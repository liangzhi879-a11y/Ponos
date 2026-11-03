// MCP 第二批（resources + prompts）测试（2026-09-16）。
// ---------------------------------------------------------------------------
// 覆盖重点（每条都是本批**最容易做错且一旦做错后果严重**的点）：
//   ① 共用能力工厂：两传输走同一实现 ⇒ 复用同一份截断/blob/缓存语义
//   ② **防再重复**（源码级反向断言）：两个传输模块内不得再有 capabilities 的 session.request 直调
//   ③ 有界：超大资源被截断**且标注原始长度**；未超限资源 `truncated===false`（防"一律截断"）
//   ④ blob **绝不 base64**（断言输出里没有它，而不是"看起来没问题"）
//   ⑤ prompts **不进工具视图**（反向断言）——照 tools 抄一份就"能跑"，但语义全错
//   ⑥ 失败路径不抛（坏 uri / 服务器已关闭 ⇒ {content, isError:true}）
//   ⑦ `expose` 过滤对新增的资源工具同样生效
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startMcpClient } from '../kernel/mcp.mjs'
import { startMcpHttpClient } from '../kernel/mcp-http.mjs'
import { createCapabilities, MCP_RESOURCE_MAX_CHARS, base64Bytes } from '../kernel/mcp-caps.mjs'
import { createMcpRegistry } from '../kernel/mcp-tools.mjs'

const STUB = fileURLToPath(new URL('./fixtures/mcp-stub-server.mjs', import.meta.url))
const HTTP_STUB = fileURLToPath(new URL('./fixtures/mcp-http-stub-server.mjs', import.meta.url))
const KERNEL_DIR = fileURLToPath(new URL('../kernel/', import.meta.url))
const NODE = process.execPath

const mkTmp = () => mkdtempSync(join(tmpdir(), 'yfw-mcp2-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个连到 stdio stub 的客户端（跑完请 close） */
const startStub = (timeoutMs = 4000) => startMcpClient({ name: 'stub', command: NODE, args: [STUB], timeoutMs })

/** 起 HTTP 夹具并等它打印 PORT=<n> */
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

/** 去掉行注释与块注释后的源码（判据只看**真实调用**，别被注释里提到的 method 名误伤） */
function codeOf(file) {
  return readFileSync(join(KERNEL_DIR, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 在临时目录里配一台 stub 服务器并起注册表 */
async function withRegistry(servers, fn) {
  const dir = mkTmp()
  try {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({ servers }), 'utf-8')
    const reg = createMcpRegistry({ configPath: p, log: () => {} })
    await reg.ready()
    try { return await fn(reg) } finally { reg.closeAll() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
// ① 共用能力工厂 + ② 防再重复
// ---------------------------------------------------------------------------
test('防再重复：两个传输模块内不得出现 capabilities 的 session.request 直调', () => {
  // 判据：`session.request('tools/…' | 'resources/…' | 'prompts/…')`。
  // 为什么必须钉死：本批加了 5 个 method，若两处各写一遍就是 10 处重复，
  // 而重复的恰恰是最容易写错的截断阈值 / blob 省略 / 错误文案。
  // 本仓库已为同类问题付过代价（guards.mjs 的"双份守卫"：子 lane 曾漏改而**没有错误熔断**）。
  const forbidden = /session\.request\(\s*['"`](?:tools|resources|prompts)\//
  for (const f of ['mcp.mjs', 'mcp-http.mjs']) {
    const src = codeOf(f)
    const hit = src.match(forbidden)
    assert.equal(hit, null, `${f} 不应再有能力层直调（实测命中：${hit?.[0]}）——应走 mcp-caps.mjs`)
  }
  // 正向前提：两边确实都在用共用工厂（否则上一条断言会因为"根本没实现"而空转通过）
  for (const f of ['mcp.mjs', 'mcp-http.mjs']) {
    assert.match(codeOf(f), /createCapabilities\(session,/, `${f} 必须经 createCapabilities 提供能力`)
    assert.match(codeOf(f), /from '\.\/mcp-caps\.mjs'/, `${f} 必须从 mcp-caps.mjs 导入`)
  }
})

test('两传输共用同一实现：能力方法齐全，且结果形状一致', async () => {
  const s = await startHttpStub('json')
  const stdio = await startStub()
  const http = await startMcpHttpClient({ name: 'remote', url: `http://127.0.0.1:${s.port}/mcp`, timeoutMs: 5000 })
  try {
    for (const [label, c] of [['stdio', stdio], ['http', http]]) {
      for (const m of ['tools', 'call', 'resources', 'readResource', 'prompts', 'getPrompt']) {
        assert.equal(typeof c[m], 'function', `${label} 客户端应提供 ${m}()`)
      }
      // 形状必须一致：上层（注册表/工具接入）对两传输无感，形状不同就会"某个传输下坏掉"
      const r = await c.resources()
      assert.deepEqual(Object.keys(r).sort(), ['items', 'templatesFailed', 'total', 'truncated'],
        `${label} resources() 返回形状应一致`)
      assert.ok(r.items.every((x) => Object.keys(x).sort().join() === 'description,isTemplate,mimeType,name,uri'),
        `${label} 资源条目形状应一致`)
      const rd = await c.readResource(r.items[0].uri)
      assert.deepEqual(Object.keys(rd).sort(), ['isError', 'originalChars', 'text', 'truncated'],
        `${label} readResource() 返回形状应一致`)
      assert.equal(rd.truncated, false, `${label} 小资源不应被截断`)
      const pr = await c.prompts()
      assert.ok(pr.some((x) => x.name === 'summarize'), `${label} 应能看到 summarize prompt`)
    }
    // 同名 prompt 在两传输下渲染结果一致（同一份实现 ⇒ 同样带角色前缀）
    const a = await stdio.getPrompt('summarize', { text: 'T' })
    const b = await http.getPrompt('summarize', { text: 'T' })
    assert.equal(a.text, b.text, '同一 prompt 在两传输下渲染结果应一致')
    assert.match(a.text, /\[user\]/, '渲染结果应带角色前缀（用户要能看出哪段是 system/user）')
    assert.match(a.text, /\[system\]/, 'system 段也必须渲染出来')
  } finally {
    stdio.close(); http.close(); s.kill()
  }
})

// ---------------------------------------------------------------------------
// ③ 有界：截断与"不截断"的反向断言
// ---------------------------------------------------------------------------
test('readResource：超大资源被截断且**标注原始长度**；小资源不截断（防"一律截断"）', async () => {
  const c = await startStub()
  try {
    const big = await c.readResource('file:///docs/big.txt')
    assert.equal(big.truncated, true, '超过阈值的资源必须被截断（否则会挤爆上下文）')
    assert.ok(big.originalChars > MCP_RESOURCE_MAX_CHARS,
      `原始长度应大于阈值：${big.originalChars} > ${MCP_RESOURCE_MAX_CHARS}`)
    // 标注必须含**原始长度**——只写"已截断"的话，模型不知道丢了多少，仍会拿残文当全文
    assert.match(big.text, new RegExp(`原始 ${big.originalChars} 字符`), '标注必须含原始字符数')
    assert.match(big.text, /已截断/, '必须有显式截断标注')
    assert.match(big.text, /^BIG-/, '截断应保留**前** maxChars 个字符（模型至少能看到开头）')

    // ★ 长度也必须真的**小于**原文：只贴一条标注、正文仍全量返回的实现是"假截断"，
    //   上下文照样被挤爆——而它靠上面那条"标注里有原始长度"的断言是**测不出来**的。
    const body = big.text.split('\n[已截断')[0]
    assert.equal(body.length, MCP_RESOURCE_MAX_CHARS, `正文应恰好保留前 ${MCP_RESOURCE_MAX_CHARS} 个字符`)
    assert.ok(big.text.length < big.originalChars,
      `输出长度必须小于原文：${big.text.length} < ${big.originalChars}`)
    assert.ok(big.text.length <= MCP_RESOURCE_MAX_CHARS + 200, '输出（含标注）不应明显超出阈值')

    // ★ 反向断言：未超限的资源**不得**被截断。
    // 少了这条，"截断写成一律截断"这种退化实现会全绿通过。
    const small = await c.readResource('file:///docs/readme.md')
    assert.equal(small.truncated, false, '未超限资源不得被截断')
    assert.ok(!small.text.includes('已截断'), '未超限资源的正文里不应出现截断标注')
    assert.equal(small.originalChars, small.text.length, '未截断时 text 长度应等于 originalChars')
  } finally { c.close() }
})

test('阈值参数化：传小阈值即按小阈值截断（阈值不是散落魔法数）', async () => {
  const session = {
    request: async (method) => {
      assert.equal(method, 'resources/read')
      return { contents: [{ uri: 'x', text: 'a'.repeat(100) }] }
    },
  }
  const caps = createCapabilities(session, { name: 'fake', resourceMaxChars: 10 })
  const r = await caps.readResource('x')
  assert.equal(r.truncated, true)
  assert.equal(r.originalChars, 100)
  assert.ok(r.text.startsWith('a'.repeat(10)), '应按传入阈值截断')
  assert.match(r.text, /原始 100 字符/)
})

test('resources()：模板经 uriTemplate 归一为 uri 并标注 isTemplate；模板接口失败**不致命**', async () => {
  // 用假 session 精确构造"templates 不可用"（真实服务器不实现该可选 method 的常见形态）
  const ok = createCapabilities({ request: async (m) => (m === 'resources/list'
    ? { resources: [{ uri: 'u1', name: 'n', mimeType: 'text/plain' }] }
    : { resourceTemplates: [{ uriTemplate: 'u/{x}', name: 't' }] }) }, { name: 'fake' })
  const r = await ok.resources()
  assert.equal(r.templatesFailed, false)
  assert.equal(r.items.length, 2)
  assert.equal(r.items[0].isTemplate, false)
  assert.equal(r.items[1].uri, 'u/{x}', '模板的 uriTemplate 应归一为 uri 字段')
  assert.equal(r.items[1].isTemplate, true, '模板必须可区分（否则用户会当普通资源去读）')

  const bad = createCapabilities({ request: async (m) => {
    if (m === 'resources/list') return { resources: [{ uri: 'u1' }] }
    throw new Error('method not found')
  } }, { name: 'fake' })
  const r2 = await bad.resources()
  assert.equal(r2.items.length, 1, 'templates 失败时仍应返回 list 结果（不该整份清单不可用）')
  assert.equal(r2.templatesFailed, true, '失败要如实标记，便于诊断')
})

// ---------------------------------------------------------------------------
// ④ blob：绝不泄漏 base64
// ---------------------------------------------------------------------------
test('readResource：blob 只报元信息，**绝不**把 base64 带进上下文', async () => {
  const c = await startStub()
  try {
    const r = await c.readResource('file:///img/logo.png')
    const expectBytes = Buffer.from('PNG-FAKE-BYTES'.repeat(40)).length
    assert.match(r.text, /二进制资源已省略/, 'blob 必须有显式省略标注（否则模型以为资源是空的）')
    assert.match(r.text, /file:\/\/\/img\/logo\.png/, '标注须含 uri')
    assert.match(r.text, /image\/png/, '标注须含 mimeType')
    assert.match(r.text, new RegExp(`${expectBytes} 字节`), '标注须含字节数（这是模型唯一能用的元信息）')
    // ★ 反向断言：base64 原文绝不能出现在输出里
    assert.ok(!r.text.includes('data:'), '不得出现 data: 形式的内联数据')
    assert.ok(!r.text.includes(Buffer.from('PNG-FAKE-BYTES'.repeat(40)).toString('base64')),
      'base64 原文不得进入上下文（1MB 图片 base64 后 ≈1.37MB，直接挤爆）')
    assert.ok(!/[A-Za-z0-9+/]{60,}/.test(r.text), '不应出现长 base64 片段')
  } finally { c.close() }
})

test('base64Bytes：按填充算解码后字节数（不解码，避免为报数字而花内存）', () => {
  assert.equal(base64Bytes(''), 0)
  assert.equal(base64Bytes(null), 0)
  assert.equal(base64Bytes(Buffer.from('abc').toString('base64')), 3)
  assert.equal(base64Bytes(Buffer.from('PNG-FAKE-BYTES'.repeat(40)).toString('base64')), 560)
  assert.equal(base64Bytes('QUJD'), 3, '无填充 4 字符 = 3 字节')
  assert.equal(base64Bytes('QUJD\nQUJD'), 6, '换行应被忽略（base64 常按行折行）')
})

// ---------------------------------------------------------------------------
// ⑤ 失败路径不抛（接入层归一为 isError）
// ---------------------------------------------------------------------------
test('readResource：uri 不存在 ⇒ 抛异常（由接入层转 isError，不向上传播）', async () => {
  const c = await startStub()
  try {
    await assert.rejects(() => c.readResource('file:///nope.txt'), /资源不存在/)
  } finally { c.close() }
})

test('接入层：坏 uri ⇒ {content, isError:true}（**不抛**，否则会崩掉引擎轮次）', async () => {
  await withRegistry({ stub: { command: NODE, args: [STUB], timeoutMs: 4000 } }, async (reg) => {
    const view = reg.view()
    const bad = await view.mcp__stub__read_resource.run({ uri: 'file:///nope.txt' }, {})
    assert.equal(bad.isError, true, '坏 uri 必须转成 is_error 结果')
    assert.match(String(bad.content), /MCP 工具错误（stub\/read_resource）/, '错误文案应点名服务器与工具')
    assert.match(String(bad.content), /资源不存在/, '错误文案应保留服务器给出的原因（可诊断）')
  })
})

test('接入层：服务器已关闭 ⇒ {content, isError:true}（不抛、不悬挂）', async () => {
  const dir = mkTmp()
  try {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({ servers: { stub: { command: NODE, args: [STUB], timeoutMs: 4000 } } }), 'utf-8')
    const reg = createMcpRegistry({ configPath: p, log: () => {} })
    await reg.ready()
    const view = reg.view()
    const listFn = view.mcp__stub__list_resources.run   // 先取引用：closeAll 会清空视图
    const readFn = view.mcp__stub__read_resource.run
    reg.closeAll()
    await sleep(100)
    const a = await listFn({}, {})
    const b = await readFn({ uri: 'file:///docs/readme.md' }, {})
    assert.equal(a.isError, true, '服务器关闭后 list_resources 应报错而非抛出')
    assert.equal(b.isError, true, '服务器关闭后 read_resource 应报错而非抛出')
    assert.match(String(a.content), /已关闭/, '应给出"已关闭"这一可诊断原因')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// ⑥ 命名、expose 过滤、清单渲染
// ---------------------------------------------------------------------------
test('资源工具：命名、描述前缀、concurrencySafe:false、input_schema', async () => {
  await withRegistry({ stub: { command: NODE, args: [STUB], timeoutMs: 4000 } }, async (reg) => {
    const view = reg.view()
    const list = view.mcp__stub__list_resources
    const read = view.mcp__stub__read_resource
    assert.ok(list && read, '每个启用的服务器都应固定暴露两个资源工具（spec D-2）')
    for (const [k, e] of [['list_resources', list], ['read_resource', read]]) {
      assert.ok(e.description.startsWith('[MCP:stub]'), `${k} 描述须带来源前缀（与既有工具一致）`)
      // 外部工具按"未知风险"处理：read_resource 能读服务器端任意已暴露文件，比普通工具更需要把关
      assert.equal(e.concurrencySafe, false, `${k} 不得参与并发批次`)
    }
    assert.deepEqual(list.input_schema.properties, {}, 'list_resources 无参')
    assert.deepEqual(read.input_schema.required, ['uri'], 'read_resource 的 uri 必填')

    // 清单渲染：uri + 名称 + 模板标注（模板不能被当成普通资源去读）
    const r = await list.run({}, {})
    assert.equal(r.isError, false)
    assert.match(String(r.content), /file:\/\/\/docs\/readme\.md/)
    assert.match(String(r.content), /\[模板\]/, '模板应带标注')
    assert.match(String(r.content), /file:\/\/\/docs\/\{name\}\.md/, '模板以 uriTemplate 形式列出')

    // 读正常资源：正文原样返回
    const one = await read.run({ uri: 'file:///docs/readme.md' }, {})
    assert.equal(one.isError, false)
    assert.match(String(one.content), /这是一份小资源的正文/)
  })
})

test('expose 过滤对新增的资源工具同样生效（private 不可见、public 可见）', async () => {
  await withRegistry({
    pub: { command: NODE, args: [STUB], timeoutMs: 4000, expose: { mode: 'public' } },
    priv: { command: NODE, args: [STUB], timeoutMs: 4000, expose: { mode: 'private' } },
    bound: { command: NODE, args: [STUB], timeoutMs: 4000, expose: { mode: 'bound', bindAgents: ['other'] } },
  }, async (reg) => {
    const names = Object.keys(reg.view())
    assert.ok(names.includes('mcp__pub__list_resources'), 'public 服务器的资源工具应可见')
    assert.ok(!names.some((n) => n.startsWith('mcp__priv__')), 'private 服务器的资源工具必须不可见')
    assert.ok(!names.some((n) => n.startsWith('mcp__bound__')), 'bound 未列出该 agent 时不可见')
    // 但**实际发现**不受影响（面板要显示"台子上有什么"，与"谁看得见"是两个维度）
    assert.ok(reg.toolNames().includes('mcp__priv__read_resource'), '发现阶段不做可见性过滤')
    assert.equal(reg.snapshot().servers.priv.expose, 'private')
  })
})

test('snapshot：新增 resources 计数，且不破坏既有字段', async () => {
  await withRegistry({ stub: { command: NODE, args: [STUB], timeoutMs: 4000 } }, async (reg) => {
    const s = reg.snapshot()
    assert.equal(s.servers.stub.resources, 4, 'stub 有 4 条资源（3 普通 + 1 模板）')
    assert.equal(typeof s.servers.stub.expose, 'string')
    assert.ok(Array.isArray(s.servers.stub.tools), '既有 tools 字段不得改动')
    for (const k of ['failed', 'disabled', 'configSig']) {
      assert.ok(k in s, `既有字段 ${k} 不得丢失（面板依赖它）`)
    }
  })
})

// ---------------------------------------------------------------------------
// ★ ⑤ prompts 不进工具视图（本批最容易做错的一点）
// ---------------------------------------------------------------------------
test('prompts：**绝不**出现在 view() / toolNames() 里（反向断言）', async () => {
  await withRegistry({ stub: { command: NODE, args: [STUB], timeoutMs: 4000 } }, async (reg) => {
    // 正向：prompt 清单确实取到了（否则下面的反向断言会因为"压根没取"而空转通过）
    const ps = reg.promptsSnapshot()
    assert.deepEqual(ps.servers.stub.prompts.map((p) => p.name).sort(), ['greet', 'summarize'],
      'prompts 应从服务器取到（否则反向断言无意义）')
    assert.deepEqual(ps.servers.stub.prompts.find((p) => p.name === 'summarize').arguments,
      [{ name: 'text', description: '要总结的文本', required: true }], '应保留参数声明（GUI 要据此做必填校验）')

    // ★ 反向：prompt 名与常用前缀都不得是工具键
    const keys = Object.keys(reg.view())
    for (const k of keys) {
      assert.ok(!/summarize|greet/.test(k), `工具键里不得出现 prompt 名（实测 ${k}）`)
      assert.ok(!/prompt/i.test(k), `不得注册任何 prompt 相关工具（实测 ${k}）`)
    }
    assert.ok(!reg.toolNames().some((k) => /summarize|greet/.test(k)), 'toolNames() 同样不得含 prompt')
    // 且不含任何以 prompt 名出现的条目（防止有人换个前缀塞进去）
    assert.equal(keys.filter((k) => k.includes('summarize') || k.includes('greet')).length, 0)
  })
})

test('getPrompt：渲染文本带角色前缀；缺必填参数 ⇒ 抛异常（由桥/接入层转正常业务结果）', async () => {
  const c = await startStub()
  try {
    const ok = await c.getPrompt('summarize', { text: '内容' })
    assert.equal(ok.isError, false)
    assert.match(ok.text, /\[system\]\n你是摘要助手。/)
    assert.match(ok.text, /\[user\]\n请总结：内容/)
    assert.equal(ok.messageCount, 2)
    await assert.rejects(() => c.getPrompt('summarize', {}), /缺少必填参数 text/,
      '缺必填参数应由服务器报错并上抛（不当成"空模板"静默返回）')
    await assert.rejects(() => c.getPrompt('nope', {}), /prompt 不存在/)
  } finally { c.close() }
})
