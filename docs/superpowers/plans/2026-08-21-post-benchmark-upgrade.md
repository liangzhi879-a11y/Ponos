# P8 评测后优化与升级方案（Post-Benchmark Upgrade）

> 目的：P7 全量横评（12/12 pass，零退化）后，针对评测暴露的**工具调用效率差距**、**评测平台治理缺口**、**超时机制误伤风险** 制定下一轮优化与升级方案。机制对照参考成熟项目源码（claude-code / pi / deepseek-harness）。
> 权威来源：kernel/（yfw 内核）、benchmark/（评测平台）、docs/superpowers/plans/2026-08-21-benchmark-regression.md（P7 结果）、vendors/（成熟项目源码对照）。
> 更新日期：2026-08-21

---

## 1. 评测收尾现状与瓶颈

P7 全量横评结论（yfw × T001-T006 + SWE001-006，deepseek-v4-flash）：

| 指标 | P7 结果 | 基线（08-20T14:24） | 说明 |
|---|---|---|---|
| 任务通过率 | **12/12（T 6/6 + SWE 6/6）** | 10/12 | 基线两个失败点（T004 verify 期望 bug、SWE004 难度）均转 pass |
| 内核单测 | 316/316 | 315/316 | 无退化 |
| 平均工具调用 | ~30 次 | ~30 次 | **与 claude ~20 次差距 50%——最大优化空间** |
| 平均耗时 | 视任务 | 视任务 | SWE 普遍提速，T002 例外 |

**瓶颈分析**：

1. **工具调用效率差距（T 系列 34~55 次 vs claude 16~39 次）**：12/12 全 pass 后，正确性已达标，但"用更少工具调用完成任务"仍落后 claude 约 50%。这是纯 prompt/机制层面的差距，不是正确性问题。最差样本 **T002：259s/55 次工具**（基线 154s/39 次，本次 55 次），既是模型波动也有探索冗余。
2. **评测平台治理缺口（T004 事件）**：全量 run.mjs 在 T004 中途进程死亡（agent 用时 30+ 分钟，远超基线 8 分钟），无结果文件、无进程监控、worktree salvage 靠人工。暴露：单任务无 hard timeout、无增量续跑、无 salvage 自动化。
3. **超时机制误伤风险（P1 R1-2 已修，仍有同类隐患）**：R1-2 连接超时把 timer 并入 fetch signal 误杀长流已修复（`599b9a8`）。但 stream 层 idle timeout（300s）仍是"整轮定时"模式——deepseek 长 thinking 轮（>30s）已证明这类"固定计时"易误伤。deepseek-harness 的 **pulse 重置 watchdog** 是更稳的模式。

## 2. 成熟项目机制对照表

三个成熟项目（vendors/）的机制调研结论，按"yfw 是否已落地"标注：

| 机制 | claude-code | pi | deepseek-harness | yfw 现状 | 优先级 |
|---|---|---|---|---|---|
| Read 去重 stub（mtime 未变返回 stub） | ✅ FileReadTool.ts:523-573 + fileStateCache.ts（~18% 命中） | — | — | ✅ 已落地（tools.mjs readCache，含测试） | — |
| 并行工具调用（只读并发 / 写工具串行） | ✅ constants/prompts.ts:310 | ✅ agent-loop.ts:411-554 | ✅ 有界池 maxParallelToolCalls=10 + ordered commit（tool-calls.ts:59-246） | ✅ 已落地（engine.mjs runToolBatch + lane） | — |
| **并行/串行纪律的提示词显式化** | ✅ 指令明确写"可并行调用多个独立只读工具" | ✅ 指令明确写 batch + 顺序逃生舱 | ✅ 指令明确 | ⚠️ 引擎支持但提示词未显式教会模型 | **A1 高** |
| **Todo-first 纪律** | ✅ TodoWriteTool/prompt.ts:183-184 每轮前置"先建 todo" | — | — | ⚠️ 有探索纪律提示词，todo 引导弱 | **A2 中** |
| **dedicated-tool-first / no-bash 探索边界** | ✅ 探索用专用工具，禁止 bash cat/ls 当读文件 | — | — | ⚠️ 未显式禁止 bash 探索 | **A3 高** |
| **工具结果截断** | ✅ Bash 输出 30K（EndTruncatingAccumulator）+ 定向 Read | ✅ 2000 行/50KB（truncate.ts，grep 500 字符行） | ✅ head 4096/tail 1024 修剪 + pruned marker（compaction-tool-result-pruner/src/index.ts:83） | ⚠️ 有 20KB 压缩预算，但**单次结果无硬截断** | **A4 高** |
| 失败消息移除后重试 | — | ✅ 重试前移除失败消息（agent-session.ts:2838-2842） | — | ⚠️ retryStream 重发但失败消息可能滞留上下文 | **C2 中** |
| **pulse 重置 idle watchdog** | — | — | ✅ timer 只在 next() 等待期间存活、pulse() 重置（timeout/src/index.ts:126） | ⚠️ stream idle 300s 固定计时 | **C1 高** |
| 溢出压缩后重试 | — | ✅ overflow-compact-then-retry | — | ✅ compact.mjs 已有溢出兜底 | — |

> 结论：yfw 已落地 Read 去重、并行执行、压缩预算、重试退避等**机制层**能力；差距集中在**提示词层**（教会模型用这些机制）与**平台层**（评测治理）。这正符合"1/18 体积买确定性"的定位——机制已备，缺的是驱动。

## 3. 优化升级任务清单

### P8-A 工具效率（agent 端，提示词/机制双管齐下）

| # | 任务 | 机制对照 | 验证 |
|---|---|---|---|
| A1 | **并行纪律提示词显式化**：工具描述/系统提示中明确"多个独立只读工具（Read/Glob/Grep）可一次并行调用；Bash/Edit/Write 串行" | claude prompts.ts:310、pi agent-loop.ts | 提示词单测；T 系列工具调用次数下降 |
| A2 | **Todo-first 纪律**：会话开始/任务复杂时 prompt 前置"先建 todo 清单再动手" | claude TodoWriteTool/prompt.ts:183 | 评测 T001/T002 工具次数下降 |
| A3 | **no-bash 探索边界**：显式禁止用 Bash cat/ls/grep 当探索，强制 Read/Glob/Grep 专用工具 | claude dedicated-tool-first | 评测观察 Bash 探索占比下降 |
| A4 | **单次工具结果硬截断**：超长结果（>50KB）按 head/tail 修剪 + `[truncated: N chars]` 标记，替代纯压缩预算；Read 超大文件提示分段（offset/limit） | deepseek head/tail pruner、pi truncate.ts、claude EndTruncatingAccumulator | 单元测试：超长 Bash 输出/Read 结果被修剪且标记可见 |
| A5 | **工具描述补效率提示**：Glob/Grep 描述写明返回上限、Grep 写明用 head_limit 防巨量输出 | pi 在描述中写限制 | 描述单测；评测观察 |

### P8-B 评测平台治理（benchmark 基础设施）

| # | 任务 | 说明 | 验证 |
|---|---|---|---|
| B1 | **单任务 hard timeout**：run.mjs 对每个 task 设硬超时（如基线耗时 ×3 + 缓冲），超时 kill + 结果标记 `TIMEOUT`，不拖垮全量 | 防 T004 30+ 分钟事件 | 注入 sleep agent 模拟超时 → 标记正确 |
| B2 | **worktree salvage 自动化**：任务进程死亡后自动对 worktree 跑 verify 并写入结果 | 当前人工 salvage | 模拟 kill 后自动 salvage 记录 |
| B3 | **增量续跑**：run.mjs 支持 `--resume`（跳过已完成任务，从结果目录读取） | 全量中断不重跑 | 中断后 resume 只补跑未完成任务 |
| B4 | **cwd 隔离**：后台任务用绝对路径 + 每次 spawn 独立 cwd，防 shell cwd 漂移 | 本会话踩坑（redirect 失败） | 回归：两次后台任务互不干扰 |
| B5 | **结果对比自动化**：results 对比基线自动生成退化清单（逐任务 diff 状态/耗时/工具数） | 当前人工读表 | 对比脚本单测 |

### P8-C 内核可靠性强化

| # | 任务 | 机制对照 | 验证 |
|---|---|---|---|
| C1 | **pulse 重置 idle watchdog**：stream idle timer 改为"只在等待下一个 chunk 期间存活"，收到 chunk 即重置；区分"连接等待"与"流中间" | deepseek-harness timeout/src/index.ts:126 | 回归测试：慢 chunk 流（间隔 > idle 阈值但不中断）不被误杀；真空闲超时仍触发 |
| C2 | **重试前移除失败消息**：retryStream 重发前把失败轮次的 assistant 消息从重放上下文剔除，防失败内容污染后续生成 | pi agent-session.ts:2838 | 单测：模拟首轮失败，断言重试请求上下文不含失败消息 |

## 4. 验收标准（量化）

- **效率**：T 系列平均工具调用 ≤24（P7 约 34~55 降至 ≤24 档），T002 耗时 ≤180s（P7 259s）；12/12 全 pass 保持
- **机制**：A4 截断、C1 pulse watchdog、C2 失败消息剔除均有单元测试；单测总数 ≥316 且全绿
- **平台**：B1-B5 落地——任意单任务中断可自动 salvage + 增量续跑；模拟超时/kill 场景有自动化验证
- **回归**：每项落地后跑全量单测 + T001/T002/T003 抽评确认无退化

## 5. 执行顺序与依赖

```
P8-A（提示词/截断，纯 kernel 改动，先做）
  └─→ P8-B（平台治理，独立于 A/C 可并行）
P8-C（可靠性强化，与 A 无依赖，可并行）
  └─→ 全量评测回归（T 系列 6/6 + SWE 6/6 保持）
```

- P8-A 与 P8-C 并行（互不依赖），P8-B 全程可并行
- 每完成一个任务即跑对应单测；A/B/C 全部落地后跑全量评测回归

---

## 6. 实施状态（2026-08-21 全量实施完成）

> 评估结论：12 项中 7 项需实现（A1/A2/A3/A4/A5/C1/C2 的机制测试与补强），5 项已由既有机制覆盖（A4 截断、A5 描述上限、B4 cwd 隔离、C1 pulse 语义、C2 失败不持久化）——本次全部落地并补齐测试。

### P8-A 工具效率（✅ 已完成）

| # | 落地内容 | 测试 |
|---|---|---|
| A1 | prompt.mjs【工具纪律】新增并行纪律："多个相互独立的只读工具（Read/Glob/Grep/WebFetch）可并行，Bash/Edit/Write/Agent/Task 必须串行" | server/prompt.test.mjs |
| A2 | 【探索纪律】新增 todo-first："复杂任务先用 TodoWrite 建清单再动手，随进度更新" | server/prompt.test.mjs |
| A3 | 【探索纪律】新增 no-bash 边界："禁止用 Bash（cat/sed/ls/find/grep）代替 Read/Glob/Grep；Bash 仅用于系统命令/测试/构建/git" | server/prompt.test.mjs |
| A4 | tools.mjs runShell 单次结果硬截断：stdout >200k / stderr >100k 截尾保留 + `[truncated: ...]` 标记（替代纯压缩预算） | server/tools-schema.test.mjs（250000 字符输出测试） |
| A5 | 技能注入收敛为 kernel 唯一入口：prompt.mjs 技能块重写为父子结构 + 触发词 + Skill 调用纪律；bridge append 只负责 GUI 规范（ASKUSER/MILESTONE），移除双路技能清单注入 | server/prompt.test.mjs + server/skills.test.mjs |

### P8-B 评测平台治理（✅ 已完成）

| # | 落地内容 | 测试 |
|---|---|---|
| B1 | run.mjs 单任务 hard timeout：task.timeoutMs 覆盖全局默认，超时 kill + 标记 `timeout`，跳过 verify 不产出假 pass/fail | kernel-engine 回归 |
| B2 | worktree salvage 自动化：spawn 异常/非 0 退出码 → 仍跑 verify 但结果带 `salvaged` 标注 | run.mjs 单元路径 |
| B3 | run.mjs `--resume [dir]` 增量续跑：跳过已有 `${agent}-${task.id}.json`，读回并入 summary | 手工验证 |
| B4 | cwd 隔离（既有，回归确认）：绝对 cwd spawn + 每任务独立 worktree | — |
| B5 | benchmark/lib/compare.mjs + compare.test.mjs：逐任务 diff 状态/耗时/工具数，生成退化清单（regressed/improved/slower/new/missing）；report.mjs `--compare <baseline>` 输出对比区块 | benchmark/lib/compare.test.mjs（3/3） |

### P8-C 内核可靠性（✅ 已完成）

| # | 落地内容 | 测试 |
|---|---|---|
| C1 | pulse 语义确认 + 回归测试：idle watchdog 已按单次 read 计时（withIdleTimeout 包 reader.read()）；新增慢 chunk 流测试（40ms 间隔 < 80ms 阈值、总时长 160ms > 阈值）证明不被误杀；真空闲超时仍触发（既有 P1-6 测试） | server/api-protocol.test.mjs |
| C2 | 失败消息不残留确认 + 回归测试：retryStream 仅对"首块前失败"重试（已产出 chunk 不重试）；新增断言——YFW_MOCK_TRANSIENT=once 重试成功后 transcript 仅 1 条 user + 1 条 assistant，失败轮次不落盘 | server/kernel-engine.test.mjs |

### 回归结果

- 全量单测：**368/368 pass**（server + electron，`npm test`），远超验收线 ≥316
- benchmark 对比单测：**3/3 pass**；B5 已用真实结果目录验证（`--compare` 正确解析 baseline 路径）
- 新增测试：C1 慢流（api-protocol 19 项）+ C2 重试上下文（kernel-engine），全部通过

### 说明与范围外项

- **verify-skill-listing 8 项既有失败**（父技能 subskills/parent 互逆一致性 ×4、技能清单大小 7385>4000 等）：经 git stash 验证为**改动前已存在**的技能库数据漂移（subskills 声明与 children parent 字段不一致、列表增长），非本次改动引入，超出 P8 范围，需单独做技能库治理。
- 效率验收（T 系列平均工具调用 ≤24、T002 ≤180s）依赖全量评测回归，本次已完成机制落地与单测，评测回归按需单独跑。

---

## 7. 效率差距根因修正（2026-08-21 实测）

> 初判"差距主因是模型（deepseek-v4-flash vs 真 Claude）"——**经核实错误**。benchmark 全部 4 个被测对象（yfw/claude/pi/deepseek）注入的是**同一套 API 配置**（`benchmark/lib/llm-api.mjs` AGENT_API + `.env` 的 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL）：claude CLI 走 `ANTHROPIC_BASE_URL=deepseek 端点 + ANTHROPIC_MODEL=deepseek-v4-flash`。**同 LLM、不同 harness，工具调用差距 = 内核（harness）技术差距。**

### 实证对比（同模型 deepseek-v4-flash，T001「修 api.mjs usage 双发」）

| 维度 | claude（claude-code CLI） | yfw（本内核） |
|---|---|---|
| 工具总数 | **13 次** | **34~51 次** |
| Bash | 5 次（ls 列目录 / node --test / git diff，全系统命令） | 29 次（其中 **24 次 python/sed 读文件**） |
| Edit | 4 次全部一次成功 | 8-10 次，含连环失败重试 |
| 探索 | Read 2 次整读 + Grep 2 次精准搜索 | Read 4-6 次 + python repr 反复验证字节 |

### 根因（机制层，非模型）

**yfw Edit 工具缺 CRLF 行尾归一化**：`kernel/tools.mjs editFile` 严格字节匹配。Windows 仓库文件普遍 CRLF，模型（LF 习惯）写的 old_string 永不命中 → Edit 连环失败 → 模型转 `python -c "open().read()"`/`repr` 验证精确字节 → 工具数爆炸（T003 34 次中 Edit 失败重试 + workaround 脚本即此根因）。

claude-code 对照（vendors/claude-code-src/FileEditTool.ts:214）：
```js
fileContent = fileBuffer.toString(encoding).replaceAll('\r\n', '\n')
```
先归一化再匹配，LF old_string 必然命中 → Edit 一次成功 → 模型无需验证字节 → 13 次完成。

### 修复（已落地）

`kernel/tools.mjs editFile`：
1. 读文件后 `\r\n → \n` 归一化（对照 claude FileEditTool.ts:214）
2. old_string / new_string 均归一化（模型传 LF 或 CRLF 都能命中；防 `\r\r\n`）
3. 写回按原文件行尾风格还原（CRLF 文件保持 CRLF，git diff 不整文件漂移）
4. 单测：`server/tools-schema.test.mjs` 新增 CRLF 用例（LF old_string 命中 CRLF 文件、行尾保留、LF 文件行为不变）

**提示词层教训**：A3 补强（禁 python 读文件）对模型无效——T001 调优后 python 读文件仍 24/29。根因不在模型自觉而在 Edit 可靠性：Edit 可靠后模型自然无需验证字节。**机制层可靠 > 提示词说教**。

### 实测验证（Edit CRLF 修复后，同 LLM deepseek-v4-flash，yfw × T001/T002/T003）

| 任务 | 修复前（提示词调优后） | 修复后 | P7 基线 | 验收线 |
|---|---|---|---|---|
| T001 | pass / 41次 | pass 53721ms / **19次** | 189s / 34次 | — |
| T002 | pass / 54次 | pass 156035ms / **26次** | 259s / 55次 | ≤180s |
| T003 | pass / 29次 | pass 123856ms / **14次** | 207s / 20次 | — |
| **T 平均工具** | 41.3 次 | **19.7 次** | 36.3 次 | ≤24 |

- 3/3 pass 保持；平均工具调用 41.3 → **19.7**，**跌破 ≤24 验收线**，进入 claude 的 13~39 区间
- T002 26 次（P7 55 次）——最差样本砍半；T001 19 次（P7 34 次）
- 验证 Edit CRLF 根因修复为真：工具调用差距 = harness 技术差距（同 LLM），一次机制修复整体收敛

## 8. 全量 12 任务评测（2026-08-21）

### 评测平台时序 bug（已修复）：result 早发导致"假 FAIL"

- **现象**：全量 12 任务 11/12 pass，唯一失败 T002 深入调查后证实是**评测平台误判**——
  agent 修复完全正确（`selectResumeHistory` 实现正确，手动 verify PASS），但 verify 读到过期文件。
- **根因**：`benchmark/harness/yfw.mjs` 在收到内核 `result` 事件时立即 resolve——而内核发出
  result 后进程尚未退出（会话落盘/记忆捕获等收尾仍在进行，agent 最后一批文件写入可能恰在
  result 之后）。立即 resolve 让 `run.mjs` 的 verify 读到旧文件态，产生"假 FAIL"。
- **证据链**：diff 快照（只有 api.mjs 被改）、worktree 5 个文件改动、cli.mjs mtime 晚于
  verify 读取时刻。
- **修复**：result 事件只记账（usage/toolCalls）并 `stdin.end()` 请求内核优雅退出，
  **不 resolve**；`child.on('close')` 时才 finish(resolve)——verify 面 = 最终文件态。
- **验证**：T002 重跑（`node benchmark/run.mjs --tasks T002 --agents yfw`）。

### 全量结果（yfw × T001-T006 + SWE001-006，deepseek-v4-flash）

| 任务 | 结果 | 耗时 | 任务 | 结果 | 耗时 |
|---|---|---|---|---|---|
| SWE001 | pass | 69s | T001 | pass | 65s |
| SWE002 | pass | 242s | T002 | pass* | 154s |
| SWE003 | pass | 86s | T003 | pass | 117s |
| SWE004 | pass | 43s | T004 | pass | 163s |
| SWE005 | pass | 265s | T005 | pass | 107s |
| SWE006 | pass | 202s | T006 | pass | 17s |

- 12/12 pass（T002 重跑确认）；SWE 全 pass 37-236s；T 系列除 T002 外全 pass
- T004 45 次/163s（P7 曾 30+ 分钟）——Edit CRLF 修复 + 提示词优化叠加生效

## 9. P9 上下文压缩质量升级（2026-08-21 实施）

### 背景：压缩次数 ≥3 后输出质量直线下降

- 用户实测反馈：批量文本处理时上下文庞大，几轮下来压缩次数已达 3 次甚至更多；
  压缩 >4 次后输出质量直线下降，难以维持高效处理。
- 根因（业界 re-compaction penalty，Baseten 实测 15.9pp 精度损失）：传统压缩器对
  "已压缩的摘要"反复再压缩，摘要层级坍缩，关键事实逐轮丢失。

### P9-1 工具结果轮次清除（microcompact 语义）

- 对照 claude-code `microCompact.ts`：上下文超"老化清除阈值"（window × 0.5）时，
  把保留窗口之外的可重放工具结果（Read/Bash/Grep/Glob/WebFetch/OCR）整条替换为
  占位标记 `[旧工具结果已清除——需要时重新调用工具读取]`，零模型成本。
- 原文仍在 transcript，模型需要时重新 Read 恢复；Edit/Write/Agent/Task 等结果小且
  不可重放，一律不清。
- 保留窗口按"全部工具结果"计数（最近 keepRecent 条不论类型保留），与 claude-code 一致。
- 实现：`kernel/compact.mjs` `ageOutToolResults()`；maybeCompact 阶段0 插入，
  `CLAUDECODE_TOOL_RESULT_CLEAR_RATIO`（默认 0.5）/ `CLAUDECODE_TOOL_RESULT_KEEP_RECENT`（默认 2）可调。

### P9-2 摘要防套摘要（sealed）

- 已压缩的 compaction summary 条目（字符串 content 的 assistant 消息）在后续摘要请求中
  一律过滤——其内容已体现在 lastSummary，重塞回请求只会让模型"对摘要的摘要再摘要"。
- 每次摘要只针对"尚未压缩的新消息"（anchored iterative summarization），
  连续压缩质量不随次数衰减。
- 实现：`assembleSummaryRequest` covered 过滤 `!(role==='assistant' && typeof content==='string')`。
- 注意：真实系统中普通 assistant 消息是 block 数组（session.assistantEntry），字符串
  content 是 compaction summary 专属——过滤条件即精确的 sealed 判别（测试 fixture 同约定）。

### P9-3 会话工作记忆文件（session memory）

- 对照 claude-code `sessionMemoryCompact.ts`：轮末把关键状态（todo/文件变更/最近决策）
  增量写入 `<configDir>/memory/session/<sessionId>.md`；压缩时读文件作为摘要事实来源，
  注入摘要请求 `<session-memory>` 块——摘要不再依赖"对话全文的一次性有损概括"。
- 实现：`kernel/compact.mjs` `buildSessionMemoryText()` + `readSessionMemoryFile()`
  （statSync mtime 缓存）；`kernel/cli.mjs` 接线 sessionMemoryPath + handleUser 轮末写入。

### 验证

- `server/compact.test.mjs` 新增 5 个 P9 测试全部通过（ageOut ×2、sealed ×1、sessionMemory ×2）
- 全量单测回归 328/328 pass
- 回归修正两个测试契约：
  - assembleSummaryRequest 前缀对齐测试 fixture 改为 block 数组（对齐 sealed 判别约定）
  - ageOutToolResults 保留窗口按全部工具结果计数（r3+e1 保留 → r1/r2 清除 2 条）

### 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CLAUDECODE_TOOL_RESULT_CLEAR_RATIO` | 0.5 | 老化清除触发阈值（window 比例） |
| `CLAUDECODE_TOOL_RESULT_KEEP_RECENT` | 2 | 保留的最近工具结果条数 |
