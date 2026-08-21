// kernel/settings.mjs —— 分层 settings（user < project < local 深合并，docs/production/platform.md P4-3）
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function deepMerge(base, override) {
  const out = { ...(base || {}) }
  for (const [k, v] of Object.entries(override || {})) {
    if (v === undefined) continue
    if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
        out[k] !== null && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

function readJson(p) {
  if (!p || !existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return {} }
}

export function loadSettings({ configDir = '', cwd = '', local = {} } = {}) {
  const userPath = configDir ? join(configDir, 'settings.json') : ''
  const projectPath = cwd ? join(cwd, '.yfworking', 'settings.json') : ''
  const user = readJson(userPath)
  const project = readJson(projectPath)
  return {
    user,
    project,
    local,
    merged: deepMerge(deepMerge(user, project), local),
    paths: { user: userPath, project: projectPath },
  }
}
