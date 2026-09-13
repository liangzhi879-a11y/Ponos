// S5 Task 8：`GET /knowledge/related?id=<blockId>&limit=<N>` 的路由回归测试。
//
// 钉住四件事（spec §7.4 / §11-10）：
//   ① 照 `/knowledge/links` 的写法与防护：薄转发（参数原样进 `--knowledge related`）、
//      `callJson` 同款错误路径（内核抛错 → 500、非 JSON → 502）；
//   ② 非法 id（缺失/空白/无 '#'/缺 docId）→ 400，**不静默当空集**（blockId 写错最常见）；
//   ③ 形状合法但库中不存在 → 既有约定（200 + 空数组），不自创 404；
//   ④ 索引不可用 / `knowledgeRelateMode:'off'` 的内核表现（空集）→ 透传空集，不自造错误码；
//      返回体只含锚点摘要字段，**不含正文**（断言字段集合）。
//
// handler **直调**：注入假 callKernel，绝不起 bridge、不联网、不碰真实用户目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleKnowledgeRoute } from './knowledge-routes.mjs'

function ctx({ method = 'GET', url = '/knowledge/related', callKernel } = {}) {
  const u = new URL(`http://x${url}`)
  return {
    method, pathname: u.pathname, searchParams: u.searchParams,
    readJsonBody: async () => ({}),
    callKernel: callKernel || (async () => '[]'),
  }
}

/** 假内核：记录 argsList，按 op 应答（与 knowledge-routes.test.mjs 同款） */
function fakeKernel(responses = {}) {
  const calls = []
  const fn = async (argsList) => {
    calls.push(argsList)
    const val = responses[argsList[1]] ?? {}
    return typeof val === 'string' ? val : JSON.stringify(val)
  }
  fn.calls = calls
  return fn
}

const ANCHOR = {
  blockId: 'experience/workflow.md#1',
  docId: 'experience/workflow.md',
  title: 'workflow',
  why: { kind: 'tag', tag: '企微CLI化' },
  score: null,
}
const SUMMARY_KEYS = ['blockId', 'docId', 'score', 'title', 'why']
const RESULT = { blockId: 'experience/workflow.md#0', validate: true, limit: 8, count: 1, related: [ANCHOR] }

test('GET /knowledge/related 薄转发到内核并回传锚点（字段集合钉死、不含正文）', async () => {
  const callKernel = fakeKernel({ related: RESULT })
  const r = await handleKnowledgeRoute(ctx({ url: '/knowledge/related?id=experience%2Fworkflow.md%230', callKernel }))
  assert.equal(r.status, 200)
  assert.deepEqual(callKernel.calls[0], ['--knowledge', 'related', '--id', 'experience/workflow.md#0'])
  assert.equal(r.body.count, 1)
  assert.equal(r.body.validate, true)
  for (const x of r.body.related) {
    assert.deepEqual(Object.keys(x).sort(), SUMMARY_KEYS,
      '锚点只给 {blockId,docId,title,why,score} —— 出现正文字段就是上下文膨胀')
  }
  assert.deepEqual(r.body.related[0].why, { kind: 'tag', tag: '企微CLI化' })
})

test('limit 只在给了的时候透传（同 /knowledge/graph，不在路由层自造数字校验）', async () => {
  const a = fakeKernel({ related: RESULT })
  await handleKnowledgeRoute(ctx({ url: '/knowledge/related?id=experience%2Fworkflow.md%230&limit=3', callKernel: a }))
  assert.deepEqual(a.calls[0], ['--knowledge', 'related', '--id', 'experience/workflow.md#0', '--limit', '3'])
  const b = fakeKernel({ related: RESULT })
  await handleKnowledgeRoute(ctx({ url: '/knowledge/related?id=experience%2Fworkflow.md%230', callKernel: b }))
  assert.ok(!b.calls[0].includes('--limit'), '未给 limit 时不带该 flag（内核走缺省）')
})

test('非法 id → 400（缺失 / 空白 / docId 无 # / 缺 docId），且不调用内核', async () => {
  for (const url of ['/knowledge/related', '/knowledge/related?id=', '/knowledge/related?id=%20%20',
    '/knowledge/related?id=experience%2Fworkflow.md', '/knowledge/related?id=%230',
    '/knowledge/related?id=experience%2Fworkflow.md%23abc']) {
    const callKernel = fakeKernel({ related: RESULT })
    const r = await handleKnowledgeRoute(ctx({ url, callKernel }))
    assert.equal(r.status, 400, `${url} 应 400`)
    assert.match(String(r.body.error), /invalid id/)
    assert.equal(callKernel.calls.length, 0, '参数就不合法，别白跑一次内核进程')
  }
})

test('形状合法但库中不存在 → 200 + 空数组（对齐 links 的空集语义，不自创 404）', async () => {
  // 内核对"库中没有这块"与"这块没有锚点"都给空集（getRelated 对未知块返回 []）
  const callKernel = fakeKernel({ related: { blockId: 'experience/nope.md#9', validate: true, limit: 8, count: 0, related: [] } })
  const r = await handleKnowledgeRoute(ctx({ url: '/knowledge/related?id=experience%2Fnope.md%239', callKernel }))
  assert.equal(r.status, 200)
  assert.equal(r.body.count, 0)
  assert.deepEqual(r.body.related, [])
})

test('索引不可用 / relateMode=off（内核给空集）→ 透传空集，不升格为错误码', async () => {
  const callKernel = fakeKernel({ related: { blockId: 'experience/workflow.md#0', validate: true, limit: 8, count: 0, related: [] } })
  const r = await handleKnowledgeRoute(ctx({ url: '/knowledge/related?id=experience%2Fworkflow.md%230', callKernel }))
  assert.equal(r.status, 200, '索引不可用是既有降级路径（空集），与 links 一致——不得自造 5xx/404')
  assert.equal(r.body.count, 0)
})

test('错误路径与 links 同款：内核抛错 → 500、非 JSON → 502、POST 不冒充 405（返回 null）', async () => {
  const boom = async () => { throw new Error('kernel boom') }
  assert.equal((await handleKnowledgeRoute(ctx({ url: '/knowledge/related?id=a.md%230', callKernel: boom }))).status, 500)
  const junk = async () => 'not json at all'
  const r502 = await handleKnowledgeRoute(ctx({ url: '/knowledge/related?id=a.md%230', callKernel: junk }))
  assert.equal(r502.status, 502)
  assert.equal(await handleKnowledgeRoute(ctx({ method: 'POST', url: '/knowledge/related?id=a.md%230' })), null)
})

// —— S5 Task 9：GUI 批量口（?doc=）与图谱图层（/knowledge/graph?related=1）——

test('?doc=<docId>：薄转发为 `--knowledge related --doc`，且不与 ?id= 混用', async () => {
  const blocks = [{ blockId: 'experience/workflow.md#1', related: [ANCHOR] }]
  const callKernel = fakeKernel({ related: { docId: 'experience/workflow.md', validate: true, limit: 8, count: 1, blocks } })
  const r = await handleKnowledgeRoute(ctx({ url: '/knowledge/related?doc=experience%2Fworkflow.md', callKernel }))
  assert.equal(r.status, 200)
  assert.deepEqual(callKernel.calls[0], ['--knowledge', 'related', '--doc', 'experience/workflow.md'])
  assert.equal(r.body.count, 1)
  assert.deepEqual(r.body.blocks, blocks)

  // limit 只在给了的时候透传（同 /knowledge/graph 的既有约定）
  const a = fakeKernel({ related: { blocks: [] } })
  await handleKnowledgeRoute(ctx({ url: '/knowledge/related?doc=a.md&limit=3', callKernel: a }))
  assert.deepEqual(a.calls[0], ['--knowledge', 'related', '--doc', 'a.md', '--limit', '3'])

  // 两个参数都给时按 ?id=（既有语义优先，不静默改道到另一条口径）
  const b = fakeKernel({ related: RESULT })
  await handleKnowledgeRoute(ctx({ url: '/knowledge/related?id=experience%2Fworkflow.md%230&doc=experience%2Fworkflow.md', callKernel: b }))
  assert.deepEqual(b.calls[0], ['--knowledge', 'related', '--id', 'experience/workflow.md#0'])
})

test('?doc= 的形状校验：含 \'#\' 是 blockId（参数用错）→ 400，且不白跑一次内核进程', async () => {
  const callKernel = fakeKernel({ related: { blocks: [] } })
  const r = await handleKnowledgeRoute(ctx({ url: '/knowledge/related?doc=experience%2Fworkflow.md%230', callKernel }))
  assert.equal(r.status, 400, '把 blockId 填进 doc 会被内核当"文档不存在"吞成空数组——最贵的假阴性')
  assert.match(String(r.body.error), /invalid doc/)
  assert.equal(callKernel.calls.length, 0)

  // 两个参数都没有：错误文案要同时给出两条正确写法（不然用户不知道还能按文档问）
  const empty = await handleKnowledgeRoute(ctx({ url: '/knowledge/related', callKernel: fakeKernel({}) }))
  assert.equal(empty.status, 400)
  assert.match(String(empty.body.error), /invalid id/)
  assert.match(String(empty.body.error), /doc=/)
})

test('图谱图层：?related=1 才带 --related（逐字判 1），缺省与 falsy 写法一律不带', async () => {
  const mk = () => fakeKernel({ graph: { nodes: [{ id: 'a.md', label: 'A', spaceId: 'notes', kind: 'doc' }], edges: [] } })
  const on = mk()
  const r = await handleKnowledgeRoute(ctx({ url: '/knowledge/graph?space=notes&related=1', callKernel: on }))
  assert.equal(r.status, 200)
  assert.deepEqual(on.calls[0], ['--knowledge', 'graph', '--space', 'notes', '--related'])

  for (const u of ['/knowledge/graph?space=notes', '/knowledge/graph?space=notes&related=0',
    '/knowledge/graph?space=notes&related=false', '/knowledge/graph?space=notes&related=']) {
    const k = mk()
    await handleKnowledgeRoute(ctx({ url: u, callKernel: k }))
    assert.equal(k.calls[0].includes('--related'), false, `${u} 不得打开图层（默认关是 spec §7.5 的硬要求）`)
  }
})
