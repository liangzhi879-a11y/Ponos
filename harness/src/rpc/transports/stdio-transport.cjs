'use strict'

const { StringDecoder } = require('node:string_decoder')

/**
 * 宿主侧 stdio-transport 适配器：child_process stdout 的 NDJSON 行协议 ↔ envelope。
 * 与 ipc/worker-transport 同构的 { send, onMessage, close }。
 * child duck：{ stdin: { write(s) }, stdout: { on('data', cb) }, kill() }。
 */
function createStdioTransport({ child }) {
  const listeners = new Set()
  let buf = ''
  // UTF-8 半字缓冲：多字节字符跨 data chunk 分裂时不丢不坏（chunk.toString() 会把半字
  // 替换为 U+FFFD，污染行缓冲且无法恢复）。真实 child_process stdout 给 Buffer；测试可给 string。
  const decoder = new StringDecoder('utf8')
  child.stdout.on('data', chunk => {
    buf += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
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
