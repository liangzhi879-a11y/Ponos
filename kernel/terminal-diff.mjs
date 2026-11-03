// 行级 diff hunk 生成（`file_change.diff_hunk` 的唯一真源，2026-10-28 Task 4a）
// ---------------------------------------------------------------------------
// 边界：**纯函数**——不碰 fs、不碰 wire、不写 transcript。只做「两段文本 → 一个单 hunk 的
//   unified diff 文本」；改动行数的统计仍归 `kernel/tools.mjs#diffLineStats`（既有算法，本模块不碰、
//   也不重算），本模块只负责**文本**，避免"两套算法"在同一帧里给出互相矛盾的数字。
//
// 形状（第一版刻意不做上下文行）：只输出"公共前缀/后缀之间的最小改动区间"
//   `@@ -<旧起始>,<旧行数> +<新起始>,<新行数> @@` + 若干 `-` 行 + 若干 `+` 行；行号 1-based，
//   旧起始 = 新起始 = 公共前缀行数 + 1。
//   ★ 零长度区间：新文件（oldText 为空）按 unified diff 惯例写 `@@ -0,0 +1,N @@`（brief 明文）；
//     其余"旧/新某一侧行数为 0"的情形仍按上面的通式给号（例如纯插入 p=2 ⇒ `@@ -3,0 +3,1 @@`）。
//     这与 GNU diff 在零长度区间用「起始-1」的写法不同，前端按 + 段起始算行号即不受影响。
//
// 超 maxBytes（默认 8KB，spec §5.1）：**在行边界**截断并追加 '\n…（已截断）'——
//   不把一行切碎，前端拿去解析不会遇到半行。
export const MAX_HUNK_BYTES = 8 * 1024

const TRUNCATED_MARK = '\n…（已截断）'

// 与 kernel/tools.mjs#diffLineStats 同样的切行/归一规则（CRLF → LF，空串 = 0 行）。
// 为什么在这里再写一遍而不 import：tools.mjs 要 import 本模块（buildHunk），反向 import 会成环；
// 而 diffLineStats 是既有导出、算法受 brief 保护不能改，故只能同规则复制这三行。
const splitLines = (t) => {
  const s = String(t ?? '').replaceAll('\r\n', '\n')
  return s === '' ? [] : s.split('\n')
}

/**
 * 生成单 hunk 的 unified diff 文本（无改动返回 ''）。
 * @param {string} oldText
 * @param {string} newText
 * @param {{ maxBytes?: number }} [opts]
 * @returns {string}
 */
export function buildHunk(oldText, newText, { maxBytes = MAX_HUNK_BYTES } = {}) {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  // 公共前缀 / 后缀（与 diffLineStats 同口径：prefix 互斥于 suffix，避免重叠）
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const oldCount = a.length - p - s
  const newCount = b.length - p - s
  if (oldCount === 0 && newCount === 0) return '' // 完全无改动（含两边都空）
  const header = a.length === 0
    ? `@@ -0,0 +1,${newCount} @@`
    : `@@ -${p + 1},${oldCount} +${p + 1},${newCount} @@`
  const lines = [header]
  for (let i = p; i < a.length - s; i++) lines.push('-' + a[i])
  for (let i = p; i < b.length - s; i++) lines.push('+' + b[i])
  // 逐行累加，超预算就在**行边界**截断（首行就超预算时只留标记，不加多余换行）
  let out = ''
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line
    if (Buffer.byteLength(next, 'utf8') > maxBytes) return out ? out + TRUNCATED_MARK : TRUNCATED_MARK.slice(1)
    out = next
  }
  return out
}
