# 任务：新增 transcript 统计聚合模块（为 /transcript/stats 端点提供数据）

这是 YFW-turbo 内核（Node ESM 净室项目）的完整仓库（含 server/ bridge 层）。spec（docs/superpowers/specs/2026-08-20-yfw-turbo-inner-core-design.md §6.5）规划了「按 对话/项目/模型 × 时间 统计 token 用量（成本/计费刚需）」，数据源是 transcript（JSONL 权威源），聚合逻辑收敛到 bridge 侧 `/transcript/stats` 端点。目前该能力尚未实现。

## 任务要求

### 1. 新建纯函数模块 `server/transcript-stats.mjs`

导出以下函数（必须可被独立 import 测试，无副作用、不依赖 bridge 运行时）：

- **`sanitizePathSegment(name)`**：与 `kernel/session.mjs` 的 `sanitizeSegment` **逐字符同算法**——每个非字母数字字符各自替换为一个 `-`，**不合并连续分隔符**（`/[\^a-zA-Z0-9]/g`，示例：`'C:\my proj/研发'` → `'C--my-proj---'`）；超 200 字符时截断前 200 字符并追加 md5 前 12 位 hex。
- **`aggregateTranscriptStats(entries, opts)`**：
  - 输入：`entries` 为多个会话的 transcript 条目数组（每条含 `{ type, ts, _project?, message? }`，跨会话条目拼接传入；`message.model` 为模型名，`message.usage` 含 `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`）。**不得**对输入做去重或截断——每条带 usage 的 assistant 条目都必须计入。
  - 提取每条 assistant 条目的 `message.usage`（`input_tokens` / `output_tokens`，含 `cache_read_input_tokens` / `cache_creation_input_tokens` 若存在，均并入输入侧）；
  - 按 **项目 / 模型 / 日期（YYYY-MM-DD）** 三个维度聚合：每个维度的桶结构固定为 `{ inputTokens, outputTokens, requests }`（`requests` 为计入条数，**不是** turns/sessions）。**每条带 usage 的 assistant 条目在三个维度都各自计入一次，不做任何去重**；
  - `opts` 支持 `{ modelPriceUsd?: { [model]: { input, output } } }`（$/1M token）时，额外计算 `totals.costUsd` 与各 `byModel` 桶 `costUsd`；未配置则 `costUsd` 为 `null`（字段名固定为 `costUsd`）；
  - 返回结构化结果：`{ byProject, byModel, byDate, totals }`，`totals: { inputTokens, outputTokens, costUsd }`。
  - 纯函数、确定性、O(n)。

> **契约示例（以下即验收测试的输入，期望输出必须严格一致，务必逐条对照）**：
> 输入 6 条条目（4 条带 usage 的 assistant + 2 条应被跳过的）：
> ① `{ type:'assistant', _project:'project-a', ts:'2026-08-19T10:00:00Z', message:{ model:'m1', usage:{ input_tokens:100, output_tokens:50 } } }`
> ② `{ type:'assistant', _project:'project-a', ts:'2026-08-19T11:00:00Z', message:{ model:'m1', usage:{ input_tokens:200, output_tokens:30 } } }`
> ③ `{ type:'assistant', _project:'project-a', ts:'2026-08-20T09:00:00Z', message:{ model:'m2', usage:{ input_tokens:400, output_tokens:100 } } }`
> ④ `{ type:'assistant', _project:'project-b', ts:'2026-08-20T10:00:00Z', message:{ model:'m1', usage:{ input_tokens:50, output_tokens:10 } } }`
> ⑤ `{ type:'assistant', _project:'project-a', ts:'2026-08-20T10:00:00Z', message:{ model:'m1' } }`（无 usage → 跳过）
> ⑥ `{ type:'user', _project:'project-a', ts:'2026-08-20T10:00:00Z', message:{ content:'hi' } }`（非 assistant → 跳过）
> 期望输出（注意：①与②是**同一项目同一模型的两条记录，必须都计入**，不得按 (项目,模型) 去重；⑤⑥不计数）：
> - `byProject`: `{ 'project-a': { inputTokens:700, outputTokens:180, requests:3 }, 'project-b': { inputTokens:50, outputTokens:10, requests:1 } }`
> - `byModel`: `{ 'm1': { inputTokens:350, outputTokens:90, requests:3 }, 'm2': { inputTokens:400, outputTokens:100, requests:1 } }`（m1 的 ① ② ④ 三条全计入）
> - `byDate`: `{ '2026-08-19': { inputTokens:300, outputTokens:80, requests:2 }, '2026-08-20': { inputTokens:450, outputTokens:110, requests:2 } }`
> - `totals`: `{ inputTokens:750, outputTokens:190, costUsd:null }`（未提供单价表时）

### 2. 在 `server/bridge.mjs` 注册 `/transcript/stats` 端点

在 bridge 的请求路由中加入 `/transcript/stats` 处理：扫描项目 transcript 目录 → 用上述聚合函数计算 → 返回统计（实现方式与现有路由一致即可，注意 bridge 是 WebSocket 消息路由，按现有模式注册即可）。此部分只做最小接入，核心评分在聚合函数。

## 验收标准

聚合函数必须正确处理：
1. 多个会话、多个模型、跨多天的 entries → 三维分组各条目次数与 token 正确；
2. 单条 assistant 无 `usage` 字段 → 不抛错，跳过该条统计；
3. `modelPriceUsd` 提供时 cost 正确；未提供时 `cost: null`；
4. 项目名含空格/中文/路径分隔符 → `sanitizePathSegment` 正确归一为安全段。

## 要求

- 遵循项目风格：ESM、无第三方依赖、确定性纯函数。
- 为聚合函数补充单元测试（如 `server/transcript-stats.test.mjs`），**必须**包含上方「契约示例」中 6 条输入与全部期望值断言（含①与②两条同项目同模型记录都计入 byModel 的断言），运行 `node --test server/transcript-stats.test.mjs server/kernel-engine.test.mjs` 确认全部通过——若你自行添加了任何去重/过滤语义导致示例断言失败，说明实现偏离契约，请修正实现而非修改示例断言。
- 不要改动无关文件（bridge.mjs 只允许最小接入改动）。
