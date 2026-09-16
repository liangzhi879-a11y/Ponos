// Ponos-turbo 上下文管理（docs/superpowers/specs/2026-08-20-ponos-turbo-inner-core-design.md §5/§6.3）
// ---------------------------------------------------------------------------
// 零依赖纯函数：token 启发式计价（块级密度系数）、模型窗口表、pre-step 压力
// 判定、tokenLedger 四区记账、usage 锚点优化（KV 前缀缓存近似）。全部确定性，
// 无模型调用；engine/compact/health 消费。
import { perfTime } from './perf.mjs'

export const DEFAULT_WINDOW = 200_000

// 本地画像保守默认窗口（2026-09-10 小窗口本地模型适配）：探测/手配/内置表均未命中
// 时使用。偏小不偏大——低估只多压几次（可接受），高估会让 32K 级本地模型反复撞
// 400（云端 400 学习只下调不上调，高估无法自愈）。一手来源 = 探测（vLLM /v1/models
// 的 max_model_len）与 provider.contextWindow；本默认仅兜底两者都不可用场景。
export const LOCAL_DEFAULT_WINDOW = 65_536

// 模型窗口表（可扩展）：deepseek-v4-flash=200K / deepseek-v4-pro=1M / MiniMax-M3=256K
export const MODEL_CONTEXT_WINDOWS = {
  'deepseek-v4-flash': 200_000,
  'deepseek-v4-pro': 1_000_000,
  'MiniMax-M3': 262_144,
}

// contextWindow 来源优先级：内置模型表 → PONOS_AUTO_COMPACT_WINDOW（bridge
// 注入 provider 手配值）→ 画像默认（PONOS_PROVIDER_PROFILE=local → 64K 保守，
// cloud/未知 → 200K）。
// 2026-09-11 表优先于注入：表是模型的"事实窗口"，注入值是 provider 级声明——对
// 已知模型以事实为准（实测 deepseek provider 手配 1M 在 v4-flash（真实 200K）上
// 虚高 → 压缩阈值按 1M 算永不触发 → 大会话每轮全量重发 1MB 请求"切 DS 也卡"）。
// 未知模型仍注入优先（表无依据时尊重用户声明）；带后缀模型（MiniMax-M3[1m]）不
// 命中表条目 → 注入 1M 正常生效。
export function contextWindowFor(model, env = process.env) {
  const byModel = MODEL_CONTEXT_WINDOWS[String(model || '')]
  if (byModel) return byModel
  const injected = Number(env.PONOS_AUTO_COMPACT_WINDOW)
  if (Number.isFinite(injected) && injected > 0) return injected
  return env.PONOS_PROVIDER_PROFILE === 'local' ? LOCAL_DEFAULT_WINDOW : DEFAULT_WINDOW
}

// 调用时输出预算钳制（pi clampMaxTokensToContext 语义；2026-09-10 小窗口本地模型适配）：
// 每次模型调用前按 window − 输入估算 − 余量 收窄 max_tokens，保证 input+max_tokens
// 恒 ≤ 窗口——本地小窗口模型（32K-64K）配大默认预算（64K/16K）不再必然撞 400。
// cap 低于 floor 时返回 floor（宁可小预算尝试，也不放大请求；仍装不下由 400 自愈路径
// 兜底——且 400 能揭示端点真实窗口供采纳学习）。预算/窗口非法返回 null（调用方跳过）。
export function clampOutputBudgetForWindow({ window, inputEst, budget, reserve = 2048, floor = 1024 }) {
  if (!Number.isFinite(window) || window <= 0) return null
  if (!Number.isFinite(budget) || budget <= 0) return null
  const est = Number.isFinite(inputEst) && inputEst > 0 ? inputEst : 0
  const cap = Math.floor(window - est - reserve)
  if (cap < floor) return Math.floor(floor)
  return Math.min(budget, cap)
}

// 密度系数（默认 text=4 / code=3 / cjk=1，可经 env 校准）。CJK（汉字/假名/谚文/
// 全角）按每字约 1 token 计价：中文会话为主的 transcript 若沿用 ASCII /4 密度，
// 整窗估算会低 ~3.7 倍（实测 real/est），pre-step 阈值永远够不着 → 压缩全靠
// 400 溢出兜底，表现为每 1-2 轮被迫压缩一次（见 zz-smoke/diag-context.mjs 复盘）。
function densityOf(env = process.env) {
  const d = { code: 3, text: 4, cjk: 1 }
  const code = Number(env.PONOS_TOKEN_DENSITY_CODE)
  const text = Number(env.PONOS_TOKEN_DENSITY_TEXT)
  const cjk = Number(env.PONOS_TOKEN_DENSITY_CJK)
  if (Number.isFinite(code) && code > 0) d.code = code
  if (Number.isFinite(text) && text > 0) d.text = text
  if (Number.isFinite(cjk) && cjk > 0) d.cjk = cjk
  return d
}

// CJK 字符判定（按 BMP code unit，覆盖常用区段）：CJK 部首/康熙、符号与标点、
// 假名、注音、假名兼容、扩展 A、统一表意、谚文音节、兼容表意、兼容形式、
// 全角/半角形式。非 BMP 扩展 B+（生僻字罕见）不命中 → 按 ASCII 密度兜底，可忽略。
export function isCjkChar(code) {
  return (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
}

export function countCjk(text) {
  const s = String(text ?? '')
  let n = 0
  for (let i = 0; i < s.length; i++) if (isCjkChar(s.charCodeAt(i))) n++
  return n
}

// 代码特征检测：行首缩进 + 关键字（高 token 密度内容）；行首=字符串开头或换行后
export function isCodeLike(text) {
  return /(?:^|\n)[\t ]*(?:const|let|var|function|class|import|export|def|func|echo|SELECT|INSERT|UPDATE|DELETE|require|if\s*\()/i.test(String(text))
}

// 载荷取文（2026-09-12 卡顿事故的根因面）：取块内**所有会进请求体**的文本/结构化载荷。
// 旧实现按字段名猜 `text ?? thinking ?? content`——tool_use 的载荷在 `input`，三个字段
// 全无 → raw='' → 每个 tool_use 块恒计 4 token（"每块 +4"里的 +4）。实测某 11.5h 会话：
// 1523 条消息 / 1.0MB 请求体，772 个 tool_use 携带 0.55MB（Write 180KB / Agent 143KB /
// Bash 141KB / Edit 84KB）只被计成 3,088 token（真实约 14.4 万，少算 14.1 万）→ pre-step
// est 75K < 阈值 132K → maybeCompact 永远 below-threshold → **压缩 0 次**，而模型每轮实收
// 1.0MB，表现为每轮 3s（缓存命中）到 65s（未命中）的"思考卡顿"且随会话单调恶化。
// 故改为三段式：①登记字段逐一取文 ②未登记的**自有属性通用兜底** ③数组内容递归——
// 新增块类型/新增载荷字段不可能再静默变 4 token（这正是旧实现被绕过的方式）。
const PAYLOAD_KEYS = ['text', 'thinking', 'content', 'input', 'output', 'data']
// 结构/控制字段：随请求体传输但不承载"内容量"，不计文本（image 的 source 走当量分支）。
// 刻意排除 id/tool_use_id（每块 40 字符 UUID，772 块 ≈ 2 万 token 纯噪声——估算器判的是
// "该不该压缩"，1-2% 的偏保守优于被 id 长度扰动）；name 是语义载荷故不排除。
const META_KEYS = new Set([
  'type', 'id', 'tool_use_id', 'cache_control', 'index', 'role', 'is_error',
  'source', 'usage', 'stop_reason', 'stop_sequence', 'model',
])

function payloadText(block) {
  const parts = []
  const push = (v) => {
    if (typeof v === 'string') { if (v) parts.push(v); return }
    if (v == null) return
    if (typeof v === 'object') { try { parts.push(JSON.stringify(v)) } catch { /* 循环引用/含 BigInt：跳过不炸 */ } }
  }
  for (const k of PAYLOAD_KEYS) push(block[k])
  for (const [k, v] of Object.entries(block)) {
    if (META_KEYS.has(k) || PAYLOAD_KEYS.includes(k)) continue
    push(v)
  }
  return parts.join('\n')
}

// —— K1.1 估算记忆化（2026-09-13「任务运行慢」系统性优化，最大头）———————
// 实测（2.5MB / 1482 条历史）：`estimateRequest` **88.5ms/次 × 3–6 次/步 = 260–530ms/步**，
// 是每步固定开销的头号来源。热点**不是遍历次数**，而是每个块都重做
// `JSON.stringify(入参)` + 逐字符 `countCjk` + 正则 `isCodeLike`——同一份历史一步内被
// 扫了 3–6 遍，且逐步骤重复（历史只增不改）。
//
// 三条「可证不陈旧」依据（设计真源 §4.1）：
// 1) **块/消息对象身份稳定**：`session.deriveMessages()` 缓存的是 `entry.message` 本身
//    （`session.mjs:303` 直接 push 引用，重建缓存也复用同一批对象）；`deriveHistory()`
//    只换数组不换元素；`patchOrphanToolUses` 无孤儿时原样推原对象。故 WeakMap 键有效。
// 2) **摘要落地是换对象而非改内容**（`appendCompactionSummary` → nodes.splice + invalidate）：
//    旧对象不再可达 → WeakMap 条目随 GC 回收，读取方**结构性不可能**读到摘要前的历史。
// 3) **唯一的原地改写是 compact.mjs 的两处 `b.content = …`**（`ageOutToolResults:59` /
//    `freeShrink:199`；全仓 grep 仅此两命中，`Object.assign`/`delete` 无命中）。两处都
//    **紧邻**调用 `bumpContentEpoch()` ⇒ 一次改写即让进程内全部估算记忆失效，可证无遗漏。
// 另：密度系数（PONOS_TOKEN_DENSITY_*）进键——env 变化必须重算。
//
// 容量：WeakMap 键是「活着的历史对象」，条目数被历史体量天然限制且随对象回收，
// 故不需要 LRU 上限（参考实现里涨到 300MB 的是**字符串键的会话级 Map**，形状不同）。
let _contentEpoch = 0
/** 内容纪元：任何**原地改写**历史内容后必须 +1（估算记忆的唯一失效源） */
export const contentEpoch = () => _contentEpoch
export function bumpContentEpoch() { _contentEpoch++ }

const NO_CACHE = '' // 关缓存时的哨兵（densityKey 永远非空）
const cacheOn = () => process.env.PONOS_ESTIMATE_CACHE !== '0' // 默认 on，可单独关
const densityKey = (d) => d.text + '/' + d.code + '/' + d.cjk
const BLK_CACHE = new WeakMap() // 块对象 → { epoch, dk, tokens }
const MSG_CACHE = new WeakMap() // 消息对象 → { epoch, dk, tokens }

// 块级计价（纯计算，不查/不写缓存）：text/thinking 按 text 密度，代码特征 / tool_result /
// tool_use 按 code 密度（tool_use 载荷是 JSON，且 JSON 转义后 `\n` 不是真换行——isCodeLike
// 的行首匹配必然失效，故按类型显式归类，不依赖内容嗅探）；中文字段先按 cjk 密度（每字
// ~1 token）单独计价、ASCII 余量按原密度，防 CJK 主体内容少计 ~4 倍；image/二进制/base64
// 附件固定 4800 当量；每块 +4。纯 ASCII 的 text/tool_result 估值与旧实现一致（零回归）。
function estimateTokensUncached(block, density, dk) {
  // 数组内容（tool_result/document 均可为块数组）：逐块递归——否则其中的
  // image 块会被 JSON.stringify 成 base64 当文本计价（1MB 图 ≈ 33 万 token vs 实际 ~4800）
  if (Array.isArray(block.content)) {
    return 4 + block.content.reduce((s, b) => s + tokensFor(b, density, dk), 0)
  }
  if (block.type === 'image' || block.type === 'binary') return 4800 + 4
  // base64 附件当量（非 image 类型但带二进制 source 的块，如 document）
  const src = block.source
  if (src && typeof src === 'object' && src.type !== 'text' && typeof src.data === 'string' && src.data) return 4800 + 4
  const raw = payloadText(block)
  const per = block.type === 'tool_result' || block.type === 'tool_use' || isCodeLike(raw) ? density.code : density.text
  const cjk = countCjk(raw)
  const ascii = raw.length - cjk
  return Math.ceil(cjk / density.cjk) + Math.ceil(ascii / per) + 4
}

/** 块级：命中需同时满足「对象身份 + 纪元 + 密度指纹」 */
function tokensFor(block, density, dk) {
  if (block == null || typeof block !== 'object') return 4
  if (!dk) return estimateTokensUncached(block, density, dk)
  const hit = BLK_CACHE.get(block)
  if (hit && hit.epoch === _contentEpoch && hit.dk === dk) return hit.tokens
  const tokens = estimateTokensUncached(block, density, dk)
  BLK_CACHE.set(block, { epoch: _contentEpoch, dk, tokens })
  return tokens
}

export function estimateTokens(block = {}, opts = {}) {
  // 防御：数组内容里的裸字符串（旧格式/外部 transcript）不按对象遍历（会把每个字符
  // 当成一个自有属性，'abc' → 'a\nb\nc' 长度翻倍）
  if (typeof block === 'string') block = { type: 'text', text: block }
  if (block == null || typeof block !== 'object') return 4
  const density = densityOf(opts?.env || process.env)
  return tokensFor(block, density, cacheOn() ? densityKey(density) : NO_CACHE)
}

// 消息级：role +4 + 各块合计（string content 视为单 text 块）。
// 消息级缓存是必需的、不是锦上添花：string 分支与 system 项每次都新建字面量对象
// （摘要条目 content 就是字符串），只做块级缓存会**恒 miss**。
function estimateMessageUncached(m, density, dk) {
  const content = m?.content
  if (typeof content === 'string') {
    // 新字面量不可能命中块级缓存 → 直接走纯计算（避免往 WeakMap 塞一次性垃圾）
    return 4 + estimateTokensUncached({ type: 'text', text: content }, density, dk)
  }
  if (Array.isArray(content)) return 4 + content.reduce((s, b) => s + tokensFor(b, density, dk), 0)
  return 4
}

function tokensForMessage(m, density, dk) {
  // m?. 防御：旧格式恢复的派生历史可能含 undefined/null 条目（默认参只兜 undefined）
  if (m == null || typeof m !== 'object') return 4
  if (!dk) return estimateMessageUncached(m, density, dk)
  const hit = MSG_CACHE.get(m)
  if (hit && hit.epoch === _contentEpoch && hit.dk === dk) return hit.tokens
  const tokens = estimateMessageUncached(m, density, dk)
  MSG_CACHE.set(m, { epoch: _contentEpoch, dk, tokens })
  return tokens
}

export function estimateMessage(m = {}, opts = {}) {
  const density = densityOf(opts?.env || process.env)
  return tokensForMessage(m, density, cacheOn() ? densityKey(density) : NO_CACHE)
}

// 全量启发式（密度/纪元在入口算一次，逐条走消息级缓存）
export function estimateHistory(msgs = [], opts = {}) {
  const density = densityOf(opts?.env || process.env)
  const dk = cacheOn() ? densityKey(density) : NO_CACHE
  let sum = 0
  for (let i = 0; i < msgs.length; i++) sum += tokensForMessage(msgs[i], density, dk)
  return sum
}

// 四区记账：system（顶层提示）/ task（本轮 user 输入）/ tool_result / history（其余历史）
// 返回 { total, sections }，供 pre-step 测压与 tokenLedger 入账。
function estimateRequestUncached({ system = '', messages = [], opts }) {
  const density = densityOf(opts?.env || process.env)
  const dk = cacheOn() ? densityKey(density) : NO_CACHE
  let task = 0
  let toolResult = 0
  let history = 0
  const arr = Array.isArray(messages) ? messages : []
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i]
    // 防御：外部传入的 messages 可能含 undefined 条目（旧格式 transcript 恢复等），
    // 直接访问 m.role/m.content 会抛 "reading 'content'"（2026-08-22 G.content 根因）
    if (i === arr.length - 1 && m?.role === 'user') {
      task += tokensForMessage(m, density, dk)
      continue
    }
    if (Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_result')) {
      toolResult += tokensForMessage(m, density, dk)
      continue
    }
    history += tokensForMessage(m, density, dk)
  }
  const sections = {
    // system 前缀同样走 CJK 感知计价（中文系统提示按字计，与块级口径一致）
    system: estimateTokensUncached({ type: 'text', text: String(system) }, density, dk),
    task,
    tool_result: toolResult,
    history,
  }
  return { total: sections.system + task + toolResult + history, sections }
}

// K0 观测（2026-09-13）：只统计**入口**耗时与调用次数。内部的 estimateMessage →
// estimateTokens 是同步嵌套，perf.mjs 的**按 key** 重入保护保证一次调用不会被记多遍。
// 关闭开关时 perfTime 直接 `return fn()`，零 performance.now() 调用。
export function estimateRequest(input) {
  return perfTime('est', () => estimateRequestUncached(input))
}

// tokenLedger：四区累计 + tool_result 占比（喂给 health 分区失衡因子）
export function createTokenLedger() {
  const sections = { system: 0, task: 0, tool_result: 0, history: 0 }
  return {
    record(section, tokens) {
      if (Object.prototype.hasOwnProperty.call(sections, section)) sections[section] += tokens
    },
    get(section) { return sections[section] ?? 0 },
    total() { return sections.system + sections.task + sections.tool_result + sections.history },
    toolResultShare() {
      const t = this.total()
      return t === 0 ? 0 : sections.tool_result / t
    },
    sections,
  }
}

// usage 锚点：最近一次成功调用且请求头（system+工具+模型指纹）相同 → 基线 + 尾部增量
export function makeUsageAnchor() {
  let lastHeadKey = null
  let lastInputTokens = 0
  return {
    estimate({ headKey, history }) {
      if (headKey && headKey === lastHeadKey) {
        const tail = Array.isArray(history) ? history.slice(-1) : []
        return { input: lastInputTokens + estimateHistory(tail), anchored: true }
      }
      return { input: estimateHistory(history), anchored: false }
    },
    record({ headKey, inputTokens }) {
      lastHeadKey = headKey ?? null
      lastInputTokens = inputTokens
    },
  }
}

// 完整请求面 token 数 = input + 缓存读 + 缓存写。KV 前缀缓存端点（Anthropic/
// DeepSeek 等）input_tokens 只计本轮新增，cache_read 才是上下文主体——单看
// input 会把水位低估一个量级；非缓存端点（vLLM 等本地）缓存字段为 0，等价 input_tokens。
export function requestTokens(u = {}) {
  return (Number(u?.input_tokens) || 0) + (Number(u?.cache_read_input_tokens) || 0) + (Number(u?.cache_creation_input_tokens) || 0)
}

// —— L4-1 上下文预测：token 增长速率 → 预测到达阈值轮数 ——
// recent 形状与 health 一致：[{ lastUsage?, usage }]。每轮水位取"最近一次单请求"
// 完整规模（lastUsage = 该轮最后一次 API 调用的 usage；旧 turnStats 无此字段时回退
// 轮级合计 usage——合计偏大，仅兼容旧数据/测试）。k = 参与均值计算的最近轮数。
export function predictTurns({ recent = [], window = 200_000, thresholdRatio = 0.8, k = 5 } = {}) {
  const sizes = (Array.isArray(recent) ? recent : []).map((t) => requestTokens(t?.lastUsage ?? t?.usage))
  const lastInput = sizes.length ? sizes[sizes.length - 1] : 0
  const threshold = Math.floor(window * thresholdRatio)
  const deltas = []
  for (let i = sizes.length - 1; i > 0 && deltas.length < k; i--) deltas.push(sizes[i] - sizes[i - 1])
  // 增长下限按窗口相对化（旧 Math.max(1, ·)：上下文持平时 delta≈0，growth 被钳到
  // 1 token/轮 → predictedTurns = (阈值−水位)/1 爆出"剩余 15811 轮"类荒谬值）。
  // 0.05% 窗口/轮（200K 窗 ≈ 100 token/轮）为保守下限；负增长（压缩后回落）取下限。
  const floor = Math.max(1, Math.floor(window * 0.0005))
  const growthPerTurn = deltas.length ? Math.max(floor, Math.round(deltas.reduce((s, d) => s + d, 0) / deltas.length)) : 1000
  // 封顶 999：更远不需要精度（评分只区分 <5/<10 两档，展示取可读近似）。
  const predictedTurns = Math.min(999, Math.max(0, Math.floor((threshold - lastInput) / growthPerTurn)))
  return { growthPerTurn, predictedTurns, threshold, lastInput }
}
