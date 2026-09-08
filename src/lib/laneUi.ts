// src/lib/laneUi.ts —— lane 压缩 toast 队列归约纯函数
// 规则：被测模块零依赖——不 import zustand store、不用 '@' alias、只 import type。
export interface LaneNote {
  /** = taskId：同任务重复压缩覆盖计次而非追加行 */
  key: string
  taskId: string
  text: string
  compactCount: number
  ts: number
}

const CAP = 3

export function makeLaneNote(taskId: string, text: string, compactCount: number): LaneNote {
  return { key: taskId, taskId, text, compactCount, ts: Date.now() }
}

export function pushLaneNote(list: LaneNote[], note: LaneNote): LaneNote[] {
  const rest = list.filter((n) => n.key !== note.key)
  const next = [...rest, note]
  return next.length > CAP ? next.slice(next.length - CAP) : next
}

export function dismissLaneNote(list: LaneNote[]): LaneNote[] {
  return list.length ? list.slice(1) : list
}
