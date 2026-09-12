# 内核会话韧性设计（2026-09-12）

> 事故驱动设计：2026-09-12 一天内反复"前端卡死"，逐层排查出桥树杀（架构缺陷）、
> EPIPE 崩溃、会话无限膨胀、轮次静默结束（parked 态）四类问题。本文把它们收敛为
> 一套可落地、可回归、有人工兜底的生产级韧性方案。
>
> 状态：部分已上线（标注 ✅）；其余为待办任务（T1-T7），归属与验收见文末。

---

## 1. 事故链实证（当天证据）

| # | 形态 | 证据 | 根因定性 |
|---|---|---|---|
| A | 内核"无声消失"（marker 无 exitCode、无日志、无 .err） | runs/ 目录 marker 与 tasklist 对照 | **桥树杀**：`electron/main.cjs` 外部桥回收用 `taskkill /F /T`（main.cjs:302-308），旧桥 spawn 的内核会话陪葬，零通知 |
| B | 内核写流崩溃 EPIPE | kernel-stderr.log 崩溃栈（protocol.mjs:10 → engine.mjs:938） | A 的次生：管道因桥死而关闭，stdout 异步 error 无监听 |
| C | 会话无限膨胀 | 单轮 67 次工具调用、请求面 317KB、会话 292 条消息、[api] POST 日志 | 缺"单消息聚合预算"（CC 200K 聚合 / pi 双上限都有，本内核没有）；DS 大请求流反复中断的温床 |
| D | 轮次静默结束（parked 态） | V8 inspector 尸检：仅剩 stdio 三句柄（fd 0/1/2）、零定时器、零 fetch 套接字、零子进程 | 引擎某收尾路径丢失续体（具体行未定位）；事件循环清醒但无任何任务排程——stdin cancel 也无人处理，是"尸体" |
| E | 前端孤儿会话 | renderer-console.log：`[WS] closed: 1006` → 重连新桥 | 新桥无旧会话状态，永不补发 closed/result；GUI 流式状态无人清理 |

## 2. 目标不变量

1. **任何应用重启/退出不产生无声死亡的内核**：每个内核要么被有序终止（marker 清理、
   transcript 落盘），要么被收养继续服务；强杀只作为超时兜底存在。
2. **任何轮次必须收敛**：`runTurn` 任意路径都以 result/error 收口；"静默结束"不是
   合法状态，由不变量测试把关。
3. **守卫只兜外部世界**（网络断、进程被强杀、上游异常）：自家模块缺陷必须由
   不变量测试抓住，而不是靠运行时守卫掩盖。
4. **人工兜底面对的必须是可响应实例，不是尸体**：任何时刻用户按下"停止"，
   内核要么在 6 秒内有序应答，要么被强杀——不存在"点了停止也没反应"的内核。

## 3. 现状架构与耦合点

```
electron/main.cjs ──spawn──► node server/bridge.mjs ──spawn──► node kernel/cli.mjs（每会话一个）
     │                            │  WS(51517)                      │ stdout NDJSON → 桥 → GUI
     └── 单实例/桥回收/健康监控      └── sessions map                  └── stdin 控制帧（cancel 等）
```

耦合缺陷：内核的生命周期**完全**依附于桥进程（stdin/stdout 管道 + taskkill /T 树杀）；
桥死 = 内核死且无任何有序收尾。GUI 又依附于桥的 WS（1006 → 换桥 → 孤儿会话）。

## 4. 设计：四层防线

### L1 预防——让异常形态不发生

| 项 | 设计 | 状态 |
|---|---|---|
| 单条工具结果落盘 | >20K 字符落盘 + `<persisted-output>` 预览（P0-3，engine.mjs persistToolResult） | ✅ 既有 |
| **单消息聚合预算** | 同一 user 消息内 tool_result 合计 >100K 字符（`CLAUDE_CODE_TOOL_RESULT_BATCH_BUDGET`）→ 从大到小落盘替换（Read 豁免）。纯函数 `applyAggregateResultBudget`（engine.mjs，可单测） | ✅ 已上线（4 测试） |
| **消息数阈值压缩** | 会话消息数 >120 条时触发主动压缩（与 token 阈值并行）——token 维度未达阈值的"长尾会话"（今日 292 条实证）在消息数维度先触顶 | T1（见任务清单） |
| 请求面稳定前缀 | 系统提示/技能块 spawn 时定型、会话内不重排（prompt.mjs composeSystemPrompt 无时间戳注入） | ✅ 现状保持，纳入回归 |

### L2 自愈——异常发生后自动恢复（现状记录）

| 层 | 机制 | 参数 |
|---|---|---|
| 流读空闲 | `withIdleTimeout(reader.read(), 300-600s)` → StreamInterrupted → 重连 ≤3 次（api.mjs） | `CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS` |
| 引擎空闲看门狗 | 无块超时 → abort → 无感续写注入（IDLE_HEAL_MAX 默认无限，engine.mjs:902-1045） | `PONOS_STREAM_IDLE_MS` / `PONOS_STREAM_FIRST_BYTE_MS` |
| 输出截断自愈 | max_tokens 截断 → 升档续写（16K→32K→64K，≤2 档，engine.mjs CONTINUE_HEAL_MAX） | `PONOS_CONTINUE_HEAL_MAX` |
| 进程级硬看门狗 | 轮次激活 + wire 无输出 >10 分钟 → exit(7) + marker.err **句柄指纹**（cli.mjs:242-265） | `PONOS_KERNEL_HARD_TIMEOUT_MS` |
| 前端孤儿会话 | WS onclose 静默定稿 → bridge_hello 换桥识别 → 自动静默续接（useYFWCLI.ts） | ✅ 已上线 |

### L3 有序终止——桥与内核生命周期解耦（替代树杀）

**原则**：桥可以死，内核必须善终；强杀是超时兜底，不是默认路径。

1. **桥侧**（`server/bridge.mjs`）：新增 `/shutdown` 路由（主进程专用，同机校验）：
   对 sessions 中每个内核注入终止控制（复用既有 cancel 协议帧）→ 等待内核有序
   退出（≤3s，内核退出时 marker 清理、transcript 落盘由既有优雅路径完成）→ 桥退出。
2. **主进程侧**（`electron/main.cjs`）：两处树杀改为"先协商后强杀"：
   - 外部桥回收（main.cjs:302-308）：先 `POST /shutdown` → 3s 超时 → `taskkill /T` 兜底
   - 健康监控判死（main.cjs:389-401）：同上（先 shutdown 再树杀）
3. **内核侧**：终止控制帧已有完整语义（cli.mjs control_request cancel → engine.abort
   → 优雅收尾）。**新增一条**：终止帧到达后 10s 内必须退出（进程级），否则硬看门狗
   退出路径兜底（复用 exit(7) 通道，fingerprint 标记 `shutdown-timeout`）。

**验收**：重启应用 100 次，`runs/` 目录无新增无 exitCode 的 marker（不变量 1 的量化形式）。

### L4 人工兜底——停止键永远有效，人面对的不是尸体

**核心缺陷修复（今日实证）**：桥的 cancel 兜底条件为 `_lastOutAt > _cancelAt`
（"仍在产出才强杀"，bridge.mjs:2551-2559）——**尸体（零输出）永远不会被强杀**，
用户点停止面对的就是一个永不响应的进程。修复：

1. **cancel 未确认即强杀**：注入 cancel 后 6s，若内核未退出且无任何输出（未确认）
   → `taskkill /T` 强杀 + 广播 cancelled。健康内核在 cancel 后数秒内必然应答
   （abort 传导到 in-flight fetch/工具），6s 无应答即判尸体。
2. **尸体识别**（诊断面板可读）：
   - marker.err 句柄指纹："stdio-only + 零定时器 + 零 fetch" = 失活签名（已上线）
   - bridge `/diag/info` 增加 per-session 状态（进程存活、距上次输出秒数、cancel 挂起态）
3. **人工操作手册**（写入诊断面板文案）：
   - 点「停止」→ 必杀（新逻辑）；杀后 GUI 解锁（closed/cancelled 处理已齐）
   - 重启应用 → 桥换新 → 自动静默续接（已上线）
   - 极端情况（连桥也尸体）→ 硬看门狗 10 分钟上限保证内核尸体寿命有界；桥尸体由
     主进程健康监控/重启计数兜底

**验收**：mock 一个"无视 cancel 的内核"（复用 `[mock:hang-forever]` 形态）→
点停止 → 6s 内进程消失 + GUI 解锁 + cancelled 广播（不变量 4 的量化形式）。

## 5. 落地任务清单

| 任务 | 内容 | 归属 | 验收 |
|---|---|---|---|
| T1 | 消息数阈值压缩（>120 条 → compact） | 我（等并行批次合入 compact.mjs 后） | 消息数超阈会话在下一轮边界触发 compact；kernel-tests 覆盖 |
| T2 | bridge `/shutdown` + 会话级终止协调 | 并行会话（bridge） | 单测：3s 内所有内核有序退出、marker 清理 |
| T3 | main.cjs 两处树杀改协商-兜底 | 并行会话（main.cjs） | 重启 100 次无新孤儿 marker（可脚本化抽检） |
| T4 | 内核终止帧 10s 强制退出 | 我 | 测试：注入终止帧后无视 → 10s exit(7) + fingerprint |
| T5 | **cancel 未确认即强杀**（bridge.mjs 兜底条件修正） | 我 | ✅ 已上线：`server/cancel-corpse.test.mjs` 尸体内核 + 停止 → 6s 强杀 + closed 广播（293/293） |
| T6 | turn-must-settle 不变量测试 | 并行会话（engine 验收门） | runTurn 任意输入 N 秒必 settle，否则 CI 红 |
| T7 | /diag/info 会话状态 + 诊断面板尸体识别文案 | 并行会话（diag） | 尸体会话可见"未确认 cancel/失活指纹"提示 |

## 6. 不变量测试清单（CI 门槛）

1. `engine-hard-watchdog`：失活 → exit(7) + 指纹；正常轮间不误杀（✅ 已有）
2. `engine-continue-heal`：截断升档续写 / 顶档收尾 / 开关关闭（✅ 已有）
3. `engine-toolresult-aggregate`：聚合预算替换 / Read 豁免 / 未超不复制（✅ 已有）
4. T5：尸体内核停止键 6s 强杀
5. T6：turn must settle（任意路径）
6. T3：重启孤儿零新增（抽检脚本）

## 7. 风险与回滚

- **T2/T3 优雅关闭引入新路径**：shutdown 协商失败必须回退到现状（taskkill /T），
  行为降级而非功能损失；T2 先于 T3 落地（桥侧先行、主进程后切）。
- **T5 误杀风险**：健康内核在长 Bash 中收到 cancel 可能 >6s 应答——评估后若存在
  此类工具，改为"cancel 后 6s 未确认 → 先 killActiveChildren 再等 3s → 强杀"
  的两段式（内核侧 killActiveChildren 已存在，tools.mjs）。
- **T1 压缩激进度**：消息数阈值默认 120 偏保守；上线后按会话健康度观测再调。
- 所有 env 旋钮均有 `=0` 关闭语义，异常时可现场回退。

---

## 附：今日已上线改动索引（本 spec 依据）

| 文件 | 内容 |
|---|---|
| `kernel/engine.mjs` | 聚合预算 `applyAggregateResultBudget` + P0-3b 接线；截断自愈（CONTINUE_HEAL_MAX） |
| `kernel/cli.mjs` | 进程级硬看门狗 + 句柄指纹；EPIPE 优雅退出 |
| `kernel/protocol.mjs` | wire 最后输出时刻 / 轮次激活标记（硬看门狗输入） |
| `kernel/api.mjs` | `[mock:hang-forever]` 尸体模拟分支（T5 测试复用） |
| `server/bridge.mjs` | bridge_hello 实例握手 |
| `src/hooks/useYFWCLI.ts` | WS onclose 静默定稿 + 换桥自动续接；closed 补 stopStreaming；渲染自适应降频 |
| `server/provider-profile.mjs` | 云端输出预算默认 16K；toolResultBudgetBytes 注入 |

---

## 8. 追加（2026-09-12 17:40，来自"卡在思考界面"专项排查）

> 只读排查（4 份 app.log 全量 116,858 帧 + kernel-stderr + transcript 探针），结论：
> UI 抱怨的主因不在"某处丢了帧"，而在**等待信号到了渲染器却没有出口**（F）＋
> **无界会话从不压缩**（G）。另发现三条生命周期缺口（H/I/J）。

### 8.1 新证据

| # | 形态 | 证据 | 定性 |
|---|---|---|---|
| F | **等待信号已送达，UI 出口被收窄** | 桥 `first_byte_pending` **每 30s 一条、连续数分钟**：17891871 在 07:24:43→07:30:53 共 16 条；17891845 在 03:56:51→03:58:31、04:11:07→04:12:37、04:17:10→04:18:40 三段。渲染器 `[WS] recv:` 逐条收下。**出口现状**：2026-09-10 起这些悬浮条被「收栏」进 `RightStatusRail`，但该栏**仅在 `rail==='task'` 时挂载**（WorkShell.tsx:194）⇒ chat 模式零出口；且默认折叠为 36px 图标条，秒数只在 hover tooltip 里（RightStatusRail.tsx:120/218-226/316+）。旧三个悬浮组件已不在构建产物中（bundle 里各 0 次，而帧类型串 `first_byte_pending`/`kernel-stall` 各 1 次 = 帧被识别、组件不在产物里；`src/lib/warningUi.ts` 归约器无人消费）。⇒ 5 小时的长等待：chat 模式只剩静态"思考中…"，task 模式只剩一枚需悬停的转圈图标 | **UI 出口缺口（非丢帧）** |
| G | **无界会话 + 压缩从不触发** | 17891871（transcript `8c7517aa`）：**单条用户消息 → 599 个模型步 / 630 次 tool_use / 5h13m**；请求面 body 445097B→477898B、msgs 727→767（09:35:51→09:38:03 两分钟 +40 条）单调上涨；每步可见文本中位 ~41B（末 100 步），602 步合计 50KB；模型时间中位 2.2s / p90 7.5s / 最大 65.2s；全窗口 **0 次 compact 事件** | **T1 的现场（阈值 120 条 vs 实际 767 条）** |
| H | **流式中断后无收口（结构成因已定位于 K/L，非"漏设某一处超时"）** | 17891845 静默 2006s、17891871 静默 2911s：起点前各有 **3 次连续 POST**（重试）后彻底无声，**远超所有已设上限**（STREAM_FIRST_BYTE 480s / 自适应 600s / STREAM_IDLE 600s / 硬看门狗 600s）。桥侧 `kernel-stall` 全天仅 1 条（`_turnActive` 为假即跳过；且 `armFirstBytePending` 的 5s 守卫一旦判假即 return，**不再重建后续心跳**——bridge.mjs:2419-2428） | **超时链缺口** |
| I | **会话状态泄漏 → 内核永不回收** | `_pendingApprovals` 全代码仅 1 处 `delete`（bridge.mjs:2699，且只删"本次回执的那个 id"）⇒ 取消/超时/内核退出均不清；回收器却用它做豁免（bridge.mjs:2366）。实测：pid 6736（17892015）静默 **53 分钟**、pid 21196（17891979，其审批帧在 WS 空窗内发给了 0 个客户端）静默 13 分钟，均无 `idle kernel reaped`。**闭环的另一半**：`_turnActive` 同样是**整体豁免**（bridge.mjs:2364），而它只由 `result` 帧解除——内核挂死时永不发 `result` ⇒ 桥的 10min 回收器**永不动手**，失速守卫（420s）又只告警不杀（bridge.mjs:2402）⇒ 挂死内核**没有任何外部收口**，只能用户手杀（pid 6736/21196 即此形态） | **回收器与等待状态耦合缺陷** |
| J | **等待中被误回收** | `04:43:51 idle kernel reaped: sid 17891871 (idle 10m)` 落在 `04:34:01 question` 与 `04:46:47 question-resolved` **之间**——用户作答时内核已被回收，回答落空（与既有「工作流宿主会话已退出」同族） | **L3/L4 同族** |
| K | **引擎侧可无限续命，唯一硬边界被三处削弱** | 轮级墙钟 `PONOS_TURN_TIMEOUT_MS` 默认 **0＝关闭**（2026-09-10 取消 30 分钟上限，engine.mjs:74/875/1006）；自愈上限 `IDLE_HEAL_MAX`/`MELTDOWN_HEAL_MAX`/`REPEAT_HEAL_MAX` 默认全 **-1＝无限**（engine.mjs:154/164/165）。唯一硬边界 = cli 硬看门狗（kernel/cli.mjs:249，默认 600_000，需 `isTurnActive()`），而它被三处削弱：① 与自适应首字节**同值 600s**（engine.mjs:118；同值共四处：cli.mjs:249 / engine.mjs:118 / engine.mjs:1619,1714 / api.mjs:993-1000）；② `protocol.mjs:13` **写前**更新 `lastWireWriteAt` ＋ 每次自愈都写 `guard_heal` 帧（engine.mjs:1059-1074）⇒ **续命本身重置看门狗**；③ 审批/提问等待期**无任何暂停机制** ⇒ 用户等待 >600s 即被 `exit(7)` 杀掉（与 `PONOS_APPROVAL_TIMEOUT_MS` 600s 同值，谁先到看 60s tick 相位），且自杀前**不写 result/error 帧**（cli.mjs:256-263 → 264），桥只见 `close` | **超时链缺口（根因）** |
| L | **api 层三处 race-reject 不 cancel（孤儿请求）** | ① `api.mjs:931-947` 连接超时只 reject 外层包装 promise（:936），**从不 abort 底层 fetch**；② `api.mjs:1003-1011`+`1283-1299` 空闲超时同样只 race-reject，pending 的 `reader.read()` 与其 response body 永不取消（全文件无 `reader.cancel()`，:1072 只 `releaseLock()`）；③ 两者叠加后一旦 JS 续体失活（无栈无 timer，`api.mjs:887-891` 的 `[mock:hang-forever]` 即此签名），内核侧无任何 deadline 生效，只剩 cli 硬看门狗 | **超时链缺口（机制）** |
| M | **压缩链路现状核实（T1）** | ① kernel 下**不存在任何消息数判据**（`grep messages.length >` 只命中无关的 `fidelity.mjs:205`），现有触发全为 token 维度（compact.mjs:511 比例 0.8 / :510-516 输出预算收窄 / context.mjs:6,12,34 窗口 / :467 熔断）；② 同日并行会话的未提交 WIP 已在修 `context.mjs:89-140`：**`tool_use.input` 漏计 ⇒ 估 75K < 阈值 132K ⇒ 压缩 0 次**——与 T1 是**同一事故的两半**（先合估算修复，否则阈值照样被同一漏计算架空）；③ 最小插入点 = `compact.mjs:795-799`（`maybeCompact()` 内、`est` 之后），主循环 engine.mjs:814 与子 lane :1869 共用同一 `context`，一处生效两条路径 | **T1 定位完成** |

### 8.2 新增任务

| 任务 | 内容 | 归属 | 验收 |
|---|---|---|---|
| **T8** | **等待态可视化**：① 在消息流顶部/输入区上方给**不可错过的文字态**（chat/task 两种模式都生效、无需 hover、无 ≥5s 静默时不占位）：等待模型响应 · 已静默 Ns / 等待审批 / 等待回答 / 压缩中；② 折叠图标条降为二级入口；③ 长等待（>30s）把秒数显示为文本而非 tooltip。归约器（warningUi.ts）、i18n（`firstByteWait.*`/`kernelStall.*`）与三个组件都已在，缺的是**常显出口**。 | 我（前端） | GUI 手测：长 prefill 期间（chat 与 task 两种 rail）显示"等待模型 …s"且秒数递增；审批/提问显示对应文案 |
| **T9** | **会话状态卫生 + 重放**（行号已按当前源码核对）：① 提问登记对称——`bridge.mjs:1296-1308` 两条分支都要登记 `_pendingQuestions`（raw 分支现**漏登记**，已实证致误回收 J），解析失败时把 raw 长度 + `isValidPayload` 拒绝原因写日志（现只截 160 字符，无法判因）；内核退出（1395-1413）与 `result` 收尾时清空。② 审批登记后于 **`tool_result` 到达且 `tool_use_id` 匹配**时删除（协议层真实收口），并在 `result`/cancel（2545-2589）/内核 exit 时整体清理 + 兜底 TTL（审批上限 + 余量）。③ 回收器（2354-2377）豁免改为"有未决等待**且**内核可达"，**且 `_turnActive` 豁免必须有时限**（`bridge.mjs:2364`）——活跃轮次静默 > 硬看门狗（T10 改后 900s）+ 余量即**强制回收**，否则"挂死→永不发 result→永不回收"是死锁（pid 6736/21196 即此形态）。④ `armFirstBytePending`（2416-2437）5s 守卫判假时**重建而非 return**，避免整段等待无信号。⑤ `GUI connected`（2503-2511）握手后重放未决 `approval`/`question`（现仅注册、无重放）。 | 我（bridge） | 单测：审批在无客户端窗口内产生 → 客户端连上即收重放；有未决等待且内核存活 >10min 不被回收；内核已死则豁免失效必被回收；`_turnActive` 静默超上限必被回收；取消后 >10min 必被回收。**夹具实况（已核对源码，勿再凭记忆）：桥侧旋钮 = `YFW_KERNEL_IDLE_MS` / `YFW_KERNEL_STALL_MS` / 本次新增 `YFW_KERNEL_TURN_REAP_MS`、`YFW_KERNEL_WAIT_EXEMPT_MS`、`YFW_KERNEL_REAP_TICK_MS`（后者专供测试缩短扫描周期）；`YFW_BRIDGE_NO_LISTEN` **确实存在**（bridge.mjs:2535，跳过顶层 listen），但现有桥测试一律用 `YFW_BRIDGE_PORT` + 等就绪行，新测试沿用同一套即可** |
| **T10** | **超时链闭合**：① 解开 600s 同值冲突——实测**共四处**（`cli.mjs:249` 硬看门狗 / `engine.mjs:118` 自适应首字节，对大请求**恒返 600_000**，`:Math.min(Math.max(baseMs,600_000),600_000)` 内层 max 已被包住形同常数 / `engine.mjs:1619,1714` 审批 / `api.mjs:993-1000` 读空闲）⇒ 抬硬看门狗默认至 **900_000**，确立不变量"硬看门狗 > 自适应首字节 + 一个自愈周期"，并订正 `cli.mjs:247` 过时注释（"480s 的两倍"）与 `:266` tick=60s 造成的 **600–660s 击杀窗**；② **等待用户期间按审批上限展期，而不是取消计时**（永不回执的 GUI 不得造成无界静默，违反不变量 9）：`protocol.mjs` 增 `setAwaitingUser(v)`/`isAwaitingUser()`（模块态 `31-32`、读口 `19-29`，与 `setTurnActive` 同区）→ **实现改为计数式 `beginAwaitingUser()`/`endAwaitingUser()`**：并行工具批可能同时挂起多个审批，布尔会被任一个解除抹掉（见 §8.5），engine 在写 `control_request` 时置真（`engine.mjs:1606`/白名单 `:1706`），在 `resolveApproval`(2481-2487)/`rejectAllWaiters`(2330-2338)/审批超时(1622/1717)/取消路径置假，消费点**只改 `cli.mjs:252` 一处**：`isTurnActive() && idle > hardTimeoutMs + (isAwaitingUser() ? approvalTimeoutMs : 0)`；③ 轮次级**绝对期限**（2006s/2911s 纯静默的正面修复）："已产出数据"走**无限**续写愈合（`IDLE_HEAL_MAX=-1`，`engine.mjs:1059-1074`），而每次愈合都写 `guard_heal` 帧、既重置看门狗又不再产出可见文本 ⇒ 记录"上次实质进展时刻"，超 `hard − 余量` 即停 `continue`、走既有可见收尾（`upstream-dead`/`idle` 文案族 `:1076-1085`），保证轮次必 settle；三个 `-1` 默认同时收紧为有限值（env 仍可放开）。④ api 层三处"race-reject 不 cancel"（K/L 的机制侧）：`api.mjs:931-947` 连接超时只 reject（:936）**从不 abort 底层 fetch**；`api.mjs:1003-1011`+`1283-1299` 空闲超时同样只 race-reject，pending `reader.read()` 与 body 永不取消（全文件无 `reader.cancel()`，`:1072` 只 `releaseLock()`）⇒ 内部 `AbortController` 与 `extSignal`(`:954`) 合并后 abort 底层、超时后 `reader.cancel()`；附带退避 `sleep` 不感知 abort（`engine.mjs:197/254`、`api.mjs:1203`）。⑤ `kernel/protocol.mjs:13-16` `writeLine`：`lastWireWriteAt`（`:13`）与 `result` 解武装（`:15`）都移到 `stream.write`（`:16`）**成功之后**，`catch {}` 分支不推进且带失败计数/日志（现写成功与失败不可区分）。 | 我（engine/cli，落点为并行 WIP **未触及**的干净区：`retryStream`(engine.mjs:218-257)、`api.mjs:929-947/993-1011/1283-1299`、`protocol.mjs:13-16`） | kernel-tests：末次请求超时必须收口为 error/result；`writeLine` 抛错时看门狗输入不被推进；审批等待期不误杀（展期）；愈合无限循环被轮次期限收口。已有缺口位：`engine-hard-watchdog.test.mjs:39`（挂死→exit7+marker.err）/`:65`（轮末 result 解武装）。**纪律：全仓无假时钟库 ⇒ 一律用 env 缩小真实毫秒；`[mock:hang-forever]`（`api.mjs:887-891`）＝永久挂起且不留定时器＝"异步链失活"签名；stdout 解析按行容错（数据块会把一行切两半），勿用 `includes`** |

### 8.3 不变量补充（§6）

7. **等待态可见**：内核静默 ≥5s 时 UI 必须显示"等待模型/审批/回答"类状态，不得只有静态"思考中"。
8. **无泄漏内核**：无未决等待的会话静默 >10min 必被回收；有未决等待的会话不得被回收。
9. **无界等待不存在**：任何已发出的请求必须在 ≤ 硬看门狗时间内收口为 result/error（含重试耗尽后的末次）；**等待用户期间按审批上限展期，而不是取消计时**——等的是人不该被杀，但"用户永不回执"必须有界。
10. **自愈不可无限续命**：任何自愈/重试链（`guard_heal` 族）必须在轮次级绝对期限内收敛为可见收尾，且不得仅凭"写了一个 wire 帧"重置硬看门狗（T10③⑤）。

### 8.4 风险

- T9/T10 落点在 `server/bridge.mjs` 与 `kernel/{engine,cli,protocol}.mjs`——**当前有并行会话正在热改同几个文件**（今日未提交 WIP 约 60 个文件，`engine.mjs` 规模还在动）。必须串行：T10 的 B 类改动**只能**落在并行 WIP 未触及的干净区（`retryStream` engine.mjs:218-257、`api.mjs:929-947/993-1011/1283-1299`、`protocol.mjs:13-16`）；T9/T1 必须等对方 commit。
- **提交归属风险（新）**：`src/hooks/useYFWCLI.ts`、`src/stores/chatStore.ts`、i18n 两份文件**同时**承载我方未提交工作（日志持久化 + 多级审批 + 本 T8）与并行会话的工作流模块 WIP。⇒ **按任务小步提交在本轮不可行**（会把对方半成品一并签入）；阶段 A 只落工作树，提交归属须先与对方确认。
- **文档归属风险（新）**：本 spec 目前**未纳入 git 跟踪**（untracked）。§8 若被并行会话整体重写即会丢失——建议尽快 `git add` 独立提交本文件。
- T8 与并行会话的在改范围同属 `src/`（`SystemWarningStrip.tsx` 已在 WIP）——T8 只新增订阅与状态条，不重排既有渲染分支，冲突面最小。
- ~~`release/YFWorking/kernel/cli.mjs` 与源码**逐字节同尺寸**~~ **（2026-09-12 18:31 实测已不成立，此条作废）**：`release/YFWorking/kernel/cli.mjs` = **57729B @17:52**，源码 `kernel/cli.mjs` = **58930B**（含 T10 + 审批档位改动）⇒ 线上内核已是**旧快照**，且 `release/YFWorking/dist/index.html` 于 **18:29 再次被其他会话改动**（几分钟内两次）⇒ 该目录正被多方持续同步，阶段 C 的"mtime 稳定 ≥10min"门**当下必然不满足**，覆盖前必须逐文件 `cmp` 并确认没有第三方在写。

### 8.5 实施进展（滚动更新）

| 阶段 | 任务 | 状态 | 验证 |
|---|---|---|---|
| A | **T8 等待态常显出口** | ✅ 已落工作树（未提交） | 新增 `src/lib/firstByteUi.ts`（纯函数：快照→显示哪一类/文案/是否带秒）+ 9 条单测；新增 `src/components/chat/WaitStatusBar.tsx`（1s 本地 ticker 补足桥 30s 重发，三级配色：灰=等模型/压缩、琥珀=等你操作、红=失速；**不用 `info`——`--info-rgb` 未在 tailwind.config 暴露，rail 现有 `text-info` 实为死类**）；挂载 `ChatWindow.tsx` `LoopStatusBar` 之前（rail 无关、内联不遮挡、无等待返回 null）；i18n 双语文案；`chatStore.clearPermissionsForSession`（**按会话清**，避免 A 会话死亡清掉 B 会话的审批弹窗）；`useYFWCLI.ts` 新增 `clearSessionWaitState` 接入 error/cancelled/closed 三路，`ws.onclose` 只清活性类（WS 抖动可恢复，审批/提问留给 `bridge_hello` 判定）。`node --test src/lib/firstByteUi.test.ts` 9/9、`src/lib/*.test.ts` 122/122、`npm run typecheck` 干净；`scripts/verify-gui-fidelity.mjs` 13/13（原 5 健康用例 + 新 8 等待用例，含"审批只对当前会话生效"的跨会话夹具），截图证实"等待模型 · 5s"与"内核静默 96 秒"**无 hover 可见**、空闲不占位、内核死亡后清除 |
| B | **T9 桥状态卫生 + 重放** | ✅ 已落工作树（未提交）<br>`server/bridge.mjs` | ①提问 raw 分支也登记 `_pendingQuestions` + 诊断带长度/首尾片段；②`user/tool_result` 帧按 `tool_use_id` **协议层收口**待批项，`result`/cancel/回执/答问各路径整体清理；③回收器重写：`_turnActive` 与"未决等待"豁免**均设时限**（`YFW_KERNEL_TURN_REAP_MS` 默认 20min / `YFW_KERNEL_WAIT_EXEMPT_MS` 默认 30min，均可用 0 关回旧行为），"从未有输出但轮次已起"改用 `_turnStartAt` 计时（旧代码 `!_lastOutAt` 直接 continue ⇒ 这类会话永不回收）；④`armFirstBytePending` 的计时器只操作自己武装的 session 对象（旧写法在 fire 里取 `sessions.get(sid)`，同名会话重建后会清掉**新**会话的计时器而僵尸 interval 永不解绑）；⑤`GUI connected` 重放未决 approval/question（`replayed:true`，仅发给新接入者）+ 补一帧 `first_byte_pending`。新增 `server/reap-guard.test.mjs`（4 例：挂死轮次回收 / 未决审批豁免且回执可达 / 等待超上限回收 / 结清后回归普通回收）与 `server/pending-replay.test.mjs`（2 例：0 客户端窗口产生的审批在接入时重放并带全字段 / 重放不打扰既有客户端）——**6/6 通过** |
| B | **T10 超时链闭合** | ✅ 已落工作树（未提交）<br>`kernel/{protocol,cli,engine,api}.mjs` | **①⑤ `protocol.mjs`**：`writeLine` 先 `result → turnActive=false`，再 `try { stream.write(); lastWireWriteAt = Date.now() }`——推进时刻挪到**写成功之后**，`catch` 只累加 `wireWriteFailures`/`lastWireWriteError`（新增 `wireWriteStats()` 供现场指纹）；新增计数式 `beginAwaitingUser()/endAwaitingUser()/isAwaitingUser()`（**计数而非布尔**：并行工具批可能同时挂起多个审批，任一解除不得抹掉"还在等"）。**② `cli.mjs`**：硬看门狗默认 600_000→**900_000**，tick 60s→`Math.min(30_000, hardTimeoutMs)`（600–660s 击杀窗随同值冲突一并消除），订正过时注释；消费点如设计所定 `limit = hardTimeoutMs + (awaiting ? approvalGraceMs : 0)`，`approvalGraceMs` 取 `PONOS_APPROVAL_TIMEOUT_MS`（与引擎侧审批上限同值 ⇒ **展期额度恰好等于引擎自己的等待上限**，无人回执时由引擎以 `timeout` 回填，看门狗只在两者都失效时才动手）；指纹增 `awaitingUser` / `wireWrite`。**③ `engine.mjs`**：`gateToolUse` 审批路径（硬黑名单必经）与 `requestWhitelistApproval` 白名单路径均在 `control_request` 前 `beginAwaitingUser()`、在决定 promise resolve 后 `endAwaitingUser()`——`deny`/`timeout`/取消（`rejectAllWaiters` 回填 deny）四条解除路径都汇到那一处，`end` 不会被漏（漏掉 = 看门狗被永久展期）；`retryStream` 退避改 `sleepAbortable`（取消即刻中断，旧写法睡满 0.5/1/2/4s 才醒=停止键不灵）。**④ `api.mjs`**：`fetchWithConnectTimeout` 内部 `AbortController` 与外部信号合并，连接超时**真 abort 底层 fetch**（监听器不随 fetch resolve 摘除——响应体读取仍要能收到取消）；`readWithRecover` 在空闲超时后 `await reader.cancel()` 再走 transient 归一；`anthropicStream` 重连退避改 `sleepAbortable`。**⚠️ 未做（有意）**：`engine.mjs:1074/1129/1970` 三处自愈退避 `sleep` 仍在并行 WIP 热区（`runTurnInternal` 内），按避让纪律未动；T10③ 的"轮次级绝对期限（记录上次实质进展时刻、超 `hard − 余量` 即停 `continue`）"同样落在该热区，**留待热区稳定后补**——当前"无界续命"由 T9 的桥侧 `_turnActive` 时限强制作外部收口，不变量 10 暂由桥侧兜住 | 新增 `kernel-tests/api-abort-recovery.test.mjs`（2 例，均以**真实 HTTP server 观测对端是否真收口**：连接超时后服务端必须观测到断开 / 流读空闲超时后必须观测到断开）；`engine-hard-watchdog.test.mjs` 扩到 **4 例**，新增"审批等待期按上限展期：静默 7s（>2×阈值 3000ms）不被误杀、回执后轮次照常 settle"与"无人回执的审批等待有界：必见 result 或 marker.err 之一"。**两条新用例均做了反向对照**（临时副本还原改动前行为）：前者 `exitCode 7` 失败（正是线上"等用户 >600s 被杀、且自杀前不写帧、作答落空"的形态），后者两例服务端均观测不到断开。全量 `node --test kernel-tests/*.test.mjs`：**389 例 / 388 通过 / 1 skip / 0 失败**；`npm run typecheck` 退出码 0 |
| B | T1 消息数阈值压缩 | ⏸ 归并行 agent（与其 `context.mjs` 估算修复**并轨**） | — |

### 8.6 工作树快照与提交边界（2026-09-12 18:30 本地）

- **并行会话已提交**其失真健康线（`c912502`…`5cd0e12`，最新为 docs），但工作树仍有 **~30 个已改 + 49 个未跟踪**文件，跨多个会话/多项功能（工作流模块、审批档位、日志持久化、失真健康、本 spec 的 T8/T9/T10）。⇒ 计划中"每完成一项立即 commit"**在本轮不可执行**：`kernel/engine.mjs` 的未提交 hunk 是**混合的**（并行会话的 `preStep`/上下文估算 + 我的 `retryStream`/审批/退避），`server/bridge.mjs` 同样混合（对方 17:04 的在手改动 + T9）。单文件 `git add` 必然连带签入他人半成品。
- **没有任何一个已改文件是"仅本任务"的（已逐 hunk 核对，勿凭直觉）**：`kernel/api.mjs` 152 处插入里大部分是并行会话的 mock 指令/失真健康（`[mock:tool-safe]`、`fidelity-read-fail`、`classifyApiError` 的 tools-unsupported 等），我只占 4 处（`sleepAbortable`、`fetchWithConnectTimeout`、`reader.cancel`、重连退避）；`kernel/cli.mjs` 70 处插入含 41 行审批档位工作（`--approval-mode`/`usage()`），我只占硬看门狗那几处；`kernel/protocol.mjs` 里 `makeWire.controlRequest` 的 `hard`/`mode` 字段是审批档位那轮留下的。⇒ **单文件 `git add` 必然连带签入他人半成品，本轮结论：不提交**（连"只提交新增测试"也不妥——测试依赖同批未提交的修复，单提会让该 commit 自证失败）。
- **可安全独立提交的只有"纯新增且独占"的产物**（若用户决定提交）：`kernel-tests/api-abort-recovery.test.mjs`、`server/reap-guard.test.mjs`、`server/pending-replay.test.mjs`、`src/lib/firstByteUi.ts`(+单测)、`src/components/chat/WaitStatusBar.tsx`，以及**本 spec 文档**（至今 untracked ⇒ §8 有整体丢失风险，建议至少把它单独 `git add`+提交）。
- **阶段 C 的门未开**：`release/YFWorking` 同步要求"并行 WIP 已 commit 且相关文件 mtime 稳定 ≥10min"，当前不满足（`release/YFWorking/dist/index.html` 17:52 刚被**别人**重新同步过 ⇒ 该目录正在多方手中热动）⇒ 构建与部署暂缓（**严禁 `package-portable.cjs`**；覆盖前逐文件备份 + `cmp`）。
- **T8 前端产物未构建**：`src/` 改动只落源码与测试，未 `npm run build`（理由同上：避免把他人半成品打进用户正在跑的 app）。

> ⚠️ 本节"**本轮结论：不提交**"与"**阶段 C 的门未开**"两条已被 **§8.8** 推翻：同日 18:50 静默门实测满足，用户在 18:3x 明确指示"统合一起提交"并"等所有写入停下来再一起系统性同步"，两项均已执行。本节保留为当时的事实快照。

### 8.7 活体观察快照（2026-09-12 18:15–18:30 本地 / 10:15–10:30Z）

用户报"当前好像又卡住"期间，runaway 会话 **17891871 仍在运行**（内核 pid 21720，08:47Z 起）。现场四组证据：

**该窗口的完整时间线（8 分钟有界观察，10:23–10:31Z）**：`10:15:03Z` 最后一条 POST → `10:20:00–10:20:01Z` 三条 assistant 帧（模型在流，但**不产生新 POST**）→ `10:22:49.628Z` 桥 `kernel stall warning ... silent 8m`、渲染器同毫秒收下 → **`10:25:04Z` 自行恢复**（新 POST `msgs=407`）→ 随后进入突发段：8 分钟内 `posts 733→745`、`msgs 407→431`、`body 232KB→282KB`（≈ +11KB/min），`10:30:48Z` 收到 `result`（轮次边界，即**一轮跑了约 15 分钟**）。⇒ 本次"卡住"= **慢流窗口**（UI 可见静默约 5m15s），非内核失活：硬看门狗没触发是对的（wire 有帧即不算静默）；用户侧"卡在思考界面"的观感正是 F——**有帧、有告警、无出口**。压缩后仍在无界增长（16 分钟 +27 条 / +50KB，照此 ~20 分钟后将再次撞墙压缩）。

1. **UI 出口缺陷 F 的活体复现（本轮最有价值的一条）**：10:15:03Z 后该内核零 POST，**10:22:49.628Z** 桥打出 `kernel stall warning: sid 17891871 turn active but silent 8m — possible AV/driver stall, consider cancel/restart`，**同一毫秒**渲染器日志出现 `[WS] recv: kernel-stall 17891871`——**信号已送达渲染端**，而用户看到的仍只有静态"思考中…"。⇒ F 是"送达但无出口"，不是丢帧；T8 的 `WaitStatusBar` 正是这条帧的出口。⚠️ 但**用户当前跑的是 `release/YFWorking/dist` 的旧构建**（`index-DsiUFV7e.js`，14:48 产物；`dist/index.html` 17:52 被别人重新同步过）⇒ T8 的效果**必须经阶段 C 构建+同步才可见**。
2. **"全过程 0 次压缩"需修正为"拖到崩边才压缩"**：日志三连 `10:05:39Z body=501913B msgs=905` → `10:05:45Z body=330640B msgs=593`（先收缩）→ **`10:06:29Z body=13460B msgs=1`（这就是摘要调用本身：单条消息 13KB 压缩指令）→ `msgs=316`**。压缩发生在 18:06 本地、峰值 ~490KB 处，即 T1 阈值从未生效、最终靠上下文撞墙/自愈路径兜底。压缩后仍在跑：`10:15:03Z msgs=404 body=231936B`，约每步 +2 条 / 76 秒内 +6KB。
3. **内核静默死亡是沉默窗口的主因（不是"内核卡住"）**：`previous run crashed` 标记今日 **16 条，`exitCode` 全为 `null`、`err` 全为 `null`**（= 未经 exit 处理器、未留 marker.err 的外部终止）。相邻两条的 `prevTs→ts` 差即"无内核窗口"，最大一条为 **07:24:38 → 08:47:20 = 82m42s（4962s）**，比 H 行记录的 2911s/2006s 更长。⇒ 长静默的主形态是**内核已死且无人重启**，桥不告知 UI；T9 的回收器/重放与 T8 的等待条对症，T10 的硬看门狗治的是"内核活着但失活"的另一半。
4. **进程账**：四个内核仍存活（pid 4532 15:58 / 6736 16:28 / 21720 16:47 / 21196 16:50 本地），均未被回收；其中 **21720 是用户正在用的会话**，6736/21196 是泄漏件。**处置权在用户**（遵守既定约束：我不动用户进程）。

### 8.8 阶段 C 落地记录（2026-09-12 18:50–18:56 本地）

**前置：静默门实测满足（不是"估计停了"）。** 有界观察窗每 60s 采样 `kernel/server/src/electron/scripts/release` 的 mtime，连续 **843s** 无写入后放行：最后三次写入为 `kernel/fidelity.mjs`(18:40:35)、`scripts/verify-gui-fidelity.mjs`(18:36)、`release/YFWorking/dist/sample-skills/_common/project_types_config.json`(18:35)，且 `git status` 无新增未跟踪项。⇒ 用户"等所有写入停下来再一起系统性同步"的条件客观成立。

**先提交、再同步。** 109 项未提交（61 改 + 48 未跟踪）统合提交为 **`6b3e2df`**（101 文件，+9936/−517）：T8/T9/T10 + 并行线的日志持久化/审批档/工作流 DSL v2/provider/失真健康。**该批次此前曾以 `3199ed7`/`fc24221` 提交，被并行会话的 `git reset` 移出 main 可达历史**（`git reflog`: `reset: moving to dc0aa1b → 5e1c371 → 5c851a1`）——内容始终在工作树，未丢失；提交后另打分支引用 **`wip/consolidated-20260912`** 以防再次被顶掉。

**同步清单（逐文件 `cmp` → 备份 → 覆盖 → 逐字节复检）**
- 备份：`release/_backup_before_kernel_resilience_2026-09-12T18-51-43/`（9 个被覆盖文件 + `MANIFEST.md5` + `HEAD.txt` + `dist-stale-assets/` 内 12 个旧哈希产物）。
- 内核 5 件（**尺寸全部变化**，顺带规避"仅比尺寸"镜像同步的漏刷风险）：`api.mjs 80136→82544`、`cli.mjs 57729→58930`、`engine.mjs 172552→173959`、`fidelity.mjs 32237→33990`、`protocol.mjs 6827→8241`。
- 桥 1 件：`server/bridge.mjs 167011→175625`（T9 全量）。
- 测试 7 件：`ws-heartbeat.test.mjs`（更新）+ 6 新增（`cancel-corpse` / `fidelity-chain` / `health-anchor` / `health-anchor-route` / `pending-replay` / `reap-guard`）。同步前逐文件核过 import 来源：只依赖 `node:*` 与 `./health-anchor.mjs`，**无一引用 `src/` 或 `kernel-tests/`**（正是"发布目录跨树导入必炸"那条坑）；同步后**在 release 树内实跑 15/15 全绿**，不是只看源码树结果。
- GUI：`npm run build`（11.54s）后 `diff -rq dist release/YFWorking/dist` 得 **0 个内容不同文件**——18:35 那波别人已用同源代码构建同步过，本次产出与之一致。release 侧多出的 **12 个孤儿哈希产物**经查是**闭环死簇**（8 个旧 `index-*.js` 互相引用旧 `vendor-icons-DydXn5r3.js`，而它们均不被 `index.html` 引用）⇒ 移入备份的 `dist-stale-assets/`，未硬删。清理后 `diff -rq` **0 行差异（含文件集）**，`index.html` 的 8 个引用全部可解析。
- 最终全树复检：`kernel`/`server`/`public`/`workflows`/`pet`/`dist` **全部 0 差异**；`electron` 仅 release 侧 21 个 Electron 运行时二进制（预期，非源码）；`release/server` 无源码侧已删除的陈旧文件。关键文件 md5 源=release：`cli b2cb8c345ae7`、`engine 5358baf2968f`、`api 514cc229c8e6`、`protocol 7f2f5d85b758`、`fidelity 5476e3bc61ad`、`bridge 1456f725f5c3`。
- **未跑 `scripts/package-portable.cjs`**（既定约束，它会 `rmSync` 整个 `release/YFWorking`）。

**验证**：`npm test` **831 / 830 pass / 1 skip / 0 fail**（exit 0）、`npm run typecheck` exit 0。⚠️ 期间有一次全量跑出现 `kernel-tests/fidelity.test.mjs` 假红——并行会话 18:40:28/35 正在写该文件及其测试，我的进程导入到中间态；单独重跑 **30/30 全绿**，非真红。

**重启语义（按代码核对，非惯例推断）**
1. `kernel/`：bridge 每次 spawn **直接用 install 路径** `<app>/kernel/cli.mjs`（`bridge.mjs:720` 返回 `rp.install.kernel`，home 镜像只是 install 缺失时的兜底）⇒ **下一次新内核进程即吃到 T10，无需重启应用**；已在运行的内核仍是进程内旧代码。
2. `~/.yfw/runtime/ponos-kernel/` 镜像：刷新发生在 **bridge 启动时**（`bridge.mjs:728` 模块级 `findYFWorking()` → `bootstrapKernelToUserDir`），当前镜像仍是旧版（api 80136B / cli 57330B / engine 172552B / fidelity 31701B / protocol 6827B）；因这 5 件尺寸均已变化，下次 bridge 启动必刷新，不会被"仅比尺寸"漏掉。
3. `server/bridge.mjs`：T9 需**重启应用**才生效（运行中的 bridge 已把旧代码载入内存）。
4. `dist/`：渲染层重载后才拿得到含 T8 的新构建（`index-h_xIyZCW.js`）。§8.7 观察期用户看到的静态"思考中"来自旧构建（`index-DsiUFV7e.js`），即"有帧、有告警、无出口"的 F 缺陷。

**仍开着**：① runaway 会话 17891871 的存活与处置权在用户（我不动进程）；② T1 消息数阈值与并行线 `context.mjs` 估算修复仍未合入——`compact.mjs` 中目前**仍不存在任何消息数判据**；③ `engine.mjs` 轮次级绝对期限（T10③）仍按 §8.5 记录为暂缓，不变量 10 暂由 T9 的桥侧 `_turnActive` 时限承担。
