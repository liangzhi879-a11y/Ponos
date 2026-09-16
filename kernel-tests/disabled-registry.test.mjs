// kernel-tests/disabled-registry.test.mjs
// Agent / Skill 全局停用（2026-09-15，待处理清单 P1「agent和skill页面及功能需要大改」D 条款）。
//
// 这层必须单独、直接地测，理由：D 条款最容易被做成**假开关**——GUI 上关了、内核照旧加载，
// 用户看到的是"我明明停了它还在跑"。故每条断言都钉"内核侧真的不再能拿到它"，
// 而不是"配置文件里写了什么"。
//
// 三处消费面各一条（缺任一条就是半生效）：
//   ① 技能：不进技能清单（提示词据此）、② 按名调用被拒（Skill 工具）、③ agent：不在 resolveAgents。
// 隔离纪律：mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readDisabled, writeDisabled, normalizeDisabled, excludeDisabled, isDisabled, disabledPath,
} from '../kernel/disabled.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'ponos-disabled-'))

/** 造一个技能目录：<root>/<id>/SKILL.md */
function makeSkill(root, id, desc = '测试技能') {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${desc}\n---\n\n# ${id}\n\n执行步骤。\n`, 'utf-8')
}

/** 造 configDir：含 skills/ 与 agents/ 两个目录。 */
function makeConfig({ skills = ['s-a', 's-b'], agents = ['my-agent'] } = {}) {
  const dir = tmp()
  for (const id of skills) makeSkill(join(dir, 'skills'), id)
  if (agents.length) {
    mkdirSync(join(dir, 'agents'), { recursive: true })
    for (const id of agents) {
      writeFileSync(join(dir, 'agents', `${id}.md`),
        `---\nname: ${id}\ndescription: 自定义 agent\n---\n\n你是 ${id}。\n`, 'utf-8')
    }
  }
  return dir
}

// ── 注册表读写 ────────────────────────────────────────────────────────────
test('注册表缺省：文件不存在 = 未停用任何项（且不抛错）', () => {
  const dir = tmp()
  try {
    const r = readDisabled({ configDir: dir })
    assert.deepEqual(r.agents, [])
    assert.deepEqual(r.skills, [])
    assert.equal(r.ok, true, '文件不存在是正常状态，不是错误')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('注册表读容错：文件损坏/非 JSON/键类型错 → 退化为"全开"且 ok=false（可查）', () => {
  const dir = tmp()
  try {
    writeFileSync(disabledPath({ configDir: dir }), '{ 这不是 JSON', 'utf-8')
    const r = readDisabled({ configDir: dir })
    assert.deepEqual(r.skills, [], '读失败必须退化为"不停用"：读失败就崩会让内核起不来')
    assert.equal(r.ok, false, '但必须让调用方知道"读失败"（否则"停用没生效"无从排查）')

    writeFileSync(disabledPath({ configDir: dir }), JSON.stringify({ skills: 'oops', agents: 7 }), 'utf-8')
    const r2 = readDisabled({ configDir: dir })
    assert.deepEqual(r2.skills, [], '键类型错 → 当空处理')
    assert.equal(r2.ok, true, '合法 JSON 就算类型不对也不算"损坏"')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('归一：去空、去重、保序', () => {
  const n = normalizeDisabled({ skills: [' b ', 'a', 'b', '', null], agents: ['x', 'x'] })
  assert.deepEqual(n.skills, ['b', 'a'], '保序：停用清单的顺序每次刷新都变会让用户以为出了事')
  assert.deepEqual(n.agents, ['x'])
})

test('写路径：原子替换 + 回读校验（半截文件会让内核读成"全开"）', () => {
  const dir = tmp()
  try {
    const w = writeDisabled({ configDir: dir, data: { skills: ['s-a', 's-a', ''], agents: ['my-agent'] } })
    assert.equal(w.ok, true, w.error)
    assert.deepEqual(w.data.skills, ['s-a'], '写入前先归一（写坏的注册表会让下次启动静默全开/全关）')
    assert.equal(JSON.parse(readFileSync(disabledPath({ configDir: dir }), 'utf-8')).agents.length, 1)
    assert.equal(existsSync(`${disabledPath({ configDir: dir })}.tmp-${process.pid}`), false, '临时文件不得残留')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('excludeDisabled / isDisabled：按 id 判定且保序；空清单不影响原数组', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(excludeDisabled(list, ['b']).map((x) => x.id), ['a', 'c'])
  assert.deepEqual(excludeDisabled(list, []), list, '空清单 → 原样返回（语义上等于全开）')
  assert.deepEqual(excludeDisabled(list, null), list)
  assert.deepEqual(excludeDisabled(list, ['', '  ']), list, '空 id 不算停用项')
  assert.equal(isDisabled(['b'], 'b'), true)
  assert.equal(isDisabled(['b'], 'a'), false)
  assert.equal(isDisabled(null, 'a'), false)
})

// ── 消费面 ①：技能不进清单 ──────────────────────────────────────────────
test('消费面①：停用后技能不在 discoverSkillsAll 结果里（提示词与工具池同源）', async () => {
  const { discoverSkillsAll } = await import('../kernel/skills.mjs')
  const dir = makeConfig({ skills: ['s-a', 's-b'] })
  try {
    const all = discoverSkillsAll({ roots: [join(dir, 'skills')], disabled: [] })
    assert.deepEqual(all.map((s) => s.id).sort(), ['s-a', 's-b'])
    const off = discoverSkillsAll({ roots: [join(dir, 'skills')], disabled: ['s-a'] })
    assert.deepEqual(off.map((s) => s.id), ['s-b'], '停用的技能必须从清单里消失')
    // 缺省不过滤：公开口的既有行为（测试/嵌入直接调用）不得被本改动打断
    assert.deepEqual(discoverSkillsAll({ roots: [join(dir, 'skills')] }).map((s) => s.id).sort(), ['s-a', 's-b'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 消费面 ②：按名调用被拒 ──────────────────────────────────────────────
test('消费面②：停用技能按名调用被明确拒绝（防"沿用历史对话直接调用"的后门）', async () => {
  const { createToolRegistry } = await import('../kernel/tools.mjs')
  const dir = makeConfig({ skills: ['s-a', 's-b'] })
  try {
    const mk = (disabledSkills) => createToolRegistry({
      cwd: dir, addDirs: [], skipPermissions: true,
      skillsDirs: [join(dir, 'skills')], disabledSkills,
    })
    const on = mk(null)
    const okRes = await on.run({ name: 'Skill', input: { skill: 's-a' } }, {})
    assert.equal(okRes.isError, false, '未停用时按名调用应正常加载')

    const off = mk(['s-a'])
    const denied = await off.run({ name: 'Skill', input: { skill: 's-a' } }, {})
    assert.equal(denied.isError, true, '停用后必须拒绝——只在清单处过滤等于留了后门')
    assert.match(denied.content, /已被全局停用/, '要说清原因，别让模型以为是"技能不存在"而反复改名重试')
    assert.match(denied.content, /技能面板/, '给出用户侧可执行动作')

    const still = await off.run({ name: 'Skill', input: { skill: 's-b' } }, {})
    assert.equal(still.isError, false, '停用只影响目标技能（不得误伤）')

    const miss = await off.run({ name: 'Skill', input: { skill: 's-ghost' } }, {})
    assert.match(miss.content, /可用技能：s-b/, '不存在时的可用清单也要排除停用项（口径一致）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 消费面 ③：agent 不在 resolveAgents ──────────────────────────────────
test('消费面③：停用 agent 不在 resolveAgents（含内置 agent——它们同样可被停用）', async () => {
  const { resolveAgents } = await import('../kernel/agents.mjs')
  const dir = makeConfig({ agents: ['my-agent'] })
  try {
    const before = resolveAgents({ configDir: dir, disabled: [] }).map((a) => a.id)
    assert.ok(before.includes('my-agent'), '自定义 agent 应可见')
    assert.ok(before.includes('general-purpose'), '内置 agent 本来恒在（这正是"停不掉"的缺口）')

    writeDisabled({ configDir: dir, data: { agents: ['my-agent', 'general-purpose'] } })
    const after = resolveAgents({ configDir: dir }).map((a) => a.id)
    assert.equal(after.includes('my-agent'), false, '自定义 agent 停用后必须消失')
    assert.equal(after.includes('general-purpose'), false, '**内置 agent 也必须能停用**（硬编码表不再是豁免区）')

    // 显式传参优先（测试与未来复用）
    assert.deepEqual(resolveAgents({ configDir: dir, disabled: [] }).map((a) => a.id).sort(),
      resolveAgents({ configDir: dir, disabled: [] }).map((a) => a.id).sort())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
