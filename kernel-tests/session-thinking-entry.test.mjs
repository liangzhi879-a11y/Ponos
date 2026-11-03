// kernel/session.mjs#appendThinking：思考块落盘可见；**不单独成帧**，只在带 tool_use 的
// assistant 轮并入 content 头部回放（2026-10-22 修订；DeepSeek /anthropic 缺块直接 400，
// 正面投影断言见 thinking-replay.test.mjs）。
// 本套件钉的是其余不变式：① 磁盘上有 thinking 行（回放数据源）；② 纯文本轮不投影
// （白涨 prompt）；③ thinking 占 seq 且 resume 不丢；④ 脱敏单点覆盖 thinking；⑤ 不计入
// 会话选择器消息数。overflow-loop.test.mjs 的"本轮新增 N 条派生消息"仍成立——thinking
// 从不进 nodes。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore, newSessionId } from '../kernel/session.mjs'
import { redactEntry } from '../kernel/redact.mjs'
import { scanSessions } from '../kernel/tui.mjs'

function newHome() {
  const home = mkdtempSync(join(tmpdir(), 'yfw-think-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const linesOf = (s) => readFileSync(s.file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('appendThinking：落盘可见 + 纯文本轮不投影进 deriveMessages', () => {
  const { home, cleanup } = newHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: newSessionId() })
    s.appendUser('你好')
    s.appendThinking('我先想想……', { model: 'm1' })
    s.appendAssistant([{ type: 'text', text: '答案是 2。' }], { model: 'm1' })

    // ① 磁盘上必须有 thinking 行，且内容完整
    const disk = linesOf(s)
    const think = disk.filter((e) => e.type === 'thinking')
    assert.equal(think.length, 1, '应落盘 1 条 thinking 条目')
    assert.equal(think[0].message.content[0].thinking, '我先想想……')
    assert.equal(think[0].message.role, 'assistant')
    // ③ model 落在 message 层（既有约定：appendAssistant 写 entry.message.model，
    // 消费侧读 msg.model，见 src/lib/transcriptAdapter.ts:288）——写顶层则无人能读到
    assert.equal(think[0].message.model, 'm1', 'model 必须落在 message 层（既有约定）')

    // ② 纯文本 assistant 轮不得并入思考块（回放投影只针对 tool_use 轮）
    const derived = s.deriveMessages()
    const flat = JSON.stringify(derived)
    assert.ok(!flat.includes('我先想想'), `deriveMessages 不得含思考文本：${flat.slice(0, 300)}`)
    assert.equal(derived.length, 2, '派生消息应只有 user + assistant 两条')
  } finally { cleanup() }
})

test('thinking 占 seq：resume 后仍在，且后续新条目 seq 更大（不复用）', async () => {
  const { home, cleanup } = newHome()
  try {
    const sid = newSessionId()
    const s1 = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: sid })
    s1.appendUser('一')
    const t = s1.appendThinking('思考一')
    const thinkSeq = t.seq

    // 重新加载（resume）：thinking 条目不得丢失、不得让 seq 回退
    const s2 = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: sid })
    await s2.load()
    const t2 = s2.appendThinking('思考二')
    assert.ok(t2.seq > thinkSeq, `resume 后新 seq 必须更大：${thinkSeq} → ${t2.seq}`)
    // 无 assistant 可并入 ⇒ 仍不投影（只钉本次实际写入的两段文本，避免将来任何
    // system/injection 文本含"思考"二字时假红）
    const derived2 = JSON.stringify(s2.deriveMessages())
    assert.ok(!derived2.includes('思考一'), `resume 后仍不得投影「思考一」：${derived2.slice(0, 300)}`)
    assert.ok(!derived2.includes('思考二'), `resume 后仍不得投影「思考二」：${derived2.slice(0, 300)}`)
    // 两次思考都在盘上
    assert.equal(linesOf(s2).filter((e) => e.type === 'thinking').length, 2)
  } finally { cleanup() }
})

// —— 脱敏：thinking 字段必须被 writeEntry 单点覆盖（2026-09-23 补漏）——
// 原 redact.mjs 的块分支只认 b.content / b.text / b.type==='tool_use'.input，
// 思考块的字段名是 thinking ⇒ 密钥明文落盘。
test('appendThinking：思考里的敏感串必须落盘打码（走 writeEntry 单点）', () => {
  const { home, cleanup } = newHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: newSessionId() })
    s.appendThinking('我读到了 key=sk-abcdefgh12345678')
    const raw = readFileSync(s.file, 'utf-8')
    assert.ok(!raw.includes('sk-abcdefgh12345678'), '思考里的密钥不得明文落盘')
    assert.ok(raw.includes('sk-***'), '应被打码为 sk-***')
  } finally { cleanup() }
})

test('redactEntry：thinking 字段被覆盖（脱敏单点的字段面）', () => {
  const out = redactEntry({
    type: 'thinking',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'token Bearer abcdefghijklmnop' }] },
  })
  assert.ok(!JSON.stringify(out).includes('abcdefghijklmnop'), 'thinking 字段必须被脱敏')
})

// —— FIX 3 回归：TUI 会话选择器的消息计数不得被 thinking 条目灌水 ——
// scanSessions 是 kernel/tui.mjs 的公开导出（无副作用 import），直接断言其 count。
test('scanSessions：thinking 条目不计入消息数（新增类型不污染会话选择器）', async () => {
  const { home, cleanup } = newHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: 'C:\\proj\\demo', sessionId: newSessionId() })
    s.appendUser('你好')
    s.appendThinking('我先想想……', { model: 'm1' })
    s.appendAssistant([{ type: 'text', text: '答案是 2。' }], { model: 'm1' })
    const list = await scanSessions({ configDir: home, cwd: 'C:\\proj\\demo' })
    assert.equal(list.length, 1, '应列出 1 个会话')
    assert.equal(list[0].count, 2, 'count 只算 user + assistant（thinking 与 meta 同样跳过）')
    assert.equal(list[0].preview, '你好')
  } finally { cleanup() }
})
