// server/git-async.mjs —— 桥的异步 git 调用（HTTP 热路径专用）
// ---------------------------------------------------------------------------
// 为什么必须异步：桥是**单进程单事件循环**。此前 /worktrees 与 /branches 用
// `execSync('git …', { timeout: 10000 })`，同步期间**全部会话的 token 流与 WS 心跳停摆**，
// 上限就是那个 timeout（10s）。同源问题在 /api/usage、/api/audit 已留下实测代价
// （10.8–19.6s，见 server/kernel-readonly.mjs 的注释），本模块把同一修法用到 git 上。
//
// 与 kernel-readonly 的异步版一样，execFileSync 免费提供的三道保险必须**自己**实现：
//   - timeout：到点即 kill 并 reject。**不 kill 会让子进程挂死、路由永久悬挂**，
//     比同步版更糟（同步版超时必返回）。
//   - maxBuffer：stdout 累加超限即 kill + reject，防跑飞的子进程吃光桥的内存。
//   - stderr 只留前 8KB：够定位问题即可，不无界增长。
//
// 另：用 **spawn + 参数数组**（非 shell），既免 shell 引号拼接，也让 `--format=%(...)`
// 这类含特殊字符的参数无需再套引号。
import { spawn } from 'node:child_process'

/** 输出上限：git 列表类命令的正常输出是 KB 级，4MB 已足够宽裕 */
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * 异步执行 git 并返回 stdout（已 trim）。失败/超时/超限一律 reject。
 * @param {string[]} args 不含 'git' 本身的参数数组
 * @param {{cwd?: string, timeoutMs?: number, maxBuffer?: number}} [opts]
 * @returns {Promise<string>}
 */
export function gitOut(args, { cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  return new Promise((resolve, reject) => {
    let proc
    try {
      proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      // spawn 本身抛（例如 cwd 不存在）——也走 reject，调用方统一处理
      reject(e)
      return
    }
    let out = ''
    let err = ''
    let settled = false
    let timer = null
    // 超时 kill 后 'close' 仍会到达，只认第一次结算
    const done = (fn, v) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(v)
    }
    const kill = () => { try { proc.kill() } catch { /* 已自行退出 */ } }
    timer = setTimeout(() => { kill(); done(reject, new Error(`git ${args[0]} 超时（${timeoutMs}ms）`)) }, timeoutMs)
    proc.stdout.on('data', (d) => {
      out += d
      if (out.length > maxBuffer) { kill(); done(reject, new Error(`git ${args[0]} 输出超过上限 ${maxBuffer}B`)) }
    })
    proc.stderr.on('data', (d) => { if (err.length < 8192) err += d })
    proc.on('error', (e) => done(reject, e))
    proc.on('close', (code) => {
      if (code === 0) return done(resolve, out.trim())
      // 非零退出：优先回 git 自己的 stderr（比"exit 128"有用得多）
      done(reject, new Error(err.trim() || `git ${args[0]} 退出码 ${code}`))
    })
  })
}

/**
 * 解析 `git worktree list --porcelain`。
 *
 * 修掉一个既有 bug：原实现用 `l.slice(21)` 取分支名，而 'branch refs/heads/' 长为 18，
 * 结果每个分支名都被**截掉前 3 个字符**（`feature/app-universal-onboarding` →
 * `ture/app-universal-onboarding`，`knowledge-s1` → `wledge-s1`），工作树面板一直显示错名。
 * 这里改为按前缀名剥离，不再依赖魔法数字。
 */
export function parseWorktrees(stdout) {
  const w = []
  let cur = null
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) w.push(cur)
      // Windows 的 git 输出反斜杠路径，统一成正斜杠（渲染层按 POSIX 风格展示）
      cur = { path: line.slice('worktree '.length).replace(/\\/g, '/'), branch: '(detached)' }
    } else if (line.startsWith('branch ') && cur) {
      const ref = line.slice('branch '.length).trim()
      cur.branch = ref.replace(/^refs\/heads\//, '')
    }
  }
  if (cur) w.push(cur)
  return w
}

/** 解析 `git branch -a --format=%(refname:short)`：逐行 trim、去空行 */
export function parseBranches(stdout) {
  return String(stdout).trim().split('\n').filter(Boolean).map((b) => b.trim())
}
