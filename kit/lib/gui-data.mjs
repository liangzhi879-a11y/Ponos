// kit/lib/gui-data.mjs —— 把 DevKit 的既有出口组装成**一包可 JSON 序列化的 GUI 数据**
//
// 三条设计约束（都是被同一类事故逼出来的）：
//   1. **纯函数 + 全注入**：`buildGuiData({ root, checkJson, viewJson, gitInfo, now })` 的每一项都由
//      调用方给。这样单测可以拿夹具（临时目录 + 假 checkJson）钉住每一条判据，而不必跑真仓、
//      更不会"读隐藏状态"（例如偷偷去读 git 或读环境变量）——那类隐藏输入会让同一份夹具给出不同结论。
//   2. **不重算契约**：门禁结论只来自 `kit/cli.mjs check --json` / `view --json` 的**公开 JSON 出口**。
//      GUI 是**报告**，不是第二个真相 —— 若它自己再算一遍路由/工具，就会出现"页面与门禁不一致"，
//      而那时读者无法分辨谁对。★ 注意 `check --json` 在被拦时**退出码为 1 但仍打印完整 JSON**，
//      所以解析 JSON、不要拿退出码当判据（退出码只用于 GUI 顶部的结论条）。
//   3. **体积上限意识**：`kit/manifest/versions.json` 有 50 KB（`channels.routes` 103 条、`commonTools.entries`
//      98 条明细），整包内联进 HTML 会让页面巨大且无人读那些明细 ⇒ 这里**只保留计数**，
//      明细留给 `node kit/cli.mjs view --json` / 台账文件本身（它们才是明细的单一真源）。
//
// 关于 git：`collectGitInfo` 用 `execFileSync('git', ...)` 跑**只读**命令（rev-parse/log/status/tag/branch/worktree）。
// ★ 任何一条失败都**降级为 null/空并记 warnings**，绝不抛错：GUI 是给人看报告的工具，
//   在"目录不是 git 仓 / git 不在 PATH / 仓库损坏"时它应当照常出页面（只是 git 段留空 + 自报原因），
//   而不是让整份报告消失 —— 那正是最需要看报告的时刻。
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_GUIDE } from './agent-guide.mjs'
import { NON_BLOCKING_RULES } from './report.mjs'

/** 台账文件（只读；路径拼 root，便于夹具注入临时目录） */
const VERSIONS_FILE = 'kit/manifest/versions.json'
const DEPS_FILE = 'kit/manifest/deps.json'
const BASELINE_FILE = 'kit/manifest/drift-baseline.json'

/**
 * 品牌/名称探针清单（**给定**的 7 条，不许在这里发挥）。
 * 每条只声明"从哪个文件的哪一行取什么"，取值实现见 `probeName`。
 * `kind` 描述**声明点所在载体的格式**（json/yaml/html/js），GUI 里展示它，
 * 让人一眼知道"这个值是从哪类文件里抠出来的"。
 */
export const BRAND_PROBES = [
  { id: 'pkg-name', label: 'npm 包名', file: 'package.json', kind: 'json', source: 'json-name' },
  { id: 'pkg-version', label: 'GUI 发布线版本', file: 'package.json', kind: 'json', source: 'json-version' },
  { id: 'app-id', label: '安装身份 appId', file: 'electron-builder.yml', kind: 'yaml', source: 'yaml-appId' },
  { id: 'product-name', label: '安装产品名 productName', file: 'electron-builder.yml', kind: 'yaml', source: 'yaml-productName' },
  { id: 'window-title', label: '窗口标题', file: 'index.html', kind: 'html', source: 'html-title' },
  { id: 'app-version', label: '应用版本线（turbo 内核版）', file: 'version.mjs', kind: 'js', source: 'js-APP_VERSION' },
  { id: 'kernel-version', label: '内核版本线', file: 'version.mjs', kind: 'js', source: 'js-KERNEL_VERSION' },
]

/** 标识资源清单（存在才收；`.ico` 只记字节数 —— 尺寸解析要额外依赖，不值得为零依赖引入） */
export const BRAND_ASSETS = [
  'public/logo.png',
  'public/icon-16.png',
  'public/icon-32.png',
  'public/icon-48.png',
  'public/icon-64.png',
  'public/icon-128.png',
  'public/icon-256.png',
  'public/icon.ico',
  'public/favicon.ico',
  'public/logo/boost-logo-light.png',
  'public/logo/boost-logo-dark.png',
  'docs/manual/images/logo_新远方数据LOGO.png',
  'docs/manual/images/logo_新远方数据LOGO横版.png',
]

/** 深拷贝走 JSON —— 顺手**证明**这一段是纯数据（含 Set/Map/函数/循环引用会在这里炸，而不是在页面上静默丢字段） */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function shortError(e) {
  const msg = e && e.message ? e.message : String(e)
  return msg.split('\n')[0].slice(0, 200)
}

/**
 * 读仓库内文件（相对路径）；读不到 ⇒ null（调用方决定是 warning 还是致命）。
 * ★ 统一转成 LF：本仓文件多为 CRLF，而 JS 正则里 `.` **不匹配 `\r`**（`\r` 是行终止符）
 *   ⇒ `(.*)$` 这类锚定式在 CRLF 行上**永远不命中**（实测：electron-builder.yml / version.mjs
 *   的探针全部取不到值，页面上一排 `—` 而没有任何报错，是最难发现的那种静默失败）。
 */
function readRel(root, rel) {
  try {
    return readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

/** 读 JSON 台账；缺失/损坏都降级为 null + 一条 warning（GUI 不该因台账缺文件而崩） */
function readJsonRel(root, rel, warnings) {
  const text = readRel(root, rel)
  if (text === null) {
    warnings.push(`读不到 ${rel}（该段留空）`)
    return null
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    warnings.push(`${rel} 不是合法 JSON：${shortError(e)}`)
    return null
  }
}

// ── git 段 ────────────────────────────────────────────────────────────────────

/** 空 git 段（所有 git 命令都失败时的形状；页面照常渲染，只是这些格显示 —） */
function emptyGit() {
  return {
    branch: null, head: null, headSubject: null,
    dirtyTracked: null, dirtyUntracked: null, statusLines: null,
    tagCount: null, tagLatest: null,
    branches: { count: null, items: [] },
    worktrees: [],
    warnings: [],
  }
}

/**
 * 只读采集 git 锚定信息。
 * @returns 形状见 `emptyGit()`；**任何命令失败都只写 warnings，绝不抛错**（见文件头第 3 段）。
 */
export function collectGitInfo({ root, exec = execFileSync, timeout = 20000 } = {}) {
  if (!root) throw new Error('collectGitInfo: 缺少 root')
  const warnings = []
  const run = (args) => {
    try {
      const out = exec('git', args, {
        cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout,
        // ★ 显式指定 stderr 走管道：`execFileSync` 的默认行为是把子进程 stderr **继承给父进程**
        //   ⇒ 在"目录不是 git 仓"时，控制台会先刷一屏 `fatal: not a git repository` 再出报告。
        //   那是**预期内**的降级（已经记进 warnings 了），不该冒充错误刷屏。
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return String(out).replace(/\r\n/g, '\n')
    } catch (e) {
      warnings.push(`git ${args.join(' ')} 失败：${shortError(e)}`)
      return null
    }
  }
  const one = (args) => {
    const t = run(args)
    if (t === null) return null
    const v = t.trim()
    return v === '' ? null : v
  }
  const out = emptyGit()
  out.warnings = warnings
  out.branch = one(['rev-parse', '--abbrev-ref', 'HEAD'])
  out.head = one(['rev-parse', '--short', 'HEAD'])
  out.headSubject = one(['log', '-1', '--pretty=%s'])

  const status = run(['status', '--porcelain'])
  if (status !== null) {
    const lines = status.split('\n').filter((l) => l.trim() !== '')
    // ★ 口径：`??` 开头 = 未跟踪，其余（含 ` M` / `A ` / `R `）都算已跟踪的改动。
    //   拆两栏是为了让人分辨"动了已有文件"与"新增了没人管的文件"——后者常是被遗忘的临时文件。
    out.statusLines = lines.length
    out.dirtyUntracked = lines.filter((l) => l.startsWith('??')).length
    out.dirtyTracked = lines.length - out.dirtyUntracked
  }

  const tags = run(['tag', '--list'])
  if (tags !== null) {
    const list = tags.split('\n').map((s) => s.trim()).filter(Boolean)
    out.tagCount = list.length
    out.tagLatest = list.length ? list[list.length - 1] : null
  }

  const branches = run(['branch', '--format=%(refname:short)'])
  if (branches !== null) {
    const list = branches.split('\n').map((s) => s.trim()).filter(Boolean)
    // 可截断：分支多时只列前 20（够人判断"有没有并行工作线"，又不至于撑爆页面）
    out.branches = { count: list.length, items: list.slice(0, 20) }
  }

  const wt = run(['worktree', 'list', '--porcelain'])
  if (wt !== null) {
    const list = []
    for (const block of wt.split('\n\n')) {
      const path = /^worktree (.+)$/m.exec(block)
      if (!path) continue
      const br = /^branch (.+)$/m.exec(block)
      list.push({ path: path[1].trim(), branch: br ? br[1].trim().replace(/^refs\/heads\//, '') : null })
    }
    out.worktrees = list
  }
  return out
}

/** 把（可能是注入的）git 段规范成固定形状：缺键补 null，warnings 合并到调用方那本账 */
function normalizeGit(gitInfo) {
  const base = emptyGit()
  const src = gitInfo && typeof gitInfo === 'object' ? gitInfo : {}
  return {
    ...base,
    ...plain(src),
    branches: { ...base.branches, ...(src.branches ? plain(src.branches) : {}) },
    worktrees: Array.isArray(src.worktrees) ? plain(src.worktrees) : [],
    warnings: Array.isArray(src.warnings) ? [...src.warnings] : [],
  }
}

// ── findings / gate ──────────────────────────────────────────────────────────

/**
 * 规范化一条 finding：**键恒存在**（缺的写 null）。
 * 为什么把 undefined 统一成 null：GUI 的表格要按 `severity` / `rule` 过滤、逐格渲染，
 * 若某些 finding 少键，前端就得处处判 undefined；而 JSON 里 undefined 也会被丢掉 ⇒ 形状不稳。
 */
function normFinding(f = {}) {
  const s = (v) => (v === undefined || v === null ? null : String(v))
  const line = Number.isInteger(f.line) ? f.line : (typeof f.line === 'string' && /^\d+$/.test(f.line) ? Number(f.line) : null)
  return {
    rule: s(f.rule), severity: s(f.severity), subject: s(f.subject),
    file: s(f.file), line,
    expected: s(f.expected), actual: s(f.actual), hint: s(f.hint),
    reason: s(f.reason), message: s(f.message), baselinedFrom: s(f.baselinedFrom),
  }
}

function buildGate(checkJson, findings) {
  const summary = checkJson && checkJson.summary && typeof checkJson.summary === 'object'
    ? {
      red: Number(checkJson.summary.red) || 0,
      yellow: Number(checkJson.summary.yellow) || 0,
      baselined: Number(checkJson.summary.baselined) || 0,
      green: Number(checkJson.summary.green) || 0,
      rules: Number(checkJson.summary.rules) || 0,
    }
    : {
      red: findings.filter((f) => f.severity === 'red').length,
      yellow: findings.filter((f) => f.severity === 'yellow').length,
      baselined: findings.filter((f) => f.severity === 'baselined').length,
      green: 0,
      rules: Array.isArray(checkJson?.checks) ? checkJson.checks.length : 0,
    }
  const ok = checkJson && typeof checkJson.ok === 'boolean' ? checkJson.ok : summary.red === 0
  return {
    ok,
    // 退出码：优先用调用方给的**真实**退出码（gui.mjs 从子进程拿到）；否则按"红 0 ⇒ 0"推。
    // 之所以要真值：CT8/CT9 是黄灯不拦，`ok:true` 与 EXIT=0 必须一致才行 —— 这条一致性由 gui.mjs 保证。
    exitCode: Number.isInteger(checkJson?.exitCode) ? checkJson.exitCode : (ok ? 0 : 1),
    summary,
    checks: Array.isArray(checkJson?.checks)
      ? checkJson.checks.map((c) => ({
        rule: c.rule ?? null, title: c.title ?? null,
        evaluated: Number(c.evaluated) || 0, passed: c.passed !== false,
        // ★ 由**真源**（report.mjs 的 NON_BLOCKING_RULES）判定，渲染层不再自己判断 ——
        //   否则每个渲染端各写一份名单，P5/P6 这种"也发黄灯"的规则迟早被漏标成「阻断」。
        nonBlocking: NON_BLOCKING_RULES.has(c.rule),
      }))
      : [],
  }
}

// ── 台账（压缩） ───────────────────────────────────────────────────────────────

/** IPC 各侧的**数量**（快照里是通道名数组；明细不进 GUI，见文件头第 3 段） */
function ipcCounts(ipc) {
  const sides = ['invoke', 'handle', 'send', 'on', 'push']
  const out = {}
  let total = 0
  for (const k of sides) {
    const n = Array.isArray(ipc?.[k]) ? ipc[k].length : 0
    out[k] = n
    total += n
  }
  out.total = total
  return out
}

function compressVersions(v, warnings) {
  if (!v) {
    return { lines: [], contracts: [], history: {}, skills: [], skillsLock: { ids: [] }, commonTools: { baselineCount: 0, addedSinceBaseline: 0, entryCount: 0 }, channels: null }
  }
  const c = v.channels && typeof v.channels === 'object' ? v.channels : null
  if (!c) warnings.push('versions.json 没有 channels 段（契约快照缺失 ⇒ 概览的契约面计数留空）')
  return {
    // 明细小（4 条 / 14 条 / 22 条 / 20 个 id）⇒ 原样带上，页面直接可读
    lines: plain(v.lines) ?? [],
    contracts: plain(v.contracts) ?? [],
    history: plain(v.history) ?? {},
    skills: plain(v.skills) ?? [],
    skillsLock: plain(v.skillsLock) ?? { ids: [] },
    // 明细大（98 条工具名、103 条 routes）⇒ 只保留计数
    commonTools: {
      baselineCount: Array.isArray(v.commonTools?.baseline) ? v.commonTools.baseline.length : 0,
      addedSinceBaseline: Array.isArray(v.commonTools?.addedSinceBaseline) ? v.commonTools.addedSinceBaseline.length : 0,
      entryCount: Array.isArray(v.commonTools?.entries) ? v.commonTools.entries.length : 0,
    },
    channels: c ? {
      snapshotAt: c.snapshotAt ?? null,
      routes: Object.keys(c.routes || {}).length,
      routePrefixes: Object.keys(c.routePrefixes || {}).length,
      wsOut: Array.isArray(c.wsOut) ? c.wsOut.length : 0,
      wsIn: Array.isArray(c.wsIn) ? c.wsIn.length : 0,
      ipc: ipcCounts(c.ipc),
      tools: Object.keys(c.tools || {}).length,
      staticToolCount: c.staticToolCount ?? null,
      excluded: Array.isArray(c.excluded) ? c.excluded.length : 0,
      scopeCount: c.scopeCount ?? null,
      scopeRedCount: c.scopeRedCount ?? null,
    } : null,
  }
}

/**
 * 依赖域。`unused`/`ghost` 两栏**不在** `deps.json` 里（那份台账只存事实：包清单/体积/说明），
 * 它们由规则算出来 —— 所以这里从**门禁的 findings** 取（P1 未用=黄、P2 幽灵=红），
 * 并保留 `deps.json.unused`/`ghost` 的优先权（万一将来台账也落盘了这两栏，以台账为准）。
 */
function buildDeps(depsRaw, findings) {
  if (!depsRaw) return { domains: [], unused: [], ghost: [], sizes: {}, notes: null, unusedSource: 'rules', ghostSource: 'rules' }
  const domains = Object.entries(depsRaw.domains || {}).map(([id, d]) => ({
    id,
    count: Array.isArray(d?.packages) ? d.packages.length : 0,
    packages: plain(d?.packages) ?? [],
    source: d?.source ?? null,
  }))
  const fromFindings = (rule) => findings.filter((f) => f.rule === rule).map((f) => f.subject)
  const asList = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : null)
  const unused = asList(depsRaw.unused) ?? fromFindings('P1')
  const ghost = asList(depsRaw.ghost) ?? fromFindings('P2')
  return {
    domains,
    unused,
    ghost,
    sizes: plain(depsRaw.sizes) ?? {},
    notes: plain(depsRaw.notes) ?? null,
    unusedSource: Array.isArray(depsRaw.unused) ? 'ledger' : 'rules',
    ghostSource: Array.isArray(depsRaw.ghost) ? 'ledger' : 'rules',
  }
}

// ── 品牌/名称探针 ─────────────────────────────────────────────────────────────

/** 在文本里按行找第一个命中（行号从 1 开始）—— 探针的行号必须是**真文件里的行**，不能靠正则位移猜 */
function lineHit(text, re) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re)
    if (m) return { line: i + 1, match: m }
  }
  return null
}

function stripQuotes(s) {
  const t = String(s).trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

/**
 * 一条探针的取值：返回 `{ value, line }` 或 null。
 * ★ 刻意**不用** JSON.parse 取"值"以外的任何东西当行号：行号只能来自真文件的行扫描
 *   （用位移反推的行号在文件被格式化后会指向错误的行 —— 而探针表的价值就在于"指到那一行"）。
 */
function probeName(probe, text) {
  if (text === null) return null
  switch (probe.source) {
    case 'json-name':
    case 'json-version': {
      const key = probe.source === 'json-name' ? 'name' : 'version'
      // 值取自 JSON 解析（权威），行号取自逐行扫描（人可核对）
      let value = null
      try {
        value = JSON.parse(text)[key] ?? null
      } catch {
        return null
      }
      const hit = lineHit(text, new RegExp(`^\\s*"${key}"\\s*:`))
      return { value: value === null ? null : String(value), line: hit ? hit.line : null }
    }
    case 'yaml-appId':
    case 'yaml-productName': {
      const key = probe.source === 'yaml-appId' ? 'appId' : 'productName'
      const hit = lineHit(text, new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`))
      if (!hit) return null
      const raw = stripQuotes(hit.match[1].replace(/\s+#.*$/, ''))
      return { value: raw === '' ? null : raw, line: hit.line }
    }
    case 'html-title': {
      const hit = lineHit(text, /<title>\s*([^<]*?)\s*<\/title>/i)
      if (!hit) return null
      return { value: hit.match[1] === '' ? null : hit.match[1], line: hit.line }
    }
    case 'js-APP_VERSION':
    case 'js-KERNEL_VERSION': {
      const name = probe.source === 'js-APP_VERSION' ? 'APP_VERSION' : 'KERNEL_VERSION'
      const hit = lineHit(text, new RegExp(`export const ${name}\\s*=\\s*(.+)$`))
      if (!hit) return null
      const raw = hit.match[1].replace(/\/\/.*$/, '').replace(/;?\s*$/, '')
      const value = stripQuotes(raw)
      return { value: value === '' ? null : value, line: hit.line }
    }
    default:
      return null
  }
}

/** PNG 宽高：offset 16/20 的大端 uint32（IHDR）。签名不对或文件太短 ⇒ null（不猜） */
function pngSize(buf) {
  if (!buf || buf.length < 24) return null
  const isPng = buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a
  if (!isPng) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/**
 * 收 7 条名称声明点 + 标识资源清单 + 一致性提示。
 * 三条纪律：
 *   · 取不到 ⇒ `value: null` + warning（**不抛错**：仓里少一个 index.html 不该让报告消失）；
 *   · 一致性提示**只提示不断言**（info/warn），本批**不加任何 CT 门禁规则** ——
 *     名称与标识分散在 4 个载体里是当前事实，把它变成门禁是另一批的设计工作；
 *   · 资源尺寸零依赖解析（PNG 读 IHDR；`.ico` 只记字节数）。
 */
export function collectBrand({ root, warnings = [] } = {}) {
  if (!root) throw new Error('collectBrand: 缺少 root')
  const texts = new Map()
  const names = BRAND_PROBES.map((probe) => {
    if (!texts.has(probe.file)) texts.set(probe.file, readRel(root, probe.file))
    const text = texts.get(probe.file)
    const hit = text === null ? null : probeName(probe, text)
    // 取不到值也要**留痕**（value 为 null 是页面事实，warning 是"为什么空"）：探针用精确匹配，
    // 文件被改格式（缩进/引号/改成 JSON5）时会取不到 —— 那时必须有人能看见，而不是页面上悄悄少一格
    if (text === null) warnings.push(`品牌探针：读不到 ${probe.file}（${probe.id} 留空）`)
    else if (!hit || hit.value === null || hit.value === '') warnings.push(`品牌探针：${probe.id} 在 ${probe.file} 里精确匹配不到值（${probe.source}）`)
    return { id: probe.id, label: probe.label, file: probe.file, kind: probe.kind, value: hit ? hit.value : null, line: hit ? hit.line : null }
  })

  const assets = []
  for (const file of BRAND_ASSETS) {
    let bytes = null
    try {
      bytes = statSync(join(root, file)).size
    } catch {
      warnings.push(`标识资源不存在：${file}`)
      continue
    }
    const isIco = /\.ico$/i.test(file)
    let w = null
    let h = null
    if (!isIco) {
      try {
        const size = pngSize(readFileSync(join(root, file)))
        if (size) { w = size.w; h = size.h }
        else warnings.push(`标识资源不是合法 PNG（宽高留空）：${file}`)
      } catch (e) {
        warnings.push(`标识资源读失败（${file}）：${shortError(e)}`)
      }
    }
    assets.push({ file, kind: isIco ? 'ico' : 'png', w, h, bytes })
  }

  return { names, assets, consistency: brandConsistency(names, assets) }
}

/** 一致性提示（每条 `{ level, message }`；warn 只在"真的取不到值"时出现） */
function brandConsistency(names, assets) {
  const val = (id) => names.find((n) => n.id === id)?.value ?? null
  const out = []
  const productName = val('product-name')
  const pkgName = val('pkg-name')
  const appVersion = val('app-version')
  const kernelVersion = val('kernel-version')
  const pkgVersion = val('pkg-version')
  const appId = val('app-id')

  // ① 中文品牌名 vs 安装产品名：两者本来就不同（中文品牌用于对外材料，productName 是安装身份）
  const cjk = assets.map((a) => /[\u4e00-\u9fa5]+/.exec(a.file)).find(Boolean)?.[0] ?? null
  if (cjk && productName) {
    out.push({
      level: 'info',
      message: `中文品牌名「${cjk}」（出现在标识资源文件名里）与安装产品名「${productName}」不同 —— 两者是不同用途的名称：前者用于对外材料/图标，后者是安装身份（appId 才是安装识别的唯一键），不必一致。`,
    })
  }
  // ② 安装名 vs 包名：允许不同（安装名给人看，包名给 npm 看）
  if (productName && pkgName && productName !== pkgName) {
    out.push({ level: 'info', message: `安装产品名「${productName}」与 npm 包名「${pkgName}」不同 —— 这是允许的：安装名面向用户，包名面向 npm registry。` })
  }
  // ③ 三条版本线各自独立：`dev` 前缀只说明那是"就地开发版"，不是与正式号冲突
  const anyDev = [appVersion, kernelVersion].some((v) => typeof v === 'string' && v.startsWith('dev'))
  const pkgPlain = typeof pkgVersion === 'string' && !pkgVersion.startsWith('dev')
  if (anyDev && pkgPlain) {
    out.push({
      level: 'info',
      message: `应用线「${appVersion ?? '—'}」/ 内核线「${kernelVersion ?? '—'}」（带 dev 前缀）与 GUI 发布线「${pkgVersion}」（正式号）是**三条独立版本线**（turbo 内核版 / 内核 / GUI 发布线），不是不一致 —— 四/三条线的口径见 version.mjs 头部注释与台账 versions.json#lines。`,
    })
  }
  // ④ 真 warn：取不到值
  for (const n of names) {
    if (n.value === null || n.value === '') {
      out.push({ level: 'warn', message: `名称声明点「${n.label}」(${n.id}) 取不到值：${n.file}${n.line ? ':' + n.line : ''} 里没有可解析的声明。` })
    }
  }
  if (!appId && !productName) {
    out.push({ level: 'warn', message: '安装身份缺失：electron-builder.yml 的 appId 与 productName 都取不到 —— 打包产物的安装身份无法核对（安装形态与在售产品不是同一个身份时，升级/共存行为会变）。' })
  }
  return out
}

// ── 组装 ─────────────────────────────────────────────────────────────────────

/**
 * 组装 GUI 数据包。**所有输入注入**（见文件头第 1 段）。
 *
 * @param {object} p
 * @param {string} p.root       仓库根（读台账/品牌文件的基准）
 * @param {object} p.checkJson  `node kit/cli.mjs check --json` 的 stdout 解析结果（**退出码 1 也有完整 JSON**）
 * @param {object} p.viewJson   `node kit/cli.mjs view --json` 的结果（提供 ledgers/scope）
 * @param {object} [p.gitInfo]  `collectGitInfo()` 的结果；不传则现场采集
 * @param {string} [p.now]      生成时间（ISO 串）；不传则用 checkJson.generatedAt 或当前时间
 */
export function buildGuiData({ root, checkJson = null, viewJson = null, gitInfo, now } = {}) {
  if (!root) throw new Error('buildGuiData: 缺少 root')
  const warnings = []
  const findings = (Array.isArray(checkJson?.findings) ? checkJson.findings : []).map(normFinding)
  if (!checkJson) warnings.push('未注入 checkJson ⇒ 门禁结论留空，deps.unused / deps.ghost 也只能为空（这两栏由 P1/P2 规则算出来，台账里没有）')

  const versionsRaw = readJsonRel(root, VERSIONS_FILE, warnings)
  const depsRaw = readJsonRel(root, DEPS_FILE, warnings)
  const baselineRaw = readJsonRel(root, BASELINE_FILE, warnings)

  const entries = Array.isArray(baselineRaw?.entries) ? baselineRaw.entries : []
  const baseline = {
    count: entries.length,
    // 基线里**显式标 severity:'red'** 的条目（= 被放行的红灯）；没标的按黄灯欠账处理（与 baseline.mjs 口径一致）
    redCount: entries.filter((e) => e.severity === 'red').length,
    entries: entries.map((e) => ({ rule: e.rule ?? null, subject: e.subject ?? null, severity: e.severity ?? null, at: e.at ?? null })),
    // 本次门禁**实际命中**的基线条数（= findings 里 severity 为 baselined 的条数）：与上面 count 不等是正常信号
    matched: findings.filter((f) => f.severity === 'baselined').length,
  }

  const gitInfoFull = normalizeGit(gitInfo === undefined ? collectGitInfo({ root }) : gitInfo)
  for (const w of gitInfoFull.warnings) warnings.push(w)
  // git 段本身**不带** warnings（git 的失败已合并进顶层 warnings 这本账；同一件事不记两处）
  const { warnings: _gitWarnings, ...git } = gitInfoFull

  const brand = collectBrand({ root, warnings })

  return {
    schemaVersion: 1,
    generatedAt: now || checkJson?.generatedAt || new Date().toISOString(),
    gate: buildGate(checkJson, findings),
    findings,
    ledgers: plain(viewJson?.ledgers) ?? null,
    scope: plain(viewJson?.scope ?? checkJson?.scope) ?? null,
    baseline,
    versions: compressVersions(versionsRaw, warnings),
    deps: buildDeps(depsRaw, findings),
    git,
    brand,
    // agent 套件规范的**同一份对象**（单一真源 kit/lib/agent-guide.mjs）：
    // 页面第 8 段与 `--agent` 的纯文本消费的是它，故两者不可能漂移
    agent: plain(AGENT_GUIDE),
    warnings,
  }
}
