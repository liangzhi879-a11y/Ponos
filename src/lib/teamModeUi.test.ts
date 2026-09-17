// src/lib/teamModeUi.test.ts —— S3「模式语义」的单测（2026-09-17）
//
// 本文件里最重要的是**反向断言**（spec §5.9 的"不受模式影响"一栏 + §10 S3-13）：
//   ① 模式筛选**不得**影响知识检索范围；
//   ② 源码级守门：知识检索视图不得引用任何按模式筛选的函数（防止日后有人"顺手"加上去）。
// 其余用例覆盖"判错会出丑"的那几条：清洗兜底方向、没团队时模式必须落回 personal、
// 团队归属的三条判据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  sanitizeWorkspaceMode, effectiveMode, modeSwitchEnabled,
  isTeamWorkspace, teamIdOfWorkspace, matchesMode, workspaceIdOfItem,
  filterConversationsByMode, filterWorkflowsByMode, filterKnowledgeSpacesByMode,
  knowledgeSearchScopeFor, WORKSPACE_MODES, PERSONAL_WORKSPACE_ID, TEAM_WORKSPACE_PREFIX,
  isTeamSectionRequest, sanitizeRequestedSection, sanitizeTeamIntent,
} from './teamModeUi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')

test('模式开关跳设置窗：分区请求与子视图请求各自清洗（脏值不改落点）', () => {
  assert.equal(isTeamSectionRequest('team'), true)
  assert.equal(isTeamSectionRequest('general'), false)
  assert.equal(isTeamSectionRequest(null), false)
  assert.equal(sanitizeRequestedSection('  team  '), 'team')
  assert.equal(sanitizeRequestedSection(42), null)
  assert.equal(sanitizeTeamIntent('create'), 'create')
  assert.equal(sanitizeTeamIntent('join'), 'join')
  for (const bad of ['manage', 'bogus', '', null, undefined, 7, {}]) {
    assert.equal(sanitizeTeamIntent(bad), 'manage', `${JSON.stringify(bad)} 应落回 manage（只显示团队页，不预开表单）`)
  }
})

test('sanitizeWorkspaceMode：非法值一律落回 personal（误判 team 会让界面进入空列表）', () => {
  assert.equal(sanitizeWorkspaceMode('personal'), 'personal')
  assert.equal(sanitizeWorkspaceMode('team'), 'team')
  for (const bad of [null, undefined, '', 'Team', 'TEAM', 0, {}, [], true]) {
    assert.equal(sanitizeWorkspaceMode(bad), 'personal', `非法模式 ${JSON.stringify(bad)} 必须落回 personal`)
  }
  assert.deepEqual([...WORKSPACE_MODES], ['personal', 'team'])
})

test('effectiveMode：没有团队时恒为 personal；团队列表未知时不闪回', () => {
  assert.equal(effectiveMode('team', 0), 'personal', '零团队 ⇒ 团队模式无意义，必须落回个人')
  assert.equal(effectiveMode('team', 2), 'team')
  assert.equal(effectiveMode('personal', 2), 'personal')
  // 团队列表还没读到（null/undefined）：保持原模式，避免首帧把已选团队模式闪回个人
  assert.equal(effectiveMode('team', null), 'team')
  assert.equal(effectiveMode('team', undefined), 'team')
  assert.equal(modeSwitchEnabled(0), false)
  assert.equal(modeSwitchEnabled(undefined), false)
  assert.equal(modeSwitchEnabled(1), true)
})

test('isTeamWorkspace / teamIdOfWorkspace：三条判据 + 旧数据落个人', () => {
  assert.equal(isTeamWorkspace('personal', []), false)
  assert.equal(isTeamWorkspace('', []), false, '空值 = 没有归属字段（D4 之前的数据）⇒ 个人')
  assert.equal(isTeamWorkspace(undefined, []), false)
  assert.equal(isTeamWorkspace('team-t_abc', []), true, 'team- 前缀（kernel/team-sync.mjs 约定）')
  assert.equal(isTeamWorkspace('t_abc', ['t_abc']), true, '显式等于已加入团队的 teamId')
  assert.equal(isTeamWorkspace('team-t_gone', ['t_abc']), true, '前缀命中但团队已不在列表 ⇒ 仍判团队（否则像"数据消失"）')
  assert.equal(isTeamWorkspace('t_gone', ['t_abc']), false, '既无前缀又不是任何团队 id ⇒ 无法认定为团队，按个人归类')
  assert.equal(isTeamWorkspace('personal', ['personal']), false, 'personal 是保留值，不因出现在团队列表里就变团队')
  assert.equal(teamIdOfWorkspace('team-t_abc'), 't_abc')
  assert.equal(teamIdOfWorkspace('t_abc'), null)
  assert.equal(teamIdOfWorkspace(''), null)
  assert.equal(TEAM_WORKSPACE_PREFIX, 'team-')
  assert.equal(PERSONAL_WORKSPACE_ID, 'personal')
})

test('workspaceIdOfItem：缺字段/空串/脏值都落个人桶（不丢项、不误判团队）', () => {
  assert.equal(workspaceIdOfItem({ workspaceId: 'team-t1' }), 'team-t1')
  assert.equal(workspaceIdOfItem({}), 'personal')
  assert.equal(workspaceIdOfItem({ workspaceId: '   ' }), 'personal')
  assert.equal(workspaceIdOfItem({ workspaceId: 42 }), 'personal')
  assert.equal(workspaceIdOfItem(null), 'personal')
})

test('matchesMode：个人模式看不到团队项，团队模式看不到个人项', () => {
  const teamIds = ['t1']
  assert.equal(matchesMode('personal', 'personal', teamIds), true)
  assert.equal(matchesMode('team-t1', 'personal', teamIds), false)
  assert.equal(matchesMode('team-t1', 'team', teamIds), true)
  assert.equal(matchesMode('personal', 'team', teamIds), false)
  assert.equal(matchesMode(undefined, 'personal', teamIds), true)
  assert.equal(matchesMode(undefined, 'team', teamIds), false)
})

test('三个筛选包装：字段口径各自正确（会话/工作流读 workspaceId，知识空间读 id）', () => {
  const teamIds = ['t1']
  const convs = [{ id: 'c1' }, { id: 'c2', workspaceId: 'team-t1' }, { id: 'c3', workspaceId: 'personal' }]
  assert.deepEqual(filterConversationsByMode(convs, 'personal', teamIds).map((c) => c.id), ['c1', 'c3'])
  assert.deepEqual(filterConversationsByMode(convs, 'team', teamIds).map((c) => c.id), ['c2'])

  const flows = [{ id: 'w1', workspaceId: 'team-t1' }, { id: 'w2' }]
  assert.deepEqual(filterWorkflowsByMode(flows, 'team', teamIds).map((w) => w.id), ['w1'])
  assert.deepEqual(filterWorkflowsByMode(flows, 'personal', teamIds).map((w) => w.id), ['w2'])

  const spaces = [{ id: 'experience' }, { id: 'team-t1', source: 'user' }]
  assert.deepEqual(filterKnowledgeSpacesByMode(spaces, 'team', teamIds).map((s) => s.id), ['team-t1'])
  assert.deepEqual(filterKnowledgeSpacesByMode(spaces, 'personal', teamIds).map((s) => s.id), ['experience'])

  // 空/脏输入不抛（列表还没拉到、后端返回 null）
  assert.deepEqual(filterConversationsByMode(null, 'team'), [])
  assert.deepEqual(filterConversationsByMode(undefined, 'personal'), [])
})

test('零回归：未加入任何团队 ⇒ 生效模式恒 personal，且列表逐字不变（团队能力默认关闭）', () => {
  // 既有用户的全部数据（会话/工作流）在 D4 之前没有 workspaceId ⇒ 一律落个人桶。
  // 链路：用户选的模式（哪怕是持久化的 'team'）→ effectiveMode(mode, 0) → 'personal' → 过滤不变。
  const legacy = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3', workspaceId: 'personal' }]
  for (const persisted of ['personal', 'team']) {
    const mode = effectiveMode(persisted, 0)
    assert.equal(mode, 'personal', '零团队时团队模式无意义，必须落回个人')
    assert.deepEqual(
      filterConversationsByMode(legacy, mode, []).map((c) => c.id),
      legacy.map((c) => c.id),
      '未加入团队时列表必须逐字不变（否则就是回归）',
    )
  }
  assert.deepEqual(filterKnowledgeSpacesByMode([{ id: 'experience' }, { id: 'memory' }], effectiveMode('team', 0), []).length, 2)
})

// ---------------------------------------------------------------------------
// 🔴 反向断言①：模式不影响知识检索范围
// ---------------------------------------------------------------------------

test('反向断言①（纯函数）：两种模式的知识检索范围逐字相同，且恒为"全部空间"', () => {
  const personal = knowledgeSearchScopeFor('personal')
  const team = knowledgeSearchScopeFor('team')
  assert.deepEqual(team, personal, '模式不得改变检索范围')
  assert.equal(personal.scope, 'all')
  assert.equal(personal.spaceIds, undefined, 'undefined = 不发 spaces 参数 = 跨全部空间')
  // 连非法模式也不得收窄（守卫函数本身不该有"兜底成窄范围"的分支）
  assert.deepEqual(knowledgeSearchScopeFor('bogus'), personal)
  assert.deepEqual(knowledgeSearchScopeFor(undefined), personal)
})

test('反向断言①（源码级）：知识检索视图走 knowledgeSearchScopeFor，且不引用任何按模式筛选的函数', () => {
  const rel = 'src/components/knowledge/KnowledgeSearchView.tsx'
  assert.ok(existsSync(join(REPO, rel)), `找不到 ${rel}：检索视图改名了就必须同步改这条断言，不能默默失效`)
  const src = read(rel)
  assert.match(
    src,
    /knowledgeSearchScopeFor\(/,
    '检索视图必须经 knowledgeSearchScopeFor 取范围（该函数恒为"全部空间"）；否则"模式不影响检索"这条约束就没有收口点',
  )
  assert.match(src, /modeScope\.spaceIds/, '范围取值必须来自 knowledgeSearchScopeFor 的返回值')
  for (const banned of ['matchesMode', 'filterByMode', 'filterKnowledgeSpacesByMode', 'isTeamWorkspace', 'effectiveMode']) {
    assert.ok(
      !src.includes(banned),
      `${rel} 不得引用 ${banned}：按模式筛选**列表**是允许的，但检索范围必须跨全部空间（spec §5.9 明确的反向要求）`,
    )
  }
})

test('接线守门（源码级）：工作流面板按模式筛选列表，且被筛空时出声', () => {
  // spec §5.9「受模式影响」一栏把"会话 / 工作流 / 知识（列表）"三者并列，故工作流面板必须与
  // ChatListPanel / TaskListPanel 走同一条链路（`useModeFilter()` + `filterXxxByMode`）——
  // 此前它是该栏唯一的漏网项（S3 其余部分均已交付），这条断言就是钉住这个缺口。
  const rel = 'src/components/workflows/WorkflowList.tsx'
  assert.ok(existsSync(join(REPO, rel)), `找不到 ${rel}：工作流列表改名了就必须同步改这条断言，不能默默失效`)
  const src = read(rel)

  assert.match(src, /useModeFilter\(\)/, '模式必须取自 useModeFilter（与 header 开关同一收口），不得自己读 store 拼状态')
  assert.match(src, /filterWorkflowsByMode\(list, wsMode, teamIds\)/, '工作流列表必须经 filterWorkflowsByMode 收口')
  assert.match(
    src,
    /const filtered = kw\s*\?\s*byMode\.filter/,
    '搜索必须建立在模式筛选结果之上：若先搜索后筛选模式，搜索结果会越过模式边界（个人工作流被搜出来）',
  )
  assert.match(src, /team\.listFilteredEmpty/, '团队模式把个人工作流筛空时必须出声（复用会话/任务面板同一文案键）')
  assert.match(
    src,
    /<Badge variant="default">\{byMode\.length\}<\/Badge>/,
    '计数徽标必须与可见卡片数一致，否则会出现"标着 5 张却一张卡片都没有"的界面谎言',
  )
  // 命名纪律：`expose.mode`（public/private 暴露态）与工作区模式（personal/team）同形不同义，
  // 接线不得图省事复用变量名 `mode` —— 那是本文件里最容易被误读的一处。
  assert.ok(
    !/filterWorkflowsByMode\(list, mode[,)]/.test(src),
    `${rel}: 工作区模式不得沿用变量名 mode（那是 expose.mode 的语义），请另起名字（本文件用 wsMode）`,
  )
})
