// Ponos-turbo Agent 循环（docs/bridge-contract.md §9 替换面）
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
import { streamMessages, classifyApiError, deadStreamError } from './api.mjs'
import { abortError } from './protocol.mjs'
import { countCjk } from './context.mjs'
import { decideToolPermission } from './permissions.mjs'
import { createToolRegistry, killActiveChildren } from './tools.mjs'
import { createSessionStore, newSessionId, sanitizeSegment } from './session.mjs'
import { resolveAgent, resolveAgents } from './agents.mjs'
import { getProvider } from './provider.mjs'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

// —— agent loop 兜底（本地模型死循环防护）——
// 参考 claude-code/pi/dsh：三者主循环均默认无全局硬上限（靠 Esc 中断/可选 maxTurns/上下文
// 自愈）；dsh 独有 repeat-tool-reminder（连续同工具调用达阈值注入提醒）。本地模型（vLLM
// Qwen 等）死循环两大形态：① 工具调用不断但无进展（反复同工具/全失败重试/无限续轮）；
// ② 生成环节打转（thinking/文本重复打转、流式无数据挂起、单轮拖超时）。本引擎按本地
// 模型场景默认开启以下守卫，全部可用 PONOS_* 环境变量调（0 = 关），PONOS_LOOP_GUARD=0
// 一键全关（对齐参考实现"无硬上限"语义）。到限一律优雅收尾：附说明文本 + result 闭轮，
// 会话上下文保留，用户可发「继续」让模型接续，不烧死 token 也不丢任务。
function envNonNeg(name, def) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : def
}
const LOOP_GUARD_OFF = process.env.PONOS_LOOP_GUARD === '0'
// 单轮工具迭代上限：默认不限（0）——应用需要长任务能力，单轮几十次工具调用是正常
// 路径（调查/重构/批量编辑）。本地模型死循环经调试验证不在工具调用链：根因是上下文
// 400 溢出吞错、生成重复打转、文件工具边界全拒等，各自有对应专项守卫（溢出按进展自
// 愈 / 生成重复 / 空闲看门狗 / 失败熔断）。迭代数硬上限只会误杀长任务轮（用户侧表现：
// 任务"自己停下来"、需反复发「继续」），故默认取消。需要保险时可显式设
// PONOS_LOOP_MAX_ITERATIONS（>0），旧变量 PONOS_MAX_TOOL_ITERATIONS（>0）优先。
const LEGACY_MAX_TOOL_ITER = Number(process.env.PONOS_MAX_TOOL_ITERATIONS)
const MAX_TOOL_ITERATIONS = LOOP_GUARD_OFF ? 0
  : (Number.isFinite(LEGACY_MAX_TOOL_ITER) && LEGACY_MAX_TOOL_ITER > 0)
    ? Math.floor(LEGACY_MAX_TOOL_ITER)
    : envNonNeg('PONOS_LOOP_MAX_ITERATIONS', 0)
// 轮次墙钟（主 loop 每轮 + 子 lane）：边界检查（工具批执行后有 300s deadline 粒度）
const TURN_TIMEOUT_MS = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_TURN_TIMEOUT_MS', 1_800_000)  // 30min
// 流式生成空闲看门狗：单次模型流内间隔超时判挂起（防 fetch 永不回块）
const STREAM_IDLE_MS = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_STREAM_IDLE_MS', 120_000)      // 2min
// 连续工具失败熔断：一轮内连续全部失败的迭代达上限即收尾（成功一次即复位）
const MAX_ERROR_ITERATIONS = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_LOOP_MAX_ERROR_ITERATIONS', 6)
// 同工具重复提醒注入阈值（dsh repeat-tool-reminder 语义；仅提醒不 veto，硬性由
// 迭代上限兜底）。PONOS_LOOP_REPEAT_REMIND 逗号分隔，如 "3,5"；空串/0 → 关闭。
function envRemindList(name) {
  const raw = process.env[name]
  if (raw === undefined) return [3, 5]
  const vals = String(raw).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
  return [...new Set(vals)]
}
const REPEAT_REMIND_AT = LOOP_GUARD_OFF ? [] : envRemindList('PONOS_LOOP_REPEAT_REMIND')
// 句级近重复检测（守卫③b）：本地模型"编织变体"死循环——措辞微变反复重述同一批内容
// （"Let me run it." / "Let me run it now."…），逐字符精确周期（守卫③）抓不到。逐新句
// 与先前句池做 bigram Jaccard，最近 recent 句的平均高相似近邻数 ≥ avg 即判退化。默认值
// 经真实 35KB 死循环样本回放 + 长文/代码对照标定（样本 ~10.6k 归一化字符止损；对照零误伤）。
// RECENT=0 / PONOS_LOOP_GUARD=0 关闭；SIM/RECENT/AVG/BACK 可经 env 调。
function envFloat(name, def) {
  const v = Number(process.env[name])
  return Number.isFinite(v) ? v : def
}
const NEAR_REPEAT_RECENT = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_NEAR_REPEAT_RECENT', 10)
const NEAR_REPEAT_AVG = LOOP_GUARD_OFF ? 0 : envFloat('PONOS_NEAR_REPEAT_AVG', 1.2)
const NEAR_REPEAT_SIM = LOOP_GUARD_OFF ? 0 : envFloat('PONOS_NEAR_REPEAT_SIM', 0.6)
const NEAR_REPEAT_BACK = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_NEAR_REPEAT_BACK', 48)
// 近重复守卫代码单元豁免（系统性修复：用户实证"代码内容容易被误判为重复"）：结构高度
// 相似的多行实现代码（对多个字段/入口做同类改造、批量绑定监听等）经 nrNorm 归一化后
// 彼此 Jaccard 高（实测 14 行同类改造 avgNeighbor=2 ≥ 1.2 误触发收尾）。代码行不进
// 句池/直方：正常代码流不再参与"近似重复"累计。PONOS_NEAR_REPEAT_CODE=0 关闭豁免。
const NEAR_REPEAT_CODE_SKIP = LOOP_GUARD_OFF ? false : process.env.PONOS_NEAR_REPEAT_CODE !== '0'
// 生成重复守卫内部自愈上限（P1）：③/③b 命中先"注入推进指令续跑"而不是直接收尾把报错
// 说明喂给用户（本地模型一次性打转 / 探测器误判时一轮注入即恢复，用户无感）。真死循环
// 模型会持续复现 → 耗尽上限才落回收尾说明（仍保证不死循环烧 token）。=0 关闭自愈
// （回到旧行为：命中即收尾 + 可见说明）。
const REPEAT_HEAL_MAX = LOOP_GUARD_OFF ? 0 : envNonNeg('PONOS_REPEAT_HEAL_MAX', 2)

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
// 上层各有处理）。mock 模式默认不重试（测试确定性），可经 PONOS_MOCK_API_RETRIES 覆盖。
async function* retryStream({ model, messages, maxTokens, signal, tools, reasoningEffort = null }) {
  const isMock = process.env.PONOS_MOCK_API === '1'
  const configured = process.env.PONOS_MOCK_API_RETRIES
  const maxRetries = configured !== undefined
    ? Number(configured)
    : (isMock ? 0 : Number(process.env.CLAUDE_CODE_API_RETRIES || 5))
  let attempt = 0
  let zeroStreak = 0 // P1-11 连续"0 事件"失败计数（含 transient 形态：连接被对端销毁等）
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
      // P1-11 空流升级：连续 ≥2 次全程 0 事件（含 transient "fetch failed/连接销毁"）→
      // 判上游空流（vLLM 引擎加载中/崩溃的典型形态），升级为 DeadStream 让 engine 快速
      // 落"检查 provider"提示。单次 0 事件（网络偶发抖动）仍保留 1 次重试自动恢复。
      if (err?.zeroEvents) {
        zeroStreak++
        if (zeroStreak >= 2) throw deadStreamError(err)
      } else {
        zeroStreak = 0
      }
      // 空流（dead-stream）只给 1 次快速重试兜瞬态断连（本地 vLLM 引擎加载中/崩溃会
      // 持续空流——1 次即止，engine 快速落"检查 provider"提示，不反复烧时间）；
      // rate-limit/transient 维持既有 maxRetries 语义。
      const deadCap = 1
      const allowed = ['rate-limit', 'transient'].includes(cls.kind) ||
        (cls.kind === 'dead-stream' && attempt < deadCap)
      if (!allowed || attempt >= maxRetries) throw err
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

// 取真实 AbortSignal：engine 的轮次级 signal 是自定义包装对象（rawSignal getter
// 暴露真 AbortSignal，见 runTurn）；undici fetch 与 AbortSignal.any 都要求真实例。
// 非 AbortSignal → null（调用方自行降级为不合并）。
function rawAbortSignal(s) {
  if (!s || typeof s !== 'object') return null
  if (s.rawSignal instanceof AbortSignal) return s.rawSignal
  return s instanceof AbortSignal ? s : null
}

// 流式空闲看门狗工厂：ms>0 时开启，流内块间隔超 ms → tripped=true 并 abort
// controller（下层 fetch 随即拒绝 → 调用方按"内部挂起"收尾）；ms<=0（守卫关闭）
// 时全 no-op。调用方须在流结束后 stop()（防 timer 泄漏）。
function makeIdleWatchdog(ms) {
  if (!ms || ms <= 0) return { controller: null, tripped: false, tick() {}, stop() {} }
  const controller = new AbortController()
  const state = { tripped: false, last: Date.now() }
  const timer = setInterval(() => {
    if (!state.tripped && Date.now() - state.last >= ms) { state.tripped = true; controller.abort() }
  }, Math.min(ms, 5000))
  if (timer.unref) timer.unref()
  return {
    controller,
    get tripped() { return state.tripped },
    tick() { state.last = Date.now() },
    stop() { clearInterval(timer) },
  }
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

// R3-2 计划尾检测：模型以"计划/承诺"措辞收尾但未执行工具调用（计划尾巴）。
// 匹配文本尾部 120 字符内的计划词；完成语（完成/结束/以上就是/无需…）优先否决，
// 避免误伤正常收尾。中英双语覆盖。
const PLAN_TAIL_RE = /(先(读|看|查|确认|检查|验证|尝试|搜索|获取|执行|开始)|(接下来|然后|接着|下一步)(读|看|查|检查|验证|处理|执行|写|改|搜索|获取|开始|做|需要|要)|开始(实施|执行|动手|做|写|改|处理)|准备(好|一下)?|需要先|我先|让我(先|开始|试)|稍等|待会|再(继续|检查|验证|读|看)|立即(开始|动手|执行)|稍后|计划|first,?\s+let|next,?\s+(i|let|we)|let me (start|begin|first)|i will (first|start|begin|now)|i'?m going to (first|start|begin|now)|to do this,?\s+(i|we)|i need to (first|start|begin))/i
const PLAN_TAIL_DONE_RE = /(已完成|完成|搞定|结束|成功|以上就是|以上就是全部|已处理|没有更多|无需|不需要|不需要了|bye|done|complete|finished|that'?s all|no more)/i
export function isPlanTail(text) {
  const tail = String(text ?? '').slice(-120)
  if (PLAN_TAIL_DONE_RE.test(tail)) return false
  return PLAN_TAIL_RE.test(tail)
}

// —— 生成死循环检测（思考/文本重复打转）——
// 单次模型流内滚动检测"周期重复"：窗口尾部出现同一长度 p 的内容段连续重复 ≥minRepeats 次
// 即判定退化循环（本地模型 CoT/文本打转的典型形态：同一段话不断自我复制）。作用面 = 一次
// API 调用的流式文本（thinking 与 text 同窗口合并）。只扫尾部窗口避免长正常输出误判，
// 最小周期/次数保守取值压低误伤（自然重复短分隔线、代码里偶发重复行不触发）。
export function detectGenerationRepeat(windowText, { minPeriod = 20, minRepeats = 3, maxPeriod = 100 } = {}) {
  const s = String(windowText || '')
  if (s.length < minPeriod * minRepeats) return null
  const upper = Math.min(maxPeriod, Math.floor(s.length / minRepeats))
  for (let p = minPeriod; p <= upper; p++) {
    const unit = s.slice(-p)
    let repeats = 1
    for (let i = s.length - 2 * p; i >= 0 && s.slice(i, i + p) === unit; i -= p) repeats++
    if (repeats >= minRepeats) return { p, repeats }
  }
  return null
}

// —— 生成"近似重复"检测（编织变体死循环；守卫③b 配套）——
// 与 detectGenerationRepeat（逐字符精确周期）互补：后者只抓"同一整段原样复制 ≥3 次"，
// 抓不到措辞微变的变体重述循环（"Let me run it." / "Let me run it now." 交织）。本检测
// 逐句做归一化 + 字符 bigram 指纹，每个新完成句与先前句池（back 上限）比较 Jaccard ≥ sim
// 记 1 个"近邻"；最近 recent 个新句的平均近邻数 ≥ avg 即判退化循环。设计取舍：
//   · 不依赖周期/固定句式对齐（编织循环序列位置漂移，句对齐会错位）——只统计"新句是旧句
//     变体的密度"，序列漂移免疫；
//   · 用完整句 + 较长指纹门槛压低误伤——正常长文/代码的新句几乎不与旧句高相似（平均近邻
//     ≈0），死循环反复重述旧内容（平均近邻 ≥1.2，标定见守卫常量注释）；
//   · 返回"最近一次触发"结构（调用方命中即收尾中断，无需闩）。
// 有状态工厂：流式 chunk 逐块喂入（内部保留未闭合尾句 pending），thinking/text 同窗累计
// （与 genWindow 语义一致）。每个 for-await 流（每次 API 调用）应新建实例。
const NR_SENT_SPLIT_RE = /[。！？!?…\n\r]+/u
const nrNorm = (raw) => String(raw ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
const nrGrams = (s) => {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}
function nrJaccard(g1, g2) {
  if (!g1.size || !g2.size) return 0
  let inter = 0
  for (const g of g1) if (g2.has(g)) inter++
  return inter / (g1.size + g2.size - inter)
}
// 代码单元识别（近重复守卫代码误伤系统性修复，见 NEAR_REPEAT_CODE_SKIP 注释）：
// 单元级特征——CJK 占比低（中文散文整体豁免）+ 结构性代码信号（强符号 / 函数调用 /
// 代码关键字）达到阈值即判"代码行"。纯符号行（{} 缩进等）归一化后 < minChars，本就
// 被长度门槛排除，无需在此处理。
// 设计权衡：宁可多豁免（代码误判收尾比漏检代价高——真死循环仍有守卫③精确重复、工具
// 重复提醒 ⑤ 与迭代/时长上限兜底），故对英文散文混代码引用句从宽。
const NR_CODE_STRONG_RE = /[{}[\]\\;=<>`:@]/g   // 结构强符号（()、"、. 属散文常见，不计）
const NR_CODE_CALL_RE = /[A-Za-z_$][\w$]*\s*\(/g  // 函数/方法调用形态 identifier(
const NR_CODE_KEYWORD_RE = /(const|let|var|function|return|import|export|require|class|extends|new|await|async|throw|=>)\b/i
export function isCodeLikeUnit(raw, { cjkRatioMax = 0.5, minStrong = 2 } = {}) {
  const s = String(raw ?? '').trim()
  if (!s) return false
  if (countCjk(s) / s.length > cjkRatioMax) return false // CJK 主导（中/日/韩散文）不判代码
  const strong = (s.match(NR_CODE_STRONG_RE) || []).length
  if (strong >= minStrong) return true
  if (strong === 0) return false // 无强符号：调用/关键字在散文中常见（"see foo() in docs"），不据此判代码
  const calls = (s.match(NR_CODE_CALL_RE) || []).length
  return calls > 0 || NR_CODE_KEYWORD_RE.test(s)
}
export function createNearRepeatDetector({ minChars = 6, maxChars = 800, pendingCap = 4096, back = 48, sim = 0.6, recent = 10, avg = 1.2, codeSkip = true } = {}) {
  if (!(recent > 0) || !(avg > 0) || !(sim > 0)) return { push: () => null } // 关闭态 no-op
  let pending = ''
  const pool = []   // { u, g }：最近 back 个完整句（u 归一化原文，g bigram 集——避免重复计算）
  const hist = []   // 每个已处理新句的近邻数（最近 recent 个参与均值判定）
  const push = (text) => {
    pending += String(text ?? '')
    // pending 上限：极端"无句界长流"（base64/长代码/纯散文不停顿）会让 pending 无限增长
    // 且每 chunk 重算整段（O(n²)）。只留尾部（丢句边界可接受——那部分无法切句本就不参与检测）。
    if (pending.length > pendingCap) pending = pending.slice(-pendingCap)
    if (pending.length <= minChars) return null
    const parts = pending.split(NR_SENT_SPLIT_RE)
    pending = parts.pop() ?? '' // 尾部未闭合，留待下一块补齐（流式切句）
    let hit = null
    for (const part of parts) {
      if (codeSkip && isCodeLikeUnit(part)) continue // 代码行不进句池/直方（系统性防误判）
      const u = nrNorm(part)
      if (u.length < minChars || u.length > maxChars) continue // 过长单元无判别力且污染指纹池
      const g = nrGrams(u)
      let m = 0
      for (const old of pool) if (nrJaccard(g, old.g) >= sim) m++
      pool.push({ u, g })
      if (pool.length > back) pool.shift()
      hist.push(m)
      if (hist.length > recent) hist.shift()
      if (hist.length === recent && hist.reduce((a, b) => a + b, 0) / recent >= avg) {
        hit = { avgNeighbor: +((hist.reduce((a, b) => a + b, 0)) / recent).toFixed(2), window: recent }
        break // 一次触发即报，调用方收尾中断，不再推进句池
      }
    }
    return hit
  }
  return { push }
}

// 工具调用规范键（重复检测用）：name + 参数深排序后 JSON——同工具同参数（忽略键序）判同一次。
// 超大参数截前 4K 参与比较（仅用于等值判定；同前缀极长参数误判风险可忽略）。
export function canonicalToolCallKey(toolUse) {
  if (!toolUse) return ''
  const name = String(toolUse.name || '')
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
    return v
  }
  let input = toolUse.input
  try { input = JSON.stringify(sort(input ?? {})) } catch { input = JSON.stringify(input ?? {}) }
  if (input.length > 4096) input = input.slice(0, 4096)
  return `${name}\u0000${input}`
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
  // P0-3 大结果落盘目录并入文件边界：persistToolResult 把 >20K 工具结果存到
  // <会话目录>/tool-results/ 并只回模型 stub（提示"可用 Read 读取"）。但会话目录
  // = configDir/projects/<cwd>，位于 GUI 挂载的 --add-dir（项目目录）之外——若不入
  // 边界，模型按 stub 指引补读会被 Read 拒绝，读大文件只见 stub 空转。仅并入本会话
  // 的 tool-results/ 子目录（内容 = 本会话落盘的临时产物），不放宽整棵 projects 树。
  const toolResultsDir = session?.file
    ? join(dirname(session.file), 'tool-results')
    : (opts.configDir && opts.addDirs?.[0])
      ? join(opts.configDir, 'projects', sanitizeSegment(opts.addDirs[0]), 'tool-results')
      : null
  const tools = createToolRegistry({ cwd: opts.addDirs?.[0], addDirs: toolResultsDir ? [...(opts.addDirs || []), toolResultsDir] : opts.addDirs, skillsDirs: opts.skillsDirs, skipPermissions: opts.skipPermissions, allowOutsideDirs: opts.allowOutsideDirs, disallowedTools: opts.disallowedTools, workflow: opts.workflow })
  // 审批门注入工作流引擎：wfEngine 内嵌 tool/document/agent 节点的工具调用须经
  // 与主 agent 会话同等的权限决策（gateToolUse 含 ask 审批挂起 / hook 否决），
  // 杜绝模型经 Workflow 工具旁路高危命令审批。cli 后续 setDeps（registry/事件）
  // 是合并语义，不影响本门。engine 直连测试无 opts.workflow 时跳过。
  if (opts.workflow && typeof opts.workflow.setDeps === 'function') {
    try { opts.workflow.setDeps({ permissionGate: gateToolUse }) } catch { /* 注入失败不阻断主 loop */ }
  }
  // agent 表（内置 ∪ 用户级 $PONOS_HOME/agents/*.md）：Agent 工具路由依据
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
  // lineage, laneOptions, summary, outputFile, usage, stop }。S2 续跑复用
  // laneStore/sysPrompt（laneOptions 保白名单沿用）；S1 级联取消查
  // lineage.parentTaskId；进程退出即失（非持久化，spec 边界）
  const pendingSubAgents = new Map()
  // turnStats 记录器（内存 append-only）：health / result / stats 三个消费者共用
  const turnStats = []

  // 历史优先走 session.deriveMessages()；无 session 时退化为内存数组（测试直连场景）
  const memoryHistory = []
  // systemPrompt 默认可变：cli 在 createEngine 后经 setSystemPrompt 注入三层组装
  // 提示词（基础行为规范 + AGENTS.md + append），直连测试可经 opts.systemPrompt 预置
  let systemPrompt = opts.systemPrompt || ''
  // 思考深度档位：null = auto（不注入，模型原生自适应）；off/low/high/max = 显式。
  // 初始来源：CLAUDE_CODE_EFFORT_LEVEL（Claude Code 命名，DeepSeek 官方推荐）> PONOS_REASONING_EFFORT > auto
  let reasoningEffort = normalizeEffort(process.env.CLAUDE_CODE_EFFORT_LEVEL || process.env.PONOS_REASONING_EFFORT || 'auto')
  function resolveEffort() { return reasoningEffort }
  function applyReasoningEffort(value) {
    const v = String(value ?? 'auto').trim().toLowerCase()
    reasoningEffort = normalizeEffort(v)
    return { value: v, effort: reasoningEffort ?? 'auto' }
  }

  function deriveHistory() {
    const base = session ? session.deriveMessages() : memoryHistory.filter((m) => m.role !== 'system')
    // loop --fresh：请求面跳过 fresh 之前的消息（transcript 继续记录，仅模型输入裁剪）
    return historySkip > 0 ? base.slice(historySkip) : base
  }
  // loop --fresh 窗口起点：记录当前消息条数，之后 deriveHistory 从该点起派生
  let historySkip = 0
  function setFreshWindow() {
    historySkip = session ? session.deriveMessages().length : memoryHistory.length
  }
  function pushMemory(m) { if (!session) memoryHistory.push(m) }

  async function runTurnInternal({ content }) {
    // P4-5：provider 热切换后每轮重解析模型（下一轮立即生效，无需重建 engine）
    model = opts.model || getProvider().model || ''
    let usage = {}
    let textBuf = ''
    let overflowRetries = 0
    // 溢出自愈可变输出预算：默认全量 maxTokens；上下文 400 揭示真实窗口后，把单次
    // 输出压到"当前 prompt 装得下"再重试（压缩无果时唯一可行解——vLLM 真实
    // max_model_len 低于配置窗口时，仅靠裁剪/摘要常无法腾出 64K 输出余量）
    let attemptMaxTokens = maxTokens
    // R3-1 本轮窗口预警已发标志（每轮至多一次）
    let contextWarned = false
    // R3-2 失败自愈/计划尾守卫：本轮存在 is_error 工具结果 → hadToolError；
    // guardInjections 记录本轮已注入的"继续执行"提示次数（防模型拒不配合时死循环）
    let hadToolError = false
    let guardInjections = 0
    const maxGuardInjections = Number(process.env.PONOS_GUARD_MAX || 3)
    // R1-1：每轮重置防重放集合（跨轮固定 id 不误判）
    executedToolIds = new Map()
    // 溢出自愈（上下文 400）不设硬计数中断：贴近端点真实窗口的长工具轮会因上下文
    // 渐进增长反复触发 400，按"是否产生实际进展"（压缩落地 / 输出预算还能收窄）
    // 决定继续与否——有进展就继续重试，直到无进展（压缩不可裁且预算已到 2048 下限）
    // 才终局发可见文本。硬计数 3 次会误杀第 4 次仍可收窄自愈的轮次（用户侧表现为
    // 发消息报"本轮执行出现内部错误"）。
    // —— agent loop 兜底状态（每轮重置）：守卫命中即优雅收尾（见文件头 PONOS_* 注释）——
    const turnT0 = Date.now()
    let loopStop = null    // { reason, message }：重复/挂起/墙钟/熔断的收尾说明
    let iterCapHit = false // 单轮迭代硬上限耗尽（无文本时补说明）
    let errorStreak = 0    // 连续全部失败的工具迭代链
    let repeatStreak = 0   // 连续相同工具调用链（主调用规范键）
    let lastToolKey = ''   // 上一迭代主工具规范键
    let remindedAt = new Set() // 已注入提醒的重复次数（防同一阈值重复轰炸）
    let repeatHeals = 0    // ③/③b 命中后注入"推进指令"续跑次数（内部消化，上限 REPEAT_HEAL_MAX）
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
      // outputBudget = 本轮输出预算：maybeCompact 据此把阈值收窄到 window−预算−余量，
      // 防"估算低于比例阈值、但请求 input+max_tokens 已超端点真实窗口"的溢出
      const r = await compactor.maybeCompact({ system: systemPrompt || '', messages: msgs, outputBudget: attemptMaxTokens })
      // M2：摘要调用是一次完整 API 请求（prefill 含被遮蔽历史数万 token），
      // 其 usage 并入本轮（再进 turnStats/result/最终条目）
      if (r?.usage) usage = addUsage(usage, r.usage)
      // R3-1 窗口余量预警：未触发压缩但消息体积已接近阈值（>=75% 窗口，字符粗估）
      // 时发 warning 事件（每轮至多一次；GUI/TUI 渲染警示条，提醒长会话即将压缩）
      if (r?.action === 'none' && !contextWarned) {
        const budget = Number(process.env.PONOS_CONTEXT_WARNING_BUDGET || 150_000)
        const total = msgs.reduce((a, m) => {
          const c = m?.content
          return a + (typeof c === 'string' ? c.length : (Array.isArray(c) ? JSON.stringify(c).length : 0))
        }, 0)
        if (total >= budget) {
          contextWarned = true
          wire.warning?.({ level: 'context', chars: total, budget, message: '上下文接近压缩阈值，长会话即将触发自动压缩' })
        }
      }
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
    for (let iter = 0; ; iter++) {
      // 守卫①：轮次墙钟——单轮累计时长超限即优雅收尾（边界检查：工具批内部有
      // 300s deadline 粒度，长耗时工具的剩余时长由各工具兜底，这里拦的是"轮次
      // 整体拖超时"的无限续轮/挂起残余）。
      if (TURN_TIMEOUT_MS > 0 && Date.now() - turnT0 >= TURN_TIMEOUT_MS) {
        loopStop = {
          reason: 'timeout',
          message: `【已达单轮时长上限（${Math.max(1, Math.round(TURN_TIMEOUT_MS / 60000))} 分钟），为防止挂起已自动收尾。任务可能未完——可发送「继续」让模型接续。】`,
        }
        break
      }
      // 守卫②：迭代硬上限——耗尽即收尾（无文本时补说明，见轮末 iterCapHit）
      if (MAX_TOOL_ITERATIONS > 0 && iter >= MAX_TOOL_ITERATIONS) { iterCapHit = true; break }
      if (loopStop) break
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
      // 生成重复检测窗：thinking+text 同窗累计（用户死循环形态在思考/生成打转），
      // 只留尾部 400 字符参与周期重复判定（长正常输出不误伤）。
      let genWindow = ''
      // 守卫③b 句级近重复检测器（同窗同生命周期：每次 API 调用一个实例，thinking+text
      // 均喂入）。关闭态（RECENT=0 / LOOP_GUARD=0）工厂返回 no-op，零额外开销。
      const nearRep = NEAR_REPEAT_RECENT > 0
        ? createNearRepeatDetector({ back: NEAR_REPEAT_BACK, sim: NEAR_REPEAT_SIM, recent: NEAR_REPEAT_RECENT, avg: NEAR_REPEAT_AVG, codeSkip: NEAR_REPEAT_CODE_SKIP })
        : null
      // 流式空闲看门狗：单次模型流内无块间隔超 STREAM_IDLE_MS 判挂起。挂起时 abort
      // 内部 controller → 下层 fetch 拒绝 → catch 分支按"内部挂起"优雅收尾（区别于
      // 用户取消；用户取消走外层 signal）。守卫关闭（STREAM_IDLE_MS=0）时全为 no-op。
      const watchdog = makeIdleWatchdog(STREAM_IDLE_MS)
      // P1-11 本流是否产出过内容：区分"上游空转挂起（0 产出）"与"模型推理中途停顿
      // （已产出内容后卡住）"，给不同收尾提示；也用于 dead-stream 快速失败分支判定。
      let attemptData = false
      const outerSig = rawAbortSignal(signal)
      const combinedSignal = watchdog.controller && typeof AbortSignal.any === 'function'
        ? (outerSig ? AbortSignal.any([outerSig, watchdog.controller.signal]) : watchdog.controller.signal)
        : signal
      try {
        for await (const chunk of retryStream({
          model,
          messages: requestMessages(),
          maxTokens: attemptMaxTokens,
          signal: combinedSignal,
          tools: tools.toolSchemas(),
          reasoningEffort: resolveEffort(),
        })) {
          if (signal.aborted) throw abortError()
          watchdog.tick()
          attemptData = true // 收到任意 chunk（含 thinking/usage）即视上游在产出
          if (chunk.type === 'text') {
            textBuf += chunk.text
            genWindow = (genWindow + chunk.text).slice(-400)
            wire.assistant([{ type: 'text', text: chunk.text }])
          } else if (chunk.type === 'thinking') {
            genWindow = (genWindow + chunk.text).slice(-400)
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
          // 守卫①b：墙钟（流内版）——覆盖"块持续流动但整体久拖不完"形态（iteration
          // 边界的墙钟检查拦不住单次超长生成）。命中即中断流，说明文本见轮末 finalize。
          if (!loopStop && TURN_TIMEOUT_MS > 0 && Date.now() - turnT0 >= TURN_TIMEOUT_MS) {
            loopStop = {
              reason: 'timeout',
              message: `【已达单轮时长上限（${Math.max(1, Math.round(TURN_TIMEOUT_MS / 60000))} 分钟），为防止挂起已自动收尾。任务可能未完——可发送「继续」让模型接续。】`,
            }
            watchdog.controller?.abort()
          }
          // 守卫③：生成重复检测（每块尾部滚动查一次）——同一片段连续重复 ≥3 次
          // 即判退化循环，abort 当前流并优雅收尾（防 thinking/文本死循环烧 token）。
          // genWindow 满 60 字符才可能触发（minPeriod×minRepeats），短输出不受影响。
          if (!loopStop) {
            const rep = detectGenerationRepeat(genWindow)
            if (rep) {
              loopStop = {
                reason: 'gen-repeat',
                message: `【检测到模型生成内容重复打转（同一片段连续重复 ${rep.repeats} 次、周期 ${rep.p} 字符），已自动收尾以防死循环。可发送「继续」让模型换一种方式接续，或补充更明确的指令。】`,
              }
              watchdog.controller?.abort() // 终止当前流，不再消费后续块
            }
          }
          // 守卫③b：句级近重复检测（每块把 text/thinking 喂入句指纹池）——编织变体
          // 循环（同一批内容措辞微变反复重述，无整段原样复制）由本守卫在句粒度识别：
          // 最近窗内新句的平均"旧句近邻数"超标即中止。精确周期检测（③）抓不到的形态。
          if (!loopStop && nearRep && (chunk.type === 'text' || chunk.type === 'thinking')) {
            const nrep = nearRep.push(chunk.text)
            if (nrep) {
              loopStop = {
                reason: 'near-repeat',
                message: `【检测到模型输出近似内容反复打转（同一批内容措辞微变重复重述，近期每句平均约 ${nrep.avgNeighbor} 句近似旧句），已自动收尾以防死循环。可发送「继续」让模型换一种方式接续，或补充更明确的指令。】`,
              }
              watchdog.controller?.abort() // 终止当前流，不再消费后续块
            }
          }
        }
      } catch (err) {
        // 用户取消永远优先于守卫收尾（同一时刻双触发时按取消语义上报）
        if (signal.aborted) { watchdog.stop(); throw abortError() }
        // 守卫自身 abort 引发的拒绝：墙钟/重复已在流内设 loopStop → 吞掉按守卫收尾
        if (loopStop) {
          // no-op：轮末 finalize 输出说明文本
        } else if (watchdog.tripped) {
          // 内部空闲看门狗触发：不是网络/API 错误，也不是用户取消——按挂起优雅收尾。
          // P1-11 区分两种形态给不同提示：全程 0 产出（上游空转/未就绪，引导查 provider）
          // vs 已产出后停顿（疑似模型推理卡住，保留"可继续重试"语义）。
          loopStop = attemptData
            ? {
                reason: 'idle',
                message: `【模型输出中断（${Math.max(1, Math.round(STREAM_IDLE_MS / 1000))} 秒无数据，此前已产出部分内容——疑似模型推理中途停顿），已按挂起自动收尾。可发送「继续」让模型重试。】`,
              }
            : {
                reason: 'upstream-dead',
                message: `【模型输出中断（连接建立后 ${Math.max(1, Math.round(STREAM_IDLE_MS / 1000))} 秒未收到任何数据——上游疑似未就绪/空转），已按挂起自动收尾。可发送「继续」重试，或检查 provider 对应模型服务是否正常后换一种方式继续。】`,
              }
        } else if (classifyApiError(err).kind === 'dead-stream') {
          // P1-11 空流：请求已受理（HTTP 200）但 0 事件即断/EOF（vLLM 引擎加载中/崩溃
          // 的典型形态）。retryStream 已做 1 次快速重试仍空 → 快速收尾并引导检查
          // provider（不空等 STREAM_IDLE_MS、不把死服务器当"模型挂起"反复重试）。
          loopStop = {
            reason: 'upstream-dead',
            message: `【上游服务空流：请求已被受理但未返回任何数据（疑似模型服务未就绪、加载中或已崩溃），已自动收尾。请检查 provider 对应服务是否正常，或切换 provider 后重试。】`,
          }
        } else if (classifyApiError(err).kind === 'context-window' && compactor && session) {
          // 溢出兜底：先压缩腾 prompt 空间；压缩落地 → 全量输出预算重试；压缩不可落地
          // （总量未达可裁阈值 / 配置窗口虚高致保留预算 > 整段对话 / 摘要熔断）→ 收窄
          // 输出预算再试。两条路只按"是否产生实际进展"继续，不再受溢出次数硬中断——
          // 贴近端点真实窗口的长工具轮会因上下文渐进增长反复 400，若第 3~4 次直接
          // throw，整轮会死在 runTurn 内部错误兜底（用户侧：发消息报内部错误、任务中断）。
          // 分类覆盖 Anthropic context_window_exceeded 与 vLLM/OpenAI "maximum context
          // length" 400（见 api.mjs classifyApiError）。limit：解析端点真实窗口传给压缩器，
          // 防摘要请求自身超限（配置窗口虚高于真实 max_model_len 时必现，否则压缩也不落地）。
          const genBefore = session.getSurface().replaceGeneration
          const realLimit = /maximum context length is (\d+)\s*tokens?/i.exec(err?.message || '')
          const promptN = /prompt contains (?:at least )?(\d+)\s*(?:input\s+)?tokens?/i.exec(err?.message || '')
          const limit = realLimit ? Number(realLimit[1]) : 0
          // —— 窗口真实化：400 揭示的端点真实 max_model_len 持久化进压缩器 context ——
          // 配置窗口虚高（GUI 256k vs vLLM 实际 131k）时 pre-step 阈值按虚高窗口算，
          // 主动压缩永不触发 → 每轮撞 400 被迫 forceCompact（"几乎跑完一两轮就压缩"）。
          // 采纳后阈值/保留/老化按真实窗口走，压缩转为到点主动触发。只下调不上调。
          if (limit > 0) {
            try {
              const adopted = compactor.adoptWindow(limit)
              if (adopted?.adopted) {
                // 输出预算封顶：真实窗口 ≤ 当前输出预算时任何请求都放不下
                // （input≥0 + max_tokens > window），直接压到半窗水平（大窗
                // 131k > 64k 预算的主场景不触发，仅小窗模型受惠）
                if (adopted.window < attemptMaxTokens) {
                  attemptMaxTokens = Math.max(2048, Math.floor(adopted.window * 0.5))
                }
                wire?.system?.('context_window_adopted', { window: adopted.window })
              }
            } catch { /* 窗口采纳失败不阻断自愈（仍走既有 forceCompact + 预算收窄） */ }
          }
          let r = null
          let compactErr = null
          try {
            r = await compactor.forceCompact({
              system: systemPrompt,
              messages: session.deriveMessages(),
              limit: limit || undefined,
              // 输出预算已定时的保留预算上限：retain ≤ 真实窗口 − 当前输出预算 − 余量。
              // 配置窗口（GUI 设 256k/1M）虚高于端点真实 max_model_len 时，默认 retain
              // 预算 > 整段对话 → 压缩永无可裁切点；按真实窗口反推保留上限，才能让压缩
              // 在贴近端点硬限时真正落地（否则只能靠输出收窄，质量与耗时双损）。
              retainHint: limit > 0 ? Math.max(4096, limit - attemptMaxTokens - 32768) : undefined,
            })
          } catch (ce) { compactErr = ce } // 压缩请求自身失败：降级走输出预算收窄，不让压缩异常杀掉自愈
          const genAfter = session.getSurface().replaceGeneration
          // M2：溢出路径的摘要调用同样是完整 API 请求，usage 并入本轮
          if (r?.usage) usage = addUsage(usage, r.usage)
          if (genAfter > genBefore) {
            // 压缩真实落地 → 上下文已变小，保持全量输出预算重试（不叠加收窄，避免浪费）
            overflowRetries++
            overflowed = true
          } else {
            // 收窄输出预算到"当前 prompt 装得下"再试。prompt 优先取服务端实测数（精确，
            // 余量 2048 兜 tokenizer 偏差与 system 抖动）；解析不到时输出预算折半兜底
            // （半衰收敛，无需精确 prompt 数）。预算已到下限 2048 仍装不下且压缩不可裁
            // = 双路皆绝 → 终局可见文本（空结果会让 GUI 静默卡死，见下）。
            const nextBudget = limit > 0
              ? (promptN
                  ? Math.max(2048, Math.min(attemptMaxTokens, limit - Number(promptN[1]) - 2048))
                  : Math.max(2048, Math.floor(attemptMaxTokens / 2)))
              : attemptMaxTokens
            if (nextBudget < attemptMaxTokens) {
              attemptMaxTokens = nextBudget
              overflowRetries++
              overflowed = true
            } else {
              const errText = `【系统】上下文已超出模型窗口${limit ? `（端点上限 ${limit} tokens）` : ''}，自动压缩与输出预算收窄均无法腾出空间${compactErr ? `（压缩失败：${String(compactErr?.message || compactErr).slice(0, 120)}）` : ''}，本轮已放弃执行。可开新会话，或让我先清理上下文再继续。`
              pushMemory({ role: 'assistant', content: errText })
              if (session) lastAssistantEntry = session.appendAssistant([{ type: 'text', text: errText }], { model })
              try { wire.assistant([{ type: 'text', text: errText }]) } catch { /* 事件流异常不再掩盖原错误 */ }
              watchdog.stop()
              finalizeUsage()
              return { usage, model, text: errText, error: 'overflow-compact-failed' }
            }
          }
        } else {
          watchdog.stop()
          throw err
        }
      }
      watchdog.stop()
      if (overflowed) continue // 压缩落地 → 重试同一轮（deriveHistory 已含摘要条目）
      // P1 生成重复守卫内部自愈：③/③b（gen-repeat/near-repeat）命中不直接收尾报给用户
      // ——先丢弃退化流，注入"推进指令"续跑（上限 REPEAT_HEAL_MAX）。一次性打转/探测器
      // 误判 → 一轮注入即恢复，用户无感（无收尾说明进会话、无报错体感）；真死循环模型
      // 持续复现 → 耗尽上限后走下方 break 收尾（说明文本仍兜底，不烧死 token）。
      if (loopStop && REPEAT_HEAL_MAX > 0 && repeatHeals < REPEAT_HEAL_MAX &&
          (loopStop.reason === 'gen-repeat' || loopStop.reason === 'near-repeat')) {
        repeatHeals++
        const healReason = loopStop.reason
        loopStop = null
        textBuf = '' // 退化部分内容不落模型输入（与收尾路径"不落退化内容"同哲学）
        const inject = '【系统】检测到你刚才的回复在反复复述近似内容（疑似陷入生成循环），该部分已被丢弃。请立即停止复述，直接推进当前任务——执行下一步具体行动或直接给出最终结论。'
        pushMemory({ role: 'user', content: inject })
        if (session) session.appendUser(inject)
        try { wire?.system?.('guard_heal', { reason: healReason, attempt: repeatHeals, max: REPEAT_HEAL_MAX }) } catch { /* 事件异常不影响主流程 */ }
        continue
      }
      if (loopStop) break // 生成重复/挂起已优雅收尾 → 本轮结束（说明文本见轮末 finalize）
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
      // R3-2 失败自愈 + 计划尾守卫：模型无工具调用即收尾时，若本轮存在工具错误
      // 或文本带"计划/承诺"尾巴（先…/接下来…/开始…），注入引导继续执行——
      // 消灭"认错即停"与"只计划不执行"两类中断（注入 user 文本，保持 API 消息链合法）
      if (blocks.length === 0) {
        if (hadToolError && guardInjections < maxGuardInjections) {
          guardInjections++
          const inject = '【系统】检测到上一轮存在失败/被取消的工具调用，任务尚未完成。请立即重试或补发正确的工具调用，不要停留在文本说明。'
          pushMemory({ role: 'user', content: inject })
          if (session) session.appendUser(inject)
          textBuf = ''
          continue
        }
        if (textBuf.trim() && guardInjections < maxGuardInjections && isPlanTail(textBuf)) {
          guardInjections++
          const inject = '【系统】你在上一轮承诺了后续动作（先…/接下来…/开始…）但未执行工具调用就结束了回合。任务型轮次必须以实际工具调用收尾——请立即落实你提到的计划，或明确说明任务已完成并给出结果摘要。'
          pushMemory({ role: 'user', content: inject })
          if (session) session.appendUser(inject)
          textBuf = ''
          continue
        }
        break
      }
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
      // R3-2 失败自愈：记录本轮工具错误（模型下一轮若认错即停，守卫会强制重试）；
      // 工具成功执行后重置（错误已恢复，不再触发守卫）
      if (toolResults.some((r) => r.is_error)) hadToolError = true
      else if (toolResults.length) hadToolError = false
      // 守卫④：连续工具失败熔断——连续"全部失败"迭代达上限即收尾止损（任一成功
      // 即复位）。与 R3-2 自愈互补：自愈引导"失败后重试"，熔断负责"重试救不回来"
      // 时的兜底，二者同源但用途相反。
      const allFailed = toolResults.length > 0 && toolResults.every((r) => r.is_error)
      if (allFailed) errorStreak++
      else if (toolResults.length) errorStreak = 0
      if (toolResults.length) {
        pushMemory({ role: 'user', content: toolResults })
        if (session) session.appendToolResults(toolResults)
      }
      // 守卫⑤：连续同工具提醒（dsh repeat-tool-reminder 语义：仅提醒不否决，硬性
      // 由迭代上限兜底）。以每轮首个 tool_use 的规范键（name+参数深排序）为基准；
      // 键变化视为换了方向，链复位。到阈值把提示并入下一条 user 消息——顺序为
      // assistant(tool_use) → user(tool_result) → user(提醒)，与 R3-2 注入先例
      // 一致（连续 user 消息 API 接受）。
      if (!loopStop && REPEAT_REMIND_AT.length && blocks.length) {
        const key = canonicalToolCallKey(blocks[0])
        if (key && key === lastToolKey) {
          repeatStreak++
        } else {
          repeatStreak = 1
          lastToolKey = key
          remindedAt = new Set()
        }
        if (REPEAT_REMIND_AT.includes(repeatStreak) && !remindedAt.has(repeatStreak)) {
          remindedAt.add(repeatStreak)
          const inject = `【提示】你已连续 ${repeatStreak} 次调用同一工具（${blocks[0].name}）且未见方向变化。若前几次未取得实质进展，请换一种方法（其他工具、拆解子任务或直接向用户说明卡点），不要重复无进展的调用。`
          pushMemory({ role: 'user', content: inject })
          if (session) session.appendUser(inject)
        }
      }
      if (MAX_ERROR_ITERATIONS > 0 && errorStreak >= MAX_ERROR_ITERATIONS) {
        loopStop = {
          reason: 'error-meltdown',
          message: `【连续 ${errorStreak} 轮工具调用全部失败，已自动收尾停止重试。请检查失败原因（权限/环境/参数）后重新发起，或明确告知用户无法推进。】`,
        }
        break
      }
      // 继续下一轮 API 调用（模型看到 tool_result 后产出新回复）
      textBuf = ''
    }
    // 守卫收尾：命中任一守卫（迭代上限/重复打转/挂起/墙钟/熔断）时，用收尾说明
    // 取代残留的部分文本——部分流式内容 GUI 实时已见，但模型输入面不落退化内容，
    // 保持会话上下文干净可续聊（用户可发「继续」接续）。
    if (loopStop || iterCapHit) {
      const notice = loopStop?.message || `【已达单轮工具迭代上限（${MAX_TOOL_ITERATIONS} 轮），为防失控已自动收尾。任务可能未完——可发送「继续」让模型接续。】`
      textBuf = notice
      if (notice.trim()) wire.assistant([{ type: 'text', text: notice }])
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
        // 串行路径同样兜底：executeToolUse 抛异常（审批/执行器内部错误）不得中断
        // 整个 turn——回填错误结果并继续，模型下一轮看到 is_error 后自愈重试。
        try {
          results[i] = await executeToolUse(b, ctx)
        } catch (e) {
          results[i] = { content: `工具执行异常：${e?.message || String(e)}`, isError: true }
        }
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

  // 工具权限门（P1-7 权限决策 + ask 审批挂起 + hooks.preToolUse 否决）。主 agent
  // 会话 executeToolUse 与工作流内嵌工具调用共用同一道门——工作流 tool/document/
  // agent 节点经 registry 直接执行工具时不得旁路主会话审批（高危 Bash/越权操作须
  // 同样 ask/deny/hook 拦截），门返回 { allowed:true } 放行 / { allowed:false, message }。
  async function gateToolUse(toolUse) {
    const perm = decideToolPermission({ toolName: toolUse.name, input: toolUse.input, skipPermissions: opts.skipPermissions, autoApproveHighRisk: opts.autoApproveHighRisk, rules: opts.permissionRules })
    if (perm.decision === 'deny') {
      denialStreak++
      denialTotal++
      return { allowed: false, message: '用户拒绝执行该操作' }
    }
    if (perm.decision === 'ask') {
      // 降级检查：拒绝过多 → 直接 deny（不挂起弹窗）
      if (denialStreak >= DENIAL_STREAK_LIMIT || denialTotal >= DENIAL_TOTAL_LIMIT) {
        denialTotal++
        return {
          allowed: false,
          message: `用户已连续拒绝 ${denialStreak} 次高危操作（累计 ${denialTotal} 次）。请停止尝试危险命令，改用安全替代方案。`,
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
      // 审批等待 deadline（L0-a）：GUI 应答缺失（弹窗丢失/前端未响应）且无 cancel 信号时，
      // waiter 永不 resolve → 工具批挂死在权限边界（TURN_TIMEOUT 在迭代边界检查，进不了
      // 工具内部）。超时按"未授权"回填，模型转向安全替代；不计 denial 计数（非用户拒绝，
      // 否则 3 次超时会误触发"连续拒绝"降级）。map 里存包装函数：任何解除路径都先清 timer。
      const approvalTimeoutMs = Math.max(1000, Number(process.env.PONOS_APPROVAL_TIMEOUT_MS || 600_000))
      const decision = await new Promise((resolvePromise) => {
        const timer = setTimeout(() => {
          approvalWaiters.delete(toolUse.id)
          // 超时文案与可配时长一致（审计 #6 收尾）：整分钟走分钟、否则按秒动态，
          // 避免 PONOS_APPROVAL_TIMEOUT_MS 改小时仍硬编码"10 分钟"误导用户
          const mins = Math.round(approvalTimeoutMs / 60000)
          const label = approvalTimeoutMs % 60000 === 0 ? `${mins} 分钟` : `${Math.round(approvalTimeoutMs / 1000)} 秒`
          resolvePromise({ behavior: 'timeout', message: `审批等待超时（${label}未收到用户响应），未执行该操作` })
        }, approvalTimeoutMs)
        approvalWaiters.set(toolUse.id, (d) => { clearTimeout(timer); resolvePromise(d) })
      })
      if (decision?.behavior !== 'allow') {
        if (decision?.behavior !== 'timeout') {
          denialStreak++
          denialTotal++
        }
        return { allowed: false, message: decision?.message || '用户拒绝执行该操作' }
      }
      denialStreak = 0
    }
    // hooks.preToolUse：可否决。deny → 工具不执行，错误回填给模型。
    const hooks = opts.hooks
    if (hooks) {
      const h = await hooks.run('preToolUse', { toolName: toolUse.name, toolUseId: toolUse.id, input: toolUse.input })
      if (h.deny) return { allowed: false, message: h.message || `PreToolUse hook 拒绝执行 ${toolUse.name}` }
    }
    return { allowed: true }
  }

  async function executeToolUse(toolUse, ctx = {}) {
    const gate = await gateToolUse(toolUse)
    if (!gate.allowed) return { content: gate.message, isError: true }
    // P2-1①/AS1：lane 白名单 deny gate——子 agent options 显式声明 tools/skills 时收窄。
    // 空数组/未定义跳过（全量）。仅当 mock/模型以名单外工具名发起时才拦截（第二道保险，
    // 第一道是 retryStream 的 tools 收窄让模型根本看不到名单外工具）。
    const lo = ctx?.laneOptions
    if (lo && Array.isArray(lo.allowedTools) && lo.allowedTools.length && !lo.allowedTools.includes(toolUse.name)) {
      return { content: `子 Agent 工具白名单不含 ${toolUse.name}（允许：${lo.allowedTools.join(', ')}），已拒绝执行`, isError: true }
    }
    if (toolUse.name === 'Skill' && Array.isArray(lo?.allowedSkills) && lo.allowedSkills.length
        && !lo.allowedSkills.includes(String(toolUse.input?.skill ?? ''))) {
      return { content: `子 Agent 技能白名单不含「${String(toolUse.input?.skill ?? '')}」（允许：${lo.allowedSkills.join(', ')}），已拒绝加载`, isError: true }
    }
    // ctx：工具执行上下文——主循环注入 spawnSubAgent/taskSystem/browserDriver
    // （Agent/Task/Browser 工具依赖），子 agent 循环注入 lane:true（禁嵌套分发）
    const { store, ...toolCtx } = ctx
    // P1-9：统一执行 deadline（兜"永不返回"的工具；各工具自身超时负责 kill）
    const toolDeadlineMs = Number(process.env.CLAUDE_CODE_TOOL_TIMEOUT_MS || 300_000)
    const r = await withToolDeadline(tools.run(toolUse, { ...toolCtx, toolUseId: toolUse.id, browserDriver: runBrowser }), toolDeadlineMs)
    // P0-3：大结果落盘到目标会话目录（子 lane 独立 store）。Read 例外：Read 返回的
    // 就是模型显式索要的文件内容（≤2000 行/2MB，超界文件已由 Read 自身引导 offset/
    // limit），落盘替换成 stub 会让"读大源文件"只见预览 + 引导补读，模型被迫小段
    // offset/limit 重读（用户侧表现为工具"输出被落盘"、反复续读），且补读 stub 文件
    // 又触发二次落盘 → 迭代空转。故 Read 结果保持内联，其余工具（Bash 等）大输出
    // 照常落盘 + stub 补读（路径已并入边界，见 createEngine toolResultsDir）。
    if (r && typeof r === 'object' && typeof r.content === 'string') {
      if (toolUse.name === 'Read') { /* Read 结果内联，不落盘替换 */ }
      else r.content = persistToolResult(store || session, toolUse.id, r.content)
    }
    // hooks.postToolUse：工具结果后触发（output 截断 8KB；不阻塞主流程决策）
    const hooks = opts.hooks
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
  // 子循环与 runTurnInternal 语义对齐但简化：无健康（短会话）；无压缩器——上下文溢出
  // 仅靠输出预算收窄自愈（见下方 #5 catch），不引入主循环式压缩/窗口采纳。
  // signal 为轮次级取消：主 signal（用户 cancel 全中断）∨ 子 signal（Task stop）
  async function runSubAgentLoop({ store, sysPrompt, signal: subSignal, onTool, options = {} }) {
    let usage = {}
    let textBuf = ''
    let toolUses = 0
    const subT0 = Date.now()
    // P2-1①/AS1：lane 级参数（model/tools/skills 白名单）。options 未定义/空 =
    // 全量（零回归锁①）。loopModel 在 retryStream 与落盘（appendAssistant）统一使用。
    const loopModel = options?.model || model
    const laneToolSchemas = (Array.isArray(options?.allowedTools) && options.allowedTools.length)
      ? tools.toolSchemas().filter((t) => options.allowedTools.includes(t.name))
      : null
    // 守卫命中时的收尾说明（resume 续跑提示；null = 正常运行）。stopped 标志让
    // runLaneExecution 把守卫停登记为 status='stopped'（同取消，可 resume 续跑）。
    const stopNotice = (reason, detail) =>
      `【子 Agent 任务已因${reason}自动中止：${detail}。可用 resume_task_id 让模型在既有会话上续跑。】`
    const guardStop = (text) => ({ usage, text, stopped: true })
    const msgs = () => {
      const m = patchOrphanToolUses(store.deriveMessages())
      return [{ role: 'system', content: sysPrompt }].filter((x) => x.content).concat(m)
    }
    // P1 ③/③b 内部自愈（同主 loop）：子 lane 重复命中先注入推进指令续跑；耗尽上限
    // （REPEAT_HEAL_MAX）才落回 guardStop 说明收尾
    let subHeals = 0
    let subErrorStreak = 0 // P1-守卫④（子 lane，审计 #4）：连续全部失败的工具迭代链（跨轮累计，任一成功即复位）
    let attemptMaxTokens = maxTokens   // P1-#5（子 lane，审计 #5）：溢出收窄的可变输出预算（初值同主循环 433）
    // 审计 #10（子 lane 镜像）：R3-2 失败自愈——本轮存在 is_error 工具结果 → hadToolError；
    // guardInjections 记录已注入的"继续执行"提示次数（上限同主循环 PONOS_GUARD_MAX，防
    // 模型拒不配合时死循环）；守卫⑤ 同工具提醒——连续相同工具调用链（canonicalToolCallKey
    // 基准，与③/③b 检文本重复不重叠；仅提醒不 veto）
    let hadToolError = false
    let guardInjections = 0
    const maxGuardInjections = Number(process.env.PONOS_GUARD_MAX || 3)
    let subRepeatStreak = 0
    let lastSubToolKey = ''
    let subRemindedAt = new Set()
    for (let iter = 0; ; iter++) {
      // 守卫（子 lane 同主 loop）：墙钟 + 迭代上限——命中即附说明收尾（防子任务
      // 拖死整个后台任务；同主任务守卫共用同一组 PONOS_* 阈值）
      if (TURN_TIMEOUT_MS > 0 && Date.now() - subT0 >= TURN_TIMEOUT_MS) {
        return guardStop(stopNotice('运行超时', `超过 ${Math.round(TURN_TIMEOUT_MS / 60000)} 分钟`))
      }
      if (MAX_TOOL_ITERATIONS > 0 && iter >= MAX_TOOL_ITERATIONS) {
        return guardStop(stopNotice('达到迭代上限', `连续 ${MAX_TOOL_ITERATIONS} 轮工具循环`))
      }
      const blocks = []
      let subStopReason = null // P0-2（同主 loop）：流内 stop_reason 消费（length 截断判据）
      let genWindow = ''
      // 守卫③b 句级近重复检测器（同主 loop：每流一实例，thinking+text 同窗喂入）
      const nearRep = NEAR_REPEAT_RECENT > 0
        ? createNearRepeatDetector({ back: NEAR_REPEAT_BACK, sim: NEAR_REPEAT_SIM, recent: NEAR_REPEAT_RECENT, avg: NEAR_REPEAT_AVG, codeSkip: NEAR_REPEAT_CODE_SKIP })
        : null
      const watchdog = makeIdleWatchdog(STREAM_IDLE_MS)
      const laneSig = rawAbortSignal(subSignal)
      const streamSignal = watchdog.controller && typeof AbortSignal.any === 'function'
        ? (laneSig ? AbortSignal.any([laneSig, watchdog.controller.signal]) : watchdog.controller.signal)
        : subSignal
      let subStop = null // ③/③b 命中（本流重复打转）→ abort 后走流外自愈/收尾（不进 catch 抛错）
      // P1-11（子 lane 镜像主循环 attemptData）：本流是否产出过内容——收到任意 chunk
      // （含 thinking/usage）即置位，等价"上游在产出"。#8 之后 textBuf 只收 text、thinking
      // 仅进 genWindow，不能作"上游是否产出"判据；看门狗措辞判别（watchdog.tripped 分支）
      // 须用本标志，否则"只产 thinking 后停"的 lane 会被误报"上游服务空流（未收到任何数据）"。
      let streamProduced = false
      try {
        for await (const chunk of retryStream({ model: loopModel, messages: msgs(), maxTokens: attemptMaxTokens, signal: streamSignal, tools: laneToolSchemas ?? tools.toolSchemas() })) {
          if (signal.aborted || subSignal.aborted) throw abortError()
          watchdog.tick()
          streamProduced = true
          if (chunk.type === 'text') {
            textBuf += chunk.text
            genWindow = (genWindow + chunk.text).slice(-400)
          } else if (chunk.type === 'thinking') {
            genWindow = (genWindow + chunk.text).slice(-400) // thinking 参与③检测窗，不入摘要
          } else if (chunk.type === 'tool_use' && !blocks.some((b) => b.id === chunk.id)) {
            blocks.push({ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input })
          } else if (chunk.type === 'usage') {
            usage = addUsage(usage, chunk.usage)
          } else if (chunk.type === 'stop_reason') {
            subStopReason = chunk.reason
          }
          // 流内墙钟（同主 loop 守卫①b）：单次生成久拖不结（块持续流动）同样中断
          if (TURN_TIMEOUT_MS > 0 && Date.now() - subT0 >= TURN_TIMEOUT_MS) {
            watchdog.controller?.abort()
            watchdog.stop()
            return guardStop(`${textBuf.trim()} ${stopNotice('运行超时', `超过 ${Math.round(TURN_TIMEOUT_MS / 60000)} 分钟`)}`.trim())
          }
          // 生成重复打转检测（同主 loop 守卫③）：命中中止当前流，流外统一内部自愈/收尾
          if (!subStop) {
            const rep = detectGenerationRepeat(genWindow)
            if (rep) {
              subStop = { reason: 'gen-repeat', detail: `同一片段连续重复 ${rep.repeats} 次` }
              watchdog.controller?.abort()
            }
          }
          // 守卫③b 句级近重复（编织变体循环；同主 loop）：同上
          if (!subStop && nearRep && (chunk.type === 'text' || chunk.type === 'thinking')) {
            const nrep = nearRep.push(chunk.text)
            if (nrep) {
              subStop = { reason: 'near-repeat', detail: `同一批内容措辞微变重复重述，近期每句平均约 ${nrep.avgNeighbor} 句近似旧句` }
              watchdog.controller?.abort()
            }
          }
        }
      } catch (err) {
        watchdog.stop()
        if (signal.aborted || subSignal.aborted) throw err // 用户取消（级联）原样上报
        if (subStop) { /* no-op：流外统一自愈/收尾 */ }
        else if (watchdog.tripped) {
          // P1-11（子 lane 镜像）：全程 0 产出 → 上游空转/未就绪提示（引导查 provider）；
          // 已产出后停顿 → 推理中途停顿语义（保留 resume 续跑提示）。判别用 streamProduced
          // （镜像主循环 attemptData，收到任意 chunk 即上游在产出）而非 textBuf.length——
          // #8 后 textBuf 仅 text，thinking 不入（thinking 只进 genWindow，见上方分流）。
          return guardStop(`${textBuf.trim()} ${streamProduced
            ? stopNotice('输出中断', `超过 ${Math.max(1, Math.round(STREAM_IDLE_MS / 1000))} 秒无数据（此前已产出部分内容——疑似推理中途停顿）`)
            : stopNotice('上游服务空流', `连接建立后 ${Math.max(1, Math.round(STREAM_IDLE_MS / 1000))} 秒未收到任何数据——疑似模型服务未就绪/空转，请检查 provider`)}`.trim())
        }
        else if (classifyApiError(err).kind === 'dead-stream') {
          // P1-11（子 lane 镜像）：HTTP 200 后 0 事件即断/EOF → 快速收尾（不空等不狂重试）
          return guardStop(stopNotice('上游服务空流', '请求已被受理但未返回任何数据——疑似模型服务未就绪、加载中或已崩溃，请检查 provider'))
        }
        else if (classifyApiError(err).kind === 'context-window') {
          // P1-#5（子 lane 镜像，审计 #5）：上下文溢出自愈——只做输出预算收窄重试（短会话
          // 无压缩器，见本函数头注释；正则 verbatim 镜像主循环 673-674，公式同主循环 720-724）。
          const m = String(err?.message || err)
          const limit = /maximum context length is (\d+)\s*tokens?/i.exec(m)
          const promptN = /prompt contains (?:at least )?(\d+)\s*(?:input\s+)?tokens?/i.exec(m)
          const limitN = limit ? Number(limit[1]) : 0
          const nextBudget = limitN > 0
            ? (promptN
                ? Math.max(2048, Math.min(attemptMaxTokens, limitN - Number(promptN[1]) - 2048))
                : Math.max(2048, Math.floor(attemptMaxTokens / 2)))
            : attemptMaxTokens
          if (nextBudget < attemptMaxTokens) {
            attemptMaxTokens = nextBudget
            continue // 收窄成功 → 同轮重试（受循环头墙钟/迭代上限守卫覆盖，无需额外防死循环）
          }
          return guardStop(stopNotice(
            '上下文窗口溢出',
            '子任务无压缩（短会话），输出预算收窄至下限仍无法腾出空间，本轮已放弃执行',
          ))
        }
        else throw err
      }
      watchdog.stop()
      // P1 ③/③b 内部自愈（同主 loop）：丢弃退化流 → 注入推进指令续跑；耗尽上限才收尾
      if (subStop) {
        if (REPEAT_HEAL_MAX > 0 && subHeals < REPEAT_HEAL_MAX) {
          subHeals++
          textBuf = ''
          const inject = '【系统】检测到你刚才的回复在反复复述近似内容（疑似陷入生成循环），该部分已被丢弃。请立即停止复述，直接推进当前任务——执行下一步具体行动或直接给出最终结论。'
          store.appendUser(inject)
          continue
        }
        return guardStop(stopNotice(subStop.reason === 'gen-repeat' ? '生成内容重复打转' : '生成内容近似打转', subStop.detail))
      }
      // P0-2（子 lane 镜像）：输出被 max_tokens 截断且已产出工具调用 → 不执行残缺参数，
      // 注入 is_error tool_result 提示模型补全重发（主循环同款保护，防子 lane 复活缺陷）
      if (blocks.length > 0 && subStopReason === 'length') {
        const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
        store.appendAssistant(assistantBlocks, { model: loopModel })
        const errorResults = blocks.map((b) => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: '模型输出被 max_tokens 截断，工具调用参数可能不完整，未执行。请重新完整发起该工具调用。',
          is_error: true,
        }))
        store.appendToolResults(errorResults)
        textBuf = ''
        continue
      }
      if (blocks.length === 0) {
        // 审计 #10 R3-2（子 lane 镜像）：模型无工具调用即收尾、且上一轮存在工具失败 → 注入
        // 续跑指令强制重试（镜像主循环 runTurnInternal blocks.length===0 分支的注入块；
        // 注入用 store.appendUser——lane 无 pushMemory/session 概念，同 subStop 自愈先例）。
        // 与守卫④熔断互补：R3-2 在失败轮后先给"重试机会"，熔断兜"重试救不回来"的底。
        // guardInjections 额度上限防模型拒不配合时无限注入续跑。
        if (hadToolError && guardInjections < maxGuardInjections) {
          guardInjections++
          const inject = '【系统】检测到上一轮存在失败/被取消的工具调用，任务尚未完成。请立即重试或补发正确的工具调用，不要停留在文本说明。'
          store.appendUser(inject)
          textBuf = ''
          continue
        }
        break
      }
      const assistantBlocks = [...(textBuf.trim() ? [{ type: 'text', text: textBuf }] : []), ...blocks]
      store.appendAssistant(assistantBlocks, { model: loopModel })
      // P0-4：子 lane 同样走只读并发批；结果按模型顺序收集
      const executed = await runToolBatch(blocks, { lane: true, store, laneOptions: options })
      const toolResults = blocks.map((b, i) => ({
        tool_use_id: b.id,
        content: executed[i]?.content ?? '',
        is_error: executed[i]?.isError === true,
      }))
      // 审计 #10 R3-2（子 lane 镜像）：记录本轮工具错误（模型下一轮若纯文本收尾，守卫会
      // 注入续跑）；工具成功执行后重置（错误已恢复，不再触发守卫）——镜像主循环 819-820。
      if (toolResults.some((r) => r.is_error)) hadToolError = true
      else if (toolResults.length) hadToolError = false
      for (let i = 0; i < blocks.length; i++) {
        toolUses++
        onTool?.(blocks[i], executed[i], toolUses)
      }
      store.appendToolResults(toolResults)
      // 审计 #10 守卫⑤（子 lane 镜像）：连续同工具提醒（dsh repeat-tool-reminder 语义：
      // 仅提醒不 veto，硬性由迭代上限兜底）。以每轮首个 tool_use 的规范键（name+参数深排序）
      // 为基准；键变化视为换了方向，链复位。位置在工具结果落 store 后、守卫④熔断判定前，
      // 镜像主循环 836-851 的提醒块。注入经 store.appendUser，与③/③b 不重叠（③③b 检生成
      // 文本重复、⑤ 检重复同工具调用，信号与阶段皆异）。
      if (REPEAT_REMIND_AT.length && blocks.length) {
        const key = canonicalToolCallKey(blocks[0])
        if (key && key === lastSubToolKey) {
          subRepeatStreak++
        } else {
          subRepeatStreak = 1
          lastSubToolKey = key
          subRemindedAt = new Set()
        }
        if (REPEAT_REMIND_AT.includes(subRepeatStreak) && !subRemindedAt.has(subRepeatStreak)) {
          subRemindedAt.add(subRepeatStreak)
          const inject = `【提示】你已连续 ${subRepeatStreak} 次调用同一工具（${blocks[0].name}）且未见方向变化。若前几次未取得实质进展，请换一种方法（其他工具、拆解子任务或直接向用户说明卡点），不要重复无进展的调用。`
          store.appendUser(inject)
        }
      }
      // P1-守卫④（子 lane 镜像，审计 #4）：连续"全部失败"迭代达上限即收尾止损（任一
      // 成功即复位）——镜像主循环 engine.mjs:786-791 / 817-823，工具结果落 store 后
      // 判定，不改落 store 语义。与 R3-2 自愈互补：自愈引导失败后重试，熔断兜"重试救
      // 不回来"的底（审计 #4：子 lane 此前无此守卫，连续全败会一路空转到迭代上限）。
      const allLaneFailed = toolResults.length > 0 && toolResults.every((r) => r.is_error)
      if (allLaneFailed) subErrorStreak++
      else if (toolResults.length) subErrorStreak = 0
      if (MAX_ERROR_ITERATIONS > 0 && subErrorStreak >= MAX_ERROR_ITERATIONS) {
        const meltdownNotice = stopNotice(
          '连续工具调用全部失败',
          `连续 ${subErrorStreak} 轮工具调用全部失败，已自动收尾停止重试。请检查失败原因（权限/环境/参数）后重新发起。`,
        )
        // 收尾说明同主循环 loopStop 文案落会话：追加进子 lane 转录，resume_task_id 续跑
        // 时模型可见停止原因（r.text 亦带同文案，经 task_notification.summary 交付）
        store.appendAssistant([{ type: 'text', text: meltdownNotice }], { model: loopModel })
        return guardStop(meltdownNotice)
      }
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
  async function runLaneExecution({ taskId, laneStore, sysPrompt, signal: subSignal, writePaths, t0, onTool, laneOptions }) {
    let text = ''
    let status = 'completed'
    let usage = {}
    try {
      const r = await runSubAgentLoop({ store: laneStore, sysPrompt, signal: subSignal, onTool, options: laneOptions })
      text = String(r.text || '').trim()
      usage = r.usage
      // 守卫停（防死循环自动中止）→ 与取消同态登记为 stopped（可 resume 续跑）
      if (r.stopped) status = 'stopped'
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

  // AS1：agent tools/skills 引用未知项诊断（提示不拦截；skillIds 仅在 cli 提供时校验，
  // 缺省（cli 在 Task 6 前无需传）跳过技能校验）
  function warnUnknownAgentRefs(agent) {
    try {
      const knownTools = new Set(tools.toolNames)
      const unknownTools = (agent.tools || []).filter((t) => !knownTools.has(t))
      const knownSkills = opts.skillIds ? new Set(opts.skillIds) : null
      const unknownSkills = knownSkills ? (agent.skills || []).filter((s) => !knownSkills.has(s)) : []
      const unk = [...unknownTools.map((t) => `工具 ${t}`), ...unknownSkills.map((s) => `技能 ${s}`)]
      if (unk.length) wire.warning?.({ level: 'agent_spec', agent: agent.id, message: `子 Agent「${agent.id}」引用未知${unk.join('、')}（已忽略，不拦截执行）` })
    } catch { /* 诊断失败静默 */ }
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
        signal: subController.signal, writePaths, t0, onTool, laneOptions: target.laneOptions,
      })
      return { content: `子 Agent 任务已续跑（task_id: ${resumeTaskId}）。完成时收到通知，可用 Task 工具查询/中止。`, isError: false }
    }
    const agent = resolveAgent(agents, type)
    if (!agent) return { content: `未知子 Agent：${type}。可用：${agents.map((a) => a.id).join(', ')}`, isError: true }
    if (!prompt) return { content: 'prompt 缺失：请说明要委派给子 Agent 的任务', isError: true }
    // AS1：agent spec 三字段接线（P2-1① 签名扩展的消费方）。tools/skills 引用未知项 →
    // wire.warning（level:'agent_spec'）提示不拦截；空/未定义 = 全量（零回归锁①）。
    const laneOptions = {
      model: agent.model || '',
      allowedTools: Array.isArray(agent.tools) && agent.tools.length ? agent.tools : undefined,
      allowedSkills: Array.isArray(agent.skills) && agent.skills.length ? agent.skills : undefined,
    }
    // 空 schema 守卫：tools 名单无一命中已注册工具名时，toolSchemas().filter 结果为空集
    // ——空集（非 null）会让 retryStream 收到 tools:[]（lane 无工具可用）。此时视为
    // "未收窄"（allowedTools 清空 → 全量 schema + deny gate 放行）。注册表名与
    // toolSchemas 的 name 同源（tools.mjs toolNames），此处判定等价于 schema 命中判定。
    if (Array.isArray(laneOptions.allowedTools) && laneOptions.allowedTools.length) {
      const knownToolNames = new Set(tools.toolNames)
      if (!laneOptions.allowedTools.some((t) => knownToolNames.has(t))) laneOptions.allowedTools = undefined
    }
    warnUnknownAgentRefs(agent)
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
    const sysPrompt = agent.systemPrompt || `你是 Ponos 的子 Agent「${agent.name}」：${agent.description}。使用简体中文。`
    const subController = new AbortController()
    const t0 = Date.now()
    const writePaths = []
    const onTool = makeLaneOnTool({ taskId, writePaths, t0 })
    const exec = () => runLaneExecution({
      taskId, laneStore, sysPrompt,
      signal: subController.signal, writePaths, t0, onTool, laneOptions,
    })
    if (runInBackground) {
      const promise = exec()
      // 登记含 sysPrompt/laneStore/lineage/laneOptions：resume 复用会话与血缘
      // （laneOptions 保证续跑沿用同一 tools/skills 白名单），级联取消查 parent
      pendingSubAgents.set(taskId, {
        status: 'running', promise, laneStore, sysPrompt, lineage, laneOptions,
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
    // workflow 引擎依赖注入：registry 暴露给工作流 tool/document 节点
    tools,
    // subagent 体系：Agent/Task 工具能力 + 后台任务登记
    spawnSubAgent,
    taskSystem,
    pendingSubAgents,
    // Agent 工具被禁用时（--disallowedTools Agent）子 Agent 区块不入提示词
    agents: opts.disallowedTools?.includes('Agent') ? [] : agents,
    setSystemPrompt(p) { systemPrompt = p || '' },
    // loop --fresh：请求面从当前消息条数起裁剪（transcript 继续记录）
    setFreshWindow,
    // loop --until 模型判定：小 maxTokens 无工具请求，判定目标是否达成
    // 返回 { done, reason, error }（error=true 时 done 恒 false，cli 据此停 loop）
    async judgeUntil({ target, maxTokens = 512, signal: s = signal }) {
      const history = deriveHistory().slice(-20)
      const judgeMsgs = [
        { role: 'system', content: '你是目标达成判定器。根据对话历史判断目标是否已达成。只输出一个 JSON 对象：{"done":true|false,"reason":"一句话理由"}' },
        ...history,
        { role: 'user', content: `目标：${target}\n请判定该目标在当前对话中是否已达成，只输出 JSON。` },
      ]
      let out = ''
      try {
        for await (const chunk of streamMessages({
          model: opts.model || getProvider().model || '',
          messages: judgeMsgs,
          maxTokens,
          signal: s?.rawSignal || s,
          tools: [],
        })) {
          if (chunk.type === 'text') out += chunk.text
        }
      } catch (err) {
        return { done: false, reason: `判定请求失败：${err?.message || String(err)}`, error: true }
      }
      const m = out.match(/\{[\s\S]*\}/)
      try {
        const j = JSON.parse(m ? m[0] : '{}')
        return { done: j.done === true, reason: String(j.reason || ''), raw: out.slice(0, 200) }
      } catch {
        return { done: /达成|完成|通过|已满足|success|done|yes|true/i.test(out), reason: out.slice(0, 120), raw: out.slice(0, 200) }
      }
    },
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
      let outcome
      try {
        const { usage, model: turnModel, text } = await runTurnInternal({ content })
        outcome = { usage, model: turnModel, text }
      } catch (e) {
        // 用户取消（Stop 按钮/打断插入，契约 §8）原样上抛 → cli 输出「已取消。」+ result
        // 收尾、进程保留可续聊。不落入下方"内部错误"兜底——AbortError 是有意信号，
        // 吞掉会让取消轮只剩半截文本、UI 无收尾确认（Stop 按钮体验依赖此路径）。
        if (e?.name === 'AbortError') throw e
        // 全局兜底：turn 内部任何未捕获异常（模型流/审批/压缩等）都不得中断会话。
        // 回填错误文本作为本轮结果，会话日志保留（transcript 权威源仍可回溯），
        // 后续轮次照常继续——消灭"失败后断"。错误文本必须 wire.assistant 发出：
        // session 模式下 pushMemory 是 no-op（不入 transcript），只发 result 会让
        // GUI 收到"无任何内容的结果"，界面表现为静默卡死（用户侧无法区分忙/死）。
        const errMsg = e?.message || String(e)
        const errText = `【系统】本轮执行出现内部错误：${errMsg}（会话已保留，可继续对话或重试）`
        pushMemory({ role: 'assistant', content: `【系统】本轮执行出现内部错误：${errMsg}` })
        try { wire.assistant([{ type: 'text', text: errText }]) } catch { /* 事件流异常不再掩盖原错误 */ }
        outcome = { usage: null, model: opts.model || process.env.ANTHROPIC_MODEL || '', text: errText }
      }
      const durationMs = Date.now() - t0
      // turnStats 每轮尾部产出（health/result/stats 共用）
      turnStats.push({ usage: outcome.usage, durationMs, model: outcome.model, ts: new Date().toISOString(), compactCount: session ? session.compactCount() : 0 })
      health?.record(turnStats[turnStats.length - 1])
      // result 事件由 engine 发出（含 duration_ms；cli 不再重复 emit）
      wire.result(outcome.usage, { duration_ms: durationMs })
      return { usage: outcome.usage, model: outcome.model, text: outcome.text, durationMs }
    },
  }
}
