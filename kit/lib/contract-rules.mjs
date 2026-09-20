// kit/lib/contract-rules.mjs —— 契约对账规则 CT0–CT10（DevKit P1 · T7；CT10 = 品牌声明点）
//
// 形状照抄 `version-rules.mjs#runVersionRules` / `dep-rules.mjs#runDepRules`：`{checks, findings}`，
// 由 `finding(...)` / `checkResult(...)` / `RED|YELLOW` 构造（同一份报告 schema）。
//
// ★★ **两条红线**：
//    ① `CT1` 必须现场重算（plan §7 反例⑤）—— 本模块不把台账里的快照当"答案"：每次判定都先
//       `buildSnapshot()` 从代码复算一遍 live 快照，再与台账里的快照 `diffSnapshot`；
//    ② **真值来源 = 提交态（HEAD）**（第 3 批，第 2 批审查的结论）—— 代码侧与文档侧都取自
//       `head*`（物化的 HEAD 检出，见 `kit/lib/head-tree.mjs`），**不是**工作树。
//       为什么必须如此：台账是**提交物**、CI 在干净检出上跑；若规则读工作树，他人在途改动
//       就会与台账产生差异，只能靠 `drift-baseline.json` 加**红灯基线**吸收 —— 而基线按
//       `rule+subject` 认领，实测两个真漏洞：`ANY /app-info` 这类真实端点键的 CT1 差异在
//       **任意方向**被永久降级；计数型 subject（`routes 多登记 1 条`）能认领**任意同类**单条。
//       ⇒ 现在：**规则与工作树脏不脏无关**（CT0–CT7/CT9 全绿），在途改动只由 `CT8` 报**黄灯**。
//
// 覆盖面的两条腿（plan §1 方案 B）：
//   · 文档侧做**真双向**（CT2 代码→文档 / CT3 文档→代码）—— P1.5 起覆盖**五类**：
//     路由（§7）、WS 出/入（§5/§6）、IPC 推送（§11）、工具出口 + 结构指纹（§12）；
//   · 无文档侧（空命名空间、CT5 的配对关系）靠 CT5/CT6 + `contract-scope.json` 的**逐条精确登记**（CT4）兜住，
//     CT7 用"路径字面量 / 顶层 `type:` 字面量守恒"防止"提取不到就当作不存在"。
//   ⇒ 判据的读法：**文档声明得越全，登记集越小**（登记 = 代码真值 ∖ 文档已声明）。P1.5 把这两类
//     补进文档后，登记只剩"没法写进文档的空洞"（空命名空间）。
//
// 已知边界（如实写下，勿高估）：
//   ① 路由提取器只认**内联字符串字面量**（单/双引号，第 4 批起；原先只认单引号 ⇒ `pathname === "/x"`
//      静默漏抓）⇒ `const P='/x'`（间接量）与反引号模板串（动态）抓不到；
//      CT7 的路由侧只覆盖提取器的 4 形态（见 `routeFormOrphans` 的注释：更宽的口径需要第二份黑名单，
//      会与提取器漂移 ⇒ 他人新增黑名单条目就假红）；
//   ② `shapeOf` 的指纹（批 F 起**递归**）覆盖 type / enum（排序后比较）/ items（数组元素）/
//      **嵌套** properties / required（排序）/ additionalProperties 存在性 / pattern / format，深度上限 8；
//      **仍不覆盖**：散文与展示（description/title/examples）、数值范围（minimum/maxLength…）、default、
//      元信息（deprecated/readOnly/writeOnly）、组合子（$ref/oneOf/anyOf/allOf，真仓零使用）
//      ⇒ "改 schema 结构 → CT6 红"只覆盖**纳入名单内**的那部分（plan 明确取舍；
//      名单由 `contract-tools.test.mjs`「批 F④」关键字守卫钉住，真仓出现未纳入的结构类关键字即失败）；
//   ③ CT9 是**单向差集**且只报不拦（黄）：前端调后端无是 D8 的历史欠账，登记在 drift-baseline；
//   ④ `CT8` 只在"有提交态可比"时才有意义 ⇒ HEAD 不可读时**明说**（不假装能对账，见 ctx.headError）；
//   ⑤ **WS 方向按 §5/§6 各判**（P1.5 收尾批，2026-09-19 起）：此前两节合成一个声明集，
//      "把出站事件抄进 §6"不会红。详见 `docDeclaredSets` 的注释（含为什么此前必须合成、
//      以及"在 §5 补 `browser:event`"这一步解锁了什么）。
//   ⑥ **CT10 只查品牌真源登记的 8 条声明点**（`kit/manifest/brand.json`），**不扫全仓**：
//      全仓另有 `Ponos-Turbo` 散在 kernel/、kernel-tests/ 与 docs 的叙述文本里（规模见 brand.json 的 knownWidespread，含复算命令）
//      （真源 `knownWidespread` 如实登记），那是独立工作项 —— 若扫全仓，CT10 会永远红。
//      CT10 与其它 CT 同口径读**提交态**：品牌声明点的在途改动由 `node scripts/brand.mjs check`
//      （读工作树）即时反馈，不进本门禁的红灯。
import { RED, YELLOW, finding, checkResult } from './report.mjs'
import { trackedFiles, codeFiles, readTracked, stripComments } from './scan.mjs'
import { extractRoutes } from './contract-routes.mjs'
import { extractWs } from './contract-ws.mjs'
import { extractIpc } from './contract-ipc.mjs'
import { extractTools } from './contract-tools.mjs'
import { buildSnapshot, diffSnapshot, channelsProblems } from './contract-snapshot.mjs'
import { checkScopeSets, contractGrowth, keyOf } from './contract-scope.mjs'
import { brandCheck } from './brand-rules.mjs'
import { agentEntryCheck } from './agent-entry-rules.mjs'
import { devkitBoundaryCheck } from './devkit-rules.mjs'

/** 规则号段（顺序即报告顺序）：CT0–CT12，含 CT4 的两个子规则、在途差异 CT8、品牌声明点 CT10、
 *  agent 入口 CT11、DevKit 边界 CT12 */
export const CT_RULES = ['CT0', 'CT1', 'CT2', 'CT3', 'CT4', 'CT4B', 'CT4C', 'CT5', 'CT6', 'CT7', 'CT8', 'CT9', 'CT10', 'CT11', 'CT12']

/** 路径主体标识符（与 contract-routes.mjs 的 SUBJECT 同口径 —— 独立实现，不 import 它的私有常量）
 *  ★ 引号必须与提取器**同口径**（第 4 批）：单/双都认。少认一种 ⇒ 同一处字面量在提取器里"有归宿"、
 *    在独立重扫里"无归宿"（或反之），守恒等式就成了噪声源；反引号两边都不认（模板串 = 动态）。 */
const NAIVE_FORMS = [
  { re: /\b(?:\w+\.)?(?:pathname|p|path)\s*(?:===|==|!==|!=)\s*(['"])(\/[^'"]*)\1/g, group: 2 },
  { re: /\b(?:\w+\.)?(?:pathname|p|path)\s*\.startsWith\(\s*(['"])(\/[^'"]*)\1/g, group: 2 },
]

/**
 * 文档声明的集合（`*` 通配**单独放**：它只声明命名空间，**不给任何子路径覆盖信用** —— plan §7 反例⑧）。
 *
 * P1.5 起共七类：路由路径 / 通配 / §7.1 方法+路径 / **§5 WS 出站（`wsOut`）** / **§6 WS 入站（`wsIn`）**
 * / IPC 通道（§11）/ 工具名（§12）。后两类把"只能整类登记"的契约面拉回文档 ⇒ 契约对账回到"文档 ↔ 代码"直接双向。
 * `toolFps` 是**指纹映射**（不参与声明集大小与 CT8 的声明差异 —— 那由 `tools` 名字集负责），
 * 专供 CT3 做"逐字比对"。
 *
 * ★ **WS 两个方向分开存**（P1.5 收尾批，2026-09-19）：此前是 `ws` = §5 ∪ §6 一个集合，
 *   于是**方向错误静默通过** —— 把 §5 的出站事件抄进 §6（inbound 节），CT2/CT3 都只看并集 ⇒ 红 0
 *   （唯一信号是 `contract-doc.test.mjs` 的 26/16 计数）。方向是契约的一部分：GUI 实现者照节写代码，
 *   把 outbound 写成 inbound 会让 `onmessage` 分支与 `send` 调用完全反过来。故按节各判。
 *   为什么之前必须合成（实测）：代码侧有**既 out 又 in 的同名事件**（`ws.out ∩ ws.in` =
 *   `pet:show-main`、`pet:quit-app`、`browser:event`），其中 `browser:event` 当时**只在 §6 声明**
 *   ⇒ 按方向判会把它算成"`wsOut` 未声明"（真仓实测唯一红点）。收尾批的处理：**在 §5 补该行**
 *   （它是真出站：`server/browser-routing.mjs` 的 `c.send(JSON.stringify({type:'browser:event'…}))`
 *   广播给 GUI，README 的下行事件清单里也有它）⇒ 两个方向都各有对应声明，判据不再需要并集。
 */
export function docDeclaredSets(doc) {
  const paths = new Set()
  const wildcards = new Set()
  const wfKeys = new Set()
  const wsOut = new Set()
  const wsIn = new Set()
  const ipc = new Set()
  const tools = new Set()
  const toolFps = new Map()
  // ★ 批 M：文档**写了方法**的声明（`'<METHOD> <path>'` → 行号）—— CT3 的"方法 + 路径"维度。
  //   §7 的行内方法（`（POST）` / `POST /x` / `GET/POST`）聚合在 `routes.get(p).methods`；
  //   §7.1 的键**本身**就是 `METHOD path`（那节的方法不需要再解析）。
  //   §7.1 的 `synonyms`（`（POST 同义）`）**不入**这里：它是"也接受"的注释，不是"必须存在"的声明。
  const routeMethods = new Map()
  for (const [p, v] of doc?.routes || []) {
    if (v && v.wildcard) wildcards.add(p)
    else paths.add(p)
    if (!v || v.wildcard) continue
    for (const m of v.methods || []) {
      if (!routeMethods.has(`${m} ${p}`)) routeMethods.set(`${m} ${p}`, (v.methodLines && v.methodLines.get(m)) || v.line || 0)
    }
  }
  for (const [k, v] of doc?.workflowRoutes || new Map()) {
    wfKeys.add(k)
    if (!routeMethods.has(k)) routeMethods.set(k, (v && v.line) || 0)
  }
  for (const t of doc?.wsOut || []) wsOut.add(t)
  for (const t of doc?.wsIn || []) wsIn.add(t)
  for (const c of doc?.ipc || []) ipc.add(c)
  for (const [name, v] of doc?.tools || new Map()) {
    tools.add(name)
    toolFps.set(name, v && v.fp ? v.fp : null)
  }
  return { paths, wildcards, wfKeys, routeMethods, wsOut, wsIn, ipc, tools, toolFps, sections: [...(doc?.sections || new Map()).keys()] }
}

/** `GET /x` → `/x` */
const pathOfKey = (k) => String(k).slice(String(k).indexOf(' ') + 1)

/** 文档**声明集**的七类（CT8 的文档面差异按这七类逐条报）
 *  ★ `toolFps` 刻意**不在此列**：它是 `tools` 名字集的附加信息（指纹），入列会让声明集大小重复计数。
 *  ★ WS 按**方向**分两类：合并成一类时"把 §5 的行挪进 §6"在 CT8 眼里看不出差异（并集不变）。 */
const DECLARED_FIELDS = [
  ['paths', 'doc.routes'], ['wildcards', 'doc.wildcards'], ['wfKeys', 'doc.workflow'],
  ['wsOut', 'doc.wsOut'], ['wsIn', 'doc.wsIn'], ['ipc', 'doc.ipc'], ['tools', 'doc.tools'],
]

/** 声明集大小（CT8 的 `evaluated` 用：判定到底比了多少条声明） */
function declaredSize(d) {
  return DECLARED_FIELDS.reduce((n, [f]) => n + (d?.[f]?.size || 0), 0)
}

/** 每类真值在文档里的归宿（CT2 的 expected 文案用：一眼看出该补哪一节） */
const DOC_SECTIONS_OF = { routes: '§7', wsOut: '§5', wsIn: '§6', ipc: '§11', tools: '§12' }

/**
 * 两份**文档声明集**的差异（CT8 的文档面）。
 * 为什么文档面也要比：文档改动是"在途"的最常见形态之一 —— 规则读 HEAD 文档 ⇒ 文档的在途改动
 * **不会**让 CT2/CT3 变红（那正是本批要的），但它也**不该**无声无息：由 CT8 逐条报出来。
 */
function declaredDiff(head, work) {
  const out = []
  for (const [field, kind] of DECLARED_FIELDS) {
    const a = head?.[field] instanceof Set ? head[field] : new Set()
    const b = work?.[field] instanceof Set ? work[field] : new Set()
    for (const x of [...a].sort()) if (!b.has(x)) out.push({ subject: `${kind} ${x}`, expected: '有', actual: '缺' })
    for (const x of [...b].sort()) if (!a.has(x)) out.push({ subject: `${kind} ${x}`, expected: '缺', actual: '有' })
  }
  return out
}

/** 契约面元素总数（CT8 的 `evaluated`：逐项比对了多少个契约面元素） */
function surfaceSize(s) {
  return Object.keys(s?.routes || {}).length + Object.keys(s?.routePrefixes || {}).length
    + (s?.wsOut || []).length + (s?.wsIn || []).length
    + Object.values(s?.ipc || {}).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0)
    + Object.keys(s?.tools || {}).length
}

/**
 * CT8 的噪声过滤：`toolSources.*.error` 的**文本**里含**绝对路径**（提交态物化树 vs 工作树必然不同），
 * 直接比会造出"伪在途差异"（夹具仓里实测：没有 `kernel/tools.mjs` 时两边的 `Cannot find module` 文本不同）。
 * 判据：两边的 `(file, role, present)` 相同、且**"有没有 error"也相同** ⇒ 只有文本差异 ⇒ 不是契约面变化。
 * 反例守住：一边有 error、一边没有（工具出口从可用变不可用）**仍要报** —— 那才是真的在途变化。
 */
function isErrorTextOnlyDiff(d, a, b) {
  if (d.kind !== 'toolSources') return false
  const x = a?.toolSources?.[d.key]
  const y = b?.toolSources?.[d.key]
  if (!x || !y) return false
  const proj = (o) => JSON.stringify({ file: o.file, role: o.role, present: o.present, hasError: Boolean(o.error) })
  return proj(x) === proj(y)
}

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
 * 五类各做一次减法：routes（`ns` 前缀声明见下）/ wsOut / wsIn / ipc（§11）/ tools（§12）。
 * @returns {{truth:{routes:string[],wsOut:string[],wsIn:string[],ipc:string[],tools:string[]}, declared:object, nsClaims:string[]}}
 *   `truth.routes` 里除端点键外还有**命名空间声明**（`ns /前缀/`）：`children` 为空的前缀
 *   （`/providers/`、`/knowledge/import/jobs/`）与"动态拼装"的前缀在快照里外观相同
 *   （`childCount===0`），只有靠这种显式声明才能区分"空命名空间"与"不存在"（T1 的 I5 / plan §2 T10）。
 *   命名空间声明**是否已被文档覆盖**的判据：文档里有具体路径落在该前缀下，或 §7.1 的路径能被该前缀的
 *   锚定正则匹配（`/workflows/`）。**文档的 `*` 通配一律不给信用**（反例⑧）。
 *   ★ P1.5 的关键性质：**文档声明得越全，真值越小** —— 五类补进文档后，"登记集"只剩真正无法
 *     文档化的空洞（空命名空间），这正是把"登记"升级为"真对账"的机制。
 */
export function buildTruth({ routes, prefixes = [], ws, ipc, tools, doc }) {
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
  // ★ WS：**按方向各减各的声明集**（§5 管出站、§6 管入站）。合成一个集合会让"方向写反"
  //   静默通过（见 `docDeclaredSets` 的说明）。两个方向都声明同一类型是**允许**的
  //   （代码里确实双向的事件：`pet:show-main`/`pet:quit-app`/`browser:event`）。
  return {
    truth: {
      routes: [...truthRoutes, ...nsClaims].sort(),
      wsOut: [...(ws?.out || [])].filter((t) => !d.wsOut.has(t)).sort(),
      wsIn: [...(ws?.in || [])].filter((t) => !d.wsIn.has(t)).sort(),
      // IPC 推送通道：§11 补齐前文档零章节 ⇒ 7 条全部要登记；补齐后按声明集做减法
      // （invoke↔handle、send↔on 走 CT5 的配对判据：那是"两方协议集合相等"，不需要文档面）
      ipc: [...(ipc?.push || [])].filter((c) => !d.ipc.has(c)).sort(),
      // 工具出口（toolSchemas 的静态+运行时并集名）：§12 补齐前**完全不在真值里**（P1 的已知盲区），
      // P1.5 起进真值 ⇒ 新工具漏了文档或登记，CT2/CT4 立刻报出来
      tools: [...(tools?.names || [])].filter((n) => !d.tools.has(n)).sort(),
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
      for (const x of m[1].matchAll(/(['"])(\/[^'"]*)\1/g)) seen.push(x[2])
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
 *
 * **两棵树的分工（本模块最重要的一条约定）**：
 *   · `head*`（`headRoot`/`headFiles`/`headReadTracked`/`headDoc`/`headParts`）= **提交态 HEAD** ⇒
 *     CT0–CT7/CT9 的**唯一真值来源**（缺省回落到 `root`/`files`/… 的同名参数：夹具仓里
 *     "夹具目录"同时代表两侧，CT8 恒空；造在途差异请显式传两棵树，见 `contract-rules.test.mjs`）；
 *   · `root`/`files`/`readTracked`/`doc` = **工作树** ⇒ 只服务 `CT8`（在途差异）。
 * @param {{root:string, headRoot?:string, headFiles?:string[], headReadTracked?:Function, headDoc?:object,
 *          headParts?:object, headError?:string|null, files?:string[], doc?:object, docWorktree?:object,
 *          snapshot?:object, scope?:object, recorded?:{scopeCount:number|null,scopeRedCount:number|null},
 *          readTracked?:Function, live?:object, parts?:object, workParts?:object, worktreeIdentical?:boolean|null}} p
 *   `snapshot` 来自台账（`readSnapshot`）；`live` 若不给则**现场重算**（默认路径就是重算，见红线注释）。
 *   `headError`：物化提交态失败时的原因（`head-tree.mjs` 的 `available:false`）—— 由调用方传入，
 *   本模块把它报成 **CT1 红**（"提交物对账不可进行"不是"没事"）。
 *   `worktreeIdentical`：调用方**验证过**"工作树 == HEAD"（`head-tree.mjs#worktreeClean`）时传 `true`，
 *   跳过 CT8 的第二遍全量提取（等价性捷径，见 CT8 段落注释）。缺省 = 逐项比对。
 */
export async function runContractRules({
  root, files = null, doc = null, snapshot = null, scope = null, recorded = null,
  readTracked: rt = null, live = null, parts = null,
  headRoot = null, headFiles = null, headReadTracked = null, headDoc = null, headParts = null,
  headError = null, docWorktree = null, workFiles = null, workReadTracked = null, workParts = null,
  worktreeIdentical = null,
} = {}) {
  // ── 提交态（真值）与工作树（CT8）各自的文件集与读取器 ──────────────────
  const filesWork = workFiles || files || trackedFiles({ root })
  const readWork = workReadTracked || rt || ((f) => readTracked({ root, file: f }))
  const filesHead = headFiles || files || filesWork
  const rootHead = headRoot || root
  const readHead = headReadTracked || (rootHead === root && !headFiles
    ? readWork
    : ((f) => readTracked({ root: rootHead, file: f })))
  const docHead = headDoc === null ? doc : headDoc
  const docWork = docWorktree === null ? doc : docWorktree

  const tracked = filesHead
  const read = readHead
  const code = codeFiles(tracked, { includeTests: false })
  const checks = []
  const findings = []

  const routes = headParts?.routes || extractRoutes({ files: tracked, readTracked: read })
  const ws = headParts?.ws || extractWs({ files: code, readTracked: read })
  const ipcAll = headParts?.ipc || extractIpc({ files: code, readTracked: read })
  const tools = headParts?.tools || await extractTools({ root: rootHead })
  const liveSnap = live || await buildSnapshot({ root: rootHead, files: tracked, readTracked: read, parts: { routes, ws, ipc: ipcAll, tools } })

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
      hint: '快照必须能从**提交态**代码现场重算出来：提交改动后跑 npm run kit:sync 更新快照；若代码才是错的，就修代码（不要把快照手改成与代码不一致的样子）',
    }))
  }
  // ★ 提交态读不到 ⇒ 现场重算无从谈起：显式报红（不静默拿工作树顶替 —— 那会把"在途噪声"
  //   伪装成"提交物对账通过"）。正常仓里这条永不触发；空仓（无提交）或 git 不可用时才出现。
  if (headError) {
    findings.push(finding({
      rule: 'CT1', severity: RED, subject: 'HEAD 物化',
      expected: '能取到提交态（HEAD）以便把台账与提交物对账', actual: String(headError),
      hint: '当前真值**退化为工作树**（等价性未验证）：先 `git commit`（仓里必须有提交）再跑 `npm run kit:check`；'
        + '不要因为"读不到提交态"就当通过',
    }))
  }
  const snapSize = Object.keys(liveSnap.routes).length + liveSnap.wsOut.length + liveSnap.wsIn.length
    + Object.values(liveSnap.ipc).reduce((n, a) => n + a.length, 0) + Object.keys(liveSnap.tools).length + liveSnap.excluded.length
  checks.push(checkResult({ rule: 'CT1', title: '快照可从**提交态**代码现场重算（逐类逐元素相等）',
    evaluated: snapSize, passed: diff.equal && !headError }))

  // ── CT2/CT3：代码 ↔ 文档（P1.5 起覆盖五类：路由 / WS 出 / WS 入 / IPC 推送 / 工具出口）──
  const truthData = buildTruth({ routes, prefixes: routes.prefixes, ws, ipc: ipcAll, tools, doc: docHead })
  const scopeOut = checkScopeSets({ scope, truth: truthData.truth, docSections: docHead ? truthData.declared.sections : null })
  const coverage = scopeOut.coverage
  // 快照里的工具出口（CT3 的指纹兜底 + CT6 的比对基准）：**提到 CT3 之前** —— `const` 在同一函数
  // 作用域里有 TDZ，若只在 CT6 段声明，CT3 引用时会直接抛 ReferenceError（不是"取不到值"）。
  const snapTools = snapshot && typeof snapshot.tools === 'object' && snapshot.tools ? snapshot.tools : {}
  const snapSources = snapshot && typeof snapshot.toolSources === 'object' && snapshot.toolSources ? snapshot.toolSources : {}

  let ct2bad = 0
  for (const kind of ['routes', 'wsOut', 'wsIn', 'ipc', 'tools']) {
    for (const name of truthData.truth[kind]) {
      if (coverage.has(keyOf(kind, name))) continue
      ct2bad++
      findings.push(finding({
        rule: 'CT2', severity: RED, subject: `${kind} ${name}`, expected: `${DOC_SECTIONS_OF[kind]} 声明，或在 contract-scope.json 登记`,
        actual: '两处都没有',
        hint: '代码里有、文档与登记里都没有 = 未覆盖的契约面：补文档（§7 路由 / §5§6 WS / §11 IPC / §12 工具）或在 kit/manifest/contract-scope.json 逐条登记（人工、带 reason）',
      }))
    }
  }
  checks.push(checkResult({ rule: 'CT2', title: '代码 → 文档：每条路由/WS 类型/IPC 推送/工具出口在 §5/§6/§7/§11/§12 出现，或在 scope 登记',
    evaluated: Object.keys(truthData.truth).reduce((n, k) => n + truthData.truth[k].length, 0), passed: ct2bad === 0 }))

  // CT3：文档声明的每一条都必须真的在代码里（文档腐烂；`*` 通配与动态段不报红）
  const livePaths = new Set([...routes.routes.keys()].map(pathOfKey))
  const pathExists = (p) => livePaths.has(p) || dynMatches(routes.prefixes, p)
  // ★ 批 M（方法维度）：代码侧"路径 → 方法集合"（键形如 `GET /x` / `ANY /x`）。只为 CT3 的方法判据服务。
  const codeMethodsByPath = new Map()
  for (const k of routes.routes.keys()) {
    const p = pathOfKey(k)
    if (!codeMethodsByPath.has(p)) codeMethodsByPath.set(p, new Set())
    codeMethodsByPath.get(p).add(String(k).slice(0, String(k).indexOf(' ')))
  }
  // ★ WS 按方向逐节判（P1.5 收尾批）：§5 的每条声明必须在**出站**集里、§6 的必须在**入站**集里。
  //   同一类型在两节都声明是允许的（真仓 `pet:show-main`/`pet:quit-app`/`browser:event` 代码里确实双向）；
  //   该红的只有一种情形：**只声明在一节、而代码对应方向没有它**（方向写反 / 事件被删改名）。
  const liveWsOut = new Set(ws.out)
  const liveWsIn = new Set(ws.in)
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
  // ★★ 批 M：**方法维度**（把 CT3 从"路径对账"升级为"方法 + 路径对账"）—— 相容规则**原文**：
  //   ① 代码键 = `'<METHOD> <path>'`（`METHOD ∈ {ANY, GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS}`，
  //      代码提取器对"不可静态判定方法"的端点发 `ANY` 键）；
  //   ② 代码为 `ANY` ⇒ 与**任意**方法相容（真仓有 `ANY /agents`、`ANY /api/audit` 这类键）；
  //   ③ **文档未写方法**（只写路径）⇒ **不判方法**（只判路径存在，保持这批之前的语义 ——
  //      一行没写方法就按方法判会炸出海量假红，而"没声明"与"声明错"不是一回事）；
  //   ④ 文档写了方法 ⇒ **逐个判**：每个被声明的方法都要有相容的代码键（`GET /x、POST /x` 需要代码里
  //      两种都有，或 `ANY`）。★ 这条比"（文档方法 ∩ 代码方法）= ∅ 才红"**更严**：后者在
  //      "文档 GET+POST、代码只有 GET"时会绿掉（两个集合相交），而那正是"文档声明了代码没有的方法"。
  //      两个方向都不相交（`PUT` vs 代码 `GET/POST`）自然也被它覆盖。
  //   ⑤ 路径**只被动态前缀认领**（`/workflows/:id` 这类靠锚定正则匹配）⇒ 方法不可静态判定 ⇒
  //      只判路径、**不判方法**（避免拿"不可静态判定"当"错"）。
  //   §7 与 §7.1 的声明同等对待（§7.1 的键本身就是 `METHOD path`）；`（POST 同义）` 只记 synonyms，
  //   不当作"必须存在"的方法（它是"也接受"的注释）。判据**只**加在 CT3 —— CT2/CT4 仍是**路径粒度**
  //   （覆盖面/登记集的口径不变：否则"文档未写方法"会在真值侧炸出海量假红）。
  for (const [key, line] of truthData.declared.routeMethods) {
    const m = key.slice(0, key.indexOf(' '))
    const p = pathOfKey(key)
    const codeM = codeMethodsByPath.get(p)
    if (!codeM) continue            // 路径不存在（已由上面的路径判据报出）或只靠动态前缀认领 ⇒ 不判方法
    if (codeM.has('ANY') || codeM.has(m)) continue
    ct3bad++
    findings.push(finding({
      rule: 'CT3', severity: RED, subject: `routes ${key}`,
      expected: `代码里有 ${key}（或 ANY ${p}）`,
      actual: `文档声明 ${m}，代码该路径下只有 ${[...codeM].sort().join('/')}`,
      file: 'docs/bridge-contract.md', line,
      hint: '文档声明了代码没有的方法 = 文档腐烂（方法写反/端点改成别的方法/被删）：'
        + '先确认代码才是对的，再改文档那一行；代码侧写成 `ANY` 的键与任意方法相容',
    }))
  }
  for (const [section, declared, live, side] of [
    ['§5', truthData.declared.wsOut, liveWsOut, '出站（ws.out）'],
    ['§6', truthData.declared.wsIn, liveWsIn, '入站（ws.in）'],
  ]) {
    for (const t of declared) {
      if (live.has(t)) continue
      ct3bad++
      findings.push(finding({
        rule: 'CT3', severity: RED, subject: `ws ${t}`,
        expected: `代码的${side}集里有该事件类型`, actual: `代码的${side}集里没有`,
        hint: `${section} 声明的事件类型必须在代码**对应方向**存在：把出站事件写进入站节（或反之）= 方向错，`
          + `GUI 实现者会照节写反 onmessage/send；事件被删或改名也一样命中这里`,
      }))
    }
  }
  // ★ P1.5：文档 §11 声明的 IPC 推送通道必须真的在代码的 **push 侧**（`webContents.send` 及其
  //   别名可选链形态）。判据只对 push：invoke↔handle、send↔on 是"两侧集合相等"，由 CT5 管。
  for (const ch of truthData.declared.ipc) {
    if (ipcAll.push.has(ch)) continue
    ct3bad++
    findings.push(finding({
      rule: 'CT3', severity: RED, subject: `ipc ${ch}`, expected: '代码里有该推送通道（webContents.send / `wc?.send?.(…)`）', actual: '代码里没有',
      hint: '文档 §11 写了代码没有 = 文档腐烂（通道被删/改名）；推送侧只认 `webContents.send(...)` 与别名可选链两种形态（见 contract-ipc.mjs 的 PUSH_PATTERNS）',
    }))
  }
  // ★ P1.5：文档 §12 声明的工具必须在代码出口里，且**结构指纹逐字相等**。
  //   指纹比对是这条规则的核：文档里只写"名字 + 指纹"（明细的唯一真相在 kernel/tools.mjs），
  //   结构一变指纹就变 ⇒ 必须同步文档，否则红。缺指纹 / 取不到出口指纹一律**报红**（fail-closed）。
  for (const name of truthData.declared.tools) {
    if (!tools.names.includes(name)) {
      ct3bad++
      findings.push(finding({
        rule: 'CT3', severity: RED, subject: `tools ${name}`, expected: '在 toolSchemas() 出口（或静态 registry）里', actual: '代码里没有该工具',
        hint: '文档 §12 列了代码没有的工具 = 文档腐烂（工具被删/改名）',
      }))
      continue
    }
    const docFp = truthData.declared.toolFps.get(name) || null
    // ★ 指纹取自**哪里**（分工说明，2026-09-19 收尾批查明后写死在这里）：
    //   ① `tools.shapeOf(name)` = **运行时出口**（`await import('kernel/tools.mjs')` → `toolSchemas()`，
    //      见 `contract-tools.mjs` 的 I1）；② `snapTools[name]` = **已提交快照**（`versions.json#channels.tools`）。
    //   优先 ①，`||` 兜底的触发条件只有一个：**该工具名在出口清单里、但运行时给不出指纹**
    //   （`shapeOf()` 返回 null）—— 实测两类：`kernel/tools.mjs` 不可加载（语法错/缺依赖 ⇒ 运行时 `byName`
    //   为空，`names` 退化成静态 registry 键）；静态 registry 有该键而 `toolSchemas()` 不导出它。
    //   ⇒ 此时 CT3 对的是**快照**（"文档 ↔ 提交物"），不是运行时。
    //   **分工**：CT3 = 文档 ↔ 快照对账；**快照 ↔ 运行时**由 CT6 负责（`tools runtime` 显式红 +
    //   逐工具指纹比对 + `staticToolCount`），快照 ↔ 代码由 CT1 负责。三者串起来 = 传递覆盖，
    //   所以"改坏 `kernel/tools.mjs` 而 CT3 仍绿"是**设计**不是漏判（实测：CT1 红 22 + CT6 红 1，
    //   而 CT3 `evaluated=183` 仍绿）。这里**不做** fail-closed 收紧：收紧等于让 CT3 承担运行时的职责，
    //   会让"快照已落盘、运行时临时不可用"的仓在文档侧误报（且与 CT1/CT6 重复报同一件事）。
    //   唯一保持 fail-closed 的方向：**两边都取不到指纹** ⇒ 红（下面的 `liveFp === null` 分支）。
    const liveFp = tools.shapeOf(name) || snapTools[name] || null
    if (!docFp) {
      ct3bad++
      findings.push(finding({
        rule: 'CT3', severity: RED, subject: `tools ${name}`, expected: '结构指纹（8 位十六进制）', actual: '文档里没给指纹',
        hint: '§12 的指纹必须**用反引号包住**才被解析（表内散文里的裸串不算）：跑 `npm run kit:sync` 或 fingerprintOf 取值后补上',
      }))
      continue
    }
    if (liveFp === null) {
      ct3bad++
      findings.push(finding({
        rule: 'CT3', severity: RED, subject: `tools ${name}`, expected: String(docFp), actual: '取不到出口指纹（工具不在运行时出口，且台账里也没有）',
        hint: '文档声明了工具却无法从代码/台账取到指纹 ⇒ 无法证明结构一致（不许当通过）：跑 `npm run kit:sync` 落盘后再对账',
      }))
      continue
    }
    if (liveFp !== docFp) {
      ct3bad++
      findings.push(finding({
        rule: 'CT3', severity: RED, subject: `tools ${name}`, expected: String(docFp), actual: String(liveFp),
        hint: '工具 input_schema 的**结构指纹**与文档 §12 不一致（递归：type/enum/items/嵌套 properties/'
          + 'required/additionalProperties/pattern/format，深度上限 8）：'
          + '这是模型契约变更 ⇒ 跑 `npm run kit:sync` 并同步 §12 的指纹（description 散文不入指纹）',
      }))
    }
  }
  checks.push(checkResult({ rule: 'CT3', title: '文档 → 代码：文档声明的每条（路由/**方法+路径**/WS/**按方向**/IPC/工具指纹）都在代码里',
    evaluated: docRouteChecks.length + truthData.declared.routeMethods.size
      + truthData.declared.wsOut.size + truthData.declared.wsIn.size
      + truthData.declared.ipc.size + truthData.declared.tools.size,
    passed: ct3bad === 0 }))

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
    // ★ P1.5：覆盖判据 = **scope 登记** 或 **文档 §11 声明**（否则 §11 补完仍红）。
    //   与 CT2/CT4 的分工：那两条判"代码真值 ∖ 文档已声明"是否都被登记；这条判"推送通道
    //   有没有契约面上的归宿"（文档面或登记面二选一）。三者都红 = 该通道确实两处都没有。
    if (coverage.has(keyOf('ipc', ch)) || truthData.declared.ipc.has(ch)) continue
    ct5bad++
    findings.push(finding({ rule: 'CT5', severity: RED, subject: `push ${ch}`, expected: '在文档 §11 声明 或在 scope 登记', actual: '两处都没有',
      hint: 'IPC 推送侧没有对应的调用点，只能靠文档 §11（推荐，P1.5 起该章已存在）或 kit/manifest/contract-scope.json 逐条登记（人工、带 reason）' }))
  }
  checks.push(checkResult({ rule: 'CT5', title: 'IPC 三方配对（invoke↔handle / send↔on / push↔on）双向相等，push 在文档 §11 或 scope',
    evaluated: ipcR.invoke.size + ipcR.send.size + ipcM.handle.size + ipcM.on.size + ipcR.on.size + ipcM.push.size, passed: ct5bad === 0 }))

  // ── CT6：工具出口 ⊆ 快照 / 静态计数 / 动态源登记 / 结构指纹 ─────────────
  //    （快照工具出口 `snapTools`/`snapSources` 已在 CT2 段之前取出：见那里的 TDZ 说明）
  let ct6bad = 0
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
        hint: '工具 input_schema 的**结构指纹**变了（递归：type/enum/items/嵌套 properties/'
          + 'required/additionalProperties/pattern/format，深度上限 8）：这是模型契约的变更 ⇒ '
          + '跑 kit:sync 并说明变更（description 散文不入指纹）' }))
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

  // ── CT8：在途差异（工作树 ∖ HEAD）—— 黄、只报不拦，**不需要任何基线** ──────────
  //   判据 = `diffSnapshot(提交态快照, 工作树快照)` 的逐条差异 + 文档**声明集**的差异。
  //   为什么单列一条规则、而不是靠基线：基线按 `rule+subject` 认领（见文件头红线的两个实测漏洞），
  //   与"契约面"语义不同 —— 在途改动是这个仓每天都有的正常状态，它既不是欠账也不该被永久压制：
  //   提交之后 CT8 自己就空了（"提交后漏登记 → CT1/CT2/CT4 红"由别的规则接住）。
  const declaredHead = docDeclaredSets(docHead)
  const declaredWork = docDeclaredSets(docWork)
  // ★ 等价性捷径：调用方已用 git 验证"工作树与 HEAD 完全一致"（`head-tree.mjs#worktreeClean`）⇒
  //   工作树侧快照与提交态快照**必然相同**，不必再跑第二遍全量提取（实测 ≈0.8 s，而 CI/干净克隆
  //   走的正是这条路）。本模块**不自己判断**"干不干净"（那是 git 的事）：只有调用方明确传 `true`
  //   才跳过；缺省/`false`/`null` 一律照常逐项比对（保守方向 = 宁可多跑一遍，不少报在途差异）。
  const workSnap = worktreeIdentical === true
    ? liveSnap
    : await buildSnapshot({ root, files: filesWork, readTracked: readWork, parts: workParts || null })
  const inflight = diffSnapshot(liveSnap, workSnap).diffs.filter((d) => !isErrorTextOnlyDiff(d, liveSnap, workSnap))
  const docInflight = declaredDiff(declaredHead, declaredWork)
  const inflightHint = '这些改动**尚未提交**：提交后跑 `npm run kit:sync`（台账按**提交态**落盘）'
    + '并在 kit/manifest/contract-scope.json 更新范围登记；在途期间本规则只报黄灯，红灯判定不受影响'
  for (const d of inflight) {
    findings.push(finding({
      rule: 'CT8', severity: YELLOW, subject: `${d.kind} ${d.key}`,
      expected: `HEAD ${d.from}`, actual: `工作树 ${d.to}`,
      hint: inflightHint,
    }))
  }
  for (const d of docInflight) {
    findings.push(finding({
      rule: 'CT8', severity: YELLOW, subject: d.subject, expected: `HEAD ${d.expected}`, actual: `工作树 ${d.actual}`,
      hint: `${inflightHint}（本条是**文档声明集**的在途差异：文档改了但规则读的是 HEAD 文档）`,
    }))
  }
  checks.push(checkResult({
    rule: 'CT8',
    title: '在途差异（工作树 ∖ HEAD：路由/前缀/WS 类型/IPC/工具/排除项 + 文档声明集）—— 黄、只报不拦',
    evaluated: surfaceSize(liveSnap) + declaredSize(declaredHead) + declaredSize(declaredWork),
    passed: inflight.length === 0 && docInflight.length === 0,
  }))

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

  // ── CT10：品牌声明点 ↔ 品牌真源（`kit/manifest/brand.json`；不可基线豁免）──────────
  //   ★ 读**提交态**（`read` / `tracked` 都来自 head*），与 CT0–CT10 同口径：品牌声明点的**在途**改动
  //     不会在这里变红（要看工作树里的当下状态，用 `node scripts/brand.mjs check` —— 它读工作树，
  //     给的是"现在改完没有"的即时反馈）。
  //   ★ 基线：`BASELINE_FORBIDDEN` 的判据是"除 CT9 外全部 CT" ⇒ CT10 自动**不可豁免**（刻意如此：
  //     品牌门禁不许靠加一条基线蒙过去）。
  const brand = brandCheck({ readTracked: read, files: tracked })
  for (const f of brand.findings) findings.push(f)
  checks.push(brand.check)

  // ── CT11：agent 自动注入入口 ↔ 真源（仓根 `AGENTS.md`；不可基线豁免）────────────────
  //   ★ 存在的理由：入口是"规范不必靠 agent 自觉去找"的那一层（工具开工自动读仓根同名文件；
  //     Ponos 内核也自动发现 —— `kernel/prompt.mjs#discoverAgentsMd` 从 cwd 上溯到 `.git` 所在目录）。
  //     它此前**只在会话提示词里被口头描述、真源零登记** ⇒ 改了真源忘改入口不红。
  //   ★ 读**提交态**，与 CT0–CT10 同口径（口径一致才谈得上"一整套规则"）。
  //   ★ 基线：`BASELINE_FORBIDDEN` 判据是"除 CT9 外全部 CT" ⇒ CT11 自动**不可豁免**（刻意如此）。
  const entry = agentEntryCheck({ readTracked: read })
  for (const f of entry.findings) findings.push(f)
  checks.push(entry.check)

  // ── CT12：DevKit 边界 —— 发行物不得含开发门禁（`kit/` 及相关配置；不可基线豁免）──────────
  //   ★ 存在的理由：用户口径『确保正式打包不会带 devkit，也就是发行给用户的版本不带 kit 及相关配置』。
  //     实测漏洞：`scripts/pack-source-zip.mjs`（源码交付包，注释声明"给客户/外部"）的排除规则里
  //     **既没有 `kit/` 也没有 `AGENTS.md`**，而候选清单来自 `git ls-files` ⇒ **59 个 devkit 文件**
  //     （`kit/` 58 + `AGENTS.md` 1）本会随包发出去。
  //   ★ 与 CT11 的分工（易混）：CT11 管"要**有**什么"（入口送达），CT12 管"要**没有**什么"（devkit 外泄）；
  //     两者在调试渠道上刚好相反 —— `AGENTS.md` 在调试版**必须有**、在发行物**必须无**。
  //   ★ 读**提交态**，与 CT0–CT11 同口径。
  //   ★ 基线：`BASELINE_FORBIDDEN` 是"除 CT9 外全部 CT" ⇒ CT12 自动**不可豁免**（刻意如此）。
  const devkit = devkitBoundaryCheck({ readTracked: read })
  for (const f of devkit.findings) findings.push(f)
  checks.push(devkit.check)

  return { checks, findings }
}
