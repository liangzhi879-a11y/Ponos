// 日志持久化策略：钳制 / 轮转 / 年龄清理 / 超大裁剪 / 关闭开关 / 文件名闸
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LOG_POLICY, LOG_POLICY_LIMITS, LOG_BASE_NAMES, normalizeLogPolicy, readLogPolicy,
  readLogPolicyCached, _resetLogPolicyCache, writeLogLine, rotateLog, pruneByAge,
  enforceLogPolicy, getLogTail, assertLogFileName, listLogFiles, logDirFor,
} from './log-policy.cjs'

const MB = 1024 * 1024
const tmp = (tag) => mkdtempSync(join(tmpdir(), `logpol-${tag}-`))

test('normalizeLogPolicy：非法值钳制到合法区间，缺省回落默认档', () => {
  const d = normalizeLogPolicy(null)
  assert.deepEqual(d, { ...DEFAULT_LOG_POLICY }, '缺失 → 默认档')
  assert.equal(normalizeLogPolicy({ maxFileBytes: -1 }).maxFileBytes, LOG_POLICY_LIMITS.minFileBytes, '负数 → 下限（而不是坏掉的轮转器）')
  assert.equal(normalizeLogPolicy({ maxFileBytes: 1e12 }).maxFileBytes, LOG_POLICY_LIMITS.maxFileBytes)
  assert.equal(normalizeLogPolicy({ maxFiles: 99 }).maxFiles, LOG_POLICY_LIMITS.maxFiles)
  assert.equal(normalizeLogPolicy({ maxFiles: -3 }).maxFiles, LOG_POLICY_LIMITS.minFiles)
  assert.equal(normalizeLogPolicy({ maxAgeDays: 0 }).maxAgeDays, LOG_POLICY_LIMITS.minAgeDays)
  assert.equal(normalizeLogPolicy({ maxAgeDays: 9999 }).maxAgeDays, LOG_POLICY_LIMITS.maxAgeDays)
  assert.equal(normalizeLogPolicy({ level: 'VERBOSE' }).level, 'info', '非法等级 → info')
  assert.equal(normalizeLogPolicy({ level: 'DEBUG' }).level, 'debug', '大小写容错')
  // 关闭开关：只有显式 false 才关
  assert.equal(normalizeLogPolicy({ persist: false }).persist, false)
  for (const v of [undefined, null, 0, '', 'false', 'no', {}]) {
    assert.equal(normalizeLogPolicy({ persist: v }).persist, true, `persist=${JSON.stringify(v)} 不得关闭持久化`)
  }
  // 字符串数字可被钳制（GUI 表单常传字符串）
  assert.equal(normalizeLogPolicy({ maxFiles: '5' }).maxFiles, 5)
})

test('readLogPolicy：读 config.json 的 logPolicy；缺失/损坏 → 默认且不抛', () => {
  const home = tmp('read')
  try {
    assert.deepEqual(readLogPolicy({ home }), { ...DEFAULT_LOG_POLICY }, '无 config.json → 默认')
    writeFileSync(join(home, 'config.json'), '{ 这不是 json')
    assert.deepEqual(readLogPolicy({ home }), { ...DEFAULT_LOG_POLICY }, '损坏 → 默认')
    writeFileSync(join(home, 'config.json'), JSON.stringify({ providers: [], logPolicy: { maxFiles: 2 } }))
    assert.equal(readLogPolicy({ home }).maxFiles, 2)
    _resetLogPolicyCache()
    const c1 = readLogPolicyCached({ home, ttlMs: 60000 })
    writeFileSync(join(home, 'config.json'), JSON.stringify({ logPolicy: { maxFiles: 7 } }))
    assert.equal(readLogPolicyCached({ home, ttlMs: 60000 }).maxFiles, 2, 'TTL 内走缓存（桥/主进程两进程靠 TTL 取新值）')
    assert.equal(readLogPolicyCached({ home, ttlMs: 0 }).maxFiles, 7, 'TTL 过期即重读')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('writeLogLine：persist:false 不写不建目录；开启则自动建目录并追加', () => {
  const home = tmp('write')
  const dir = logDirFor(home)
  try {
    assert.equal(writeLogLine(join(dir, 'app.log'), 'x', { persist: false }), false)
    assert.ok(!existsSync(dir), 'persist:false 连目录都不该建（零副作用）')
    assert.equal(writeLogLine(join(dir, 'app.log'), 'hello', { persist: true }), true)
    assert.equal(writeLogLine(join(dir, 'app.log'), 'world', { persist: true }), true)
    assert.equal(readFileSync(join(dir, 'app.log'), 'utf-8'), 'hello\nworld\n')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('等级门槛：低于策略等级的行走 log 通道被丢弃，error 永不被丢', () => {
  const home = tmp('level')
  const p = join(logDirFor(home), 'app.log')
  try {
    assert.equal(writeLogLine(p, 'dbg', { level: 'debug' }, 'debug'), true)
    assert.equal(writeLogLine(p, 'inf', { level: 'warn' }, 'info'), false, 'info < warn → 丢弃')
    assert.equal(writeLogLine(p, 'wrn', { level: 'warn' }, 'warn'), true)
    assert.equal(writeLogLine(p, 'err', { level: 'error' }, 'error'), true)
    assert.equal(readFileSync(p, 'utf-8'), 'dbg\nwrn\nerr\n')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('写入超限自动轮转：app.log → .1，且 .1 后移，最旧一份被删', () => {
  const home = tmp('rotate')
  const dir = logDirFor(home)
  const p = join(dir, 'app.log')
  // 上限受 LOG_POLICY_LIMITS 钳制（1KB 会被抬到 64KB）——用合法下限，避免测到"没轮转"
  const cap = LOG_POLICY_LIMITS.minFileBytes
  const policy = { maxFileBytes: cap, maxFiles: 2 }
  try {
    mkdirSync(dir, { recursive: true })
    // 每批 ≈70KB > cap：保证每批至少触发一次轮转（批 C 触发后 .1 必含 C 的行）
    for (const tag of ['A', 'B', 'C']) {
      for (let i = 0; i < 70; i++) writeLogLine(p, `${tag}-${String(i).padStart(3, '0')}-${'x'.repeat(990)}`, policy)
    }
    assert.deepEqual(readdirSync(dir).sort(), ['app.log', 'app.log.1', 'app.log.2'], '保留份数 = maxFiles，不得出现 .3')
    const newest = readFileSync(join(dir, 'app.log.1'), 'utf-8')
    assert.match(newest, /C-/, '.1 是最新一份历史')
    assert.ok(statSync(join(dir, 'app.log.1')).mtimeMs >= statSync(join(dir, 'app.log.2')).mtimeMs, '.1 比 .2 新')
    for (const n of ['app.log', 'app.log.1', 'app.log.2']) {
      assert.ok(statSync(join(dir, n)).size <= cap + 1100, `${n} 应有界（cap + 一行）`)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('rotateLog：maxFiles=0 不留历史（清空而非删文件）；文件不存在返回 false', () => {
  const home = tmp('rot0')
  const p = join(logDirFor(home), 'app.log')
  try {
    mkdirSync(logDirFor(home), { recursive: true })
    writeFileSync(p, 'x'.repeat(5000))
    assert.equal(rotateLog(p, { maxFiles: 0 }), true)
    assert.ok(existsSync(p), '保留文件本身（tail 读取不 ENOENT）')
    assert.equal(readFileSync(p, 'utf-8'), '', '内容清空')
    assert.deepEqual(readdirSync(logDirFor(home)), ['app.log'], '不产生 .1')
    assert.equal(rotateLog(join(logDirFor(home), 'nope.log'), { maxFiles: 3 }), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('pruneByAge：超龄轮转份被删，未超龄保留，无关文件不误删', () => {
  const home = tmp('age')
  const dir = logDirFor(home)
  const p = join(dir, 'app.log')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(p, 'live\n')
    writeFileSync(join(dir, 'app.log.1'), 'old\n')
    writeFileSync(join(dir, 'app.log.2'), 'fresh\n')
    writeFileSync(join(dir, 'last-boot.json'), '{}')
    writeFileSync(join(dir, 'other.log.1'), 'x\n')
    const old = (Date.now() - 20 * 86400_000) / 1000
    utimesSync(join(dir, 'app.log.1'), old, old)
    utimesSync(join(dir, 'other.log.1'), old, old)
    assert.equal(pruneByAge(p, { maxAgeDays: 14 }), 1, '只删 app.log.1')
    assert.ok(!existsSync(join(dir, 'app.log.1')))
    assert.ok(existsSync(join(dir, 'app.log.2')), '未超龄保留')
    assert.ok(existsSync(join(dir, 'app.log')), '主文件永不按年龄删（否则正在写的日志会消失）')
    assert.ok(existsSync(join(dir, 'last-boot.json')), '非轮转份不受影响')
    assert.ok(existsSync(join(dir, 'other.log.1')), '其它基名的同规则文件不由本调用处理')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('enforceLogPolicy：存量超大文件裁到尾部 cap×4 并轮转（76MB app.log 收敛）', () => {
  const home = tmp('enforce')
  const dir = logDirFor(home)
  const p = join(dir, 'app.log')
  const policy = { maxFileBytes: 64 * 1024, maxFiles: 3 }
  try {
    mkdirSync(dir, { recursive: true })
    // 合成"历史遗留巨型日志"：每行 1KB，共 4096 行 = 4MB（≥ cap×4 才触发裁剪）
    const lines = []
    for (let i = 0; i < 4096; i++) lines.push(`line-${String(i).padStart(5, '0')}-${'y'.repeat(1000)}`)
    writeFileSync(p, lines.join('\n') + '\n')
    const before = statSync(p).size
    assert.ok(before > policy.maxFileBytes * 4, '前置：夹具确实超过 cap×4')
    const r = enforceLogPolicy(p, policy)
    assert.equal(r.trimmed, true, '应发生裁剪')
    assert.equal(r.rotated, true, '裁剪后仍超 cap → 应轮转')
    const rotated = join(dir, 'app.log.1')
    assert.ok(existsSync(rotated), '历史落入 .1')
    assert.ok(statSync(rotated).size <= policy.maxFileBytes * 4 + 4096, `单个历史文件应有界（实际 ${statSync(rotated).size}）`)
    assert.ok(!existsSync(p), '轮转后主文件让位（下次写入重新创建）')
    // 尾部内容保留（最后一行还在），旧行被丢弃
    assert.match(readFileSync(rotated, 'utf-8'), /line-04095/)
    assert.doesNotMatch(readFileSync(rotated, 'utf-8'), /line-00000/)
    // 幂等：再次执行不再做任何事
    const again = enforceLogPolicy(p, policy)
    assert.deepEqual(again, { rotated: false, trimmed: false, pruned: 0, skipped: false })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('enforceLogPolicy：persist:false 完全跳过（不裁剪不删除已有日志）', () => {
  const home = tmp('enforce-off')
  const dir = logDirFor(home)
  const p = join(dir, 'app.log')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(p, 'z'.repeat(3 * MB))
    const r = enforceLogPolicy(p, { persist: false, maxFileBytes: 64 * 1024 })
    assert.equal(r.skipped, true)
    assert.equal(statSync(p).size, 3 * MB, '关闭持久化 = 只停写，绝不删/裁已有日志')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('getLogTail：取最近 N 行、n 钳到 1..500、不整读大文件', () => {
  const home = tmp('tail')
  const p = join(logDirFor(home), 'app.log')
  try {
    assert.deepEqual(getLogTail(p, 10), [], '文件不存在 → 空数组（不抛）')
    mkdirSync(logDirFor(home), { recursive: true })
    writeFileSync(p, Array.from({ length: 50 }, (_, i) => `L${i}`).join('\n') + '\n')
    assert.deepEqual(getLogTail(p, 3), ['L47', 'L48', 'L49'])
    assert.equal(getLogTail(p, 0).length, 1, 'n=0 → 钳到 1')
    assert.equal(getLogTail(p, 99999).length, 50, 'n 过大 → 全给（上限 500 行）')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('assertLogFileName：拒穿越/非白名单/超序号；放行白名单与轮转份', () => {
  const policy = { maxFiles: 3 }
  for (const bad of ['../app.log', '..\\app.log', 'config.json', 'app.log.99', 'app.log.4', '/etc/app.log',
    'C:\\x\\app.log', 'other.log', 'app.log.exe', 'kernel-stderr.log.11', '', null, 'app.txt']) {
    const r = assertLogFileName(bad, policy)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒`)
    assert.ok(r.error, '拒绝要带原因')
  }
  assert.equal(assertLogFileName('app.log', policy).ok, true)
  assert.equal(assertLogFileName('app.log.1', policy).ok, true)
  assert.equal(assertLogFileName('kernel-stderr.log.3', policy).ok, true)
  assert.equal(assertLogFileName('renderer-console.log', policy).index, 0)
  assert.deepEqual(LOG_BASE_NAMES, ['app.log', 'kernel-stderr.log', 'renderer-console.log'], '白名单与四处写入点一致')
})

test('listLogFiles：列出白名单内文件（含轮转份），忽略无关文件', () => {
  const home = tmp('list')
  const dir = logDirFor(home)
  try {
    assert.deepEqual(listLogFiles({ dir }), [], '目录不存在 → 空数组')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'app.log'), 'a\n')
    writeFileSync(join(dir, 'app.log.1'), 'b\n')
    writeFileSync(join(dir, 'kernel-stderr.log'), 'c\n')
    writeFileSync(join(dir, 'last-boot.json'), '{}')
    writeFileSync(join(dir, 'config.json.bak.20260912'), '{}')
    const files = listLogFiles({ dir, policy: { maxFiles: 3 } })
    assert.deepEqual(files.map((f) => f.name).sort(), ['app.log', 'app.log.1', 'kernel-stderr.log'])
    assert.ok(files.every((f) => f.size > 0 && Number.isFinite(f.mtimeMs)))
    // 策略收紧后超份数的残留不再列出
    assert.deepEqual(listLogFiles({ dir, policy: { maxFiles: 0 } }).map((f) => f.name).sort(), ['app.log', 'kernel-stderr.log'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})
