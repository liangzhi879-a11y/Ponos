// src/stores/knowledgeStore.test.ts
// 运行：node --test src/stores/knowledgeStore.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
//
// 假 localStorage 必须在 import store **之前**装好：zustand 的 createJSONStorage 在模块求值
// 时就调 getStorage() 并把结果捕获下来（middleware.js:281-286），晚装等于没装。
// 照 src/stores/uiStore.test.ts:12-24 的写法。
//
// 末条用例顺带测 merge 的真实路径：**先**把一份"损坏 + 含展开态"的负载塞进盘里再 import，
// hydrate 时 merge 才会被调用（时序与真实冷启动一致，不靠直接调 merge 造场景）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const mem = new Map<string, string>()
const writes: string[] = []
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { writes.push(v); mem.set(k, v) },
  removeItem: (k: string) => { mem.delete(k) },
}

const KEY = 'yfworking-knowledge'
// 损坏负载：spaceId 是数字、view 非法、tree 是数组（旧版/手改/跨版本残留的形状）
mem.set(KEY, JSON.stringify({
  state: { spaceId: 42, view: 'timeline', tree: [{ expanded: true }] },
  version: 0,
}))

const { useKnowledgeStore, sanitizeView, sanitizeTree, toPersistedTree, KNOWLEDGE_VIEWS } =
  await import('./knowledgeStore.ts')
await new Promise((r) => setImmediate(r))   // 等 persist 水合落定

const st = () => useKnowledgeStore.getState()

test('merge：损坏的落盘负载被白名单清洗（不抛），view/spaceId/tree 全部兜底', () => {
  assert.equal(st().view, 'read', '非法 view 必须兜底 read')
  assert.equal(st().spaceId, null, '非法 spaceId 必须兜底 null')
  assert.deepEqual(st().tree, {}, '损坏 tree 必须兜底 {}')
})

test('merge（有效负载路径）：恢复 spaceId/view 与展开态，折叠分支丢弃，actions 保留', () => {
  // 上一条只覆盖"损坏负载"；这里直接调 persist 的 merge，钉住"合法负载能恢复展开态"
  // —— 那才是持久化的目的（重启后展开的目录自动重取）。
  const opts = useKnowledgeStore.persist.getOptions()
  const merged = opts.merge!(
    {
      spaceId: 'notes',
      view: 'graph',
      tree: {
        'notes/a': { entries: [], loaded: false, expanded: true },
        'notes/b': { entries: [], loaded: false, expanded: false },
      },
    },
    st(),
  )
  assert.equal(merged.spaceId, 'notes')
  assert.equal(merged.view, 'graph')
  assert.deepEqual(merged.tree, { 'notes/a': { entries: [], loaded: false, expanded: true } })
  assert.equal(typeof merged.setSpace, 'function', 'merge 必须保留 actions')
  assert.equal(typeof merged.toggleExpanded, 'function')
})

test('sanitizeView：4 合法值原样透传，其余（含缺省/数字/null）兜底 read', () => {
  for (const v of KNOWLEDGE_VIEWS) assert.equal(sanitizeView(v), v)
  assert.deepEqual([...KNOWLEDGE_VIEWS], ['read', 'edit', 'graph', 'search'], '四视图集合固定')
  assert.equal(sanitizeView('edit2'), 'read')
  assert.equal(sanitizeView(undefined), 'read')
  assert.equal(sanitizeView(null), 'read')
  assert.equal(sanitizeView(2), 'read')
  assert.equal(sanitizeView({ view: 'edit' }), 'read')
})

test('sanitizeTree：非对象/数组/null/字符串一律兜底 {}，且绝不抛', () => {
  for (const bad of [null, undefined, 'x', 42, true, [], ['a/b'], () => {}]) {
    assert.deepEqual(sanitizeTree(bad), {}, `sanitizeTree(${String(bad)}) 应为 {}`)
  }
  // 纯对象但值形态不对（字符串/数组/null）→ 整键丢弃
  assert.deepEqual(sanitizeTree({ 'a/b': true, 'c/d': 'yes', 'e/f': [], 'g/h': null }), {})
})

test('sanitizeTree：只保留展开态，entries 与 loaded 一律重置（易失数据不复活）', () => {
  const got = sanitizeTree({
    'notes/a': { entries: [{ name: 'x.md', path: 'notes/a/x.md', type: 'file' }], loaded: true, expanded: true },
    'notes/b': { entries: [], loaded: true, expanded: false },
  })
  assert.deepEqual(got, { 'notes/a': { entries: [], loaded: false, expanded: true } })
})

test('toPersistedTree：折叠分支不落盘，展开分支只留骨架', () => {
  const got = toPersistedTree({
    'a': { entries: [{ name: 'x.md', path: 'a/x.md', type: 'file' }], loaded: true, expanded: true },
    'b': { entries: [{ name: 'y.md', path: 'b/y.md', type: 'file' }], loaded: true, expanded: false },
  })
  assert.deepEqual(got, { a: { entries: [], loaded: false, expanded: true } })
})

test('toggleExpanded：不存在的路径**创建**节点（expanded=true, entries=[]、loaded=false）', () => {
  // 语义与冷启动 merge 恢复的形态一致：树组件据 `expanded && !loaded` 去拉取
  assert.equal(st().tree['notes'], undefined)
  st().toggleExpanded('notes')
  assert.deepEqual(st().tree['notes'], { entries: [], loaded: false, expanded: true })
})

test('toggleExpanded：已存在节点翻转展开态，再次翻转回原态；空路径忽略', () => {
  st().toggleExpanded('notes')
  assert.equal(st().tree['notes'].expanded, false)
  st().toggleExpanded('notes')
  assert.equal(st().tree['notes'].expanded, true)
  const before = st().tree
  st().toggleExpanded('')
  assert.equal(st().tree, before, '空路径必须空操作（不换引用）')
})

test('setTreeEntries：写入 entries 并置 loaded=true', () => {
  const entries = [{ name: 'a.md', path: 'notes/a.md', type: 'file' as const, docId: 'notes/notes/a.md' }]
  st().setTreeEntries('notes/a', entries)
  assert.deepEqual(st().tree['notes/a'], { entries, loaded: true, expanded: true })
})

test('setTreeEntries：不覆盖已有展开态（拉取落定不该顶开用户已折叠的分支）', () => {
  st().toggleExpanded('notes/b')          // 创建（展开）
  st().toggleExpanded('notes/b')          // 用户折叠
  st().setTreeEntries('notes/b', [{ name: 'b.md', path: 'notes/b.md', type: 'file' }])
  assert.equal(st().tree['notes/b'].expanded, false, '折叠态必须保留')
  assert.equal(st().tree['notes/b'].loaded, true)
  assert.equal(st().tree['notes/b'].entries.length, 1)
})

test('setSpace：切空间清空 tree（路径是空间内相对路径，跨空间复用会指错文档）', () => {
  st().setTreeEntries('root', [{ name: 'r.md', path: 'r.md', type: 'file' }])
  st().setSpace('experience')
  assert.equal(st().spaceId, 'experience')
  assert.deepEqual(st().tree, {}, '切空间必须清树')
  const before = st()
  st().setSpace('experience')
  assert.equal(st(), before, '同值切换必须空操作（不换引用）')
  st().setSpace(null)
  assert.equal(st().spaceId, null)
})

test('persist 负载：只落 spaceId/view/展开态，树里的 entries 不进盘', () => {
  writes.length = 0
  st().setView('graph')
  const payload = JSON.parse(writes[writes.length - 1]) as { state: Record<string, unknown> }
  assert.equal(payload.state.view, 'graph', 'view 必须落盘（重启回到上次视图）')
  assert.equal(payload.state.spaceId, null)
  const tree = payload.state.tree as Record<string, { entries: unknown[]; loaded: boolean }>
  for (const [path, node] of Object.entries(tree)) {
    assert.deepEqual(node.entries, [], `${path} 的 entries 不得落盘（易失数据）`)
    assert.equal(node.loaded, false, `${path} 的 loaded 必须重置为 false（重启后重取）`)
  }
  // 上一条用例的 setSpace 已清树 ⇒ 此处落盘只有空 tree（展开态才占位，折叠分支不落盘）
  assert.deepEqual(tree, {})
})
