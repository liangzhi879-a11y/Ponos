// src/lib/conversationResync.ts —— 断线重连后的会话重同步（2026-09-13「任务断掉」事故）
//
// 事故形态（实证 sid 17892228）：内核 15:36:34.649Z 正常产出最终答复、桥 4ms 后收到 result，
// 但渲染器自 15:36:29.6Z 起约 55 秒没有消费任何一帧（也不回心跳 pong）——帧躺在它自己的
// 接收缓冲里没人读，连接本身还活着。桥按「僵尸客户端」在心跳超时后 terminate()（渲染器记
// closed:1006），重连只握手：bridge_hello 只带桥实例 id（bridge.mjs:2595），既不补投漏掉的帧，
// GUI 侧也不重拉 transcript（useYFWCLI.ts 的 onclose 反而清空 pendingStreamEvents、
// 同桥闪断走「无需动作」分支）⇒ 最终答复与整轮 result 永久缺席屏幕，用户看到的就是
// 「应用自己处理任务断掉了」。而磁盘上的 transcript 里那条答复是完好的。
//
// 本模块只做**合并判定**这一纯逻辑，不碰 React、不碰 store：
//   · 以磁盘（transcript）为准 —— 它是唯一完整的真相；
//   · 但保留「本地更新、磁盘还没有」的消息（断线期间排队发送的用户消息、失败提示块…）；
//   · 磁盘为空（拉取失败/无 transcript）时原样返回本地 —— **绝不允许因一次拉取失败清空屏幕**。
//
// 为什么用「时间戳 > 最后一条磁盘记录 + 宽限」而不是按 id 去重：GUI 流式消息的 id 来自本地
// generateId()（chatStore._addStreamingMessage:922），磁盘条目用的是内核 entry id，两边**永远
// 不相同**，按 id 去重必然重复。而「实时渲染过的消息」= 磁盘某条 entry 的副本，落盘与投递实测
// 只差毫秒（result 与 transcript 记录相差 4ms），所以用时间戳 + 宽限能把这类副本排除在外，
// 只留下磁盘确实没有的尾部。
//
// 已知取舍（有意为之）：本地流式渲染过、但内核从未落盘的内容（消息写到一半就被杀）会被磁盘
// 视图取代而消失。之所以不设法保住它：磁盘条目与本地副本的 id 基准不同，无法可靠配对，
// 硬留就会在同一屏上出现「半截 + 完整」两条同一答复。磁盘是唯一可信真相，宁可少不可重。

import type { Message } from '../types/index.ts'

/**
 * 本地消息被判定为「磁盘还没有」的时间宽限（毫秒）。
 * 依据：同一内容的磁盘记录与实时投递实测相差 ~4ms（transcript 15:36:34.649Z / 桥收 result
 * 15:36:34.653Z），1.5s 足够把它们认成同一份，而断线期间排队发送的用户消息至少晚一个重连
 * 退避（≥2s），不会被误判成副本。
 */
export const RESYNC_GRACE_MS = 1500

export interface ResyncMergeResult {
  /** 合并后的消息数组（磁盘顺序在前） */
  messages: Message[]
  /**
   * 屏幕上**净增的行数**（= messages.length − local.length）。
   * >0：这次重连确实补回了丢帧；=0：本地已与磁盘一致（只发生了副本去重）；
   * <0：本地比磁盘多出的副本被去重（截图对比时别误读成"丢消息"）。
   */
  netGain: number
  /** 末尾保留的本地新增条数（磁盘尚未包含） */
  keptLocal: number
}

const ts = (m: Message | undefined): number => {
  const t = Number(m?.timestamp)
  return Number.isFinite(t) ? t : 0
}

/**
 * 合并「本地已渲染消息」与「刚从 transcript 读到的消息」。
 * 磁盘为空 → 原样返回本地（netGain=0 且不复制数组），调用方据此放弃本次重同步。
 */
export function mergeResyncedMessages(
  local: Message[],
  fromDisk: Message[],
  graceMs: number = RESYNC_GRACE_MS
): ResyncMergeResult {
  if (fromDisk.length === 0) return { messages: local, netGain: 0, keptLocal: 0 }
  const lastDiskTs = fromDisk.reduce((mx, m) => Math.max(mx, ts(m)), 0)
  const cutoff = lastDiskTs + graceMs
  const keptLocal = local.filter((m) => ts(m) > cutoff)
  const messages = [...fromDisk, ...keptLocal]
  return { messages, netGain: messages.length - local.length, keptLocal: keptLocal.length }
}
