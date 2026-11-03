// kernel/skill-forge.mjs —— 技能工坊的**纯函数**核心（校验 / 渲染 / 侦察 / 章节 diff）。
//
// ## 为什么这个文件必须是纯函数（零 fs、零桥）
//
// 本仓的教训：把校验写进路由或工具执行体，会导致"对话式与 GUI 两条入口各校验一套"，
// 松的那条成为后门（spec §5.1 明确要求两入口过同一套硬门）。纯函数可被三条消费者
// （SkillDraft 工具 / HTTP handler / GUI 预校验）同时复用，且单测无需起进程。
//
// ## 硬门纪律
//
// `validateDraft` **不在第一个错误处 early-return**：一次回执列出全部问题，
// 否则用户/agent 要"改一个跑一次"（本仓 agent 循坏里这是最贵的交互模式）。
import { join } from 'node:path'
import { parseFrontmatter } from './skills.mjs'
import { detectInjectionSignals, shouldWarn } from './untrusted.mjs'

/** 技能 id 格式（导出供 GUI 与工具复用——两处各写一份正则必然漂移）。 */
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

/** 零宽 / 双向控制字符（人眼审阅看不出，是注入常见手法，见 kernel/untrusted.mjs:29）。 */
const HIDDEN_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/

const DESC_MAX = 300
const TRIGGERS_MAX = 20
const TRIGGER_LEN_MAX = 40
const BODY_LINES_MAX = 800

/** 从 frontmatter 取 triggers（兼容 YAML 列表与逗号分隔单行两种写法，与 skills.mjs 同口径）。 */
function readTriggers(content) {
  const yaml = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
  const out = []
  for (const line of yaml.split('\n')) {
    const m = line.match(/^\s*-\s*(.+)$/)
    if (m) { out.push(m[1].trim().replace(/^["']|["']$/g, '')); continue }
    const inline = line.match(/^triggers:[ \t]*(.+)$/)
    if (inline && inline[1].trim()) out.push(...inline[1].split(/[,，]/).map((s) => s.trim()).filter(Boolean))
  }
  return out
}

/**
 * 硬门校验（spec §5.4）。返回全部问题，不在首个错误处中断。
 * @param {{ id?: string, content?: string, existingIds?: string[] }} [p]
 * @returns {{ ok: boolean, errors: Array<{code:string,field?:string,message:string,hint?:string}>, warnings: Array<{code:string,message:string}> }}
 */
export function validateDraft({ id = '', content = '', existingIds = [] } = {}) {
  const errors = []
  const warnings = []
  const want = String(id || '').trim()
  const text = String(content || '')

  if (!ID_RE.test(want)) {
    errors.push({ code: 'ID_FORMAT', field: 'id',
      message: `id "${want}" 不合规`,
      hint: '只允许小写字母/数字/连字符，首字符为字母或数字，长度 2-64（例：rd-ip-crosscheck）' })
  } else if (Array.isArray(existingIds) && existingIds.includes(want)) {
    errors.push({ code: 'ID_TAKEN', field: 'id', message: `技能 id "${want}" 已存在`, hint: '换个 id；本工具不会静默改名' })
  }

  if (!/^---\r?\n/.test(text)) {
    errors.push({ code: 'FM_MISSING', field: 'frontmatter', message: '缺少 frontmatter（文件必须以 --- 开头）',
      hint: '至少需要 name 与 description 两个键' })
  } else {
    const meta = parseFrontmatter(text)
    if (!meta.name) errors.push({ code: 'FM_PARSABLE', field: 'name', message: 'frontmatter 缺 name' })
    if (!meta.description) {
      errors.push({ code: 'FM_PARSABLE', field: 'description', message: 'frontmatter 缺 description' })
    } else if (meta.description.length > DESC_MAX) {
      errors.push({ code: 'DESC_TOO_LONG', field: 'description',
        message: `description ${meta.description.length} 字，超过 ${DESC_MAX}`,
        hint: '提示词技能块会按 300 字截断（kernel/skills.mjs 的 description 解析），超长部分不会被模型看到' })
    }
    const trg = readTriggers(text)
    if (trg.length > TRIGGERS_MAX) {
      errors.push({ code: 'TRIGGERS_TOO_MANY', field: 'triggers', message: `${trg.length} 条触发词，超过 ${TRIGGERS_MAX}` })
    }
    const longOne = trg.find((t) => t.length > TRIGGER_LEN_MAX)
    if (longOne) {
      errors.push({ code: 'TRIGGER_TOO_LONG', field: 'triggers', message: `触发词过长（${longOne.length} 字）：${longOne.slice(0, 20)}…` })
    }
  }

  const lines = text.split('\n').length
  if (lines > BODY_LINES_MAX) {
    warnings.push({ code: 'TOO_LONG', message: `正文 ${lines} 行，建议拆分（Skill 工具会一次性加载全文）` })
  }

  if (HIDDEN_RE.test(text)) {
    errors.push({ code: 'HIDDEN_CHARS', field: 'content', message: '含零宽/双向控制字符',
      hint: '这类字符人眼不可见却能藏指令，一律拒绝；请清除后重试' })
  }
  const signals = detectInjectionSignals(text)
  if (shouldWarn(signals)) {
    errors.push({ code: 'INJECTION', field: 'content',
      message: `检出 ${signals.length} 个提示注入信号（最高级别 ${signals[0]?.severity || '?'}）`,
      hint: '技能会进 system 提示，注入内容等于持久化污染；请改写为中性描述' })
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * 从 SKILL.md 正文的 frontmatter `name` 推导技能 id（**单一真源**）。
 *
 * 为什么必须只有一处：id 推导原先**两处各写一遍**——内核 `SkillDraft` 工具推导、
 * HTTP `POST /skill-draft` 却用 `String(body.id || '')` 直传 ⇒ 同一份正文走工具能存、
 * 走 HTTP 一律 `ID_FORMAT`（2026-09-23 实测的契约分叉）。现在工具体与路由都调本函数；
 * GUI 不再自带 id（存成哪个 id 以服务端返回值为准）。
 *
 * 推不出来时回空串（**不猜、不造**），由调用方按 `ID_FORMAT` 逐条报错。
 * @param {string} content 完整 SKILL.md 全文（含 `---` 围栏）
 * @returns {string} 推导出的 id；无 frontmatter name 时为空串
 */
export function deriveSkillId(content) {
  const m = String(content || '').match(/^---\r?\n[\s\S]*?^name:[ \t]*["']?(.+?)["']?[ \t]*$/m)
  return m ? m[1].trim() : ''
}

/** 按 frontmatter 渲染完整 SKILL.md（spec §5.2）。value 若含 `"` 或换行则加引号（parseFrontmatter 会剥）。 */
export function renderSkillDoc({ name, description, version = '1.0.0', triggers = [], parent = '', subskills = [], extraDirs = [], body = '' }) {
  // 标量一律加引号（规范形态）：parseFrontmatter 做朴素剥引号，恒定加引号保证往返确定性
  const q = (v) => JSON.stringify(String(v))
  const lines = ['---', `name: ${q(name)}`, `description: ${q(description)}`, `version: ${q(version)}`]
  if (Array.isArray(triggers) && triggers.length) {
    lines.push('triggers:')
    for (const t of triggers) lines.push(`  - ${q(t)}`)
  }
  if (parent) lines.push(`parent: ${q(parent)}`)
  if (Array.isArray(subskills) && subskills.length) lines.push(`subskills: ${subskills.map((s) => q(s)).join(', ')}`)
  if (Array.isArray(extraDirs) && extraDirs.length) {
    // ★ 必须发**块式**列表，不能发 `extra_dirs: "a", "b"` 的行内式：读取侧
    // kernel/skills.mjs#parseYamlList 只认块式（`key:` 独占一行 + 后续 `- item`），
    // 行内式会被**静默读成空数组** ⇒ 草稿里声明的额外目录安装后失效、且毫无提示。
    // round-trip 由 kernel-tests/skill-forge.test.mjs 钉住（2026-09-23 发现并修复）。
    lines.push('extra_dirs:')
    for (const s of extraDirs) lines.push(`  - ${q(s)}`)
  }
  lines.push('---', '', String(body || '').trim(), '')
  return lines.join('\n')
}

/** 按 `# 标题` 切分章节，供 diffChapters 使用。 */
export function chapters(md) {
  const out = []
  let heading = '(前言)'
  let lines = []
  for (const line of String(md).split('\n')) {
    const m = line.match(/^#\s+(.*)$/)
    if (m) {
      if (heading !== '(前言)' || lines.some((l) => l.trim())) out.push({ heading, lines })
      heading = m[1].trim()
      lines = []
    } else {
      lines.push(line)
    }
  }
  if (heading !== '(前言)' || lines.some((l) => l.trim())) out.push({ heading, lines })
  return out
}

/** 章节级 diff：逐章节 added / removed / changed / same。 */
export function diffChapters(oldMd, newMd) {
  const a = chapters(oldMd)
  const b = chapters(newMd)
  const res = []
  const bByHeading = new Map(b.map((c) => [c.heading, c]))
  for (const ca of a) {
    const cb = bByHeading.get(ca.heading)
    if (!cb) { res.push({ heading: ca.heading, status: 'removed' }); continue }
    bByHeading.delete(ca.heading)
    const same = ca.lines.join('\n').trim() === cb.lines.join('\n').trim()
    res.push({ heading: ca.heading, status: same ? 'same' : 'changed' })
  }
  for (const cb of bByHeading.values()) res.push({ heading: cb.heading, status: 'added' })
  return res
}

/**
 * 变更级别（spec §5.3.2）：major = 删必需章节 / 换 id / 版本大跳；minor = 增删章节；patch = 同章节改写。
 * 纯函数：oldMd/newMd + id 变化信息。
 */
export function classifyChange(oldMd, newMd, { oldId = '', newId = '' } = {}) {
  const REQUIRED = ['角色定位', '操作步骤', '坑与预防']
  const d = diffChapters(oldMd, newMd)
  if (oldId && newId && oldId !== newId) return { level: 'major', reasons: [`id 变更：${oldId} → ${newId}（会导致现有引用失效）`] }
  const removed = d.filter((x) => x.status === 'removed').map((x) => x.heading)
  const hit = REQUIRED.filter((h) => removed.includes(h))
  if (hit.length) return { level: 'major', reasons: [`删除必需章节：${hit.join('、')}`] }
  if (removed.length) return { level: 'minor', reasons: [`删除章节：${removed.join('、')}`] }
  if (d.some((x) => x.status === 'added')) return { level: 'minor', reasons: d.filter((x) => x.status === 'added').map((x) => `新增章节：${x.heading}`) }
  return { level: 'patch', reasons: d.filter((x) => x.status === 'changed').map((x) => `改写章节：${x.heading}`) }
}

/** 可识别的外部格式（顺序即判定优先级）。 */
export const EXTERNAL_FORMATS = ['yfworking', 'claude', 'codex', 'plugin', 'superpowers']

/** 导入时排除的目录（含 node_modules/.git：那是依赖与版本库，不是技能内容）。 */
export const IGNORED_DIRS = ['node_modules', '.git', '.venv', '__pycache__', '.idea', '.vscode', '.drafts']

/** 入口文件 → 格式的映射（判定优先级与 EXTERNAL_FORMATS 一致）。 */
const ENTRY_MAP = [
  ['SKILL.md', 'yfworking'],
  ['CLAUDE.md', 'claude'], ['skill.md', 'claude'],
  ['AGENTS.md', 'codex'], ['codex.md', 'codex'],
  ['plugin.json', 'plugin'], ['manifest.json', 'plugin'],
]

const SCRIPT_EXTS = ['.mjs', '.js', '.cjs', '.ts', '.py', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.rb', '.pl']
const DOC_EXTS = ['.md', '.json', '.yml', '.yaml', '.txt', '.csv']
/** 超过此体积的二进制/大文件不纳入版本化（spec §5.6.5），但必须在报告里列出。 */
const BIG_FILE = 2 * 1024 * 1024
/** 侦察护栏：超过这些上限直接拒绝导入（防用户误选整个项目根）。 */
export const MAX_ASSETS = 2000
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024

const extOf = (n) => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i).toLowerCase() }

/** 递归收集 assets（符号链接**不跟随**：防"通过软链把 /etc 搬进草稿区"）。 */
function collectAssets({ dir, prefix = '', io, warnings, acc }) {
  let entries = []
  try { entries = io.readdir(join(dir, prefix || '.')) } catch { return }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isLink) { warnings.push(`符号链接不跟随，已跳过：${rel}`); continue }
    if (e.isDir) {
      if (IGNORED_DIRS.includes(e.name)) continue
      collectAssets({ dir, prefix: rel, io, warnings, acc })
      continue
    }
    let size = 0
    try { size = io.stat(join(dir, rel)).size } catch { size = 0 }
    const ext = extOf(e.name)
    let kind = 'other'
    if (SCRIPT_EXTS.includes(ext)) kind = 'script'
    else if (DOC_EXTS.includes(ext)) kind = 'doc'
    if (size > BIG_FILE) { warnings.push(`大文件未纳管（${Math.round(size / 1024)}KB）：${rel}`); kind = 'other' }
    acc.push({ path: rel, kind, size })
  }
}

/** 目录习惯识别：出现过的顶层目录 + 已知约定。 */
const CONVENTION_DIRS = ['scripts', 'references', 'commands', 'agents', 'hooks', 'templates', 'assets']
function conventionsOf(assets) {
  const tops = new Set(assets.map((a) => a.path.split('/')[0]))
  return CONVENTION_DIRS.filter((d) => tops.has(d)).map((d) => `${d}/`)
}

/** 命中"跨机器绝对路径"的引用（供 agent 改写为 {{PONOS_SKILLS}}）。 */
const ABS_REF_RE = /(?:[A-Za-z]:[\\/][^\s"'`）)]+|\/(?:home|Users|root)\/[^\s"'`）)]+)/g
function refsOf({ assets, io, dir }) {
  const out = []
  for (const a of assets) {
    if (a.kind !== 'doc' || a.size > 512 * 1024) continue
    let text = ''
    try { text = io.readFile(join(dir, a.path)) } catch { continue }
    text.split('\n').forEach((line, i) => {
      const m = line.match(ABS_REF_RE)
      if (m) for (const raw of m) out.push({ file: a.path, line: i + 1, raw })
    })
  }
  return out
}

/**
 * 外部技能目录侦察（纯函数：fs 以注入方式传入，故可单测、零 fs 依赖）。
 *
 * **只读**：本函数不写任何东西——现实现 `convertToPonos` 用 writeFileSync 就地改写
 * 用户源目录（server/bridge.mjs:3189，2026-09-23 复核重定位）是必须修掉的缺陷（spec §5.6.1 I1）。
 *
 * 形态判定**不猜**：认不出来就 format='unknown' 并把"找过哪些文件名"放进 warnings，
 * 宁可让用户改一个文件名，不可静默产出一个错技能（spec I2）。
 *
 * @param {{ dir?: string, readdir?: Function, readFile?: Function, stat?: Function }} [p]
 */
export function detectExternal({ dir, readdir, readFile, stat } = {}) {
  const io = { readdir, readFile, stat }
  const warnings = []
  let entries = []
  try { entries = readdir(dir) } catch (e) {
    return { format: 'unknown', entryFile: '', assets: [], dirConventions: [], pathRefs: [], warnings: [`目录不可读：${String(e?.message || e)}`] }
  }
  const topNames = entries.filter((e) => !e.isDir).map((e) => e.name)
  const topDirs = entries.filter((e) => e.isDir && !e.isLink).map((e) => e.name)

  let format = 'unknown'
  let entryFile = ''
  for (const [name, fmt] of ENTRY_MAP) {
    if (topNames.includes(name)) {
      entryFile = name
      format = fmt
      break
    }
  }
  // superpowers 形态：SKILL.md + 同级支撑 .md（与 yfworking 的区别只在"有伴生文档"，
  // 但两者都按 yfworking 兼容处理；此处只标注，供报告展示）
  if (format === 'yfworking') {
    const siblings = topNames.filter((n) => n.endsWith('.md') && n !== 'SKILL.md')
    if (siblings.length) format = 'superpowers'
  }
  if (format === 'unknown') {
    warnings.push(`未识别到技能入口文件。已查找：${ENTRY_MAP.map(([n]) => n).join('、')}`)
  }
  if (format === 'superpowers') entryFile = 'SKILL.md'

  const assets = []
  collectAssets({ dir, io, warnings, acc: assets })
  const totalBytes = assets.reduce((s, a) => s + a.size, 0)
  if (assets.length > MAX_ASSETS) warnings.push(`文件数 ${assets.length} 超过上限 ${MAX_ASSETS}，拒绝导入`)
  if (totalBytes > MAX_TOTAL_BYTES) warnings.push(`总体积 ${Math.round(totalBytes / 1024 / 1024)}MB 超过上限 ${MAX_TOTAL_BYTES / 1024 / 1024}MB，拒绝导入`)

  return {
    format, entryFile, assets,
    dirConventions: conventionsOf(assets),
    pathRefs: refsOf({ assets, io, dir }),
    warnings,
    topDirs,
    totalBytes,
  }
}
