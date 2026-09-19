// kit/lib/ledger.mjs —— 台账读写 + 同步（versions / deps）
//
// "sync" 的职责是**从宿主文件发现事实、写进台账**；"check" 的职责是**回读宿主文件、与台账比对**。
// 两者永不共享"已解析的缓存值" —— 否则一个 bug 会同时污染写侧与读侧，门禁就成了自证。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../../shared/atomic-write.mjs'
import { trackedFiles, codeFiles, readTracked, isTestFile, CONFIG_FILES } from './scan.mjs'

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

/**
 * 文件内容的 sha256。
 *
 * ★ 行尾**先归一（CRLF → LF）再哈希**：哈希必须与"怎么检出"无关。
 *   实测（Task 9 干净克隆验证）：本仓 `core.autocrlf=true` 且无 `.gitattributes`，
 *   同一个 `SKILL.md` 在长驻工作树里是 LF、在 `git clone` 出来的干净克隆里是 CRLF
 *   （`brainstorming/SKILL.md` 实测 156 处 CRLF）—— 按原始字节哈希，干净克隆里 20 条锁
 *   有 **15 条假红**，门禁成了"检出方式"的函数而不是"内容有没有变"的函数。
 *   归一后：改内容必然变哈希（V7 判据仍然有效），只改行尾（git 自己视为同一内容）不再误报。
 *   注意写入侧（syncSkillsLock）与判定侧（V7）都用本函数 —— 两侧口径不可能漂移。
 */
export function sha256File({ root, file }) {
  const text = readTracked({ root, file })
  if (text === null) return null
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
}

// ── Task 9（A7）：重算 skills-lock（D5 —— 记录"本地安装后"哈希） ────────────
//
// ★ 为什么必须改 lock 文件本身、而不是记进台账：
//   台账由 sync 生成，若哈希也由 sync 写进台账、V7 又拿台账比对文件，
//   则"跑一次 sync"必然让 V7 全绿 —— 门禁被自己的 sync 架空（自证陷阱）。
//   判据必须是**已提交的 lock 文件**：改 SKILL.md 却忘了重算 lock → V7 红
//   （V7 直读 lock，台账里的哈希不参与判定 —— 反向断言见 version-rules.test.mjs）。
//   lock 的角色从"记上游原文哈希"（实测 20/20 与本地不符）改为"记本地安装后哈希"（D5）。
export const LOCK_FILE = 'skills-lock.json'
export const LOCK_FIELD = 'computedHash'

/**
 * 重算 lock 里每条技能的 `computedHash`。**只改这一个字段**（source / upstreamHash 等原样保留），
 * 且只写 lock 文件本身 —— 这样每次重算产生的 diff 恰好是"哪些 SKILL.md 变了"，可复核。
 *
 * lock 是**唯一真源**：不在 lock 里的技能不会被"顺手补录"（补录是 sync-sample-skills 的职责），
 * lock 里有而文件没有的进 `missing` 且条目保留（删掉条目 = 把 V7 的红灯擦掉：文件没了反而无人报）。
 *
 * @param files 扫描域（git 已跟踪文件）；省略则现取。传它是为了与 check 共用同一次扫描、
 *              并让夹具能脱离 git 直接喂入（否则测试必须造真 git 仓）。
 */
export function syncSkillsLock({ root, files, dryRun = false } = {}) {
  const tracked = files || trackedFiles({ root })
  const lock = readJson({ root, rel: LOCK_FILE, fallback: null })
  if (!lock || !lock.skills) return { updated: [], unchanged: [], missing: [], skipped: true }
  const updated = []
  const unchanged = []
  const missing = []
  for (const id of Object.keys(lock.skills)) {
    const file = `${SKILLS_DIR}/${id}/SKILL.md`
    // 判据是"已入库"（与 scan 的扫描域同一来源）：磁盘上存在但未入库的文件不算
    if (!tracked.includes(file)) { missing.push(id); continue }
    const actual = sha256File({ root, file })
    if (lock.skills[id][LOCK_FIELD] === actual) { unchanged.push(id); continue }
    lock.skills[id] = { ...lock.skills[id], [LOCK_FIELD]: actual }
    updated.push(id)
  }
  if (!dryRun && updated.length) writeJson({ root, rel: LOCK_FILE, data: lock })
  return { updated, unchanged, missing }
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

// ── Task 5：依赖台账 ────────────────────────────────────────────────────────
//
// ★ 为什么必须有"五类证据"而不是只扫 import：
//   实测只扫 import 会得出 11 个"未用"，其中 6 个是假阳性：
//     · rcedit            → scripts/patch-icon.mjs:10 的 `await import('rcedit')`（动态）
//     · electron-builder  → scripts/build-installer.mjs:65 的 `npx electron-builder`（CLI）
//     · @tailwindcss/typography / @vitejs/plugin-react / tailwindcss / postcss / autoprefixer /
//       typescript / vite → 根级配置文件消费（vite.config.ts / tailwind.config.ts / postcss.config.js / tsconfig.json）
//   误判的代价不是"多报几条"，而是**让人删掉正在用的依赖**（B1 会真的执行删除）；
//   反向的代价同样真实：判据太宽（把"文件里出现过包名"当证据）会让**真未用**的依赖逃掉判定，
//   B1 就不会删它们 —— 两侧都必须是"可复现的证据"，不是印象。
export const EVIDENCE_CLASSES = ['import', 'dynamic-import', 'config-file', 'cli', 'types']

const MODULE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx)$/

/**
 * "工具 ⇒ 它读的根级配置文件"：配置文件名就是消费证据。
 * 实测 `postcss` / `autoprefixer` / `typescript` 全仓源码**零 import**（只有配置文件里以
 * 插件名/工具名出现）——少了这张表，三者会被判 unused ⇒ P1 变红 ⇒ 最短"修红"路径是删掉
 * 正在用的工具链。表里的每一行都能在仓里指到具体文件。
 */
export const TOOL_CONFIG_FILES = {
  postcss: 'postcss.config.js',
  tailwindcss: 'tailwind.config.ts',
  typescript: 'tsconfig.json',
  vite: 'vite.config.ts',
  'electron-builder': 'electron-builder.yml',
}

/**
 * 从一段源码里抽出模块说明符。
 * 已知局限（有意保留）：不做注释剥离 —— `// 各调用点自己 require('electron')` 这类注释也会命中。
 * 方向是"多给证据"（不会造成误删），且实测未出现"注释救回真未用依赖"的情况（逐个包 git grep 核对过）。
 */
/**
 * 把**注释**与**正则字面量**的内容替换成空格：长度与换行保持不变，故所有基于下标的判定
 * （行号、try/catch 区间、引号计数）继续成立。
 *
 * 为什么必须做：实测这两类位置会凭空造出"幽灵依赖"（P2 全红）：
 *   · 注释：src/i18n/translations/en-US.ts:220 的 `… from "pressure"`（英文散文里的 of/from）；
 *   · 正则字面量：scripts/verify-knowledge-import-gui.mjs:167 的 `/from '@\/hooks\/useKnowledge'/`
 *     —— 校验脚本把"源码里的 import 长什么样"写成正则，扫描器却把它当成了 import。
 * 字符串字面量**不**掩掉：模块说明符本身就是字符串（`from 'clsx'`），掩掉就什么都抽不到了；
 * "更外层还有字符串" 这种情况由 insideEnclosingString() 判掉。
 */
export function maskNonCode(text) {
  const out = text.split('')
  const n = text.length
  const blank = (from, to) => { for (let k = Math.max(from, 0); k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ' }
  let i = 0
  while (i < n) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      const to = end === -1 ? n : end
      blank(i, to); i = to; continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const to = end === -1 ? n : end + 2
      blank(i, to); i = to; continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === ch) break
        if (ch !== '`' && text[j] === '\n') break
        j++
      }
      i = Math.min(j + 1, n); continue
    }
    if (ch === '/' && regexCanStart(text, i)) {
      let j = i + 1
      let inClass = false
      while (j < n) {
        const c = text[j]
        if (c === '\\') { j += 2; continue }
        if (c === '\n') break
        if (inClass) { if (c === ']') inClass = false }
        else if (c === '[') inClass = true
        else if (c === '/') break
        j++
      }
      if (j < n && text[j] === '/') {
        let k = j + 1
        while (k < n && /[A-Za-z0-9_$]/.test(text[k])) k++
        blank(i + 1, j)
        i = k; continue
      }
    }
    i++
  }
  return out.join('')
}

/** `/` 是正则字面量开头还是除号：看前一个非空白字符（关键字/运算符之后是正则） */
const REGEX_PREV = '=(,:[!&|?{};+-*%~^<>'
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete', 'void',
  'throw', 'await', 'yield', 'do', 'else'])
function regexCanStart(text, i) {
  let k = i - 1
  while (k >= 0 && /[ \t\r\n]/.test(text[k])) k--
  if (k < 0) return true
  const prev = text[k]
  if (REGEX_PREV.includes(prev)) return true
  if (!/[A-Za-z0-9_$]/.test(prev)) return false
  let s = k
  while (s >= 0 && /[A-Za-z0-9_$]/.test(text[s])) s--
  return REGEX_KEYWORDS.has(text.slice(s + 1, k + 1))
}

/**
 * 匹配起点是否落在**更外层的字符串字面量**里（同一行内数引号奇偶）。
 * 实测形态：测试夹具把待扫描的源码写成字符串 ——
 * `'src/a.test.ts': "import { d } from 'diff'\n"` —— 若不判掉，夹具里的 `diff`
 * 就成了"diff 包在用"的证据，真未用的 `diff` 直接逃掉判定。
 */
function insideEnclosingString(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  const before = text.slice(lineStart, index)
  for (const q of ['"', "'", '`']) {
    let count = 0
    for (let i = 0; i < before.length; i++) if (before[i] === q && before[i - 1] !== BACKSLASH) count++
    if (count % 2 === 1) return true
  }
  return false
}

function specifiersIn(text, masked = maskNonCode(text)) {
  const out = []
  const push = (spec, kind, index) => {
    if (!spec) return
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('#')) return
    if (insideEnclosingString(text, index)) return
    out.push({ spec, kind, index })
  }
  for (const m of masked.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) push(m[1], 'static', m.index)
  for (const m of masked.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1], 'static', m.index)
  for (const m of masked.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1], 'dynamic', m.index)
  for (const m of masked.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) push(m[1], 'static', m.index)
  return out
}

/**
 * ★ 2026-09-19 性能改造（Task 5 复审 rider R1）：**每个文件只读一次、只 mask 一次**。
 *
 * 旧写法是"每个依赖自己去遍历全仓、逐个文件 readFileSync + maskNonCode"，
 * 于是复杂度是 O(依赖数 × 文件数)：实测全仓（52+13=65 个依赖 × 886 个文件）`syncDeps` 要 **56.8s**，
 * 而 Task 7 把 `kit:check` 接进 CI 后 sync+check 要付两遍。
 * 现在改为：先按文件把**与具体依赖无关**的中间结果解析一遍（masked 文本 / 说明符清单 / CLI 命令词），
 * 再让每个依赖在这个索引上做匹配。匹配用的 `configTokenRe` 等仍然逐依赖跑 —— 但那部分是 O(文本) 且无 I/O。
 *
 * 为什么用"显式传入的 cache（Map）"而不是模块级缓存：模块级缓存会把"上一次跑的结果"
 * 泄漏给下一次调用（同一进程里跑两个不同的 root 就串味），而门禁最怕这种不可复现的脏状态。
 */
function isEvidenceCandidate(file) {
  return MODULE_EXT.test(file) || CONFIG_FILES.includes(file) || file === 'package.json'
}

/** 单文件解析结果；读不到 / 不是候选文件 → null（null 也会被缓存，避免反复试探） */
function fileRecord({ root, file, cache }) {
  if (cache && cache.has(file)) return cache.get(file)
  let rec = null
  if (isEvidenceCandidate(file)) {
    const text = readTracked({ root, file })
    if (text !== null) {
      const masked = maskNonCode(text)
      rec = {
        file,
        text,
        masked,
        specifiers: specifiersIn(text, masked),
        _commands: null,
        _tryRanges: null,
        /** CLI 证据的词表（package.json 的 scripts 与代码里的 npx/exec 家族）—— 与依赖无关，故只算一次 */
        commands() {
          if (this._commands === null) {
            this._commands = file === 'package.json' ? packageJsonCommands(this.masked) : cliCommandsIn(this.masked)
          }
          return this._commands
        },
        /** try/catch 覆盖区间（可选探针用）—— 同上，只算一次 */
        tryRanges() {
          if (this._tryRanges === null) this._tryRanges = tryCatchRanges(this.masked)
          return this._tryRanges
        },
      }
    }
  }
  if (cache) cache.set(file, rec)
  return rec
}

/** 建索引：把一次扫描里要用到的文件全解析进同一个 Map（调用方可跨函数复用） */
export function buildEvidenceIndex({ root, files }) {
  const cache = new Map()
  for (const file of files) fileRecord({ root, file, cache })
  return cache
}

/** 源码里出现的全部模块说明符（用于反向幽灵依赖判定） */
export function parseDeclaredImports({ root, files, cache = null }) {
  const idx = cache || buildEvidenceIndex({ root, files })
  const names = new Set()
  for (const file of files.filter((f) => MODULE_EXT.test(f))) {
    const rec = fileRecord({ root, file, cache: idx })
    if (!rec) continue
    for (const s of rec.specifiers) names.add(s.spec)
  }
  return [...names].sort()
}

/** 包名归一：`@scope/pkg/sub/path` → `@scope/pkg`；`pkg/sub` → `pkg` */
export function packageRootOf(spec) {
  const parts = String(spec).split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const BACKSLASH = String.fromCharCode(92)
/** 正则转义（用 fromCharCode 取反斜杠，避免在模板/字符串里手写转义序列时被上层工具吞掉） */
function escapeRe(s) {
  const specials = '.*+?^${}()|[]' + BACKSLASH
  return String(s).split('').map((ch) => (specials.includes(ch) ? BACKSLASH + ch : ch)).join('')
}

/**
 * 配置文件里的包名 token 证据：**对象键**（`autoprefixer: {}`）或**字符串字面量**（`'postcss'`）。
 * 刻意不接受"裸标识符" —— vite.config.ts 里的 `plugins: [react()]` 中 `react` 是本地变量名
 * （来自 @vitejs/plugin-react），把它当"react 包的证据"就是纯噪声。
 */
function configTokenRe(dep) {
  const e = escapeRe(dep)
  const b = BACKSLASH
  // 对象键：`autoprefixer: {}`（前导边界排除 word 字符与 @ / - ，避免 `my-autoprefixerx` 这类子串误命中）
  const asKey = new RegExp('(?:^|[^' + b + 'w@/-])' + e + '[ ' + b + 't]*:')
  // 字符串字面量：`'postcss'`
  const asLiteral = new RegExp('[\'"]' + e + '[\'"]')
  return { test: (text) => asKey.test(text) || asLiteral.test(text) }
}

/** 每段 `&&` / `||` / `;` / `|` 的第一个 token；`npx X` 取 X（剥掉 @version） */
const RESERVED_CMD = new Set(['npm', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'run', 'exec', 'cmd', 'sh', 'bash',
  'pwsh', 'powershell', 'cd', 'echo', 'set', 'rem', 'exit', 'call', 'start', 'if', 'for'])
const stripVersion = (t) => t.replace(/@[\w.^~*-]+$/, '').replace(/[)("'`,;]+$/, '').replace(/^[("'`]+/, '')

function commandWords(script) {
  const out = []
  for (const seg of String(script).split(/&&|\|\||;|\|/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean)
    if (!toks.length) continue
    if (toks[0] === 'npx') {
      const t = toks.slice(1).find((x) => !x.startsWith('-'))
      if (t) out.push(stripVersion(t))
    } else if (!RESERVED_CMD.has(toks[0])) out.push(stripVersion(toks[0]))
  }
  return out
}

/** 代码文本里的 CLI 证据：`npx X`，以及 exec/spawn 家族字符串实参里的命令词 */
function cliCommandsIn(text) {
  const out = []
  for (const m of text.matchAll(/\bnpx\s+([^\n'"`]+)/g)) {
    const first = m[1].trim().split(/\s+/).find((t) => t && !t.startsWith('-'))
    if (first) out.push(stripVersion(first))
  }
  for (const m of text.matchAll(/\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\(\s*(['"`])([\s\S]*?)\1/g)) {
    out.push(...commandWords(m[2]))
  }
  return out
}

/** package.json 的 scripts 也是 CLI 证据（spec §6.2 类 4 明列） */
function packageJsonCommands(text) {
  try {
    return Object.values(JSON.parse(text).scripts || {}).flatMap((cmd) => commandWords(cmd))
  } catch { return [] }
}

/** `try { … } catch` 覆盖的字符区间（用 `catch` 结尾才算"可降级"；try/finally 不算） */
function tryCatchRanges(text) {
  const ranges = []
  const re = /\btry\s*\{/g
  let m
  while ((m = re.exec(text)) !== null) {
    const open = text.indexOf('{', m.index)
    let depth = 0
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) {
        if (/^\s*catch\b/.test(text.slice(i + 1))) ranges.push([open, i])
        break
      }
    }
  }
  return ranges
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/**
 * 可选探针：**全部**出现位置都落在 `try/catch` 里的模块 import。
 * 实测 `shared/pack-zip.test.mjs:85` 的 `JSZip = (await import('jszip')).default`（catch 里跳过）：
 * jszip 是 mammoth 的传递依赖，源码显式允许它缺失 —— 把它当"幽灵依赖"报红，红的是**有意设计**；
 * 但也不能静默放过：清单照原样写进台账 `optionalProbes`（含 file:line），供人复核。
 */
export function optionalProbes({ root, files, cache = null }) {
  const idx = cache || buildEvidenceIndex({ root, files })
  const found = []
  for (const file of files.filter((f) => MODULE_EXT.test(f))) {
    const rec = fileRecord({ root, file, cache: idx })
    if (!rec) continue
    const ranges = rec.tryRanges()
    if (!ranges.length) continue
    const inside = (i) => ranges.some(([a, b]) => i >= a && i <= b)
    const agg = new Map()
    for (const o of rec.specifiers) {
      const e = agg.get(o.spec) || { total: 0, optional: 0, line: lineOf(rec.text, o.index) }
      e.total++
      if (inside(o.index)) e.optional++
      agg.set(o.spec, e)
    }
    for (const [spec, e] of agg) if (e.optional === e.total) found.push({ spec, file, line: e.line })
  }
  return found.sort((a, b) => a.spec.localeCompare(b.spec) || a.file.localeCompare(b.file))
}

/**
 * tsconfig 的 `compilerOptions.types`（缺字段 → null = TS 默认"自动包含全部 @types/*"）。
 * 用正则而不是 JSON.parse：tsconfig 是"允许注释与尾逗号"的 JSONC，严格解析会 throw。
 */
function tsconfigTypes(ts) {
  const m = ts.match(/"types"\s*:\s*\[([^\]]*)\]/)
  if (!m) return null
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

/** `@types/x` → `x`；`@types/babel__core` → `@babel/core`（DefinitelyTyped 的作用域名 `__` 约定） */
function typedModuleOf(dep) {
  const rest = dep.slice('@types/'.length)
  return rest.includes('__') ? '@' + rest.replace('__', '/') : rest
}

export function collectEvidence({ root, files, dep, includeTests = true, cache = null }) {
  const idx = cache || buildEvidenceIndex({ root, files })
  const classes = new Set()
  const hitFiles = []
  const productionFiles = []
  for (const file of files) {
    if (!includeTests && isTestFile(file)) continue
    const rec = fileRecord({ root, file, cache: idx })
    if (!rec) continue
    const masked = rec.masked
    const isConfig = CONFIG_FILES.includes(file)
    let hit = false
    for (const o of rec.specifiers) {
      if (packageRootOf(o.spec) !== dep) continue
      hit = true
      classes.add(o.kind === 'dynamic' ? 'dynamic-import' : 'import')
      if (isConfig) classes.add('config-file')
    }
    if (isConfig && configTokenRe(dep).test(masked)) { classes.add('config-file'); hit = true }
    if (rec.commands().includes(dep)) { classes.add('cli'); hit = true }
    if (hit) {
      hitFiles.push(file)
      if (!isTestFile(file)) productionFiles.push(file)
    }
  }
  // types 类：@types/* 由 tsconfig 自动包含（tsconfig.json 未声明 "types" 字段时全部生效）
  if (dep.startsWith('@types/')) {
    const ts = readTracked({ root, file: 'tsconfig.json' })
    if (ts !== null) {
      const declared = tsconfigTypes(ts)
      if (declared === null) {
        classes.add('types'); hitFiles.push('tsconfig.json')
      } else if (declared.includes(dep) || declared.includes(dep.slice('@types/'.length))) {
        classes.add('types'); hitFiles.push('tsconfig.json')
      } else {
        // ★ R2：`types` 字段只关掉"全局自动包含"，**模块级**类型包（@types/react 这类）是靠
        //   `import 'react'` 的模块解析生效的 —— 把它一并判死等于给 B1 递刀（删了 typecheck 才炸）。
        const base = typedModuleOf(dep)
        // ★ Rider 4-①（Task 7 复审）：这里原来扫的是内部 cache 的 `idx.values()`，于是结论
        //   取决于**cache 覆盖面**而非入参 `files` —— 实测 `collectEvidence({files:['tsconfig.json'],
        //   dep:'@types/react'})` 无 cache 得 `[]`，同一个调用只要缓存里恰好多一个 `src/a.tsx`
        //   就变成 `['types']`。同一函数同参数两个结论 = check/sync 的结论不可复现。
        //   现改为**只扫入参 `files`**：入参是契约（"在哪些文件里找证据"），cache 只是性能优化，
        //   优化不得改变语义（测试同时钉住"有无 cache 结论一致"）。
        const importers = []
        for (const f of files) {
          if (!includeTests && isTestFile(f)) continue
          const rec = fileRecord({ root, file: f, cache: idx })
          if (rec && rec.specifiers.some((o) => packageRootOf(o.spec) === base)) importers.push(rec.file)
        }
        if (importers.length) {
          classes.add('types')
          hitFiles.push(...importers.sort())
        }
      }
    }
  }
  // 工具约定：包没有 import，它读的配置文件就是证据（tsconfig.json 不是代码文件，走不了上面的候选过滤）
  const owner = TOOL_CONFIG_FILES[dep]
  if (owner && readTracked({ root, file: owner }) !== null) { classes.add('config-file'); hitFiles.push(owner) }
  return {
    classes: EVIDENCE_CLASSES.filter((c) => classes.has(c)),
    files: [...new Set(hitFiles)],
    productionFiles: [...new Set(productionFiles)],
  }
}

/** 解析 requirements.txt（跳过注释与行内注释） */
export function readRequirements({ root, file }) {
  const text = readTracked({ root, file })
  if (text === null) return []
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^([A-Za-z0-9_.\-]+)\s*(.*)$/)
    if (!m) continue
    out.push({ name: m[1].replace(/_/g, '-').toLowerCase(), spec: m[2].trim() })
  }
  return out
}

export const REQUIREMENTS_FILE = 'public/sample-skills/_common/requirements.txt'

/** 暂存目录体积（缺失记 0；仅趋势，不设阈值 —— 见 spec §6.3 P6） */
export function dirSizeOf({ root, rel }) {
  let total = 0
  const walk = (d) => {
    let ents
    try { ents = readdirSync(join(root, d), { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const r = `${d}/${e.name}`
      if (e.isDirectory()) walk(r)
      else { try { total += statSync(join(root, r)).size } catch { /* 并发删除等，忽略 */ } }
    }
  }
  walk(rel)
  return total
}

const BUILTIN_MODULES = new Set([...builtinModules, ...builtinModules.map((m) => m.replace(/^node:/, ''))])
/** 运行时内建模块不算依赖（用 node 的 builtinModules，不手抄清单 —— 手抄必漏） */
function isBuiltinModule(n) { return BUILTIN_MODULES.has(n) }
/** tsconfig 的 `@/*` 别名与项目内的 `~/`（上游技能示例文件的工程别名）不算依赖；入参是**原始说明符** */
function isLocalAlias(spec) { return spec.startsWith('@/') || spec.startsWith('~/') }

/**
 * 幽灵依赖判定（源码 import 了但没声明）。
 *
 * ★ R4（Task 5 复审 rider）：**sync 与 check 必须共用这一份判据**。
 *   实测代价：Task 7 计划里另写的 `ghostOf()`（只滤 `@/`、不看 optionalProbes）
 *   在真仓会多报两条 —— `~`（public/sample-skills 上游示例里的 `~/threads/...` 别名）
 *   与 `jszip`（shared/pack-zip.test.mjs:85 的 try/catch 可选探针）。
 *   这两类"必须不报"在 ledger.test.mjs 的夹具里已经钉住，两边各写一份 = 门禁自己打自己脸。
 *
 * @param declared 已声明的包名集合（sync 传本次新扫出的；check 传台账里的）
 * @param probes   可选探针清单（省略则现场算；check 路径可直接用台账里的 `optionalProbes`）
 */
export function computeGhost({ root, files, declared, probes = null, cache = null }) {
  const idx = cache || buildEvidenceIndex({ root, files })
  const imported = parseDeclaredImports({ root, files, cache: idx })
    .filter((s) => !isLocalAlias(s))
    .map(packageRootOf)
  const optionalSpecs = new Set((probes || optionalProbes({ root, files, cache: idx })).map((o) => packageRootOf(o.spec)))
  return [...new Set(imported)]
    .filter((n) => n && !declared.has(n) && !isBuiltinModule(n) && !isLocalAlias(n) && !optionalSpecs.has(n))
    .sort()
}

export function syncDeps({ root, files, sizes, dryRun = false } = {}) {
  const tracked = files || trackedFiles({ root })
  const codeTracked = codeFiles(tracked, { includeTests: true })
  // package.json 的 scripts 属 CLI 证据（spec §6.2 类 4），故与代码文件一起参与判定
  const evidenceFiles = [...codeTracked, 'package.json']
  const pkg = readJson({ root, rel: 'package.json', fallback: { dependencies: {}, devDependencies: {}, scripts: {} } })
  const kernelPkg = readJson({ root, rel: 'kernel/package.json', fallback: {} })
  // ★ R1：一次扫描里**只解析一次**（读盘 + mask + 抽说明符），下面三个消费者共用同一份索引。
  //   否则 65 个依赖各扫一遍全仓 = 56.8s（实测）；共享后见 `docs/待处理清单.md` / 本任务报告。
  //   索引取 `tracked`（而不是 evidenceFiles）：配置文件（tsconfig.json / electron-builder.yml 等）
  //   也要在内（@types/* 与 TOOL_CONFIG_FILES 的判定会用到），多解析几个小文件换掉整轮重扫。
  const cache = buildEvidenceIndex({ root, files: tracked })

  const buildPackages = (depsObj) => Object.keys(depsObj || {}).sort().map((name) => {
    const ev = collectEvidence({ root, files: evidenceFiles, dep: name, cache })
    return {
      name,
      evidence: { classes: ev.classes, files: ev.files.slice(0, 20) },
      status: ev.classes.length ? 'used' : 'unused',
    }
  })

  const runtime = buildPackages(pkg.dependencies)
  const dev = buildPackages(pkg.devDependencies)
  const kernelDeps = Object.keys(kernelPkg.dependencies || {})

  // Python：内嵌集（真源在本台账的 python.embedded；构建脚本改读它 —— 见 Task 11 B2）
  const prev = readDeps({ root }) || {}
  const embedded = (prev.python && prev.python.embedded) || DEFAULT_PYTHON_EMBEDDED
  const reqs = readRequirements({ root, file: REQUIREMENTS_FILE })

  const optional = optionalProbes({ root, files: codeTracked, cache })
  const declaredAll = new Set([...runtime, ...dev].map((p) => p.name))
  // 只登记**未声明**的探针：这条清单的作用是解释"为什么它没被报成幽灵依赖"，
  // 已声明的包（如 rcedit）不需要解释，登记进去反而让清单变噪声。
  const unresolvedProbes = optional.filter((o) => !declaredAll.has(packageRootOf(o.spec)))
  // 幽灵判定走公共实现（computeGhost）：check 侧回读时用**台账里的** declared/optionalProbes
  // 调同一个函数，两侧判据不可能漂移 —— 见 computeGhost 的注释（实测漂移会多报 `~` 与 jszip）。
  const ghost = computeGhost({ root, files: codeTracked, declared: declaredAll, probes: unresolvedProbes, cache })

  const data = {
    version: 1,
    generatedBy: 'node kit/cli.mjs sync',
    _note: 'packages[].evidence 与 optionalProbes 由 sync 生成；notes / gates / sizes 可人工维护（sync 保留）。status=unused 的判定见 spec §6.2（五类引用证据）。',
    domains: {
      'npm-runtime': { source: 'package.json#dependencies', packages: runtime },
      'npm-dev': { source: 'package.json#devDependencies', packages: dev },
      kernel: {
        source: 'kernel/package.json#dependencies',
        assertZero: true,
        packages: kernelDeps.map((name) => ({ name, status: 'declared' })),
      },
      'python-embedded': { source: 'kit/manifest/deps.json#python.embedded', packages: embedded.map((name) => ({ name })) },
      'python-skills': { source: REQUIREMENTS_FILE, packages: reqs.map((r) => ({ name: r.name, spec: r.spec })) },
    },
    python: { embedded },
    optionalProbes: unresolvedProbes,
    notes: prev.notes || {},
    gates: prev.gates || { ci: [], manual: [] },
    sizes: sizes || prev.sizes || {
      node_modules: dirSizeOf({ root, rel: 'node_modules' }),
      'runtime/python': dirSizeOf({ root, rel: 'runtime/python' }),
      'runtime/skills': dirSizeOf({ root, rel: 'runtime/skills' }),
    },
  }
  // ★ dryRun（Task 7）：`kit/cli.mjs sync --dry-run` 是"预演"，**不得**落盘。
  //   加这个参数的原因：初版只有 syncVersions 认 dryRun，syncDeps 照样写 —— 于是"预演"会改掉
  //   一半台账（deps.json 变了、versions.json 没变），仓库进入两边口径不一致的状态，比不做预演更坏。
  if (!dryRun) writeDeps({ root, data })
  return { data, unused: [...runtime, ...dev].filter((p) => p.status === 'unused').map((p) => p.name), ghost }
}

/** 内嵌 Python 包的初始真源（Task 11 会把它从 scripts/build-embedded-python.mjs:82 迁到这里） */
export const DEFAULT_PYTHON_EMBEDDED = [
  'openpyxl', 'python-docx', 'xlrd', 'Pillow', 'beautifulsoup4', 'rapidocr-onnxruntime',
  'PyPDF2', 'pypdf', 'pypdfium2', 'requests', 'Jinja2', 'openai', 'pydantic',
]

export function readDeps({ root }) { return readJson({ root, rel: DEPS_FILE, fallback: null }) }
export function writeDeps({ root, data }) { writeJson({ root, rel: DEPS_FILE, data }) }
