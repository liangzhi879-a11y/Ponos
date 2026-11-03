// 合帧器：把高频 stdout/stderr 合并成低频帧，并对 UI 侧做尾部截断。
// ---------------------------------------------------------------------------
// 边界：**纯逻辑**——不碰 wire、不碰 fs、不写日志（全量落盘由调用方 runShell 负责，
//   通过 logFile 全量追加）；也不碰 transcript / 模型上下文（delta 只走 UI）。
//
// 语义（对齐 spec 2026-10-28-agent-terminal-live-tracking §5：「尾部上限：每工具调用送往
//   UI 的总量上限 64KB（**stdout + stderr 合计，不是各一份**），超出丢弃最早内容并置
//   truncated:true」，验收口径「UI 帧累计 ≤ 64KB 且末帧 truncated:true」）：
//   - stdout 与 stderr 共用一份 TAIL_LIMIT 预算，跨帧累计；超出部分丢弃最早内容
//     （单块超预算时只收该块尾部），并把 truncated 置 true；
//   - **唯一代价**：stdout 先喷满 64KB 会让 stderr 此后一个字都进不来（顺序性饥饿）。
//     用户已裁定接受、不设 stderr 保底；诊断材料靠全量日志（runDir/<toolUseId>.log）
//     与 tool_result 自己的累积值兜底，实时视图被截断只损失观感；
//   - truncated 是**通道级**标记（不是流级）：stdout 打满时同一帧里正常收下的 stderr
//     也会被标 truncated:true（全局预算配全局标记，自洽；前端要分流提示得扩帧字段）；
//   - **空截断帧是一次性信号**：预算耗尽后再有输出时，允许发一帧 stdout==='' && stderr===''
//     && truncated===true，表示「更早的输出已丢弃」；靠闩锁保证只发一次，之后不再重复
//     （前端不得丢弃该帧，也不可能等到第二帧）；
//   - 帧内积压 ≥ FLUSH_BYTES，或距上次 emit ≥ intervalMs 时自动 emit；
//   - flushNow 立即冲刷；既无内容、也没有待报的截断标记时不 emit。
//
// 不变量：预算保证收下的字节合计 ≤ TAIL_LIMIT ⇒ 帧内缓冲永不超过 TAIL_LIMIT，
//   因此**不需要**再对缓冲做二次裁剪（早先的 trimTail 是死代码，已按裁定删除）。
//   若将来给 sent 加 reset/复用，必须重新审视这条不变量，否则会静默丢字节且不置 truncated。
//
// 生命周期：**一个实例 = 一次工具调用**（sent 终身不重置，spec 的上限就是「每工具调用」）。
// 计长按 JS 字符串 UTF-16 码元长度（与调用方 child.stdout 'data' 块口径一致）；
//   多字节字符跨越 chunk 边界时的半个码元由上游负责对齐，不在本模块职责内。
export const TAIL_LIMIT = 64 * 1024
export const FLUSH_INTERVAL_MS = 100
export const FLUSH_BYTES = 8 * 1024

/**
 * @param {{
 *   intervalMs?: number,
 *   flush?: (frame: { seq: number, stdout: string, stderr: string, truncated: boolean }) => void,
 *   now?: () => number,
 * }} [opts]
 */
export function createChunkMerger(opts = {}) {
  const { intervalMs = FLUSH_INTERVAL_MS, now = Date.now, flush } = opts
  if (typeof flush !== 'function') throw new TypeError('createChunkMerger: flush 必须是函数')
  let stdout = ''
  let stderr = ''
  // 已发给 UI 的字节数（stdout + stderr 合计，跨帧累计，终身不重置）
  let sent = 0
  let bytes = 0 // 本帧待发字节数（只算真正收下的内容）
  let seq = 0
  let last = now()
  let truncated = false // 本帧待报的截断标记
  let truncationReported = false // 空截断帧的闩锁：一次性信号

  const emit = () => {
    if (!stdout && !stderr && !truncated) return
    seq += 1
    if (!stdout && !stderr) truncationReported = true // 这一帧就是那个一次性的空截断帧
    const frame = { seq, stdout, stderr, truncated }
    stdout = ''
    stderr = ''
    bytes = 0
    truncated = false
    last = now()
    flush(frame)
  }

  // 预算不足时只收尾部（丢弃这一块最早的部分），返回真正收下的文本
  const accept = (chunk) => {
    const budget = TAIL_LIMIT - sent
    if (chunk.length <= budget) return chunk
    const kept = budget > 0 ? chunk.slice(-budget) : ''
    // 有正文的截断帧每帧都要标；空截断帧只在闩锁未落时标一次
    if (kept || !truncationReported) truncated = true
    return kept
  }

  return {
    push(stream, chunk) {
      if (!chunk) return
      const text = accept(String(chunk))
      if (text) {
        if (stream === 'stderr') stderr += text
        else stdout += text
        sent += text.length
        bytes += text.length
      }
      if (bytes >= FLUSH_BYTES || now() - last >= intervalMs) emit()
    },
    flushNow: emit,
  }
}
