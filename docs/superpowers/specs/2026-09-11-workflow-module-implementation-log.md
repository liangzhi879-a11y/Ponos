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
