// 技能自动触达通道（S1.4）—— `matchAutoTrigger` 泛化的**纯函数**契约
// ---------------------------------------------------------------------------
// 背景：workflow 与 skill 在**发现机制**上平权（同根、同 triggers），但触发通道不平权——
// 匹配器 `matchAutoTrigger` 只吃 workflows（既有语义还带 `autoTrigger !== true → continue`
// 硬门槛），而 `discoverSkills()` 产出的技能对象**没有 autoTrigger 字段**
// （kernel/skills.mjs:75-87）。故"把 skills 换个参数传进去"一项都不会命中，必须放宽谓词。
//
// 本文件钉死两侧，缺一不可：
//   ① **默认语义一字不变**：requireFlag 缺省（true）时仍只认 autoTrigger === true
//      —— 这是既有工作流触发口径，放开即回归（见 workflow-engine.test.mjs:175-177）；
//   ② **requireFlag:false 时**技能形态（无该字段）可命中，且显式 `autoTrigger: false`
//      仍被尊重（跳过）。触发词口径与既有完全一致：子串匹配、长度 >= 2 防单字误触、
//      按列表顺序取第一个命中、未命中返回 null。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { matchAutoTrigger } from '../kernel/workflow-dsl.mjs'

const skill = (id, triggers) => ({ id, name: id, description: 'd', triggers })   // 注意：无 autoTrigger 字段

test('默认语义不变：没有 autoTrigger 的项不得命中（回归锁定）', () => {
  assert.equal(matchAutoTrigger([skill('s1', ['报表'])], '帮我做报表'), null)
})

test('默认语义不变：autoTrigger:true 的项缺省仍命中（防"改默认"式放宽）', () => {
  const wf = { id: 'w1', autoTrigger: true, triggers: ['报表'] }
  assert.equal(matchAutoTrigger([wf], '帮我做报表')?.id, 'w1')
})

test('★ requireFlag:false 时技能可命中（子串匹配，触发词 >= 2 字）', () => {
  const hit = matchAutoTrigger([skill('s1', ['报表'])], '帮我做报表', { requireFlag: false })
  assert.equal(hit?.id, 's1')
})

test('requireFlag:false 仍不接受单字触发词（防误触口径一致）', () => {
  assert.equal(matchAutoTrigger([skill('s1', ['表'])], '做表', { requireFlag: false }), null)
})

test('requireFlag:false 未命中 → null（而不是抛出或返回空对象）', () => {
  assert.equal(matchAutoTrigger([skill('s1', ['报表'])], '你好', { requireFlag: false }), null)
})

test('混排：autoTrigger:true 的工作流与技能共存时，按列表顺序取第一个命中', () => {
  const wf = { id: 'w1', autoTrigger: true, triggers: ['报表'] }
  assert.equal(matchAutoTrigger([wf, skill('s1', ['报表'])], '做报表', { requireFlag: false })?.id, 'w1')
})

test('requireFlag:false 也尊重显式关掉：autoTrigger:false 的项必须跳过（停用/关闭语义）', () => {
  const off = { id: 's1', autoTrigger: false, triggers: ['报表'] }
  const on = skill('s2', ['报表'])
  assert.equal(matchAutoTrigger([off, on], '做报表', { requireFlag: false })?.id, 's2')
})

// ── 源码面守卫：接线三条硬要求（纯函数测试**覆盖不到** cli 接线，只能扫源码）────────
// 三条都是"静默失效"型缺陷——出错时没有任何运行时异常，只在用户侧表现为
// "停用的技能被自动触发 / 系统提示以用户气泡进历史 / 一条消息收到两套打架的指令"。
const cliSrc = readFileSync(new URL('../kernel/cli.mjs', import.meta.url), 'utf-8')

/** 取 `function <name>(…) {…}` 的**函数体**切片（括号平衡，含嵌套块）。 */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `kernel/cli.mjs 缺函数 ${name}`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1) }
  }
  assert.fail(`函数 ${name} 的函数体括号不平衡`)
}

/** 函数体里是否有一处形如 `engine.queueNext(<任意实参…>, { system: true })` 的调用。 */
function hasSystemMarkedQueueNext(body) {
  for (const m of body.matchAll(/engine\.queueNext\(/g)) {
    // 从调用起点做括号平衡切片，再判实参里是否显式带 system: true
    let depth = 0
    let j = m.index + 'engine.queueNext'.length
    for (; j < body.length; j++) {
      if (body[j] === '(') depth++
      else if (body[j] === ')') { depth--; if (depth === 0) { j++; break } }
    }
    if (/\{ system: true \}/.test(body.slice(m.index, j))) return true
  }
  return false
}

test('接线①：技能匹配必须吃已过滤 disabled 的 skills（不得用未过滤的发现结果）', () => {
  const body = functionBody(cliSrc, 'maybeAutoTriggerSkill')
  assert.ok(
    body.includes('matchAutoTrigger(skills, content, { requireFlag: false })'),
    '技能触发须用 matchAutoTrigger(skills, content, { requireFlag: false }) —— 且 skills 必须是'
    + '已过 excludeDisabled 的那份（否则"提示词清单里没有、却被自动触发"，停用失效）',
  )
})

test('接线②：技能提示注入必须走 system 标记出口（否则出现在用户可见历史里）', () => {
  const body = functionBody(cliSrc, 'maybeAutoTriggerSkill')
  assert.ok(
    hasSystemMarkedQueueNext(body),
    '技能自动触达的注入必须经 engine.queueNext(…, { system: true })（同文件自动触发工作流结果先例）',
  )
})

test('接线③：优先级 workflow > 技能 —— 调用点须由"workflow 未命中"来把守技能触发', () => {
  assert.ok(
    /if \(!maybeAutoTriggerWorkflow\(content\)\) maybeAutoTriggerSkill\(content\)/.test(cliSrc),
    '调用点须写成 `if (!maybeAutoTriggerWorkflow(content)) maybeAutoTriggerSkill(content)`'
    + '（同一消息只注入一段；两个都注入会让模型收到两套互相打架的指令）',
  )
  // 且该守卫确实在唯一调用点上（技能触发不得在别处被无条件调用 —— 否则优先级被绕过）
  const unconditional = cliSrc.match(/^\s*maybeAutoTriggerSkill\(content\)\s*$/gm) || []
  assert.equal(unconditional.length, 0, '技能触发不得存在无守卫的裸调用点')
})
