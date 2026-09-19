// kit/lib/report.mjs —— DevKit 的统一报告 schema（check 与 view 共用，是 AI 侧的稳定契约）
export const RED = 'red'
export const YELLOW = 'yellow'
export const BASELINED = 'baselined'

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
export function makeReport({ checks = [], findings = [], generatedAt = new Date().toISOString() } = {}) {
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
  return lines.join('\n')
}
