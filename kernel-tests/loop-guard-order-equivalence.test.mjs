// L2 守卫序等价锁（S2/B1 · Task 2：iterHead）
// ---------------------------------------------------------------------------
// 目的：把「守卫命中时的可观测后果」钉死——防重构把守卫静默搬丢/搬错序/改文案。
// 断言五件事：
//   1. 守卫名清单：profile 声明的每个名字都在 KNOWN_GUARDS 里，且**与 engine 的
//      GUARD_IDS（O2 可观测面真源）同集同义**——同物异名是漂移源，必须零残留
//   2. 守卫序：iterHead 固定为 wallClock → iterCap → stall（profile 驱动）
//   3. 搬移等价：loop-core 的运行时可观测后果与 golden 基线**逐字一致**
//      （injections 文案/persist/事件 payload、wire 事件、stop 文案、action、计数变化）
//   4. 源级等价：搬移前 HEAD 源码块里的**中文字面量**必须逐字出现在 loop-core.mjs
//      （防"运行时恰好一致但文案被改写"这类漏网）
//   5. 接线：engine 已不再内联 iterHead 守卫（否则 = 两处维护，回归风险）
// 本任务只覆盖 iterHead；Task 3/4 扩充 inStream/afterStream。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAIN_PROFILE, LANE_PROFILE, KNOWN_GUARDS, resolveGuards } from '../kernel/loop-profile.mjs'
import { GUARD_IDS } from '../kernel/engine.mjs'
import { runIterHeadScenario, scenarios } from './fixtures/guard-order-harness.mjs'

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/guard-order-iterhead.golden.json', import.meta.url), 'utf8'))
const CORE_SRC = readFileSync(new URL('../kernel/loop-core.mjs', import.meta.url), 'utf8')
const ENGINE_SRC = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')

test('守卫名清单与 profile 声明一致（防拼错后静默失效）', () => {
  const declared = new Set([
    ...MAIN_PROFILE.guards.iterHead, ...MAIN_PROFILE.guards.inStream, ...MAIN_PROFILE.guards.afterStream,
    ...LANE_PROFILE.guards.iterHead, ...LANE_PROFILE.guards.inStream, ...LANE_PROFILE.guards.afterStream,
  ])
  for (const name of declared) assert.ok(KNOWN_GUARDS.has(name), `${name} 应在 KNOWN_GUARDS`)
})

test('★ 命名归一：KNOWN_GUARDS 与 engine 的 GUARD_IDS 同集（不留两套名字）', () => {
  // 真源 = engine.mjs 的 GUARD_IDS（O2 已落地的可观测面）。骨架期的计划名
  // （idleDeadRetry / meltdownStop / failureHeal）必须已归一到 idleWatchdog / meltdown。
  // ★ `progressRefresh` 是**唯一例外**（Task 4 实测修正）：骨架期曾把它归一为 `stall`，
  //   但二者是不同相位、不同语义、不同动作（stall 在迭代头做停滞检测并注入/break；
  //   progressRefresh 在工具后做纯状态更新、无 stop 无注入），而守卫注册表**按名注册**
  //   ⇒ 同名只能指同一函数，归一会导致某个相位调错实现（静默错行为）。故保留独立名；
  //   它不出现在 GUARD_IDS 是因为从不登记命中，与其"独立守卫"身份不矛盾。
  const NON_HIT_GUARDS = ['progressRefresh'] // 从不登记命中的守卫（GUARD_IDS 只管 O2 命中面）
  for (const id of GUARD_IDS) assert.ok(KNOWN_GUARDS.has(id), `${id} 应在 KNOWN_GUARDS（以 engine 为准）`)
  for (const name of KNOWN_GUARDS) {
    if (NON_HIT_GUARDS.includes(name)) continue
    assert.ok(GUARD_IDS.includes(name), `${name} 不在 engine 的 GUARD_IDS 里 ⇒ 名字漂移`)
  }
  // 已废弃的计划名不得回流（回流 = 两套名字，横比口径失效）
  const src = `${CORE_SRC}\n${readFileSync(new URL('../kernel/loop-profile.mjs', import.meta.url), 'utf8')}`
    .replace(/^\s*\/\/.*$/gm, '') // 注释里允许提及历史名（映射表要写清），跑码里不许出现
  for (const dead of ['idleDeadRetry', 'meltdownStop', 'failureHeal']) {
    assert.ok(!new RegExp(`'${dead}'`).test(src), `已废弃的守卫名 ${dead} 不得在跑码中出现（只允许出现在注释的映射表里）`)
  }
})

test('iterHead 守卫序固定为 wallClock → iterCap → stall（profile 驱动，主循环与 lane 同序）', async () => {
  assert.deepEqual(resolveGuards(MAIN_PROFILE, 'iterHead'), ['wallClock', 'iterCap', 'stall'])
  assert.deepEqual(resolveGuards(LANE_PROFILE, 'iterHead'), ['wallClock', 'iterCap', 'stall'])
})

test('★ golden 基线确为「搬移前」产物（否则等价锁无意义）', () => {
  assert.ok(GOLDEN.iterHeadSource.includes('// 守卫①：轮次墙钟'), 'git 源码块应含 ① 墙钟')
  assert.ok(GOLDEN.iterHeadSource.includes('turnGuardHits.push(\'stall\')'), 'git 源码块应含 ⑥ 命中登记')
  assert.ok(!GOLDEN.iterHeadSource.includes('runIterHeadGuards'), '源码块不得已含搬移后的调用（否则基线是搬移后录的）')
  assert.deepEqual(Object.keys(GOLDEN.runtime).sort(), ['iterCap', 'stallHardStop', 'stallHeal', 'wallClock'])
})

test('★ L2 等价：iterHead 三个守卫的可观测后果与基線逐字一致', async () => {
  // 场景里的 lastProgressAt/turnT0 依赖当前时刻 ⇒ 用同一套「相对现在」的构造重跑；
  // 快照已把墙钟规范成布尔（progressRefreshed），故比对与运行时刻无关。
  for (const [name, state] of Object.entries(scenarios())) {
    const actual = await runIterHeadScenario(state)
    assert.deepEqual(actual, GOLDEN.runtime[name], `场景 ${name} 的可观测后果必须与基线逐字一致`)
  }
})

test('★ 源级等价：搬移前源码块里的中文字面量必须逐字出现在 loop-core.mjs', () => {
  // 同时抽单引号字面量与模板字面量（①/⑥ 的收尾文案是反引号模板）
  const lits = [
    ...[...GOLDEN.iterHeadSource.matchAll(/'([^'\n]*[\u4e00-\u9fa5][^'\n]*)'/g)].map((m) => m[1]),
    ...[...GOLDEN.iterHeadSource.matchAll(/`([^`\n]*[\u4e00-\u9fa5][^`]*?)`/g)].map((m) => m[1]),
  ]
  assert.ok(lits.length >= 3, `基线里应至少抽出 3 条中文文案（①/⑥ 收尾 + ⑥ 注入），实际 ${lits.length}`)
  for (const t of lits) {
    // 文案经模板插值（${...}）后不会逐字相等 ⇒ 取插值前的骨架片段比对
    const skeleton = t.split('${')[0]
    assert.ok(CORE_SRC.includes(skeleton), `搬移前的文案片段在 loop-core 中缺失（文案被改？）：${skeleton.slice(0, 40)}`)
  }
  // 事件文案（reason 字面值）与阈值变量名必须原样搬移
  assert.ok(CORE_SRC.includes("reason: 'loop-stall'"), "guard_heal 的 reason 字面值必须仍为 'loop-stall'")
  assert.ok(CORE_SRC.includes("reason: 'timeout'"), "① 的 loopStop.reason 必须仍为 'timeout'")
})

test('★ 接线：engine 不再内联 iterHead 守卫（防两处维护），且逐处只保留一份实现', () => {
  // engine 侧：①/②/⑥ 的三处内联命中登记应已全部搬走
  for (const id of ['wallClock', 'iterCap']) {
    assert.equal((ENGINE_SRC.match(new RegExp(`turnGuardHits\\.push\\('${id}'\\)`, 'g')) || []).length, 0, `${id} 应已搬入 loop-core`)
  }
  assert.match(ENGINE_SRC, /await runIterHeadGuards\(/, 'engine 必须调用契约入口')
  // loop-core 侧：三个守卫体各登记恰一次（⑥ 两支：自愈 + 硬停，合计 2 处）
  for (const id of ['wallClock', 'iterCap']) {
    assert.equal((CORE_SRC.match(new RegExp(`push\\('${id}'\\)`, 'g')) || []).length, 1, `${id} 在 loop-core 应恰 1 处登记`)
  }
  assert.equal((CORE_SRC.match(/push\('stall'\)/g) || []).length, 2, '⑥ 有自愈/硬停两支 ⇒ 2 处登记')
})

test('★ 注入经唯一出口：⑥ 的注入只能走 ctx.inject（不得自造 pushMemory/wire 路径）', () => {
  assert.ok(CORE_SRC.includes('ctx.inject(STALL_INJECT_TEXT'), '⑥ 注入必须走唯一出口')
  // 跑码不得引用宿主副作用（边界纪律；注释里的"不得自造 pushMemory/wire"说明不算）
  const code = CORE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(!/pushMemory/.test(code), 'loop-core 跑码不得直接调用 pushMemory')
  assert.ok(!/wire\?\.system/.test(code), 'loop-core 跑码不得直接调 wire.system')
  // 文案常量已搬入 loop-core（单一来源）
  assert.match(CORE_SRC, /const STALL_INJECT_TEXT = '【系统】检测到你长时间没有实质进展/)
  // 主循环那份文案（结尾"…或向用户明确汇报当前卡点与结论。"）必须已从 engine 搬走；
  // 子 lane 的那份（结尾"…或输出最终结论。"）属 Task 4 范围，此处不动它。
  assert.ok(!ENGINE_SRC.includes('或向用户明确汇报当前卡点与结论'), '主循环的 ⑥ 文案不得再留在 engine（两处维护）')
  assert.ok(ENGINE_SRC.includes('或输出最终结论'), '子 lane 的 ⑥ 文案仍在 engine（Task 4 才搬移，本任务不动）')
})

test('★ 命中即短路：守卫序 wallClock → iterCap → stall 逐级截断（与原实现同序）', async () => {
  // 场景 A：② 与 ⑥ 同时"该命中"——② 在前，故只登记 iterCap 且 break（原实现同序）
  const a = await runIterHeadScenario({
    MAX_TOOL_ITERATIONS: 1, iter: 5, LOOP_STALL_MS: 60000, lastProgressAt: Date.now() - 120000, stallHeals: 0,
  })
  assert.deepEqual(a.hits, ['iterCap'], '② 在 ⑥ 之前 ⇒ 不得再跑 ⑥（否则一次迭代计两次命中）')
  assert.equal(a.action, 'break', '② 的收尾方式是 break（且不置 loopStop）')
  assert.equal(a.stop, null, '② 不置 loopStop（loopStopReason 必须保持 null）')
  assert.equal(a.injectionsCount, 0, '② 无注入')

  // 场景 B：关掉 ② 后 ⑥ 自愈 —— break/continue 与 stop 三者语义各不相同，此处锁 continue
  const b = await runIterHeadScenario({
    MAX_TOOL_ITERATIONS: 0, LOOP_STALL_MS: 60000, lastProgressAt: Date.now() - 120000, stallHeals: 0,
  })
  assert.deepEqual(b.hits, ['stall'])
  assert.equal(b.action, 'continue', '⑥ 自愈 = continue（重开观察窗）')
  assert.equal(b.stop, null)
  assert.equal(b.injectionsCount, 1)
  assert.equal(b.state.stallHeals, 1)
  assert.equal(b.state.progressRefreshed, true, '注入后必须刷新进展时间戳（重开完整观察窗）')
})
