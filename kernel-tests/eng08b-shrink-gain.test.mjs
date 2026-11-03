// ENG-08 补强（2026-10-19）：免费收缩"动了东西"≠"把上下文压下去了"
// ---------------------------------------------------------------------------
// 【用户实测现场】长会话上下文膨胀：日志显示 maxMessages=120，会话已到 2500 条，
//   每次请求约 1.8 MB。用户观察："每轮只清 1 条可重放工具结果"。
//
// 【原 ENG-08 的盲区】升级闸的判据是 `shrink.cleared > 0 || shrink.prunedAny` ——
//   **只要动过内容就算"有效"**，于是每轮把 consecutiveCountNoShrink 清零 ⇒ 升级闸
//   永远到不了 ⇒ 条数照样无限增长，而返回值看起来一切正常。
//   为什么这不是吹毛求疵：真实 transcript 实测（本仓 4500c736 会话，deriveMessages
//   1230 条 / est 431478）里，一次**有效**收缩能让 est 降 75%（200351 → 48827）；
//   而"每轮清 1 条 200 字节结果"的降幅只有 0.1% 量级 —— 两者在上下文规模上差三个数量级，
//   却因为同一个 `cleared > 0` 被当成同一件事。
//
// 【修法】判据从"动过没有"改为"**实际降幅**"：降幅 < PONOS_COMPACT_SHRINK_MIN_GAIN
//   （默认 1%）⇒ 视为"收不动"，照常累加计数（连续 N 次后升级到付费摘要）。
//   既保住原设计"不为条数多付费"（真能收敛就继续免费收），又堵住"清得动但压不下"的盲区。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCompactor } from '../kernel/compact.mjs'
import { createSessionStore } from '../kernel/session.mjs'

/** 估算器：按字符数/2（与服务端量级同阶；本组只关心"相对降幅"，不关心绝对值） */
const estOf = (messages) => ({
  total: messages.reduce((s, m) => {
    const c = m.content
    if (typeof c === 'string') return s + Math.ceil(c.length / 2)
    if (!Array.isArray(c)) return s + 4
    return s + c.reduce((n, b) => n + (b.type === 'text' ? Math.ceil(String(b.text || '').length / 2)
      : b.type === 'tool_result' ? Math.ceil(String(b.content || '').length / 2)
        : Math.ceil(JSON.stringify(b.input || {}).length / 2)), 0)
  }, 0),
})

const estMessage = (m) => estOf([m]).total

/**
 * 夹具：`bulkCount` 个不可清的文本回合（占体积）+ `pendingResults` 个可老化工具结果。
 * ★ 关键设计：window 取小值让 `age` 生效（`est >= window*clearRatio`），
 *   同时 `threshold = window*0.8` 要**明显高于**剩余部分 ⇒ 走的是条数门分支（`!overTokens`）。
 */
function harness({ window = 37_500, maxMessages = 5, bulkCount = 7, bulkChars = 8000, pendingResults = 2, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-shrink-gain-'))
  const store = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'shrink-gain' })
  const messages = []
  for (let i = 0; i < bulkCount; i++) {
    messages.push({ role: 'user', content: `问 ${i}` })
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(bulkChars) }] })
  }
  let seq = 0
  const addResult = () => {
    const id = `t${++seq}`
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { path: `/f${seq}` } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'z'.repeat(300) }] })
  }
  for (let i = 0; i < pendingResults; i++) addResult()
  const compactor = createCompactor({
    session: store,
    context: {
      window, thresholdRatio: 0.8, retainRatio: 0.16, maxMessages,
      estimateMessage: estMessage, estimate: ({ messages: ms }) => estOf(ms),
    },
    model: 'test-model', maxTokens: 1024, wire: { system: () => {} },
    // ★ window=37500 与 clearRatio=0.3 是**一起算出来的**（不是拍的）：
    //   threshold = 37500*0.8 = 30000；age 门 = 37500*0.3 = 11250。
    //   夹具的 est 落在 (~28450, 34325) ⇒ 既过 age 门（真会清）、又能在"清掉 40 条"后跌破
    //   threshold（于是能测到"token 解决"那一侧）。写死一个不看量级的窗口，会让夹具压根
    //   进不到目标分支 —— 本仓踩过多次的"断言恒真"老坑。
    //   否则 age=false ⇒ 一条都不清 ⇒ 测到的是"完全没东西可清"那条路径，与本组要测的
    //   "清了但只清 1 条"不是同一件事（这是本仓"夹具没进到目标分支 ⇒ 断言恒真"的老坑）。
    env: { PONOS_TOOL_RESULT_CLEAR_RATIO: '0.3', ...process.env, ...env },
  })
  return { messages, store, compactor, addResult, dir }
}

test('★ ENG-08 补强：只清 1 条（降幅 <1%）**不算**有效收缩 ⇒ 计数累加，连续 N 次后升级摘要', async () => {
  // 夹具：体积由 10 个不可清回合撑起（约 30K 字符），另有 2 个可清结果。
  // 每轮只新增 1 个结果 ⇒ ageOut 每轮最多清掉 1 条（keepRecent=2 之外的那条）。
  const h = harness({ window: 37_500, bulkCount: 7, bulkChars: 8000, pendingResults: 3 })
  const seq = []
  for (let i = 0; i < 4; i++) {
    h.addResult()
    const r = await h.compactor.maybeCompact({ system: '', messages: h.messages, outputBudget: 1024 })
    seq.push(r)
  }
  // ① 前几轮必须被识别成"收不动"（而不是被 `cleared>0` 哄成 count-shrink-only）
  const shrinkingOnly = seq.filter((r) => r.reason === 'count-shrink-only').length
  assert.ok(shrinkingOnly <= 1,
    `只清 1 条的会话不得每轮都被判成"有效收缩"（实得 ${shrinkingOnly} 次 count-shrink-only）；`
    + `实际 reasons=${seq.map((r) => r.reason).join(',')}`)
  // ② 计数必须真的累加（这是升级的前提）；一旦到门槛就必须**离开** no-shrink 分支
  const streaks = seq.map((r) => r.noShrinkStreak).filter((v) => typeof v === 'number')
  assert.ok(streaks.length >= 2, `必须至少两次处于 no-shrink 分支（实得 ${JSON.stringify(streaks)}）`)
  assert.ok(Math.max(...streaks) >= 2, `计数必须累加（实得 streaks=${JSON.stringify(streaks)}）`)
  assert.ok(seq.every((r) => r.reason !== 'count-shrink-only' || r.streak === undefined),
    'count-shrink-only 只在**有效收缩**时才返回（那就是清零分支）')
  // ③ 到门槛后必须走摘要链路（本夹具没凭据 ⇒ 表现为 compact-error / no-cut-point，
  //    两者都证明"已经离开 no-shrink 的静默等待"）
  assert.ok(seq.some((r) => r.reason === 'compact-error' || r.reason === 'no-cut-point'),
    `连续收不动必须升级到摘要链路（实得 reasons=${seq.map((r) => r.reason).join(',')}）`)
  rmSync(h.dir, { recursive: true, force: true })
})

test('★ 两维度分别解决才算收口：token 解决 + 条数未超 ⇒ 报 aged（不误升级）', async () => {
  // 夹具：大量可清结果一次性被老化 ⇒ 降幅远超 1%；maxMessages 放宽 ⇒ 条数门本来就不命中。
  // ★ 这里刻意把条数门放开：本用例要单独钉"纯 token 维度收口"的行为。
  //   （两个维度都超时**不该**报 aged —— 那正是 2026-10-19 修掉的那个洞，见上一个用例。）
  const h = harness({ window: 37_500, bulkCount: 7, bulkChars: 8000, pendingResults: 40, maxMessages: 999 })
  const before = estOf(h.messages).total
  const r = await h.compactor.maybeCompact({ system: '', messages: h.messages, outputBudget: 1024 })
  const after = estOf(h.messages).total
  assert.ok(after < before, '前置条件：这轮必须真的清掉了内容（否则本用例不成立）')
  const gain = (before - after) / before
  assert.ok(gain >= 0.01, `前置条件：降幅需 ≥1%（实得 ${(gain * 100).toFixed(2)}%）`)
  assert.equal(r.action, 'aged', '两个维度都满足（token 降下去、条数本来没超）⇒ 应报 aged（不摘要）')
  // 下一轮必须回到"有效收缩"路径（计数已清零 ⇒ 不可能是 no-shrink 分支）
  h.addResult()
  const r2 = await h.compactor.maybeCompact({ system: '', messages: h.messages, outputBudget: 1024 })
  assert.notEqual(r2.reason, 'count-over-no-shrink',
    '真能收敛的会话不得被升级成付费摘要（那是白花钱，违背原设计取舍）')
  rmSync(h.dir, { recursive: true, force: true })
})

test('★ ENG-08 补强：阈值可配（PONOS_COMPACT_SHRINK_MIN_GAIN），且默认保守', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../kernel/compact.mjs', import.meta.url), 'utf8')
  assert.match(src, /PONOS_COMPACT_SHRINK_MIN_GAIN/, '降幅阈值必须可配（不同项目容忍度不同）')
  const m = src.match(/PONOS_COMPACT_SHRINK_MIN_GAIN\s*\?\?\s*([\d.]+)/)
  assert.ok(m, '必须有默认值')
  const def = Number(m[1])
  assert.ok(def > 0 && def <= 0.05, `默认值应在 (0, 5%] 区间（实得 ${def}）—— 取 0 等于退回旧行为，取太大等于每次条数超限都摘要`)
  // 把阈值抬到不可能达到 ⇒ 任何清理都算"收不动"
  // 条数门放开（maxMessages: 999）：让本用例只考察"降幅阈值"这一个变量
  const h = harness({ window: 37_500, bulkCount: 7, bulkChars: 8000, pendingResults: 40, maxMessages: 999, env: { PONOS_COMPACT_SHRINK_MIN_GAIN: '1' } })
  const r = await h.compactor.maybeCompact({ system: '', messages: h.messages, outputBudget: 1024 })
  assert.ok(r.reason !== 'count-shrink-only',
    `阈值抬到 1（100%）后，任何清理都不该被当成有效（实得 reason=${r.reason}）`)
  rmSync(h.dir, { recursive: true, force: true })
})

test('★ ENG-08 补强：清了但压不下去时必须把证据透出来（clearedButTiny / gainRatio）', async () => {
  const h = harness({ window: 37_500, bulkCount: 7, bulkChars: 8000, pendingResults: 3 })
  h.addResult()
  const r = await h.compactor.maybeCompact({ system: '', messages: h.messages, outputBudget: 1024 })
  if (r.reason === 'count-over-no-shrink') {
    // 只有"真清了但降幅不够"的情形才该带这两个字段；纯"没东西可清"不该带（不造证据）
    if (r.clearedButTiny !== undefined) {
      assert.equal(typeof r.gainRatio, 'number', 'clearedButTiny 必须与 gainRatio 成对出现')
      assert.ok(r.gainRatio < 0.01, `既然被判成"收不动"，降幅必然 < 阈值（实得 ${r.gainRatio}）`)
    }
  }
  rmSync(h.dir, { recursive: true, force: true })
})
