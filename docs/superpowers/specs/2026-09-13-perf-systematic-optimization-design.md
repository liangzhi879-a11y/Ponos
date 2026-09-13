# 任务运行慢 · 系统性优化设计（内核优先 → 渲染层）

**日期**：2026-09-13
**上游**：用户反馈「感觉任务运行慢」→ 全栈只读排查 → 本设计
**性质**：纯性能优化，**不改产品语义**（请求面语义、事件契约、API 合法性全部冻结）
**实施计划**：`docs/superpowers/plans/2026-09-13-perf-systematic-optimization.md`

---

## §1 问题与实测真源

排查手段：`app.log` 全量 3,382 行 + 内核 transcript 探针 + 真实 provider 探针 + 进程 CPU 采样 + 两端代码走读。

| 指标 | 实测值 | 含义 |
|---|---|---|
| provider TTFB / 吞吐 | TTFB 263ms；384 tok/s；`reasoning_effort=max` 下推理 87–99 tok/s、正文 93–106 tok/s；30K 上下文 91 tok/s 端到端 | **provider 不慢** |
| 应用内每步 | 中位 2.9s（p90 13.2s）= TTFB 0.6s + 生成 1.9s + 尾部 0.6s | 86% 模型侧；尾部 0.6s 里内核固定开销占 0.15–0.7s |
| 每步帧数 / 帧间隔 | 中位 3 帧；帧间隔中位 998ms | 每步只吐几十字符 |
| 单轮输出 vs 可见文本 | 28,253 / 98,038 output tokens，可见正文中位 **0 字符** | 墙钟几乎全在**推理 token** |
| 请求面 | 中位 273KB / msgs 174；最大 295,191B / msgs 226 | 每步全量重建 |
| 渲染器 CPU | 流式期 **1.35 核 / 1.5GB**；同期内核 0.03 核、桥 0.00 核 | 渲染器是唯一吃 CPU 的进程 |
| 机器 | i7-7700T 4C/8T | 1.35 核 = 17% 总算力 |
| `/api/usage` | 三次采样 10.8 / 12.7 / 19.6s；驾驶舱开着时每 5s 轮询一次，GUI 超时也是 5s | 桥事件循环被**同步 spawn 整进程 + 全量聚合**阻塞 |

**结论**：不是 provider 慢，也不是单一 bug，而是三者叠加——「每步固定开销 × 极多步数」+「墙钟几乎全花在不可见推理」+「渲染层流式期吃满一个核」。

**用户决策**：先内核后渲染层；允许进取改动（可牺牲少量诊断/交互细节）；推理预算做分级（常规步降档、疑难步保持高档）。

---

## §2 不变量（违反即回退）

1. 请求面语义与 API 合法性不变（`patchOrphanToolUses` 补孤儿 tool_result 的位置硬约束、溢出瘦身副本「取用即消费」、`freeShrink` 老化语义）。
2. **缓存必须可证不陈旧**：只对「本步窗口内不可变」的数据做缓存；任何原地改写后必须失效。
3. 新增观测不得引入逐帧 IO。
4. 诊断不降级到不可用：错误与慢路径全量保留。
5. 内核零外部依赖（`kernel/**` 只 import `node:*` 与仓内相对路径）。
6. 契约纯增量；优化与观测的异常一律 try/catch，不得抛穿 `runTurn`。

---

## §3 阶段 K0 — 观测基线

内核 `kernel/` 下 `performance.now()` / `[perf]` / `hrtime` **零命中**：要落地 K1 必须先能测。

新增 `kernel/perf.mjs`（约 50 行）：默认零开销实现 + `PONOS_PERF=1` 开关切换（可插拔观测的标准形状，参考 pi `telemetry/src/index.ts` 的 `NOOP_TELEMETRY_CONTEXT`）。

三条硬约束：
- **开关必须惰性读**：`cli.mjs` 的 `settings.env` 注入发生在**所有 ESM 模块求值之后**，写成模块级常量必然拿不到（同一个坑 `engine-adaptive-firstbyte.test.mjs` 头部注释已记录）。
- **重入保护按 key 做，不做全局 depth**（**实施期修正**）：原设计的 `depth>0 只计数` 是错的——`preStep`（key=`pre`，异步）**内部就调用** `est`/`req`/`tools`，全局 depth 会让这三个真正的头号指标在每一轮里全部漏记（退化成 `est=0`，等于把最该测的东西测没了）。改为 `active: Set<key>`：只有**同一个 key** 的重入才由最外层记账，达到同样的「一次 88ms 不被记 5 遍」效果而不误伤。
- **发射点在迭代头**：主循环每迭代开头结算**上一步**汇总。`continue` 出口有十余处，在迭代头结算可**一处覆盖所有出口**且不碰任何 `continue` 路径。轮末再补最后一步（`break` 与正常退出都要发）。

异步段（`ttfb`/`gen`/`tail`）用 `perfMark`/`perfSpan` 打点，`perfSpan` **取用即消费**（读后删除打点）：走 `continue` 出口的迭代若不删，会把旧打点当成"本步结束时刻"算出虚高的段长。异常出口同样打 `genEnd`（否则本步 `tail` 段缺失）。

默认必须关：内核 stderr 会被桥 ① 转发 console ② 写 `kernel-stderr.log` ③ 作为 `stderr` 事件转渲染器，有实际成本。

伴随落地的两处非内核观测（同属 K0，为 K2/R 提供前后数据背书）：
- **K0.2 桥侧事件循环漂移探针**：`/api/usage` 是同步 `execFileSync`，route 的 `ms=` 只说明「调用方等了多久」，说明不了「别人被连累多久」——采样定时器的漂移才是后者的直接度量，expose 于 `/diag/info`（`loopDriftMs`/`loopDriftMaxMs`）。
- **K0.3 渲染帧指标**：帧数 / 单帧处理 ms p50,p95 / 真实帧间隔 p50,max / 是否降频，每 5s 经 `POST /diag/render-frame` 汇入桥内存 → `checkRenderHealth` 的 `detail`。**不落 uiStore**（persist store，每帧写 = 每帧全量序列化），且**只加 detail 不改 status 判据**（阈值化 warn 在长消息流式期会常态误报）。

---

## §4 阶段 K1 — 每步只算一次（主收益）

**实测校正了优先级**（本机 Windows / Node 24，2.5MB / 1482 条合成历史 + 真机 88 个技能目录）：头号热点**不是遍历**，而是 token 估算里的**逐块序列化 + 逐字符计数**。

| 热点 | 实测 | 每步次数 | 每步代价 |
|---|---|---|---|
| `estimateRequest`（`estimateHistory` 75.9） | **88.5 ms/次** | 3–6 | **260–530 ms** |
| `buildWorkflowTools` + 发现 | **22.2 ms/次** | 6 | **132 ms** |
| `JSON.stringify(face)`（`adaptiveFirstByteMs`） | 16.7 ms/次 | 1 | 16.7 ms |
| `requestMessages()` = `patchOrphanToolUses` | 0.77 ms/次 | 4–5 | 3.9 ms |
| `session.append` | 0.83 ms/条 | 1–3 | ~2 ms |
| `setEntryUsage` 行反查（33.5MB / 5 万行） | 172 ms（+读写 ≈ 300ms） | ≤1/轮 | 尖峰 |
| **合计** | | | **420–680 ms/步 → 收敛后 5–8 ms/步** |

### §4.1 缓存可证不陈旧的结构性依据

- `deriveMessages()` **已有缓存**；`deriveHistory()` = 缓存数组或 `filter`（**只换数组、不换元素**）；`patchOrphanToolUses` 无孤儿时推原对象（`out.push(m)`）⇒ **块对象身份在一步内稳定**。
- **唯一破坏身份稳定的是原地改写**，且全仓只此两处：`compact.mjs:59` 与 `:199`（已用 `grep '^\s*(b|block|blk)\.[a-zA-Z_]* = ' kernel/*.mjs` 证明；`Object.assign`/`delete` 在 kernel 下亦无命中）。
  ⇒ `bumpContentEpoch()` **紧邻两个赋值点**各调一次（而非只在 `freeShrink` 外层）——`ageOutToolResults` 是导出函数、会被独立调用（`compact-safety.test.mjs:83`），写在 `freeShrink` 里漏掉这条路径就会陈旧。紧邻赋值点 ⇒ **可证无遗漏**。
- **摘要落地是"换对象"而非"改内容"**（`nodes.splice` + `invalidate()`）⇒ 结构性不可能读到摘要前的历史。
- **两个独立计数器**（参考 codex `history_version` 与 `user_message_revision` 的分离）：`contentEpoch` 管内容改写、`session.revision` 管会话变更。

### §4.2 各项

- **K1.1 估算器记忆化**：按**对象身份** WeakMap 记忆化，键 = `身份 + contentEpoch + 密度指纹`。**必须同时做消息级与块级**——string 分支与 system 项每次都新建字面量对象，只做块级会**恒 miss**。
  - **实测（1.75MB / 1500 条合成历史，同夹具对比 `PONOS_ESTIMATE_CACHE=0`）**：关缓存 `24.9/18.7/18.2ms` → 开缓存 `20.3/0.71/1.39ms`。**稳态 ≈18–25×**；首次只快 1.2×（首调必须冷算），而真实每步是 **3–6 次调用**，故每步是「1 次冷算 + 2–5 次命中」——这正是收益所在。跨步也命中：`deriveMessages()` 推的是 `entry.message` **引用**（`session.mjs:303`），历史增长只让新增的几条冷算。
  - `system` 段**刻意不缓存**（`estimateTokensUncached`）：`systemPrompt` 可被 `setSystemPrompt` 整体替换，而它是字符串（WeakMap 键不了），且一次只有 ~20KB——缓存它收益小、风险大。
  - **容量不需要 LRU**：键是「活着的历史对象」，条目数被历史体量天然限制、随对象回收；参考实现里涨到 300MB 的是**字符串键的会话级 Map**，形状不同。
  - 开关 `PONOS_ESTIMATE_CACHE=0` 单独关（默认 on）。
- **K1.2 工具视图缓存**：缓存边界画在**工具表构造**上（`cli.mjs` 的 `setDynamicTools` 闭包内）。失效键 = `toolSourceSignature()`，三部分：
  1. **各工作流根的条目名列表（含类型）**——增/删/改名/改型 100% 正确，零 stat；
  2. **上一轮发现实际读过的文件** `(mtimeMs,size)`——编辑 100% 正确，含 legacy/不可见/超限者（`discoverWorkflows` 的元数据 `path` 即此集合；`buildWorkflowTools` 以非枚举 `sourcePaths` 带出）；
  3. **应用侧** registry.json / binding.json + 每个注册应用的 `<appId>/spec.json`（id 集用 `listApps` 取，与 app-tools 同一读入口）。
  **`syncAppPermissionRules` 有副作用（改 `rules.allow/ask`），必须每次求值都跑，绝不进缓存**（只包工具表构造）——行为侧（绑定/解绑后 `rules.ask` 必须变化）与结构侧（源码顺序：该调用早于 `viewCache.get(sig)`）双重钉死。
  **容量上限 ≤8 + LRU**（参考教训：无上限 Map 曾涨到 300MB+），实现为 `createToolsViewCache({max:8})`，命中重插队尾（否则退化成 FIFO）。
  - **实测（真实 home：技能根 64 项 + 工作流根 2 项 + 1 个应用根）**：签名 **0.68ms/次**；× 6 次求值/步 ≈ **4.1ms/步**（原 132ms）。端到端 mock 两迭代实测 `tools=2/2.1 dynHit=2`、`tools=1/1.1 dynHit=1` ⇒ **稳态构建 0 次**。
  - **零 per-item stat 是被实测逼出来的**：逐项 stat 62 个目录的 `<dir>/workflow.yml` = **4.44ms**（接近发现层本身的 6.13ms）；递归 `readdirSync(recursive:true)`（483 项）= **35.4ms**。两者都会吃掉全部收益。
  - **失败语义有意不对称**：根 `readdir` 失败 → `-`（与 `discoverWorkflows`「读不到即空」同口径 ⇒ **稳定可缓存**，否则"尚未创建工作流目录"这一常见态永远不可缓存）；文件 `stat` 非 ENOENT 失败 → **签名返回 null ⇒ 不缓存**（退化为每次求值）。
  - **唯一残留（已登记）**：在**既存目录**内新增 `<dir>/workflow.yml`——父目录名未变（名字列表看不见）、又不在已知文件集 ⇒ 需等该根条目增删/已知文件被编辑/重启内核。常见写入路径（新建=新目录名、编辑=文件指纹、绑定/解绑=binding.json）均不受影响。二期由桥侧 `tools_dirty` 显式失效信号收口。
  - 开关 `PONOS_DYNTOOLS_CACHE=0` 单独关（默认 on，惰性读）。
- **K1.3 `adaptiveFirstByteMs` 惰性化**：不必缓存——**根本不必算**。返回值只可能是 `{0, baseMs, 600_000}` 三者之一，改为惰性提供者后正常首字节永不触发那次 stringify。语义等价（新阈值 ≥ 旧阈值，只会**延后** trip）。
  - **实现**：`makeIdleWatchdog(ms, firstByteMs)` 的 `firstByteMs` 允许为函数。`gateMs = lazy ? ms : Math.min(ms, constMs)`——提供者形态下检查门槛取 `ms`，靠「引擎侧提供者恒 ≥ ms」保证不早于应有阈值；求值结果**缓存**（含抛错兜底为 `ms`，不每周期重试）。常量形态阈值/门槛/timer 周期三者仍按常量算，**与旧版逐字一致** ⇒ `firstByteMs < ms` 的历史用法不受影响。
  - **实测**（真机请求面口径）：中位 273KB/208 条 = **1.19ms/请求**、最大 295KB/224 条 = **1.90ms/请求**、长历史 1.32MB/1835 条 = **9.22ms/请求**；惰性化后正常首字节路径 **0 次求值**（原计划记的 16.7ms 出自另一份 tool_result 更密的夹具）。省 1–2ms/步、几十 ms/轮——**量级不大但代价为零**（不引入任何新状态），历史越长收益越大。
  - **唯一差异在时机不在结果**：提供者调用从「每请求恒 1 次」变为「仅 prefill 超 `ms` 零数据时 1 次，常态 0 次」；返回值不变（`adaptiveFirstByteMs` 自带 try/catch，watchdog 侧再兜一层为 `ms`，两层同指一个宽限值）。回退 = 调用点改回传值（1 行）。
  - **有意偏差**：`makeIdleWatchdog` 由私有改为**导出**（纯增量）——否则「提供者是否真被惰性调用」无法直接测，只能间接推断。
- **K1.4 `requestMessages()` 记忆化**：抽 `createRequestFace(...)` 工厂并导出。键用**引用比较**而非把 20KB systemPrompt 拼进字符串。**唯一别名点**：`fitRequestToWindow` 早退时原样返回入参引用，且被 `engine-fit-request.test.mjs:21-22` 的 `assert.equal(r, msgs)` 钉死。
  - **键四分量** = `(session.revision, historySkip, systemPrompt, contentEpoch)`。`revision` 是 session 的派生纪元（每次 `deriveMessages()` **真实重建**即 +1）；`contentEpoch` 是保险丝（compact 原地改写只改块内容、不改数组结构）。
  - **`revision` 有两处 +1**：`invalidate()`（写路径立即生效）与 `deriveMessages()` 的重建分支（兜住"忘了 invalidate 却改了 nodes"）。同时把 `rebuildSurface` 的 `deriveCache = null` 改为调 `invalidate()` ⇒ 全仓"置空缓存"仅一处。两处同触发只多失效一次（只多算、不会错算）。
  - **工厂必须先 `getBase()` 再 `getRevision()`**（顺序不变式）：`revision` 在重建时才 +1，反序会在"已失效未重建"的窗口里把新结果存到旧键下，白丢一次命中。已单测钉死。
  - **systemPrompt 的键比较实测是「内容比较 + 身份快路径」**（V8 驻留字面量 + `===` 先比身份再比内容），比纯引用比更好：传等值新串不白付重建，代价仅一次 ~20KB memcmp。
  - **内存模式（无 session）需独立计数器 `memoryRev`**：`deriveHistory()` 走 `memoryHistory.filter()` **每次新建数组**，身份不可用；在数组声明旁加计数器、让唯一写入点 `pushMemory` 同址 bump。
  - **实测**（261 条 / 102KB + 20KB 系统提示，一步 5 次求值）：请求面 1.02ms → **0.04ms**；含 5 次全量估算 5.15ms → **1.23ms**（联动 K1.1：数组身份稳定 ⇒ 4/5 次估算命中）。
  - **范围**：lane 路径的 `msgs()` 一步只求值 **1 次**（仅 `retryStream` 一处），记忆化零收益，**不套工厂**。
  - 观测：新增 `[perf]` 字段 `reqHit=`——否则「缓存被静默关掉/失效键写错恒 miss」与「优化生效」在 `req=` 的毫秒上无法区分。开关 `PONOS_REQUEST_FACE_CACHE=0`。
- **K1.5 append**：`mkdirSync` 去重。**硬约束：不得改成常驻 fd**——`setEntryUsage` 用 `writeFileSync(tmp)+renameSync` 整体替换文件，常驻 fd 会指向被 unlink 的旧 inode → **静默丢写**。
- **K1.6 估算锚定（二期，默认关）**：以最近一条带 usage 的条目为锚，只估尾部（参考 claude-code `tokens.ts` / codex `history.rs`）。**风险在方向**：低估 → 压缩触发过晚 → 溢出 ⇒ 必须先量化误差（>5% 不上线）；**压缩落地即作废锚点**。

---

## §5 阶段 K2 — 磁盘与发现路径

**改动点排序（按性价比）：① 日期下推 → ② 水位线缓存 → ③ 异步 spawn → ④ 常驻进程（不做）**。

- **K2.0 `scope=today` 日期下推（第一优先，且是现存 bug）**：`runUsage` 里 `scope` 只用于 `bySession`，`from`/`to` 恒为空 ⇒ **`scope='today'` 与 `'all'` 计算量完全相同 = 全量历史聚合**，而 UI 文案写「今日用量」。修法：`scope==='today'` 时推导 `from`。
- **K2.1 `/api/usage` 异步化（现存 bug）**：`execFileSync` → 异步 spawn（不改路由签名）。GUI 超时 5s 而实测 10.8–19.6s ⇒ **用量面板当前必然超时失败**；驾驶舱 5s 轮询与 5s 超时**同值** ⇒ 慢时必然堆积。
- **K2.2 只读聚合剪枝 + 日期水位线缓存**：① 按 `(mtimeMs,size)` 跳过没变的文件；② 桥侧落带**版本号 + 日期水位线**的聚合缓存，只重算水位线之后那一段再合并（参考 claude-code `statsCache`），配**单飞锁** + `inFlight` 去重。
- **K2.3 `session.append` 批量写**：缓冲 + 定时 flush，`result`/控制类保持同步写。**必须有显式 flush 屏障**（轮末/压缩前/退出/异常路径）。**不是常驻 fd**（见 K1.5）。
- **K2.4/K2.5（低优先）**：`setEntryUsage` 复用写队列；追加型 transcript 的**撕裂尾部修复**（加载时校验最后一行、重写有效前缀 + 补 `\n`）。

---

## §6 阶段 K3 — 推理预算分级

墙钟上最大的杠杆（69% 墙钟在流式生成，其中绝大部分是不可见推理 token），但不是性能优化能单方面决定的事 ⇒ 独立成阶段 + 回退开关。

**链路实测（决定实现方式）**：`normalizeEffort` 只认 `off|low|high|max`（**`medium` 会被映射成 `high`**）；`api.mjs` 的 `effortParam` **把 thinking-enabled 分支排在 `reasoning_effort` 映射之前并直接 return** ⇒ 当前每请求只带 `thinking:{budget_tokens:4096}`，**用户设的 `effortLevel: max` 实际从未发出去**。

- **K3.0 先定「哪个旋钮真的管用」**（必做前置）：三臂探针（adaptive 不带 budget / 带 budget / `reasoning_effort`）。**成熟实现是「旋钮二选一、由模型能力决定，绝不两个同时传」**；若选 budget 必须钳到 `min(maxOutputTokens-1, budget)`（那个 `-1` 照抄，否则 API 400）。凭据只从 `~/.yfw/config.json` 读、绝不回显/落盘。
- **K3.1 判据**：**先按阶段边界定档，运行时启发式只作辅助**——四套成熟实现里**都没有任何运行时探测**。① 摘要/压缩步 → `off`（几无质量风险）② 首步 → 用户档 ③ 工具步 → 降一档 ④ 运行时只留「上一步工具报错」「压缩后第一步」两条。**用户显式 pin 档位时策略只降不升**。
- **K3.2/K3.3 落点与回退**：档位解析层放一处（别名与降级写死）；`PONOS_EFFORT_POLICY=graded|off`，**默认 `off`**，直到 K3.0 有实测数据。

---

## §7 阶段 R — 渲染层（内核之后）

前两条是「每帧同步 IO」与「整店订阅 → 整树重建」。

- **R1 每帧日志双写**：每帧 `console.log` → 主进程**两次** `statSync+appendFileSync`。实测：renderer-console.log 22 小时写了 **17MB**。**次序很重要：先门控短路（不构造字符串），再谈缓冲**。
- **R2 uiStore 瞬时态**：已亲证 `zustand@4.5.7` 的 `set` **无条件** `setItem()`（`partialize({...get()})` + `localStorage.setItem`）⇒ 每帧 2 次同步全量序列化。**在 store action 里 `set(() => ({}))` 不是短路**，唯一有效的原地修法是**在调用 `set` 之前提前 return**；更彻底的做法是把瞬时态移出 persist store（deepseek 有直接先例）。
- **R3 拆「整店 → 整树」链**：`WorkShell` 的 `useChatStore()` / `useUIStore()` **无选择器**，而它直接渲染 `<ChatWindow>` ⇒ 任何写入都重建整棵消息树。**R2×R3 叠加**：即使假短路 `set` 也产生新 state 对象 → 每帧白送 2 次整树重渲染 ⇒ 「提前 return」同时消掉两处，是性价比最高的一处改动。
- **R4 markdown**：稳定对象 `useMemo` + 逐字符拼接改正则 + **冻结稳定前缀、只重解析不稳定尾块**（参考 `StreamingMarkdown`）。
- **R5 `streamHeavyMode`**：原判据只包住 store 循环 ⇒ 永不置位。**成熟做法测「队列压力」而非「handler 耗时」**（队列深度 / 最老未渲染项年龄 + 滞回）；**调度不用 rAF**（后台/失焦会停摆），改 16ms 定时器。
- **R6 长列表**：虚拟化或 containment；做法照「量化 scrollTop + `useSyncExternalStore`」+ `memo` 比较器显式豁免回调 props。

---

## §8 参考实现对照（成熟经验 → 落点）

对象：`claude-code/src`（Ink TUI）、`codex-main/codex-rs`（Rust）、`deepseek-harness-master`（TS/Electron 同构，最接近本仓）、`pi-main/packages`。

| 成熟经验 | 出处 | 落点 |
|---|---|---|
| 估算锚定服务端 usage，只估尾部 | `claude-code/src/utils/tokens.ts:226,253-256`；codex `core/src/context_manager/history.rs:665,697` | K1.6 |
| 重写即 bump 版本号；两个独立计数器 | codex `.../history.rs:81-84,196-197` | K1 的 `contentEpoch` / K1.4 的 `revision` |
| 压缩产物写新对象、不改旧对象 | `claude-code/.../microCompact.ts:470-479` | K1 改写点枚举的旁证 |
| 内容哈希做键避免陈旧 + LRU 上限 | codex `utils/cache/src/lib.rs:30,130-134` | K1 备选保险 |
| 发现层 = 快照 + 显式 clear/watcher 驱动（四套库**都没有 TTL 型 discovery 缓存**） | codex `ext/skills/.../host_service.rs:87-90,375`；`claude-code/.../toolSchemaCache.ts:18-26` | K1.2 |
| **会话级 Map 必须设上限**（lodash memoize 涨到 300MB+） | `claude-code/src/utils/memoize.ts:227-269` | K1.2 容量上限 |
| 不用 inode 做失效键（Windows 不可靠） | `claude-code/.../markdownConfigLoader.ts:159-170` | 反证 K1.2 的 `(mtime,size)` 选择 |
| TTL + stale-while-revalidate + 单飞 | `claude-code/src/utils/memoize.ts:40-107,120-220` | K2.2 |
| 磁盘缓存 = 版本号 + 日期水位线 + 增量合并 + 单飞锁 | `claude-code/src/utils/statsCache.ts:17,27-50,57,147,214,260+` | **K2.2 升级版** |
| 落盘 = 有界队列 + 后台刷盘 + **显式 flush 屏障** | codex `rollout/src/recorder.rs:979,1031,1052`；deepseek `session-persistence/.../coordinator.ts:1325` | K2.3 |
| 追加型日志撕裂尾部修复 | `pi-main/.../session/jsonl/storage.ts:38-41,89-105` | K2.5 |
| 先门控短路、再缓冲 | `claude-code/src/utils/debug.ts:104-125`、`utils/bufferedWriter.ts:9-21,60-80` | R1 次序 |
| 数据层不节流、渲染层 16ms 节流；**不用 rAF** | `claude-code/src/ink/ink.tsx:213`；`pi-main/packages/tui/src/tui.ts:343,806-824` | R5 |
| 自适应降频测**队列压力**（深度/最老年龄 + 滞回） | codex `tui/src/streaming/chunking.rs:85-116` | R5 判据 |
| markdown 只重解析尾块 + 前缀冻结 + 哈希 token 缓存 + 语法快速路径 | `claude-code/src/components/Markdown.tsx:22-71,186-235` | R4 |
| 瞬时态不进持久化 store；弃用 zustand persist（同因） | deepseek `runtime/.../contract/store.ts:119-147`、`ui-conversation/.../stores.ts:21-27` | R2 首选 |
| 量化 scrollTop + `useSyncExternalStore`；memo 比较器豁免回调 | `claude-code/src/hooks/useVirtualScroll.ts:233-244`、`components/Messages.tsx:741+` | R6 / R3 |
| 推理档位 = 配置维度 + 阶段边界，**不是运行时探测** | codex `core/src/config/mod.rs:970`、`state/session.rs:36-70`；`claude-code/.../compact.ts:1305` | **K3.1 修正** |
| 旋钮二选一由模型能力决定；`min(maxOutputTokens-1, budget)` | `claude-code/src/services/api/claude.ts:1601-1630` | K3.0 |
| 档位解析三层链 + 未知值降级写死在解析层 | `claude-code/src/utils/effort.ts:136-167,202-216`；codex `reasoning_effort.rs:10-40` | K3.2 |
| **质量验证无自动化机制**（只有流程约束 + 灰度） | `claude-code/src/utils/thinking.ts:100-101,131-133` | K3 的「默认 off + A/B 表 + 一键回退」是唯一可行路线 |

**诚实标注**：R 阶段的问题（每帧 `console.log`、整店订阅）在 Ink/Rust 里**不存在**——渲染模型不同。故 R 的「成熟经验」是**局部模式**，**不是架构可移植**；K 阶段的经验才是同构的。

---

## §9 风险与回退

| 风险 | 缓解 / 回退 |
|---|---|
| **缓存陈旧**（最大正确性风险） | 原地改写仅两处（已 grep 证明）→ `bumpContentEpoch()` 写在 `freeShrink` 内且同 PR；反例测试必红；每项独立 env 开关，一次只开一个 |
| `requestMessages()` 共享数组被下游写 | 已逐点审计（`messages` 全仓无原地写）；唯一别名点 `fitRequestToWindow` 早退返回入参引用，被 `engine-fit-request.test.mjs:21-22` 钉死 —— **PR 描述必须点名** |
| 请求面缓存的 `revision` 与派生缓存**脱钩** | 两处 +1（`invalidate()` + 重建分支）+ 唯一置空点收拢到 `invalidate()` ⇒ 结构上不可能不同步；内存模式另有同址 bump 的 `memoryRev`；反例测试（append/压缩/load/epoch 各向）全覆盖 |
| 工具表缓存漏掉 Spec/工作流改动 | 名字列表入键（增删改名 100% 正确）+ **发现层实际读过的文件** `(mtime,size)` 覆盖编辑 + 检测不到变化一律不缓存；权限规则因每次跑 `syncAppPermissionRules` 而不受影响 |
| 工具表缓存的**已知残留**：既存目录内新增 `<dir>/workflow.yml` | 名字列表看不见（父目录名未变）⇒ 等该根条目增删/已知文件编辑/重启内核。三态可测；常见写入路径均不受影响；二期 `tools_dirty` 收口 |
| **Windows mtime 粒度**（15.6ms） | `size` 与名字列表双入键；等长改写用例显式 `sleep(30)` 暴露；粒度不可靠则默认关 |
| 惰性 watchdog 改变挂起语义 | 只可能**延后** trip（提供者恒 ≥ `ms`），不可能提前掐断；双向测试（放宽态 `tripped===false` + 常量小阈值仍按小阈值 trip）；回退 1 行。**残留**：求值时机由「每请求」变为「仅超 `ms` 零数据时」，故该路径上的异常显影更晚——但 `adaptiveFirstByteMs` 本就自带 try/catch（抛错返回 `baseMs`），外部语义不变 |
| K1.6 锚点法低估 → 溢出 | 默认 off；先量化误差（>5% 不上线）；压缩后作废锚点 |
| 写盘正确性 | **禁止**常驻 fd；缓冲另加显式 flush 屏障 + 关键条目同步写 |
| 推理降档损伤质量 | 默认 off；A/B 实测后再开；一键回退 |
| 合帧渲染改变观感 | 已选进取档；保留开关回退 |
| 日志采样降低诊断密度 | 错误与慢路径全量；`[perf]` 默认关、采样率可配 |

---

## §10 验证

1. `npm test`（基线 1061 条 / 1 skip）+ `npm run typecheck`。
2. 每阶段前后对比 `[perf]` 的每步字段。
3. K3 前后：A/B 表 + 3–5 个真实任务对比（**别指望自动化质量回归**）。
4. 新增测试全放**新文件**（避开并行 WIP 的 `fidelity.test.mjs` / `app-*.test.mjs`）。
5. 端到端护栏（免费）：`app-tools-mount` / `api-protocol` / `overflow-loop` 已断言每轮请求体的历史内容，缓存一旦返回陈旧历史必红。
6. release 同步门：先 `diff -rq` 再逐文件覆盖；**不跑 `scripts/package-portable.cjs`**。
