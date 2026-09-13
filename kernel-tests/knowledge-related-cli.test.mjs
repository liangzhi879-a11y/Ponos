// S5 Task 7：CLI `--knowledge related --id <blockId> [--no-validate] [--limit N]` 的回归测试。
//
// 钉住四件事（spec §7.3 / §11-10）：
//   ① op 接线可用：返回锚点摘要（字段集合钉死、**绝不含正文**）；
//   ② `--no-validate` 真的关掉了读时校验（不是"参数被静默吞掉"——未知 -- 参数在本 CLI 里
//      是静默忽略的，这正是必须显式登记该 flag 的理由）；
//   ③ 缺失/形状错的 `--id`、坏 `--limit` 一律 code=1 + 明确文案（参数错不被伪装成空数组）；
//   ④ `--limit` 生效（0 合法：只要 duplicate 标记的场景）；
//   ⑤ 真进程链路：`--knowledge` 在**格式校验之后**，故必须带
//      `--output-format stream-json --input-format stream-json`（S1 踩过的坑，用例锁死）。
//
// 隔离纪律：mkdtempSync 临时目录；真进程用例走 PONOS_HOME（并清掉 CLAUDE_CONFIG_DIR，
// 防宿主环境把它指到真实库），**不起 bridge、不联网**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runKnowledgeCommand } from '../kernel/knowledge-cli.mjs'
import { MAX_RELATED } from '../shared/knowledge-core.mjs'

const DOC = 'experience/workflow.md'
const IDX = (dir) => join(dir, 'knowledge', '.index')
/** 锚点摘要的精确字段集合：多一个 text/full/snippet 就是上下文膨胀（S3 的教训）。 */
const SUMMARY_KEYS = ['blockId', 'docId', 'score', 'title', 'why']

// 4 条同 tag（骨架层相邻）+ 1 条异 tag（内容层噪声边界）。
// 正文长度一律 ≥ MIN_LEN(20)：短正文会被当垃圾条目过滤掉，用例会退化成空转。
const LINES = [
  '- [会话|企微CLI化] 渠道纪律 -- 涉及真实沟通渠道的测试一律只发文件传输助手，避免打扰真人',
  '- [会话|企微CLI化] 步骤字段契约 -- js 步骤需 expression、click 类需 ref，写错会静默失败很久',
  '- [会话|企微CLI化] 同步前预演 -- 用 rsync 增量同步目录时先 dry-run 预览变更清单再执行',
  '- [会话|企微CLI化] 联查去重 -- 多表联查先按业务键去重再聚合，否则分母翻倍让比率失真',
  '- [会话|打包发布] 打包核对 -- 上传前逐项核对文件名与发布清单，避免版本错配',
]

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-krelcli-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), ['---', 'name: workflow', '---', ...LINES].join('\n') + '\n', 'utf-8')
  return { dir, personal, md: join(personal, 'workflow.md') }
}

/** 块序号不靠硬编码：从 `entries` op 取（op 自身也是被测接线的一部分）。 */
async function firstBlockId(dir) {
  const { output } = await runKnowledgeCommand({ op: 'entries', configDir: dir, args: { id: DOC } })
  assert.ok(output.entries.length >= 4, '前置：夹具必须产出 ≥4 条同 tag 条目')
  return output.entries[0].blockId
}

function tamperDocs(dir, fn) {
  const p = join(IDX(dir), 'docs.jsonl')
  const rows = readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  fn(rows)
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
}

test('op=related 返回锚点摘要：带 why、不含正文、字段集合钉死', async () => {
  const { dir } = fixture()
  try {
    const id = await firstBlockId(dir)
    const { output, code } = await runKnowledgeCommand({ op: 'related', configDir: dir, args: { id } })
    assert.equal(code, 0)
    assert.equal(output.blockId, id)
    assert.equal(output.validate, true, '缺省开读时校验（spec §6.2）')
    assert.equal(output.limit, MAX_RELATED, '缺省 limit 必须与内核缺省同源（不是另抄的字面量）')
    assert.ok(output.count >= 3, `同 tag 邻居应至少 3 条，实得 ${output.count}`)
    assert.equal(output.count, output.related.length)
    for (const x of output.related) {
      assert.deepEqual(Object.keys(x).sort(), SUMMARY_KEYS, '锚点只给摘要，带正文字段即失败')
      assert.ok(x.why && typeof x.why === 'object', 'why 必带（无 why 的锚点与随机跳转无异）')
    }
    const tagEdge = output.related.find((x) => x.why.kind === 'tag')
    assert.equal(tagEdge.why.tag, '企微CLI化')
    assert.equal(tagEdge.title, 'workflow', 'title 取目标块所属文档标题')
    assert.equal(tagEdge.score, null, 'tag 边不编造分数（null，不是 0）')
    assert.ok(output.related.some((x) => x.blockId === `${DOC}#1`), '同 tag 的 #1 必须可达')
    // 体积控制：整段正文不可能出现在 related 里（最长字段是 bigram 级的 shared）
    const json = JSON.stringify(output)
    assert.ok(!json.includes(LINES[1].slice(LINES[1].indexOf('--') + 2).slice(0, 16)), '不得携带正文')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('--no-validate 生效：陈旧边在缺省视图被剔除、在调试视图仍可见（且不改物化）', async () => {
  const { dir } = fixture()
  try {
    await runKnowledgeCommand({ op: 'reindex', configDir: dir }) // 先物化
    const id = await firstBlockId(dir)
    const before = readFileSync(join(IDX(dir), 'related.jsonl'), 'utf-8')
    const strict0 = await runKnowledgeCommand({ op: 'related', configDir: dir, args: { id } })
    assert.ok(strict0.output.related.some((x) => x.blockId === `${DOC}#1`), '前置：#0→#1 在物化里存在')

    // 构造"物化陈旧"：块 #1 从 docs.jsonl 消失，而 .md 未动 ⇒ 不触发重建（读时校验的正题）
    tamperDocs(dir, (rows) => { for (const d of rows) d.blocks = d.blocks.filter((b) => b.n !== 1) })

    const raw = await runKnowledgeCommand({ op: 'related', configDir: dir, args: { id, noValidate: true } })
    assert.equal(raw.output.validate, false, '--no-validate 必须回显（否则无法确认开关生效）')
    assert.ok(raw.output.related.some((x) => x.blockId === `${DOC}#1`),
      '--no-validate 应返回物化里原样存着的边（否则这个 flag 等于没接线）')
    const strict = await runKnowledgeCommand({ op: 'related', configDir: dir, args: { id } })
    assert.ok(!strict.output.related.some((x) => x.blockId === `${DOC}#1`), '缺省视图必须剔除端点已消失的边')
    assert.equal(readFileSync(join(IDX(dir), 'related.jsonl'), 'utf-8'), before, '读时校验绝不改物化文件')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('--limit 生效：1 → 1 条、0 → 0 条（duplicate 仍照常追加在末尾）', async () => {
  const { dir } = fixture()
  try {
    const id = await firstBlockId(dir)
    const all = await runKnowledgeCommand({ op: 'related', configDir: dir, args: { id } })
    const one = await runKnowledgeCommand({ op: 'related', configDir: dir, args: { id, limit: 1 } })
    const zero = await runKnowledgeCommand({ op: 'related', configDir: dir, args: { id, limit: 0 } })
    assert.equal(one.output.limit, 1)
    assert.equal(one.output.related.filter((x) => x.why.kind !== 'duplicate').length, 1)
    assert.equal(zero.output.related.filter((x) => x.why.kind !== 'duplicate').length, 0)
    assert.ok(all.output.count > one.output.count, `limit 必须真的截断（全量 ${all.output.count} vs 1）`)
    assert.ok(one.output.related[0].why.kind === 'tag', '截断后仍保留排序口径：tag 在前')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('缺失/形状错的 --id 与坏 --limit 一律 code=1 + 明确文案（不伪装成空数组）', async () => {
  const { dir } = fixture()
  try {
    const cases = [
      [{}, /missing --id/],
      [{ id: '   ' }, /missing --id/],
      [{ id: DOC }, /invalid blockId/],        // 传了 docId（无 '#'）——最常见的写错方式
      [{ id: '#0' }, /invalid blockId/],        // 缺 docId
      [{ id: `${DOC}#abc` }, /invalid blockId/],
      [{ id: `${DOC}#0`, limit: -1 }, /--limit 必须是非负整数/],
      [{ id: `${DOC}#0`, limit: 2.5 }, /--limit 必须是非负整数/],
      [{ id: `${DOC}#0`, limit: 'abc' }, /--limit 必须是非负整数/],
    ]
    for (const [args, re] of cases) {
      const { output, code } = await runKnowledgeCommand({ op: 'related', configDir: dir, args })
      assert.equal(code, 1, `args=${JSON.stringify(args)} 应报错`)
      assert.match(String(output.error), re)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('真进程链路：带 I/O 格式旗标可用；不带则被格式校验拦下（S1 的坑）', async () => {
  const { dir } = fixture()
  const cli = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
  try {
    const id = await firstBlockId(dir)
    const env = { ...process.env, PONOS_HOME: dir }
    delete env.CLAUDE_CONFIG_DIR // 防宿主环境把 configDir 指到真实库
    const fmt = ['--output-format', 'stream-json', '--input-format', 'stream-json']
    const args = ['--knowledge', 'related', '--id', id]

    const okRun = spawnSync(process.execPath, [cli, ...fmt, ...args], { env, encoding: 'utf-8' })
    assert.equal(okRun.status, 0, `stderr=${okRun.stderr}`)
    const out = JSON.parse(okRun.stdout)
    assert.equal(out.blockId, id)
    assert.ok(out.count >= 3, '真进程路径也要能拿到锚点')

    const noFmt = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf-8' })
    assert.equal(noFmt.status, 2, '缺 I/O 格式旗标必须在格式校验处被拦（--knowledge 短路在其之后）')
    assert.match(noFmt.stderr, /only stream-json I\/O format/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseArgs：--no-validate 必须被显式识别（未知 -- 参数是静默忽略的）', async () => {
  const { parseArgs } = await import('../kernel/cli.mjs')
  const a = parseArgs(['--knowledge', 'related', '--id', `${DOC}#0`, '--no-validate', '--limit', '3'])
  assert.equal(a.knowledge, 'related')
  assert.equal(a.noValidate, true)
  assert.equal(a.limit, 3)
  assert.equal(parseArgs(['--knowledge', 'related', '--id', `${DOC}#0`]).noValidate, undefined)
})

// —— S5 Task 9：GUI 批量口（`related --doc`）与图谱图层（`graph --related`）——

test('op=related --doc：整篇锚点（字段集合钉死）+ 坏 limit 明确报错', async () => {
  const { dir } = fixture()
  const { output, code } = await runKnowledgeCommand({ op: 'related', configDir: dir, args: { doc: DOC } })
  assert.equal(code, 0)
  assert.equal(output.docId, DOC, '回显 docId：CLI 是新进程调试口，不回显无法确认参数真的生效')
  assert.equal(output.validate, true)
  assert.equal(output.limit, MAX_RELATED)
  assert.ok(output.count >= 1, `同 tag 的邻居应给出锚点，实得 ${output.count}`)
  assert.equal(output.count, output.blocks.length)
  for (const bl of output.blocks) {
    assert.deepEqual(Object.keys(bl), ['blockId', 'related'], '块级只回 blockId + related')
    assert.ok(bl.related.length > 0, '没有锚点的块不该出现（GUI 据此不留空壳）')
    for (const x of bl.related) assert.deepEqual(Object.keys(x).sort(), SUMMARY_KEYS, '绝不含正文')
  }
  // 不存在的文档 → 空数组（与 links 的空集惯例一致），不是错误码
  const miss = await runKnowledgeCommand({ op: 'related', configDir: dir, args: { doc: 'experience/nope.md' } })
  assert.equal(miss.code, 0)
  assert.deepEqual(miss.output.blocks, [])

  // 坏 limit 必须报错（静默取缺省会把"参数写错"读成"只有这么多锚点"）
  const bad = await runKnowledgeCommand({ op: 'related', configDir: dir, args: { doc: DOC, limit: -1 } })
  assert.equal(bad.code, 1)
  assert.match(bad.output.error, /limit/)
})

test('op=graph --related：显式 true 才附相关层；缺省/字符串一律不带（图层默认关）', async () => {
  const { dir } = fixture()
  const off = await runKnowledgeCommand({ op: 'graph', configDir: dir, args: {} })
  assert.equal('related' in off.output, false, '缺省不得带 related（S2 响应形状逐字不变）')
  const offStr = await runKnowledgeCommand({ op: 'graph', configDir: dir, args: { related: 'true' } })
  assert.equal('related' in offStr.output, false, "字符串 'true' 不算（显式 === true，宁可少带）")
  const on = await runKnowledgeCommand({ op: 'graph', configDir: dir, args: { related: true } })
  assert.deepEqual(on.output.nodes, off.output.nodes)
  assert.ok(Array.isArray(on.output.related), 'related:true 时必须给数组')
  assert.deepEqual(on.output.related, [], '单文档库里没有文档对（自环已丢），空数组而不是缺失')
})

// —— 真进程链路：`--doc` 与 `graph --related` 必须**穿过 cli.mjs 的转发**——
//
// 为什么必须用真进程测：命令级用例（上面几条）直接调 `runKnowledgeCommand`，
// **绕过了 cli.mjs 的 parseArgs→args 转发**，于是漏转发抓不到。实测踩过：
// `parseArgs` 解析了 `--doc`（:172 有 case）但转发对象里没登记它 → 内核收到空 doc →
// `related --doc` 退化成 "missing --id" 报错，**GUI 文档内部一片关联都看不到**；
// `graph --related` 更隐蔽：被静默忽略 → 图谱图层开关打开了却没有边，
// 看起来像"数据没算出来"而不是"参数没传进来"。
// 这两个 flag 均由 HTTP 路由以 argv 形式驱动（`['--knowledge','related','--doc',docId]`
// / `['--knowledge','graph','--related']`），所以命令级测试永远替代不了本用例。
test('真进程链路：--doc 与 graph --related 必须真的穿过 CLI 管道（漏转发=静默失效）', async () => {
  const { dir } = fixture()
  const cli = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
  try {
    await runKnowledgeCommand({ op: 'reindex', configDir: dir })
    const env = { ...process.env, PONOS_HOME: dir }
    delete env.CLAUDE_CONFIG_DIR
    const fmt = ['--output-format', 'stream-json', '--input-format', 'stream-json']

    // ① related --doc：GUI「进入文档」后的批量锚点口
    const docRun = spawnSync(
      process.execPath, [cli, ...fmt, '--knowledge', 'related', '--doc', DOC], { env, encoding: 'utf-8' },
    )
    assert.equal(docRun.status, 0, `--doc 必须在真进程链路可用（漏转发会报 missing --id）stderr=${docRun.stderr}`)
    const docOut = JSON.parse(docRun.stdout)
    assert.equal(docOut.docId, DOC)
    assert.ok(docOut.count > 0, '文档内应能拿到锚点（否则"文档内部没关联"）')

    // ② graph --related：图谱关联图层开关
    const gRun = spawnSync(
      process.execPath, [cli, ...fmt, '--knowledge', 'graph', '--related'], { env, encoding: 'utf-8' },
    )
    assert.equal(gRun.status, 0, `stderr=${gRun.stderr}`)
    const gOut = JSON.parse(gRun.stdout)
    assert.ok(Array.isArray(gOut.related), '--related 必须真的穿过管道（被忽略时该字段不存在）')
    const plain = spawnSync(process.execPath, [cli, ...fmt, '--knowledge', 'graph'], { env, encoding: 'utf-8' })
    assert.equal(JSON.parse(plain.stdout).related, undefined, '不开图层时不应返回 related（默认只画显式链接）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
