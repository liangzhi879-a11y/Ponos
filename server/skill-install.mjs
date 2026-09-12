// 内置技能安装/更新器（2026-09-12 P2-2；与 workflow-install.mjs 同族、同语义）
// ---------------------------------------------------------------------------
// 病灶：autoInstallSamples 原先有两处短路——① `.auto-installed.json` 标记存在即整体
// return；② 逐个技能 `existsSync(target)` 即跳过。两处叠加的后果：**内置技能的后续更新
// 永远到不了用户的 ~/.yfw/skills**。实证：live home 的 using-superpowers/SKILL.md 里
// 没有 triggers（源码已加），11 个技能的触发词修复对存量安装等于没做——正是"优化了却
// 看不到效果"的一条机械原因。工作流安装器早就按"版本/内容比对 → 备份后覆盖"工作，
// 技能安装器缺这一环。
//
// 方案：marker 从"一次性开关"改成**指纹台账**（files: '<id>/<相对路径>' → 上次写入
// 内容的 sha256 前 16 位），逐文件比对：
//   · 已装内容 == 内置源（按 {{YFW_SKILLS}} 重写后）→ 无变化，跳过（幂等，零抖动）
//   · 有差异且指纹与台账相符 → 该文件自安装后没被动过 ⇒ 备份 SKILL.md 后覆盖
//   · 有差异但指纹对不上（台账里另有一个值）⇒ 用户改过 ⇒ 整个技能跳过，绝不覆盖
// 基准用"重写后的内容"而非源文件字节：文本文件里 {{YFW_SKILLS}} 会被替换成真实技能根，
// 与源文件本就不同——按源字节比会把每个含占位符的技能都误判成"用户改过"，于是永远不更新。
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, sep, basename, relative } from 'node:path'
import { createHash } from 'node:crypto'

// 需要做 {{YFW_SKILLS}} 重写的文本类扩展名（二进制原样拷贝）
export const SKILL_TEXT_RE = /\.(md|py|json|txt|yaml|yml|js|mjs|cjs|ts|html|css|sh|bat|cmd|csv)$/i
export const SKILLS_PLACEHOLDER = '{{YFW_SKILLS}}'

// 递归拷贝技能目录，把 {{YFW_SKILLS}} 重写成真实技能根（打包后仍可移植）。
// 单技能安装与首轮批量安装共用；已存在的目标文件会被覆盖。
export function copyWithRewrite(srcDir, destDir, placeholder, yfwRootAbs) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true })
      copyWithRewrite(src, dest, placeholder, yfwRootAbs)
    } else {
      const raw = readFileSync(src)
      if (SKILL_TEXT_RE.test(entry.name)) writeFileSync(dest, raw.toString('utf-8').split(placeholder).join(yfwRootAbs), 'utf-8')
      else writeFileSync(dest, raw)
    }
  }
}

export function readSkillIndex(idxPath) {
  if (!existsSync(idxPath)) return []
  try {
    const idx = JSON.parse(readFileSync(idxPath, 'utf-8'))
    return Array.isArray(idx) ? idx : []
  } catch {
    return []
  }
}

export function writeSkillIndex(idxPath, index) {
  writeFileSync(idxPath, JSON.stringify(index, null, 2), 'utf-8')
}

// 写入/刷新单个技能的索引条目。更新既有条目时保留 enabled/installed_at——用户可能在
// 面板里停用过该技能，整体替换会把它悄悄启用回来。
export function writeSkillIndexEntry({ skillRoot, id, srcDir }) {
  const idxPath = join(skillRoot, '_skill_index.json')
  const mdPath = join(skillRoot, id, 'SKILL.md')
  if (!existsSync(mdPath)) return
  const md = readFileSync(mdPath, 'utf-8')
  const yamlMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  let ver = ''
  let desc = ''
  if (yamlMatch) {
    const grab = (k) => {
      const m = yamlMatch[1].match(new RegExp('^' + k + ':\\s*["\']?(.+?)["\']?\\s*$', 'm'))
      return m ? m[1].trim() : ''
    }
    ver = grab('version')
    desc = grab('description')
  }
  const index = readSkillIndex(idxPath)
  const at = index.findIndex(s => s && s.id === id)
  const prev = at >= 0 ? index[at] : null
  const entry = {
    id, name: id, description: desc || id,
    version: ver || '0.0.0', triggers: [],
    lines: md.split('\n').length, size_kb: Math.round(md.length / 1024),
    installed_at: (prev && prev.installed_at) || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    installed_from: 'builtin',
    source_path: String(srcDir).replace(/\\/g, '/'),
    dependencies: [], enabled: prev && typeof prev.enabled === 'boolean' ? prev.enabled : true,
  }
  if (at >= 0) index[at] = entry
  else index.push(entry)
  writeSkillIndex(idxPath, index)
}

// 内容指纹（前 16 位十六进制；非密码用途，只判漂移）
function sha16(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

// 文本类内容指纹：**行尾归一后**再哈希（CRLF/LF 不算内容差异）。
// 实证依据：live home 里 350/361 个内置文件与源逐字符相同，但其中 ~23 个只差行尾
// （checkout 的 autocrlf 与历史写入路径不一致）——按字节比会把它们全判成"要更新"，
// 每次更新还各留一个 .bak，纯噪音。"用户改过"应当指内容变了，不是行尾变了。
function textHash(buf) {
  return sha16(Buffer.from(buf.toString('utf-8').replace(/\r\n/g, '\n'), 'utf-8'))
}

// 文件**安装后**应有的内容指纹（文本文件先做占位符重写，二进制原样）
function installedHash(srcPath, placeholder, yfwRootAbs) {
  const raw = readFileSync(srcPath)
  if (!SKILL_TEXT_RE.test(basename(srcPath))) return sha16(raw)
  return textHash(Buffer.from(raw.toString('utf-8').split(placeholder).join(yfwRootAbs), 'utf-8'))
}

// 已装文件的现状指纹：与 installedHash **同一基准**（否则行尾差异会被误判成用户改动，
// 而台账里记的又是一个基准 ⇒ 自我矛盾，技能会被永久标成 kept 再也不更新）。
function liveHash(p) {
  const raw = readFileSync(p)
  if (!SKILL_TEXT_RE.test(basename(p))) return sha16(raw)
  return textHash(raw)
}

// 目录内全部文件（相对路径，'/' 分隔，排序稳定）
function listFilesRel(root, base = root) {
  const out = []
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) out.push(...listFilesRel(p, base))
    else out.push(relative(base, p).split(sep).join('/'))
  }
  return out.sort()
}

// 单个技能/共享库的"装 / 更新 / 跳过"决策与执行。manifest.files 就地更新。
// 返回：'installed' | 'updated' | 'unchanged' | 'kept-user-modified' | 'skipped-empty'
export function upsertSkill({ srcRoot, dstRoot, id, manifest }) {
  const srcDir = join(srcRoot, id)
  const dstDir = join(dstRoot, id)
  const rootAbs = String(dstRoot).replace(/\\/g, '/')
  const isNew = !existsSync(dstDir)
  const rels = listFilesRel(srcDir)
  if (rels.length === 0) return 'skipped-empty'
  const changed = []
  const userEdited = []
  for (const rel of rels) {
    const parts = rel.split('/')
    const dstFile = join(dstDir, ...parts)
    const key = id + '/' + rel
    const want = installedHash(join(srcDir, ...parts), SKILLS_PLACEHOLDER, rootAbs)
    if (!existsSync(dstFile)) { changed.push(rel); continue }
    let have
    try { have = liveHash(dstFile) } catch { changed.push(rel); continue }
    if (have === want) {
      manifest.files[key] = have // 已是最新内置版：顺手记指纹（供日后判断"用户是否动过"）
      continue
    }
    const recorded = manifest.files[key]
    if (recorded && recorded !== have) userEdited.push(rel)
    else changed.push(rel)
  }
  if (!isNew && userEdited.length > 0) return 'kept-user-modified'
  if (changed.length === 0) return 'unchanged'
  if (!isNew) {
    // 备份后覆盖（与工作流安装器同语义）：**每个**将被改写且内容确有差异的文件各留一份
    // <文件名>.bak。只备份 SKILL.md 不够——技能目录里还有 lib/脚本/引用文档，用户手改的
    // 若是这些，覆盖就无副本可回退（台账缺失的首扫正属"未知漂移"，风险最高）。
    for (const rel of changed) {
      try {
        const parts = rel.split('/')
        const dstFile = join(dstDir, ...parts)
        if (existsSync(dstFile)) copyFileSync(dstFile, dstFile + '.bak')
      } catch { /* 备份失败不阻断（下面仍然覆盖） */ }
    }
    try {
      const md = join(dstDir, 'SKILL.md')
      if (existsSync(md)) copyFileSync(md, join(dstDir, 'SKILL.md.bak'))
    } catch { /* 同上 */ }
  }
  mkdirSync(dstDir, { recursive: true })
  copyWithRewrite(srcDir, dstDir, SKILLS_PLACEHOLDER, rootAbs)
  for (const rel of rels) {
    const key = id + '/' + rel
    try { manifest.files[key] = liveHash(join(dstDir, ...rel.split('/'))) } catch { /* 读回失败则下次按未知处理 */ }
  }
  return isNew ? 'installed' : 'updated'
}

/**
 * 安装/更新全部内置技能（srcRoot 下的目录形态技能 + _common 共享库）。
 * 与 installBuiltinWorkflows 同风格：无副作用日志，返回统计对象由调用方打印。
 * 台账（files 指纹表）随每次扫描写回——它记录"我们写下去的字节"，与本次是否失败无关；
 * 失败项下次会因内容不符自然重试，而写回台账能保住"用户改过"的记忆，避免下次把
 * 用户改动当成未知而覆盖。
 */
export function installBuiltinSkills({ srcRoot, dstRoot, manifestPath }) {
  const out = { installed: [], updated: [], kept: [], unchanged: 0, failed: [], files: {} }
  if (!srcRoot || !dstRoot || !existsSync(srcRoot)) return out
  let manifest = { files: {} }
  if (manifestPath && existsSync(manifestPath)) {
    try { manifest = { ...manifest, ...JSON.parse(readFileSync(manifestPath, 'utf-8')) } } catch { /* 损坏 → 空台账 */ }
  }
  if (!manifest.files || typeof manifest.files !== 'object') manifest.files = {}
  let dirs = []
  try { dirs = readdirSync(srcRoot, { withFileTypes: true }) } catch { return out }
  const ids = dirs
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(srcRoot, d.name, 'SKILL.md')))
    .map((d) => d.name)
  if (existsSync(join(srcRoot, '_common'))) ids.push('_common')
  for (const id of ids) {
    try {
      const st = upsertSkill({ srcRoot, dstRoot, id, manifest })
      if (st === 'installed') {
        out.installed.push(id)
        if (id !== '_common') writeSkillIndexEntry({ skillRoot: dstRoot, id, srcDir: join(srcRoot, id) })
      } else if (st === 'updated') {
        out.updated.push(id)
        if (id !== '_common') writeSkillIndexEntry({ skillRoot: dstRoot, id, srcDir: join(srcRoot, id) })
      } else if (st === 'kept-user-modified') out.kept.push(id)
      else out.unchanged += 1
    } catch (e) {
      out.failed.push({ id, error: e?.message || String(e) })
    }
  }
  out.files = manifest.files
  if (manifestPath) {
    try {
      writeFileSync(manifestPath, JSON.stringify({ installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), count: out.installed.length, files: manifest.files }, null, 2), 'utf-8')
    } catch { /* 台账写失败仅影响下次判据 */ }
  }
  return out
}
