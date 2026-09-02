import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnvelope, validateEnvelope, decrementTtl } from './envelope.cjs'
import { createRouter } from './router.cjs'

test('makeEnvelope 注入路由头，默认 ttl 16', () => {
  const env = makeEnvelope({ method: 'a.b', params: { x: 1 }, x_sender: 'm1', x_target: 'broadcast' })
  assert.equal(env.jsonrpc, '2.0')
  assert.equal(env.x_ttl, 16)
  assert.equal(env.x_target, 'broadcast')
})

test('validateEnvelope 拒绝缺失 method / 非法 ttl', () => {
  assert.equal(validateEnvelope({ jsonrpc: '2.0', method: '' }).ok, false)
  assert.equal(validateEnvelope({ jsonrpc: '2.0', method: 'a', x_ttl: 0 }).ok, false)
  assert.equal(validateEnvelope(makeEnvelope({ method: 'a', x_sender: 'm' })).ok, true)
})

test('decrementTtl 递减并在 0 时停止', () => {
  const env = makeEnvelope({ method: 'a', x_sender: 'm' })
  assert.equal(decrementTtl(env), 15)
  const zero = { ...env, x_ttl: 1 }
  assert.equal(decrementTtl(zero), 0)
})

test('invoke 调用已注册 handler 并传 ctx.sender', async () => {
  const r = createRouter()
  let seenSender = null
  r.register('a.b', async (params, ctx) => { seenSender = ctx.sender; return params.v * 2 }, { capabilities: ['a'] })
  const env = makeEnvelope({ method: 'a.b', params: { v: 21 }, x_sender: 'm1' })
  const res = await r.invoke(env)
  assert.equal(res.ok, true)
  assert.equal(res.result, 42)
  assert.equal(seenSender, 'm1')
})

test('invoke 未注册方法返回 METHOD_NOT_FOUND；无权限返回 PERMISSION_DENIED', async () => {
  const r = createRouter()
  r.register('a.c', () => 'ok', { capabilities: ['a'] })
  const env1 = makeEnvelope({ method: 'nope', x_sender: 'm1' })
  assert.equal((await r.invoke(env1)).error, 'METHOD_NOT_FOUND')
  // capabilities 匹配：method 以任一 capability 为前缀才放行
  const env2 = makeEnvelope({ method: 'a.c', x_sender: 'm1' })
  const env3 = makeEnvelope({ method: 'other.x', x_sender: 'm1' })
  // 已注册但 capability 不覆盖其命名空间 → 路由侧 PERMISSION_DENIED
  r.register('other.x', () => 'x', { capabilities: ['a'] })
  assert.equal((await r.invoke(env3)).error, 'PERMISSION_DENIED')
  assert.equal((await r.invoke(env2)).ok, true)
})

test('notify 忽略错误，discover/listMethods 内省可用', async () => {
  const r = createRouter()
  r.register('a.d', () => 'v', { capabilities: ['a'] })
  await r.notify(makeEnvelope({ method: 'missing', x_sender: 'm' })) // 不抛
  assert.deepEqual(r.listMethods(), ['a.d'])
  assert.deepEqual(r.discover(), [{ method: 'a.d', capabilities: ['a'] }])
})
