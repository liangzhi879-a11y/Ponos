// 自愈阶梯（L0–L4）：把"内核现在救到第几级"变成可读事实（2026-09-21 长任务可靠性 P2 第三步）。
//
// 为什么要有这个文件（不是"为纯函数补覆盖率"）：
//   自愈点已有 9 处，但级差原先只写在注释里、预算分散在各处 ⇒ 排障时答不出最基本的一问
//   "这个卡住的任务，内核救到第几级了？还能再救吗？"。统一阶梯的价值全在**级差是事实且不会漂移**，
//   故本文件的三组断言各守一条：
//     ① 定级正确（纯函数）：含"同一字符串在注入/收尾两种动作下级别不同"这条最容易写错的语义；
//     ② **不漂移**（静态对账）：扫 loop-core 的 reason 字面量必须全部已登记 —— 防新增守卫忘登记，
//        让"统一阶梯"在半年后仍是真的（否则它会慢慢退化成一份过期注释）；
//     ③ **端到端真的带上 wire**：level 只在观测面出现才有排障价值；同时在断言里反证
//        "未登记的 reason 不得凭空造级"（不猜级=不误导）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DISK_REASON_LEVEL, GUARD_HEAL_LEVELS, HEAL_LEVEL_NAMES, HEAL_LEVELS, INJECTION_REASON_LEVEL, REASON_TABLES, SIGNAL_LEVEL, STOP_REASON_LEVEL,
  judgeEscalation, levelRank, reasonToLevel, summarizeLadder,
} from '../kernel/heal-ladder.mjs'
import { KNOWN_GUARDS } from '../kernel/loop-profile.mjs'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

// ── ① 定级正确 ──────────────────────────────────────────────────────────────
test('级序与名称：L0–L4 五级齐备、数值序与语义序一致', () => {
  assert.deepEqual(Object.values(HEAL_LEVELS), [0, 1, 2, 3, 4])
  for (const lv of ['L0', 'L1', 'L2', 'L3', 'L4']) assert.equal(typeof HEAL_LEVEL_NAMES[lv], 'string')
  assert.ok(levelRank('L0') < levelRank('L1') && levelRank('L1') < levelRank('L2') && levelRank('L2') < levelRank('L3') && levelRank('L3') < levelRank('L4'))
  assert.equal(levelRank('L9'), -1, '未登记级别排序最末（不参与"最高级"比较）')
  assert.equal(levelRank(null), -1)
})

test('★ 定级看"手段是否改变"，不看"发生在哪个守卫里"：upstream-dead=L0（退避重发）、idle-interrupted=L1（注入续写）', () => {
  // 两者都由 idleWatchdog/upstreamDead 一带触发，级差只有一个理由：有没有**注入文本改变对话**
  assert.equal(reasonToLevel('upstream-dead', 'inject'), 'L0')
  assert.equal(reasonToLevel('idle-interrupted', 'inject'), 'L1')
  assert.equal(reasonToLevel('loop-stall', 'inject'), 'L1')
  assert.equal(reasonToLevel('error-meltdown', 'inject'), 'L1')
  assert.equal(reasonToLevel('continue', 'inject'), 'L1', '截断升档续写（引擎侧）也是改策略')
  assert.equal(reasonToLevel('loop-timeout-streak', 'inject'), 'L2', '超时连击的文案就是"降规模"')
})

test('★ 同一字符串两种含义：注入 = L1（改策略）、收尾 = L3（有界收尾）—— 判定必须带动作维度', () => {
  for (const r of ['loop-stall', 'gen-repeat', 'near-repeat', 'error-meltdown', 'upstream-dead']) {
    assert.equal(reasonToLevel(r, 'stop'), 'L3', `${r} 收尾应 L3`)
  }
  // 其中这几个在**注入域**也有含义（repeatHeal 直接复用收尾 reason 去注入推进指令）
  for (const r of ['loop-stall', 'gen-repeat', 'near-repeat', 'error-meltdown']) {
    assert.equal(reasonToLevel(r, 'inject'), 'L1', `${r} 注入应 L1`)
  }
  // upstream-dead 的注入是"退避重发"（不改对话内容）⇒ L0，与上面四个改策略的不同
  assert.equal(reasonToLevel('upstream-dead', 'inject'), 'L0', 'upstream-dead 注入 = 静默重试，不是改策略')
  // 只作收尾用的
  for (const r of ['timeout', 'idle']) assert.equal(reasonToLevel(r, 'stop'), 'L3')
  // 只作信号用的
  assert.equal(reasonToLevel('idle-dead-retry', 'signal'), 'L0')
  assert.equal(reasonToLevel('upstream-dead-retry', 'signal'), 'L0')
  assert.equal(reasonToLevel('idle-heal', 'signal'), 'L1')
})

test('纪律③：未登记 / 畸形 / 缺动作 ⇒ null（**绝不猜级**——猜错比不给更糟）', () => {
  assert.equal(reasonToLevel('wat', 'inject'), null)
  assert.equal(reasonToLevel('wat', 'stop'), null)
  assert.equal(reasonToLevel('', 'inject'), null)
  assert.equal(reasonToLevel(undefined, 'inject'), null)
  assert.equal(reasonToLevel(123, 'inject'), null)
  assert.equal(reasonToLevel('loop-stall', 'unknown-action'), null, '动作维度缺失时不猜')
  assert.equal(reasonToLevel('loop-stall'), null)
})

// ── ② 不漂移：静态对账（本仓范式）────────────────────────────────────────────
test('★ 对账：loop-core 里出现的每个 reason/signal 字面量都必须已登记（防新增守卫忘登记）', () => {
  const src = read('../kernel/loop-core.mjs')
  const found = new Set()
  for (const m of src.matchAll(/\breason:\s*'([a-z0-9-]+)'/g)) found.add(m[1])
  for (const m of src.matchAll(/\bsignal:\s*'([a-z0-9-]+)'/g)) found.add(m[1])
  for (const m of src.matchAll(/\bkind:\s*'([a-z0-9-]+)'/g)) found.add(m[1])
  assert.ok(found.size >= 12, `扫描应找到足量字面量（实测 ${found.size}：${[...found].join(',')}）`)
  const registered = new Set([
    ...Object.keys(INJECTION_REASON_LEVEL),
    ...Object.keys(STOP_REASON_LEVEL),
    ...Object.keys(SIGNAL_LEVEL),
  ])
  const unregistered = [...found].filter((r) => !registered.has(r))
  assert.deepEqual(unregistered, [], `以下 reason 未登记自愈级别（新增守卫时请一并登记 kernel/heal-ladder.mjs）：${unregistered.join(',')}`)
})

test('★ 对账（精确版）：注入点写死的 reason 必须登记在**注入域**，且**两种事件形态都要认**', () => {
  // 只查"任一域已登记"是**弱判据**：`gen-repeat` 若只登记在收尾域也能蒙过去，而它在注入域
  // 缺登记时，该自愈路径在观测面上就没有 level（"统一阶梯"名存实亡）。故这里按**语法位置**判。
  const src = read('../kernel/loop-core.mjs')
  // 形态① 扁平 `event: { reason: '...'`；形态② 嵌套 `payload: { reason: '...'`
  const flat = [...src.matchAll(/event:\s*\{\s*reason:\s*'([a-z0-9-]+)'/g)].map((m) => m[1])
  const nested = [...src.matchAll(/payload:\s*\{\s*reason:\s*'([a-z0-9-]+)'/g)].map((m) => m[1])
  assert.ok(flat.length >= 2, `扁平形态应找到足量（实测 ${flat.length}：${flat.join(',')}）`)
  assert.ok(nested.length >= 3, `嵌套形态应找到足量（实测 ${nested.length}：${nested.join(',')}）`)
  for (const r of new Set([...flat, ...nested])) {
    const lv = reasonToLevel(r, 'inject')
    assert.ok(lv !== null, `注入点 reason='${r}' 必须在注入域登记（否则该自愈在观测面上没有级别）`)
  }
  // 语义抽查（防"登记了但登记错级"）：L0 只属于"不改对话内容的静默重试"，
  // L2 只属于"降规模"。这两条是最容易被后来者顺手改成 L1 的。
  assert.equal(reasonToLevel('loop-timeout-streak', 'inject'), 'L2', '超时连击 = 降规模')
  assert.equal(reasonToLevel('upstream-dead', 'inject'), 'L0', '上游空流重发 = 静默重试（不注入文本）')
  assert.equal(reasonToLevel('loop-stall', 'inject'), 'L1', '停滞 = 注入推进指令')
  // ★ 形态对账：标注实现必须两种都认（否则扁平形态的守卫在观测面上没有 level）。
  //   这是实测踩过的坑：初版只认 payload 嵌套 ⇒ 停滞/超时连击（最常用的自愈路径）漏掉。
  const fnSrc = src.slice(src.indexOf('function annotateHealLevel('), src.indexOf('function annotateHealLevel(') + 1400)
  assert.match(fnSrc, /const pl = event\.payload && typeof event\.payload === 'object' \? event\.payload : null/, '须先探 payload（嵌套形态）')
  assert.match(fnSrc, /reasonToLevel\(event\.reason, 'inject'\)/, '再回落到 event.reason（扁平形态）')
  // 宿主侧同样是两种形态（两侧口径必须一致，否则"发了没人认"）
  const engineSrc = read('../kernel/engine.mjs')
  assert.match(engineSrc, /const pl = ev\.payload \|\| ev/, '宿主侧也按"payload 优先、回落扁平"读，与本处对齐')
  // 变量形式（repeatHeal 复用 loopStop.reason）单独钉住
  assert.match(src, /const healReason = loopStop\.reason/, 'repeatHeal 复用收尾 reason 做注入（此形态需人工确认）')
  assert.match(src, /reason:\s*healReason/, '注入事件用的是变量 ⇒ 必须确认 gen-repeat/near-repeat 已在注入域登记')
  for (const r of ['gen-repeat', 'near-repeat']) assert.equal(reasonToLevel(r, 'inject'), 'L1', `${r} 被 repeatHeal 借去注入，必须在注入域登记`)
})

test('★ 对账：GUARD_HEAL_LEVELS 的键集 == 守卫注册表（防守卫改名/新增后阶梯表过期）', () => {
  assert.deepEqual(
    Object.keys(GUARD_HEAL_LEVELS).sort(),
    [...KNOWN_GUARDS].sort(),
    '阶梯表的守卫键集必须与 loop-profile 注册表逐字一致',
  )
  // 每个值只能是我们认识的级别，且升序（说明表填写正确）
  for (const [gid, levels] of Object.entries(GUARD_HEAL_LEVELS)) {
    for (const lv of levels) assert.ok(lv in HEAL_LEVELS, `${gid} 含非法级别 ${lv}`)
    const ranks = levels.map(levelRank)
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${gid} 的级别应升序`)
    assert.ok(!levels.includes('L3') && !levels.includes('L4'), `${gid} 不应把"收尾/宿主"算作可自愈级别`)
  }
  // 有自愈能力的守卫必须非空（否则说明表填漏了）
  for (const gid of ['stall', 'repeatHeal', 'meltdown', 'idleWatchdog', 'upstreamDead', 'repeatReminder']) {
    assert.ok(GUARD_HEAL_LEVELS[gid].length > 0, `${gid} 有自愈动作，级别不应为空`)
  }
  for (const gid of ['wallClock', 'iterCap', 'genRepeat', 'nearRepeat', 'progressRefresh']) {
    assert.deepEqual(GUARD_HEAL_LEVELS[gid], [], `${gid} 无自愈动作（只收尾/只更新状态）`)
  }
})

test('接线：定级发生在唯一注入出口（单点），且只标注、不改预算（纪律①）', () => {
  const src = read('../kernel/loop-core.mjs')
  assert.match(src, /import \{ reasonToLevel \} from '\.\/heal-ladder\.mjs'/, '须引入阶梯模块')
  assert.match(src, /const ev = annotateHealLevel\(meta\.event\)/, '定级须在 emitInjection 内单点完成')
  assert.match(src, /function annotateHealLevel\(event\)/, '须有独立的标注函数（纯函数、返回新对象）')
  // 标注函数不得触碰预算/计数（纪律①：级差是事实，不是策略）
  const fnSrc = src.slice(src.indexOf('function annotateHealLevel('), src.indexOf('function annotateHealLevel(') + 600)
  for (const banned of ['HealCount', 'healCount', 'budget', 'attempt', '++']) {
    assert.ok(!fnSrc.includes(banned), `annotateHealLevel 不得涉及 ${banned}（否则"标注"会变成"改策略"）`)
  }
  // 未登记 reason ⇒ 不加 level（不猜级、老行为逐字不变）
  assert.match(fnSrc, /if \(!level\) return event/)
})

// ── 汇总与升级判定 ──────────────────────────────────────────────────────────
test('summarizeLadder：给出"最高到几级 + 是否已收尾交还用户"，且未登记项如实上报', () => {
  const none = summarizeLadder({})
  assert.equal(none.highest, null)
  assert.equal(none.exhausted, false)
  assert.match(none.line, /无需自愈/)

  const injected = summarizeLadder({ injections: 2, hits: { stall: 2 } })
  assert.equal(injected.highest, 'L1')
  assert.equal(injected.counts.L1, 2)
  assert.equal(injected.exhausted, false)

  const l0 = summarizeLadder({ signals: ['upstream-dead-retry'] })
  assert.equal(l0.highest, 'L0')
  assert.equal(l0.highestName, '静默重试')

  const stopped = summarizeLadder({ hits: { stall: 3, idleWatchdog: 1 }, injections: 1, stops: ['loop-stall', 'timeout'] })
  assert.equal(stopped.counts.L3, 2)
  assert.equal(stopped.highest, 'L3')
  assert.equal(stopped.exhausted, true, '走到 L3 = 内核救不动了、已收尾交还用户')
  assert.match(stopped.line, /已收尾交还用户/)

  const unknown = summarizeLadder({ stops: ['wat'], hits: { progressRefresh: 1 } })
  assert.deepEqual(unknown.unknown, ['stop:wat'], '未登记项如实上报（不得静默吞掉）')
  // progressRefresh 是登记过的守卫（级别为空）⇒ 不算 unknown，也不贡献级
  assert.equal(unknown.highest, null)
})

test('judgeEscalation：预算内留在本级；耗尽升一级；L3 不再自行升级（L4 由宿主决定）', () => {
  assert.deepEqual(judgeEscalation({ level: 'L0', attempts: 0, max: 3 }).action, 'retry')
  assert.equal(judgeEscalation({ level: 'L1', attempts: 3, max: 5 }).action, 'inject')
  assert.equal(judgeEscalation({ level: 'L2', attempts: 1, max: 3 }).action, 'downscale')
  const up0 = judgeEscalation({ level: 'L0', attempts: 3, max: 3 })
  assert.equal(up0.action, 'escalate')
  assert.equal(up0.nextLevel, 'L1')
  assert.equal(judgeEscalation({ level: 'L1', attempts: 5, max: 5 }).nextLevel, 'L2')
  assert.equal(judgeEscalation({ level: 'L2', attempts: 5, max: 5 }).nextLevel, 'L3')
  const at3 = judgeEscalation({ level: 'L3', attempts: 9, max: 9 })
  assert.equal(at3.action, 'finalize', 'L3 已是有界收尾')
  assert.equal(at3.nextLevel, null, '内核不得自行升级到 L4（那是宿主决定）')
  // 无限预算（max<0）= 持久安全网语义（meltdown 的默认形态）：永不升级
  assert.equal(judgeEscalation({ level: 'L1', attempts: 999, max: -1 }).action, 'inject')
  assert.equal(judgeEscalation({ level: 'L1', attempts: 999 }).action, 'inject', '缺 max 视为无限')
  // 未登记级别 ⇒ unknown（调用方按旧逻辑处理 = 零行为变更）
  assert.equal(judgeEscalation({ level: 'wat', attempts: 1, max: 1 }).action, 'unknown')
  assert.equal(judgeEscalation({}).action, 'unknown')
})

test('升级只认"手段用了几次"，不认时间（纪律②：自愈不得靠"等得更久"升级）', () => {
  const src = read('../kernel/heal-ladder.mjs')
  const fnSrc = src.slice(src.indexOf('export function judgeEscalation('))
  for (const banned of ['Date.now', 'elapsed', 'ms', 'timeout', 'since']) {
    assert.ok(!fnSrc.slice(0, 1200).includes(banned), `judgeEscalation 不得引入时间维度（命中 ${banned}）`)
  }
  assert.ok(!/Date\.now/.test(src.slice(src.indexOf('export function summarizeLadder('), src.indexOf('export function judgeEscalation('))), 'summarizeLadder 也不得引入时间维度')
})

// ── 第四域：落盘（2026-09-23 会话健康快照，spec §4.1）──────────────────────────
test('★ 落盘域定级：四 reason 分级正确（L0 重试 / L1 降级 / L2 舍次 / L3 告警前）', () => {
  assert.equal(reasonToLevel('disk-write-retry', 'disk'), 'L0')
  assert.equal(reasonToLevel('disk-strategy-fallback', 'disk'), 'L1')
  assert.equal(reasonToLevel('disk-shed-secondary', 'disk'), 'L2')
  assert.equal(reasonToLevel('disk-critical-persist-fail', 'disk'), 'L3')
  // 跨域不串味：落盘的 reason 在别的域里不成立，反之亦然
  assert.equal(reasonToLevel('disk-write-retry', 'inject'), null)
  assert.equal(reasonToLevel('loop-stall', 'disk'), null)
  assert.equal(reasonToLevel('nope', 'disk'), null, '未登记 ⇒ null（不猜级）')
})

test('★ 落盘域词表恒定：site 名不进 reason 词表（否则词表随落盘点增长而失控）', () => {
  const src = read('../kernel/heal-ladder.mjs')
  // 切片只覆盖落盘词表本身（终点取下一个导出，避免把 GUARD_HEAL_LEVELS 整块注释也纳入，
  // 否则将来在无关注释里提到 site 名会误红）
  const body = src.slice(src.indexOf('export const DISK_REASON_LEVEL'), src.indexOf('export const GUARD_HEAL_LEVELS'))
  for (const site of ['transcript-append', 'tool-result', 'session-memory', 'loop-state', 'transcript-usage']) {
    assert.ok(!body.includes(site), `site 名 ${site} 不得进 reason 词表（site 是参数）`)
  }
  assert.deepEqual(Object.keys(DISK_REASON_LEVEL).sort(), [
    'disk-critical-persist-fail', 'disk-shed-secondary', 'disk-strategy-fallback', 'disk-write-retry',
  ])
})

test('★ 对账（行为式·四域全覆盖）：域齐备 + 每张表的每个 reason 都能被 reasonToLevel 定级', () => {
  // 为什么这样写而不是扫源码文本：扫文本的断言"功能被注释掉仍绿、等价重构却红"（两个方向都不可靠）。
  // 行为式断言能真守住"新增域/漏登记"：漏接一个域 ⇒ 域清单红；表里登记了但函数没接 ⇒ 定级为 null 红。
  assert.deepEqual(Object.keys(REASON_TABLES).sort(), ['disk', 'inject', 'signal', 'stop'], '四个动作域缺一不可')
  for (const [domain, table] of Object.entries(REASON_TABLES)) {
    for (const reason of Object.keys(table)) {
      assert.notEqual(reasonToLevel(reason, domain), null, `${domain} 域的 ${reason} 必须在 reasonToLevel 里生效`)
      assert.equal(reasonToLevel(reason, domain), table[reason], `${domain}/${reason} 的定级须与词表一致`)
    }
    assert.equal(reasonToLevel('definitely-not-registered', domain), null, `${domain} 域未登记 reason ⇒ null（不猜级）`)
  }
})

test('★ 未登记 reason 的原型键也不得漏过：返回 null 而非 Object.prototype 的成员', () => {
  for (const domain of ['inject', 'stop', 'signal', 'disk']) {
    for (const protoKey of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      assert.equal(reasonToLevel(protoKey, domain), null, `${domain}/${protoKey} 必须为 null`)
    }
  }
})
