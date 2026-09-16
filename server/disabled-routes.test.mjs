// server/disabled-routes.test.mjs
// `/disabled` 路由（2026-09-15，P1 D 条款）。**直调纯 handler，不起 bridge、不起内核子进程**
// （本仓库纪律，见 server/disabled-routes.mjs 头注与 knowledge-routes.test.mjs 的先例）。
//
// 为什么必须测这一层而不只测 kernel/disabled.mjs：真正会坏的是**接线**——路径拼错、方法漏判、
// 只改一个键时把另一个清空、坏负载写坏文件。这些都发生在 handler 里，注册表单测看不见。
//
// 隔离纪律：configDir 为 mkdtempSync 临时目录，绝不碰真实 ~/.yfworking。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleDisabledRoute } from './disabled-routes.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'ponos-disabled-routes-'))
/** 造一次请求：body 为对象则序列化；`raw` 直接给字符串（测坏负载）。 */
const call = (configDir, { method = 'GET', pathname = '/disabled', body, raw } = {}) => handleDisabledRoute({
  method, pathname, configDir,
  readJsonBody: async () => {
    if (raw !== undefined) return JSON.parse(raw)   // 与 bridge 的同名实现一样会抛
    return body
  },
})

test('路径不匹配 → 返回 null（交给后续路由，不得吞掉别的请求）', async () => {
  const dir = tmp()
  try {
    assert.equal(await call(dir, { pathname: '/skills' }), null)
    assert.equal(await call(dir, { pathname: '/knowledge/spaces' }), null)
    assert.equal(await call(dir, { method: 'DELETE', pathname: '/disabled' }), null, '不支持的方法也不得拦截')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GET：空注册表返回两个空数组 + readable=true', async () => {
  const dir = tmp()
  try {
    const r = await call(dir)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.skills, [])
    assert.deepEqual(r.body.agents, [])
    assert.equal(r.body.readable, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GET：注册表损坏时 readable=false（"停用没生效"要能在界面上被解释）', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'disabled.json'), '{坏', 'utf-8')
    const r = await call(dir)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.skills, [])
    assert.equal(r.body.readable, false, '读失败必须透出，而不是假装"没停用任何项"')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PUT：写入落盘到 <configDir>/disabled.json（内核读的同一处）', async () => {
  const dir = tmp()
  try {
    const r = await call(dir, { method: 'PUT', body: { skills: ['s-a'], agents: ['general-purpose'] } })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true, r.body.error)
    assert.equal(existsSync(join(dir, 'disabled.json')), true)
    const onDisk = JSON.parse(readFileSync(join(dir, 'disabled.json'), 'utf-8'))
    assert.deepEqual(onDisk.skills, ['s-a'])
    assert.deepEqual(onDisk.agents, ['general-purpose'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PUT：只改传入的键（跨面板操作不得互相清空）', async () => {
  const dir = tmp()
  try {
    await call(dir, { method: 'PUT', body: { skills: ['s-a'], agents: ['general-purpose'] } })
    const a = await call(dir, { method: 'PUT', body: { skills: ['s-b'] } })
    assert.deepEqual(a.body.skills, ['s-b'])
    assert.deepEqual(a.body.agents, ['general-purpose'], '未传入的键必须保持原值')

    const b = await call(dir, { method: 'PUT', body: { agents: [] } })
    assert.deepEqual(b.body.agents, [])
    assert.deepEqual(b.body.skills, ['s-b'], '清空 agents 不得连带清空 skills')

    // 空对象 = 什么都不改（而不是"清空全部"）
    const c = await call(dir, { method: 'PUT', body: {} })
    assert.deepEqual(c.body.skills, ['s-b'])
    assert.deepEqual(c.body.agents, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PUT：脏负载归一后落盘（去空/去重/保序）', async () => {
  const dir = tmp()
  try {
    const r = await call(dir, { method: 'PUT', body: { skills: ['x', 'x', '', ' y '] } })
    assert.deepEqual(r.body.skills, ['x', 'y'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PUT：坏 JSON → 400 且磁盘既有注册表**不被改动**', async () => {
  const dir = tmp()
  try {
    await call(dir, { method: 'PUT', body: { skills: ['keep-me'] } })
    const before = readFileSync(join(dir, 'disabled.json'), 'utf-8')
    const r = await call(dir, { method: 'PUT', raw: '{ 坏的' })
    assert.equal(r.status, 400, '坏负载必须报错，不能静默写成"全开"')
    assert.match(r.body.error, /JSON/)
    assert.equal(readFileSync(join(dir, 'disabled.json'), 'utf-8'), before, '失败请求不得改动磁盘状态')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PUT → GET 往返：写进去的能读回来（注册表不是 write-only）', async () => {
  const dir = tmp()
  try {
    await call(dir, { method: 'PUT', body: { skills: ['s-1', 's-2'], agents: ['a-1'] } })
    const r = await call(dir)
    assert.deepEqual(r.body.skills, ['s-1', 's-2'])
    assert.deepEqual(r.body.agents, ['a-1'])
    assert.equal(r.body.readable, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
