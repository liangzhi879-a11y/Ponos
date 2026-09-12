// 上下文失真 GUI 渲染验证（手动运行，不属 npm test —— 需要 electron 与图形会话）
// ---------------------------------------------------------------------------
//   node scripts/verify-gui-fidelity.mjs
// 目的：把 Task 6 的**核心语义**在真实 DOM 里验掉，而不是只在代码里"看起来对"：
//   ① 失真红 → 证据卡出现（逐条证据 + 两级动作按钮）
//   ② 失真琥珀 → 只有角标、不弹卡（不打扰）
//   ③ 压力红 + 失真绿 → 血条变红但**无角标无卡**（两轴严禁互相赋值）
//   ④ 老内核（无 distortion 字段）→ 无角标无卡（向后兼容）
// 做法：esbuild 打包"真组件 + 真 store"，electron 无头加载，读回 computed style 与 innerText。
// 临时文件全部生成在系统 temp 目录，不污染仓库。
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(findNodeModules(REPO_ROOT), 'electron', 'dist', 'electron.exe')
const TMP = mkdtempSync(join(tmpdir(), 'yfw-gui-verify-'))
/** 截图输出目录（放 release/ 下，仓库 gitignore，便于人工眼见为实） */
const SHOT_DIR = process.env.GUI_VERIFY_SHOT_DIR || join(REPO_ROOT, 'release', '_gui-fidelity-shots')

/** 取构建产物里的 CSS（组件用到的类与主题令牌都在其中）
 *  可用 GUI_VERIFY_CSS_DIR 指向别的 dist（如调试版 release/YFWorking/dist），
 *  验证"调试版 CSS 下布局类同样生效"。 */
function builtCssPath() {
  const dir = process.env.GUI_VERIFY_CSS_DIR || join(REPO_ROOT, 'dist', 'assets')
  const css = readdirSync(dir).filter((f) => f.endsWith('.css'))
  if (!css.length) throw new Error(`未找到 ${dir}/*.css —— 请先 npm run build`)
  return join(dir, css[0])
}

// ---- 夹具（与 kernel/fidelity.mjs 下发的形状一致） ----
const issue = (i, axis, kind, strength) => ({
  id: `${axis[0]}:${kind}:${i}`, axis, kind, strength, turn: i, evidence: `证据 ${i}：引用了已删除的 src/f${i}.ts`, at: '2026-09-12T00:00:00.000Z',
})
const dist = (tier, issues, extra = {}) => ({
  score: tier === 'green' ? 0 : tier === 'amber' ? 45 : 85,
  tier, axes: { memory: tier === 'green' ? 0 : 40, coherence: tier === 'green' ? 0 : 60, goal: 0 },
  issues, trigger: issues.length ? issues[0].id : null, observeUntilTurn: null,
  anchorAvailable: tier === 'red', ...(tier === 'red' ? { anchorText: '【上下文锚定·权威事实】\n■ 原始任务 实现删除交互\n■ 硬约束 不改动 API 契约' } : {}), ...extra,
})
const pressure = (tier) => ({ score: tier === 'red' ? 90 : 10, tier, compactCount: tier === 'red' ? 2 : 0, remainingPct: tier === 'red' ? 9 : 60, remainingTurns: tier === 'red' ? 158 : 900, suggestNewSession: tier === 'red', reason: '压力档' })

const CASES = [
  { key: 'red-distortion', desc: '失真红（3 条证据）+ 压力绿', health: { ...pressure('green'), distortion: dist('red', [issue(1, 'coherence', 'stale_ref', 'strong'), issue(2, 'memory', 'summary_missing', 'strong'), issue(3, 'goal', 'drift', 'medium')]) } },
  { key: 'amber-distortion', desc: '失真琥珀（2 条证据）+ 压力绿', health: { ...pressure('green'), distortion: dist('amber', [issue(1, 'coherence', 'stale_ref', 'medium'), issue(2, 'coherence', 'contradiction', 'medium')]) } },
  { key: 'red-pressure-only', desc: '压力红 + 失真绿（关键：不得弹卡/角标）', health: { ...pressure('red'), distortion: dist('green', []) } },
  { key: 'legacy-no-distortion', desc: '老内核：完全无 distortion 字段', health: pressure('green') },
  {
    key: 'recurred-distortion', desc: '同源复发（此前处理过 → 应重现并提示升级）',
    health: { ...pressure('green'), distortion: dist('red', [{ ...issue(1, 'coherence', 'stale_ref', 'strong'), recurred: true }]) },
    // 模拟"用户已处理过该证据"：首次抑制键已登记（复发态用 #recurred 键，故仍应弹卡）
    shownIds: ['c:stale_ref:1'],
  },
]

// ---- 生成 harness（真组件 + 真 store，按键位夹具渲染） ----
const harness = `
import { createRoot } from 'react-dom/client'
import { HealthMeter } from '@/components/chat/HealthMeter'
import { HealthSuggestCard } from '@/components/chat/HealthSuggestCard'
import { HealthGlow } from '@/components/chat/HealthGlow'
import { TooltipProvider } from '@/components/ui'
import { useHealthStore } from '@/stores/healthStore'

// 主题类挂在 <html> 上（themes.css 的 .theme-dark 等定义 --health-tier-* 等令牌），
// 不设主题则所有主题变量未定义 → 颜色解析为透明、泛光 box-shadow 失效（测量假阴性）。
document.documentElement.className = 'theme-dark'
const FIXTURES = window.__FIXTURES__ || []
const el = document.getElementById('root')
const root = createRoot(el)

// 页内切换夹具（避免把大 JSON 塞进 file:// 的 query —— 那样会 ERR_FAILED）
window.__render = (i) => {
  const fx = FIXTURES[i]
  useHealthStore.setState({
    healthBySession: { c1: fx.health },
    summaryCompactCountBySession: { c1: 0 },
    dismissedUntilBySession: {},
    distortionShownIdsBySession: { c1: fx.shownIds || [] },
    dismissedDistortionUntilBySession: {},
  })
  root.render(
    // 与真实应用一致：Tooltip 必须在 TooltipProvider 内（App.tsx 根部提供）。
    // 卡片是 absolute bottom-full（悬浮在输入框上方）→ 外层留出上方空间，否则截图拍到视口外。
    <TooltipProvider>
      <div className="relative" style={{ width: 800, height: 200, marginTop: 300, marginLeft: 40 }}>
        <HealthGlow conversationId="c1" />
        <HealthMeter conversationId="c1" />
        <HealthSuggestCard conversationId="c1" onAnchorApplied={() => {}} onStopSource={() => {}} />
      </div>
    </TooltipProvider>,
  )
}
window.__render(0)
`
const mainCjs = `
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { writeFileSync, mkdirSync } = require('node:fs')
const HTML = ${JSON.stringify(join(TMP, 'index.html'))}
const RESULT_FILE = ${JSON.stringify(join(TMP, 'result.json'))}
const SHOT_DIR = ${JSON.stringify(SHOT_DIR)}
const shotFiles = []
let shotErr = null
const FX = ${JSON.stringify(CASES.map((c) => ({ key: c.key })))}

const EXTRACT = \`(() => {
  const fill = document.querySelector('.health-meter-fill')
  // 泛光 = inset 红色 box-shadow 的覆盖层（卡片用的是 filter: drop-shadow，不会误判）
  const glow = [...document.querySelectorAll('div')].find(d => {
    const s = getComputedStyle(d)
    return s.boxShadow && s.boxShadow !== 'none' && s.boxShadow.includes('inset')
  })
  return {
    hasMeter: !!document.querySelector('.health-meter'),
    fillBg: fill ? getComputedStyle(fill).backgroundColor : null,
    text: document.body.innerText,
    buttons: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean),
    hasGlow: !!glow,
    // 复发提示（"锚定未根治"）：按可见文本判定，不依赖具体文案
    recurredNotice: /再次出现|came back/.test(document.body.innerText),
    htmlLen: document.getElementById('root').innerHTML.length,
    errors: window.__ERRORS__ || [],
  }
})()\`

app.whenReady().then(async () => {
  const results = []
  const win = new BrowserWindow({ show: true, width: 900, height: 560, webPreferences: { contextIsolation: true } })
  await win.loadFile(HTML)
  await win.webContents.executeJavaScript('new Promise(r => setTimeout(() => r(1), 250))')
  for (let i = 0; i < FX.length; i++) {
    const key = FX[i].key
    await win.webContents.executeJavaScript('window.__render(' + i + ')')
    await win.webContents.executeJavaScript('new Promise(r => setTimeout(() => r(1), 300))')
    const data = await win.webContents.executeJavaScript(EXTRACT)
    // 截图留证（人工眼见为实）：release/_gui-fidelity-shots/<key>.png
    try {
      const img = await win.webContents.capturePage()
      const png = img.toPNG()
      if (!png || !png.length) throw new Error('capturePage 返回空图')
      mkdirSync(SHOT_DIR, { recursive: true })
      writeFileSync(join(SHOT_DIR, key + '.png'), png)
      shotFiles.push(key + '.png')
    } catch (e) { shotErr = String(e?.message || e) }
    results.push({ key, ...data })
  }
  win.destroy()
  // electron.exe 是 GUI 子系统程序：stdout 不可靠 → 结果落文件
  writeFileSync(RESULT_FILE, JSON.stringify({ results, shotFiles, shotErr }))
  app.quit()
}).catch((e) => { writeFileSync(RESULT_FILE, JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1) })
`

writeFileSync(join(TMP, 'harness.tsx'), harness)
writeFileSync(join(TMP, 'main.cjs'), mainCjs)
// 夹具经脚本全局注入（页内切换，避免 file:// query 体积限制）
writeFileSync(join(TMP, 'fixtures.js'), `window.__FIXTURES__ = ${JSON.stringify(CASES.map((c) => ({ health: c.health, shownIds: c.shownIds || [] })))};`)
writeFileSync(join(TMP, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${builtCssPath().replace(/\\/g, '/')}"></head>
<body style="background: var(--bg-primary)"><div id="root"></div>
<script>window.__ERRORS__=[];window.addEventListener('error',e=>window.__ERRORS__.push(String(e.message||e.error)));window.addEventListener('unhandledrejection',e=>window.__ERRORS__.push('reject: '+String(e.reason)));</script>
<script src="./fixtures.js"></script><script src="./bundle.js"></script></body></html>`)

/** 就近查找 node_modules：从仓库根向上走（worktree 自身没有，依赖在主仓库/上层）。 */
function findNodeModules(from) {
  let dir = from
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, 'node_modules')
    if (existsSync(cand)) return cand
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  return join(from, 'node_modules')
}

// ---- esbuild：打包真组件（别名 @ → src；用 JS API 避免 shell 引号/Windows 路径转义） ----
const { build } = await import('esbuild')
await build({
  entryPoints: [join(TMP, 'harness.tsx')],
  bundle: true,
  outfile: join(TMP, 'bundle.js'),
  format: 'iife',
  jsx: 'automatic',
  alias: { '@': join(REPO_ROOT, 'src') },
  // harness 在系统 temp 下，Node 解析不到仓库依赖 → 显式给出 node_modules 搜索路径
  nodePaths: [findNodeModules(REPO_ROOT)],
  // iife 下 import.meta 为空对象；config.ts 只在函数体内用它（非加载期），
  // 这里显式给个空 env 以免运行期读到 undefined。
  define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

/** 跑子进程并收 stdout（shell 关闭以免 Windows 引号转义） */
function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let out = '', err = ''
    p.stdout.on('data', (d) => out += d)
    p.stderr.on('data', (d) => err += d)
    p.on('close', (code) => code === 0 ? res(out) : rej(new Error(`${cmd} 退出码 ${code}\n${err || out}`)))
  })
}

// electron.exe 是 GUI 子系统程序（stdout 不可靠）→ 以结果文件为准，忽略其退出码
try { await run(ELECTRON, [join(TMP, 'main.cjs')], { shell: false }) } catch { /* 见下 */ }
let payload
try {
  payload = JSON.parse(readFileSync(join(TMP, 'result.json'), 'utf8'))
} catch (e) {
  throw new Error(`未取到结果文件：${e.message}（electron 未完成渲染？）`)
}
if (payload && payload.error) throw new Error(`electron 渲染失败：${payload.error}`)
const results = payload.results
const shotFiles = payload.shotFiles || []
const shotErr = payload.shotErr

// ---- 断言 ----
const fails = []
const byKey = Object.fromEntries(results.map((r) => [r.key, r]))
const check = (cond, msg) => { if (!cond) fails.push(msg) }
const rowsOf = (text) => (String(text).match(/第 \d+ 轮 ·/g) || []).length
const REANCHOR = '重新锚定'
const NEW_SESSION = '新建会话'

const A = byKey['red-distortion'], B = byKey['amber-distortion'], C = byKey['red-pressure-only'], D = byKey['legacy-no-distortion'], E = byKey['recurred-distortion']

check(!!A?.hasMeter && !!D?.hasMeter, '血条应始终渲染（两个被测量中它是常驻仪表）')
check(A && rowsOf(A.text) === 3, `失真红应逐条列出 3 条证据，实测 ${A ? rowsOf(A.text) : '缺失'}`)
check(A && A.buttons.some((b) => b.includes(REANCHOR)), '失真红应出现「重新锚定」按钮')
check(A && A.buttons.some((b) => b.includes(NEW_SESSION)), '失真红应出现「新建会话」按钮')
check(A && /×\s*3/.test(A.text), '失真红应显示角标 ×3')
check(B && rowsOf(B.text) === 0, `失真琥珀不得弹卡（不打扰），实测证据行 ${B ? rowsOf(B.text) : '缺失'}`)
check(B && !B.buttons.some((b) => b.includes(REANCHOR)), '失真琥珀不得出现「重新锚定」按钮')
check(B && /×\s*2/.test(B.text), '失真琥珀应显示角标 ×2')
check(C && rowsOf(C.text) === 0, '压力红 + 失真绿：不得弹失真卡')
check(C && !C.buttons.some((b) => b.includes(REANCHOR)), '压力红 + 失真绿：不得出现「重新锚定」按钮')
check(C && !/×\s*\d/.test(C.text), '压力红 + 失真绿：不得点亮失真角标（两轴严禁互相赋值）')
check(C && D && C.fillBg !== D.fillBg, `血条颜色必须跟随压力档（压力红=${C?.fillBg} vs 压力绿=${D?.fillBg}）`)
check(A && D && A.fillBg === D.fillBg, `失真红不得改变血条颜色（失真红=${A?.fillBg} vs 压力绿=${D?.fillBg}）`)
check(D && rowsOf(D.text) === 0 && !/×\s*\d/.test(D.text), '老内核（无 distortion 字段）：不得弹卡/角标')
check(!B?.hasGlow && !C?.hasGlow && !D?.hasGlow, '泛光应只在失真红出现（琥珀/压力红/老内核都不泛光）')
check(!!A && A.hasGlow, '失真红应出现泛光（泛光已换轴到失真）')
// 复发：即使该证据已展示过也必须重新提醒，并给出"锚定没根治"提示（spec 验收项 6）
check(E && rowsOf(E.text) === 1, `同源复发应重现卡片，实测证据行 ${E ? rowsOf(E.text) : '缺失'}`)
check(E && E.buttons.some((b) => b.includes(REANCHOR)) && E.buttons.some((b) => b.includes(NEW_SESSION)), '复发卡片应仍提供两级动作')
check(!!E && E.recurredNotice, '复发卡片应显示"锚定未根治"提示')
check(B && !B.recurredNotice && A && !A.recurredNotice, '非复发不得显示复发提示')

console.log('\n失真 GUI 渲染验证：')
for (const r of results) console.log(`  · ${r.key.padEnd(22)} fillBg=${r.fillBg} 证据行=${rowsOf(r.text)} 角标=${/×\s*\d/.test(r.text) ? 'on' : 'off'} 泛光=${r.hasGlow ? 'on' : 'off'} 按钮=[${r.buttons.join(', ')}] rootHtml=${r.htmlLen}`)
const errs = [...new Set(results.flatMap((r) => r.errors || []))]
if (errs.length) console.log(`\n页内错误：\n  - ${errs.slice(0, 4).join('\n  - ')}`)
console.log(fails.length ? `\n✖ ${fails.length} 项未通过：\n  - ${fails.join('\n  - ')}` : '\n✔ 全部通过')
if (shotFiles.length) console.log(`\n截图：${SHOT_DIR}（${shotFiles.join(', ')}）`)
else if (shotErr) console.log(`\n（截图不可用：${shotErr} —— 不影响断言结论）`)

rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
process.exit(fails.length ? 1 : 0)
