// 落盘遥测（纯函数）：分点记账 + P95 + 豁免判定。
// 为什么这些断言值得写：① 记账若算错，"磁盘慢"这个结论就是假的（比没有更糟）；
// ② 豁免判定的三个边界（未达阈不声明/窗口有界/不叠加）正是心跳设计里踩过的坑，
//    必须由测试钉住而不是靠实现自觉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CRITICAL_DISK_SITES, DEFAULT_DISK_EXEMPT_MAX_MS, DEFAULT_DISK_SLOW_MS, DISK_SITES,
  createDiskTelemetry, judgeDiskWait, percentile, resolveDiskConfig,
} from '../kernel/disk-telemetry.mjs'

test('DISK_SITES：恰为 5 个落盘点、且与勘察表格逐字一致', () => {
  assert.deepEqual([...DISK_SITES], [
    'transcript-append', 'transcript-usage', 'session-memory', 'loop-state', 'tool-result',
  ])
  assert.deepEqual([...CRITICAL_DISK_SITES], ['transcript-append'], '关键项只有 transcript-append（丢了就真丢）')
  for (const s of CRITICAL_DISK_SITES) assert.ok(DISK_SITES.includes(s), '关键项必须是合法 site')
})

test('percentile：空/单样本/常规；p95 逼近最大值但不被单点完全支配（小窗口用最近秩）', () => {
  assert.equal(percentile([], 0.95), null, '无样本 ⇒ null（不填 0）')
  assert.equal(percentile([7], 0.95), 7)
  assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 50)
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2)
  assert.equal(percentile([5, 1, 3], 0.95), 5, '不要求输入有序')
})

test('percentile：非法 p ⇒ null（不得返回 undefined 冒充"知道"——导出函数会被 Task 4/5 复用）', () => {
  // 修前实测：p=NaN ⇒ idx=Math.min/max(...NaN)=NaN ⇒ sorted[NaN] === undefined（违反声明的 number|null，
  // 下游用 `p95 === null` 判"不知道"时会把 undefined 当成"知道"）。
  assert.equal(percentile([1, 2, 3], NaN), null)
  assert.equal(percentile([1, 2, 3], Infinity), null, 'Infinity 也不是合法分位 ⇒ 同样 fail-closed 为 null（旧行为会返回最大值，属"拿非法输入造出个数字"）')
  assert.equal(percentile([1, 2, 3], 1), 3, 'p=1 ⇒ 最大值（合法分位的上界继续可用）')
  assert.equal(percentile([1, 2, 3], 0), 1, 'p=0 ⇒ 最小值')
  assert.equal(percentile([1, 2, 3], undefined), percentile([1, 2, 3], 0.95), '显式 undefined ⇒ 用默认 p')
})

test('resolveDiskConfig：PONOS_KERNEL_DISK_EXEMPT_MS 的 0 变体都是关闭语义（回滚开关必须 fail-safe）', () => {
  // 修前实测：'0 ' / ' 0' / '0.0' / '00' 落到"非法 ⇒ 回落默认 120000"分支 ⇒ **豁免全开**（方向反了）。
  for (const v of ['0', '0 ', ' 0', '0.0', '00', '0e0', ' +0 ']) {
    assert.equal(resolveDiskConfig({ PONOS_KERNEL_DISK_EXEMPT_MS: v }).exemptMaxMs, 0, `${JSON.stringify(v)} ⇒ 关豁免`)
  }
  assert.equal(resolveDiskConfig({ PONOS_KERNEL_DISK_EXEMPT_MS: '0.5' }).exemptMaxMs, 0.5, '非 0 ⇒ 按数值用（不是关闭）')
  assert.equal(resolveDiskConfig({ PONOS_KERNEL_DISK_EXEMPT_MS: ' 5000 ' }).exemptMaxMs, 5000)
  assert.equal(resolveDiskConfig({ PONOS_KERNEL_DISK_EXEMPT_MS: '' }).exemptMaxMs, DEFAULT_DISK_EXEMPT_MAX_MS, '空串不是"显式 0" ⇒ 默认')
  assert.equal(resolveDiskConfig({ PONOS_KERNEL_DISK_EXEMPT_MS: 'abc' }).exemptMaxMs, DEFAULT_DISK_EXEMPT_MAX_MS)
  // PONOS_DISK_SLOW_MS 无"关闭"语义：0/负值仍是"非法 ⇒ 默认"，不被上面的宽容口径带跑
  assert.equal(resolveDiskConfig({ PONOS_DISK_SLOW_MS: '0' }).slowMs, DEFAULT_DISK_SLOW_MS)
  assert.equal(resolveDiskConfig({ PONOS_DISK_SLOW_MS: ' 0 ' }).slowMs, DEFAULT_DISK_SLOW_MS)
  assert.equal(resolveDiskConfig({ PONOS_DISK_SLOW_MS: '750' }).slowMs, 750)
})

test('resolveDiskConfig：默认值 + 显式 0 关闭豁免 + 非法值回落默认', () => {
  assert.deepEqual(resolveDiskConfig({}), { enabled: true, slowMs: DEFAULT_DISK_SLOW_MS, exemptMaxMs: DEFAULT_DISK_EXEMPT_MAX_MS })
  assert.equal(resolveDiskConfig({ PONOS_DISK_TELEMETRY: '0' }).enabled, false, 'PONOS_DISK_TELEMETRY=0 ⇒ 关埋点')
  assert.equal(resolveDiskConfig({ PONOS_KERNEL_DISK_EXEMPT_MS: '0' }).exemptMaxMs, 0, '显式 0 ⇒ 关豁免（逐字回旧行为）')
  assert.equal(resolveDiskConfig({ PONOS_KERNEL_DISK_EXEMPT_MS: '5000' }).exemptMaxMs, 5000)
  assert.equal(resolveDiskConfig({ PONOS_KERNEL_DISK_EXEMPT_MS: 'abc' }).exemptMaxMs, DEFAULT_DISK_EXEMPT_MAX_MS, '非法 ⇒ 默认（不得变成 NaN）')
  assert.equal(resolveDiskConfig({ PONOS_DISK_SLOW_MS: '-1' }).slowMs, DEFAULT_DISK_SLOW_MS)
})

test('记账：按点分账 count/totalMs/maxMs/slow/failures/lastError，互不串味', () => {
  let t = 0
  const telem = createDiskTelemetry({ slowMs: 100, now: () => t })
  t = 0; const tok = telem.begin('transcript-append'); t = 300; telem.end(tok, true)
  t = 1000; telem.note('transcript-append', 50, true)
  t = 2000; telem.note('loop-state', 5, false, new Error('EACCES: permission denied'))
  const s = telem.snapshot()
  assert.equal(s.sites['transcript-append'].count, 2)
  assert.equal(s.sites['transcript-append'].totalMs, 350)
  assert.equal(s.sites['transcript-append'].maxMs, 300)
  assert.equal(s.sites['transcript-append'].slow, 1, '仅 300ms 那次达到 100ms 阈值（口径是 >=，不是 >）')
  assert.equal(s.sites['transcript-append'].failures, 0)
  assert.equal(s.sites['loop-state'].count, 1)
  assert.equal(s.sites['loop-state'].failures, 1)
  assert.match(s.sites['loop-state'].lastError, /EACCES/)
  assert.equal(s.sites['tool-result'].count, 0, '未用过的点如实为 0 计数（表示"没写过"）')
  assert.equal(s.total.count, 3)
  assert.equal(s.maxMs, 300)
  assert.equal(s.slowestSite, 'transcript-append')
})

// ── health 判档（2026-09-23 批 2 口径修正）─────────────────────────────────────
// 旧口径 `failures > 0 ⇒ failing` 与总原则（"多数问题自愈、单次失败绝不打扰用户"）冲突：
// L0 让"一次逻辑写 = 最多 2～3 次 attempt"，于是**被 L0 救回的瞬时 EBUSY** 也报 failing
// ⇒ GUI 红徽标 ⇒ 自愈成功却打扰用户。新口径把两个计数分开：
//   failures（attempt 级，隐患热度，自愈成功也照记） / unhealed（终局未落盘的逻辑写，用户可见）
//   health = unhealed > 0 ? 'failing' : (slow > 0 ? 'slow' : 'ok')
test('★ health 判档：只有"终局未愈合"（到达 L3）才 failing；L0/L1 救回与 L2 舍次都不 failing', () => {
  const t = createDiskTelemetry({ slowMs: 100 })
  assert.equal(t.snapshot().health, 'ok')

  // ① L0 救回：第一次失败（无级别，尚未定级）+ 重试成功（'L0'）⇒ 有失败热度、但**无**用户可见告警
  t.note('transcript-append', 5, false, new Error('EBUSY'), null)
  t.note('transcript-append', 5, true, null, 'L0')
  let s = t.snapshot()
  assert.equal(s.sites['transcript-append'].failures, 1, '失败尝试照记（隐患热度不丢）')
  assert.equal(s.sites['transcript-append'].unhealed, 0, '被 L0 救回 ⇒ 不算未愈合')
  assert.equal(s.health, 'ok', '★ 自愈成功的写不得产生用户可见告警（旧口径下这里是 failing）')
  assert.equal(s.healLevel, 'L0', '"这里发生过愈合"这一事实仍可见')

  // ② L2 舍次（非关键项，可重建）⇒ 也不算未愈合、不告警（best-effort 既有语义）
  const t2 = createDiskTelemetry({ slowMs: 100 })
  t2.note('tool-result', 5, false, new Error('EROFS'), null)
  t2.note('tool-result', 5, false, new Error('EROFS'), 'L2')
  assert.equal(t2.snapshot().health, 'ok', '舍次不是告警（旧口径下这里是 failing）')
  assert.equal(t2.snapshot().total.failures, 2)
  assert.equal(t2.snapshot().total.unhealed, 0)

  // ③ 关键项终局失败（到达 L3）⇒ 唯一进 failing 的终局
  const t3 = createDiskTelemetry({ slowMs: 100 })
  t3.note('transcript-append', 5, false, new Error('ENOSPC'), null)
  t3.note('transcript-append', 5, false, new Error('ENOSPC'), 'L3')
  const s3 = t3.snapshot()
  assert.equal(s3.health, 'failing', '关键项持续失败 ⇒ 醒目告警')
  assert.equal(s3.sites['transcript-append'].unhealed, 1, '一次逻辑写终局失败 ⇒ unhealed +1（不是 +2）')
  assert.equal(s3.total.failures, 2, 'attempt 级热度仍是 2（两次尝试都失败）')

  // ④ 仅慢 ⇒ slow（持续状态预警，与"单次失败"不同）；慢 + 未愈合 ⇒ failing 优先
  const t4 = createDiskTelemetry({ slowMs: 100 })
  t4.note('loop-state', 500, true)
  assert.equal(t4.snapshot().health, 'slow')
  t4.note('transcript-append', 500, false, new Error('ENOSPC'), 'L3')
  assert.equal(t4.snapshot().health, 'failing', '失败（数据可能没落盘）优先于慢')
})

test('★ `unhealed` 只在带 L3 级别的失败上记：不带级别的裸失败只进 failures（health 是"用户可见档位"，不是"发生过失败"）', () => {
  // 这条口径的边界必须显式钉住，否则"裸 note 失败"与"终局未愈合"会被混同：
  // 裸失败没有表达"这次写最终有没有落地"，而 health 回答的正是后者（前者由 failures 如实承载）。
  const t = createDiskTelemetry({ slowMs: 100 })
  t.note('loop-state', 1, false, new Error('EROFS'))
  assert.equal(t.snapshot().sites['loop-state'].failures, 1)
  assert.equal(t.snapshot().total.unhealed, 0)
  assert.equal(t.snapshot().health, 'ok')
  // 生产代码里 5 个落盘点全部经 diskWrite 的 begin/end ⇒ 终局失败恒带 L2/L3（有测试钉住该不变式），
  // 故这里不存在"裸失败导致告警丢失"的路径。
  assert.equal(createDiskTelemetry().snapshot().total.unhealed, 0, '零写入 ⇒ 0（不是 undefined）')
})

test('lastError：失败但没带 err ⇒ 不清空既有错误（保留最近一条有内容的信息）', () => {
  // 修前实测：先 note(...,false,Error('EROFS')) 得 'EROFS'，再 note(...,false,null) 被抹成 '' ⇒ 排障信息丢失。
  const telem = createDiskTelemetry({ slowMs: 100 })
  telem.note('loop-state', 1, false, new Error('EROFS: read-only file system'))
  assert.match(telem.snapshot().sites['loop-state'].lastError, /EROFS/)
  telem.note('loop-state', 1, false, null)
  assert.match(telem.snapshot().sites['loop-state'].lastError, /EROFS/, '无 err 的失败不得抹掉上一条真错误')
  assert.equal(telem.snapshot().sites['loop-state'].failures, 2, '但失败计数照记（信息缺失 ≠ 没失败）')
  telem.note('loop-state', 1, false, new Error('ENOSPC: no space left'))
  assert.match(telem.snapshot().sites['loop-state'].lastError, /ENOSPC/, '有内容的新错误 ⇒ 覆盖为最新')
})

test('healLevel：无自愈发生 ⇒ null（不虚报）；埋点传入 level ⇒ 取最高级', () => {
  const telem = createDiskTelemetry({ slowMs: 100 })
  telem.note('transcript-append', 1, true)
  assert.equal(telem.snapshot().healLevel, null, '批 1 无自愈 ⇒ 不得凭空报级')
  telem.note('transcript-append', 1, false, new Error('EBUSY'), 'L0')
  telem.note('transcript-append', 1, false, new Error('EBUSY'), 'L1')
  assert.equal(telem.snapshot().healLevel, 'L1')
  telem.note('transcript-append', 1, false, new Error('EBUSY'), 'L3')
  assert.equal(telem.snapshot().healLevel, 'L3', '取最高级')
  telem.note('transcript-append', 1, false, new Error('x'), 'wat')
  assert.equal(telem.snapshot().healLevel, 'L3', '非法 level 不得污染（保持既有最高）')
})

test('healLevel：原型链上的名字（toString/constructor/__proto__ 等）不是合法级别，且不得把真实级别卡死', () => {
  // 修前实测：`level in LEVEL_RANK` 认原型链 ⇒ note(...,'toString') 后 healLevel 停在 "toString"，
  // 且 LEVEL_RANK['toString'] 是函数、与数字比较恒 false ⇒ 之后真实级别 'L2' **再也记不上**（伪级永久卡住）。
  const protoNames = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']
  for (const name of protoNames) {
    const telem = createDiskTelemetry({ slowMs: 100 })
    assert.equal(telem.note('transcript-append', 1, false, new Error('EBUSY'), name).level, name, '返回值如实回显入参（不校验）')
    assert.equal(telem.snapshot().healLevel, null, `${name} 不是合法级别 ⇒ 不得进 healLevel`)
    telem.note('transcript-append', 1, false, new Error('EBUSY'), 'L2')
    assert.equal(telem.snapshot().healLevel, 'L2', `${name} 之后真实级别仍能正常记账（不被伪级卡死）`)
  }
})

test('p95Ms：样本不足 ⇒ null（不得用三两个样本就宣称"慢盘"）', () => {
  const telem = createDiskTelemetry({ p95MinSamples: 5 })
  for (let i = 0; i < 4; i++) telem.note('transcript-append', 900, true)
  assert.equal(telem.p95Ms('transcript-append'), null)
  telem.note('transcript-append', 900, true)
  assert.equal(telem.p95Ms('transcript-append'), 900)
  assert.equal(telem.p95Ms('loop-state'), null, '无样本 ⇒ null')
  assert.equal(telem.p95Ms('nope'), null, '未知 site ⇒ null')
})

test('★ 豁免判定：未达慢写阈值 ⇒ 不声明（正常磁盘零额外帧，不产生噪音）', () => {
  const telem = createDiskTelemetry({ p95MinSamples: 1 })
  for (let i = 0; i < 10; i++) telem.note('transcript-append', 20, true)
  const j = judgeDiskWait({ telemetry: telem, site: 'transcript-append', now: 0, slowMs: 1000, exemptMaxMs: 120000 })
  assert.equal(j.declare, false)
  assert.equal(j.reason, 'not-slow')
})

test('★ 豁免判定：慢盘才声明，窗口 = min(P95×2, 上限)（有界）', () => {
  const telem = createDiskTelemetry({ p95MinSamples: 1 })
  for (let i = 0; i < 10; i++) telem.note('transcript-append', 3000, true)
  const j = judgeDiskWait({ telemetry: telem, site: 'transcript-append', now: 0, slowMs: 1000, exemptMaxMs: 120000 })
  assert.equal(j.declare, true)
  assert.equal(j.windowMs, 6000, 'P95=3000 ⇒ 6000')
  assert.equal(j.basis, 3000, '依据须可查（P95 值）')
  // 上限生效：极慢盘也不会拿到无限窗口
  const slow = createDiskTelemetry({ p95MinSamples: 1 })
  for (let i = 0; i < 10; i++) slow.note('tool-result', 200000, true)
  const j2 = judgeDiskWait({ telemetry: slow, site: 'tool-result', now: 0, slowMs: 1000, exemptMaxMs: 120000 })
  assert.equal(j2.windowMs, 120000, 'min(P95×2=400000, 120000) = 120000（不会掩盖真死）')
})

test('★ 豁免判定：exemptMaxMs=0 ⇒ 永不声明（回滚开关逐字回旧行为）', () => {
  const telem = createDiskTelemetry({ p95MinSamples: 1 })
  for (let i = 0; i < 10; i++) telem.note('transcript-append', 5000, true)
  const j = judgeDiskWait({ telemetry: telem, site: 'transcript-append', now: 0, slowMs: 1000, exemptMaxMs: 0 })
  assert.equal(j.declare, false)
  assert.equal(j.windowMs, 0)
  assert.equal(j.reason, 'disabled')
})

test('slow 口径：耗时**恰好等于** slowMs 也算慢（>= 口径，与 spec §4.2「P95 ≥ 阈值」一致）', () => {
  const telem = createDiskTelemetry({ slowMs: 100 })
  telem.note('transcript-append', 100, true)
  assert.equal(telem.snapshot().sites['transcript-append'].slow, 1, '100ms ⇒ 计 slow（不是 >100 才算）')
  assert.equal(telem.snapshot().health, 'slow')
  const below = createDiskTelemetry({ slowMs: 100 })
  below.note('transcript-append', 99, true)
  assert.equal(below.snapshot().sites['transcript-append'].slow, 0, '99ms ⇒ 不计 slow')
})

test('★ 豁免判定：未知 site ⇒ reason "unknown-site"（与"确实不慢"分开，basis 仍 null）', () => {
  // 修前实测：site:'nope' ⇒ reason:'not-slow' ⇒ 埋点漏登记会被观测面洗成"这个点正常"。
  const telem = createDiskTelemetry({ p95MinSamples: 1 })
  for (let i = 0; i < 10; i++) telem.note('transcript-append', 5000, true)
  const j = judgeDiskWait({ telemetry: telem, site: 'nope', now: 0, slowMs: 1000, exemptMaxMs: 120000 })
  assert.deepEqual(j, { declare: false, windowMs: 0, reason: 'unknown-site', basis: null })
  assert.equal(judgeDiskWait({ telemetry: telem, site: undefined, now: 0 }).reason, 'unknown-site')
  // 已知但不慢的点仍是 not-slow（两态不得混同）
  const warm = createDiskTelemetry({ p95MinSamples: 1 })
  for (let i = 0; i < 10; i++) warm.note('tool-result', 5, true)
  assert.equal(judgeDiskWait({ telemetry: warm, site: 'tool-result', now: 0, slowMs: 1000, exemptMaxMs: 120000 }).reason, 'not-slow')
})

test('★ 豁免判定：亚毫秒窗口（<1ms）不得声明成功 ⇒ zero-window（别给"已豁免"的假安心）', () => {
  // 修前实测：p95=600、exemptMaxMs=0.4 ⇒ {declare:true, windowMs:0.4}（实质空操作却宣称豁免）。
  const telem = createDiskTelemetry({ p95MinSamples: 1 })
  for (let i = 0; i < 10; i++) telem.note('transcript-append', 600, true)
  const j = judgeDiskWait({ telemetry: telem, site: 'transcript-append', now: 0, slowMs: 0.1, exemptMaxMs: 0.4 })
  assert.deepEqual(j, { declare: false, windowMs: 0, reason: 'zero-window', basis: 600 }, '亚毫秒上限 ⇒ 不肯声明')
  // 0.2ms 的 P95（round(0.4)=0）同样是零窗口
  const tiny = createDiskTelemetry({ p95MinSamples: 1 })
  for (let i = 0; i < 10; i++) tiny.note('transcript-append', 0.2, true)
  assert.equal(judgeDiskWait({ telemetry: tiny, site: 'transcript-append', now: 0, slowMs: 0.1, exemptMaxMs: 0.4 }).reason, 'zero-window')
  // 边界：恰好 1ms 上限 ⇒ 声明（>=1 才算有效窗口）
  assert.equal(judgeDiskWait({ telemetry: telem, site: 'transcript-append', now: 0, slowMs: 0.1, exemptMaxMs: 1 }).windowMs, 1)
  assert.equal(judgeDiskWait({ telemetry: telem, site: 'transcript-append', now: 0, slowMs: 0.1, exemptMaxMs: 1 }).declare, true)
})

test('★ 豁免判定不含"多次声明叠加"逻辑：同一 site 反复判定得到同一窗口（不累加、不延长）', () => {
  const telem = createDiskTelemetry({ p95MinSamples: 1 })
  for (let i = 0; i < 10; i++) telem.note('session-memory', 2000, true)
  const a = judgeDiskWait({ telemetry: telem, site: 'session-memory', now: 0, slowMs: 1000, exemptMaxMs: 120000 })
  const b = judgeDiskWait({ telemetry: telem, site: 'session-memory', now: 1000, slowMs: 1000, exemptMaxMs: 120000 })
  assert.equal(a.windowMs, b.windowMs, '判定是纯函数：窗口只由 P95 与上限决定，不随调用次数增长')
  assert.equal(a.declare, b.declare)
})

test('关闭埋点：begin 返回 null、end 不记账（零开销路径）', () => {
  const telem = createDiskTelemetry({ enabled: false })
  const tok = telem.begin('transcript-append')
  assert.equal(tok, null)
  assert.equal(telem.end(tok, true), null)
  assert.equal(telem.snapshot().total.count, 0)
})

test('关闭埋点：note 也不记账（PONOS_DISK_TELEMETRY=0 的"逐字回旧行为"不得被绕过）', () => {
  // 修前实测：enabled:false 时 note('transcript-append',5000,false,Error('ENOSPC')) ⇒ total.count=1、health='failing'。
  const telem = createDiskTelemetry({ enabled: false, slowMs: 100 })
  assert.equal(telem.note('transcript-append', 5000, false, new Error('ENOSPC')), null)
  const s = telem.snapshot()
  assert.equal(s.total.count, 0)
  assert.equal(s.total.ms, 0)
  assert.equal(s.total.slow, 0)
  assert.equal(s.total.failures, 0)
  assert.equal(s.total.unhealed, 0, '关闭埋点 ⇒ 未愈合计数也不得记账（回滚开关不得被绕过）')
  assert.equal(s.health, 'ok')
  assert.equal(s.healLevel, null)
  assert.equal(s.p95Ms, null, '不记账 ⇒ 无样本 ⇒ 没有"慢盘"可宣称')
  assert.equal(telem.p95Ms('transcript-append'), null)
  assert.deepEqual(s.sites['transcript-append'], { count: 0, totalMs: 0, maxMs: 0, slow: 0, failures: 0, unhealed: 0, lastError: '' })
})

test('snapshot 不含时间戳字段（与 spec §3.1 约定一致：帧时序即时间）', () => {
  const telem = createDiskTelemetry()
  telem.note('loop-state', 5, true)
  const s = telem.snapshot()
  assert.deepEqual(Object.keys(s.sites).sort(), [...DISK_SITES].sort())
  for (const k of ['at', 'generatedAt', 'ts', 'timestamp', 'now']) {
    assert.ok(!(k in s), `不得含时间字段 ${k}`)
  }
})
