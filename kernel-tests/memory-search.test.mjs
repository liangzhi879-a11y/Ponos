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

// ── S3 §4.2：MemorySearch 转发到知识库块级检索（老签名不变）────────────────────
// 判别性用例：块级检索能命中**非条目块**（标题/正文段落），而 legacy 的 searchLocalMemory
// 只认 `- [` 开头的行。这条在改造前必然失败，是"确实换成了新实现"的证据。
test('S3：MemorySearch 能命中非条目块（正文段落），不再只认 - [ 行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-ms1s3-'))
  try {
    const personal = join(dir, 'memory', 'personal')
    mkdirSync(personal, { recursive: true })
    writeFileSync(join(personal, 'notes.md'), [
      '---', 'name: notes', 'description: 笔记', '---',
      '## 供应商对账', '每月 5 日前必须完成供应商对账，逾期会影响付款计划与账期评级。',
    ].join('\n') + '\n', 'utf-8')
    const tools = createToolRegistry({ cwd: dir, addDirs: [dir], memoryRoot: personal })
    const r = await tools.run({ name: 'MemorySearch', input: { query: '供应商对账 付款计划' } }, {})
    assert.equal(r.isError, false)
    assert.match(String(r.content), /供应商对账/, `块级检索应命中正文段落（实际：${r.content}）`)
    assert.match(String(r.content), /【经验库命中 \d+ 条/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 老格式零改动：输出头 `【经验库命中 N 条，取前 M】` + `- [主题|标签] 摘要 -- 全文（score · 文件）`
// —— 老提示词里"看到空提示就换关键词"的策略依赖这套措辞，换实现不得换措辞。
test('S3：转发后输出仍是老格式（老提示词/老会话无需重学）', async () => {
  const { dir, personal } = makeRoots()
  try {
    const tools = createToolRegistry({ cwd: dir, addDirs: [dir], memoryRoot: personal })
    const r = await tools.run({ name: 'MemorySearch', input: { query: 'PS材料 压缩', scope: 'personal' } }, {})
    assert.equal(r.isError, false)
    assert.match(String(r.content), /【经验库命中 \d+ 条，取前 \d+】/)
    assert.match(String(r.content), /- \[workflow\|PS材料\] .+ -- .+（score [\d.]+ · .+）/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 命中里的文件路径必须是**可用于 Read 的绝对路径**：legacy 给的是绝对路径（Read 白名单含
// memoryRoot），若新实现改吐 `experience/workflow.md` 这类 docId，模型拿它 Read 会直接失败。
test('S3：命中条目给出可 Read 的绝对路径（相对 docId 会让 Read 失败）', async () => {
  const { dir, personal } = makeRoots()
  try {
    const tools = createToolRegistry({ cwd: dir, addDirs: [dir], memoryRoot: personal })
    const r = await tools.run({ name: 'MemorySearch', input: { query: 'PS材料 压缩', scope: 'personal' } }, {})
    assert.ok(String(r.content).includes(join(personal, 'workflow.md')), `命中行须带绝对路径（实际：${r.content}）`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 规格 §4.2 把 scope='project' 映射到 spaces=['project-*']，但知识库里**没有** project 空间
// （见 spec §11.3 N2）：该档恒 0 命中，与现状（cli 不传 projectMemoryRoot）语义等价。
test('S3：scope=project 映射到不存在的 project-* 空间 ⇒ 恒 0 命中且不报错', async () => {
  const { dir, personal } = makeRoots()
  try {
    const tools = createToolRegistry({ cwd: dir, addDirs: [dir], memoryRoot: personal })
    const r = await tools.run({ name: 'MemorySearch', input: { query: 'PS材料', scope: 'project' } }, {})
    assert.equal(r.isError, false)
    assert.match(String(r.content), /经验库无/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
