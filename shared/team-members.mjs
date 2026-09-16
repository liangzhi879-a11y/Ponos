// shared/team-members.mjs —— S3 成员清单：**签名哈希链的唯一实现**（纯函数，无 IO）。
//
// 依据 spec §5.9「成员清单防篡改（定案 16）」：每设备一条**追加式日志**，形如
//   members/log-<deviceId>.jsonl
//   {"seq":1,"op":"add","memberId":"u_7f3a","role":"editor","by":"<owner指纹>","ts":…,"prev":"<上一行哈希>","sig":"…"}
// 每行含 `prev`（上一行哈希）+ `sig`（操作者 Ed25519 私钥签名）⇒ 改一行、删一行、插一行都会被发现；
// 且**每台设备各存一份**，所以删掉共享目录里某个文件也能从别处复原。复用 `kernel/workflow-engine.mjs`
// 的哈希链形态（`prev='-'` 为创世）。
//
// 【为什么存续记录必须签名，而不仅是哈希链】哈希链只能防"改动历史中的某一行"（因为后续行的 `prev`
// 对不上）——但它防不了**插入伪造行**：攻击者知道前一行的哈希（那是公开的），照抄即可让 `prev` 自洽。
// 真正挡住插入的是 `sig`：没有成员私钥就签不出来。反之，若只有签名没有链，则**删除整行**不会被发现
// （每行签名各自有效）。**两者缺一不可**，这是本文件同时维护 `prev` 与 `sig` 的原因。

import { createHash } from 'node:crypto'
import { signText, verifyText, generateMemberId, fingerprint } from './team-crypto.mjs'

/** 创世哨兵（与 `kernel/workflow-engine.mjs` 的形态保持一致）。 */
export const GENESIS_PREV = '-'
export const MEMBER_LOG_VERSION = 1

/**
 * 规范化 JSON：**递归按键名排序**。
 *
 * 为什么必须做：哈希的输入必须是"同一份内容永远得到同一个字节序列"。若直接用 `JSON.stringify`，
 * 一旦有工具（格式化器、别的语言的解析器、手工编辑）改变了键的顺序，哈希就会变，于是**没被篡改的
 * 记录会被误报为篡改**——这种"假警报"比漏报更糟：它会让用户不再相信告警。
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}

/**
 * 单行哈希。
 *
 * **排除 `sig` 字段**再哈希，原因有二：
 * ① 链的语义是"内容链"——`prev` 应只依赖内容，这样签名算法/密钥轮换（将来）不会把链打断；
 * ② 否则"校验链"与"校验签名"两件事会耦合，排障时分不清是内容被改还是签名被换。
 */
export function hashRecord(rec) {
  const { sig, ...rest } = rec || {}
  return createHash('sha256').update(canonicalJson(rest), 'utf-8').digest('hex')
}

/** 计算某行的 `next prev`（= 该行哈希）。 */
export function nextPrev(rec) {
  return hashRecord(rec)
}

/**
 * 追加一条成员操作。`records` 为该设备日志的既有记录数组（可为空 = 新日志）。
 *
 * 返回**新记录**（不改动 `records`）——纯函数，便于测"同一序列必然产出同一链"，也避免调用方
 * 因意外共享引用而写出半截链。
 */
export function appendMemberOp(records, op, { privateKey, by, ts = Date.now(), extra = {} } = {}) {
  const list = Array.isArray(records) ? records : []
  const last = list.length ? list[list.length - 1] : null
  const seq = (last && Number(last.seq)) ? Number(last.seq) + 1 : 1
  const rec = {
    v: MEMBER_LOG_VERSION,
    seq,
    op: String(op),
    by: String(by || ''),
    ts: new Date(ts).toISOString(),
    prev: last ? nextPrev(last) : GENESIS_PREV,
    ...extra,
  }
  // 签名覆盖"含 prev 的完整内容"⇒ 既锁内容也锁位置（换位置会破坏 prev 从而破坏签名）
  rec.sig = signText(canonicalJson(rec), privateKey)
  return rec
}

/**
 * 校验单条链。返回 `{ ok, errors }`，errors 逐项给出 `{ index, seq, reason, detail }`。
 *
 * 三类攻击**分别可辨**（不笼统报"链坏了"）——用户需要知道"被改了"还是"被删了"还是"被塞了"：
 * - `bad-signature`：该行签名验不过 ⇒ 内容被改，或整行是伪造插入（没有成员私钥）。
 * - `bad-prev`：该行的 `prev` 与其前一行实际哈希不符 ⇒ 前面有行被删除/插入/改动。
 * - `bad-seq`：序号不是自 1 连续递增 ⇒ 有行被删（prev 可能因整段重放而看似自洽）。
 * `resolvePubKey(by)` 返回该操作者的公钥 base64；返回 `null`/`undefined` 表示"缺公钥"⇒
 * 记为 `unknown-signer`（**不当作通过**，也不当作篡改：可能是成员公钥尚未同步到位）。
 */
export function verifyMemberChain(records, { resolvePubKey } = {}) {
  const list = Array.isArray(records) ? records : []
  const errors = []
  let prevHash = GENESIS_PREV
  for (let i = 0; i < list.length; i++) {
    const rec = list[i] || {}
    if (rec.prev !== prevHash) {
      errors.push({ index: i, seq: rec.seq ?? null, reason: 'bad-prev', detail: `期望 ${prevHash.slice(0, 12)}…，实为 ${String(rec.prev).slice(0, 12)}…` })
    }
    const wantSeq = i + 1
    if (Number(rec.seq) !== wantSeq) {
      errors.push({ index: i, seq: rec.seq ?? null, reason: 'bad-seq', detail: `期望 seq=${wantSeq}` })
    }
    const pub = typeof resolvePubKey === 'function' ? resolvePubKey(rec.by) : null
    if (!pub) {
      errors.push({ index: i, seq: rec.seq ?? null, reason: 'unknown-signer', detail: `缺 ${rec.by || '(空)'} 的公钥` })
    } else {
      const { sig, ...rest } = rec
      if (!verifyText(canonicalJson(rest), sig, pub)) {
        errors.push({ index: i, seq: rec.seq ?? null, reason: 'bad-signature', detail: `${rec.by} 的签名验不过` })
      }
    }
    prevHash = nextPrev(rec)
  }
  return { ok: errors.length === 0, errors, count: list.length }
}

/**
 * 多副本重放：把同一逻辑日志的多个副本（含网盘冲突副本）**去重合并**后按**时间序**排序。
 *
 * 去重键 `(by, seq)`：`by` 区分设备、`seq` 区分该设备内的位置 ⇒ 同一行在多个副本里必然同键，
 * 而不同设备的同行 seq 不会被误合并。冲突副本可能含有原文件缺的记录（网盘同步的中间态），
 * 所以必须**并集**而不是"谁新用谁"。
 *
 * 【排序为什么必须以 `ts` 为主键 —— 这是个被实测抓出来的真缺陷】
 * 首版按 `(by, seq)` 排序，即**顺序由"指纹的字典序"决定**。但 `seq` 只在**单个设备内**有意义，
 * 跨设备之间它不构成全序：当"设备 B 的 add"恰好排在"设备 A 的 revoke"之后时，`replayMembers`
 * 的 `add` 分支会把已移除的成员**覆盖回 active**。这直接导致真机回归网时红时绿
 * （`server/team-routes.test.mjs` 3 轮 2 红，复现探针 40 次里 24 次错）。
 * 修法：以 `ts`（ISO 8601，字符串字典序 = 时间序）为主键；`ts` 相同（真并发/同毫秒）时再用
 * `(by, seq)` 兜底，保证结果**仍然确定**（不会因进程调度而变）。
 * 无效/缺失 `ts` 视为 `0`（排最前），使坏数据不会插到中间制造错误因果。
 */
export function mergeMemberLogCopies(copies) {
  const seen = new Map()
  for (const c of copies || []) {
    for (const rec of (c && Array.isArray(c.records) ? c.records : [])) {
      const key = `${String(rec.by)}\u0000${String(rec.seq)}`
      if (!seen.has(key)) seen.set(key, rec)
    }
  }
  const tsKey = (rec) => {
    const t = Date.parse(String((rec && rec.ts) || ''))
    return Number.isFinite(t) ? t : 0
  }
  return Array.from(seen.values()).sort((a, b) => {
    const d = tsKey(a) - tsKey(b)
    if (d !== 0) return d
    // 同毫秒（真并发）：用码元序兜底 —— 结果确定即可，谁先谁后在此场景下本就无客观答案
    if (a.by !== b.by) return String(a.by) < String(b.by) ? -1 : 1
    return Number(a.seq) - Number(b.seq)
  })
}

/**
 * 由重放后的记录推导**成员状态**（当前成员表）。
 *
 * 支持的 op：`add`（加入）、`role`（改角色）、`revoke`（移除/作废）。**未知 op 忽略**（向前兼容：
 * 将来新增 op 时，旧版本客户端不会因此崩掉或把成员表算错）。
 *
 * **关键区分**：`op:'revoke'` 有两种靶子 —— `scope:'invite'` 表示"作废一个**邀请信封**"
 * （§5.9 的一次性用后即焚），它**不是**成员移除。若不加区分，刚用验证码加入的人会在同一步里
 * 被自己写下的"revoked 记录"立刻踢出成员表。成员移除是**不带** `scope:'invite'` 的 revoke。
 * 返回按 memberId 排序的数组，便于稳定断言。
 */
export function replayMembers(records) {
  const byId = new Map()
  for (const rec of records || []) {
    const id = rec && rec.memberId ? String(rec.memberId) : null
    if (!id) continue
    const cur = byId.get(id) || { memberId: id, role: null, publicKey: null, status: 'active', addedAt: null, revokedAt: null, fingerprint: null }
    switch (rec.op) {
      case 'add':
        cur.status = 'active'
        cur.role = rec.role || cur.role
        cur.publicKey = rec.publicKey || cur.publicKey
        cur.addedAt = rec.ts || cur.addedAt
        break
      case 'role':
        cur.role = rec.role || cur.role
        break
      case 'revoke':
        if (rec.scope === 'invite') break // 作废的是邀请信封，不是成员
        cur.status = 'revoked'
        cur.revokedAt = rec.ts || cur.revokedAt
        break
      default:
        break // 未知 op：忽略（向前兼容）
    }
    if (cur.publicKey) cur.fingerprint = fingerprint(cur.publicKey)
    byId.set(id, cur)
  }
  return Array.from(byId.values()).sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0))
}

/**
 * 已作废的**邀请信封**（一次性凭据的消费记录）。
 * 返回 `Set<memberId>`：加入流程据此拒绝"同一个验证码用第二次"。
 * 与 `replayMembers` 共用同一份记录集，保证"谁被邀请过/谁已加入/哪个邀请已用过"三者口径一致。
 */
export function consumedInvites(records) {
  const out = new Set()
  for (const rec of records || []) {
    if (rec && rec.op === 'revoke' && rec.scope === 'invite' && rec.memberId) out.add(String(rec.memberId))
  }
  return out
}

/**
 * 从成员表构建 `resolvePubKey`（供 `verifyMemberChain` 用）。
 *
 * **键必须是"指纹"而不是 memberId**：记录里的 `by` 存的是**操作者指纹**（§5.9 的示例
 * `"by":"<owner指纹>"`），不是成员 id。这里曾按 memberId 建表 ⇒ 解析恒 miss、所有记录都被报
 * `unknown-signer`（这个 bug 被首轮冒烟抓出来，故在此写明原因，避免后来者"顺手改回 memberId"）。
 * 同时注册 memberId 作为备用键：便于接受"某些历史记录用 memberId 充当 by"的变体，不改变主路径语义。
 *
 * `revoke` 之后仍保留公钥：**作废的是"今后的写入权"，不是"历史记录的签名有效性"**——
 * 否则一个成员被移除后，他当年签过的合法记录会集体变成"验不过"，把历史判成篡改。
 */
export function pubKeyResolver(members) {
  const map = new Map()
  for (const m of members || []) {
    if (!m || !m.publicKey) continue
    if (m.fingerprint) map.set(String(m.fingerprint), m.publicKey)
    if (m.memberId) map.set(String(m.memberId), m.publicKey)
  }
  return (by) => map.get(String(by)) || null
}

/** 便捷：把"添加成员"写成一条记录（`by` = 操作者指纹，成员 id 由调用方传入或自动生成）。 */
export function addMemberOp(records, { memberId, role = 'editor', publicKey, by, privateKey, ts, extra } = {}) {
  return appendMemberOp(records, 'add', {
    privateKey, by, ts, extra: { memberId: memberId || generateMemberId(), role, publicKey, ...(extra || {}) },
  })
}

/**
 * 便捷：把"作废"写成一条记录。
 *
 * `scope` **必须走显式参数**（不能只靠 `extra` 传）：调用方很容易写成 `revokeMemberOp(log, {memberId, scope:'invite'})`
 * 而 `scope` 悄悄丢失 —— 那样"作废邀请"会被重放理解成"移除成员"，于是**刚用验证码加入的人会在同一步里
 * 被自己写下的记录踢出成员表**。这个坑在 S3 首次回归网里被实测抓到过，故在此做成显式形参。
 * - `scope:'invite'` ⇒ 作废的是**邀请信封**（一次性用后即焚）；
 * - 省略 `scope` ⇒ 作废的是**成员**（移除）。
 */
export function revokeMemberOp(records, { memberId, scope = null, by, privateKey, ts, extra } = {}) {
  return appendMemberOp(records, 'revoke', {
    privateKey, by, ts, extra: { memberId, ...(scope ? { scope } : {}), ...(extra || {}) },
  })
}
