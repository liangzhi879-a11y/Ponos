// 浏览器白名单写入（2026-09-10）：内核 Browser 工具白名单审批通过后由 bridge
// 写 {YFW_HOME}/browser-whitelist.json 的 allow 数组——执行器 mtime 热重载即时
// 生效。本文件钉死：文件创建/追加/幂等/非法域名拒绝/既有条目保留。
// bridge.mjs 模块求值即监听端口——测试环境必须在 import 前关掉顶层 listen
//（YFW_BRIDGE_NO_LISTEN 约定）并用临时 YFWORKING_HOME，故用动态导入。
process.env.YFW_BRIDGE_NO_LISTEN = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'browser-wl-bridge-'))
process.env.YFWORKING_HOME = home
const { addBrowserWhitelist } = await import('./bridge.mjs')

const cfgPath = join(home, 'browser-whitelist.json')
const readAllow = () => {
  try { return JSON.parse(readFileSync(cfgPath, 'utf-8')).allow } catch { return null }
}

test('addBrowserWhitelist：文件不存在时创建并写入域名', () => {
  assert.equal(addBrowserWhitelist('example.com'), true)
  assert.deepEqual(readAllow(), ['example.com'])
})

test('addBrowserWhitelist：追加新域名且保留既有条目', () => {
  assert.equal(addBrowserWhitelist('other.org'), true)
  const allow = readAllow()
  assert.ok(allow.includes('example.com'), '既有条目保留')
  assert.ok(allow.includes('other.org'), '新条目追加')
  assert.equal(allow.length, 2)
})

test('addBrowserWhitelist：同域名重复添加幂等（不产生重复条目）', () => {
  assert.equal(addBrowserWhitelist('Example.COM'), true, '大小写归一后命中既有条目，返回成功')
  assert.equal(readAllow().length, 2, '不产生重复条目')
})

test('addBrowserWhitelist：非法域名拒绝（不落盘）', () => {
  const before = JSON.stringify(readAllow())
  assert.equal(addBrowserWhitelist('bad host!'), false)
  assert.equal(addBrowserWhitelist(''), false)
  assert.equal(JSON.stringify(readAllow()), before, '文件不变')
})

test('addBrowserWhitelist：损坏的既有文件重建（不崩）', () => {
  writeFileSync(cfgPath, '{broken json', 'utf-8')
  assert.equal(addBrowserWhitelist('recover.dev'), true)
  assert.deepEqual(readAllow(), ['recover.dev'], '损坏文件重建为有效白名单')
})

// ── 2026-09-17 修复：静默失败 → 显式拒绝 + 日志 ──────────────────────────────
// 旧实现对非法值**静默** return false（不写盘、不报错、不打日志），而内核只看审批结果就回
// 模型"已批准，请重试" ⇒ agent 重试仍被拦 → 再弹审批 → 用户再同意，形成死循环。
// 下两条钉死：① 中文占位符「该域名」必须被拒且**留日志**；② 合法主机名（含 IPv6）能真的写进去。
test('addBrowserWhitelist：中文占位符「该域名」被拒且留日志（绝不再静默）', () => {
  const before = JSON.stringify(readAllow())
  const warns = []
  const orig = console.warn
  console.warn = (...a) => warns.push(a.map(String).join(' '))
  try {
    assert.equal(addBrowserWhitelist('该域名'), false)
  } finally { console.warn = orig }
  assert.equal(JSON.stringify(readAllow()), before, '不落盘')
  assert.ok(warns.some((w) => w.includes('rejected invalid host')), '必须有日志——静默是死循环的根源之一')
  assert.ok(warns.some((w) => w.includes('该域名')), '日志含被拒原值，便于排查')
})

test('addBrowserWhitelist：合法主机名（含 IPv6 字面量）真的写入，与读取端口径一致', () => {
  // 读取端 electron/browser-common.cjs 用同一个 normalizeWhitelistHost ⇒ 写进去的必然认得出
  assert.equal(addBrowserWhitelist('[::1]'), true, 'IPv6 回环（此前会被 /^[a-z0-9.-]+$/ 拒掉）')
  assert.ok(readAllow().includes('[::1]'))
  assert.equal(addBrowserWhitelist('ok.host'), true)
  assert.equal(addBrowserWhitelist('OK.HOST'), true, '大小写归一后幂等')
  assert.equal(readAllow().filter((x) => x === 'ok.host').length, 1, '不产生重复条目')
})
