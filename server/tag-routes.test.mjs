// S2-D6 桥路由回归网：`/tags`（可观测）+ `/tags/merge`（自动合并）+ `/tags/undo`（可撤销）
// ---------------------------------------------------------------------------
// spec §6.2 D6、§10 S2-5、§14-4（用户裁定 📌#4 = **自动合并 + 可撤销**）。
//
// 为什么必须做"真机"这一层而不止单测：D6 的能力若只躺在库里等人 import，就无从验收、UI/agent 也
// 无从调用。故补齐"起桥 → 真发请求 → 读磁盘"的端到端证据，并借机钉住两条**安全**命题：
//   ① 三个路由都落在 D2 token 闸门**之后** ⇒ 无 token 一律 401（不因新增功能而在闸门上开口子）；
//   ② 未授权的 POST **不得产生写入**（401 之后注册表文件不应出现）—— 仅断言状态码会漏掉"先写后拒"。
// 落点与 D3 的 `/egress/policy` 相邻，同属"判定内核 + 一个既定入口"的做法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import http from 'node:http'
import { TEST_BRIDGE_TOKEN, authHeaders } from './test-bridge-auth.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const BRIDGE_ENTRY = join(REPO_ROOT, 'server', 'bridge.mjs')

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function rmSyncRetry(path, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch (e) {
      if (i === attempts - 1) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * 起一个隔离的桥：
 * - `YFWORKING_HOME` 指向临时目录 ⇒ `YFW_HOME` 随之隔离（`resolveYfwHome` **调用期读取、无模块级缓存**），
 *   因此本测试**绝不会**碰到真实用户的 `~/tags/registry.json`。
 * - 注入 `YFW_BRIDGE_TOKEN` ⇒ 走 D2 的"持令牌"路径。
 */
async function startBridge(home, { withToken = true } = {}) {
  const port = await freePort()
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    YFW_AUTH_FILE: join(home, 'auth.json'),
    YFWORKING_HOME: home,
    PONOS_CONFIG_DIR: home,
  }
  delete env.PONOS_HOME
  if (withToken) env.YFW_BRIDGE_TOKEN = TEST_BRIDGE_TOKEN
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let errTail = ''
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => { out += String(d) })
  proc.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-2000) })

  const call = (method, path, body = null, headers = {}) => new Promise((resolve) => {
    const payload = body === null ? null : JSON.stringify(body)
    const h = { ...headers }
    if (payload !== null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = String(Buffer.byteLength(payload)) }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let buf = ''
      res.on('data', (d) => { buf += d })
      res.on('end', () => resolve({ status: res.statusCode, body: buf }))
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.setTimeout(5000, () => { try { req.destroy(new Error('timeout')) } catch {} })
    req.end(payload === null ? undefined : payload)
  })
  /** 只对**连接层失败**重试：启动期事件循环忙时的首请求超时是假红，与路由语义无关 */
  const settled = async (method, path, body, headers) => {
    const deadline = Date.now() + 20000
    for (;;) {
      const r = await call(method, path, body, headers)
      if (r.status !== 0 || Date.now() > deadline) return r
      await sleep(200)
    }
  }
  const get = (p, h) => settled('GET', p, null, h)
  const post = (p, b, h) => settled('POST', p, b, h)

  const deadline = Date.now() + 60000
  while (!/listening 127\.0\.0\.1:\d+ \(loopback only\)/.test(out) && Date.now() < deadline) {
    if (proc.exitCode !== null) break
    await sleep(120)
  }
  return { port, proc, get, post, outText: () => out, errText: () => errTail, stop: () => { try { proc.kill() } catch {} } }
}

test('真机：/tags 受 D2 保护——无 token 401；带 token 得到空注册表视图', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-tags-'))
  const b = await startBridge(home)
  const registry = join(home, 'tags', 'registry.json')
  try {
    const noTok = await b.get('/tags')
    assert.equal(noTok.status, 401, '新增路由不得在 D2 闸门上开口子')
    assert.ok(!existsSync(registry), '被拒的读请求不应产生任何文件')

    const ok = await b.get('/tags', authHeaders())
    assert.equal(ok.status, 200)
    const view = JSON.parse(ok.body)
    assert.equal(view.total, 0, '全新安装：空注册表（不是报错）')
    assert.equal(view.scope, 'personal', '缺省作用域 = personal（§5.9 L1 恒个人）')
    assert.deepEqual(view.merges, [])
  } finally {
    b.stop()
    await sleep(150)
    rmSyncRetry(home)
  }
})

test('真机：自动合并 → 可查询 → 可撤销，且每一步都真落盘', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-tags-'))
  const b = await startBridge(home)
  const registry = join(home, 'tags', 'registry.json')
  try {
    // ① 无 token 的写请求：必须 401，且**不得产生写入**（只断言状态码会漏掉"先写后拒"）
    const denied = await b.post('/tags/merge', { from: '财务部', into: '财务' })
    assert.equal(denied.status, 401)
    assert.ok(!existsSync(registry), '未授权请求绝不能落盘')

    // ② 自动合并：无审核即生效
    const m = await b.post('/tags/merge', { from: '财务部', into: '财务' }, authHeaders())
    assert.equal(m.status, 200, `合并应成功（实际 ${m.body}）`)
    const mr = JSON.parse(m.body)
    assert.equal(mr.ok, true)
    assert.match(mr.mergeId, /^mrg-\d{4}$/)

    // ③ 落盘实据：真读文件
    assert.ok(existsSync(registry), '合并必须真的写盘')
    const onDisk = readFileSync(registry, 'utf-8')
    assert.match(onDisk, /"name": "财务"/)
    assert.match(onDisk, /"财务部"/, '别名必须落盘')

    // ④ 可查询：GET /tags 应只剩规范实体、并带别名计数
    const v = JSON.parse((await b.get('/tags', authHeaders())).body)
    assert.equal(v.total, 1)
    assert.equal(v.tags[0].name, '财务')
    assert.deepEqual(v.tags[0].aliases, ['财务部'])
    assert.equal(v.merges.length, 1)
    assert.equal(v.merges[0].undoneAt, null)

    // ⑤ 可撤销：还原后两个实体都在盘上
    const u = await b.post('/tags/undo', { mergeId: mr.mergeId }, authHeaders())
    assert.equal(u.status, 200, `撤销应成功（实际 ${u.body}）`)
    assert.equal(JSON.parse(u.body).ok, true)
    const after = JSON.parse((await b.get('/tags', authHeaders())).body)
    assert.deepEqual(after.tags.map((t) => t.name).sort(), ['财务', '财务部'], '撤销后两个标签都应回来')
    assert.deepEqual(after.tags.find((t) => t.name === '财务').aliases, [], '目标实体的别名应被剥回')
    assert.ok(after.merges[0].undoneAt, '合并记录保留并记撤销时间（可追溯）')

    // ⑥ 作用域：team 与 personal 互不影响
    const t = JSON.parse((await b.get('/tags?scope=team', authHeaders())).body)
    assert.equal(t.total, 0, 'personal 的合并不得到 team 作用域里出现')
  } finally {
    b.stop()
    await sleep(150)
    rmSyncRetry(home)
  }
})

test('真机：错误路径明确回报（不静默成功）', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-tags-'))
  const b = await startBridge(home)
  try {
    // 自身合并
    const self = await b.post('/tags/merge', { from: '财务', into: '财务' }, authHeaders())
    assert.equal(self.status, 400)
    assert.equal(JSON.parse(self.body).reason, 'same-tag')

    // 空标签
    const empty = await b.post('/tags/merge', { from: '', into: '财务' }, authHeaders())
    assert.equal(empty.status, 400)
    assert.equal(JSON.parse(empty.body).reason, 'empty-tag')

    // 未知合并记录
    const undo = await b.post('/tags/undo', { mergeId: 'mrg-9999' }, authHeaders())
    assert.equal(undo.status, 400)
    assert.equal(JSON.parse(undo.body).reason, 'not-found')

    // 非法作用域：明确 400（不静默当成 personal）
    const bad = await b.get('/tags?scope=nope', authHeaders())
    assert.equal(bad.status, 400)
    assert.equal(JSON.parse(bad.body).reason, 'invalid-scope')

    // 反向合并（会造成环）必须被拒
    await b.post('/tags/merge', { from: '甲', into: '乙' }, authHeaders())
    const cyc = await b.post('/tags/merge', { from: '乙', into: '甲' }, authHeaders())
    assert.equal(cyc.status, 400)
    assert.equal(JSON.parse(cyc.body).reason, 'already-merged')
  } finally {
    b.stop()
    await sleep(150)
    rmSyncRetry(home)
  }
})
