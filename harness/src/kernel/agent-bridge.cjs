'use strict'

const { spawn } = require('node:child_process')
const readline = require('node:readline')

/** P1 最小内核桥：spawn kernel/cli.mjs（NDJSON 契约）。P3 由 cli-bridge 运行时正式化。 */
function createAgentBridge({ kernelPath, nodePath = process.execPath, env = process.env, spawnImpl, readlineImpl }) {
  let proc = null
  let rl = null
  const listeners = new Set()

  function onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb) }

  function start() {
    const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--dangerously-skip-permissions']
    proc = (spawnImpl || spawn)(nodePath, [kernelPath, ...args], { env: { ...env }, cwd: process.cwd() })
    rl = (readlineImpl || readline.createInterface)({ input: proc.stdout })
    rl.on('line', line => {
      let parsed
      try { parsed = JSON.parse(line) } catch { return }
      for (const cb of listeners) { try { cb(parsed) } catch {} }
    })
    proc.on('exit', () => { proc = null; rl = null })
    return { pid: proc.pid }
  }

  function send(text) {
    if (!proc) return { ok: false, error: 'NOT_RUNNING' }
    proc.stdin.write(JSON.stringify({ type: 'user', data: { text } }) + '\n')
    return { ok: true }
  }

  function cancel() {
    if (!proc) return { ok: false, error: 'NOT_RUNNING' }
    proc.stdin.write(JSON.stringify({ type: 'control_request', request: { subtype: 'cancel' } }) + '\n')
    return { ok: true }
  }

  function stop() {
    if (proc) { proc.kill(); proc = null; rl = null }
    return { ok: true }
  }

  return { start, send, cancel, onEvent, stop }
}

module.exports = { createAgentBridge }
