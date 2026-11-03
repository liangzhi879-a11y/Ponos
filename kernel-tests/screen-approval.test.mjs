import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTool, modeAllows, TOOL_CLASS_ALLOW_FROM } from '../kernel/approval-mode.mjs'
import { decideToolPermission } from '../kernel/permissions.mjs'

test('★ Screen 必须被显式登记（未登记落 unknown，其来源档 loose ⇒ 默认档自动放行）', () => {
  // ★ 改写说明（不是放宽断言）：本条原为「classifyTool('Screen') === 'read'」—— 那是
  //   「P2a 是只读分期」的编码，随 P2b 实现坐标类输入而失效（同 screen-contract.test.mjs 里
  //   已记录过的"改写而非改绿"先例）。命题本身**更严了**：不再要求某个固定类，而是要求
  //   "不得落 unknown（默认档会放行的那一类）"，并按 act 逐条钉住。
  assert.notEqual(classifyTool('Screen', { action: 'displays' }), 'unknown',
    'TOOL_CLASS_ALLOW_FROM.unknown = loose（默认档）⇒ 未登记即静默扩大攻击面')
  assert.notEqual(classifyTool('Screen', { action: 'clickAt' }), 'unknown',
    '输入 act 同样不得落 unknown —— 那条路径在默认档会被自动放行')
})

test('★ P2b：只读 act 仍归 read；输入 act 必须归保守类（默认档逐次 ask）', () => {
  // R6 / A5：只读 act 不该每次都弹审批（它们不产生副作用），输入 act 必须逐次问。
  for (const act of ['displays', 'windows', 'capture']) {
    assert.equal(classifyTool('Screen', { action: act }), 'read', `${act} 是只读，不该每次都弹审批`)
  }
  for (const act of ['move', 'clickAt', 'drag', 'scroll', 'keyCombo']) {
    assert.notEqual(classifyTool('Screen', { action: act }), 'read', `${act} 是真实输入，必须归保守类`)
    assert.notEqual(classifyTool('Screen', { action: act }), 'unknown', '不得落 unknown（默认档会放行）')
    assert.equal(classifyTool('Screen', { action: act }), 'appTool', `${act} 归 appTool（允许档 bypass）`)
    // 档位语义：默认档（loose）必须 ask，bypass 档才自动放行 —— 这就是"逐次确认"
    assert.equal(modeAllows('loose', 'appTool'), false, `${act}：默认档必须逐次 ask`)
    assert.equal(modeAllows('bypass', 'appTool'), true, `${act}：bypass 档才自动放行`)
  }
})

test('★ P2b：act 判定大小写/空白不敏感（驼峰 clickAt 不得被当成只读）', () => {
  // 契约侧 `isInputAct` 是大小写不敏感口径（INPUT_ACT_SET 为驼峰 act 专建索引）；
  // 分类器若自己做一次精确比较，`ClickAt`/` clickat ` 就会掉进只读分支 = 静默放行。
  for (const act of ['ClickAt', 'CLICKAT', ' clickat ', 'Move', 'keycombo']) {
    assert.notEqual(classifyTool('Screen', { action: act }), 'read', `${JSON.stringify(act)} 不得被判为只读`)
  }
})

test('★ P2b：缺 input 时保守处理（不得因"拿不到 act"就放行输入）', () => {
  // 防御：调用方忘了传 input ⇒ 不能当作只读放行（fail in the conservative direction）
  assert.notEqual(classifyTool('Screen'), 'read')
  assert.equal(classifyTool('Screen'), 'appTool')
  assert.notEqual(classifyTool('Screen', {}), 'read')
  assert.notEqual(classifyTool('Screen', { action: '' }), 'read')
  assert.notEqual(classifyTool('Screen', null), 'read')
})

test('★ P2b：未实现的输入 act（typeText，P2d）同样归保守类', () => {
  // 契约里已登记为输入 act ⇒ 分类必须先于实现保守起来（别等 P2d 上线才想起来改档）。
  assert.equal(classifyTool('Screen', { action: 'typeText' }), 'appTool')
})

test('★ 决策层（R6 的真实落点）：默认档下只读 allow、输入 act 必须 ask', () => {
  // 只测 classifyTool + modeAllows 不够 —— 产品行为是 decideToolPermission 的返回值。
  const ro = decideToolPermission({ toolName: 'Screen', input: { action: 'displays' }, mode: 'loose' })
  assert.equal(ro.decision, 'allow', '默认档下只读 act 不得弹审批')
  for (const action of ['move', 'clickAt', 'drag', 'scroll', 'keyCombo']) {
    const d = decideToolPermission({ toolName: 'Screen', input: { action }, mode: 'loose' })
    assert.equal(d.decision, 'ask', `默认档下 ${action} 必须逐次 ask`)
    assert.equal(d.askOncePerRun, true, `${action} 的 ask 必须带 askOncePerRun（一次运行问一次，而非复用 hard）`)
  }
  // ★ 改写说明（2026-10-15，**不是放宽断言**）：本条原为
  //   `bypass 档下 <act> 可自动执行`（= 缺陷本身）。那个命题与用户裁决 2 直接冲突：
  //   `appTool` 的允许档是 `bypass` ⇒ 全放行档**反而不再询问真实键鼠**，正是安全审查
  //   Important #4 实测到的"档位与需求相反"。现改为四档一律 `ask`（命题**更严**：
  //   从"三档 ask"变成"四档 ask"），且不看 `hard`（hard 的语义是"每次都问+灾难级警示条"，
  //   与"一次运行问一次"冲突）——见 docs/superpowers/specs/2026-10-15-p2b-authorization-design.md §1/§3.2。
  for (const action of ['move', 'clickAt', 'drag', 'scroll', 'keyCombo']) {
    for (const mode of ['manual', 'auto', 'loose', 'bypass']) {
      const b = decideToolPermission({ toolName: 'Screen', input: { action }, mode })
      assert.equal(b.decision, 'ask', `${mode} 档下 ${action} 都必须 ask（任何档位不得静默放行真实键鼠）`)
      assert.equal(b.askOncePerRun, true, `${mode} 档下 ${action} 应带 askOncePerRun`)
      assert.notEqual(b.hard, true, `${action} 不得复用 hard（hard = 每次都问 + 灾难级警示条）`)
    }
  }
  // 缺 input 的调用方：默认档必须 ask（不得因拿不到 act 就放行）
  assert.equal(decideToolPermission({ toolName: 'Screen', mode: 'loose' }).decision, 'ask')
})

test('★ 显式钉住 read 的档位语义（未变：只读仍任何档位自动执行）', () => {
  assert.equal(TOOL_CLASS_ALLOW_FROM.read, 'manual')
  assert.equal(modeAllows('manual', 'read'), true)
  assert.equal(TOOL_CLASS_ALLOW_FROM.appTool, 'bypass', 'appTool 必须是最保守的允许档（默认档 ask）')
})

test('Screen 的分类名可被 deny/ask 规则引用（返回值是字符串）', () => {
  assert.equal(typeof classifyTool('Screen', { action: 'displays' }), 'string')
  assert.equal(typeof classifyTool('Screen', { action: 'clickAt' }), 'string')
  // 显式规则优先于档位表（既有语义不受本次改动影响）
  const denied = decideToolPermission({
    toolName: 'Screen', input: { action: 'clickAt' }, mode: 'bypass',
    rules: { deny: ['Screen:*'] },
  })
  assert.equal(denied.decision, 'deny')
})

test('既有分类不受影响（回归）', () => {
  assert.equal(classifyTool('Read'), 'read')
  assert.equal(classifyTool('Browser'), 'agent')
  assert.equal(classifyTool('Bash'), 'exec')
  assert.equal(classifyTool('app_x_query'), 'appTool')
  assert.equal(classifyTool('run_workflow_abc'), 'unknown')
})
