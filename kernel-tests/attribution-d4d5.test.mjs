// S2-D4/D5 回归网：归属字段落盘（authorId + workspaceId）与 byAuthor 聚合
//   spec §6.2 D4/D5、§5.9「数据模型影响」、§10「S2 验收」、§13 决策闸门（前置 📌#4 已裁定 ⇒ 可开工）
// ---------------------------------------------------------------------------
// 改前事实：transcript / 记忆 / 工作流**均无作者**，经验作者位硬编码 `[会话]`，且全仓**无工作区概念**
// （grep `workspaceId` 命中 0）。spec §6.2 D4 的判断是：归属必须在写入时就落，**后补 = 全量数据迁移**
// ——事后无法从数据反推作者，只能迁移全部历史。
//
// 本文件的核心原则：**断言"文件里真的有"，而不是"函数算出来了"**。做法是给归属注入**非默认值**
// （env `YFW_AUTHOR_ID`/`YFW_WORKSPACE_ID`），再去读磁盘上的产物。若只断言默认值（local/personal），
// "字段真的写进去了"与"根本没写、读侧刚好也返回默认值"无法区分——那正是 D4 要防的静默缺口。
//
// 覆盖：① 三处写入点各出实据；② 幂等（重复写入不累积、不覆盖已有值）；③ 旧数据兼容（不伪造归属）；
// ④ 工作流往返不丢（GUI 编辑器 加载→序列化 不得抹掉字段）；⑤ byAuthor 分桶（含 unknown 兜底）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attributionOf, withAttribution, hasAttribution, DEFAULT_WORKSPACE_ID, LOCAL_AUTHOR_ID } from '../shared/attribution.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { collectTranscriptFiles } from '../kernel/readonly.mjs'
import { aggregateUsage } from '../kernel/stats.mjs'
import { appendMemoryEntry, readMemoryEntries } from '../kernel/memory.mjs'
import { toModel, serializeWorkflow } from '../kernel/workflow-dsl.mjs'
import { createWorkflow, readWorkflowYml, writeWorkflowYml, parseWorkflowMeta } from '../server/workflow-store.mjs'

const AUTHOR = 'alice-d4d5'
const WORKSPACE = 'ws-d4d5'

/** 用非默认归属跑一段（证明字段真落盘），结束后恢复 env */
function withTestAttribution(fn) {
  const saved = { a: process.env.YFW_AUTHOR_ID, w: process.env.YFW_WORKSPACE_ID }
  process.env.YFW_AUTHOR_ID = AUTHOR
  process.env.YFW_WORKSPACE_ID = WORKSPACE
  try { return fn() } finally {
    if (saved.a === undefined) delete process.env.YFW_AUTHOR_ID; else process.env.YFW_AUTHOR_ID = saved.a
    if (saved.w === undefined) delete process.env.YFW_WORKSPACE_ID; else process.env.YFW_WORKSPACE_ID = saved.w
  }
}

function tmp(prefix) { return mkdtempSync(join(tmpdir(), prefix)) }
function cleanup(p) {
  for (let i = 0; i < 8; i++) {
    try { rmSync(p, { recursive: true, force: true }); return } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60) }
  }
}
/** 按 memory.mjs 的 parseFrontmatter 同构解析（该函数未导出，测试侧独立实现以免依赖内部细节） */
function parseFront(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return {}
  const front = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) front[kv[1]] = kv[2]
  }
  return front
}
/** 一条带 usage 的 assistant entry（aggregateUsage 只统计 type==='assistant' 且有 usage.input_tokens） */
function assistantEntry(ts, inputTokens) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      model: 'test-model',
      usage: { input_tokens: inputTokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }
}

// ---------------------------------------------------------------------------
// ① 唯一实现：默认值 / env 覆盖 / 幂等
// ---------------------------------------------------------------------------
test('归属解析：L1 默认 local+personal，env 可覆盖，withAttribution 幂等且不覆盖已有值', () => {
  const def = attributionOf({ env: {} })
  assert.equal(def.authorId, LOCAL_AUTHOR_ID, '§6.2 D4：L1 作者恒为本人')
  assert.equal(def.workspaceId, DEFAULT_WORKSPACE_ID, '§5.9：个人工作区固定值 personal')
  const over = attributionOf({ env: { YFW_AUTHOR_ID: 'a1', YFW_WORKSPACE_ID: 'w1' } })
  assert.deepEqual(over, { authorId: 'a1', workspaceId: 'w1' })
  const blank = attributionOf({ env: { YFW_AUTHOR_ID: '   ', YFW_WORKSPACE_ID: '' } })
  assert.deepEqual(blank, { authorId: LOCAL_AUTHOR_ID, workspaceId: DEFAULT_WORKSPACE_ID }, '空白串视为未设置，不得把空值写进数据')
  assert.deepEqual(withAttribution({ x: 1 }, { env: {} }), { x: 1, authorId: LOCAL_AUTHOR_ID, workspaceId: DEFAULT_WORKSPACE_ID })
  assert.equal(withAttribution({ authorId: 'keep' }, { env: { YFW_AUTHOR_ID: 'other' } }).authorId, 'keep', '已有归属不得被覆盖')
  assert.equal(hasAttribution({ authorId: 'a', workspaceId: 'w' }), true)
  assert.equal(hasAttribution({ authorId: 'a' }), false, '缺一半也不算带齐归属')
})

// ---------------------------------------------------------------------------
// ② 会话（transcript）：meta 首行落盘实据
// ---------------------------------------------------------------------------
test('会话落盘实据：新会话 meta 首行带 authorId/workspaceId（读文件断言，非函数返回）', () => {
  const configDir = tmp('yfw-d4-sess-')
  try {
    withTestAttribution(() => {
      const store = createSessionStore({ configDir, cwd: 'C:/proj/demo', sessionId: 'sess-d4d5', maxEntries: 20 })
      const meta = JSON.parse(readFileSync(store.file, 'utf-8').split('\n')[0])
      assert.equal(meta.type, 'meta', 'meta 应为文件首行')
      assert.equal(meta.authorId, AUTHOR, '会话归属必须真的写进 meta 首行')
      assert.equal(meta.workspaceId, WORKSPACE)
      assert.equal(meta.schemaVersion, 1, '不得因新增可选字段而 bump schemaVersion（旧文件会拒绝加载）')
    })
  } finally { cleanup(configDir) }
})

// ---------------------------------------------------------------------------
// ③ 读取注入 + byAuthor：从 meta 注入到每条 entry；旧数据不伪造归属
// ---------------------------------------------------------------------------
test('byAuthor 分桶：归属经 meta 注入逐条 entry；旧 transcript 落 unknown 桶（不伪造）', () => {
  const configDir = tmp('yfw-d4-agg-')
  try {
    withTestAttribution(() => {
      const store = createSessionStore({ configDir, cwd: 'C:/proj/new', sessionId: 'sess-new', maxEntries: 20 })
      appendFileSync(store.file, JSON.stringify(assistantEntry('2026-09-16T00:00:00.000Z', 100)) + '\n')

      const oldDir = join(configDir, 'projects', 'C--proj-old')
      mkdirSync(oldDir, { recursive: true })
      writeFileSync(join(oldDir, 'sess-old.jsonl'), [
        JSON.stringify({ type: 'meta', kind: 'transcript', schemaVersion: 1, timestamp: '2026-09-15T00:00:00.000Z' }),
        JSON.stringify(assistantEntry('2026-09-15T00:00:00.000Z', 7)),
      ].join('\n') + '\n', 'utf-8')

      const entries = collectTranscriptFiles({ configDir })
      const fromNew = entries.filter((e) => e.sessionId === 'sess-new' && e.type === 'assistant')
      assert.equal(fromNew.length, 1)
      assert.equal(fromNew[0].authorId, AUTHOR, 'meta 的归属应被注入到该文件的每条 entry')
      assert.equal(fromNew[0].workspaceId, WORKSPACE)
      const fromOld = entries.filter((e) => e.sessionId === 'sess-old' && e.type === 'assistant')
      assert.equal(fromOld.length, 1, '旧格式 transcript 必须仍可加载（兼容性）')
      assert.equal(fromOld[0].authorId, undefined, '旧数据不得被伪造归属（那会掩盖待迁移的数据）')

      const agg = aggregateUsage(entries)
      assert.equal(agg.byAuthor[AUTHOR]?.input_tokens, 100, 'byAuthor 应按 D4 落盘的作者分桶')
      assert.equal(agg.byAuthor.unknown?.input_tokens, 7, '无归属的历史数据落 unknown 桶，显式可数')
      assert.equal(agg.byAuthor[LOCAL_AUTHOR_ID], undefined, '不得把无归属数据算到默认作者头上')
      assert.ok(agg.totals && agg.byModel && agg.byProject && agg.byDate, '既有聚合键必须保持存在（新增键是加法）')
      assert.equal(agg.byAuthor[AUTHOR].turns, 1, '桶结构应与 byProject 一致（含 turns）')
    })
  } finally { cleanup(configDir) }
})

test('byAuthor 纯函数：多作者分桶 + 缺归属归 unknown', () => {
  const agg = aggregateUsage([
    { ...assistantEntry('2026-09-16T00:00:00.000Z', 10), authorId: 'a' },
    { ...assistantEntry('2026-09-16T00:00:00.000Z', 20), authorId: 'b' },
    { ...assistantEntry('2026-09-16T00:00:00.000Z', 30), authorId: 'a' },
    { ...assistantEntry('2026-09-16T00:00:00.000Z', 40) },
  ])
  assert.equal(agg.byAuthor.a.input_tokens, 40)
  assert.equal(agg.byAuthor.b.input_tokens, 20)
  assert.equal(agg.byAuthor.unknown.input_tokens, 40)
  assert.equal(agg.byAuthor.a.turns, 2)
})

// ---------------------------------------------------------------------------
// ④ 记忆（经验）：frontmatter 落盘实据 + 幂等
// ---------------------------------------------------------------------------
test('记忆落盘实据：条目写入时 frontmatter 落归属；重复写入不累积、不覆盖已有值', () => {
  const root = tmp('yfw-d4-mem-')
  try {
    withTestAttribution(() => {
      const r1 = appendMemoryEntry({ root, theme: 'demo', tag: 't', summary: '摘要内容足够长以通过最小长度校验', full: '全文内容同样需要足够长以通过最小长度校验的要求' })
      assert.equal(r1.ok, true, `写入应成功（实际 ${JSON.stringify(r1)}）`)
      const p = join(root, 'demo.md')
      const text1 = readFileSync(p, 'utf-8')
      assert.match(text1, new RegExp(`^authorId: ${AUTHOR}$`, 'm'), 'frontmatter 必须真的落 authorId')
      assert.match(text1, new RegExp(`^workspaceId: ${WORKSPACE}$`, 'm'))
      const front = parseFront(text1)
      assert.equal(front.authorId, AUTHOR, '读取侧按既有键名正则即可解析（无需改读取代码）')
      assert.equal(front.workspaceId, WORKSPACE)
      assert.equal(front.name, 'demo', '既有 frontmatter 键必须保留')
      assert.equal(readMemoryEntries({ root, theme: 'demo' }).length, 1, '公开读取器应仍能读到条目')

      appendMemoryEntry({ root, theme: 'demo', tag: '', summary: '第二条摘要内容同样足够长以通过校验', full: '第二条全文内容同样足够长以通过校验的要求' })
      const text2 = readFileSync(p, 'utf-8')
      assert.equal((text2.match(/^authorId:/gm) || []).length, 1, '作者字段不得随写入累积')
      assert.equal((text2.match(/^workspaceId:/gm) || []).length, 1)

      process.env.YFW_AUTHOR_ID = 'someone-else'
      appendMemoryEntry({ root, theme: 'demo', tag: '', summary: '第三条摘要内容同样足够长以通过校验', full: '第三条全文内容同样足够长以通过校验的要求' })
      const text3 = readFileSync(p, 'utf-8')
      assert.match(text3, new RegExp(`^authorId: ${AUTHOR}$`, 'm'), '既有归属不得被后续写入覆盖')
      assert.ok(!text3.includes('someone-else'))
    })
  } finally { cleanup(root) }
})

// ---------------------------------------------------------------------------
// ⑤ 工作流：YAML 元数据落盘实据 + 往返不丢（GUI 编辑器路径）
// ---------------------------------------------------------------------------
test('工作流落盘实据：写入收口补归属；parseWorkflowMeta 暴露；幂等；往返序列化不丢字段', () => {
  const root = tmp('yfw-d4-wf-')
  try {
    withTestAttribution(() => {
      const yml = 'name: demo\nversion: "1.0"\ntriggers:\n  - type: manual\nnodes:\n  - id: n1\n    type: code\nedges: []\n'
      createWorkflow({ root, id: 'demo', yml })
      const written = readWorkflowYml({ root, id: 'demo' })
      assert.match(written, new RegExp(`^authorId: ${AUTHOR}$`, 'm'), '工作流 YAML 必须真的落 authorId')
      assert.match(written, new RegExp(`^workspaceId: ${WORKSPACE}$`, 'm'))
      const meta = parseWorkflowMeta(written)
      assert.equal(meta.authorId, AUTHOR, 'parseWorkflowMeta 应暴露归属')
      assert.equal(meta.workspaceId, WORKSPACE)
      assert.equal(meta.name, 'demo', '既有元数据解析不受影响')

      writeWorkflowYml({ root, id: 'demo', yml: written })
      const again = readWorkflowYml({ root, id: 'demo' })
      assert.equal((again.match(/^authorId:/gm) || []).length, 1, '保存不得累积归属字段')
      assert.equal((again.match(/^workspaceId:/gm) || []).length, 1)

      // 往返不丢：这一条是"静默丢字段"的守卫——若 TOP_KEYS / serializeWorkflow 未纳入这两个键，
      // GUI 编辑器"加载→序列化"一存就会把归属抹掉（比不写更糟：造成"已归属"的假象）。
      const model = toModel({ name: 'demo', version: '1.0', authorId: AUTHOR, workspaceId: WORKSPACE, nodes: [], edges: [] })
      assert.equal(model.authorId, AUTHOR, 'toModel 投影不得丢弃归属（否则编辑器保存即静默丢失）')
      assert.equal(model.workspaceId, WORKSPACE)
      const out = serializeWorkflow(model)
      assert.match(out, new RegExp(`^authorId: ${AUTHOR}$`, 'm'), '序列化必须回写归属')
      assert.match(out, new RegExp(`^workspaceId: ${WORKSPACE}$`, 'm'))

      const legacy = parseWorkflowMeta('name: old\nversion: "1.0"\ntriggers: []\nnodes: []\nedges: []\n')
      assert.equal(legacy.authorId, '', '旧工作流不得被伪造归属（缺失时按模块约定返回空串，不是默认作者）')
      assert.ok(!legacy.authorId, '空串为 falsy ⇒ 读侧可区分"从未记录"与"已归属"')
      writeWorkflowYml({ root, id: 'legacy', yml: 'name: old\nversion: "1.0"\ntriggers: []\nnodes: []\nedges: []\n' })
      assert.equal(parseWorkflowMeta(readWorkflowYml({ root, id: 'legacy' })).authorId, AUTHOR, '旧工作流再保存即自然带上归属（无需回填脚本）')
    })
  } finally { cleanup(root) }
})
