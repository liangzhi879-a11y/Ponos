'use strict'

const path = require('node:path')
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const { createSessionHost } = require('./core.cjs')

/**
 * agent-core cli-bridge 子进程入口。
 * 宿主 stdin NDJSON：{ id, method, params } → stdout 响应 { id, result|error }；
 * kernel 事件 → stdout 通知 { method:'session.event', params:{ sessionId, event } }。
 * kernelPath 默认 repo-root kernel/cli.mjs（本文件位于 modules/agent-core/）。
 */
function runAgentCore({ stdin = process.stdin, stdout = process.stdout, kernelPath, spawnImpl, readlineImpl } = {}) {
  const host = createSessionHost({
    spawnImpl: spawnImpl || spawn,
    readlineImpl,
    kernelPath: kernelPath || path.join(__dirname, '..', '..', 'kernel', 'cli.mjs'),
    nodePath: process.execPath,  // 本进程即 node 运行，execPath 可直接复用
    args: ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--dangerously-skip-permissions'],
  })
  host.spawnKernel()
  host.onEvent(event => {
    stdout.write(JSON.stringify({ method: 'session.event', params: { sessionId: host.status().sessionId, event } }) + '\n')
  })
  const rl = readline.createInterface({ input: stdin })
  rl.on('line', line => {
    let req
    try { req = JSON.parse(line) } catch { return }
    if (!req || req.id === undefined) return
    const res = host.handleRequest(req.method, req.params)
    if (res.ok) stdout.write(JSON.stringify({ id: req.id, result: res }) + '\n')
    else stdout.write(JSON.stringify({ id: req.id, error: res.error }) + '\n')
  })
  return host
}

if (require.main === module) runAgentCore()
module.exports = { runAgentCore }
