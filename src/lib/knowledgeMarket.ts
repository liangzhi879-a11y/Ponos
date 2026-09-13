// src/lib/knowledgeMarket.ts —— 知识包市场的**纯逻辑**（S4 Task 6）
//
// 为什么单列一个 lib：仓库没有 DOM 测试环境（spec §11.1），组件只能人工走查；
// 把"筛选 / 徽标判定 / 表单校验 / 状态分类 / 体积格式化"抽出来，就能用 `node:test` 钉住——
// 其中几条恰好是最容易写错又最难肉眼发现的地方：
//   · 清单条目已装且**清单版本更高**才算"可更新"（相等或更低都不是）；
//   · 冲突态是 403 而不是失败，UI 要弹三选，不能显示成红色报错；
//   · 导出表单的 id/version/license 规则必须与后端 `validatePackManifest` 一致
//     （先说清再发请求，省掉一个 400 往返）。
import type { KnowledgePackIndexItem, KnowledgePackVersionDecision, PackInstallStatus } from './knowledgePacksApi.ts'

/**
 * 冲突三选（`installPack` 的 `mode` 取值）。**为什么在 lib 里定义而不是从 API 层 import**：
 * API 层把后端的 `options` 原样收成 `string[]`（它不该替后端做枚举裁决）；三选是**本 GUI 的
 * 展示契约**（三个按钮 = 三种 mode），故联合类型与白名单归这里，与 CONFLICT_OPTIONS 同源。
 */
export type PackConflictOption = 'overwrite' | 'keep' | 'to-my-space'

/** "全部标签"哨兵：用空串而不是 `null`，因为 `<select>` 的值只能是字符串 */
export const PACK_TAG_ALL = ''

/** 清单里的标签去重排序（下拉选项；按中文习惯排序，纯英文标签也不至于乱序） */
export function collectPackTags(packs: readonly KnowledgePackIndexItem[]): string[] {
  const set = new Set<string>()
  for (const p of packs || []) {
    for (const t of p?.tags || []) {
      const s = String(t).trim()
      if (s) set.add(s)
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

export interface PackFilter {
  /** 关键词：匹配 id / name / description / author / tags（大小写不敏感） */
  q?: string
  /** 精确标签；空串 = 全部 */
  tag?: string
}

/**
 * 列表筛选。**空值一律放行**——"没填关键词"与"匹配不到"是两件事，
 * 若把空串当关键词就会得到永远为空的列表（这类 bug 在 GUI 上表现为"市场是空的"）。
 */
export function filterPacks(packs: readonly KnowledgePackIndexItem[], filter: PackFilter = {}): KnowledgePackIndexItem[] {
  const tag = String(filter.tag ?? PACK_TAG_ALL)
  const needle = String(filter.q ?? '').trim().toLowerCase()
  return (packs || []).filter((p) => {
    if (tag && !(p.tags || []).some((t) => String(t) === tag)) return false
    if (!needle) return true
    const hay = [p.id, p.name, p.description, p.author, ...(p.tags || [])].join(' ').toLowerCase()
    return hay.includes(needle)
  })
}

/** 列表角标：可更新 > 已安装 > 可安装（三者互斥，按此优先级取一个，避免条目上挂两个徽标） */
export type PackBadge = 'update' | 'installed' | 'available'

export function packBadge(pack: KnowledgePackIndexItem): PackBadge {
  if (pack?.updateAvailable) return 'update'
  return pack?.onDisk ? 'installed' : 'available'
}

/** 安装结果的三种处置：成功落盘 / 需用户三选 / 被拒 */
export type InstallKind = 'ok' | 'conflict' | 'rejected'

/** 四态成功 + `to-my-space`（第三选）都算"已处理完"，只有 `kept-user-modified` 需用户决策 */
export function isInstallOk(status: PackInstallStatus | string): boolean {
  return status === 'installed' || status === 'updated' || status === 'unchanged' || status === 'to-my-space'
}

export function classifyInstallStatus(status: PackInstallStatus | string): InstallKind {
  if (isInstallOk(status)) return 'ok'
  // kept-user-modified：后端**一个字节都没写**（spec §11.3 R3）——UI 要弹三选而非报错
  if (status === 'kept-user-modified') return 'conflict'
  return 'rejected'
}

/** 三选（与后端 `installPack` 返回的 options 逐字一致）；顺序即 UI 展示顺序 */
export const CONFLICT_OPTIONS: readonly PackConflictOption[] = ['overwrite', 'keep', 'to-my-space']

/**
 * 后端给的 options 归一：只认白名单三项（后端若加值，前端不能凭空造按钮——
 * 点了没实现的 mode 会被后端 400）。为空时回落到默认三项（老版本后端不返回 options 时仍可用）。
 */
export function normalizeConflictOptions(options: unknown): PackConflictOption[] {
  const list = Array.isArray(options) ? options.map(String) : []
  const hit = CONFLICT_OPTIONS.filter((o) => list.includes(o))
  return hit.length ? hit : [...CONFLICT_OPTIONS]
}

export type VersionTone = 'current' | 'fallback' | 'needs-higher-app' | 'unknown'

/**
 * 版本判定 → 展示语气。`fallback` 是"包给了旧版本所以能装"，必须显式告知
 * （用户以为装的是清单里的最新版，实际拿到的是回退版本，不说明就是误导）。
 */
export function versionTone(decision: KnowledgePackVersionDecision | null | undefined): VersionTone {
  const r = String(decision?.reason ?? '')
  if (r === 'current') return 'current'
  if (r === 'fallback') return 'fallback'
  if (r === 'needs-higher-app') return 'needs-higher-app'
  return 'unknown'
}

/** 体积展示（清单给的是字节）。用 1024 进制并保留一位小数，够读且不虚报精度 */
export function formatBytes(n: unknown): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  if (v < 1024) return `${Math.round(v)} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(1)} MB`
}

/** 与 `shared/knowledge-pack.mjs` 的 PACK_ID_RE 同规则（导出表单本地先校验，后端仍是最终裁决） */
export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** 与 `shared/knowledge-pack.mjs` 的 parseSemver 同口径（三段 + 可选预发布后缀） */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export type ExportField = 'id' | 'version' | 'license' | 'name'

/**
 * 导出表单校验：返回**非法字段名**（空数组 = 可提交）。
 * 返回字段名而不是文案，是为了让组件把 `t('knowledge.marketExportErrId')` 映射上去——
 * lib 层不该知道 i18n 键。
 */
export function validateExportForm(form: { id?: string; version?: string; license?: string; name?: string }): ExportField[] {
  const bad: ExportField[] = []
  const id = String(form?.id ?? '').trim()
  if (!PACK_ID_RE.test(id)) bad.push('id')
  if (!SEMVER_RE.test(String(form?.version ?? '').trim())) bad.push('version')
  // license 是硬失败项（spec §6）：导出侧也拦一道，避免产出"自己都装不回去"的包
  if (!String(form?.license ?? '').trim()) bad.push('license')
  if (String(form?.name ?? '').trim().length > 80) bad.push('name')
  return bad
}

/**
 * 本地文件安装是否可用：只有桌面版（preload 暴露了 `openKnowledgePack`）才能弹系统文件对话框。
 * 浏览器里跑 dev 时该 API 不存在——此时给"仅桌面版支持"的显式提示，而不是抛 TypeError。
 */
export function localInstallSupported(fileApi: { openKnowledgePack?: unknown } | undefined | null): boolean {
  return typeof fileApi?.openKnowledgePack === 'function'
}

/** 市场"来源"一行的语气：本地清单 = 未联网（企业内网的关键状态，必须一眼可见） */
export function sourceLabel(source: string): 'local' | 'remote' | 'none' {
  return source === 'local' || source === 'remote' ? source : 'none'
}
