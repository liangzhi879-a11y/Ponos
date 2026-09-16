// 测试用 MCP stub 服务器（stdio JSON-RPC 2.0）——仅供 kernel-tests/mcp.test.mjs 使用。
// 故障注入（按 tool 名触发），覆盖客户端异常路径：
//   echo  → 正常 content 数组
//   boom  → JSON-RPC error（验证转 is_error 而非抛崩引擎）
//   hang  → 永不回复（验证请求超时且 pending 被清理）
//   die   → 直接退出进程（验证进程退出时 pending 被 reject、不悬挂）
//   plain → 非 content 结构（验证文本化兜底）
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })

const TOOLS = [
  { name: 'echo', description: '回显传入文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'boom', description: '总是失败', inputSchema: { type: 'object', properties: {} } },
  { name: 'hang', description: '永不回复', inputSchema: { type: 'object', properties: {} } },
  { name: 'die', description: '退出进程', inputSchema: { type: 'object', properties: {} } },
  { name: 'plain', description: '返回非 content 结构', inputSchema: { type: 'object', properties: {} } },
]

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg
  try { msg = JSON.parse(t) } catch { return }
  if (msg.id === undefined) return // 通知（notifications/initialized）不应答
  const { id, method, params } = msg
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } } })
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  if (method === 'tools/call') {
    const tool = params?.name
    if (tool === 'hang') return // 故意不回复
    if (tool === 'die') { process.exit(0); return }
    if (tool === 'boom') return send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'boom 注定失败' } })
    if (tool === 'plain') return send({ jsonrpc: '2.0', id, result: { ok: true, value: 42 } })
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${params?.arguments?.text ?? ''}` }] } })
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } })
})

process.stderr.write('stub 服务器已就绪\n')
