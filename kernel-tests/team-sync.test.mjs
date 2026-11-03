// S3 回归网④：内容协同（团队知识空间 + 经验条目级并集 + 模式语义）
// spec §7.1（知识空间加 team-<id>，插在 builtinSpaceSpecs，**下层检索/切分/关联/路由零改动**；
//   经验条目 id 已是内容寻址 ⇒ 团队经验 = 条目集合，合并 = 集合求并）、§5.9（模式语义表格）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  teamSpaceId, teamKnowledgeRoot, teamExperienceDir, teamSpaceSpecs, safeTeamSpaceSpecs,
  ensureTeamContentDirs, entryKey, parseEntryLines, unionEntryLines, readTeamExperience,
  syncTeamExperience, listTeamExperienceThemes, sidebarSpaceIds, checkTeamContentReady,
} from '../kernel/team-sync.mjs'
import { builtinSpaceSpecs } from '../shared/knowledge-core.mjs'
import { createTeam } from '../kernel/team-store.mjs'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

function tmp(prefix) { return mkdtempSync(join(tmpdir(), prefix)) }
function cleanup(p) {
  for (let i = 0; i < 8; i++) {
    try { rmSync(p, { recursive: true, force: true }); return } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

test('空间 spec：id 为 team-<teamId>、source=team、且只对**目录真实存在**的团队挂载', () => {
  const ws = tmp('yfw-s3-sync-spec-')
  try {
    const cfgDir = join(ws, 'appdata')
    const dir = join(ws, '团队')
    const created = createTeam({ configDir: cfgDir, name: '甲', dir, identCode: '111111111' })
    assert.equal(created.ok, true)

    // 内容目录尚未建 ⇒ 不挂（避免"挂着一个永远空的空间"）
    assert.deepEqual(teamSpaceSpecs(cfgDir), [], '内容目录未建时不应挂载')

    ensureTeamContentDirs(dir, created.teamId)
    const specs = teamSpaceSpecs(cfgDir)
    assert.equal(specs.length, 1)
    assert.equal(specs[0].id, teamSpaceId(created.teamId))
    assert.equal(specs[0].id.startsWith('team-'), true)
    assert.equal(specs[0].source, 'team')
    assert.equal(specs[0].writable, true)
    assert.equal(specs[0].root, teamKnowledgeRoot(dir, created.teamId))

    // 未加入任何团队 ⇒ 空（零回归的关键）
    assert.deepEqual(teamSpaceSpecs(join(ws, 'nobody')), [])
    // 安全版：配置损坏也不抛，退化为空（**先建目录再写文件**——首轮是先写后建，自己造了个 ENOENT）
    mkdirSync(join(ws, 'broken', 'team'), { recursive: true })
    writeFileSync(join(ws, 'broken', 'team', 'config.json'), '{ 坏')
    assert.deepEqual(safeTeamSpaceSpecs(join(ws, 'broken')), [], '配置损坏时安全版必须退化为空数组（主链路不受影响）')
  } finally { cleanup(ws) }
})

test('builtinSpaceSpecs：不传 extra 时逐字不变（零回归）；传 extra 时追加在末尾', () => {
  const base = builtinSpaceSpecs('/cfg')
  assert.deepEqual(base.map((s) => s.id), ['experience', 'session-memory', 'skill-experience'])
  assert.equal(base.length, 3)

  const withExtra = builtinSpaceSpecs('/cfg', { extra: [{ id: 'team-t_1', name: '团队：甲', root: '/team/k', writable: true, source: 'team' }] })
  assert.equal(withExtra.length, 4)
  assert.equal(withExtra[3].id, 'team-t_1', '团队空间追加在内置之后')
  assert.deepEqual(withExtra.slice(0, 3).map((s) => s.id), base.map((s) => s.id), '内置三项不得被改动')
  // 非法 extra 项被忽略（不产生半残 spec）
  assert.equal(builtinSpaceSpecs('/cfg', { extra: [{ id: 'x' }, null, { root: '/y' }] }).length, 3)
})

test('端到端：团队空间接入知识 store 后**可被检索到**（下层零改动的实证）', () => {
  const ws = tmp('yfw-s3-sync-e2e-')
  try {
    const cfgDir = join(ws, 'appdata')
    const dir = join(ws, '团队')
    const created = createTeam({ configDir: cfgDir, name: '甲', dir, identCode: '111111111' })
    const { knowledge } = ensureTeamContentDirs(dir, created.teamId)
    // 在**共享目录**里放一篇团队知识
    mkdirSync(join(knowledge, '研发'), { recursive: true })
    writeFileSync(join(knowledge, '研发', '规范.md'), '# 研发规范\n\n这是团队共享的研发规范，含关键词 ponos-team-marker。\n', 'utf-8')

    // 不传 extra：团队空间不可见
    const plain = createKnowledgeStore({ configDir: cfgDir })
    plain.load({ force: true })
    assert.equal(plain.getSpaces().some((s) => s.id.startsWith('team-')), false, '不传 extra ⇒ 与今日一致')

    // 传 extra：团队空间可见，且其中文档被正常切块/索引（下层逻辑未改一行）
    const store = createKnowledgeStore({ configDir: cfgDir, extraSpaceSpecs: teamSpaceSpecs(cfgDir) })
    store.load({ force: true })
    const spaces = store.getSpaces()
    const teamSpace = spaces.find((s) => s.id === teamSpaceId(created.teamId))
    assert.ok(teamSpace, '团队空间应出现在空间清单里')
    assert.equal(teamSpace.source, 'team')

    const st = store.stats()
    assert.equal(st.spaces, spaces.length, `团队空间应被计入索引（spaces=${st.spaces}）`)

    // 检索命中团队空间内容（证明"下层零改动即可用"）
    // 注意：`search` 收 **options 对象**（`{query,...}`）而非字符串 —— 传字符串会恒得 0 条
    // （首轮就是这么假红的：连内置空间同样内容也搜不到，说明问题在调用方而不在团队空间）。
    const res = store.search({ query: 'ponos-team-marker' })
    assert.ok(res.items.length >= 1, '团队空间内的文档应能被检索到')
    const hitSpace = res.items[0].spaceId
    assert.equal(hitSpace, teamSpaceId(created.teamId), '命中的应是团队空间')
  } finally { cleanup(ws) }
})

test('经验并集：内容寻址去重、顺序稳定、重复计数如实', () => {
  const A = '- [会话|甲] 摘要 A -- 全文 A'
  const B = '- [会话|甲] 摘要 B -- 全文 B'
  const C = '- [会话|乙] 摘要 C -- 全文 C'
  assert.notEqual(entryKey(A), entryKey(B), '不同条目必须不同 key（否则并集静默丢内容）')

  const u1 = unionEntryLines([A, B], [A, C])
  assert.deepEqual(u1.lines, [A, B, C], '结果 = a 原序 + b 新增（稳定可预测）')
  assert.equal(u1.addedFromB, 1)
  assert.equal(u1.duplicates, 1, '被合并掉的重数要如实报出（便于解释"为什么没变多"）')

  // 输入形态两种都要吃：数组 / 整份文本
  assert.deepEqual(parseEntryLines(['a', 'b']), ['a', 'b'])
  assert.deepEqual(parseEntryLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(parseEntryLines([A, B]), [A, B], '数组入参**不得**被逗号拼成一行（首轮实测踩过）')
  const u2 = unionEntryLines(`${A}\n${B}\n`, C)
  assert.deepEqual(u2.lines, [A, B, C], '字符串入参同样可用')

  // 幂等：同集合再并一次不产生新增
  const u3 = unionEntryLines(u1.lines, u1.lines)
  assert.equal(u3.addedFromB, 0)
  assert.deepEqual(u3.lines, u1.lines)
})

test('syncTeamExperience：写入并集、无新增不写盘（避免网盘判为改动）、不可读则拒绝写', () => {
  const ws = tmp('yfw-s3-sync-exp-')
  try {
    const dir = join(ws, '团队')
    mkdirSync(dir, { recursive: true })
    ensureTeamContentDirs(dir, 't_a')

    const A = '- [会话|甲] 摘要 A -- 全文 A'
    const B = '- [会话|甲] 摘要 B -- 全文 B'
    const C = '- [会话|乙] 摘要 C -- 全文 C'

    const r1 = syncTeamExperience({ teamDir: dir, theme: 'workflow', localLines: [A, B] })
    assert.equal(r1.ok, true)
    assert.equal(r1.written, true)
    assert.equal(r1.total, 2, '两条必须都在（数组入参不得被拼成一行）')
    assert.equal(r1.added, 2)
    assert.deepEqual(readFileSync(join(teamExperienceDir(dir), 'workflow.md'), 'utf-8').trim().split('\n'), [A, B])

    const r2 = syncTeamExperience({ teamDir: dir, theme: 'workflow', localLines: [A, C] })
    assert.equal(r2.total, 3, '本机新增 C 后团队库应为 3 条')
    assert.equal(r2.added, 1)

    // 幂等：无新增 ⇒ 不写盘（避免无意义的 mtime 抖动 → 网盘同步流量与冲突）
    const r3 = syncTeamExperience({ teamDir: dir, theme: 'workflow', localLines: [A, C] })
    assert.equal(r3.written, false, '无新增不得写盘')
    assert.equal(r3.total, 3)

    // 不可读（用同名目录模拟 EISDIR）：必须拒绝写，避免把既有内容覆盖成"只剩本机条目"
    mkdirSync(join(teamExperienceDir(dir), 'bad.md'), { recursive: true })
    const r4 = syncTeamExperience({ teamDir: dir, theme: 'bad', localLines: [A] })
    assert.equal(r4.ok, false)
    assert.equal(r4.reason, 'unreadable')
    assert.equal(readTeamExperience(dir, 'bad').lines.length, 0, '不可读时不得凭空产生条目')

    // 主题列举与"缺主题"的如实报告
    assert.deepEqual(listTeamExperienceThemes(dir), ['bad', 'workflow'])
    const missing = readTeamExperience(dir, 'nope')
    assert.equal(missing.exists, false)
    assert.deepEqual(missing.lines, [])
  } finally { cleanup(ws) }
})

test('模式语义：只影响侧边栏默认筛选，**检索范围不受模式影响**（§5.9）', () => {
  const ws = tmp('yfw-s3-sync-mode-')
  try {
    const cfgDir = join(ws, 'appdata')
    const dir = join(ws, '团队')
    const created = createTeam({ configDir: cfgDir, name: '甲', dir, identCode: '111111111' })
    ensureTeamContentDirs(dir, created.teamId)

    const personal = sidebarSpaceIds({ configDir: cfgDir, mode: 'personal' })
    assert.deepEqual(personal, ['experience', 'session-memory', 'skill-experience'], '个人模式只显示内置空间')

    const team = sidebarSpaceIds({ configDir: cfgDir, mode: 'team' })
    assert.deepEqual(team, [teamSpaceId(created.teamId)], '团队模式显示团队空间')

    const one = sidebarSpaceIds({ configDir: cfgDir, mode: 'team', teamId: created.teamId })
    assert.deepEqual(one, [teamSpaceId(created.teamId)], '可按 teamId 只留一个团队')

    // 契约：**没有**任何"按模式裁剪检索范围"的导出（一旦存在，早晚会被误用成
    // "团队模式下搜不到个人经验"——而 §5.9 明确检索默认跨全部空间）
    const mod = readFileSync(join(process.cwd(), 'kernel', 'team-sync.mjs'), 'utf-8')
    assert.equal(/searchScopeByMode|filterSpacesByMode|modeSearchScope/.test(mod), false)
  } finally { cleanup(ws) }
})

test('checkTeamContentReady：逐项报缺（不笼统说"没准备好"）', () => {
  const ws = tmp('yfw-s3-sync-ready-')
  try {
    const dir = join(ws, '团队')
    mkdirSync(dir, { recursive: true })
    let r = checkTeamContentReady(dir, 't_a')
    assert.equal(r.ok, false)
    assert.ok(r.problems.includes('team-manifest-missing'))
    assert.ok(r.problems.includes('knowledge-dir-missing'))
    assert.ok(r.problems.includes('experience-dir-missing'))

    writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: 't_a', identCode: '111111111' }))
    ensureTeamContentDirs(dir, 't_a')
    r = checkTeamContentReady(dir, 't_a')
    assert.deepEqual(r.problems, [])
    assert.equal(r.ok, true)
  } finally { cleanup(ws) }
})

test('共享目录里的内容：团队成员写进去的文档不会落到本机配置目录（内容在共享目录，才叫协同）', () => {
  const ws = tmp('yfw-s3-sync-share-')
  try {
    const cfgDir = join(ws, 'appdata')
    const dir = join(ws, '团队')
    const created = createTeam({ configDir: cfgDir, name: '甲', dir, identCode: '111111111' })
    const { knowledge, experience } = ensureTeamContentDirs(dir, created.teamId)
    assert.equal(knowledge.startsWith(dir), true, '知识空间根必须在团队源目录内')
    assert.equal(experience.startsWith(dir), true, '经验目录必须在团队源目录内')
    assert.equal(existsSync(knowledge), true)
    assert.equal(existsSync(experience), true)
  } finally { cleanup(ws) }
})
