// TUI 渲染纯函数测试：行缓冲切分 + 渐变块字符画缩放
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bufferChunk, scaleBanner } from '../zz-smoke/tui.mjs'

test('bufferChunk：无换行时全部归 rest（流式半行持续累积）', () => {
  let buf = ''
  const r1 = bufferChunk(buf, '你')
  assert.equal(r1.complete, '')
  assert.equal(r1.rest, '你')
  const r2 = bufferChunk(r1.rest, '好')
  assert.equal(r2.complete, '')
  assert.equal(r2.rest, '你好')
  // 结尾换行 → 整段成为 complete，rest 清空
  const r3 = bufferChunk(r2.rest, '\n')
  assert.equal(r3.complete, '你好\n')
  assert.equal(r3.rest, '')
})

test('bufferChunk：多行块只取末尾不完整行做 rest', () => {
  const { complete, rest } = bufferChunk('', 'a\nb\nc')
  assert.equal(complete, 'a\nb\n')
  assert.equal(rest, 'c')
})

test('bufferChunk：换行跨越 chunk 边界', () => {
  // 前一 chunk 以 \n 结尾：complete 含整行，rest 空
  let r = bufferChunk('', 'abc\ndef')
  assert.equal(r.complete, 'abc\n')
  assert.equal(r.rest, 'def')
  r = bufferChunk(r.rest, '\n')
  assert.equal(r.complete, 'def\n')
  assert.equal(r.rest, '')
})

test('scaleBanner：输出仅含渐变块字符集，无 @ 等符号', () => {
  const src = [
    '@@@@@@@@',
    '@OOOO@@',
    '@====@@',
    '@@@@@@@@',
  ]
  const out = scaleBanner(src, 6, 4)
  const allowed = new Set([' ', '░', '▒', '▓', '█'])
  for (const line of out) {
    for (const ch of line) {
      assert.ok(allowed.has(ch), `非法字符 ${JSON.stringify(ch)}`)
    }
  }
  // 有实质内容（不全空白）
  assert.ok(out.some((l) => l.trim().length > 0))
  // 宽度与目标一致
  assert.ok(out.every((l) => l.length === 6))
})

test('scaleBanner：小于目标时直接居中不缩放，仍为渐变块', () => {
  const src = ['█', '░']
  const out = scaleBanner(src, 4, 3)
  assert.equal(out.length, 2)
  assert.ok(out.every((l) => l.length === 4))
  assert.equal(out[0][0], '█')
  assert.equal(out[1][0], '░')
})
