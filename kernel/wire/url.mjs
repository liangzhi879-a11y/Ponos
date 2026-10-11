// kernel/wire/url.mjs —— 端点 URL 归一与协议判定（**纯函数，跨层唯一真源**）
// ---------------------------------------------------------------------------
// 为什么单独成模块：本仓已有三处各自硬编码端点拼接（内核 api.mjs、桥 provider-probe.mjs、
// 桥 title-gen.mjs），协议知识一旦分散就必然漂移（title-gen.mjs 注释里那个 `/v1/v1/...`
// 双段 404 就是同一病灶的实证）。此处收成一份，桥侧以后直接 import 复用。
//
// 基址约定（本仓事实，务必先读懂）：
//   ・内核既有行为是 `base + '/v1/messages'`，而**用户配置的 apiBaseUrl 自带协议前缀**
//     （默认 `https://api.deepseek.com/anthropic`）⇒ 实际请求 `/anthropic/v1/messages`。
//   ・但用户从 OpenAI 兼容文档 / 教程抄来的基址**常带 `/v1`**（本地 vLLM 更常见），
//     若直接 `base + '/v1/chat/completions'` 就会拼出 `/v1/v1/...` → 404。
//   ⇒ 故 anthropic 路径**原样保留** `base + '/v1/messages'`（零回归，不动既有语义），
//     而 openai 路径一律从 `rootOf(base)` 拼装（先剥尾缀再加 `/v1`）。

/** 去掉尾部斜杠（用户手填常带）。 */
export function trimSlashes(u) {
  return String(u || '').trim().replace(/\/+$/, '')
}

/**
 * 剥掉用户可能自己带上的协议尾缀（`/anthropic`、`/anthropic/v1`、`/v1`），得到"根地址"。
 * 与 `server/provider-probe.mjs#modelMetaUrlCandidates` 的剥法同一约定。
 */
export function rootOf(baseUrl) {
  return trimSlashes(baseUrl).replace(/(?:\/anthropic(?:\/v1)?|\/v1)$/i, '')
}

/**
 * Anthropic Messages 端点。
 * ★ **刻意不做 rootOf**：既有内核行为就是 `base + '/v1/messages'`（base 含 `/anthropic`
 * 时得到 `/anthropic/v1/messages`），改动它会直接造成 Anthropic 路径回归。
 */
export function anthropicStreamUrl(baseUrl) {
  return trimSlashes(baseUrl) + '/v1/messages'
}

/**
 * OpenAI Chat Completions 端点：`<root>/v1/chat/completions`。
 * 一律从 root 拼装（防 `/v1/v1` 双段 404，见文件头注）。
 */
export function openaiStreamUrl(baseUrl) {
  return rootOf(baseUrl) + '/v1/chat/completions'
}

// 本机/本地判据**刻意不在此实现**：`server/provider-profile.mjs#resolveProviderProfile`
// 与 `src/lib/providerProfileUi.ts` 已各有一份且有 parity 测试锁定一致性。
// 协议判定也不依赖它（见 resolveApiFormat 的 auto 语义：不猜）。

export const API_FORMATS = ['auto', 'anthropic', 'openai']

/** 归一枚举值（未知/非法 → 'auto'）。供 GUI/bridge 兜底与 env 解析共用。 */
export function normalizeApiFormat(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return API_FORMATS.includes(s) && s !== 'auto' ? s : 'auto'
}

/**
 * 协议判定（**唯一决策点**）。返回 `'anthropic' | 'openai' | 'auto'`：
 *   ① 显式 `format`（provider.apiFormat）—— 非 auto 直接采用
 *   ② env `PONOS_API_FORMAT`（bridge 注入，与 GUI 同源）
 *   ③ 基址尾缀 `/anthropic`（含 `/anthropic/v1`）→ `anthropic`（本仓既有默认形状，强信号）
 *   ④ **其余一切（含本地画像、云域名）→ `auto`**
 *
 * ★ 为什么本地画像**不再直接判 openai**（2026-09-23 实测修正）：
 *   曾按"私有网段 → openai"推导，结果把本机上的 **Anthropic 兼容端点**（本地网关/代理，
 *   以及本仓既有测试用的 127.0.0.1 mock）全部误判成 OpenAI ⇒ 违反"零回归"硬指标（实测
 *   直接把 `api-empty-stream.test.mjs` 的正常流用例打成红：请求被送到 /v1/chat/completions）。
 *   教训与 `kernel/api.mjs#cacheMarkerEnabled` 同一纪律：**端点能力无法从地址推断**，
 *   猜错的代价是既有可用配置当场坏掉。
 *
 * `auto` 的语义（由 `streamMessages` 执行）：**先按今天的既有行为走 anthropic**（零回归），
 * 仅在"未产出任何 chunk + 协议级拒绝（404/405）"时回退 openai 一次，并把生效协议按 baseUrl
 * 记忆（同一进程内后续请求不再试错）。这样：本机 Anthropic 端点照旧直接成功；只支持
 * OpenAI 的本地 vLLM/Ollama 多付一次 404 往返后自动可用；云端行为与今天完全一致。
 */
/**
 * @param {{ format?: any, baseUrl?: any, env?: any }} [opts]
 */
export function resolveApiFormat({ format = 'auto', baseUrl = '', env = {} } = {}) {
  const explicit = String(format || 'auto').trim().toLowerCase()
  if (explicit === 'openai' || explicit === 'anthropic') return explicit
  const fromEnv = normalizeApiFormat(env.PONOS_API_FORMAT)
  if (fromEnv !== 'auto') return fromEnv
  const b = trimSlashes(baseUrl)
  if (!b) return 'anthropic'
  if (/\/anthropic(?:\/v1)?$/i.test(b)) return 'anthropic'
  return 'auto'
}

/**
 * 协议级拒绝判据：仅 404/405（路径/方法不存在）才算"这套协议这个端点不认"。
 * ★ 额外排除流中断类（StreamInterrupted / DeadStreamError）：那些是"已连上但中途失败"，
 *   即便其 error 意外携带了 status，也**不属于协议不匹配**——按协议回退重发会把半截输出
 *   重来一遍（与 anthropicStream 断流重连"宁可丢半截也不重复"的取舍纪律冲突）。
 *   真机上 HTTP 404 在 `protocolStream` 的 `!res.ok` 分支抛出（先于读流），本身无 name；
 *   这里的排除是为防御未来的错误包装方式，属加固而非权宜。
 */
export function isProtocolRejection(err) {
  const status = Number(err?.status)
  if (status !== 404 && status !== 405) return false
  if (err?.name === 'StreamInterrupted' || err?.name === 'DeadStreamError') return false
  return true
}
