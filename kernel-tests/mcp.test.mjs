// P1-5 MCP 客户端测试（stdio JSON-RPC）。
// ---------------------------------------------------------------------------
// 覆盖重点（都是"能崩引擎/能卡死轮次"的真实风险点，不是凑覆盖率）：
//   ① 握手 + tools/list 发现 + tools/call 往返
//   ② JSON-RPC error → 转 is_error（**不得抛崩引擎轮次**）
//   ③ 请求超时 → reject **且 pending 清理干净**（否则 id 泄漏、内存增长）
//   ④ 进程退出 → pending 全部 reject（**否则工具调用永久悬挂，整个轮次卡死**）
//   ⑤ 缺配置 → 视图恒空（证明既有用户零行为变化）
//   ⑥ 坏配置 → 不抛崩（只是跳过）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadMcpServers, startMcpClient, mcpToolName, sanitizeMcpName, contentToText, mcpChildEnv,
  normalizeMcpServers, writeMcpServers, interpolateEnv,
} from '../kernel/mcp.mjs'
import { createMcpRegistry, mcpConfigPath } from '../kernel/mcp-tools.mjs'

const STUB = fileURLToPath(new URL('./fixtures/mcp-stub-server.mjs', import.meta.url))
const NODE = process.execPath

const mkTmp = () => mkdtempSync(join(tmpdir(), 'yfw-mcp-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个连到 stub 的客户端（跑完请 close） */
const startStub = (timeoutMs = 4000) =>
  startMcpClient({ name: 'stub', command: NODE, args: [STUB], timeoutMs })

// ---------------------------------------------------------------------------
test('loadMcpServers：缺文件→{}（未配置用户零影响）；坏 JSON→抛出；结构过滤', () => {
  const dir = mkTmp()
  try {
    assert.deepEqual(loadMcpServers(join(dir, 'none.json')), {}, '缺文件应返回空配置')
    assert.deepEqual(loadMcpServers(), {}, '无路径也应返回空配置')

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ 这不是 JSON')
    assert.throws(() => loadMcpServers(bad), '坏 JSON 应抛出（由调用方记日志跳过，而非静默吞掉）')

    const ok = join(dir, 'ok.json')
    writeFileSync(ok, JSON.stringify({
      servers: {
        a: { command: 'node', args: ['x.mjs'], env: { K: 'v' }, timeoutMs: 1234 },
        noCommand: { args: ['y'] },     // 无 command → 忽略
        nullish: null,                  // null → 忽略
        badTimeout: { command: 'node', timeoutMs: -5 },
      },
    }))
    const cfg = loadMcpServers(ok)
    assert.deepEqual(Object.keys(cfg).sort(), ['a', 'badTimeout'], '无 command/null 的条目应被忽略')
    assert.equal(cfg.a.timeoutMs, 1234)
    assert.equal(cfg.badTimeout.timeoutMs, 20000, '非法 timeoutMs 应回落默认值')
    assert.deepEqual(cfg.a.args, ['x.mjs'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('命名与安全字符化：mcp__<server>__<tool>，非常规字符被替换', () => {
  assert.equal(mcpToolName('srv', 'tool'), 'mcp__srv__tool')
  assert.equal(sanitizeMcpName('a b/c:d'), 'a_b_c_d', '空格与分隔符须替换（工具名要能安全进入工具表）')
  assert.ok(mcpToolName('s', 't').startsWith('mcp__'), '前缀是"外部工具"的可见标识')
})

test('contentToText：content 数组展平；非文本条目兜底；无 content 结构 JSON 化', () => {
  assert.equal(contentToText({ content: [{ type: 'text', text: 'hi' }] }), 'hi')
  assert.equal(contentToText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.match(contentToText({ content: [{ type: 'image', mimeType: 'image/png' }] }), /图片/)
  assert.equal(contentToText('裸字符串'), '裸字符串')
  assert.match(contentToText({ ok: true, value: 42 }), /"value": 42/, '非 content 结构应 JSON 化而非丢失')
  assert.equal(contentToText(null), '')
})

test('mcpChildEnv：只透传白名单 + 显式 env 覆盖（不把宿主密钥泄给第三方服务器）', () => {
  const before = process.env.SECRET_TOKEN
  process.env.SECRET_TOKEN = 'should-not-leak'
  try {
    const env = mcpChildEnv({ MY: 1 })
    assert.equal(env.SECRET_TOKEN, undefined, '非白名单变量不得透传')
    assert.equal(env.MY, '1', '显式 env 应生效（且字符串化）')
  } finally {
    if (before === undefined) delete process.env.SECRET_TOKEN
    else process.env.SECRET_TOKEN = before
  }
})

// ---------------------------------------------------------------------------
test('startMcpClient：握手 + tools/list 发现 + tools/call 往返', async () => {
  const c = await startStub()
  try {
    const tools = await c.tools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ['boom', 'die', 'echo', 'hang', 'plain'])
    assert.equal(c.protocolVersion, '2024-11-05', '握手应记录协议版本')
    assert.ok(tools.every((t) => t.input_schema && typeof t.input_schema === 'object'), '每个工具都须有 input_schema')

    const r = await c.call('echo', { text: '你好' })
    assert.equal(r.text, 'echo: 你好')
    assert.equal(r.isError, false)
    assert.equal(c.stats().calls, 1)
  } finally { c.close() }
})

test('JSON-RPC error → 抛出带 mcpError 标记的错误（接入层负责转 is_error）', async () => {
  const c = await startStub()
  try {
    await assert.rejects(() => c.call('boom', {}), /boom 注定失败/)
    assert.ok(c.stats().errors >= 1, '错误应计数（供诊断/熔断参考）')
  } finally { c.close() }
})

test('请求超时：reject 且 pending 清理干净（防 id 泄漏）', async () => {
  const c = await startStub(300)
  try {
    await assert.rejects(() => c.call('hang', {}), /超时/)
    assert.equal(c.stats().pending, 0, '超时后 pending 必须为 0，否则会持续泄漏')
  } finally { c.close() }
})

test('进程退出：pending 全部 reject，且不悬挂（否则整个引擎轮次卡死）', async () => {
  const c = await startStub()
  try {
    // die 工具会让 stub 直接 exit；请求可能先被 closeWith 拒绝（进程退出）或先拿到响应而失败
    await assert.rejects(() => c.call('die', {}))
    await sleep(200) // 等 exit 事件落地
    assert.equal(c.stats().closed, true, '进程退出后应标记 closed')
    assert.equal(c.stats().pending, 0, '退出后 pending 必须清空')
    await assert.rejects(() => c.call('echo', { text: 'x' }), /已关闭/, '关闭后再调用应立即失败而非悬挂')
  } finally { c.close() }
})

test('close() 后调用立即失败（不悬挂）', async () => {
  const c = await startStub()
  c.close()
  assert.equal(c.stats().closed, true)
  await assert.rejects(() => c.call('echo', {}), /已关闭/)
})

test('abort signal 中断请求（用户在审批/取消时不应留下悬挂请求）', async () => {
  const c = await startStub()
  try {
    const ac = new AbortController()
    const p = c.call('hang', {}, { signal: ac.signal })
    setTimeout(() => ac.abort(), 60)
    await assert.rejects(() => p, /取消/)
    assert.equal(c.stats().pending, 0, 'abort 后 pending 必须为 0')
  } finally { c.close() }
})

// ---------------------------------------------------------------------------
test('注册表：缺配置 → view() 恒空对象（既有用户零行为变化）', async () => {
  const dir = mkTmp()
  try {
    const reg = createMcpRegistry({ configPath: join(dir, 'none.json'), log: () => {} })
    assert.deepEqual(reg.view(), {}, '未配置时视图必须为空')
    await reg.ready()
    assert.deepEqual(reg.view(), {}, '就绪后仍为空')
    assert.deepEqual(reg.toolNames(), [])
    reg.closeAll()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('注册表：坏配置 → 不抛崩（只记警告并跳过）', async () => {
  const dir = mkTmp()
  try {
    const p = join(dir, 'bad.json')
    writeFileSync(p, 'not json at all')
    const warns = []
    const reg = createMcpRegistry({ configPath: p, log: (lv, m) => warns.push(`${lv}:${m}`) })
    await reg.ready()
    assert.deepEqual(reg.view(), {}, '坏配置不应产出工具')
    assert.ok(warns.some((w) => w.includes('配置解析失败')), '应发出可诊断的警告')
    reg.closeAll()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('注册表：接入 stub → 发现 5 个工具、命名带前缀、run 正常与错误路径', async () => {
  const dir = mkTmp()
  try {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({ servers: { stub: { command: NODE, args: [STUB], timeoutMs: 4000 } } }))
    const reg = createMcpRegistry({ configPath: p, log: () => {} })
    await reg.ready()
    const view = reg.view()
    const names = Object.keys(view).sort()
    assert.deepEqual(names, ['mcp__stub__boom', 'mcp__stub__die', 'mcp__stub__echo', 'mcp__stub__hang', 'mcp__stub__plain'])
    assert.ok(view.mcp__stub__echo.description.startsWith('[MCP:stub]'), '描述须标注来源，便于用户与模型识别外部工具')

    const okRes = await view.mcp__stub__echo.run({ text: 'hi' }, {})
    assert.deepEqual(okRes, { content: 'echo: hi', isError: false })

    const boomRes = await view.mcp__stub__boom.run({}, {})
    assert.equal(boomRes.isError, true, 'MCP 报错必须转成 is_error 结果，而不是抛崩引擎')
    assert.match(String(boomRes.content), /MCP 工具错误/)

    const plainRes = await view.mcp__stub__plain.run({}, {})
    assert.match(String(plainRes.content), /42/, '非 content 结构应文本化后返回')
    reg.closeAll()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('注册表：单服务器启动失败不影响其它服务器，也不影响内核', async () => {
  const dir = mkTmp()
  try {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({
      servers: {
        broken: { command: join(dir, 'definitely-not-exist-binary'), args: [], timeoutMs: 1500 },
        stub: { command: NODE, args: [STUB], timeoutMs: 4000 },
      },
    }))
    const reg = createMcpRegistry({ configPath: p, log: () => {} })
    await reg.ready()
    const names = Object.keys(reg.view())
    assert.ok(names.includes('mcp__stub__echo'), '好的服务器仍应可用')
    assert.ok(!names.some((n) => n.includes('broken')), '坏的服务器不产出工具')
    assert.ok(Object.keys(reg.failedServers()).includes('broken'), '失败服务器应可诊断')
    reg.closeAll()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('closeAll：回收后视图为空（防止孤儿进程与"幽灵工具"）', async () => {
  const dir = mkTmp()
  try {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({ servers: { stub: { command: NODE, args: [STUB], timeoutMs: 4000 } } }))
    const reg = createMcpRegistry({ configPath: p, log: () => {} })
    await reg.ready()
    assert.ok(Object.keys(reg.view()).length > 0)
    reg.closeAll()
    assert.deepEqual(reg.view(), {}, 'closeAll 后不应再暴露工具')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('mcpConfigPath：位于配置目录下（PONOS_HOME 可覆盖）', () => {
  const p = mcpConfigPath({ PONOS_HOME: 'C:/tmp/ponos-home' })
  assert.match(p.replace(/\\/g, '/'), /tmp\/ponos-home\/mcp\.json$/)
})

// ---------------------------------------------------------------------------
// P1-5 扩展：HTTP 传输的配置面（url / headers）
test('normalizeMcpServers：接受纯 url 服务器，占位符原样存盘（不落盘解析）', () => {
  const n = normalizeMcpServers({
    servers: { remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } } },
  })
  assert.equal(n.ok, true, `纯 url 配置应合法：${n.ok ? '' : n.error}`)
  assert.equal(n.servers.remote.url, 'https://example.com/mcp')
  assert.equal(n.servers.remote.headers.Authorization, 'Bearer ${TOKEN}',
    '必须原样保存占位符——密钥只能运行时求值，否则会明文落盘')
  assert.equal(n.servers.remote.timeoutMs, 20000, '未给 timeoutMs 应回落默认值')
})

test('normalizeMcpServers：command 与 url 恰好其一（同时给或都不给都报错）', () => {
  const both = normalizeMcpServers({ servers: { x: { command: 'npx', url: 'https://e.com/mcp' } } })
  assert.equal(both.ok, false, '同给应报错（消歧，避免运行期行为取决于实现顺序）')
  assert.match(both.error, /同时/)

  const neither = normalizeMcpServers({ servers: { y: { args: ['-y'] } } })
  assert.equal(neither.ok, false, '两者都缺应报错')
  assert.match(neither.error, /缺少/)
})

test('normalizeMcpServers：字段与传输类型必须匹配', () => {
  const a = normalizeMcpServers({ servers: { x: { url: 'https://e.com/mcp', args: ['--x'] } } })
  assert.equal(a.ok, false, 'url 配 args 应报错（args 仅 stdio）')
  assert.match(a.error, /args/)

  const b = normalizeMcpServers({ servers: { x: { command: 'npx', headers: { A: '1' } } } })
  assert.equal(b.ok, false, 'command 配 headers 应报错（headers 仅 HTTP）')
  assert.match(b.error, /headers/)
})

test('normalizeMcpServers：url 必须是 http(s) 绝对地址', () => {
  for (const bad of ['ftp://e.com/mcp', '/relative/path', 'not a url', '']) {
    const r = normalizeMcpServers({ servers: { x: { url: bad } } })
    assert.equal(r.ok, false, `非法 url 应报错: ${JSON.stringify(bad)}`)
  }
  assert.equal(normalizeMcpServers({ servers: { x: { url: 'http://127.0.0.1:8080/mcp' } } }).ok, true)
})

test('loadMcpServers：不再丢弃纯 url 条目（**读侧修复**）', () => {
  const dir = mkTmp()
  try {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({ servers: { remote: { url: 'https://example.com/mcp', headers: { A: 'B' } } } }))
    const cfg = loadMcpServers(p)
    assert.ok(cfg.remote, '纯 url 服务器必须被加载（修复前会被静默丢弃 ⇒ HTTP 功能整体失效）')
    assert.equal(cfg.remote.url, 'https://example.com/mcp')
    assert.deepEqual(cfg.remote.headers, { A: 'B' })
    assert.equal(cfg.remote.command, undefined, 'HTTP 条目不应带 command 键')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('往返：writeMcpServers 写出的 url 服务器能被读回等价（防两套规则漂移）', () => {
  const dir = mkTmp()
  try {
    const p = join(dir, 'mcp.json')
    const n = normalizeMcpServers({
      servers: { remote: { url: 'https://e.com/mcp', headers: { Authorization: 'Bearer ${T}' }, timeoutMs: 5000 } },
    })
    assert.equal(n.ok, true)
    const w = writeMcpServers(p, n.servers)
    assert.equal(w.ok, true, `写入应成功：${w.ok ? '' : w.error}`)
    const back = loadMcpServers(p)
    assert.equal(back.remote.url, 'https://e.com/mcp')
    assert.deepEqual(back.remote.headers, { Authorization: 'Bearer ${T}' },
      '占位符往返必须不变形（否则"存得进读不出"）')
    assert.equal(back.remote.timeoutMs, 5000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('读校验同口径：loadMcpServers 跳过的条目，normalizeMcpServers 也必须拒绝', () => {
  const dir = mkTmp()
  try {
    const p = join(dir, 'mcp.json')
    const bad = {
      both: { command: 'npx', url: 'https://e.com/mcp' },
      badUrl: { url: 'ftp://e.com/mcp' },
      headersOnStdio: { command: 'npx', headers: { A: '1' } },
    }
    writeFileSync(p, JSON.stringify({ servers: bad }))
    assert.deepEqual(loadMcpServers(p), {}, '三条都应被读侧跳过')
    for (const [name, cfg] of Object.entries(bad)) {
      const r = normalizeMcpServers({ servers: { [name]: cfg } })
      assert.equal(r.ok, false, `${name} 应被校验侧拒绝（两处口径必须一致）`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// P1-5 扩展：${ENV_VAR} 插值（密钥不落盘的执行侧）
test('interpolateEnv：替换已定义变量；无占位符原样返回；多个占位符都替换', () => {
  assert.equal(interpolateEnv('Bearer ${TOKEN}', { TOKEN: 'abc' }), 'Bearer abc')
  assert.equal(interpolateEnv('plain', {}), 'plain')
  assert.equal(interpolateEnv('${A}-${B}', { A: '1', B: '2' }), '1-2')
})

test('interpolateEnv：未定义变量**报错并点名**（绝不静默换空串）', () => {
  // 静默换空串会得到 "Bearer " 这种语法正确但语义空洞的头，
  // 服务器回一个含义不明的 401，排查成本远高于直接报错。
  assert.throws(
    () => interpolateEnv('Bearer ${MISSING}', {}, 'headers.Authorization'),
    (e) => /MISSING/.test(e.message) && /headers\.Authorization/.test(e.message),
    '错误必须点名变量与所在配置项',
  )
  assert.throws(() => interpolateEnv('${EMPTY}', { EMPTY: '' }), /EMPTY/,
    '已定义但为空串同样视为不可用（换成空串等于没配）')
  // 非法变量名（如 ${1BAD}）不匹配占位符语法 ⇒ 原样保留。它进不了 header 值的关键位，
  // 且服务器会直接拒绝；此处不该抛错，否则用户写文档示例都会被误伤。
  assert.equal(interpolateEnv('${1BAD}', {}), '${1BAD}', '非法变量名应原样保留而非误替换')
})
