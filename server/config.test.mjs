// server/config.test.mjs —— 配置目录解析 + 共享目录（docs/production/security.md S5-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolveConfigDir, sharedDirFor } from '../kernel/config.mjs'

test('resolveConfigDir：CLAUDE_CONFIG_DIR > YFWORKING_HOME > ~/.yfworking', () => {
  const h = mkdtempSync(join(tmpdir(), 'cfg-'))
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: join(h, 'a') }, () => h), join(h, 'a'))
  assert.equal(resolveConfigDir({ YFWORKING_HOME: join(h, 'b') }, () => h), join(h, 'b'))
  assert.equal(resolveConfigDir({}, () => h), join(h, '.yfworking'))
})

test('sharedDirFor：configDir 下 shared 子目录', () => {
  assert.equal(sharedDirFor('/x/.yfworking'), join('/x/.yfworking', 'shared'))
})
