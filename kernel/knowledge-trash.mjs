// 知识库回收站（软删除）—— 从 kernel/knowledge.mjs 拆出（2026-09-29 批次 4.2）
//
// **为什么拆这里**（P2 接缝勘察判据①：难度不看行数，看"被拆代码是否共享模块级可变状态"）：
//   knowledge.mjs 2855 行里，`createKnowledgeStore` 的 2100 余行**共享大量闭包状态**
//   （kroot/spaces/docs/idf/inverted/linkOut/lastFiles…）⇒ 属高风险区，不动。
//   而回收站簇（id 形状与生成 / 路径越界防护 / 搬运 / 占用统计 / 台账读写 / 还原让位）
//   **全部是纯函数、只吃入参**，不依赖任何闭包状态 ⇒ 是本文档里唯一的低风险切面。
//
// **为什么 trashRoot 不在这里**：它依赖 `knowledgeRoot(configDir)`（knowledge.mjs 的导出），
//   搬过来会形成 knowledge.mjs ↔ knowledge-trash.mjs 的**循环导入** ⇒ 留在原处，
//   从本模块取 `TRASH_DIR_NAME` 常量。
//
// **公开 API 未变**：knowledge.mjs 继续（转发）导出 trashRoot / isTrashId / newTrashId，
//   调用方与测试无需改动（kernel-tests/knowledge-trash.test.mjs 的导入一行未改）。
//
// **回退方式**：把本文件内容并回 knowledge.mjs 的同一位置（见 git 历史），删本文件即可。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { writeFileAtomicSync } from '../shared/atomic-write.mjs'
// ── 回收站（软删除，2026-09-14）──────────────────────────────────────────────
// 设计见 .yfw-spec/knowledge-trash/spec.md。三条不变量，改本段前先读它们：
//   ① 除 purge 外**不做任何物理删除**（`movePath` 的跨盘兜底 rm 只删"已经复制成功"的源）；
//   ② 回收站放 `<knowledge>/.trash`（不在各空间内）：`walkMd` 跳过 `.` 开头的目录 ⇒
//      回收站天然不进索引（索引层零改动）；且删整库时不会把回收站一起搬走；
//   ③ 删除权限判定**独立于 `writable`**：内置经验空间的 `writable === true`（记忆需要能写），
//      照它放行会直接删掉用户的 `~/.ponos/memory/personal`。
export const TRASH_DIR_NAME = '.trash'
/** `YYYYMMDD-HHmm-<4位小写字母数字>`。purge 是唯一物理删除路径，形状校验是它的第一道闸。 */
const TRASH_ID_RE = /^[0-9]{8}-[0-9]{4}-[0-9a-z]{4}$/


/** trashId 形状校验。`../`、绝对路径、盘符一律不匹配 ⇒ purge 拿不到回收站外的路径。 */
export function isTrashId(v) {
  return TRASH_ID_RE.test(String(v ?? '').trim())
}

/**
 * 生成 trashId（时间可读 + 防同秒冲突）。`taken` 由调用方给（查台账 + 查目录）。
 *
 * ★ 2026-09-29（批次 4.2）：补上 `@param` —— 搬迁后 T3 棘轮立刻报
 *   `kernel/knowledge-trash.mjs(46,33): error TS2554: Expected 0 arguments, but got 1`：
 *   默认值 `() => false` 被 TS 推断成**零参函数**，而实现里调用 `taken(id)` ⇒ 类型错。
 *   原文件里这个错一直在（被 knowledge.mjs 的基线上限"兜住"了），搬到新文件后
 *   因"**新文件必须 0 错**"而暴露 —— 这正是 T3 棘轮该有的作用。
 *   **修类型、不是改基线**（把新文件登记进 byFile 会让"新代码可以带错出生"变成惯例）。
 * @param {(id: string) => boolean} [taken] 判断候选 id 是否已被占用（查回收站台账 + 目录）
 * @returns {string}
 */
export function newTrashId(taken = () => false) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  for (let i = 0; i < 200; i++) {
    const rand = Math.random().toString(36).slice(2).padEnd(4, '0').slice(0, 4)
    const id = `${stamp}-${rand}`
    if (isTrashId(id) && !taken(id)) return id
  }
  // 不返回时间戳外的兜底值：宁可报错，也不覆盖已有回收站条目（那才是真的丢数据）
  throw new Error('trash: 无法生成唯一 trashId（同分钟内 200 次随机全部撞车）')
}

/** 目标路径是否真的落在 root 内（软链接解析后判定）。`..` 已在路径规范化阶段拒掉，这是第二道。 */
export function realpathInside(root, abs) {
  let rootReal
  let absReal
  try { rootReal = realpathSync(root) } catch { return false }
  try { absReal = realpathSync(abs) } catch { return false }
  return absReal === rootReal || absReal.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)
}

/**
 * 相对 .md 路径规范化（删除/还原专用，与 `listTree` 的读侧防护同口径）：
 * 拒绝对路径/盘符/`..`/空段，且必须以 `.md` 结尾 —— 允许删非 md 文件等于把这里变成通用删文件口。
 */
export function normalizeMdRel(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/').trim()
  if (!s) return null
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null
  const parts = s.split('/').filter((p) => p && p !== '.')
  if (!parts.length || parts.some((p) => p === '..')) return null
  if (!/\.md$/i.test(parts[parts.length - 1])) return null
  return parts.join('/')
}

/** 路径占用统计（删前算，删后就没有了）。文件返回自身大小；目录递归求和。 */
export function pathBytes(abs) {
  let st
  try { st = statSync(abs) } catch { return 0 }
  if (st.isFile()) return st.size
  let bytes = 0
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (!e.isFile()) continue
      try { bytes += statSync(p).size } catch { /* 统计失败不影响删除，只是数字略小 */ }
    }
  }
  return bytes
}

/** 目录下的文件相对路径清单（只用于报告"搬走了什么"，不参与删除决策）。 */
export function listRelFiles(abs) {
  const out = []
  let st
  try { st = statSync(abs) } catch { return out }
  if (st.isFile()) return [basename(abs)]
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (e.isFile()) out.push(relative(abs, p).split(sep).join('/'))
    }
  }
  return out
}

/** 先试 rename（同盘原子、最快），EXDEV（跨盘）才退化成"复制成功后再删源"。 */
export function movePath(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
    return 'rename'
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e
  }
  cpSync(from, to, { recursive: true })
  rmSync(from, { recursive: true, force: true }) // 源已完整复制，这里删的是副本的源
  return 'copy'
}

/**
 * 复制路径（2026-09-14 批次 4）。与 `movePath` 唯一的区别是**源保留**。
 * 搬走的场景要 30 秒内跨盘也能用（`cpSync` + `rmSync`），复制场景直接用 `cpSync` 即可 ——
 * 但都要先 `mkdirSync` 父目录，否则 `cpSync` 在父目录不存在时抛 ENOENT。
 */
export function copyPath(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
  return 'copy'
}

/** 台账读写（原子替换：写 .tmp → rename，避免半截 JSON 让整个回收站不可读）。 */
export function readTrashIndex(trashDir) {
  // 安全解析内联（**刻意不依赖 knowledge.mjs 的 readJsonFile**：那会形成循环导入）。
  //   语义与原实现一致：读不到 / 损坏 ⇒ 视为空台账，再由下面的 shape 校验兜底成 `{version,items:[]}`。
  let raw = {}
  try { raw = JSON.parse(readFileSync(join(trashDir, 'index.json'), 'utf-8')) } catch { /* 空台账 */ }
  return { version: 1, items: Array.isArray(raw?.items) ? raw.items : [] }
}

export function writeTrashIndex(trashDir, index) {
  // ★ 批次 4.2：原实现手写"写 .tmp → rename"，与 shared/atomic-write.mjs 的 writeFileAtomicSync
  //   **重复**（同一语义两处实现 ⇒ 必然漂移）。改用 shared 那份：同样保证"要么旧要么新、
  //   不存在半截 JSON"，并额外 mkdir 父目录、rename 前 fsync、失败时清理 tmp。
  //   等价性依据：kernel-tests/knowledge-trash.test.mjs 等回收站测试全绿。
  writeFileAtomicSync(join(trashDir, 'index.json'), JSON.stringify(index, null, 2))
}
export function freeRel(root, rel) {
  const parts = rel.split('/')
  const file = parts.pop()
  const dir = parts.join('/')
  const ext = extname(file)
  const stem = basename(file, ext)
  // 让位名必须把**目录前缀带回去**（`sub/b.md` → `sub/b-2.md`）。只返回 `b-2.md` 会把文件
  // 还原到空间根 —— 看起来"还原成功"，实际位置错了，且原目录下仍然缺这个文件。
  const at = (name) => join(root, ...(dir ? `${dir}/${name}` : name).split('/'))
  if (!existsSync(at(file))) return rel
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem}-${i}${ext}`
    if (!existsSync(at(cand))) return dir ? `${dir}/${cand}` : cand
  }
  return null
}
