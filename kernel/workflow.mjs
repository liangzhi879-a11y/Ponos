// kernel/workflow.mjs —— 工作流引擎（对标 Dify 功能，自有 DSL 技术路线）
//
// 与 skill 平权协同：同一发现机制（workflow.yml 目录 + 平铺 .yml）、共享 triggers
// 触发词；定位差异：skill=灵活处理（模型自由执行），workflow=严格输出（确定性
// DAG 执行 + 节点级审计哈希链）。可互调：skill 脚本中调用 Workflow 工具；工作流
// tool 节点可调用 Skill 工具加载技能脚本。
//
// DSL v2「edges 即真相」（解析/校验实现见 kernel/workflow-dsl.mjs，本文件 re-export）：
//   name/description/version/triggers   —— 元数据（triggers 与 skill 同 schema）
//   inputs: [{name, type, required}]    —— 入口参数（agentic 触发时注入）
//   nodes: [{id, type, label, position, config{...}, retry{...}}]
//   edges: [{id, source, target}]       —— 执行顺序唯一真相（无 edges = 旧格式）
// 节点专属配置写在 node.config（画布友好），加载期摊平为扁平字段（节点执行器读扁平字段）。
//
// 节点类型（P1，对标 Dify 15/26）：
//   start/end/llm/code/template/if/assign/aggregate/http/document/tool/list
//   classify/extract/memory/store/agent/iterate/loop/confirm + join/answer/subworkflow
//   （执行实现见 kernel/workflow-nodes.mjs，本文件仅持有引擎）
//
// 审计：每节点 {ts,node,type,status,dur_ms,out_hash,prev} 哈希链落盘
//   ~/.ponos/workflow-runs/<name>/<ts>-<runId>.jsonl，verifyRun 验完整性。

import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
// DSL 实现见 workflow-dsl.mjs；节点执行器见 workflow-nodes.mjs（Task 4 迁出）
import { discoverWorkflows, loadWorkflow } from './workflow-dsl.mjs'
import { executeNode, setNodeDeps } from './workflow-nodes.mjs'

// ===================== DSL（解析/变量/条件/发现/加载/校验）：兼容 re-export =====================
// DSL v2 实现见 kernel/workflow-dsl.mjs；本文件保持既有 import 面不变（cli.mjs / tools.mjs /
// kernel-tests 无需改动）。
export {
  DSL_VERSION, parseYaml, renderTemplate, resolvePath, evalCondition,
  discoverWorkflows, discoverWorkflowsAll, matchAutoTrigger, loadWorkflow,
  normalizeWorkflow, validateWorkflow, migrateLegacy,
} from './workflow-dsl.mjs'
// TODO(Task 5): export createWorkflowEngine, verifyRun from './workflow-engine.mjs'

// ===================== 审计（哈希链） =====================
function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex')
}

function auditAppend(auditPath, node, r, prevHash) {
  try { mkdirSync(dirname(auditPath), { recursive: true }) } catch { /* ignore */ }
  const rec = {
    ts: new Date().toISOString(),
    node: node.id,
    type: node.type,
    status: r.ok ? 'done' : 'failed',
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

// ===================== 节点执行器（已迁出本文件） =====================
// 节点执行器实现迁至 kernel/workflow-nodes.mjs（Task 4）：本文件不再持有 execXxx。
// 过渡接线：引擎入口/setDeps 调 setNodeDeps 注入依赖，下方 executeNode(node, ctx) 调用点
// 逐字不变（Task 5 迁引擎到 workflow-engine.mjs 后改用 createNodeExecutor 实例）。

// ===================== 引擎（执行循环 + 审计 + 事件） =====================
// createWorkflowEngine({ configDir, registry, onEvent, getModel, signal })
//   configDir: 审计落盘根（<configDir>/workflow-runs/...）
//   registry:  createToolRegistry 返回值（tool/document 节点调用）
//   onEvent:   ({type:'start'|'node'|'end', ...}) 事件回调（wire/TUI/GUI 复用）
//   getModel:  () => 默认模型名（llm 节点未指定时）
//   signal:    { aborted } 工作流级取消标志

export function createWorkflowEngine({ configDir = '', registry, onEvent, getModel, signal, memoryRoot = '' } = {}) {
  const roots = []
  let _configDir = configDir
  let _registry = registry
  let _onEvent = onEvent || (() => {})
  let _getModel = getModel || (() => process.env.ANTHROPIC_MODEL || '')
  let _signal = signal || { aborted: false }
  let _memoryRoot = memoryRoot
  // 审批门（engine 注入 gateToolUse）：内嵌工具节点执行前先经门（高危 ask/deny/
  // hook 否决）；null = 无门 → checkToolPermission 对 Bash fail-closed
  let _permissionGate = null
  let _getToolCtx = () => ({})
  // confirm 挂起队列：key = runId:nodeId → { resolve, timer }
  const confirmWaiters = new Map()

  // 节点执行器依赖（Task 4 迁出至 workflow-nodes.mjs）：过渡期经模块级注入接线，
  // 使本引擎内的 executeNode(node, ctx) 调用点逐字不变。engine 待 Task 5 落地后注入。
  setNodeDeps({ registry: _registry, getModel: _getModel, memoryRoot: _memoryRoot, engine: null })

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
    if (deps.permissionGate !== undefined) _permissionGate = deps.permissionGate
    // 2026-09-11 spec-dev：主引擎子 agent 能力注入（懒 getter——engine 的 spawnSubAgent/
    // taskSystem 在 setDeps 调用时尚处 TDZ，调用时才取）
    if (deps.getToolCtx !== undefined) _getToolCtx = deps.getToolCtx
    // 节点执行器依赖同步（Task 4 过渡接线）：cli/测试在 createWorkflowEngine 之后才 setDeps
    setNodeDeps({ registry: _registry, getModel: _getModel, memoryRoot: _memoryRoot })
  }

  function event(type, payload) {
    try { _onEvent({ type, ...payload }) } catch { /* 事件失败不阻断 */ }
  }

  // 子图执行（iterate/loop 的 body）：按 body id 顺序执行，支持显式 next 跳转；
  // 输出写入同一 vars（item/index 由外层注入），审计共享 auditState 哈希链。
  // 返回"实际执行的最后一个节点"的输出（body 内 if 路由到分支节点时，
  // 结果取分支节点而非 body 列表末位）；发 node 事件（in_body 标记）供 UI 观察进度。
  async function runBody(ctx, bodyIds) {
    const visited = new Set()
    let curId = bodyIds[0]
    let guard = 0
    let lastId = null
    while (curId && !_signal.aborted && guard++ < 200) {
      if (visited.has(curId)) throw new Error(`子图循环检测: ${curId}`)
      visited.add(curId)
      const node = ctx.nodes.get(curId)
      if (!node) throw new Error(`未知子图节点: ${curId}`)
      const r = await executeNode(node, ctx)
      lastId = curId
      if (!r.ok) throw new Error(`子图节点 ${curId} 失败: ${r.error}`)
      ctx.vars[curId] = r.output
      if (ctx.auditState?.path) ctx.auditState.prev = auditAppend(ctx.auditState.path, node, r, ctx.auditState.prev)
      ctx.event?.('node', {
        runId: ctx.runId, node: node.id, type: 'node', node_type: node.type, status: 'done',
        dur_ms: r.dur_ms, output: r.output, in_body: true,
      })
      const idx = bodyIds.indexOf(curId)
      curId = r.next !== undefined && r.next !== null ? r.next : (idx >= 0 && idx < bodyIds.length - 1 ? bodyIds[idx + 1] : null)
    }
    return lastId ? ctx.vars[lastId] : undefined
  }

  async function run({ id, inputs = {}, mode = 'sync' } = {}) {
    const wf = loadWorkflow({ roots, id })
    if (!wf) return { ok: false, error: `工作流不存在: ${id}` }
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const auditPath = _configDir ? join(_configDir, 'workflow-runs', wf.name || id, `${ts}-${runId}.jsonl`) : ''
    const vars = { inputs: { ...inputs }, var: {}, root: {} }
    const nodes = new Map(wf.nodes.map((n) => [n.id, n]))
    const auditState = { path: auditPath, prev: '-' }
    // 子图专用节点：loop/iterate 的 body 成员 + 经 next 可达的节点（传递闭包）。
    // 它们只经 runBody 执行，主循环按数组顺序推进时必须跳过，否则会被误执行。
    const bodyOnly = new Set()
    for (const n of wf.nodes) {
      if ((n.type === 'loop' || n.type === 'iterate') && Array.isArray(n.body)) {
        for (const id of n.body) {
          if (bodyOnly.has(id)) continue
          bodyOnly.add(id)
          const q = [id]
          while (q.length) {
            const cid = q.shift()
            const cn = nodes.get(cid)
            if (!cn) continue
            for (const nx of [cn.next, cn.next_true, cn.next_false]) {
              if (!nx || bodyOnly.has(nx)) continue
              const nxNode = nodes.get(nx)
              if (nxNode && nxNode.type !== 'start' && nxNode.type !== 'end') { bodyOnly.add(nx); q.push(nx) }
            }
          }
        }
      }
    }
    // start 节点：无则用第一个节点
    let cur = wf.nodes.find((n) => n.type === 'start') || wf.nodes[0]
    const visited = new Set()
    const results = {}
    event('start', { runId, workflow: wf.name || id, nodes: wf.nodes.length, mode })
    let nextId = cur.id
    let steps = 0
    while (nextId && !_signal.aborted) {
      if (steps > 500) return { ok: false, error: '执行步数超限（可能死循环）', runId, auditPath }
      if (visited.has(nextId)) return { ok: false, error: `节点循环检测: ${nextId}`, runId, auditPath }
      visited.add(nextId)
      const node = nodes.get(nextId)
      if (!node) return { ok: false, error: `未知节点: ${nextId}`, runId, auditPath }
      const ctx = { vars, results, inputs, registry: _registry, signal: _signal, getModel: _getModel, nodes, auditState, memoryRoot: _memoryRoot, runBody, runId, event, confirmWaiters: { create: createConfirmWaiter }, permissionGate: _permissionGate, getToolCtx: _getToolCtx }
      const r = await executeNode(node, ctx)
      results[node.id] = r
      if (r.ok) {
        vars[node.id] = r.output
        if (typeof r.output === 'object' && r.output !== null) Object.assign(vars.root, r.output)
      }
      auditState.prev = auditPath ? auditAppend(auditPath, node, r, auditState.prev) : auditState.prev
      event('node', { runId, node: node.id, type: 'node', node_type: node.type, status: r.ok ? 'done' : 'failed', dur_ms: r.dur_ms, output: r.ok ? r.output : undefined, error: r.ok ? undefined : r.error })
      if (!r.ok && node.on_error !== 'continue') {
        event('end', { runId, status: 'failed', error: r.error, steps: steps + 1 })
        return { ok: false, error: r.error, node: node.id, runId, auditPath }
      }
      // 确定下一个节点：节点 next 显式 → if 分支已定 → 否则数组顺序
      // （跳过子图专用节点——它们只能由 loop/iterate 的 runBody 执行）
      nextId = r.next !== undefined && r.next !== null ? r.next : null
      if (!nextId) {
        let idx = wf.nodes.findIndex((n) => n.id === cur.id)
        while (idx >= 0 && idx < wf.nodes.length - 1) {
          idx++
          const cand = wf.nodes[idx]
          if (cand && !bodyOnly.has(cand.id)) { nextId = cand.id; break }
        }
      }
      cur = nodes.get(nextId) || cur
      steps++
    }
    const status = _signal.aborted ? 'cancelled' : 'completed'
    event('end', { runId, status, steps })
    return { ok: true, status, outputs: results, runId, auditPath, steps }
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
  // 防重：sameMinute 记录已触发（同分钟内不重复）。返回 stop()。
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

  return {
    run,
    setDeps,
    discover: (root) => discoverWorkflows({ root }),
    load: (id) => loadWorkflow({ roots, id }),
    verify: (auditPath) => verifyRun(auditPath),
    addRoot: (root) => { if (root && !roots.includes(root)) roots.push(root) },
    resolveConfirm,
    startScheduler,
    createWebhookServer,
    cronMatches,
  }
}
