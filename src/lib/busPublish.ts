// src/lib/busPublish.ts
// 聊天事件发布辅助：纯函数构造 StateBus 事件信封，from 携带会话标识，便于接收方按会话路由。
import type { BusEvent } from '@/types'

/** 构造聊天事件信封：from 携带会话标识，便于接收方按会话路由。 */
export function buildChatEvent(channel: string, action: string, payload: unknown, sessionId: string): BusEvent {
  return { channel, action, payload, from: `chat:${sessionId}`, ts: Date.now() }
}
