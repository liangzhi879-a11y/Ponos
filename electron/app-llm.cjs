// 应用智控：模型调用（Task 3.1 的 `callLlm` 真实实现）
//
// ★ 架构（收敛到内核单一真源）：本文件只做两件事——
//   ① 读 $YFW_HOME/config.json 的 activeProvider（loadProvider：纯配置读取，不 require 内核）；
//   ② 把一次「system + user → 文本」的调用转交内核 kernel/api.mjs 的 `streamMessages()`。
//   Anthropic SSE 解析（含 thinking_delta）、流内 error 事件、空流（DeadStream）判定、错误
//   分类、思考开关（内核 effortParam）全部继承内核实现，主进程不再维护第二套客户端。
//
//   历史漂移的实际代价（本文件自建客户端时）：parseDelta 只认 text_delta、**完全忽略
//   thinking_delta**；而当前 provider（api.deepseek.com/anthropic）默认开思考 ⇒ 思考增量
//   吃满 max_tokens 后正文为 0，上层只能报「模型没有输出任何文本」，用户侧表现为生成段
//   整体失败且无从诊断。收敛后这类问题由内核单点修复。
//
//   旧顶部注释「内核 streamMessages 跑在内核进程里、主进程 import 不到（打包产物也不含
//   kernel/ 源码）」已被证伪：工作区与发布形态 release/YFWorking/ 下 electron/ 与 kernel/
//   均平级存在（release/YFWorking/kernel/api.mjs 确实存在）⇒ 这里按 ../kernel/api.mjs
//   动态加载。用 `await import()` 而非顶部 require 的原因：app-websearch.cjs 只借本文件的
//   authHeaders/loadProvider（注释里明确「不 require kernel」），把内核塞进顶部依赖会连带
//   加载整个内核模块图；动态加载把这份代价压到真正调模型的那一刻。
'use strict'
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { resolveYfwHome } = require('../server/yfw-home.cjs')

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_TIMEOUT_MS = 180000
const DEFAULT_MAX_TOKENS = 8000

/** 读取激活 provider；返回结构化结果而非抛错（调用方要能给出人话提示） */
function loadProvider({ home } = {}) {
  const file = join(home || resolveYfwHome(), 'config.json')
  let cfg
  try {
    cfg = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (e) {
    return { ok: false, error: `读不到模型配置（${file}）：${String(e?.message || e)}` }
  }
  const list = Array.isArray(cfg.providers) ? cfg.providers : []
  const active = list.find((p) => p?.id === cfg.activeProvider) || list[0]
  if (!active) return { ok: false, error: `模型配置里没有可用 provider（${file}）` }
  const baseUrl = String(active.apiBaseUrl || '').replace(/\/+$/, '')
  const authToken = String(active.authToken || '')
  if (!baseUrl || !authToken) {
    return { ok: false, error: `provider「${active.id || '?'}」缺少 apiBaseUrl 或 authToken，请在应用设置里补全` }
  }
  const model = String(active.primaryModel || active.model || '')
  if (!model) return { ok: false, error: `provider「${active.id || '?'}」未配置模型名（primaryModel）` }
  return { ok: true, provider: { id: active.id, baseUrl, authToken, authScheme: active.authScheme, model } }
}

/** 与 kernel/provider.mjs:18-25 同口径 */
function authHeaders(provider = {}) {
  const token = String(provider.authToken || '')
  if (String(provider.authScheme || '').toLowerCase() === 'bearer') {
    return { authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}` }
  }
  return { 'x-api-key': token }
}

// 以下 parseDelta / textFromWholeBody **已不参与真实调用链路**（内核 createAnthropicParser
// 接管了协议解析），但仍是本模块的对外导出契约（既有测试与诊断脚本按名引用），故原样保留。
// 新增的解析行为请只改内核，勿在此复制第二份（这正是本次收敛要消灭的形态）。

/** 从一行 SSE 数据里抠出增量文本；返回 {text, done, error} */
function parseDelta(line) {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return payload === '[DONE]' ? { done: true } : null
  let j
  try {
    j = JSON.parse(payload)
  } catch {
    return null
  }
  if (j.type === 'error') return { error: String(j.error?.message || JSON.stringify(j.error || {})) }
  if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') return { text: String(j.delta.text || '') }
  const oa = j.choices?.[0]?.delta?.content
  if (typeof oa === 'string') return { text: oa }
  if (j.type === 'message_stop') return { done: true }
  return null
}

/** 非流式响应体 → 文本（有的网关忽略 stream 参数直接回整个 JSON） */
function textFromWholeBody(text) {
  try {
    const j = JSON.parse(text)
    if (Array.isArray(j.content)) return j.content.filter((c) => c?.type === 'text').map((c) => c.text).join('')
    const oa = j.choices?.[0]?.message?.content
    if (typeof oa === 'string') return oa
  } catch {
    /* 不是 JSON，交给调用方当错误处理 */
  }
  return ''
}

// —— 内核模块懒加载（单例；动态 import 见文件头说明） ——
let kernel = null
async function loadKernel() {
  if (!kernel) {
    const [api, provider] = await Promise.all([
      import('../kernel/api.mjs'),
      import('../kernel/provider.mjs'),
    ])
    kernel = { api, provider }
  }
  return kernel
}

// streamMessages 有两道互不相干的可用性判据，必须同时满足：
//   ① 守卫 detectProtocol() 只读 process.env 的 base url（纯 env 契约，内核自己的
//      api-protocol.test.mjs 依赖这一点）；该 env 名**跨内核版本漂移**：工作区 kernel 用
//      PONOS_BASE_URL，发布目录 release/YFWorking/kernel 用 ANTHROPIC_BASE_URL（实测漏补
//      后者时报「内核：未检测到可用协议（需 ANTHROPIC_BASE_URL）」）⇒ 两个名字都补；
//   ② 真身取值走 kernel/provider.mjs 的 registry（anthropicStream 内 getProvider() =
//      state.active || envProvider()），与 env 名无关——setProvider 已播种，故 env 只需
//      「存在」即可过守卫，补进去的是真实 baseUrl。
// 故调用前 setProvider(...) 播种 registry，env 为空时临时补 base url 过守卫。
// 并发/重入安全：env 用嵌套计数配对，只有「本模块确实写过 env」且「最后一个持有者退出」
// 时才恢复——否则 A 调用恢复 env 的瞬间会把并发 B 调用的守卫打空（detectProtocol 返 null
// 直接抛错）。绝不把守卫 env 永久留在 process.env 里。
const GUARD_ENV_KEYS = ['PONOS_BASE_URL', 'ANTHROPIC_BASE_URL']
let envHolders = 0
const envSeeded = new Map()
function acquireEnvSeed(env, baseUrl) {
  envHolders += 1
  for (const key of GUARD_ENV_KEYS) {
    if (!env[key]) {
      env[key] = baseUrl
      envSeeded.set(key, baseUrl)
    }
  }
}
function releaseEnvSeed(env) {
  envHolders = Math.max(0, envHolders - 1)
  if (envHolders > 0) return
  for (const [key, value] of envSeeded) {
    if (env[key] === value) delete env[key]
  }
  envSeeded.clear()
}

/**
 * 无正文时的**可诊断**错误：把 stop_reason / usage / 思考字符数一并带出，让「思考占满
 * max_tokens」与「网关无输出」在文案上就分得开（旧文案「模型没有输出任何文本」两者同形，
 * 排查只能靠手写探针）。
 */
function noTextError({ stopReason = null, usage = null, thinkingChars = 0 } = {}) {
  const diag = [
    `stop_reason=${stopReason === null || stopReason === undefined ? 'null' : stopReason}`,
    usage ? `输出 token=${usage.output_tokens}` : '未收到 usage',
    `思考 ${thinkingChars} 字符`,
  ].join('，')
  const cause = thinkingChars > 0
    ? (stopReason === 'max_tokens'
      ? '思考内容吃满 max_tokens、正文被挤没（本调用默认关思考；仍复现请提高 max_tokens）'
      : '只收到思考内容、正文为空')
    : '流内既无思考也无正文，疑似网关无输出'
  return `模型没有输出任何文本（${diag}；${cause}）`
}

// 非流式网关兜底：内核 protocolStream 要求 res.body 可读，忽略 stream 参数直接回整段 JSON
// 的网关会被它判成 `内核：API 请求失败 200 <响应体>`。这里从该文案里把响应体取回来交给
// textFromWholeBody——保持收敛前「非流式网关也能拿到文本」的行为，不新增第二套解析逻辑。
const NON_STREAM_KERNEL_ERROR_RE = /^内核：API 请求失败 200 ([\s\S]+)$/
function textFromNonStreamKernelError(kernelMsg) {
  const m = NON_STREAM_KERNEL_ERROR_RE.exec(String(kernelMsg || ''))
  return m ? textFromWholeBody(m[1]) : ''
}

/**
 * 调模型拿一段文本（流式，边收边回调）。实现 = 内核 streamMessages 单一真源。
 *
 * 对外契约（保持不变）：
 *   @param {{system?:string, user?:string, onDelta?:Function, maxTokens?:number, timeoutMs?:number,
 *            provider?:object, fetchImpl?:Function}} opts
 *     fetchImpl：测试注入点——内核 protocolStream 走裸 fetch（globalThis.fetch），故传入时
 *     临时替换 globalThis.fetch 并在 finally 恢复；生产路径（不传）不做任何全局替换。
 *   追加的可选参数（均有默认值）：
 *     thinkingMode：'off' 默认 **关思考**。生成链路只要稳定 JSON，不需要思考；当前 provider
 *       （deepseek anthropic 端点）默认开思考，思考增量会吃满输出预算导致正文为 0。
 *     reasoningEffort：内核档位（low|high|max|off）。调用方显式传 thinkingMode 或
 *       reasoningEffort 时一律尊重调用方，不再强制关思考。
 *   @returns {Promise<{ok:boolean, text:string, error:string|null, chars:number}>}
 *     - 失败时若已收到半截文本则如实返回（ok:false 但 text 保留）；
 *     - 超时文案仍是「模型调用超时（Ns）」；
 *     - provider 传入时优先于配置文件。
 */
async function callLlmStream(opts = {}) {
  const { system, user, onDelta, maxTokens, timeoutMs, provider, fetchImpl } = opts
  const resolved = provider ? { ok: true, provider } : loadProvider()
  if (!resolved.ok) return { ok: false, text: '', error: resolved.error, chars: 0 }
  const p = resolved.provider
  if (!p.model) return { ok: false, text: '', error: 'provider 未配置模型名', chars: 0 }

  // 默认关思考；调用方显式给了 thinkingMode / reasoningEffort 就按其意愿走（例如诊断探针要
  // 观察思考流）。用 hasOwnProperty 而非真值判断：thinkingMode:null 也是「显式不干预」。
  const hasOwn = (k) => Object.prototype.hasOwnProperty.call(opts, k)
  const thinkingMode = hasOwn('thinkingMode') ? opts.thinkingMode : (hasOwn('reasoningEffort') ? null : 'off')
  const reasoningEffort = hasOwn('reasoningEffort') ? (opts.reasoningEffort ?? null) : null

  let mods
  try {
    mods = await loadKernel()
  } catch (e) {
    return { ok: false, text: '', error: `加载内核模型客户端失败：${String(e?.message || e)}`, chars: 0 }
  }
  // 播种 registry（② 真身取值来源）。authScheme 先归一到内核允许的两个值，避免配置文件里
  // 出现 'Bearer' 这类大小写变体时 setProvider 直接抛错。
  try {
    mods.provider.setProvider({
      baseUrl: p.baseUrl,
      authToken: p.authToken,
      model: p.model,
      authScheme: String(p.authScheme || '').toLowerCase() === 'bearer' ? 'bearer' : 'x-api-key',
    })
  } catch (e) {
    return { ok: false, text: '', error: `provider 配置不可用：${String(e?.message || e)}`, chars: 0 }
  }

  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') return { ok: false, text: '', error: '当前运行环境没有 fetch', chars: 0 }

  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ac.abort() }, timeout)
  const swapFetch = typeof fetchImpl === 'function'
  const prevFetch = swapFetch ? globalThis.fetch : null
  if (swapFetch) globalThis.fetch = fetchImpl
  const env = process.env
  let text = ''
  let thinkingChars = 0
  let usage = null
  let stopReason = null
  try {
    acquireEnvSeed(env, p.baseUrl)
    const stream = mods.api.streamMessages({
      model: p.model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      maxTokens: maxTokens || DEFAULT_MAX_TOKENS,
      signal: ac.signal,
      reasoningEffort,
      thinkingMode,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text') {
        text += chunk.text
        onDelta?.(chunk.text, text.length)
      } else if (chunk?.type === 'thinking') {
        thinkingChars += String(chunk.text || '').length
      } else if (chunk?.type === 'usage') {
        usage = chunk.usage
      } else if (chunk?.type === 'stop_reason') {
        stopReason = chunk.reason ?? null
      }
    }
    if (!text) return { ok: false, text: '', error: noTextError({ stopReason, usage, thinkingChars }), chars: 0 }
    return { ok: true, text, error: null, chars: text.length }
  } catch (e) {
    const isTimeout = timedOut || e?.name === 'AbortError'
    const msg = isTimeout ? `模型调用超时（${Math.round(timeout / 1000)}s）` : String(e?.message || e)
    if (!isTimeout && !text) {
      const whole = textFromNonStreamKernelError(msg)
      if (whole) {
        onDelta?.(whole, whole.length)
        return { ok: true, text: whole, error: null, chars: whole.length }
      }
    }
    // 已有部分文本时如实返回：让界面能展示「收到一半就断了」，而不是整段丢弃
    return { ok: false, text, error: msg, chars: text.length }
  } finally {
    clearTimeout(timer)
    releaseEnvSeed(env)
    if (swapFetch) globalThis.fetch = prevFetch
  }
}

module.exports = {
  callLlmStream, loadProvider, authHeaders, parseDelta, textFromWholeBody,
  ANTHROPIC_VERSION, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_TOKENS,
}
