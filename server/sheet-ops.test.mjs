// S1 步骤 4：C5（行/列内容指纹）与 C6（结构操作 + 公式格只读 + ops 写入）
// ---------------------------------------------------------------------------
// 与 `sheet-python.test.mjs` 的分工：那边锁旧行为（read 幂等、写生效），这边验**新契约**。
// 两边并存不是冗余 —— 前者保证"改写没顺手弄坏别的"，后者保证"该变的确实变了"。
//
// 本文件的**核心判据**是 B6：
//   「在第 3 行插一行」在**行号寻址**下会让第 4 行起全部变成"被修改行"
//   （实测 21 行表 = 1 处插入 + **19 处假修改**）；
//   在**内容指纹寻址**下只有 1 个新行 id，其余行 id 一个不动 ⇒ 1 处插入 + **0 处修改**。
// 这一条决定了"表格能不能协同"：假修改会让人工/自动合并看到满屏冲突。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundledPython, resolvePython } from '../kernel/knowledge-import.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const SCRIPT = join(__dirname, 'sheet_edit.py')
const FIXTURES = join(__dirname, 'office-fixtures')
const XL_BASE = join(FIXTURES, 'xl_base.xlsx')
const XL_INSERT = join(FIXTURES, 'xl_insertrow.xlsx')

const TMP = mkdtempSync(join(tmpdir(), 'yfw-sheet-ops-'))

function rmRetry(p, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(p, { recursive: true, force: true }); return } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}
function py() { return resolvePython() || bundledPython() || 'python' }

function runSheet(args) {
  const r = spawnSync(py(), [SCRIPT, ...args], { cwd: REPO, encoding: 'utf-8', timeout: 30000 })
  let json = null
  try { json = JSON.parse(String(r.stdout).trim()) } catch { /* 由断言暴露 */ }
  return { code: r.status, json, stdout: String(r.stdout), stderr: String(r.stderr) }
}
function readSheet(path) {
  const r = runSheet(['read', path])
  assert.equal(r.json?.ok, true, r.stdout + r.stderr)
  return r.json
}
let seq = 0
function writeOps(body) {
  const j = join(TMP, `ops-${++seq}.json`)
  writeFileSync(j, JSON.stringify(body), 'utf-8')
  return runSheet(['write', j])
}
function freshCopy(name) {
  const p = join(TMP, `${name}-${++seq}.xlsx`)
  copyFileSync(XL_BASE, p)
  return p
}

// ---------------------------------------------------------------------------
// 一、C5：行/列内容指纹
// ---------------------------------------------------------------------------

test('[C5/B6] 插一行 ⇒ 内容指纹下 = 1 处插入 + 0 处修改（行号寻址会假报 19 处）', () => {
  // 语料 `xl_insertrow.xlsx` 就是"在 base 上插了一整行"的产物（README 有说明）。
  // 这是 C5 的存在理由：用同一份数据，对比两种寻址口径的结论差异。
  const base = readSheet(XL_BASE).sheets[0]
  const ins = readSheet(XL_INSERT).sheets[0]

  assert.equal(base.rowIds.length, 21)
  assert.equal(ins.rowIds.length, 22, '插了一行')

  // 内容指纹口径：base 的 21 个行 id 全部仍在，只多出 1 个新 id
  const missing = base.rowIds.filter((id) => !ins.rowIds.includes(id))
  const added = ins.rowIds.filter((id) => !base.rowIds.includes(id))
  assert.deepEqual(missing, [], '基线的行 id 一个都不能消失（否则会被判成"整行被删+新增"）')
  assert.equal(added.length, 1, '只多出 1 个新行 id ⇒ 1 处插入 + 0 处修改')

  // 行号口径：同样两份数据，按位置比较会得出"几乎每行都变了"的结论
  const positionalDiff = base.rowIds.reduce((n, id, i) => n + (id === ins.rowIds[i] ? 0 : 1), 0)
  assert.ok(positionalDiff >= 15,
    `行号寻址应产生大量假修改（实测 ${positionalDiff} 处）—— 这正是不能用行号寻址的证据`)
})

test('[C5] 行 id 由内容决定：改 A 行不动 B 行 id；改内容则该行 id 变', () => {
  // 这条保证"改一处 = 一处"：若改一行会让其他行 id 也变（比如掺了位置/时间），
  // 合并时每一次编辑都会看起来像改了整张表。
  const p = freshCopy('c5-stable')
  const g0 = readSheet(p).sheets[0]

  const res = writeOps({
    path: p,
    baseVersion: readSheet(p).baseVersion,
    ops: [{ op: 'updateCell', rowId: g0.rowIds[1], colId: g0.colIds[0], value: 'C5-改过了' }],
  })
  assert.equal(res.json?.ok, true, res.stdout + res.stderr)

  const g1 = readSheet(p).sheets[0]
  assert.notEqual(g1.rowIds[1], g0.rowIds[1], '被改的那一行 id 必变（内容变了）')
  for (const i of [0, 2, 3, 5, 20]) {
    assert.equal(g1.rowIds[i], g0.rowIds[i], `第 ${i} 行未被动过 ⇒ id 必须不变`)
  }
  // 列 id 也由内容决定 ⇒ 被改的第 0 列 id 变、其他列不变
  assert.notEqual(g1.colIds[0], g0.colIds[0], '被改的列 id 必变')
  assert.equal(g1.colIds[1], g0.colIds[1], '未动的列 id 不变')
})

test('[C5] 归一化：等值回写不改行 id；且 1 与 1.0、空白差异都视为同一内容', () => {
  // 为什么需要归一化：同一份表被不同程序重存后，数值可能 int↔float、文本可能多出空格。
  // 不归一化的话"没人改内容"会被判成"整行都改了"，协同里就是满屏假冲突。
  //
  // 本用例分两段：
  //  ① 端到端：把某格**按原值**写回去（语义没变）⇒ 行 id 不得变。
  //  ② 直测归一化规则本身：`1` vs `1.0`、`' a  b '` vs `'a b'` 必须归一成同一形态。
  //     （必须直测：JSON 无法区分 `5` 与 `5.0`，端到端根本递不进去 float。）
  const p = freshCopy('c5-norm')
  const g0 = readSheet(p).sheets[0]
  const idBefore = g0.rowIds[1]

  const same = g0.rows[1][0]
  const res = writeOps({
    path: p,
    baseVersion: readSheet(p).baseVersion,
    ops: [{ op: 'updateCell', rowId: idBefore, colId: g0.colIds[0], value: same }],
  })
  assert.equal(res.json?.ok, true, JSON.stringify(res.json))
  const g1 = readSheet(p).sheets[0]
  assert.equal(g1.rowIds[1], idBefore, '等值写入 ⇒ 行 id 不变（归一化生效）')
  assert.equal(g1.rows[1][0], same, '值原样保留')

  // ② 直测归一化：import 后调用内部函数（已加 `__main__` 守卫，可安全导入）
  const code =
    'import sys,json;sys.path.insert(0,sys.argv[1]);from sheet_edit import _norm_cell as n;' +
    "print(json.dumps({'n': n(1)==n(1.0), 't': n(' a  b ')==n('a b'), 'b': n(True)!=n(1), 'none': n(None)==n('')}))"
  const r = spawnSync(py(), ['-c', code, join(REPO, 'server')], { encoding: 'utf-8', timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
  const norm = JSON.parse(String(r.stdout).trim())
  assert.equal(norm.n, true, '数字 1 与 1.0 归一为同一内容')
  assert.equal(norm.t, true, '空白差异（连续空格/首尾空格）归一')
  assert.equal(norm.b, true, '布尔 True 与数字 1 必须区分（python 里 True == 1，不区分会把它们看作同值）')
  assert.equal(norm.none, false,
    '空白格(None) 与空串("") **必须区分**：Excel 语义上二者不同（ISBLANK 可判别），' +
    '归一会把"内容被清空"这类真实改动判成没变（本用例第一版就写错了这条期望）')
})

// ---------------------------------------------------------------------------
// 二、C6：ops 写入
// ---------------------------------------------------------------------------

test('[C6] updateCell 按 rowId+colId 寻址，写到正确行列；同批同行多格互不干扰', () => {
  // "同批同行多格"是身份映射设计的关键场景：若每条 op 都按"当前内容"重算行 id，
  // 第一条改完该行内容就变了、第二条立刻找不到该行 ⇒ 批量编辑必然失败。
  const p = freshCopy('c6-cells')
  const g0 = readSheet(p).sheets[0]

  const res = writeOps({
    path: p,
    baseVersion: readSheet(p).baseVersion,
    ops: [
      { op: 'updateCell', rowId: g0.rowIds[1], colId: g0.colIds[0], value: 'C6-甲' },
      { op: 'updateCell', rowId: g0.rowIds[1], colId: g0.colIds[1], value: 'C6-乙' },
      { op: 'updateCell', rowId: g0.rowIds[2], colId: g0.colIds[0], value: 'C6-丙' },
    ],
  })
  assert.equal(res.json?.ok, true, res.stdout + res.stderr)

  const g1 = readSheet(p).sheets[0]
  assert.equal(g1.rows[1][0], 'C6-甲')
  assert.equal(g1.rows[1][1], 'C6-乙')
  assert.equal(g1.rows[2][0], 'C6-丙')
  // 未点名的格不得被波及
  assert.equal(g1.rows[1][2], g0.rows[1][2])
  assert.equal(g1.rows[2][1], g0.rows[2][1])
  assert.equal(g1.rows[0][0], g0.rows[0][0])
})

test('[C6] insertRow：1 条 op 即插入整行；基线行 id 全部保留（写入路径也满足 B6）', () => {
  const p = freshCopy('c6-insrow')
  const g0 = readSheet(p).sheets[0]

  const res = writeOps({
    path: p,
    baseVersion: readSheet(p).baseVersion,
    ops: [{ op: 'insertRow', after: g0.rowIds[0], values: ['C6-新行A', 'C6-新行B'] }],
  })
  assert.equal(res.json?.ok, true, res.stdout + res.stderr)
  assert.equal(res.json.applied.length, 1, '**1 条 op** 完成插入（不是逐格写 N 条）')

  const g1 = readSheet(p).sheets[0]
  assert.equal(g1.rowIds.length, g0.rowIds.length + 1)
  assert.deepEqual(g1.rows[1].slice(0, 2), ['C6-新行A', 'C6-新行B'], '插在锚点行之后')
  assert.equal(g1.rows[2][0], g0.rows[1][0], '原来的第 1 行顺延到第 2 行（内容未变）')
  // 基线行 id 一个不少 ⇒ 0 处修改
  const missing = g0.rowIds.filter((id) => !g1.rowIds.includes(id))
  assert.deepEqual(missing, [], 'B6：插入行不得让其他行被判成"被修改"')
})

test('[C6] deleteRow / insertCol / deleteCol 各自生效，且不影响其他行列身份', () => {
  const p = freshCopy('c6-struct')
  let cur = readSheet(p).sheets[0]

  // 删一行
  let res = writeOps({ path: p, baseVersion: readSheet(p).baseVersion, ops: [{ op: 'deleteRow', rowId: cur.rowIds[2] }] })
  assert.equal(res.json?.ok, true, res.stdout + res.stderr)
  let g1 = readSheet(p).sheets[0]
  assert.equal(g1.rowIds.length, 20)
  assert.ok(!g1.rowIds.includes(cur.rowIds[2]), '被删行的 id 消失')
  assert.equal(g1.rows[2][0], cur.rows[3][0], '后续行上移')

  // 插一列（在最后一列之后）
  const lastCol = g1.colIds[g1.colIds.length - 1]
  res = writeOps({ path: p, baseVersion: readSheet(p).baseVersion, ops: [{ op: 'insertCol', after: lastCol, values: ['C6-新列头'] }] })
  assert.equal(res.json?.ok, true, res.stdout + res.stderr)
  let g2 = readSheet(p).sheets[0]
  assert.equal(g2.colIds.length, g1.colIds.length + 1, '列数 +1')
  assert.equal(g2.rows[0][g2.rows[0].length - 1], 'C6-新列头', '新列的表头写在最上面一行')

  // 删一列
  res = writeOps({ path: p, baseVersion: readSheet(p).baseVersion, ops: [{ op: 'deleteCol', colId: g2.colIds[0] }] })
  assert.equal(res.json?.ok, true, res.stdout + res.stderr)
  const g3 = readSheet(p).sheets[0]
  assert.equal(g3.colIds.length, g2.colIds.length - 1)
  assert.ok(!g3.colIds.includes(g2.colIds[0]), '被删列的 id 消失')
})

test('[C6] 公式格只读：写公式格 ⇒ formula-cell-readonly；整个请求不落盘（不做部分写入）', () => {
  // 公式格只读是 C6 的明确要求；"整个请求被拒"是配套决定 —— 半截写入会让用户
  // 既丢改动又不知道该信哪部分状态。
  const p = freshCopy('c6-formula')
  const g0 = readSheet(p).sheets[0]

  // xl_base 无公式格，先确认这条前提（否则本用例会"因为别的原因"通过/失败）
  assert.equal(g0.formulas.flat().filter(Boolean).length, 0)

  // 手工把 B2 变成公式格（绕过 sheet_edit.py，模拟"外部 Excel 里写了公式"）
  const code = 'import sys;from openpyxl import load_workbook;wb=load_workbook(sys.argv[1]);wb.active["B2"]="=SUM(A1:A2)";wb.save(sys.argv[1])'
  const r = spawnSync(py(), ['-c', code, p], { encoding: 'utf-8', timeout: 30000 })
  assert.equal(r.status, 0, `造公式格失败：${r.stderr}`)

  const g1 = readSheet(p).sheets[0]
  assert.equal(g1.formulas[1][1], true, 'B2 现在是公式格')

  const res = writeOps({
    path: p,
    baseVersion: readSheet(p).baseVersion,
    ops: [
      { op: 'updateCell', rowId: g1.rowIds[1], colId: g1.colIds[0], value: 'C6-普通格' },
      { op: 'updateCell', rowId: g1.rowIds[1], colId: g1.colIds[1], value: 999 },
    ],
  })
  assert.equal(res.json?.ok, false, '写公式格必须被拒绝')
  assert.equal(res.json.code, 'formula-cell-readonly')
  assert.match(String(res.json.error), /B2/, '错误须指出具体是哪个格')

  const g2 = readSheet(p).sheets[0]
  assert.equal(g2.rows[1][0], g1.rows[1][0], '整个请求被拒 ⇒ 先前的普通格改动也不得写进去')
  assert.equal(g2.formulas[1][1], true, '公式仍在')
})

test('[C6] 旧 updates 写法被显式拒绝；各类非法请求都有明确错误码', () => {
  const p = freshCopy('c6-errors')
  const g0 = readSheet(p).sheets[0]
  const ver = readSheet(p).baseVersion

  // ① 旧写法（{row,col,value}）必须被拒，且文件不被改动
  let res = writeOps({ path: p, baseVersion: ver, updates: [{ row: 2, col: 2, value: 'X' }] })
  assert.equal(res.json?.ok, false)
  assert.equal(res.json.code, 'legacy-updates-not-supported')
  assert.deepEqual(readSheet(p).sheets[0].rows, g0.rows, '被拒绝的写入不得动文件')

  // ② 既无 ops 也无 updates
  res = writeOps({ path: p, baseVersion: ver })
  assert.equal(res.json?.code, 'ops-required')

  // ③ 引用不存在的行/列
  res = writeOps({ path: p, baseVersion: ver, ops: [{ op: 'updateCell', rowId: 'deadbeefdead:9', colId: g0.colIds[0], value: 'x' }] })
  assert.equal(res.json?.code, 'row-not-found')
  res = writeOps({ path: p, baseVersion: ver, ops: [{ op: 'updateCell', rowId: g0.rowIds[1], colId: 'deadbeefdead:9', value: 'x' }] })
  assert.equal(res.json?.code, 'col-not-found')

  // ④ 缺 value / 未知 op / 工作表不存在
  res = writeOps({ path: p, baseVersion: ver, ops: [{ op: 'updateCell', rowId: g0.rowIds[1], colId: g0.colIds[0] }] })
  assert.equal(res.json?.code, 'value-required')
  res = writeOps({ path: p, baseVersion: ver, ops: [{ op: 'frobnicate', rowId: g0.rowIds[1] }] })
  assert.equal(res.json?.code, 'unknown-op')
  res = writeOps({ path: p, baseVersion: ver, sheet: '不存在的表', ops: [{ op: 'updateCell', rowId: g0.rowIds[1], colId: g0.colIds[0], value: 'x' }] })
  assert.equal(res.json?.code, 'sheet-not-found')
  assert.deepEqual(res.json.sheetNames, ['sheet1'], '报错时回带可用表名（便于改正）')
})

test('[C6] baseVersion 防丢失更新：缺失拒绝、不匹配拒绝、匹配放行并回传新版本', () => {
  const p = freshCopy('c6-version')
  const g0 = readSheet(p).sheets[0]
  const v0 = readSheet(p).baseVersion

  let res = writeOps({ path: p, ops: [{ op: 'updateCell', rowId: g0.rowIds[1], colId: g0.colIds[0], value: 'x' }] })
  assert.equal(res.json?.code, 'base-version-required')

  res = writeOps({ path: p, baseVersion: 'f'.repeat(64), ops: [{ op: 'updateCell', rowId: g0.rowIds[1], colId: g0.colIds[0], value: 'x' }] })
  assert.equal(res.json?.code, 'base-version-mismatch')
  assert.equal(res.json.expected, 'f'.repeat(64))
  assert.equal(res.json.actual, v0)
  assert.deepEqual(readSheet(p).sheets[0].rows, g0.rows, '被拒绝的写入不得动文件')

  // A 读到 → B 改 → A 基于旧版本提交必须被拒（B 的改动必须保住）
  const b = writeOps({ path: p, baseVersion: v0, ops: [{ op: 'updateCell', rowId: g0.rowIds[1], colId: g0.colIds[0], value: 'B 先改' }] })
  assert.equal(b.json?.ok, true)
  const a = writeOps({ path: p, baseVersion: v0, ops: [{ op: 'updateCell', rowId: g0.rowIds[1], colId: g0.colIds[0], value: 'A 覆盖' }] })
  assert.equal(a.json?.code, 'base-version-mismatch', 'A 必须被拒，否则会覆盖 B')
  assert.equal(readSheet(p).sheets[0].rows[1][0], 'B 先改', 'B 的改动保住了')

  // 重新读取后重试 ⇒ 放行，并回传新 baseVersion 供前端续接
  const v1 = readSheet(p).baseVersion
  const g1 = readSheet(p).sheets[0]
  const retry = writeOps({ path: p, baseVersion: v1, ops: [{ op: 'updateCell', rowId: g1.rowIds[1], colId: g1.colIds[0], value: 'A 重试成功' }] })
  assert.equal(retry.json?.ok, true, retry.stdout + retry.stderr)
  assert.match(String(retry.json.baseVersion), /^[0-9a-f]{64}$/)
  assert.notEqual(retry.json.baseVersion, v1, '内容变了版本必变')
  assert.equal(readSheet(p).sheets[0].rows[1][0], 'A 重试成功')
})
