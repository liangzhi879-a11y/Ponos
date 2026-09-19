// kit/lib/contract-routes.mjs —— HTTP 路由提取器（DevKit P1 · T1）
//
// 设计不变量（每条都由 kit/lib/contract-routes.test.mjs 的断言钉住）：
//   I1 **禁止按文件找 Set 表**（D1）：`FILES_ROUTE_PATHS` 定义在 `server/bridge.mjs:271`，
//      而它的处理器在 `server/files-routes.mjs` ⇒ 必须扫**全部源码文本**做形态识别，
//      而不是"打开 bridge.mjs 找那张表"。
//   I2 扫描域 = 调用方传入的 `files`（来自 `scan.mjs#trackedFiles` = `git ls-files`）+
//      `readTracked`（只读已入库文件）。**禁止 readdirSync**：磁盘上的
//      `release/YFWorking/server/*-routes.mjs`、`release/_backup_*/` 都是副本，不是真相（D4）。
//   I3 注释不是代码：匹配前先过 `scan.mjs#stripComments`（真形态：`bridge.mjs:1757/1829`
//      的注释里写着 `pathname === '…'`）。
//   I4 "提取不到 ≠ 不存在"：每个被形态识别到、但**不是** bridge 端点的字面量都进 `excluded`，
//      **逐条带 reason**（分类前缀可机读），且**不留"其余全部"这类兜底条目**。
//   I5 动态前缀单列成 `prefixes`：`/transcript/`、`/file-collab/`、`/providers/`、`/workflows/`、
//      `/knowledge`、`/logs/` 这类 `startsWith` 是**命名空间**，children 可能为空 ——
//      "通配到底有没有被枚举"必须一眼可判（`providers/` 空 = 段是动态拼的）。
//
// 四形态（`routes` 的 `forms` 字段逐条记录来源）：
//   `eq`         `pathname === '/x'`（含 `p === '/x'`、`url.pathname`；真仓最多的一类）
//   `set`        `const X = new Set(['/x', …])`（`set:<变量名>`）
//   `isPath`     `isXxxPath(pathname)` 返回式谓词（`isPath:<函数名>`）—— 是**认领关系**，不是新端点
//   `startsWith` `pathname.startsWith('/x')` —— 前缀，落 `prefixes` 而不是 `routes`
import { stripComments } from './scan.mjs'

/** 方法字面量（守卫表达式里出现的才算；不出现则方法不可静态判定）。
 *  ★ 不能写尾随 `\b`：`'GET'` 的右侧是引号/空格/行尾（全是非单词字符），`\b` 恒不成立 ——
 *  实测那会让 `method === 'GET'` 一个都读不到（本文件最初就踩了这一脚）。 */
const METHOD_RE = /'(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)'/g

/** 路径主体标识符：只认这些名字，避免把 `target === '/x'` 这类文件系统判定当路由 */
const SUBJECT = '(?:\\w+\\.)?(?:pathname|p|path)'
const EQ_RE = new RegExp(`\\b(${SUBJECT})\\s*(!?={2,3})\\s*'([^']*)'`, 'g')
const STARTS_RE = new RegExp(`\\b(${SUBJECT})\\.startsWith\\(\\s*'([^']*)'`, 'g')
const SET_RE = /(?:(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)?new Set\(\[([^\]]*)\]\)/g
const ISPATH_RE = /(?:export\s+)?(?:function\s+(is[A-Za-z]*Path)\s*\(|(?:const|let)\s+(is[A-Za-z]*Path)\s*=\s*(?:async\s*)?\()/g

/** 系统目录前缀（命中即"文件系统目录"，不是 HTTP 路径）。
 *  ★ 必须按**路径段边界**比对：`'/boot-status'.startsWith('/boot')` 为真 ——
 *  用裸前缀比对会把端点 `/boot-status` 误判成系统目录（实测踩到）。 */
const SYSTEM_DIRS = ['/etc', '/bin', '/sbin', '/usr', '/dev', '/boot', '/System', '/Library/LaunchDaemons', '/Library/LaunchAgents']

/** 令牌守卫文件：它的路径字面量是**豁免判定**，不是端点处理器 */
const TOKEN_GUARD = 'server/bridge-token.cjs'
const VENDORED = 'public/sample-skills/'
/** bridge 端点只可能在 `server/**`（HTTP 服务就在 server/bridge.mjs） */
const ROUTE_PREFIX = 'server/'

/** 逐行偏移表 → O(log n) 定位行号（避免对每个命中点重扫全文） */
function lineMap(code) {
  const starts = [0]
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}
function lineAt(starts, idx) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= idx) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * 命中所属的**守卫窗口**：单行守卫取本行；括号未闭合的续行条件（真形态 `bridge.mjs:2803-2804`）
 * 向后并进，最多 4 行。窗口只用于读方法字面量 —— 取宽了会把下一行的 `'POST'` 算到本行头上
 * （夹具里 `const wantGet = … && method === 'GET'` 与 `const wantPut = …` 相邻，正是这个坑）。
 */
function guardWindow(code, idx) {
  const start = code.lastIndexOf('\n', idx) + 1
  let end = code.indexOf('\n', idx)
  if (end === -1) end = code.length
  for (let n = 0; n < 4; n++) {
    const win = code.slice(start, end)
    if (win.includes('{')) return win
    const open = (win.match(/\(/g) || []).length
    const close = (win.match(/\)/g) || []).length
    if (open <= close && !/(?:&&|\|\||\()\s*$/.test(win.trim())) return win
    const next = code.indexOf('\n', end + 1)
    end = next === -1 ? code.length : next
  }
  return code.slice(start, end)
}

/** 守卫窗口里的方法集合；空 = 不可静态判定（聚合时按 ANY 处理） */
function methodsIn(win) {
  const out = new Set()
  METHOD_RE.lastIndex = 0
  let m
  while ((m = METHOD_RE.exec(win))) out.add(m[1])
  if (out.size === 0) {
    if (/!\s*isPost\b/.test(win)) out.add('GET')      // `!isPost` = 非 POST 侧（knowledge-routes 的 GET 写法）
    else if (/\bisPost\b/.test(win)) out.add('POST')
  }
  return [...out]
}

/** 取函数体（从首个 `{` 到配对的 `}`）—— isPath 谓词的返回式只在这些字节里 */
function bodyOf(code, from) {
  const open = code.indexOf('{', from)
  if (open === -1) return ''
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (depth === 0) return code.slice(open, i + 1)
    }
  }
  return code.slice(open)
}

/** 该文件里是否存在锚定在本前缀上的正则字面量（如 `p.match(/^\/workflows\/([^/]+)(\/.*)?$/)`） */
function anchoredPatternFor(code, prefix, starts) {
  const escaped = prefix.replace(/\//g, '\\/')
  let idx = code.indexOf(escaped)
  while (idx !== -1) {
    const lineStart = code.lastIndexOf('\n', idx) + 1
    const nl = code.indexOf('\n', idx)
    const line = code.slice(lineStart, nl === -1 ? code.length : nl)
    const lit = line.match(/\/\^[^\n]*?(?=\/[gimsuy]*[,);\s]|\/[gimsuy]*$)/)
    if (lit) return { line: lineAt(starts, lineStart), pattern: lit[0] }
    idx = code.indexOf(escaped, idx + 1)
  }
  return null
}

/**
 * 非端点字面量的分类（**逐条**给 reason；返回 null 表示"这是路由候选"）。
 * 顺序有意：根路径 → 副本目录 → 令牌守卫 → 系统目录 → 非 bridge 面。
 */
function excludable(file, literal, line) {
  const of = (reason) => ({ literal, reason, file, line })
  if (literal === '/') {
    return of("root-path-check：'/' 是根路径判定（绝对路径 / URL 根），不是端点")
  }
  if (file.startsWith(VENDORED)) {
    return of(`vendored-sample-skill：${VENDORED} 是上游示例技能副本，自带私有 HTTP 面，不属于本仓 bridge 契约`)
  }
  if (file === TOKEN_GUARD) {
    return of('token-guard：令牌豁免/守卫判定面（不是端点处理器；/health 的处理器在 server/host-routes.mjs，/api/auth/* 在 server/auth-routes.mjs）')
  }
  if (SYSTEM_DIRS.some((p) => literal === p || literal.startsWith(p + '/'))) {
    return of(`system-dir：文件系统目录字面量（${literal}），不是 HTTP 路径`)
  }
  if (!file.startsWith(ROUTE_PREFIX)) {
    return of(`non-bridge-surface：${file.split('/')[0]}/ 侧的路径判定，不落在 bridge 路由链上（bridge 端点只可能在 ${ROUTE_PREFIX}**）`)
  }
  return null
}

/** 形态识别：把一份源码文本里的路径字面量按四形态收集为"命中点"。
 *  每个命中点带两个字段：`form`（来源标签，进 routes/prefixes 的 `forms`）与
 *  `via`（`eq` | `set` | `startsWith` —— 决定这条字面量是**端点**还是**前缀**）。 */
function occurrencesOf(code, file, starts, out) {
  const push = (literal, form, via, idx, methodWin) => {
    out.push({ literal, form, via, file, line: lineAt(starts, idx), methods: methodsIn(methodWin) })
  }
  const isPathOnly = (s) => s.startsWith('/')

  // ① `pathname === '/x'`（`!==` 不是判定点，必须跳过）
  EQ_RE.lastIndex = 0
  let m
  while ((m = EQ_RE.exec(code))) {
    if (m[2].startsWith('!')) continue
    if (!isPathOnly(m[3])) continue
    push(m[3], 'eq', 'eq', m.index, guardWindow(code, m.index))
  }
  // ② `pathname.startsWith('/x')` —— 前缀 + 段匹配，落 prefixes（不是端点）
  STARTS_RE.lastIndex = 0
  while ((m = STARTS_RE.exec(code))) {
    if (!isPathOnly(m[2])) continue
    push(m[2], 'startsWith', 'startsWith', m.index, guardWindow(code, m.index))
  }
  // ③ `new Set(['/x', …])`
  SET_RE.lastIndex = 0
  const sets = []
  while ((m = SET_RE.exec(code))) {
    const name = m[1] || '(anonymous)'
    const members = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]).filter(isPathOnly)
    if (!members.length) continue
    const line = lineAt(starts, m.index)
    sets.push({ name, members, file, line })
    for (const lit of members) push(lit, `set:${name}`, 'set', m.index, guardWindow(code, m.index))
  }
  // ④ `isXxxPath(…)` 返回式谓词：是认领关系（把表/前缀挂到函数名上），本身不新增端点
  ISPATH_RE.lastIndex = 0
  while ((m = ISPATH_RE.exec(code))) {
    const fn = m[1] || m[2]
    const body = bodyOf(code, m.index)
    const bodyIdx = code.indexOf(body, m.index)
    const tag = `isPath:${fn}`
    // 4a 函数体里对表的 `.has()` 引用 → 把该表的成员都记上这个认领者
    for (const ref of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*has\(/g)) {
      const set = sets.find((s) => s.name === ref[1])
      if (!set) continue
      for (const lit of set.members) out.push({ literal: lit, form: tag, via: 'set', file, line: set.line, methods: [] })
    }
    // 4b 函数体里的路径字面量（`startsWith('/transcript/')` / `=== '/api/profile'`）
    for (const lit of body.matchAll(new RegExp(`(===|==|startsWith\\()\\s*'([^']*)'`, 'g'))) {
      if (!isPathOnly(lit[2])) continue
      const idx = bodyIdx + lit.index
      const via = lit[1] === 'startsWith(' ? 'startsWith' : 'eq'
      out.push({ literal: lit[2], form: tag, via, file, line: lineAt(starts, idx), methods: methodsIn(guardWindow(code, idx)) })
    }
  }
  return sets
}

/**
 * 提取 bridge HTTP 路由。
 * @param {{files?: string[], readTracked?: (file: string) => (string|null)}} p
 *   `files` 来自 `scan.mjs#trackedFiles`（已入库）；`readTracked` 按**相对路径**读该文件
 *   （调用方自行 bind root：`(f) => readTracked({ root, file: f })`）。
 * @returns {{routes: Map<string, {forms:string[],file:string,line:number,hints:object[]}>,
 *            prefixes: Array<{prefix:string,children:string[],hints:object[],dynamic:object|null}>,
 *            excluded: Array<{literal:string,reason:string,file:string,line:number}>}}
 */
export function extractRoutes({ files = [], readTracked } = {}) {
  if (!Array.isArray(files)) throw new Error('extractRoutes: files 必须是数组（来自 scan.mjs#trackedFiles）')
  if (typeof readTracked !== 'function') throw new Error('extractRoutes: readTracked(file) 必须注入')

  const hits = []          // 全部形态命中点（含非端点）
  const sets = []          // 全局 Set 表（跨文件按变量名匹配 isPath 谓词）
  for (const file of files) {
    const text = readTracked(file)
    if (typeof text !== 'string') continue
    const code = stripComments(text)      // I3：注释先行剥掉，假路径不进任何集合
    sets.push(...occurrencesOf(code, file, lineMap(code), hits))
  }

  // ── 归类：端点（via=eq/set） / 前缀（via=startsWith） / 排除 ────────────────
  const routeHits = []
  const prefixHits = []
  const excluded = []
  for (const h of hits) {
    const bad = excludable(h.file, h.literal, h.line)
    if (bad) { excluded.push(bad); continue }
    if (h.via === 'startsWith') prefixHits.push(h)
    else routeHits.push(h)
  }

  // ── 路由聚合：按 literal 分组，再按方法展开（同一 path 的"无方法约束"判定点并入每个方法条目）
  const byLiteral = new Map()
  for (const h of routeHits) {
    if (!byLiteral.has(h.literal)) byLiteral.set(h.literal, [])
    byLiteral.get(h.literal).push(h)
  }
  const routes = new Map()
  for (const [literal, list] of byLiteral) {
    const methods = new Set(list.flatMap((h) => h.methods))
    const keys = methods.size ? [...methods].sort() : ['ANY']
    for (const method of keys) {
      const picked = list.filter((h) => h.methods.length === 0 || h.methods.includes(method))
      const hints = dedupeHints(picked)
      routes.set(`${method} ${literal}`, {
        forms: dedupeForms(picked),
        file: hints[0].file,
        line: hints[0].line,
        hints,
      })
    }
  }

  // ── 前缀聚合：children = 该前缀下**静态可枚举**的端点；dynamic = 正则/段比较分派
  const byPrefix = new Map()
  for (const h of prefixHits) {
    if (!byPrefix.has(h.literal)) byPrefix.set(h.literal, [])
    byPrefix.get(h.literal).push(h)
  }
  const routePaths = [...byLiteral.keys()]
  const prefixes = []
  for (const [prefix, list] of byPrefix) {
    const children = routePaths.filter((p) => p !== prefix && p.startsWith(prefix)).sort()
    const hints = dedupeHints(list)
    let dynamic = null
    for (const file of [...new Set(list.map((h) => h.file))]) {
      const text = readTracked(file)
      if (typeof text !== 'string') continue
      const code = stripComments(text)
      const found = anchoredPatternFor(code, prefix, lineMap(code))
      if (!found) continue
      const segments = []
      const suffixes = []
      for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*===?\s*'([^']*)'/g)) {
        const [, varName, lit] = m
        if (/(?:pathname|^p$|^path$)/.test(varName)) continue
        const line = lineAt(lineMap(code), m.index)
        if (lit.startsWith('/')) {
          if (!lit.endsWith('/')) suffixes.push({ literal: lit, file, line })
        } else if (/^(?:id|seg|segment|key|name)$/.test(varName) && /^[A-Za-z][\w-]*$/.test(lit)) {
          segments.push({ literal: lit, file, line })
        }
      }
      dynamic = { ...found, file, segments: uniqBy(segments), suffixes: uniqBy(suffixes) }
      break
    }
    prefixes.push({ prefix, children, hints, dynamic })
  }
  prefixes.sort((a, b) => (a.prefix < b.prefix ? -1 : 1))
  // 排除清单按**判定点**去重（同一字面量在同一行被两种形态命中 = 一个点，不是两条）：
  // 否则"提取守恒"（CT7）会把同一处数两遍，条数虚高
  const exBySite = new Map()
  for (const e of excluded) exBySite.set(`${e.file}:${e.line}:${e.literal}`, e)
  const excludedOut = [...exBySite.values()]
  excludedOut.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return { routes, prefixes, excluded: excludedOut }
}

function dedupeHints(list) {
  const by = new Map()
  for (const h of list) {
    const key = `${h.file}:${h.line}`
    const cur = by.get(key) || { file: h.file, line: h.line, forms: [], methods: [] }
    if (!cur.forms.includes(h.form)) cur.forms.push(h.form)
    for (const m of h.methods) if (!cur.methods.includes(m)) cur.methods.push(m)
    by.set(key, cur)
  }
  return [...by.values()]
    .map((h) => ({ ...h, forms: h.forms.sort(), methods: h.methods.sort() }))
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
}

function dedupeForms(list) { return [...new Set(list.map((h) => h.form))].sort() }
function uniqBy(list) {
  const by = new Map()
  for (const x of list) by.set(`${x.literal}@${x.file}:${x.line}`, x)
  return [...by.values()].sort((a, b) => (a.literal < b.literal ? -1 : 1))
}
