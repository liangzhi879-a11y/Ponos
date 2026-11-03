// kernel/skill-drafts.mjs —— 草稿区的**唯一写盘/读取入口**（spec §5.1/§5.5）。
//
// ## 为什么草稿必须走这里而不是直接 fs
//
// 1. **路径白名单**：所有写操作只允许落 `<configDir>/skills/.drafts/<id>/`，
//    任何 `..`/绝对路径/分隔符越界都在 safeId 处被拒——这是"草稿不可见"之外的
//    第二道防线（防 agent 借草稿写通道写到技能根或仓外）。
// 2. **写后回读校验**：原子替换（tmp + rename）后必须回读确认内容一致，
//    否则"返回 ok 但盘上是旧内容/半截文件"无从发现。
// 3. **校验前置**：落盘前先过 validateDraft 硬门，坏内容根本不进盘。
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
// ★ 2026-10-18：草稿是用户内容、不可重建，落盘必须 fsync 后 rename（防断电留空/半截文件）
import { writeFileAtomicSync } from '../shared/atomic-write.mjs'
import { join, resolve } from 'node:path'
import { validateDraft, ID_RE } from './skill-forge.mjs'

/** 草稿区目录名。点开头 ⇒ 技能发现（kernel/skills.mjs）的两形态（目录/平铺）都不命中。 */
export const DRAFT_DIR_NAME = '.drafts'

export const draftsRoot = ({ configDir }) => join(configDir, 'skills', DRAFT_DIR_NAME)

/**
 * 草稿目录的**内部命名空间**：以 `_` 开头的文件属草稿区私有（当前仅 `_meta.json`：
 * origin/intent/sourcePath 等来源信息），**安装到技能根时必须排除**。
 *
 * 为什么要有这条显式约定（2026-09-23 实测缺陷）：`server/skill-forge-routes.mjs` 的安装流程
 * 原先整目录复制，把 `_meta.json` 一起复制进 `<skills>/<id>/`，**污染用户技能目录**；
 * 更坏的是返回给调用方的 `files` 列表当时又把它过滤掉了 ⇒ 报告与磁盘不一致
 * （"说没带、其实带了"，比污染本身更难发现）。故把"何为内部文件"登记在此单一真源，
 * 安装侧按它排除，并由 server/skill-forge-routes.test.mjs 钉住。
 */
export const DRAFT_INTERNAL_PREFIX = '_'

/** 判某文件名是否属草稿内部命名空间（安装时排除）。 */
export const isInternalDraftFile = (name) => String(name || '').startsWith(DRAFT_INTERNAL_PREFIX)

function safeId(id) {
  const s = String(id || '').trim()
  if (!ID_RE.test(s)) return null
  // ID_RE 已排除分隔符；这里再加一层防改 ID_RE 后忘记同步的兜底
  if (s.includes('..') || s.includes('/') || s.includes('\\')) return null
  return s
}

/**
 * 原子写：**fsync + rename** + 回读校验（回读不一致 = 失败，不假装成功）。
 *
 * ★ 2026-10-18：改用 `writeFileAtomicSync`（它 open+write+**fsync**+rename 重试+失败清理齐全）。
 *   原来手写 `writeFileSync(tmp) + renameSync` **没有 fsync** —— 断电时 rename 可能先于
 *   数据落盘被持久化 ⇒ 草稿文件变空或半截。草稿是**用户写的内容**，不可重建，
 *   而写坏的后果是"草稿打开是空的"（用户以为丢稿）。
 *   回读校验保留（原实现的优点）：现在校验的是**最终文件**，比原来更准。
 */
function atomicWriteText(file, content) {
  writeFileAtomicSync(file, content)
  const back = readFileSync(file, 'utf-8')
  if (back !== content) {
    throw new Error(`写后回读不一致：${file}`)
  }
}

/**
 * 写草稿（先硬门校验，后落盘）。
 * @param {{ configDir?: string, id?: string, content?: string, existingIds?: string[], meta?: object }} [p]
 * @returns {{ ok: true, path: string, warnings: Array } | { ok: false, errors: Array }}
 */
export function writeDraft({ configDir, id, content, existingIds = [], meta = {} } = {}) {
  const validation = validateDraft({ id, content, existingIds })
  if (!validation.ok) return { ok: false, errors: validation.errors }
  const sid = safeId(id)
  if (!sid) return { ok: false, errors: [{ code: 'ID_FORMAT', message: `id "${id}" 不允许作为草稿目录名` }] }

  const dir = join(draftsRoot({ configDir }), sid)
  mkdirSync(dir, { recursive: true })
  atomicWriteText(join(dir, 'SKILL.md'), String(content || ''))
  atomicWriteText(join(dir, '_meta.json'), JSON.stringify(
    { id: sid, updatedAt: new Date().toISOString(), ...meta }, null, 2))
  return { ok: true, path: join(dir, 'SKILL.md'), warnings: validation.warnings }
}

/**
 * 读草稿；不存在返回 null。
 * @param {{ configDir?: string, id?: string }} [opts]
 */
export function readDraft({ configDir, id } = {}) {
  const sid = safeId(id)
  if (!sid) return null
  const file = join(draftsRoot({ configDir }), sid, 'SKILL.md')
  try {
    const content = readFileSync(file, 'utf-8')
    let meta = {}
    try { meta = JSON.parse(readFileSync(join(draftsRoot({ configDir }), sid, '_meta.json'), 'utf-8')) } catch { meta = {} }
    return { id: sid, content, meta, path: file }
  } catch { return null }
}

/**
 * 列出所有草稿（id + 校验状态 + meta），供 GUI 草稿列表用。
 * @param {{ configDir?: string }} [opts]
 */
export function listDrafts({ configDir } = {}) {
  const root = draftsRoot({ configDir })
  let names = []
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  return names
    .filter((n) => ID_RE.test(n))
    .map((n) => {
      const d = readDraft({ configDir, id: n })
      if (!d) return null
      return { id: n, meta: d.meta, validation: validateDraft({ id: n, content: d.content, existingIds: [] }) }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.meta?.updatedAt || '').localeCompare(String(a.meta?.updatedAt || '')))
}

/**
 * 删除草稿目录（幂等：不存在也算成功）。
 * @param {{ configDir?: string, id?: string }} [opts]
 */
export function removeDraft({ configDir, id } = {}) {
  const sid = safeId(id)
  if (!sid) return { ok: false, error: 'id 不合法' }
  rmSync(join(draftsRoot({ configDir }), sid), { recursive: true, force: true })
  return { ok: true }
}
