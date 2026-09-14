// 应用即工具（Task 4.x）：kernel/app-tools.mjs 单测
// ---------------------------------------------------------------------------
// 钉死四件事：
//   ① 可见性（未绑定 → 0 工具；console/public/private 三态）——与 app-spec 同口径；
//   ② 工具形状与 dyntools 一致（description/input_schema/concurrencySafe/run）；
//   ③ 执行语义（失败转 isError 不抛；未注入 runner 明确报错，绝不静默成功）；
//   ④ 上限截断与重名不静默覆盖（nameConflicts 非枚举属性）。
// 全部用临时目录 + 假 runner，不碰真实 ~/.yfworking、不发网络请求。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAppTools } from '../kernel/app-tools.mjs'
import { appToolName } from '../kernel/app-naming.mjs'
import { MAX_COMMANDS_PER_APP } from '../kernel/app-spec.mjs'

const dirs = []
function tmpRoot() {
  const d = mkdtempSync(join(tmpdir(), 'apptools-'))
  dirs.push(d)
  return d
}
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 清理尽力而为 */ } } })

/** 造一个应用：registry.json + <appId>/spec.json（可选 binding.json） */
function makeApp({ root, appId = 'app-a', name = '甲系统', mode = 'console', commands, bindSession = null, enabled = true, extraRegistry = [] } = {}) {
  mkdirSync(join(root, appId), { recursive: true })
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ version: 1, apps: [{ id: appId, name, targetType: 'web', enabled }, ...extraRegistry] }), 'utf-8')
  const spec = {
    specVersion: 1, appId, name, target: { type: 'web', url: 'https://example.com' },
    expose: { mode }, commands,
  }
  writeFileSync(join(root, appId, 'spec.json'), JSON.stringify(spec), 'utf-8')
  if (bindSession) writeFileSync(join(root, 'binding.json'), JSON.stringify({ [bindSession]: { appId, boundAt: '2026-09-13T00:00:00Z' } }), 'utf-8')
  return spec
}

const READ_CMD = { action: 'queryOrder', title: '查询订单', kind: 'read', params: [{ name: 'orderId', type: 'string', required: true, description: '订单号' }], steps: [{ act: 'goto', url: '/' }] }
const WRITE_CMD = { action: 'submitOrder', title: '提交订单', kind: 'write', params: [], steps: [{ act: 'click', selector: '#ok' }] }
const mkCmds = (n, kind = 'read') => Array.from({ length: n }, (_, i) => ({ action: `act${i + 1}`, title: `命令${i + 1}`, kind, params: [], steps: [{ act: 'goto', url: '/' }] }))

test('①未绑定控制台 → 0 工具（应用不进公共注册表）', () => {
  const root = tmpRoot()
  makeApp({ root, commands: [READ_CMD, WRITE_CMD] })
  const tools = buildAppTools({ roots: [root], sessionId: 's1' })
  assert.deepEqual(Object.keys(tools), [])
})

test('②绑定后 → 工具名全部 app_ 前缀，且形状四字段齐全（与 dyntools 同构）', () => {
  const root = tmpRoot()
  const spec = makeApp({ root, commands: [READ_CMD, WRITE_CMD], bindSession: 's1' })
  const tools = buildAppTools({ roots: [root], sessionId: 's1' })
  const names = Object.keys(tools)
  assert.equal(names.length, 2)
  assert.ok(names.every((n) => n.startsWith('app_')), `工具名应全部 app_ 前缀：${names}`)
  // 命名与权限规则注入共用同一真源（kernel/app-naming.mjs）——两侧不一致 = 规则永不命中
  assert.deepEqual(new Set(names), new Set([appToolName(spec, 'queryOrder'), appToolName(spec, 'submitOrder')]))
  for (const [name, t] of Object.entries(tools)) {
    assert.equal(typeof t.description, 'string', `${name}.description`)
    assert.equal(typeof t.input_schema, 'object', `${name}.input_schema`)
    assert.equal(t.input_schema.type, 'object', `${name}.input_schema.type`)
    assert.equal(typeof t.concurrencySafe, 'boolean', `${name}.concurrencySafe`)
    assert.equal(typeof t.run, 'function', `${name}.run`)
  }
  // 参数 schema 由 Spec 的 params（数组）派生：必填项进入 required
  const readTool = tools[appToolName(spec, 'queryOrder')]
  assert.deepEqual(readTool.input_schema.required, ['orderId'])
  assert.equal(readTool.input_schema.properties.orderId.type, 'string')
})

test('③read → concurrencySafe=true；write → false 且描述含「需确认」', () => {
  const root = tmpRoot()
  const spec = makeApp({ root, commands: [READ_CMD, WRITE_CMD], bindSession: 's1' })
  const tools = buildAppTools({ roots: [root], sessionId: 's1' })
  const read = tools[appToolName(spec, 'queryOrder')]
  const write = tools[appToolName(spec, 'submitOrder')]
  assert.equal(read.concurrencySafe, true)
  assert.equal(write.concurrencySafe, false)
  assert.match(write.description, /需确认/)
  assert.doesNotMatch(read.description, /需确认/)
  assert.match(read.description, /^\[甲系统\] 查询订单/)
  // 中文应用名经 appToolName 回退到 appId 短哈希（不是 dyntools 的 run_workflow_<hash>）
  assert.match(appToolName(spec, 'queryOrder'), /^app_a[0-9a-f]{6}_queryOrder$/)
})

test('④public 免绑定可见；private 永不可见（即使已绑定）', () => {
  const pub = tmpRoot()
  makeApp({ root: pub, mode: 'public', commands: [READ_CMD, WRITE_CMD] })
  assert.equal(Object.keys(buildAppTools({ roots: [pub], sessionId: 's1' })).length, 2)

  const priv = tmpRoot()
  makeApp({ root: priv, mode: 'private', commands: [READ_CMD, WRITE_CMD], bindSession: 's1' })
  assert.equal(Object.keys(buildAppTools({ roots: [priv], sessionId: 's1' })).length, 0, 'private 即便绑定也不可见')

  // console：绑定别的应用时，本应用不可见（严格单开）
  const consoles = tmpRoot()
  makeApp({ root: consoles, appId: 'app-a', commands: [READ_CMD], bindSession: 's1' })
  mkdirSync(join(consoles, 'app-b'), { recursive: true })
  writeFileSync(join(consoles, 'app-b', 'spec.json'), JSON.stringify({
    specVersion: 1, appId: 'app-b', name: '乙系统', target: { type: 'web', url: 'u' }, expose: { mode: 'console' },
    commands: [{ ...READ_CMD, action: 'other' }],
  }), 'utf-8')
  writeFileSync(join(consoles, 'registry.json'), JSON.stringify({ version: 1, apps: [{ id: 'app-a', name: '甲系统', enabled: true }, { id: 'app-b', name: '乙系统', enabled: true }] }), 'utf-8')
  const names = Object.keys(buildAppTools({ roots: [consoles], sessionId: 's1' }))
  assert.equal(names.length, 1, '只有被绑定的那个 console 应用可见')
  assert.equal(names[0], appToolName({ name: '甲系统', appId: 'app-a' }, 'queryOrder'))
})

test('⑤run：成功 isError=false；返回失败 / runner 抛错 均 isError=true 且不抛', async () => {
  const root = tmpRoot()
  const spec = makeApp({ root, commands: [READ_CMD], bindSession: 's1' })
  const name = appToolName(spec, 'queryOrder')

  const okCalls = []
  const okTools = buildAppTools({
    roots: [root], sessionId: 's1',
    runner: async (p) => { okCalls.push(p); return { ok: true, data: { status: 'paid' }, error: null, kind: 'read', durationMs: 12 } },
  })
  const ok = await okTools[name].run({ orderId: 'A1' })
  assert.equal(ok.isError, false)
  assert.match(ok.content, /执行完成/)
  assert.match(ok.content, /paid/)
  assert.deepEqual(okCalls[0], { appId: 'app-a', action: 'queryOrder', args: { orderId: 'A1' }, sessionId: 's1' }, 'runner 必须收到 appId/action/args/sessionId')

  const failTools = buildAppTools({ roots: [root], sessionId: 's1', runner: async () => ({ ok: false, data: null, error: 'boom', kind: 'read', durationMs: 1 }) })
  const bad = await failTools[name].run({ orderId: 'A1' })
  assert.equal(bad.isError, true)
  assert.match(bad.content, /boom/)

  const throwTools = buildAppTools({ roots: [root], sessionId: 's1', runner: async () => { throw new Error('bridge down') } })
  const thrown = await throwTools[name].run({})
  assert.equal(thrown.isError, true, 'runner 抛错必须转 isError，不得冒出工具边界中断 turn')
  assert.match(thrown.content, /bridge down/)
})

test('⑥未注入 runner → 明确报错（绝不静默成功）', async () => {
  const root = tmpRoot()
  const spec = makeApp({ root, commands: [READ_CMD], bindSession: 's1' })
  const tools = buildAppTools({ roots: [root], sessionId: 's1' }) // 不传 runner
  const r = await tools[appToolName(spec, 'queryOrder')].run({ orderId: 'A1' })
  assert.equal(r.isError, true)
  assert.match(r.content, /未注入 runner/)
})

test('⑦超 MAX_COMMANDS_PER_APP / publicLimit 被截断（按注册顺序）', () => {
  const perApp = tmpRoot()
  const spec = makeApp({ root: perApp, commands: mkCmds(MAX_COMMANDS_PER_APP + 3), bindSession: 's1' })
  const names = Object.keys(buildAppTools({ roots: [perApp], sessionId: 's1', publicLimit: MAX_COMMANDS_PER_APP + 10 }))
  assert.equal(names.length, MAX_COMMANDS_PER_APP, `单应用上限 ${MAX_COMMANDS_PER_APP}`)
  assert.equal(names[0], appToolName(spec, 'act1'))
  assert.equal(names.at(-1), appToolName(spec, `act${MAX_COMMANDS_PER_APP}`))

  const limit = tmpRoot()
  makeApp({ root: limit, mode: 'public', commands: mkCmds(5) })
  assert.equal(Object.keys(buildAppTools({ roots: [limit], sessionId: 's1', publicLimit: 2 })).length, 2)
  // 非整数 publicLimit → 回退到缺省上限；此例 5 条全在（缺省 ≥ 5）
  assert.equal(Object.keys(buildAppTools({ roots: [limit], sessionId: 's1', publicLimit: 'x' })).length, 5)
  assert.equal(Object.keys(buildAppTools({ roots: [limit], sessionId: 's1', publicLimit: 2.5 })).length, 5)
})

// ---------- 装配级护栏：缺省上限必须容得下"应用允许的命令数" ----------
//
// 真实故障（M2）：kernel/cli.mjs 的装配调用 `buildAppTools({ roots, agentId, sessionId, runner })`
// **不传 publicLimit**，而此处缺省曾是 dyntools 的 LIMIT_DEFAULT(20)；同时 kernel/app-spec.mjs 的
// 单应用上限已提到 40、校验也只比 40 —— 于是用户能存下 40 条命令的 Spec，工具池里只出现前 20 条，
// 后 20 条被 slice 静默丢弃（模型只会说"没有这个工具"，界面上看不出少了什么）。
// 上面 ⑦ 之所以没抓到，是因为它**显式传了** publicLimit，绕开了缺省路径。
// 这条用例刻意**不传 publicLimit**，走的就是生产装配的那条分支。
test('⑦b 不传 publicLimit（生产装配路径）：40 条命令全部进工具池，第 41 条才被截断', () => {
  const root = tmpRoot()
  const spec = makeApp({ root, commands: mkCmds(MAX_COMMANDS_PER_APP + 1), bindSession: 's1' })
  const names = Object.keys(buildAppTools({ roots: [root], sessionId: 's1' }))
  assert.equal(names.length, MAX_COMMANDS_PER_APP,
    `缺省上限必须容得下单应用上限 ${MAX_COMMANDS_PER_APP} 条（实际 ${names.length} → 有命令被静默丢弃）`)
  assert.equal(names.at(-1), appToolName(spec, `act${MAX_COMMANDS_PER_APP}`), '截断点应在第 41 条（注册顺序稳定）')
  assert.ok(!names.includes(appToolName(spec, `act${MAX_COMMANDS_PER_APP + 1}`)), '超出单应用上限的第 41 条不应注册')
})

test('⑧重名 action：加哈希后缀保两条可用，冲突记入非枚举属性 nameConflicts', () => {
  const root = tmpRoot()
  // 两个 public 应用同名 'x' + 同 action → 工具名必撞（slug 相同）
  makeApp({ root, appId: 'app-a', name: 'x', mode: 'public', commands: [{ ...READ_CMD, action: 'q' }] })
  mkdirSync(join(root, 'app-b'), { recursive: true })
  writeFileSync(join(root, 'app-b', 'spec.json'), JSON.stringify({
    specVersion: 1, appId: 'app-b', name: 'x', target: { type: 'web', url: 'u' }, expose: { mode: 'public' },
    commands: [{ ...READ_CMD, action: 'q' }],
  }), 'utf-8')
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ version: 1, apps: [{ id: 'app-a', name: 'x', enabled: true }, { id: 'app-b', name: 'x', enabled: true }] }), 'utf-8')

  const tools = buildAppTools({ roots: [root], sessionId: 's1' })
  const names = Object.keys(tools)
  assert.equal(names.length, 2, '重名必须两条都在（不得静默覆盖丢命令）')
  assert.equal(names[0], 'app_x_q')
  assert.match(names[1], /^app_x_q_[0-9a-f]{6}/)
  assert.equal(tools.nameConflicts.length, 1)
  assert.equal(tools.nameConflicts[0].preferred, 'app_x_q')
  assert.equal(tools.nameConflicts[0].resolved, names[1])
  assert.equal(Object.keys(tools).includes('nameConflicts'), false, '冲突明细不得进工具表视图')
})

test('⑨英文应用名 → app_<slug>_<action>；disabled 应用不产出工具', () => {
  const root = tmpRoot()
  const spec = makeApp({ root, appId: 'crm', name: 'CRM Portal', commands: [READ_CMD], bindSession: 's1' })
  const names = Object.keys(buildAppTools({ roots: [root], sessionId: 's1' }))
  assert.deepEqual(names, ['app_crm_portal_queryOrder'])
  assert.equal(appToolName(spec, 'queryOrder'), names[0])

  const off = tmpRoot()
  makeApp({ root: off, appId: 'crm', name: 'CRM Portal', mode: 'public', commands: [READ_CMD], enabled: false })
  assert.deepEqual(Object.keys(buildAppTools({ roots: [off], sessionId: 's1' })), [], 'enabled=false 不进工具池')
})
