// kernel/settings.mjs —— 分层 settings（user < project < local 深合并，docs/production/platform.md P4-3）
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_VERSION } from '../version.mjs'

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

// —— D2-1 settings schema 版本化：迁移链 + 校验 ——
// v0 = 无 schemaVersion 字段的旧文件；迁移表 { from: fn }，fn 返回 from+1 版本数据。
export const MIGRATIONS = {
  0: (d) => ({ ...d, schemaVersion: 1 }),
}

export function migrateSettings(data = {}) {
  let current = data
  let from = Number(current.schemaVersion)
  if (!Number.isFinite(from) || from < 0) from = 0
  let migrated = false
  while (from < SCHEMA_VERSION) {
    const fn = MIGRATIONS[from]
    if (!fn) break // 缺迁移函数：停在当前版本（不硬失败）
    current = fn(current)
    from++
    migrated = true
  }
  return { data: current, from: Number(data.schemaVersion) || 0, to: from, migrated }
}

export function validateSettings(data = {}) {
  const v = Number(data.schemaVersion)
  if (Number.isFinite(v) && v > SCHEMA_VERSION) {
    return { ok: false, error: `settings schema 版本 ${v} 高于内核支持的 ${SCHEMA_VERSION}，请升级内核` }
  }
  return { ok: true, error: null }
}

export function loadSettings({ configDir = '', cwd = '', local = {} } = {}) {
  const userPath = configDir ? join(configDir, 'settings.json') : ''
  const projectPath = cwd ? join(cwd, '.yfworking', 'settings.json') : ''
  const user = readJson(userPath)
  const project = readJson(projectPath)
  // 迁移只对已存在的 user 文件执行：无文件 = 无配置，merged 保持空（P4 既有语义）
  const { data: migratedUser, migrated } = userPath && existsSync(userPath)
    ? migrateSettings(user)
    : { data: user, migrated: false }
  const valid = validateSettings(migratedUser)
  return {
    user: migratedUser,
    project,
    local,
    merged: deepMerge(deepMerge(migratedUser, project), local),
    paths: { user: userPath, project: projectPath },
    schema: { version: SCHEMA_VERSION, migrated, error: valid.error },
  }
}
