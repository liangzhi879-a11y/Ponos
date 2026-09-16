# MCP 顶层面板与授权模型 —— 设计

- 日期：2026-09-16
- 状态：待实现
- 前置：`2026-09-16-mcp-client-design.md`（stdio 客户端）、`2026-09-16-mcp-http-transport-design.md`（Streamable HTTP 传输 + 配置 GUI）

## 1. 问题

MCP 配置界面已完成（能增删改服务器、能测试连通、HTTP 传输可用），但存在两个真实问题：

**① 入口藏在设置窗内。** `McpPanel` 只挂在 `SettingsView.tsx` 的 `section === 'mcp'` 分支下，不是与会话/任务同级的顶层视图，用户找不到。

**② 更实质：加完服务器，AI 其实还用不上，而界面显示"成功"。**
- `mcpRegistry` 在**内核启动时**创建（`kernel/cli.mjs:731`），`boot()` 只跑一次，`viewCache` 此后**永久缓存**（`kernel/mcp-tools.mjs:113`）
- ⇒ 内核运行期间通过界面添加的服务器，工具不会进入 AI 的工具表，**必须重启内核**
- 而卡片上的「✓ 3 个工具」来自**面板自己发起的探测**（`POST /mcp/test`），它只证明"这台服务器此刻连得上"，**完全不证明"内核已接入"**。两个不同的事实被界面呈现成一个，用户因此认为"添加成功却找不到调用入口"。

**③ 缺少授权控制。** 现有模型是"配了就全局可用"：没有开关，也不能只给某些 agent 用。带凭证的远程服务器一旦配好就对所有 agent（含各类子 agent）开放，粒度太粗。

## 2. 目标与非目标

**目标**
1. MCP 提升为与会话/任务同级的顶层标签（第 8 个 rail），设置窗不再保留入口。
2. 面板展示**内核真实接入状态**：已接入哪些服务器、各暴露了哪些工具（真实全名）、哪些失败及原因。
3. 配置比内核新时明确提示"将在下一条消息时自动生效"，不再让测试结果冒充"已可用"。
4. 每台服务器可：**关闭 / 仅测试 / 启用并按 public|bound 授权**；`bound` 可指定 agent 列表。

**非目标（YAGNI）**
- 不做面板内"手动调用工具"（需新增内核调用通路，另行立项）
- 不做 MCP resources / prompts / sampling（沿用既有决策）
- 不做热加载：不使用"运行时给运行中的内核塞新工具"，走既有的 respawn 路径（见 §5）
- 不做 OAuth 授权流程、不做自动重连（沿用既有决策）

## 3. 数据模型（`mcp.json` 向后兼容扩展）

新增两个**全部可选**的字段，缺省值保证存量配置行为不变：

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "enabled": true,
      "expose": { "mode": "public" }
    },
    "jira": {
      "url": "https://jira.example.com/mcp",
      "headers": { "Authorization": "Bearer ${JIRA_TOKEN}" },
      "enabled": true,
      "expose": { "mode": "bound", "bindAgents": ["researcher", "general-purpose"] }
    },
    "scratch": {
      "command": "npx", "args": ["-y", "some-experimental-server"],
      "enabled": true,
      "expose": { "mode": "private" }
    }
  }
}
```

**字段语义**

| 字段 | 取值 | 缺省 | 含义 |
|---|---|---|---|
| `enabled` | `true` / `false` | `true` | `false` ⇒ **根本不启动连接**（不 spawn 子进程、不发 HTTP 请求），AI 看不到 |
| `expose.mode` | `private` / `public` / `bound` | **`public`** | 见下 |
| `expose.bindAgents` | `string[]` | `[]` | 仅 `bound` 时有意义 |

**三档 = 关闭 / 仅测试 / 授权**，与用户确认一致：

| 界面档位 | 配置 | 内核行为 |
|---|---|---|
| 关闭 | `enabled:false` | 不连接 |
| **仅测试** | `enabled:true` + `expose.mode='private'` | 连接（面板可测试），但**不注册给任何 AI** |
| 授权 · 公开 | `enabled:true` + `expose.mode='public'` | 所有 agent 可用 |
| 授权 · 指定 | `enabled:true` + `expose.mode='bound'` | **仅** `bindAgents` 列出的 agent 可用；**主会话不可用** |

**两处刻意的语义选择（须写进注释与测试）**

1. **缺省 `mode` 是 `public`，不是 `private`** —— 这与工作流的缺省（`dyntools.mjs` 的 `visibilityOf` 缺省 `private`）**不一致**，是有意为之：存量 `mcp.json` 里没有任何 `expose` 字段，若缺省 `private` 则升级后所有 MCP 工具**突然消失**，用户会认为功能坏了。向后兼容优先。（用户已确认"存量默认开启+公开"。）
2. **`bound` 对主会话不可见** —— 与 `dyntools.visibilityOf` 现行语义一致（`!agentId` 时 `bound` 返回 `null`），不引入第二套规则。（用户已确认。）

**fail-closed**：`mode='bound'` 但 `bindAgents` 为空或全部无效时，**视为 `private`（无人可见）**，绝不退化成 `public`。权限判定必须向"更严"一侧失败。写侧校验（GUI/`normalizeMcpServers`）直接把这种组合判为非法并 400，让用户在保存时就知道，而不是保存后困惑"为什么没生效"。

## 4. 组件与职责

### 4.1 内核 `kernel/mcp.mjs`（配置模型）

- `loadMcpServers` / `normalizeMcpServers`：解析并归一化 `enabled` / `expose`
  - `enabled` 归一化：只有显式 `false` 才是关闭，其它（含缺省、`'false'` 字符串）**一律视为开启**——解析歧义不该悄悄关掉用户的服务器
  - `expose` 归一化：`mode` 不在三值内 → 判非法（**整份配置读取失败** `ok:false`，界面显示原因并禁用保存——与既有 `command`/`url` 校验失败同一处理，不新立规则）；`bindAgents` 只收非空字符串数组、去重保序、含空项则判非法
  - 强约束（既有测试已断言）：`writeMcpServers` 写出的必须能被 `loadMcpServers` 读回等价 —— 新增字段同样纳入该等值断言
- **新增 `mcpConfigSig(servers)`**：归一化后的**稳定序列化**（键排序）→ 短哈希。用途见 §5。**必须包含 `enabled`/`expose`**：授权变更同样需要触发内核重载。
- **新增 `mcpVisibilityOf(entry, agentId)`**：返回 `'public'` / `'bound'` / `null`（不可见）
  - `enabled===false` → `null`
  - `mode==='private'` → `null`
  - `mode==='public'` → `'public'`
  - `mode==='bound'` → `bindAgents.includes(agentId)` 时 `'bound'`，否则 `null`（`agentId` 为 null ⇒ `null`，即主会话不可见）

### 4.2 内核 `kernel/mcp-tools.mjs`（注册表）

- `boot()`：
  - 跳过 `enabled:false` 的服务器（记入 `disabled` 诊断，**不连接**）
  - 按服务器保存两份表：`toolsByServer: Map<name, {key,entry}[]>`、`visByServer: Map<name, 'public'|'bound'|null>`
  - 视图不再是一次性扁平缓存，而是**按 agentId 实时组装**（组装成本 = 少量对象展开，远低于每迭代调用它的既有开销）
- `view({ agentId })`：**保持同步、绝不阻塞**（既有契约，`toolSchemas` 直接调用）
  - 返回：可见服务器的工具合并对象
  - ⚠️ 保持既有签名兼容：无参调用等价于 `agentId = null`
- **新增 `snapshot()`**（面板用）：
  ```js
  { servers: { <name>: { tools: ['mcp__x__y', ...], expose: 'public'|'bound'|'private' } },
    failed: { <name>: '原因' }, disabled: ['<name>'], configSig: '<哈希>' }
  ```
  `tools` 列**该服务器实际发现的全部工具名**（不看可见性）——面板要能显示"台子上有什么"，可见性是另一维信息，由 `expose` 与服务端 agentId 决定展示。
- 既有 `toolNames()` / `failedServers()` 保留（诊断与既有测试依赖）

### 4.3 内核 `kernel/cli.mjs`（接线 + 上报）

- `withMcp`（`:738`）改为 `mcpRegistry.view({ agentId: args.agent || null })`
  - **复用同一个 agentId 来源**（`args.agent`，与 `:765/779/809/839` 的 `buildWorkflowTools` 等一致）⇒ 两处过滤口径必然一致，不会出现"工作流按 agent 过滤、MCP 不按"的分裂
- 启动后台任务：`mcpRegistry.ready()` 完成后 `wire.system('mcp_status', registry.snapshot())`
  - **不得阻塞主启动路径**：`ready()` 只是等待，不 `await` 在 init 流程里（MCP 服务器不可达时可能耗时数秒，绝不能拖慢内核启动或 `system(init)`）
  - 上报失败不影响内核（`try/catch` 吞掉，与既有 `wire.system('workflow', ...)` 同风格）

### 4.4 桥 `server/mcp-routes.mjs` + `server/bridge.mjs`

- **新增 `GET /mcp/status`**（`mcp-routes.mjs`）：
  - 入参：无（用路由上下文的 `configDir`）
  - 出参：`{ ok:true, config: { path, sig }, kernel: <快照|null>, stale: bool }`
  - `stale` = `kernel.configSig !== 当前文件 sig`（**这是"配置比内核新"的判定**，即"需生效"提示的依据）
  - 内核从未上报（本次运行还没发过消息）时 `kernel: null`，面板显示"内核尚未启动"
  - 读用 `readMcpServers`（绝不抛），与既有 `GET /mcp` 同纪律
  - **"报哪个会话的快照"这个歧义必须显式解决**：内核是**每会话一进程**，而面板是全局的。
    结论：返回**最近一次上报的快照**（更新即覆盖）。
    **为什么一个全局快照就够**：`snapshot().servers[].tools` 是"该服务器实际发现的全部工具"
    （§4.2，发现阶段**不做可见性过滤**），而所有内核读同一个 `mcp.json`、连同一批服务器
    ⇒ 各会话的**发现结果必然相同**。随 agent 变化的只是"谁看得见"，那是**配置维度**的信息
    （面板按配置档位展示），不是需要实时查询的运行时状态。故无须按会话聚合、也无须让用户选会话。
- `bridge.mjs`：
  - 缓存内核上报：收到 `system` 事件 `subtype==='mcp_status'` 时按会话存最近一份（`Map<sid, snapshot>`）
  - **新增 `_spawnMcpSig` 签名比对**，与 `_spawnEnvSig`（provider/model）、`_spawnKnowledgeSig`（知识范围）**完全同一条路径**：
    - 发消息时计算当前文件签名，与 spawn 时冻结的签名不一致 ⇒ `_reaped = true` → `taskkill` 旧内核 → 以 `--resume` 重新 spawn（不丢上下文）
    - 签名一致 ⇒ 零动作（绝大多数轮次走这条）
  - 生效时机因此是"**保存配置后的下一条消息**"，与既有"改关联后下一句生效""切模型后下一句生效"行为一致

### 4.5 前端

**导航（3 处必须同时改，`viewStore.ts` 已明确警告）**
- `viewStore.ts`：`RailId` 联合类型加 `'mcp'`；`RAIL_IDS` 数组加 `'mcp'`（只改一处 ⇒ 落盘值被 `sanitizeRail` 静默清成 `'task'`，表现为"选中后刷新弹回任务"）
- `railMeta.ts`：追加 `{ id: 'mcp', icon: Plug, labelKey: 'rail.mcp' }`
  - `Plug` 现仅被设置窗占用（该 section 即将删除）⇒ 迁移复用为 rail 图标，**不新增图标占用**，符合项目图标唯一性审计
- i18n：`rail.mcp` = MCP 服务 / MCP Servers

**`WorkShell.tsx`**：加 `rail === 'mcp'` 分支 → `McpView`

**新目录 `src/components/mcp/`**
- `McpView.tsx`（新）：组装三块
  1. **内核状态条**（全局真值，来自 `GET /mcp/status`）
     - `✓ 内核已接入 2 个服务器 · 6 个工具`
     - `⚠ 配置已更新，将在你发送下一条消息时自动生效`（`stale`）
     - `✗ jira 启动失败：连接被拒绝（目标端口没有服务在监听）`（`failed`）
     - 内核未上报：`内核尚未启动（发送一条消息后生效）`
  2. **服务器卡片列表**（配置管理 + 授权控制）
  3. **工具清单**（按服务器分组，展示**真实全名** `mcp__filesystem__read_file`，并标注该服务器授权范围）
- `McpConfigEditor.tsx`：由现 `McpPanel.tsx` 拆分而来（表单 + 增删 + 连接测试 + 保存），**授权控件内联在每张卡片上**
  - 现文件 665 行、职责已偏多（配置 IO + 校验 + 表单 + 授权 + 状态），拆出视图层是本次改动的合理组成部分
- 迁移 `mcpFormat.ts` / `mcpFormat.test.ts`（纯逻辑，已有 16 条测试）

**`SettingsView.tsx`**：删除 `mcp` section（含 `Plug` 导入）与对应 i18n 键；如需保留可发现性，放一句引导文字（"MCP 已在左侧 MCP 服务标签中管理"）

**授权控件（每卡片）**：三态分段控件 + `bound` 时展开 agent 多选
- 档位切换即改本地 state，**保存后才落盘**（与现有表单一致）
- `bound` 但未选 agent ⇒ 校验报错、禁用保存（fail-closed 的界面侧对应）
- agent 列表来源：`src/lib/agentsApi.ts` 的 `GET /agents`（agent 管理页同源）。注意其口径是**完整目录 + `disabled` 标记**，故多选里应展示全部（可含已停用）并标出状态——与 agent 管理页一致，避免"面板里选不到的 agent"。若用户绑定了已停用 agent，该工具即无人可用（fail-closed），面板需明示

**状态同步（沿用既有模式，不轮询）**
本应用已有固定套路：hook 收内核事件 → 写入 zustand store → 面板读 store
（`useYFWCLI.ts:1005` 处理 `system/init` → `useHealthStore` / `useWarningStore`）。`mcp_status` 走同一条：
- `useYFWCLI.ts`：`type==='system' && event.subtype==='mcp_status'` → `useMcpStore.getState().setKernelStatus(sid, snapshot)`
- 新 `src/stores/mcpStore.ts`：存内核上报（会话维度，与其他 store 同构）、存 `GET /mcp/status` 拉到的 `{config, kernel, stale}`、存"上次拉取时间"
- `McpView` 挂载时做**一次** `GET /mcp/status`（拿到"内核在面板打开前已上报"的缓存值），此后靠事件推送更新；提供手动刷新按钮
- 理由：轮询是"定期问"、事件是"有事才说"。后端本来就会推，轮询既多余又会在用户没做任何事时反复发请求

## 5. 数据流：配置变更如何生效

```
面板保存 → PUT /mcp 落盘（签名变化）
   ↓ 用户发下一条消息
bridge: mcpConfigSig(当前文件) !== s._spawnMcpSig ?
   ↓ 是（既有 _spawnEnvSig 同路径）
taskkill 旧内核 → spawn 新内核（--resume 续上下文）
   ↓ 新内核 boot(): 读配置 → 跳过 enabled:false → 连接 → 发现工具 → 记录 visByServer
   ↓ ready() 完成
wire.system('mcp_status', snapshot())
   ↓
bridge 缓存 snapshot → GET /mcp/status → 面板显示真实工具清单，stale 转 false
```

**为什么不做热加载**：注册表在启动段构建一次，工具表被 `createToolsViewCache` 缓存（`cli.mjs:763`）。运行中注入新工具要动缓存与视图两层，而 respawn 路径**已经存在、已被两条既有特性验证过**（provider/model、知识范围），且 `--resume` 保证上下文不丢。用现成机制胜于新增一层热更新（少一条会静默失效的链路）。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| `enabled:false` | 不连接、不报错，面板显示"已关闭" |
| 服务器连不上 | 记入 `failed`，其余服务器不受影响（既有 Promise.allSettled 隔离语义不变） |
| 配置解析失败 | 内核记 warning 并跳过（既有行为）；桥 `GET /mcp/status` 返回 `ok:false`；面板提示且**禁用保存**（已实现） |
| `${ENV_VAR}` 未定义 | 连接失败并点名变量（既有 `interpolateEnv` 行为） |
| `bound` 未指定 agent | 写侧 400（保存时即报错）；读侧 fail-closed 视为不可见 |
| 内核从未上报 | `kernel:null`，面板显示"内核尚未启动"，**不谎称"已接入 0 个"** |
| 上报到达时面板未打开 | 挂载时拉一次 `GET /mcp/status` 取回桥缓存的最近一份（事件已错过，但缓存在桥侧） |

## 7. 测试策略

**内核（纯函数优先，`kernel-tests/`）**
- `mcpVisibilityOf`：三档 × agentId 组合（含 `agentId=null`、`bindAgents` 空、名字不匹配）——重点锁 **bound 对主会话不可见** 与 **fail-closed**
- `loadMcpServers` / `normalizeMcpServers`：`enabled`/`expose` 往返等值（写→读回等价）；`enabled` 只认显式 `false`；`bound` 空列表判非法
- `mcpConfigSig`：内容相同（键序不同）⇒ 同签名；改动 `enabled`/`expose`/`args` ⇒ 签名变化
- `createMcpRegistry`：注入假配置路径
  - `enabled:false` ⇒ **不 spawn**（断言子进程未被启动）且 `snapshot().disabled` 含它
  - `view({agentId})` 按可见性过滤；`view()` 无参等价 `agentId=null`
  - `snapshot()` 形状（含"实际发现的全部工具"与可见性无关）

**桥（`server` 测试，不起内核）**
- `GET /mcp/status`：内核未上报 ⇒ `kernel:null`；上报后 ⇒ 原样返回且 `stale` 计算正确（配置改一格 ⇒ `stale:true`）
- `handleMcpRoute` 未匹配路径仍返回 `null`（不吞别的路由）

**前端（`src` 测试，纯函数/组件无 DOM）**
- 迁移既有 16 条 `mcpFormat` 测试
- 新增：授权档位 → 配置对象互转（三档往返）；`bound` 无 agent ⇒ 校验失败并禁用保存
- 新增 `mcpStore`：`setKernelStatus` 按会话写入；`stale` 由 `config.sig !== kernel.configSig` 推出；内核未上报时为 `null`（断言"不谎称已接入 0 个"）
- 沿用既有静态守卫（`hooksDeps.test.ts` 禁 `t` 进依赖数组）

**门禁**：typecheck + 内核/server/src 三套全量 + 构建 + `release/YFWorking/dist` 同步。

## 8. 风险

| 风险 | 应对 |
|---|---|
| 改 `RailId` 只改一处 ⇒ 静默回退 task | 两处同改 + 手工验证"加 rail 后落盘仍正常"（`viewCache`/`sanitizeRail` 是已知静默失效点） |
| respawn 触发过频导致体验差 | 签名基于**归一化内容**，纯空白差异不触发；且只在发消息时比对 |
| `view()` 由扁平缓存改为实时组装，可能影响每迭代性能 | 组装只是少量对象展开；内核测试加"多次调用结果稳定"断言；如需可加按 agentId 的组装缓存（仅当实测有影响） |
| agent 列表 API 与 agents 页不同源 ⇒ 选了不存在的 agent | 复用同源 API；`bound` 指向不存在 agent ⇒ 该工具无人可见（fail-closed），面板明示 |
| 665 行 `McpPanel` 拆分引入回归 | 拆分以"搬家 + 授权控件"为限，不动既有交互逻辑；既有 16 条测试随迁作为回归网 |

## 9. 验收标准

1. 左侧出现与会话/任务同级的 **MCP 服务** 标签，点击进入面板；设置窗不再有 MCP 入口
2. 选择该标签后**刷新应用仍停留在该标签**（证明 `RAIL_IDS` 两处已同改）
3. 面板顶部显示**内核真实接入**：服务器数、工具数与**真实全名清单**（`mcp__<服务器>__<工具>`）
4. 新增服务器并保存后，顶部出现 `⚠ 配置已更新，将在你发送下一条消息时自动生效`；**发送一条消息后**该提示消失、工具清单出现新工具
5. 把某台设为 **仅测试**：保存并发一条消息后，其工具**从内核工具清单消失**，但卡片上的"连接测试"仍可用
6. 把某台设为**公开**：工具重新出现在清单
7. 把某台设为**指定 agent**（只勾一个子 agent）：主会话工具清单里**看不到**它；以该 agent 运行时可看到
8. 关闭某台：保存并发消息后，其工具消失，且**不产生该服务器的连接**（无子进程/无网络请求）
9. 存量配置（无 `enabled`/`expose`）升级后**行为不变**，仍为开启 + 公开
