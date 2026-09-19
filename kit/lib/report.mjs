// kit/lib/report.mjs —— DevKit 的统一报告 schema（check 与 view 共用，是 AI 侧的稳定契约）
export const RED = 'red'
export const YELLOW = 'yellow'
export const BASELINED = 'baselined'

/**
 * 构造一条发现（finding）。
 * 刻意把 expected/actual 字符串化：版本常量里既有数字（INDEX_VERSION=4）又有字符串，
 * 若按原类型存进 JSON 再比对，会出现 `4 !== "4"` 这种与业务无关的假红。
 */
export function finding({ rule, severity, subject, expected, actual, file, line, hint, reason }) {
  const out = { rule, severity, subject }
  if (expected !== undefined) out.expected = String(expected)
  if (actual !== undefined) out.actual = String(actual)
  if (file) out.file = file
  if (line) out.line = line
  if (hint) out.hint = hint
  if (reason) out.reason = reason
  return out
}

/** 一条规则的执行结果（用于 summary.green：通过了几条规则） */
export function checkResult({ rule, title, evaluated = 0, passed = true }) {
  return { rule, title, evaluated, passed }
}

export function makeReport({ checks = [], findings = [], generatedAt = new Date().toISOString() } = {}) {
  const count = (s) => findings.filter((f) => f.severity === s).length
  const red = count(RED)
  return {
    ok: red === 0,
    generatedAt,
    summary: {
      red,
      yellow: count(YELLOW),
      baselined: count(BASELINED),
      green: checks.filter((c) => c.passed).length,
      rules: checks.length,
    },
    checks,
    findings,
  }
}

/** 人话报告（给人看；AI 侧读 JSON） */
export function renderHuman(report) {
  const lines = []
  const { red, yellow, baselined } = report.summary
  lines.push(`DevKit 检查：${report.ok ? '✅ 通过' : '❌ 未通过'}  （红灯 ${red} / 黄灯 ${yellow} / 基线 ${baselined}）`)
  const section = (severity, title) => {
    const items = report.findings.filter((f) => f.severity === severity)
    if (!items.length) return
    lines.push('')
    lines.push(`── ${title}（${items.length}）──`)
    for (const f of items) {
      const loc = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : ''
      const diff = (f.expected !== undefined && f.actual !== undefined) ? `  期望 ${f.expected} / 实际 ${f.actual}` : ''
      lines.push(`  [${f.rule}] ${f.subject}${loc ? '  ' + loc : ''}${diff}`)
      if (f.reason) lines.push(`        （已登记基线：${f.reason}）`)
      if (f.hint) lines.push(`        → ${f.hint}`)
    }
  }
  section(RED, '红灯（阻断）')
  section(YELLOW, '黄灯（提示）')
  section(BASELINED, '基线（已知断账）')
  return lines.join('\n')
}
