// 压缩管线安全测试（2026-09-09 长任务挂起事故修复）——纯函数不变量：
// ① 摘要请求组装不放大（covered 注入有界）；② 切点纪律（open tail / turn 边界）；
// ③ 老化清除只清可重放旧结果且幂等；④ 行内思考清洗兜底摘要提取。
// 背景：事故当天 0 条 compaction 落地 + 曾出现 307 万 token 请求，此套件把
// 放大路径（assembleSummaryRequest/findCutPoint/ageOutToolResults）钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findCutPoint,
  assembleSummaryRequest,
  extractSummary,
  stripInlineThink,
  ageOutToolResults,
  CLEARED_TOOL_RESULT_MARKER,
} from '../kernel/compact.mjs'
import { estimateMessage } from '../kernel/context.mjs'

const user = (content) => ({ role: 'user', content })
const toolResultMsg = (id, text) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] })
const assistantText = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const assistantTool = (id, name) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] })

test('findCutPoint：open tail（最后 assistant 带 tool_use）→ null', () => {
  const msgs = [user('a'), assistantText('b'), assistantTool('t1', 'Read')]
  assert.equal(findCutPoint({ messages: msgs, retainTokens: 100, estimateMessage }), null)
})

test('findCutPoint：切点对齐到真实 user turn 起点（不拆 tool 配对）', () => {
  const msgs = [
    user('task 1'), assistantTool('t1', 'Read'), toolResultMsg('t1', 'r1'),
    assistantTool('t2', 'Bash'), toolResultMsg('t2', 'r2'),
    assistantText('done 1'),
    user('task 2'), assistantText('working'),
  ]
  // 保留预算只够最后两条 → 切点必须落在 task 2（turn 起点）
  const keep = estimateMessage(msgs[6]) + estimateMessage(msgs[7])
  const cut = findCutPoint({ messages: msgs, retainTokens: keep, estimateMessage })
  assert.ok(cut, '应有切点')
  assert.equal(cut.start, 6, '保留起点 = task 2')
  assert.equal(cut.covered.length, 6)
})

test('assembleSummaryRequest：输出规模有界（不放大 covered）', () => {
  const msgs = []
  for (let i = 0; i < 20; i++) {
    msgs.push(user(`round ${i} question with some padding text`))
    msgs.push(assistantTool(`t${i}`, 'Read'))
    msgs.push(toolResultMsg(`t${i}`, `result ${i}: ` + 'x'.repeat(400)))
  }
  msgs.push(user('final question'))
  msgs.push(assistantText('final answer'))
  const cut = findCutPoint({ messages: msgs, retainTokens: 2000, estimateMessage })
  assert.ok(cut, '应有切点')
  const coveredChars = JSON.stringify(cut.covered).length
  const req = assembleSummaryRequest({ system: 'sys', messages: msgs, cut, lastSummary: null, keyInfo: '', sessionMemory: '' })
  const reqChars = JSON.stringify(req).length
  // covered + 指令/系统提示注入：增量必须远小于 covered 本身（有界，不重复拼接）
  assert.ok(reqChars < coveredChars + 4000, `req ${reqChars} vs covered ${coveredChars}`)
  assert.equal(req.length, cut.covered.length + 1, 'summary 请求 = covered + 1 条指令消息')
})

test('assembleSummaryRequest：lastSummary 前置且旧字符串摘要过滤（P9-2）', () => {
  const msgs = [
    user('q1'), { role: 'assistant', content: 'old summary string' }, // 旧摘要（字符串 content assistant）
    user('q2'), assistantText('a2'),
  ]
  // 保留预算只够 q2+a2（约 18 est）→ 切点落在 q2 turn 起点，covered = [q1, 旧摘要]
  const cut = findCutPoint({ messages: msgs, retainTokens: 15, estimateMessage })
  assert.ok(cut, '应有切点')
  const req = assembleSummaryRequest({ system: 's', messages: msgs, cut, lastSummary: 'PREV', keyInfo: '', sessionMemory: '' })
  const text = JSON.stringify(req)
  assert.ok(text.includes('PREV'), 'lastSummary 注入')
  assert.ok(!text.includes('old summary string'), '旧字符串摘要被过滤')
})

test('ageOutToolResults：只清窗口外可重放结果，保留最近 N 条，二次调用幂等', () => {
  const msgs = [
    user('go'), assistantTool('t1', 'Read'), toolResultMsg('t1', 'file content 1'),
    assistantTool('t2', 'Edit'), toolResultMsg('t2', 'edited'),
    assistantTool('t3', 'Read'), toolResultMsg('t3', 'file content 2'),
    assistantTool('t4', 'Grep'), toolResultMsg('t4', 'matches'),
  ]
  const cleared = ageOutToolResults(msgs, { keepRecent: 2 })
  // 保留窗口按"全部结果"计（t3/t4 在最近 2 条内）→ 只有窗口外的 t1 可清（t2 Edit 不可清）
  assert.equal(cleared, 1)
  assert.equal(msgs[2].content[0].content, CLEARED_TOOL_RESULT_MARKER, 't1 已清')
  assert.equal(msgs[4].content[0].content, 'edited', 'Edit 不可清')
  assert.equal(msgs[6].content[0].content, 'file content 2', '最近窗口内保留')
  assert.equal(msgs[8].content[0].content, 'matches', '最近窗口内保留')
  assert.equal(ageOutToolResults(msgs, { keepRecent: 2 }), 0, '二次调用幂等（已清的不重复计）')
})

test('stripInlineThink：成对标签删除 / 孤儿闭合标签从头删 / 无标签原样', () => {
  assert.equal(stripInlineThink('a<think>x</think>b'), 'ab')
  assert.equal(stripInlineThink('思考正文直接起头</think>正式回答'), '正式回答')
  assert.equal(stripInlineThink('plain text'), 'plain text')
  assert.equal(stripInlineThink('未闭合 <think>abc'), '未闭合', '未闭合：保留标签前文本，标签起删到末尾')
})

test('extractSummary + 无标签兜底：弱模型不吐标签时整体响应可用作摘要', () => {
  assert.equal(extractSummary('<compacted-summary>内容</compacted-summary>'), '内容')
  assert.equal(extractSummary('no tags at all'), null)
  // 兜底语义（summarize 内联）：null → stripInlineThink(text).trim() 非空即摘要
  const fallback = (text) => extractSummary(text) ?? stripInlineThink(text).trim()
  assert.equal(fallback('no tags at all'), 'no tags at all')
  assert.equal(fallback('<think>t</think>正文'), '正文')
})

test('patchOrphanToolUses：合成 tool_result 紧跟孤儿 tool_use 的下一条（中段孤儿）', async () => {
  const { patchOrphanToolUses } = await import('../kernel/engine.mjs')
  const msgs = [
    user('任务开始'),
    assistantTool('orphan-1', 'Read'),   // 崩溃残留：无配对结果
    user('后续用户消息'),
    assistantTool('ok-1', 'Grep'),
    toolResultMsg('ok-1', 'r1'),
  ]
  const out = patchOrphanToolUses(msgs)
  // 位置断言：合成结果必须紧跟孤儿所在 assistant 的下一条（index 2），
  // 而不是数组末尾（Anthropic "immediately after" 硬约束）
  assert.equal(out[2].role, 'user')
  assert.ok(Array.isArray(out[2].content))
  assert.equal(out[2].content[0].tool_use_id, 'orphan-1')
  assert.equal(out[2].content[0].is_error, true)
  assert.equal(out.length, msgs.length + 1)
})

test('patchOrphanToolUses：无孤儿时不改动消息数', async () => {
  const { patchOrphanToolUses } = await import('../kernel/engine.mjs')
  const msgs = [
    user('go'), assistantTool('t1', 'Read'), toolResultMsg('t1', 'r1'),
  ]
  const out = patchOrphanToolUses(msgs)
  assert.equal(out.length, 3)
})

test('trimOversizedRequestCopy：裁剪最长块（头尾 30%+标记），不污染原消息', async () => {
  const { trimOversizedRequestCopy } = await import('../kernel/engine.mjs')
  const big = 'x'.repeat(300_000)
  const msgs = [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: [{ type: 'text', text: big + 'TAILMARK' }] },
  ]
  const out = trimOversizedRequestCopy(msgs)
  assert.ok(out, '应有裁剪副本')
  assert.notEqual(out, msgs, '深拷贝，不改原数组')
  assert.equal(msgs[1].content[0].text, big + 'TAILMARK', '原消息未被污染')
  const trimmed = out[1].content[0].text
  assert.ok(trimmed.includes('已裁剪'), '带裁剪标记')
  assert.ok(trimmed.includes('TAILMARK'), '尾部保留')
  assert.ok(trimmed.length < big.length, '体积下降')
  // 无超长内容 → null
  assert.equal(trimOversizedRequestCopy([{ role: 'user', content: 'short' }]), null)
})
