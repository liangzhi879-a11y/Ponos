// src/lib/knowledgeSearch.ts —— 搜索视图的**纯逻辑**（S2 Task 7）
//
// 为什么单独一层：组件里那些"看起来是渲染细节"的判断其实是可被钉死的规则——
//   · 关键词串怎么拆（中文逗号/分号/空格在用户输入里混着出现）；
//   · snippet 里哪几段算命中（要支持大小写不敏感 + 用户输入里的 `+`/`(` 等正则元字符）；
//   · 相关度怎么从 `score` 变成"三格色条"（score 是 4 路融合的加权和，**绝对值无意义**，
//     只有同一次结果内的相对高低可读——所以只能按本次最大分归一，不能定死阈值）。
// 组件只做 map；本文件不 import React、不 import '@/...' 别名（node:test 原生跑 TS 的要求，
// 照 lib/knowledgeBlocks.ts 头部的约定）。
//
// 🔴 不暴露原始 `score`（spec §6 / 计划 Task 7）：分数是内部融合量，展示数字会让用户
// 把它当"匹配度百分比"去跨查询比较——不同查询的分数分布完全不同，比较没有意义。

import type { KnowledgeSearchItem } from './knowledgeApi.ts'

/** Ctrl/Cmd+F 聚焦搜索框的跨组件信号（WorkShell 发 → 搜索视图收）。
 *  为什么用 window 事件而不是 store 字段：这是**一次性意图**，不是需要持久化/订阅的状态；
 *  仓库既有同类先例（`yfworking:scroll-message` / `yfworking:pin-limit`，ChatWindow.tsx:156）。 */
export const KB_FOCUS_SEARCH_EVENT = 'yfworking:knowledge-focus-search'

/**
 * 关键词串 → 数组。分隔符收 `,` `，`（中文）`;` `；` 与空白：把关键词框做成"必须用英文逗号"
 * 是典型的自找麻烦（中文输入法下逗号默认是全角）。空项丢弃、去重、保序。
 */
export function parseKeywords(input: string): string[] {
  const out: string[] = []
  for (const raw of String(input ?? '').split(/[,，;；\s]+/)) {
    const k = raw.trim()
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

/**
 * 高亮词典 = 查询串 + 关键词（去空、去重、**长词在前**）。
 * 长词在前的原因：`['文件传输助手', '文件']` 若短词先匹配，长词永远命中不到完整片段，
 * 高亮会碎成"文件 / 传输助手"两段——同一处命中被切两次。
 */
export function searchTerms(q: string, keywords: readonly string[] = []): string[] {
  const all = [String(q ?? '').trim(), ...keywords.map(k => String(k ?? '').trim())]
  const uniq: string[] = []
  for (const term of all) if (term && !uniq.includes(term)) uniq.push(term)
  return uniq.sort((a, b) => b.length - a.length)
}

export interface HighlightChunk {
  text: string
  /** true = 命中片段（渲染时给底色） */
  hit: boolean
}

/** 词典长度上限：词典来自用户输入，理论上无上限；拼成 `a|b|c` 正则前先截断，
 *  避免一个畸形输入（几千个逗号）让每次渲染都构造超长正则。 */
const MAX_TERMS = 24

/**
 * snippet → 高亮片段序列（调用方直接 map 成 <span>）。
 * 大小写不敏感（英文命中不该因为大小写整段不亮）；词典里的正则元字符转义——用户在搜索框里
 * 输入 `c++` 或 `fs(` 是常态，不转义会直接抛 `Invalid regular expression` 白屏。
 * 无词典/空文本 → 原样一段（未命中），调用方无需分支。
 */
export function splitHighlight(text: string, terms: readonly string[]): HighlightChunk[] {
  const src = String(text ?? '')
  if (!src) return []
  const dict = terms.filter(Boolean).slice(0, MAX_TERMS)
  if (!dict.length) return [{ text: src, hit: false }]

  const pattern = dict.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(pattern, 'gi')
  const out: HighlightChunk[] = []
  let last = 0
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), hit: false })
    out.push({ text: m[0], hit: true })
    last = m.index + m[0].length
    if (m[0] === '') re.lastIndex++          // 空匹配防御：正则在原地踏步会让循环永不结束
  }
  if (last < src.length) out.push({ text: src.slice(last), hit: false })
  return out.filter(c => c.text !== '')     // 空片段不进 DOM（key 稳定、少几个节点）
}

/**
 * 相对相关度 → 1..3 档（渲染成三格色条）。
 * 只按**本次结果集**的最大分归一（见文件头）：`max` 非法（0/NaN/负）时一律 1 档（有色条但不虚张声势）。
 */
export function strengthLevel(score: number, max: number): 1 | 2 | 3 {
  if (!Number.isFinite(score) || !Number.isFinite(max) || max <= 0) return 1
  const ratio = Math.min(Math.max(score / max, 0), 1)
  if (ratio >= 0.75) return 3
  if (ratio >= 0.4) return 2
  return 1
}

/** 本次结果集里的最大分（色条分母）；空集 → 0（strengthLevel 会回落 1 档） */
export function maxScore(items: readonly KnowledgeSearchItem[]): number {
  let max = 0
  for (const it of items) if (Number.isFinite(it?.score) && it.score > max) max = it.score
  return max
}
