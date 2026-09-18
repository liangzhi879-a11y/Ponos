// 团队协作路由：标签合并 / 团队源 / 文件协同（P1 · 从 server/bridge.mjs 抽出）
// ---------------------------------------------------------------------------
// 约定同 `server/logs-routes.mjs` / `files-routes.mjs` / `office-routes.mjs`：
//   返回 `{ status, body }` 表示已算出响应；返回 `null` 表示不是本模块负责的路径。
//
// 为什么这三组端点归一个模块：它们同属"协作"域，且**在原文件里本就是连续区间**
// （`/tags…` → `/team/*` → `/file-collab/…`），共享 `configDir` 与团队解析逻辑。
// 更重要的一致性是安全上的：三者都必须落在 **D2 令牌闸门之后**（放闸门之前 = 未鉴权暴露）。
// 由 `server/tag-routes.test.mjs` / `server/team-routes.test.mjs` 的端到端起桥测试守住
// （断言无 token 一律 401，且未授权 POST **不得产生写入**）。
//
// 异常策略（**刻意与原实现不同**，见下）：`/tags…` 与 `/team/*` 的 handler 各自 try/catch 并
// 如实回报 reason（团队是可选能力，它出问题不该让桥 500）；`/file-collab/…` 则**不**捕获，
// 让异常向上抛给调用方的统一错误出口。迁移时逐条保留了这个差异。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tagRegistrySnapshot, mergeTagsInStore, undoMergeInStore } from '../kernel/tag-store.mjs'
import { teamStatus, createTeam, joinTeam, exportInvite, revokeMember, setSearchRoot } from '../kernel/team-store.mjs'
import {
  ingestFile, versionsOf, claimsOf, claimFile, checkinFile, releaseClaim, heartbeatClaim,
  resolveFileId, writabilityOf, policyForPath, readPolicies, writePolicies, ensureCollabDirs,
  prepareConflictResolution, currentPathOf, readVersionBuffer,
} from '../kernel/file-collab.mjs'
import { planFallback } from '../shared/file-modal.mjs'
import { executeOfficeMerge } from './office-merge-exec.mjs'
import { DEFAULT_TAG_SCOPE } from '../shared/tag-registry.mjs'

/** 本模块负责的固定路径（`/file-collab/…` 走前缀匹配，见 isCollabPath） */
const FIXED_PATHS = new Set([
  '/tags', '/tags/merge', '/tags/undo',
  '/team/status', '/team/create', '/team/invite', '/team/join', '/team/revoke', '/team/search-root',
])

/** 是否由本模块处理（含 `/file-collab/` 前缀；未知子路径交由模块内报 404） */
export function isCollabPath(pathname) {
  return FIXED_PATHS.has(pathname) || pathname.startsWith('/file-collab/')
}

const json = (status, body) => ({ status, body })

/**
 * 【S4】三层兜底的"能力探测"结果**惰性缓存**：
 * 探测要起一次 python 进程（约百毫秒），逐请求探查会明显拖慢协同操作，
 * 而结果在进程生命周期内恒定，故探一次即可。
 * 探测失败（无 python / 无该模块）⇒ 对应能力为"不可用"，如实反映到分层结果（不假装能转）。
 */
let capsCache = null

function probeCaps(findPythonExe) {
  if (capsCache) return capsCache
  const py = findPythonExe()
  const probe = 'import json,importlib\nout={}\nfor m in ("xlrd","openpyxl","win32com","PIL"):\n    try:\n        importlib.import_module(m); out[m]=True\n    except Exception:\n        out[m]=False\nprint(json.dumps(out))'
  let mods = {}
  try {
    const r = spawnSync(py, ['-c', probe], { encoding: 'utf-8', timeout: 20000 })
    mods = JSON.parse(String(r.stdout || '{}').trim() || '{}')
  } catch { mods = {} }
  // convert 能力逐格式报告：`.xls` 需 xlrd+openpyxl（可写出 .xlsx）；`.doc` 需 win32com（Word COM）
  const convert = []
  if (mods.xlrd && mods.openpyxl) convert.push('.xls')
  if (mods.win32com) convert.push('.doc')
  capsCache = { convert, extract: true, modules: mods }
  return capsCache
}

/**
 * 处理协作类路径。
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.pathname
 * @param {URLSearchParams} p.searchParams
 * @param {object|null} p.body         已解析的 JSON body（仅 POST 需要，由调用方容错解析）
 * @param {string} p.sep               平台路径分隔符
 * @param {string} p.configDir         YFW_HOME
 * @param {Function} p.findPythonExe
 * @param {object}  [p.office]         office 读写出口（`createOfficeAccess()`），供 `edit-merge` 真正执行三路合并；
 *                                     缺省时该选项退回"只回报动作"（与接线前行为一致，便于单独测试本模块）
 * @returns {Promise<{status:number,body:any}|null>}
 */
export async function handleCollabRoute({ method, pathname, searchParams, body, sep, configDir, findPythonExe, office }) {
  if (!isCollabPath(pathname)) return null

  // ═══ /tags*：标签注册表（可观测 + 自动合并 + 可撤销）═══════════════════
  if (pathname === '/tags' && method === 'GET') {
    const scope = searchParams.get('scope') || DEFAULT_TAG_SCOPE
    try {
      return json(200, tagRegistrySnapshot(configDir, { scope }))
    } catch (e) {
      return json(400, { ok: false, reason: 'invalid-scope', message: String((e && e.message) || e) })
    }
  }
  if (pathname === '/tags/merge' && method === 'POST') {
    let r
    try {
      r = mergeTagsInStore(configDir, body && body.from, body && body.into, { scope: (body && body.scope) || DEFAULT_TAG_SCOPE })
    } catch (e) {
      // tag-store 写侧是**严格**模式：注册表损坏时拒绝写（不把损坏内容覆盖成空表），此处如实回报。
      r = { ok: false, reason: 'registry-unreadable', message: String((e && e.message) || e) }
    }
    return json(r && r.ok ? 200 : 400, r)
  }
  if (pathname === '/tags/undo' && method === 'POST') {
    let r
    try {
      r = undoMergeInStore(configDir, body && body.mergeId)
    } catch (e) {
      r = { ok: false, reason: 'registry-unreadable', message: String((e && e.message) || e) }
    }
    return json(r && r.ok ? 200 : 400, r)
  }

  // ═══ /team/*：团队源（创建/邀请/加入/撤销/状态/搜索根）═══════════════════
  // 每个 handler 都**不允许异常逃逸**：团队是可选能力，它出问题不该让桥 500 或崩掉；
  // 统一捕获并如实回报 reason，供前端给出可操作提示（而不是笼统"未知错误"）。
  if (pathname === '/team/status' && method === 'GET') {
    try {
      return json(200, teamStatus({ configDir, teamId: searchParams.get('teamId') || null }))
    } catch (e) {
      return json(400, { ok: false, reason: 'status-failed', message: String((e && e.message) || e) })
    }
  }
  if (pathname === '/team/create' && method === 'POST') {
    let r
    try {
      r = createTeam({
        configDir,
        name: body && body.name,
        dir: body && body.dir,
        identCode: body && body.identCode ? String(body.identCode) : null,
      })
    } catch (e) {
      r = { ok: false, reason: 'create-failed', message: String((e && e.message) || e) }
    }
    return json(r && r.ok ? 200 : 400, r)
  }
  if (pathname === '/team/invite' && method === 'POST') {
    let r
    try {
      r = exportInvite({
        configDir,
        teamId: body && body.teamId,
        ttlMs: body && body.ttlMs ? Number(body.ttlMs) : undefined,
      })
    } catch (e) {
      r = { ok: false, reason: 'invite-failed', message: String((e && e.message) || e) }
    }
    return json(r && r.ok ? 200 : 400, r)
  }
  if (pathname === '/team/join' && method === 'POST') {
    let r
    try {
      r = joinTeam({
        configDir,
        identCode: body && body.identCode,
        code: body && body.code,
        searchRoot: body && body.searchRoot ? String(body.searchRoot) : null,
      })
    } catch (e) {
      r = { ok: false, reason: 'join-failed', message: String((e && e.message) || e) }
    }
    return json(r && r.ok ? 200 : 400, r)
  }
  if (pathname === '/team/revoke' && method === 'POST') {
    let r
    try {
      r = revokeMember({ configDir, teamId: body && body.teamId, memberId: body && body.memberId })
    } catch (e) {
      r = { ok: false, reason: 'revoke-failed', message: String((e && e.message) || e) }
    }
    return json(r && r.ok ? 200 : 400, r)
  }
  if (pathname === '/team/search-root' && method === 'POST') {
    let r
    try {
      r = setSearchRoot(configDir, body && body.searchRoot)
    } catch (e) {
      r = { ok: false, reason: 'set-search-root-failed', message: String((e && e.message) || e) }
    }
    return json(r && r.ok ? 200 : 400, r)
  }

  // ═══ /file-collab/…：文件协同（版本链 / 软占用 / 检出检入 / 冲突处置 / 目录策略）═══
  // 注意：以下 handler **不**自行 try/catch（保持原实现：异常交由调用方的统一错误出口）。
  if (pathname.startsWith('/file-collab/')) {
    const s4TeamRoot = (teamId) => {
      const st = teamStatus({ configDir })
      const teams = (st && st.teams) || []
      const ok = teams.filter((t) => t && t.ok && t.dir)
      if (ok.length === 0) return { ok: false, reason: 'no-team', teams: teams.map((t) => ({ teamId: t.teamId, ok: t.ok })) }
      const hit = teamId ? ok.find((t) => t.teamId === teamId) : ok[0]
      if (!hit) return { ok: false, reason: 'team-not-found', teamId, teams: ok.map((t) => t.teamId) }
      return { ok: true, teamRoot: hit.dir, teamId: hit.teamId, deviceId: st.deviceId || null }
    }
    const s4Caps = () => probeCaps(findPythonExe)
    const s4Reject = (r, okStatus = 200) => {
      const status = r && r.ok ? okStatus : ({
        'file-missing': 404,
        // 未知端点：调用点写的是 `s4Reject({code:'unknown-endpoint'}, 404)`，但第二个参数是
        // **ok 时**的状态码，不 ok 时状态只由这张表决定 —— 漏登记就会被兜底成 400（表意错误：
        // 路径不存在是 404）。补上，让"未知端点"如实回报 404。
        'unknown-endpoint': 404,
        'held-by-other': 409,
        'not-checked-out': 409,
        'blocked-by-other': 409,
        'placeholder-file': 409,
      }[(r && r.code) || ''] || 400)
      return json(status, r)
    }

    // 团队源概况（供 UI 判断"能否协同"）
    if (pathname === '/file-collab/status' && method === 'GET') {
      const st = s4TeamRoot(searchParams.get('teamId'))
      if (!st.ok) return s4Reject(st)
      const absPath = (searchParams.get('path') || '').replace(/\//g, sep)
      const requesterId = searchParams.get('memberId') || null
      if (!absPath || !existsSync(absPath)) return s4Reject({ ok: false, code: 'file-missing', error: `文件不存在：${absPath}` })
      const resolved = resolveFileId(st.teamRoot, absPath)
      const w = writabilityOf({ teamRoot: st.teamRoot, absPath, requesterId, caps: s4Caps() })
      return s4Reject({
        ok: true, teamId: st.teamId, deviceId: st.deviceId, path: absPath, fileId: resolved ? resolved.fileId : null,
        ingested: !!resolved, modal: w.modal, readonly: w.readonly, reason: w.reason,
        holder: w.holder || null, remainingMs: w.remainingMs ?? null,
        policy: w.policy, caps: s4Caps(),
      })
    }

    // 纳管（首次分配 fileId 并入 CAS；L-B/L-D 不产生原地写）
    if (pathname === '/file-collab/ingest' && method === 'POST') {
      const st = s4TeamRoot(body && body.teamId)
      if (!st.ok) return s4Reject(st)
      const absPath = String((body && body.path) || '').replace(/\//g, sep)
      if (!absPath) return s4Reject({ ok: false, code: 'path-required', error: '缺少 path' })
      ensureCollabDirs(st.teamRoot)
      const r = ingestFile({ teamRoot: st.teamRoot, absPath, authorId: (body && body.memberId) || null, caps: s4Caps(), note: (body && body.note) || null })
      return s4Reject({ ...r, teamId: st.teamId })
    }

    // 版本链
    if (pathname === '/file-collab/versions' && method === 'GET') {
      const st = s4TeamRoot(searchParams.get('teamId'))
      if (!st.ok) return s4Reject(st)
      const fileId = searchParams.get('fileId')
      const absPath = (searchParams.get('path') || '').replace(/\//g, sep)
      const resolved = fileId ? { fileId } : (absPath ? resolveFileId(st.teamRoot, absPath) : null)
      if (!resolved) return s4Reject({ ok: false, code: 'file-not-ingested', error: '该文件尚未纳入团队源（无版本链）' })
      const recs = versionsOf(st.teamRoot, resolved.fileId)
      const cur = currentPathOf(st.teamRoot, resolved.fileId)
      return s4Reject({
        ok: true, teamId: st.teamId, fileId: resolved.fileId, currentPath: cur.path, logicalName: cur.logicalName,
        versions: recs.filter((x) => x.type === 'version'),
        history: recs,
      })
    }

    // 占用/检出状态
    if (pathname === '/file-collab/claims' && method === 'GET') {
      const st = s4TeamRoot(searchParams.get('teamId'))
      if (!st.ok) return s4Reject(st)
      const fileId = searchParams.get('fileId')
      if (!fileId) return s4Reject({ ok: false, code: 'fileId-required', error: '缺少 fileId' })
      return s4Reject({ ok: true, teamId: st.teamId, fileId, records: claimsOf(st.teamRoot, fileId) })
    }

    // 检出 / 续租 / 释放 / 检入（#9 的显式动作）
    if (pathname === '/file-collab/claim' && method === 'POST') {
      const st = s4TeamRoot(body && body.teamId)
      if (!st.ok) return s4Reject(st)
      const absPath = String((body && body.path) || '').replace(/\//g, sep)
      const holder = (body && body.memberId) || null
      if (!absPath || !holder) return s4Reject({ ok: false, code: 'bad-request', error: '需要 path 与 memberId' })
      if (!existsSync(absPath)) return s4Reject({ ok: false, code: 'file-missing', error: `文件不存在：${absPath}` })
      const resolved = resolveFileId(st.teamRoot, absPath)
      if (!resolved) return s4Reject({ ok: false, code: 'file-not-ingested', error: '请先纳管该文件（无版本链时无法建立占用）' })
      const plan = planFallback(absPath, s4Caps())
      const r = claimFile({
        teamRoot: st.teamRoot, fileId: resolved.fileId, holder, deviceId: (body && body.deviceId) || null,
        leaseMs: (body && body.leaseMs) || undefined, note: (body && body.note) || null,
        modal: plan.modal, policy: policyForPath(st.teamRoot, absPath),
      })
      return s4Reject({ ...r, fileId: resolved.fileId, modal: plan.modal })
    }
    if (pathname === '/file-collab/heartbeat' && method === 'POST') {
      const st = s4TeamRoot(body && body.teamId)
      if (!st.ok) return s4Reject(st)
      if (!body || !body.fileId || !body.memberId) return s4Reject({ ok: false, code: 'bad-request', error: '需要 fileId 与 memberId' })
      return s4Reject(heartbeatClaim({ teamRoot: st.teamRoot, fileId: body.fileId, holder: body.memberId, leaseMs: body.leaseMs || undefined }))
    }
    if (pathname === '/file-collab/release' && method === 'POST') {
      const st = s4TeamRoot(body && body.teamId)
      if (!st.ok) return s4Reject(st)
      if (!body || !body.fileId || !body.memberId) return s4Reject({ ok: false, code: 'bad-request', error: '需要 fileId 与 memberId' })
      return s4Reject(releaseClaim({ teamRoot: st.teamRoot, fileId: body.fileId, holder: body.memberId }))
    }
    if (pathname === '/file-collab/checkin' && method === 'POST') {
      const st = s4TeamRoot(body && body.teamId)
      if (!st.ok) return s4Reject(st)
      const absPath = String((body && body.path) || '').replace(/\//g, sep)
      if (!body || !body.fileId || !body.memberId || !absPath) return s4Reject({ ok: false, code: 'bad-request', error: '需要 fileId、memberId 与 path' })
      if (!existsSync(absPath)) return s4Reject({ ok: false, code: 'file-missing', error: `文件不存在：${absPath}` })
      const r = checkinFile({
        teamRoot: st.teamRoot, fileId: body.fileId, holder: body.memberId, absPath,
        authorId: body.memberId, note: body.note || null, caps: s4Caps(),
      })
      return s4Reject(r)
    }

    // 冲突处置（四选一；save-copy 降级为草稿）
    if (pathname === '/file-collab/conflict' && method === 'POST') {
      const st = s4TeamRoot(body && body.teamId)
      if (!st.ok) return s4Reject(st)
      if (!body || !body.fileId || !body.choice) return s4Reject({ ok: false, code: 'bad-request', error: '需要 fileId 与 choice' })
      const r = prepareConflictResolution({
        teamRoot: st.teamRoot, fileId: body.fileId, logicalName: body.logicalName || null,
        baseVersionId: body.baseVersionId || null, mineVersionId: body.mineVersionId || null,
        theirsVersionId: body.theirsVersionId || null, choice: body.choice,
      })
      // Buffer 不进 JSON：只回报可序列化字段（内容落盘由调用方按 action 决定）
      if (r && r.ok) {
        const { content, ...rest } = r
        // `edit-merge`：「进入编辑器逐处合并」这一选项过去只会回报一个动作名就结束——
        // 前端于是提示"已交给三路合并"，而实际**既没合并也没落盘**（bytes: 0 就是那个空操作）。
        // 这里把 kernel/file-collab.mjs 注释里写的"由上层按文件模态选择函数后调用"补齐：
        // 读 base/mine（版本库）+ theirs（磁盘当前）→ 合并 → 落盘（带 baseVersion 乐观锁）。
        // 冲突时**不写盘**，把冲突明细原样回报，由前端逐处让人决定。
        if (r.action === 'merge-then-write' && office) {
          const cur = currentPathOf(st.teamRoot, body.fileId)
          const merge = await executeOfficeMerge({
            teamRoot: st.teamRoot,
            versionIds: r.versionIds,
            logicalName: (cur && cur.logicalName) || body.logicalName || null,
            targetPath: cur && cur.path,
            office,
            readVersionBuffer,
          })
          return s4Reject({ ...rest, ok: !!merge.ok, merge })
        }
        return s4Reject({ ...rest, bytes: content ? content.length : 0 })
      }
      return s4Reject(r)
    }

    // 目录策略（批注 #3：全局默认关闭 + 按目录开启）
    if (pathname === '/file-collab/policies' && method === 'GET') {
      const st = s4TeamRoot(searchParams.get('teamId'))
      if (!st.ok) return s4Reject(st)
      const policies = readPolicies(st.teamRoot)
      const relPath = searchParams.get('path')
      return s4Reject({
        ok: true, teamId: st.teamId, policies,
        effective: relPath ? policyForPath(st.teamRoot, relPath.replace(/\//g, sep)) : null,
      })
    }
    if (pathname === '/file-collab/policies' && method === 'POST') {
      const st = s4TeamRoot(body && body.teamId)
      if (!st.ok) return s4Reject(st)
      const dirs = (body && body.dirs) || null
      if (!dirs || typeof dirs !== 'object') return s4Reject({ ok: false, code: 'bad-request', error: '需要 dirs 对象（{ "<目录>": { softClaim, occupancy, maxFileBytes } }）' })
      ensureCollabDirs(st.teamRoot)
      writePolicies(st.teamRoot, { dirs })
      return s4Reject({ ok: true, teamId: st.teamId, policies: readPolicies(st.teamRoot) })
    }

    return s4Reject({ ok: false, code: 'unknown-endpoint', error: `未知的 file-collab 端点：${pathname}` }, 404)
  }

  return null
}
