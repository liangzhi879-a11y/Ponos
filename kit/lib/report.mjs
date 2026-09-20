// kit/lib/report.mjs —— DevKit 的统一报告 schema（check 与 view 共用，是 AI 侧的稳定契约）
export const RED = 'red'
export const YELLOW = 'yellow'
export const BASELINED = 'baselined'

/**
 * **只报不拦**的规则集 —— 它们的 finding 一律是 `YELLOW`（或被基线降级成 `BASELINED`），
 * 因此**永不影响退出码**，只在报告里"报一声"。渲染层（`report.mjs` 人类可读输出、GUI）
 * 必须据此区分「✘ 未通过（红，会拦）」与「✘ 有待办（只报不拦）」——
 * 否则读者会把"确实有东西但本来就不拦"误读成"门禁失败"。
 *
 * ★ 为什么要有这份**单一真源**：此前 GUI 里各自硬编码 `['CT8','CT9']`，而
 * `dep-rules.mjs` 的 `P5`/`P6` 同样只发 `YELLOW` ⇒ 它们被**误标成「阻断」**。
 * 这类"某个概念在多处各写一份"正是漂移之源（与「合同文档腐烂」同因）。
 *
 * ★ 与规则实现的**锁**：`report.test.mjs` 会扫描各 `*-rules.mjs` 源码里
 * `rule: 'X', severity: <SEV>` 的字面量配对，双向断言：
 *   ① 凡是发过 `YELLOW` 的规则 ⇒ **必须**在本集合里；
 *   ② 本集合里的规则 ⇒ **不得**发过 `RED`。
 * 于是"新增一条黄灯规则却忘了登记"会被测试当场拦下（不是靠自觉）。
 */
export const NON_BLOCKING_RULES = new Set(['CT8', 'CT9', 'P5', 'P6'])

/**
 * 构造一条发现（finding）。
 * 刻意把 expected/actual 字符串化：版本常量里既有数字（INDEX_VERSION=4）又有字符串，
 * 若按原类型存进 JSON 再比对，会出现 `4 !== "4"` 这种与业务无关的假红。
 *
 * `baselinedFrom` 由 baseline.mjs 在降级时写入（保留原始 severity），报告的
 *「基线豁免 N 条，其中红灯 M 条」里的 M 就靠反查它 —— 没有它，被豁免的红灯
 * 会与"本来就是黄"的条目混在一起，"绿灯里藏着人工放行"就统计不出来。
 */
export function finding({ rule, severity, subject, expected, actual, file, line, hint, reason, message, baselinedFrom }) {
  const out = { rule, severity, subject }
  if (expected !== undefined) out.expected = String(expected)
  if (actual !== undefined) out.actual = String(actual)
  if (file) out.file = file
  if (line) out.line = line
  if (hint) out.hint = hint
  if (reason) out.reason = reason
  if (message) out.message = message
  if (baselinedFrom) out.baselinedFrom = baselinedFrom
  return out
}

/** 一条规则的执行结果（用于 summary.green：通过了几条规则） */
export function checkResult({ rule, title, evaluated = 0, passed = true }) {
  return { rule, title, evaluated, passed }
}

/**
 * 汇总报告。summary 是**派生快照**（从 findings/checks 算出来的），所以套用基线后
 * 必须**重建**报告，不能"复用旧 report 只把 findings 换掉"—— 那会留下脏的红灯计数。
 * lib 层为此提供 baseline.mjs 的 `reportWithBaseline(findings, baseline)`，渲染路径一律走它。
 */
export function makeReport({ checks = [], findings = [], generatedAt = new Date().toISOString(), scope = null } = {}) {
  const count = (s) => findings.filter((f) => f.severity === s).length
  const red = count(RED)
  const baselined = count(BASELINED)
  return {
    ok: red === 0,
    generatedAt,
    // summary.baselined 是条数（spec §9 的稳定 schema）；顶层的 baselined 另给
    //「其中红灯几条」的拆分（裁定规则 3），两处都由同一批 findings 一次算出。
    summary: {
      red,
      yellow: count(YELLOW),
      baselined,
      green: checks.filter((c) => c.passed).length,
      rules: checks.length,
    },
    baselined: { total: baselined, red: findings.filter((f) => f.severity === BASELINED && f.baselinedFrom === RED).length },
    checks,
    findings,
    // 契约范围登记摘要（P1）。**只有调用方显式传入时才有该键**：report.mjs 的既有测试断言
    // renderHuman 的逐行输出，凭空多一段会让它们变红；CLI 侧两条渲染路径（check/view）都会传。
    ...(scope ? { scope } : {}),
  }
}

/**
 * 人话报告（给人看；AI 侧读 JSON）。
 *
 * ★ 2026-09-19 裁定规则 3：豁免统计必须**始终可见**。初版 renderHuman 在有豁免、
 *   且豁免条都是红灯时照样打印裸「✅ 通过」，于是"加一行 JSON 把红灯变绿"在报告里
 *   完全看不出来 —— 与 I4「放行即人工且可见」相反。故：
 *   - 豁免统计行在任何情况下（含通过）都打印；
 *   - 有豁免时通过行写成 `✅ 通过（红灯 0 / 基线豁免 N 条，其中红灯 M 条）`；
 *   - M > 0 时再逐条列出 `rule subject reason`，让人一眼看到绿灯里的放行。
 *
 * 注意：本函数只渲染，不重算。调用方须用 baseline.mjs 的 `reportWithBaseline`
 * 重建报告后再传进来（summary 是派生快照，复用旧 report 会留下脏计数）。
 */
export function renderHuman(report) {
  const lines = []
  const { red, yellow } = report.summary
  const total = report.baselined ? report.baselined.total : report.summary.baselined
  const redBaselined = report.baselined ? report.baselined.red : 0
  const bracket = total > 0
    ? `（红灯 ${red} / 基线豁免 ${total} 条，其中红灯 ${redBaselined} 条）`
    : `  （红灯 ${red} / 黄灯 ${yellow} / 基线 ${total}）`
  lines.push(`DevKit 检查：${report.ok ? '✅ 通过' : '❌ 未通过'}${bracket}`)
  lines.push(`基线豁免：${total} 条（其中红灯 ${redBaselined} 条）`)
  if (redBaselined > 0) {
    for (const f of report.findings.filter((x) => x.severity === BASELINED && x.baselinedFrom === RED)) {
      lines.push(`  ⚠ 基线放行：[${f.rule}] ${f.subject}  ${f.reason || '（未写理由）'}`)
    }
  }
  const section = (severity, title) => {
    const items = report.findings.filter((f) => f.severity === severity)
    if (!items.length) return
    lines.push('')
    lines.push(`── ${title}（${items.length}）──`)
    for (const f of items) {
      const loc = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : ''
      lines.push(`  [${f.rule}] ${f.subject}${loc ? '  ' + loc : ''}`)
      if (f.expected !== undefined && f.actual !== undefined) lines.push(`        期望 ${f.expected} / 实际 ${f.actual}`)
      if (f.message) lines.push(`        ${f.message}`)
      if (f.reason) lines.push(`        （已登记基线：${f.reason}）`)
      if (f.hint) lines.push(`        → ${f.hint}`)
    }
  }
  section(RED, '红灯（阻断）')
  section(YELLOW, '黄灯（提示）')
  section(BASELINED, '基线（已知断账）')
  renderScope(report, lines)
  return lines.join('\n')
}

/**
 * 契约范围登记段（P1 · 先例 §7.3 规则 3 的同族要求：**豁免/范围统计始终可见**）。
 *
 * ★ 为什么**逐条**列而不是只报总数：范围登记就是"哪些契约面不在文档覆盖面内"的**边界**本身。
 *   只打「37 键」等于把边界藏起来 —— 读者无法判断"这 37 键是真边界还是被人塞进来凑数的"；
 *   逐条带 `kind/ns/count/docSection/reason` 才让"为什么它可以不检查"当场可核对。
 * ★ 为什么"恒打印"：`report.scope` 由 CLI 的两条渲染路径（check / view）都传；
 *   只有 lib 层的旧测试没传（那时不打印，避免破坏它们的逐行断言）。
 */
function renderScope(report, lines) {
  const s = report.scope
  if (!s) return
  lines.push('')
  lines.push(`── 契约范围登记（${s.total} 组 / ${s.keys} 键）──`)
  if (!s.total) {
    lines.push(`  （${s.present ? '登记为空' : '无 kit/manifest/contract-scope.json'}：代码真值里没有"文档未声明"的键，或登记文件缺失）`)
    return
  }
  for (const g of s.groups) {
    const doc = g.docSection === null || g.docSection === undefined ? '无' : g.docSection
    const bad = g.problems ? `  ⚠ ${g.problems} 条问题（条目失效，CT4C）` : ''
    lines.push(`  [${g.kind}] ${g.ns}  ${g.count} 键  docSection=${doc}${bad}`)
    lines.push(`        ${g.reason}`)
  }
}
