// src/lib/agentTools.test.ts
// Agent 工具结构化模型（2026-09-15，P1 A 条款）。跑在 node --test（本仓库无 vitest）。
//
// 三类断言，缺一不可：
//   ① **语义对齐内核**：解析/格式化必须与 `kernel/agents.mjs` 的 parseToolsSpec 同语义，
//      否则"界面配的"与"内核执行的"是两套规则（本缺陷的根源就是这种不一致）。
//   ② **往返无损**：`parse → format → parse` 稳定，保证反复保存不会逐次退化。
//   ③ **工具名全集与内核一致**（漂移守卫）：界面不能列出内核没有的工具名——列了就是
//      "用户配了一个永远不生效的工具"。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALL_TOOL_NAMES, TOOL_CATALOG, TOOL_GROUPS, parseAgentTools, formatAgentTools,
  effectiveTools, summarizeAgentTools, isReadOnlyTools, isKnownTool,
} from './agentTools.ts'

test('工具目录：无重复、分组齐全、名字为空的情况不存在', () => {
  assert.equal(new Set(ALL_TOOL_NAMES).size, ALL_TOOL_NAMES.length, '工具名不得重复')
  for (const t of TOOL_CATALOG) {
    assert.ok(t.name && t.label && t.group, `目录项缺字段：${JSON.stringify(t)}`)
  }
  assert.deepEqual(TOOL_GROUPS, [...new Set(TOOL_GROUPS)], '分组顺序不得重复')
})

test('漂移守卫：界面工具名全集必须与内核注册表一致（多一个少一个都是坑）', async () => {
  // 内核是权威。GUI 不能 import 内核（子进程 + .mjs），故在此对账：
  //   少一个 → 用户无法在界面上授权一个真实存在的工具（能力静默缺失）；
  //   多一个 → 用户能授权一个不存在的工具，内核按"不认识"处理（配置静默无效）。
  // 用变量路径 + `as string` 让 TS 不解析它（`.mjs` 无类型声明；运行期 node 按相对本文件解析）。
  const mod = await import('../../kernel/tools.mjs' as string) as {
    createToolRegistry: (o: Record<string, unknown>) => { toolNames: string[] }
  }
  const { createToolRegistry } = mod
  const registry = createToolRegistry({ cwd: process.cwd(), addDirs: [], skipPermissions: true })
  const kernelNames = [...registry.toolNames].sort()
  const uiNames = [...ALL_TOOL_NAMES].sort()
  assert.deepEqual(uiNames, kernelNames,
    `界面工具目录与内核漂移。\n界面有而内核没有：${uiNames.filter(n => !kernelNames.includes(n))}\n` +
    `内核有而界面没有：${kernelNames.filter(n => !uiNames.includes(n))}`)
})

test('parseAgentTools：三态解析与内核 parseToolsSpec 同语义', () => {
  assert.deepEqual(parseAgentTools('All tools'), { mode: 'all', names: [] })
  assert.deepEqual(parseAgentTools(''), { mode: 'all', names: [] })
  assert.deepEqual(parseAgentTools(undefined), { mode: 'all', names: [] })
  assert.deepEqual(parseAgentTools([]), { mode: 'all', names: [] }, '空数组（老数据形态）也是"不限制"')
  assert.deepEqual(parseAgentTools('All tools except Agent, Edit, Write'),
    { mode: 'allExcept', names: ['Agent', 'Edit', 'Write'] })
  assert.deepEqual(parseAgentTools(['All tools except Agent, Edit, Write']),
    { mode: 'allExcept', names: ['Agent', 'Edit', 'Write'] }, '数组形态必须与字符串等价（GUI 两种都写过）')
  assert.deepEqual(parseAgentTools('Read, Glob'), { mode: 'custom', names: ['Read', 'Glob'] })
})

test('formatAgentTools：输出内核认识的字面量 + 去重保序', () => {
  assert.equal(formatAgentTools({ mode: 'all', names: [] }), 'All tools')
  assert.equal(formatAgentTools({ mode: 'allExcept', names: ['Edit', 'Write'] }), 'All tools except Edit, Write')
  assert.equal(formatAgentTools({ mode: 'allExcept', names: [] }), 'All tools', '无排除项 = 全部（不写成 "except "）')
  assert.equal(formatAgentTools({ mode: 'custom', names: ['Read', 'Read', 'Grep'] }), 'Read, Grep')
})

test('往返无损：parse → format → parse 稳定（反复保存不得逐次退化）', () => {
  const cases = ['All tools', 'All tools except Agent, Edit, Write', 'Read, Glob, Grep', '']
  for (const raw of cases) {
    const once = formatAgentTools(parseAgentTools(raw))
    const twice = formatAgentTools(parseAgentTools(once))
    assert.equal(once, twice, `不稳定：${JSON.stringify(raw)} → ${JSON.stringify(once)} → ${JSON.stringify(twice)}`)
  }
})

test('effectiveTools：**修复的核心**——"全部（除 Edit/Write）"必须保留 Read', () => {
  const spec = parseAgentTools('All tools except Agent, Edit, Write')
  const eff = effectiveTools(spec)
  assert.ok(eff.names.includes('Read'), '核心：专业 agent 必须能读文件（原先只剩 Edit/Write）')
  assert.equal(eff.unrestricted, true, 'allExcept 属于"不限制"家族（不是白名单）')
  for (const n of ['Agent', 'Edit', 'Write']) assert.equal(eff.names.includes(n), false)
})

test('effectiveTools：白名单全是不认识的名字 → 如实显示"不限制"（内核真实行为）', () => {
  const eff = effectiveTools({ mode: 'custom', names: ['我的工具'] })
  assert.equal(eff.unrestricted, true, '内核 resolveLaneTools 的保底分支就是退回不限制，界面不能装作已收窄')
  assert.deepEqual(eff.unknownNames, ['我的工具'])
  assert.equal(eff.names.length, ALL_TOOL_NAMES.length)
})

test('effectiveTools：未知名字与已知名字混填时，只按已知名收窄并报出未知项', () => {
  const eff = effectiveTools({ mode: 'custom', names: ['Read', '幽灵工具'] })
  assert.deepEqual(eff.names, ['Read'])
  assert.equal(eff.unrestricted, false)
  assert.deepEqual(eff.unknownNames, ['幽灵工具'])
})

test('isReadOnlyTools：无写/执行工具即只读', () => {
  assert.equal(isReadOnlyTools({ mode: 'custom', names: ['Read', 'Grep', 'Glob'] }), true)
  assert.equal(isReadOnlyTools({ mode: 'custom', names: ['Read', 'Edit'] }), false)
  assert.equal(isReadOnlyTools({ mode: 'custom', names: ['Read', 'Bash'] }), false)
  assert.equal(isReadOnlyTools({ mode: 'all', names: [] }), false, '全开 = 可写（不能标成只读）')
  assert.equal(isReadOnlyTools({ mode: 'allExcept', names: ['Write', 'Edit', 'Bash', 'KnowledgeImport', 'KnowledgeDelete'] }), true,
    '把写类工具全排除掉也算只读')
})

test('summarizeAgentTools：三种模式都给出可读摘要', () => {
  assert.equal(summarizeAgentTools({ mode: 'all', names: [] }), '全部工具')
  assert.equal(summarizeAgentTools({ mode: 'allExcept', names: ['Edit', 'Write'] }), '全部（除 Edit、Write）')
  assert.equal(summarizeAgentTools({ mode: 'custom', names: ['Read', 'Grep'] }), 'Read、Grep')
  assert.match(summarizeAgentTools({ mode: 'custom', names: ALL_TOOL_NAMES.slice(0, 8) }), /等 8 个/)
})

test('isKnownTool：大小写敏感（与内核 Set 精确匹配一致）', () => {
  assert.equal(isKnownTool('Read'), true)
  assert.equal(isKnownTool('read'), false, '内核不接受小写，界面也不能当作有效项')
})
