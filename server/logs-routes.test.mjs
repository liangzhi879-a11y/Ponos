// 日志端点：list/tail 正常路径 + 穿越防护 400 + lines 钳制 + prune 只清轮转份
// 直接调 handleLogsRoute（不起桥）：见 server/logs-routes.mjs 头注释。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleLogsRoute } from './logs-routes.mjs'

const POLICY = { persist: true, level: 'info', maxFileBytes: 5 * 1024 * 1024, maxFiles: 3, maxAgeDays: 14 }
const sp = (obj) => new URLSearchParams(obj)
const call = (pathname, { method = 'GET', params = {}, home, policy = POLICY } = {}) =>
  handleLogsRoute({ method, pathname, searchParams: sp(params), home, policy })

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'logs-api-'))
  const dir = join(home, 'logs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'app.log'), Array.from({ length: 30 }, (_, i) => `L${i}`).join('\n') + '\n')
  writeFileSync(join(dir, 'kernel-stderr.log'), 'ERR\n')
  writeFileSync(join(dir, 'app.log.1'), 'old\n')
  writeFileSync(join(dir, 'config.json'), '{"authToken":"绝密"}')
  return { home, dir }
}

test('未命中 /logs/* 之外的路径返回 null（调用方继续匹配）', () => {
  assert.equal(call('/health'), null)
  assert.equal(call('/api/auth/status'), null)
  assert.equal(call(''), null)
})

test('/logs/list：返回目录、策略、上限、等级清单与文件表（不含 config.json）', () => {
  const { home } = fixture()
  try {
    const r = call('/logs/list', { home })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.persist, true)
    assert.deepEqual(r.body.policy, { ...POLICY })
    assert.ok(r.body.limits.minFileBytes > 0 && r.body.limits.maxFiles === 20)
    assert.deepEqual(r.body.levels, ['debug', 'info', 'warn', 'error'])
    assert.deepEqual(r.body.files.map((f) => f.name).sort(), ['app.log', 'app.log.1', 'kernel-stderr.log'])
    assert.ok(r.body.files.every((f) => f.size > 0))
    assert.equal(r.body.dir, join(home, 'logs'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('/logs/tail：默认取 app.log 最近 200 行；显式 file/lines 生效', () => {
  const { home } = fixture()
  try {
    const all = call('/logs/tail', { home })
    assert.equal(all.status, 200)
    assert.equal(all.body.file, 'app.log')
    assert.equal(all.body.lines.length, 30, '不足 200 行则全给')
    const few = call('/logs/tail', { home, params: { file: 'app.log.1', lines: '1' } })
    assert.deepEqual(few.body.lines, ['old'])
    const k = call('/logs/tail', { home, params: { file: 'kernel-stderr.log' } })
    assert.deepEqual(k.body.lines, ['ERR'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('/logs/tail：lines 钳到 1..500（0/负数/超大/非数字）', () => {
  const { home } = fixture()
  try {
    assert.equal(call('/logs/tail', { home, params: { lines: '0' } }).body.lines.length, 1)
    assert.equal(call('/logs/tail', { home, params: { lines: '-5' } }).body.lines.length, 1)
    assert.equal(call('/logs/tail', { home, params: { lines: '99999' } }).body.lines.length, 30, '上限 500 仍受实际行数限制')
    assert.equal(call('/logs/tail', { home, params: { lines: 'abc' } }).body.lines.length, 30, '非数字 → 默认 200')
    // 明确验证"钳到 500"：造 600 行
    writeFileSync(join(home, 'logs', 'app.log'), Array.from({ length: 600 }, (_, i) => `N${i}`).join('\n') + '\n')
    const big = call('/logs/tail', { home, params: { lines: '99999' } })
    assert.equal(big.body.lines.length, 500, '不得整读返回全部 600 行')
    assert.equal(big.body.lines[0], 'N100')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('/logs/tail：穿越/非白名单一律 400，绝不读到 config.json', () => {
  const { home } = fixture()
  try {
    for (const file of ['../config.json', '..%2Fconfig.json', 'config.json', '/etc/passwd',
      'C:\\Windows\\win.ini', 'app.log.99', 'app.log.9', 'other.log', 'app.log.exe', '..\\config.json']) {
      const r = call('/logs/tail', { home, params: { file } })
      assert.equal(r.status, 400, `${file} 应被拒（实际 ${r.status}）`)
      assert.match(String(r.body.error), /文件名|越界|白名单|序号/)
      assert.equal(r.body.lines, undefined, '被拒时不得回内容')
    }
    // 白名单 + 序号边界应放行
    assert.equal(call('/logs/tail', { home, params: { file: 'app.log.3' } }).status, 200, 'k ≤ maxFiles 放行（文件不存在→空行）')
    assert.equal(call('/logs/tail', { home, params: { file: 'renderer-console.log' } }).status, 200)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('/logs/prune：只删轮转份 + 主文件轮转成 .1；GET 拒绝', () => {
  const { home, dir } = fixture()
  try {
    assert.equal(call('/logs/prune', { home }).status, 405, 'GET 应 405（避免误触发清理）')
    const r = call('/logs/prune', { home, method: 'POST' })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.removed, 1, '只删掉原先的 app.log.1')
    assert.ok(r.body.freedBytes > 0)
    // 主文件被轮转成 .1（内容留一份，路径让出——下一次写入 appendFileSync 会重建主文件）
    assert.deepEqual(readdirSync(dir).sort(), ['app.log.1', 'config.json', 'kernel-stderr.log.1'].sort())
    assert.ok(!existsSync(join(dir, 'config.json.1')), '非日志文件不得被动')
    assert.match(r.body.files.map((f) => f.name).join(','), /app\.log\.1/)
    // 再次清理：这次删掉刚生成的轮转份（主文件此时不存在 → 无内容可轮转）
    const again = call('/logs/prune', { home, method: 'POST' })
    assert.equal(again.body.removed, 2, '两个 .1 都被清掉')
    assert.deepEqual(readdirSync(dir), ['config.json'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('persist:false 时 list 如实上报，但 tail/prune 仍可用（看历史、清磁盘）', () => {
  const { home } = fixture()
  try {
    const off = { ...POLICY, persist: false }
    const list = call('/logs/list', { home, policy: off })
    assert.equal(list.body.persist, false, '面板据此显示"已关闭本地持久化"横幅')
    assert.equal(list.body.files.length, 3, '关闭持久化不影响读已有日志')
    assert.equal(call('/logs/tail', { home, policy: off }).status, 200, '关闭后仍可查看历史')
    assert.equal(call('/logs/prune', { home, policy: off, method: 'POST' }).status, 200, '关闭后仍可清理')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('策略来源：未显式传 policy 时读 home 的 config.json（端点与写入端同源）', () => {
  const { home } = fixture()
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ logPolicy: { maxFiles: 1, persist: false, level: 'error' } }))
    const r = handleLogsRoute({ method: 'GET', pathname: '/logs/list', searchParams: sp({}), home })
    assert.equal(r.body.policy.maxFiles, 1)
    assert.equal(r.body.policy.persist, false)
    assert.equal(r.body.policy.level, 'error')
    assert.deepEqual(r.body.files.map((f) => f.name).sort(), ['app.log', 'app.log.1', 'kernel-stderr.log'], 'app.log.1 序号 1 ≤ maxFiles 1 → 仍列出')
    const pruned = handleLogsRoute({ method: 'POST', pathname: '/logs/prune', searchParams: sp({}), home })
    assert.equal(pruned.status, 200, 'config.json 是日志策略来源，但绝不是日志文件（prune 不碰它）')
    assert.ok(existsSync(join(home, 'config.json')))
  } finally { rmSync(home, { recursive: true, force: true }) }
})
