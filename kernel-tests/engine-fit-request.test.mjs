// 请求面硬适配 fitRequestToWindow（2026-09-11 持续稳定运行）
// ---------------------------------------------------------------------------
// 背景：上下文溢出时压缩/预算收窄/终局裁剪均无解（慢端点摘要熔断等），旧行为
// 落"本轮已放弃执行"——轮次中断。硬适配把请求面裁到窗口内（系统提示 + 最近一个
// 完整 turn，transcript 不动），轮次继续；连末轮都放不下才返回 null（放弃文案
// 是最终防线）。本文件钉死：保留语义（系统+末轮）、孤儿 tool_use 补链、单 turn
// 超窗走 trimOversizedRequestCopy、病态返回 null、装得下原样返回。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitRequestToWindow } from '../kernel/engine.mjs'
import { estimateMessage } from '../kernel/context.mjs'

const sys = { role: 'system', content: 'sys-prompt' }
const user = (content) => ({ role: 'user', content })
const assistantText = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const assistantTool = (id, name) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] })
const toolResult = (id, text) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] })

test('装得下时原样返回（同一引用，零开销）', () => {
  const msgs = [sys, user('hi'), assistantText('ok')]
  const r = fitRequestToWindow(msgs, { window: 200_000, outputBudget: 1024, estimateMessage })
  assert.equal(r, msgs)
})

test('超窗硬适配：系统提示 + 历史索引（渐进式披露）+ 最近一个完整 turn', () => {
  const msgs = [
    sys,
    user('t1 ' + 'x'.repeat(5000)), assistantText('a'.repeat(5000)),          // turn1 ≈ 2.5K tokens
    user('t2'), assistantTool('u1', 'Read'), toolResult('u1', 'r'.repeat(20000)), assistantText('b'), // turn2 ≈ 6.7K
    user('t3 当前任务'), assistantText('done'),                               // turn3 ≈ 40
  ]
  const r = fitRequestToWindow(msgs, { window: 8000, outputBudget: 1024, estimateMessage, transcriptPath: 'C:/t.jsonl' })
  assert.ok(r, '应有适配结果')
  assert.equal(r[0], sys, '系统提示保留')
  assert.match(String(r[1].content), /<history-index>/, '更早历史索引化（渐进式披露）')
  assert.match(String(r[1].content), /C:\/t\.jsonl/, '索引带 transcript 路径（可 Read 展开）')
  assert.match(String(r[1].content), /t1 |t2 |工具 Read/, '索引行含主题与工具名')
  assert.deepEqual(r[2].content, 't3 当前任务', '最近一个完整 turn 起点保留')
  assert.equal(r.length, 4, 'system + 索引 + 末轮两条')
  const est = r.reduce((s, m) => s + estimateMessage(m), 0)
  assert.ok(est <= 8000 - 1024 - 4096, `适配后应装得下（est=${est}）`)
})

test('保留末轮含孤儿 tool_use → 索引化 + patchOrphanToolUses 合成错误结果补链', () => {
  const msgs = [
    sys,
    user('t1 ' + 'x'.repeat(8000)), assistantText('a'.repeat(8000)), // 超窗旧历史
    user('t2 任务'), assistantTool('u2', 'Read'),                     // 末轮：tool_use 无结果（孤儿）
  ]
  const r = fitRequestToWindow(msgs, { window: 8000, outputBudget: 1024, estimateMessage })
  assert.ok(r)
  assert.equal(r[0], sys)
  assert.match(String(r[1].content), /<history-index>/, '超窗旧历史索引化')
  assert.equal(r.length, 5, 'system + 索引 + user + assistant(tool_use) + 合成 tool_result')
  const last = r[r.length - 1]
  assert.equal(last.role, 'user')
  assert.equal(last.content[0].type, 'tool_result', '孤儿补链为合成错误结果')
  assert.equal(last.content[0].is_error, true)
})

test('索引化装不下（海量历史）→ 退回纯丢弃（不丢系统与末轮）', () => {
  // budget 下限 1024：小索引恒装得下——只有海量消息（索引本身数千行）才触发
  // 退回纯丢弃。3000 条旧消息 ≈ 9 万 est；索引 ≈ 3000 行 × 50 字符 ≈ 37K est > 1024。
  const msgs = [sys]
  for (let i = 0; i < 3000; i++) msgs.push(user(`旧消息 ${i} 内容`), assistantText(`回答 ${i}`))
  msgs.push(user('t2 任务'), assistantText('done'))
  const r = fitRequestToWindow(msgs, { window: 8000, outputBudget: 1024, estimateMessage })
  assert.ok(r)
  assert.equal(r[0], sys)
  assert.ok(!JSON.stringify(r).includes('<history-index>'), '索引装不下时退回纯丢弃')
  assert.deepEqual(r[1].content, 't2 任务')
  assert.equal(r.length, 3)
})

test('末轮单独超窗 → 复用 trimOversizedRequestCopy 裁剪最长块', () => {
  // 预算设计：总量 ≈34K（>预算 32K 触发硬适配）且末轮单独 ≈30K（>预算 32K？否——
  // 30K < 32K 末轮本身装得下）。故改用更窄预算：总量 34K > 27K，末轮 30K > 27K → 走裁剪；
  // 裁剪后 72K 字符 ≈ 18K ≤ 27K ✓。window = 27000+1024+4096 = 32120。
  const big = 'z'.repeat(120_000) // ≥100K 字符触发终局裁剪
  // 数组 content（真实消息形态）：trimOversizedRequestCopy 只扫数组块
  const msgs = [sys, user('t1 ' + 'x'.repeat(8000)), assistantText('a'.repeat(8000)), { role: 'user', content: [{ type: 'text', text: 'big ' + big }] }, assistantText('e')]
  const r = fitRequestToWindow(msgs, { window: 32_120, outputBudget: 1024, estimateMessage })
  assert.ok(r, '裁剪后应装得下')
  const est = r.reduce((s, m) => s + estimateMessage(m), 0)
  assert.ok(est <= 32_120 - 1024 - 4096, `适配后应装得下（est=${est}）`)
  const content = JSON.stringify(r)
  assert.ok(content.includes('已裁剪'), '应带裁剪标记')
  assert.ok(!content.includes('z'.repeat(50000)), '中间大部被裁掉')
})

test('病态：末轮连裁剪后都放不下 → null（放弃文案为最终防线）', () => {
  const msgs = [sys, user('x'.repeat(300_000)), assistantText('e')]
  const r = fitRequestToWindow(msgs, { window: 8000, outputBudget: 1024, estimateMessage })
  assert.equal(r, null)
})
