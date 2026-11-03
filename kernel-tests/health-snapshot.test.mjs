// 会话健康快照聚合（纯读取）。
// 为什么断言要写这么细：快照是"排障时一眼看全"的依据，一旦它把"不知道"报成"很好"（填 0）、
// 或偷偷夹带判定逻辑变成第二套真相，排障就会被它带偏——比没有快照更糟。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SNAPSHOT_KEYS, buildHealthSnapshot } from '../kernel/health-snapshot.mjs'
import { createDiskTelemetry } from '../kernel/disk-telemetry.mjs'
import { diskWrite } from '../kernel/disk-write.mjs'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('空输入：五段齐备且全为 null（**不填 0**——填 0 会把"不知道"读成"很好"）', () => {
  const s = buildHealthSnapshot()
  assert.deepEqual(Object.keys(s).sort(), [...SNAPSHOT_KEYS].sort())
  for (const k of SNAPSHOT_KEYS) assert.equal(s[k], null, `${k} 缺数据应为 null`)
  assert.deepEqual(buildHealthSnapshot({}).pressure, null)
  assert.deepEqual(buildHealthSnapshot({ health: null, cost: undefined }).cost, null)
})

test('pressure：字段齐备时原样透传（快照不得改写数值）', () => {
  const s = buildHealthSnapshot({ health: { remainingPct: 42, remainingTurns: 7, compactCount: 2, attentionCeiling: 160_000 } })
  assert.deepEqual(s.pressure, { remainingPct: 42, remainingTurns: 7, compactCount: 2, attentionCeiling: 160_000 })
  // 部分字段缺失 ⇒ 保 null（逐字段如实，不整体美化也不整体丢弃）
  const p = buildHealthSnapshot({ health: { remainingPct: 42 } }).pressure
  assert.equal(p.remainingPct, 42)
  assert.equal(p.remainingTurns, null)
})

// attentionCeiling 是真源里的**数字**水位基准（Task 5 修复：health 侧已把它加进对外快照）。
// 此前聚合器用 str() 收字符串 ⇒ 真值（数字）被一律丢弃 ⇒ 该字段恒 null（"值已知却不上 wire"）。
// 数字之外的输入仍一律 null：缺项不填 0（0 会被读成"基准为零、水位恒满"）。
test('★ pressure.attentionCeiling：数字数值透传；缺项/非数字 ⇒ null（不是 0）', () => {
  assert.equal(buildHealthSnapshot({ health: { attentionCeiling: 160_000 } }).pressure.attentionCeiling, 160_000)
  assert.equal(buildHealthSnapshot({ health: { attentionCeiling: 0 } }).pressure.attentionCeiling, 0, '0 是合法数字 ⇒ 透传（"无有效窗口"由 health 侧收口为 null）')
  assert.equal(buildHealthSnapshot({ health: { remainingPct: 1 } }).pressure.attentionCeiling, null, '缺项 ⇒ null')
  assert.equal(buildHealthSnapshot({ health: { attentionCeiling: undefined } }).pressure.attentionCeiling, null, 'undefined ⇒ null')
  assert.equal(buildHealthSnapshot({ health: { attentionCeiling: null } }).pressure.attentionCeiling, null, 'health 侧"无有效窗口"⇒ null 原样保留')
  assert.equal(buildHealthSnapshot({ health: { attentionCeiling: '160000' } }).pressure.attentionCeiling, null, '字符串不猜成数字（旧口径恰恰只认字符串）')
  assert.equal(buildHealthSnapshot({ health: { attentionCeiling: NaN } }).pressure.attentionCeiling, null, 'NaN ⇒ null')
})

test('fidelity：三轴 + issues 原样；无 issues ⇒ 空数组（表示"确实没发现问题"）', () => {
  const s = buildHealthSnapshot({ fidelity: { memory: 0.9, coherence: 0.8, goal: 0.85, issues: [{ kind: 'drift' }] } })
  assert.deepEqual(s.fidelity, { memory: 0.9, coherence: 0.8, goal: 0.85, issues: [{ kind: 'drift' }] })
  assert.deepEqual(buildHealthSnapshot({ fidelity: { memory: 0.9 } }).fidelity.issues, [])
})

test('cost：token/请求数/成本/预算；预算未给出 ⇒ budgetUsd 与 overBudget 均 null（不猜）', () => {
  const s = buildHealthSnapshot({ cost: { tokens: 1234, requests: 5, costUsd: 0.42, budgetUsd: 5, overBudget: false } })
  assert.deepEqual(s.cost, { tokens: 1234, requests: 5, costUsd: 0.42, budgetUsd: 5, overBudget: false })
  const noBudget = buildHealthSnapshot({ cost: { tokens: 10, requests: 1, costUsd: 0.01 } }).cost
  assert.equal(noBudget.budgetUsd, null)
  assert.equal(noBudget.overBudget, null, '无预算 ⇒ 不得推断 false（那会被读成"没超预算"）')
})

test('guard：透传 hits/injections 与既有 ladder（**逐字不改**collectGuardState 的形状）', () => {
  const guard = { hits: ['stall'], injections: 2, ladder: { highest: 'L1', highestName: '注入改策略', exhausted: false, counts: { L0: 0, L1: 2, L2: 0, L3: 0, L4: 0 }, unknown: [], line: '自愈阶梯：最高 L1（注入改策略）' } }
  const s = buildHealthSnapshot({ guard })
  assert.deepEqual(s.guard.hits, ['stall'])
  assert.equal(s.guard.injections, 2)
  assert.deepEqual(s.guard.ladder, guard.ladder, 'ladder 是既有派生视图，快照只引用不改写')
  assert.deepEqual(buildHealthSnapshot({ guard: { hits: [] } }).guard.ladder, null, '无 ladder ⇒ null')
})

// 2026-09-25 复审 ⑤：`injections` 原先写作 `num(g.injections) ?? 0`（缺项填 0），是本模块
// 纪律②（缺项一律 null、绝不填 0）的唯一例外。真源恒有该字段 ⇒ 当时无行为影响，但没有测试
// 钉住，日后任何改口径都会静默。现改为如实 null，并由本用例锁住"缺项 ⇒ null、真 0 ⇒ 0"。
test('★ guard.injections：缺项 ⇒ null（不填 0）；真 0 ⇒ 0（两者的语义必须可区分）', () => {
  assert.equal(buildHealthSnapshot({ guard: { hits: [] } }).guard.injections, null, '缺项 ⇒ null（不填 0）')
  assert.equal(buildHealthSnapshot({ guard: { hits: [], injections: undefined } }).guard.injections, null)
  assert.equal(buildHealthSnapshot({ guard: { hits: [], injections: null } }).guard.injections, null)
  assert.equal(buildHealthSnapshot({ guard: { hits: [], injections: 0 } }).guard.injections, 0, '真 0 ⇒ 0（"确实没注入过"）')
  assert.equal(buildHealthSnapshot({ guard: { hits: [], injections: '2' } }).guard.injections, null, '字符串不猜成数字')
  assert.equal(buildHealthSnapshot({ guard: { hits: [], injections: NaN } }).guard.injections, null)
})

test('disk：透传落盘遥测的 snapshot（含 health/healLevel/p95Ms）', () => {
  const disk = { sites: { 'loop-state': { count: 1, totalMs: 5, maxMs: 5, slow: 0, failures: 0, lastError: '' } }, total: { count: 1, ms: 5, slow: 0, failures: 0 }, maxMs: 5, slowestSite: 'loop-state', p95Ms: null, health: 'ok', healLevel: null }
  const s = buildHealthSnapshot({ disk })
  assert.equal(s.disk.health, 'ok')
  assert.equal(s.disk.healLevel, null)
  assert.deepEqual(s.disk.sites['loop-state'], disk.sites['loop-state'])
})

// ── 落盘段收口：没观测 ≠ 磁盘好（Task 1 审查指出）──────────────────────────────
// 为什么必须有这组用例：落盘遥测在"埋点关闭"或"本会话一次都没写过"时返回
// count 全 0 + health:'ok' + healLevel:null。若聚合器原样透传，`ponos_health` 帧就会
// 把"没有观测"上报成"磁盘很好"——与"缺项一律 null、绝不填 0"同一条纪律的两个面：
// 填 0 会把"不知道"读成"很好"。故 disk 段必须自行判定"有没有样本"，无样本即 null。

test('★ 收口①：disk 无样本（total.count === 0）⇒ disk 段为 null（不得把"没观测"报成 ok）', () => {
  const s = buildHealthSnapshot({
    disk: {
      sites: { 'transcript-append': { count: 0, totalMs: 0, maxMs: 0, slow: 0, failures: 0, lastError: '' } },
      total: { count: 0, ms: 0, slow: 0, failures: 0 },
      maxMs: 0, slowestSite: null, p95Ms: null, health: 'ok', healLevel: null,
    },
  })
  assert.equal(s.disk, null, 'count=0 ⇒ 无观测 ⇒ 必须 null（透传就等于宣称"磁盘很好"）')
})

test('★ 收口②：有样本（total.count = 3）⇒ 正常透传，health 保留（ok 此时表示"观察过且没问题"）', () => {
  const disk = {
    sites: { 'transcript-append': { count: 3, totalMs: 30, maxMs: 20, slow: 0, failures: 0, lastError: '' } },
    total: { count: 3, ms: 30, slow: 0, failures: 0 },
    maxMs: 20, slowestSite: 'transcript-append', p95Ms: 20, health: 'ok', healLevel: null,
  }
  const d = buildHealthSnapshot({ disk }).disk
  assert.notEqual(d, null, '有样本 ⇒ 有信息量，必须透传')
  assert.equal(d.health, 'ok', '有观测的 ok 是有信息量的（观察过且没问题），不得被抹成 null')
  assert.equal(d.healLevel, null)
  assert.equal(d.total.count, 3)
  assert.equal(d.maxMs, 20)
  assert.equal(d.p95Ms, 20)
  assert.deepEqual(d.sites['transcript-append'], disk.sites['transcript-append'])
  // failing/slow 同样透传（收口只针对"无样本"这一种歧义，不得顺手改写有样本的结论）
  assert.equal(buildHealthSnapshot({ disk: { ...disk, health: 'failing' } }).disk.health, 'failing')
})

test('★ 收口③：total 缺失或非法（非对象 / count 非正数 / 非数字）⇒ disk 段为 null', () => {
  const base = { sites: {}, maxMs: 0, slowestSite: null, p95Ms: null, health: 'ok', healLevel: null }
  assert.equal(buildHealthSnapshot({ disk: { ...base } }).disk, null, 'total 缺失 ⇒ null')
  assert.equal(buildHealthSnapshot({ disk: { ...base, total: null } }).disk, null)
  assert.equal(buildHealthSnapshot({ disk: { ...base, total: 'nope' } }).disk, null, 'total 非对象 ⇒ null')
  assert.equal(buildHealthSnapshot({ disk: { ...base, total: {} } }).disk, null, 'count 缺失 ⇒ null')
  assert.equal(buildHealthSnapshot({ disk: { ...base, total: { count: '3', ms: 0, slow: 0, failures: 0 } } }).disk, null, 'count 非数字 ⇒ null（不猜）')
  assert.equal(buildHealthSnapshot({ disk: { ...base, total: { count: 0, ms: 0, slow: 0, failures: 0 } } }).disk, null)
  assert.equal(buildHealthSnapshot({ disk: { ...base, total: { count: -1, ms: 0, slow: 0, failures: 0 } } }).disk, null, '负计数非法 ⇒ null')
})

test('★ 收口④（联证真实来源）：埋点关闭 / 本会话零写入 ⇒ 真实遥测的 snapshot 被聚合器收口为 null', () => {
  const off = createDiskTelemetry({ enabled: false })
  assert.equal(buildHealthSnapshot({ disk: off.snapshot() }).disk, null, 'PONOS_DISK_TELEMETRY=0 ⇒ 无观测 ⇒ null')
  const idle = createDiskTelemetry()
  assert.equal(idle.snapshot().health, 'ok', '（前提）零写入时遥测自身报 ok —— 正是要收口的那个歧义')
  assert.equal(buildHealthSnapshot({ disk: idle.snapshot() }).disk, null, '本会话一次都没写 ⇒ 无观测 ⇒ null')
  idle.note('loop-state', 3, true) // 一旦真有一次写入 ⇒ 可观测 ⇒ 透传
  const d = buildHealthSnapshot({ disk: idle.snapshot() }).disk
  assert.notEqual(d, null)
  assert.equal(d.total.count, 1)
  assert.equal(d.health, 'ok')
})

// ── 落盘档位与自愈的关系（2026-09-23 批 2 口径修正，端到端接真源）────────────────────
// 快照是**派生视图**：`disk` 段由 `disk-telemetry#snapshot()` 投影，故"自愈修好的写不产生
// 告警"这条口径必须能从**真源**一路读到聚合结果里（不是只看 telemetry 的单测）。
test('★ 口径修正端到端：被 L0 救回的写 ⇒ 聚合后 health 仍 ok（GUI 红徽标据此不出现）', () => {
  const t = createDiskTelemetry({ slowMs: 1000, p95MinSamples: 99 })
  let n = 0
  const r = diskWrite(t, 'transcript-append', () => { n += 1; if (n === 1) throw new Error('EBUSY: resource busy'); return 'ok' }, { critical: true })
  assert.equal(r.level, 'L0', '前提：L0 确实救回了')
  const d = buildHealthSnapshot({ disk: t.snapshot() }).disk
  assert.notEqual(d, null, '有样本 ⇒ 段仍透传（收口只针对"零样本"）')
  assert.equal(d.health, 'ok', '★ 自愈成功 ⇒ 透传给 GUI 的档位不是 failing')
  assert.equal(d.total.unhealed, 0, '新计数必须随段上 wire（GUI 的失败次数/失败点取自它）')
  assert.equal(d.total.failures, 1, '隐患热度也随段上 wire（愈合事实不丢失）')
  assert.equal(d.healLevel, 'L0')
  assert.equal(d.sites['transcript-append'].unhealed, 0)
})

test('★ 口径修正端到端：关键项终局失败 ⇒ 聚合后 health=failing 且失败点/次数/末次错误齐备', () => {
  const t = createDiskTelemetry({ slowMs: 1000, p95MinSamples: 99 })
  diskWrite(t, 'transcript-append', () => { throw new Error('ENOSPC: no space left on device') }, { critical: true })
  const d = buildHealthSnapshot({ disk: t.snapshot() }).disk
  assert.equal(d.health, 'failing')
  assert.equal(d.total.unhealed, 1, '未愈合计数（用户可见口径）= 1 次逻辑写（不是 2 次 attempt）')
  assert.equal(d.sites['transcript-append'].unhealed, 1, '失败点可定位')
  assert.match(d.sites['transcript-append'].lastError, /ENOSPC/)
})

test('★ 不含时间戳（帧时序即时间；加时间戳会让"派生视图"纪律出现唯一例外）', () => {
  const s = buildHealthSnapshot({ health: { remainingPct: 1 } })
  for (const k of ['at', 'generatedAt', 'ts', 'timestamp', 'now', 'time']) {
    assert.ok(!(k in s), `不得含时间字段 ${k}`)
  }
  const src = read('../kernel/health-snapshot.mjs')
  assert.ok(!/Date\.now|new Date\(/.test(src), '聚合器不得读时钟')
})

/** 去掉注释后的**代码**（本文件要用它判"有没有 import"，而源码注释里正写着"不 import 判定模块"）。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

test('★ 静态：聚合器是纯读取——不得 import 判定模块、不得含判定/副作用', () => {
  const src = read('../kernel/health-snapshot.mjs')
  const code = stripComments(src)

  // ── 反向白名单（2026-09-25 复审 ⑥，比黑名单更强）──────────────────────────────
  // 原实现只列了 4 个模块名的黑名单，实测变异：聚合器里 `import { computeHealthScore }
  // from './health.mjs'` ⇒ **全绿**（漏洞：漏列判定源就能溜过去，且每新增一个判定模块就漏一次）。
  // 聚合器当前**零 import**（只导出常量与纯函数），故直接断言"源码里不出现任何 import/require"：
  // 这不是"当前碰巧成立"的约束，而是本模块的**定义**——一旦它 import 任何东西，就说明它开始
  // 认识来源/开始自己算（纪律①"派生视图不是新事实"、纪律③"纯读取"）。
  assert.doesNotMatch(code, /\bimport\b|\brequire\b|\bimport\s*\(/,
    '聚合器必须**零 import**（不得以任何形式引入其它模块：认识来源就会长出第二套真相）')

  // 黑名单作为**第二道**保留：万一将来有人把零 import 断言改成白名单，逐个点名仍有价值。
  for (const banned of ['heal-ladder', 'disk-telemetry', 'loop-core', 'engine.mjs',
    'health.mjs', 'fidelity.mjs', 'guards.mjs']) {
    assert.ok(!code.includes(banned), `聚合器不得依赖 ${banned}（判定归判定模块，聚合器只读）`)
  }
  for (const banned of ['writeFile', 'writeFileSync', 'process.env', 'setTimeout', 'setInterval']) {
    assert.ok(!code.includes(banned), `聚合器不得含副作用 ${banned}`)
  }
})

test('★ 幂等：同一输入两次聚合得同一结果（不得带隐藏状态）', () => {
  const input = { health: { remainingPct: 5 }, guard: { hits: ['stall'], injections: 1 } }
  assert.deepEqual(buildHealthSnapshot(input), buildHealthSnapshot(input))
})
