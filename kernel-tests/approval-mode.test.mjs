// 审批档位模型（kernel/approval-mode.mjs）
// ---------------------------------------------------------------------------
// 钉三件事：① 四档单调放宽（每档恰好多放行一类）；② 非法输入永不抛、回落默认档；
// ③ 旧 flag 派生规则 = 今天的真实行为（回归护栏：派生不得把写文件从 allow 变 ask）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVAL_MODES, APPROVAL_RANK, DEFAULT_APPROVAL_MODE, TOOL_CLASS_ALLOW_FROM,
  normalizeApprovalMode, isValidApprovalMode, classifyTool, modeAllows, deriveApprovalMode,
} from '../kernel/approval-mode.mjs'

// 注册表（kernel/tools.mjs）全量 18 个工具 + 两个兼容名
const REGISTRY_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'TodoWrite',
  'WebFetch', 'WebSearch', 'OCR', 'Vision', 'Skill', 'MemorySearch', 'SkillSearch', 'Workflow', 'Browser']

test('档位：四档顺序固定，rank 单调递增', () => {
  assert.deepEqual(APPROVAL_MODES, ['manual', 'auto', 'loose', 'bypass'])
  for (let i = 1; i < APPROVAL_MODES.length; i++) {
    assert.ok(APPROVAL_RANK[APPROVAL_MODES[i]] > APPROVAL_RANK[APPROVAL_MODES[i - 1]], `${APPROVAL_MODES[i]} 应比上一档宽`)
  }
})

test('档位：normalize 落默认档且永不抛', () => {
  assert.equal(DEFAULT_APPROVAL_MODE, 'loose')
  for (const v of ['manual', 'auto', 'loose', 'bypass', 'MANUAL', ' Bypass ']) {
    assert.ok(APPROVAL_MODES.includes(normalizeApprovalMode(v)), `${v} 应被接受`)
  }
  assert.equal(normalizeApprovalMode('bypass'), 'bypass')
  assert.equal(normalizeApprovalMode('  manual '), 'manual')
  for (const bad of [null, undefined, '', '   ', 42, {}, [], 'plan', 'acceptEdits', 'bypassPermissions']) {
    assert.equal(normalizeApprovalMode(bad), 'loose', `${String(bad)} 应回落默认档`)
    assert.equal(isValidApprovalMode(bad), false)
  }
})

test('档位：全部注册工具都有确定性分类', () => {
  const got = Object.fromEntries(REGISTRY_TOOLS.map((n) => [n, classifyTool(n)]))
  assert.equal(got.Bash, 'exec')
  for (const n of ['Read', 'Glob', 'Grep', 'MemorySearch', 'SkillSearch', 'Vision', 'OCR', 'TodoWrite']) {
    assert.equal(got[n], 'read', `${n} 应为只读`)
  }
  for (const n of ['Write', 'Edit']) assert.equal(got[n], 'write', `${n} 应为写文件`)
  for (const n of ['WebFetch', 'WebSearch']) assert.equal(got[n], 'net', `${n} 应为出网`)
  for (const n of ['Agent', 'Task', 'Skill', 'Workflow', 'Browser']) assert.equal(got[n], 'agent', `${n} 应为 agent 类`)
  // 兼容名与未识别工具
  assert.equal(classifyTool('MultiEdit'), 'write')
  assert.equal(classifyTool('NotebookEdit'), 'write')
  assert.equal(classifyTool('mcp__github__create_issue'), 'unknown')
  assert.equal(classifyTool(''), 'unknown')
  assert.equal(classifyTool(undefined), 'unknown')
})

test('档位：语义表逐格展开（含硬黑名单永不自动放行）', () => {
  // [类, manual, auto, loose, bypass]
  const TABLE = [
    ['read', true, true, true, true],
    ['exec', false, true, true, true],
    ['write', false, false, true, true],
    ['net', false, false, true, true],
    ['agent', false, false, true, true],
    ['unknown', false, false, true, true],
    ['highRiskBash', false, false, false, true],
    ['appTool', false, false, false, true],
  ]
  for (const [cls, ...row] of TABLE) {
    APPROVAL_MODES.forEach((mode, i) => {
      assert.equal(modeAllows(mode, cls), row[i], `mode=${mode} class=${cls} 期望 ${row[i]}`)
    })
  }
  // 每进一档恰好放宽一类（单调性）
  for (const [cls] of TABLE) {
    let prev = modeAllows('manual', cls)
    for (const mode of APPROVAL_MODES.slice(1)) {
      const cur = modeAllows(mode, cls)
      assert.ok(cur || !prev, `class=${cls} 在 ${mode} 上收紧了（应单调放宽）`)
      prev = cur
    }
  }
  assert.equal(Object.keys(TOOL_CLASS_ALLOW_FROM).length, 8)
})

test('档位：旧 flag 派生 = 今天的真实行为', () => {
  assert.equal(deriveApprovalMode({ skipPermissions: true, autoApproveHighRisk: true }), 'bypass')
  assert.equal(deriveApprovalMode({ skipPermissions: true, autoApproveHighRisk: false }), 'loose')
  assert.equal(deriveApprovalMode({ skipPermissions: true }), 'loose')
  // 关键回归护栏：未跳权限**不得**派生 manual（否则写文件由 allow 变 ask）
  assert.equal(deriveApprovalMode({ skipPermissions: false, autoApproveHighRisk: false }), 'loose')
  assert.equal(deriveApprovalMode({}), 'loose')
  assert.equal(deriveApprovalMode(), 'loose')
  // autoApproveHighRisk 单独出现（无 skip）今天也不生效（permissions 需两者同时）
  assert.equal(deriveApprovalMode({ autoApproveHighRisk: true }), 'loose')
  assert.equal(modeAllows(deriveApprovalMode({ skipPermissions: false }), 'write'), true, '写文件必须仍自动放行')
})
