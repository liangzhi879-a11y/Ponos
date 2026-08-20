#!/usr/bin/env node
// YFW-turbo 横向评估 —— 实时交互 Dashboard
// ---------------------------------------------------------------------------
// 本地 HTTP 服务（零依赖，node:http）：
//   GET /                       → 交互式 dashboard 页面（自包含，无外部依赖）
//   GET /api/snapshot?dir=<ts>  → 汇总 JSON（meta + 评分 + 每任务结果 + 实时进行中状态）
//   GET /api/result?dir=&agent=&task= → 单条完整结果 JSON（详情面板用）
//   GET /api/dirs               → 历史结果目录列表（下拉切换）
// 评测运行中（node benchmark/run.mjs）打开 dashboard 即可实时看到进度：
//   run.mjs 每完成一个 (agent×task) 写一条 JSON，dashboard 轮询 results/ 目录动态刷新；
//   run.mjs 写 active.json（当前正在跑的任务）时 dashboard 显示"进行中 + 已耗时"。
// 用法：node benchmark/dashboard.mjs [--port 8787] [--dir <ts>]
// ---------------------------------------------------------------------------
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { computeScores } from './lib/scoring.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const resultsRoot = join(__dirname, 'results')
const repoRoot = join(__dirname, '..')
const controlFile = join(resultsRoot, '.control.json')

// ── 参数 ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const port = Number(argv[argv.indexOf('--port') + 1] ?? process.env.DASHBOARD_PORT ?? 8787)
const dirIdx = argv.indexOf('--dir')
const dirArg = dirIdx >= 0 ? argv[dirIdx + 1] : null
// --open：服务就绪后自动打开浏览器（一键启动脚本用）
const autoOpen = argv.includes('--open')

// ── 结果目录工具 ──────────────────────────────────────────────────────────────
const hasMeta = (d) => existsSync(join(resultsRoot, d, 'meta.json'))
const listDirs = () => readdirSync(resultsRoot)
  .filter((d) => hasMeta(d) || existsSync(join(resultsRoot, d, 'summary.json')))
  .sort((a, b) => (a < b ? 1 : -1)) // 新→旧

/** 加载一个结果目录的完整数据（冒烟/正式评测都支持） */
function loadDir(dir) {
  const base = join(resultsRoot, dir)
  const meta = existsSync(join(base, 'meta.json'))
    ? JSON.parse(readFileSync(join(base, 'meta.json'), 'utf8'))
    : { ts: dir }
  let results = []
  if (existsSync(join(base, 'summary.json'))) {
    results = JSON.parse(readFileSync(join(base, 'summary.json'), 'utf8'))
  } else {
    results = readdirSync(base)
      .filter((f) => f.endsWith('.json') && f !== 'meta.json' && f !== 'summary.json' && f !== 'active.json')
      .map((f) => JSON.parse(readFileSync(join(base, f), 'utf8')))
  }
  // 实时进行中状态：active.json 由 run.mjs 心跳写入
  // 心跳超过 15min 视为残留（进程被强杀后 finally 未执行），忽略以免误报"进行中"
  let active = null
  if (existsSync(join(base, 'active.json'))) {
    try {
      const a = JSON.parse(readFileSync(join(base, 'active.json'), 'utf8'))
      if (a.since && Date.now() - a.since < 15 * 60 * 1000) active = a
    } catch { /* 忽略坏文件 */ }
  }
  return { meta, results, active }
}

/** 从结果目录生成快照（meta + 评分 + 结果 + 状态） */
function buildSnapshot(dir) {
  const { meta, results, active } = loadDir(dir)
  const agents = [...new Set(results.map((s) => s.agent))]
  const taskIds = [...new Set(results.map((s) => s.task))]
  const { scores } = computeScores(agents, results)
  // 每个结果附带轻量视图（完整 stdout/verify 详情由 /api/result 按需取）
  const rows = results.map((r) => ({
    agent: r.agent, task: r.task, status: r.status,
    durationMs: r.durationMs, timedOut: !!r.timedOut,
    toolCalls: r.toolCalls ?? null, cost: r.cost ?? null,
    selfTested: !!r.selfTested, exitCode: r.exitCode,
    hasDetail: true, // 详情可经 /api/result 获取
  }))
  // 进行中/未开始：meta.tasks 声明的全集减去已有结果
  const todo = (meta.tasks || taskIds).filter((t) => !results.some((r) => r.task === t))
  const pending = []
  if (active) {
    pending.push({ agent: active.agent, task: active.task, since: active.since })
  } else {
    for (const t of todo) pending.push({ agent: agents[0] || null, task: t })
  }
  return {
    dir, meta, agents, taskIds,
    scores: Object.fromEntries(agents.map((a) => [a, scores[a]])),
    rows, active, pending, todo,
    totalPass: rows.filter((r) => r.status === 'pass').length,
    total: rows.length,
  }
}

// ── 评测控制（spawn run.mjs 子进程 + control 文件）─────────────────────────
// 状态机：idle → running → paused → running → done / aborted / failed
// pause/abort 通过 .control.json 下发给 run.mjs（任务边界生效）；
// abort 兜底：超过 10s 未退出则强杀子进程。
const ctl = {
  state: 'idle', // idle | running | paused | done | aborted | failed
  child: null,
  pid: null,
  startedAt: null,
  agents: [],
  tasks: [],
  logTail: '',
  lastError: null,
  dir: null, // 本次评测结果目录名
}

function ctlWrite(cmd) {
  writeFileSync(controlFile, JSON.stringify({ cmd, by: 'dashboard', at: Date.now() }, null, 2))
}
function ctlClear() {
  try { rmSync(controlFile, { force: true }) } catch { /* 忽略 */ }
}
function ctlSnapshot() {
  return {
    state: ctl.state,
    pid: ctl.pid,
    startedAt: ctl.startedAt,
    agents: ctl.agents,
    tasks: ctl.tasks,
    dir: ctl.dir,
    logTail: ctl.logTail.slice(-4000),
    lastError: ctl.lastError,
  }
}

/** 启动评测子进程：node benchmark/run.mjs --agents ... --tasks ... --control-file ... */
function startRun({ agents: ags, tasks: tks }) {
  if (ctl.child) return { ok: false, error: `评测已在运行（PID ${ctl.pid}），先终止再开始` }
  const args = ['benchmark/run.mjs']
  if (ags && ags.length) args.push('--agents', ags.join(','))
  if (tks && tks.length) args.push('--tasks', tks.join(','))
  args.push('--control-file', controlFile)
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    windowsHide: true,
  })
  ctl.child = child
  ctl.pid = child.pid
  ctl.startedAt = Date.now()
  ctl.agents = ags || []
  ctl.tasks = tks || []
  ctl.state = 'running'
  ctl.lastError = null
  ctl.logTail = ''
  ctl.dir = null
  ctlWrite('resume') // 启动即放行
  // 捕获输出尾部（供前端日志面板）
  const cap = (chunk) => { ctl.logTail = (ctl.logTail + chunk).slice(-20000) }
  child.stdout?.on('data', cap)
  child.stderr?.on('data', cap)
  child.on('error', (e) => {
    ctl.lastError = e.message
    ctl.state = 'failed'
    ctl.child = null
    ctl.pid = null
  })
  child.on('exit', (code) => {
    const wasAborted = ctl.state === 'aborting'
    ctlClear()
    ctl.child = null
    ctl.pid = null
    ctl.state = wasAborted ? 'aborted' : (code === 0 ? 'done' : 'failed')
    if (code !== 0 && !wasAborted) ctl.lastError = ctl.lastError || `退出码 ${code}`
    // 识别本次结果目录（最新带 meta.json 的目录）
    try {
      const dirs = listDirs()
      if (dirs.length) ctl.dir = dirs[0]
    } catch { /* 忽略 */ }
  })
  return { ok: true, pid: child.pid }
}

/** 终止：先发 abort（run.mjs 任务边界退出并写部分 summary），超时强杀 */
function abortRun() {
  if (!ctl.child) return { ok: false, error: '没有运行中的评测' }
  ctl.state = 'aborting'
  ctlWrite('abort')
  const pid = ctl.pid
  // 兜底：10s 未退出则强杀（state 保持 aborting，由 exit 事件统一置为 aborted）
  const killer = setTimeout(() => {
    if (ctl.child && ctl.state === 'aborting') {
      try { ctl.child.kill('SIGKILL') } catch { /* 忽略 */ }
    }
  }, 10000)
  killer.unref()
  return { ok: true, pid }
}

// ── HTTP 服务 ────────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = url.pathname

  if (p === '/api/dirs') {
    return sendJson(res, 200, { dirs: listDirs(), current: dirArg || listDirs()[0] || null })
  }

  if (p === '/api/snapshot') {
    const dir = url.searchParams.get('dir') || dirArg || listDirs()[0]
    if (!dir || !existsSync(join(resultsRoot, dir))) return sendJson(res, 404, { error: `目录不存在: ${dir}` })
    try { return sendJson(res, 200, buildSnapshot(dir)) } catch (e) { return sendJson(res, 500, { error: String(e) }) }
  }

  if (p === '/api/result') {
    const dir = url.searchParams.get('dir') || dirArg
    const agent = url.searchParams.get('agent')
    const task = url.searchParams.get('task')
    if (!dir || !agent || !task) return sendJson(res, 400, { error: '需要 dir/agent/task 参数' })
    const base = join(resultsRoot, dir)
    const f = join(base, `${agent}-${task}.json`)
    if (!existsSync(f)) return sendJson(res, 404, { error: `结果不存在: ${agent}-${task}` })
    try { return sendJson(res, 200, JSON.parse(readFileSync(f, 'utf8'))) }
    catch (e) { return sendJson(res, 500, { error: String(e) }) }
  }

  if (p === '/') {
    return sendHtml(res, PAGE)
  }

  // ── 评测控制 API ──────────────────────────────────────────────────────────
  if (p === '/api/control/status') {
    return sendJson(res, 200, ctlSnapshot())
  }

  if (p === '/api/control/start') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '需要 POST' })
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let agents = [], tasks = []
      try {
        const b = JSON.parse(body || '{}')
        agents = (b.agents || []).filter(Boolean)
        tasks = (b.tasks || []).filter(Boolean)
      } catch { /* 默认全量 */ }
      const r = startRun({ agents, tasks })
      return sendJson(res, r.ok ? 200 : 409, r)
    })
    return
  }

  if (p === '/api/control/pause') {
    if (!ctl.child) return sendJson(res, 409, { ok: false, error: '没有运行中的评测' })
    if (ctl.state !== 'running') return sendJson(res, 409, { ok: false, error: `当前状态 ${ctl.state}，无法暂停` })
    ctlWrite('pause')
    ctl.state = 'paused'
    return sendJson(res, 200, { ok: true })
  }

  if (p === '/api/control/resume') {
    if (!ctl.child) return sendJson(res, 409, { ok: false, error: '没有运行中的评测' })
    if (ctl.state !== 'paused') return sendJson(res, 409, { ok: false, error: `当前状态 ${ctl.state}，无法继续` })
    ctlWrite('resume')
    ctl.state = 'running'
    return sendJson(res, 200, { ok: true })
  }

  if (p === '/api/control/abort') {
    const r = abortRun()
    return sendJson(res, r.ok ? 200 : 409, r)
  }

  if (p === '/api/meta') {
    // 可选 agent / 任务列表（控制面板选择用）
    const tasksDir = join(__dirname, 'tasks')
    let taskList = []
    try {
      taskList = readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, 'task.json'))).sort().map((d) => {
        try { return { id: JSON.parse(readFileSync(join(tasksDir, d, 'task.json'), 'utf8')).id } }
        catch { return { id: d } }
      })
    } catch { /* 忽略 */ }
    return sendJson(res, 200, {
      agents: ['yfw', 'claude', 'pi', 'deepseek'],
      tasks: taskList,
      control: ctlSnapshot(),
    })
  }

  sendJson(res, 404, { error: `未知路径: ${p}` })
})

// ── 前端页面（自包含，无 CDN，内联 CSS/JS + SVG 交互图表）───────────────────
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YFW-turbo 横向评估 Dashboard</title>
<style>
:root{--pass:#1a7f37;--fail:#c62828;--warn:#b26a00;--ink:#1a1a1a;--muted:#666;--line:#e5e7eb;--bg-card:#fff;--bg-soft:#f6f8fa;--blue:#2563eb}
*{box-sizing:border-box}
body{font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;background:#f0f2f5;color:var(--ink);margin:0;padding:20px}
.wrap{max-width:1280px;margin:0 auto}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px}
h1{font-size:20px;margin:0;flex:1}
select,button{font-size:13px;padding:5px 10px;border-radius:6px;border:1px solid var(--line);background:#fff}
button{cursor:pointer}
button:hover{background:var(--bg-soft)}
.live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.dot{width:9px;height:9px;border-radius:50%;background:#9ca3af}
.dot.on{background:#22c55e;animation:pulse 1.6s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}
.card{flex:1;min-width:150px;background:var(--bg-card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .label{font-size:12px;color:var(--muted)}
.card .num{font-size:26px;font-weight:800;margin:2px 0}
.card .sub{font-size:12px;color:var(--muted)}
.chart-box{background:var(--bg-card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
.chart-box h3{margin:0 0 8px;font-size:15px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:980px){.grid2{grid-template-columns:1fr}}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px;background:var(--bg-card);border-radius:8px;overflow:hidden}
th,td{border-bottom:1px solid var(--line);padding:7px 10px;text-align:left}
th{background:var(--bg-soft);font-weight:600;white-space:nowrap}
tr.pass td{background:#f2fbf4}tr.fail td{background:#fdf3f3}tr.workspace-error td{background:#fafafa}
.badge{display:inline-block;padding:1px 9px;border-radius:10px;font-size:11px;font-weight:700}
.badge.pass{background:#e3f5e8;color:var(--pass)}.badge.fail{background:#fde3e3;color:var(--fail)}.badge.other{background:#eee;color:var(--muted)}
.badge.run{background:#e0ecff;color:var(--blue);animation:pulse 1.6s infinite}
pre{background:#f8f8f8;padding:10px;border-radius:6px;overflow:auto;font-size:12px;max-height:280px}
#detail{position:fixed;right:0;top:0;bottom:0;width:min(560px,92vw);background:#fff;border-left:1px solid var(--line);box-shadow:-6px 0 24px rgba(0,0,0,.12);transform:translateX(105%);transition:transform .22s ease;overflow:auto;padding:18px;z-index:50}
#detail.open{transform:translateX(0)}
#detail .close{float:right;cursor:pointer;font-size:16px;border:none;background:none;color:var(--muted)}
.tooltip{position:fixed;pointer-events:none;background:rgba(20,20,20,.92);color:#fff;font-size:12px;padding:6px 10px;border-radius:6px;z-index:99;display:none;white-space:pre}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0;font-size:13px}
.filters label{cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.row-link{cursor:pointer}
.row-link:hover td{background:#eef3ff}
.ctl-btn{padding:6px 16px;border-radius:6px;border:1px solid var(--line);cursor:pointer;font-size:13px;background:#fff}
.ctl-btn:hover:not(:disabled){background:var(--bg-soft)}
.ctl-btn:disabled{opacity:.45;cursor:not-allowed}
.ctl-btn.danger{color:#c62828;border-color:#f0c4c4}
.ctl-btn.danger:hover:not(:disabled){background:#fdecec}
.ctl-state{font-weight:700;font-size:13px;margin-left:10px;padding:3px 10px;border-radius:12px;background:var(--bg-soft)}
.ctl-state.running{background:#e0ecff;color:var(--blue)}
.ctl-state.paused{background:#fdf3e3;color:#b26a00}
.ctl-state.done{background:#e3f5e8;color:var(--pass)}
.ctl-state.aborted,.ctl-state.failed{background:#fde3e3;color:var(--fail)}
.ctl-log{margin-top:8px}
.ctl-log pre{max-height:180px;font-size:11px}
footer{color:var(--muted);font-size:12px;margin-top:22px;text-align:center}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body><div class="wrap">
<header>
  <h1>YFW-turbo 内核横向评估 Dashboard</h1>
  <span class="live"><span class="dot" id="liveDot"></span><span id="liveText">连接中…</span></span>
  <select id="dirSel" title="切换历史结果目录"></select>
  <button id="refreshBtn">刷新</button>
</header>

<div class="chart-box" id="controlBox">
  <h3>评测控制台</h3>
  <div class="filters">
    <b>被测内核：</b><span id="agentSel"></span>
    <b style="margin-left:14px">测试科目：</b><span id="taskSel"></span>
  </div>
  <div class="filters">
    <button id="btnStart" class="ctl-btn">▶ 开始评测</button>
    <button id="btnPause" class="ctl-btn" disabled>⏸ 暂停</button>
    <button id="btnResume" class="ctl-btn" disabled>▶ 继续</button>
    <button id="btnAbort" class="ctl-btn danger" disabled>⏹ 终止</button>
    <span class="ctl-state" id="ctlState">空闲</span>
  </div>
  <div class="ctl-log" id="ctlLog" style="display:none"><pre id="ctlLogPre"></pre></div>
</div>

<div class="cards" id="overview"></div>
<div class="chart-box"><h3>综合评分排行（点击 agent 高亮）</h3><div id="scoreCards"></div></div>
<div class="grid2">
  <div class="chart-box"><h3>四维能力对比（雷达图，hover 查看数值）</h3><svg id="radar" width="560" height="320"></svg></div>
  <div class="chart-box"><h3>各任务耗时（柱状图，hover 详情 / 点击筛选）</h3><svg id="durChart" width="560" height="320"></svg></div>
</div>
<div class="chart-box"><h3>任务完成矩阵（点击行看详情）</h3>
  <div class="filters" id="filters"></div>
  <table id="matrix"></table>
</div>

<div id="detail"><button class="close" onclick="closeDetail()">✕</button><div id="detailBody"></div></div>
<footer>YFW-turbo 横向评估平台 · 实时刷新 · 失败案例比成功案例更有价值</footer>
</div>

<div class="tooltip" id="tip"></div>
<script>
const COLORS = ['#2563eb','#7c3aed','#059669','#d97706','#dc2626','#0891b2'];
const $ = (s) => document.querySelector(s);
let DATA = null, selAgent = null, selTask = null, selDir = null;
let pollTimer = null, POLL_MS = 3000;

// ── 数据拉取 ────────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
  return r.json();
}
async function loadDirs() {
  const { dirs, current } = await fetchJSON('/api/dirs');
  const sel = $('#dirSel');
  sel.innerHTML = dirs.map((d) => '<option' + (d === (selDir || current) ? ' selected' : '') + '>' + d + '</option>').join('');
  if (!selDir) selDir = current;
}
async function poll() {
  try {
    const dir = selDir || $('#dirSel').value;
    const snap = await fetchJSON('/api/snapshot?dir=' + encodeURIComponent(dir));
    DATA = snap; selDir = dir;
    $('#dirSel').value = dir;
    $('#liveDot').classList.add('on');
    $('#liveText').textContent = snap.active
      ? '评测中：' + snap.active.agent + ' × ' + snap.active.task + '（已 ' + fmtDur(Date.now() - snap.active.since) + '）'
      : snap.todo.length
        ? '等待中 ' + snap.todo.length + ' 个任务' + (snap.active ? '' : '（无进行中心跳）')
        : '评测完成';
    render();
  } catch (e) {
    $('#liveDot').classList.remove('on');
    $('#liveText').textContent = '连接失败: ' + e.message;
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────
const fmtDur = (ms) => { if (!ms && ms !== 0) return '—'; const s = Math.round(ms / 1000); if (s >= 60) return (s / 60).toFixed(1) + 'm'; return s + 's'; };
const fmtCost = (c) => (c == null ? '—' : '$' + c.toFixed(4));
const okBadge = (st) => '<span class="badge ' + (st === 'pass' ? 'pass' : st === 'fail' ? 'fail' : 'other') + '">' + st + '</span>';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rowOf = (a, t) => DATA.rows.find((r) => r.agent === a && r.task === t);

// ── 渲染 ────────────────────────────────────────────────────────────────────
function render() {
  renderOverview();
  renderScores();
  renderRadar();
  renderDurChart();
  renderFilters();
  renderMatrix();
}

function renderOverview() {
  const a = DATA.agents;
  const pass = DATA.totalPass, total = DATA.total;
  const avgMs = total ? DATA.rows.reduce((s, r) => s + r.durationMs, 0) / total : 0;
  const self = total ? DATA.rows.filter((r) => r.selfTested).length / total : 0;
  $('#overview').innerHTML = [
    card('总通过率', pass + '/' + total, (total ? (pass / total * 100).toFixed(0) : 0) + '% 全部任务'),
    card('任务总数', DATA.taskIds.length, a.length + ' 个被测对象'),
    card('平均耗时', fmtDur(avgMs), '每 (agent×task)'),
    card('自测率', (self * 100).toFixed(0) + '%', '主动运行测试/verify'),
  ].join('');
  function card(label, num, sub) { return '<div class="card"><div class="label">' + label + '</div><div class="num">' + num + '</div><div class="sub">' + sub + '</div></div>'; }
}

function renderScores() {
  const list = DATA.agents.map((a) => [a, DATA.scores[a]]).filter(([, s]) => s).sort((x, y) => y[1].total - x[1].total);
  $('#scoreCards').innerHTML = '<div class="cards">' + list.map(([a, s], i) => {
    const rank = ['🥇','🥈','🥉'][s.rank - 1] || '';
    const hl = selAgent === a ? ' style="outline:2px solid var(--blue);cursor:pointer"' : ' style="cursor:pointer"';
    return '<div class="card" onclick="toggleAgent(\\'' + a + '\\')"' + hl + '><div class="label">' + esc(a) + ' ' + rank + '</div><div class="num">' + s.total + '</div><div class="sub">完成率 ' + (s.passRate * 100).toFixed(0) + '% · 效率 ' + s.effScore + ' · 自测 ' + (s.selfTestRate * 100).toFixed(0) + '% · 聚焦 ' + (s.focusRate * 100).toFixed(0) + '%</div></div>';
  }).join('') + '</div>';
}

function renderRadar() {
  const svg = $('#radar'), W = svg.clientWidth || 560, H = 320;
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  const cx = W / 2, cy = H / 2 + 8, R = Math.min(W, H) / 2 - 58;
  const dims = [ { k: 'passRate', label: '完成率', mx: 1 }, { k: 'effScore', label: '探索效率', mx: 100 }, { k: 'selfTestRate', label: '验证能力', mx: 1 }, { k: 'focusRate', label: '改动质量', mx: 1 } ];
  const pt = (v, i, rr) => { const ang = -Math.PI / 2 + i / dims.length * 2 * Math.PI; return [cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)]; };
  let h = '<rect width="' + W + '" height="' + H + '" fill="transparent"/>';
  // 网格环
  for (let ring = 1; ring <= 4; ring++) {
    const pts = dims.map((_, i) => pt(1, i, R * ring / 4).join(',')).join(' ');
    h += '<polygon points="' + pts + '" fill="none" stroke="#e5e7eb" stroke-width="1"/>';
  }
  dims.forEach((d, i) => { const [x, y] = pt(1, i, R + 20); h += '<text x="' + x + '" y="' + (y + 4) + '" text-anchor="middle" font-size="12" fill="#666">' + d.label + '</text>'; });
  // agent 多边形（hover 高亮 + tooltip）
  DATA.agents.forEach((a, ai) => {
    const s = DATA.scores[a]; if (!s) return;
    const pts = dims.map((d, i) => { const v = (s[d.k] ?? 0) / d.mx; return pt(v, i, Math.max(4, R * Math.min(1, v))).join(','); }).join(' ');
    const col = COLORS[ai % COLORS.length];
    const extra = selAgent === a ? ' stroke-width="3.5"' : ' stroke-width="2"';
    h += '<polygon points="' + pts + '" fill="' + col + '33" stroke="' + col + '"' + extra + ' opacity="' + (selAgent && selAgent !== a ? '.35' : '1') + '" style="cursor:pointer" onclick="toggleAgent(\\'' + a + '\\')" onmousemove="tip(event, \\'' + esc(a) + '\\n总分 ' + s.total + '\\n完成率 ' + (s.passRate * 100).toFixed(0) + '%\\n效率 ' + s.effScore + '\\n自测 ' + (s.selfTestRate * 100).toFixed(0) + '%\\n聚焦 ' + (s.focusRate * 100).toFixed(0) + '%\\')" onmouseleave="tipHide()"/>';
  });
  // 图例
  DATA.agents.forEach((a, ai) => {
    const s = DATA.scores[a]; if (!s) return;
    const x = 10, y = 18 + ai * 18;
    h += '<rect x="' + x + '" y="' + (y - 10) + '" width="12" height="12" fill="' + COLORS[ai % COLORS.length] + '" rx="2"/>';
    h += '<text x="' + (x + 17) + '" y="' + y + '" font-size="12" fill="#333">' + esc(a) + '（' + s.total + '分）</text>';
  });
  svg.innerHTML = h;
}

function renderDurChart() {
  const svg = $('#durChart'), W = svg.clientWidth || 560, H = 320;
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  const padL = 56, padR = 16, padT = 30, padB = 44;
  const maxV = Math.max(...DATA.rows.map((r) => r.durationMs || 0), 60000);
  const n = DATA.taskIds.length, g = DATA.agents.length;
  const bw = Math.min(40, (W - padL - padR) / n / g * 0.72);
  let h = '<rect width="' + W + '" height="' + H + '" fill="transparent"/>';
  // y 刻度
  for (let i = 0; i <= 4; i++) {
    const v = maxV * i / 4, y = H - padB - (H - padT - padB) * i / 4;
    h += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#eee"/>';
    h += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="#666">' + fmtDur(v) + '</text>';
  }
  DATA.taskIds.forEach((t, ti) => {
    const x0 = padL + (W - padL - padR) / n * ti + (W - padL - padR) / n * 0.5 - g * bw / 2;
    DATA.agents.forEach((a, ai) => {
      const r = rowOf(a, t);
      const d = r ? r.durationMs : 0;
      const hgt = (H - padT - padB) * Math.min(1, d / maxV);
      const x = x0 + ai * bw, y = H - padB - hgt;
      const col = COLORS[ai % COLORS.length];
      const dim = selTask && selTask !== t ? ' opacity=".3"' : '';
      h += '<rect x="' + x + '" y="' + y + '" width="' + Math.max(1, bw - 3) + '" height="' + Math.max(1, hgt) + '" fill="' + (r ? col + 'cc' : col + '22') + '" rx="2"' + dim + ' style="cursor:pointer" onclick="toggleTask(\\'' + t + '\\')" onmousemove="tip(event, \\'' + esc(t) + ' — ' + esc(a) + '\\n' + (r ? (r.status === 'pass' ? '通过' : r.status === 'fail' ? '失败' : r.status) + ' · ' + fmtDur(d) + (r.toolCalls ? ' · ' + r.toolCalls + ' 次工具' : '') : '未运行') + '\\')" onmouseleave="tipHide()"/>';
      if (d > 0) h += '<text x="' + (x + (bw - 3) / 2) + '" y="' + (y - 4) + '" text-anchor="middle" font-size="9" fill="#666">' + fmtDur(d) + '</text>';
    });
    h += '<text x="' + (x0 + g * bw / 2) + '" y="' + (H - 12) + '" text-anchor="middle" font-size="11" fill="#333" style="cursor:pointer" onclick="toggleTask(\\'' + t + '\\')">' + t.replace(/-.*/, '') + '</text>';
  });
  DATA.agents.forEach((a, ai) => {
    const x = padL + ai * 86, y = 13;
    h += '<rect x="' + x + '" y="' + (y - 8) + '" width="10" height="10" fill="' + COLORS[ai % COLORS.length] + '" rx="2"/>';
    h += '<text x="' + (x + 14) + '" y="' + y + '" font-size="11" fill="#333">' + esc(a) + '</text>';
  });
  svg.innerHTML = h;
}

function renderFilters() {
  const f = $('#filters');
  const agChips = DATA.agents.map((a) => '<label><input type="checkbox" ' + (selAgent === null || selAgent === a ? 'checked' : '') + ' onchange="agentFilter(\\'' + a + '\\', this.checked)"> ' + esc(a) + '</label>').join('');
  const tkChips = DATA.taskIds.map((t) => '<label><input type="checkbox" ' + (selTask === null || selTask === t ? 'checked' : '') + ' onchange="taskFilter(\\'' + t + '\\', this.checked)"> ' + esc(t).replace(/-.*/, '') + '</label>').join('');
  f.innerHTML = '<b>筛选：</b>' + agChips + tkChips;
}

function renderMatrix() {
  const tbl = $('#matrix');
  const ags = DATA.agents.filter((a) => selAgent === null || selAgent === a);
  const tks = DATA.taskIds.filter((t) => selTask === null || selTask === t);
  let h = '<tr><th>任务</th>' + ags.map((a) => '<th class="num">' + esc(a) + '</th>').join('') + '<th>状态</th><th>耗时</th><th>工具</th><th>成本</th><th>自测</th></tr>';
  for (const t of tks) {
    h += '<tr><td><b>' + esc(t) + '</b></td>';
    for (const a of ags) {
      const r = rowOf(a, t);
      const cell = r
        ? '<span class="badge ' + (r.status === 'pass' ? 'pass' : r.status === 'fail' ? 'fail' : 'other') + '">' + r.status + '</span>'
        : '<span class="badge other">—</span>';
      h += '<td class="num row-link" onclick="openDetail(\\'' + a + '\\',\\'' + t + '\\')" title="点击查看详情">' + cell + '</td>';
    }
    // 汇总列
    const rs = ags.map((a) => rowOf(a, t)).filter(Boolean);
    const passN = rs.filter((r) => r.status === 'pass').length;
    h += '<td>' + passN + '/' + rs.length + '</td>';
    h += '<td class="num">' + (rs.length ? fmtDur(rs.reduce((s, r) => s + r.durationMs, 0) / rs.length) : '—') + '</td>';
    h += '<td class="num">' + (rs.length ? (rs.reduce((s, r) => s + (r.toolCalls || 0), 0) / rs.length).toFixed(1) : '—') + '</td>';
    h += '<td class="num">' + (rs.some((r) => r.cost != null) ? '$' + rs.reduce((s, r) => s + (r.cost || 0), 0).toFixed(4) : '—') + '</td>';
    h += '<td class="num">' + rs.filter((r) => r.selfTested).length + '/' + rs.length + '</td>';
    h += '</tr>';
  }
  tbl.innerHTML = h;
}

// ── 交互 ────────────────────────────────────────────────────────────────────
function toggleAgent(a) { selAgent = selAgent === a ? null : a; render(); }
function toggleTask(t) { selTask = selTask === t ? null : t; render(); }
function agentFilter(a, on) {
  // 单选高亮简化：直接切换 selAgent
  selAgent = selAgent === a ? null : a;
  // 同步 checkbox 状态
  renderFilters(); renderMatrix();
}
function taskFilter(t, on) {
  selTask = selTask === t ? null : t;
  renderFilters(); renderMatrix();
}
function tip(ev, text) {
  const t = $('#tip');
  t.textContent = text;
  t.style.display = 'block';
  t.style.left = (ev.clientX + 14) + 'px';
  t.style.top = (ev.clientY + 14) + 'px';
}
function tipHide() { $('#tip').style.display = 'none'; }
async function openDetail(agent, task) {
  try {
    const r = await fetchJSON('/api/result?dir=' + encodeURIComponent(selDir) + '&agent=' + agent + '&task=' + task);
    const ns = (r.diff?.nameStatus || '').split('\\n').filter(Boolean).map((l) => l.split('\\t').pop() || l.split(/\\s+/)[1] || '');
    $('#detailBody').innerHTML =
      '<h2 style="margin-top:0">' + esc(agent) + ' × ' + esc(task) + '</h2>' +
      '<p>' + okBadge(r.status) + (r.timedOut ? ' <b>（超时）</b>' : '') + ' · 耗时 ' + fmtDur(r.durationMs) + ' · 退出码 ' + (r.exitCode ?? '—') +
      ' · 工具调用 ' + (r.toolCalls ?? '—') + ' · 成本 ' + fmtCost(r.cost) + ' · ' + (r.selfTested ? '主动自测 ✅' : '未自测') + '</p>' +
      (r.basePatched ? '<p style="font-size:12px;color:var(--muted)">base 补丁已应用：' + esc(JSON.stringify(r.basePatched)) + '</p>' : '') +
      (ns.length ? '<p style="font-size:12px"><b>改动文件：</b>' + esc(ns.join(', ')) + '</p>' : '') +
      (r.verify?.stdout ? '<h4>验收输出</h4><pre>' + esc(r.verify.stdout) + '</pre>' : '') +
      (r.verify?.stderr ? '<h4>验收错误</h4><pre>' + esc(r.verify.stderr) + '</pre>' : '') +
      (r.diff?.stat ? '<h4>改动统计</h4><pre>' + esc(r.diff.stat) + '</pre>' : '') +
      (r.stderrTail ? '<h4>agent stderr 尾部</h4><pre>' + esc(r.stderrTail) + '</pre>' : '') +
      (r.stdoutTail ? '<h4>agent stdout 尾部</h4><pre>' + esc(r.stdoutTail) + '</pre>' : '') +
      (r.log ? '<h4>运行日志</h4><pre>' + esc(r.log) + '</pre>' : '');
    $('#detail').classList.add('open');
  } catch (e) { alert('加载详情失败: ' + e.message); }
}
function closeDetail() { $('#detail').classList.remove('open'); }

// ── 评测控制台 ───────────────────────────────────────────────────────────────
const META_AGENTS = ['yfw', 'claude', 'pi', 'deepseek'];
const META_TASKS = ['T001','T002','T003','T004','T005','T006'];
let ctlSelAgents = new Set(META_AGENTS);
let ctlSelTasks = new Set(META_TASKS);
let CTRL = { state: 'idle' };

async function loadMeta() {
  try {
    const m = await fetchJSON('/api/meta');
    if (m.agents?.length) META_AGENTS.splice(0, META_AGENTS.length, ...m.agents);
    if (m.tasks?.length) META_TASKS.splice(0, META_TASKS.length, ...m.tasks.map((t) => t.id));
    ctlSelAgents = new Set(META_AGENTS);
    ctlSelTasks = new Set(META_TASKS);
    CTRL = m.control || CTRL;
  } catch (e) { /* 保持默认 */ }
  renderControl();
}

function renderControl() {
  $('#agentSel').innerHTML = META_AGENTS.map((a) =>
    '<label><input type="checkbox" ' + (ctlSelAgents.has(a) ? 'checked' : '') + ' onchange="toggleCtl(\\'agent\\',\\'' + a + '\\',this.checked)"> ' + esc(a) + '</label>').join('');
  $('#taskSel').innerHTML = META_TASKS.map((t) =>
    '<label><input type="checkbox" ' + (ctlSelTasks.has(t) ? 'checked' : '') + ' onchange="toggleCtl(\\'task\\',\\'' + t + '\\',this.checked)"> ' + esc(t).replace(/-.*/, '') + '</label>').join('');
  const s = CTRL.state;
  const running = s === 'running' || s === 'aborting';
  $('#btnStart').disabled = running;
  $('#btnPause').disabled = !running || s === 'aborting';
  $('#btnResume').disabled = s !== 'paused';
  $('#btnAbort').disabled = !(running || s === 'paused');
  const st = $('#ctlState');
  st.textContent = s === 'running' ? '运行中' + (CTRL.pid ? '（PID ' + CTRL.pid + '）' : '') : s === 'paused' ? '已暂停' : s === 'done' ? '已完成' : s === 'aborted' ? '已终止' : s === 'failed' ? '异常退出' : '空闲';
  st.className = 'ctl-state ' + (s === 'running' ? 'running' : s === 'paused' ? 'paused' : s === 'done' ? 'done' : (s === 'aborted' || s === 'failed') ? 'aborted' : '');
  const log = CTRL.logTail;
  if (log && s !== 'idle') {
    $('#ctlLog').style.display = 'block';
    const pre = $('#ctlLogPre');
    pre.textContent = log;
    pre.scrollTop = pre.scrollHeight;
  } else {
    $('#ctlLog').style.display = 'none';
  }
}

function toggleCtl(kind, val, on) {
  if (kind === 'agent') { on ? ctlSelAgents.add(val) : ctlSelAgents.delete(val); }
  else { on ? ctlSelTasks.add(val) : ctlSelTasks.delete(val); }
  renderControl();
}

async function pollControl() {
  try {
    const c = await fetchJSON('/api/control/status');
    if (c.state !== 'idle') { CTRL = c; renderControl(); }
  } catch (e) { /* 服务未起控制模块时忽略 */ }
}

async function ctlAction(action) {
  try {
    const body = action === 'start'
      ? JSON.stringify({ agents: [...ctlSelAgents], tasks: [...ctlSelTasks] })
      : null;
    const r = await fetch('/api/control/' + action, {
      method: action === 'start' || action === 'pause' || action === 'resume' || action === 'abort' ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const j = await r.json();
    if (!r.ok) { alert('操作失败: ' + (j.error || r.statusText)); return; }
    CTRL = { ...CTRL, state: action === 'start' ? 'running' : action === 'pause' ? 'paused' : action === 'resume' ? 'running' : action === 'abort' ? 'aborting' : CTRL.state, pid: j.pid || CTRL.pid };
    if (action === 'start') {
      setTimeout(async () => { selDir = null; try { await loadDirs(); } catch (e) {} }, 1200);
    }
    renderControl();
    pollControl();
  } catch (e) { alert('请求失败: ' + e.message); }
}

$('#btnStart').addEventListener('click', () => ctlAction('start'));
$('#btnPause').addEventListener('click', () => ctlAction('pause'));
$('#btnResume').addEventListener('click', () => ctlAction('resume'));
$('#btnAbort').addEventListener('click', () => ctlAction('abort'));

// ── 启动 ────────────────────────────────────────────────────────────────────
$('#dirSel').addEventListener('change', () => { selDir = $('#dirSel').value; poll(); });
$('#refreshBtn').addEventListener('click', poll);
async function boot() {
  await loadMeta();
  try { await loadDirs(); } catch (e) { $('#liveText').textContent = '目录加载失败: ' + e.message; }
  await poll();
  pollTimer = setInterval(poll, POLL_MS);
  setInterval(pollControl, 2000);
}
boot();
</script></body></html>`

server.listen(port, () => {
  const dirs = listDirs()
  console.log(`YFW-turbo Dashboard: http://localhost:${port}`)
  console.log(`结果目录 ${resultsRoot}`)
  console.log(dirs.length ? `最近一次评测：${dirs[0]}` : '（暂无评测结果，跑 node benchmark/run.mjs 后自动出现）')
  console.log('按 Ctrl+C 停止')
  if (autoOpen) {
    // 自动打开浏览器（跨平台）
    try {
      const url = `http://localhost:${port}`
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
      } else {
        spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
      }
    } catch { /* 打不开也不影响服务 */ }
  }
})
