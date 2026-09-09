// src/lib/chatModeUi.ts —— 会话模式过滤纯函数（Task 10 二级面板 chat/task 分流）
// 规则：被测模块零依赖——不 import zustand store、不用 '@' alias、只 import type。
// 语义：mode===undefined（旧数据/导入）按 task 对待（与 chatStore migrate v3 归一一致）。
export interface ModeLike {
  mode?: 'chat' | 'task'
}

export function isChatLike(c: ModeLike): boolean {
  return c.mode === 'chat'
}

export function isTaskLike(c: ModeLike): boolean {
  return c.mode !== 'chat'
}
