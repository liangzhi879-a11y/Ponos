// src/lib/teamApi.ts —— S3 团队协同的**桥面客户端**（渲染层唯一的团队数据入口，2026-09-17）
//
// 纪律（与 `mcpApi.ts` / `disabledApi.ts` 同范式，三条都踩过坑）：
//   ① **只调既有 6 个路由**，不自己造端点（路由表见下，`TEAM_ROUTES` 是单一真源，
//      并被 `teamApi.test.ts` 的源码级断言钉住"每个路径都真的存在于 server/bridge.mjs"）；
//   ② **永不抛**：桥没起 / 端口不通 / 非 2xx / 后端 ok:false 一律收敛成可展示文案 ——
//      渲染期抛异常会整页白屏，用户看不到任何原因；
//   ③ **失败不静默**：`reason` 是内核给的**机器可判**错误码（`kernel/team-store.mjs:joinTeam`
//      逐项区分 `ident-not-found` / `bad-code` / `expired` / `already-used` …），必须原样透传，
//      由 `teamOnboardingUi.JOIN_FAILURE` 映射成"错码 / 过期 / 已用过"三套不同文案。
//      在这里把 reason 吞成一句"加入失败"，就等于把内核刻意做出的区分抹掉。
//
// 服务端契约（`server/bridge.mjs` 的 `/team/*` 六段 handler，全部落在 D2 令牌闸门之后）：
//   GET  /team/status?teamId=     本机团队状态（成员表 + 完整性 + 同步盘警告 + 体积度量）
//   POST /team/create             { name, dir, identCode? }  → 建目录布局 + manifest + 本机登记
//   POST /team/join               { identCode, code, searchRoot? } → 解信封 → 加入
//   POST /team/invite             { teamId, ttlMs? } → 生成一次性验证码信封 + 转发文案
//   POST /team/revoke             { teamId, memberId }
//   POST /team/search-root        { searchRoot } → 记住"我放团队目录的地方"
import { resolveBridgeBase } from './bridgeBase.ts'

/** 六个端点的**唯一真源**。改这里之前先改 `server/bridge.mjs`（本文件不得自造端点）。 */
export const TEAM_ROUTES = Object.freeze({
  status: '/team/status',
  create: '/team/create',
  join: '/team/join',
  invite: '/team/invite',
  revoke: '/team/revoke',
  searchRoot: '/team/search-root',
})

/** 团队成员（`teamStatus` 的 `members[]` 条目）。 */
export interface TeamMemberView {
  memberId: string
  role: string
  status: string
  fingerprint?: string
}

/** 成员清单完整性（签名哈希链校验结果；`ok:false` ⇒ 界面必须告警，不能假装没事）。 */
export interface TeamIntegrity { ok: boolean; errors: unknown[] }

/** 一个已加入团队的状态快照（`GET /team/status` 的 `teams[]` 条目）。 */
export interface TeamSummary {
  teamId: string
  /** false = 团队源当前不可用（目录被删/没同步到），此时只有 teamId 与 reason */
  ok: boolean
  reason?: string
  name?: string
  dir?: string
  identCode?: string
  me?: { memberId: string; role: string; fingerprint?: string }
  memberCount: number
  members: TeamMemberView[]
  integrity: TeamIntegrity
  /** 已吸收的同步盘冲突副本数（§7.1 对策①） */
  copies: number
  warnings: string[]
  checkedAt?: string
}

export interface TeamStatusResult {
  ok: boolean
  deviceId: string
  searchRoot: string | null
  teams: TeamSummary[]
  /** 读取失败的原因（桥没起 / 后端异常）；`teams` 为空且此字段为空 = 真的没加入任何团队 */
  error?: string
}

export interface TeamCreateResult {
  ok: boolean
  teamId?: string
  name?: string
  identCode?: string
  dir?: string
  memberId?: string
  role?: string
  reason?: string
  error?: string
}

export interface TeamJoinResult {
  ok: boolean
  reason?: string
  error?: string
  teamId?: string
  name?: string
  dir?: string
  memberId?: string
  role?: string
  /** `ident-ambiguous` 时的候选目录（界面要列出来，否则用户不知道去哪手动选） */
  hits?: string[]
  alreadyMember?: boolean
}

export interface TeamInviteResult {
  ok: boolean
  reason?: string
  error?: string
  teamId?: string
  memberId?: string
  /** 6 位一次性验证码（**只在此刻可见**：团队源里存的是它的信封，不是它本身） */
  code?: string
  expiresAt?: string
  /** 信封在团队源里的相对路径（排障用） */
  envelope?: string
  /** 可直接转发给人的一段话（批注 #7：本轮只提供文本，二维码/系统分享不实现） */
  copyText?: string
}

export interface TeamRevokeResult { ok: boolean; memberId?: string; reason?: string; error?: string }

export interface TeamSearchRootResult { ok: boolean; searchRoot: string | null; reason?: string; error?: string }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** 统一的请求封装：把一切异常收敛成可展示文案，**永不抛出**。 */
async function requestJson(
  path: string,
  init: { method: string; body?: unknown },
  baseUrlInjected?: string,
): Promise<{ status: number; data: Record<string, unknown> | null; error?: string }> {
  try {
    const res = await fetch(`${resolveBridgeBase(baseUrlInjected)}${path}`, {
      method: init.method,
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    let data: Record<string, unknown> | null = null
    try { data = (await res.json()) as Record<string, unknown> } catch { data = null }
    if (!res.ok && !data) return { status: res.status, data, error: `请求失败（HTTP ${res.status}）` }
    // 桥的团队 handler 统一"4xx + {ok:false, reason}"：**不**在这里转成 error 文案，
    // 保留后端形状交给下面的归一化函数（reason 要给界面做区分）
    return { status: res.status, data }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { status: 0, data: null, error: `无法连接本地服务：${msg}` }
  }
}

/** 归一 `GET /team/status`：**不信任形状**（桥版本不匹配时字段可能缺失/类型不对）。 */
export function normalizeTeamStatus(raw: unknown): TeamStatusResult {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const teamsRaw = Array.isArray(d.teams) ? d.teams : []
  const teams: TeamSummary[] = []
  for (const t of teamsRaw) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    const teamId = str(o.teamId)
    if (!teamId) continue
    const membersRaw = Array.isArray(o.members) ? o.members : []
    const members: TeamMemberView[] = []
    for (const m of membersRaw) {
      if (!m || typeof m !== 'object') continue
      const mo = m as Record<string, unknown>
      const memberId = str(mo.memberId)
      if (!memberId) continue
      members.push({
        memberId,
        role: str(mo.role) ?? 'unknown',
        status: str(mo.status) ?? 'unknown',
        ...(str(mo.fingerprint) ? { fingerprint: str(mo.fingerprint) as string } : {}),
      })
    }
    const integ = (o.integrity && typeof o.integrity === 'object' ? o.integrity : {}) as Record<string, unknown>
    const me = (o.me && typeof o.me === 'object' ? o.me : null) as Record<string, unknown> | null
    teams.push({
      teamId,
      ok: o.ok === true,
      ...(str(o.reason) ? { reason: str(o.reason) as string } : {}),
      ...(str(o.name) ? { name: str(o.name) as string } : {}),
      ...(str(o.dir) ? { dir: str(o.dir) as string } : {}),
      ...(str(o.identCode) ? { identCode: str(o.identCode) as string } : {}),
      ...(me && str(me.memberId)
        ? { me: { memberId: str(me.memberId) as string, role: str(me.role) ?? 'unknown', ...(str(me.fingerprint) ? { fingerprint: str(me.fingerprint) as string } : {}) } }
        : {}),
      memberCount: num(o.memberCount),
      members,
      integrity: { ok: integ.ok !== false, errors: Array.isArray(integ.errors) ? integ.errors : [] },
      copies: num(o.copies),
      warnings: Array.isArray(o.warnings) ? o.warnings.map((w) => String(w)) : [],
      ...(str(o.checkedAt) ? { checkedAt: str(o.checkedAt) as string } : {}),
    })
  }
  return {
    ok: d.ok !== false,
    deviceId: str(d.deviceId) ?? '',
    searchRoot: str(d.searchRoot) ?? null,
    teams,
  }
}

/** 读本机团队状态。失败降级为"空列表 + error"，**不掩盖原因**（否则界面会把"读不到"画成"没加入团队"）。 */
export async function getTeamStatus(baseUrl?: string, teamId?: string | null): Promise<TeamStatusResult> {
  const q = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
  const r = await requestJson(`${TEAM_ROUTES.status}${q}`, { method: 'GET' }, baseUrl)
  if (r.error) return { ok: false, deviceId: '', searchRoot: null, teams: [], error: r.error }
  const out = normalizeTeamStatus(r.data)
  if (r.data?.ok === false) return { ...out, ok: false, error: str(r.data.error) ?? '读取团队状态失败' }
  return out
}

/** 统一的"后端 ok:false → 结果"收口：**原样透传 reason**（见文件头 ③）。 */
function failOf(data: Record<string, unknown> | null, error: string | undefined, fallbackReason: string) {
  return {
    ok: false,
    reason: str(data?.reason) ?? fallbackReason,
    ...(error ? { error } : {}),
  }
}

/** 创建团队（向导第 ③ 步调用）：目录布局 + `team.json` + 本机登记一次完成。 */
export async function createTeam(
  input: { name: string; dir: string; identCode?: string | null },
  baseUrl?: string,
): Promise<TeamCreateResult> {
  const body: Record<string, unknown> = { name: input.name, dir: input.dir }
  if (input.identCode) body.identCode = input.identCode
  const r = await requestJson(TEAM_ROUTES.create, { method: 'POST', body }, baseUrl)
  if (r.error) return { ok: false, reason: 'network', error: r.error }
  if (r.data?.ok !== true) return failOf(r.data, str(r.data?.error) ?? str(r.data?.message), 'create-failed')
  const d = r.data
  return {
    ok: true,
    teamId: str(d.teamId), name: str(d.name), identCode: str(d.identCode),
    dir: str(d.dir), memberId: str(d.memberId), role: str(d.role),
  }
}

/** 加入团队（两个数字）：`searchRoot` 只在"首次加入、还没设过搜索根"时由界面带上。 */
export async function joinTeam(
  input: { identCode: string; code: string; searchRoot?: string | null },
  baseUrl?: string,
): Promise<TeamJoinResult> {
  const body: Record<string, unknown> = { identCode: input.identCode, code: input.code }
  if (input.searchRoot) body.searchRoot = input.searchRoot
  const r = await requestJson(TEAM_ROUTES.join, { method: 'POST', body }, baseUrl)
  if (r.error) return { ok: false, reason: 'network', error: r.error }
  if (r.data?.ok !== true) {
    const hits = Array.isArray(r.data?.hits) ? (r.data?.hits as unknown[]).map((h) => String(h)) : undefined
    return { ...failOf(r.data, str(r.data?.error) ?? str(r.data?.message), 'join-failed'), ...(hits ? { hits } : {}) }
  }
  const d = r.data
  return {
    ok: true,
    teamId: str(d.teamId), name: str(d.name), dir: str(d.dir),
    memberId: str(d.memberId), role: str(d.role), alreadyMember: d.alreadyMember === true,
  }
}

/** 生成一次邀请（**团队密钥只在本机**，这里拿到的是"验证码 + 信封已写入团队源"）。 */
export async function inviteMember(
  input: { teamId: string; ttlMs?: number },
  baseUrl?: string,
): Promise<TeamInviteResult> {
  const body: Record<string, unknown> = { teamId: input.teamId }
  if (Number.isFinite(input.ttlMs)) body.ttlMs = input.ttlMs
  const r = await requestJson(TEAM_ROUTES.invite, { method: 'POST', body }, baseUrl)
  if (r.error) return { ok: false, reason: 'network', error: r.error }
  if (r.data?.ok !== true) return failOf(r.data, str(r.data?.error) ?? str(r.data?.message), 'invite-failed')
  const d = r.data
  return {
    ok: true,
    teamId: str(d.teamId), memberId: str(d.memberId), code: str(d.code),
    expiresAt: str(d.expiresAt), envelope: str(d.envelope), copyText: str(d.copyText),
  }
}

/** 移除成员（写入共享目录的签名记录；只有签名者本人的密钥可用 ⇒ 无法伪造他人的移除记录）。 */
export async function revokeTeamMember(
  input: { teamId: string; memberId: string },
  baseUrl?: string,
): Promise<TeamRevokeResult> {
  const r = await requestJson(TEAM_ROUTES.revoke, { method: 'POST', body: { ...input } }, baseUrl)
  if (r.error) return { ok: false, reason: 'network', error: r.error }
  if (r.data?.ok !== true) return failOf(r.data, str(r.data?.error) ?? str(r.data?.message), 'revoke-failed')
  return { ok: true, memberId: str(r.data.memberId) }
}

/** 记住"我放团队目录的地方"（一次设置、长期复用 —— "两个数字加入"的前提）。 */
export async function setTeamSearchRoot(searchRoot: string, baseUrl?: string): Promise<TeamSearchRootResult> {
  const r = await requestJson(TEAM_ROUTES.searchRoot, { method: 'POST', body: { searchRoot } }, baseUrl)
  if (r.error) return { ok: false, searchRoot: null, reason: 'network', error: r.error }
  if (r.data?.ok !== true) {
    return { searchRoot: null, ...failOf(r.data, str(r.data?.error), 'set-search-root-failed') }
  }
  return { ok: true, searchRoot: str(r.data.searchRoot) ?? null }
}
