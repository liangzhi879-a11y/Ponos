// TUI 渲染纯函数测试：行缓冲切分 + 渐变块字符画缩放 + 键盘解析 + 宽度工具
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bufferChunk, scaleBanner, visWidth, wrapText, trunc, cursorPosOf, computeLayout, KeyStream } from '../kernel/tui.mjs'

test('bufferChunk：无换行时全部归 rest（流式半行持续累积）', () => {
  let buf = ''
  const r1 = bufferChunk(buf, '你')
  assert.equal(r1.complete, '')
  assert.equal(r1.rest, '你')
  const r2 = bufferChunk(r1.rest, '好')
  assert.equal(r2.complete, '')
  assert.equal(r2.rest, '你好')
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
  assert.ok(out.some((l) => l.trim().length > 0))
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

test('visWidth：东亚宽字符按 2 计，ASCII 按 1', () => {
  assert.equal(visWidth('abc'), 3)
  assert.equal(visWidth('你好'), 4)
  assert.equal(visWidth('a你b'), 4)
  assert.equal(visWidth('┃ Assistant '), 12)
})

test('visWidth：跳过 ANSI 颜色序列（着色行宽度正确）', () => {
  const colored = '\x1b[38;2;255;66;0mPonos\x1b[0m'
  assert.equal(visWidth(colored), 5)
  const mixed = '\x1b[1m你好\x1b[0m world'
  assert.equal(visWidth(mixed), 10) // 你好=4 + 空格1 + world=5
})

test('wrapText：按宽度折行且不拆字符', () => {
  assert.deepEqual(wrapText('你好世界', 4), ['你好', '世界'])
  assert.deepEqual(wrapText('abcd', 3), ['abc', 'd'])
  assert.deepEqual(wrapText('a\nb', 10), ['a', 'b'])
  assert.deepEqual(wrapText('', 10), [''])
})

test('wrapText：ANSI 序列原样保留、不计宽、不拆行', () => {
  // 红 ▍ 尾巴（streaming 指示）不会把颜色序列拆到两行；'▍' 宽 1，width=4 触发折行
  const colored = 'abcd\x1b[38;2;255;36;0m▍\x1b[0m'
  const out = wrapText(colored, 4)
  assert.equal(out.length, 2)
  assert.equal(out[0], 'abcd')
  assert.equal(out[1], '\x1b[38;2;255;36;0m▍\x1b[0m') // 序列完整保留、不被拆行
})

test('trunc：ANSI 序列原样保留且绝不切半', () => {
  const colored = 'Ponos\x1b[38;2;255;66;0m 交互\x1b[0m'
  const out = trunc(colored, 8)
  assert.ok(!out.includes('m\x1b') || true) // 无断言性检查，仅验证不抛
  // 截断后不残留未闭合的 ESC 序列：以 … 结尾且 ESC 只出现在成对序列中
  const stripped = out.replace(/\x1b\[[0-9;]*m/g, '')
  assert.equal(stripped.endsWith('…'), true)
  // 每个 ESC 序列都被完整保留（成对出现）
  assert.equal((out.match(/\x1b\[/g) || []).length, (out.match(/m/g) || []).length)
  // 宽度不超过目标
  assert.ok(visWidth(out) <= 9)
})

test('cursorPosOf：换行与折行后的光标坐标', () => {
  assert.deepEqual(cursorPosOf('你好', 1, 4), { row: 0, col: 2 }) // '你' 宽 2
  assert.deepEqual(cursorPosOf('你好', 2, 4), { row: 0, col: 4 })
  assert.deepEqual(cursorPosOf('你好世', 3, 4), { row: 1, col: 2 }) // '世' 超宽折行
  assert.deepEqual(cursorPosOf('a\nb', 2, 10), { row: 1, col: 0 }) // 换行符后
})

test('computeLayout：四层布局行数分配（含三条分隔线）', () => {
  const l = computeLayout(30, 100, { inputLines: 2 })
  assert.equal(l.headerRows, 2)
  assert.equal(l.footerRows, 1)
  assert.equal(l.dividerRows, 3)
  assert.equal(l.inputRows, 2)
  assert.equal(l.approvalRows, 0)
  assert.equal(l.viewportRows, 30 - 2 - 1 - 3 - 2 - 0)
  // 分隔线+四层总行数恰好等于总行数
  assert.equal(l.headerRows + l.footerRows + l.dividerRows + l.inputRows + l.approvalRows + l.viewportRows, 30)
  // inputLines 封顶 4
  assert.equal(computeLayout(30, 100, { inputLines: 9 }).inputRows, 4)
  // approval 占用 3 行（标题/理由/选项）
  const la = computeLayout(30, 100, { inputLines: 1, approval: true })
  assert.equal(la.approvalRows, 3)
  assert.equal(la.headerRows + la.footerRows + la.dividerRows + la.inputRows + la.approvalRows + la.viewportRows, 30)
})

test('KeyStream：Enter / Shift+Enter / Ctrl+C / 方向键 / 可打印字符', () => {
  const ks = new KeyStream()
  const ev = ks.push(Buffer.from('a\r\x1b[A\x1b[13;2u\x03\x7f', 'utf-8'))
  assert.deepEqual(ev[0], { name: 'char', char: 'a' })
  assert.deepEqual(ev[1], { name: 'enter' })
  assert.deepEqual(ev[2], { name: 'up' })
  assert.deepEqual(ev[3], { name: 'enter', shift: true, newline: true })
  assert.deepEqual(ev[4], { name: 'c', ctrl: true })
  assert.deepEqual(ev[5], { name: 'backspace' })
})

test('KeyStream：换行字节（Ctrl+J / 部分终端 Shift+Enter）视为换行', () => {
  const ks = new KeyStream()
  const ev = ks.push(Buffer.from('\n', 'utf-8'))
  assert.equal(ev[0].newline, true)
})

test('KeyStream：UTF-8 中文跨 chunk 不破坏', () => {
  const ks = new KeyStream()
  const buf = Buffer.from('你好', 'utf-8')
  const ev1 = ks.push(buf.subarray(0, 2)) // '你' 的 3 字节中只给前 2 字节（截断）
  const ev2 = ks.push(buf.subarray(2))
  assert.equal(ev1.filter((e) => e.name === 'char').length, 0) // 未完整解码，不输出
  const chars = ev2.filter((e) => e.name === 'char').map((e) => e.char).join('')
  assert.equal(chars, '你好')
})

// —— 历史会话扫描与投影（恢复历史会话） ——
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSessions, readTranscriptHistory } from '../kernel/tui.mjs'
import { sanitizeSegment } from '../kernel/session.mjs'

function writeTranscript(configDir, cwd, sid, entries) {
  const dir = join(configDir, 'projects', sanitizeSegment(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, sid + '.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
}

test('scanSessions：扫描 transcript 目录，按时间倒序返回预览/条数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-scan-'))
  try {
    writeTranscript(dir, 'proj', 'aaa', [
      { type: 'meta', kind: 'transcript', schemaVersion: 1, timestamp: '2026-08-01T00:00:00Z' },
      { type: 'user', timestamp: '2026-08-01T00:01:00Z', message: { role: 'user', content: '第一条消息' } },
      { type: 'assistant', timestamp: '2026-08-01T00:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '回复' }] } },
    ])
    writeTranscript(dir, 'proj', 'bbb', [
      { type: 'meta', kind: 'transcript', schemaVersion: 1, timestamp: '2026-08-02T00:00:00Z' },
      { type: 'user', timestamp: '2026-08-02T00:01:00Z', message: { role: 'user', content: '更新的一条' } },
    ])
    writeTranscript(dir, 'proj', 'ccc', [
      { type: 'meta', kind: 'transcript', schemaVersion: 1, timestamp: '2026-08-03T00:00:00Z' }, // 仅 meta：不列为会话
    ])
    const sids = await scanSessions({ configDir: dir, cwd: 'proj' })
    assert.equal(sids.length, 2)
    assert.equal(sids[0].id, 'bbb') // 时间倒序：bbb 最新
    assert.equal(sids[0].preview, '更新的一条')
    assert.equal(sids[0].count, 1)
    assert.equal(sids[1].id, 'aaa')
    assert.equal(sids[1].count, 2)
    // 不存在的项目目录 → 空列表
    assert.deepEqual(await scanSessions({ configDir: dir, cwd: 'nope' }), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readTranscriptHistory：user/assistant 文本 + tool_use 卡片 + 摘要行投影，toolCount 续接', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-hist-'))
  try {
    const sid = 'hist-1'
    const file = join(dir, sid + '.jsonl')
    writeFileSync(file, [
      { type: 'meta', kind: 'transcript', schemaVersion: 1 },
      { type: 'user', message: { role: 'user', content: '请运行工具' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '完成：' }, { type: 'text', text: 'done' }] } },
      { type: 'assistant', kind: 'compaction', phase: 'summary', sourceEventSeqs: [1, 2, 3], message: { role: 'assistant', content: '历史压缩摘要' } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')

    const { msgs, toolCount } = readTranscriptHistory(file)
    assert.equal(toolCount, 1)
    assert.deepEqual(msgs[0], { kind: 'user', text: '请运行工具' })
    assert.equal(msgs[1].kind, 'tool')
    assert.equal(msgs[1].name, 'Bash')
    assert.equal(msgs[1].seq, 1)
    // tool_result user 消息不投影（无 text 块）
    assert.equal(msgs[2].kind, 'assistant')
    assert.equal(msgs[2].text, '完成：done') // 同一条 assistant 的多个 text 块合并
    assert.equal(msgs[3].kind, 'result')
    assert.ok(msgs[3].text.includes('历史压缩摘要'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readTranscriptHistory：不存在的文件返回空投影', () => {
  const { msgs, toolCount } = readTranscriptHistory(join(tmpdir(), 'no-such-session.jsonl'))
  assert.deepEqual(msgs, [])
  assert.equal(toolCount, 0)
})
