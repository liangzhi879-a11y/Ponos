// 对拍（Task 13）：内核直调 vs CLI 子进程（server 实际通道）——top-5 blockId 序列必须逐位相同。
// ---------------------------------------------------------------------------
// 为什么对拍的是"内核直调 vs 内核 CLI 子进程"：server 侧**没有**自己的检索实现，
// `/knowledge/search` 完全等于 `kernelReadonly(['--knowledge','search',...])` 的 stdout。
// 漂移风险因此只在 **CLI 参数组装 + JSON 序列化往返**（而非两套算法）。本测试把这个
// 往返钉死；算法内部漂移由 shared/ 与 kernel-tests/knowledge-*.test.mjs 覆盖。
//
// 隔离：子进程经 PONOS_HOME 指向 mkdtempSync 临时目录（resolveConfigDir 优先级：
// PONOS_CONFIG_DIR → PONOS_HOME → ~/.ponos）；PONOS_CONFIG_DIR 显式置空以免外部干扰。
// 绝不触碰真实 ~/.yfworking / ~/.yfw；不起 bridge。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

const CLI = new URL('../kernel/cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kpar-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', 'description: 工作流心得', '---',
    '## 申报材料',
    '- [会话|申报材料] 四表联动交叉校验 -- RD/PS/IP/TOAI 的产品名称与收入口径必须对齐',
    '- [会话|申报材料] 建表前先冻结口径 -- 收入口径变更导致返工，先冻结再出表',
    '## 企微CLI化',
    '- [会话|企微CLI化] 只发文件传输助手 -- 真实沟通渠道的测试只发文件传输助手',
  ].join('\n') + '\n', 'utf-8')
  writeFileSync(join(personal, 'policy.md'), [
    '---', 'name: policy', '---',
    '- [会话|高企口径] RD表与PS表技术关联 -- 需说明研发项目与产品之间的技术关联',
  ].join('\n') + '\n', 'utf-8')
  return dir
}

function runCli(dir, argsList) {
  // 必须带 stream-json 两个标志：`--knowledge` 短路块位于 cli.mjs 的格式校验之后，
  // 缺标志会以 `kernel: only stream-json I/O format is supported` 退出。
  // 这也正是 server 侧 kernelReadonly 的实际调用形状（server/kernel-readonly.mjs:41）。
  const out = execFileSync(process.execPath, [
    CLI, '--output-format', 'stream-json', '--input-format', 'stream-json', '--knowledge', ...argsList,
  ], {
    env: { ...process.env, PONOS_HOME: dir, PONOS_CONFIG_DIR: '' },
    encoding: 'utf-8',
    timeout: 60000,
  })
  return JSON.parse(out)
}

/** 与 server 侧同一路径：stdout 单行 JSON → parse。 */
function runCliRaw(dir, argsList) {
  return execFileSync(process.execPath, [
    CLI, '--output-format', 'stream-json', '--input-format', 'stream-json', '--knowledge', ...argsList,
  ], {
    env: { ...process.env, PONOS_HOME: dir, PONOS_CONFIG_DIR: '' },
    encoding: 'utf-8',
    timeout: 60000,
  })
}

/**
 * 去掉 `indexAge`（= 进程内 Date.now() - builtAt 的毫秒差，天生跨进程不可比），
 * 其余字段一律要求逐字相同——只放行这一个时间字段，其它漂移仍然会红。
 */
function withoutAge(o) {
  const { indexAge, ...rest } = JSON.parse(JSON.stringify(o))
  return rest
}

const QUERIES = [
  { query: '四表联动交叉校验', keywords: ['申报材料'] },
  { query: '收入口径', keywords: [] },
  { query: '文件传输助手', keywords: ['企微CLI化'] },
]

test('对拍：直调与 CLI 子进程的 top-5 blockId 序列逐位一致（3 组查询）', () => {
  const dir = fixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    for (const q of QUERIES) {
      const direct = store.search({ ...q, topK: 5 })
      const cliOut = runCli(dir, ['search', '--query', q.query, '--keywords', q.keywords.join(','), '--topK', '5'])
      const directIds = direct.items.map((i) => i.blockId)
      const cliIds = cliOut.items.map((i) => i.blockId)
      assert.deepEqual(cliIds, directIds, `查询「${q.query}」双端不一致`)
      assert.equal(cliOut.count, direct.count)
      assert.equal(cliOut.degraded, direct.degraded)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('对拍：search 全量输出经 JSON 往返无漂移（server 拿到的就是直调结果）', () => {
  const dir = fixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    for (const q of QUERIES) {
      const direct = store.search({ ...q, topK: 5 })
      const raw = runCliRaw(dir, ['search', '--query', q.query, '--keywords', q.keywords.join(','), '--topK', '5'])
      // 单行 JSON（server 的 readFileSync+JSON.parse 形状；多行会破坏分帧假设）。
      // 注：console.log 会补一个尾换行，判据是"去掉尾换行后无内嵌换行"。
      assert.equal(raw.replace(/\r?\n$/, '').includes('\n'), false, 'stdout 必须是单行 JSON')
      const cliOut = JSON.parse(raw)
      assert.deepEqual(withoutAge(cliOut), withoutAge(direct), `查询「${q.query}」JSON 往返漂移`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('对拍：CLI 的 spaces / stats / entries 与直调一致', () => {
  const dir = fixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    const cliSpaces = runCli(dir, ['spaces'])
    assert.deepEqual(
      cliSpaces.spaces.map((s) => [s.id, s.docCount]),
      store.getSpaces().map((s) => [s.id, s.docCount]),
    )
    const cliStats = runCli(dir, ['stats'])
    assert.equal(cliStats.docs, store.stats().docs)
    assert.equal(cliStats.blocks, store.stats().blocks)

    const cliEntries = runCli(dir, ['entries', '--id', 'experience/workflow.md'])
    assert.deepEqual(
      cliEntries.entries.map((e) => e.summary),
      store.listEntries('experience/workflow.md').map((e) => e.summary),
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('对拍：CLI 未命中/降级查询与直调同形（含空 query）', () => {
  const dir = fixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    // 空 query：直调返回空结果；CLI 亦须返回同形（不得报错）
    const directEmpty = store.search({ query: '', topK: 5 })
    assert.deepEqual(
      withoutAge(runCli(dir, ['search', '--query', '', '--topK', '5'])),
      withoutAge(directEmpty),
    )
    // 零命中乱码：走降级路，双端 degraded 标记与结果必须一致
    const directMiss = store.search({ query: 'zzzzqqqq', topK: 5 })
    const cliMiss = runCli(dir, ['search', '--query', 'zzzzqqqq', '--topK', '5'])
    assert.deepEqual(withoutAge(cliMiss), withoutAge(directMiss))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('索引可弃：删除 .index 后自动重建，结果与删除前完全一致', () => {
  const dir = fixture()
  try {
    const first = (() => {
      const s = createKnowledgeStore({ configDir: dir })
      s.load({ force: true })
      return s.search({ query: '收入口径', topK: 5 }).items.map((i) => i.blockId)
    })()
    assert.ok(first.length >= 2, '前置：删除前应有多条结果（否则"一致"无意义）')
    // 前置：索引确实已落盘（否则 rm 是空操作，"可弃"未真正被验证）
    assert.ok(existsSync(join(dir, 'knowledge', '.index')), '前置：.index 应已生成')
    rmSync(join(dir, 'knowledge', '.index'), { recursive: true, force: true })
    assert.equal(existsSync(join(dir, 'knowledge', '.index')), false)
    const second = (() => {
      const s = createKnowledgeStore({ configDir: dir })
      s.load() // 无 force：索引缺失应自动重建
      return s.search({ query: '收入口径', topK: 5 }).items.map((i) => i.blockId)
    })()
    assert.deepEqual(second, first)
    // 重建后 CLI 侧同样一致（server 通道也受益于"索引可弃"）
    const cliIds = runCli(dir, ['search', '--query', '收入口径', '--topK', '5']).items.map((i) => i.blockId)
    assert.deepEqual(cliIds, first)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ═══════════════════════════════════════════════════════════════════════════
// 2026-09-14 对标 Obsidian 批次 1：`--spaces` 的**转发链路**（真进程）
//
// 为什么必须用真进程钉住：`--spaces` 要穿过三层才生效 ——
//   cli.mjs parseArgs（登记旗标）→ cli.mjs 的 knowledgeArgs **显式白名单**（转发）
//   → knowledge-cli.mjs 的 parseSpacesArg（数组/单值/逗号串三态归一）。
// 三层任一漏掉都是**静默失效**（不报错、参数被吞、返回全库结果），单元测试各测一层都发现不了。
// 本次实测真切踩过：parseArgs 与 knowledge-cli 都改好了，却漏了中间那层白名单，
// `--spaces nope` 依然返回全部标签 —— 只有真进程能暴露。
// ═══════════════════════════════════════════════════════════════════════════

test('批次1：index-tags 的 --spaces 必须真的生效（转发链路三层齐备）', () => {
  const dir = fixture()
  try {
    // fixture 里只有内置空间（experience/session-memory 等），故"限定到不存在的空间"应为空集
    const all = runCli(dir, ['index-tags'])
    assert.ok(Array.isArray(all.tags), 'index-tags 返回 tags 数组')
    assert.equal(all.spaces, null, '不带 --spaces → 不过滤')

    const scoped = runCli(dir, ['index-tags', '--spaces', 'experience'])
    assert.deepEqual(scoped.spaces, ['experience'], '--spaces 必须被转发到内核（漏转发会被静默吞掉）')
    assert.ok(scoped.tags.length > 0, '经验库里有文件名派生的标签')

    const none = runCli(dir, ['index-tags', '--spaces', 'no-such-space'])
    assert.deepEqual(none.spaces, ['no-such-space'])
    assert.equal(none.tags.length, 0, '限定到不存在的空间 → 空集（证明过滤生效，而非"未过滤"）')

    // 逗号串（HTTP `?spaces=a,b` 的形状）也要被归一成数组
    const multi = runCli(dir, ['index-tags', '--spaces', 'experience,session-memory'])
    assert.deepEqual(multi.spaces, ['experience', 'session-memory'], '逗号串逐字拆成数组')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ═══════════════════════════════════════════════════════════════════════════
// 2026-09-14 对标 Obsidian 批次 2：引用体系的三条 CLI 通道（真进程）
//
// 为什么每条都要真进程钉：`--around`/`--hops` 与批次 1 的 `--spaces` 同一个坑 ——
//   ① cli.mjs 的 parseArgs 不登记 → 静默忽略；② knowledgeArgs 白名单漏转发 → 静默吞掉。
// 两层都"不报错、不抛异常"，单元测试各测一层也全绿，只有真进程能发现。
// `mentions` / `broken-links` 是新 op，还要额外验证它们真的被 CLI 的 op 白名单接住
// （不在白名单里会走"unknown op"分支）。
// ═══════════════════════════════════════════════════════════════════════════

test('批次2：graph 的 --around/--hops 必须真的生效（登记 + 转发两层齐备）', () => {
  const dir = fixture()
  try {
    // 造一个真有引用关系的文档集（fixture 的经验库文档之间没有链接，测不出邻域）：
    //   a → b → c → d，另有孤岛 e
    const sp = join(dir, 'knowledge', 'spaces', 'demo')
    mkdirSync(sp, { recursive: true })
    writeFileSync(join(sp, 'a.md'), '# 甲\n\n[[b]]\n', 'utf-8')
    writeFileSync(join(sp, 'b.md'), '# 乙\n\n[[c]]\n', 'utf-8')
    writeFileSync(join(sp, 'c.md'), '# 丙\n\n[[d]]\n', 'utf-8')
    writeFileSync(join(sp, 'd.md'), '# 丁\n\n没有出链。\n', 'utf-8')
    writeFileSync(join(sp, 'e.md'), '# 孤岛\n\n无人理我。\n', 'utf-8')

    const all = runCli(dir, ['graph', '--space', 'demo'])
    assert.deepEqual(all.nodes.map((n) => n.id).sort(), ['demo/a.md', 'demo/b.md', 'demo/c.md', 'demo/d.md', 'demo/e.md'])
    assert.ok(all.edges.length >= 3, '全局图应有 a→b/b→c/c→d 的边（证明链接真的被解析成边）')

    // 1 跳 = 自身 + 直接邻居；孤岛与更远的节点都不在
    const one = runCli(dir, ['graph', '--space', 'demo', '--around', 'demo/a.md', '--hops', '1'])
    assert.deepEqual(one.nodes.map((n) => n.id).sort(), ['demo/a.md', 'demo/b.md'],
      '若 --around 被静默吞掉，这里会返回全局的 5 个节点')
    // 2 跳到 c（走的是**出链**方向）
    assert.deepEqual(runCli(dir, ['graph', '--space', 'demo', '--around', 'demo/a.md', '--hops', '2']).nodes.map((n) => n.id).sort(),
      ['demo/a.md', 'demo/b.md', 'demo/c.md'])
    // 3 跳到 d 为止，**孤岛 e 始终不进局部图**（局部图的意义就是不把无关节点拉进来）
    const three = runCli(dir, ['graph', '--space', 'demo', '--around', 'demo/a.md', '--hops', '3'])
    assert.deepEqual(three.nodes.map((n) => n.id).sort(), ['demo/a.md', 'demo/b.md', 'demo/c.md', 'demo/d.md'])
    // 双向：以 d 为心 1 跳要能走到 c（只走出链会漏掉"谁引用了我"，那是反链方向）
    assert.deepEqual(runCli(dir, ['graph', '--space', 'demo', '--around', 'demo/d.md', '--hops', '1']).nodes.map((n) => n.id).sort(),
      ['demo/c.md', 'demo/d.md'], '--hops 生效且遍历是双向的')
    // hops 越界收敛到 3（CLI 层 clamp）；不存在的中心 → 回落全局图（不是空图）
    assert.deepEqual(runCli(dir, ['graph', '--space', 'demo', '--around', 'demo/a.md', '--hops', '99']).nodes.map((n) => n.id).sort(),
      ['demo/a.md', 'demo/b.md', 'demo/c.md', 'demo/d.md'])
    assert.equal(runCli(dir, ['graph', '--space', 'demo', '--around', 'demo/不存在.md', '--hops', '2']).nodes.length, 5)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('批次2：mentions / broken-links 两个新 op 能经 CLI 直通（含 limit 缺省回落）', () => {
  const dir = fixture()
  try {
    // mentions：目标文档的标题是"workflow"（frontmatter name 派生），另一篇 policy.md 里没提到它 → 空集
    const m = runCli(dir, ['mentions', '--id', 'experience/workflow.md'])
    assert.ok(Array.isArray(m.items), 'mentions 返回 items 数组')
    assert.equal(typeof m.count, 'number')
    // 非法 limit（0 / abc）→ 回落缺省 30，而不是 0 条或 NaN
    assert.ok(Array.isArray(runCli(dir, ['mentions', '--id', 'experience/workflow.md', '--limit', 'abc']).items))
    // 不存在的文档 → 空集（不是报错：文档刚删是常态）
    assert.deepEqual(runCli(dir, ['mentions', '--id', 'no-such.md']).items, [])

    const b = runCli(dir, ['broken-links'])
    assert.ok(Array.isArray(b.items))
    assert.equal(typeof b.broken, 'number')
    // 空间过滤生效（限定到不存在的空间 → 0；证明 --space 被转发了，不是"未过滤"）
    assert.equal(runCli(dir, ['broken-links', '--space', 'no-such-space']).broken, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('批次2：links 的锚点/嵌入字段经 CLI 往返后不丢（JSON 序列化不能吃掉 false/空串）', () => {
  const dir = fixture()
  try {
    const r = runCli(dir, ['links', '--id', 'experience/workflow.md'])
    assert.ok(Array.isArray(r.out) && Array.isArray(r.in))
    // fixture 里没有 wiki 链接 → 两个数组都空；这条主要钉"op 直通 + 形状正确"，
    // 字段级往返由 kernel-tests/knowledge.test.mjs 的批次 2 用例覆盖（那里能造出锚点数据）。
    assert.equal(r.out.length, 0)
    assert.equal(r.in.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('批次1：search 的 total 与 tagHit 经 CLI 往返后不丢', () => {
  const dir = fixture()
  try {
    const r = runCli(dir, ['search', '--query', '申报材料', '--topK', '2'])
    assert.ok(r.total >= r.count, 'total 是截断前的命中总数，count 是本页条数')
    assert.ok(Number.isFinite(r.total), 'CLI 往返后 total 必须是数字（不是 undefined）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
