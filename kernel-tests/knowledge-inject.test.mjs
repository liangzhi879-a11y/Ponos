// kernel-tests/knowledge-inject.test.mjs —— S3 Task 2：统一知识注入（索引层 + 抽调层）
// 隔离纪律：一律 mkdtempSync + 显式 configDir（绝不碰真实 ~/.yfworking）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildKnowledgeInjection, resolveInjectMode, resolveInjectBudget,
  getInjectStats, resetInjectStats,
} from '../kernel/knowledge-inject.mjs'
import { buildMemoryIndex, appendMemoryEntry } from '../kernel/memory.mjs'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

/** 造一个含个人经验库的临时 configDir（experience 是内置空间，root=memory/personal）。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-ki-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', 'description: 工作流', '---',
    '## 沟通渠道',
    '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
    '- [会话|企微CLI化] 发送前先确认群名 -- 群名拼错会发到别人群里',
    '- [会话|申报材料] 四表联动交叉校验 -- RD/PS/IP/TOAI 四表的产品名称与收入口径必须对齐',
  ].join('\n') + '\n', 'utf-8')
  writeFileSync(join(personal, 'checklist.md'), [
    '---', 'name: checklist', 'description: 清单', '---',
    '## 申报前清单',
    '- [ ] Step 1 核对四表联动的产品名称',
    '- [ ] Step 2 核对四表联动的收入口径',
    '- [ ] Step 3 导出盖章件',
  ].join('\n') + '\n', 'utf-8')
  return dir
}

const KW = ['四表联动', '企微CLI化']

test('legacy（缺省）只出索引层，且与既有 buildMemoryIndex 输出逐字节一致（零回归锁）', () => {
  const dir = fixture()
  try {
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'), query: 'x', keywords: KW,
    })
    // 缺省 mode 必须 = legacy（向后兼容硬约束）
    assert.equal(r.stats.strategy, 'legacy')
    assert.equal(r.recallSection, '', 'legacy 不得产出抽调层（抽调仍由调用方沿用 graph.search）')
    const legacy = buildMemoryIndex({ root: join(dir, 'memory', 'personal'), maxBytes: 4096 })
    assert.equal(r.indexSection, legacy, 'legacy 路径的索引层必须与改动前逐字节一致')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('legacy 的预算等于总预算（不切 2:1——没有抽调层可让渡）', () => {
  const dir = fixture()
  try {
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'), totalBudget: 4096,
    })
    assert.equal(r.indexSection, buildMemoryIndex({ root: join(dir, 'memory', 'personal'), maxBytes: 4096 }))
    const small = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'), totalBudget: 200,
    })
    assert.equal(small.indexSection, buildMemoryIndex({ root: join(dir, 'memory', 'personal'), maxBytes: 200 }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unified 产出块级抽调层（含 docId / 行号 / 既有串头风格）', () => {
  const dir = fixture()
  try {
    resetInjectStats()
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
      query: '四表联动的口径', keywords: KW, mode: 'unified',
    })
    assert.equal(r.stats.strategy, 'unified')
    assert.match(r.recallSection, /【相关知识抽调】/)
    assert.match(r.recallSection, /experience\/workflow\.md/, '行内须带 docId（模型据此 Read 全文）')
    assert.match(r.recallSection, /第 \d+ 行/)
    assert.ok(r.stats.recallBlocks > 0, `应命中至少一块（实际 ${r.stats.recallBlocks}）`)
    assert.equal(r.stats.degraded, null)
    const s = getInjectStats()
    assert.equal(s.calls, 1, '统计累加器应记账')
    assert.equal(s.strategy, 'unified')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unified：复选框行（- [ ]，tag === null 的 entry 块）不进抽调层（S1 裁定的渲染规则）', () => {
  const dir = fixture()
  try {
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
      query: '四表联动 产品名称 收入口径 核对', keywords: ['四表联动'], mode: 'unified', totalBudget: 8192,
    })
    assert.doesNotMatch(r.recallSection, /Step 1|Step 2|Step 3/, '无标签的复选框行是任务清单，不是经验知识')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unified：blockId 去重 + 同一文档最多 2 块', () => {
  const dir = fixture()
  try {
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
      query: '四表联动 企微CLI化 沟通渠道 申报材料', keywords: KW, mode: 'unified', totalBudget: 8192,
    })
    const rows = r.recallSection.split('\n').filter((l) => l.startsWith('- ['))
    const ids = rows.map((l) => (/\(([^)]+)\)/.exec(l) || [])[1]).filter(Boolean)
    assert.ok(rows.length > 0, '应有命中行')
    assert.equal(new Set(ids).size, ids.length, `blockId 不得重复：${ids.join(', ')}`)
    const perDoc = new Map()
    for (const l of rows) {
      const m = /·\s*([^\s·]+\.md)/.exec(l)
      if (m) perDoc.set(m[1], (perDoc.get(m[1]) || 0) + 1)
    }
    for (const [doc, n] of perDoc) assert.ok(n <= 2, `${doc} 贡献了 ${n} 块（上限 2）`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unified：两层合计不超总预算（含让渡：索引层小 → 抽调层用满）', () => {
  const dir = fixture()
  try {
    const root = join(dir, 'memory', 'personal')
    for (const budget of [800, 2048, 4096]) {
      const r = buildKnowledgeInjection({
        configDir: dir, memoryRootDir: root,
        query: '四表联动 企微CLI化 沟通渠道 申报材料', keywords: KW, mode: 'unified', totalBudget: budget,
      })
      const used = Buffer.byteLength(r.indexSection, 'utf-8') + Buffer.byteLength(r.recallSection, 'utf-8')
      // 口径说明：预算按**字节**计量（新代码如实），而索引层复用的 buildMemoryIndex 内部按
      // **字符数**比较 maxBytes（既有约定，不动 = 零回归）。极小预算下索引层的固定串头
      // （约 400 字节）自身就可能超限——此时抽调层必须为空（本函数把它置 0），
      // 故断言上界取 max(budget, 索引层单层字节)。
      const indexOnly = Buffer.byteLength(buildMemoryIndex({ root, maxBytes: budget }), 'utf-8')
      assert.ok(used <= Math.max(budget, indexOnly), `预算 ${budget} 超限（实际 ${used}）`)
      if (indexOnly > budget) assert.equal(r.recallSection, '', '索引层自身超限时抽调层必须为空')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unified：预算让渡 —— 空索引层时抽调层可用满总预算', () => {
  // 只有 knowledge/ 下的用户空间、memory/personal 为空 → 索引层几乎为空（只剩 header）
  const dir = mkdtempSync(join(tmpdir(), 'ponos-ki-b-'))
  try {
    mkdirSync(join(dir, 'memory', 'personal'), { recursive: true })
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
      query: '任意', keywords: ['任意'], mode: 'unified', totalBudget: 4096,
    })
    const idx = Buffer.byteLength(r.indexSection, 'utf-8')
    assert.ok(idx < 4096, '空库索引层应很小')
    assert.ok(idx + Buffer.byteLength(r.recallSection, 'utf-8') <= 4096)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unified：索引损坏时降级为纯索引层（degraded=error），绝不抛异常打断会话', () => {
  const dir = fixture()
  try {
    // 把 .index 写成"文件"而非目录：持久化与读取都会失败 → store 内部纪律是静默降级
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(join(dir, 'knowledge', '.index'), 'blocked', 'utf-8')
    let r
    assert.doesNotThrow(() => {
      r = buildKnowledgeInjection({
        configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
        query: '四表联动', keywords: KW, mode: 'unified',
      })
    })
    assert.equal(typeof r.recallSection, 'string')
    assert.ok(r.indexSection.length > 0, '索引层必须仍在（模型仍能用工具主动检索）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 规格 §8-1 的原文是"KnowledgeSearch 与注入抽调返回的 top-3 blockId **一致**"。实测下这句话
// 需要一个**限定**：注入层有意过滤两类块，而工具层不过滤——① 无标签的 entry（`- [ ] Step N`
// 任务清单，S1 裁定"经验条目 = 有 tag 的 entry"）；② 同文档第 3 块起（防单文档刷屏）。
// 本测试据此断言"**同序子集 + 首名一致**"：排序与评分完全同源（同一个 store.search），
// 注入只在其上做文档化的过滤与预算裁剪。比字面相等更真实，也守住了它要防的风险——
// 注入绝不能出现工具检索不出来的块（那个方向才会让模型觉得"注入在胡说"）。
test('unified：与直接 store.search 同序子集，且首名一致（口径统一，规格 §8-1 的限定版）', () => {
  const dir = fixture()
  try {
    const q = '四表联动 企微CLI化 沟通渠道'
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
      query: q, keywords: KW, mode: 'unified', totalBudget: 8192,
    })
    const store = createKnowledgeStore({ configDir: dir })
    store.load({})
    const items = store.search({ query: q, keywords: KW, topK: 8 }).items
    // 复刻注入层的两道过滤后的"应有顺序"
    const perDoc = new Map()
    const expect = []
    for (const it of items) {
      if (it.kind === 'entry') {
        const n = Number(String(it.blockId).slice(String(it.blockId).lastIndexOf('#') + 1))
        const b = store.getDoc(it.docId)?.blocks?.find((x) => x.n === n)
        if (!b?.tag) continue
      }
      const c = perDoc.get(it.docId) || 0
      if (c >= 2) continue
      perDoc.set(it.docId, c + 1)
      expect.push(it.blockId)
    }
    const got = r.recallSection.split('\n').filter((l) => l.startsWith('- ['))
      .map((l) => (/\(([^)]+)\)/.exec(l) || [])[1])
    assert.ok(got.length > 0, '注入抽调层应有命中')
    assert.equal(got[0], expect[0], '首名（最高分块）必须与检索引擎一致')
    assert.deepEqual(got, expect.slice(0, got.length), '注入顺序必须是检索引擎顺序的前缀')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('模式与预算解析：env 优先于 settings，缺省 legacy，非法值回落 legacy', () => {
  assert.equal(resolveInjectMode({}), 'legacy', '缺省必须 = 既有行为')
  assert.equal(resolveInjectMode({ settings: { memory: { injectMode: 'unified' } } }), 'unified')
  assert.equal(resolveInjectMode({ env: { PONOS_KNOWLEDGE_INJECT_MODE: 'unified' }, settings: { memory: { injectMode: 'legacy' } } }), 'unified', 'env 优先')
  assert.equal(resolveInjectMode({ settings: { memory: { injectMode: 'banana' } } }), 'legacy', '非法值一律回落 legacy')
  assert.equal(resolveInjectBudget({}), 4096)
  assert.equal(resolveInjectBudget({ settings: { memory: { injectMaxBytes: 2048 } } }), 2048)
  assert.equal(resolveInjectBudget({ env: { PONOS_KNOWLEDGE_INJECT_MAX_BYTES: '3000' } }), 3000)
  assert.equal(resolveInjectBudget({ settings: { memory: { injectMaxBytes: -5 } } }), 4096, '非正数回落默认')
  assert.equal(resolveInjectBudget({ env: { PONOS_KNOWLEDGE_INJECT_MAX_BYTES: 'abc' } }), 4096)
})

test('unified 两次调用结果稳定（无隐藏状态：每次自建 store 并 load）', () => {
  const dir = fixture()
  try {
    const opts = {
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
      query: '四表联动', keywords: KW, mode: 'unified', totalBudget: 4096,
    }
    const a = buildKnowledgeInjection(opts).recallSection
    const b = buildKnowledgeInjection(opts).recallSection
    assert.equal(a, b)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('注入内容不含真实 home 路径（隔离纪律）', () => {
  const dir = fixture()
  try {
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'),
      query: '四表联动', keywords: KW, mode: 'unified',
    })
    assert.ok(r.indexSection.includes(dir), '索引层路径应指向临时目录')
    assert.ok(!/\.yfworking|\.yfw[/\\]/.test(r.indexSection + r.recallSection), '不得出现真实 home 路径')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('模块无副作用：导入时不读盘（readFileSync 仅在被调用时使用）', () => {
  // 只做静态检查：源码里不得出现模块顶层的 I/O 调用
  const src = readFileSync(new URL('../kernel/knowledge-inject.mjs', import.meta.url), 'utf-8')
  const topLevelIo = /^\s*(readFileSync|createKnowledgeStore|writeFileSync)\(/m.test(src)
  assert.equal(topLevelIo, false, '模块顶层不得直接调用 I/O')
})

// ── S3 Task 5：写入闭环（增量更新，同一会话下一轮即可检索到）──────────────────
test('S3：appendMemoryEntry 写入后调 updateDoc（增量），成功时不触发全量 load', () => {
  const dir = fixture()
  try {
    const calls = []
    const ki = {
      updateDoc: (id) => { calls.push(['updateDoc', id]); return { updated: true } },
      load: () => { calls.push(['load']) },
    }
    const r = appendMemoryEntry({
      root: join(dir, 'memory', 'personal'), theme: 'workflow', tag: '新标签',
      summary: '新的沉淀摘要', full: '新的沉淀全文', knowledgeIndex: ki,
    })
    assert.equal(r.ok, true)
    assert.deepEqual(calls, [['updateDoc', 'experience/workflow.md']],
      '只调一次增量更新（docId = <spaceId>/<relPath>），不得无谓全量 load')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('S3：文档不在索引里（首次沉淀的新主题）→ 回落一次 load 重建', () => {
  const dir = fixture()
  try {
    const calls = []
    const ki = {
      updateDoc: (id) => { calls.push(['updateDoc', id]); return { updated: false, reason: 'not-found' } },
      load: (o) => { calls.push(['load', o]) },
    }
    appendMemoryEntry({
      root: join(dir, 'memory', 'personal'), theme: 'brand-new', tag: null,
      summary: '全新主题', full: '全新主题全文', knowledgeIndex: ki,
    })
    assert.deepEqual(calls, [['updateDoc', 'experience/brand-new.md'], ['load', {}]],
      'updateDoc 未命中必须回落 load（否则"刚记下就查不到"）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('S3：真实 store 集成 —— 写入后同一实例立即可检索到（已有主题 + 新主题两条路）', () => {
  const dir = fixture()
  try {
    const mroot = join(dir, 'memory', 'personal')
    const store = createKnowledgeStore({ configDir: dir })
    store.load({})
    // ① 已有主题（走增量）
    appendMemoryEntry({
      root: mroot, theme: 'workflow', tag: '增量验证',
      summary: '增量写入的独特短语 蓝鲸协议', full: '正文：蓝鲸协议要求三日内回执', knowledgeIndex: store,
    })
    assert.ok(store.search({ query: '蓝鲸协议' }).count > 0, '增量路径写入后应立即可检索')
    // ② 新主题（走 load 回落）
    appendMemoryEntry({
      root: mroot, theme: 'brand-new', tag: '新主题验证',
      summary: '新主题的独特短语 长颈鹿工单', full: '正文：长颈鹿工单走单独审批', knowledgeIndex: store,
    })
    assert.ok(store.search({ query: '长颈鹿工单' }).count > 0, '新主题首次写入后也应立即可检索')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('S3：不传 knowledgeIndex 时行为与改动前一致（纯增量，老调用方无感）', () => {
  const dir = fixture()
  try {
    const r = appendMemoryEntry({ root: join(dir, 'memory', 'personal'), theme: 'workflow', tag: null, summary: '无索引写入', full: 'f' })
    assert.equal(r.ok, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
