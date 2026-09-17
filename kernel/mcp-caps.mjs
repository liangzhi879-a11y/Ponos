// MCP 客户端的「共用能力工厂」——把 tools / resources / prompts 三类**能力**抽成一份。
// ---------------------------------------------------------------------------
// 为什么必须有这个文件（不是"少写代码"，而是"语义只能有一份"）：
//   抽传输（`createJsonRpcSession`）只解决了 pending/超时/abort，**能力层仍是两处各一份**：
//   `mcp.mjs`（stdio）与 `mcp-http.mjs`（HTTP）各自实现 tools()/call()。第二批要加 5 个 method
//   （resources/list、resources/templates/list、resources/read、prompts/list、prompts/get），
//   照旧写法就是两份×5 = 10 处新重复，而重复的恰恰是最容易写错的部分：
//   截断阈值、blob 省略、错误文案、缓存语义。
//   本仓库已为同类问题付过代价（`kernel/guards.mjs` 的"双份守卫"：子 lane 曾因漏改而**没有错误熔断**，
//   一路空转到迭代上限）。故新用例含**反向断言**：两个传输模块内不得再出现 resources/prompts 的
//   `session.request` 直调。
//
// 本模块的依赖纪律：**零依赖、纯逻辑**（除 `contentToText` 外不含任何 IO/配置/进程逻辑），
// 因此可以被两个传输模块共同引用而不会形成循环依赖。
//
// 传输侧只需提供一个已握手的 `session`（`createJsonRpcSession` 的产物）。

/**
 * MCP tools/call 结果 → 纯文本（content 数组展平；非文本条目 JSON 化）。
 *
 * 本函数**原样从 mcp.mjs 搬入**（含 image 省略文案），并由 mcp.mjs 重新导出以保持既有调用方不变。
 * 搬进来的理由：resources/read 与 prompts/get 都要把内容块文本化，若留在 mcp.mjs，
 * 本模块就得反向 import 那个含进程/配置逻辑的大模块（形成循环依赖）。
 */
export function contentToText(result) {
  if (result === null || result === undefined) return ''
  const parts = Array.isArray(result.content) ? result.content : null
  if (!parts) return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  const out = []
  for (const p of parts) {
    if (!p || typeof p !== 'object') { out.push(String(p)); continue }
    if (p.type === 'text' && typeof p.text === 'string') out.push(p.text)
    else if (p.type === 'image') out.push(`[图片 ${p.mimeType || ''} 已省略]`)
    else if (p.type === 'resource' && p.resource?.text) out.push(String(p.resource.text))
    else out.push(JSON.stringify(p))
  }
  return out.join('\n')
}

/**
 * 单次资源读取的字符上限（**保护性上限**，不是"完整读取能力"）。
 *
 * 为什么必须有界：`resources/read` 读的是服务器端任意已暴露文件——一个 10MB 的日志就能
 * 直接把上下文挤爆，模型收到的还是被静默截断的半截内容然后据此下结论。
 * 有界 + **显式标注原始长度**：模型至少知道"这不是全部"。
 */
export const MCP_RESOURCE_MAX_CHARS = 20000

/** 资源清单条数上限：服务器可能有上千资源，清单本身就能爆上下文 */
export const MCP_RESOURCE_LIST_MAX = 200

/** 截断标注（**必须含原始长度**：不写清楚，模型会拿残文当全文） */
export function truncationNote(originalChars, shownChars) {
  return `[已截断：原始 ${originalChars} 字符，仅显示前 ${shownChars} 字符]`
}

/** 二进制资源标注（只报元信息：uri / mimeType / 字节数） */
export function blobNote(uri, mimeType, bytes) {
  return `[二进制资源已省略：${uri}${mimeType ? ` mimeType=${mimeType}` : ''} ${bytes} 字节]`
}

/**
 * base64 的**解码后**字节数（不解码：一张 1MB 图片的 base64 是 ~1.37MB，
 * 为了报一个数字而真去 Buffer.from 一次是白花内存）。
 */
export function base64Bytes(b64) {
  const s = String(b64 ?? '').replace(/\s+/g, '')
  if (!s) return 0
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
  const n = Math.floor((s.length * 3) / 4) - pad
  return n > 0 ? n : 0
}

/**
 * 创建能力工厂。所有方法的**错误语义与传输层一致：抛异常**，由接入层
 * （`mcp-tools.mjs` 的 `run()`）统一转成 `{content, isError:true}`——
 * 错误处理只有一个落点，才不会出现"某条路径忘了 catch 就抛崩引擎轮次"。
 * @param {{request:Function}} session 已握手的 JSON-RPC 会话
 * @param {{name:string, onLog?:Function, resourceMaxChars?:number, resourceListMax?:number}} opts
 */
export function createCapabilities(session, {
  name, onLog = null,
  resourceMaxChars = MCP_RESOURCE_MAX_CHARS,
  resourceListMax = MCP_RESOURCE_LIST_MAX,
} = {}) {
  const log = (level, msg) => { try { onLog?.(level, msg) } catch { /* 日志失败不影响协议 */ } }
  const label = String(name || 'mcp')
  let calls = 0
  let toolsCache = null
  // 阈值的**唯一归一化点**：散落魔法数是这类"有界"逻辑最容易两处不一致的地方
  const maxChars = Number.isFinite(resourceMaxChars) && resourceMaxChars > 0 ? resourceMaxChars : MCP_RESOURCE_MAX_CHARS
  const listMax = Number.isFinite(resourceListMax) && resourceListMax > 0 ? resourceListMax : MCP_RESOURCE_LIST_MAX


  return {
    /** tools/list（带缓存：视图在每次迭代都会求值，不能每次都打一次协议往返） */
    async tools() {
      if (toolsCache) return toolsCache
      const r = await session.request('tools/list', {})
      toolsCache = Array.isArray(r?.tools)
        ? r.tools.map((t) => ({
          name: String(t.name),
          description: String(t.description || ''),
          input_schema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
        }))
        : []
      return toolsCache
    },
    /** tools/call（calls 计数供 stats() 诊断用；行为与文案与搬迁前逐字一致） */
    async call(tool, argsObj = {}, opts = {}) {
      calls++
      const r = await session.request('tools/call', { name: tool, arguments: argsObj || {} }, opts)
      return { text: contentToText(r), isError: r?.isError === true, raw: r }
    },
    /**
     * resources/list + resources/templates/list 合一的清单（**只读，不缓存**）。
     *
     * 不缓存（与 tools() 不同）的理由：资源是**服务器端可变的数据**，用户随时可能在服务器上
     * 新增/删除文件；清单缓存只会让模型看到过期事实。tools 反而稳定得多（随服务器版本变），
     * 且视图每迭代求值，才需要缓存。
     *
     * templates 失败**不致命**：部分服务器不实现 `resources/templates/list`（能力可选），
     * 拿不到就只回 list 结果并记日志——不该因为少一个可选 method 就让整份清单不可用。
     * @returns {Promise<{items:Array, total:number, truncated:boolean, templatesFailed:boolean}>}
     */
    async resources(opts = {}) {
      const r = await session.request('resources/list', {}, opts)
      const items = []
      for (const x of (Array.isArray(r?.resources) ? r.resources : [])) {
        items.push({
          uri: String(x?.uri ?? ''),
          name: String(x?.name ?? ''),
          description: String(x?.description ?? ''),
          mimeType: x?.mimeType ? String(x.mimeType) : '',
          isTemplate: false,
        })
      }
      let templatesFailed = false
      try {
        const t = await session.request('resources/templates/list', {}, opts)
        for (const x of (Array.isArray(t?.resourceTemplates) ? t.resourceTemplates : [])) {
          items.push({
            // 模板用 uriTemplate（含 {var}），字段名归一为 uri 以便上层统一处理
            uri: String(x?.uriTemplate ?? ''),
            name: String(x?.name ?? ''),
            description: String(x?.description ?? ''),
            mimeType: x?.mimeType ? String(x.mimeType) : '',
            isTemplate: true,
          })
        }
      } catch (e) {
        templatesFailed = true
        log('debug', `MCP ${label} 资源模板列表不可用（已忽略）：${e?.message || String(e)}`)
      }
      const total = items.length
      const truncated = total > listMax
      return { items: truncated ? items.slice(0, listMax) : items, total, truncated, templatesFailed }
    },
    /**
     * resources/read → 文本化。落实 spec D-3 的两条硬约束：
     *   ① **有界**：超过 `resourceMaxChars` 就截断，并**显式标注原始字符数**；
     *   ② **blob 只报元信息**（uri/mimeType/字节数）——**绝不 base64**。
     *      一张 1MB 图片 base64 后 ≈1.37MB，直接挤爆上下文，而模型对 base64 也无能为力；
     *      这与既有 `contentToText` 对 `image` 的处理是同一哲学。
     *
     * 返回 `truncated` / `originalChars` 是为了让上层与测试能**断言**"没超限就没截断"
     * （只有标注、没有布尔量的话，"一律截断"这种退化写法测不出来）。
     * `isError` 恒为 false：协议里 `resources/read` 没有该字段，保留它是为了让接入层
     * 与 `call()` 的结果形状一致（同一个取值表达式，不必分支）。
     * @returns {Promise<{text:string, isError:boolean, truncated:boolean, originalChars:number}>}
     */
    async readResource(uri, opts = {}) {
      const r = await session.request('resources/read', { uri: String(uri ?? '') }, opts)
      const parts = Array.isArray(r?.contents) ? r.contents : []
      const chunks = []
      for (const p of parts) {
        if (!p || typeof p !== 'object') { chunks.push(String(p)); continue }
        if (typeof p.text === 'string') { chunks.push(p.text); continue }
        if (p.blob !== undefined && p.blob !== null) {
          // 注意：`blobNote` 只接收**字节数**，base64 原文在此被丢弃（不进 text、不进返回值）
          chunks.push(blobNote(p.uri || String(uri ?? ''), p.mimeType ? String(p.mimeType) : '', base64Bytes(p.blob)))
          continue
        }
        chunks.push(JSON.stringify(p))   // 未知条目：JSON 化保留信息（与 contentToText 同哲学）
      }
      const full = chunks.join('\n')
      const originalChars = full.length
      const truncated = originalChars > maxChars
      return {
        text: truncated ? `${full.slice(0, maxChars)}\n${truncationNote(originalChars, maxChars)}` : full,
        isError: false,
        truncated,
        originalChars,
      }
    },

    /**
     * prompts/list：模板清单（含参数声明）。
     *
     * **这些模板绝不注册进模型工具表**（MCP 规范把 prompts 定为 *user-controlled*：
     * 挑模板是**用户**的动作，不是模型该自主决定的事）。本方法只提供给"用户显式选择"的通道
     * （桥路由 / 设置面板），与 tools 的可见性语义刻意分开。
     * @returns {Promise<Array<{name:string, description:string, arguments:Array<{name:string,description:string,required:boolean}>}>>}
     */
    async prompts(opts = {}) {
      const r = await session.request('prompts/list', {}, opts)
      const list = Array.isArray(r?.prompts) ? r.prompts : []
      return list.map((p) => ({
        name: String(p?.name ?? ''),
        description: String(p?.description ?? ''),
        arguments: (Array.isArray(p?.arguments) ? p.arguments : []).map((a) => ({
          name: String(a?.name ?? ''),
          description: String(a?.description ?? ''),
          // 只认显式 true：缺省视为可选（规范里 required 缺省即 false），
          // 否则界面上会把所有参数都标成必填，用户被自己的参数吓退
          required: a?.required === true,
        })),
      }))
    },
    /**
     * prompts/get：取一个渲染好的模板文本。
     *
     * 复用 `contentToText` 文本化每条 message 的内容块——同一个哲学：非文本条目省略/JSON 化，
     * 绝不把二进制塞进上下文。缺必填参数由服务器报错（-32602 等），异常原样上抛，
     * 由接入层/桥统一转成"正常业务结果"（不是 5xx）。
     * @returns {Promise<{text:string, description:string, isError:boolean, messageCount:number}>}
     */
    async getPrompt(promptName, argsObj = {}, opts = {}) {
      const r = await session.request('prompts/get', { name: String(promptName ?? ''), arguments: argsObj || {} }, opts)
      const messages = Array.isArray(r?.messages) ? r.messages : []
      const rendered = []
      for (const m of messages) {
        const c = m?.content
        const blocks = Array.isArray(c) ? c : (c === undefined || c === null ? [] : [c])
        const inner = contentToText({ content: blocks })
        if (!inner) continue
        // 带上角色：渲染结果会插入用户输入框，用户要能看出哪段是 system / user
        rendered.push(`[${String(m?.role || 'user')}]\n${inner}`)
      }
      return {
        text: rendered.join('\n\n'),
        description: String(r?.description ?? ''),
        isError: r?.isError === true,
        messageCount: messages.length,
      }
    },
    /**
     * 调用计数（传输层的 stats().calls 需要它）。
     * 由本模块持有**唯一**计数——若两侧各记一份，就会出现"stdio 的 calls 对、HTTP 的对不上"
     * 这类只在其中一个传输上复现的怪现象。
     */
    stats() { return { calls } },
  }
}
