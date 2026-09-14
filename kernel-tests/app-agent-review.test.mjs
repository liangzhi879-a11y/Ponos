// M4：交付前评审的纯函数层。评审是"质量结论的唯一来源"，所以两件事必须钉死：
//   ① 稳健解析（模型输出是自由文本：带代码块、带解释、甚至只写了一段话，都不能把生成搞崩）；
//   ② 解析失败时**降级**（不触发补全、如实记录），而不是抛异常或假装评审通过。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  parseReview, reviewInstruction, reviewFeedbackLines, reviewSpec, REVIEW_RESERVE_TURNS, REVIEW_MIN_REMAINING_MS,
} = require('../electron/app-agent.cjs')

test('parseReview：标准 JSON → 结构化结论（gaps 逐条结构化）', () => {
  const r = parseReview(JSON.stringify({
    verdict: 'thin',
    gaps: [{ what: '缺"按日期筛选订单"', why: '用户需求点没被任何命令覆盖', hint: '给 listOrders 加 query 参数 dateFrom' }],
    notes: '整体可用但漏了筛选',
  }))
  assert.equal(r.parseFailed, false)
  assert.equal(r.verdict, 'thin')
  assert.deepEqual(r.gaps, [{ what: '缺"按日期筛选订单"', why: '用户需求点没被任何命令覆盖', hint: '给 listOrders 加 query 参数 dateFrom' }])
  assert.equal(r.notes, '整体可用但漏了筛选')
})

test('parseReview：容忍代码块 / 前后解释文字 / 字符串形式的 gaps', () => {
  const fenced = parseReview('我的评审如下：\n```json\n{"verdict":"thin","gaps":["缺导出的命令"]}\n```\n以上。')
  assert.equal(fenced.verdict, 'thin')
  assert.deepEqual(fenced.gaps, [{ what: '缺导出的命令', why: '', hint: '' }])
})

test('parseReview：gaps 为空 ⇒ verdict 归 ok（不因为模型没填 verdict 就触发补全）', () => {
  assert.equal(parseReview('{"notes":"覆盖到位"}').verdict, 'ok')
  assert.deepEqual(parseReview('{"notes":"覆盖到位"}').gaps, [])
})

test('★ parseReview：解析不了 ⇒ 降级为 ok + parseFailed（不许抛、不许靠猜触发补全）', () => {
  const r = parseReview('我觉得还行吧，没什么大问题')
  assert.equal(r.parseFailed, true)
  assert.equal(r.verdict, 'ok')
  assert.deepEqual(r.gaps, [])
  assert.ok(r.notes.includes('无法解析'), r.notes)
})

test('reviewInstruction：有需求时逐条核对覆盖度；无需求时对着目标自身核对', () => {
  const withReq = reviewInstruction(['导出全部图层', '批量重命名'])
  assert.ok(withReq.includes('导出全部图层') && withReq.includes('批量重命名'), withReq)
  assert.ok(withReq.includes('交付前评审'), withReq)
  assert.ok(/JSON/.test(withReq), '要明确输出 JSON 契约')
  const noReq = reviewInstruction([])
  assert.ok(!noReq.includes('【用户需求】'), '无需求不编需求段')
  assert.ok(noReq.includes('目标'), noReq)
})

test('★ reviewFeedbackLines：把 gaps 变成"可执行的补齐要求"，并明确不许推翻已通过部分', () => {
  const text = reviewFeedbackLines({ gaps: [{ what: '缺按日期筛选', why: '需求点未覆盖', hint: 'listOrders 加 dateFrom' }] })
  assert.ok(text.includes('缺按日期筛选') && text.includes('需求点未覆盖') && text.includes('dateFrom'), text)
  assert.ok(text.includes('不要推翻'), '要防止模型借补全把已试跑通过的部分重写一遍')
})

test('reviewSpec：把同一份上下文尾部追加评审指令后调用模型（同会话语义）', async () => {
  const calls = []
  const r = await reviewSpec({
    system: 'SYS',
    userPrefix: 'SEED\n\n【工具】…历史…',
    requirement: ['导出全部图层'],
    callLlm: async (p) => { calls.push(p); return { ok: true, text: '{"verdict":"ok","gaps":[]}', chars: 24 } },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].system, 'SYS', 'system 不变（同一次会话的同一套规则）')
  assert.ok(calls[0].user.startsWith('SEED'), '上下文前缀原样保留（上下文完整是这一轮的价值）')
  assert.ok(calls[0].user.includes('交付前评审'))
  assert.equal(r.ok, true)
  assert.equal(r.verdict, 'ok')
})

test('reviewSpec：模型调用失败 ⇒ 如实记原因、不触发补全（评审只是辅助，不能毁掉交付）', async () => {
  const r = await reviewSpec({ system: 'S', userPrefix: 'U', requirement: [], callLlm: async () => ({ ok: false, error: 'provider 429' }) })
  assert.equal(r.ok, false)
  assert.deepEqual(r.gaps, [])
  assert.ok(r.notes.includes('429'), r.notes)
})

test('预算常量：评审 + 补全各占 1 轮，且需要至少 60s 余量（明确取值，便于验收）', () => {
  assert.equal(REVIEW_RESERVE_TURNS, 2)
  assert.equal(REVIEW_MIN_REMAINING_MS, 60000)
})
