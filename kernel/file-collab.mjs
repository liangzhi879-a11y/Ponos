/**
 * S4-2/3：文件版本链、L-B 只追加语义、软占用与检出检入（IO 层）
 *
 * 复用 S3 已备好的路径与写盘原语（`teamPaths` / `writeVerifiedSync` / `detectPlaceholderSync`），
 * 不新造同步机制、不引入锁文件做正确性依据（总设计定案 8：锁**不得参与正确性**）。
 *
 * —— 三条硬约束（都有对应的测试断言）——
 * ① **一律追加、永不原地改**：版本链与占用都是 append-only 日志。
 *    不用"读全量 → 改 → 写回"（那正是丢失更新的经典成因），也不用覆盖式状态文件。
 * ② **不使用 `.bak` 命名**（总设计 §5.7 与定案 3 的补充）：临时文件用 `.tmp-<pid>-<ts>`，
 *    且写在**团队源目录内**；用户的文件目录里不产生任何新文件。
 * ③ **L-B 永不原地写**（§10-10 头号验收）：纳管只是"读内容 + 存进 CAS"，
 *    目标文件字节与所在目录内容都不得发生变化。
 */
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { TEAM_LAYOUT, detectPlaceholderSync, teamPaths, writeVerifiedSync, hideContainerSync } from '../shared/team-source.mjs'
import {
  MODAL, classifyModal, claimEnabled, foldClaims, measureSize, parseDirPolicy, planFallback, planConflict,
} from '../shared/file-modal.mjs'

/**
 * 目录策略文件名（独立于 S3 的 `team.json`：**不去改 S3 的清单格式**，避免相互踩）。
 * 名字由 `TEAM_LAYOUT` 唯一定义；文件本身也在**容器**内（`<团队根>/.yfworking/policies.json`），
 * 与用户的工作文件分开。
 */
export const POLICY_FILE = TEAM_LAYOUT.POLICY_FILE

/** 内容哈希 = versionId（与 S1 的 `baseVersion` 同源：都是整文件 sha256）。 */
export function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 12 位十六进制 fileId（可注入以便测试确定性）。 */
export function newFileId() {
  return randomBytes(6).toString('hex')
}

/** 确保团队源标准目录存在（幂等；用 S3 的布局常量，避免手拼路径写歪）。 */
export function ensureCollabDirs(teamRoot) {
  const p = teamPaths(teamRoot)
  // `p.container` 必须在子目录之前建；建完设 Windows 隐藏属性（点开头在 Windows 上不隐藏）
  for (const d of [p.root, p.container, p.casDir, p.versionsDir, p.claimsDir]) {
    mkdirSync(d, { recursive: true })
  }
  hideContainerSync(p.container)
  return p
}

// ---------------------------------------------------------------------------
// 目录策略（批注 #3：全局默认关闭 + 按目录开启）
// ---------------------------------------------------------------------------

/** 读策略文件；缺失/损坏一律回落到"默认关闭"（不因脏配置改变行为）。 */
export function readPolicies(teamRoot) {
  // 双读：容器内的 policies.json 优先，旧布局（团队根下）回退 —— 旧团队的目录策略仍然生效
  const f = teamPaths(teamRoot).read.policyFile()
  if (!existsSync(f)) return { dirs: {} }
  try {
    const j = JSON.parse(readFileSync(f, 'utf-8'))
    return { dirs: (j && typeof j.dirs === 'object' && j.dirs) || {} }
  } catch {
    return { dirs: {} }
  }
}

/** 写策略文件（覆盖式是**可以**的：它是配置而非并发数据，且写入走校验写）。 */
export function writePolicies(teamRoot, policies) {
  const f = teamPaths(teamRoot).policyFile
  writeVerifiedSync(f, JSON.stringify(policies, null, 2))
  return f
}

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 取某文件生效的策略：**最具体者优先**（长键优先，等价于"子目录覆盖父目录"）。
 *
 * 键的两种写法都支持（实测必需：纳管的是**用户的绝对路径**，而策略通常按团队内的目录名写）：
 *   * **绝对路径键**（`C:/work/design`）：命中同一目录及其子目录；
 *   * **相对目录键**（`design`）：命中路径中**任一层级**的同名目录（`…/design/…`）。
 *     语义 = "凡在 design 目录下的文件都适用"，代价是**同名目录会一起生效**（记档；S4 不做
 *     "按团队源相对位置"的映射，因为纳管是引用式、不把文件搬进团队源）。
 * 未配置任何匹配 ⇒ 默认策略（批注 #3：全局默认关闭）。
 */
export function policyForPath(teamRoot, filePath) {
  const target = normPath(filePath)
  const { dirs } = readPolicies(teamRoot)
  const keys = Object.keys(dirs || {})
    .map((k) => ({ k, n: normPath(k) }))
    .filter((x) => x.n.length > 0)
    .sort((a, b) => b.n.length - a.n.length) // 最具体的优先
  for (const { k, n } of keys) {
    const isAbs = /^[a-z]:\//.test(n) || n.startsWith('/')
    const hit = isAbs
      ? (target === n || target.startsWith(n + '/'))
      : (target === n || target.startsWith(n + '/') || target.includes('/' + n + '/') || target.endsWith('/' + n))
    if (hit) return parseDirPolicy(dirs[k])
  }
  return parseDirPolicy(null)
}

// ---------------------------------------------------------------------------
// append-only 日志
// ---------------------------------------------------------------------------

/**
 * 追加一行 JSON 并**回读校验**。
 *
 * 为什么手动 append 而不是"读全量→追加→原子替换"：后者在并发下会互相覆盖（两个人的两条记录
 * 只剩一条）。`O_APPEND` 的单次小写入是原子的，正合 append-only 日志的语义。
 * 回读校验是必要的：写盘静默失败会让"已记录"的判断全错（S3 的 `writeVerifiedSync` 出于同一考虑）。
 */
export function appendRecord(file, rec) {
  mkdirSync(join(file, '..'), { recursive: true })
  const line = JSON.stringify(rec) + '\n'
  appendFileSync(file, line, 'utf-8')
  const back = readFileSync(file, 'utf-8')
  if (!back.endsWith(line)) throw new Error(`追加校验失败（回读不匹配）：${file}`)
  return rec
}

function readJsonl(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const raw of readFileSync(file, 'utf-8').split('\n')) {
    const s = raw.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 跳过损坏行：日志不该因一行坏掉而整体不可用 */ }
  }
  return out
}

/**
 * 双读一个 append-only 日志文件（容器内 / 旧布局）的**行并集**。
 *
 * 为什么日志不能用"容器优先、缺失回退"的 `read.*`：追加写只落在容器侧，而给旧团队追加**第一条**
 * 记录时会在容器里**新建**该文件 ⇒ 一旦新建，`read.*` 就再也看不到旧侧那整段历史，
 * 表现为"版本链突然只剩一条""占用记录凭空消失"。故日志必须取并集。
 *
 * 顺序：**先旧侧后容器侧** —— 追加写只写容器侧，旧侧文件因此是"冻结的历史"，
 * 这个顺序天然等于时间序（版本链取"最后一条"，顺序错了结论就会错）。
 * 对完全相同的行去重：防御性处理，万一两侧被同时写过也不会产生重复记录。
 */
function readJsonlDual(teamRoot, pick) {
  const p = teamPaths(teamRoot)
  const seen = new Set()
  const out = []
  for (const f of [pick(p.legacy), pick(p)]) {
    if (!existsSync(f)) continue
    for (const raw of readFileSync(f, 'utf-8').split('\n')) {
      const s = raw.trim()
      if (!s || seen.has(s)) continue
      seen.add(s)
      try { out.push(JSON.parse(s)) } catch { /* 跳过损坏行（同 readJsonl） */ }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 版本链
// ---------------------------------------------------------------------------

export function versionsOf(teamRoot, fileId) {
  // 双读行并集（见 readJsonlDual 的说明：日志不能用"缺失回退"，否则新建即遮蔽历史）
  return readJsonlDual(teamRoot, (q) => q.versionLog(fileId))
}

/** 该 fileId 的当前绑定路径（取最后一条 path/bind 行）。 */
export function currentPathOf(teamRoot, fileId) {
  let path = null
  let logicalName = null
  for (const r of versionsOf(teamRoot, fileId)) {
    if (r.type === 'bind') logicalName = r.logicalName
    else if (r.type === 'path') path = r.path
  }
  return { path, logicalName }
}

/**
 * 路径 → fileId。扫描 `versions/*.jsonl` 的 path 行。
 * 代价 O(文件数 × 日志长度)，规模在团队源量级可接受；将来可加索引（不改本函数签名即可换实现）。
 */
export function resolveFileId(teamRoot, absPath) {
  const p = teamPaths(teamRoot)
  // 双读：新旧两个 versions 目录的并集（旧团队已纳管的文件不能被漏掉）
  const names = new Set()
  for (const d of [p.versionsDir, p.legacy.versionsDir]) {
    let list = []
    try { list = readdirSync(d) } catch { continue }
    for (const f of list) if (f.endsWith('.jsonl')) names.add(f)
  }
  const target = String(absPath)
  for (const f of names) {
    const fileId = f.slice(0, -'.jsonl'.length)
    const { path } = currentPathOf(teamRoot, fileId)
    if (path && (path === target || path.replace(/\\/g, '/') === target.replace(/\\/g, '/'))) {
      return { fileId, path }
    }
  }
  return null
}

/** 把内容写入 CAS（内容寻址：同名即同内容，天然免疫网盘冲突副本）。 */
export function putBlob(teamRoot, buf) {
  const hash = sha256Of(buf)
  const dest = teamPaths(teamRoot).casBlob(hash)
  if (!existsSync(dest)) {
    mkdirSync(join(dest, '..'), { recursive: true })
    writeVerifiedSync(dest, buf, { expectHash: hash })
  }
  return { versionId: hash, bytes: buf.length, blob: dest }
}

export function readBlob(teamRoot, versionId) {
  // 双读：旧团队的内容块在团队根下的 cas/，容器里没有 ⇒ 不回退就会读不到历史版本
  const f = teamPaths(teamRoot).read.casBlob(versionId)
  if (!existsSync(f)) return null
  return readFileSync(f)
}

/**
 * 纳管一个文件（首次分配 fileId；再次纳管复用并追加新版本）。
 *
 * **绝不修改目标文件、绝不在目标目录留文件**（L-B 验收与"不用 .bak"都靠这条）。
 * 占位符（网盘未下载）⇒ 明确拒绝：把 0 字节占位当内容纳管，会造成"内容凭空丢失"的假象。
 */
export function ingestFile({ teamRoot, absPath, authorId = null, caps = {}, note = null, now = Date.now(), fileId = null }) {
  const p = ensureCollabDirs(teamRoot)

  if (!existsSync(absPath)) return { ok: false, code: 'file-missing', error: `文件不存在：${absPath}` }

  const ph = detectPlaceholderSync(absPath)
  if (ph && ph.placeholder) {
    return { ok: false, code: 'placeholder-file', error: `文件是网盘占位符（未下载），拒绝纳管以免把空内容当版本：${ph.reason}`, size: ph.size }
  }

  const buf = readFileSync(absPath)
  const plan = planFallback(absPath, caps)
  const existing = resolveFileId(teamRoot, absPath)
  const id = fileId || (existing && existing.fileId) || newFileId()
  const log = p.versionLog(id)

  if (!existsSync(log)) {
    appendRecord(log, { type: 'bind', fileId: id, logicalName: absPath.split(/[\\/]/).pop(), at: now })
  }
  appendRecord(log, { type: 'path', path: absPath, at: now })

  const { versionId, bytes } = putBlob(teamRoot, buf)
  const versions = versionsOf(teamRoot, id).filter((r) => r.type === 'version')
  const last = versions[versions.length - 1]
  let appended = false
  if (!last || last.versionId !== versionId) {
    appendRecord(log, {
      type: 'version', versionId, bytes, authorId, at: now, note,
      modal: plan.modal, baseModal: plan.baseModal, path: plan.path, writesInPlace: plan.writesInPlace,
    })
    appended = true
  }

  return {
    ok: true, fileId: id, versionId, bytes, appended,
    modal: plan.modal, baseModal: plan.baseModal, fallbackPath: plan.path,
    effectiveName: plan.effectiveName, writesInPlace: plan.writesInPlace, reason: plan.reason,
    size: measureSize(bytes, policyForPath(teamRoot, absPath)),
  }
}

// ---------------------------------------------------------------------------
// 占用 / 检出检入
// ---------------------------------------------------------------------------

/** 版本链的头版本（最后提交的那个版本）。 */
export function headVersionOf(teamRoot, fileId) {
  const vs = versionsOf(teamRoot, fileId).filter((x) => x.type === 'version')
  return vs.length ? vs[vs.length - 1] : null
}

/**
 * 检出/检入
 */
export function claimsOf(teamRoot, fileId) {
  return readJsonlDual(teamRoot, (q) => q.claimLog(fileId))
}

/**
 * 申请占用/检出。
 *
 * **默认关闭时一律不写**（批注 #3 的裁定）：未开启占用的目录里，调用方不该产生任何记录 ——
 * 这条被测试断言（默认下 claims 目录为空）。
 */
export function claimFile({ teamRoot, fileId, holder, deviceId = null, leaseMs = 30 * 60 * 1000, note = null, now = Date.now(), modal = MODAL.D, policy = null }) {
  const policyNow = policy || parseDirPolicy(null)
  if (!claimEnabled(modal, policyNow)) {
    return { ok: true, skipped: true, reason: 'claims-disabled', message: '该目录未开启占用（批注 #3：全局默认关闭）' }
  }
  const records = claimsOf(teamRoot, fileId)
  const cur = foldClaims(records, now)
  const log = teamPaths(teamRoot).claimLog(fileId)

  // 已被**他人**持有且未过期 ⇒ 拒绝（#9 的"某人正在编辑，你目前只读"）
  if (cur.state === 'held' && cur.holder !== holder) {
    return { ok: false, code: 'held-by-other', error: `已被 ${cur.holder} 检出，剩余 ${Math.ceil(cur.remainingMs / 1000)} 秒`, holder: cur.holder, remainingMs: cur.remainingMs }
  }
  // 记下**检出那一刻的版本**（检入时用它判断"我编辑期间有没有人提交过新版本" ⇒ 冲突检测的依据）
  const head = headVersionOf(teamRoot, fileId)
  const versionId = head ? head.versionId : null
  // 租约过期 ⇒ 允许接管，但**必须留痕**（否则"谁抢了谁的"无从追溯）
  if (cur.state === 'expired') {
    appendRecord(log, { type: 'takeover', from: cur.holder, to: holder, deviceId, at: now, leaseMs, reason: 'lease-expired', note, versionId })
    return { ok: true, takenOver: true, from: cur.holder, fileId, versionId }
  }
  // 自己已持有 ⇒ 视为续租（重复点"检出"不该报错，也不该产生第二条 claim）
  if (cur.state === 'held') {
    appendRecord(log, { type: 'heartbeat', holder, at: now, leaseMs })
    return { ok: true, renewed: true, fileId, versionId }
  }
  appendRecord(log, { type: 'claim', holder, deviceId, at: now, leaseMs, note, versionId })
  return { ok: true, claimed: true, fileId, leaseMs, versionId }
}

export function heartbeatClaim({ teamRoot, fileId, holder, leaseMs = 30 * 60 * 1000, now = Date.now() }) {
  const cur = foldClaims(claimsOf(teamRoot, fileId), now)
  if (cur.state === 'free') return { ok: false, code: 'not-checked-out' }
  if (cur.holder !== holder) return { ok: false, code: 'held-by-other', holder: cur.holder }
  appendRecord(teamPaths(teamRoot).claimLog(fileId), { type: 'heartbeat', holder, at: now, leaseMs })
  return { ok: true, expiresAt: now + leaseMs }
}

export function releaseClaim({ teamRoot, fileId, holder, now = Date.now() }) {
  const cur = foldClaims(claimsOf(teamRoot, fileId), now)
  if (cur.state === 'free') return { ok: true, alreadyFree: true }
  if (cur.holder !== holder) return { ok: false, code: 'held-by-other', holder: cur.holder }
  appendRecord(teamPaths(teamRoot).claimLog(fileId), { type: 'release', holder, at: now })
  return { ok: true, released: true }
}

/**
 * 检入：持有者提交新内容 ⇒ **生成新版本** + 释放占用（#9 的"检入"动作）。
 * 未检出者不得检入（否则等于绕过独占）。
 *
 * **检入是 S4 里唯一自然的"三方冲突入口"**：我检出后（base = 检出那一刻的版本），
 * 若期间有人提交了新版本（theirs），而我本地也改了（mine = 磁盘当前内容），那就是真正的
 * base/mine/theirs 三方情形。此处**拒绝检入并把三方版本 id 交给调用方**去走 §5.4 的四选一，
 * 绝不"默默以我的内容覆盖"——那正是 S1 花大力气防的静默丢失。
 * 注意 mine 的 id 由 `putBlob`（内容寻址、幂等）取得，**不追加版本**：此时我的内容尚未被接受，
 * 只进 CAS 供冲突处置读取，不算一次提交（"提交"必须由人来决定）。
 */
export function checkinFile({ teamRoot, fileId, holder, absPath, authorId = null, note = null, caps = {}, now = Date.now() }) {
  const cur = foldClaims(claimsOf(teamRoot, fileId), now)
  if (cur.state === 'free') return { ok: false, code: 'not-checked-out', error: '该文件当前未被检出，无法检入' }
  if (cur.holder !== holder) return { ok: false, code: 'held-by-other', error: `当前由 ${cur.holder} 检出，只有持有者可以检入`, holder: cur.holder }

  const head = headVersionOf(teamRoot, fileId)
  const baseVersionId = cur.record?.versionId || null
  const theirsVersionId = head ? head.versionId : null
  const theirsByOther = !!(head && head.authorId && authorId && head.authorId !== authorId)

  // 检出后被**他人**提交过新版本 ⇒ 冲突，交人工处置（不覆盖、不自动合并）
  if (theirByOtherGuard(baseVersionId, theirsVersionId, theirsByOther)) {
    let mineVersionId = null
    if (existsSync(absPath)) {
      const buf = readFileSync(absPath)
      mineVersionId = sha256Of(buf)
      if (sha256Of(buf) !== theirsVersionId) putBlob(teamRoot, buf)
    }
    return {
      ok: false, code: 'checkin-conflict',
      error: `你检出之后 ${head.authorId} 提交了新版本，为避免覆盖对方的改动，检入被拒绝；请先处置冲突`,
      baseVersionId, mineVersionId, theirsVersionId,
      theirsAuthorId: head.authorId, teamRootHint: null,
    }
  }

  const res = ingestFile({ teamRoot, absPath, authorId: authorId || holder, caps, note, now, fileId })
  if (!res.ok) return res
  appendRecord(teamPaths(teamRoot).claimLog(fileId), { type: 'release', holder, at: now, reason: 'checkin' })
  return { ok: true, fileId, versionId: res.versionId, appended: res.appended, released: true }
}

/** 三方皆在且头版本由他人提交 ⇒ 构成 base/mine/theirs 冲突。 */
function theirByOtherGuard(baseVersionId, theirsVersionId, theirsByOther) {
  return !!(baseVersionId && theirsVersionId && baseVersionId !== theirsVersionId && theirsByOther)
}

/**
 * 组合判定：该文件的当前可写性（供路由/UI 状态条使用）。
 * 返回 `{readonly, reason, holder, modal, policy}`。
 */
export function writabilityOf({ teamRoot, absPath, requesterId, now = Date.now(), caps = {} }) {
  const plan = planFallback(absPath, caps)
  const policy = policyForPath(teamRoot, absPath)
  const found = resolveFileId(teamRoot, absPath)
  const claims = found ? claimsOf(teamRoot, found.fileId) : []
  const cur = foldClaims(claims, now)

  // L-B/L-D：本来就不能原地写（与占用无关，这是格式能力决定的）
  if (!plan.writesInPlace) {
    const held = cur.state === 'held' && cur.holder !== requesterId
    return {
      readonly: true, reason: held ? 'held-by-other' : 'modal-not-writable',
      holder: held ? cur.holder : null, modal: plan.modal, policy, fileId: found ? found.fileId : null,
    }
  }
  if (claimEnabled(plan.modal, policy) && cur.state === 'held' && cur.holder !== requesterId) {
    return { readonly: true, reason: 'held-by-other', holder: cur.holder, remainingMs: cur.remainingMs, modal: plan.modal, policy, fileId: found ? found.fileId : null }
  }
  return { readonly: false, reason: cur.state, modal: plan.modal, policy, fileId: found ? found.fileId : null }
}

// ---------------------------------------------------------------------------
// S4-6：冲突处置（读三版本 → 四选一 → 产出落盘物）
// ---------------------------------------------------------------------------

/** 草稿目录名（S4 自有；**不改 S3 的布局常量**，避免两处定义互相踩）。 */
export const DRAFTS_DIR = 'drafts'

export function draftsDir(teamRoot) {
  return join(String(teamRoot), DRAFTS_DIR)
}

/**
 * 读某个版本的原始内容。缺版本 ⇒ 报错而**不静默以空内容继续** ——
 * 冲突处置里"拿空文件当对方版本"会直接导致用户数据被清空。
 */
export function readVersionBuffer(teamRoot, versionId) {
  if (!versionId) return { ok: false, code: 'version-required', error: '缺少 versionId' }
  const buf = readBlob(teamRoot, versionId)
  if (!buf) return { ok: false, code: 'version-missing', error: `团队源里找不到该版本内容：${versionId}` }
  // 内容寻址 ⇒ 顺手校验"取回的内容确实等于该 id"（防 CAS 文件损坏被当成正常版本）
  const actual = sha256Of(buf)
  if (actual !== versionId) {
    return { ok: false, code: 'version-corrupted', error: `版本内容与 id 不符（期望 ${versionId}，实际 ${actual}）` }
  }
  return { ok: true, buf, bytes: buf.length }
}

/**
 * 把"我的改动"另存为**草稿**（总设计 §5.4 定案）。
 *
 * 为什么落在团队源的 `drafts/` 而不是用户目录：定案 3 与 §5.7 明确不要"同目录多份近似文件"
 * —— 那会让"哪份是正本"永久模糊。放在团队源里、目录名直白叫 `drafts/`，语义清楚且不动用户文件。
 * 命名里带**版本哈希前 8 位**：同名文件的不同草稿互不覆盖（append-only 精神）。
 */
export function saveDraft({ teamRoot, fileId, logicalName, fromVersionId, buf, now = Date.now() }) {
  const dir = join(draftsDir(teamRoot), fileId)
  mkdirSync(dir, { recursive: true })
  const safe = String(logicalName || 'draft').replace(/[\\/:*?"<>|]/g, '_')
  const dest = join(dir, `${String(fromVersionId).slice(0, 8)}-${safe}`)
  writeVerifiedSync(dest, buf, { expectHash: sha256Of(buf) })
  appendRecord(teamPaths(teamRoot).versionLog(fileId), {
    type: 'draft', draftPath: dest, fromVersionId, at: now,
  })
  return dest
}

/**
 * 冲突处置编排：读三版本 → 按选择产出决策与落盘物。
 *
 * 返回的 `content` 是 Buffer（供调用方直接落盘/写草稿），**不要**直接塞进 JSON 响应；
 * HTTP 层只取 `action/source/draftPath/versionIds` 等可序列化字段。
 * `edit-merge` 分支不在本函数里做合并：合并是 S1 的 `shared/office-merge.mjs` 的职责，
 * 由上层按文件模态（docx 块 / xlsx 行）选择对应函数后调用，本函数只给出"该去合并"的决策。
 */
export function prepareConflictResolution({
  teamRoot, fileId, logicalName = null,
  baseVersionId, mineVersionId, theirsVersionId, choice, now = Date.now(),
}) {
  const b = readVersionBuffer(teamRoot, baseVersionId)
  const m = readVersionBuffer(teamRoot, mineVersionId)
  const t = readVersionBuffer(teamRoot, theirsVersionId)
  const bad = [b, m, t].find((x) => !x.ok)
  if (bad) return bad

  const decision = planConflict({ choice, base: b.buf, mine: m.buf, theirs: t.buf })
  if (!decision.ok) return decision

  const versionIds = { base: baseVersionId, mine: mineVersionId, theirs: theirsVersionId }

  if (decision.action === 'save-draft') {
    const draftPath = saveDraft({
      teamRoot, fileId, logicalName: logicalName || currentPathOf(teamRoot, fileId).logicalName,
      fromVersionId: mineVersionId, buf: m.buf, now,
    })
    return { ok: true, action: 'save-draft', source: 'mine', draftPath, versionIds, note: decision.note }
  }

  return {
    ok: true,
    action: decision.action,
    source: decision.source,
    content: decision.action === 'write' ? decision.content : null,
    versionIds,
    note: decision.note,
  }
}
