# 审计：每模型上下文窗口 + 切换模型续跑（2026-09-10）

## 问题

压缩机制对"切换模型继续任务"没有有效应对：会话历史按旧模型（云端大窗口
1M/200K）积累后切到本地小窗口模型（vLLM Qwen 32K-180K），上下文必然超新窗口。
三层症状：

1. **窗口分辨率缺失**：`MODEL_CONTEXT_WINDOWS` 只有 2 个硬编码云端模型，其余一律
   回落 200K——本地小窗口模型按 200K 规划，主动压缩永不触发，每轮撞 400。
2. **压缩自身装不下**：即使强制压缩，covered 远超摘要请求容量（limit − 输出预算 −
   余量），A4 限幅最多翻倍保留预算 4 次仍装不下 → 摘要请求自身 400 → 熔断 →
   压缩永不落地 → 每轮"400 → forceCompact → 失败"打转。
3. **调用时不按窗口配预算**：`max_tokens` 默认 64K（本地画像 16K），小窗口模型
   input + max_tokens 恒超窗，阈值解析对"预算占满窗口"退化回纯比例，拦不住必 400
   的请求。大文件读取（Read 内联 ≤2MB/2000 行）按固定 20K 字符预算裁剪，与窗口
   无关——32K 窗口下单条结果可吃掉半个窗口。

## 参考实现研究（C:\Users\T203-15\agents 源码）

| 机制 | Claude Code | pi | Codex |
|---|---|---|---|
| 每模型窗口 | 动态 modelCapabilities 缓存 + `[1m]` 后缀 + env 覆盖，回落 200K | models.dev 目录 `Model.contextWindow`；自建 provider 默认 128K；llama.cpp 运行时读 n_ctx | 服务端 /models 动态下发 context_window/max_context_window/auto_compact_token_limit(90%)/effective(95%)；未知模型回落 272K |
| 压缩触发 | 固定 token 缓冲（13K），有效窗口 = 窗口 − min(输出,20K) | `contextTokens > window − reserveTokens`（16K 保留） | 阈值 + 三选一策略（TokenBudget 换窗 / 服务端 v2 / 本地 Memento 摘要） |
| 切换模型 | **无专项子系统**——阈值每轮按当前模型重算；`[1m]` 后缀跨 skill override 保留 | 仅记录 model_change 条目，按新模型窗口计；旧模型溢出错误不触发新模型压缩 | **ModelDownshift**：切小窗口且新限已超 → 用旧模型压缩后再切 |
| 超限兜底 | PTL 重试丢弃最旧分组直至装下（≤3 次） | 溢出检测（~25 个 provider 正则 + usage 静默溢出）→ 压缩一次 → 重试一次 | 压缩请求内 ContextWindowExceeded → 删最旧条目重试（滑窗兜底） |
| 调用时预算 | maxOutput ≤ min(20K, 模型上限) | **clampMaxTokensToContext**：`window − estInput − 4096`，下限 1 | effective 95% 预留 headroom |
| 大结果 | microCompact 清可重放结果 + POST_COMPACT 重注入预算 50K | 读 2000 行/50KB，bash tail，输出可落盘 stub | **记录时截断**（truncation policy tokens/bytes）；v2 前 newest-first 替换超窗结果直至装下 |

## 设计决策

**D1 分辨率链**（context.mjs）：注入窗口（bridge 下发的 provider.contextWindow）
→ 内置模型表 → 画像默认。新增 `PONOS_PROVIDER_PROFILE`（bridge 经 provider-profile
注入）——local 未命中表回落 **64K 保守默认**（偏小不偏大：低估只多压几次，高估让
小窗口模型反复 400 且 400 学习只下调无法自愈）；cloud 维持 200K。一手来源仍是探测
（vLLM /v1/models 的 max_model_len → provider.contextWindow 持久化），表/默认只兜底
探测不可用场景。

**D2 分块摘要（阶段②b，map-reduce）**：covered > 单块容量（limit − 输出预算 − 4096）
时按 turn 边界切成每块 ≤ 容量的段落，逐块滚动合并——前块摘要作 `<compacted-summary>`
前缀注入下一块请求，末块注入 keyInfo/会话记忆。单块容量装得下时走原单发路径
（A4 限幅语义零改动）。切块纪律与切点纪律一致：新块永远从真实 user turn 起点开始，
tool_use/tool_result 配对不拆；单条超预算消息自成一块（不撕裂消息链，超限由 400
自愈兜底）。小窗口摘要输出预算同时按比例收窄（min(maxTokens, 16K, limit×0.25)）——
vLLM 按 input+max_tokens 对 max_model_len 校验，大输出预算会让摘要请求自身 400。

**D3 调用时预算钳制**（engine preStep，pi clampMaxTokensToContext 语义）：每次模型
调用前 `attemptMaxTokens = min(budget, window − estInput − 2048)`（下限 1024）——
窗口在每次调用时生效，input+max_tokens 恒 ≤ 窗口。仍装不下时正常发请求：400 是
免费的真实窗口来源（adoptWindow 学习），自愈路径已有。钳制事件
`output_budget_clamped` 上行可观测。

**D4 免费收缩共用**：老化清除 + 结构裁剪抽取为 `freeShrink`，maybeCompact（阈值触发）
与 forceCompact（溢出兜底）共用——小窗口切换后的溢出路径先零成本收缩再摘要，covered
最小化、分块段数最少。裁剪预算窗口感知：`clamp(window/8, 4K, 24K)` 字符（32K 窗口 →
4K/条，1M 窗口 → 24K 封顶），env 显式值仍优先。

**D5 切换重定向**：`switch_provider` 热切路径设 `context.window` 后上行
`context_window_retargeted` 事件（TUI 提示）；GUI 切换经 bridge env 签名收割重 spawn
（既有机制），新进程按 D1 解析窗口，首轮 preStep 触发阈值压缩（分块落地）。GUI 新建
provider 的 contextWindow 默认 1000000 → **0 = 自动**（探测回填；探测不到按表/画像
默认）——虚高默认是本地模型撑爆的根因之一；探测回填条件同步把 0 视为空位。

## 变更地图

- `kernel/context.mjs`：`LOCAL_DEFAULT_WINDOW`、`MiniMax-M3` 表项、画像感知
  `contextWindowFor`、`clampOutputBudgetForWindow`
- `kernel/compact.mjs`：`splitCoveredIntoChunks`/`chunkMergeInstruction`（阶段②b）、
  `freeShrink`/`resolveToolResultBudget`（D4）、summarize 分块分支 + `landSummary`
  抽取、小窗口摘要输出预算、forceCompact 前置免费收缩
- `kernel/engine.mjs`：preStep 调用时预算钳制（D3）
- `kernel/cli.mjs`：`context_window_retargeted` 事件（D5）
- `kernel/tui.mjs`：`context_window_retargeted` 展示
- `server/provider-profile.mjs`：`PONOS_PROVIDER_PROFILE` 注入（入 MANAGED_KEYS）
- `server/bridge.mjs`：syncKernelSettings 窗口注入 0/未设不再注入 1M（D5）
- `server/provider-probe.mjs`：0 视为空位可回填（D5）
- `src/components/settings/SettingsView.tsx` + i18n：新建 provider 默认 0 = 自动

## 验证

- 新增 `kernel-tests/context-window.test.mjs`（分辨率链 + 钳制纯函数）、
  `kernel-tests/compact-chunked.test.mjs`（切块纪律 + 分块落地 e2e + 单发零回归）、
  `kernel-tests/engine-budget-clamp.test.mjs`（钳制事件 + 大窗口零回归）
- 全量回归：kernel 130 / server 139 / electron 46 全过，typecheck 干净
- 存量行为零改动面：单发摘要路径（A4 限幅/收敛重试/熔断）语义不变；cloud 窗口
  默认 200K 不变；env 显式工具结果预算优先不变
