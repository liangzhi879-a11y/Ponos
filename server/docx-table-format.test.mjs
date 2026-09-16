// S1 步骤 5：C3（表格降维，双视图）与 C4（格式指纹 + 噪声归一化）
// ---------------------------------------------------------------------------
// 两条 D 级缺陷的正面验收：
//   B4（格式完全不可见）：只读 p.text ⇒ "仅把某段改粗体"会被判定为块序列**完全一致**。
//        → C4 让每个块携带 `format`（段级 pPr + run 级 rPr 摘要），验收标准 §10-S1-5
//          "格式变更不再被判定为无变化"。
//   B2（表格原子性）：整表作为一个块 ⇒ 甲改 (1,1)、乙改 (1,2) 被误判为 1 冲突。
//        → C3 降维出 `tableCells`（行 id + 列 id + 单元格网格），合并粒度下沉到单元格。
//
// 本文件同时承担 spec 点名的**联调验收项**：C4 引入格式指纹后**重验 T2**
// （Word 重存可能改变格式的 XML 表示）。实测确实存在两处真实噪声，已在实现里归一化：
//   ① `w:pStyle/@w:val`：python-docx 写样式名（`Heading1`），Word 重存写 styleId（`3`）；
//   ② Word 把样式里继承的外观**物化**成直接格式（表补 `tblBorders` 等；单元格段落补 `w:spacing`）。
// 断言里保留了"原始 XML 确实不同"的证据 —— 否则"归一化生效"和"这批文件恰好没差异"无法区分。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundledPython, resolvePython } from '../kernel/knowledge-import.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const SCRIPT = join(__dirname, 'docx_edit.py')
const FIXTURES = join(__dirname, 'office-fixtures')
const TOOLS = join(FIXTURES, 'tools')
const BASE = join(FIXTURES, 'base.docx')
const RESAVED = join(FIXTURES, 'word_resaved.docx')

const TMP = mkdtempSync(join(tmpdir(), 'yfw-docx-fmt-'))

function rmRetry(p, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(p, { recursive: true, force: true }); return } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}
function py() { return resolvePython() || bundledPython() || 'python' }
function run(script, args) {
  const r = spawnSync(py(), [join(TOOLS, script), ...args], { cwd: REPO, encoding: 'utf-8', timeout: 30000 })
  let json = null
  try { json = JSON.parse(String(r.stdout).trim()) } catch { /* 由断言暴露 */ }
  return { json, stdout: String(r.stdout), stderr: String(r.stderr) }
}
function readBlocks(path) {
  const r = spawnSync(py(), [SCRIPT, 'read', path], { cwd: REPO, encoding: 'utf-8', timeout: 30000 })
  const j = JSON.parse(String(r.stdout).trim())
  assert.equal(j.ok, true, String(r.stdout) + String(r.stderr))
  return j.blocks
}
let seq = 0
function freshCopy(name) {
  const p = join(TMP, `${name}-${++seq}.docx`)
  copyFileSync(BASE, p)
  return p
}
/** 从"原始 XML"取每段的 pStyle/@w:val（绕过本仓库的归一化，看**文件里真实写着什么**）。 */
function rawPStyleVals(path) {
  const code = [
    'import sys,json',
    'from docx import Document',
    'from docx.oxml.ns import qn',
    'd=Document(sys.argv[1])',
    'out=[]',
    'for p in d.paragraphs:',
    '    ppr=p._p.find(qn("w:pPr"))',
    '    st=ppr.find(qn("w:pStyle")) if ppr is not None else None',
    '    out.append(st.get(qn("w:val")) if st is not None else None)',
    'print(json.dumps(out))',
  ].join('\n')
  const r = spawnSync(py(), ['-c', code, path], { encoding: 'utf-8', timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(String(r.stdout).trim())
}

// ---------------------------------------------------------------------------
// 一、C4：格式指纹
// ---------------------------------------------------------------------------

test('[C4] 块携带格式指纹：段落 {digest,style,runFormats}、表格 {digest,style}', () => {
  const blocks = readBlocks(BASE)
  for (const b of blocks) {
    assert.ok(b.format, `每个块都必须带 format：${b.kind}`)
    assert.match(b.format.digest, /^[0-9a-f]{12}$/, '格式摘要为 12 位十六进制')
    assert.equal(typeof b.format.style === 'string' || b.format.style === null, true)
    if (b.kind !== 'table') {
      assert.deepEqual(Object.keys(b.format).sort(), ['digest', 'runFormats', 'style'])
      assert.ok(Number.isInteger(b.format.runFormats) && b.format.runFormats >= 0)
    }
  }
  // 标题块的样式名必须被解析出来（否则"改了标题层级"这类真变更也看不见）
  const h1 = blocks.find((b) => b.kind === 'h1')
  assert.match(String(h1.format.style), /Heading/i, '标题块应带标题样式名')
})

test('[C4/B4] 只改一处粗体 ⇒ 格式摘要变化（不再"判定为无变化"），且 blockId 保持稳定', () => {
  // B4 的旧信号：只比较文本 ⇒ 块序列**完全一致**，格式改动不可见。这里把两个信号都断言出来：
  // 文本信号仍相同（说明旧口径确实检测不到），格式摘要必须变化（新口径检测得到）。
  const p = freshCopy('c4-bold')
  const before = readBlocks(p)
  const mut = run('docx_mutate_probe.py', ['bold', p, '1'])
  assert.equal(mut.json?.ok, true, mut.stdout + mut.stderr)
  const after = readBlocks(p)

  const textOf = (bs) => bs.map((b) => `${b.kind}:${b.text ?? ''}`)
  assert.deepEqual(textOf(after), textOf(before), '旧口径（只看文本）确实看不出这次改动 —— 这就是 B4')

  assert.notEqual(after[1].format.digest, before[1].format.digest, 'C4：格式摘要必须变化')
  assert.equal(after[1].blockId, before[1].blockId,
    'blockId 不含格式（实测修正 D-2）：这样"甲改格式 + 乙改文字"落在同一 id 上可合并；' +
    '若把格式并进 id，二者会退化成"删除+新增"而必然互斥')

  // 判别力要精确：其余块的格式摘要一律不得变（否则"改一处"会看起来像"改了很多处"）
  const changed = before.filter((b, i) => b.format.digest !== after[i].format.digest).length
  assert.equal(changed, 1, `应恰好 1 个块的格式摘要变化，实际 ${changed}`)
})

test('[C4/T2 重验] base 与真 Word 重存件：blocks 完全相等（含格式字段）—— 联调验收项', () => {
  // spec 点名"这是 C2+C4 的联调验收项"。这条一旦红，意味着"用户在 Word 里打开又保存"
  // 会让格式指纹全线漂移 ⇒ 整篇被判成"格式全改了"。
  const a = readBlocks(BASE)
  const b = readBlocks(RESAVED)
  assert.deepEqual(b, a, 'Word 重存不得改变块序列、blockId 或格式摘要')

  // 关键补充证据：两个文件里**原始 XML 确实不同**（pStyle 的 val 一个写样式名、一个写 styleId）。
  // 没有这条，"blocks 相等"可能只是"这批文件恰好没差异"，看不出归一化是否真的在起作用。
  const ra = rawPStyleVals(BASE)
  const rb = rawPStyleVals(RESAVED)
  const raSet = new Set(ra.filter(Boolean))
  const rbSet = new Set(rb.filter(Boolean))
  assert.notDeepEqual([...raSet].sort(), [...rbSet].sort(),
    '两个文件的原始 pStyle/@w:val 取值应当不同（否则本用例退化为"没有噪声可测"）')
  assert.ok([...rbSet].some((v) => /^\d+$/.test(v)), `重存件的 pStyle/@w:val 应为 styleId 形态，实测：${[...rbSet]}`)
  assert.ok([...raSet].some((v) => /^Heading/.test(v)), `原始件的 pStyle/@w:val 应为样式名形态，实测：${[...raSet]}`)
})

test('[C4] 表格级格式：真实表级变更可见，而 Word 物化出的属性不算变更', () => {
  const p = freshCopy('c4-table')
  const before = readBlocks(p)
  const ti = before.findIndex((b) => b.kind === 'table')
  assert.ok(ti >= 0)

  // 表级真变更：加 w:jc=center（**不在**"物化组"里）
  const mut = run('docx_mutate_probe.py', ['table-jc', p, '0'])
  assert.equal(mut.json?.ok, true, mut.stdout + mut.stderr)
  const after = readBlocks(p)
  assert.notEqual(after[ti].format.digest, before[ti].format.digest, '表级格式变更必须可见')
  assert.equal(after[ti].blockId, before[ti].blockId, '表级格式变更同样不改 blockId')
  assert.equal(after[ti].rows.length, before[ti].rows.length, '这只是格式变更，结构不变')

  // 反面：Word 重存补写的 tblBorders/tblCellMar/… 属"物化"，不得被判成变更 ——
  // 由上面 T2 用例的 deepEqual 覆盖；这里再点明它为什么必须如此。
  const resaved = readBlocks(RESAVED)
  const bi = before.findIndex((b) => b.kind === 'table')
  assert.equal(resaved[bi].format.digest, before[bi].format.digest,
    '物化属性（表样式继承来的边框/边距/布局）必须被剔除，否则 T2 必红')
})

// ---------------------------------------------------------------------------
// 二、C3：表格降维（双视图）
// ---------------------------------------------------------------------------

test('[C3] 双视图：粗粒度 rows 保留，细粒度 tableCells 给出 rowIds/colIds/values 且尺寸对齐', () => {
  const blocks = readBlocks(BASE)
  const t = blocks.find((b) => b.kind === 'table')
  assert.ok(Array.isArray(t.rows) && t.rows.length > 0, '粗视图 rows 必须保留（D-3：不改编辑器 UI）')

  const tc = t.tableCells
  assert.ok(tc, '必须有细粒度视图')
  assert.deepEqual(Object.keys(tc).sort(), ['colIds', 'rowIds', 'values'])
  assert.equal(tc.rowIds.length, t.rows.length, 'rowIds 与行数同长')
  assert.equal(tc.values.length, t.rows.length, 'values 与行数同长')
  assert.equal(tc.colIds.length, tc.values[0].length, 'colIds 与列数同长')
  assert.equal(new Set(tc.rowIds).size, tc.rowIds.length, 'rowIds 唯一')
  assert.equal(new Set(tc.colIds).size, tc.colIds.length, 'colIds 唯一')
  // 粗视图与细视图必须是**同一份数据**（否则两个视图会各自漂移）
  assert.deepEqual(tc.values, t.rows.map((r) => r.slice()), 'values 与 rows 内容一致')
})

test('[C3/B2] 粒度下沉到单元格：改一个格 ⇒ 只有该格变化，同表其他格不受影响', () => {
  // B2 的模型层证据：整表原子时"甲改 (1,1)、乙改 (1,2)"无法区分，只能整体冲突；
  // 有单元格身份后，可精确指出"变的是这一格"，从而支持自动合成。
  const p = freshCopy('c3-cell')
  const before = readBlocks(p)
  const ti = before.findIndex((b) => b.kind === 'table')
  const t0 = before[ti]

  // 直接改文件里的一个单元格文本（模拟"外部程序改了 1 个格"）
  const code = [
    'import sys',
    'from docx import Document',
    'd=Document(sys.argv[1])',
    'd.tables[0].cell(1,1).text="C3-只改这一格"',
    'd.save(sys.argv[1])',
  ].join('\n')
  const r = spawnSync(py(), ['-c', code, p], { encoding: 'utf-8', timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)

  const after = readBlocks(p)
  const t1 = after[ti]

  // 以"基线单元格身份"为坐标框架逐格比较（这就是合并器要做的事）
  const cellKey = (tc, r, c) => `${tc.rowIds[r]}#${tc.colIds[c]}`
  let changed = 0
  const changedAt = []
  for (let r0 = 0; r0 < t0.tableCells.values.length; r0++) {
    for (let c0 = 0; c0 < t0.tableCells.colIds.length; c0++) {
      // 用**基线行 id** 找到该行在新版本里的位置（内容改了 ⇒ 行 id 会变，故按基线的 rowId 定位不到时用下标兜底）
      const baseKey = cellKey(t0.tableCells, r0, c0)
      const newKey = t1.tableCells.rowIds[r0] ? `${t1.tableCells.rowIds[r0]}#${t1.tableCells.colIds[c0]}` : ''
      if (t0.tableCells.values[r0][c0] !== t1.tableCells.values[r0][c0]) { changed++; changedAt.push(`${baseKey}${newKey ? '' : ''}`) }
    }
  }
  assert.equal(changed, 1, `应恰好 1 个单元格内容变化，实际 ${changed}（整表原子会报"整表都变了"）`)
  assert.equal(t1.tableCells.values[1][1], 'C3-只改这一格')
  assert.deepEqual(t1.rows.length, t0.rows.length, '行数不变')

  // 行身份口径：被改的那一行行 id 变了，其他行不变 —— 说明身份按内容算，且变化范围被限制在那一行
  const rowChanged = t0.tableCells.rowIds.filter((id, i) => id !== t1.tableCells.rowIds[i]).length
  assert.equal(rowChanged, 1, `应恰好 1 个行 id 变化，实际 ${rowChanged}`)
})

test('[C3/B6 表格版] 表中插一行（全新内容）⇒ 行身份支持"1 处插入 + 0 处修改"', () => {
  // 与 xlsx 的 B6 同一诉求：行号寻址下"插一行"会让其后所有行被判成"被改"。
  // 注意此处必须插入**全新内容**的行：若复制既有行（内容相同），纯内容指纹要靠"出现序号"消歧
  // ⇒ 后续同内容行序号漂移，恰好命中 D-2 登记的已知限制，"0 处修改"这条性质就测不出来了。
  const p = freshCopy('c3-insrow')
  const before = readBlocks(p)
  const ti = before.findIndex((b) => b.kind === 'table')
  const t0 = before[ti].tableCells

  const mut = run('docx_mutate_probe.py', ['insert-row', p, '0', '1', 'C3-新行'])
  assert.equal(mut.json?.ok, true, mut.stdout + mut.stderr)

  const after = readBlocks(p)
  const t1 = after[ti].tableCells
  assert.equal(t1.rowIds.length, t0.rowIds.length + 1, '多了一行')

  const missing = t0.rowIds.filter((id) => !t1.rowIds.includes(id))
  const added = t1.rowIds.filter((id) => !t0.rowIds.includes(id))
  assert.deepEqual(missing, [], '基线的行 id 一个都不能消失（否则会被判成"整行被删+新增"）')
  assert.equal(added.length, 1, '只多出 1 个新行 id ⇒ 1 处插入 + 0 处修改')

  // 行号口径的对照：按位置比较必然误报。**不写死数量**：误报数取决于表长与插入点
  // （受控语料这张表只有 2 行 + 插在第 1 行后 ⇒ 实测误报 1 处），写死会随语料变化而假红。
  // 要断言的是**性质差异**：指纹口径 0 处修改，行号口径 >0 处。
  const positionalDiff = t0.rowIds.reduce((n, id, i) => n + (id === t1.rowIds[i] ? 0 : 1), 0)
  assert.ok(positionalDiff > 0,
    `行号寻址必须产生假修改（实测 ${positionalDiff} 处）；而指纹口径的"被修改行数"是 0 —— 这就是 C3/B6 要的性质差异`)
})

test('[C3] 细粒度视图不破坏旧契约：插行后 rows 与 tableCells 仍一致（双视图同步）', () => {
  const p = freshCopy('c3-sync')
  const mut = run('docx_mutate_probe.py', ['dup-row', p, '0', '2'])
  assert.equal(mut.json?.ok, true, mut.stdout + mut.stderr)
  const t = readBlocks(p).find((b) => b.kind === 'table')
  assert.deepEqual(t.tableCells.values, t.rows.map((r) => r.slice()),
    '两个视图必须始终指向同一份内容 —— 否则前端（读 rows）与合并器（读 tableCells）会不一致')
})
