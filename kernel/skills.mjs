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
    skills.push({
      id,
      name: meta.name || id,
      description: (meta.description || firstLine || id).slice(0, 300),
      version: meta.version || '',
      triggers: meta.triggers || '',
      parent: meta.parent || '',
      subskills: meta.subskills || '',
      lines: content.split('\n').length,
    })
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id))
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
