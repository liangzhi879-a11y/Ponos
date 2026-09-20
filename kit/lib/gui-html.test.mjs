// kit/lib/gui-html.test.mjs —— 自包含单文件 HTML 的**机械校验**
//
// 为什么这些判据要写成断言而不是"人工看一眼"：
//   "零外链""无 JS 可看""数据不截断"这三条都属于**平时看不出、坏了也不报警**的性质 ——
//   页面照样能打开，只是离线时缺样式、数据里含 `</script>` 时白屏。它们的共同点是：
//   都能用一条正则/一次 JSON.parse 机械判定 ⇒ 那就必须进测试，而不是留在实现者的自觉里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_GUIDE } from './agent-guide.mjs'
import { buildGuiData } from './gui-data.mjs'
import { GUI_SECTIONS, inlineJsonText, renderGuiHtml } from './gui-html.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 最小可用数据包（手工造 —— 不依赖真仓门禁，故快；真仓那一份由 gui.test.mjs 端到端覆盖） */
function makeData(overrides = {}) {
  const base = {
    schemaVersion: 1,
    generatedAt: '2026-09-20T00:00:00.000Z',
    gate: {
      ok: false,
      exitCode: 1,
      summary: { red: 1, yellow: 1, baselined: 1, green: 3, rules: 5 },
      checks: [
        { rule: 'CT1', title: '台账快照 == 现场重算', evaluated: 372, passed: true },
        { rule: 'CT8', title: '在途差异', evaluated: 708, passed: false },
        { rule: 'V1', title: '台账值可从宿主文件解析-回读', evaluated: 18, passed: false },
      ],
    },
    findings: [
      { rule: 'V1', severity: 'red', subject: 'APP_VERSION@version.mjs', file: 'version.mjs', line: 9, expected: 'dev 3.0.0', actual: 'dev 3.0.1', hint: '跑 npm run kit:sync', reason: null, message: null, baselinedFrom: null },
      { rule: 'CT8', severity: 'yellow', subject: 'routes ANY /app-info', file: null, line: null, expected: 'HEAD 缺', actual: '工作树 有', hint: '在途差异只报不拦', reason: null, message: null, baselinedFrom: null },
      { rule: 'CT9', severity: 'baselined', subject: '/worktree/create', file: 'src/components/worktree/WorktreePanel.tsx', line: 60, expected: 'server 路由里有', actual: '无', hint: '补端点或改前端路径', reason: 'D8 历史欠账（登记在 drift-baseline.json）', message: null, baselinedFrom: 'yellow' },
    ],
    ledgers: { versions: { lines: 4, contracts: 14, skills: 22, skillsLock: 20, commonTools: 98, channels: { routes: 103 } }, deps: { 'npm-runtime': 44 } },
    scope: { present: true, total: 2, keys: 2, groups: [{ kind: 'routes', ns: '/providers/', count: 1, docSection: '§7', reason: '没有具体子路径可写', problems: 0 }] },
    baseline: { count: 5, redCount: 0, matched: 1, entries: [{ rule: 'CT9', subject: '/worktree/create', severity: null, at: '2026-09-19' }] },
    versions: {
      lines: [{ id: 'APP_VERSION', label: 'Ponos 应用（turbo 内核版）', file: 'version.mjs', locator: { kind: 'const', name: 'APP_VERSION' }, value: 'dev 3.0.0' }],
      contracts: [{ id: 'VAULT_VERSION', value: 1, file: 'electron/vault.cjs', line: 21, kind: 'contract' }],
      history: { baselineCount: 5, baselineRedCount: 0, commonToolsBaseline: 98, records: [] },
      skills: [{ id: 'brainstorming', value: '1.0.0', file: 'public/sample-skills/brainstorming/SKILL.md' }],
      skillsLock: { source: 'skills-lock.json', field: 'computedHash', ids: ['brainstorming'] },
      commonTools: { baselineCount: 98, addedSinceBaseline: 0, entryCount: 98 },
      channels: {
        snapshotAt: '2026-09-20T00:25:40.836Z', routes: 103, routePrefixes: 7, wsOut: 27, wsIn: 16,
        ipc: { invoke: 61, handle: 61, send: 10, on: 17, push: 7, total: 156 },
        tools: 21, staticToolCount: 21, excluded: 49, scopeCount: 2, scopeRedCount: 2,
      },
    },
    deps: { domains: [{ id: 'npm-runtime', count: 44, packages: ['ws'], source: 'package.json' }], unused: [], ghost: [], sizes: { node_modules: 616137688 }, notes: null, unusedSource: 'rules', ghostSource: 'rules' },
    git: { branch: 'kit/p0-ledgers', head: 'd2407d6', headSubject: 'docs(loop): spec v2', dirtyTracked: 36, dirtyUntracked: 4, statusLines: 40, tagCount: 1, tagLatest: 'v3.0.0-dev.0', branches: { count: 45, items: ['main'] }, worktrees: [{ path: 'C:/x', branch: 'kit/p0-ledgers' }] },
    brand: {
      names: [{ id: 'product-name', label: '安装产品名 productName', file: 'electron-builder.yml', kind: 'yaml', value: 'YFWorking', line: 4 }],
      assets: [{ file: 'public/logo.png', kind: 'png', w: 512, h: 356, bytes: 61207 }, { file: 'public/icon.ico', kind: 'ico', w: null, h: null, bytes: 28366 }],
      consistency: [{ level: 'info', message: '中文品牌名与安装产品名不同' }, { level: 'warn', message: '名称声明点 appId 取不到值' }],
    },
    agent: AGENT_GUIDE,
    warnings: ['读不到 kit/manifest/foo.json（该段留空）'],
  }
  return { ...base, ...overrides }
}

/** 从产物里抠出内联的 JSON 数据块（等价于页面里的 getElementById('kit-data').textContent） */
function dataBlock(html) {
  const mark = 'id="kit-data">'
  const start = html.indexOf(mark)
  assert.ok(start >= 0, '产物里必须有 id="kit-data" 的数据块')
  const from = start + mark.length
  const end = html.indexOf('</script>', from)
  assert.ok(end > from, '数据块必须有结束标签')
  return html.slice(from, end)
}

test('零外链：无 http(s)、无 src=、无 <link>/<img>、无 fetch/XHR；href 只允许页内锚点', () => {
  const html = renderGuiHtml(makeData())
  assert.equal(html.match(/https?:\/\//g), null, '产物里不许出现 http(s) 字样')
  assert.equal(html.match(/\ssrc=/g), null, '产物里不许出现 src= 属性')
  assert.equal(html.match(/<link/gi), null, '不许有 <link>（样式必须内联）')
  assert.equal(html.match(/<img/gi), null, '不许有 <img>（页面不加载任何图片：标识资源清单只列元数据）')
  assert.equal(html.match(/fetch\(/g), null, '不许 fetch（页面不取任何远程数据）')
  assert.equal(html.match(/XMLHttpRequest/g), null, '不许 XMLHttpRequest')
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
  assert.ok(hrefs.length >= GUI_SECTIONS.length, '侧边导航必须有锚点')
  for (const h of hrefs) assert.match(h, /^#/, `href 只允许页内锚点，实际：${h}`)
  // 反向自证：上面那条"href 只允许锚点"要能真的失败 —— 造一个外链数据不该让它变绿，但真外链一定被它抓住
  assert.equal(renderGuiHtml(makeData()).includes('http'), html.includes('http'), '同一份输入两次渲染必须一致')
})

test('数据内联：`</script>`/`://`/U+2028 都被转义，且 JSON.parse 后**逐值还原**', () => {
  const nasty = '</script><script>alert(1)</script>'
  const data = makeData({
    findings: [{
      rule: 'ZZZ', severity: 'red', subject: nasty,
      file: 'a.mjs', line: 1, expected: 'http://evil.example/x', actual: 'https://evil.example/y',
      hint: '含 U+2028 的行分隔符：\u2028 与 U+2029：\u2029', reason: null, message: nasty, baselinedFrom: null,
    }],
  })
  const html = renderGuiHtml(data)
  const block = dataBlock(html)
  assert.ok(!block.includes('</script>'), '数据块内部不许出现 </script>')
  assert.ok(block.includes('<\\/script>'), '`</` 必须转义成 `<\\/`（否则页面白屏）')
  assert.ok(!block.includes('http://') && !block.includes('https://'), '`://` 必须转义（否则"零外链"无法机械校验）')
  assert.ok(block.includes(':\\/\\/'), '`://` 的转义形态必须存在')
  assert.ok(!/[\u2028\u2029]/.test(block), 'U+2028/2029 必须转义（JS 源码里它们是换行符）')
  // ★ 关键：转义是**可逆**的 —— 页面 JSON.parse 之后拿到的值必须与原始数据逐字相等
  const parsed = JSON.parse(block)
  assert.equal(parsed.findings[0].subject, nasty)
  assert.equal(parsed.findings[0].expected, 'http://evil.example/x')
  assert.equal(parsed.findings[0].hint, '含 U+2028 的行分隔符：\u2028 与 U+2029：\u2029')
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(data)), '内联数据必须与原始数据等价')
  // 转义函数的单点断言（`<\\/` 与 `:\\/\\/` 两种形态各一眼可见）
  assert.equal(inlineJsonText({ s: '</script>' }), '{"s":"<\\/script>"}')
  assert.equal(inlineJsonText({ s: 'http://x' }), '{"s":"http:\\/\\/x"}')
})

test('骨架：charset/lang/title、八个段标题、侧边锚点导航、顶部结论条、打印友好', () => {
  const html = renderGuiHtml(makeData())
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('<meta charset="utf-8">'))
  assert.ok(html.includes('<html lang="zh-CN">'))
  assert.ok(html.includes('<title>DevKit 报告 · 门禁未通过'))
  for (const s of GUI_SECTIONS) {
    assert.ok(html.includes(`<section id="${s.id}">`), `缺段：${s.id}`)
    assert.ok(html.includes(`<h2>${s.title}</h2>`), `缺段标题：${s.title}`)
    assert.ok(html.includes(`href="#${s.id}"`), `缺导航锚点：${s.id}`)
  }
  assert.equal(GUI_SECTIONS.length, 8, '八段视图（少一段或多一段都要有人显式改这条）')
  // 顶部结论条：红/黄/基线/green/rules/EXIT 与生成时间都得在
  for (const chip of ['EXIT=1', '红 1', '黄 1', '基线 1', 'green 3 / rules 5', '生成 2026-09-20T00:00:00.000Z']) {
    assert.ok(html.includes(chip), `顶部结论条缺：${chip}`)
  }
  assert.ok(html.includes('@media print'), '打印样式段必须存在')
  assert.ok(html.includes('prefers-color-scheme'), '浅色/深色必须按系统偏好切换（不引主题系统）')
  assert.ok(html.includes('<noscript>'), '无 JS 时必须给提示')
})

test('findings 段：默认全量渲染（含 baselined 与理由）、筛选控件齐备、宽表可横向滚动', () => {
  const html = renderGuiHtml(makeData())
  // 全量：三条 finding 的 subject 都在（无 JS 时也能全部看到 ⇒ 筛选只是渐进增强）
  for (const s of ['APP_VERSION@version.mjs', 'routes ANY /app-info', '/worktree/create']) {
    assert.ok(html.includes(s), `默认渲染必须含：${s}`)
  }
  assert.ok(html.includes('D8 历史欠账（登记在 drift-baseline.json）'), 'baselined 行必须显示基线理由')
  assert.ok(html.includes('原为黄（提示）'), 'baselined 行必须显示它原本是什么颜色的欠账')
  assert.ok(html.includes('class="f-sev"') && html.includes('class="f-rule"'), '筛选控件（severity/rule）必须存在')
  assert.ok(html.includes('id="findings-table"'), '筛选脚本要按 id 取行')
  assert.ok(html.includes('src/components/worktree/WorktreePanel.tsx:60'), 'file:line 必须拼成一行显示')
  assert.ok(html.includes('class="scroll"'), '表格必须包在可横向滚动的容器里（不破版）')
  // 黄灯类规则「只报不拦」必须显式标注（否则读者会把 passed=false 读成门禁失败）
  assert.ok(html.includes('只报不拦'))
})

test('台账/依赖域/版本控制/品牌 四段：缺数据时**显式说明**而不是留空白', () => {
  const html = renderGuiHtml(makeData())
  // 版本控制：CLI 命令与 version-manager 指路说明
  assert.ok(html.includes('node scripts/bump-version.mjs'))
  assert.ok(html.includes('npm run kit:sync'))
  assert.ok(html.includes('refs/yfw/snap'), '必须指向影子引用快照')
  assert.ok(html.includes('docs/superpowers/specs/2026-09-15-version-manager-design.md'))
  assert.ok(html.includes('只读展示'), '必须写明 GUI 只读展示、不重复实现')
  // 台账：channels 计数与 snapshotAt（committed 口径）
  assert.ok(html.includes('2026-09-20T00:25:40.836Z'))
  assert.ok(html.includes('committed 口径'))
  // 依赖域：notes 无 ⇒ 说明；sizes 在 ⇒ 表格里有键
  assert.ok(html.includes('没有 notes 段'), 'notes 为空必须说明"无则说明"')
  assert.ok(html.includes('node_modules'))
  // 品牌：只读汇总 + 本批不加门禁规则 + warn 醒目
  assert.ok(html.includes('本视图<b>只读汇总</b>'))
  assert.ok(html.includes('本批不加门禁规则'))
  assert.ok(html.includes('class="bad">warn'), 'warn 必须用醒目色')
  assert.ok(html.includes('public/icon.ico') && html.includes('—'), 'ico 尺寸列显示 —（不假装有尺寸）')

  // scope 缺失（present:false）必须显式说明，而不是当作"没有范围"
  const noScope = renderGuiHtml(makeData({ scope: { present: false, total: 0, keys: 0, groups: [] } }))
  assert.ok(noScope.includes('登记文件不存在'))
  assert.ok(noScope.includes('这不等于"没有范围"'))
  // 空 findings 也要有显式说明（空表会被读成"页面坏了"）
  assert.ok(renderGuiHtml(makeData({ findings: [] })).includes('findings 为空'))
})

test('Agent 段：顶部指路 + 四段条目 + cmd 可一键复制 + 铁律', () => {
  const html = renderGuiHtml(makeData())
  // 属性里的转义规则（`data-copy` 是 HTML 属性：引号/尖括号必须转义，否则属性被提前闭合）
  const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  assert.ok(html.includes('node kit/gui.mjs --agent'), '顶部必须给 agent 的纯文本出口')
  assert.ok(html.includes('本页数据即 agent 读取的同一份真源'))
  for (const s of AGENT_GUIDE.sections) {
    assert.ok(html.includes(`<div class="card-h">${s.title}（${s.items.length} 条）`), `缺段：${s.title}`)
    for (const item of s.items) {
      assert.ok(html.includes(escAttr(item.do)), `缺条目 do：${item.do.slice(0, 24)}`)
      assert.ok(html.includes(escAttr(item.why.slice(0, 40))), `缺条目 why：${item.why.slice(0, 24)}`)
      if (item.cmd) assert.ok(html.includes(`data-copy="${escAttr(item.cmd)}"`), `缺 cmd 的复制按钮：${item.cmd}`)
    }
  }
  for (const r of AGENT_GUIDE.ironRules) assert.ok(html.includes(escAttr(r.slice(0, 20))), `四条铁律必须逐条渲染：${r.slice(0, 16)}`)
  assert.ok(html.includes(`${AGENT_GUIDE.ci.file}:${AGENT_GUIDE.ci.line}`), 'CI 锚点（文件:行号）必须显示')
  // 复制按钮的降级路径必须存在（clipboard 不可用时不报错，退回 select）
  assert.ok(html.includes('navigator.clipboard') && html.includes('createRange'))
  assert.ok(!html.includes('alert('), '复制失败不许弹窗打断阅读')
})

test('真仓数据端到端渲染：产物仍满足零外链/可解析/八段齐全', () => {
  // 真仓台账 + 一份最小 checkJson（**不跑门禁**：那 2.5s+ 的开销由 gui.test.mjs 的端到端用例承担）
  const checkJson = { ok: true, exitCode: 0, summary: { red: 0, yellow: 5, baselined: 5, green: 29, rules: 31 }, checks: [], findings: JSON.parse(readFileSync(join(ROOT, 'kit/manifest/drift-baseline.json'), 'utf8')).entries }
  const data = buildGuiData({ root: ROOT, checkJson, viewJson: null, now: '2026-09-20T00:00:00.000Z' })
  const html = renderGuiHtml(data)
  assert.equal(html.match(/https?:\/\//g), null)
  assert.equal(html.match(/\ssrc=/g), null)
  const parsed = JSON.parse(dataBlock(html))
  assert.equal(parsed.brand.names.length, 7, '真仓 7 条名称声明点都要在')
  assert.ok(parsed.brand.assets.length >= 10, '真仓标识资源清单不应为空')
  for (const s of GUI_SECTIONS) assert.ok(html.includes(`<h2>${s.title}</h2>`))
  assert.ok(html.length > 20000 && html.length < 3 * 1024 * 1024, `体积应在一个合理区间，实际 ${html.length}`)
})
