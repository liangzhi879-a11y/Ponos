// 生成链路端到端（假 LLM + 假执行器 + 假 webContents）：验证进度事件、不落盘、试跑口径
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const home = mkdtempSync(join(tmpdir(), 'appgen-'))
process.env.YFWORKING_HOME = home
delete process.env.CLAUDE_CONFIG_DIR

const { registerAppHandlers, pickBlockerReasons, inferDriver } = require('../electron/app-ipc.cjs')
const { DRIVERS } = require('../electron/app-generate.cjs')

const SPEC_TEXT = JSON.stringify({
  specVersion: 1, appId: 'x', name: '示例站',
  target: { type: 'web', url: 'https://example.com' },
  expose: { mode: 'console' },
  commands: [
    { action: 'listRecent', title: '最近列表', kind: 'read', params: [], steps: [{ act: 'goto', url: '/recent' }, { act: 'snapshot', save: 'result' }] },
    { action: 'submit', title: '提交', kind: 'write', params: [], steps: [{ act: 'goto', url: '/new' }, { act: 'snapshot' }, { act: 'click', ref: 1 }] },
  ],
})

/** 默认"后台取页面素材"的成功响应：一份素材充足的静态 HTML */
const RICH_HTML = `<!doctype html><html><head><title>示例站</title></head><body>
<form id="f" action="/search"><input name="q" placeholder="关键词"><input name="page" placeholder="页码"><button type="submit">查询</button></form>
<button id="exportBtn">导出</button>
<a href="/recent">最近记录</a><a href="/help">帮助</a></body></html>`
/** 只含一个标题的薄页面（细到不足以写命令） */
const THIN_HTML = '<!doctype html><html><head><title>空壳</title></head><body><div id="root"></div></body></html>'

function setup({ llm, exec, fetch: fetchImpl, executor, deps } = {}) {
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
      // 额外注入点（如登录等待上限/轮询间隔 loginWaitMs/loginPollMs，见 Task 6 用例）
      ...(deps || {}),
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

test('显式授权：覆盖 apex↔www（站点会互跳），但不扩散到子域/其它域名/伪造后缀', async () => {
  const { isWhitelisted, authorizeAppTarget } = (() => {
    const common = require('../electron/browser-common.cjs')
    const ipc = require('../electron/app-ipc.cjs')
    return { ...common, authorizeAppTarget: ipc.authorizeAppTarget }
  })()
  // apex 与 www 都授权：网站几乎都会在两者间跳转（真机第二轮：kimi.com → www.kimi.com，
  // 只授权 apex 时模型按跳转后地址写出的命令仍被拦 → 试跑全红）
  const hosts = authorizeAppTarget({ type: 'web', url: 'https://only-this-host-check.example/a/b?c=1' })
  assert.deepEqual(hosts.sort(), ['only-this-host-check.example', 'www.only-this-host-check.example'])
  assert.equal(isWhitelisted('https://only-this-host-check.example/other'), true, '路径不同仍属同一主机 → 授权')
  assert.equal(isWhitelisted('https://www.only-this-host-check.example/'), true, 'www 变体要一并授权（跳转落点）')
  assert.equal(isWhitelisted('https://sub.only-this-host-check.example/'), false, '不扩散到子域')
  assert.equal(isWhitelisted('https://another-host.example/'), false, '不扩散到其它域名')
  assert.equal(isWhitelisted('https://evil.gov.cn.attacker.com/'), false, 'gov.cn 后缀伪造仍须被拒')
  assert.deepEqual(authorizeAppTarget({ type: 'desktop', exePath: 'C:/x.exe' }), [], '桌面目标不动白名单')
  assert.deepEqual(authorizeAppTarget({ type: 'web', url: '不是网址' }), [], '不合法网址不授权')
})

test('显式授权：额外授权跳转落点（extraUrls）', async () => {
  const { isWhitelisted } = require('../electron/browser-common.cjs')
  const { authorizeAppTarget } = require('../electron/app-ipc.cjs')
  const hosts = authorizeAppTarget({ type: 'web', url: 'https://landing-target.example/' }, { extraUrls: ['https://cdn-assets.example/x', null, '不是网址'] })
  assert.ok(hosts.includes('landing-target.example'))
  assert.ok(hosts.includes('cdn-assets.example'), '跳转落点要一并授权')
  assert.equal(isWhitelisted('https://cdn-assets.example/y'), true)
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

test('app:generate：模型输出始终无法解析 → 早停并如实报告（不耗满预算）', async () => {
  let calls = 0
  const t = setup({ llm: async () => { calls += 1; return { ok: true, text: '不是 JSON', error: null } } })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, false)
  assert.equal(calls, 3, '连续 3 次读不懂就早停，不空耗 24 轮预算')
  assert.equal(r.rounds, 3)
  assert.ok(r.issues.some((i) => i.includes('无法解析')), r.issues.join('｜'))
})

// ---------- 自主探索与自我调试（用户要求："给 LLM 框架，让它自己去充分探索和调试测试"） ----------
//
// 用户原话：固定脚本 LLM 自主度太低，完成不了普遍性任务；要给框架让它自己探索、自己调试，
// 并对封装格式质量提要求。下面这几条用例守的就是"框架真的把控制权交给了模型"：
//   · 模型能自己决定抓哪个页面（fetch_page），我们只如实把素材回喂；
//   · 模型能自己试跑命令（run_command）看到真实报错；
//   · 模型改好再提交（submit_spec）→ 真实试跑通过才算完成；
//   · 质量不达标会被打回；确定改不动时早停，绝不假装成功。

/** 按顺序回放脚本的假模型（用尽后重复最后一个），模拟"模型每轮做什么" */
const scriptLlm = (script) => {
  let i = 0
  return async () => {
    const text = script[Math.min(i, script.length - 1)]
    i += 1
    return { ok: true, text, error: null, chars: text.length }
  }
}
const submitTurn = (spec, thought = '写好了') => JSON.stringify({ thought, tool: 'submit_spec', spec })
const fetchTurn = (url) => JSON.stringify({ thought: '先看看这个页面', tool: 'fetch_page', args: { url } })
const runTurn = (action, args = {}) => JSON.stringify({ thought: '试跑一下', tool: 'run_command', args: { action, args } })

test('自主探索：模型自己抓页面 → 提交 → 真实试跑通过', async () => {
  const seenUsers = []
  let llmCalls = 0
  const t = setup({
    llm: async (p) => {
      seenUsers.push(p?.user || '')
      llmCalls += 1
      const script = [fetchTurn('https://example.com/detail/7'), submitTurn(JSON.parse(SPEC_TEXT))]
      const text = script[Math.min(llmCalls - 1, script.length - 1)]
      return { ok: true, text, error: null, chars: text.length }
    },
    exec: async () => ({ ok: true, snapshot: { page: { title: 'T' }, info: [] }, data: 'ok' }),
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.verify.ok, true, '真实试跑应通过')
  assert.equal(r.agent.toolCalls, 1, '模型应自己发起过 1 次页面抓取')
  assert.ok(r.agent.trace.some((x) => x.kind === 'tool' && x.tool === 'fetch_page'), '轨迹里要能看到模型的探索动作')
  // 抓到的素材必须**回喂**给模型（否则"自主探索"就是假的）
  assert.ok(seenUsers[1].includes('示例站') || seenUsers[1].includes('fetch_page'), `第二轮的上下文里应有抓取结果：${seenUsers[1].slice(-500)}`)
  assert.ok(t.details().some((d) => d.includes('抓取页面')), `进度里要如实展示模型在抓页面：${t.details().join(' | ')}`)
})

test('自我调试：试跑报错 → 模型用 run_command 查因 → 提交修订版 → 试跑通过', async () => {
  // 模拟真实情形：第一版忽略 js 要用 expression 字段，试跑报错；模型据此修正
  const badSpec = {
    specVersion: 1, appId: 'x', name: '示例站', target: { type: 'web', url: 'https://example.com' }, expose: { mode: 'console' },
    commands: [{ action: 'readText', title: '读正文', kind: 'read', params: [], steps: [{ act: 'goto', url: '/' }, { act: 'js', expression: 'document.body.innerText', save: 'r' }] }],
  }
  const brokenSpec = { ...badSpec, commands: [{ ...badSpec.commands[0], steps: [{ act: 'goto', url: '/' }, { act: 'js', code: 'document.body.innerText' }] }] }
  const script = [submitTurn(brokenSpec), runTurn('readText'), submitTurn(JSON.parse(SPEC_TEXT), '按报错修好了')]
  let gotoCalls = 0
  const t = setup({
    llm: scriptLlm(script),
    exec: async (_s, act) => {
      if (act === 'goto') { gotoCalls += 1; return { ok: true, snapshot: { page: { title: 'T' }, info: [] } } }
      return { ok: true, snapshot: { page: { title: 'T' }, info: [] }, data: '正文内容' }
    },
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.verify.ok, true, '修订后试跑应通过')
  assert.ok(r.agent.toolCalls >= 1, '模型应至少调用过一次工具（run_command 或 fetch_page）')
  assert.ok(t.details().some((d) => d.includes('试跑未通过') || d.includes('试跑命令')), `进度要如实反映试跑与调试：${t.details().join(' | ')}`)
  assert.ok(gotoCalls > 0, '应真的执行过试跑')
})

test('原地打转：模型反复提交同一批问题 → 早停，且如实保留"未通过"', async () => {
  const noReadSpec = {
    specVersion: 1, appId: 'x', name: '示例站', target: { type: 'web', url: 'https://example.com' }, expose: { mode: 'console' },
    commands: [{ action: 'submitForm', title: '提交表单', kind: 'write', params: [], steps: [{ act: 'goto', url: '/new' }, { act: 'snapshot' }, { act: 'click', ref: 1 }] }],
  }
  let calls = 0
  const t = setup({ llm: async () => { calls += 1; return { ok: true, text: submitTurn(noReadSpec), error: null } } })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, false, '没有 read 命令（质量硬门槛）→ 不产出 Spec')
  assert.ok(calls <= 4, `同一批问题重复出现应早停，实际调用了 ${calls} 次`)
  assert.equal(r.stoppedBy, 'no-progress')
  assert.ok(r.issues.some((i) => i.includes('read 命令')), r.issues.join('｜'))
})

test('质量门槛：title/参数说明写占位语 → 打回；改对后通过（封装质量要求落地）', async () => {
  const junk = {
    specVersion: 1, appId: 'x', name: '示例站', target: { type: 'web', url: 'https://example.com' }, expose: { mode: 'console' },
    commands: [
      { action: 'query', title: 'TODO', kind: 'read', params: [{ name: 'q', type: 'string', required: true, desc: '待补充' }], steps: [{ act: 'goto', url: '/list' }, { act: 'snapshot', save: 'r' }] },
    ],
  }
  const seenUsers = []
  const t = setup({
    llm: async (p) => { seenUsers.push(p?.user || ''); return { ok: true, text: submitTurn(junk), error: null } },
    exec: async () => ({ ok: true, snapshot: { page: { title: 'T' }, info: [] }, data: 'ok' }),
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, false, '占位语标题/参数说明属于不可用产物 → 不应交付')
  assert.ok(r.issues.some((i) => i.includes('占位语')), r.issues.join('｜'))
  assert.ok(seenUsers.some((u) => u.includes('封装质量校验未通过')), '要把质量问题回喂给模型去改')
  assert.ok(t.details().some((d) => d.includes('质量未达标')), t.details().join(' | '))
})

test('安全边界：write 命令绝不被自动试跑（run_command 只允许 read）', async () => {
  // 只写 write 命令：先被质量门槛打回（没有 read 命令），此过程中草稿会被留存，
  // 于是模型能拿到草稿去试跑 —— 而试跑 write 必须被拒（那会在用户的应用里产生真实改动）
  const writeOnly = {
    specVersion: 1, appId: 'x', name: '示例站', target: { type: 'web', url: 'https://example.com' }, expose: { mode: 'console' },
    commands: [
      { action: 'deleteItem', title: '删除指定条目', kind: 'write', params: [{ name: 'id', type: 'string', required: true, desc: '条目编号，形如 IT-001' }], steps: [{ act: 'goto', url: '/list' }, { act: 'snapshot' }, { act: 'click', ref: 2 }] },
    ],
  }
  const seenUsers = []
  let calls = 0
  const t = setup({
    llm: async (p) => {
      seenUsers.push(p?.user || '')
      calls += 1
      const script = [submitTurn(writeOnly), runTurn('deleteItem', { id: 'IT-001' }), submitTurn(writeOnly)]
      return { ok: true, text: script[Math.min(calls - 1, script.length - 1)], error: null }
    },
    exec: async () => ({ ok: true, snapshot: { page: { title: 'T' }, info: [] }, data: 'ok' }),
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.ok(seenUsers.some((u) => u.includes('拒绝试跑')), `模型试跑 write 时必须被拒绝并告知原因：${seenUsers.map((u) => u.slice(-200)).join(' || ')}`)
  assert.ok(!r.verify || (r.verify.tried || []).every((a) => a !== 'deleteItem'), 'write 命令绝不能被自动执行')
})

test('app:generate：js 缺 expression 的坏 Spec 会在校验轮被拦下并回喂（不再等到试跑）', async () => {
  const bad = JSON.stringify({
    specVersion: 1, appId: 'x', name: 'n', target: { type: 'web', url: 'https://example.com' }, expose: { mode: 'console' },
    commands: [{ action: 'readPageText', title: '读正文', kind: 'read', params: [], steps: [{ act: 'goto', url: '/' }, { act: 'js', code: 'document.body.innerText' }] }],
  })
  const good = JSON.stringify({
    specVersion: 1, appId: 'x', name: 'n', target: { type: 'web', url: 'https://example.com' }, expose: { mode: 'console' },
    commands: [{ action: 'readPageText', title: '读正文', kind: 'read', params: [], steps: [{ act: 'goto', url: '/' }, { act: 'js', expression: 'document.body.innerText', save: 'r' }] }],
  })
  let llmCalls = 0
  const seen = []
  const t = setup({
    llm: async (p) => {
      llmCalls += 1
      seen.push(p?.user || '')
      return { ok: true, text: llmCalls === 1 ? bad : good, error: null }
    },
    exec: async () => ({ ok: true, snapshot: { page: { title: 'T' }, info: [] }, data: '正文' }),
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.equal(llmCalls, 2, '第一轮的坏 Spec 应被校验拦下 → 回喂 → 第二轮修好')
  assert.ok(seen[1].includes('"code"') && seen[1].includes('expression'), `回喂内容要点名 code→expression：${seen[1].slice(-400)}`)
  assert.equal(r.spec.commands[0].steps[1].expression, 'document.body.innerText')
})

test.after(() => { rmSync(home, { recursive: true, force: true }) })

// ---------- 浏览器探索工具：browse / click / back（用户放开"自动点击/翻页"与"登录态"） ----------
//
// 用户选择放开这两项能力。这里守住两端：**探索真能用**（模型点得动、拿得到新页面），
// 且**破坏性动作绝不替用户做**（探索 ≠ 可以替用户删数据/下单）。

/** 假执行器：按 act 返回不同快照，用于验证 browse/click/back 的真实反馈链路 */
const exploreExecutor = (calls) => ({
  exec: async (sessionId, act, params) => {
    calls.push({ sessionId, act, params })
    if (act === 'goto') {
      return {
        ok: true,
        snapshot: {
          page: { url: params.url, title: '订单系统', logged_in: true },
          interactives: [
            { ref: 1, tag: 'a', label: '订单列表', path_hint: 'nav' },
            { ref: 2, tag: 'button', label: '下一页', path_hint: 'list' },
            { ref: 3, tag: 'button', label: '删除该订单', path_hint: 'row1' },
          ],
          info: ['共 128 条订单'],
        },
      }
    }
    if (act === 'click') {
      return { ok: true, snapshot: { page: { url: 'https://example.com/orders?page=2', title: '订单系统 第2页', logged_in: true }, interactives: [{ ref: 1, tag: 'a', label: '订单详情 A-100', path_hint: 'row1' }], info: ['共 128 条订单'] } }
    }
    return { ok: true, snapshot: { page: { url: 'https://example.com/', title: '订单系统', logged_in: true }, interactives: [{ ref: 1, tag: 'a', label: '订单列表', path_hint: 'nav' }] } }
  },
})

const exploreTurn = (tool, args) => JSON.stringify({ thought: '探索一下', tool, args })

test('browse：用浏览器打开（带登录态），快照与 ref 编号回喂给模型', async () => {
  const calls = []
  const seenUsers = []
  const script = [exploreTurn('browse', { url: 'https://example.com/orders' }), submitTurn(JSON.parse(SPEC_TEXT))]
  let i = 0
  const t = setup({
    executor: exploreExecutor(calls),
    llm: async (p) => { seenUsers.push(p?.user || ''); const text = script[Math.min(i, script.length - 1)]; i += 1; return { ok: true, text, error: null, chars: text.length } },
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com/' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.equal(calls[0].act, 'goto')
  // Task 6 契约变更：探索不再用 chat sessionId，而是站点级分区键（登录态就存在这个分区里）
  assert.equal(calls[0].sessionId, 'app-site-example.com', '探索必须用应用自己的分区键（登录态就存在这个分区里）')
  const ctx = seenUsers[1] || ''
  assert.ok(ctx.includes('订单列表'), `快照要回喂给模型：${ctx.slice(-400)}`)
  assert.ok(ctx.includes('下一步') || ctx.includes('1'), '要带上 ref 编号供模型点击')
  assert.ok(t.details().some((d) => d.includes('登录态')), `进度要如实说明用的是带登录态的浏览器：${t.details().join(' | ')}`)
})

test('click：模型按文字点「下一页」（翻页探索）→ 拿到新页面快照', async () => {
  const calls = []
  const seenUsers = []
  const script = [
    exploreTurn('browse', { url: 'https://example.com/orders' }),
    exploreTurn('click', { text: '下一页' }),
    submitTurn(JSON.parse(SPEC_TEXT)),
  ]
  let i = 0
  const t = setup({
    executor: exploreExecutor(calls),
    llm: async (p) => { seenUsers.push(p?.user || ''); const text = script[Math.min(i, script.length - 1)]; i += 1; return { ok: true, text, error: null, chars: text.length } },
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com/' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  const click = calls.find((c) => c.act === 'click')
  assert.ok(click, '应真的执行了点击')
  assert.equal(click.params.ref, 2, '按文字解析出的 ref 要正确')
  assert.ok(seenUsers.some((u) => u.includes('第2页')), '翻页后的新页面要回喂给模型')
  assert.ok(t.details().some((d) => d.includes('下一页')), t.details().join(' | '))
})

test('click：破坏性按钮被拒绝（探索不等于替用户删数据）', async () => {
  const calls = []
  const seenUsers = []
  const script = [
    exploreTurn('browse', { url: 'https://example.com/orders' }),
    exploreTurn('click', { text: '删除该订单' }),
    submitTurn(JSON.parse(SPEC_TEXT)),
  ]
  let i = 0
  const t = setup({
    executor: exploreExecutor(calls),
    llm: async (p) => { seenUsers.push(p?.user || ''); const text = script[Math.min(i, script.length - 1)]; i += 1; return { ok: true, text, error: null, chars: text.length } },
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com/' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.ok(!calls.some((c) => c.act === 'click'), '破坏性按钮绝不能被真的点到')
  assert.ok(seenUsers.some((u) => u.includes('拒绝点击')), `要把拒绝原因回喂给模型：${seenUsers.map((u) => u.slice(-200)).join(' || ')}`)
})

test('click：ref 失效时如实报错并列出可选目标（模型能自己纠正）', async () => {
  const seenUsers = []
  const script = [exploreTurn('browse', { url: 'https://example.com/orders' }), exploreTurn('click', { ref: 99 }), submitTurn(JSON.parse(SPEC_TEXT))]
  let i = 0
  const t = setup({
    executor: exploreExecutor([]),
    llm: async (p) => { seenUsers.push(p?.user || ''); const text = script[Math.min(i, script.length - 1)]; i += 1; return { ok: true, text, error: null, chars: text.length } },
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com/' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.ok(seenUsers.some((u) => u.includes('没有 ref=99') && u.includes('订单列表')), '要把可选元素列给模型')
})

test('back：探索完分支可以退回上一页', async () => {
  const calls = []
  const script = [exploreTurn('browse', { url: 'https://example.com/orders' }), exploreTurn('click', { text: '下一页' }), exploreTurn('back', {}), submitTurn(JSON.parse(SPEC_TEXT))]
  let i = 0
  const t = setup({
    executor: exploreExecutor(calls),
    llm: async () => { const text = script[Math.min(i, script.length - 1)]; i += 1; return { ok: true, text, error: null, chars: text.length } },
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com/' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.ok(calls.some((c) => c.act === 'back'), '应真的执行返回')
})

test('桌面应用不该出现浏览器探索（如实拒绝，而不是静默失败）', async () => {
  const calls = []
  const seenUsers = []
  const script = [exploreTurn('browse', { url: 'https://example.com/' }), submitTurn(JSON.parse(SPEC_TEXT))]
  let i = 0
  const t = setup({
    executor: exploreExecutor(calls),
    llm: async (p) => { seenUsers.push(p?.user || ''); const text = script[Math.min(i, script.length - 1)]; i += 1; return { ok: true, text, error: null, chars: text.length } },
  })
  // exePath 必须是**真能探测出驱动的**可执行文件：uia 目标在生成阶段就早退（见文末 Task 5 用例），
  // 用不存在的 'C:/x.exe' 会退化成 uia 而根本走不到"模型想用浏览器"这一步。
  await t.invoke('app:generate', { target: { type: 'desktop', exePath: process.execPath }, appId: 'x', sessionId: 's1' })
  assert.equal(calls.length, 0, '桌面应用不该去动浏览器执行器')
  assert.ok(seenUsers.some((u) => u.includes('桌面应用')), '要如实告诉模型这条路走不通')
})

// ---------- Task 6：生成期登录闭环（检测登录墙 → 自动开窗 → 带 Cookie 重抓 → 继续生成） ----------
//
// 用户诉求（原话）："很多应用或网站需要登录才能暴露所有端口……要确保用户手动登陆后，
// LLM 可以获取到登录状态。" 下面这几条守的就是这句话在**真实生成流程**里落地：
//   · high 置信度登录墙 → 自动开窗 → 登录成功 → **换掉**素材重抓（模型必须看到登录后的内容）；
//   · 非 high 一律不弹窗（用户要求"能不弹就不弹"）；超时仍产出 Spec 但如实警示"未在登录态下验证"；
//   · Cookie 只发给本次授权 host（登录态绝不外发）。

/** 登录页：有密码框（登录墙 high 的硬信号），没有订单内容 */
const PAGE_WITH_PASSWORD = `<!doctype html><html><head><title>请登录 - 示例站</title></head><body>
<form id="login" action="/login"><input name="user" placeholder="账号"><input type="password" name="pw" placeholder="密码"><button type="submit">登录</button></form></body></html>`
/** 普通页面：既没有密码框、也没有订单内容（登录墙 none —— 不该触发任何自动开窗） */
const PAGE_PLAIN = `<!doctype html><html><head><title>示例站首页</title></head><body><h1>示例站</h1><a href="/about">关于</a></body></html>`
/** 登录后才看得到的页面：模型必须看到 ORDERS 才算真的带上了登录态 */
const PAGE_WITH_ORDERS = `<!doctype html><html><head><title>订单中心</title></head><body><h1>ORDERS</h1>
<form id="q" action="/orders"><input name="kw" placeholder="订单号"><input name="from" placeholder="起始日期"><button>查询</button></form>
<a href="/orders/export">导出订单</a></body></html>`

/** 假 HTTP 响应（形状与真实 fetch 一致：headers.get 能取 content-type/location） */
const htmlResp = (html, { url, status = 200, location = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: {
    get: (name) => {
      const n = String(name).toLowerCase()
      if (n === 'content-type') return 'text/html; charset=utf-8'
      if (n === 'location') return location
      return null
    },
  },
  text: async () => html,
})

/**
 * 假执行器：模拟"检测到登录墙 → 开窗 → 用户在窗口里完成登录（cookie 变化）"。
 * 记录三件事供断言：开过的窗口、每次 exec 收到的键、每次取 Cookie 时的入参（键 + URL）。
 * 登录成功的确定性触发点 = **开窗导航完成后的第 2 次轮询快照**（第一次仍如实显示"还停在登录页"）：
 * 真实站点登录必然写 cookie，故状态一变就以 cookie-changed 收尾，不必依赖真实计时/网络。
 * @param {{site?:string, cookie?:string, neverLogin?:boolean}} opts
 */
function loginExecutor({ site = 'https://x.com/login', cookie = null, neverLogin = false } = {}) {
  const opened = []
  const calls = []        // 每次 exec：{ key, act, url }
  const cookieCalls = []  // 每次取 Cookie：{ key, url }（契约：必须按 URL 取，见 Task 2 的 url 过滤分支）
  const state = { fp: cookie ? 'n1:abc' : 'empty', snapAfterOpen: 0 }
  let openedDone = false
  return {
    opened, calls, cookieCalls, state,
    openWindow: async (key) => { opened.push(key); return { ok: true } },
    exec: async (key, act, params) => {
      calls.push({ key, act, url: params?.url || null })
      if (act === 'goto') { openedDone = true; return { ok: true, snapshot: { page: { url: params?.url, title: '请登录' } } } }
      if (openedDone && !neverLogin) {
        state.snapAfterOpen += 1
        if (state.snapAfterOpen >= 2) state.fp = 'n1:abc'   // 用户完成了登录（写入了 cookie）
      }
      // 快照如实保持"仍停在登录页"：本次成功的唯一信号就是 cookie 变化（走 cookie-changed 分支）
      return { ok: true, snapshot: { page: { url: site, logged_in: false, interactives: [{ ref: 1, tag: 'textbox', label: '密码' }] } } }
    },
    getCookieFingerprint: async (key, url) => { cookieCalls.push({ key, url }); return state.fp },
    getCookieHeader: async (key, url) => { cookieCalls.push({ key, url }); return state.fp === 'empty' ? null : 'sid=1' },
  }
}

/** 从进度事件里挑出登录阶段的事件（Task 6 新增 phase:'login'） */
const loginEvents = (events) => events
  .filter(([ch, p]) => ch === 'app:generate-progress' && p.phase === 'login')
  .map(([, p]) => p)

test('登录墙（high）→ 自动开窗等待 → cookie 变化 → 带 Cookie 重抓素材进 agent seed', async () => {
  const exec = loginExecutor()
  const fetchCalls = []
  const fetched = async (u, opt) => {
    const cookie = opt?.headers?.cookie || null
    fetchCalls.push({ url: u, cookie })
    return htmlResp(cookie ? PAGE_WITH_ORDERS : PAGE_WITH_PASSWORD, { url: u })
  }
  const seenUsers = []
  const t = setup({
    executor: exec,
    fetch: fetched,
    deps: { loginWaitMs: 500, loginPollMs: 5 },
    llm: async (p) => { seenUsers.push(p?.user || ''); return { ok: true, text: SPEC_TEXT, error: null, chars: SPEC_TEXT.length } },
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://x.com/login' }, appId: 'x', sessionId: 'chat-s1' })

  assert.equal(r.ok, true)
  // ① 检测到登录墙 → 自动打开登录窗口；键来自 appSessionKey（**不是** chat sessionId）
  assert.deepEqual(exec.opened, ['app-site-x.com'], '必须自动打开登录窗口，且用站点级分区键')
  assert.ok(exec.calls.every((c) => c.key === 'app-site-x.com'), `所有执行器调用都必须用站点级键：${JSON.stringify(exec.calls)}`)
  assert.equal(r.login.attempted, true)
  assert.equal(r.login.ok, true)
  assert.equal(r.login.reason, 'cookie-changed', 'cookie 指纹变化即视为登录成功')
  // ② 登录成功后带 Cookie 重抓：模型看到的必须是登录后的内容（替换而非追加）
  assert.ok(fetchCalls.some((c) => c.cookie), '登录成功后必须带 Cookie 重抓')
  assert.ok(seenUsers[0].includes('ORDERS'), `模型看到的素材必须是登录后的内容：${seenUsers[0].slice(0, 400)}`)
  assert.ok(!seenUsers[0].includes('密码'), '不得把登录前的空壳页当有效线索喂给模型')
  // ③ Cookie 必须**按 URL** 取（Task 2 的假 session 漏了 {url} 入参 → 这条分支此前零覆盖）
  assert.ok(exec.cookieCalls.length > 0, '必须真的读过该分区的 Cookie')
  assert.ok(exec.cookieCalls.every((c) => c.key === 'app-site-x.com'), JSON.stringify(exec.cookieCalls))
  assert.ok(exec.cookieCalls.every((c) => typeof c.url === 'string' && c.url.startsWith('https://x.com')), `取 Cookie 必须带上 URL（按 URL 过滤）：${JSON.stringify(exec.cookieCalls)}`)
  // ④ 进度：waiting true → false（收尾只有一条）；Spec 记录登录墙结论（可选字段）
  const ev = loginEvents(t.events)
  assert.equal(ev[0].waiting, true, '开窗前就要告诉界面"正在等待登录"')
  assert.equal(ev[0].key, 'app-site-x.com')
  assert.equal(ev.filter((p) => p.waiting === false).length, 1, '收尾事件只能一条（ensureLoggedIn 已发，Task 6 不得重复发）')
  assert.ok(ev[ev.length - 1].detail.includes('带登录态重新获取页面'), ev[ev.length - 1].detail)
  assert.equal(r.spec.auth?.needsLogin, true, '登录墙结论写进 Spec（可选字段，向后兼容）')
  assert.equal(r.spec.auth?.loginUrl, 'https://x.com/login')
})

test('无需登录的页面：不开登录窗口（high 以外一律不打扰）', async () => {
  const exec = loginExecutor()
  const t = setup({ executor: exec })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.deepEqual(exec.opened, [], '没有登录墙就绝不弹窗')
  assert.equal(r.login, null, '没走登录编排就该如实为 null（不假装登录过）')
  assert.equal(loginEvents(t.events).length, 0, '没有登录墙就不该有 login 阶段事件')
  assert.equal(r.spec.auth, undefined, '无需登录就不写 auth 字段')
})

test('登录词提示（medium）：只在进度里提示，不弹窗', async () => {
  const loginWordHtml = `<!doctype html><html><head><title>请先登录</title></head><body><h1>请先登录后查看订单</h1>
<form id="q" action="/orders"><input name="kw" placeholder="订单号"><input name="from" placeholder="起始日期"><button>查询</button></form>
<a href="/orders/export">导出订单</a></body></html>`
  const exec = loginExecutor()
  const t = setup({ executor: exec, fetch: async () => htmlResp(loginWordHtml, { url: 'https://x.com/' }) })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://x.com/' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.deepEqual(exec.opened, [], '中/弱信号一律不自动弹窗')
  assert.equal(r.login, null)
  const ev = loginEvents(t.events)
  assert.equal(ev.length, 1, `只提示一次：${JSON.stringify(ev)}`)
  assert.equal(ev[0].waiting, false)
  assert.ok(ev[0].detail.includes('未自动打开登录窗口') && ev[0].detail.includes('登录此应用'), ev[0].detail)
  assert.equal(r.spec.auth?.needsLogin, true, '中/弱信号同样记录"需要登录"（供自检提醒）')
})

test('登录超时：仍产出 spec，但 login.ok=false 且文案含"未在登录态下验证"', async () => {
  const exec = loginExecutor({ neverLogin: true })   // 指纹与快照始终不变 = 用户没登录
  const fetched = async (u, opt) => htmlResp(opt?.headers?.cookie ? PAGE_WITH_ORDERS : PAGE_WITH_PASSWORD, { url: u })
  const t = setup({ executor: exec, fetch: fetched, deps: { loginWaitMs: 40, loginPollMs: 5 } })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://x.com/login' }, appId: 'x', sessionId: 's1' })

  assert.equal(r.ok, true, '登录没完成也不能中断生成（用户明确取舍：超时仍继续）')
  assert.ok(r.spec.commands.length > 0, '仍要产出 Spec')
  assert.equal(r.login.attempted, true)
  assert.equal(r.login.ok, false)
  assert.equal(r.login.reason, 'timeout')
  assert.ok(r.login.detail.includes('未在登录态下验证'), r.login.detail)
  const ev = loginEvents(t.events)
  assert.equal(ev[ev.length - 1].waiting, false, '超时也必须收尾，界面不能停在"等待登录中"')
  assert.ok(ev[ev.length - 1].detail.includes('未在登录态下验证'), ev[ev.length - 1].detail)
})

test('带 Cookie 重抓：Cookie 只发给授权 host（跨站跳转直接停跟，一个请求都不发）', async () => {
  const exec = loginExecutor()
  const calls = []
  const fetched = async (u, opt) => {
    const cookie = opt?.headers?.cookie || null
    calls.push({ url: u, cookie })
    if (cookie) {
      // 登录后站点把请求跳去第三方域名：登录态绝不能跟着走
      return htmlResp('', { url: u, status: 302, location: 'https://tracker.example/steal' })
    }
    return htmlResp(PAGE_WITH_PASSWORD, { url: u })
  }
  const t = setup({ executor: exec, fetch: fetched, deps: { loginWaitMs: 500, loginPollMs: 5 } })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://x.com/login' }, appId: 'x', sessionId: 's1' })

  assert.equal(r.ok, true)
  assert.ok(calls.some((c) => c.cookie), '重抓必须带上 Cookie（否则拿不到登录后的内容）')
  assert.equal(calls.filter((c) => c.url.includes('tracker.example')).length, 0, '未授权域名一个请求都不该收到')
  const withCookie = calls.filter((c) => c.cookie)
  assert.ok(withCookie.every((c) => new URL(c.url).hostname === 'x.com'), `Cookie 只能发给授权 host：${JSON.stringify(withCookie)}`)
  // 登录成功了、但重抓拿不到素材（跨站即整体失败）：必须如实说"没取到登录后素材"，
  // 否则用户会以为本次生成用的是登录后的内容。
  const last = loginEvents(t.events).pop()
  assert.equal(last.waiting, false)
  assert.ok(last.detail.includes('未取得登录后的页面素材'), last.detail)
})

test('高置信度登录墙但没有执行器：不静默——如实提示"未在登录态下验证"', async () => {
  const t = setup({ executor: null, fetch: async (u) => htmlResp(PAGE_WITH_PASSWORD, { url: u }) })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://x.com/login' }, appId: 'x', sessionId: 's1' })

  assert.equal(r.ok, true, '执行器缺失也不能中断生成')
  assert.equal(r.login.attempted, false)
  assert.equal(r.login.ok, false)
  assert.equal(r.login.reason, 'no-executor')
  const ev = loginEvents(t.events)
  assert.equal(ev.length, 1, '至少要看得到一条登录相关提示，不能一条都不发')
  assert.equal(ev[0].waiting, false)
  assert.ok(ev[0].detail.includes('未就绪'), ev[0].detail)
  assert.ok(ev[0].detail.includes('未在登录态下验证'), ev[0].detail)
})

test('模型探索 fetch_page：Cookie 只发给本次流程授权的 host（登录态绝不外发）', async () => {
  const exec = loginExecutor({ cookie: 'sid=1' })   // 该站点已有登录态
  const calls = []
  const fetched = async (u, opt) => {
    calls.push({ url: u, cookie: opt?.headers?.cookie || null })
    return htmlResp(RICH_HTML, { url: u })
  }
  const script = [fetchTurn('https://other.example/data'), fetchTurn('https://x.com/recent'), submitTurn(JSON.parse(SPEC_TEXT))]
  let i = 0
  const t = setup({
    executor: exec,
    fetch: fetched,
    llm: async () => { const text = script[Math.min(i, script.length - 1)]; i += 1; return { ok: true, text, error: null, chars: text.length } },
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://x.com/' }, appId: 'x', sessionId: 's1' })

  assert.equal(r.ok, true)
  const other = calls.find((c) => c.url.includes('other.example'))
  assert.ok(other, `模型主动抓的页面要真的去抓（否则探索就是假的）：${JSON.stringify(calls)}`)
  assert.equal(other.cookie, null, '未授权 host 绝不带 Cookie')
  assert.ok(calls.some((c) => c.url.startsWith('https://x.com/') && c.cookie), '本站点必须带 Cookie（否则探索看不到登录后内容）')
})

test('模型主动请求登录：开窗等待成功 → 带 Cookie 重抓 → 把登录后内容回喂给模型继续探索', async () => {
  // 本用例自带一个"打开窗口即视为登录成功"的假执行器：
  // 不依赖按快照次数翻转指纹的启发式（那会让结果受调用次序影响）。
  const state = { loggedIn: false, opened: [] }
  const exec = {
    async openWindow(key) { state.opened.push(key); state.loggedIn = true; return { ok: true } },
    async exec(key, act) {
      return { ok: true, snapshot: { page: { url: 'https://example.com/', logged_in: state.loggedIn, interactives: [] } } }
      },
    async getCookieFingerprint() { return state.loggedIn ? 'n1:abc' : 'empty' },
    async getCookieHeader() { return state.loggedIn ? 'sid=1' : null },
  }
  const seenUsers = []
  const fetched = async (u, opt) => htmlResp(opt?.headers?.cookie ? PAGE_WITH_ORDERS : PAGE_PLAIN, { url: u })
  const script = [
    JSON.stringify({ thought: '这页看不到功能入口', tool: 'request_login', args: { reason: '首页只有登录入口' } }),
    submitTurn(JSON.parse(SPEC_TEXT)),
  ]
  let i = 0
  const t = setup({
    executor: exec,
    fetch: fetched,
    deps: { loginWaitMs: 500, loginPollMs: 5 },
    llm: async (p) => { seenUsers.push(p?.user || ''); const text = script[Math.min(i, script.length - 1)]; i += 1; return { ok: true, text, error: null, chars: text.length } },
  })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com/' }, appId: 'x', sessionId: 's1' })

  assert.equal(r.ok, true, (r.issues || []).join('｜'))
  assert.ok(state.opened.length >= 1, '必须真的打开了可见登录窗口')
  const turn = r.agent.trace.find((x) => x.kind === 'tool' && x.tool === 'request_login')
  assert.ok(turn, '模型主动请求登录要出现在轨迹里')
  assert.equal(turn.ok, true, turn.summary)
  assert.ok(turn.summary.includes('ORDERS'), `回喂的必须是**登录后**重抓到的素材：${turn.summary.slice(0, 300)}`)
  assert.ok(seenUsers.some((u) => u.includes('ORDERS')), '下一轮模型也要看得到登录后的内容')
  assert.ok(seenUsers.some((u) => u.includes('用户已完成登录')), '要如实告诉模型登录已完成')
})

test('模型请求登录：桌面应用明确拒绝（没有浏览器登录概念），生成照常继续', async () => {
  const script = [
    JSON.stringify({ thought: '想登录', tool: 'request_login', args: {} }),
    submitTurn(JSON.parse(SPEC_TEXT)),
  ]
  let i = 0
  const t = setup({
    llm: async () => { const text = script[Math.min(i, script.length - 1)]; i += 1; return { ok: true, text, error: null, chars: text.length } },
  })
  // 同上：用真实可执行文件（→ process 驱动），否则 uia 早退会让"生成照常继续"无从验证
  const r = await t.invoke('app:generate', { target: { type: 'desktop', exePath: process.execPath }, appId: 'desk', sessionId: 's1' })

  assert.equal(r.ok, true, '拒绝该工具不应中断生成')
  const turn = r.agent.trace.find((x) => x.kind === 'tool' && x.tool === 'request_login')
  assert.ok(turn, '工具调用要出现在轨迹里')
  assert.equal(turn.ok, false)
  assert.ok(turn.summary.includes('桌面'), turn.summary)
})

// ---------- Task 4：desktop 试跑必须注入 driver ----------
//
// 真实故障：desktop 的试跑分支只把草稿 spec 交给 desktopRunner，而草稿里的 driver 由模型写、
// 常常没有 → desktopRunner 直接回 "不支持的 driver：undefined" → 试跑恒失败 → 模型被反复回喂
// → 用户最终看到的是最早几轮的陈旧错误（"specVersion 必须为 1；缺少 name；…"）。
test('app:generate（desktop/process）：生成 → 试跑全链路通过（试跑必须注入 driver）', async () => {
  const DESK_SPEC = JSON.stringify({
    specVersion: 1, appId: 'd1', name: '本地 CLI',
    target: { type: 'desktop', exePath: process.execPath },
    expose: { mode: 'console' },
    commands: [
      { action: 'version', title: '查看版本号', kind: 'read', params: [], returns: { type: 'text', from: 'out' },
        steps: [{ act: 'cli', argv: ['--version'], save: 'out' }] },
      { action: 'listModules', title: '列出内置模块', kind: 'read', params: [], returns: { type: 'text', from: 'out' },
        steps: [{ act: 'cli', argv: ['-e', 'console.log(Object.keys(process.versions).join(","))'], save: 'out' }] },
      { action: 'getVersionOf', title: '查询指定组件的版本号', kind: 'read',
        params: [{ name: 'name', type: 'string', required: true, desc: '组件名，如 node / v8 / openssl' }],
        returns: { type: 'text', from: 'out' },
        steps: [{ act: 'cli', argv: ['-e', 'console.log(process.versions["${name}"] || "unknown")'], save: 'out' }] },
    ],
  })
  const t = setup({ llm: async () => ({ ok: true, text: DESK_SPEC, error: null, chars: DESK_SPEC.length }) })
  const r = await t.invoke('app:generate', { target: { type: 'desktop', exePath: process.execPath }, appId: 'd1', sessionId: 's1' })
  assert.equal(r.driver, 'process')
  assert.equal(r.ok, true, `生成应成功（issues：${JSON.stringify(r.issues || [])}）`)
  assert.equal(r.verify.ok, true, `试跑应通过（failures：${JSON.stringify(r.verify?.failures || [])}）`)
  assert.deepEqual(r.verify.tried.slice().sort(), ['listModules', 'version'], '只试跑无需参数的 read')
  assert.equal(r.verify.notRun.length, 0, '三条都是 read')
})

// ---------- Task 5：uia 目标在生成阶段早退（明确拒绝，而不是产出注定跑不通的应用） ----------
//
// 真实故障：桌面目标探测不到 CLI/脚本接口时会降级为 uia 驱动，而 UI 自动化后端**尚未接入**
// （app-runner-desktop.cjs 的 runUia 恒返回"未接入"）→ 此路径下生成的任何命令都注定跑不通。
// 原行为却照常烧十几轮模型预算，最后可能"生成成功"交给用户一个永远失败的应用。
test('app:generate（desktop/uia）：后端未接入 → 早退拒绝，不烧模型轮次、不产出注定跑不通的应用', async () => {
  let llmCalled = 0
  const stubDir = mkdtempSync(join(tmpdir(), 'uia-stub-'))
  const stub = join(stubDir, 'nope.exe')          // 空文件 + .exe：process/script 探测都失败 → uia
  writeFileSync(stub, '', 'utf-8')
  const t = setup({ llm: async () => { llmCalled++; return { ok: true, text: '{}', error: null, chars: 2 } } })
  try {
    const r = await t.invoke('app:generate', { target: { type: 'desktop', exePath: stub }, appId: 'd2', sessionId: 's1' })
    assert.equal(r.ok, false)
    assert.equal(r.driver, 'uia')
    assert.equal(r.stoppedBy, 'uia-unsupported')
    assert.ok(r.error.includes('UI 自动化后端尚未接入'), `要说清为什么不能生成：${r.error}`)
    assert.ok(r.error.includes('命令行') || r.error.includes('CLI'), '要给出可行的替代路径')
    assert.equal(llmCalled, 0, '注定跑不通就别去烧模型轮次')
    assert.ok(t.phases().includes('error'), '进度要以 error 收尾（界面才不会停在"生成中"）')
  } finally { rmSync(stubDir, { recursive: true, force: true }) }
})

// ---------- M3：失败原因取自"最新"，不是 round-1 的旧错 ----------
//
// 真实故障：早期轮次的错误永远排在 issues 头部，界面取前 3 条 → 用户看到的"失败原因"是早就改好的
// 旧错（"specVersion 必须为 1；缺少 name；…"），真正卡住的原因（在 issues 尾部）永远显不出来。
test('app:generate：失败原因必须是最新阻塞原因，不得把 round-1 的旧错当原因', async () => {
  // 第 1 轮：结构非法（制造 round-1 旧错）；之后模型连续 3 轮输出读不懂 → bad-output 早停
  let n = 0
  const BAD_SPEC = JSON.stringify({ thought: 't', tool: 'submit_spec', spec: { specVersion: 1, appId: 'x', target: { type: 'web', url: 'https://example.com/' }, commands: [] } })
  const t = setup({ llm: async () => { n++; return { ok: true, text: n === 1 ? BAD_SPEC : '我不太会写 JSON，这里是说明文字', error: null } } })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, false)
  assert.equal(r.stoppedBy, 'bad-output')
  assert.ok(r.error.includes('输出无法解析'), `原因应是本路径的真实原因，实际：${r.error}`)
  assert.ok(!r.error.includes('specVersion'), `不得把 round-1 旧错当原因，实际：${r.error}`)
  assert.ok(r.issues.some((i) => i.includes('name')), 'issues 仍需保留全量历史供排障')
  assert.ok(t.details().some((d) => String(d).includes('输出无法解析')), '进度事件也要给出真实原因')
})

test('pickBlockerReasons：优先 blockers；回退取 issues 尾部（最新）而不是头部（最旧）', () => {
  // ① 有 blockers：只信 blockers（app-agent 每条早退路径都会设）
  assert.deepEqual(pickBlockerReasons({ blockers: ['当前卡点'], issues: ['round-1 旧错', 'round-2 旧错'] }), ['当前卡点'])
  // ② 没有 blockers：回退取**尾部**最新 3 条（取头部等于把最陈旧的错误当原因，与目的正好相反）
  assert.deepEqual(pickBlockerReasons({ blockers: [], issues: ['最旧1', '最旧2', '较新1', '较新2', '最新'] }), ['较新1', '较新2', '最新'])
  // ③ 都没有：返回空数组（调用方给兜底文案）
  assert.deepEqual(pickBlockerReasons({}), [])
  // ④ 至多 3 条：界面文案不因历史上百条错误而失控
  assert.equal(pickBlockerReasons({ blockers: ['1', '2', '3', '4'] }).length, 3)
})

// ---------- m1：驱动推定只有一份实现（校验放过的值 = 执行能跑的值） ----------
test('inferDriver 复用 driverOf：校验放行的 driver（含历史别名 web）执行侧必然认识', () => {
  // 'web' 是历史别名：validateSpecBasic 放行它，执行侧就必须归一为 browser ——
  // 旧实现原样返回 'web' → desktopRunner 回"不支持的 driver：web"（校验放过、执行必炸）。
  assert.equal(inferDriver({ driver: 'web', target: { type: 'web', url: 'https://a.com/' } }), 'browser')
  assert.equal(inferDriver({ driver: 'desktop', target: { type: 'desktop', exePath: 'C:/x.exe' } }), 'uia', '历史值按 target.type 推定')
  assert.equal(inferDriver({ driver: 'process', target: { type: 'desktop', exePath: 'C:/x.exe' } }), 'process')
  assert.equal(inferDriver({ target: { type: 'web', url: 'https://a.com/' } }), 'browser', '缺 driver → 按 target.type')
  assert.equal(inferDriver({ target: { type: 'desktop', exePath: 'C:/x.exe' } }), 'uia', '其余一律最保守的 uia')
  // 非法值不得原样漏给执行器（必须归一到执行器认识的驱动）
  assert.ok(DRIVERS.includes(inferDriver({ driver: 'launchMissiles', target: { type: 'web' } })))
})
