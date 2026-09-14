import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 源码级断言（同 server/diag-info.test.mjs 的策略）：main.cjs 依赖 Electron 运行时，
// 单测里跑不起来；而下面两条规则一旦违反，只在**启动失败路径**上炸——平时全绿。
const src = readFileSync(new URL('./main.cjs', import.meta.url), 'utf-8')
const lines = src.split('\n')

// 每行所属的「顶层构造」= 向上找到的第一行 0 缩进代码的行号。
// main.cjs 的排版约定：0 缩进 = 模块顶层的函数/const 声明或语句；其内容一律带缩进。
// 因此两个行号相同 ⇔ 处于同一个顶层构造内部（含其嵌套块，即同一作用域链）。
function anchorOf(i) {
  for (let k = i; k >= 0; k--) {
    if (lines[k].length && !/^\s/.test(lines[k])) return k
  }
  return -1
}

// 2026-09-14 实况：`async function showBootFailureDialog()` 声明在 `} else {`
// （单实例锁）块内，却被顶层函数 startBridgeAndWait() 调用 ⇒ ReferenceError。
// 根因：Annex B 的块级函数提升**只覆盖 FunctionDeclaration，不覆盖
// AsyncFunctionDeclaration**（实测：块内 `function f(){}` 可被外部调用，
// 块内 `async function g(){}` 抛 "g is not defined"）。
// 故规则：块内声明的 async 函数名，不得被**另一个顶层构造**里的代码引用。
// （同一顶层构造内的引用一律放过：同在 else 块里的调用点是合法的。
//   局限：同一顶层构造内、互为兄弟的嵌套块之间的引用不在此规则覆盖范围内。）
test('块内声明的 async 函数不得被其他顶层构造引用（Annex B 不提升 async 函数）', () => {
  const declRe = /^ {2,}async function\*? (\w+)/
  const nested = new Map() // name -> 声明行号
  lines.forEach((l, i) => {
    const m = declRe.exec(l)
    if (m) nested.set(m[1], i)
  })
  // 顶层同名声明（0 缩进）存在时，该名字是模块级可见的，与本规则无关
  for (const name of [...nested.keys()]) {
    const topLevel = new RegExp(`^(async )?function\\*? ${name}\\b`)
    if (lines.some((l) => topLevel.test(l))) nested.delete(name)
  }

  const broken = []
  for (const [name, declIdx] of nested) {
    const declAnchor = anchorOf(declIdx)
    const call = new RegExp(`\\b${name}\\s*\\(`)
    lines.forEach((l, i) => {
      if (i === declIdx) return
      if (l.trimStart().startsWith('//') || l.trimStart().startsWith('*')) return
      if (!call.test(l)) return
      if (anchorOf(i) !== declAnchor) broken.push(`${name} (行 ${i + 1})`)
    })
  }
  assert.deepEqual(
    broken,
    [],
    `以下块内 async 函数被其他顶层构造引用（运行时会 ReferenceError）：${broken.join('、')}。` +
      '把它提到顶层，或把调用点收进同一个块。',
  )
})

// 反向锁：兜底对话框必须保持顶层可调用，且启动失败路径确实调用了它。
// 少了这个调用，启动失败就没有「打开日志目录 / 复制路径」的出口；
// 该调用一旦抛 ReferenceError，紧随其后的 app.quit() 便不执行 ⇒ 进程不退（当日实况）。
// 2026-09-14 实况（半死实例）：app.quit() 被 keepAlive 登录窗的 close→preventDefault
// 否决而**中止**，但 isQuitting 已置真且全仓没有复位点 ⇒ 桥被 killBridge 杀掉、自愈被
// scheduleBridgeRestart 的 `|| isQuitting` 挡死、will-quit 的清理又要等窗口关完才触发：
// 进程活着、窗口在、桥永远起不来（渲染层无限 1006 重连）。下面把两条防线各锁一次。
test('退出路径：窗口否决不了退出，且退出闩可复位（防半死实例）', () => {
  const block = (start, n) => lines.slice(start, start + n).join('\n')

  // ① before-quit 必须解除窗口否决（destroyAllWindows 前移）+ 武装兜底
  const bq = lines.findIndex((l) => /^app\.on\('before-quit'/.test(l))
  assert.ok(bq > 0, 'before-quit 处理器应存在')
  const bqBody = block(bq, 14)
  assert.match(bqBody, /browserExecutor\.destroyAllWindows/,
    'before-quit 必须销毁执行器窗口：keepAlive 登录窗 preventDefault 会让 app.quit() 被中止')
  assert.match(bqBody, /armQuitWatchdog\(\)/, 'before-quit 必须武装退出兜底')

  // ② 兜底：到点必须补做 will-quit 的收尾（被中止的退出等不到它）再硬退出
  const wd = lines.findIndex((l) => /^function armQuitWatchdog\(\)/.test(l))
  assert.ok(wd > 0, 'armQuitWatchdog 应存在')
  const wdBody = block(wd, 16)
  assert.match(wdBody, /writeBootSummary\(\)/, '兜底退出前要落 boot 汇总（will-quit 不会触发）')
  assert.match(wdBody, /app\.exit\(0\)/, '兜底必须硬退出，不能停在半死态')

  // ③ 复位路径：showMainWindow（second-instance / 托盘「打开主窗口」/ activate 共用）
  //    必须先撤销「已中止的退出」，否则用户再点图标只会得到窗口 + 永远起不来的桥
  const sm = lines.findIndex((l) => /^function showMainWindow\(\)/.test(l))
  assert.ok(sm > 0, 'showMainWindow 应存在')
  assert.match(block(sm, 4), /reviveIfQuitAborted\(\)/, 'showMainWindow 必须复位「已中止的退出」')

  // ④ 复位体必须清闩、清退避、重拉桥，并取消兜底（否则用户"又要窗口"后仍被兜底杀掉）
  const rv = lines.findIndex((l) => /^function reviveIfQuitAborted\(\)/.test(l))
  assert.ok(rv > 0, 'reviveIfQuitAborted 应存在')
  const rvBody = block(rv, 12)
  assert.match(rvBody, /isQuitting = false/, '复位必须清掉退出闩')
  assert.match(rvBody, /scheduleBridgeRestart\(\)/, '复位后必须重拉桥')
  assert.match(rvBody, /clearTimeout\(quitWatchdog\)/, '复位必须取消兜底计时器（复活与兜底会打架）')
})

test('showBootFailureDialog 位于顶层且被启动失败路径调用', () => {
  assert.match(src, /^async function showBootFailureDialog\s*\(/m)
  const callIdx = lines.findIndex((l) => /await showBootFailureDialog\(\)/.test(l))
  assert.ok(callIdx > 0, 'startBridgeAndWait 失败路径应 await showBootFailureDialog()')
  const quitIdx = lines.findIndex((l, i) => i > callIdx && /app\.quit\(\)/.test(l))
  assert.ok(quitIdx > callIdx, 'showBootFailureDialog() 之后应有 app.quit()（先弹窗、再退出）')
})
