// T001 验收：mock SSE → protocolStream 只产出一个 usage chunk
// 用法：node verify.mjs <workspace>
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const ws = process.argv[2]
const testFile = join(ws, 'server', 'zz-bench-T001-verify.test.mjs')
const testContent = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { protocolStream } from '../kernel/api.mjs'

test('protocolStream：完整 Anthropic 事件序列仅产出一个 usage chunk（T001 验收）', async () => {
  const events = [
    JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    JSON.stringify({ type: 'content_block_start', content_block: { type: 'text', text: '' } }),
    JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好，世界。\\n\\n' } }),
    JSON.stringify({ type: 'content_block_stop' }),
    JSON.stringify({ type: 'message_delta', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }),
  ]
  const sse = events.map((e) => 'data: ' + e).join('\\n\\n') + '\\n\\ndata: [DONE]\\n\\n'
  const prev = global.fetch
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }),
  })
  try {
    const chunks = []
    for await (const c of protocolStream({ protocol: 'anthropic', url: 'http://t/v1/messages', body: {}, headers: {} })) chunks.push(c)
    const usages = chunks.filter((c) => c.type === 'usage')
    assert.equal(usages.length, 1)
    assert.equal(usages[0].usage.output_tokens, 3)
    assert.equal(usages[0].usage.cache_read_input_tokens, 2)
    assert.ok(chunks.some((c) => c.type === 'text'))
  } finally {
    global.fetch = prev
  }
})
`
writeFileSync(testFile, testContent)
try {
  execFileSync(process.execPath, ['--test', testFile], { cwd: ws, stdio: 'pipe', timeout: 60000 })
  console.log('VERIFY_PASS')
  process.exit(0)
} catch (e) {
  const out = e.stdout?.toString?.() || ''
  const tail = out.split('\n').slice(-15).join('\n')
  console.error('VERIFY_FAIL')
  console.error(tail)
  process.exit(1)
} finally {
  try { unlinkSync(testFile) } catch { }
}
