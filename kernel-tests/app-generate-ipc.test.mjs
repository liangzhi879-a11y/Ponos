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

function setup({ llm, exec } = {}) {
  const handlers = new Map()
  const events = []
  const ipcMain = { handle: (c, f) => handlers.set(c, f) }
  const webContents = { send: (ch, payload) => events.push([ch, payload]) }
  registerAppHandlers({
    ipcMain,
    getExecutor: () => ({ exec: exec || (async () => ({ ok: true, snapshot: { page: { title: 'T' }, text: 'body' } })) }),
    getWebContents: () => webContents,
    deps: { callLlm: llm || (async () => ({ ok: true, text: SPEC_TEXT, error: null, chars: SPEC_TEXT.length })) },
  })
  return {
    invoke: (ch, ...a) => handlers.get(ch)({}, ...a),
    events,
    phases: () => events.filter(([ch]) => ch === 'app:generate-progress').map(([, p]) => p.phase),
    details: () => events.filter(([ch]) => ch === 'app:generate-progress').map(([, p]) => p.detail).filter(Boolean),
  }
}

test('app:generate 全链路：探测 → 生成 → 试跑，并逐阶段上报真实进度', async () => {
  const t = setup()
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.driver, 'browser')
  assert.equal(r.spec.commands.length, 2)
  assert.equal(r.verify.ok, true)
  assert.deepEqual(r.verify.tried, ['listRecent'], '只试跑无需参数的 read')
  assert.deepEqual(r.verify.notRun, ['submit'], 'write 绝不试跑')

  const phases = t.phases()
  for (const must of ['probe', 'round', 'parse', 'parsed', 'verify', 'done']) {
    assert.ok(phases.includes(must), `进度事件缺少阶段 ${must}（实际：${phases.join(',')}）`)
  }
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

test('app:generate：页面探测失败 → 立即失败并如实说明（不进入生成）', async () => {
  const t = setup({ exec: async (_s, act) => (act === 'goto' ? { ok: false, error: '域名被拦截' } : { ok: true, snapshot: {} }) })
  const r = await t.invoke('app:generate', { target: { type: 'web', url: 'https://blocked.example' }, appId: 'x', sessionId: 's1' })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('拦截'))
  assert.ok(!t.phases().includes('round'), '探测失败就不该请求模型')
})

test('app:generate：web 目标但执行器未就绪 → 明确报错', async () => {
  const handlers = new Map()
  registerAppHandlers({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, getExecutor: () => null, getWebContents: () => null, deps: {} })
  const r = await handlers.get('app:generate')({}, { target: { type: 'web', url: 'https://a.com' }, appId: 'x' })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('执行器'))
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
