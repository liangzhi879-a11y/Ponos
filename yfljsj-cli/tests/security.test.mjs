// Task 6 安全钩子测试 — 写确认 / 域名白名单（防 SSRF）/ 审计日志 / 敏感字段脱敏
// mock 网关用本地 https server（自签名证书，127.0.0.1 属白名单，不联网）
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:https'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const api = await import('../yfljsj.mjs')
const CLI = fileURLToPath(new URL('../yfljsj.mjs', import.meta.url))
const CLI_DIR = path.dirname(CLI)
const KEY = readFileSync(new URL('./fixtures/key.pem', import.meta.url))
const CERT = readFileSync(new URL('./fixtures/cert.pem', import.meta.url))

// 模块级默认 home（config/audit 落这里）
const HOME = mkdtempSync(path.join(os.tmpdir(), 'yfljsj-security-'))
process.env.YFLJSJ_HOME = HOME
const AUDIT = path.join(HOME, '.yfljsj', 'audit.log')

function seedConfig(home = HOME) {
  mkdirSync(path.join(home, '.yfljsj'), { recursive: true })
  writeFileSync(
    path.join(home, '.yfljsj', 'config.json'),
    JSON.stringify({ accessToken: 'AT-sec', refreshToken: 'RT-sec', tenantId: 'T-sec', expiresAt: Date.now() + 3600_000 })
  )
}

// 本地 https mock 网关（non-auth 路由回显 body；state.nextData 覆盖返回数据）
function startMock() {
  const state = { requests: [], nextData: undefined }
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
      if (route === '/auth/refresh-token') {
        return respond(200, { success: true, code: 200, msg: 'ok', data: { accessToken: 'AT-sec', refreshToken: 'RT-sec', tenantId: 'T-sec', expiresIn: 7200 } })
      }
      if (state.nextData !== undefined) {
        return respond(200, { success: true, code: 200, msg: 'ok', data: state.nextData })
      }
      respond(200, { success: true, code: 200, msg: 'ok', data: { echo: body } })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        state,
        server,
        rcms: `https://127.0.0.1:${port}/api/rcms`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

let mock
before(async () => {
  mock = await startMock()
  seedConfig()
})
after(async () => {
  await mock.close()
})

const RCMS = (extra = {}) => ({ baseUrl: mock.rcms, rejectUnauthorized: false, ...extra })

// 子进程 helper（home 隔离 + mock 网关环境变量）。已存在 config 时不再覆盖
// （保证 config set 的配置项在同 home 的多次运行间持久生效）。
function run(args, { home, env: extraEnv } = {}) {
  return new Promise((resolve) => {
    const tmp = home || mkdtempSync(path.join(os.tmpdir(), 'yfljsj-sec-run-'))
    if (!existsSync(path.join(tmp, '.yfljsj', 'config.json'))) seedConfig(tmp)
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

// ==================== confirmWrite（单元） ====================
test('confirmWrite：read 命令直接放行', () => {
  assert.deepEqual(api.confirmWrite({ kind: 'read', action: 'building-list' }, {}), { allowed: true })
})

test('confirmWrite：write 无 --confirm/--yes → 拒绝', () => {
  const r = api.confirmWrite({ kind: 'write', action: 'building-add' }, {})
  assert.equal(r.allowed, false)
  assert.match(r.reason, /确认/)
})

test('confirmWrite：--confirm / --yes 放行；--confirm=false 不放行', () => {
  assert.equal(api.confirmWrite({ kind: 'write', action: 'building-add' }, { '--confirm': true }).allowed, true)
  assert.equal(api.confirmWrite({ kind: 'write', action: 'building-add' }, { '--yes': true }).allowed, true)
  assert.equal(api.confirmWrite({ kind: 'write', action: 'building-add' }, { '--confirm': 'false' }).allowed, false)
})

test('confirmWrite：delete/remove 类有确认仍缺 --force → 拒绝', () => {
  const r = api.confirmWrite({ kind: 'write', action: 'building-deleteById' }, { '--confirm': true })
  assert.equal(r.allowed, false)
  assert.match(r.reason, /force/)
  const r2 = api.confirmWrite({ kind: 'write', action: 'projectInfo-remove' }, { '--yes': true })
  assert.equal(r2.allowed, false)
  assert.match(r2.reason, /force/)
})

test('confirmWrite：delete + --confirm + --force → 放行', () => {
  assert.equal(api.confirmWrite({ kind: 'write', action: 'building-deleteBatch' }, { '--confirm': true, '--force': true }).allowed, true)
})

// ==================== assertWhitelist（单元，防 SSRF） ====================
test('assertWhitelist：*.yfljsj.com 生产网关放行', () => {
  assert.equal(api.assertWhitelist('https://gateway.yfljsj.com/api/rcms/x').allowed, true)
  assert.equal(api.assertWhitelist('https://sub.api.yfljsj.com/x').allowed, true)
  assert.equal(api.assertWhitelist('https://yfljsj.com/x').allowed, true)
})

test('assertWhitelist：localhost/127.0.0.1 回环放行（测试 mock）', () => {
  assert.equal(api.assertWhitelist('https://127.0.0.1:39999/api/x').allowed, true)
  assert.equal(api.assertWhitelist('http://localhost:8899/x').allowed, true)
})

test('assertWhitelist：非白名单域名/畸形 URL 拒绝', () => {
  assert.equal(api.assertWhitelist('https://evil.example.com/x').allowed, false)
  assert.equal(api.assertWhitelist('http://192.168.1.10/x').allowed, false)
  assert.equal(api.assertWhitelist('https://gateway.yfljsj.com.evil.com/x').allowed, false) // 前缀伪装不通过
  assert.equal(api.assertWhitelist('not-a-url').allowed, false)
})

// ==================== runCommand / rawRequest 安全钩子 ====================
test('runCommand：写操作缺 --confirm → 退出码 2，不发请求', async () => {
  mock.state.requests.length = 0
  const r = await api.runCommand('asset', 'building-add', { name: 'x' }, RCMS())
  assert.equal(r.exitCode, 2)
  assert.match(r.json.msg, /确认/)
  assert.equal(mock.state.requests.length, 0)
})

test('runCommand：写操作 + --confirm → 放行成功', async () => {
  const r = await api.runCommand('asset', 'building-add', { name: 'x' }, RCMS({ '--confirm': true }))
  assert.equal(r.exitCode, 0)
  assert.equal(r.json.success, true)
})

test('runCommand：delete 缺 --force → 退出码 2', async () => {
  const r = await api.runCommand('asset', 'building-deleteById', {}, RCMS({ '--confirm': true }))
  assert.equal(r.exitCode, 2)
  assert.match(r.json.msg, /force/)
})

test('runCommand：非白名单 baseUrl → 退出码 2，不发请求（防 SSRF）', async () => {
  mock.state.requests.length = 0
  const r = await api.runCommand(
    'asset',
    'building-list',
    { current: 1, size: 10 },
    { baseUrl: 'https://evil.example.com/api/rcms', rejectUnauthorized: false }
  )
  assert.equal(r.exitCode, 2)
  assert.match(r.json.msg, /白名单/)
  assert.equal(mock.state.requests.length, 0)
})

test('rawRequest：非白名单 baseUrl → 退出码 2（防 SSRF）', async () => {
  const r = await api.rawRequest({ path: '/x', baseUrl: 'https://evil.example.com/api' })
  assert.equal(r.exitCode, 2)
  assert.match(r.json.msg, /白名单/)
})

test('rawRequest：白名单 mock baseUrl → 正常放行', async () => {
  const r = await api.rawRequest({ path: '/asset/building/list', method: 'POST', data: { a: 1 }, baseUrl: mock.rcms, rejectUnauthorized: false })
  assert.equal(r.exitCode, 0)
})

// ==================== 审计日志 ====================
test('audit.log：写操作（已确认）记录命令/路径/方法，不含 token/密码', async () => {
  rmSync(AUDIT, { force: true })
  seedConfig()
  const r = await api.runCommand('asset', 'building-add', { name: 'x', password: 'pw-123' }, RCMS({ '--confirm': true }))
  assert.equal(r.exitCode, 0)
  assert.ok(existsSync(AUDIT))
  const log = readFileSync(AUDIT, 'utf8')
  assert.ok(log.includes('asset building-add'))
  assert.ok(log.includes('method=POST'))
  assert.ok(log.includes('path=/asset/building/add'))
  assert.ok(!log.includes('AT-sec')) // accessToken 不入审计
  assert.ok(!log.includes('RT-sec')) // refreshToken 不入审计
  assert.ok(!log.includes('pw-123')) // 请求体密码不入审计
})

test('audit.log：读操作与 rawRequest 也留痕', async () => {
  rmSync(AUDIT, { force: true })
  seedConfig()
  await api.runCommand('asset', 'building-list', { current: 1, size: 10 }, RCMS())
  await api.rawRequest({ path: '/raw/x', method: 'POST', data: { a: 1 }, baseUrl: mock.rcms, rejectUnauthorized: false })
  const log = readFileSync(AUDIT, 'utf8')
  assert.ok(log.includes('path=/asset/building/list'))
  assert.ok(log.includes('raw /raw/x'))
})

// ==================== 敏感字段脱敏 ====================
test('maskSensitive：递归脱敏敏感字段', () => {
  const out = api.maskSensitive({ data: [{ id: 1, password: 'secret', nested: { mobile: '138' } }] }, ['password', 'mobile'])
  assert.equal(out.data[0].password, '******')
  assert.equal(out.data[0].nested.mobile, '******')
  assert.equal(out.data[0].id, 1)
})

test('formatOutput：--human 脱敏 / --json 保留原始', () => {
  const json = { success: true, data: [{ mobile: '13800000000', name: 'a' }] }
  const human = api.formatOutput(json, { human: true, sensitive: ['mobile'] })
  assert.ok(!human.includes('13800000000'))
  assert.ok(human.includes('******'))
  const plain = api.formatOutput(json, { sensitive: ['mobile'] })
  assert.ok(plain.includes('13800000000'))
})

test('runCommand：无 sensitive 声明 → sensitive=[]（跳过脱敏）', async () => {
  const r = await api.runCommand('asset', 'building-add', { name: 'x' }, RCMS({ '--confirm': true }))
  assert.equal(r.exitCode, 0)
  assert.deepEqual(r.sensitive, [])
})

// 合并前审阅修复 I-4：seed 命令表 PII 资源读接口已声明敏感字段，sensitiveFieldsOf 消费生效
test('seed：user sysUser-page 敏感字段声明 → runCommand 暴露 sensitive 列表 + --human 脱敏', async () => {
  api.loadApis({ force: true }) // 确保读到最新 seed
  const apis = api.loadApis()
  const mod = apis.modules.user
  assert.ok(mod, 'seed 应含 user 模块')
  const cmd = (mod.commands || []).find((c) => c.action === 'sysUser-page')
  assert.ok(cmd, 'seed 应含 user sysUser-page')
  mock.state.nextData = [{ id: 1, name: 'alice', mobile: '13800000000', idCard: '1101011990', phone: '010-1234' }]
  try {
    const r = await api.runCommand('user', 'sysUser-page', { current: 1, size: 10 }, RCMS())
    assert.equal(r.exitCode, 0)
    assert.ok(r.sensitive.includes('password'))
    assert.ok(r.sensitive.includes('mobile'))
    assert.ok(r.sensitive.includes('idCard'))
    assert.ok(r.sensitive.includes('phone'))
    // --human 分支实际脱敏；--json 保留原始
    const human = api.formatOutput(r.json, { human: true, sensitive: r.sensitive })
    assert.ok(!human.includes('13800000000'))
    assert.ok(!human.includes('1101011990'))
    assert.ok(human.includes('******'))
    const plain = api.formatOutput(r.json, { sensitive: r.sensitive })
    assert.ok(plain.includes('13800000000'))
  } finally {
    mock.state.nextData = undefined
  }
})

test('e2e：命令表标 sensitive（params 与命令级数组）--human 脱敏生效', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'yfljsj-sec-home-'))
  mkdirSync(path.join(home, '.yfljsj'), { recursive: true })
  seedConfig(home)
  writeFileSync(
    path.join(home, '.yfljsj', 'apis.json'),
    JSON.stringify({
      version: 1,
      services: { rcms: mock.rcms },
      modules: {
        sec: {
          title: 'sec',
          service: 'rcms',
          commands: [
            { action: 'user-add', method: 'POST', path: '/sec/user/add', kind: 'write', params: { username: 'string', password: { type: 'string', sensitive: true } } },
            { action: 'user-list', method: 'POST', path: '/sec/user/list', kind: 'read', params: {}, sensitive: ['mobile', 'idCard'] },
          ],
        },
      },
    })
  )
  const oldHome = process.env.YFLJSJ_HOME
  process.env.YFLJSJ_HOME = home
  try {
    api.loadApis({ force: true })
    // params 标 sensitive：password 脱敏
    const r = await api.runCommand('sec', 'user-add', { username: 'alice', password: 'secret123' }, RCMS({ '--confirm': true }))
    assert.equal(r.exitCode, 0)
    assert.deepEqual(r.sensitive, ['password'])
    const human = api.formatOutput(r.json, { human: true, sensitive: r.sensitive })
    assert.ok(!human.includes('secret123'))
    assert.ok(human.includes('******'))
    // 命令级 sensitive 数组：mobile/idCard 脱敏
    mock.state.nextData = [{ id: 1, name: 'alice', mobile: '13800000000', idCard: '1101011990' }]
    try {
      const r2 = await api.runCommand('sec', 'user-list', {}, RCMS())
      assert.equal(r2.exitCode, 0)
      assert.deepEqual(r2.sensitive.sort(), ['idCard', 'mobile'])
      const human2 = api.formatOutput(r2.json, { human: true, sensitive: r2.sensitive })
      assert.ok(!human2.includes('13800000000'))
      assert.ok(!human2.includes('1101011990'))
    } finally {
      mock.state.nextData = undefined
    }
  } finally {
    process.env.YFLJSJ_HOME = oldHome
    api.loadApis({ force: true }) // 恢复静态 seed
  }
})

// ==================== auto-confirm-write 配置开关 ====================
test('config set auto-confirm-write true → 写操作免 --confirm；false → 恢复强制', async () => {
  seedConfig()
  api.setConfigValue('auto-confirm-write', 'true')
  try {
    assert.equal(api.getConfigValue('auto-confirm-write'), true)
    const r = await api.runCommand('asset', 'building-add', { name: 'x' }, RCMS())
    assert.equal(r.exitCode, 0)
  } finally {
    api.setConfigValue('auto-confirm-write', 'false')
  }
  assert.equal(api.getConfigValue('auto-confirm-write'), false)
  const r = await api.runCommand('asset', 'building-add', { name: 'x' }, RCMS())
  assert.equal(r.exitCode, 2)
})

// ==================== 子进程端到端 ====================
test('CLI：写操作缺 --confirm → 退出码 2，stderr 提示', async () => {
  const r = await run(['asset', 'building-add', '--name', 'x'], { env: { YFLJSJ_GATEWAY: mock.rcms, YFLJSJ_INSECURE: '1' } })
  assert.equal(r.code, 2)
  assert.match(r.err, /确认/)
  assert.equal(JSON.parse(r.out).code, 2)
})

test('CLI：delete 缺 --force → 退出码 2', async () => {
  const r = await run(['asset', 'building-deleteById', '--confirm'], { env: { YFLJSJ_GATEWAY: mock.rcms, YFLJSJ_INSECURE: '1' } })
  assert.equal(r.code, 2)
  assert.match(r.err, /force/)
})

test('CLI：config set auto-confirm-write true/false 端到端生效', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'yfljsj-sec-cfg-'))
  const env = { YFLJSJ_GATEWAY: mock.rcms, YFLJSJ_INSECURE: '1' }
  // 缺省 false：写操作需 --confirm
  const r0 = await run(['asset', 'building-add', '--name', 'x'], { home, env })
  assert.equal(r0.code, 2)
  // 打开 auto-confirm-write → 免确认放行
  const s1 = await run(['config', 'set', 'auto-confirm-write', 'true'], { home, env })
  assert.equal(s1.code, 0)
  const r1 = await run(['asset', 'building-add', '--name', 'x'], { home, env })
  assert.equal(r1.code, 0)
  // 关闭 → 恢复强制确认
  const s2 = await run(['config', 'set', 'auto-confirm-write', 'false'], { home, env })
  assert.equal(s2.code, 0)
  const r2 = await run(['asset', 'building-add', '--name', 'x'], { home, env })
  assert.equal(r2.code, 2)
})

test('CLI：--human 对命令表标 sensitive 字段脱敏（json 分支保留原始）', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'yfljsj-sec-human-'))
  seedConfig(home)
  writeFileSync(
    path.join(home, '.yfljsj', 'apis.json'),
    JSON.stringify({
      version: 1,
      services: { rcms: mock.rcms },
      modules: {
        sec: {
          title: 'sec',
          service: 'rcms',
          commands: [{ action: 'user-list', method: 'POST', path: '/sec/user/list', kind: 'read', params: {}, sensitive: ['mobile'] }],
        },
      },
    })
  )
  const env = { YFLJSJ_GATEWAY: mock.rcms, YFLJSJ_INSECURE: '1' }
  mock.state.nextData = [{ id: 1, name: 'alice', mobile: '13800000000' }]
  try {
    const human = await run(['sec', 'user-list', '--human'], { home, env })
    assert.equal(human.code, 0)
    assert.ok(!human.out.includes('13800000000'))
    assert.ok(human.out.includes('******'))
    const json = await run(['sec', 'user-list'], { home, env })
    assert.equal(json.code, 0)
    assert.ok(json.out.includes('13800000000')) // --json 保留原始
  } finally {
    mock.state.nextData = undefined
  }
})
