// server/office-merge-exec.test.mjs —— `edit-merge` 接线（执行编排）的验证
// ---------------------------------------------------------------------------
// 背景：`shared/office-merge.mjs` 有算法+ops，`server/office-routes.mjs` 有读写原语，但**没人把它们接起来**，
// 于是用户在冲突弹窗选「进入编辑器逐处合并」后什么都不会发生。`server/office-merge-exec.mjs` 补的就是这段
// 编排。因此本测试的重点不是再测一遍算法（`shared/office-merge.test.mjs` 已覆盖 T5/T6/T7/T9/B2 与落盘闭环），
// 而是验证**编排本身**：
//   · 真的把结果写进了磁盘（读回文件确认两处改动都在）——不是"回报成功"就算数；
//   · 有冲突时**绝不写盘**（宁可回报冲突，也不给出一个合了一半的文件）；
//   · 多表工作簿按表分次写、**版本号滚动**（第二张表必须用第一张表写回的新版本，否则第二笔必然 409）；
//   · 各种失败路径都有**明确 reason**（不静默返回 ok，也不抛栈给上层）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveReadable, resolveWritable, assertSizeOk } from '../shared/fs-guard.mjs'
import { resolvePython } from '../kernel/knowledge-import.mjs'
import { createOfficeAccess } from './office-routes.mjs'
import { executeOfficeMerge, modalityOf } from './office-merge-exec.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(HERE, 'office-fixtures', 'tools')
const FIXTURE_DOCX = join(HERE, 'office-fixtures', 'base.docx')
const FIXTURE_XLSX = join(HERE, 'office-fixtures', 'xl_base.xlsx')

const TMP = mkdtempSync(join(tmpdir(), 'yfw-merge-exec-test-'))
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ } })

// office 出口：与 bridge.mjs 里给 collab 的构造方式一致（同一套 roots/guard）
const office = createOfficeAccess({
  sep,
  roots: { read: [TMP], write: [TMP], writeDeny: [], credentials: [] },
  guard: { resolveReadable, resolveWritable, assertSizeOk, findPythonExe: () => resolvePython() },
})

const runPy = (script, args) => spawnSync(resolvePython(), [script, ...args], { encoding: 'utf-8' })

/** 模拟"外部程序改了文件"（与 shared/office-merge.test.mjs 用同一个探针） */
const mutate = (path, idx, text) => {
  const r = runPy(join(TOOLS, 'docx_mutate_probe.py'), ['set-text', path, String(idx), text])
  assert.equal(r.status, 0, r.stderr || r.stdout)
}

let seq = 0
/** 准备三份 docx：base=夹具原样、mine=base+改第 5 段、theirs(磁盘目标)=base+改第 9 段 */
function setupDocx () {
  const tag = `c${++seq}`
  const files = {}
  for (const which of ['base', 'mine', 'theirs']) {
    files[which] = join(TMP, `${which}-${tag}.docx`)
    copyFileSync(FIXTURE_DOCX, files[which])
  }
  mutate(files.mine, 5, `MINE-EDIT-${tag}`)
  mutate(files.theirs, 9, `THEIRS-EDIT-${tag}`)
  files.tag = tag
  return files
}

// 版本读取：真实项目里是 (teamRoot, versionId) => { ok, buf }；这里用**文件路径当版本 id**，
// 于是既测了编排，又不必搭一整套团队库（编排与"版本从哪来"本就该解耦）。
const readVersionBuffer = (_teamRoot, id) => {
  try { return { ok: true, buf: readFileSync(id) } } catch { return { ok: false } }
}

// 桩测里不需要真实版本内容（office 出口已桩掉），给个占位 buffer 即可
const anyVersion = () => ({ ok: true, buf: Buffer.from('stub') })

const readBackDocxText = async (path) => {
  const r = await office.readDocx(path)
  assert.equal(r.body?.ok, true, JSON.stringify(r.body))
  return r.body.blocks.map((b) => b.text || '').join('\n')
}

const sha = (p) => readFileSync(p).toString('base64').slice(0, 64) + ':' + readFileSync(p).length

// ── 真实链路（真 python、真文件）────────────────────────────────────────────

test('端到端（docx）：mine 改第 5 段 + 磁盘改第 9 段 ⇒ 结果真的落盘且两处改动都在文件里', async () => {
  const f = setupDocx()
  const r = await executeOfficeMerge({
    teamRoot: TMP,
    versionIds: { base: f.base, mine: f.mine, theirs: f.theirs },
    logicalName: 'base.docx',
    targetPath: f.theirs, // theirs = 磁盘当前内容
    office,
    readVersionBuffer,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.written, true, '应当真的写盘')
  assert.ok(r.ops > 0, `应当产生改动 ops，实际 ${r.ops}`)

  // **读回磁盘**确认（而不是相信返回值）
  const text = await readBackDocxText(f.theirs)
  assert.match(text, new RegExp(`MINE-EDIT-${f.tag}`), '我的第 5 段改动丢了')
  assert.match(text, new RegExp(`THEIRS-EDIT-${f.tag}`), '磁盘那份的第 9 段改动丢了')
})

test('端到端（docx）冲突：两人改同一段 ⇒ 报 conflict 且**一个字节都没动**', async () => {
  const f = setupDocx()
  mutate(f.mine, 12, `BOTH-A-${f.tag}`)
  mutate(f.theirs, 12, `BOTH-B-${f.tag}`) // 同一段、不同内容
  const before = sha(f.theirs)

  const r = await executeOfficeMerge({
    teamRoot: TMP,
    versionIds: { base: f.base, mine: f.mine, theirs: f.theirs },
    logicalName: 'base.docx',
    targetPath: f.theirs,
    office,
    readVersionBuffer,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'conflict')
  assert.ok(r.conflicts.length >= 1, '必须把冲突报出来（宁多报，不静默取舍）')
  assert.equal(sha(f.theirs), before, '有冲突时不得写盘')
})

test('端到端（docx）：三方一致 ⇒ 无改动、不写盘（written=false，而不是空写一次）', async () => {
  const tag = `s${++seq}`
  const same = join(TMP, `same-${tag}.docx`)
  copyFileSync(FIXTURE_DOCX, same) // base = mine = theirs = 夹具
  const before = sha(same)

  const r = await executeOfficeMerge({
    teamRoot: TMP,
    versionIds: { base: same, mine: same, theirs: same },
    logicalName: 'same.docx',
    targetPath: same,
    office,
    readVersionBuffer,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.written, false)
  assert.equal(r.ops, 0)
  assert.equal(sha(same), before)
})

test('端到端（xlsx）：两人改同表不同单元格 ⇒ 合并后两格都在（spec 的 B2）', async () => {
  const tag = `x${++seq}`
  const files = {}
  for (const which of ['base', 'mine', 'theirs']) {
    files[which] = join(TMP, `${which}-${tag}.xlsx`)
    copyFileSync(FIXTURE_XLSX, files[which])
  }
  const firstSheet = async (p) => {
    const r = await office.readSheet(p)
    assert.equal(r.body?.ok, true, JSON.stringify(r.body))
    return { sheet: r.body.sheets[0], baseVersion: r.body.baseVersion }
  }
  const baseRead = await firstSheet(files.base)
  const { name, rowIds, colIds } = baseRead.sheet
  // 我改第 2 列；磁盘那份改第 1 列（不同格 ⇒ 不该冲突）
  const w1 = await office.writeSheet(files.mine, name, baseRead.baseVersion, [
    { op: 'updateCell', rowId: rowIds[0], colId: colIds[1], value: `MINE-${tag}` },
  ])
  assert.equal(w1.body?.ok, true, JSON.stringify(w1.body))
  const theirsRead = await firstSheet(files.theirs)
  const w2 = await office.writeSheet(files.theirs, name, theirsRead.baseVersion, [
    { op: 'updateCell', rowId: rowIds[0], colId: colIds[0], value: `THEIRS-${tag}` },
  ])
  assert.equal(w2.body?.ok, true, JSON.stringify(w2.body))

  const r = await executeOfficeMerge({
    teamRoot: TMP,
    versionIds: { base: files.base, mine: files.mine, theirs: files.theirs },
    logicalName: `wb-${tag}.xlsx`,
    targetPath: files.theirs,
    office,
    readVersionBuffer,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.written, true)
  assert.deepEqual(r.sheets, [name])

  // 读回目标文件：对方那格仍在，我改的那格被合了进去
  const after = (await firstSheet(files.theirs)).sheet.rows[0]
  assert.equal(after[0], `THEIRS-${tag}`, '磁盘那份的改动丢了')
  assert.equal(after[1], `MINE-${tag}`, '我的改动没被合并进去')
})

// ── 编排分支（无需 python：桩掉 office 出口）────────────────────────────────

/** 桩 office：按路径尾串区分"读的是哪一侧"，并记录写调用 */
function stubOffice ({ sheetsOf, writeResults }) {
  const writes = []
  let writeIdx = 0
  return {
    writes,
    readDocx: async () => ({ status: 404, body: { ok: false, error: 'not-used' } }),
    readSheet: async (p) => ({ status: 200, body: { ok: true, baseVersion: 'V-x', sheets: sheetsOf(p) } }),
    writeDocx: async () => ({ status: 500, body: { ok: false, error: 'not-used' } }),
    writeSheet: async (path, sheet, baseVersion, ops) => {
      writes.push({ path, sheet, baseVersion, ops })
      return writeResults[writeIdx++] || { status: 200, body: { ok: true, baseVersion: 'V-ok' } }
    },
  }
}

const sheet = (name, values, id) => ({
  name,
  rows: [Array.isArray(values) ? values : [values]],
  rowIds: [id],
  colIds: values.length > 1 ? ['c1', 'c2'] : ['c1'],
  formulas: [],
})

test('多表工作簿：逐表写、且第二张表用第一张表写回的**新** baseVersion（版本号滚动）', async () => {
  // 表 A：只有我改 → 需要把我的改动写进目标
  // 表 B：两人改**同一行的不同单元格**（spec 的 B2 场景）→ 我的那格要写、对方那格已在目标里
  // 表 C：只在我这侧（表级新增）→ 不在合并范围，但必须如实回报而非静默吞掉
  const stub = stubOffice({
    sheetsOf: (p) => {
      if (p.endsWith('base.xlsx')) return [sheet('A', 'a-base', 'rA'), sheet('B', ['b1', 'b2'], 'rB')]
      if (p.endsWith('mine.xlsx')) {
        return [sheet('A', 'a-mine', 'rA'), sheet('B', ['b1', 'b2-mine'], 'rB'), sheet('C', 'c-mine', 'rC')]
      }
      return [sheet('A', 'a-base', 'rA'), sheet('B', ['b1-theirs', 'b2'], 'rB')] // 目标（磁盘）
    },
    writeResults: [
      { status: 200, body: { ok: true, baseVersion: 'V2' } }, // 写 A 后版本变为 V2
      { status: 200, body: { ok: true, baseVersion: 'V3' } },
    ],
  })

  const r = await executeOfficeMerge({
    teamRoot: TMP,
    versionIds: { base: 'base', mine: 'mine' },
    logicalName: 'wb.xlsx',
    targetPath: join(TMP, 'wb.xlsx'),
    office: stub,
    readVersionBuffer: anyVersion,
  })

  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.sheets, ['A', 'B'], '两张表都要写')
  assert.equal(stub.writes.length, 2)
  assert.equal(stub.writes[0].baseVersion, 'V-x', '第一张表用磁盘读到的版本')
  assert.equal(stub.writes[1].baseVersion, 'V2', '第二张表必须用第一张表写回的新版本（否则必然 409）')
  assert.equal(r.baseVersion, 'V3')
  assert.deepEqual(r.mineOnly, ['C'], '只在单侧出现的表必须如实回报')
})

test('多表写中途失败 ⇒ 报 write-failed、并交代**已经写下去的表**（不做静默的部分成功）', async () => {
  const stub = stubOffice({
    sheetsOf: (p) => {
      if (p.endsWith('base.xlsx')) return [sheet('A', 'a', 'rA'), sheet('B', 'b', 'rB')]
      if (p.endsWith('mine.xlsx')) return [sheet('A', 'a-mine', 'rA'), sheet('B', 'b-mine', 'rB')]
      return [sheet('A', 'a', 'rA'), sheet('B', 'b', 'rB')]
    },
    writeResults: [
      { status: 200, body: { ok: true, baseVersion: 'V2' } },
      { status: 409, body: { ok: false, error: 'version-conflict' } },
    ],
  })
  const r = await executeOfficeMerge({
    teamRoot: TMP,
    versionIds: { base: 'base', mine: 'mine' },
    logicalName: 'wb.xlsx',
    targetPath: join(TMP, 'wb.xlsx'),
    office: stub,
    readVersionBuffer: anyVersion,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'write-failed')
  assert.equal(r.sheet, 'B')
  assert.deepEqual(r.writtenSheets, ['A'], '已写下去的表要说清楚（便于人工收拾）')
})

test('失败路径都给明确 reason（不静默 ok、不抛）', async () => {
  const common = { teamRoot: TMP, versionIds: { base: 'b', mine: 'm' }, targetPath: '/x/a.docx', office }
  const un = await executeOfficeMerge({ ...common, logicalName: 'a.txt' })
  assert.deepEqual([un.ok, un.reason], [false, 'unsupported-modality'])

  const noOffice = await executeOfficeMerge({ ...common, logicalName: 'a.docx', office: null })
  assert.deepEqual([noOffice.ok, noOffice.reason], [false, 'office-unavailable'])

  const noFactory = await executeOfficeMerge({ ...common, logicalName: 'a.docx' })
  assert.deepEqual([noFactory.ok, noFactory.reason], [false, 'office-unavailable'])

  const noTarget = await executeOfficeMerge({ ...common, logicalName: 'a.docx', targetPath: null })
  assert.deepEqual([noTarget.ok, noTarget.reason], [false, 'no-target-path'])

  const badVersion = await executeOfficeMerge({
    ...common, logicalName: 'a.docx', readVersionBuffer,
  })
  assert.equal(badVersion.reason, 'version-unreadable')
  assert.equal(badVersion.which, 'base', '要说清是 base 还是 mine 读不到')
})

test('模态判定：docx/xlsx/xls 认识，其它一律 null（不猜）', () => {
  assert.equal(modalityOf('a.docx'), 'docx')
  assert.equal(modalityOf('a.xlsx'), 'sheet')
  assert.equal(modalityOf('A.XLS'), 'sheet', '扩展名判定不区分大小写')
  assert.equal(modalityOf('a.txt'), null)
  assert.equal(modalityOf(''), null)
  assert.equal(modalityOf(undefined), null)
})
