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

test('语料完整性：入库 base.docx 与生成脚本产物的 read 输出逐字节相等', () => {
  // 为什么重要：本文件后续所有断言都以 `base.docx` 为基准。若入库字节被静默替换，或
  // gen_docx.py 漂移（比如有人改了标题层级），基准就变了而测试仍可能"看起来通过"。
  // 这条断言让"基准本身"也进入受控状态。变红意味着：要么换了语料，要么生成脚本改了结构。
  const gen = join(TMP, 'base_gen.docx')
  assert.ok(existsSync(gen), 'gen_docx.py 未产出文件')
  assert.equal(readDocxRaw(gen), readDocxRaw(BASE))
})

// ---------------------------------------------------------------------------
// 二、read 的字段契约
// ---------------------------------------------------------------------------

test('read 字段集合：段落块只有 {kind,text}、表格块只有 {kind,rows}，且当前没有 id', () => {
  // 为什么重要：这是 read→write 的**线格式**。S1 的 C1/C2 要往这里加 id、baseVersion、
  // ops 等字段；在这之前先把"当前只有一个 kind/text（或 rows）"钉死，才能确信后续
  // 新增字段是有意为之、而不是顺手多吐了一个字段把下游（AI 提示词/合并器）带歪。
  const j = readDocx(BASE)
  assert.equal(j.ok, true)
  assert.ok(Array.isArray(j.blocks))
  assert.equal(j.blocks.length, 17)

  let paraCount = 0
  let tableCount = 0
  for (const b of j.blocks) {
    assert.ok(PARA_KINDS.has(b.kind) || b.kind === 'table', `未知 kind：${b.kind}`)
    // TODO-C2：稳定 blockId 落地后，这里的字段集合会多出 `id`——届时同步更新本断言
    assert.ok(!('id' in b), `当前不应有 id（C2 之前）：${JSON.stringify(b).slice(0, 80)}`)
    if (b.kind === 'table') {
      tableCount += 1
      assert.deepEqual(Object.keys(b).sort(), ['kind', 'rows'])
      assert.ok(Array.isArray(b.rows) && b.rows.every((r) => Array.isArray(r)))
    } else {
      paraCount += 1
      assert.deepEqual(Object.keys(b).sort(), ['kind', 'text'])
      assert.equal(typeof b.text, 'string')
    }
  }
  assert.equal(paraCount, 15)
  assert.equal(tableCount, 2)
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

test('【不变量】T2 稳定：真 Word 重存后的 word_resaved.docx 与 base.docx 的 read 输出完全相同', () => {
  // 为什么重要：这条解除"两种编辑入口混用"的最大顾虑——用户在 Word 里打开又保存
  // （内容一字未改，但 Word 会重组 zip、重切 run），块级解析必须仍然认得出来。
  // 若变红：Word 的 run 重切已经影响到我们读到的块序列，块对齐会全线失准。
  // 注意这是"入库的真 Word 字节"，不是脚本生成的（见 office-fixtures/README.md）。
  assert.equal(readDocxRaw(RESAVED), readDocxRaw(BASE))
})

// ---------------------------------------------------------------------------
// 四、【锁现状 + TODO】B3 块序 ≠ 文档真序
// ---------------------------------------------------------------------------

test('TODO-C2: B3 现状——read 先遍历段落再遍历表格，两个表格全被堆到末尾（≠ 文档真序）', () => {
  // 为什么锁它：`read_docx` 是「先 doc.paragraphs 再 doc.tables」，两个独立序列拼起来，
  // **交错关系彻底丢失**。后果不是"显示难看"，而是：块序错位 ⇒ 任何按序对齐的合并
  // （LCS/按位）都会把"表格前的那段"和"表格后的那段"判成同一位置。
  //
  // C2 之后此断言必须**反转为"表格穿插的真序"**：期望块序里 table 出现在它原本的位置。
  // 反转做法：把下面的 kinds 断言换成真序（trueBodyOrder 已经是真序，可直接比对）。
  const j = readDocx(BASE)
  const kinds = j.blocks.map((b) => (b.kind === 'table' ? 'T' : b.kind)).join('')
  assert.equal(kinds, 'h1ppph2pph3ppph2pppTT', '当前现状：1ppp2pp3ppp2pppTT（T 全在末尾）')

  // 现状的两个侧面，写清楚免得被"看起来对"糊弄：
  assert.ok(j.blocks.slice(15).every((b) => b.kind === 'table'), '末尾 2 块都是表格')
  assert.ok(j.blocks.slice(0, 15).every((b) => b.kind !== 'table'), '前 15 块都是段落')

  // 而文档真序里，**表格出现在最后一段之前** ⇒ 这正是不等于真序的证据
  const order = trueBodyOrder(BASE)
  assert.ok(order.includes('tbl'))
  assert.ok(order.indexOf('tbl') < order.lastIndexOf('p'), '真序中表格应先于末尾段落出现')
})

// ---------------------------------------------------------------------------
// 五、【锁现状 + TODO】B1 按位 zip：静默截断 / 静默丢弃
// ---------------------------------------------------------------------------

test('TODO-C1: B1 现状——写入的段落块多于文档实际时，多出的块被静默丢弃且返回 ok:true', () => {
  // 为什么锁它：这是 FINDINGS.md 判为「🔴 阻断」的那条。`zip(paras, doc.paragraphs)`
  // 短序列结束即停，**多出来的合并结果直接消失，却谎报 `{"ok":true}`**。
  // 协同场景里这等于"用户的改动被无声吞掉"，比报错危害大得多。
  //
  // C1 之后此断言必须**反转**：应改为「块数与文档不符 ⇒ 显式报错（不得静默）」。
  const p = freshCopy('b1-more')
  const j0 = readDocx(BASE)
  const ghost = '【幽灵段】不应出现在文档中'
  const res = writeDocx({ path: p, blocks: [...j0.blocks, { kind: 'p', text: ghost }] })
  assert.equal(res.ok, true, '现状：静默接受并谎报成功')

  const j1 = readDocx(p)
  assert.equal(j1.blocks.length, 17, '现状：文档段落数未变（第 16 段从未被写入）')
  assert.ok(!j1.blocks.some((b) => (b.text || '').includes('幽灵段')), '现状：多出的块被丢弃')
})

test('TODO-C1: B1 现状——写入的段落块少于文档实际时，其余段落被静默保留（不报错）', () => {
  // 为什么锁它：zip 的另一面。传 3 个段落块进去，只有前 3 段被覆盖，**第 4 段及以后
  // 原样留下**，同样返回 ok:true。调用方无法从返回值分辨"写全了"还是"只写了前 3 段"。
  // C1 之后此断言必须**反转**为「显式报错」（或由 ops 语义显式表达"只改这三段"）。
  const p = freshCopy('b1-fewer')
  const j0 = readDocx(BASE)
  const paras = j0.blocks.filter((b) => b.kind !== 'table')
  const tables = j0.blocks.filter((b) => b.kind === 'table')
  const short = [{ kind: 'p', text: '改写第0段' }, paras[1], paras[2], ...tables]

  const res = writeDocx({ path: p, blocks: short })
  assert.equal(res.ok, true, '现状：静默接受')

  const j1 = readDocx(p)
  assert.equal(j1.blocks.length, 17, '段落数不变——未传入的段落原样保留')
  assert.equal(j1.blocks[0].text, '改写第0段', '传入的前 3 段被覆盖（第 0 段）')
  assert.equal(j1.blocks[5].text, j0.blocks[5].text, '第 5 段未传入 ⇒ 原文照旧')
})

// ---------------------------------------------------------------------------
// 六、【不变量】写回文本确实生效
// ---------------------------------------------------------------------------

test('【不变量】写回生效：改一段文字后重新 read 能看到新文字', () => {
  // 为什么重要：上面几条锁的都是"缺陷"，如果只有它们，那么一个「什么都不写」的实现
  // 也能全绿。本条是最基本的正向保证：write 确实改了文档，且 read 能读回来。
  const p = freshCopy('write-ok')
  const j0 = readDocx(BASE)
  const NEW = '【校验】本期目标为打通采集、校验、汇总三个环节。'
  const blocks = j0.blocks.map((b, i) => (i === 5 ? { kind: b.kind, text: NEW } : b))

  const res = writeDocx({ path: p, blocks })
  assert.equal(res.ok, true)
  assert.equal(readDocx(p).blocks[5].text, NEW)
  // 顺带钉住"只改了一段"：邻居段未被波及
  assert.equal(readDocx(p).blocks[6].text, j0.blocks[6].text)
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

  const j0 = readDocx(BASE)
  const blocks = j0.blocks.map((b, i) => (i === 3 ? { kind: b.kind, text: NEW } : b))
  assert.equal(writeDocx({ path: p, blocks }).ok, true)

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
