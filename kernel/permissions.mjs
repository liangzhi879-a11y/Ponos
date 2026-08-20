// YFW-turbo 工具权限判定（docs/bridge-contract.md §4 can_use_tool 协议）
// ---------------------------------------------------------------------------
// 净室语义：--dangerously-skip-permissions 使低危工具自动执行；Bash 高危命令
// 仍发 can_use_tool control_request 挂起，经 GUI 审批（approval 事件）后以
// control_response 解除。这保证 GUI 审批弹窗工作流（契约 §5 approval）可用。
import { matchesHighRisk } from './highrisk.mjs'

// 权限决策：
//   { decision: 'allow' }                    —— 自动执行
//   { decision: 'ask' }                      —— 发 can_use_tool 挂起等回执
//   { decision: 'deny' }                     —— 直接拒绝（不执行）
export function decideToolPermission({ toolName, input, skipPermissions }) {
  if (toolName === 'Bash') {
    const command = String(input?.command ?? '')
    if (matchesHighRisk(command)) return { decision: 'ask', reason: `命令为高危操作，需要用户批准：${command.slice(0, 80)}` }
    return { decision: 'allow' }
  }
  // Read/Write 等文件工具：自动执行（路径边界校验在执行器内）
  return { decision: 'allow' }
}
