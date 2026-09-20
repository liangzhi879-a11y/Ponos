// kit/lib/gui-html.mjs —— 把 GUI 数据包渲染成**自包含单文件 HTML**
//
// 五条硬约束（每条都有机械校验，见 kit/lib/gui-html.test.mjs）：
//   1. **零外链**：不引任何 http(s) 资源、不引本地文件、不 fetch —— 生成物要能在**断网的机器上
//      `file://` 双击打开**。CSS 与 JS 全部内联（一个 `<style>` + 一个 `<script>`），
//      唯一的"外链形态"是页内锚点 `href="#id"`（不做机械校验的话，`<link>` 一个字体就能让
//      "离线可看"这条承诺失效，而失效时页面只是变丑、没人会发现）。
//   2. **数据内联成 JSON 脚本块**：`<script type="application/json" id="kit-data">`，
//      前端 `JSON.parse(getElementById('kit-data').textContent)`。★ 必须转义 `</`（否则数据里一旦
//      出现 `</script>` 就会**截断脚本块**，页面白屏且原因极难定位）与 U+2028/2029（JS 里的非法换行）。
//   3. **无 JS 也能看**：表格默认**全量渲染**，筛选是渐进增强（`<noscript>` 里明说"筛选不可用"）。
//      为什么这点重要：这是**门禁报告**，它最需要被看到的时候，恰恰可能是"页面里某个脚本出错"的时候。
//   4. **浅色/深色都可用**：只用 `prefers-color-scheme`（不引任何主题系统 —— 应用主题属于 src/，
//      GUI 与应用界面**零挂钩**是本任务的前提）。
//   5. **只读展示**：页面没有任何写操作（无按钮会改数据、不写 git）。`navigator.clipboard` 只用于
//      复制命令文本，且**不可用时静默降级**（选中文本让用户自己 Ctrl+C），绝不因剪贴板不可用而报错。
import { AGENT_GUIDE } from './agent-guide.mjs'

/** 八个视图（顺序即导航顺序；id 同时是锚点） */
export const GUI_SECTIONS = [
  { id: 'overview', title: '概览' },
  { id: 'findings', title: '红灯与黄灯' },
  { id: 'rules', title: '规则矩阵' },
  { id: 'ledgers', title: '台账' },
  { id: 'deps', title: '依赖域' },
  { id: 'version', title: '版本控制' },
  { id: 'brand', title: '品牌标识与名称' },
  { id: 'agent', title: 'Agent 套件规范' },
]

/** 黄灯类规则（只报不拦）—— ★ 不再在这里硬编码名单：由 `gui-data.mjs` 从真源
 *  `report.mjs#NON_BLOCKING_RULES` 读进 `checks[].nonBlocking`（此前正是这里硬编码
 *  `['CT8','CT9']`，把同样只发黄灯的 `P5`/`P6` 漏标成了「阻断」）。 */

const SEVERITY_LABEL = { red: '红（阻断）', yellow: '黄（提示）', baselined: '基线（已知欠账）' }

/** HTML 文本转义（**所有**插值都过这里：数据来自仓库文件，含引号/尖括号是常态） */
function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/** 空值显示 `—`（页面上一排空格比一个显式的破折号难读得多） */
function orDash(v) {
  return v === null || v === undefined || v === '' ? '—' : v
}

/** `file:line` 展示 */
function loc(file, line) {
  if (!file) return '—'
  return line ? `${file}:${line}` : String(file)
}

/** 表格包装：横向滚动容器（宽表不破版）；`id` 给前端筛选脚本定位用 */
function table(head, rows, cls = '', id = '') {
  return `<div class="scroll"><table class="${cls}"${id ? ` id="${id}"` : ''}><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.join('')}</tbody></table></div>`
}

/** 复制按钮（`data-copy` 走属性转义；点击逻辑见文末内联脚本，剪贴板不可用时静默降级） */
function copyBtn(text) {
  return `<button class="copy" type="button" data-copy="${esc(text)}">复制</button>`
}

/** 一行「键: 值」的卡片格 */
function stat(label, value, note = '') {
  return `<div class="stat"><div class="stat-k">${esc(label)}</div><div class="stat-v">${esc(orDash(value))}</div>`
    + (note ? `<div class="stat-n">${esc(note)}</div>` : '') + '</div>'
}

/**
 * 数据内联：把 JSON 文本变成**安全嵌在 `<script>` 里**的文本。
 * 三处转义各有原因（都是"页面白屏但控制台只有一行 SyntaxError"的经典成因）：
 *   · `</` → `<\/`：否则数据里出现 `</script>` 会提前结束脚本块（JSON 允许 `\/`，解析后值不变）；
 *   · `://` → `:\/\/`：让产物里**不存在** `http://` / `https://` 字面量 —— 于是"零外链"这条
 *     可以用一条正则机械校验（同一条校验也挡住真正的 `<link>`/`<script src>` 回归）；
 *   · U+2028 / U+2029：JSON 允许、JavaScript 源码里是**换行符** ⇒ 不转义会直接语法错误。
 */
export function inlineJsonText(data) {
  return JSON.stringify(data)
    .replace(/<\//g, '<\\/')
    .replace(/:\/\//g, ':\\/\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

// ── 各段渲染 ─────────────────────────────────────────────────────────────────

function renderOverview(d) {
  const g = d.gate
  const ch = d.versions?.channels
  const scope = d.scope
  const cards = [
    `<div class="card ${g.ok ? 'ok' : 'bad'}">`,
    `<div class="card-h">门禁结论</div>`,
    `<div class="card-big">${g.ok ? '✅ 通过' : '❌ 未通过'}　EXIT=${esc(g.exitCode)}</div>`,
    '<div class="statrow">',
    stat('红（阻断）', g.summary.red), stat('黄（只报不拦）', g.summary.yellow),
    stat('基线（已知欠账）', g.summary.baselined), stat('green 规则数', g.summary.green), stat('规则总数', g.summary.rules),
    '</div>',
    `<div class="note">数据来自 <code>node kit/cli.mjs check --json</code> 的公开 JSON 出口（★ 被拦时退出码为 1 但仍打印完整 JSON）。`
    + `本页是**报告**工具：门禁红时它照样生成，红 0 与否不改变生成结果。</div>`,
    '</div>',
  ]
  const numbers = [
    ['routes（方法+路径键）', ch ? ch.routes : null, ''],
    ['routePrefixes', ch ? ch.routePrefixes : null, ''],
    ['wsOut（bridge → GUI）', ch ? ch.wsOut : null, ''],
    ['wsIn（GUI → bridge）', ch ? ch.wsIn : null, ''],
    ['ipc（各侧计数之和）', ch ? ch.ipc.total : null, ch ? `invoke ${ch.ipc.invoke} / handle ${ch.ipc.handle} / send ${ch.ipc.send} / on ${ch.ipc.on} / push ${ch.ipc.push}` : ''],
    ['tools（指纹条数）', ch ? ch.tools : null, ch && ch.staticToolCount !== null ? `静态 registry ${ch.staticToolCount}` : ''],
    ['scope（范围登记）', scope ? `${scope.total} 组 / ${scope.keys} 键` : null, scope?.present === false ? '登记文件不存在' : ''],
    ['build 时间（本页生成）', d.generatedAt, ''],
    ['快照 snapshotAt（committed 口径）', ch ? ch.snapshotAt : null, ''],
  ]
  const warnBox = d.warnings?.length
    ? `<div class="card warn"><div class="card-h">取数警告（${d.warnings.length}）</div><ul class="tight">${d.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : '<div class="card"><div class="card-h">取数警告</div><div class="note">无 —— 台账、git 段与品牌探针全部取到值。</div></div>'
  return `<div class="grid2">${cards.join('')}</div>`
    + `<div class="card"><div class="card-h">关键数字（契约面与台账规模）</div><div class="statrow">${numbers.map(([k, v, n]) => stat(k, v, n)).join('')}</div>`
    + `<div class="note">明细不在这里：<code>routes</code> 103 条、<code>commonTools</code> 98 条明细刻意<b>不内联</b>`
    + `（否则页面巨大且无人读）；要逐条看请跑 <code>npm run kit:view</code> 或直接读台账文件 —— 它们才是明细的单一真源。</div></div>`
    + warnBox
}

function renderFindings(d) {
  const rows = d.findings.map((f) => {
    const sev = f.severity || 'yellow'
    return `<tr class="sev-${esc(sev)}" data-rule="${esc(f.rule || '')}" data-sev="${esc(sev)}">`
      + `<td class="mono">${esc(orDash(f.rule))}</td>`
      + `<td>${esc(SEVERITY_LABEL[sev] || sev)}${f.baselinedFrom ? `　<span class="tag">原为${esc(SEVERITY_LABEL[f.baselinedFrom] || f.baselinedFrom)}</span>` : ''}</td>`
      + `<td class="mono">${esc(orDash(f.subject))}</td>`
      + `<td class="mono">${esc(loc(f.file, f.line))}</td>`
      + `<td class="mono">${esc(orDash(f.expected))}</td>`
      + `<td class="mono">${esc(orDash(f.actual))}</td>`
      + `<td>${esc(orDash(f.hint))}${f.message ? `<div class="note">${esc(f.message)}</div>` : ''}</td>`
      + `<td>${f.baselinedFrom ? esc(orDash(f.reason)) : '—'}</td>`
      + '</tr>'
  })
  const head = ['rule', 'severity', 'subject', 'file:line', 'expected', 'actual', 'hint', 'baselinedFrom（基线理由）']
  const rules = [...new Set(d.findings.map((f) => f.rule).filter(Boolean))].sort()
  const sevs = [...new Set(d.findings.map((f) => f.severity).filter(Boolean))]
  // 筛选控件默认"全选"（= 初始状态与无 JS 时一致）；选了才缩小范围 ⇒ 渐进增强
  const sevBoxes = ['red', 'yellow', 'baselined'].map((s) => {
    const n = d.findings.filter((f) => f.severity === s).length
    return `<label class="chk"><input type="checkbox" class="f-sev" value="${esc(s)}" checked> ${esc(SEVERITY_LABEL[s])}（${n}）</label>`
  }).join('')
  const ruleBoxes = rules.map((r) => {
    const n = d.findings.filter((f) => f.rule === r).length
    return `<label class="chk"><input type="checkbox" class="f-rule" value="${esc(r)}" checked> ${esc(r)}（${n}）</label>`
  }).join('')
  return `<div class="card"><div class="card-h">门禁结论：红 ${esc(d.gate.summary.red)} / 黄 ${esc(d.gate.summary.yellow)} / 基线 ${esc(d.gate.summary.baselined)}（EXIT=${esc(d.gate.exitCode)}）</div>`
    + `<div class="note">筛选是<b>渐进增强</b>：无 JS 时下表为全量；勾选框初始全选（页面加载后点选即可缩小范围）。`
    + `黄灯（<code>CT8</code> 在途差异 / <code>CT9</code> 历史欠账）<b>只报不拦</b>。</div>`
    + `<div class="filters" data-total="${d.findings.length}">`
    + `<div class="fgroup"><span class="flabel">severity</span>${sevBoxes}</div>`
    + `<div class="fgroup"><span class="flabel">rule</span>${ruleBoxes || '<span class="note">（本次无 finding）</span>'}</div>`
    + `<button id="f-all" type="button">全选</button><button id="f-none" type="button">全不选</button>`
    + `<span id="f-count" class="note"></span></div></div>`
    + table(head, rows.length ? rows : [`<tr><td colspan="${head.length}" class="note">findings 为空 —— 本次门禁没有任何红/黄/基线条目。</td></tr>`], 'tbl', 'findings-table')
    + `<div class="note">共 ${d.findings.length} 条（severity 取值：${sevs.map((s) => esc(s)).join(' / ') || '—'}）。</div>`
}

function renderRules(d) {
  const rows = d.gate.checks.map((c) => {
    const nb = c.nonBlocking === true
    return `<tr><td class="mono">${esc(orDash(c.rule))}</td><td>${esc(orDash(c.title))}</td>`
      + `<td class="num">${esc(c.evaluated)}</td>`
      + `<td>${c.passed ? '✔ 通过' : (nb ? '✘ 有待办（只报不拦）' : '✘ 未通过（红）')}</td>`
      + `<td>${nb ? '<span class="tag warn">只报不拦</span>' : '<span class="tag">阻断</span>'}</td></tr>`
  })
  const nonBlocking = d.gate.checks.filter((c) => c.nonBlocking === true).map((c) => c.rule)
  return `<div class="card"><div class="card-h">${esc(d.gate.checks.length)} 条规则；green ${esc(d.gate.summary.green)} / 规则数 ${esc(d.gate.summary.rules)}</div>`
    + `<div class="note">口径：<code>evaluated</code> 是"这条规则判了多少条"（各侧独立计数之和，例如 CT5 的 156 = invoke 61 + handle 61 + send 10 + on 17 + push 7）。`
    + `标「只报不拦」的规则 <code>${nonBlocking.map((r) => esc(r)).join(' / ') || '—'}</code>：它们 <code>passed=false</code> 表示"确实有东西"，但<b>不影响退出码</b>。`
    + `★ 完整判据与默认动作在 <code>kit/README.md</code> 的「规则表」。</div></div>`
    + table(['rule', 'title', 'evaluated', 'passed', '性质'], rows, 'tbl')
}

function renderLedgers(d) {
  const v = d.versions || {}
  const ch = v.channels
  const scope = d.scope
  const ld = d.ledgers
  const depsSizes = ld?.deps
  const scopeLine = scope
    ? (scope.present === false
      ? `<div class="card warn"><div class="card-h">范围登记</div><div class="note"><b>登记文件不存在</b>（<code>kit/manifest/contract-scope.json</code> 缺失 ⇒ 无法判断"文档未声明"的键是否已被人工放行；这不等于"没有范围"）。</div></div>`
      : `<div class="card"><div class="card-h">范围登记（${esc(scope.total)} 组 / ${esc(scope.keys)} 键）</div>`
      + table(['kind', 'ns', '键数', 'docSection', 'reason'],
        scope.groups.map((g) => `<tr><td class="mono">${esc(g.kind)}</td><td class="mono">${esc(g.ns)}</td><td class="num">${esc(g.count)}</td><td>${esc(orDash(g.docSection))}</td><td>${esc(g.reason)}${g.problems ? ` <span class="tag warn">${esc(g.problems)} 条问题（CT4C）</span>` : ''}</td></tr>`),
        'tbl') + '</div>')
    : '<div class="card"><div class="card-h">范围登记</div><div class="note">未取到（view --json 的 <code>scope</code> 段为空）。</div></div>'
  return `<div class="grid2">`
    + `<div class="card"><div class="card-h">版本台账（versions.json#lines / #contracts / #skills）</div><div class="statrow">`
    + stat('版本线', (v.lines || []).length) + stat('契约常量', (v.contracts || []).length)
    + stat('技能条目', (v.skills || []).length) + stat('skillsLock.ids', v.skillsLock?.ids?.length)
    + stat('commonTools 基线数', v.commonTools?.baselineCount, 'baseline 数组长度')
    + stat('commonTools 新增数', v.commonTools?.addedSinceBaseline, 'addedSinceBaseline 数组长度')
    + stat('commonTools 条目数', v.commonTools?.entryCount, 'entries 明细不入本页')
    + '</div></div>'
    + `<div class="card"><div class="card-h">依赖台账规模（deps.json）</div><div class="statrow">`
    + (depsSizes
      ? Object.entries(depsSizes).map(([k, n]) => stat(k, n)).join('')
      : '<div class="note">未取到（view --json 的 ledgers.deps 段为空）。</div>')
    + '</div></div></div>'
    + `<div class="card"><div class="card-h">契约快照 channels（计数；明细在台账文件里）</div><div class="statrow">`
    + (ch
      ? stat('snapshotAt', ch.snapshotAt, 'committed 口径：由 kit:sync 按提交态落盘')
      + stat('routes', ch.routes) + stat('routePrefixes', ch.routePrefixes)
      + stat('wsOut', ch.wsOut) + stat('wsIn', ch.wsIn)
      + stat('ipc 合计', ch.ipc.total, `invoke ${ch.ipc.invoke} / handle ${ch.ipc.handle} / send ${ch.ipc.send} / on ${ch.ipc.on} / push ${ch.ipc.push}`)
      + stat('tools', ch.tools) + stat('excluded', ch.excluded)
      + stat('scopeCount', ch.scopeCount, '人工封顶（组数）') + stat('scopeRedCount', ch.scopeRedCount, '人工封顶（键数）')
      : '<div class="note">未取到 channels（versions.json 缺该段 ⇒ 契约快照缺失，跑 <code>npm run kit:sync</code> 生成）。</div>')
    + '</div><div class="note">★ 口径：这些是<b>提交态</b>复算值（台账随代码一起提交，CI 在干净检出上跑同一条门禁）。'
    + '工作树里未提交的契约改动不进这张表 —— 它们只在 <code>CT8</code> 里逐条报黄灯。</div></div>'
    + scopeLine
}

function renderDeps(d) {
  const dep = d.deps || {}
  const domainRows = (dep.domains || []).map((x) => `<tr><td class="mono">${esc(x.id)}</td><td class="num">${esc(x.count)}</td><td class="mono">${esc(orDash(x.source))}</td>`
    + `<td class="mono">${esc((x.packages || []).join(', ') || '—')}</td></tr>`)
  const listCard = (title, list, note) => `<div class="card"><div class="card-h">${esc(title)}（${Array.isArray(list) ? list.length : 0}）</div>`
    + `<div class="note">${note}</div>`
    + (Array.isArray(list) && list.length
      ? `<ul class="tight">${list.map((x) => `<li class="mono">${esc(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('')}</ul>`
      : '<div class="note">无 —— 这一栏为空是<b>结论</b>（没有未用依赖 / 没有反向幽灵依赖），不是"没取到数"。</div>')
    + '</div>'
  const notes = dep.notes && typeof dep.notes === 'object' ? dep.notes : null
  const notesCard = notes
    ? `<div class="card"><div class="card-h">notes（台账里的人工说明；逐条带 reason）</div>`
    + Object.entries(notes).map(([k, arr]) => `<details><summary>${esc(k)}（${Array.isArray(arr) ? arr.length : 0}）</summary>`
      + (Array.isArray(arr)
        ? `<ul class="tight">${arr.map((x) => `<li><span class="mono">${esc(x?.name ?? JSON.stringify(x))}</span><div class="note">${esc(x?.reason ?? '')}</div></li>`).join('')}</ul>`
        : `<div class="note mono">${esc(JSON.stringify(arr))}</div>`)
      + '</details>').join('') + '</div>'
    : '<div class="card"><div class="card-h">notes</div><div class="note">台账里没有 notes 段（无则说明：说明这里没有需要人工解释的差集/未核实项）。</div></div>'
  const sizes = dep.sizes && Object.keys(dep.sizes).length
    ? table(['域', '体积（字节）'], Object.entries(dep.sizes).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="num">${esc(v)}</td></tr>`), 'tbl')
    : '<div class="note">sizes 为空 —— P6 的三域体积记账未采集（仅趋势、无阈值）。</div>'
  return `<div class="card"><div class="card-h">依赖域（${(dep.domains || []).length} 域；P1/P2 的结论在「红灯与黄灯」）</div>`
    + `<div class="note">unused / ghost 两栏<b>不在</b> <code>deps.json</code> 里：它们由规则算出来（P1 = 未用依赖=黄、P2 = 反向幽灵依赖=红），故本页取的是门禁 findings。`
    + `现取数来源：unused ← ${esc(dep.unusedSource)}, ghost ← ${esc(dep.ghostSource)}。</div></div>`
    + table(['域', '包数', '来源', '包清单'], domainRows, 'tbl')
    + '<div class="grid2">' + listCard('unused（P1：声明了但有/无引用证据）', dep.unused, '黄灯。删包前必须把五类证据（import / 动态 import() / 配置文件 / CLI / types）逐类核过 —— 删错的代价是功能静默失效。')
    + listCard('ghost（P2：源码 import 了却没声明）', dep.ghost, '红灯。这是仓库里唯一能抓"删了依赖但其实还有人在用"的规则；★ 本机的判定不成立（家目录杂散 node_modules 会把它解析到），只有 CI / 盘根克隆才算数。')
    + '</div>'
    + `<div class="card"><div class="card-h">sizes（P6 三域体积记账）</div>${sizes}</div>`
    + notesCard
}

function locatorText(x) {
  const l = x?.locator
  if (!l) return orDash(x?.file)
  if (l.kind === 'json') return `${x.file}:${l.path}`
  if (l.kind === 'const') return `${x.file}:${l.name}`
  return `${x.file}:${JSON.stringify(l)}`
}

function renderVersion(d) {
  const v = d.versions || {}
  const g = d.git || {}
  const lineRows = (v.lines || []).map((x) => `<tr><td class="mono">${esc(x.id)}</td><td>${esc(orDash(x.label))}</td>`
    + `<td class="mono">${esc(JSON.stringify(x.value))}</td><td class="mono">${esc(locatorText(x))}</td>`
    + `<td class="mono">${esc(x.mirror ? `${x.mirror.file}:${x.mirror.locator?.path ?? ''} = ${JSON.stringify(x.mirrorValue)}` : '—')}</td>`
    + `<td>${esc(orDash(x.migrationNote))}</td></tr>`)
  const contractRows = (v.contracts || []).map((x) => `<tr><td class="mono">${esc(x.id)}</td><td class="mono">${esc(JSON.stringify(x.value))}</td>`
    + `<td class="mono">${esc(loc(x.file, x.line))}</td><td>${esc(orDash(x.kind))}</td><td>${esc(orDash(x.migrationNote))}</td></tr>`)
  const h = v.history || {}
  const anchors = [
    ['分支', g.branch], ['HEAD', g.head], ['HEAD 标题', g.headSubject],
    ['未提交（已跟踪）', g.dirtyTracked], ['未提交（未跟踪）', g.dirtyUntracked],
    ['tag 数', g.tagCount], ['最新 tag', g.tagLatest],
    ['分支数', g.branches?.count], ['worktree 数', (g.worktrees || []).length],
  ]
  const wtRows = (g.worktrees || []).map((w) => `<tr><td class="mono">${esc(w.path)}</td><td class="mono">${esc(w.branch || '（detached）')}</td></tr>`)
  const branchList = g.branches?.items?.length
    ? `<div class="note">分支列表（前 ${g.branches.items.length} / 共 ${g.branches.count}）：<span class="mono">${esc(g.branches.items.join(' · '))}</span></div>`
    : ''
  return `<div class="card"><div class="card-h">版本线（${(v.lines || []).length} 条）</div>`
    + table(['id', 'label', '值', '位置（locator）', 'mirror 镜像值', 'migrationNote'], lineRows.length ? lineRows : ['<tr><td colspan="6" class="note">未取到（versions.json 缺失或 lines 为空）。</td></tr>'], 'tbl') + '</div>'
    + `<div class="card"><div class="card-h">契约常量（${(v.contracts || []).length} 条）</div>`
    + table(['id', '值', 'file:line', 'kind', 'migrationNote'], contractRows.length ? contractRows : ['<tr><td colspan="5" class="note">未取到。</td></tr>'], 'tbl') + '</div>'
    + `<div class="card"><div class="card-h">history（版本变更留痕）</div><div class="statrow">`
    + stat('baselineCount', h.baselineCount, '基线条目数上限') + stat('baselineRedCount', h.baselineRedCount, '被放行的红灯上限')
    + stat('commonToolsBaseline', h.commonToolsBaseline) + stat('records 条数', Array.isArray(h.records) ? h.records.length : null, 'V3：首尾相接且末条 == 当前值')
    + `</div><div class="note">基线三条数字的**关系**：条目数超过登记值 ⇒ <code>BASE</code> 红（"基线是已知欠账，不是遇红就塞"）。</div></div>`
    + `<div class="card"><div class="card-h">git 锚定（只读采集）</div><div class="statrow">${anchors.map(([k, val]) => stat(k, val)).join('')}</div>`
    + (g.warnings?.length ? `<div class="note">⚠ git 采集警告：${g.warnings.map((w) => esc(w)).join('；')}</div>` : '')
    + table(['worktree 路径', '分支'], wtRows.length ? wtRows : ['<tr><td colspan="2" class="note">未取到（非 git 仓 / git 不可用）。</td></tr>'], 'tbl') + branchList + '</div>'
    + `<div class="card"><div class="card-h">这个视图对应的命令（可复制）</div><ul class="tight">`
    + `<li><code>node scripts/bump-version.mjs</code>${copyBtn('node scripts/bump-version.mjs')}<div class="note">版本号推进的<b>唯一入口</b>（手改版本常量会与台账/mirror 脱节）。</div></li>`
    + `<li><code>npm run kit:sync</code>${copyBtn('npm run kit:sync')}<div class="note">登记版本线/契约快照变化（★ 台账按<b>提交态</b>落盘：先提交、再 sync、再提交台账）。</div></li>`
    + '</ul>'
    + `<div class="note">快照 / 回退 / 对比 / 清理（影子引用快照 <code>refs/yfw/snap/*</code>）按 spec `
    + '<code>docs/superpowers/specs/2026-09-15-version-manager-design.md</code> 由 <b>version-manager 工作线</b>实施；'
    + '本 GUI <b>只读展示</b>，不重复实现、不写 git。</div></div>'
}

function renderBrand(d) {
  const b = d.brand || {}
  const t = b.truth || null
  const nameRows = (b.names || []).map((n) => `<tr><td class="mono">${esc(n.id)}</td><td>${esc(n.label)}</td>`
    + `<td class="mono">${n.value === null || n.value === '' ? '<span class="bad">取不到值</span>' : esc(n.value)}</td>`
    + `<td class="mono">${esc(loc(n.file, n.line))}</td><td>${esc(orDash(n.kind))}</td>`
    + `<td class="mono">${n.declId ? esc(n.declId) : '—（不在真源的声明点里）'}</td></tr>`)
  const conRows = (b.consistency || []).map((c) => `<tr class="${c.level === 'warn' ? 'sev-red' : ''}">`
    + `<td>${c.level === 'warn' ? '<span class="bad">warn</span>' : '<span class="tag">info</span>'}</td><td>${esc(c.message)}</td></tr>`)
  const assetRows = (b.assets || []).map((a) => `<tr><td class="mono">${esc(a.file)}</td><td>${esc(a.kind)}</td>`
    + `<td class="num">${a.kind === 'ico' ? '—' : `${esc(a.w)} × ${esc(a.h)}`}</td><td class="num">${esc(a.bytes)}</td></tr>`)
  // (a) 品牌真源：层级名 + 8 条声明点（含 why）
  const layerRows = ((t && t.layers) || []).map((l) => `<tr><td class="mono">${esc(l.id)}</td>`
    + `<td class="mono">${esc(l.name)}</td><td>${esc(orDash(l.note))}</td></tr>`)
  const declRows = ((t && t.declarations) || []).map((x) => `<tr><td class="mono">${esc(x.id)}</td>`
    + `<td class="mono">${esc(x.file)}</td><td>${esc(orDash(x.kind))}</td>`
    + `<td class="mono">${esc(x.expects ? (x.expects.literal !== undefined ? `字面量 "${x.expects.literal}"` : `层 ${x.expects.layer} 的名称`) : '—')}</td>`
    + `<td>${esc(orDash(x.why))}</td></tr>`)
  // (b) 废弃别名 + 已知广泛存在
  const aliasRows = ((t && t.retiredAliases) || []).map((a) => `<tr class="sev-red"><td class="mono">${esc(a.alias)}</td>`
    + `<td class="mono">${esc(a.replaceWith)}</td><td>${esc(orDash(a.layer))}</td><td>${esc(orDash(a.why))}</td>`
    + `<td class="mono">${esc(orDash(a.scope))}</td></tr>`)
  // ★ 规模必须**从真源的 counts 结构读**（不是 `occurrences` 裸数字）：真源里存的是**带口径的多组计数**
  //   + `recompute` 命令 —— 页面照抄真源、自己不另算一份（否则页面与真源会各说一套，本仓已吃过这个亏）。
  const cnt = (k, key) => {
    const c = (k.counts || {})[key]
    return c ? `${c.lines} 处 / ${c.files} 文件` : '—'
  }
  const wideRows = ((t && t.knownWidespread) || []).map((k) => `<tr><td class="mono">${esc(k.alias)}</td>`
    + `<td class="num">${esc(cnt(k, 'exactCaseSensitive'))}</td>`
    + `<td class="num">${esc(cnt(k, 'aliasFamily'))}</td>`
    + `<td>${esc(orDash(k.why))}${k.measuredAt ? `<div class="dim">@${esc(k.measuredAt)} 量的快照（会漂移）</div>` : ''}`
    + `${k.recompute ? `<div class="cmd"><code>${esc(String(k.recompute).split('\n')[0])}</code>${copyBtn(String(k.recompute).split('\n')[0])}</div>` : ''}</td></tr>`)
  // 「已知**未**纳管」—— 把"还没统一"的地方如实摊开，避免页面给人"全都统一了"的错觉
  const ungatedRows = ((t && t.knownUngated) || []).map((u) => `<tr><td>${esc(orDash(u.what))}</td>`
    + `<td class="mono">${esc(orDash(u.where))}</td><td>${esc(orDash(u.why))}</td><td>${esc(orDash(u.carry))}</td></tr>`)
  const cmd = (c) => `<div class="cmd"><code>${esc(c)}</code>${copyBtn(c)}</div>`
  return ''
    + `<div class="card"><div class="card-h">品牌真源（<span class="mono">kit/manifest/brand.json</span>）—— 改它 = 重新定义品牌</div>`
    + (t
      ? `<div class="note">层级名（用户可见层名 vs 内核层名）+ 中文品牌名：</div>`
        + table(['层 id', '层名', '说明'], layerRows.length ? layerRows : ['<tr><td colspan="3" class="note">真源里没有 layers。</td></tr>'], 'tbl')
        + `<div class="note">中文品牌名：<b>${esc(t.brandZh?.name ?? '—')}</b> ${esc(orDash(t.brandZh?.where))}</div>`
        + `<div class="card-h">声明点（${((t && t.declarations) || []).length} 条；CT10 逐条对账 —— 每条都写明"为什么算声明点"）</div>`
        + table(['id', 'file', 'kind', '期望', '为什么算声明点（why）'], declRows.length ? declRows : ['<tr><td colspan="5" class="note">真源里没有 declarations。</td></tr>'], 'tbl')
      : '<div class="note">读不到品牌真源（<span class="mono">kit/manifest/brand.json</span>）—— 见「概览」的取数警告；CT10 会把"真源不可读"报成红。</div>')
    + `<div class="note">一致性由 <b>CT10</b> 把关（8 条声明点逐条对账；★ <b>不可基线豁免</b> —— 品牌门禁不许靠加一条基线蒙过去）：`
    + `结果见「红灯与黄灯」与「规则矩阵」的 CT10 行。改真源之后跑下面三条命令看"哪里还没跟上"。</div>`
    + cmd('node scripts/brand.mjs show')
    + cmd('node scripts/brand.mjs check')
    + cmd('node scripts/brand.mjs set <layer> <name>')
    + `<div class="note"><span class="mono">show</span> 打印真源；<span class="mono">check</span> 按 CT10 判据查<b>工作树</b>（改完立刻能看）；`
    + `<span class="mono">set</span> 重新定义某层名：改真源 + 自动同步能同步的声明点（version.mjs 注释、台账 label），`
    + `再把<b>仍需手工改</b>的（productName / &lt;title&gt; / npm 包名 / appId —— 改了会影响安装与发布身份）列成清单 + 给出建议值。</div></div>`
    + `<div class="card"><div class="card-h">废弃别名与已知广泛存在（边界必须一眼看清）</div>`
    + table(['废弃别名', '应替换为', '层', '为什么废弃', '范围'], aliasRows.length ? aliasRows
      : ['<tr><td colspan="5" class="note">真源里没有 retiredAliases。</td></tr>'], 'tbl')
    + `<div class="note">别名判据：<b>只查受管声明点指向的那段文本</b>（某行注释 / 某 key 的值 / &lt;title&gt; 的内容 / 台账里的某条 label），`
    + `匹配<b>不区分大小写</b>；<b>不扫整文件、更不扫全仓</b>。</div>`
    + `<div class="card-h">已知广泛存在（★ 不在门禁范围：全仓统一改名是独立工作项）</div>`
    + table(['别名', '精确写法', '含各种写法', '说明与复算命令'], wideRows.length ? wideRows
      : ['<tr><td colspan="4" class="note">真源里没有 knownWidespread。</td></tr>'], 'tbl')
    + `<div class="note">这些文本散在 <span class="mono">kernel/</span>、<span class="mono">kernel-tests/</span> 与 <span class="mono">docs/</span> 的`
    + `<b>叙述性文本</b>里 —— 它们不是"声明点"，改不改都不影响安装/显示；CT10 若去扫全仓会永远红（红灯失去信息量），故明确划在范围外。</div></div>`
    + `<div class="card"><div class="card-h">名称声明点（${(b.names || []).length} 条；探针取值，<span class="mono">declId</span> = 与真源声明点的对齐结果）</div>`
    + table(['id', 'label', '值', 'file:line', '声明载体', '真源声明点'], nameRows.length ? nameRows : ['<tr><td colspan="6" class="note">未取到。</td></tr>'], 'tbl') + '</div>'
    + `<div class="card"><div class="card-h">一致性提示（${(b.consistency || []).length}；warn 醒目、info 普通）</div>`
    + table(['level', 'message'], conRows.length ? conRows : ['<tr><td colspan="2" class="note">无提示。</td></tr>'], 'tbl')
    + `<div class="note">一致性提示**只提示不断言**：真正的断言在 <b>CT10</b>（品牌真源 ↔ ${(t && t.declarations || []).length} 条声明点，不可基线豁免）；`
    + `本段只把"名分散在哪几处"显形。</div></div>`
    + `<div class="card"><div class="card-h">已知**未**纳管的声明点（${((t && t.knownUngated) || []).length} 类；如实摊开，别把这里读成"全都统一了"）</div>`
    + table(['是什么', '在哪', '为什么不纳管', '后续怎么处理'], ungatedRows.length ? ungatedRows
      : ['<tr><td colspan="4" class="note">真源里没有 knownUngated。</td></tr>'], 'tbl')
    + `<div class="note">这些位置<b>确实还带着旧名/未统一</b>，但形态零散（运行时代码字符串、i18n 文案、二进制资产、NSIS 方言），`
    + `强行"改了必须红"会做成脆弱门禁 ⇒ 如实登记为<b>已知未纳管</b>，改名时按这份清单人工过一遍。</div></div>`
    + `<div class="card"><div class="card-h">标识资源清单（${(b.assets || []).length} 项；尺寸零依赖解析 —— PNG 读 IHDR，.ico 只记字节数）</div>`
    + table(['文件', 'kind', '尺寸（px）', '字节数'], assetRows.length ? assetRows : ['<tr><td colspan="4" class="note">未取到（资源文件都不存在？见「概览」的取数警告）。</td></tr>'], 'tbl')
    + `<div class="note">本视图<b>只读汇总</b>：名称与标识的<b>唯一真源</b>是 <span class="mono">kit/manifest/brand.json</span>，`
    + `上面那些文件里的声明点由 <b>CT10</b> 逐条对账（<b>已生效</b>，不是"待另立一批"）；`
    + `本页不做任何写操作 —— 要改品牌走 <span class="mono">node scripts/brand.mjs set &lt;layer&gt; &lt;name&gt;</span>。</div></div>`
}

function renderAgent(d) {
  const guide = d.agent || AGENT_GUIDE
  const sections = guide.sections.map((s) => `<div class="card"><div class="card-h">${esc(s.title)}（${s.items.length} 条）</div>`
    + '<ol class="items">' + s.items.map((it) => '<li>'
      + `<div class="do">${esc(it.do)}</div>`
      + `<div class="why">为什么：${esc(it.why)}</div>`
      + (it.cmd ? `<div class="cmd"><code>${esc(it.cmd)}</code>${copyBtn(it.cmd)}</div>` : '<div class="note">（本条无可复制命令）</div>')
      + '</li>').join('') + '</ol></div>').join('')
  return `<div class="card"><div class="card-h">本页数据即 agent 读取的同一份真源 ⇒ 可跑 <code>node kit/gui.mjs --agent</code> 打印纯文本</div>`
    + `<div class="note">单一真源：<code>kit/lib/agent-guide.mjs</code>（本视图与 <code>--agent</code> 消费的是同一份对象，故两者不可能漂移）；`
    + `入口指针：<code>kit/AGENT.md</code>（不承载清单内容）。</div>`
    + `<div class="cmd"><code>node kit/gui.mjs --agent</code>${copyBtn('node kit/gui.mjs --agent')}</div>`
    + `<div class="note">${esc(guide.intro)}</div></div>`
    + sections
    + `<div class="card"><div class="card-h">四条断言与基线纪律</div>`
    + `<div class="note">★ 这四条与 <span class="mono">kit/README.md</span> 里那套「<b>四条铁律</b>」`
    + `（sync 字段 / 放行可见 / 扫描域 = <span class="mono">git ls-files</span> / 真仓数字口径）是`
    + `<b>两份不同清单</b>、并行生效，别把"铁律 4"当成同一个东西（真源在 README，本页不复制其内容）。</div>`
    + '<ol class="items tight">'
    + guide.assertionRules.map((r) => `<li><div class="do">${esc(r)}</div></li>`).join('') + '</ol></div>'
    + `<div class="card"><div class="card-h">CI 锚点</div><div class="mono">${esc(guide.ci.file)}:${esc(guide.ci.line)} → <code>${esc(guide.ci.script)}</code></div>`
    + `<div class="cmd"><code>${esc(guide.ci.script)}</code>${copyBtn(guide.ci.script)}</div>`
    + `<div class="note">${esc(guide.ci.note)}</div></div>`
}

// ── 样式与脚本（全部内联；刻意不用任何主题系统/框架） ─────────────────────────

const STYLE = `
:root{--bg:#f6f7f9;--fg:#1b1d21;--muted:#5c6674;--card:#fff;--line:#dfe3e8;--red:#c62828;--yellow:#8d6e00;
--green:#1b7f3b;--base:#5b4bb8;--tag:#eef1f5;--mono:ui-monospace,Consolas,"Courier New",monospace}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--fg:#e8eaee;--muted:#9aa4b2;--card:#1d2026;--line:#323741;
--red:#ff6b6b;--yellow:#e6c34a;--green:#5ddc8a;--base:#b1a6ff;--tag:#272b32}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
a{color:inherit}
code{font-family:var(--mono);background:var(--tag);padding:1px 5px;border-radius:4px;word-break:break-all}
.mono{font-family:var(--mono);word-break:break-all}
.top{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.top h1{font-size:15px;margin:0 8px 0 0}
.chip{background:var(--tag);border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-family:var(--mono);font-size:12px}
.chip.bad{color:var(--red);border-color:var(--red)}
.chip.ok{color:var(--green);border-color:var(--green)}
.chip.warn{color:var(--yellow);border-color:var(--yellow)}
.chip.base{color:var(--base);border-color:var(--base)}
.topnote{margin-left:auto;font-size:12px;color:var(--muted)}
.wrap{display:flex;align-items:flex-start}
.side{position:sticky;top:52px;flex:0 0 168px;padding:14px 10px;border-right:1px solid var(--line);min-height:calc(100vh - 52px)}
.side a{display:block;padding:4px 8px;border-radius:6px;text-decoration:none;font-size:13px;color:var(--muted)}
.side a:hover{background:var(--tag);color:var(--fg)}
main{flex:1;min-width:0;padding:14px 18px 60px}
section{margin:0 0 26px}
h2{font-size:17px;margin:18px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
.card.ok{border-left:4px solid var(--green)}
.card.bad{border-left:4px solid var(--red)}
.card.warn{border-left:4px solid var(--yellow)}
.card-h{font-weight:600;margin-bottom:8px}
.card-big{font-size:20px;font-weight:700;margin-bottom:8px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px}
.statrow{display:flex;flex-wrap:wrap;gap:10px}
.stat{background:var(--tag);border-radius:8px;padding:8px 10px;min-width:120px;flex:1 1 140px}
.stat-k{font-size:12px;color:var(--muted)}
.stat-v{font-size:16px;font-weight:600;font-family:var(--mono);word-break:break-all}
.stat-n{font-size:11px;color:var(--muted);font-family:var(--mono);word-break:break-all}
.note{font-size:12px;color:var(--muted);margin-top:6px}
.scroll{overflow-x:auto;margin:8px 0}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
th{background:var(--tag);position:sticky;top:0}
td.num{text-align:right;font-family:var(--mono)}
.tbl{min-width:760px}
tr.sev-red td:first-child{color:var(--red);font-weight:600}
tr.sev-yellow td:first-child{color:var(--yellow)}
tr.sev-baselined td:first-child{color:var(--base)}
.tag{background:var(--tag);border:1px solid var(--line);border-radius:999px;padding:0 6px;font-size:11px;color:var(--muted)}
.tag.warn{color:var(--yellow);border-color:var(--yellow)}
.bad{color:var(--red);font-weight:600}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:8px 0}
.fgroup{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--tag);border-radius:8px;padding:6px 8px}
.flabel{font-family:var(--mono);font-size:12px;color:var(--muted)}
.chk{font-size:12px}
button{font:inherit;font-size:12px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 8px;cursor:pointer}
button:hover{background:var(--tag)}
.copy{margin-left:6px}
.items{margin:6px 0 0;padding-left:22px}
.items.tight li{margin:4px 0}
.items li{margin:10px 0}
.do{font-weight:600}
.why{font-size:12px;color:var(--muted)}
.cmd{margin-top:4px}
details{margin:6px 0}
summary{cursor:pointer;font-family:var(--mono);font-size:12.5px}
ul.tight li{margin:3px 0}
footer{padding:10px 18px;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}
@media print{.side{position:static;min-height:0}.top{position:static}.scroll{overflow:visible}table{min-width:0}}
`

/** 内联脚本：① findings 筛选（渐进增强）② 复制（剪贴板不可用时静默降级） */
const SCRIPT = `
(function(){
  // ① 筛选：初始态 = 全选 = 与无 JS 时的全量渲染一致（故"JS 坏了"页面依然可读）
  var rows = Array.prototype.slice.call(document.querySelectorAll('#findings-table tbody tr[data-sev]'));
  var boxSev = Array.prototype.slice.call(document.querySelectorAll('.f-sev'));
  var boxRule = Array.prototype.slice.call(document.querySelectorAll('.f-rule'));
  var counter = document.getElementById('f-count');
  function apply(){
    var sevOn = {}, ruleOn = {};
    boxSev.forEach(function(b){ if(b.checked) sevOn[b.value] = 1; });
    boxRule.forEach(function(b){ if(b.checked) ruleOn[b.value] = 1; });
    var shown = 0;
    rows.forEach(function(r){
      var ok = sevOn[r.getAttribute('data-sev')] && ruleOn[r.getAttribute('data-rule')];
      r.hidden = !ok;
      if(ok) shown++;
    });
    if(counter) counter.textContent = '显示 ' + shown + ' / ' + rows.length + ' 条';
  }
  boxSev.concat(boxRule).forEach(function(b){ b.addEventListener('change', apply); });
  var all = document.getElementById('f-all'), none = document.getElementById('f-none');
  if(all) all.addEventListener('click', function(){ boxSev.concat(boxRule).forEach(function(b){ b.checked = true; }); apply(); });
  if(none) none.addEventListener('click', function(){ boxSev.concat(boxRule).forEach(function(b){ b.checked = false; }); apply(); });
  apply();
  // ② 复制：clipboard 不可用（file:// 下的旧浏览器 / 权限拒绝）时**不许报错**，退回"选中文本"
  function fallback(btn){
    try{
      var code = btn.parentNode.querySelector('code');
      if(!code || !window.getSelection || !document.createRange) return;
      var range = document.createRange();
      range.selectNodeContents(code);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = '已选中，按 Ctrl+C';
    }catch(e){ /* 兜底也失败就算了：按钮文本会自己复位，绝不抛给用户 */ }
  }
  document.addEventListener('click', function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest('.copy') : null;
    if(!btn) return;
    var text = btn.getAttribute('data-copy') || '';
    var done = function(ok){ btn.textContent = ok ? '已复制' : '复制失败'; setTimeout(function(){ btn.textContent = '复制'; }, 1600); };
    try{
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(function(){ done(true); }, function(){ fallback(btn); });
      }else{ fallback(btn); }
    }catch(e){ fallback(btn); }
  });
})();
`

// ── 主渲染 ───────────────────────────────────────────────────────────────────

/**
 * 渲染完整 HTML（自包含单文件）。
 * @param {object} data `buildGuiData()` 的产物
 * @returns {string} HTML
 */
export function renderGuiHtml(data) {
  const d = data && typeof data === 'object' ? data : {}
  const g = d.gate || { ok: false, exitCode: 1, summary: {}, checks: [] }
  const summary = g.summary || {}
  const nav = GUI_SECTIONS.map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`).join('')
  const top = `<header class="top">`
    + `<h1>DevKit GUI 报告</h1>`
    + `<span class="chip ${g.ok ? 'ok' : 'bad'}">EXIT=${esc(g.exitCode)}</span>`
    + `<span class="chip ${summary.red ? 'bad' : 'ok'}">红 ${esc(summary.red ?? 0)}</span>`
    + `<span class="chip warn">黄 ${esc(summary.yellow ?? 0)}</span>`
    + `<span class="chip base">基线 ${esc(summary.baselined ?? 0)}</span>`
    + `<span class="chip">green ${esc(summary.green ?? 0)} / rules ${esc(summary.rules ?? 0)}</span>`
    + `<span class="chip">生成 ${esc(d.generatedAt ?? '—')}</span>`
    // 页顶显式指路：本页的数据与 agent 读的是**同一份真源**（否则人看页面、agent 看文本，两份规范会漂移）
    + `<span class="note topnote">本页数据即 agent 读取的同一份真源 ⇒ 可跑 <code>node kit/gui.mjs --agent</code> 打印纯文本</span>`
    + `</header>`
  const body = `<div class="wrap"><nav class="side">${nav}</nav><main>`
    + `<section id="overview"><h2>概览</h2>${renderOverview(d)}</section>`
    + `<section id="findings"><h2>红灯与黄灯</h2>${renderFindings(d)}</section>`
    + `<section id="rules"><h2>规则矩阵</h2>${renderRules(d)}</section>`
    + `<section id="ledgers"><h2>台账</h2>${renderLedgers(d)}</section>`
    + `<section id="deps"><h2>依赖域</h2>${renderDeps(d)}</section>`
    + `<section id="version"><h2>版本控制</h2>${renderVersion(d)}</section>`
    + `<section id="brand"><h2>品牌标识与名称</h2>${renderBrand(d)}</section>`
    + `<section id="agent"><h2>Agent 套件规范</h2>${renderAgent(d)}</section>`
    + `</main></div>`
  // findings 表格自带 id（见 renderFindings 的 table(..., 'findings-table')）：筛选脚本按它取行
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DevKit 报告 · ${g.ok ? '门禁通过' : '门禁未通过'}（红 ${esc(summary.red ?? 0)} / 黄 ${esc(summary.yellow ?? 0)}）· ${esc(d.generatedAt ?? '')}</title>
<style>${STYLE}</style>
</head>
<body>
${top}
<noscript><div class="card warn" style="margin:10px 18px"><div class="card-h">JavaScript 不可用</div><div class="note">本页表格已<b>全量渲染</b>，可正常阅读；仅「筛选」与「一键复制」不可用（它们是渐进增强）。</div></div></noscript>
${body}
<footer>本页由 <code>node kit/gui.mjs</code> 生成（自包含单文件、零外链、零依赖、不写 git）。数据真源：<code>kit/cli.mjs check --json</code> / <code>view --json</code> + <code>kit/manifest/*.json</code>（只读）。</footer>
<script type="application/json" id="kit-data">${inlineJsonText(d)}<\/script>
<script>${SCRIPT}<\/script>
</body>
</html>`
}
