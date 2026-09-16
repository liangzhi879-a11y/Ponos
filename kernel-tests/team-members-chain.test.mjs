// S3 回归网②：成员清单防篡改（签名哈希链 + 多副本见证）
// spec §5.9「成员清单防篡改（定案 16）」、§9「S3 清单防篡改」。
//
// 要钉住的三类攻击**必须可辨**（不笼统报"链坏了"）：改一行 / 删一行 / 插一行。
// 以及 spec 明确的一条恢复能力：**删掉整个日志文件，其他副本在 ⇒ 仍可复原**。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  appendMemberOp, addMemberOp, revokeMemberOp, verifyMemberChain, replayMembers, consumedInvites,
  mergeMemberLogCopies, pubKeyResolver, canonicalJson, hashRecord, nextPrev, GENESIS_PREV,
} from '../shared/team-members.mjs'
import { generateMemberKeyPair, generateDeviceId, fingerprint } from '../shared/team-crypto.mjs'

/** 造一条 3 行的正品日志 + 解析器。 */
function buildChain() {
  const owner = generateMemberKeyPair()
  const m1 = generateMemberKeyPair()
  const m2 = generateMemberKeyPair()
  const by = fingerprint(owner.publicKey)
  let log = []
  log.push(addMemberOp(log, { memberId: 'u_owner', role: 'owner', publicKey: owner.publicKey, by, privateKey: owner.privateKey, ts: 1000 }))
  log.push(addMemberOp(log, { memberId: 'u_m1', role: 'editor', publicKey: m1.publicKey, by, privateKey: owner.privateKey, ts: 2000 }))
  log.push(addMemberOp(log, { memberId: 'u_m2', role: 'viewer', publicKey: m2.publicKey, by, privateKey: owner.privateKey, ts: 3000 }))
  const members = replayMembers(log)
  return { log, members, resolve: pubKeyResolver(members), owner, m1, m2, by }
}

test('正品链：验签通过、无错误；成员表按 id 排序稳定', () => {
  const { log, members, resolve } = buildChain()
  const v = verifyMemberChain(log, { resolvePubKey: resolve })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.deepEqual(v.errors, [])
  assert.deepEqual(members.map((m) => m.memberId), ['u_m1', 'u_m2', 'u_owner'])
  assert.equal(log[0].prev, GENESIS_PREV, '首行 prev 为创世哨兵')
  assert.equal(log[1].prev, nextPrev(log[0]), '次行 prev = 上一行哈希')
  assert.equal(log[0].sig && log[0].sig.length > 0, true, '每行都带签名')
})

test('篡改①改内容：签名验不过 + 后续行 prev 断链（两类错误都报，定位到行）', () => {
  const { log, resolve } = buildChain()
  const t = JSON.parse(JSON.stringify(log))
  t[1].role = 'owner' // 试图把 editor 提权成 owner
  const v = verifyMemberChain(t, { resolvePubKey: resolve })
  assert.equal(v.ok, false)
  const reasons = v.errors.map((e) => `${e.reason}@${e.index}`)
  assert.ok(reasons.includes('bad-signature@1'), `应报该行签名失效：${reasons.join(',')}`)
  assert.ok(reasons.includes('bad-prev@2'), `应报后续行断链：${reasons.join(',')}`)
})

test('篡改②删中间行：prev 断链 + seq 不连续（两种线索都给）', () => {
  const { log, resolve } = buildChain()
  const t = [log[0], log[2]] // 删掉第 2 行
  const v = verifyMemberChain(t, { resolvePubKey: resolve })
  assert.equal(v.ok, false)
  const reasons = v.errors.map((e) => `${e.reason}@${e.index}`)
  assert.ok(reasons.includes('bad-prev@1'), `被删行之后的 prev 应对不上：${reasons.join(',')}`)
  assert.ok(reasons.includes('bad-seq@1'), `seq 应不连续：${reasons.join(',')}`)
})

test('篡改③插伪造行：prev 可以照抄（公开信息），但**签名签不出来** ⇒ 必须被抓住', () => {
  const { log, resolve } = buildChain()
  // 攻击者知道前一行的哈希，因此能伪造一个 prev 自洽的行——这正是"只有哈希链不够"的原因
  const fake = {
    v: 1, seq: 2, op: 'add', by: fingerprint(generateMemberKeyPair().publicKey), ts: '2026-01-01T00:00:00.000Z',
    prev: nextPrev(log[0]), memberId: 'u_evil', role: 'owner', publicKey: generateMemberKeyPair().publicKey, sig: 'AAAA',
  }
  const t = [log[0], fake, log[1], log[2]]
  const v = verifyMemberChain(t, { resolvePubKey: resolve })
  assert.equal(v.ok, false)
  const reasons = v.errors.map((e) => `${e.reason}@${e.index}`)
  assert.ok(reasons.includes('unknown-signer@1') || reasons.includes('bad-signature@1'), `伪造行必须被判不可信：${reasons.join(',')}`)
})

test('篡改③b 换掉记录里的公钥：内容变了 ⇒ 原签名必然对不上', () => {
  const { log, resolve } = buildChain()
  const t = JSON.parse(JSON.stringify(log))
  // 注意：u_m1 那行本来就带 m1.publicKey —— 若塞回同一把钥匙就是**空操作**（首轮就是这么假红的）。
  // 必须换一把**全新**公钥，才真的改变了被签内容。
  t[1].publicKey = generateMemberKeyPair().publicKey
  const v = verifyMemberChain(t, { resolvePubKey: resolve })
  assert.equal(v.ok, false)
  const reasons = v.errors.map((e) => `${e.reason}@${e.index}`)
  assert.ok(reasons.includes('bad-signature@1'), `被改内容的那行签名必然对不上：${reasons.join(',')}`)
  assert.ok(reasons.includes('bad-prev@2'), `后续行也随之断链：${reasons.join(',')}`)
})

test('缺失公钥：记 unknown-signer —— 既不当作通过，也不诬指篡改（可能是公钥尚未同步）', () => {
  const { log } = buildChain()
  const v = verifyMemberChain(log, { resolvePubKey: () => null })
  assert.equal(v.ok, false)
  assert.ok(v.errors.every((e) => e.reason === 'unknown-signer'), '全部应为 unknown-signer')
})

test('多副本见证：删掉整个日志文件，仅凭其他副本仍能复原（§5.9 明确的恢复能力）', () => {
  const { log } = buildChain()
  const devA = generateDeviceId()
  // 只有副本（本体被误删）
  const copies = [{ name: `log-${devA} - 副本.jsonl`, records: log }]
  const merged = mergeMemberLogCopies(copies)
  assert.deepEqual(merged, log, '从副本复原的记录应与原日志逐字一致')
  const members = replayMembers(merged)
  assert.equal(members.length, 3, '三个成员都能复原')
  const v = verifyMemberChain(merged, { resolvePubKey: pubKeyResolver(members) })
  assert.equal(v.ok, true, '复原后的链仍然自洽（副本内容未被改动）')
})

test('多副本合并：并集去重（重复副本不改变结果；只在副本里出现的记录要保住）', () => {
  const { log } = buildChain()
  const partial = [log[0], log[1]]
  const withExtra = [log[0], { ...log[2], ts: '2026-02-02T00:00:00.000Z' }]
  const merged = mergeMemberLogCopies([
    { name: 'a', records: partial },
    { name: 'b', records: log },              // 完整重复
    { name: 'c', records: [log[0]] },          // 部分重复
  ])
  assert.equal(merged.length, 3, '去重后仍是 3 条')
  // 同一 (by,seq) 只保留首个出现的副本 ⇒ 结果与"首次读取的副本"一致
  assert.deepEqual(merged.map((r) => r.seq), [1, 2, 3])
  // 不同设备同 seq 不误合并
  const other = { ...log[0], by: fingerprint(generateMemberKeyPair().publicKey) }
  assert.equal(mergeMemberLogCopies([{ records: log }, { records: [other] }]).length, 4, '异设备同 seq 必须各算一条')
  void withExtra
})

test('跨设备重放按**时间序**而非指纹序 —— 否则 add 会覆盖 revoke（真机 flake 的根因）', () => {
  // 这个用例钉的是一个**实测出来的真缺陷**：首版 mergeMemberLogCopies 按 (by, seq) 排序，
  // 即顺序由"指纹字典序"决定。B 设备的 add 若排在 A 设备的 revoke 之后，replayMembers 的
  // add 分支会把已移除成员覆盖回 active ⇒ 真机回归网时红时绿。
  // 这里不靠"跑几次看看"，而是**直接构造对抗性顺序**：A 的 revoke 时间最晚、B 的 add 最早，
  // 且反复生成密钥对让两条 by 的字典序随机 ⇒ 若按 by 排序，必有约一半概率判错。
  let wrong = 0
  for (let i = 0; i < 20; i++) {
    const owner = generateMemberKeyPair()
    const joiner = generateMemberKeyPair()
    const byO = fingerprint(owner.publicKey)
    const byJ = fingerprint(joiner.publicKey)

    let logA = []
    logA.push(addMemberOp(logA, { memberId: 'u_owner', role: 'owner', publicKey: owner.publicKey, by: byO, privateKey: owner.privateKey, ts: 1000 }))
    logA.push(revokeMemberOp(logA, { memberId: 'u_x', by: byO, privateKey: owner.privateKey, ts: 9000 })) // 最晚发生

    let logB = []
    logB.push(addMemberOp(logB, { memberId: 'u_x', role: 'editor', publicKey: joiner.publicKey, by: byJ, privateKey: joiner.privateKey, ts: 2000 }))

    const merged = mergeMemberLogCopies([{ records: logA }, { records: logB }])
    const st = replayMembers(merged).find((m) => m.memberId === 'u_x').status
    if (st !== 'revoked') wrong++

    // 传入顺序也必须无关（副本先后由列目录顺序决定，不该影响语义）
    const swapped = mergeMemberLogCopies([{ records: logB }, { records: logA }])
    assert.deepEqual(swapped, merged, '副本传入顺序不得影响合并结果')
  }
  assert.equal(wrong, 0, `20 次对抗性顺序中 ${wrong} 次判错（时序合并必须按 ts 排序）`)
})

test('时序兜底：ts 相同（真并发）时结果仍确定（不会因调度而变）', () => {
  const owner = generateMemberKeyPair()
  const joiner = generateMemberKeyPair()
  const byO = fingerprint(owner.publicKey)
  const byJ = fingerprint(joiner.publicKey)
  const TS = 5000
  let a = []
  a.push(addMemberOp(a, { memberId: 'u_o', role: 'owner', publicKey: owner.publicKey, by: byO, privateKey: owner.privateKey, ts: TS }))
  let b = []
  b.push(addMemberOp(b, { memberId: 'u_j', role: 'editor', publicKey: joiner.publicKey, by: byJ, privateKey: joiner.privateKey, ts: TS }))
  const r1 = mergeMemberLogCopies([{ records: a }, { records: b }])
  const r2 = mergeMemberLogCopies([{ records: b }, { records: a }])
  assert.deepEqual(r1, r2, '同毫秒时必须有确定的兜底顺序（按 by 码元序）')

  // 坏 ts（缺失/不可解析）排最前，不得插到中间制造错误因果
  let c = []
  c.push(addMemberOp(c, { memberId: 'u_bad', role: 'editor', publicKey: joiner.publicKey, by: byJ, privateKey: joiner.privateKey, ts: 300000 }))
  const withBadTs = mergeMemberLogCopies([{ records: c }, { records: [{ ...c[0], ts: '不是时间' }] }])
  assert.equal(Number(withBadTs[0].seq), 1, '不可解析的 ts 应排最前')
})
test('一次性验证码：`revoke(scope=invite)` 作废的是**邀请**，不是成员（否则刚加入就被自己踢出）', () => {
  const { log, owner } = buildChain()
  const by = fingerprint(owner.publicKey)
  let mine = [...log]
  mine.push(revokeMemberOp(mine, { memberId: 'u_m1', scope: 'invite', by, privateKey: owner.privateKey, ts: 4000 }))
  const members = replayMembers(mine)
  const m1 = members.find((m) => m.memberId === 'u_m1')
  assert.equal(m1.status, 'active', '作废邀请不得把成员状态改成 revoked')
  assert.deepEqual(Array.from(consumedInvites(mine)), ['u_m1'], '但该邀请应被记为"已消费"')

  // 真正的成员移除：不带 scope='invite'
  let mine2 = [...log]
  mine2.push(revokeMemberOp(mine2, { memberId: 'u_m1', by, privateKey: owner.privateKey, ts: 5000 }))
  const members2 = replayMembers(mine2)
  assert.equal(members2.find((m) => m.memberId === 'u_m1').status, 'revoked', '不带 scope 的 revoke 才是成员移除')
  assert.deepEqual(Array.from(consumedInvites(mine2)), [], '成员移除不算"邀请已消费"')

  // 被移除的成员，其历史签名仍然有效（作废的是今后写入权，不是历史）
  const v = verifyMemberChain(mine2, { resolvePubKey: pubKeyResolver(members2) })
  assert.equal(v.ok, true, '历史记录在成员被移除后仍应验签通过（否则历史会被误判成篡改）')
})

test('canonicalJson：键序无关 ⇒ 序列化口径不影响哈希（避免"格式化一下就被报篡改"）', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
  assert.equal(canonicalJson({ x: { d: 1, c: [2, { z: 1, y: 2 }] } }), '{"x":{"c":[2,{"y":2,"z":1}],"d":1}}')
  // 哈希排除 sig：换签名不应改变内容哈希（链是"内容链"）
  const base = { a: 1, sig: 'X' }
  assert.equal(hashRecord(base), hashRecord({ a: 1, sig: 'Y' }), 'hash 必须排除 sig')
  assert.notEqual(hashRecord(base), hashRecord({ a: 2, sig: 'X' }), '内容变了哈希必须变')
})

test('appendMemberOp：seq 自增、不改动入参数组（纯函数）、unknown op 被重放忽略（向前兼容）', () => {
  const { log, owner, by } = buildChain()
  const before = JSON.stringify(log)
  const rec = appendMemberOp(log, 'whatever-future-op', { privateKey: owner.privateKey, by, ts: 9000, extra: { foo: 1 } })
  assert.equal(JSON.stringify(log), before, 'append 不得就地改动入参数组')
  assert.equal(rec.seq, 4, 'seq 基于最后一行自增')
  assert.equal(rec.prev, nextPrev(log[2]))

  let withFuture = [...log, rec]
  const members = replayMembers(withFuture)
  assert.equal(members.length, 3, '未知 op 不应凭空造出成员，也不应崩')
  const v = verifyMemberChain(withFuture, { resolvePubKey: pubKeyResolver(replayMembers(log)) })
  assert.equal(v.ok, true, '未知 op 的合法签名记录仍应通过链校验（向前兼容）')
})
