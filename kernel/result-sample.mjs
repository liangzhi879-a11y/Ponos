// kernel/result-sample.mjs —— 工具结果的内联采样（T2.1，2026-10-20）
// ---------------------------------------------------------------------------
// 问题（问0）：超阈值工具结果会**全文落盘**（`engine.mjs#persistToolResult`），内联只留预览。
// 但原预览是 `content.slice(0, 2000)` —— **只留开头**。而 Bash 类输出的关键信息几乎总在**结尾**：
//   退出码汇总、失败的用例名、"Failed tests: 3"、构建报错、`npm ERR!` 全在尾部。
//   只给开头等于"给你看日志前 2000 字，报错自己 Read 文件找"。
//   同时内联阈值是 20,000 字符（≈5–7 K token 全额价），对大输出仍偏贵。
//
// 改法（两处，都是"更省 + 更好用"）：
//   ① **预览改成头 + 尾**（默认 2,000 + 4,000 字符），交界处给显式省略标记与恢复路径；
//   ② 内联阈值默认从 20,000 降到 8,000 字符（**仍全文落盘** ⇒ 无损，模型可按路径补读）。
//      `PONOS_TOOL_RESULT_BUDGET_BYTES=20000` 一行回到旧行为。
//
// ★ 为什么这不算"用质量换成本"：落盘是**无损**的（原文一个字节不少，路径就在标记里）。
//   唯一代价是"看中段要多一次 Read"，故采样标记里把路径写全，并把"用什么工具定位"写清楚。
// ★ 采样**只在超阈值时**发生；错误输出（退出码/stderr 摘要）由 `runShell` 自己拼进正文，
//   不经过本函数 —— stderr 永远不会被采样掉。

/** 省略标记片段（可被测试与模型识别；不含路径，路径由调用方拼） */
export const SAMPLE_MARKER = (omitted) => `\n[…中间省略 ${omitted} 字符：完整内容已落盘，用 Read 读取下面的路径，或用 Grep 在中段定位…]\n`

/**
 * 把长文本采样成"头 + 省略标记 + 尾"。
 *
 * @param {string} content 原始文本
 * @param {{headChars?: number, tailChars?: number}} [opts]
 * @returns {{text: string, omitted: number, sampled: boolean}}
 *   `sampled=false` 时 `text` 原样返回（短内容零变化）。
 */
export function sampleToolOutput(content, { headChars = 2000, tailChars = 4000 } = {}) {
  const s = typeof content === 'string' ? content : String(content ?? '')
  const head = Math.max(0, Math.floor(Number(headChars) || 0))
  const tail = Math.max(0, Math.floor(Number(tailChars) || 0))
  const keep = head + tail
  // 不超预算 ⇒ 原样（"采样"不该在短内容上引入任何字符）
  if (s.length <= keep) return { text: s, omitted: 0, sampled: false }
  const omitted = s.length - keep
  return {
    text: s.slice(0, head) + SAMPLE_MARKER(omitted) + s.slice(s.length - tail),
    omitted,
    sampled: true,
  }
}
