// 应用智控安全兜底：app_* 工具默认档不得自动放行
// 背景：动态工具原先一律归入 'unknown'，其允许档为 'loose'，而默认档也是 'loose'，
//       导致 2>=2 直接放行 —— 应用的全部 write 命令会被静默执行。
//
// 注意：'write' 类**不能**用作兜底目标 —— 它的允许档同样是 'loose'（默认档），仍会放行。
//       故本兜底引入独立保守类 'appTool'（允许档 'bypass'，与 highRiskBash 同级）。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTool,
  modeAllows,
  TOOL_CLASS_ALLOW_FROM,
  APPROVAL_RANK,
  DEFAULT_APPROVAL_MODE,
} from '../kernel/approval-mode.mjs'
import { decideToolPermission } from '../kernel/permissions.mjs'

test('app_ 前缀归入保守类 appTool', () => {
  assert.equal(classifyTool('app_xyz_queryOrder'), 'appTool')
  assert.equal(classifyTool('app_a_b'), 'appTool')
})

test('★ 核心断言：默认档（loose）不得自动放行 app_ 工具', () => {
  // 这是本兜底存在的唯一理由：不通过即说明 write 会被静默执行
  assert.equal(DEFAULT_APPROVAL_MODE, 'loose', '默认档已变化，本测试前提需重新评估')
  assert.equal(modeAllows('loose', classifyTool('app_xyz_queryOrder')), false)
})

test('manual / auto 档同样不放行', () => {
  for (const m of ['manual', 'auto']) {
    assert.equal(modeAllows(m, classifyTool('app_xyz_anything')), false, `${m} 档不应放行 app_ 工具`)
  }
})

test('空档位视为 loose，不得因此放宽', () => {
  assert.equal(modeAllows('', classifyTool('app_a_b')), false)
  assert.equal(modeAllows(undefined, classifyTool('app_a_b')), false)
})

test('bypass 档放行（用户显式免批准，与 highRiskBash 同级语义）', () => {
  assert.equal(modeAllows('bypass', classifyTool('app_xyz_anything')), true)
})

test('appTool 允许档必须严于 write，否则等于没兜住', () => {
  assert.ok(
    APPROVAL_RANK[TOOL_CLASS_ALLOW_FROM.appTool] > APPROVAL_RANK[TOOL_CLASS_ALLOW_FROM.write],
    `appTool=${TOOL_CLASS_ALLOW_FROM.appTool} 未严于 write=${TOOL_CLASS_ALLOW_FROM.write}`,
  )
})

test('不误伤既有工具分类', () => {
  assert.equal(classifyTool('Read'), 'read')
  assert.equal(classifyTool('Glob'), 'read')
  assert.equal(classifyTool('Write'), 'write')
  assert.equal(classifyTool('Bash'), 'exec')
  assert.equal(classifyTool('WebFetch'), 'net')
  assert.equal(classifyTool('未知工具xyz'), 'unknown')
})

test('工作流动态工具（run_*）不受本兜底影响', () => {
  assert.equal(classifyTool('run_workflow_abc123'), 'unknown')
  assert.equal(classifyTool('run_周报_a1b2c3'), 'unknown')
})

test('近似前缀不被误判（app / appx_ / Xapp_）', () => {
  assert.equal(classifyTool('app'), 'unknown')
  assert.equal(classifyTool('appx_foo'), 'unknown')
  assert.equal(classifyTool('Xapp_foo'), 'unknown')
})

test('★ 台账完整性：classifyTool 的返回值必须都在 TOOL_CLASS_ALLOW_FROM 中登记', () => {
  // 防"类名手误"：modeAllows 对**未登记**类名回落 'loose'（见 approval-mode.mjs 的 `|| 'loose'`），
  // 而默认档对 'loose' 是放行的 —— 即类名写错就等于静默放行。故台账必须完整。
  const samples = ['Read', 'Glob', 'Write', 'Bash', 'WebFetch', '未知工具xyz', 'app_x_y', 'run_workflow_a']
  for (const t of samples) {
    const cls = classifyTool(t)
    assert.ok(Object.hasOwn(TOOL_CLASS_ALLOW_FROM, cls), `工具 ${t} 的分类 ${cls} 未在语义表登记`)
  }
  // 反向验证这条测试为何必要：未登记类名确实会回落成放行
  assert.equal(modeAllows('loose', 'appToolX'), true, '未登记类名回落 loose → 故台账完整性必须被测试锁住')
})

// ── 决策层（产品真实行为是 decideToolPermission 的返回值，须端到端钉住）──
// 只测 classifyTool + modeAllows 不够：中间还隔着 ①黑名单 → ②显式规则 → ③高危 → ④档位表 四道顺序，
// 顺序被后人调换时，上层测试抓不到。

test('决策层：无规则时默认档为 ask（兜底真实生效）', () => {
  assert.equal(decideToolPermission({ toolName: 'app_x_anything', mode: 'loose' }).decision, 'ask')
  assert.equal(decideToolPermission({ toolName: 'app_x_anything', mode: undefined }).decision, 'ask')
})

test('决策层：read 工具凭显式 allow 规则在 manual 档可放行', () => {
  const r = decideToolPermission({
    toolName: 'app_x_queryOrder', mode: 'manual',
    rules: { allow: ['app_x_queryOrder:*'] },
  })
  assert.equal(r.decision, 'allow')
})

test('决策层：write 工具凭显式 ask 规则即便 bypass 档也询问', () => {
  const r = decideToolPermission({
    toolName: 'app_x_submitOrder', mode: 'bypass',
    rules: { ask: ['app_x_submitOrder:*'] },
  })
  assert.equal(r.decision, 'ask', '显式 ask 优先级高于档位表 → write 在任何档位都会被询问')
})

test('决策层：裸工具名（不带 :*）规则不生效——锁住 matchRule 的格式要求', () => {
  const r = decideToolPermission({
    toolName: 'app_x_submitOrder', mode: 'bypass',
    rules: { ask: ['app_x_submitOrder'] },
  })
  assert.equal(r.decision, 'allow', '裸名永不匹配（matchRule 先找冒号）；规则必须写成 <工具名>:*')
})

test('决策层：用户 side 的 allow 规则不得压过注入的 ask（deny>ask>allow 优先级）', () => {
  const r = decideToolPermission({
    toolName: 'app_x_submitOrder', mode: 'bypass',
    rules: { allow: ['app_x_submitOrder:*'], ask: ['app_x_submitOrder:*'] },
  })
  assert.equal(r.decision, 'ask')
})
