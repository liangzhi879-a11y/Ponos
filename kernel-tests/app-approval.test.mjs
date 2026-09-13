// 应用智控安全兜底：app_* 工具默认档不得自动放行
// 背景：动态工具原先一律归入 'unknown'，其允许档为 'loose'，而默认档也是 'loose'，
//       导致 2>=2 直接放行 —— 应用的全部 write 命令会被静默执行。
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
