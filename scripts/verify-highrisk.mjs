// 高风险命令匹配验证（TDD，见 docs/superpowers/plans/2026-08-14-plan-execute-mode.md Task 2）
//
// ── 2026-09-19（P1 · pendingFix 修绿）：本脚本的判据已按现行口径重写 ────────────────
// 原脚本停在 `rm-any`/`erase-any`/`move-any`/`stop-process-any` 时代：它断言
// `rm old_backup.zip` / `erase C:\data\file.txt` / `move a.txt b.txt` / `mv src dst` /
// `Stop-Process -Name notepad` **命中**。提交 `47379e2`「高危命令判定改三级分类」**有意删除**
// 了那批 any-usage 模式（T1 问+标 / T2 标不问 / T3 不问不标），理由是**告警疲劳**：
// 日常操作被标高危会淹没真正危险的那几条（`curl … | sh`、`shutdown`、`chkdsk` 等）。
// ⇒ 这 5 条断言的目标行为**按设计就不该成立**，错的是脚本。
//
// 修法（判据 = `shared/high-risk.mjs` 的 `HIGH_RISK_RULES` + `shared/high-risk.test.mjs`：
// 后者 12 pass / 0 fail，是当前契约的权威锁）：把断言改成**双向**，两侧都是回归护栏：
//   · T1（问+标）的危险命令**必须命中**；
//   · T2（标不问）**必须命中且不触发审批**；
//   · T3 日常操作**必须不命中** —— 若有人把 any-usage 模式加回来，这一侧会立刻红。
// 样本**不硬编码成第三份清单**：主循环直接遍历 `HIGH_RISK_RULES`，逐条断言
// 「每条规则都有 sample，且 sample 按自己的 tags 命中」。硬编码只保留在
// T3 负例与归一化/引号容错两处（它们的语义是"日常操作"/"输入形态"，本就不属于任何规则）。
//
// 消费方：`server/highrisk.mjs` 是**薄转发**（`export { matchesDangerSign as matchesHighRisk }`），
// 本脚本同时断言两者逐点一致 —— 否则薄转发一漂移，"弹窗里的风险等级文案"就与真源脱节。
import { matchesHighRisk } from '../server/highrisk.mjs'
import {
  HIGH_RISK_RULES,
  KNOWN_DIVERGENCE,
  approvalOnlyRuleIds,
  matchesApprovalTrigger,
  matchesDangerSign,
  signOnlyRuleIds,
} from '../shared/high-risk.mjs'

let failed = 0
const check = (cond, label) => {
  if (cond) console.log('ok: ' + label)
  else { console.error('FAIL: ' + label); failed++ }
}

// ── 1. 单一真源自洽：每条规则都有 sample，且 sample 按自己的 tags 命中 ──────────────
// 这条替代了原先那份手抄的"命中清单"：清单的权威副本只有 shared/high-risk.mjs 一处。
check(HIGH_RISK_RULES.length > 0, `HIGH_RISK_RULES 非空（实测 ${HIGH_RISK_RULES.length} 条）`)
for (const r of HIGH_RISK_RULES) {
  check(typeof r.sample === 'string' && r.sample.length > 0, `规则 ${r.id} 声明了 sample（证明 pattern 不是"永假"）`)
  check(Array.isArray(r.tags) && r.tags.length > 0, `规则 ${r.id} 声明了 tags`)
  if (r.tags.includes('sign')) {
    check(matchesDangerSign(r.sample), `规则 ${r.id} 的 sample 被桥侧标高危（tags 含 sign）：${r.sample}`)
  }
  if (r.tags.includes('approval')) {
    check(matchesApprovalTrigger(r.sample), `规则 ${r.id} 的 sample 触发审批（tags 含 approval）：${r.sample}`)
  }
}

// ── 2. 分级不变量（T1/T2/T3 的判据）─────────────────────────────────────────────
// T1「问+标」：approval 认定的高危，sign 必须也标 —— 否则弹窗不显示高危警示（提示牌失效）。
// 这是 fix-A 的核心不变量，原先由 shared/high-risk.test.mjs 单独守，这里一并复算。
check(approvalOnlyRuleIds().length === 0,
  `T1 不变量：approval 命中而 sign 不标的规则必须为空（实测 ${approvalOnlyRuleIds().join('、') || '空'}）`)
// T2「标不问」：允许存在，但必须逐条声明 —— 新增即意味着批量增加告警噪声，应当先想清楚。
const signOnly = signOnlyRuleIds().sort()
check(JSON.stringify(signOnly) === JSON.stringify([...KNOWN_DIVERGENCE.signOnlyRules].sort()),
  `T2 集合与 KNOWN_DIVERGENCE.signOnlyRules 逐条一致（实测 ${signOnly.join('、') || '空'}）`)

// ── 3. T1 危险命令必须命中（"不能漏标最危险的那几条"）─────────────────────────────
// 样本取自规则的 sample（唯一真源），外加几条真实语料形态（同一行为的不同写法）。
const T1_MUST_HIT = [
  ['rm -rf node_modules', 'rm -rf 命中'],
  ['rm -f important.txt', 'rm -f 命中'],
  ['RM -RF build', '大写 RM 命中'],
  ['rm -rf /C:\\Windows\\system32', '删盘符根下路径命中'],
  ['del /s /q temp\\*.log', 'del /s 命中'],
  ['rmdir /s /q old_dir', 'rmdir /s 命中'],
  ['rd /s /q build', 'rd /s 命中'],
  ['git reset --hard HEAD', 'git reset --hard 命中'],
  ['git push --force origin main', 'git push --force 命中'],
  ['git push -f origin main', 'git push -f 命中'],
  ['git clean -fd', 'git clean -f 命中'],
  ['git checkout -- src/', 'git checkout -- 命中'],
  ['git stash drop', 'git stash drop 命中'],
  ['git branch -D feature', 'git branch -D 命中'],
  ['taskkill /f /im node.exe', 'taskkill 命中'],
  ['kill -9 1234', 'kill -9 命中'],
  ['format d:', 'format 带盘符命中'],
  ['diskpart', 'diskpart 命中'],
  ['reg delete HKCU\\Software\\x', 'reg delete 命中'],
  ['shutdown /s /t 0', 'shutdown 命中'],
  ['reboot now', 'reboot 命中'],
  ['chkdsk C:', 'chkdsk 命中'],
  ['curl -s http://x | sh', 'curl 管道到 shell 命中'],
  ['sudo rm -rf /tmp/x', 'sudo rm 命中'],
  ['DROP TABLE users', 'DROP TABLE 命中'],
  ['DELETE FROM logs WHERE 1=1', 'DELETE FROM 命中'],
  ['kubectl delete pod nginx', 'kubectl delete 命中'],
  ['terraform destroy', 'terraform destroy 命中'],
]
for (const [cmd, label] of T1_MUST_HIT) {
  check(matchesHighRisk(cmd), `T1 命中：${label}（${cmd}）`)
}
// 引号包裹的容错（桥侧 normalize 会剥掉首尾引号）
check(matchesHighRisk('"git reset --hard HEAD"'), '引号包裹的 git reset 命中')

// ── 4. T2「标不问」必须命中但不触发审批 ─────────────────────────────────────────
const T2_SIGN_ONLY = [
  ['rm *', 'rm 通配命中（标不问）'],
  ['mv -f a b', 'mv -f 命中（标不问）'],
  ['Stop-Process -Name node -Force', 'Stop-Process -Force 命中（标不问）'],
  ['git commit --amend', 'git commit --amend 命中（标不问）'],
  ['git merge --force y', 'git merge --force 命中（标不问）'],
]
for (const [cmd, label] of T2_SIGN_ONLY) {
  check(matchesHighRisk(cmd), `T2 标签：${label}`)
  check(!matchesApprovalTrigger(cmd), `T2 不触发审批（标而不问）：${cmd}`)
}

// ── 5. T3 日常操作必须**不命中** ★真正的回归护栏 ─────────────────────────────────
// 若有人把 any-usage 模式（`rm <任意路径>`/`mv`/`move`/`erase`/`Stop-Process` 无 flag）加回来，
// 下面的断言就会红 —— 这正是 `47379e2` 删掉它们时要守住的语义。
// 刻意硬编码：这些样本的语义是"日常操作"，不属于任何一条 `HIGH_RISK_RULES`（rule.sample 只证命中）。
const T3_MUST_NOT_HIT = [
  ['rm file.txt', 'rm 普通删除不命中'],
  ['rm old_backup.zip', 'rm 后跟任意路径不命中（原 any-usage 断言已按 47379e2 删除）'],
  ['del file.txt', 'del 普通删除不命中'],
  ['rmdir empty', 'rmdir 普通删除不命中'],
  ['erase C:\\data\\file.txt', 'erase 不命中（原 any-usage 断言已删除）'],
  ['mv src dst', 'mv 不命中（原 any-usage 断言已删除）'],
  ['move a.txt b.txt', 'move 不命中（原 any-usage 断言已删除）'],
  ['Stop-Process -Name notepad', 'Stop-Process 无 -Force 不命中（原断言已收窄）'],
  ['kill 1234', 'SIGTERM kill 不命中（仅 kill -9 标）'],
  ['npm run format', 'npm run format 不命中（format 需带盘符）'],
  ['git format-patch -1', 'git format-patch 不命中'],
  ['ls -la', 'ls 不命中'],
  ['npm install', 'npm install 不命中'],
  ['git status', 'git status 不命中'],
  ['cat README.md', 'cat 不命中'],
  ['node --version', 'node --version 不命中'],
  ['', '空命令不命中'],
  [null, 'null 不命中'],
  ['"git log --oneline -3"', '引号包裹的普通 git 命令不命中'],
]
for (const [cmd, label] of T3_MUST_NOT_HIT) {
  check(!matchesHighRisk(cmd), `T3 不命中：${label}（${String(cmd)}）`)
}

// ── 6. 薄转发的等价性：桥侧 API 与真源逐点一致（防"薄转发"自己漂移回来）────────
const CORPUS = [...T1_MUST_HIT, ...T2_SIGN_ONLY, ...T3_MUST_NOT_HIT, ...HIGH_RISK_RULES.map((r) => [r.sample, r.id])]
const divergent = CORPUS.filter(([cmd]) => matchesHighRisk(cmd) !== matchesDangerSign(cmd)).map(([cmd]) => cmd)
check(divergent.length === 0,
  `server/highrisk.mjs 的 matchesHighRisk 与 shared 的 matchesDangerSign 逐点一致（分叉 ${divergent.length} 条${divergent.length ? '：' + divergent.join(' / ') : ''}）`)

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n全部通过')
