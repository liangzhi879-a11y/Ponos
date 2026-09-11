// kernel/workflow-dag.mjs —— 就绪集合调度器（edges 即真相）
// 语义：① 节点在其全部入边 settle 且至少一条 active 时可执行，执行一次；
//      ② 条件边：源节点 route → 命中 handle 的边 active，其余 skipped；
//      ③ 入边全 skipped 的节点 skipped 并向其出边传播；
//      ④ on_error=branch 的失败节点走 'fail' handle；on_error=continue 失败不终止 run，
//         且其非 fail 出边按"成功"激活，使下游继续执行（沿用旧引擎语义）；
//      ⑤ 节点级 retry 在调度器内做退避重试（不改节点实现），退避 sleep 分片可中断。
// 子图（loop/iterate body）由节点执行器递归调用本函数，作用域 = body 成员集合。
//
// 零外部运行时依赖：只 import node:* 与仓库内相对路径。
// 确定性：就绪/跳过集合都按 nodes 数组顺序切批，Promise.all 的完成顺序不影响 settled 结果。
import { resolvePath } from './workflow-dsl.mjs'

export function buildGraph(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = new Map(nodes.map((n) => [n.id, []]))
  const outgoing = new Map(nodes.map((n) => [n.id, []]))
  // 边 id 必须唯一：edgeState 以 edgeId 为键，重复 id 会让两条边串台——
  // 同 id 边任一条 settle 即让**所有**同 id 边看起来"已确定"（节点提前就绪），
  // 或使另一条 active 的入边被覆盖成 skipped（活跃分支静默丢失）。
  // 这类无法正确调度的输入必须 fail-fast，不得静默产出错误结果。
  const edgeIds = new Set()
  for (const e of edges || []) {
    if (!e || e.id == null) continue
    if (edgeIds.has(e.id)) throw new Error(`重复的边 id: ${e.id}`)
    edgeIds.add(e.id)
  }
  for (const e of edges || []) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    outgoing.get(e.source).push(e)
    incoming.get(e.target).push(e)
  }
  return { byId, incoming, outgoing }
}

// 退避 sleep 分片（每片 ≤250ms 复查一次 signal.aborted）：取消后最多等一个分片就落地，
// 不再需要等满 30s 的退避窗口（signal 是 { aborted } 形状的普通对象，只能轮询）。
const SLEEP_SLICE_MS = 250

async function sleep(ms, signal) {
  let remaining = Math.max(0, Number(ms) || 0)
  while (remaining > 0) {
    if (signal?.aborted) return
    await new Promise((r) => setTimeout(r, Math.min(remaining, SLEEP_SLICE_MS)))
    remaining -= SLEEP_SLICE_MS
  }
}

// on_error 三态归一化：未知取值一律按默认 'fail'（硬失败）处理。
// 若放任未知值走"非硬失败"路径，节点失败会被静默吞掉 → run 以 completed 收尾却少了分支。
const ON_ERROR_VALUES = new Set(['fail', 'branch', 'continue'])
const normalizeOnError = (v) => (ON_ERROR_VALUES.has(v) ? v : 'fail')

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
// on_error='continue' 的失败节点由调用方以 `{ ok: true }` 的等效 result 传入（见 settleEdgesOf）。
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
  const onError = normalizeOnError(retry.on_error)   // fail | branch | continue（未知 → fail）
  let last
  for (let attempt = 0; attempt <= max; attempt++) {
    if (ctx.signal?.aborted) return { ok: false, error: 'cancelled', cancelled: true }
    last = await ctx.executeNode(node, ctx)
    if (last?.ok) return last
    if (attempt < max) await sleep(Math.min(base * Math.pow(2, attempt), 30_000), ctx.signal)
  }
  return { ...last, onError }
}

export async function schedule({ nodes, edges, inputs = {}, runId = '', executeNode, maxParallel = 4, signal = { aborted: false }, onSettle, onEdge, ctxExtra = {} }) {
  const { byId, incoming, outgoing } = buildGraph(nodes, edges || [])
  // maxParallel 归一化：0 / 负数 / NaN / 小数都不得让切批循环原地踏步。
  // 若 mp 为 0 或 NaN（`i += mp` 永不推进），批切出的空批 Promise.all([]) 会反复 resolve
  // 造成微任务饥饿——定时器与 IO 不再被调度（外部 stop() 也难生效），stepsLimit 永不触发，
  // 进程级硬挂。故进入调度前归一化为 ≥1 的整数。
  const mp = Math.max(1, Math.floor(Number(maxParallel) || 1))
  const settled = new Map()
  const edgeState = new Map()   // edgeId -> 'active'|'skipped'
  const order = nodes.map((n) => n.id)
  const stepsLimit = Math.max(500, nodes.length * 50)
  let steps = 0

  const settleEdgesOf = (nodeId, result) => {
    const node = byId.get(nodeId)
    // on_error='continue'：失败不终止 run，其非 fail 出边照"成功"激活使下游继续执行
    //（沿用旧引擎语义 kernel/workflow.mjs:696）。settled 里仍如实记 ok:false + error，
    // 下游可能读到 undefined 的 output。
    const eff = !result?.ok && !result?.skipped && normalizeOnError(node?.retry?.on_error) === 'continue'
      ? { ...result, ok: true }
      : result
    activateOutgoing(node, eff, outgoing, edgeState)
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
    for (let i = 0; i < ready.length; i += mp) {
      if (signal.aborted) return { ok: false, status: 'cancelled', settled, steps, error: '已取消' }
      const batch = ready.slice(i, i + mp)
      const results = await Promise.all(batch.map(async (id) => {
        const node = byId.get(id)
        const r = await runWithRetry(node, { ...ctxExtra, executeNode, signal, runId, inputs, settled })
        return { id, r }
      }))
      // **先把整批 results 全部落账**（settled + 出边状态 + onSettle/onEdge 回调），
      // 再在批末统一判定取消/硬失败：批内节点已并发执行完毕（可能带副作用），
      // 若在第一个结果处就 return，同批其余已完成节点会丢记 → 引擎侧 audit 无行、
      // 无 node 事件、outputs 缺该节点（取消判定用全局 signal.aborted，必命中"第一个"结果）。
      let cancelledInBatch = false
      let hardFail = null
      for (const { id, r } of results) {
        steps++
        if (steps > stepsLimit) return { ok: false, status: 'failed', settled, steps, error: '执行步数超限' }
        const rec = { ok: !!r.ok, skipped: false, output: r.output, route: r.route, error: r.ok ? undefined : (r.error || '节点失败'), dur_ms: r.dur_ms || 0 }
        settled.set(id, rec)
        settleEdgesOf(id, rec)
        onSettle?.({ node: id, ...rec })
        // 批内取消：节点执行途中 signal 被置位，或节点自身报告 { cancelled:true } →
        // 整个 run 以 cancelled 收尾（取消 ≠ 失败，不得落进下方 hardFail 分支）。
        if (r?.cancelled || signal.aborted) cancelledInBatch = true
        const node = byId.get(id)
        const onError = normalizeOnError(node?.retry?.on_error)
        // 硬失败：on_error='fail'（默认，含未知取值），或 'branch' 但没有声明 'fail' 出边
        //（错误无人接管）。未处理的错误不允许静默成功，否则该 run 会以 completed 收尾却少了
        // 整条分支。'continue' 不硬失败（第 ④ 条语义）。
        const hasFailEdge = (outgoing.get(id) || []).some((e) => e.sourceHandle === 'fail')
        if (!rec.ok && !hardFail && (onError === 'fail' || (onError === 'branch' && !hasFailEdge))) {
          hardFail = { id, error: rec.error }
        }
      }
      if (cancelledInBatch) return { ok: false, status: 'cancelled', settled, steps, error: '已取消' }
      if (hardFail) return { ok: false, status: 'failed', settled, steps, error: hardFail.error, node: hardFail.id }
    }
  }
  return { ok: true, status: 'completed', settled, steps }
}
