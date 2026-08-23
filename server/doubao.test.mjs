import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as d from './doubao.mjs'   // homeDir() 延迟读取 env，模块求值时机无关紧要

let home
before(() => {
  home = mkdtempSync(join(tmpdir(), 'doubao-test-'))
  process.env.PONOS_TEST_HOME = home
})
after(() => { rmSync(home, { recursive: true, force: true }) })

test('isLoggedIn: 无会话文件返回 false', () => {
  assert.equal(d.isLoggedIn(), false)
})

test('saveSession + isLoggedIn: 写 sessionid cookie 后为 true', () => {
  d.saveSession([{ name: 'sessionid', value: 'abc123', domain: '.doubao.com', path: '/' }])
  assert.equal(d.isLoggedIn(), true)
  const raw = JSON.parse(readFileSync(d.sessionFile(), 'utf-8'))
  assert.ok(raw.exportedAt > 0)
  assert.equal(raw.cookies[0].value, 'abc123')
})

test('clearSession: 清除后为 false', () => {
  d.clearSession()
  assert.equal(d.isLoggedIn(), false)
})

test('readSessionMeta: 返回 exportedAt', () => {
  d.saveSession([{ name: 'sessionid', value: 'x', domain: '.doubao.com', path: '/' }])
  const m = d.readSessionMeta()
  assert.ok(m && m.exportedAt > 0)
})

test('history: add/list/remove 与上限', () => {
  for (let i = 0; i < 105; i++) d.addHistory({ id: `h${i}`, prompt: `p${i}`, imageUrl: `u${i}` })
  const list = d.listHistory()
  assert.equal(list.length, 100)
  assert.equal(list[0].prompt, 'p104')
  assert.ok(list.every(x => x.createdAt > 0))
  d.removeHistory('h104')
  assert.equal(d.listHistory().some(x => x.id === 'h104'), false)
})

test('rateLimitHit: 1 秒窗口内第 4 次调用为 true（多图连发不误伤）', () => {
  assert.equal(d.rateLimitHit(), false)
  assert.equal(d.rateLimitHit(), false)
  assert.equal(d.rateLimitHit(), false)
  assert.equal(d.rateLimitHit(), true)
})
