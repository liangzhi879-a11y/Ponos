// server/workspace-attribution-wiring.test.mjs —— 「团队模式下新建内容带团队归属」的**桥侧接线**回归网
// ---------------------------------------------------------------------------
// 覆盖两段：
//   ① **行为**：工作流存储/路由确实"按请求携带的归属"落盘（`writeWorkflowYml` + `/workflows` 保存路径），
//     并保持"未传/非法 = 回落既有归属"（旧行为不变）。
//   ② **接线**（源码级断言）：bridge 的三处关键接线 —— 校验函数被调用、校验后的值进 spawn env、
//     两处 `getOrCreateSession` 调用点都传；以及 bridge 把团队白名单注入工作流路由。
//
// 为什么不测真 WS：`server/bridge.mjs` **顶层就会 listen(51517)**，测试 import 它会真起桥、
// 并可能 taskkill 用户正在运行的应用（该文件头部与本仓库所有 bridge* 测试的既有结论）。
// 归属链路上 bridge 只做三件可静态核对的事（校验 → env → 传参），真正的语义由
// `kernel-tests/attribution-workspace.test.mjs`（校验函数 + 内核侧 env→meta 端到端）覆盖；
// 这里补的正是"bridge 这段胶水有没有接上"——它一旦漏接就是"前端传了、内核收不到"，
// 表现与本次要修的 bug 一模一样（列表恒空）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleWorkflowRoute } from './workflow-routes.mjs'
import * as store from './workflow-store.mjs'

const ROOT_DIR = join(import.meta.dirname, '..')
const read = (rel) => readFileSync(join(ROOT_DIR, rel), 'utf-8')

const YML = 'name: demo\nversion: 1.0.0\nnodes:\n  - { id: s, type: start }\nedges:\n  - { id: e1, source: s, target: s }\n'

function mkRoot() {
  const home = mkdtempSync(join(tmpdir(), 'wf-ws-attr-'))
  const root = join(home, 'workflows')
  mkdirSync(root, { recursive: true })
  return { home, root, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/** 用指定的 env 归属跑一段（结束后恢复，避免污染同进程其他用例） */
function withEnvWorkspace(value, fn) {
  const saved = process.env.YFW_WORKSPACE_ID
  if (value === undefined) delete process.env.YFW_WORKSPACE_ID; else process.env.YFW_WORKSPACE_ID = value
  try { return fn() } finally {
    if (saved === undefined) delete process.env.YFW_WORKSPACE_ID; else process.env.YFW_WORKSPACE_ID = saved
  }
}

const metaOf = (root, id) => store.parseWorkflowMeta(store.readWorkflowYml({ root, id }))

function mkReply() {
  const out = {}
  return { out, reply: (code, headers, body) => { out.code = code; out.headers = headers; out.body = JSON.parse(body) } }
}
const reqOf = (method, url, body) => ({ method, url, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } })

function setupRoute() {
  const { home, root, cleanup } = mkRoot()
  const runsRoot = join(home, 'workflow-runs')
  const host = {
    load: async (id) => ({ ok: true, id, model: { name: id, nodes: [], edges: [] }, yml: YML }),
    validate: async (id) => ({ ok: true, errors: [], warnings: [] }),
    // 宿主只回内容：归属**不是**宿主的事（渲染层 → 路由 → 存储收口）
    save: async ({ id, yaml }) => ({ ok: true, id, yml: yaml || YML }),
    run: async () => ({ ok: true }), stop: async () => ({ ok: true }), confirm: () => ({ ok: true }),
  }
  return { home, root, runsRoot, host, cleanup }
}

// ---------------------------------------------------------------------------
// ① 存储层：请求携带的归属优先；非法/未传回落既有 env 归属
// ---------------------------------------------------------------------------
test('writeWorkflowYml：请求携带的 workspaceId 落盘（白名单命中）并覆盖 env 归属', () => {
  const { root, cleanup } = mkRoot()
  try {
    withEnvWorkspace('ws-from-env', () => {
      store.writeWorkflowYml({ root, id: 'from-req', yml: YML, workspaceId: 'team-t1', teamIds: ['t1'] })
      assert.equal(metaOf(root, 'from-req').workspaceId, 'team-t1',
        '请求携带的归属必须优先于 bridge 进程 env（bridge 长驻、一个进程服务个人与团队 ⇒ 进程级 env 会串味）')
    })
  } finally { cleanup() }
})

test('writeWorkflowYml：未传或非法值 → 回落既有 env 归属（"未传 = 不改行为"）', () => {
  const { root, cleanup } = mkRoot()
  try {
    withEnvWorkspace('ws-from-env', () => {
      store.writeWorkflowYml({ root, id: 'no-req', yml: YML })
      assert.equal(metaOf(root, 'no-req').workspaceId, 'ws-from-env', '未传 ⇒ 与改动前完全一致（仍是 env/默认）')

      store.writeWorkflowYml({ root, id: 'bad-req', yml: YML, workspaceId: 'team-evil', teamIds: ['t1'] })
      assert.equal(metaOf(root, 'bad-req').workspaceId, 'ws-from-env',
        '伪造的团队 id 不得进磁盘；但也不阻断写入（归属是元数据）')

      store.writeWorkflowYml({ root, id: 'bad-req2', yml: YML, workspaceId: '../evil', teamIds: ['t1'] })
      assert.equal(metaOf(root, 'bad-req2').workspaceId, 'ws-from-env', '含路径分隔符等非法形态同样拒绝')
    })
    withEnvWorkspace(undefined, () => {
      store.writeWorkflowYml({ root, id: 'personal-ws', yml: YML, workspaceId: 'personal' })
      assert.equal(metaOf(root, 'personal-ws').workspaceId, 'personal', 'personal 无需白名单')
      store.writeWorkflowYml({ root, id: 'no-team', yml: YML, workspaceId: 'team-t1', teamIds: [] })
      assert.equal(metaOf(root, 'no-team').workspaceId, 'personal', '不在白名单 ⇒ 回落内置个人工作区')
    })
  } finally { cleanup() }
})

// ---------------------------------------------------------------------------
// ② 路由层：body.workspaceId → 落盘；非法值丢弃且**不影响保存成功**
// ---------------------------------------------------------------------------
test('POST /workflows：body.workspaceId（已加入团队）落盘；非法值被丢弃但保存仍 200', async () => {
  const { root, runsRoot, host, cleanup } = setupRoute()
  try {
    await withEnvWorkspace(undefined, async () => {
      const { out, reply } = mkReply()
      await handleWorkflowRoute({
        url: new URL('http://x/workflows'), req: reqOf('POST', '/workflows', { id: 'team-flow', workspaceId: ' team-t1 ', teamIds: ['t1'] }),
        reply, readJsonBody: async () => ({ id: 'team-flow', workspaceId: ' team-t1 ', teamIds: ['t1'] }),
        store, host, root, runsRoot, teamIds: ['t1'],
      })
      assert.equal(out.body.ok, true)
      assert.equal(metaOf(root, 'team-flow').workspaceId, 'team-t1', '带空白的合法值按归一化后的规范值落盘')

      const bad = mkReply()
      await handleWorkflowRoute({
        url: new URL('http://x/workflows'), req: reqOf('POST', '/workflows', { id: 'evil-flow', workspaceId: 'team-evil' }),
        reply: bad.reply, readJsonBody: async () => ({ id: 'evil-flow', workspaceId: 'team-evil' }),
        store, host, root, runsRoot, teamIds: ['t1'],
      })
      assert.equal(bad.out.body.ok, true, '归属非法**不得**让保存失败（归属是元数据，不该阻断主链路）')
      assert.equal(metaOf(root, 'evil-flow').workspaceId, 'personal', '非法归属按未传处理，落回既有默认')
    })
  } finally { cleanup() }
})

test('PUT /workflows/:id：保存路径同样按请求归属落盘', async () => {
  const { root, runsRoot, host, cleanup } = setupRoute()
  try {
    await withEnvWorkspace(undefined, async () => {
      const { out, reply } = mkReply()
      await handleWorkflowRoute({
        url: new URL('http://x/workflows/demo'), req: reqOf('PUT', '/workflows/demo', { workspaceId: 'team-t2' }),
        reply, readJsonBody: async () => ({ workspaceId: 'team-t2' }),
        store, host, root, runsRoot, teamIds: ['t1', 't2'],
      })
      assert.equal(out.body.ok, true)
      assert.equal(metaOf(root, 'demo').workspaceId, 'team-t2')
    })
  } finally { cleanup() }
})

// ---------------------------------------------------------------------------
// ③ 源码级接线断言（bridge 顶层 listen ⇒ 不能 import）
// ---------------------------------------------------------------------------
test('bridge 接线：workspaceId 过校验 → 进 spawn env，且两处 getOrCreateSession 都传', () => {
  const src = read('server/bridge.mjs')
  assert.match(src, /import \{ sanitizeWorkspaceId \} from '\.\.\/shared\/attribution\.mjs'/,
    'bridge 必须复用 shared 的校验实现（各自写一份必漂移）')
  assert.match(src, /function sanitizeClientWorkspaceId\(raw/, '校验入口必须是**模块内可复用**的小函数（两处调用点共用）')
  assert.match(src, /sanitizeWorkspaceId\(raw, \{ teamIds: joinedTeamIds\(\) \}\)/, '白名单必须来自本机已加入团队')
  assert.match(src, /function getOrCreateSession\([^)]*workspaceId = null\)/, 'getOrCreateSession 追加第 10 个位置参数')
  assert.match(src, /YFW_WORKSPACE_ID: workspaceId/, '必须注入 spawn env（只传值、判定在内核）')
  assert.match(src, /\.\.\.\(workspaceId \? \{ YFW_WORKSPACE_ID: workspaceId \} : \{\}\)/,
    '未传时**不设**该 env（内核走自己的默认 personal ⇒ 未传不改行为）')
  // 两处调用点：send 分支与 answer 的"内核已回收 → 重 spawn"分支。漏一处 = 同一会话两个归属。
  const callSites = src.match(/getOrCreateSession\([^)]*msg\.knowledgeSpaces, msg\.appPageId, workspaceId\)/g) || []
  assert.equal(callSites.length, 2, `send 与 answer 两处都必须传 workspaceId（实际 ${callSites.length} 处）`)
  assert.equal((src.match(/sanitizeClientWorkspaceId\(msg\.workspaceId/g) || []).length, 2,
    '两处都必须经校验（收下不校验 = 任意字符串进元数据）')
  // 工作流归属：bridge 把团队白名单注入路由（路由不读盘）
  assert.match(src, /handleWorkflowRoute\(\{[^}]*teamIds: joinedTeamIds\(\)/s,
    '工作流路由必须拿到团队白名单（否则合法团队归属也会被拒）')
  assert.ok(!/teamStatus\(/.test(src.slice(src.indexOf('handleWorkflowRoute({'), src.indexOf('handleWorkflowRoute({') + 300)),
    '白名单不许改用 teamStatus（每次发消息验签成员链 + 量目录体积，太重）')
})

test('workflow-routes 接线：body.workspaceId 先校验再随写入落盘', () => {
  const src = read('server/workflow-routes.mjs')
  assert.match(src, /import \{ sanitizeWorkspaceId \} from '\.\.\/shared\/attribution\.mjs'/)
  assert.match(src, /const workspaceIdOf = \(body\) =>/, '校验必须收口成一个函数（POST/PUT 两处共用）')
  assert.match(src, /sanitizeWorkspaceId\(body && body\.workspaceId, \{ teamIds \}\)/, '白名单由 bridge 注入')
  const writes = src.match(/store\.writeWorkflowYml\(\{ root, id, yml: saved\.yml, workspaceId: workspaceIdOf\(body\), teamIds \}\)/g) || []
  assert.equal(writes.length, 2, `POST /workflows 与 PUT /workflows/:id 两条保存路径都要带归属（实际 ${writes.length} 处）`)
  assert.match(src, /【团队模式归属】/, '中文注释写清背景（团队模式归属）与"非法值只丢弃不拒请求"的理由')
})
