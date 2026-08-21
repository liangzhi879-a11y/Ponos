// kernel/redact.mjs —— 敏感信息脱敏（docs/production/security.md S2-1）
// 磁盘 transcript / 日志在落盘前打码；内存模型输入（deriveMessages）保留原文。
// YFW_KEEP_SECRETS=1 时磁盘也保留（用户显式选择）。
const SECRET_PATTERNS = [
  // Bearer 优先：先吞整段 token，避免其尾部 sk- 被下一条 pattern 抢先打码
  /\b(Bearer\s+)[A-Za-z0-9\-._~+/]{8,}/gi,
  /(\bsk-)[A-Za-z0-9_-]{8,}/g,                  // OpenAI/Anthropic 风格 API key
  /(\bAKIA)[A-Z0-9]{16}\b/g,                    // AWS access key
  /(\b(?:api[_-]?key|auth[_-]?token|password|secret|token)\b\s*[:=]\s*["']?)[A-Za-z0-9_\-.]{8,}/gi,
]
const KEEP = () => process.env.YFW_KEEP_SECRETS === '1'

export function redactText(text) {
  if (typeof text !== 'string' || !text || KEEP()) return text
  let out = text
  // 每条 pattern 都带前缀捕获组；replace 回调第二参在无捕获组时是匹配偏移量，
  // 有捕获组时才是前缀字符串——统一以 (m, prefix) 解构取前缀（sk-/AKIA/Bearer /key=）。
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix) => (prefix || m.slice(0, 4)) + '***')
  }
  return out
}

export function redactEntry(entry) {
  if (KEEP() || !entry) return entry
  const msg = entry.message
  if (!msg) return entry
  // 不可变：返回脱敏副本，不修改原 entry（内存模型输入必须保留原文）
  if (typeof msg.content === 'string') {
    return { ...entry, message: { ...msg, content: redactText(msg.content) } }
  }
  if (Array.isArray(msg.content)) {
    const content = msg.content.map((b) => {
      if (!b) return b
      const nb = { ...b }
      if (typeof b.content === 'string') nb.content = redactText(b.content)
      if (typeof b.text === 'string') nb.text = redactText(b.text)
      if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
        try { nb.input = JSON.parse(redactText(JSON.stringify(b.input))) } catch { /* 保持原样 */ }
      }
      return nb
    })
    return { ...entry, message: { ...msg, content } }
  }
  return entry
}
