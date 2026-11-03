// MCP 并发语义测试（2026-10-06 三层升级·批次 5 参考核验）
// ---------------------------------------------------------------------------
// 背景（Goose 实测教训，spec 2026-10-06-loop-3layer-upgrade §6 表）：
//   上游曾以 "refcounted ActiveSession" 修并发（PR #7202）——**中途被移除、从未合并**；
//   真正落地的修复只有两条：① **删掉跨 await 持有的锁**；② 响应**按 id 匹配**（而不是
//   队列/顺序假设）。我们 kernel/mcp.mjs 的 createJsonRpcSession 从一开始就是
//   「pending Map 按 id resolve + 无跨 await 锁」，但**这条设计此前没有测试钉死**——
//   没有断言的设计等于"此刻恰好如此"，任何人重构都可能退回串行/顺序假设而不报错。
//
// 本文件的断言分两层（都是可证伪的行为断言，不是"实现里有这个变量"）：
//   A. 会话核（注入 send，无子进程）：按 id 结算 / 一路超时或 abort 不误伤另一路；
//   B. 端到端（子进程桩）：一路 hang（永不回复）不阻塞另一路 echo 往返——
//      若客户端跨 await 持锁，echo 会被拖到 hang 超时（4s）之后才返回（实测毫秒 vs 秒级）。
//      ★ 用桩里既有的 `hang` 工具造"慢路"，**不新增夹具工具**（改共享桩会波及 4 个既有
//      文件的工具数断言，噪声远大于收益）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createJsonRpcSession, startMcpClient } from '../kernel/mcp.mjs'

const STUB = fileURLToPath(new URL('./fixtures/mcp-stub-server.mjs', import.meta.url))
const NODE = process.execPath

/** 记录出站消息的探针会话（ids 由实现分配，测试按出站顺序取回） */
function probeSession(opts = {}) {
  const sent = []
  const s = createJsonRpcSession({ name: 'probe', send: (m) => { sent.push(m); return true }, ...opts })
  return { s, sent }
}

// ── A. 会话核：按 id 结算 ────────────────────────────────────────────────────

test('会话核：并发请求按 id 各自结算——先回「后发出的」也不串台', async () => {
  const { s, sent } = probeSession()
  const p1 = s.request('first')
  const p2 = s.request('second')
  assert.equal(s.stats().pending, 2, '两路都应在挂起表里')

  // 关键序：**先**结算第二个请求（id 更大者）——FIFO/队列式实现会把它错配给 p1
  s.handleMessage({ jsonrpc: '2.0', id: sent[1].id, result: 'B' })
  s.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: 'A' })

  assert.equal(await p1, 'A', '结果必须按 id 归属，不得按到达顺序')
  assert.equal(await p2, 'B')
  assert.equal(s.stats().pending, 0)
})

test('会话核：一路超时不误伤另一路（各自计时器），晚到的响应仍能结算', async () => {
  const { s, sent } = probeSession({ timeoutMs: 5000 })
  const pLong = s.request('long')                                    // 缺省 5000ms
  const pTiny = s.request('tiny', undefined, { timeoutMs: 30 })      // 30ms 后超时

  await assert.rejects(() => pTiny, /超时/, '短超时那路必须自己拒绝')
  assert.equal(s.stats().pending, 1, '长超时那路不得被连带拒绝/清理')

  s.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: 'ok' })
  assert.equal(await pLong, 'ok', '另一路的响应必须仍能结算')
  assert.equal(s.stats().pending, 0)
})

test('会话核：一路 abort 不误伤另一路；收尾后无 pending 残留', async () => {
  const { s, sent } = probeSession()
  const ac = new AbortController()
  const pAborted = s.request('aborted', undefined, { signal: ac.signal })
  const pAlive = s.request('alive')

  ac.abort()
  await assert.rejects(() => pAborted, /取消/)
  assert.equal(s.stats().pending, 1, 'abort 只该清掉自己那一笔')

  s.handleMessage({ jsonrpc: '2.0', id: sent[1].id, result: 'alive-ok' })
  assert.equal(await pAlive, 'alive-ok')
  assert.equal(s.stats().pending, 0, '全部结算后 pending 必须归零（防 id 泄漏）')
})

// ── B. 端到端：并发不被串行化 + 结果归属 ────────────────────────────────────

test('端到端：一路 hang（永不回复）不阻塞另一路 echo 往返（跨 await 不持锁）', async () => {
  const c = await startMcpClient({ name: 'conc', command: NODE, args: [STUB], timeoutMs: 4000 })
  try {
    const t0 = Date.now()
    const pHang = c.call('hang', {})                 // 桩故意不回复：4s 后超时
    const pEcho = c.call('echo', { text: 'B' })      // 与 hang 同时在飞
    const r = await pEcho
    const dt = Date.now() - t0

    assert.equal(r.text, 'echo: B', 'echo 结果必须归 echo（不得与 hang 那笔串台）')
    assert.ok(dt < 1500,
      `并发 echo 应在毫秒级返回，实测 ${dt}ms —— 若客户端跨 await 持锁/按顺序等待，`
      + '会被 hang 拖到超时（4s）之后才返回（这正是 Goose 那条未合并修复要解决的问题）')

    await assert.rejects(() => pHang, /超时/, 'hang 那路应各自超时（证明它确实仍在飞，不是被丢弃）')
    assert.equal(c.stats().pending, 0, '两路收尾后 pending 必须归零')
  } finally { c.close() }
})

test('端到端：两个并发 echo 各自拿回自己的载荷（结果按 id 归属）', async () => {
  const c = await startMcpClient({ name: 'conc2', command: NODE, args: [STUB], timeoutMs: 4000 })
  try {
    const [ra, rb] = await Promise.all([
      c.call('echo', { text: '甲' }),
      c.call('echo', { text: '乙' }),
    ])
    assert.equal(ra.text, 'echo: 甲')
    assert.equal(rb.text, 'echo: 乙')
    assert.equal(c.stats().pending, 0)
    assert.equal(c.stats().calls, 2, '两次调用都应计为独立 call（未被合并/丢弃）')
  } finally { c.close() }
})
