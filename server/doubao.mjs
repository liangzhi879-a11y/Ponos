import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'fs'
import { resolveYfwHome } from './yfw-home.cjs'

// 数据根每次调用经共享模块 yfw-home.cjs 延迟解析（读 env：YFWORKING_HOME ||
// CLAUDE_CONFIG_DIR || ~/.yfworking）；测试设 YFWORKING_HOME 指向临时目录即可隔离，
// 不碰真实 ~/.yfworking；延迟读取避免 ESM import 求值顺序问题（顶层求值时 env 可能未设）。
export const sessionFile = () => join(resolveYfwHome(), 'doubao-session.json')
export const historyFile = () => join(resolveYfwHome(), 'doubao-history.json')
export const imagesDir = () => join(resolveYfwHome(), 'doubao-images')

let rateReqTimes = []

function readJson(p) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null } catch { return null }
}
function writeJson(p, v) {
  mkdirSync(resolveYfwHome(), { recursive: true })
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
