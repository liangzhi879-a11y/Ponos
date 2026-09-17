// 【团队模式归属】`sanitizeWorkspaceId` 校验语义 + env → 内核会话 meta 的端到端实据
// ---------------------------------------------------------------------------
// 背景（"团队模式下列表永远空"的根因）：归属取自 env `YFW_WORKSPACE_ID`（默认 'personal'），
// 而全仓库此前**没有任何地方设置它**（只有测试设）⇒ 团队模式新建的内容一律落成个人归属，
// 团队筛选自然恒空。本轮接线后，渲染层随消息带来 `workspaceId`，bridge 校验后注入 spawn env。
//
// 因此本文件钉两件事：
//   ① `sanitizeWorkspaceId` 的**拒收面**（安全核心）：该值会被写进磁盘元数据
//     （transcript meta / 工作流 yml），放行任意字符串 = 让渲染层往落盘数据里写任意归属。
//     白名单是"本机已加入团队"，`personal` 是内置工作区**不需要**白名单（反向断言见下）。
//   ② env → 会话 meta 的贯通：**真起一个子进程**（不 mock），在进程环境里给
//     `YFW_WORKSPACE_ID=team-t1`，断言内核 `createSessionStore` 写出的 meta 首行归属为
//     `team-t1` 而不是 personal —— 这是 bridge "只传值、判定在内核" 那条链的下半段。
//     手法与 `kernel-tests/attribution-d4d5.test.mjs` 同源（那里已用 env 注入非默认归属，
//     本文件只是把取值换成真实的团队形态，并额外走一次**跨进程 env 传递**）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { sanitizeWorkspaceId, DEFAULT_WORKSPACE_ID, withAttribution } from '../shared/attribution.mjs'
import { createSessionStore } from '../kernel/session.mjs'

const T1 = 't1'

// ---------------------------------------------------------------------------
// ① 校验语义
// ---------------------------------------------------------------------------
test('sanitizeWorkspaceId：“personal” 是内置工作区，无需白名单（反向断言）', () => {
  assert.equal(sanitizeWorkspaceId('personal'), DEFAULT_WORKSPACE_ID)
  assert.equal(sanitizeWorkspaceId('personal', { teamIds: [] }), 'personal', '空白名单也必须放行 personal')
  assert.equal(sanitizeWorkspaceId('personal', { teamIds: ['t1'] }), 'personal')
  assert.equal(sanitizeWorkspaceId(' personal '), 'personal', '去空白后按同一口径判定')
})

test('sanitizeWorkspaceId：合法团队归属需命中白名单；未命中一律 null（安全核心）', () => {
  assert.equal(sanitizeWorkspaceId('team-t1', { teamIds: [T1] }), 'team-t1')
  assert.equal(sanitizeWorkspaceId('team-t1'), null, '白名单缺省为空 ⇒ 一律拒绝（防伪造）')
  assert.equal(sanitizeWorkspaceId('team-t1', { teamIds: [] }), null)
  assert.equal(sanitizeWorkspaceId('team-t1', { teamIds: ['t2'] }), null, '不在白名单 ⇒ 拒绝')
  assert.equal(sanitizeWorkspaceId('team-team-t1', { teamIds: [T1] }), null, '前缀只消一层：team-team-t1 不是 t1')
})

test('sanitizeWorkspaceId：先 trim 再判定，返回归一化值（空白语义已固定）', () => {
  // 语义选择（本仓库口径）：**先 trim 再判定，返回 trimmed 规范值**。
  // 理由：同一归属带/不带空格必须是同一个值，否则列表筛选会把" team-t1 "与"team-t1"当两者。
  assert.equal(sanitizeWorkspaceId(' team-t1 ', { teamIds: [T1] }), 'team-t1')
  assert.equal(sanitizeWorkspaceId('\tteam-t1\n', { teamIds: [T1] }), 'team-t1')
  assert.equal(sanitizeWorkspaceId(' team-t1 ', { teamIds: [] }), null, 'trim 不改变"仍需白名单"')
  assert.equal(sanitizeWorkspaceId(' team-evil ', { teamIds: [T1] }), null)
})

test('sanitizeWorkspaceId：形态/类型非法一律 null（含路径分隔符与伪造注入）', () => {
  const bad = ['team-', 'team- ', '', '   ', null, undefined, 123, true, {}, [], 'personal2', '../evil',
    'team-../evil', 'team-..\\evil', 'os-/etc/passwd', 'TEAM-t1', 'team_t1', ' team-', '/personal', 'personal/']
  for (const raw of bad) {
    assert.equal(sanitizeWorkspaceId(raw, { teamIds: [T1, 't 1'] }), null, `必须拒绝：${JSON.stringify(raw)}`)
  }
})

test('sanitizeWorkspaceId：白名单里的脏值不会让"带空格的归属"通过', () => {
  assert.equal(sanitizeWorkspaceId('team-t 1', { teamIds: ['t 1'] }), null, '团队 id 含空白 ⇒ 拒绝（不因白名单同名而放行）')
  assert.equal(sanitizeWorkspaceId('team-t1', { teamIds: [' t1 ', 't2'] }), 'team-t1', '白名单侧同样 trim 后比对')
  assert.equal(sanitizeWorkspaceId('team-t1', { teamIds: [T1, null, 7] }), 'team-t1', '白名单里的非字符串项被忽略，不影响合法项')
})

test('sanitizeWorkspaceId：与 withAttribution 串联 —— 校验过的值是该会话的唯一归属来源', () => {
  const ws = sanitizeWorkspaceId(' team-t1 ', { teamIds: [T1] })
  assert.deepEqual(withAttribution({}, { env: { YFW_WORKSPACE_ID: ws } }).workspaceId, 'team-t1')
  assert.equal(sanitizeWorkspaceId('team-evil', { teamIds: [T1] }), null,
    '非法值应被调用方当作"未传"（withAttribution 随后回落默认 personal），而不是写进数据')
  assert.equal(withAttribution({}, { env: {} }).workspaceId, DEFAULT_WORKSPACE_ID)
})

// ---------------------------------------------------------------------------
// ② env → 内核会话 meta（真子进程，无 mock）
// ---------------------------------------------------------------------------
/** 在子进程里建一个内核会话，返回其 transcript 文件路径 */
function createSessionInChildProcess(configDir, sessionId) {
  const script = [
    `import { createSessionStore } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'kernel', 'session.mjs')).href)}`,
    `const store = createSessionStore({ configDir: ${JSON.stringify(configDir)}, cwd: 'C:/proj/team-demo', sessionId: ${JSON.stringify(sessionId)} })`,
    `process.stdout.write(store.file)`,
  ].join('\n')
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    // 与 bridge 的 spawn 同形：**只传值**（判定在内核）。这里刻意不传 YFW_AUTHOR_ID，
    // 以证明 workspaceId 与 authorId 是两条独立链路（作者恒为本人的 L1 口径不变）。
    env: { ...process.env, YFW_WORKSPACE_ID: 'team-t1' },
  })
  assert.equal(r.status, 0, `子进程建会话失败：${r.stderr || r.stdout}`)
  return String(r.stdout).trim()
}

function metaOf(file) {
  return JSON.parse(readFileSync(file, 'utf-8').split('\n')[0])
}

test('内核端到端：spawn env 带 YFW_WORKSPACE_ID=team-t1 时，新会话 meta 归属为 team-t1', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'yfw-ws-team-'))
  try {
    const file = createSessionInChildProcess(configDir, 'sess-team')
    const meta = metaOf(file)
    assert.equal(meta.type, 'meta', 'meta 应为 transcript 首行')
    assert.equal(meta.workspaceId, 'team-t1', '团队模式的新会话必须落团队归属（此前恒为 personal ⇒ 团队列表永远空）')
    assert.notEqual(meta.workspaceId, DEFAULT_WORKSPACE_ID)
    assert.equal(meta.authorId, 'local', 'L1 口径不变：作者恒为本人（未传 YFW_AUTHOR_ID）')
  } finally { rmSync(configDir, { recursive: true, force: true }) }
})

test('内核端到端（对照）：未传该 env 时归属仍是内置的 personal（"未传 = 不改行为"）', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'yfw-ws-personal-'))
  try {
    const env = { ...process.env }
    delete env.YFW_WORKSPACE_ID // 本机若恰好设过同名变量，会掩盖"默认值"这条断言
    const script = [
      `import { createSessionStore } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'kernel', 'session.mjs')).href)}`,
      `const store = createSessionStore({ configDir: ${JSON.stringify(configDir)}, cwd: 'C:/proj/personal-demo', sessionId: 'sess-personal' })`,
      `process.stdout.write(store.file)`,
    ].join('\n')
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8', env })
    assert.equal(r.status, 0, `子进程建会话失败：${r.stderr || r.stdout}`)
    assert.equal(metaOf(String(r.stdout).trim()).workspaceId, DEFAULT_WORKSPACE_ID)
  } finally { rmSync(configDir, { recursive: true, force: true }) }
})

test('内核端到端：同进程内 createSessionStore 也认 env（bridge 注入路径的下半段）', () => {
  // 与 d4d5 同款手法（那里用 ws-d4d5），此处换成团队形态：保证"env 变了、meta 就变"在
  // 进程内也成立 —— 子进程用例证明跨进程传递，本用例证明读取时机（构造 store 时读一次）。
  const saved = process.env.YFW_WORKSPACE_ID
  const configDir = mkdtempSync(join(tmpdir(), 'yfw-ws-inproc-'))
  try {
    process.env.YFW_WORKSPACE_ID = 'team-t1'
    const store = createSessionStore({ configDir, cwd: 'C:/proj/inproc', sessionId: 'sess-inproc' })
    assert.equal(metaOf(store.file).workspaceId, 'team-t1')
  } finally {
    if (saved === undefined) delete process.env.YFW_WORKSPACE_ID; else process.env.YFW_WORKSPACE_ID = saved
    rmSync(configDir, { recursive: true, force: true })
  }
})
