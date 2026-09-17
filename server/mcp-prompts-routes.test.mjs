// server/mcp-prompts-routes.test.mjs —— `GET /mcp/prompts` 与 `POST /mcp/prompts/get`（Task 5，第二批）。
// **直调纯 handler，不起 bridge、不起内核子进程**（本仓库纪律，见 server/mcp-routes.mjs 头注：
// bridge 在 import 期就会扫真实 home）。隔离同上：configDir 为 mkdtempSync 临时目录。
//
// 本文件盯的是**三态区分的接线**，而不是"能返回点东西"——三态里任何一条错位，GUI 的行为就会错：
//   400 = 用户给的数据不合规（磁盘与远端都不动）⇒ 界面把 error 显示在输入框旁
//   500 = IO/内部失败（数据合规但没做成，如磁盘读不了）⇒ 界面走错误分支
//   200 + ok:false = 正常业务结果（连不上、prompt 不存在、服务器嫌参数不齐）⇒ 界面照原样展示原因
// 把"连不上"写成 5xx 会让用户看到"界面出错了"而不是"这台服务器连不上"，是实打实的误导。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { handleMcpRoute } from './mcp-routes.mjs'

// 复用内核测试的 stub（已含 prompts/list + prompts/get 与"缺必填参数回 error"）
const STUB = fileURLToPath(new URL('../kernel-tests/fixtures/mcp-stub-server.mjs', import.meta.url))
// 远程 HTTP 夹具（同形：一个 summarize 模板）：两条端点都要走 url 分派，
// 而 stdio 用例证明不了它 —— 分派写错的典型表现就是"本地能用、远程整块不可用"。
const HTTP_STUB = fileURLToPath(new URL('../kernel-tests/fixtures/mcp-http-stub-server.mjs', import.meta.url))
const NODE = process.execPath

/** 起一个 Streamable HTTP 夹具，等它打印 PORT=<n> */
function startHttpStub() {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [HTTP_STUB, 'json'], { stdio: ['ignore', 'pipe', 'pipe'] })
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

/**
 * 一个**只做 tools、不实现 prompts** 的最小 MCP 服务器（源码写进临时目录，**不碰 kernel-tests/**）。
 * 为什么必须有这个夹具：真实世界里大量服务器只做 tools，"这台没有 prompt 模板"是常态而非故障，
 * 必须验证它归入 `errors` 而**整体仍是 200/ok:true**——若把它当故障回 5xx，面板会因为
 * 一台朴素服务器而整块报错。
 */
const NO_PROMPTS_SRC = `import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let msg
  try { msg = JSON.parse(text) } catch { return }
  if (msg.id === undefined) return
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'no-prompts', version: '1.0.0' } } })
  }
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } })
  return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: '方法未实现: ' + msg.method } })
})
`

const tmp = () => mkdtempSync(join(tmpdir(), 'ponos-mcp-prompts-'))
const writeConfig = (dir, servers) => writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ servers }, null, 2), 'utf-8')
/** 写一个"不提供 prompts"的服务器脚本到临时目录并返回其绝对路径 */
const writeNoPromptsStub = (dir) => {
  const p = join(dir, 'no-prompts-stub.mjs')
  writeFileSync(p, NO_PROMPTS_SRC, 'utf-8')
  return p
}
const stubServer = () => ({ command: NODE, args: [STUB], timeoutMs: 8000 })
/** 造一次请求：body 为对象则原样给 handler；`raw` 直接给字符串（测坏负载，与 bridge 的 readJsonBody 一样会抛） */
const call = (configDir, { method = 'GET', pathname = '/mcp/prompts', body, raw } = {}) => handleMcpRoute({
  method, pathname, configDir,
  readJsonBody: async () => (raw !== undefined ? JSON.parse(raw) : body),
})
const getPrompt = (dir, body) => call(dir, { method: 'POST', pathname: '/mcp/prompts/get', body })
const promptNames = (r, server) => (r.body.servers?.[server]?.prompts || []).map((p) => p.name)

// ---------------------------------------------------------------------------
test('路径/方法不匹配 → null（不得吞掉别的请求，也不得对不支持的方法报 500）', async () => {
  const dir = tmp()
  try {
    assert.equal(await call(dir, { method: 'DELETE', pathname: '/mcp/prompts' }), null)
    assert.equal(await call(dir, { method: 'GET', pathname: '/mcp/prompts/get' }), null, '取文本只接受 POST')
    assert.equal(await call(dir, { method: 'POST', pathname: '/mcp/prompts' }), null)
    // 其余 MCP 路由不受影响（新增两个端点不能改变既有分派）
    assert.equal(await call(dir, { method: 'GET', pathname: '/mcp/promptsX' }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GET /mcp/prompts：列出启用服务器的 prompt 模板（含参数声明与 expose）', async () => {
  const dir = tmp()
  try {
    writeConfig(dir, { stub: stubServer(), off: { command: 'definitely-not-real-xyz', enabled: false } })
    const r = await call(dir)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true, r.body.error)
    assert.deepEqual(promptNames(r, 'stub'), ['summarize', 'greet'])
    // 参数声明必须带上 required：界面靠它给必填项打标、并在提交前拦下空值
    assert.deepEqual(r.body.servers.stub.prompts[0].arguments, [{ name: 'text', description: '要总结的文本', required: true }])
    assert.deepEqual(r.body.servers.stub.prompts[1].arguments, [], '无参数模板不应编造参数')
    assert.equal(r.body.servers.stub.expose, 'public')
    assert.deepEqual(r.body.disabled, ['off'])
    assert.equal('off' in r.body.servers, false, 'enabled:false 的服务器绝不连接（用户关掉它就是不想再起进程）')
    assert.deepEqual(r.body.errors, {}, '没有任何一台失败时不得留下噪声条目')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GET /mcp/prompts：服务器不提供 prompts ⇒ 只记进 errors，整体仍 200/ok:true', async () => {
  const dir = tmp()
  try {
    const noPrompts = writeNoPromptsStub(dir)
    writeConfig(dir, { plain: { command: NODE, args: [noPrompts], timeoutMs: 8000 }, stub: stubServer() })
    const r = await call(dir)
    assert.equal(r.status, 200, '一台不做 prompts 是**常态**，不能以 5xx 让面板整块报错')
    assert.equal(r.body.ok, true, r.body.error)
    assert.ok(String(r.body.errors.plain || '').length > 0, '这台为什么没有模板必须能显示出来')
    assert.match(String(r.body.errors.plain), /-32601|未实现/, '应保留服务器原文，便于用户自行判断')
    assert.equal('plain' in r.body.servers, false, '失败的那台不得出现半截清单')
    assert.deepEqual(promptNames(r, 'stub'), ['summarize', 'greet'], '一台失败不得影响另一台')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GET /mcp/prompts：一台连不上不影响另一台（故障隔离），连不上同样是业务结果', async () => {
  const dir = tmp()
  try {
    writeConfig(dir, { dead: { command: 'definitely-not-a-real-command-xyz-9000', timeoutMs: 3000 }, stub: stubServer() })
    const r = await call(dir)
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.ok(String(r.body.errors.dead || '').length > 0)
    assert.deepEqual(promptNames(r, 'stub'), ['summarize', 'greet'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('GET /mcp/prompts：无配置 / 配置坏掉 → 都可解释（沿用 GET /mcp 的 200 口径）', async () => {
  const dir = tmp()
  try {
    const none = await call(dir)
    assert.equal(none.status, 200)
    assert.equal(none.body.ok, true, '未配置 MCP 不是错误：空表即可')
    assert.deepEqual(none.body.servers, {})
    assert.deepEqual(none.body.disabled, [])

    writeFileSync(join(dir, 'mcp.json'), '{ 这不是 JSON', 'utf-8')
    const broken = await call(dir)
    assert.equal(broken.status, 200, '读不出来是**报告**，不是请求错误（5xx 只会让界面剩一句"加载失败"）')
    assert.equal(broken.body.ok, false)
    assert.ok(String(broken.body.error || '').length > 0, 'error 必须非空，否则界面没法告诉用户为什么')
    assert.deepEqual(broken.body.servers, {})
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
test('POST /mcp/prompts/get：取回渲染文本（带角色前缀），**只交给用户**（不自动发送）', async () => {
  const dir = tmp()
  try {
    writeConfig(dir, { stub: stubServer() })
    const r = await getPrompt(dir, { server: 'stub', name: 'summarize', arguments: { text: '你好' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true, r.body.error)
    // 角色前缀是刻意的：文本要插进输入框，用户得看出哪段是 system / user
    assert.match(r.body.text, /\[system\]/)
    assert.match(r.body.text, /你是摘要助手。/)
    assert.match(r.body.text, /\[user\]/)
    assert.match(r.body.text, /请总结：你好/)
    assert.equal(r.body.messageCount, 2)
    // 端点只把文本交出来：渲染结果不经任何"发送"通道（D-4 的核心约束）
    assert.equal('send' in r.body, false)
    assert.equal('sent' in r.body, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/prompts/get：无论成败都不得写盘（本端点只读配置）', async () => {
  const dir = tmp()
  try {
    writeConfig(dir, { stub: stubServer() })
    const file = join(dir, 'mcp.json')
    const before = readFileSync(file)   // Buffer：逐字节比较，避免行尾/编码差异被放过
    await getPrompt(dir, { server: 'stub', name: 'summarize', arguments: { text: 'x' } })
    await getPrompt(dir, { server: 'stub', name: 'nope' })
    await getPrompt(dir, { server: 'ghost', name: 'nope' })
    assert.equal(readFileSync(file).equals(before), true, '取 prompt 文本不该改动配置')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/prompts/get：请求体缺参/形状不对 → 400（本地可判定，不连服务器）', async () => {
  const dir = tmp()
  try {
    writeConfig(dir, { stub: stubServer() })
    const cases = [
      { name: '缺 server 与 name', opt: { body: {} } },
      { name: '缺 name', opt: { body: { server: 'stub' } } },
      { name: 'server 为空白', opt: { body: { server: '   ', name: 'summarize' } } },
      { name: 'name 为空白', opt: { body: { server: 'stub', name: '  ' } } },
      { name: 'arguments 非对象', opt: { body: { server: 'stub', name: 'summarize', arguments: 'oops' } } },
      { name: 'body 非对象', opt: { raw: '[1,2,3]' } },
      { name: '坏 JSON', opt: { raw: '{ 坏的' } },
    ]
    for (const c of cases) {
      const r = await call(dir, { method: 'POST', pathname: '/mcp/prompts/get', ...c.opt })
      assert.equal(r.status, 400, `${c.name} 必须 400（用户数据不合规，界面把 error 显示在输入框旁）`)
      assert.equal(r.body.ok, false)
      assert.ok(String(r.body.error || '').length > 0, `${c.name} 必须给出可展示的 error`)
    }
    // 缺 name 的报错要能指向是哪个字段缺了，否则用户只能一个个试
    const noName = await getPrompt(dir, { server: 'stub' })
    assert.match(String(noName.body.error), /name/, '报错应点名缺少的字段')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/prompts/get：服务器不在配置里 → 400（点名是哪台）', async () => {
  const dir = tmp()
  try {
    writeConfig(dir, { stub: stubServer() })
    const r = await getPrompt(dir, { server: 'ghost', name: 'summarize' })
    assert.equal(r.status, 400, '请求体本身有毛病（点了不存在的服务器）⇒ 400，而不是"连不上"的 200+ok:false')
    assert.equal(r.body.ok, false)
    assert.match(String(r.body.error), /ghost/, '错误必须点名服务器，否则用户不知道该改哪一项')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/prompts/get：prompt 不存在 → 200 + ok:false + error（服务器说不行 = 业务结果）', async () => {
  const dir = tmp()
  try {
    writeConfig(dir, { stub: stubServer() })
    const r = await getPrompt(dir, { server: 'stub', name: '没有这个模板' })
    assert.equal(r.status, 200, 'prompt 不存在不该让界面走进 5xx 错误分支')
    assert.equal(r.body.ok, false)
    assert.match(String(r.body.error), /prompt 不存在/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/prompts/get：连不上 → 200 + ok:false（家常便饭，不是 500）', async () => {
  const dir = tmp()
  try {
    writeConfig(dir, { dead: { command: 'definitely-not-a-real-command-xyz-9000', timeoutMs: 3000 } })
    const r = await getPrompt(dir, { server: 'dead', name: 'summarize' })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, false)
    assert.ok(String(r.body.error || '').length > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/prompts/get：必填参数为空 ⇒ 由**服务器**判定 → 200 + ok:false，不越权当 400', async () => {
  const dir = tmp()
  try {
    writeConfig(dir, { stub: stubServer() })
    // 界线说明：400 只管**本地可判定**的请求体形状与"服务器是否在配置里"。
    // "模板声明的必填参数齐不齐"要先向服务器取声明（多一次往返，且服务器不实现 prompts/list 时会误判），
    // 而 MCP 里这本就是服务器的职责（它回 -32602）⇒ 归入"连得上但没做成"的业务结果。
    // 界面侧另有 `promptArgsOf`/`missingPromptArgs` 在点"渲染"之前就拦下空值（那是 UX，不是契约）。
    const empty = await getPrompt(dir, { server: 'stub', name: 'summarize', arguments: { text: '' } })
    assert.equal(empty.status, 200, '空串照发，由服务器决定它算不算"没填"')
    assert.equal(empty.body.ok, false)
    assert.match(String(empty.body.error), /缺少必填参数 text/)

    const missing = await getPrompt(dir, { server: 'stub', name: 'summarize' })
    assert.equal(missing.status, 200)
    assert.equal(missing.body.ok, false)

    // 非字符串值不得被静默丢弃（表单里数字很常见）：服务器收到 '42' 就能正常渲染
    const num = await getPrompt(dir, { server: 'stub', name: 'summarize', arguments: { text: 42 } })
    assert.equal(num.body.ok, true, JSON.stringify(num.body))
    assert.match(num.body.text, /请总结：42/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/prompts/get：已关闭的服务器 → 200 + ok:false（用户自己的选择，不是数据不合规）', async () => {
  const dir = tmp()
  try {
    writeConfig(dir, { off: { command: NODE, args: [STUB], enabled: false } })
    const r = await getPrompt(dir, { server: 'off', name: 'greet' })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, false)
    assert.match(String(r.body.error), /已关闭/, '要让用户明白"不是我填错了，是这台被关了"')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('POST /mcp/prompts/get：配置坏掉 → 500（用户请求没毛病，是磁盘读不了）', async () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'mcp.json'), '{ 这不是 JSON', 'utf-8')
    const r = await getPrompt(dir, { server: 'stub', name: 'summarize' })
    // 与上面三类 400 的区别：用户该改的不是输入而是文件 ⇒ 归 IO/内部失败。
    // 与 GET /mcp/prompts 的 200+ok:false 也不冲突：那个端点回答的是"配置读得出来吗"，
    // 本身就是**报告**；这里是"照你给的请求去取文本"的动作没做成。
    assert.equal(r.status, 500)
    assert.equal(r.body.ok, false)
    assert.ok(String(r.body.error || '').length > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 接线守卫：bridge.mjs 里那个 `if (url.pathname === '/mcp' || ...)` 必须登记这两条路径。
//
// 为什么值得一条**读源码**的静态断言：漏登记不会报错、不会 404 —— 请求根本到不了 handler，
// 表现只是"界面里那个入口一直转圈"。本仓库已两次踩过"漏登记被静默忽略"（`--spaces`/`--confirm`），
// 而这两个端点分散在"路由表"与"handler"两处，改一处忘另一处是最容易发生的形态。
test('bridge 的 MCP 守卫必须登记 /mcp/prompts 与 /mcp/prompts/get（否则请求到不了 handler）', () => {
  const src = readFileSync(fileURLToPath(new URL('./bridge.mjs', import.meta.url)), 'utf-8')
  const at = src.indexOf('handleMcpRoute({')
  assert.ok(at > 0, 'bridge 应调用 handleMcpRoute')
  // 只取调用点之前的守卫区间：别处出现同样的字符串（如注释）不算数
  const guard = src.slice(Math.max(0, at - 2000), at)
  assert.match(guard, /'\/mcp\/prompts'/, '清单端点必须在这个 if 里')
  assert.match(guard, /'\/mcp\/prompts\/get'/, '渲染端点必须在这个 if 里')
})

// ---------------------------------------------------------------------------
test('两条端点都走 url 分派：HTTP 传输能列模板、能取回**与 stdio 逐字相同**的渲染结果', async () => {
  const dir = tmp()
  const s = await startHttpStub()
  try {
    writeConfig(dir, { remote: { url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 5000 } })

    const list = await call(dir)
    assert.equal(list.status, 200, JSON.stringify(list.body))
    assert.equal(list.body.ok, true, list.body.error)
    assert.deepEqual(promptNames(list, 'remote'), ['summarize'])
    assert.equal(list.body.servers.remote.prompts[0].arguments[0].required, true)
    assert.deepEqual(list.body.errors, {}, '能连上的不该留错误条目')

    const r = await getPrompt(dir, { server: 'remote', name: 'summarize', arguments: { text: '同一份实现' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true, r.body.error)
    // 与 stdio 逐字相同（两个传输共用 kernel 的同一份能力实现）：分派错到另一条路时这里会立刻变红
    assert.equal(r.body.text, '[system]\n你是摘要助手。\n\n[user]\n请总结：同一份实现')
    // 该服务器不在结果级返回 description ⇒ 缺省即空串，不得变成 undefined（界面会渲染成 "undefined"）
    assert.equal(r.body.description, '')
  } finally { s.kill(); rmSync(dir, { recursive: true, force: true }) }
})
