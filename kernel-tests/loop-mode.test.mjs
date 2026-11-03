// 三层升级执行层（2026-10-06 spec loop-3layer-upgrade §4 A23）：
// 模式常量 / 归一 / profileForMode / 指令文本 / 引擎轮首接管（setLoopMode → 下一轮生效、
// 指令恰一次、loop_mode_applied 事件、turnStats.loopMode）/ 默认（auto→react）零变更 /
// profile 解析点唯一（静态）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PONOS_MOCK_API = '1'

const {
  LOOP_MODES, LOOP_MODE_SELECTORS, DEFAULT_LOOP_MODE, DEFAULT_EFFECTIVE_MODE,
  normalizeLoopMode, modeDirective, profileForMode,
  CUSTOM_LOOP_MODE_PREFIX, parseCustomLoopMode, customLoopModeId,
} = await import('../kernel/loop-modes.mjs')
const { MAIN_PROFILE, validateProfile, resolveGuards } = await import('../kernel/loop-profile.mjs')
const { createEngine } = await import('../kernel/engine.mjs')
const { createSessionStore } = await import('../kernel/session.mjs')
const { makeWire } = await import('../kernel/protocol.mjs')

// ── 纯模块契约 ──────────────────────────────────────────────────────────────

test('LOOP_MODES = react/plan/reflect/subagent（顺序即展示序）；选择器 = auto + 模式', () => {
  // ★ 2026-10-29：新增 subagent（用户要求"新增一个真正的 subagent 模式"）。它追加在末位
  //   ——react 必须仍是**默认档/首位**（零回归基线靠这个位置语义 + DEFAULT_EFFECTIVE_MODE）。
  assert.deepEqual(LOOP_MODES, ['react', 'plan', 'reflect', 'subagent'])
  assert.deepEqual(LOOP_MODE_SELECTORS, ['auto', 'react', 'plan', 'reflect', 'subagent'])
  assert.equal(DEFAULT_LOOP_MODE, 'auto')
  assert.equal(DEFAULT_EFFECTIVE_MODE, 'react', '缺省实际模式必须是现状行为（零回归基线）')
})

test('normalizeLoopMode：合法值归一（大小写/空白），非法值 null（不静默改档）', () => {
  assert.equal(normalizeLoopMode('react'), 'react')
  assert.equal(normalizeLoopMode(' PLAN '), 'plan')
  assert.equal(normalizeLoopMode('Reflect'), 'reflect')
  assert.equal(normalizeLoopMode('auto'), 'auto')
  for (const bad of ['', '   ', 'foo', null, undefined, 0, 'pl an']) {
    assert.equal(normalizeLoopMode(bad), null, `非法值 ${JSON.stringify(bad)} 必须返回 null`)
  }
})

// ── 编排形态（2026-10-07 编排扩展 T2）──────────────────────────────────────

test('parseCustomLoopMode：custom:<SAFE_ID> 形态校验，保留大小写，非法 null', () => {
  assert.equal(CUSTOM_LOOP_MODE_PREFIX, 'custom:', '前缀是跨层字面量（桥/内核/契约同物同名）')
  // 合法：id 段原样保留（大小写敏感——它是磁盘目录名）
  assert.equal(parseCustomLoopMode('custom:foo'), 'custom:foo')
  assert.equal(parseCustomLoopMode('custom:Gen-Review_1.0'), 'custom:Gen-Review_1.0', 'id 保留大小写')
  assert.equal(parseCustomLoopMode('  custom:abc  '), 'custom:abc', '首尾空白修剪')
  assert.equal(parseCustomLoopMode('custom:trail '), 'custom:trail', '同上：整体修剪后 id 合法即合法')
  assert.equal(parseCustomLoopMode('custom:' + 'a'.repeat(64)), 'custom:' + 'a'.repeat(64), '配满 64 字符仍合法')
  // 非法：null（不静默改档）
  for (const bad of [
    '', 'custom:', 'custom: lead', 'custom:trail x', 'custom:a b',
    'custom:-lead', 'custom:.dot', 'custom:_x', 'custom:a/b', 'custom:a\\b',
    'custom:' + 'a'.repeat(65),
    'Custom:foo', 'CUSTOM:foo', 'custom :foo',
    'foo', 'custom', 'plan', null, undefined, 0,
  ]) {
    assert.equal(parseCustomLoopMode(bad), null, `非法形态 ${JSON.stringify(bad)} 必须返回 null`)
  }
  // 并列不互认：custom 不是第四个枚举值，三模式也不带前缀
  assert.equal(normalizeLoopMode('custom:foo'), null, 'custom 不得被枚举归一吞下')
  assert.equal(parseCustomLoopMode('plan'), null, '枚举值不得被 custom 解析吞下')
})

test('customLoopModeId：取 id 或 null（前缀只有一处真源）', () => {
  assert.equal(customLoopModeId('custom:Gen-Review'), 'Gen-Review')
  assert.equal(customLoopModeId('  custom:abc  '), 'abc')
  assert.equal(customLoopModeId('custom:'), null)
  assert.equal(customLoopModeId('plan'), null)
  assert.equal(customLoopModeId(null), null)
})

test('★ profileForMode：react 与 MAIN_PROFILE 同身份（零回归的硬保证）', () => {
  assert.equal(profileForMode('react'), MAIN_PROFILE, 'react 必须是同一对象（=== 通过）')
  assert.equal(profileForMode('不存在的模式'), MAIN_PROFILE, '防御回落 react（上游已归一，此处不猜）')
})

test('★ profileForMode：plan/reflect/subagent 过 validateProfile 且守卫集逐项同 MAIN（不漏守卫）', () => {
  for (const mode of ['plan', 'reflect', 'subagent']) {
    const p = profileForMode(mode)
    assert.equal(validateProfile(p).ok, true, `${mode} profile 必须合法`)
    assert.notEqual(p, MAIN_PROFILE, `${mode} 不得与 MAIN 同对象（否则"模式"名存实亡）`)
    for (const phase of ['iterHead', 'inStream', 'afterStream']) {
      assert.deepEqual(resolveGuards(p, phase), resolveGuards(MAIN_PROFILE, phase),
        `${mode} 的 ${phase} 守卫集必须与主循环逐项相同（删名=静默丢守卫）`)
    }
    assert.equal(p.stop, MAIN_PROFILE.stop)
  }
})

test('profileForMode 缓存：同模式同对象（不重复派生/校验）', () => {
  assert.equal(profileForMode('plan'), profileForMode('plan'))
  assert.equal(profileForMode('reflect'), profileForMode('reflect'))
  assert.equal(profileForMode('subagent'), profileForMode('subagent'))
})

test('modeDirective：每个模式各有非空且互不相同的指令；未知模式 null', () => {
  const seen = new Set()
  for (const mode of LOOP_MODES) {
    const d = modeDirective(mode)
    assert.equal(typeof d, 'string')
    assert.ok(d.length > 10, `${mode} 指令文本不得为空壳`)
    assert.ok(d.includes('【循环模式·'), `${mode} 指令须带稳定前缀（可断言、可过滤）`)
    seen.add(d)
  }
  assert.equal(seen.size, LOOP_MODES.length, '各模式指令不得互相复制')
  assert.equal(modeDirective('nope'), null)
})

// ── 引擎运行时（mock API）───────────────────────────────────────────────────

function makeEngine() {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-lmode-'))
  const store = createSessionStore({ configDir: join(dir, 'home'), cwd: dir, sessionId: 'main' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir: join(dir, 'home'), addDirs: [dir], skipPermissions: true },
    wire, session: store,
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  const appliedEvents = () => events.filter((e) => e.type === 'system' && e.subtype === 'loop_mode_applied')
  const directivesIn = (mode) => store.deriveMessages().filter(
    (m) => m.role === 'user' && String(m.content ?? '').includes(`【循环模式·${mode.toUpperCase()}】`))
  return { events, engine, store, appliedEvents, directivesIn, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const lastMeta = (engine) => {
  const stats = engine.getTurnStats()
  return stats[stats.length - 1].loopMode
}

test('运行时·默认零变更：auto→react 无注入、无事件、turnStats 如实', async () => {
  delete process.env.PONOS_MOCK_LOOP
  const env = makeEngine()
  try {
    await env.engine.runTurn({ content: '只回一句话，不要调用工具' })
    const meta = lastMeta(env.engine)
    assert.equal(meta.selected, 'auto')
    assert.equal(meta.effective, 'react', '路由未产出时必须沿用 react（零回归基线）')
    assert.ok(meta.router, 'auto 轮必须留下路由留痕（可观测）')
    assert.equal(meta.router.fallback, true, 'mock 环境无脚本化路由回复 ⇒ 如实记 fallback')
    assert.equal(meta.governance.action, 'stay', '路由未产出 ⇒ 治理保持（安全默认）')
    assert.equal(env.appliedEvents().length, 0, '默认轮不得注入模式指令（appliedMode 起步 react）')
    assert.equal(env.directivesIn('react').length, 0, '默认轮不得出现任何模式指令文本')
  } finally { env.cleanup() }
})

test('★ 运行时·钉住 plan：下一轮生效 + 指令恰一次 + 事件 + meta', async () => {
  const env = makeEngine()
  try {
    const r = env.engine.setLoopMode('plan')
    assert.deepEqual(r, { ok: true, value: 'plan', selected: 'plan', effective: 'plan' })
    await env.engine.runTurn({ content: '只回一句话，不要调用工具' })
    assert.deepEqual(lastMeta(env.engine), { selected: 'plan', effective: 'plan', router: null, governance: null })
    const evs = env.appliedEvents()
    assert.equal(evs.length, 1, `模式变化应恰发一次 loop_mode_applied，实际 ${evs.length}`)
    assert.deepEqual({ selected: evs[0].selected, effective: evs[0].effective, from: evs[0].from },
      { selected: 'plan', effective: 'plan', from: 'react' })
    assert.equal(env.directivesIn('plan').length, 1, 'PLAN 指令应恰注入一次')
    // 第二轮：模式语境未再变化 ⇒ 不再重复注入/发事件（防每轮刷屏）
    await env.engine.runTurn({ content: '继续' })
    assert.equal(env.appliedEvents().length, 1, '语境未变不得重复发事件')
    assert.equal(env.directivesIn('plan').length, 1, '语境未变不得重复注入指令')
    assert.equal(lastMeta(env.engine).effective, 'plan')
  } finally { env.cleanup() }
})

test('★ 运行时·切回 react：退出指令恰一次（对称）', async () => {
  const env = makeEngine()
  try {
    env.engine.setLoopMode('plan')
    await env.engine.runTurn({ content: '只回一句话，不要调用工具' })
    const r = env.engine.setLoopMode('react')
    assert.equal(r.ok, true)
    await env.engine.runTurn({ content: '继续' })
    assert.deepEqual(lastMeta(env.engine), { selected: 'react', effective: 'react', router: null, governance: null })
    assert.equal(env.appliedEvents().length, 2, 'plan→react 应再发一次事件')
    assert.equal(env.directivesIn('react').length, 1, '切回 react 应有且仅有一次退出指令')
  } finally { env.cleanup() }
})

test('★ 运行时·钉住 subagent（2026-10-29 新增档）：热切生效 + 指令恰一次 + effective 就是它', async () => {
  const env = makeEngine()
  try {
    const r = env.engine.setLoopMode('subagent')
    assert.deepEqual(r, { ok: true, value: 'subagent', selected: 'subagent', effective: 'subagent' })
    await env.engine.runTurn({ content: '只回一句话，不要调用工具' })
    assert.deepEqual(lastMeta(env.engine), { selected: 'subagent', effective: 'subagent', router: null, governance: null })
    assert.equal(env.directivesIn('subagent').length, 1, 'SUBAGENT 指令应恰注入一次')
    assert.equal(env.appliedEvents().length, 1, '模式变化应恰发一次 loop_mode_applied')
  } finally { env.cleanup() }
})

test('setLoopMode 非法值：ok:false 且不改档（rejected 由 cli 上报）', async () => {
  const env = makeEngine()
  try {
    env.engine.setLoopMode('plan')
    const bad = env.engine.setLoopMode('bogus')
    assert.equal(bad.ok, false)
    assert.equal(bad.value, 'bogus')
    assert.deepEqual(env.engine.getLoopMode(), { selected: 'plan', effective: 'plan' }, '非法值不得改档')
  } finally { env.cleanup() }
})

test('运行时·热切 custom（2026-10-07 编排扩展）：形态校验接受、存在性不判（轮首解析）、非法拒绝不改档', async () => {
  const env = makeEngine()
  try {
    // 形态合法即接受——即便工作流不存在（零状态纪律：存在性留给轮首解析，D23）
    const r = env.engine.setLoopMode('custom:ghost-not-exist')
    assert.deepEqual(r, { ok: true, value: 'custom:ghost-not-exist', selected: 'custom:ghost-not-exist', effective: 'custom' },
      'custom 是钉住态：selected 带 id、effective 压成字面量 custom')
    assert.deepEqual(env.engine.getLoopMode(), { selected: 'custom:ghost-not-exist', effective: 'custom' })
    // 大小写保留（id 是磁盘目录名）：前缀字面量小写、id 原样
    assert.equal(env.engine.setLoopMode('custom:Gen-Review_1.0').selected, 'custom:Gen-Review_1.0')
    // 非法形态拒绝且不改档（rejected 由 cli 上报）
    for (const bad of ['custom:', 'custom: lead', 'custom:a b', 'Custom:foo', 'CUSTOM:foo']) {
      const r2 = env.engine.setLoopMode(bad)
      assert.equal(r2.ok, false, `${bad} 必须被拒`)
      assert.equal(r2.value, bad)
    }
    assert.deepEqual(env.engine.getLoopMode(), { selected: 'custom:Gen-Review_1.0', effective: 'custom' }, '非法值不得改档')
  } finally { env.cleanup() }
})

// ── 静态接线 ────────────────────────────────────────────────────────────────

const ENGINE_SRC = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')

test('★ 静态：profileForMode 在 engine 恰一个调用点（每轮一次解析的结构保证）', () => {
  const n = (ENGINE_SRC.match(/profileForMode\(/g) || []).length
  assert.equal(n, 1, `engine 内 profileForMode( 调用应恰 1 处（轮首 profile 解析点），实际 ${n}`)
  assert.match(ENGINE_SRC, /profile: profileForMode\(turnMeta\.effective\)/, '解析点必须用轮首结算的 effective')
})

test('★ 静态：轮首结算只认轮边界（不得挂在 loop.onTurnEnd 等旁路）', () => {
  // 负向：engine 源码里不得出现"在 onTurnEnd 里切模式"这类接线（本升级只走 runTurnInternal 轮首）
  assert.ok(!/onTurnEnd[\s\S]{0,200}setLoopMode|setLoopMode[\s\S]{0,200}onTurnEnd/.test(ENGINE_SRC),
    'setLoopMode 不得挂在 onTurnEnd（它不是通用轮边界）')
})
