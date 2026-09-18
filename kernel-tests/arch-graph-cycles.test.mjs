// kernel-tests/arch-graph-cycles.test.mjs —— 文件级「环」的基线守卫（P2-4②）
// ---------------------------------------------------------------------------
// 为什么值得测：以前"文件级环只有 N 组"这个数字**只写在文档里**，靠人每次想起来重算。
// 于是出现了这样的漂移：`docs/architecture.html` 第 9 章写"仅 5 组"，而实测早已是 4 组
// （`tools ↔ knowledge-import` 那个环在 P2-1 第二刀中被消掉，没人回头改文档）。
// 环是**架构腐化最隐蔽的一种形态**：它不报错、不失败测试，只是让"改 A 必须懂 B、改 B 必须懂 A"
// 慢慢扩散；等有人发现时，往往已经有几十个环，且每个都很难拆。
//
// 因此本测试把「环集合」变成**声明式基线**：
//   · 引入新环 → 立刻失败（必须在 PR 里解释，或先解开）；
//   · 解开旧环 → 也失败（提示把基线更新——避免基线腐化成一句假话，正如上面那处文档漂移）。
//
// 数据来源是 `buildGraph()` **直接扫描真实源码**，而不是读已生成的 `docs/architecture-graph.html`：
// 后者会滞后（改完代码不重生成图谱时它还是旧的），而守门需要"当前的真相"。
// 运行：node --test kernel-tests/arch-graph-cycles.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph } from '../scripts/build-arch-graph.mjs'

// ── 声明式基线：当前**已被接受**的文件级环（2026-09-18 实测，475 模块 / 1273 边）
// 每条按模块 id 排序后比较；修改此表必须同时说明"为什么这个环被接受"。
const ACCEPTED_CYCLES = [
  // renderer：标题生成工具 ⇄ 两个 store（互相需要对方的当前值）——同层内互引
  ['src/lib/titleGen.ts', 'src/stores/chatStore.ts', 'src/stores/settingsStore.ts'],
  // renderer：健康度 UI 文案 ⇄ 健康度 store ——同层内互引
  ['src/lib/healthUi.ts', 'src/stores/healthStore.ts'],
  // kernel：引擎配置 ⇄ 生成期守卫（守卫需要读配置，配置的默认值又由守卫的规则决定）
  ['kernel/engine-config.mjs', 'kernel/gen-guards.mjs'],
  // kernel：压缩 ⇄ 引擎（引擎发起压缩，压缩完成后回调引擎继续）
  ['kernel/compact.mjs', 'kernel/engine.mjs'],
]

// ── Tarjan 强连通分量（迭代版，避免深递归爆栈）
function findCycles (nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id))
  const adj = new Map([...ids].map((id) => [id, []]))
  for (const e of edges) if (ids.has(e.from) && ids.has(e.to)) adj.get(e.from).push(e.to)

  let idx = 0
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const sccs = []
  for (const start of ids) {
    if (index.has(start)) continue
    const work = [[start, 0]]
    while (work.length) {
      const frame = work[work.length - 1]
      const [v, pi] = frame
      if (pi === 0) { index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onStack.add(v) }
      const outs = adj.get(v) || []
      let recursed = false
      for (let i = pi; i < outs.length; i++) {
        const w = outs[i]
        if (!index.has(w)) { frame[1] = i + 1; work.push([w, 0]); recursed = true; break }
        if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)))
      }
      if (recursed) continue
      if (low.get(v) === index.get(v)) {
        const comp = []
        for (;;) { const w = stack.pop(); onStack.delete(w); comp.push(w); if (w === v) break }
        if (comp.length > 1) sccs.push(comp.sort())
      }
      work.pop()
      if (work.length) { const p = work[work.length - 1]; low.set(p[0], Math.min(low.get(p[0]), low.get(v))) }
    }
  }
  return sccs.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
}

const key = (group) => group.join(' ↔ ')
const graph = buildGraph()
const cycles = findCycles(graph.nodes, graph.edges)
const layerOf = new Map(graph.nodes.map((n) => [n.id, n.layer]))

test('文件级环集合与声明式基线完全一致（引入新环 / 解开旧环都要显式更新基线）', () => {
  const actual = new Set(cycles.map(key))
  const expected = new Set(ACCEPTED_CYCLES.map((g) => key([...g].sort())))

  const added = [...actual].filter((k) => !expected.has(k))
  const gone = [...expected].filter((k) => !actual.has(k))

  const hint = '若为有意变更：更新本文件的 ACCEPTED_CYCLES，并说明该环为何被接受（或为何不再存在）'
  assert.deepEqual(added, [], `检测到**新增**文件级环（架构腐化）——应优先解开，而不是直接加进基线：\n  ${added.join('\n  ')}\n${hint}`)
  assert.deepEqual(gone, [], `基线里的环已不存在（多半是件好事）——请更新基线，避免它变成一句假话：\n  ${gone.join('\n  ')}\n${hint}`)
})

test('基线条目必须是"真实的环"：成员都存在、且组内每个节点都进出相连', () => {
  const ids = new Set(graph.nodes.map((n) => n.id))
  const edgeSet = new Set(graph.edges.map((e) => e.from + '\u0000' + e.to))

  for (const group of ACCEPTED_CYCLES) {
    assert.ok(group.length >= 2, `基线含 size<2 的条目：${key(group)}（那不是环）`)
    for (const m of group) assert.ok(ids.has(m), `基线成员不存在于图谱：${m}（改名后需同步基线）`)

    // 环内每个节点都必须：有出边指向组内另一成员，且有入边来自组内另一成员
    for (const m of group) {
      const outs = group.filter((o) => o !== m && edgeSet.has(m + '\u0000' + o))
      const ins = group.filter((o) => o !== m && edgeSet.has(o + '\u0000' + m))
      assert.ok(outs.length > 0, `${m} 在基线环里没有指向组内其它成员的边 —— 它其实不在这个环上`)
      assert.ok(ins.length > 0, `${m} 在基线环里没有被组内其它成员指向的边 —— 它其实不在这个环上`)
    }
  }
})

test('现有环必须都是"同层内互引"（跨层反向依赖形成的环不予接受）', () => {
  // 同层内互相引用（store ⇄ store、引擎 ⇄ 引擎的子系统）是可以容忍的：它们几乎总是一起改。
  // 跨层成环则意味着分层被打破（例如 renderer 反向依赖 kernel 又绕回来），会破坏"上层可替换"的前提。
  for (const group of cycles) {
    const layers = new Set(group.map((m) => layerOf.get(m)))
    assert.equal(layers.size, 1, `环跨越了多个分层（${[...layers].join(' / ')}）：${key(group)}\n  → 跨层环会破坏分层，应优先解开而不是加入基线`)
  }
})

test('不存在自环（模块 import 自己）', () => {
  const selfEdges = graph.edges.filter((e) => e.from === e.to)
  assert.deepEqual(selfEdges.map((e) => e.from), [], '存在自环边（from === to）')
})

test('图的规模与执行前提（防止 buildGraph 静默返回空图而让本守卫变成"永远通过"）', () => {
  // 这是关键的自检：若扫描因环境问题（git 不可用、目录改名）返回空/极小图，
  // 上面的"无新环"会**假通过**——守卫必须在数据不足时明确失败，而不是默默放过。
  assert.ok(graph.nodes.length > 300, `只扫描到 ${graph.nodes.length} 个模块 —— 疑似扫描失败，守卫不可依赖`)
  assert.ok(graph.edges.length > 500, `只扫描到 ${graph.edges.length} 条边 —— 疑似解析失败，守卫不可依赖`)
  assert.ok(graph.nodes.every((n) => typeof n.layer === 'string' && n.layer), '存在没有分层的节点')
})
