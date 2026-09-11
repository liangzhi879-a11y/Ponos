// kernel/workflow-nodes.mjs —— 工作流节点执行器（Task 4：从 kernel/workflow.mjs 平移）
//
// 职责：单个节点的执行（llm/agent/code/template/if/assign/aggregate/http/document/tool/
// list/classify/extract/memory/store/iterate/loop/confirm/join/answer/subworkflow）。
// 调度（顺序、并行、条件分支、跳过传播）由 kernel/workflow-dag.mjs 的 schedule 负责——
// 本模块**不再**返回 next/next_true/next_false（edges 即真相）；分支节点只表达 route：
//   if       → route 'true' | 'false'
//   classify → route 'route:<i>'（类目下标；未命中任何类目 → 'default'）
//
// 零外部运行时依赖：只 import node:* 与仓库内相对路径。
//
// 依赖注入（两种用法）：
//   ① 工厂：const exec = createNodeExecutor({ registry, getModel, memoryRoot, engine })
//   ② 模块级默认实例（供尚未搬迁的旧引擎 kernel/workflow.mjs 过渡使用）：
//      setNodeDeps({ registry, getModel, memoryRoot, engine }); await executeNode(node, ctx)
//   Task 5 的 createWorkflowEngine 走 ①（deps 形状见 createNodeExecutor 形参）。

import { createContext, runInContext } from 'node:vm'
import { streamMessages } from './api.mjs'
import { buildRelevantMemory, appendMemoryEntry } from './memory.mjs'
import { renderTemplate, resolvePath, evalCondition } from './workflow-dsl.mjs'
import { schedule } from './workflow-dag.mjs'

export function createNodeExecutor({ registry = null, getModel = () => '', memoryRoot = '', engine = null } = {}) {
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

  // 公共 LLM 文本请求（llm/classify/extract 共用）：模板渲染 prompt → 流式聚合文本 →
  // 可选 JSON 解析。返回聚合文本（json_schema 时可能为解析后的对象）
  async function callLLMText(model, prompt, node, vars, maxTokens = 4096) {
    const system = node.system ? renderTemplate(node.system, vars) : ''
    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ]
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), node.timeout_ms || 60_000)
    let text = ''
    try {
      for await (const chunk of streamMessages({ model, messages, maxTokens, signal: ctrl.signal })) {
        if (chunk.type === 'text') text += chunk.text
      }
    } finally { clearTimeout(timer) }
    if (node.json_schema) {
      const m = text.match(/\{[\s\S]*\}/)
      try { text = JSON.parse(m ? m[0] : text) } catch { /* 非 JSON 保留原文 */ }
    }
    return text
  }

  // agent 节点：工作流内嵌 ReAct 循环（独立对话，不污染主会话 transcript）。
  // 工具执行走 registry（权限/边界/高危钩子沿用）；tools 白名单可选，缺省全量。
  async function runAgentLoop({ prompt, system = '', tools = [], model, signal, registry, permissionGate = null, maxIters = 8, timeoutMs = 120_000, getToolCtx = () => ({}) }) {
    if (!model) throw new Error('agent 节点缺少 model（未配置 provider）')
    const messages = []
    if (system) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: prompt })
    const allSchemas = registry?.toolSchemas ? registry.toolSchemas() : []
    const schemas = tools && tools.length ? allSchemas.filter((t) => tools.includes(t.name)) : allSchemas
    let text = ''
    for (let i = 0; i < maxIters; i++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      const toolUses = []
      let roundText = ''
      try {
        for await (const chunk of streamMessages({ model, messages, maxTokens: 8192, signal: ctrl.signal, tools: schemas })) {
          if (chunk.type === 'text') roundText += chunk.text
          else if (chunk.type === 'tool_use') toolUses.push(chunk)
        }
      } finally { clearTimeout(timer) }
      if (!toolUses.length) return { text: roundText || text, iters: i + 1, tool_uses: i }
      text = roundText
      messages.push({
        role: 'assistant',
        content: [
          ...(roundText ? [{ type: 'text', text: roundText }] : []),
          ...toolUses.map((tu) => ({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })),
        ],
      })
      const results = []
      for (const tu of toolUses) {
        // agent 内嵌工具同样过审批门（防止工作流 agent 节点旁路主会话高危审批）
        const gate = await checkToolPermission({ permissionGate, registry }, tu.name, tu.input || {})
        if (gate.denied) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: gate.message, is_error: true })
          continue
        }
        try {
          const r = await registry.run({ name: tu.name, input: tu.input }, getToolCtx?.() || {})
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(r?.content ?? '').slice(0, 20000), is_error: r?.isError === true })
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: `执行异常: ${err?.message || String(err)}`, is_error: true })
        }
      }
      messages.push({ role: 'user', content: results })
    }
    return { text: text || '（达到最大迭代次数）', iters: maxIters, tool_uses: maxIters }
  }

  async function execLLM(node, ctx) {
    const model = node.model || ctx.getModel?.() || getModel()
    if (!model) throw new Error('llm 节点缺少 model（未配置 provider）')
    const prompt = renderTemplate(node.prompt || '', ctx.vars)
    const out = await callLLMText(model, prompt, node, ctx.vars, node.max_tokens || 4096)
    return { output: out }
  }

  // classify：LLM 分类 → 输出 category/class_index，route 表达命中类目（'route:<i>'；
  // 未命中任何类目 → 'default'，由调度器激活 default 边）
  async function execClassify(node, ctx) {
    const model = node.model || ctx.getModel?.() || getModel()
    if (!model) throw new Error('classify 节点缺少 model')
    const query = renderTemplate(node.query || node.input || '', ctx.vars)
    const classes = node.classes || []
    if (!classes.length) throw new Error('classify 节点缺少 classes')
    const instruction = node.instruction || '将输入分类到最合适的一类'
    const prompt = `${instruction}\n\n输入：\n${query}\n\n可选类别（只输出类别名本身，不要编号和解释）：\n${classes.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    const raw = await callLLMText(model, prompt, node, ctx.vars, 512)
    let category = String(raw).trim().replace(/^["'\d.\s-]+|["']$/g, '')
    let idx = classes.findIndex((c) => category === c || category.includes(c) || c.includes(category))
    if (idx < 0) {
      const num = parseInt(category, 10)
      if (Number.isFinite(num) && num >= 1 && num <= classes.length) idx = num - 1
    }
    category = idx >= 0 ? classes[idx] : category
    return { output: { category, class_index: idx, raw }, route: idx >= 0 ? `route:${idx}` : 'default' }
  }

  // extract：LLM 按 JSON schema 提取字段（对标 Dify parameter-extractor）
  async function execExtract(node, ctx) {
    const model = node.model || ctx.getModel?.() || getModel()
    if (!model) throw new Error('extract 节点缺少 model')
    const query = renderTemplate(node.query || node.input || '', ctx.vars)
    const instruction = node.instruction || '从输入中提取指定字段'
    const params = node.parameters || []
    if (!params.length) throw new Error('extract 节点缺少 parameters')
    const schemaDesc = params.map((p) => `- ${p.name}${p.required ? '（必填）' : '（可选）'}: ${p.type || 'string'}${p.description ? ' — ' + p.description : ''}`).join('\n')
    const prompt = `${instruction}\n\n输入：\n${query}\n\n只输出一个 JSON 对象（不要 markdown 代码块、不要解释），字段定义：\n${schemaDesc}`
    const raw = await callLLMText(model, prompt, node, ctx.vars, 1024)
    const m = String(raw).match(/\{[\s\S]*\}/)
    try {
      const parsed = JSON.parse(m ? m[0] : String(raw))
      return { output: { ...parsed, _raw: String(raw).slice(0, 500) } }
    } catch {
      return { output: { _raw: String(raw).slice(0, 2000) } }
    }
  }

  // memory：语义检索（复用 buildRelevantMemory 关键词匹配）
  async function execMemory(node, ctx) {
    const query = renderTemplate(node.query || node.input || '', ctx.vars)
    const keywords = String(query).split(/[\s,，、;；]+/).filter(Boolean)
    const root = ctx.memoryRoot || memoryRoot || ''
    const text = root ? buildRelevantMemory({ root, keywords, maxBytes: node.max_bytes || 2048 }) : '（未配置记忆库根目录）'
    return { output: { text, keywords } }
  }

  // store：记忆写入（复用 appendMemoryEntry）
  async function execStore(node, ctx) {
    const root = ctx.memoryRoot || memoryRoot || ''
    if (!root) throw new Error('store 节点需要记忆库根目录（未注入 memoryRoot）')
    const theme = renderTemplate(node.theme || node.topic || '', ctx.vars)
    const summary = renderTemplate(node.summary || '', ctx.vars)
    const full = renderTemplate(node.full || node.content || '', ctx.vars)
    const tag = renderTemplate(node.tag || '', ctx.vars)
    if (!theme || !summary) throw new Error('store 节点缺少 theme/summary')
    const ok = appendMemoryEntry({ root, theme, tag: tag || null, summary, full })
    return { output: { ok: !!ok, theme, tag } }
  }

  // 子图调度结果判定：schedule 形态带 settled（Map）；旧引擎注入的 runBody 返回裸输出。
  const isScheduleResult = (r) => !!r && typeof r === 'object' && r.settled instanceof Map
  const unwrapBody = (r) => (isScheduleResult(r) ? r.output : r)

  // iterate：数组迭代（is_parallel 并行，parallel_nums 并发度）；每项注入 item/index
  // 执行 body 子图（由 ctx.runBody 递归调度），聚合各次 body 末节点输出
  async function execIterate(node, ctx) {
    const arr = resolvePath(ctx.vars, node.iterable || node.input || '')
    if (!Array.isArray(arr)) throw new Error(`iterate 输入不是数组: ${node.iterable}`)
    const body = node.body || []
    if (!body.length) throw new Error('iterate 节点缺少 body（子节点 id 列表）')
    const runBodyFn = ctx.runBody
    if (typeof runBodyFn !== 'function') throw new Error('iterate 节点不可用：未注入子图调度（ctx.runBody）')
    const out = []
    const parallel = node.is_parallel === true
    const nums = Math.max(1, Number(node.parallel_nums || 1))
    const items = arr.map((item, index) => ({ item, index }))
    const runOne = async ({ item, index }) => {
      const vars = { ...ctx.vars, item, index }
      const sub = { ...ctx, vars }
      const r = await runBodyFn(sub, body, { item, index })
      if (isScheduleResult(r) && !r.ok) throw new Error(`iterate 子图执行失败: ${r.error}`)
      return unwrapBody(r)
    }
    if (parallel) {
      for (let i = 0; i < items.length; i += nums) {
        const batch = items.slice(i, i + nums)
        const rs = await Promise.all(batch.map(runOne))
        out.push(...rs)
      }
    } else {
      for (const it of items) out.push(await runOne(it))
    }
    return { output: out }
  }

  // loop：循环（count 次数 + while_conditions 轮前检查 + break_conditions 提前终止）；
  // 每轮注入 iter/index 执行 body 子图（ctx.runBody 递归调度）。count 支持模板渲染。
  // continue_on_error=true 时单轮失败记录 {__error} 继续；max_duration_ms 为整循环时间预算。
  // 注意：loop 不做并行（轮间共享 var 状态，并行会竞态）——并行迭代用 iterate.is_parallel。
  async function execLoop(node, ctx) {
    const body = node.body || []
    if (!body.length) throw new Error('loop 节点缺少 body')
    const runBodyFn = ctx.runBody
    if (typeof runBodyFn !== 'function') throw new Error('loop 节点不可用：未注入子图调度（ctx.runBody）')
    const rawCount = Number(renderTemplate(String(node.count ?? 3), ctx.vars))
    const count = Number.isFinite(rawCount) ? Math.max(1, rawCount) : 3
    const out = []
    const contOnErr = node.continue_on_error === true
    const maxDur = Number(node.max_duration_ms || 0)
    const t0 = Date.now()
    const whiles = node.while_conditions || []
    const breaks = node.break_conditions || []
    for (let i = 0; i < count && !ctx.signal?.aborted; i++) {
      if (maxDur > 0 && Date.now() - t0 > maxDur) break
      // while 条件（轮前检查）：不满足立即终止（对标 while/until 语义）
      if (whiles.length) {
        const pass = whiles.every((c) => evalCondition(c, { ...ctx.vars, iter: i, index: i }))
        if (!pass) break
      }
      const vars = { ...ctx.vars, iter: i, index: i }
      const sub = { ...ctx, vars }
      let last
      if (contOnErr) {
        // continue_on_error：单轮失败记录 {__error} 后继续下一轮，不终止整个 loop
        try {
          last = await runBodyFn(sub, body, { iter: i, index: i })
          if (isScheduleResult(last) && !last.ok) throw new Error(last.error || '子图执行失败')
        } catch (err) { last = { __error: err?.message || String(err), __iter: i } }
      } else {
        last = await runBodyFn(sub, body, { iter: i, index: i })
        if (isScheduleResult(last) && !last.ok) throw new Error(`loop 子图执行失败: ${last.error}`)
      }
      out.push(unwrapBody(last))
      // break 条件（对标 Dify loop break_conditions）：本轮执行后检查（读本轮 vars，
      // 子图节点输出已按 id 写入 sub.vars）
      if (breaks.length) {
        const pass = breaks.every((c) => evalCondition(c, sub.vars))
        if (pass) return { output: { results: out, iterations: i + 1, broken: true } }
      }
    }
    return { output: { results: out, iterations: out.length, broken: false } }
  }

  // agent：工作流内嵌对话式执行（ReAct 循环，工具白名单可选）
  async function execAgent(node, ctx) {
    const prompt = renderTemplate(node.prompt || node.query || '', ctx.vars)
    const system = renderTemplate(node.system || '', ctx.vars)
    const model = node.model || ctx.getModel?.() || getModel()
    const r = await runAgentLoop({
      prompt, system, tools: node.tools || [], model,
      signal: ctx.signal, registry: ctx.registry || registry, permissionGate: ctx.permissionGate,
      maxIters: node.max_iters || 8, timeoutMs: node.timeout_ms || 120_000,
      getToolCtx: ctx.getToolCtx,
    })
    return { output: { text: r.text, iters: r.iters, tool_uses: r.tool_uses } }
  }

  // confirm：人工审批节点（对标 Dify human-input）。发 confirm_request 事件后挂起，
  // 等待外部 resolveConfirm（TUI /wf approve|reject / 协议层 workflow_confirm）或超时。
  // 审批结果表达在 output.action（approved/rejected/timeout）；分支由 edges 的 handle 决定
  // ——v2 的 confirm handle 名待定（Task 5 定名后再生成条件边），故本节点暂不返回 route。
  async function execConfirm(node, ctx) {
    const message = renderTemplate(node.message || node.prompt || '请确认', ctx.vars)
    const runId = ctx.runId || ''
    const nodeId = node.id
    const timeoutMs = node.timeout_ms || 300_000
    const waiter = ctx.confirmWaiters?.create ? ctx.confirmWaiters.create(runId, nodeId, timeoutMs) : null
    ctx.event?.('confirm_request', { runId, node: nodeId, message, inputs: node.inputs || [], timeout_ms: timeoutMs })
    if (!waiter) return { output: { action: 'approved', comment: '' } }
    const r = await waiter.promise
    ctx.event?.('confirm_resolved', { runId, node: nodeId, action: r.action, comment: r.comment, timed_out: r.timed_out })
    if (r.timed_out) return { output: { action: 'timeout', comment: r.comment || '' } }
    if (r.action === 'rejected') return { output: { action: 'rejected', comment: r.comment || '' } }
    return { output: { action: 'approved', comment: r.comment || '' } }
  }

  function execCode(node, ctx) {
    const code = node.code || ''
    const inputVars = {}
    for (const v of node.variables || []) {
      inputVars[v.variable || v.name] = resolvePath(ctx.vars, v.selector || v.value || '')
    }
    const sandbox = createContext({ inputs: inputVars, JSON, Math, Date, console })
    const result = runInContext(`(function(){ ${code}\n; return typeof main === 'function' ? main(inputs) : inputs })()`, sandbox, {
      timeout: node.timeout_ms || 10_000,
    })
    return { output: result }
  }

  function execTemplate(node, ctx) {
    return { output: renderTemplate(node.template || '', ctx.vars) }
  }

  // if：条件分支。route 精确等于边的 sourceHandle（'true' | 'false'），调度器据此激活分支。
  function execIf(node, ctx) {
    const conds = node.conditions || []
    const logic = node.logical_operator || 'and'
    const pass = logic === 'or' ? conds.some((c) => evalCondition(c, ctx.vars)) : conds.every((c) => evalCondition(c, ctx.vars))
    return { output: { pass }, route: pass ? 'true' : 'false' }
  }

  function execAssign(node, ctx) {
    const items = node.items || []
    for (const it of items) {
      const name = it.variable || it.name
      if (!name) continue
      const val = resolvePath(ctx.vars, it.value || it.selector || '')
      const cur = ctx.vars.var[name]
      const op = it.operation || 'over-write'
      if (op === 'append') {
        ctx.vars.var[name] = Array.isArray(cur) ? [...cur, val] : (cur !== undefined ? [cur, val] : [val])
      } else if (op === 'clear') {
        ctx.vars.var[name] = null
      } else {
        ctx.vars.var[name] = val
      }
    }
    return { output: ctx.vars.var }
  }

  function execAggregate(node, ctx) {
    const vars = node.variables || []
    const outType = node.output_type || 'string'
    if (outType === 'array') {
      return { output: vars.map((v) => resolvePath(ctx.vars, v.selector || v)) }
    }
    const sep = node.separator ?? '\n'
    return { output: vars.map((v) => String(resolvePath(ctx.vars, v.selector || v) ?? '')).join(sep) }
  }

  async function execHttp(node, ctx) {
    const url = renderTemplate(node.url || '', ctx.vars)
    if (!url) throw new Error('http 节点缺少 url')
    const method = (node.method || 'GET').toUpperCase()
    const headers = {}
    for (const [k, v] of Object.entries(renderTemplate(node.headers || '', ctx.vars) ? parseHeaderLines(node.headers) : {})) headers[k] = v
    let body
    if (node.body) {
      const bt = node.body.type || 'json'
      if (bt === 'json') {
        const data = {}
        for (const d of node.body.data || []) data[d.key] = renderTemplate(String(d.value ?? ''), ctx.vars)
        body = JSON.stringify(data)
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
      } else if (bt === 'raw') {
        body = renderTemplate(String(node.body.raw || ''), ctx.vars)
      }
    }
    const auth = node.authorization || {}
    if (auth.type === 'bearer') headers['Authorization'] = `Bearer ${renderTemplate(String(auth.token || ''), ctx.vars)}`
    if (auth.type === 'api-key') headers[auth.header || 'X-API-Key'] = renderTemplate(String(auth.token || ''), ctx.vars)
    const timeout = (node.timeout || {}).read || node.timeout_ms || 60_000
    const retry = node.retry?.enabled ? Math.max(0, Number(node.retry.max_retries || 1)) : 0
    let attempt = 0
    let lastErr
    while (attempt <= retry) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const res = await fetch(url, { method, headers, body, signal: ctrl.signal })
        const text = await res.text()
        let parsed = text
        try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
        return {
          output: { status_code: res.status, body: parsed, headers: Object.fromEntries(res.headers) },
        }
      } catch (err) {
        lastErr = err
        attempt++
        if (attempt <= retry) await sleep(Math.min(500 * Math.pow(2, attempt - 1), 10_000))
      } finally { clearTimeout(timer) }
    }
    throw lastErr || new Error('http 请求失败')
  }

  function parseHeaderLines(headersStr) {
    const out = {}
    for (const line of String(headersStr || '').split('\n')) {
      const idx = line.indexOf(':')
      if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    return out
  }

  // —— 工作流内嵌工具执行前的审批门 ——
  // 工作流 tool/document/agent 节点经 registry 直接跑工具，须与主 agent 会话同等
  // 遵守权限决策（高危 Bash ask 审批 / deny / hooks.preToolUse 否决），避免经
  // Workflow 工具旁路主会话审批（engine 经 setDeps({ permissionGate }) 注入门）。
  // 无门（脱离 engine 独立跑：纯测试/直连）时收敛高危面：Bash fail-closed 拒绝，
  // 其余工具边界仍由工具自身强制（allowDirs 等）。
  let wfToolSeq = 0
  async function checkToolPermission(ctx, name, input) {
    const gate = ctx?.permissionGate
    if (typeof gate !== 'function') {
      if (name === 'Bash') return { denied: true, message: '当前工作流无审批通道：Bash 工具默认拒绝执行（请在交互会话中运行该工作流，由引擎审批门放行）' }
      return { denied: false }
    }
    let d
    try {
      d = await gate({ id: `wf-${Date.now().toString(36)}-${(++wfToolSeq).toString(36)}`, name, input })
    } catch (err) {
      return { denied: true, message: `工具权限校验异常：${err?.message || String(err)}` }
    }
    if (!d?.allowed) return { denied: true, message: d?.message || '该工具调用被拒绝' }
    return { denied: false }
  }

  async function execDocument(node, ctx) {
    const filePath = renderTemplate(node.input || node.file || '', ctx.vars)
    if (!filePath) throw new Error('document 节点缺少 input')
    const reg = ctx.registry || registry
    const gate1 = await checkToolPermission(ctx, 'Read', { file_path: filePath })
    if (!gate1.denied) {
      const readRes = await reg.run({ name: 'Read', input: { file_path: filePath } }, {})
      if (!readRes.isError) return { output: { text: readRes.content } }
    }
    const gate2 = await checkToolPermission(ctx, 'OCR', { file_path: filePath })
    if (!gate2.denied) {
      const ocrRes = await reg.run({ name: 'OCR', input: { file_path: filePath } }, {})
      if (!ocrRes.isError) return { output: { text: ocrRes.content } }
    }
    throw new Error(`document 读取失败: ${filePath}（Read ${gate1.denied ? '被拒绝: ' + gate1.message : '无内容/失败'}，OCR ${gate2.denied ? '被拒绝: ' + gate2.message : '无内容/失败'}）`)
  }

  async function execTool(node, ctx) {
    const name = node.tool || node.name
    if (!name) throw new Error('tool 节点缺少 tool 字段')
    const input = {}
    for (const [k, v] of Object.entries(node.input || {})) input[k] = renderTemplate(String(v), ctx.vars)
    const gate = await checkToolPermission(ctx, name, input)
    if (gate.denied) return { output: gate.message, isError: true }
    const res = await (ctx.registry || registry).run({ name, input }, ctx.getToolCtx?.() || {})
    return { output: res.content, isError: res.isError === true }
  }

  function execList(node, ctx) {
    const arr = resolvePath(ctx.vars, node.variable || '')
    if (!Array.isArray(arr)) throw new Error(`list 节点输入不是数组: ${node.variable}`)
    let out = [...arr]
    if (node.filter_by?.enabled && node.filter_by.key && node.filter_by.op) {
      out = out.filter((item) => evalCondition({ var: node.filter_by.key, op: node.filter_by.op, value: node.filter_by.value }, { root: item }))
    }
    if (node.order_by?.enabled && node.order_by.key) {
      const key = node.order_by.key
      out.sort((a, b) => {
        const av = a?.[key]; const bv = b?.[key]
        if (node.order_by.order === 'desc') return bv > av ? 1 : bv < av ? -1 : 0
        return av > bv ? 1 : av < bv ? -1 : 0
      })
    }
    if (node.extract_by?.enabled) {
      const serial = node.extract_by.serial || 'first'
      if (serial === 'first') out = out[0]
      else if (serial === 'last') out = out[out.length - 1]
    }
    return { output: out }
  }

  // join：多分支汇聚（DAG 的 join 语义由调度器保证——全部入边 settle 且至少一条 active
  // 才执行；本节点只负责把各分支输出按 mode 聚合）。
  //   mode='array'  → 原值数组（保持类型，供下游 code/list 节点使用）
  //   mode='first'  → 第一个非空值
  //   mode='concat' → 按 separator（默认换行）拼接字符串
  function execJoin(node, ctx) {
    const mode = node.mode || 'concat'
    const sels = node.sources || []
    const vals = sels.map((s) => resolvePath(ctx.vars, s))
    const output = mode === 'array'
      ? vals
      : mode === 'first'
        ? (vals.find((v) => v !== undefined && v !== null) ?? null)
        : vals.map((v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join(node.separator ?? '\n')
    return { output }
  }

  // answer：终端输出节点（对标 Dify answer）——输出 answer 文本，运行时在 end/answer 处收束
  function execAnswer(node, ctx) {
    const text = node.template ? renderTemplate(node.template, ctx.vars) : String(resolvePath(ctx.vars, node.value || '') ?? '')
    return { output: { answer: text, ...(node.variable ? { [node.variable]: text } : {}) } }
  }

  // subworkflow：调用子工作流（engine.run 由 Task 5 的 createWorkflowEngine 注入；
  // ctx.depth 由引擎透传，深度上限 5 防自递归）。子工作流的 outputs 作为本节点输出。
  async function execSubworkflow(node, ctx) {
    const depth = Number(ctx.depth || 0)
    if (depth >= 5) throw new Error('subworkflow 调用深度超限（>=5，疑似递归）')
    if (!engine?.run) throw new Error('subworkflow 节点不可用：引擎未注入')
    const wid = renderTemplate(String(node.workflow || ''), ctx.vars)
    const sub = {}
    for (const [k, v] of Object.entries(node.inputs || {})) sub[k] = typeof v === 'string' ? renderTemplate(v, ctx.vars) : v
    const r = await engine.run({ id: wid, inputs: sub, depth: depth + 1 })
    if (!r.ok) throw new Error(`子工作流 ${wid} 失败: ${r.error}`)
    return { output: r.outputs ?? {} }
  }

  // 子图执行（loop/iterate 的 body）：复用调度器 schedule 递归执行子图。
  // 作用域 = body 成员集合：节点按 bodyIds 过滤，边**只取子图内部边**（跨边界边不进入
  // 子图；validateWorkflow 的 BODY_ESCAPE 已禁止，此处再兜一层）。
  // 子图节点输出按 id 写入共享 vars（本轮内可见，供下游引用与 break/while 条件读取）。
  async function runBody(ctx, bodyIds, extraVars = {}) {
    const ids = bodyIds || []
    const allNodes = Array.isArray(ctx.childNodes) ? ctx.childNodes : (ctx.nodes?.values ? [...ctx.nodes.values()] : [])
    const nodes = ids.map((id) => allNodes.find((n) => n.id === id)).filter(Boolean)
    const edges = (Array.isArray(ctx.childEdges) ? ctx.childEdges : []).filter((e) => ids.includes(e.source) && ids.includes(e.target))
    const vars = ctx.vars || {}
    for (const [k, v] of Object.entries(extraVars)) vars[k] = v
    const r = await schedule({
      nodes, edges, inputs: ctx.inputs, runId: ctx.runId, signal: ctx.signal,
      maxParallel: ctx.maxParallel ?? 4,
      executeNode: async (n, sub) => {
        const res = await executeNode(n, { ...ctx, ...sub, vars, var: ctx.var })
        if (res?.ok) vars[n.id] = res.output
        return res
      },
      onSettle: (s) => ctx.onNodeSettled?.({ ...s, in_body: true }),
      onEdge: (s) => ctx.onEdge?.({ ...s, in_body: true }),
    })
    const lastId = [...r.settled.keys()].pop()
    return { ok: r.ok, output: r.settled.get(lastId)?.output, settled: r.settled, iterations: r.steps, error: r.error }
  }

  async function dispatch(node, ctx) {
    switch (node.type) {
      case 'start': return { output: { ...ctx.inputs } }
      case 'end': {
        const out = {}
        for (const o of node.outputs || []) out[o.variable || o.name] = resolvePath(ctx.vars, o.selector || o.value || o.variable || '')
        return { output: out }
      }
      case 'llm': return execLLM(node, ctx)
      case 'code': return execCode(node, ctx)
      case 'template': return execTemplate(node, ctx)
      case 'if': return execIf(node, ctx)
      case 'assign': return execAssign(node, ctx)
      case 'aggregate': return execAggregate(node, ctx)
      case 'http': return execHttp(node, ctx)
      case 'document': return execDocument(node, ctx)
      case 'tool': return execTool(node, ctx)
      case 'list': return execList(node, ctx)
      case 'classify': return execClassify(node, ctx)
      case 'extract': return execExtract(node, ctx)
      case 'memory': return execMemory(node, ctx)
      case 'store': return execStore(node, ctx)
      case 'agent': return execAgent(node, ctx)
      case 'iterate': return execIterate(node, ctx)
      case 'loop': return execLoop(node, ctx)
      case 'confirm': return execConfirm(node, ctx)
      case 'join': return execJoin(node, ctx)
      case 'answer': return execAnswer(node, ctx)
      case 'subworkflow': return execSubworkflow(node, ctx)
      default: throw new Error(`未知节点类型: ${node.type}`)
    }
  }

  // 变量作用域归一化：变量环境 = { inputs, var, <nodeId>: output, ... }（见 workflow-dsl）。
  // 引擎传入的 ctx.vars 已含 inputs/var（原样沿用，保持对象同一性——赋值节点写 vars.var
  // 的副作用必须对外层可见）；独立执行/测试传 { inputs, vars, var } 形状时补齐缺失键，
  // 并把 ctx.var 这个引用直接挂进作用域（不复制，赋值结果对调用方可见）。
  function normalizeScope(ctx) {
    const src = ctx?.vars
    const vars = (src && typeof src === 'object') ? src : {}
    const needInputs = vars.inputs === undefined && ctx?.inputs !== undefined
    const needVar = vars.var === undefined
    if (!needInputs && !needVar) return vars
    return { ...vars, ...(needInputs ? { inputs: ctx.inputs } : {}), ...(needVar ? { var: ctx.var || {} } : {}) }
  }

  // 归一化包装：抛错自动转 { ok:false, error }（与旧 executeNode 行为一致）。
  // 未注入 ctx.runBody 时（独立执行/测试）注入本执行器的调度式子图实现。
  // 注意：runBody 经闭包引用本 const（不得引用模块级同名导出，否则工厂实例的子图
  // 会串到模块级默认实例的 deps 上）。
  const executeNode = async (node, ctx) => {
    const t0 = Date.now()
    const vars = normalizeScope(ctx)
    const c = {
      ...(ctx || {}),
      vars,
      ...(typeof ctx?.runBody === 'function' ? {} : { runBody: (sub, ids, extra) => runBody(sub || ctx, ids, extra) }),
    }
    try {
      const r = await dispatch(node, c)
      return { ok: true, ...r, dur_ms: Date.now() - t0 }
    } catch (err) {
      return { ok: false, error: err?.message || String(err), dur_ms: Date.now() - t0 }
    }
  }
  return executeNode
}

// ===================== 模块级默认实例（过渡期兼容） =====================
// 旧引擎（kernel/workflow.mjs，Task 5 才迁到 workflow-engine.mjs）内的 executeNode 调用
// 迁移期走这里：引擎入口/ setDeps 调 setNodeDeps 注入依赖，其余调用点逐字不变。
// Task 5 完成后可删（引擎改持 createNodeExecutor 的实例）。
let _deps = {}
export function setNodeDeps(deps = {}) { _deps = { ..._deps, ...deps } }
export async function executeNode(node, ctx) { return createNodeExecutor(_deps)(node, ctx) }
