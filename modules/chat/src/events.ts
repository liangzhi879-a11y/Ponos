// Chat 模块的纯逻辑（与 React 解耦，便于 node --test 直接加载）。
// node 的 type-stripping 只覆盖 .ts（不覆盖 .tsx），故抽成独立 .ts 文件。

export interface Msg { role: 'user' | 'assistant' | 'tool'; text: string; ts: number }

export interface ChatState { msgs: Msg[]; busy: boolean }

export function reduceEvents(state: ChatState, ev: any): ChatState {
  const t = ev?.type
  const data = ev?.data || {}
  if (t === 'user') return { ...state, msgs: [...state.msgs, { role: 'user', text: data.text || '', ts: Date.now() }] }
  if (t === 'assistant') return { ...state, msgs: [...state.msgs, { role: 'assistant', text: data.text || '', ts: Date.now() }] }
  if (t === 'tool') return { ...state, msgs: [...state.msgs, { role: 'tool', text: data.name ? `[${data.name}] ${data.summary || ''}` : '', ts: Date.now() }] }
  if (t === 'result') return { ...state, busy: false }
  return state
}
