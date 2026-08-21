// server/provider-chain.test.mjs —— P4-1 provider 配置传递链（providers.json 播种 + 视觉透传）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFromFile, visionFromEnv, getProvider } from '../kernel/provider.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'yfw-prov-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('seedFromFile：读取 providers.json 激活 active provider', () => {
  const p = join(tmp, 'providers.json')
  writeFileSync(p, JSON.stringify({
    activeProvider: 'p2',
    providers: [
      { id: 'p1', apiBaseUrl: 'https://a.example.com', authToken: 'tok-a', primaryModel: 'm-a' },
      { id: 'p2', apiBaseUrl: 'https://b.example.com', authToken: 'tok-b', primaryModel: 'm-b', contextWindow: 200000 },
    ],
  }), 'utf-8')
  assert.equal(seedFromFile(p), true)
  const prov = getProvider()
  assert.ok(prov, '激活后 getProvider 有值')
  assert.equal(prov.baseUrl, 'https://b.example.com')
  assert.equal(prov.authToken, 'tok-b')
  assert.equal(prov.model, 'm-b')
})

test('seedFromFile：文件缺失/active 配置不全 → false 不激活', () => {
  assert.equal(seedFromFile(join(tmp, 'nope.json')), false)
  const p = join(tmp, 'bad.json')
  writeFileSync(p, JSON.stringify({ activeProvider: 'x', providers: [{ id: 'x' }] }), 'utf-8')
  assert.equal(seedFromFile(p), false)
})

test('visionFromEnv：YFW_VISION_* 解析 + 缺字段返回 null', () => {
  assert.deepEqual(visionFromEnv({ YFW_VISION_BASE_URL: 'https://v.example.com', YFW_VISION_MODEL: 'gpt-v', YFW_VISION_AUTH_TOKEN: 'tv' }),
    { baseUrl: 'https://v.example.com', model: 'gpt-v', configured: true })
  assert.equal(visionFromEnv({ YFW_VISION_BASE_URL: 'https://v.example.com' }), null)
  assert.equal(visionFromEnv({}), null)
})
