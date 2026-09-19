// kit/lib/contract-scope.mjs —— 契约范围登记（DevKit P1 · T8）
//
// 为什么需要它：spec §12 的"双向对账"在"文档缺半壁"时不可行（IPC 与工具 schema 文档零章节、
// §7 只覆盖 ≈1/3 路径）。判定补成两条后，第 (b) 条"**范围登记完整**"就是本模块的职责：
// 登记集必须等于"**代码真值 ∖ 文档已声明**"。三条防"一条通配放行一切"的闸：
//
//   ① `ns` / `members` 禁 `*` 与正则字符 —— 写了即**条目失效**并报 CT4C（不是"忽略坏字符"）；
//   ② 集合相等（多一少一都红）：`members` 的并集必须**恰好**覆盖真值差集；
//   ③ 命中判定只用 `keyOf(kind, name)` 的**精确 tuple**（`JSON.stringify([kind, name])`）——
//      **本文件不得出现 `startsWith` / `includes` / 正则**做匹配（"前缀/子串放行"是把
//      scope 变成放行一切的入口；测试里有**源码级**断言钉住，`contract-scope.test.mjs`）。
//
// 与 `drift-baseline.json` **刻意不复用**（plan §5）：baseline 的语义是"已知漂移、可降级为 baselined"，
// scope 的语义是"范围边界、**不降级任何 finding**"。混用会让"一条 scope = 放行一切"，正是要防的事。
//
// 本模块**只读**：没有任何写函数（与 `sync` 不得写它的不变量 I4 同源）。首填/维护一律人工编辑。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SCOPE_FILE = 'kit/manifest/contract-scope.json'

/** 允许的 kind：四类契约 + 文档侧（`doc` 保留给"文档自身待补"的边界条目） */
export const SCOPE_KINDS = ['routes', 'wsOut', 'wsIn', 'ipc', 'tools', 'doc']
/** 白名单查表用 Set（**本文件禁 `includes`/`startsWith`/正则** —— 见文件头第 ③ 条；测试有源码级断言） */
const KIND_SET = new Set(SCOPE_KINDS)

/** 禁用的通配/正则字符（`*`、`?`、量词、分组、字符类、锚点、转义符） */
const FORBIDDEN_CHARS = new Set(['*', '?', '+', '(', ')', '[', ']', '{', '}', '|', '^', '$', String.fromCharCode(92)])

/**
 * 登记键：**精确 tuple** 的 JSON 序列化。
 * 用 JSON 数组而不是 `kind + '::' + name`：后者会让 `{kind:'a::b', name:'c'}` 与
 * `{kind:'a', name:'b::c'}` 撞成同一键（同一坑见 baseline.mjs#keyOf 的注释）。
 */
export function keyOf(kind, name) { return JSON.stringify([kind, name]) }

/** 含禁用字符？（逐字符查表，不用正则 —— 本模块不做任何正则匹配） */
function forbiddenIn(s) {
  for (const ch of String(s)) if (FORBIDDEN_CHARS.has(ch)) return ch
  return null
}

function isObj(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v) }

/**
 * 读人工登记文件并逐条体检。
 * @returns {{present:boolean, file:string, loadError:string|null, entries:Array}}
 *   `entries[].problems` 非空 = 该条目**失效**（不产生任何覆盖），并由 CT4C 报红。
 */
export function loadScope({ root } = {}) {
  const out = { present: false, file: SCOPE_FILE, loadError: null, entries: [] }
  const p = join(root, SCOPE_FILE)
  if (!existsSync(p)) return out
  out.present = true
  let json = null
  try { json = JSON.parse(readFileSync(p, 'utf8')) } catch (e) { out.loadError = `JSON 解析失败：${e.message}`; return out }
  const raw = Array.isArray(json?.entries) ? json.entries : null
  if (raw === null) { out.loadError = '文件缺少 entries 数组'; return out }

  const seenGroups = new Map()
  const seenKeys = new Map()
  out.entries = raw.map((e, index) => {
    const problems = []
    const o = isObj(e) ? e : {}
    if (!isObj(e)) problems.push('条目不是对象')
    const kind = o.kind
    const ns = o.ns
    const members = Array.isArray(o.members) ? o.members : null
    const reason = typeof o.reason === 'string' ? o.reason.trim() : ''
    if (!KIND_SET.has(kind)) problems.push(`kind 不在白名单 ${SCOPE_KINDS.join('/')}（实测 ${JSON.stringify(kind)}）`)
    if (typeof ns !== 'string' || !ns.trim()) problems.push('ns 缺失或空白')
    else {
      const bad = forbiddenIn(ns)
      if (bad) problems.push(`ns 含通配/正则字符 ${JSON.stringify(bad)}（登记只允许精确命名空间）`)
    }
    if (members === null) problems.push('members 必须是数组（精确键清单，不得省略）')
    else {
      if (!members.length && !reason) problems.push('members 为空的条目必须写 reason 说明"空命名空间"的理由')
      for (const m of members) {
        if (typeof m !== 'string' || !m.trim()) { problems.push('members 里有非字符串/空白项'); continue }
        const bad = forbiddenIn(m)
        if (bad) problems.push(`member ${JSON.stringify(m)} 含通配/正则字符 ${JSON.stringify(bad)}`)
      }
    }
    // ★ reason 必填非空（I4：放行即人工且理由可见）—— 缺 reason 的条目**失效**并报 CT4C
    if (!reason) problems.push('缺 reason（范围登记必须写明为什么这些键不在文档覆盖面内）')
    if (o.docSection !== undefined && o.docSection !== null && typeof o.docSection !== 'string') {
      problems.push('docSection 必须是 null 或章节字符串（如 "§7"）')
    }
    // ★ 重复登记：**涉及的两条都失效**（不是"后来的那条失效、先前那条照旧生效"）——
    //   重复登记说明这份人工清单已经不可信（谁先谁后不该由文件顺序决定放行结果），
    //   而"两条都失效"的代价是清晰的：其成员回到"未登记"→ CT4 照常报红，不会静默放行。
    const groupKey = keyOf(String(kind), String(ns))
    if (!seenGroups.has(groupKey)) seenGroups.set(groupKey, [])
    seenGroups.get(groupKey).push(index)
    for (const m of members || []) {
      if (typeof m !== 'string') continue
      const k = keyOf(String(kind), m)
      if (!seenKeys.has(k)) seenKeys.set(k, [])
      seenKeys.get(k).push(index)
    }
    return { index, kind, ns, members: members || [], docSection: o.docSection === undefined ? null : o.docSection, reason, at: o.at ?? null, problems }
  })
  for (const [groupKey, idxs] of seenGroups) {
    if (idxs.length < 2) continue
    for (const i of idxs) out.entries[i].problems.push(`同 (kind, ns) 重复登记：${groupKey} 共 ${idxs.length} 条（重复条目全部失效）`)
  }
  for (const [k, idxs] of seenKeys) {
    if (idxs.length < 2) continue
    for (const i of idxs) out.entries[i].problems.push(`member 重复登记：${k} 共 ${idxs.length} 条（重复条目全部失效）`)
  }
  return out
}

/**
 * 双护栏：① 登记**组数** ② 登记**键数** 不得超过人工封顶值（`channels.scopeCount` / `channels.scopeRedCount`）。
 *
 * 没有它，范围登记会变成"文档不动、scope 无限扩容"的后门：每次代码新增端点只要往 members 里塞一条，
 * 门禁照旧全绿，而"范围边界"这件事就永远不需要人解释。
 * ★ 两条护栏**必须都接线**（P0 的教训：`baselineRedCount` 当时只读不写 ⇒ 第二道护栏形同不存在）：
 *   `recordedCount`/`recordedRedCount` 都从台账读、都由首填写进 `versions.json#channels`。
 * 两条都没超 → null（与 `baselineGrowth` 同形状，便于同一段接线消费）。
 */
export function contractGrowth({ scope, recordedCount = null, recordedRedCount = null } = {}) {
  const entries = scope?.entries || []
  const count = entries.length
  const keyCount = entries.reduce((n, e) => n + (e.members || []).length, 0)
  const out = { count, keyCount, recordedCount, recordedRedCount, exceeded: null, redExceeded: null }
  if (Number.isInteger(recordedCount) && count > recordedCount) out.exceeded = count
  if (Number.isInteger(recordedRedCount) && keyCount > recordedRedCount) out.redExceeded = keyCount
  if (out.exceeded === null && out.redExceeded === null) return null
  return out
}

/** 报告用：把成员清单折成一行（超过上限只列前 N 条 + "…共 M 条"） */
function listUpTo(items, n = 12) {
  const arr = [...items].sort()
  return arr.length <= n ? arr.join('、') : `${arr.slice(0, n).join('、')} …共 ${arr.length} 条`
}

/**
 * 范围登记的判定：`members`（有效条目）与 `truth`（代码真值 ∖ 文档已声明）**集合相等**。
 *
 * @param {{scope:object, truth:object, docSections?:string[]}} p
 *   `truth` 形如 `{routes:[…], wsOut:[…], wsIn:[…], ipc:[…], tools:[…], doc:[…]}`（精确键名清单）。
 * @returns {{coverage:Set<string>, findings:Array, groups:Array, groupCount:number, keyCount:number,
 *            invalidCount:number, byKind:object}}
 *   `coverage` = keyOf 元组集合（**只含有效条目**）—— CT2 的"或在 scope 登记"直接消费它。
 */
export function checkScopeSets({ scope, truth = {}, docSections = null } = {}) {
  const entries = scope?.entries || []
  const findings = []
  const coverage = new Map()
  const invalid = []

  for (const e of entries) {
    if (e.problems.length) { invalid.push(e); continue }
    for (const m of e.members) coverage.set(keyOf(e.kind, m), { ns: e.ns, index: e.index })
  }

  // ── CT4C：条目不合法（含 reason 缺失、通配、重复、编造章节）→ 失效并红 ─────────────
  for (const e of invalid) {
    findings.push({
      rule: 'CT4C', severity: 'red', subject: `${e.kind} ${e.ns || `(条目 #${e.index})`}`,
      message: `范围登记条目失效：${e.problems.join('；')}`,
      hint: '修 design：ns/members 只允许精确键（禁 `*` 与正则字符）、reason 必须写明真实理由；'
        + '失效条目**不产生任何覆盖**，其成员的 finding 会照常报红（这正是"不许静默放行"）',
    })
  }
  if (docSections) {
    const known = new Set(docSections)
    for (const e of entries) {
      if (!e.docSection || e.problems.length) continue
      if (!known.has(e.docSection)) {
        findings.push({
          rule: 'CT4C', severity: 'red', subject: `${e.kind} ${e.ns} docSection=${e.docSection}`,
          message: `docSection 指向不存在的章节 ${e.docSection}（文档实有：${[...known].join(' ')}）`,
          hint: 'docSection 是"该命名空间与哪一节相关"的**可核对**指针，不能编造；无相关章节请写 null',
        })
      }
    }
  }

  // ── CT4：集合相等（双向）──────────────────────────────────────────────
  const kinds = [...new Set([...SCOPE_KINDS.filter((k) => k in truth), ...entries.map((e) => e.kind)])].sort()
  const byKind = {}
  for (const kind of kinds) {
    const t = new Set(truth[kind] || [])
    const r = new Set(entries.filter((e) => e.kind === kind && !e.problems.length).flatMap((e) => e.members))
    const missing = [...t].filter((x) => !r.has(x))
    const extra = [...r].filter((x) => !t.has(x))
    byKind[kind] = { truth: t.size, registered: r.size, missing: missing.length, extra: extra.length }
    if (missing.length) {
      findings.push({
        rule: 'CT4', severity: 'red', subject: `${kind} 未登记 ${missing.length} 条`,
        message: `代码真值 ∖ 文档已声明 里还有未登记的键：${listUpTo(missing)}`,
        hint: '要么在 docs/bridge-contract.md 补齐声明（另开 P1.5），要么在 kit/manifest/contract-scope.json 逐条精确登记（人工）',
      })
    }
    if (extra.length) {
      findings.push({
        rule: 'CT4', severity: 'red', subject: `${kind} 多登记 ${extra.length} 条`,
        message: `登记里有**不在**"代码真值 ∖ 文档已声明"中的键（文档已声明 / 已不存在 / 拼错）：${listUpTo(extra)}`,
        hint: '多登记 = 给已由文档覆盖或根本不存在的键发放豁免；删除多余成员（登记集必须与真值差集**相等**）',
      })
    }
  }

  return {
    coverage: new Set(coverage.keys()),
    findings,
    groups: entries.map((e) => ({ kind: e.kind, ns: e.ns, count: e.members.length, docSection: e.docSection, reason: e.reason, problems: e.problems.length })),
    groupCount: entries.length,
    keyCount: entries.reduce((n, e) => n + e.members.length, 0),
    invalidCount: invalid.length,
    byKind,
  }
}
