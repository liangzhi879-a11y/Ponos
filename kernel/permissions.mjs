// YFW-turbo 工具权限判定（docs/bridge-contract.md §4 can_use_tool 协议）
// ---------------------------------------------------------------------------
// 净室语义：--dangerously-skip-permissions 使低危工具自动执行；Bash 高危命令
// 仍发 can_use_tool control_request 挂起，经 GUI 审批（approval 事件）后以
// control_response 解除。这保证 GUI 审批弹窗工作流（契约 §5 approval）可用。
// headless 场景（benchmark/CI 无审批者）：--auto-approve-high-risk 与
// skipPermissions 同时开启时，高危命令也自动放行，避免永久挂起。
import { matchesHighRisk } from './highrisk.mjs'

// 权限决策：
//   { decision: 'allow' }                    —— 自动执行
//   { decision: 'ask' }                      —— 发 can_use_tool 挂起等回执
//   { decision: 'deny' }                     —— 直接拒绝（不执行）
export function decideToolPermission({ toolName, input, skipPermissions, autoApproveHighRisk }) {
  if (toolName === 'Bash') {
    const command = String(input?.command ?? '')
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
