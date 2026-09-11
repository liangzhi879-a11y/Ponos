// 会话工作记忆的行内思考清洗（2026-09-09 记忆污染修复）
// ---------------------------------------------------------------------------
// 背景：vLLM Qwen 等弱模型把思考作为行内文本输出（<think>...</think> 混在 text
// 块里）。extractKeyInfo 的 decisions 取自 assistant 落盘文本原文，思考（尤其
// </think> 标签）随会话工作记忆写入 memory/session/<sid>.md，压缩时读回注入会令
// 弱模型模仿"想完即停"截断模式。修复：decisions 在提取时经 stripInlineThink 清洗。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripInlineThink, extractKeyInfo, buildSessionMemoryText, keyInfoBlock } from '../kernel/compact.mjs'

test('stripInlineThink：无标签文本原样返回（快路径）', () => {
  assert.equal(stripInlineThink('正常正文，没有任何标签。'), '正常正文，没有任何标签。')
})

test('stripInlineThink：单个闭合块删除且保留尾部正文', () => {
  const t = '<think>用户在问 1+1</think>\n\n答案是 2。'
  assert.equal(stripInlineThink(t), '答案是 2。')
})

test('stripInlineThink：思考夹在正文中间', () => {
  const t = '先看需求。<think>让我想想步骤</think>方案如下：…'
  assert.equal(stripInlineThink(t), '先看需求。方案如下：…')
})

test('stripInlineThink：多个思考块全部删除', () => {
  const t = '<think>第一段</think>正文一。<think>第二段</think>正文二。'
  assert.equal(stripInlineThink(t), '正文一。正文二。')
})

test('stripInlineThink：未闭合标签删到末尾（截断形态）', () => {
  const t = '正文前。<think>思考被截断了'
  assert.equal(stripInlineThink(t), '正文前。')
})

test('stripInlineThink：纯思考条清洗后为空', () => {
  assert.equal(stripInlineThink('<think>I should answer concisely.</think>'), '')
  assert.equal(stripInlineThink('  <think>未闭合'), '')
})

test('stripInlineThink：孤儿 </think>（无开头标签，Qwen 实测形态）删思考保正文', () => {
  assert.equal(stripInlineThink('思考文字没有开头标签</think>\n\n答案是正文。'), '答案是正文。')
  assert.equal(stripInlineThink('The user is asking me to introduce myself.\n</think>\n\n我是 YFWorking。'), '我是 YFWorking。')
})

test('stripInlineThink：孤儿 </think> 在末尾（无正文）清洗后为空', () => {
  assert.equal(stripInlineThink('只有思考，直接以标签收尾</think>'), '')
  assert.equal(stripInlineThink('</think>'), '')
})

test('stripInlineThink：成对块 + 孤儿标签混合', () => {
  assert.equal(stripInlineThink('<think>成对块</think>正文A</think>\n正文B'), '正文B')
})

test('stripInlineThink：空/非字符串输入安全', () => {
  assert.equal(stripInlineThink(''), '')
  assert.equal(stripInlineThink(null), '')
  assert.equal(stripInlineThink(undefined), '')
})

test('extractKeyInfo：纯思考 assistant 条被丢弃，取最近 2 条非空决策', () => {
  const msgs = [
    { role: 'assistant', content: [{ type: 'text', text: '<think>思考一</think>最早的有效答案。' }] },
    { role: 'assistant', content: '<think>只有思考没有答案</think>' }, // 清洗后空 → 丢弃
    { role: 'assistant', content: [{ type: 'text', text: '<think>思考二</think>倒数第二条。' }] },
    { role: 'assistant', content: '最后一条：完整结论。' },
  ]
  const key = extractKeyInfo(msgs)
  assert.equal(key.decisions.length, 2)
  assert.equal(key.decisions[0], '倒数第二条。')
  assert.equal(key.decisions[1], '最后一条：完整结论。')
})

test('buildSessionMemoryText：端到端（extractKeyInfo → 记忆文件）无 </think> 残留', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'a.md' } }] },
    { role: 'assistant', content: [{ type: 'text', text: '<think>思考</think>有效决策内容。' }, { type: 'text', text: '无标签决策。' }] },
  ]
  const key = extractKeyInfo(msgs)
  const text = buildSessionMemoryText(key)
  assert.ok(!text.includes('<think'), '记忆文件不得含思考标签')
  assert.ok(!text.includes('</think>'), '记忆文件不得含思考闭合标签')
  assert.ok(text.includes('有效决策内容。 无标签决策。'))
})

test('keyInfoBlock：端到端（extractKeyInfo → key-info）同样无思考残留', () => {
  const msgs = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: '任务A' }, { content: '任务B' }] } }] },
    { role: 'assistant', content: [{ type: 'text', text: '<think>内部推演</think>最终结论：通过。' }] },
  ]
  const key = extractKeyInfo(msgs)
  const block = keyInfoBlock(key)
  assert.ok(!block.includes('<think'))
  assert.ok(block.includes('最终结论：通过。'))
  assert.ok(block.includes('任务A / 任务B'))
})
