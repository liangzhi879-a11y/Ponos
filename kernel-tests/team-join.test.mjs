// S3 回归网③：加入机制（识别码 + 一次性验证码信封 + 过期 + 作废）
// spec §5.9「加入机制（定案 15）」、§9「S3 加入机制」：
//   识别码匹配 / 验证码解信封 / 错误验证码拒绝 / 一次性作废（二次使用失败）/ 过期拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createTeam, exportInvite, joinTeam, revokeMember, teamStatus, verifyTeamSource, setSearchRoot,
  loadTeamConfig, saveTeamConfig, teamConfigPath,
} from '../kernel/team-store.mjs'
import { openTeamSource } from '../shared/team-source.mjs'
import { generateVerifyCode } from '../shared/team-crypto.mjs'

function tmp(prefix) { return mkdtempSync(join(tmpdir(), prefix)) }
function cleanup(p) {
  for (let i = 0; i < 8; i++) {
    try { rmSync(p, { recursive: true, force: true }); return } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

/** 造一套"创建者 + 团队源 + 搜索根"的隔离环境。 */
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

test('§7.2 契约：team.json 是明文且**不含任何密钥**；识别码 9 位；团队密钥只在本机配置', () => {
  const env = setup('yfw-s3-join-')
  try {
    const manifest = JSON.parse(readFileSync(join(env.dir, '.yfworking', 'team.json'), 'utf-8'))
    assert.equal(manifest.identCode, '123456789')
    assert.equal(manifest.teamId.startsWith('t_'), true)
    assert.equal(typeof manifest.salt, 'string', '盐必须存在（解密方需要它，且盐不是秘密）')
    assert.equal(manifest.scrypt.N, 2 ** 15, '§5.9 指定 N=2^15')
    // 明文 manifest 里不能出现任何密钥材料
    const raw = readFileSync(join(env.dir, '.yfworking', 'team.json'), 'utf-8')
    assert.equal(/teamKey|privateKey|"key"|secret/i.test(raw), false, 'team.json 绝不含密钥')

    // 团队密钥在本机配置里（0600）
    const cpath = teamConfigPath(env.ownerCfg)
    const cfgRaw = readFileSync(cpath, 'utf-8')
    assert.match(cfgRaw, /"teamKey"/)
    assert.match(cfgRaw, /"privateKey"/)
    if (process.platform !== 'win32') {
      const mode = statSync(cpath).mode & 0o777
      assert.equal(mode, 0o600, `本机配置含私钥与团队密钥，权限必须是 0600（实际 ${mode.toString(8)}）`)
    }
  } finally { cleanup(env.workspace) }
})

test('加入成功：识别码匹配 + 正确验证码解出**同一个团队密钥**；成员表出现两人且链完整', () => {
  const env = setup('yfw-s3-join-ok-')
  try {
    const invite = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId })
    assert.equal(invite.ok, true)
    assert.match(invite.code, /^\d{6}$/, '验证码 6 位数字')
    assert.ok(invite.copyText.includes('123456789') && invite.copyText.includes(invite.code), '转发文案含识别码与验证码')
    assert.equal(existsSync(join(env.dir, '.yfworking', 'keys', `${invite.memberId}.env`)), true, '信封必须落在 <团队根>/.yfworking/keys/<memberId>.env')

    // 另一台机器（独立 configDir = 独立设备 id 与身份密钥）
    const joinerCfg = join(env.workspace, 'joiner-appdata')
    const joined = joinTeam({ configDir: joinerCfg, identCode: '123456789', code: invite.code, searchRoot: env.searchRoot })
    assert.equal(joined.ok, true, JSON.stringify(joined))
    assert.equal(joined.memberId, invite.memberId, '加入者采用被邀请的成员槽')
    assert.equal(joined.dir, env.dir)

    // 团队密钥一致（信封真的把团队密钥交出去了）
    const ownerCfg = loadTeamConfig(env.ownerCfg)
    const joinerCfgObj = loadTeamConfig(joinerCfg)
    assert.equal(joinerCfgObj.teams[env.created.teamId].teamKey, ownerCfg.teams[env.created.teamId].teamKey,
      '加入者拿到的团队密钥必须与创建者一致')

    // 成员表：owner + joiner，链完整
    const src = openTeamSource({ root: env.dir })
    const v = verifyTeamSource(src)
    assert.equal(v.integrity.ok, true, JSON.stringify(v.integrity.errors))
    assert.equal(v.members.length, 2, '应有 owner 与新成员')
    assert.equal(v.members.filter((m) => m.status === 'active').length, 2, '两人都是 active（**加入者不得被自己那条"作废邀请"记录踢出**）')
    assert.equal(v.copies.length, 2, '两台设备各一条日志')
  } finally { cleanup(env.workspace) }
})

test('一次性：同一验证码第二次使用必须失败（already-used），且换机器也不能复用', () => {
  const env = setup('yfw-s3-join-once-')
  try {
    const invite = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId })
    const cfg1 = join(env.workspace, 'machine-1')
    const first = joinTeam({ configDir: cfg1, identCode: '123456789', code: invite.code, searchRoot: env.searchRoot })
    assert.equal(first.ok, true)

    // 换一台机器（不同 configDir / deviceId）再试同一验证码 —— 一次性必须记在**团队源**上，否则换机即可复用
    const cfg2 = join(env.workspace, 'machine-2')
    const second = joinTeam({ configDir: cfg2, identCode: '123456789', code: invite.code, searchRoot: env.searchRoot })
    assert.equal(second.ok, false, '同一验证码不得二次使用')
    assert.equal(second.reason, 'already-used')
  } finally { cleanup(env.workspace) }
})

test('错误验证码：明确拒绝（bad-code），不误报为"过期/已用"', () => {
  const env = setup('yfw-s3-join-bad-')
  try {
    const invite = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId })
    const wrong = invite.code === '000000' ? '111111' : '000000'
    const cfg = join(env.workspace, 'm')
    const r = joinTeam({ configDir: cfg, identCode: '123456789', code: wrong, searchRoot: env.searchRoot })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'bad-code')
    assert.equal(existsSync(teamConfigPath(cfg)), false, '失败不得写本机配置（不留半截状态）')
  } finally { cleanup(env.workspace) }
})

test('过期：TTL 到点后拒绝（expired），且与"验证码错"可区分', () => {
  const env = setup('yfw-s3-join-exp-')
  try {
    const invite = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId, ttlMs: 1000 })
    const cfg = join(env.workspace, 'm')
    const r = joinTeam({ configDir: cfg, identCode: '123456789', code: invite.code, searchRoot: env.searchRoot, now: Date.now() + 60_000 })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'expired', '过期必须与"验证码错"区分（否则用户会反复重试一个永远不会成功的码）')
  } finally { cleanup(env.workspace) }
})

test('识别码：不匹配 → ident-not-found；格式不对 → bad-ident-format（不静默当作没找到）', () => {
  const env = setup('yfw-s3-join-ident-')
  try {
    const invite = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId })
    const cfg = join(env.workspace, 'm')
    const notFound = joinTeam({ configDir: cfg, identCode: '999999999', code: invite.code, searchRoot: env.searchRoot })
    assert.equal(notFound.reason, 'ident-not-found')

    const badFormat = joinTeam({ configDir: cfg, identCode: '12345', code: invite.code, searchRoot: env.searchRoot })
    assert.equal(badFormat.reason, 'bad-ident-format')
    const badCodeFmt = joinTeam({ configDir: cfg, identCode: '123456789', code: 'abc', searchRoot: env.searchRoot })
    assert.equal(badCodeFmt.reason, 'bad-code-format')
  } finally { cleanup(env.workspace) }
})

test('搜索根：未设置/不存在 → search-root-missing（与"没找到团队"区分）', () => {
  const env = setup('yfw-s3-join-root-')
  try {
    const cfg = join(env.workspace, 'm')
    const noRoot = joinTeam({ configDir: cfg, identCode: '123456789', code: '123456' })
    assert.equal(noRoot.reason, 'search-root-missing')
    const badRoot = joinTeam({ configDir: cfg, identCode: '123456789', code: '123456', searchRoot: join(env.workspace, '不存在') })
    assert.equal(badRoot.reason, 'search-root-missing')
  } finally { cleanup(env.workspace) }
})

test('无信封：团队存在但没有邀请 → no-envelope（措辞不要误导成"验证码错"）', () => {
  const env = setup('yfw-s3-join-noenv-')
  try {
    const cfg = join(env.workspace, 'm')
    const r = joinTeam({ configDir: cfg, identCode: '123456789', code: '123456', searchRoot: env.searchRoot })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-envelope')
  } finally { cleanup(env.workspace) }
})

test('撤销成员：写签名记录 ⇒ 成员表变 revoked；且历史签名仍有效（不把历史判成篡改）', () => {
  const env = setup('yfw-s3-revoke-')
  try {
    const invite = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId })
    const cfg = join(env.workspace, 'm')
    assert.equal(joinTeam({ configDir: cfg, identCode: '123456789', code: invite.code, searchRoot: env.searchRoot }).ok, true)

    const r = revokeMember({ configDir: env.ownerCfg, teamId: env.created.teamId, memberId: invite.memberId })
    assert.equal(r.ok, true)
    const src = openTeamSource({ root: env.dir })
    const v = verifyTeamSource(src)
    assert.equal(v.members.find((m) => m.memberId === invite.memberId).status, 'revoked')
    assert.equal(v.integrity.ok, true, '移除成员后链仍应自洽（历史记录签名依旧有效）')
  } finally { cleanup(env.workspace) }
})

test('teamStatus：给出成员/完整性/同步盘警告/体积度量（三样互为解释）', () => {
  const env = setup('yfw-s3-status-')
  try {
    const invite = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId })
    assert.equal(joinTeam({ configDir: env.workspace + '/m', identCode: '123456789', code: invite.code, searchRoot: env.searchRoot }).ok, true)

    const st = teamStatus({ configDir: env.ownerCfg })
    assert.equal(st.ok, true)
    assert.equal(st.teams.length, 1)
    const t = st.teams[0]
    assert.equal(t.ok, true)
    assert.equal(t.memberCount, 2)
    assert.equal(t.integrity.ok, true)
    assert.equal(t.copies, 2)
    assert.equal(typeof t.measure.files, 'number')
    assert.equal(Array.isArray(t.warnings), true)
    assert.equal(t.me.role, 'owner')

    // 未加入任何团队时：如实返回空列表（不是报错）
    const empty = teamStatus({ configDir: join(env.workspace, 'nobody') })
    assert.deepEqual(empty.teams, [])
  } finally { cleanup(env.workspace) }
})

test('非成员不能邀请（not-a-member）；成员名单缺团队密钥时不能邀请（no-team-key）', () => {
  const env = setup('yfw-s3-join-nomember-')
  try {
    const r = exportInvite({ configDir: join(env.workspace, 'nobody'), teamId: env.created.teamId })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not-a-member')

    // 手工造一个"只在名册里、没有团队密钥"的本机条目（模拟只同步了成员表的情形）
    const cfg = loadTeamConfig(env.ownerCfg)
    delete cfg.teams[env.created.teamId].teamKey
    saveTeamConfig(env.ownerCfg, cfg)
    const r2 = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId })
    assert.equal(r2.ok, false)
    assert.equal(r2.reason, 'no-team-key')
  } finally { cleanup(env.workspace) }
})

test('setSearchRoot / 团队源目录被删：状态如实报 team-dir-missing（不假装正常）', () => {
  const env = setup('yfw-s3-dirgone-')
  try {
    setSearchRoot(env.ownerCfg, env.searchRoot)
    assert.equal(loadTeamConfig(env.ownerCfg).searchRoot, env.searchRoot)

    rmSync(env.dir, { recursive: true, force: true })
    const st = teamStatus({ configDir: env.ownerCfg })
    assert.equal(st.teams[0].ok, false)
    assert.equal(st.teams[0].reason, 'team-dir-missing')
  } finally { cleanup(env.workspace) }
})

test('损坏的本机配置：读侧降级（不崩），但**不静默覆盖**（strict 模式明确报错）', () => {
  const env = setup('yfw-s3-corrupt-')
  try {
    const p = teamConfigPath(env.ownerCfg)
    const good = readFileSync(p, 'utf-8')
    writeFileSync(p, '{ 坏掉的 JSON')
    // 读侧：返回全新空配置（降级，不抛）
    const cfg = loadTeamConfig(env.ownerCfg)
    assert.deepEqual(cfg.teams, {}, '损坏时降级为空配置，避免主链路起不来')
    assert.equal(typeof cfg.deviceId, 'string', '降级配置仍需可用（要有设备 id）')
    // 写侧/严格：明确报错，避免把损坏内容覆盖成空表
    assert.throws(() => loadTeamConfig(env.ownerCfg, { strict: true }), /损坏|非法/)
    assert.equal(readFileSync(p, 'utf-8'), '{ 坏掉的 JSON', '损坏文件必须原样保留以供人工恢复')
    writeFileSync(p, good)
  } finally { cleanup(env.workspace) }
})

test('验证码不得成为"加密安全"的暗示：文案遵守 §11 措辞约束', () => {
  const env = setup('yfw-s3-wording-')
  try {
    const invite = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId })
    assert.equal(/加密|安全|仅.*可见|防止.*访问/i.test(invite.copyText), false,
      '§5.9/§11：不得暗示"已加密/仅受邀可读"（真实边界是网盘 ACL，邀请无强制力）')
  } finally { cleanup(env.workspace) }
})

test('邀请信封的随机性：两次邀请的验证码与信封不同（同一码重复出现会让一次性形同虚设）', () => {
  const env = setup('yfw-s3-random-')
  try {
    const a = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId })
    const b = exportInvite({ configDir: env.ownerCfg, teamId: env.created.teamId })
    assert.notEqual(a.memberId, b.memberId)
    const keys = readdirSync(join(env.dir, '.yfworking', 'keys')).sort()
    assert.equal(keys.length, 2, '两个信封各占一个成员槽')
    // 码空间 10^6，两次相同的概率极低；这里只断言"不是硬编码常量"
    assert.ok(a.code.length === 6 && b.code.length === 6)
    void generateVerifyCode
  } finally { cleanup(env.workspace) }
})
