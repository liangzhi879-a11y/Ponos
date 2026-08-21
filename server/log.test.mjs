// server/log.test.mjs —— 内核结构化日志（docs/production/reliability.md R5-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createLogger } from '../kernel/log.mjs'

function sink() {
  const lines = []
  const s = new Writable({ write(c, e, cb) { lines.push(c.toString().trim()); cb() } })
  return { s, lines }
}

test('createLogger：JSON 行到 stderr + sid/extra 展开', () => {
  const { s, lines } = sink()
  const log = createLogger({ sink: s, level: 'debug', sid: 's1' })
  log.info('turn start', { turn: 1 })
  log.error('api failed', new Error('boom'))
  assert.equal(lines.length, 2)
  const a = JSON.parse(lines[0])
  assert.equal(a.level, 'info'); assert.equal(a.sid, 's1'); assert.equal(a.msg, 'turn start'); assert.equal(a.turn, 1)
  const b = JSON.parse(lines[1])
  assert.equal(b.level, 'error'); assert.equal(b.err, 'boom')
  assert.ok(a.ts && b.ts)
})

test('createLogger：级别过滤（默认 info 不落 debug）', () => {
  const { s, lines } = sink()
  const log = createLogger({ sink: s, sid: '' })
  log.debug('hidden')
  log.info('shown')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /"msg":"shown"/)
})
