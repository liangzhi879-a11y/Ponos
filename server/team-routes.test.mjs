// S3 桥路由回归网：`/team/*`（创建 / 邀请 / 加入 / 撤销 / 状态 / 搜索根）
// ---------------------------------------------------------------------------
// spec §7.1（团队源 L1）、§5.9（加入机制）、§10 S3。
//
// 为什么必须有"真机"这一层：S3 的能力若只躺在库里等人 import，就无从验收、UI/agent 也无从调用。
// 因此补齐"起桥 → 真发请求 → 读磁盘"的端到端证据，并借机钉住两条**安全**命题：
//   ① 六个路由都落在 D2 token 闸门**之后** ⇒ 无 token 一律 401（不因新增功能而在闸门上开口子）；
//   ② 未授权的 POST **不得产生写入**（401 之后团队目录/本机配置都不应出现）——
//      只断言状态码会漏掉"先写后拒"这种真实缺陷。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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
      if (i === attempts - 1) return
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

/** 起一个隔离的桥（`YFWORKING_HOME` 隔离 ⇒ 绝不碰真实用户配置）。 */
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
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => { out += String(d) })

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
  /** 只对**连接层失败**重试（启动期事件循环忙时的首请求超时是假红，与路由语义无关） */
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
  return { port, proc, get, post, stop: () => { try { proc.kill() } catch {} } }
}

function json(res) { try { return JSON.parse(res.body) } catch { return null } }

test('真机：六个 /team* 路由都在 D2 闸门之后 —— 无 token 一律 401，且**未授权不产生任何写入**', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-team-auth-'))
  const teamDir = join(home, '共享', '团队甲')
  const b = await startBridge(home)
  try {
    const noTok = [
      await b.get('/team/status'),
      await b.post('/team/create', { name: '甲', dir: teamDir }),
      await b.post('/team/invite', { teamId: 't_x' }),
      await b.post('/team/join', { identCode: '111111111', code: '123456' }),
      await b.post('/team/revoke', { teamId: 't_x', memberId: 'u_x' }),
      await b.post('/team/search-root', { searchRoot: home }),
    ]
    for (const r of noTok) assert.equal(r.status, 401, '新增路由不得在 D2 闸门上开口子')

    // ② 只断状态码会漏掉"先写后拒"：显式确认未授权请求**没有**留下任何痕迹
    assert.equal(existsSync(teamDir), false, '未授权的 create 不得创建团队目录')
    assert.equal(existsSync(join(teamDir, 'team.json')), false, '未授权的 create 不得写 team.json')
    assert.equal(existsSync(join(home, 'team', 'config.json')), false, '未授权的任何请求都不得写本机团队配置')
  } finally { b.stop(); rmSyncRetry(home) }
})

test('真机：创建 → 邀请 → 加入 → 状态 → 撤销（全链路，且逐项读磁盘核实）', { timeout: 120000 }, async () => {
  const homeA = mkdtempSync(join(tmpdir(), 'yfw-team-a-'))
  const homeB = mkdtempSync(join(tmpdir(), 'yfw-team-b-'))
  const teamDir = join(homeA, '共享', '团队甲')
  const b = await startBridge(homeA)
  try {
    // ① 创建
    const created = await b.post('/team/create', { name: '甲团队', dir: teamDir, identCode: '123456789' }, authHeaders())
    assert.equal(created.status, 200, created.body)
    const c = json(created)
    assert.equal(c.ok, true)
    assert.match(c.teamId, /^t_/)

    // 磁盘核实：manifest 明文且**不含密钥**
    const manifestRaw = readFileSync(join(teamDir, 'team.json'), 'utf-8')
    assert.equal(/teamKey|privateKey|secret/i.test(manifestRaw), false, 'team.json 绝不含密钥')
    assert.equal(JSON.parse(manifestRaw).identCode, '123456789')
    // 本机配置含团队密钥（0600）
    const cfgPath = join(homeA, 'team', 'config.json')
    assert.equal(existsSync(cfgPath), true)
    assert.match(readFileSync(cfgPath, 'utf-8'), /"teamKey"/)
    if (process.platform !== 'win32') assert.equal(statSync(cfgPath).mode & 0o777, 0o600)

    // ② 邀请
    const inv = json(await b.post('/team/invite', { teamId: c.teamId }, authHeaders()))
    assert.equal(inv.ok, true, JSON.stringify(inv))
    assert.match(inv.code, /^\d{6}$/)
    assert.equal(existsSync(join(teamDir, 'keys', `${inv.memberId}.env`)), true, '信封必须落盘')
    assert.equal(/加密|安全|仅.*可见/i.test(inv.copyText), false, '§11 措辞约束：不得暗示"加密所以安全"')

    // ③ 加入（另一台机器 = 另一个隔离 home）
    const b2 = await startBridge(homeB)
    try {
      const joined = json(await b2.post('/team/join', { identCode: '123456789', code: inv.code, searchRoot: join(homeA, '共享') }, authHeaders()))
      assert.equal(joined.ok, true, JSON.stringify(joined))
      assert.equal(joined.memberId, inv.memberId)
      assert.equal(joined.dir, teamDir)

      // ④ 状态：两人、链完整、副本两份
      const st = json(await b.get(`/team/status?teamId=${encodeURIComponent(c.teamId)}`, authHeaders()))
      assert.equal(st.ok, true)
      assert.equal(st.teams.length, 1)
      const t = st.teams[0]
      assert.equal(t.memberCount, 2)
      assert.equal(t.integrity.ok, true, JSON.stringify(t.integrity.errors))
      assert.equal(t.copies, 2, '两台设备各一条日志')
      assert.equal(t.me.role, 'owner')
      assert.equal(typeof t.measure.files, 'number')

      // ⑤ 撤销（由 owner 侧执行）
      const rv = json(await b.post('/team/revoke', { teamId: c.teamId, memberId: inv.memberId }, authHeaders()))
      assert.equal(rv.ok, true)
      const st2 = json(await b.get('/team/status', authHeaders()))
      const t2 = st2.teams.find((x) => x.teamId === c.teamId)
      assert.equal(t2.members.find((m) => m.memberId === inv.memberId).status, 'revoked')
      assert.equal(t2.integrity.ok, true, '移除成员后链仍应自洽')
    } finally { b2.stop() }
  } finally { b.stop(); rmSyncRetry(homeA); rmSyncRetry(homeB) }
})

test('真机：错误路径逐项区分（不笼统报"失败"），且失败不落半截状态', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-team-err-'))
  const b = await startBridge(home)
  try {
    // 缺 dir：明确 dir-required
    const noDir = await b.post('/team/create', { name: '甲' }, authHeaders())
    assert.equal(noDir.status, 400)
    assert.equal(json(noDir).reason, 'dir-required')

    // 加入：识别码格式 / 识别码找不到 / 验证码格式 各自可辨
    const badIdent = await b.post('/team/join', { identCode: '12345', code: '123456', searchRoot: home }, authHeaders())
    assert.equal(json(badIdent).reason, 'bad-ident-format')
    const badCode = await b.post('/team/join', { identCode: '123456789', code: 'abc', searchRoot: home }, authHeaders())
    assert.equal(json(badCode).reason, 'bad-code-format')
    const notFound = await b.post('/team/join', { identCode: '123456789', code: '123456', searchRoot: home }, authHeaders())
    assert.equal(json(notFound).reason, 'ident-not-found')

    // 未加入任何团队时的 status：如实返回空列表（不是报错、不是 500）
    const st = await b.get('/team/status', authHeaders())
    assert.equal(st.status, 200)
    assert.deepEqual(json(st).teams, [])

    // 失败后不得留下目录
    assert.equal(readdirSync(home).filter((n) => n === '共享').length, 0)
  } finally { b.stop(); rmSyncRetry(home) }
})

test('真机：search-root 可设置（"两个数字加入"的前提）', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-team-root-'))
  const b = await startBridge(home)
  try {
    const r = json(await b.post('/team/search-root', { searchRoot: home }, authHeaders()))
    assert.equal(r.ok, true)
    assert.equal(r.searchRoot, home)
    const st = json(await b.get('/team/status', authHeaders()))
    assert.equal(st.searchRoot, home, '搜索根应透出给前端/排障')
  } finally { b.stop(); rmSyncRetry(home) }
})
