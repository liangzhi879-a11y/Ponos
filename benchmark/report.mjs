#!/usr/bin/env node
// 横向对比报告生成器（可视化 + 评分）
// 用法：node benchmark/report.mjs results/<ts> [--latest] [--compare <baselineDir>]
// 输出：results/<ts>/report.md + report.html（自包含，无外部依赖）
// --compare：与基线结果目录逐任务对比，报告首部输出退化/改善清单（B5 自动化）
// ---------------------------------------------------------------------------
// 评分体系（每 agent 汇总分 0-100）：
//   完成率   40%   pass 任务占比
//   探索效率 20%   平均耗时归一化（最快 agent 满分，越慢越低）
//   验证能力 20%   自测率（主动运行测试/verify）
//   改动质量 20%   改动聚焦度（只碰任务相关文件=高分；越界改动扣分）
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeScores } from './lib/scoring.mjs'
import { auditResults } from './lib/audit.mjs'
import { compareResults } from './lib/compare.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const argv = process.argv.slice(2)
let tsArg = argv.find((a) => !a.startsWith('--'))
const latest = argv.includes('--latest')

const resultsRoot = join(__dirname, 'results')

// 定位结果目录
let dir
const hasSummary = (d) => existsSync(join(resultsRoot, d, 'summary.json')) || existsSync(join(resultsRoot, d, 'meta.json'))
if (latest) {
  const dirs = readdirSync(resultsRoot).filter((d) => hasSummary(d))
  if (!dirs.length) { console.error('无评测结果'); process.exit(1) }
  dir = join(resultsRoot, dirs.sort().reverse()[0])
} else if (tsArg) {
  dir = join(resultsRoot, tsArg.replace(/^results[/\\]/, ''))
  if (!existsSync(dir)) { console.error('结果目录不存在:', dir); process.exit(1) }
} else {
  const dirs = readdirSync(resultsRoot).filter((d) => hasSummary(d))
  if (!dirs.length) { console.error('无评测结果，用法: node benchmark/report.mjs results/<ts> [--latest]'); process.exit(1) }
  console.log('最近一次评测：', dirs.sort().reverse()[0])
  dir = join(resultsRoot, dirs.sort().reverse()[0])
}

// 数据收集：summary.json（正式评测）或目录内单条 JSON（冒烟）
let summary
if (existsSync(join(dir, 'summary.json'))) {
  summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))
} else {
  summary = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'meta.json' && f !== 'summary.json')
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
}
const meta = existsSync(join(dir, 'meta.json'))
  ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  : {}
const agents = [...new Set(summary.map((s) => s.agent))]
const taskIds = [...new Set(summary.map((s) => s.task))]

const fmt = (ms) => (ms >= 60000 ? (ms / 60000).toFixed(1) + 'm' : Math.round(ms / 1000) + 's')
const fmtMs = (ms) => (ms >= 60000 ? (ms / 60000).toFixed(1) + 'm' : ms + 'ms')
const tok = (n) => (n == null ? '—' : n.toLocaleString())
const okIcon = (s) => (s.status === 'pass' ? '✅' : s.status === 'fail' ? '❌' : '⚠️')

// ── 评分计算（逻辑在 lib/scoring.mjs，report 与 dashboard 共用）────────────
const { scores } = computeScores(agents, summary)

const rankLabel = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : '')
const avgOf = (fn, pred = () => true) => {
  const rs = summary.filter(pred)
  return rs.length ? rs.reduce((s, x) => s + fn(x), 0) / rs.length : 0
}

// ── Markdown ─────────────────────────────────────────────────────────────────
let md = `# Ponos-turbo 内核横向评估报告\n\n`
md += `- 评测时间：${meta.ts || basename(dir)}\n`
md += `- 模型：${meta.model || '—'}\n`
md += `- 被测对象：${agents.join(' / ')}\n`
md += `- 任务集：${taskIds.join(' / ')}\n\n`

// B5 对比基线：--compare <baselineDir> → 报告首部输出退化/改善清单
let cmp = null
const cmpIdx = argv.indexOf('--compare')
const baselineDir = cmpIdx >= 0 ? argv[cmpIdx + 1] : null
if (baselineDir) {
  const baseDir = join(resultsRoot, String(baselineDir).replace(/^results[/\\]/, ''))
  let baseSummary = []
  try {
    if (existsSync(join(baseDir, 'summary.json'))) {
      baseSummary = JSON.parse(readFileSync(join(baseDir, 'summary.json'), 'utf8'))
    } else {
      baseSummary = readdirSync(baseDir)
        .filter((f) => f.endsWith('.json') && f !== 'meta.json' && f !== 'summary.json')
        .map((f) => JSON.parse(readFileSync(join(baseDir, f), 'utf8')))
    }
  } catch (e) { console.error('基线读取失败:', e.message); process.exit(1) }
  cmp = compareResults({ current: summary, baseline: baseSummary })
  md += `## 退化对比（vs ${baselineDir}）\n\n`
  md += `**汇总**：${cmp.summary.regressed} 退化 / ${cmp.summary.improved} 改善 / ${cmp.summary.slower} 变慢 / ${cmp.summary.same} 持平 / ${cmp.summary.new} 新增 / ${cmp.summary.missing} 缺失\n\n`
  if (cmp.regressed.length || cmp.slower.length) {
    md += `| 判定 | Agent | 任务 | 基线状态 | 当前状态 | 基线耗时 | 当前耗时 | 基线工具 | 当前工具 |\n|---|---|---|---|---|---|---|---|---|\n`
    for (const r of [...cmp.regressed, ...cmp.slower]) {
      const b = r.baseline || {}
      const c = r.current || {}
      md += `| ${r.verdict} | ${r.agent} | ${r.task} | ${b.status ?? '—'} | ${c.status ?? '—'} | ${fmt(b.durationMs ?? 0)} | ${fmt(c.durationMs ?? 0)} | ${b.toolCalls ?? '—'} | ${c.toolCalls ?? '—'} |\n`
    }
    md += `\n`
  }
  if (cmp.improved.length) {
    md += `**改善**：${cmp.improved.map((r) => `${r.agent}×${r.task}`).join('、')}\n\n`
  }
}

// 总评分排行
md += `## 零、综合评分排行\n\n| 排名 | Agent | 综合分 | 完成率(40) | 探索效率(20) | 验证能力(20) | 改动质量(20) |\n|---|---|---|---|---|---|---|\n`
for (const a of [...agents].sort((x, y) => (scores[y]?.total ?? -1) - (scores[x]?.total ?? -1))) {
  const s = scores[a]
  if (!s) continue
  md += `| ${rankLabel(s.rank)} ${s.rank} | ${a} | **${s.total}** | ${(s.passRate * 100).toFixed(0)}% | ${s.effScore} | ${(s.selfTestRate * 100).toFixed(0)}% | ${(s.focusRate * 100).toFixed(0)}% |\n`
}
md += `\n> 评分口径：完成率 40% + 探索效率 20%（平均耗时归一化）+ 验证能力 20%（自测率）+ 改动质量 20%（改动聚焦度）。\n\n`

// 总览矩阵
md += `## 一、任务完成矩阵\n\n| 任务 | ${agents.join(' | ')} |\n|---|---${'|---'.repeat(agents.length)}\n`
for (const t of taskIds) {
  md += `| ${t} |`
  for (const a of agents) {
    const s = summary.find((x) => x.agent === a && x.task === t)
    md += ` ${s ? okIcon(s) : '—'} |`
  }
  md += '\n'
}
md += `\n**通过率**：`
for (const a of agents) {
  const rs = summary.filter((x) => x.agent === a)
  const pass = rs.filter((x) => x.status === 'pass').length
  md += `${a} ${pass}/${rs.length}　`
}
md += `\n\n## 二、多维指标\n\n`
for (const a of agents) {
  const rs = summary.filter((x) => x.agent === a)
  md += `### ${a}\n\n| 任务 | 状态 | 耗时 | 输入 token | 输出 token | 工具调用 | 成本($) | 主动自测 | 改动文件 |\n|---|---|---|---|---|---|---|---|---|\n`
  for (const r of rs) {
    const ns = (r.diff?.nameStatus || '').split('\n').filter(Boolean)
    md += `| ${r.task} | ${okIcon(r)}${r.status} | ${fmt(r.durationMs)} | ${tok(r.usage?.input_tokens)} | ${tok(r.usage?.output_tokens)} | ${r.toolCalls ?? '—'} | ${r.cost?.toFixed?.(4) ?? '—'} | ${r.selfTested ? '✅' : '—'} | ${ns.map((l) => l.split('\t').pop()).join(', ') || '—'} |\n`
  }
  md += `\n`
}

// 失败详情
const fails = summary.filter((s) => s.status !== 'pass')
if (fails.length) {
  md += `## 三、失败分析（失败案例比成功案例更有价值）\n\n`
  for (const f of fails) {
    md += `### ${f.agent} × ${f.task}\n\n`
    md += `- 状态：${f.status}；耗时 ${fmt(f.durationMs)}；退出码 ${f.exitCode}${f.timedOut ? '（**超时**）' : ''}\n`
    md += `- 验收输出：\n\`\`\`\n${(f.verify?.stdout || '').slice(0, 600)}\n\`\`\`\n`
    if (f.verify?.stderr) md += `- 验收错误：\n\`\`\`\n${f.verify.stderr.slice(0, 600)}\n\`\`\`\n`
    if (f.diff?.stat) md += `- 改动范围：\n\`\`\`\n${f.diff.stat.slice(0, 600)}\n\`\`\`\n`
    if (f.stderrTail) md += `- agent stderr 尾部：\n\`\`\`\n${f.stderrTail.slice(0, 400)}\n\`\`\`\n`
    md += `\n`
  }
}

// 语义越界审计（agent 自创语义/自我合理化注释检测，人工复核用）
const audit = auditResults(summary)
md += `## 四、语义越界审计\n\n`
if (!audit.byResult.length) {
  md += `未检测到"自创语义/合理化注释"特征（去重、只计首、防重复等关键词，含否定语境排除）。\n\n`
} else {
  md += `共 **${audit.total}** 处命中（检测 agent 新增代码中的自创语义注释，如 T004 实测的"去重口径"类发明；仅供参考，需人工复核）:\n\n`
  md += `| Agent | 任务 | 状态 | 命中组 | 文件 | 命中文本 |\n|---|---|---|---|---|---|\n`
  for (const r of audit.byResult) {
    for (const h of r.hits) {
      md += `| ${r.agent} | ${r.task} | ${okIcon({ status: r.status })}${r.status} | ${h.group} | \`${h.file}\` | \`${h.line.replace(/\|/g, '\\|')}\` |\n`
    }
  }
  md += `\n`
}

// 能力洞察
md += `## 五、探索成本与验证能力对比\n\n`
md += `| 指标 | ${agents.join(' | ')} |\n|---|---${'|---'.repeat(agents.length)}\n`
for (const metric of ['平均耗时', '平均工具调用', '自测率', '改动聚焦度']) {
  md += `| ${metric} |`
  for (const a of agents) {
    const rs = summary.filter((x) => x.agent === a)
    if (!rs.length) { md += ' — |'; continue }
    if (metric === '平均耗时') md += ` ${fmt(avgOf((x) => x.durationMs, (x) => x.agent === a))} |`
    else if (metric === '平均工具调用') md += ` ${(avgOf((x) => x.toolCalls || 0, (x) => x.agent === a)).toFixed(1)} |`
    else if (metric === '自测率') md += ` ${(rs.filter((x) => x.selfTested).length / rs.length * 100).toFixed(0)}% |`
    else md += ` ${(scores[a]?.focusRate ?? 0) * 100}% |`
  }
  md += '\n'
}
md += `\n*成本按 usage × 单价（input $0.2/M, output $1.2/M）估算；pi/deepseek 的 usage 未上报时成本列为 —。*\n`

writeFileSync(join(dir, 'report.md'), md)

// ── HTML（自包含可视化，无外部依赖）─────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const bar = (pct, color = '#4caf50') => `<div class="bar"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>`

// 各 agent 的图表数据（注入 JS）
const chartData = JSON.stringify({
  agents: agents.map((a) => ({ name: a, ...scores[a] })),
  tasks: taskIds.map((t) => ({
    id: t,
    dur: agents.map((a) => summary.find((x) => x.agent === a && x.task === t)?.durationMs ?? 0),
    tools: agents.map((a) => summary.find((x) => x.agent === a && x.task === t)?.toolCalls ?? 0),
  })),
})

let html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Ponos-turbo 横向评估 ${meta.ts || ''}</title>
<style>
:root{--pass:#1a7f37;--fail:#c62828;--warn:#b26a00;--ink:#1a1a1a;--muted:#666;--line:#e5e7eb;--bg-card:#fff;--bg-soft:#f6f8fa}
*{box-sizing:border-box}
body{font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;background:#f0f2f5;color:var(--ink);margin:0;padding:24px}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--line)}
h3{font-size:15px;margin:16px 0 8px}
table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:13px;background:var(--bg-card);border-radius:8px;overflow:hidden}
th,td{border-bottom:1px solid var(--line);padding:7px 10px;text-align:left}
th{background:var(--bg-soft);font-weight:600;white-space:nowrap}
tr.pass td{background:#f2fbf4}tr.fail td{background:#fdf3f3}tr.workspace-error td{background:#fafafa}
code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:12px}
pre{background:#f8f8f8;padding:10px;border-radius:6px;overflow-x:auto;font-size:12px;max-height:240px;overflow-y:auto}
.badge{display:inline-block;padding:1px 9px;border-radius:10px;font-size:11px;font-weight:700}
.badge.pass{background:#e3f5e8;color:var(--pass)}.badge.fail{background:#fde3e3;color:var(--fail)}.badge.other{background:#eee;color:var(--muted)}
.cards{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0}
.card{flex:1;min-width:180px;background:var(--bg-card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .label{font-size:12px;color:var(--muted)}
.card .num{font-size:28px;font-weight:800;margin:2px 0}
.card .sub{font-size:12px;color:var(--muted)}
.rank-num{font-size:40px;font-weight:900;background:linear-gradient(135deg,#2563eb,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent}
.bar{background:#eef0f3;border-radius:4px;height:8px;min-width:60px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:10px 0}
.metric{background:var(--bg-card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.metric .m-label{font-size:12px;color:var(--muted);display:flex;justify-content:space-between}
.metric .m-label b{color:var(--ink)}
.tabs{display:flex;gap:6px;margin:10px 0}
.tab{padding:5px 14px;border-radius:16px;font-size:13px;background:var(--bg-soft);border:1px solid var(--line);cursor:pointer}
.tab.active{background:#2563eb;color:#fff;border-color:#2563eb}
.chart-box{background:var(--bg-card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:10px 0}
footer{color:var(--muted);font-size:12px;margin-top:28px;text-align:center}
</style></head><body><div class="wrap">`

html += `<h1>Ponos-turbo 内核横向评估报告</h1>`
html += `<p style="color:var(--muted);margin:0">${esc(meta.ts || basename(dir))} · 模型 ${esc(meta.model || '—')} · 任务集 ${taskIds.join(' / ')}</p>`

// 顶部总览卡片
const totalPass = summary.filter((s) => s.status === 'pass').length
html += `<div class="cards">
  <div class="card"><div class="label">总通过率</div><div class="num">${totalPass}/${summary.length}</div><div class="sub">${(totalPass / summary.length * 100).toFixed(0)}% 全部任务</div></div>
  <div class="card"><div class="label">任务总数</div><div class="num">${taskIds.length}</div><div class="sub">${agents.length} 个被测对象</div></div>
  <div class="card"><div class="label">平均耗时</div><div class="num">${fmt(avgOf((x) => x.durationMs))}</div><div class="sub">每 (agent×task)</div></div>
  <div class="card"><div class="label">自测率</div><div class="num">${(summary.filter((x) => x.selfTested).length / summary.length * 100).toFixed(0)}%</div><div class="sub">主动运行测试/verify</div></div>
</div>`

// B5 退化对比（--compare 时插入首部表格）
if (cmp) {
  html += `<h2>退化对比（vs ${esc(baselineDir)}）</h2>`
  html += `<p style="color:var(--muted);font-size:12px">${cmp.summary.regressed} 退化 / ${cmp.summary.improved} 改善 / ${cmp.summary.slower} 变慢 / ${cmp.summary.same} 持平 / ${cmp.summary.new} 新增 / ${cmp.summary.missing} 缺失</p>`
  if (cmp.regressed.length || cmp.slower.length) {
    html += `<table><tr><th>判定</th><th>Agent</th><th>任务</th><th>基线状态</th><th>当前状态</th><th>基线耗时</th><th>当前耗时</th><th>基线工具</th><th>当前工具</th></tr>`
    for (const r of [...cmp.regressed, ...cmp.slower]) {
      const b = r.baseline || {}
      const c = r.current || {}
      html += `<tr><td><span class="badge fail">${r.verdict}</span></td><td>${esc(r.agent)}</td><td>${esc(r.task)}</td><td>${esc(b.status ?? '—')}</td><td>${esc(c.status ?? '—')}</td><td>${fmt(b.durationMs ?? 0)}</td><td>${fmt(c.durationMs ?? 0)}</td><td>${b.toolCalls ?? '—'}</td><td>${c.toolCalls ?? '—'}</td></tr>`
    }
    html += `</table>`
  }
  if (cmp.improved.length) {
    html += `<p style="color:var(--muted);font-size:12px"><b>改善</b>：${cmp.improved.map((r) => `${r.agent}×${r.task}`).join('、')}</p>`
  }
}

// 综合评分排行（横向条形 + 排名）
html += `<h2>综合评分排行</h2><div class="cards">`
for (const a of [...agents].sort((x, y) => (scores[y]?.total ?? -1) - (scores[x]?.total ?? -1))) {
  const s = scores[a]
  if (!s) continue
  html += `<div class="card" style="text-align:center">
    <div class="rank-num">${s.total}</div>
    <div style="font-weight:700;font-size:15px;margin:4px 0">${esc(a)} ${rankLabel(s.rank)}</div>
    <div class="sub">完成率 ${(s.passRate * 100).toFixed(0)}% · 效率 ${s.effScore} · 自测 ${(s.selfTestRate * 100).toFixed(0)}% · 聚焦 ${(s.focusRate * 100).toFixed(0)}%</div>
  </div>`
}
html += `</div><p style="color:var(--muted);font-size:12px">评分口径：完成率 40% + 探索效率 20%（平均耗时归一化，最快=100）+ 验证能力 20%（自测率）+ 改动质量 20%（改动聚焦度）。</p>`

// 雷达图 / 条形图（Canvas，动态渲染）
html += `<div class="chart-box"><h3 style="margin-top:0">四维能力对比（雷达图）</h3><canvas id="radar" height="300"></canvas></div>`
html += `<div class="chart-box"><h3 style="margin-top:0">各任务耗时对比（柱状图）</h3><canvas id="durChart" height="220"></canvas></div>`

// 任务完成矩阵
html += `<h2>任务完成矩阵</h2><table><tr><th>任务</th>${agents.map((a) => `<th>${esc(a)}</th>`).join('')}</tr>`
for (const t of taskIds) {
  html += `<tr><td>${esc(t)}</td>${agents.map((a) => {
    const s = summary.find((x) => x.agent === a && x.task === t)
    return `<td>${s ? `<span class="badge ${s.status}">${s.status}</span>` : '—'}</td>`
  }).join('')}</tr>`
}
html += '</table>'

// 多维指标
html += `<h2>多维指标</h2>`
for (const a of agents) {
  html += `<h3>${esc(a)} <span style="color:var(--muted);font-weight:400;font-size:12px">综合 ${scores[a]?.total ?? '—'} 分 · 排名 ${scores[a]?.rank ?? '—'}</span></h3>`
  html += `<table><tr><th>任务</th><th>状态</th><th>耗时</th><th>输入</th><th>输出</th><th>工具调用</th><th>成本($)</th><th>自测</th><th>改动文件</th></tr>`
  for (const r of summary.filter((x) => x.agent === a)) {
    const ns = (r.diff?.nameStatus || '').split('\n').filter(Boolean).map((l) => l.split('\t').pop() || l.split(/\s+/)[1] || '')
    html += `<tr class="${r.status}"><td>${esc(r.task)}</td><td><span class="badge ${r.status}">${r.status}</span></td><td>${fmt(r.durationMs)}</td><td>${tok(r.usage?.input_tokens)}</td><td>${tok(r.usage?.output_tokens)}</td><td>${r.toolCalls ?? '—'}</td><td>${r.cost?.toFixed?.(4) ?? '—'}</td><td>${r.selfTested ? '✅' : '—'}</td><td style="font-size:11px">${esc(ns.join(', ')) || '—'}</td></tr>`
  }
  html += '</table>'
}

// 失败详情（折叠）
if (fails.length) {
  html += `<h2>失败详情</h2>`
  for (const f of fails) {
    html += `<details style="margin:8px 0;background:var(--bg-card);border:1px solid var(--line);border-radius:8px;padding:10px 14px">
    <summary style="cursor:pointer;font-weight:600"><span class="badge ${f.status}">${f.status}</span> ${esc(f.agent)} × ${esc(f.task)}${f.timedOut ? '（超时）' : ''} · ${fmt(f.durationMs)}</summary>`
    if (f.verify?.stdout) html += `<pre>${esc(f.verify.stdout.slice(0, 800))}</pre>`
    if (f.verify?.stderr) html += `<pre>${esc(f.verify.stderr.slice(0, 800))}</pre>`
    if (f.diff?.stat) html += `<pre>${esc(f.diff.stat.slice(0, 800))}</pre>`
    if (f.stderrTail) html += `<pre>${esc(f.stderrTail.slice(0, 500))}</pre>`
    html += `</details>`
  }
}

html += `<footer>Ponos-turbo 内核横向评估平台 · 成本按 usage × 单价（input $0.2/M, output $1.2/M）估算 · 失败案例比成功案例更有价值</footer>`

html += `<script>
const DATA = ${chartData};
const COLORS = ['#2563eb','#7c3aed','#059669','#d97706','#dc2626','#0891b2'];

// 雷达图：四维能力（完成率/效率/自测/聚焦，归一化 0-100）
(function() {
  const c = document.getElementById('radar');
  if (!c || !DATA.agents.length) return;
  const ctx = c.getContext('2d');
  const W = c.width = c.offsetWidth || 800, H = c.height = 280;
  const cx = W/2, cy = H/2 + 6, R = Math.min(W, H) / 2 - 48;
  const dims = [
    {k:'passRate', label:'完成率', color:'#2563eb'},
    {k:'effScore', label:'探索效率', color:'#059669'},
    {k:'selfTestRate', label:'验证能力', color:'#d97706'},
    {k:'focusRate', label:'改动质量', color:'#7c3aed'},
  ];
  ctx.clearRect(0,0,W,H);
  // 网格
  for (let ring=1; ring<=4; ring++) {
    ctx.beginPath();
    for (let i=0;i<=dims.length;i++) {
      const ang = -Math.PI/2 + i/dims.length*2*Math.PI;
      const rr = R*ring/4;
      const x = cx + rr*Math.cos(ang), y = cy + rr*Math.sin(ang);
      i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    }
    ctx.strokeStyle = '#e5e7eb'; ctx.stroke();
  }
  // 轴标签
  ctx.font = '12px sans-serif'; ctx.fillStyle = '#666'; ctx.textAlign='center';
  dims.forEach((d,i) => {
    const ang = -Math.PI/2 + i/dims.length*2*Math.PI;
    const x = cx + (R+22)*Math.cos(ang), y = cy + (R+22)*Math.sin(ang);
    ctx.fillText(d.label, x, y+4);
  });
  // 多边形
  DATA.agents.forEach((a, ai) => {
    ctx.beginPath();
    dims.forEach((d, i) => {
      const v = (a[d.k] ?? 0) * (d.k==='effScore'?1:100);
      const rr = Math.max(4, R * Math.min(1, v/100));
      const ang = -Math.PI/2 + i/dims.length*2*Math.PI;
      const x = cx + rr*Math.cos(ang), y = cy + rr*Math.sin(ang);
      i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    ctx.closePath();
    ctx.fillStyle = COLORS[ai%COLORS.length] + '33'; ctx.fill();
    ctx.strokeStyle = COLORS[ai%COLORS.length]; ctx.lineWidth = 2; ctx.stroke();
  });
  // 图例
  ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
  DATA.agents.forEach((a, ai) => {
    const x = 12, y = 16 + ai*18;
    ctx.fillStyle = COLORS[ai%COLORS.length]; ctx.fillRect(x, y-9, 12, 12);
    ctx.fillStyle = '#333'; ctx.fillText(a.name + ' (' + (a.total ?? '—') + '分)', x+18, y);
  });
})();

// 柱状图：各任务耗时（grouped bars）
(function() {
  const c = document.getElementById('durChart');
  if (!c || !DATA.tasks.length) return;
  const ctx = c.getContext('2d');
  const W = c.width = c.offsetWidth || 800, H = c.height = 200;
  const padL = 56, padR = 16, padT = 14, padB = 30;
  ctx.clearRect(0,0,W,H);
  const maxV = Math.max(...DATA.tasks.flatMap(t => t.dur), 60*1000);
  const n = DATA.tasks.length, g = DATA.agents.length;
  const bw = Math.min(46, (W-padL-padR)/n/g*0.7);
  ctx.font = '10px sans-serif'; ctx.fillStyle = '#666';
  // y 轴刻度
  const ticks = 4;
  for (let i=0;i<=ticks;i++) {
    const v = maxV*i/ticks, y = H-padB - (H-padT-padB)*i/ticks;
    ctx.strokeStyle = '#eee'; ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(W-padR,y); ctx.stroke();
    ctx.fillStyle = '#666'; ctx.textAlign='right';
    ctx.fillText(Math.round(v/1000)+'s', padL-6, y+3);
  }
  DATA.tasks.forEach((t, ti) => {
    const x0 = padL + (W-padL-padR)/n*ti + (W-padL-padR)/n*0.5 - g*bw/2;
    t.dur.forEach((d, ai) => {
      const h = (H-padT-padB) * Math.min(1, d/maxV);
      const x = x0 + ai*bw, y = H-padB - h;
      ctx.fillStyle = COLORS[ai%COLORS.length] + (d===0?'22':'cc');
      ctx.fillRect(x, y, bw-3, Math.max(1,h));
      ctx.fillStyle = '#666'; ctx.textAlign='center';
      if (d > 0) ctx.fillText(Math.round(d/1000)+'s', x+(bw-3)/2, y-3);
    });
    ctx.fillStyle = '#333'; ctx.textAlign='center';
    ctx.fillText(t.id.replace(/-.*/,''), x0 + g*bw/2, H-10);
  });
  // 图例
  ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  DATA.agents.forEach((a, ai) => {
    const x = padL + ai*86, y = 10;
    ctx.fillStyle = COLORS[ai%COLORS.length]; ctx.fillRect(x, y-8, 10, 10);
    ctx.fillStyle = '#333'; ctx.fillText(a.name, x+14, y);
  });
})();
</script>`

html += `</div></body></html>`
writeFileSync(join(dir, 'report.html'), html)
console.log('报告已生成：')
console.log('  Markdown:', join(dir, 'report.md'))
console.log('  HTML   :', join(dir, 'report.html'))
if (cmp) {
  console.log(`退化对比（vs ${baselineDir}）：${cmp.summary.regressed} 退化 / ${cmp.summary.improved} 改善 / ${cmp.summary.slower} 变慢 / ${cmp.summary.same} 持平 / ${cmp.summary.new} 新增 / ${cmp.summary.missing} 缺失`)
  for (const r of [...cmp.regressed, ...cmp.slower]) {
    console.log(`  [${r.verdict}] ${r.agent}×${r.task}：${r.baseline?.status ?? '—'}→${r.current?.status ?? '—'} (${fmt(r.baseline?.durationMs ?? 0)}→${fmt(r.current?.durationMs ?? 0)})`)
  }
}
