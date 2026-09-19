// 孤儿 tool_use 补丁的位置语义（2026-09-19 实况回归）。
//
// Anthropic 的硬约束是**消息级**的：assistant 消息里的**每一个** tool_use，都必须被
// **紧邻的下一条**消息里的 tool_result 回答（"tool_result blocks immediately after"）。
// 2026-09-10 的旧补丁只满足"每个孤儿各有一条结果紧跟其后"，于是并行批次补成
// assistant(use0,use1) → user(→use1) → user(→use0)——use0 的结果被挤到第二位，
// 请求依旧 400（报错点名的正是 call_00），用户"重启该会话"也无效：每次重试都重新补成
// 同一个非法形状。
//
// 本文件锁四件事：
//   1) 同一 assistant 消息的多个孤儿 → **合成一条** user 消息，块序与 tool_use 一致；
//   2) 紧邻的下一条已是 user 消息时 → **并入**它，而不是另插一条（否则把该消息里
//      已有的 tool_result 挤到第二位，犯同一约束的另一半）；
//   3) 尾部孤儿（无下一条）/ 连续 assistant → 才插新消息，且必须插在被回答消息之后；
//   4) 无孤儿时**元素身份不变**（K1.1 的估算记忆化靠它整段命中，别改成克隆）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
const { patchOrphanToolUses } = await import('../kernel/engine.mjs')

const use = (id) => ({ type: 'tool_use', id, name: 'Read', input: {} })
const res = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })

/** 直接断言 API 硬约束本身（比断言"插了几条"更贴近真因） */
function assertChainValid(msgs, label = '') {
  const bad = []
  msgs.forEach((m, i) => {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) return
    const uses = m.content.filter((b) => b?.type === 'tool_use')
    if (!uses.length) return
    const answered = new Set(
      (Array.isArray(msgs[i + 1]?.content) ? msgs[i + 1].content : [])
        .filter((b) => b?.type === 'tool_result')
        .map((b) => b.tool_use_id),
    )
    for (const u of uses) if (!answered.has(u.id)) bad.push(`${label}[#${i}] ${u.id}`)
  })
  assert.deepEqual(bad, [], `以下 tool_use 未被紧邻的下一条消息回答：${bad.join('、')}`)
}

test('多孤儿合一条：并行批次的两个 tool_use 必须被同一条消息回答（旧实现补成两条 ⇒ 400）', () => {
  const msgs = [
    { role: 'user', content: '开始' },
    { role: 'assistant', content: [{ type: 'text', text: '我并行读两个文件' }, use('call_00'), use('call_01')] },
  ]
  const out = patchOrphanToolUses(msgs)
  assertChainValid(out, 'case1')
  assert.equal(out.length, msgs.length + 1, '只应新增 1 条消息，不是每条孤儿各一条')
  const next = out[2]
  assert.equal(next.role, 'user')
  const ids = next.content.map((b) => b.tool_use_id)
  assert.deepEqual(ids, ['call_00', 'call_01'], '块序必须与 tool_use 一致')
  assert.ok(next.content.every((b) => b.is_error === true && b.type === 'tool_result'))
})

test('用户抢发的"继续"不被吞：另插一条补丁消息，纯文本用户消息原样留在其后', () => {
  // 实况形状：seq=16 assistant 两个工具调用未落结果，用户已发了两条"继续"
  const msgs = [
    { role: 'user', content: '开始' },
    { role: 'assistant', content: [use('call_00'), use('call_01')] },
    { role: 'user', content: '继续' },
    { role: 'user', content: '继续' },
  ]
  const out = patchOrphanToolUses(msgs)
  assertChainValid(out, 'case2')
  assert.equal(out.length, msgs.length + 1, '下一条无结果 ⇒ 插一条，不并入用户消息')
  const next = out[2]
  assert.deepEqual(next.content.map((b) => b.tool_use_id), ['call_00', 'call_01'])
  assert.equal(out[3], msgs[2], '用户消息原样推原对象（身份不变）')
  assert.equal(out[4], msgs[3])
})

test('部分回答的批次：缺的并入同一条消息（另插会把已答的挤到第二位）', () => {
  const msgs = [
    { role: 'assistant', content: [use('call_00'), use('call_01')] },
    { role: 'user', content: [res('call_00')] },
  ]
  const out = patchOrphanToolUses(msgs)
  assertChainValid(out, 'case3')
  assert.equal(out.length, 2, '不新增消息：只能并入')
  const types = out[1].content.map((b) => b.type)
  assert.deepEqual(types, ['tool_result', 'tool_result'], '同一消息里 tool_result 必须先于 text')
  assert.deepEqual(out[1].content.map((b) => b.tool_use_id), ['call_01', 'call_00'], '缺的在前、真实的原样在后')
  assert.equal(out[1].content[1], msgs[1].content[0], '真实结果对象原样保留（不重建）')
})

test('部分回答 + 文本：并入时结果块排前、文本块保留（不调序不改文本）', () => {
  const msgs = [
    { role: 'assistant', content: [use('u0'), use('u1')] },
    { role: 'user', content: [{ type: 'text', text: '继续' }, res('u0')] },
  ]
  const out = patchOrphanToolUses(msgs)
  assertChainValid(out, 'case3b')
  assert.deepEqual(out[1].content.map((b) => `${b.type}:${b.tool_use_id ?? b.text}`),
    ['tool_result:u1', 'text:继续', 'tool_result:u0'])
})

test('尾部孤儿：无下一条时补一条新消息放在其后', () => {
  const msgs = [
    { role: 'user', content: '开始' },
    { role: 'assistant', content: [use('call_x')] },
  ]
  const out = patchOrphanToolUses(msgs)
  assertChainValid(out, 'case4')
  assert.equal(out.length, 3)
  assert.equal(out[2].content[0].tool_use_id, 'call_x')
})

test('连续 assistant：各自补在各自的下一条，互不串位', () => {
  const msgs = [
    { role: 'assistant', content: [use('a1')] },
    { role: 'assistant', content: [use('b1'), use('b2')] },
    { role: 'user', content: '继续' },
  ]
  const out = patchOrphanToolUses(msgs)
  assertChainValid(out, 'case5')
  assert.equal(out[1].role, 'user', '第一条 assistant 之后必须紧跟补丁消息')
  assert.equal(out[1].content[0].tool_use_id, 'a1')
  // b1/b2 的补丁必须夹在 B 与用户的"继续"之间（紧跟 B，而不是被排到末尾）
  assert.deepEqual(out[3].content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id), ['b1', 'b2'])
  assert.equal(out[4], msgs[2], '用户的"继续"原样留在最后')
})

test('中段孤儿 + 尾部正常：不误伤已成对的消息', () => {
  const msgs = [
    { role: 'assistant', content: [use('m1')] },
    { role: 'user', content: '继续' },              // m1 的孤儿 → 在其前插补丁消息
    { role: 'assistant', content: [use('ok1')] },
    { role: 'user', content: [res('ok1')] },          // 已成对，一字不动
  ]
  const out = patchOrphanToolUses(msgs)
  assertChainValid(out, 'case6')
  assert.equal(out.length, msgs.length + 1)
  assert.equal(out[1].content[0].tool_use_id, 'm1')
  assert.equal(out[3], msgs[2], '已成对的消息应原样推原对象（身份不变）')
  assert.equal(out[4], msgs[3])
})

test('无孤儿：元素身份不变（K1.1 估算记忆化的前提，别改成克隆）', () => {
  const msgs = [
    { role: 'assistant', content: [use('k1')] },
    { role: 'user', content: [res('k1')] },
  ]
  const out = patchOrphanToolUses(msgs)
  assert.equal(out.length, 2)
  for (let i = 0; i < msgs.length; i++) assert.equal(out[i], msgs[i], `#${i} 必须是同一对象`)
})
