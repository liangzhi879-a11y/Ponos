// K1.1 估算记忆化契约（2026-09-13「任务运行慢」系统性优化 Task 2）
// ---------------------------------------------------------------------------
// 实测背景：`estimateRequest` 88.5ms/次 × 3–6 次/步 = 260–530ms/步（2.5MB / 1482 条历史），
// 是每步固定开销的头号来源。热点不是遍历，是每块重做 JSON.stringify + 逐字符 countCjk。
//
// 本文件锁四件事：
//   1) **命中**：同一份历史连续估算，结果逐字段相等，且第二次远快于第一次。
//   2) **不陈旧的唯一风险 = 原地改写**：先用估算污染缓存，再走 compact 的两条改写路径
//      （`ageOutToolResults` 老化清除 / `freeShrink` 结构裁剪）→ 估值必须随之下降。
//      **不 bump contentEpoch 必红**——这是全仓唯一两处 `b.content = …`（已 grep 证明）。
//   3) **密度 env 进键**：改密度系数必须重算（否则会用旧密度算出错误估值）。
//   4) **性能红线**：1MB+ 历史连调 3 次总耗时上限（抗抖动的主断言是相对比值）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateRequest, estimateHistory, estimateMessage, estimateTokens,
  contentEpoch, bumpContentEpoch,
} from '../kernel/context.mjs'
import { freeShrink, ageOutToolResults, CLEARED_TOOL_RESULT_MARKER } from '../kernel/compact.mjs'

const toolResultMsg = (id, text) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] })
const assistantTool = (id, name) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: { file_path: 'x' } }] })
const assistantText = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

/** 合成历史：约 2.5MB（与专项探针同规模），块/消息对象**复用**（真实历史就是这样） */
function bigHistory({ messages = 1500, chunk = 1700 } = {}) {
  const filler = 'x'.repeat(chunk)
  const msgs = []
  for (let i = 0; i < messages; i++) {
    if (i % 3 === 0) msgs.push(assistantText(`第 ${i} 段正文 ${filler}`))
    else if (i % 3 === 1) msgs.push(assistantTool(`tu_${i}`, 'Read'))
    else msgs.push(toolResultMsg(`tu_${i - 1}`, `结果 ${i} ${filler}`))
  }
  return msgs
}

test('命中：两次估算逐字段相等，且第二次远快于第一次', () => {
  const msgs = bigHistory()
  const t1 = performance.now()
  const a = estimateRequest({ system: 'sys', messages: msgs })
  const ms1 = performance.now() - t1
  const t2 = performance.now()
  const b = estimateRequest({ system: 'sys', messages: msgs })
  const ms2 = performance.now() - t2
  assert.deepEqual(b, a, '同一份历史两次估算必须逐字段相等（total + 四区）')
  assert.ok(a.total > 100_000, `夹具应具规模（实际 ${a.total}）`)
  // 相对断言：抗 CI 抖动；命中后只剩 1500 次 WeakMap 查表
  assert.ok(ms2 < ms1 / 5, `第二次应远快于第一次（${ms1.toFixed(1)}ms → ${ms2.toFixed(1)}ms）`)
  assert.ok(ms2 < 20, `命中路径应 <20ms（实际 ${ms2.toFixed(2)}ms）`)
})

test('反例①：老化清除（compact.mjs:59）后估值必须下降——不 bump epoch 必红', () => {
  const msgs = [
    assistantTool('t1', 'Read'), toolResultMsg('t1', 'y'.repeat(4000)),
    assistantTool('t2', 'Read'), toolResultMsg('t2', 'y'.repeat(4000)),
  ]
  const before = estimateHistory(msgs) // 先污染缓存
  const cleared = ageOutToolResults(msgs, { keepRecent: 1 })
  assert.equal(cleared, 1, '应清掉窗口外的 1 条可重放结果')
  assert.equal(msgs[1].content[0].content, CLEARED_TOOL_RESULT_MARKER, '改写已发生')
  const after = estimateHistory(msgs)
  assert.ok(after < before, `清除后估值必须下降（${before} → ${after}）；相等=缓存陈旧`)
})

test('反例②：结构裁剪（compact.mjs:199）后估值必须下降', () => {
  const msgs = [assistantTool('t1', 'Bash'), toolResultMsg('t1', 'z'.repeat(8000))]
  const before = estimateHistory(msgs)
  const r = freeShrink(msgs, { window: 200_000, env: { PONOS_TOOL_RESULT_BUDGET_BYTES: '200' }, age: false })
  assert.equal(r.prunedAny, true, '超预算结果应被裁剪')
  const after = estimateHistory(msgs)
  assert.ok(after < before, `裁剪后估值必须下降（${before} → ${after}）；相等=缓存陈旧`)
})

test('反例③：bumpContentEpoch 后（非 compact 路径的外部改写）同样失效', () => {
  const block = { type: 'text', text: 'w'.repeat(4000) }
  const before = estimateTokens(block)
  block.text = 'w'.repeat(40) // 模拟外部原地缩短（真实场景应配 bump，这里两个都做）
  bumpContentEpoch()
  const after = estimateTokens(block)
  assert.ok(after < before, `纪元 +1 后必须重算（${before} → ${after}）`)
  assert.equal(contentEpoch() > 0, true)
})

test('密度 env 进键：改系数必须重算，恢复后回到原值', () => {
  const msgs = bigHistory({ messages: 60 })
  const a = estimateRequest({ system: '', messages: msgs }).total
  process.env.PONOS_TOKEN_DENSITY_TEXT = '2' // 系数是「每 token 几个字符」→ 变小 = 估值变大
  try {
    const b = estimateRequest({ system: '', messages: msgs }).total
    assert.notEqual(b, a, '密度系数变了必须重算（缓存键缺 dk 就会串味 → 这里会静默返回旧值）')
    assert.ok(b > a, `密度 4→2 应使估值上升（${a} → ${b}）`)
  } finally {
    delete process.env.PONOS_TOKEN_DENSITY_TEXT
  }
  assert.equal(estimateRequest({ system: '', messages: msgs }).total, a, '恢复后应回到原值')
})

test('开关：PONOS_ESTIMATE_CACHE=0 可单独关闭（值不变、不做缓存）', () => {
  const msgs = bigHistory({ messages: 200 })
  const a = estimateRequest({ system: 's', messages: msgs })
  process.env.PONOS_ESTIMATE_CACHE = '0'
  try {
    const b = estimateRequest({ system: 's', messages: msgs })
    assert.deepEqual(b, a, '关缓存只影响性能，不得改变估值')
  } finally {
    delete process.env.PONOS_ESTIMATE_CACHE
  }
  assert.deepEqual(estimateRequest({ system: 's', messages: msgs }), a)
})

test('性能红线：2.5MB 历史连调 3 次 < 200ms', () => {
  const msgs = bigHistory()
  const t0 = performance.now()
  const r1 = estimateRequest({ system: 'sys', messages: msgs })
  const r2 = estimateRequest({ system: 'sys', messages: msgs })
  const r3 = estimateRequest({ system: 'sys', messages: msgs })
  const ms = performance.now() - t0
  assert.equal(r2.total, r1.total)
  assert.equal(r3.total, r1.total)
  // 未记忆化时单次即 ~88ms，三次 ~265ms —— 这条红线挡的正是"缓存被静默关掉/失效"
  assert.ok(ms < 200, `三次估算应 <200ms（实际 ${ms.toFixed(1)}ms，单次约 ${(ms / 3).toFixed(1)}ms）`)
})

test('回归：零散块/边界输入与旧口径一致（不因记忆化改变语义）', () => {
  assert.equal(estimateTokens({ type: 'text', text: '' }), 4)
  assert.equal(estimateTokens(null), 4)
  assert.equal(estimateTokens(42), 4)
  assert.equal(estimateTokens('abc'), Math.ceil(3 / 4) + 4)
  assert.equal(estimateMessage({ role: 'user' }), 4)
  assert.equal(estimateMessage(null), 4)
  assert.equal(estimateMessage({ role: 'user', content: '' }), 8, '空字符串 content 仍是 4 + 4')
  assert.equal(estimateTokens({ type: 'image', source: { type: 'base64', data: 'x' } }), 4800 + 4)
})
