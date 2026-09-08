// MS1 searchLocalMemory：命中排序 / scope 过滤 / 空结果 / 工具注册冒烟。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchLocalMemory } from '../kernel/memory-search.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { memoryRoot } from '../kernel/memory.mjs'

function makeRoots() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-ms1-'))
  const personal = join(dir, 'memory', 'personal')
  const project = join(dir, 'memory', 'project')
  mkdirSync(personal, { recursive: true })
  mkdirSync(project, { recursive: true })
  const w = (root, file, body) => writeFileSync(join(root, file), body)
  w(personal, 'workflow.md', [
    '---',
    'name: workflow',
    'description: 工作流',
    '---',
    '- [会话|PS材料] PS材料整理 -- 材料压缩：先合并再压缩，注意尺寸上限',
    '- [会话] 无关经验 -- 与检索目标无关的内容',
  ].join('\n') + '\n')
  w(project, 'proj.md', '- [会话|成果转化] 成果转化材料 -- 四表联动核对步骤\n')
  return { dir, personal, project }
}

test('命中排序 + topK 截断 + 输出条目字段', () => {
  const { dir, personal, project } = makeRoots()
  try {
    const r = searchLocalMemory({ personalRoot: personal, projectRoot: project, query: 'PS材料 压缩', topK: 5 })
    assert.ok(r.items.length >= 1)
    const top = r.items[0]
    assert.ok(['theme', 'tag', 'summary', 'full', 'file', 'score'].every((k) => k in top))
    assert.equal(top.tag, 'PS材料')
    assert.ok(top.score > 0)
    assert.ok(r.items.every((a, i, arr) => i === 0 || arr[i - 1].score >= a.score), 'score 降序')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('scope 过滤：project 只查项目库；personal 只查个人库；all 合并', () => {
  const { dir, personal, project } = makeRoots()
  try {
    const q = '材料'
    assert.ok(searchLocalMemory({ personalRoot: personal, projectRoot: project, query: q, scope: 'project' }).items.length >= 1)
    const personalHit = searchLocalMemory({ personalRoot: personal, projectRoot: project, query: q, scope: 'personal' })
    assert.ok(personalHit.items.length >= 1)
    const allHit = searchLocalMemory({ personalRoot: personal, projectRoot: project, query: q, scope: 'all' })
    assert.ok(allHit.count >= personalHit.count)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('空结果：无匹配 → items 空；空 query → 空', () => {
  const { dir, personal, project } = makeRoots()
  try {
    assert.equal(searchLocalMemory({ personalRoot: personal, projectRoot: project, query: 'zzz不存在的词', topK: 3 }).items.length, 0)
    assert.equal(searchLocalMemory({ personalRoot: personal, projectRoot: project, query: '' }).items.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('工具注册：MemorySearch 进 toolNames/toolSchemas，执行无命中返回明确空提示', async () => {
  const { dir, personal } = makeRoots()
  try {
    const tools = createToolRegistry({ cwd: dir, addDirs: [dir], memoryRoot: personal })
    assert.ok(tools.toolNames.includes('MemorySearch'))
    const schema = tools.toolSchemas().find((t) => t.name === 'MemorySearch')
    assert.equal(schema.input_schema.required[0], 'query')
    const r = await tools.run({ name: 'MemorySearch', input: { query: 'zzz不存在的词' } }, {})
    assert.equal(r.isError, false)
    assert.match(String(r.content), /经验库无/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
