// shared/process-artifacts.mjs —— **过程文件归集约定**的唯一真源（待办 860）
// ---------------------------------------------------------------------------
// 要解决什么（用户原话）：「agent 在完成阶段后，要做好过程文件脚本的整理和清理，尽量不
// 暴漏过多垃圾文件给用户，可以集中整理在项目根目录下的隐藏文件夹，方便溯源过程和回退」。
//
// 现实病灶：agent 干活时产出的**过程物**（诊断/探针脚本、抓取结果、中间产物、日志）
// 直接落在用户的项目根目录，与用户的交付物（申报材料、表格、源码）混在一起。用户看到的
// 是"我的项目里怎么多了十几个莫名其妙的文件"，且**分不清哪个能删**。
//
// 本模块只做三件事，且都是**纯函数**（无 IO），IO 执行在 `kernel/process-hygiene.mjs`：
//   ① 定义目录约定（`.ponos/process/`）——**常量只在这里出现一次**；
//   ② 判定"这个文件名算不算过程物"（判据见下，**宁可少归类，不可误归类**）；
//   ③ 产出归集/回退**计划**（planned moves），由执行层按计划落盘。
//
// ── 目录约定的来源（不是新发明）────────────────────────────────────────────
// `shared/team-source.mjs` 的 `TEAM_CONTAINER_DIR = '.ponos'` 已是本仓既有的"顶层
// 隐藏容器"约定（团队模式的清单/成员日志/密钥/CAS 全收在 `<团队根>/.ponos/` 下）。
// 本模块**直接复用该常量**（import，而非再写一遍字面量），团队模式与项目模式共用同一个
// 顶层容器——避免出现"第二套顶层隐藏目录"（`.agent-tmp` / `.yfworking2` 之类）。
// 容器内部分工（并行工作线之间的**唯一目录体系**裁定）：
//   · `.ponos/process/`   ← 本模块（过程文件/脚本/中间产物：归集、溯源、回退）
//   · `.ponos/state/`     ← 另一条线（结构化状态：file_map.json、project_status.json）
//   · `.ponos/knowledge/` ← 另一条线（项目知识库）
//   · `.ponos/{team.json,members,keys,cas,versions,claims,experience,policies.json}`
//                             ← 团队模式（team-source.mjs 的 TEAM_LAYOUT）
//
// ── 归集的判据（为什么这么保守）────────────────────────────────────────────
// 红线是「**绝不能删用户的真实文件**」。本机制**只移动、从不删除**，且移动前要求三个
// 条件同时成立（任一不满足就跳过，并把跳过原因写进清单）：
//   a. **文件名本身是过程物形态**（见 PROCESS_ARTIFACT_PATTERNS）——不靠"猜测内容"，
//      只认那些正常交付物几乎不可能取的名字（`tmp-*` / `*-probe.*` / `*.log` …）；
//   b. **git 未跟踪**（`git ls-files` 里没有）——已入库的文件是项目的一部分，动了就毁 diff；
//      git 状态**读不到**时（见 readTrackedPaths 的 ok:false）整批放弃，宁可不归类；
//   c. **只在项目根目录的**普通文件（不下钻子目录）——子目录里的 `logs/app.log`、
//      `data/*.bak` 完全可能是用户的真实数据，下钻扫描的误伤代价远高于收益。
// 刻意**不**纳入的模式（曾被列入候选、经权衡剔除）：`*.bak`（gxtz 技能用 `.bak` 表示
// "有意义的迭代版本"，移走会让用户找不到）、裸 `out`/`err`/`nul`（本仓自身的误重定向
// 产物，但在用户项目里 `out` 是合理的名字）、`scratch/`（本仓既有的冒烟工作区目录，
// 被并行工作线使用，动它会打扰别人）。
//
// ── 溯源与回退 ─────────────────────────────────────────────────────────────
// 归集不是"藏起来"，而是"搬到一个有账本的地方"：
//   · `<phase>/manifest.json` —— 机器可读账本：原路径、归集路径、大小、sha256、时间、来源；
//   · `<phase>/INDEX.md`      —— 人可读索引：一眼看出"哪个阶段、什么时候、把什么搬到了哪"，
//                                并附带**一行可粘贴的回退命令**。
// 一个 phase = 一个"阶段"（默认取会话 id；人工归集可传 `--phase 阶段2-实现` 之类语义名）。
// 同一 phase 的多次归集**追加**到同一账本，故"阶段产出"是可追溯的时间序，不是一坨。

import { join } from 'node:path'
import { TEAM_CONTAINER_DIR } from './team-source.mjs'

/** 顶层容器名（**唯一真源在 shared/team-source.mjs**，此处只做再导出，禁止另写字面量）。 */
export const PROCESS_CONTAINER_DIR = TEAM_CONTAINER_DIR

/** 布局常量集中在此，避免各处手拼路径写歪。 */
export const PROCESS_LAYOUT = Object.freeze({
  CONTAINER: PROCESS_CONTAINER_DIR,
  DIR: 'process',
  MANIFEST: 'manifest.json',
  INDEX: 'INDEX.md',
  /** 清单格式版本（跨版本读旧清单时要能判断"是不是我认识的格式"）。 */
  SCHEMA_VERSION: 1,
})

/**
 * 过程物文件名判据（**匹配 basename**，忽略大小写；匹配前剥掉前导点）。
 *
 * 每条都写"为什么它一定不是交付物"——后续想加模式时，请一并写清这条理由，
 * 否则本条判据会慢慢变成"看到像就收"，误伤用户文件的概率随之上升。
 */
export const PROCESS_ARTIFACT_PATTERNS = Object.freeze([
  // tmp-xxx / tmp_xxx（各语言的临时文件名习惯；交付物不会以 tmp 命名）
  { id: 'tmp-prefix', re: /^tmp[-_].+/i, why: 'tmp- 前缀是通行的一次性临时文件命名' },
  { id: 'tmp-suffix', re: /^.+[-_]tmp\.[^.]+$/i, why: 'xxx-tmp.ext 同上，尾部 tmp 表临时' },
  { id: 'tmp-ext', re: /^.+\.tmp$/i, why: '.tmp 扩展名本身就是"未完成/临时"' },
  // _xxx_append2.md：临时追加文件（本仓 compact.mjs 的 isTransientArtifact 已认这种形态）
  { id: 'append-scratch', re: /^_?[a-z0-9]+_append\d*\.[^.]+$/i, why: '_x_appendN.ext 是"临时追加/草稿"的既有本仓约定' },
  // 日志：*.log 已在本仓 .gitignore 里（属"调试临时"类），不是交付物
  { id: 'log', re: /^.+\.log$/i, why: '.log 是运行日志，交付时不该留在项目根' },
  // 探针 / 诊断 / 调试脚本：probe-x.mjs、diag-1.txt、cache-age-probe.mjs、tmp-wfdiag
  { id: 'probe-prefix', re: /^(?:probe|diag|debug)[-_].+\.[^.]+$/i, why: 'probe-/diag-/debug- 前缀是"为本次排查临时写的"' },
  { id: 'probe-suffix', re: /^.+[-_](?:probe|diag|debug)\.[^.]+$/i, why: 'xxx-probe.ext 同上（后缀形态）' },
  { id: 'diag-bare', re: /^(?:probe|diag|wfdiag|tmp-diag)(?:[-_][^.]*)?$/i, why: '裸 wfdiag/probe 等**无扩展名**诊断产物（带扩展名的走上面两条，避免把 probe.docx 误收）' },
  // 提交信息草稿 / 一次性验证脚本（本仓既有形态：commit-msg.txt、verify-*.mjs）
  { id: 'commit-msg', re: /^commit-msg\.txt$/i, why: '提交信息草稿（一次性，写完即无用）' },
  { id: 'verify-script', re: /^verify[-_].+\.(?:mjs|cjs|js|py|ps1|sh|bat)$/i, why: 'verify-*.{mjs,py,...} 是"这次改动跑一遍就完"的验证脚本' },
])

/** 匹配前剥掉前导点：`.tmp-ag.json` 与 `tmp-ag.json` 同样是垃圾（本仓根目录实测就有）。 */
const stripLeadingDots = (s) => String(s ?? '').replace(/^\.+/, '')

/**
 * 文件名是否为过程物。返回命中详情（供清单写"为什么归类它"），未命中返回 null。
 * @param {string} name 文件名（不含目录）
 */
export function matchProcessArtifact(name) {
  const base = stripLeadingDots(name).trim()
  if (!base) return null
  for (const p of PROCESS_ARTIFACT_PATTERNS) if (p.re.test(base)) return { id: p.id, why: p.why }
  return null
}

/** 布尔便捷形式。 */
export function isProcessArtifactName(name) {
  return matchProcessArtifact(name) !== null
}

/**
 * 阶段名归一：既作目录名也作账本字段，必须**安全**（防路径穿越）且**稳定**（同阶段同名）。
 *
 * 拒绝一切可能逃出 `<进程根>` 的写法：`..`、`/`、`\`、盘符冒号、绝对路径。
 * 非法或空白一律回落到调用方给的兜底（通常 = 会话 id 或时间戳），**绝不抛错**：
 * 归集是收尾动作，不该因为一个名字不合规就让整个阶段收尾失败。
 */
export function normalizePhaseName(raw, fallback = 'unlabeled') {
  const s = String(raw ?? '').trim()
  const safe = s
    .replace(/[\\/:*?"<>|]/g, '-') // 路径分隔符 → 连字符（顺带堵死 `a/b` 逃逸）；冒号堵死 `C:` 盘符
    .replace(/\.\.+/g, '')         // 父目录引用：**先删点**再去前导点（顺序反了会把 `...` 削成 `.`）
    .replace(/^\.+/, '')           // 前导点（避免造出 `.` / `..` / 隐藏阶段目录）
    .replace(/^[-\s]+/, '')
    .replace(/[-\s]+$/, '')
    .slice(0, 64)
  if (safe && safe !== '.' && safe !== '..') return safe
  return String(fallback ?? 'unlabeled').replace(/[\\/:*?"<>|.]/g, '-').slice(0, 64) || 'unlabeled'
}

/** 归集根：`<项目根>/.ponos/process`（相对路径形态由 `relProcessRoot()` 给出）。 */
export function processRoot(projectRoot) {
  return join(String(projectRoot), PROCESS_LAYOUT.CONTAINER, PROCESS_LAYOUT.DIR)
}

/** 某阶段的归集目录（绝对路径）。 */
export function processPhaseDir(projectRoot, phase) {
  return join(processRoot(projectRoot), normalizePhaseName(phase))
}

/** 归集根的**仓库相对路径**（posix 风格，写进文档/提示词用）。 */
export function relProcessRoot(phase) {
  const base = `${PROCESS_LAYOUT.CONTAINER}/${PROCESS_LAYOUT.DIR}`
  return phase ? `${base}/${normalizePhaseName(phase)}` : base
}

/** 统一成 posix 相对路径（账本里存 posix，跨平台读起来一致）。 */
export function toPosixRel(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/**
 * 归集计划（**纯函数**：不碰磁盘，全部输入由调用方探测后传入）。
 *
 * @param {object} input
 * @param {string[]} input.files          候选文件名（**项目根下一层**，不含目录；调用方负责只给文件）
 * @param {Set<string>|string[]} input.tracked git 已跟踪的相对路径集合（posix）
 * @param {Set<string>|string[]} [input.existingTargets] 归集目标目录里**已存在**的文件名
 * @param {(name: string) => ({bytes:number, sha256:string})} [input.probe] 单文件元信息探测器
 * @param {string} input.phase
 * @param {string} [input.at]  归集时刻（ISO）
 * @param {string} [input.source] 来源标记（kernel-closeout / cli-manual / …）
 * @returns {{phase:string, dir:string, collected:object[], skipped:object[]}}
 */
export function planProcessCollection({ files = [], tracked, existingTargets = [], probe = null, phase, at = new Date().toISOString(), source = 'unspecified' } = {}) {
  const trackedSet = tracked instanceof Set ? tracked : new Set((tracked || []).map(toPosixRel))
  const targetSet = existingTargets instanceof Set ? existingTargets : new Set(existingTargets || [])
  const dir = relProcessRoot(phase)
  const collected = []
  const skipped = []
  const seen = new Set()
  for (const raw of files) {
    const name = String(raw ?? '').trim()
    if (!name || name === '.' || name === '..') continue
    // 只接受"根目录下的单层文件名"：带分隔符的一律拒（调用方若把深层路径塞进来，
    // 这里必须挡住，而不是照搬——否则"下钻扫描的误伤"会从这里漏进来）。
    if (/[\\/]/.test(name)) { skipped.push({ path: toPosixRel(name), reason: 'not-root-level' }); continue }
    if (seen.has(name)) continue
    seen.add(name)
    const hit = matchProcessArtifact(name)
    if (!hit) { skipped.push({ path: name, reason: 'not-artifact' }); continue }
    const rel = toPosixRel(name)
    if (trackedSet.has(rel)) { skipped.push({ path: rel, reason: 'git-tracked', note: '已入库的文件属项目的一部分，归集会毁 diff' }); continue }
    if (targetSet.has(name)) { skipped.push({ path: rel, reason: 'target-exists', note: '归集目录里已有同名文件（绝不覆盖）' }); continue }
    let meta = { bytes: null, sha256: null }
    if (typeof probe === 'function') {
      try {
        meta = { ...meta, ...(probe(name) || {}) }
      } catch { /* 探测失败不阻断：元信息缺失如实记 null */ }
    }
    collected.push({ from: rel, to: `${dir}/${name}`, bytes: meta.bytes ?? null, sha256: meta.sha256 ?? null, at, source, pattern: hit.id, why: hit.why })
  }
  return { phase: normalizePhaseName(phase), dir, collected, skipped }
}

/**
 * 回退计划（**纯函数**）：把账本里 `status === 'collected'` 的条目搬回原处。
 *
 * 两条硬约束（防"回退把新文件覆盖了"）：
 *   ① 原路径**已存在**内容 ⇒ 跳过。用户可能又在原处放了同名文件，覆盖就是数据丢失；
 *   ② 归集文件**已不存在**（用户手动删过/已回退过）⇒ 跳过，不报错（幂等）。
 * `restoredAt` 非空 = 已回退过，跳过。
 *
 * @param {object} input
 * @param {object} input.manifest 账本（readProcessManifest 的返回值）
 * @param {(relPath: string) => boolean} input.exists 相对项目根的路径是否存在（由调用方注入）
 */
export function planProcessRestore({ manifest, exists } = {}) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : []
  const has = typeof exists === 'function' ? exists : () => false
  const restored = []
  const skipped = []
  for (const e of entries) {
    if (e.status !== 'collected' || e.restoredAt) { skipped.push({ from: e.from, reason: 'already-restored' }); continue }
    if (!has(e.to)) { skipped.push({ from: e.from, reason: 'collected-file-missing' }); continue }
    if (has(e.from)) { skipped.push({ from: e.from, reason: 'origin-exists', note: '原处已有文件，绝不覆盖' }); continue }
    restored.push({ from: e.from, to: e.to })
  }
  return { restored, skipped }
}

/** 把一批归集结果并入账本（纯函数，返回新对象；同一 `from` 已收集过则不重复登记）。 */
export function mergeManifest(prev, { phase, projectRoot, collected = [], skipped = [], at, source }) {
  const base = prev && typeof prev === 'object' && Array.isArray(prev.entries)
    ? { ...prev, entries: [...prev.entries], skipped: Array.isArray(prev.skipped) ? [...prev.skipped] : [] }
    : { version: PROCESS_LAYOUT.SCHEMA_VERSION, phase: normalizePhaseName(phase), projectRoot: String(projectRoot ?? ''), updatedAt: at, entries: [], skipped: [] }
  const known = new Set(base.entries.filter((e) => e.status === 'collected').map((e) => e.from))
  for (const c of collected) {
    if (known.has(c.from)) continue
    known.add(c.from)
    base.entries.push({ ...c, status: 'collected', restoredAt: null })
  }
  for (const s of skipped) base.skipped.push({ ...s, at, source })
  // 跳过项可能很多（每次收尾都会重新扫描"不匹配的文件"），只保留最近 200 条：
  // 账本的价值在"我搬走了什么"，跳过项只是"我没动什么"的证据，不该无限增长。
  if (base.skipped.length > 200) base.skipped = base.skipped.slice(-200)
  base.phase = normalizePhaseName(phase)
  base.projectRoot = String(projectRoot ?? base.projectRoot ?? '')
  base.updatedAt = at
  base.version = PROCESS_LAYOUT.SCHEMA_VERSION
  return base
}

/** 账本里的条目标记为已回退（纯函数）。 */
export function markRestored(manifest, restoredPairs, at) {
  const keys = new Set((restoredPairs || []).map((r) => r.from))
  return {
    ...manifest,
    entries: (manifest?.entries || []).map((e) => (keys.has(e.from) ? { ...e, status: 'restored', restoredAt: at } : e)),
    updatedAt: at,
  }
}

/** 一行式回退命令（写进 INDEX.md，让用户不必知道内核在哪、不必记 flag）。 */
export function restoreCommandLine(phase) {
  const rel = `${relProcessRoot(phase)}/${PROCESS_LAYOUT.MANIFEST}`
  return `node -e "const fs=require('fs'),p=require('path');const m=JSON.parse(fs.readFileSync('${rel}','utf8'));let n=0;for(const e of m.entries){if(e.status!=='collected'||fs.existsSync(e.from))continue;if(!fs.existsSync(e.to))continue;fs.mkdirSync(p.dirname(e.from),{recursive:true});fs.renameSync(e.to,e.from);console.log('restored',e.from);n++}console.log('共回退',n,'个文件')"`
}

const fmtBytes = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${n} B` : '—')
const shortSha = (s) => (typeof s === 'string' && s.length >= 12 ? s.slice(0, 12) : '—')

/**
 * 渲染人可读索引（INDEX.md）。
 *
 * 为什么还要 markdown（有 manifest.json 不就够了）：清单是给"想知道项目里怎么多了一个
 * 隐藏文件夹"的人看的——他需要的是**一句话解释 + 一眼可核对的清单 + 一条能粘的回退命令**，
 * 而不是去读 JSON。两者同一次归集里一起生成，不会漂移。
 */
export function renderProcessIndex(manifest) {
  const m = manifest || {}
  const entries = Array.isArray(m.entries) ? m.entries : []
  const lines = []
  lines.push(`# 过程文件归集索引（阶段：${m.phase || '—'}）`)
  lines.push('')
  lines.push('> 本目录由 agent 在**阶段收尾**时自动/手动归集，存放一次性过程物（诊断脚本、探针、')
  lines.push('> 中间产物、日志）。**这里没有任何东西被删除**——每个文件都在下面的清单里登记了原路径，')
  lines.push('> 可随时移回。本目录整体可安全删除（删了只是丢过程留痕，不影响交付物）。')
  lines.push('')
  lines.push(`- 项目根：\`${m.projectRoot || '—'}\``)
  lines.push(`- 最近更新：${m.updatedAt || '—'}`)
  lines.push(`- 约定真源：\`shared/process-artifacts.mjs\`（目录：\`${relProcessRoot()}\`）`)
  lines.push('')
  lines.push('## 已归集')
  lines.push('')
  if (!entries.length) {
    lines.push('（无）')
  } else {
    lines.push('| 归集时间 | 来源 | 原路径 | 现路径 | 大小 | sha256 | 状态 |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const e of entries) {
      const status = e.restoredAt ? `已回退（${e.restoredAt}）` : '已归集'
      lines.push(`| ${e.at || '—'} | ${e.source || '—'} | \`${e.from}\` | \`${e.to}\` | ${fmtBytes(e.bytes)} | \`${shortSha(e.sha256)}\` | ${status} |`)
    }
  }
  lines.push('')
  lines.push('## 回退')
  lines.push('')
  lines.push('在项目根目录执行（逐个移回原路径；原处已有同名文件时**跳过不覆盖**）：')
  lines.push('')
  lines.push('```bash')
  lines.push(restoreCommandLine(m.phase))
  lines.push('```')
  lines.push('')
  const skipped = Array.isArray(m.skipped) ? m.skipped : []
  if (skipped.length) {
    const byReason = new Map()
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1)
    lines.push('## 未归集（刻意不动）')
    lines.push('')
    lines.push('| 原因 | 条数 | 含义 |')
    lines.push('|---|---|---|')
    const meaning = {
      'not-artifact': '名字不像过程物（**用户的正常文件**，例如源码/文档/表格）',
      'git-tracked': '已入 git 版本控制（动了会毁 diff）',
      'target-exists': '归集目录已有同名文件（不覆盖）',
      'not-root-level': '不在项目根一层（不下钻子目录，避免误伤用户数据）',
    }
    for (const [r, n] of byReason) lines.push(`| ${r} | ${n} | ${meaning[r] || '—'} |`)
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push('## 归集判据（为什么"没被归类"的文件是真的没动）')
  lines.push('')
  lines.push('一个文件会被归集，当且仅当三条同时成立：① 文件名命中过程物模式（`tmp-*`、`*-probe.*`、')
  lines.push('`*.log`、`commit-msg.txt`、`verify-*.mjs` 等）；② git **未**跟踪；③ 位于项目根**一层**。')
  lines.push('任一不满足即跳过并记入上面的"未归集"表。**从不删除**任何文件。')
  lines.push('')
  return lines.join('\n')
}

/**
 * 写进内核系统提示词的**规则段**（待办 860 的提示词侧）。
 *
 * 为什么这段文案在这里而不在 `kernel/prompt.mjs`：它是**目录约定的一部分**，必须与
 * `PROCESS_LAYOUT` 挨着，否则改了目录名而忘了改提示词 → agent 把过程物写到不存在的约定里
 * （而且它不会报错，只会"看起来照做了"）。单测 `shared/process-artifacts.test.mjs` 钉住
 * "提示词文案里出现的目录 = 本模块的常量"，漂移即红。
 *
 * 注入点在 `kernel/cli.mjs`（composeSystemPrompt 的 append 通道，见那里的注释）。
 */
export function processHygieneRuleText() {
  const root = relProcessRoot()
  return [
    '【过程文件纪律（阶段收尾）】',
    `- 你为完成任务临时写的**过程物**（诊断/探针脚本、中间产物、抓取结果、日志、临时导出）一律放 \`${root}/<阶段名>/\`，不要散落在用户项目里。阶段名用语义短名（如 \`阶段1-勘察\`、\`ip-表格生成\`）。`,
    '- **交付物与过程物分开**：给用户的成果（源码、文档、表格、报告）留在用户指定位置；只有"这次跑完就没用"的东西才进过程目录。分不清时**留在原地并按交付物对待**（宁可多留一个文件，不可把用户的成果藏起来）。',
    `- 阶段收尾（任务完成、交付、向用户汇报）前自检一次：项目根一层是否还有自己产出的 \`tmp-*\`、\`*-probe.*\`、\`*.log\`、\`verify-*.mjs\`、\`commit-msg.txt\` 之类？有就移入 \`${root}/\` 并说明。内核也会在轮次收尾时自动兜底归集（同样只动这些形态、只移不删）。`,
    '- **禁止**移动或删除：用户原有的文件、git 已跟踪的文件、任何非本次任务产出的东西。归集**只移动、不删除**；每个被移动的文件都会登记原路径，可随时回退。',
  ].join('\n')
}
