// 出网能力闸的单测（E2 Task 1，plan Step 1）。
// ---------------------------------------------------------------------------
// 本文件钉死五条**默认姿态**（都是"最严"这一条的不同侧面，任一条被放宽都必须红）：
//   ① 未显式放行 ⇒ 拒绝（含宽松档 —— 档位只影响默认口径，不能绕过显式表）
//   ② 未知能力（拼错）⇒ 拒绝（fail-closed：拼错不得等于放行）
//   ③ loopback ⇒ 允许（不得把自己代理掉/拦掉自己的回环）
//   ④ 显式放行 ⇒ 放行，且审计里能看到"能力 + 目标主机"
//   ⑤ 审计**不得**带查询串（凭据常以 `?key=` 形态出现；审计本身不能成为泄露通道）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideEgress, EGRESS_CAPABILITY, CAPABILITY_MODES, EGRESS_REASONS, EGRESS_BOUNDARY,
  capabilitiesOf, capabilitiesSource,
} from './egress-capability.cjs'

// ★ S2①（修复轮 R=1）：能力类别**正面**断言"恰为六类"。
//   病灶：下面那条"默认最严"用例遍历 `Object.values(EGRESS_CAPABILITY)` ⇒ 删掉某个能力常量时
//   它**自动少跑一轮**、不会红（少测一类 = 静默失去覆盖）。故：① 用**字面量**钉住六类；
//   ② "默认最严"改用字面量清单遍历（删常量 ⇒ 该用例仍会因"常量缺失"而红）。
const SIX_CAPABILITY_KEYS = ['BROWSER', 'LOOPBACK', 'PROVIDER', 'SHELL', 'TEAM', 'WEB']
const SIX_CAPABILITY_VALUES = ['browser', 'loopback', 'provider', 'shell', 'team', 'web']
/** 默认最严必须逐一拒绝的**非** loopback 类别（字面量，不用 Object.values 派生） */
const FIVE_NON_LOOPBACK = ['provider', 'team', 'web', 'shell', 'browser']

test('能力类别恰为六类（正面断言：增删任一常量都必须红）', () => {
  assert.deepEqual(Object.keys(EGRESS_CAPABILITY).sort(), SIX_CAPABILITY_KEYS, '能力类别键恰为六类')
  assert.deepEqual(Object.values(EGRESS_CAPABILITY).sort(), SIX_CAPABILITY_VALUES, '能力类别值恰为六类（plan §D3）')
  // 期望值硬编码（不 import 常量当期望值：那样"常量被删"会连期望一起消失）
  for (const cap of FIVE_NON_LOOPBACK) assert.ok(SIX_CAPABILITY_VALUES.includes(cap))
})

test('默认最严：未显式放行的能力一律拒绝', () => {
  for (const cap of FIVE_NON_LOOPBACK) {
    const r = decideEgress({ capability: cap, target: 'https://example.com', mode: CAPABILITY_MODES.STRICT })
    assert.equal(r.allowed, false, `${cap} 不应默认放行`)
    assert.equal(r.reason, 'not-explicitly-allowed')
  }
})

test('loopback 永远允许（不得把自己代理掉）', () => {
  const r = decideEgress({ capability: EGRESS_CAPABILITY.LOOPBACK, target: 'http://127.0.0.1:51517/x', mode: CAPABILITY_MODES.STRICT })
  assert.equal(r.allowed, true)
  assert.equal(r.reason, 'loopback')
})

test('显式放行后放行，且审计里带能力与目标', () => {
  const r = decideEgress({ capability: EGRESS_CAPABILITY.PROVIDER, target: 'https://api.x.com', mode: CAPABILITY_MODES.STRICT, allow: ['provider'] })
  assert.equal(r.allowed, true)
  assert.equal(r.reason, 'explicitly-allowed')
  assert.equal(r.audit.capability, 'provider')
  // ★ 字段名取 `host`（plan Step 3 的实现与 Step 6 的接线示例都读 `g.audit.host`）：
  //   plan Step 1 原稿此处写的是 `r.audit.target`，与它自己 Step 3 的实现形状不一致
  //   （实现里没有 target 字段 ⇒ `assert.match(undefined, …)` 必抛）。断言强度不变：
  //   仍要求审计里能读出目标主机，取不到该字段依旧红。
  assert.match(r.audit.host, /api\.x\.com/)
})

test('未知能力 ⇒ 拒绝（fail-closed，不得因拼错而放行）', () => {
  const r = decideEgress({ capability: 'typo', target: 'https://x.com', mode: CAPABILITY_MODES.STRICT })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'unknown-capability')
})

test('宽松档仍然：未放行的非 loopback 能力不放行（档位只影响默认口径，不绕过显式表）', () => {
  const r = decideEgress({ capability: EGRESS_CAPABILITY.SHELL, target: 'x', mode: CAPABILITY_MODES.LOOSE })
  assert.equal(r.allowed, false)
})

test('审计不含凭据/正文（只留类别与 target）', () => {
  const r = decideEgress({ capability: EGRESS_CAPABILITY.PROVIDER, target: 'https://api.x.com/v1/messages?key=SECRET', mode: CAPABILITY_MODES.STRICT, allow: ['provider'] })
  assert.ok(!JSON.stringify(r.audit).includes('SECRET'), '审计不得含查询串里的凭据')
})

// —— 以下三条是同一条纪律的补角（显式放行也不认拼错、审计只留 host、判定可复现）——

test('放行表里写拼错的能力名 ⇒ 未知能力仍拒绝（放行表不得成为绕过 fail-closed 的入口）', () => {
  const r = decideEgress({ capability: 'provider ', target: 'https://api.x.com', mode: CAPABILITY_MODES.STRICT, allow: ['provider ', 'provider'] })
  assert.equal(r.allowed, false, '带空格的键不得被当成 provider')
  assert.equal(r.reason, 'unknown-capability')
})

test('审计形状：只留 host（丢弃路径/查询串/账号密码），且带结论与原因', () => {
  const r = decideEgress({ capability: EGRESS_CAPABILITY.WEB, target: 'https://u:p@api.x.com/v1/a?token=SECRET#frag', mode: CAPABILITY_MODES.STRICT, allow: ['web'] })
  assert.equal(r.audit.host, 'api.x.com')
  const s = JSON.stringify(r.audit)
  assert.ok(!s.includes('SECRET') && !s.includes('/v1/a') && !s.includes('u:p'), `审计只应留 host：${s}`)
  assert.equal(r.audit.allowed, true)
  assert.equal(r.audit.reason, 'explicitly-allowed')
  assert.equal(r.audit.mode, 'strict')
  // ★ S2②（修复轮 R=1）：审计键集合**正面**断言"恰为这六个"。
  //   病灶：此前只有纯否定式断言（"不得含凭据/路径"）⇒ `audit` 退化成 `{}` 也全绿
  //   （`!JSON.stringify({}).includes('SECRET')` 恒真）。审计是"可审计"这条承诺的唯一载体，
  //   字段少一个就等于少一条证据链，必须正面钉住。
  assert.deepEqual(Object.keys(r.audit).sort(), ['allowed', 'at', 'capability', 'host', 'mode', 'reason'],
    '审计键集合恰为 {at, capability, host, mode, allowed, reason}')
  assert.equal(typeof r.audit.at, 'string')
  assert.equal(typeof r.audit.host, 'string')
})

// ── M2（修复轮 R=1）：`capabilities` 键**读不读得懂**必须区分三态，读不懂按最严 ──
// 病灶：`capabilities: "provider"`（字符串，键在、类型非法）落进"键缺失"分支 ⇒ 生效清单回落到
// 四元组兜底，**比用户意图更宽**（违反 Global Constraints："读不到/判不了不得当成放行"）。
test('M2：capabilities 键类型非法 ⇒ 按最严（[]）且来源可辨识为 config-invalid', () => {
  const invalid = [
    'provider',                       // 字符串（审查实测的形态）
    42, true, null,                  // 其他标量
    ['provider', 42],                // 数组含非字符串元素（类型非法 ⇒ 整表读不懂）
    { provider: true },              // 对象
  ]
  for (const v of invalid) {
    const network = { capabilities: v }
    assert.deepEqual(capabilitiesOf(network), [], `capabilities=${JSON.stringify(v)} 必须按最严（视作 []）`)
    assert.equal(capabilitiesSource(network), 'config-invalid', `capabilities=${JSON.stringify(v)} 必须报可辨识来源`)
  }
  // `network` 本身不是对象（`network: "off"` 这类手改形态）⇒ 同样读不懂 ⇒ 最严
  for (const bad of ['off', 7, ['a']]) {
    assert.deepEqual(capabilitiesOf(bad), [], `network=${JSON.stringify(bad)} 必须按最严`)
    assert.equal(capabilitiesSource(bad), 'config-invalid')
  }
})

test('M2：三态判据的另两态不被误伤（存量兜底 / 显式声明）', () => {
  // 键缺失 = 存量文件形态 ⇒ 兜底（升级零变化）
  assert.deepEqual(capabilitiesOf({ proxy: { mode: 'off' } }), ['provider', 'web', 'browser', 'shell'])
  assert.equal(capabilitiesSource({ proxy: { mode: 'off' } }), 'legacy-fallback')
  assert.deepEqual(capabilitiesOf(undefined), ['provider', 'web', 'browser', 'shell'])
  assert.equal(capabilitiesSource(undefined), 'legacy-fallback')
  // 合法数组 ⇒ 显式声明（哪怕是空数组 = "一个都不放行"的明确意志）
  assert.deepEqual(capabilitiesOf({ capabilities: [] }), [])
  assert.equal(capabilitiesSource({ capabilities: [] }), 'config-explicit')
  assert.deepEqual(capabilitiesOf({ capabilities: ['provider', 'web'] }), ['provider', 'web'])
  // 拼错的**字符串**沿用既有语义：丢弃（丢弃 = 不放行，比用户意图更严），来源仍是显式声明
  assert.deepEqual(capabilitiesOf({ capabilities: ['provider', 'provder'] }), ['provider'])
  assert.equal(capabilitiesSource({ capabilities: ['provider', 'provder'] }), 'config-explicit')
})

test('判定是纯函数：同一入参、同一 now ⇒ 逐字相同的结论与审计', () => {
  const args = { capability: EGRESS_CAPABILITY.PROVIDER, target: 'https://api.x.com', mode: CAPABILITY_MODES.STRICT, allow: ['provider'], now: 1700000000000 }
  assert.deepEqual(decideEgress(args), decideEgress(args))
})

// ── 稳定枚举与边界声明（供界面/文档读；改动即破坏契约）──
test('拒绝原因枚举稳定（排障/测试按字面量读）', () => {
  assert.deepEqual(Object.values(EGRESS_REASONS).sort(),
    ['explicitly-allowed', 'loopback', 'not-explicitly-allowed', 'unknown-capability'])
})

test('边界声明：每条 canBlock 自报「已接线/尚未接线」，且"拦不住"至少点名 Bash 直连', () => {
  assert.ok(EGRESS_BOUNDARY.canBlock.length >= 2)
  for (const item of EGRESS_BOUNDARY.canBlock) {
    assert.match(String(item), /^(已接线|尚未接线)：/, `每条都必须自报接线状态：${item}`)
  }
  assert.ok(EGRESS_BOUNDARY.canBlock.some((s) => String(s).startsWith('已接线：')))
  assert.ok(EGRESS_BOUNDARY.canBlock.some((s) => String(s).startsWith('尚未接线：')))
  assert.ok(EGRESS_BOUNDARY.cannotBlock.some((s) => String(s).includes('Bash')), '必须如实声明 Bash 直连拦不住')
})
