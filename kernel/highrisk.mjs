// 高危命令匹配（Bash 权限审批触发判定）
// ---------------------------------------------------------------------------
// 破坏性/系统级/危险命令 → 触发 can_use_tool 审批。纯函数，供 permissions 与
// 测试复用。注意：命令可能带引号/参数顺序变化，用宽松子串匹配 + 词边界。

const HIGH_RISK_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rf]|[a-zA-Z]*rf[a-zA-Z]*\s+)/i,   // rm -rf / rm -r -f 等递归强删
  /\brmdir\s+\/s/i,                                     // Windows rmdir /s
  /\bdel\s+\/s/i,                                       // Windows del /s
  /\bformat\s+\w:/i,                                    // 磁盘格式化
  /\bdiskpart\b/i,                                      // 磁盘分区工具
  /\bchkdsk\b/i,                                        // 磁盘检查（可能写盘）
  /\bcleanmgr\b/i,                                      // 磁盘清理
  /\bshutdown\b/i,                                      // 关机
  /\breboot\b/i,
  /\btaskkill\b/i,                                      // 杀进程
  /\btskill\b/i,
  /\bdrop\s+(table|database)\b/i,                       // SQL 删表
  /\btruncate\s+table\b/i,
  /\bgit\s+push\s+--force/i,                            // 强推（覆盖远端历史）
  /\bgit\s+reset\s+--hard/i,                            // 硬重置（丢弃改动）
  /\bgit\s+clean\s+-f/i,                                // 清理未跟踪文件
  /\b(rm|del|erase)\s+-\w*\s+\/[a-zA-Z]:\\./i,          // 删除根路径文件（宽松）
  /\bcurl\s+.*\|?\s*(sh|bash)\b/i,                      // 管道执行远程脚本
  /\b(?:sudo|runas)\s+rm\b/i,
]

export function matchesHighRisk(command) {
  if (!command || typeof command !== 'string') return false
  const c = command.trim()
  if (!c) return false
  return HIGH_RISK_PATTERNS.some((re) => re.test(c))
}
