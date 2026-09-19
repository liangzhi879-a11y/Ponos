// kit/lib/contract-rules.mjs —— 契约对账规则 CT0–CT9（DevKit P1 · T7）
//
// 形状照抄 `version-rules.mjs#runVersionRules` / `dep-rules.mjs#runDepRules`：`{checks, findings}`，
// 由 `finding(...)` / `checkResult(...)` / `RED|YELLOW` 构造（同一份报告 schema）。
//
// ★★ **红线：CT1 必须现场重算**（plan §7 反例⑤）。
//    本模块不把台账里的快照当"答案"：每次判定都先 `buildSnapshot()` 从代码复算一遍 live 快照，
//    再与台账里的快照 `diffSnapshot` —— 快照本身错了也必然被发现（"快照写错 ⇒ 拿它当答案 ⇒ 永远绿"
//    是这类门禁最典型的自证陷阱，先例：V7 的判据恒为已提交的 skills-lock.json）。
//    同理：CT2/CT3/CT5/CT6/CT7/CT9 的判据都来自**现场提取**（`doc` 也是现场解析的文本）。
//
// 覆盖面的两条腿（plan §1 方案 B）：
//   · 文档侧做**真双向**（CT2 代码→文档 / CT3 文档→代码；有文档的只有路由与 WS 类型）；
//   · 无文档侧（IPC、工具 schema）靠 CT5/CT6 + `contract-scope.json` 的**逐条精确登记**（CT4）兜住，
//     CT7 用"路径字面量 / 顶层 `type:` 字面量守恒"防止"提取不到就当作不存在"。
//
// 已知边界（如实写下，勿高估）：
//   ① 路由提取器只认**内联单引号**形态 ⇒ `const P='/x'`（间接量）与双引号比较两种写法抓不到；
//      CT7 的路由侧只覆盖提取器的 4 形态（见 `routeFormOrphans` 的注释：更宽的口径需要第二份黑名单，
//      会与提取器漂移 ⇒ 他人新增黑名单条目就假红）；
//   ② `shapeOf` 只含结构指纹（props 名+类型 / required / additionalProperties 存在性），
//      enum/items 不入 ⇒ "改 schema 结构 → CT6 红"只覆盖这一部分（plan 明确取舍）；
//   ③ CT9 是**单向差集**且只报不拦（黄）：前端调后端无是 D8 的历史欠账，登记在 drift-baseline。
import { RED, YELLOW, finding, checkResult } from './report.mjs'
import { trackedFiles, codeFiles, readTracked, stripComments } from './scan.mjs'
import { extractRoutes } from './contract-routes.mjs'
import { extractWs } from './contract-ws.mjs'
import { extractIpc } from './contract-ipc.mjs'
import { extractTools } from './contract-tools.mjs'
import { buildSnapshot, diffSnapshot, channelsProblems } from './contract-snapshot.mjs'
import { checkScopeSets, contractGrowth, keyOf } from './contract-scope.mjs'

/** 规则号段（顺序即报告顺序）：CT0–CT9，含 CT4 的两个子规则；刻意**没有 CT8**（号段按 plan §3 原样） */
export const CT_RULES = ['CT0', 'CT1', 'CT2', 'CT3', 'CT4', 'CT4B', 'CT4C', 'CT5', 'CT6', 'CT7', 'CT9']

/** 路径主体标识符（与 contract-routes.mjs 的 SUBJECT 同口径 —— 独立实现，不 import 它的私有常量） */
const NAIVE_FORMS = [
  { re: /\b(?:\w+\.)?(?:pathname|p|path)\s*(?:===|==|!==|!=)\s*'(\/[^']*)'/g, group: 1 },
  { re: /\b(?:\w+\.)?(?:pathname|p|path)\s*\.startsWith\(\s*'(\/[^']*)'/g, group: 1 },
]

/** 文档声明的集合（`*` 通配**单独放**：它只声明命名空间，**不给任何子路径覆盖信用** —— plan §7 反例⑧） */
export function docDeclaredSets(doc) {
  const paths = new Set()
  const wildcards = new Set()
  const wfKeys = new Set()
  const ws = new Set()
  for (const [p, v] of doc?.routes || []) {
    if (v && v.wildcard) wildcards.add(p)
    else paths.add(p)
  }
  for (const k of (doc?.workflowRoutes || new Map()).keys()) wfKeys.add(k)
  for (const t of doc?.wsOut || []) ws.add(t)
  for (const t of doc?.wsIn || []) ws.add(t)
  return { paths, wildcards, wfKeys, ws, sections: [...(doc?.sections || new Map()).keys()] }
}

/** `GET /x` → `/x` */
const pathOfKey = (k) => String(k).slice(String(k).indexOf(' ') + 1)

/**
 * 把快照/提取器里的 `dynamic.pattern` 变成可用的正则。
 * ★ 实测（本任务踩到并记下）：`contract-routes.mjs#anchoredPatternFor` 存的是**源码原文**
 *   ——含**前导** `/`、不含尾随 `/`。直接 new RegExp(pat) 会把前导 `/` 当成字面斜杠、
 *   而 `^` 落在位置 1 ⇒ **永不匹配**（静默假绿：文档与代码的 `/workflows/:id` 系全部「匹配不上」）。
 *   故消费方必须归一：剥掉那个前导 `/`。
 *   （不去改 T1 的产出：那是「源码原文」的如实记录，改动它会牵动快照与既有测试。）
 */
function dynRe(pat) {
  const s = String(pat)
  const src = s.charAt(0) === '/' ? s.slice(1) : s
  try { return new RegExp(src) } catch { return null }
}

/** `['/workflows/'] ← 该前缀的锚定正则命中该路径？`（坏正则按"不命中"处理，不抛） */
function dynMatches(prefixes, path) {
  for (const p of prefixes || []) {
    if (!p || !p.dynamic) continue
    const re = dynRe(p.dynamic.pattern)
    if (re && re.test(path)) return true
  }
  return false
}

/**
 * 真值 = **代码真值 ∖ 文档已声明**（plan §1 判据 b 的"登记集"定义）。
 * @returns {{truth:{routes:string[],wsOut:string[],wsIn:string[],ipc:string[]}, declared:object, nsClaims:string[]}}
 *   `truth.routes` 里除端点键外还有**命名空间声明**（`ns /前缀/`）：`children` 为空的前缀
 *   （`/providers/`、`/knowledge/import/jobs/`）与"动态拼装"的前缀在快照里外观相同
 *   （`childCount===0`），只有靠这种显式声明才能区分"空命名空间"与"不存在"（T1 的 I5 / plan §2 T10）。
 *   命名空间声明**是否已被文档覆盖**的判据：文档里有具体路径落在该前缀下，或 §7.1 的路径能被该前缀的
 *   锚定正则匹配（`/workflows/`）。**文档的 `*` 通配一律不给信用**（反例⑧）。
 */
export function buildTruth({ routes, prefixes = [], ws, ipc, doc }) {
  const d = docDeclaredSets(doc)
  const truthRoutes = []
  for (const k of routes?.routes ? routes.routes.keys() : (routes || new Map()).keys()) {
    const p = pathOfKey(k)
    if (d.paths.has(p) || d.wfKeys.has(k)) continue
    truthRoutes.push(k)
  }
  const nsClaims = []
  for (const pref of prefixes || []) {
    const prefix = pref.prefix
    const underDoc = [...d.paths].some((x) => x !== prefix && x.indexOf(prefix) === 0)
    // 动态前缀（如 `/workflows/`）由 §7.1 的具体端点覆盖：用**锚定正则**判，不得因为
    // "routes 里没有该静态键"就当成未覆盖（plan：CT2/CT3 必须用 prefixes.dynamic，否则漏报）
    const dynHit = pref.dynamic && [...d.wfKeys].some((k) => {
      const re = dynRe(pref.dynamic.pattern)
      return re ? re.test(pathOfKey(k)) : false
    })
    if (underDoc || dynHit) continue
    nsClaims.push(`ns ${prefix}`)
  }
  const coveredWs = d.ws
  return {
    truth: {
      routes: [...truthRoutes, ...nsClaims].sort(),
      wsOut: [...(ws?.out || [])].filter((t) => !coveredWs.has(t)).sort(),
      wsIn: [...(ws?.in || [])].filter((t) => !coveredWs.has(t)).sort(),
      // IPC：文档**零章节** ⇒ 全部推送通道都要登记（invoke/handle/send/on 走 CT5 的配对判据，
      // 那是"两方协议集合相等"，不需要文档面 —— 这两条的分工写在 plan §3 的 CT5 行）
      ipc: [...(ipc?.push || [])].sort(),
    },
    declared: d,
    nsClaims,
  }
}

/** 路由侧独立重数：4 形态的**字面量站点**（file|literal），返回 {sites, orphans}（orphans = 无归宿者） */
export function routeFormScan({ files, readTracked: read, routes }) {
  // ★ 自筛（与提取器同域口径）：raw `trackedFiles` 直传会把 **test 文件**里的路径字面量算进来
  //   （实测：`server/workflow-api.test.mjs` 的 `/workflows/verify`），而提取器按设计不看测试文件
  //   ⇒ 那不是"没归宿"，是"不在同一域"。接口自己免疫，不靠调用顺序。
  const code = codeFiles(files, { includeTests: false })
  const homes = new Set()
  for (const [k, v] of routes.routes || new Map()) for (const h of v.hints || []) homes.add(`${h.file}|${pathOfKey(k)}`)
  for (const p of routes.prefixes || []) for (const h of p.hints || []) homes.add(`${h.file}|${p.prefix}`)
  for (const e of routes.excluded || []) homes.add(`${e.file}|${e.literal}`)
  const orphans = new Set()
  let sites = 0
  for (const file of code) {
    if (file.indexOf('server/') !== 0) continue
    const text = read(file)
    if (typeof text !== 'string') continue
    const code = stripComments(text)
    const seen = []
    for (const form of NAIVE_FORMS) {
      const re = new RegExp(form.re.source, 'g')
      let m
      while ((m = re.exec(code))) seen.push(m[form.group])
    }
    for (const m of code.matchAll(/new Set\(\[([^\]]*)\]\)/g)) {
      for (const x of m[1].matchAll(/'(\/[^']*)'/g)) seen.push(x[1])
    }
    for (const lit of seen) {
      sites++
      if (!homes.has(`${file}|${lit}`)) orphans.add(lit)
    }
  }
  return { sites, orphans: [...orphans].sort() }
}

/** 只要无归宿者的便捷包装（测试与 finding 用） */
export function routeFormOrphans({ files, readTracked: read, routes }) {
  return routeFormScan({ files, readTracked: read, routes }).orphans
}

/**
 * 前端 fetch 路径（渲染层 `src/` 下的 `.ts` / `.tsx`）：`fetch('/x')` 与模板基址拼装（`` `${base}/x` ``）
 * —— 后者把 `${…}` 挖掉再取路径；以 `/` 结尾的路径是**组合基址**（`/api/` + `${kind}`），由 `frontendDiff` 按前缀处理。
 */
export function frontendFetchPaths({ files, readTracked: read }) {
  const out = new Map()
  const argOf = (code, open) => {
    let depth = 0
    for (let i = open; i < code.length; i++) {
      const c = code[i]
      if (c === '(') depth++
      else if (c === ')') { depth--; if (!depth) return code.slice(open + 1, i) }
      else if (c === ',' && depth === 1) return code.slice(open + 1, i)
    }
    return ''
  }
  for (const file of files) {
    if (file.indexOf('src/') !== 0 || !/\.(ts|tsx)$/.test(file)) continue
    const text = read(file)
    if (typeof text !== 'string') continue
    const code = stripComments(text)
    for (const m of code.matchAll(/\bfetch\s*\(/g)) {
      const arg = argOf(code, m.index + m[0].length - 1).split(/\$\{[^}]*\}/).join('')
      const q = arg.match(/['"`]([^'"`]*)/)
      if (!q) continue
      const p = q[1].match(/\/[A-Za-z0-9_\-/.]+/)
      if (!p) continue
      const key = p[0]
      if (!out.has(key)) out.set(key, [])
      out.get(key).push(file)
    }
  }
  return out
}

/**
 * 前端 fetch 与 server 路由的**单向差集**。命中口径（三种，都不算差集）：
 *   ① 精确路径命中某个静态端点键；
 *   ② 命中某条**锚定正则**（`prefixes[].dynamic`，如 `/workflows/:id` 系）；
 *   ③ 落在桥**已分派的命名空间**下（`prefixes[].prefix`，如 `/providers/` —— 桥用 `startsWith` 分派，
 *      具体子路径由运行时拼装）。★ ②③ 是"后端有没有人接"的判据；**不**在这里判"子路径是否被登记"
 *      ——那是 T1 的 `prefixes.children` 与 scope 登记（CT4）的职责，重复判定只会制造两套真相。
 */
export function frontendDiff({ fetched, routes, prefixes = [] }) {
  const livePaths = new Set([...(routes || new Map()).keys()].map(pathOfKey))
  const nsPrefixes = (prefixes || []).map((p) => p.prefix).filter(Boolean)
  const diff = []
  for (const p of fetched.keys()) {
    if (livePaths.has(p)) continue
    let hit = dynMatches(prefixes, p)
    if (!hit) hit = nsPrefixes.some((x) => p === x || p.indexOf(x) === 0)
    if (!hit && p.endsWith('/')) {
      for (const live of livePaths) if (live.indexOf(p) === 0) { hit = true; break }
    }
    if (!hit) diff.push(p)
  }
  return diff.sort()
}

/** IPC 两侧（主进程 / preload）—— 配对判据必须**按侧**比，`on` 是两侧并集（T3 的 I1） */
const isRendererSide = (f) => f.indexOf('preload') !== -1

/**
 * 跑全部契约规则。
 * @param {{root:string, files?:string[], doc?:object, snapshot?:object, scope?:object,
 *          recorded?:{scopeCount:number|null,scopeRedCount:number|null},
 *          readTracked?:Function, live?:object, parts?:object}} p
 *   `snapshot` 来自台账（`readSnapshot`）；`live` 若不给则**现场重算**（默认路径就是重算，见红线注释）。
 */
export async function runContractRules({
  root, files = null, doc = null, snapshot = null, scope = null, recorded = null,
  readTracked: rt = null, live = null, parts = null,
} = {}) {
  const tracked = files || trackedFiles({ root })
  const read = rt || ((f) => readTracked({ root, file: f }))
  const code = codeFiles(tracked, { includeTests: false })
  const checks = []
  const findings = []

  const routes = parts?.routes || extractRoutes({ files: tracked, readTracked: read })
  const ws = parts?.ws || extractWs({ files: code, readTracked: read })
  const ipcAll = parts?.ipc || extractIpc({ files: code, readTracked: read })
  const tools = parts?.tools || await extractTools({ root })
  const liveSnap = live || await buildSnapshot({ root, files: tracked, readTracked: read, parts: { routes, ws, ipc: ipcAll, tools } })

  // ── CT0：快照存在且形状完整 ──────────────────────────────────────────
  const shapeProblems = channelsProblems(snapshot)
  for (const p of shapeProblems) {
    findings.push(finding({ rule: 'CT0', severity: RED, subject: 'versions.json#channels', message: p,
      hint: '契约快照由 `npm run kit:sync` 落盘；缺它则 CT1–CT7 全部无从判定（不是"没事"）' }))
  }
  checks.push(checkResult({ rule: 'CT0', title: '契约快照存在且形状完整（versions.json#channels）', evaluated: 1, passed: shapeProblems.length === 0 }))

  // ── CT1：**现场重算**后逐类逐元素相等（红线：绝不读快照当答案）────────────────
  //     hint 里给"当前代码里的判定位置"（file:line 只进 hint，不进快照 —— plan §6 D2）
  const hintOf = (key) => {
    const p = pathOfKey(key)
    const hit = routes.routes.get(key)
    if (hit) return `${hit.file}:${hit.line}`
    const pref = routes.prefixes.find((x) => x.prefix === p)
    if (pref && pref.hints.length) return `${pref.hints[0].file}:${pref.hints[0].line}`
    return ''
  }
  const diff = diffSnapshot(snapshot, liveSnap)
  for (const d of diff.diffs) {
    const loc = d.kind === 'routes' ? hintOf(d.key) : ''
    findings.push(finding({
      rule: 'CT1', severity: RED, subject: `${d.kind} ${d.key}`, expected: d.from, actual: d.to, file: loc ? loc.split(':')[0] : undefined,
      line: loc ? Number(loc.split(':')[1]) : undefined,
      hint: '快照必须能从代码现场重算出来：跑 npm run kit:sync 更新快照；若代码才是错的，就修代码（不要把快照手改成与代码不一致的样子）',
    }))
  }
  const snapSize = Object.keys(liveSnap.routes).length + liveSnap.wsOut.length + liveSnap.wsIn.length
    + Object.values(liveSnap.ipc).reduce((n, a) => n + a.length, 0) + Object.keys(liveSnap.tools).length + liveSnap.excluded.length
  checks.push(checkResult({ rule: 'CT1', title: '快照可从代码现场重算（逐类逐元素相等）', evaluated: snapSize, passed: diff.equal }))

  // ── CT2/CT3：代码 ↔ 文档（有文档的两类：路由与 WS 类型）────────────────────
  const truthData = buildTruth({ routes, prefixes: routes.prefixes, ws, ipc: ipcAll, doc })
  const scopeOut = checkScopeSets({ scope, truth: truthData.truth, docSections: doc ? truthData.declared.sections : null })
  const coverage = scopeOut.coverage

  let ct2bad = 0
  for (const kind of ['routes', 'wsOut', 'wsIn']) {
    for (const name of truthData.truth[kind]) {
      if (coverage.has(keyOf(kind, name))) continue
      ct2bad++
      findings.push(finding({
        rule: 'CT2', severity: RED, subject: `${kind} ${name}`, expected: '在 docs/bridge-contract.md §5/§6/§7 声明，或在 contract-scope.json 登记',
        actual: '两处都没有',
        hint: '代码里有、文档与登记里都没有 = 未覆盖的契约面：补文档（P1.5）或在 kit/manifest/contract-scope.json 逐条登记（人工、带 reason）',
      }))
    }
  }
  checks.push(checkResult({ rule: 'CT2', title: '代码 → 文档：每条路由/WS 类型在 §5/§6/§7 出现，或在 scope 登记',
    evaluated: Object.keys(truthData.truth).reduce((n, k) => n + truthData.truth[k].length, 0), passed: ct2bad === 0 }))

  // CT3：文档声明的每一条都必须真的在代码里（文档腐烂；`*` 通配与动态段不报红）
  const livePaths = new Set([...routes.routes.keys()].map(pathOfKey))
  const pathExists = (p) => livePaths.has(p) || dynMatches(routes.prefixes, p)
  const liveWs = new Set([...ws.out, ...ws.in])
  let ct3bad = 0
  const docRouteChecks = [...truthData.declared.paths, ...[...truthData.declared.wfKeys].map(pathOfKey)]
  for (const p of docRouteChecks) {
    if (pathExists(p)) continue
    ct3bad++
    findings.push(finding({
      rule: 'CT3', severity: RED, subject: `routes ${p}`, expected: '代码里有该端点（或其动态前缀能匹配）', actual: '代码里没有',
      hint: '文档说了代码没有 = 文档腐烂（先确认是不是端点被删/改名）；文档里 `*` 通配不算覆盖声明 —— 反例⑧',
    }))
  }
  for (const t of truthData.declared.ws) {
    if (liveWs.has(t)) continue
    ct3bad++
    findings.push(finding({
      rule: 'CT3', severity: RED, subject: `ws ${t}`, expected: '代码里有该事件类型', actual: '代码里没有',
      hint: '文档的 §5/§6 表里写着、代码里零命中 ⇒ 要么补代码，要么删/改文档行',
    }))
  }
  checks.push(checkResult({ rule: 'CT3', title: '文档 → 代码：文档声明的每条都在代码里（文档腐烂）',
    evaluated: docRouteChecks.length + truthData.declared.ws.size, passed: ct3bad === 0 }))

  // ── CT4 / CT4B / CT4C：范围登记 ──────────────────────────────────────
  for (const f of scopeOut.findings) findings.push(f)
  checks.push(checkResult({ rule: 'CT4', title: 'scope members 与「代码真值 ∖ 文档已声明」集合相等（多一少一都红）',
    evaluated: Object.values(truthData.truth).reduce((n, a) => n + a.length, 0),
    passed: scopeOut.findings.filter((x) => x.rule === 'CT4').length === 0 }))
  checks.push(checkResult({ rule: 'CT4C', title: 'scope 条目合法（reason 必填 / 禁通配与正则字符 / 无重复 / docSection 真实存在）',
    evaluated: scopeOut.groupCount, passed: scopeOut.findings.filter((x) => x.rule === 'CT4C').length === 0 }))

  const growth = contractGrowth({ scope, recordedCount: recorded?.scopeCount ?? null, recordedRedCount: recorded?.scopeRedCount ?? null })
  if (growth) {
    const overCount = growth.exceeded !== null && growth.exceeded !== undefined
    findings.push(finding({
      rule: 'CT4B', severity: RED,
      subject: overCount ? 'channels.scopeCount' : 'channels.scopeRedCount',
      expected: String(overCount ? growth.recordedCount : growth.recordedRedCount),
      actual: String(overCount ? growth.exceeded : growth.redExceeded),
      hint: '范围登记的封顶值超了：登记是"范围边界的可见表达"，不是"遇红就登记"的垃圾桶。'
        + (overCount ? '确认新增的组是真边界后，人工改 versions.json#channels.scopeCount。' : '确认新增的键是真边界后，人工改 versions.json#channels.scopeRedCount。'),
    }))
  }
  checks.push(checkResult({ rule: 'CT4B', title: 'scope 条数不得超 channels.scopeCount / scopeRedCount（双护栏）',
    evaluated: scopeOut.groupCount + scopeOut.keyCount, passed: growth === null }))

  // ── CT5：IPC 三方配对（按侧比）+ push 的文档/scope 覆盖 ───────────────
  //    `parts.ipc` 是**全域**并集（T3 的 I1：`on` 是两侧并集）；配对必须按侧拆，故这里按文件再跑两份
  //    （很便宜：`extractIpc` 只扫 `electron/**` 的文本，无 I/O 放大）。
  const rendererFiles = code.filter((f) => isRendererSide(f))
  const mainFiles = code.filter((f) => !isRendererSide(f))
  const ipcR = extractIpc({ files: rendererFiles, readTracked: read })
  const ipcM = extractIpc({ files: mainFiles, readTracked: read })
  void ipcAll
  let ct5bad = 0
  const pair = (labelA, setA, labelB, setB) => {
    for (const x of setA) if (!setB.has(x)) {
      ct5bad++
      findings.push(finding({ rule: 'CT5', severity: RED, subject: `${labelA} ${x}`, expected: `${labelB} 侧有同名通道`, actual: `${labelB} 侧没有`,
        hint: 'IPC 是两方协议：注册与调用必须**双向集合相等**（删掉一边 = 通道永远不会被响应/永远不会有人调）' }))
    }
    for (const x of setB) if (!setA.has(x)) {
      ct5bad++
      findings.push(finding({ rule: 'CT5', severity: RED, subject: `${labelB} ${x}`, expected: `${labelA} 侧有同名通道`, actual: `${labelA} 侧没有`,
        hint: 'IPC 是两方协议：注册与调用必须**双向集合相等**（多注册一个没人调的通道同样是契约面扩大）' }))
    }
  }
  pair('invoke', ipcR.invoke, 'handle', ipcM.handle)
  pair('send', ipcR.send, 'on(main)', ipcM.on)
  pair('push', ipcM.push, 'on(renderer)', ipcR.on)
  for (const ch of ipcM.push) {
    if (coverage.has(keyOf('ipc', ch))) continue
    ct5bad++
    findings.push(finding({ rule: 'CT5', severity: RED, subject: `push ${ch}`, expected: '在文档声明 或在 scope 登记', actual: '两处都没有',
      hint: 'bridge-contract.md 没有 IPC 章节 ⇒ 推送通道只能进 contract-scope.json（kind 写 ipc，逐条精确键 + reason）' }))
  }
  checks.push(checkResult({ rule: 'CT5', title: 'IPC 三方配对（invoke↔handle / send↔on / push↔on）双向相等，push 在文档或 scope',
    evaluated: ipcR.invoke.size + ipcR.send.size + ipcM.handle.size + ipcM.on.size + ipcR.on.size + ipcM.push.size, passed: ct5bad === 0 }))

  // ── CT6：工具出口 ⊆ 快照 / 静态计数 / 动态源登记 / 结构指纹 ─────────────
  let ct6bad = 0
  const snapTools = snapshot && typeof snapshot.tools === 'object' && snapshot.tools ? snapshot.tools : {}
  const snapSources = snapshot && typeof snapshot.toolSources === 'object' && snapshot.toolSources ? snapshot.toolSources : {}
  // ★ 变异实测补的洞：`kernel/tools.mjs` 语法坏掉时，运行时出口不可用 ⇒ `names` 退化成"静态键"、
  //   `shapeOf()` 全 null。旧写法只在 `liveHash !== null` 时比对 ⇒ **静默全绿**（M12 变异实测 CT6 红 0）。
  //   判据：**快照里有指纹**（说明这个仓本来能导出）而运行时**不可用** ⇒ 红。夹具仓（快照 tools 为空、
  //   没有 kernel/tools.mjs）不受影响 —— 那里"没有工具"是事实，不是故障。
  const staticSource = tools.sources.find((s) => s.id === 'static')
  if (Object.keys(snapTools).length > 0 && staticSource && staticSource.error) {
    ct6bad++
    findings.push(finding({ rule: 'CT6', severity: RED, subject: 'tools runtime',
      expected: 'toolSchemas() 可调用（运行时出口是模型真正看到的那份）', actual: `导入/调用失败：${staticSource.error}`,
      hint: '`kernel/tools.mjs` 不可加载（语法错/缺依赖）⇒ 工具出口比对全部失效。修好再跑 kit:sync；'
        + '**不要**因为"比不出差异"就当通过（这正是本次变异实测抓到的静默绿）' }))
  }
  for (const name of tools.names) {
    if (!Object.hasOwn(snapTools, name)) {
      ct6bad++
      findings.push(finding({ rule: 'CT6', severity: RED, subject: `tools ${name}`, expected: '在快照 tools 里', actual: '快照里没有',
        hint: 'toolSchemas() 是模型真正看到的那份出口：出口有而快照没有 ⇒ 跑 npm run kit:sync 落盘（或说明为什么动态工具不该进快照）' }))
      continue
    }
    const liveHash = tools.shapeOf(name)
    if (liveHash !== null && snapTools[name] !== liveHash) {
      ct6bad++
      findings.push(finding({ rule: 'CT6', severity: RED, subject: `tools ${name}`, expected: String(snapTools[name]), actual: String(liveHash),
        hint: '工具 input_schema 的**结构指纹**变了（props 名+类型 / required / additionalProperties）：这是模型契约的变更 ⇒ 跑 kit:sync 并说明变更（description 散文不入指纹）' }))
    }
  }
  if (snapshot && snapshot.staticToolCount !== tools.staticCount) {
    ct6bad++
    findings.push(finding({ rule: 'CT6', severity: RED, subject: 'tools staticCount', expected: String(snapshot.staticToolCount), actual: String(tools.staticCount),
      hint: '静态 registry 键数与快照不一致：加/删工具后必须跑 npm run kit:sync（`kernel/tools.mjs` 的 registry 是静态真源）' }))
  }
  for (const s of tools.sources) {
    const got = snapSources[s.id]
    if (!got || got.present !== s.present || got.file !== s.file) {
      ct6bad++
      findings.push(finding({ rule: 'CT6', severity: RED, subject: `toolSource ${s.id}`, expected: `present=${s.present} file=${s.file}`, actual: got ? `present=${got.present} file=${got.file}` : '未登记',
        hint: '动态/派生工具来源必须逐条登记（抽取器 TOOL_SOURCES）；文件不在时也要**如实登记 present:false**，不许把条目删掉（"提取不到 ≠ 不存在"）' }))
    }
  }
  checks.push(checkResult({ rule: 'CT6', title: 'toolSchemas() 出口 ⊆ 快照 + 静态计数一致 + 动态源逐条登记',
    evaluated: tools.names.length + tools.sources.length, passed: ct6bad === 0 }))

  // ── CT7：提取守恒（"提取不到 ≠ 不存在"的可证伪形式）───────────────────
  let ct7bad = 0
  const wsSum = ws.outOccurrences + ws.excluded.length
  if (ws.rawTypeCount !== wsSum) {
    ct7bad++
    findings.push(finding({ rule: 'CT7', severity: RED, subject: 'ws 守恒',
      expected: `rawTypeCount ${ws.rawTypeCount} == 出站命中 ${ws.outOccurrences} + 排除 ${ws.excluded.length}`, actual: `差 ${ws.rawTypeCount - wsSum}`,
      hint: '域内每条 `type:`/`subtype:` 字面量都必须有归宿：要么归因到 sink 白名单，要么进 excluded（带 reason）。'
        + '差额通常意味着**新增了一类 sink 形态没登记**，或归因漏了一类消息形状' }))
  }
  for (const u of ws.unattributed) {
    ct7bad++
    findings.push(finding({ rule: 'CT7', severity: RED, subject: `ws 无归宿 ${u.literal}`, file: u.file, line: u.line,
      expected: '有归宿（归因到 sink 或进 excluded）', actual: '一条规则都没认领',
      hint: '在 contract-ws.mjs 的 sink 白名单/REASON 里补一条**有据**分类；禁止兜底成"其余全部"' }))
  }
  const formScan = routeFormScan({ files: tracked, readTracked: read, routes })
  for (const lit of formScan.orphans) {
    ct7bad++
    findings.push(finding({ rule: 'CT7', severity: RED, subject: `routes 无归宿 ${lit}`, expected: '在 routes/prefixes/excluded 里有归宿', actual: '独立重扫（4 形态）找不到归宿',
      hint: '提取器的形态覆盖被削弱了（或新增了一种路径判定形态没登记）：路径字面量必须要么成为端点/前缀，要么进 excluded 带 reason' }))
  }
  checks.push(checkResult({ rule: 'CT7', title: '提取守恒：`type:` 字面量 = 已归因 + 显式排除；路径字面量必有归宿（独立重扫）',
    evaluated: ws.rawTypeCount + formScan.sites, passed: ct7bad === 0 }))

  // ── CT9：前端 fetch ↔ server 路由单向差集（黄、只报不拦；D8）────────────
  const fetched = frontendFetchPaths({ files: tracked, readTracked: read })
  const srcDiff = frontendDiff({ fetched, routes: routes.routes, prefixes: routes.prefixes })
  for (const p of srcDiff) {
    findings.push(finding({
      rule: 'CT9', severity: YELLOW, subject: p, expected: 'server 侧有对应路由（或动态前缀能匹配）', actual: 'server 侧没有',
      hint: '渲染层调了后端不存在的端点（D8 类型的历史欠账）。**只报不拦**：确认是"后端已实现但路径变了"还是"前端调错"，'
        + '处理不了的先登记进 kit/manifest/drift-baseline.json（带 reason），不要靠忽略报告过关',
    }))
  }
  checks.push(checkResult({ rule: 'CT9', title: '渲染层 fetch 路径 ↔ server 路由单向差集（只报不拦；差集为空才 ✔）',
    evaluated: fetched.size, passed: srcDiff.length === 0 }))

  return { checks, findings }
}
