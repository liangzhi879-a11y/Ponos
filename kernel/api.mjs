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
import { getProvider, authHeaders } from './provider.mjs'

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

// 累计口径单调合并（usage 去重）：Anthropic 流里 message_delta.usage 是"到该点的
// 累计快照"，且常只带 output_tokens（input 在 message_start 已报全量）；逐字段直接
// 覆盖会丢 input/cache，逐次相加会把累计值重复计。按字段取最大值即得正确终值，
// 同时天然把网关重发/分段多次 delta 的同值快照去重。
function mergeCumulativeUsage(a, b) {
  return {
    input_tokens: Math.max(a.input_tokens, b.input_tokens),
    output_tokens: Math.max(a.output_tokens, b.output_tokens),
    cache_read_input_tokens: Math.max(a.cache_read_input_tokens, b.cache_read_input_tokens),
    cache_creation_input_tokens: Math.max(a.cache_creation_input_tokens, b.cache_creation_input_tokens),
  }
}

// Anthropic Messages 事件流纯解析器（闭包状态：tool 累积/textBuf/usage）
export function createAnthropicParser() {
  let tool = null // { id, name, inputJson }
  let textBuf = ''
  let usage = { input_tokens: 0, output_tokens: 0 }
  let lastUsageKey = null // 最近一次已 push 的 usage 快照指纹（同值快照去重）
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
          // 累计单调合并 + 同值去重（见 mergeCumulativeUsage 注释）
          usage = mergeCumulativeUsage(usage, normalizeUsage(payload.usage))
          const key = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].join(':')
          if (key !== lastUsageKey) { lastUsageKey = key; out.push({ type: 'usage', usage }) }
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
  // —— agent loop 守卫测试分支（engine-guard-*.test.mjs，env 门控）——
  // 循环工具模拟：PONOS_MOCK_LOOP=ok|fail → 每次请求都产出 Bash 工具轮（无视
  // tool_result 轮回显拦截，模拟模型"不断发同样工具"）。必须放最顶（任何历史形态
  // 都接管）：ok=echo 成功（迭代上限/同工具提醒用），fail=exit 1 → is_error（熔断用）
  const mockLoop = process.env.PONOS_MOCK_LOOP
  if (mockLoop === 'ok' || mockLoop === 'fail') {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield {
      type: 'tool_use',
      id: `tool_use_mock_loop_${Math.floor(Math.random() * 1e9)}`,
      name: 'Bash',
      input: { command: mockLoop === 'fail' ? 'exit 1' : 'echo mock-loop-ok' },
    }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane 熔断模拟（审计 #4）：子 lane 会话历史含 [mock:lane-melt] 时，每次请求都
  // 产出失败 Bash（exit 1 → is_error），模拟"连续全败"工具链让 lane 熔断守卫触发。
  // 必须放 tool_result 回显分支之前：lane 第 2 轮起末条即 tool_result user 消息，回显
  // 分支会抢先拦截 marker 轮（与 PONOS_MOCK_LOOP 置顶接管任何历史形态同理）。按会话
  // 历史门控，[mock:lane-melt] 只存在于 lane 转录、绝无主会话，故不影响主 loop 请求。
  if ((messages || []).some((m) => m?.role === 'user' && (
    typeof m?.content === 'string'
      ? m.content.includes('[mock:lane-melt]')
      : (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && String(b?.text ?? '').includes('[mock:lane-melt]')))
  ))) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield {
      type: 'tool_use',
      id: `tool_use_lane_melt_${Math.floor(Math.random() * 1e9)}`,
      name: 'Bash',
      input: { command: 'exit 1' },
    }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane 守卫⑤ 同工具提醒（审计 #10）：lane 会话历史含 [mock:lane-iter] 时按请求轮次
  // 产出：前 3 轮同一 Bash（echo lane-iter-A，同工具链推进到 REPEAT_REMIND_AT 命中注入
  // 提醒）→ 第 4-5 轮换另一 Bash（echo lane-iter-B，键变化计数复位不再提醒）→ 第 6 轮起
  // 纯文本收尾（lane 正常完成，摘要可断言）。轮次经 PONOS_MOCK_LANE_ITER_N 计数（测试
  // 启动前清零）。放 tool_result 回显分支之前（同 lane-melt）：lane 每轮请求都须接管产出
  // 工具，让同工具连续计数真实推进（回显分支会抢先拦截 tool_result 轮）。
  if ((messages || []).some((m) => m?.role === 'user' && (
    typeof m?.content === 'string'
      ? m.content.includes('[mock:lane-iter]')
      : (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && String(b?.text ?? '').includes('[mock:lane-iter]')))
  ))) {
    const round = (Number(process.env.PONOS_MOCK_LANE_ITER_N) || 0) + 1
    process.env.PONOS_MOCK_LANE_ITER_N = String(round)
    if (round <= 5) {
      if (signal?.aborted) throw abortError()
      await sleep(MOCK_SLEEP_MS)
      yield {
        type: 'tool_use',
        id: `tool_use_lane_iter_${round}_${Math.floor(Math.random() * 1e9)}`,
        name: 'Bash',
        input: { command: round <= 3 ? 'echo lane-iter-A' : 'echo lane-iter-B' },
      }
      yield { type: 'usage', usage: MOCK_USAGE }
      return
    }
    yield* streamText('任务完成 [mock:lane-iter-done]', signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
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
  // 溢出模拟：PONOS_MOCK_OVERFLOW=once|always → 非 summarizer 调用抛上下文溢出。
  // once=仅首次抛（溢出自愈恢复测试）；always=每次调用都抛（贴近真实窗口的反复 400
  // 长工具轮，验证溢出自愈按"是否有进展"续跑、不因硬计数中断死在内部错误兜底）。
  // once 用 Anthropic 措辞（压缩落地路径）；always 用 vLLM 措辞（带 limit/prompt 数，
  // 供 engine 解析后走输出预算精确收窄路径，两者覆盖两条自愈臂）。
  const overflowMode = process.env.PONOS_MOCK_OVERFLOW
  if ((overflowMode === 'once' || overflowMode === 'always') && !String(lastText || '').includes('系统压缩指令')) {
    if (overflowMode === 'once' && process.env.PONOS_MOCK_OVERFLOW_CONSUMED === '1') { /* 已抛过 */ }
    else {
      if (overflowMode === 'once') process.env.PONOS_MOCK_OVERFLOW_CONSUMED = '1'
      if (overflowMode === 'always') {
        const e = new Error('内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":"This model\'s maximum context length is 131072 tokens. However, you requested 64000 output tokens and your prompt contains at least 70000 input tokens, for a total of at least 134000 tokens. Please reduce the length of the input prompt or max_tokens."}}')
        e.status = 400
        throw e
      }
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
  // 子 lane 截断测试（审计 #1）：触发 Agent 工具，子任务 prompt 内嵌 [mock:lane-trunc]
  if (lastText.includes('[mock:agent-lane-trunc]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_trunc', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-trunc] 输出确认' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane 截断模拟（审计 #1）：非高危 Bash tool_use + 截断 stop_reason
  if (lastText.includes('[mock:lane-trunc]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_lane_trunc_1', name: 'Bash', input: { command: 'echo mock-lane-trunc' } }
    yield { type: 'stop_reason', reason: 'length' }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane 溢出自愈（审计 #5）：触发 Agent tool_use，子任务 prompt 内嵌 [mock:lane-overflow]
  if (lastText.includes('[mock:agent-lane-overflow]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_overflow', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-overflow] 输出确认并执行' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane 溢出模拟（审计 #5）：lane 会话历史含 [mock:lane-overflow] → 首次请求抛上下文
  // 溢出 400（带端点真实窗口 + prompt 用量，供 engine 按主循环公式收窄输出预算），此后请求
  // 产出成功 Bash（echo mock-lane-overflow-ok）——模拟"收窄输出预算后同轮重试成功"。放
  // tool_result 回显分支之后：重试成功轮的 tool_result 回合走正常回显结束 lane。收窄重试
  // 不改变消息历史（400 抛于流首、无任何块落 store），首/次轮请求内容完全相同，内容门控
  // 无法区分，故用一次性子标志（同 PONOS_MOCK_OVERFLOW_CONSUMED 的 once 模式）。
  if ((messages || []).some((m) => m?.role === 'user' && (
    typeof m?.content === 'string'
      ? m.content.includes('[mock:lane-overflow]')
      : (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && String(b?.text ?? '').includes('[mock:lane-overflow]')))
  ))) {
    if (process.env.PONOS_MOCK_LANE_OVERFLOW_FIRED !== '1') {
      process.env.PONOS_MOCK_LANE_OVERFLOW_FIRED = '1'
      const e = new Error('内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":"This model\'s maximum context length is 32768 tokens. However, you requested 64000 output tokens and your prompt contains at least 24576 input tokens. Please reduce the length of the input prompt or max_tokens."}}')
      e.status = 400
      throw e
    }
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: `tool_use_lane_overflow_${Math.floor(Math.random() * 1e9)}`, name: 'Bash', input: { command: 'echo mock-lane-overflow-ok' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane 熔断测试（审计 #4）：触发 Agent tool_use，子任务 prompt 内嵌 [mock:lane-melt]
  // （lane 会话含该标记 → 上方置顶分支对每次 lane 请求产失败 Bash）
  if (lastText.includes('[mock:agent-lane-melt]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_melt', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-melt] 输出确认' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane 摘要分流测试（审计 #8）：触发 Agent tool_use，子任务 prompt 内嵌
  // [mock:lane-think]——子 lane 侧按消息历史门控产出 thinking+text 双流
  if (lastText.includes('[mock:agent-lane-think]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_think', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-think] 输出确认' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane R3-2 失败自愈测试（审计 #10）：触发 Agent tool_use，子任务 prompt 内嵌
  // [mock:lane-heal]——lane 侧首轮产失败 Bash，engine 注入"请立即重试"续跑后由 R3-2
  // 恢复分支（历史含守卫注入串）产成功 Bash（见下方 lane-heal 模拟分支）
  if (lastText.includes('[mock:agent-lane-heal]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_heal', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-heal] 输出确认并执行' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane R3-2 guardInjections 上限测试（审计 #10）：触发 Agent tool_use，子任务 prompt
  // 内嵌 [mock:lane-healcap]——lane 侧每次"非 tool_result 轮"都产失败 Bash（见下方
  // lane-healcap 模拟分支），验证注入至多 PONOS_GUARD_MAX 次后收尾不无限续跑
  if (lastText.includes('[mock:agent-lane-healcap]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_healcap', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-healcap] 输出确认并执行' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane 守卫⑤ 同工具提醒测试（审计 #10）：触发 Agent tool_use，子任务 prompt 内嵌
  // [mock:lane-iter]——lane 侧按轮次产同工具/换工具（见顶部 lane-iter 模拟分支）
  if (lastText.includes('[mock:agent-lane-iter]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_iter', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-iter] 输出确认并执行' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane M5 判别测试（P1-11 落地）：触发 Agent tool_use，子任务 prompt 内嵌
  // [mock:lane-stall-think]——lane 侧先产 thinking 再挂起（见下方 lane-stall-think 模拟
  // 分支），验证看门狗判别镜像主循环 attemptData。marker 与既有互不子串劫持：避免
  // agent-lane-think（lane-think 前缀不同）与 stall0/stall（无 [mock: 前缀连缀）。
  if (lastText.includes('[mock:agent-lane-stall-think]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_stall_think', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-stall-think] 输出确认' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane 产 thinking+text（审计 #8）：lane 会话历史含 [mock:lane-think] → 每次请求产
  // thinking 块（子任务内部推理，不应进通知/摘要）与 text 块（正式回答，应进摘要），
  // 无工具调用正常收尾。放 agent-lane-think 之后（不同子串互不抢）且 [mock:lane-think]
  // 只存在于 lane 转录、绝无主会话，故不影响主 loop 请求。
  if ((messages || []).some((m) => m?.role === 'user' && (
    typeof m?.content === 'string'
      ? m.content.includes('[mock:lane-think]')
      : (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && String(b?.text ?? '').includes('[mock:lane-think]')))
  ))) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'thinking', text: '子任务内部推理：不应出现在摘要的思考X' }
    yield* streamText('子任务正式回答：应出现在摘要的文本Y', signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane M5 判别模拟（P1-11 落地）：lane 会话历史含 [mock:lane-stall-think] → 每次请求
  // 先产一个 thinking 块（镜像主循环 attemptData 语义：收到 thinking 即算上游已产出）随即
  // 挂起（无 text 无 tool_use，连接挂着不回数据），STREAM_IDLE_MS 空闲看门狗中止走
  // watchdog.tripped 分支。仅 thinking 时 lane textBuf 为空（#8 后 textBuf 只收 text），
  // 若判别仍用 textBuf.length 会被误报"上游服务空流"——本分支即 M5 判别测试靶点。放
  // lane-think 之后（不同子串互不抢）；兜底 1.5s 超时防守卫关闭时测试永久悬挂。
  if ((messages || []).some((m) => m?.role === 'user' && (
    typeof m?.content === 'string'
      ? m.content.includes('[mock:lane-stall-think]')
      : (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && String(b?.text ?? '').includes('[mock:lane-stall-think]')))
  ))) {
    if (signal?.aborted) throw abortError()
    yield { type: 'thinking', text: '子任务内部推理：停顿前最后思考' }
    yield { type: 'usage', usage: MOCK_USAGE }
    await new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      signal?.addEventListener?.('abort', () => resolve(), { once: true })
      const t = setTimeout(resolve, 1500)
      if (t.unref) t.unref()
    })
    if (signal?.aborted) throw abortError()
    return
  }
  // 子 lane R3-2 失败模拟（审计 #10）：lane 会话历史含 [mock:lane-heal] 且任务 prompt 仍为
  // 末条 user 文本（lastText 含标记 → 尚未经历失败轮）→ 产出失败 Bash（exit 1 →
  // is_error，镜像 [mock:guard-err] 语义）。失败轮后的 tool_result 回显走 echo 分支（纯
  // 文本、无工具轮），engine 在"无工具轮 break"前判 hadToolError 注入"请立即重试"续跑，
  // 随后 R3-2 恢复分支（历史含【系统】…失败/被取消串）产成功 Bash（镜像 guard-recovered）。
  if (lastText.includes('[mock:lane-heal]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: `tool_use_lane_heal_fail_${Math.floor(Math.random() * 1e9)}`, name: 'Bash', input: { command: 'exit 1' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane R3-2 注入上限模拟（审计 #10）：lane 会话历史含 [mock:lane-healcap] → 每次
  // "非 tool_result 轮"的请求都产失败 Bash（exit N → is_error；命令逐轮不同，避免⑤同
  // 工具计数噪音）；tool_result 轮交由回显分支（纯文本 → engine 注入续跑）。重复
  // "失败→纯文本→注入"循环直至 guardInjections 达 PONOS_GUARD_MAX（默认 3）后 engine
  // 不再注入、lane 收尾——锁定上限语义。轮次经 PONOS_MOCK_LANE_HEALCAP_N 计数（测试启动
  // 前清零）。放 R3-2 恢复分支之前：该场景必须持续失败、不得被恢复分支接管。
  if ((messages || []).some((m) => m?.role === 'user' && (
    typeof m?.content === 'string'
      ? m.content.includes('[mock:lane-healcap]')
      : (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && String(b?.text ?? '').includes('[mock:lane-healcap]')))
  )) && !lastIsToolResult) {
    const n = (Number(process.env.PONOS_MOCK_LANE_HEALCAP_N) || 0) + 1
    process.env.PONOS_MOCK_LANE_HEALCAP_N = String(n)
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: `tool_use_lane_healcap_${n}_${Math.floor(Math.random() * 1e9)}`, name: 'Bash', input: { command: `exit ${n}` } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // Read 回归（大结果内联 + 落盘产物边界补读）：[mock:read] <file_path> 触发 Read
  // tool_use。用于断言 ① >20K 的 Read 结果不落盘替换（模型要的就是文件内容，stub
  // 会逼其小段 offset/limit 续读空转）；② 补读 tool-results/ 落盘产物不被边界拒绝
  // （会话目录在 --add-dir 外，见 engine.mjs createEngine toolResultsDir 并入）。
  if (lastText.includes('[mock:read]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    const pathArg = lastText.slice(lastText.indexOf('[mock:read]') + '[mock:read]'.length).trim().split('\n')[0]
    yield { type: 'tool_use', id: 'tool_use_mock_read', name: 'Read', input: { file_path: pathArg } }
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
  // R3-2 守卫恢复测试：历史含守卫注入（【系统】…失败/承诺）→ 产出成功 tool_use
  // （模拟"模型收到守卫提示后补发正确调用"；配合 hadToolError 成功重置验证闭环）
  if (!lastIsToolResult && (messages || []).some(
    (m) => m.role === 'user' && typeof m.content === 'string' &&
      (m.content.includes('【系统】检测到上一轮存在失败/被取消的工具调用') || m.content.includes('【系统】你在上一轮承诺了后续动作'))
  )) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_guard_recover', name: 'Bash', input: { command: 'echo guard-recovered' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // R3-2 失败自愈测试：[mock:guard-err] 产出失败的 tool_use（Bash exit 1 → is_error）。
  // 回显轮"认错即停"→ 守卫注入 → 恢复分支产出成功调用（guard-recovered）
  if (lastText.includes('[mock:guard-err]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_guard_err', name: 'Bash', input: { command: 'exit 1' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // R3-2 计划尾测试：[mock:guard-tail] 产出计划性纯文本（无工具，模拟"计划尾巴"）。
  // engine 守卫检测到计划词（先看…/接下来…）后注入"承诺了后续动作"，恢复分支接管
  if (lastText.includes('[mock:guard-tail]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield* streamText('我先看一下结构，接下来开始处理，然后再验证', signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 生成重复打转模拟：
  //   [mock:gen-loop]  会话历史含标记即每次请求都输出同一段文字（死循环形态）。自愈
  //                     路径下即使 engine 注入推进指令，模型仍复现 → 自愈上限耗尽后
  //                     才应收尾说明（engine-guard-gen 测试语义不变）。
  //   [mock:gen-heal]  仅首次请求退化（模型"一次性打转"）→ 收到内部自愈注入后恢复为
  //                     正常回复（验证 harness 内部消化、无用户侧报错体感）。
  // 判定：任一历史 user 文本含标记 = 该场景（退化/半退化）；lastText 是否仍含标记用于
  // 区分"首次请求"（内容=标记）与"自愈注入后的请求"（内容=【系统】注入，无标记）。
  const historyTexts = (messages || [])
    .filter((m) => m?.role === 'user')
    .map((m) => (typeof m?.content === 'string'
      ? m.content
      : (Array.isArray(m?.content) ? m.content.filter((b) => b?.type === 'text').map((b) => String(b?.text ?? '')).join('\n') : '')))
  const historyHas = (kw) => historyTexts.some((t) => t.includes(kw))
  if (historyHas('[mock:gen-loop]')) {
    const phrase = '我需要不断重复这句话来验证模型的自我循环检测机制是否能正确触发守卫。'
    for (let i = 0; i < 6; i++) {
      if (signal?.aborted) throw abortError()
      await sleep(MOCK_SLEEP_MS)
      yield { type: 'text', text: phrase }
    }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  if (historyHas('[mock:gen-heal]')) {
    if (lastText.includes('[mock:gen-heal]')) {
      // 首次：模型打转（复述同一段文字）→ 引擎应在重复处中止并内部注入推进指令
      const phrase = '我需要不断重复这句话来验证模型的自我循环检测机制是否能正确触发守卫。'
      for (let i = 0; i < 6; i++) {
        if (signal?.aborted) throw abortError()
        await sleep(MOCK_SLEEP_MS)
        yield { type: 'text', text: phrase }
      }
      yield { type: 'usage', usage: MOCK_USAGE }
      return
    }
    // 自愈注入已到位：模型恢复 → 正常回复收尾
    yield* streamText('修复已完成：已按新思路推进任务并给出结论 [mock:gen-heal-recovered]', signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 近似重复（编织变体）死循环模拟：[mock:near-loop] 会话历史含标记即每次请求都输出
  // 同一批措辞微变的句子轮转（守卫③b 形态）。historyHas 语义与 gen-loop 相同。
  if (historyHas('[mock:near-loop]')) {
    const pool = [
      'Let me run it.',
      'OK, running now.',
      "I'm invoking the Bash tool.",
      'Let me run it now.',
      "OK, I'm running it.",
      'Invoking the tool.',
      'Let me go.',
      'Running the command.',
      'Here we go.',
      "I'll invoke the tool now.",
    ]
    for (let round = 0; round < 5; round++) {
      if (signal?.aborted) throw abortError()
      await sleep(MOCK_SLEEP_MS)
      yield { type: 'text', text: pool.join('\n') }
    }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 同类多行实现代码模拟：[mock:code-batch] 输出结构高度相似的多行代码（对多个字段做
  // 同类改造）。无死循环——回归验证：代码单元被近重复守卫豁免（不误判"重复打转"收尾）。
  if (historyHas('[mock:code-batch]')) {
    const lines = []
    for (let i = 0; i < 16; i++) {
      lines.push(`    onChange={(val) => setField(\`field_${i}\`, normalize(val, { trim: true }))};`)
      lines.push(`    onBlur={() => markTouched(\`field_${i}\`, touchedMap.get(\`field_${i}\`))}`)
    }
    lines.push('// code-batch-end')
    yield* streamText(lines.join('\n'), signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 空流模拟：[mock:deadstream] 首个请求即抛 DeadStreamError（上游 HTTP 200 后 0
  // 事件即断/EOF，vLLM 引擎未就绪形态）。engine 应快速失败（不空等 STREAM_IDLE_MS）
  // 并输出"检查 provider"提示。
  if (lastText.includes('[mock:deadstream]')) throw deadStreamError(new Error('mock:deadstream'))
  // 零数据挂起模拟：[mock:stall0] 与 [mock:stall] 同构但不产出开头文本——整个流一个
  // 块都没有就被空闲看门狗 abort。engine 据此区分"连接空转（上游无产出）"与"推理
  // 中途停顿（已产出内容后卡住）"，给不同的收尾提示。
  if (lastText.includes('[mock:stall0]')) {
    await new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      signal?.addEventListener?.('abort', () => resolve(), { once: true })
      const t = setTimeout(resolve, 1500)
      if (t.unref) t.unref()
    })
    if (signal?.aborted) throw abortError()
    return
  }
  // 流式挂起模拟：[mock:stall] 输出开头后不再产生任何块（连接挂着不回数据），仅
  // 被 abort 打断——engine 空闲看门狗（守卫②）应在 STREAM_IDLE_MS 后中止。兜底
  // 1.5s 超时防止守卫关闭时测试永久悬挂。
  if (lastText.includes('[mock:stall]')) {
    yield { type: 'text', text: '停顿测试开始' }
    yield { type: 'usage', usage: MOCK_USAGE }
    await new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      signal?.addEventListener?.('abort', () => resolve(), { once: true })
      const t = setTimeout(resolve, 1500)
      if (t.unref) t.unref()
    })
    if (signal?.aborted) throw abortError()
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
  let eventCount = 0 // 已成功解析的 SSE 事件数——空流判据：HTTP 200 后 0 事件即上游无产出
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
        eventCount++
        for (const c of parser.feed(ev)) {
          if (c.type === 'usage') usagePushed = true
          yield c
        }
      }
    }
    // P1-11：HTTP 200 后 0 事件即 EOF（服务端没发 message_start 就结束响应体）——上游
    // 无产出，按空流归一为 DeadStreamError（engine 快速落 provider 检查提示）。
    if (eventCount === 0) throw deadStreamError(new Error('响应体结束，未收到任何事件'))
    for (const c of parser.finish()) {
      if (c.type === 'usage') usagePushed = true
      yield c
    }
    // 流末尾：stop_reason（engine 判 length 截断用；无则 null）
    yield { type: 'stop_reason', reason: parser.stopReason() }
    // 每流一个终态 usage：解析器已 push（message_delta / OpenAI 末尾 usage）则不再兜底
    if (!usagePushed) yield { type: 'usage', usage: parser.usage() }
  } catch (err) {
    // P1-11 空流归一（0 事件即断/EOF，vLLM 引擎未就绪/崩溃的典型形态）：
    //   ① 干净 EOF（上文已抛）与非瞬态读错误（200 后即断 "terminated"）→ DeadStreamError
    //      （engine 快速落"检查 provider"提示）；
    //   ② transient（网络层瞬时抖动 / 连接被对端销毁的 "fetch failed"）→ 打 zeroEvents
    //      标记放行：单次抖动仍走既有重发语义自动恢复，不误报"上游故障"；但连续多次
    //      0 事件（上游持续空流）由 engine retryStream 的 streak 计数升级为 DeadStream。
    //   ③ AbortError（用户取消 / engine 空闲看门狗 abort）原样抛出——由 engine 的
    //      signal.aborted / watchdog.tripped 分支处理。
    if (err?.name !== 'DeadStreamError' && eventCount === 0 && err?.name !== 'AbortError') {
      if (classifyApiError(err).kind === 'transient' || err?.kind === 'transient') err.zeroEvents = true
      else throw deadStreamError(err)
    }
    throw err
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

// P1-11 空流错误：请求已被上游接受（HTTP 200）但响应体一个 SSE 事件都没下发
// （0 事件即断流 / 0 事件即 EOF）。与 StreamInterrupted（流中途断、已流出过事件，
// 保留瞬态重发语义）互补：空流判"上游本身无产出"——重试价值低，engine 快速失败
// 并明确提示检查 provider，避免"空等 120s + 反复重试死服务器"。
export function deadStreamError(cause) {
  const e = new Error('上游空流：请求已受理但未返回任何事件' + (cause?.message ? `（${String(cause.message).slice(0, 160)}）` : ''))
  e.name = 'DeadStreamError'
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
  // 鉴权头按 provider.authScheme 选择：默认 x-api-key（anthropic/deepseek/minimax）；
  // vLLM 等本地 Bearer-only 端点配置 authScheme=bearer 后改发 Authorization。
  const headers = { 'content-type': 'application/json', ...authHeaders(p), 'anthropic-version': '2023-06-01' }
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
  // 已知取舍（审计 #9，2026-09-07 复核维持现状）：断流重连时若上一段文本已部分输出，
  // 重试可能重复半截文本。审计与产品取舍均判定"接受"——重试正确性优先于输出去重；
  // 若要改进（engine 层半截文本去重）需先做真实断流复现与评估，勿无评估直接改此处。
  // R1-1 流中断重连：重发完整请求（无断点续传），已流出的半截文本丢弃（首段可能
  // 重复，接受）；工具副作用由 engine 防重放（Task 3）兜底。abort/非 transient 直接抛。
  for (let attempt = 0; ; attempt++) {
    try {
      yield* protocolStream({ url: base + '/v1/messages', body, headers, signal })
      return
    } catch (err) {
      // R1-2：连接/首字节超时（TimeoutError）与流中断（StreamInterrupted）同为
      // transient 可重发；abort（用户取消）/非 transient 直接抛
      const retryable = (err?.name === 'StreamInterrupted' || err?.name === 'TimeoutError') && !err?.zeroEvents
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
  // P1-11 空流：上游 HTTP 200 后 0 事件即断/EOF（vLLM 引擎未就绪/加载中/崩溃的典型
  // 形态）。不归 transient——engine 只做 1 次快速重试后落"检查 provider"提示，不空等
  // STREAM_IDLE_MS 也不走瞬时网络错误的多轮重发。
  if (err?.name === 'DeadStreamError') return { kind: 'dead-stream', retryable: false }
  const msg = String(err?.message || '')
  const status = err?.status || 0
  // context_window_exceeded 以 message 关键词判定（provider 不一定带 status，如 mock）
  if (/context_window_exceeded/.test(msg)) return { kind: 'context-window', retryable: false }
  // vLLM/OpenAI 等非 Anthropic 端点：400 + "maximum context length is N tokens"
  // （prompt+max_tokens 超过 max_model_len）同样判上下文超限，engine 走压缩自愈
  if (status === 400 && /maximum context length is \d+\s*tokens?/i.test(msg)) return { kind: 'context-window', retryable: false }
  // 413 Payload Too Large：网关/代理层可能以 413 拒绝超长请求（vLLM 原生常为 400，
  // 经代理/网关后状态码可能变为 413）。消息含上下文超限语义 → 走压缩兜底；否则按
  // 负载层瞬时失败保守可重试（不直接杀掉整轮工具执行）。
  if (status === 413) {
    return /maximum context length|context window|prompt is too long|too many tokens/i.test(msg)
      ? { kind: 'context-window', retryable: false }
      : { kind: 'transient', retryable: true }
  }
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
