// 首内容窗口自适应（2026-09-09 本地 vLLM 容器适配）
// ---------------------------------------------------------------------------
// prefill 时长随输入规模线性增长：输入体量超阈值（>200k 字符 JSON）时首内容
// 宽限放宽到 600s，小输入/云端保持配置值不变。只放宽不收紧。
// 注意：STREAM_FIRST_BYTE_MS 在 engine 模块求值期冻结 → env 必须在 import 前设定。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_STREAM_FIRST_BYTE_MS = '400'
const { adaptiveFirstByteMs } = await import('../kernel/engine.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('小输入：保持配置的基础宽限', () => {
  const ms = adaptiveFirstByteMs(() => [{ role: 'user', content: 'hi' }], 400)
  assert.equal(ms, 400)
})

test('大输入（>200k 字符）：放宽到 600s 封顶', () => {
  const big = 'x'.repeat(210_000)
  const ms = adaptiveFirstByteMs(() => [{ role: 'user', content: big }], 400)
  assert.equal(ms, 600_000)
})

test('baseMs=0（守卫关闭）：保持 0（no-op）', () => {
  assert.equal(adaptiveFirstByteMs(() => [{ role: 'user', content: 'x'.repeat(300_000) }], 0), 0)
})

test('估算异常：回退基础宽限（不崩）', () => {
  const ms = adaptiveFirstByteMs(() => { throw new Error('estimate boom') }, 400)
  assert.equal(ms, 400)
})
