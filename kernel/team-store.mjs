// kernel/team-store.mjs —— S3 团队源的**本机侧编排**（配置、创建、邀请、加入、撤销、校验）。
//
// 分工（沿用 S2-D6 的 `shared/tag-registry.mjs` + `kernel/tag-store.mjs` 同款切分）：
//   shared/team-crypto.mjs   = 码/密钥/信封（规则，零 IO）
//   shared/team-members.mjs  = 签名哈希链（规则，零 IO）
//   shared/team-source.mjs   = L1 共享目录 + 同步盘四行为对策（IO）
//   kernel/team-store.mjs    = **本文件**：把上面三块编排成"创建/邀请/加入/撤销/校验"这套动作
//
// 【什么存在本机、什么存在共享目录（§5.9 的真实边界）】
//   本机（`<configDir>/team/config.json`，权限 0600）：本机身份密钥对、**团队密钥**、已加入的团队列表。
//   共享目录（团队源）：`team.json`（**明文**：teamId/识别码/salt/scrypt 参数，**不含任何密钥**）、
//     `members/log-<deviceId>.jsonl`（签名链）、`keys/<memberId>.env`（团队密钥的验证码信封）。
//   这样切分的意义：**共享目录永远不出现可直接使用的密钥材料**；而"能读共享目录的人"本来就被
//   网盘 ACL 授权了（§5.9：真实边界始终是 ACL，"邀请"没有强制力）。
//
// 【一次性验证码的落点】用后即焚记在**共享目录的成员日志**里（`op:'revoke', scope:'invite'`），
// 而不是只记本机：否则换一台机器、或从备份恢复本机配置后，同一验证码就能再用一次 —— 那等于没有
// 一次性。记录进日志同时也让它**可被成员链校验**（改动会被发现）。

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../shared/atomic-write.mjs'
import {
  generateIdentCode, generateTeamId, generateTeamKey, generateMemberId, generateDeviceId,
  generateMemberKeyPair, generateVerifyCode, fingerprint, sealTeamKeyEnvelope, openTeamKeyEnvelope,
  normalizeCode, VERIFY_CODE_LEN, IDENT_CODE_LEN, ENVELOPE_TTL_MS,
} from '../shared/team-crypto.mjs'
import {
  appendMemberOp, addMemberOp, revokeMemberOp, verifyMemberChain, replayMembers, consumedInvites,
  mergeMemberLogCopies, pubKeyResolver, canonicalJson,
} from '../shared/team-members.mjs'
import {
  openTeamSource, scanTeamDirs, ensureTeamDirs, detectPlaceholderSync, TEAM_LAYOUT, DEFAULT_SCAN_DEPTH,
} from '../shared/team-source.mjs'

export const TEAM_CONFIG_VERSION = 1

/** 本机团队配置路径。 */
export function teamConfigPath(configDir) {
  return join(String(configDir || '.'), 'team', 'config.json')
}

/** 本机团队目录（私钥与团队密钥都在此，须为 0600）。 */
export function teamConfigDir(configDir) {
  return join(String(configDir || '.'), 'team')
}

/** 空配置（首次使用：生成设备 id 与身份密钥对）。 */
export function createTeamConfig(now = new Date().toISOString()) {
  const kp = generateMemberKeyPair()
  return {
    version: TEAM_CONFIG_VERSION,
    deviceId: generateDeviceId(),
    identity: { publicKey: kp.publicKey, privateKey: kp.privateKey, fingerprint: fingerprint(kp.publicKey) },
    searchRoot: null,
    teams: {},
    updatedAt: now,
  }
}

/**
 * 读本机配置（缺文件 → 新建的空配置，**不是错误**）。
 * 结构损坏时**降级为空配置**（与 `tag-store` 的读侧一致：一个可选能力的配置坏掉，不该让主链路起不来）。
 */
export function loadTeamConfig(configDir, { strict = false } = {}) {
  const p = teamConfigPath(configDir)
  if (!existsSync(p)) return createTeamConfig()
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(p, 'utf-8'))
  } catch (e) {
    if (strict) throw new Error(`本机团队配置已损坏，拒绝覆盖：${p}（${(e && e.message) || e}）`)
    return createTeamConfig()
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.identity || !parsed.teams) {
    if (strict) throw new Error(`本机团队配置结构非法，拒绝覆盖：${p}`)
    return createTeamConfig()
  }
  if (!parsed.version) parsed.version = TEAM_CONFIG_VERSION
  if (!Array.isArray(parsed.teams) && typeof parsed.teams === 'object') { /* map 形态，保持 */ }
  return parsed
}

/**
 * 写本机配置（原子写 + **0600**）。
 * 权限必须收紧：文件里有本机私钥与团队密钥；默认 umask 下可能是 0644，同机其他用户可读。
 */
export function saveTeamConfig(configDir, cfg) {
  const p = teamConfigPath(configDir)
  cfg.updatedAt = new Date().toISOString()
  const bytes = writeFileAtomicSync(p, JSON.stringify(cfg, null, 2) + '\n')
  try { chmodSync(p, 0o600) } catch { /* 非 POSIX 文件系统（如某些网络盘）可能不支持，忽略 */ }
  return bytes
}

/** 取某团队的本机登记项（含团队密钥与我的成员 id）。 */
export function getLocalTeam(configDir, teamId) {
  const cfg = loadTeamConfig(configDir)
  return cfg.teams[String(teamId)] || null
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

/**
 * 创建团队：建目录布局 → 写 `team.json`（**只含公开信息**）→ 追加"我加入"的记录 → 存本机配置。
 *
 * `team.json` 里放 `salt` 与 `scrypt` 参数（§5.9）：**盐不是秘密**，解密方需要它派生同一密钥；
 * 而 `teamKey` 只进本机配置与信封，**永不写 `team.json`**（回归网对此有专门断言）。
 */
export function createTeam({ configDir, name, dir, now = Date.now(), identCode = null } = {}) {
  if (!dir) return { ok: false, reason: 'dir-required', message: '必须指定团队源目录' }
  const cfg = loadTeamConfig(configDir)
  const src = openTeamSource({ root: dir })
  src.ensure()

  const teamId = generateTeamId()
  const code = identCode && normalizeCode(identCode, IDENT_CODE_LEN) ? String(identCode) : generateIdentCode()
  const teamKey = generateTeamKey()
  const salt = randomBytes(16).toString('base64')
  const iso = new Date(now).toISOString()

  const manifest = {
    v: TEAM_LAYOUT.MANIFEST_VERSION,
    teamId,
    name: String(name || '团队'),
    identCode: code,
    salt,
    scrypt: { N: 2 ** 15, r: 8, p: 1, keylen: 32 },
    createdAt: iso,
    createdBy: cfg.identity.fingerprint,
  }
  src.writeManifest(manifest)

  // 我作为 owner：追加第一条 add（自己的公钥入册）
  const memberId = `u_${cfg.identity.fingerprint.replace(/-/g, '').slice(0, 8)}`
  let records = []
  records.push(addMemberOp(records, {
    memberId, role: 'owner', publicKey: cfg.identity.publicKey,
    by: cfg.identity.fingerprint, privateKey: cfg.identity.privateKey, ts: now,
  }))
  src.writeLog(cfg.deviceId, records.map((r) => JSON.stringify(r)).join('\n') + '\n')

  cfg.teams[teamId] = {
    teamId, name: manifest.name, dir: String(dir), identCode: code, memberId, role: 'owner',
    teamKey: teamKey.toString('base64'), joinedAt: iso, deviceId: cfg.deviceId,
  }
  saveTeamConfig(configDir, cfg)
  return { ok: true, teamId, name: manifest.name, identCode: code, dir: String(dir), memberId, role: 'owner', manifest }
}

// ---------------------------------------------------------------------------
// 邀请（生成一次性验证码信封）
// ---------------------------------------------------------------------------

/**
 * 生成一个"成员槽"：分配 `memberId` + 6 位验证码 + 写 `keys/<memberId>.env`（团队密钥封装）。
 *
 * 返回 `{ memberId, code, expiresAt, copyText }`：
 * - `copyText` 是**给人转发的一段话**（批注 #7 未定 ⇒ 本轮只提供文本；二维码/系统分享不实现）。
 * - 文案**不暗示"加密所以安全"**：§11 措辞约束，且事实如此（真实边界是 ACL）。
 */
export function exportInvite({ configDir, teamId, now = Date.now(), ttlMs = ENVELOPE_TTL_MS, memberId = null } = {}) {
  const cfg = loadTeamConfig(configDir, { strict: false })
  const local = cfg.teams[String(teamId)]
  if (!local) return { ok: false, reason: 'not-a-member', message: '本机没有加入该团队，无法邀请' }
  if (!local.teamKey) return { ok: false, reason: 'no-team-key', message: '本机缺少团队密钥（可能只是加入了成员列表），无法邀请' }
  const src = openTeamSource({ root: local.dir })
  if (!existsSync(src.paths.manifest)) return { ok: false, reason: 'team-dir-missing', message: `团队源目录不可用：${local.dir}` }

  const newMemberId = memberId ? String(memberId) : generateMemberId()
  const code = generateVerifyCode()
  const envText = sealTeamKeyEnvelope({ teamKey: Buffer.from(local.teamKey, 'base64'), code, memberId: newMemberId, teamId: String(teamId), ttlMs, now })
  src.writeKeyEnvelope(newMemberId, envText)
  const expiresAt = new Date(now + ttlMs).toISOString()
  return {
    ok: true,
    teamId: String(teamId),
    memberId: newMemberId,
    code,
    expiresAt,
    envelope: src.rel(src.paths.keyEnvelope(newMemberId)),
    // 转发文案：包含识别码（公开）与验证码（私下给）；措辞遵守 §11（不承诺访问控制）
    copyText: `加入团队「${local.name}」：识别码 ${local.identCode}，验证码 ${code}（${expiresAt.slice(0, 10)} 前有效，只能用一次）。`,
  }
}

// ---------------------------------------------------------------------------
// 加入
// ---------------------------------------------------------------------------

/** 读一个团队源的全部成员日志（**所有设备、所有冲突副本**），返回 {records, chains, copies}。 */
export function readAllMemberLogs(src) {
  const chains = []
  const records = []
  const copies = []
  for (const logical of src.listLogNames()) {
    const r = src.readLogCopies(logical.replace(/^log-/, '').replace(/\.jsonl$/, ''))
    if (!r.copies.length) continue
    copies.push(...r.copies)
    const parsed = []
    for (const rec of r.records) {
      try { parsed.push(JSON.parse(rec)) } catch { /* 坏行：跳过，链校验会体现出来 */ }
    }
    chains.push({ logical, records: parsed, skipped: r.skipped })
    records.push(...parsed)
  }
  return { records, chains, copies }
}

/**
 * 校验一个团队源的成员清单完整性：逐条链验签 + 多副本合并。
 * 返回 `{ members, chainResults, integrity:{ok, errors}, copies }`。
 */
export function verifyTeamSource(src) {
  const { records, chains, copies } = readAllMemberLogs(src)
  const merged = mergeMemberLogCopies(chains.map((c) => ({ name: c.logical, records: c.records })))
  const members = replayMembers(merged)
  const resolve = pubKeyResolver(members)
  const chainResults = chains.map((c) => ({ logical: c.logical, ...verifyMemberChain(c.records, { resolvePubKey: resolve }) }))
  // 先按成员表解析公钥；成员表本身来自重放，因此对"同一份日志自证"是封闭的
  const errors = []
  for (const cr of chainResults) for (const e of cr.errors) errors.push({ logical: cr.logical, ...e })
  return { members, chainResults, integrity: { ok: errors.length === 0, errors }, copies, merged }
}

/**
 * 加入团队：扫描搜索根 → 找 `team.json` 内容匹配识别码 → 逐个信封试验证码 → 成功后
 * ① 追加"我加入"的签名记录；② 追加"邀请信封已作废"记录（一次性）；③ 存本机配置。
 *
 * 失败原因逐项区分（不笼统报"加入失败"）：`ident-not-found`、`ident-ambiguous`（多个团队同码）、
 * `no-envelope`、`bad-code`、`expired`、`already-used`（一次性）、`search-root-missing`。
 */
export function joinTeam({ configDir, identCode, code, searchRoot = null, now = Date.now() } = {}) {
  const ident = normalizeCode(identCode, IDENT_CODE_LEN)
  if (!ident) return { ok: false, reason: 'bad-ident-format', message: `识别码应为 ${IDENT_CODE_LEN} 位数字` }
  const vcode = normalizeCode(code, VERIFY_CODE_LEN)
  if (!vcode) return { ok: false, reason: 'bad-code-format', message: `验证码应为 ${VERIFY_CODE_LEN} 位数字` }

  const cfg = loadTeamConfig(configDir)
  const root = searchRoot || cfg.searchRoot
  if (!root || !existsSync(root)) return { ok: false, reason: 'search-root-missing', message: `搜索根不可用：${root || '(未设置)'}` }

  const scan = scanTeamDirs({ root, maxDepth: DEFAULT_SCAN_DEPTH })
  const hits = scan.found.filter((f) => f.identCode === ident)
  if (!hits.length) return { ok: false, reason: 'ident-not-found', message: '搜索根下没有识别码匹配的团队' }
  if (hits.length > 1) {
    return { ok: false, reason: 'ident-ambiguous', message: `有 ${hits.length} 个团队使用同一识别码，无法确定加入哪一个`, hits: hits.map((h) => h.dir) }
  }

  const hit = hits[0]
  const src = openTeamSource({ root: hit.dir })
  // 一次性判定基于**团队源**（不是本机配置）：换机器/恢复备份后仍不能复用同一验证码
  const { records } = readAllMemberLogs(src)
  const used = consumedInvites(records)
  const { members } = verifyTeamSource(src)

  const keysDir = src.paths.keysDir
  let envNames = []
  try { envNames = readdirSync(keysDir).filter((n) => n.endsWith('.env')) } catch { envNames = [] }
  if (!envNames.length) return { ok: false, reason: 'no-envelope', message: '团队源里没有可用的邀请信封（请让成员先生成邀请）' }

  let expiredSeen = false
  for (const n of envNames.sort()) {
    const memberId = n.replace(/\.env$/, '')
    if (used.has(memberId)) continue // 已消费：跳过（但要与"验证码错"区分）
    const path = join(keysDir, n)
    const ph = detectPlaceholderSync(path)
    if (ph.placeholder) continue
    let text = ''
    try { text = readFileSync(path, 'utf-8') } catch { continue }
    const opened = openTeamKeyEnvelope(text, { code: vcode, teamId: hit.teamId, now })
    if (opened.ok) {
      // 成功：追加两条记录（我加入 + 该邀请信封作废）
      const memberIdMine = memberId
      const kp = generateMemberKeyPair()
      let mine = []
      mine.push(addMemberOp(mine, {
        memberId: memberIdMine, role: 'editor', publicKey: kp.publicKey,
        by: fingerprint(kp.publicKey), privateKey: kp.privateKey, ts: now,
      }))
      mine.push(revokeMemberOp(mine, {
        memberId: memberIdMine, scope: 'invite', by: fingerprint(kp.publicKey), privateKey: kp.privateKey, ts: now,
      }))
      src.writeLog(cfg.deviceId, mine.map((r) => JSON.stringify(r)).join('\n') + '\n')

      cfg.searchRoot = cfg.searchRoot || root
      cfg.teams[hit.teamId] = {
        teamId: hit.teamId, name: hit.name, dir: hit.dir, identCode: ident, memberId: memberIdMine,
        role: 'editor', teamKey: Buffer.from(opened.teamKey).toString('base64'),
        joinedAt: new Date(now).toISOString(), deviceId: cfg.deviceId,
        identity: { publicKey: kp.publicKey, privateKey: kp.privateKey, fingerprint: fingerprint(kp.publicKey) },
      }
      saveTeamConfig(configDir, cfg)
      return { ok: true, teamId: hit.teamId, name: hit.name, dir: hit.dir, memberId: memberIdMine, role: 'editor', alreadyMember: members.some((m) => m.memberId === memberIdMine) }
    }
    if (opened.reason === 'expired') expiredSeen = true
  }
  // 区分"码错"与"已用过/过期"：都归为 bad-code 会让用户反复重试一个永远不会成功的码
  if (expiredSeen) return { ok: false, reason: 'expired', message: '该验证码已过期，请让成员重新生成' }
  if (used.size && used.size >= envNames.length) return { ok: false, reason: 'already-used', message: '团队源里的邀请都已使用过（验证码一次性），请让成员重新生成' }
  return { ok: false, reason: 'bad-code', message: '验证码不正确' }
}

// ---------------------------------------------------------------------------
// 撤销 / 状态
// ---------------------------------------------------------------------------

/** 移除成员（写共享目录的签名记录）。只有签名者本人的密钥可用 ⇒ 无法伪造他人的移除记录。 */
export function revokeMember({ configDir, teamId, memberId, now = Date.now() } = {}) {
  const cfg = loadTeamConfig(configDir)
  const local = cfg.teams[String(teamId)]
  if (!local) return { ok: false, reason: 'not-a-member', message: '本机没有加入该团队' }
  const me = local.identity || cfg.identity
  const src = openTeamSource({ root: local.dir })
  const r = src.readLogCopies(String(cfg.deviceId).replace(/^log-/, ''))
  const existing = r.records.map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
  const rec = revokeMemberOp(existing, { memberId: String(memberId), by: me.fingerprint, privateKey: me.privateKey, ts: now })
  src.writeLog(cfg.deviceId, [...existing, rec].map((x) => JSON.stringify(x)).join('\n') + '\n')
  return { ok: true, memberId: String(memberId), record: rec }
}

/**
 * 团队状态（供 `GET /team/status` 与排障）：成员表 + 完整性 + 同步盘警告 + 体积度量。
 * 三样东西一起给，是因为它们**互为解释**：成员少了要能立刻看出是"链验不过"还是"副本没同步到"。
 */
export function teamStatus({ configDir, teamId = null, now = Date.now() } = {}) {
  const cfg = loadTeamConfig(configDir)
  const ids = teamId ? [String(teamId)] : Object.keys(cfg.teams)
  const out = []
  for (const id of ids) {
    const local = cfg.teams[id]
    if (!local) { out.push({ teamId: id, ok: false, reason: 'not-a-member' }); continue }
    const src = openTeamSource({ root: local.dir })
    if (!existsSync(src.paths.manifest)) { out.push({ teamId: id, ok: false, reason: 'team-dir-missing', dir: local.dir }); continue }
    const v = verifyTeamSource(src)
    out.push({
      teamId: id,
      ok: true,
      name: local.name,
      dir: local.dir,
      identCode: local.identCode,
      me: { memberId: local.memberId, role: local.role, fingerprint: (local.identity && local.identity.fingerprint) || cfg.identity.fingerprint },
      memberCount: v.members.length,
      members: v.members.map((m) => ({ memberId: m.memberId, role: m.role, status: m.status, fingerprint: m.fingerprint })),
      integrity: v.integrity,
      copies: v.copies.length,
      warnings: src.scanWarnings(),
      measure: src.measure(),
      checkedAt: new Date(now).toISOString(),
    })
  }
  return { ok: true, deviceId: cfg.deviceId, searchRoot: cfg.searchRoot, teams: out }
}

/** 设置搜索根（"两个数字加入"的前提：先告诉应用去哪儿找团队源）。 */
export function setSearchRoot(configDir, root) {
  const cfg = loadTeamConfig(configDir)
  cfg.searchRoot = root ? String(root) : null
  saveTeamConfig(configDir, cfg)
  return { ok: true, searchRoot: cfg.searchRoot }
}

/** 确保本机团队目录存在（保存私钥前调用）。 */
export function ensureTeamConfigDir(configDir) {
  const d = teamConfigDir(configDir)
  try { mkdirSync(d, { recursive: true }) } catch { /* ignore */ }
  return d
}

// 供测试与排障：暴露 canonicalJson（保证"记录序列化口径"与哈希口径同源）
export { canonicalJson, appendMemberOp }
