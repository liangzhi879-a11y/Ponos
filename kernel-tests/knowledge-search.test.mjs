// KnowledgeSearch 工具测试：只读检索，走临时 configDir 隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchKnowledge } from '../kernel/knowledge-search.mjs'
import { CHAT_MODE_DISALLOWED, createToolRegistry } from '../kernel/tools.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-ks-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', '---',
    '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
    '- [会话|申报材料] 四表联动交叉校验 -- RD/PS/IP/TOAI 四表的产品名称与收入口径必须对齐',
  ].join('\n') + '\n', 'utf-8')
  return dir
}

test('searchKnowledge 返回可读条目清单（含来源与行号）', () => {
  const dir = fixture()
  try {
    const r = searchKnowledge({ configDir: dir, query: '四表联动', keywords: ['申报材料'] })
    assert.equal(r.isError, false)
    assert.match(r.content, /四表联动交叉校验/)
    assert.match(r.content, /experience\/workflow\.md/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('searchKnowledge 无命中给出明确提示而非报错', () => {
  const dir = fixture()
  try {
    const r = searchKnowledge({ configDir: dir, query: 'zzzzz', keywords: ['zzzzz'] })
    assert.equal(r.isError, false)
    assert.match(r.content, /无.*命中|未命中/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('searchKnowledge 空 query 返回 isError', () => {
  const dir = fixture()
  try {
    const r = searchKnowledge({ configDir: dir, query: '' })
    assert.equal(r.isError, true)
    assert.match(r.content, /query/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 隔离纪律：不存在路径一律落在 tmpdir 内（绝不用 /definitely/not/here 这类绝对路径去
// 真实盘符根建目录），测后清理。
test('searchKnowledge 索引不可用时不抛异常（降级为无命中）', () => {
  const dir = join(tmpdir(), `ponos-ks-absent-${process.pid}-${Date.now()}`)
  try {
    const r = searchKnowledge({ configDir: dir, query: '任意' })
    assert.equal(r.isError, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// S3 D2（**有意的语义变更**）：chat 模式放行 KnowledgeSearch。S1 阶段它与 MemorySearch 同列
// 禁用表；放行理由是"只读、不写盘、不执行、不出网"——chat 隔离要防的是本地执行/写盘能力
// 泄漏，只读检索不构成该风险。MemorySearch **保持禁用**（O(N) 全量扫描，chat 无收益），
// 故本条同时锁住"放行只针对这一项"。
test('S3：KnowledgeSearch 已出 chat 禁用表，MemorySearch 仍在表内（放行只针对知识检索）', () => {
  assert.ok(!CHAT_MODE_DISALLOWED.includes('KnowledgeSearch'), 'D2 决策：chat 放行 KnowledgeSearch')
  assert.ok(CHAT_MODE_DISALLOWED.includes('MemorySearch'), 'MemorySearch 不在 D2 范围内，保持禁用')
})

// 假放行排查：工具在表内 ≠ 真能用。KnowledgeSearch 的 configDir 由 memoryRoot 上溯两级推导，
// 若 chat 路径不传 memoryRoot，工具会恒回"检索不可用"——那等于放行了也白放。
// 实测 kernel/cli.mjs:487 的 memoryRoot 是**无条件**传的（不随 chat 收窄），此条把它锁住。
test('S3：chat 会话的 KnowledgeSearch 真的可用（非"放行但无 configDir"的假放行）', async () => {
  const dir = fixture()
  try {
    const tools = createToolRegistry({
      cwd: dir, addDirs: [], skipPermissions: true,
      disallowedTools: CHAT_MODE_DISALLOWED,      // 复刻 chat 会话的注册参数
      memoryRoot: join(dir, 'memory', 'personal'), // 复刻 kernel/cli.mjs:487 的无条件传参
    })
    assert.ok(tools.toolNames.includes('KnowledgeSearch'), 'chat 工具表应含 KnowledgeSearch')
    const r = await tools.run({ name: 'KnowledgeSearch', input: { query: '四表联动', topK: 3 } }, {})
    assert.equal(r.isError, false)
    assert.match(r.content, /四表联动交叉校验/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 注册表接线（锁 configDir 的推导：memoryRoot = <configDir>/memory/personal）───
// 这是本任务最容易静默错的一环：推导少一级会指向 <configDir>/memory（空空间清单），
// 多一级会指向 <configDir> 的父目录（读到别人的知识库）。故直接经 registry.run 断言。
test('注册表：经 tools.run 调用时 configDir 推导正确（能命中临时 configDir 下的条目）', async () => {
  const dir = fixture()
  try {
    const tools = createToolRegistry({
      cwd: dir, addDirs: [], skipPermissions: true, memoryRoot: join(dir, 'memory', 'personal'),
    })
    assert.ok(tools.toolNames.includes('KnowledgeSearch'))
    const r = await tools.run({ name: 'KnowledgeSearch', input: { query: '四表联动', topK: 3 } }, {})
    assert.equal(r.isError, false)
    assert.match(r.content, /四表联动交叉校验/)
    assert.match(r.content, /experience\/workflow\.md/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('注册表：未传 memoryRoot 时不猜路径（不写 cwd，降级且不报错）', async () => {
  const tools = createToolRegistry({ cwd: tmpdir(), addDirs: [], skipPermissions: true })
  const r = await tools.run({ name: 'KnowledgeSearch', input: { query: '任意' } }, {})
  assert.equal(r.isError, false)
  assert.match(r.content, /不可用/)
})
