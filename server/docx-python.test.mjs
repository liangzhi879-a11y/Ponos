// `server/docx_edit.py` 回归网 —— 锁住**现有行为**，为 S1「文档协同模型」改造做前置网
// ---------------------------------------------------------------------------
// 这个文件在防什么：`docx_edit.py` 是 Word 读写入口，此前**零测试覆盖**（既有 mjs 测试
// 刻意不 spawn python）。S1 要把它从「按位 zip 配对 + 整包重写」改成「ops-only + 稳定
// blockId + 三路合并」，**没有网就改不动**——改完无从判断是真修好还是把别处踩坏了。
//
// 因此本文件分两类断言，勿混：
//   【不变量】改造前后都必须成立：read 幂等（T1）、Word 重存稳定（T2）、写回文本生效。
//             这类断言变红 = **改造引入了真 bug**。
//   【锁现状 + TODO】记录当前**已知缺陷**，用例名带 `TODO-Cx`：
//             B3 表格堆末尾（TODO-C2）、B1 按位 zip 静默截断/丢弃（TODO-C1）、
//             run 分段被抹平。
//             这类断言**变红是好事**——说明 Cx 已修，届时把断言**反转为期望的新行为**。
//             绝不要为了让它们变绿而改回旧行为。
//
// 语料与生成脚本见 `server/office-fixtures/README.md`（`scratch/` 被 .gitignore 忽略，
// 不能直接引用）。不 spawn 桥、不出网；临时文件用完重试清理。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, copyFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePython } from '../kernel/knowledge-import.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const SERVER = join(REPO_ROOT, 'server')
const DOCX_EDIT = join(SERVER, 'docx_edit.py')
const FIXTURES = join(SERVER, 'office-fixtures')
const TOOLS = join(FIXTURES, 'tools')
const BASE = join(FIXTURES, 'base.docx')
const RESAVED = join(FIXTURES, 'word_resaved.docx')

// 解释器与引擎脚本同一套探测（env → 自带 runtime → PATH）。自带排最前的原因见
// kernel/knowledge-import.mjs 注释：系统 python 通常没装 python-docx。
const PY = resolvePython()

const TMP = mkdtempSync(join(tmpdir(), 'yfw-docx-py-'))

// Windows 并发下子进程句柄释放有延迟，rmSync 会偶发 EPERM——重试兜底（照 auth-preflight 先例）
function rmSyncRetry(path, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch (e) {
      if (i === attempts - 1) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}
after(() => { rmSyncRetry(TMP) })

function pyRaw(args) {
  const r = spawnSync(PY, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (r.error) throw new Error(`spawn ${PY} 失败：${r.error.message}`)
  if (r.status !== 0) throw new Error(`python 退出码 ${r.status}：${r.stderr}`)
  return r.stdout
}

/** 读 bytes：read 输出是 ASCII（json.dumps 默认 ensure_ascii），跨 locale 稳定 */
function readDocxRaw(path) { return pyRaw([DOCX_EDIT, 'read', path]) }
function readDocx(path) {
  const raw = readDocxRaw(path)
  const j = JSON.parse(raw)
  if (!j.ok) throw new Error(`read 失败：${raw}`)
  return j
}

let writeSeq = 0
function writeDocx(payload) {
  const jp = join(TMP, `write-${++writeSeq}.json`)
  // 载荷含中文，必须 UTF-8 落盘（docx_edit.py 用 encoding="utf-8" 读）
  writeFileSync(jp, JSON.stringify(payload), 'utf8')
  const raw = pyRaw([DOCX_EDIT, 'write', jp])
  return JSON.parse(raw)
}

/** 只读检查器：read 看不到 run，而 set_para_text 的行为恰在 run 层 */
function inspectPara(path, index) {
  const raw = pyRaw([join(TOOLS, 'inspect_docx_runs.py'), path, String(index)])
  const j = JSON.parse(raw)
  if (!j.ok) throw new Error(`inspect 失败：${raw}`)
  return j.paragraphs[0]
}

/** 文档 body 的**真序**（p / tbl 交错）——read 输出丢了它，必须另取 */
function trueBodyOrder(path) {
  const code =
    "import sys,json;from docx import Document;" +
    "print(json.dumps([c.tag.split('}')[-1] for c in Document(sys.argv[1]).element.body.iterchildren()" +
    " if c.tag.endswith('}p') or c.tag.endswith('}tbl')]))"
  return JSON.parse(pyRaw(['-c', code, path]))
}

/** 每次用例用独立副本，避免互相污染 */
function freshCopy(name) {
  const p = join(TMP, `${name}-${++writeSeq}.docx`)
  copyFileSync(BASE, p)
  return p
}

// 表头：段落块 vs 表格块的**字段集合**必须精确，多一个少一个都是契约变更
const PARA_KINDS = new Set(['h1', 'h2', 'h3', 'p'])

before(() => {
  // 现场生成可确定性复现的变体（脚本入库、产物不入库）
  pyRaw([join(TOOLS, 'gen_docx.py'), join(TMP, 'base_gen.docx')])
  pyRaw([join(TOOLS, 'gen_variants.py'), BASE, TMP])
})

// ---------------------------------------------------------------------------
// 一、语料完整性（先钉住"尺子"本身，否则后面全是假绿）
// ---------------------------------------------------------------------------

test('语料完整性：入库 base.docx 与生成脚本产物的 **blocks 逐字节相等**', () => {
  // 为什么重要：本文件后续所有断言都以 `base.docx` 为基准。若入库字节被静默替换，或
  // gen_docx.py 漂移（比如有人改了标题层级），基准就变了而测试仍可能"看起来通过"。
  // 这条断言让"基准本身"也进入受控状态。变红意味着：要么换了语料，要么生成脚本改了结构。
  //
  // C2 起只比 `blocks`、**不比整个输出**：`baseVersion` 是"整文件 sha256"，两个内容相同
  // 但 zip 时间戳不同的文件必然给出不同哈希 —— 那是版本字段的**应有**行为，不是语料漂移。
  // 若这里改成比整份输出，会在 C2 落地后恒红（假红），把真正的语料漂移淹没掉。
  const gen = join(TMP, 'base_gen.docx')
  assert.ok(existsSync(gen), 'gen_docx.py 未产出文件')
  assert.deepEqual(readDocx(gen).blocks, readDocx(BASE).blocks)
})

// ---------------------------------------------------------------------------
// 二、read 的字段契约
// ---------------------------------------------------------------------------

test('read 字段契约（C2 后）：每块有唯一 blockId、顶层有 baseVersion', () => {
  // 为什么重要：这是 read→write 的**线格式**，也是 ops 寻址的全部依据。
  // 原断言钉的是"C2 之前没有 id"；C2 落地后**反转为"必须有 id"**（不是删掉——删掉就再没人看着线格式了）。
  // 变红意味着：要么 blockId 没了（ops 立刻无从寻址），要么 baseVersion 没了
  // （防丢失更新失效，A 的改动会静默覆盖 B 的）。
  const j = readDocx(BASE)
  assert.equal(j.ok, true)
  assert.ok(Array.isArray(j.blocks))
  assert.equal(j.blocks.length, 17)

  // 顶层版本字段：64 位 hex（整文件 sha256），供写入时做"基线比对"
  assert.equal(typeof j.baseVersion, 'string')
  assert.match(j.baseVersion, /^[0-9a-f]{64}$/)

  const ids = new Set()
  let paraCount = 0
  let tableCount = 0
  for (const b of j.blocks) {
    assert.ok(PARA_KINDS.has(b.kind) || b.kind === 'table', `未知 kind：${b.kind}`)
    assert.equal(typeof b.blockId, 'string', '每块都必须有 blockId')
    assert.ok(b.blockId.length > 0)
    assert.equal(ids.has(b.blockId), false, `blockId 必须唯一，重复：${b.blockId}`)
    ids.add(b.blockId)
    if (b.kind === 'table') {
      tableCount += 1
      // 步骤 5（C3/C4）扩展了线格式：表格块增 `tableCells`（细粒度视图）与 `format`（格式指纹）。
      // 这正是本用例该管的事 —— 字段增减必须是有意为之，不能悄悄漂。
      assert.deepEqual(Object.keys(b).sort(), ['blockId', 'format', 'kind', 'rows', 'tableCells'])
      assert.ok(Array.isArray(b.rows) && b.rows.every((r) => Array.isArray(r)))
    } else {
      paraCount += 1
      assert.deepEqual(Object.keys(b).sort(), ['blockId', 'format', 'kind', 'text'])
      assert.equal(typeof b.text, 'string')
    }
  }
  assert.equal(paraCount, 15, '段落块数不得改变（字段升级不应增删内容）')
  assert.equal(tableCount, 2, '表格块数不得改变')
})

// ---------------------------------------------------------------------------
// 三、【不变量】T1 幂等 / T2 Word 重存稳定
// ---------------------------------------------------------------------------

test('【不变量】T1 幂等：同一文件连续 read 3 次，输出逐字节相等', () => {
  // 为什么重要：幂等是"能不依赖"协同的前提——若同一字节两次读出的结果都不同（比如字段
  // 顺序随机、含时间戳），那么"两人改后合并"的判等就没有意义，任何 diff 都会恒为全量差异。
  // 变红意味着：读路径引入了不确定性（随机序、时间戳、locale 相关格式）。
  const a = readDocxRaw(BASE)
  const b = readDocxRaw(BASE)
  const c = readDocxRaw(BASE)
  assert.equal(a, b)
  assert.equal(b, c)
})

test('【不变量】T2 稳定：真 Word 重存后的 word_resaved.docx 与 base.docx 的 **blocks 完全相同**', () => {
  // 为什么重要：这条解除"两种编辑入口混用"的最大顾虑——用户在 Word 里打开又保存
  // （内容一字未改，但 Word 会重组 zip、重切 run），块级解析必须仍然认得出来。
  // 若变红：Word 的 run 重切已经影响到我们读到的块序列，块对齐会全线失准。
  // 注意这是"入库的真 Word 字节"，不是脚本生成的（见 office-fixtures/README.md）。
  //
  // C2 起只比 `blocks` 而**不比整个输出**：`baseVersion` 是整文件 sha256，
  // base.docx 与 word_resaved.docx 是**两个不同的文件**（本就不同字节），哈希必然不同。
  // 那是版本字段的应有语义；若把整份输出拿来比，这条会在 C2 后恒红（假红），
  // 从而掩盖真正的信号——"blockId 是否扛住了 Word 重存"。
  assert.deepEqual(readDocx(RESAVED).blocks, readDocx(BASE).blocks)
  // 顺带把"两个文件确实不同字节"钉住，避免有人误以为 baseVersion 也该相同
  assert.notEqual(readDocx(RESAVED).baseVersion, readDocx(BASE).baseVersion)
})

// ---------------------------------------------------------------------------
// 四、【C2 新契约】块序 = 文档真序
// ---------------------------------------------------------------------------

test('C2：read 按文档**真序**取块（原 B3 缺陷已根除）——表格穿插在它原本的位置', () => {
  // 这条原是"锁现状"（先段落后表格，T 全在末尾）。C2 落地后**反转为真序断言**。
  // 为什么从"锁现状"改成"验正确"而不是删掉：块序是合并对齐的坐标基准，必须有断言看着。
  // 独立性说明：期望值不是硬编码，而是由 python-docx 直接遍历 `doc.element.body` 算出
  // （`trueBodyOrder`），与 `docx_edit.py` 的实现**不是同一段代码** —— 不是自证。
  const j = readDocx(BASE)
  // 两侧字母表不同，必须先归一：read 给的是**标题层级**（h1/h2/h3/p），
  // 而 `trueBodyOrder` 给的是**标签名**（p/tbl）。直接比 'h1ppph2…' 与 'pppp…' 是假红
  // （首版就是这么红的）。归一为"表/非表结构"后，比对的是**交错次序**，正是 B3 的失败点。
  const structOfRead = j.blocks.map((b) => (b.kind === 'table' ? 'T' : 'P')).join('')

  const order = trueBodyOrder(BASE)
  const expectStruct = order.map((v) => (v === 'tbl' ? 'T' : 'P')).join('')
  assert.equal(structOfRead, expectStruct, '块序必须与 body 子元素真序一致（独立实现：直接遍历 python-docx 的 body）')
  assert.equal(j.blocks.length, order.length, '块数 = body 中 p/tbl 子元素数（sectPr 等非块元素必须被跳过）')

  // 真序的关键特征（也是旧实现的失败点）：表格**出现在末尾段落之前**，末块是段落
  assert.ok(order.includes('tbl'))
  assert.ok(order.indexOf('tbl') < order.lastIndexOf('p'), '真序中表格应先于末尾段落出现')
  assert.equal(j.blocks[j.blocks.length - 1].kind !== 'table', true, '末块应为段落（旧实现里末两块都是表格）')
})

// ---------------------------------------------------------------------------
// 五、【C1 新契约】B1 已根除：旧全量 blocks 写法**显式拒绝**，zip 按位覆盖不复存在
// ---------------------------------------------------------------------------

test('C1：旧全量 blocks 写法被**显式拒绝**（原 B1"静默丢弃/静默截断"已根除）', () => {
  // 这两条原是"锁现状"（多一个块被静默丢弃、少一个块被静默保留，且都返回 ok:true）。
  // C1 落地后**反转为"必须显式拒绝"**。
  //
  // 为什么不能只是"删掉旧用例"：B1 是 FINDINGS.md 判为 🔴 阻断的那条 —— 它的危害不是"写错"，
  // 而是**静默**（协同场景里等于"用户的改动被无声吞掉"）。反转成"必须报错"后，
  // 一旦有人为了兼容又把旧路径放回来，这条会立刻变红。
  const p = freshCopy('c1-legacy-more')
  const j0 = readDocx(BASE)
  const ghost = '【幽灵段】不应出现在文档中'

  // ① 多一个块
  let res = writeDocx({ path: p, blocks: [...j0.blocks, { kind: 'p', text: ghost }] })
  assert.equal(res.ok, false, '旧写法必须被拒绝，不得静默接受')
  assert.equal(res.code, 'legacy-blocks-not-supported')
  assert.equal(readDocx(p).blocks.length, 17, '被拒绝的写入不得改动文件')
  assert.ok(!readDocx(p).blocks.some((b) => (b.text || '').includes('幽灵段')))

  // ② 少几个块
  const p2 = freshCopy('c1-legacy-fewer')
  const paras = j0.blocks.filter((b) => b.kind !== 'table')
  const tables = j0.blocks.filter((b) => b.kind === 'table')
  res = writeDocx({ path: p2, blocks: [{ kind: 'p', text: '改写第0段' }, paras[1], paras[2], ...tables] })
  assert.equal(res.ok, false, '旧写法必须被拒绝（即便只传了部分块）')
  assert.equal(res.code, 'legacy-blocks-not-supported')
  assert.deepEqual(readDocx(p2).blocks, j0.blocks, '被拒绝的写入不得留下半截改动')

  // ③ 既不传 ops 也不传 blocks ⇒ 明确报"缺 ops"
  const p3 = freshCopy('c1-no-ops')
  res = writeDocx({ path: p3 })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'ops-required')

  // ④ 旧写法带不带 baseVersion 都必须被拒（不能因为"顺手带了 baseVersion"就放行旧路径）
  const p4 = freshCopy('c1-legacy-with-version')
  res = writeDocx({ path: p4, baseVersion: j0.baseVersion, blocks: j0.blocks })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'legacy-blocks-not-supported')
})

// ---------------------------------------------------------------------------
// 六、【不变量】写回文本确实生效
// ---------------------------------------------------------------------------

test('【不变量】写回生效：改一段文字后重新 read 能看到新文字（改用 ops）', () => {
  // 为什么重要：上面几条锁的都是"拒绝路径"，如果只有它们，那么一个「什么都不写」的实现
  // 也能全绿。本条是最基本的正向保证：ops 确实改了文档，且 read 能读回来。
  // C1 起写入换成 ops（blockId 寻址 + baseVersion），因此这里也换成 ops —— 若仍用旧 blocks，
  // 它会因为"被正确拒绝"而变红，那是**假红**（拒绝是对的），会掩盖真正的写入失效。
  const p = freshCopy('write-ok')
  const j0 = readDocx(p)
  const NEW = '【校验】本期目标为打通采集、校验、汇总三个环节。'

  const res = writeDocx({
    path: p,
    baseVersion: j0.baseVersion,
    ops: [{ op: 'update', blockId: j0.blocks[5].blockId, text: NEW }],
  })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(readDocx(p).blocks[5].text, NEW)
  // 顺带钉住"只改了一段"：邻居段未被波及
  assert.equal(readDocx(p).blocks[6].text, j0.blocks[6].text)
  assert.equal(readDocx(p).blocks.length, j0.blocks.length, '块数不变')
})

// ---------------------------------------------------------------------------
// 七、【锁现状】set_para_text 抹平 run 分段
// ---------------------------------------------------------------------------

test('【锁现状】set_para_text 抹平 run 分段：写入后可见文本只剩 1 个 run，粗体/斜体格式丢失', () => {
  // 为什么锁它：`set_para_text` 把整段文本塞进**第一个非空 run**，其余 run 文本清空，
  // 但**不动格式**。于是 `p.text` 看起来"正确"（read 只返回 text，完全看不见这事），
  // 实际上粗体/斜体所占的位置被抹成了一整段无格式文本——这是格式变更不可见（FINDINGS #4）
  // 在写入侧的镜像。C4「格式指纹」正是为此。
  //
  // 这条测得了，靠的是 `office-fixtures/tools/inspect_docx_runs.py`（read 看不到 run）。
  const p = freshCopy('run-flat')
  const NEW = '全新一整句文本'

  const b4 = inspectPara(BASE, 3)
  assert.equal(b4.runs.length, 4, 'base 第 3 段：4 个 run（混合格式，Word 重存最容易重切的地方）')
  assert.equal(b4.runs.filter((r) => r.text).length, 4)
  assert.ok(b4.runs.some((r) => r.bold === true), 'base 第 3 段含粗体 run')
  assert.ok(b4.runs.some((r) => r.italic === true), 'base 第 3 段含斜体 run')

  const j0 = readDocx(p)
  const w = writeDocx({
    path: p,
    baseVersion: j0.baseVersion,
    ops: [{ op: 'update', blockId: j0.blocks[3].blockId, text: NEW }],
  })
  assert.equal(w.ok, true, JSON.stringify(w))

  assert.equal(readDocx(p).blocks[3].text, NEW, 'read 层看起来"写对了"')

  const af = inspectPara(p, 3)
  assert.equal(af.runs.filter((r) => r.text).length, 1, '现状：可见文本塌成 1 个 run')
  assert.equal(af.runs.filter((r) => r.text)[0].text, NEW)
  assert.equal(af.runs.length, 4, 'run 对象本身还在（只是文本被清空）')
  assert.ok(af.runs.some((r) => !r.text && r.bold === true), '粗体标记残留在**空** run 上')
  assert.ok(
    !af.runs.some((r) => r.text && (r.bold === true || r.italic === true)),
    '现状：承载可见文本的 run 不再带格式 ⇒ 粗体/斜体从可见文本上消失',
  )
})
