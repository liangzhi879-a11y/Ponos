// server/agents-routes.test.mjs
// `GET /agents` 路由（2026-09-15，批次二 H）。直调纯 handler，不起 bridge / 不起内核子进程
// （本仓库纪律，见 server/agents-routes.mjs 头注）。
//
// 为什么这些断言重要（都是"功能看起来在、实际不在"的典型）：
//   ① **停用项必须仍在列表里**（带 `disabled: true`）——否则用户停掉某个内置 agent 后它就消失，
//      **永远点不回来**，开关成了单向操作；
//   ② `builtin` 标记要能区分"内核硬编码内置"与"用户 .md"，界面据此分组；
//   ③ 只在内核里存在的 5 个 agent（researcher/implementer/reviewer/explorer/planner）必须出现
//      —— 这正是 H 要补的覆盖缺口，缺了等于没修。
//
// 隔离纪律：configDir 为 mkdtempSync 临时目录，绝不碰真实 ~/.yfworking。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAgentsRoute } from './agents-routes.mjs'

/** H 条款的核心缺口：这 5 个内置 agent 的定义只在 kernel 里，GUI 列表没有。 */
const KERNEL_ONLY = ['researcher', 'implementer', 'reviewer', 'explorer', 'planner']

const tmp = () => mkdtempSync(join(tmpdir(), 'ponos-agents-routes-'))
const call = (configDir, { method = 'GET', pathname = '/agents' } = {}) =>
  handleAgentsRoute({ method, pathname, configDir })

function writeAgentFixture(dir, id, description) {
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'agents', `${id}.md`),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n你是 ${id}。\n`, 'utf-8')
}

test('路径/方法不匹配 → 返回 null（不得吞掉别的请求）', async () => {
  const dir = tmp()
  try {
    assert.equal(await call(dir, { pathname: '/skills' }), null)
    assert.equal(await call(dir, { pathname: '/disabled' }), null)
    assert.equal(await call(dir, { method: 'PUT', pathname: '/agents' }), null, '只支持 GET')
    assert.equal(await call(dir, { method: 'DELETE', pathname: '/agents' }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('**核心**：只在内核里存在的 5 个内置 agent 必须出现在列表里（H 要补的缺口）', async () => {
  const dir = tmp()
  try {
    const r = await call(dir)
    assert.equal(r.status, 200)
    const ids = r.body.agents.map((a) => a.id)
    for (const id of KERNEL_ONLY) {
      assert.ok(ids.includes(id), `缺 ${id} ⇒ 用户在界面上看不到它，也就停不掉（H 未修好）`)
    }
    // general-purpose 在两边都有（GUI 列表里也有），同样应在
    assert.ok(ids.includes('general-purpose'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('builtin 标记：内核内置为 true，用户 .md 为 false', async () => {
  const dir = tmp()
  try {
    writeAgentFixture(dir, 'demo-user-agent', '用户自定义测试 agent')
    const r = await call(dir)
    const byId = new Map(r.body.agents.map((a) => [a.id, a]))
    assert.equal(byId.get('researcher').builtin, true, '内置应标 true（界面据此分组展示）')
    assert.equal(byId.get('demo-user-agent').builtin, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('**核心**：停用项仍留在列表里且标记 disabled=true（否则无法重新启用）', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'disabled.json'),
      JSON.stringify({ schemaVersion: 1, agents: ['researcher'], skills: [] }), 'utf-8')
    const r = await call(dir)
    const item = r.body.agents.find((a) => a.id === 'researcher')
    assert.ok(item, '**关键**：停用后不得从列表消失 —— 消失了用户就永远点不回来（单向开关）')
    assert.equal(item.disabled, true, '必须带 disabled 标记，界面据此显示"已停用"并允许点回启用')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('disabled 标记与注册表一致（未停用的项为 false）', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'disabled.json'),
      JSON.stringify({ schemaVersion: 1, agents: ['reviewer'], skills: [] }), 'utf-8')
    const r = await call(dir)
    const byId = new Map(r.body.agents.map((a) => [a.id, a]))
    assert.equal(byId.get('reviewer').disabled, true)
    assert.equal(byId.get('researcher').disabled, false, '不得误标其他 agent（停用只影响目标项）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('字段完整性：id/name/description/tools/disallowedTools 都在，且 tools 是字面量串', async () => {
  const dir = tmp()
  try {
    writeAgentFixture(dir, 'demo-user-agent', '用户自定义测试 agent')
    const r = await call(dir)
    const item = r.body.agents.find((a) => a.id === 'demo-user-agent')
    assert.equal(item.name, 'demo-user-agent')
    assert.equal(item.description, '用户自定义测试 agent')
    assert.equal(typeof item.tools, 'string', 'tools 按原始字面量返回（GUI 侧 parseAgentTools 三态展示）')
    assert.ok(Array.isArray(item.disallowedTools))
    // 内置 agent 的工具声明是显式清单，必须原样透出（界面据此显示"能否读文件"）
    const researcher = r.body.agents.find((a) => a.id === 'researcher')
    assert.match(researcher.tools, /Read/, '内置只读 agent 的工具声明必须透出（含 Read）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('注册表损坏 → 不抛错，全部按未停用返回（与内核容错口径一致）', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'disabled.json'), '{ 坏 JSON', 'utf-8')
    const r = await call(dir)
    assert.equal(r.status, 200, '读失败退化为"全部未停用"，不得让接口 500')
    assert.ok(r.body.agents.every((a) => a.disabled === false))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('configDir 缺失 → 只返回内核内置（不崩）', async () => {
  const r = await call(undefined)
  assert.equal(r.status, 200)
  const ids = r.body.agents.map((a) => a.id)
  for (const id of KERNEL_ONLY) assert.ok(ids.includes(id), '内置定义不依赖 configDir')
})
