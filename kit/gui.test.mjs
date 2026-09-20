// kit/gui.test.mjs —— CLI 入口的端到端判据（真仓跑一次；含"退出码语义"这条最容易搞反的性质）
//
// 为什么放在 kit/ 而不是 kit/lib/：这份测试跑的是 `node kit/gui.mjs` 进程本身（与 kit/cli.test.mjs 同族），
// 判据是**命令行契约**（退出码 / stdout 文案 / 产物落盘），不是某个 lib 函数的返回值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GUI = 'kit/gui.mjs'

/** 跑 CLI；`execFileSync` 在非零退出时**抛错** ⇒ "不抛错"就是"exit 0"（下面每条 happy path 都依赖这条） */
function runGui(args, opts = {}) {
  return execFileSync(process.execPath, [GUI, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...opts })
}

const EIGHT_TITLES = ['概览', '红灯与黄灯', '规则矩阵', '台账', '依赖域', '版本控制', '品牌标识与名称', 'Agent 套件规范']

function tmpFile(t, name) {
  const dir = mkdtempSync(join(tmpdir(), 'kitgui-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  return join(dir, name)
}

test('端到端：--out 到临时路径 ⇒ 生成 HTML、exit 0、八个段标题与数据块都在', (t) => {
  const out = tmpFile(t, 'report.html')
  const stdout = runGui(['--out', out])
  assert.ok(existsSync(out), '产物必须落盘')
  // 一行结果（含绝对路径 / KB / 红黄数）
  assert.match(stdout, /^已生成 .+（[\d.]+ KB，红灯 \d+ \/ 黄灯 \d+）$/m)
  // ★ 门禁结论必须显式写出：GUI 自己恒 exit 0，不写这行的话调用方会把"报告生成成功"读成"仓库是绿的"
  assert.match(stdout, /^门禁结论：红 (\d+) ⇒ EXIT=([01])/m)
  const red = Number(/门禁结论：红 (\d+)/.exec(stdout)[1])
  assert.equal(red, 0, '本仓当前应无红灯（有红灯时这条会红，提示先修门禁再验收 GUI）')
  assert.ok(stdout.includes(`EXIT=0`) && stdout.includes('node kit/cli.mjs check --json'), '结论行须自报数据源')
  const html = readFileSync(out, 'utf8')
  for (const title of EIGHT_TITLES) assert.ok(html.includes(`<h2>${title}</h2>`), `缺段：${title}`)
  assert.ok(html.includes('id="kit-data"'), '必须内联数据块')
  assert.ok(html.includes('application/json'), '数据块须声明 JSON（否则浏览器不把它当数据）')
  // 端到端也要守住"零外链"（这是交付承诺，不能只在 lib 层测）
  assert.equal(html.match(/https?:\/\//g), null)
  assert.equal(html.match(/\ssrc=/g), null)
  // 抠数据块：与页面里的 `getElementById('kit-data').textContent` 等价（偏移量用长度算，不写死魔数）
  const mark = 'id="kit-data">'
  const from = html.indexOf(mark) + mark.length
  const parsed = JSON.parse(html.slice(from, html.indexOf('</script>', from)))
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.gate.exitCode, 0, '页面顶部的 EXIT 必须与真实退出码一致')
  assert.equal(parsed.brand.names.length, 7)
  assert.ok(parsed.agent.sections.length === 4, 'agent 规范随数据一起进页面')
})

test('--json：把数据包打到 stdout（不写 HTML），体积 < 2MB', (t) => {
  const out = tmpFile(t, 'should-not-exist.html')
  const stdout = runGui(['--json', '--out', out])
  assert.ok(!existsSync(out), '--json 不许写 HTML（否则"只输出"的语义被破坏）')
  const data = JSON.parse(stdout)
  assert.deepEqual(Object.keys(data), ['schemaVersion', 'generatedAt', 'gate', 'findings', 'ledgers', 'scope', 'baseline', 'versions', 'deps', 'git', 'brand', 'agent', 'warnings'])
  assert.ok(Buffer.byteLength(stdout, 'utf8') < 2 * 1024 * 1024, `体积必须 < 2MB，实际 ${Buffer.byteLength(stdout)}`)
  assert.ok(data.versions.channels.routes > 0, '真仓契约快照计数必须 > 0')
})

test('--agent：纯文本规范（含四段标题与 cmd 行）', () => {
  const stdout = runGui(['--agent'])
  const lines = stdout.split('\n')
  assert.equal(lines[0], 'DevKit agent 套件规范 v1（真源：kit/lib/agent-guide.mjs；GUI 视图见 kit-report.html）')
  for (const title of ['开工前（3 步）', '改动契约面时', '交付前（缺一不可）', '红灯怎么修']) {
    assert.ok(stdout.includes(title), `缺段：${title}`)
  }
  assert.ok(stdout.includes('$ npm run kit:check'), '每条 cmd 必须单独成行（可复制去跑）')
  assert.ok(stdout.includes('CI 锚点：.github/workflows/ci.yml:72'), 'CI 锚点必须写明文件与行号')
})

test('未知参数 ⇒ 打 usage 且 exit 2（不静默成功）', () => {
  let status = null
  let stderr = ''
  try {
    runGui(['--bogus'], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    status = e.status
    stderr = String(e.stderr || '')
  }
  assert.equal(status, 2, '未知参数必须 exit 2')
  assert.ok(stderr.includes('未知参数：--bogus'), '必须点名是哪个参数')
  assert.ok(stderr.includes('用法：node kit/gui.mjs'), '必须打出 usage')
  // --out 缺值也要走同一条出口（而不是把下一个参数当路径吞掉）；stderr 收进管道，别把 usage 刷进测试输出
  let status2 = null
  try {
    runGui(['--out', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    status2 = e.status
  }
  assert.equal(status2, 2)
})
