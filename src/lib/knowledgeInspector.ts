// src/lib/knowledgeInspector.ts —— 右栏 Inspector 的**纯逻辑**（S2 Task 9）
//
// 两件事可测且值得测：
//   ① 大纲构造：要从 `/doc` 的块数组里挑出 `kind === 'heading'` 的块，并归一 level
//      （后端 level 字段是可选整数，脏值为 0/负数/小数时不能让缩进算成负 padding）；
//   ② 索引龄分档：`/stats` 的 `indexAgeMs` 是毫秒数（也可能 null），分档逻辑（刚刚/分钟/小时/天）
//      放在这里，组件只负责把 unit 映射成 i18n 文案——**不在这里产文案**，否则中文硬编码会
//      跟着被测代码一起漏进 UI（本仓库 i18n 是硬要求）。
//
// 照 lib/knowledgeBlocks.ts 的约定：不 import React、不 import '@/...' 别名（node:test 直接跑 TS）。
import { clampLevel, type BlockLike } from './knowledgeBlocks.ts'

export interface OutlineEntry {
  /** 块序号（做 React key；缺失时用下标兜底） */
  n: number
  /** 原文行号（点击定位的落点；阅读视图的块上有 data-line 锚点） */
  line: number
  /** 归一后的标题级别 1..6 */
  level: number
  text: string
}

/**
 * 块数组 → 大纲。
 * 只收 heading：`/doc` 的其它块（段落/条目/代码）在右栏列出会让大纲变成"整篇目录"，
 * 失去"跳章节"的作用。空文本标题丢弃（点它无处可跳，也无法作为锚点标签）。
 */
export function buildOutline(blocks: readonly BlockLike[] | undefined): OutlineEntry[] {
  const out: OutlineEntry[] = []
  const list = blocks ?? []
  list.forEach((b, i) => {
    if (!b || b.kind !== 'heading') return
    const text = String(b.text ?? '').trim()
    if (!text) return
    const line = typeof b.line === 'number' && Number.isFinite(b.line) ? Math.floor(b.line) : 0
    out.push({ n: typeof b.n === 'number' ? b.n : i, line, level: clampLevel(b.level), text })
  })
  return out
}

/** 缩进步长（px）与首级缩进：212px 宽的右栏里，每级 9px 能放下 4 级标题而不挤成竖排 */
const INDENT_BASE = 6
const INDENT_STEP = 9

/** 级别 → 左内边距。封顶 5 级（md 虽到 6 级，但 6 级在本宽度下已无可读缩进余量） */
export function outlineIndent(level: number): number {
  const l = Math.min(Math.max(clampLevel(level), 1), 5)
  return INDENT_BASE + (l - 1) * INDENT_STEP
}

export interface AgeParts {
  unit: 'now' | 'minute' | 'hour' | 'day'
  /** `now` 时固定为 0（调用方不必分支） */
  value: number
}

/**
 * 索引龄分档：null/非数/负数 → null（调用方显示"—"，**不能**当成"刚刚"——没数据要说没数据）。
 * 阈值：<60s 刚刚 / <60min 分钟 / <24h 小时 / ≥24h 天（取整=向下取，宁可说"59 分钟前"也不早报"1 小时前"）。
 */
export function ageParts(ms: number | null | undefined): AgeParts | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 60_000) return { unit: 'now', value: 0 }
  if (ms < 3_600_000) return { unit: 'minute', value: Math.floor(ms / 60_000) }
  if (ms < 86_400_000) return { unit: 'hour', value: Math.floor(ms / 3_600_000) }
  return { unit: 'day', value: Math.floor(ms / 86_400_000) }
}
