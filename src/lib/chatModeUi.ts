// src/lib/chatModeUi.ts —— 会话模式过滤纯函数（Task 10 二级面板 chat/task 分流）
// 规则：被测模块零依赖——不 import zustand store、不用 '@' alias、只 import type。
// 语义：mode===undefined（旧数据/导入）按 task 对待（与 chatStore migrate v3 归一一致）。
// 2026-09-16（Task 4）：新增应用会话判据 isAppScoped / isPlainTaskLike——应用会话是 task 模式，
// 但**不属于任务面板**（否则每进一次应用页就在任务列表里多出一条"应用·xxx"）。
export interface ModeLike {
  mode?: 'chat' | 'task'
}

export function isChatLike(c: ModeLike): boolean {
  return c.mode === 'chat'
}

export function isTaskLike(c: ModeLike): boolean {
  return c.mode !== 'chat'
}

export interface AppScopedLike {
  /** 应用会话归属（见 src/types/index.ts 的 Conversation.appId） */
  appId?: string
}

/**
 * 是不是**应用会话**（Task 4「应用生成后自动质检」）。
 *
 * 为什么要有它：应用会话在 store 里就是 task 模式（chat 模式没有应用工具），于是它天然
 * 落进 `isTaskLike`——若不过滤，用户每进一次应用页，任务列表里就会多出一条（或复用后
 * 仍占位）"应用·xxx"，与 `getOrCreateAppConversation` 的"一个应用一个常驻会话"直接打架。
 * 判据只看"有没有 appId"，不依赖 mode（将来应用会话若改成别的模式也不会漏过滤）。
 */
export function isAppScoped(c: AppScopedLike): boolean {
  return typeof c.appId === 'string' && c.appId.trim() !== ''
}

/** 任务面板的入列判据：是任务会话 **且** 不是某个应用的专属会话 */
export function isPlainTaskLike(c: ModeLike & AppScopedLike): boolean {
  return isTaskLike(c) && !isAppScoped(c)
}
