// M4：评审在生成循环里的**时序与预算**（全部用假模型，不碰网络）。
// 这批用例是"质量控制改由 LLM 评估"的落地凭证：评审何时被调用、gaps 何时触发补全、
// 预算不足时如何降级、补全失败时交付哪一版——这些用真模型根本没法稳定验证。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { runAgentLoop } = require('../electron/app-agent.cjs')

const TARGET = { type: 'web', url: 'https://example.com/' }
const specWith = (n, tag) => ({
  specVersion: 1, appId: 'x', name: '示例站', target: TARGET, expose: { mode: 'console' },
  commands: Array.from({ length: n }, (_, i) => ({
    action: `listItems${tag}${i}`, title: `查询条目${tag}${i}`, kind: 'read', params: [],
    steps: [{ act: 'js', expression: `await fetch('/api/items/${tag}${i}').then(r=>r.json())`, save: 'result' }],
    returns: { type: 'json', from: 'result' },
  })),
})
const submit = (spec) => JSON.stringify({ thought: '写完了', tool: 'submit_spec', spec })
const reviewJson = (gaps) => JSON.stringify({ verdict: gaps.length ? 'thin' : 'ok', gaps, notes: '评审完成' })
/**
 * 评审轮的判别标记：取 `reviewInstruction` 的**开头**，而不是笼统的"交付前评审"——
 * M4-2 的 `reviewFeedbackLines` 回喂进日志的表头是「【交付前评审：发现覆盖缺口…】」，
 * 笼统匹配会把**补全轮**误判成评审轮（补全轮的 user 里带着这段日志），于是同一次生成
 * 会被数成"评审了 4 次"，断言「评审只追加一次」就永远失败——那是判别式的错，不是实现的错。
 */
const REVIEW_MARK = '现在做一次交付前评审'

/** 假模型：按用户消息内容区分"普通轮"与"评审轮"，并记录每次调用 */
function fakeLlm({ turns }) {
  const calls = []
  const fn = async (p) => {
    calls.push(p)
    const isReview = String(p.user).includes(REVIEW_MARK)
    const text = isReview ? reviewJson(turns.reviewGaps || []) : turns.next()
    return { ok: true, text, error: null, chars: text.length }
  }
  fn.calls = calls
  fn.reviewCalls = () => calls.filter((c) => String(c.user).includes(REVIEW_MARK))
  return fn
}

test('★ 评审发现 gaps → 追加一轮补全 → 补全后的 Spec 通过试跑并作为交付物', async () => {
  const turns = { reviewGaps: [{ what: '缺"按日期筛选订单"', why: '用户需求点没被覆盖', hint: 'listOrders 加 dateFrom 参数' }] }
  let n = 0
  const llm = fakeLlm({ turns: { ...turns, next: () => (n++ === 0 ? submit(specWith(2, 'A')) : submit(specWith(3, 'B'))) } })
  const r = await runAgentLoop({
    target: TARGET, driver: 'browser', probeMode: 'http', probeMaterial: { title: 'T' },
    requirement: ['导出全部订单，支持按日期筛选'],
    callLlm: llm,
    runTool: async () => ({ ok: true, summary: 'ok' }),
    verify: async () => ({ ok: true, tried: ['listItemsA0'], failures: [] }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.equal(llm.reviewCalls().length, 1, '评审只追加一次（不重复评审）')
  assert.equal(llm.calls.length, 3, '两次生成 + 一次评审')
  assert.equal(r.review.gaps.length, 1)
  assert.equal(r.review.applied, true)
  assert.equal(r.review.outcome, 'refined')
  assert.deepEqual(r.spec.commands.map((c) => c.action), ['listItemsB0', 'listItemsB1', 'listItemsB2'], '交付的是补全后的版本')
  assert.ok(llm.reviewCalls()[0].user.includes('交付前评审'), '评审指令在 user 尾部')
  assert.ok(llm.calls[2].user.includes('缺"按日期筛选订单"'), 'gaps 作为反馈回喂给补全轮')
  assert.equal(r.spec.review.applied, true, '评审结论写进 Spec（后续可见）')
})

test('★ 评审给出 ok（无 gaps）→ 不补全，直接交付（省一轮预算）', async () => {
  const llm = fakeLlm({ turns: { reviewGaps: [], next: () => submit(specWith(2, 'A')) } })
  const r = await runAgentLoop({
    target: TARGET, driver: 'browser', probeMode: 'http', probeMaterial: { title: 'T' },
    callLlm: llm, runTool: async () => ({ ok: true, summary: 'ok' }),
    verify: async () => ({ ok: true, tried: [], failures: [] }),
  })
  assert.equal(llm.reviewCalls().length, 1)
  assert.equal(llm.calls.length, 2, '生成 1 次 + 评审 1 次')
  assert.equal(r.review.outcome, 'no-gaps')
  assert.deepEqual(r.review.gaps, [])
  assert.equal(r.spec.review.applied, false)
})

test('★ 评审输出解析不了 → 降级：不补全、交付原 Spec、如实记 warning', async () => {
  const llm = async (p) => {
    const isReview = String(p.user).includes(REVIEW_MARK)
    return { ok: true, text: isReview ? '我看还行' : submit(specWith(2, 'A')), chars: 10 }
  }
  llm.calls = []
  const r = await runAgentLoop({
    target: TARGET, driver: 'browser', probeMode: 'http', probeMaterial: { title: 'T' },
    callLlm: async (p) => { llm.calls.push(p); return llm(p) },
    runTool: async () => ({ ok: true, summary: 'ok' }),
    verify: async () => ({ ok: true, tried: [], failures: [] }),
  })
  assert.equal(r.ok, true, '评审失败不许毁掉交付')
  assert.equal(r.review.outcome, 'review-failed')
  assert.ok(r.warnings.some((w) => w.includes('无法解析')), r.warnings.join('｜'))
  assert.equal(llm.calls.length, 2, '解析失败不再追加补全轮')
})

test('★ 补全轮没通过试跑 → 交付上一版试跑全通过的 Spec（不许越补越差）', async () => {
  let n = 0
  const llm = fakeLlm({ turns: { reviewGaps: [{ what: '缺导出命令', why: '', hint: '' }], next: () => (n++ === 0 ? submit(specWith(2, 'A')) : submit(specWith(3, 'B'))) } })
  let verifyRound = 0
  const r = await runAgentLoop({
    target: TARGET, driver: 'browser', probeMode: 'http', probeMaterial: { title: 'T' },
    callLlm: llm, runTool: async () => ({ ok: true, summary: 'ok' }),
    verify: async () => (++verifyRound === 1
      ? { ok: true, tried: ['listItemsA0'], failures: [] }
      : { ok: false, tried: ['listItemsB0'], failures: [{ action: 'listItemsB0', error: '接口 404' }] }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.review.outcome, 'refine-failed')
  assert.deepEqual(r.spec.commands.map((c) => c.action), ['listItemsA0', 'listItemsA1'], '兜底交付上一版通过的产物')
  assert.ok(r.warnings.some((w) => w.includes('补全轮')), r.warnings.join('｜'))
})

test('★ 轮次预算不足（剩余 < 2 轮）→ 整段跳过评审，不追加任何调用', async () => {
  const llm = fakeLlm({ turns: { reviewGaps: [{ what: '缺 X', why: '', hint: '' }], next: () => submit(specWith(2, 'A')) } })
  const r = await runAgentLoop({
    target: TARGET, driver: 'browser', probeMode: 'http', probeMaterial: { title: 'T' },
    budget: { maxTurns: 3, maxToolCalls: 5 },     // 生成用 1 轮 → 剩 2 轮，但补全也要 1 轮 ⇒ 2 ≥ 2 恰好够
    callLlm: llm, runTool: async () => ({ ok: true, summary: 'ok' }),
    verify: async () => ({ ok: true, tried: [], failures: [] }),
  })
  // 恰好够：评审 1 轮 + 补全 1 轮，总调用 = 1（生成）+1（评审）+1（补全）
  assert.equal(llm.calls.length, 3)
  assert.equal(r.turns, 3, '评审与补全都计入轮次账（不许预算外烧钱）')

  const llm2 = fakeLlm({ turns: { reviewGaps: [], next: () => submit(specWith(2, 'A')) } })
  const r2 = await runAgentLoop({
    target: TARGET, driver: 'browser', probeMode: 'http', probeMaterial: { title: 'T' },
    budget: { maxTurns: 2, maxToolCalls: 5 },     // 生成 1 轮 → 剩 1 轮 < 2 ⇒ 跳过评审
    callLlm: llm2, runTool: async () => ({ ok: true, summary: 'ok' }),
    verify: async () => ({ ok: true, tried: [], failures: [] }),
  })
  assert.equal(llm2.reviewCalls().length, 0, '轮次不够就不评审（宁可少一次评审，也不透支预算）')
  assert.equal(r2.review.outcome, 'skipped-budget')
  assert.equal(r2.review.applied, false)
  assert.ok(r2.warnings.some((w) => w.includes('跳过')), r2.warnings.join('｜'))
  assert.equal(JSON.stringify(r2.spec).includes('"review"'), true, '跳过也要如实记进 Spec（用户能看出"这次没评审"）')
})

test('★ 时间预算不足（剩余 < 60s）→ 同样跳过评审', async () => {
  const llm = fakeLlm({ turns: { reviewGaps: [], next: () => submit(specWith(2, 'A')) } })
  const r = await runAgentLoop({
    target: TARGET, driver: 'browser', probeMode: 'http', probeMaterial: { title: 'T' },
    budget: { timeBudgetMs: 30000 },               // 30s < 60s 余量 ⇒ 跳过
    callLlm: llm, runTool: async () => ({ ok: true, summary: 'ok' }),
    verify: async () => ({ ok: true, tried: [], failures: [] }),
  })
  assert.equal(llm.reviewCalls().length, 0)
  assert.equal(r.review.outcome, 'skipped-budget')
})

test('★ 没通过试跑的路径不评审（评审的前提是"有可交付的产物"）', async () => {
  const llm = fakeLlm({ turns: { reviewGaps: [{ what: '缺 X', why: '', hint: '' }], next: () => submit(specWith(2, 'A')) } })
  const r = await runAgentLoop({
    target: TARGET, driver: 'browser', probeMode: 'http', probeMaterial: { title: 'T' },
    budget: { maxTurns: 2 },
    callLlm: llm, runTool: async () => ({ ok: true, summary: 'ok' }),
    verify: async () => ({ ok: false, tried: ['listItemsA0'], failures: [{ action: 'listItemsA0', error: '接口 500' }] }),
  })
  assert.equal(llm.reviewCalls().length, 0)
  assert.equal(r.review, null)
})

test('★ IPC：app:generate 的返回值带上 review（界面/后续可见）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'appreview-ipc-'))
  process.env.YFWORKING_HOME = home
  delete process.env.CLAUDE_CONFIG_DIR
  const require2 = require
  const handlers = new Map()
  let calls = 0
  require('../electron/app-ipc.cjs').registerAppHandlers({
    ipcMain: { handle: (c, f) => handlers.set(c, f) },
    getExecutor: () => ({ exec: async (_sid, act) => (act === 'snapshot' ? { ok: true, snapshot: { page: { url: TARGET.url, title: 'T' }, interactives: [] } } : { ok: true }) }),
    getWebContents: () => ({ send: () => {} }),
    deps: {
      fetchImpl: async () => ({ ok: true, text: async () => '<html><head><title>T</title></head><body><a href="/a">A</a></body></html>' }),
      callLlm: async (p) => {
        calls++
        const isReview = String(p.user).includes(REVIEW_MARK)
        const text = isReview
          ? JSON.stringify({ verdict: 'thin', gaps: [{ what: '缺导出命令', why: '需求未覆盖', hint: '加一条导出命令' }], notes: 'n' })
          : JSON.stringify({ thought: 'ok', tool: 'submit_spec', spec: specWith(2, 'A') })
        return { ok: true, text, error: null, chars: text.length }
      },
    },
  })
  const r = await handlers.get('app:generate')({}, { target: { type: 'web', url: 'https://example.com/' }, appId: 'rv' })
  assert.equal(r.ok, true, r.error || '')
  // 3 次 = 生成 1 次 + 评审 1 次 + 补全 1 次（评审给出了 gaps ⇒ 必然触发一次补全轮；
  // 补全轮提交的还是同一份 Spec，仍会过校验。与用例 1 的计数口径一致。）
  assert.equal(calls, 3, '一次生成 + 一次评审 + 一轮补全（补全轮由假模型返回同一份 Spec，仍应过校验）')
  assert.ok(r.review && Array.isArray(r.review.gaps), `返回值要带 review：${JSON.stringify(r.review)}`)
  assert.equal(r.spec.review.gaps.length, 1)
  try { rmSync(home, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
})
