// 里程碑标记解析（方案 A 协议，见 docs/superpowers/specs/2026-08-10-milestone-progress-design.md）
// 计划声明：<!--MILESTONES 3 需求分析|方案设计|编码实现-->
// 开始执行：<!--MILESTONE-START 1/3 需求分析-->
// 达成 check：<!--MILESTONE-OK 1/3 需求分析-->
export function extractMilestoneMarks(text) {
  const out = { stripped: text, milestones: null, oks: [], starts: [] }
  // 大小写不敏感 + 允许 `<!-- MILESTONES`（注释符后带空格，模型常见输出）——
  // 否则 deepseek 等模型按 HTML 惯例输出带空格注释时标记静默失效。
  const planMatch = text.match(/<!--\s*MILESTONES\s+(\d+)\s+([\s\S]*?)-->/i)
  if (planMatch) {
    const total = parseInt(planMatch[1], 10)
    if (total > 0) {
      out.milestones = {
        total,
        names: planMatch[2].split('|').map(s => s.trim()).filter(Boolean),
      }
    }
  }
  const startRe = /<!--\s*MILESTONE-START\s+(\d+)\/(\d+)\s+([\s\S]*?)-->/gi
  let s
  while ((s = startRe.exec(text)) !== null) {
    out.starts.push({
      index: parseInt(s[1], 10),
      total: parseInt(s[2], 10),
      name: s[3].trim(),
    })
  }
  const okRe = /<!--\s*MILESTONE-OK\s+(\d+)\/(\d+)\s+([\s\S]*?)-->/gi
  let m
  while ((m = okRe.exec(text)) !== null) {
    out.oks.push({
      index: parseInt(m[1], 10),
      total: parseInt(m[2], 10),
      name: m[3].trim(),
    })
  }
  const hasMark = /<!--\s*MILESTONE/i.test(text)
  if (out.milestones || out.starts.length > 0 || out.oks.length > 0 || hasMark) {
    out.stripped = text
      .replace(/<!--\s*MILESTONES[\s\S]*?-->|<!--\s*MILESTONE-START[\s\S]*?-->|<!--\s*MILESTONE-OK[\s\S]*?-->/gi, '')
      .trim()
  }
  return out
}

// 散文式阶段兜底：agent 未输出结构化标记时，从自然语言阶段叙述（"阶段 X/Y"、"步骤 X/Y"）
// 提取进度。返回 { total, stages: [{index, total}] }，无匹配返回 null。
export function extractProseStages(text) {
  const re = /(?:阶段|步骤)\s*(\d{1,2})\s*\/\s*(\d{1,2})/g
  const out = []
  let m
  while ((m = re.exec(text)) !== null) {
    const index = parseInt(m[1], 10)
    const total = parseInt(m[2], 10)
    if (index >= 1 && total >= 1 && index <= total) out.push({ index, total })
  }
  if (out.length === 0) return null
  // 按阶段号去重（同阶段多次出现只留 total 最大的一次），按序号排序
  const byIndex = new Map()
  for (const s of out) {
    const prev = byIndex.get(s.index)
    if (!prev || s.total > prev.total) byIndex.set(s.index, s)
  }
  const stages = [...byIndex.values()].sort((a, b) => a.index - b.index)
  return { total: Math.max(...stages.map(s => s.total)), stages }
}
