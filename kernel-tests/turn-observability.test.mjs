// 批1 Task 1（S1 观测层）：O1（turnToolDigest.size）+ O2（turnStats.guard）
// ---------------------------------------------------------------------------
// 契约（plan Task 1）：
//   · GUARD_IDS 共 11 个（单一真源）；GUARD_INJECT_IDS ⊆ GUARD_IDS（5 个**真注入**守卫）
//   · O1：turnToolDigest 每项含 size（字节）—— 只取长度、**不复制正文**
//   · O2：turnStats[i].guard = { hits, injections, iterCapHit, loopStopReason,
//                                stallHeals, errorStreak, repeatStreak }
//   · 零行为变更：本层只登记，不得改变任何守卫语义
//
// ★ 迭代上限在 engine-config **模块加载时**读取 ⇒ env 必须在 import 之前设置，
//   故本文件用动态 import（静态 import 会被提升到赋值之前）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LOOP_MAX_ITERATIONS = '2' // 让"工具轮"在第 3 次迭代前被 ② 硬上限截停

const { createEngine, GUARD_IDS, GUARD_INJECT_IDS, collectGuardState } = await import('../kernel/engine.mjs')
const { createSessionStore } = await import('../kernel/session.mjs')
const { makeWire } = await import('../kernel/protocol.mjs')

function makeEngine({ health } = {}) {
  const events = []
  const wire = makeWire({ write(s) { events.push(JSON.parse(s)) } })
  const dir = mkdtempSync(join(tmpdir(), 'ponos-obs-'))
  const store = createSessionStore({ configDir: join(dir, 'home'), cwd: dir, sessionId: 'main' })
  const engine = createEngine({
    opts: { model: 'mock-model', configDir: join(dir, 'home'), addDirs: [dir], skipPermissions: true },
    wire, session: store, ...(health ? { health } : {}),
  })
  engine.setSystemPrompt('你是 Ponos-turbo 测试内核。')
  return { events, engine, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** health 桩：只关心 recordTurnContent（O1 的 digest 出口），其余方法一律 no-op */
function makeHealthStub() {
  const seen = { contents: [] }
  const impl = { recordTurnContent(c) { seen.contents.push(c) } }
  return { seen, stub: new Proxy(impl, { get: (t, p) => (p in t ? t[p] : () => {}) }) }
}

const lastGuard = (engine) => {
  const stats = engine.getTurnStats()
  assert.ok(Array.isArray(stats) && stats.length > 0, 'getTurnStats() 应返回非空数组')
  const last = stats[stats.length - 1]
  assert.ok(last && typeof last === 'object', '轮次统计项应为对象')
  return last.guard
}

// ── 契约（纯函数，不依赖运行时）─────────────────────────────────────────────

test('GUARD_IDS：11 个、互不重复、非空字符串（单一真源）', () => {
  assert.equal(GUARD_IDS.length, 11, `守卫 id 应为 11 个，实际 ${GUARD_IDS.length}`)
  assert.equal(new Set(GUARD_IDS).size, 11, 'GUARD_IDS 不得重复')
  for (const id of GUARD_IDS) {
    assert.equal(typeof id, 'string')
    assert.ok(id.length > 0, 'id 不得为空串')
  }
})

test('GUARD_INJECT_IDS ⊆ GUARD_IDS 且恰 5 个（无注入守卫不得混入）', () => {
  assert.equal(GUARD_INJECT_IDS.length, 5, `真注入守卫应为 5 个，实际 ${GUARD_INJECT_IDS.length}`)
  assert.equal(new Set(GUARD_INJECT_IDS).size, 5, 'GUARD_INJECT_IDS 不得重复')
  for (const id of GUARD_INJECT_IDS) {
    assert.ok(GUARD_IDS.includes(id), `注入守卫 ${id} 必须是合法守卫 id`)
  }
})

test('collectGuardState：默认值如实（0 / null / false，不推断不美化）', () => {
  assert.deepEqual(collectGuardState(), {
    hits: [], injections: 0, iterCapHit: false, loopStopReason: null,
    stallHeals: 0, errorStreak: 0, repeatStreak: 0,
  })
  assert.deepEqual(collectGuardState({ iterations: 99 }).hits, [], '未知字段不得被当成 hits')
})

test('collectGuardState：透传真实值 + 防御非法输入（不造数）', () => {
  const g = collectGuardState({
    hits: ['stall', 'iterCap'], injections: 3, iterCapHit: true, loopStopReason: 'loop-stall',
    stallHeals: 2, errorStreak: 5, repeatStreak: 7,
  })
  assert.deepEqual(g, {
    hits: ['stall', 'iterCap'], injections: 3, iterCapHit: true, loopStopReason: 'loop-stall',
    stallHeals: 2, errorStreak: 5, repeatStreak: 7,
  })
  // 非法输入按 0/null/false —— 且 iterCapHit 只认严格 true（字符串 'true' 不算）
  const bad = collectGuardState({
    hits: 'stall', injections: NaN, iterCapHit: 'true', loopStopReason: '', stallHeals: -1, errorStreak: 1.5, repeatStreak: null,
  })
  assert.deepEqual(bad, {
    hits: [], injections: 0, iterCapHit: false, loopStopReason: null,
    stallHeals: 0, errorStreak: 1, repeatStreak: 0,
  })
})

// ── 静态接线：声明与实装必须一致（防"声明了却没接"或"多计"）───────────────

const ENGINE_SRC = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')
const LOOP_CORE_SRC = readFileSync(new URL('../kernel/loop-core.mjs', import.meta.url), 'utf8')

test('★ 源码接线：11 个守卫 id 每个都有命中登记；注入计数恰 5 处', () => {
  // ★ 2026-09-20 批2 Task 2 起：iterHead 守卫体已**等价搬移**进 kernel/loop-core.mjs，
  //   登记语句跟着守卫一起搬走（批1 与批2 计划双向写明的串行纪律）。
  //   故此处改为**两文件合扫**判定「声明与实装一致」——断言语义不变：
  //   · 每个声明 id 有 1~2 处命中登记   · 无未声明 id
  //   · 真注入登记点总数恰 = GUARD_INJECT_IDS.length
  const src = `${ENGINE_SRC}\n${LOOP_CORE_SRC}`
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  const pat = (id) => new RegExp(String.raw`turnGuardHits\??\.push\('${esc(id)}'\)`, 'g')

  for (const id of GUARD_IDS) {
    // 允许 `turnGuardHits.push(`（engine 内联）与 `turnGuardHits?.push(`（loop-core 走 ctx）
    const n = (src.match(pat(id)) || []).length
    assert.ok(n >= 1, `守卫 ${id} 声明了却没有任何命中登记（漏接）`)
    assert.ok(n <= 2, `守卫 ${id} 的登记超过 2 处（可能重复计数）：${n}`)
  }
  // 反向：源码里不得出现未登记的 id（写了别人的 id = 契约漂移）
  for (const m of src.matchAll(/turnGuardHits\??\.push\('([^']+)'\)/g)) {
    assert.ok(GUARD_IDS.includes(m[1]) || m[1].startsWith('${'), `出现未声明的守卫 id: ${m[1]}`)
  }
  // 注入计数：真注入登记点总数必须与 GUARD_INJECT_IDS 数量一致。
  //  · engine 侧未搬移的守卫仍是内联 `turnGuardInjections++`
  //  · loop-core 侧走唯一注入出口的计数钩子 `turnGuardInjections?.bump()`
  const inj = (ENGINE_SRC.match(/turnGuardInjections\+\+/g) || []).length
    + (LOOP_CORE_SRC.match(/turnGuardInjections\??\.bump\(\)/g) || []).length
  assert.equal(inj, GUARD_INJECT_IDS.length, `真注入登记点应恰 ${GUARD_INJECT_IDS.length} 处，实际 ${inj}`)

  // O1 只取长度、不复制正文
  assert.match(ENGINE_SRC, /size: Buffer\.byteLength\(/, 'O1 的 size 必须用 Buffer.byteLength 取字节')
  // O2 落到轮次统计
  assert.match(ENGINE_SRC, /guard: outcome\.guard \?\? collectGuardState\(\)/, 'O2 必须落到 turnStats.push')
})

// ── 运行时：干净轮（无守卫命中）─────────────────────────────────────────────

test('运行时：干净轮 guard 如实为空（hits=[] / injections=0 / 无 loopStop）', async () => {
  delete process.env.PONOS_MOCK_LOOP
  const env = makeEngine()
  try {
    await env.engine.runTurn({ content: '只回一句话，不要调用工具' })
    const g = lastGuard(env.engine)
    assert.ok(g, 'turnStats 末条必须含 guard（O2 已接线）')
    assert.deepEqual(g.hits, [], '干净轮不得有任何守卫命中（否则是误报）')
    assert.equal(g.injections, 0, '干净轮注入次数应为 0')
    assert.equal(g.iterCapHit, false)
    assert.equal(g.loopStopReason, null)
  } finally { env.cleanup() }
})

// ── 运行时：② 迭代硬上限真的被登记（end-to-end 证明登记生效）────────────────

test('★ 运行时：② 迭代硬上限命中 → hits 含 iterCap、iterCapHit=true、注入 0', async () => {
  process.env.PONOS_MOCK_LOOP = 'ok' // 每轮都吐一个工具调用 ⇒ 必然迭代到硬上限
  const env = makeEngine()
  try {
    await env.engine.runTurn({ content: '反复调用工具' })
    const g = lastGuard(env.engine)
    assert.ok(g.hits.includes('iterCap'), `hits 应含 iterCap，实际 ${JSON.stringify(g.hits)}`)
    assert.equal(g.iterCapHit, true, 'iterCapHit 应与命中一致')
    // ★ 如实口径：② 只置 iterCapHit=true，**不置 loopStop、不发任何事件**
    //   （对照表见计划：守卫②"不发任何事件"）⇒ loopStopReason 必须仍为 null
    assert.equal(g.loopStopReason, null, `② 不置 loopStop ⇒ loopStopReason 应为 null，实际 ${g.loopStopReason}`)
    assert.equal(g.injections, 0, '② 不发事件、无注入 ⇒ injections 必须为 0（如实登记，不粉饰）')
    assert.deepEqual(g.hits.filter((x) => !GUARD_IDS.includes(x)), [], '不得出现未声明的守卫 id')
  } finally { delete process.env.PONOS_MOCK_LOOP; env.cleanup() }
})

// ── 运行时：O1（digest.size 真测量、且不夹带正文）──────────────────────────

test('★ 运行时：O1 工具摘要含 size（真字节数 > 0）且不复制正文', async () => {
  process.env.PONOS_MOCK_LOOP = 'ok'
  const { seen, stub } = makeHealthStub()
  const env = makeEngine({ health: stub })
  try {
    await env.engine.runTurn({ content: '反复调用工具' })
    assert.ok(seen.contents.length >= 1, 'health.recordTurnContent 应被调用（O1 的出口）')
    const digest = seen.contents[seen.contents.length - 1]?.toolDigest
    assert.ok(Array.isArray(digest) && digest.length > 0, '工具摘要应非空（本轮确实跑了工具）')
    for (const d of digest) {
      assert.equal(typeof d.size, 'number', 'O1：每项必须含 size')
      assert.ok(Number.isInteger(d.size) && d.size >= 0, `size 应为非负整数，实际 ${d.size}`)
      assert.ok(!('content' in d), 'O1：不得夹带原始正文（体积与隐私约束）')
      assert.ok(String(d.errorText ?? '').length <= 200, 'errorText 仍须截断在 200 字符内')
    }
    assert.ok(digest.some((d) => d.size > 0), '至少一项 size > 0（证明是真测量，不是恒 0 占位）')
  } finally { delete process.env.PONOS_MOCK_LOOP; env.cleanup() }
})
