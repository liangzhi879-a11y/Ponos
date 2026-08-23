// Ponos-turbo 工具权限判定（docs/bridge-contract.md §4 can_use_tool 协议）
// ---------------------------------------------------------------------------
// 净室语义：--dangerously-skip-permissions 使低危工具自动执行；Bash 高危命令
// 仍发 can_use_tool control_request 挂起，经 GUI 审批（approval 事件）后以
// control_response 解除。这保证 GUI 审批弹窗工作流（契约 §5 approval）可用。
// headless 场景（benchmark/CI 无审批者）：--auto-approve-high-risk 与
// skipPermissions 同时开启时，高危命令也自动放行，避免永久挂起。
// S3-1：--permission-rules-file 的显式规则优先于默认判定，优先级 deny > ask > allow。
import { matchesHighRisk } from './highrisk.mjs'

// S3-1 规则匹配：条目 Tool:pattern（pattern 支持 * 通配）。Bash 匹配命令文本；
// 非 Bash 仅 "Tool:*"（全工具）与精确工具名命中。
function patternToRegExp(pattern) {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')
}
function matchRule(rule, toolName, command) {
  const idx = String(rule).indexOf(':')
  if (idx < 0) return false
  const t = rule.slice(0, idx)
  const pattern = rule.slice(idx + 1)
  if (t !== toolName) return false
  if (pattern === '*') return true
  if (toolName === 'Bash' && command) return patternToRegExp(pattern).test(command.trim())
  return false
}
function matchList(list, toolName, command) {
  for (const rule of list || []) if (matchRule(rule, toolName, command)) return rule
  return null
}

// 权限决策：
//   { decision: 'allow' }                    —— 自动执行
//   { decision: 'ask' }                      —— 发 can_use_tool 挂起等回执
//   { decision: 'deny' }                     —— 直接拒绝（不执行）
export function decideToolPermission({ toolName, input, skipPermissions, autoApproveHighRisk, rules = {} }) {
  const command = toolName === 'Bash' ? String(input?.command ?? '') : ''
  // S3-1 显式规则优先：deny > ask > allow；命中即定，不再走默认判定
  const denied = matchList(rules.deny, toolName, command)
  if (denied) return { decision: 'deny', reason: `权限规则 deny 命中：${denied}` }
  const asked = matchList(rules.ask, toolName, command)
  if (asked) return { decision: 'ask', reason: `权限规则 ask 命中：${asked}` }
  const allowed = matchList(rules.allow, toolName, command)
  if (allowed) return { decision: 'allow', reason: `权限规则 allow 命中：${allowed}` }
  // —— 原默认逻辑（无规则时行为不变）——
  if (toolName === 'Bash') {
    if (matchesHighRisk(command)) {
      // headless 放行：仅当显式 autoApproveHighRisk 且已跳过权限时生效
      if (skipPermissions && autoApproveHighRisk) return { decision: 'allow' }
      return { decision: 'ask', reason: `命令为高危操作，需要用户批准：${command.slice(0, 80)}` }
    }
    return { decision: 'allow' }
  }
  // Read/Write 等文件工具：自动执行（路径边界校验在执行器内）
  return { decision: 'allow' }
}
