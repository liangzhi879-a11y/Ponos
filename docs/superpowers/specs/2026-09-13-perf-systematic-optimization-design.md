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
  - **实测**：`mkdirSync(递归,已存在)+appendFileSync` 0.401ms/条 → 仅 `appendFileSync` **0.221ms/条**（省 0.181ms/条 ≈ 近半）⇒ 0.18–0.54ms/步。
  - **省 mkdir 会删掉一条隐含自愈语义**：目录运行期被删时旧实现靠"每次都 mkdir"自愈，只省不补会让 ENOENT 被 catch 吞掉 ⇒ 内存有、磁盘无（静默丢写）。故补 ENOENT 分支：清标志 → 重建目录 → **重试一次**。已做变异验证（短路该分支后恰好两个自愈用例转红）。
  - **测试边界**：删目录等于连 transcript 文件一起删，旧内容必然没了（旧实现同样如此）⇒ 断言"新写入落盘"而非"内容复活"。
- **K1.6 估算锚定（二期，默认关）**：以最近一条带 usage 的条目为锚，只估尾部（参考 claude-code `tokens.ts` / codex `history.rs`）。**风险在方向**：低估 → 压缩触发过晚 → 溢出 ⇒ 必须先量化误差（>5% 不上线）；**压缩落地即作废锚点**。

---

## §5 阶段 K2 — 磁盘与发现路径

**改动点排序（按性价比，已按 K2.0/K2.2 的实测两次校正）**：① **桥侧缓存（命中即零扫描）** → ② **内核侧无状态剪枝**（日期窗口 → mtime 下界）→ ③ 异步 spawn → ④ 日期下推（**正确性**优先，性能仅 14%）→ ⑤ 常驻进程（不做）。
校正依据见下 K2.0 的实测表：`from/to` 在**逐行 parse 之后**才比较，故它省的是聚合不是解析；**解析与文件数**才是真瓶颈。②优先级高于"带水位线的持久化聚合"的原因见 K2.2。

- **K2.0 `scope=today` 日期下推（已完成；价值在正确性）**：`runUsage` 里 `scope` 只用于 `bySession`，`from`/`to` 恒为空（`from || day` 只在本次改动后才存在）⇒ **`scope='today'` 与 `'all'` 计算量完全相同 = 全量历史聚合**，而 UI 文案写「今日用量」（驾驶舱卡读 `report.totals` 并把 requests 标成「今日 turns」）。实现：`todayFrom()` + **闭区间 `[今天,今天]`**（只给 `from` 会漏进"未来条目"⇒ 静默多算）；显式 `from`/`to` 各自优先。`scope` 的两类语义仍须区分：`session|project|all` 是**分组维度**（文档化契约），`today` 是**时间窗口**（GUI 引入、本次实现）——故加了「`scope=session` 多天总量 == `all`」的不回归测试。
- **K2.0 实测（240 文件 / 33.4MB / 48000 条）**：全量解析 470.7ms、`runUsage all` 557.6ms、`runUsage today` 477.3ms ⇒ **净省 80ms = 14%**；真实 CLI 全进程 809ms（纯启动 150ms = 19%）；只解析当天文件 ≈ **14.2ms**。
- **夹具发现（决定 K2.2 形状）**：同 57MB 夹具下**文件数**才是乘数——240 文件 731ms vs 4800 文件 **3271ms**（4.5×），其中仅 `statSync` 218.8ms。⇒ 「每次都 stat 再剪枝」在**该夹具**上不够，命中即零扫描的缓存必须排最前。
  **⚠️ 事后的真机更正（K2.2 实测推翻了一处推论）**：原文由此推断「真机必是数万个小文件量级」——**错**。真机 `~/.yfw` 实测 **134 文件 / 36.8MB / 7 目录**，`--usage --scope today` 稳定 520–579ms；故 10.8–19.6s 不是单次扫描代价，最可能是**同步 spawn 阻塞 × 轮询堆积**（K2.1 修掉的正是这部分）。教训：**夹具的敏感性不能反推真机规模**；而 134 文件上 `statSync` 只要 8ms ⇒ 无状态剪枝完全付得起。
- **K2.1 `/api/usage` 异步化（已完成）**：`execFileSync` → 异步 spawn（**不改路由签名**）。GUI 超时 5s 而实测 10.8–19.6s ⇒ **用量面板当前必然超时失败**；驾驶舱 5s 轮询与 5s 超时**同值** ⇒ 慢时必然堆积。异步化的收益随文件数放大（阻塞的是桥的整个事件循环）。
  **异步化自己引入三项责任**（`execFileSync` 的 timeout/maxBuffer 是免费的，必须自己补，缺一项都比同步版更糟）：① **超时必须 kill**——只 reject 不 kill 会让路由**永久悬挂**；② **stdout 必须封顶**——跑飞的子进程会吃光桥内存；③ **同参必须单飞**（把 K2.2 的 `inFlight` 提前到此）——**同步版把事件循环堵死反而"天然串行"**，改 async 后 5s 轮询与数秒~数十秒的耗时能重叠，不设上界会同时 spawn 好几个内核进程（各 50–70MB RSS + 全量扫盘），在本机（4 核）比原来的阻塞更糟。摘除必须走 settle（含失败路径），否则一次报错会让同参请求永久复用那个 rejection（**永久陈旧**，比慢严重得多）。
  **测试重心 = 「不再阻塞」而非「返回值能解析」**：核心用例在异步调用期间挂 10ms 定时器，断言照常触发（≥3 次）并对照断言同步版 0 次。变异验证：把异步版退化成「同步跑 + 包一层 Promise」⇒ 6/8 红，其中 `maxBuffer` 用例 105ms → **55.5s**（证明 kill 是真杀）。
  **同类隐患（未动）**：`bridge.mjs` 尚有 `git worktree list`/`git branch -a`/`netstat -ano -p tcp` 等同步 `execSync`（同属"HTTP 路由里同步 spawn"）；`taskkill` 系列是刻意短阻塞。K0.2 的 `loopDriftMaxMs` 保留，专职盯这些剩余路径。
- **K2.2 只读聚合剪枝 + 日期水位线缓存**：①（先做）桥侧落带**版本号 + 日期水位线**的聚合缓存，只重算水位线之后那一段再合并（参考 claude-code `statsCache`），配**单飞锁** + `inFlight` 去重；②（后做）按 `(mtimeMs,size)` 跳过没变的文件——它是逐文件 `statSync`，只在缓存未命中时才付这笔钱。
- **K2.3 `session.append` 批量写（不做——实测否决）**：缓冲 + 定时 flush，`result`/控制类保持同步写。**必须有显式 flush 屏障**（轮末/压缩前/退出/异常路径）。**不是常驻 fd**（见 K1.5）。
  **否决依据（真机/本机实测）**：`appendFileSync` 一条 4.6KB 行 = **0.40–0.44ms，且三个文件量级完全一致**（0.9MB / 5.5MB / 34.1MB 的 p50 同为 0.41ms）⇒ 追加写是 **O(1)**，"历史越大写越慢"这个前提不成立；按每步 1–3 条算，省下的是 **1.2ms/步 ≈ 步墙钟的 0.04%**（中位步 2.9s）。而代价是**三条写路径必须协同**：带缓冲的 `append` 之外，`setEntryUsage` 是**整文件 temp+rename**、`repairTornTail` 是 **truncate**——任一条在缓冲非空时落盘都会**静默丢掉尚未 flush 的内存条目**（rename 换掉整个 inode，与 K1.5 禁常驻 fd 同类但更隐蔽），再加 5 处屏障（退出三路 + 轮末 + 压缩前）与最长 250ms 崩溃丢失窗口。**复活条件**：每步数十条写入的真实场景 / append 不再是 O(1) / 会话层整体改成"有界队列 + 后台刷盘"并把另两条写路径一并纳入同一队列。
- **K2.4（已完成）**：`setEntryUsage` **尾部优先反查** + **幂等早退**。实测病灶是"自头 `findIndex` + 逐行 `JSON.parse`"——对唯一调用点（终轮补 usage，补的正是最后一条）就是整文件（真机最大 transcript 5.05MB/1155 行：全量反查 31.4ms）。现在尾部最多扫 8 条非空行、未命中逐字回退，**回退路径语义不变**（用 parse 次数验证：末条 ≤8 次 vs 中部 750+ 次，≥50×）。**原子性刻意保留** temp+rename：可选的"原地 patch"能再省 33ms/轮，但把"崩溃=文件完好"降级成"崩溃=该行损坏"，与 K2.3 同判。
- **K2.5（已完成）**：撕裂尾部修复。病灶**不是"读不了"**——`readLines` 与 `server/transcript.mjs:156-171` 本就逐行 try/catch 跳过坏行并计 `skipped`，故「加载不报错」在修复前也是绿的（空跑）；真病灶是**残行缺尾换行 ⇒ 下次 `appendFileSync` 与之黏连 ⇒ 新条目整行 parse 失败、静默丢失**。修法：末尾非 `\n` 时，完整 JSON 尾行**只补 `\n`**（零字节损失，`dropped=0`），真·半行则 `truncateSync` 到最后一个 `\n` 之后并按字节数留痕；健康文件走 1 字节探针、**内容与 mtime 逐字节不变**。验证必须走「制造撕裂 → 加载 → 再 append → 重载后新条目仍在」。

---

## §6 阶段 K3 — 推理预算分级

墙钟上最大的杠杆（69% 墙钟在流式生成，其中绝大部分是不可见推理 token），但不是性能优化能单方面决定的事 ⇒ 独立成阶段 + 回退开关。

**链路实测（决定实现方式）**：`normalizeEffort` 只认 `off|low|high|max`（**`medium` 会被映射成 `high`**）；`api.mjs` 的 `effortParam` **把 thinking-enabled 分支排在 `reasoning_effort` 映射之前并直接 return** ⇒ 当前每请求只带 `thinking:{budget_tokens:4096}`，**用户设的 `effortLevel: max` 实际从未发出去**。

- **K3.0 先定「哪个旋钮真的管用」（已完成，结论推翻本阶段前提）**：三臂探针（adaptive 不带 budget / 带 budget 1024·2048·4096 / `reasoning_effort` low·high·max），②③ 两臂走**真实** `kernel/api.mjs`，共 ~59 次调用（n=8/臂/题 × 2 题，含一道可判对错的陷阱题）。凭据只从 `~/.yfw/config.json` 读、绝不回显/落盘。
  **实测（deepseek-v4-flash）**：唯一真正管用的旋钮是 **thinking 的 on/off**——中位墙钟 **3.1×**（1014 → 3120ms）与 **1.5×**（703 → 1064ms），且 **16/16 全对**；`budget_tokens` **不是节流阀**（1024 vs 4096 在 P2 上思考量 305 vs 287，P1 上区间大幅重叠 174–1246 vs 279–2987，轮 1 单样本里 1024 甚至**多于** 4096 ⇒ 非单调）；`reasoning_effort` 两轮方向相反 ⇒ 不可用；`adaptive` 端点**认**（担心的 400 未出现）但**无优势**（1360 字符/2904ms，不优于 4096）。
  **最关键的一条**：同设置内**跑次间方差极大**（budget4096 × P1 思考量 279–2987 字符 = **10.7×**）⇒ **任何"逐步微调档位"的策略都会被噪声吞掉**，这正是四套参考实现里**一个运行时启发式都没有**的原因。
  **bug 级附带发现**：`provider.thinkingEnabled=true` 时桥恒注入 `THINKING_ENABLED=1` ⇒ **每一步都思考**（含摘要/压缩步），而用户设的 `effortLevel: max` 永远发不出去（`api.mjs:1280` 的 thinking 分支先 `return`）——这条即使策略永不开启也该修。
  **范围限定**：仅该模型 + 两道小题 ⇒ 其余 provider 需各跑一次同一脚本；也**不足以**证明 off 在长任务上无损。
- **K3.1 判据（按实测改为二值，范围经用户决策收窄）**：`pickStepThinking → 'on'|'off'`，落在新模块 `kernel/effort-policy.mjs`。`off` **只给摘要/压缩步**（范式 `compact.ts:1305`），其余一律 `'on'`＝**不干预**。**用户 2026-09-13 决策：接受这一档**（"常规步也 off"因质量证据只有两道小题的 16/16 而被否）。原计划的"工具步降一档"**删除**——无档可降；两条运行时**升档**启发式**刻意不写**（在"只降摘要步"范围下永远不可能触发＝死代码，文件顶部写明将来扩大范围时必须与"用户 off 时策略不得开"一起实现）。**保真审计步显式 `'on'`**：它的产出是"摘要漏了什么"的判断本身，关掉思考＝悄悄削弱"抓坏摘要"的唯一自动安全网。
- **K3.2/K3.3 落点与回退**：解析层放一处（把"用户档位被静默丢弃"这个 bug 一并修掉：off → `thinking:{type:'disabled'}`，否则按 provider 的 `thinkingEnabled` → enabled+budget；旋钮二选一，解释器为 `effortParam(effort, thinkingMode)`，优先级 ①策略关思考 ②provider 思考开关 ③`reasoning_effort`）；`PONOS_EFFORT_POLICY=graded|off`，**默认 `graded`**（用户已看过 A/B 表并选定范围；回退＝设 `off`，惰性读 env 保证 `settings.env` 通道生效）。
  - **已落地（两笔）**：① `550cfdf` 保行为部分——`effortParam` 优先级显式化 + `thinkingMode` 贯穿 `streamMessages → anthropicStream → 请求体` + 显式档位被吃掉时每进程落一行诊断（纯函数 `effortDroppedNotice`，`auto`/未知不误报）；② 策略部分——`effort-policy.mjs` + `compact.mjs:callSummaryBody({ thinking })`（单发与**分块**两处传 `summaryThinking()`，审计传 `'on'`）。**`engine.mjs`/`bridge.mjs` 刻意不改**：主路径/lane 是常规步（超出授权范围），而策略 env 经 `settings.json` 的 `env` 直达内核，桥不需要新字段。
  - **测试做法的修正（值得记下）**：原计划写的是「`PONOS_MOCK_API=1` + mock `api.bodies` 断言请求字段」——**做不到**。mock 在 `anthropicStream` 之前就短路了，`body` 根本不会构造；而本 bug 恰恰只在请求字段上可见。改为 `http.createServer` 起本地端点抓**真实**请求体（范式 `api-empty-stream.test.mjs` 的 `withServer`），并用它驱动**真 compactor** 抓摘要/分块/审计三类请求。共 27 例（判据表 5 + 线协议 22）、**八个变异全部被杀**。**其中最值钱的一条**：首版端到端只覆盖了单发摘要路径，变异「分块路径不传 thinking」**存活**——分块夹具需要 35 轮 × 32768 窗口，而默认夹具只有 6 轮。教训两条：**观测点必须选在「事实发生的那一层」**（mock 看不到的东西别指望它断言）；**「策略生效」的测试必须覆盖该策略的每一条分支**，否则漏掉的正是小窗口/大 covered 会话那条路。

---

## §7 阶段 R — 渲染层（内核之后）

前两条是「每帧同步 IO」与「整店订阅 → 整树重建」。

- **R1 每帧日志双写**（**已落地**）：每帧 `console.log` → 主进程**两次** `statSync+appendFileSync`。实测：renderer-console.log 22 小时写了 **17MB**。**次序很重要：先门控短路（不构造字符串），再谈缓冲**——两者都在 `createRendererConsoleSink.handle()` 里，门控在最前。
  - **判据的形状由真实日志回放决定，不由直觉决定**（本节最重要的一条）。发射点 `src/hooks/useYFWCLI.ts:174` 只有一种形状：`[WS] recv: <msg.type> <sid> <data.type>`。全量 4 个日志文件里 `event` 129,694 行（98.5%），其中 `assistant` 127,833 行（98.6%）；到达间隔 **p50=76ms / p10=22ms（峰值 45 行/秒）**。初版判据写成前缀 `[WS] recv:`，回放显示它**会连带采样掉当天 487 行诊断里的 396 行（81%）**：kernel-stderr 转发（唯一的内核诊断入口）与紧随 assistant 帧到达的 `tool_result`(975)/`result`/`ponos_warning`(10)——后者是状态迁移与告警，不是噪声。**"高频前缀"这种按家族下刀的判据在这里是错的**，正确判据是**形状**：`/^\[WS\] recv: event \S+ assistant\b/`，只认"帧级正文复本"这一种噪声。
  - 采样不是丢弃：被吃掉多少条记在下一个放行行上（`(+N 条同类被采样)`），所以**"什么都没记"这种最坏情况结构上不可能出现**；异常行另有第二道豁免（`RENDER_ALERT_RE`，实测在窄判据下命中 0 次，价值在判据将来被放宽时——`warn` 不设词边界，因为 `ponos_warning` 里 `_w` 之间没有 `\b`）。
  - **实测（同一段真实到达序列 15,344 行 / 2.83h，新旧两套实现各回放一遍）**：墙钟 14,198ms → 1,634ms（**−88.5%**）；落盘 1,974KB → 501KB（**−74.6%**）；append 30,688 → ~3,170 + 批量；每行主进程**同步**耗时 0.93ms → 0.11ms（45 行/秒峰值下 42ms/s → 5ms/s 的主进程阻塞）。放行率 20.7%（非判据行全量 + 窗口放行）。
  - **范围诚实说明**：渲染器**仍然**每帧 `console.log` 并按帧发一条 IPC（实测 ~1.5 条/秒；判据在主进程，IPC 已发生）。R1 消掉的是**主进程侧的双写与字符串构造**；渲染器那个"1.35 核"属于 R3/R4/R5 的战场，不要记在 R1 账上。
- **R2 uiStore 瞬时态**（**已落地**）：已亲证 `zustand@4.5.7` 的 `set` **无条件** `setItem()`（`partialize({...get()})` + `localStorage.setItem`）⇒ 每帧 2 次同步全量序列化。**在 store action 里 `set(() => ({}))` 不是短路**，唯一有效的原地修法是**在调用 `set` 之前提前 return**。
  - **落地时改了方案**：原首选"把瞬时态移出 persist store"**没做**——`partialize` 白名单本来就不含这两个骨架键，症状不在白名单，而在 zustand 的无条件 `setItem`（移出 store 要动 `useYFWCLI` 的 6 个调用点，是跨模块重构）。改用**两层互补**：① 四条瞬时态 action 在 `set` 前提前 return（连 `partialize`/`stringify` 都不跑，**且不换 state 引用**）；② 新增 `src/lib/stableStorage.ts` 包住 `createJSONStorage`，**逐字节相同即跳过写盘**——这一层是**结构性兜底**，管住 ① 够不着的白名单外键变化（编辑器内容/`previewFile`/附件），也让"缺陷悄悄回来"必须显式改掉 storage 才行。
  - **落地时补掉的一个设计缺口**：去重缓存冷启动时没有基线 ⇒ 冷启动后的第一次写入必然穿透。修在**设计**里（惰性读一次盘上现值做基线），不是把断言改松。`removeItem` 必须清基线（否则 remove 后写回同值会被当成"没变"而静默丢失）。
  - 静态收益：`useYFWCLI.ts:883-884` 对**每个** `event` 帧清一次两个骨架键（帧率 p50≈13/秒、峰值 45/秒）⇒ **26–90 次同步全量 `JSON.stringify`+`localStorage.setItem`+整店订阅者重建 / 秒 → 0**。
- **R3 拆「整店 → 整树」链**（**已落地**）：`WorkShell` 的 `useChatStore()` / `useUIStore()` **无选择器**，而它直接渲染 `<ChatWindow>` ⇒ 任何写入都重建整棵消息树。**R2×R3 叠加**：即使假短路 `set` 也产生新 state 对象 → 每帧白送 2 次整树重渲染 ⇒ 「提前 return」同时消掉两处，是性价比最高的一处改动。
  - **增量转换的键为什么可以是对象身份**：**先核实过** `chatStore` 的消息更新是 copy-on-write（`{ ...m, content }`），从不原地 mutate ⇒ 未变消息引用跨帧稳定。`statusKey`（`running/complete`，**按位置**算）必须入键，否则流式结束时最后一条会永远停在 running。WeakMap ⇒ 无泄漏。
  - **memo 的边界在这儿是"不收 props 的组件"**：三个消息视图的内容全部经 `MessagePrimitive.Root` 的 context 流入，所以默认浅比较就是"无需比较"；参考实现里那个"比较器显式豁免回调 props"的写法针对的是**收 props** 的组件，照抄会写出一段没有作用的比较器。该模式的实质（别让内联对象/回调击穿 memo）落在"部件表提为模块级常量 + render prop 用 `useCallback` 稳定"上。
  - **两条 memo 语义用真 React 实测**（Electron 无头窗口 + 官方 UMD React 18.3.1，零新依赖）：父级重渲染 ×3 ⇒ 对照组 1→4、**memo 组件恒 1**；只改 context ⇒ **memo 组件 1→2（context 穿透 memo）**。前者是收益来源，后者是正确性底线（流式追加的那条必须更新，不能读到旧内容）。
  - **顺带清掉的同类缺陷**（全在同一条链上）：`ChatWindow` 订阅 `conversations` **整数组**（流式每帧换新数组）→ 拆 5 个原始值选择器；`ChatContext.Provider` 的 `value` 内联字面量 → `useMemo`；两处**从未被使用**的订阅与两个死 import 直接删除。
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
| 落盘 = 有界队列 + 后台刷盘 + **显式 flush 屏障** | codex `rollout/src/recorder.rs:979,1031,1052`；deepseek `session-persistence/.../coordinator.ts:1325` | K2.3（**实测否决**：省 0.04%/步 却引入三类静默丢写，见 §5） |
| 追加型日志撕裂尾部修复 | `pi-main/.../session/jsonl/storage.ts:38-41,89-105` | K2.5（**已完成**；病灶是"黏连"而非"读不了"，见 §5） |
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
| 推理降档损伤质量 | **范围收窄到摘要/压缩步**（产出是结构化摘要，质量风险几乎为零，有 `compact.ts:1305` 先例），常规步一律不干预；用户看过 A/B 表后 2026-09-13 决策启用；一键回退 `PONOS_EFFORT_POLICY=off`。**保真审计步不降**（它是"抓坏摘要"的唯一自动安全网）。**已知残留**：用户全局 `effortLevel:'off'` 时审计步仍会思考（一次 512 token 调用），未纳入本次范围 |
| 合帧渲染改变观感 | 已选进取档；保留开关回退 |
| 日志采样降低诊断密度 | 错误与慢路径全量；`[perf]` 默认关、采样率可配。**R1 的实际教训**：真正会"降级诊断"的不是采样本身，而是**判据太宽**——宽判据（`[WS] recv:`）实测吃掉当天 81% 的 kernel-stderr 转发行，且因为 assistant 帧密集，`tool_result` 这类状态迁移几乎必然被误伤。⇒ 判据按**形状**而非家族写，并把"判据必须窄"用测试钉死（M9/M10） |

---

## §10 验证

1. `npm test`（基线 1061 条 / 1 skip）+ `npm run typecheck`。
2. 每阶段前后对比 `[perf]` 的每步字段。
3. K3 前后：A/B 表 + 3–5 个真实任务对比（**别指望自动化质量回归**）。
4. 新增测试全放**新文件**（避开并行 WIP 的 `fidelity.test.mjs` / `app-*.test.mjs`）。
5. 端到端护栏（免费）：`app-tools-mount` / `api-protocol` / `overflow-loop` 已断言每轮请求体的历史内容，缓存一旦返回陈旧历史必红。
6. release 同步门：先 `diff -rq` 再逐文件覆盖；**不跑 `scripts/package-portable.cjs`**。
