// server/kernel-readonly.mjs —— bridge → kernel 只读子命令薄转发（U1/AS1）
// ---------------------------------------------------------------------------
// execFileSync(process.execPath, [cli, ...args]) 免 shell quoting（对比 spawn shell:true
// 拼接需 q() 转义）。cli 路径解析与 findYFWorking 同源（YFWORKING_KERNEL > <repo>/kernel/
// cli.mjs > <repo>/kernel-dist/cli.mjs）。60s 超时兜底——只读聚合毫秒级，超时视为内核故障。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function resolveKernelCli() {
  if (process.env.YFWORKING_KERNEL) {
    if (!existsSync(process.env.YFWORKING_KERNEL)) throw new Error(`kernel not found: YFWORKING_KERNEL=${process.env.YFWORKING_KERNEL}`)
    return process.env.YFWORKING_KERNEL
  }
  for (const rel of ['../kernel/cli.mjs', '../kernel-dist/cli.mjs']) {
    const p = join(__dirname, rel)
    if (existsSync(p)) return p
  }
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
