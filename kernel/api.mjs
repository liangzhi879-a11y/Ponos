// Ponos-turbo LLM API 客户端（docs/bridge-contract.md §2 buildChildEnv 注入的 provider env）
// ---------------------------------------------------------------------------
// 以 Anthropic Messages API 兼容协议调上游（ANTHROPIC_BASE_URL +
// ANTHROPIC_AUTH_TOKEN + ANTHROPIC_MODEL）。OpenAI 兼容端点已删除（2026-08-20 实测
// deepseek OpenAI 端点带 tools 时高概率 thinking-only 空回复，见 zz-smoke 冒烟记录），
// SSE 流式解析后产出结构化 chunk：
//   { type: 'text',     text }      已累积的文本段（按段落/阈值切分）
//   { type: 'thinking', text }      推理模型的思考块（deepseek 等）
//   { type: 'usage',    usage }     最终 token 用量（input_tokens/output_tokens）
// engine.mjs 消费该流并转发 wire.assistant，不感知具体 provider 流式格式。
// PONOS_MOCK_API=1：内置幂等 mock 流（引擎测试用，无网络）。
import { abortError } from './protocol.mjs'
import { getProvider } from './provider.mjs'

const MOCK_SLEEP_MS = 30

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// 将 SSE 文本增量累积并按段落边界切分：产出 1..n 个 {type:'text'} chunk
function* segmentText(buffer) {
  let rest = buffer
  while (true) {
    const idx = rest.indexOf('\n\n')
    if (idx < 0) return rest
    const seg = rest.slice(0, idx + 2)
    rest = rest.slice(idx + 2)
    if (seg.trim()) yield { type: 'text', text: seg }
  }
}

// 协议检测：仅 Anthropic 兼容协议（deepseek 等 provider 的 /anthropic 端点）。
// 纯 env 契约（api-protocol.test.mjs 以自定义 env 对象调用，不得读 registry/process）。
// P4-5 registry 生效点只在 anthropicStream 内部（getProvider 未激活时现读 env，等效）。
export function detectProtocol(env = process.env) {
  return env.ANTHROPIC_BASE_URL ? 'anthropic' : null
}

// usage 归一化：扩展 cache_read/cache_creation（deepseek 系）
function normalizeUsage(u = {}) {
  const cacheRead = u.cache_read_input_tokens ?? 0
  return {
    input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
    output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
    cache_read_input_tokens: cacheRead ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  }
}

// Anthropic Messages 事件流纯解析器（闭包状态：tool 累积/textBuf/usage）
export function createAnthropicParser() {
  let tool = null // { id, name, inputJson }
  let textBuf = ''
  let usage = { input_tokens: 0, output_tokens: 0 }
  let stopReason = null
  return {
    feed(payload) {
      const out = []
      const dt = payload.delta
      if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
        tool = { id: payload.content_block.id, name: payload.content_block.name, inputJson: '' }
      } else if (payload.type === 'content_block_delta' && dt) {
        if (dt.type === 'text_delta' && dt.text) {
          textBuf += dt.text
          for (const seg of segmentText(textBuf)) { textBuf = ''; out.push(seg) }
        } else if (dt.type === 'thinking_delta' && dt.thinking) {
          out.push({ type: 'thinking', text: dt.thinking })
        } else if (dt.type === 'input_json_delta' && tool && dt.partial_json) {
          tool.inputJson += dt.partial_json
        }
      } else if (payload.type === 'content_block_stop' && tool) {
        let input = {}
        try { input = tool.inputJson ? JSON.parse(tool.inputJson) : {} } catch {}
        out.push({ type: 'tool_use', id: tool.id, name: tool.name, input })
        tool = null
      } else if (payload.type === 'message_start' && payload.message?.usage) {
        usage = normalizeUsage(payload.message.usage)
      } else if (payload.type === 'message_delta') {
        // stop_reason 在 message_delta 才可靠（content_block_stop 时恒为 null）
        if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason
        if (payload.usage) {
          usage = normalizeUsage(payload.usage)
          out.push({ type: 'usage', usage })
        }
      }
      return out
    },
    finish() {
      const out = []
      if (textBuf.trim()) out.push({ type: 'text', text: textBuf })
      textBuf = ''
      return out
    },
    usage() { return usage },
    stopReason() { return stopReason },
  }
}

const MOCK_USAGE = { input_tokens: 10, output_tokens: 20 }

// 模拟流式文本：切 3 段，段间短暂停顿使 cancel 可中断
async function* streamText(text, signal) {
  const step = Math.max(1, Math.ceil(text.length / 3))
  let rest = text
  while (rest) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    if (signal?.aborted) throw abortError()
    yield { type: 'text', text: rest.slice(0, step) }
    rest = rest.slice(step)
  }
}

async function* mockStream({ messages, signal }) {
  // 瞬时错误模拟（P0-1 retry 测试）：PONOS_MOCK_TRANSIENT=once 首次调用抛网络层错误
  if (process.env.PONOS_MOCK_TRANSIENT === 'once' && process.env.PONOS_MOCK_TRANSIENT_CONSUMED !== '1') {
    process.env.PONOS_MOCK_TRANSIENT_CONSUMED = '1'
    const err = new Error('内核：API 请求失败 503 fetch failed')
    err.status = 503
    throw err
  }
  // tool_result user 消息不是"新轮次"：计数与 lastText 提取都要跳过（工具循环
  // 中间条目落盘后，tool_result 以 user 角色进入模型输入，不得算作用户新轮次）
  const realUser = (messages || []).filter(
    (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'))
  )
  const lastUser = realUser[realUser.length - 1]
  const lastContent = lastUser?.content
  const lastText = typeof lastContent === 'string'
    ? lastContent
    : (Array.isArray(lastContent) ? lastContent.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')
  // 工具结果回合：仅当"最后一条消息"为 tool_result 轮才报告执行结果（引擎工具
  // 循环第二轮）。不得用"历史中任意 tool_result"判定——跨轮连续调用 [mock:tool]
  // 时，上一轮被拒绝的 tool_result 残留在历史里，会让 mock 误走结果回显分支而
  // 永远不再产出 tool_use（denial 降级测试复现，2026-08-21 修复）。
  const lastMessage = (messages || [])[messages.length - 1]
  const lastIsToolResult = lastMessage?.role === 'user' &&
    Array.isArray(lastMessage.content) && lastMessage.content.some((b) => b?.type === 'tool_result')
  if (lastIsToolResult) {
    const firstBlock = lastMessage.content.find((b) => b?.type === 'tool_result')
    const body = `工具执行完成：${String(firstBlock?.content ?? '').slice(0, 120)}`
    yield* streamText(body, signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 压缩摘要调用：检测 COMPACTION_INSTRUCTION → 返回 mock 摘要（收敛用）。
  // PONOS_MOCK_COMPACT_BAD=1 → 返回无标签文本（extractSummary 失败，熔断测试用）
  if (lastText && lastText.includes('系统压缩指令')) {
    if (process.env.PONOS_MOCK_COMPACT_BAD === '1') {
      yield* streamText('（压缩失败：模型未输出结构化摘要）', signal)
      yield { type: 'usage', usage: MOCK_USAGE }
      return
    }
    const body = process.env.PONOS_MOCK_COMPACT_RESPONSE === '1'
      ? '<compacted-summary>摘要输出</compacted-summary>'
      : '<compacted-summary>mock 摘要</compacted-summary>'
    yield* streamText(body, signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 溢出模拟：PONOS_MOCK_OVERFLOW=once → 非 summarizer 调用抛一次 context_window_exceeded
  if (process.env.PONOS_MOCK_OVERFLOW === 'once' && !String(lastText || '').includes('系统压缩指令')) {
    if (process.env.PONOS_MOCK_OVERFLOW_CONSUMED === '1') { /* 已抛过 */ } else {
      process.env.PONOS_MOCK_OVERFLOW_CONSUMED = '1'
      throw new Error('context_window_exceeded: 请求超出模型上下文窗口')
    }
  }
  // 安全工具请求回合：[mock:tool-safe] 触发非高危 Bash tool_use（echo）。
  // 子 lane 测试用——高危命令会经 can_use_tool 审批挂起（无 CLI 无法解除）
  if (lastText.includes('[mock:tool-safe]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_safe', name: 'Bash', input: { command: 'echo mock-safe' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 agent 产物承接测试：[mock:write] 触发 Write tool_use（写两个文件，
  // onTool 收集 → task_notification.outputs 断言）。PONOS_MOCK_WRITE_DIR 指定目录
  if (lastText.includes('[mock:write]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    const base = process.env.PONOS_MOCK_WRITE_DIR || process.cwd()
    yield { type: 'tool_use', id: 'tool_use_mock_write_1', name: 'Write', input: { file_path: `${base}/mock-a.txt`, content: 'a' } }
    yield { type: 'tool_use', id: 'tool_use_mock_write_2', name: 'Write', input: { file_path: `${base}/mock-b.txt`, content: 'b' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // R1-1 防重放测试：同一次调用输出两个【相同 id】的 tool_use（echo 安全命令）
  if (lastText.includes('[mock:replay]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    const id = 'tool_use_replay_1'
    yield { type: 'tool_use', id, name: 'Bash', input: { command: 'echo replay-once' } }
    yield { type: 'tool_use', id, name: 'Bash', input: { command: 'echo replay-once' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 工具请求回合：[mock:tool] 触发 Bash tool_use（rm -rf 高危 → 审批挂起）。
  // PONOS_MOCK_TOOLS=N 时一次返回 N 个 tool_use（多工具轮合并回归用）
  if (lastText.includes('[mock:tool]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    const n = Math.max(1, Number(process.env.PONOS_MOCK_TOOLS || 1))
    for (let i = 1; i <= n; i++) {
      // 第 1 个工具保留 rm -rf 高危命令（审批测试依赖 can_use_tool 触发）；多工具模式后续用安全 echo
      const command = i === 1 ? 'rm -rf /tmp/ponos-mock-target' : `echo mock-tool-${i}`
      yield { type: 'tool_use', id: `tool_use_mock_${i}`, name: 'Bash', input: { command } }
    }
    // P0-2 length 截断模拟：PONOS_MOCK_STOP_REASON=length → 工具轮后置 stop_reason
    if (process.env.PONOS_MOCK_STOP_REASON === 'length') yield { type: 'stop_reason', reason: 'length' }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 浏览器桥冒烟：[mock:browser] 触发 Browser tool_use（bridge_request(browser)
  // 挂起 → browser_response 解除 链路测试用）
  if (lastText.includes('[mock:browser]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_browser', name: 'Browser', input: { action: 'goto', params: { url: 'https://example.com' } } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 大结果工具轮（P0-3 磁盘持久化测试）：Bash 输出 30000 字符触发落盘 + 预览替换
  if (lastText.includes('[mock:big]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_big', name: 'Bash', input: { command: 'node -e "process.stdout.write(\'x\'.repeat(30000))"' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 Agent 分发冒烟：[mock:agent] 触发 Agent tool_use（subagent 链路测试用）
  if (lastText.includes('[mock:agent]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent', name: 'Agent', input: { subagent_type: 'general-purpose', prompt: '测试子任务：请输出一句确认' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 后台子 Agent 分发冒烟：[mock:agent-bg] 触发 run_in_background Agent tool_use
  // （cancel 全杀 subagent 测试用：hardStop 后任务应被中止为 stopped）。子 prompt
  // 带 [mock:sleep] → 子 lane 进入长 Bash 执行（持续运行态，等待被 kill）。
  if (lastText.includes('[mock:agent-bg]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_bg', name: 'Agent', input: { subagent_type: 'general-purpose', prompt: '[mock:sleep] 后台测试子任务：持续运行', run_in_background: true } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 长 Bash 工具轮：[mock:sleep] 触发 sleep 30（killActiveChildren 全杀测试用：
  // cancel/hardStop 后子进程被杀，轮快速收敛而非等 30s）
  if (lastText.includes('[mock:sleep]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_sleep', name: 'Bash', input: { command: 'sleep 30' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // loop --until 判定请求：mock 返回可控 done（PONOS_MOCK_JUDGE=done|not，默认 not）
  if (lastText && lastText.includes('请判定该目标在当前对话中是否已达成')) {
    const done = process.env.PONOS_MOCK_JUDGE === 'done'
    yield* streamText(JSON.stringify({ done, reason: done ? 'mock 判定达成' : 'mock 判定未达成' }), signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 普通回合：回显（带 turn 计数，历史恢复可断言）
  const text = `mock: ${String(lastText).slice(0, 120)} (turn=${realUser.length})`
  yield* streamText(text, signal)
  yield { type: 'usage', usage: MOCK_USAGE }
}

// undici fetch 要求 signal 为 AbortSignal 实例。engine 的轮次级 signal 是自定义
// 对象（rawSignal getter 暴露真 AbortSignal）；其余调用方（mock/测试）无 rawSignal
// 时兜底：AbortSignal 直传，普通对象则不给 fetch（由调用方 chunk 循环检查中止）。
export function toAbortSignal(s) {
  if (s?.rawSignal) return s.rawSignal
  return s instanceof AbortSignal ? s : undefined
}

// R1-2 连接/首字节超时：只覆盖 fetch resolve（响应头到达）前。用独立 timer 包裹
// fetch，resolve 后即清理——不得把 AbortSignal.timeout 并入 fetch signal（其 timer
// 在 resolve 后仍存活，30s 一到会 abort 仍在读取的响应流，误杀长 thinking 流，
// T003 评测实测 "stream interrupted: ... timeout"）。外部取消仍经 extSignal 传导：
// abort → fetch reject AbortError（不重试）；连接超时 → TimeoutError（transient 重发）
async function fetchWithConnectTimeout(url, { method, headers, body, signal }, connectTimeoutMs) {
  const p = fetch(url, { method, headers, body, signal })
  if (!connectTimeoutMs || connectTimeoutMs <= 0) return p
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const e = new Error('连接超时: The operation was aborted due to timeout')
      e.name = 'TimeoutError'
      reject(e)
    }, connectTimeoutMs)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

// Anthropic SSE 流：统一产出归一化 chunk。
export async function* protocolStream({ url, body, headers, signal }) {
  const connectTimeoutMs = Math.max(0, Number(process.env.CLAUDE_CODE_CONNECT_TIMEOUT_MS || 30_000))
  const extSignal = toAbortSignal(signal)
  const res = await fetchWithConnectTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: extSignal,
  }, connectTimeoutMs)
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    // P0-1：错误携带 HTTP status，供 classifyApiError 结构化分类（5xx 可退避重试）
    const err = new Error(`内核：API 请求失败 ${res.status} ${detail.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let usagePushed = false
  const parser = createAnthropicParser()
  // P1-6：单次流读空闲看门狗（默认 300s，同 deepseek-harness）
  const idleTimeoutMs = Number(process.env.CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS || 300_000)
  // R1-1 流中断识别：读阶段 transient 错误（网络断/fetch failed/流空闲超时）包装为
  // StreamInterrupted，供 anthropicStream 外层重发判定；abort/非 transient 原样抛
  async function readWithRecover() {
    try {
      return await withIdleTimeout(reader.read(), idleTimeoutMs)
    } catch (err) {
      const cls = classifyApiError(err)
      if (cls.kind === 'transient') throw streamInterrupted(err)
      throw err
    }
  }
  try {
    while (true) {
      const { done, value } = await readWithRecover()
      if (done) break
      if (signal?.aborted) throw abortError()
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let ev
        try { ev = JSON.parse(payload) } catch { continue }
        for (const c of parser.feed(ev)) {
          if (c.type === 'usage') usagePushed = true
          yield c
        }
      }
    }
    for (const c of parser.finish()) {
      if (c.type === 'usage') usagePushed = true
      yield c
    }
    // 流末尾：stop_reason（engine 判 length 截断用；无则 null）
    yield { type: 'stop_reason', reason: parser.stopReason() }
    // 每流一个终态 usage：解析器已 push（message_delta / OpenAI 末尾 usage）则不再兜底
    if (!usagePushed) yield { type: 'usage', usage: parser.usage() }
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

// R1-1 流中断包装：读阶段 transient 错误 → StreamInterrupted（anthropicStream
// 外层据此重发完整请求；abort/quota/auth/非 transient 不经此处）
export function streamInterrupted(err) {
  const e = new Error('stream interrupted: ' + (err?.message || String(err)))
  e.name = 'StreamInterrupted'
  e.kind = 'transient'
  return e
}

// 是否因 cache_control 被端点拒绝（400/422 或缓存相关 message）→ 回退重发判断
function isCacheRejection(err) {
  const status = err?.status || 0
  const msg = String(err?.message || '')
  return status === 400 || status === 422 || /cache|unknown field|unsupported/i.test(msg)
}

// 思考深度 → 请求体字段（对齐 Claude Code 档位 + DeepSeek Anthropic 兼容端点：
// 深度走 reasoning_effort（low/high/max），关闭走 thinking:disabled；两者不并发生
// 发，避免 DeepSeek #1397 的 400）。auto/未知 → {}（模型原生自适应，不注入）。
export function effortParam(effort) {
  if (effort === 'off') return { thinking: { type: 'disabled' } }
  if (effort === 'low' || effort === 'high' || effort === 'max') return { reasoning_effort: effort }
  return {}
}

// 端点拒绝思考深度字段（400/422 且提及 effort/thinking）→ 去掉字段重发，退回模型默认
function isEffortRejection(err) {
  const status = err?.status || 0
  const msg = String(err?.message || '')
  return (status === 400 || status === 422) && /reasoning_effort|thinking|effort/i.test(msg)
}

// Anthropic 协议流：tools 中立形状 → tools[]；system 抽顶层。
// prompt cache 显式化：PONOS_PROMPT_CACHE=1 且 system 非空时，system 改数组形态并
// 打 ephemeral 缓存标记（Anthropic 官方端点依赖显式标记命中缓存；DeepSeek 兼容
// 端点自动缓存，显式标记无害）。端点拒绝该字段时自动去掉标记重发一次（兼容兜底）。
async function* anthropicStream({ model, messages, system, tools, maxTokens, signal, reasoningEffort = null }) {
  // P4-5：注册表解析（setProvider 激活后固定；未激活 getProvider 现读 env，行为不变）
  const p = getProvider()
  const base = p.baseUrl
  const token = p.authToken
  if (!base || !token) throw new Error('内核：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 未配置')
  const useCache = process.env.PONOS_PROMPT_CACHE === '1' && !!system
  const headers = { 'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01' }
  // 采样稳定性：默认 temperature=0（贪婪解码，确定性优先，支持该参数的端点生效；
  // DeepSeek 兼容端点对 temperature 不敏感且不保证 seed 复现，注入无害）。PONOS_SEED
  // 可选固定采样种子（部分端点 temperature=0 + seed 时可复现）。
  const temperature = Number(process.env.PONOS_TEMPERATURE ?? 0)
  const seedEnv = process.env.PONOS_SEED
  // 思考深度：reasoningEffort（low/high/max → reasoning_effort；off → thinking disabled；
  // 缺省 → 不注入，模型原生自适应）
  const body = {
    model,
    max_tokens: maxTokens,
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(seedEnv ? { seed: Number(seedEnv) } : {}),
    ...effortParam(reasoningEffort),
    ...(system ? (useCache ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : { system }) : {}),
    messages,
    stream: true,
    ...(tools.length
      ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) }
      : {}),
  }
  const maxReconnect = Math.max(0, Number(process.env.CLAUDE_CODE_STREAM_RECONNECTS ?? 3))
  // R1-1 流中断重连：重发完整请求（无断点续传），已流出的半截文本丢弃（首段可能
  // 重复，接受）；工具副作用由 engine 防重放（Task 3）兜底。abort/非 transient 直接抛。
  for (let attempt = 0; ; attempt++) {
    try {
      yield* protocolStream({ url: base + '/v1/messages', body, headers, signal })
      return
    } catch (err) {
      // R1-2：连接/首字节超时（TimeoutError）与流中断（StreamInterrupted）同为
      // transient 可重发；abort（用户取消）/非 transient 直接抛
      const retryable = err?.name === 'StreamInterrupted' || err?.name === 'TimeoutError'
      if (retryable && !signal?.aborted && attempt < maxReconnect) {
        await sleep(1000 * Math.pow(2, attempt))   // 1s / 2s / 4s
        continue
      }
      if (useCache && isCacheRejection(err)) {
        // 缓存标记被拒：去掉后重发一次（body 恢复纯字符串 system）
        yield* protocolStream({ url: base + '/v1/messages', body: { ...body, ...(system ? { system } : {}) }, headers, signal })
        return
      }
      if (reasoningEffort && isEffortRejection(err)) {
        // 端点不支持思考深度字段：去掉后重发一次（退回模型默认思考深度）
        const { reasoning_effort, thinking, ...rest } = body
        yield* protocolStream({ url: base + '/v1/messages', body: rest, headers, signal })
        return
      }
      throw err
    }
  }
}

// 错误分类（P0-1）：结构化错误码 + 是否可重试。engine 据此决定退避重试或快速失败。
//   abort          —— 用户取消，永不重试
//   context-window —— 上下文溢出，engine 有独立压缩兜底路径
//   auth           —— 401/403 凭证问题，重试无意义
//   quota          —— 配额/计费耗尽（insufficient_quota 类），快速失败
//   rate-limit     —— 429 / rate limit，可退避重试
//   transient      —— 5xx / 网络 / 流空闲超时，可退避重试（连接层瞬时错误）
//   unknown        —— 其余，保守不重试
export function classifyApiError(err) {
  if (err?.name === 'AbortError') return { kind: 'abort', retryable: false }
  // R1-2 超时分级：连接/首字节超时（AbortSignal.timeout）→ transient 可重试，
  // 与用户取消（abort）区分；流空闲超时已有单独分支
  if (err?.name === 'TimeoutError') return { kind: 'transient', retryable: true }
  const msg = String(err?.message || '')
  const status = err?.status || 0
  // context_window_exceeded 以 message 关键词判定（provider 不一定带 status，如 mock）
  if (/context_window_exceeded/.test(msg)) return { kind: 'context-window', retryable: false }
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false }
  if (status === 429 || /rate.?limit|too many requests/i.test(msg)) return { kind: 'rate-limit', retryable: true }
  if (/quota|billing|insufficient/i.test(msg)) return { kind: 'quota', retryable: false }
  if (/stream idle timeout/i.test(msg)) return { kind: 'transient', retryable: true }
  if (status >= 500 || /ECONN|ENOTFOUND|EPIPE|ETIMEDOUT|fetch failed|network|socket/i.test(msg)) return { kind: 'transient', retryable: true }
  return { kind: 'unknown', retryable: false }
}

// 单次读操作空闲看门狗（P1-6）：reader.read() 长时间无数据判超时。
// 参考 deepseek-harness 的流式空闲看门狗（300s），防 fetch 永不 settle。
function withIdleTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(Object.assign(new Error('stream idle timeout'), { code: 'STREAM_TIMEOUT' }))
    }, ms)
    if (t.unref) t.unref()
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

// 消息流入口：mock / 真实 Anthropic 协议分流。tools = 中立 [{name, description, input_schema}]
export async function* streamMessages({ model, messages, maxTokens, signal, tools = [], reasoningEffort = null }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const rest = messages.filter((m) => m.role !== 'system')
  if (process.env.PONOS_MOCK_API === '1') {
    yield* mockStream({ messages, signal })
    return
  }
  if (!detectProtocol()) throw new Error('内核：未检测到可用协议（需 ANTHROPIC_BASE_URL）')
  yield* anthropicStream({ model, messages: rest, system, tools, maxTokens, signal, reasoningEffort })
}
