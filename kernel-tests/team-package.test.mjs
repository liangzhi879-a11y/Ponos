// S3 补齐回归网：`.yfwteam` 邀请包（spec §5.9 定案 17 / §10 验收 5）
//
// spec §10 验收 5 原文：「`.yfwteam` 邀请包仍可用（兜底路径），拖入即完成配置。」
// 本文件测四类东西，每一类都对应一个**真实会出事**的场景：
//   ① 格式与指纹：包被改过（改验证码/改目录/改团队）必须被发现，且与"文件不完整"可区分；
//   ② 兜底寻址：**没有搜索根**也能加入（这正是该包存在的理由）；
//   ③ 一次性：同一个包换机器再导入仍必须失败（判定落在团队源，不落本机）；
//   ④ 措辞：不得暗示"加密/仅受邀可读"（§5.9/§11 的红线，与 team-join.test.mjs 同口径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTeam, exportInvite, exportTeamPackage, importTeamPackage, joinTeam, verifyTeamSource, loadTeamConfig } from '../kernel/team-store.mjs'
import { openTeamSource } from '../shared/team-source.mjs'
import {
  buildTeamPackage, parseTeamPackage, packFingerprint, teamPackFilename,
  TEAM_PACK_FORMAT, TEAM_PACK_SCHEMA_VERSION, TEAM_PACK_EXT,
} from '../shared/team-package.mjs'

function tmp(prefix) { return mkdtempSync(join(tmpdir(), prefix)) }
function cleanup(p) {
  for (let i = 0; i < 8; i++) {
    try { rmSync(p, { recursive: true, force: true }); return } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

/** 造一套"创建者 + 团队源"。**刻意不设搜索根**：兜底路径的关键就是它不依赖搜索根。 */
function setup(prefix) {
  const workspace = tmp(prefix)
  const ownerCfg = join(workspace, 'owner-appdata')
  const searchRoot = join(workspace, '网盘', '搜索根')
  const dir = join(searchRoot, '团队-甲')
  mkdirSync(searchRoot, { recursive: true })
  const created = createTeam({ configDir: ownerCfg, name: '甲团队', dir, identCode: '123456789' })
  assert.equal(created.ok, true)
  return { workspace, ownerCfg, searchRoot, dir, created }
}

// ---------------------------------------------------------------------------
// ① 格式与指纹（纯规则，零 IO）
// ---------------------------------------------------------------------------

// ★ 2026-09-29 还债：原先这里写死 `Date.parse('2026-09-17T00:00:00.000Z')`，
//   而 `parseTeamPackage` 用**真实时钟**校验 TTL ⇒ 过了有效期后本测试必然变红
//   （典型的"时间炸弹"：代码没改、测试自己变红）。这也是一种**真实缺陷**——
//   它会长期挂着一条红灯，掩盖真正的新回归。改为相对当下 ⇒ 永远是一份"新鲜的合法包"。
//   （另有独立的过期用例，用显式 `expiresAt: '2020-01-01'` 验证过期路径，那个是**有意为之**。）
const goodPack = () => buildTeamPackage({
  manifest: { teamId: 't_abc123', name: '甲团队', identCode: '123456789', salt: 's', scrypt: { N: 2 ** 15 } },
  memberId: 'u_x', code: '739204', envelope: '{"kind":"team-key"}',
  sourceDir: 'Z:/团队-甲', now: Date.now(),
})

test('包格式：同族命名与扩展名（`.yfwflow` → `.yfwteam`），且组装后自带指纹', () => {
  const pack = goodPack()
  assert.equal(pack.format, TEAM_PACK_FORMAT)
  assert.equal(TEAM_PACK_FORMAT, 'yfworking-team')
  assert.equal(pack.schemaVersion, TEAM_PACK_SCHEMA_VERSION)
  assert.equal(TEAM_PACK_EXT, '.yfwteam')
  assert.match(pack.fingerprint, /^sha256:[0-9a-f]{64}$/)
  assert.equal(pack.fingerprint, packFingerprint(pack))
  // 组装 → 解析 必须原样往返（否则导出方与导入方看到的不是同一个包）
  const r = parseTeamPackage(JSON.stringify(pack))
  assert.equal(r.ok, true)
  assert.deepEqual(r.pack, pack)
})

test('指纹：改验证码 / 改目录 / 改团队 / 改信封 都必被发现（且不笼统报"文件无效"）', () => {
  const cases = [
    ['验证码', (p) => { p.invite.code = '000000' }],
    ['团队目录', (p) => { p.source.dir = 'D:/骗人的目录' }],
    ['团队 id', (p) => { p.team.teamId = 't_别的团队' }],
    ['信封', (p) => { p.invite.envelope = '{"kind":"team-key","偷换":true}' }],
    ['成员 id', (p) => { p.invite.memberId = 'u_别人' }],
  ]
  for (const [what, mutate] of cases) {
    const p = goodPack()
    mutate(p)
    const r = parseTeamPackage(p)
    assert.equal(r.ok, false, `改了${what}却仍被判为有效 —— 指纹没覆盖这一段`)
    assert.equal(r.reason, 'fingerprint-mismatch', `${what} 必须报"指纹不一致"（提醒重新索要），而不是别的`)
    assert.match(r.message, /重新索要/, '文案要给出下一步动作，不能只说"无效"')
  }
  // 反例保护：**重新导出**（时间/成员槽变了）不应被误判成篡改
  const a = goodPack()
  const b = buildTeamPackage({
    manifest: { teamId: 't_abc123', name: '甲团队', identCode: '123456789', salt: 's', scrypt: { N: 2 ** 15 } },
    memberId: 'u_y', code: '111111', envelope: '{"kind":"team-key"}',
    sourceDir: 'Z:/团队-甲', now: Date.now(),   // ★ 同上：不用写死时间（避免时间炸弹）
  })
  assert.notEqual(a.fingerprint, b.fingerprint, '不同邀请必须是不同指纹（否则"两个包等价"会让一次性形同虚设）')
})

test('解析失败原因逐项区分（4 种各自的处置完全不同，不能合并成一句"文件无效"）', () => {
  assert.equal(parseTeamPackage('这不是 JSON').reason, 'not-json')
  assert.equal(parseTeamPackage('{}').reason, 'bad-format')
  assert.equal(parseTeamPackage({ format: TEAM_PACK_FORMAT, schemaVersion: 99 }).reason, 'bad-schema')

  const missing = parseTeamPackage({ format: TEAM_PACK_FORMAT, schemaVersion: 1, team: { teamId: 't_1' }, invite: {}, source: {} })
  assert.equal(missing.reason, 'missing-field')
  assert.ok(missing.missing.includes('invite.code(6位数字)'), '缺字段要照原文列出（用户据此知道是复制粘贴截断）')
  assert.ok(missing.missing.includes('source.dir'))

  // 过期：包自带的过期时间先给出明确说法（而不是等解信封才失败）
  const expired = goodPack()
  expired.invite.expiresAt = '2020-01-01T00:00:00.000Z'
  expired.fingerprint = packFingerprint(expired) // 合法包，只是过期了
  assert.equal(parseTeamPackage(expired).reason, 'code-expired')

  // 脏输入不崩（拖进来一个空文件 / 目录 / 数组）
  for (const junk of ['', '   ', null, undefined, 42, [], [1, 2]]) {
    assert.equal(parseTeamPackage(junk).ok, false, `${JSON.stringify(junk)} 应被判为无效而不是抛出`)
  }
})

test('文件名：团队名里的非法字符被替换、空名/超长兜住（真实团队名常含空格与括号）', () => {
  assert.equal(teamPackFilename('研发一组', 't_1a2b3c').endsWith(TEAM_PACK_EXT), true)
  const f = teamPackFilename('湖北美宝药业/研发:组*?', 't_zzzz9f3a')
  assert.equal(/[\\/:*?"<>|]/.test(f), false, `文件名不得含非法字符（实际 ${f}）`)
  assert.equal(f.endsWith('-9f3a.yfwteam'), true, '尾部保留 teamId 后 4 位（非字母数字已剔除）便于人工核对是哪个团队')
  assert.ok(teamPackFilename('', '').length > 0, '空名也要给一个可用文件名（不能返回 .yfwteam）')
  assert.ok(teamPackFilename('あ'.repeat(200), 't_1').length <= 60, '超长团队名要截断（Windows 路径长度）')
})

// ---------------------------------------------------------------------------
// ②③④ 端到端：导出 → 导入（兜底寻址 / 一次性 / 篡改 / 措辞）
// ---------------------------------------------------------------------------

test('兜底路径：**没有搜索根**也能用邀请包加入；团队密钥一致、两人 active、链完整', () => {
  const env = setup('yfw-s3-pkg-ok-')
  try {
    const exported = exportTeamPackage({ configDir: env.ownerCfg, teamId: env.created.teamId })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.match(exported.code, /^\d{6}$/)
    assert.equal(exported.filename.endsWith('.yfwteam'), true)
    assert.equal(exported.envelopeWritten, true, '导出方能访问团队源时应把信封也写回去（两条路径都能用）')

    // 模拟"拖入文件"：把包序列化成文本，**原样**交给导入侧（渲染层不解析）
    const text = JSON.stringify(exported.package, null, 2)
    const joinerCfg = join(env.workspace, 'joiner-appdata')  // 独立设备
    const imported = importTeamPackage({ configDir: joinerCfg, text })
    assert.equal(imported.ok, true, JSON.stringify(imported))
    assert.equal(imported.teamId, env.created.teamId)
    assert.equal(imported.memberId, exported.memberId, '导入者占用被邀请的成员槽')
    assert.equal(imported.via, 'package')

    // 团队密钥到手（信封真的解开了）
    const owner = loadTeamConfig(env.ownerCfg)
    const joiner = loadTeamConfig(joinerCfg)
    assert.equal(joiner.teams[env.created.teamId].teamKey, owner.teams[env.created.teamId].teamKey)
    // 兜底路径**不设搜索根**：加入成功不该偷偷写 searchRoot（那是主路径的事）
    assert.equal(joiner.searchRoot, null, '导入包不应顺手设置搜索根（用户没要求访问整个搜索根）')

    const src = openTeamSource({ root: env.dir })
    const v = verifyTeamSource(src)
    assert.equal(v.integrity.ok, true, JSON.stringify(v.integrity.errors))
    assert.equal(v.members.filter((m) => m.status === 'active').length, 2, 'owner + 导入者都是 active')
  } finally { cleanup(env.workspace) }
})

test('一次性：同一个包导入第二次必失败（invite-used），换机器同样拦得住', () => {
  const env = setup('yfw-s3-pkg-once-')
  try {
    const exported = exportTeamPackage({ configDir: env.ownerCfg, teamId: env.created.teamId })
    const text = JSON.stringify(exported.package)

    const first = importTeamPackage({ configDir: join(env.workspace, 'm1'), text })
    assert.equal(first.ok, true, JSON.stringify(first))
    const second = importTeamPackage({ configDir: join(env.workspace, 'm2'), text })
    assert.equal(second.ok, false, '同一个包换机器也不得复用')
    assert.equal(second.reason, 'invite-used')
    assert.equal(existsSync(join(env.workspace, 'm2', 'team', 'config.json')), false, '失败不得写本机配置')
  } finally { cleanup(env.workspace) }
})

test('篡改：改过内容的包被拒（fingerprint-mismatch），且不写本机配置、不污染团队源', () => {
  const env = setup('yfw-s3-pkg-tamper-')
  try {
    const exported = exportTeamPackage({ configDir: env.ownerCfg, teamId: env.created.teamId })
    const tampered = JSON.parse(JSON.stringify(exported.package))
    tampered.invite.code = '000000'

    const cfg = join(env.workspace, 'victim')
    const r = importTeamPackage({ configDir: cfg, text: JSON.stringify(tampered) })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'fingerprint-mismatch')
    assert.equal(existsSync(join(cfg, 'team', 'config.json')), false)

    // 团队源侧不留痕迹（没有"被拒的加入"写进成员日志）
    const v = verifyTeamSource(openTeamSource({ root: env.dir }))
    assert.equal(v.members.length, 1, '被拒的导入不得在团队源留下成员记录')
  } finally { cleanup(env.workspace) }
})

test('寻址：包里的目录在本机不存在 → team-dir-missing；用 sourceDir 指到本机目录即可成功', () => {
  const env = setup('yfw-s3-pkg-dir-')
  try {
    // 导出时故意把一个"对方不存在的路径"写进包（模拟两台机器挂载点不同）
    const exported = exportTeamPackage({ configDir: env.ownerCfg, teamId: env.created.teamId, sourceDir: join(env.workspace, '不存在的挂载点') })
    assert.equal(exported.ok, true)
    const text = JSON.stringify(exported.package)

    const cfg = join(env.workspace, 'joiner')
    const noOverride = importTeamPackage({ configDir: cfg, text })
    assert.equal(noOverride.ok, false)
    assert.equal(noOverride.reason, 'team-dir-missing')
    assert.match(noOverride.message, /手动指定/, '要告诉用户"可以手动指定目录"，否则他只会反复重试同一个包')

    const override = importTeamPackage({ configDir: cfg, text, sourceDir: env.dir })
    assert.equal(override.ok, true, JSON.stringify(override))
    assert.equal(loadTeamConfig(cfg).teams[env.created.teamId].dir, env.dir, '本机配置里记的必须是**实际可用**的那个目录')
  } finally { cleanup(env.workspace) }
})

test('防串台：包属于甲团队、目录是乙团队 → team-mismatch（不误报成"验证码错"）', () => {
  const env = setup('yfw-s3-pkg-mismatch-')
  try {
    const otherDir = join(env.workspace, '网盘', '搜索根', '团队-乙')
    const other = createTeam({ configDir: join(env.workspace, 'other-appdata'), name: '乙团队', dir: otherDir, identCode: '987654321' })
    assert.equal(other.ok, true)

    const exported = exportTeamPackage({ configDir: env.ownerCfg, teamId: env.created.teamId })
    const r = importTeamPackage({ configDir: join(env.workspace, 'm'), text: JSON.stringify(exported.package), sourceDir: otherDir })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'team-mismatch', '拿甲团队的包去加乙团队必须明确拒绝（否则用户会以为验证码错了）')
  } finally { cleanup(env.workspace) }
})

test('过期：TTL 到点后导入 → code-expired（与"包坏了"分开）', () => {
  const env = setup('yfw-s3-pkg-exp-')
  try {
    const exported = exportTeamPackage({ configDir: env.ownerCfg, teamId: env.created.teamId, ttlMs: 1000 })
    const text = JSON.stringify(exported.package)
    const r = importTeamPackage({ configDir: join(env.workspace, 'm'), text, now: Date.now() + 60_000 })
    // 信封与包用的是同一个 TTL，因此"过期"在解析阶段就会被拦下（更早、文案更准）
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'code-expired')
  } finally { cleanup(env.workspace) }
})

test('导出侧：本机没加入/没有团队密钥时不得假装成功（not-a-member / no-team-key）', () => {
  const env = setup('yfw-s3-pkg-nomember-')
  try {
    const r = exportTeamPackage({ configDir: join(env.workspace, 'nobody'), teamId: env.created.teamId })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not-a-member')

    const cfg = loadTeamConfig(env.ownerCfg)
    delete cfg.teams[env.created.teamId].teamKey
    writeFileSync(join(env.ownerCfg, 'team', 'config.json'), JSON.stringify(cfg), 'utf-8')
    const r2 = exportTeamPackage({ configDir: env.ownerCfg, teamId: env.created.teamId })
    assert.equal(r2.ok, false)
    assert.equal(r2.reason, 'no-team-key')
  } finally { cleanup(env.workspace) }
})

test('两数字路径仍然可用（补齐邀请包不得把主路径改坏）——两条路径共用同一个一次性判定', () => {
  const env = setup('yfw-s3-pkg-both-')
  try {
    // 两条路径各自开一个成员槽、各自出一枚验证码：**不得**互相覆盖（覆盖 = 已发出的码静默失效）
    const invite = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId })
    const exported = exportTeamPackage({ configDir: env.ownerCfg, teamId: env.created.teamId })
    assert.equal(invite.ok, true)
    assert.equal(exported.ok, true)
    assert.notEqual(exported.memberId, invite.memberId, '导出邀请包必须开新成员槽（不得覆盖在流通的信封）')
    assert.notEqual(exported.code, invite.code)

    // 用**包里的码**完成加入
    const first = importTeamPackage({ configDir: join(env.workspace, 'm1'), text: JSON.stringify(exported.package) })
    assert.equal(first.ok, true, JSON.stringify(first))

    // 同一个码改走"两个数字"路径：必须也已经作废（判定落在团队源，两条路径共用）
    const viaCodes = joinTeam({
      configDir: join(env.workspace, 'm2'), identCode: '123456789', code: exported.code, searchRoot: env.searchRoot,
    })
    assert.equal(viaCodes.ok, false)
    assert.equal(viaCodes.reason, 'already-used', '两条路径共用同一个一次性判定（否则换个姿势就能把同一个码用两次）')

    // 另一枚（走"两个数字"那条邀请的）码**不受影响**——各槽独立
    const other = joinTeam({
      configDir: join(env.workspace, 'm3'), identCode: '123456789', code: invite.code, searchRoot: env.searchRoot,
    })
    assert.equal(other.ok, true, JSON.stringify(other))

    const src = openTeamSource({ root: env.dir })
    const v = verifyTeamSource(src)
    assert.equal(v.integrity.ok, true, JSON.stringify(v.integrity.errors))
    assert.equal(v.members.filter((m) => m.status === 'active').length, 3, 'owner + 包导入者 + 两个数字加入者')
  } finally { cleanup(env.workspace) }
})

test('§11 措辞约束：邀请包文案不得暗示"加密/仅受邀可读"（包内本就含验证码=凭据）', () => {
  const env = setup('yfw-s3-pkg-wording-')
  try {
    const exported = exportTeamPackage({ configDir: env.ownerCfg, teamId: env.created.teamId })
    assert.equal(/加密|安全|仅.*可见|防止.*访问/i.test(exported.copyText), false,
      '§5.9/§11：真实边界是网盘 ACL，不得宣称"已加密/仅受邀可读"')
    assert.match(exported.copyText, /凭据/, '反过来必须**如实**说明"包里有验证码、等于凭据"')
    assert.match(exported.copyText, /只能用一次/)
  } finally { cleanup(env.workspace) }
})

test('包是单文件 JSON 且**不含团队密钥本身**（只有验证码信封）——格式与安全边界都钉住', () => {
  const env = setup('yfw-s3-pkg-plain-')
  try {
    const exported = exportTeamPackage({ configDir: env.ownerCfg, teamId: env.created.teamId })
    const text = JSON.stringify(exported.package)
    // 单文件、纯 JSON：与 `.yfwflow` 同族，拖入/转发只需一次文件拷贝（不引入 zip 依赖）
    assert.equal(text.trim().startsWith('{'), true)
    assert.equal(/PK\u0003\u0004/.test(text), false, '不得是 zip 容器')
    // 团队密钥本体（base64 的 32 字节）绝不能出现在包里：出现即"密钥随文件外流"
    const ownerKey = loadTeamConfig(env.ownerCfg).teams[env.created.teamId].teamKey
    assert.equal(text.includes(ownerKey), false, '包里不得含团队密钥明文（只能有需要验证码才能解开的信封）')
    assert.equal(existsSync(join(env.dir, '.ponos', 'keys', `${exported.memberId}.env`)), true)
    const envText = readFileSync(join(env.dir, '.ponos', 'keys', `${exported.memberId}.env`), 'utf-8')
    assert.equal(envText.includes(ownerKey), false, '信封同样不得含密钥明文')
  } finally { cleanup(env.workspace) }
})
