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

test('sanitizeId 兜底与截断（空/超长都不得产出非法或超长分区名）', () => {
  assert.equal(sanitizeId(''), 'unknown')
  assert.equal(sanitizeId(null), 'unknown')
  assert.equal(sanitizeId(undefined), 'unknown')
  assert.equal(sanitizeId('  '), '__', '空白字符会被替换成下划线（不是空串，故不触发 unknown 兜底）')
  assert.equal(sanitizeId('a'.repeat(200)).length, 64, '超长必须截断，否则分区名会撑爆文件路径')
  assert.equal(appSessionKey({ appId: 'x'.repeat(200), target: { type: 'desktop' } }).length, 4 + 64)
})

test('分区字符串不得在别处手写（写错会静默落到别的分区 → Cookie 读空 → 误判"未登录"）', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = path.join(process.cwd())
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name === 'src' || e.name === 'electron') walk(full); continue }
      if (/\.(cjs|mjs|ts|tsx)$/.test(e.name) && !full.includes('app-session-key.test.mjs')) files.push(full)
    }
  }
  walk(root)
  const offenders = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    src.split(/\r?\n/).forEach((line, i) => {
      if (!line.includes('persist:automation-')) return
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (!code.includes('persist:automation-')) return   // 注释里提到不算（用于解释来龙去脉）
      if (path.basename(f) === 'app-session-key.cjs') return
      offenders.push(`${path.relative(root, f)}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [], `这些地方手写了分区前缀，必须改用 partitionFor()：${offenders.join(', ')}`)
})
