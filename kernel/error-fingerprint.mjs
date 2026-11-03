// kernel/error-fingerprint.mjs —— 错误指纹（P1 Task 1；设计 §4.1）
//
// 定位：把**同一条错误的不同写法**归一成一个稳定短码 `fp`，让转录 / doctor journal /
//   渲染层日志三处的事件能被认成「同一件事」。**只用于聚合**，不用于自动判定"是不是同一个 bug"
//   （聚合结果旁边必须带原始片段供人核对 —— 见 kernel/error-attribution.mjs 的 snippet 字段）。
//
// 三条纪律：
//   · **纯函数、零 IO、无时钟、无随机**（同输入逐字同输出）⇒ 可单测、可重放、跨源可比；
//   · **只删噪声、不删语义**：路径/行号/时间戳/GUID/长随机串/量级数字都是噪声；
//     错误类型词与固定短语（`only stream-json I/O format is supported`）必须保留；
//   · **空输入不参与聚合**：返回 `null` 而不是 `''`（`''` 会变成一个"什么都撞"的桶）。
//
// 归一化顺序**不可随意调换**：先时间戳再行号（否则 ISO 里的 `:12:33` 会先被行号规则吃掉）。

import { createHash } from 'node:crypto'

/** 超长文本的截断预算：头保留 4 KB、尾保留 1 KB（错误类型在头，结论常在尾）。 */
const HEAD_KEEP = 4096
const TAIL_KEEP = 1024
const HARD_LIMIT = HEAD_KEEP + TAIL_KEEP

const RE_WIN_PATH = /[A-Za-z]:\\[^\s"']+/g
const RE_POSIX_PATH = /(?<![\w<])\/(?:[\w.\-]+\/)+[\w.\-]+/g
const RE_ISO_TS = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g
const RE_DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g
const RE_LINE_REF = /\b(line|at line)\s*\d+|第\s*\d+\s*行/gi
const RE_LINE_COL = /:\d+(?::\d+)?/g
const RE_GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const RE_LONG_HEX = /\b[0-9a-f]{12,}\b/gi
const RE_BIG_NUMBER = /\b\d{3,}\b/g
const RE_LONG_QUOTED = /"[^"]{40,}"|'[^']{40,}'/g

/**
 * 归一化错误文本（**幂等**：`normalize(normalize(x)) === normalize(x)`）。
 * @param {unknown} raw
 * @returns {string} 归一化结果；非字符串/空白 ⇒ `''`
 */
export function normalizeErrorText(raw) {
  if (typeof raw !== 'string') return ''
  let t = raw
  if (!t.trim()) return ''

  // ⓪ 截断：只保留头尾（中段噪声不参与比较）
  if (t.length > HARD_LIMIT) t = `${t.slice(0, HEAD_KEEP)} ${t.slice(-TAIL_KEEP)}`

  // ① 路径（先于其它规则：路径里可能含 `:\`、数字、点号，先吃掉免得被后面切碎）
  t = t.replace(RE_WIN_PATH, '<path>').replace(RE_POSIX_PATH, '<path>')
  // ② 时间戳/时长（**必须先于行号**：ISO 的 `:12:33` 会被行号规则切坏）
  t = t.replace(RE_ISO_TS, '<ts>').replace(RE_DURATION, '<ts>')
  // ③ 行引用与行列号
  t = t.replace(RE_LINE_REF, 'line N').replace(RE_LINE_COL, ':N')
  // ④ 随机 id：GUID / 长十六进制 / ≥3 位的量级数字
  t = t.replace(RE_GUID, '<id>').replace(RE_LONG_HEX, '<id>').replace(RE_BIG_NUMBER, '<n>')
  // ⑤ 引号内长串（每轮变化的内容，如 JSON 片段/正文）
  t = t.replace(RE_LONG_QUOTED, '<str>')

  // ⑥ 收尾：小写 + 折叠空白 + 去尾部标点
  return t.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,;:、，。；：]+$/, '')
}

/**
 * 错误指纹：`sha1(归一化文本)` 前 12 位十六进制。
 * @param {unknown} raw
 * @returns {string|null} 空/非字符串 ⇒ `null`（调用方**必须**丢弃，不得当成一个桶）
 */
export function fingerprintOf(raw) {
  const norm = normalizeErrorText(raw)
  if (!norm) return null
  // 用 node 内置 crypto（内核是独立进程，node:crypto 无额外依赖）
  // 注意：这里**不能**用随机盐 —— 跨会话/跨源必须可比
  return createHash('sha1').update(norm, 'utf8').digest('hex').slice(0, 12)
}
