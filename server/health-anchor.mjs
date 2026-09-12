// 锚定生效路由的纯函数封装（便于单测，避免起真桥）。
// 语义：前端用户点了「重新锚定」并已发送锚点 → 上报内核把对应证据标记为已解决
// （markFidelityResolved → 失真档立即回绿 + 进入观察期）。bridge 只做"校验 + 转发"，
// 判定逻辑全在内核（前端上报不是真值来源，只是"用户已处理"的信号）。
export const MAX_ISSUE_IDS = 50
export const MAX_ID_LEN = 120

/**
 * 构造内核 stdin 消息；sessionId 缺失时返回 null（路由据此回 400）。
 * issueIds 容错清洗：非数组按空、去重、剔除非字符串/空串、单条限长、总量限 50。
 */
export function buildAnchorApplied(sessionId, issueIds) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!sid) return null
  const list = []
  if (Array.isArray(issueIds)) {
    for (const raw of issueIds) {
      if (typeof raw !== 'string') continue
      const id = raw.trim().slice(0, MAX_ID_LEN)
      if (!id || list.includes(id)) continue
      list.push(id)
      if (list.length >= MAX_ISSUE_IDS) break
    }
  }
  return { sessionId: sid, message: { type: 'anchor_applied', issueIds: list } }
}
