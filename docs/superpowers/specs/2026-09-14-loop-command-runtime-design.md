# /loop 指令运行时（打通 + 生产级闭环）设计

> 状态：设计定稿待实现（用户已确认四项关键取向）
> 日期：2026-09-14
> 基线：`kernel/cli.mjs`（loop 内联状态机）、`kernel/engine.mjs`（守卫族/judgeUntil/预算告警）、`src/components/chat/ScheduleGuide.tsx`、`docs/superpowers/audits/2026-09-08-agentloop-guide-gap.md`

---

## 1. 背景与根因

### 1.1 现状：内核有 loop，GUI 到内核是断链

净室内核**已具备**一套可用的 loop 运行时：

| 已有能力 | 锚点 |
|---|---|
| loop 状态机（次数 / `--until` 判定 / `--fresh` 窗口） | `kernel/cli.mjs:866`（`loopState`）、`:1004-1029`（轮次推进） |
| 目标达成 LLM 判定器 | `kernel/engine.mjs:2705`（`judgeUntil`） |
| 无进展检测（**时间维度**） | `kernel/engine.mjs:182`（`LOOP_STALL_MS`）+ `:1079-1091`（停滞自愈） |
| 守卫族（重复/熔断/超时/最大迭代/溢出重试） | `kernel/engine.mjs:59-187` |
| 会话级成本累计 + 预算告警（告警不硬停） | `kernel/engine.mjs`（P2-2 预算护栏） |
| 事件与展示 | `kernel/protocol.mjs:119`（`wire.loop`）、`src/components/chat/LoopStatusBar.tsx` |

### 1.2 根因（三处断点，均已实证）

1. **GUI → 内核无指令通道**：`src/components/chat/ScheduleGuide.tsx:46` 发出的是**纯文本** `` `/loop ${iv} ${t}` ``；`kernel/cli.mjs` **没有任何斜杠指令解析**（全文件 grep 无 `COMMANDS` / `startsWith('/')`），`server/bridge.mjs` 亦无 `loop` 字段转译。该文本经 bridge（`bridge.mjs:2975-2980`）作为普通 `{type:'user'}` 消息送入 `handleUser`，**被当作普通 prompt 交给模型**——loop 状态机永不启动。这是"没打通"的直接原因。
2. **语法互吞**：GUI 发 `/loop 10m <任务>`（间隔式），内核/TUI 语义为 `/loop <次数> [--until 目标] [--fresh]`（次数式）。`10m` 经 `Number('10m')` → `NaN` → 回落默认 3 轮，**间隔语义被静默吞掉**，GUI 与 TUI 语法不自洽。
3. **运行时缺三块**：`loopState` 为纯内存对象（进程退出即失，无断点续跑）；完成条件仅有 LLM 判词（无命令式验真，模型"自认完成"无法拦截）；指令族只有 start（无 status/pause/resume/stop/budget/rollback/replay），且无轮次维度的无进展检测。

### 1.3 本次目标（用户已确认）

一次性打通并补齐生产级闭环：**GUI 通道 + 指令族 + 状态持久化 + 双层 done_when 验证器**，语法归一为「次数为主 + 可选间隔」，GUI 提供状态面板与暂停/恢复等控制。

---

## 2. 范围与非目标

| 维度 | 定界 |
|---|---|
| 功能 | L1 指令解析与语法归一；L2 loop 控制器（状态机/预算/无进展/持久化）；L3 双层验证器；L4 指令族（status/pause/resume/stop/budget/approve/inject/rollback/replay/memory）；L5 bridge 转译与协议扩展；L6 GUI 状态面板与控制 |
| 界面 | kernel 全量实现 + bridge 转译 + GUI 面板（本轮含 React 组件，与此前"GUI 只产契约"的 agentloop 计划不同——用户明确要求界面可用） |
| 配置 | 一律 env 位 + 默认值；不改 settings 持久化层（沿用既有惯例） |
| 非目标 | 多进程沙箱；分布式检查点；跨会话 loop 编排（workflow DAG 已覆盖，不在此重造）；`git push` 等远端写操作（仍走既有审批） |

---

## 3. 架构

### 3.1 模块布局（新增 `kernel/loop.mjs`）

loop 逻辑当前**内联在 `cli.mjs`（1318 行文件的 `finally` 块内）**，无法承载指令族/持久化/验证器。故抽为独立控制器，cli 退化为薄接线：

```
kernel/loop.mjs            新增   LoopController：状态机 + 预算 + 无进展 + 持久化 + 指令族
kernel/loop-verify.mjs     新增   双层验证器（命令式验真 + LLM 判词）
kernel/loop-commands.mjs   新增   /loop 指令解析（start 形式 + 指令族，纯函数、可单测）
kernel/cli.mjs             改    loopState 内联逻辑 → LoopController 委托；loop_command 消息路由
kernel/protocol.mjs        改    wire.loop 帧扩展字段（goal/status/cost/steps/verify）
kernel/engine.mjs          改    暴露 loop 决策所需观察量（文件变更集/错误指纹/usage）
server/bridge.mjs          改    /loop 文本拦截 → loop_command 转译；loop 帧透传（既有）
src/components/chat/LoopPanel.tsx        新增  状态面板（目标/轮次/预算/成本/验证/控制按钮）
src/components/chat/LoopStatusBar.tsx    改    扩展展示 goal/status/cost
src/hooks/useYFWCLI.ts     改    loop 帧归约扩展 + sendLoopCommand 通道
src/stores/chatStore.ts    改    loopStates 字段扩展（status/goal/costUsd/steps/verify）
```

**依赖方向（单向，无环）**：
```
cli.mjs ──▶ loop.mjs ──▶ loop-commands.mjs（纯解析）
              │      └─▶ loop-verify.mjs ──▶ engine.tools.run('Bash') / engine.judgeUntil
              └─▶ session store（持久化）+ protocol wire（事件）
```

### 3.2 数据权威源（双源约定，沿用 agentloop spec 2.2）

- **热数据（进程内循环控制）**：`LoopController` 内存状态对象。
- **冷数据（断点续跑/回放）**：`<configDir>/loop/<sessionId>.json`（原子写：`tmp + rename`），含 `version` / `updatedAt` / 完整状态 / `history[]`。进程崩溃后 `--resume` 时经 `resume_or_start` 语义恢复。
- **轮次原文**：既有 transcript（`<configDir>/projects/<cwd-san>/<sid>.jsonl`）不动——loop 状态文件**只存控制面**，不复制对话内容。

### 3.3 状态模型

```js
{
  version: 1,
  status: 'idle' | 'running' | 'pausing' | 'paused' | 'verifying' | 'awaiting_approval'
        | 'done' | 'failed' | 'stalled' | 'budget_exceeded' | 'cancelled',
  goal: '',                       // 自然语言目标（结构化 done_when 优先）
  doneWhen: [],                   // [{ type:'cmd', run, expect, timeoutMs } | { type:'judge', text }]
  prompt: '',                     // 每轮重放的指令文本
  index: 0,                       // 已完成轮次
  count: 3,                       // 轮数上限（null = 无限，需 stop/until/预算终止）
  everyMs: 0,                     // 轮间间隔（周期巡检）
  fresh: false,
  budget: { maxCostUsd: 0, maxSteps: 0, maxWallMs: 0 },
  usageAcc: { input_tokens:0, output_tokens:0, cache_read_input_tokens:0, cache_creation_input_tokens:0 },
  costUsd: 0,
  steps: 0,
  noProgress: { streak: 0, lastFingerprint: '', threshold: 3 },
  onStall: 'reflect_and_ask',     // 无进展升级策略（env PONOS_LOOP_ON_STALL）
  injections: [],                 // /loop inject 追加的人工补充信息（随下一轮注入）
  startedAt: '', updatedAt: '', endedAt: '',
  endReason: '',                  // completed|until_hit|verify_hit|budget_exceeded|no_progress|stalled|cancelled|failed
  history: [],                    // [{ index, ts, usage, costUsd, steps, toolCount, filesChanged, errors, verify, judged, note }]
  pendingApproval: null,          // { kind:'verify_fail_retry'|'rollback', detail }
  snapshotRef: '',                // 最近 git 快照引用（rollback 用）
}
```

### 3.4 循环主流程

```
start(goal, doneWhen, opts)
  → 建状态 + 持久化 + wire.loop('start')
  → 投递首轮（现有 user + loop 字段通道）

每轮结束（cli 轮末回调 onTurnEnd({ outcome })）:
  1. 累计 usage/steps/costUsd → 持久化
  2. 记录 history（filesChanged / errors / toolCount）
  3. 终止判定（短路序）:
     a. status != running        → 不推进（paused/stopped）
     b. 预算超限                  → budget_exceeded（硬停）
     c. 无进展连续 N 轮           → on_stall（默认：注入反思指令 + awaiting_approval 请求人工）
     d. doneWhen 非空             → verify()（命令式→判词）；全过 → verify_hit
     e. 仅 goal（无 doneWhen）    → judgeUntil(goal)；done → until_hit
     f. index >= count（有限）    → completed
  4. 未终止 → 若 everyMs > 0 则定时投递，否则立即投递下一轮
```

**短路序即安全边界**：预算与无进展**先于**验证器判定——防止"验证器反复失败 → 无限重试烧钱"。

---

## 4. 语法契约（统一 CLI / TUI / GUI）

### 4.1 单一语法（三端一致）

```
/loop [次数] [--until <目标>] [--every <间隔>] [--fresh]
      [--max-cost <USD>] [--max-steps <N>] [--max-wall <时长>]
      [--done <命令>]... [--goal <目标>] [prompt...]
```

| 参数 | 语义 | 默认 |
|---|---|---|
| `次数` | 轮数上限（整数） | `3`（保持现状默认） |
| `--until <目标>` | LLM 判词达成即停（`judgeUntil`） | 无 |
| `--done <命令>` | **命令式验真**，可重复（多个 = AND，全部退出码 0 才通过） | 无 |
| `--goal <目标>` | 结构化目标（与 `--done` 组合为强规格） | 无 |
| `--every <间隔>` | 轮间间隔（`Ns/Nm/Nh/Nd`）；给定且无次数 → 持续运行 | `0`（连跑） |
| `--fresh` | 每轮独立上下文窗口 | `false` |
| `--max-cost <USD>` | 成本硬顶 | `0`（不限） |
| `--max-steps <N>` | 总步数硬顶 | `0`（不限） |
| `--max-wall <时长>` | 墙钟硬顶 | `0`（不限） |
| `prompt...` | 每轮重放内容（缺省重放上一条用户消息） | — |

### 4.2 GUI 旧语法兼容（关键）

GUI 现发 `/loop 10m <任务>`。**首个 token 匹配 `^\d+(s|m|h|d)$` 时识别为间隔**（非次数），等价 `--every 10m`：

- `/loop 10m 检查磁盘` → `{ everyMs: 600000, prompt: '检查磁盘', count: null }`
- `/loop 5 优化函数` → `{ count: 5, prompt: '优化函数' }`
- `/loop 5 --until 测试通过 修复 bug` → `{ count: 5, until: '测试通过', prompt: '修复 bug' }`

**零回归锁**：既有 TUI 语法（`/loop 3 <prompt>`、`--until`、`--fresh`）解析结果逐字不变。

### 4.3 指令族

```
/loop start <目标>       显式启动（等价于直接给 prompt 的 start 形式）
/loop status            目标/状态/轮次/步数/成本/预算/无进展计数/最近验证结果/历史
/loop pause             请求暂停（当前轮跑完，status=pausing→paused）
/loop resume            从 paused/awaiting_approval 恢复
/loop stop [reason]     立即停止（status=cancelled）
/loop budget [--max-cost X] [--max-steps N] [--max-wall T]   查询/设置预算
/loop approve           批准挂起项（验证失败重试 / 回滚）
/loop inject <补充信息>  向当前轮注入信息（复用 engine.queueNext 插话通道）
/loop rollback          回滚到最近检查点（git 快照，需确认）
/loop replay [--last N] 回放 history（时间线：轮次/用量/成本/文件变更/验证结果）
/loop memory            查看 loop 记忆（沉淀的目标/失败经验/规则）
```

**判定规则**：`/loop` 后首个 token 属于指令族关键字集合 → 指令；否则按 4.1 的 start 形式解析。

---

## 5. 组件设计

### 5.1 `kernel/loop-commands.mjs`（纯函数解析）

```js
export const LOOP_OPS = ['start','status','pause','resume','stop','budget','approve','inject','rollback','replay','memory']
export function parseLoopDirective(text) → { kind:'start', opts } | { kind:'op', op, args } | null
export function parseDuration(s) → ms | null      // 10m / 30s / 1h / 1d
export function formatLoopStatus(state) → string  // /loop status 的文本回执
export function formatLoopReplay(history, last) → string
```

契约：**纯函数、零 IO、零 engine 依赖**（便于 fixtures 全覆盖单测）。无法解析 → 返回 `null` 交调用方按普通消息处理（不吞用户输入）。

### 5.2 `kernel/loop-verify.mjs`（双层验证器）

```js
export async function verifyDoneWhen(doneWhen, { runCmd, judge, signal, timeoutMs }) → {
  passed: boolean,
  results: [{ spec, type, ok, exitCode?, output?, reason?, ms }],
  reason: string,
}
```

- **命令式（第一层，确定性优先）**：逐个执行 `{ type:'cmd', run }`，**必须经 `engine.tools.run({ name:'Bash', input:{ command } }, ctx)`** —— 复用既有五段式执行管线（白名单 → 权限/审批 → 频率 → Schema → 有界重试）。**禁止**绕开审批自建 spawn：验真命令同样可能具破坏性，必须受同一门控与审计。
- 退出码 `=== expect`（默认 0）→ 通过；单条超时（默认 120s）→ 不通过并记 `reason:'timeout'`。
- **判词（第二层，兜底）**：命令层全过后，`{ type:'judge', text }` 交 `engine.judgeUntil({ target: text })`；`done === true` 才算通过。
- 短路：命令层任一失败即返回（不再调模型），省预算。
- `doneWhen` 为空 → 返回 `{ passed:null }`（调用方回落到 `--until`/`--goal` 的 judge 路径）。

### 5.3 `kernel/loop.mjs` — LoopController

```js
export function createLoopController({ wire, engine, store, configDir, sessionId, cwd, env = process.env })
```

对外 API（全部幂等 + 静默降级，异常绝不打断主流程）：

| 方法 | 行为 |
|---|---|
| `start(opts)` | 初始状态 + 持久化 + `wire.loop('start', …)` |
| `onTurnEnd({ outcome })` | 累计 → 终判 → 返回 `{ action:'next'|'wait'|'stop', delayMs, verify? }` |
| `status()` / `formatStatus()` | 状态对象 / 文本回执（`/loop status`） |
| `pause()` / `resume()` / `stop(reason)` | 状态迁移 + 持久化 + 事件 |
| `setBudget(patch)` | 预算热更新（`/loop budget`） |
| `approve()` | 解除 `awaiting_approval` → 继续（重试本轮验证 / 执行回滚） |
| `inject(text)` | 追加到 `state.injections[]` + `engine.queueNext(text)` |
| `snapshot()` / `rollback()` | git 快照打点 / 回滚（需 `approve`） |
| `replay(lastN)` | 从 `history` 生成时间线 |
| `memory()` | 读取本 loop 沉淀记忆 |
| `load()` / `persist()` | 从 `<configDir>/loop/<sid>.json` 恢复 / 原子写 |

**无进展检测（轮次维度，补既有时间维度的空档）**：
每轮计算指纹 = `hash(变更文件集 ∪ 工具错误码集 ∪ 验证失败项)`。指纹与前轮相同 → `streak++`；否则归零。`streak >= threshold`（默认 3，env `PONOS_LOOP_NOPROGRESS_N`）→ `on_stall`：
- `PONOS_LOOP_ON_STALL`（默认 `reflect_and_ask`）：注入反思指令（"连续 N 轮无实质进展，请换策略或说明阻塞"）+ `status='awaiting_approval'`，**请求人工**（不静默烧钱）。

**预算硬停**：`costUsd > maxCostUsd`（或 steps/wall 超限）→ `status='budget_exceeded'` + `wire.loop('end', { reason:'budget_exceeded', … })`。注意与 P2-2 区分：P2-2 是**会话级告警（不硬停）**，本层是 **loop 自设预算的硬停**，两者互补不冲突。

**持久化**：每次状态迁移 + 每轮结束原子写。写失败静默（不阻断循环），但 `wire.warning({ level:'loop_persist' })` 提示一次。

### 5.4 `kernel/cli.mjs` 接线

- `loopState` 内联对象与 `:1004-1029` 推进逻辑 → 替换为 `controller = createLoopController(...)`；`handleUser` 保留 `{ message, loop }` 入队通道（`controller` 生成该载荷）。
- 新增消息类型路由（`rl.on('line')` 内）：`parsed.type === 'loop_command'` → `controller.handle(op)`（stdout 回执经 `wire.loop('status'|'replay'|'memory', …)`）；运行中进程内斜杠文本（TUI）经 `parseLoopDirective` 同路。
- `--resume` 时 `controller.load()`：存在未终结 loop → 恢复运行（`resume_or_start`）；已终结 → 仅回执不重启。
- `cancel`（停止按钮）→ `controller.stop('cancelled')`（保持既有语义）。
- `console.log('{"type":"system","subtype":"loop_result",...}')` 承载指令族回执（requestId 配对，沿用 workflow 回执惯例）。

### 5.5 `server/bridge.mjs` 转译（打通点）

GUI `send(conversationId, content)` 路径（`bridge.mjs:2975` 区）增前置判定：

```js
const directive = parseLoopDirective(content)   // 复用 kernel 纯函数（bridge 直 import kernel 模块不跨进程）
if (directive) {
  session.proc.stdin.write(JSON.stringify(
    directive.kind === 'start'
      ? { type: 'user', message: { role:'user', content: directive.opts.prompt }, loop: directive.opts }
      : { type: 'loop_command', op: directive.op, args: directive.args, requestId: msg.requestId }
  ) + '\n')
  return
}
```

**注意**：`parseLoopDirective` 为纯函数零依赖模块，bridge 直 import 不引入跨进程耦合（与 kernel-readonly 的 spawn 路线不同，因这是同步热路径）。

### 5.6 GUI

- `LoopPanel.tsx`（新）：状态面板——目标 / 轮次进度 / 步数 / 成本 vs 预算 / 无进展计数 / 最近验证结果（含命令与退出码）/ 历史时间线（replay）；按钮：暂停、恢复、停止、设置预算、批准挂起项、回滚（二次确认）。
- `LoopStatusBar.tsx`（改）：胶囊内补 `goal` 摘要与 `costUsd`；`status` 为 `paused`/`awaiting_approval`/`budget_exceeded` 时显示对应徽标。
- `useYFWCLI.ts`（改）：loop 帧归约扩字段；新增 `sendLoopCommand(conversationId, op, args?)`。
- `chatStore.ts`（改）：`loopStates[sid]` 增 `status/goal/costUsd/steps/verify/noProgress`；`clearLoopState` 语义不变。
- `ScheduleGuide.tsx`（改）：改发结构化 start（`--every` 语义），并在面板中暴露`--until`/`--done` 输入。

---

## 6. wire 协议扩展

`wire.loop(state, data)` 既有帧（`protocol.mjs:119`）**只增字段、不改语义**（旧 GUI 解析不受影响）：

| state | 新增字段 |
|---|---|
| `start` | `goal`, `count`, `everyMs`, `doneWhen`（摘要）, `budget` |
| `iter` | `steps`, `costUsd`, `filesChanged`, `noProgressStreak`, `verify`（`{passed, results:[{run,ok,exitCode}]}` 摘要） |
| `end` | `endReason` 扩展值域：`verify_hit` / `budget_exceeded` / `no_progress` / `failed`（原 4 值保留） |
| `status` | 全量状态快照（`/loop status` 回执） |
| `replay` / `memory` | 文本回执 |

GUI `LoopStatusBar` 的 `REASON_KEY`（`LoopStatusBar.tsx:12-15`）需补新值域映射 + i18n（`zh-CN.ts` / `en-US.ts` 的 `loopStatus`）。

---

## 7. 测试计划

沿用 `kernel-tests/*.test.mjs`（`node:test`）+ `npm test`（server/GUI）：

| 文件 | 覆盖 |
|---|---|
| `kernel-tests/loop-commands.test.mjs` | 解析矩阵：次数/`--until`/`--every`/`--fresh`/`--done`×N/`--max-*`/GUI 旧语法 `10m`/指令族 11 个 op/非法输入返回 null；**零回归锁**：既有 TUI 语法解析结果不变 |
| `kernel-tests/loop-verify.test.mjs` | 命令式通过/失败/超时/多命令 AND/短路不调模型；判词层兜底；命令**经 Bash 工具门**（断言审批被触发，不绕过） |
| `kernel-tests/loop-controller.test.mjs` | 状态迁移（start/pause/resume/stop/approve）；预算硬停；无进展指纹与 `reflect_and_ask`；次数耗尽；持久化 round-trip；load 恢复 running |
| `kernel-tests/loop-e2e.test.mjs` | mock 驱动端到端：`--done` 验真失败→重试→通过（`verify_hit`）；预算超限终止；崩溃后 resume 续跑 |
| `server/loop-translate.test.mjs` | bridge 把 `/loop 10m X` 转译为 `loop` 载荷、`/loop status` 转译为 `loop_command`；普通文本不受影响（零回归） |
| GUI 冒烟 | 本轮以**人工冒烟清单**交付（仓库现无 React 组件测试基建，不为本任务新建）：① ScheduleGuide 发 `10m` → 面板显示目标+持续态；② 暂停/恢复/停止按钮各触发一次状态迁移并在胶囊可见；③ 预算设为极小值 → 下一轮 `budget_exceeded` 收尾；④ `/loop status`、`/loop replay` 文本回执可读 |

**回归门槛**：全量 `node --test kernel-tests/*.test.mjs` 绿 + `npm test` 绿；三把零回归锁显式断言（TUI 语法解析不变、非 `/loop` 文本直通、loop 帧旧字段逐字保留）。

---

## 8. 风险与回滚

| 风险 | 对冲 |
|---|---|
| 抽 `loop.mjs` 触碰既有 loop 路径 | 三把零回归锁 + 全量 kernel-tests 门槛；先落"解析纯函数 + 控制器骨架（委托等价）"再逐步接管 |
| 命令式验真被滥用为任意命令执行 | 强制经 Bash 工具门（审批/黑名单/审计），并记 `appendMeta('loop_verify', …)` |
| 回滚丢用户改动 | 回滚**必须** `awaiting_approval` + GUI 二次确认；仅作用于 git 跟踪文件，仅回到 loop 自建快照 |
| 持久化文件损坏 | 原子写 + `version` 校验；解析失败 → 丢弃该文件并按新 loop 启动（`wire.warning('loop_persist')`） |
| 无限运行（`--every` 无次数） | 预算/墙钟硬顶 + 无进展升级 + 人工 stop 三保险；`cont` 语义需显式 `--every` |
| bridge 直 import kernel 模块 | 仅 import 无副作用的纯函数模块（`loop-commands.mjs`），不引入 engine/provider 依赖 |

**回滚方案**：各层为独立新增（新模块 + 只增字段），按提交粒度单点回退；`cli.mjs` 若接管失败可回退到内联 `loopState` 路径（保留一个 `PONOS_LOOP_LEGACY=1` 逃生开关，验收通过后移除）。

---

## 9. 建议推进顺序（供 writing-plans 细化）

1. `loop-commands.mjs` 解析纯函数 + 测试（零回归锁先行）
2. `loop-verify.mjs` 双层验证器 + 测试（含 Bash 门断言）
3. `loop.mjs` 控制器（状态机/预算/无进展/持久化）+ 测试
4. `cli.mjs` 接线（委托 + `loop_command` 路由 + resume 恢复）
5. `bridge.mjs` 转译 + server 测试（**打通点**，至此 GUI 可用）
6. GUI：`chatStore`/`useYFWCLI` 归约 → `LoopStatusBar` 扩展 → `LoopPanel` 面板
7. 协议文档更新（`docs/bridge-contract.md`）+ 端到端冒烟

第 1–2 步互不依赖可并行；第 6 步依赖 4–5。

---

## 附录 A：现状锚点（探索期核实）

- `kernel/cli.mjs`：`loopState:866`、start 登记 `:896-905`、轮末推进 `:1004-1029`、cancel `:1157-1159`、EOF 等待 `:1295-1300`、stdin 路由 `:1247-1285`（**无斜杠解析**）、`extractContent:278`。
- `kernel/engine.mjs`：`judgeUntil:2705`、守卫常量 `:52-187`（`LOOP_STALL_MS:182`）、停滞自愈 `:1079-1091`、`setFreshWindow`（loop --fresh）、`queueNext`/`pendingNextCount`/`drainNextPending`、`hardStop`、`runTurn` 返回 `{ text, usage, model }`。
- `kernel/protocol.mjs`：`wire.loop:119`、`makeWire` 事件族（`system/assistant/result/warning/health/summary/taskStarted`）。
- `server/bridge.mjs`：GUI send 写内核 `:2975-2980`、守卫 env `:899`（`CLAUDE_CODE_AGENT_TRIGGERS`）、内核命令构造 `:585-601`、空闲回收 env `:1916/:1942`。
- `src/`：`ScheduleGuide.tsx:46/214`（发纯文本 `/loop`）、`useYFWCLI.ts:1048-1085`（loop 帧归约）、`LoopStatusBar.tsx:12-15`（reason 映射）、`chatStore.setLoopState`。
- 既有设计基线：`docs/superpowers/specs/2026-09-08-agentloop-prod-upgrade-design.md`（预算/审计/Judge 接线）、`docs/superpowers/audits/2026-09-08-agentloop-guide-gap.md`（差距分级：G1 明确仅 `/loop --until` 为示例级实现）。

## 附录 B：关联文档

- 差距审计：`docs/superpowers/audits/2026-09-08-agentloop-guide-gap.md`
- agentloop 升级 spec/plan：`docs/superpowers/specs|plans/2026-09-08-agentloop-prod-upgrade*`
- 桥接契约：`docs/bridge-contract.md`（本轮需补 `loop_command` 与 loop 帧扩展）

---

## 附录 C：实施结论（2026-09-14）

**状态：已实施并通过验收。** 提交：设计 `8cb0cde` → 计划 `e518e5a` → Task1+2 `b145d01` → Task3 `ca1af52` → Task4+5+6 `d9ecab1` → 本文档更新。

### C.1 交付与验证

| 层 | 产物 | 验证 |
|---|---|---|
| 解析 | `kernel/loop-commands.mjs` | 7 测试（含零回归锁①） |
| 验证器 | `kernel/loop-verify.mjs` | 9 测试（命令经 Bash 门 / 短路 / fail-closed） |
| 控制器 | `kernel/loop.mjs` | 12 测试（状态机 / 预算硬停 / 无进展 / 持久化 round-trip） |
| 接线 | `kernel/cli.mjs`、`kernel/engine.mjs`（`runTurn` 补 `toolDigest`） | 6 e2e 测试 |
| 打通 | `server/loop-translate.mjs`、`server/bridge.mjs` | 5 测试 + **真实 bridge 端到端 8/8 PASS** |
| GUI | `LoopPanel.tsx`、`LoopStatusBar.tsx`、`useYFWCLI.ts`、`types/index.ts`、i18n | `tsc --noEmit` 通过 |

**核心验收证据**（真实 bridge + WS 客户端 + `PONOS_MOCK_API=1` 净室）：GUI 纯文本
`/loop --every 3s 巡检` → 内核帧序列 `loop/start(everyMs=3000) → loop/iter`；`/loop status`
文本 → `system/loop_result` 可读回执；`/loop stop` → `end(cancelled)`；停止后越过两个间隔
窗口仅 1 次 iter、start 帧数恒为 1（无重启）；随后普通消息正常（未污染会话）。

### C.2 实施期发现并修复的缺陷

1. **停止后 loop 自启（严重，已修 + 反证）**：`--every` 的延迟投递定时器不可取消。用户在间隔
   期间 `stop`/`cancel` 后，定时器到点仍投递下一轮载荷 → `handleUser` 见 `!loop.isActive()`
   把已终结的 loop **重新 start**。实测：`stop` 后 loop 自行重启并续跑 8 轮。
   修法：新增 `clearLoopNextTimer()`（在 `stop`/`pause`/`resume`/`approve`/cancel 五处调用）
   + 到点复核 `status === 'running'`（覆盖"stop 早于定时器注册"的竞态）。
   已用反证确认回归测试有牙齿（临时移除守卫 → 测试失败并复现 8 轮）。
2. **`resume` 双投递**：`resume` 需补投递下一轮（控制器只在轮末被调用，否则恢复后静默停住），
   若残留定时器未清会连跑两轮 → 由同一 `clearLoopNextTimer()` 消除。
3. **`engine.runTurn` 不返回 `toolDigest`**：无进展指纹与 `filesChanged` 恒为空 → 检测形同
   虚设。已补返回字段（只增不改）。

### C.3 遗留 / 后续

- `rollback` 仅登记 `pendingApproval` 并记录 git HEAD 快照引用，**未实现实际 `git reset` 执行**
  （防误伤取向）；`PONOS_LOOP_ON_STALL=stop` 分支无自动化测试（端到端手测项）。
- 命令式验真仅支持 `expect === 0`：Bash 工具以 `isError` 表达退出码、不暴露原始码，显式非 0
  期望 → fail-closed 并在 `reason` 说明。
- 无进展指纹以 `<工具名>:<路径>` / `<工具名>:<错误前缀>` 构成：同路径内容变更可能被判为
  "无进展"（保守取向，宁可提前问人也不静默烧钱），可用 `PONOS_LOOP_NOPROGRESS_N` 放宽。
- GUI 组件无自动化测试基建，本轮以真实 bridge 端到端 + `tsc` 交付；`LoopPanel` 按钮的
  浏览器层交互建议后续纳入 Electron 冒烟。
- 本次提交 `d9ecab1` 因 `kernel/cli.mjs`、`server/bridge.mjs` 上并存其他在途任务（知识库回收站）
  的未提交改动，整文件提交一并定型（已在该 commit message 中注明）。

### C.4 二次审查补充修复（--resume 断点续跑，2026-09-14）

**缺陷**：cli 启动时 `if (args.resume) { loop.load() }` —— `load()` 仅还原控制面状态
（`status='running'`、`index=N`）而**不投递下一轮**。而控制器的 `onTurnEnd` 只在轮末被调用，
故恢复后 loop 静默停住：用户看到"已恢复"却再无任何轮次推进，⑤「状态持久化 + 断点续跑」
实际形同虚设。

**修复**：
1. `kernel/cli.mjs`：`load()` 成功后，若 `status === 'running'` 则补投递下一轮载荷
   （`setImmediate` 推迟到 signal/rl 接线完成之后，规避启动期竞态与 TDZ）；
   仅 `running` 自动续跑，`paused`/`awaiting_approval` 仍等用户 `resume`/`approve`。
2. `kernel/loop.mjs`：`until` 纳入 `freshState()`/`start()` → 参与落盘，否则 `--resume` 后
   `--until` 停止条件丢失（退化为按次数/预算收尾）。

**反证**（确认回归测试有牙齿）：临时回退为原始 `loop.load()`，事件序列变为
`system:crash_recovered → system:init → loop:start`（有 start、**无任何 iter**），
断言 `恢复后应续跑下一轮` 如期失败；恢复修复后 7/7 通过。
