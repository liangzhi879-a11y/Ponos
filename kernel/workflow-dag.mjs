// kernel/workflow-dag.mjs —— 就绪集合调度器（edges 即真相）
// 语义：① 节点在其全部入边 settle 且至少一条 active 时可执行，执行一次；
//      ② 条件边：源节点 route → 命中 handle 的边 active，其余 skipped；
//      ③ 入边全 skipped 的节点 skipped 并向其出边传播；
//      ④ on_error=branch 的失败节点走 'fail' handle；
//      ⑤ 节点级 retry 在调度器内做退避重试（不改节点实现）。
// 子图（loop/iterate body）由节点执行器递归调用本函数，作用域 = body 成员集合。
//
// 零外部运行时依赖：只 import node:* 与仓库内相对路径。
// 确定性：就绪/跳过集合都按 nodes 数组顺序切批，Promise.all 的完成顺序不影响 settled 结果。
import { resolvePath } from './workflow-dsl.mjs'

export function buildGraph(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = new Map(nodes.map((n) => [n.id, []]))
  const outgoing = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges || []) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    outgoing.get(e.source).push(e)
    incoming.get(e.target).push(e)
  }
  return { byId, incoming, outgoing }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 出边激活：无 sourceHandle 的源节点 → 成功时全部 active；有 handle → 按 route 命中。
// handle 语义（契约）：
//   'true'/'false'  → 仅当 result.route 精确等于该 handle
//   'route:<i>'     → 仅当 result.route 精确等于该 handle
//   'default'       → **仅当没有任何条件 handle 命中时**才 active（classify 的兜底分支）
//   'fail'          → 仅当 result.ok === false
// 关键：'default' 不是无条件激活。若写成无条件，classify 命中 route:0 时 default 边会同时
// 激活，导致两条分支并跑（这正是 Task 2 审查 I-1 指出的缺陷）。
// 跳过传播：被跳过的节点（result.skipped）其**所有**出边一律 skipped——包括无 handle 的顺序边；
// 否则 skip 会沿顺序边漏成 active，导致"仅依赖被跳过入边的下游"被误执行（跳过必须传播）。
function activateOutgoing(node, result, outgoing, edgeState) {
  const outs = outgoing.get(node.id) || []
  if (result?.skipped) {
    for (const e of outs) edgeState.set(e.id, 'skipped')
    return
  }
  const branching = outs.some((e) => e.sourceHandle)
  if (!branching) {
    for (const e of outs) edgeState.set(e.id, result.ok ? 'active' : 'skipped')
    return
  }
  const route = String(result?.route ?? '')
  const condHandles = outs.map((e) => e.sourceHandle).filter((h) => h && h !== 'fail' && h !== 'default')
  const matched = result.ok && route && condHandles.includes(route)
  for (const e of outs) {
    const h = e.sourceHandle
    let active
    if (!h) active = result.ok                      // 混合图：无 handle 出边按"成功即走"
    else if (h === 'fail') active = !result.ok
    else if (h === 'default') active = result.ok && !matched
    else active = !result.ok ? false : route === h
    edgeState.set(e.id, active ? 'active' : 'skipped')
  }
}

async function runWithRetry(node, ctx) {
  const retry = node.retry || {}
  const max = Math.max(0, Number(retry.max || 0))
  const base = Math.max(0, Number(retry.delay_ms || 0))
  const onError = retry.on_error || 'fail'   // fail | branch | continue
  let last
  for (let attempt = 0; attempt <= max; attempt++) {
    if (ctx.signal?.aborted) return { ok: false, error: 'cancelled', cancelled: true }
    last = await ctx.executeNode(node, ctx)
    if (last?.ok) return last
    if (attempt < max) await sleep(Math.min(base * Math.pow(2, attempt), 30_000))
  }
  return { ...last, onError }
}

export async function schedule({ nodes, edges, inputs = {}, runId = '', executeNode, maxParallel = 4, signal = { aborted: false }, onSettle, onEdge, ctxExtra = {} }) {
  const { byId, incoming, outgoing } = buildGraph(nodes, edges || [])
  const settled = new Map()
  const edgeState = new Map()   // edgeId -> 'active'|'skipped'
  const order = nodes.map((n) => n.id)
  const stepsLimit = Math.max(500, nodes.length * 50)
  let steps = 0

  const settleEdgesOf = (nodeId, result) => {
    activateOutgoing(byId.get(nodeId), result, outgoing, edgeState)
    for (const e of outgoing.get(nodeId) || []) onEdge?.({ edge: e.id, state: edgeState.get(e.id) })
  }

  while (true) {
    if (signal.aborted) return { ok: false, status: 'cancelled', settled, steps, error: '已取消' }
    const pending = order.filter((id) => !settled.has(id))
    if (!pending.length) break
    const ready = pending.filter((id) => {
      const ins = incoming.get(id)
      if (!ins.length) return true                                   // 源节点（含 start）
      if (!ins.every((e) => edgeState.has(e.id))) return false        // 入边未全 settle
      return ins.some((e) => edgeState.get(e.id) === 'active')
    })
    const skipped = pending.filter((id) => {
      const ins = incoming.get(id)
      if (!ins.length) return false
      if (!ins.every((e) => edgeState.has(e.id))) return false
      return ins.every((e) => edgeState.get(e.id) === 'skipped')
    })
    if (!ready.length && !skipped.length) {
      return { ok: false, status: 'failed', settled, steps, error: '调度死锁：存在无法就绪也无法跳过的节点' }
    }
    for (const id of skipped) {
      const r = { ok: true, skipped: true, output: undefined }
      settled.set(id, r)
      settleEdgesOf(id, { ok: true, skipped: true })
      onSettle?.({ node: id, ...r })
    }
    for (let i = 0; i < ready.length; i += maxParallel) {
      if (signal.aborted) return { ok: false, status: 'cancelled', settled, steps, error: '已取消' }
      const batch = ready.slice(i, i + maxParallel)
      const results = await Promise.all(batch.map(async (id) => {
        const node = byId.get(id)
        const r = await runWithRetry(node, { ...ctxExtra, executeNode, signal, runId, inputs, settled })
        return { id, r }
      }))
      for (const { id, r } of results) {
        steps++
        if (steps > stepsLimit) return { ok: false, status: 'failed', settled, steps, error: '执行步数超限' }
        const rec = { ok: !!r.ok, skipped: false, output: r.output, route: r.route, error: r.ok ? undefined : (r.error || '节点失败'), dur_ms: r.dur_ms || 0 }
        settled.set(id, rec)
        settleEdgesOf(id, rec)
        onSettle?.({ node: id, ...rec })
        // 批内取消：节点执行途中 signal 被置位，或节点自身报告 { cancelled:true } →
        // 整个 run 以 cancelled 收尾。若不做此判断，批内被取消的节点会落入下方 hardFail
        // 分支被误判为 status:'failed'，掩盖真实原因（取消 ≠ 失败）。
        if (r?.cancelled || signal.aborted) {
          return { ok: false, status: 'cancelled', settled, steps, error: '已取消' }
        }
        const node = byId.get(id)
        const onError = node.retry?.on_error || 'fail'
        // on_error:'branch' 但没有声明 'fail' 出边 = 错误无人接管 → 视为硬失败
        //（未处理的错误不允许静默成功，否则该 run 会以 completed 收尾却少了整条分支）。
        const hasFailEdge = (outgoing.get(id) || []).some((e) => e.sourceHandle === 'fail')
        const hardFail = !rec.ok && (onError === 'fail' || (onError === 'branch' && !hasFailEdge))
        if (hardFail) return { ok: false, status: 'failed', settled, steps, error: rec.error, node: id }
      }
    }
  }
  return { ok: true, status: 'completed', settled, steps }
}
