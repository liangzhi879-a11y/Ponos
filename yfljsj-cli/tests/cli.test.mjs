// CLI 入口测试 — 参数解析 / 命令路由 / 输出格式化
// 子进程端到端用本地 https mock 网关（自签名证书，不联网）；模块级测试直接 import 复用导出。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:https'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY = readFileSync(new URL('./fixtures/key.pem', import.meta.url))
const CERT = readFileSync(new URL('./fixtures/cert.pem', import.meta.url))
const CLI = fileURLToPath(new URL('../yfljsj.mjs', import.meta.url))
const CLI_DIR = path.dirname(CLI)

const api = await import('../yfljsj.mjs')

// ==================== mock 网关（oauth 登录/refresh + rcms 通用成功响应） ====================
let mock
before(async () => {
  mock = await startMock()
})
after(async () => {
  await mock.close()
})

function startMock() {
  const state = { requests: [] }
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
      state.requests.push({ method: req.method, path: u.pathname, headers: req.headers, body })
      const respond = (status, json) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(json))
      }
      const route = u.pathname.replace(/^\/api\/[^/]+/, '')
      if (route === '/auth/login') {
        return respond(200, { success: true, code: 200, msg: 'ok', data: { accessToken: 'AT-cli', refreshToken: 'RT-cli', tenantId: 'T-CLI', expiresIn: 7200 } })
      }
      if (route === '/auth/refresh-token') {
        return respond(200, { success: true, code: 200, msg: 'ok', data: { accessToken: 'AT-new', refreshToken: 'RT-new', tenantId: 'T-CLI', expiresIn: 7200 } })
      }
      return respond(200, { success: true, code: 200, msg: 'ok', data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        state,
        server,
        oauth: `https://127.0.0.1:${port}/api/oauth`,
        rcms: `https://127.0.0.1:${port}/api/rcms`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

// ==================== 子进程 helper ====================
function newHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'yfljsj-cli-'))
}

function seedConfig(home, { accessToken = 'AT-cli', refreshToken = 'RT-cli', tenantId = 'T-CLI', expiresAt = Date.now() + 3600_000 } = {}) {
  mkdirSync(path.join(home, '.yfljsj'), { recursive: true })
  writeFileSync(path.join(home, '.yfljsj', 'config.json'), JSON.stringify({ accessToken, refreshToken, tenantId, expiresAt }))
}

function run(args, { home, env: extraEnv } = {}) {
  return new Promise((resolve) => {
    const tmp = home || newHome()
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: CLI_DIR,
      env: { ...process.env, YFLJSJ_HOME: tmp, ...extraEnv },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

// ==================== parseArgs（CLI 级） ====================
test('parseArgs：auth login 参数解析（--key value）', () => {
  const a = api.parseArgs(['auth', 'login', '--method', 'password', '--user', 'u', '--password', 'p'])
  assert.equal(a.command, 'auth')
  assert.equal(a.sub, 'login')
  assert.equal(a.opts['--method'], 'password')
  assert.equal(a.opts['--user'], 'u')
  assert.equal(a.opts['--password'], 'p')
  assert.deepEqual(a.positional, [])
})

test('parseArgs：captcha / tenant 登录形态', () => {
  const c = api.parseArgs(['auth', 'login', '--method', 'captcha', '--user', 'u', '--code', '123456'])
  assert.equal(c.opts['--method'], 'captcha')
  assert.equal(c.opts['--code'], '123456')
  const t = api.parseArgs(['auth', 'login', '--method', 'tenant', '--user', 'u', '--tenant', 'T'])
  assert.equal(t.opts['--tenant'], 'T')
})

test('parseArgs：<module> <action> --param value', () => {
  const a = api.parseArgs(['asset', 'building-list', '--current', '1'])
  assert.equal(a.command, 'asset')
  assert.equal(a.sub, 'building-list')
  assert.equal(a.opts['--current'], '1')
})

test('parseArgs：raw path + --data + --method', () => {
  const a = api.parseArgs(['raw', '/asset/building/list', '--data', '{"current":1}', '--method', 'POST'])
  assert.equal(a.command, 'raw')
  assert.equal(a.sub, '/asset/building/list')
  assert.equal(a.opts['--data'], '{"current":1}')
  assert.equal(a.opts['--method'], 'POST')
})

test('parseArgs：顶层 --help / --version / 空 argv / -h / -v', () => {
  assert.equal(api.parseArgs(['--help']).command, '--help')
  assert.equal(api.parseArgs(['--version']).command, '--version')
  assert.equal(api.parseArgs(['-h']).command, '-h')
  assert.equal(api.parseArgs(['-v']).command, '-v')
  assert.equal(api.parseArgs([]).command, null)
})

test('parseArgs：--flag 布尔 / --key=value / discover --port', () => {
  assert.equal(api.parseArgs(['asset', 'building-list', '--verbose']).opts['--verbose'], true)
  assert.equal(api.parseArgs(['raw', '/x', '--method=GET']).opts['--method'], 'GET')
  assert.equal(api.parseArgs(['discover', '--port', '8899']).opts['--port'], '8899')
})

// ==================== formatOutput ====================
test('formatOutput：默认 --json 输出合法 JSON', () => {
  const json = { success: true, code: 0, msg: 'ok', data: { a: 1 } }
  const s = api.formatOutput(json)
  assert.deepEqual(JSON.parse(s), json)
})

test('formatOutput：--human 数组字段自动表头', () => {
  const s = api.formatOutput({ success: true, code: 0, msg: 'ok', data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] }, { human: true })
  assert.ok(s.includes('| id | name |'))
  assert.ok(s.includes('| 1'))
  assert.ok(s.includes('| b'))
})

test('formatOutput：--human 非数组平铺 key: value', () => {
  const s = api.formatOutput({ success: true, code: 0, msg: 'ok' }, { human: true })
  assert.ok(s.includes('success: true'))
  assert.ok(s.includes('msg: ok'))
})

// ==================== main（import 级，离线） ====================
test('main：--help / --version 退出码 0', async () => {
  assert.equal(await api.main(['--help']), 0)
  assert.equal(await api.main(['--version']), 0)
})

test('main：未知命令 → 退出码 2', async () => {
  assert.equal(await api.main(['bogus']), 2)
})

test('main：auth status 无 token → 退出码 3', async () => {
  const home = newHome()
  process.env.YFLJSJ_HOME = home
  assert.equal(await api.main(['auth', 'status']), 3)
})

// ==================== 子进程端到端（无 token / 用法错误，离线） ====================
test('CLI：--help 打印命令树，退出码 0，stderr 无噪声', async () => {
  const { code, out, err } = await run(['--help'])
  assert.equal(code, 0)
  assert.ok(out.includes('auth login'))
  assert.ok(out.includes('raw <path>'))
  assert.ok(out.includes('退出码'))
  assert.equal(err, '')
})

test('CLI：--version 打印版本号，退出码 0', async () => {
  const { code, out } = await run(['--version'])
  assert.equal(code, 0)
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/)
})

test('CLI：未知命令 → 退出码 2，stdout 纯 JSON，stderr 提示', async () => {
  const { code, out, err } = await run(['bogus', 'cmd'])
  assert.equal(code, 2)
  const j = JSON.parse(out) // stdout 纯 JSON（无日志混入）
  assert.equal(j.success, false)
  assert.equal(j.code, 2)
  assert.ok(err.includes('未知'))
})

test('CLI：auth 无子命令 → 退出码 2 + stdout JSON', async () => {
  const { code, out } = await run(['auth'])
  assert.equal(code, 2)
  assert.equal(JSON.parse(out).code, 2)
})

test('CLI：auth login 缺参数 → 退出码 2', async () => {
  const { code, out } = await run(['auth', 'login', '--method', 'password', '--user', 'u'])
  assert.equal(code, 2)
  assert.equal(JSON.parse(out).code, 2)
})

test('CLI：auth status 无 token → 退出码 3，stdout 纯 JSON', async () => {
  const { code, out } = await run(['auth', 'status'])
  assert.equal(code, 3)
  const j = JSON.parse(out)
  assert.equal(j.success, false)
  assert.equal(j.code, 3)
})

test('CLI：auth status 有 token → 退出码 0，stdout 含 token 信息', async () => {
  const home = newHome()
  seedConfig(home)
  const { code, out } = await run(['auth', 'status'], { home })
  assert.equal(code, 0)
  const j = JSON.parse(out)
  assert.equal(j.success, true)
  assert.equal(j.data.accessToken, 'AT-cli')
  assert.equal(j.data.expired, false)
})

test('CLI：discover 启动本地代理并打印指向提示（交互式，kill 结束）', async () => {
  const home = newHome()
  const child = spawn(process.execPath, [CLI, 'discover', '--port', '0'], {
    cwd: CLI_DIR,
    env: { ...process.env, YFLJSJ_HOME: home },
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { err += c })
  const hintSeen = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`discover 未在超时内打印指向提示（err=${err}）`)), 5000)
    child.stderr.on('data', () => {
      if (/浏览器代理指向/.test(err)) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('close', (code) => {
      if (!/浏览器代理指向/.test(err)) {
        clearTimeout(timer)
        reject(new Error(`discover 提前退出 code=${code}（err=${err}）`))
      }
    })
  })
  try {
    await hintSeen
    assert.match(err, /浏览器代理指向 http:\/\/127\.0\.0\.1:\d+，操作前端各模块，Ctrl\+C 结束/)
    assert.equal(out, '') // 诊断走 stderr，stdout 保持干净
  } finally {
    child.kill()
  }
  await new Promise((r) => child.once('close', r))
})

test('CLI：<module> <action> 未登录 → 路由到 runCommand → 退出码 3，stdout 纯 JSON', async () => {
  const { code, out } = await run(['asset', 'building-list', '--current', '1', '--size', '10'])
  assert.equal(code, 3)
  const j = JSON.parse(out)
  assert.equal(j.success, false)
  assert.equal(j.code, 3)
})

test('CLI：raw 未登录 → 退出码 3，stdout 纯 JSON', async () => {
  const { code, out } = await run(['raw', '/asset/building/list', '--data', '{"current":1}'])
  assert.equal(code, 3)
  const j = JSON.parse(out)
  assert.equal(j.code, 3)
})

// ==================== 子进程 + mock 网关（端到端，离线） ====================
test('CLI：asset building-list --current 1 --size 10 → 端到端成功，stdout 纯 JSON 退出码 0', async () => {
  const home = newHome()
  seedConfig(home)
  const { code, out } = await run(['asset', 'building-list', '--current', '1', '--size', '10'], {
    home,
    env: { YFLJSJ_GATEWAY: mock.rcms, YFLJSJ_INSECURE: '1' },
  })
  assert.equal(code, 0)
  const j = JSON.parse(out)
  assert.equal(j.success, true)
  assert.equal(j.data.length, 2)
  assert.equal(j.data[0].name, 'a')
  // 请求确实打到 mock 网关 rcms 前缀（命令表 path 正确拼接）
  assert.ok(mock.state.requests.some((r) => r.path === '/api/rcms/asset/building/list'))
})

test('CLI：raw --data 端到端成功，body 透传', async () => {
  const home = newHome()
  seedConfig(home)
  const { code, out } = await run(['raw', '/asset/building/list', '--data', '{"current":5,"size":20}'], {
    home,
    env: { YFLJSJ_GATEWAY: mock.rcms, YFLJSJ_INSECURE: '1' },
  })
  assert.equal(code, 0)
  const j = JSON.parse(out)
  assert.equal(j.success, true)
  const matches = mock.state.requests.filter((r) => r.path === '/api/rcms/asset/building/list' && r.method === 'POST')
  assert.deepEqual(matches[matches.length - 1].body, { current: 5, size: 20 })
})

test('CLI：auth login 端到端成功（mock oauth）并落 token', async () => {
  const home = newHome()
  const { code, out } = await run(['auth', 'login', '--method', 'password', '--user', 'alice', '--password', 'pw'], {
    home,
    env: { YFLJSJ_GATEWAY: mock.oauth, YFLJSJ_INSECURE: '1' },
  })
  assert.equal(code, 0)
  const j = JSON.parse(out)
  assert.equal(j.success, true)
  assert.equal(j.data.loggedIn, true)
  // 登录后 auth status 可见 token
  const st = await run(['auth', 'status'], { home, env: { YFLJSJ_GATEWAY: mock.oauth, YFLJSJ_INSECURE: '1' } })
  assert.equal(st.code, 0)
  assert.equal(JSON.parse(st.out).data.accessToken, 'AT-cli')
})

test('CLI：--human 表格输出（数组字段自动表头）', async () => {
  const home = newHome()
  seedConfig(home)
  const { code, out } = await run(['asset', 'building-list', '--current', '1', '--size', '10', '--human'], {
    home,
    env: { YFLJSJ_GATEWAY: mock.rcms, YFLJSJ_INSECURE: '1' },
  })
  assert.equal(code, 0)
  assert.ok(out.includes('| id | name |'))
  assert.ok(out.includes('| b'))
})
