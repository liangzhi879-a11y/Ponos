// server/session-meta.test.mjs —— P6 D2-2 transcript meta 版本标记（新会话首行 + 旧格式 v1 适配）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore, TRANSCRIPT_SCHEMA_VERSION } from '../kernel/session.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'ponos-meta-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('新会话：文件首行写 transcript schemaVersion meta', () => {
  const configDir = join(tmp, 'c1')
  const store = createSessionStore({ configDir, cwd: '/proj', sessionId: 'sess-1' })
  assert.ok(existsSync(store.file))
  const firstLine = readFileSync(store.file, 'utf-8').split('\n')[0]
  const meta = JSON.parse(firstLine)
  assert.equal(meta.type, 'meta')
  assert.equal(meta.kind, 'transcript')
  assert.equal(meta.schemaVersion, TRANSCRIPT_SCHEMA_VERSION)
  // meta 不占 seq：首个 user 条目 seq 为 1
  store.appendUser('hello')
  const lines = readFileSync(store.file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  const user = lines.find((l) => l.type === 'user')
  assert.equal(user.seq, 1)
})

test('load：meta 不投影进 deriveMessages + 返回 metaVersion', async () => {
  const configDir = join(tmp, 'c2')
  const store = createSessionStore({ configDir, cwd: '/proj', sessionId: 'sess-2' })
  store.appendUser('hi')
  store.appendAssistant([{ type: 'text', text: 'yo' }])
  const r = await store.load()
  assert.equal(r.metaVersion, TRANSCRIPT_SCHEMA_VERSION)
  const msgs = store.deriveMessages()
  assert.equal(msgs.length, 2) // 只有 user + assistant，无 meta
})

test('旧格式兼容：无 meta 首行的 transcript → load 正常 + metaVersion=1', async () => {
  const configDir = join(tmp, 'c3')
  const store = createSessionStore({ configDir, cwd: '/proj', sessionId: 'sess-3' })
  // 模拟旧文件：直接覆写为无 meta 的旧格式
  const { writeFileSync } = await import('node:fs')
  writeFileSync(store.file, [
    JSON.stringify({ type: 'user', id: 'a', seq: 1, timestamp: new Date().toISOString(), message: { role: 'user', content: 'old' } }),
    JSON.stringify({ type: 'assistant', id: 'b', seq: 2, timestamp: new Date().toISOString(), message: { role: 'assistant', content: 'old reply' } }),
    '',
  ].join('\n'), 'utf-8')
  const r = await store.load()
  assert.equal(r.metaVersion, 1)
  assert.equal(store.deriveMessages().length, 2)
})
