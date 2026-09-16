// `server/sheet_edit.py` 回归网 —— 锁住**现有行为**，为 S1「表格协同模型」改造做前置网
// ---------------------------------------------------------------------------
// 这个文件在防什么：`sheet_edit.py` 是 Excel 读写入口，此前**零测试覆盖**。S1 的
// C3（表格降维）/ C5（行指纹）/ C6（结构操作与公式只读）都要改它，没有网同样改不动。
//
// 断言分两类，勿混：
//   【不变量】改造前后都必须成立：read 字段契约、read 幂等、单元格写入生效。
//             变红 = 改造引入了真 bug。
//   【锁现状 + TODO】B8 公式格静默跳过（TODO-C6）、`.xls` 写回必失败（格式/依赖限制）。
//             带 TODO 的那条**变红是好事**，届时反转为期望的新行为。
//
// 语料与生成脚本见 `server/office-fixtures/README.md`。
// 不 spawn 桥、不出网；临时文件用完重试清理。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePython } from '../kernel/knowledge-import.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const SERVER = join(REPO_ROOT, 'server')
const SHEET_EDIT = join(SERVER, 'sheet_edit.py')
const FIXTURES = join(SERVER, 'office-fixtures')
const TOOLS = join(FIXTURES, 'tools')
const XL_BASE = join(FIXTURES, 'xl_base.xlsx')

const PY = resolvePython()

const TMP = mkdtempSync(join(tmpdir(), 'yfw-sheet-py-'))

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

/** 读 bytes（read 输出是 ASCII：json.dumps 默认 ensure_ascii） */
function readSheetRaw(path) { return pyRaw([SHEET_EDIT, 'read', path]) }
function readSheet(path) {
  const raw = readSheetRaw(path)
  const j = JSON.parse(raw)
  if (!j.ok) throw new Error(`read 失败：${raw}`)
  return j
}

let writeSeq = 0
function writeSheet(payload) {
  const jp = join(TMP, `write-${++writeSeq}.json`)
  writeFileSync(jp, JSON.stringify(payload), 'utf8')
  return JSON.parse(pyRaw([SHEET_EDIT, 'write', jp]))
}

/** 只读旁证：openpyxl 直读工作簿元信息 / 单元格原始值（绕过 sheet_edit.py） */
function xlsxMeta(path) {
  const code =
    'import sys,json;from openpyxl import load_workbook;wb=load_workbook(sys.argv[1]);' +
    "print(json.dumps({'sheetnames':wb.sheetnames,'active':wb.active.title}))"
  return JSON.parse(pyRaw(['-c', code, path]))
}
function xlsxRawCell(path, ref) {
  const code =
    'import sys,json;from openpyxl import load_workbook;wb=load_workbook(sys.argv[1]);' +
    "print(json.dumps(wb.active[sys.argv[2]].value))"
  return JSON.parse(pyRaw(['-c', code, path, ref]))
}

function freshCopy(name) {
  const p = join(TMP, `${name}-${++writeSeq}.xlsx`)
  copyFileSync(XL_BASE, p)
  return p
}

const FORMULA = join(TMP, 'formula.xlsx')
const MULTI = join(TMP, 'multi_sheet.xlsx')

before(() => {
  // formula.xlsx / multi_sheet.xlsx 是确定性生成的变体：脚本入库、产物不入库。
  // 这里跑的就是提交进仓库的那份脚本——顺带保证它不会漂移到跑不起来。
  pyRaw([join(TOOLS, 'gen_xlsx_variants.py'), TMP])
})

// ---------------------------------------------------------------------------
// 一、read 的字段契约
// ---------------------------------------------------------------------------

test('read 字段契约（C5 后）：顶层有 baseVersion/sheetNames，每 sheet 有 rowIds/colIds（内容指纹）', () => {
  // 为什么重要：这是 read→write 的线格式。S1 的 C3/C5 会往上加行指纹、sheet 标识等字段；
  // 先钉死当前形状，才能确信后续新增是有意为之。另外"只返回 active sheet"是个**隐式
  // 契约**——多表工作簿里，非 active 的表当前**完全不可见**（不是空、是没有键），
  // 协同场景下这会直接丢数据，必须显式记账。
  const j = readSheet(XL_BASE)
  assert.equal(j.ok, true)
  assert.equal(j.sheets.length, 1, '当前只返回 active sheet')
  const s = j.sheets[0]
  assert.deepEqual(Object.keys(s).sort(), ['colIds', 'formulas', 'name', 'rowIds', 'rows'])
  assert.equal(s.name, 'sheet1')
  assert.equal(typeof s.name, 'string')

  // 【C5 新契约】顶层：版本号 + 全部工作表名
  // baseVersion 是"提交时的基线"，缺它就无法防丢失更新（A 的改动会静默覆盖 B 的）
  assert.match(j.baseVersion, /^[0-9a-f]{64}$/, 'baseVersion = 整文件 sha256')
  assert.deepEqual(j.sheetNames, ['sheet1'], 'sheetNames 列出工作簿里所有表（D-7）')

  // 行/列指纹：**数量必须与行列数一一对齐** —— 前端按 rows[r] 渲染、按 rowIds[r] 提交，
  // 错位一格就会把用户的改动写到相邻行上（且不会有任何报错）。
  assert.equal(s.rowIds.length, s.rows.length, 'rowIds 与 rows 同长')
  assert.equal(new Set(s.rowIds).size, s.rowIds.length, 'rowIds 唯一')
  assert.equal(s.colIds.length, s.rows[0].length, 'colIds 与列数同长')
  assert.equal(new Set(s.colIds).size, s.colIds.length, 'colIds 唯一')

  assert.ok(Array.isArray(s.rows) && s.rows.length === 21, '21 行')
  assert.ok(s.rows.every((r) => Array.isArray(r)), 'rows 是二维数组')
  assert.ok(Array.isArray(s.formulas) && s.formulas.length === s.rows.length, 'formulas 与 rows 同行数')
  assert.ok(s.rows.every((r, i) => r.length === s.formulas[i].length), '每行的 formulas 与 cells 同列数')
  assert.ok(
    s.formulas.every((r) => r.every((v) => typeof v === 'boolean')),
    'formulas 是布尔矩阵（是否公式格）',
  )
  assert.equal(s.formulas.flat().filter(Boolean).length, 0, 'xl_base.xlsx 无公式格')
})

test('read 幂等：同一文件连续 read 3 次，输出逐字节相等', () => {
  // 为什么重要：与 docx 同理——读路径若不确定，任何"两人改后合并"的判等都失去意义。
  // 变红意味着读路径引入了不确定性（时间戳、随机序、locale 相关数字/日期格式）。
  const a = readSheetRaw(XL_BASE)
  const b = readSheetRaw(XL_BASE)
  const c = readSheetRaw(XL_BASE)
  assert.equal(a, b)
  assert.equal(b, c)
})

// ---------------------------------------------------------------------------
// 二、【不变量】write_xlsx 单元格写入生效
// ---------------------------------------------------------------------------

test('【不变量】write_xlsx：{row,col,value} 生效，且只改指定单元格', () => {
  // 为什么重要：这是唯一的正向保证——否则一个"什么都不写"的实现能让下面所有
  // 「锁现状」断言全绿。同时钉住"只改指定格"，避免实现顺手整表重写。
  const p = freshCopy('write-ok')
  const j0 = readSheet(p)
  const res = writeSheet({
    path: p,
    baseVersion: j0.baseVersion,
    // C6 起改用 ops：按**行/列内容指纹**寻址（不再用 {row,col} 行号 —— 行号在插删行后会漂移）
    ops: [{ op: 'updateCell', rowId: j0.sheets[0].rowIds[1], colId: j0.sheets[0].colIds[1], value: '【校验】PROBE-OK' }],
  })
  assert.equal(res.ok, true, JSON.stringify(res))

  const j1 = readSheet(p)
  assert.equal(j1.sheets[0].rows[1][1], '【校验】PROBE-OK', '目标格已写入')
  assert.equal(j1.sheets[0].rows[1][0], j0.sheets[0].rows[1][0], '同行左邻未变')
  assert.equal(j1.sheets[0].rows[2][1], j0.sheets[0].rows[2][1], '同列下邻未变')
})

// ---------------------------------------------------------------------------
// 三、【C6 新契约】公式格只读且**明确报错**（原 B8 静默跳过已根除）
// ---------------------------------------------------------------------------

test('C6：对公式格下发 updateCell ⇒ **明确报错**（原 B8"静默跳过 + 谎报 ok:true"已根除）', () => {
  // 这条原是"锁现状"（写 999 被丢弃、公式原样保留、却返回 ok:true）。
  // C6 落地后**反转为"必须显式拒绝"**。
  // 为什么不能只是删掉：B8 与 docx 的 B1 同类 —— 危害不在"写错"，而在**静默**：
  // 协同里"某人改了公式"这一改动凭空消失，而调用方看到的是成功。
  // 反转后若有人把静默跳过放回来，这条立刻变红。
  //
  // 附注：这里还顺带排除了"只是读法不同"的解释——用 openpyxl 直读原始单元格确认公式串。
  const rowsBefore = readSheet(FORMULA).sheets[0]
  assert.equal(rowsBefore.formulas[21][0], true, 'A22 是公式格')
  assert.equal(rowsBefore.rows[21][0], null, '无缓存值（openpyxl 生成的公式无 cached value）')
  assert.equal(xlsxRawCell(FORMULA, 'A22'), '=SUM(A2:A8)')

  const res = writeSheet({
    path: FORMULA,
    baseVersion: readSheet(FORMULA).baseVersion,
    ops: [
      { op: 'updateCell', rowId: rowsBefore.rowIds[21], colId: rowsBefore.colIds[0], value: 999 }, // 公式格
    ],
  })
  assert.equal(res.ok, false, '写公式格必须被拒绝，不得静默丢弃')
  assert.equal(res.code, 'formula-cell-readonly')
  assert.match(String(res.error), /A22/, '错误必须指出**哪个格**是公式格（否则用户无从下手）')

  const after = readSheet(FORMULA).sheets[0]
  assert.equal(xlsxRawCell(FORMULA, 'A22'), '=SUM(A2:A8)', '被拒绝的写入不得动公式')
  assert.equal(after.rows[21][0], null, '值未变')

  // 同一次请求里"公式格 + 普通格"混发：整个请求被拒（不做部分写入）——
  // 半截写入会让用户既丢改动又不知道该信哪部分状态。
  const p = freshCopy('formula-mixed')
  const g = readSheet(p).sheets[0]
  const mixed = writeSheet({
    path: p,
    baseVersion: readSheet(p).baseVersion,
    ops: [
      { op: 'updateCell', rowId: g.rowIds[1], colId: g.colIds[0], value: 'RD01-X' },
      { op: 'updateCell', rowId: g.rowIds[0], colId: g.colIds[0], value: 'x' },
      { op: 'updateCell', rowId: 'deadbeefdead:1', colId: g.colIds[0], value: 'x' },
    ],
  })
  assert.equal(mixed.ok, false)
  assert.equal(mixed.code, 'row-not-found')
  assert.equal(readSheet(p).sheets[0].rows[1][0], g.rows[1][0], '整个请求被拒 ⇒ 前面的普通格也不得写进去')
})

// ---------------------------------------------------------------------------
// 四、【锁现状】只读 active sheet，其余表完全不可见
// ---------------------------------------------------------------------------

test('【锁现状】多表工作簿：read 只返回 active sheet，另一张表完全不可见（无键、不报错）', () => {
  // 为什么锁它：这是"隐式契约"，最容易在协同里无声丢数据——用户以为读到的是整个工作簿，
  // 实际只有当前激活的那张。C5/C3 要处理多表必须先把这件事显式化。
  // 这里用 openpyxl 直读作为旁证：**工作簿里确实有两张表**，而 read 只吐一张。
  const meta = xlsxMeta(MULTI)
  assert.deepEqual(meta.sheetnames, ['sheet1', 'Second'], '旁证：工作簿确有两张表')
  assert.equal(meta.active, 'Second', 'active 被切到 Second')

  const j = readSheet(MULTI)
  assert.equal(j.sheets.length, 1, '现状：只返回 1 张')
  assert.equal(j.sheets[0].name, 'Second', '返回的是 active 那张')
  assert.equal(j.sheets[0].rows[0][0], 'SECOND-MARKER', 'Second 的内容读到了')
  // 关键：`sheet1` 既不在返回里，也没有任何"还有别的表"的提示
  assert.ok(!j.sheets.some((s) => s.name === 'sheet1'), '现状：sheet1 完全不可见')
  // 【C5/D-7】但顶层 sheetNames 现在把两张表都列出来了 —— "还有别的表"这件事不再完全不可见。
  // 这解决的是**信息不对称**（ops 能写到 read 看不见的表上），而非"多表可读"（那不在 S1 范围）。
  assert.deepEqual(j.sheetNames, ['sheet1', 'Second'], 'sheetNames 必须列出全部表')
})

// ---------------------------------------------------------------------------
// 五、【C6 新契约】.xls 结构写**明确报错**（D-5：只读格式，不做"跑不到的分支"）
// ---------------------------------------------------------------------------

test('C6：.xls 结构写明确报错 xls-write-unsupported，且不落盘', () => {
  // 为什么改成"明确报错"：旧实现走 `write_xls`，失败点是 `import xlutils`（本机未装），
  // 报出来的错是**依赖缺失**——用户看到的是"缺个库"，而不是"这种格式就是不支持写"。
  // D-5 定案：`.xls` 只读，结构写给一条**格式层面**的明确说明（含"请另存为 .xlsx"的可行动作），
  // 不再把一个本机环境问题伪装成功能故障。
  const legacy = join(TMP, `legacy-${++writeSeq}.xls`)
  copyFileSync(XL_BASE, legacy) // 扩展名决定走哪条分支；内容不参与判定
  const before = readFileSync(legacy)

  const res = writeSheet({
    path: legacy,
    // baseVersion 直接用该文件的 sha256（不能用 readSheet 取：`.xls` 分支要求真的是 xls 内容，
    // 而这个文件是"改了扩展名"的副本 —— 目的是让判定**只由扩展名决定**，与内容无关）
    baseVersion: createHash('sha256').update(before).digest('hex'),
    ops: [{ op: 'updateCell', rowId: 'x:1', colId: 'y:1', value: 'X' }],
  })
  assert.equal(res.ok, false, '.xls 结构写不可用')
  assert.equal(res.code, 'xls-write-unsupported')
  assert.match(String(res.error), /xlsx/, '错误应给出可行动作：另存为 .xlsx')

  assert.ok(before.equals(readFileSync(legacy)), '失败路径不落盘：文件字节未变')
})
