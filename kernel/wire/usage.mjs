// kernel/wire/usage.mjs —— usage 归一（**跨协议唯一真源**）
// ---------------------------------------------------------------------------
// 从 kernel/api.mjs 搬出（2026-09-23，OpenAI 协议兼容）：Anthropic 与 OpenAI 两个
// 解析器都要用它，而 wire/openai.mjs 不能反向 import api.mjs（会形成循环依赖）。
// 搬出后仍是**一份实现**——api.mjs 与 wire/openai.mjs 都 import 本模块。
//
// 三家形态（按回传字段区分，**不靠 baseUrl 猜**）：
//   ・Anthropic：`input_tokens` + `cache_read_input_tokens`（input **不含** read 部分）
//   ・DeepSeek 原生：`prompt_tokens` + `prompt_cache_hit_tokens`
//   ・OpenAI 形态：`prompt_tokens` + `prompt_tokens_details.cached_tokens`
//                 （Responses API 为 `input_tokens_details.cached_tokens`）
// 后两者的 `prompt_tokens` **都含**命中部分（hit 是它的子集）⇒ 归一到 Anthropic 语义时
// 必须把命中数从 input 里扣掉，否则命中部分被按全价再计一次（重叠计费、成本虚高）。
// 「含/不含」的判定只看用了哪个顶层字段：用 `prompt_tokens` 者一律含，用 `input_tokens` 者不含
// （Anthropic 官方语义），这样混合形态（`prompt_tokens` + 显式 cache_read）也能正确归位。
//
// 原始出处与三处合并对账记录见 kernel/api.mjs 的 P0-1 注释块（勿在此重复维护）。

export function normalizeUsage(u = {}) {
  const inputContainsCacheRead = u.input_tokens == null && u.prompt_tokens != null
  const promptTokens = u.input_tokens ?? u.prompt_tokens ?? 0
  const cacheReadRaw = u.cache_read_input_tokens
    ?? u.prompt_cache_hit_tokens
    ?? u.prompt_tokens_details?.cached_tokens
    ?? u.input_tokens_details?.cached_tokens
  const cacheCreateRaw = u.cache_creation_input_tokens
  const cacheRead = cacheReadRaw ?? 0
  return {
    input_tokens: inputContainsCacheRead ? Math.max(0, promptTokens - cacheRead) : promptTokens,
    output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreateRaw ?? 0,
    // ★ 存在性信号（与"值为 0"完全不同）：端点是否**上报**了缓存计量字段。
    //   必须先取原始值再兜 0 —— 顺序颠倒即销毁该信号。
    cache_fields_reported: cacheReadRaw !== undefined || cacheCreateRaw !== undefined,
  }
}
