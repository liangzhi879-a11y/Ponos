// kernel-tests/knowledge-import-tool.test.mjs —— T5：agent 侧 `KnowledgeImport` 工具的回归
// ---------------------------------------------------------------------------
// 钉住四件事（spec P2-1 / P2-2 / P3-1 / §6）：
//   ① **同一条管线**：工具体只做参数归一 + 调 `importFiles`（对外主入口），报告口径是
//      `results[].status` 四态 + `summary`，且**落盘真的发生**；导入后同一个注册表的
//      `KnowledgeSearch` 能检索到（P2-1 的"随后 agent 就能检索"端到端）。
//   ② 参数非法给**明确错误**而不是抛异常：`from`/`space` 缺失、未配 memoryRoot —— 全部
//      走结构化 `{content, isError:true}`，且零写入（不猜路径、不现种 knowledge/.index）。
//   ③ **错误码原样透出**（P3-1）：`readonly-space` / `invalid-space-id` / `not-found` 一字不改。
//      特别注意 `invalid-space-id` 是 `importFiles` 的**对外别名**（内部是 `bad-space-id`）——
//      这条断言同时也是"工具确实走 importFiles 而非 importDocuments"的结构性证据。
//   ④ `dryRun` 透传且**零写入**；`maxOcrPages` 归一（缺省/非法 0 都回默认 200，不得被 0 归零）。
//
// 隔离纪律（spec §6）：**不启 bridge、不 spawn python、不加载 OCR 模型** —— 解析器由
// `ctx.runDocToMd` 注入假实现（与 `ctx.browserDriver` 同一套依赖注入手法）；
// 全部临时 configDir（mkdtempSync），真实 `~/.yfworking` / `~/.yfw` 一律不碰。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createToolRegistry } from '../kernel/tools.mjs'

const TOOLS_SRC = fileURLToPath(new URL('../kernel/tools.mjs', import.meta.url))

/** 临时 configDir；`memoryRoot` 取 <dir>/memory/personal（与 kernel/cli.mjs 同口径：
 *  工具把 configDir 推导成 memoryRoot 上溯两级）。 */
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kbimptool-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(dir, 'config.json'), '{"model":"fake"}', 'utf-8')
  return { dir, personal }
}

function mkSrc(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kbimptoolsrc-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }
  return dir
}

/**
 * 假解析器：正好是 `importFiles({runDocToMd})` 的契约形状 `(filePath, opts) => {ok, …}`。
 * `seen` 收集每次调用的 opts —— 用它钉 `limits` 透传（maxOcrPages）而不用真 python。
 */
function fakeParser(seen = []) {
  return (filePath, opts = {}) => {
    seen.push({ filePath, opts })
    return Promise.resolve({
      ok: true,
      converter: 'fake',
      title: `文档 ${basename(filePath)}`,
      sections: [{ heading: '一、材料', level: 1, text: '材料费与差旅费明细，含中文与表格', tables: [[['科目', '金额'], ['材料费', '320']]] }],
      warnings: [],
    })
  }
}

/** 目录快照（相对路径 → 字节数）：判"零写入"用 —— 比逐个 existsSync 更能发现**意外**产物。 */
function snapshot(root) {
  const out = {}
  const walk = (dir, prefix = '') => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) { out[`${rel}/`] = 0; walk(join(dir, e.name), rel) } else out[rel] = statSync(join(dir, e.name)).size
    }
  }
  walk(root)
  return out
}

const registry = (h) => createToolRegistry({ cwd: h.dir, addDirs: [], skipPermissions: true, memoryRoot: h.personal })
const call = (tools, input, ctx = {}) => tools.run({ name: 'KnowledgeImport', input }, ctx)
/** 成功路径的 content 必须是**可解析的结构化报告**（不是给人看的散文）。 */
const reportOf = (r) => {
  assert.equal(r.isError, false, `应为成功（实际：${String(r.content).slice(0, 200)}）`)
  return JSON.parse(r.content)
}

test('工具调用：正常导入返回结构化报告，md 落盘，随后 KnowledgeSearch 能检索到（P2-1 端到端）', async () => {
  const h = home()
  const src = mkSrc({ 'a.docx': 'x', '子目录/b.xlsx': 'yy' })
  try {
    const tools = registry(h)
    const rep = reportOf(await call(tools, { from: src, space: '申报资料' }, { runDocToMd: fakeParser() }))
    assert.equal(rep.space, '申报资料', 'space 原样回显（模型据此确认导进了哪）')
    assert.equal(rep.spaceName, '申报资料', 'name 缺省即空间 id')
    assert.equal(rep.spaceCreated, true)
    assert.equal(rep.dryRun, false)
    assert.deepEqual(rep.summary, { total: 2, imported: 2, skipped: 0, rejected: 0, failed: 0 })
    assert.deepEqual(rep.results.map((x) => x.status), ['imported', 'imported'])
    const byRel = Object.fromEntries(rep.results.map((x) => [x.rel, x]))
    assert.equal(byRel['a.docx'].mdRel, 'a.md')
    assert.equal(byRel['子目录/b.xlsx'].mdRel, '子目录/b.md', '相对目录结构必须保留')
    // 报告不是"纸面成功"：md 真的在盘上，内容来自权威渲染（含表格正文）
    const md = join(h.dir, 'knowledge', 'spaces', '申报资料', 'a.md')
    assert.ok(existsSync(md), '导入产物必须落盘')
    assert.match(readFileSync(md, 'utf-8'), /材料费/, '落盘内容必须是解析出的正文（权威渲染）')
    // P2-1 的"随后用 KnowledgeSearch 就能检索到"——同一个注册表、同一份知识根
    const s = await tools.run({ name: 'KnowledgeSearch', input: { query: '材料费', keywords: ['材料费'], topK: 5 } }, {})
    assert.equal(s.isError, false)
    assert.match(s.content, /申报资料\//, '检索命中必须落在刚导入的空间（空间/相对路径 = docId）')
  } finally { rmSync(h.dir, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

test('工具调用：参数非法/未配知识根给明确错误，不抛异常、零写入', async () => {
  const h = home()
  const src = mkSrc({ 'a.txt': 'x' })
  try {
    const tools = registry(h)
    const before = snapshot(h.dir)
    const cases = [
      [{ space: 's' }, /from 参数缺失/, '缺 from'],
      [{ from: src }, /space 参数缺失/, '缺 space'],
      [{ from: '   ', space: 's' }, /from 参数缺失/, 'from 只有空白'],
      [{ from: src, space: '  ' }, /space 参数缺失/, 'space 只有空白'],
    ]
    for (const [input, re, why] of cases) {
      const r = await call(tools, input, { runDocToMd: fakeParser() })
      assert.equal(r.isError, true, `${why}：必须标 error`)
      assert.match(r.content, re, `${why}：错误信息要点名缺哪个参数（实际 ${r.content}）`)
      assert.doesNotMatch(r.content, /工具执行异常/, `${why}：不得靠"抛异常被兜底"报错（那样错误信息会丢）`)
    }
    // 未配 memoryRoot：**不猜路径**（相对路径探知识根会在 cwd 下现种一棵 knowledge/.index）
    const bare = createToolRegistry({ cwd: h.dir, addDirs: [] })
    const r = await call(bare, { from: src, space: 's' }, { runDocToMd: fakeParser() })
    assert.equal(r.isError, true)
    assert.match(r.content, /memoryRoot/)
    assert.deepEqual(snapshot(h.dir), before, '上述所有失败路径都必须零写入')
  } finally { rmSync(h.dir, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

test('工具调用：只读空间/非法 id/源不存在 的错误码原样透出（P3-1），全程零写入', async () => {
  const h = home()
  const src = mkSrc({ 'a.txt': 'x' })
  const srcBad = mkSrc({ '资料包/a.txt': 'x' })
  try {
    const tools = registry(h)
    const before = snapshot(h.dir)
    // 非法 id 断言的是 `invalid-space-id`（importFiles 的对外别名）而**不是**内部码
    // `bad-space-id` —— 别名层只在 importFiles 里翻，故这条同时证明工具走的是主入口。
    const cases = [
      [{ from: src, space: 'pack-demo' }, /readonly-space/, '只读知识包前缀'],
      [{ from: srcBad, space: '资料/包' }, /invalid-space-id/, '非法 id（含 /）'],
      [{ from: join(h.dir, '不存在的目录'), space: 'ok-space' }, /not-found/, '源不存在'],
    ]
    for (const [input, re, why] of cases) {
      const r = await call(tools, input, { runDocToMd: fakeParser() })
      assert.equal(r.isError, true, `${why}：必须标 error`)
      assert.match(r.content, re, `${why}：错误码必须原样透出（实际 ${r.content}）`)
      assert.match(r.content, /导入未执行/, `${why}：必须是"未执行"而不是含糊的失败`)
    }
    assert.deepEqual(snapshot(h.dir), before, '被拒的导入必须零写入（绝不静默写到别处）')
    assert.ok(!existsSync(join(h.dir, 'knowledge')), '被拒时连 knowledge 根都不该出现')
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
    rmSync(srcBad, { recursive: true, force: true })
  }
})

test('工具调用：dryRun 透传且零写入；已入库内容在 dryRun 里显示为 skipped（P2-2）', async () => {
  const h = home()
  const src = mkSrc({ 'a.txt': '正文', 'b.md': '正文' })
  try {
    const tools = registry(h)
    const before = snapshot(h.dir)
    const p1 = reportOf(await call(tools, { from: src, space: '预览空间', dryRun: true }, { runDocToMd: fakeParser() }))
    assert.equal(p1.dryRun, true)
    // dryRun 下 `spaceCreated` 的语义是**"将新建"**（真有东西要落盘才算；见 importDocuments
    // 的 dry-run 分支），不是"已经建好了"——是否真建由下面的零写入断言说话。
    assert.equal(p1.spaceCreated, true, '预览：空间不存在且有文件要导入 → "将新建"')
    assert.equal(p1.spaceExisted, false)
    assert.deepEqual(p1.summary, { total: 2, imported: 2, skipped: 0, rejected: 0, failed: 0 }, '预览里 imported = "将导入"')
    assert.deepEqual(snapshot(h.dir), before, 'dryRun 必须零写入（整个 configDir 逐字节一致）')

    reportOf(await call(tools, { from: src, space: '预览空间' }, { runDocToMd: fakeParser() }))
    const sizeBefore = statSync(join(h.dir, 'knowledge', 'spaces', '预览空间', 'a.md')).size
    const p2 = reportOf(await call(tools, { from: src, space: '预览空间', dryRun: true }, { runDocToMd: fakeParser() }))
    assert.deepEqual(p2.summary, { total: 2, imported: 0, skipped: 2, rejected: 0, failed: 0 }, '内容未变 → 全部"将跳过"')
    assert.deepEqual(p2.results.map((x) => x.status), ['skipped', 'skipped'])
    assert.equal(statSync(join(h.dir, 'knowledge', 'spaces', '预览空间', 'a.md')).size, sizeBefore, '预览不得改写已入库文件')
  } finally { rmSync(h.dir, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

test('工具调用：maxOcrPages 归一（缺省与非法 0 都回默认 200，显式值原样透传）', async () => {
  const h = home()
  const src = mkSrc({ 'a.txt': 'x' })
  try {
    const tools = registry(h)
    for (const [input, want, why] of [
      [{ from: src, space: 'o1' }, 200, '缺省'],
      [{ from: src, space: 'o2', maxOcrPages: 0 }, 200, '0'],
      [{ from: src, space: 'o3', maxOcrPages: -3 }, 200, '负数'],
      [{ from: src, space: 'o4', maxOcrPages: 7 }, 7, '显式值'],
    ]) {
      const seen = []
      const rep = reportOf(await call(tools, input, { runDocToMd: fakeParser(seen) }))
      assert.equal(rep.summary.imported, 1, `${why}：护栏被归零会变成"每份文件都超限"，实测 ${JSON.stringify(rep.summary)}`)
      assert.equal(seen[0].opts.limits.maxOcrPages, want, `${why}：应传 ${want}`)
    }
  } finally { rmSync(h.dir, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

test('工具调用：报告回显有条数上限（results 截断 + resultsOmitted），落盘不截断', async () => {
  const h = home()
  const files = {}
  for (let i = 1; i <= 60; i++) files[`f${String(i).padStart(2, '0')}.txt`] = '内容'
  const src = mkSrc(files)
  try {
    const rep = reportOf(await call(registry(h), { from: src, space: '大批' }, { runDocToMd: fakeParser() }))
    assert.deepEqual([rep.summary.total, rep.summary.imported], [60, 60], 'summary 必须是全量计数（截断只影响明细回显）')
    assert.equal(rep.results.length, 50, '明细超过 50 条截断（防整批回灌吃掉上下文）')
    assert.equal(rep.resultsOmitted, 10, '省略条数必须显式写在报告里（不静默丢信息）')
    const md = readdirSync(join(h.dir, 'knowledge', 'spaces', '大批')).filter((n) => n.endsWith('.md'))
    assert.equal(md.length, 60, '截断只影响回显：60 篇产物必须都在盘上')
  } finally { rmSync(h.dir, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

// 源码级守卫（对应验收第 3 条：grep 证明工具内没有第二份解析/渲染/落盘逻辑）。
// 为什么要在测试里做：这条纪律靠"读代码"守不住——下一个人为了"顺手补个日志/加个扩展名
// 白名单"就会复制一份判定进来，而功能测试全绿（复制的那份恰好与权威实现同行为）。
test('源码守卫：KnowledgeImport 工具体 = 参数归一 + 调用权威主入口 importFiles（无第二份管线）', () => {
  const src = readFileSync(TOOLS_SRC, 'utf-8')
  const start = src.indexOf('KnowledgeImport: {')
  assert.ok(start > 0, 'tools.mjs 必须仍注册 KnowledgeImport')
  const rest = src.slice(start)
  // 切到**下一个静态工具键**（4 空格缩进 + `名字: {`），不写死名字（重命名/换序不会误伤）。
  // ⚠️ 必须写 `\r?\n`：tools.mjs 是 **CRLF**，原先的 `\n {4}` 在本文件里**从不匹配**
  // （`{` 后面跟的是 `\r` 不是 `\n`）→ `end` 恒为 -1 → `block` 退化成"从 KnowledgeImport
  // 到文件尾"，守卫实际一直在**全文扫描**。它此前"通过"只是因为 KnowledgeImport 之后没有
  // 哪个工具用到那些禁词；加入 KnowledgeDelete（自身需要 createKnowledgeStore）后立刻显形。
  // 修成 CRLF 无关后，切分范围才真的等于"这一个工具的体"。
  const end = rest.search(/\r?\n {4}[A-Za-z][A-Za-z0-9]*: \{\r?\n/)
  const block = end > 0 ? rest.slice(0, end) : rest
  assert.ok(block.length < rest.length, '守卫必须能切出 KnowledgeImport 这个工具的体（否则退化成全文扫描）')
  // 注释行先剥掉再查禁词：注释里**提到**权威函数名（说明同源关系）是文档，不是实现
  const code = block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.match(code, /const \{ importFiles \} = await import\('\.\/knowledge-import\.mjs'\)/,
    '必须调对外主入口 importFiles（与 CLI/GUI 同一条管线）')
  for (const forbidden of ['doc_to_md', 'spawn(', 'renderMarkdown', 'renderImportText', 'writeFileSync',
    'createKnowledgeStore', 'sha256', 'importDocuments', 'IMPORT_LIMITS', 'validateSpaceId']) {
    assert.ok(!code.includes(forbidden), `工具体不得出现 ${forbidden}：解析/渲染/落盘/校验只有 kernel/knowledge-import.mjs 一份实现`)
  }
})
