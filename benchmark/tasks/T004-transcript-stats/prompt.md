# 任务：新增 transcript 统计聚合模块（为 /transcript/stats 端点提供数据）

这是 YFW-turbo 内核（Node ESM 净室项目）的完整仓库（含 server/ bridge 层）。spec（docs/superpowers/specs/2026-08-20-yfw-turbo-inner-core-design.md §6.5）规划了「按 对话/项目/模型 × 时间 统计 token 用量（成本/计费刚需）」，数据源是 transcript（JSONL 权威源），聚合逻辑收敛到 bridge 侧 `/transcript/stats` 端点。目前该能力尚未实现。

## 任务要求

### 1. 新建纯函数模块 `server/transcript-stats.mjs`

导出以下函数（必须可被独立 import 测试，无副作用、不依赖 bridge 运行时）：

- **`sanitizePathSegment(name)`**：与 `kernel/session.mjs` 的 `sanitizeSegment` 同算法——把路径/项目名转为安全目录段（非字母数字字符 → `-`）。
- **`aggregateTranscriptStats(entries, opts)`**：
  - 输入：`entries` 为多个会话的 transcript 条目数组（每条含 `{ type, ts, model?, message?, usage? }`，跨会话条目拼接传入，可含 `_sessionId` / `_project` 标记，或按 `sessionId` 分组传入的嵌套结构——自行定义合理输入形态并在 JSDoc 说明）；
  - 提取每条 assistant 条目的 `message.usage`（`input_tokens` / `output_tokens`，含 `cache_read_input_tokens` / `cache_creation_input_tokens` 若存在）；
  - 按 **项目 / 模型 / 日期（YYYY-MM-DD）** 三个维度聚合 token 用量与请求次数；
  - `opts` 支持 `{ modelPriceUsd?: { [model]: { input, output } } }`（$/1M token）时，额外计算 `total_cost_usd`；未配置则返回 `cost: null`；
  - 返回结构化结果（形如 `{ byProject: {...}, byModel: {...}, byDate: {...}, totals: { inputTokens, outputTokens, costUsd } }`）。
  - 纯函数、确定性、O(n)。

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
- 为聚合函数补充单元测试（如 `server/transcript-stats.test.mjs`），运行 `node --test server/transcript-stats.test.mjs server/kernel-engine.test.mjs` 确认全部通过。
- 不要改动无关文件（bridge.mjs 只允许最小接入改动）。
