import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAuthStatus, setupPassword, checkPassword, changePassword } from './auth.mjs'

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

test('setupPassword 非字符串口令（undefined/12345）拒绝，phase 保持 uninitialized 且不写文件', async (t) => {
  freshFile(t)
  // undefined → String 为 "undefined" 长度 9，旧守卫放行、现应被类型感知守卫拒绝
  await assert.rejects(setupPassword(undefined), /auth: password too short/)
  // 数字口令即使字面长度达标（"12345" 长度 5）也非字符串，应拒绝
  await assert.rejects(setupPassword(12345), /auth: password too short/)
  assert.deepEqual(await getAuthStatus(), { phase: 'uninitialized' })
  assert.equal(existsSync(process.env.YFW_AUTH_FILE), false)
})

// 修改密码（2026-09-10 个人信息窗）
test('changePassword：旧密验证 → 新密生效；未初始化时直接设置', async (t) => {
  freshFile(t)
  await setupPassword('oldpass')
  const bad = await changePassword('wrong', 'newpass')
  assert.equal(bad.ok, false)
  assert.equal((await checkPassword('oldpass')).ok, true, '旧密未变')
  const good = await changePassword('oldpass', 'newpass')
  assert.equal(good.ok, true)
  assert.equal((await checkPassword('newpass')).ok, true)
  assert.equal((await checkPassword('oldpass')).ok, false)
})

test('changePassword：未初始化 → 直接设置新密码', async (t) => {
  freshFile(t)
  const r = await changePassword('', 'firstpass')
  assert.equal(r.ok, true)
  assert.equal(r.wasUninitialized, true)
  assert.equal((await checkPassword('firstpass')).ok, true)
})
