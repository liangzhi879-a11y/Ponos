// 落盘域自愈阶梯（2026-09-23 spec §4.1）：多数问题自愈、严重才提醒。
// 关键断言是"**不该告警的时候绝不告警**"——瞬时 EBUSY 被 L0 救回、次要项失败被 L2 舍掉，
// 用户都不该被打扰；只有关键项持续失败（L3）才提醒。
//
// ── 实施期（Task 7）追加的三组断言（原计划未覆盖，但都是本任务引入的行为）──────────────
//   ⑧ **慢盘声明的节流**：最高频落盘点 per-entry 调 diskWrite ⇒ 无冷却时慢盘下"每条 entry 一个声明"，
//      而声明要经 stdout 往外发（本身可能是延迟源）⇒ 冷却 = windowMs/2，且**不延长**豁免窗口。
//   ⑨ **回滚开关**：`PONOS_DISK_TELEMETRY=0` 时自愈一并关闭，逐字回"直接调用一次"。
//   ⑩ **级别进埋点**：到达的级别要进快照 `healLevel`（否则该字段永远是 null = 观测面死的）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDiskTelemetry, judgeDiskWait } from '../kernel/disk-telemetry.mjs'
import { configureDiskWriter, diskWrite, resetDiskTelemetry } from '../kernel/disk-write.mjs'

const telemetry = () => createDiskTelemetry({ slowMs: 1000, p95MinSamples: 99 })

test('L0：首次失败后立即重试一次即成功 ⇒ level=L0、**不告警**、返回值原样', () => {
  const t = telemetry()
  const heals = []
  let n = 0
  const r = diskWrite(t, 'transcript-append', () => { n += 1; if (n === 1) throw new Error('EBUSY: resource busy'); return 'ok' },
    { critical: true, onHeal: (reason) => heals.push(reason) })
  assert.equal(r.ok, true)
  assert.equal(r.value, 'ok')
  assert.equal(r.level, 'L0')
  assert.equal(r.reason, 'disk-write-retry')
  assert.deepEqual(heals, ['disk-write-retry'], '自愈须上报（供阶梯观测）')
  assert.equal(n, 2, '第一次失败后必须**真的**再试一次（自愈不是记账）')
  assert.equal(t.snapshot().sites['transcript-append'].failures, 1, '失败仍如实计数（自愈成功不等于没失败过）')
})

test('L1：重试仍败 ⇒ 换策略（fallback）成功 ⇒ level=L1、不告警', () => {
  const t = telemetry()
  const heals = []
  const r = diskWrite(t, 'transcript-append',
    () => { throw new Error('EACCES') },
    { critical: true, fallback: () => 'via-tmp-rename', onHeal: (x) => heals.push(x) })
  assert.equal(r.ok, true)
  assert.equal(r.value, 'via-tmp-rename')
  assert.equal(r.level, 'L1')
  assert.equal(r.reason, 'disk-strategy-fallback')
  assert.deepEqual(heals, ['disk-write-retry', 'disk-strategy-fallback'], '两级手段都试过')
})

test('★ L2：非关键项持续失败 ⇒ 舍掉（shed），level=L2，**不告警**', () => {
  const t = telemetry()
  const heals = []
  let fallbackCalls = 0
  const r = diskWrite(t, 'tool-result', () => { throw new Error('EROFS: read-only') },
    { fallback: () => { fallbackCalls += 1; return 'never' }, onHeal: (x) => heals.push(x) })
  assert.equal(r.ok, false)
  assert.equal(r.shed, true, '非关键项降规模 = 舍掉，不是失败告警')
  assert.equal(r.level, 'L2')
  assert.equal(r.reason, 'disk-shed-secondary')
  assert.equal(fallbackCalls, 0, '非关键项不试 fallback（换策略留给关键项）')
  assert.deepEqual(heals, ['disk-write-retry', 'disk-shed-secondary'], '非关键项不试 fallback（换策略留给关键项）')
})

test('★ L3：关键项持续失败 ⇒ level=L3、reason=disk-critical-persist-fail（**唯一告警闸门**）', () => {
  const t = telemetry()
  const heals = []
  const r = diskWrite(t, 'transcript-append', () => { throw new Error('ENOSPC: no space left') }, { critical: true, onHeal: (x) => heals.push(x) })
  assert.equal(r.ok, false)
  assert.equal(r.level, 'L3')
  assert.equal(r.reason, 'disk-critical-persist-fail')
  assert.equal(r.error.message.includes('ENOSPC'), true, '错误须原样交回（据此告警文案）')
  // L3 是唯一"可告警"级别：本包装自己不告警，只把 level/reason 交给上层（批 1 的红色徽标据此收口）
  assert.deepEqual(heals, ['disk-write-retry', 'disk-critical-persist-fail'], '到达 L3 的两级手段都要可观测')
})

test('★ 成功路径逐字不变：无需自愈时 level=null 且不触发 onHeal（零噪音）', () => {
  const t = telemetry()
  let called = 0
  const r = diskWrite(t, 'loop-state', () => 'w', { onHeal: () => { called += 1 } })
  assert.deepEqual(r, { ok: true, value: 'w', level: null, reason: null })
  assert.equal(called, 0)
  assert.equal(t.snapshot().healLevel, null, '没自愈过 ⇒ 快照不得凭空报级')
})

test('★ CRITICAL_DISK_SITES 是唯一判据：critical 未显式传入时按 site 判定', () => {
  const t = telemetry()
  // transcript-append 属关键项 ⇒ 不传 critical 也走 L3
  const a = diskWrite(t, 'transcript-append', () => { throw new Error('x') })
  assert.equal(a.level, 'L3')
  // loop-state 非关键 ⇒ L2
  const b = diskWrite(t, 'loop-state', () => { throw new Error('x') })
  assert.equal(b.level, 'L2')
})

test('自愈不改变"埋点零开销"性质：关闭埋点时自愈也关闭（回滚开关语义）', () => {
  const t = createDiskTelemetry({ enabled: false })
  let calls = 0
  const r = diskWrite(t, 'transcript-append', () => { calls += 1; throw new Error('x') }, { critical: true })
  assert.equal(calls, 1, '关闭埋点 ⇒ 不重试（回到"直接调用一次"的旧行为）')
  assert.equal(r.ok, false)
  assert.equal(r.level, null)
})

// ── ⑧ 慢盘声明节流 ────────────────────────────────────────────────────────────
// 现场形态：P95 被一次慢写抬到 1000ms（AV 扫描/网络盘），此后 100 次写都很快 —— 无冷却时
// 每次写都会重发同一份声明（100 个 stdout 帧），而豁免窗口本来就是同一个。
test('★ 节流：慢盘下连续 100 次写只声明极少数次（远小于 100），且窗口不因反复声明而延长', () => {
  resetDiskTelemetry() // 清冷却状态（本用例用显式实例，但冷却状态是模块级的）
  const t = createDiskTelemetry({ slowMs: 1000, p95MinSamples: 5, window: 512 })
  for (let i = 0; i < 200; i++) t.note('transcript-append', 1000, true) // 200 个慢样本留在窗口里
  const declares = []
  configureDiskWriter({ onDeclare: (d) => declares.push(d) })
  try {
    for (let i = 0; i < 100; i++) {
      const r = diskWrite(t, 'transcript-append', () => 'ok')
      assert.deepEqual(r, { ok: true, value: 'ok', level: null, reason: null }, '成功路径不受慢盘判定影响')
    }
  } finally { configureDiskWriter({ onDeclare: null }) }

  const pure = judgeDiskWait({ telemetry: t, site: 'transcript-append', now: 0, exemptMaxMs: 120000, slowMs: 1000 })
  assert.equal(pure.declare, true, '前提：该现场确实被判为"慢盘"（否则本用例空转）')
  assert.equal(pure.windowMs, 2000, '前提：窗口 = min(round(P95×2), 上限) = 2000ms')
  assert.ok(declares.length >= 1, '慢盘必须至少声明一次（否则豁免失效、磁盘又会被击穿）')
  assert.ok(declares.length < 10, `★ 100 次写的声明次数必须远小于 100（实际 ${declares.length} 次）— 无冷却时会恰好 100 次`)
  for (const d of declares) {
    assert.equal(d.site, 'transcript-append')
    assert.equal(d.windowMs, pure.windowMs, '★ 声明的窗口必须恒等于纯函数算出的窗口 ⇒ 反复声明**不叠加、不延长**')
    assert.equal(d.reason, 'p95-slow')
    assert.equal(d.basis, 1000)
  }
  assert.equal(judgeDiskWait({ telemetry: t, site: 'transcript-append', now: Date.now(), exemptMaxMs: 120000, slowMs: 1000 }).windowMs,
    pure.windowMs, '写 100 次之后窗口仍不变（声明不得污染 P95 判定）')
})

test('★ 节流只"去重"不"续期"：冷却到期后可再声明、换 site 立即可声明、窗口恒为纯函数值', async () => {
  resetDiskTelemetry()
  const t = createDiskTelemetry({ slowMs: 1000, p95MinSamples: 1, window: 512 })
  for (let i = 0; i < 8; i++) { t.note('transcript-append', 1000, true); t.note('loop-state', 1000, true) }
  const declares = []
  configureDiskWriter({ onDeclare: (d) => declares.push(d) })
  const w = { exemptMaxMs: 20 } // ⇒ windowMs = min(2000, 20) = 20 ⇒ 冷却 = 10ms（本用例内可确定地"过期"）
  try {
    diskWrite(t, 'transcript-append', () => 'a', w) // ① 声明
    diskWrite(t, 'loop-state', () => 'b', w)        // ② 另一 site 不受本 site 冷却影响 ⇒ 声明
    diskWrite(t, 'transcript-append', () => 'a', w) // ③ 距 ① 不足 10ms ⇒ 冷却挡下（不重复发同一份声明）
    await new Promise((r) => setTimeout(r, 20))     // 冷却到期
    diskWrite(t, 'transcript-append', () => 'a', w) // ④ 再声明（冷却不是"只声明一次"）
  } finally { configureDiskWriter({ onDeclare: null }) }
  assert.deepEqual(declares.map((d) => d.site), ['transcript-append', 'loop-state', 'transcript-append'],
    `实际 ${JSON.stringify(declares.map((d) => d.site))}`)
  for (const d of declares) assert.equal(d.windowMs, 20, '冷却不改变声明窗口（只去重，不续期）')
})

// ── ⑪ 用户可见档位（2026-09-23 批 2 口径修正）：自愈修好的写**不得**产生告警 ──────────────
// Task 7 复核实测的冲突：`health` 原本按 `failures > 0` 判档，而 L0 重试让"一次逻辑写 = 2 次
// attempt" ⇒ 一次被 L0 救回的瞬时 EBUSY 也报 `failing` ⇒ GUI（`diskBadge` 判 `health==='failing'`）
// 给用户一个红徽标 —— 自愈成功却打扰用户，与总原则（多数问题自愈、单次失败绝不打扰）矛盾。
// 修正：内核侧分账 `failures`（attempt 级，隐患热度）/ `unhealed`（终局未落盘的逻辑写），
// `health` 只由后者判档。下表 5 行是**用户可见结果**的判据，逐行钉住。
test('★ 口径修正①：瞬时 EBUSY 被 L0 救回 ⇒ health 不 failing（无红徽标）、热度仍可见', () => {
  const t = telemetry()
  let n = 0
  const r = diskWrite(t, 'transcript-append', () => { n += 1; if (n === 1) throw new Error('EBUSY: resource busy'); return 'ok' },
    { critical: true, fallback: () => 'fb' })
  assert.equal(r.ok, true)
  assert.equal(r.level, 'L0')
  const s = t.snapshot()
  assert.equal(s.health, 'ok', '★ 被自愈修好的写 ⇒ 用户可见结果必须是"没告警"（修前实测为 failing）')
  assert.equal(s.total.unhealed, 0)
  assert.equal(s.total.failures, 1, '愈合事实不得丢失：失败尝试照记（隐患热度）')
  assert.equal(s.healLevel, 'L0', '愈合事实不得丢失：到达过 L0')
})

test('★ 口径修正②：关键项先败、L1 换策略成功 ⇒ health 不 failing', () => {
  const t = telemetry()
  const r = diskWrite(t, 'transcript-append', () => { throw new Error('EACCES') }, { critical: true, fallback: () => 'via-tmp-rename' })
  assert.equal(r.level, 'L1')
  const s = t.snapshot()
  assert.equal(s.health, 'ok', '★ 换策略救回 ⇒ 不打扰用户（修前实测为 failing）')
  assert.equal(s.total.unhealed, 0)
  assert.equal(s.total.failures, 2, '两次失败尝试 + 一次 fallback 成功：热度照记')
  assert.equal(s.healLevel, 'L1')
})

test('★ 口径修正③：非关键项持续失败被 L2 舍掉 ⇒ health 不 failing（既有 best-effort 语义不变）', () => {
  const t = telemetry()
  const r = diskWrite(t, 'tool-result', () => { throw new Error('EROFS: read-only') })
  assert.equal(r.shed, true)
  const s = t.snapshot()
  assert.equal(s.health, 'ok', '★ 舍次不是告警（修前实测为 failing）')
  assert.equal(s.total.unhealed, 0)
  assert.equal(s.total.failures, 2)
  assert.equal(s.healLevel, 'L2')
  // 该点非关键 ⇒ 调用点本来就静默降级（见 disk-sites-behavior），这里不新增任何用户可见提示。
  assert.equal(s.sites['tool-result'].unhealed, 0)
})

test('★ 口径修正④：关键项 transcript-append 持续失败（L3）⇒ 唯一进 failing 的终局，且带失败点/次数/末次错误', () => {
  const t = telemetry()
  const r = diskWrite(t, 'transcript-append', () => { throw new Error('ENOSPC: no space left on device') }, { critical: true })
  assert.equal(r.level, 'L3')
  const s = t.snapshot()
  assert.equal(s.health, 'failing', '★ 这是唯一可以醒目告警的终局')
  assert.equal(s.total.unhealed, 1, '一次逻辑写终局未落盘 ⇒ unhealed +1（不是按 attempt 的 2）')
  assert.equal(s.sites['transcript-append'].unhealed, 1, '失败点可定位（该点 unhealed>0）')
  assert.equal(s.total.failures, 2, 'attempt 级热度仍如实为 2')
  assert.match(s.sites['transcript-append'].lastError, /ENOSPC/, '末次错误可讲（卡片据此渲染）')
})

test('★ 口径修正⑤：持续慢盘（写都成功）⇒ slow（琥珀，持续状态预警）而不是 failing', () => {
  const t = createDiskTelemetry({ slowMs: 1000, p95MinSamples: 5 })
  for (let i = 0; i < 8; i++) diskWrite(t, 'transcript-append', () => 'ok') // 写都成功（P95 由 note 造样本）
  for (let i = 0; i < 200; i++) t.note('transcript-append', 1500, true)
  const s = t.snapshot()
  assert.equal(s.total.failures, 0)
  assert.equal(s.health, 'slow', '★ 慢 ≠ 失败：这是持续状态预警（琥珀），不是"单次失败告警"（红）')
  assert.equal(s.p95Ms !== null && s.p95Ms >= 1000, true, '前提：P95 确实越过阈值')
})

test('★ 不变式：终局失败必带 L2/L3（否则 `unhealed` 记账会静默漏掉告警）', () => {
  // `unhealed` 由"到达的级别"推出：终局 attempt 若漏传级别（null），failing 会**静默消失**
  // —— 这正是最危险的退化（用户不再被告知"关键数据没落盘"）。故逐条终局路径钉住它交给埋点的级别。
  const spy = () => {
    const notes = []
    return {
      notes,
      begin: () => ({ site: 'transcript-append', t0: 0 }),
      end: (token, ok, err, level) => { notes.push({ ok: ok === true, level: level ?? null }); return null },
    }
  }
  // L3（关键项，无 fallback）
  const a = spy()
  diskWrite(a, 'transcript-append', () => { throw new Error('ENOSPC') }, { critical: true })
  assert.deepEqual(a.notes.map((n) => n.level), [null, 'L3'], '关键项终局 ⇒ 必带 L3')
  // L3（关键项，fallback 也失败：fallback 那次的失败同样带 L3）
  const b = spy()
  diskWrite(b, 'transcript-append', () => { throw new Error('ENOSPC') }, { critical: true, fallback: () => { throw new Error('EACCES') } })
  assert.deepEqual(b.notes.map((n) => n.level), [null, null, 'L3'], 'fallback 失败 ⇒ 终局仍带 L3')
  // L2（非关键项舍次）
  const c = spy()
  diskWrite(c, 'tool-result', () => { throw new Error('EROFS') })
  assert.deepEqual(c.notes.map((n) => n.level), [null, 'L2'], '非关键项终局 ⇒ 必带 L2（舍次，不告警）')
  // L0/L1 救回：终局是**成功**的 attempt ⇒ 无"终局失败"可言
  const d = spy()
  let n = 0
  diskWrite(d, 'transcript-append', () => { n += 1; if (n === 1) throw new Error('EBUSY'); return 'ok' }, { critical: true })
  assert.deepEqual(d.notes.map((x) => [x.ok, x.level]), [[false, null], [true, 'L0']], 'L0 救回：终局是成功（无未愈合）')
})

// ── ⑨ 回滚开关（Global Constraints）──────────────────────────────────────────
test('★ 回滚：PONOS_DISK_TELEMETRY=0 ⇒ 逐字回"直接调用一次"（不重试、不换策略、不声明、级别 null）', () => {
  const old = process.env.PONOS_DISK_TELEMETRY
  process.env.PONOS_DISK_TELEMETRY = '0'
  resetDiskTelemetry()
  const declares = []
  const heals = []
  configureDiskWriter({ onDeclare: (d) => declares.push(d) })
  try {
    const boom = new Error('EBUSY: resource busy')
    let calls = 0
    let fallbackCalls = 0
    const r = diskWrite(null, 'transcript-append', () => { calls += 1; throw boom },
      { critical: true, fallback: () => { fallbackCalls += 1; return 'never' }, onHeal: (x) => heals.push(x) })
    assert.equal(calls, 1, '★ 逐字回旧行为：只调用一次（不重试）')
    assert.equal(fallbackCalls, 0, '关闭埋点 ⇒ 不换策略')
    assert.equal(r.error, boom, '错误原样交回（调用点自行决定是否重抛）')
    assert.deepEqual(r, { ok: false, error: boom, shed: false, level: null, reason: null })
    assert.deepEqual(heals, [], '关闭埋点 ⇒ 不产生任何自愈事件（没有观测就不该有看不见的重试）')
    assert.deepEqual(declares, [], '关闭埋点 ⇒ 不声明豁免')
    assert.deepEqual(diskWrite(null, 'loop-state', () => 'v'), { ok: true, value: 'v', level: null, reason: null })
  } finally {
    configureDiskWriter({ onDeclare: null })
    if (old === undefined) delete process.env.PONOS_DISK_TELEMETRY
    else process.env.PONOS_DISK_TELEMETRY = old
    resetDiskTelemetry()
  }
})

// ── ⑩ 级别进埋点（快照 healLevel 的唯一来源）────────────────────────────────
test('★ 级别进埋点：到达的级别进快照 healLevel（取最高级），成功路径不凭空报级', () => {
  const t = createDiskTelemetry({ p95MinSamples: 99, slowMs: 1000 })
  let n = 0
  diskWrite(t, 'loop-state', () => { n += 1; if (n === 1) throw new Error('EBUSY') }) // L0 救回
  assert.equal(t.snapshot().healLevel, 'L0', 'L0 也要可观测（否则"自愈了很多次"与"没自愈"看起来一样）')
  diskWrite(t, 'transcript-append', () => { throw new Error('ENOSPC') }, { critical: true })
  assert.equal(t.snapshot().healLevel, 'L3', '取最高级')
})
