// Vault 工具的内核侧接线守卫（2026-10-22）。
// 与 screen-engine-routing.test.mjs 同法：这五处任何一处漏接，表现都是"工具调用静默超时"
// （执行器其实早回了），是最难从现象定位的一类缺陷。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ENGINE = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')
const CLI = readFileSync(new URL('../kernel/cli.mjs', import.meta.url), 'utf8')

test('★ ① 独立的 vaultWaiters（不得复用 browser/app/screen 的挂起表）', () => {
  assert.match(ENGINE, /const vaultWaiters = new Map\(\)/)
  const i = ENGINE.indexOf('const vaultWaiters = new Map()')
  assert.ok(Math.abs(i - ENGINE.indexOf('const screenWaiters = new Map()')) < 800,
    'vaultWaiters 应与其它挂起表声明在一处（便于审查是否漏了清理）')
})

test('★ ② runVault 与 runBrowser/runScreen 同构：发 route:vault', () => {
  assert.match(ENGINE, /async function runVault\s*\(/)
  const i = ENGINE.indexOf('async function runVault')
  const block = ENGINE.slice(i, i + 2600)
  assert.match(block, /route:\s*'vault'/)
  assert.match(block, /vaultWaiters/)
  assert.match(block, /VAULT_TIMEOUT_MS/)
  assert.match(block, /isError:\s*true/)
  assert.match(block, /content:/)
  assert.match(block, /denied/, 'denied 必须给模型一条不重试的提示（否则会原地打转）')
})

test('★ ③ 超时默认值必须大于主进程审批闸门的单次等待上限（90s）', () => {
  const i = ENGINE.indexOf('PONOS_VAULT_TIMEOUT_MS')
  assert.ok(i > 0, '超时须可配')
  const m = /PONOS_VAULT_TIMEOUT_MS\s*\|\|\s*(\d[\d_]*)/.exec(ENGINE.slice(i, i + 120))
  assert.ok(m, '必须有默认值')
  const ms = Number(m[1].replace(/_/g, ''))
  assert.ok(ms > 90_000, `默认 ${ms}ms 必须 > 90_000ms（否则用户还在看弹窗，内核先超时）`)
})

test('★ ④ resolveVault 实例方法（cli 靠它解除挂起）', () => {
  assert.match(ENGINE, /resolveVault\s*\(requestId,\s*resp\)\s*\{/)
  const i = ENGINE.indexOf('resolveVault(')
  assert.match(ENGINE.slice(i, i + 300), /vaultWaiters\.delete\(requestId\)/)
})

test('★ ⑤ rejectAllWaiters 必须清理 vaultWaiters（取消/打断不得卡到超时）', () => {
  const i = ENGINE.indexOf('function rejectAllWaiters()')
  assert.ok(i > 0)
  assert.match(ENGINE.slice(i, i + 2000), /vaultWaiters/)
})

test('★ ⑥ vaultDriver 必须注入 toolCtx', () => {
  assert.match(ENGINE, /vaultDriver:\s*runVault/)
})

test('★ ⑦ cli 必须有 vault_response 路由', () => {
  assert.match(CLI, /subtype === 'vault_response'/)
  const i = CLI.indexOf("subtype === 'vault_response'")
  assert.match(CLI.slice(i, i + 300), /engine\.resolveVault\(/)
})

test('★ ⑧ Vault 结果绝不落盘（persistToolResult 必须跳过 Vault）', () => {
  const i = ENGINE.indexOf('persistToolResult(store || session')
  assert.ok(i > 0)
  const before = ENGINE.slice(Math.max(0, i - 500), i)
  assert.match(before, /toolUse\.name === 'Vault'/, 'Vault 的 get 回执含明文，必须像 Read 一样内联、不得写进 tool-results/')
})

test('★ ⑨ 用户钩子拿不到 Vault 明文（output 置空 + password 脱敏）', () => {
  assert.match(ENGINE, /function hookInputOf\s*\(/, '必须有入参脱敏函数')
  assert.match(ENGINE, /params\.password = '\[redacted\]'/, 'password 字段必须脱敏')
  assert.match(ENGINE, /input: hookInputOf\(toolUse\.name, toolUse\.input\)/)
  assert.match(ENGINE, /toolUse\.name === 'Vault' \? '' :/, 'Vault 的 output 不得交给钩子')
})
