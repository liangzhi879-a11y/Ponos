// S4-1：文件模态分层、三层兜底、目录策略、占用/检出、冲突处置（纯逻辑）
// ---------------------------------------------------------------------------
// 本文件只测**纯函数**（毫秒级、不需磁盘）：S4 里最容易出错也最值得反复回归的就是这些规则
// （扩展名走错一层，后续"能不能原地写/要不要独占"全错）。
// IO 行为（版本链、占用日志落盘、L-B 字节不变）在 kernel-tests/file-collab.test.mjs 里测。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MODAL, classifyModal, canWriteInPlace, upgradeTarget, planFallback,
  parseDirPolicy, claimEnabled, measureSize, extOf,
  foldClaims, canCheckout, isReadonlyFor, canCheckin,
  planConflict, CONFLICT_CHOICES, DEFAULT_DIR_POLICY,
} from './file-modal.mjs'

// ---------------------------------------------------------------------------
// 模态判定
// ---------------------------------------------------------------------------

test('[模态] 四层判定的代表格式与边界（判据是能力，不是文件类型）', () => {
  // L-A：有稳定寻址单元 + 可回写
  for (const f of ['a.docx', 'a.xlsx', 'note.md', 'data.txt', 'cfg.json', 'rows.csv', 'pic.svg', 'code.ts']) {
    assert.equal(classifyModal(f), MODAL.A, `${f} 应为 L-A`)
    assert.equal(canWriteInPlace(f), true, `${f} 应可原地写`)
  }
  // L-B：能读、无稳定可写单元
  for (const f of ['a.pdf', 'scan.PNG', 'photo.jpeg', 'x.tif']) {
    assert.equal(classifyModal(f), MODAL.B, `${f} 应为 L-B`)
    assert.equal(canWriteInPlace(f), false)
  }
  // L-C：可转换升层
  for (const f of ['old.doc', 'legacy.XLS', 'page.html', 'mail.eml']) {
    assert.equal(classifyModal(f), MODAL.C, `${f} 应为 L-C`)
    assert.equal(canWriteInPlace(f), false, `${f} 原始格式不可原地写`)
  }
  // L-D：无稳定单元且不可转换
  for (const f of ['deck.pptx', 'design.psd', 'plan.dwg', 'bundle.zip', 'clip.mp4', 'raw.wav', 'unknown.xyz']) {
    assert.equal(classifyModal(f), MODAL.D, `${f} 应为 L-D`)
  }
})

test('[模态] 扩展名解析：大小写、多点名、无扩展名、路径分隔符', () => {
  assert.equal(extOf('A.DOCX'), '.docx')
  assert.equal(extOf('archive.tar.gz'), '.gz')
  assert.equal(extOf('noext'), '')
  assert.equal(extOf('.gitignore'), '', '以点开头的隐藏文件不算扩展名')
  assert.equal(extOf('dir/sub/文件.PDF'), '.pdf')
  assert.equal(extOf('dir\\sub\\win.docx'), '.docx', 'Windows 路径分隔符也要能解析')
  assert.equal(classifyModal('无扩展名'), MODAL.D, '未知/无扩展名按保守的 L-D 处理')
})

test('[模态] CSV 归 L-A（与仓库既有 TEXT_EXTS 口径一致，记档的差异）', () => {
  // 总设计 L-C 行把 CSV 与 HTML 并列，但仓库既有口径（shared/knowledge-pack.mjs 的 TEXT_EXTS）
  // 已把 .csv 当"可原地写的文本"（内容哈希前行尾归一）。两套判据会打架 —— 这里选既有口径，
  // 断言把它钉住，避免后来者"按总设计字面"改回去而悄悄改变可写性。
  assert.equal(classifyModal('data.csv'), MODAL.A)
  assert.equal(canWriteInPlace('data.csv'), true)
  // 而 HTML/EML 不同：它们没有可回写的结构化目标 ⇒ L-C
  assert.equal(classifyModal('page.html'), MODAL.C)
})

// ---------------------------------------------------------------------------
// 三层兜底
// ---------------------------------------------------------------------------

test('[兜底] L-A 直接协同；L-C 有转换能力时升入 L-A（产物上协同）', () => {
  const a = planFallback('report.docx', {})
  assert.equal(a.path, 'direct')
  assert.equal(a.modal, MODAL.A)
  assert.equal(a.writesInPlace, true)

  // .xls 有转换能力（本机 xlrd+openpyxl 齐备）⇒ 升层，且**在产物 .xlsx 上**协同
  const c = planFallback('old.xls', { convert: ['.xls'] })
  assert.equal(c.path, 'convert')
  assert.equal(c.modal, MODAL.A, '转换后按 L-A 协同')
  assert.equal(c.effectiveName, 'old.xlsx', '协同对象是转换产物，不是原文件')
  assert.equal(c.upgradeTo, '.xlsx')
  assert.equal(c.writesInPlace, true)
  assert.match(c.reason, /doc_toolkit\.py convert/, '理由里点明用的是既有转换器（不重实现）')
})

test('[兜底] 转换能力缺失（本机实测 .doc 缺 win32com）⇒ 不得假装能升层', () => {
  // 这条最关键：本机 win32com 缺失，`.doc→.docx` 实际不可用。
  // 实现必须如实降级，而不是"配置里写了就能转"。
  const r = planFallback('old.doc', { convert: [] })
  assert.notEqual(r.path, 'convert', '能力不可用时不得走转换路径')
  assert.notEqual(r.modal, MODAL.A, '也不得声称可原地写')
  assert.equal(r.writesInPlace, false)

  // 有提取能力 ⇒ 走提取（L-B：文件本身只追加版本）
  const ex = planFallback('old.doc', { convert: [], extract: true })
  assert.equal(ex.path, 'extract')
  assert.equal(ex.modal, MODAL.B)
  assert.equal(ex.writesInPlace, false)

  // 什么都没有 ⇒ 降级 L-D
  const down = planFallback('old.doc', { convert: [], extract: false })
  assert.equal(down.path, 'downgrade')
  assert.equal(down.modal, MODAL.D)
  assert.match(down.reason, /独占/, '降级理由要说清"走独占"，避免产生可合并的假象')
})

test('[兜底] 能力探测是"逐格式"的：只给 .xls 不能顺带让 .doc 也能转', () => {
  const r = planFallback('a.doc', { convert: ['.xls'] })
  assert.notEqual(r.path, 'convert', '.doc 不在可用列表里 ⇒ 不得走转换')
})

// ---------------------------------------------------------------------------
// 目录策略（批注 #3：全局默认关闭 + 按目录开启）
// ---------------------------------------------------------------------------

test('[策略 #3] 默认关闭：不给策略或空策略 ⇒ 占用一律不启用', () => {
  assert.equal(DEFAULT_DIR_POLICY.softClaim, false, '默认必须是关闭')
  for (const raw of [undefined, null, {}, { occupancy: 'exclusive' }]) {
    const p = parseDirPolicy(raw)
    assert.equal(p.softClaim, false, '缺 softClaim 视为关闭')
    // 即便文件是 L-D，默认也不启用占用 —— 这正是 #3 裁定的语义（opt-in）
    assert.equal(claimEnabled(MODAL.D, p), false)
    assert.equal(claimEnabled(MODAL.A, p), false)
  }
})

test('[策略 #3] 按目录开启：开启后 L-D 启用；advisory 下普通文件不启用', () => {
  const advisory = parseDirPolicy({ softClaim: true })
  assert.equal(claimEnabled(MODAL.D, advisory), true, 'L-D 在开启后启用占用')
  assert.equal(claimEnabled(MODAL.A, advisory), false, 'advisory 模式下 L-A 不占用（只提示性）')

  const exclusive = parseDirPolicy({ softClaim: true, occupancy: 'exclusive' })
  assert.equal(claimEnabled(MODAL.A, exclusive), true, 'exclusive 模式下所有文件都参与占用')
})

test('[策略] 非法字段被忽略（不因脏配置让策略变成未定义行为）', () => {
  const p = parseDirPolicy({ softClaim: 'yes', occupancy: 'bogus', maxFileBytes: 'big' })
  assert.equal(p.softClaim, false, '非布尔值不算开启')
  assert.equal(p.occupancy, 'advisory')
  assert.equal(p.maxFileBytes, null)
  const ok = parseDirPolicy({ softClaim: true, occupancy: 'exclusive', maxFileBytes: 1024 })
  assert.deepEqual([ok.softClaim, ok.occupancy, ok.maxFileBytes], [true, 'exclusive', 1024])
})

test('[策略 #8] 体积只度量、不阻断（批注未定 ⇒ 不擅自裁剪）', () => {
  assert.deepEqual(measureSize(10 * 1024 * 1024, parseDirPolicy({})),
    { bytes: 10 * 1024 * 1024, limit: null, overLimit: false }, '未设限 ⇒ 不判超限')
  const sized = measureSize(2048, parseDirPolicy({ maxFileBytes: 1024 }))
  assert.equal(sized.overLimit, true, '设了限就如实报告超限')
  assert.equal(sized.limit, 1024)
})

// ---------------------------------------------------------------------------
// 占用 / 检出（append-only 日志折叠）
// ---------------------------------------------------------------------------

const T0 = 1_000_000

test('[占用] 日志折叠：空 ⇒ free；claim ⇒ held；release ⇒ free；心跳续租', () => {
  assert.equal(foldClaims([], T0).state, 'free')
  assert.equal(foldClaims(null, T0).state, 'free')

  const held = foldClaims([{ type: 'claim', holder: 'A', at: T0, leaseMs: 60_000 }], T0 + 1000)
  assert.equal(held.state, 'held')
  assert.equal(held.holder, 'A')
  assert.equal(held.remainingMs, 59_000)

  const released = foldClaims([
    { type: 'claim', holder: 'A', at: T0, leaseMs: 60_000 },
    { type: 'release', holder: 'A', at: T0 + 2000 },
  ], T0 + 3000)
  assert.equal(released.state, 'free')

  // 心跳把到期时间往后推（否则长任务会莫名"被接管"）
  const hb = foldClaims([
    { type: 'claim', holder: 'A', at: T0, leaseMs: 60_000 },
    { type: 'heartbeat', holder: 'A', at: T0 + 50_000, leaseMs: 60_000 },
  ], T0 + 100_000)
  assert.equal(hb.state, 'held', '心跳后续租，不应算过期')
  assert.equal(hb.remainingMs, 10_000)
})

test('[占用] 租约到期 ⇒ expired（不是"还在占用"，也不是"消失了"）', () => {
  const st = foldClaims([{ type: 'claim', holder: 'A', at: T0, leaseMs: 1000 }], T0 + 5000)
  assert.equal(st.state, 'expired')
  assert.equal(st.holder, 'A', '过期的持有者仍要能报出来（排障需要知道是谁）')
  assert.equal(st.remainingMs, 0)
})

test('[检出] 互斥语义：#9 的"某人正在编辑，你目前只读"', () => {
  const claims = [{ type: 'claim', holder: 'A', at: T0, leaseMs: 60_000 }]
  // A 自己：已持有，可继续
  assert.deepEqual(canCheckout({ claims, requesterId: 'A', now: T0 + 1000 }).reason, 'already-held')
  // B：被拒，且必须给出**持有者**与**剩余时间**（否则用户只看到"不能编辑"却不知为何/要等多久）
  const b = canCheckout({ claims, requesterId: 'B', now: T0 + 1000 })
  assert.equal(b.ok, false)
  assert.equal(b.reason, 'held-by-other')
  assert.equal(b.holder, 'A')
  assert.equal(b.remainingMs, 59_000)
  // B 的只读判定（UI 状态条的来源）
  const ro = isReadonlyFor({ modal: MODAL.D, claims, requesterId: 'B', now: T0 + 1000, policy: parseDirPolicy({ softClaim: true }) })
  assert.equal(ro.readonly, true)
  assert.equal(ro.holder, 'A')
  // 对 A 自己不是只读
  assert.equal(isReadonlyFor({ modal: MODAL.D, claims, requesterId: 'A', now: T0 + 1000, policy: parseDirPolicy({ softClaim: true }) }).readonly, false)
})

test('[检出] 到期后可接管（且留下 takeover 痕迹）；未检出者不得检入', () => {
  const expired = [{ type: 'claim', holder: 'A', at: T0, leaseMs: 1000 }]
  const t = canCheckout({ claims: expired, requesterId: 'B', now: T0 + 5000 })
  assert.equal(t.ok, true, '过期的占用不应永久锁死文件')
  assert.equal(t.reason, 'takeover-expired')
  assert.equal(t.canTakeover, true)

  // takeover 之后的折叠结果：持有者换成 B，且记得是从谁手里接的
  const after = foldClaims([
    ...expired,
    { type: 'takeover', from: 'A', to: 'B', at: T0 + 5000, leaseMs: 60_000, reason: 'lease-expired' },
  ], T0 + 6000)
  assert.equal(after.holder, 'B')
  assert.equal(after.record.takenFrom, 'A')

  // 未检出者不得检入（否则等于绕过独占）
  assert.equal(canCheckin({ claims: [], requesterId: 'A', now: T0 }).reason, 'not-checked-out')
  const heldByA = [{ type: 'claim', holder: 'A', at: T0, leaseMs: 60_000 }]
  const bIn = canCheckin({ claims: heldByA, requesterId: 'B', now: T0 + 1000 })
  assert.equal(bIn.ok, false)
  assert.equal(bIn.reason, 'held-by-other')
  assert.equal(canCheckin({ claims: heldByA, requesterId: 'A', now: T0 + 1000 }).ok, true)
})

test('[检出] 占用关闭的目录：永远不算只读（#3 默认关闭的行为契约）', () => {
  const claims = [{ type: 'claim', holder: 'A', at: T0, leaseMs: 60_000 }]
  const ro = isReadonlyFor({ modal: MODAL.D, claims, requesterId: 'B', now: T0 + 1000, policy: parseDirPolicy({}) })
  assert.equal(ro.readonly, false, '默认关闭时即便有残留日志也不得把文件锁成只读')
  assert.equal(ro.reason, 'claims-disabled')
})

// ---------------------------------------------------------------------------
// 冲突处置（§5.4 四选一）
// ---------------------------------------------------------------------------

test('[冲突] 四选一：接受对方 / 保留我的 / 另存副本 / 进编辑器', () => {
  assert.deepEqual(CONFLICT_CHOICES, ['use-theirs', 'use-mine', 'save-copy', 'edit-merge'])
  const args = { base: 'B', mine: 'M', theirs: 'T' }

  const theirs = planConflict({ choice: 'use-theirs', ...args })
  assert.equal(theirs.action, 'write')
  assert.equal(theirs.content, 'T')

  const mine = planConflict({ choice: 'use-mine', ...args })
  assert.equal(mine.action, 'write')
  assert.equal(mine.content, 'M')

  const copy = planConflict({ choice: 'save-copy', ...args })
  assert.equal(copy.action, 'save-draft', '**副本必须降级为草稿**，不产生同目录近似文件')
  assert.equal(copy.content, 'M')
  assert.match(copy.note, /草稿/)

  const merge = planConflict({ choice: 'edit-merge', ...args })
  assert.equal(merge.action, 'merge-then-write', '进编辑器 = 交给 S1 的三路合并')
  assert.equal(merge.content, null)

  const bad = planConflict({ choice: 'whatever', ...args })
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.choices, ['use-theirs', 'use-mine', 'save-copy', 'edit-merge'], '非法取值要回带合法选项')
})
