// 压缩指示条生命周期守卫（2026-09-13「压缩提示/动画触发后常驻不取消」事故收口）
// ---------------------------------------------------------------------------
// 病根：`chatStore.compactingBySession` 是纯布尔态，只有内核的 system/compaction
// 帧能复位（start→true / done→false，见 useYFWCLI 归约）。**done 帧丢一次**，
// 指示条与 `animate-pulse` 动画就常驻到下一次压缩为止——丢帧的现实来源：
//   · WS 闪断（onclose 只清失速/首字节，见 hook 内注释）；
//   · 内核 writeLine 写失败被静默 catch（kernel/protocol.mjs，已改计数但帧仍丢）；
//   · 桥侧 send 遇 readyState≠1 客户端直接跳过（bridge.mjs:1477）。
//
// 分层收口（本模块只提供纯判定，不持有状态；组件仍只读布尔，无新状态源）：
//   ① 回合结束必清：压缩在 preStep 内 await，**不可能跨回合边界**——`result` 到达即
//      证明 done 帧已丢（hook 的 result 分支消费）；
//   ② 断线必清：WS onclose 清该会话瞬时态（提问/审批仍刻意保留，见 hook）；
//   ③ 墙钟兜底：内核硬看门狗（kernel/cli.mjs，默认 900s）内必然出现 result/closed，
//      超本上限仍亮 = 帧与生命周期双双丢失 ⇒ 强制复位 + 留日志（hook 的 30s 巡检消费）。
//
// 为什么可以放心清：误清无害——`setCompacting` 同值幂等短路，done 帧再来是空操作，
// 下一次 start 会重新点亮；漏清有害——常驻动画让用户无法区分"在压缩"和"卡住了"。

/**
 * 兜底上限（毫秒）：超过它仍亮着即判定 done 帧丢失，强制复位。
 *
 * 取值必须**大于**内核硬看门狗默认值（`kernel/cli.mjs` 的 PONOS_KERNEL_HARD_TIMEOUT_MS，
 * 当前 900s）+ 其 60s tick 相位余量——内核自杀后桥会广播 closed 走正常复位路径，所以
 * 活过这个窗口的指示条必然是帧丢、不是压缩在跑。跨树一致性由
 * `server/compact-indicator-parity.test.mjs` 守（抬内核上限时必须同步抬本值）。
 */
export const COMPACT_INDICATOR_MAX_MS = 20 * 60 * 1000

/**
 * 返回「压缩指示已挂起超限」的会话 id 列表（纯函数，便于单测）。
 *
 * - 只认 `compacting === true` 的会话：false/缺省一律不管（无指示就没有悬挂）。
 * - `since` 缺失/非有限（不该出现，单写者 setCompacting 维护）按超限处理——宁清不留：
 *   没有时间基准就无法证明它新鲜，留着就是无限常驻。
 * - 边界：`now - since > boundMs` 才算超限（正好到点仍然新鲜，交给下一轮巡检）。
 */
export function staleCompactionSids(
  compacting: Record<string, boolean | undefined>,
  since: Record<string, number | undefined>,
  now: number,
  boundMs: number = COMPACT_INDICATOR_MAX_MS,
): string[] {
  const out: string[] = []
  for (const [sid, on] of Object.entries(compacting || {})) {
    if (on !== true) continue
    const startedAt = since?.[sid]
    if (!Number.isFinite(startedAt)) { out.push(sid); continue }
    if (now - (startedAt as number) > boundMs) out.push(sid)
  }
  return out
}
