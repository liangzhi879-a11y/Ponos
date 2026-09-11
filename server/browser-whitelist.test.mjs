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
