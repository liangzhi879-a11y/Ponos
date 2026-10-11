// 后台任务完成 → 自动唤醒空闲内核的**决策纯函数**（2026-09-21 长任务可靠性改造 P0）。
//
// 为什么独立成模块：与 server/kernel-loop-reap.mjs 同范式 —— 判定可穷举单测，
// 接线（合并窗口 setTimeout、入队、拉起 handleUser）留在 kernel/cli.mjs。
//
// 背景症状：agent 派后台子代理/后台程序后结束轮次；任务完成只有 UI 通知
// （wire.taskNotification → 前端 usePonosCLI 的 task_notification 分支只更新任务卡片），
// **没有任何机制唤醒主 agent**，用户必须手打一条消息才能续上。
//
// 唤醒通路（接线侧实现）：本模块判定 → cli 侧入队（systemInjection: true，展示层静默）
// → 显式拉起 handleUser 开新一轮。★ 不能只调 engine.queueNext()：它的消费点是
// handleUser 的 finally 兜底，轮次已结束时没有 finally 会再跑，消息会永远躺在 pendingNext 里。

/** 合并窗口：多个后台任务在该窗口内完成时合并为一次注入，避免连环唤醒刷屏。 */
export const WAKE_MERGE_WINDOW_MS = 1500

/** 注入时的单条摘要上限（防止把子代理全量输出灌进主上下文——产物全量、读面有上限）。 */
export const WAKE_SUMMARY_MAX = 2000

/**
 * 是否应当自动唤醒主 agent。四条同时成立才唤醒。
 *
 * 为什么要求"轮次空闲"：轮次活跃时，工具边界会自然把后台完成事件带入下一轮，
 * 此时再注入等于插话干扰，且可能打断正在进行的推理。
 *
 * @param {{turnActive:boolean, queueLen:number, wakeUsed:number, max:number}} p
 * @returns {boolean}
 */
export function shouldAutoWake({ turnActive, queueLen, wakeUsed, max }) {
  if (!(max > 0)) return false // max<=0 = 关闭（PONOS_AUTO_WAKE=0 回滚开关）
  if (turnActive) return false // 轮次活跃：无需唤醒
  if (queueLen > 0) return false // 已有排队消息：它自己会启动下一轮
  return wakeUsed < max // 预算内才唤醒（防"唤醒→派任务→再唤醒"无限递归）
}

/**
 * 构造静默注入文本。
 *
 * **不产生用户气泡**由注入侧的 `systemInjection: true` 保证（展示层静默，模型上下文不变
 * —— 见 engine.mjs#queueNext 对该字段的说明），此处只管内容：
 * 终态摘要 + 产物线索 + "继续推进"指示。
 *
 * @param {Array<{taskId:string, status:string, summary?:string, kind?:string}>} items
 * @returns {string}
 */
export function buildWakeText(items) {
  const lines = (items || []).map((it) => {
    const kind = it?.kind === 'bash' ? '后台命令' : '后台子任务'
    const summary = String(it?.summary ?? '').slice(0, WAKE_SUMMARY_MAX)
    return `【${kind} ${it?.taskId} ${it?.status}】${summary}`
  })
  return `${lines.join('\n')}\n请据此继续推进剩余工作（无需等待用户指令）。`
}
