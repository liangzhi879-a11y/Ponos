// YFWorking 版本契约：单一数据源 version.mjs（APP_VERSION / KERNEL_VERSION 双版本线）。
// 升级版本号禁止手改——走 scripts/bump-version.mjs 会自动同步本测试期望值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { APP_VERSION, KERNEL_VERSION, SCHEMA_VERSION, buildId } from '../version.mjs'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'yfw-ver-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('版本符合 dev 格式', () => {
  assert.match(APP_VERSION, /^dev \d+\.\d+(\.\d+)?$/, `非法应用版本格式: ${APP_VERSION}`)
  assert.match(KERNEL_VERSION, /^dev \d+\.\d+(\.\d+)?$/, `非法内核版本格式: ${KERNEL_VERSION}`)
})

test('当前版本号（bump 脚本自动同步）', () => {
  assert.equal(APP_VERSION, 'dev 3.0.0')
  assert.equal(KERNEL_VERSION, 'dev 0.1')
})

test('version.mjs 单一数据源：常量 + buildId（env 注入 / dev 默认）', () => {
  assert.ok(typeof APP_VERSION === 'string' && APP_VERSION.length > 0)
  assert.ok(typeof KERNEL_VERSION === 'string' && KERNEL_VERSION.length > 0)
  assert.equal(SCHEMA_VERSION, 1)
  assert.equal(buildId(), 'dev')
  const prev = process.env.YFW_BUILD_ID
  process.env.YFW_BUILD_ID = 'build-123'
  try { assert.equal(buildId(), 'build-123') } finally { if (prev === undefined) delete process.env.YFW_BUILD_ID; else process.env.YFW_BUILD_ID = prev }
})

test('init 事件：version = KERNEL_VERSION + schemaVersion + buildId（含 YFW_BUILD_ID 注入）', async () => {
  const configDir = join(tmp, 'c')
  mkdirSync(configDir, { recursive: true })
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion',
  ], {
    env: { ...process.env, YFW_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir, YFW_BUILD_ID: 'ci-42' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  const waiters = []
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const t = l.trim()
    if (!t) return
    if (waiters.length) waiters.shift()(t)
    else lines.push(t)
  })
  const nextEvent = (ms = 5000) => {
    if (lines.length) return Promise.resolve(JSON.parse(lines.shift()))
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout')), ms)
      waiters.push((l) => { clearTimeout(to); res(JSON.parse(l)) })
    })
  }
  try {
    const ev = await nextEvent()
    assert.equal(ev.type, 'system')
    assert.equal(ev.subtype, 'init')
    assert.equal(ev.version, KERNEL_VERSION)
    assert.equal(ev.schemaVersion, 1)
    assert.equal(ev.buildId, 'ci-42')
  } finally {
    try { child.stdin.end() } catch {}
  }
})
