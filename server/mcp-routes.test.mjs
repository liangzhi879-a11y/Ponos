// server/mcp-routes.test.mjs —— `/mcp` 与 `/mcp/test`（2026-09-15，P1-6「MCP 配置界面」）。
// **直调纯 handler，不起 bridge、不起内核子进程**（本仓库纪律，见 server/disabled-routes.test.mjs 与
// server/knowledge-routes.mjs 的头注：bridge 在 import 期就会扫真实 home）。
//
// 为什么必须测这一层而不只测 kernel/mcp.mjs 的读写函数：真正会坏的是**接线**——路径拼错、
// 方法漏判、坏负载把用户既有 mcp.json 写坏、失败时没回收探测子进程。这些都只发生在 handler 里。
//
// 隔离纪律：configDir 为 mkdtempSync 临时目录，绝不碰真实 ~/.yfworking（= 桥的 YFW_HOME）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { handleMcpRoute } from './mcp-routes.mjs'
import { loadMcpServers } from '../kernel/mcp.mjs'

// 复用内核测试的同款 stub（支持 tools: echo/boom/hang/die/plain），不另造一个
const STUB = fileURLToPath(new URL('../kernel-tests/fixtures/mcp-stub-server.mjs', import.meta.url))
const HTTP_STUB = fileURLToPath(new URL('../kernel-tests/fixtures/mcp-http-stub-server.mjs', import.meta.url))
const NODE = process.execPath

/** 起一个 Streamable HTTP 夹具（P1-5：url 服务器的试连用例），等它打印 PORT=<n> */
function startHttpStub(mode = 'json') {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [HTTP_STUB, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('HTTP 夹具启动超时')) }, 10000)
    child.stdout.on('data', (c) => {
      buf += c
      const m = buf.match(/PORT=(\d+)/)
      if (m) { clearTimeout(timer); resolve({ port: Number(m[1]), kill: () => child.kill() }) }
    })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

const tmp = () => mkdtempSync(join(tmpdir(), 'ponos-mcp-routes-'))
/** 造一次请求：body 为对象则序列化；`raw` 直接给字符串（测坏负载，与 bridge 的 readJsonBody 一样会抛）。 */
const call = (configDir, { method = 'GET', pathname = '/mcp', body, raw } = {}) => handleMcpRoute({
  method, pathname, configDir,
  readJsonBody: async () => {
    if (raw !== undefined) return JSON.parse(raw)
    return body
  },
})

/**
 * 归一到 `loadMcpServers` 的形状再比较：它总给出 `cwd` 键（空则 null），
 * 而 normalize 对空 cwd 是"不设该键"——两者表示同一件事，直接 deepEqual 会误报。
 */
const canon = (servers) => Object.fromEntries(
  Object.entries(servers).map(([k, v]) => [k, { ...v, cwd: v.cwd ?? null }]),
)

// ---------------------------------------------------------------------------
test('路径/方法不匹配 → 返回 null（不得吞掉别的请求，也不得对不支持的方法报 500）', async () => {
  const dir = tmp()
  try {
    assert.equal(await call(dir, { pathname: '/mcp/servers' }), null)
    assert.equal(await call(dir, { pathname: '/disabled' }), null)
    assert.equal(await call(dir, { method: 'DELETE', pathname: '/mcp' }), null, '不支持的方法应交给后续路由')
    assert.equal(await call(dir, { method: 'GET', pathname: '/mcp/test' }), null, '测试端点只接受 POST')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GET：缺文件 → 200 且 servers 为空对象（未配置用户看到的是空表，不是报错）', async () => {
  const dir = tmp()
  try {
    const r = await call(dir)
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true, r.body.error)
    assert.deepEqual(r.body.servers, {})
    assert.equal(r.body.configPath, join(dir, 'mcp.json'), 'configPath 要指向内核读的同一个文件')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PUT → GET 往返：写进去的能被内核的 loadMcpServers 读回**等价**内容', async () => {
  const dir = tmp()
  try {
    const r = await call(dir, {
      method: 'PUT',
      body: { servers: { alpha: { command: ' node ', args: ['a.mjs', 1], env: { K: 1, B: true }, cwd: ' /tmp ', timeoutMs: 1234 } } },
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true, r.body.error)

    const file = join(dir, 'mcp.json')
    assert.equal(existsSync(file), true)
    // 强约束：落盘内容必须能被内核读回等价内容（否则用户会看到"保存成功但服务器消失"）
    assert.deepEqual(canon(loadMcpServers(file)), canon(r.body.servers), '落盘内容与返回的归一化结果必须一致')
    assert.deepEqual(Object.keys(loadMcpServers(file)), ['alpha'])

    const back = await call(dir)
    assert.deepEqual(back.body.servers, r.body.servers, 'GET 应回显刚写入的内容')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PUT：非法负载 → 400 **且磁盘逐字节不变**（半校验就落盘会把用户配置写坏）', async () => {
  const dir = tmp()
  try {
    const file = join(dir, 'mcp.json')
    const known = JSON.stringify({ servers: { keep: { command: 'node', args: ['keep.mjs'] } } }, null, 2) + '\n'
    writeFileSync(file, known, 'utf-8')
    const before = readFileSync(file)     // Buffer：逐字节比较，避免行尾/编码差异被字符串比较放过

    const bad = [
      { name: '缺 command', opt: { method: 'PUT', body: { servers: { x: { args: ['a'] } } } } },
      { name: 'command 空串', opt: { method: 'PUT', body: { servers: { x: { command: '   ' } } } } },
      { name: 'body 非对象', opt: { method: 'PUT', raw: '[1,2,3]' } },
      { name: 'servers 非对象', opt: { method: 'PUT', body: { servers: 'oops' } } },
      { name: '缺 servers 字段', opt: { method: 'PUT', body: { serversX: {} } } },
      { name: '坏 JSON', opt: { method: 'PUT', raw: '{ 坏的' } },
    ]
    for (const c of bad) {
      const r = await call(dir, c.opt)
      assert.equal(r.status, 400, `${c.name} 必须 400`)
      assert.equal(r.body.ok, false, c.name)
      assert.ok(r.body.error && String(r.body.error).length > 0, `${c.name} 必须给出可展示的 error`)
      assert.equal(readFileSync(file).equals(before), true, `${c.name} 之后磁盘内容不得变化`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PUT：目标文件不存在时校验失败不得"顺手创建"文件', async () => {
  const dir = tmp()
  try {
    const r = await call(dir, { method: 'PUT', body: { servers: { x: { command: '' } } } })
    assert.equal(r.status, 400)
    assert.equal(existsSync(join(dir, 'mcp.json')), false, '失败请求不得留下半成品文件')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PUT：保留文件里的未知顶层键（其它功能/用户手写的字段不因保存 MCP 而丢）', async () => {
  const dir = tmp()
  try {
    const file = join(dir, 'mcp.json')
    writeFileSync(file, JSON.stringify({ foo: 1, note: '手写的', servers: { old: { command: 'node' } } }), 'utf-8')
    const r = await call(dir, { method: 'PUT', body: { servers: { fresh: { command: 'node' } } } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    assert.equal(onDisk.foo, 1, '未知顶层键必须保留')
    assert.equal(onDisk.note, '手写的')
    assert.deepEqual(Object.keys(onDisk.servers), ['fresh'], 'servers 键是整表替换（界面提交的就是全量）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GET：文件损坏 → 200 + ok:false（界面能解释"读不出来"，而不是一句 5xx 无从下手）', async () => {
  const dir = tmp()
  try {
    const file = join(dir, 'mcp.json')
    writeFileSync(file, '{ 这不是 JSON', 'utf-8')
    const r = await call(dir)
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, false)
    assert.ok(String(r.body.error || '').length > 0, 'error 必须非空，否则界面没法告诉用户为什么')
    assert.deepEqual(r.body.servers, {})
    assert.equal(r.body.configPath, file)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/test：连上 stub → 200 且列出工具与 serverInfo；**不落盘**', async () => {
  const dir = tmp()
  try {
    const r = await call(dir, { method: 'POST', pathname: '/mcp/test', body: { server: { command: NODE, args: [STUB] } } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true, r.body.error)
    assert.ok(r.body.tools.some((t) => t.name === 'echo'), `应含 echo 工具，实际 ${JSON.stringify(r.body.tools)}`)
    assert.equal(r.body.serverInfo?.name, 'stub')
    assert.equal(existsSync(join(dir, 'mcp.json')), false, '试连不得写配置文件（用户还没点保存）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/test：命令不存在 → 200 + ok:false（连不上是业务结果，不是 500，也不得抛）', async () => {
  const dir = tmp()
  try {
    const r = await call(dir, { method: 'POST', pathname: '/mcp/test', body: { server: { command: 'definitely-not-a-real-command-xyz-9000', timeoutMs: 3000 } } })
    assert.equal(r.status, 200, '连不上是正常业务结果：界面照原样展示原因，而不是走进 5xx 错误分支')
    assert.equal(r.body.ok, false)
    assert.ok(String(r.body.error || '').length > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/test：缺 command / body 非对象 → 400（不白起子进程）', async () => {
  const dir = tmp()
  try {
    const a = await call(dir, { method: 'POST', pathname: '/mcp/test', body: { server: { args: ['x'] } } })
    assert.equal(a.status, 400)
    assert.match(String(a.body.error), /command|url/, '报错应点明缺少 command 或 url')
    const b = await call(dir, { method: 'POST', pathname: '/mcp/test', raw: '[1]' })
    assert.equal(b.status, 400)
    const c = await call(dir, { method: 'POST', pathname: '/mcp/test', body: {} })
    assert.equal(c.status, 400)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// P1-5 扩展：POST /mcp/test 支持远程 HTTP 服务器
test('POST /mcp/test：url 服务器 → 200 且列出工具（HTTP 分派真的接通了）', async () => {
  const dir = tmp()
  const s = await startHttpStub('json')
  try {
    const r = await call(dir, {
      method: 'POST', pathname: '/mcp/test',
      body: { server: { url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 5000 } },
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true, r.body.error)
    assert.deepEqual(r.body.tools.map((t) => t.name), ['echo', 'whoami'])
    assert.equal(r.body.serverInfo?.name, 'http-stub')
    assert.equal(existsSync(join(dir, 'mcp.json')), false, '试连不得写配置文件')
  } finally { s.kill(); rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/test：url 不可达 → 200 + ok:false（连不上是业务结果，不是 500）', async () => {
  const dir = tmp()
  try {
    const r = await call(dir, {
      method: 'POST', pathname: '/mcp/test',
      body: { server: { url: 'http://127.0.0.1:1/mcp', timeoutMs: 1000 } },
    })
    assert.equal(r.status, 200, '不可达不该让界面走进 5xx 错误分支')
    assert.equal(r.body.ok, false)
    assert.ok(String(r.body.error || '').length > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/test：认证头里未定义的变量 → 200 + ok:false 且点名变量（不失真成 400/500）', async () => {
  const dir = tmp()
  const s = await startHttpStub('json')
  try {
    // 变量名为故意不存在的：用户点了"测试"应看到"哪个变量没定义"，
    // 而不是一句笼统的失败——这才是这个按钮存在的意义。
    const r = await call(dir, {
      method: 'POST', pathname: '/mcp/test',
      body: {
        server: {
          url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 5000,
          headers: { Authorization: 'Bearer ${YFW_TEST_TOKEN_SURELY_UNDEFINED}' },
        },
      },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, false)
    assert.match(String(r.body.error), /YFW_TEST_TOKEN_SURELY_UNDEFINED/, '错误必须点名未定义的变量')
  } finally { s.kill(); rmSync(dir, { recursive: true, force: true }) }
})

test('PUT /mcp：url 服务器可保存并原样读回占位符（HTTP 配置走完整链路）', async () => {
  const dir = tmp()
  try {
    const servers = {
      remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${MY_TOKEN}' }, timeoutMs: 5000 },
    }
    const r = await call(dir, { method: 'PUT', pathname: '/mcp', body: { servers } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true)
    // 落盘内容必须仍是占位符：明文 token 一旦写进 mcp.json 就随备份/截图一起流出去
    const onDisk = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf-8'))
    assert.equal(onDisk.servers.remote.headers.Authorization, 'Bearer ${MY_TOKEN}')
    const back = await call(dir, { method: 'GET', pathname: '/mcp' })
    assert.equal(back.body.servers.remote.url, 'https://example.com/mcp')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// GET /mcp/status（2026-09-16，P1-6「MCP 顶层面板」）：内核**真实接入状态**。
//
// 为什么单独一个端点：面板里的"连接测试"只说明"这台此刻连得上"，而用户真正要问的是
// "内核已经把它接进 AI 的工具表了吗"——两者是不同的事实，混为一谈就会出现
// "添加成功却找不到调用入口"。这个端点回答后者，并给出"配置比内核新"的判定依据。
const statusCall = (dir, extra = {}) => handleMcpRoute({
  method: 'GET', pathname: '/mcp/status',
  readJsonBody: async () => ({}), configDir: dir, ...extra,
})

test('GET /mcp/status：内核从未上报 ⇒ kernel:null（不谎称"已接入 0 个"）', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { a: { command: 'npx' } } }), 'utf-8')
    const r = await statusCall(dir)
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.kernel, null, '没有内核上报时必须是 null —— 界面据此显示"内核尚未启动"')
    assert.equal(r.body.stale, false, '没有内核可比 ⇒ 不该显示"待生效"')
    assert.match(r.body.config.sig, /^[0-9a-f]{16}$/)
    assert.equal(r.body.config.path, join(dir, 'mcp.json'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GET /mcp/status：内核签名落后于磁盘 ⇒ stale:true（"发下一条消息即生效"的依据）', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: { a: { command: 'npx' } } }), 'utf-8')

    const stale = await statusCall(dir, {
      getMcpStatus: () => ({ servers: {}, failed: {}, disabled: [], configSig: 'deadbeefdeadbeef' }),
    })
    assert.equal(stale.body.stale, true, '内核用的是别的配置 ⇒ 界面要提示"下一条消息生效"')

    const cur = await statusCall(dir, {
      getMcpStatus: () => ({ servers: {}, failed: {}, disabled: [], configSig: stale.body.config.sig }),
    })
    assert.equal(cur.body.stale, false, '签名一致 ⇒ 已生效，提示消失')

    // 内核没带 configSig（畸形/旧版本）时不得误报为"已生效"
    const noSig = await statusCall(dir, { getMcpStatus: () => ({ servers: {}, failed: {}, disabled: [] }) })
    assert.equal(noSig.body.stale, false, '缺签名不误报：没有证据说"落后"就不提示，避免噪音')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GET /mcp/status：配置文件坏掉 ⇒ ok:false 且不抛（界面显示原因并禁用保存）', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'mcp.json'), '{ 这不是 JSON', 'utf-8')
    const r = await statusCall(dir)
    assert.equal(r.status, 200, '读失败也要 200：这是"读不出来"的报告，不是请求错误')
    assert.equal(r.body.ok, false)
    assert.ok(String(r.body.error || '').length > 0)
    assert.equal(r.body.config.sig, null, '读不出配置 ⇒ 无签名')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GET /mcp/status：getMcpStatus 抛异常也不得 500（面板不能因诊断接口而崩）', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers: {} }), 'utf-8')
    const r = await statusCall(dir, { getMcpStatus: () => { throw new Error('boom') } })
    assert.equal(r.status, 200)
    assert.equal(r.body.kernel, null, '诊断失败就当作"没有上报"，不影响读取配置本身')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('未匹配路径仍返回 null（不吞别的路由），且 status 只接受 GET', async () => {
  assert.equal(await handleMcpRoute({
    method: 'GET', pathname: '/mcp/whatever', readJsonBody: async () => ({}), configDir: '/tmp',
  }), null)
  assert.equal(await handleMcpRoute({
    method: 'POST', pathname: '/mcp/status', readJsonBody: async () => ({}), configDir: '/tmp',
  }), null, 'status 只接受 GET（POST 落到后续路由，不是"不支持的方法"）')
})
