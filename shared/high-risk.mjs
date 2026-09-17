// 高危命令判定的**单一真源**（2026-09-17 · P1-2）
// ---------------------------------------------------------------------------
// 背景：此前"什么是高危命令"这份知识被**抄了两份**，且两份互不一致——
//   · `kernel/highrisk.mjs`  → 内核判定：命中即 `can_use_tool` 审批（"要不要问用户"）
//   · `server/highrisk.mjs`  → 桥判定：命中即给审批弹窗打高危标识（"要不要印危险标识"）
// 实测（55 条真实命令语料）**52.7% 判定分叉**。本模块把这份知识收敛到一处，
// 两个消费方各取所需，漂移从此**不可能静默**（见 shared/high-risk.test.mjs 的漂移锁）。
//
// ⚠️ 重要更正（实施期实测，勿沿用旧判断）：桥侧 `highRisk` **不参与门控**。
// 它在 `server/bridge.mjs:1879` 只是 approval 事件的一个字段，渲染层
// `src/hooks/useYFWCLI.ts:1520` 把它映射成弹窗里的风险等级文案
// （`risk: isDangerSign ? 'high' : 'medium'`）。是否执行/是否弹窗由内核的审批档位与
// `kernel/blacklist.mjs` 决定。⇒ **原本设想的"桥放行、内核拦截错位"并不存在**；
// 真实危害是**提示牌错**：(a) 最危险的命令（`curl … | bash`、`shutdown`、`reboot`、
// `chkdsk`）在桥侧不判高危 ⇒ 弹窗不显示高危警示；(b) 日常命令（`mv x`、`kill 1234`、
// `rm file.txt`、`git commit --amend`）被判高危 ⇒ 告警疲劳，反而淹没 (a)。
//
// 设计：**一条危险事实声明一次**（pattern 只写一遍），用 `tags` 标明哪些消费方需要它。
//   · tag `'approval'` → 内核：命中即需用户批准（"要不要问"）
//   · tag `'sign'`     → 桥：命中即标高危（"要不要印危险标识"）
//
// ── 分级原则（2026-09-17 fix-A 定稿）──────────────────────────────────────
//   T1 不可逆 / 系统级 / 远程执行  → 两个 tag 都要（既问也标）
//   T2 可回滚或属常见操作，但值得提醒 → 只 sign（标但不打断）
//   T3 日常可逆操作               → 都不标（如 `rm file.txt`、`mv a b`、`kill 1234`）
//
//   **不变量：`sign ⊇ approval`** —— approval 认定的高危，sign 必须也标
//   （否则弹窗不显示高危警示 = 提示牌失效）。由 `approvalOnlyRuleIds()` 必须为空来守住。
//   该不变量修复了此前的两类缺陷（详见 fix-A 记录）：
//     · 漏标：`curl … | sh`（远程代码执行）、`shutdown`、`reboot`、`tskill`、`chkdsk`、`cleanmgr`
//             原先只有 approval 没有 sign ⇒ 最危险的命令在弹窗里反而不标高危。
//     · 过标：`rm`/`mv`/`kill`/`format` 等一批"任何用法都算"的条目
//             （含 `npm run format` 被判高危）⇒ 告警疲劳，淹没上面那几条。
//
// 归一化差异是**刻意的**（内核只 trim；桥额外剥首尾引号），已注释并测试锁定。
// 纯函数、零依赖（内核 bundle 与 server 都要能 import）。

/**
 * @typedef {{id: string, group: string, re: RegExp, tags: string[], sample: string, note?: string}} RiskRule
 * tags 取值：'approval'（内核审批触发）| 'sign'（桥高危标识）
 * sample：**必然命中本规则的示例命令**。它有两个用途：
 *   ① 证明 pattern 不是"永假"（测试断言 re.test(sample)）；
 *   ② 作为"漏标"的实证判据——若 approval 命中 sample 而 sign 不命中，
 *      则该命令在桥侧**不会被标高危**（提示牌失效）。见 KNOWN_DIVERGENCE。
 */

/** @type {RiskRule[]} */
export const HIGH_RISK_RULES = [
  // ── rm / 删除家族 ──────────────────────────────────────────────────────
  {
    id: 'rm-recursive-force', group: 'rm',
    re: /\brm\b\s+(?:.*\s)?(?:--recursive|--force|-[a-zA-Z]*[rf][a-zA-Z]*)/i,
    tags: ['approval', 'sign'], sample: 'rm -rf /tmp/x',
    note: 'T1：危险 flag 可在任意参数位置（rm -i -rf /、rm file -rf 均触发）。原 rm-any（任何 rm）已删除——`rm file.txt` 属日常操作',
  },
  {
    id: 'rm-wildcard', group: 'rm', re: /\brm\b[^\n]*[*?]/,
    tags: ['sign'], sample: 'rm *',
    note: 'T2：通配删除，影响范围取决于当前目录内容、难以预判；无危险 flag 故不打断',
  },
  {
    id: 'rm-root-path', group: 'rm', re: /\b(rm|del|erase)\s+-\w*\s+\/[a-zA-Z]:\\./i,
    tags: ['approval', 'sign'], sample: 'rm -rf /C:\\Windows\\system32',
    note: 'T1：删除盘符根下路径',
  },
  {
    id: 'rmdir-s', group: 'rmdir', re: /\b(?:rmdir|rd)\s+\/s/i,
    tags: ['approval', 'sign'], sample: 'rmdir /s C:\\tmp',
    note: 'T1：Windows 递归删目录。`rd` 是 `rmdir` 的别名，故一并覆盖（原 rd-s 只有 sign）；原 rmdir-any 已删（`rmdir empty` 属日常）',
  },
  {
    id: 'del-s', group: 'del', re: /\bdel\s+\/s/i,
    tags: ['approval', 'sign'], sample: 'del /s *.txt',
    note: 'T1：Windows del /s；原 del-any 已删（`del file.txt` 属日常）',
  },
  {
    id: 'move-overwrite', group: 'move',
    re: /\b(?:mv|move)\b[^\n]*?(?:-f\b|\/y\b|[*?])/i,
    tags: ['sign'], sample: 'mv -f a b',
    note: 'T2：仅"强制覆盖 / 通配"移动标高危（可覆盖既有文件）；原 move-any/mv-any 已删——普通 `mv a b` 属日常操作',
  },

  // ── 磁盘 / 系统 ────────────────────────────────────────────────────────
  {
    id: 'format-drive', group: 'format', re: /\bformat\s+\w:/i,
    tags: ['approval', 'sign'], sample: 'format C:',
    note: 'T1：必须带盘符。原 format-any（任何 format）已删，它把 `npm run format`、`git format-patch` 判成高危',
  },
  { id: 'diskpart', group: 'diskpart', re: /\bdiskpart\b/i, tags: ['approval', 'sign'], sample: 'diskpart', note: 'T1：磁盘分区工具' },
  {
    id: 'chkdsk', group: 'chkdsk', re: /\bchkdsk\b/i,
    tags: ['approval', 'sign'], sample: 'chkdsk C:',
    note: 'T1：修复型磁盘检查，可改动磁盘结构。【补漏标】原桥侧不标高危',
  },
  {
    id: 'cleanmgr', group: 'cleanmgr', re: /\bcleanmgr\b/i,
    tags: ['approval', 'sign'], sample: 'cleanmgr /sagerun:1',
    note: 'T1：磁盘清理。【补漏标】原桥侧不标高危',
  },
  {
    id: 'shutdown', group: 'power', re: /\bshutdown\b/i,
    tags: ['approval', 'sign'], sample: 'shutdown /s /t 0',
    note: 'T1：关机。【补漏标】原桥侧不标高危（kernel/blacklist.mjs 的 POWER_TOOLS 另有"一票否决"兜底）',
  },
  {
    id: 'reboot', group: 'power', re: /\breboot\b/i,
    tags: ['approval', 'sign'], sample: 'reboot now',
    note: 'T1：重启。【补漏标】原桥侧不标高危（同上）',
  },
  { id: 'taskkill', group: 'kill', re: /\btaskkill\b/i, tags: ['approval', 'sign'], sample: 'taskkill /pid 123', note: 'T1：Windows 强杀进程' },
  {
    id: 'tskill', group: 'kill', re: /\btskill\b/i,
    tags: ['approval', 'sign'], sample: 'tskill 123',
    note: 'T1：【补漏标】原桥侧靠 kill-any 兜底，但 \\bkill\\b 的词边界不匹配 tskill；kill-any 已收窄为 kill-sigkill',
  },
  {
    id: 'kill-sigkill', group: 'kill', re: /\bkill\b[^\n]*?(?:-9\b|-KILL\b|-SIGKILL\b)/i,
    tags: ['sign'], sample: 'kill -9 1234',
    note: 'T2：SIGKILL 不可被捕获，进程无法优雅退出。原 kill-any 已删——普通 `kill 1234`（SIGTERM）属日常操作',
  },
  {
    id: 'stop-process-force', group: 'kill', re: /\bStop-Process\b[^\n]*?-(?:Force|F)\b/i,
    tags: ['sign'], sample: 'Stop-Process -Name node -Force',
    note: 'T2：仅 -Force 强杀标高危；原 stop-process（任何 Stop-Process）已收窄',
  },
  {
    id: 'takeown-f', group: 'takeown', re: /\btakeown\s+\/f/i,
    tags: ['approval', 'sign'], sample: 'takeown /f C:\\x',
    note: 'T1：夺取文件所有权（改 ACL），系统级且不易复原',
  },
  { id: 'reg-delete', group: 'reg', re: /\breg\s+delete\b/i, tags: ['approval', 'sign'], sample: 'reg delete HKLM\\Software\\X /f', note: 'T1：删注册表项，系统级、多数不可逆' },

  // ── git 历史改写 ───────────────────────────────────────────────────────
  {
    id: 'git-force-push', group: 'git-force', re: /\bgit\s+push\s+(?:--force|-f)\b/i,
    tags: ['approval', 'sign'], sample: 'git push --force',
    note: 'T1：【补漏标(approval)】原审批侧只认 `--force`，`git push -f`（最常见的强制推送写法）漏问；现两者都覆盖',
  },
  {
    id: 'git-force-any', group: 'git-force',
    re: /git\s+(?:reset|rebase|merge)\s+[^\n]*?(?:--hard|--force|-f\b)/i,
    tags: ['sign'], sample: 'git merge --force y',
    note: 'T2：非 push 的强制形式（rebase --hard / merge --force）；push 已由 git-force-push 覆盖',
  },
  { id: 'git-reset-hard', group: 'git-reset', re: /\bgit\s+reset\s+--hard/i, tags: ['approval', 'sign'], sample: 'git reset --hard HEAD~1', note: 'T1：丢弃工作区+暂存区改动' },
  {
    id: 'git-clean-f', group: 'git-clean', re: /\bgit\s+clean\s+-[^\s]*f/i,
    tags: ['approval', 'sign'], sample: 'git clean -f',
    note: 'T1：【补漏标(approval)】任何含 f 的组合 flag 都覆盖（-fd/-xdf）；原审批侧精确匹配 `-f`，漏掉 -xdf（原 git-clean-any 已合并于此）',
  },
  {
    id: 'git-checkout-dash', group: 'git-discard', re: /git\s+checkout\s+(?:--|\.)/,
    tags: ['approval', 'sign'], sample: 'git checkout -- .',
    note: 'T1：丢弃工作区未提交改动，未 stash 时不可恢复',
  },
  { id: 'git-restore-dot', group: 'git-discard', re: /git\s+restore\s+\./, tags: ['approval', 'sign'], sample: 'git restore .', note: 'T1：同上' },
  { id: 'git-stash-drop', group: 'git-stash', re: /git\s+stash\s+(?:drop|clear)/, tags: ['approval', 'sign'], sample: 'git stash drop', note: 'T1：丢弃 stash，未合并的改动即丢失' },
  { id: 'git-branch-D', group: 'git-branch', re: /git\s+branch\s+-D\b/, tags: ['approval', 'sign'], sample: 'git branch -D feature', note: 'T1：-D 是强制删除（不检查是否已合并），可能丢失提交' },
  {
    id: 'git-commit-amend', group: 'git-commit', re: /git\s+commit\s+[^\n]*--amend/,
    tags: ['sign'], sample: 'git commit --amend',
    note: 'T2：改写历史，但 reflog 可恢复 ⇒ 标而不问',
  },
  {
    id: 'git-commit-no-verify', group: 'git-commit', re: /git\s+commit\s+[^\n]*--no-verify/,
    tags: ['sign'], sample: 'git commit --no-verify -m y',
    note: 'T2：绕过 pre-commit 钩子（策略绕过，非数据损失）',
  },

  // ── 远程执行 / 提权 ────────────────────────────────────────────────────
  {
    id: 'curl-pipe-shell', group: 'remote-exec', re: /\bcurl\s+.*\|?\s*(sh|bash)\b/i,
    tags: ['approval', 'sign'], sample: 'curl -s http://x | sh',
    note: 'T1：【补漏标】远程代码执行——本次最严重的一条漏标（原先弹窗不标高危，用户更易轻率批准）',
  },
  {
    id: 'sudo-rm', group: 'privilege', re: /\b(?:sudo|runas)\b[^\n]*?\brm\b/i,
    tags: ['approval', 'sign'], sample: 'sudo rm x',
    note: 'T1：【补漏标】提权删除。regex 放宽以覆盖 `runas /user:admin rm x` 这类带选项写法（原先两者都不命中——sign 侧曾靠 rm-any 顺带覆盖，rm-any 收窄后需显式声明）',
  },

  // ── 数据库 / 基础设施 ──────────────────────────────────────────────────
  { id: 'drop-table', group: 'drop', re: /\bdrop\s+(table|database)\b/i, tags: ['approval', 'sign'], sample: 'DROP TABLE users', note: 'T1' },
  { id: 'truncate-table', group: 'truncate', re: /\btruncate\s+table\b/i, tags: ['approval', 'sign'], sample: 'truncate table t', note: 'T1' },
  {
    id: 'drop-truncate-any', group: 'drop', re: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
    tags: ['approval', 'sign'], sample: 'drop schema x',
    note: 'T1：含 SCHEMA（原审批侧漏掉 SCHEMA；原 sign 侧更宽故一并提升）',
  },
  {
    id: 'delete-from', group: 'delete-from', re: /\bDELETE\s+FROM\b/i,
    tags: ['approval', 'sign'], sample: 'DELETE FROM users WHERE id=1',
    note: 'T1：无 WHERE 时清空全表；有 WHERE 也可能误删',
  },
  { id: 'kubectl-delete', group: 'kubectl', re: /\bkubectl\s+delete\b/i, tags: ['approval', 'sign'], sample: 'kubectl delete pod x', note: 'T1：删集群资源' },
  { id: 'terraform-destroy', group: 'terraform', re: /\bterraform\s+destroy\b/i, tags: ['approval', 'sign'], sample: 'terraform destroy', note: 'T1：销毁全部被管理的基础设施' },
]

const RULES_BY_TAG = {
  approval: HIGH_RISK_RULES.filter((r) => r.tags.includes('approval')).map((r) => r.re),
  sign: HIGH_RISK_RULES.filter((r) => r.tags.includes('sign')).map((r) => r.re),
}

/** 归一化：内核侧只 trim（**逐字保留**，勿与 sign 侧合并——见文件头"零行为变化承诺"） */
function normalizeForApproval(command) {
  if (!command || typeof command !== 'string') return null
  const c = command.trim()
  return c || null
}

/** 归一化：桥侧 trim + 剥掉首尾引号（**逐字保留**） */
function normalizeForSign(command) {
  if (typeof command !== 'string' || !command.trim()) return null
  return command.trim().replace(/^["']|["']$/g, '')
}

/**
 * 内核判定：该命令是否触发审批（"要不要问用户"）。
 * 等价于旧 `kernel/highrisk.mjs` 的 `matchesHighRisk`。
 */
export function matchesApprovalTrigger(command) {
  const c = normalizeForApproval(command)
  if (c === null) return false
  return RULES_BY_TAG.approval.some((re) => re.test(c))
}

/**
 * 桥判定：该命令是否该在弹窗里标高危（"要不要印危险标识"）。
 * 等价于旧 `server/highrisk.mjs` 的 `matchesHighRisk`。
 */
export function matchesDangerSign(command) {
  const c = normalizeForSign(command)
  if (c === null) return false
  return RULES_BY_TAG.sign.some((re) => re.test(c))
}

/** 命中的规则 id 列表（诊断/测试用；两侧共用一份清单） */
export function matchedRuleIds(command, consumer) {
  const norm = consumer === 'sign' ? normalizeForSign(command) : normalizeForApproval(command)
  if (norm === null) return []
  const tag = consumer === 'sign' ? 'sign' : 'approval'
  return HIGH_RISK_RULES.filter((r) => r.tags.includes(tag) && r.re.test(norm)).map((r) => r.id)
}

/** 声明了某个 tag 的 pattern 列表（供兼容旧导出 `HIGH_RISK_PATTERNS`） */
export function patternsFor(consumer) {
  return [...(RULES_BY_TAG[consumer === 'sign' ? 'sign' : 'approval'] || [])]
}

/**
 * **实证**算出"只有 approval 判高危、桥侧却不标"的规则 = 提示牌漏标。
 * 判据：approval 命中该规则的 `sample`，但 sign 对同一命令不命中。
 * fix-A 之后此函数**必须返回空数组**（不变量 `sign ⊇ approval`），由测试断言。
 * （不用"同 group 是否有 sign 条目"做代理——语义不等价：`sudo rm` 无对应 group 但
 *   曾被 rm-any 顺带覆盖；而 `git reset --hard` 的 group 无 sign 条目却被 git-force-any 覆盖。）
 */
export function approvalOnlyRuleIds() {
  return HIGH_RISK_RULES
    .filter((r) => r.tags.includes('approval'))
    .filter((r) => !matchesDangerSign(r.sample))
    .map((r) => r.id)
}

/** 实证算出"桥标高危、但内核不因此提问"的规则 = 只标不问（T2），应有明确理由 */
export function signOnlyRuleIds() {
  return HIGH_RISK_RULES
    .filter((r) => r.tags.includes('sign'))
    .filter((r) => !matchesApprovalTrigger(r.sample))
    .map((r) => r.id)
}

/**
 * 分叉声明（供漂移锁测试断言）。
 * 凡出现声明之外的差异，测试即失败 ⇒ 任何新漂移都不会静默。
 */
export const KNOWN_DIVERGENCE = {
  /**
   * **必须为空**（fix-A 不变量）：approval 认的高危，sign 必须也标。
   * 先前非空的 6 条（curl-pipe-shell / shutdown / reboot / tskill / chkdsk / cleanmgr）
   * 正是"最危险的命令在弹窗里反而不标高危"的缺陷，已修复。
   */
  approvalOnlyRules: [],
  /**
   * T2（可回滚或常见，标而不问）。每条都必须能在 T1/T2/T3 分级下有据可依；
   * 新增条目意味着批量增加告警噪声，应当先想清楚。
   */
  signOnlyRules: [
    'rm-wildcard',            // 通配删除：范围不可预判，但无危险 flag
    'move-overwrite',         // 强制覆盖/通配移动
    'kill-sigkill',           // SIGKILL 不可捕获（普通 kill 属日常）
    'stop-process-force',     // 仅 -Force
    'git-force-any',          // rebase --hard / merge --force
    'git-commit-amend',       // 改写历史但 reflog 可恢复
    'git-commit-no-verify',   // 绕过钩子（策略绕过，非数据损失）
  ],
}
