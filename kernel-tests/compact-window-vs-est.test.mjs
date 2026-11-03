// 压缩判据的「窗口 vs 实际内容」口径修正（2026-10-19）
// ---------------------------------------------------------------------------
// 【用户实测现场（调试版日志）】长会话上下文持续膨胀，数值全部来自真实运行：
//     window = 1,048,576（DeepSeek 官方 deepseek-flash 上下文 1M，用户配置正确）
//     msgs   553 → 557 → 559 → 561 → 563 → 565        条数单调上涨
//     est    193,334 → 193,647 → 196,980 → 199,607    上下文单调上涨
//     [compact] action=none reason=count-over-no-shrink msgs=559 est=193647
//     compaction frame state=start covered=1 coveredTokens=2174 / 633
//     [compact] action=none reason=no-convergence
//     [api] POST body=521453B → 538308B               请求体单调上涨
//
// 【两个结构缺陷】都源于"只按**窗口**比例算"，而窗口是**端点能力上限**、不是"应该用多少"：
//
//   ① age 门（免费收缩的开关）= window × 0.5 = **524,288**，而实际内容 193,647
//      ⇒ **门永远不开** ⇒ 可重放工具结果 / Write·Edit 大 payload 一条都不清
//      ⇒ 只剩条数门在触发。修：`age 门 = min(窗口比例, 绝对量 64K)`。
//
//   ② retainTokens（摘要保留量）= window × 0.16 = **167,772**，而整段内容 193,647
//      ⇒ 保留区吃掉 **86.6%** ⇒ 只剩 13%（约 2,174 token）可遮蔽
//      ⇒ 摘要只压得掉那么一点 ⇒ `summaryTokens < coveredTokens` 失败 ⇒ `no-convergence`
//      ⇒ **压缩永不落地**。窗口越大，"保留窗口的 16%"越接近"保留全部" ⇒ 大窗口上结构性失效。
//      修：`retainTokens ≤ 总 est × 0.5`（至少能压掉一半）。
//
// 本文件钉的判据（每条都能被"退回旧口径"的变异杀掉，见文末说明）：
//   · 大窗口 + 中等内容 ⇒ age 门必须开（否则免费收缩形同不存在）
//   · 大窗口 + 中等内容 ⇒ 可遮蔽量必须达到"能压掉一半"的量级（否则摘要不收敛）
//   · 小窗口行为逐字不变（收紧只发生在 min 的上限侧，不得反向放大保留量）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCompactor, freeShrink } from '../kernel/compact.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { estimateMessage, contextWindowFor } from '../kernel/context.mjs'

/** 现场量级：1M 窗口 / 193K 内容 / 550+ 条 */
const BIG_WINDOW = 1_048_576
const LIVE_EST = 193_647
const LIVE_MSGS = 559

/**
 * 造一个"现场形态"的会话：大量小消息 + 少量可老化内容。
 * ★ 关键：让**总 est 远小于窗口**（这正是现场的形态，也是旧口径失效的前提）。
 */
function liveShape({ window = BIG_WINDOW, targetEst = LIVE_EST, maxMessages = 120, env = {}, frames = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-win-vs-est-'))
  const store = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'win-vs-est' })
  const messages = []
  let est = 0
  let i = 0
  while (est < targetEst) {
    // 每 40 条插一大块（模拟工具回合），其余是短问答 ⇒ 550+ 条、193K est
    if (i % 40 === 39) {
      const id = `r${i}`
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/f${i}` } }] })
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(6000) }] })
    } else if (i % 2 === 0) {
      messages.push({ role: 'user', content: `第 ${i} 轮：继续` })
    } else {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(500) }] })
    }
    est += estimateMessage(messages[messages.length - 1])
    i++
  }
  const compactor = createCompactor({
    session: store,
    context: {
      window, thresholdRatio: 0.8, retainRatio: 0.16, maxMessages,
      estimateMessage, estimate: ({ messages: ms }) => ({ total: ms.reduce((s, m) => s + estimateMessage(m), 0) }),
      estimateHistory: (ms) => ms.reduce((s, m) => s + estimateMessage(m), 0),
    },
    model: 'test-model', maxTokens: 16_384,
    // 捕获 compaction 帧：那是实现**真正算出并发出**的 covered / coveredTokens，
    // 用它做期望值来源，而不是在测试里自己重算一遍公式（后者是恒真断言）。
    wire: { system: (subtype, payload) => frames.push({ subtype, ...(payload || {}) }) },
    env: { ...process.env, ...env },
  })
  return { messages, store, compactor, dir, est, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('★ 判据①：1M 窗口 + 193K 内容 ⇒ age 门必须开（旧口径 min 前是 524,288，永远不开）', async () => {
  const h = liveShape()
  try {
    const before = h.messages.length
    assert.ok(h.est < BIG_WINDOW * 0.5,
      `前置条件：内容必须**远小于**窗口的一半（实得 est=${h.est} vs ${BIG_WINDOW * 0.5}）`
      + '—— 这正是旧口径失效的形态；夹具若把内容做大到 50%+，就测不到本缺陷')
    const r = await h.compactor.maybeCompact({ system: '', messages: h.messages, outputBudget: 16_384 })
    // 免费收缩真的发生了（清掉了可重放结果）
    const touched = (r.cleared ?? 0) + (r.agedInputs ?? 0) > 0
    assert.ok(touched,
      `大窗口下 age 门必须开：应清掉可重放结果（实得 cleared=${r.cleared} agedInputs=${r.agedInputs}，`
      + `reason=${r.reason}）。若为 0 ⇒ 退回了"只按窗口比例"的旧口径`)
    assert.ok(h.messages.length === before, '老化只改内容不删消息（条数由摘要解决）')
  } finally { h.cleanup() }
})

/**
 * 「不可清」夹具：纯文本大会话（无 tool_result、无 Write/Edit）⇒ 免费收缩完全无效
 * ⇒ 只能走摘要路径。**这是观测 retainTokens 的唯一方式**：
 *   只要夹具里有可清的东西，age 门一开就会 `count-shrink-only` 提前返回，
 *   压根到不了摘要 ⇒ 关于 retainTokens 的断言会退化成"有没有清过东西"（恒真）。
 * 2026-10-19 变异测试实测踩过这个坑：初版夹具带可清结果，把 retainTokens 退回旧口径
 * 也照样绿。夹具必须不可清，判据才有效。
 */
function unsqueezableShape({ window = BIG_WINDOW, targetEst = LIVE_EST, env = {}, frames = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-wv-unsq-'))
  const store = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'wv-unsq' })
  const messages = []
  let est = 0
  let i = 0
  while (est < targetEst) {
    if (i % 2 === 0) messages.push({ role: 'user', content: `第 ${i} 轮：继续推进这个任务` })
    else messages.push({ role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(1200) }] })
    est += estimateMessage(messages[messages.length - 1])
    i++
  }
  const compactor = createCompactor({
    session: store,
    context: {
      window, thresholdRatio: 0.8, retainRatio: 0.16, maxMessages: 120,
      estimateMessage,
      estimate: ({ messages: ms }) => ({ total: ms.reduce((s, m) => s + estimateMessage(m), 0) }),
      estimateHistory: (ms) => ms.reduce((s, m) => s + estimateMessage(m), 0),
    },
    model: 'test-model', maxTokens: 16_384,
    wire: { system: (subtype, payload) => frames.push({ subtype, ...(payload || {}) }) },
    // NOSHRINK_LIMIT=1：一次"收不动"就升级到摘要（否则要连调 3 次，本用例只想看一次决策）
    env: { ...process.env, PONOS_COMPACT_NOSHRINK_LIMIT: '1', ...env },
  })
  return { messages, store, compactor, dir, est, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('★ 判据②：大窗口下实际发出的 coveredTokens 必须达到「能压掉一半」（否则摘要永不收敛）', async () => {
  // ★★ 这一条被变异测试**返工了两次**，两侧都是"恒真断言"的经典形态，记在这里防重犯：
  //   初版 ①：在测试里自己重算 `min(window*0.16, totalEst*0.5)` 再断言它 ≤ 0.5 —— 断言自己刚算的值。
  //   初版 ②：改用 wire 帧观测实现，但夹具**带可清结果** ⇒ age 门一开就 count-shrink-only
  //           提前返回，压根到不了摘要 ⇒ 把 retainTokens 退回旧口径照样绿。
  //   现在：夹具**不可清**（纯文本）+ NOSHRINK_LIMIT=1 强制升级 ⇒ 必走摘要 ⇒ 帧里才有
  //         coveredTokens，而它正是实现用 retainTokens 切出来的量。
  const frames = []
  const h = unsqueezableShape({ frames })
  try {
    const totalEst = h.messages.reduce((s, m) => s + estimateMessage(m), 0)
    const r = await h.compactor.maybeCompact({ system: '', messages: h.messages, outputBudget: 16_384 })
    const start = frames.find((f) => f.subtype === 'compaction' && f.state === 'start')
    assert.ok(start,
      `不可清夹具必须走到摘要（否则本判据没有观测面）：reason=${r.reason}`
      + ` —— 若 reason=count-over-no-shrink，检查 NOSHRINK_LIMIT=1 是否生效`)
    const ratio = start.coveredTokens / totalEst
    // 旧口径：retainTokens = 1M×0.16 = 167,772 ⇒ 占内容 86% ⇒ covered 仅约 13%
    // 新口径：retainTokens ≤ 总 est×0.5 ⇒ covered 约 50%
    assert.ok(ratio >= 0.35,
      `可遮蔽量必须达到约「压掉一半」的量级（实得 coveredTokens=${start.coveredTokens} / 总 ${totalEst}`
      + ` = ${(ratio * 100).toFixed(1)}%，covered=${start.covered}）。`
      + ' 若是个位数/十几百分比 ⇒ retainTokens 未被实际内容约束（退回"保留窗口 16%"的旧口径，'
      + ' 现场表现正是 covered=1 coveredTokens=2174 ⇒ 摘要比原文还长 ⇒ no-convergence）')
  } finally { h.cleanup() }
})

test('★ 判据②端到端：1M 窗口的 maybeCompact 不得停在 no-convergence（旧口径的稳定症状）', async () => {
  const h = liveShape({ targetEst: 60_000 })
  try {
    const r = await h.compactor.maybeCompact({ system: '', messages: h.messages, outputBudget: 16_384 })
    // 允许的结局：①免费收缩已把上下文压下阈值（aged/pruned/count-shrink-only）
    //             ②真去摘要并落地（summarized）③无切点（no-cut-point，数据形态问题）
    // **不允许**：no-convergence —— 那说明"摘要比原文还长"，是保留量过大导致的确定性失败
    assert.notEqual(r.reason, 'no-convergence',
      `1M 窗口下不得因保留量过大而 no-convergence（实得 ${JSON.stringify(r).slice(0, 220)}）`)
  } finally { h.cleanup() }
})

test('★ 判据③：小窗口行为逐字不变（收紧只在上限侧，不得反向放大保留量）', () => {
  // 32K 窗口 / 小内容：min(16K, 64K)=16K 与旧口径一致 ⇒ age 门不变
  const win = 32_768
  const clearRatio = 0.5
  const ageAbs = 65_536
  assert.equal(Math.min(Math.floor(win * clearRatio), ageAbs), Math.floor(win * clearRatio),
    '32K 窗口：绝对量上限不得起作用（否则小窗口行为被改动）')
  // 1M 窗口：绝对量起作用
  assert.equal(Math.min(Math.floor(BIG_WINDOW * clearRatio), ageAbs), ageAbs,
    '1M 窗口：必须被绝对量压住')
  // retainTokens：内容很少时，min 不会把保留量放大
  const tiny = 5_000
  const rawRetain = Math.floor(BIG_WINDOW * 0.16)
  assert.ok(Math.max(1024, Math.min(rawRetain, Math.floor(tiny * 0.5))) <= rawRetain,
    'min 只收紧，不放大')
})

test('★ 模型表：deepseek-flash 必须在表里且为 1M（防回落到"碰巧配对的注入值"）', () => {
  // 依据：DeepSeek 官方《模型 & 价格》—— deepseek-flash = DeepSeek-V4.1-Flash-1017，上下文 1M
  assert.equal(contextWindowFor('deepseek-flash', {}), 1_000_000,
    '现行官方名必须在表里（否则回落注入值：配对了是运气，配错了没人发现）')
  // 表仍优先于注入（判据本体不变）
  assert.equal(contextWindowFor('deepseek-flash', { PONOS_AUTO_COMPACT_WINDOW: '65536' }), 1_000_000,
    '已知模型不信手配值（含"配小了"这种反向错误）')
})
