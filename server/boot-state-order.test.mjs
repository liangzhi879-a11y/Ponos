// 模块级状态声明顺序门禁（2026-09-18）
// ---------------------------------------------------------------------------
// 守护什么：`server/bridge.mjs` 里 **模块级 `const` 的声明必须早于它的任何使用**。
//
// 为什么单独立一条：2026-09-18 之前 `bootState.kernelBootstrapped = true`（当时在
// findYFWorking 内、约 :951）**永远抛 TDZ ReferenceError** —— `bootState` 声明在
// :1038，而 `findYFWorking()` 在模块求值期就被调用（`const YFWORKING = findYFWorking()`）。
// 那句赋值被同处 `try { … } catch { }` 静默吞掉，于是：
//   · `/boot-status` 的 kernelBootstrapped 恒为 false；
//   · `electron/main.cjs` 的启动进度永远等不到该步 ⇒ `ready` 永不成立，
//     且它的 300ms 轮询定时器**永不 clearInterval**（空转整个应用生命周期）。
// 整条链上没有任何测试会红 —— 因为**它不报错**，只是永远为假。所以这里的断言不是
// "测行为"而是"测源码结构"：这类缺陷只有结构断言抓得住（同 bridge-auth-token.test.mjs 的做法）。
//
// 为什么不做成"起桥跑一遍":起桥需要端口与 home（EADDRINUSE 时桥会自愈式 taskkill 掉
// 命令行含 yfworking|bridge.mjs 的进程，可能误杀用户正在用的应用），代价与风险都不成比例；
// 而 TDZ 是纯粹的**静态可判定**问题，源码扫描更准也更快。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'bridge.mjs')

/** 去掉注释与字符串字面量后的源码行（避免把注释里的示例、日志文案当成真实引用） */
function codeLines(src) {
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
  return stripped.split('\n')
}

/** 找到模块级 `const NAME =` / `let NAME =` 的行号（1 起；0 = 未找到） */
function declarationLine(lines, name) {
  const re = new RegExp(`^(?:const|let|var)\\s+${name}\\s*=`)
  const i = lines.findIndex((l) => re.test(l))
  return i < 0 ? 0 : i + 1
}

test('bridge.mjs：模块级状态的使用不得早于声明（TDZ 会让赋值静默失效）', () => {
  const src = readFileSync(BRIDGE, 'utf8')
  const lines = codeLines(src)

  // ① 本次事故的具体形态：bootState 必须声明在 findYFWorking 的调用之前。
  const decl = declarationLine(lines, 'bootState')
  assert.ok(decl > 0, '找不到 `const bootState =` —— 若已改名/搬迁，请同步本断言')
  const callLine = lines.findIndex((l) => /^const\s+YFWORKING\s*=\s*findYFWorking\(\)/.test(l)) + 1
  assert.ok(callLine > 0, '找不到 `const YFWORKING = findYFWorking()` —— 请同步本断言')
  assert.ok(decl < callLine,
    `bootState 声明在 :${decl}，但 findYFWorking() 在 :${callLine} 就被调用 —— `
    + 'findYFWorking 内会写 bootState.kernelBootstrapped，模块级 const 尚未求值即写入 ⇒ '
    + 'TDZ ReferenceError 被处内 catch 吞掉，"内核自举"步骤与 /boot-status 的 ready 永远不成立')

  // ② 泛化：声明之后才允许出现该标识符（防止将来又引入同类错序）
  const firstUse = lines.findIndex((l, i) => i + 1 !== decl && /\bbootState\b/.test(l)) + 1
  assert.ok(firstUse > decl,
    `bootState 在 :${firstUse} 被使用，早于其声明 :${decl} —— 模块级 const 存在 TDZ，此处运行期会抛 ReferenceError`)

  // ③ 那句赋值本身必须**不再被空 catch 吞掉**：失败要留痕，否则同类问题会再次隐身。
  const assignIdx = lines.findIndex((l) => /bootState\.kernelBootstrapped\s*=\s*true/.test(l))
  assert.ok(assignIdx >= 0, '找不到 kernelBootstrapped 的置位语句 —— 请同步本断言')
  const around = lines.slice(assignIdx, assignIdx + 8).join('\n')
  assert.match(around, /console\.warn\(/,
    'kernelBootstrapped 置位所在 try 的 catch 必须打日志 —— 空 catch 会把真实失败（含这类 TDZ）吞成"永远为假"')
})
