// server/kernel-readonly.mjs —— bridge → kernel 只读子命令薄转发（U1/AS1）
// ---------------------------------------------------------------------------
// execFileSync(process.execPath, [cli, ...args]) 免 shell quoting（对比 spawn shell:true
// 拼接需 q() 转义）。cli 路径解析与 findYFWorking 严格同源：委托 electron/kernel-paths.cjs
// resolveKernelPaths（全应用单一事实来源，勿再开并行解析）——YFWORKING_KERNEL 逃生口优先，
// 其次 install 候选（kernel/ > 上溯一级 kernel/ > kernel-dist/），最后 home bootstrap 缓存
// （<home>/runtime/ponos-kernel）兜底，杜绝与 live 会话内核漂移/误 502。60s 超时兜底。
import { execFileSync } from 'node:child_process'
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
export function kernelReadonlySync(argsList = [], { env = process.env, cwd = process.cwd(), timeoutMs = 60_000 } = {}) {
  const cli = resolveKernelCli()
  const stdio = ['ignore', 'pipe', 'pipe']
  const out = execFileSync(process.execPath, [cli, '--output-format', 'stream-json', '--input-format', 'stream-json', ...argsList], {
    env, cwd, timeout: timeoutMs, stdio, encoding: 'utf8',
  })
  return out.trim()
}
