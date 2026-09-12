// kernel/skills.mjs —— 技能发现内核化（与 bridge /skills 同一 schema：SKILL.md 目录 + legacy .md）
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function parseFrontmatter(content) {
  const m = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const meta = {}
  if (!m) return meta
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const raw = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    meta[key] = raw
  }
  return meta
}

// YAML 多行列表解析（triggers/subskills/dependencies 共用）：从 "<key>:" 行下一行开始，
// 逐行收集 "- item"，遇到下一个行首 key 行或块尾终止（逐行解析，规避 m 模式下
// $ 行尾备选导致非贪婪提前终止的正则陷阱）
const KEY_LINE_RE = /^[a-zA-Z_][\w-]*:[ \t]*(\S.*)?$/
export function parseYamlList(raw, key) {
  const lines = String(raw).split('\n')
  const start = lines.findIndex((l) => new RegExp('^' + key + ':[ \\t]*$').test(l))
  if (start < 0) return []
  const out = []
  for (let j = start + 1; j < lines.length; j++) {
    if (KEY_LINE_RE.test(lines[j])) break
    const v = lines[j].replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '')
    if (v) out.push(v)
  }
  return out
}

// YAML 单行字段解析（parent 用）：值去引号/空白，无该字段或失败 → ''
function parseYamlSingle(raw, key) {
  const m = String(raw).match(new RegExp('^' + key + ':[ \\t]*["\']?(.+?)["\']?[ \\t]*$', 'm'))
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
}

// 技能发现（2026-09-12 P2-1 修复：平铺 .md 污染）。
// 目录形式 <id>/SKILL.md 是技能唯一的**强约定**（bridge 安装、public/sample-skills、
// ~/.yfw/skills 全用它）；平铺 <id>.md 只是 legacy 兼容，而 .md 后缀本身不含任何约定
// ⇒ 项目根目录里任意文档都会被当成技能灌进提示词与 Skill 工具清单（实测：仓库根
// BUILD.md 进了技能块，AGENTS.md 同样中招，而它们连 frontmatter 都没有）。
// 两道闸：
//   ① 平铺文件必须带 frontmatter（`---` 块）——纯说明文档不是技能；
//   ② allowFlat=false 的根（项目目录/addDirs）只认目录形式；技能集合根
//      （用户显式 --skills-dir、<configDir>/skills）才认平铺（见 cli 的 flatSkillRoots）。
export function discoverSkills({ root, allowFlat = true } = {}) {
  if (!root || !existsSync(root)) return []
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const skills = []
  for (const it of entries) {
    let content = ''
    let id = ''
    if (it.isDirectory()) {
      const mdPath = join(root, it.name, 'SKILL.md')
      if (!existsSync(mdPath)) continue
      id = it.name
      try { content = readFileSync(mdPath, 'utf-8') } catch { continue }
    } else if (it.isFile() && it.name.endsWith('.md')) {
      if (!allowFlat) continue
      try { content = readFileSync(join(root, it.name), 'utf-8') } catch { continue }
      if (!/^---\r?\n/.test(content)) continue // 无 frontmatter 的普通文档不算技能
      id = it.name.slice(0, -3)
    } else continue
    const meta = parseFrontmatter(content)
    const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
    // P8 业务适配：triggers/subskills 解析为数组（触发词进提示词技能块），parent 单行
    const yaml = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
    skills.push({
      id,
      name: meta.name || id,
      description: (meta.description || firstLine || id).slice(0, 300),
      version: meta.version || '',
      triggers: meta.triggers ? String(meta.triggers).split(/[,，]/).map((s) => s.trim()).filter(Boolean) : parseYamlList(yaml, 'triggers'),
      parent: parseYamlSingle(yaml, 'parent'),
      subskills: parseYamlList(yaml, 'subskills').length ? parseYamlList(yaml, 'subskills') : parseYamlList(yaml, 'dependencies'),
      lines: content.split('\n').length,
    })
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id))
}

// 跨 root 技能发现（去重）：Skill 工具与提示词技能块共用同一数据源
// flatRoots 缺省 undefined = 全部根都认平铺（direct caller/测试的旧行为，零回归）；
// 传入数组（cli 的 flatSkillRoots：--skills-dir 与 <configDir>/skills）时按根白名单——
// 提示词技能清单、Skill 工具的"可用技能"回执、SkillSearch 三处必须同口径，否则又回到
// "清单里没有、报错里却有"的断裂。
export function discoverSkillsAll({ roots = [], flatRoots = undefined } = {}) {
  const out = []
  const seen = new Set()
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const allowFlat = Array.isArray(flatRoots) ? flatRoots.includes(root) : true
    for (const s of discoverSkills({ root, allowFlat })) {
      if (!seen.has(s.id)) { seen.add(s.id); out.push(s) }
    }
  }
  return out
}

// 技能全文加载（Skill 工具执行体）：按 id 在 roots 中找 <root>/<id>/SKILL.md 或
// <root>/<id>.md，返回完整内容（含 frontmatter 与操作步骤）；未命中返回 null。
// flatRoots 口径与 discoverSkillsAll 一致（undefined = 全认平铺；数组 = 根白名单）：
// 提示词里不存在的 id 也不该能经 Skill 工具加载到（否则模型可把项目文档当技能读）。
export function loadSkillContent({ roots = [], id, flatRoots = undefined } = {}) {
  if (!id) return null
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const dirMd = join(root, id, 'SKILL.md')
    if (existsSync(dirMd)) {
      try { return readFileSync(dirMd, 'utf-8') } catch { continue }
    }
    if (Array.isArray(flatRoots) && !flatRoots.includes(root)) continue
    const flatMd = join(root, `${id}.md`)
    if (existsSync(flatMd)) {
      try { return readFileSync(flatMd, 'utf-8') } catch { continue }
    }
  }
  return null
}

// 版本一致性校验（轻量版）：lock 支持 { [id]: ver } 或 { skills: { [id]: ver } }。
export function verifySkillVersions({ lockPath, skills = [] }) {
  if (!lockPath || !existsSync(lockPath)) return { outdated: [] }
  let lock = {}
  try { lock = JSON.parse(readFileSync(lockPath, 'utf-8')) } catch { return { outdated: [] } }
  // 两种 lock 形态可并存：顶层 { [id]: ver }（skills 键除外）+ 嵌套 { skills: { [id]: ver } }
  const table = {}
  for (const [k, v] of Object.entries(lock)) {
    if (k === 'skills') continue
    table[k] = v
  }
  if (lock.skills && typeof lock.skills === 'object') Object.assign(table, lock.skills)
  const outdated = []
  for (const s of skills) {
    const want = table[s.id]
    if (want && s.version && want !== s.version) outdated.push({ id: s.id, lock: want, disk: s.version })
  }
  return { outdated }
}
