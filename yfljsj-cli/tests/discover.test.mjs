// discover 代理测试 — mock 网关用本地 http server（测试用 http 转发，免 TLS）
// 覆盖：startProxy 透传/捕获/CONNECT、mergeApis 去重合并、runDiscover 写回 apis.json + 统计、
//       loadApis 用户 apis.json 优先。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const api = await import('../yfljsj.mjs')

// 模块级默认 home（无 apis.json → loadApis 回退静态 seed）
const TMP = mkdtempSync(path.join(os.tmpdir(), 'yfljsj-discover-'))
process.env.YFLJSJ_HOME = TMP

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 临时 home 辅助：切 YFLJSJ_HOME 执行 fn，结束恢复 + 清理
function newHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'yfljsj-discover-home-'))
}
async function withHome(home, fn) {
  const old = process.env.YFLJSJ_HOME
  process.env.YFLJSJ_HOME = home
  try {
    return await fn()
  } finally {
    process.env.YFLJSJ_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
}

// 本地 http mock 网关（记录请求，回显 body）
function startMockGateway() {
  const state = { requests: [] }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const u = new URL(req.url, 'http://localhost')
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      state.requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, code: 200, msg: 'ok', data: { echo: body } }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            if (typeof server.closeAllConnections === 'function') {
              try { server.closeAllConnections() } catch { /* ignore */ }
            }
            server.close(r)
          }),
      })
    })
  })
}

// 向代理发普通 http 请求（absolute=true 时 path 用绝对 URL 形式，模拟标准 HTTP 代理）
function send(method, port, pathname, body, { absolute = false, target } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null
    const reqPath = absolute ? `${target}${pathname}` : pathname
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        agent: false, // 禁用 keep-alive，避免 server.close() 等待连接释放而挂起
        headers: payload != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          let j = null
          try {
            j = JSON.parse(raw)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, body: j, raw })
        })
      }
    )
    req.on('error', reject)
    if (payload != null) req.write(payload)
    req.end()
  })
}

// CONNECT 请求（https 系统代理隧道探测）：Node 客户端对 CONNECT 走 request 'connect' 事件
function sendConnect(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target, agent: false })
    req.on('connect', (res, socket, head) => {
      let raw = head ? head.toString() : ''
      socket.on('data', (c) => { raw += c })
      socket.on('end', () => resolve({ status: res.statusCode, raw }))
      socket.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

// 取一个刚释放的端口（信号注入测试用固定端口）
function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// 轮询等待端口可 TCP 连接（不发送 HTTP 数据，避免污染捕获）
function waitPortOpen(port, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    const tryConnect = () => {
      const sock = net.connect({ host: '127.0.0.1', port })
      const retry = () => {
        sock.destroy()
        if (Date.now() > deadline) reject(new Error(`端口 ${port} 未就绪`))
        else setTimeout(tryConnect, 20)
      }
      sock.once('connect', () => { sock.destroy(); resolve() })
      sock.once('error', retry)
    }
    tryConnect()
  })
}

// ==================== startProxy：透传 + 捕获 ====================

test('startProxy：转发到 mock 网关并捕获 method/path/body样例/contentType', async () => {
  const mock = await startMockGateway()
  try {
    const captured = []
    const proxy = await api.startProxy({ port: 0, baseUrl: mock.baseUrl, onCapture: (r) => captured.push(r) })
    try {
      const res = await send('POST', proxy.port, '/api/rcms/asset/capturedNew/list', { current: 1, size: 10 })
      assert.equal(res.status, 200)
      assert.deepEqual(res.body, { success: true, code: 200, msg: 'ok', data: { echo: { current: 1, size: 10 } } })
      // 透传：mock 网关收到同 path、同 body
      assert.equal(mock.state.requests.length, 1)
      assert.equal(mock.state.requests[0].method, 'POST')
      assert.equal(mock.state.requests[0].path, '/api/rcms/asset/capturedNew/list')
      assert.deepEqual(mock.state.requests[0].body, { current: 1, size: 10 })
      // 捕获记录 + onCapture 回调
      assert.equal(proxy.captured.length, 1)
      assert.equal(captured.length, 1)
      const rec = proxy.captured[0]
      assert.equal(rec.method, 'POST')
      assert.equal(rec.path, '/api/rcms/asset/capturedNew/list')
      assert.deepEqual(rec.body样例, { current: 1, size: 10 })
      assert.match(rec.contentType, /json/)
    } finally {
      await proxy.close()
    }
  } finally {
    await mock.close()
  }
})

test('startProxy：绝对 URL（标准代理形式）+ GET query 透传', async () => {
  const mock = await startMockGateway()
  try {
    const proxy = await api.startProxy({ port: 0, baseUrl: 'http://unused.invalid' })
    try {
      const res = await send('GET', proxy.port, '/api/rcms/asset/building/page?current=2&size=20', undefined, {
        absolute: true,
        target: mock.baseUrl,
      })
      assert.equal(res.status, 200)
      // mock 收到绝对 URL 指向的目标路径与 query
      assert.equal(mock.state.requests.length, 1)
      assert.equal(mock.state.requests[0].path, '/api/rcms/asset/building/page')
      assert.deepEqual(mock.state.requests[0].query, { current: '2', size: '20' })
      // 捕获：path 只记 pathname（无 query），GET 无 body
      assert.equal(proxy.captured.length, 1)
      assert.equal(proxy.captured[0].path, '/api/rcms/asset/building/page')
      assert.equal(proxy.captured[0].method, 'GET')
      assert.equal(proxy.captured[0].body样例, null)
    } finally {
      await proxy.close()
    }
  } finally {
    await mock.close()
  }
})

test('startProxy：CONNECT 返回 501 且不转发不捕获', async () => {
  const mock = await startMockGateway()
  try {
    const proxy = await api.startProxy({ port: 0, baseUrl: mock.baseUrl })
    try {
      const res = await sendConnect(proxy.port, 'gateway.yfljsj.com:443')
      assert.equal(res.status, 501)
      assert.match(res.raw, /CONNECT 隧道/)
      assert.equal(mock.state.requests.length, 0) // 未转发
      assert.equal(proxy.captured.length, 0) // 未当作接口捕获
    } finally {
      await proxy.close()
    }
  } finally {
    await mock.close()
  }
})

// ==================== mergeApis：去重合并 ====================

test('mergeApis：新接口并入 + 按 path 去重 + 服务/action/参数推断', () => {
  const existing = {
    version: 1,
    services: { rcms: 'https://gateway.yfljsj.com/api/rcms', upms: 'https://gateway.yfljsj.com/api/upms' },
    modules: {
      asset: {
        title: 'asset',
        service: 'rcms',
        commands: [
          { action: 'building-list', method: 'POST', path: '/asset/building/list', params: { current: 'number', size: 'number' }, desc: '/asset/building/list', kind: 'read' },
        ],
      },
    },
  }
  const captured = [
    { method: 'POST', path: '/asset/building/list', body样例: { current: 1 }, contentType: 'application/json' }, // 已存在 → 去重
    { method: 'POST', path: '/asset/building/add', body样例: { name: 'x', count: 3 }, contentType: 'application/json' }, // 新增
    { method: 'POST', path: '/user/sysUser/page', body样例: {}, contentType: 'application/json' }, // 新模块
  ]
  const merged = api.mergeApis(existing, captured)
  // asset 模块：既有 1 + 新增 1（building/list 不重复）
  assert.equal(merged.modules.asset.commands.length, 2)
  assert.equal(merged.modules.asset.commands.filter((c) => c.path === '/asset/building/list').length, 1)
  // action 命名复用 gen-apis inferAction：building-add
  assert.ok(merged.modules.asset.commands.some((c) => c.path === '/asset/building/add' && c.action === 'building-add' && c.kind === 'write'))
  // 新模块 user → upms 服务
  assert.equal(merged.modules.user.service, 'upms')
  assert.ok(merged.modules.user.commands.some((c) => c.path === '/user/sysUser/page' && c.action === 'sysUser-page' && c.method === 'POST'))
  // body样例 反推 params
  const add = merged.modules.asset.commands.find((c) => c.path === '/asset/building/add')
  assert.equal(add.params.name, 'string')
  assert.equal(add.params.count, 'number')
  // 分页接口补 page 参数（v2 对象定义）
  const page = merged.modules.user.commands.find((c) => c.path === '/user/sysUser/page')
  assert.deepEqual(page.params, {
    current: { type: 'number', required: true, desc: '页码（从1开始）', auto: false },
    size: { type: 'number', required: true, desc: '每页条数' },
  })
  // 不修改入参
  assert.equal(existing.modules.asset.commands.length, 1)
})

test('mergeApis：捕获路径去掉 /api/<service> 前缀并入命令表', () => {
  const existing = { version: 1, services: { rcms: 'https://gateway.yfljsj.com/api/rcms' }, modules: {} }
  const merged = api.mergeApis(existing, [{ method: 'POST', path: '/api/rcms/asset/capturedNew/list', body样例: { a: 1 }, contentType: 'application/json' }])
  assert.ok(merged.modules.asset.commands.some((c) => c.path === '/asset/capturedNew/list'))
  assert.equal(merged.modules.asset.service, 'rcms')
  assert.ok(!merged.modules.api) // 不产生 /api 伪模块
})

test('mergeApis：空捕获 / 缺 path 记录安全跳过', () => {
  const existing = { version: 1, services: {}, modules: {} }
  assert.deepEqual(api.mergeApis(existing, []).modules, {})
  assert.deepEqual(api.mergeApis(existing, [null, { method: 'GET' }, { path: '' }, { path: null }]).modules, {})
})

// Task 7：discover 合并写回不得丢业务元数据（relations/doc 子命令依赖）
test('mergeApis：保留 existing 的 operations/relations 元数据', () => {
  const existing = {
    version: 2,
    services: { rcms: 'x' },
    modules: { asset: { title: 'asset', service: 'rcms', commands: [{ action: 'building-list', method: 'POST', path: '/asset/building/list', params: {}, kind: 'read' }] } },
    operations: { createProject: { title: '创建研发项目', steps: [{ cmd: 'workbench projectInfo-add', desc: '1. 建项目' }] } },
    relations: { project: { title: '项目', createOrder: ['projectInfo-add'] } },
  }
  const merged = api.mergeApis(existing, [{ method: 'POST', path: '/asset/new/add', body样例: {} }])
  assert.deepEqual(merged.operations, existing.operations)
  assert.deepEqual(merged.relations, existing.relations)
  assert.ok(merged.modules.asset.commands.some((c) => c.path === '/asset/new/add'))
  // 无 existing 元数据 → 兜底为空对象（不 undefined，relationsCommand/docCommand 可安全遍历）
  const bare = api.mergeApis({ version: 2, services: {}, modules: {} }, [])
  assert.deepEqual(bare.operations, {})
  assert.deepEqual(bare.relations, {})
})

// ==================== runDiscover：捕获 → 合并 → 写回 + 统计 ====================

test('runDiscover：捕获→合并→写回 apis.json + 统计输出 + loadApis 优先用户表', async () => {
  const mock = await startMockGateway()
  try {
    const home = newHome()
    await withHome(home, async () => {
      const lines = []
      const output = { write: (s) => lines.push(s) }
      const r = await api.runDiscover({
        port: 0,
        baseUrl: mock.baseUrl,
        output,
        whenReady: async ({ proxy, finish }) => {
          const res = await send('POST', proxy.port, '/api/rcms/asset/discoveredNew/list', { current: 1 })
          assert.equal(res.status, 200)
          finish()
        },
      })
      // 统计
      assert.equal(r.stats.captured, 1)
      assert.equal(r.stats.modules, 1)
      assert.equal(r.stats.added, 1)
      const text = lines.join('')
      assert.match(text, /浏览器代理指向 http:\/\/127\.0\.0\.1:\d+，操作前端各模块，Ctrl\+C 结束/)
      assert.match(text, /捕获 1 接口、1 模块、新增 1/)
      // 写回 ~/.yfljsj/apis.json
      const p = path.join(home, '.yfljsj', 'apis.json')
      assert.ok(existsSync(p))
      const apis = JSON.parse(readFileSync(p, 'utf8'))
      assert.ok(apis.modules.asset.commands.some((c) => c.path === '/asset/discoveredNew/list'))
      assert.equal(apis.version, 2) // v2：discover 写回的用户命令表为 v2 结构（loadApis 已迁移）
      // loadApis 优先读用户写回的 apis.json
      const loaded = api.loadApis({ force: true })
      assert.ok(loaded.modules.asset.commands.some((c) => c.path === '/asset/discoveredNew/list'))
    })
  } finally {
    await mock.close()
  }
})

test('runDiscover 统计：重复请求按接口去重（captured/added 计唯一）', async () => {
  const mock = await startMockGateway()
  try {
    const home = newHome()
    await withHome(home, async () => {
      const r = await api.runDiscover({
        port: 0,
        baseUrl: mock.baseUrl,
        output: { write: () => {} },
        whenReady: async ({ proxy, finish }) => {
          await send('POST', proxy.port, '/api/rcms/asset/discoverDupTest/list', { current: 1 })
          await send('POST', proxy.port, '/api/rcms/asset/discoverDupTest/list', { current: 2 }) // 同接口再次捕获
          await send('GET', proxy.port, '/api/upms/user/discoverDupTestUser/page')
          finish()
        },
      })
      assert.equal(r.stats.captured, 2) // 两个唯一接口（path 去重）
      assert.equal(r.stats.modules, 2) // asset + user
      assert.equal(r.stats.added, 2) // 新增命令（不重复，且均不在 seed）
      assert.equal(r.captured.length, 3) // 原始捕获条数
    })
  } finally {
    await mock.close()
  }
})

test('runDiscover：signal 注入结束（等价 Ctrl+C 路径）', async () => {
  const mock = await startMockGateway()
  try {
    const home = newHome()
    await withHome(home, async () => {
      const free = await freePort()
      let resolveSignal
      const signal = new Promise((r) => { resolveSignal = r })
      const lines = []
      const p = api.runDiscover({ port: free, baseUrl: mock.baseUrl, output: { write: (s) => lines.push(s) }, signal })
      await waitPortOpen(free) // 代理就绪（不产生捕获）
      const res = await send('POST', free, '/api/rcms/asset/sigNew/list', { a: 1 })
      assert.equal(res.status, 200)
      resolveSignal()
      const r = await p
      assert.equal(r.stats.captured, 1)
      assert.equal(r.stats.added, 1)
      assert.match(lines.join(''), /捕获 1 接口、1 模块、新增 1/)
    })
  } finally {
    await mock.close()
  }
})

// ==================== loadApis：用户 apis.json 优先 ====================

test('loadApis：~/.yfljsj/apis.json 存在时优先（用户命令表生效）', () => {
  const home = newHome()
  mkdirSync(path.join(home, '.yfljsj'), { recursive: true })
  const custom = {
    version: 1,
    services: { rcms: 'https://gateway.yfljsj.com/api/rcms' },
    modules: {
      asset: {
        title: 'asset',
        service: 'rcms',
        commands: [{ action: 'x-list', method: 'POST', path: '/asset/x/list', params: {}, desc: '/asset/x/list', kind: 'read' }],
      },
    },
  }
  writeFileSync(path.join(home, '.yfljsj', 'apis.json'), JSON.stringify(custom))
  withHome(home, () => {
    const apis = api.loadApis({ force: true })
    assert.ok(apis.modules.asset.commands.some((c) => c.path === '/asset/x/list'))
    assert.equal(apis.modules.asset.commands.length, 1) // 用户表优先，而非 seed 全量
  })
})

test('loadApis：用户 apis.json 损坏时回退静态 seed', () => {
  const home = newHome()
  mkdirSync(path.join(home, '.yfljsj'), { recursive: true })
  writeFileSync(path.join(home, '.yfljsj', 'apis.json'), '{broken json')
  withHome(home, () => {
    const apis = api.loadApis({ force: true })
    assert.ok(apis.modules.asset) // seed 内容可用
    assert.ok(apis.modules.asset.commands.length > 0)
  })
})

test('loadApis：用户 apis.json 空 modules 回退 seed（空表不吞 535 命令）', () => {
  const home = newHome()
  mkdirSync(path.join(home, '.yfljsj'), { recursive: true })
  writeFileSync(path.join(home, '.yfljsj', 'apis.json'), JSON.stringify({ version: 2, modules: {} }))
  withHome(home, () => {
    const apis = api.loadApis({ force: true })
    // 空 modules 用户表 → 回退 seed：31 模块全量命令可用
    assert.ok(Object.keys(apis.modules).length > 0)
    assert.ok(apis.modules.asset)
    assert.ok(apis.modules.asset.commands.length > 0)
  })
})
