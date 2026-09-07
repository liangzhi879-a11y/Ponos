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

export function discoverSkills({ root } = {}) {
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
      id = it.name.slice(0, -3)
      try { content = readFileSync(join(root, it.name), 'utf-8') } catch { continue }
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
export function discoverSkillsAll({ roots = [] } = {}) {
  const out = []
  const seen = new Set()
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    for (const s of discoverSkills({ root })) {
      if (!seen.has(s.id)) { seen.add(s.id); out.push(s) }
    }
  }
  return out
}

// 技能全文加载（Skill 工具执行体）：按 id 在 roots 中找 <root>/<id>/SKILL.md 或
// <root>/<id>.md，返回完整内容（含 frontmatter 与操作步骤）；未命中返回 null
export function loadSkillContent({ roots = [], id } = {}) {
  if (!id) return null
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const dirMd = join(root, id, 'SKILL.md')
    if (existsSync(dirMd)) {
      try { return readFileSync(dirMd, 'utf-8') } catch { continue }
    }
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
