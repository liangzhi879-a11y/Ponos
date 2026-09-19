// kit/lib/contract-doc.mjs —— 契约文档解析器（DevKit P1 · T5）
//
// 为什么是"解析"而不是"读表"：`docs/bridge-contract.md` 是**受控子集**（plan §1 方案 B）——
// 文档只声明它声明的那些，解析结果**不做任何推断**。三条纪律：
//   I1 §5/§6 表按**反引号分组**：`milestones` / `milestone-start` / `milestone-ok` 是三件事（真盘写法）；
//      同一格内写成 `a / b`（共用一对反引号）时再按 ` / ` 与、 二次拆（兜底，并非真盘现状）。
//   I2 §7 每行按**反引号 + 顿号**分组（一行可以声明 5 条端点）；`（POST）` 是文档声明的方法。
//   I3 **文档里的 `*` 不给覆盖信用**（plan §7 反例 ⑧）：`/providers/*`、`/workflows/*` 只声明
//      命名空间 ⇒ 保留 `*` 原样并打 `wildcard:true`，**绝不展开成子路径**（展开 = 给未覆盖的
//      子路径凭空发放"已被文档声明"的信用，对账会假绿）。判定留给 T7。
//
// 返回形状（`sections` 是反查索引：每条解析结果都能回到它的章节与行号）：
//   · `wsOut: Set<string>`          §5（bridge → GUI）
//   · `wsIn:  Set<string>`          §6（GUI → bridge）
//   · `routes: Map<path, {method, wildcard, row, line, section, docSection}>`  §7
//   · `workflowRoutes: Map<'<METHOD> <path>', {raw, synonyms, row, line, section}>`  §7.1
//   · `sections: Map<'§N', {title, line, rows, types, routes, workflowRoutes, wildcards}>`
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

/** `GET /workflows/runs?name=x`（兼容 `?id=`）→ { method:'GET', path:'/workflows/runs', raw, synonyms } */
function parseMethodPath(cell) {
  const raw = ticked(cell)[0] || ''
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/.exec(raw)
  if (!m) return null
  const path = m[2].split('?')[0]
  const synonyms = []
  const syn = /（([A-Z]+)\s*同义）/u.exec(cell) || /\(([A-Z]+)\s*同义\)/.exec(cell)
  if (syn) synonyms.push(syn[1])
  return { method: m[1], path, raw, synonyms }
}

/** §7 的一行：`| `a`、`b` | 用途 |` / `| `x`（POST） | … |` */
function parseEndpointRow(cell, row, line, section) {
  const out = []
  const method = /（(GET|POST|PUT|PATCH|DELETE)）/u.exec(cell) || /\((GET|POST|PUT|PATCH|DELETE)\)/.exec(cell)
  for (const tok of ticked(cell)) {
    const path = tok.split('（')[0].split('(')[0].trim()
    if (!path.startsWith('/')) continue
    out.push({
      path,
      value: {
        method: method ? method[1] : null,
        wildcard: path.includes('*'),
        row,
        line,
        section,
        docSection: section,
      },
    })
  }
  return out
}

/**
 * 解析契约文档文本（纯函数，同输入必同输出）。
 * @param {string} text
 * @returns {{wsOut:Set<string>, wsIn:Set<string>, routes:Map<string,object>,
 *            workflowRoutes:Map<string,object>, sections:Map<string,object>}}
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

  for (const h of heads) {
    const sec = sections.get(h.id)
    const rows = firstTable(lines, h.start)
    sec.rows = rows.length
    const cells = rows.map((r) => firstCell(r.text))

    if (h.id === '§3' || h.id === '§4' || h.id === '§5' || h.id === '§6') {
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
      }
      continue
    }

    if (h.id === '§7') {
      let row = 0
      for (const r of rows) {
        row++
        for (const e of parseEndpointRow(firstCell(r.text), row, r.line, h.id)) {
          if (!routes.has(e.path)) routes.set(e.path, e.value)
          sec.routes.push(e.path)
          if (e.value.wildcard && !sec.wildcards.includes(e.path)) sec.wildcards.push(e.path)
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

  return { wsOut, wsIn, routes, workflowRoutes, sections }
}
