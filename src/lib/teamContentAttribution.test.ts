// src/lib/teamContentAttribution.test.ts —— S3「新建内容带团队归属」的接线守卫（2026-09-17）
//
// 背景（这条链此前**必然为空列表**）：`Conversation.workspaceId` 与工作流元数据的 `workspaceId`
// 早已存在、列表筛选（`filterConversationsByMode` / `filterWorkflowsByMode`）也早已按它判归属，
// 但**没有任何创建路径写入归属** ⇒ 团队模式下的会话列表/任务列表/工作流列表恒为空。
// 本次补上写入侧：`workspaceIdForContent`（唯一收口）+ 会话创建 + 发消息 payload + 工作流保存。
//
// 为什么本文件一半是纯逻辑、一半是源码级断言（照 `teamModeUi.test.ts:176` 与
// `chatStore.test.ts` 的既有风格）：
//   · 纯逻辑断言证明 `workspaceIdForContent` 的分支对（含"绝不产出 `team-` 半截值"这条）；
//   · 但**判对不等于接上**——写入侧有三处（会话 / 发消息 / 工作流），任何一处漏接的表现都是
//     静默的（列表为空，不报错、不抛异常）。故用源码断言钉住"确实调了那一份收口"。
// 本仓库测试跑在 Node 原生 `node --test` 下，别名（`@/...`）不可解析 ⇒ 不得 import store，
// 只读源码文本（与 `chatStore.test.ts` 顶部同一条理由）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { zhCN } from '../i18n/translations/zh-CN.ts'
import { enUS } from '../i18n/translations/en-US.ts'
import {
  workspaceIdForContent, PERSONAL_WORKSPACE_ID, effectiveMode,
} from './teamModeUi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')
/** 取 `from` 到 `to` 之间的源码（`to` 省略 = 到文件尾）；找不到起点直接失败，避免断言静默失效。 */
const sliceBetween = (src: string, from: string, to?: string) => {
  const i = src.indexOf(from)
  assert.ok(i >= 0, `源码里找不到「${from}」——改了函数名就必须同步改这条断言，不能默默失效`)
  const j = to ? src.indexOf(to, i) : -1
  return j > i ? src.slice(i, j) : src.slice(i)
}

// ---------------------------------------------------------------------------
// ① 纯逻辑：workspaceIdForContent 的分支
// ---------------------------------------------------------------------------

test('workspaceIdForContent：个人模式恒 personal（团队能力默认关闭 ⇒ 零回归）', () => {
  assert.equal(PERSONAL_WORKSPACE_ID, 'personal', '必须与内核 shared/attribution.mjs 的 DEFAULT_WORKSPACE_ID 同源')
  assert.equal(workspaceIdForContent('personal', [{ id: 't1' }], 't1'), PERSONAL_WORKSPACE_ID)
  assert.equal(workspaceIdForContent('personal', [{ id: 't1' }], null), PERSONAL_WORKSPACE_ID)
  assert.equal(workspaceIdForContent('personal', null, null), PERSONAL_WORKSPACE_ID)
})

test('workspaceIdForContent：脏模式值归一成个人（落盘 JSON 脏值时不得落团队桶）', () => {
  for (const dirty of ['TEAM', 'team ', '', 'xxx', null, undefined, 1]) {
    assert.equal(
      workspaceIdForContent(dirty as never, [{ id: 't1' }], 't1'),
      PERSONAL_WORKSPACE_ID,
      `模式脏值 ${JSON.stringify(dirty)} 必须回落个人（sanitizeWorkspaceMode 的既有口径）`,
    )
  }
})

test('workspaceIdForContent：团队模式 + activeTeamId → team-<id>（用当前团队）', () => {
  assert.equal(workspaceIdForContent('team', [{ id: 't1' }, { id: 't2' }], 't2'), 'team-t2')
  // activeTeamId 不在列表里（团队被移除/团队源不可达）仍用它：写归属不替用户改选择，
  // 与 modeFlip「个人+已选团队不在列表 → 仍按进团队处理」同一取舍。
  assert.equal(workspaceIdForContent('team', [{ id: 't1' }], 'gone'), 'team-gone')
  // 首尾空白必须 trim（脏值不 trim 就是一条永远筛不出来的归属）
  assert.equal(workspaceIdForContent('team', [{ id: 't1' }], '  t9  '), 'team-t9')
})

test('workspaceIdForContent：团队模式 + 没选团队（空/纯空白）→ 取第一个团队', () => {
  assert.equal(workspaceIdForContent('team', [{ id: 't1' }, { id: 't2' }], null), 'team-t1')
  assert.equal(workspaceIdForContent('team', [{ id: 't1' }, { id: 't2' }], ''), 'team-t1')
  assert.equal(workspaceIdForContent('team', [{ id: '  t1  ' }, { id: 't2' }], null), 'team-t1', '首个团队的 id 也要 trim')
})

test('🔴 workspaceIdForContent：解析不出团队 id → 回落 personal（绝不产出 `team-` 半截值）', () => {
  // 这几支是最危险的：半截值 `team-` 会被 matchesMode 判成团队、又在任何 teamIds 列表里找不到，
  // 形状是"数据在，但永远看不见"（比写 personal 难查得多）。
  assert.equal(workspaceIdForContent('team', null, 't1'), PERSONAL_WORKSPACE_ID, '团队列表还没拉到：宁可这次不写归属')
  assert.equal(workspaceIdForContent('team', null, null), PERSONAL_WORKSPACE_ID)
  assert.equal(workspaceIdForContent('team', [], 't1'), PERSONAL_WORKSPACE_ID, '列表为空 = 没加入任何团队')
  assert.equal(workspaceIdForContent('team', [], null), PERSONAL_WORKSPACE_ID)
  assert.equal(workspaceIdForContent('team', [{ id: '' }], null), PERSONAL_WORKSPACE_ID, '脏列表项（空 id）不算团队')
  assert.equal(workspaceIdForContent('team', [{ id: '   ' }], '   '), PERSONAL_WORKSPACE_ID, '纯空白 id 同上（脏值防御）')
  assert.equal(workspaceIdForContent('team', [{} as { id: string }], null), PERSONAL_WORKSPACE_ID, '缺 id 字段同上')
  const dirtyCases: Array<[{ id: string }[] | null, string | null]> = [
    [null, 't1'], [[], null], [[{ id: '' }], '  '],
  ]
  for (const [teams, active] of dirtyCases) {
    const out = workspaceIdForContent('team', teams, active)
    assert.notEqual(out, 'team-', `${JSON.stringify(teams)} / ${JSON.stringify(active)} 不得产出 team- 半截值`)
    assert.ok(out === PERSONAL_WORKSPACE_ID || /^team-\S/.test(out), `返回值形状非法：${out}`)
  }
})

test('workspaceIdForContent：与 effectiveMode 口径一致（一个团队都没有时恒个人）', () => {
  // 这条钉住"两处判据不许漂移"：effectiveMode 说生效模式是 personal 时，归属也必须落个人。
  // 注意 `teams === null`（还没拉到团队列表）是**刻意的不对称**：effectiveMode 保持原模式
  // （不把用户已选的团队模式闪回个人），但归属必须落 personal —— 因为归属要落盘、错一次就是
  // "再也看不见"，而模式只是筛选显示、可以下一秒就更新。下半段把这条不对称显式钉住。
  const cases: Array<[{ id: string }[] | null, string | null]> = [
    [[], 't1'], [[{ id: 't1' }], 't1'], [[{ id: 't1' }], null],
  ]
  for (const [teams, active] of cases) {
    const eff = effectiveMode('team', teams ? teams.length : null)
    const ws = workspaceIdForContent('team', teams, active)
    if (eff !== 'team') {
      assert.equal(ws, PERSONAL_WORKSPACE_ID, `生效模式为 personal 时归属必须是 personal（teams=${JSON.stringify(teams)}）`)
    } else {
      assert.match(ws, /^team-\S/, `生效模式为 team 且有团队时必须落团队桶（teams=${JSON.stringify(teams)}）`)
    }
  }
  assert.equal(effectiveMode('team', null), 'team', '前提：模式在"列表还没拉到"时保持原值')
  assert.equal(workspaceIdForContent('team', null, 't1'), PERSONAL_WORKSPACE_ID, '而归属此时必须落 personal（见上）')
})

// ---------------------------------------------------------------------------
// 🔴 ② 接线守门（源码级）：写入侧三处都必须调**同一个**收口
// ---------------------------------------------------------------------------

test('接线守门：chatStore.createConversation 写入归属（且源自 workspaceIdForContent）', () => {
  const rel = 'src/stores/chatStore.ts'
  assert.ok(existsSync(join(REPO, rel)), `找不到 ${rel}：改名就必须同步改这条断言`)
  const src = read(rel)
  assert.match(src, /import \{ workspaceIdForContent, PERSONAL_WORKSPACE_ID \} from '@\/lib\/teamModeUi'/,
    '必须复用纯逻辑收口（自己拼 `team-` 前缀 = 迟早漂移）')
  assert.match(src, /useTeamStore\.getState\(\)/, '归属必须取自 teamStore 的当前状态（模式 + 团队 + 当前团队）')
  // 起点用**实现签名**（带 `= 'task'` 默认值那处），不能用接口声明那处——接口在前，
  // slice 会贴着接口取出一段根本不含实现的源码（断言看着通过、其实什么都没查）。
  const body = sliceBetween(src, "createConversation: (cwd?: string, agentId?: string, mode: 'chat' | 'task' = 'task')", 'getOrCreateAppConversation:')
  assert.match(body, /workspaceIdForContent\(/, '新建会话必须经 workspaceIdForContent 取归属')
  assert.match(body, /workspaceId/, '归属必须真的写进 Conversation')
  // 归属必须落在**构造 Conversation 的那一处**（而不是只算了没写）
  const conv = sliceBetween(body, 'const conversation: Conversation = {', 'set(state => ({')
  assert.match(conv, /workspaceId/, 'workspaceId 必须进 Conversation 字面量（算了不写 = 没接线）')
  // 🔴 反向断言：**只在归属非 personal 时**才落字段 —— 否则个人模式的落盘结果会多一个键，
  // 既有持久化数据/快照就不再逐字节一致（"零回归"这条会静默破掉）。
  assert.match(
    conv,
    /\.\.\.\(workspaceId !== PERSONAL_WORKSPACE_ID \? \{ workspaceId \} : \{\}\)/,
    '必须写成"非 personal 才落字段"的条件展开：personal 会话不得多出 workspaceId 键',
  )
  // partialize 是**显式取字段**白名单：漏掉 workspaceId = 归属重启后静默丢失
  // （表现成"我刚在团队模式下建的会话，重启后不见了"）。
  const persist = sliceBetween(src, 'partialize: (state) => ({', 'conversationSets:')
  assert.match(persist, /workspaceId: c\.workspaceId/, 'partialize 白名单必须包含 workspaceId')
})

test('接线守门：发消息 payload 带上会话自己的 workspaceId（bridge → 内核 → transcript）', () => {
  const rel = 'src/hooks/useYFWCLI.ts'
  assert.ok(existsSync(join(REPO, rel)), `找不到 ${rel}：改名就必须同步改这条断言`)
  const src = read(rel)
  // 全部发消息路径（send / 插话 / 换桥续接 / 回答提问）共用同一个字段集构造函数
  // ⇒ 断言做在这一处，覆盖到每一条 payload。
  const fields = sliceBetween(src, 'function conversationSpawnFields(', 'function buildSendPayload(')
  assert.match(
    fields,
    /\.\.\.\(conversation\.workspaceId \? \{ workspaceId: conversation\.workspaceId \} : \{\}\)/,
    'payload 必须带 workspaceId，且取值是**该会话自己的** workspaceId',
  )
  assert.match(fields, /\.\.\.\(conversation\.appPageId/, '归属必须与 appPageId 同款"缺失即不发该键"的纪律')
  // 🔴 反向断言：发消息**不得**用"当前模式"兜底。对一条个人会话按当前团队模式兜底，会把
  // 个人会话的新消息写进团队桶（数据串桶，事后无法分辨是哪个会话错写的）。
  assert.doesNotMatch(src, /workspaceIdForContent|useTeamStore/,
    '发消息路径不得引入"当前模式"：归属只能来自会话自身字段')
  // 每条 send 都经 buildSendPayload（不得另开一处 payload 构造点漏掉归属）
  const sendBuilders = src.match(/type: 'send'/g) ?? []
  assert.equal(sendBuilders.length, 1, 'send payload 的构造点只应有 buildSendPayload 一处（多处 = 容易漏带归属）')
})

test('接线守门：工作流三条写路径（新建 / 画布保存 / YAML 保存）都提交 workspaceId', () => {
  const rel = 'src/lib/workflowApi.ts'
  assert.ok(existsSync(join(REPO, rel)), `找不到 ${rel}：改名就必须同步改这条断言`)
  const src = read(rel)
  assert.match(src, /import \{ workspaceIdForContent, PERSONAL_WORKSPACE_ID \} from '@\/lib\/teamModeUi'/,
    '归属必须经同一份收口计算')
  const helper = sliceBetween(src, 'function attributionBody(', 'export function listWorkflows(')
  assert.match(helper, /workspaceIdForContent\(/, '收口调用必须在 attributionBody 里')
  assert.match(
    helper,
    /workspaceId === PERSONAL_WORKSPACE_ID \? \{\} : \{ workspaceId \}/,
    '🔴 只有团队模式下才带该键：个人模式的请求体必须与今日逐字节相同',
  )
  for (const [from, to] of [
    ['export function saveWorkflow(', 'export function createWorkflow('],
    ['export function createWorkflow(', 'export function saveWorkflowYaml('],
    ['export function saveWorkflowYaml(', 'export function deleteWorkflow('],
  ] as const) {
    const fn = sliceBetween(src, from, to)
    assert.match(fn, /attributionBody\(\)/, `${from}… 的请求体必须带上归属（漏一处 = 那个入口存的工作流在团队模式里看不见）`)
  }
  // 反向断言：不得在前端自己拼前缀（前缀约定属于内核 shared/attribution.mjs）
  assert.doesNotMatch(src, /`team-\$\{/, '不得自行拼接 team- 前缀：那是 workspaceIdForContent（与内核同源）的职责')
})

// ---------------------------------------------------------------------------
// ④ 文案：modeHint 补回"新建内容带归属"，且中英一一对应
// ---------------------------------------------------------------------------

test('i18n：modeHint 在 zh/en 都提到"团队模式下新建的内容归入该团队"', () => {
  const zh = ((zhCN as { team?: Record<string, unknown> }).team ?? {})
  const en = ((enUS as { team?: Record<string, unknown> }).team ?? {})
  const zhHint = String(zh.modeHint ?? '')
  const enHint = String(en.modeHint ?? '')
  assert.ok(zhHint.length > 20 && enHint.length > 20, 'modeHint 缺失或过短')
  // zh：必须同时保留"只筛列表"（§5.9 正向）与"新建内容带归属"（本次实现的能力）
  assert.match(zhHint, /筛选范围/, '必须保留"模式只影响筛选范围"这句')
  assert.match(zhHint, /团队模式下\*\*新建\*\*的会话、任务与工作流会归入该团队/, '必须补回归属说明（否则用户不知道团队里的内容从哪来）')
  assert.match(enHint, /created\*\* while in team mode are attributed to that team/, '英文必须一一对应')
  assert.doesNotMatch(enHint, /[一-龥]/, 'en-US.team.modeHint 不得混入中文')
  // 🔴 仍不得写成"默认归属"：归属由**当前模式 + 当前团队**决定，不是静态默认值
  // （反向断言由 `teamModeIndicatorUi.test.ts` 持有，这里同向再钉一次）。
  for (const text of [zhHint, enHint]) {
    assert.doesNotMatch(text, /默认归属|default attribution|default owner/i)
  }
})

test('i18n：team 区块 zh/en 键一一对应，且 modeNotIsolationNote 的"不是隔离"保持不变', () => {
  const zh = ((zhCN as { team?: Record<string, unknown> }).team ?? {})
  const en = ((enUS as { team?: Record<string, unknown> }).team ?? {})
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'team 区块出现单语言专有键（另一语言会渲染出裸键名）')
  assert.match(String(zh.modeNotIsolationNote ?? ''), /不是数据隔离/, '§5.9 反向要求：模式 ≠ 隔离，这句必须保留')
  assert.match(String(en.modeNotIsolationNote ?? ''), /not data isolation/i)
})
