// P1-6 共享守卫判据单测（2026-09-16）
// ---------------------------------------------------------------------------
// 背景：`engine.mjs` 的主循环与子 lane 此前**各有一份守卫实现**（内注释自认
// 「子 lane 镜像主循环」），是"同一逻辑两处维护"。审计 #4 记录了真实后果：子 lane
// 曾**没有**错误熔断，连续全败一路空转到迭代上限。本轮把判据/文案收敛到
// `kernel/guards.mjs`，本文件负责钉住：
//   ① 判据边界（含"提取前后等价"，防重构时行为悄悄变了）；
//   ② 注入文案**逐字不变**（文案是模型行为的一部分，改了等于改了提示词）；
//   ③ **防再重复**：engine.mjs 源码里不得再出现内联守卫——否则债务会悄悄长回来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isRealProgress, allToolResultsFailed, nextHadToolError,
  shouldRemindRepeat, repeatRemindText, errorMeltdownText, hasMeltdownBudget,
  batchToolKey, isClosedOut, planTailText,
} from '../kernel/guards.mjs'
import { canonicalToolCallKey, isPlanTail } from '../kernel/gen-guards.mjs'

const ENGINE = fileURLToPath(new URL('../kernel/engine.mjs', import.meta.url))
const engineSrc = readFileSync(ENGINE, 'utf-8')

const ok = () => ({ is_error: false })
const bad = () => ({ is_error: true })
const tool = (name, input = {}) => ({ name, input })
const browser = (action) => tool('Browser', { action })

// ---------------------------------------------------------------------------
// 守卫⑥ 进展口径
// ---------------------------------------------------------------------------
test('isRealProgress：成功且非只读测量才算进展', () => {
  assert.equal(isRealProgress([tool('Write')], [ok()]), true, '写文件＝实质进展')
  assert.equal(isRealProgress([tool('Read')], [ok()]), true, '读文件也算进展（改变了认知基础）')
  assert.equal(isRealProgress([tool('Browser', { action: 'goto' })], [ok()]), true, 'goto 会改页面状态＝进展')
  // Browser 的 js/snapshot 是只读测量 → 不算进展，于是"测量打转"会被停滞守卫拦下
  assert.equal(isRealProgress([browser('js')], [ok()]), false, 'Browser js＝只读测量，不算进展')
  assert.equal(isRealProgress([browser('snapshot')], [ok()]), false, 'Browser snapshot＝只读测量，不算进展')
  assert.equal(isRealProgress([tool('Write')], [bad()]), false, '失败结果不算进展')
  assert.equal(isRealProgress([], []), false, '空轮次不算进展')
  // 混合：只要有任一成功非只读即算进展
  assert.equal(isRealProgress([browser('js'), tool('Edit')], [ok(), ok()]), true)
  assert.equal(isRealProgress([browser('js'), tool('Edit')], [ok(), bad()]), false, 'Edit 失败则整轮无实质进展')
})

// ---------------------------------------------------------------------------
// 守卫④ 全失败判定与预算
// ---------------------------------------------------------------------------
test('allToolResultsFailed：空结果不算"全部失败"', () => {
  assert.equal(allToolResultsFailed([bad(), bad()]), true)
  assert.equal(allToolResultsFailed([bad(), ok()]), false)
  assert.equal(allToolResultsFailed([ok()]), false)
  assert.equal(allToolResultsFailed([]), false, '无结果≠全部失败（否则纯文本轮次也会累积熔断）')
})

test('hasMeltdownBudget：max<0 为不限次；heals 达 max 即用尽', () => {
  assert.equal(hasMeltdownBudget(0, 2), true)
  assert.equal(hasMeltdownBudget(1, 2), true)
  assert.equal(hasMeltdownBudget(2, 2), false, '用尽即不再愈合')
  assert.equal(hasMeltdownBudget(99, -1), true, '负数＝不限次')
  assert.equal(hasMeltdownBudget(0, -1), true)
})

// ---------------------------------------------------------------------------
// R3-2 三态错误标记（提取前后必须等价）
// ---------------------------------------------------------------------------
test('nextHadToolError：三态（有失败→true；有结果全成功→false；无结果→保持）', () => {
  assert.equal(nextHadToolError(false, [bad()]), true, '本轮有失败 → 标记')
  assert.equal(nextHadToolError(true, [bad()]), true)
  assert.equal(nextHadToolError(true, [ok()]), false, '错误已恢复 → 清除标记')
  assert.equal(nextHadToolError(false, [ok()]), false)
  assert.equal(nextHadToolError(true, []), true, '无结果不改变判断（保持 true）')
  assert.equal(nextHadToolError(false, []), false, '无结果不改变判断（保持 false）')
  // 混合（有成功也有失败）→ 仍视为有错误，守卫下一轮照常强制重试
  assert.equal(nextHadToolError(false, [ok(), bad()]), true)
})

// ---------------------------------------------------------------------------
// 守卫⑤ 阈值命中与文案
// ---------------------------------------------------------------------------
test('shouldRemindRepeat：到阈值且未提醒过才提醒（防同档重复注入）', () => {
  const T = [3, 5, 8]
  assert.equal(shouldRemindRepeat(3, T, new Set()), true)
  assert.equal(shouldRemindRepeat(3, T, new Set([3])), false, '同档已提醒过 → 不重复注入')
  assert.equal(shouldRemindRepeat(4, T, new Set()), false, '不在阈值上不提醒')
  assert.equal(shouldRemindRepeat(0, T, new Set()), false)
  assert.equal(shouldRemindRepeat(3, [], new Set()), false)
  assert.equal(shouldRemindRepeat(3, undefined, new Set()), false, '阈值非数组时安全返回 false')
})

test('repeatRemindText：文案逐字稳定（改文案＝改提示词，必须显式）', () => {
  const t = repeatRemindText(3, 'Read')
  assert.match(t, /你已连续 3 次调用同一工具（Read）且未见方向变化/)
  assert.match(t, /请换一种方法/, '必须给出"换个方法"的指引')
  assert.match(t, /不要重复无进展的调用/)
  // 参数化正确
  assert.match(repeatRemindText(8, 'Bash'), /连续 8 次调用同一工具（Bash）/)
})

test('errorMeltdownText：两个变体各自完整，且差异是刻意保留的', () => {
  const main = errorMeltdownText('main')
  const lane = errorMeltdownText('lane')
  for (const [name, t] of [['main', main], ['lane', lane]]) {
    assert.match(t, /检测到连续多轮工具调用全部失败/, `${name} 变体应含熔断主句`)
    assert.match(t, /停止原样重试/, `${name} 变体应含"停止原样重试"`)
  }
  // 主循环面向交互用户：给具体排查手段（含上一轮 stderr）+ 向用户说明
  assert.match(main, /stderr/, 'main 变体应提示查看上一轮 tool_result 的 stderr')
  assert.match(main, /向用户说明阻塞原因/, 'main 变体以"向用户说明"收尾（有交互对象）')
  // 子 lane 无交互对象：文案更简、以"输出阻塞说明"收尾，不出现 stderr 指引
  assert.match(lane, /输出阻塞说明/, 'lane 变体以"输出阻塞说明"收尾（后台任务无交互对象）')
  assert.ok(!lane.includes('stderr'), 'lane 变体不应含 stderr 指引（无交互对象，读者是模型自己）')
  // 默认（未传/未知变体）应落到 main，避免漏传时静默产出半截文案
  assert.equal(errorMeltdownText(), main)
  assert.equal(errorMeltdownText('nonsense'), main)
})

// ---------------------------------------------------------------------------
// ★ 防再重复：engine.mjs 内不得再出现内联守卫实现
// ---------------------------------------------------------------------------
test('防再重复：engine.mjs 源码内不得出现内联守卫（否则"两处维护"会悄悄长回来）', () => {
  // 1) 内联注入文案：这两条串若再出现，说明有人又复制了一份模板
  assert.ok(
    !engineSrc.includes('【提示】你已连续 '),
    'engine.mjs 不应再内联【提示】模板——应调用 repeatRemindText()',
  )
  assert.ok(
    !engineSrc.includes('【系统】检测到连续多轮工具调用全部失败。'),
    'engine.mjs 不应再内联熔断文案——应调用 errorMeltdownText()',
  )
  // 2) 内联判据：Browser 只读测量口径与全失败口径都只应在 guards.mjs 里出现一次
  assert.ok(
    !/a === 'js' \|\| a === 'snapshot'/.test(engineSrc),
    "engine.mjs 不应再内联 Browser 只读测量判据——应调用 isRealProgress()",
  )
  assert.ok(
    !/toolResults\.every\(\(r\) => r\.is_error\)/.test(engineSrc),
    'engine.mjs 不应再内联"全部失败"判据——应调用 allToolResultsFailed()',
  )
  assert.ok(
    !/MELTDOWN_HEAL_MAX < 0 \|\|/.test(engineSrc),
    'engine.mjs 不应再内联愈合预算判据——应调用 hasMeltdownBudget()',
  )
  // 3) 正向前提：engine.mjs 确实（且只能）从 guards.mjs 取这些判据
  assert.match(engineSrc, /from '\.\/guards\.mjs'/, 'engine.mjs 必须从 guards.mjs 导入')
  for (const fn of ['isRealProgress', 'allToolResultsFailed', 'nextHadToolError', 'shouldRemindRepeat', 'repeatRemindText', 'errorMeltdownText', 'hasMeltdownBudget']) {
    assert.ok(engineSrc.includes(fn), `engine.mjs 应使用 ${fn}（否则该判据仍在别处重复实现）`)
  }
})

test('防再重复（双向）：guards.mjs 不得反向依赖 engine.mjs（防循环依赖）', () => {
  const src = readFileSync(fileURLToPath(new URL('../kernel/guards.mjs', import.meta.url)), 'utf-8')
  // 只看**真实导入语句**：注释里提到 "engine.mjs"（说明提取背景）是允许的，
  // 若用 includes() 会误报——判据必须落在代码依赖上，而非文本出现。
  const imports = [...src.matchAll(/^\s*import\b.*$/gm)].map((m) => m[0])
  const requires = [...src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const dynImports = [...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  assert.deepEqual(
    imports, [],
    `guards.mjs 应为无依赖纯函数模块（不得 import），实得：${JSON.stringify(imports)}`,
  )
  assert.deepEqual(requires, [], `guards.mjs 不得 require，实得：${JSON.stringify(requires)}`)
  assert.deepEqual(dynImports, [], `guards.mjs 不得动态 import，实得：${JSON.stringify(dynImports)}`)
})

// ---------------------------------------------------------------------------
// 守卫⑤ 链键口径（2026-09-16 收紧）：整批工具调用 vs 每轮首个
// ---------------------------------------------------------------------------
test('batchToolKey：整批键——"开头相同 + 后续不同"不得判为同一次', () => {
  const k = (name, input) => `${name}\u0000${JSON.stringify(input)}`
  // 同一批（键序无关）→ 同键
  const a = [{ name: 'Read' }, { name: 'Grep' }]
  const b = [{ name: 'Grep' }, { name: 'Read' }]
  assert.equal(batchToolKey(a, (x) => x.name), batchToolKey(b, (x) => x.name), '整批键与调用顺序无关')
  // 开头相同、后续不同 → **不同键**（旧口径只取 blocks[0] 会把这两批判成同一次而误报）
  const first = [{ name: 'Bash' }, { name: 'Edit' }]
  const second = [{ name: 'Bash' }, { name: 'Grep' }]
  assert.notEqual(batchToolKey(first, (x) => x.name), batchToolKey(second, (x) => x.name))
  // 单调用与批量也不会撞键（分隔符保证前缀不互相包含）
  assert.notEqual(batchToolKey([{ name: 'Bash' }], (x) => x.name), batchToolKey(first, (x) => x.name))
  // 真死循环（整批一模一样）仍判同一次
  assert.equal(batchToolKey(first, (x) => x.name), batchToolKey([...first], (x) => x.name))
  // 边界：空批 / 无 keyOf → 空串（调用方按"键空则不推进链"处理）
  assert.equal(batchToolKey([], (x) => x.name), '')
  assert.equal(batchToolKey(first, null), '')
  assert.equal(batchToolKey(null, (x) => x.name), '')
  // 与真实 canonicalToolCallKey 组合（engine 的实际用法）
  assert.equal(
    batchToolKey([tool('Bash', { command: 'ls' })], canonicalToolCallKey),
    canonicalToolCallKey(tool('Bash', { command: 'ls' })),
    '单块时整批键应退化为该块的规范键',
  )
})

// ---------------------------------------------------------------------------
// R3-2 失败自愈出口（2026-09-16）：文本已明确收尾则不再注入
// ---------------------------------------------------------------------------
test('isClosedOut：认"完成声明/交付结果/请示用户"，不认"认错即停"', () => {
  const closed = (t) => isClosedOut(t, isPlanTail)
  // ① 完成声明与交付结果 → 已收尾（守卫必须让位，否则"提示→照做→再提示"循环）
  assert.equal(closed('本次检查已完成，未发现内核守卫异常。'), true)
  assert.equal(closed('报告已生成，保存在 docs/ 目录下。'), true)
  assert.equal(closed('以下是整理结果：\n- 守卫 A\n- 守卫 B'), true, '交付清单：收尾语在首行，清单不是承诺')
  assert.equal(closed('汇总如下：共 9 项'), true)
  assert.equal(closed('以上是全部证据。'), true)
  // ② 请示用户（把决定权交回用户也是合法收尾）
  assert.equal(closed('需要你确认是否按方案 A 执行。'), true)
  assert.equal(closed('请你确认后我再继续。'), true)
  // ③ ★ 刻意不收"卡住/无法继续"类措辞——那正是 R3-2 要抓的"认错即停"
  assert.equal(closed('抱歉，我无法继续。'), false, '"无法继续"是认错即停，必须仍被拉回重试')
  assert.equal(closed('工具报错了，我先停一下等你说。'), false)
  assert.equal(closed('这里卡住了。'), false)
  // ④ 计划尾巴不在收尾语里（与计划尾守卫职责分离）
  assert.equal(closed('我先看一下结构，接下来开始处理。'), false)
  // ⑤ 收尾语之后**又出现计划尾巴** → 不算收尾（判据不是"尾巴里有没有收尾语"）
  assert.equal(closed('前一步已完成。接下来我准备继续读下一个文件并验证。'), false)
  // ⑥ 关掉计划判据注入时退化为"只认收尾语"（文档化该退化，防有人误以为恒定）
  assert.equal(isClosedOut('前一步已完成。接下来我准备继续读下一个文件并验证。'), true)
  assert.equal(isClosedOut(''), false)
  assert.equal(isClosedOut(null), false)
})

test('反挂账：engine.mjs 两侧 R3-2 必须都经 isClosedOut 门控（防只改主循环）', () => {
  const hits = [...engineSrc.matchAll(/isClosedOut\(/g)].length
  assert.ok(hits >= 2, `主循环与子 lane 都应经 isClosedOut 门控，实测 ${hits} 处`)
  assert.match(engineSrc, /from '\.\/guards\.mjs'/)
})

test('反挂账：守卫⑤链键不得回退到"每轮首个工具调用"（engine 主循环+lane 与 loop-core）', () => {
  // 【Task 4 后改写】主循环的重复提醒守卫已搬入 kernel/loop-core.mjs（契约化），
  // 故"两处都用 batchToolKey"的判据要跨两个文件数：loop-core（主循环）+ engine（子 lane）。
  // 判据**反而更强**：它同时证明了搬移后的守卫体确实在用规范链键，而不只是"搬家了"。
  const coreSrc = readFileSync(new URL('../kernel/loop-core.mjs', import.meta.url), 'utf8')
  assert.ok(
    !/canonicalToolCallKey\(blocks\[0\]\)/.test(engineSrc + coreSrc),
    '守卫⑤ 链键应走 batchToolKey(blocks, canonicalToolCallKey)，不得回退到 blocks[0]',
  )
  const uses = [...(engineSrc + coreSrc).matchAll(/batchToolKey\(blocks, canonicalToolCallKey\)/g)].length
  assert.ok(uses >= 2, `主循环(loop-core)与子 lane(engine)都应使用 batchToolKey，实测 ${uses} 处`)
  assert.ok(/batchToolKey\(blocks, canonicalToolCallKey\)/.test(coreSrc),
    'loop-core 的 repeatReminder 必须使用规范链键（否则搬移即退化）')
})

test('反挂账：子 lane 的重复自愈须与主循环同为 "-1 = 不限次" 语义', () => {
  // 旧缺陷：子 lane 写 `REPEAT_HEAL_MAX > 0`，默认值 -1 时该 lane 完全没有自愈
  assert.ok(
    !/REPEAT_HEAL_MAX > 0 && subHeals < REPEAT_HEAL_MAX/.test(engineSrc),
    '子 lane 不得用 REPEAT_HEAL_MAX > 0（-1=不限次语义会失效）',
  )
  assert.match(engineSrc, /REPEAT_HEAL_MAX !== 0 && \(REPEAT_HEAL_MAX < 0 \|\| subHeals < REPEAT_HEAL_MAX\)/)
})

test('反挂账：计划尾守卫两侧对称（主循环 + 子 lane），且文案单一来源', () => {
  // ① 两侧都要有 isPlanTail 门控（修复前子 lane 无此分支：子任务以"接下来我要…"收尾
  //    会被当作完成结果回传主线程）
  const gates = [...engineSrc.matchAll(/isPlanTail\(textBuf\)/g)].length
  assert.ok(gates >= 2, `计划尾门控应覆盖主循环与子 lane，实测 ${gates} 处`)
  // ② 注入文案不得内联回 engine.mjs（否则两侧各一份文案，改一处即分叉）
  assert.ok(
    !/const inject = '【系统】你在上一轮承诺了后续动作/.test(engineSrc),
    '计划尾文案应走 guards.planTailText()（单一来源），不得内联',
  )
  const uses = [...engineSrc.matchAll(/planTailText\(\)/g)].length
  assert.ok(uses >= 2, `两侧都应调用 planTailText()，实测 ${uses} 处`)
})

test('防再重复（跨文件契约）：planTailText 首句必须与 api.mjs mock 恢复锚点一致', () => {
  // api.mjs 的 R3-2 恢复分支按【系统】你在上一轮承诺了后续动作 匹配历史——改文案不改
  // mock 会让所有计划尾 e2e 退化为"注入后无恢复"（测试仍绿但已失去意义），故在此钉死。
  const anchor = '【系统】你在上一轮承诺了后续动作'
  assert.ok(planTailText().startsWith(anchor), `planTailText 首句须为 mock 锚点，实际：${planTailText().slice(0, 60)}`)
  const apiSrc = readFileSync(fileURLToPath(new URL('../kernel/api.mjs', import.meta.url)), 'utf-8')
  assert.ok(apiSrc.includes(anchor), 'api.mjs 恢复分支应含同一锚点串')
  // 端到端测试也依赖该锚点在人读断言里可见（防有人把它改成变量后断言空转）
  const e2e = readFileSync(fileURLToPath(new URL('./plan-tail-e2e.test.mjs', import.meta.url)), 'utf-8')
  assert.ok(e2e.includes('你在上一轮承诺了后续动作'), 'plan-tail-e2e 应含同一锚点串')
})
