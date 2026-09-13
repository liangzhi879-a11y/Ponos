// src/lib/knowledgeTree.ts —— 知识库文件树的**纯逻辑**（排序 / 缩进 / docId 兜底 / 新建名校验）
//
// 为什么单独抽出来：仓库**没有 DOM 测试环境**（spec §11.3），组件只能靠 typecheck + 人工走查，
// 所以凡是能脱离 React 的判断逻辑都往这里放，用 `node --test` 钉住行为：
//   · 缩进公式（深目录不能无限右移，否则窄左栏里文件名被挤没）；
//   · 排序（目录在前 + 数字感知，a2 排 a10 前，且不改动入参数组）；
//   · 新建笔记的文件名校验（**前端提前给友好提示**，而不是把后端 400 原样甩给用户——
//     后端仍会兜底挡穿越/非 md，这里只是把常见误输入在本地解释清楚）。
// 纯函数，无副作用、不 import React / store，任何一端都能无成本复用。

/** 后端 tree 条目最小形状（只声明本文件用得到的字段，避免与 knowledgeApi 循环依赖） */
export interface TreeEntryLike {
  name: string
  path: string
  type: 'dir' | 'file'
}

/**
 * 树缩进：8px 起、每层 +12px、**封顶 120px**。
 * 封顶是必须的：左栏固定 236px，若不封顶，深度 10 层后文件名（+图标）就只剩 0 宽度。
 * 非法输入（NaN/负数/小数）一律按 0 层处理（防御后端返回脏 depth 时整棵树错位）。
 */
export function indentFor(depth: number): number {
  const d = Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 0
  return Math.min(8 + d * 12, 120)
}

/**
 * 目录在前、文件在后；同类按路径 localeCompare（`numeric: true` 让 `a2.md` 排在 `a10.md` 前面，
 * 否则字典序会把 10 排到 2 前面——文件列表里这是最刺眼的一种错序）。
 * 返回**新数组**：store 里的 entries 是跨组件共享的引用，就地 sort 会让别的订阅者看到非预期顺序。
 */
export function sortEntries<T extends TreeEntryLike>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.path.localeCompare(b.path, 'zh-CN', { numeric: true })
  })
}

/** docId 兜底：后端 tree 一般直接给 docId（`${spaceId}/${rel}`），缺失时才本地拼，格式保持一致 */
export function resolveDocId(space: string, path: string): string {
  return `${space}/${String(path ?? '').replace(/^\/+/, '')}`
}

export type NoteNameResult =
  | { ok: true; /** 空间根内相对路径（始终带 .md 后缀） */ path: string; /** 文档标题（首行 `# 标题`） */ title: string }
  | { ok: false; /** empty = 没填；invalid = 形状非法（细分原因对用户没意义，UI 只需一句提示） */ reason: 'empty' | 'invalid' }

/**
 * 新建笔记的文件名校验与归一化。
 * 本任务只支持**空间根下的单层 .md**（子目录选择 UI 留 S3）——所以含 `/`、`\` 一律拒绝，
 * 而不是"聪明地"当子目录处理：路径语义一旦在这里隐式放大，后端穿越防护就成了最后的护栏。
 */
export function normalizeNoteName(input: string): NoteNameResult {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, reason: 'empty' }
  if (/[\\/]/.test(raw)) return { ok: false, reason: 'invalid' }          // 子目录/绝对路径（本任务不支持）
  if (/^\./.test(raw)) return { ok: false, reason: 'invalid' }           // 点开头：后端跳过隐藏项 → 建完看不见
  if (/[:*?"<>|]/.test(raw)) return { ok: false, reason: 'invalid' }     // Windows 非法字符（跨平台一致）
  const title = raw.replace(/\.md$/i, '').trim()
  if (!title) return { ok: false, reason: 'invalid' }                    // 只输 ".md" 等于空名
  return { ok: true, path: `${title}.md`, title }
}
