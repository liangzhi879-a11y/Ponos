// YFW-turbo Agent 循环（docs/bridge-contract.md §9 替换面）
// ---------------------------------------------------------------------------
// runTurn：user 消息入 session → 循环调用 api.streamMessages：
//   - 文本/思考块 → wire.assistant 流式转发
//   - tool_use 块 → 权限判定（高危 Bash → can_use_tool 挂起等 control_response）
//     → tools 执行 → tool_result 经 session.appendToolResult 落盘 → 再调 API，
//     直到模型输出纯文本
// 取消：cli 调 engine.abort()，流循环在检查点抛 AbortError → cli 输出
// '已取消。' + result（契约 §8，进程保留可续聊）。
// 消息源：transcript 是权威源——请求消息一律 session.deriveMessages() 派生；
// session 缺省时退化为内存数组（测试直连场景），无 seedHistory 机制。
// usage：chunk 逐次 addUsage 累计（input/output/cache 各字段），替代覆盖赋值。
// 观测：每轮尾部产出 turnStats（usage/durationMs/model/ts/compactCount），
// health/result/stats 三个消费者共用；result 事件由 engine 发出（cli 不再重复）。
import { streamMessages, classifyApiError } from './api.mjs'
import { abortError } from './protocol.mjs'
import { decideToolPermission } from './permissions.mjs'
import { createToolRegistry, killActiveChildren } from './tools.mjs'
import { createSessionStore, newSessionId } from './session.mjs'
import { resolveAgent, resolveAgents } from './agents.mjs'
import { getProvider } from './provider.mjs'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

// 工具循环上限：真实多步任务（探查→修复→测试）需 20+ 次工具调用，10 会在
// 探索中打断模型（SWE 类任务实测 toolCalls 全部卡在 11-13）。提升至 50，
// 与 claude/pi/deepseek 无上限对齐，仍受评测/交互整体超时约束。
const MAX_TOOL_ITERATIONS = 50

// usage 逐次累加（input/output/cache 各字段），修复"多次 API 调用只记最后一次"
function addUsage(acc, u = {}) {
  const out = { ...acc }
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    out[k] = (acc[k] ?? 0) + (u[k] ?? 0)
  }
  return out
}

// usage 是否有实质计数（空对象 / 全零视为无用量，不写 transcript）
function hasUsage(u = {}) {
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) > 0
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// 思考深度档位规范化（导出供测试）：对齐 Claude Code /effort 档位体系。
// off/low/high/max 原样；medium → high（DeepSeek 旧映射，规避端点不识 medium）；
// auto / 空 / 未知 → null（不注入任何字段，交给模型原生自适应——DeepSeek 默认
// high、agent 场景自动 max，官方推荐 Claude Code 场景设 CLAUDE_CODE_EFFORT_LEVEL=max）
export function normalizeEffort(value) {
  const v = String(value ?? 'auto').trim().toLowerCase()
  if (v === 'off' || v === 'low' || v === 'high' || v === 'max') return v
  if (v === 'medium') return 'high'
  return null
}

// P0-1 重试退避：指数 + 25% jitter（参考 pi provider-retry：抖动避免同步风暴）
function retryDelayMs(attempt) {
  return 500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250)
}

// P0-1：流式请求重试——仅对"首块前失败"的瞬时/限流错误退避重试（已流出的文本
// 不重复，避免用户看到两次内容），abort/quota/auth/context-window 直接抛（engine
// 上层各有处理）。mock 模式默认不重试（测试确定性），可经 YFW_MOCK_API_RETRIES 覆盖。
async function* retryStream({ model, messages, maxTokens, signal, tools, reasoningEffort = null }) {
  const isMock = process.env.YFW_MOCK_API === '1'
  const configured = process.env.YFW_MOCK_API_RETRIES
  const maxRetries = configured !== undefined
    ? Number(configured)
    : (isMock ? 0 : Number(process.env.CLAUDE_CODE_API_RETRIES || 5))
  let attempt = 0
  while (true) {
    let produced = false
    try {
      for await (const chunk of streamMessages({ model, messages, maxTokens, signal, tools, reasoningEffort })) {
        produced = true
        yield chunk
      }
      return
    } catch (err) {
      if (signal?.aborted || produced) throw err
      const cls = classifyApiError(err)
      if (!['rate-limit', 'transient'].includes(cls.kind) || attempt >= maxRetries) throw err
      attempt++
      await sleep(retryDelayMs(attempt))
    }
  }
}

// P1-9 工具执行 deadline：超时返回结构化 TOOL_TIMEOUT 结果。不取消底层执行
// （各工具自身超时负责 kill；deadline 仅兜"永不返回"的工具，防整轮挂死）
export function withToolDeadline(promise, ms) {
  if (!ms || ms <= 0) return promise
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      resolve({ content: `工具执行超时（${ms}ms），已中止`, isError: true, meta: { timeout: true } })
    }, ms)
    if (t.unref) t.unref()
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

// P1-8：孤儿 tool_use 补丁——压缩/恢复破坏消息链时，为无配对 tool_result 的
// tool_use 追加合成 is_error tool_result（保 API 请求消息链合法，防 400）。
// 纯派生（不入日志）：每次请求前重建，日志保持权威。
export function patchOrphanToolUses(msgs) {
  const out = []
  const unpaired = new Map()
  for (const m of msgs) {
    // 防御：派生历史可能含 undefined 条目（旧格式 transcript 恢复），m?. 防护
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === 'tool_use') unpaired.set(b.id, b)
    } else if (m?.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === 'tool_result') unpaired.delete(b.tool_use_id)
    }
    out.push(m)
  }
  if (unpaired.size) {
    out.push({
      role: 'user',
      content: [...unpaired.values()].map((b) => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: '（该工具调用因上下文压缩/恢复丢失，未执行，标记为错误）',
        is_error: true,
      })),
    })
  }
  return out
}

export function createEngine({ opts = {}, wire, session, compactor, health }) {
  // signal 是轮次级取消标志（aborted 每轮由 runTurn 重置）；rawSignal 暴露真正
  // 的 AbortSignal，供 api.mjs 中断底层 fetch（undici 要求 AbortSignal 实例）
  let abortController = new AbortController()
  const signal = {
    aborted: false,
    get rawSignal() { return abortController.signal },
  }
  // P4-5：model 每轮从 provider 注册表刷新（CLI --model 显式指定优先于 registry）；
  // 未激活时 getProvider 现读 env.ANTHROPIC_MODEL，与既有行为一致
  let model = opts.model || getProvider().model || ''
  const maxTokens = Math.max(1, Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || 64000))
  const tools = createToolRegistry({ cwd: opts.addDirs?.[0], addDirs: opts.addDirs, skipPermissions: opts.skipPermissions, allowOutsideDirs: opts.allowOutsideDirs, disallowedTools: opts.disallowedTools })
  // agent 表（内置 ∪ 用户级 $YFW_HOME/agents/*.md）：Agent 工具路由依据
  const agents = resolveAgents({ configDir: opts.configDir })
  // 审批挂起队列：toolUseId → resolve（cli 的 control_response 解除）
  const approvalWaiters = new Map()
  // 浏览器桥挂起队列：requestId → resolve（bridge 回写 browser_response 解除；
  // 内核发 bridge_request(browser) → 主进程执行器 → 响应回写 stdin）
  const browserWaiters = new Map()
  // P8 排队插话（priority:'next'）：cli 吸收入队，引擎在工具调用边界注入当前轮；
  // 纯文本生成阶段不注入，轮末由 cli 作为新轮处理（前端方案 A 兜底语义）
  const pendingNext = []
  // R1-1 防重放（轮级）：已执行 tool_use id → 结果。runTurn 开头重置，
  // 同轮重复 id（重连重放）回填不重执行；跨轮自动失效（新轮新 map）
  let executedToolIds = new Map()
  // 后台子 agent 任务登记：taskId → { status, promise, laneStore, sysPrompt,
  // lineage, summary, outputFile, usage, stop }。S2 续跑复用 laneStore/sysPrompt；
  // S1 级联取消查 lineage.parentTaskId；进程退出即失（非持久化，spec 边界）
  const pendingSubAgents = new Map()
  // turnStats 记录器（内存 append-only）：health / result / stats 三个消费者共用
  const turnStats = []

  // 历史优先走 session.deriveMessages()；无 session 时退化为内存数组（测试直连场景）
  const memoryHistory = []
  // systemPrompt 默认可变：cli 在 createEngine 后经 setSystemPrompt 注入三层组装
  // 提示词（基础行为规范 + AGENTS.md + append），直连测试可经 opts.systemPrompt 预置
  let systemPrompt = opts.systemPrompt || ''
  // 思考深度档位：null = auto（不注入，模型原生自适应）；off/low/high/max = 显式。
  // 初始来源：CLAUDE_CODE_EFFORT_LEVEL（Claude Code 命名，DeepSeek 官方推荐）> YFW_REASONING_EFFORT > auto
  let reasoningEffort = normalizeEffort(process.env.CLAUDE_CODE_EFFORT_LEVEL || process.env.YFW_REASONING_EFFORT || 'auto')
  function resolveEffort() { return reasoningEffort }
  function applyReasoningEffort(value) {
    const v = String(value ?? 'auto').trim().toLowerCase()
    reasoningEffort = normalizeEffort(v)
    return { value: v, effort: reasoningEffort ?? 'auto' }
  }

  function deriveHistory() {
    if (session) return session.deriveMessages()
    return memoryHistory.filter((m) => m.role !== 'system')
  }
  function pushMemory(m) { if (!session) memoryHistory.push(m) }

  async function runTurnInternal({ content }) {
    // P4-5：provider 热切换后每轮重解析模型（下一轮立即生效，无需重建 engine）
    model = opts.model || getProvider().model || ''
    let usage = {}
    let textBuf = ''
    let overflowRetries = 0
    // R1-1：每轮重置防重放集合（跨轮固定 id 不误判）
    executedToolIds = new Map()
    const maxOverflowRetries = Number(process.env.CLAUDE_CODE_MAX_OVERFLOW_RETRIES || 3)
    // 请求消息 = system 前缀（api.mjs 抽顶层）+ 派生历史；session/memory 两模式一致。
    // 孤儿 tool_use 补丁（P1-8）在派生后执行（纯派生不入日志，请求面永远合法）
    const requestMessages = () => {
      const msgs = patchOrphanToolUses(deriveHistory())
      return [{ role: 'system', content: systemPrompt }].filter((m) => m.content).concat(msgs)
    }
    // pre-step 测压检查点：每轮请求前（工具结果/上轮产物已落日志之后）
    async function preStep() {
      if (!compactor || !session) return
      const msgs = session.deriveMessages()
      const r = await compactor.maybeCompact({ system: systemPrompt || '', messages: msgs })
      // M2：摘要调用是一次完整 API 请求（prefill 含被遮蔽历史数万 token），
      // 其 usage 并入本轮（再进 turnStats/result/最终条目）
      if (r?.usage) usage = addUsage(usage, r.usage)
    }
    // 本轮已写最后一条 assistant 条目（M1 空文本收尾轮把 usage 挂到它上面）
    let lastAssistantEntry = null
    // usage 只写在轮次最终 assistant 条目上（M1 修复）：中间工具轮条目不带 usage，
    // 仅带 model。空文本收尾轮（tool-only / 溢出后置分支）恰好一个带 usage 的
    // assistant 条目——把 usage 挂到本轮最后一条已写条目；无已写条目则跳过
    // （无用量可计，且不追加空内容条目以免破坏 API 消息流）。
    const finalizeUsage = () => {
      if (!session) return
      if (textBuf.trim()) {
        // 最终 assistant 条目由 engine 写入（带 usage/model；cli 不再重复落盘）
        lastAssistantEntry = session.appendAssistant([{ type: 'text', text: textBuf }], { usage, model })
        return
      }
      if (hasUsage(usage) && lastAssistantEntry) {
        session.setEntryUsage(lastAssistantEntry, usage)
      }
    }
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      await preStep()
      // P8 排队插话注入（工具边界）：每次 API 调用前吸收 pendingNext 进当前轮
      // （appendUser 落 transcript，请求面 deriveMessages 自动包含；模型下一轮
      // 请求即见补充信息）。started 确认已在 queueNext 吸收时经 command_lifecycle
      // 发出。轮次结束仍有残余（纯文本阶段）→ cli 轮末作为新轮处理。
      if (pendingNext.length) {
        const injects = pendingNext.splice(0)
        for (const inj of injects) {
          if (session) session.appendUser(inj.content)
          else pushMemory({ role: 'user', content: inj.content })
        }
      }
      const blocks = []
      let overflowed = false
      let stopReason = null
      try {
        for await (const chunk of retryStream({
          model,
          messages: requestMessages(),
          maxTokens,
          signal,
          tools: tools.toolSchemas(),
          reasoningEffort: resolveEffort(),
        })) {
          if (signal.aborted) throw abortError()
          if (chunk.type === 'text') {
            textBuf += chunk.text
            wire.assistant([{ type: 'text', text: chunk.text }])
          } else if (chunk.type === 'thinking') {
            wire.assistant([{ type: 'thinking', thinking: chunk.text }])
          } else if (chunk.type === 'tool_use') {
            // R1-1 同流防重放：重复 id 只保留首个（模型重发同工具时防 tool_result
            // 重复与 assistant 重复 id 触发 API 400）；跨 iteration 重放由轮级
            // executedToolIds 兜底
            if (blocks.some((b) => b.id === chunk.id)) continue
            blocks.push({ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input })
            // 工具调用块随 assistant 事件转发 GUI（工具卡片展示）
            wire.assistant([{ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input }])
          } else if (chunk.type === 'usage') {
            usage = addUsage(usage, chunk.usage)
          } else if (chunk.type === 'stop_reason') {
            stopReason = chunk.reason
          }
        }
      } catch (err) {
        // 溢出兜底：强制压缩 → 仅 replaceGeneration 前进（压缩真实落地）才重试同一请求
        if (/context_window_exceeded/.test(err?.message || '') && compactor && session && overflowRetries < maxOverflowRetries) {
          const genBefore = session.getSurface().replaceGeneration
          const r = await compactor.forceCompact({ system: systemPrompt, messages: session.deriveMessages() })
          const genAfter = session.getSurface().replaceGeneration
          // M2：溢出路径的摘要调用同样是完整 API 请求，usage 并入本轮
          if (r?.usage) usage = addUsage(usage, r.usage)
          if (genAfter > genBefore) { overflowRetries++; overflowed = true }
          else { finalizeUsage(); return { usage, model, text: '', error: 'overflow-compact-failed' } }
        } else {
          throw err
        }
      }
      if (overflowed) continue // 压缩落地 → 重试同一轮（deriveHistory 已含摘要条目）
      // P0-2：输出被 max_tokens 截断且已产出工具调用 → 不执行残缺参数，注入
      // 错误 tool_result 提示模型补全重发（pi 机制，消灭"执行参数残缺的调用"）
      if (blocks.length > 0 && stopReason === 'length') {
        const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
        pushMemory({ role: 'assistant', content: assistantBlocks })
        if (session) lastAssistantEntry = session.appendAssistant(assistantBlocks, { model })
        const errorResults = blocks.map((b) => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: '模型输出被 max_tokens 截断，工具调用参数可能不完整，未执行。请重新完整发起该工具调用。',
          is_error: true,
        }))
        pushMemory({ role: 'user', content: errorResults })
        if (session) session.appendToolResults(errorResults)
        textBuf = ''
        continue
      }
      if (blocks.length === 0) break
      // 该轮 assistant 历史：文本块 + tool_use 块（Anthropic API 要求）
      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
      pushMemory({ role: 'assistant', content: assistantBlocks })
      // 中间 assistant 条目落盘（工具调用轮）：不带 usage（M1，usage 只写轮次最终条目）
      if (session) lastAssistantEntry = session.appendAssistant(assistantBlocks, { model })
      // P0-4：只读工具批并发、写/执行类串行，结果按模型调用顺序收集。tool_result
      // 必须合并进同一条 user 消息（Anthropic 要求同一 assistant 的多个 tool_use 的
      // tool_result 紧随其后且同消息，拆多条会 400）——先收集再一次性落盘。
      const executed = await runToolBatch(blocks, { spawnSubAgent, taskSystem })
      const toolResults = blocks.map((b, i) => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: executed[i]?.content ?? '',
        is_error: executed[i]?.isError === true,
      }))
      if (toolResults.length) {
        pushMemory({ role: 'user', content: toolResults })
        if (session) session.appendToolResults(toolResults)
      }
      // 继续下一轮 API 调用（模型看到 tool_result 后产出新回复）
      textBuf = ''
    }
    if (textBuf.trim()) {
      pushMemory({ role: 'assistant', content: textBuf })
    }
    finalizeUsage()
    return { usage, model, text: textBuf }
  }

  // P0-3：大工具结果磁盘持久化 + 预览替换——超阈值全文落盘
  // <sessionDir>/tool-results/<toolUseId>.json，模型输入只留 <persisted-output>
  // 预览 + 路径（可 Read 补读，无损恢复；参考 claude toolResultStorage）
  function persistToolResult(target, toolUseId, content) {
    if (!target || typeof content !== 'string') return content
    const limit = Number(process.env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES || 20000)
    if (content.length <= limit) return content
    try {
      const dir = join(dirname(target.file), 'tool-results')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${toolUseId}.json`)
      writeFileSync(file, JSON.stringify({ id: toolUseId, content, ts: new Date().toISOString() }), 'utf-8')
      const preview = content.slice(0, 2000).replace(/"/g, '&quot;')
      return `<persisted-output path="${file}" preview="${preview}">（完整内容 ${content.length} 字符已落盘，可用 Read 读取）</persisted-output>`
    } catch {
      return content // 落盘失败退回原文（不阻断工具结果）
    }
  }

  // P0-4：工具批执行——连续只读工具并发（Promise.all），写/执行类单独串行；
  // 结果按模型调用顺序收集（tool_result 与 toolCall 一一对应，Anthropic 要求）
  async function runToolBatch(blocks, ctx) {
    const results = []
    let pending = []
    const flush = async () => {
      if (!pending.length) return
      const batch = pending
      pending = []
      const settled = await Promise.all(
        batch.map((p) => p.promise.catch((e) => ({ content: `工具执行异常：${e?.message || String(e)}`, isError: true })))
      )
      settled.forEach((r, i) => { results[batch[i].index] = r })
    }
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      // R1-1 防重放：本轮内重复 tool_use id（重连后模型重放 / 同轮重复输出）→
      // 不重复执行，回填既有结果（幂等防副作用）。轮级集合 runTurn 开头重置，
      // 跨轮固定 id（mock 测试场景）不受影响。
      const replay = executedToolIds.get(b.id)
      if (replay) {
        results[i] = { content: replay.content ?? '', isError: replay.is_error === true }
        continue
      }
      if (tools.isConcurrencySafe(b.name)) {
        pending.push({
          index: i,
          promise: executeToolUse(b, ctx).then((x) => {
            executedToolIds.set(b.id, { content: x?.content ?? '', is_error: x?.isError === true })
            return x
          }),
        })
      } else {
        await flush()
        results[i] = await executeToolUse(b, ctx)
        executedToolIds.set(b.id, { content: results[i]?.content ?? '', is_error: results[i]?.isError === true })
      }
    }
    await flush()
    return results
  }

  // P1-7：权限 denial 计数降级——连续拒绝 3 次 / 累计 20 次后，高危命令自动 deny
  // （不再打扰用户弹窗），tool_result 明示模型停止尝试（参考 claude denialTracking）
  let denialStreak = 0
  let denialTotal = 0
  const DENIAL_STREAK_LIMIT = 3
  const DENIAL_TOTAL_LIMIT = 20

  async function executeToolUse(toolUse, ctx = {}) {
    const perm = decideToolPermission({ toolName: toolUse.name, input: toolUse.input, skipPermissions: opts.skipPermissions, autoApproveHighRisk: opts.autoApproveHighRisk, rules: opts.permissionRules })
    if (perm.decision === 'deny') {
      denialStreak++
      denialTotal++
      return { content: '用户拒绝执行该操作', isError: true }
    }
    if (perm.decision === 'ask') {
      // 降级检查：拒绝过多 → 直接 deny（不挂起弹窗）
      if (denialStreak >= DENIAL_STREAK_LIMIT || denialTotal >= DENIAL_TOTAL_LIMIT) {
        denialTotal++
        return {
          content: `用户已连续拒绝 ${denialStreak} 次高危操作（累计 ${denialTotal} 次）。请停止尝试危险命令，改用安全替代方案。`,
          isError: true,
        }
      }
      // 发 can_use_tool control_request 挂起，等 cli 经 control_response 解除
      wire.controlRequest({
        requestId: 'req-' + toolUse.id,
        toolName: toolUse.name,
        toolUseId: toolUse.id,
        input: toolUse.input,
        reason: perm.reason || '',
      })
      const decision = await new Promise((resolvePromise) => {
        approvalWaiters.set(toolUse.id, resolvePromise)
      })
      if (decision?.behavior !== 'allow') {
        denialStreak++
        denialTotal++
        return { content: decision?.message || '用户拒绝执行该操作', isError: true }
      }
      denialStreak = 0
    }
    // hooks.preToolUse：可否决。deny → 工具不执行，错误回填给模型。
    const hooks = opts.hooks
    if (hooks) {
      const h = await hooks.run('preToolUse', { toolName: toolUse.name, toolUseId: toolUse.id, input: toolUse.input })
      if (h.deny) return { content: h.message || `PreToolUse hook 拒绝执行 ${toolUse.name}`, isError: true }
    }
    // ctx：工具执行上下文——主循环注入 spawnSubAgent/taskSystem/browserDriver
    // （Agent/Task/Browser 工具依赖），子 agent 循环注入 lane:true（禁嵌套分发）
    const { store, ...toolCtx } = ctx
    // P1-9：统一执行 deadline（兜"永不返回"的工具；各工具自身超时负责 kill）
    const toolDeadlineMs = Number(process.env.CLAUDE_CODE_TOOL_TIMEOUT_MS || 300_000)
    const r = await withToolDeadline(tools.run(toolUse, { ...toolCtx, toolUseId: toolUse.id, browserDriver: runBrowser }), toolDeadlineMs)
    // P0-3：大结果落盘到目标会话目录（子 lane 独立 store）
    if (r && typeof r === 'object' && typeof r.content === 'string') {
      r.content = persistToolResult(store || session, toolUse.id, r.content)
    }
    // hooks.postToolUse：工具结果后触发（output 截断 8KB；不阻塞主流程决策）
    if (hooks) {
      try {
        await hooks.run('postToolUse', {
          toolName: toolUse.name,
          toolUseId: toolUse.id,
          input: toolUse.input,
          output: typeof r?.content === 'string' ? r.content.slice(0, 8192) : '',
        })
      } catch { /* post 钩子失败不影响工具结果 */ }
    }
    return r
  }

  // —— 内置浏览器驱动（bridge_request(browser) → 主进程执行器）——
  const BROWSER_TIMEOUT_MS = 120_000
  async function runBrowser(action, params) {
    const requestId = 'br-' + randomUUID()
    let timer
    const resp = await new Promise((resolve) => {
      browserWaiters.set(requestId, resolve)
      timer = setTimeout(() => {
        browserWaiters.delete(requestId)
        resolve({ ok: false, error: `浏览器操作超时（${action}，${BROWSER_TIMEOUT_MS}ms）` })
      }, BROWSER_TIMEOUT_MS)
      if (timer.unref) timer.unref() // 超时 timer 不阻塞进程退出
      // 发 bridge_request(browser)：bridge browserRouter 转主进程执行器，
      // 完成后再经 stdin browser_response 回写解除挂起
      wire.bridgeRequest({ route: 'browser', requestId, payload: { action, params } })
    })
    clearTimeout(timer)
    if (resp?.ok) {
      const body = resp.snapshot ?? resp.data ?? { ok: true }
      return { content: typeof body === 'string' ? body : JSON.stringify(body), isError: false }
    }
    return { content: `浏览器操作失败：${resp?.error || '未知错误'}`, isError: true }
  }

  // —— 子 agent（subagent）执行：进程内 lane ——
  // 子 lane = 独立 session store（复用 createSessionStore，sessionId=taskId，
  // 独立 transcript 文件），主会话日志零污染（只有 Agent tool_use + 结果回填）。
  // 子循环与 runTurnInternal 语义对齐但简化：无压缩/溢出恢复/健康（短会话）。
  // signal 为轮次级取消：主 signal（用户 cancel 全中断）∨ 子 signal（Task stop）
  async function runSubAgentLoop({ store, sysPrompt, signal: subSignal, onTool }) {
    let usage = {}
    let textBuf = ''
    let toolUses = 0
    const msgs = () => {
      const m = patchOrphanToolUses(store.deriveMessages())
      return [{ role: 'system', content: sysPrompt }].filter((x) => x.content).concat(m)
    }
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const blocks = []
      for await (const chunk of retryStream({ model, messages: msgs(), maxTokens, signal: subSignal, tools: tools.toolSchemas() })) {
        if (signal.aborted || subSignal.aborted) throw abortError()
        if (chunk.type === 'text') textBuf += chunk.text
        else if (chunk.type === 'tool_use' && !blocks.some((b) => b.id === chunk.id)) blocks.push({ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input })
        else if (chunk.type === 'usage') usage = addUsage(usage, chunk.usage)
      }
      if (blocks.length === 0) break
      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
      store.appendAssistant(assistantBlocks, { model })
      // P0-4：子 lane 同样走只读并发批；结果按模型顺序收集
      const executed = await runToolBatch(blocks, { lane: true, store })
      const toolResults = blocks.map((b, i) => ({
        tool_use_id: b.id,
        content: executed[i]?.content ?? '',
        is_error: executed[i]?.isError === true,
      }))
      for (let i = 0; i < blocks.length; i++) {
        toolUses++
        onTool?.(blocks[i], executed[i], toolUses)
      }
      store.appendToolResults(toolResults)
      textBuf = ''
    }
    return { usage, text: textBuf }
  }

  // —— 子任务执行与登记（S1 血缘 / S2 可继续 / S3 结果承接）——
  // 子 lane 产物收集：Write 工具成功路径记录文件路径（outputs 交付 + 最后产物）
  function makeLaneOnTool({ taskId, writePaths, t0 }) {
    return (b, r, count) => {
      if (b.name === 'Write' && !r.isError) {
        const p = String(b.input?.file_path || '')
        if (p) writePaths.push(p)
      }
      wire.taskProgress({
        taskId,
        lastToolName: b.name,
        description: r.isError ? `${b.name} 失败：${String(r.content || '').slice(0, 120)}` : `${b.name} 完成`,
        usage: { tool_uses: count, total_tokens: 0, duration_ms: Date.now() - t0 },
      })
    }
  }

  // 子 lane 执行体（spawn 与 resume 共用）：跑完整子循环 → 登记更新 + 终态通知。
  // resume 复用同一 laneStore（历史经 deriveMessages 原样保留，无副作用重放）
  async function runLaneExecution({ taskId, laneStore, sysPrompt, signal: subSignal, writePaths, t0, onTool }) {
    let text = ''
    let status = 'completed'
    let usage = {}
    try {
      const r = await runSubAgentLoop({ store: laneStore, sysPrompt, signal: subSignal, onTool })
      text = String(r.text || '').trim()
      usage = r.usage
    } catch (err) {
      if (err?.name === 'AbortError') { status = 'stopped'; text = '（已取消）' }
      else { status = 'failed'; text = `执行出错：${err?.message || String(err)}` }
    }
    const totalTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    // notifUsage 带 in/out/cache 拆分字段（GUI 消费），total_tokens 为合计
    const notifUsage = {
      tool_uses: 0, total_tokens: totalTokens, duration_ms: Date.now() - t0,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    }
    const outputFile = writePaths[writePaths.length - 1] || ''
    const entry = pendingSubAgents.get(taskId)
    if (entry) Object.assign(entry, { status, summary: text, outputFile, usage: notifUsage })
    wire.taskNotification({ taskId, status, summary: text, outputFile, usage: notifUsage, outputs: [...writePaths] })
    return { status, text, usage, outputFile }
  }

  // Agent 工具执行体：前台同步回填 / 后台异步 + task_notification 交付；
  // resume_task_id 复用既有后台任务会话续跑（S2/S3，无需新建 lane）
  async function spawnSubAgent(input, ctx = {}) {
    const type = String(input?.subagent_type || '')
    const prompt = String(input?.prompt || '').trim()
    const toolUseId = String(ctx?.toolUseId || '')
    // —— resume 模式：基于既有后台任务会话续跑（复用 laneStore/sysPrompt/血缘）——
    const resumeTaskId = String(input?.resume_task_id || '')
    if (resumeTaskId) {
      const target = pendingSubAgents.get(resumeTaskId)
      if (!target) return { content: `任务不存在：${resumeTaskId}`, isError: true }
      if (target.status === 'running') return { content: `任务 ${resumeTaskId} 仍在运行中，无法续跑`, isError: true }
      if (!target.laneStore) return { content: `任务 ${resumeTaskId} 无可恢复的会话`, isError: true }
      if (!prompt) return { content: 'prompt 缺失：请说明续跑指令', isError: true }
      // 续跑：追加 user 消息到既有 lane（子循环 deriveMessages 起点 = 原历史 + 续跑指令）
      target.laneStore.appendUser(prompt)
      const subController = new AbortController()
      target.stop = () => subController.abort()
      target.status = 'running'
      wire.taskResumed({ taskId: resumeTaskId, prompt })
      const t0 = Date.now()
      const writePaths = []
      const onTool = makeLaneOnTool({ taskId: resumeTaskId, writePaths, t0 })
      target.promise = runLaneExecution({
        taskId: resumeTaskId, laneStore: target.laneStore, sysPrompt: target.sysPrompt,
        signal: subController.signal, writePaths, t0, onTool,
      })
      return { content: `子 Agent 任务已续跑（task_id: ${resumeTaskId}）。完成时收到通知，可用 Task 工具查询/中止。`, isError: false }
    }
    const agent = resolveAgent(agents, type)
    if (!agent) return { content: `未知子 Agent：${type}。可用：${agents.map((a) => a.id).join(', ')}`, isError: true }
    if (!prompt) return { content: 'prompt 缺失：请说明要委派给子 Agent 的任务', isError: true }
    const runInBackground = input?.run_in_background === true
    const taskId = newSessionId()
    // S1 血缘：主 agent 派发 depth 0 / parent null；子 lane 派发（S4 预留）经 ctx.lane 透传
    const lineage = {
      parentTaskId: ctx?.lane?.taskId ?? null,
      depth: (ctx?.lane?.depth ?? -1) + 1,
      path: [...(ctx?.lane?.path || []), taskId],
    }
    wire.taskStarted({ taskId, toolUseId, prompt, parentTaskId: lineage.parentTaskId, depth: lineage.depth })
    const laneStore = createSessionStore({ configDir: opts.configDir, cwd: opts.addDirs?.[0] || '', sessionId: taskId })
    // 子任务指令入子 lane（子循环 deriveMessages 的起点；与主 runTurn appendUser 对齐）
    laneStore.appendUser(prompt)
    const sysPrompt = agent.systemPrompt || `你是 YFWorking 的子 Agent「${agent.name}」：${agent.description}。使用简体中文。`
    const subController = new AbortController()
    const t0 = Date.now()
    const writePaths = []
    const onTool = makeLaneOnTool({ taskId, writePaths, t0 })
    const exec = () => runLaneExecution({
      taskId, laneStore, sysPrompt,
      signal: subController.signal, writePaths, t0, onTool,
    })
    if (runInBackground) {
      const promise = exec()
      // 登记含 sysPrompt/laneStore/lineage：resume 复用会话与血缘，级联取消查 parent
      pendingSubAgents.set(taskId, {
        status: 'running', promise, laneStore, sysPrompt, lineage,
        stop: () => subController.abort(), // Task stop 中止该子任务（独立信号）
      })
      return { content: `子 Agent「${agent.id}」任务已后台启动（task_id: ${taskId}）。完成时收到通知，可用 Task 工具查询/中止/续跑。`, isError: false }
    }
    const r = await exec()
    if (r.status === 'stopped') return { content: '子 Agent 任务已取消', isError: true }
    if (r.status === 'failed') return { content: r.text, isError: true }
    const totalTokens = (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0)
      + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0)
    const detail = [
      `子 Agent「${agent.id}」执行完成（${totalTokens} tokens）`,
      r.text,
      r.outputFile ? `输出文件：${r.outputFile}` : '',
    ].filter(Boolean).join('\n\n')
    return { content: detail, isError: false }
  }

  // Task 工具能力（后台任务查询/中止）
  // 级联取消：中止任务及其全部后代（子级优先释放，对齐 deepseek 所有权图语义；
  // 当前子 lane 禁嵌套无后代，结构为 S4 预留）
  function stopSubTree(taskId, seen = new Set()) {
    if (seen.has(taskId)) return
    seen.add(taskId)
    for (const [id, entry] of pendingSubAgents) {
      if (entry.lineage?.parentTaskId === taskId) stopSubTree(id, seen)
    }
    const t = pendingSubAgents.get(taskId)
    if (t && t.status === 'running' && typeof t.stop === 'function') t.stop()
  }

  // 全量中止所有后台子 agent（hardStop / cancel 用）：逐个 abort 子 lane 信号，
  // 子循环在检查点抛 AbortError → runLaneExecution 置 status='stopped' 并发
  // task_notification（"已取消"）。与 stopSubTree 的区别：不管血缘，全部停。
  function abortAllSubAgents() {
    for (const [id, t] of pendingSubAgents) {
      if (t.status === 'running' && typeof t.stop === 'function') t.stop()
    }
  }

  // 解除全部审批/浏览器挂起（abort / hardStop 共用）：挂起点在 await waiter，
  // 若不 resolve，取消后 runTurn 永远卡在工具边界（can_use_tool 审批或
  // browser_response）。审批按 deny 回执（模型侧表现为"用户拒绝/已取消"），
  // 浏览器按失败回执——随后流循环检查 signal.aborted 抛 AbortError 结束轮次。
  function rejectAllWaiters() {
    for (const [id, resolve] of [...approvalWaiters]) {
      approvalWaiters.delete(id)
      resolve({ behavior: 'deny', message: '已取消' })
    }
    for (const [id, resolve] of [...browserWaiters]) {
      browserWaiters.delete(id)
      resolve({ ok: false, error: '已取消' })
    }
  }

  const taskSystem = {
    list() {
      if (pendingSubAgents.size === 0) return '当前无后台子 Agent 任务'
      return [...pendingSubAgents.entries()]
        .map(([id, t]) => {
          const indent = '  '.repeat(t.lineage?.depth ?? 0)
          return `${indent}${id.slice(0, 8)} [${t.status}]${t.summary ? ' ' + String(t.summary).slice(0, 80) : ''}`
        })
        .join('\n')
    },
    status(taskId) {
      const t = pendingSubAgents.get(String(taskId || ''))
      return t ? `${taskId} [${t.status}]${t.summary ? '\n' + String(t.summary) : ''}` : `任务不存在：${taskId}`
    },
    output(taskId) {
      const t = pendingSubAgents.get(String(taskId || ''))
      if (!t) return { content: `任务不存在：${taskId}`, isError: true }
      if (t.status === 'running') return { content: '任务仍在运行中', isError: false }
      return { content: String(t.summary || '(无输出)'), isError: false }
    },
    stop(taskId) {
      const t = pendingSubAgents.get(String(taskId || ''))
      if (!t) return { content: `任务不存在：${taskId}`, isError: true }
      if (t.status !== 'running') return { content: `任务已结束（${t.status}）`, isError: false }
      stopSubTree(String(taskId || '')) // 级联中止（含后代；当前无嵌套场景等价单中止）
      return { content: `已请求中止任务 ${taskId}（含其后代）`, isError: false }
    },
    // S2 可继续：基于既有后台任务会话续跑（复用 laneStore；prompt 为续跑指令）
    async resume(taskId, prompt) {
      const id = String(taskId || '')
      const t = pendingSubAgents.get(id)
      if (!t) return { content: `任务不存在：${id}`, isError: true }
      if (t.status === 'running') return { content: `任务 ${id} 仍在运行中，无法续跑`, isError: true }
      if (!t.laneStore) return { content: `任务 ${id} 无可恢复的会话`, isError: true }
      // 复用 spawnSubAgent 的 resume 分支（同一语义：复用 lane + 追加续跑指令）
      return spawnSubAgent({ resume_task_id: id, prompt: String(prompt || '').trim() || '（任务继续）' })
    },
  }

  return {
    signal,
    toolNames: tools.toolNames,
    toolSchemas: () => tools.toolSchemas(),
    // subagent 体系：Agent/Task 工具能力 + 后台任务登记
    spawnSubAgent,
    taskSystem,
    pendingSubAgents,
    // Agent 工具被禁用时（--disallowedTools Agent）子 Agent 区块不入提示词
    agents: opts.disallowedTools?.includes('Agent') ? [] : agents,
    setSystemPrompt(p) { systemPrompt = p || '' },
    // 思考深度热设置（cli control_request reasoning_effort）：返回规范化档位 + 生效 effort
    setReasoningEffort(value) { return applyReasoningEffort(value) },
    abort() {
      rejectAllWaiters()
      signal.aborted = true
      abortController.abort()
    },
    // 停止按钮（cancel）全杀：kill 工具子进程（Bash/OCR，模块级 ACTIVE_CHILDREN）
    // + 中止全部后台子 agent + 中断当前 API 流 + 解除审批/浏览器挂起。与 abort()
    // （打断插入用，同样解除挂起）语义：any 取消路径都必须立刻结束等待——
    // 否则审批/浏览器 waiter 永不 resolve，runTurn 卡死在挂起点（取消不即时根因）。
    hardStop() {
      try { killActiveChildren() } catch {}
      abortAllSubAgents()
      rejectAllWaiters()
      signal.aborted = true
      abortController.abort()
    },
    seedCompactCount(n) { /* session 已从日志恢复 compactCount；兼容保留 */ },
    // cli 的 control_response 路由：解除对应 tool_use 的审批挂起
    resolveApproval(toolUseId, inner) {
      const w = approvalWaiters.get(toolUseId)
      if (w) {
        approvalWaiters.delete(toolUseId)
        w(inner)
      }
    },
    // cli 的 browser_response 路由（bridge 回写）：解除浏览器挂起
    resolveBrowser(requestId, resp) {
      const w = browserWaiters.get(requestId)
      if (w) {
        browserWaiters.delete(requestId)
        w(resp)
      }
    },
    // P8 排队插话：cli 在 turnActive 时吸收 next 消息入队并回发 command_lifecycle
    queueNext(content, uuid) {
      pendingNext.push({ content: String(content ?? ''), uuid })
      if (uuid) wire.commandLifecycle(uuid, 'started')
      return pendingNext.length
    },
    pendingNextCount() { return pendingNext.length },
    drainNextPending() { return pendingNext.splice(0) },
    getTurnStats() { return turnStats },
    async runTurn({ content, msg }) {
      // 新轮次重置取消标志：abort() 只影响发出时正在进行的轮次
      signal.aborted = false
      abortController = new AbortController()
      const t0 = Date.now()
      if (session) session.appendUser(String(content ?? ''))
      else pushMemory({ role: 'user', content: String(content ?? '') })
      const { usage, model: turnModel, text } = await runTurnInternal({ content })
      const durationMs = Date.now() - t0
      // turnStats 每轮尾部产出（health/result/stats 共用）
      turnStats.push({ usage, durationMs, model: turnModel, ts: new Date().toISOString(), compactCount: session ? session.compactCount() : 0 })
      health?.record(turnStats[turnStats.length - 1])
      // result 事件由 engine 发出（含 duration_ms；cli 不再重复 emit）
      wire.result(usage, { duration_ms: durationMs })
      return { usage, model: turnModel, text, durationMs }
    },
  }
}
