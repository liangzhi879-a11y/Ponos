// server/kernel-readonly.mjs —— bridge → kernel 只读子命令薄转发（U1/AS1）
// ---------------------------------------------------------------------------
// 两种调用形态：**异步 `kernelReadonly()`（HTTP 路径唯一入口，K2.1）** 与同步
// `kernelReadonlySync()`（仅测试/离线脚本）。都走 `process.execPath` + 参数数组，免 shell
// quoting（对比 spawn shell:true 拼接需 q() 转义）。cli 路径解析与 findYFWorking 严格同源：
// 委托 electron/kernel-paths.cjs resolveKernelPaths（全应用单一事实来源，勿再开并行解析）
// ——YFWORKING_KERNEL 逃生口优先，其次 install 候选（kernel/ > 上溯一级 kernel/ >
// kernel-dist/），最后 home bootstrap 缓存（<home>/runtime/ponos-kernel）兜底，杜绝与 live
// 会话内核漂移/误 502。60s 超时兜底（异步版自带 kill，见下）。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveKernelPaths } from '../electron/kernel-paths.cjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// appDir 可注入（测试/hermetic 布局用）；缺省 = 本模块上层，与 bridge findYFWorking 的
// join(__dirname,'..') 推导一致 → 两端锁步。
export function resolveKernelCli({ appDir } = {}) {
  // 1) 显式内核覆盖（D8 唯一逃生口），与 findYFWorking 同序：值无效即抛错，绝不静默回退
  if (process.env.YFWORKING_KERNEL) {
    if (!existsSync(process.env.YFWORKING_KERNEL)) throw new Error(`kernel not found: YFWORKING_KERNEL=${process.env.YFWORKING_KERNEL}`)
    return process.env.YFWORKING_KERNEL
  }
  // 2) kernel-paths 统一解析（与 findYFWorking 步骤 2/3 完全同序）：install 候选命中即用；
  //    install 全缺时 home bootstrap 缓存兜底（升级/卸载残留——bridge 仍跑缓存内核时
  //    本端点同样落缓存，避免 502 或查询到与 live 会话不同的内核二进制）。
  const rp = resolveKernelPaths({ appDir: appDir || join(__dirname, '..') })
  if (rp.install.kernel) return rp.install.kernel
  if (rp.kernel) return rp.kernel
  throw new Error('[kernel-readonly] kernel cli.mjs not found — set YFWORKING_KERNEL')
}

// 同步调只读子命令（--usage/--audit/--agents）。stdout = JSON（cli 短路输出）；
// 非零退出抛错（调用方回 502）。同步阻塞可接受：只读聚合毫秒级，60s 超时兜底防悬挂。
// **仅测试与离线脚本可继续用它**：HTTP 路径一律走下面的异步版（同步版会阻塞桥事件循环）。
export function kernelReadonlySync(argsList = [], { env = process.env, cwd = process.cwd(), timeoutMs = 60_000 } = {}) {
  const cli = resolveKernelCli()
  const stdio = ['ignore', 'pipe', 'pipe']
  const out = execFileSync(process.execPath, [cli, '--output-format', 'stream-json', '--input-format', 'stream-json', ...argsList], {
    env, cwd, timeout: timeoutMs, stdio, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  })
  return out.trim()
}

// 在飞的同参请求（单飞）。K2.2 的「单飞锁」被提前到这里，是因为**异步化本身创造了并发**：
// 同步版把桥事件循环堵死，反而"天然串行"；改 async 后 5s 轮询与数秒~数十秒的耗时可以重叠，
// 不设上界就会同时 spawn 好几个内核进程（每个约 50–70MB RSS + 全量扫 transcript）——在本机
// （4 核）上比原来的阻塞更糟。同参合并的语义也是对的：同一问题在同一时刻的答案本就该一致。
const inFlight = new Map()

// 异步调只读子命令（HTTP 路径唯一入口）。stdout = JSON（cli 短路输出，已 trim）；
// 非零退出 / 超时 / 超 maxBuffer 一律 reject（调用方回 502），与同步版逐项对齐——
// 这里的三道保险必须**自己**实现（execFileSync 的 timeout/maxBuffer 是免费的）：
//   - timeout：超时即 kill 并 reject。**不 kill 的话子进程挂死会让路由永久悬挂**，
//     比同步版更糟（同步版超时必返回）。
//   - maxBuffer：stdout 累加超限即 kill + reject，防跑飞的子进程把桥的内存吃光。
//   - stderr 只留前 8KB：错误信息够用即可，不无界增长。
export function kernelReadonly(argsList = [], { env = process.env, cwd = process.cwd(), timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const key = JSON.stringify(argsList)
  const flying = inFlight.get(key)
  if (flying) return flying
  const p = runOnce(argsList, { env, cwd, timeoutMs, maxBuffer })
  inFlight.set(key, p)
  // 无论成败都要摘掉（用 .finally 派生一个新 promise，避免影响返回给调用方的那个）
  p.catch(() => {}).finally(() => { if (inFlight.get(key) === p) inFlight.delete(key) })
  return p
}

function runOnce(argsList, { env, cwd, timeoutMs, maxBuffer }) {
  const cli = resolveKernelCli()
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, '--output-format', 'stream-json', '--input-format', 'stream-json', ...argsList], {
      env, cwd, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let settled = false
    let timer = null
    const done = (fn, v) => {
      if (settled) return // 超时 kill 后 'close' 仍会来，只认第一次
      settled = true
      if (timer) clearTimeout(timer)
      fn(v)
    }
    const kill = () => { try { proc.kill() } catch { /* 已自行退出 */ } }
    timer = setTimeout(() => { kill(); done(reject, new Error(`[kernel-readonly] timeout ${timeoutMs}ms`)) }, timeoutMs)
    proc.stdout.on('data', (d) => {
      out += d
      if (out.length > maxBuffer) { kill(); done(reject, new Error(`[kernel-readonly] stdout 超过上限 ${maxBuffer}B`)) }
    })
    proc.stderr.on('data', (d) => { if (err.length < 8192) err += d })
    proc.on('error', (e) => done(reject, e))
    proc.on('close', (code) => {
      if (code === 0) return done(resolve, out.trim())
      done(reject, new Error(err.trim() || `[kernel-readonly] exit ${code}`))
    })
  })
}
