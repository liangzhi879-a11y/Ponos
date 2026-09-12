// Ponos-turbo 审批放行档位（四档：manual / auto / loose / bypass）
// ---------------------------------------------------------------------------
// 设计：把"哪些操作需要用户批准"显式化成一条单调放宽的谱系。每一档恰好比上一档
// 多放行一类工具，因此判定就是一个谓词：
//     modeAllows(mode, class) === rank(mode) >= rank(ALLOW_FROM[class])
// 语义表（唯一真源，改动必须同步 docs/bridge-contract.md §2 与说明书 §5.10）：
//
//   工具类            manual  auto  loose(默认)  bypass
//   只读              allow   allow  allow        allow
//   普通 Bash         ask     allow  allow        allow
//   写文件            ask     ask    allow        allow
//   出网/浏览器       ask     ask    allow        allow
//   子 agent/技能/工作流 ask  ask    allow        allow
//   未识别(MCP 等)    ask     ask    allow        allow
//   高危 Bash         ask     ask    ask          allow
//   灾难命令(黑名单)  ask(硬) ask(硬) ask(硬)      ask(硬)   ← 见 blacklist.mjs，永不自动放行
//
// 兼容性核心（deriveApprovalMode）：不传档位时按旧 flag 推导——`skipPermissions`
// 无论真假都映射到 loose（= 今天的裸内核行为，非 Bash 工具一直是无条件 allow），
// 只有 `skipPermissions && autoApproveHighRisk`（headless 免批准）才到 bypass。
// **不能**把"未跳权限"映射成 manual：那会把写文件从 allow 变 ask，属于行为回归。
// 因此 manual/auto 只能由显式选择到达（--approval-mode / settings.json / GUI）。
// 纯函数、零依赖。

export const APPROVAL_MODES = ['manual', 'auto', 'loose', 'bypass']
export const DEFAULT_APPROVAL_MODE = 'loose'
// 宽松序（越大越宽）；判定只依赖它
export const APPROVAL_RANK = { manual: 0, auto: 1, loose: 2, bypass: 3 }

// 工具类 → 从哪一档起自动放行
export const TOOL_CLASS_ALLOW_FROM = {
  read: 'manual',        // 只读：任何档位都自动
  exec: 'auto',          // 普通 Bash
  write: 'loose',        // 写文件
  net: 'loose',          // 出网 / 浏览器
  agent: 'loose',        // 子 agent / 技能 / 工作流
  unknown: 'loose',      // 未识别工具（MCP、动态工具）→ 与 agent 同级，保持现状
  highRiskBash: 'bypass', // 高危 Bash（highrisk.mjs）
}

// 注册表全量工具名（kernel/tools.mjs）分类；MultiEdit/NotebookEdit 为兼容外部工具名保留
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'MemorySearch', 'SkillSearch', 'Vision', 'OCR', 'TodoWrite'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const NET_TOOLS = new Set(['WebFetch', 'WebSearch'])
const AGENT_TOOLS = new Set(['Agent', 'Task', 'Skill', 'Workflow', 'Browser'])

export function isValidApprovalMode(v) {
  return APPROVAL_MODES.includes(String(v ?? '').trim().toLowerCase())
}

// 非法/缺失 → 默认档（永不抛：档位来自 config/flag/stdin，任何脏值都不该让内核崩）
export function normalizeApprovalMode(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return APPROVAL_MODES.includes(s) ? s : DEFAULT_APPROVAL_MODE
}

export function classifyTool(toolName) {
  const name = String(toolName || '')
  if (name === 'Bash') return 'exec'
  if (READ_TOOLS.has(name)) return 'read'
  if (WRITE_TOOLS.has(name)) return 'write'
  if (NET_TOOLS.has(name)) return 'net'
  if (AGENT_TOOLS.has(name)) return 'agent'
  return 'unknown'
}

export function modeAllows(mode, toolClass) {
  const from = TOOL_CLASS_ALLOW_FROM[toolClass] || 'loose'
  return APPROVAL_RANK[normalizeApprovalMode(mode)] >= APPROVAL_RANK[from]
}

// 旧 flag → 档位（内核不带 --approval-mode 时的兜底；见文件头"兼容性核心"）
export function deriveApprovalMode({ skipPermissions, autoApproveHighRisk } = {}) {
  if (skipPermissions && autoApproveHighRisk) return 'bypass'
  return DEFAULT_APPROVAL_MODE
}
