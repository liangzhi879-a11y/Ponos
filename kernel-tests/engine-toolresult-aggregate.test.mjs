// P0-3b 单消息聚合预算（2026-09-12 四家对标：CC 200K 聚合 / pi 双上限）
// ---------------------------------------------------------------------------
// 背景：单条 20K 字符落盘（P0-3）挡不住"一轮几十次工具调用"的聚合膨胀——
// 实测一轮 67 次工具调用把请求面撑到 317KB、会话涨到 292 条消息，长会话在
// DeepSeek 端点上反复流中断。同一 user 消息内 tool_result 合计超预算时，
// 最大几条落盘替换为 preview+path（Read 豁免），合计压回预算内。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAggregateResultBudget } from '../kernel/engine.mjs'

const big = (n) => ({ type: 'tool_result', content: 'x'.repeat(n) })

test('合计超预算 → 从大到小替换至预算内；Read 豁免', () => {
  const results = [big(40_000), big(30_000), big(20_000), big(5_000)]
  const persisted = []
  const out = applyAggregateResultBudget(results, ['Bash', 'Read', 'Bash', 'Bash'], {
    budgetChars: 50_000,
    persist: (content) => { persisted.push(content.length); return '<persisted-output preview="" path="stub.json">' },
  })
  // 40K(Bash) 应被 stub；30K(Read) 豁免；20K(Bash) 被 stub；5K 保留
  const total = out.reduce((s, r) => s + String(r.content).length, 0)
  assert.ok(total <= 50_000, `合计应压回预算内（实际 ${total}）`)
  assert.ok(out[1].content === results[1].content, 'Read 结果不得被 stub')
  assert.ok(out[0].content.startsWith('<persisted-output'), '最大的 Bash 结果应被替换')
  assert.ok(out[2].content.startsWith('<persisted-output'), '第二大非 Read 结果应被替换')
  assert.ok(persisted.length >= 1)
})

test('合计未超预算 → 原样返回（同一引用）', () => {
  const results = [big(10_000), big(20_000)]
  const out = applyAggregateResultBudget(results, ['Bash', 'Bash'], {
    budgetChars: 100_000,
    persist: () => { throw new Error('不应触发 persist') },
  })
  assert.equal(out, results, '未超预算不得复制/替换')
})

test('全 Read → 不 stub（宁可超预算也不替换显式索要的内容）', () => {
  const results = [big(60_000), big(60_000)]
  const out = applyAggregateResultBudget(results, ['Read', 'Read'], {
    budgetChars: 10_000,
    persist: () => { throw new Error('Read 不得触发 persist') },
  })
  assert.equal(out, results)
})

test('budgetChars 非法/未设 → 不裁剪', () => {
  const results = [big(99_000)]
  const out = applyAggregateResultBudget(results, ['Bash'], { budgetChars: 0, persist: () => { throw new Error('不应触发') } })
  assert.equal(out, results)
})
