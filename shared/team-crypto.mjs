// shared/team-crypto.mjs —— S3 团队源：**身份与密钥信封的唯一实现**（纯函数，无 IO）。
//
// 依据 spec §5.9「加入机制（定案 15）」：
//   识别码 = **9 位数字**，团队级固定，明文写在 `team.json`（可分享给任意人）；
//   验证码 = **6 位数字**，**每个成员一个**（粒度在成员，便于 revocation）、**一次性**（成功后追加 revoked
//   记录）、默认 **7 天**有效；
//   信封 = `keys/<memberId>.env` = `AEAD(团队密钥, key = scrypt(验证码, 团队源里的 salt, N=2^15))`。
//
// 【必须说清的真实边界（spec 明令，避免误导用户）】
// spec §5.9：**6 位验证码不是访问控制的保证** —— 它防的是"共享目录里那串密钥文件被随手解出来"，
// **不防**"已经拿到共享目录读取权限的人"（那种人本就被网盘 ACL 授权了）。**真实边界始终是 ACL**。
// 而"邀请"也没有强制力：能读 `team.json` 的人本来就能读团队源，代码里做的只是登记。
// 因此**任何 API/UI 文案都不得暗示"已加密，仅受邀可读"**（§11 措辞约束）。本文件的长注释同理：
// 它描述的是"信封这一层"的机制，不是整体安全承诺。
//
// 【为什么识别码与验证码必须是两码】识别码回答"哪个团队"（公开、可张贴）；验证码回答"谁被允许加入"
// （私下给、用完即废）。合成一个码就会陷入两难：要么公开可加入（无门禁），要么每次有人加入就得
// 重新分发给所有人（不可运维）。

import {
  createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomInt,
  scryptSync, sign as cryptoSign, verify as cryptoVerify, timingSafeEqual,
  createPublicKey, createPrivateKey,
} from 'node:crypto'

/** 识别码位数（§5.9：9 位数字）。 */
export const IDENT_CODE_LEN = 9
/** 验证码位数（§5.9：6 位数字）。 */
export const VERIFY_CODE_LEN = 6
/** 信封默认有效期（§5.9：默认 7 天）。 */
export const ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 团队密钥长度（AEAD 用 32 字节 = AES-256）。 */
export const TEAM_KEY_BYTES = 32
/** scrypt 参数（§5.9 指定 N=2^15）。 */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 32 }
/** 信封格式版本（结构变更时靠它判定）。 */
export const ENVELOPE_VERSION = 1

// ---------------------------------------------------------------------------
// 码与 id 生成
// ---------------------------------------------------------------------------

/**
 * 9 位识别码。用 `randomInt`（**密码学随机**，不是 Math.random）逐位生成，保证位数固定（含前导 0）。
 * 逐位生成而非 `randomInt(0, 1e9)` 的原因：后者转字符串后可能不足 9 位，会造成"打印出来 8 位、
 * 用户照着念错"的实际故障。
 */
export function generateIdentCode() {
  let s = ''
  for (let i = 0; i < IDENT_CODE_LEN; i++) s += String(randomInt(0, 10))
  return s
}

/** 6 位验证码（同上，位数固定）。 */
export function generateVerifyCode() {
  let s = ''
  for (let i = 0; i < VERIFY_CODE_LEN; i++) s += String(randomInt(0, 10))
  return s
}

/** 团队 id：**不透明**标识（§5.9：不写可见语义）——随机 hex，不含团队名/时间等可推测信息。 */
export function generateTeamId() {
  return `t_${randomBytes(8).toString('hex')}`
}

/** 成员 id：`u_` + 随机 hex（可读前缀 + 无碰撞空间）。 */
export function generateMemberId() {
  return `u_${randomBytes(4).toString('hex')}`
}

/** 设备 id：日志文件名 `log-<deviceId>.jsonl` 用（§7.2）。 */
export function generateDeviceId() {
  return `d_${randomBytes(4).toString('hex')}`
}

/** 团队密钥（32 字节随机）。**只出现在信封里**，永不写入 `team.json`。 */
export function generateTeamKey() {
  return randomBytes(TEAM_KEY_BYTES)
}

/** 规范化数字码输入（容忍用户输入空格/连字符；非数字长度不符 → null）。 */
export function normalizeCode(raw, len) {
  const s = String(raw ?? '').replace(/[\s-]/g, '')
  if (!new RegExp(`^\\d{${len}}$`).test(s)) return null
  return s
}

// ---------------------------------------------------------------------------
// Ed25519 密钥对与指纹
// ---------------------------------------------------------------------------

/**
 * 生成成员签名密钥对（Ed25519）。导出为 DER base64 —— 便于落盘进 JSON，且不带 PEM 头尾噪声。
 * 私钥落在**本机**（§5.9 诚实边界：防的是"改共享目录里的清单"，不防"拿到本机的人"）。
 */
export function generateMemberKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

/**
 * 密钥指纹：sha256(公钥 DER) 的**前 16 个 hex 字符，4 字符一组**（§5.9 指定的展示形式）。
 * 分组的理由：指纹是给人**核对**的（念出来、对照截图），连续 16 位一串极易读错。
 */
export function fingerprint(publicKeyBase64) {
  const h = createHash('sha256').update(Buffer.from(String(publicKeyBase64), 'base64')).digest('hex')
  const head = h.slice(0, 16)
  return head.replace(/(.{4})(?=.)/g, '$1-')
}

/** 用成员私钥对文本签名（Ed25519，返回 base64）。 */
export function signText(text, privateKeyBase64) {
  const key = createPrivateKey({ key: Buffer.from(String(privateKeyBase64), 'base64'), format: 'der', type: 'pkcs8' })
  return cryptoSign(null, Buffer.from(String(text), 'utf-8'), key).toString('base64')
}

/** 校验签名。任何异常（公钥格式坏、签名坏）一律返回 false —— 验签的失败语义就是"不可信"。 */
export function verifyText(text, signatureBase64, publicKeyBase64) {
  try {
    const key = createPublicKey({ key: Buffer.from(String(publicKeyBase64), 'base64'), format: 'der', type: 'spki' })
    return cryptoVerify(null, Buffer.from(String(text), 'utf-8'), key, Buffer.from(String(signatureBase64), 'base64'))
  } catch {
    return false
  }
}

/** 公钥到指纹的映射表构建（多副本重放时按成员 id 查公钥）。 */
export function fingerprintOf(publicKeyBase64) {
  return fingerprint(publicKeyBase64)
}

/** 常数时间比较（用于指纹/码的相等判断，避免时序侧信道）。长度不同直接 false（不 leak 长度以外信息）。 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf-8')
  const bb = Buffer.from(String(b ?? ''), 'utf-8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// ---------------------------------------------------------------------------
// scrypt 密钥派生 + AEAD 信封
// ---------------------------------------------------------------------------

/**
 * 由验证码派生信封密钥（scrypt，N=2^15）。
 * `maxmem` 必须显式给足：N=2^15/r=8 需要 128*N*r = 32 MiB，正好等于 Node 默认 maxmem 上限，
 * 不给就会抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`（这是个很容易踩、且报错信息不直观的坑）。
 */
export function deriveEnvelopeKey(code, saltBase64) {
  return scryptSync(String(code), Buffer.from(String(saltBase64), 'base64'), SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2,
  })
}

/** AEAD 加密（AES-256-GCM）。AAD 绑定元数据，使"换绑到别的团队/成员"会导致解密失败。 */
export function aeadSeal(plainBuf, keyBuf, aad) {
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyBuf, nonce)
  if (aad) c.setAAD(Buffer.from(String(aad), 'utf-8'))
  const ct = Buffer.concat([c.update(plainBuf), c.final()])
  return { nonce: nonce.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') }
}

/** AEAD 解密；认证失败返回 null（调用方据此判"验证码错误/内容被改"）。 */
export function aeadOpen(sealed, keyBuf, aad) {
  try {
    const d = createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(sealed.nonce, 'base64'))
    if (aad) d.setAAD(Buffer.from(String(aad), 'utf-8'))
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64')), d.final()])
  } catch {
    return null
  }
}

/**
 * 生成成员信封内容（写进 `keys/<memberId>.env`）。
 *
 * 信封内是**团队密钥**（32 字节随机，团队级共享），不是成员私钥 —— 成员私钥只在本机使用、从不出门。
 * `expiresAt` 与 `salt` 都写进**信封外层明文**：前者供加入方**先判断过期再决定是否尝试**（避免白算一次
 * scrypt），后者必须公开（解密方需要它派生同一密钥）；二者公开都不降低安全性（盐不是秘密）。
 */
export function sealTeamKeyEnvelope({ teamKey, code, memberId, teamId, ttlMs = ENVELOPE_TTL_MS, now = Date.now() }) {
  const salt = randomBytes(16)
  const key = deriveEnvelopeKey(code, salt.toString('base64'))
  const aad = `${teamId}\u0000${memberId}`
  const sealed = aeadSeal(Buffer.from(teamKey), key, aad)
  return JSON.stringify({
    v: ENVELOPE_VERSION,
    kind: 'team-key',
    teamId,
    memberId,
    salt: salt.toString('base64'),
    scrypt: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, keylen: SCRYPT_PARAMS.keylen },
    nonce: sealed.nonce,
    ct: sealed.ct,
    tag: sealed.tag,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  })
}

/**
 * 解信封。返回 `{ ok:true, teamKey }` 或 `{ ok:false, reason }`。
 *
 * 失败原因**逐项区分**（不笼统报"打不开"）：`malformed`（结构/版本不对）、`team-mismatch`
 * （信封不属于这个团队）、`expired`（过期，**先于**尝试解密判断 ⇒ 不浪费一次 scrypt）、
 * `bad-code`（AEAD 认证失败 = 验证码错误**或**信封被篡改，二者在密码学上不可区分 —— 如实合并为一个原因）。
 * 一次性作废**不在此函数判定**：那要读 members 日志（I/O），属 `kernel/team-store.mjs` 的编排职责。
 */
export function openTeamKeyEnvelope(raw, { code, teamId, now = Date.now() } = {}) {
  const normalized = normalizeCode(code, VERIFY_CODE_LEN)
  if (!normalized) return { ok: false, reason: 'bad-code-format' }
  let env = null
  try {
    env = JSON.parse(String(raw))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!env || env.kind !== 'team-key' || env.v !== ENVELOPE_VERSION) return { ok: false, reason: 'malformed' }
  if (teamId && env.teamId !== teamId) return { ok: false, reason: 'team-mismatch' }
  const exp = Date.parse(String(env.expiresAt || ''))
  if (Number.isFinite(exp) && now > exp) return { ok: false, reason: 'expired' }
  const key = deriveEnvelopeKey(normalized, env.salt)
  const aad = `${env.teamId}\u0000${env.memberId}`
  const plain = aeadOpen({ nonce: env.nonce, ct: env.ct, tag: env.tag }, key, aad)
  if (!plain) return { ok: false, reason: 'bad-code' }
  return { ok: true, teamKey: plain, memberId: env.memberId, teamId: env.teamId, expiresAt: env.expiresAt || null }
}
