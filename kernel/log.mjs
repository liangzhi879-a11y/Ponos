// kernel/log.mjs —— 内核结构化日志（docs/production/reliability.md R5-1）
// 输出 stderr（stdout 是 NDJSON 契约通道，日志不得污染）。级别过滤经
// CLAUDE_CODE_LOG_LEVEL（fatal/error/warn/info/debug），默认 info。
// S2-1：error/fatal/warn 的 err 消息落日志前脱敏（日志不泄密钥）。
import { redactText } from './redact.mjs'
const LEVELS = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4 }

export function createLogger({ sink = process.stderr, level = '', sid = '' } = {}) {
  const min = LEVELS[level] ?? 3
  return {
    log(lvl, msg, extra = {}) {
      if ((LEVELS[lvl] ?? 3) > min) return
      try {
        sink.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, sid, msg, ...extra }) + '\n')
      } catch { /* stderr 已关闭 */ }
    },
    fatal(msg, err) { this.log('fatal', msg, err ? { err: redactText(err?.message || String(err)) } : {}) },
    error(msg, err) { this.log('error', msg, err ? { err: redactText(err?.message || String(err)) } : {}) },
    warn(msg, err) { this.log('warn', msg, err ? { err: redactText(err?.message || String(err)) } : {}) },
    info(msg, extra) { this.log('info', msg, extra) },
    debug(msg, extra) { this.log('debug', msg, extra) },
  }
}
