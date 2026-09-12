// src/lib/firstByteUi.ts —— 「等待态」出口的判定纯逻辑（T8，2026-09-12 卡在思考界面事故）
//
// 事故形态：桥每 30s 发一条 first_byte_pending、连续数分钟（实测 17891871 在
// 07:24:43→07:30:53 共 16 条），渲染器逐条收到，但唯一出口是 RightStatusRail——
// 该栏只在 rail==='task' 挂载（WorkShell.tsx:194）、默认折叠为 36px 图标条、秒数
// 只在 hover tooltip 里 ⇒ chat 模式零出口，UI 恒显示静态「思考中…」。
//
// 本模块只做「store 快照 → 该显示哪一类等待、文案键是什么、是否显示秒数」的映射，
// 不碰 React、不碰时间源，供组件与单测共用同一判定（避免两处口径漂移）。
//
// 分级依据：
//   审批 / 提问 = 等的是人（用户不动作就永远等下去）→ 常显、不显示秒数
//   失速 / 首字节等待 / 压缩 = 等的是模型或内核 → 显示递增秒数

export type WaitKind = 'approval' | 'question' | 'stall' | 'firstByte' | 'compact'

export interface WaitSnapshot {
  /** 本会话未决审批数（chatStore.pendingPermissions 按 sessionId 过滤） */
  approvalCount: number
  /** 本会话是否有待回答提问（chatStore.pendingQuestions[conversationId]） */
  hasQuestion: boolean
  /** 内核静默毫秒（uiStore.kernelStalls[conversationId]，0 = 无） */
  stallMs: number
  /** 首字节等待毫秒（uiStore.firstByteWait[conversationId]，0 = 无） */
  firstByteMs: number
  /** 是否正在压缩上下文（chatStore.compactingBySession[conversationId]） */
  compacting: boolean
}

export interface WaitView {
  kind: WaitKind
  /** i18n 文案键 */
  i18nKey: string
  /** i18n 参数（秒数类含 secs，供首帧渲染用；随后由 secondsOf 逐秒覆盖） */
  i18nParams: Record<string, number>
  /** 是否显示递增秒数 */
  showSeconds: boolean
  /** 秒数基准（快照里的静默毫秒；不显示秒数时为 0） */
  sinceMs: number
}

/**
 * 优先级（同一时刻只显示一条，避免多个来源互相打架）：
 *   审批 > 提问 > 失速 > 首字节等待 > 压缩
 * 前两类是「等人」，比「等模型」更需要用户动作；失速高于首字节是因为桥侧本就把
 * 首字节等待在 90s 时升级为失速（升级时 firstByteWait 已被清除）。
 * 无任何等待态时返回 null —— 调用方据此不占位。
 */
export function deriveWaitView(s: WaitSnapshot): WaitView | null {
  if (s.approvalCount > 0) {
    return { kind: 'approval', i18nKey: 'firstByteWait.waitingApproval', i18nParams: {}, showSeconds: false, sinceMs: 0 }
  }
  if (s.hasQuestion) {
    return { kind: 'question', i18nKey: 'firstByteWait.waitingAnswer', i18nParams: {}, showSeconds: false, sinceMs: 0 }
  }
  if (s.stallMs > 0) {
    return { kind: 'stall', i18nKey: 'kernelStall.title', i18nParams: { secs: secondsOf(s.stallMs, 0) }, showSeconds: true, sinceMs: s.stallMs }
  }
  if (s.firstByteMs > 0) {
    return { kind: 'firstByte', i18nKey: 'firstByteWait.waitingModel', i18nParams: { secs: secondsOf(s.firstByteMs, 0) }, showSeconds: true, sinceMs: s.firstByteMs }
  }
  if (s.compacting) {
    // 压缩只有布尔态（chatStore.compactingBySession），没有时间基准 ⇒ 不显示秒数
    return { kind: 'compact', i18nKey: 'compacting.title', i18nParams: {}, showSeconds: false, sinceMs: 0 }
  }
  return null
}

/**
 * 秒数 = (快照静默毫秒 + 锚点之后的本地流逝毫秒) / 1000，向下取整、至少 1。
 *
 * 为什么要本地流逝量：桥只在 5s 首帧之后每 30s 重发一次（bridge.mjs:2396/2398），
 * store 里的值因此每 30s 才更新一次，直接用会出现「30 秒才跳一次」的秒数。组件用
 * 1s ticker 把「本帧值 + 锚点以来流逝毫秒」交给这里，得到平滑递增。
 *
 * 向下取整而非四舍五入：首帧 5000ms 应立刻显示 5（而不是 5 秒后再显示 5），
 * 之后每满 1s 递增一次，符合"已等待 N 秒"的读法。
 */
export function secondsOf(sinceMs: number, elapsedMs: number): number {
  return Math.max(1, Math.floor((sinceMs + elapsedMs) / 1000))
}
