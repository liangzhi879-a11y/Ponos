// src/lib/knowledgeBlocks.ts —— 阅读视图的「块 → 渲染计划」纯逻辑（S2 Task 5）
//
// 为什么必须有这一层：`/knowledge/doc` **不回原始 md**，只回块数组
// （kernel/knowledge.mjs:104-125 parseDocFile → `{ n, kind, level, text, line, tag, full }`）。
// 所以阅读视图**不能**把整篇 md 丢给 react-markdown：那样既认不出经验条目（拿不到 tag），
// 也丢掉了每块的 `line` 锚点（检索跳转定位就无从做起）。
// 本文件把「每个块怎么渲染」抽成纯函数：组件只做 map，判定逻辑可被 `node --test` 钉住。
//
// 🔴 S1 裁定（spec §11.4）硬约束：**`tag !== null` 才渲染经验卡片**。
// 背景：`- [ ] Step N` 这类复选框行会被内核 ENTRY_LINE_RE
// （shared/knowledge-core.mjs:39 `/^- \[([^\]]*)\]\s*(.*)$/`）判成 entry 块——inner 内没有 `|`
// ⇒ entryTag 为 null。S1 已裁定**不改内核正则**（改动会牵动经验系统的兼容契约），
// 改由渲染层分流。故判定写成 isEntryCard()，并在 knowledgeBlocks.test.ts 里用
// 「含 `- [ ]` 的任务清单」用例钉死：这类块必须落到 markdown，一张卡片都不许出现。
//
// 有意的取舍：`tag === null` 的 entry 块，其 text 已被内核截成摘要（`- [ ]` / `- [x]` 标记与
// 勾选状态在块层就丢了，无法回溯），因此这里按普通段落渲染，**不伪造复选框**——
// 伪造会把用户手动打勾的 `- [x]` 显示成未勾选，比丢标记更误导。要还原标记得读原始文件
// （bridge /read-file），属 S3 范畴。
//
// 纯函数、无副作用、不 import React 与 '@/' 别名（照 lib/knowledgeTree.ts 的 TreeEntryLike 范式
// 自声明最小形状）：node 原生跑 TS 测试时不依赖构建期别名。

/** 块的最小形状（只声明本文件用得到的字段，避免 runtime 依赖 knowledgeApi） */
export interface BlockLike {
  /** 块序号（内核 splitBlocks 给，从 0 起）；缺省时用下标兜底做 key */
  n?: number
  kind: string
  level?: number
  text: string
  line: number
  /** 经验条目标签；非条目标签为 null（后端 `entryTag || null`） */
  tag?: string | null
  full?: string | null
}

export type BlockRender =
  | { type: 'entryCard'; key: string; line: number; tag: string; summary: string; full: string }
  | { type: 'heading'; key: string; line: number; level: number; text: string }
  | { type: 'markdown'; key: string; line: number; text: string }

/**
 * 是否渲染为经验卡片：**kind === 'entry' 且 tag 非空**。
 * 只判 kind === 'entry' 会把任务清单（`- [ ] Step 1`）画成经验卡片 —— 这正是 S1 §11.4 要禁止的。
 * 用 `typeof === 'string' && trim()` 而不是 `!== null`：既覆盖 null（后端契约），也顺带挡住
 * undefined（字段缺失）与纯空白（脏数据），语义仍是"有真标签才算经验"。
 */
export function isEntryCard(b: BlockLike): boolean {
  const tag = b.tag
  return b.kind === 'entry' && typeof tag === 'string' && tag.trim() !== ''
}

/** heading 级别归一：非法（NaN/0/负数/小数）→ 1，上限 6（md 最多 6 级） */
export function clampLevel(level?: number): number {
  const l = typeof level === 'number' && Number.isFinite(level) && level >= 1 ? Math.floor(level) : 1
  return Math.min(l, 6)
}

/**
 * 标签去噪（文档标题下的 tag 徽标）：trim + 去空 + 去重 + 忽略非字符串。
 * 后端 tags 来自 frontmatter 自由文本与条目 tag 聚合，出现空串/重复是常态。
 */
export function normalizeTags(tags?: readonly unknown[] | null): string[] {
  const out: string[] = []
  for (const raw of tags ?? []) {
    const t = typeof raw === 'string' ? raw.trim() : ''
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/**
 * 块数组 → 渲染计划（保持原文顺序与行号）。
 * 空文本块直接丢弃：react-markdown 渲染空串只会留下一个吃掉间距的空 div，
 * 而它也不可能是跳转目标（无内容可看）。
 */
export function planBlockRender(blocks: readonly BlockLike[]): BlockRender[] {
  const out: BlockRender[] = []
  blocks.forEach((b, i) => {
    const key = `b${b.n ?? i}`
    const line = typeof b.line === 'number' && Number.isFinite(b.line) ? b.line : 0
    if (isEntryCard(b)) {
      const summary = String(b.text ?? '').trim()
      const full = String(b.full ?? '').trim()
      out.push({ type: 'entryCard', key, line, tag: String(b.tag).trim(), summary, full: full || summary })
      return
    }
    const text = String(b.text ?? '')
    if (!text.trim()) return
    if (b.kind === 'heading') {
      out.push({ type: 'heading', key, line, level: clampLevel(b.level), text: text.trim() })
      return
    }
    out.push({ type: 'markdown', key, line, text })
  })
  return out
}

/**
 * 目标行 → 渲染计划里的下标（检索命中跳转用）。
 * 取「line <= targetLine 的最后一个块」：行号指向某块内部的某一行时，跳到该块才是对的位置。
 * 返回 null 的情况：无目标行（null/NaN/0/负数）或计划为空 —— 调用方据此不做滚动、也不高亮。
 * targetLine 早于首块（例如落在 frontmatter 区）→ 0（首块），不能让"跳转"静默失效。
 */
export function pickTargetIndex(renders: readonly BlockRender[], targetLine?: number | null): number | null {
  if (!renders.length) return null
  if (typeof targetLine !== 'number' || !Number.isFinite(targetLine) || targetLine < 1) return null
  let found: number | null = null
  for (let i = 0; i < renders.length; i++) {
    if (renders[i].line <= targetLine) found = i
    else break                       // 块按行号升序（splitBlocks 顺序产出），首个超出即可停
  }
  return found ?? 0
}
