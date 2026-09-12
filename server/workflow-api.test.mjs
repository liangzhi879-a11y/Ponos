// server/workflow-api.test.mjs —— /workflows 路由单测（直接调路由函数，不起服务）
//
// 注意：必须从 workflow-routes.mjs 导入，不能 import bridge.mjs
//（bridge.mjs 顶层 listen(51517)，测试里会真起桥并可能 taskkill 用户运行中的应用）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleWorkflowRoute } from './workflow-routes.mjs'
import { createWorkflowHost, HOST_SID } from './workflow-host.mjs'
import * as store from './workflow-store.mjs'

function mkReply() {
  const out = {}
  return { out, reply: (code, headers, body) => { out.code = code; out.headers = headers; out.body = JSON.parse(body) } }
}
const reqOf = (method, url, body) => ({ method, url, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } })

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'wf-api-'))
  const root = join(home, 'workflows')
  const runsRoot = join(home, 'workflow-runs')
  mkdirSync(root, { recursive: true })
  const host = {
    load: async (id) => ({ ok: true, id, model: { name: id, nodes: [], edges: [] }, yml: 'name: x\nnodes: []\nedges: []\n' }),
    validate: async (id) => ({ ok: true, errors: [], warnings: [] }),
    save: async ({ id, model, yaml }) => ({ ok: true, id, yml: yaml || `name: ${id}\nnodes: []\nedges: []\n` }),
    run: async ({ id, inputs }) => ({ ok: true, id, status: 'completed', steps: 2, runId: 'r1', inputs }),
    stop: async () => ({ ok: true }),
    confirm: () => ({ ok: true }),
  }
  return { home, root, runsRoot, host, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const YML = 'name: demo\nversion: 1.0.0\nnodes:\n  - { id: s, type: start }\nedges:\n  - { id: e1, source: s, target: s }\n'

test('GET /workflows：列表（含 legacy 标记）', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    store.createWorkflow({ root, id: 'demo', yml: YML })
    const { out, reply } = mkReply()
    const handled = await handleWorkflowRoute({ url: new URL('http://x/workflows'), req: reqOf('GET', '/workflows'), reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    assert.equal(handled, true)
    assert.equal(out.body.workflows.length, 1)
    assert.equal(out.body.workflows[0].id, 'demo')
    assert.equal(out.body.workflows[0].legacy, false)
    assert.equal(out.body.root, root.replace(/\\/g, '/'))
  } finally { cleanup() }
})

test('PUT /workflows/:id：存盘并回传内核校验错误', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    const { out, reply } = mkReply()
    // root 必须显式传入：默认 '' 会把工作流写进进程 CWD（测试污染仓库 + 断言落空）
    await handleWorkflowRoute({ url: new URL('http://x/workflows/demo'), req: reqOf('PUT', '/workflows/demo', { model: { name: 'demo' } }), reply, readJsonBody: async () => ({ model: { name: 'demo' } }), store, host, root, runsRoot })
    assert.equal(out.body.ok, true)
    assert.ok(existsSync(join(root, 'demo', 'workflow.yml')))
    assert.equal(readFileSync(join(root, 'demo', 'workflow.yml'), 'utf-8'), 'name: demo\nnodes: []\nedges: []\n')

    const bad = mkReply()
    await handleWorkflowRoute({
      url: new URL('http://x/workflows/demo2'), req: reqOf('PUT', '/workflows/demo2'), reply: bad.reply, readJsonBody: async () => ({ model: {} }),
      store, host: { ...host, save: async () => ({ ok: false, error: '校验失败', errors: [{ code: 'NO_START' }] }) }, root, runsRoot,
    })
    assert.equal(bad.out.code, 400)
    assert.equal(bad.out.body.errors[0].code, 'NO_START')
    assert.equal(existsSync(join(root, 'demo2', 'workflow.yml')), false, '内核校验失败不得落盘（单一写者，fail-closed）')
  } finally { cleanup() }
})

test('POST /workflows：新建（id 必填 + 先内核校验后落盘）', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    const noId = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows'), req: reqOf('POST', '/workflows', { model: {} }), reply: noId.reply, readJsonBody: async () => ({ model: {} }), store, host, root, runsRoot })
    assert.equal(noId.out.code, 400)
    assert.match(noId.out.body.error, /id 必填/)

    const ok = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows'), req: reqOf('POST', '/workflows', { id: 'fresh', model: { name: 'fresh' } }), reply: ok.reply, readJsonBody: async () => ({ id: 'fresh', model: { name: 'fresh' } }), store, host, root, runsRoot })
    assert.equal(ok.out.code, 200)
    assert.equal(ok.out.body.id, 'fresh')
    assert.ok(existsSync(join(root, 'fresh', 'workflow.yml')))

    // 保留字 id（RUN 等动作为子路由）→ 存储层拒绝，路由映射为 400（不是 500）
    const res = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/verify'), req: reqOf('PUT', '/workflows/verify', { model: {} }), reply: res.reply, readJsonBody: async () => ({ model: {} }), store, host, root, runsRoot })
    assert.equal(res.out.code, 400)
    assert.match(res.out.body.error, /保留字|非法/)
  } finally { cleanup() }
})

test('POST /workflows/run：授权清单透传宿主，未带清单则 400', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    const okr = mkReply()
    let seen = null
    await handleWorkflowRoute({ url: new URL('http://x/workflows/run'), req: reqOf('POST', '/workflows/run'), reply: okr.reply, readJsonBody: async () => ({ id: 'demo', inputs: { q: 1 }, capabilities: { tools: ['Read'] } }), store, host: { ...host, run: async (a) => { seen = a; return { ok: true, runId: 'r9' } } }, root, runsRoot })
    assert.equal(okr.out.body.ok, true)
    assert.deepEqual(seen.capabilities.tools, ['Read'])

    const bad = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/run'), req: reqOf('POST', '/workflows/run'), reply: bad.reply, readJsonBody: async () => ({ id: 'demo' }), store, host, root, runsRoot })
    assert.equal(bad.out.code, 400, '缺 capabilities 应拒绝（授权清单是运行前置）')

    const failed = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/run'), req: reqOf('POST', '/workflows/run'), reply: failed.reply, readJsonBody: async () => ({ id: 'demo', capabilities: { tools: [] } }), store, host: { ...host, run: async () => ({ ok: false, error: 'LEGACY_DSL', code: 'LEGACY_DSL' }) }, root, runsRoot })
    assert.equal(failed.out.code, 400)
    assert.equal(failed.out.body.code, 'LEGACY_DSL')
  } finally { cleanup() }
})

// —— 异步运行（2026-09-12）——
// 原实现 POST /workflows/run 同步等待内核跑完（spec-dev 实测 80–110 秒）才回执，界面在等待期
// 零反馈 → 用户重复点击 → 同一工作流并行多份重跑（实测 20 秒内 3 份）。异步化后本路由只负责
// **提交**：宿主 startRun 立即回 { runId, status:'running' }，过程走 WS 事件流，终态查 run-status。
test('POST /workflows/run：异步提交——宿主 startRun 立即回 runId，不等待运行结束', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    let release = null
    let seenArgs = null
    const { out, reply } = mkReply()
    const slowHost = {
      ...host,
      // 后台永不主动 resolve（模拟 spec-dev 这类长跑）：若路由仍在等待运行结果，本测试会超时。
      startRun: (a) => { release = true; seenArgs = a; return { ok: true, runId: a.runId, status: 'running', started: true } },
      run: async () => { throw new Error('不应走同步 run（宿主已实现 startRun）') },
    }
    const t0 = Date.now()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/run'), req: reqOf('POST', '/workflows/run'), reply, readJsonBody: async () => ({ id: 'demo', capabilities: { tools: [] }, runId: 'run-mine-1' }), store, host: slowHost, root, runsRoot })
    assert.equal(out.code, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.runId, 'run-mine-1')
    assert.equal(out.body.status, 'running')
    assert.equal(release, true)
    assert.equal(seenArgs.runId, 'run-mine-1', '客户端预生成的 runId 必须透传（前端提交前认领事件归属用）')
    assert.ok(Date.now() - t0 < 1000, '提交应毫秒级返回，不得等待运行结束')
  } finally { cleanup() }
})

test('GET /workflows/run-status：运行中 / 终态 / 未知三态', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    const running = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/run-status?runId=r1'), req: reqOf('GET', '/workflows/run-status?runId=r1'), reply: running.reply, readJsonBody: async () => ({}), store, host: { ...host, runResult: () => ({ ok: true, runId: 'r1', status: 'running', finished: false }) }, root, runsRoot })
    assert.equal(running.out.body.finished, false)
    assert.equal(running.out.body.status, 'running')

    const done = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/run-status?runId=r2'), req: reqOf('GET', '/workflows/run-status?runId=r2'), reply: done.reply, readJsonBody: async () => ({}), store, host: { ...host, runResult: () => ({ ok: true, runId: 'r2', status: 'completed', finished: true, finalOutput: { msg: 'hi' } }) }, root, runsRoot })
    assert.equal(done.out.body.finished, true)
    assert.deepEqual(done.out.body.finalOutput, { msg: 'hi' })

    // unknown（宿主重启/超缓存）：2xx 但带 unknown 标记，前端据此停止轮询并提示
    const unknown = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/run-status?runId=gone'), req: reqOf('GET', '/workflows/run-status?runId=gone'), reply: unknown.reply, readJsonBody: async () => ({}), store, host: { ...host, runResult: () => ({ ok: false, runId: 'gone', unknown: true, error: '未知 runId' }) }, root, runsRoot })
    assert.equal(unknown.out.body.ok, false)
    assert.equal(unknown.out.body.unknown, true)

    const noId = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/run-status'), req: reqOf('GET', '/workflows/run-status'), reply: noId.reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    assert.equal(noId.out.code, 400, 'runId 必填')
  } finally { cleanup() }
})

test('stop / confirm / validate / runs 透传宿主与审计目录', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    let stopped = null
    const stop = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/stop'), req: reqOf('POST', '/workflows/stop', { runId: 'r1' }), reply: stop.reply, readJsonBody: async () => ({ runId: 'r1' }), store, host: { ...host, stop: async (runId) => { stopped = runId; return { ok: true } } }, root, runsRoot })
    assert.equal(stopped, 'r1')
    assert.equal(stop.out.body.ok, true)

    let confirmed = null
    const cf = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/confirm'), req: reqOf('POST', '/workflows/confirm', { runId: 'r1', node: 'n2' }), reply: cf.reply, readJsonBody: async () => ({ runId: 'r1', node: 'n2', action: 'approved' }), store, host: { ...host, confirm: (b) => { confirmed = b; return { ok: true } } }, root, runsRoot })
    assert.equal(confirmed.node, 'n2')
    assert.equal(cf.out.body.ok, true)

    const v = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/demo/validate'), req: reqOf('GET', '/workflows/demo/validate'), reply: v.reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    assert.deepEqual(v.out.body, { ok: true, errors: [], warnings: [] })

    // 审计记录：<runsRoot>/<name>/<file>.jsonl
    mkdirSync(join(runsRoot, 'demo'), { recursive: true })
    writeFileSync(join(runsRoot, 'demo', '2026-01-01T00-00-00.jsonl'), '{"status":"completed"}\n', 'utf-8')
    const r = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/runs?name=demo'), req: reqOf('GET', '/workflows/runs?name=demo'), reply: r.reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    assert.equal(r.out.body.runs.length, 1)
    assert.equal(r.out.body.runs[0].status, 'completed')
  } finally { cleanup() }
})

test('GET/PUT /workflows/bindings：信任清单往返', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    const empty = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/bindings'), req: reqOf('GET', '/workflows/bindings'), reply: empty.reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    // ok:true 是契约（2026-09-12）：客户端以 body.ok === false 判失败，成功回执缺 ok 字段时
    // UI 会走 `if (!r.ok)` 失败分支——实测表现为「列表恒空」+「读取信任清单失败：undefined」。
    assert.deepEqual(empty.out.body, { ok: true, agents: {}, trusted: [] })

    const put = mkReply()
    const payload = { agents: { 'a1': ['demo'] }, trusted: ['demo'] }
    await handleWorkflowRoute({ url: new URL('http://x/workflows/bindings'), req: reqOf('PUT', '/workflows/bindings', payload), reply: put.reply, readJsonBody: async () => payload, store, host, root, runsRoot })
    assert.equal(put.out.body.ok, true)

    const again = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/bindings'), req: reqOf('GET', '/workflows/bindings'), reply: again.reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    assert.deepEqual(again.out.body.trusted, ['demo'])

    // 方法白名单（Task 12 审查 I-2）：POST/DELETE 不得落进写分支，且回 405（不是「路由不存在」的 404）
    for (const method of ['POST', 'DELETE', 'PATCH']) {
      const no = mkReply()
      await handleWorkflowRoute({ url: new URL('http://x/workflows/bindings'), req: reqOf(method, '/workflows/bindings', {}), reply: no.reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
      assert.equal(no.out.code, 405, `${method} /workflows/bindings 应回 405`)
      assert.match(no.out.body.error, /方法不允许/)
    }
    // 405 之后绑定表必须原封不动（非 GET/PUT 不得写盘）
    const after = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/bindings'), req: reqOf('GET', '/workflows/bindings'), reply: after.reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    assert.deepEqual(after.out.body, { ok: true, ...payload })
  } finally { cleanup() }
})

test('版本 / 回滚 / 导出 / 导入 / 复制 / 删除', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    store.createWorkflow({ root, id: 'demo', yml: YML })
    // 第二次写盘产生 v1 快照
    const put = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/demo'), req: reqOf('PUT', '/workflows/demo', { model: {} }), reply: put.reply, readJsonBody: async () => ({ model: {} }), store, host, root, runsRoot })
    assert.equal(put.out.body.ok, true)

    const vers = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/demo/versions'), req: reqOf('GET', '/workflows/demo/versions'), reply: vers.reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    assert.equal(vers.out.body.versions.length, 1)

    const rb = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/demo/rollback'), req: reqOf('POST', '/workflows/demo/rollback', { ts: vers.out.body.versions[0].ts }), reply: rb.reply, readJsonBody: async () => ({ ts: vers.out.body.versions[0].ts }), store, host, root, runsRoot })
    assert.equal(rb.out.body.ok, true)
    assert.equal(readFileSync(join(root, 'demo', 'workflow.yml'), 'utf-8'), YML, '回滚应恢复快照原文')

    // 穿越版本号 → 400（不得读出工作流目录之外的文件）
    const evil = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/demo/rollback'), req: reqOf('POST', '/workflows/demo/rollback', { ts: '../../secret' }), reply: evil.reply, readJsonBody: async () => ({ ts: '../../secret' }), store, host, root, runsRoot })
    assert.equal(evil.out.code, 400)

    const exp = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/demo/export'), req: reqOf('GET', '/workflows/demo/export'), reply: exp.reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    assert.equal(exp.out.body.bundle.format, 'yfworking-workflow')
    assert.equal(exp.out.body.filename, 'demo.yfwflow')

    const imp = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/import'), req: reqOf('POST', '/workflows/import', { bundle: exp.out.body.bundle, id: 'copy' }), reply: imp.reply, readJsonBody: async () => ({ bundle: exp.out.body.bundle, id: 'copy' }), store, host, root, runsRoot })
    assert.equal(imp.out.body.id, 'copy')
    assert.ok(existsSync(join(root, 'copy', 'workflow.yml')))

    const miss = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/nope/export'), req: reqOf('GET', '/workflows/nope/export'), reply: miss.reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    assert.equal(miss.out.code, 404)

    const dup = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/demo/duplicate'), req: reqOf('POST', '/workflows/demo/duplicate', { toId: 'demo2' }), reply: dup.reply, readJsonBody: async () => ({ toId: 'demo2' }), store, host, root, runsRoot })
    assert.equal(dup.out.body.ok, true)
    assert.ok(existsSync(join(root, 'demo2', 'workflow.yml')))

    const del = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/demo2'), req: reqOf('DELETE', '/workflows/demo2'), reply: del.reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    assert.equal(del.out.body.ok, true)
    assert.equal(existsSync(join(root, 'demo2')), false)
  } finally { cleanup() }
})

test('id 需 decodeURIComponent（%64emo → demo）', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    let seenId = null
    const { out, reply } = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/%64emo'), req: reqOf('GET', '/workflows/%64emo'), reply, readJsonBody: async () => ({}), store, host: { ...host, load: async (id) => { seenId = id; return { ok: true, id } } }, root, runsRoot })
    assert.equal(seenId, 'demo')
    assert.equal(out.body.id, 'demo')
  } finally { cleanup() }
})

test('GET /workflows/:id：宿主判不存在 → 404', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    const { out, reply } = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/ghost'), req: reqOf('GET', '/workflows/ghost'), reply, readJsonBody: async () => ({}), store, host: { ...host, load: async (id) => ({ ok: false, error: `工作流不存在: ${id}` }) }, root, runsRoot })
    assert.equal(out.code, 404)
    assert.match(out.body.error, /工作流不存在/)
  } finally { cleanup() }
})

test('未知子路由 → 404；宿主未注入 → 500（不静默降级）', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    const { out, reply } = mkReply()
    const handled = await handleWorkflowRoute({ url: new URL('http://x/workflows/demo/nope'), req: reqOf('GET', '/workflows/demo/nope'), reply, readJsonBody: async () => ({}), store, host, root, runsRoot })
    assert.equal(handled, true)
    assert.equal(out.code, 404)
    assert.equal(out.body.error, 'not found')

    const noHost = mkReply()
    const h2 = await handleWorkflowRoute({ url: new URL('http://x/workflows'), req: reqOf('GET', '/workflows'), reply: noHost.reply, readJsonBody: async () => ({}), store, root, runsRoot })
    assert.equal(h2, true)
    assert.equal(noHost.out.code, 500)
    assert.match(noHost.out.body.error, /宿主未注入/)
  } finally { cleanup() }
})

test('未匹配路径返回 false（不吞其他路由）', async () => {
  const { host, cleanup } = setup()
  try {
    const { out, reply } = mkReply()
    const handled = await handleWorkflowRoute({ url: new URL('http://x/skills'), req: reqOf('GET', '/skills'), reply, readJsonBody: async () => ({}), store, host })
    assert.equal(handled, false)
    assert.equal(out.code, undefined)
  } finally { cleanup() }
})

test('真实宿主（假内核会话）接线：PUT 走 save-raw 配对 → 内核校验 → 落盘', async () => {
  const { root, runsRoot, cleanup } = setup()
  try {
    // 假内核：按真实内核回执形态（wire.system(子命令, {requestId, result})）应答
    const written = []
    const session = {
      proc: {
        stdin: {
          write: (line) => {
            const cmd = JSON.parse(line)
            written.push(cmd)
            // 宿主 onKernelMessage 由 bridge 的 stdout 分发调用 → 这里同步回调模拟
            host.onKernelMessage({
              type: 'system', subtype: cmd.subtype, requestId: cmd.requestId,
              result: cmd.payload.model
                ? { ok: true, id: cmd.payload.id, yml: `name: ${cmd.payload.model.name}\nnodes: []\nedges: []\n`, validation: { ok: true, errors: [], warnings: [] } }
                : { ok: false, id: cmd.payload.id, error: '校验失败', errors: [{ code: 'NO_NODES' }] },
            })
          },
        },
        killed: false,
      },
    }
    const host = createWorkflowHost({
      sessions: new Map([[HOST_SID, session]]), getOrCreateSession: () => session, yfwHome: root, model: 'm', onEvent: () => {},
    })
    const okr = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/zi'), req: reqOf('PUT', '/workflows/zi', { model: { name: 'zi' } }), reply: okr.reply, readJsonBody: async () => ({ model: { name: 'zi' } }), store, host, root, runsRoot })
    assert.equal(okr.out.body.ok, true)
    assert.equal(written[0].subtype, 'save-raw', '宿主 save 以 save-raw 载体发 model（内核两种载荷都认）')
    assert.equal(readFileSync(join(root, 'zi', 'workflow.yml'), 'utf-8'), 'name: zi\nnodes: []\nedges: []\n')

    const bad = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/zi'), req: reqOf('PUT', '/workflows/zi', { yaml: 'x: 1\n' }), reply: bad.reply, readJsonBody: async () => ({ yaml: 'x: 1\n' }), store, host, root, runsRoot })
    assert.equal(bad.out.code, 400)
    assert.equal(bad.out.body.errors[0].code, 'NO_NODES')
  } finally { cleanup() }
})

// —— 2026-09-12 实测缺陷回归：`GET /workflows/verify` 路由从未实现 ——
// 现场证据（对运行中的调试版）：`GET /workflows/verify?path=...` → 404
//   （前端 RunDrawer「校验完整性」按钮直接失败；内核 subtype:'verify' 早已就绪）。
test('GET /workflows/verify：审计哈希链校验（路由补齐）', async () => {
  const { runsRoot, host, cleanup } = setup()
  try {
    const p = join(runsRoot, 'demo', 'x.jsonl')
    let seen = null
    const h = { ...host, send: async (cmd) => { seen = cmd; return { ok: true, lines: 3, tampered: null } } }
    const { out, reply } = mkReply()
    const url = new URL('http://x/workflows/verify?path=' + encodeURIComponent(p))
    const handled = await handleWorkflowRoute({ url, req: reqOf('GET', '/workflows/verify'), reply, readJsonBody: async () => ({}), store, host: h, runsRoot })
    assert.equal(handled, true)
    assert.equal(out.code, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.lines, 3)
    assert.equal(seen?.subtype, 'verify', '应转发到宿主 verify 子命令')
    assert.equal(seen?.payload?.auditPath, p)
  } finally { cleanup() }
})

test('GET /workflows/verify：path 必填且必须落在 runsRoot 内（不得当任意文件探测器）', async () => {
  const { runsRoot, host, cleanup } = setup()
  try {
    const h = { ...host, send: async () => ({ ok: true }) }
    const bad = mkReply()
    await handleWorkflowRoute({ url: new URL('http://x/workflows/verify'), req: reqOf('GET', '/workflows/verify'), reply: bad.reply, readJsonBody: async () => ({}), store, host: h, runsRoot })
    assert.equal(bad.out.code, 400, '缺 path → 400')

    const outside = mkReply()
    const url = new URL('http://x/workflows/verify?path=' + encodeURIComponent(join(runsRoot, '..', 'secret.txt')))
    await handleWorkflowRoute({ url, req: reqOf('GET', '/workflows/verify'), reply: outside.reply, readJsonBody: async () => ({}), store, host: h, runsRoot })
    assert.equal(outside.out.code, 400, 'runsRoot 之外的路径必须拒绝')
  } finally { cleanup() }
})

// —— 路由覆盖守卫（2026-09-12 教训）——
// 两个真实缺陷都是「前端调了、后端没实现」，而当时的核验只把计划文本与路由做了文字对照：
//   · GET /workflows/verify      → 从未实现（RunDrawer「校验完整性」恒 404）
//   · POST /workflows/bindings   → setBindings() 用 POST（路由只收 GET/PUT）→ 405
// 这条守卫把**每条前端调用**逐一打到真实路由函数上，要求"不得 404"（路径必须存在）。
// 新增前端调用时若忘了补路由，这里立刻变红。
test('路由覆盖守卫：workflowApi 的每条调用都不得 404（路径必须存在）', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    store.createWorkflow({ root, id: 'demo', yml: YML })
    const h = { ...host, send: async () => ({ ok: true }) }
    // 与 src/lib/workflowApi.ts 的调用面一一对应（method, path）
    const callers = [
      ['GET', '/workflows'],
      ['GET', '/workflows/demo'],
      ['PUT', '/workflows/demo'],
      ['POST', '/workflows'],
      ['POST', '/workflows/demo/duplicate'],
      ['GET', '/workflows/demo/validate'],
      ['GET', '/workflows/demo/versions'],
      ['POST', '/workflows/demo/rollback'],
      ['GET', '/workflows/demo/export'],
      ['POST', '/workflows/import'],
      ['POST', '/workflows/run'],
      ['GET', '/workflows/run-status?runId=r1'],
      ['POST', '/workflows/stop'],
      ['POST', '/workflows/confirm'],
      ['GET', '/workflows/runs'],
      ['GET', '/workflows/verify'],
      ['GET', '/workflows/bindings'],
      ['PUT', '/workflows/bindings'],
      ['DELETE', '/workflows/demo'],   // 破坏性调用放最后：先删了后面就没得测了
    ]
    const missing = []
    for (const [method, path] of callers) {
      const { out, reply } = mkReply()
      const body = { capabilities: { tools: [] } }
      await handleWorkflowRoute({ url: new URL('http://x' + path), req: reqOf(method, path, method === 'GET' ? undefined : body), reply, readJsonBody: async () => body, store, host: h, root, runsRoot })
      // 404 = 路径不存在（未实现）；400/405 等业务性拒绝说明路由存在
      if (out.code === 404) missing.push(`${method} ${path}`)
    }
    assert.deepEqual(missing, [], `以下前端调用无对应路由实现：${missing.join(' | ')}`)
  } finally { cleanup() }
})

// —— ok 契约守卫（2026-09-12 实测缺陷）——
// 客户端 workflowApi.call() 的失败判定是「HTTP 非 2xx」+「body.ok === false」，而消费方写的是
// `const r = await listWorkflows(); if (!r.ok) …`。于是**成功回执缺 ok 字段**时全部被当成失败：
//   · GET  /workflows           → { workflows, root }        → 列表恒显「暂无工作流」
//   · GET  /workflows/bindings  → { agents, trusted }        → 授权卡「读取信任清单失败：undefined」
//   · GET  /workflows/runs      → { runs }                   → 历史记录恒空
// 这类缺陷单测此前照不出来（单测直接断言 body.runs/body.trusted 字段，不看 ok）。
// 这条守卫要求：**所有 2xx 回执都必须带 ok 字段**（true/false 皆可，但不能缺）。
test('ok 契约守卫：所有 2xx 回执必须带 ok 字段（缺则 UI 判为失败）', async () => {
  const { root, runsRoot, host, cleanup } = setup()
  try {
    store.createWorkflow({ root, id: 'demo', yml: YML })
    const h = { ...host, send: async () => ({ ok: true, lines: 1 }), runResult: () => ({ ok: true, runId: 'r1', status: 'completed', finished: true }) }
    const callers = [
      ['GET', '/workflows'],
      ['GET', '/workflows/demo'],
      ['PUT', '/workflows/demo'],
      ['POST', '/workflows'],
      ['POST', '/workflows/demo/duplicate'],
      ['GET', '/workflows/demo/validate'],
      ['GET', '/workflows/demo/versions'],
      ['POST', '/workflows/demo/rollback'],
      ['GET', '/workflows/demo/export'],
      ['POST', '/workflows/import'],
      ['POST', '/workflows/run'],
      ['GET', '/workflows/run-status?runId=r1'],
      ['POST', '/workflows/stop'],
      ['POST', '/workflows/confirm'],
      ['GET', '/workflows/runs'],
      ['GET', '/workflows/verify'],
      ['GET', '/workflows/bindings'],
      ['PUT', '/workflows/bindings'],
    ]
    const offending = []
    for (const [method, path] of callers) {
      const { out, reply } = mkReply()
      const body = { capabilities: { tools: [] }, path: join(runsRoot, 'demo', 'x.jsonl'), ts: '2026-01-01T00-00-00-000Z', bundle: {}, toId: 'copy', runId: 'r1', node: 'n', action: 'approved', auditPath: join(runsRoot, 'demo', 'x.jsonl') }
      await handleWorkflowRoute({ url: new URL('http://x' + path + (path === '/workflows/verify' ? `?path=${encodeURIComponent(body.path)}` : '')), req: reqOf(method, path, method === 'GET' ? undefined : body), reply, readJsonBody: async () => body, store, host: h, root, runsRoot })
      if (out.code >= 200 && out.code < 300 && out.body && typeof out.body === 'object' && out.body.ok === undefined) {
        offending.push(`${method} ${path} → ${JSON.stringify(out.body).slice(0, 60)}`)
      }
    }
    assert.deepEqual(offending, [], `以下 2xx 回执缺 ok 字段（UI 会当失败处理）：\n${offending.join('\n')}`)
  } finally { cleanup() }
})
