// kernel/team-sync.mjs —— S3 **内容协同**：团队知识空间 + 经验条目级并集。
//
// 依据 spec §7.1：
//   「内容同步的插入点：知识空间加 `team-<id>`（插在 `shared/knowledge-core.mjs` 的
//     `builtinSpaceSpecs`），**下层检索/切分/关联/路由零改动**」
//   经验同步：经验条目 id **已是内容寻址**（memory.mjs 的 `hashLine`）⇒ **团队经验 = 条目集合，
//   合并 = 集合求并**。同一主题的条目文件都可能出现 ⇒ 按行条目去重。
//
// 【为什么"零改动下层"是硬要求】知识链路（切块/向量/IDF/关联/路由）已被大量测试钉住，且是
// 检索质量的所在。团队空间只是**多一个根目录**：只要 spec 里的 `root` 指向共享目录，下层一切照旧。
// 本文件因此**只做两件事**：① 把团队根目录包成 space spec；② 把"经验条目的并集"算出来落盘。
//
// 【模式语义（§5.9）】受模式影响 = **侧边栏默认列表的筛选范围**；不受影响 = **知识检索范围**
// （默认跨全部空间）。故本文件提供 `sidebarSpaceIds`（UI 用，可随模式变化）而**不提供**任何
// "按模式裁剪检索范围"的入口 —— 后者一旦存在，早晚会被误用成"团队模式下搜不到个人经验"。

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hashLine } from '../shared/knowledge-core.mjs'
import { writeFileAtomicSync } from '../shared/atomic-write.mjs'
import { loadTeamConfig } from './team-store.mjs'
import { writeVerifiedSync, openTeamSource, detectPlaceholderSync } from '../shared/team-source.mjs'

/** 团队源里知识空间与经验的位置（§7.2 只规定同步基础设施；这两处是 S3 定义的内容约定）。 */
export const TEAM_CONTENT_SUBDIR = Object.freeze({ KNOWLEDGE: 'knowledge', EXPERIENCE: 'experience' })

/** 团队知识空间 id（`team-<teamId>`，§7.1 指定）。 */
export function teamSpaceId(teamId) { return `team-${String(teamId)}` }

/** 团队知识空间根目录（在**共享目录**里，因此双方看到的是同一份）。 */
export function teamKnowledgeRoot(teamDir, teamId) {
  return join(String(teamDir), TEAM_CONTENT_SUBDIR.KNOWLEDGE, 'spaces', teamSpaceId(teamId))
}

/** 团队经验目录（共享）。 */
export function teamExperienceDir(teamDir) {
  return join(String(teamDir), TEAM_CONTENT_SUBDIR.EXPERIENCE)
}

/**
 * 由本机团队配置生成**团队空间 spec**（供 `createKnowledgeStore` 的 `builtinSpaceSpecs(..., {extra})`）。
 *
 * 只返回团队源目录**真实存在**的那些：spec 的 `discoverSpaces` 本来就有"目录不存在就不挂"的行为，
 * 这里提前过滤可以让调用方拿到的清单本身就诚实（不会出现"挂着一个永远空的团队空间"）。
 * `writable: true` —— 团队空间是能被团队检索与写入的内容区（写入权限的真实边界仍是网盘 ACL）。
 */
export function teamSpaceSpecs(configDir) {
  const cfg = loadTeamConfig(configDir)
  const out = []
  for (const [teamId, t] of Object.entries(cfg.teams || {})) {
    if (!t || !t.dir) continue
    const root = teamKnowledgeRoot(t.dir, teamId)
    if (!existsSync(root)) continue
    out.push({
      id: teamSpaceId(teamId),
      name: `团队：${t.name || teamId}`,
      description: '团队共享知识（来自团队源目录）',
      root,
      writable: true,
      source: 'team',
      teamId,
    })
  }
  return out
}

/**
 * **安全版** `teamSpaceSpecs`：任何异常（配置缺失/损坏/权限问题）一律退化为 `[]`。
 *
 * 供**生产接线**使用（`kernel/cli.mjs` 的会话知识范围、`kernel/knowledge-cli.mjs` 的 store 创建）：
 * 团队能力是**附加**功能，它出问题绝不能让"知识检索/索引重建"这条主链路起不来 —— 未加入任何团队时
 * 返回空数组，与改造前逐字一致（零回归）。
 */
export function safeTeamSpaceSpecs(configDir) {
  try {
    return teamSpaceSpecs(configDir)
  } catch {
    return []
  }
}

/** 确保团队内容目录存在（首次加入后调用，使空间"可见"）。 */
export function ensureTeamContentDirs(teamDir, teamId) {
  const k = teamKnowledgeRoot(teamDir, teamId)
  const e = teamExperienceDir(teamDir)
  for (const d of [k, e]) { try { mkdirSync(d, { recursive: true }) } catch { /* ignore */ } }
  return { knowledge: k, experience: e }
}

// ---------------------------------------------------------------------------
// 经验：条目级并集
// ---------------------------------------------------------------------------

/**
 * 经验条目的**内容寻址 id**。与 `memory.mjs` 去重口径同源（都走 `hashLine`）——
 * 这样"本机认为重复的两条"与"团队合并时认为重复的两条"是同一判断，不会出现
 * "本机只有一条、传到团队变成两条"的鬼现象。
 * 归一化只做**行尾空白与前后空白**的裁剪（不改内部），以免把有意义的内容差异抹掉。
 */
export function entryKey(line) {
  return hashLine(String(line ?? '').trim())
}

/**
 * 解析条目文件为条目行（保留原行文本；空行与注释不动）。
 *
 * **同时接受数组与字符串**：调用方既可能传"整份文件文本"，也可能传"已切好的行数组"。
 * 首版只处理字符串，于是数组入参会走 `String(array)` 被**逗号拼成一行**（`A,B` 被当成一条条目），
 * 结果是同步后 `total` 凭空变少、条目**静默丢失**。这个坑由 T5 首轮冒烟实测抓到
 * （`entryKey` 无碰撞、并集正确，问题出在这一层），故在此显式双形态支持。
 */
export function parseEntryLines(text) {
  if (Array.isArray(text)) {
    return text.map((l) => String(l).trimEnd()).filter((l) => l.trim().length > 0)
  }
  return String(text ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length > 0)
}

/**
 * **并集合并**（§7.1：团队经验 = 条目集合，合并 = 集合求并）。
 *
 * 结果顺序 = `a` 的原序 + `b` 中新增条目的原序：**稳定且可预测**（同一输入永远同一输出），
 * 这既让回归网能逐字断言，也让"两边各自追加"不会互相把对方的顺序打乱（避免每次同步都产生
 * 整文件 diff，那会让网盘每次都判为"内容变了"）。
 *
 * 返回 `{ lines, addedFromB, duplicates }`：`duplicates` 如实报出被合并掉的重数（便于解释"为什么没变多"）。
 */
export function unionEntryLines(aLines, bLines) {
  const seen = new Set()
  const out = []
  let duplicates = 0
  for (const l of parseEntryLines(aLines)) { const k = entryKey(l); if (!seen.has(k)) { seen.add(k); out.push(l) } else duplicates++ }
  let addedFromB = 0
  for (const l of parseEntryLines(bLines)) {
    const k = entryKey(l)
    if (seen.has(k)) { duplicates++; continue }
    seen.add(k); out.push(l); addedFromB++
  }
  return { lines: out, addedFromB, duplicates }
}

/** 读团队某主题的经验条目（占位符/缺失 → 空，**不报错**）。 */
export function readTeamExperience(teamDir, theme) {
  const p = join(teamExperienceDir(teamDir), `${theme}.md`)
  if (!existsSync(p)) return { path: p, lines: [], exists: false }
  const ph = detectPlaceholderSync(p)
  if (ph.placeholder) return { path: p, lines: [], exists: true, placeholder: true, reason: ph.reason }
  try {
    return { path: p, lines: parseEntryLines(readFileSync(p, 'utf-8')), exists: true }
  } catch (e) {
    return { path: p, lines: [], exists: true, unreadable: (e && e.code) || 'unknown' }
  }
}

/**
 * 把本机某主题的经验与团队经验求并，写回团队源（**校验写**：网盘上写入必须回读确认）。
 *
 * `localLines` 由调用方传入（本文件不擅自去读本机经验库：那是 `kernel/memory.mjs` 的职责，
 * 重复实现会造出第二个"经验库在哪"的真相源）。
 */
export function syncTeamExperience({ teamDir, theme, localLines, now = new Date().toISOString() } = {}) {
  if (!theme) return { ok: false, reason: 'theme-required', message: '必须指定经验主题' }
  const team = readTeamExperience(teamDir, theme)
  if (team.placeholder || team.unreadable) {
    // 读不到现有内容就**绝不写**：占位符（仅在线/脱水）与不可读（EISDIR/EACCES）是同一类风险 ——
    // 若按"空内容"处理，本机条目会把团队里已有的内容覆盖掉（在线文件尤其容易这样丢）。
    return {
      ok: false,
      reason: team.placeholder ? 'placeholder' : 'unreadable',
      message: `团队经验文件当前不可读（${team.reason || team.unreadable}），已跳过以免覆盖既有内容`,
    }
  }
  const merged = unionEntryLines(team.lines, parseEntryLines(localLines || []))
  const dir = teamExperienceDir(teamDir)
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  const target = join(dir, `${theme}.md`)
  if (merged.addedFromB === 0 && team.exists) {
    // 无新增：**不写盘**（避免无意义的 mtime 抖动被网盘判为改动，进而制造同步流量与冲突）
    return { ok: true, written: false, path: target, total: merged.lines.length, added: 0, duplicates: merged.duplicates, at: now }
  }
  writeVerifiedSync(target, merged.lines.join('\n') + '\n')
  return { ok: true, written: true, path: target, total: merged.lines.length, added: merged.addedFromB, duplicates: merged.duplicates, at: now }
}

/** 列出团队源里已有的经验主题（供 UI/排障）。 */
export function listTeamExperienceThemes(teamDir) {
  let names = []
  try { names = readdirSync(teamExperienceDir(teamDir)) } catch { return [] }
  return names.filter((n) => n.endsWith('.md')).map((n) => n.replace(/\.md$/, '')).sort()
}

// ---------------------------------------------------------------------------
// 模式语义（§5.9）
// ---------------------------------------------------------------------------

/**
 * 侧边栏在给定模式下**默认筛选**的空间 id 列表。
 * - `personal` 模式：内置空间（个人经验/会话记忆/技能经验）。
 * - `team` 模式：团队空间（可传 `teamId` 只留一个团队）。
 *
 * 注意：这**只影响默认列表**；知识检索范围默认跨全部空间，不受模式影响（§5.9 表格）。
 * 因此本函数不被任何检索路径调用 —— 若将来有人想"顺手在检索里按模式过滤"，请回到 §5.9。
 */
export function sidebarSpaceIds({ configDir, mode = 'personal', teamId = null } = {}) {
  const specs = [...builtinIds(), ...teamSpaceSpecs(configDir).map((s) => s.id)]
  if (mode === 'team') {
    const teams = teamSpaceSpecs(configDir).map((s) => s.id)
    return teamId ? teams.filter((id) => id === teamSpaceId(teamId)) : teams
  }
  return specs.filter((id) => !id.startsWith('team-'))
}

function builtinIds() { return ['experience', 'session-memory', 'skill-experience'] }

/** 团队源可用性自检（加入后调用：目录/内容子目录是否就位、是否有占位符风险）。 */
export function checkTeamContentReady(teamDir, teamId) {
  const src = openTeamSource({ root: teamDir })
  const out = { ok: true, problems: [] }
  if (!existsSync(src.paths.manifest)) { out.ok = false; out.problems.push('team-manifest-missing') }
  const k = teamKnowledgeRoot(teamDir, teamId)
  if (!existsSync(k)) out.problems.push('knowledge-dir-missing')
  const e = teamExperienceDir(teamDir)
  if (!existsSync(e)) out.problems.push('experience-dir-missing')
  return out
}

export { writeFileAtomicSync }
