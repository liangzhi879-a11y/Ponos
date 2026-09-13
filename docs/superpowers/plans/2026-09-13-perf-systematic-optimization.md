# 任务运行慢 · 系统性优化 · 实施计划（内核优先 → 渲染层）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「每步 420–680ms 的内核固定开销」压到 5–8ms/步，消掉桥侧同步 spawn 尖峰，并在内核之后修掉渲染层「每帧同步 IO + 整店订阅 → 整树重建」两个吃满一个核的根因。**不改产品语义。**

**Architecture:** 观测先行（K0）→ 内核每步只算一次（K1，靠对象身份 + `contentEpoch` 双计数器保证可证不陈旧）→ 磁盘/只读路径剪枝与水位线缓存（K2）→ 推理预算分级（K3，默认关）→ 渲染层（R）。

**Tech Stack:** 内核 Node ESM（零外部依赖，仅 `node:*` 与仓内相对路径）；测试 `node --test`（Node 24，`.mjs`/`.ts` 可直跑）；前端 React 18 + zustand + Tailwind；**无新依赖**。

**设计依据：** `docs/superpowers/specs/2026-09-13-perf-systematic-optimization-design.md`（本计划逐节对应其 §1–§10）

**上游：** `C:\Users\T203-15\.claude\plans\snug-kindling-fog.md`（含实测表、参考实现对照全表）

## Global Constraints

- **内核零外部依赖**：`kernel/**` 只能 import `node:*` 与仓内相对路径；`scripts/build-kernel.mjs` 打包仍需成功。
- **请求面语义冻结**：`patchOrphanToolUses` 补孤儿 tool_result 的位置硬约束、溢出瘦身副本「取用即消费」、`freeShrink` 老化语义——一律不改。
- **契约纯增量**：新增字段/事件必须可选；老 GUI 忽略、老内核缺字段时前端按默认。
- **静默降级**：优化与观测的异常一律 try/catch，**不得抛穿 `runTurn`**。
- **缓存可证不陈旧**：只缓存「本步窗口内不可变」的数据；每项缓存独立 env 开关（`PONOS_ESTIMATE_CACHE` / `PONOS_DYNTOOLS_CACHE` / `PONOS_REQUEST_FACE_CACHE`），**一次只开一个**。
- **禁止**把 `session.append` 改成常驻 fd：`setEntryUsage` 的 `writeFileSync+renameSync` 会换 inode → **静默丢写**。
- **测试 hermetic**：`env: {}` 隔离 + `PONOS_MOCK_API=1`；**新增测试全放新文件**（避开并行 WIP 的 `fidelity.test.mjs` / `app-*.test.mjs`）。
- **回归基线**：`npm test`（1061 条 / 1 skip）+ `npm run typecheck`；除本计划新增用例不得有新增失败。
- **不新增 npm 依赖**、不跑 `scripts/package-portable.cjs`、`release/` 覆盖前先 `diff -rq`。

---

## 文件结构（本计划锁定）

| 文件 | 动作 | 职责 |
|---|---|---|
| `kernel/perf.mjs` | 新建 | 观测内核：`perfCount`/`perfAdd`/`perfTime`/`perfMark`/`perfSpan`/`perfStep`/`perfLine`，`PONOS_PERF` 惰性开关 + **按 key** 重入保护（K1.4 增 `reqHit` 字段） |
| `kernel-tests/engine-perf-log.test.mjs` | 新建 | K0 契约：行数=步数、step 连续、字段齐全、关开关时零输出、settings.json 通道也生效 |
| `server/diag-info.test.mjs` | 改 | K0.2 契约测试补 `loopDriftMs`/`loopDriftMaxMs` 初值 + 埋点存在性断言 |
| `electron/diag-monitor.cjs` | 改 | K0.3 `checkRenderHealth` 附渲染帧指标（**只加 detail，不改 status 判据**） |
| `kernel/context.mjs` | 改 | K1.1 估算器记忆化 + `contentEpoch`（`bumpContentEpoch()` / `contentEpoch()`） |
| `kernel-tests/context-cache.test.mjs` | 新建 | K1.1 命中/反例（`freeShrink` 后必失效）/密度 env/性能红线 |
| `kernel/compact.mjs` | 改 | K1.1 `freeShrink` 内 `bumpContentEpoch()`（两处原地改写点） |
| `kernel/engine.mjs` | 改 | K0 埋点、K1.3 惰性 firstByte、K1.4 `createRequestFace`、K3 档位状态与消费点 |
| `kernel-tests/engine-request-face.test.mjs` | 新建 | K1.4 同 revision 同引用 / `rev+1` 重建 / `contentEpoch+1` 保险丝 / 顺序不变式 / session 写路径 bump |
| `kernel-tests/engine-adaptive-firstbyte-lazy.test.mjs` | 新建 | K1.3 惰性提供者调用次数与语义等价 |
| `kernel/session.mjs` | 改 | K1.4 `revision`、K1.5 `dirEnsured`、K2.3 写队列 + `flushSession()`、K2.5 尾部修复 |
| `kernel-tests/session-append-dir.test.mjs` | 新建 | K1.5 只建一次目录 + **目录被删后不得静默丢写**（含变异验证）+ 不得常驻 fd 的反向守卫 |
| `kernel/cli.mjs` | 改 | K1.2 视图闭包内工具表缓存（`syncAppPermissionRules` 仍在缓存外） |
| `kernel-tests/dyntools-cache.test.mjs` | 新建 | K1.2 命中/失效/权限副作用/异常不缓存 |
| `kernel/dyntools.mjs` | 改 | K1.2 `toolSourceSignature()` + `createToolsViewCache()`（LRU≤8）；`buildWorkflowTools` 挂非枚举 `sourcePaths` |
| `kernel/workflow-dsl.mjs` | 改 | K1.2 `discoverWorkflows` 元数据补 `path`（文件级签名的输入集 = 发现层实际读过的文件） |
| `kernel/readonly.mjs` | 改 | **K2.0 已完成**（`todayFrom()` + 闭区间 `[今天,今天]`）；K2.2 `(mtime,size)` 剪枝；K2.5 尾部修复 |
| `server/kernel-readonly.mjs` | 改 | **K2.1 已完成**（`kernelReadonly()` 异步 + kill/封顶/单飞；同步版保留给测试） |
| `server/bridge.mjs` | 改 | K0.2 耗时日志、**K2.1 已完成**（`/api/usage` 改 `await`）、K2.2 水位线缓存 |
| `server/kernel-readonly-async.test.mjs` | 新建 | **K2.1 已完成**（不阻塞事件循环 / 逐字节对齐同步版 / 超时 kill / maxBuffer / 单飞 / 源码守卫） |
| `kernel-tests/usage-scope.test.mjs` | 新建 | **K2.0 已完成**（10 条：今日口径/UTC 零点边界/闭区间/`session` 不回归/入口透传/变异验证） |
| `src/hooks/useYFWCLI.ts` | 改 | K0.3 帧指标采集（内存环形缓冲 + 5s 上报）、R1 日志门控、R5 队列压力判据 + 16ms 调度 |
| `electron/main.cjs` | 改 | R1 单一咽喉的前缀采样/限流 |
| `src/stores/uiStore.ts` | 改 | R2 瞬时态 action「调用 `set` 之前提前 return」 |
| `src/components/layout/WorkShell.tsx` | 改 | R3 整店订阅 → 选择器 |
| `src/lib/chatRuntime.tsx`、`src/components/chat/ChatWindow.tsx` | 改 | R3 按身份增量转换、稳定 render prop、`memo` |
| `src/components/chat/MarkdownText.tsx`、`src/lib/utils.ts` | 改 | R4 `useMemo` 稳定表 + 前缀冻结 + `sanitizeText` 改正则 |
| `docs/bridge-contract.md` | 改 | 仅当 K3 新增可选字段时增补 |

依赖顺序：Task 1（K0）**必须先落地并采一轮基线** → Task 2–6（K1，每项独立可提交）→ Task 7–10（K2）→ Task 11（K3.0 探针，独立）→ Task 12–16（R）。

---

### Task 1: K0 观测基线（内核 + 桥 + 渲染帧）

**Files:**
- Create: `kernel/perf.mjs`、`kernel-tests/engine-perf-log.test.mjs`
- Modify: `kernel/engine.mjs`（埋点）、`kernel/context.mjs`（`est=` 计数）、`kernel/tools.mjs`（`dynHit=`）、`server/bridge.mjs`（K0.2 + K0.3 上报端点）、`src/hooks/useYFWCLI.ts`（K0.3）、`electron/diag-monitor.cjs`（K0.3）、`server/diag-info.test.mjs`（契约测试补新字段）

**Interfaces（后续任务依赖，不得改名）:**
```js
export function perfOn()                              // 惰性读 PONOS_PERF
export function perfCount(key, n = 1)                 // 计数
export function perfAdd(key, ms)                      // 累计一次调用 + 毫秒
export function perfTime(key, fn)                     // 包一层，返回 fn() 结果（同键重入只记最外层）
export function perfTimeAsync(key, fn)                // 同上，await 段
export function perfMark(name) / perfSpan(key, from)  // 异步边界打点；perfSpan 取用即消费
export function perfBegin() / perfReset()
export function perfLine(turn, step)                  // → '[perf] turn=… step=… ms=… pre=… est=… …'
export function perfStep(turn, step)                  // 发一行 + 清账 + 给新步打起点
```

- [x] 写 `kernel/perf.mjs`：`let on = null; const perfOn = () => (on === null ? (on = process.env.PONOS_PERF === '1') : on)`（**必须惰性**：`cli.mjs` 的 `settings.env` 注入在所有 ESM 求值之后）
- [x] 关闭时 `perfTime` 直接 `fn()`，**零 `performance.now()` 调用**
- [x] ~~重入保护：嵌套时 `depth>0` 只计数~~ → **有意偏差**：改为**按 key 的重入保护**（`active: Set<key>`）。原设计的全局 `depth` 是错的——`preStep`（key=`pre`，异步）内部就调用 `est`/`req`/`tools`，全局 depth 会让这三个真正的头号指标在每轮里**全部漏记**（实测会退化成 `est=0`）。按 key 保护达到同样的「一次 88ms 不被记 5 遍」效果，且不误伤。
- [x] `kernel/engine.mjs` 主循环迭代开头（`iter` 之后、`await preStep()` 之前）发**上一步**汇总；轮末补最后一步（**选迭代头是为了一处覆盖十余处 `continue` 出口**）
- [x] 挂点：`pre=` 包 `preStep()`；`est=` 在 `estimateRequest` 导出层；`req=` 包 `requestMessages`；`tools=` 包 `dynamicView`；`ttfb=`/`gen=`/`tail=` 用 `perfMark`/`perfSpan`（异常出口同样打 `genEnd`，否则本步 tail 段缺失）。`dynHit=` 留待 K1.2 填。
- [x] K0.2 `server/bridge.mjs`：只读端点（`/api/usage`、`/api/audit`）加 `ms=` 耗时日志 + 事件循环漂移探针（`diagInfo.loopDriftMs/loopDriftMaxMs`，>50ms 才记，探针 expose 于 `/diag/info`）
- [x] K0.3 渲染帧指标（帧数/单帧 ms p50,p95/真实帧间隔 p50,max/是否降频）→ 每 5s POST `/diag/render-frame` → `diagInfo.renderFrames` → `checkRenderHealth` 的 `detail`。**不落 uiStore**；**只加 detail 不改 status 判据**（阈值化 warn 会在长消息流式期常态误报）
- [x] 测试 `kernel-tests/engine-perf-log.test.mjs`：三用例——默认关（零 `[perf]` 且轮次照常收尾）、`PONOS_PERF=1`（行数=步数、step 连续 0..N-1、字段形状、`est/req/tools≥1`）、`settings.json` 的 `env.PONOS_PERF='1'` 通道（锁惰性读）
- [ ] **采一轮真实基线并记录**（后续每项改动都要有前后数据背书）——**待用户在应用内跑**：把 `PONOS_PERF=1` 放进 `~/.yfw/settings.json` 的 `env`（或启动前设环境变量），跑一个真实长会话任务，`[perf]` 行落 `~/.yfw/logs/kernel-stderr.log`

**K0 已产出的实测样例**（mock 两迭代回合，验证链路通）：
```
[perf] turn=1 step=0 ms=123 pre=1/3.5 req=4/0.4 est=3/2.7 tools=2/2.2 dynHit=0 ttfb=35 gen=0 tail=83
[perf] turn=1 step=1 ms=117 pre=1/0.6 req=4/0.1 est=3/0.6 tools=1/0.8 dynHit=0 ttfb=39 gen=77 tail=0
```
（`est=3`/步与外部探针"3–6 次/步"吻合；`tail` 含工具执行时长；末步 `tail=0` 属设计——轮末无下一迭代头。）

**验收**：`[perf]` 行能回答「每步 pre/gen/tail 各占多少、估算与工具表各付了几次几毫秒」。

---

### Task 2: K1.1 估算器记忆化（最大头）

**Files:** Modify `kernel/context.mjs`、`kernel/compact.mjs`；Create `kernel-tests/context-cache.test.mjs`

- [x] `context.mjs` 增 `contentEpoch()` / `bumpContentEpoch()`（进程内计数器，模块级）
- [x] `estimateTokens`/`estimateMessage`/`estimateHistory`/`estimateRequest` 按**对象身份** WeakMap 记忆化，键 = `身份 + contentEpoch + 密度指纹`
- [x] **同时做消息级与块级**：string 分支与 system 项每次都新建字面量对象，只做块级会**恒 miss**。string 分支走 `estimateTokensUncached`（新字面量不可能命中，不往 WeakMap 塞垃圾）；`system` 段**刻意不缓存**（`systemPrompt` 是字符串且可被 `setSystemPrompt` 整体替换，一次 ~20KB，收益小风险大）。
- [x] `compact.mjs` **两处原地改写点各自紧邻**调 `bumpContentEpoch()`（`:59` `ageOutToolResults` + `:199` `freeShrink`）。**有意偏差**：原计划"写在 `freeShrink` 内"不够——`ageOutToolResults` 是导出函数、会被独立调用（`compact-safety.test.mjs:83` 就单独调它），写在 `freeShrink` 里会漏掉这条路径 → 陈旧。
- [x] `PONOS_ESTIMATE_CACHE` 开关（默认 **on**，可单独关）；**容量不需要 LRU**（键是活着的对象，随 GC 回收；参考实现里涨到 300MB 的是字符串键的会话级 Map）
- [x] 测试 `kernel-tests/context-cache.test.mjs`（8 用例）：两次估算逐字段相等且第二次 < 首次 1/5；**反例**——老化清除 / 结构裁剪两条改写路径后估值必须下降（**不 bump epoch 必红**）+ 纪元保险丝；密度 env 进键（改系数重算、恢复回原值）；关缓存值不变；2.5MB 连调 3 次 < 200ms；边界输入零回归

**K1.1 前后实测**（1.75MB / 1500 条合成历史，同夹具 `PONOS_ESTIMATE_CACHE=0` vs 默认）：

| | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| 关缓存 | 24.9ms | 18.7ms | 18.2ms |
| 开缓存 | 20.3ms | **0.71ms** | **1.39ms** |

每步是「1 次冷算 + 2–5 次命中」⇒ 每步估算成本 `3–6 × 20ms ≈ 60–120ms` → `~22ms`；跨步也命中（`deriveMessages()` 推的是 `entry.message` 引用，只有新增的几条冷算）。

---

### Task 3: K1.2 工具视图缓存（第二）

**Files:** Modify `kernel/cli.mjs`、`kernel/dyntools.mjs`、`kernel/workflow-dsl.mjs`；Create `kernel-tests/dyntools-cache.test.mjs`

- [x] `toolSourceSignature()`：各 root 的 `readdirSync` **名字列表** + 已知工具文件 `(mtimeMs,size)`（**不要逐项 stat**）
- [x] 缓存只包**工具表构造**；**`syncAppPermissionRules` 必须每次求值都跑**（有副作用，是"进/离控制台即生效"的主机制）——测试里既从**行为侧**（绑定/解绑后 `rules.ask` 必须变化）也从**结构侧**（`cli.mjs` 里该调用必须早于 `viewCache.get(sig)`）钉死
- [x] 缓存**带容量上限（≤8）+ LRU**（教训：无上限 Map 曾涨到 300MB+）→ 抽出 `createToolsViewCache({max:8})`，命中重插队尾（否则退化成 FIFO）
- [x] 异常/无法 stat 一律不缓存 → 退化为现状行为；保留 `dynamicView` 的 try/catch
- [x] `PONOS_DYNTOOLS_CACHE` 开关（默认 **on**，惰性读）
- [x] 测试 16 条：同盘面连续 5 次签名逐字相同；新增/删除目录（**不加 sleep**）；名字↔目录互转；改文件改字节数；**等长改写 + `sleep(30)`**（暴露 Windows mtime 粒度）；**权限副作用**；不可 stat 文件 → `null` 不抛；读不到的根 → 与发现层同口径；ENOENT 合法稳定；应用侧 registry/binding/spec 四态；`sourcePaths` 含 legacy 且非枚举；LRU 容器；结构护栏
- [x] 端到端护栏加进 `engine-perf-log.test.mjs`：`rebuilds = Σ(tools − dynHit) ≤ 2`（不设缓存时 ≈ 步数 × 6，被静默关掉即红）

**「不要逐项 stat」被实测证实**（本机 Windows / Node 24，真实 home）：

| 签名方案 | 实测 | 结论 |
|---|---|---|
| 名字列表（技能根 64 项 + 工作流根 2 项） | 0.217ms + 0.121ms | 采用 |
| 逐项 stat（62 目录的 `<dir>/workflow.yml`） | **4.44ms** | 弃——接近发现层本身 6.13ms，会吃掉全部收益 |
| 递归 `readdirSync(recursive:true)`（483 项） | **35.4ms** | 弃（曾以为一条 syscall 走完子树会便宜） |
| **最终签名**（各根名字列表 + 已知文件 stat + 应用 registry/binding/spec） | **0.68ms/次** | 采用；× 6 次求值/步 ≈ **4.1ms/步**（原 132ms） |

端到端实测（mock 两迭代）：step0 `tools=2/2.1 dynHit=2`、step1 `tools=1/1.1 dynHit=1` ⇒ **稳态构建 0 次**；启动期头两次求值各构建一次（首轮签名尚无文件集，属固有代价，`dynHit` 的 2 次构建落在未开帐时点）。

**有意偏差（3 处，均已记入 spec）**：
1. **多一个导出**：`createToolsViewCache`（原计划只写「dyntools 新增一个导出」）。理由：容量上限/LRU 埋在 cli 闭包里等于零测试覆盖，而它挡的正是 300MB 那类事故。
2. **`kernel/workflow-dsl.mjs` 也改**（原文件结构表列为「不改」）：`discoverWorkflows` 的元数据增加 `path`，使文件级签名的输入集**恰好等于发现层实际读过的文件**（含 legacy/不可见/超限者）。纯增量字段：两个消费者（`cli.mjs:574` 提示词、`:801` `workflow_result`）都按显式字段取值，不序列化它。
3. **失败语义有意不对称**：根 readdir 失败 → `-`（与 `discoverWorkflows`「读不到即空」同口径，故**稳定可缓存**，否则"尚未创建工作流目录"这个常见态永远不可缓存）；文件 stat 非 ENOENT 失败 → `null`（不缓存）。测试把两者都钉住。

**残留（计划原本只登记了「同刻度同字节数改写」，此处补第二条）**：在**既存目录**内新增 `<dir>/workflow.yml` —— 父目录名没变（名字列表看不见）、又不在已知文件集里 ⇒ 需等该根条目增删、某已知文件被编辑、或重启内核。常见写入路径均不受影响：新建工作流 = 新增目录名、编辑已有工作流 = 文件条目、绑定/解绑 = `binding.json`。二期由桥侧 `tools_dirty` 显式失效信号收口。

---

### Task 4: K1.3 `adaptiveFirstByteMs` 惰性化（第三）

**Files:** Modify `kernel/engine.mjs`；Create `kernel-tests/engine-adaptive-firstbyte-lazy.test.mjs`

- [x] 把 firstByteMs 从**值**改成**惰性提供者**：`makeIdleWatchdog` 只在「已等到 baseMs」时才求值（返回值只可能是 `{0, baseMs, 600_000}` 三者之一）
- [x] 语义等价：新阈值 ≥ 旧阈值 ⇒ 只可能**延后** trip，不可能提前掐断
- [x] 现有 `engine-adaptive-firstbyte.test.mjs` 签名不变，必须全绿
- [x] 测试：立即 `stop()` → 提供者调用次数 0；阈值放宽后 `tripped===false` 且只求值一次（真实 `sleep(30)`，无假时钟）

**实现要点**：`gateMs = lazy ? ms : Math.min(ms, constMs)`——提供者形态下检查门槛取 `ms`，靠「引擎侧提供者恒 ≥ ms」保证不早于应有阈值；`firstThreshold()` 把求值结果**缓存**（含抛错兜底为 `ms`，避免每个 timer 周期重试）；常量形态三者（阈值/门槛/timer 周期）仍全按常量算，**与旧版逐字一致**，故 `firstByteMs < ms` 的历史用法不受影响。

**实测**（本机 Windows / Node 24，合成历史按块结构对齐真机请求面）：

| 请求面 | 消息数 | JSON 大小 | 旧：每请求无条件求值 | 新：正常首字节 |
|---|---|---|---|---|
| 中位 273KB | 208 | 145KB | **1.19ms** | **0** |
| 最大 295KB | 224 | 157KB | **1.90ms** | **0** |
| 长历史（原计划的 16.7ms 档） | 1835 | 1.32MB | **9.22ms** | **0** |

计划里写的 16.7ms 出自另一份夹具（tool_result 块更多）；按**真机实际请求面**（`[perf]` 采到的中位 273KB）应记 **1.2–1.9ms/请求**，即每步省 ~1–2ms、每轮省几十毫秒——**量级不大但代价为零**（惰性化不引入任何新状态），且历史越长收益越大。

**唯一行为差异在时机，不在结果**：提供者被调用的**时点**从「每请求一次（在 `makeIdleWatchdog` 之外，调用点求值）」变成「仅当 prefill 超 `ms` 仍零数据时一次」，调用**次数**也从恒 1 变成常态 0。返回值路径不变——`adaptiveFirstByteMs` 自带 try/catch（抛错返回 `baseMs`），而 `makeIdleWatchdog` 侧对提供者抛错再加一层兜底为 `ms`，两层都指向同一宽限值。惰性化**不引入任何新状态**，回退 = 把调用点改回 `adaptiveFirstByteMs(requestMessages, STREAM_FIRST_BYTE_MS)`（1 行）。

**有意偏差**：`makeIdleWatchdog` 由模块内私有**改为导出**（供测试直接驱动 timer 语义）。原计划的测试清单（`stop()` → 0 次、放宽 → 只求值 1 次）若只测 `adaptiveFirstByteMs` 无法覆盖"提供者是否真被惰性调用"，故导出。纯增量导出，无消费者变化。

**未覆盖的形态（测试未钉、代码已处理）**：`state.gotData` 为真后**不再**求值（测试 `有数据后按 ms 判生成停顿` 钉住 `calls === 0`）；提供者返回小于 `ms` 的值仍会 trip（`提供者返回 < ms` 用例）；`ms <= 0` 的 no-op 形态下连 timer 都不起（`守卫关闭` 用例）。

---

### Task 5: K1.4 `requestMessages()` 记忆化（第四）

**Files:** Modify `kernel/engine.mjs`、`kernel/session.mjs`、`kernel/perf.mjs`、`kernel-tests/engine-perf-log.test.mjs`；Create `kernel-tests/engine-request-face.test.mjs`

- [x] 抽 `createRequestFace({getBase, getSkip, getSystem, getRevision})` 工厂并**导出**（纯逻辑可单测）
- [x] 键 = `(session.revision, historySkip, systemPrompt 引用)`——**绝不把 20KB systemPrompt 拼进 key 字符串**
- [x] `session.mjs` 增 `revision`，与 `invalidate()` **同址**（结构上不可能不同步）
- [x] **唯一别名点人工确认**：`fitRequestToWindow` 早退原样返回入参引用，被 `engine-fit-request.test.mjs:21-22` 的 `assert.equal(r, msgs)` 钉死 → **PR 描述里必须点名**
- [x] `PONOS_REQUEST_FACE_CACHE` 开关（默认 **on**）
- [x] 测试：同 revision 返回**同一数组引用**且计数版 `patch` 只被调 1 次；`rev+1` 必重建；`contentEpoch+1` 即使 `rev` 不变也必须重建；注入"每次返回新对象"的 patch → 断言重建后是新值

**实测**（261 条 / 102KB 合成历史 + 20KB 系统提示，一步按真实调用次数 5 次求值）：

| | 请求面 5 次求值 | 含 5 次全量 `estimateRequest` |
|---|---|---|
| 关缓存 | 1.02ms | 5.15ms |
| 开缓存 | **0.04ms** | **1.23ms** |

直接收益 ~1ms/步（25×），联动收益 ~3.9ms/步——**同一数组身份让下游 K1.1 的估算从"每步 5 次冷算"塌缩为"1 次冷算 + 4 次命中"**（残余 1.23ms 即那次冷算，含刻意不缓存的 ~20KB system 段）。

**有意偏差（2 处）**：
1. **`revision` 有两处 +1 而非一处**：除 `invalidate()` 外，`deriveMessages()` 的**真实重建**分支也 +1。原计划「与 `invalidate()` 同址」只覆盖"写路径记得调 invalidate"的假设；加第二处后，任何**忘记** invalidate 却改了 `nodes` 的路径也会因 `nodes.join` 键变化触发重建 ⇒ 必然 +1。两处都触发时最多多失效一次（只多算、不会错算）。同时把 `rebuildSurface` 里直接 `deriveCache = null` 改为调 `invalidate()`，使「置空缓存」全仓仅一处。
2. **新增 `[perf]` 字段 `reqHit=`**（同步改 `engine-perf-log.test.mjs` 的 `LINE_RE` 与断言，加 `reqBuilds ≤ 步数+1` 护栏）。理由：没有它，「缓存被静默关掉 / 失效键写错导致恒 miss」与「优化生效」在 `req=` 的毫秒上长得一样（都是 ~1ms/3.9ms），无法在真实任务里区分——而 K0 的全部意义就是让每项 K1 改动有前后数据背书。范式同 K1.2 的 `dynHit`。

**两个实测澄清（都改写了测试的写法）**：
- **systemPrompt 的键比较实际是「内容比较 + 身份快路径」**：V8 会驻留相同的字符串字面量，`===` 在字符串上先比身份、不等时再比内容。故测试里"同内容不同对象"**仍命中**——这比原计划设想的纯引用比**更好**（`setSystemPrompt` 传等值新串不白付重建），代价只是命中路径上一次 ~20KB memcmp（µs 级）。测试改为断言两个真实方向：内容变必重建 / 同内容不误判。
- **`memoryRev`（无 session 的直连模式）必须有**：`deriveHistory()` 在无 session 时走 `memoryHistory.filter(...)`，**每次新建数组** ⇒ 身份天然不稳，且 `session.revision()` 不存在。故在 `memoryHistory` 声明旁加 `memoryRev`，并让**唯一写入点** `pushMemory` 同址 bump（与 session 侧同一手法）。

**范围决策（有意不做）**：lane 路径的 `msgs()`（`engine.mjs` 内 `patchOrphanToolUses(store.deriveMessages())` + 拼前缀）**不套工厂**——全文件仅 `retryStream({messages: msgs()})` **一处调用**，一步只求值一次，记忆化零收益。少一处改动、少一处风险。

**顺序不变式（最容易写错的一处，已单测钉死）**：工厂**先 `getBase()` 再 `getRevision()`**。因为 `revision` 在重建时才 +1，若反序，遇到"已 invalidate 但尚未重建"的窗口会先读到旧纪元、再拿到新数组 ⇒ 把新结果存在旧键下，白丢一次命中（第二次求值仍 miss，第三次才命中）。`顺序不变式：写入后首次求值即建档，同行第二次求值就命中` 用例即为此设。

---

### Task 6: K1.5 `session.append` 的 `mkdirSync` 去重

**Files:** Modify `kernel/session.mjs`；Create `kernel-tests/session-append-dir.test.mjs`

- [x] `dirEnsured` 标志（与构造期重复的 `mkdirSync` 去掉）
- [x] **不得改成常驻 fd**（`setEntryUsage` 会换 inode → 静默丢写）——写进代码注释
- [x] 回归：`npm test` + `node --test "kernel-tests/*.test.mjs"`

**实测**（交替先后测量同一行代码，抵消磁盘缓存/杀软扫描的时序偏置，400 次取中位）：`mkdirSync(递归, 目录已存在)` + `appendFileSync` = **0.401ms/条** → 仅 `appendFileSync` = **0.221ms/条**，省 **0.181ms/条**（近半）⇒ 按 1–3 条/步 = **0.18–0.54ms/步**。

**有意偏差：新增测试文件 `kernel-tests/session-append-dir.test.mjs`**（原计划只有"回归：npm test"，无新文件）。理由：省掉"每次都 mkdir"会**删掉旧实现的一条隐含自愈语义**——目录在运行期被删时（用户清理 `~/.yfw`、测试夹具 `rmSync`），旧实现靠每次都 mkdir 自愈，新实现若只省不补，`appendFileSync` 抛的 ENOENT 会被 `catch` 静默吞掉 ⇒ **内存里有这条消息、磁盘上没有**。这正是最该被测试钉住的一类静默丢写，故：
- 补 `ENOENT` 分支：清标志、重建目录、**重试一次**（只重试一次，其余错误与旧实现一致地吞掉）；
- 6 个用例：常态落盘顺序、**删除目录后新写入必须真的落盘**（不静默丢写）、反复删除每次都能恢复（标志正确复位，非一次性）、磁盘不可写时不抛且内存可用、`setEntryUsage` 换 inode 后仍写进新文件（"不得常驻 fd"的反向守卫）、恢复会话是追加而非截断。
- **已做变异验证**：把 ENOENT 分支短路（`if (false && …)`）后，恰好两个自愈用例转红、其余四个仍绿 ⇒ 用例非空转。

**测试自身的边界（写测试时踩到）**：删 `projects` 目录等于连 transcript 文件一起删掉，**旧内容必然没了**（旧实现同样如此）。故断言写的是"新写入落盘"而非"内容复活"——第一版断言 `['删除前','删除后']` 是错的。

**二期未做（计划原列，仍延后）**：`setEntryUsage` 的行反查快路径（先看末行，未命中再全量扫）——每轮 ≤1 次，收益小、风险在正确性，留待 K2.4。

---

### Task 7: K2.0 `scope=today` 日期下推（第一优先，现存 bug）

**状态：已完成（commit `K2.0`，测试 `kernel-tests/usage-scope.test.mjs` 10 条全绿，变异测试 7/10 转红）**

**Files:** Modify `kernel/readonly.mjs`（`src/lib/usageUi.ts` **未改**——修在内核侧，一处覆盖 CLI 与 bridge 两条入口）；Create `kernel-tests/usage-scope.test.mjs`

- [x] `runUsage` 里 `scope==='today'` 时推导日期窗口（复用现成的 `ts.slice(0,10)` 比较）
- [x] 改动前对照 `docs/superpowers/plans/2026-09-08-agentloop-prod-upgrade.md:267-272,598` 的 `runReadonly` 契约
- [x] 测试：造跨越两天的 transcript → `scope=today` 只统计今天；`scope=all` 口径不变

**实施中的两处修正（与本任务原描述不同，均有测试/契约背书）**

1. **`to` 必须一起推导（闭区间）**，原描述只推导 `from`。只给 `from` 会让窗口变成 `[今天, ∞)`：机器时钟回跳/NTP 校正写出的"未来条目"会被算进「今日」——**静默多算**，正是本次要修的病灶方向。实测用的跨天夹具直接把这条暴露成了红测（`6 !== 2`，把次日条目也算了进来）。
2. **`scope` 实为两类语义**，文档化契约（`specs/2026-09-08-agentloop-prod-upgrade-design.md:65`）里只有 `session|project|all` 且它们是**分组维度**（`bySession` 开关，过滤靠独立的 `sessionId`/`project` 参数），`today` 是 GUI 引入的**时间窗口**。故新增「不回归」测试：`scope='session'` 的多天总量必须与 `'all'` 逐字节相等。`today` 不在原契约内 ⇒ 本次是纯增量，无破坏面。

**实测（240 文件 / 33.4MB / 48000 条夹具；中位值）**

| 项 | 实测 |
|---|---|
| `collectTranscriptFiles` 全量解析 | 470.7ms |
| `runUsage` all | 557.6ms |
| `runUsage` today（本次改动后） | 477.3ms |
| **聚合侧净省** | **80ms = 14%** |
| 真实 CLI 全进程 `--usage`（`execFileSync`） | 809ms（其中纯启动+模块加载 150ms = 19%） |
| 只解析"当天写过"的文件（K2.2 剪枝后模拟） | **14.2ms** |

**结论（与原计划判断相反，须据此调整后续优先级）**：K2.0 的价值是**正确性**（UI 文案与数字终于对得上），**不是性能**——`from`/`to` 在 `collectTranscriptFiles:33-40` 里是**逐行 parse 之后**才比较的，故它省掉的是聚合（14%），解析（84%）一分未省。**K2 的性能大头在 K2.2 的剪枝与水位线缓存**（470ms → 14ms 的空间），其次 K2.1（150ms 固定底 + 阻塞桥事件循环）。

**另有一项决定性发现（改变 K2.2 的设计重心）**：同 57MB 夹具下，**文件数**才是乘数而非字节数——240 文件 731ms vs 4800 文件 **3271ms**（4.5×），其中仅 `statSync` 就 218.8ms。这解释了真机 `/api/usage` 的 10.8–19.6s（合成 34MB 夹具只复现出 0.81s，故真机必是**数万个小 transcript 文件**的量级）。⇒ K2.2 的重心是**水位线缓存（命中即零扫描）**，而非"每次轮询都 stat 一遍再剪枝"——4800 文件光 stat 就 219ms，5s 轮询下仍然不够。

> **⚠️ 对上一段末句的事后更正（Task 9 实测推翻）**：「真机必是数万个小 transcript 文件的量级」**是错的推论**。Task 9 直接量了真机 `~/.yfw`：**134 个文件 / 36.8MB / 7 个项目目录**；真 CLI `--usage --scope today` 稳定在 **520–579ms**。故 10.8–19.6s 不是单次扫描的代价，最可能是**同步 spawn 阻塞 × 轮询/调用堆积**的复合值（正是 K2.1 修掉的那部分）。教训：夹具测出的敏感性只说明「文件数是敏感维度」，**不能反推真机规模**——下这种判断前必须先量真机。**4.5× 的文件数敏感性本身仍然成立**（那是夹具实测）。

---

### Task 8: K2.1 `/api/usage` 异步化（现存 bug）

**Files:** Modify `server/kernel-readonly.mjs`、`server/bridge.mjs`

**状态：已完成（测试 `server/kernel-readonly-async.test.mjs` 8 条全绿；变异 D 6/8 转红、变异 A 1/8 转红）**

- [x] 增加异步版（`spawn` + Promise，照 `bridge.mjs:1700-1712` 写法），**保留同步版**给现有测试与离线脚本
- [x] `/api/usage` 路由改 `await`（route handler 本已 `async`，**未改签名**）
- [ ] 验收（**留待用户实机**）：用量面板改前 5s 超时失败 → 改后正常返回

**异步化自己引入的三道责任（原计划漏了，必须自己实现——`execFileSync` 的 timeout/maxBuffer 是免费的）**

1. **超时必须 kill**：超时只 reject 不 kill 的话，子进程挂死会让路由**永久悬挂**——比同步版更糟（同步版超时必返回）。
2. **stdout 必须封顶**：跑飞的子进程会把桥的内存吃光。
3. **同参必须单飞**（把 K2.2 的 `inFlight` 提前到这里）：**同步版把事件循环堵死，反而"天然串行"**；改 async 后 5s 轮询与数秒~数十秒的耗时可以重叠，不设上界就会同时 spawn 好几个内核进程（每个 50–70MB RSS + 全量扫 transcript），在本机（4 核）上比原来的阻塞更糟。同参合并在语义上也正确：同一问题在同一时刻的答案本就该一致。**摘除必须走 settle**（含失败）——否则一次报错会让同参请求永久复用那个 rejection（永久陈旧，比慢严重得多），已单列用例。

**测试的重心是「不再阻塞」而不是「返回值能解析」**：核心用例让异步调用期间挂一个 10ms 定时器，断言**照常触发（≥3 次）**，并对照断言同步版**一次都跑不到（0 次）**——直接度量病灶。变异 D（把异步版退化成「同步跑 + 只包一层 Promise」）让 6/8 转红，其中 `maxBuffer` 用例从 105ms 涨到 **55.5s**，证明 kill 是真杀而不是装饰。

**同类隐患（本次未动，留作后续）**：`server/bridge.mjs` 里仍有同步 `execSync`——`git worktree list`（:2280）、`git branch -a`（:2290）、`netstat -ano -p tcp`（:2693）等，同属"HTTP 路由里同步 spawn ⇒ 阻塞桥事件循环"。`taskkill` 系列是刻意的短阻塞（杀进程路径），可不动。K0.2 的 `loopDriftMaxMs` 探针**保留**，现在专职盯这些剩余路径。

---

### Task 9: K2.2 只读聚合剪枝 + 桥侧缓存

**状态：已完成（测试 `server/readonly-cache.test.mjs` 13 条 + `kernel-tests/readonly-mtime-prune.test.mjs` 5 条全绿；变异 5/5 与 3/3 全部被预期用例杀死）**

**Files:** Create `server/readonly-cache.mjs`、`server/readonly-cache.test.mjs`、`kernel-tests/readonly-mtime-prune.test.mjs`；Modify `server/bridge.mjs`、`kernel/readonly.mjs`

- [x] 桥侧 TTL + **stale-while-revalidate** + 单飞（`readonly-cache.mjs`），`/api/usage|/api/audit` 改走缓存
- [x] 内核侧 **mtime 下界剪枝**（`collectTranscriptFiles`）：把日期窗口下推成"太旧的文件根本不读"
- [x] 实测验收：真机连续两次 `--scope today`，第二次 **0 扫描**（缓存命中，连子进程都不 spawn）
- [ ] 验收（**留待用户实机**）：驾驶舱连看 5s 轮询不再出现用量卡片失败

**与原计划的两处偏离（均有实测背书）**

1. **顺序：先做"命中即零扫描"的**桥侧缓存**，而不是"版本号 + 日期水位线 + 增量合并"**。水位线那条路（范式 `claude-code/src/utils/statsCache.ts`）隐含一个与 K2.0 同款的陷阱：**它省的是聚合，不是解析**——transcript 不是按天分文件的，要找出"水位线之后"的条目仍得**把每个文件读一遍再逐行 parse**。它只有在配上**逐文件持久化聚合**（`{path → (mtime,size) → agg}`）时才有解析收益，那是一个有状态、要版本号/合并/失效的更大改动。而 K2.0 已证明解析占 84% ⇒ 先做**无状态的 mtime 剪枝**（见 2）性价比高一个量级。
2. **②的形态：把"跳过没变的文件"换成"跳过窗口前的文件"。** 两个都无状态，但后者更强也更简单：`scope=today` 下它直接砍掉**全部历史**；前者对"没变过的历史文件"同样只能省解析。`(mtime,size)` 缓存那份"上次扫过的文件清单"仍列为**二期**（它才是 `scope=all` 的真正解法，见文末）。

**内核侧：mtime 下界剪枝（`kernel/readonly.mjs`）**

- 单边剪枝：只跳过 mtime **早于**窗口起点的文件；**绝不按 `to` 反向剪**——append-only 只保证不重写、不保证按日期分文件，一个今天写过的文件完全可能含上个月的条目（已单列测试：跨窗口文件的窗口外条目必须仍在无 `from` 查询里出现）。
- **可靠性论证**（写进了代码注释）：transcript 是 append-only，每行 `timestamp` = 写入时刻，而 mtime = **最后一次**写入时刻 ≥ 任意一行的写入时刻 ⇒ mtime 早于 from 零点则每行写入都早于 from 零点 ⇒ 无合格行。唯一破绽是「取 ts」与「落盘」之间发生**时钟回跳**，故再加 `MTIME_SAFETY_MS`（1 小时）边距。**残余风险已明示**：回跳 > 1 小时且恰好跨 UTC 零点仍会**静默少算**（方向与 K2.0 修掉的"多算"相反）⇒ 留 `PONOS_USAGE_MTIME_PRUNE=0` 一键回退。
- `from` **只认严格 `YYYY-MM-DD`**（正则），其余一律不剪。实测 `Date.parse` 会宽松吃掉 `'2019'`/`'2020'`/`'2020-01'`——其中 **`'2020-01'` 会真的造成分歧**（字符串比较当它是"2020-01 之后"，日期解析却回退到 1 月 1 日零点 ⇒ 剪掉 mtime 在 2019 年末的文件，而里面的 `2020-01-15` 条目本该保留）。故正则不是装饰：去掉它，两条用例立刻转红（已变异验证）。
- `statSync` 失败一律**不剪**（退化为现状行为，宁可多读不可漏算）。

**桥侧：TTL + stale-while-revalidate + 单飞（`server/readonly-cache.mjs`）**

- 四种态：`fresh`（TTL 内命中）/ `stale`（过期：**立即回旧值**，后台刷新）/ `computing`（冷启动未就绪：立刻 503，刷新留后台跑完 ⇒ **自愈**）/ `failed`（等待期间真的失败：**透出原始错误**，绝不伪装成"计算中"——否则 502 退化成含糊的诊断降级）。
- 冷启动只等 `firstWaitMs`（默认 3000ms），**硬约束 < GUI 的 5s 超时**（`src/lib/usageApi.ts`）——等到了也没人接就是白等。该不变量由跨模块测试锁死（测试直接读 `usageApi.ts` 的 `FETCH_TIMEOUT_MS` 常量比对）。
- **后台刷新的 rejection 一律自己接住**：未处理的 rejection 会掀掉整个桥，比单次返回错值严重得多（用例挂了进程级 `unhandledRejection` 监听器断言零外泄，而不是只断言返回值）。
- 键 = 子命令 + flags；env 不必入键（`buildChildEnv()` 里唯一影响聚合结果的是 `CLAUDE_CONFIG_DIR ← YFW_HOME`，模块级常量；已在注释里写明"若 YFW_HOME 变成可热改则必须入键"）。
- 驾驶舱实际只发**一个**键（`fetchUsage({scope:'today'})`，见 `useCockpitOverview.ts:141`）⇒ 命中率就是轮询命中率。TTL 10s = 轮询间隔 2 倍 ⇒ 稳态下**扫描频率降到约 1/3**（每 ~15s 一次全量），其余轮询零扫描。

**实测（真机 `~/.yfw`，非夹具）**

| 项 | 实测 |
|---|---|
| 真机规模 | 134 文件 / 36.8MB / 7 个项目目录；其中**今天写过**的只有 **10 个（5.7MB）** ⇒ 可剪 **92.5% 字节** |
| `statSync` 134 文件 | 8ms（对比 4800 文件夹具的 218.8ms——真机负担小得多） |
| 真 CLI `--usage --scope today`（剪枝前） | 520 / 526 / 579 ms |
| 真 CLI `--usage --scope today`（剪枝后） | **272 / 259 / 238 ms（2.1×）**；余下主要是 ~150ms 进程启动地板 |
| `--usage`（all，无 from ⇒ 不剪） | 不改（约 557ms）——**未动无窗口查询的行为** |
| 剪枝开/关 结果一致性 | `today`/`all`/`session`/`project`/`audit` **五种查询逐字节相同**（sha256 比对） |
| 桥侧缓存命中 | **0 扫描、0 子进程 spawn** |

**二期（本次未做，方案已明确）**：逐文件持久化聚合 `{version, files: {path → {mtimeMs, size, agg}}}`——它才是 `scope=all`/`session` 的真正解法（只解析变过的文件再合并），但需要版本号、合并、失效与并发写保护，且要有一个"内核是短命子进程"下仍然有效的落盘点（`<home>/runtime/` 之类）。届时**不可把水位线当成解析收益**（见偏离 1），必须以**文件级**为单位。

---

### Task 10: K2.3 批量写 + flush 屏障（含 K2.4/K2.5）

**状态：K2.4/K2.5 已完成**（测试 `kernel-tests/session-tail-repair.test.mjs` 7 条全绿；变异 5/5 被预期用例杀死）**；K2.3 经实测否决**，复活条件见文末。

**Files:** Modify `kernel/session.mjs`；Create `kernel-tests/session-tail-repair.test.mjs`（原计划写的 `kernel/readonly.mjs` 属笔误——K2.4/K2.5 都落在 `session.mjs`）

- [x] K2.5：加载时校验尾部是否以 `\n` 结尾，否则修复（完整 JSON 尾行只补 `\n`，真·半行截断到最后一个 `\n` 之后）
- [x] 测试 `kernel-tests/session-tail-repair.test.mjs`（7 条：核心黏连、零丢失、健康文件零改动、中间坏行、尾部快路径、幂等、回退语义）
- [x] K2.4：`setEntryUsage` 尾部优先反查 + 幂等早退（**不做**"复用写队列"——因 K2.3 不做）
- [x] K2.4 的原子性**刻意保留** temp+rename
- [x] 实测代价分解 + 变异验证（下表）

**K2.5：病灶是「黏连」，不是「读不了」**

`readLines`（`session.mjs`）与桥的 `server/transcript.mjs:156-171` **本就**逐行 try/catch 跳过坏行并计 `skipped` ⇒ 半行从来不会让**加载**失败。故若把验收写成"加载不报错"，在修复前也是绿的 = **空跑**。真病灶在**写侧**：`appendFileSync(line + '\n')` 遇到**无尾换行的残行**会把新条目拼到同一行 ⇒ 整行 parse 失败 ⇒ **新条目静默丢失**（连 `skipped` 都只报"一行坏"）。核心用例因此必须走「制造撕裂 → 加载 → 再 append 一条 → 重载后新条目必须在」，而不是只断言 `tornTailDropped > 0`。

修法（`endsWithNewline()` 1 字节探针 + `repairTornTail()`）：

| 盘上尾部状态 | 动作 |
|---|---|
| 以 `\n` 结尾 / 空文件 | **零成本返回**（1 字节探针，不整读；健康文件内容与 **mtime 逐字节不变**——用例显式断言 mtime，锁死"不许顺手重写"） |
| 残行**本身是完整 JSON**（崩溃恰落在对象结尾） | 只补 `\n`：**零字节丢失**，返回 `dropped = 0` |
| 真·半行 | `truncateSync` 到最后一个 `\n` 之后，**返回丢弃字节数并 `console.error` 留痕**（诊断不降级，否则用户只看到"历史少一条"） |
| stat/读/写任一步失败 | **保持原样**（绝不因修复失败而让加载失败） |
| 动盘前 `statSync` 复核发现 size 变过 | **整个放弃本次修复**：`cut` 是基于本次读出的字节算的**绝对**偏移，若这期间有 writer 追加过，`truncateSync` 会把那部分**完整**数据一起切掉（比不修更糟）。这道守卫**无确定性单测**（单线程内本修复是全同步块、没有可插入的交汇点），且触达面极窄——正常 writer 都写 `line+\n` ⇒ 末尾始终是换行 ⇒ 修复根本不启动；能命中它的只有"另一个 writer 正卡在半个行中间"，而那种 writer 自己也要被修。已把这份触达分析写进代码注释 |

中间坏行（**带**换行）不因本次修复被删——它不构成黏连风险，留着供排查（已单列用例）。

**K2.4：尾部优先反查**

调用点只有 `engine.mjs:1049` 的终轮补 usage（`finalizeUsage`，空文本收尾路径），补的**正是最后写入的那条** assistant 条目 ⇒ 原实现的"自头 `findIndex` + 逐行 `JSON.parse`"付的就是**整文件**。

- 从尾部起只扫最多 `TAIL_SCAN = 8` 条非空行；未命中**逐字回退**到原 `findIndex`，**语义不变**（回退路径仍是自头反查）。
- 一处**有意的语义差异**已写进注释：尾部起扫命中的是**最后**一条同 seq 行，原实现命中最先一条。健康文件里 seq 唯一（加载侧按 max+1 重建、append 侧单调），重复只可能来自磁盘损坏——而撕裂尾部已由 K2.5 在加载侧收口。
- 幂等早退：盘上已是目标形态（`lines[idx] === want`）⇒ 连整文件重写都省掉。
- **原子性刻意保留**（`writeFileSync(tmp) + renameSync`）：另一个可选的写法是**原地 patch**（按已知字节偏移 `writeSync` + 空格补齐，实测可再省 33ms/轮），但它把"崩溃 = 文件完好"降级为"崩溃 = 该行损坏"。与下面否决 K2.3 的理由同源 ⇒ **同判**。

**实测（真机最大 transcript：5.05MB / 1155 行 / 均长 4581B）**

| 项 | 实测 |
|---|---|
| `readFileSync` | 18.1 ms |
| `split('\n')` | 3.0 ms |
| 逐行 `JSON.parse`（全量 1154 条） | 13.1 ms |
| 尾部 8 行（同样免 split） | **0.1 ms** |
| 原子重写（temp+rename） | 14.6 ms |
| **原实现合计** | **≈49 ms** |
| **尾部快路径** | **≈33 ms**（省 33%；read+write 占 67%，是 temp+rename 保原子性的**固有**成本） |
| 反查的 parse 次数（1502 行夹具，**这才是被修的病灶**） | 末条命中 **≤8 次**；中部条目 **750+ 次**（回退路径 = 原语义）；两路相差 ≥50× |

**验证用的是 parse 次数而非耗时**：耗时比最多 ~1.5×（被 read+write 的 67% 压住），既弱又受机器抖动影响；而用例只需给 `JSON.parse` 挂一层计数器就能**打准病灶本身**——把 `TAIL_SCAN` 改成 0（永不命中尾部）立刻转红，把幂等早退去掉则 mtime 用例转红。

**K2.3 不做（实测否决，不是延期）**

`appendFileSync` 一条 4.6KB 行实测 **0.40–0.44 ms，且与文件大小无关**：

| 文件 | p50 / 条 | 按每步 1–3 条 | 占步墙钟（中位步 2.9s） |
|---|---|---|---|
| 空（0.9MB） | 0.404 ms | 1.2 ms | 0.042% |
| 5.5MB | 0.436 ms | 1.3 ms | 0.045% |
| 34.1MB | 0.408 ms | 1.2 ms | 0.042% |

追加写是 **O(1)**（不存在"历史越大越慢"），三个量级 p50 完全一致。省 **0.04%** 的代价是**三条写路径必须协同**：除带缓冲的 `append` 外，`setEntryUsage` 是**整文件 temp+rename**、`repairTornTail` 是 **truncate** —— 任一条在缓冲非空时落盘都会**静默丢掉尚未 flush 的条目**（rename 直接换掉 inode，与 K1.5「禁常驻 fd」是同一类事故，且更隐蔽：丢的是**内存里**的条目）。再加 5 处屏障（退出三路 `exit`/`SIGINT|TERM`/`uncaughtException` + 轮末 + 压缩前）与最长 250ms 的崩溃丢失窗口。

⇒ **0.04% 换三类静默丢写风险，不做。** 复活条件（任一成立再评估）：① 出现"每步数十条写入"的真实场景（当前 1–3 条/步）；② 实测显示 append 不再是 O(1)（如落到网络盘）；③ 会话层改成有界队列 + 后台刷盘（参考实现 codex `rollout/src/recorder.rs` 的形状）**并**把 `setEntryUsage`/`repairTornTail` 一并纳入同一写队列——那时"三条写路径协同"这个前提才被真正解决。

---

### Task 11: K3.0 旋钮 A/B 探针（必做前置）

**状态：已完成（结论推翻了本阶段的前提，并改变了 Task 12 的形状）**

**Files:** 探针脚本（临时，不入库，落在 `%TEMP%`）；结论写入本文件 + spec §6

- [x] 三臂探针：① `thinking:{type:'adaptive'}`（**不带 budget**，`effortParam` 产生不了 ⇒ 直连）② `{enabled,budget_tokens:1024/2048/4096}` ③ `reasoning_effort: low/high/max`
- [x] 量「思考字符数 / 正文长度 / TTFB / 总时长 / 是否 400 / **答对与否**」，产出 A/B 表
- [x] ②③ 两臂走**真实** `kernel/api.mjs`（`setProvider()` + `streamMessages`），只有①直连
- [x] 凭据只从 `~/.yfw/config.json` 现读进本进程内存，**未回显、未落盘**
- [x] 三轮共 ~59 次调用：轮 1 每设置 1 次（噪声盖过效应）→ 轮 2 每设置 4 次 → 轮 3 每设置 8 次 × 2 题（含一道**可判对错**的陷阱题）

**A/B 表（deepseek-v4-flash，temperature=0，n=8/臂/题，两题合计）**

| 设置 | P1 箱子题 思考中位（极值） | P1 总中位 | P2 均速陷阱 思考中位 | P2 总中位 | 答对 | 400? |
|---|---|---|---|---|---|---|
| `thinking:{type:'disabled'}` **（off）** | 0 | **1014 ms** | 0 | **703 ms** | **16/16** | 否 |
| `{enabled,budget_tokens:1024}` | 525（174–1246） | 2456 ms | 305（198–367） | 1178 ms | 16/16 | 否 |
| `{enabled,budget_tokens:4096}`（**现状**） | 893（279–2987） | 3120 ms | 287（184–333） | 1064 ms | 16/16 | 否 |
| `thinking:{type:'adaptive'}` | 1360（340–2305） | 2904 ms | 311（196–352） | 1200 ms | 16/16 | 否 |
| `reasoning_effort: low / max`（轮 1+2） | 710 / 423（**两轮方向相反**） | 2334 / 2000 ms | — | — | 8/8 | 否 |

**结论（六条，全部有数）**

1. **唯一真正管用的旋钮是 thinking 的 on/off**：中位墙钟 P1 **3.1×**（1014 → 3120 ms）、P2 **1.5×**（703 → 1064 ms），且 **16/16 全对**。
2. **budget 不是节流阀**：1024 vs 4096 在 P2 上思考量几乎相同（305 vs 287），P1 上区间大幅重叠（174–1246 vs 279–2987）；轮 1 的单样本里 1024 甚至**多于** 4096（2091 vs 1462）⇒ **非单调**。
3. **`reasoning_effort` 在该端点不可用**：轮 1（low 545 / high 1473 / max 594）与轮 2（low 710 / max 423）方向相反，无单调性。讽刺的是它是当前代码里**唯一被静默丢弃**的字段。
4. **`adaptive` 端点认**（本计划担心的 400 **未出现**）但**无优势**：P1 思考 1360 字符 / 总 2904 ms，不优于 4096。⇒ 不必为它加分支。
5. **同一设置内的跑次间方差极大**（budget4096 × P1：279–2987 字符 = **10.7×**）⇒ **任何"逐步微调档位"的策略都会被噪声吞掉**。这正是四套参考实现里**一个运行时启发式都没有**的原因——本仓若做，只能是**阶段边界**。
6. **bug 级附带发现**：`provider.thinkingEnabled=true` 时桥恒注入 `THINKING_ENABLED=1`（`bridge.mjs:914-915`）⇒ **每一步都思考**（含摘要/压缩步），而用户设的 `effortLevel: max` 永远发不出去（`api.mjs:1280` 的 thinking 分支先 `return`）。
   中性副作用：off 臂的正文**更简短也更听指令**（P2 的 out=3 token 就是「4 km/h」；开思考时 out≈114 token = 额外解释）。

**范围限定（不许外推）**：仅 **deepseek-v4-flash** 一个模型、两道小题、每臂 n=8。其余 provider（minimax / vLLM Qwen）**必须各跑一次同一脚本**才能下同样结论——尤其 MiniMax 按 `api.mjs:1284` 的注释「不显式 `thinking:enabled` 则思考完全不可见」，其 off 臂语义可能与 deepseek 不同。质量信号也仅限这两题：**不足以**证明 off 在长任务（多文件改动/规划）上同样无损。

---

### Task 12: K3.1–K3.3 推理预算分级

**状态：部分完成 —— 「保行为 + 消静默」部分已提交（`550cfdf`）；「策略」部分待用户决策后再落**（`PONOS_EFFORT_POLICY` 默认 `off`，见下方最后一条）

**Files:** Modify `kernel/engine.mjs`、`kernel/api.mjs`、`server/bridge.mjs`；Create `kernel-tests/effort-policy.test.mjs`、`kernel-tests/effort-wire.test.mjs`

**形状变更（数据驱动，非偏好）**：原计划的四档阶梯（`medium/low/high/max`）**在本 provider 上不可实现**——budget 与 `reasoning_effort` 两个旋钮实测都不控思考量（Task 11 结论 2/3），而唯一有量级效应的旋钮是 **thinking 的 on/off**（结论 1：3.1× / 1.5×，16/16 全对）。故判据降为**二值** `pickStepThinking(input) → 'on' | 'off'`，同时更贴近四套参考实现（阶段边界 + 配置，**零运行时启发式**）。用户原话「常规步 medium / 疑难步 max」的**意图**（常规步少思考）保留，但载体不得不换成开关。

- [ ] `pickStepThinking(input)` 纯函数：`off` **只给已知安全的阶段**——摘要/压缩步（范式 `claude-code/src/services/compact/compact.ts:1305`：其产出是结构化摘要，不需要探索性推理）；**其余一律 `on`（= 维持现状）**，不做"工具步降一档"（无档可降）
- [ ] 运行时启发式只保留两条**升档**：上一步 `tool_result` 为 `is_error` → `on`；紧跟压缩/溢出瘦身后的第一步 → `on`
- [ ] **只降不升 + 用户优先**：用户 `effortLevel: 'off'` 时策略**不得**开；策略只能把 `on` 变 `off`
- [ ] 解析层放**一处**：合法值/别名/未知值降级全写死在解析函数里
- [x] 落点：`api.mjs:effortParam` **明确优先级**（① `thinkingMode==='off'` 或用户 `off` → `thinking:{type:'disabled'}`；② provider 的 thinkingEnabled → enabled+budget；③ 其余档位 → `reasoning_effort`；旋钮二选一，绝不并发），**消除"用户档位被静默丢弃"**（Task 11 结论 6——这条即使策略永不开启也该修）。`thinkingMode` 已贯穿 `streamMessages → anthropicStream → 请求体`（默认 `null`，现状行为逐字节不变），**策略层入口就位但尚无调用方**。诊断由纯函数 `effortDroppedNotice(effort,{thinkingEnabled,budget})` 给出，每进程落一行（`auto`/未知档位不提示，避免误报）。
- [ ] 落点（策略，未做）：`engine.mjs` 档位状态 + 主路径/lane 两个消费点传入 `thinkingMode`；`server/bridge.mjs` 增加策略字段（与 `thinkingBudget` 同区）
- [ ] `PONOS_EFFORT_POLICY=graded|off`，**默认 `off`**：Task 11 已有数据，但"改变模型行为"这一档要用户**看过 A/B 表再开**
- [x] 测试：`kernel-tests/effort-wire.test.mjs`（**18 例，全绿；五个变异全被杀**）。**修正原计划的做法**：`PONOS_MOCK_API=1` **断言不了请求字段**——mock 在 `anthropicStream` 之前短路，`body` 根本不会构造，而本 bug 恰恰在请求字段上。改为直连本地 `http.createServer` 抓真实 body（范式 `kernel-tests/api-empty-stream.test.mjs` 的 `withServer`），断言 (env, 档位) 整张矩阵 + 两旋钮互斥不变量 + 「档位以外的字段逐字段不变」。判据表（`kernel-tests/effort-policy.test.mjs`）随策略一起落。
- [ ] **仍不做**：`adaptive` 分支（结论 4：无优势）、budget 钳制（不选 budget 即无需那个 `-1`）

---

### Task 13: R1 停掉每帧日志双写

**Files:** Modify `electron/main.cjs`、`src/hooks/useYFWCLI.ts`

- [ ] **先门控短路**：未开 perf / 级别不够时**直接 return，不构造字符串、不调 console**
- [ ] 再上缓冲（`flushIntervalMs=1000`、`maxBufferSize=100`、溢出走 `setImmediate`、退出强制 flush）
- [ ] 在 `main.cjs:1445-1461` 这条**单一咽喉**按前缀采样/限流（error 与慢帧全量），一处改动覆盖所有调用点

---

### Task 14: R2 uiStore 瞬时态（务必与 R3 一起修）

**Files:** Modify `src/stores/uiStore.ts`

- [ ] 五个瞬时态 action 全部改为**在调用 `set` 之前提前 return**（在 action 里 `set(() => ({}))` **不是短路**）
- [ ] 首选方案：把 `kernelStalls`/`firstByteWait` **移出 persist store**（persist 用白名单）
- [ ] 验收：流式期不再每帧写 localStorage

---

### Task 15: R3 拆「整店 → 整树」链

**Files:** Modify `src/components/layout/WorkShell.tsx`、`src/lib/chatRuntime.tsx`、`src/components/chat/ChatWindow.tsx`

- [ ] `WorkShell` 的两处整店订阅改**选择器**
- [ ] `chatRuntime` 的 `?? []` 与每帧重算改为**按 message 身份增量转换**
- [ ] 内联 render prop 换稳定 `useCallback`；`AssistantMessageView` 加 `memo`；比较器**显式豁免回调 props**、内容按数组逐项比
- [ ] 内联 `components={{...}}` 提为模块级常量；注意 `MessageBubble.tsx` 已是**死代码**，不要复活

---

### Task 16: R4/R5/R6 渲染层其余三项

**Files:** Modify `src/components/chat/MarkdownText.tsx`、`src/lib/utils.ts`、`src/hooks/useYFWCLI.ts`、`src/components/chat/ChatWindow.tsx`

- [ ] R4：`{...MD_COMPONENTS, p}` 与 `preprocessBoxDrawingTables` 用 `useMemo`；`sanitizeText` 逐字符拼接 → **正则**；进一步**冻结稳定前缀、只重解析不稳定尾块**
- [ ] R5：`streamHeavyMode` 判据换成**队列压力**（队列深度 / 最老未处理项年龄 + 滞回），**不用 rAF**（后台/失焦停摆）改 16ms 定时器；按进取档做 100–150ms 合帧
- [ ] R6：长列表 containment 或虚拟化（**量化 scrollTop + `useSyncExternalStore`**，仅对确定的长会话启用）

---

## 验证与交付

- [ ] `npm test`（基线 1061 / 1 skip）+ `npm run typecheck`：除新增用例无新增失败
- [ ] 每 Task 独立提交、独立可回退；提交信息用 `perf(kernel): …` / `perf(ui): …`
- [ ] K1 全部落地后跑同一会话同一任务，比 `[perf]` 的每步字段（目标：内核固定开销从 420–680ms/步 → 5–8ms/步）
- [ ] `scripts/verify-gui-fidelity.mjs` 增加「长会话 N 条消息」计时用例（该脚本现无任何 timing）
- [ ] release 同步：先 `diff -rq` 再逐文件覆盖，备份到 `release/_backup_before_perf_<时间戳>/`；**不跑 `scripts/package-portable.cjs`**
- [ ] 更新 `docs/manual/YFWorking产品使用说明书.md`（仅当有用户可见行为变化：合帧观感、用量口径修正）
