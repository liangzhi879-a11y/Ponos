// YFW-turbo 会话持久化（docs/bridge-contract.md §7/§8：transcript 为权威源 + --resume 恢复）
// ---------------------------------------------------------------------------
// transcript 文件位置与 server/transcript.mjs 的约定一致（跨层契约，GUI 直接
// 经 bridge /transcript/load 读取）：
//   <CLAUDE_CONFIG_DIR ?? ~/.yfworking>/projects/<sanitize(cwd)>/<sessionId>.jsonl
// 每行一个 NDJSON entry：{ type: user|assistant, id, timestamp, message }。
// 同一文件既供 GUI 展示（transcriptAdapter.entriesToMessages 转换），也供内核
// --resume 时恢复 messages 历史（单一事实源）。
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const MAX_SANITIZED_LENGTH = 200

// 与 server/transcript.mjs sanitizePathSegment 同算法：非字母数字 → '-'，
// 超 200 字符截断并追加 md5 前 12 位 hex。
export function sanitizeSegment(name) {
  const s = String(name ?? '').replace(/[^a-zA-Z0-9]/g, '-')
  if (s.length <= MAX_SANITIZED_LENGTH) return s
  const hash = createHash('md5').update(String(name)).digest('hex').slice(0, 12)
  return `${s.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

export function newSessionId() {
  return randomUUID()
}

export function createSessionStore({ configDir, cwd, sessionId }) {
  const dir = join(configDir, 'projects', sanitizeSegment(cwd))
  const file = join(dir, `${sessionId}.jsonl`)
  return {
    file,
    // 读全量 entry（跳过损坏行）。resume 恢复历史用；GUI 经 bridge 读取同文件
    load() {
      if (!existsSync(file)) return []
      const entries = []
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        try { entries.push(JSON.parse(t)) } catch { /* 跳过损坏行 */ }
      }
      return entries
    },
    // 追加一条 entry（user/assistant 轮次记录）
    append(entry) {
      try {
        mkdirSync(dir, { recursive: true })
        appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8')
      } catch { /* 磁盘不可写不致命：内存历史仍可用 */ }
    },
    // 组装一条 user entry（与内核/GUI 契约形状一致）
    userEntry(content, extra = {}) {
      return {
        type: 'user',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: String(content ?? '') },
        ...extra,
      }
    },
    // 组装一条 assistant entry（content 块数组；usage/model 由 engine 提供）
    assistantEntry(blocks, { usage, model } = {}) {
      const entry = {
        type: 'assistant',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: blocks },
      }
      if (usage) entry.message.usage = usage
      if (model) entry.message.model = model
      return entry
    },
  }
}
