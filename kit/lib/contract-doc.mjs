// kit/lib/contract-doc.mjs —— 契约文档解析器（DevKit P1 · T5）
//
// 为什么是"解析"而不是"读表"：`docs/bridge-contract.md` 是**受控子集**（plan §1 方案 B）——
// 文档只声明它声明的那些，解析结果**不做任何推断**。三条纪律：
//   I1 §5/§6 表按**反引号分组**：`milestones` / `milestone-start` / `milestone-ok` 是三件事（真盘写法）；
//      同一格内写成 `a / b`（共用一对反引号）时再按 ` / ` 与、 二次拆（兜底，并非真盘现状）。
//   I2 §7 每行按**反引号 + 顿号**分组（一行可以声明 5 条端点）；`（POST）` 是文档声明的方法。
//      ★ 方法名**大小写不敏感**、解析结果**规范化成大写**（`（post）` / `post /x` / `get /x` 与小写
//        形态必须与大写等价；此前只认大写 ⇒ 小写法会静默退化成"没写方法"甚至"整条不存在"）。
//   I3 **文档里的 `*` 不给覆盖信用**（plan §7 反例 ⑧）：`/providers/*`、`/workflows/*` 只声明
//      命名空间 ⇒ 保留 `*` 原样并打 `wildcard:true`，**绝不展开成子路径**（展开 = 给未覆盖的
//      子路径凭空发放"已被文档声明"的信用，对账会假绿）。判定留给 T7。
//   I4 **P1.5 新增 §11/§12**（IPC 推送通道 / 工具 input_schema 出口）：纪律与 §5/§6 一致
//      （反引号分组、一行可多条、` / ` 与顿号二次拆），同样**只解析章节的第一张连续表**；
//      §12 的**指纹必须被反引号包住**且形如 8 位十六进制，否则 `fp:null` —— 指纹是被**逐字比对**
//      的东西，靠"扫行内像不像指纹"去猜等于把判定交给正则的宽容度（宁可要求写清、缺了就红）。
//      为什么把这两类拉回文档面：P1 时它们"零章节"⇒ 只能整类登记（92 条），登记是"人工承认边界"，
//      不是对账；补上文档后契约面回到"文档 ↔ 代码"直接双向（P1.5 的判据 (a)）。
//
// 返回形状（`sections` 是反查索引：每条解析结果都能回到它的章节与行号）：
//   · `wsOut: Set<string>`          §5（bridge → GUI）
//   · `wsIn:  Set<string>`          §6（GUI → bridge）
//   · `routes: Map<path, {method, methods, methodLines, wildcard, row, line, section, docSection}>`  §7
//     ★ 批 M（方法入账）：key 仍是 **path**（CT2/CT4/CT8 的路径粒度不变），方法作为同值的第二维度 ——
//       `methods: Set` = 该路径声明的方法并集（**规范化为大写**）；`method` = **兼容字段** =
//       **按字典序首个**被声明的方法（其余情况 null；见文末的收口说明）；
//       `methodLines: Map<method, line>` = 方法 → 首次出现的行号。取舍与形态说明见 `parseEndpointRow`
//       与 §7 分支（为什么不用 `'<METHOD> <path>'` 作 key：那要连带改所有路径粒度消费方）。
//   · `workflowRoutes: Map<'<METHOD> <path>', {raw, synonyms, row, line, section}>`  §7.1
//   · `ipc:   Set<string>`          §11（Electron IPC 推送通道；主进程 → 渲染层）
//   · `tools: Map<name, {fp, row, line, section}>`  §12（工具名 + 结构指纹；`fp` 可为 null）
//   · `sections: Map<'§N', {title, line, rows, types, routes, workflowRoutes, wildcards}>`
//     （`types` = 该节声明的名字清单：§3/§4 消息类型、§5/§6 WS 类型、§11 通道、§12 工具名）
/** 文档里的章节标题：`## 7. HTTP REST API…` / `### 7.1 工作流模块…` */
const HEADING_RE = /^(#{2,4})\s*(\d+(?:\.\d+)*)\.?\s+(.*)$/

/** 从反引号内容里取路径/类型字面量（`/a`、`GET /a`、`type`） */
const ticked = (cell) => [...String(cell).matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean)

/** 表格行判定（`|` 开头且不是分隔行） */
const isRow = (line) => /^\s*\|/.test(line)
const isSeparator = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line)

/** 表头行判定（各文档表的首列名各不相同，统一按"表头 + 分隔行"这对特征跳过） */
function firstCell(line) {
  const parts = String(line).split('|')
  return parts.length > 1 ? parts[1].trim() : ''
}

/** 取章节正文的第一张连续表（返回 [{line, text}]），行号从 1 起 */
function firstTable(lines, from) {
  const out = []
  let started = false
  for (let i = from; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) break
    if (isRow(lines[i])) {
      if (!started) {
        if (isSeparator(lines[i])) continue
        // 表头：下一行是分隔行 ⇒ 跳过它
        if (isRow(lines[i + 1] || '') && isSeparator(lines[i + 1] || '')) { started = true; continue }
        started = true
      }
      if (isSeparator(lines[i])) continue
      out.push({ line: i + 1, text: lines[i] })
    } else if (started && lines[i].trim() === '') {
      continue
    } else if (started) {
      break
    }
  }
  return out
}

/**
 * 方法名（与 `contract-routes.mjs#METHOD_RE` 同集合；**不含** `ANY` —— 那是代码侧口径）。
 * ★ 大小写不敏感（批 M 复审批）：HTTP 方法在 RFC 里是**大小写敏感**的 token（应写大写），
 *   但文档里的写法不是判据 —— 若解析器只认大写，一处小写就变成"这条声明没写方法"（乃至整条消失）。
 *   实测三类**假绿**（都已在 `contract-doc.test.mjs`「批 M 复审」里钉住）：
 *     ① `（delete）` ⇒ 被当成"没写方法" ⇒ **静默绿**；
 *     ② 行内 `post /x` ⇒ 旧的"token 必须以 `/` 开头"把它整条丢掉 ⇒ 反被 CT2 报"未覆盖"（误导）；
 *     ③ §7.1 的 `get /x` ⇒ 整行解析不出 ⇒ 连 CT2 都不红（纯假绿）。
 *   ⇒ 三个方法正则一律加 `i`，并在解析结果里**规范化成大写**（下游比较、报告、台账都只认大写，
 *     避免 `post` 与 `POST` 在 `Set`/`Map` 里成为两个不同的键）。
 */
const METHOD = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS'
/** 行尾行内方法：`（POST）` / `（GET/POST）` / `(DELETE/PATCH)` —— 全角半角都认（`i` 大小写不敏感），括号里必须**只有**方法名 */
const CELL_METHOD_RE = new RegExp(`[（(]\\s*((?:${METHOD})(?:\\s*[/、]\\s*(?:${METHOD}))*)\\s*[）)]`, 'gi')
/** 反引号 token 里的行内方法前缀：`POST /x` / `GET/POST /x`（批 M 前这类 token 被整条丢掉 —— 见下；`i` 认小写） */
const TOKEN_METHOD_RE = new RegExp(`^((?:${METHOD})(?:[/](?:${METHOD}))*)\\s+(\\/\\S+)`, 'i')
/** 方法名的规范化形态（解析结果的唯一形态：**大写**） */
const normMethod = (m) => String(m).toUpperCase()

/** `GET /workflows/runs?name=x`（兼容 `?id=`）→ { method:'GET', path:'/workflows/runs', raw, synonyms } */
function parseMethodPath(cell) {
  const raw = ticked(cell)[0] || ''
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i.exec(raw)
  if (!m) return null
  const path = m[2].split('?')[0]
  const synonyms = []
  // ★ `（POST 同义）` 这类注释**照旧只记 synonyms、不当"必须存在"的方法**（它是"也接受"的注解，
  //   不是"这一行声明的方法"；`contract-rules.mjs#buildTruth` 不把 synonyms 收进 `routeMethods`）。
  //   这里同样加 `i` 只是"小写别把注释丢掉"（否则 `（post 同义）` 会静默变成没有同义注释），
  //   规范化成大写后与既有断言/消费方一致 —— 注解语义一字未变。
  const syn = /（([A-Z]+)\s*同义）/iu.exec(cell) || /\(([A-Z]+)\s*同义\)/i.exec(cell)
  if (syn) synonyms.push(normMethod(syn[1]))
  return { method: normMethod(m[1]), path, raw, synonyms }
}

/**
 * §7 的一行 → 逐 token 的（路径, 方法）声明：
 *   `| `a`、`b` | 用途 |` / `| `x`（POST） | … |` / `| `POST /x` | … |` / `| `GET/POST /x` | … |`
 *
 * 两种**方法写法**（批 M 补全，此前只认第一种）：
 *   ① 行尾括号：`（POST）` / `(POST)` / `（GET/POST）` —— 适用于本行**未自带宽方法**的 token
 *      （真仓最常见的形态：`| `/mcp/test`、`/mcp/prompts/get`（POST） |`）；
 *   ② 行内前缀：`POST /x` / `GET/POST /x` —— token 自带方法，优先于行尾括号。
 *   ★ 旧解析器要求 token **以 `/` 开头**（`if (!path.startsWith('/')) continue`）⇒ 形态 ② 的端点
 *     **整条解析不出来**（`GET /a` 被当成"不是路径"跳过）= 静默漏声明；现在两者都收。
 *   ★ 方法只从**第一列**读：真仓把 `（GET）` 写在"用途"列的行（文件协同只读面等）**不**算方法声明
 *     —— 那是散文里提到的方法，不是"这一行声明的方法"（照收会凭空造出方法声明）。
 *   ★ 两种写法里的方法名都**大小写不敏感**（`（post）` 与 `（POST）` 等价），出参**一律大写**。
 * @returns {Array<{path:string, methods:string[]}>} 逐条声明（`methods` 为空 = 该条没写方法）
 */
function parseEndpointRow(cell) {
  const text = String(cell)
  const rowMethods = []
  CELL_METHOD_RE.lastIndex = 0
  let m
  while ((m = CELL_METHOD_RE.exec(text))) {
    for (const x of m[1].split(/\s*[/、]\s*/)) if (x) rowMethods.push(normMethod(x))
  }
  const out = []
  for (const tok of ticked(text)) {
    // 一个反引号里也可能用顿号并写多条（兜底，并非真盘现状）
    for (const piece of tok.split('、')) {
      const t = piece.trim()
      if (!t) continue
      const inline = TOKEN_METHOD_RE.exec(t)
      const rest = inline ? inline[2] : t
      const path = rest.split('（')[0].split('(')[0].split('?')[0].trim()
      if (!path.startsWith('/')) continue
      out.push({ path, methods: inline ? inline[1].split('/').map(normMethod) : rowMethods })
    }
  }
  return out
}

/**
 * §12 的一行：`| `Agent` | `1977c7ba` | 一句用途 |`。
 * 取该行**全部反引号 token**：第 1 个形如标识符的是工具名，第 1 个形如 8 位十六进制的是指纹。
 * 指纹**必须包反引号**（散文里的裸串不算）—— 逐字比对的东西不许靠"像不像"来猜。
 * @returns {{name:string, value:{fp:string|null,row:number,line:number,section:string}}|null}
 */
function parseToolRow(text, row, line, section) {
  const toks = ticked(text)
  const name = toks.find((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t))
  if (!name) return null
  const fp = toks.find((t) => /^[0-9a-f]{8}$/.test(t)) || null
  return { name, value: { fp, row, line, section } }
}

/**
 * 解析契约文档文本（纯函数，同输入必同输出）。
 * @param {string} text
 * @returns {{wsOut:Set<string>, wsIn:Set<string>, routes:Map<string,object>,
 *            workflowRoutes:Map<string,object>, ipc:Set<string>, tools:Map<string,object>,
 *            sections:Map<string,object>}}
 */
export function parseDoc(text) {
  // Windows 检出是 CRLF：行尾的 CR 在 JS 里是**行终止符**，点号与行尾锚都够不到它
  //   （实测：标题行带 CR 时正则全失配 ⇒ 真仓解析出 0 个章节、全表为空）。
  //   故统一按 CRLF 与裸 LF 两种行尾切行。
  const lines = String(text ?? '').split(/\r?\n/)
  // ① 章节切分（含子节 §7.1/§7.2/§7.3）
  const heads = []
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i])
    if (m) heads.push({ id: `§${m[2]}`, title: m[3].trim(), line: i + 1, start: i + 1 })
  }
  const sections = new Map()
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]
    const end = i + 1 < heads.length ? heads[i + 1].start - 1 : lines.length
    sections.set(h.id, {
      title: h.title,
      line: h.line,
      end,
      rows: 0,
      types: [],
      routes: [],
      workflowRoutes: [],
      wildcards: [],
    })
  }

  const wsOut = new Set()
  const wsIn = new Set()
  const routes = new Map()
  const workflowRoutes = new Map()
  const ipc = new Set()
  const tools = new Map()

  for (const h of heads) {
    const sec = sections.get(h.id)
    const rows = firstTable(lines, h.start)
    sec.rows = rows.length
    const cells = rows.map((r) => firstCell(r.text))

    if (h.id === '§3' || h.id === '§4' || h.id === '§5' || h.id === '§6' || h.id === '§11') {
      // `milestones` / `milestone-start` / `milestone-ok` ⇒ 三条（按 ` / ` 与顿号拆）
      const types = []
      for (const cell of cells) {
        for (const tok of ticked(cell)) {
          for (const piece of tok.split(/\s*\/\s*|、/)) {
            const t = piece.trim()
            if (t && !t.includes(' ')) types.push(t)
          }
        }
      }
      sec.types = [...new Set(types)]
      for (const t of sec.types) {
        if (h.id === '§5') wsOut.add(t)
        else if (h.id === '§6') wsIn.add(t)
        else if (h.id === '§11') ipc.add(t)
      }
      continue
    }

    if (h.id === '§12') {
      let row = 0
      for (const r of rows) {
        row++
        const e = parseToolRow(r.text, row, r.line, h.id)
        if (!e) continue
        if (!tools.has(e.name)) tools.set(e.name, e.value)
        sec.types.push(e.name)
      }
      sec.types = [...new Set(sec.types)]
      continue
    }

    if (h.id === '§7') {
      let row = 0
      for (const r of rows) {
        row++
        for (const e of parseEndpointRow(firstCell(r.text))) {
          // ★ 批 M：**同路径多方法合并**（key 仍是 path ⇒ CT2/CT4/CT8 的路径粒度不变）。
          //   旧写法 `if (!routes.has(path)) routes.set(...)` 让"同一路径的第二条声明"整条消失 ——
          //   真仓 `/api/profile`（读行无方法 + 写行 `（POST）`）的 POST 声明就是这么丢的。
          let v = routes.get(e.path)
          if (!v) {
            v = {
              method: null,                 // 兼容字段：首个被声明的方法（null = 该路径没有任何声明写方法）
              methods: new Set(),           // 该路径在 §7 声明的方法并集（**只收写了方法的声明**）
              methodLines: new Map(),       // 方法 → 首次出现的行号（finding 要指到那一行）
              wildcard: e.path.includes('*'),
              row, line: r.line, section: h.id, docSection: h.id,
            }
            routes.set(e.path, v)
          }
          for (const mm of e.methods) {
            v.methods.add(mm)
            if (!v.methodLines.has(mm)) v.methodLines.set(mm, r.line)
          }
          if (!sec.routes.includes(e.path)) sec.routes.push(e.path)
          if (v.wildcard && !sec.wildcards.includes(e.path)) sec.wildcards.push(e.path)
        }
      }
      continue
    }

    if (h.id === '§7.1') {
      let row = 0
      for (const r of rows) {
        row++
        const cell = firstCell(r.text)
        const p = parseMethodPath(cell)
        if (!p) continue
        const key = `${p.method} ${p.path}`
        if (!workflowRoutes.has(key)) {
          workflowRoutes.set(key, { raw: p.raw, synonyms: p.synonyms, row, line: r.line, section: h.id })
        }
        sec.workflowRoutes.push(key)
      }
      continue
    }
  }

  // ★ 批 M：兼容字段 `method` = **按字典序的首个**被声明方法（null = 该路径没有任何声明写方法）。
  //   为什么不用"首个出现的"：那是**书写次序**的函数 —— `GET/POST /x` 与 `POST/GET /x`
  //   （同一份契约的两种写法）会给出不同的 `method`，同输入必同输出这条就不成立了（确定性可复算）。
  for (const v of routes.values()) v.method = [...v.methods].sort()[0] ?? null

  return { wsOut, wsIn, routes, workflowRoutes, ipc, tools, sections }
}
