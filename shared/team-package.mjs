// shared/team-package.mjs —— `.yfwteam` **邀请包**（spec §5.9 / §10 验收 5）
//
// spec 原文（§5.9「加入团队」行）：
//   「**输入「识别码 + 验证码」两个数字 → 完成**。兜底：拖入 `.yfwteam` 邀请包，或手动选择目录」
// spec §5.9 定案 17：
//   「⚠️ **保留 `.yfwteam` 邀请包，但降级为兜底**：当搜索根不可用（跨网段直连、服务器源、对方
//     网盘根结构未知）时使用。仍与 `.yfwflow`、知识包**同族格式**，复用 manifest + 内容指纹 +
//     校验安全模型（§7）。」
// spec §10 验收 5：
//   「`.yfwteam` 邀请包仍可用（兜底路径），拖入即完成配置。」
//
// ---------------------------------------------------------------------------
// 【本模块解决的是"寻址"，不是"授权"——这个边界必须写清楚，否则会被误读成安全机制】
//
// 两个数字加入（主路径）的前提是**搜索根已设置**：应用在搜索根下扫 `team.json` 的识别码。
// 跨网段直连、对方网盘根结构未知、只有一个团队目录手头可发时，扫描这条路走不通——
// 邀请包把「团队在哪（source.dir）+ 我是谁（manifest）+ 我的邀请（信封 + 验证码）」装进
// **一个文件**，于是"拖进去即完成配置"，不需要搜索根。
//
// ⚠️ 诚实边界（§5.9「单机版的『邀请』没有强制力」）：包里**同时**装着验证码与它要解的密钥信封，
// 所以**这个文件本身就是凭据**——拿到文件的人就能加入。这与 spec 的安全模型**一致**而非削弱它：
//   ① 信封的存在意义是让"验证码"能走不安全信道（聊天工具）而**明文团队密钥永不出本机**；
//      信封 + 验证码合起来等价于团队密钥的可用副本，故"发文件"与"发码"本就是同一信任级。
//   ② spec 明示真实边界**始终是 OS ACL / 网盘权限**，应用层登记没有强制力
//      ⇒ 不宣称"文件已加密/仅受邀可读"（文案红线见 `src/lib/teamOnboardingUi.ts` 的措辞守卫）。
//   ③ **一次性**语义不受影响：用没用过由**团队源侧的成员日志**判定（`consumedInvites`），
//      同一份包再导入一次照样失败（`invite-used`）——见 `kernel/team-store.mjs:importTeamPackage`。
//
// 【为什么是单文件 JSON，不是 zip】
// 与 `.yfwflow` 同族（那份也是单文件 JSON，见 `server/workflow-store.mjs:exportBundle`）：
// 拖入/下载/转发都只需一次文件拷贝，且**不引入 zip 依赖**（内核 bundle 要能直接 import 本文件）。
// 内容只有几个短字符串，压缩收益为零。
//
// 分工（同 S2-D6 / S3 的切分惯例）：
//   `shared/team-package.mjs` = **本文件**：格式常量 + 指纹 + 组装/解析（纯规则，零 IO）
//   `kernel/team-store.mjs`   = 编排：取本机团队配置 → 造信封 → 组装包；解析包 → 落成员日志
import { createHash } from 'node:crypto'
import { canonicalJson } from './team-members.mjs'
import { IDENT_CODE_LEN, VERIFY_CODE_LEN, ENVELOPE_TTL_MS } from './team-crypto.mjs'

/** 包格式标识（同族命名：`yfworking-workflow` → `yfworking-team`）。 */
export const TEAM_PACK_FORMAT = 'yfworking-team'

/** 包结构版本。**加字段不 bump**（`parseTeamPackage` 只校验必需字段，未知字段原样保留）。 */
export const TEAM_PACK_SCHEMA_VERSION = 1

/** 扩展名（含点）——前端按它判"拖进来的是不是邀请包"，也用于下载文件名。 */
export const TEAM_PACK_EXT = '.yfwteam'

/** 解析失败原因 → 机器可判的枚举（前端据此给不同文案，不笼统报"文件无效"）。 */
export const PACK_PARSE_REASONS = Object.freeze([
  'not-json',              // 文本不是 JSON（拖错了文件、或复制粘贴截断）
  'bad-format',            // 是 JSON 但不是邀请包（format 字段不符）
  'bad-schema',            // 格式对但结构版本不认识（比本机新）
  'missing-field',         // 缺必需字段（手工改坏）
  'fingerprint-mismatch',  // 指纹对不上 —— 内容被改过（含"改了验证码/目录"这类针对性篡改）
  'code-expired',          // 包自带的过期时间已过（信封过期前先给用户一个明确说法）
])

/** 指纹算法（写进包体，便于将来换算法时能识别老包）。 */
export const PACK_FINGERPRINT_ALGO = 'sha256'

/**
 * 参与指纹的**包体**（顺序无关：`packFingerprint` 内部走 `canonicalJson`）。
 *
 * 为什么把这三段**全部**纳入指纹、且**不含** `exportedAt`/`fingerprint` 自身：
 *   · `team` 段被篡改 ⇒ 可以把包指向另一个团队（改了 teamId 却留着别人的信封）；
 *   · `invite` 段被篡改 ⇒ 可以换掉验证码或换成自己造的信封（**最需要防的一条**）；
 *   · `source` 段被篡改 ⇒ 可以把受害者引到一个攻击者控制的目录（"加入"后读的是攻击者的源）。
 *   而 `exportedAt` 只是展示信息，纳入指纹会让"同一份包重新导出"看起来像篡改。
 */
export function packBodyOf(pack) {
  const p = (pack && typeof pack === 'object' ? pack : {}) || {}
  return {
    format: p.format,
    schemaVersion: p.schemaVersion,
    team: p.team ?? null,
    invite: p.invite ?? null,
    source: p.source ?? null,
  }
}

/** 包体指纹：`sha256:<hex>`（前缀带算法，便于将来并存多种算法）。 */
export function packFingerprint(pack) {
  const bytes = canonicalJson(packBodyOf(pack))
  return `${PACK_FINGERPRINT_ALGO}:${createHash('sha256').update(bytes, 'utf-8').digest('hex')}`
}

/** 常量时间无关的字符串比较（指纹不是秘密，用普通比较即可；这里只为语义清晰）。 */
function sameFingerprint(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && a === b
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''
const isDigitsOfLen = (v, len) => typeof v === 'string' && new RegExp(`^\\d{${len}}$`).test(v)

/**
 * 组装邀请包。
 *
 * 入参由 `kernel/team-store.mjs:exportTeamPackage` 提供（那里掌握本机团队配置与团队密钥）；
 * 本函数**不做 IO**，因此可以脱离文件系统单独验证格式与指纹。
 *
 * @param {object} p
 * @param {object} p.manifest   团队清单（`team.json` 的公开字段：teamId/name/identCode/salt/scrypt…）
 * @param {string} p.memberId   为本成员分配的 memberId（信封文件名的本体）
 * @param {string} p.code       6 位一次性验证码
 * @param {string} p.envelope   团队密钥信封的**文本**（`sealTeamKeyEnvelope` 的产物）
 * @param {string} [p.sourceDir] 团队源目录（导出方视角；导入方若挂载点不同可另行指定）
 * @param {number} [p.ttlMs]    有效期（默认与信封一致：`ENVELOPE_TTL_MS`）
 * @param {number} [p.now]      「现在」（注入以便测试；默认 `Date.now()`）
 */
export function buildTeamPackage({ manifest, memberId, code, envelope, sourceDir = null, ttlMs = ENVELOPE_TTL_MS, now = Date.now() } = {}) {
  const m = manifest && typeof manifest === 'object' ? manifest : {}
  const teamId = isNonEmptyString(m.teamId) ? String(m.teamId) : ''
  const identCode = isNonEmptyString(m.identCode) ? String(m.identCode) : ''
  const pack = {
    format: TEAM_PACK_FORMAT,
    schemaVersion: TEAM_PACK_SCHEMA_VERSION,
    exportedAt: new Date(now).toISOString(),
    // ① 团队是谁（公开信息：`team.json` 里本就没有密钥材料）
    team: {
      teamId,
      name: isNonEmptyString(m.name) ? String(m.name) : '团队',
      identCode,
      ...(isNonEmptyString(m.salt) ? { salt: String(m.salt) } : {}),
      ...(m.scrypt && typeof m.scrypt === 'object' ? { scrypt: m.scrypt } : {}),
    },
    // ② 我的邀请（信封 + 一次性验证码；见文件头"诚实边界"）
    invite: {
      memberId: isNonEmptyString(memberId) ? String(memberId) : '',
      code: isNonEmptyString(code) ? String(code) : '',
      envelope: isNonEmptyString(envelope) ? String(envelope) : '',
      expiresAt: new Date(now + ttlMs).toISOString(),
    },
    // ③ 团队在哪（导入方可覆盖；包里的值只是"导出方视角的提示"）
    source: { dir: isNonEmptyString(sourceDir) ? String(sourceDir) : null },
  }
  pack.fingerprint = packFingerprint(pack)
  return pack
}

/**
 * 解析并**校验**邀请包（接受 JSON 文本或已解析对象）。
 *
 * 校验顺序刻意从"最容易给出好文案的"开始：不是 JSON → 不是包 → 版本新 → 缺字段 → 指纹 → 过期。
 * 返回 `{ ok:true, pack }` 或 `{ ok:false, reason, message, missing? }`。
 *
 * **指纹校验失败与缺字段分开报**：前者意味着"文件被改过"（要提醒重新索要），后者意味着
 * "文件不完整"（可能复制粘贴截断）——两种处置完全不同，合并成一句"文件无效"会让用户反复重试。
 */
export function parseTeamPackage(input) {
  let obj = input
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) return { ok: false, reason: 'not-json', message: '邀请包内容为空' }
    try { obj = JSON.parse(text) } catch { return { ok: false, reason: 'not-json', message: '这不是邀请包文件（内容不是 JSON）' } }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'not-json', message: '这不是邀请包文件（内容不是 JSON 对象）' }
  }
  const p = obj
  if (p.format !== TEAM_PACK_FORMAT) {
    return { ok: false, reason: 'bad-format', message: `不是团队邀请包（format=${String(p.format)}）` }
  }
  if (!Number.isInteger(p.schemaVersion) || p.schemaVersion > TEAM_PACK_SCHEMA_VERSION || p.schemaVersion < 1) {
    return { ok: false, reason: 'bad-schema', message: `邀请包结构版本不受支持（${String(p.schemaVersion)}）` }
  }

  const team = (p.team && typeof p.team === 'object') ? p.team : {}
  const invite = (p.invite && typeof p.invite === 'object') ? p.invite : {}
  const source = (p.source && typeof p.source === 'object') ? p.source : null
  const missing = []
  if (!isNonEmptyString(team.teamId)) missing.push('team.teamId')
  if (!isDigitsOfLen(String(team.identCode ?? ''), IDENT_CODE_LEN)) missing.push(`team.identCode(${IDENT_CODE_LEN}位数字)`)
  if (!isNonEmptyString(invite.memberId)) missing.push('invite.memberId')
  if (!isDigitsOfLen(String(invite.code ?? ''), VERIFY_CODE_LEN)) missing.push(`invite.code(${VERIFY_CODE_LEN}位数字)`)
  if (!isNonEmptyString(invite.envelope)) missing.push('invite.envelope')
  if (!source || !isNonEmptyString(source.dir)) missing.push('source.dir')
  if (missing.length) return { ok: false, reason: 'missing-field', missing, message: `邀请包缺少必需内容：${missing.join('、')}` }

  const expect = packFingerprint(p)
  if (!sameFingerprint(p.fingerprint, expect)) {
    // 只报"对不上"，**不回显两个指纹**：回显会诱使人照着手改 fingerprint 字段绕过校验
    return { ok: false, reason: 'fingerprint-mismatch', message: '邀请包校验失败：内容与指纹不一致（文件可能被修改过），请向邀请人重新索要' }
  }

  if (isNonEmptyString(invite.expiresAt)) {
    const t = Date.parse(String(invite.expiresAt))
    if (Number.isFinite(t) && t < Date.now()) {
      return { ok: false, reason: 'code-expired', message: `该邀请包已于 ${String(invite.expiresAt).slice(0, 10)} 过期，请让成员重新生成邀请` }
    }
  }

  return { ok: true, pack: p }
}

/**
 * 下载文件名：`<团队名>-<teamId 后 4 位>.yfwteam`。
 *
 * 团队名可能含 `/` `\` `:` 等非法字符（团队名由用户自由填写，真实例："湖北美宝药业股份有限公司"），
 * 直接当文件名会在 Windows 上失败或跑到别的目录 ⇒ 统一替换成 `-`，并兜住空名/超长。
 */
export function teamPackFilename(name, teamId = '') {
  const raw = String(name ?? '').trim()
  const safeName = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 40) || 'team'
  const tail = String(teamId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(-4) || '0000'
  return `${safeName}-${tail}${TEAM_PACK_EXT}`
}
