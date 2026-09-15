import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, schedule } from '../kernel/workflow-dag.mjs'

// 通用执行器桩：按 node.id 返回 { ok, output, route }
function stub(map, log) {
  return async (node) => {
    log.push(node.id)
    const r = map[node.id]
    if (typeof r === 'function') return r(node)
    return r ?? { ok: true, output: node.id, dur_ms: 1 }
  }
}

const N = (id, extra = {}) => ({ id, type: 'llm', ...extra })
const E = (source, target, handle) => ({ id: `e_${source}_${target}${handle || ''}`, source, target, ...(handle ? { sourceHandle: handle } : {}) })

test('多入边 join：等待所有入边 settle 才执行一次', async () => {
  const log = []
  const nodes = [N('a'), N('b'), N('c')]
  const edges = [E('a', 'c'), E('b', 'c')]
  const r = await schedule({ nodes, edges, executeNode: stub({}, log), maxParallel: 4 })
  assert.equal(r.ok, true)
  assert.equal(log.filter((x) => x === 'c').length, 1, 'c 只执行一次')
  assert.ok(log.indexOf('c') > log.indexOf('a') && log.indexOf('c') > log.indexOf('b'), `c 应在 a/b 之后：${log}`)
})

test('并行：同批无依赖节点并发执行（maxParallel 限制）', async () => {
  let peak = 0; let cur = 0
  const nodes = [N('a'), N('b'), N('c'), N('d')]
  const edges = []
  const exec = async () => {
    cur++; peak = Math.max(peak, cur)
    await new Promise((r) => setTimeout(r, 20))
    cur--
    return { ok: true, output: 1 }
  }
  await schedule({ nodes, edges, executeNode: exec, maxParallel: 2 })
  assert.ok(peak <= 2, `并发不得超过 2，实测 ${peak}`)
  assert.equal(peak, 2, '应真正并行（而非串行）')
})

test('条件边：if 命中 true → false 分支被跳过并向下游传播跳过', async () => {
  const log = []
  const nodes = [N('g'), N('t'), N('f'), N('after')]
  const edges = [E('g', 't', 'true'), E('g', 'f', 'false'), E('f', 'after')]
  const r = await schedule({
    nodes, edges,
    executeNode: stub({ g: { ok: true, output: { pass: true }, route: 'true' } }, log),
  })
  assert.equal(r.ok, true)
  assert.ok(log.includes('t'))
  assert.equal(log.includes('f'), false, 'false 分支不执行')
  assert.equal(log.includes('after'), false, '仅依赖被跳过入边的节点也应跳过')
  assert.equal(r.settled.get('f').skipped, true)
  assert.equal(r.settled.get('after').skipped, true)
})

test('错误边：on_error=branch 失败 → 只走 fail 边；未配 fail 边则整 run 失败', async () => {
  const log = []
  const nodes = [N('x', { retry: { max: 0, on_error: 'branch' } }), N('ok'), N('bad')]
  const edges = [E('x', 'ok'), E('x', 'bad', 'fail')]
  const r = await schedule({ nodes, edges, executeNode: stub({ x: { ok: false, error: 'boom' } }, log) })
  assert.equal(r.ok, true, `有 fail 分支时不应整体失败：${r.error}`)
  assert.equal(log.includes('bad'), true)
  assert.equal(log.includes('ok'), false)

  const r2 = await schedule({ nodes, edges, executeNode: stub({ x: { ok: false, error: 'boom' } }, log) })
  assert.equal(r2.ok, true)
  const r3 = await schedule({ nodes, edges: [E('x', 'ok')], executeNode: stub({ x: { ok: false, error: 'boom' } }, log) })
  assert.equal(r3.ok, false)
  assert.equal(r3.node, 'x')
})

test('classify default 语义：命中 route:i 时 default 不得同时激活；未命中才走 default', async () => {
  const log = []
  const nodes = [N('c'), N('a'), N('b'), N('d')]
  const edges = [E('c', 'a', 'route:0'), E('c', 'b', 'route:1'), E('c', 'd', 'default')]

  const hit = await schedule({ nodes, edges, executeNode: stub({ c: { ok: true, route: 'route:0' } }, log) })
  assert.equal(hit.ok, true)
  assert.ok(log.includes('a'), '命中 route:0 应走 a')
  assert.equal(log.includes('b'), false, 'b 应被跳过')
  assert.equal(log.includes('d'), false, 'default 分支不得在命中 route:0 时同时激活')

  const miss = await schedule({ nodes, edges, executeNode: stub({ c: { ok: true, route: 'route:9' } }, log) })
  assert.equal(miss.ok, true)
  assert.ok(log.includes('d'), '未命中任何条件 handle 时才走 default')
})

test('retry：失败重试 max 次后成功；耗尽仍失败则按 on_error 收尾', async () => {
  let calls = 0
  const nodes = [N('r', { retry: { max: 2, delay_ms: 1 } })]
  const r = await schedule({
    nodes, edges: [],
    executeNode: async () => { calls++; return calls < 3 ? { ok: false, error: 'e' } : { ok: true, output: 'done' } },
  })
  assert.equal(calls, 3, `应尝试 3 次（1 初始 + 2 重试），实测 ${calls}`)
  assert.equal(r.settled.get('r').output, 'done')
})

test('skip 传播后仍可达的节点照常执行；signal 取消立即停止', async () => {
  const log = []
  const nodes = [N('g'), N('f'), N('t'), N('after')]
  const edges = [E('g', 'f', 'true'), E('g', 't', 'false'), E('t', 'after'), E('f', 'after')]
  const r = await schedule({
    nodes, edges,
    executeNode: stub({ g: { ok: true, route: 'false' } }, log),
  })
  assert.equal(r.ok, true)
  assert.ok(log.includes('after'), `after 有一条 active 入边（t→after），应执行：${log}`)

  const signal = { aborted: false }
  const p = schedule({
    nodes: [N('long')],
    edges: [],
    signal,
    executeNode: async () => { signal.aborted = true; return { ok: true, output: 1 } },
  })
  const r2 = await p
  assert.equal(r2.status, 'cancelled')
})

// ---------- 返工轮 1 补充守卫：重复边 id / maxParallel 归一化 / 批内取消落账 / continue 语义 / 死锁 ----------

test('重复边 id：buildGraph fail-fast，不静默串台（活跃分支丢失/提前就绪）', async () => {
  const nodes = [N('a'), N('q'), N('b')]
  const edges = [
    { id: 'dup', source: 'a', target: 'b' },
    { id: 'dup', source: 'q', target: 'b' },
  ]
  assert.throws(() => buildGraph(nodes, edges), /重复的边 id: dup/)
  // schedule 也不得静默跑出"b 被跳过但 run 仍 completed"的结果
  await assert.rejects(
    schedule({ nodes, edges, executeNode: stub({}, []) }),
    /重复的边 id: dup/,
  )
})

test('死锁：成环图 → status failed（不得静默 ok:true completed）', async () => {
  const log = []
  const nodes = [N('x'), N('y')]
  const edges = [E('x', 'y'), E('y', 'x')]
  const r = await schedule({ nodes, edges, executeNode: stub({}, log) })
  assert.equal(r.ok, false)
  assert.equal(r.status, 'failed')
  assert.match(r.error, /死锁/)
  assert.equal(log.length, 0, `死锁图不得执行任何节点：${log}`)
})

test('批内取消：整批先落账再返回 cancelled（同批已执行节点有记录、未启动节点不执行）', async () => {
  const log = []
  const signal = { aborted: false }
  const nodes = [N('y'), N('x'), N('later')]
  const edges = [E('y', 'later')]          // later 依赖 y，只能落到下一批
  const r = await schedule({
    nodes, edges, signal, maxParallel: 2,
    executeNode: async (node) => {
      log.push(node.id)
      if (node.id === 'y') await new Promise((res) => setTimeout(res, 30))   // 慢节点在 x 之后完成
      if (node.id === 'x') signal.aborted = true
      return { ok: true, output: node.id }
    },
  })
  assert.equal(r.status, 'cancelled')
  assert.equal(r.ok, false)
  assert.deepEqual(log, ['y', 'x'], `实际启动的节点：${log}`)
  assert.equal(r.settled.get('y')?.output, 'y', '同批已执行节点必须落账（先落账再判取消）')
  assert.equal(r.settled.get('x')?.output, 'x', '同批已执行节点必须落账（先落账再判取消）')
  assert.equal(r.settled.has('later'), false, '未启动节点不得出现在 settled')
})

test("on_error:'continue'：失败不终止 run 且下游照常执行；未知取值按硬失败处理", async () => {
  const log = []
  const nodes = [N('x', { retry: { max: 0, on_error: 'continue' } }), N('y'), N('z')]
  const edges = [E('x', 'y'), E('x', 'z')]
  const r = await schedule({ nodes, edges, executeNode: stub({ x: { ok: false, error: 'boom' } }, log) })
  assert.equal(r.status, 'completed')
  assert.equal(r.ok, true, 'continue 不得终止 run')
  assert.equal(r.settled.get('x').ok, false, '失败必须如实记录 ok:false')
  assert.equal(r.settled.get('x').error, 'boom')
  assert.ok(log.includes('y') && log.includes('z'), `continue 的下游应照常执行：${log}`)
  assert.equal(r.settled.get('y').output, 'y')

  const log2 = []
  const nodes2 = [N('x', { retry: { max: 0, on_error: 'weird' } }), N('y')]
  const r2 = await schedule({ nodes: nodes2, edges: [E('x', 'y')], executeNode: stub({ x: { ok: false, error: 'boom' } }, log2) })
  assert.equal(r2.ok, false, '未知 on_error 必须按默认 fail（硬失败）')
  assert.equal(r2.status, 'failed')
  assert.equal(r2.node, 'x')
  assert.equal(log2.includes('y'), false, '硬失败后下游不得执行')
})

test('maxParallel 归一化：0 / NaN / 负数 / 小数都不得空转挂死', async () => {
  for (const mp of [0, NaN, -1, 2.7]) {
    const log = []
    const r = await schedule({
      nodes: [N('a'), N('b'), N('c')],
      edges: [E('a', 'c'), E('b', 'c')],
      executeNode: stub({}, log),
      maxParallel: mp,
    })
    assert.equal(r.status, 'completed', `maxParallel=${mp} 应正常完成`)
    assert.deepEqual([...r.settled.keys()].sort(), ['a', 'b', 'c'], `maxParallel=${mp} 实测：${log}`)
  }
})
