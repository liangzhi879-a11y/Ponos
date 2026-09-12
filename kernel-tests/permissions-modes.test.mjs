// 权限决策 × 审批档位（kernel/permissions.mjs + approval-mode + blacklist 合流）
// ---------------------------------------------------------------------------
// 判定顺序是本文件的重点：硬黑名单 > 显式规则 > 高危 Bash > 档位表。顺序错了两类事故：
//   ① 黑名单被 allow 规则放开（底线失效）；
//   ② 不传 mode 的既有调用方（TUI/脚本/旧测试）行为漂移（回归）。
// 另钉：mode 缺省 ≡ 今天（deriveApprovalMode 派生），保证未接线路径零变化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideToolPermission } from '../kernel/permissions.mjs'

const d = (toolName, mode, input = {}) => decideToolPermission({ toolName, input, mode }).decision
const info = (toolName, mode, input = {}) => decideToolPermission({ toolName, input, mode })

test('档位 × 工具类：语义表逐格展开', () => {
  // [工具、输入、manual, auto, loose, bypass]
  const TABLE = [
    ['Read', { file_path: 'a.txt' }, 'allow', 'allow', 'allow', 'allow'],
    ['Grep', { pattern: 'x' }, 'allow', 'allow', 'allow', 'allow'],
    ['TodoWrite', { todos: [] }, 'allow', 'allow', 'allow', 'allow'],
    ['Bash', { command: 'ls -la' }, 'ask', 'allow', 'allow', 'allow'],
    ['Bash', { command: 'npm test' }, 'ask', 'allow', 'allow', 'allow'],
    ['Write', { file_path: 'a.txt', content: 'x' }, 'ask', 'ask', 'allow', 'allow'],
    ['Edit', { file_path: 'a.txt' }, 'ask', 'ask', 'allow', 'allow'],
    ['WebFetch', { url: 'https://x' }, 'ask', 'ask', 'allow', 'allow'],
    ['Agent', { prompt: 'x' }, 'ask', 'ask', 'allow', 'allow'],
    ['Skill', { skill: 'x' }, 'ask', 'ask', 'allow', 'allow'],
    ['Workflow', {}, 'ask', 'ask', 'allow', 'allow'],
    ['mcp__foo__bar', {}, 'ask', 'ask', 'allow', 'allow'],
    // 高危 Bash：loose 仍问，只有 bypass 放行
    ['Bash', { command: 'git push --force origin main' }, 'ask', 'ask', 'ask', 'allow'],
    ['Bash', { command: 'rm -rf ./build' }, 'ask', 'ask', 'ask', 'allow'],
    ['Bash', { command: 'drop table users' }, 'ask', 'ask', 'ask', 'allow'],
  ]
  for (const [tool, input, ...row] of TABLE) {
    ;['manual', 'auto', 'loose', 'bypass'].forEach((mode, i) => {
      assert.equal(d(tool, mode, input), row[i], `${tool} mode=${mode} 期望 ${row[i]}`)
    })
  }
})

test('硬黑名单：四档一律 ask 且带 hard 标记（永不自动放行）', () => {
  const CATASTROPHIC = ['rm -rf /', 'rm -rf ~', 'sudo rm -rf /', 'mkfs.ext4 /dev/sda', 'format C:', 'dd if=/dev/zero of=/dev/sda', 'shutdown -h now', 'diskpart']
  for (const command of CATASTROPHIC) {
    for (const mode of ['manual', 'auto', 'loose', 'bypass']) {
      const r = info('Bash', mode, { command })
      assert.equal(r.decision, 'ask', `${command} 在 ${mode} 下应 ask`)
      assert.equal(r.hard, true, `${command} 在 ${mode} 下应带 hard 标记`)
      assert.match(r.reason, /硬黑名单/, 'reason 应明确指出硬黑名单')
    }
  }
})

test('硬黑名单优先于显式 allow 规则（底线不可被规则放开）', () => {
  const rules = { allow: ['Bash:*'], deny: [], ask: [] }
  const r = decideToolPermission({ toolName: 'Bash', input: { command: 'rm -rf /' }, rules, mode: 'bypass' })
  assert.equal(r.decision, 'ask', 'allow 规则不得放开灾难命令')
  assert.equal(r.hard, true)
  // 非灾难命令仍受 allow 规则影响（规则层未被削弱）
  assert.equal(decideToolPermission({ toolName: 'Bash', input: { command: 'ls' }, rules, mode: 'manual' }).decision, 'allow')
})

test('显式规则仍高于档位（deny/ask/allow 三序不变）', () => {
  const rules = { deny: ['Bash:git *'], ask: ['Write:*'], allow: ['Read:*'] }
  const dr = (toolName, mode, input) => decideToolPermission({ toolName, input, rules, mode }).decision
  assert.equal(dr('Bash', 'bypass', { command: 'git status' }), 'deny', 'deny 规则在 bypass 下仍拒绝')
  assert.equal(dr('Write', 'bypass', { file_path: 'a' }), 'ask', 'ask 规则在 bypass 下仍询问')
  assert.equal(dr('Read', 'manual', { file_path: 'a' }), 'allow', 'allow 规则在 manual 下仍放行')
  // 规则只覆盖命中的工具，其余仍走档位表
  assert.equal(dr('Bash', 'bypass', { command: 'ls' }), 'allow', '未命中规则的命令走档位')
  assert.equal(dr('Write', 'loose', { file_path: 'a' }), 'ask', '规则未覆盖其它工具')
})

test('mode 缺省 ≡ 今天的真实行为（未接线调用方零回归）', () => {
  const legacy = (toolName, input, flags = {}) => decideToolPermission({ toolName, input, skipPermissions: flags.skip, autoApproveHighRisk: flags.auto }).decision
  // GUI 今天的 spawn：总是 --dangerously-skip-permissions → 普通命令/写文件自动、高危询问
  assert.equal(legacy('Bash', { command: 'ls' }, { skip: true }), 'allow')
  assert.equal(legacy('Write', { file_path: 'a' }, { skip: true }), 'allow')
  assert.equal(legacy('Agent', {}, { skip: true }), 'allow')
  assert.equal(legacy('Bash', { command: 'git push --force origin main' }, { skip: true }), 'ask')
  // 不带任何 flag 的裸内核：非 Bash 工具一直是无条件 allow（回归护栏）
  assert.equal(legacy('Write', { file_path: 'a' }), 'allow')
  assert.equal(legacy('Bash', { command: 'ls' }), 'allow')
  assert.equal(legacy('Bash', { command: 'git push --force origin main' }), 'ask')
  // headless 免批准：两 flag 同时才放行高危
  assert.equal(legacy('Bash', { command: 'git push --force origin main' }, { skip: true, auto: true }), 'allow')
  assert.equal(legacy('Bash', { command: 'git push --force origin main' }, { auto: true }), 'ask')
  // 显式档位优先于旧 flag（bridge 下发 mode 后 flag 不再决定语义）
  assert.equal(decideToolPermission({ toolName: 'Bash', input: { command: 'ls' }, skipPermissions: true, autoApproveHighRisk: true, mode: 'manual' }).decision, 'ask')
})

test('非法档位回落默认档（脏值不放大权限）', () => {
  for (const bad of ['', null, undefined, 'plan', 'acceptEdits', 7, {}]) {
    assert.equal(d('Write', bad, { file_path: 'a' }), 'allow', `${String(bad)} → 默认档 loose`)
    assert.equal(d('Bash', bad, { command: 'ls' }), 'allow')
    assert.equal(d('Bash', bad, { command: 'git push --force' }), 'ask', '高危仍问')
  }
})
