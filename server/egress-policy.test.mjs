// S2-D3 数据出网闸回归网（spec §6.2 D3、§9「S2 出网闸」、§10「S2 验收 3」、§5.1、§4 P1/P2）
// ---------------------------------------------------------------------------
// 「出网」= **过团队源**（把本地数据分享给他人可见），不是"访问 LLM provider"（后者是用户显式
// 操作 + 热·凭据，不在本闸门内）。改前事实：全仓**无 syncPolicy 痕迹**，即"哪些数据能过团队源"
// 从未被固化——S3 一旦接线，任何实体都可能被顺手带出网，而默认值是什么无人可查。
//
// 本文件钉四类命题，缺一类都可能是假绿：
//   ① 单测正反两面（§9 原文）：默认 local-only **不出网**；**显式标记才出**。
//      —— 只断言"拒绝"会在"闸门把一切都拒了"时通过，所以必须同时断言"显式标记能出"。
//   ② 优先级：热·永不（config/凭据）**显式标记也不能出**（P1「永不」）；整档封闭压过实体标记。
//   ③ 敏感类需**脱敏证据**（§5.1「显式分享时必须过 kernel/redact.mjs」），且未知实体一律拒（P2 白名单）。
//   ④ 真机：`/egress/policy` 受 D2 保护（无 token 401），且默认档下 **allowedEntities 为空**
//      —— 这是 §10 S2-3「默认配置下 transcript/config 等敏感数据无任何出网路径」的字面验收。
// 另含静态守卫：实体分档不得被静默改松（把 transcript 挪到 cold-content 就等于悄悄放开敏感数据）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import http from 'node:http'
import {
  EGRESS_ENTITIES, EGRESS_TIERS, EGRESS_MODE, EGRESS_REASON, SYNC_POLICY,
  authorizeEgress, listEgressPolicy,
} from './egress-policy.mjs'
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

// ---------------------------------------------------------------------------
// ① 单测：默认不出网 / 显式标记才出（§9 原文的两面）
// ---------------------------------------------------------------------------
test('单测：默认档下一切实体不出网；显式标记 + 开放档下冷·内容才可出', () => {
  // 默认参数（连 policy/mode 都不传）必须拒——这是 §10 S2-3 的默认姿态
  for (const entity of Object.keys(EGRESS_ENTITIES)) {
    const r = authorizeEgress(entity)
    assert.equal(r.allowed, false, `默认档下 ${entity} 必须不出网`)
    assert.equal(r.reason, EGRESS_REASON.MODE_LOCAL_ONLY, `默认档应以"整档封闭"为由拒绝 ${entity}`)
  }
  // 即便实体显式标记 sync-ok，整档封闭仍压过它（默认配置 = 无任何出网路径）
  const markedButClosed = authorizeEgress('knowledge', { policy: SYNC_POLICY.SYNC_OK })
  assert.equal(markedButClosed.allowed, false, '整档 local-only 时，显式标记也不得出网')
  assert.equal(markedButClosed.reason, EGRESS_REASON.MODE_LOCAL_ONLY)

  // 反面：开放档 + 显式标记 ⇒ 冷·内容可出（只测拒绝会掩盖"闸门全拒"的假绿）
  const content = authorizeEgress('knowledge', { policy: SYNC_POLICY.SYNC_OK, mode: EGRESS_MODE.SYNC_ENABLED })
  assert.equal(content.allowed, true, '冷·内容在显式标记 + 开放档下必须可出网')
  assert.equal(content.reason, EGRESS_REASON.ALLOWED)
  const telemetry = authorizeEgress('usage', { policy: SYNC_POLICY.SYNC_OK, mode: EGRESS_MODE.SYNC_ENABLED })
  assert.equal(telemetry.allowed, true, '冷·遥测在显式标记 + 开放档下必须可出网（单向上行，方向由调用方约束）')
  // 开放档但**未**显式标记 ⇒ 仍拒（P2：显式标记才可外发）
  const unmarked = authorizeEgress('knowledge', { mode: EGRESS_MODE.SYNC_ENABLED })
  assert.equal(unmarked.allowed, false, '未显式标记的实体不得出网（白名单式）')
  assert.equal(unmarked.reason, EGRESS_REASON.POLICY_LOCAL_ONLY)
})

// ---------------------------------------------------------------------------
// ② 优先级：热·永不 / 整档封闭；③ 敏感类需脱敏证据；未知实体拒
// ---------------------------------------------------------------------------
test('单测：热·永不连显式标记也拒；敏感类需脱敏证据；未知实体一律拒', () => {
  const open = { policy: SYNC_POLICY.SYNC_OK, mode: EGRESS_MODE.SYNC_ENABLED }
  // 热·永不：config 含明文 provider token、credential 是凭据 —— P1「永不」优先于显式标记
  for (const entity of ['config', 'credential', 'conversation', 'approval', 'browser', 'tool-exec']) {
    const r = authorizeEgress(entity, open)
    assert.equal(r.allowed, false, `热·永不实体 ${entity} 即使显式标记也不得出网`)
    assert.equal(r.reason, EGRESS_REASON.HOT_NEVER_SYNCS, `${entity} 的拒绝原因应是 hot-never-syncs`)
  }
  // 冷·敏感：显式标记但无脱敏 ⇒ 拒（§5.1「必须过 kernel/redact.mjs」）
  const noRedact = authorizeEgress('transcript', open)
  assert.equal(noRedact.allowed, false, '敏感类缺脱敏证据必须拒')
  assert.equal(noRedact.reason, EGRESS_REASON.SENSITIVE_REQUIRES_REDACT)
  // 有脱敏证据 ⇒ 放行
  const redacted = authorizeEgress('transcript', { ...open, redacted: true })
  assert.equal(redacted.allowed, true, '敏感类在显式标记 + 脱敏证据下必须可出网')
  // 脱敏标记必须是严格的 true（不得被真值型字符串糊过去）
  assert.equal(authorizeEgress('transcript', { ...open, redacted: 'true' }).allowed, false, 'redacted 必须严格为 true')
  // 未知实体 ⇒ 拒（白名单式，P2）
  const unknown = authorizeEgress('whatever-new-entity', open)
  assert.equal(unknown.allowed, false, '白名单外实体一律拒')
  assert.equal(unknown.reason, EGRESS_REASON.UNKNOWN_ENTITY)
})

// ---------------------------------------------------------------------------
// ④ 实体分档静态守卫（防有人静默改松）+ 审计不含数据正文
// ---------------------------------------------------------------------------
test('静态：实体分档不得被改松（transcript 敏感 / config+凭据 热·永不），审计不携带数据正文', () => {
  const src = readFileSync(join(REPO_ROOT, 'server', 'egress-policy.cjs'), 'utf8')
  // §10 S2-3 点名的两类必须停在最严档：把 transcript 挪到 cold-content 就等于悄悄放开敏感数据
  assert.equal(EGRESS_ENTITIES.transcript, EGRESS_TIERS.sensitive, 'transcript 必须留在冷·敏感档')
  assert.equal(EGRESS_ENTITIES.config, EGRESS_TIERS.hot, 'config（含明文 provider token）必须留在热·永不档')
  assert.equal(EGRESS_ENTITIES.credential, EGRESS_TIERS.hot, 'credential 必须留在热·永不档')
  assert.equal(EGRESS_ENTITIES['abs-path'], EGRESS_TIERS.sensitive, '绝对路径必须留在冷·敏感档')
  // 每个实体都有档位（无 undefined ⇒ 不会被"未知实体"分支静默拦下而无人发现）
  for (const [e, t] of Object.entries(EGRESS_ENTITIES)) {
    assert.ok(Object.values(EGRESS_TIERS).includes(t), `实体 ${e} 的档位 ${t} 非法`)
  }
  // 默认值不得被改成"可出网"
  assert.match(src, /SYNC_POLICY\.LOCAL_ONLY/, 'syncPolicy 默认值必须是 local-only')
  assert.match(src, /mode = EGRESS_MODE\.LOCAL_ONLY/, 'authorizeEgress 的 mode 默认必须是 local-only')
  assert.match(src, /policy = SYNC_POLICY\.LOCAL_ONLY/, 'authorizeEgress 的 policy 默认必须是 local-only')
  // 审计条目：只允许实体/档位/结论/原因/时间，不得带数据正文
  const audit = authorizeEgress('transcript', { policy: SYNC_POLICY.SYNC_OK, mode: EGRESS_MODE.SYNC_ENABLED }).audit
  assert.deepEqual(Object.keys(audit).sort(), ['allowed', 'at', 'entity', 'policy', 'reason', 'tier'], '审计条目字段集固定，不得夹带数据正文')
  assert.ok(!JSON.stringify(audit).includes('content'), '审计不得含数据正文')
})

// ---------------------------------------------------------------------------
// ⑤ 汇总面：默认档下"无任何出网路径"
// ---------------------------------------------------------------------------
test('单测：默认档汇总的 allowedEntities 必须为空（§10 S2-3 的可断言形态）', () => {
  const def = listEgressPolicy()
  assert.equal(def.mode, EGRESS_MODE.LOCAL_ONLY, '默认档必须是 local-only')
  assert.deepEqual(def.allowedEntities, [], '默认档下不得有任何可出网实体')
  const byName = Object.fromEntries(def.entities.map((e) => [e.entity, e]))
  for (const e of ['transcript', 'config', 'credential', 'abs-path', 'command']) {
    assert.equal(byName[e].allowed, false, `默认档下 ${e} 必须不可出网（§10 S2-3 点名）`)
  }
  // 开放档 + 全量标记：热·永不仍应全部拒（正面证明闸门不是"一律拒"的摆设）
  const openPolicies = Object.fromEntries(Object.keys(EGRESS_ENTITIES).map((e) => [e, SYNC_POLICY.SYNC_OK]))
  const open = listEgressPolicy({ mode: EGRESS_MODE.SYNC_ENABLED, policies: openPolicies, redactedEntities: ['transcript', 'abs-path', 'command'] })
  assert.ok(open.allowedEntities.includes('knowledge'), '开放档下冷·内容应可出网')
  assert.ok(!open.allowedEntities.includes('config'), '开放档下 config 仍不得出网')
  assert.ok(!open.allowedEntities.includes('credential'), '开放档下凭据仍不得出网')
})

// ---------------------------------------------------------------------------
// ⑥ 真机：/egress/policy 受 D2 保护，且默认档下无任何出网路径
// ---------------------------------------------------------------------------
test('真机：/egress/policy 无 token → 401；带 token → 默认档无任何可出网实体', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-egress-'))
  const port = await freePort()
  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',
    YFW_BRIDGE_PORT: String(port),
    YFW_AUTH_FILE: join(home, 'auth.json'),
    YFWORKING_HOME: home,
    PONOS_CONFIG_DIR: home,
    YFW_BRIDGE_TOKEN: TEST_BRIDGE_TOKEN,
  }
  delete env.PONOS_HOME
  const proc = spawn(process.execPath, [BRIDGE_ENTRY], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = []
  const state = { exitInfo: null }
  let errTail = ''
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => { out.push(String(d)) })
  proc.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-2000) })
  proc.once('exit', (code, signal) => { state.exitInfo = { code, signal } })

  const get = (path, headers = {}) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let buf = ''
      res.on('data', (d) => { buf += d })
      res.on('end', () => resolve({ status: res.statusCode, body: buf }))
    })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.setTimeout(5000, () => { try { req.destroy(new Error('timeout')) } catch {} })
    req.end()
  })
  /** 只对连接层失败重试（启动期事件循环忙时会首请求超时，属假红，非闸门语义） */
  const getSettled = async (path, headers = {}) => {
    const deadline = Date.now() + 20000
    for (;;) {
      const r = await get(path, headers)
      if (r.status !== 0) return r
      if (Date.now() > deadline) return r
      await sleep(250)
    }
  }

  try {
    const deadline = Date.now() + 15000
    let ready = false
    while (Date.now() < deadline) {
      if (out.join('').includes(`[bridge] listening 127.0.0.1:${port} (loopback only)`) || out.join('').includes(`http+ws://localhost:${port}`)) { ready = true; break }
      if (state.exitInfo) throw new Error(`bridge exited before ready: ${JSON.stringify(state.exitInfo)}; stderr tail: ${errTail}`)
      await sleep(50)
    }
    assert.ok(ready, `bridge 未就绪；stderr tail: ${errTail}`)

    // 受 D2 保护：无 token 的本机客户端不得读到这一面（它本身也是"团队同步拓扑"的侦察信息）
    const anon = await getSettled('/egress/policy')
    assert.equal(anon.status, 401, `无 token 访问 /egress/policy 必须 401（实际 ${JSON.stringify(anon)}）`)

    const authed = await getSettled('/egress/policy', authHeaders())
    assert.equal(authed.status, 200, `带 token 必须 200（实际 ${JSON.stringify(authed)}）`)
    const body = JSON.parse(authed.body)
    assert.equal(body.mode, EGRESS_MODE.LOCAL_ONLY, '默认档必须是 local-only')
    assert.deepEqual(body.allowedEntities, [], '默认配置下不得有任何可出网实体（§10 S2-3）')
    const byName = Object.fromEntries(body.entities.map((e) => [e.entity, e]))
    for (const e of ['transcript', 'config', 'credential', 'abs-path']) {
      assert.equal(byName[e].allowed, false, `默认档下 ${e} 必须 allowed:false`)
    }
    assert.equal(byName.transcript.tier, EGRESS_TIERS.sensitive)
    assert.equal(byName.config.tier, EGRESS_TIERS.hot)
  } finally {
    try { proc.kill() } catch {}
    await new Promise((resolve) => {
      if (state.exitInfo) return resolve()
      const t = setTimeout(resolve, 3000)
      proc.once('exit', () => { clearTimeout(t); resolve() })
    })
    rmSyncRetry(home)
  }
})
