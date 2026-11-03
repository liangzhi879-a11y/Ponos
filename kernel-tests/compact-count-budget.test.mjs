// 压缩的「条数预算」（2026-10-19）
// ---------------------------------------------------------------------------
// 【真实故障（调试版重启后日志）】窗口口径修好、免费收缩生效之后，暴露的**下一层**缺陷：
//     03:14:04 compaction done ok=true
//     03:14:46 compaction done ok=true
//     03:15:07 compaction done ok=true     ← 每 42 秒摘一次
//     03:15:36 compaction done ok=false    ← 第四次失败
//     03:15:36 [compact] action=none reason=no-convergence msgs=126
//     03:15:44 [compact] action=none reason=count-over-no-shrink msgs=130 est=51265
//     [api] POST body=131133B → 143101B    ← 又开始单调上涨
//
// 【根因：条数门与摘要保留策略脱耦】
//   `retainTokens` 只约束**保留区的 token 量**，保留区**条数**不受 `maxMessages` 任何约束
//   ⇒ 摘要后条数 = 1(摘要) + 保留区，实测 217/312 条，仍远超 120
//   ⇒ 「条数超门」永远成立 ⇒ 每 3 轮（NOSHRINK_LIMIT）重复摘要一次、收益递减
//   ⇒ 最终 covered 越来越小 ⇒ 摘要比原文还长 ⇒ `no-convergence` ⇒ 膨胀重新开始。
//
// 【修法：给保留区加**条数预算**】保留条数 ≤ maxMessages × keepTargetRatio（默认 0.5）。
//   取 0.5 而不是刚好等于门：压到"刚好 120"意味着每轮都要重摘（涨 6 条就超），且 covered
//   只有几条（摘要自身占 1 条、固定开销 500–2000 token ⟹ 在条数上零收益、必然 no-convergence）。
//   压到一半 ⟹ 一次摘要撑几十轮，且 covered 足够大能收敛。
//
// 【真实数据逼出的两条约束（第三、四条 test）】
//   ① 真实 user turn 起点**极稀疏**：实测某长会话 408 条里只有 5 个（86/138/203/294/306）；
//   ② 尾部可能是**单个超长 turn**：最后 94 条同属一个 turn（工具循环）
//   ⇒ 条数预算经常**无法精确满足**。此时必须**退让到最近的起点**（保留区超预算但可切），
//     绝不能返回 null：null ⇒ 摘要永不落地 ⇒ 条数无限涨（正是用户最初的抱怨）。
//   ★ turn 是**原子单位**（tool_use 与 tool_result 不可拆）⇒ 条数预算只能是软目标。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findCutPoint, createCompactor } from '../kernel/compact.mjs'
import { estimateHistory, estimateRequest } from '../kernel/context.mjs'
import { createSessionStore } from '../kernel/session.mjs'

process.env.PONOS_MOCK_API = '1'

const estimateMessage = (m) => {
  if (typeof m.content === 'string') return Math.ceil(m.content.length / 4)
  return (m.content || []).reduce(
    (s, b) => s + (b.text ? Math.ceil(b.text.length / 4) : 0) + 50, 0,
  )
}
const estOf = (ms) => ms.reduce((s, m) => s + estimateMessage(m), 0)
const WINDOW = 1_048_576
const MAX_MESSAGES = 120
const retainFor = (ms) => Math.max(1024, Math.min(Math.floor(WINDOW * 0.16), Math.floor(estOf(ms) * 0.5)))

/**
 * 造「真实起点稀疏 + 超长尾 turn」的会话（复刻实测形态）。
 * @param starts 真实 user turn 起点位置；其余位置按 assistant 文本 / tool_result 交替填充
 */
function sparseTurns({ total = 408, starts = [86, 138, 203, 294, 306], tailIsOpen = false } = {}) {
  const msgs = []
  for (let i = 0; i < total; i++) {
    if (starts.includes(i)) msgs.push({ role: 'user', content: `真实用户输入 ${i}` })
    else if (i % 2 === 0) msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(600) }] })
    else msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'r'.repeat(400) }] })
  }
  // 默认把尾部改成普通 assistant 文本：否则最后一条是 tool_result 前的 tool_use，
  // 会命中 open tail 直接 null，本文件的判据就测不到了（夹具必须进目标分支）。
  msgs[total - 1] = tailIsOpen
    ? { role: 'assistant', content: [{ type: 'tool_use', id: 'open', name: 'Bash', input: {} }] }
    : { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(200) }] }
  return msgs
}

test('★ 判据①：条数预算必须让保留区收口到 maxMessages 以内（修前摘要后仍 206 条 ⇒ 每 3 轮重摘）', () => {
  const msgs = sparseTurns()
  const retain = retainFor(msgs)
  const noBudget = findCutPoint({ messages: msgs, retainTokens: retain, estimateMessage })
  const withBudget = findCutPoint({ messages: msgs, retainTokens: retain, estimateMessage, maxKeptMessages: 60 })

  assert.ok(noBudget, '前置条件：无预算时也必须能切（否则对比无意义）')
  const keptNoBudget = msgs.length - noBudget.start
  assert.ok(keptNoBudget + 1 > MAX_MESSAGES,
    `前置条件：无条数预算时摘要后条数必须仍超门（实得 ${keptNoBudget + 1}）`
    + ' —— 这正是"每 3 轮重摘一次直到 no-convergence"的成因')

  assert.ok(withBudget, '有条数预算时必须仍能切')
  const keptWithBudget = msgs.length - withBudget.start
  assert.ok(keptWithBudget + 1 <= MAX_MESSAGES,
    `有条数预算时摘要后必须收口（实得 ${keptWithBudget + 1} 条，门 ${MAX_MESSAGES}）。`
    + ' 收不了口 ⇒ 每 3 轮重摘一次、收益递减直到 no-convergence')
  assert.ok(withBudget.start > noBudget.start, '条数预算应把切点往**后**推（遮蔽更多、保留更少）')
})

test('★ 判据②：估算起点之后才有真实起点（向前无起点）⇒ 必须**往后**找，不得返回 null', () => {
  // ★ 这条是变异测试返工出来的：初版判据②用 starts=[86..306] 且 idx≈340，
  //   "从 340 往前退"第一个就撞上 306 ⇒ 通过靠的是**往前找**，
  //   把"往后找"整段删掉也照样绿（实测 pass 5 / fail 0）⇒ 恒真断言。
  //   现在把唯一起点放在 350（**idx=340 之后**）：从 340 往前退到 0 都没有起点，
  //   只有"往后找"能看到 350。删掉往后找 ⇒ null ⇒ 摘要永不落地 ⇒ 条数无限涨。
  const msgs = sparseTurns({ total: 400, starts: [350] })
  const retain = retainFor(msgs)
  const cut = findCutPoint({ messages: msgs, retainTokens: retain, estimateMessage, maxKeptMessages: 60 })
  assert.ok(cut, '向前无起点时必须往后找最近起点，不得返回 null（null ⇒ 永不摘要）')
  assert.equal(cut.start, 350, `必须落在唯一的真实起点 350（实得 ${cut.start}）`)
  assert.ok(msgs.length - cut.start <= 60, '此后找的切点也应满足条数预算')
})

test('★ 判据③：条数预算**无法满足**（尾部是单个超长 turn）⇒ 退让到最近起点，不返回 null', () => {
  // 实测形态：400 条里 5 个起点（...294/306），最后 94 条是**同一个 turn**（工具循环）
  // ⇒ 预算 60 条不可能满足（turn 是原子单位）⇒ 只能退让到 306，保留 94 条。
  // 关键是**仍能收口**（94+1=95 ≤ 120）；返回 null 则膨胀重新开始。
  const msgs = sparseTurns({ total: 400 })
  const retain = retainFor(msgs)
  const cut = findCutPoint({ messages: msgs, retainTokens: retain, estimateMessage, maxKeptMessages: 60 })
  assert.ok(cut, '预算无法满足时必须退让（可切）而不是 null')
  assert.equal(cut.start, 306, `应退让到最近的起点 306（实得 ${cut.start}）`)
  const kept = msgs.length - cut.start
  assert.ok(kept > 60, `保留区必然超预算（实得 ${kept} 条）—— turn 原子性决定，可接受`)
  assert.ok(kept + 1 <= MAX_MESSAGES,
    `但摘要后仍必须收口到门下（实得 ${kept + 1} vs 门 ${MAX_MESSAGES}）`)
})

test('★ 判据④：open tail 仍返回 null（原语义不得被条数预算放宽）', () => {
  const msgs = sparseTurns({ total: 300, tailIsOpen: true })
  const cut = findCutPoint({
    messages: msgs, retainTokens: retainFor(msgs), estimateMessage, maxKeptMessages: 60,
  })
  assert.equal(cut, null,
    '最后一条 assistant 带 tool_use = 进行中 turn，绝不可切（否则 tool_use 与 tool_result 被拆散）')
  assert.equal(
    findCutPoint({ messages: msgs, retainTokens: retainFor(msgs), estimateMessage }), null,
    '不传条数预算时同样为 null（保持版本无关）',
  )
})

test('★ 判据⑤：切点永远是真实 user turn 起点（tool 配对完整性，不因条数预算被破坏）', () => {
  const msgs = sparseTurns({ total: 500, starts: [50, 120, 200, 280, 360, 440] })
  for (const budget of [10, 30, 60, 120, 400]) {
    const cut = findCutPoint({
      messages: msgs, retainTokens: retainFor(msgs), estimateMessage, maxKeptMessages: budget,
    })
    if (!cut) continue
    const m = msgs[cut.start]
    assert.equal(m.role, 'user', `budget=${budget}：切点必须是 user 消息`)
    const isToolResult = Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')
    assert.equal(isToolResult, false, `budget=${budget}：切点不得是 tool_result（那会拆散配对）`)
    assert.ok(cut.start >= 1, `budget=${budget}：切点不能是第 0 条（那样 covered 为空）`)
  }
})

// ---------------------------------------------------------------------------
// 真机形态（2026-10-22）：长工具循环里的 n=1 空转
// ---------------------------------------------------------------------------
// 实测某会话 3431 条 / 158 次 compaction，其中 **140 次 covered=1**：
// [已密封摘要, 真实用户一句, assistant tool_use, tool_result, tool_use, tool_result, ...]
// 真实 user 起点只有索引 1；向后对齐会停在 1 ⇒ covered=[旧摘要] ⇒ 每次都付费重摘
// 同一条摘要，条数零收益，compactCount 却 +1。修法只在**条数预算生效且仍超预算**时
// 把 assistant 工具批次起点也当切点（tool_use 与配对 tool_result 同在保留侧）。

/** 复刻 n=1 形态：索引 0 = 已密封摘要（assistant + 字符串），索引 1 = 唯一真实 user 起点 */
function toolLoop({ pairs = 200 } = {}) {
  const msgs = [
    { role: 'assistant', content: '旧摘要：' + 's'.repeat(400) },
    { role: 'user', content: '真实用户输入（本会话唯一真实起点）' },
  ]
  for (let k = 0; k < pairs; k++) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `u${k}`, name: 'Bash', input: {} }] })
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${k}`, content: 'r'.repeat(400) }] })
  }
  return msgs
}

test('★ 判据⑥：条数预算下切点必须推到工具批次起点（否则 covered 只剩旧摘要 ⇒ n=1 空转）', () => {
  const msgs = toolLoop()
  const cut = findCutPoint({
    messages: msgs, retainTokens: retainFor(msgs), estimateMessage, maxKeptMessages: 60,
  })
  assert.ok(cut, '必须能切；真机的缺陷不是切不了，而是切出 covered=[旧摘要] 的假压缩')
  assert.ok(cut.start >= 2, `切点必须越过「旧摘要 + 唯一起点」（实得 ${cut.start}）`)
  const m = msgs[cut.start]
  assert.equal(m.role, 'assistant', `切点应是工具批次起点（实得 ${m.role}）`)
  assert.equal(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_use'), true,
    '切点必须是带 tool_use 的 assistant（这正是放宽的唯一允许形态）')
  // 放宽的安全性前提：tool_use 与它的 tool_result 必须同侧，绝不拆散配对
  const useId = m.content[0].id
  const partner = msgs[cut.start + 1]
  assert.equal(partner.role, 'user')
  assert.equal(partner.content[0].type, 'tool_result')
  assert.equal(partner.content[0].tool_use_id, useId, '配对不得被切点拆散')
  // 条数预算必须真正收口（这正是放宽的原因）
  assert.ok(msgs.length - cut.start <= 60,
    `保留区应收口到 60 条（实得 ${msgs.length - cut.start}）`)
  // covered 必须含新内容：旧摘要之外，还要有真实 user 与工具批次
  assert.ok(cut.covered.some((x) => x.role === 'user' && typeof x.content === 'string'),
    'covered 应包含真实 user 任务（而不是只有旧摘要）')
  assert.ok(cut.covered.some((x) => Array.isArray(x.content) && x.content.some((b) => b?.type === 'tool_use')),
    'covered 应包含工具批次（否则摘要内容与原文重复、零收益）')
})

test('★ 判据⑦：没有条数预算（或预算未超）⇒ 切点行为逐字不变（仍停在唯一真实起点）', () => {
  const msgs = toolLoop()
  const noBudget = findCutPoint({ messages: msgs, retainTokens: retainFor(msgs), estimateMessage })
  assert.ok(noBudget)
  assert.equal(noBudget.start, 1, `无条数预算时必须保持 HEAD 行为（实得 ${noBudget.start}）`)
  assert.equal(noBudget.covered.length, 1, '这正是真机 n=1 的形态：旧摘要被反复重摘')
  const slack = findCutPoint({
    messages: msgs, retainTokens: retainFor(msgs), estimateMessage, maxKeptMessages: 10_000,
  })
  assert.equal(slack.start, 1, '消息数远小于预算时同样不得放宽（预算未生效 = 行为不变）')
})

/** 端到端夹具：一条已密封摘要 + 「真实 user 一句 + assistant 文本/tool_result 交替」尾巴
 *  （没有 tool_use、也没有新的真实起点 ⇒ 切点只能退到索引 1，covered 只剩旧摘要） */
function makeNoNovelEnv() {
  const events = []
  const wire = {
    system: (subtype, payload) => events.push({ subtype, ...(payload || {}) }),
    summary: () => {},
  }
  const dir = mkdtempSync(join(tmpdir(), 'ponos-nonovel-'))
  const store = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'no-novel-session' })
  store.appendUser('初始任务：把 A 改成 B')
  store.appendAssistant([{ type: 'text', text: '已完成：' + 'x'.repeat(120) }])
  const seqs = store.seqsForMessages(store.deriveMessages())
  store.appendCompactionStart(seqs)
  store.appendCompactionSummary({ summary: '旧摘要：A 已改成 B。' + 's'.repeat(300), coveredSeqs: seqs })
  store.appendUser('继续：再检查一下 C')
  for (let i = 0; i < 60; i++) {
    store.appendAssistant([{ type: 'text', text: '检查中 ' + 'y'.repeat(80) }])
    store.appendToolResult({ toolUseId: `t${i}`, content: 'z'.repeat(200) })
  }
  const context = {
    window: 200_000,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    estimate: ({ system, messages }) => estimateRequest({ system, messages }),
    estimateMessage,
    estimateHistory,
  }
  const compactor = createCompactor({
    session: store, context, model: 'mock-model', maxTokens: 8192, wire,
    env: process.env, sessionMemoryPath: null,
  })
  return { events, store, compactor, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('★ 判据⑧：covered 只剩已密封摘要 ⇒ no-novel-content，不调模型、不落地、计数不涨', async () => {
  const env = makeNoNovelEnv()
  try {
    const before = env.store.compactCount()
    assert.equal(before, 1, '前置：夹具里已密封一条摘要')
    const r = await env.compactor.forceCompact({
      system: 'sys', messages: env.store.deriveMessages(), limit: 200_000,
    })
    assert.equal(r.action, 'none', `摘要的摘要必须直接收手：${JSON.stringify(r).slice(0, 300)}`)
    assert.equal(r.reason, 'no-novel-content')
    assert.equal(env.store.compactCount(), before, '摘要的摘要不得落地（否则 compactCount 虚高）')
    assert.equal(env.events.some((e) => e.subtype === 'compaction'), false,
      '未实际压缩就不得发 compaction start（否则日志里又是一次"假压缩"）')
  } finally { env.cleanup() }
})
