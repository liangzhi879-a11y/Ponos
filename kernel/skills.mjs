// kernel/skills.mjs —— 技能发现内核化（与 bridge /skills 同一 schema：SKILL.md 目录 + legacy .md）
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { excludeDisabled } from './disabled.mjs'

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
/**
 * 发现全部技能（多根合并、按 id 去重）。
 *
 * `disabled` = 全局停用清单（2026-09-15，D 条款）。**过滤在这里做**，因为本函数是技能清单的
 * 唯一汇聚点：提示词的技能区块、`Skill` 工具的可用清单都取自它 —— 在这里剔除，两处自动一致。
 * 若改由各消费者各自过滤，就会出现"提示词里没了、工具还能按名调用"的半生效状态（最难察觉）。
 *
 * 缺省（不传）= 不过滤：本函数也是公开口（测试/嵌入直接调用），缺省收窄会把它们的既有行为打断。
 * cli 侧两个消费者都必须显式传 `disabled`，由静态守卫测试钉住"没有漏传"。
 */
export function discoverSkillsAll({ roots = [], flatRoots = undefined, disabled = undefined } = {}) {
  const out = []
  const seen = new Set()
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const allowFlat = Array.isArray(flatRoots) ? flatRoots.includes(root) : true
    for (const s of discoverSkills({ root, allowFlat })) {
      if (!seen.has(s.id)) { seen.add(s.id); out.push(s) }
    }
  }
  return excludeDisabled(out, disabled)
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

// ── 技能详情（只读）────────────────────────────────────────────────────────
// 2026-09-15，待处理清单 P1 批次二 C：用户要求"每张卡片注明 skill 详情，展开可管理触发规则、
// 管理关联脚本"。设计决策 D2 = **只读展示 + 系统打开文件** —— 应用不写用户的 SKILL.md。
//
// 为什么详情要**按需**取（而不是塞进 /skills 列表）：
//   列表要列几十个技能，而脚本清单需要逐个 readdirSync 技能目录；为列表里每个技能都扫一遍
//   目录，会把"打开技能页"变成一次几十次系统调用的批量操作（慢且无必要——用户没展开就不需要）。
//
// 只读的边界（重要）：本函数**只读**，不返回任何写接口，也不规范化/回写 SKILL.md。
// 界面上"管理"的实际动作 = 系统默认程序打开文件（Electron `shell:open-path`），
// 由用户在自己的编辑器里改——这样应用永不参与用户技能文件的格式演进（零格式风险）。

/** 脚本/附件候选后缀：识别"关联脚本"时只认这些，避免把 .gitkeep、临时文件当脚本列出来。 */
const SCRIPT_EXTS = ['.mjs', '.js', '.cjs', '.ts', '.py', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.rb', '.pl']
/** 其余可展示的伴随文件（不算脚本，但用户可能想看）。 */
const DOC_EXTS = ['.md', '.json', '.yml', '.yaml', '.txt', '.csv', '.xlsx']

/**
 * 读取单个技能的详情（只读）。
 *
 * @param {{roots?: string[], id?: string, flatRoots?: string[]|undefined}} p
 * @returns {null | {
 *   id: string, dir: string, skillFile: string, isFlat: boolean,
 *   triggers: string[], parent: string, parentSource: 'explicit'|'none',
 *   subskills: string[], scripts: Array<{name: string, path: string, sizeKb: number}>,
 *   docs: Array<{name: string, path: string, sizeKb: number}>, contentLines: number
 * }} 未找到返回 null（调用方出 404，别让界面拿到半个对象）
 */
export function loadSkillDetail({ roots = [], id = '', flatRoots = undefined } = {}) {
  const want = String(id || '').trim()
  if (!want) return null
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const allowFlat = Array.isArray(flatRoots) ? flatRoots.includes(root) : true
    const dir = join(root, want)
    const mdPath = join(dir, 'SKILL.md')
    // ① 标准形态：<root>/<id>/SKILL.md
    if (existsSync(mdPath)) {
      let content = ''
      try { content = readFileSync(mdPath, 'utf-8') } catch { return null }
      return buildSkillDetail({ id: want, dir, skillFile: mdPath, content, isFlat: false })
    }
    // ② legacy 形态：<root>/<id>.md（仅白名单根；与 discoverSkills 的 allowFlat 同口径）
    if (allowFlat) {
      const flat = join(root, `${want}.md`)
      if (existsSync(flat)) {
        let content = ''
        try { content = readFileSync(flat, 'utf-8') } catch { return null }
        // 平铺形态没有独立目录：脚本/伴随文件列父目录会混入**其他技能**的文件，
        // 故显式返回空清单（宁可少显示，也不能让用户以为那是它的关联脚本）。
        return buildSkillDetail({ id: want, dir: root, skillFile: flat, content, isFlat: true })
      }
    }
  }
  return null
}

/** 组装详情对象（拆出来便于单测两个形态的差异，尤其 isFlat 的文件清单处理）。 */
function buildSkillDetail({ id, dir, skillFile, content, isFlat }) {
  const detail = {
    id, dir, skillFile, isFlat,
    // triggers/parent/subskills 与 discoverSkills 同一套解析（复用，避免"列表里显示的"与
    // "详情里显示的"不一致）
    triggers: [],
    parent: '',
    // `explicit` = 技能在 SKILL.md 里**显式声明**了父级；界面据此显示"为何在此分组"，
    // 并允许用户区分"声明的"与"按前缀猜的"（D1：显式优先、启发式兜底）。
    parentSource: 'none',
    subskills: [],
    scripts: [],
    docs: [],
    contentLines: content.split('\n').length,
  }
  const yaml = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
  const meta = parseFrontmatter(content)
  detail.triggers = meta.triggers
    ? String(meta.triggers).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    : parseYamlList(yaml, 'triggers')
  const p = parseYamlSingle(yaml, 'parent')
  if (p) { detail.parent = p; detail.parentSource = 'explicit' }
  detail.subskills = parseYamlList(yaml, 'subskills').length
    ? parseYamlList(yaml, 'subskills')
    : parseYamlList(yaml, 'dependencies')

  // 目录形态才列文件：平铺形态的父目录里混着别的技能（见调用处注释）。
  if (!isFlat) {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { entries = [] }
    for (const it of entries) {
      if (!it.isFile() || it.name === 'SKILL.md') continue
      const lower = it.name.toLowerCase()
      const ext = lower.slice(lower.lastIndexOf('.'))
      if (!SCRIPT_EXTS.includes(ext) && !DOC_EXTS.includes(ext)) continue
      let sizeKb = 0
      try { sizeKb = Math.max(1, Math.round(readFileSync(join(dir, it.name)).length / 1024)) } catch { sizeKb = 0 }
      const item = { name: it.name, path: join(dir, it.name), sizeKb }
      if (SCRIPT_EXTS.includes(ext)) detail.scripts.push(item)
      else detail.docs.push(item)
    }
    detail.scripts.sort((a, b) => a.name.localeCompare(b.name))
    detail.docs.sort((a, b) => a.name.localeCompare(b.name))
  }
  return detail
}
