// server/settings.test.mjs —— 分层 settings（docs/production/platform.md P4-3）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deepMerge, loadSettings } from '../kernel/settings.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'yfw-settings-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('deepMerge：标量覆盖 / 对象递归 / 数组替换 / undefined 跳过', () => {
  const base = { a: 1, b: { x: 1, y: 2 }, c: [1, 2], d: 'keep' }
  const over = { a: 2, b: { y: 3, z: 4 }, c: [9], d: undefined }
  assert.deepEqual(deepMerge(base, over), { a: 2, b: { x: 1, y: 3, z: 4 }, c: [9], d: 'keep' })
})

test('loadSettings：user < project < local 三级合并 + paths', () => {
  const configDir = join(tmp, 'cfg')
  const cwd = join(tmp, 'proj')
  mkdirSync(join(configDir), { recursive: true })
  mkdirSync(join(cwd, '.yfworking'), { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ model: 'user-model', hooks: [{ event: 'sessionStart' }], env: { A: '1' } }), 'utf-8')
  writeFileSync(join(cwd, '.yfworking', 'settings.json'), JSON.stringify({ model: 'project-model', env: { B: '2' } }), 'utf-8')
  const r = loadSettings({ configDir, cwd, local: { model: 'local-model' } })
  assert.equal(r.merged.model, 'local-model')
  assert.equal(r.merged.env.B, '2')
  assert.equal(r.merged.env.A, '1')
  assert.equal(r.merged.hooks.length, 1)
  assert.ok(r.paths.user.endsWith('settings.json') && r.paths.project.endsWith('settings.json'))
})

test('loadSettings：无文件时返回空对象', () => {
  const r = loadSettings({ configDir: join(tmp, 'nope'), cwd: join(tmp, 'nope2') })
  assert.deepEqual(r.merged, {})
})

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')

function makeReader(stream) {
  const lines = []
  const waiters = []
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', (l) => {
    const line = l.trim()
    if (!line) return
    if (waiters.length) waiters.shift()(line)
    else lines.push(line)
  })
  return {
    nextEvent(timeoutMs = 5000) {
      if (lines.length) return Promise.resolve(JSON.parse(lines.shift()))
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('read timeout: ' + JSON.stringify(lines))), timeoutMs)
        waiters.push((l) => { clearTimeout(t); resolve(JSON.parse(l)) })
      })
    },
  }
}

test('settings 集成：项目 settings.model 注入 system(init)', async () => {
  const configDir = join(tmp, 'cfg2')
  const cwd = join(tmp, 'proj2')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(cwd, '.yfworking'), { recursive: true })
  writeFileSync(join(cwd, '.yfworking', 'settings.json'), JSON.stringify({ model: 'my-model' }), 'utf-8')
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd,
  ], {
    env: { ...process.env, YFW_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_MODEL: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  try {
    const ev = await reader.nextEvent()
    assert.equal(ev.type, 'system')
    assert.equal(ev.subtype, 'init')
    assert.equal(ev.model, 'my-model')
  } finally {
    try { child.stdin.end() } catch {}
  }
})
