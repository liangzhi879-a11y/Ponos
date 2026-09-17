/**
 * shell 命令行的「引号与校验」单一真源（P1 · shell 拼接加固，2026-09-17）
 * ---------------------------------------------------------------------------
 * 背景：`electron/diag-monitor.cjs` 与 `electron/app-profiler.cjs` 原先各自把路径拼进
 * shell 命令行（`cmdArgs.join(' ')` + `spawn(..., {shell:true})` / `exec(`"${exePath}" ...`)`）。
 * 字符串拼接意味着**路径自身含 `"` 就能闭合引号并注入命令**，例如：
 *     C:\tmp\a"& calc &".bat
 * 这里把"何时加引号、哪些字符必须拒绝"收敛到一处，两个模块共用，避免各自再写一遍。
 *
 * 为什么 cmd 下加双引号足够（而不必弃用 shell）：
 *   · cmd 在双引号内不再把 `& | < > ^` 当命令分隔/重定向符，一律作字面量；
 *   · `%VAR%` 在引号内仍会展开，但展开只能替换文本、无法执行命令；
 *   · 真正的逃逸途径是**输入自身含 `"`**，故显式拒绝该字符。
 * 另拒绝 CR/LF：cmd 视其为命令结束/续行，属注入向量。
 *
 * 注：这两处的参数本身是硬编码（`--help`/`--version`）或应用内部路径，`exePath` 来自被探测
 * 程序的应用 spec —— 因此本模块属**纵深防御**（不让"路径里有引号"变成命令执行），
 * 不是在对一个已知可达的攻击面做紧急修补。
 *
 * 纯函数、零依赖，便于单测（见 electron/shell-args.test.mjs）。
 */

/** 一律拒绝：引号（可逃出引号）与 CR/LF（cmd 视为命令边界） */
const UNSAFE = /["\r\n]/

/** 需要加引号才安全：空白与 shell 元字符（含 POSIX 的 $ ` ; 与 Windows 的 % !） */
const NEEDS_QUOTE = /[\s&|<>^()%!$`;,'"=]/

/** 校验单个碎片；不合法直接抛（调用方按"探测失败"处理，而不是带着注入风险执行） */
function assertShellSafe(value, label = 'argument') {
  const v = String(value ?? '')
  if (v === '') throw new Error(`${label} is empty`)
  if (UNSAFE.test(v)) throw new Error(`${label} contains quote/CR/LF: ${JSON.stringify(v)}`)
  return v
}

/** 按需加引号（简单 flag 如 `--help` 原样返回，保持既有行为不变） */
function quoteShellArg(value, label = 'argument') {
  const v = assertShellSafe(value, label)
  return NEEDS_QUOTE.test(v) ? `"${v}"` : v
}

/**
 * 构造 shell 命令行：可执行文件 + 参数，逐段校验并按需加引号。
 * 传入顺序即 argv 顺序；返回字符串用于 `spawn(cmd, {shell:true})` 或 `exec(cmd)`。
 */
function buildCommandLine(exePath, args = []) {
  const parts = [quoteShellArg(exePath, 'exePath')]
  args.forEach((a, i) => parts.push(quoteShellArg(a, `arg[${i}]`)))
  return parts.join(' ')
}

/** 该输入是否会被本模块拒绝（供调用方做前置判断，避免用异常控流程） */
function isShellSafe(value) {
  const v = String(value ?? '')
  return v !== '' && !UNSAFE.test(v)
}

module.exports = { quoteShellArg, buildCommandLine, isShellSafe, UNSAFE, NEEDS_QUOTE }
