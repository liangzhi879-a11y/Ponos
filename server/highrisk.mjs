// 高风险命令匹配（与内核 destructiveCommandWarning.ts 同构，见 docs/superpowers/specs/2026-08-14-plan-execute-mode-design.md §2.5）
// bridge 用：检测 BashTool tool_use 是否命中清单 → 前端审批弹窗
export const HIGH_RISK_PATTERNS = [
  // git 破坏性
  /git\s+(?:reset|rebase|merge|push)\s+[^\n]*?(?:--hard|--force|-f\b)/i,
  /git\s+clean\s+-[^ ]*f/i,
  /git\s+checkout\s+(?:--|\.)/,
  /git\s+restore\s+\./,
  /git\s+stash\s+(?:drop|clear)/,
  /git\s+branch\s+-D\b/,
  /git\s+commit\s+[^\n]*--amend/,
  /git\s+commit\s+[^\n]*--no-verify/,
  // 文件/目录删除（Unix + Windows）
  /\brm\b/i, // rm / rm -f / rm -rf（任何 rm 均为删除操作）
  /\b(?:del|erase)\b/i,
  /\brmdir\b/i,
  /\brd\s+\/s/i,
  /\bmove\b/i, // Windows move（文件移动）
  /\bmv\b/i,
  /\btakeown\s+\/f/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  // 进程/服务终止
  /\btaskkill\b/i,
  /\bkill\b/i,
  /\bStop-Process\b/i,
  // 数据库/基础设施破坏性
  /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bkubectl\s+delete\b/i,
  /\bterraform\s+destroy\b/i,
]

export function matchesHighRisk(command) {
  if (typeof command !== 'string' || !command.trim()) return false
  const c = command.trim().replace(/^["']|["']$/g, '') // 引号包裹容错
  return HIGH_RISK_PATTERNS.some((re) => re.test(c))
}
