// kit/lib/gui-data.test.mjs —— GUI 数据组装的判据（夹具注入；**不跑真仓门禁**，故快且稳定）
//
// 夹具走**临时目录**（`mkdtempSync(join(tmpdir(), ...))`）：品牌探针/台账读取全都是"按 root 拼路径"，
// 于是同一套断言既能钉住真仓事实（H 段），也能在临时目录里造出真仓没有的形态
// （缺 appId、CRLF、findings 为空…）—— 后者是"这条断言能失败"的前提。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_GUIDE, renderAgentGuideText } from './agent-guide.mjs'
import { buildGuiData, collectGitInfo } from './gui-data.mjs'
import { renderGuiHtml } from './gui-html.mjs'

/** kit/lib → 仓库根（本测试要复核实仓文件时用） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 写一套夹具文件（返回临时目录；目录由调用方在 t.after 里删） */
function makeFixture(files, { crlf = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kitgui-data-'))
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, crlf ? text.replace(/\n/g, '\r\n') : text)
  }
  return dir
}

function cleanup(t, dir) {
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
}

/** 一套"四类声明点齐全"的夹具（行号刻意各不相同，好钉住"行号取自真文件的行扫描"） */
const FULL_FILES = {
  'package.json': '{\n  "name": "fixture-pkg",\n  "version": "9.9.9"\n}\n',
  'electron-builder.yml': '# 身份\nappId: com.example.fixture\nproductName: FixtureApp\n',
  'index.html': '<!doctype html>\n<html><head><title>Fixture 窗口</title></head></html>\n',
  'version.mjs': "// 版本线\nexport const APP_VERSION = 'dev 7.7.7'\nexport const KERNEL_VERSION = 'dev 1.1'\n",
}

const valueOf = (data, id) => data.brand.names.find((n) => n.id === id)?.value
const lineOf = (data, id) => data.brand.names.find((n) => n.id === id)?.line

test('品牌探针：7 条取值与**行号**都取自真文件（含 CRLF 夹具）', (t) => {
  const dir = makeFixture(FULL_FILES, { crlf: true })
  cleanup(t, dir)
  const data = buildGuiData({ root: dir })
  assert.equal(valueOf(data, 'pkg-name'), 'fixture-pkg')
  assert.equal(valueOf(data, 'pkg-version'), '9.9.9')
  assert.equal(valueOf(data, 'app-id'), 'com.example.fixture')
  assert.equal(valueOf(data, 'product-name'), 'FixtureApp')
  assert.equal(valueOf(data, 'window-title'), 'Fixture 窗口')
  assert.equal(valueOf(data, 'app-version'), 'dev 7.7.7')
  assert.equal(valueOf(data, 'kernel-version'), 'dev 1.1')
  // 行号必须是**真文件里的行**（`(.*)$` 在 CRLF 行上不命中 ⇒ 这里会一起红，是刻意的哨兵）
  assert.equal(lineOf(data, 'pkg-name'), 2)
  assert.equal(lineOf(data, 'pkg-version'), 3)
  assert.equal(lineOf(data, 'app-id'), 2)
  assert.equal(lineOf(data, 'product-name'), 3)
  assert.equal(lineOf(data, 'window-title'), 2)
  assert.equal(lineOf(data, 'app-version'), 2)
  assert.equal(lineOf(data, 'kernel-version'), 3)
  // 齐全 ⇒ 一致性里不该出现 warn（这条与下一条测试成对：缺了就得有 warn）
  assert.equal(data.brand.consistency.filter((c) => c.level === 'warn').length, 0)
})

test('品牌探针反向自证：夹具值改了 ⇒ 输出跟着变（不是写死的常量）', (t) => {
  const dir = makeFixture(FULL_FILES)
  cleanup(t, dir)
  const before = buildGuiData({ root: dir })
  // 逐类改值：JSON / YAML / HTML / JS 各一处（若探针写死了值，这里必然不等）
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "changed-pkg",\n  "version": "0.0.1"\n}\n')
  writeFileSync(join(dir, 'electron-builder.yml'), 'appId: com.changed.app\nproductName: ChangedApp\n')
  writeFileSync(join(dir, 'index.html'), '<title>Changed 窗口</title>\n')
  writeFileSync(join(dir, 'version.mjs'), "export const APP_VERSION = 'dev 8.8.8'\nexport const KERNEL_VERSION = 'dev 2.2'\n")
  const after = buildGuiData({ root: dir })
  for (const id of ['pkg-name', 'pkg-version', 'app-id', 'product-name', 'window-title', 'app-version', 'kernel-version']) {
    assert.notEqual(valueOf(after, id), valueOf(before, id), `${id} 未跟着夹具变化`)
  }
  assert.equal(valueOf(after, 'app-id'), 'com.changed.app')
  // 行号也变了（index.html 只剩 1 行 ⇒ window-title 落在第 1 行）
  assert.equal(lineOf(after, 'window-title'), 1)
})

test('品牌一致性：缺 appId ⇒ 出现 level:warn（并在 warnings 里留痕）', (t) => {
  const dir = makeFixture({
    ...FULL_FILES,
    // 只有 productName、没有 appId：真仓里"安装身份缺失"的最小形态
    'electron-builder.yml': '# 只有产品名\nproductName: FixtureApp\n',
  })
  cleanup(t, dir)
  const data = buildGuiData({ root: dir })
  assert.equal(valueOf(data, 'app-id'), null)
  const warns = data.brand.consistency.filter((c) => c.level === 'warn')
  assert.ok(warns.length >= 1, '缺 appId 必须报 warn')
  assert.ok(warns.some((c) => c.message.includes('app-id')), 'warn 必须点名是哪一条探针')
  assert.ok(data.warnings.some((w) => w.includes('app-id')), '取不到值要在 warnings 留痕（不能只在 consistency 里）')
})

// ── 品牌**真源**（本批新增：品牌标识与名称的统一管理）─────────────────────────

test('★ 品牌真源进数据：真仓 14 条声明点（每条带 why）+ 探针按 id 对齐 + "已统一管理/CT10 把关"那条 info', () => {
  const data = buildGuiData({ root: ROOT, checkJson: null })
  assert.deepEqual(data.brand.truth.layers.map((l) => [l.id, l.name]), [['app', 'YFWorking'], ['kernel', 'ponos']])
  assert.equal(data.brand.truth.declarations.length, 8, '8 条声明点都要在（少一条 = CT10 会红）')
  // 每条都要带 why（页面上要能回答"它为什么算声明点"，否则那格是空的、没人知道该不该改它）
  for (const dd of data.brand.truth.declarations) assert.ok(dd.why && dd.why.length > 8, `${dd.id} 缺 why`)
  // 对齐：能对齐的探针标 declId；对不齐的（发布线版本）保持 null —— 不硬凑
  const byId = new Map(data.brand.names.map((n) => [n.id, n.declId]))
  assert.deepEqual(
    ['product-name', 'window-title', 'app-id', 'pkg-name', 'app-version', 'kernel-version'].map((id) => byId.get(id)),
    ['product-name', 'window-title', 'app-id', 'npm-name', 'app-label', 'kernel-label'])
  assert.equal(byId.get('pkg-version'), null, '发布线版本不是品牌声明点 ⇒ 不对齐（对齐表只放一处：PROBE_DECLARATION）')
  // 废弃别名与已知广泛存在都要带进数据（页面第 2 块表要渲染它们）
  assert.equal(data.brand.truth.retiredAliases[0].alias, 'Ponos-Turbo')
  assert.equal(data.brand.truth.retiredAliases[0].replaceWith, 'ponos')
  // ★ 断言"规模取自真源"，但**不写死数字**（数字会漂移）：与真仓 brand.json 现读的值比对
  const wide = JSON.parse(readFileSync(new URL('../../kit/manifest/brand.json', import.meta.url), 'utf8')).knownWidespread[0]
  assert.deepEqual(data.brand.truth.knownWidespread[0].counts, wide.counts,
    '已知广泛存在的规模必须原样来自真源（页面不另写一份、也不改写数字）')
  // 先给结论：品牌已统一管理 + CT10 把关（不可基线豁免）
  assert.ok(data.brand.consistency.some((c) => c.level === 'info' && /CT10/.test(c.message) && /不可基线豁免/.test(c.message)),
    '一致性提示里必须有那条 info：真源位置 + CT10 把关 + 不可基线豁免')
})

test('品牌真源读不到：truth=null + warning（GUI 不崩，页面显式说明而不是留白）', (t) => {
  const dir = makeFixture(FULL_FILES)   // FULL_FILES 里没有 kit/manifest/brand.json
  cleanup(t, dir)
  const data = buildGuiData({ root: dir })
  assert.equal(data.brand.truth, null)
  assert.ok(data.warnings.some((w) => w.includes('kit/manifest/brand.json')), '读不到真源必须在 warnings 留痕')
  assert.ok(data.brand.consistency.some((c) => /读不到/.test(c.message)), '一致性提示要明说真源读不到')
})

test('brand 段还收 assets（PNG 读 IHDR 尺寸、.ico 只记字节数），缺文件记 warning 不抛错', (t) => {
  // 造一张 3×2 的合法 PNG 文件头（签名 + IHDR 长度/类型 + 宽 3 + 高 2），只为钉住"零依赖解析"这条判据
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]), Buffer.from('IHDR'),
    Buffer.from([0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x02]),
    Buffer.from([0x08, 0x06, 0x00, 0x00, 0x00]),
  ])
  const dir = mkdtempSync(join(tmpdir(), 'kitgui-data-'))
  cleanup(t, dir)
  mkdirSync(join(dir, 'public'), { recursive: true })
  writeFileSync(join(dir, 'public/logo.png'), png)
  writeFileSync(join(dir, 'public/icon.ico'), Buffer.alloc(37, 1))
  const data = buildGuiData({ root: dir })
  const logo = data.brand.assets.find((a) => a.file === 'public/logo.png')
  assert.deepEqual([logo.w, logo.h, logo.bytes, logo.kind], [3, 2, png.length, 'png'])
  const ico = data.brand.assets.find((a) => a.file === 'public/icon.ico')
  assert.deepEqual([ico.w, ico.h, ico.bytes, ico.kind], [null, null, 37, 'ico'])
  // 夹具里没有 docs/manual/images/logo_新远方数据LOGO.png ⇒ 记 warning 而不是抛错
  assert.ok(data.warnings.some((w) => w.includes('logo_新远方数据LOGO.png')))
})

test('collectGitInfo：非 git 目录**不抛错**，降级为 null/空 + warnings', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kitgui-nogit-'))
  cleanup(t, dir)
  const info = collectGitInfo({ root: dir })
  assert.equal(info.branch, null)
  assert.equal(info.head, null)
  assert.equal(info.tagCount, null)
  assert.deepEqual(info.worktrees, [])
  assert.ok(Array.isArray(info.warnings) && info.warnings.length >= 1, '失败必须留 warnings')
  assert.ok(info.warnings.every((w) => typeof w === 'string' && w.startsWith('git ')))
  // 同一函数在真仓上必须给出真值（否则"降级"就成了这个函数的唯一行为）
  const real = collectGitInfo({ root: ROOT })
  assert.ok(typeof real.branch === 'string' && real.branch.length > 0, '真仓必须取到分支')
  assert.match(real.head, /^[0-9a-f]{7,}$/)
  assert.ok(real.worktrees.length >= 1, '真仓至少有主工作树')
})

test('buildGuiData：台账缺失 ⇒ 留痕降级（不抛错、不假装有数据）', (t) => {
  const dir = makeFixture(FULL_FILES)
  cleanup(t, dir)
  const data = buildGuiData({ root: dir })
  assert.equal(data.versions.channels, null)
  assert.deepEqual(data.versions.lines, [])
  assert.deepEqual(data.deps.domains, [])
  assert.equal(data.baseline.count, 0)
  assert.ok(data.warnings.some((w) => w.includes('kit/manifest/versions.json')))
  assert.ok(data.warnings.some((w) => w.includes('kit/manifest/deps.json')))
  assert.ok(data.warnings.some((w) => w.includes('kit/manifest/drift-baseline.json')))
})

test('findings 稳健：空 findings 与 5 条基线 findings（含 baselinedFrom）都能渲染', () => {
  const baselined = ['/save-temp-image', '/worktree/create', '/worktree/remove', '/v1/chat/completions', '/v1/messages']
    .map((subject) => ({ rule: 'CT9', severity: 'baselined', subject, baselinedFrom: 'yellow', reason: 'D8 历史欠账（登记在 drift-baseline.json）' }))
  const empty = { ok: true, summary: { red: 0, yellow: 0, baselined: 0, green: 3, rules: 3 }, checks: [], findings: [] }
  const withBase = { ok: true, exitCode: 0, summary: { red: 0, yellow: 0, baselined: 5, green: 3, rules: 3 }, checks: [], findings: baselined }
  for (const [name, checkJson] of [['空 findings', empty], ['5 条基线', withBase]]) {
    const data = buildGuiData({ root: ROOT, checkJson, viewJson: { ledgers: null, scope: null }, now: '2026-09-20T00:00:00.000Z' })
    assert.equal(data.findings.length, checkJson.findings.length, name)
    const html = renderGuiHtml(data)
    assert.ok(html.includes('<h2>红灯与黄灯</h2>'), name)
    assert.ok(html.includes('红灯与黄灯'), name)
    if (checkJson.findings.length) {
      assert.equal(data.findings[0].baselinedFrom, 'yellow')
      // 基线理由必须显示（只显示 subject 会让人以为那是活红灯）
      assert.ok(html.includes('D8 历史欠账'), `${name}：baselinedFrom 的理由必须出现在页面里`)
      assert.ok(html.includes('/worktree/create'), name)
    } else {
      assert.ok(html.includes('findings 为空'), `${name}：空 findings 要有显式说明，而不是一张空表`)
    }
  }
})

test('buildGuiData：结果可 JSON round-trip（无 Set/Map/函数/循环）且 < 2MB（明细已被压掉）', () => {
  const check = JSON.parse(readFileSync(join(ROOT, 'kit/manifest/drift-baseline.json'), 'utf8'))
  const data = buildGuiData({
    root: ROOT,
    // 用台账自身当"假 findings"只为内容多样（含中文/引号/长文本），判据是形状不是语义
    checkJson: { ok: false, exitCode: 1, summary: { red: 1, yellow: 2, baselined: 5, green: 20, rules: 31 }, checks: [{ rule: 'CT1', title: '快照==现场重算', evaluated: 372, passed: true }], findings: check.entries },
    viewJson: { ledgers: { versions: { lines: 4 } }, scope: { present: true, total: 2, keys: 2, groups: [] } },
  })
  const text = JSON.stringify(data)
  const once = JSON.parse(text)
  // ★ 判据不是"能解析"（那是恒真），而是**再序列化后逐值相等**：Set/Map/函数/循环引用都会在这一步露馅
  //   （Set/Map 会被 stringify 成 `{}`，函数/undefined 键会被丢掉 ⇒ 两次结果不等）
  assert.deepEqual(JSON.parse(JSON.stringify(once)), once)
  assert.ok(text.length < 2 * 1024 * 1024, `体积必须 < 2MB，实际 ${text.length}`)
  const ledger = JSON.parse(readFileSync(join(ROOT, 'kit/manifest/versions.json'), 'utf8'))
  // 压缩的**反向**证据：明细确实被压成计数了（否则上面那条体积断言会以一种难解释的方式失败）。
  // ★ 期望值取自台账本身（不写死数字）：台账长一条明细，这里就跟着变 —— 门禁测试不该被"加了个工具/脚本"弄红。
  assert.equal(typeof data.versions.channels.routes, 'number')
  assert.equal(typeof data.versions.channels.ipc.total, 'number')
  assert.equal(data.versions.channels.tools, Object.keys(ledger.channels.tools).length)
  assert.equal(data.versions.commonTools.entryCount, ledger.commonTools.entries.length, 'commonTools 只留计数：条目数须等于台账 entries.length')
  assert.ok(!('entries' in data.versions.commonTools), 'commonTools.entries 明细不许进 GUI 数据')
  assert.ok(!JSON.stringify(data.versions.channels).includes('ANY '), 'channels 段不许含 routes 明细键')
  // 每一段都在（缺段说明组装漏了接线）
  assert.deepEqual(Object.keys(data), ['schemaVersion', 'generatedAt', 'gate', 'findings', 'ledgers', 'scope', 'baseline', 'versions', 'deps', 'git', 'brand', 'agent', 'warnings'])
})

test('agent 单一真源：文本含四段标题与每条 cmd；CI 锚点行号与 ci.yml 实际一致（**有牙齿**）', () => {
  const text = renderAgentGuideText(AGENT_GUIDE)
  assert.equal(AGENT_GUIDE.sections.length, 4)
  for (const s of AGENT_GUIDE.sections) {
    assert.ok(text.includes(s.title), `缺段落标题：${s.title}`)
    assert.ok(s.items.length >= 3, `${s.title} 的条目太少（规范不能只剩一句口号）`)
    for (const item of s.items) {
      assert.ok(text.includes(item.do), `缺条目：${item.do.slice(0, 30)}`)
      if (item.cmd) assert.ok(text.includes(item.cmd), `缺 cmd 行：${item.cmd}`)
    }
  }
  assert.equal(text.split('\n')[0], 'DevKit agent 套件规范 v1（真源：kit/lib/agent-guide.mjs；GUI 视图见 kit-report.html）')
  assert.ok(text.includes('不许放宽断言') && text.includes('不许恒真断言') && text.includes('不许 `|| true` 吞错') && text.includes('不许靠加基线让红变绿'))
  // ★ 真牙齿：CI 文件行号被改动 ⇒ 这条测试红（规范文本不允许"大概对"）
  const ci = readFileSync(join(ROOT, AGENT_GUIDE.ci.file), 'utf8').split('\n')
  const hit = ci.findIndex((l) => l.includes('npm run kit:check'))
  assert.ok(hit >= 0, 'ci.yml 里必须仍有 npm run kit:check 这一步')
  assert.equal(hit + 1, AGENT_GUIDE.ci.line, `AGENT_GUIDE.ci.line 与 ${AGENT_GUIDE.ci.file} 的实际行号不符`)
  assert.ok(ci[hit].includes('run:'), '锚点行必须是真的 run 行')
})
