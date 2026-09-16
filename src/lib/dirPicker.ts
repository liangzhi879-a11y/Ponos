// src/lib/dirPicker.ts —— 工作目录选择器的纯逻辑层
//
// spec：docs/superpowers/specs/2026-09-15-workdir-picker-design.md
//
// 为什么单独成层：面包屑切分、历史栈、快捷入口归一都是**有边界条件**的逻辑
// （Windows 盘符 / POSIX 根 / 尾部斜杠 / "…" 折叠 / 前后退越界），
// 而仓库的 `.tsx` 无法被 `node --test` import —— 写进组件就等于没有单测。

/** 快捷入口（桌面/文档/下载…），由 bridge `/known-folders` 提供 */
export interface QuickFolder {
  name: string
  path: string
  kind: string
}

/** 面包屑的一段：label 是显示名，path 是点击后应跳转的完整路径 */
export interface Crumb {
  label: string
  path: string
}

/** 浏览历史（浏览器式） */
export interface HistoryState {
  stack: string[]
  index: number
}

/** 历史上限：防止长时间浏览后无限增长（只用于来回切换，不需要完整流水） */
export const HISTORY_LIMIT = 100

/** 折叠时用的占位段（path 为空 ⇒ 渲染成不可点击的省略号） */
export const FOLD_PLACEHOLDER: Crumb = { label: '…', path: '' }

const isWinDrive = (s: string): boolean => /^[a-zA-Z]:$/.test(s)

/** 统一分隔符并去掉尾部斜杠（保留根：'C:/' 与 '/'） */
export function normalizePath(path: string): string {
  const p = (path || '').trim().replace(/\\/g, '/')
  if (!p) return ''
  // 折叠重复斜杠（但 '//server/share' 这类 UNC 前缀保留双斜杠）
  const uncMatch = /^\/\/[^/]+\/[^/]+/.exec(p)
  if (uncMatch) {
    return uncMatch[0] + p.slice(uncMatch[0].length).replace(/\/+/g, '/').replace(/\/$/, '')
  }
  const collapsed = p.replace(/\/+/g, '/')
  // 根不剥：'C:/' 与 '/'
  if (collapsed === '/' || /^[a-zA-Z]:\/$/.test(collapsed)) return collapsed
  return collapsed.replace(/\/$/, '')
}

/**
 * 面包屑：把路径切成"每级可点"的段。
 *   'C:/Users/me/Documents' → [C: → C:/, Users → C:/Users, me → …, Documents → 全路径]
 *   '/home/me'              → [/ → /, home → /home, me → /home/me]
 * 输入为空 ⇒ 空数组（渲染成"未选择"而不是崩）。
 */
export function breadcrumbSegments(path: string): Crumb[] {
  const norm = normalizePath(path)
  if (!norm) return []
  const parts = norm.split('/').filter(Boolean)
  const out: Crumb[] = []
  if (norm.startsWith('//')) {
    // UNC：\\server\share\dir —— 头两段合成一个不可再分的根
    const root = `//${parts[0]}/${parts[1] ?? ''}`
    out.push({ label: root, path: root })
    let acc = root
    for (const seg of parts.slice(2)) {
      acc = `${acc}/${seg}`
      out.push({ label: seg, path: acc })
    }
    return out
  }
  if (norm.startsWith('/')) {
    out.push({ label: '/', path: '/' })       // POSIX 根
    let acc = ''
    for (const seg of parts) {
      acc = `${acc}/${seg}`
      out.push({ label: seg, path: acc })
    }
    return out
  }
  // Windows 盘符根（'C:/a/b'）
  const drive = parts[0]
  const driveRoot = isWinDrive(drive) ? `${drive}/` : drive
  out.push({ label: isWinDrive(drive) ? drive : drive, path: driveRoot })
  let acc = isWinDrive(drive) ? drive : ''
  for (const seg of parts.slice(1)) {
    acc = `${acc}/${seg}`
    out.push({ label: seg, path: acc })
  }
  return out
}

/**
 * 折叠过长面包屑：保留 **首级 + … + 末两级**（D6）。
 * 为什么保末两级而不是只保末级：末级是当前位置、倒数第二级是"从哪进来"，
 * 用户回退时最常点的就是这两级；中间层级靠 Up/后退即可。
 */
export function foldBreadcrumb(segs: Crumb[], maxItems = 4): Crumb[] {
  if (!Array.isArray(segs)) return []
  if (segs.length <= maxItems || maxItems < 3) return segs
  const tail = maxItems - 2
  return [segs[0], FOLD_PLACEHOLDER, ...segs.slice(segs.length - tail)]
}

/** 初始历史 */
export function initHistory(path = ''): HistoryState {
  const norm = normalizePath(path)
  return norm ? { stack: [norm], index: 0 } : { stack: [], index: 0 }
}

/**
 * 记录一次跳转。同一路径重复跳转不产生新历史（否则"点了没反应"却把历史撑满）。
 * 若当前不在栈顶（用户后退过），前进分支被截断——这与浏览器一致。
 */
export function pushHistory(state: HistoryState, path: string): HistoryState {
  const norm = normalizePath(path)
  if (!norm) return state
  if (state.stack[state.index] === norm) return state
  const kept = state.stack.slice(0, state.index + 1)
  kept.push(norm)
  const overflow = Math.max(0, kept.length - HISTORY_LIMIT)
  const stack = overflow ? kept.slice(overflow) : kept
  return { stack, index: stack.length - 1 }
}

/** 后退；已在最早 ⇒ 原样返回（不越界、不报错） */
export function goBack(state: HistoryState): HistoryState {
  return state.index > 0 ? { ...state, index: state.index - 1 } : state
}

/** 前进；已在最新 ⇒ 原样返回 */
export function goForward(state: HistoryState): HistoryState {
  return state.index < state.stack.length - 1 ? { ...state, index: state.index + 1 } : state
}

export const canGoBack = (s: HistoryState): boolean => s.index > 0
export const canGoForward = (s: HistoryState): boolean => s.index < s.stack.length - 1
export const currentPath = (s: HistoryState): string => s.stack[s.index] ?? ''

/**
 * 归一 bridge `/known-folders` 的返回。
 * **不信任形状**：IPC/HTTP 对面可能返回缺字段或类型不对的对象（版本不匹配、旧产物），
 * 逐项校验后丢弃脏数据，避免把 undefined 渲染成可点击项（点下去必然报错）。
 */
export function normalizeFolders(raw: unknown): QuickFolder[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { folders?: unknown }).folders
  if (!Array.isArray(list)) return []
  const out: QuickFolder[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const name = (item as { name?: unknown }).name
    const path = (item as { path?: unknown }).path
    const kind = (item as { kind?: unknown }).kind
    if (typeof name !== 'string' || !name) continue
    if (typeof path !== 'string' || !path) continue
    const norm = normalizePath(path)
    if (!norm || seen.has(norm)) continue    // 去重：同一目录出现两次会渲染成重复项
    seen.add(norm)
    out.push({ name, path: norm, kind: typeof kind === 'string' ? kind : 'other' })
  }
  return out
}

/**
 * 地址栏输入清洗：去首尾空白、剥成对引号（用户常从资源管理器复制 "C:\path" 带引号）、
 * 统一为正斜杠。返回 '' 表示无有效输入（调用方据此不发请求）。
 */
export function cleanPathInput(input: string): string {
  if (typeof input !== 'string') return ''
  let s = input.trim()
  if (s.length >= 2) {
    const first = s[0]
    const last = s[s.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim()
    }
  }
  return normalizePath(s)
}

/** 判断某路径是否在当前路径之下（用于高亮"当前位于哪个快捷入口"） */
export function isSameOrUnder(path: string, base: string): boolean {
  const p = normalizePath(path)
  const b = normalizePath(base)
  if (!p || !b) return false
  if (p === b) return true
  return p.startsWith(b.endsWith('/') ? b : `${b}/`)
}
