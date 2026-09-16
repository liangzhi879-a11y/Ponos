// src/lib/skillDetail.ts —— 技能详情（只读）的数据层（2026-09-15，P1 批次二 C）。
//
// ## 为什么单独一个 .ts（而不是写在组件里）
//
// 本仓库单测跑在 Node 原生 `node --test` 上（无 vitest/tsx），**`.tsx` 组件无法被 import**
// （`ERR_UNKNOWN_FILE_EXTENSION`，已实测）。故凡是有判断逻辑的部分都必须落在 `.ts` 模块里才能被
// 直接测试——这正是本文件存在的原因（同 `chatScopeMigration.ts` 的抽出动机）。
// 组件只负责渲染，不承担"错误分类"这类逻辑。
//
// ## 只读纪律（决策 D2）
//
// 本模块**只有 GET**，没有任何写接口。界面上的"管理"= 用系统默认程序打开文件（Electron 既有 IPC
// `openInExplorer` → `shell.openPath`），由用户在自己的编辑器里改。应用永不改写用户的 SKILL.md——
// 这些文件承载着 gztz-*/yfwdoc-* 等大量业务内容，任何"应用规范化写入"都是格式风险。
//
// ## 错误必须可区分
//
// `404` = 技能在磁盘上已不存在（被删/被移）；网络异常 = 桥未就绪；HTTP 错误 = 服务端问题。
// 若都笼统返回空对象，界面只能渲染一张空白面板 —— 用户会以为界面坏了，而不是"这个技能没了"。
export type SkillDetail = {
  id: string
  dir: string
  skillFile: string
  /** true = 平铺式技能（`<root>/<id>.md`，无独立目录 ⇒ 无法列出关联脚本） */
  isFlat: boolean
  triggers: string[]
  parent: string
  /** 'explicit' = 技能文件里**声明**了 parent；'none' = 未声明（界面走前缀启发式兜底，D1） */
  parentSource: 'explicit' | 'none'
  subskills: string[]
  scripts: Array<{ name: string; path: string; sizeKb: number }>
  docs: Array<{ name: string; path: string; sizeKb: number }>
  contentLines: number
}

export type SkillDetailResult = SkillDetail | { error: string }

const BASE = 'http://127.0.0.1:3939'

/** 拉取技能详情；失败返回 `{ error }`（分类见文件头）。**不抛**给渲染层。 */
export async function fetchSkillDetail(id: string): Promise<SkillDetailResult> {
  try {
    const r = await fetch(`${BASE}/skill-detail?id=${encodeURIComponent(id)}`)
    if (r.status === 404) return { error: 'not-found' }
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const j = await r.json() as { ok?: boolean; error?: string } & Partial<SkillDetail>
    if (j.ok === false) return { error: j.error || 'unknown' }
    return j as SkillDetail
  } catch (e) {
    return { error: (e as Error)?.message || 'network' }
  }
}

/**
 * 用系统默认程序打开文件/目录（Electron 既有 IPC `openInExplorer` → `shell.openPath`）。
 * 不在 Electron 环境（如浏览器调试）时**报错**而非静默：静默会让用户以为"点了没反应是正常"。
 * @returns 失败时返回可展示的错误文案，成功返回 null
 */
export async function openLocalPath(p: string): Promise<string | null> {
  const api = (globalThis as unknown as {
    yfworkingAPI?: { openInExplorer?: (p: string) => Promise<{ ok: boolean; error?: string }> }
  }).yfworkingAPI
  if (!api?.openInExplorer) return '当前环境不支持打开本地文件'
  try {
    const res = await api.openInExplorer(p)
    if (res && res.ok === false) return res.error || '打开失败'
    return null
  } catch (e) {
    return (e as Error)?.message || '打开失败'
  }
}
