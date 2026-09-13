// 应用智控：工具命名的**唯一真源**
//
// 为什么必须单独抽出：工具名有两处消费者——
//   ① kernel/app-tools.mjs 用它生成给 LLM 的工具名
//   ② 权限规则注入用它生成 `app_*:*` 规则
// 两侧若不一致，规则永远命中不到工具 → read 放不了行、write 挡不住。
// 故一律调用本函数，不得各自拼名。
import { shortHash } from './dyntools.mjs'

export const APP_TOOL_PREFIX = 'app_'

/**
 * 应用工具名：`app_<slug>_<action>`
 *
 * 与 dyntools.slugToToolName 的差异（有意为之，不可直接复用后者）：
 *  - 前缀是 `app_`，不是 `run_`（后者是工作流专用命名空间）
 *  - 中文名（如「甲系统」）经非 ASCII 清洗后为空 → 回退到 `app_a<appId 短哈希>`，
 *    而不是 `run_workflow_<hash>`；否则多个中文应用会坍缩同名。
 *
 * @param {{name?:string, appId?:string}} spec
 * @param {string} action 命令 action
 * @returns {string}
 */
export function appToolName(spec, action) {
  const raw = String(spec?.name || spec?.appId || '')
  const slug = raw.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
  const base = slug || `a${shortHash(spec?.appId || raw)}`
  return `${APP_TOOL_PREFIX}${base}_${action}`
}

/**
 * 把 Spec 的命令映射为 [{ name, kind, cmd }]。
 * 供 app-tools.mjs（建工具）与 app-permissions.mjs（注入规则）共用，
 * 保证两侧**同源同序**。
 * @param {object} spec
 * @returns {Array<{name:string, kind:'read'|'write', cmd:object}>}
 */
export function appCommandTools(spec) {
  const commands = Array.isArray(spec?.commands) ? spec.commands : []
  return commands
    .filter((c) => c && c.action)
    .map((c) => ({ name: appToolName(spec, c.action), kind: c.kind, cmd: c }))
}

/** 判定某条规则是否为本模块注入的 app 规则（形如 `app_xxx_y:*`） */
export function isAppRule(rule) {
  const s = String(rule || '')
  return s.startsWith(APP_TOOL_PREFIX) && s.endsWith(':*')
}
