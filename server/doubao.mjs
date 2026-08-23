import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'fs'

// HOME 延迟读取（每次调用读 env）：测试通过 PONOS_TEST_HOME 隔离，
// 避免 ESM import 求值顺序问题（模块顶层求值时 env 可能尚未设置）
export const homeDir = () => process.env.PONOS_TEST_HOME || homedir()
export const sessionFile = () => join(homeDir(), '.ponos', 'doubao-session.json')
export const historyFile = () => join(homeDir(), '.ponos', 'doubao-history.json')
export const imagesDir = () => join(homeDir(), '.ponos', 'doubao-images')

let rateReqTimes = []

function readJson(p) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null } catch { return null }
}
function writeJson(p, v) {
  mkdirSync(join(homeDir(), '.ponos'), { recursive: true })
  writeFileSync(p, JSON.stringify(v, null, 2), 'utf-8')
}

export function getSessionCookies() {
  const s = readJson(sessionFile())
  return s && Array.isArray(s.cookies) ? s.cookies : []
}
export function isLoggedIn() {
  return getSessionCookies().some(c => c.name === 'sessionid' && c.value)
}
export function saveSession(cookies) {
  writeJson(sessionFile(), { exportedAt: Date.now(), cookies: Array.isArray(cookies) ? cookies : [] })
  try { chmodSync(sessionFile(), 0o600) } catch {}
}
export function clearSession() {
  try { rmSync(sessionFile(), { force: true }) } catch {}
}
export function readSessionMeta() {
  try {
    const s = JSON.parse(readFileSync(sessionFile(), 'utf-8'))
    return s && typeof s.exportedAt === 'number' ? { exportedAt: s.exportedAt } : null
  } catch { return null }
}

export function addHistory(entry) {
  const list = listHistory()
  list.unshift({ ...entry, createdAt: Date.now() })
  writeJson(historyFile(), list.slice(0, 100))
  return true
}
export function listHistory() {
  return readJson(historyFile()) || []
}
export function removeHistory(id) {
  writeJson(historyFile(), listHistory().filter(x => x.id !== id))
  return true
}

export function rateLimitHit() {
  // 滑动窗口：1 秒内最多 3 次（多图一次生成 4 张连续下载不误伤，仍限滥用）
  const now = Date.now()
  rateReqTimes = rateReqTimes.filter(t => now - t < 1000)
  if (rateReqTimes.length >= 3) return true
  rateReqTimes.push(now)
  return false
}
