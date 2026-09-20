// kit/lib/contract-routes.mjs —— HTTP 路由提取器（DevKit P1 · T1）
//
// 设计不变量（每条都由 kit/lib/contract-routes.test.mjs 的断言钉住）：
//   I1 **禁止按文件找 Set 表**（D1）：`FILES_ROUTE_PATHS` 定义在 `server/bridge.mjs:271`，
//      而它的处理器在 `server/files-routes.mjs` ⇒ 必须扫**全部源码文本**做形态识别，
//      而不是"打开 bridge.mjs 找那张表"。
//   I2 扫描域 = 调用方传入的 `files`（`scan.mjs#trackedFiles` = `git ls-files` 即可，
//      **内部自筛**：再过一遍 `codeFiles(files, {includeTests:false})`，剔 test 文件与非代码文件）
//      + `readTracked`（只读已入库文件）。**禁止 readdirSync**：磁盘上的
//      `release/YFWorking/server/*-routes.mjs`、`release/_backup_*/` 都是副本，不是真相（D4）。
//      ★ 自筛不是可选项：raw `trackedFiles` 直传会多出 test 文件里的端点（`server/workflow-api.test.mjs`
//      的 `/workflows/verify`）与一堆 `docs/*.md` 噪声 ⇒ T9 接线自伤（假阳性）。接口自己免疫，不靠调用顺序。
//   I3 注释不是代码：匹配前先过 `scan.mjs#stripComments`（真形态：`bridge.mjs:1757/1829`
//      的注释里写着 `pathname === '…'`）。
//   I4 "提取不到 ≠ 不存在"：每个被形态识别到、但**不是** bridge 端点的字面量都进 `excluded`，
//      **逐条带 reason**（分类前缀可机读），且**不留"其余全部"这类兜底条目**。
//   I5 动态前缀单列成 `prefixes`：`/transcript/`、`/file-collab/`、`/providers/`、`/workflows/`、
//      `/knowledge`、`/logs/` 这类 `startsWith` 是**命名空间**，children 可能为空 ——
//      "通配到底有没有被枚举"必须一眼可判（`providers/` 空 = 段是动态拼的）。
//
// 五形态（`routes` 的 `forms` 字段逐条记录来源）：
//   `eq`            `pathname === '/x'`（含 `p === '/x'`、`url.pathname`；真仓最多的一类）
//   `negated-guard` `pathname !== '/x'`（早退守卫 `if (pathname !== '/x') return null`）——
//                   与 `eq` 同为**认领关系**（真形态：`server/agents-routes.mjs:28`、
//                   `server/disabled-routes.mjs:23`、`server/skill-detail-routes.mjs:28`）。
//   `set`           `const X = new Set(['/x', …])`（`set:<变量名>`）
//   `isPath`        `isXxxPath(pathname)` 返回式谓词（`isPath:<函数名>`）—— 是**认领关系**，不是新端点
//   `startsWith`    `pathname.startsWith('/x')` —— 前缀，落 `prefixes` 而不是 `routes`
import { stripComments, codeFiles } from './scan.mjs'

/** 换行符常量（源码里写裸转义会被编辑链吃掉，这里显式构造） */
const NL = String.fromCharCode(10)

/** 方法字面量（守卫表达式里出现的才算；不出现则方法不可静态判定）。
 *  ★ 不能写尾随 `\b`：`'GET'` 的右侧是引号/空格/行尾（全是非单词字符），`\b` 恒不成立 ——
 *  实测那会让 `method === 'GET'` 一个都读不到（本文件最初就踩了这一脚）。
 *  ★ 引号同样是单/双都认（`method === "POST"` 漏掉的话，端点键会从 `POST /x` 退化成 `ANY /x`
 *  —— 与路径字面量是**同一类**静默漏抓，只是后果轻一点：键的方法语义丢失）。
 *  ★ 大小写不敏感（批 M 复审，与 `contract-doc.mjs` 的文档侧同法）：原先只认大写字面量，
 *  于是代码里写 `method === 'post'` ⇒ 键退化成 `ANY /x` ⇒ 靠 CT3 相容规则②（ANY 与任意方法相容）**判绿**
 *  ⇒ 该端点的方法维度**静默不可判**。捕获后一律 `.toUpperCase()` 归一（键与 finding 都用大写）。
 *  真仓当前 0 处小写写法（所以加 `i` 后 **键集与快照都不变**），但这是与文档侧对称的口子，一并堵上。 */
const METHOD_RE = /(['"])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1/gi

/** 路径主体标识符：只认这些名字，避免把 `target === '/x'` 这类文件系统判定当路由 */
const SUBJECT = '(?:\\w+\\.)?(?:pathname|p|path)'
/**
 * 字符串字面量：**单引号与双引号都认**（第 4 批收口）。
 * ★ 为什么必须两样都认（审查核实的能力边界）：原先只有 `'…'`，于是 `if (pathname === "/x")`
 *   这种**完全合法**的写法**静默漏抓** —— 不是"少报一条"，而是整条链路（CT1/CT2/CT4/CT8）都看不见它
 *   （真仓实测 0 处双引号 / 77 处单引号，且仓里**没有** `.prettierrc` 兜底格式 ⇒ 属潜在漏抓）。
 * ★ 取舍：① **不**接纳反引号 —— 这些判定位置出现模板串时就是**动态**的（`` `${base}/x` ``），
 *   把它当静态端点会造出假端点/假红；② 不做转义解义：体内 `[^'"]` 不含引号（路径字面量里出现引号
 *   不是本仓形态），加逃逸支持只会让正则更脆（宁可漏抓一处怪异写法，不要误抓一片）。
 * ★ 反向引用的序号**逐条写死在下面**（别抽成一个共用常量）：`EQ_RE` 中间有一个操作符捕获组，
 *   引号是第 3 组；`STARTS_RE` 里它是第 2 组 —— 写死 `\1` 会指向**主语**（实测：整条正则永不匹配，
 *   提取结果只剩 Set 表那些键，看起来像"注释剥多了"，实际是反向引用指错组）。
 */
const EQ_RE = new RegExp(`\\b(${SUBJECT})\\s*(!?={2,3})\\s*(['"])([^'"]*)\\3`, 'g')
const STARTS_RE = new RegExp(`\\b(${SUBJECT})\\.startsWith\\(\\s*(['"])([^'"]*)\\2`, 'g')
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
  while ((m = METHOD_RE.exec(win))) out.add(m[2].toUpperCase())
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
    // 两种真实形态都归这一类：`path === '/'`（bare `'/files/'` 前缀判定也是这一族，见下）与
    // `path.startsWith('/')`（绝对路径检查，如 scripts/check-doc-anchors.mjs:117）。
    // ★ 本模块自身也会被扫到（`kit/**` 是已入库源码）：`if (!path.startsWith('/')) continue`
    //   就是这一类，说明"扫描域 = 全部源码文本"是真的在生效。
    return of("root-path-check：`=== '/'` / `startsWith('/')` 这类根路径或绝对路径判定，不是端点")
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
 *  `via`（`eq` | `set` | `startsWith` —— 决定这条字面量是**端点**还是**前缀**）。
 *  `isComment(line)` 是**再兜一道**的注释过滤：`stripComments` 不认正则字面量，
 *  源码里出现 `/'/` 这类写法时会把其后文本当成字符串、**连注释一起留下**（真形态：
 *  `server/bridge.mjs:1716` 的注释在剥注释后仍然存在）⇒ 命中点落在这类行上必须丢掉。 */
function occurrencesOf(code, file, starts, out, isComment) {
  const push = (literal, form, via, idx, methodWin) => {
    const line = lineAt(starts, idx)
    if (isComment(line)) return
    out.push({ literal, form, via, file, line, methods: methodsIn(methodWin) })
  }
  const isPathOnly = (s) => s.startsWith('/')

  // ① `pathname === 单/双引号路径 与 `pathname !== ...` 两种判定点（引号单/双都认，见 EQ_RE）
  EQ_RE.lastIndex = 0
  let m
  while ((m = EQ_RE.exec(code))) {
    if (!isPathOnly(m[4])) continue
    // ★ `!==` 早退守卫（`if (pathname !== '/x') return null`）是**认领该端点**，不是"跳过项"：
    //   真形态 server/agents-routes.mjs:28 / server/disabled-routes.mjs:23 /
    //   server/skill-detail-routes.mjs:28（三条 handler 的入口都是这个形态）。
    //   早先把它 continue 掉，症状是这三条**既不在 routes、也不在 excluded** ——
    //   直接违反 I4"每条字面量都有归宿"（审查 M1 实测：同形态探针文件加进去，路由数纹丝不动）。
    //   归类仍走下面的统一流程（`/` 这类非端点会被 excludable 判为 root-path-check 进 excluded），
    //   故这里不存在"第三条路"。form 记 `negated-guard`，让"守卫形态"在快照里可判。
    push(m[4], m[2].startsWith('!') ? 'negated-guard' : 'eq', 'eq', m.index, guardWindow(code, m.index))
  }
  // ② `pathname.startsWith('/x')` —— 前缀 + 段匹配，落 prefixes（不是端点）
  STARTS_RE.lastIndex = 0
  while ((m = STARTS_RE.exec(code))) {
    if (!isPathOnly(m[3])) continue
    push(m[3], 'startsWith', 'startsWith', m.index, guardWindow(code, m.index))
  }
  // ③ `new Set(['/x', …])`（成员同样单/双引号都认）
  SET_RE.lastIndex = 0
  const sets = []
  while ((m = SET_RE.exec(code))) {
    const name = m[1] || '(anonymous)'
    const members = [...m[2].matchAll(/(['"])([^'"]*)\1/g)].map((x) => x[2]).filter(isPathOnly)
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
      if (!isComment(set.line)) {
        for (const lit of set.members) out.push({ literal: lit, form: tag, via: 'set', file, line: set.line, methods: [] })
      }
    }
    // 4b 函数体里的路径字面量（`startsWith('/transcript/')` / `=== "/api/profile"`；引号单/双都认，见 EQ_RE）
    for (const lit of body.matchAll(new RegExp(`(===|==|startsWith\\()\\s*(['"])([^'"]*)\\2`, 'g'))) {
      if (!isPathOnly(lit[3])) continue
      const idx = bodyIdx + lit.index
      const via = lit[1] === 'startsWith(' ? 'startsWith' : 'eq'
      const line = lineAt(starts, idx)
      if (!isComment(line)) out.push({ literal: lit[3], form: tag, via, file, line, methods: methodsIn(guardWindow(code, idx)) })
    }
  }
  return sets
}

/**
 * 提取 bridge HTTP 路由。
 * @param {{files?: string[], readTracked?: (file: string) => (string|null)}} p
 *   `files` 可**直接**传 `scan.mjs#trackedFiles`（含 test 文件与 `docs/*.md`）：本函数内部会再
 *   过一遍 `codeFiles(files, { includeTests: false })`（**自筛**，见 I2）—— 接口对误用免疫，
 *   调用方不必记得"先 codeFiles 再传进来"（历史 JSDoc 只说"来自 trackedFiles"，照做会自伤）。
 *   `readTracked` 按**相对路径**读该文件（调用方自行 bind root：`(f) => readTracked({ root, file: f })`）。
 * @returns {{routes: Map<string, {forms:string[],file:string,line:number,hints:object[]}>,
 *            prefixes: Array<{prefix:string,children:string[],hints:object[],dynamic:object|null}>,
 *            excluded: Array<{literal:string,reason:string,file:string,line:number}>}}
 */
export function extractRoutes({ files = [], readTracked } = {}) {
  if (!Array.isArray(files)) throw new Error('extractRoutes: files 必须是数组（来自 scan.mjs#trackedFiles）')
  if (typeof readTracked !== 'function') throw new Error('extractRoutes: readTracked(file) 必须注入')
  const scanFiles = codeFiles(files, { includeTests: false })   // ★ 自筛（I2）：接口对误用免疫

  const hits = []          // 全部形态命中点（含非端点）
  const sets = []          // 全局 Set 表（跨文件按变量名匹配 isPath 谓词）
  for (const file of scanFiles) {
    const text = readTracked(file)
    if (typeof text !== 'string') continue
    const code = stripComments(text)      // I3：注释先行剥掉，假路径不进任何集合
    // 第二道：raw 行以注释起头的一律不算（stripComments 被正则字面量击穿时的兜底）
    const rawLines = text.split(NL)
    const isComment = (line) => /^\s*(?:\/\/|\/\*|\*)/.test(rawLines[line - 1] || '')
    sets.push(...occurrencesOf(code, file, lineMap(code), hits, isComment))
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
