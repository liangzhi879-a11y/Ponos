'use strict'

/**
 * 宿主侧 stdio-transport 适配器：child_process stdout 的 NDJSON 行协议 ↔ envelope。
 * 与 ipc/worker-transport 同构的 { send, onMessage, close }。
 * child duck：{ stdin: { write(s) }, stdout: { on('data', cb) }, kill() }。
 */
function createStdioTransport({ child }) {
  const listeners = new Set()
  let buf = ''
  child.stdout.on('data', chunk => {
    buf += chunk.toString()
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }  // 非 JSON 行丢弃（kernel 侧 raw 由 wrapper 处理，宿主侧不适用）
      for (const cb of listeners) { try { cb(parsed) } catch {} }
    }
  })
  return {
    send(env) { child.stdin.write(JSON.stringify(env) + '\n') },
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    close() { child.kill() },
  }
}

module.exports = { createStdioTransport }
