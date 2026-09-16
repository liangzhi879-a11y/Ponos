// S1-6：三路合并对拍（spec §10 的 T5/T6/T7/T9 与 B2）
// ---------------------------------------------------------------------------
// spec §5.4 定义协同流程为"base + mine + theirs 三路合并（内容对齐）"，本文件就是它的验收：
//   T5 甲改第 5 段、乙改第 9 段 → 0 冲突，两处都保住
//   T6 甲改一段、乙插一段       → 0 冲突，插入被吸收
//   T7 甲乙改同一段            → **1 冲突**（要报出来，不能悄悄取舍）
//   T9 xlsx 甲乙改不同单元格    → 0 冲突，两处都保住
//   B2 同表甲乙改不同格         → 0 冲突（表格粒度下沉到单元格）
//
// 分两层验：
//  ① **纯模型层**（不 spawn python）：用合成块/行模型精确构造场景，断言合并逻辑本身。
//  ② **端到端层**：用受控语料真造出 mine/theirs 两个文件（外部编辑用探针模拟、应用内编辑走 ops），
//     读三方 → 合并 →（其中一个用例）再用 ops 把合并产物落盘并读回校验。
// 只有第 ② 层能证明"整套契约能一起工作"，但它的场景受语料限制；第 ① 层负责把边界情形（删 vs 改、
// 同位置插入、格式冲突）钉死。两层缺一不可。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundledPython, resolvePython } from '../kernel/knowledge-import.mjs'
import {
  blocksToOps, mergeDocxBlocks, mergeSheetRows, sheetMergeToOps, alignToBase, lcsPairs,
} from './office-merge.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const SERVER = join(REPO, 'server')
const FIXTURES = join(SERVER, 'office-fixtures')
const TOOLS = join(FIXTURES, 'tools')
const BASE_DOCX = join(FIXTURES, 'base.docx')
const XL_BASE = join(FIXTURES, 'xl_base.xlsx')

const TMP = mkdtempSync(join(tmpdir(), 'yfw-merge-'))
function rmRetry(p, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(p, { recursive: true, force: true }); return } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}
function py() { return resolvePython() || bundledPython() || 'python' }
let seq = 0
function cp(src, tag) {
  const p = join(TMP, `${tag}-${++seq}${src.endsWith('.xlsx') ? '.xlsx' : '.docx'}`)
  copyFileSync(src, p)
  return p
}
function runPython(script, args) {
  const r = spawnSync(py(), [script, ...args], { cwd: REPO, encoding: 'utf-8', timeout: 30000 })
  let json = null
  try { json = JSON.parse(String(r.stdout).trim()) } catch { /* 由断言暴露 */ }
  return { json, stdout: String(r.stdout), stderr: String(r.stderr) }
}
const mutate = (...args) => runPython(join(TOOLS, 'docx_mutate_probe.py'), args)
function readDocx(path) {
  const r = runPython(join(SERVER, 'docx_edit.py'), ['read', path])
  assert.equal(r.json?.ok, true, r.stdout + r.stderr)
  return r.json
}
function readSheet(path) {
  const r = runPython(join(SERVER, 'sheet_edit.py'), ['read', path])
  assert.equal(r.json?.ok, true, r.stdout + r.stderr)
  return r.json
}
function writeDocxOps(path, body) {
  const f = join(TMP, `ops-${++seq}.json`)
  writeFileSync(f, JSON.stringify(body), 'utf-8')
  return runPython(join(SERVER, 'docx_edit.py'), ['write', f])
}
function writeSheetOps(path, body) {
  const f = join(TMP, `ops-${++seq}.json`)
  writeFileSync(f, JSON.stringify(body), 'utf-8')
  return runPython(join(SERVER, 'sheet_edit.py'), ['write', f])
}

// 合成模型助手（纯模型层用）
const para = (id, text, digest = 'f0') => ({ blockId: id, kind: 'p', text, format: { digest, style: 'Normal', runFormats: 1 } })
const table = (id, rowIds, colIds, values) => ({
  blockId: id, kind: 'table',
  rows: values,
  tableCells: { rowIds, colIds, values },
  format: { digest: 't0', style: 'Table Grid' },
})

// ---------------------------------------------------------------------------
// 一、纯模型层
// ---------------------------------------------------------------------------

test('[T5] 甲改第 5 段、乙改第 9 段 ⇒ 0 冲突，两处改动都在', () => {
  const base = Array.from({ length: 12 }, (_, i) => para(`b${i}`, `第${i}段`))
  const mine = base.map((b, i) => (i === 5 ? para('m5', '甲改的第5段') : b))
  const theirs = base.map((b, i) => (i === 9 ? para('t9', '乙改的第9段') : b))
  const r = mergeDocxBlocks(base, mine, theirs)
  assert.equal(r.conflicts.length, 0, JSON.stringify(r.conflicts.map((c) => c.reason)))
  const texts = r.blocks.map((b) => b.text)
  assert.ok(texts.includes('甲改的第5段'), '甲的改动必须保住')
  assert.ok(texts.includes('乙改的第9段'), '乙的改动必须保住')
  assert.equal(r.blocks.length, 12, '块数不变（两处都是替换）')
})

test('[T6] 甲改一段、乙插一段 ⇒ 0 冲突，插入被吸收且位置正确', () => {
  const base = [para('b0', 'A'), para('b1', 'B'), para('b2', 'C')]
  const mine = [para('b0', 'A'), para('m1', 'B改'), para('b2', 'C')]
  const theirs = [para('b0', 'A'), para('x', '乙插的新段'), para('b1', 'B'), para('b2', 'C')]
  const r = mergeDocxBlocks(base, mine, theirs)
  assert.equal(r.conflicts.length, 0)
  assert.deepEqual(r.blocks.map((b) => b.text), ['A', '乙插的新段', 'B改', 'C'],
    '插入落在 A 之后、B 之前，且甲的改动也在')
})

test('[T7] 甲乙改同一段（不同文本）⇒ 恰好 1 冲突，且两侧内容都带出来', () => {
  const base = [para('b0', 'A'), para('b1', '原始这一段')]
  const mine = [base[0], para('m1', '甲改成这样')]
  const theirs = [base[0], para('t1', '乙改成那样')]
  const r = mergeDocxBlocks(base, mine, theirs)
  assert.equal(r.conflicts.length, 1, '必须报出冲突（不能悄悄取舍）')
  const c = r.conflicts[0]
  assert.equal(c.kind, 'modify-modify')
  assert.equal(c.base.text, '原始这一段')
  assert.equal(c.mine.text, '甲改成这样')
  assert.equal(c.theirs.text, '乙改成那样')
  assert.equal(r.blocks.length, 1, '冲突块不写进结果，等人工选择')
})

test('[T7 变体] 两人改成**相同**文本 ⇒ 0 冲突（结果一致就不是冲突）', () => {
  const base = [para('b1', '原始')]
  const r = mergeDocxBlocks(base, [para('m1', '改成一模一样')], [para('t1', '改成一模一样')])
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.blocks[0].text, '改成一模一样')
})

test('[B2] 同表甲乙改不同单元格 ⇒ 0 冲突，该行两处改动都保住', () => {
  const b = table('T', ['r0', 'r1', 'r2'], ['c0', 'c1', 'c2'],
    [['序号', '负责人', '数量'], ['1', '张三', '5'], ['2', '李四', '6']])
  const mine = table('T-m', ['r0', 'r1m', 'r2'], ['c0', 'c1', 'c2'],
    [['序号', '负责人', '数量'], ['1', '王五', '5'], ['2', '李四', '6']])
  const theirs = table('T-t', ['r0', 'r1t', 'r2'], ['c0', 'c1', 'c2'],
    [['序号', '负责人', '数量'], ['1', '张三', '7'], ['2', '李四', '6']])
  const r = mergeDocxBlocks([b], [mine], [theirs])
  assert.equal(r.conflicts.length, 0, JSON.stringify(r.conflicts.map((c) => c.reason)))
  assert.deepEqual(r.blocks[0].rows[1], ['1', '王五', '7'], '甲的"王五"与乙的"7"都要保住')
  assert.deepEqual(r.blocks[0].rows[2], ['2', '李四', '6'], '没动过的行不得变化')
})

test('[B2 变体] 同表同一格被两人改成不同值 ⇒ 报 1 冲突（下沉到单元格才能精确定位）', () => {
  const b = table('T', ['r1'], ['c0', 'c1'], [['x', 'y']])
  const mine = table('T-m', ['r1m'], ['c0', 'c1'], [['甲的x', 'y']])
  const theirs = table('T-t', ['r1t'], ['c0', 'c1'], [['乙的x', 'y']])
  const r = mergeDocxBlocks([b], [mine], [theirs])
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].kind, 'modify-modify')
})

test('[边界] 删 vs 改 ⇒ 冲突；两边都删 ⇒ 和平删除；同位置插入相同内容 ⇒ 只留一份', () => {
  const base = [para('b0', 'A'), para('b1', 'B'), para('b2', 'C')]

  // 甲删掉 B、乙改了 B ⇒ 无法自动判定
  const delVsEdit = mergeDocxBlocks(base, [base[0], base[2]], [base[0], para('t1', 'B改'), base[2]])
  assert.equal(delVsEdit.conflicts.length, 1)
  assert.equal(delVsEdit.conflicts[0].kind, 'delete-vs-edit')

  // 两人都删 ⇒ 共识，不报冲突
  const bothDel = mergeDocxBlocks(base, [base[0], base[2]], [base[0], base[2]])
  assert.equal(bothDel.conflicts.length, 0)
  assert.deepEqual(bothDel.blocks.map((x) => x.text), ['A', 'C'])

  // 同一位置插入完全相同的内容 ⇒ 只留一份（否则会出现两段重复）
  const sameIns = mergeDocxBlocks([base[0]], [base[0], para('mm', '新段')], [base[0], para('tt', '新段')])
  assert.equal(sameIns.conflicts.length, 0)
  assert.deepEqual(sameIns.blocks.map((x) => x.text), ['A', '新段'])

  // 同一位置插入不同内容 ⇒ 都保留（丢数据比顺序歧义更糟），顺序确定性：mine 在前
  const diffIns = mergeDocxBlocks([base[0]], [base[0], para('mm', '甲的新段')], [base[0], para('tt', '乙的新段')])
  assert.equal(diffIns.conflicts.length, 0)
  assert.deepEqual(diffIns.blocks.map((x) => x.text), ['A', '甲的新段', '乙的新段'])
})

test('[C4 联动] 仅格式不同（blockId 不变）也算改动：不得被静默丢弃', () => {
  // 没有这条，格式改动会因为"id 没变"被当成"没改"而丢失 —— 正是 C4 要防的静默丢弃。
  const base = [para('same', '同一段文字', 'f0')]
  const mine = [para('same', '同一段文字', 'f-bold')]
  const theirs = [para('same', '同一段文字', 'f0')]
  const r = mergeDocxBlocks(base, mine, theirs)
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.blocks[0].format.digest, 'f-bold', '单方格式改动必须生效')

  // 两人把同一段改成不同格式 ⇒ 冲突
  const twoFmt = mergeDocxBlocks(base, mine, [para('same', '同一段文字', 'f-italic')])
  assert.equal(twoFmt.conflicts.length, 1)
  assert.equal(twoFmt.conflicts[0].reason, 'format-conflict')
})

test('[对齐工具] LCS/对齐的基本性质：锚点不乱序，空档按位配对、数量不等记为插入', () => {
  assert.deepEqual(lcsPairs(['a', 'b', 'c'], ['a', 'c']), [[0, 0], [2, 1]])
  assert.deepEqual(lcsPairs(['a', 'b', 'c'], ['x', 'a', 'b', 'c']), [[0, 1], [1, 2], [2, 3]])

  const eq = alignToBase(['a', 'b', 'c'], ['a', 'B2', 'c'])
  assert.deepEqual(eq.counterpart, [0, 1, 2], '等长空档按位置配对（视为"这一段被改了"）')
  assert.deepEqual(eq.inserts, [])

  const ins = alignToBase(['a', 'b'], ['a', 'x', 'b'])
  assert.deepEqual(ins.counterpart, [0, 2])
  assert.deepEqual(ins.inserts, [{ after: 0, units: [1] }], '多出来的记为插入，锚在 a 之后')
})

// ---------------------------------------------------------------------------
// 二、端到端层（真文件 + 真读写）
// ---------------------------------------------------------------------------

test('[端到端 T5/T6] 外部编辑造 mine/theirs → 读三方 → 合并 → 0 冲突', () => {
  const baseP = cp(BASE_DOCX, 'e2e-base')
  const mineP = cp(BASE_DOCX, 'e2e-mine')
  const theirsP = cp(BASE_DOCX, 'e2e-theirs')

  assert.equal(mutate('set-text', mineP, '5', '甲把第 5 段改了').json?.ok, true)
  assert.equal(mutate('set-text', theirsP, '9', '乙把第 9 段改了').json?.ok, true)
  const r1 = mergeDocxBlocks(readDocx(baseP).blocks, readDocx(mineP).blocks, readDocx(theirsP).blocks)
  assert.equal(r1.conflicts.length, 0, JSON.stringify(r1.conflicts.map((c) => c.reason)))
  const texts1 = r1.blocks.map((b) => b.text)
  assert.ok(texts1.includes('甲把第 5 段改了'))
  assert.ok(texts1.includes('乙把第 9 段改了'))

  // T6：甲改一段 + 乙插一段
  const theirs2 = cp(BASE_DOCX, 'e2e-theirs2')
  assert.equal(mutate('insert-para', theirs2, '2', '乙插入的新段落').json?.ok, true)
  const r2 = mergeDocxBlocks(readDocx(baseP).blocks, readDocx(mineP).blocks, readDocx(theirs2).blocks)
  assert.equal(r2.conflicts.length, 0, JSON.stringify(r2.conflicts.map((c) => c.reason)))
  const texts2 = r2.blocks.map((b) => b.text)
  assert.ok(texts2.includes('甲把第 5 段改了'))
  assert.ok(texts2.includes('乙插入的新段落'))
  assert.equal(r2.blocks.length, readDocx(baseP).blocks.length + 1, '只多出插入的那一段')
})

test('[端到端 T7] 两人改同一段 ⇒ 1 冲突', () => {
  const baseP = cp(BASE_DOCX, 't7-base')
  const mineP = cp(BASE_DOCX, 't7-mine')
  const theirsP = cp(BASE_DOCX, 't7-theirs')
  assert.equal(mutate('set-text', mineP, '5', '甲的说法').json?.ok, true)
  assert.equal(mutate('set-text', theirsP, '5', '乙的说法').json?.ok, true)
  const r = mergeDocxBlocks(readDocx(baseP).blocks, readDocx(mineP).blocks, readDocx(theirsP).blocks)
  assert.equal(r.conflicts.length, 1, `期望恰好 1 冲突，实际 ${r.conflicts.length}`)
  assert.equal(r.conflicts[0].kind, 'modify-modify')
  assert.equal(r.conflicts[0].mine.text, '甲的说法')
  assert.equal(r.conflicts[0].theirs.text, '乙的说法')
})

test('[端到端 T9] xlsx 两人改不同单元格 ⇒ 0 冲突，两处都保住', () => {
  const baseP = cp(XL_BASE, 't9-base')
  const base = readSheet(baseP).sheets[0]
  const mineP = cp(XL_BASE, 't9-mine')
  const theirsP = cp(XL_BASE, 't9-theirs')

  // 应用内编辑走 ops（这正是真实路径：前端按 rowId/colId 提交）
  const mw = writeSheetOps(mineP, {
    path: mineP, sheet: base.name, baseVersion: readSheet(mineP).baseVersion,
    ops: [{ op: 'updateCell', rowId: base.rowIds[1], colId: base.colIds[0], value: '甲改的格' }],
  })
  assert.equal(mw.json?.ok, true, mw.stdout + mw.stderr)
  const tw = writeSheetOps(theirsP, {
    path: theirsP, sheet: base.name, baseVersion: readSheet(theirsP).baseVersion,
    ops: [{ op: 'updateCell', rowId: base.rowIds[1], colId: base.colIds[1], value: '乙改的格' }],
  })
  assert.equal(tw.json?.ok, true, tw.stdout + tw.stderr)

  const r = mergeSheetRows(base, readSheet(mineP).sheets[0], readSheet(theirsP).sheets[0])
  assert.equal(r.conflicts.length, 0, JSON.stringify(r.conflicts.map((c) => c.reason)))
  assert.equal(r.rows[1][0], '甲改的格', '甲的改动保住')
  assert.equal(r.rows[1][1], '乙改的格', '乙的改动保住')
  assert.equal(r.rows[2][0], base.rows[2][0], '没动过的行不变')
})

test('[端到端 B2] 同表两人改不同单元格 ⇒ 0 冲突（真文件）', () => {
  const baseP = cp(BASE_DOCX, 'b2-base')
  const mineP = cp(BASE_DOCX, 'b2-mine')
  const theirsP = cp(BASE_DOCX, 'b2-theirs')
  assert.equal(mutate('table-set-cell', mineP, '0', '1', '0', '甲改').json?.ok, true)
  assert.equal(mutate('table-set-cell', theirsP, '0', '1', '1', '乙改').json?.ok, true)

  const base = readDocx(baseP).blocks
  const r = mergeDocxBlocks(base, readDocx(mineP).blocks, readDocx(theirsP).blocks)
  assert.equal(r.conflicts.length, 0, JSON.stringify(r.conflicts.map((c) => c.reason)))

  const ti = base.findIndex((b) => b.kind === 'table')
  const mergedTable = r.blocks[ti]
  assert.equal(mergedTable.rows[1][0], '甲改', '甲改的格保住')
  assert.equal(mergedTable.rows[1][1], '乙改', '乙改的格保住')
  assert.deepEqual(mergedTable.rows[0], base[ti].rows[0], '表头未被波及')
})

test('[端到端闭环] 合并产物 → ops → 落盘 → 读回：文件内容等于合并结果', () => {
  // "能算出合并结果"不等于"能把结果存回去"。这条把 S1 的两端接起来验：
  // 合并（blocksToOps）→ 写入（/write-docx 的同一套 ops 契约）→ 读回比对。
  const baseP = cp(BASE_DOCX, 'loop-base')
  const mineP = cp(BASE_DOCX, 'loop-mine')
  const theirsP = cp(BASE_DOCX, 'loop-theirs')
  assert.equal(mutate('set-text', mineP, '5', '甲改第 5 段').json?.ok, true)
  assert.equal(mutate('insert-para', theirsP, '2', '乙插的新段').json?.ok, true)

  const base = readDocx(baseP).blocks
  const merged = mergeDocxBlocks(base, readDocx(mineP).blocks, readDocx(theirsP).blocks)
  assert.equal(merged.conflicts.length, 0)

  const ops = blocksToOps(base, merged.blocks)
  assert.ok(ops.length >= 2, `至少要有一个 update 和一个 insert，实际：${JSON.stringify(ops)}`)

  const w = writeDocxOps(baseP, { path: baseP, baseVersion: readDocx(baseP).baseVersion, ops })
  assert.equal(w.json?.ok, true, w.stdout + w.stderr)

  const after = readDocx(baseP).blocks
  assert.deepEqual(after.map((b) => b.text ?? `[table:${b.rows.length}x${b.rows[0].length}]`),
    merged.blocks.map((b) => b.text ?? `[table:${b.rows.length}x${b.rows[0].length}]`),
    '落盘后的块序列必须与合并结果一致')
})

test('[端到端闭环 T9] xlsx 合并产物 → ops → 落盘 → 读回', () => {
  const baseP = cp(XL_BASE, 'loop9-base')
  const base = readSheet(baseP).sheets[0]
  const mineP = cp(XL_BASE, 'loop9-mine')
  const theirsP = cp(XL_BASE, 'loop9-theirs')
  const mw = writeSheetOps(mineP, { path: mineP, sheet: base.name, baseVersion: readSheet(mineP).baseVersion, ops: [{ op: 'updateCell', rowId: base.rowIds[1], colId: base.colIds[0], value: '甲' }] })
  assert.equal(mw.json?.ok, true)
  const tw = writeSheetOps(theirsP, { path: theirsP, sheet: base.name, baseVersion: readSheet(theirsP).baseVersion, ops: [{ op: 'updateCell', rowId: base.rowIds[2], colId: base.colIds[1], value: '乙' }] })
  assert.equal(tw.json?.ok, true)

  const merged = mergeSheetRows(base, readSheet(mineP).sheets[0], readSheet(theirsP).sheets[0])
  assert.equal(merged.conflicts.length, 0)

  const ops = sheetMergeToOps(base, merged.rows)
  assert.equal(ops.length, 2, `应为 2 个单元格改动，实际 ${JSON.stringify(ops)}`)
  const w = writeSheetOps(baseP, { path: baseP, sheet: base.name, baseVersion: readSheet(baseP).baseVersion, ops })
  assert.equal(w.json?.ok, true, w.stdout + w.stderr)

  const after = readSheet(baseP).sheets[0]
  assert.equal(after.rows[1][0], '甲')
  assert.equal(after.rows[2][1], '乙')
})
