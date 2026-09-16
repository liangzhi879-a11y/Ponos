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
} from '../kernel/guards.mjs'

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
