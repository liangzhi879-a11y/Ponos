import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { appSessionKey, partitionFor, hostOf, sanitizeId } = require('../electron/app-session-key.cjs')

test('web 目标按站点主机名取键（apex/www 归一，cookie 本来就互通）', () => {
  assert.equal(appSessionKey({ target: { type: 'web', url: 'https://www.kimi.com/chat' } }), 'app-site-kimi.com')
  assert.equal(appSessionKey({ appId: 'my-app', target: { type: 'web', url: 'https://kimi.com' } }), 'app-site-kimi.com')
})

test('desktop 目标按 appId 取键；无 appId 兜底 app-probe', () => {
  assert.equal(appSessionKey({ appId: 'my-app', target: { type: 'desktop', exePath: 'C:\\a.exe' } }), 'app-my-app')
  assert.equal(appSessionKey({ target: { type: 'desktop' } }), 'app-probe')
})

test('web 目标网址不可解析时退回 appId / app-probe（绝不返回空键）', () => {
  assert.equal(appSessionKey({ appId: 'x1', target: { type: 'web', url: '不是网址' } }), 'app-x1')
  assert.equal(appSessionKey({ target: { type: 'web', url: '' } }), 'app-probe')
})

test('appId 里的非法字符被清洗（分区名会进文件路径）', () => {
  assert.equal(sanitizeId('a b/c\\d'), 'a_b_c_d')
  assert.equal(appSessionKey({ appId: 'a b/c', target: { type: 'desktop' } }), 'app-a_b_c')
})

test('partitionFor 是分区字符串的唯一出处', () => {
  assert.equal(partitionFor('app-site-kimi.com'), 'persist:automation-app-site-kimi.com')
})

test('hostOf 对非法输入返回 null（不抛）', () => {
  assert.equal(hostOf('https://a.b/c'), 'a.b')
  assert.equal(hostOf('nope'), null)
})
