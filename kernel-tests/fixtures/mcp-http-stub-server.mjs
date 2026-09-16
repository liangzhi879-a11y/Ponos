// MCP Streamable HTTP 测试夹具（零依赖，仅 node:http）。
// ---------------------------------------------------------------------------
// 为什么自己起服务器而不是 mock fetch：本批的关键风险全在**线级行为**上——
//   · 响应可能是 JSON，也可能是 SSE 流（规范允许服务器任选）
//   · 服务器用 Mcp-Session-Id 头维持会话，客户端必须记住并在后续请求回传
//   · 超时必须能真正中断在途连接（否则请求 reject 了、连接还挂着）
//   · 会话过期用 404 表达，与"地址写错"要能区分
// mock fetch 只能验证"我调了什么"，验证不了"我处理得对不对"。
//
// 用法：node mcp-http-stub-server.mjs [mode]
//   mode: json（默认）| sse | http500 | hang | hang-tools | no-session | echo-auth
// 启动后向 stdout 打印一行 PORT=<n>，供测试读取后连接。
import http from 'node:http'

const mode = process.argv[2] || 'json'
const SESSION_ID = 'sess-test-1'

function rpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}
function rpcError(id, message, code = -32000) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

const server = http.createServer((req, res) => {
  if (mode === 'http500') {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('boom')
    return
  }
  if (mode === 'hang') return   // 故意不响应：测超时能否 reject 并清 pending

  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let msg = null
    try { msg = JSON.parse(body) } catch {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('bad json')
      return
    }

    const isInit = msg.method === 'initialize'

    // hang-tools：握手正常返回，但**后续请求一律不响应**。
    // 专门用来测"会话已建立后某次请求超时"——这是最贴近真实故障（服务器卡住）的形态，
    // 也才能验证超时是否清了 pending 并中断了在途连接。hang 模式则连握手都不给。
    if (mode === 'hang-tools' && !isInit) return

    // no-session：init 之外一律 404，模拟"会话已过期/服务器重启"
    if (mode === 'no-session' && !isInit) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(rpcError(msg.id, 'session not found'))
      return
    }
    // 正常模式下，init 之后必须带对 session id（echo-auth 模式不检查，它只关心头）
    if (!isInit && mode !== 'echo-auth' && req.headers['mcp-session-id'] !== SESSION_ID) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(rpcError(msg.id, 'session not found'))
      return
    }

    // 通知（无 id）：规范允许回 202 空体
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202).end()
      return
    }

    let payload
    if (isInit) {
      payload = rpc(msg.id, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'http-stub', version: '1.0.0' },
      })
    } else if (msg.method === 'tools/list') {
      payload = rpc(msg.id, {
        tools: [
          { name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'whoami', description: '回显本次请求的 HTTP 头（供认证头插值用例断言）', inputSchema: { type: 'object', properties: {} } },
        ],
      })
    } else if (msg.method === 'tools/call') {
      const tool = msg.params?.name
      if (tool === 'whoami') {
        // 把收到的头原样回显：只有这样才能证明"服务器确实收到了解析后的认证头"
        payload = rpc(msg.id, { content: [{ type: 'text', text: JSON.stringify({ headers: req.headers }) }] })
      } else {
        const text = msg.params?.arguments?.text ?? ''
        payload = rpc(msg.id, { content: [{ type: 'text', text: `echo:${text}` }] })
      }
    } else {
      payload = rpcError(msg.id, 'method not found', -32601)
    }

    const extra = isInit ? { 'mcp-session-id': SESSION_ID } : {}
    if (mode === 'sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...extra })
      // 规范允许服务器用 SSE 承载响应。这里发一条即结束本次请求的流：
      // 真实服务器常保持流不关，客户端必须"拿到本请求的响应就停止读取"。
      res.write(`event: message\ndata: ${payload}\n\n`)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', ...extra })
    res.end(payload)
  })
})

server.listen(0, '127.0.0.1', () => {
  console.log(`PORT=${server.address().port}`)
})
