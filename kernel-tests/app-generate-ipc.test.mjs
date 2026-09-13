// 生成链路端到端（假 LLM + 假执行器 + 假 webContents）：验证进度事件、不落盘、试跑口径
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const home = mkdtempSync(join(tmpdir(), 'appgen-'))
process.env.YFWORKING_HOME = home
delete process.env.CLAUDE_CONFIG_DIR

const { registerAppHandlers } = require('../electron/app-ipc.cjs')

const SPEC_TEXT = JSON.stringify({
  specVersion: 1, appId: 'x', name: '示例站',
  target: { type: 'web', url: 'https://example.com' },
  expose: { mode: 'console' },
  commands: [
    { action: 'listRecent', title: '最近列表', kind: 'read', params: [], steps: [{ act: 'goto', url: '/recent' }, { act: 'snapshot', save: 'result' }] },
    { action: 'submit', title: '提交', kind: 'write', params: [], steps: [{ act: 'click', selector: '#ok' }] },
  ],
})

/** 默认"后台取页面素材"的成功响应：一份素材充足的静态 HTML */
const RICH_HTML = `<!doctype html><html><head><title>示例站</title></head><body>
<form id="f" action="/search"><input name="q" placeholder="关键词"><input name="page" placeholder="页码"><button type="submit">查询</button></form>
<button id="exportBtn">导出</button>
<a href="/recent">最近记录</a><a href="/help">帮助</a></body></html>`
/** 只含一个标题的薄页面（细到不足以写命令） */
const THIN_HTML = '<!doctype html><html><head><title>空壳</title></head><body><div id="root"></div></body></html>'

function setup({ llm, exec, fetch: fetchImpl, executor } = {}) {
  const handlers = new Map()
  const events = []
  const ipcMain = { handle: (c, f) => handlers.set(c, f) }
  const webContents = { send: (ch, payload) => events.push([ch, payload]) }
  // 默认注入"成功取回富素材"，让测试走主路径（后台 HTTP）；绝不能真打外网
  const fetchStub = fetchImpl || (async () => ({ ok: true, status: 200, url: 'https://example.com/', headers: { get: () => 'text/html; charset=utf-8' }, text: async () => RICH_HTML }))
  registerAppHandlers({
    ipcMain,
    getExecutor: () => (executor !== undefined ? executor : { exec: exec || (async () => ({ ok: true, snapshot: { page: { title: 'T' }, text: 'body' } })) }),
    getWebContents: () => webContents,
    deps: {
      callLlm: llm || (async () => ({ ok: true, text: SPEC_TEXT, error: null, chars: SPEC_TEXT.length })),
      fetchImpl: fetchStub,
    },
  })
  return {
    invoke: (ch, ...a) => handlers.get(ch)({}, ...a),
    events,
    phases: () => events.filter(([ch]) => ch === 'app:generate-progress').map(([, p]) => p.phase),
    details: () => events.filter(([ch]) => ch === 'app:generate-progress').map(([, p]) => p.detail).filter(Boolean),
  }
}

/** 造一个"取页面失败"的 fetch（超时/被拒/非网页都归到这里） */
const failFetch = (msg = '取页面失败：连接被拒绝') => async () => { throw new Error(msg) }

test('app:generate 全链路：后台取素材 → 生成 → 试跑，并逐阶段上报真实进度', async () => {
  const t = setup()
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.driver, 'browser')
  assert.equal(r.probe.mode, 'http', '非白名单站点走后台取素材，不开浏览器')
  assert.equal(r.spec.commands.length, 2)
  assert.equal(r.verify.ok, true)
  assert.deepEqual(r.verify.tried, ['listRecent'], '只试跑无需参数的 read')
  assert.deepEqual(r.verify.notRun, ['submit'], 'write 绝不试跑')

  const phases = t.phases()
  for (const must of ['fetch', 'round', 'parse', 'parsed', 'verify', 'done']) {
    assert.ok(phases.includes(must), `进度事件缺少阶段 ${must}（实际：${phases.join(',')}）`)
  }
})

test('app:generate：白名单站点 + 静态素材不足 → 用浏览器取真实 DOM（增强而非门槛）', async () => {
  const t = setup({
    fetch: async () => ({ ok: true, status: 200, url: 'http://127.0.0.1:9/x', headers: { get: () => 'text/html' }, text: async () => THIN_HTML }),
    exec: async () => ({ ok: true, snapshot: { page: { title: '本地系统', url: 'http://127.0.0.1:9/x' }, interactives: [{ ref: 1, tag: 'button', label: '查询' }] } }),
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'http://127.0.0.1:9/x' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.probe.mode, 'browser', '白名单域名才有浏览器增强')
  assert.ok(t.phases().includes('probe'))
})

test('app:generate 不落盘：生成结果必须等用户确认后才写', async () => {
  const t = setup()
  await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(existsSync(join(home, 'apps', 'x', 'spec.json')), false, '生成不得写 spec.json')
  assert.equal(existsSync(join(home, 'apps', 'x', 'history')), false, '试跑也不得留执行记录（应用尚未存在）')
})

test('app:generate：模型调用失败 → ok=false 且人话原因（进度以 error 收尾）', async () => {
  const t = setup({ llm: async () => ({ ok: false, text: '', error: '模型接口 401：invalid key' }) })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('401'))
  assert.ok(t.phases().includes('error'))
})

test('app:generate：非白名单站点 → 用户填的网址被显式授权，试跑不再被白名单拦下', async () => {
  // 真机验收（kimi.com）暴露的断点：生成走后台 HTTP 没问题，但生成后的**试跑**会经
  // BrowserExecutor → 白名单被拦（"目标域名不在白名单…已拒绝导航"），导致命令永远"未验证"。
  // 契约：用户在界面填的网址 = 显式授权；agent 自主浏览仍受原白名单约束（见下一个用例）。
  const { isWhitelisted } = require('../electron/browser-common.cjs')
  assert.equal(isWhitelisted('https://app-not-whitelisted.example/'), false, '前置：该域名本来不在白名单')
  // 模拟真实 BrowserExecutor 的导航行为：非白名单直接拒绝；相对路径按当前页解析（与真执行器一致）
  const exec = async (_s, act, p) => {
    const abs = (u) => (/^https?:/i.test(u) ? u : new URL(u, 'https://app-not-whitelisted.example/x').toString())
    if (act === 'goto' && !isWhitelisted(abs(p.url))) return { ok: false, error: `目标域名不在白名单（默认 *.gov.cn/localhost），已拒绝导航: ${abs(p.url)}` }
    return { ok: true, snapshot: { page: { title: 'T', url: abs(p.url) }, info: [], interactives: [] } }
  }
  const t = setup({ exec })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://app-not-whitelisted.example/x' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.verify.ok, true, `试跑应通过（失败明细：${JSON.stringify(r.verify.failures)}）`)
  assert.equal(isWhitelisted('https://app-not-whitelisted.example/'), true, '授权后该精确主机名可通过')
})

test('显式授权只覆盖精确主机名：不扩散到同域其它主机，也不改默认白名单', async () => {
  const { isWhitelisted, authorizeAppTarget } = (() => {
    const common = require('../electron/browser-common.cjs')
    const ipc = require('../electron/app-ipc.cjs')
    return { ...common, authorizeAppTarget: ipc.authorizeAppTarget }
  })()
  assert.equal(authorizeAppTarget({ type: 'web', url: 'https://only-this-host-check.example/a/b?c=1' }), 'only-this-host-check.example')
  assert.equal(isWhitelisted('https://only-this-host-check.example/other'), true, '路径不同仍属同一主机 → 授权')
  assert.equal(isWhitelisted('https://sub.only-this-host-check.example/'), false, '不扩散到子域')
  assert.equal(isWhitelisted('https://another-host.example/'), false, '不扩散到其它域名')
  assert.equal(isWhitelisted('https://evil.gov.cn.attacker.com/'), false, 'gov.cn 后缀伪造仍须被拒')
  assert.equal(authorizeAppTarget({ type: 'desktop', exePath: 'C:/x.exe' }), null, '桌面目标不动白名单')
  assert.equal(authorizeAppTarget({ type: 'web', url: '不是网址' }), null, '不合法网址不授权')
})

test('app:generate：取素材失败 → **不再中止**，降级为"靠常识推断"并如实标注', async () => {
  // 真实反馈驱动的契约变更：原先取不到页面素材就整个失败（且必须过浏览器白名单，
  // 导致 kimi.com 这类站点根本没法生成命令）。现在照样生成，只是不假装探测过。
  const t = setup({ fetch: failFetch('取页面失败：目标域名不在白名单') })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://blocked.example' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true, '取素材失败不得中断生成')
  assert.equal(r.probe.mode, 'none', '没素材就要如实标 none')
  assert.ok(r.probe.note.includes('白名单'), '失败原因要如实带上')
  assert.ok(t.phases().includes('round'), '应继续请求模型')
  assert.ok(t.details().some((d) => d.includes('公开了解') || d.includes('人工核对')), '进度要说明是推断的')
})

test('app:generate：白名单站点浏览器探测也失败 → 仍继续，并如实说明', async () => {
  const t = setup({
    fetch: failFetch('取页面失败：连接被拒绝'),
    exec: async (_s, act) => (act === 'goto' ? { ok: false, error: '域名被拦截' } : { ok: true, snapshot: {} }),
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'http://127.0.0.1:9/x' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.probe.mode, 'none')
  assert.ok(r.probe.note.includes('拦截'), '要带上浏览器侧的失败原因')
  assert.ok(t.phases().includes('probe'), '走过浏览器增强分支')
  assert.ok(t.details().some((d) => d.includes('继续用静态素材') || d.includes('未成功')))
})

test('app:generate：执行器未就绪不再报错——后台取素材即可完成生成', async () => {
  const handlers = new Map()
  const fetchStub = async () => ({ ok: true, status: 200, url: 'https://a.com/', headers: { get: () => 'text/html' }, text: async () => RICH_HTML })
  const SPEC = JSON.stringify({ specVersion: 1, appId: 'x', name: 'n', target: { type: 'web', url: 'https://a.com' }, expose: { mode: 'console' }, commands: [{ action: 'list', title: '列表', kind: 'read', params: [], steps: [{ act: 'goto', url: '/' }, { act: 'snapshot', save: 'r' }] }] })
  registerAppHandlers({
    ipcMain: { handle: (c, f) => handlers.set(c, f) },
    getExecutor: () => null,
    getWebContents: () => null,
    deps: { callLlm: async () => ({ ok: true, text: SPEC, error: null }), fetchImpl: fetchStub },
  })
  const r = await handlers.get('app:generate')({}, { target: { type: 'web', url: 'https://a.com' }, appId: 'x' })
  assert.equal(r.ok, true, '没有浏览器执行器也能生成（素材来自后台 HTTP）')
  assert.equal(r.probe.mode, 'http')
})

test('app:generate：目标不合法 → 明确报错（不做无谓探测）', async () => {
  const t = setup()
  const r = await t.invoke('app:generate', { target: { type: 'weird' }, appId: 'x' })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('目标不合法'))
})

test('app:generate：试跑失败 → 返回失败明细（界面据此禁止保存）', async () => {
  const t = setup({ exec: async (_s, act) => (act === 'snapshot' ? { ok: false, error: '选择器没找到' } : { ok: true, snapshot: { page: {} } }) })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true, '生成本身成功')
  assert.equal(r.verify.ok, false, '试跑失败')
  assert.ok(r.verify.failures[0].error.includes('选择器'))
  assert.ok(t.details().some((d) => d.includes('试跑未通过')), '进度事件应如实说明试跑未通过')
})

test('app:generate：模型返回非法 JSON → 回喂多轮后失败，轮数与错误都回传', async () => {
  let calls = 0
  const t = setup({ llm: async () => { calls += 1; return { ok: true, text: '不是 JSON', error: null } } })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, false)
  assert.equal(calls, 3, '最多 3 轮')
  assert.equal(r.rounds, 3)
  assert.ok(r.issues.some((i) => i.includes('不是合法 JSON')))
})

test.after(() => { rmSync(home, { recursive: true, force: true }) })
