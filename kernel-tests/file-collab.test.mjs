// S4-2 ~ S4-6：文件版本链 / L-B 只追加 / 软占用 / 检出检入（IO 层，真实文件系统）
// ---------------------------------------------------------------------------
// 与 `shared/file-modal.test.mjs` 的分工：那边测纯规则（模态、兜底、策略、折叠、冲突处置），
// 这边测**真的落盘行为** —— 尤其 §10-10 的头号验收断言："**L-B（pdf/图片）不产生原地写**"。
// 那条只能靠"字节哈希对照 + 目录快照对照"来证明，光看返回值不算数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MODAL, foldClaims, parseDirPolicy } from '../shared/file-modal.mjs'
import { TEAM_LAYOUT, teamPaths } from '../shared/team-source.mjs'
import {
  POLICY_FILE, claimFile, claimsOf, checkinFile, currentPathOf, ensureCollabDirs,
  heartbeatClaim, ingestFile, newFileId, policyForPath, readBlob, readPolicies,
  releaseClaim, resolveFileId, sha256Of, versionsOf, writePolicies, writabilityOf,
  DRAFTS_DIR, draftsDir, prepareConflictResolution, readVersionBuffer,
} from '../kernel/file-collab.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = mkdtempSync(join(tmpdir(), 'yfw-s4-'))

function rmRetry(p, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(p, { recursive: true, force: true }); return } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}
let seq = 0
/** 一次性的"用户目录 + 团队源"沙箱（每个用例互不干扰）。 */
function sandbox(tag) {
  const id = `${tag}-${++seq}`
  const userDir = join(ROOT, id, 'work')
  const teamRoot = join(ROOT, id, 'team')
  mkdirSync(userDir, { recursive: true })
  mkdirSync(teamRoot, { recursive: true })
  return { userDir, teamRoot }
}
/** 目录快照：文件名 → sha256（用于断言"纳管前后用户目录零变化"）。 */
function snapshot(dir) {
  const out = {}
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f)
    out[f] = statSync(p).isDirectory() ? '<dir>' : sha256Of(readFileSync(p))
  }
  return out
}
function writeUserFile(dir, name, content) {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

// ---------------------------------------------------------------------------
// 版本链
// ---------------------------------------------------------------------------

test('[版本链] 纳管：分配 fileId、内容入 CAS、写 bind/path/version 三类记录', () => {
  const { userDir, teamRoot } = sandbox('ingest')
  const f = writeUserFile(userDir, 'a.docx', 'AAAA')

  const r = ingestFile({ teamRoot, absPath: f, authorId: 'u1', caps: {} })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(r.fileId, /^[0-9a-f]{12}$/)
  assert.equal(r.versionId, sha256Of(Buffer.from('AAAA')))
  assert.equal(r.appended, true)
  assert.equal(r.modal, MODAL.A, 'docx 是 L-A')

  // CAS 落盘且内容可读回
  assert.deepEqual(readBlob(teamRoot, r.versionId).toString(), 'AAAA')
  assert.equal(existsSync(teamPaths(teamRoot).casBlob(r.versionId)), true)

  const recs = versionsOf(teamRoot, r.fileId)
  assert.deepEqual(recs.map((x) => x.type), ['bind', 'path', 'version'])
  assert.equal(recs[0].logicalName, 'a.docx')
  assert.equal(currentPathOf(teamRoot, r.fileId).path, f)

  // 路径 → fileId 可解析（版本链与路径解耦的前提）
  assert.equal(resolveFileId(teamRoot, f).fileId, r.fileId)
  assert.equal(resolveFileId(teamRoot, join(userDir, 'nope.docx')), null)
})

test('[版本链] 追加语义：同内容重复纳管不产生新版本；改内容产生新版本且旧版本仍可读', () => {
  const { userDir, teamRoot } = sandbox('append')
  const f = writeUserFile(userDir, 'a.txt', 'v1')

  const r1 = ingestFile({ teamRoot, absPath: f, caps: {} })
  const r2 = ingestFile({ teamRoot, absPath: f, caps: {} })
  assert.equal(r1.fileId, r2.fileId, '同一路径复用 fileId（否则版本链断裂）')
  assert.equal(r2.appended, false, '内容未变 ⇒ 不追加版本（避免版本链被空转刷屏）')
  assert.equal(versionsOf(teamRoot, r1.fileId).filter((x) => x.type === 'version').length, 1)

  writeFileSync(f, 'v2')
  const r3 = ingestFile({ teamRoot, absPath: f, caps: {} })
  assert.equal(r3.appended, true)
  assert.equal(r3.fileId, r1.fileId)
  assert.notEqual(r3.versionId, r1.versionId)
  const vs = versionsOf(teamRoot, r1.fileId).filter((x) => x.type === 'version')
  assert.equal(vs.length, 2)
  // 旧版本仍可读（append-only 的价值：历史不会被覆盖）
  assert.equal(readBlob(teamRoot, r1.versionId).toString(), 'v1')
  assert.equal(readBlob(teamRoot, r3.versionId).toString(), 'v2')
})

test('[版本链] 路径变更可追溯：同一 fileId 记录新的 path 行，历史路径保留在日志里', () => {
  const { userDir, teamRoot } = sandbox('path')
  const oldPath = writeUserFile(userDir, 'old.txt', 'same')
  const r = ingestFile({ teamRoot, absPath: oldPath, caps: {} })

  const newPath = join(userDir, 'renamed.txt')
  writeFileSync(newPath, 'same')
  rmSync(oldPath)
  const r2 = ingestFile({ teamRoot, absPath: newPath, caps: {}, fileId: r.fileId })

  assert.equal(r2.fileId, r.fileId)
  const paths = versionsOf(teamRoot, r.fileId).filter((x) => x.type === 'path').map((x) => x.path)
  assert.deepEqual(paths, [oldPath, newPath], '两次路径都要留在日志里')
  assert.equal(currentPathOf(teamRoot, r.fileId).path, newPath, '当前路径取最后一条')
  assert.equal(resolveFileId(teamRoot, oldPath), null, '旧路径不应再解析到该 fileId')
})

test('[版本链] 不使用 .bak 命名（总设计 §5.7）', () => {
  const { userDir, teamRoot } = sandbox('nobak')
  const f = writeUserFile(userDir, 'a.txt', 'x')
  ingestFile({ teamRoot, absPath: f, caps: {} })
  const all = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else all.push(relative(ROOT, p).replace(/\\/g, '/'))
    }
  }
  walk(teamRoot)
  walk(userDir)
  assert.equal(all.some((p) => p.endsWith('.bak') || p.includes('.bak.')), false,
    `不得出现 .bak（实测清单：${all.join(', ')}）`)
  // 临时文件也不该残留（校验写应已完成）
  assert.equal(all.some((p) => p.includes('.tmp-')), false, `不得残留临时文件：${all.join(', ')}`)
})

// ---------------------------------------------------------------------------
// S4-3：L-B 只追加、永不原地写（§10-10 头号验收）
// ---------------------------------------------------------------------------

test('[S4-3 / §10-10] L-B（pdf）纳管 ⇒ 目标文件与所在目录**零变化**，且尝试原地写被拒', () => {
  const { userDir, teamRoot } = sandbox('lb')
  const pdf = writeUserFile(userDir, 'manual.pdf', Buffer.from('PDF-假内容-但字节要一致'))
  const before = snapshot(userDir)
  const h0 = sha256Of(readFileSync(pdf))

  const r = ingestFile({ teamRoot, absPath: pdf, caps: { extract: true } })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.modal, MODAL.B, 'pdf 属 L-B（能读、无稳定可写单元）')
  assert.equal(r.writesInPlace, false)
  assert.equal(r.fallbackPath, 'extract', '有提取能力时走提取路径')

  // 核心断言：字节不变 + 目录零新增（含无 .bak/.tmp 残留）
  assert.equal(sha256Of(readFileSync(pdf)), h0, 'pdf 字节必须完全不变')
  assert.deepEqual(snapshot(userDir), before, '用户目录不得出现任何新文件/改名')

  // 可写性判定：L-B 永远只读（与占用无关，是格式能力决定的）
  const w = writabilityOf({ teamRoot, absPath: pdf, requesterId: 'u1', caps: { extract: true } })
  assert.equal(w.readonly, true)
  assert.equal(w.reason, 'modal-not-writable')

  // 图片同样属 L-B
  const png = writeUserFile(userDir, 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const hp = sha256Of(readFileSync(png))
  const rp = ingestFile({ teamRoot, absPath: png, caps: { extract: true } })
  assert.equal(rp.modal, MODAL.B)
  assert.equal(sha256Of(readFileSync(png)), hp)
})

test('[S4-1/3] L-C 无转换能力（本机 .doc 缺 win32com）⇒ 降级，绝不假装可写', () => {
  const { userDir, teamRoot } = sandbox('lc')
  const doc = writeUserFile(userDir, 'spec.doc', Buffer.from('旧格式假字节'))
  const before = snapshot(userDir)
  const h0 = sha256Of(readFileSync(doc))

  const r = ingestFile({ teamRoot, absPath: doc, caps: { convert: [], extract: true } })
  assert.equal(r.baseModal, MODAL.C)
  assert.equal(r.modal, MODAL.B, '有提取能力 ⇒ 退到 L-B')
  assert.equal(r.writesInPlace, false)
  assert.equal(sha256Of(readFileSync(doc)), h0)
  assert.deepEqual(snapshot(userDir), before)

  const down = ingestFile({ teamRoot, absPath: doc, caps: { convert: [], extract: false } })
  assert.equal(down.modal, MODAL.D, '既不能转换也不能提取 ⇒ 降级 L-D（独占）')
})

// ---------------------------------------------------------------------------
// S4-4：软占用（#3 全局默认关闭 + 按目录开启）
// ---------------------------------------------------------------------------

test('[S4-4 / #3] 默认关闭：claim 不写任何记录，也不把文件判成只读', () => {
  const { userDir, teamRoot } = sandbox('claimoff')
  const f = writeUserFile(userDir, 'deck.pptx', 'PPTX')
  const r = ingestFile({ teamRoot, absPath: f, caps: {} })
  assert.equal(r.modal, MODAL.D, 'pptx 属 L-D')

  const c = claimFile({ teamRoot, fileId: r.fileId, holder: 'A', modal: MODAL.D, policy: parseDirPolicy(null) })
  assert.equal(c.skipped, true, '默认关闭 ⇒ 跳过')
  assert.equal(c.reason, 'claims-disabled')
  assert.deepEqual(claimsOf(teamRoot, r.fileId), [], '不得写任何占用记录')
  assert.equal(existsSync(teamPaths(teamRoot).claimLog(r.fileId)), false, '连日志文件都不该产生')
})

test('[S4-4] 按目录开启：A 占用后 B 被拒并获知持有者与剩余时间；续租/释放/到期接管', () => {
  const { userDir, teamRoot } = sandbox('claimon')
  writePolicies(teamRoot, { dirs: { [userDir.replace(/\\/g, '/')]: { softClaim: true, occupancy: 'exclusive' } } })
  const f = writeUserFile(userDir, 'shared.docx', 'DOC')
  const r = ingestFile({ teamRoot, absPath: f, caps: {} })

  // 策略确实生效（这一条同时验证"绝对路径键"能命中）
  assert.equal(policyForPath(teamRoot, f).softClaim, true)

  const now = 1_000_000
  const lease = 60_000
  const a = claimFile({ teamRoot, fileId: r.fileId, holder: 'A', leaseMs: lease, now, modal: MODAL.A, policy: policyForPath(teamRoot, f) })
  assert.equal(a.claimed, true)

  const b = claimFile({ teamRoot, fileId: r.fileId, holder: 'B', leaseMs: lease, now: now + 1000, modal: MODAL.A, policy: policyForPath(teamRoot, f) })
  assert.equal(b.ok, false)
  assert.equal(b.code, 'held-by-other')
  assert.equal(b.holder, 'A')
  assert.equal(b.remainingMs, lease - 1000)

  // B 视角：只读且指明持有者（#9 状态条的数据来源）
  const wB = writabilityOf({ teamRoot, absPath: f, requesterId: 'B', now: now + 1000, caps: {} })
  assert.equal(wB.readonly, true)
  assert.equal(wB.holder, 'A')
  // A 自己可写
  assert.equal(writabilityOf({ teamRoot, absPath: f, requesterId: 'A', now: now + 1000, caps: {} }).readonly, false)

  // 心跳续租
  const hb = heartbeatClaim({ teamRoot, fileId: r.fileId, holder: 'A', leaseMs: lease, now: now + 50_000 })
  assert.equal(hb.ok, true)
  const stillA = writabilityOf({ teamRoot, absPath: f, requesterId: 'B', now: now + 100_000, caps: {} })
  assert.equal(stillA.readonly, true, '心跳后续租，B 仍不可写')

  // 到期 ⇒ B 可接管（并留痕）
  const takeover = claimFile({ teamRoot, fileId: r.fileId, holder: 'B', leaseMs: lease, now: now + 200_000, modal: MODAL.A, policy: policyForPath(teamRoot, f) })
  assert.equal(takeover.takenOver, true)
  assert.equal(takeover.from, 'A')
  const recs = claimsOf(teamRoot, r.fileId)
  assert.equal(recs.some((x) => x.type === 'takeover' && x.from === 'A' && x.to === 'B'), true, '接管必须留痕')
  assert.equal(writabilityOf({ teamRoot, absPath: f, requesterId: 'B', now: now + 200_100, caps: {} }).readonly, false)

  // 释放后回到自由态
  assert.equal(releaseClaim({ teamRoot, fileId: r.fileId, holder: 'B', now: now + 201_000 }).released, true)
  assert.equal(writabilityOf({ teamRoot, absPath: f, requesterId: 'A', now: now + 202_000, caps: {} }).readonly, false)
})

test('[S4-4] 相对目录键同样生效（策略键写 "design" 覆盖任意层级下的 design 目录）', () => {
  const { userDir, teamRoot } = sandbox('relkey')
  writePolicies(teamRoot, { dirs: { design: { softClaim: true } } })
  const d = join(userDir, 'design')
  mkdirSync(d, { recursive: true })
  const f = writeUserFile(d, 'a.psd', 'PSD')
  assert.equal(policyForPath(teamRoot, f).softClaim, true, '相对键应命中 …/design/…')
  assert.equal(policyForPath(teamRoot, join(userDir, 'other', 'a.psd')).softClaim, false, '非 design 目录不受影响')
})

test('[S4-4] 策略文件缺失/损坏 ⇒ 回落默认关闭（不因脏配置改变行为）', () => {
  const { teamRoot } = sandbox('badpolicy')
  assert.deepEqual(readPolicies(teamRoot), { dirs: {} })
  writeFileSync(join(teamRoot, POLICY_FILE), '{ 这不是 JSON')
  assert.deepEqual(readPolicies(teamRoot), { dirs: {} })
  assert.equal(policyForPath(teamRoot, 'any/thing.docx').softClaim, false)
})

// ---------------------------------------------------------------------------
// S4-5：L-D 检出/检入（#9）
// ---------------------------------------------------------------------------

test('[S4-5 / §10-10] L-D 独占：互斥、只读、检入生版本并释放、未检出者不得检入', () => {
  const { userDir, teamRoot } = sandbox('ld')
  const f = writeUserFile(userDir, 'deck.pptx', 'DECK-v1')
  writePolicies(teamRoot, { dirs: { [userDir.replace(/\\/g, '/')]: { softClaim: true, occupancy: 'exclusive' } } })
  const r = ingestFile({ teamRoot, absPath: f, caps: {} })
  assert.equal(r.modal, MODAL.D)
  const policy = policyForPath(teamRoot, f)

  // 未检出者不得检入（**必须在任何人检出之前测**：一旦 A 持有，原因就变成"他人持有"了）
  const ciFree = checkinFile({ teamRoot, fileId: r.fileId, holder: 'C', absPath: f, caps: {} })
  assert.equal(ciFree.ok, false)
  assert.equal(ciFree.code, 'not-checked-out', '无人持有 ⇒ 报"未检出"')

  // A 检出
  const co = claimFile({ teamRoot, fileId: r.fileId, holder: 'A', leaseMs: 60_000, modal: MODAL.D, policy })
  assert.equal(co.claimed, true)

  // B 检出被拒（独占语义）
  const co2 = claimFile({ teamRoot, fileId: r.fileId, holder: 'B', leaseMs: 60_000, modal: MODAL.D, policy })
  assert.equal(co2.ok, false)
  assert.equal(co2.code, 'held-by-other')

  // 他人持有期间检入：原因必须精确为 held-by-other 且带出持有者
  const ciB = checkinFile({ teamRoot, fileId: r.fileId, holder: 'B', absPath: f, caps: {} })
  assert.equal(ciB.ok, false)
  assert.equal(ciB.code, 'held-by-other')
  assert.equal(ciB.holder, 'A', '要告诉调用方现在是谁持有（否则用户只知道"不能检入"）')

  // A 改动后检入 ⇒ 新版本 + 释放
  writeFileSync(f, 'DECK-v2')
  const ci = checkinFile({ teamRoot, fileId: r.fileId, holder: 'A', absPath: f, caps: {}, note: '改完一版' })
  assert.equal(ci.ok, true, JSON.stringify(ci))
  assert.equal(ci.released, true)
  assert.notEqual(ci.versionId, r.versionId)
  assert.equal(readBlob(teamRoot, ci.versionId).toString(), 'DECK-v2')
  const vs = versionsOf(teamRoot, r.fileId).filter((x) => x.type === 'version')
  assert.equal(vs.length, 2)
  assert.equal(vs[1].note, '改完一版')
  // 释放后他人可检出
  assert.equal(claimFile({ teamRoot, fileId: r.fileId, holder: 'B', leaseMs: 60_000, modal: MODAL.D, policy }).claimed, true)
})

test('[S4-5] 检入不改变 L-D 的"不可原地写"判定（独占 ≠ 可合并）', () => {
  // 容易混淆的一点：检出期间"持有者可写"是**占用层面**的许可；L-D 在**格式层面**始终不可
  // 原地结构化写。两者必须分开报告，否则 UI 会给人"pptx 也能像 docx 那样逐块合并"的错觉。
  const { userDir, teamRoot } = sandbox('ld2')
  const f = writeUserFile(userDir, 'deck.pptx', 'D')
  writePolicies(teamRoot, { dirs: { [userDir.replace(/\\/g, '/')]: { softClaim: true, occupancy: 'exclusive' } } })
  const r = ingestFile({ teamRoot, absPath: f, caps: {} })
  claimFile({ teamRoot, fileId: r.fileId, holder: 'A', leaseMs: 60_000, modal: MODAL.D, policy: policyForPath(teamRoot, f) })
  const w = writabilityOf({ teamRoot, absPath: f, requesterId: 'A', caps: {} })
  assert.equal(w.readonly, true, '持有者也不能"原地写"：L-D 没有结构化写路径')
  assert.equal(w.reason, 'modal-not-writable')
  assert.equal(w.modal, MODAL.D)
})

test('[S4] 占位符文件被拒绝纳管（避免把网盘未下载的空内容当版本）', () => {
  // 判据在 S3 的 detectPlaceholderSync（真实占位符依赖 Windows 云文件属性，本机造不出）。
  // 这里做**反向**断言：普通文件不得被误判为占位符（否则正常纳管全被拦）。
  const { userDir, teamRoot } = sandbox('ph')
  const f = writeUserFile(userDir, 'normal.docx', 'content')
  const r = ingestFile({ teamRoot, absPath: f, caps: {} })
  assert.equal(r.ok, true, '普通文件必须能正常纳管（占位符判定不得误伤）')
  // 0 字节文件也不应被"占位符判定"之外的机制拦住（它自身是合法内容）
  const empty = writeUserFile(userDir, 'empty.txt', '')
  const r2 = ingestFile({ teamRoot, absPath: empty, caps: {} })
  assert.equal(r2.ok, true)
  assert.equal(r2.bytes, 0)
})

test('[S4] ensureCollabDirs 幂等；且不触碰 S3 的 team.json', () => {
  const { teamRoot } = sandbox('dirs')
  const p1 = ensureCollabDirs(teamRoot)
  ensureCollabDirs(teamRoot)
  for (const d of [p1.casDir, p1.versionsDir, p1.claimsDir]) assert.equal(existsSync(d), true)
  assert.equal(existsSync(join(teamRoot, TEAM_LAYOUT.MANIFEST)), false, 'S4 不该去创建/改写 S3 的清单文件')
})

// ---------------------------------------------------------------------------
// S4-6：冲突处置（读三版本 → 四选一 → 落盘物）
// ---------------------------------------------------------------------------

/** 造出 base/mine/theirs 三个版本（同一条版本链上的三份内容）。 */
function threeVersions(teamRoot, userDir, tag) {
  const f = join(userDir, `${tag}.txt`)
  const out = {}
  for (const [key, content] of [['base', 'BASE'], ['mine', 'MINE'], ['theirs', 'THEIRS']]) {
    writeFileSync(f, content)
    const r = ingestFile({ teamRoot, absPath: f, caps: {} })
    assert.equal(r.ok, true, JSON.stringify(r))
    out[key] = r.versionId
  }
  return { f, ids: out }
}

test('[S4-6] use-theirs / use-mine ⇒ 产出对应内容，不改动任何文件', () => {
  const { userDir, teamRoot } = sandbox('c-resolve')
  const { f, ids } = threeVersions(teamRoot, userDir, 'doc')
  writeFileSync(f, 'CURRENT-ON-DISK')
  const before = snapshot(userDir)

  const t = prepareConflictResolution({ teamRoot, fileId: resolveFileId(teamRoot, f).fileId, logicalName: 'doc.txt', baseVersionId: ids.base, mineVersionId: ids.mine, theirsVersionId: ids.theirs, choice: 'use-theirs' })
  assert.equal(t.ok, true, JSON.stringify(t))
  assert.equal(t.action, 'write')
  assert.equal(t.source, 'theirs')
  assert.equal(t.content.toString(), 'THEIRS')

  const m = prepareConflictResolution({ teamRoot, fileId: resolveFileId(teamRoot, f).fileId, logicalName: 'doc.txt', baseVersionId: ids.base, mineVersionId: ids.mine, theirsVersionId: ids.theirs, choice: 'use-mine' })
  assert.equal(m.source, 'mine')
  assert.equal(m.content.toString(), 'MINE')

  // 处置只产出决策，**不得**顺手改盘（落盘是单独的显式动作）
  assert.deepEqual(snapshot(userDir), before, '处置阶段不得改动用户文件')
})

test('[S4-6] save-copy ⇒ 我的改动成为**草稿**，落在团队源 drafts/，用户目录零变化', () => {
  const { userDir, teamRoot } = sandbox('c-draft')
  const { f, ids } = threeVersions(teamRoot, userDir, 'plan')
  const before = snapshot(userDir)

  const r = prepareConflictResolution({ teamRoot, fileId: resolveFileId(teamRoot, f).fileId, logicalName: 'plan.txt', baseVersionId: ids.base, mineVersionId: ids.mine, theirsVersionId: ids.theirs, choice: 'save-copy' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.action, 'save-draft')
  assert.equal(r.source, 'mine', '草稿保存的是**我的**改动（把对方当正本）')

  // 草稿落在团队源内、目录名直白、文件名带版本前缀（同名文件多份草稿互不覆盖）
  assert.ok(r.draftPath.replace(/\\/g, '/').includes(`/${DRAFTS_DIR}/`), `草稿应在 drafts/ 内：${r.draftPath}`)
  assert.equal(r.draftPath.startsWith(draftsDir(teamRoot)), true)
  assert.equal(readFileSync(r.draftPath).toString(), 'MINE')
  assert.ok(r.draftPath.includes(ids.mine.slice(0, 8)), '文件名带来源版本前缀 ⇒ 不同草稿不互相覆盖')

  // 关键：不产生"同目录多份近似文件"（定案 3），也不产生 .bak
  assert.deepEqual(snapshot(userDir), before, '用户目录不得新增任何文件')
  const drafts = readdirSync(join(draftsDir(teamRoot), resolveFileId(teamRoot, f).fileId))
  assert.equal(drafts.length, 1)
  assert.equal(drafts.some((n) => n.endsWith('.bak')), false)

  // 草稿动作也要留痕（append-only 日志里可追溯"曾生成过草稿"）
  const recs = versionsOf(teamRoot, resolveFileId(teamRoot, f).fileId)
  assert.equal(recs.some((x) => x.type === 'draft' && x.fromVersionId === ids.mine), true)
})

test('[S4-6] edit-merge ⇒ 决策为"交给合并"，不在本层做合并（S1 职责）', () => {
  const { userDir, teamRoot } = sandbox('c-merge')
  const { f, ids } = threeVersions(teamRoot, userDir, 'm')
  const r = prepareConflictResolution({ teamRoot, fileId: resolveFileId(teamRoot, f).fileId, logicalName: 'm.txt', baseVersionId: ids.base, mineVersionId: ids.mine, theirsVersionId: ids.theirs, choice: 'edit-merge' })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'merge-then-write')
  assert.equal(r.content, null, '合并结果由 S1 的三路合并产出，本层不预置内容')
  assert.match(r.note, /S1|三路合并/)
})

test('[S4-6] 版本缺失/损坏 ⇒ 明确报错，绝不静默以空内容继续', () => {
  // 这条是"不静默"原则在冲突处置上的落地：把空内容当对方版本会直接清空用户数据。
  const { userDir, teamRoot } = sandbox('c-bad')
  const { f, ids } = threeVersions(teamRoot, userDir, 'b')
  const fileId = resolveFileId(teamRoot, f).fileId

  const missing = prepareConflictResolution({ teamRoot, fileId, logicalName: 'b.txt', baseVersionId: 'f'.repeat(64), mineVersionId: ids.mine, theirsVersionId: ids.theirs, choice: 'use-theirs' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'version-missing')

  const noId = prepareConflictResolution({ teamRoot, fileId, logicalName: 'b.txt', baseVersionId: null, mineVersionId: ids.mine, theirsVersionId: ids.theirs, choice: 'use-theirs' })
  assert.equal(noId.code, 'version-required')
})

test('[S4-6] 非法处置方式 ⇒ 回带合法选项（不做默认兜底）', () => {
  const { userDir, teamRoot } = sandbox('c-badchoice')
  const { f, ids } = threeVersions(teamRoot, userDir, 'c')
  const r = prepareConflictResolution({ teamRoot, fileId: resolveFileId(teamRoot, f).fileId, logicalName: 'c.txt', baseVersionId: ids.base, mineVersionId: ids.mine, theirsVersionId: ids.theirs, choice: 'pick-one' })
  assert.equal(r.ok, false)
  assert.deepEqual(r.choices, ['use-theirs', 'use-mine', 'save-copy', 'edit-merge'])
})

test('[S4-6] readVersionBuffer 会校验"取回内容 == 该 id"（防 CAS 损坏被当成正常版本）', () => {
  const { userDir, teamRoot } = sandbox('cas')
  const f = writeUserFile(userDir, 'x.txt', 'REAL')
  const r = ingestFile({ teamRoot, absPath: f, caps: {} })
  assert.equal(readVersionBuffer(teamRoot, r.versionId).ok, true)

  // 手工把 CAS 文件改成别的内容（同一路径、不同内容）⇒ 必须报 version-corrupted
  const blob = teamPaths(teamRoot).casBlob(r.versionId)
  writeFileSync(blob, 'TAMPERED')
  const bad = readVersionBuffer(teamRoot, r.versionId)
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'version-corrupted')
})

test('[S4-5/6] 检入冲突：我检出后他人提交了新版本 ⇒ 拒绝覆盖，并交回三方版本 id', () => {
  // 这是 S4 里**唯一自然的三方入口**：base = 我检出那一刻的版本；theirs = 期间他人提交的版本；
  // mine = 我本地磁盘上的内容。三者齐备才谈得上 §5.4 的四选一。
  // 断言的重点是"**不覆盖**"：实现绝不能悄悄以我的内容盖掉对方的提交。
  const { userDir, teamRoot } = sandbox('ci-conflict')
  const f = writeUserFile(userDir, 'shared.txt', 'V1-基线')
  const r1 = ingestFile({ teamRoot, absPath: f, authorId: 'A', caps: {} })
  const fileId = r1.fileId

  // A 检出（记下检出时的版本 = V1）
  const co = claimFile({ teamRoot, fileId, holder: 'A', leaseMs: 600_000, modal: MODAL.A, policy: parseDirPolicy({ softClaim: true, occupancy: 'exclusive' }) })
  assert.equal(co.claimed, true)
  assert.equal(co.versionId, r1.versionId, '检出记录里要写清"从哪个版本开始编辑"（否则无从判断冲突）')

  // 期间 B 提交了新版本（模拟"另一个人也在改同一个文件并先提交了"）
  writeFileSync(f, 'V2-对方提交')
  const r2 = ingestFile({ teamRoot, absPath: f, authorId: 'B', caps: {}, fileId })
  assert.equal(r2.appended, true)
  assert.notEqual(r2.versionId, r1.versionId)

  // A 本地也改了，然后检入 ⇒ 必须拒绝，并交回 base/mine/theirs
  writeFileSync(f, 'V3-我的改动')
  const ci = checkinFile({ teamRoot, fileId, holder: 'A', absPath: f, authorId: 'A', caps: {} })
  assert.equal(ci.ok, false, '不得悄悄以我的内容覆盖对方的提交')
  assert.equal(ci.code, 'checkin-conflict')
  assert.equal(ci.baseVersionId, r1.versionId, 'base = 我检出的版本')
  assert.equal(ci.theirsVersionId, r2.versionId, 'theirs = 对方提交的版本')
  assert.equal(ci.mineVersionId, sha256Of(Buffer.from('V3-我的改动')), 'mine = 我磁盘上的内容')
  assert.equal(ci.theirsAuthorId, 'B', '要告诉用户"是谁先提交的"')

  // 关键：冲突路径**不得追加版本**（我的内容只进 CAS 供处置读取），也不得释放占用
  const vs = versionsOf(teamRoot, fileId).filter((x) => x.type === 'version')
  assert.equal(vs.length, 2, '冲突时不得产生第三个版本（未经人决定的提交不算提交）')
  assert.deepEqual(vs.map((x) => x.authorId), ['A', 'B'])
  assert.equal(claimsOf(teamRoot, fileId).some((x) => x.type === 'release'), false, '冲突时不得释放占用（我的编辑还在进行中）')
  assert.equal(foldClaims(claimsOf(teamRoot, fileId), Date.now()).holder, 'A', 'A 仍持有检出')

  // 我的内容确实进了 CAS（否则后续"另存为草稿"取不到内容）
  assert.equal(readBlob(teamRoot, ci.mineVersionId).toString(), 'V3-我的改动')

  // 走完四选一（另存副本）后，草稿可取到我的内容
  const resolved = prepareConflictResolution({
    teamRoot, fileId, logicalName: 'shared.txt',
    baseVersionId: ci.baseVersionId, mineVersionId: ci.mineVersionId, theirsVersionId: ci.theirsVersionId,
    choice: 'save-copy',
  })
  assert.equal(resolved.ok, true, JSON.stringify(resolved))
  assert.equal(resolved.action, 'save-draft')
  assert.equal(readFileSync(resolved.draftPath).toString(), 'V3-我的改动')
})

test('[S4-5] 无人提交过新版本时，检入正常通过（冲突检测不得误报）', () => {
  // 反向断言：冲突判定过宽会让"正常检入"也失败，那比漏报更糟（用户完全无法提交）。
  const { userDir, teamRoot } = sandbox('ci-ok')
  const f = writeUserFile(userDir, 'solo.txt', 'V1')
  const r1 = ingestFile({ teamRoot, absPath: f, authorId: 'A', caps: {} })
  claimFile({ teamRoot, fileId: r1.fileId, holder: 'A', leaseMs: 600_000, modal: MODAL.A, policy: parseDirPolicy({ softClaim: true, occupancy: 'exclusive' }) })
  writeFileSync(f, 'V2')
  const ci = checkinFile({ teamRoot, fileId: r1.fileId, holder: 'A', absPath: f, authorId: 'A', caps: {} })
  assert.equal(ci.ok, true, JSON.stringify(ci))
  assert.equal(ci.released, true)
  assert.equal(versionsOf(teamRoot, r1.fileId).filter((x) => x.type === 'version').length, 2)

  // 自己提交的版本（同一 authorId）不算"他人提交" ⇒ 再次检入不应因自己的历史版本报冲突
  claimFile({ teamRoot, fileId: r1.fileId, holder: 'A', leaseMs: 600_000, modal: MODAL.A, policy: parseDirPolicy({ softClaim: true, occupancy: 'exclusive' }) })
  writeFileSync(f, 'V3')
  const again = checkinFile({ teamRoot, fileId: r1.fileId, holder: 'A', absPath: f, authorId: 'A', caps: {} })
  assert.equal(again.ok, true, '自己的连续提交不该被判成冲突')
})

test.after(() => rmRetry(ROOT))
