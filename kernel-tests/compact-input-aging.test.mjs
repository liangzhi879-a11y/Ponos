// Write/Edit 大 payload 老化（2026-10-19，用户裁决："只清 Write/Edit 的大 payload"）
// ---------------------------------------------------------------------------
// 【为什么做】真实会话实测（4500c736，deriveMessages 1230 条 / est 431478）：
//   可清的 tool_result 只占 33.9%，而 `tool_use.input` 占 59.4% —— 其中 Write/Edit 的
//   正文/替换串是**纯冗余**：工具执行成功那一刻内容已经写到磁盘上了，对话历史里再留一份，
//   每次请求都要为它付 prefill 费用，而它只能回答"我当时写的原文是什么"。
//   Bash 的 input 刻意不动（command 是操作痕迹、是审计与复现依据）。
//   实测收益：老化 tool_result 降 22.8%，再老化 Write/Edit payload 再降 12.7%（合计 32.6%）。
//
// 【本组钉的是"零信息损失"的四个必要前提】——每一条都对应一个真实的失败方式：
//   ① 只清**落地成功**的（写失败时 input 是唯一副本）；
//   ② 保留 `file_path`（回读坐标），且下游 extractKeyInfo / 子 lane 产物登记仍能读到；
//   ③ 保留最近 N 次调用（近期还要接着改）；
//   ④ 幂等（重复老化不重复计数、不反复 bump epoch —— 后者会让估算缓存反复失效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ageOutToolUseInputs, CLEARED_TOOL_INPUT_PREFIX, TOOL_INPUT_AGE_MIN_BYTES, freeShrink,
} from '../kernel/compact.mjs'
import { contentEpoch } from '../kernel/context.mjs'

const big = (n = 2000) => 'x'.repeat(n)

/** 造一条 assistant 的 tool_use 消息 */
const useMsg = (id, name, input) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] })
/** 造一条 user 的 tool_result 消息 */
const resMsg = (id, isError = false) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] })
/**
 * 夹具尾部：一条**收尾 assistant 消息**。
 * ★ 为什么每个夹具都要它：实现有一条工程防线"不碰最后一条 assistant 消息"
 *   （`session.setEntryUsage` 会把那条整行重写回盘，见 compact.mjs 注释）。
 *   只放一个 tool_use 的**最小**夹具里，那条 tool_use 恰好就是"最后一条 assistant"
 *   ⇒ 一个都不会被清 ⇒ 断言会以"实现坏了"的样子失败，实际是夹具没造出"历史"。
 *   这与 tool_result 老化的 `keepRecent` 同源：**老化必须有"更后面"的东西才算历史**。
 */
const tail = () => ({ role: 'assistant', content: [{ type: 'text', text: '收尾' }] })

function harness({ calls = 8, payload = 2000, keepRecent = 2 } = {}) {
  const messages = []
  for (let i = 0; i < calls; i++) {
    messages.push(useMsg(`w${i}`, 'Write', { file_path: `/f${i}.ts`, content: big(payload) }))
    messages.push(resMsg(`w${i}`))
  }
  // 最后一条 assistant 消息（工程防线：不做老化）
  messages.push({ role: 'user', content: '收尾' })
  return { messages, keepRecent }
}

test('★ 只清 Write/Edit 的正文类字段，file_path 一律保留（回读坐标）', () => {
  const { messages, keepRecent } = harness()
  const n = ageOutToolUseInputs(messages, { keepRecent })
  assert.equal(n, 6, `8 次调用保留最近 2 次 ⇒ 应清 6 个（实得 ${n}）`)
  // ① 被清的那个：content 变成带坐标的标记
  const first = messages[0].content[0]
  assert.equal(typeof first.input.content, 'string')
  assert.ok(first.input.content.startsWith(CLEARED_TOOL_INPUT_PREFIX), `content 应被替换为标记：${first.input.content}`)
  assert.equal(first.input.file_path, '/f0.ts', '★ file_path 必须原样保留（模型据此 Read 回读；下游产物登记也读它）')
  assert.match(first.input.content, /\/f0\.ts/, '标记里必须写明文件落点（否则"可回读"只是句空话）')
  assert.match(first.input.content, /Read/, '标记要告诉模型怎么拿回来')
  // ② 保留窗口内的不动
  const kept = messages[(8 - 1) * 2].content[0]
  assert.equal(kept.input.content, big(2000), '最近 2 次调用必须原样保留（近期还要接着改）')
})

test('★ 只清落地成功的：写失败（is_error）或找不到 tool_result ⇒ 一律不清', () => {
  // 三个候选：成功 / 失败 / 孤儿（无 result）
  const messages = [
    useMsg('ok1', 'Write', { file_path: '/a', content: big() }),
    resMsg('ok1', false),
    useMsg('bad1', 'Write', { file_path: '/b', content: big() }),
    resMsg('bad1', true),
    useMsg('orphan', 'Write', { file_path: '/c', content: big() }),
    tail(),
    { role: 'user', content: '收尾' },
  ]
  const n = ageOutToolUseInputs(messages, { keepRecent: 0 })
  assert.equal(n, 1, `只有落地成功的那 1 个可以清（实得 ${n}）`)
  assert.ok(messages[0].content[0].input.content.startsWith(CLEARED_TOOL_INPUT_PREFIX), '成功的那条被清')
  assert.equal(messages[2].content[0].input.content, big(), '★ 写失败时 input 是**唯一**副本 ⇒ 绝不能清')
  assert.equal(messages[4].content[0].input.content, big(), '找不到 tool_result ⇒ 判"未知" ⇒ fail-closed 不清')
})

test('★ 体量门：小于阈值不清（清了只损失精度、省不下钱）', () => {
  const messages = []
  for (let i = 0; i < 4; i++) {
    messages.push(useMsg(`s${i}`, 'Write', { file_path: `/s${i}`, content: 'y'.repeat(500) }))
    messages.push(resMsg(`s${i}`))
  }
  messages.push(tail(), { role: 'user', content: '收尾' })
  assert.equal(ageOutToolUseInputs(messages, { keepRecent: 0 }), 0,
    `500 B < 阈值 ${TOOL_INPUT_AGE_MIN_BYTES} B ⇒ 一个都不清`)
  // 恰好超阈值 ⇒ 清
  const m2 = [useMsg('b', 'Write', { file_path: '/b', content: 'z'.repeat(TOOL_INPUT_AGE_MIN_BYTES + 1) }), resMsg('b'), tail(), { role: 'user', content: 'x' }]
  assert.equal(ageOutToolUseInputs(m2, { keepRecent: 0 }), 1, '超过阈值就该清（边界是 > 不是 >=）')
})

test('★ Edit 同时清 old_string 与 new_string（两者都是"改动已应用"的冗余）', () => {
  const messages = [
    useMsg('e1', 'Edit', { file_path: '/e.ts', old_string: big(1500), new_string: big(1600) }),
    resMsg('e1'),
    tail(),
    { role: 'user', content: '收尾' },
  ]
  assert.equal(ageOutToolUseInputs(messages, { keepRecent: 0 }), 1)
  const inp = messages[0].content[0].input
  assert.ok(inp.old_string.startsWith(CLEARED_TOOL_INPUT_PREFIX), 'old_string 被清')
  assert.ok(inp.new_string.startsWith(CLEARED_TOOL_INPUT_PREFIX), 'new_string 被清')
  assert.equal(inp.file_path, '/e.ts', 'file_path 保留')
  // 标记里的体量是两者之和（否则会报一个偏小的数，读日志的人无法据此判断收益）
  assert.match(inp.old_string, /3100 B/, `体量应是 old+new 合计 3100 B：${inp.old_string}`)
})

test('★ Bash 的 command 一律不动（它是操作痕迹，也是审计与复现依据）', () => {
  const messages = [
    useMsg('b1', 'Bash', { command: 'rm -rf build && npm run build -- --long-flag'.repeat(20) }),
    resMsg('b1'),
    tail(),
    { role: 'user', content: '收尾' },
  ]
  assert.equal(ageOutToolUseInputs(messages, { keepRecent: 0 }), 0, 'Bash 不在清理范围内')
  assert.ok(String(messages[0].content[0].input.command).includes('npm run build'), 'command 必须原样保留')
})

test('★ 幂等：重复老化不重复计数、不反复 bump contentEpoch', () => {
  const { messages, keepRecent } = harness({ calls: 6 })
  const e0 = contentEpoch()
  const n1 = ageOutToolUseInputs(messages, { keepRecent })
  assert.ok(n1 > 0, '前置条件：第一次应清掉东西')
  const e1 = contentEpoch()
  assert.ok(e1 > e0, '★ 原地改写必须 bump 内容纪元（否则估算缓存读到旧值）')
  const n2 = ageOutToolUseInputs(messages, { keepRecent })
  assert.equal(n2, 0, `第二次必须清 0 个（实得 ${n2}）—— 否则每轮都"清一遍"，计数虚高且日志误导`)
  assert.equal(contentEpoch(), e1, '★ 没有真实改写就**不得** bump（反复 bump = 估算缓存反复失效 = 白烧 CPU）')
})

test('★ 幂等靠**标记前缀**兜底，不是靠体量门（minBytes=0 时也成立）', () => {
  // 为什么必须单独钉这一条（变异测试发现的真洞）：把阈值设成 0 时，"标记本身很短"这个
  // 巧合就没了 —— 若幂等只依赖"标记字节 < 阈值"，那么 minBytes=0 会让它每轮被反复重清：
  // 计数虚高、日志误导，还会**反复 bump contentEpoch**（估算缓存反复失效 = 白烧 CPU）。
  // 前缀判据是**结构性**的，与配置无关 —— 这条测试就是为了让它被杀掉时会红。
  const messages = [
    useMsg('z', 'Write', { file_path: '/z', content: big(2000) }),
    resMsg('z'),
    tail(),
    { role: 'user', content: 'x' },
  ]
  assert.equal(ageOutToolUseInputs(messages, { keepRecent: 0, minBytes: 0 }), 1, '第一次清 1 个')
  const e1 = contentEpoch()
  assert.equal(ageOutToolUseInputs(messages, { keepRecent: 0, minBytes: 0 }), 0,
    'minBytes=0 时第二次仍必须清 0 个 —— 靠标记前缀，而不是靠"标记碰巧很短"')
  assert.equal(contentEpoch(), e1, '没有真实改写就不得 bump')
})

test('★ 工程防线：不碰最后一条 assistant 消息（setEntryUsage 会把那条整行重写回盘）', () => {
  const messages = [
    useMsg('old', 'Write', { file_path: '/old', content: big() }),
    resMsg('old'),
  ]
  // 最后一条 assistant 消息本身带一个大 Write（keepRecent=0 放开窗口门）
  messages.push(useMsg('last', 'Write', { file_path: '/last', content: big() }))
  messages.push(resMsg('last'))
  const n = ageOutToolUseInputs(messages, { keepRecent: 0 })
  assert.equal(n, 1, `只应清掉非最后那条（实得 ${n}）`)
  assert.ok(messages[0].content[0].input.content.startsWith(CLEARED_TOOL_INPUT_PREFIX), '历史那条被清')
  assert.equal(messages[2].content[0].input.content, big(), '★ 最后一条 assistant 一律不动 —— 那条会被 setEntryUsage 整行回写落盘')
})

test('★ freeShrink 把 agedInputs 单独回报（不与 cleared 混成一个数）', () => {
  const messages = [
    useMsg('w', 'Write', { file_path: '/w', content: big() }),
    resMsg('w'),
    tail(),
    { role: 'user', content: '收尾' },
  ]
  const r = freeShrink(messages, { window: 200_000, env: { PONOS_TOOL_INPUT_KEEP_RECENT: '0' }, age: true })
  assert.equal(typeof r.agedInputs, 'number', '必须回报 agedInputs')
  assert.equal(r.agedInputs, 1, `应清 1 个 payload（实得 ${r.agedInputs}）`)
  assert.equal(r.cleared, 0, '本例没有可重放 tool_result ⇒ cleared 必须是 0（两个数各自独立）')
  // age=false 时两个都不动作（同一个门）
  const m2 = [useMsg('w2', 'Write', { file_path: '/w2', content: big() }), resMsg('w2'), tail(), { role: 'user', content: 'x' }]
  const r2 = freeShrink(m2, { window: 200_000, env: { PONOS_TOOL_INPUT_KEEP_RECENT: '0' }, age: false })
  assert.equal(r2.agedInputs, 0, 'age=false ⇒ 不老化（与 tool_result 老化同一个门）')
  assert.equal(m2[0].content[0].input.content, big(), '内容必须原样')
})

test('★ 边界：空/脏输入不抛（messages 非数组、input 缺失、字段非字符串）', () => {
  assert.equal(ageOutToolUseInputs(null), 0)
  assert.equal(ageOutToolUseInputs([]), 0)
  const m = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Write' }] },                    // 无 input
    { role: 'assistant', content: [{ type: 'tool_use', id: 'y', name: 'Write', input: { content: 42 } }] }, // 非字符串
    { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { content: big() } }] },  // 无 id
    tail(),
    { role: 'user', content: 'x' },
  ]
  assert.equal(ageOutToolUseInputs(m, { keepRecent: 0 }), 0, '脏输入一律跳过，不抛也不误清')
})
