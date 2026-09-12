// kernel/log.mjs —— 内核结构化日志（docs/production/reliability.md R5-1）
// 输出 stderr（stdout 是 NDJSON 契约通道，日志不得污染）。级别过滤经
// CLAUDE_CODE_LOG_LEVEL（fatal/error/warn/info/debug），默认 info。
// S2-1：error/fatal/warn 的 err 消息落日志前脱敏（日志不泄密钥）。
import { redactText } from './redact.mjs'
const LEVELS = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4 }

// 第二参既可能是 Error/字符串，也可能是结构化对象（如 cli.mjs 的
// { pid, prevTs, exitCode, err }）。旧实现一律走 String(err)，结构化对象被压成
// "[object Object]"——崩溃根因（恰恰是该埋点的目的）当场丢失，实测 4 次崩溃日志
// 全是这四个字。此处按类型分派：字符串/Error 归一为 { err }，普通对象保留全字段
// 并对敏感文本脱敏（v instanceof Error 取 message，避免嵌套对象再被序列化丢信息）。
function normalizeLogExtra(errOrExtra) {
  if (errOrExtra == null || errOrExtra === '') return {}
  if (typeof errOrExtra === 'string') return { err: redactText(errOrExtra) }
  if (errOrExtra instanceof Error) return { err: redactText(errOrExtra.message || String(errOrExtra)) }
  if (typeof errOrExtra === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(errOrExtra)) {
      out[k] = v instanceof Error ? (v.message || String(v)) : v
    }
    for (const k of ['err', 'message', 'stack', 'detail']) {
      if (typeof out[k] === 'string') out[k] = redactText(out[k])
    }
    return out
  }
  return { err: redactText(String(errOrExtra)) }
}

export function createLogger({ sink = process.stderr, level = '', sid = '' } = {}) {
  const min = LEVELS[level] ?? 3
  return {
    log(lvl, msg, extra = {}) {
      if ((LEVELS[lvl] ?? 3) > min) return
      try {
        // extra 在前、核心字段在后：调用方的 extra 不得覆写 ts/level/sid/msg
        //（否则 extra.ts 会顶掉日志自身时间戳，排障时时间线错乱）
        sink.write(JSON.stringify({ ...extra, ts: new Date().toISOString(), level: lvl, sid, msg }) + '\n')
      } catch { /* stderr 已关闭 */ }
    },
    fatal(msg, err) { this.log('fatal', msg, normalizeLogExtra(err)) },
    error(msg, err) { this.log('error', msg, normalizeLogExtra(err)) },
    warn(msg, err) { this.log('warn', msg, normalizeLogExtra(err)) },
    info(msg, extra) { this.log('info', msg, extra) },
    debug(msg, extra) { this.log('debug', msg, extra) },
  }
}
