import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStdioTransport } from './stdio-transport.cjs'

/** fake child：手动触发 stdout data 分片，模拟行到达与半行合并。 */
function fakeChild() {
  const c = { stdin: { write() {} }, stdout: null, killed: false, kill() { this.killed = true } }
  const dataListeners = []
  c.stdout = { on(ev, cb) { if (ev === 'data') dataListeners.push(cb) } }
  c.emit = chunk => dataListeners.forEach(cb => cb(chunk))
  return c
}

test('send 写 JSON 行；onMessage 收到解析后的对象（半行合并 + 非 JSON 丢弃）', () => {
  const c = fakeChild()
  const written = []
  c.stdin.write = s => written.push(s)
  const t = createStdioTransport({ child: c })
  const got = []
  t.onMessage(m => got.push(m))
  t.send({ id: 1, method: 'session.status' })
  assert.equal(written.length, 1)
  assert.equal(written[0], JSON.stringify({ id: 1, method: 'session.status' }) + '\n')
  // 分片到达：第一片只含半行 + 第二片补全 → 应合并为一行
  c.emit('{"id": 2, "res')
  assert.equal(got.length, 0, '半行不应触发')
  c.emit('ult": {"ok": true}}\n')
  assert.equal(got.length, 1)
  assert.deepEqual(got[0], { id: 2, result: { ok: true } })
  // 非 JSON 行丢弃
  c.emit('not json\n')
  assert.equal(got.length, 1)
})

test('UTF-8 多字节字符跨 chunk 分裂不丢字（StringDecoder 缓冲半字）', () => {
  const c = fakeChild()
  const t = createStdioTransport({ child: c })
  const got = []
  t.onMessage(m => got.push(m))
  const line = JSON.stringify({ id: 9, result: { text: '你好世界' } }) + '\n'
  const full = Buffer.from(line, 'utf8')
  const youStart = full.indexOf(Buffer.from('你', 'utf8'))  // '你' 的首字节 offset（其前全 ASCII）
  assert.ok(youStart > 0, '夹具应能找到多字节起点')
  const cut = youStart + 1  // 切在 '你' 三字节中间 → 半字分裂（E4 已到，BD A0 下一片）
  c.emit(full.subarray(0, cut))
  assert.equal(got.length, 0, '半行不应触发')
  c.emit(full.subarray(cut))
  assert.equal(got.length, 1)
  assert.deepEqual(got[0], { id: 9, result: { text: '你好世界' } }, '跨 chunk 分裂的多字节字符应无损还原')
})

test('onMessage 返回退订；close 调 child.kill', () => {
  const c = fakeChild()
  const t = createStdioTransport({ child: c })
  let n = 0
  const off = t.onMessage(() => n++)
  c.emit('{"method":"session.event","params":{}}\n')
  off()
  c.emit('{"method":"x"}\n')
  assert.equal(n, 1)
  t.close()
  assert.equal(c.killed, true)
})
