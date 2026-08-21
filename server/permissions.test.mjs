// server/permissions.test.mjs —— 权限规则 schema（docs/production/security.md S3-1）
// 注：计划样例 fixture 中 'rm -rf /tmp/x' 同时出现在 deny 与 allow 断言，与
// "deny > ask > allow" 核心语义冲突；此处修正为 allow 显式放行该路径，
// deny 换无冲突路径（计划 Step 4 要求 PASS，语义以优先级规范为准）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideToolPermission } from '../kernel/permissions.mjs'

const RULES = {
  allow: ['Bash:git status*', 'Bash:echo hello', 'Bash:rm -rf /tmp/x', 'Read:*'],
  deny: ['Bash:git push --force*', 'Bash:rm -rf /var'],
  ask: ['Bash:drop table*'],
}

test('S3-1 显式规则：deny 优先于 ask/allow，allow 放行默认高危', () => {
  // deny 命中（即使命令也是 highrisk 默认 ask 类）
  const d = decideToolPermission({ toolName: 'Bash', input: { command: 'git push --force origin main' }, skipPermissions: false, autoApproveHighRisk: false, rules: RULES })
  assert.equal(d.decision, 'deny')
  // allow 命中 → 放行默认高危（rm -rf 特定路径被用户显式允许）
  const a = decideToolPermission({ toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, skipPermissions: false, autoApproveHighRisk: false, rules: RULES })
  assert.equal(a.decision, 'allow')
  // ask 命中（drop table 但不在默认 highrisk 列表）
  const q = decideToolPermission({ toolName: 'Bash', input: { command: 'drop table users' }, skipPermissions: false, autoApproveHighRisk: false, rules: RULES })
  assert.equal(q.decision, 'ask')
})

test('S3-1 无规则命中：行为与现状一致（highrisk ask / 其他 allow）', () => {
  const r = decideToolPermission({ toolName: 'Bash', input: { command: 'rm -rf /elsewhere' }, skipPermissions: false, autoApproveHighRisk: false, rules: RULES })
  assert.equal(r.decision, 'ask')                       // 默认 highrisk
  const r2 = decideToolPermission({ toolName: 'Bash', input: { command: 'echo hi' }, skipPermissions: false, autoApproveHighRisk: false, rules: {} })
  assert.equal(r2.decision, 'allow')                    // 默认非高危
  // 未传 rules 参数（向后兼容）
  const r3 = decideToolPermission({ toolName: 'Bash', input: { command: 'rm -rf /y' }, skipPermissions: false, autoApproveHighRisk: false })
  assert.equal(r3.decision, 'ask')
})
