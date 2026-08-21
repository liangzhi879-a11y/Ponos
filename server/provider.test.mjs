import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getProvider, setProvider, providerVersion } from '../kernel/provider.mjs'

test('未激活时 getProvider 每次现读 env（含运行时改动）', () => {
  process.env.ANTHROPIC_BASE_URL = 'http://a'
  process.env.ANTHROPIC_AUTH_TOKEN = 'k1'
  process.env.ANTHROPIC_MODEL = 'm1'
  assert.deepEqual(getProvider(), { baseUrl: 'http://a', authToken: 'k1', model: 'm1' })
  process.env.ANTHROPIC_BASE_URL = 'http://b'   // 运行时改 env 必须生效（现有测试模式）
  assert.equal(getProvider().baseUrl, 'http://b')
})

test('setProvider 校验：非 http(s) baseUrl / 空 authToken / 空 model 抛错', () => {
  assert.throws(() => setProvider({ baseUrl: 'ftp://x', authToken: 'k', model: 'm' }), /http/)
  assert.throws(() => setProvider({ baseUrl: 'http://x', authToken: '', model: 'm' }), /authToken/)
  assert.throws(() => setProvider({ baseUrl: 'http://x', authToken: 'k', model: '' }), /model/)
})

test('setProvider 激活后固定 registry 值 + version 递增 + 尾部斜杠归一', () => {
  const r1 = setProvider({ baseUrl: 'http://api.example.com/', authToken: 'k2', model: 'm2' })
  assert.equal(r1.version, 1)
  assert.equal(getProvider().baseUrl, 'http://api.example.com')  // 斜杠被归一
  assert.equal(getProvider().model, 'm2')
  process.env.ANTHROPIC_BASE_URL = 'http://zzz'   // 激活后 env 改动不再生效
  assert.equal(getProvider().baseUrl, 'http://api.example.com')
  const r2 = setProvider({ baseUrl: 'http://new.example.com', authToken: 'k3', model: 'm3' })
  assert.equal(r2.version, 2)
  assert.equal(providerVersion(), 2)
})
