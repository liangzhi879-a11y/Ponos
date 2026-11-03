// kernel-tests/screen-env.mjs —— "本机能不能真跑屏幕脚本"的单一判定（2026-11-01）
//
// 为什么需要它（实测）：
//   `electron/screen.ps1` 第一步就要求 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` 成功，
//   否则 `Fail 'dpi-awareness-declaration-failed'`（**刻意 fail-closed**：DPI 未声明就会坐标虚拟化、
//   静默点偏）。这条前置在**非交互会话**里必然失败 —— CI 的 runner 以服务/SYSTEM 身份跑（session 0），
//   没有可交互桌面 ⇒ `screen-*` 那 12 条"真跑脚本"的用例整片红，而红的原因是被测环境没有桌面，
//   不是脚本行为不对（本机在登录会话里跑就绿）。
//
// 口径：只有**能力缺失**（DPI 声明失败 / 找不到 powershell）才 skip；脚本一旦跑起来，
//   其它任何失败照常红（不掩盖真实缺陷）。skip 在报告里单列，不是"通过"。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PS1 = fileURLToPath(new URL('../electron/screen.ps1', import.meta.url))

let cached
/** 不能真跑屏幕脚本时返回跳过原因；能跑返回 null（结果进程内缓存，只探测一次）。 */
export function screenSkipReason() {
  if (cached !== undefined) return cached
  if (process.platform !== 'win32') { cached = '非 Windows 平台：screen.ps1 只在 Windows 上有意义'; return cached }
  if (!existsSync(PS1)) { cached = '找不到 electron/screen.ps1'; return cached }
  let out
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Act', 'displays'],
      { encoding: 'utf8', timeout: 40_000 })
  } catch (e) {
    cached = `powershell 不可用（${String((e && e.message) || e).slice(0, 120)}）`
    return cached
  }
  let res
  try { res = JSON.parse(String(out).trim().split('\n').filter(Boolean).pop()) } catch { cached = null; return cached }
  if (res && res.ok === false && /dpi-awareness-declaration-failed/.test(String(res.error || ''))) {
    cached = '当前会话没有可交互桌面（SetProcessDpiAwarenessContext 失败）—— 服务/SYSTEM 身份跑 CI 时必然如此'
    return cached
  }
  cached = null
  return cached
}
