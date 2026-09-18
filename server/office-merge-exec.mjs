/**
 * 三路合并的**执行编排**（接线层）。
 *
 * 背景：`shared/office-merge.mjs` 提供"合并算法 + 落盘 ops"，但**它自己不读盘也不写盘**——
 * spec 把职责切成两半：算法归 S1-6，**"按文件模态选择函数后调用"归上层**（见
 * `kernel/file-collab.mjs` 的 `prepareConflictResolution` 注释）。这个"上层"一直没人写，
 * 于是用户在冲突弹窗里选「进入编辑器逐处合并」后**什么都不会发生**（HTTP 层只回报了
 * `action: 'merge-then-write'` 就结束）。本模块补的就是这一段。
 *
 * 一次合并的完整链路（以 docx 为例）：
 *
 *   base/mine（团队库里的版本，读成 Buffer）
 *        └─ 落临时文件 ──→ docx_edit.py read ──→ blocks
 *   theirs（**磁盘当前内容**，直接读目标路径）
 *        └──────────────── docx_edit.py read ──→ blocks + baseVersion
 *                            ↓
 *              mergeDocxBlocks(base, mine, theirs)
 *                     ├─ 有冲突 → **不写盘**，把冲突原样回报（宁多报，不静默取舍）
 *                     └─ 无冲突 → blocksToOps → docx_edit.py write（带 baseVersion 乐观锁）
 *
 * 三个刻意的设计选择：
 *  1. **theirs 用磁盘当前内容，而不是团队库里存的那份**。冲突是"文件在磁盘上变了"触发的，
 *     所以"要合进去的那一方"就是**此刻的磁盘**；顺带它的 `baseVersion` 正是落盘时该带的
 *     乐观锁值——读与写取自同一次读取，中间被第三方改动时写入自然会 409 而不是覆盖。
 *  2. **任何冲突都不写盘**。宁可回报"有 N 处需要你决定"，也不做部分合并/部分落盘——
 *     否则用户看到的是"合了一半"的文件，比不合更危险。
 *  3. **表级增删如实回报**（`mineOnly` / `theirsOnly`），不静默吞掉。合并只覆盖 base 里
 *     已有的表；只在某一侧新增的表不在本次范围内，但必须让调用方知道它们的存在。
 *
 * 多表工作簿：写接口一次只能写一张表（`sheet_edit.py` 的 ops 不带表名，落盘时取 `body.sheet`），
 * 所以按表分次写、**版本号滚动**（每次写返回新的 `baseVersion` 供下一次用）。ops 里的
 * rowId/colId 是内容指纹、与版本号无关，故分次写不会互相影响。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { blocksToOps, mergeDocxBlocks, mergeSheetRows, sheetMergeToOps } from '../shared/office-merge.mjs'

/** 扩展名 → 文件模态。未知模态返回 null（调用方据此回报"不支持"，而不是猜。 */
const MODALITY_BY_EXT = { '.docx': 'docx', '.xlsx': 'sheet', '.xls': 'sheet' }

export function modalityOf (name) {
  return MODALITY_BY_EXT[extname(String(name || '')).toLowerCase()] || null
}

const fail = (reason, extra) => ({ ok: false, reason, ...extra })

/** 读结构：把 `{status, body}` 归一成 `{data}` / `{err}`，避免调用处到处判两层。 */
async function readStruct (office, modality, path, which) {
  const res = modality === 'docx' ? await office.readDocx(path) : await office.readSheet(path)
  if (!res || res.status !== 200 || !res.body || res.body.ok === false) {
    return { err: fail('read-failed', { which, detail: res ? res.body : null }) }
  }
  return { data: res.body }
}

/**
 * 执行一次三路合并。
 *
 * @param {object}   o
 * @param {string}   o.teamRoot          团队库根目录
 * @param {object}   o.versionIds        `{ base, mine, theirs }` 版本 id（来自 prepareConflictResolution）
 * @param {string}   o.logicalName       文件名（用于判定模态）
 * @param {string}   o.targetPath        目标文件的**磁盘路径**（合并结果写回这里）
 * @param {object}   o.office            `createOfficeAccess()` 的返回值（读写 office 格式）
 * @param {Function} o.readVersionBuffer `(teamRoot, versionId) => { ok, buf }`
 * @returns {Promise<object>} 见下方各 `reason`：
 *   · `unsupported-modality` / `office-unavailable` / `no-target-path` / `version-unreadable`
 *   · `read-failed` / `write-failed` —— 带 `detail`（底层回报，便于定位）
 *   · `conflict` —— 带 `conflicts[]`（**未写盘**）
 *   · `ok: true` —— 带 `written`（false 表示本来就无需改动）、`ops`、`baseVersion`
 */
export async function executeOfficeMerge ({ teamRoot, versionIds, logicalName, targetPath, office, readVersionBuffer }) {
  const modality = modalityOf(logicalName || targetPath)
  if (!modality) return fail('unsupported-modality', { logicalName })
  if (!office) return fail('office-unavailable')
  if (!targetPath) return fail('no-target-path')
  if (typeof readVersionBuffer !== 'function') return fail('office-unavailable', { detail: 'readVersionBuffer 未注入' })

  // base / mine 取自团队库里的版本（theirs 用磁盘，理由见文件头）
  const bufs = {}
  for (const which of ['base', 'mine']) {
    const v = readVersionBuffer(teamRoot, versionIds && versionIds[which])
    if (!v || !v.ok || !v.buf) return fail('version-unreadable', { which })
    bufs[which] = v.buf
  }

  const ext = extname(String(logicalName || targetPath)).toLowerCase() ||
    (modality === 'docx' ? '.docx' : '.xlsx')
  const dir = await mkdtemp(join(tmpdir(), 'yfw-merge-'))
  try {
    const tmp = {}
    for (const which of ['base', 'mine']) {
      tmp[which] = join(dir, `${which}${ext}`)
      await writeFile(tmp[which], bufs[which])
    }
    return modality === 'docx'
      ? await mergeDocxFlow({ office, targetPath, tmp })
      : await mergeSheetFlow({ office, targetPath, tmp })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function mergeDocxFlow ({ office, targetPath, tmp }) {
  const base = await readStruct(office, 'docx', tmp.base, 'base')
  if (base.err) return base.err
  const mine = await readStruct(office, 'docx', tmp.mine, 'mine')
  if (mine.err) return mine.err
  const theirs = await readStruct(office, 'docx', targetPath, 'theirs')
  if (theirs.err) return theirs.err

  const merged = mergeDocxBlocks(base.data.blocks, mine.data.blocks, theirs.data.blocks)
  if (!merged.ok) return fail('conflict', { modality: 'docx', conflicts: merged.conflicts || [] })

  // ⚠️ ops 必须相对**落盘目标当前的内容**（= theirs，磁盘那份）来算，不能相对 base：
  //    ops 里的 blockId 是内容指纹，而目标文件里被改过的块 id 与 base 已不同；
  //    若按 base 算，写下去时会报 `block-not-found`（这个 bug 就是被本文件的端到端测试抓出来的）。
  const ops = blocksToOps(theirs.data.blocks, merged.blocks)
  if (!ops.length) return { ok: true, modality: 'docx', reason: 'no-change', written: false, ops: 0 }

  const w = await office.writeDocx(targetPath, theirs.data.baseVersion, ops)
  if (!w || w.status !== 200 || !w.body || w.body.ok === false) {
    return fail('write-failed', { modality: 'docx', detail: w ? w.body : null, ops: ops.length })
  }
  return {
    ok: true,
    modality: 'docx',
    written: true,
    ops: ops.length,
    baseVersion: w.body.baseVersion,
    conflicts: [],
  }
}

async function mergeSheetFlow ({ office, targetPath, tmp }) {
  const base = await readStruct(office, 'sheet', tmp.base, 'base')
  if (base.err) return base.err
  const mine = await readStruct(office, 'sheet', tmp.mine, 'mine')
  if (mine.err) return mine.err
  const theirs = await readStruct(office, 'sheet', targetPath, 'theirs')
  if (theirs.err) return theirs.err

  const byName = (body) => new Map((body.sheets || []).map((s) => [s.name, s]))
  const mineSheets = byName(mine.data)
  const theirsSheets = byName(theirs.data)
  const baseSheets = base.data.sheets || []

  // 只合并 base 里已有的表；逐表判定冲突，**有任何冲突就整体不写盘**
  const conflicts = []
  const planned = []
  for (const bs of baseSheets) {
    const fallback = { name: bs.name, rows: [], rowIds: [], colIds: bs.colIds }
    const ms = mineSheets.get(bs.name) || fallback
    const ts = theirsSheets.get(bs.name) || fallback
    const merged = mergeSheetRows(bs, ms, ts)
    if (!merged.ok) {
      for (const c of merged.conflicts || []) conflicts.push({ ...c, sheet: bs.name })
      continue
    }
    // 同 docx：ops 相对落盘目标（theirs）算，理由见 mergeDocxFlow 的注释
    const ops = sheetMergeToOps(ts, merged.rows)
    if (ops.length) planned.push({ sheet: bs.name, ops })
  }

  // 表级增删不在本次合并范围内 —— 如实回报，不静默吞掉
  const baseNames = new Set(baseSheets.map((s) => s.name))
  const mineOnly = [...mineSheets.keys()].filter((n) => !baseNames.has(n))
  const theirsOnly = [...theirsSheets.keys()].filter((n) => !baseNames.has(n))

  if (conflicts.length) return fail('conflict', { modality: 'sheet', conflicts, mineOnly, theirsOnly })
  if (!planned.length) {
    return { ok: true, modality: 'sheet', reason: 'no-change', written: false, ops: 0, mineOnly, theirsOnly }
  }

  let baseVersion = theirs.data.baseVersion
  let applied = 0
  const writtenSheets = []
  for (const p of planned) {
    const w = await office.writeSheet(targetPath, p.sheet, baseVersion, p.ops)
    if (!w || w.status !== 200 || !w.body || w.body.ok === false) {
      return fail('write-failed', {
        modality: 'sheet', sheet: p.sheet, detail: w ? w.body : null,
        writtenSheets, ops: applied,
      })
    }
    baseVersion = w.body.baseVersion || baseVersion
    applied += p.ops.length
    writtenSheets.push(p.sheet)
  }
  return {
    ok: true,
    modality: 'sheet',
    written: true,
    ops: applied,
    sheets: writtenSheets,
    baseVersion,
    mineOnly,
    theirsOnly,
  }
}
