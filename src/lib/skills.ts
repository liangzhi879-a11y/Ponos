import { getBridgeUrl } from '@/lib/config'

export interface SkillEntry {
  id: string
  name: string
  description: string
  version: string
  triggers: string[]
  parent?: string
  subskills?: string[]
  lines?: number
  size_kb?: number
}

interface SkillsResponse {
  skills: SkillEntry[]
  dir?: string
}

/**
 * 加载已安装技能：先试 bridge（3s 短超时），失败/空列表回退 bundled skills.json。
 * onDir 在 bridge 返回技能目录时回调（各消费方用于设置各自的 skillsDir 状态）。
 */
export async function fetchSkills(projectRoot: string, onDir?: (dir: string) => void): Promise<SkillEntry[]> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const q = projectRoot ? `?project=${encodeURIComponent(projectRoot)}` : ''
    const r = await fetch(`${getBridgeUrl()}/skills${q}`, { signal: controller.signal })
    clearTimeout(timeout)
    const data: SkillsResponse = await r.json()
    const list = Array.isArray(data.skills) ? data.skills : (Array.isArray(data) ? data : [])
    if (data.dir) onDir?.(data.dir)
    if (list.length > 0) return list
  } catch {}
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}skills.json`)
    const data = await r.json()
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/** 技能调用提示词：目录式 <skillId>/SKILL.md 优先，兼容旧扁平格式。 */
export function buildSkillPrompt(skillsDir: string, skillId: string): string {
  const baseName = skillId.replace('gxtz-', '')
  const dirPath = `${skillsDir}/${skillId}/SKILL.md`
  const legacyPath1 = `${skillsDir}/gxtz-${baseName}.md`
  const legacyPath2 = `${skillsDir}/${skillId}.md`
  return `执行技能 ${skillId}。首选使用 Read 工具读取 "${dirPath}"（若不存在则尝试 "${legacyPath1}" 或 "${legacyPath2}"），按技能定义逐步执行。项目根目录为当前工作目录。`
}
