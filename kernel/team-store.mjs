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

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
import { buildTeamPackage, parseTeamPackage, teamPackFilename } from '../shared/team-package.mjs'

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
 * @param {{ configDir?: string, name?: string, dir?: string, now?: number, identCode?: string|null }} [p]
 *   ★ **为什么必须逐键登记**：不写时 TS 只按"带默认值的绑定"推断 ⇒ 无默认值的键（configDir/teamId/…）直接缺席——功能体内读它们报 TS2339，调用点传它们报 TS2353。
 *   这里只补类型，不改任何运行逻辑（团队数据的读写路径一字未动）。
 */
export function createTeam({ configDir, name, dir, now = Date.now(), identCode = null } = {}) {
  if (!dir) return { ok: false, reason: 'dir-required', message: '必须指定团队源目录' }
  const cfg = loadTeamConfig(configDir)
  const src = openTeamSource(/** @type {Parameters<typeof openTeamSource>[0] & { root?: string }} */ ({ root: dir }))
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
  records.push(addMemberOp(records, /** @type {Parameters<typeof addMemberOp>[1] & { memberId?: string, publicKey?: string, by?: string, privateKey?: string, ts?: number, role?: string }} */ ({
    memberId, role: 'owner', publicKey: cfg.identity.publicKey,
    by: cfg.identity.fingerprint, privateKey: cfg.identity.privateKey, ts: now,
  })))
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
 * @param {{ configDir?: string, teamId?: string, now?: number, ttlMs?: number, memberId?: string|null }} [p]
 *   ★ **为什么必须逐键登记**：不写时 TS 只按"带默认值的绑定"推断 ⇒ 无默认值的键（configDir/teamId/…）直接缺席——功能体内读它们报 TS2339，调用点传它们报 TS2353。
 *   这里只补类型，不改任何运行逻辑（团队数据的读写路径一字未动）。
 */
export function exportInvite({ configDir, teamId, now = Date.now(), ttlMs = ENVELOPE_TTL_MS, memberId = null } = {}) {
  const cfg = loadTeamConfig(configDir, { strict: false })
  const local = cfg.teams[String(teamId)]
  if (!local) return { ok: false, reason: 'not-a-member', message: '本机没有加入该团队，无法邀请' }
  if (!local.teamKey) return { ok: false, reason: 'no-team-key', message: '本机缺少团队密钥（可能只是加入了成员列表），无法邀请' }
  const src = openTeamSource(/** @type {Parameters<typeof openTeamSource>[0] & { root?: string }} */ ({ root: local.dir }))
  if (!existsSync(src.paths.read.manifestFile())) return { ok: false, reason: 'team-dir-missing', message: `团队源目录不可用：${local.dir}` }

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
 * 「加入成功」的**唯一落盘收口**（`joinTeam` 与 `importTeamPackage` 共用）。
 *
 * 为什么必须收口：加入成功要原子地做四件事 —— ① 生成**本成员自己的**密钥对；
 * ② 追加"我加入"签名记录；③ 追加"该邀请信封已作废"记录（验证码**一次性**的落点，§5.9）；
 * ④ 写本机配置（团队密钥 + 我的 memberId + 我是谁的公私钥）。
 * 两处各写一遍必然漂移，而漂移的后果是**不可见的**：漏写第 ③ 条 = 验证码可以无限复用
 * （安全漏洞）；漏写 `identity` = 该成员此后无法撤销他人（`revokeMember` 取不到自己的私钥）。
 */
function completeJoin({ cfg, configDir, src, teamId, name, dir, identCode, memberId, teamKey, now, searchRoot = null, role = 'editor' }) {
  const kp = generateMemberKeyPair()
  let mine = []
  mine.push(addMemberOp(mine, /** @type {Parameters<typeof addMemberOp>[1] & { memberId?: string, publicKey?: string, by?: string, privateKey?: string, ts?: number, role?: string }} */ ({
    memberId, role, publicKey: kp.publicKey,
    by: fingerprint(kp.publicKey), privateKey: kp.privateKey, ts: now,
  })))
  mine.push(revokeMemberOp(mine, /** @type {Parameters<typeof revokeMemberOp>[1] & { memberId?: string, scope?: string, by?: string, privateKey?: string, ts?: number }} */ ({
    memberId, scope: 'invite', by: fingerprint(kp.publicKey), privateKey: kp.privateKey, ts: now,
  })))
  src.writeLog(cfg.deviceId, mine.map((r) => JSON.stringify(r)).join('\n') + '\n')

  if (searchRoot) cfg.searchRoot = cfg.searchRoot || searchRoot
  // 加入成功 ⇒ 清掉试码计数（独立文件，见 `joinThrottle`：成功即归零）
  clearJoinThrottle(configDir, teamId)
  cfg.teams[String(teamId)] = {
    teamId: String(teamId), name, dir, identCode, memberId,
    role, teamKey: Buffer.from(teamKey).toString('base64'),
    joinedAt: new Date(now).toISOString(), deviceId: cfg.deviceId,
    identity: { publicKey: kp.publicKey, privateKey: kp.privateKey, fingerprint: fingerprint(kp.publicKey) },
  }
  saveTeamConfig(configDir, cfg)
  return {
    ok: true, teamId: String(teamId), name, dir, memberId, role,
    identity: { fingerprint: fingerprint(kp.publicKey) },
  }
}

/**
 * 加入团队：扫描搜索根 → 找 `team.json` 内容匹配识别码 → 逐个信封试验证码 → 成功后
 * ① 追加"我加入"的签名记录；② 追加"邀请信封已作废"记录（一次性）；③ 存本机配置。
 *
 * 失败原因逐项区分（不笼统报"加入失败"）：`ident-not-found`、`ident-ambiguous`（多个团队同码）、
 * `no-envelope`、`bad-code`、`expired`、`already-used`（一次性）、`search-root-missing`。
 */
/** 连续错码达到这个次数即进入冷却（§10 验收 6「错误验证码被拒并计入限速」）。 */
export const JOIN_MAX_ATTEMPTS = 5

/** 冷却时长。取 1 分钟：够打断"手输狂按/脚本刷码"，又不至于让手滑的人等太久。 */
export const JOIN_COOLDOWN_MS = 60_000

/**
 * 试码限速的计数与判定。
 *
 * ⚠️ **这是礼让限制，不是安全边界 —— 必须写清，否则会被误读成"防爆破机制"**：
 *   · 计数存在**本机**（`<configDir>/team/join-attempts.json`）⇒ 删掉它、换设备、或**直接拿 `keys/`
 *     里的信封离线试**，都能绕过。真正的成本来自 `scrypt N=2^15`（每次约百毫秒）+ 一次性 + 7 天有效
 *     （§5.9「验证码的安全设计」），而真实边界始终是**网盘 ACL**（能读 `keys/` 的人本已被授权）。
 *   · 它真正解决的问题是**在线侧的噪声**：手滑连错、或脚本对着桥猛刷，每次都要付 scrypt 代价并写日志；
 *     限速把这条路径掐断。
 *   · 因此**不**据此宣称"6 位码无法爆破"——那个结论只由 scrypt 成本 + 有效期 + 一次性支撑。
 *
 * 为什么单独一个文件、而不是写进 `team/config.json`：加入**失败**时不得改动本机团队配置
 * （既有断言：失败不留半截状态 —— 不落团队条目、不落密钥）。限速计数是"防噪"用的旁观数据，
 * 一旦混进团队配置，就会让"失败没写配置"这条**强断言**变成需要放宽的模糊断言 —— 那是拆门禁。
 */
const JOIN_ATTEMPTS_FILE = 'join-attempts.json'

function joinAttemptsPath(configDir) { return join(configDir, 'team', JOIN_ATTEMPTS_FILE) }

function loadJoinAttempts(configDir) {
  try {
    const m = JSON.parse(readFileSync(joinAttemptsPath(configDir), 'utf-8'))
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {}
  } catch { return {} }  // 不存在/损坏 ⇒ 视为没有计数（限速是礼让，不该因文件坏了而拦住正常加入）
}

function saveJoinAttempts(configDir, map) {
  try {
    mkdirSync(join(configDir, 'team'), { recursive: true })
    writeFileSync(joinAttemptsPath(configDir), JSON.stringify(map, null, 2), 'utf-8')
  } catch { /* 写不进去就退化成"不限速"——绝不因为计数写失败而阻断加入 */ }
}

function joinThrottle(configDir, teamId, now) {
  const rec = loadJoinAttempts(configDir)[String(teamId)] || null
  const blockedUntil = rec && Number.isFinite(Number(rec.blockedUntil)) ? Number(rec.blockedUntil) : 0
  return {
    blocked: blockedUntil > now,
    blockedUntil,
    retryAfterSec: blockedUntil > now ? Math.ceil((blockedUntil - now) / 1000) : 0,
  }
}

/** 记一次**错码**；达到阈值则进入冷却并把计数清零（冷却从最后一次错码起算）。 */
function bumpJoinThrottle(configDir, teamId, now) {
  const key = String(teamId)
  const map = loadJoinAttempts(configDir)
  const count = Number(map[key] && map[key].count ? map[key].count : 0) + 1
  const rec = count >= JOIN_MAX_ATTEMPTS
    ? { count: 0, blockedUntil: now + JOIN_COOLDOWN_MS }
    : { count, blockedUntil: 0 }
  saveJoinAttempts(configDir, { ...map, [key]: rec })
  return rec
}

/** 加入成功 ⇒ 清掉该团队的试码计数（§10 验收 6 的限速：连续错码累计，成功即归零）。 */
function clearJoinThrottle(configDir, teamId) {
  const map = loadJoinAttempts(configDir)
  if (!(String(teamId) in map)) return
  delete map[String(teamId)]
  saveJoinAttempts(configDir, map)
}

/**
 * 用"识别码 + 验证码"两个数字加入团队：扫搜索根 → 命中团队源 → 核销一次性封套 → 落本机配置。
 * @param {{ configDir?: string, identCode?: string, code?: string, searchRoot?: string|null, now?: number }} [p]
 *   ★ 无默认值的键（configDir/identCode/code）不登记就缺席（功能体内读它们报 TS2339、调用点传它们报 TS2353）；
 *   只补类型，不改任何读写路径。
 */
export function joinTeam({ configDir, identCode, code, searchRoot = null, now = Date.now() } = {}) {
  const ident = normalizeCode(identCode, IDENT_CODE_LEN)
  if (!ident) return { ok: false, reason: 'bad-ident-format', message: `识别码应为 ${IDENT_CODE_LEN} 位数字` }
  const vcode = normalizeCode(code, VERIFY_CODE_LEN)
  if (!vcode) return { ok: false, reason: 'bad-code-format', message: `验证码应为 ${VERIFY_CODE_LEN} 位数字` }

  const cfg = loadTeamConfig(configDir)
  const root = searchRoot || cfg.searchRoot
  if (!root || !existsSync(root)) return { ok: false, reason: 'search-root-missing', message: `搜索根不可用：${root || '(未设置)'}` }

  const scan = scanTeamDirs(/** @type {Parameters<typeof scanTeamDirs>[0] & { root?: string }} */ ({ root, maxDepth: DEFAULT_SCAN_DEPTH }))
  const hits = scan.found.filter((f) => f.identCode === ident)
  if (!hits.length) return { ok: false, reason: 'ident-not-found', message: '搜索根下没有识别码匹配的团队' }
  if (hits.length > 1) {
    return { ok: false, reason: 'ident-ambiguous', message: `有 ${hits.length} 个团队使用同一识别码，无法确定加入哪一个`, hits: hits.map((h) => h.dir) }
  }

  const hit = hits[0]
  const src = openTeamSource(/** @type {Parameters<typeof openTeamSource>[0] & { root?: string }} */ ({ root: hit.dir }))
  // 一次性判定基于**团队源**（不是本机配置）：换机器/恢复备份后仍不能复用同一验证码
  const { records } = readAllMemberLogs(src)
  const used = consumedInvites(records)
  const { members } = verifyTeamSource(src)

  // 双读：邀请信封可能落在容器内 `keys/`（新布局）或团队根下的 `keys/`（旧布局）⇒ 两边都要找，
  // 否则旧团队会表现为"团队源里没有可用的邀请信封"，而信封其实就在那儿。
  const envFiles = []
  for (const d of [src.paths.keysDir, src.paths.legacy.keysDir]) {
    let names = []
    try { names = readdirSync(d).filter((n) => n.endsWith('.env')) } catch { continue }
    for (const n of names) envFiles.push({ name: n, path: join(d, n) })
  }
  if (!envFiles.length) return { ok: false, reason: 'no-envelope', message: '团队源里没有可用的邀请信封（请让成员先生成邀请）' }
  // 名序稳定（跨目录也确定）：重放/试码顺序必须区域无关地可断言
  envFiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  // 限速在**试码之前**判定：冷却期内连正确验证码也拒（否则"刷到对为止"照样可行）。
  // 放在识别码命中之后：识别码不对属"找错了团队"，没必要耗冷却（也不该让用户以为是码错了）。
  const gate = joinThrottle(configDir, hit.teamId, now)
  if (gate.blocked) {
    return {
      ok: false, reason: 'rate-limited', retryAfterSec: gate.retryAfterSec,
      message: `验证码错误次数过多，请 ${gate.retryAfterSec} 秒后再试`,
    }
  }

  let expiredSeen = false
  let usedMatched = false
  for (const { name: n, path } of envFiles) {
    const memberId = n.replace(/\.env$/, '')
    if (used.has(memberId)) {
      // 已消费的信封**仍要试一次**（只判不加入，不写任何文件）：只有它能区分两种失败 ——
      // "这枚码确实用过"（→ already-used，重试永远无意义）与"这枚码不对"（→ bad-code，可以重试）。
      // 不试就会在"团队里还有别的未用信封"时把前者误报成后者，用户会拿着一个废码反复重试。
      try {
        const t = readFileSync(path, 'utf-8')
        if (openTeamKeyEnvelope(t, /** @type {Parameters<typeof openTeamKeyEnvelope>[1] & { code?: string, teamId?: string, now?: number }} */ ({ code: vcode, teamId: hit.teamId, now })).ok) usedMatched = true
      } catch { /* 读不到/坏了就当不匹配 */ }
      continue
    }
    const ph = detectPlaceholderSync(path)
    if (ph.placeholder) continue
    let text = ''
    try { text = readFileSync(path, 'utf-8') } catch { continue }
    const opened = openTeamKeyEnvelope(text, /** @type {Parameters<typeof openTeamKeyEnvelope>[1] & { code?: string, teamId?: string, now?: number }} */ ({ code: vcode, teamId: hit.teamId, now }))
    if (opened.ok) {
      // 成功：交给**唯一落盘收口**（我加入 + 该邀请信封作废 + 本机配置）
      const r = completeJoin({
        cfg, configDir, src, teamId: hit.teamId, name: hit.name,
        dir: hit.dir, identCode: ident, memberId, teamKey: opened.teamKey, now, searchRoot: root,
      })
      return { ...r, alreadyMember: members.some((m) => m.memberId === memberId) }
    }
    if (opened.reason === 'expired') expiredSeen = true
  }
  // 区分"码错"与"已用过/过期"：都归为 bad-code 会让用户反复重试一个永远不会成功的码
  if (usedMatched) return { ok: false, reason: 'already-used', message: '该验证码已使用过（一次性），请让成员重新生成邀请' }
  if (expiredSeen) return { ok: false, reason: 'expired', message: '该验证码已过期，请让成员重新生成' }
  // 走到这里 = 试了至少一个信封且没解开 ⇒ 记一次错码（已用过/已过期不算错码：那不是猜测）
  const bumped = bumpJoinThrottle(configDir, hit.teamId, now)
  if (Number(bumped.blockedUntil) > now) {
    const sec = Math.ceil((Number(bumped.blockedUntil) - now) / 1000)
    return { ok: false, reason: 'rate-limited', retryAfterSec: sec, message: `验证码不正确；错误次数过多，请 ${sec} 秒后再试` }
  }
  if (used.size && used.size >= envFiles.length) return { ok: false, reason: 'already-used', message: '团队源里的邀请都已使用过（验证码一次性），请让成员重新生成' }
  return { ok: false, reason: 'bad-code', message: '验证码不正确' }
}

// ---------------------------------------------------------------------------
// 邀请包 `.yfwteam`（spec §5.9 定案 17 / §10 验收 5）
// ---------------------------------------------------------------------------

/**
 * 生成 `.yfwteam` 邀请包（兜底路径：当搜索根不可用、或只想把"一个团队"发给一个人时用）。
 *
 * 与 `exportInvite` 的关系：**同一个邀请**的两种交付形态 —— 前者给"一段可转发的话"（靠搜索根寻址），
 * 本函数给"一个文件"（**自带寻址**，不依赖搜索根）。两者共用 `memberId + 验证码 + 信封` 这套东西，
 * 且一次性判定都落在**团队源侧成员日志**上（见 `completeJoin`），故同一份邀请无论走哪条路都只能用一次。
 *
 * 信封**尽力**写进团队源（导出方通常能访问团队目录，写上以后两条路径都能用）；
 * 团队源此刻不可达**不算失败** —— 这正是本包存在的理由（包自带信封，导入方不需要那份副本）。
 * @param {{ configDir?: string, teamId?: string, sourceDir?: string|null, now?: number, ttlMs?: number }} [p]
 *   ★ 无默认值的键（configDir/teamId）不登记就缺席（体内读它们报 TS2339、调用点传它们报 TS2353）；只补类型，不改读写路径。
 */
export function exportTeamPackage({ configDir, teamId, sourceDir = null, now = Date.now(), ttlMs = ENVELOPE_TTL_MS } = {}) {
  const cfg = loadTeamConfig(configDir, { strict: false })
  const local = cfg.teams[String(teamId)]
  if (!local) return { ok: false, reason: 'not-a-member', message: '本机没有加入该团队，无法邀请' }
  if (!local.teamKey) return { ok: false, reason: 'no-team-key', message: '本机缺少团队密钥（可能只是加入了成员列表），无法邀请' }

  const src = openTeamSource(/** @type {Parameters<typeof openTeamSource>[0] & { root?: string }} */ ({ root: local.dir }))
  let manifest = null
  try { manifest = src.readManifest() } catch { manifest = null }
  if (!manifest || manifest.teamId !== String(teamId)) {
    return { ok: false, reason: 'team-dir-missing', message: `团队源目录不可用或清单不匹配：${local.dir}` }
  }

  // 每次导出都开**新成员槽**：刻意不接受外部指定 memberId —— 用同一个槽再导出会覆盖既有信封，
  // 让一份**已经在流通**的验证码静默失效（对方报"验证码错"，而邀请人看不出原因）。多开一个槽没有代价。
  const newMemberId = generateMemberId()
  const code = generateVerifyCode()
  const envelope = sealTeamKeyEnvelope({
    teamKey: Buffer.from(local.teamKey, 'base64'), code, memberId: newMemberId, teamId: String(teamId), ttlMs, now,
  })
  // 尽力同步一份到团队源；写不进去（目录只读/离线）不阻断——包自带信封即够用
  let envelopeWritten = false
  try { src.writeKeyEnvelope(newMemberId, envelope); envelopeWritten = true } catch { envelopeWritten = false }

  const pack = buildTeamPackage({
    manifest, memberId: newMemberId, code, envelope,
    sourceDir: sourceDir ? String(sourceDir) : local.dir, ttlMs, now,
  })
  return {
    ok: true,
    teamId: String(teamId),
    memberId: newMemberId,
    code,
    expiresAt: pack.invite.expiresAt,
    fingerprint: pack.fingerprint,
    filename: teamPackFilename(manifest.name, teamId),
    package: pack,
    envelopeWritten,
    // 与 `exportInvite` 同样的 §11 措辞约束：**不**暗示"加密所以安全"
    copyText: `加入团队「${manifest.name}」的邀请包（${pack.invite.expiresAt.slice(0, 10)} 前有效，只能用一次）：把 ${teamPackFilename(manifest.name, teamId)} 拖进应用即可。`
      + `邀请包里含验证码，等于凭据本身，请用你信任的渠道发送。`,
  }
}

/**
 * 导入 `.yfwteam` 邀请包完成加入（spec §10 验收 5「拖入即完成配置」）。
 *
 * 与 `joinTeam`（两个数字）的三处差异，都是"兜底路径"的必然结果：
 *   ① **不扫描搜索根** —— 包自带 `source.dir`（寻址）；`sourceDir` 参数可覆盖（导入方挂载点不同，
 *      例如导出方是 `Z:\团队`、导入方是 `D:\同步\团队`）；
 *   ② 识别码与验证码**来自包**，用户无需手输（但仍逐项校验）；
 *   ③ 本机团队配置里会记下**实际使用**的目录（而不是包里那个可能不存在的路径）。
 *
 * 一次性与防重放**不含糊**：用没用过仍由团队源侧成员日志判定（`consumedInvites`），
 * 故"同一个包导入两次"第二次必失败（`invite-used`），与两个数字路径行为一致。
 * @param {{ configDir?: string, pack?: object|string|null, text?: string|null, sourceDir?: string|null, now?: number }} [p]
 *   ★ 无默认值的键（configDir）不登记就缺席（体内读它报 TS2339、调用点传它报 TS2353）；只补类型，不改读写路径。
 */
export function importTeamPackage({ configDir, pack = null, text = null, sourceDir = null, now = Date.now() } = {}) {
  const parsed = parseTeamPackage(pack ?? text)
  if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.message, ...(parsed.missing ? { missing: parsed.missing } : {}) }
  const p = parsed.pack

  const dir = sourceDir ? String(sourceDir) : (p.source && p.source.dir ? String(p.source.dir) : '')
  if (!dir) return { ok: false, reason: 'source-missing', message: '邀请包里没有团队目录，请手动指定团队目录' }
  if (!existsSync(dir)) {
    return { ok: false, reason: 'team-dir-missing', message: `团队目录不可用：${dir}（若两台机器的路径不同，请手动指定本机的团队目录）` }
  }

  const src = openTeamSource(/** @type {Parameters<typeof openTeamSource>[0] & { root?: string }} */ ({ root: dir }))
  let manifest = null
  try { manifest = src.readManifest() } catch { manifest = null }
  if (!manifest) return { ok: false, reason: 'team-dir-missing', message: `该目录不是团队源（没有清单）：${dir}` }
  // 包与目录必须是**同一个团队**：否则等于"用 A 团队的验证码去解 B 团队的信封"，必然失败却难排障
  if (manifest.teamId !== p.team.teamId) {
    return {
      ok: false, reason: 'team-mismatch',
      message: `邀请包属于团队 ${p.team.teamId}，但目录里的团队是 ${String(manifest.teamId)}`,
    }
  }

  const cfg = loadTeamConfig(configDir)
  // 一次性：基于团队源成员日志（不是本机配置）⇒ 换机器/恢复备份也拦得住
  const { records } = readAllMemberLogs(src)
  if (consumedInvites(records).has(p.invite.memberId)) {
    return { ok: false, reason: 'invite-used', message: '该邀请包已使用过（验证码一次性），请让成员重新生成邀请' }
  }

  const opened = openTeamKeyEnvelope(p.invite.envelope, /** @type {Parameters<typeof openTeamKeyEnvelope>[1] & { code?: string, teamId?: string, now?: number }} */ ({ code: p.invite.code, teamId: p.team.teamId, now }))
  if (!opened.ok) {
    const reason = opened.reason === 'expired' ? 'code-expired' : 'bad-code'
    const message = opened.reason === 'expired'
      ? '该邀请包已过期，请让成员重新生成邀请'
      : '邀请包无法解开（验证码或信封不匹配），请向邀请人重新索要'
    return { ok: false, reason, message }
  }

  const r = completeJoin({
    cfg, configDir, src, teamId: p.team.teamId,
    name: manifest.name || p.team.name, dir,
    identCode: String(manifest.identCode || p.team.identCode),
    memberId: p.invite.memberId, teamKey: opened.teamKey, now,
  })
  return { ...r, via: 'package', fingerprint: p.fingerprint }
}

// ---------------------------------------------------------------------------
// 撤销 / 状态
// ---------------------------------------------------------------------------

/**
 * 移除成员（写共享目录的签名记录）。只有签名者本人的密钥可用 ⇒ 无法伪造他人的移除记录。
 * @param {{ configDir?: string, teamId?: string, memberId?: string, now?: number }} [p]
 *   ★ 无默认值的键（configDir/teamId/memberId）不登记就缺席（体内读它们报 TS2339、调用点传它们报 TS2353）；
 *   只补类型，**不改数据写路径**（写入的仍是被移除成员的那条签名记录）。
 */
export function revokeMember({ configDir, teamId, memberId, now = Date.now() } = {}) {
  const cfg = loadTeamConfig(configDir)
  const local = cfg.teams[String(teamId)]
  if (!local) return { ok: false, reason: 'not-a-member', message: '本机没有加入该团队' }
  const me = local.identity || cfg.identity
  const src = openTeamSource(/** @type {Parameters<typeof openTeamSource>[0] & { root?: string }} */ ({ root: local.dir }))
  const r = src.readLogCopies(String(cfg.deviceId).replace(/^log-/, ''))
  const existing = r.records.map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
  const rec = revokeMemberOp(existing, /** @type {Parameters<typeof revokeMemberOp>[1] & { memberId?: string, by?: string, privateKey?: string, ts?: number }} */ ({ memberId: String(memberId), by: me.fingerprint, privateKey: me.privateKey, ts: now }))
  src.writeLog(cfg.deviceId, [...existing, rec].map((x) => JSON.stringify(x)).join('\n') + '\n')
  return { ok: true, memberId: String(memberId), record: rec }
}

/**
 * 团队状态（供 `GET /team/status` 与排障）：成员表 + 完整性 + 同步盘警告 + 体积度量。
 * 三样东西一起给，是因为它们**互为解释**：成员少了要能立刻看出是"链验不过"还是"副本没同步到"。
 * @param {{ configDir?: string, teamId?: string|null, now?: number }} [p]
 *   ★ 无默认值的键（configDir）不登记就缺席（体内读它报 TS2339、调用点传它报 TS2353）；只补类型，不改读写路径。
 */
export function teamStatus({ configDir, teamId = null, now = Date.now() } = {}) {
  const cfg = loadTeamConfig(configDir)
  const ids = teamId ? [String(teamId)] : Object.keys(cfg.teams)
  const out = []
  for (const id of ids) {
    const local = cfg.teams[id]
    if (!local) { out.push({ teamId: id, ok: false, reason: 'not-a-member' }); continue }
    const src = openTeamSource(/** @type {Parameters<typeof openTeamSource>[0] & { root?: string }} */ ({ root: local.dir }))
    if (!existsSync(src.paths.read.manifestFile())) { out.push({ teamId: id, ok: false, reason: 'team-dir-missing', dir: local.dir }); continue }
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
