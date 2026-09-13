// 应用智控：权限规则注入（安全双保险的**主机制**）
//
// 与 kernel/approval-mode.mjs 的 `appTool` 兜底类分工：
//   主机制（本模块）：按 Spec 的 kind 精确注入显式规则 —— read 放行、write 询问。
//   兜底（approval-mode）：规则未注入/加载失败时，app_* 一律归入保守类 → 默认档也会询问。
// 兜底无法区分 read/write（工具名里没有 kind），所以它只在主机制失效时生效，方向是"宁可多问"。
//
// ★ 规则格式必须是 `<工具名>:*`，不能是裸工具名。
//   kernel/permissions.mjs 的 matchRule 第一件事是 `indexOf(':')`，**不带冒号直接 return false**；
//   且非 Bash 工具只有 `pattern === '*'` 才命中。实测：
//     rules.ask  = ['app_x_submit']      + bypass → allow（裸名失效）
//     rules.ask  = ['app_x_submit:*']    + bypass → ask  ✓
//     rules.allow= ['app_x_query:*']     + manual → allow ✓
//
// ★ 显式规则优先级高于档位表（decideToolPermission 的 ② 早于 ④，命中即定），
//   因此 write 的 ask 规则在**任何档位（含 bypass）**都会生效 —— 这才是「write 需人工确认」的最终保证。
import { appCommandTools, isAppRule } from './app-naming.mjs'

/** 本模块已注入过的规则（用于精确回收，避免误删用户手写的 app_ 规则） */
let injected = new Set()

const ensureArray = (rules, key) => {
  if (!Array.isArray(rules[key])) rules[key] = []
  return rules[key]
}

/**
 * 把绑定应用的命令按 kind 注入显式规则；并回收上一轮注入的规则。
 *
 * 设计为**幂等 + 可反复调用**：cli.mjs 在 setDynamicTools 的视图函数里每次求值都调它，
 * 于是「用户切换应用 / 编辑 Spec / 漂移修复」都能立刻反映到权限判定上，无需重启内核。
 *
 * @param {object}   p
 * @param {object}   p.rules  内核的 permissionRules 对象（engine 持有其引用，改它即生效）
 * @param {object|null} p.spec 当前会话绑定的应用 Spec；null 表示无绑定 → 只回收不注入
 * @returns {{allowed:string[], asked:string[]}} 本次生效的规则（便于诊断/测试）
 */
export function syncAppPermissionRules({ rules, spec }) {
  if (!rules || typeof rules !== 'object') throw new Error('syncAppPermissionRules 需要 rules 对象')

  const allow = ensureArray(rules, 'allow')
  const ask = ensureArray(rules, 'ask')

  // ① 回收上一轮注入（只删自己注入过的，不碰用户手写规则）
  if (injected.size > 0) {
    for (const arr of [allow, ask]) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (injected.has(arr[i])) arr.splice(i, 1)
      }
    }
    injected = new Set()
  }

  // ② 无绑定 → 不注入
  if (!spec) return { allowed: [], asked: [] }

  // ③ 按 kind 注入（同一 action 重复出现时后写覆盖先写，这里用 Set 去重）
  const asked = new Set()
  const allowed = new Set()
  for (const { name, kind } of appCommandTools(spec)) {
    const rule = `${name}:*`
    if (kind === 'write') { ask.push(rule); asked.add(rule); injected.add(rule) }
    else { allow.push(rule); allowed.add(rule); injected.add(rule) }
  }

  return { allowed: [...allowed], asked: [...asked] }
}

/** 测试辅助：清空"已注入"记录（不影响 rules 内容） */
export function __resetInjectedForTest() {
  injected = new Set()
}

export { isAppRule }
