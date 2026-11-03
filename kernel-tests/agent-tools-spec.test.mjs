// kernel-tests/agent-tools-spec.test.mjs
// Agent 工具声明的解析与车道收窄（2026-09-15，P1「agent和skill页面及功能需要大改」A 条款）。
//
// **本文件钉的是一个真实的既存缺陷**：GUI 的专业 agent 写的是自然语言
// `'All tools except Agent, Edit, Write'`，而下游按逗号 split 当工具名用，于是被切成
// `['All tools except Agent','Edit','Write']`；engine 的"名单里只要有一个认识的名字就不重置"
// 守卫因 `Edit`/`Write` 恰是真实工具名而不生效 ⇒ 该 agent 最终只剩 **Edit + Write**，
// 一个"不会读文件、只会写文件"的 agent，且**全程没有任何报错**。
//
// 故断言分两层：① 声明解析正确；② 车道工具集**真的含有 Read**（不是"看起来配了"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseToolsSpec, parseSkillsSpec, resolveLaneTools } from '../kernel/agents.mjs'

/** 真实的工具名全集（与内核注册表同源，测试里写死关键几个足够；全集用于"只禁不白"分支）。 */
const ALL = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'Task', 'Agent', 'Skill', 'SkillSearch', 'KnowledgeSearch', 'TodoWrite', 'AskUserQuestion']

test('parseToolsSpec：`All tools` / 空 → 不限制', () => {
  for (const raw of ['All tools', 'all tools', '', null, undefined, '  ']) {
    const r = parseToolsSpec(raw)
    assert.deepEqual(r.tools, [], `${JSON.stringify(raw)} 应表示"不限制白名单"`)
    assert.deepEqual(r.disallowed, [])
    assert.equal(r.allTools, true)
  }
})

test('parseToolsSpec：`All tools except A, B` → 不限制白名单 + 禁用集（缺陷的根因处）', () => {
  const r = parseToolsSpec('All tools except Agent, Edit, Write')
  assert.deepEqual(r.tools, [], '**不得**把整句当成一个工具名（这正是原先的切分错误）')
  assert.deepEqual(r.disallowed, ['Agent', 'Edit', 'Write'])
  assert.equal(r.allTools, true)
  // 数组写法（GUI 历史上两种都写过）必须与字符串等价
  assert.deepEqual(parseToolsSpec(['All tools except Agent, Edit, Write']), r)
  // 大小写/空白容错
  assert.deepEqual(parseToolsSpec('  all TOOLS   except   Agent ,Edit').disallowed, ['Agent', 'Edit'])
})

test('parseToolsSpec：显式清单 → 白名单；脏项（空/多余逗号）被丢弃', () => {
  const r = parseToolsSpec('Read, Glob, Grep')
  assert.deepEqual(r.tools, ['Read', 'Glob', 'Grep'])
  assert.deepEqual(r.disallowed, [])
  assert.equal(r.allTools, false)
  assert.deepEqual(parseToolsSpec('Read, , Glob').tools, ['Read', 'Glob'], '手写多余逗号不得产生幽灵工具名')
})

test('parseToolsSpec：无法识别的自由文本不静默丢弃（交由已知名守卫报出）', () => {
  const r = parseToolsSpec('Read, 我的自定义工具')
  assert.deepEqual(r.tools, ['Read', '我的自定义工具'], '保底行为与改动前一致：整串作为白名单项返回')
})

test('parseSkillsSpec：`All skills` 不是技能名', () => {
  assert.deepEqual(parseSkillsSpec('All skills'), [])
  assert.deepEqual(parseSkillsSpec('all skills'), [])
  assert.deepEqual(parseSkillsSpec(''), [])
  assert.deepEqual(parseSkillsSpec('gxtz-core-tables, yfwdoc-excel'), ['gxtz-core-tables', 'yfwdoc-excel'])
  // 回归：原先会被当成一个名为 "All skills" 的技能
  assert.equal(parseSkillsSpec('All skills').includes('All skills'), false)
})

test('resolveLaneTools：缺陷修复的核心断言——`All tools except Agent, Edit, Write` 必须**保留 Read**', () => {
  const spec = parseToolsSpec('All tools except Agent, Edit, Write')
  const allowed = resolveLaneTools({ tools: spec.tools, disallowedTools: spec.disallowed, allToolNames: ALL })
  assert.ok(allowed.includes('Read'), '**核心**：专业 agent 必须能读文件（原先只剩 Edit/Write）')
  assert.ok(allowed.includes('Bash') && allowed.includes('Grep'))
  for (const t of ['Agent', 'Edit', 'Write']) {
    assert.equal(allowed.includes(t), false, `禁用的 ${t} 不得出现`)
  }
  assert.equal(allowed.length, ALL.length - 3, '只禁不白 = 全量 − 禁用集')
})

test('resolveLaneTools：空白名单 → undefined（= 不收窄，不是"零工具"）', () => {
  assert.equal(resolveLaneTools({ tools: [], allToolNames: ALL }), undefined)
  assert.equal(resolveLaneTools({ allToolNames: ALL }), undefined)
})

test('resolveLaneTools：名字全不认识 → 退回不收窄（防"名单写错导致 lane 无工具"）', () => {
  assert.equal(resolveLaneTools({ tools: ['不存在的工具'], allToolNames: ALL }), undefined)
  assert.equal(resolveLaneTools({ tools: ['All tools except Agent, Edit, Write'], allToolNames: ALL }), undefined,
    '未解析的自然语言整句也走这条保底（与改动前行为一致，不会更坏）')
})

test('resolveLaneTools：显式白名单原样保留（含与禁用集叠加）', () => {
  assert.deepEqual(resolveLaneTools({ tools: ['Read', 'Grep'], allToolNames: ALL }), ['Read', 'Grep'])
  assert.deepEqual(resolveLaneTools({ tools: ['Read', 'Grep', 'Bash'], disallowedTools: ['Bash'], allToolNames: ALL }),
    ['Read', 'Grep'], '白名单与禁用集同时给时，禁用集优先')
})

test('resolveLaneTools：只给禁用集（只读 agent 的典型写法）', () => {
  const allowed = resolveLaneTools({ disallowedTools: ['Write', 'Edit', 'Bash'], allToolNames: ALL })
  assert.ok(allowed.includes('Read'))
  assert.equal(allowed.includes('Write'), false)
  assert.equal(allowed.includes('Edit'), false)
  assert.equal(allowed.includes('Bash'), false)
})
