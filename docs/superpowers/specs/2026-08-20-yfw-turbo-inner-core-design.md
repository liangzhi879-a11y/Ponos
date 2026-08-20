# YFW-turbo 内层逻辑架构设计（事件日志 + 上下文压缩 + 健康监控）

日期：2026-08-20
状态：架构定稿，待实施
参考：deepseek-harness（DeepSeek AI 开源 harness，追加式事件日志 + compaction capability seam）、pi packages/agent（两阶段上下文管线 + turn 边界切点纪律）、本仓库 health-monitor-design.md（2026-08-13）与 fullstack-perf-optimization-design.md（2026-08-14）

## 1. 背景与动机

YFW-turbo 是净室重建的原创内核（Node ESM、stream-json 协议、当前 Anthropic Messages 兼容 API——本轮扩展为双协议、单进程每会话）。当前只有最小 Agent 循环 + 3 个工具，**内层逻辑缺三块**：

| 缺失能力 | 后果 |
|---|---|
| 消息历史为内存数组，无压缩 | 长会话 token 膨胀，2-3 次摘要嵌套后执行能力断崖（deepseek-v4-flash 实测） |
| 无 token 预算/窗口管理 | 无法预判 `context_window_exceeded`，溢出只能硬失败 |
| 无健康监控事件 | GUI 对任务质量劣化一无所知（health-monitor-design 已定义协议但内核未实现） |

目标（用户确认，2026-08-20）：**先定方向架构，内层逻辑（消息历史/压缩/健康）优先于外围功能**；功能面（工具扩展、子代理、定时任务）后续再讨论。API 层双协议与 tools schema 注入作为**前置项**纳入本轮（§3.5，压缩摘要调用与真实工具链路依赖它）。

## 1.5 业务场景与能力需求（2026-08-20 用户补充确认）

内层逻辑的验收标准 = 两类核心业务场景：

### A. 申报材料服务（高企认定，最长会话场景）

- 长会话跨多天：一个企业申报项目持续数周，会话反复 resume
- 长文撰写：立项报告 / 创新性说明等数千字专业材料，上下文质量直接决定材料成败
- 大文件读取：Excel 四表（RD/PS/IP/TOAI）、PDF、发票数据，单次工具输出可达数十万字符
- 多轮核对迭代：专审核对 / 发票 PS 匹配等反复比对
- 子代理分发：table-expert / refiner / material-writer 等专业 agent 并发

### B. 代码开发（日常开发与内核自身迭代，本轮即用）

- 长代码文件读写与多文件搜索（Read/Write/Edit/Glob/Grep，工具面后续轮补齐）
- 代码审查、测试驱动开发、系统调试、分支管理（对应已装技能）
- 开发任务跨天持续：resume + 压缩 + 健康监控同样必需
- 高 token 密度：代码块 token/字符比高于自然语言（约 3-4 字符/token vs 4-5）

### 对设计的约束（由场景反推）

| 约束 | 来源场景 | 设计落点 |
|---|---|---|
| 压缩不得损害代码/材料质量 | A/B | 收敛校验 + 增量摘要（§5.3） |
| 大工具输出不得撑爆上下文 | A（Excel/PDF/发票） | tool-result 裁剪优先（§5.3） |
| 裁剪不得切碎代码语义 | B | 裁剪按完整行边界（§5.3 补充） |
| token 计价需贴近真实用量 | B（代码密度高） | 块级密度系数（§5.1 补充） |
| 长会话可感知质量劣化 | A（申报跨周） | 健康监控 + 剩余轮数提示（§6） |

## 2. 设计决策（用户已逐项确认）

| 决策点 | 选择 |
|---|---|
| 消息历史模型 | **追加式事件日志 + surface 派生**（对齐 deepseek-harness，与现有 transcript 权威源一致） |
| 压缩摘要策略 | **允许调用主模型**，裁剪优先（先免模型 tool-result 裁剪，仍超才摘要调用） |
| 本轮实施范围 | **压缩 + 健康监控一起**（context/compact/health 三模块 + yfw_health/yfw_summary 双事件） |
| API 层 | **双协议适配 + tools schema 注入**（前置项，2026-08-20 确认）——OpenAI 兼容 + Anthropic 兼容并存，归一化 chunk 形状不变 |

## 3. 架构总览

```
┌────────────────────────────── YFW-turbo 内核（每会话单进程）──────────────────────────────┐
│                                                                                            │
│  cli.mjs（IO 层）──user──▶ engine.mjs（Agent 循环）                                         │
│                              │  pre-step 测压检查点                                        │
│                              ▼                                                            │
│                        context.mjs ◀──▶ compact.mjs（两阶段压缩器）                         │
│                        窗口表/token 计价    pruner → summarizer                            │
│                              │                                                            │
│                              ▼                                                            │
│                        session.mjs（事件日志 + surface）◀── transcript JSONL（权威源）      │
│                                                                                            │
│  turnStats 记录器（每轮产出）→ health.mjs（纯计算）→ yfw_health / yfw_summary（stdout）      │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 3.5 API 层双协议适配 + tools schema 注入（前置项，2026-08-20 用户确认）

### 3.5.1 基础缺口（必须先修，协议无关）

当前 `api.mjs` 请求 body **没有 `tools` 字段**（api.mjs:148-164），且 `tools.mjs` 的 registry 只有 `description` 无 JSON schema。后果：**真实 API 路径下模型不知道有工具可用，工具调用链路是断的**——现有工具测试全部靠 `YFW_MOCK_API` mock 流掩盖。无论走哪条传输协议，都必须先注入工具 schema。

- `tools.mjs` registry 每工具补 `input_schema`（JSON Schema，`additionalProperties: false`）；`toolNames`/`run` 不变。
- `api.mjs` 请求构造把 schema 序列化为协议的 tools 参数（Anthropic `tools[]` / OpenAI `tools[]` 同构，字段名映射）。

### 3.5.2 双协议适配（不是替换，并存）

```
engine ──▶ 归一化 chunk 形状 {type:'text'|'thinking'|'tool_use'|'usage'}（不变，engine 无感）
              ▲
      api.mjs 协议选择层（env 检测）
        ├─ anthropicStream：现有逻辑微调 + 补 tools 注入（默认，现网 ANTHROPIC_* 配置不破坏）
        └─ openaiStream：新写 ~120 行（/v1/chat/completions）
      env：OPENAI_BASE_URL + OPENAI_API_KEY 存在 → OpenAI；否则 ANTHROPIC_BASE_URL → Anthropic
```

| 差异点 | Anthropic（现有） | OpenAI（新增） |
|---|---|---|
| 端点 | `/v1/messages` | `/v1/chat/completions` |
| system | 抽顶层 `system` 字段 | 并入 messages `{role:'system'}` |
| 流式文本 | `content_block_delta.text_delta` | `choices[0].delta.content` |
| 思考块 | `thinking_delta` | `delta.reasoning_content`（deepseek 系） |
| 工具调用 | `content_block_start(tool_use)`+`input_json_delta` | `delta.tool_calls[i].function.arguments` 增量 |
| usage | `message_start`/`message_delta` | 流末尾 `usage{prompt_tokens,completion_tokens}` |

### 3.5.3 配套改动

- `bridge.mjs` `buildChildEnv`：provider 配置支持注入 `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`（上一轮已确认 bridge 可协同演进；模型名透传，`ANTHROPIC_MODEL` 兼容保留）。
- 模型路由：`ANTHROPIC_DEFAULT_SONNET/OPUS/HAIKU` 语义在 OpenAI 协议下由 provider 模型名透传，不额外映射。

## 3.6 请求前缀缓存优化（KV/Prompt Cache，2026-08-20 评估）

参考"提升 KV Cache / Prompt Cache 命中率"路线做约束适配。核心原则：**让更多请求共享更长完全一致的前缀，动态内容放末尾**。

**采纳（融入架构）**：

| 项 | 落点 |
|---|---|
| 前缀稳定性不变量 | system（顶层）+ 工具定义（顶层）+ 历史按序追加——engine 组装请求的固定顺序，写为不变量防未来破坏 |
| 缓存命中率可观测 | usage 解析扩展 `cache_read_input_tokens` / `cache_creation_input_tokens`（deepseek 系 provider 均提供）→ 进 turnStats → stats 端点可统计命中率/平均复用前缀长度 |
| **summarizer 前缀对齐主请求** | 压缩摘要调用重放前缀时**顺序与主请求一致**（system+工具+旧历史+指令）→ 摘要调用 prefill 命中主请求 KV 缓存，压缩的额外成本显著下降 |
| cache_control 断点（可选） | Anthropic 协议 system/静态块加 `cache_control:{type:'ephemeral'}`；未知 provider 可能忽略 → 默认关，按 provider 白名单/配置开启 |

**拒绝**：前缀感知路由/实例调度/批量共享前缀（多实例场景）、缓存块大小/容量/淘汰策略（provider 推理框架侧）、语义缓存（输出结果缓存，场景不匹配）。

**权衡记录**：resume 精简技能清单（fullstack-perf 已有决策）→ resume 后 system prompt 变化 → 首个请求缓存 miss。保留现有决策，副作用记录，后续可用 system 静态块 cache_control 缓解。

**审计项**：bridge 注入的 system prompt 文件须无时间戳/随机 ID 等每 spawn 变化的内容（经验注入/技能清单顺序稳定）；发现即固定化。

## 3.7 多会话与资源治理（2026-08-20 评估）

**现状**：每会话一进程（全局多进程、会话内单进程）——契约设计，进程级隔离（一个会话崩溃不影响其他）。代价：并发会话 = 并发完整上下文，FREEZE 调查确认多会话自动恢复的内存压力是卡死放大器。

**治理层次**：

| 层 | 措施 | 状态 |
|---|---|---|
| 已有 | 空闲 10min 回收 + resume 无缝重启 | 已实现 |
| 架构覆盖 | 压缩减请求体/内存、turnStats 观测 | 本设计 §5/§6 |
| 新增① | **transcript 分段加载**：session.mjs `load()` 改逐行流式读，超长截断到近窗口（降内存峰值） | 本设计 |
| 新增② | **deriveMessages 缓存**：surface 派生结果缓存，append/replace 时增量失效重建 | 本设计 |
| 新增③ | **resume 窗口化恢复（折衷）**：超大 transcript（>N token）默认全量恢复保语义，配置可开"近窗口+压缩摘要"恢复（针对首 token 慢） | 本设计 |
| 新增④ | bridge 侧并发进程上限 + 每进程内存采样进 diag | bridge 协同演进 |
| ❌ 拒绝 | 多会话共享进程/进程池（拿崩溃隔离换资源，违背契约底线） | 明确不做 |

**立场**：资源治理不得破坏"每会话一进程"的隔离契约；优化只发生在**单个进程内部的资源使用**（内存/派生/恢复）与 bridge 的**调度层**（上限/回收）。

## 4. 消息历史：追加式事件日志 + surface

### 4.1 原则

- transcript JSONL **已是追加式事件日志**（user/assistant entry），是权威源。本设计不另建存储，只扩展 entry 字段 + 增加内存 surface 投影。
- 模型输入消息**永远从日志派生**（`deriveMessages`），不单独维护 message 数组——压缩、resume、子代理 fork 都建立在同一模型上。

### 4.2 entry 扩展（session.mjs）

每个 entry 增加：

```jsonc
{ "type": "user" | "assistant",
  "id": "<uuid>",
  "seq": 3,                          // 单调递增序号（新增；跨进程恢复的稳定标识）
  "ts": "<iso>",
  "surfaceOp": "append" | "replace", // 默认 append；压缩条目为 replace（新增）
  "sourceEventSeqs": [1, 2],         // replace 时被遮蔽的 seq 列表（新增）
  "kind": "compaction",              // 仅压缩摘要条目携带（新增；GUI 展示可折叠/容错）
  "message": { ... } }
```

- 兼容性：旧 transcript 无 seq → 加载时按顺序补齐；GUI 读到的旧字段全部保留。

### 4.3 内存 surface（engine/session 持有）

```js
// 有序 seq 数组 + 代际计数器（压缩替换后递增）
surface = { nodes: [1, 2, 3, 4, 5], replaceGeneration: 0 }
```

- **seq 语义澄清**：`seq` 是**日志侧**的追加序号（单调递增，跨进程稳定的标识）；`surface.nodes` 是**投影侧**的顺序（模型输入顺序），`replace` 后因新 seq 插入旧区间而**可能非单调**——两者不矛盾：投影顺序以 `nodes` 数组顺序为准。
- `deriveMessages(surface)`：按 nodes 数组顺序取日志条目转 Anthropic Message，O(新节点)。
- `replace(start, end, summarySeq)`：`nodes.splice(start, end-start+1, summarySeq)`；`replaceGeneration++`。
- **不变量**：assistant tool-call 与其 tool_result 永不拆散（切点纪律，见 §5.4）；surface 上被替换区间一定覆盖 `sourceEventSeqs` 全集。

### 4.4 resume

`--resume` 加载 transcript → 依序重建 seq + surface（含压缩 replace 后的最终形态）→ 用 `YFW_HEALTH_COMPACT_COUNT`（bridge 已注入）恢复压缩计数。超大 transcript 的窗口化恢复见 §3.7 新增③（默认全量恢复保语义，配置可开"近窗口+压缩摘要"）。

## 5. 上下文压缩（kernel/context.mjs + kernel/compact.mjs）

### 5.1 token 计价（context.mjs，零依赖纯函数）

```js
estimateTokens(block)   // 块级密度系数：text 按 chars/4；代码/工具输出按 chars/3（密度更高）
                        // 图片/二进制按固定 4800 字符当量；每块 +4
estimateMessage(m)      // role +4 + 各块合计
estimateHistory(msgs)   // 全量启发式
// 锚点优化：最近一次成功调用 usage 且请求头与当前相同 → usage.input_tokens 为基线
//   + 尾部增量估计，否则全量启发式
// 密度系数可配置（代码场景实测校准），默认 text=4 / code=3
```

### 5.2 触发（pre-step 测压，deepseek after-call 语义）

- 测压时机：**每轮请求前**（工具结果/上一轮产物已落日志之后），与 pi/deepseek 一致。
- 阈值：`thresholdTokens = floor(contextWindow × 0.8)`；`contextWindow` 来源优先级：
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（bridge 注入的 provider contextWindow）→ 模型窗口表（deepseek-v4-flash=200K / deepseek-v4-pro[1m]=1M，可扩展）。
- `estimateHistory ≥ thresholdTokens` → 触发压缩流程。
- 溢出兜底：provider 返回 `context_window_exceeded` → **强制压缩** → 仅当 `replaceGeneration` 前进（压缩确实落地）才 retry 同一请求；`maxOverflowRetries`（默认 3）防循环。

### 5.3 两阶段管线（compact.mjs）

```
阶段① 免模型裁剪（ToolResultPruner，确定性零成本）
  优先级原则（架构立场）：按需读取 > 结构裁剪 > 摘要压缩。
  裁剪是兜底，只应对"模型已产生超大输出"的存量；正路是工具层按需读取
  （工具面补齐时 Read 的 offset/limit、Grep 上下文行数排第一优先级）。
  结构感知裁剪（轻启发式，按行首特征判断内容类型，不引入解析库）：
    表格/CSV（四表/发票）→ 表头 + 等间隔采样行 + 合计尾行
    代码             → 完整行边界 + 首部（导入/签名）+ 尾部（主逻辑/入口）
    JSON/日志        → 键名结构 + 错误行（stderr/异常优先级高于 stdout）
  可追问标记（模型知道自己缺什么、怎么补读）：
    "已截断：第 8000-12000 字符未保留（表格第 301-400 行），
     可对该片段追问，或我用 Read offset/limit 补读"
  裁剪后重测：压力已安全 → 跳过摘要，直接结束
  默认阈值 20000 字符偏保守（申报 CSV 单文件可达数十万字符），宁可多保留、
  多提示——裁剪省的是 token，理解错误的代价是任务失败，默认值可配置
  （CLAUDE_CODE_TOOL_RESULT_BUDGET(_BYTES) 覆盖，可整体关闭）

阶段② 摘要压缩（一次直呼主模型）
  assemble：重放主请求前缀中即将被遮蔽的区间（system/工具定义/旧消息，
            顺序与主请求一致——见 §3.6 前缀对齐，使摘要调用 prefill 命中
            主请求 KV 缓存）作为上下文
           + 末尾追加固定 COMPACTION_INSTRUCTION（原创提示词：9 节结构化 checkpoint：
             Goal/Progress/Blockers/Next Steps/Key Facts/Decisions/Artifacts/Open Questions/Continuation）
           + 前次 <compacted-summary>（若存在）合并更新（增量摘要，非全量重写）
  → 一次流式调用 → 提取 <compacted-summary> 标签内文本
  收敛校验：摘要 tokens 必须 < 被遮蔽内容 tokens；否则重试（compactionRetries=3，且逐次
            强化"必须更短"指令）；摘要再超窗口 → 拒绝本次压缩（等待下一次阈值触发）
```

### 5.4 切点纪律与保留尾巴

- **切点只允许在 turn 边界**：user 消息之后；**禁止**切进 assistant tool-call/tool_result 配对中间（可切割的最小单位 = 一个完整 turn）。
- 保留尾巴：从 surface 尾部向前累计 token 至 `retainTokens = floor(contextWindow × 0.16)`，再向前扩展到最近一个完整 turn 边界；open tail（不可分割的进行中 turn）不压缩，返回 null 等待。
- 覆盖范围：被遮蔽区间 = 保留尾巴之前的所有可切 turn。

### 5.5 落地与日志锁（崩溃可检测）

- 日志追加括号对：`compaction/start`（持锁，记录被遮蔽 seq）→ `compaction/summary`（replace 落地）→ `compaction/end`（释放锁）。
- 进程崩溃留孤儿 `start` → 加载时检测到孤儿 start → 回滚该次替换（surface 重建时忽略未配对区间）。
- 单进程内叠加内存锁：压缩进行中拒绝并发压缩。

### 5.6 配置默认值

| 项 | 默认 | 覆盖 |
|---|---|---|
| thresholdRatio | 0.8 | env / 配置 |
| retainRatio | 0.16 | env / 配置 |
| tool-result 裁剪阈值 | 20000 字符触发，结构感知保留（表格采样/代码行边界/JSON 键名，见 §5.3） | CLAUDE_CODE_TOOL_RESULT_BUDGET(_BYTES) |
| compactionRetries | 3 | 配置 |
| maxOverflowRetries | 3 | 配置 |

## 6. 健康监控（kernel/health.mjs）

规格完全照 health-monitor-design.md（2026-08-13），本设计只定内核侧落点。

**观测层统一（设计观点，2026-08-20）**：健康监控、usage 统计、耗时统计（GUI 读 duration_ms）本质是同一族——"每轮观测 → 聚合 → 事件/查询"。统一为 **turnStats 记录器**（engine 每轮尾部产出一份 `turnStats {usage, durationMs, model, ts, compactCount}`，内存 append-only 数组），三个消费者共用：

```
engine 每轮尾部 → turnStats 记录器
   ├─ health.mjs 消费 → 健康分 → yfw_health / yfw_summary
   ├─ result 事件携带（usage / duration_ms 对齐 GUI 读取）
   └─ /transcript/stats 聚合（bridge 侧从 transcript 重建）
```

- health.mjs 退化为**纯计算**（吃 turnStats 出健康分、档位、去抖状态机），不自己维护观测状态。
- 对应 deepseek-harness session-stats/token-meter 投影思路，收敛为单进程内一个数组，不过度设计。

**调用点**：`engine` 每轮尾部产生 turnStats → health 消费；`compact.mjs` 压缩成功后 `health.recordCompaction(summary, count)`。
- **健康分模型**（多因子加权，模型自适应归一化）：

| 因子 | 规则 |
|---|---|
| 压缩次数 | count>0 → max(40, 70×count/cap)；cap=断崖点（flash 3 / pro[1m] 6） |
| 压缩链深度（10 轮内） | ≥2 → (chain−1)×15 |
| 上下文剩余水位 | 剩余 <25%/<12%（相对 attentionCeiling）→ +45/+70 |
| 剩余可执行轮数 | 剩余 token ÷ 近 10 轮平均消耗，<10/<5 → +20/+30；<5 强制红档 |
| 连续压缩失败 | 每次 +10，封顶 3 |

- 档位：0-40 绿 / 40-70 黄 / ≥70 红；同档去抖只发一次；红档 5 分钟冷却。
- 模型自适应：`reliableAttentionRatio=0.8`；`attentionCeiling = min(有效窗口, 名义窗口×0.8)`；剩余水位以此为分母。
- 事件协议（与 spec 原文一致，bridge 已原样转发，零改动）：

```
{"type":"yfw_health","score":72,"tier":"red","compactCount":3,"remainingPct":8,
 "remainingTurns":4,"suggestNewSession":true,"reason":"已连续压缩3次，剩余约4轮"}
{"type":"yfw_summary","text":"<最近一次压缩摘要全文>","compactCount":3}
```

- 全程 try/catch 静默降级，绝不影响主流程。

## 6.3 上下文健康监控参考路线的折衷采纳（2026-08-20 评估）

对照通用路线（统一上下文网关 + 多维指标 + 规则/向量/LLM 三层评估 + 治理闭环）做约束适配评估，结论：**骨架采纳，重资产拒绝**（约束：无依赖单进程、本地桌面、资源与 token 双敏感）。

| 采纳度 | 项 | 落点 |
|---|---|---|
| ✅ 采纳 | 上下文分区 + 每区 token 记账 | context.mjs `tokenLedger`：system / task / tool_result / history 四区累计 |
| ✅ 采纳 | 冗余率轻量近似 | health.mjs：哈希去重节省 token 比例因子（O(n) 零模型成本） |
| ✅ 采纳 | 分区失衡信号 | health.mjs：tool_result 区占比超阈值加分（直指"大工具输出撑爆"业务痛点） |
| ✅ 采纳 | 治理结果入账 | turnStats 记录压缩/裁剪量（闭环轻量版） |
| 🟡 折衷 | LLM-as-Judge 低频抽检 | 仅健康分红档时，压缩摘要+最近消息重放主模型做完整性 1-5 分；**默认关闭**（每次=一次完整 API 调用），结果进 stats 供回归 |
| ❌ 拒绝 | embedding/NLI/向量库/观测平台/块级元数据/TTL/冲突消解 | 违背无依赖+低资源约束，收益/成本不成比例 |

**关键原则**：所有增强必须是**确定性 O(n) 纯函数或默认关闭的可选调用**；任何需要额外模型调用/向量化/外部依赖的能力一律不进主流程。

## 6.5 token 使用统计（对话 / 项目 / 模型 × 时间，2026-08-20 用户补充）

需求：按对话、项目、模型 + 时间维度统计 token 用量（成本/计费刚需）。

**数据盘点（transcript 权威源天然支撑）**：
- 对话维度：单 transcript 内聚合 assistantEntry.usage
- 项目维度：`projects/<sanitize(cwd)>/` 目录天然分组（一个项目 = 一个目录）
- 模型维度：entry.message.model 字段
- 时间维度：entry.timestamp

**必须先修的两个数据缺陷（否则统计失真）**：
1. **turn 内多 API 调用 usage 只记最后一次**（engine.mjs 现状 `usage = chunk.usage` 覆盖）——工具循环每轮都调 API，中间轮用量丢失 → 改为**累计**（input/output 逐次累加）。
2. **压缩摘要调用的用量未计入**——`compact.mjs` 摘要调用走独立流式，其 usage 并入当前轮统计。

**成本换算边界（修正版，2026-08-20）**：内核只保证**精确 usage**，`total_cost_usd` 换算**全部收敛到 `/transcript/stats` 端点**（单价表/provider 配置在 bridge，provider 改价无需动内核）。result 事件**不补** total_cost_usd 字段——避免 bridge 为补字段而解析改写内核事件（破坏"原样转发"的干净性）。GUI 成本显示统一从 stats 端点取；其现有对 `result.total_cost_usd` 的读取（useYFWCLI.ts:623）无值时不报错，后续 GUI 重构时移除该读取。

**聚合层**：bridge 新增 `/transcript/stats` 端点（按 项目/模型/日期 聚合，供 GUI 成本面板），数据源即 transcript 全量扫描；不做独立账本文件（避免与权威源双写不一致）。

## 7. 契约分层与协同演进（2026-08-20 用户确认：bridge/前端可系统化升级）

此前"GUI 零改动 / bridge 零改动"是**净室过渡期的便利假设，不是架构原则**。开发是系统性的：内核是重点，但 bridge / 前端 / transcript 均允许协同演进。契约分四层：

| 层 | 内容 | 可动性 |
|---|---|---|
| L0 上游契约 | Anthropic Messages 兼容 API、provider env | 🔒 不可动（外部约束） |
| L1 产品契约 | 用户可见功能不消失、数据不丢（transcript 权威源语义） | 🔒 不可动（底线） |
| L2 进程边界协议 | stdin/stdout NDJSON、事件形状 | 🔓 可协同演进：内核+bridge+GUI 同步改，需兼容期/版本化 |
| L3 实现契约 | bridge 转发逻辑、文本解析、transcript 格式、统计聚合 | 🔓 自研，随时重构 |

**演进预留（本轮不实现，wire 留位）**：

| 演进点 | 现状（文本/脆弱） | 系统化方向 |
|---|---|---|
| 里程碑/ASK_USER 卡片 | bridge 正则从 assistant 文本剥离 `<!--...-->` | 内核发结构化 `milestone`/`question` 事件；文本标记降级为展示兜底 |
| approval 协议 | `can_use_tool` 文本化传递 | 结构化升级（decisionClassification、updatedInput 回写语义） |
| transcript 格式 | GUI 对未知 kind 折叠兜底 | transcript v2：压缩/统计字段原生消费 |
| result/统计 | GUI 读 result.total_cost_usd（本轮不发） | 统一走 `/transcript/stats` |

**本轮落地方式**（仍保持向后兼容，避免一步到位的破坏性改动）：
- transcript entry 新增字段（seq/surfaceOp/sourceEventSeqs/kind）**全部可选**，旧文件可加载
- yfw_health / yfw_summary 走 stdout 原样转发（bridge 零改动可先行），结构化升级放入演进队列
- stdin / spawn / wire 协议不变

## 8. 测试计划

1. **token 计价单测**：chars/4 基准、块/role 加成、**代码块密度系数（chars/3）**、usage 锚点切换（同/异请求头）。
2. **切点纪律单测**：tool-call/result 配对不可拆；user 边界才可切；open tail 返回 null。
3. **行边界裁剪单测（代码场景）**：超长代码输出裁剪不切在行中间，头尾行完整保留。
4. **结构感知裁剪单测**：表格行采样保留表头+合计尾行；代码行边界不切行中；JSON 键名+错误行优先。
5. **压缩流程单测（YFW_MOCK_API）**：mock 流注入超阈值历史 → 触发 → 裁剪优先（不调摘要）→ 仍超 → 摘要调用 → replace 落地 → surface 派生正确。
6. **收敛校验**：摘要不小于被遮蔽内容 → 重试 → 上限后放弃。
7. **溢出恢复**：mock provider 返回 context_window_exceeded → 强制压缩 → retry 成功；replaceGeneration 未前进不 retry。
8. **日志锁/崩溃恢复**：孤儿 compaction/start → 加载回滚。
9. **usage 累计单测**：turn 内多次 API 调用 + 压缩摘要调用 → 全部计入；result.usage 与 transcript 一致。
10. **统计聚合单测**：多会话/多模型 transcript → 按 项目/模型/日期 聚合正确。
11. **健康分单测**：档位边界 40/70、去抖、模型自适应（flash 3 次红 vs pro[1m] 3 次黄）、剩余轮数强制红。
12. **resume 回归**：压缩后 transcript 的 resume 恢复 surface 终态 + compactCount。
13. **tools schema 注入单测**：registry 各工具 input_schema 序列化正确；真实 API 请求 body 含 tools（mock HTTP 断言）。
14. **双协议解析单测（前置项）**：同一归一化 chunk 序列分别经 anthropicStream / openaiStream 事件流（mock SSE：content_block_* vs choices[].delta 含 content/reasoning_content/tool_calls）→ 产出相同 chunk 形状；tools 参数映射一致。
15. **协议选择单测**：OPENAI_BASE_URL 存在 → OpenAI；否则 Anthropic；未知协议报错。
16. **tokenLedger 记账单测**：四区累计正确；tool_result 区占比超阈值触发分区失衡因子。
17. **冗余率单测**：重复段落哈希去重比例计算正确（O(n) 无模型调用）。
18. **LLM-as-Judge 抽检单测**：默认关闭不产生调用；开启后仅红档触发一次；结果入 stats。
19. **缓存 usage 解析单测**：provider 返回 cache_read/cache_creation 字段 → 正确解析进 turnStats；缺失时降级 input/output。
20. **summarizer 前缀对齐单测**：摘要调用重放顺序与主请求一致（system+工具+旧历史+指令）；前缀一致性可断言。
21. **分段加载单测**：超大 transcript 流式读内存峰值受控；近窗口截断语义正确。
22. **deriveMessages 缓存单测**：append 增量更新；replace 失效重建；缓存命中不重复派生。
23. **resume 窗口化恢复单测**：全量恢复（默认）与窗口化恢复（配置）语义一致（模型可见上下文等价）。
24. **既有回归**：kernel-engine / kernel-contract / kernel-bridge 三套测试全部保持通过。

## 9. 改动文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `kernel/api.mjs` | 改（前置） | 协议选择层 + openaiStream 新增 + anthropicStream 补 tools 注入 + **usage 解析扩展（cache_read/cache_creation）+ cache_control 可选** |
| `kernel/tools.mjs` | 改（前置） | registry 补 input_schema（JSON Schema） |
| `kernel/context.mjs` | 新增 | 模型窗口表、token 计价、压力判定、**tokenLedger 四区记账** |
| `kernel/compact.mjs` | 新增 | 两阶段压缩器（pruner + summarizer）、切点、保留尾巴、日志锁、溢出恢复、**治理结果入账、summarizer 前缀对齐主请求（缓存复用）** |
| `kernel/health.mjs` | 新增 | 健康分模型（含**冗余率/分区失衡**因子）、yfw_health/yfw_summary 事件、去抖状态机、**红档 LLM-as-Judge 低频抽检（默认关）** |
| `kernel/session.mjs` | 改 | entry 扩展（seq/surfaceOp/sourceEventSeqs/kind）、surface 加载/重建、孤儿 start 回滚、**分段加载（流式读）** |
| `kernel/engine.mjs` | 改 | pre-step 测压检查点、每轮尾部 health.record、压缩摘要消费、**usage 逐次累计**、双层循环骨架预留、**deriveMessages 缓存** |
| `kernel/protocol.mjs` | 改 | yfw_health/yfw_summary 事件构造器（result 保持纯 usage） |
| `server/bridge.mjs` | 改 | `/transcript/stats` 聚合端点（项目/模型/日期 + 成本换算）；provider 配置支持 OPENAI_* env 注入 |
| `server/transcript.mjs` 或 GUI 侧 | 小改（本轮同步） | transcriptAdapter 对 kind=compaction 条目容错折叠 |

## 10. 非目标（YAGNI）

- 不做子代理体系（Lane 模型仅在本设计预留事件日志/surface 可扩展性，不实现）——方向已定"先设计再定"。
- 不做定时任务/工具面扩展（外围功能，下一轮讨论）。
- 不做三存储 + reducer 崩溃恢复（pi 方案，SQLite 依赖违背单进程无依赖）。
- 不做上下文压缩的持久化压缩后消息重写（transcript 权威源语义：压缩只作用于 surface 派生，原文日志保留可回溯）。
- 不做健康监控的历史视图/桌面通知（spec 非目标原样保留）。
