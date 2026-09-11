// kernel/workflow-engine.mjs —— 工作流引擎装配（Task 5：从 kernel/workflow.mjs 迁出）
//
// 职责：把三块纯逻辑装配成可运行实例
//   workflow-dsl.mjs   解析 / 归一化 / 校验 / 发现 / 加载
//   workflow-dag.mjs   就绪集合调度（edges 即真相、条件边、跳过传播、重试、取消）
//   workflow-nodes.mjs 单节点执行器（loop/iterate 的子图递归由节点侧自带调度完成）
// 本模块只负责「装配 + 外围」：run（校验→调度→审计→事件→输出合成）、run 级 stop、
// confirm 挂起/回解、cron 调度器、webhook 服务。
//
// 与 skill 平权协同：同一发现机制（workflow.yml 目录 + 平铺 .yml）、共享 triggers 触发词；
// 定位差异：skill=灵活处理，workflow=严格输出（确定性 DAG + 节点级审计哈希链）。
//
// 审计：每节点 {ts,node,type,status,dur_ms,out_hash,prev} 哈希链落盘
//   <configDir>/workflow-runs/<name>/<ts>-<runId>.jsonl，verifyRun 验完整性。
//
// 零外部运行时依赖：只 import node:* 与仓库内相对路径。

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { discoverWorkflows, loadWorkflow, migrateLegacy, appendEdges, validateWorkflow, resolvePath } from './workflow-dsl.mjs'
import { schedule } from './workflow-dag.mjs'
import { createNodeExecutor } from './workflow-nodes.mjs'
// 可见性判定单一来源（M3）：通用 Workflow 工具的闸门与 dyntools 工具池/提示词清单同口径
// （dyntools 只依赖 workflow-dsl，无循环 import）。
import { visibilityOf } from './dyntools.mjs'

// ===================== 审计（哈希链） =====================
function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex')
}

// 链语义（不得改变）：prev = 上一行原文的 sha256，首行 '-'；verifyRun 逐行复算。
// r.status 为可选覆盖：跳过的节点记 status:'skipped' 而非 'done'/'failed'
//（跳过的记账必须留痕，但**不是失败**，也不该伪装成成功——GUI 对账要区分）。
// 不传 status 时行为与迁移前逐字一致（ok ? 'done' : 'failed'）；链只由 line/prev 决定，
// status 是载荷字段，覆盖它不影响 verifyRun 的校验语义。
function auditAppend(auditPath, node, r, prevHash) {
  try { mkdirSync(dirname(auditPath), { recursive: true }) } catch { /* ignore */ }
  const rec = {
    ts: new Date().toISOString(),
    node: node.id,
    type: node.type,
    status: r.status || (r.ok ? 'done' : 'failed'),
    dur_ms: r.dur_ms ?? 0,
    out_hash: sha256(JSON.stringify(r.output ?? r.error ?? '')),
    prev: prevHash,
  }
  const line = JSON.stringify(rec)
  try { appendFileSync(auditPath, line + '\n') } catch { /* 审计失败不阻断执行 */ }
  return sha256(line)
}

export function verifyRun(auditPath) {
  if (!existsSync(auditPath)) return { ok: false, error: '审计文件不存在', lines: 0 }
  let lines
  try { lines = readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean) } catch (e) { return { ok: false, error: e.message, lines: 0 } }
  let prev = '-'
  let tampered = null
  for (let i = 0; i < lines.length; i++) {
    let rec
    try { rec = JSON.parse(lines[i]) } catch { tampered = { line: i + 1, reason: 'parse error' }; break }
    if (rec.prev !== prev) { tampered = { line: i + 1, expected: prev, got: rec.prev }; break }
    prev = sha256(lines[i])
  }
  return { ok: !tampered, lines: lines.length, tampered, lastHash: prev }
}

// ===================== 返回值合成（规格契约条目 11） =====================
// settled 的值是 {ok,output,skipped,error,...} **记录**；变量作用域必须是
// "节点 id → 节点输出值"，直接摊平会把记录对象塞进模板（{{node}} 渲染成记录）——
// 务必取 .output。
function synthesizeOutput(wf, settled, inputs = {}) {
  const ends = (wf.nodes || []).filter((n) => n.type === 'end')
  const answers = (wf.nodes || []).filter((n) => n.type === 'answer')
  const scope = { inputs, var: {} }
  for (const [nid, rec] of settled) scope[nid] = rec.output
  const out = {}
  for (const e of ends) {
    for (const o of e.outputs || []) out[o.variable || o.name] = resolvePath(scope, o.selector || o.value || '')
  }
  if (answers.length) {
    out.answer = answers.map((a) => settled.get(a.id)?.output?.answer ?? '').filter(Boolean).join('\n')
  }
  if (!Object.keys(out).length) {
    // 无 end.outputs 且无 answer：回退"最后一个成功且未跳过节点的输出"（对标工具调用口径）。
    // **必须排除 end/answer 自身**（C2）：end 的输出恒为 `{}`（无 outputs 时），
    // 不排除则兜底恒取到 end → finalOutput 恒为 {result:{}}（工具回执/GUI 运行面板显示空）。
    const terminals = new Set([...ends, ...answers].map((n) => n.id))
    const last = [...settled.entries()].filter(([nid, r]) => r.ok && !r.skipped && !terminals.has(nid)).pop()
    if (last) out.result = last[1].output
  }
  return out
}

// 主图作用域：loop/iterate 的 body 成员只由节点执行器的子图递归执行，**不进主调度**。
// 若把 body 成员一并交给主调度，它们因无入边会被当成源节点在 t0 就绪（在 loop 之外
// 多跑一遍，并与主链并行），DAG 语义被破坏（跨边界边已被 validateWorkflow 的
// BODY_ESCAPE 禁止，故过滤边不会误伤主图连线）。
export function mainScope(wf) {
  const bodyMembers = new Set()
  for (const n of wf.nodes || []) {
    if ((n.type === 'loop' || n.type === 'iterate') && Array.isArray(n.body)) {
      for (const b of n.body) bodyMembers.add(b)
    }
  }
  if (!bodyMembers.size) return { nodes: wf.nodes || [], edges: wf.edges || [] }
  return {
    nodes: (wf.nodes || []).filter((n) => !bodyMembers.has(n.id)),
    edges: (wf.edges || []).filter((e) => !bodyMembers.has(e.source) && !bodyMembers.has(e.target)),
  }
}

// ===================== 引擎（执行 + 审计 + 事件） =====================
// createWorkflowEngine({ configDir, registry, onEvent, getModel, signal, memoryRoot })
//   configDir: 审计落盘根（<configDir>/workflow-runs/...）
//   registry:  createToolRegistry 返回值（tool/document 节点调用）
//   onEvent:   ({type:'start'|'node'|'node_skipped'|'edge_taken'|'end'|...}) 事件回调
//   getModel:  () => 默认模型名（llm 节点未指定时）
//   signal:    { aborted } 全局取消标志（与 run 级 stop 合并）
export function createWorkflowEngine({ configDir = '', registry, onEvent, getModel, signal, memoryRoot = '', agentId = null } = {}) {
  const roots = []
  let _configDir = configDir
  let _registry = registry
  let _onEvent = onEvent || (() => {})
  let _getModel = getModel || (() => process.env.ANTHROPIC_MODEL || '')
  let _signal = signal || { aborted: false }
  let _memoryRoot = memoryRoot
  // 当前会话 agent id（M3）：bound 可见性判定用；与 dyntools 工具池的 agentId 同源
  // （cli 传 --agent），缺省 null（仅 public 可见）。
  let _agentId = agentId
  // 审批门（engine 注入 gateToolUse）：内嵌工具节点执行前先经门（高危 ask/deny/
  // hook 否决）；null = 无门 → checkToolPermission 对 Bash fail-closed
  let _permissionGate = null
  let _getToolCtx = () => ({})
  // confirm 挂起队列：key = runId:nodeId → { resolve, timer }
  const confirmWaiters = new Map()
  // run 级取消集合：engine.stop(runId) 置位，与全局 _signal 合并成 runSignal
  const cancelledRuns = new Set()

  // 节点执行器实例（Task 5）：引擎**直接持有** createNodeExecutor 实例，并把 executeNode
  // 交给 schedule（Task 4 的 setNodeDeps 模块级过渡接线已删除——全进程可变状态会在多引擎
  // 实例/并发 run 之间串台）。deps 经 setDeps 变更后重建实例（节点内部仍优先读 ctx.*，
  // 此处是兜底）；engine 引用使 subworkflow 节点可递归调用本引擎（深度上限由节点侧守卫）。
  let nodeExecutor = null
  const makeNodeExecutor = (api) => createNodeExecutor({ registry: _registry, getModel: _getModel, memoryRoot: _memoryRoot, engine: api })

  // 创建挂起项（超时自动 resolve 为 timed_out）
  function createConfirmWaiter(runId, nodeId, timeoutMs) {
    const key = `${runId}:${nodeId}`
    if (confirmWaiters.has(key)) return confirmWaiters.get(key)
    let resolveFn
    const promise = new Promise((resolve) => { resolveFn = resolve })
    const timer = setTimeout(() => {
      if (confirmWaiters.has(key)) {
        confirmWaiters.delete(key)
        resolveFn({ action: 'timeout', comment: '', timed_out: true })
      }
    }, timeoutMs)
    // 注意：confirm 超时 timer 不能 unref——审批挂起期间进程必须保持活跃等待
    // （unref 会导致事件循环无活引用时进程退出、超时永不触发）
    const waiter = { key, promise, resolve: (r) => { clearTimeout(timer); if (confirmWaiters.delete(key)) resolveFn({ ...r, timed_out: false }) } }
    confirmWaiters.set(key, waiter)
    return waiter
  }

  // 外部审批回传：TUI /wf approve|reject / 协议层 workflow_confirm
  function resolveConfirm(runId, nodeId, { action = 'approved', comment = '' } = {}) {
    const key = `${runId}:${nodeId}`
    const w = confirmWaiters.get(key)
    if (!w) return { ok: false, error: `无挂起审批（${key}）` }
    w.resolve({ action, comment })
    return { ok: true }
  }

  function setDeps(deps = {}) {
    if (deps.configDir !== undefined) _configDir = deps.configDir
    if (deps.registry !== undefined) _registry = deps.registry
    if (deps.onEvent !== undefined) _onEvent = deps.onEvent || (() => {})
    if (deps.getModel !== undefined) _getModel = deps.getModel
    if (deps.signal !== undefined) _signal = deps.signal
    if (deps.memoryRoot !== undefined) _memoryRoot = deps.memoryRoot
    if (deps.agentId !== undefined) _agentId = deps.agentId
    if (deps.permissionGate !== undefined) _permissionGate = deps.permissionGate
    // 2026-09-11 spec-dev：主引擎子 agent 能力注入（懒 getter——engine 的 spawnSubAgent/
    // taskSystem 在 setDeps 调用时尚处 TDZ，调用时才取）
    if (deps.getToolCtx !== undefined) _getToolCtx = deps.getToolCtx
    // 节点执行器依赖同步（重建实例：registry/getModel/memoryRoot 变更后立即生效）
    nodeExecutor = makeNodeExecutor(api)
  }

  function event(type, payload) {
    try { _onEvent({ type, ...payload }) } catch { /* 事件失败不阻断 */ }
  }

  // run 级取消（engine.stop(runId)）：只作用于该 run；全局 _signal 语义保持不变
  // （停整台引擎）。二者合并进 runSignal（getter 形式——schedule 与节点执行器都按
  // 只读 { aborted } 消费，取消在下一个检查点落地）。
  function stop(runId) {
    if (!runId) return { ok: false, error: 'runId 必填' }
    cancelledRuns.add(runId)
    return { ok: true }
  }

  async function run({ id, inputs = {}, mode = 'sync', depth = 0, runId: presetRunId, grant = null, cwd = '' } = {}) {
    const wf = loadWorkflow({ roots, id })
    if (!wf) return { ok: false, error: `工作流不存在: ${id}` }
    // 校验进生产路径（Task 1 交接 I-5）：loadWorkflow 只解析不校验，旧格式（无 edges）
    // 若被静默加载执行会退回"数组顺序 + next"的旧语义——DAG 引擎必须 fail-fast。
    const v = validateWorkflow(wf)
    if (!v.ok) {
      return { ok: false, error: `工作流校验失败: ${v.errors.map((e) => e.code).join(', ')}`, code: v.errors[0]?.code, errors: v.errors }
    }
    const runId = presetRunId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const auditPath = _configDir ? join(_configDir, 'workflow-runs', wf.name || id, `${ts}-${runId}.jsonl`) : ''
    const vars = { inputs: { ...inputs }, var: {}, root: {} }
    const nodes = new Map(wf.nodes.map((n) => [n.id, n]))
    const auditState = { path: auditPath, prev: '-' }
    const runSignal = { get aborted() { return _signal.aborted || cancelledRuns.has(runId) } }
    // 并发度：workflow 级 settings.max_parallel（缺省 4）；0/负数/NaN 由 schedule 归一化为 ≥1
    const maxParallel = Number(wf.settings?.max_parallel) > 0 ? Number(wf.settings.max_parallel) : 4
    const scope = mainScope(wf)
    const ctx = {
      inputs, vars, var: vars.var, nodes,
      childNodes: wf.nodes, childEdges: wf.edges, registry: _registry, signal: runSignal,
      getModel: _getModel, memoryRoot: _memoryRoot, runId, depth, maxParallel,
      event, confirmWaiters: { create: createConfirmWaiter }, permissionGate: _permissionGate,
      getToolCtx: _getToolCtx, nodeRuns: {},
      // 运行级授权（宿主经 workflow_command.run 注入）：节点执行器的 checkToolPermission
      // 以它为准（命中放行、未命中 fail-closed）。cwd 是相对路径判定基——宿主会话 cwd
      // 未必等于内核进程 cwd，必须显式传入（Task 9 遗留 / Task 11 审查 I-2 配套）。
      grant, cwd,
    }
    // 节点落账（主图与子图统一入口）：审计一行 + 事件 + 变量作用域写入。
    // 跳过的节点也落账（verifyRun 行数与 GUI 对账一致：settled 里的每个节点都有一行），
    // 但记 status:'skipped' —— 不是失败，也不算成功。
    const onNodeSettled = ({ node, ok, skipped, output, error, dur_ms, route, in_body }) => {
      ctx.nodeRuns[node] = { ok, skipped, output, error, dur_ms }
      const inBody = in_body === true
      if (skipped) {
        auditState.prev = auditPath
          ? auditAppend(auditPath, nodes.get(node), { ok: true, status: 'skipped', dur_ms: 0 }, auditState.prev)
          : auditState.prev
        // 双事件：`node + status:'skipped'`（既有 node 事件字段契约，GUI 按 type:'node' 收）
        // 与 `node_skipped`（Task 5 新增，UI 侧按 type 灰显）。
        // node_type：消费端（TUI/GUI）按节点类型渲染——旧引擎即有此字段，Task 5 搬迁时漏带
        // （审查 I-1）。两类事件都带，node_skipped 单独消费时类型信息不丢。
        const ntSkipped = nodes.get(node)?.type
        event('node', { runId, node, node_type: ntSkipped, status: 'skipped', dur_ms: 0, ...(inBody ? { in_body: true } : {}) })
        event('node_skipped', { runId, node, node_type: ntSkipped, ...(inBody ? { in_body: true } : {}) })
        return
      }
      if (ok && output !== undefined) {
        vars[node] = output
        if (output && typeof output === 'object') Object.assign(vars.root, output)
      }
      auditState.prev = auditPath
        ? auditAppend(auditPath, nodes.get(node), { ok, output, error, dur_ms }, auditState.prev)
        : auditState.prev
      event('node', {
        runId, node, node_type: nodes.get(node)?.type, status: ok ? 'done' : 'failed', dur_ms,
        output: ok ? output : undefined, error: ok ? undefined : error, route,
        ...(inBody ? { in_body: true } : {}),
      })
    }
    const onEdgeSettled = ({ edge, state, in_body }) => event('edge_taken', { runId, edge, state, ...(in_body === true ? { in_body: true } : {}) })
    // 子图（loop/iterate body）内的节点/边也走同一通道：节点执行器的子图递归会回调
    // ctx.onNodeSettled / ctx.onEdge —— 审计逐节点、事件不丢子图进度。
    // 引擎**不注入 runBody**：子图调度由节点模块自带的 schedule 递归实现。
    ctx.onNodeSettled = onNodeSettled
    ctx.onEdge = onEdgeSettled
    event('start', { runId, workflow: wf.name || id, nodes: wf.nodes.length, mode })
    const r = await schedule({
      nodes: scope.nodes, edges: scope.edges, inputs, runId, signal: runSignal, maxParallel,
      ctxExtra: ctx,
      executeNode: (node, sub) => nodeExecutor(node, { ...ctx, ...sub }),
      onSettle: onNodeSettled,
      onEdge: onEdgeSettled,
    })
    const outputs = {}
    for (const [nid, rec] of r.settled) outputs[nid] = { ok: rec.ok, output: rec.output, skipped: rec.skipped, error: rec.error }
    const finalOutput = synthesizeOutput(wf, r.settled, inputs)
    const status = r.status
    event('end', { runId, status, steps: r.steps, error: r.error, ...(r.node ? { node: r.node } : {}) })
    return { ok: r.ok, status, outputs, finalOutput, steps: r.steps, error: r.error, node: r.node, runId, auditPath, settled: r.settled }
  }

  // cron 表达式匹配（5 段：分 时 日 月 周；* / 数字 逗号）
  function cronMatches(expr, date = new Date()) {
    const fields = String(expr).trim().split(/\s+/)
    if (fields.length !== 5) return false
    const vals = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()]
    for (let i = 0; i < 5; i++) {
      const f = fields[i]
      if (f === '*') continue
      if (f.startsWith('*/')) {
        const step = Number(f.slice(2))
        if (vals[i] % step !== 0) return false
        continue
      }
      if (f.includes(',')) {
        const parts = f.split(',').map(Number)
        if (!parts.includes(vals[i])) return false
        continue
      }
      if (Number(f) !== vals[i]) return false
    }
    return true
  }

  // 调度器：每 60s 扫描 roots 下带 schedule 字段的工作流，cron 匹配即 run。
  // 防重：last 记录已触发（同分钟内不重复）。返回 stop()。
  function startScheduler({ onRun } = {}) {
    const last = new Map()
    const timer = setInterval(() => {
      for (const root of roots) {
        for (const wf of discoverWorkflows({ root })) {
          const schedule = wf.schedule
          if (!schedule) continue
          const now = new Date()
          const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
          if (!cronMatches(schedule, now)) continue
          if (last.get(wf.id) === minuteKey) continue
          last.set(wf.id, minuteKey)
          const r = run({ id: wf.id, inputs: {} })
          if (onRun) void r.then((res) => onRun(wf.id, res))
        }
      }
    }, 60_000)
    if (timer.unref) timer.unref()
    return () => clearInterval(timer)
  }

  // webhook 触发：node:http 服务，POST /wf/run/<id>（JSON body = inputs）。
  // 返回 server（调用方 listen）；默认端口 51312（PONOS_WF_WEBHOOK_PORT 覆盖）。
  function createWebhookServer() {
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/wf/run/')) {
        const id = decodeURIComponent(req.url.slice('/wf/run/'.length))
        let body = ''
        for await (const chunk of req) body += chunk
        let inputs = {}
        try { inputs = JSON.parse(body || '{}') } catch { /* 非 JSON body 视为空 */ }
        try {
          const r = await run({ id, inputs })
          res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: r.ok, status: r.status, steps: r.steps, runId: r.runId, auditPath: r.auditPath, error: r.error, node: r.node }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }))
        }
        return
      }
      if (req.method === 'GET' && req.url === '/wf/list') {
        const list = []
        for (const root of roots) for (const w of discoverWorkflows({ root })) list.push({ id: w.id, nodes: w.nodes, schedule: w.schedule || null, description: w.description })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ workflows: list }))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
    return server
  }

  // 通用 Workflow 工具的可见性闸门（M3）：与 dyntools 工具池同一口径判定
  // （visibilityOf：private→不可见、bound 需 bind_agents 命中、缺 expose 默认 private），
  // 另加 legacy（无 edges）拒绝。不可见即拒绝执行——防模型绕过工具列表直接点名工作流 id。
  // 复用 api.load（不重复实现发现），load 的 path 缺失不影响判定。
  function canRun(id) {
    if (!id) return { ok: false, reason: '工作流 id 为空' }
    let wf = null
    try { wf = loadWorkflow({ roots, id }) } catch { wf = null }
    if (!wf) return { ok: false, reason: `工作流不存在: ${id}` }
    if (!Array.isArray(wf.edges) || !wf.edges.length) {
      return { ok: false, reason: `工作流「${id}」为旧 DSL 格式（无 edges），需先迁移再运行`, legacy: true }
    }
    const vis = visibilityOf({ ...wf, id: wf.id || id }, _agentId)
    if (!vis) return { ok: false, reason: `工作流「${id}」不可见（未公开为工具/未绑定到当前 agent）` }
    return { ok: true, vis }
  }

  // ===== 旧格式迁移 + 落盘（M7）=====
  // ⚠️ 这是**唯一的内核写「用户工作流目录」点**，且仅在被显式调用（CLI `/wf migrate`）时发生：
  // 内核其余路径（发现/加载/运行/调度/工具池）一律只读用户目录。破例理由：迁移的产物必须
  // 落盘才有生产意义——此前 migrateLegacy 只有单测与 re-export，用户侧"需升级"提示无处落地。
  // 写盘两件套（顺序固定，备份失败即中止该条、不碰原文件）：
  //   ① 备份原文 → <工作流目录>/versions/legacy-<ts>.yml（平铺 .yml 形态落在 <root>/<id>/versions/，
  //      避免同秒内两个工作流互相覆盖）
  //   ② 追加迁移生成的 edges 块（不重写全文——见 workflow-dsl.appendEdges 注释）
  // 幂等：已是 v2（有 edges）→ skipped，不写盘。
  function migrate({ id = null } = {}) {
    const result = { ok: true, migrated: [], skipped: [], errors: [] }
    const targets = []
    if (id) {
      const wf = loadWorkflow({ roots, id })
      if (!wf || !wf.path) { result.ok = false; result.errors.push({ id, error: '工作流不存在或无可写路径' }); return result }
      targets.push({ id, wf })
    } else {
      const seen = new Set()
      for (const root of roots) {
        for (const m of discoverWorkflows({ root })) {
          if (seen.has(m.id)) continue
          seen.add(m.id)
          const wf = loadWorkflow({ roots, id: m.id })
          if (wf?.path) targets.push({ id: m.id, wf })
        }
      }
    }
    for (const t of targets) {
      try {
        if (Array.isArray(t.wf.edges) && t.wf.edges.length) {
          result.skipped.push({ id: t.id, reason: '已是 DSL v2（存在 edges）' })
          continue
        }
        const { workflow, notes } = migrateLegacy(t.wf)
        // 无产出的迁移不落盘（如仅单节点）：否则会写出空 edges 块，且无法通过"已是 v2"护栏
        if (!(workflow.edges || []).length) {
          result.skipped.push({ id: t.id, reason: '迁移未产出任何边（无需落盘）', notes })
          continue
        }
        const raw = readFileSync(t.wf.path, 'utf-8')
        const dir = basename(t.wf.path).toLowerCase() === 'workflow.yml' ? dirname(t.wf.path) : join(dirname(t.wf.path), t.id)
        const backup = join(dir, 'versions', `legacy-${new Date().toISOString().replace(/[:.]/g, '-')}.yml`)
        mkdirSync(dirname(backup), { recursive: true })
        writeFileSync(backup, raw, 'utf-8')
        writeFileSync(t.wf.path, appendEdges(raw, workflow.edges), 'utf-8')
        result.migrated.push({ id: t.id, path: t.wf.path, backup, edges: (workflow.edges || []).length, notes })
      } catch (err) {
        result.errors.push({ id: t.id, error: err?.message || String(err) })
      }
    }
    result.ok = result.errors.length === 0
    return result
  }

  const api = {
    run,
    stop,
    setDeps,
    discover: (root) => discoverWorkflows({ root }),
    load: (id) => loadWorkflow({ roots, id }),
    verify: (auditPath) => verifyRun(auditPath),
    addRoot: (root) => { if (root && !roots.includes(root)) roots.push(root) },
    resolveConfirm,
    canRun,
    migrate,
    startScheduler,
    createWebhookServer,
    cronMatches,
  }
  // 创建节点执行器实例（初始 deps + engine 引用：subworkflow 节点经 engine.run 递归）
  nodeExecutor = makeNodeExecutor(api)
  return api
}
