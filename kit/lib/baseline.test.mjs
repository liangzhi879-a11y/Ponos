// kit/lib/baseline.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASELINE_FILE, keyOf, loadBaseline, applyBaseline, baselineGrowth, reportWithBaseline } from './baseline.mjs'
import { RED, YELLOW, finding, makeReport, renderHuman } from './report.mjs'

function fixture(baseline) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  mkdirSync(join(root, 'kit', 'manifest'), { recursive: true })
  if (baseline !== undefined) writeFileSync(join(root, BASELINE_FILE), JSON.stringify(baseline, null, 2))
  return root
}

test('loadBaseline：文件缺失返回空基线而非抛错', () => {
  const root = fixture(undefined)
  const b = loadBaseline({ root })
  assert.equal(b.version, 1)
  assert.deepEqual(b.entries, [])
})

test('loadBaseline：解析失败也返回空基线（不能因坏文件崩掉门禁）', () => {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  mkdirSync(join(root, 'kit', 'manifest'), { recursive: true })
  writeFileSync(join(root, BASELINE_FILE), '{ 坏 JSON')
  assert.deepEqual(loadBaseline({ root }).entries, [])
})

// 审查实测：旧 keyOf 用 '::' 拼接 → {rule:'A::B',subject:'C'} 与 {rule:'A',subject:'B::C'} 同键
test('keyOf：不同 (rule, subject) 组合不得撞键（撞键会把不该豁免的豁免掉）', () => {
  assert.notEqual(keyOf({ rule: 'A::B', subject: 'C' }), keyOf({ rule: 'A', subject: 'B::C' }))
  const baseline = { version: 1, entries: [{ rule: 'A', subject: 'B::C', reason: 'r' }] }
  const out = applyBaseline([finding({ rule: 'A::B', severity: YELLOW, subject: 'C' })], baseline)
  assert.equal(out.findings[0].severity, 'yellow', '未命中的 finding 不得因撞键被降级')
})

test('applyBaseline：命中黄灯降级为 baselined 并带 reason；未命中的原样保留', () => {
  const baseline = { version: 1, entries: [{ rule: 'P5', subject: 'python.diff', reason: '内嵌集是分发态最小集', at: '2026-09-19' }] }
  const findings = [
    finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' }),
    finding({ rule: 'V7', severity: RED, subject: 'skillsLock.x' }),
  ]
  const out = applyBaseline(findings, baseline)
  assert.equal(out.findings[0].severity, 'baselined')
  assert.equal(out.findings[0].reason, '内嵌集是分发态最小集')
  assert.equal(out.findings[0].baselinedFrom, 'yellow')
  assert.equal(out.findings[1].severity, 'red')
  assert.equal(out.findings[1].reason, undefined, '未命中的 finding 不得被写上 reason')
  assert.deepEqual(out.used, [keyOf({ rule: 'P5', subject: 'python.diff' })])
})

// ★ 裁定规则 1 的反例：基线不得无声抹平红灯（这是本任务最重要的一条测试）
test('applyBaseline：登记了红灯但条目未显式认领 severity:red → 仍为红', () => {
  const baseline = { version: 1, entries: [{ rule: 'V7', subject: 'skillsLock.x', reason: '想豁免但没认领' }] }
  const out = applyBaseline([finding({ rule: 'V7', severity: RED, subject: 'skillsLock.x' })], baseline)
  assert.equal(out.findings[0].severity, 'red', '未显式认领 severity:red 时红灯必须保持红')
  assert.ok(out.findings[0].hint.includes('severity'), '必须提示如何正确认领')
  assert.equal(out.findings[0].reason, undefined, '未认领就不算豁免，不得留下 reason 当作已放行')
})

test('applyBaseline：条目显式认领 severity:red → 才允许降级，且记下 baselinedFrom', () => {
  const baseline = { version: 1, entries: [{ rule: 'V7', subject: 'skillsLock.x', severity: 'red', reason: '20 条锁哈希待 A3 重算' }] }
  const out = applyBaseline([finding({ rule: 'V7', severity: RED, subject: 'skillsLock.x' })], baseline)
  assert.equal(out.findings[0].severity, 'baselined')
  assert.equal(out.findings[0].baselinedFrom, 'red', '必须能反查原本是红灯（报告的"其中红灯 M 条"靠它）')
})

// ★ 第 4 批（收口）：**关掉"用基线把契约红灯变绿"的通路**。
// 背景：第 2 批删掉了 3 条**红灯基线**（给在途差异兜底的那三条），但**通路本身没关** ——
//   审查实测（HEAD `3b013eb`）：把 `{rule:'CT1', subject:'routes ANY /zzz-red', severity:'red'}`
//   塞进 `drift-baseline.json`、并把 `baselineCount 5→6 / baselineRedCount 0→1` 一起上调 ⇒ **EXIT=0**
//   （只多一行「⚠ 基线放行」）。即：删了条目，但"下次再走一遍"的能力还在。
// 判决：契约**对账 / 范围 / 快照存在性**类规则（CT0–CT8）**一律不许被基线降级**，条目本身报红
//   （`BASELINE_FORBIDDEN`）。例外只有 `CT9`：它是"渲染层幽灵 fetch"的**历史欠账**（黄、只报不拦），
//   基线里那 5 条正当 —— 所以这里**不是**把基线一刀切禁掉。
// 为什么禁在契约侧而不禁在别处：契约红灯的语义是"契约面与提交物/登记不一致"，处置动作只有
//   三种（修代码 / `kit:sync` / 登记 scope），**没有一种**是"记一笔欠账长期放行"。
const FORBIDDEN_CT = ['CT0', 'CT1', 'CT2', 'CT3', 'CT4', 'CT4B', 'CT4C', 'CT5', 'CT6', 'CT7', 'CT8']

test('applyBaseline：契约类规则即使显式认领 severity:red 也不得降级，且条目本身报 BASELINE_FORBIDDEN 红', () => {
  for (const rule of FORBIDDEN_CT) {
    const baseline = { version: 1, entries: [{ rule, subject: 'x', severity: 'red', reason: '想用基线放行契约红灯' }] }
    const out = applyBaseline([finding({ rule, severity: RED, subject: 'x' })], baseline)
    const f = out.findings.find((x) => x.rule === rule)
    assert.equal(f.severity, 'red', `${rule} 不得被降级（契约规则不支持豁免）`)
    assert.equal(f.reason, undefined, `${rule} 没被豁免 ⇒ 不得留下 reason（否则报告会显示"已登记基线"）`)
    assert.deepEqual(out.findings.filter((x) => x.rule === 'BASELINE_FORBIDDEN').map((x) => [x.subject, x.severity]),
      [[`${rule} x`, 'red']], `${rule} 的条目本身必须报红（"该规则不支持豁免"，不许静默忽略）`)
    assert.deepEqual(out.used, [], `${rule} 的条目不算"已用"（否则会被当成生效）`)
    assert.deepEqual(out.unused, [keyOf({ rule, subject: 'x' })], '必须进 unused ⇒ 报告里能提示摘除')
  }
})

test('applyBaseline：契约类条目**即使不命中**也报红（"出现即红"：留着它就等于留着下次走的通路）', () => {
  const baseline = { version: 1, entries: [{ rule: 'CT4B', subject: 'channels.scopeCount', severity: 'red', reason: 'r' }] }
  const out = applyBaseline([finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' })], baseline)
  assert.deepEqual(out.findings.filter((f) => f.rule === 'BASELINE_FORBIDDEN').map((f) => f.severity), ['red'])
  assert.equal(out.findings.find((f) => f.rule === 'P5').severity, 'yellow', '无关 finding 不受影响（不是"一有 CT 条目就全红"）')
})

test('applyBaseline：CT9 与版本/依赖类的豁免能力**不变**（不许一刀切禁掉基线）', () => {
  // CT9：那 5 条正当欠账（黄、只报不拦）必须照旧逐条豁免
  const ct9 = { version: 1, entries: [{ rule: 'CT9', subject: '/save-temp-image', reason: '**真欠账**：前端调了后端不存在的端点' }] }
  const o1 = applyBaseline([finding({ rule: 'CT9', severity: YELLOW, subject: '/save-temp-image' })], ct9)
  assert.deepEqual(o1.findings.map((f) => `${f.rule}:${f.severity}`), ['CT9:baselined'])
  assert.equal(o1.findings[0].reason, '**真欠账**：前端调了后端不存在的端点')
  assert.deepEqual(o1.used, [keyOf({ rule: 'CT9', subject: '/save-temp-image' })])
  assert.deepEqual(o1.findings.filter((f) => f.rule === 'BASELINE_FORBIDDEN'), [])
  // V7（P0 落地时那 20 条锁哈希债）仍可被显式认领红灯豁免 —— 否则门禁上线当天就绿不了
  const v7 = { version: 1, entries: [{ rule: 'V7', subject: 'skillsLock.x', severity: 'red', reason: '20 条锁哈希待重算' }] }
  const o2 = applyBaseline([finding({ rule: 'V7', severity: RED, subject: 'skillsLock.x' })], v7)
  assert.equal(o2.findings[0].severity, 'baselined')
  assert.deepEqual(o2.findings.filter((f) => f.rule === 'BASELINE_FORBIDDEN'), [])
})

// ★ 裁定规则 2 的反例：缺 reason 的条目不生效，且本身报红（I4 的强制执行点）
test('applyBaseline：条目缺 reason / reason 为空白 → 条目不生效并报 BASELINE_NO_REASON 红', () => {
  const baseline = { version: 1, entries: [{ rule: 'P5', subject: 'python.diff' }, { rule: 'P6', subject: 'x', reason: '   ' }] }
  const out = applyBaseline([finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' })], baseline)
  assert.equal(out.findings.find((f) => f.rule === 'P5' && f.subject === 'python.diff').severity, 'yellow', '缺 reason 的条目不得生效')
  assert.equal(out.ignoredNoReason, 2)
  const nr = out.findings.filter((f) => f.rule === 'BASELINE_NO_REASON')
  assert.equal(nr.length, 2)
  assert.ok(nr.every((f) => f.severity === 'red'))
  assert.deepEqual(out.used, [], '缺 reason 的条目不算"已用"，否则会被当成生效')
})

test('applyBaseline：基线里不再命中的条目进 unused（提示可摘除）', () => {
  const baseline = { version: 1, entries: [{ rule: 'V8', subject: 'gone', reason: 'r' }] }
  const out = applyBaseline([], baseline)
  assert.deepEqual(out.used, [])
  assert.deepEqual(out.unused, [keyOf({ rule: 'V8', subject: 'gone' })])
})

// G5 防滥用：基线是"欠账"不是"药方"，条目数与「红灯豁免数」各有一条护栏
test('baselineGrowth：条目总数与「红灯豁免数」分别超限都要报；未记录（null）时不管', () => {
  const b = { version: 1, entries: [{ rule: 'a', subject: 'b', reason: 'r' }, { rule: 'c', subject: 'd', reason: 'r' }] }
  assert.equal(baselineGrowth({ baseline: b, recordedCount: null, recordedRedCount: null }), null)
  assert.equal(baselineGrowth({ baseline: b, recordedCount: 2, recordedRedCount: 0 }), null)
  const g = baselineGrowth({ baseline: b, recordedCount: 1, recordedRedCount: 0 })
  assert.equal(g.exceeded, 2)
  assert.equal(g.count, 2)
  assert.equal(g.redExceeded, null, '总数超限但红灯数没超 → 红灯护栏不报')
  // 红灯豁免数：2 条里 1 条 severity:red，记录值 0 → 报 redExceeded（总数 2 不超 2，故只报这一条）
  const br = { version: 1, entries: [{ rule: 'a', subject: 'b', severity: 'red', reason: 'r' }, { rule: 'c', subject: 'd', reason: 'r' }] }
  const g2 = baselineGrowth({ baseline: br, recordedCount: 2, recordedRedCount: 0 })
  assert.equal(g2.redExceeded, 1)
  assert.equal(g2.redCount, 1)
  assert.equal(g2.exceeded, null, '红灯护栏单独超限时只报 redExceeded')
})

// ★ 低危项：summary 是派生快照 —— 复用旧 report 只换 findings 会留下脏计数
test('reportWithBaseline：套用基线后重建报告（summary/baselined 与 findings 一致），并让 renderHuman 看见放行', () => {
  const baseline = { version: 1, entries: [{ rule: 'V7', subject: 'skillsLock.x', severity: 'red', reason: '20 条锁哈希待 A3 重算' }] }
  const findings = [finding({ rule: 'V7', severity: RED, subject: 'skillsLock.x' }), finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' })]
  const stale = makeReport({ findings })                        // 复用旧 report：summary.red 还停在 1
  const fresh = reportWithBaseline(findings, baseline)
  assert.equal(fresh.ok, true)
  assert.equal(fresh.summary.red, 0)
  assert.equal(fresh.summary.baselined, 1)
  assert.equal(fresh.summary.yellow, 1)
  assert.deepEqual(fresh.baselined, { total: 1, red: 1 })
  const dirty = { ...stale, findings: fresh.findings }
  assert.equal(dirty.summary.red, 1, '复用旧 report 的 summary 会留下脏红灯计数（这正是需要 reportWithBaseline 的原因）')
  // renderHuman 路径：ok 为 true 也必须看见「基线豁免 1 条，其中红灯 1 条」
  const lines = renderHuman(fresh).split('\n')
  assert.equal(lines[0], 'DevKit 检查：✅ 通过（红灯 0 / 基线豁免 1 条，其中红灯 1 条）')
  assert.equal(lines[1], '基线豁免：1 条（其中红灯 1 条）')
})

// ★ 低危项（Task 2 复审）：手工把 entries 写成 [null] 是**现实路径**（人工编辑该文件），
//   而门禁声明的是"不能因坏文件崩掉"。初版只校验 Array.isArray(entries)，元素形状不管：
//   `null.reason` 直接抛 TypeError，整个 check 变成崩溃而不是红灯。
test('applyBaseline / baselineGrowth：entries 里的非对象元素不得抛错，按"缺 reason"处理', () => {
  const root = fixture({ version: 1, entries: [null, 'x', 3] })
  const loaded = loadBaseline({ root })
  const findings = [finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' })]
  assert.doesNotThrow(() => applyBaseline(findings, loaded), '坏条目不得让门禁崩掉（应降级为红灯）')
  const out = applyBaseline(findings, loaded)
  assert.equal(out.ignoredNoReason, 3, '三个坏条目都当作缺 reason')
  assert.equal(out.findings.filter((f) => f.rule === 'BASELINE_NO_REASON' && f.severity === 'red').length, 3, '每条都要有一条红灯（坏文件必须可见）')
  assert.equal(out.findings.find((f) => f.rule === 'P5').severity, 'yellow', '坏条目不得顺手把正常 finding 豁免掉')
  assert.deepEqual(out.used, [])
  assert.doesNotThrow(() => baselineGrowth({ baseline: loaded, recordedCount: 0, recordedRedCount: 0 }))
  const g = baselineGrowth({ baseline: loaded, recordedCount: 0, recordedRedCount: 0 })
  assert.equal(g.count, 3, '坏条目也占条目数（否则"塞垃圾条目"可绕过条目数护栏）')
  assert.equal(g.exceeded, 3)
  assert.equal(g.redExceeded, null, '坏条目不是"红灯豁免"，不得计入红灯护栏')
})
