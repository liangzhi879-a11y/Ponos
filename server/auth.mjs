import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_FAILS = 5
const LOCK_MS = 30_000

function authPath() {
  if (process.env.YFW_AUTH_FILE) return process.env.YFW_AUTH_FILE
  return join(process.env.YFWORKING_HOME || join(homedir(), '.yfworking'), 'auth.json')
}
function readState() {
  try { return JSON.parse(readFileSync(authPath(), 'utf8')) } catch { return null }
}
function writeState(s) { writeFileSync(authPath(), JSON.stringify(s, null, 2)) }
function hashOf(password, salt) {
  return scryptSync(String(password), salt, 32, { N: 16384 }).toString('hex')
}
function locked(state) {
  const lu = state && state.lockedUntil
  if (!lu) return null
  const left = lu - Date.now()
  return left > 0 ? left : null
}

export async function getAuthStatus() {
  const st = readState()
  if (!st || !st.hash) return { phase: 'uninitialized' }
  const left = locked(st)
  if (left != null) return { phase: 'locked', lockedForMs: left }
  return { phase: 'ok' }
}
export async function setupPassword(password) {
  const cur = await getAuthStatus()
  if (cur.phase !== 'uninitialized') throw new Error('auth: already initialized')
  if (String(password).length < 4) throw new Error('auth: password too short')
  const salt = randomBytes(16).toString('hex')
  writeState({ version: 1, salt, hash: hashOf(password, salt), failCount: 0, lockedUntil: 0 })
}
export async function checkPassword(password) {
  const st = readState()
  if (!st || !st.hash) throw new Error('auth: not initialized')
  const left = locked(st)
  if (left != null) return { ok: false, reason: 'bad-password', lockedForMs: left }
  const ok = st.salt && timingSafeEqual(Buffer.from(hashOf(password, st.salt), 'hex'), Buffer.from(st.hash, 'hex'))
  const failCount = ok ? 0 : (st.failCount || 0) + 1
  writeState({ ...st, failCount, lockedUntil: ok ? 0 : (failCount >= MAX_FAILS ? Date.now() + LOCK_MS : st.lockedUntil || 0) })
  if (!ok && failCount >= MAX_FAILS) return { ok: false, reason: 'bad-password', lockedForMs: LOCK_MS }
  return ok ? { ok: true } : { ok: false, reason: 'bad-password', lockedForMs: null }
}
