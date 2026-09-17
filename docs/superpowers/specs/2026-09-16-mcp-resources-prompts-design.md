# Spec：MCP 第二批（resources + prompts）设计（2026-09-16）

来源：`docs/待处理清单.md` 第 273 行 `P1` 条目遗留子项。该条目 §5「P0」「P1」两组均已闭环，
唯"MCP resources/prompts（第二批）未开始"——上批（Streamable HTTP）spec 第 5 行即写明
"第二批 = resources/prompts（另开 spec）"，本文件即那份 spec。

## 1. 目标

在既有 MCP 客户端（现仅 tools）之上补齐 **resources** 与 **prompts** 两类能力，覆盖
**stdio 与 Streamable HTTP 两种传输**，并接到内核工具视图、bridge 路由与设置 GUI。

非目标：
- 不做 sampling（反向请求，需要模型回调宿主，与本仓库架构无关且无消费方）。
- 不做 resources/subscribe（变更订阅）—— 无长驻宿主消费变更通知（内核按会话 spawn）。
- 不改 `mcp.json` 的结构语义（仍只有既有的那些键）。

## 2. 现状（代码级核实，非采信文档）

| 事实 | 位置 |
|---|---|
| JSON-RPC 会话 `createJsonRpcSession`（pending/超时/abort/收尾语义单一真相源） | `kernel/mcp.mjs:210` |
| stdio 的 `tools()` | `kernel/mcp.mjs:397` |
| stdio 的 `call()` | `kernel/mcp.mjs:409` |
| HTTP 的 `tools()` | `kernel/mcp-http.mjs:230` |
| HTTP 的 `call()` | `kernel/mcp-http.mjs:244` |
| 工具命名 `mcp__<server>__<tool>` | `kernel/mcp.mjs:179` |
| `contentToText`（image 已省略） | `kernel/mcp.mjs:184` |
| 注册表：同步视图 + 异步预热、`entriesByKey`、`view({agentId})`、`snapshot()` | `kernel/mcp-tools.mjs` |
| 桥路由 `GET /mcp`、`PUT /mcp`、`POST /mcp/test`、`GET /mcp/status` | `server/mcp-routes.mjs` |
| GUI 纯函数（可 `node --test` 直测） | `src/components/settings/mcpFormat.ts` |

**关键观察**：`createJsonRpcSession` 已抽出共用，但 `tools()`/`call()` 仍是
**两个传输各一份**。这不是历史遗留的巧合，而是"抽了传输、没抽能力"的结果。

## 3. 决策

### D-1（首要）：抽「共用能力工厂」，消除即将出现的第三、四份重复

新增 `kernel/mcp-caps.mjs`：`createCapabilities(session, { name, onLog })` 返回

```
{ tools(), call(tool, args, opts), resources(), readResource(uri, opts), prompts(), getPrompt(name, args, opts) }
```

两个传输各自建好 session 后**只调用它**，不再自己写任何 `session.request('tools/…')`。

**为什么必须现在做**：本批要加 methods 共 5 个（`resources/list`、`resources/templates/list`、
`resources/read`、`prompts/list`、`prompts/get`）。照现状写法就是两份×5 = 10 处新重复，
且**重复的恰恰是最容易写错的部分**：截断阈值、blob 省略、错误文案、缓存语义。
本仓库已因同类问题付过代价（`kernel/guards.mjs` 的"双份守卫"：子 lane 曾因漏改而**没有错误熔断**，
一路空转到迭代上限；正是"两处维护、改一处忘另一处"）。故本批的验收含**反向断言**：
`mcp.mjs` / `mcp-http.mjs` 内不得再出现 `resources/` 或 `prompts/` 的 `session.request` 直调。

**改后既有 tools 行为与文案必须逐字不变**（含 description 拼接、错误文案、`isError` 判定）。

### D-2：resources 接入为**只读工具**（而非自动注入上下文）

每个启用的服务器固定暴露两个工具：

| 工具名 | 参数 | 说明 |
|---|---|---|
| `mcp__<server>__list_resources` | 无 | 合并 `resources/list` 与 `resources/templates/list`（模板标注为模板） |
| `mcp__<server>__read_resource` | `{ uri }` | `resources/read` 后转文本 |

**为什么是"工具"而不是"自动注入"**：MCP 规范把 resources 定为 *application-driven*
（由宿主决定何时读）。本仓库没有长驻宿主 GUI 去替模型决定——内核是 agent，工具视图就是它与
外界交互的唯一出口。让模型**按需拉取**既贴合规范意图（宿主=agent 自身），又避免"开个会话就把
服务器上所有资源塞进上下文"这种必然爆上下文的做法。
副作用是它与其他 MCP 工具一样走审批：`mcp-tools.mjs` 已把外部工具按"未知风险"处理
（`concurrencySafe: false`），**这正合适**——`resources/read` 能读到服务器端任意已暴露文件，
比普通工具更需要把关。spec 在此**明确其审批落档为既有 unknown 档**，不额外放宽。

### D-3：**有界**是 resources 的第一风险控制

- 单次读取上限 `MCP_RESOURCE_MAX_CHARS`（默认 **20000** 字符，可经参数覆盖）。
  超限 ⇒ 截断并**显式标注**：`[已截断：原始 N 字符，仅显示前 M 字符]`。
  模型必须知道"这不是全部"，否则会基于残文给出错误结论。
- **blob（二进制）资源只报元信息**：`[二进制资源已省略：<uri> mimeType=<t> <bytes> 字节]`。
  **绝不把 base64 塞进上下文** —— 一张 1MB 图片 base64 后 ≈1.37MB，直接挤爆上下文，
  而模型对 base64 也无能为力。这与既有 `contentToText` 对 `image` 的处理口径一致（沿用同一哲学）。
- `list_resources` 的清单本身也有界（默认最多 **200** 条，超出标注"还有 N 条未列出"）——
  服务器可能有上千资源，清单本身就能爆上下文。

阈值**参数化**（可经 opts 覆盖）并写进测试，而非散落魔法数。

### D-4：prompts **不进工具视图**，走"用户显式选择"

MCP 规范把 prompts 定为 *user-controlled*：它不是模型该自主决定的事，而是用户主动挑一个模板。
故：

- **不得**把 prompt 注册成模型可调用的工具。**反向断言**：`registry.view()` 的键里
  不得出现任何 prompt 名（这是本批最容易做错的一点——照着 tools 抄一遍就"能跑"，
  但语义全错，且会让模型在没有用户意图时乱套模板）。
- 经 bridge 暴露：
  - `GET /mcp/prompts`：列出各服务器 prompts（含参数声明）。
  - `POST /mcp/prompts/get`：`{ server, name, arguments }` ⇒ 渲染后的文本。
- GUI：设置面板提供入口，选中后把渲染结果**交给用户**（插入输入框），不自动发送。

**三态区分沿用 `mcp-routes.mjs` 既有约定**：400 = 用户数据不合规（磁盘/服务器都不动）；
500 = IO 失败；200 + ok:false = 正常业务结果（如"服务器连不上"、"prompt 不存在"）。

## 4. 契约（不变式）

1. 动态视图**必须同步**；`run()` 任何异常都不上抛（归一化为 `{content, isError:true}`）。
2. 故障隔离：单服务器失败只记 `failures`，不影响其它服务器与内核启动。
3. 未配置 MCP ⇒ 视图仍为空对象（**零行为变化**）；`enabled:false` 的服务器**不连接**。
4. `expose`（public/private/bound）过滤对新增的 resources 工具**同样生效**。
5. 不新增任何第三方依赖。
6. 既有 `kernel-tests/mcp.test.mjs` 16 用例与 tools 相关断言必须继续全绿。

## 5. 测试与验收

- 扩展 `kernel-tests/fixtures/mcp-stub-server.mjs`：支持 `resources/list`、
  `resources/templates/list`、`resources/read`、`prompts/list`、`prompts/get`，
  并内置**一个超大资源**（验证截断）与**一个 blob 资源**（验证省略）。
- 新增用例覆盖：
  1. 共用工厂：两传输（stdio + HTTP）走**同一实现**；反向断言无重复直调。
  2. `list_resources` / `read_resource` 的命名、可见性与 `expose` 过滤。
  3. 截断：超限资源被截断且**标注含原始长度**；未超限**不截断**（反向断言，防"一律截断"）。
  4. blob：**不得**出现 base64 片段（断言不含 `data:` / 长 base64 串），且含 uri/mimeType/字节数。
  5. 失败不抛：服务器不可用/uri 不存在 ⇒ `{content, isError:true}`。
  6. prompts **不入视图**（反向断言）。
  7. 桥路由：`GET /mcp/prompts`、`POST /mcp/prompts/get` 的三态区分。
  8. GUI 纯函数（`mcpFormat.ts` 或新增纯函数）的渲染/参数校验。
- 门禁（**分段跑，全量 npm test 会超时**）：`npm run typecheck`；`node --test kernel-tests/*.test.mjs`；
  `node --test "src/**/*.test.ts"`；`node --test "server/*.test.mjs"`。各自记录 pass/fail 计数。
- 守门演练（防假绿）：至少对"截断阈值"与"prompts 不进视图"各做一次**注入式演练**
  （临时改坏 ⇒ 断言变红 ⇒ 复原），证明断言真能抓住回归。

## 6. 已知边界（诚实登记）

1. **不做** `resources/subscribe` 与变更通知：内核按会话 spawn，无常驻订阅方。
2. **不做** OAuth：与上批一致（只支持静态头/环境变量）。
3. 本机若无可用的真实 MCP 服务器（含 resources/prompts），端到端只以 **stub 夹具**验证；
   真实第三方服务器的兼容性属**终验**事项，不写成"已验证"。
4. 超大资源的阈值是**保护性上限**而非"完整读取能力"——需要全量时用户应走别的通道。
5. `resources/read` 的审批落档沿用既有 unknown 档；**审批强度本身不在本批范围内**。
