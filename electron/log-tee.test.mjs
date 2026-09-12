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

// 夹具策略：显式传参，避免用例受"开发机真实 config.json 的 logPolicy"影响（非 hermetic）
const TEE_POLICY = { persist: true, level: 'debug', maxFileBytes: 5 * 1024 * 1024, maxFiles: 3, maxAgeDays: 14 }

test('initLogTee 双写：console 原输出保留 + 文件有内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logtee-'))
  const orig = console.log
  let seen = ''
  console.log = (m) => { seen += m }
  try {
    const { getLogPath } = initLogTee({ logDir: dir, policy: TEE_POLICY })
    console.log('[main] test line')
    assert.match(seen, /test line/)           // 原输出保留
    const content = readFileSync(getLogPath(), 'utf-8')
    assert.match(content, /\[main\] test line/) // 文件有内容
  } finally {
    console.log = orig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rotateIfNeeded 超过上限轮转到 app.log.1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logtee-'))
  const big = join(dir, 'app.log')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, 'x'.repeat(5 * 1024 * 1024 + 1))
  const { rotateIfNeeded } = initLogTee({ logDir: dir, policy: TEE_POLICY })
  rotateIfNeeded()
  assert.ok(!existsSync(big))
  assert.ok(statSync(join(dir, 'app.log.1')).size > 5 * 1024 * 1024)
  rmSync(dir, { recursive: true, force: true })
})

test('超过上限自动轮转：无需手动调 rotateIfNeeded（原实现是死代码，2026-09-12 修复）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logtee-auto-'))
  const orig = console.log
  const policy = { ...TEE_POLICY, maxFileBytes: 64 * 1024, maxFiles: 2 }
  console.log = () => {}
  try {
    const { getLogPath } = initLogTee({ logDir: dir, policy })
    for (let i = 0; i < 90; i++) console.log(`[main] ${i} ${'y'.repeat(990)}`)
    assert.ok(existsSync(join(dir, 'app.log.1')), '超限应自动产生轮转份')
    assert.ok(statSync(getLogPath()).size <= 64 * 1024 + 1100, '主文件应有界')
  } finally {
    console.log = orig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persist:false：不写日志文件（console 原输出仍保留）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logtee-off-'))
  const orig = console.log
  let seen = ''
  console.log = (m) => { seen += m }
  try {
    const { getLogPath } = initLogTee({ logDir: dir, policy: { ...TEE_POLICY, persist: false } })
    console.log('[main] 不该落盘')
    assert.match(seen, /不该落盘/, '关闭持久化不影响 console 输出')
    assert.ok(!existsSync(getLogPath()), '关闭本地持久化后不得再写文件')
  } finally {
    console.log = orig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init 时按策略清理历史：存量超大日志被裁剪（一次性迁移）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logtee-legacy-'))
  mkdirSync(dir, { recursive: true })
  const big = join(dir, 'app.log')
  const policy = { ...TEE_POLICY, maxFileBytes: 64 * 1024 }
  // 3MB 历史文件（模拟"无上限增长"遗留）：应被裁到 cap×4 以内并轮转
  writeFileSync(big, Array.from({ length: 3000 }, (_, i) => `L${i}-${'z'.repeat(1000)}`).join('\n') + '\n')
  try {
    initLogTee({ logDir: dir, policy })
    const rotated = join(dir, 'app.log.1')
    assert.ok(existsSync(rotated), '历史内容应落入轮转份')
    assert.ok(statSync(rotated).size <= policy.maxFileBytes * 4 + 4096, `单个历史文件应有界（实际 ${statSync(rotated).size}）`)
    assert.ok(!existsSync(big), '主文件让位，下次写入重新开始')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('崩溃：落盘 + 清理回调执行 + 非零退出 + stderr 可见', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logtee-crash-'))
  const marker = join(dir, 'crash-ran.txt')
  const script = `
    const { initLogTee } = require(${JSON.stringify(fileURLToPath(new URL('./log-tee.cjs', import.meta.url)))})
    const tee = initLogTee({ logDir: ${JSON.stringify(dir)}, policy: { persist: true, level: 'debug', maxFileBytes: 5 * 1024 * 1024, maxFiles: 3, maxAgeDays: 14 } })
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

// 2026-09-12 修复回归：main.cjs 里数据根兜底注入必须早于 initLogTee()。
// initLogTee 的 logDir 默认值 `join(resolveYfwHome(), 'logs')` 在**调用期**求值——
// 顺序颠倒时 app.log 落到旧根 ~/.yfworking/logs（实测存量 4.78MB），而
// renderer-console.log 走 /logs 路由在请求期才解析 home、一直在新根 ⇒ 只有 app.log
// 错位，按新根找日志的内置查看器看不到它。该不变量只能由源码顺序保证，故在此锁死。
test('main.cjs：YFWORKING_HOME 兜底注入必须早于 initLogTee()（app.log 落错根回归）', () => {
  const src = readFileSync(new URL('./main.cjs', import.meta.url), 'utf-8')
  // 锚点用完整语句而非裸符号：顶部注释里也含 "initLogTee()" 字样，裸 indexOf 会先命中注释
  const atInject = src.indexOf("process.env.YFWORKING_HOME = path.join(os.homedir(), '.yfw')")
  const atTee = src.indexOf('const logTee = initLogTee(')
  assert.ok(atInject > -1, 'main.cjs 必须有 YFWORKING_HOME 兜底注入')
  assert.ok(atTee > -1, 'main.cjs 必须调用 initLogTee()')
  assert.ok(atInject < atTee, `兜底注入（偏移 ${atInject}）必须早于 initLogTee()（偏移 ${atTee}）`)
})
