/**
 * S1-6 三路合并（base / mine / theirs → merged + conflicts）
 *
 * ⚠️ 未接线（2026-09-18 核实）：本模块**没有任何生产代码调用**——唯一引用者是它自己的测试。
 *    缺的不是算法，而是 server 层的一段编排：`server/collab-routes.mjs` 的 `/file-collab/conflict`
 *    路由收到 `choice === 'edit-merge'` 时，应读三版本 → 按模态调 mergeDocxBlocks / mergeSheetRows
 *    → blocksToOps / sheetMergeToOps → 写回（原语 `/read-docx` `/write-docx` `/read-sheet` `/write-sheet`
 *    均已存在）。**因此它不是死代码**：请勿当作废弃文件删除；功能说明与接线方案见
 *    `docs/2026-09-18-office-merge-功能说明与接线方案.md`。
 *
 * —— 为什么需要它 ——
 * 协同的本质是"两个人各自改了同一份文件"。spec §5.4 定义流程为"base + mine + theirs
 * 三路合并（内容对齐）"，§10 给出验收用例 T5/T6/T7/T9 与 B2：
 *   T5 甲改第 5 段、乙改第 9 段 → 0 冲突（两处都保住）
 *   T6 甲改一段、乙插一段       → 0 冲突（插入被吸收）
 *   T7 甲乙改同一段            → 1 冲突（要**报**出来，不能悄悄取舍）
 *   T9 xlsx 甲乙改不同单元格    → 0 冲突（两处都保住）
 *   B2 同表甲乙改不同格         → 0 冲突（表格粒度下沉到单元格）
 *
 * —— 核心设计：以"内容指纹 id"为对齐锚，以"位置"为区间内兜底 ——
 * 块/行 id 由内容算出（C2/C5），所以**未被改动的块在三个版本里 id 相同** ⇒ 它们是天然而可靠的
 * 对齐锚点。被改动过的块 id 已变，无法靠 id 匹配，于是落在两个锚点之间的"空档"里，按**位置**
 * 1:1 配对（这正是"同一段被两人各自改了"能识别为冲突、而不是"删一段+插两段"的原因）。
 *
 * —— 冲突宁可多报，不可静默取舍 ——
 * 无法自动判定的情形（一侧删、另一侧改；结构性增删数量不等导致无法配对）一律记为冲突并
 * 原样带出两侧内容。S1 只要求"判定 + 报出"，交互式选择留给后续（spec §6.1 非目标）。
 *
 * —— id 的归属（重要）——
 * 合并产物里"被两人共同修改"的块沿用**基线 id**：它是"改自哪个块"的身份，也正是写回时
 * 用来寻址的 id（`ops` 一律按**磁盘上当前内容**寻址）。落盘后由读侧重新算 id。
 */
/** 结构相等（合并里只用于比较"是否同一内容"，不涉及函数/循环引用）。 */
export function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 最长公共子序列配对（返回 [[baseIdx, otherIdx], …]）。
 *
 * 为什么用 LCS 而不是"哈希表直接配对"：内容相同的块可能在一篇里出现多次，
 * 直接建 map 会把所有同内容块错配到同一处；LCS 保证**顺序不乱**（乱序配对会让合并结果串位）。
 * 复杂度 O(n·m)：块数/行数在几十~几百量级，够用（实测受控语料 21 行 × 21 行瞬时完成）。
 */
export function lcsPairs(aKeys, bKeys) {
  const n = aKeys.length
  const m = bKeys.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aKeys[i] === bKeys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const pairs = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (aKeys[i] === bKeys[j]) { pairs.push([i, j]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return pairs
}

/**
 * 把 other 序列对齐到 base。
 *
 * 返回：
 *   counterpart[i] = other 中的下标（未匹配为 -1）
 *   inserts[i]     = 挂在下标 i 之后的 other 侧内容（-1 表示文档最前）
 *
 * 规则：两个锚点之间的空档，若两侧数量**相等**就按位置 1:1 配对（视为"这一段被改了"）；
 * 数量不等则不做配对，把 other 侧的内容整体记为插入（宁可当成"增删"报冲突，也不硬配错）。
 */
export function alignToBase(baseKeys, otherKeys) {
  const pairs = lcsPairs(baseKeys, otherKeys)
  const counterpart = new Array(baseKeys.length).fill(-1)
  const inserts = []
  let bi = 0
  let oj = 0
  const pushRegion = (bStart, bEnd, oStart, oEnd) => {
    const bn = bEnd - bStart
    const on = oEnd - oStart
    if (bn === on) {
      for (let k = 0; k < bn; k++) counterpart[bStart + k] = oStart + k
    } else if (on > 0) {
      const units = []
      for (let k = oStart; k < oEnd; k++) units.push(k)
      inserts.push({ after: bStart - 1, units })
    }
  }
  for (const [i, j] of pairs) {
    pushRegion(bi, i, oj, j)
    counterpart[i] = j
    bi = i + 1
    oj = j + 1
  }
  pushRegion(bi, baseKeys.length, oj, otherKeys.length)
  return { counterpart, inserts }
}

/**
 * 通用三路合并。
 *
 * @param {Array} base 基线单位序列
 * @param {Array} mine 我方（A）
 * @param {Array} theirs 对方（B）
 * @param {{key: (u:any)=>string, mergeUnit?: (b:any,m:any,t:any)=>{ok:boolean,unit?:any,reason?:string}, label?: string}} opts
 *   - key：身份键（块 id / 行 id / 列 id）
 *   - mergeUnit：双方都改了同一单位时的**下沉合并**（例如表格行 → 单元格）。缺省表示"两边都改了就冲突"。
 * @returns {{ok: boolean, units: Array, conflicts: Array}}
 */
export function threeWayMerge(base, mine, theirs, opts) {
  const { key, mergeUnit, label = 'unit' } = opts
  const baseKeys = base.map(key)
  const A = alignToBase(baseKeys, mine.map(key))
  const B = alignToBase(baseKeys, theirs.map(key))

  const out = []
  const conflicts = []

  // 同一位置两侧都插了内容：**内容相同**则只取一次；不同则都保留（丢数据比顺序歧义更糟），
  // 顺序固定为 mine 在前、theirs 在后（确定性，便于测试与复现）。
  // 判"内容相同"时剥掉 id：id 由内容派生，但同一内容在不同版本里可能因"出现序号"而不同
  // （例如文档别处也有同内容块），按 id 比对会把同一段插入认成两段、留下重复内容。
  const slots = new Map()
  const addInserts = (side, seq, al) => {
    for (const ins of al.inserts) {
      const slot = slots.get(ins.after) || { mine: [], theirs: [] }
      for (const idx of ins.units) slot[side].push(seq[idx])
      slots.set(ins.after, slot)
    }
  }
  addInserts('mine', mine, A)
  addInserts('theirs', theirs, B)
  const emitInserts = (pos) => {
    const slot = slots.get(pos)
    if (!slot) return
    const { mine: mm, theirs: tt } = slot
    if (mm.length && tt.length && mm.length === tt.length &&
        mm.every((u, i) => deepEqual(contentOf(u), contentOf(tt[i])))) {
      out.push(...mm)
    } else {
      out.push(...mm, ...tt)
    }
  }

  emitInserts(-1)
  for (let i = 0; i < base.length; i++) {
    const b = base[i]
    const m = A.counterpart[i] >= 0 ? mine[A.counterpart[i]] : null
    const t = B.counterpart[i] >= 0 ? theirs[B.counterpart[i]] : null

    if (m && t) {
      const mChanged = !deepEqual(m, b)
      const tChanged = !deepEqual(t, b)
      if (!mChanged && !tChanged) out.push(b)
      else if (mChanged && !tChanged) out.push(m)
      else if (!mChanged && tChanged) out.push(t)
      else if (deepEqual(m, t)) out.push(m)
      else {
        const r = mergeUnit ? mergeUnit(b, m, t) : { ok: false, reason: 'both-modified' }
        if (r.ok) out.push(r.unit)
        else {
          conflicts.push({
            kind: 'modify-modify', label, baseIndex: i,
            reason: r.reason || 'both-modified', base: b, mine: m, theirs: t,
          })
        }
      }
    } else if (m || t) {
      // 一侧有对应、另一侧没有：可能是"一侧删除"。若保留的那侧**没改** ⇒ 删除生效（不报冲突）；
      // 若保留的那侧也改了 ⇒ "删 vs 改"，无法自动判定 ⇒ 报冲突。
      const kept = m || t
      if (!deepEqual(kept, b)) {
        conflicts.push({
          kind: 'delete-vs-edit', label, baseIndex: i,
          reason: '一侧删除/替换、另一侧修改', base: b, mine: m, theirs: t,
        })
      }
    }
    // 两侧都没有对应 ⇒ 双方都删了 ⇒ 丢弃（共识删除）
    emitInserts(i)
  }
  return { ok: conflicts.length === 0, units: out, conflicts }
}

// ---------------------------------------------------------------------------
// 领域封装：docx 块
// ---------------------------------------------------------------------------

/** 剥掉身份字段后的内容视图（比较"是否同一内容"时用；id 是内容派生的，不该参与内容比对）。 */
function contentOf(unit) {
  if (!unit || typeof unit !== 'object') return unit
  const { blockId, rowId, colId, ...rest } = unit
  return rest
}


function mergeFormat(baseFmt, mineFmt, theirsFmt) {
  const mChanged = !deepEqual(mineFmt, baseFmt)
  const tChanged = !deepEqual(theirsFmt, baseFmt)
  if (!mChanged && !tChanged) return { ok: true, format: baseFmt }
  if (mChanged && !tChanged) return { ok: true, format: mineFmt }
  if (!mChanged && tChanged) return { ok: true, format: theirsFmt }
  if (deepEqual(mineFmt, theirsFmt)) return { ok: true, format: mineFmt }
  return { ok: false }
}

const rowsOf = (block) => block.rows || []
const rowIdsOf = (block) => (block.tableCells && block.tableCells.rowIds) || []
const colIdsOf = (block) => (block.tableCells && block.tableCells.colIds) || []

/** 把表格块拆成"行单位"（行 id + 单元格值 + 列框架）。 */
function tableRowUnits(block) {
  const rows = rowsOf(block)
  const rowIds = rowIdsOf(block)
  const colIds = colIdsOf(block)
  return rows.map((values, i) => ({ rowId: rowIds[i] ?? `#${i}`, values, colIds }))
}

/** 表格行内部的单元格合并：以**列 id** 为键，逐格判定。 */
function mergeRowUnits(baseRow, mineRow, theirsRow) {
  const toCols = (row) => row.colIds.map((colId, i) => ({ colId, value: row.values[i] ?? null }))
  const cols = toCols(baseRow)
  const mineCols = toCols(mineRow)
  const theirsCols = toCols(theirsRow)
  // 注意：**不能**用"列 id 序列是否相等"来判断列框架是否一致。
  // 列 id 是**列内容**的指纹（C5），改一个格就会让该列的 id 变 —— 早期版本这么判，
  // 结果是"同表两人各改一格"被判成 21 处 `column-structure-diverged`（B2/T9 全红，实测踩到）。
  // 正确做法：让列也走通用对齐（未变的列按 id 命中做锚点，被改的列落在锚点空档里**按位置**配对），
  // 于是"同一格被两人改成不同值"会自然落到 `both-modified` → 报冲突，而不同格互不干扰。
  const r = threeWayMerge(cols, mineCols, theirsCols, { key: (u) => u.colId, label: 'cell' })
  if (!r.ok) return { ok: false, reason: 'cell-conflict' }
  return { ok: true, unit: { ...baseRow, values: r.units.map((u) => u.value) } }
}

/** 表格块的合并：行级三路 → 行内单元格级三路（B2 的关键：粒度下沉到单元格）。 */
function mergeTableBlocks(b, m, t) {
  const r = threeWayMerge(tableRowUnits(b), tableRowUnits(m), tableRowUnits(t), {
    key: (u) => u.rowId,
    mergeUnit: mergeRowUnits,
    label: 'row',
  })
  if (!r.ok) return { ok: false, reason: 'row-conflict' }
  // 行 id 沿用基线框架（被改过的行 id 在磁盘上已变，落盘后由 read 重算）
  const rowIds = r.units.map((u) => (u.rowId.startsWith('#') ? null : u.rowId))
  const keptColIds = colIdsOf(b)
  return {
    ok: true,
    unit: {
      ...b,
      rows: r.units.map((u) => u.values),
      tableCells: { rowIds, colIds: keptColIds, values: r.units.map((u) => u.values) },
    },
  }
}

/**
 * 合并 docx 块序列。
 * @returns {{ok: boolean, blocks: Array, conflicts: Array}}
 */
export function mergeDocxBlocks(base, mine, theirs) {
  const r = threeWayMerge(base, mine, theirs, {
    key: (b) => b.blockId,
    label: 'block',
    mergeUnit: (b, m, t) => {
      if (b.kind !== m.kind || b.kind !== t.kind) return { ok: false, reason: 'kind-diverged' }
      if (b.kind === 'table') return mergeTableBlocks(b, m, t)
      if (m.text !== t.text) return { ok: false, reason: 'text-conflict' }
      const f = mergeFormat(b.format, m.format, t.format)
      if (!f.ok) return { ok: false, reason: 'format-conflict' }
      return { ok: true, unit: { ...b, text: m.text, format: f.format } }
    },
  })
  return { ok: r.ok, blocks: r.units, conflicts: r.conflicts }
}

// ---------------------------------------------------------------------------
// 领域封装：xlsx 行
// ---------------------------------------------------------------------------

const sheetRowUnits = (sheet) =>
  sheet.rows.map((values, i) => ({ rowId: sheet.rowIds[i] ?? `#${i}`, values, colIds: sheet.colIds }))

/**
 * 合并工作表（行级三路 → 行内单元格级三路）。T9 的关键：两人改同一行的不同列 → 0 冲突。
 * @returns {{ok: boolean, rows: Array<Array>, colIds: Array, conflicts: Array}}
 */
export function mergeSheetRows(baseSheet, mineSheet, theirsSheet) {
  const r = threeWayMerge(sheetRowUnits(baseSheet), sheetRowUnits(mineSheet), sheetRowUnits(theirsSheet), {
    key: (u) => u.rowId,
    mergeUnit: mergeRowUnits,
    label: 'row',
  })
  return {
    ok: r.ok,
    rows: r.units.map((u) => u.values),
    colIds: baseSheet.colIds,
    rowIds: r.units.map((u) => (u.rowId.startsWith('#') ? null : u.rowId)),
    conflicts: r.conflicts,
  }
}

// ---------------------------------------------------------------------------
// 把合并结果变成 ops（"合并产物可落盘"）
// ---------------------------------------------------------------------------

/** 找出 base 中"在 merged 里仍有对应"的最大下标 ≤ pos（插入锚点必须是一个**仍然存在**的块）。 */
function anchorBaseIndex(baseKeys, counterpart, pos, alive) {
  for (let i = Math.min(pos, counterpart.length - 1); i >= 0; i--) {
    if (counterpart[i] >= 0 && alive.has(i)) return i
  }
  return -1
}

/**
 * base → merged 的 docx 写入 ops（`{op:'update'|'insert'|'delete'}`）。
 *
 * 关键点：
 * * **改动的块按"基线 id"寻址**（块内容变了 ⇒ 它的新 id 已不同，但磁盘上仍是基线那份，
 *   所以必须用基线 id 去寻址；这也是 ops 契约"按磁盘当前内容寻址"的体现）。
 * * **连续插入倒序下发**：插入锚点只能指向已存在的块（本批新插入的块在服务端还没有 id），
 *   因此同一锚点下的多个插入要**倒着发**，最终顺序才是正的（实测：正序发会得到逆序结果）。
 * * 删除放在最后：锚点必须在其被删除前仍然存在。
 */
export function blocksToOps(base, merged) {
  const baseKeys = base.map((b) => b.blockId)
  const { counterpart, inserts } = alignToBase(baseKeys, merged.map((b) => b.blockId))
  const insertAt = new Map()
  for (const ins of inserts) {
    const list = insertAt.get(ins.after) || []
    for (const idx of ins.units) list.push(merged[idx])
    insertAt.set(ins.after, list)
  }

  const alive = new Set()
  for (let i = 0; i < base.length; i++) if (counterpart[i] >= 0) alive.add(i)

  const updates = []
  for (let i = 0; i < base.length; i++) {
    const j = counterpart[i]
    if (j < 0) continue
    const b = base[i]
    const mu = merged[j]
    if (deepEqual(b, mu)) continue
    if (b.kind === 'table') updates.push({ op: 'update', blockId: b.blockId, rows: mu.rows })
    else updates.push({ op: 'update', blockId: b.blockId, text: mu.text })
  }

  const insOps = []
  const keys = [-1, ...insertAt.keys()].sort((a, b) => a - b)
  for (const pos of keys) {
    const list = insertAt.get(pos)
    if (!list) continue
    const ai = anchorBaseIndex(baseKeys, counterpart, pos, alive)
    const after = ai >= 0 ? base[ai].blockId : null
    for (let k = list.length - 1; k >= 0; k--) {
      const u = list[k]
      const block = u.kind === 'table'
        ? { kind: 'table', rows: u.rows }
        : { kind: u.kind, text: u.text ?? '' }
      insOps.push({ op: 'insert', after, block })
    }
  }

  const dels = []
  for (let i = 0; i < base.length; i++) {
    if (counterpart[i] < 0) dels.push({ op: 'delete', blockId: base[i].blockId })
  }

  return [...updates, ...insOps, ...dels]
}

/**
 * base → merged 的 xlsx 写入 ops。
 * 按**基线行/列 id**寻址：只发真正变化的单元格；新增行用 `insertRow`（同上，倒序下发）。
 */
export function sheetMergeToOps(baseSheet, mergedRows) {
  const baseUnits = sheetRowUnits(baseSheet)
  const byId = new Map(baseUnits.map((u) => [u.rowId, u]))
  const rows = mergedRows.map((values, i) => ({ values, i }))
  const ops = []

  // 行级对齐：以 id 匹配为主、空档按位置兜底（与合并同一套口径）
  const mergedUnits = mergedRows.map((values, i) => ({ rowId: baseSheet.rowIds[i] ?? `#${i}`, values }))
  const { counterpart, inserts } = alignToBase(baseUnits.map((u) => u.rowId), mergedUnits.map((u) => u.rowId))

  for (let i = 0; i < baseUnits.length; i++) {
    const j = counterpart[i]
    if (j < 0) continue
    const bu = baseUnits[i]
    const mu = mergedUnits[j]
    const colIds = bu.colIds
    for (let c = 0; c < colIds.length; c++) {
      if (!deepEqual(bu.values[c] ?? null, mu.values[c] ?? null)) {
        ops.push({ op: 'updateCell', rowId: bu.rowId, colId: colIds[c], value: mu.values[c] ?? null })
      }
    }
  }

  const alive = new Set()
  for (let i = 0; i < baseUnits.length; i++) if (counterpart[i] >= 0) alive.add(i)
  for (const ins of inserts) {
    const list = ins.units.map((idx) => mergedUnits[idx])
    const ai = anchorBaseIndex(baseUnits.map((u) => u.rowId), counterpart, ins.after, alive)
    const after = ai >= 0 ? baseUnits[ai].rowId : null
    for (let k = list.length - 1; k >= 0; k--) {
      ops.push({ op: 'insertRow', after, values: list[k].values })
    }
  }
  for (let i = 0; i < baseUnits.length; i++) {
    if (counterpart[i] < 0) ops.push({ op: 'deleteRow', rowId: baseUnits[i].rowId })
  }
  return ops
}
