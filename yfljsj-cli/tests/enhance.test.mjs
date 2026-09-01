// 增强命令测试（schema/relations/explore）— mock 网关用本地 https server（自签名证书，不联网）
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 自签名证书用于本地 https mock（参考 auth.test.mjs startMock 模式）
const KEY = readFileSync(new URL('./fixtures/key.pem', import.meta.url))
const CERT = readFileSync(new URL('./fixtures/cert.pem', import.meta.url))

// 测试隔离：config 写入临时目录（YFLJSJ_HOME 覆盖 os.homedir）
const TMP = mkdtempSync(path.join(os.tmpdir(), 'yfljsj-enhance-'))
process.env.YFLJSJ_HOME = TMP
const CONFIG_PATH = path.join(TMP, '.yfljsj', 'config.json')

const api = await import('../yfljsj.mjs')

// 种子 config：accessToken/tenantId，供 authenticatedRequest / probeFields 使用
function seedConfig({ accessToken = 'AT-enhance', refreshToken = 'RT-enhance', tenantId = 'T001', expiresAt = Date.now() + 3600_000 } = {}) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify({ accessToken, refreshToken, tenantId, expiresAt }))
}

// 可配置的本地 https mock 网关（参考 auth.test.mjs startMock 模式）
function startMock() {
  const state = { requests: [], handlers: {} }
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
      const entry = { method: req.method, path: u.pathname, headers: req.headers, body }
      state.requests.push(entry)
      const respond = (status, json) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(json === undefined ? '' : JSON.stringify(json))
      }
      const handler = state.handlers[u.pathname]
      if (handler) return handler(entry, respond)
      return respond(404, { success: false, code: 404, msg: 'not found', data: null })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        state,
        server,
        baseUrl: `https://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

let mock
let mockBase
beforeEach(async () => {
  mock = await startMock()
  mockBase = mock.baseUrl
  // 默认路由：
  //   /workbench/projectAppro/add → 必填字段校验报错（探出 headPerson/projectId）
  //   /ok/endpoint → success（接口宽容，无必填）
  mock.state.handlers['/workbench/projectAppro/add'] = (_e, respond) =>
    respond(200, { success: false, code: 400, msg: '[headPerson:must not be null, projectId:must not be null]', data: null })
  mock.state.handlers['/ok/endpoint'] = (_e, respond) =>
    respond(200, { success: true, code: 200, msg: 'ok', data: null })
  seedConfig()
})
afterEach(async () => {
  await mock.close()
})

// ==================== schema ====================

test('schema：输出命令字段定义', () => {
  // 直接测 schemaCommand 渲染（mock stdout）
  const lines = []
  const out = { write: s => lines.push(s) }
  const code = api.schemaCommand('workbench', 'projectAppro-add', { output: out })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, /projectAppro-add/)
  assert.match(text, /headPerson/)
  assert.match(text, /techEconTarget/)
  assert.match(text, /必填|required/)
})

test('schema：未知命令 → 退出码 2', () => {
  const code = api.schemaCommand('workbench', 'nonexistent', { output: { write: () => {} } })
  assert.equal(code, 2)
})

// ==================== relations ====================

test('relations：输出对象关联图谱', () => {
  const lines = []
  const code = api.relationsCommand('project', { output: { write: s => lines.push(s) } })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, /project/)
  assert.match(text, /projectAppro|立项/)
  assert.match(text, /rdItem|研发/)
  assert.match(text, /创建顺序/)
})

test('relations：无参 → 输出对象目录', () => {
  const lines = []
  const code = api.relationsCommand(null, { output: { write: s => lines.push(s) } })
  assert.equal(code, 0)
  assert.match(lines.join(''), /可用对象|对象/)
})

// ==================== explore（Task 4：交互式字段探测） ====================

test('parseValidationMsg：多字段校验报错解析', () => {
  // 平台报错格式 [xxx:must not be null, yyy:must not be blank]（逗号后带空格）
  assert.deepEqual(api.parseValidationMsg('[headPerson:must not be null, projectId:must not be blank]'), ['headPerson', 'projectId'])
  assert.deepEqual(api.parseValidationMsg('[projectId:must not be null]'), ['projectId'])
  assert.deepEqual(api.parseValidationMsg('ok'), [])
  assert.deepEqual(api.parseValidationMsg(''), [])
})

test('probeFields：空请求报错解析必填字段', async () => {
  // mock 网关：空 body 返回 [headPerson:must not be null, projectId:must not be null]
  // probeFields 返回 { fields, attempts }（brief 接口契约）
  const { fields } = await api.probeFields('/workbench/projectAppro/add', { baseUrl: mockBase, method: 'POST', rejectUnauthorized: false })
  assert.ok(fields.includes('headPerson'))
  assert.ok(fields.includes('projectId'))
})

test('probeFields：success 时返回空字段（全部满足）', async () => {
  const { fields } = await api.probeFields('/ok/endpoint', { baseUrl: mockBase, method: 'POST', rejectUnauthorized: false })
  assert.deepEqual(fields, [])
})

test('exploreCommand：dry-run 输出探测结果', async () => {
  const lines = []
  const code = await api.exploreCommand('/workbench/projectAppro/add', { output: { write: s => lines.push(s) }, dryRun: true, baseUrl: mockBase, rejectUnauthorized: false })
  assert.equal(code, 0)
  assert.match(lines.join(''), /headPerson/)
})

test('explore 未登录 → main 路由 catch → 退出码 3（AUTH_REQUIRED）', async () => {
  // 无 config（未登录态）→ authenticatedRequest 抛 AUTH_REQUIRED；
  // 此前异常逃逸到入口 .catch 打印完整栈，现应由 main explore 路由映射为退出码 3
  const home = mkdtempSync(path.join(os.tmpdir(), 'yfljsj-explore-auth-'))
  const oldHome = process.env.YFLJSJ_HOME
  process.env.YFLJSJ_HOME = home
  try {
    const code = await api.main(['explore', '/workbench/projectAppro/add', '--dry-run'])
    assert.equal(code, 3)
  } finally {
    process.env.YFLJSJ_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  }
})

// ==================== doc（Task 5：操作手册） ====================

test('doc：输出操作手册（步骤+示例）', () => {
  const lines = []
  const code = api.docCommand('createProject', { output: { write: s => lines.push(s) } })
  assert.equal(code, 0)
  const text = lines.join('')
  assert.match(text, /创建研发项目/)
  assert.match(text, /projectInfo-add/)
  assert.match(text, /projectAppro-add/)
  assert.match(text, /yfljsj /)
})

test('doc：无参 → 输出目录', () => {
  const lines = []
  const code = api.docCommand(null, { output: { write: s => lines.push(s) } })
  assert.equal(code, 0)
  assert.match(lines.join(''), /createProject|可用手册/)
})
