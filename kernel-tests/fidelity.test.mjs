// 上下文失真检测（2026-09-12 spec：docs/superpowers/specs/2026-09-12-context-fidelity-health-design.md）
// 被测量 = 失真（还准不准），而非压力（还能装多少）。三轴：memory / coherence / goal。
// 判定原则：强证据直通（不参与加权求和）+ 中证据累积（≥2 点 → amber，不弹窗）。
// 真值优先级：用户纠错 > 工具记录/文件系统/实体覆盖 > 模型自评（自评上限 amber）。
// 误报控制：无信号恒 green；用户显式改需求 = 合法转向；显式演进语不计矛盾。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractEntities, normalizeEntity, missingEntities, extractFacts, detectContradictions,
  extractConstraints, detectUserCorrection, detectRequirementChange, taskCoverage,
  buildAnchorText, fidelityConfigFromEnv, createFidelity,
} from '../kernel/fidelity.mjs'

const mkFid = (over = {}) => createFidelity({ getAnchorSource: () => ({}), ...over })

test('fidelityConfigFromEnv：默认值、env 覆盖、非法回落、总开关', () => {
  const d = fidelityConfigFromEnv({})
  assert.equal(d.enabled, true)
  assert.equal(d.windowTurns, 12)
  assert.equal(d.decay, 0.85)
  assert.equal(d.red, 70)
  assert.equal(d.amber, 40)
  assert.equal(d.observeTurns, 3)
  const o = fidelityConfigFromEnv({ PONOS_FIDELITY: '0', PONOS_FIDELITY_WINDOW: '6', PONOS_FIDELITY_RED: 'abc' })
  assert.equal(o.enabled, false)
  assert.equal(o.windowTurns, 6)
  assert.equal(o.red, 70, '非法值回落默认')
})

test('extractEntities：路径/数字/约束/反引号标识符/模型名都抽到', () => {
  const e = extractEntities('按 SPEC 必须把 src/a.ts 的行号上限设为 120，运行 `npm test` 验证 C:\\x\\y.md，模型用 deepseek-v4-flash')
  const joined = e.join(' | ')
  assert.ok(joined.includes('src/a.ts'), `路径要抽到：${joined}`)
  assert.ok(joined.includes('120'), '数字要抽到')
  assert.ok(e.some((x) => /npm test/i.test(x)), '反引号标识符要抽到')
  assert.ok(e.some((x) => normalizeEntity(x) === 'c:/x/y.md'), `Windows 路径要抽到（比对用归一化形式）：${joined}`)
  assert.ok(joined.includes('deepseek-v4-flash'), '模型名要抽到')
})

test('normalizeEntity：全角/大小写/路径分隔符/markdown 装饰归一', () => {
  assert.equal(normalizeEntity('**Src\\A.TS**'), 'src/a.ts')
  assert.equal(normalizeEntity('`npm test`'), 'npm test')
  assert.equal(normalizeEntity('１２３'), '123')
  assert.equal(normalizeEntity('  a  b  '), 'a b')
})

test('missingEntities：全部覆盖 ratio=0；成片丢失 ratio 命中且 missing 具名', () => {
  const e = extractEntities('必须保留 src/a.ts、src/b.ts 与阈值 120')
  assert.equal(missingEntities(e, '仍需保留 src/a.ts、src/b.ts，阈值 120 不变').ratio, 0)
  const lost = missingEntities(e, '继续之前的开发工作')
  assert.ok(lost.ratio >= 0.5, `关键实体成片丢失：${JSON.stringify(lost)}`)
  assert.ok(lost.missing.some((m) => m.includes('src/a.ts')), 'missing 要具名到实体')
  const few = missingEntities(['a', 'b'], 'a')
  assert.ok(few.total < 3, 'total<3 由调用方跳过判定（minEntities）')
})

test('extractFacts + detectContradictions：同值不算冲突；显式演进不计；无演进语的互斥取值算冲突', () => {
  const f1 = extractFacts('模型用 deepseek-v4-flash，上限设 0.8')
  const f2 = extractFacts('模型用 deepseek-v4-flash')
  assert.equal(detectContradictions([f1, f2]).length, 0, '同值不算冲突')
  const f3 = extractFacts('上限已改为 0.5')
  assert.equal(detectContradictions([f1, f3]).length, 0, '显式演进（已改为）不计矛盾')
  const f4 = extractFacts('上限设 0.5')
  assert.ok(detectContradictions([f1, f4]).length >= 1, '无演进语的互斥取值算冲突')
})

test('extractConstraints：抽约束句、去重、限长', () => {
  const c = extractConstraints('你必须先跑测试。必须二次确认。随便写点。')
  assert.equal(c.length, 2)
  assert.ok(c.every((x) => x.length <= 120))
})

test('detectUserCorrection / detectRequirementChange', () => {
  assert.equal(detectUserCorrection('我前面说过数据库是 MySQL').corrected, true)
  assert.equal(detectUserCorrection('继续').corrected, false)
  assert.equal(detectRequirementChange('先放一放，改做导出功能'), true)
  assert.equal(detectRequirementChange('继续实现'), false)
})

test('taskCoverage：延续任务高、无关任务低', () => {
  const anchor = extractEntities('实现 workflow 画布的删除交互')
  assert.ok(anchor.length >= 3, `锚点应抽出多个实体：${JSON.stringify(anchor)}`)
  assert.ok(taskCoverage(anchor, ['删除交互已完成，画布上新增确认框']) > 0.3, '延续任务覆盖率应高')
  assert.ok(taskCoverage(anchor, ['今天天气不错']) < 0.15, '无关任务覆盖率应低')
  assert.ok(taskCoverage(anchor, ['删除交互已完成，画布上新增确认框']) > taskCoverage(anchor, ['今天天气不错']))
})

test('假绿：无信号恒 green、不弹窗、零分', () => {
  const f = mkFid()
  f.recordTurn({ user: '实现 A', assistant: '好的，开始实现 A', toolDigest: [] })
  const s = f.snapshot()
  assert.equal(s.tier, 'green')
  assert.equal(s.trigger, null)
  assert.equal(s.score, 0)
  assert.equal(s.anchorAvailable, false)
  assert.deepEqual(s.issues, [])
})

test('假绿：连续 20 轮纯问答（无工具/无压缩/无纠错）恒 green', () => {
  const f = mkFid()
  for (let i = 0; i < 20; i++) f.recordTurn({ user: `问题 ${i}`, assistant: `回答 ${i}`, toolDigest: [] })
  const s = f.snapshot()
  assert.equal(s.tier, 'green')
  assert.equal(s.issues.length, 0)
})

test('强证据直通：摘要实体缺失率 ≥ 0.4 → red + trigger + 下发锚点', () => {
  const f = mkFid({ getAnchorSource: () => ({ task: '实现删除交互', memoryText: '## 文件变更\n- src/a.ts' }) })
  const issues = f.recordCompactionAudit({
    entities: ['src/a.ts', 'src/b.ts', 'src/c.ts', '阈值 120'],
    missing: ['src/a.ts', 'src/b.ts'],
    ratio: 0.5,
  })
  assert.equal(issues[0].strength, 'strong')
  assert.equal(issues[0].axis, 'memory')
  const s = f.snapshot()
  assert.equal(s.tier, 'red')
  assert.ok(s.trigger, 'red 必有 trigger（去抖键）')
  assert.equal(s.axes.memory > 0, true, '归因到 memory 轴')
  assert.equal(s.anchorAvailable, true)
  assert.ok(s.anchorText.includes('实现删除交互'), '红线随事件下发锚点文本')
})

test('中证据累积：单点不打扰（green）；两类中证据（陈旧引用 + 矛盾）→ amber 且不弹窗', () => {
  const f = mkFid()
  f.recordTurn({
    user: '引用 src/gone.ts 继续', assistant: '读取 src/gone.ts',
    toolDigest: [{ name: 'Read', path: 'src/gone.ts', isError: true, errorText: 'ENOENT: no such file' }],
  })
  let s = f.snapshot()
  assert.equal(s.tier, 'green', '单点中证据不打扰')
  assert.ok(s.score < 40, `单条 medium 分数须低于 amber 阈值（实得 ${s.score}）`)
  // 第二类中证据：同一项出现互斥取值（无演进语）
  f.recordTurn({ user: '上限设 0.5 就行', assistant: '好的，上限设 0.5', toolDigest: [] })
  f.recordTurn({ user: '再确认一下', assistant: '阈值上限 0.8 保持不变', toolDigest: [] })
  s = f.snapshot()
  assert.equal(s.tier, 'amber')
  assert.equal(s.trigger, null, 'amber 不弹窗')
  assert.ok(s.issues.length >= 2, `应累积两条以上证据：${JSON.stringify(s.issues)}`)
})

test('red 只由强证据触发：中证据再多也不越档（封顶 < 70）', () => {
  const f = mkFid()
  for (let i = 0; i < 6; i++) {
    f.recordTurn({
      user: `第 ${i} 次引用 src/gone.ts`, assistant: `读取 src/gone.ts 第 ${i} 次`,
      toolDigest: [], // 不发工具错误 → 陈旧引用只有一次（第 1 轮），其余靠矛盾累积
    })
  }
  f.recordTurn({ user: '引用 src/gone.ts', assistant: '读取 src/gone.ts', toolDigest: [{ name: 'Read', path: 'src/gone.ts', isError: true, errorText: 'ENOENT' }] })
  const s = f.snapshot()
  assert.notEqual(s.tier, 'red', '无强证据不得 red（宁漏勿误）')
  assert.ok(s.score <= 65, `中证据封顶 65：${s.score}`)
})

test('去抖：同 id 重复不叠加分数；markResolved 后立即回绿', () => {
  const f = mkFid()
  const d = [{ name: 'Read', path: 'src/x.ts', isError: true, errorText: 'ENOENT' }]
  f.recordTurn({ user: 'a', assistant: 'a', toolDigest: d })
  const first = f.snapshot()
  f.recordTurn({ user: 'a', assistant: 'a', toolDigest: d })
  assert.equal(f.snapshot().score, first.score, '同 id 重复不刷分')
  const ids = f.snapshot().issues.map((i) => i.id)
  assert.equal(f.markResolved(ids), ids.length)
  assert.equal(f.snapshot().tier, 'green', 'resolved 后立即回绿')
  assert.equal(f.evidenceLog().resolved.length, ids.length, '旧问题移入历史区可回看')
})

test('半衰期：窗口外老证据不再计分（自动回绿）', () => {
  const f = mkFid()
  const d = [{ name: 'Read', path: 'src/y.ts', isError: true, errorText: 'ENOENT' }]
  f.recordTurn({ user: 'u 引用 src/y.ts', assistant: 'a 读取 src/y.ts', toolDigest: d })
  f.recordTurn({ user: 'u 再引用 src/y.ts', assistant: 'a 再读 src/y.ts', toolDigest: d })
  assert.equal(f.snapshot().tier, 'red', '跨轮第 2 次 → 强证据（工具记录是真值）')
  for (let i = 0; i < 20; i++) f.recordTurn({ user: 'u', assistant: 'a', toolDigest: [] })
  assert.equal(f.snapshot().tier, 'green', '窗口外的老证据不再计分')
})

test('回绿与复发升级：重新锚定后立即回绿，同源复发 → 直通红档 + recurred 标记', () => {
  const f = mkFid()
  const d = [{ name: 'Read', path: 'src/z.ts', isError: true, errorText: 'ENOENT' }]
  f.recordTurn({ user: 'u 引用 src/z.ts', assistant: 'a 读 src/z.ts', toolDigest: d })
  f.recordTurn({ user: 'u 引用 src/z.ts', assistant: 'a 读 src/z.ts', toolDigest: d })
  const s1 = f.snapshot()
  assert.equal(s1.tier, 'red')
  assert.ok(s1.trigger, 'red 有 trigger 才能弹窗')
  const ids = s1.issues.map((i) => i.id)
  assert.equal(f.markResolved(ids), ids.length)
  assert.equal(f.snapshot().tier, 'green', '锚定生效 → 立即回绿（压力红档做不到这点）')
  assert.ok(f.snapshot().observeUntilTurn > 0, '记录修复时点（供前端提示"刚修复过"）')
  // 同源复发：观察期内应解除观察并复活证据（否则"锚定无效"会被静默吞掉）
  f.recordTurn({ user: 'u 又引用 src/z.ts', assistant: 'a 又读 src/z.ts', toolDigest: d })
  const s2 = f.snapshot()
  assert.equal(s2.tier, 'red')
  assert.ok(s2.trigger, '复发必须重新弹窗（动作升级为新建会话）')
  assert.ok(s2.issues.some((i) => i.recurred), '复发证据带 recurred 标记')
})

test('反复复发：每次复发都递增次数（否则第二次起永远不再提醒）', () => {
  // 前端用「抑制键」避免同一证据反复弹卡。若复发标记只是布尔且永不清除，抑制键就恒为
  // <id>#recurred —— 第一次复发登记后，第二次复发用的还是同一个键 → 静默，用户以为已解决。
  // 内核须给出次数，前端才能"每次复发各提醒一次"。
  const f = mkFid()
  const d = [{ name: 'Read', path: 'src/z.ts', isError: true, errorText: 'ENOENT' }]
  const hit = () => f.recordTurn({ user: 'u 引用 src/z.ts', assistant: 'a 读 src/z.ts', toolDigest: d })
  hit(); hit()
  const s1 = f.snapshot()
  assert.equal(s1.tier, 'red')
  assert.ok(s1.issues.every((i) => !i.recurredCount), '首次出现不算复发（次数缺省/0）')

  f.markResolved(s1.issues.map((i) => i.id))
  hit() // 第一次复发
  const s2 = f.snapshot()
  const r2 = s2.issues.find((i) => i.recurred)
  assert.ok(r2, '第一次复发带 recurred 标记')
  assert.equal(r2.recurredCount, 1, '首次复发计 1 次')
  assert.equal(s2.tier, 'red', '复发直通红档')

  f.markResolved(s2.issues.map((i) => i.id))
  hit() // 第二次复发
  const s3 = f.snapshot()
  const r3 = s3.issues.find((i) => i.id === r2.id)
  assert.ok(r3, '复发证据仍在')
  assert.equal(r3.recurredCount, 2, '第二次复发次数递增（前端据此用新抑制键再提醒一次）')
  assert.equal(s3.tier, 'red')

  f.markResolved(s3.issues.map((i) => i.id))
  hit() // 第三次复发
  assert.equal(f.snapshot().issues.find((i) => i.id === r2.id).recurredCount, 3, '次数持续递增')
})

test('中证据累积：两个**不同轴**各 1 点也达「≥2 点中证据」→ amber（spec §1）', () => {
  // spec §1：「amber 40 ≤ D < 70 **或存在 ≥2 点中证据**」——按点数而非仅按分数，
  // 且不要求同轴（每轴独立归一的是 score，不是点数）。此测试固化该语义。
  const f = mkFid()
  f.recordTurn({ user: '开始做 A', assistant: '好的', toolDigest: [] })
  // memory 轴 1 点：摘要缺失率 1/3 落在 medium 档（≥0.2 且 <0.4）
  f.recordCompactionAudit({ entities: ['src/a.ts', 'src/b.ts', 'src/c.ts'], missing: ['src/c.ts'], ratio: 0.33 })
  // coherence 轴 1 点：单轮内引用工具已报不存在的路径（两次才算强证据）
  f.recordTurn({ user: 'u 引用 src/z.ts', assistant: 'a 读 src/z.ts', toolDigest: [{ name: 'Read', path: 'src/z.ts', isError: true, errorText: 'ENOENT' }] })
  const s = f.snapshot()
  assert.ok(!s.issues.some((i) => i.strength === 'strong'), '本例不得含强证据（否则 red 另有来源）')
  assert.ok(s.issues.length >= 2, `应至少两条中证据，实得 ${s.issues.length}`)
  assert.ok(new Set(s.issues.map((i) => i.axis)).size >= 2, '确实跨两个轴')
  assert.equal(s.tier, 'amber', '跨轴合计 ≥2 点中证据 → amber')
  assert.equal(s.trigger, null, 'amber 不弹窗')
})

test('假红回归：压缩刚落地（159×场景）不得弹失真红档', () => {
  const f = mkFid()
  f.recordTurn({ user: '实现 A', assistant: '开始实现 A', toolDigest: [] })
  f.recordCompactionAudit({ entities: ['src/a.ts', 'src/b.ts', 'src/c.ts'], missing: [], ratio: 0 })
  f.recordTurn({ user: '继续', assistant: '好的', toolDigest: [] })
  const s = f.snapshot()
  assert.equal(s.tier, 'green', '压缩本身不是失真')
  assert.equal(s.trigger, null)
})

test('用户纠错 + 命中已压缩区间 → S1 强证据直通', () => {
  const f = mkFid()
  f.recordCompactionAudit({ entities: ['src/conf.ts', '阈值 120', '必须二次确认'], missing: [], ratio: 0 })
  for (let i = 0; i < 3; i++) f.recordTurn({ user: '继续', assistant: '好的', toolDigest: [] })
  f.recordTurn({ user: '我前面说过 src/conf.ts 的阈值是 120', assistant: '抱歉', toolDigest: [] })
  const s = f.snapshot()
  assert.equal(s.tier, 'red')
  assert.ok(s.issues.some((i) => i.kind === 'user-correction' && i.strength === 'strong'))
})

test('合法转向：用户显式改需求 → 重置目标轴，不报目标漂移', () => {
  const f = mkFid()
  for (let i = 0; i < 8; i++) f.recordTurn({ user: '实现导出功能', assistant: '正在实现导出功能', toolDigest: [] })
  f.recordTurn({ user: '先放一放，改做权限校验脚本', assistant: '好的，开始做权限校验', toolDigest: [] })
  for (let i = 0; i < 8; i++) f.recordTurn({ user: '权限校验脚本继续', assistant: '权限校验脚本继续', toolDigest: [] })
  const s = f.snapshot()
  assert.equal(s.axes.goal, 0, '用户改需求后目标轴归零（合法转向不是失真）')
  assert.equal(s.tier, 'green')
})

test('buildAnchorText：含任务/缺失实体/约束，且 ≤ 4KB', () => {
  const t = buildAnchorText({
    task: '实现删除交互', memoryText: '## 文件变更\n- src/a.tsx',
    missing: ['src/a.ts', '阈值 120'], constraints: ['必须二次确认'],
  })
  assert.match(t, /实现删除交互/)
  assert.match(t, /src\/a\.ts/)
  assert.match(t, /阈值 120/)
  assert.match(t, /必须二次确认/)
  assert.ok(Buffer.byteLength(t, 'utf-8') <= 4096)
  const big = buildAnchorText({ task: 'x'.repeat(50_000), memoryText: 'y'.repeat(50_000), missing: [], constraints: [] })
  assert.ok(Buffer.byteLength(big, 'utf-8') <= 4096, '超长必须截断')
})

test('静默降级：undefined/null/超长输入不抛；总开关关时恒 green', () => {
  const f = mkFid()
  assert.doesNotThrow(() => { f.recordTurn({}); f.recordTurn({ user: null, assistant: undefined, toolDigest: null }) })
  assert.deepEqual(f.recordTurn({ user: 'x'.repeat(500_000), assistant: 'y', toolDigest: [] }), [])
  assert.doesNotThrow(() => f.recordCompactionAudit())
  assert.doesNotThrow(() => f.markResolved(null))
  const off = createFidelity({ config: fidelityConfigFromEnv({ PONOS_FIDELITY: '0' }), getAnchorSource: () => ({}) })
  off.recordCompactionAudit({ entities: ['a.md', 'b.md', 'c.md', 'd.md'], missing: ['a.md', 'b.md'], ratio: 0.5 })
  assert.equal(off.snapshot().tier, 'green', '总开关关：不做失真判定')
})

// 注：上方「假红回归：压缩刚落地（159×场景）」锁"压缩本身不是失真"；
// 下面这条补锁**前端可见契约**——非红档不得携带去抖键、不预生成锚点文本
//（否则前端会误弹卡、或"重新锚定"按钮带着空/过期锚点可点）。
test('假红回归：压缩落地 + 该轮一切正常 → 非红档且不带去抖键/不预生成锚点', () => {
  const f = mkFid()
  // 压缩落地：摘要完整覆盖关键实体（missing 为空 → 无 memory 证据）
  f.recordCompactionAudit({ entities: [], missing: [], total: 4, ratio: 0 })
  // 紧接着正常一轮：工具全成功、助手未引用任何失踪路径、目标覆盖充足
  f.recordTurn({
    user: '继续按计划实现 src/a.ts，把阈值改成 120',
    assistant: '已按计划改完 src/a.ts 的阈值 120，接下来补测试。',
    toolDigest: [{ name: 'Read', path: 'src/a.ts', isError: false }, { name: 'Edit', path: 'src/a.ts', isError: false }],
  })
  const s = f.snapshot()
  assert.notEqual(s.tier, 'red', `刚压缩完的正常轮不得判红（score=${s.score} issues=${JSON.stringify(s.issues)}）`)
  assert.equal(s.trigger, null, '非红档不得携带去抖键（前端据此不弹卡）')
  assert.equal(s.anchorAvailable, false, '非红档不应生成锚点文本')
})

test('假绿回归：连续 20 轮纯问答（无工具/无压缩/无纠错）恒 green 且零证据', () => {
  const f = mkFid()
  for (let i = 0; i < 20; i++) {
    f.recordTurn({
      user: `第 ${i + 1} 个问题：Node 的事件循环分几个阶段？`,
      assistant: '六个阶段：timers、pending callbacks、idle/prepare、poll、check、close callbacks。',
      toolDigest: [],
    })
    const s = f.snapshot()
    assert.equal(s.tier, 'green', `第 ${i + 1} 轮不应有失真信号：${JSON.stringify(s.issues)}`)
    assert.equal(s.issues.length, 0)
    assert.equal(s.score, 0)
  }
})

test('性能红线：单轮 20 万字符输入的处理耗时 < 200ms（轮尾同步调用，不能拖慢对话）', () => {
  const f = mkFid()
  const big = ('必须保留 src/a.ts 与阈值 120，模型用 deepseek-v4-flash。' + 'x'.repeat(80)).repeat(2000)
  const t0 = Date.now()
  f.recordTurn({ user: big, assistant: big, toolDigest: [{ name: 'Read', path: 'src/gone.ts', isError: true, errorText: 'ENOENT' }] })
  f.snapshot()
  const ms = Date.now() - t0
  assert.ok(ms < 200, `单轮处理耗时 ${ms}ms，超出 200ms 红线`)
})
