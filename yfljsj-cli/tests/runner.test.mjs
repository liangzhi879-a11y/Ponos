// 命令执行器 + HTTP 客户端测试 — mock 网关用本地 https server（自签名证书，不联网）
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEY = readFileSync(new URL('./fixtures/key.pem', import.meta.url))
const CERT = readFileSync(new URL('./fixtures/cert.pem', import.meta.url))

// 测试隔离：config 写入临时目录（YFLJSJ_HOME 覆盖 os.homedir）
const TMP = mkdtempSync(path.join(os.tmpdir(), 'yfljsj-runner-'))
process.env.YFLJSJ_HOME = TMP
const CONFIG_PATH = path.join(TMP, '.yfljsj', 'config.json')

const api = await import('../yfljsj.mjs')

function resetConfig() {
  rmSync(CONFIG_PATH, { force: true })
}

function seedConfig({ accessToken = 'AT-old', refreshToken = 'RT-old', tenantId = 'T001', expiresAt = Date.now() + 3600_000 } = {}) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify({ accessToken, refreshToken, tenantId, expiresAt }))
}

const makeTokens = (at, rt) => ({ accessToken: at, refreshToken: rt, tenantId: 'T001', expiresIn: 7200 })

// 可配置的本地 https mock 网关（genericHandler 收到 res，可发非 JSON 响应）
function startMock() {
  const state = {
    requests: [], // 全部请求记录 {method, path, query, headers, body}
    refreshCount: 0,
    refreshHandler: null,
    genericHandler: null,
  }
  const server = createServer({ key: KEY, cert: CERT }, (req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const u = new URL(req.url, 'https://localhost')
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      const entry = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body }
      state.requests.push(entry)
      const respond = (status, json, extraHeaders = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
        res.end(json === undefined ? '' : JSON.stringify(json))
      }
      // 去掉 /api/<service> 前缀后路由
      const route = u.pathname.replace(/^\/api\/[^/]+/, '')
      if (route === '/auth/refresh-token') {
        state.refreshCount++
        if (state.refreshHandler) return state.refreshHandler(entry, respond, state)
        return respond(200, { success: true, code: 200, msg: 'ok', data: makeTokens('AT-new', 'RT-new') })
      }
      if (state.genericHandler) return state.genericHandler(entry, respond, state, res)
      return respond(200, { success: true, code: 200, msg: 'ok', data: { echo: entry.body ?? entry.query } })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        state,
        server,
        baseUrl: `https://127.0.0.1:${port}/api/rcms`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

// 拿一个已关闭的端口（连接被拒 → 网络错误）
function closedPort() {
  return new Promise((resolve) => {
    const srv = createServer({ key: KEY, cert: CERT }, () => {})
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

let mock
beforeEach(async () => {
  mock = await startMock()
  resetConfig()
})
afterEach(async () => {
  await mock.close()
})

const RCMS = (opts = {}) => ({ baseUrl: mock.baseUrl, rejectUnauthorized: false, ...opts })

// ==================== 参数拼接 ====================

test('GET 命令：args 拼成 query 串', async () => {
  seedConfig()
  const r = await api.runCommand('resefunds', 'projectBudget-projectSourceList', { deptId: 'D1', deep: 1 }, RCMS())
  assert.equal(r.exitCode, 0)
  const req = mock.state.requests[0]
  assert.equal(req.path, '/api/rcms/resefunds/projectBudget/projectSourceList')
  assert.deepEqual(req.query, { deptId: 'D1', deep: '1' })
  assert.ok(r.json.success)
})

test('POST 命令：args 拼成 body JSON 透传', async () => {
  seedConfig()
  const r = await api.runCommand('asset', 'building-list', { current: 1, size: 10 }, RCMS())
  assert.equal(r.exitCode, 0)
  const req = mock.state.requests[0]
  assert.equal(req.path, '/api/rcms/asset/building/list')
  assert.deepEqual(req.body, { current: 1, size: 10 })
  assert.deepEqual(r.json, { success: true, code: 200, msg: 'ok', data: { echo: { current: 1, size: 10 } } })
})

test('CLI token 数组 key=value + 按命令表类型转换 number', async () => {
  seedConfig()
  const r = await api.runCommand('asset', 'building-list', ['current=5', 'size=20'], RCMS())
  assert.equal(r.exitCode, 0)
  assert.deepEqual(mock.state.requests[0].body, { current: 5, size: 20 })
})

test('--data 显式 JSON body 覆盖 args（且跳过必填校验）', async () => {
  seedConfig()
  const r = await api.runCommand('asset', 'building-list', ['--data', '{"current":5,"size":20}'], RCMS())
  assert.equal(r.exitCode, 0)
  assert.deepEqual(mock.state.requests[0].body, { current: 5, size: 20 })
})

test('--data= 内联形式也解析', async () => {
  seedConfig()
  const r = await api.runCommand('asset', 'building-list', ['--data={"a":1}'], RCMS())
  assert.equal(r.exitCode, 0)
  assert.deepEqual(mock.state.requests[0].body, { a: 1 })
})

test('已知 --flag 不进 body', async () => {
  seedConfig()
  const r = await api.runCommand('asset', 'building-list', { current: 1, size: 10, '--verbose': true }, RCMS())
  assert.equal(r.exitCode, 0)
  assert.deepEqual(mock.state.requests[0].body, { current: 1, size: 10 })
})

// ==================== JSON 输出透传 ====================

test('JSON 输出：{success, data} 透传', async () => {
  seedConfig()
  mock.state.genericHandler = (_e, respond) => respond(200, { success: true, code: 200, msg: 'ok', data: { list: [1, 2], total: 2 } })
  const r = await api.runCommand('asset', 'building-list', { current: 1, size: 10 }, RCMS())
  assert.equal(r.exitCode, 0)
  assert.deepEqual(r.json, { success: true, code: 200, msg: 'ok', data: { list: [1, 2], total: 2 } })
})

// ==================== 退出码 ====================

test('业务错误 success=false → 退出码 1', async () => {
  seedConfig()
  mock.state.genericHandler = (_e, respond) => respond(200, { success: false, code: 500, msg: '库存不足', data: null })
  const r = await api.runCommand('asset', 'building-list', { current: 1, size: 10 }, RCMS())
  assert.equal(r.exitCode, 1)
  assert.equal(r.json.success, false)
  assert.equal(r.json.msg, '库存不足')
})

test('HTTP 500（非 JSON 响应）→ 退出码 1', async () => {
  seedConfig()
  mock.state.genericHandler = (_e, _respond, _st, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('internal server error')
  }
  const r = await api.runCommand('asset', 'building-list', { current: 1, size: 10 }, RCMS())
  assert.equal(r.exitCode, 1)
  assert.match(r.json.msg, /HTTP 500/)
})

test('缺少必填参数 → 退出码 2', async () => {
  const r = await api.runCommand('asset', 'building-list', {}, RCMS())
  assert.equal(r.exitCode, 2)
  assert.match(r.json.msg, /缺少必填参数/)
  assert.ok(r.json.msg.includes('current') && r.json.msg.includes('size'))
})

test('未知模块 → 退出码 2', async () => {
  const r = await api.runCommand('nope', 'x', {}, RCMS())
  assert.equal(r.exitCode, 2)
  assert.match(r.json.msg, /未知模块/)
})

test('未知 action → 退出码 2', async () => {
  const r = await api.runCommand('asset', 'nope', {}, RCMS())
  assert.equal(r.exitCode, 2)
  assert.match(r.json.msg, /未知命令/)
})

test('未登录（AUTH_REQUIRED）→ 退出码 3', async () => {
  const r = await api.runCommand('asset', 'building-list', { current: 1, size: 10 }, RCMS())
  assert.equal(r.exitCode, 3)
  assert.equal(r.json.success, false)
})

test('网络错误（连接被拒）→ 退出码 4', async () => {
  seedConfig()
  const port = await closedPort()
  const r = await api.runCommand('asset', 'building-list', { current: 1, size: 10 }, { baseUrl: `https://127.0.0.1:${port}/api/rcms`, rejectUnauthorized: false })
  assert.equal(r.exitCode, 4)
  assert.equal(r.json.success, false)
})

// ==================== 401 → refresh → 重试 ====================

test('401 → refresh → 重试一次成功', async () => {
  seedConfig()
  mock.state.genericHandler = (entry, respond) => {
    const authz = entry.headers.authorization || ''
    if (authz === 'Bearer AT-old') return respond(401, { success: false, code: 401, msg: 'unauthorized', data: null })
    return respond(200, { success: true, code: 200, msg: 'ok', data: { echo: authz } })
  }
  const r = await api.runCommand('asset', 'building-list', { current: 1, size: 10 }, RCMS())
  assert.equal(r.exitCode, 0)
  assert.equal(mock.state.refreshCount, 1)
  const hits = mock.state.requests.filter((x) => x.path === '/api/rcms/asset/building/list')
  assert.equal(hits.length, 2) // 首次 401 + 重试
  assert.equal(r.json.data.echo, 'Bearer AT-new')
})

test('401 重试后仍 401 → 退出码 3', async () => {
  seedConfig()
  mock.state.genericHandler = (_e, respond) => respond(401, { success: false, code: 401, msg: 'unauthorized', data: null })
  const r = await api.runCommand('asset', 'building-list', { current: 1, size: 10 }, RCMS())
  assert.equal(r.exitCode, 3)
})

// ==================== rawRequest ====================

test('rawRequest：原始调用（不查命令表）', async () => {
  seedConfig()
  const r = await api.rawRequest({ path: '/asset/building/list', method: 'POST', data: { current: 1, size: 10 }, baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(r.exitCode, 0)
  assert.equal(mock.state.requests[0].path, '/api/rcms/asset/building/list')
  assert.deepEqual(mock.state.requests[0].body, { current: 1, size: 10 })
})

test('rawRequest 未登录 → 退出码 3', async () => {
  const r = await api.rawRequest({ path: '/x', baseUrl: mock.baseUrl, rejectUnauthorized: false })
  assert.equal(r.exitCode, 3)
  assert.equal(r.json.success, false)
})
