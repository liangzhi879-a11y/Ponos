// 流式运行支撑（原 engine.mjs 中部，P1-6 拆出）：usage 记账、可中断 sleep/退避与重发、
// 工具超时包装、聚合结果预算、空闲看门狗、输出档位与 effort 归一。
// 性质：纯函数/小工厂，不触碰 createEngine 闭包状态，故可独立成模块。
import { classifyApiError, deadStreamError, streamMessages } from './api.mjs'
import { STREAM_FIRST_BYTE_MS, STREAM_IDLE_MS, adaptiveFirstByteMs } from './engine-config.mjs'


// usage 逐次累加（input/output/cache 各字段），修复"多次 API 调用只记最后一次"
export function addUsage(acc, u = {}) {
  const out = { ...acc }
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    out[k] = (acc[k] ?? 0) + (u[k] ?? 0)
  }
  return out
}

// usage 是否有实质计数（空对象 / 全零视为无用量，不写 transcript）
export function hasUsage(u = {}) {
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) > 0
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// 可中断退避（2026-09-12）：重试退避 0.5/1/2/4s（见 retryDelayMs）期间收到取消必须
// 立刻结束等待——旧实现睡满才醒，用户按停止键后内核仍攥着定时器，取消要等整个退避
// 走完才可见（观感：停止键不灵）。非标准 signal / 无 signal 退化为普通 sleep。
export function sleepAbortable(ms, signal) {
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

// 思考深度档位规范化（导出供测试）：自有统一档位体系（off/low/high/max/auto）。
// off/low/high/max 原样；medium → high（DeepSeek 旧映射，规避端点不识 medium）；
// auto / 空 / 未知 → null（不注入任何字段，交给模型原生自适应——DeepSeek 默认
// high、agent 场景自动 max；需要钉死档位时显式设 PONOS_REASONING_EFFORT=max）
export function normalizeEffort(value) {
  const v = String(value ?? 'auto').trim().toLowerCase()
  if (v === 'off' || v === 'low' || v === 'high' || v === 'max') return v
  if (v === 'medium') return 'high'
  return null
}

// P0-1 重试退避：指数 + 25% jitter（抖动避免同步风暴）
export function retryDelayMs(attempt) {
  return 500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250)
}

// P0-1：流式请求重试——仅对"首块前失败"的瞬时/限流错误退避重试（已流出的文本
// 不重复，避免用户看到两次内容），abort/quota/auth/context-window 直接抛（engine
// 上层各有处理）。mock 模式默认不重试（测试确定性），可经 PONOS_MOCK_API_RETRIES 覆盖。
export async function* retryStream({ model, messages, maxTokens, signal, tools, reasoningEffort = null }) {
  const isMock = process.env.PONOS_MOCK_API === '1'
  const configured = process.env.PONOS_MOCK_API_RETRIES
  const maxRetries = configured !== undefined
    ? Number(configured)
    : (isMock ? 0 : Number(process.env.PONOS_API_RETRIES || 5))
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
      await sleepAbortable(retryDelayMs(attempt), signal)
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

// P0-3b 单消息聚合预算（2026-09-12 对标：单消息 200K token 聚合 / 双上限
// 50KB+2000 行）。纯函数：不改入参；持久化动作由调用方注入（persist(content, idx)
// 返回替换 stub）。按大小降序替换，直到合计 ≤ budget；Read（toolNames[i]==='Read'）
// 豁免（模型显式索要的文件内容不 stub，同 P0-3 语义）。
export function applyAggregateResultBudget(results, toolNames, { budgetChars, persist }) {
  const budget = Number(budgetChars) > 0 ? Number(budgetChars) : Infinity
  const total = results.reduce((s, r) => s + String(r?.content ?? '').length, 0)
  if (total <= budget) return results
  const out = results.map((r) => ({ ...r }))
  let excess = total - budget
  let replaced = false
  const order = out.map((_, i) => i)
    .sort((a, b) => String(out[b]?.content ?? '').length - String(out[a]?.content ?? '').length)
  for (const i of order) {
    if (excess <= 0) break
    if (toolNames && toolNames[i] === 'Read') continue
    const before = String(out[i]?.content ?? '').length
    const stub = persist(String(out[i]?.content ?? ''), i)
    const after = String(stub ?? '').length
    if (after < before) {
      excess -= before - after
      out[i] = { ...out[i], content: stub }
      replaced = true
    }
  }
  return replaced ? out : results
}

// 取真实 AbortSignal：engine 的轮次级 signal 是自定义包装对象（rawSignal getter
// 暴露真 AbortSignal，见 runTurn）；undici fetch 与 AbortSignal.any 都要求真实例。
// 非 AbortSignal → null（调用方自行降级为不合并）。
export function rawAbortSignal(s) {
  if (!s || typeof s !== 'object') return null
  if (s.rawSignal instanceof AbortSignal) return s.rawSignal
  return s instanceof AbortSignal ? s : null
}

// 流式空闲看门狗工厂：ms>0 时开启，流内块间隔超 ms → tripped=true 并 abort
// controller（下层 fetch 随即拒绝 → 调用方按"内部挂起"收尾）；ms<=0（守卫关闭）
// 时全 no-op。调用方须在流结束后 stop()（防 timer 泄漏）。
// 两阶段窗口（2026-09-09）：首个 chunk 前按 firstByteMs 宽限（prefill 正常形态），
// 首个 chunk 后按 ms 判生成停顿。firstByteMs 缺省退化为 ms（行为与旧版一致）。
//
// K1.3 惰性首字节窗口（2026-09-13 系统性优化）：`firstByteMs` 允许传**提供者**（函数），
// 只在「已等到 ms」时才求值——正常首字节（绝大多数请求）永不触发那次
// `JSON.stringify(requestMessages())`（实测 1.2–1.9ms/次 @ 真机请求面 273–295KB；
// 长历史 1.3MB ⇒ 9.2ms；随历史线性增长，故历史越长越值得省）。
//   · 语义等价的依据：engine 侧提供者 = `adaptiveFirstByteMs(...)`，其返回值只可能是
//     `baseMs`（= STREAM_FIRST_BYTE_MS = ms = STREAM_IDLE_MS）或 `600_000`，**恒 ≥ ms**
//     ⇒ 「等到 ms 再求值」只可能**延后** trip，不可能提前掐断。
//   · 传常量时（含 `firstByteMs < ms` 的历史用法）行为与旧版**逐字一致**：阈值、
//     检查门槛、timer 周期三者都仍按常量算。
//   · 提供者抛错 ⇒ 退回 ms（不给底层 setInterval 抛穿的机会——那会变成进程级异常）。
export function makeIdleWatchdog(ms, firstByteMs) {
  if (!ms || ms <= 0) return { controller: null, tripped: false, tick() {}, stop() {} }
  const lazy = typeof firstByteMs === 'function'
  const constFirst = lazy ? null : firstByteMs
  const constMs = (constFirst && constFirst > 0) ? constFirst : ms
  // 「何时才需要知道真实阈值」：常量直接取 min（与旧版一致）；提供者则等到 ms——
  // 由上面的恒 ≥ ms 保证不早于应有阈值。
  const gateMs = lazy ? ms : Math.min(ms, constMs)
  let resolved = lazy ? null : constMs
  const firstThreshold = () => {
    if (resolved !== null) return resolved
    try {
      const v = Number(firstByteMs())
      resolved = (v && v > 0) ? v : ms
    } catch { resolved = ms }
    return resolved
  }
  const controller = new AbortController()
  const state = { tripped: false, gotData: false, last: Date.now() }
  const timer = setInterval(() => {
    if (state.tripped) return
    const elapsed = Date.now() - state.last
    if (state.gotData) {
      if (elapsed >= ms) { state.tripped = true; controller.abort() }
      return
    }
    if (elapsed >= gateMs && elapsed >= firstThreshold()) { state.tripped = true; controller.abort() }
  }, lazy ? Math.min(ms, 5000) : Math.min(ms, constMs, 5000))
  if (timer.unref) timer.unref()
  return {
    controller,
    get tripped() { return state.tripped },
    tick() { state.gotData = true; state.last = Date.now() },
    stop() { clearInterval(timer) },
  }
}
