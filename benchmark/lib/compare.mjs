// benchmark/lib/compare.mjs —— B5 结果对比自动化：逐任务 diff 状态/耗时/工具数，
// 生成退化清单。供 report.mjs --compare <baselineDir> 消费（纯函数，可单测）。
// ---------------------------------------------------------------------------
// 判定口径（按 agent×task 匹配）：
//   baseline 缺失            → 'new'（本轮新增）
//   current 缺失             → 'missing'（本轮缺失）
//   pass → 非 pass            → 'regressed'（严重退化）
//   非 pass → pass            → 'improved'（修复）
//   同为 pass/fail，但耗时 >基线×1.5 或工具数 >基线×1.5 → 'slower'（效率退化）
//   其余                       → 'same'
// ---------------------------------------------------------------------------

export function compareResults({ current = [], baseline = [] }) {
  const byKey = (arr) => Object.fromEntries(arr.map((r) => [`${r.agent}:${r.task}`, r]))
  const cur = byKey(current)
  const base = byKey(baseline)
  const keys = new Set([...Object.keys(cur), ...Object.keys(base)])
  const rows = []
  for (const k of [...keys].sort()) {
    const c = cur[k]
    const b = base[k]
    const entry = { agent: c?.agent ?? b?.agent ?? '', task: c?.task ?? b?.task ?? '', baseline: b ?? null, current: c ?? null }
    if (!b) { entry.verdict = 'new' }
    else if (!c) { entry.verdict = 'missing' }
    else if (b.status === 'pass' && c.status !== 'pass') { entry.verdict = 'regressed' }
    else if (b.status !== 'pass' && c.status === 'pass') { entry.verdict = 'improved' }
    else {
      // 基线为 0（如 timeout 无工具调用）时比值无意义，按 1 处理不误判 slower
      const durRatio = b.durationMs > 0 ? c.durationMs / b.durationMs : 1
      const toolRatio = (b.toolCalls || 0) > 0 ? (c.toolCalls || 0) / b.toolCalls : 1
      entry.verdict = durRatio > 1.5 || toolRatio > 1.5 ? 'slower' : 'same'
    }
    rows.push(entry)
  }
  const by = (v) => rows.filter((r) => r.verdict === v)
  return {
    rows,
    regressed: by('regressed'),
    improved: by('improved'),
    slower: by('slower'),
    summary: {
      total: rows.length,
      regressed: by('regressed').length,
      improved: by('improved').length,
      slower: by('slower').length,
      same: by('same').length,
      new: by('new').length,
      missing: by('missing').length,
    },
  }
}
