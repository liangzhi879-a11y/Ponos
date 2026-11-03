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
  // ★ 2026-10-19 查证更新（用户 provider 正在用 deepseek-flash，实测长会话膨胀）：
  //   依据 = DeepSeek 官方《模型 & 价格》https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
  //     模型 deepseek-flash ｜ 模型版本 DeepSeek-V4.1-Flash-1017 ｜ **上下文长度 1M**
  //     脚注①："模型名请使用 deepseek-flash。旧模型名 deepseek-v4-flash…仍可调用，但对应模型
  //             已下线，请求将由 DeepSeek-V4.1-Flash-1017 模型提供服务。"
  //
  // 为什么必须补 `deepseek-flash` 这一行（不是"顺手加个模型"）：
  //   表没人命中 ⇒ 回落 provider 手配的 PONOS_AUTO_COMPACT_WINDOW。这条回落在**未知模型**上
  //   是合理的（无依据时尊重用户声明），但对**已知模型**它曾造成过事故（下方注释记录的
  //   "v4-flash 手配 1M 虚高"）。反过来同样危险：用户配的若是偏小值，表缺失会让压缩阈值
  //   被压低 → 过度摘要。⇒ 已知模型的窗口必须是**表里的一个事实**，而不是"碰巧配对了"。
  //
  // 为什么 `deepseek-v4-flash` 从 200K 改成 1M（**事实变更，不是放宽判据**）：
  //   原记的 200_000 是"下线前那个 flash"的事实。官方脚注明确说旧名现在指向 V4.1-Flash-1017
  //   ⇒ 同一模型、同一 1M 窗口。留着 200K 会让"旧名"用户的阈值被低估 5 倍。
  'deepseek-flash': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'MiniMax-M3': 262_144,
}

// contextWindow 来源优先级（2026-10-26 按**来源**重新排序，见下方 resolveContextWindowFor）：
//   ① PONOS_PROBED_CONTEXT_WINDOW / provider.contextWindowSource==='probe'（服务端实测）
//   ② 内置模型表（已知模型的事实窗口）
//   ③ provider 手配值（PONOS_AUTO_COMPACT_WINDOW / provider.contextWindow）
//   ④ 画像默认（local → 64K 保守，cloud/未知 → 200K）
//
// ★ 2026-09-11 的事故判据**仍然有效**：表必须压过**手配值**（实测 deepseek provider 手配
//   1M 在 v4-flash（真实 200K）上虚高 → 压缩阈值按 1M 算永不触发 → 大会话每轮全量重发
//   1MB 请求"切 DS 也卡"）。kernel-tests/context-window.test.mjs 把这条双向钉死
//   （含"配小了"也以表为准），**不得反转**。
//
// ★ 但 2026-10-26 发现：原实现把"手配值"与"探测值"塞进**同一个** env 通道
//   （PONOS_AUTO_COMPACT_WINDOW），于是表优先顺带把**服务端自报的事实**也吞掉了
//   （真机：/v1/models 返回 1048576，表值 1_000_000 顶掉它 —— 差 4.6% 偏保守无害，
//   但机制是定时炸弹：表一旦落后于服务端，用户就永远拿不到正确窗口，且无法自愈）。
//   ⇒ 按**来源**分流：探测值另行注入 PONOS_PROBED_CONTEXT_WINDOW，权威性高于表。
//   **这不是放宽 2026-09-11 的判据**：手配值仍然斗不过表，只有"服务端实测"斗得过。
/**
 * @param {{ model?: string, configured?: number, source?: string, env?: any }} [opts]
 * @returns {number} 生效上下文窗口（token）
 */
export function resolveContextWindowFor({ model, configured, source, env = process.env } = {}) {
  // ① 探测值：服务端 /v1/models 自报的事实，权威性最高
  const probedEnv = Number(env.PONOS_PROBED_CONTEXT_WINDOW)
  if (Number.isFinite(probedEnv) && probedEnv > 0) return probedEnv
  const cfg = Number(configured)
  if (source === 'probe' && Number.isFinite(cfg) && cfg > 0) return cfg
  // ② 内置表：已知模型的"事实窗口"，压过手配值（2026-09-11 判据，勿反转）
  const byModel = MODEL_CONTEXT_WINDOWS[String(model || '')]
  if (byModel) return byModel
  // ③ 手配值：未知模型时尊重用户声明
  if (Number.isFinite(cfg) && cfg > 0) return cfg
  const injected = Number(env.PONOS_AUTO_COMPACT_WINDOW)
  if (Number.isFinite(injected) && injected > 0) return injected
  // ④ 画像默认
  return env.PONOS_PROVIDER_PROFILE === 'local' ? LOCAL_DEFAULT_WINDOW : DEFAULT_WINDOW
}

// 兼容入口：签名与语义保持原样（只走 env 通道，等价于 configured 未提供）。
// ★ 启动路径与热切换必须都走这同一套优先级（热切换原先直接读 provider.contextWindow，
//   口径与启动相反 —— 这是本次修的接缝，别再把两者写回各算各的）。
export function contextWindowFor(model, env = process.env) {
  return resolveContextWindowFor({ model, env })
}

// 调用时输出预算钳制（2026-09-10 小窗口本地模型适配）：
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
// 3) **唯一的原地改写是 compact.mjs 的三处 `b.content = …` / `input[f] = …`**
//    （`ageOutToolResults` 的 tool_result 标记、`freeShrink` 的裁剪、`ageOutToolUseInputs`
//    的 Write/Edit 大 payload 标记；全仓 grep 仅此三命中，`Object.assign`/`delete` 无命中）。
//    三处都**紧邻**调用 `bumpContentEpoch()` ⇒ 一次改写即让进程内全部估算记忆失效，可证无遗漏。
//    ★ 2026-10-19 新增第三处时的纪律：**新增任何原地改写都必须同时 bump 并回来更新这段清单**
//      —— 这段注释本身是"可证无遗漏"论证的组成部分，漏写就等于让论证失真。
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

// —— tools schema 计价（2026-10-26：本地小模型「首轮就撑爆」的根因修复）——
// 病灶（真实会话实测）：请求体 = system + **tools[]** + messages，而本文件原实现的
// `estimateRequest` 只算 system + messages ⇒ 110 个 MCP 工具的 schema（实测约 100K token，
// 占 128K 窗口的 79%）**完全不在估算里**。后果不是"估得略低"，是**机制性失明**：
//   · `est` 恒约 20K，永远低于阈值 104,857 ⇒ `maybeCompact` 永不触发（压缩 0 次）；
//   · 溢出兜底压缩只能裁 messages，裁不掉 tools ⇒ 压多少次都装不下；
//   · `clampOutputBudgetForWindow` 的 inputEst 同样漏 tools ⇒ 输出预算不收窄；
//   · engine 的 usage 对账（reported vs est）也因 est 偏小而误判。
// ⇒ tools 必须是**估算的一等公民**，与 system 同源计价（不得另起第二套口径）。
//
// 缓存：以**数组引用**为键。调用方必须"同一轮只求值一次 toolSchemas()、同一数组既发请求
// 又做估算"才命中（每轮 miss 一次 ≈ 一次 JSON.stringify，可接受）；跨轮重建数组即重算。
const TOOLS_CACHE = new WeakMap() // schemas 数组 → { epoch, dk, tokens }
function toolsTokens(tools, density, dk) {
  if (!Array.isArray(tools) || tools.length === 0) return 0
  const hit = TOOLS_CACHE.get(tools)
  if (dk && hit && hit.epoch === _contentEpoch && hit.dk === dk) return hit.tokens
  let s = ''
  try { s = JSON.stringify(tools) } catch { return 0 } // 循环引用等异常：不炸估算
  // 按 code 密度计价（schema 是 JSON，JSON 转义后 `\n` 不是真换行 ⇒ isCodeLike 必然失效，
  // 与 tool_use 块同款显式归类，不依赖内容嗅探）
  const cjk = countCjk(s)
  const tokens = Math.ceil(cjk / density.cjk) + Math.ceil((s.length - cjk) / density.code) + 4
  if (dk) TOOLS_CACHE.set(tools, { epoch: _contentEpoch, dk, tokens })
  return tokens
}

// 四区记账：system（顶层提示）/ task（本轮 user 输入）/ tool_result / history（其余历史）
// 返回 { total, sections }，供 pre-step 测压与 tokenLedger 入账。
// ★ 2026-10-26：`tools` 是**第五个真实分区**（固定前缀的一半），只增字段不改既有四键口径
//   ——`sections` 的既有消费方（health / tokenLedger）读的是已知键，新增键对它们零影响。
function estimateRequestUncached({ system = '', messages = [], tools = null, opts }) {
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
    // 工具面（schema 面）：与 system 并列的固定前缀，**必须计入 total**（见上方长注释）
    tools: toolsTokens(tools, density, dk),
    task,
    tool_result: toolResult,
    history,
  }
  return { total: sections.system + sections.tools + task + toolResult + history, sections }
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

// 前缀缓存观测 · 口径层（2026-09-18 spec：docs/superpowers/specs/2026-09-18-prefix-cache-observability-design.md §3.1）
// ★ 语义修订（2026-09-18，用户裁定"从根修复"）：`supported` 的含义**已变更**——
//   旧定义 `read + create > 0` 是**请求级**证据（"本请求命中过/写过缓存"），与它自己的
//   设计目标（区分「端点真未命中」与「端点根本没有缓存字段」）自相矛盾：一次 read=0 既
//   可能是"端点无缓存能力"，也可能是"端点上缓存可用但这次真未命中"，单靠数值分不出来。
//   新定义 = **端点具备缓存计量**（是否上报缓存字段），信号来自 api.mjs 的
//   `cache_fields_reported`（存在性在 normalizeUsage 里被保留，不再被 `?? 0` 销毁）。
//   —— 这是**语义变更而非新增字段**：下游 `suspicious` 判定因此改为"端点有缓存但未命中"，
//      而不是旧实现的"端点级粘性"绕过（该 hack 已随本修订删除，见 cache-observer.mjs）。
//   兼容规则：`cache_fields_reported` **缺键**时退化为旧启发式 `read + create > 0`——
//   手写 usage 字面量的调用方（mock 夹具、单测、旧 transcript）无该键，退化后行为与旧版
//   完全一致（本地 vLLM 这类缓存字段恒 0 的端点依旧整体静默，spec §5「不假警」约束不破）。
//   `reported` 与 `supported` 恒同值：前者是信号来源的显式出口，后者是既有消费点的契约名。
//   保留两个名字是刻意的（消费方读 `supported`，诊断/断言读 `reported`），**不得只留一个**。
// hitRatio 分母 = input + read（与 stats.mjs:62 既有 cacheRate 同口径，全仓唯一）；
// cache_creation 不计入——写入与读取互斥，混入会让首轮写缓存显示为高命中。
// **口径不得改**：total / hitRatio 两式与本次修订前逐字一致。
export function cacheStats(u = {}) {
  const input = Number(u?.input_tokens) || 0
  const read = Number(u?.cache_read_input_tokens) || 0
  const create = Number(u?.cache_creation_input_tokens) || 0
  // 存在性优先：端点上报过缓存计量字段 ⇒ 具备缓存能力（即使本轮 read/create 都为 0，
  // 那是"未命中"而非"无缓存"）。缺该键时退化为旧启发式，见上方兼容规则。
  const reported = typeof u?.cache_fields_reported === 'boolean'
    ? u.cache_fields_reported
    : read + create > 0
  return {
    input,
    read,
    create,
    total: input + read + create,
    reported,
    supported: reported,
    hitRatio: input + read > 0 ? read / (input + read) : 0,
  }
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
