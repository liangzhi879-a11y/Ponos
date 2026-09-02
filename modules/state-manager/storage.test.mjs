import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFileStorage } from './storage.cjs'

test('createFileStorage 读写往返；缺失文件返回 null；损坏 JSON 返回 null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sms-'))
  try {
    const p = path.join(dir, 'state.json')
    const s = createFileStorage(p)
    assert.equal(s.load(), null)
    s.save({ a: 1 })
    assert.deepEqual(s.load(), { a: 1 })
    writeFileSync(p, '{broken')
    assert.equal(s.load(), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
