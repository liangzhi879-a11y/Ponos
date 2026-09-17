// 子代理并发上限：策略纯函数 + 设置项贯通（第 10 项，2026-09-17）。
//
// 纪律（沿用 server/knowledge-kernel-env.test.mjs）：
// ① **绝不 import `server/bridge.mjs`** —— 它是入口模块，import 即起服务并 bind 51517：
//    实测会撞运行中应用（EADDRINUSE）；若应用没开则会真起一个桥，属危险副作用。
//    故纯策略放在 `shared/subagent-concurrency.mjs`，本文件只 import 它 + 读源码做治理断言。
// ② 不起内核子进程（引擎行为由 kernel-tests 的 mock 用例覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeMaxSubAgents, defaultLaneConcurrency, MAX_SUBAGENTS_CAP } from '../shared/subagent-concurrency.mjs'

const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf-8')

test('① normalizeMaxSubAgents：三值语义（自动 / 不限 / 上限）与钳制', () => {
  // 自动：null / undefined / 空串 / 'auto' —— 不注入 env，内核按系统配置推导
  for (const v of [null, undefined, '', 'auto']) {
    assert.equal(normalizeMaxSubAgents(v), null, `${JSON.stringify(v)} 应归一为"自动"`)
  }
  // 不限：0 / 负数 → 0（与内核 PONOS_LANE_MAX_CONCURRENT 的 0 语义一致）
  assert.equal(normalizeMaxSubAgents(0), 0)
  assert.equal(normalizeMaxSubAgents(-1), 0)
  assert.equal(normalizeMaxSubAgents('0'), 0)
  // 上限：正数取整并 clamp 到 [1, 32]
  assert.equal(normalizeMaxSubAgents(4), 4)
  assert.equal(normalizeMaxSubAgents('6'), 6)
  assert.equal(normalizeMaxSubAgents(3.7), 3)
  assert.equal(normalizeMaxSubAgents(200), MAX_SUBAGENTS_CAP, '上限防呆：再大既无收益也会把模型 API 打爆')
  assert.equal(normalizeMaxSubAgents(0.4), 1, '小于 1 的正数不得被截成 0（0 是"不限"，语义相反）')
  // 非法输入 → 自动（最安全：交内核按系统配置决定），绝不落到"不限"
  assert.equal(normalizeMaxSubAgents('abc'), null)
  assert.equal(normalizeMaxSubAgents(NaN), null)
  assert.equal(normalizeMaxSubAgents({}), null)
  // 显式挡住宽松转换：Number([])===0（会变成"不限"）、Number(true)===1（会变成静默串行）
  assert.equal(normalizeMaxSubAgents([]), null, '空数组不得被 Number() 成 0 = 不限')
  assert.equal(normalizeMaxSubAgents(true), null, '布尔不得被 Number() 成 1 = 上限 1')
  assert.equal(normalizeMaxSubAgents('   '), null, '空白串不是数字')
})

test('② defaultLaneConcurrency：默认按系统配置推导，clamp 到 [2, 8]，探测失败退回 4', () => {
  assert.equal(defaultLaneConcurrency(4), 3, '4 核 → 3')
  assert.equal(defaultLaneConcurrency(8), 7, '8 核 → 7')
  assert.equal(defaultLaneConcurrency(2), 2, '2 核 → 2（下限，1 核无意义故夹到 2）')
  assert.equal(defaultLaneConcurrency(1), 2, '单核也要给 2——1 等于串行，失去"并发"的意义')
  assert.equal(defaultLaneConcurrency(32), 8, '超大核机器封顶 8，避免同时打爆模型 API')
  assert.equal(defaultLaneConcurrency(0), 4, '探测失败退回旧默认值 4（行为可预期）')
  assert.equal(defaultLaneConcurrency(undefined), 4)
  assert.equal(defaultLaneConcurrency(NaN), 4)
})

test('③ 源码治理：桥注入 env、内核读同一键并用同一策略（两处漂移即设置失效）', () => {
  const bridge = readSrc('./bridge.mjs')
  assert.match(bridge, /import \{ normalizeMaxSubAgents \} from '\.\.\/shared\/subagent-concurrency\.mjs'/,
    '桥必须引用 shared 的唯一策略（不得自己再写一份 clamp）')
  assert.match(bridge, /const maxSubAgents = normalizeMaxSubAgents\(cfg\.maxSubAgents\)/,
    'buildChildEnv 必须经归一后再注入（否则 0/负数会被内核读成"不限"）')
  assert.match(bridge, /if \(maxSubAgents !== null\) env\.PONOS_LANE_MAX_CONCURRENT = String\(maxSubAgents\)/,
    '"自动"档必须**不注入** env，让内核按系统配置推导')
  assert.match(bridge, /if \('maxSubAgents' in out\)/, 'sanitizeConfigPatch 必须钳制该键（落盘前再挡一次）')
  assert.match(bridge, /maxSubAgents: null,/, '默认必须是"自动"（null），不得把本机结论写死进默认配置')
  assert.doesNotMatch(bridge, /function normalizeMaxSubAgents/,
    '桥内不得再保留一份策略副本（会与 shared 漂移）')

  const cfg = readSrc('../kernel/engine-config.mjs')
  assert.match(cfg, /PONOS_LANE_MAX_CONCURRENT/, '内核必须读同一个 env 键')
  assert.match(cfg, /defaultLaneConcurrency\(probeCores\(\)\)/,
    '内核默认值必须按系统配置推导（第 10 项"默认根据系统配置设置最大并发值"）')
  assert.match(cfg, /from '\.\.\/shared\/subagent-concurrency\.mjs'/,
    '内核也必须引用同一策略（前后端默认值不得各写一套）')

  // "0 = 不限"的判定在前台槽位处（kernel/engine.mjs），不在 engine-config
  const engine = readSrc('../kernel/engine.mjs')
  assert.match(engine, /if \(LANE_MAX_CONCURRENT <= 0\) return \(\) => \{\}/,
    '前端槽位必须把 0 视为"不限"——与桥侧的"自动不注入"配套，否则 0 会变成"全串行"')
})

test('④ 与前端归约的契约：三值映射两侧一致（auto↔null / 0↔0 / N↔N）', () => {
  const ui = readSrc('../src/lib/subagentUi.ts')
  assert.match(ui, /if \(norm === 'auto'\) return null/, 'UI → config：auto 必须映射为 null')
  assert.match(ui, /if \(n <= 0\) return 0/, 'UI → config：0/负数必须映射为 0（不限），不得映射为 null')
  assert.match(ui, /=== 'auto'\) return 'auto'/, '读配置时必须把缺键（旧 config）归一为"自动"')
  // 钳制上界两侧同值（32）：跨语言无法共享常量，用契约断言锁住
  assert.match(ui, /Math\.min\(32, Math\.max\(1, Math\.floor\(n\)\)\)/, 'UI 钳制规则须与 shared 一致')
})
