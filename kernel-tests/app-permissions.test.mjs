// 应用智控：命名唯一真源 + 权限规则注入（安全双保险的主机制）
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appToolName, appCommandTools, APP_TOOL_PREFIX } from '../kernel/app-naming.mjs'
import { syncAppPermissionRules, __resetInjectedForTest } from '../kernel/app-permissions.mjs'
import { decideToolPermission } from '../kernel/permissions.mjs'
import { classifyTool, modeAllows } from '../kernel/approval-mode.mjs'

const spec = (over = {}) => ({
  specVersion: 1, appId: 'app-7f3a2c', name: 'MyApp', target: { type: 'web' },
  expose: { mode: 'console' },
  commands: [
    { action: 'queryOrder', kind: 'read', params: [], steps: [{ act: 'goto', url: '/o' }] },
    { action: 'listStock', kind: 'read', params: [], steps: [{ act: 'goto', url: '/s' }] },
    { action: 'submitOrder', kind: 'write', params: [], steps: [{ act: 'click', selector: '#ok' }] },
  ],
  ...over,
})

const freshRules = () => ({ allow: [], ask: [], deny: [], skip: [], highRiskPrefixes: [], blacklist: [] })

// ── 命名 ────────────────────────────────────────────────
test('命名：app_ 前缀 + slug + action', () => {
  assert.equal(appToolName({ name: 'MyApp' }, 'queryOrder'), 'app_myapp_queryOrder')
  assert.ok(appToolName({ name: 'MyApp' }, 'x').startsWith(APP_TOOL_PREFIX))
})

test('命名：中文名回退到 appId 短哈希（不会坍缩成同名）', () => {
  const a = appToolName({ name: '甲系统', appId: 'app-aaa' }, 'query')
  const b = appToolName({ name: '乙系统', appId: 'app-bbb' }, 'query')
  assert.ok(a.startsWith('app_') && b.startsWith('app_'))
  assert.notEqual(a, b, '两个中文应用不得同名')
  assert.ok(!a.includes('run_'), '不得带工作流命名空间的 run_ 前缀')
  assert.ok(/^app_a[0-9a-z]+_query$/.test(a), `实际：${a}`)
})

test('命名：同一输入稳定可复现（规则注入与建工具必须一致）', () => {
  assert.equal(appToolName({ name: 'MyApp' }, 'x'), appToolName({ name: 'MyApp' }, 'x'))
})

test('命名：名字含空格/符号被归一', () => {
  assert.equal(appToolName({ name: 'My App / 系统' }, 'go'), appToolName({ name: 'My App / 系统' }, 'go'))
  assert.ok(!appToolName({ name: 'My App!!' }, 'go').includes(' '))
})

test('appCommandTools 跳过无 action 的命令', () => {
  const r = appCommandTools({ name: 'X', commands: [{ kind: 'read' }, { action: 'ok', kind: 'read' }] })
  assert.equal(r.length, 1)
  assert.equal(r[0].cmd.action, 'ok')
})

// ── 规则注入 ─────────────────────────────────────────────
test('注入：read → allow，write → ask，且格式为 <工具名>:*', () => {
  __resetInjectedForTest()
  const rules = freshRules()
  const r = syncAppPermissionRules({ rules, spec: spec() })
  assert.deepEqual(r.allowed, ['app_myapp_queryOrder:*', 'app_myapp_listStock:*'])
  assert.deepEqual(r.asked, ['app_myapp_submitOrder:*'])
  assert.ok(rules.allow.includes('app_myapp_queryOrder:*'))
  assert.ok(rules.ask.includes('app_myapp_submitOrder:*'))
})

test('注入：幂等 —— 反复调用不累积重复规则', () => {
  __resetInjectedForTest()
  const rules = freshRules()
  syncAppPermissionRules({ rules, spec: spec() })
  syncAppPermissionRules({ rules, spec: spec() })
  syncAppPermissionRules({ rules, spec: spec() })
  assert.equal(rules.allow.length, 2, `allow 应稳定为 2，实际 ${rules.allow.length}`)
  assert.equal(rules.ask.length, 1, `ask 应稳定为 1，实际 ${rules.ask.length}`)
})

test('注入：切换应用时回收上一个应用的规则', () => {
  __resetInjectedForTest()
  const rules = freshRules()
  syncAppPermissionRules({ rules, spec: spec() })
  syncAppPermissionRules({ rules, spec: spec({ name: 'OtherApp', appId: 'app-other' }) })
  assert.ok(!rules.allow.some((r) => r.includes('myapp')), '旧应用规则应被回收')
  assert.ok(rules.ask.some((r) => r.includes('otherapp')))
})

test('注入：不误删用户手写的规则（包括用户写的 app_ 规则）', () => {
  __resetInjectedForTest()
  const rules = freshRules()
  rules.allow.push('Read', 'app_user_written:*')
  rules.ask.push('Bash:rm *')
  syncAppPermissionRules({ rules, spec: spec() })
  syncAppPermissionRules({ rules, spec: null })
  assert.ok(rules.allow.includes('Read'), '用户规则应保留')
  assert.ok(rules.allow.includes('app_user_written:*'), '用户手写的 app_ 规则也应保留')
  assert.ok(rules.ask.includes('Bash:rm *'))
})

test('注入：无绑定时只回收、不注入', () => {
  __resetInjectedForTest()
  const rules = freshRules()
  syncAppPermissionRules({ rules, spec: null })
  assert.deepEqual(rules.allow, [])
  assert.deepEqual(rules.ask, [])
})

test('注入：rules 缺 allow/ask 键时自动补齐', () => {
  __resetInjectedForTest()
  const rules = {}
  syncAppPermissionRules({ rules, spec: spec() })
  assert.ok(Array.isArray(rules.allow) && Array.isArray(rules.ask))
  assert.equal(rules.allow.length, 2)
})

test('注入：rules 非对象则抛错（不静默失败）', () => {
  assert.throws(() => syncAppPermissionRules({ rules: null, spec: spec() }))
})

// ── ★ 端到端：注入的规则必须真正改变 decideToolPermission 的行为 ──
test('★ 端到端：read 凭注入的 allow 规则在 manual 档可放行', () => {
  __resetInjectedForTest()
  const rules = freshRules()
  syncAppPermissionRules({ rules, spec: spec() })
  const r = decideToolPermission({ toolName: 'app_myapp_queryOrder', mode: 'manual', rules })
  assert.equal(r.decision, 'allow', 'read 应放行（否则产品承诺的「read 直接跑」不成立）')
})

test('★ 端到端：write 凭注入的 ask 规则即便 bypass 档也必须询问', () => {
  __resetInjectedForTest()
  const rules = freshRules()
  syncAppPermissionRules({ rules, spec: spec() })
  for (const mode of ['manual', 'auto', 'loose', 'bypass']) {
    const r = decideToolPermission({ toolName: 'app_myapp_submitOrder', mode, rules })
    assert.equal(r.decision, 'ask', `${mode} 档下 write 都必须询问`)
  }
})

test('★ 端到端：规则未注入时，兜底仍保证默认档询问（双层防护）', () => {
  __resetInjectedForTest()
  const rules = freshRules()   // 空规则 = 模拟注入失败
  const r = decideToolPermission({ toolName: 'app_myapp_submitOrder', mode: 'loose', rules })
  assert.equal(r.decision, 'ask', '主机制失效时兜底必须接住')
})

test('★ 端到端：注入后切走应用，旧应用的 read 不再被放行（防越权残留）', () => {
  __resetInjectedForTest()
  const rules = freshRules()
  syncAppPermissionRules({ rules, spec: spec() })
  syncAppPermissionRules({ rules, spec: spec({ name: 'OtherApp', appId: 'app-other' }) })
  const r = decideToolPermission({ toolName: 'app_myapp_queryOrder', mode: 'manual', rules })
  assert.equal(r.decision, 'ask', '切走后旧应用不应仍靠残留规则放行（档位+兜底决定为 ask）')
})

test('★ 兜底与主机制的类判定一致：注入的工具名确实以 app_ 开头', () => {
  for (const { name } of appCommandTools(spec())) {
    assert.equal(classifyTool(name), 'appTool', `${name} 应落入兜底类`)
    assert.equal(modeAllows('loose', classifyTool(name)), false)
  }
})
