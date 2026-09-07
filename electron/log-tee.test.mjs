import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTee, initLogTee } from './log-tee.cjs'

test('createTee 加时间戳前缀并写入', () => {
  const lines = []
  const tee = createTee(l => lines.push(l))
  tee.log('hello')
  tee.error('boom')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]*Z\] hello$/)
  assert.match(lines[1], /^\[\d{4}-\d{2}-\d{2}T[\d:.]*Z\] boom$/)
})

test('createTee 吞掉写入异常（EPIPE 场景）', () => {
  const tee = createTee(() => { const e = new Error('EPIPE'); e.code = 'EPIPE'; throw e })
  assert.doesNotThrow(() => tee.log('x'))
})

test('initLogTee 双写：console 原输出保留 + 文件有内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logtee-'))
  const orig = console.log
  let seen = ''
  console.log = (m) => { seen += m }
  try {
    const { getLogPath } = initLogTee({ logDir: dir })
    console.log('[main] test line')
    assert.match(seen, /test line/)           // 原输出保留
    const content = readFileSync(getLogPath(), 'utf-8')
    assert.match(content, /\[main\] test line/) // 文件有内容
  } finally {
    console.log = orig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rotateIfNeeded 超过 5MB 轮转到 app.log.1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logtee-'))
  const big = join(dir, 'app.log')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, 'x'.repeat(5 * 1024 * 1024 + 1))
  const { rotateIfNeeded } = initLogTee({ logDir: dir })
  rotateIfNeeded()
  assert.ok(!existsSync(big))
  assert.ok(statSync(join(dir, 'app.log.1')).size > 5 * 1024 * 1024)
  rmSync(dir, { recursive: true, force: true })
})

test('崩溃：落盘 + 清理回调执行 + 非零退出 + stderr 可见', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logtee-crash-'))
  const marker = join(dir, 'crash-ran.txt')
  const script = `
    const { initLogTee } = require(${JSON.stringify(fileURLToPath(new URL('./log-tee.cjs', import.meta.url)))})
    const tee = initLogTee({ logDir: ${JSON.stringify(dir)} })
    tee.onCrash(() => require('fs').writeFileSync(${JSON.stringify(marker)}, '1'))
    throw new Error('boom-test')
  `
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' })
  assert.notEqual(r.status, 0)                       // 非零退出
  assert.match(r.stderr, /boom-test/)                 // stderr 可见
  assert.match(readFileSync(join(dir, 'app.log'), 'utf-8'), /\[uncaughtException\].*boom-test/)  // 落盘
  assert.ok(existsSync(marker))                       // 清理回调已执行
  rmSync(dir, { recursive: true, force: true })
})
