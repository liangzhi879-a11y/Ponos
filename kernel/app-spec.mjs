// 应用智控：Spec 读取 / 校验 / 可见性判定 / 绑定读取
// 纯函数 + 零依赖：内核（kernel/cli.mjs）是独立进程，此处不得依赖 Electron。
//
// 本模块是「应用智控」在内核侧的**唯一读入口**：
//   - registry.json  → 应用清单
//   - <appId>/spec.json → 单应用命令表（App Spec）
//   - binding.json   → 当前会话绑定的应用（严格单开，值为字符串而非数组）
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** expose 三态：private 永不接给 agent / console 仅进入控制台的会话可见 / public 全局 */
export const EXPOSE_MODES = ['private', 'console', 'public']

/** 单应用命令数上限（防止工具池被单个应用撑爆，与 dyntools 的 LIMIT_DEFAULT 同思路） */
export const MAX_COMMANDS_PER_APP = 20

/** 缺省可见性：console（不进公共注册表，进入卡片才绑定） */
const DEFAULT_EXPOSE_MODE = 'console'

/** 宽容读 JSON：文件缺失/损坏一律返回 null，不抛（内核请求期间不应因坏文件崩） */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return null }
}

const rootList = (roots) => (Array.isArray(roots) ? roots : (roots ? [roots] : []))

/**
 * 读所有 root 下的 registry.json，合并应用清单。
 * 兼容两种形状：[...] 或 { version, apps: [...] }
 * @returns {Array<{id:string,name?:string,targetType?:string,enabled?:boolean}>}
 */
export function listApps({ roots = [] } = {}) {
  const out = []
  for (const root of rootList(roots)) {
    if (!root) continue
    const reg = readJson(join(root, 'registry.json'))
    const items = Array.isArray(reg) ? reg : (Array.isArray(reg?.apps) ? reg.apps : [])
    for (const a of items) if (a && a.id) out.push(a)
  }
  return out
}

/**
 * 读单应用 spec.json（按 root 顺序，首个命中优先）。
 * @returns {object|null}
 */
export function loadSpec({ roots = [], appId } = {}) {
  if (!appId) return null
  for (const root of rootList(roots)) {
    if (!root) continue
    const p = join(root, appId, 'spec.json')
    if (existsSync(p)) return readJson(p)
  }
  return null
}

/**
 * 读当前会话绑定的应用 id。
 * 严格单开：binding.json 形如 { "<sessionId>": { appId, boundAt } }，值为字符串。
 * @returns {string|null}
 */
export function getBoundApp({ roots = [], sessionId = null } = {}) {
  if (!sessionId) return null
  for (const root of rootList(roots)) {
    if (!root) continue
    const binding = readJson(join(root, 'binding.json'))
    const appId = binding?.[sessionId]?.appId
    if (appId) return appId
  }
  return null
}

/**
 * 可见性三态判定（与 kernel/dyntools.mjs 的 visibilityOf 同构）。
 *   private → 永不可见（仅允许在控制台手工执行）
 *   console → 仅当本会话绑定的就是本应用（默认）
 *   public  → 始终可见
 * 未知 mode 一律不可见（fail-safe：宁可少给，不可错给）。
 * @param {object} spec
 * @param {{agentId?:string|null, boundApp?:string|null}} ctx
 * @returns {boolean}
 */
export function isAppVisible(spec, { agentId = null, boundApp = null } = {}) {
  if (!spec) return false
  const mode = spec.expose?.mode || DEFAULT_EXPOSE_MODE
  if (!EXPOSE_MODES.includes(mode)) return false
  if (mode === 'private') return false
  if (mode === 'console') return !!boundApp && boundApp === spec.appId
  return true // public
}

/**
 * Spec 结构校验（纯机械判定，不含 LLM 判断）。
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateSpec(spec) {
  const errors = []
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, errors: ['spec 必须是对象'] }
  }
  if (spec.specVersion !== 1) errors.push('specVersion 必须为 1')
  if (!spec.appId) errors.push('缺少 appId')
  if (!spec.name) errors.push('缺少 name')
  if (!['web', 'desktop'].includes(spec.target?.type)) errors.push('target.type 必须为 web 或 desktop')

  if (!Array.isArray(spec.commands)) {
    errors.push('commands 必须是数组')
    return { ok: errors.length === 0, errors }
  }

  if (spec.commands.length > MAX_COMMANDS_PER_APP) {
    errors.push(`commands 数量超过上限 ${MAX_COMMANDS_PER_APP}`)
  }

  const seen = new Set()
  for (const c of spec.commands) {
    if (!c || typeof c !== 'object') { errors.push('命令必须是对象'); continue }
    if (!c.action) errors.push('命令缺少 action')
    else if (seen.has(c.action)) errors.push(`action 重复：${c.action}`)
    else seen.add(c.action)

    if (!['read', 'write'].includes(c.kind)) {
      errors.push(`命令 ${c.action || '?'} 的 kind 必须为 read 或 write`)
    }
    // params 必须是数组：与工作流 inputs 同构，才能直接喂 deriveInputSchema()
    if (c.params != null && !Array.isArray(c.params)) {
      errors.push(`命令 ${c.action || '?'} 的 params 必须是数组`)
    }
    if (!Array.isArray(c.steps) || c.steps.length === 0) {
      errors.push(`命令 ${c.action || '?'} 缺少 steps`)
    }
  }

  return { ok: errors.length === 0, errors }
}
