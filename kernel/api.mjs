// Ponos-turbo LLM API 客户端（docs/bridge-contract.md §2 buildChildEnv 注入的 provider env）
// ---------------------------------------------------------------------------
// 以 Anthropic Messages API 兼容协议调上游（PONOS_BASE_URL +
// PONOS_AUTH_TOKEN + PONOS_MODEL）。OpenAI 兼容端点已删除（2026-08-20 实测
// deepseek OpenAI 端点带 tools 时高概率 thinking-only 空回复，见 zz-smoke 冒烟记录），
// SSE 流式解析后产出结构化 chunk：
//   { type: 'text',     text }      已累积的文本段（按段落/阈值切分）
//   { type: 'thinking', text }      推理模型的思考块（deepseek 等）
//   { type: 'usage',    usage }     最终 token 用量（input_tokens/output_tokens）
// engine.mjs 消费该流并转发 wire.assistant，不感知具体 provider 流式格式。
// PONOS_MOCK_API=1：内置幂等 mock 流（引擎测试用，无网络）。
import { abortError } from './protocol.mjs'
import { getProvider, authHeaders } from './provider.mjs'
// 协议层（2026-09-23 OpenAI 协议兼容）：协议差异收敛在 kernel/wire/，本模块只做分派。
// 切帧与 usage 归一必须与 OpenAI 侧**共用同一份**（两条逻辑都是用真实事故换来的），
// 故从 wire/ 导入而非各写一份；wire/ 不反向 import 本模块（防循环依赖）。
import { segmentText } from './wire/segment.mjs'
import { normalizeUsage } from './wire/usage.mjs'
import { createOpenAIParser, encodeOpenAIRequest, openaiHeaders } from './wire/openai.mjs'
import { normalizeApiFormat, resolveApiFormat, isProtocolRejection, anthropicStreamUrl, openaiStreamUrl } from './wire/url.mjs'

/**
 * 内核 API 错误的**扩展字段**（S2.1 登记，全部键可选）：本模块大量构造 `new Error(...)`
 * 后补写这些字段，`classifyApiError` 也据此分流（`status` 判 5xx/429/4xx，
 * `kind`/`hint` 透传空产出诊断，`providerType` 记流内 SSE 错误类型）。
 * 它们都是"挂在标准 Error 上的附加信息"，故登记为交叉形状——只补类型面，
 * 运行期仍是同一个 Error 实例、同一份赋值（F2 修法 R3「Node 错误扩展」）。
 * @typedef {Error & {
 *   status?: number, kind?: string, hint?: string, providerType?: string,
 *   fallbackProviderId?: string|null,
 * }} ApiError
 */
// 协议相关模型名（2026-09-23 Task 1）：同一 provider 的模型名可能跨协议不同
// （MiniMax：Anthropic 侧 `MiniMax-M3[1m]`，OpenAI 侧必须 `MiniMax-M3`）。
import { pickModelName } from './wire/model.mjs'
// 仅 PONOS_MOCK_CACHE_SEQ 的 `big:` 键使用（见 mockStream 内注释）：把大体积夹具落成
// 真实文件，供 Read 产出**可老化**的大工具结果。其余 mock 分支不碰文件系统。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

// 文本切帧（segmentText）与 usage 归一（normalizeUsage）已搬至 kernel/wire/
// （2026-09-23，OpenAI 协议兼容）：Anthropic 与 OpenAI 两个解析器必须共用同一份实现，
// 而 wire/ 不能反向 import 本模块（循环依赖）。
//   · 切帧：段落切分 + 超阈值先吐 + `<!--` 未闭合押后 + "返回尾巴不丢字" → wire/segment.mjs
//   · usage：三形态别名（Anthropic/DeepSeek 原生/OpenAI）+ 命中口径归一 → wire/usage.mjs
// 两处的原始事故记录随之保留在那两个文件内，勿在本文件重复维护。

// 协议检测：仅 Anthropic 兼容协议（deepseek 等 provider 的 /anthropic 端点）。
// 纯 env 契约（api-protocol.test.mjs 以自定义 env 对象调用，不得读 registry/process）。
// P4-5 registry 生效点只在 anthropicStream 内部（getProvider 未激活时现读 env，等效）。
export function detectProtocol(env = process.env) {
  return env.PONOS_BASE_URL ? 'anthropic' : null
}

// usage 归一化：扩展 cache_read/cache_creation（deepseek 系）
//
// 【2026-09-18 P0-1】补**跨协议**缓存字段别名 + 口径归一。此前只认
// `cache_read_input_tokens`，端点若回传别的形态，命中数被读成 0，且**全程静默**：缓存观测
// （stats 命中率）、成本统计、预算熔断同时失真——所有缓存优化都变成在黑箱里做，这是整个
// "前缀缓存"议题的验收前提。
// 三家形态（按回传字段区分，不靠 baseUrl 猜）：
//   ・Anthropic：`input_tokens` + `cache_read_input_tokens`（input **不含** read 部分）
//   ・DeepSeek 原生：`prompt_tokens` + `prompt_cache_hit_tokens`
//   ・OpenAI 形态：`prompt_tokens` + `prompt_tokens_details.cached_tokens`
//                 （Responses API 为 `input_tokens_details.cached_tokens`）
// 后两者的 `prompt_tokens` **都含**命中部分（hit 是它的子集）⇒ 归一到 Anthropic 语义时
// 必须把命中数从 input 里扣掉，否则命中部分被按全价再计一次（重叠计费、成本虚高）。
// 「含/不含」的判定只看用了哪个顶层字段：用 `prompt_tokens` 者一律含，用 `input_tokens` 者不含
// （Anthropic 官方语义），这样混合形态（`prompt_tokens` + 显式 cache_read）也能正确归位。
//
// 与 `docs/superpowers/plans/2026-09-18-prefix-cache-observability.md`（worktree 备份态
// `.preworktree`）v2 增补 **A4** 的关系：A4 只列了 OpenAI 两条别名、并主张"不动既有语义"；
// 本实现**合并**其 OpenAI 别名（勿重复添加），并额外做了 ① DeepSeek 原生别名
// ② 上面这层口径归一——因为按 A4 原样接线时，OpenAI/DeepSeek 形态仍会重叠计费（A4 的
// "不动语义"在只考虑 Anthropic 时成立，跨形态则不成立）。两处合并后为完整集合。
// 与 `docs/superpowers/plans/2026-09-18-prefix-cache-observability`（**已在 worktree 分支
// `feat/prefix-cache-observability` 实施完毕**，33 提交）的关系——三处必须拉平：
//   ① **OpenAI 两条别名**（A4 / 该分支 Task 1）：与本实现完全一致，勿重复添加。
//   ② **`cache_fields_reported` 存在性信号**（该分支 Task 1 ★）：本实现**照抄保留**。它与
//      "值为 0"完全不同：缺此信号，判定层无法区分「本轮真未命中（read=0）」与「端点根本
//      没有该字段」，而二者处置相反（前者是 suspicious 候选，后者必须静默）。**必须先取
//      原始值再兜 0**——`?? 0` 一旦在前，存在性会在到达判定层前被销毁。
//   ③ **口径归一（扣减）**：该分支评审 **Major-2** 已识别此问题但裁定「只记录、本次不修」
//      （理由：权威规格明令"不动既有语义"，口径变更须先有上游确认与观测对账）。本实现
//      **经用户批准做了归一**，故此处与那个裁定**有意不同** ⇒ **合并该分支时须在此对账**：
//      保留扣减，并把 Major-2 的"已修"结论回填到其评审记录（其描述的现象——hitRatio 被
//      压低、total 偏大——正是本条修复的对象）。
// ↑ 上述 P0-1 口径记录**留在本文件**（它是三处合并对账的原始出处）。
// 实现已搬至 kernel/wire/usage.mjs，供 Anthropic 与 OpenAI 两个解析器共用（单一真源）。
// ★ 2026-10-09 合并对账（本条即上文 ③ 承诺的落账）：分支本地 normalizeUsage 已整体
//   让位 wire/usage.mjs（别名×3、扣减、存在性信号俱全）；Major-2"只记录不修"的结论
//   自本合起**作废**——扣减已修（PR 记录随分支合并归档）。

// 累计口径单调合并（usage 去重）：Anthropic 流里 message_delta.usage 是"到该点的
// 累计快照"，且常只带 output_tokens（input 在 message_start 已报全量）；逐字段直接
// 覆盖会丢 input/cache，逐次相加会把累计值重复计。按字段取最大值即得正确终值，
// 同时天然把网关重发/分段多次 delta 的同值快照去重。
// 注意：第 5 键 cache_fields_reported 必须**显式合并**（取或）——它是布尔，漏掉即
// `undefined` 传染，下游 cacheStats 退化为旧启发式（该分支 Task 1 已踩过此坑）。
function mergeCumulativeUsage(a, b) {
  return {
    input_tokens: Math.max(a.input_tokens, b.input_tokens),
    output_tokens: Math.max(a.output_tokens, b.output_tokens),
    cache_read_input_tokens: Math.max(a.cache_read_input_tokens, b.cache_read_input_tokens),
    cache_creation_input_tokens: Math.max(a.cache_creation_input_tokens, b.cache_creation_input_tokens),
    // ★ 存在性信号**取或**（不是 max：布尔没有大小序，max 对 false/true 恰好等价，但语义上
    //   要说清是"任一分片报过即视为端点上报"）。message_delta 的累计快照常只带 output_tokens
    //   （input/cache 在 message_start 已报全量）⇒ 若按"取最后一片"会因末片缺字段而把端点
    //   误判成无缓存能力，整条观测链在该端点静默。逐字段 max 之外的第五个键必须显式合并，
    //   漏掉即 `undefined` 传染（下游 cacheStats 退化为旧启发式）。
    cache_fields_reported: Boolean(a.cache_fields_reported || b.cache_fields_reported),
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
  // 思考块**完整副本**（2026-10-22 thinking 回放）：DeepSeek /anthropic 等推理端点要求
  // 把上一轮 assistant 的 `content[].thinking` 原样回传（带 tools 的工具轮回放尤其强制，
  // 缺块直接 400「The content[].thinking in the thinking mode must be passed back」）。
  // 上面的 thinkBuf 只承载**分段后的实时帧**（给 GUI 上屏，粒度被 segmentText 改过），
  // 不能用来回放；这里按 content_block index 另存原始 text + signature。签名随
  // `signature_delta` 到达（DeepSeek 可能给占位值或空串，官方不校验；真 Anthropic 校验），
  // 在 content_block_stop 时整块产出一次 `{type:'thinking_block'}`。
  const thinkSlots = new Map() // key(index|'__last') -> { text, signature }
  let lastThinkKey = null
  let usage = normalizeUsage({})
  // ↑ 初值必须含全部 4 字段（经 normalizeUsage 取单一真源），不能写成 {input,output} 两字段：
  // 【2026-09-18 P0-1 顺带修的缺陷】某些兼容端点只发 message_delta.usage、不发
  // message_start.message.usage，此时 mergeCumulativeUsage 与两字段初值做
  // Math.max(undefined, n) ⇒ **NaN 贯穿**命中数与写缓存数，且 NaN 参与的成本比较恒 false，
  // 预算守卫会静默失效（不报警、不拦截）。此前未暴露：Anthropic 官方与 DeepSeek /anthropic
  // 都发 message_start.usage（normalizeUsage 会整体替换成 4 字段），掩盖了这条路径。
  // （分支侧"两键初值＋只补新键"的写法被此修复取代：normalizeUsage({}) 已含全部 5 键。）
  let lastUsageKey = null // 最近一次已 push 的 usage 快照指纹（同值快照去重）
  let stopReason = null
  /** 收尾所有未关闭的思考槽（兼容端点可能省略 content_block_stop）。 */
  const drainThinkSlots = (out) => {
    for (const slot of thinkSlots.values()) {
      out.push({ type: 'thinking_block', thinking: slot.text || slot.inline || '', signature: slot.signature })
    }
    thinkSlots.clear()
    lastThinkKey = null
  }
  return {
    feed(payload) {
      const out = []
      const dt = payload.delta
      const hasIdx = Number.isInteger(payload.index)
      // 【2026-09-23 流式序修复】把 text/thinking 的押后余量吐净。segmentText 会把
      // "不足阈值且无段落界"的尾巴留在缓冲里（原本**只在 finish() 流末**吐净），而
      // tool_use 在 content_block_stop 就上 wire ⇒ 工具前的**短引导语**（十几个字、无空行，
      // 正是常见形态）整段被押到流末、跑到工具卡片之后，实时视图显示"卡片 → 正文"，
      // 与磁盘落盘序（思考 → 正文 → 工具）相反（用户实测："正文被过快出现的卡片打断"）。
      // 块边界（start/stop）就是该块内容的终点，此时吐净即可让实时序与磁盘序一致。
      // 只释放、不丢弃 ⇒ 不引入丢字；标记完整性由 finish() 路径继续保证（未闭合注释
      // 仍按 holdStart 押后，故此处在标记中途也不会切开标记）。
      const flushPending = () => {
        if (thinkBuf) { out.push({ type: 'thinking', text: thinkBuf }); thinkBuf = '' }
        if (textBuf.trim()) { out.push({ type: 'text', text: textBuf }) }
        textBuf = ''
      }
      if (payload.type === 'content_block_start') {
        flushPending() // 上一块收尾（兼容端点可能省略 content_block_stop）
        drainThinkSlots(out) // 新块开始 = 上一思考块已结束（同上兼容动机）
        const cb = payload.content_block
        if (cb?.type === 'thinking') {
          // 少数端点把整段内联在 content_block.thinking、signature 内联在 content_block.signature
          // （与 tool_use 的 inline.input 同形）。delta 优先：只有全程没有 delta 才用 inline，
          // 否则「inline 首段 + deltas」会重复计一遍。
          const key = hasIdx ? payload.index : '__last'
          const inline = typeof cb.thinking === 'string' && cb.thinking ? cb.thinking : ''
          thinkSlots.set(key, {
            text: '',
            inline,
            signature: typeof cb.signature === 'string' ? cb.signature : '',
          })
          lastThinkKey = key
          if (inline) {
            // 实时面同步展示（与 delta 相同切分器；进度标记不丢）
            thinkBuf += inline
            const it = segmentText(thinkBuf, 'thinking')
            let n = it.next()
            while (!n.done) { out.push(n.value); n = it.next() }
            thinkBuf = typeof n.value === 'string' ? n.value : ''
          }
        }
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
          // 回放副本按**原始 delta**累积（不经 segmentText），保证与上游逐字一致；
          // 签名端点对思考文本的完整性校验以这段文本为准。
          const key = hasIdx ? payload.index : (lastThinkKey ?? '__last')
          let slot = thinkSlots.get(key)
          if (!slot) { slot = { text: '', inline: '', signature: '' }; thinkSlots.set(key, slot) }
          slot.text += dt.thinking
          lastThinkKey = key
          thinkBuf += dt.thinking
          const it = segmentText(thinkBuf, 'thinking')
          let n = it.next()
          while (!n.done) { out.push(n.value); n = it.next() }
          thinkBuf = typeof n.value === 'string' ? n.value : ''
        } else if (dt.type === 'signature_delta' && typeof dt.signature === 'string') {
          // Anthropic 真端点的签名分片（通常一片到齐）。缺槽时静默忽略——没收到过
          // thinking_delta 的签名不属于任何思考块，硬造一个空块只会污染回放面。
          const key = hasIdx ? payload.index : lastThinkKey
          const slot = key === null || key === undefined ? undefined : thinkSlots.get(key)
          if (slot) slot.signature += dt.signature
        } else if (dt.type === 'input_json_delta' && dt.partial_json) {
          // 按 index 落槽；缺 index 回退最后一个未收尾块
          const key = hasIdx ? payload.index : lastToolKey
          const slot = key === null ? undefined : toolSlots.get(key)
          if (slot) slot.inputJson += dt.partial_json
        }
      } else if (payload.type === 'content_block_stop') {
        // 思考块收尾：整块（原始文本 + 签名）产出一次，供落盘/下一轮回放。
        // 两个槽表**分开**取 key：缺 index 的旧式端点上 lastThinkKey/lastToolKey 各自指向
        // 自己那类未收尾块，混用一个 key 会让另一类槽永远收不了尾。
        const thinkKey = hasIdx ? payload.index : lastThinkKey
        const thinkSlot = thinkKey === null || thinkKey === undefined ? undefined : thinkSlots.get(thinkKey)
        // 只对"该 index 上确实有 tool_use 槽"才产出——文本/思考块的 stop 不再误触发
        const key = hasIdx ? payload.index : lastToolKey
        const slot = key === null || key === undefined ? undefined : toolSlots.get(key)
        // 块收尾即该块内容的终点 ⇒ 先吐净余量再吐本块产出，保证 思考→正文→工具 的顺序
        // （见 flushPending 注释：不吐净则短正文被押到流末、跑到工具卡片之后）。
        flushPending()
        // 完整思考块紧跟实时尾巴之后（实时帧 → 完整块 → 正文 → 工具）：collector 侧
        // 按这个顺序把 buf 与 block 分别记账，落盘序与上屏序一致。
        if (thinkSlot) {
          out.push({ type: 'thinking_block', thinking: thinkSlot.text || thinkSlot.inline || '', signature: thinkSlot.signature })
          thinkSlots.delete(thinkKey)
          if (lastThinkKey === thinkKey) lastThinkKey = null
        }
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
      // 流末仍未收到 content_block_stop 的思考块也要保住（否则回放会缺块 → DeepSeek 400）
      drainThinkSlots(out)
      return out
    },
    usage() { return usage },
    stopReason() { return stopReason },
  }
}

const MOCK_USAGE = { input_tokens: 10, output_tokens: 20 }
// 前缀缓存观测夹具的请求序号（2026-09-18 spec §9.1）：mockStream 每次调用 = 1 请求，
// 每请求取一段 ⇒ 严格按请求推进。模块级：同进程内跨请求保持（每个 spawn 新进程自然归零）。
let mockCacheSeqN = 0

// `big:<字符数>` 夹具的正文（2026-09-18 Task 6）：确定性 ASCII 文本，每行 100 字符，
// 行数 = ceil(字符数/100)，故 Read 出来的工具结果体量≈请求值（Read 会加行号前缀，偏差在
// 个位数百分比内）。**刻意不含 CJK**：中文按密度 1 计价（context.mjs 头注），会让同样的
// 字符数得到约 4 倍 token，使"体量旋钮"与 token 估算脱钩、影响测试可读性。
function bigFixtureText(chars) {
  const perLine = 100
  const total = Math.max(1, Math.ceil(Math.max(perLine, Math.floor(chars)) / perLine))
  const lines = []
  for (let i = 0; i < total; i++) {
    const head = `line-${String(i).padStart(5, '0')}-`
    lines.push(head + 'x'.repeat(Math.max(1, perLine - head.length)))
  }
  return lines.join('\n')
}

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
  // 思考块持久化测试（2026-09-23）：PONOS_MOCK_THINKING=1 → 每次请求先产出两段
  // thinking、再产出文本。用于断言"思考条目落盘且排在该迭代 assistant 条目之前"。
  // 放最前（任何历史形态都接管），保证逐次请求形态稳定可断言。
  if (process.env.PONOS_MOCK_THINKING === '1') {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'thinking', text: '思考甲' }
    yield { type: 'thinking', text: '思考乙' }
    // 子 lane 落盘顺序靶点（2026-09-23 Task 3）：子 lane 的 assistant 落盘点全在**工具迭代**
    // （无工具调用即收尾、不写 assistant 条目），只产文本时"思考先于该迭代 assistant"这条
    // 顺序断言不出来——transcript 里根本没有 assistant 可比。PONOS_MOCK_THINKING_TOOL=1 →
    // 首个请求（历史无 tool_result）额外产出一个 Bash 工具轮，使思考与该轮 assistant 落在
    // 同一迭代；后续请求沿用原纯文本收尾形态。未设本变量时行为逐字不变（主循环用例不受影响）。
    const sawToolResult = (messages || []).some((m) => m?.role === 'user' && Array.isArray(m?.content) &&
      m.content.some((b) => b?.type === 'tool_result'))
    if (process.env.PONOS_MOCK_THINKING_TOOL === '1' && !sawToolResult) {
      yield { type: 'tool_use', id: `tool_use_think_tool_${Math.floor(Math.random() * 1e9)}`, name: 'Bash', input: { command: 'echo lane-think-ok' } }
      yield { type: 'usage', usage: MOCK_USAGE }
      return
    }
    yield* streamText('收到。', signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
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
  // 前缀缓存观测夹具（2026-09-18 spec §9.1）：PONOS_MOCK_CACHE_SEQ="in:10000,read:90000|..."
  // 按请求序号取段（越界取最后一段 ⇒ 稳态只需写一段），字段 in/read/new/out/tool。
  // ★ 已知限制（评审 Finding 3；**只写清语义，不改行为**）：这个"请求序号"计的是
  //   **mockStream 调用数**，不是"主请求数"——
  //     · 摘要请求等**额外模型调用**同样消耗一段（压缩的摘要调用走的就是同一条 mockStream）；
  //     · 下方的 `mockCacheSeqN++` 排在 `signal?.aborted` 检查**之前**，故被 abort 取消的
  //       调用也照样消耗一段。
  //   于是若与"压缩 + 本夹具"在**同一进程**里联用，序列推进会快于 `[cache]` 行的 `req`
  //   ——二者**错位**；而"越界取最后一段"的兜底会把这种错位**掩盖成重复值**（看起来像稳态），
  //   极难诊断。⇒ 联用时必须先核对本计数器与 `[cache] req` 是否对齐，再解释三态。
  // **为什么新开分支**：MOCK_USAGE 被 58 处 yield 引用，全替换改动面大且无收益；
  // 本分支只在显式设 env 时接管 ⇒ 零回归。位置在 LOOP 之后（LOOP 有"必须放最顶"的
  // 优先权），其余分支各有独立 env，互不抢先。
  if (process.env.PONOS_MOCK_CACHE_SEQ) {
    const seq = String(process.env.PONOS_MOCK_CACHE_SEQ).split('|')
    const seg = seq[Math.min(mockCacheSeqN, seq.length - 1)]
    const u = {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 20,
      // ★ 存在性信号必须显式带上（2026-09-18 cacheStats 语义修订的跨任务一致性要求）：
      //   本分支**不经 normalizeUsage**（直接 yield 字面量 usage，故存在性不会被 `?? 0` 销毁
      //   也不会被自动补上），而 cacheStats.supported 现由「端点是否**上报**缓存字段」驱动。
      //   缺此键 ⇒ 退化启发式 `read + create > 0` ⇒ 序列里 read:0 的那一步被判
      //   cache-fields-vanished（判据 ③）而非预期的 cache-drop（判据 ⑤）——二者在 [cache]
      //   行上都只是 st=suspicious，肉眼与断言都分不出来。真实 Anthropic 端点总是如实上报
      //   这两个字段，夹具必须与之同构。默认 MOCK_USAGE **刻意不带**该键（证明"端点无缓存
      //   字段 ⇒ 静默 unsupported"仍成立，见 engine-cache-obs.test.mjs）。
      cache_fields_reported: true,
    }
    // tool=1 → 本段改为"工具轮"（产出一次非高危 Bash，先例 [mock:tool-safe]）。**为什么需要**：
    //   观测器是**轮内局部量**（engine.mjs 的 runTurnInternal 里 createCacheObserver），跨轮不
    //   复用比较基准 ⇒ "一轮一请求"的形态下相邻比较永远不存在，三态判定（尤其 suspicious）
    //   端到端**不可达**。要观测相邻请求的骤降，就必须把两次请求放进**同一轮**，而工具轮是
    //   唯一能让引擎在同一轮里再发一次请求的机制。默认关（不写 tool=1 时行为与无此键完全一致）。
    let withTool = false
    let bigChars = 0
    for (const kv of seg.split(',')) {
      const idx = kv.indexOf(':')
      if (idx < 0) continue
      const key = kv.slice(0, idx).trim()
      const n = Number(kv.slice(idx + 1)) || 0
      if (key === 'in') u.input_tokens = n
      else if (key === 'read') u.cache_read_input_tokens = n
      else if (key === 'new') u.cache_creation_input_tokens = n
      else if (key === 'out') u.output_tokens = n
      else if (key === 'tool') withTool = n > 0
      else if (key === 'big') bigChars = n
    }
    mockCacheSeqN++
    if (signal?.aborted) throw abortError()
    // big:<字符数> → 本段改为"大体积工具轮"（2026-09-18，Task 6 夹具增强）——**为什么需要**：
    //   归因 `cause=post-aged` 要求压缩链路真的发生**老化清除**（compact.mjs 的
    //   `ageOutToolResults`），而老化需要 est 同时越过两道门（token 阈值 + clearRatio 门槛，
    //   见 compact.mjs:1003/1011）；原夹具的 tool 轮只 `echo cache-seq-N`（体量几十字节），
    //   est 永远够不着门槛 ⇒ `action=aged` **不可达** ⇒ 端到端的 post-aged 无法验证。
    // 形态选择（Read 大文件而不是 Bash 大输出）：① Read 结果**豁免**落盘替换
    //   （engine.mjs:1443 与 applyAggregateResultBudget 的 Read 例外）⇒ 大内容真的留在
    //   模型输入里，不会被 `<persisted-output>` 预览悄悄缩掉；② Read 属
    //   `REPLAYABLE_TOOLS`（compact.mjs:27）⇒ **可被老化清除**，正是本夹具要触发的那条路径。
    // 幂等与隔离：文件写在 `PONOS_CONFIG_DIR`（无则 cwd）下，按**请求序号**命名
    //   （`cache-seq-big-<N>.txt`）⇒ 同进程内多次 big 段互不覆盖，也绕开 Read 的
    //   "文件自上次读取后未变化"去重（那会让第二次读取返回短文，静默缩掉体量）。
    // 行数上限：Read 单次上限 2000 行（tools.mjs READ_MAX_LINES）⇒ 每行 100 字符、
    //   行数 = ceil(n/100)，调用方保持 n ≤ 190_000 才不会触发"未读完"提示。
    // 默认关：不在段里写 big: 时行为与无此键**逐字一致**（withTool 分支不变）。
    // ★ Minor-6（2026-09-18 评审）：big: 有**两条静默退化路径**，且**不做清理**——
    //   ① 写盘失败（`mkdirSync`/`writeFileSync` 抛错，如目录只读）⇒ `file = null` ⇒ 工具调用
    //      退化成**相对路径** `cache-seq-big-<N>.txt`（通常 Read 报"文件不存在"）；调用方的
    //      est 断言会紧接着变红，故对夹具是**可见**失败，但对"只看 [cache] 行"的读者是静默的。
    //   ② **本进程**把 `file_path` 记为绝对路径（写盘成功时），但**消费它的 Read 在另一处**：
    //      若该绝对路径落在 Read 的 `--add-dir` 白名单之外，读会被**拒**（同样静默退化成
    //      小/空结果）。当前所有调用点都把 configDir 同时作为 add-dir，故未触发；**新增调用点
    //      必须保持这个不变式**（configDir ⊆ add-dirs），否则夹具会静默失去"大体积"效果。
    //   残留：文件留在 `PONOS_CONFIG_DIR || process.cwd()` 下且**无人清理**——kernel-tests /
    //      本仓实验都在临时目录里跑并 `rmSync`，故只有**手工**在真实目录里用 big: 会残留
    //      `cache-seq-big-*.txt`（诊断夹具的既有取舍，不为此加清理逻辑、不动产品行为）。
    if (bigChars > 0) {
      await sleep(MOCK_SLEEP_MS)
      let file = null
      try {
        const dir = process.env.PONOS_CONFIG_DIR || process.cwd()
        file = join(dir, `cache-seq-big-${mockCacheSeqN}.txt`)
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, bigFixtureText(bigChars), 'utf-8')
      } catch { file = null } // 退化路径①：落盘失败 ⇒ 相对路径（详见上方 Minor-6 两条路径）
      yield {
        type: 'tool_use',
        id: `tool_use_mock_cache_big_${mockCacheSeqN}`,
        name: 'Read',
        input: { file_path: file || `cache-seq-big-${mockCacheSeqN}.txt` },
      }
      yield { type: 'usage', usage: u }
      return
    }
    if (withTool) {
      await sleep(MOCK_SLEEP_MS)
      // 命令带请求序号：避免与引擎"连续相同工具调用"守卫（repeatStreak）撞上——本夹具的目的是
      // 让每请求都真发出去，不被提醒/自愈注入插队。
      yield { type: 'tool_use', id: `tool_use_mock_cache_${mockCacheSeqN}`, name: 'Bash', input: { command: `echo cache-seq-${mockCacheSeqN}` } }
      yield { type: 'usage', usage: u }
      return
    }
    yield* streamText(`缓存观测夹具：第 ${mockCacheSeqN} 次请求`, signal)
    yield { type: 'usage', usage: u }
    return
  }
  // 系统提示探针（2026-09-12 lane 技能目录测试）：PONOS_MOCK_SYS_PROBE=<needle> →
  // 请求内 system 条目含该子串则回 SYS_PROBE:1，否则回 SYS_PROBE:0。系统提示不落盘
  // （transcript 只有 user/assistant），这是唯一能端到端断言"系统提示真进了请求"的口子。
  // 多探针（2026-09-12 chat 隔离测试）：needle 用 `|` 分隔时逐项判定，
  // 回 SYS_PROBE:<bit 串>（如 '1100' = 前两项命中）——一次 spawn 可断言多个区块
  // 的有无，避免"每条断言各跑一个内核进程"。
  if (process.env.PONOS_MOCK_SYS_PROBE) {
    const needles = String(process.env.PONOS_MOCK_SYS_PROBE).split('|')
    const sysText = (messages || [])
      .filter((m) => m?.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b?.text || '').join('')))
      .join('\n')
    if (signal?.aborted) throw abortError()
    const bits = needles.map((n) => (sysText.includes(n) ? '1' : '0')).join('')
    yield* streamText(`SYS_PROBE:${bits}`, signal)
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 失真锚点注入探针（2026-09-15）：PONOS_MOCK_ANCHOR_PROBE=<needle> → 每轮把请求体内
  // **任意非 system 条目**是否含该子串，写成 stderr 一行 `ANCHOR_PROBE:<bits>`（多针用
  // `|` 分隔、回 bit 串）。**旁路观测，不改变响应**：早期版本命中即 return，会顶掉
  // scripted 场景（[mock:fidelity-read-fail] 被截胡 → 失真场景根本建不起来）；而 mock
  // 的场景状态是会话级持续的，仅"消息不含 [mock: 时才探测"也会漏掉后续轮次。
  // 必要性：锚点是纯派生（不落盘、不发事件），只断言 ponos_health 带 anchorText 只能
  // 证明"检测到了"，证明不了"锚点真进了发给模型的请求"——stderr 探针是唯一口子。
  if (process.env.PONOS_MOCK_ANCHOR_PROBE) {
    try {
      const needles = String(process.env.PONOS_MOCK_ANCHOR_PROBE).split('|')
      const bodyText = (messages || [])
        .filter((m) => m?.role !== 'system')
        .map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b?.text || '').join('')))
        .join('\n')
      const bits = needles.map((n) => (bodyText.includes(n) ? '1' : '0')).join('')
      process.stderr.write(`[mock-anchor-probe] ANCHOR_PROBE:${bits}\n`)
    } catch { /* 观测失败不影响 mock 响应 */ }
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
      /** @type {ApiError} */ const e = new Error('内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":"This model\'s maximum context length is 40000 tokens. However, you requested 8192 output tokens and your prompt contains at least 41000 input tokens, for a total of at least 49192 tokens. Please reduce the length of the input prompt or max_tokens."}}')
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
    /** @type {ApiError} */ const err = new Error('内核：API 请求失败 503 fetch failed')
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
  // 长前台工具（2026-09-21 长任务可靠性 P2）：产一个"跑得比硬看门狗阈值久"的 Bash 调用，
  // 用于验收「在飞工作期间内核不得被硬看门狗误杀」（活性心跳的放行路径）。
  // 工期由 PONOS_MOCK_TOOL_LONG_MS 控制（默认 6000）：须 > 硬看门狗阈值、< 工具 deadline。
  // 与 [mock:tool-timeout] 恰成对照：那条是"工具**超时**结束"（在忙，但有 tool_result 收口），
  // 这条是"工具正常跑很久"——期间**零 wire 输出**，正是被旧判据误杀的那种形态。
  // 只为**首轮**发 tool_use：tool_result 回来后落到下面的工具结果回合正常收尾（否则永远
  // 等不到 result）。计数沿用本文件既有惯例（process.env 计数，子进程天然复位）。
  if (JSON.stringify(messages || []).includes('[mock:tool-long]')) {
    if (Number(process.env.PONOS_MOCK_TOOL_LONG_N || 0) === 0) {
      process.env.PONOS_MOCK_TOOL_LONG_N = '1'
      if (signal?.aborted) throw abortError()
      await sleep(MOCK_SLEEP_MS)
      const longMs = Number(process.env.PONOS_MOCK_TOOL_LONG_MS || 6000)
      yield* streamText('开始一个较长的前台任务（执行期间不产出任何内容）。', signal)
      yield {
        type: 'tool_use',
        id: `tool_use_long_${Math.floor(Math.random() * 1e9)}`,
        name: 'Bash',
        input: { command: `node -e "setTimeout(()=>{},${longMs})"`, timeout_ms: longMs + 2000 },
      }
      yield { type: 'usage', usage: MOCK_USAGE }
      return
    }
  }
  // 超时活跃/连击（P1 Task 9，2026-09-21）：连续产出"会超时的 Bash 调用"，驱动两件事：
  // ① 双计时器 —— 模型在等长命令（每批都有超时）不该被误判"无实质进展"（症状①）；
  // ② 连击预算 —— "在忙"的续命不能变成无限拖延，连续多批全超时须被兜住。
  // 与 [mock:loop-measure] 恰成对照：那条是"没超时也没进展"（打转），这条是"有超时活动"。
  // 轮数由 PONOS_MOCK_TIMEOUT_ROUNDS 控制（默认 4），达到后转纯文本收尾防死循环；
  // 次数按 PONOS_MOCK_TIMEOUT_N 计数（沿用本文件既有惯例，测试每轮开跑前清该变量复位）。
  // 必须放在"工具结果回合"分支之前 —— 否则任何 tool_result 之后都会立刻文本作答返回。
  if (JSON.stringify(messages || []).includes('[mock:tool-timeout]')) {
    const rounds = Number(process.env.PONOS_MOCK_TIMEOUT_ROUNDS || 4)
    const n = Number(process.env.PONOS_MOCK_TIMEOUT_N || 0) + 1
    process.env.PONOS_MOCK_TIMEOUT_N = String(n)
    if (n > rounds) {
      yield* streamText('超时探测结束：已按新策略收束 [mock:timeout-done]', signal)
      yield { type: 'usage', usage: MOCK_USAGE }
      return
    }
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    // 命令本体远超 timeout_ms ⇒ 每轮必然以"工具超时"结束（timeout 标记进 toolResults）
    yield* streamText(`第 ${n} 次长命令（预期超时）。`, signal)
    yield {
      type: 'tool_use',
      id: `tool_use_timeout_${n}_${Math.floor(Math.random() * 1e9)}`,
      name: 'Bash',
      input: { command: 'node -e "setTimeout(()=>{},10000)"', timeout_ms: 250 },
    }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 工具结果回合：仅当"最后一条消息"为 tool_result 轮才报告执行结果（引擎工具
  // 循环第二轮）。不得用"历史中任意 tool_result"判定——跨轮连续调用 [mock:tool]
  // 时，上一轮被拒绝的 tool_result 残留在历史里，会让 mock 误走结果回显分支而
  // 永远不再产出 tool_use（denial 降级测试复现，2026-08-21 修复）。
  // 同族重试模拟（P0-3，2026-09-16）：验证"灾难命令被拒后，模型改写/升权再试"必须被
  // **直接硬拒**而不是再次弹窗。**必须放在"工具结果回合"分支之前**——那个分支会在任何
  // tool_result 之后立刻文本作答返回，永远走不到下面的标记分支，也就模拟不出同轮重试。
  // 用法：一轮内第 1 次发 `rm -rf /`，第 2 次发**同族改写变体** `rm -rf /*`（刻意不字面
  // 相同：字面比对挡不住的那种，正是族粒度拦截要证明的），第 3 次起落到下面的结果回显
  // 分支让轮次正常结束。次数按 PONOS_MOCK_CATA_RETRY_N 计数（沿用本文件 overflow 计数
  // 的既有惯例），测试在每轮开跑前清该变量即可复位。
  if (lastText.includes('[mock:catastrophic-retry]') || JSON.stringify(messages || []).includes('[mock:catastrophic-retry]')) {
    const nth = Number(process.env.PONOS_MOCK_CATA_RETRY_N || 0) + 1
    process.env.PONOS_MOCK_CATA_RETRY_N = String(nth)
    if (nth <= 2) {
      if (signal?.aborted) throw abortError()
      await sleep(MOCK_SLEEP_MS)
      const command = nth === 1 ? 'rm -rf /' : 'rm -rf /*'
      yield { type: 'tool_use', id: `tool_use_mock_cata_retry_${nth}`, name: 'Bash', input: { command } }
      yield { type: 'usage', usage: MOCK_USAGE }
      return
    }
  }
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
        /** @type {ApiError} */ const e = new Error('内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":"This model\'s maximum context length is 131072 tokens. However, you requested 64000 output tokens and your prompt contains at least 70000 input tokens, for a total of at least 134000 tokens. Please reduce the length of the input prompt or max_tokens."}}')
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
      /** @type {ApiError} */ const e = new Error('内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":"This model\'s maximum context length is 8000 tokens. However, you requested 8192 output tokens and your prompt contains at least 9000 input tokens, for a total of at least 17192 tokens. Please reduce the length of the input prompt or max_tokens."}}')
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
  // P2b 授权（2026-10-15）：**同一次运行内两个 Screen 输入动作**——"一次运行只问一次"的端到端夹具
  //（见 kernel-tests/screen-input-authorization.test.mjs）。两条 tool_use 落在**同一批**里，
  // 而 Screen 不是 concurrencySafe ⇒ engine 串行执行，第二个动作的闸门能看到第一个动作批准后的
  // 运行级记忆 —— 这正是要测的语义（若并发则退化为"问两次"，方向仍是 fail-closed）。
  // ★ 本夹具**绝不发真实输入**：Screen 的 screenDriver 走 bridge_request，测试里没有主进程，
  //   由测试自己用 resolveScreen 回桩回执；executor/ps1 两层另有各自的负面测试。
  // 必须放在 `lastIsToolResult` 早期返回**之后**：那一分支负责在工具结果回来后收尾（否则同轮无限重发工具）。
  if (lastText.includes('[mock:screen-input-x2]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_screen_click', name: 'Screen', input: { action: 'clickAt', params: { window: 'mock-target', x: 100, y: 200 } } }
    yield { type: 'tool_use', id: 'tool_use_mock_screen_drag', name: 'Screen', input: { action: 'drag', params: { window: 'mock-target', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } } } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // P2b 授权：**只读 act** 轮（displays）—— 证明只读动作不弹窗、且载荷里授权证据为 false（G6）。
  if (lastText.includes('[mock:screen-read]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_screen_displays', name: 'Screen', input: { action: 'displays' } }
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
      /** @type {ApiError} */ const e = new Error('内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":"This model\'s maximum context length is 32768 tokens. However, you requested 64000 output tokens and your prompt contains at least 24576 input tokens. Please reduce the length of the input prompt or max_tokens."}}')
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
  // 子 lane 计划尾守卫测试（2026-09-16 两侧对齐）：触发 Agent tool_use，子任务 prompt
  // 内嵌 [mock:lane-plan-tail]——lane 侧首轮只产"承诺后续动作"文本（无工具调用），
  // engine 注入计划尾续跑指令后由下方 R3-2 恢复分支（历史含计划尾注入串）产成功 Bash。
  // marker 与既有互不子串劫持：'agent-lane-plan-tail' 中 'lane' 前有 'agent-'，
  // 不匹配 lane 侧要求紧邻 'mock:' 的 [mock:lane-plan-tail]。
  if (lastText.includes('[mock:agent-lane-plan-tail]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_lane_plan_tail', name: 'Agent',
      input: { subagent_type: 'general-purpose', prompt: '子任务：请针对 [mock:lane-plan-tail] 输出确认并执行' } }
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
  // 子 lane 计划尾模拟（2026-09-16 两侧对齐 [mock:lane-plan-tail]）：lane 任务 prompt 仍为
  // 末条 user 文本（lastText 含标记 → 尚未经历注入轮）⇒ 只产**文本**、不产工具调用，且
  // 文本尾部是"承诺后续动作"（命中 gen-guards 的 PLAN_TAIL_RE）——模拟子任务"只说不做"。
  // engine 在"无工具轮 break"前应注入计划尾续跑指令（而不直接收尾），随后 R3-2 恢复分支
  // （历史含【系统】你在上一轮承诺了后续动作串）产成功 Bash，lane 得以继续执行。
  // 用 lastText 门控（非历史门控）：注入轮之后 lastText 已是注入文案、不再含标记，
  // 否则会每轮重复产计划尾文本直到 guardInjections 上限，测不出"注入 → 恢复"路径。
  if (lastText.includes('[mock:lane-plan-tail]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'text', text: '我先看一下这个子任务的输入。接下来我要读取核心表格并核对数据。' }
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
  // 跨 Agent 证据面测试：[mock:edit] 触发一次 Edit + 一次 Read
  // （Edit 产物须计入 outputs；Read 路径须进 task_notification.reads）
  if (lastText.includes('[mock:edit]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    const base = process.env.PONOS_MOCK_WRITE_DIR || process.cwd()
    yield { type: 'tool_use', id: 'tool_use_mock_edit_1', name: 'Edit', input: { file_path: `${base}/mock-c.txt`, old_string: 'old', new_string: 'new' } }
    yield { type: 'tool_use', id: 'tool_use_mock_read_1', name: 'Read', input: { file_path: `${base}/mock-c.txt` } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
  // 跨 Agent 证据面测试（output_file 语义回归锁）：[mock:write-edit-write] 在同一轮产
  // Write A → Write B → Edit A ⇒ writePaths = [A, B, A]。用于锁住 output_file 仍取"最后
  // 被写/改的文件"（A），而 outputs 是保序去重的 [A, B]——两者在去重后必须不同。目录
  // 同 [mock:write]：PONOS_MOCK_WRITE_DIR 指定。
  if (lastText.includes('[mock:write-edit-write]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    const base = process.env.PONOS_MOCK_WRITE_DIR || process.cwd()
    yield { type: 'tool_use', id: 'tool_use_mock_wew_1', name: 'Write', input: { file_path: `${base}/mock-a.txt`, content: 'old\n' } }
    yield { type: 'tool_use', id: 'tool_use_mock_wew_2', name: 'Write', input: { file_path: `${base}/mock-b.txt`, content: 'b' } }
    yield { type: 'tool_use', id: 'tool_use_mock_wew_3', name: 'Edit', input: { file_path: `${base}/mock-a.txt`, old_string: 'old', new_string: 'new' } }
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
  // 同轮多子 Agent 派发：[mock:agent-pair] 在**一条 assistant 消息**里产出两个 Agent
  // tool_use（测试前台批量并发用）。为什么必须同轮：runToolBatch 的并发判定按"同一批
  // 内的工具"做，跨轮派发天然串行（第二轮要等第一轮结果回来），测不出并发能力。
  if (lastText.includes('[mock:agent-pair]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_agent_pair_1', name: 'Agent', input: { subagent_type: 'general-purpose', prompt: '同轮子任务 A：请输出一句确认' } }
    yield { type: 'tool_use', id: 'tool_use_mock_agent_pair_2', name: 'Agent', input: { subagent_type: 'general-purpose', prompt: '同轮子任务 B：请输出一句确认' } }
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
export async function* protocolStream({ url, body, headers, signal, parser = createAnthropicParser() }) {
  // 连接/首字节超时（2026-09-09 挂起事故根因修复）：默认从 30s 提到 600s。
  // 实测网关在 HTTP 层缓冲整个排队+思考阶段（复杂请求响应头 207s 才到），30s
  // 超时会在排队期间反复掐断请求——服务器侧仍在生成（孤儿占用槽位），重试
  // 制造更多孤儿，形成"越重试越挂"的死亡螺旋（实测 8 分钟 19 次重试全灭）。
  // 真正的挂起守卫是 engine 的首字节看门狗（447/480s，abort 信号传导到 fetch）；
  // TCP 连接失败（拒绝/RST）由系统栈秒级报错，不需要 30s 兜底。
  const connectTimeoutMs = Math.max(0, Number(process.env.PONOS_CONNECT_TIMEOUT_MS || 600_000))
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
    /** @type {ApiError} */ const err = new Error(`内核：API 请求失败 ${res.status} ${detail.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let usagePushed = false
  let eventCount = 0 // 已成功解析的 SSE 事件数——空流判据：HTTP 200 后 0 事件即上游无产出
  let sseEventName = '' // 当前 SSE `event:` 名（error/ping 判定用；空行/新 event 行覆盖）
  // 解析器由调用方注入（2026-09-23 协议兼容）：默认值即 Anthropic 解析器，
  // 且默认参数**每次调用求值** ⇒ 每次流都是新实例（不会跨请求/跨重连累积状态）。
  // 本函数以下的逻辑一律协议无关（连接超时、`connection: close`、断流重连、空闲看门狗、
  // 空流归一、SSE `event:` 名解析、流内错误抛错、usage 终态收敛）——**勿在其中再判协议**。
  // P1-6：单次流读空闲看门狗。默认 300s，但必须跟随首内容宽限校准——若
  // PONOS_STREAM_FIRST_BYTE_MS（provider firstByteMs 注入，如 447s）长于 300s，
  // 本层仍按 300s 掐断会在慢 prefill（实测 362KB 上下文排队 >5min）时形成
  // "每 300s 重发同一请求"的失速循环（2026-09-10 实测 881s 静默告警根因：
  // engine 首字节看门狗 447/600s 还没到，流读先被 300s 掐死 → zeroEvents
  // 无限重试）。大请求（>200K 字符，engine adaptiveFirstByteMs 同门槛）放宽
  // 到 600s 封顶。显式 PONOS_STREAM_IDLE_TIMEOUT_MS 仍权威（测试/用户覆盖）。
  const idleTimeoutMs = (() => {
    const explicit = Number(process.env.PONOS_STREAM_IDLE_TIMEOUT_MS)
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
  /** @type {ApiError} */ const e = new Error('stream interrupted: ' + (err?.message || String(err)))
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
  /** @type {ApiError} */ const e = new Error(`${ptype}: ${msg}`)
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
  /** @type {ApiError} */ const e = new Error(`内核：API 请求失败 400 {"type":"error","error":{"type":"BadRequestError","message":""auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"}}${detail ? `（${String(detail).slice(0, 120)}）` : ''}`)
  e.status = 400
  return e
}

// 是否因 cache_control 被端点拒绝（400/422 或缓存相关 message）→ 回退重发判断
function isCacheRejection(err) {
  const status = err?.status || 0
  const msg = String(err?.message || '')
  return status === 400 || status === 422 || /cache|unknown field|unsupported/i.test(msg)
}

// 思考深度 → 请求体字段（对齐自有统一档位 + DeepSeek Anthropic 兼容端点：
// 深度走 reasoning_effort（low/high/max），关闭走 thinking:disabled；两者不并发生
// 发，避免 DeepSeek #1397 的 400）。auto/未知 → {}（模型原生自适应，不注入）。
//
// **优先级是显式的，且经实测确定（Task 11 探针，2026-09-13，n=8/臂/题）**：
//   ① 策略关思考（thinkingMode==='off'）或用户 off 档 → thinking:{type:'disabled'}
//      —— 唯一被实测证明能压掉思考量的手段：中位墙钟 3.1× / 1.5×，且 16/16 全对
//   ② provider 开了思考模式（PONOS_THINKING_ENABLED=1）→ thinking:{enabled,budget}
//      —— 唯一真正控制思考量的旋钮（MiniMax 等不显式开启则思考完全不可见）
//   ③ 其余档位 → reasoning_effort
// 关键实测（决定了②必须排在③之前，而不是"两害相权"）：在本端点 `reasoning_effort`
// **不控思考量**——low/high/max 两轮采样方向相反（low 545/710 vs max 594/423 字符），
// 且同设置内跑次间方差极大（budget4096 一次跑到 2987 字符，另一次 279，=10.7×）。
// 故"两个旋钮都不发"和"发 reasoning_effort"在效果上无法区分，二选一只为避免 400。
//
// thinkingMode 由**策略层**（engine 的阶段判断）传入：'off' = 本步强制关思考；
// 其余值（含 null）一律视为"不干预"，保持上面的既有行为——这样策略永不启用时本函数
// 的行为与 2026-09-13 之前逐字节相同。
// 「用户显式档位被 provider 的思考开关吃掉」的提示文案（纯函数 ⇒ 可整表单测，
// 不受"每进程只提示一次"这个模块级状态影响）。null = 没有话要说。
export function effortDroppedNotice(effort, { thinkingEnabled = false, budget = 4096 } = {}) {
  if (!thinkingEnabled) return null
  if (effort !== 'low' && effort !== 'high' && effort !== 'max') return null // auto/未知本就不注入，不算"被吃掉"
  return `[api] effort=${effort} 未随请求发出：该 provider 走 thinking 开关`
    + `（实发 thinking:{enabled,budget_tokens:${budget}}）。实测本端点 reasoning_effort 不控思考量；`
    + `要真正降思考请用 off 档或 PONOS_EFFORT_POLICY（见 docs/superpowers/specs 2026-09-13 §6）`
}

let effortDiagDone = false
export function effortParam(effort, thinkingMode = null) {
  if (thinkingMode === 'off' || effort === 'off') return { thinking: { type: 'disabled' } }
  // provider 思考模式（2026-09-10）：MiniMax 等不认 reasoning_effort 的云端，
  // 显式 thinking:enabled+budget 后流内才有 thinking_delta（实测无参数时思考
  // 完全不可见——思考混进 text_delta 或整段隐藏）。auto 档位走本分支。
  if (process.env.PONOS_THINKING_ENABLED === '1') {
    const budget = Number(process.env.PONOS_THINKING_BUDGET || 4096)
    const n = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 4096
    // 诊断不降级：旧实现对此**完全静默**——用户在设置面板把档位从 low 拉到 max，
    // 线上请求一字未变却无从察觉。落一行（每进程一次）到内核 stderr，可经
    // kernel-stderr.log 追查。文案由纯函数给，这里只管"只说一次"。
    const notice = effortDroppedNotice(effort, { thinkingEnabled: true, budget: n })
    if (notice && !effortDiagDone) {
      effortDiagDone = true
      try { console.error(notice) } catch { /* 日志失败不影响请求 */ }
    }
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

// 是否给 system 打 ephemeral 缓存标记（P0-2，2026-09-18）。
//
// 为什么不再用单一手工 env 决定：两家端点的语义**相反且互斥**——
//   ・Anthropic **官方**：不显式标记 ⇒ 完全不缓存（0 命中，缓存收益全丢）
//   ・DeepSeek 兼容端点：**忽略** cache_control（官方兼容性表明确列为"忽略"），缓存自动
//     生效；打了没用，还可能撞"未知字段 400"再触发一次"去标记重发"（多一次往返 + 重复 prefill）
// 多端点混用下，`PONOS_PROMPT_CACHE` 无论默认开/关都必然对一半端点不合适。改按能力判定：
//   ① `PONOS_PROMPT_CACHE` 显式 '1'/'0' ⇒ **一律以它为准**（保留既有手工契约与既有测试）
//   ② 未设 ⇒ 只对"必须显式标记"的端点自动开启（Anthropic 官方 / Bedrock / Vertex）
//   ③ 其余端点（DeepSeek、本地 vLLM、未知网关）⇒ 保持关闭 = **原有默认行为不变**（零回归）
// 刻意**不**用 baseUrl 通配去猜"是不是 Anthropic 兼容"：第三方网关的缓存语义无法从域名
// 推断，猜错要么丢收益、要么引入无谓的 400 重发。要给网关开，显式设 env 即可。
export function cacheMarkerEnabled(baseUrl = '', env = process.env) {
  const explicit = String(env.PONOS_PROMPT_CACHE ?? '').trim()
  if (explicit === '1' || explicit === '0') return explicit === '1'
  return /anthropic\.com|claude\.ai|bedrock|aiplatform\.googleapis\.com|vertex/i.test(String(baseUrl))
}

// ── 思考块回放（2026-10-22）────────────────────────────────────────────────────
// 背景：DeepSeek 的 /anthropic 端点在**思考模式**下要求把上一轮 assistant 的
// `content[].thinking` 原样回传（带 tools 的工具轮回放尤其强制）；缺块直接
// 400「The content[].thinking in the thinking mode must be passed back to the API」。
// session.deriveMessages 现在会把带 tool_use 的 assistant 轮次的 thinking 块并回
// content 头部；本函数决定"这份历史到底能不能原样发给当前端点"：
//   · 真 Anthropic 系（anthropic.com / claude.ai / bedrock / vertex）**校验签名**：
//     无签名的块（旧 transcript、被脱敏改写的块）发出去必 400 ⇒ 丢弃（维持旧行为）；
//     有签名的块原样回传。
//   · DeepSeek / MiniMax 等非签名兼容端点：官方要求回放，签名可为空 ⇒ 补 `signature: ''`。
//   · 本步显式关闭思考（thinking:{type:'disabled'}）时不回放——思考关了还递思考块，
//     部分端点会当协议冲突拒掉。
// 纯函数、不改入参（请求面缓存跨调用共享，原地改会污染 transcript 的内存视图）。
const SIGNING_ANTHROPIC_HOST_RE = /anthropic\.com|claude\.ai|bedrock|aiplatform\.googleapis\.com|vertex/i
export function prepareMessagesForAnthropicWire(messages = [], { base = '', thinkingDisabled = false } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const signing = SIGNING_ANTHROPIC_HOST_RE.test(String(base))
  let changed = false
  const out = []
  for (const m of messages) {
    // 压缩摘要的派生投影是 **assistant + 字符串 content**（kernel/session.mjs#
    // compactionSummaryEntry 的既有契约，deriveMessages()[0] 即它）。但上线时必须转成
    // **user**：DeepSeek /anthropic 在思考模式下从「最后一条真实 user 消息」之后校验
    // thinking 回放，而 tool_result 消息映射成 role:'tool'、不算 user ⇒ 压缩后若所有
    // 真实 user 文本都被遮蔽，摘要这个无 thinking 的 assistant 就落进校验区间 ⇒ 400
    // 「The content[].thinking ... must be passed back」。
    // ★ 2026-10-22 真机实测（7 个请求逐条对照）：带真实 user 文本的 4 次全 200，
    //   没有的 3 次全 400，且失败请求的首条恒为摘要、其余 assistant 全带 thinking。
    //   投影成 user 也符合压缩惯例（摘要=用户侧交代前情），并给校验器一个 user 锚点。
    //   只改线上副本：落盘/transcript 回放仍以 assistant 条目为真源（compact.mjs 的
    //   isSealedSummary 等判据依赖 assistant+字符串这一形态，不能动派生层）。
    if (m && m.role === 'assistant' && typeof m.content === 'string') {
      changed = true
      out.push({ ...m, role: 'user' })
      continue
    }
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)
      || !m.content.some((b) => b && b.type === 'thinking')) {
      out.push(m)
      continue
    }
    const content = []
    let touched = false
    for (const b of m.content) {
      if (!b || b.type !== 'thinking') { content.push(b); continue }
      if (thinkingDisabled) { touched = true; continue }
      const sig = typeof b.signature === 'string' ? b.signature : ''
      if (signing && !sig) { touched = true; continue }
      if (sig) { content.push(b); continue }
      content.push({ ...b, signature: '' }) // 非签名端点显式空串（DeepSeek 实证接受）
      touched = true
    }
    if (!touched) { out.push(m); continue }
    changed = true
    // 思考块被全剥且无其他内容：空 assistant content 非法，整条不发
    if (content.length) out.push({ ...m, content })
  }
  return changed ? out : messages
}

// Anthropic 协议流：tools 中立形状 → tools[]；system 抽顶层。
// prompt cache 显式化：由 cacheMarkerEnabled() 判定（P0-2 起按端点能力，不再只看 env）
// ——命中时 system 改数组形态并打 ephemeral 缓存标记。端点拒绝该字段时自动去掉标记
// 重发一次（兼容兜底，见 isCacheRejection）。
async function* anthropicStream({ model, messages, system, tools, maxTokens, signal, reasoningEffort = null, thinkingMode = null }) {
  // P4-5：注册表解析（setProvider 激活后固定；未激活 getProvider 现读 env，行为不变）
  const p = getProvider()
  // 协议相关模型名（Task 1）：未配置 modelByFormat 时与既有行为逐字相同
  const wireModel = pickModelName({ model, format: 'anthropic', modelByFormat: p.modelByFormat })
  const base = p.baseUrl
  const token = p.authToken
  if (!base || !token) throw new Error('内核：PONOS_BASE_URL / PONOS_AUTH_TOKEN 未配置')
  const useCache = cacheMarkerEnabled(base) && !!system
  // 鉴权头按 provider.authScheme 选择：默认 x-api-key（anthropic/deepseek/minimax）；
  // vLLM 等本地 Bearer-only 端点配置 authScheme=bearer 后改发 Authorization。
  const headers = { 'content-type': 'application/json', ...authHeaders(p), 'anthropic-version': '2023-06-01' }
  // 采样稳定性：默认 temperature=0（贪婪解码，确定性优先，支持该参数的端点生效；
  // DeepSeek 兼容端点对 temperature 不敏感且不保证 seed 复现，注入无害）。PONOS_SEED
  // 可选固定采样种子（部分端点 temperature=0 + seed 时可复现）。
  const temperature = Number(process.env.PONOS_TEMPERATURE ?? 0)
  const seedEnv = process.env.PONOS_SEED
  // 输出预算守卫（Task 6 / spec §3.6 L2）：思考型模型在小预算下会把预算吃光 ⇒ 正文为空。
  // 与档位正交（不因"是否关思考"而变，否则改档位会顺带改请求体，见 guardOutputBudget 注释）。
  const budget = guardOutputBudget({ maxTokens })
  if (budget !== maxTokens) logBudgetFloorOnce(maxTokens, budget)
  // 思考深度：reasoningEffort（low/high/max → reasoning_effort；off → thinking disabled；
  // 缺省 → 不注入，模型原生自适应）
  const effort = effortParam(reasoningEffort, thinkingMode)
  const body = {
    model: wireModel,
    max_tokens: budget,
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(seedEnv ? { seed: Number(seedEnv) } : {}),
    ...effort,
    ...(system ? (useCache ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : { system }) : {}),
    messages: prepareMessagesForAnthropicWire(messages, {
      base,
      thinkingDisabled: effort?.thinking?.type === 'disabled',
    }),
    stream: true,
    ...(tools.length
      ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) }
      : {}),
  }
  const maxReconnect = Math.max(0, Number(process.env.PONOS_STREAM_RECONNECTS ?? 3))
  // 已知取舍（审计 #9，2026-09-07 复核维持现状）：断流重连时若上一段文本已部分输出，
  // 重试可能重复半截文本。审计与产品取舍均判定"接受"——重试正确性优先于输出去重；
  // 若要改进（engine 层半截文本去重）需先做真实断流复现与评估，勿无评估直接改此处。
  // R1-1 流中断重连：重发完整请求（无断点续传），已流出的半截文本丢弃（首段可能
  // 重复，接受）；工具副作用由 engine 防重放（Task 3）兜底。abort/非 transient 直接抛。
  for (let attempt = 0; ; attempt++) {
    try {
      yield* protocolStream({ url: anthropicStreamUrl(base), body, headers, signal })
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
      // ★ 上下文超窗同样必须**先于**缓存标记兜底上抛（2026-11-01）：`isCacheRejection` 对任意
      //   400/422 都成立，于是超窗请求（正是"请求体最大"的那一类）去掉缓存标记后再发一次，
      //   必然再 400 —— 每轮白付一次满额请求，且把真实原因掩盖在第二次失败里。
      //   与上面 tools-unsupported 的纪律完全一致。
      if (classifyApiError(err).kind === 'context-window') throw err
      if (useCache && isCacheRejection(err)) {
        // 缓存标记被拒：去掉后重发一次（body 恢复纯字符串 system）
        yield* protocolStream({ url: anthropicStreamUrl(base), body: { ...body, ...(system ? { system } : {}) }, headers, signal })
        return
      }
      if (reasoningEffort && isEffortRejection(err)) {
        // 端点不支持思考深度字段：去掉后重发一次（退回模型默认思考深度）
        const { reasoning_effort, thinking, ...rest } = body
        yield* protocolStream({ url: anthropicStreamUrl(base), body: rest, headers, signal })
        return
      }
      throw err
    }
  }
}

// OpenAI Chat Completions 流（2026-09-23 协议兼容）。与 anthropicStream 的分工：
//   · 骨架**刻意保持同构**（重连次数、指数退避、tools-unsupported 先抛、effort 拒绝降级），
//     便于两侧行为对齐、审计时逐条对照；
//   · 差异**全部下沉**到 wire/openai.mjs（URL、鉴权头、请求编码、解析器）——本函数不判字段形态。
async function* openaiStream({ model, messages, system, tools, maxTokens, signal, reasoningEffort = null, thinkingMode = null }) {
  const p = getProvider()
  // 协议相关模型名（Task 1）：与 anthropicStream 同一处逻辑，未配置时逐字不变
  const wireModel = pickModelName({ model, format: 'openai', modelByFormat: p.modelByFormat })
  const base = p.baseUrl
  if (!base || !p.authToken) throw new Error('内核：PONOS_BASE_URL / PONOS_AUTH_TOKEN 未配置')
  // 鉴权固定 Bearer（OpenAI 生态约定），不看 provider.authScheme
  const headers = openaiHeaders(p)
  const url = openaiStreamUrl(base)
  const temperature = Number(process.env.PONOS_TEMPERATURE ?? 0)
  const seedEnv = process.env.PONOS_SEED
  // 输出预算守卫（Task 6）：与 anthropicStream **同一处逻辑**（只抬不降，未指定不动，与档位正交）
  const budget = guardOutputBudget({ maxTokens })
  if (budget !== maxTokens) logBudgetFloorOnce(maxTokens, budget)
  const body = encodeOpenAIRequest({
    model: wireModel,
    messages,
    system,
    tools,
    maxTokens: budget,
    reasoningEffort,
    thinkingMode,
    temperature: Number.isFinite(temperature) ? temperature : null,
    seed: seedEnv || null,
  })
  const maxReconnect = Math.max(0, Number(process.env.PONOS_STREAM_RECONNECTS ?? 3))
  for (let attempt = 0; ; attempt++) {
    try {
      // ★ 每次调用都传**新解析器实例**：重连若复用旧实例，上一段的文本缓冲与工具槽会串进下一段
      yield* protocolStream({ url, body, headers, signal, parser: createOpenAIParser() })
      return
    } catch (err) {
      const retryable = (err?.name === 'StreamInterrupted' || err?.name === 'TimeoutError') && !err?.zeroEvents
      if (retryable && !signal?.aborted && attempt < maxReconnect) {
        await sleepAbortable(1000 * Math.pow(2, attempt), signal)
        continue
      }
      // 与 anthropicStream 同序：工具能力未开启是终局配置错误，先于降级兜底上抛
      if (classifyApiError(err).kind === 'tools-unsupported') throw err
      if (reasoningEffort && isEffortRejection(err)) {
        // 端点不支持思考深度字段：去掉后重发一次（退回模型默认思考深度）
        const { reasoning_effort, thinking, ...rest } = body
        yield* protocolStream({ url, body: rest, headers, signal, parser: createOpenAIParser() })
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
  // 413 Payload Too Large：网关/代理层以 413 拒绝超长请求（vLLM 原生常为 400，经代理/网关后可能变 413）。
  //
  // ★★★ 2026-09-29 修（实测的**死循环**事故）：原先"消息不含上下文超限关键词 ⇒ 归为
  //   `transient`（保守可重试）"。但 413 的语义**无歧义**：负载超过服务端接受上限 ——
  //   **重试同一个 payload 永远不可能成功**。实测现场：某会话 2500+ 消息、请求体 ~1.7MB，
  //   网关回 413（nginx 风格 "Request Entity Too Large"，不含那些关键词）⇒ 被判 transient
  //   ⇒ 反复重试同一超大请求 ⇒ **61 轮 compact+api 死循环**（每轮 1.7MB，且消息数还在涨），
  //   而内核**本已具备**的 context-window 自愈（压缩腾空间/采纳真实窗口/收窄输出预算）
  //   **完全没被触发**（因为它只在 kind==='context-window' 时进入）。⇒ 修法：413 一律归
  //   `context-window`，文案关键词不再作为分类前提（仅保留它做"进一步确认"的语义）。
  //   这样"payload 过大"必然走自愈；自愈若仍进展不了，由既有熔断/进展判据收口，不再空转。
  if (status === 413) return { kind: 'context-window', retryable: false }
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false }
  if (status === 429 || /rate.?limit|too many requests/i.test(msg)) return { kind: 'rate-limit', retryable: true }
  if (/quota|billing|insufficient/i.test(msg)) return { kind: 'quota', retryable: false }
  if (/stream idle timeout/i.test(msg)) return { kind: 'transient', retryable: true }
  if (status >= 500 || /ECONN|ENOTFOUND|EPIPE|ETIMEDOUT|fetch failed|network|socket/i.test(msg)) return { kind: 'transient', retryable: true }
  // 空回复两类（Task 6 / spec §3.6）：它们是**流已正常收尾**才成立的事实，错误对象由
  // emptyCompletionError 携带 kind（流内没有错误可分类）。此处原样透传 ⇒ 任何按
  // classifyApiError 分流的层（retryStream / cli / lane）都不会把它们当瞬时错误盲重试。
  // 为什么不在此处按 message 猜：message 面向用户可读，判据不能依赖文案（会随文案改动漂移）。
  if (err?.kind === 'empty-completion' || err?.kind === 'reasoning-budget-exhausted') return { kind: err.kind, retryable: false }
  return { kind: 'unknown', retryable: false }
}

// ── 空回复两类分类 + 输出预算守卫（Task 6 / spec §3.6 类型 Ⅱ）────────────────────
//
// 实测依据（spec §1.3，2026-08-20 冒烟 + 2026-09-23 复测）：`max_tokens=512` 时思考内容会把
// 预算吃光 ⇒ `finish_reason: length`、`content` 空（铁证：`usage.completion` 恰好等于
// `max_tokens`）；4096 / 8192 均正常收尾 `stop`。⇒ 两类空回复必须分开：类型 Ⅰ「适配器缺陷」
// 靠正确实现解析器消除（最小闭环已完成）；类型 Ⅱ「预算被思考吃光」靠本节的守卫 + 可诊断错误消除。
//
// ★ `max_tokens` 是**上限而非目标**：抬升上限不增加常规成本（输出长度由内容决定），
//   故守卫只抬不降是安全的。它与 engine 既有的 OUTPUT_TIERS 升档**互补而非重复**：
//   升档发生在"已经空/截断一次之后"的补救，守卫是"别让第一发就空"。
export const OUTPUT_BUDGET_FLOOR = 4096

/**
 * 输出预算守卫：低于地板值抬到地板，其余原样（只抬不降）。
 * @param {{ maxTokens?: number, profile?: string }} args
 * @returns {number|undefined} 未指定预算（undefined/非数值）时原样返回——不擅自替调用方决定
 *
 * ★ 为什么**不区分**是否关思考（2026-09-23 实测修正）：曾按"关思考时该故障形态不存在"
 *   给关思考的调用豁免，结果把"档位旋钮"的影响从两个字段扩到三个 —— `max_tokens` 随档位
 *   变化，直接打红 `kernel-tests/effort-wire.test.mjs` 的档位不变量（"旋钮之外请求体不变：
 *   缓存前缀不被搅动"）。地板必须**与档位正交**：同一调用方在任何档位下取到同一预算，
 *   否则"改档位"就顺手改了请求体，缓存前缀判据与审计口径都跟着漂。
 */
export function guardOutputBudget({ maxTokens, profile } = {}) {
  if (!Number.isFinite(maxTokens)) return maxTokens
  if (maxTokens >= OUTPUT_BUDGET_FLOOR) return maxTokens
  return OUTPUT_BUDGET_FLOOR
}

// 预算抬升诊断（每进程每对取值只说一次，防请求密集时刷屏——与 effortDroppedNotice 同口径）。
// 必须落诊断：用户看到"我明明配了 512，请求却发 4096"而没有任何解释时，只会怀疑内核乱改配置。
let budgetFloorDiagKey = null
function logBudgetFloorOnce(from, to) {
  const key = `${from}->${to}`
  if (budgetFloorDiagKey === key) return
  budgetFloorDiagKey = key
  try {
    console.error(`[api] 输出预算已按地板抬升：max_tokens ${from} → ${to}`
      + `（${from} 下思考型模型会把预算吃光、正文为空；max_tokens 是上限而非目标，抬升不增加常规成本。）`)
  } catch { /* 日志失败不影响请求 */ }
}

/**
 * 空回复分类（两类必须分开，spec §3.6）。返回 null 表示有产出、无需分类。
 *   · reasoning-budget-exhausted：`stop_reason` 为 max_tokens/length **且有思考内容**
 *     ⇒ 预算被思考吃光，引导用户提高输出预算或关思考。
 *   · empty-completion：其余"content 空 + tool_use 空"⇒ HTTP 200 且流正常收尾却零产出，
 *     属"假成功"，必须报错而非静默。
 * @param {{ stopReason?: string|null, textLen?: number, toolCount?: number, thinkingLen?: number }} args
 *   textLen 请传**已 trim 的长度**（纯空白的"正文"不算产出，否则守卫会被空白绕过）。
 */
export function classifyEmptyCompletion({ stopReason, textLen = 0, toolCount = 0, thinkingLen = 0 } = {}) {
  if (textLen > 0 || toolCount > 0) return null
  if (stopReason === 'max_tokens' && thinkingLen > 0) {
    return {
      kind: 'reasoning-budget-exhausted',
      retryable: false,
      hint: '模型的思考内容占满了输出预算，正文被截断。请提高该 provider 的输出上限（建议 ≥4096），或为思考型模型关闭思考后重试。',
    }
  }
  return {
    kind: 'empty-completion',
    retryable: false,
    hint: '端点返回成功但没有任何内容与工具调用。请确认该模型/协议组合可用，或改用该端点的另一协议入口。',
  }
}

/**
 * 第三态的处置决策（纯函数，spec §3.6 L3）：
 *   · `switch-format`：provider 配了**与当前不同**的 `fallbackApiFormat` 且本回合还没降级过
 *     ⇒ 换协议重发一次；
 *   · `fail`：其余情形 ⇒ 由调用方抛 emptyCompletionError（带 kind/hint）。
 * `fallbackProviderId` 只作为信息带出（`providerSwitchConfigured`）：内核只有**单个** active
 * provider 注册表，热切换 provider 属 bridge 的 `switch_provider` 流程（含上下文窗口重算），
 * 内核在本回合内擅自换 provider 会留下"env 指旧、注册表指新"的不一致 ⇒ 不做，写进错误引导。
 *
 * ⚠️ 形参 JSDoc 为必需（S2.1）：`classified` 无默认值 ⇒ 缺席于推断形参类型（解构处 TS2339）。
 * @param {{
 *   classified?: object|null, currentFormat?: string, fallbackApiFormat?: string|null,
 *   fallbackProviderId?: string|null, downgraded?: boolean,
 * }} [opts]
 */
export function planEmptyCompletionRecovery({ classified, currentFormat = 'auto', fallbackApiFormat = null, fallbackProviderId = null, downgraded = false } = {}) {
  if (!classified) return { action: 'none' }
  const to = normalizeApiFormat(fallbackApiFormat) // 非法/未配置 → 'auto'
  if (!downgraded && to !== 'auto' && to !== currentFormat) return { action: 'switch-format', to }
  return { action: 'fail', providerSwitchConfigured: !!fallbackProviderId }
}

/** 无产出（类型 Ⅰ/Ⅱ）的**可诊断**错误：带 `kind` 与 `hint`，上层可分级引导而非字符串匹配。
 * ⚠️ 形参 JSDoc 为必需（S2.1）：`classified` 无默认值 ⇒ 缺席于推断形参类型（解构处 TS2339）；
 *   其形状取自 `classifyEmptyCompletion` 的返回（kind/hint 两键）。
 * @param {{ classified?: { kind?: string, hint?: string }|null, fallbackProviderId?: string|null }} [opts]
 */
export function emptyCompletionError({ classified, fallbackProviderId = null } = {}) {
  const kind = classified?.kind || 'empty-completion'
  const hint = classified?.hint || ''
  const tail = fallbackProviderId
    ? `（已配置备用 provider「${fallbackProviderId}」，但内核本回合无法热切换 provider：请在应用内切换该 provider 后重发一轮。）`
    : ''
  /** @type {ApiError} */ const err = new Error(`端点未产出任何正文（${kind}）：${hint}${tail}`)
  err.kind = kind
  err.hint = hint
  if (fallbackProviderId) err.fallbackProviderId = fallbackProviderId
  return err
}

// 单次读操作空闲看门狗（P1-6）：reader.read() 长时间无数据判超时。
// 流式空闲看门狗（300s），防 fetch 永不 settle。
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

// 【2026-09-18 P1-9】请求面剔除本地记账字段 `usage` / `model`。
// 为什么必须剔：
//   ① 它们是**本地记账**字段（token 用量、模型名），对模型没有任何语义，却白付每轮
//      重传的 prefill（长会话里几乎每条 assistant 都带，实测约 150–250B/条）；
//   ② 更关键的是 engine 在**轮末给"已发出过"的 assistant 消息补 usage**
//      （engine.mjs 的 `session.setEntryUsage(lastAssistantEntry, usage)`），使"上一轮请求"
//      与"本轮请求"的公共前缀在**最末一条 assistant** 处断掉；剔除后公共前缀可一直延伸到
//      该条消息本身，命中窗口更宽（前缀缓存逐字节匹配，任何一个字段变化都截断其后全部）。
// 实现约束（**勿**改成在 `deriveMessages()` 里拷贝！）：`context.mjs` 的估算缓存以**消息对象
//   身份**为 WeakMap 键，且 `session.deriveMessages()` 缓存的是 `entry.message` 本身、
//   compact 的 covered→seq 反查也依赖同一 surface 代的对象身份。故此处**只对带这两键的消息**
//   做浅拷贝，其余**原样返回同一引用**——与 streamMessages 里既有的 `filter` 新建数组、保留
//   元素引用是同一身份契约，不会击穿任何缓存。
// 存储侧**照旧保留** `usage` / `model`（`--usage` 只读聚合 `readonly.mjs` 直接自读 transcript
//   文件、`context.predictTurns` 的旧数据回退路径都依赖它们），此处仅控制"不进模型输入"。
export function stripAccountingFields(list) {
  return list.map((m) => {
    if (!m || (m.usage === undefined && m.model === undefined)) return m
    const keep = { ...m }
    delete keep.usage
    delete keep.model
    return keep
  })
}

// 消息流入口：mock / 真实协议分流。tools = 中立 [{name, description, input_schema}]
// 协议分派（2026-09-23，**唯一决策点**）：Anthropic Messages 与 OpenAI Chat Completions 二选一。
// 判定依据与优先级见 kernel/wire/url.mjs#resolveApiFormat（显式字段 → env PONOS_API_FORMAT →
// 基址尾缀 /anthropic → 本地画像 → 兜底 anthropic 不猜）。
// 调用方（engine / compact / lane / workflow / judgeUntil）零改动：它们只认本函数与
// "内部 Anthropic 形状"，线协议差异全部在 kernel/wire/ 内消化。
// auto 模式的生效协议记忆：同一进程内按 baseUrl 去重，避免每次请求都多付一次 404 往返。
// 只在"实测得出"时写入（先 anthropic 成功 或 404/405 回退 openai 成功），**不做任何地址推断**。
const autoFormatCache = new Map()
function rememberAutoFormat(baseUrl, format) {
  if (!baseUrl) return
  if (autoFormatCache.size > 50) autoFormatCache.clear() // 防无界增长（baseUrl 频繁变更的场景）
  autoFormatCache.set(baseUrl, format)
}
/** 测试专用：清空 auto 记忆（避免用例间串味）。生产代码勿调用。 */
export function resetAutoFormatCacheForTest() { autoFormatCache.clear() }

export async function* streamMessages({ model, messages, maxTokens, signal, tools = [], reasoningEffort = null, thinkingMode = null, apiFormat = null }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const rest = stripAccountingFields(messages.filter((m) => m.role !== 'system'))
  if (process.env.PONOS_MOCK_API === '1') {
    yield* mockStream({ messages, signal })
    return
  }
  if (!detectProtocol()) throw new Error('内核：未检测到可用协议（需 PONOS_BASE_URL）')
  const baseUrl = getProvider().baseUrl
  // apiFormat：**本回合内的协议覆盖**（Task 6 空回复降级：换备用协议重发一次）。缺省 null 时
  // 与既有行为逐字相同（resolveApiFormat 收到 'auto' ⇒ 走既有判定链）——调用方零改动。
  const format = resolveApiFormat({ format: apiFormat || 'auto', baseUrl, env: process.env })
  const args = { model, messages: rest, system, tools, maxTokens, signal, reasoningEffort, thinkingMode }
  if (format === 'openai') { yield* openaiStream(args); return }
  if (format === 'anthropic') { yield* anthropicStream(args); return }
  // ── auto：先按既有行为走 anthropic（**零回归**），仅在"未产出任何 chunk + 协议级拒绝
  //    （404/405）"时回退 openai 一次并记忆。produced 守卫保证：只要流已开始吐内容就绝不
  //    重发（避免半截文本重复，与 anthropicStream 断流重连同一取舍纪律）。
  if (autoFormatCache.get(baseUrl) === 'openai') { yield* openaiStream(args); return }
  let produced = false
  try {
    for await (const chunk of anthropicStream(args)) { produced = true; yield chunk }
    rememberAutoFormat(baseUrl, 'anthropic')
    return
  } catch (err) {
    if (produced || !isProtocolRejection(err)) throw err
    rememberAutoFormat(baseUrl, 'openai')
    process.stderr.write(`[api] 协议回退：${baseUrl} 的 /v1/messages 返回 ${err?.status}，改用 OpenAI 协议重发一次\n`)
    yield* openaiStream(args)
  }
}
