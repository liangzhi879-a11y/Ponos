// 测试用 MCP stub 服务器（stdio JSON-RPC 2.0）——供 kernel-tests 的 MCP 用例使用。
// 故障注入（按 tool 名触发），覆盖客户端异常路径：
//   echo  → 正常 content 数组
//   boom  → JSON-RPC error（验证转 is_error 而非抛崩引擎）
//   hang  → 永不回复（验证请求超时且 pending 被清理）
//   die   → 直接退出进程（验证进程退出时 pending 被 reject、不悬挂）
//   plain → 非 content 结构（验证文本化兜底）
//
// 第二批（resources + prompts）扩展的 method：
//   resources/list            → 3 条资源（含**超大**与**blob**，见下）
//   resources/templates/list  → 1 条模板（可选 method，客户端须容忍其失败）
//   resources/read            → 按 uri 分派；未知 uri 回 JSON-RPC error
//   prompts/list              → 2 个 prompt（一个带必填参数）
//   prompts/get               → 渲染文本；缺必填参数回 error
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })

const TOOLS = [
  { name: 'echo', description: '回显传入文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'boom', description: '总是失败', inputSchema: { type: 'object', properties: {} } },
  { name: 'hang', description: '永不回复', inputSchema: { type: 'object', properties: {} } },
  { name: 'die', description: '退出进程', inputSchema: { type: 'object', properties: {} } },
  { name: 'plain', description: '返回非 content 结构', inputSchema: { type: 'object', properties: {} } },
]

// —— 资源夹具 ——
const SMALL_TEXT = '这是一份小资源的正文（含中文与 ASCII: hello）。'
// 超大资源：长度刻意超过客户端默认阈值 20000（见 MCP_RESOURCE_MAX_CHARS）。
// 内容用可校验的重复片段，便于用例断言"截断后仍能看到前缀"与"标注里有原始长度"。
const BIG_TEXT = 'BIG-' + 'x'.repeat(25000)
// blob：真实形态是 base64。这里用一段**可辨识的长 base64**，
// 用例据此断言"输出里没有它"（若实现把 base64 塞进上下文，断言立刻变红）。
const BLOB_B64 = Buffer.from('PNG-FAKE-BYTES'.repeat(40)).toString('base64')

const RESOURCES = [
  { uri: 'file:///docs/readme.md', name: 'README', description: '小文本资源', mimeType: 'text/markdown' },
  { uri: 'file:///docs/big.txt', name: '大文件', description: '超过客户端阈值', mimeType: 'text/plain' },
  { uri: 'file:///img/logo.png', name: 'logo', description: '二进制资源', mimeType: 'image/png' },
]

const RESOURCE_TEMPLATES = [
  { uriTemplate: 'file:///docs/{name}.md', name: '文档模板', description: '按名取文档', mimeType: 'text/markdown' },
]

const PROMPTS = [
  {
    name: 'summarize',
    description: '总结一段文本',
    arguments: [{ name: 'text', description: '要总结的文本', required: true }],
  },
  {
    name: 'greet',
    description: '打个招呼（无参数）',
    arguments: [],
  },
]

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const rpcError = (id, message, code = -32000) => send({ jsonrpc: '2.0', id, error: { code, message } })

/** resources/read 的分派（未知 uri → error，用于验证失败路径转 isError 而非抛出） */
function readResource(id, uri) {
  if (uri === 'file:///docs/readme.md') {
    return send({ jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: 'text/markdown', text: SMALL_TEXT }] } })
  }
  if (uri === 'file:///docs/big.txt') {
    return send({ jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: 'text/plain', text: BIG_TEXT }] } })
  }
  if (uri === 'file:///img/logo.png') {
    // **只给 blob**：没有 text 字段。客户端必须据此"只报元信息"，绝不能把 blob 原文带出去。
    return send({ jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: 'image/png', blob: BLOB_B64 }] } })
  }
  return rpcError(id, `资源不存在：${uri}`, -32002)
}

rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg
  try { msg = JSON.parse(t) } catch { return }
  if (msg.id === undefined) return // 通知（notifications/initialized）不应答
  const { id, method, params } = msg
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'stub', version: '1.0.0' } } })
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  if (method === 'tools/call') {
    const tool = params?.name
    if (tool === 'hang') return // 故意不回复
    if (tool === 'die') { process.exit(0); return }
    if (tool === 'boom') return rpcError(id, 'boom 注定失败')
    if (tool === 'plain') return send({ jsonrpc: '2.0', id, result: { ok: true, value: 42 } })
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${params?.arguments?.text ?? ''}` }] } })
  }
  // —— 第二批：resources ——
  if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: RESOURCES } })
  if (method === 'resources/templates/list') {
    return send({ jsonrpc: '2.0', id, result: { resourceTemplates: RESOURCE_TEMPLATES } })
  }
  if (method === 'resources/read') return readResource(id, params?.uri)
  // —— 第二批：prompts ——
  if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: PROMPTS } })
  if (method === 'prompts/get') {
    const pname = params?.name
    const args = params?.arguments || {}
    if (pname === 'summarize') {
      // 必填参数缺失 → error（验证"服务器报错 ⇒ 接入层转正常业务结果，不是 5xx"）
      if (!args.text) return rpcError(id, '缺少必填参数 text', -32602)
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          description: '总结一段文本',
          messages: [
            { role: 'system', content: { type: 'text', text: '你是摘要助手。' } },
            { role: 'user', content: [{ type: 'text', text: `请总结：${args.text}` }] },
          ],
        },
      })
    }
    if (pname === 'greet') {
      return send({ jsonrpc: '2.0', id, result: { messages: [{ role: 'user', content: { type: 'text', text: '你好！' } }] } })
    }
    return rpcError(id, `prompt 不存在：${pname}`, -32602)
  }
  rpcError(id, `未知方法 ${method}`, -32601)
})

process.stderr.write('stub 服务器已就绪\n')
