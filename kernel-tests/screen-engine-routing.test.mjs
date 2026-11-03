import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ENGINE = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')
const CLI = readFileSync(new URL('../kernel/cli.mjs', import.meta.url), 'utf8')

test('★ ① 独立的 screenWaiters（不得复用 browserWaiters —— 回执会投错）', () => {
  assert.match(ENGINE, /const screenWaiters = new Map\(\)/)
  const i = ENGINE.indexOf('const screenWaiters = new Map()')
  assert.ok(Math.abs(i - ENGINE.indexOf('const browserWaiters = new Map()')) < 1500,
    'screenWaiters 应与 browserWaiters/appWaiters 声明在一处')
})

test('★ ② runScreen 与 runBrowser 同构：发 route:screen', () => {
  assert.match(ENGINE, /async function runScreen\s*\(/)
  const i = ENGINE.indexOf('async function runScreen')
  const block = ENGINE.slice(i, i + 2600)
  assert.match(block, /route:\s*'screen'/)
  assert.match(block, /screenWaiters/)
  assert.match(block, /SCREEN_TIMEOUT_MS/)
  assert.match(block, /isError:\s*true/)
  assert.match(block, /content:/)
})

test('★ ③ resolveScreen 实例方法（cli 靠它解除挂起）', () => {
  assert.match(ENGINE, /resolveScreen\s*\(requestId,\s*resp\)\s*\{/)
  const i = ENGINE.indexOf('resolveScreen(')
  assert.match(ENGINE.slice(i, i + 300), /screenWaiters\.delete\(requestId\)/)
})

test('★ ④ rejectAllWaiters 必须清理 screenWaiters（原稿漏掉的一处）', () => {
  const i = ENGINE.indexOf('function rejectAllWaiters()')
  assert.ok(i > 0)
  assert.match(ENGINE.slice(i, i + 1600), /screenWaiters/,
    '取消会话时必须解除 screen 挂起，否则工具边界卡到超时')
})

test('★ ⑤ screenDriver 必须注入 toolCtx', () => {
  assert.match(ENGINE, /screenDriver:\s*runScreen/)
})

test('★ ⑥ cli 必须有 screen_response 路由', () => {
  assert.match(CLI, /subtype === 'screen_response'/)
  const i = CLI.indexOf("subtype === 'screen_response'")
  assert.match(CLI.slice(i, i + 300), /engine\.resolveScreen\(/)
})

test('超时可配且有默认值', () => {
  const i = ENGINE.indexOf('PONOS_SCREEN_TIMEOUT_MS')
  assert.ok(i > 0)
  assert.match(ENGINE.slice(i, i + 120), /\|\|\s*\d/)
})
