import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAuthStatus, setupPassword, checkPassword } from './auth.mjs'

function freshFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-auth-'))
  process.env.YFW_AUTH_FILE = join(dir, 'auth.json')
  t.after(() => { delete process.env.YFW_AUTH_FILE; rmSync(dir, { recursive: true, force: true }) })
}

test('未初始化 phase=uninitialized', async (t) => {
  freshFile(t)
  assert.deepEqual(await getAuthStatus(), { phase: 'uninitialized' })
})

test('setup 后 phase=ok，checkPassword 正确口令通过/错误口令拒绝', async (t) => {
  freshFile(t)
  await setupPassword('hello123')
  assert.equal((await getAuthStatus()).phase, 'ok')
  assert.deepEqual(await checkPassword('hello123'), { ok: true })
  assert.equal((await checkPassword('wrong')).ok, false)
})

test('错误 5 次进入锁定，锁定期内拒绝', async (t) => {
  freshFile(t)
  await setupPassword('hello123')
  for (let i = 0; i < 5; i++) await checkPassword('wrong')
  const st = await getAuthStatus()
  assert.equal(st.phase, 'locked')
  assert.ok(st.lockedForMs > 0)
  assert.equal((await checkPassword('hello123')).ok, false) // 锁定中即使口令对也拒
})

test('auth.json 不存明文口令', async (t) => {
  freshFile(t)
  await setupPassword('hello123')
  const raw = (await import('node:fs')).readFileSync(process.env.YFW_AUTH_FILE, 'utf8')
  assert.ok(!raw.includes('hello123'))
})
