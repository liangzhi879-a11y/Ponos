// AI-02 修复验证（P2 / 安全）：权限规则的 allow 匹配**先于**高危判定 ⇒ 一条宽规则会连高危形式一起放行。
//
// 【缺陷】`kernel/permissions.mjs:82-84` 的求值序：
//   ① 硬黑名单 → ② deny → ②-b Screen 输入 → ②-c ask → **②-d allow（命中即 return）**
//   → ③ 高危 Bash 判定 → ④ 档位
//
// 于是 `allow: ['Bash: git *']` 这样一条**看起来无害**的宽规则，会把
// `git config --global http.proxy ...`、`git -c core.hooksPath=...` 这类可执行任意命令的形式一起放行
// —— allow 在"高危 Bash"之前 return，高危判定**根本没机会跑**。
//
// 【为什么这很危险】用户配 allow 规则的心智模型是"放行我确认过的那类命令"，
// 而 `matchesHighRisk` 判的恰恰是"这条命令的高危形式"。绕过它 = 用户以为自己只放行了查询，
// 实际放行了能改配置/植入钩子/间接执行的形式。
//
// 【修法】把高危判定提到 allow **之前**，但保留**显式逃生口**：
//   规则里写 `allow-high-risk: <pattern>` 前缀（或 `highRisk: true` 标记）才允许连高危一起放行，
//   且 reason 要标出"规则已放宽"，让审批卡能如实告知。
//   ★ 逃生口是必须的：否则用户无法表达"我就是想自动放行某类高危命令"（如 CI 里跑 migrate），
//     而"没有逃生口的硬限制"在实践中会被绕过（改成 skipPermissions），反而更不安全。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideToolPermission } from '../kernel/permissions.mjs'

const decide = (command, rules, extra = {}) =>
  decideToolPermission({ toolName: 'Bash', input: { command }, rules, mode: 'default', ...extra })

// 高危形式的实测样本（2026-10-18 用 matchesApprovalTrigger 逐条验证过判定结果）：
//   · `git push --force`  —— HIGH（覆盖远端历史）
//   · `git reset --hard`  —— HIGH（丢弃本地未提交改动）
// 两者都能被 **`Bash: git *`** 这条宽规则匹配 ⇒ 正好暴露"allow 先于高危判定"的缺陷。
//
// ★ 我第一版选了 `git config --global ...` 与 `git -c core.hooksPath=...` —— 实测它们**不算高危**
//   （matchesApprovalTrigger 返回 norm），于是"allow 放行"是**设计内的正常行为**，
//   拿它们当样本会让测试**假绿**（测的根本不是 AO-02 描述的缺陷）。
//   样本必须同时满足两个条件：①确属高危 ②能被宽规则匹配。缺一就测不到东西。
//   （顺带记一笔：hooksPath / --global config 未被高危规则覆盖，这本身可能是另一个缺口，
//     但那是"高危规则覆盖面"问题，不在 AI-02 范围内，不在此处混改。）
const HIGH_RISK_SAMPLES = [
  'git push --force',
  'git reset --hard',
]

test('★ AI-02：宽 allow 规则不得把高危形式一起放行', () => {
  const rules = { allow: ['Bash: git *'], deny: [], ask: [] }
  for (const cmd of HIGH_RISK_SAMPLES) {
    const r = decide(cmd, rules)
    assert.notEqual(r.decision, 'allow',
      `allow 规则 'Bash: git *' 不得把高危形式 "${cmd}" 直接放行（实得 ${r.decision}）`
      + ' —— 高危判定必须在 allow 之前生效')
  }
})

test('★ AI-02：非高危的同类命令仍应被 allow 规则放行（不能把功能改坏）', () => {
  const rules = { allow: ['Bash: git *'], deny: [], ask: [] }
  const r = decide('git status', rules)
  assert.equal(r.decision, 'allow',
    '普通 git 命令必须仍被 allow 规则放行 —— 修复只应拦住高危形式，不应废掉 allow 规则')
})

test('★ AI-02：必须保留显式逃生口（用户能主动放行高危）', () => {
  // 逃生口形态：allow-high-risk 前缀
  const rules = { allow: ['allow-high-risk: Bash: git *'], deny: [], ask: [] }
  const r = decide(HIGH_RISK_SAMPLES[1], rules)
  assert.equal(r.decision, 'allow',
    '显式 allow-high-risk 规则必须能放行高危形式 —— 没有逃生口的话，实践上会被'
    + '改成 skipPermissions 整片关掉，反而更不安全')
  // 且必须标明"规则已放宽"，让审批卡能如实告知
  assert.match(String(r.reason || ''), /放宽|high.?risk/i,
    `逃生口放行时 reason 必须标明规则已放宽（实得：${r.reason}）`)
})

test('★ AI-02：deny 仍然赢过一切（修复不得改变这条既有事实）', () => {
  const rules = { allow: ['allow-high-risk: Bash: git *'], deny: ['Bash: git *'], ask: [] }
  const r = decide('git status', rules)
  assert.equal(r.decision, 'deny', 'deny 必须仍然优先于 allow / allow-high-risk')
})

test('★ AI-02：硬黑名单（灾难级）仍在最前，任何规则都不能放行', () => {
  // 找一个确定命中 matchesCatastrophic 的命令（rm -rf / 之类）
  const rules = { allow: ['allow-high-risk: Bash: *'], deny: [], ask: [] }
  const r = decideToolPermission({
    toolName: 'Bash', input: { command: 'rm -rf /' }, rules, mode: 'bypass', skipPermissions: true,
  })
  assert.equal(r.decision, 'ask',
    '灾难级命令必须仍然强制询问（hard），任何 allow / 档位 / skipPermissions 都不能放行')
  assert.equal(r.hard, true, '灾难级必须是 hard（每次问 + 灾难级警示条）')
})

// ─────────────────────────────────────────────────────────────────────────────
// 顺带修复（2026-10-18，与 AI-02 同处同主题）：规则 pattern 不 trim ⇒ 自然写法静默失效
//
// 最自然的写法是 `Bash: git status`（冒号后带空格），而实现取 pattern 时不 trim，
// 得到 `" git status"` → 编译成 `^ git status$` → **永远匹配不上**。
//
// **危险方向在 deny 上**：`deny: ['Bash: rm -rf *']` 带空格 ⇒ 规则不生效 ⇒
// rm -rf 照常放行，而用户以为自己已经禁掉了 —— 比"没配规则"更糟（虚假的安全感）。
// ─────────────────────────────────────────────────────────────────────────────

test('★ 规则 trim：deny 用自然写法（冒号后带空格）必须真的生效', () => {
  const r = decide('git status', { allow: [], deny: ['Bash: git *'], ask: [] })
  assert.equal(r.decision, 'deny',
    '`deny: [\'Bash: git *\']`（冒号后带空格，最自然的写法）必须真的拦住 git 命令 —— '
    + '不 trim 的话它会静默失效，用户以为自己禁掉了、实际没有')
})

test('★ 规则 trim：allow 用自然写法必须真的生效', () => {
  const r = decide('git status', { allow: ['Bash: git *'], deny: [], ask: [] })
  assert.equal(r.decision, 'allow',
    '`allow: [\'Bash: git *\']`（带空格）必须真的放行普通 git 命令')
})

test('★ 规则 trim：两种写法必须等价（不得因空格产生行为差异）', () => {
  const withSpace = decide('git status', { allow: ['Bash: git *'], deny: [], ask: [] })
  const noSpace = decide('git status', { allow: ['Bash:git *'], deny: [], ask: [] })
  assert.equal(withSpace.decision, noSpace.decision,
    '`Bash: git *` 与 `Bash:git *` 必须等价 —— 一个空格不该改变安全行为')
})
