## 实现记录（2026-09-11）

本节在原设计之后追加，记录实际落地结果（设计文档保持原样，偏差在此说明）。

### 规模

- 提交 33 个（`b2982e1` 预审修复 → `8a69962`），55 文件、+10350/−1156 行。
- 两份计划：内核 8 任务（`2026-09-11-workflow-module-kernel.md`）、宿主+GUI 6 任务（`2026-09-11-workflow-module-ui.md`）。
- 流程：每任务「实现 → 独立审查 → 返工（如需要）→ 定向复审」+ 计划终审（whole-branch review）；共 10 个返工轮，**0 个任务以未解决 Critical/Important 收尾**。

### 实际改动文件（按层）

| 层 | 文件 |
|---|---|
| 内核（新增） | `kernel/workflow-dsl.mjs`、`workflow-dag.mjs`、`workflow-nodes.mjs`、`workflow-engine.mjs`、`dyntools.mjs` |
| 内核（改） | `kernel/workflow.mjs`（1037 行 → 26 行 re-export 层）、`cli.mjs`、`tools.mjs`、`agents.mjs`、`tui.mjs` |
| 桥接/宿主（新增） | `server/workflow-store.mjs`、`workflow-host.mjs`、`workflow-routes.mjs`、`workflow-install.mjs`、`workflow-events.mjs` |
| 桥接（改） | `server/bridge.mjs`（挂载 `/workflows` 路由 + 事件转发） |
| 前端（新增） | `src/lib/workflowModel.ts`、`workflowApi.ts`、`src/components/workflows/**`（列表/画布/节点面板/配置面板/运行抽屉/授权卡） |
| 前端（改） | `src/stores/viewStore.ts`、`src/components/layout/{railMeta,WorkShell}.tsx`、`src/lib/agents.ts`、`src/types/index.ts`、i18n |
| 其他 | `electron/main.cjs`（agent frontmatter 补 `workflows`）、`workflows/spec-dev/workflow.yml`（重写为显式 DAG）、`package.json`（+`@xyflow/react`）、`docs/bridge-contract.md` |

### 验收结果（自动化部分，全部实测）

| 项 | 结果 |
|---|---|
| `kernel-tests/workflow-*.test.mjs`（11 文件） | **86 pass / 0 fail** |
| `server/*.test.mjs`（全量） | **193 pass / 0 fail** |
| `src/lib/workflowModel.test.ts` / `viewStore.test.ts` | 9 pass + 2 pass / 0 fail |
| `npx tsc --noEmit` | ✅ |
| `npm run build` | ✅（15s） |
| `node scripts/build-kernel.mjs` | ✅ 打包成功（内核零外部依赖约束保持） |

端到端探针（控制者实跑）另验证：`trigger_config` 双路径触发读取、输出合成兜底、private 工作流经通用 `Workflow` 工具被拒且审计零新增、spec-dev `expose`/triggers 解析、迁移落盘含备份、grant 命中/拒绝三态。

### 计划外修复（审查发现，均已修 + 回归）

1. **`agent` 节点内嵌工具循环未透传 grant → 授权清单可被绕过**（`b1e51d3`）：只有 Bash 因无审批通道被拒，Read/Write/WebFetch 等全部放行，与"未授权 fail-closed"矛盾。已透传 + 补回归测试。
2. **内置工作流在老用户机上永远 `LEGACY_DSL`**（`4a9b5a6`）：旧版桥把工作流装在技能根，而根顺序是技能根优先 → legacy 副本遮蔽新装 v2。已加 `legacyRoots` 处理（备份后移除）。
3. **`spec-dev` 版本未升导致升级 no-op**（`4a9b5a6`）：按 version 比对对自身失效 → 补内容指纹兜底。
4. **`trigger_config` 只有写者没有读者**（`735edca`）：`schedule`/`auto_trigger` 从顶层迁走后再无人读 → 定时/自动触发静默失效。已双路径兼容。
5. **`finalOutput` 兜底恒为 `{result:{}}`**（`735edca`）：兜底取"最后成功节点"时恒命中 `end` 自身。已排除终端节点。
6. **通用 `Workflow` 工具无可见性闸门**（`735edca`）：private 工作流可被模型执行。已加闸门。
7. **宿主错误配对误杀在途 run**（`6dd8f6c`）：无 requestId 的 error 会 reject 全部 pending。已改为只结清最近一条，并在内核侧根治（error 回执补 `requestId`）。
8. **宿主 runId 与内核 runId 分叉**（`6dd8f6c`）：`stop`/`confirm` 打不到真实运行。内核已转发 `payload.runId`。

### 未完成 / 延后项及原因

| 项 | 原因 |
|---|---|
| **GUI 交互需人工验收** | 画布拖拽/连线/变量选择器/事件着色/授权卡勾除/抽屉切换等属交互，无法自动化断言；自动化只能覆盖纯逻辑层与 HTTP/事件契约 |
| 旧文件迁移：`end.outputs` 对象形态、`document.path`/`classify.routes` 旧键回显 | Task 13 复审 Minor；影响面小（内核本就会报错），未纳入本轮 |
| `openRunSetup` 的 ≤300ms 窗口 | 画布节流未触发时 `dirty===false` → 只 flush 不落盘；窗口极窄（<300ms），未纳入本轮 |
| `publicLimit` 无设置项数据源 | 缺"公开工作流上限"的设置 UI；当前固定缺省 20 |
| `/wf list` 未按可见性 + legacy 过滤 | 仅影响 CLI 视角的清单，模型侧已按可见性过滤 |
| 部分内核键 UI 不可编辑 | `if.logical_operator`、`code.variables`、`http.retry`、`extract.model` 等；属功能缺口而非口径漂移（UI 写出的键内核都认） |
| `cancelledRuns` 无清理、`stepsLimit` 早退位置等引擎 Minor | 触发条件极窄，不影响正确性 |
| 仓库卫生 | 审查过程留下的 `.tmp-*/`、`nul`、`.yfw-harness/` 等未跟踪残留不在本模块提交内，需另行清理 |

### 与设计的偏差

1. **`server/` 不 import `kernel/*`**：设计时未预见生产包只带 `kernel-dist/cli.mjs` 单文件 bundle（`electron-builder.yml` 的 files 不含 `kernel/**`）。因此 DSL 解析/校验/序列化一律经宿主会话（内核），bridge 侧只做轻量正则元数据。
2. **路由与安装器为独立模块**（`workflow-routes.mjs`/`workflow-install.mjs`/`workflow-events.mjs`）：bridge.mjs 顶层会 `listen(51517)` 且其 EADDRINUSE 自愈逻辑会 taskkill 用户进程，测试不能 import 它。
3. **`save`/`save-raw` 由内核序列化 + 校验并回传 yml，落盘仍在 bridge 侧**：单一写者原则；内核唯一写盘点是显式 `migrate`。

### 调试期缺陷修复（2026-09-12，人工测试阶段发现）

用户实测报告："创建无任何响应，只有输入工作流名及导入，没有创建面板"。系统化调试定位到**三个此前自动化测试与逐任务审查都未覆盖的真实缺陷**：

| # | 现象 | 根因 | 证据 | 修复 |
|---|---|---|---|---|
| 1 | 创建/保存/运行**永久无响应**（界面零反馈） | 宿主会话 `_wfhost` 以**不存在的 cwd** `<YFW_HOME>/workflow-runtime` spawn → Windows 报 ENOENT（退出码 -4058）、存活约 250ms 即退；bridge 反复重启宿主，命令写进死进程后**静默挂到超时**（默认 120s、run 30min） | 日志：`spawn: _wfhost (new) C:\...\.yfw\workflow-runtime` 紧接 `kernel exited abnormal code=-4058 (sid _wfhost) after 255ms`（连续 3 次）；`GET /workflows`（纯 fs）200 正常而 `POST /workflows` curl 20s 无响应；手工 `mkdir` 该目录后同请求**立即 200** | `116e2d6`：`ensure()` 先 `mkdirSync(cwd,{recursive:true})` 再 spawn；新增 `onKernelExit()`——bridge 在内核退出时**立即**把在途命令判失败（不再静默挂 120s） |
| 2 | 运行抽屉「校验完整性」恒失败 | `GET /workflows/verify` **路由从未实现**（内核 `subtype:'verify'` 早已就绪） | 对运行中的应用实测 → 404 | `6a56d93`：补路由 + `path` 必须落在 `runsRoot` 内（否则成为任意文件探测器）+ 「路由覆盖守卫测试」 |
| 3 | 绑定写入潜在 405 | `setBindings()` 用 POST，而路由只收 GET/PUT（`setWorkflowTrusted` 走 PUT 故未暴露） | 路由方法白名单实测 405 | `f9445b3`：改用 PUT |

**流程教训（已固化为守卫）**：Task 12/14 的"URL 全对齐"核验只做了**计划文本与路由的文字对照**，未把前端每条调用真正打到路由函数上——两个缺陷由此漏过（守卫测试若当时存在会立刻变红）。现已在 `server/workflow-api.test.mjs` 增加 `路由覆盖守卫`：18 条前端调用逐一打到真实路由，任一 404 即失败（破坏性调用排最后，避免自造误报）。

**同时确认的健壮性缺口**：宿主会话是**共享单例**，`HOST_SID` 冲突会静默复用（cosmetic）；`kernel/workflow-dag.mjs` 等模块级可变状态（`setNodeDeps` 已移除）等既往 Minor 项不受影响。

### 调试期缺陷修复（2026-09-12 第二轮，浏览器端到端回归发现）

用户实测补充："创建/保存/运行点了长时间无响应"、**"无法测试，目前没有跑通过"**。本轮改用**真机 UI 回归**（隔离全栈：bridge 51999 + vite 5397 + 最小 Electron 壳 + CDP 脚本化驱动，见 §验证方法），定位到**六个根因**（前三个是"整片 fetch 失败/列表空白"级别）：

| # | 现象 | 根因 | 证据 | 修复 |
|---|---|---|---|---|
| 1 | 「信任清单无法写入」，整片 `Failed to fetch` | `bridge.mjs` 的 `OPTIONS` 预检只回 `GET, POST, OPTIONS`；而保存（`PUT /workflows/:id`）、信任清单（`PUT /workflows/bindings`）、删除（`DELETE`）都是带 `application/json` 的**非简单请求**，预检未声明该方法 → **真实请求根本不发出** | 对运行中应用发 `OPTIONS` 实测响应头；curl 与直调路由的单测**都不走预检**，故 52 项自动化全绿仍漏 | 白名单补 `PUT, PATCH, DELETE, OPTIONS`；`auth-preflight.test.mjs` 加预检契约 + 真实 `PUT` 后校验 `_bindings.json` 落盘 |
| 2 | 创建/保存/运行偶发无响应 | `reapIdleKernels()` 把**常驻宿主 `_wfhost` 当普通会话回收**（宿主不发 `assistant/result`，`_turnActive` 恒 false，"空闲"是常态）；且旧判定 `s._lastOutAt > 0 && …` 在 `_lastOutAt===0`（刚 spawn）时短路为 false，**直接落进回收分支**，冷启动窗口内秒杀 | `/workflows/verify` 偶发「工作流宿主会话已退出」、第二次请求即正常 | 宿主跳过空闲回收；未产出 stdout 的会话按"启动中"豁免；`send()` 对幂等子命令（load/validate/save-raw/list/verify/migrate）在宿主消失时**重建宿主并重试一次**（`run` 不重试）；`ensure()` 清理残留死条目 |
| 3 | **列表恒显「暂无工作流」**、授权卡「读取信任清单失败：**undefined**」、历史恒空 | 客户端 `call()` 判定含「`body.ok === false` → 失败」，消费方一律 `if (!r.ok)`；而 store 的**纯数据回执没有 ok 字段**（`{workflows,root}` / `{agents,trusted}` / `{runs}`）→ **成功被当失败** | 真机 UI 实测；单测只断言 `body.runs`/`body.trusted`，**从不看 `ok`**，故照不出来 | 路由层 `json()` 助手统一补 `ok:true`（已有 ok 的内核/宿主回执不覆盖）；新增「ok 契约守卫」测试枚举全部 17 条路由断言 **2xx 必带 ok** |
| 4 | 运行完 `finalOutput: {}`，用户判定为"没跑通" | 内核作用域是 `{inputs, var, <nodeId>: <该节点 output>}`——**节点 id 直接就是输出值**。故 `{{t.output}}` 在输出为标量时解析成 `undefined`，`JSON.stringify` 把该键**整条丢掉**；而画布原提示恰写「{{节点.字段}}」，**诱导**用户写错 | 对照实验：`{{t}}` → `"hello world"` ✅、`{{t.output}}` → 丢键 ❌、`{{inputs.who}}` → `"world"` ✅ | `end` 与 `synthesizeOutput` **保留键并置 `null`** + 收集 `unresolved` 透传到回执/`end` 事件；GUI 三处展示该告警；selector 文案纠正为「写 `{{节点}}` 取整输出 / `{{节点.字段}}` 仅当输出是对象」 |
| 5 | 运行抽屉永远停在「等待事件…」 | `POST /workflows/run` **同步等待内核跑完才回执**（含完整结果），但前端返回类型只声明 `{runId}`、只取 `runId`，其余全靠 WS 事件流——丢事件即无输出 | 路由与宿主回执实测 | `runWorkflow` 返回类型扩为 `RunResult`；`startRun` 把回执**合成 node/end 事件**补进运行视图（已是终态则不覆盖） |
| 6 | **打开画布整页白屏**：`(t.triggers \|\| []).join is not a function` | `toModel`（编辑器模型）对顶层 `triggers` **原样透传**，而 `discoverWorkflows`（列表）会归一 → YAML 写裸逗号标量（内置 spec-dev 即如此）时两条路径形状不一致：列表数组、编辑器**字符串**。保存路径 `model.triggers.map` 同样会抛 | `GET /workflows/spec-dev` 实测 `model.triggers` 为 `"spec 开发, spec-dev, …"`（string） | 内核新增 `normalizeTriggers` 单一归一器，三处共用（`normalizeWorkflow` 加载收口 / `toModel` / `serializeWorkflow`）；前端 `asTriggerList` 再兜一层防白屏；两侧加形状契约测试 |

**方法论（本轮最大收获）**：前三个根因**共同的逃逸原因**是"测试不经过真实调用路径"——预检测试不走浏览器、单测直调路由函数、单测只断言字段不看判定键。故新增守卫的核心不是"再写一个测试"，而是**让测试走真实路径**（真机 origin 的预检、枚举全部路由的 ok 契约、把前端每条调用真正打到路由）。真机 UI 回归方法已固化：隔离 bridge（独立端口 + 独立 `YFWORKING_HOME`）+ vite（带 `YFW_BRIDGE_PORT`）+ 最小 Electron 壳（`remote-debugging-port` + 独立 userData）+ CDP 脚本（`ws` 驱动 `Runtime.evaluate`/`Page.captureScreenshot`）。

**本轮同时交付的 UX（用户明确要求）**：元素删除＝框选多选 + 一律二次确认（`describeRemoval` 摊开影响面：连带边/子图成员/他处悬空引用逐条列出）+ 右键菜单（节点/连线/空白三态）+ 删除撤销（快照栈 50 + Ctrl/Cmd+Z，输入框内不接管）；开始/结束＝内联编辑输入参数与返回值 + 变量选择器（仅上游可达）+ 可达性/写法校验（`describeDataFlow`/`detectRefPitfall`）+ 运行前授权卡同时展示输入与"运行结束后返回的键"。

**与 Dify 对照后的已知差异**（未做，待定）：①输出变量无**类型标注**（Dify 支持 string/number/object/array，用作工具返回 schema）；②Dify 禁止多个 Output 节点输出名重复（UI 报 `Output name already exists`），本内核允许多个 `end` 且**同名静默覆盖**，建议在 GUI 校验层禁掉。

**验证**：`kernel-tests/workflow*.test.mjs` 88/88 · `server/*.test.mjs` 236/236 · 前端 `src/lib/*.test.ts` 106/106 · `tsc --noEmit` ✅ · 构建 ✅ · 真机 UI 实测：新建→画布、右键删除→二次确认→撤销恢复、保存（PUT+CORS 实证）、列表 5 条、授权卡、运行 `已完成 2 步` 且输出键保留为 `null`、渲染器 **0 个 fetch 错误**。
