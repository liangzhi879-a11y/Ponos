// kit/lib/ledger.mjs —— 台账读写 + 同步（versions / deps）
//
// "sync" 的职责是**从宿主文件发现事实、写进台账**；"check" 的职责是**回读宿主文件、与台账比对**。
// 两者永不共享"已解析的缓存值" —— 否则一个 bug 会同时污染写侧与读侧，门禁就成了自证。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../../shared/atomic-write.mjs'
import { trackedFiles, codeFiles, readTracked } from './scan.mjs'

export const VERSIONS_FILE = 'kit/manifest/versions.json'
export const DEPS_FILE = 'kit/manifest/deps.json'

// ── 通用 JSON 读写 ─────────────────────────────────────────────────────────

export function readJson({ root, rel, fallback = null }) {
  const p = join(root, rel)
  if (!existsSync(p)) return fallback
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

/** 写台账用原子写（shared/atomic-write.mjs）：台账被半截写坏会让门禁全线误报 */
export function writeJson({ root, rel, data }) {
  writeFileAtomicSync(join(root, rel), JSON.stringify(data, null, 2) + '\n')
}

// ── 版本：四条版本线的定位方式（手写，因为它们的位置是刻意的契约） ────────────

export const LINE_SPECS = [
  { id: 'APP_VERSION', label: 'Ponos 应用（turbo 内核版）', file: 'version.mjs',
    locator: { kind: 'const', name: 'APP_VERSION' }, kind: 'app-line' },
  { id: 'KERNEL_VERSION', label: 'Ponos-Turbo 内核', file: 'version.mjs',
    locator: { kind: 'const', name: 'KERNEL_VERSION' }, kind: 'app-line',
    mirror: { file: 'kernel/package.json', locator: { kind: 'json', path: 'version' } } },
  { id: 'GUI_VERSION', label: 'GUI 发布线（Vite 注入 __APP_VERSION__）', file: 'package.json',
    locator: { kind: 'json', path: 'version' }, kind: 'app-line' },
  { id: 'KB_SCHEMA_VERSION', label: 'settings 文件 schema', file: 'version.mjs',
    locator: { kind: 'const', name: 'SCHEMA_VERSION' }, kind: 'data-schema',
    migrationNote: 'settings 无 schemaVersion 的旧文件视为 v0，读取时沿迁移链升级（version.mjs:15）' },
]

/**
 * 按 locator 从宿主文件解析出当前值。
 * const 分支刻意宽容：允许 `export` 前缀、行尾 `//` 注释、行尾分号、单/双引号。
 * 实测这些形态在仓里都真实存在（如 `const VAULT_VERSION = 1  // …`）。
 *
 * ★ 行首缩进写 `[ \t]*` 而**不是** `\s*`：`\s` 含换行，`^\s*` 会把**前导空行**一并吞进匹配，
 *   使匹配起点落在空行上（实测 `'\n\nexport const INDEX_VERSION = 5'` → 行号 1 而非 3）。
 *   行号是 V1「台账 {file,line} 处仍是该常量且值相等」的定位依据，故两处正则口径一致。
 */
export function parseByLocator({ root, file, locator }) {
  const text = readTracked({ root, file })
  if (text === null) return null
  if (locator.kind === 'json') {
    try {
      const j = JSON.parse(text)
      const v = locator.path.split('.').reduce((o, k) => (o == null ? o : o[k]), j)
      return v === undefined ? null : { value: v, raw: String(v) }
    } catch { return null }
  }
  if (locator.kind === 'const') {
    const re = new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${locator.name}\\s*=\\s*(.+?)[ \\t]*$`, 'm')
    const m = text.match(re)
    if (!m) return null
    const raw = m[1].replace(/\/\/.*$/, '').replace(/;\s*$/, '').trim()
    const q = raw.match(/^(['"`])([\s\S]*)\1$/)
    if (q) return { value: q[2], raw }
    const n = Number(raw)
    if (!Number.isNaN(n) && raw !== '') return { value: n, raw }
    return { value: raw, raw }
  }
  throw new Error(`未知 locator.kind: ${locator.kind}`)
}

/** 台账键：`${id}@${file}` —— 同一常量名出现在两个文件时必须可区分（实测有两处 SCHEMA_VERSION） */
export function keyOfVersion(entry) { return `${entry.id}@${entry.file}` }

/** 发现规约：以 `VERSION` 结尾的全大写常量，形如 `<PREFIX>VERSION = <字面量>`（行首缩进理由同 parseByLocator） */
const VERSION_CONST_RE = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]*VERSION)\s*=\s*(.+?)[ \t]*$/gm

/** 从已入库代码文件里发现所有版本常量（不含测试文件；测试里的不算契约） */
export function discoverVersionConsts({ root, files }) {
  const out = []
  for (const file of codeFiles(files)) {
    const text = readTracked({ root, file })
    if (text === null) continue
    VERSION_CONST_RE.lastIndex = 0
    let m
    while ((m = VERSION_CONST_RE.exec(text)) !== null) {
      const raw = m[2].replace(/\/\/.*$/, '').replace(/;\s*$/, '').trim()
      const q = raw.match(/^(['"`])([\s\S]*)\1$/)
      const value = q ? q[2] : (Number.isNaN(Number(raw)) ? raw : Number(raw))
      const line = text.slice(0, m.index).split('\n').length
      out.push({ id: m[1], value, valueType: typeof value, file, line, locator: { kind: 'const', name: m[1] }, kind: 'contract' })
    }
  }
  return out
}

// ── 技能版本（skills.json ↔ SKILL.md frontmatter） ──────────────────────────

export const SKILLS_JSON = 'public/skills.json'
export const SKILLS_DIR = 'public/sample-skills'

/** 从 SKILL.md 的 YAML frontmatter 取 version（支持带引号/不带引号） */
export function readSkillFrontmatterVersion({ root, file }) {
  const text = readTracked({ root, file })
  if (text === null) return null
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return null
  const m = fm[1].match(/^version:\s*["']?([^"'\n]+?)["']?\s*$/m)
  return m ? m[1].trim() : null
}

export function sha256File({ root, file }) {
  const text = readTracked({ root, file })
  if (text === null) return null
  return createHash('sha256').update(readFileSync(join(root, file))).digest('hex')
}

// ── _common 工具版本 ───────────────────────────────────────────────────────

export const COMMON_DIR = 'public/sample-skills/_common'
export const COMMON_MANIFEST = `${COMMON_DIR}/_common_manifest.json`

/** 实有 .py 清单（从 files 过滤，不用磁盘遍历 —— 保持与扫描域同一来源） */
export function listCommonPy(files) {
  const pre = `${COMMON_DIR}/`
  return files.filter((f) => f.startsWith(pre) && f.endsWith('.py')).map((f) => f.slice(pre.length)).sort()
}

// ── syncVersions ──────────────────────────────────────────────────────────

/**
 * 人工可编辑字段的**显式白名单**（契约：`versions.json` 里只有这些字段属于人写内容）。
 *
 * 为什么必须是显式名单、而不是 `{ ...old }` 整条合并：台账里同时住着**事实字段**
 * （`value` / `line` / `locator`）与**人工字段**。整条合并会把旧条目里已经过期的
 * `value` / `locator` 一并"继承"回来，`sync` 就不再是从宿主文件重算事实，而是
 * "宿主文件与旧台账谁赢看实现细节"——同一条不变量（I1：sync 不得覆盖人工内容）
 * 反过来被违反（sync 覆盖了事实）。白名单把两侧焊死：事实永远来自宿主文件，人工字段永远来自人。
 *
 * `manual` 不在本名单里：它是 contracts 分区的**整条人工条目**标记（由下方 manualContracts 分支
 * 单独处理），不是"某条记录上的可编辑字段"，两者语义不同，混在一起会让 lines 也能伪造事实条目。
 */
export const MANUAL_FIELDS = ['note', 'consumers', 'migrationNote']

/**
 * 从宿主文件重建版本台账。
 * 合并语义：以发现结果为"骨架"，只为 `MANUAL_FIELDS`（人工字段）继承旧台账值。
 * 这样 `sync` 可以随时跑，不会把人工写的说明冲掉，也不会把过期的版本值留住。
 */
export function syncVersions({ root, files, dryRun = false } = {}) {
  const tracked = files || trackedFiles({ root })
  const prev = readVersions({ root }) || {}
  const prevByKey = new Map((prev.contracts || []).map((e) => [keyOfVersion(e), e]))
  // ★ `exclude` 整条列表来自旧台账（人工可编辑区），不是每次由 DEFAULT_EXCLUDES 重算 ——
  //   实测已验证：人工新增的排除项（含 note）在二次 sync 后仍在、且真的生效（对应测试
  //   「exclude 的人工编辑同样被保留」）。DEFAULT_EXCLUDES 只用于**首次**建台账（prev 为空时）。
  const excludes = prev.exclude || DEFAULT_EXCLUDES
  // ★ 排除按 **id 全局匹配**（不是 id@file）—— 实测 ANTHROPIC_VERSION 出现在 **两个**文件
  //   （electron/app-llm.cjs 与 electron/app-websearch.cjs），这是"外部协议版本"的属性，
  //   与它出现在哪个文件无关；按 id@file 匹配的话，新增第三个调用点就会漏排。
  //   JSON 里的 file 字段仅作"当前位于何处"的说明，不参与匹配。
  const excludeIds = new Set(excludes.map((e) => e.id))
  // ★ 版本线已纳管的常量不再重复进 contracts 分区。否则 APP_VERSION@version.mjs、
  //   KERNEL_VERSION@version.mjs、SCHEMA_VERSION@version.mjs 会**同时**出现在 lines 与
  //   contracts 两处（同一事实两份记录，违反不变量 I1），且 contracts 会变成 15 而非 14。
  const lineLocatorKeys = new Set(LINE_SPECS.map(
    (s) => `${s.locator.kind === 'const' ? s.locator.name : s.locator.path}@${s.file}`,
  ))

  // lines
  //
  // ★ 人工字段继承（Task 3 复审返工）：契约承诺"人工只允许改 exclude / note / consumers /
  //   migrationNote"，但初版 lines 只做 `{...spec, value, valueType}` —— 宿主文件一改导致
  //   sync 重建，人工写在 lines 条目上的 note / consumers / migrationNote 就被**静默丢弃**。
  //   contracts 分支本来就做了继承，lines 必须与之一致：否则同一条不变量（I1：sync 不得
  //   覆盖人工内容）在两个分区里行为不同，且失败是静默的（无告警）。
  //   注意按 id 建 map：台账键 `${id}@${file}` 对 lines 而言 id 已唯一（LINE_SPECS 手写枚举）。
  const prevLines = new Map((prev.lines || []).map((e) => [e.id, e]))
  const lines = LINE_SPECS.map((spec) => {
    const parsed = parseByLocator({ root, file: spec.file, locator: spec.locator })
    if (!parsed) return null
    const old = prevLines.get(spec.id)
    const entry = { ...spec, value: parsed.value, valueType: typeof parsed.value }
    if (spec.mirror) entry.mirrorValue = parseByLocator({ root, file: spec.mirror.file, locator: spec.mirror.locator })?.value ?? null
    // 只继承白名单（人工）字段：`value`/`locator`/`mirrorValue` 等事实字段一律以本次解析为准
    for (const k of MANUAL_FIELDS) if (old && k in old) entry[k] = old[k]
    return entry
  }).filter(Boolean)

  // contracts（发现 − 排除 − 版本线已纳管 + 人工字段保留）
  const discovered = discoverVersionConsts({ root, files: tracked })
    .filter((e) => !excludeIds.has(e.id) && !lineLocatorKeys.has(keyOfVersion(e)))
  const manualContracts = (prev.contracts || []).filter((e) => e.manual === true)
  const contracts = []
  for (const d of discovered) {
    const old = prevByKey.get(keyOfVersion(d))
    contracts.push(old ? { ...old, value: d.value, valueType: d.valueType, line: d.line, locator: d.locator } : d)
  }
  for (const m of manualContracts) if (!contracts.some((e) => keyOfVersion(e) === keyOfVersion(m))) contracts.push(m)

  // skills（skills.json ↔ frontmatter）
  const skillsJson = readJson({ root, rel: SKILLS_JSON, fallback: [] }) || []
  const skills = skillsJson
    .map((s) => {
      const file = `${SKILLS_DIR}/${s.id}/SKILL.md`
      const fm = readSkillFrontmatterVersion({ root, file })
      return { id: s.id, value: s.version ?? null, frontmatterVersion: fm, file }
    })
    .filter((s) => s.frontmatterVersion !== null || s.value !== null)

  // skillsLock（只记引用，不复制哈希 —— 见下方"为什么"）
  // ★ 为什么台账里不存 sha256：`sync` 会重写台账。若哈希也由 sync 写进台账，
  //   而 V7 又拿台账里的哈希去比对文件，那么"跑一次 sync"就必然让 V7 变绿 ——
  //   门禁被自己的 sync 架空（自证陷阱）。判据必须是**已提交的 lock 文件**（skills-lock.json）。
  //   更新 lock 是 `syncSkillsLock` 的职责（Task 9），V7 只读不改。
  const lock = readJson({ root, rel: 'skills-lock.json', fallback: { skills: {} } }) || { skills: {} }
  const skillsLock = { source: 'skills-lock.json', field: 'computedHash', ids: Object.keys(lock.skills || {}) }

  // commonTools（全量登记；未标注者 version=null + versionSource='unmarked'）
  const prevCommon = prev.commonTools || {}
  const prevEntries = new Map((prevCommon.entries || []).map((e) => [e.file, e]))
  const manifest = readJson({ root, rel: COMMON_MANIFEST, fallback: { tools: {} } }) || { tools: {} }
  const manifestTools = manifest.tools || {}
  const pyNames = listCommonPy(tracked)
  const commonEntries = pyNames.map((name) => {
    const file = `${COMMON_DIR}/${name}`
    const old = prevEntries.get(file)
    const mv = manifestTools[name]?.current_version
    if (old && old.versionSource === 'unmarked' && !mv) return old
    return mv
      ? { file, version: mv, versionSource: 'manifest' }
      : { file, version: null, versionSource: 'unmarked' }
  })
  const baselinePrev = Array.isArray(prevCommon.baseline) ? prevCommon.baseline : null
  const addedSinceBaseline = baselinePrev ? pyNames.filter((n) => !baselinePrev.includes(n)) : []

  const data = {
    version: 1,
    generatedBy: 'node kit/cli.mjs sync',
    // ★ `_note` 是对**行为**的承诺，改 sync 的合并语义时必须同步改这里（否则文档撒谎）：
    //   事实字段（value/line/locator/mirrorValue）每次重算；人工字段见 MANUAL_FIELDS。
    _note: '本文件由 sync 生成骨架：value / line / locator 等事实字段每次 sync 都从宿主文件重算，人工改动会被覆盖。人工只可编辑：exclude / note / consumers / migrationNote（lines 与 contracts 两个分区都会被继承）/ manual 条目（仅 contracts 分区）/ history。',
    exclude: excludes,
    history: prev.history || { baselineCount: 0, commonToolsBaseline: pyNames.length, records: [] },
    lines,
    contracts,
    skills,
    skillsLock,
    commonTools: {
      baseline: pyNames,
      addedSinceBaseline,
      entries: commonEntries,
    },
    channels: prev.channels || {},
  }
  data.history.commonToolsBaseline = pyNames.length
  data.history.baselineCount = (prev.history?.baselineCount ?? 0)

  if (!dryRun) writeJson({ root, rel: VERSIONS_FILE, data })
  const prevKeys = new Set((prev.contracts || []).map(keyOfVersion))
  const nowKeys = new Set(contracts.map(keyOfVersion))
  return {
    data,
    added: [...nowKeys].filter((k) => !prevKeys.has(k)),
    removed: [...prevKeys].filter((k) => !nowKeys.has(k)),
  }
}

/** 默认排除项：外部协议版本与上游技能资产，不是本仓契约（**按 id 全局匹配**，见 syncVersions） */
export const DEFAULT_EXCLUDES = [
  { id: 'ANTHROPIC_VERSION', file: 'electron/app-llm.cjs',
    reason: 'Anthropic Messages API 协议版本（外部标准），不参与本仓版本台账；另一调用点见 electron/app-websearch.cjs' },
  { id: 'SUPERPOWERS_VERSION', file: 'public/sample-skills/brainstorming/scripts/server.cjs',
    reason: '上游 superpowers 技能包自带脚本（技能资产，随技能同步整体更新），非本仓契约；其值还是函数调用 readSuperpowersVersion() 而非字面量' },
]

export function readVersions({ root }) { return readJson({ root, rel: VERSIONS_FILE, fallback: null }) }
export function writeVersions({ root, data }) { writeJson({ root, rel: VERSIONS_FILE, data }) }
