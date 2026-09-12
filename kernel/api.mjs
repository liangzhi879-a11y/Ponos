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

// 可中断退避（2026-09-12）：重发退避期间收到取消/abort 必须立刻结束等待。旧实现
// 睡满 1/2/4s 才醒——用户按下停止键后内核仍攥着定时器装死，且取消路径"检查点"直到
// 退避结束才被求值，观感即"停止键不灵"。无 signal 或非标准 signal 时退化为普通 sleep。
function sleepAbortable(ms, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') return sleep(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let timer = null
    const onAbort = () => done()
    const done = () => {
      if (timer) clearTimeout(timer)
      try { signal.removeEventListener('abort', onAbort) } catch { /* 忽略 */ }
      resolve()
    }
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch { /* 退化 */ }
    timer = setTimeout(done, ms)
  })
}

// 将 SSE 文本增量累积并按段落边界切分：产出 1..n 个 {type:'text'} chunk。
// 【2026-09-12 流式观感与丢字修复】两处缺陷（均已用探针实证）：
//   ① 只在 "\n\n" 处产出 ⇒ 模型写整段无空行时，该段被扣到步末 finish() 才一次性
//      吐出，观感是"卡住几个字、不是流式输出"（用户实测语），而本会话每步可见文本
//      中位数仅 51B ⇒ 每步只蹦几个字再冻结数秒。超阈值即先吐，段落边界仍优先。
//   ② `return rest` 的尾巴不进 for...of（生成器返回值不参与迭代），而调用方又在
//      首轮就 textBuf='' ⇒ 同一 delta 内 "\n\n" 之后的文字**永久丢失**（实证：喂
//      '第一段\n\n第二段开始' 只吐 '第一段\n\n'；喂整块 '## 标题\n\n正文一。\n\n
//      正文二。' 只活下第一段）。丢失不止是显示：引擎自己的 textBuf 同源累积
//      （engine.mjs 用它落盘 assistant 消息并作下一轮上下文），故模型会"忘掉"自己
//      刚说过的话。⇒ 改为"产出段 + 返回尾巴"，尾巴由调用方留在缓冲里。
// 默认 16 字：本仓实测慢模型（qwen/vLLM 约 15 B/s）下 ≈1s 一跳，观感接近连续；
// 调到 1 即"每 delta 一帧"（最大流式粒度，帧数最多）。设 0/非法值回落默认。
const TEXT_FLUSH_CHARS = () => Math.max(1, Number(process.env.PONOS_TEXT_FLUSH_CHARS) || 16)

// 【2026-09-12 标记完整性】未闭合的 HTML 注释（`<!--` 尚无配对 `-->`）不得在中间切帧。
// 依据：ASK_USER 提问卡与 MILESTONE 进度标记**都是 HTML 注释**，而桥侧是**逐帧**正则
// 提取、要求同一帧内闭合（bridge.mjs 的 extractAskUserBlocks / extractMilestoneMarks
// 都用 `[\s\S]*?-->`）。按字符数切帧会把 93 字的 ASK_USER 标记切成 7 帧 ⇒ 卡片 0 命中、
// 且原始 `<!--ASK_USER {...` 原样漏进气泡（探针实证：切帧数 7、命中 0、7 帧全原样转发）。
// 此处只做纯语法判定、不认知任何具体标记名（渲染层 markdown 同样不再见到半截注释）。
// 上限兜底：模型写出永不闭合的 `<!--` 时不得把整段扣住（那恰是"卡住几个字"的病根），
// 超过上限即放弃押后、照常吐帧。0 = 关闭押后（退回纯长度切分）。
const MARKER_HOLD_MAX = () => {
  const raw = process.env.PONOS_TEXT_MARKER_HOLD_MAX
  if (raw === undefined || raw === '') return 2048
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 2048
}

// 返回"必须押后的起点"：无未闭合注释时 = buf.length（可自由切分）
function holdStart(buf) {
  const max = MARKER_HOLD_MAX()
  if (!max) return buf.length
  const i = buf.lastIndexOf('<!--')
  if (i < 0 || buf.indexOf('-->', i + 4) !== -1) return buf.length
  return buf.length - i > max ? buf.length : i // 超上限 = 放弃押后（防坏标记扣住整段）
}

// 切点 pos 是否落在某个 HTML 注释**内部**。判据必须是"注释内部"而非"当前押后区内"：
// 注释一旦闭合押后就释放了，若只看押后区，载荷内的 `\n\n` 会在闭合的瞬间变回合法
// 切点、把已完整的标记重新切成两帧（夹具实证：`<!--MILESTONE-OK 1/3 读代码\n\n继续跑-->`
// 在 `-->` 到达后被从 `\n\n` 处切开）。取"最后一个 `<!--` 是否晚于最后一个 `-->`"。
function insideComment(s, pos) {
  const head = s.slice(0, pos)
  return head.lastIndexOf('<!--') > head.lastIndexOf('-->')
}

function* segmentText(buffer, kind = 'text') {
  let rest = buffer
  while (rest) {
    const holdAt = holdStart(rest)
    const idx = rest.indexOf('\n\n')
    if (idx >= 0 && !insideComment(rest, idx + 2)) {
      const seg = rest.slice(0, idx + 2)
      rest = rest.slice(idx + 2)
      if (seg.trim()) yield { type: kind, text: seg }
      continue
    }
    // 无段界但已够长：先吐，避免整段被扣到流末（帧数仍远少于逐 delta 直发）
    if (rest.length >= TEXT_FLUSH_CHARS() && holdAt === rest.length) {
      yield { type: kind, text: rest }
      rest = ''
    }
    break
  }
  return rest
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
  // 【2026-09-11 DeepSeek 适配】并发/交错安全的工具块累积：按 content_block 的 index
  // 分槽（Anthropic 语义：每个 content_block_* 事件都带 index）。旧实现只有单一
  // `tool` 变量——兼容端点若"多个 tool_use 先 start、input_json_delta 交错下发"，
  // 会发生：后块覆盖前块（前块丢失）+ 两块的 partial_json 拼进同一 inputJson
  // （JSON.parse 失败 → 空参 {} 执行）。缺 index 的旧式端点回退"最后一个未收尾块"
  // （等价原单槽语义，保持向后兼容）。
  const toolSlots = new Map() // key(index|'__last') -> { id, name, inputJson, inline }
  let lastToolKey = null
  let textBuf = ''
  // 思考块同样要成帧：旧实现逐 delta 直发（`out.push({type:'thinking', ...})`），
  // 而推理模型（deepseek 系）常把 MILESTONE 标记写在 thinking 里——桥虽"text 与
  // thinking 都提取里程碑"，但 delta 边界几乎必然落在标记中间 ⇒ 思考块内的进度标记
  // **从未**解析成功过（这正是桥侧"散文兜底"存在的原因）。与 text 共用同一切分器，
  // 标记不再被切开；模型耗时/推理内容本身不变，只是帧粒度变粗（默认 16 字）。
  let thinkBuf = ''
  let usage = { input_tokens: 0, output_tokens: 0 }
  let lastUsageKey = null // 最近一次已 push 的 usage 快照指纹（同值快照去重）
  let stopReason = null
  return {
    feed(payload) {
      const out = []
      const dt = payload.delta
      const hasIdx = Number.isInteger(payload.index)
      if (payload.type === 'content_block_start') {
        const cb = payload.content_block
        if (cb?.type === 'tool_use') {
          const key = hasIdx ? payload.index : '__last'
          toolSlots.set(key, {
            id: cb.id,
            name: cb.name,
            inputJson: '',
            // 兼容端点可能把完整参数内联在 content_block.input（不发 input_json_delta）
            inline: cb.input === undefined || cb.input === null ? undefined : cb.input,
          })
          lastToolKey = key
        }
      } else if (payload.type === 'content_block_delta' && dt) {
        if (dt.type === 'text_delta' && dt.text) {
          textBuf += dt.text
          // 手工消费以拿到生成器的返回值：for...of 只迭代 yield，`return rest` 的
          // 尾巴会被静默丢弃（旧写法），故必须显式取 n.value 留回缓冲。
          const it = segmentText(textBuf)
          let n = it.next()
          while (!n.done) { out.push(n.value); n = it.next() }
          textBuf = typeof n.value === 'string' ? n.value : ''
        } else if (dt.type === 'thinking_delta' && dt.thinking) {
          thinkBuf += dt.thinking
          const it = segmentText(thinkBuf, 'thinking')
          let n = it.next()
          while (!n.done) { out.push(n.value); n = it.next() }
          thinkBuf = typeof n.value === 'string' ? n.value : ''
        } else if (dt.type === 'input_json_delta' && dt.partial_json) {
          // 按 index 落槽；缺 index 回退最后一个未收尾块
          const key = hasIdx ? payload.index : lastToolKey
          const slot = key === null ? undefined : toolSlots.get(key)
          if (slot) slot.inputJson += dt.partial_json
        }
      } else if (payload.type === 'content_block_stop') {
        // 只对"该 index 上确实有 tool_use 槽"才产出——文本/思考块的 stop 不再误触发
        const key = hasIdx ? payload.index : lastToolKey
        const slot = key === null ? undefined : toolSlots.get(key)
        if (slot) {
          let input
          if (slot.inputJson) {
            try { input = JSON.parse(slot.inputJson) } catch { input = {} }
          } else if (slot.inline !== undefined) {
            input = slot.inline
          } else {
            input = {}
          }
          out.push({ type: 'tool_use', id: slot.id, name: slot.name, input })
          toolSlots.delete(key)
          if (lastToolKey === key) lastToolKey = null
        }
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
      // 思考块的押后尾巴同样要收口（旧实现逐 delta 直发、无缓冲，故此前不需要这一步；
      // 加了缓冲就必须在流末吐净，否则是"新造一条丢字路径"）。
      if (thinkBuf) out.push({ type: 'thinking', text: thinkBuf })
      thinkBuf = ''
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
  // 系统提示探针（2026-09-12 lane 技能目录测试）：PONOS_MOCK_SYS_PROBE=<needle> →
  // 请求内 system 条目含该子串则回 SYS_PROBE:1，否则回 SYS_PROBE:0。系统提示不落盘
  // （transcript 只有 user/assistant），这是唯一能端到端断言"系统提示真进了请求"的口子。
  if (process.env.PONOS_MOCK_SYS_PROBE) {
    const needle = process.env.PONOS_MOCK_SYS_PROBE
    const sysText = (messages || [])
      .filter((m) => m?.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b?.text || '').join('')))
      .join('\n')
    if (signal?.aborted) throw abortError()
    yield* streamText(sysText.includes(needle) ? 'SYS_PROBE:1' : 'SYS_PROBE:0', signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 输出截断自愈模拟（2026-09-12 engine-continue-heal 测试）：PONOS_MOCK_TRUNCATE_CONT=1 →
  // 历史无续写指令时产出部分文本 + max_tokens 截断 stop_reason；续写指令出现后产出
  // 剩余文本 + 正常收尾。调用次数写 PONOS_MOCK_TRUNCATE_CONT_N 供断言有界。
  if (process.env.PONOS_MOCK_TRUNCATE_CONT === '1') {
    const healMark = (messages || []).some((m) => m?.role === 'user' && typeof m?.content === 'string' &&
      m.content.includes('【系统】你的上一条回复因输出上限被截断'))
    process.env.PONOS_MOCK_TRUNCATE_CONT_N = String(Number(process.env.PONOS_MOCK_TRUNCATE_CONT_N || 0) + 1)
    if (signal?.aborted) throw abortError()
    if (!healMark) {
      yield* streamText('这是被截断的前半段', signal)
      yield { type: 'usage', usage: MOCK_USAGE }
      yield { type: 'stop_reason', reason: 'max_tokens' }
      return
    }
    yield* streamText('这是续写的后半段 [mock:truncate-cont-done]', signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // PONOS_MOCK_OVERFLOW=too-big[:BYTES] → 请求体 JSON 字节数 > BYTES（默认 50000）即抛
  // vLLM 原文 400。**必须放摘要检测分支之前**：端点不会因为请求是"压缩用的"就放宽
  // 窗口，线上事故的真实形态就是摘要请求自身超窗（估算口径 vs 端点真实计费口径背离，
  // 报文里窗口数 40000 刻意取小 → 沿用估算口径的压缩器算出分块照样被拒）。
  // 该形态下唯一能过的请求是硬适配副本（fitRequestToWindow：系统提示 + 最近一轮 +
  // <history-index>，≈10KB）——钉死"瘦身副本必须被当次重试真正用上"。
  // 抛错次数写 PONOS_MOCK_OVERFLOW_COUNT（含未抛的放行调用）供断言调用次数有界。
  const tooBig = /^too-big(?::(\d+))?$/.exec(String(process.env.PONOS_MOCK_OVERFLOW || ''))
  if (tooBig) {
    process.env.PONOS_MOCK_OVERFLOW_COUNT = String(Number(process.env.PONOS_MOCK_OVERFLOW_COUNT || 0) + 1)
    if (Buffer.byteLength(JSON.stringify(messages || [])) > Number(tooBig[1] || 50_000)) {
      const e = new Error('内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":"This model\'s maximum context length is 40000 tokens. However, you requested 8192 output tokens and your prompt contains at least 41000 input tokens, for a total of at least 49192 tokens. Please reduce the length of the input prompt or max_tokens."}}')
      e.status = 400
      throw e
    }
  }
  // 压缩摘要调用检测（前移：须先于 [mock:lane-melt]/[mock:lane-iter] 历史门控——
  // lane 压缩开启后摘要请求的 covered 历史含 [mock:lane-iter] 标记，被门控抢先会产
  // 工具而非摘要。原位置在 L232，判定语义等价）。mLastIsToolResult 守卫镜像原"回显
  // 先于摘要"的隐式顺序（末条为 tool_result 的回合交回显，不在此误判）。
  const mLaneLast = (messages || [])[messages.length - 1]
  const mLastIsToolResult = mLaneLast?.role === 'user' &&
    Array.isArray(mLaneLast.content) && mLaneLast.content.some((b) => b?.type === 'tool_result')
  const mSummaryText = (() => {
    const lu = [...(messages || [])].reverse().find((m) => m.role === 'user' &&
      !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')))
    const c = lu?.content
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')
  })()
  if (!mLastIsToolResult && mSummaryText.includes('系统压缩指令')) {
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
  // ASK_USER 阻塞语义模拟（2026-09-12）：历史含 [mock:ask-user] 即扮演"问完就停"的
  // 模型——产出带提问标记的文本后由引擎挂起；作答（桥的格式以"用户回答："开头）到达
  // 后本分支让位给下面的普通回显，于是"挂起 → 作答注入当前轮 → 继续同一步"可被断言。
  // 关键：未作答时必须每轮都只问不推进（模拟真模型的"停下来等"），否则测试无从判定
  // 内核是否真的停住了。
  const askSeen = (messages || []).some((m) => m?.role === 'user' && (
    typeof m?.content === 'string'
      ? m.content.includes('[mock:ask-user]')
      : (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && String(b?.text ?? '').includes('[mock:ask-user]')))
  ))
  if (askSeen && !String(lastText).includes('用户回答')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield* streamText('需要你确认方案：<!--ASK_USER {"questions":[{"question":"继续吗？","options":[{"label":"继续"},{"label":"停下"}]}]}-->', signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 无进展停滞守卫测试（守卫⑥，2026-09-10）：每次请求产注释文本 + Browser js
  // 只读测量（表达式逐次微变），模拟"测量打转"循环——文本/工具键都不同，
  // ③b/⑤ 抓不到；engine 的 LOOP_STALL_MS 停滞守卫应在超时后收尾。
  // 必须放在 tool_result 回显分支之前：测量轮的 tool_result 回合交回显会让
  // 循环一轮即结束。历史门控用内联 some（historyHas 定义在本分支之后，TDZ）。
  if ((messages || []).some((m) => m?.role === 'user' && (
    typeof m?.content === 'string'
      ? m.content.includes('[mock:loop-measure]')
      : (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && String(b?.text ?? '').includes('[mock:loop-measure]')))
  ))) {
    // 自愈分支（PONOS_MOCK_STALL_HEAL='1' 显式开启，once 语义）：历史已含守卫⑥
    // 推进指令 → 模拟模型改做实质工作（成功 Bash，刷新进展信号 → 愈合计数清零）。
    // 已愈合后的后续请求走"恢复完成"纯文本分支收尾（见下），不再产测量——
    // once + 终态双门控防"愈合标记残留 → 每轮都产工具"的死循环。
    if (process.env.PONOS_MOCK_STALL_HEAL === '1' && process.env.PONOS_MOCK_STALL_HEAL_CONSUMED !== '1' &&
        (messages || []).some((m) => m?.role === 'user' && typeof m?.content === 'string' && m.content.includes('【系统】检测到你长时间没有实质进展'))) {
      process.env.PONOS_MOCK_STALL_HEAL_CONSUMED = '1'
      if (signal?.aborted) throw abortError()
      await sleep(MOCK_SLEEP_MS)
      yield {
        type: 'tool_use',
        id: `tool_use_stall_healed_${Math.floor(Math.random() * 1e9)}`,
        name: 'Bash',
        input: { command: 'echo stall-healed-real-work' },
      }
      yield { type: 'usage', usage: MOCK_USAGE }
      return
    }
    // 愈合完成终态：Bash 已落地（实质进展）→ 模型以最终结论收尾（正常完成，不停摆）
    if (process.env.PONOS_MOCK_STALL_HEAL === '1' && process.env.PONOS_MOCK_STALL_HEAL_CONSUMED === '1') {
      yield* streamText('任务已按新方向推进完成 [mock:stall-healed-done]', signal)
      yield { type: 'usage', usage: MOCK_USAGE }
      return
    }
    const n = (Number(process.env.PONOS_MOCK_MEASURE_N) || 0) + 1
    process.env.PONOS_MOCK_MEASURE_N = String(n)
    yield* streamText(`第 ${n} 次测量：这次再换个角度看一下结果。`, signal)
    yield {
      type: 'tool_use',
      id: `tool_use_measure_${n}_${Math.floor(Math.random() * 1e9)}`,
      name: 'Browser',
      input: { action: 'js', params: { expression: `measure_${n}()` } },
    }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
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
        process.env.PONOS_MOCK_OVERFLOW_COUNT = String(Number(process.env.PONOS_MOCK_OVERFLOW_COUNT || 0) + 1)
        const e = new Error('内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":"This model\'s maximum context length is 131072 tokens. However, you requested 64000 output tokens and your prompt contains at least 70000 input tokens, for a total of at least 134000 tokens. Please reduce the length of the input prompt or max_tokens."}}')
        e.status = 400
        throw e
      }
      throw new Error('context_window_exceeded: 请求超出模型上下文窗口')
    }
  }
  // 溢出无限重发模拟（2026-09-12 长会话 UI 压缩条闪烁事故）：
  // PONOS_MOCK_OVERFLOW=when-large[:N] → 请求面 messages 条数 ≥ N（默认 8）抛 vLLM 原文
  // context-window 400（报文里的窗口数刻意取小，让小夹具也能触发"硬裁到窗口内"），
  // 条数 < N 则正常作答。线上形态就是"带全量历史的请求必 400、只有瘦身副本能过"——
  // 钉死"瘦身副本必须被当次重试真正用上"（旧实现在 continue 前清空副本 → 同一超窗
  // 请求无限重发、runTurn 永不返回）。抛错次数写 PONOS_MOCK_OVERFLOW_COUNT 供断言有界。
  const largeAt = /^when-large(?::(\d+))?$/.exec(String(process.env.PONOS_MOCK_OVERFLOW || ''))
  if (largeAt) {
    process.env.PONOS_MOCK_OVERFLOW_COUNT = String(Number(process.env.PONOS_MOCK_OVERFLOW_COUNT || 0) + 1)
    if ((messages || []).length >= Number(largeAt[1] || 8)) {
      const e = new Error('内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":"This model\'s maximum context length is 8000 tokens. However, you requested 8192 output tokens and your prompt contains at least 9000 input tokens, for a total of at least 17192 tokens. Please reduce the length of the input prompt or max_tokens."}}')
      e.status = 400
      throw e
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
  // 上下文失真观测测试用（2026-09-12）：产出一次必然失败的 Read（相对路径不存在）
  // → 引擎轮尾工具摘要应收录 { name:'Read', isError:true }，供 fidelity 陈旧引用检测。
  if (lastText.includes('[mock:fidelity-read-fail]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_fid_read', name: 'Read', input: { file_path: '__yfw_fidelity_missing__.md' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 硬黑名单回合：[mock:tool-catastrophic] 触发灾难级 Bash（rm -rf /）——任何审批档位
  // 下都必须挂起等用户确认（2026-09-12 四档化：hard ask 跳过度降级计数）。
  if (lastText.includes('[mock:tool-catastrophic]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_catastrophic', name: 'Bash', input: { command: 'rm -rf /' } }
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
  // AS1 技能白名单测试：主 loop 标记 → Agent 子任务 prompt 内嵌 [mock:lane-skill]
  if (lastText.includes('[mock:agent-lane-skill]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_skill', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-skill] 输出确认并执行' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // AS1 技能白名单：lane 会话历史含 [mock:lane-skill] 且尚无 Skill tool_use → 产
  // Skill tool_use {skill:'demo'}。历史门控（同 lane-iter）：[mock:lane-skill] 只存在于
  // lane 转录，不影响主 loop。once 语义靠 laneSkillSeen（前轮 Skill 调用已入历史 →
  // 本分支跳过 → 后续回合走回显/默认收尾，lane 自然完成；deny 路径同样不重复触发）。
  const laneSkillSeen = (messages || []).some((m) => m?.role === 'assistant' &&
    Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_use' && b.name === 'Skill'))
  if (!laneSkillSeen && (messages || []).some((m) => m?.role === 'user' && (
    typeof m?.content === 'string'
      ? m.content.includes('[mock:lane-skill]')
      : (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && String(b?.text ?? '').includes('[mock:lane-skill]')))
  ))) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_lane_skill_1', name: 'Skill', input: { skill: 'demo' } }
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
  // 子 lane 工具能力未开启（2026-09-12，镜像 [mock:agent-lane-overflow]）：主 loop 侧
  // 触发 Agent tool_use，子任务 prompt 内嵌 [mock:lane-notools]；lane 侧（下方历史门控）
  // 每次请求都抛 400 —— 服务端没开工具调用时子任务重试无意义，engine 应立刻 guardStop。
  if (lastText.includes('[mock:agent-lane-notools]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_notools', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-notools] 输出确认' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 子 lane 工具能力未开启模拟：lane 会话历史含 [mock:lane-notools] → 每次请求抛
  // tools-unsupported 400（历史门控保证不影响主会话/其它 lane）
  if ((messages || []).some((m) => m?.role === 'user' && (
    typeof m?.content === 'string'
      ? m.content.includes('[mock:lane-notools]')
      : (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'text' && String(b?.text ?? '').includes('[mock:lane-notools]')))
  ))) throw toolsUnsupportedError('mock:lane-notools')
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
  // 工具能力未开启模拟：[mock:tools-unsupported] 首个请求即抛 400（provider 未以
  // --enable-auto-tool-choice 启动，任何带 tools 的请求都被拒）。engine 应快速失败
  // 并落"补启动参数 / 换 provider"的可操作引导（不得重试、不得静默去掉 tools）。
  if (lastText.includes('[mock:tools-unsupported]')) throw toolsUnsupportedError('mock:tools-unsupported')
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
  // 异步链失活模拟（2026-09-12 事故形态）：[mock:hang-forever] 永久挂起且无视
  // abort——引擎请求层看门狗 abort 后本分支不响应（真实事故里续体彻底丢失、
  // 请求级定时器已清理）。只有 cli 级硬看门狗（PONOS_KERNEL_HARD_TIMEOUT_MS）
  // 能救。仅用于进程级 spawn 测试；engine 单测不得使用（会真挂）。
  if (lastText.includes('[mock:hang-forever]')) {
    await new Promise(() => {}) // 永不 resolve
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
  // 内部 AbortController 与外部取消信号合并（2026-09-12 异步链失活/孤儿请求修复）：
  // 旧实现超时只 reject——底层 fetch 仍挂在 undici 池里继续跑，服务器侧照常生成
  // （孤儿占用槽位），重试再叠一层，正是上面注释记的"越重试越挂"死亡螺旋的请求侧成因。
  // 合并后：超时 abort 底层；外部 abort 仍穿透到**响应体读取**（engine 空闲看门狗
  // 依赖这条，故监听器须随响应体生命周期存活，不在 fetch resolve 时摘除）。
  const ctrl = new AbortController()
  const onExtAbort = () => { try { ctrl.abort(signal?.reason) } catch { try { ctrl.abort() } catch {} } }
  if (signal) {
    if (signal.aborted) onExtAbort()
    else { try { signal.addEventListener('abort', onExtAbort, { once: true }) } catch { /* 非标准 signal：忽略 */ } }
  }
  const p = fetch(url, { method, headers, body, signal: ctrl.signal })
  if (!connectTimeoutMs || connectTimeoutMs <= 0) return p
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const e = new Error('连接超时: The operation was aborted due to timeout')
      e.name = 'TimeoutError'
      try { ctrl.abort(e) } catch {}
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
  // 连接/首字节超时（2026-09-09 挂起事故根因修复）：默认从 30s 提到 600s。
  // 实测网关在 HTTP 层缓冲整个排队+思考阶段（复杂请求响应头 207s 才到），30s
  // 超时会在排队期间反复掐断请求——服务器侧仍在生成（孤儿占用槽位），重试
  // 制造更多孤儿，形成"越重试越挂"的死亡螺旋（实测 8 分钟 19 次重试全灭）。
  // 真正的挂起守卫是 engine 的首字节看门狗（447/480s，abort 信号传导到 fetch）；
  // TCP 连接失败（拒绝/RST）由系统栈秒级报错，不需要 30s 兜底。
  const connectTimeoutMs = Math.max(0, Number(process.env.CLAUDE_CODE_CONNECT_TIMEOUT_MS || 600_000))
  const extSignal = toAbortSignal(signal)
  // connection: close（2026-09-09 挂起事故修复）：远程网关对半开/复用连接有隐性
  // 限流——kernel 连接堆积（ESTABLISHED+CLOSE_WAIT）后新请求被静默丢弃（实测：
  // 同请求连续多次 447s 零数据，旁路新连接秒回；重试换新连接后才恢复）。undici
  // 默认 keep-alive 池让连接长期驻留，累积后命中网关上限。逐请求关闭连接、
  // 即用即弃，杜绝堆积（代价：每请求一次 TCP 握手，远端 RTT 量级可忽略）。
  // D 观测：请求体尺寸落 stderr（kernel-stderr.log 诊断项可见）——挂起排查时
  // 可当场确认"请求发出去了多大"，与 usage 对账守卫互补（对账只在响应到达时生效）。
  const rawBody = JSON.stringify(body)
  console.error(`[api] POST ${url} body=${rawBody.length}B msgs=${Array.isArray(body.messages) ? body.messages.length : '-'}`)
  const res = await fetchWithConnectTimeout(url, {
    method: 'POST',
    headers: { ...headers, connection: 'close' },
    body: rawBody,
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
  let sseEventName = '' // 当前 SSE `event:` 名（error/ping 判定用；空行/新 event 行覆盖）
  const parser = createAnthropicParser()
  // P1-6：单次流读空闲看门狗。默认 300s，但必须跟随首内容宽限校准——若
  // PONOS_STREAM_FIRST_BYTE_MS（provider firstByteMs 注入，如 447s）长于 300s，
  // 本层仍按 300s 掐断会在慢 prefill（实测 362KB 上下文排队 >5min）时形成
  // "每 300s 重发同一请求"的失速循环（2026-09-10 实测 881s 静默告警根因：
  // engine 首字节看门狗 447/600s 还没到，流读先被 300s 掐死 → zeroEvents
  // 无限重试）。大请求（>200K 字符，engine adaptiveFirstByteMs 同门槛）放宽
  // 到 600s 封顶。显式 CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS 仍权威（测试/用户覆盖）。
  const idleTimeoutMs = (() => {
    const explicit = Number(process.env.CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS)
    if (Number.isFinite(explicit) && explicit > 0) return explicit
    const fb = Number(process.env.PONOS_STREAM_FIRST_BYTE_MS)
    // 大请求：对齐 engine adaptiveFirstByteMs（>200K 字符 → 600s 上限）
    if (rawBody.length > 200_000) return 600_000
    // 普通请求：对齐 engine FIRST_BYTE_HARD_CAP_MS（480s），下限 300s
    const floor = Math.max(300_000, Number.isFinite(fb) && fb > 0 ? fb : 0)
    return Math.min(480_000, floor)
  })()
  // R1-1 流中断识别：读阶段 transient 错误（网络断/fetch failed/流空闲超时）包装为
  // StreamInterrupted，供 anthropicStream 外层重发判定；abort/非 transient 原样抛
  async function readWithRecover() {
    try {
      return await withIdleTimeout(reader.read(), idleTimeoutMs)
    } catch (err) {
      // 空闲超时/读错误：必须先 cancel 底层 reader（2026-09-12）。旧实现只 releaseLock()，
      // 那个挂起的 read() 永不完成、响应体不释放——连接与服务器槽位一起泄漏，重试又开
      // 新连接叠加（实测静默窗口里同一请求被反复重发）。cancel 让底层流真正收口，
      // 之后再走既有 transient 重发语义。
      try { await reader.cancel(err) } catch { /* 已关闭/已 errored：忽略 */ }
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
        if (!t) continue
        // SSE 事件名行（`event: error` / `event: ping`）。Anthropic 兼容端点在流中途
        // 报错时发 `event: error` + data {type:'error',error:{type,message}}；
        // 旧实现只看 data 行，这类错误被 JSON.parse 后交 parser.feed 静默忽略
        // （无 error 分支）→ 用户侧表现为"回答突然截断/空回复且无任何报错"，极难排查。
        if (t.startsWith('event:')) { sseEventName = t.slice(6).trim(); continue }
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let ev
        try { ev = JSON.parse(payload) } catch { continue }
        // 流内错误：显式抛出，交 classifyApiError 判定可重试（overloaded/429/5xx）
        // 或终局（invalid_request），复用既有 retryStream 重发链路
        if (sseEventName === 'error' || ev?.type === 'error') throw apiStreamError(ev, sseEventName)
        // 心跳不计入有效事件：否则"只发 ping 后 EOF"的空流不会被 DeadStream 快速判定
        // （engine 只能等空闲看门狗 300s 收尾）
        if (ev?.type === 'ping') continue
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
    if (err?.name !== 'DeadStreamError' && err?.name !== 'ApiStreamError' && eventCount === 0 && err?.name !== 'AbortError') {
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

// 【2026-09-11 DeepSeek 适配】流内 SSE 错误事件（Anthropic 语义 `event: error` +
// data {type:'error',error:{type,message}}）→ 结构化错误，带上 status 让既有
// classifyApiError 正确分流：
//   overloaded_error / server_error / internal → 529 → transient（retryStream 重发）
//   rate_limit_error / too_many_requests        → 429 → rate-limit（可重试）
//   invalid_request_error / 其它                → 400 → unknown（终局，不空耗重试）
export function apiStreamError(ev, eventName = '') {
  const info = (ev && typeof ev.error === 'object' && ev.error) || ev || {}
  const ptype = String(info.type || info.code || (eventName === 'error' ? 'stream_error' : eventName) || 'stream_error')
  const msg = String(info.message || '流内错误事件')
  const e = new Error(`${ptype}: ${msg}`)
  e.name = 'ApiStreamError'
  e.providerType = ptype
  if (/overloaded|server_error|internal|unavailable|temporarily/i.test(ptype)) e.status = 529
  else if (/rate.?limit|too_many/i.test(ptype)) e.status = 429
  else e.status = 400
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

// 工具能力未开启错误（2026-09-12）：端点对带 tools 的请求回 400（vLLM 未以
// --enable-auto-tool-choice --tool-call-parser 启动时的原文）。构造器保证 status=400
// 与线上报文同形，供引擎/mock/测试共用同一文本（改文案即改这里，不会多处漂移）。
export function toolsUnsupportedError(detail = '') {
  const e = new Error(`内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":""auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"}}${detail ? `（${String(detail).slice(0, 120)}）` : ''}`)
  e.status = 400
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
  // provider 思考模式（2026-09-10）：MiniMax 等不认 reasoning_effort 的云端，
  // 显式 thinking:enabled+budget 后流内才有 thinking_delta（实测无参数时思考
  // 完全不可见——思考混进 text_delta 或整段隐藏）。auto 档位走本分支。
  if (process.env.CLAUDE_CODE_THINKING_ENABLED === '1') {
    const budget = Number(process.env.CLAUDE_CODE_THINKING_BUDGET || 4096)
    const n = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 4096
    return { thinking: { type: 'enabled', budget_tokens: n } }
  }
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
        await sleepAbortable(1000 * Math.pow(2, attempt), signal)   // 1s / 2s / 4s（取消即刻中断）
        continue
      }
      // 工具能力未开启是终局配置错误：去缓存标记/去思考深度字段都不会改变"服务端
      // 没开工具调用"这一事实（isCacheRejection 对任意 400 都成立，会把同一个 400
      // 原样重发一次）→ 先于两个降级兜底直接上抛。
      if (classifyApiError(err).kind === 'tools-unsupported') throw err
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
//   tools-unsupported —— 端点未开启工具调用（vLLM 缺 --enable-auto-tool-choice 等），
//                        配置级终局错误：重试/去字段/收窄预算全部无效，快速失败报引导
//   unknown        —— 其余，保守不重试
// 工具能力未开启的报文形态（2026-09-12 实测：vLLM + Qwen3 未带启动参数时，任何带
// tools 的请求必 400）。第一段是 vLLM 原话；第二段覆盖同类端点把"模型不支持工具"
// 表述为否定句的情形（Ollama/llama.cpp 等）。两段都要求出现 tools/tool calling/
// tool_choice 字样，避免误伤无关的 "xxx not supported" 报文。
const TOOLS_UNSUPPORTED_RE = /enable-auto-tool-choice|tool-call-parser|\btools?(?![a-z0-9])[^.\n]{0,40}(?:not supported|unsupported|not enabled|not available|disabled)|\bnot support(?:s|ed)?\b[^.\n]{0,20}\btools?(?![a-z0-9])/i
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
  // 模型不存在/已下线（2026-09-11 改名适配）：404/400 + model not found / invalid model
  // → 单独分类，engine 落"重新探测模型清单"引导（桥探测已按服务端清单自动适配旧名）
  if ((status === 404 || status === 400) && /(invalid model|unknown model|model[\w\s.:'"-]{0,80}\b(not[ -]?found|not[ -]?exist|does not exist))/i.test(msg)) return { kind: 'model-not-found', retryable: false }
  // 工具能力未开启（2026-09-12）：端点收到 tools 后按 tool_choice 语义校验，而 vLLM
  // 类服务未以 --enable-auto-tool-choice --tool-call-parser 启动 → 带 tools 的请求必
  // 400（实测 6 种请求组合里只有"不带 tools"与 tool_choice:none 能过）。配置级终局
  // 错误——换字段/去缓存/缩预算重发都是同一个 400，故 retryable:false 由 engine 落引导。
  if ((status === 400 || status === 422) && TOOLS_UNSUPPORTED_RE.test(msg)) return { kind: 'tools-unsupported', retryable: false }
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
