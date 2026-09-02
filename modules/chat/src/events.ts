// Chat 模块的纯逻辑（与 React 解耦，便于 node --test 直接加载）。
// 渲染契约（权威：kernel/protocol.mjs makeWire + docs/bridge-contract.md §4）：
//   assistant 事件为流式逐块：{ type:'assistant', message:{ role:'assistant',
//     content:[{type:'text',text}|{type:'thinking',thinking}|{type:'tool_use',…}] } }
//   result 事件闭轮：{ type:'result', usage }
// 策略：text 块累积进当前 assistant 气泡（busy 窗口内合并 → 单条消息呈现整段流式文本），
//   result 清 busy 闭轮；thinking/tool_use 纯块不渲染（v1）；user 消息由 UI 发送时乐观追加，
//   内核不在 stdout 回显 user 事件。

export interface Msg { role: 'user' | 'assistant' | 'tool'; text: string; ts: number }

export interface ChatState { msgs: Msg[]; busy: boolean }

const textOf = (ev: any): string =>
  (ev?.message?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('')

export function reduceEvents(state: ChatState, ev: any): ChatState {
  const t = ev?.type
  if (t === 'assistant') {
    const text = textOf(ev)
    if (!text) return state // thinking/tool_use 纯块：v1 不渲染
    const last = state.msgs[state.msgs.length - 1]
    if (state.busy && last?.role === 'assistant') {
      return { ...state, msgs: [...state.msgs.slice(0, -1), { ...last, text: last.text + text }] }
    }
    return { ...state, msgs: [...state.msgs, { role: 'assistant', text, ts: Date.now() }], busy: true }
  }
  if (t === 'result') return { ...state, busy: false }
  return state
}
