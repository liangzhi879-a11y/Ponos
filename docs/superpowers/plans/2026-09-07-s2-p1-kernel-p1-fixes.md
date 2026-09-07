# S2-P1：内核健壮性补齐计划（子 lane 熔断 #4 / 溢出自愈 #5 / 审批超时验证 #6 / flaky 门禁治理 #11）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) 或 executing-plans 实施本计划；步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 在 ponos-dev 内核（Ponos-turbo）补齐外部审计 P1 健壮性项——#4 子 lane 失败熔断、#5 子 lane 上下文溢出（400）自愈、#6 审批挂起超时（HEAD 已实现→验证+补测+文案收尾）、#11 门禁 flaky 治理——回归全绿后并入 S2 修复后基线。

**Architecture:** 修复落在 `C:\Users\T203-15\ponos-dev`。行号以 HEAD `1b350c5`（2026-09-07 锚点研究实据）为准，实施时若已漂移以测试先锁行为再对照。审计 #6 关键事实：审批超时已由 0817e8d 引入（`PONOS_APPROVAL_TIMEOUT_MS` 默认 600s，engine.mjs:949-955），审计"866 行无超时"指向 0817e8d^ 旧快照（同审计 #7 过时情形）→ #6 转为验证+补行为测试+文案动态化。审计 #11：全量门禁 flaky 根因 = spawn/bridge 类测试 5s 硬收集超时 + 真 listen + 每会话 spawn 在文件级并行下争抢；本机实测无复现（负载型偶发）→ 治理 = 统一提升收集超时并支持环境变量覆盖，全量门禁连续复跑绿为凭。

**Tech Stack:** Node >= 18 ESM、node:test、零 npm 依赖内核；mock 基建 = `kernel/api.mjs` mockStream（PONOS_MOCK_API=1）+ env 门控。

## Global Constraints

- 执行目录：`C:\Users\T203-15\ponos-dev`（branch main；每任务独立 commit——延续 S2-P0 已批准工作流）
- 锚点研究权威文件（行号/代码片段/测试格局出处）：`C:\Users\T203-15\yfworking\.superpowers\sdd\2026-09-07-s2-kernel-p0-fixes\s2p1-anchor-research.md`（只读，不 commit 入内核仓库）
- 测试 hermetic 纪律：引用 `process.env` 的守卫类测试必须 `PONOS_MOCK_API=1` 门控；顶层 env 用例须静态 import 或 env 先于模块求值（镜像 engine-guard-iter/meltdown/idle.test.mjs 的做法）
- 子 lane 语义对齐目标：runSubAgentLoop 的守卫命中一律 `return guardStop(stopNotice(...))`（见 1057-1062 既有守卫风格）；不改变子 lane"无压缩/无健康（短会话）"的简化设计（engine.mjs:1035-1036 注释），#5 只做**输出预算收窄半臂**，不引入 compactor
- 既有 mock 分支语义零改动；新行为用新 env/marker 追加
- 全量回归命令：`cd C:/Users/T203-15/ponos-dev && node --test "server/*.test.mjs"`（本机基线 513/513，17.5s）；相关套件命令见各 Task
- #11 治理目标：`collect`/`next` 收集超时默认 5000 硬编码全部消除，统一默认 15000 且可 `PONOS_TEST_COLLECT_TIMEOUT_MS` 覆盖；全量门禁连续两次全绿

---

### Task 1: #4 子 lane 补失败熔断守卫（镜像主循环 errorStreak/MAX_ERROR_ITERATIONS）

**Files:**
- Modify: `kernel/engine.mjs`（`runSubAgentLoop`：轮变量区 + runToolBatch 返回处理）
- Modify: `kernel/api.mjs`（mockStream：追加 lane 持续失败模拟——以 api.mjs 实际分发结构为准，见 Step 1）
- Test: `server/engine-lane-meltdown.test.mjs`（新建，镜像 `server/engine-guard-meltdown.test.mjs` 主循环熔断测试 + `server/engine-lane-trunc.test.mjs` 子 lane harness）

**Interfaces:**
- Consumes: 主循环熔断链（`engine.mjs:452` errorStreak、`engine.mjs:56` `MAX_ERROR_ITERATIONS = envNonNeg('PONOS_LOOP_MAX_ERROR_ITERATIONS', 6)`、全败计数语义 786-791、熔断动作 817-823）；子 lane 既有守卫收尾风格 `return guardStop(stopNotice(...))`（runSubAgentLoop 1057-1062）
- Produces: 子 lane 连续"全部失败"工具轮达 `MAX_ERROR_ITERATIONS` 时 `guardStop` 可见收尾（任一成功即复位）；lane 转录/任务通知可证

- [ ] **Step 1: 通读子 lane 工具批处理与 mock 分发结构（只读）**

读 `engine.mjs:1149-1167`（runToolBatch 调用与 store 落法，确认批返回的 results 变量名与 is_error 标记形状）与 `engine.mjs:780-825`（主循环全败计数/熔断 verbatim）。再读 `kernel/api.mjs` mockStream 分发（`PONOS_MOCK_LOOP` env 分支约 136-148、tool_result 回显分支约 170-179、marker 分支 223 起、PONOS_MOCK_LOOP=fail 产 exit 1 Bash 的既有实现）与 `server/engine-guard-meltdown.test.mjs`（顶层 env `PONOS_MOCK_LOOP=fail` + `PONOS_LOOP_MAX_ITERATIONS=40` + `PONOS_LOOP_REPEAT_REMIND=''` 使主循环熔断先于其它守卫触发）。**判定 mock 追加方案**：若 `PONOS_MOCK_LOOP=fail` 对所有请求（含子 lane 请求、含 tool_result 回显轮）生效——则 lane 熔断测试可顶层设 `PONOS_MOCK_LOOP=fail`，但主循环首轮会产 fail Bash 而非 Agent tool_use，故需确认 mockStream 是否有"主请求先走 Agent marker"的判定路径；若 env 分支先于 marker 且对所有请求生效，则追加一个**首轮 Agent 触发 marker**（复用 `[mock:agent]` 形状，如 `[mock:agent-lane-melt]`，prompt 内含子 lane 请求 marker），并把子 lane 的持续失败靠 `PONOS_MOCK_LOOP=fail` 的全局 fail 语义满足（lane 内每轮请求都产 fail Bash）。在报告里记录你实测的分发顺序与所选方案理由。不得臆造：以读到 api.mjs 真实结构为准。

- [ ] **Step 2: 写失败测试**（先复现缺陷：lane 无熔断 → 失败无限续轮直到迭代上限/墙钟）

新建 `server/engine-lane-meltdown.test.mjs`，镜像 lane-trunc 的 makeEnv harness；测试用例如下（阈值下调为 2 以缩短用例；env 须在 import engine 前冻结，镜像 meltdown 测试的静态 import 布局）：
```js
// 子 lane 失败熔断（审计 #4）：连续"全部失败"工具轮达 MAX_ERROR_ITERATIONS（测试设 2）即
// guardStop 收尾，不无限重试；lane 转录/通知可证熔断文案。镜像 engine-guard-meltdown 主循环版。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// —— env 冻结须先于 engine 求值（镜像 engine-guard-meltdown.test.mjs 布局，按该文件实际 import 次序调整）——
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_LOOP_MAX_ERROR_ITERATIONS = '2'   // 收敛用例时长
process.env.PONOS_LOOP_MAX_ITERATIONS = '40'        // 防迭代上限先触发（镜像主循环版）
process.env.PONOS_LOOP_REPEAT_REMIND = ''           // 防同工具提醒噪音

import { createEngine } from '../kernel/engine.mjs'
import { createSessionStore } from '../kernel/session.mjs'
import { makeWire } from '../kernel/protocol.mjs'

function makeEnv() { /* 镜像 engine-lane-trunc.test.mjs 的 makeEnv（wire 事件 + laneFile 规则），此处照抄其实现 */ }

test('子 lane：连续工具全败达上限即熔断收尾，不无限重试', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-melt]' })
    const notif = env.events.find((e) => e.type === 'system' && e.subtype === 'task_notification')
    assert.ok(notif, '应有 task_notification')
    // 子 lane 通知/转录含熔断说明（"全部失败"）——以实际 guardStop 文案为断言目标
    const notifText = JSON.stringify(notif)
    assert.ok(/全部失败|自动收尾/.test(notifText), `通知应含熔断文案，实际：${notifText}`)
    // lane 转录含熔断说明（is_error 连续记录）
    const lane = readFileSync(env.laneFile(notif.task_id), 'utf-8')
    assert.ok(/全部失败|自动收尾/.test(lane), `lane 转录应含熔断文案，实际：${lane.slice(-400)}`)
    assert.ok(String(r.text).length > 0, '主线程正常收尾')
  } finally { env.cleanup() }
})
```
> Step 1 的 mock 判定若与上面用例的 marker 假设不符，以实测结构调整 marker 与通知断言文案（熔断 guardStop 文案以你读到的 stopNotice 用法为准），但测试意图（lane 连败熔断不无限重试）不变。

- [ ] **Step 3: 跑测试确认失败（缺陷复现）**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-lane-meltdown.test.mjs`
Expected: FAIL —— 修复前 lane 无熔断，失败轮无限续（被测试 env 的迭代上限 40 兜住前无"全部失败"文案），断言不通过。

- [ ] **Step 4: 生产代码修复**（engine.mjs runSubAgentLoop）

① 在 lane 轮变量区（`subStopReason` 声明旁，约 1064）追加：
```js
let subErrorStreak = 0    // P1-守卫④（子 lane，审计 #4）：连续全部失败的工具迭代链
```
② 在 runToolBatch 返回处理（约 1153-1163，结果落 store 处）后插入熔断判定（镜像主循环 786-791 全败语义 + 817-823 动作；results 变量名以 Step 1 实测为准）：
```js
      // P1-守卫④（子 lane 镜像，审计 #4）：连续"全部失败"迭代达上限即收尾止损（任一成功即
      // 复位）。与 R3-2 自愈互补：自愈引导失败后重试，熔断兜"重试救不回来"的底。镜像主循环
      // engine.mjs:786-791 / 817-823。
      const allLaneFailed = laneToolResults.length > 0 && laneToolResults.every((r) => r.is_error)
      if (allLaneFailed) subErrorStreak++
      else if (laneToolResults.length) subErrorStreak = 0
      if (MAX_ERROR_ITERATIONS > 0 && subErrorStreak >= MAX_ERROR_ITERATIONS) {
        return guardStop(stopNotice(
          `连续 ${subErrorStreak} 轮工具调用全部失败，已自动收尾停止重试。请检查失败原因后重新发起。`,
          'error-meltdown',
        ))
      }
```
> `laneToolResults` = Step 1 实测的子 lane 工具批返回数组变量名；`stopNotice`/`guardStop` 的形参顺序与文案以 runSubAgentLoop 既有守卫调用（1057-1062、1091-1095、1136-1148）为镜像照抄。若批处理在 store 落法后无结果数组留存，需把 results 提升到该处可见作用域（最小改动，不改落 store 语义）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-lane-meltdown.test.mjs server/engine-lane-trunc.test.mjs server/subagent.test.mjs server/engine-guard-meltdown.test.mjs`
Expected: PASS（新增 1 + 子 lane/守卫既有零回归；主循环熔断测试不受影响）。

- [ ] **Step 6: Commit**

```bash
cd C:/Users/T203-15/ponos-dev && git add kernel/engine.mjs kernel/api.mjs server/engine-lane-meltdown.test.mjs && git commit -m "fix(kernel): 子 lane 补失败熔断守卫，连续工具全败达上限即收尾（审计 #4）"
```

---

### Task 2: #5 子 lane 补上下文溢出（400）自愈——输出预算收窄半臂

**Files:**
- Modify: `kernel/engine.mjs`（`runSubAgentLoop`：attemptMaxTokens 可变预算 + catch 增 context-window 分支）
- Modify: `kernel/api.mjs`（mockStream：追加 lane 溢出模拟——以 api.mjs 实际错误模拟结构为准）
- Test: `server/engine-lane-overflow.test.mjs`（新建）

**Interfaces:**
- Consumes: 主循环溢出 catch 分支（`engine.mjs:628-703`：`classifyApiError(err).kind === 'context-window'`、`realLimit`/`promptN` 正则 638-639、收窄公式 685-694、`overflowed → continue` 710）；`attemptMaxTokens` 声明 433、`maxTokens` 358；子 lane 现请求 @1077 直接用 maxTokens、catch（1113-1121）对 context-window 走 `else throw err` → lane status='failed'（runLaneExecution 1198-1201）
- Produces: 子 lane 遇 context-window 400 时按主循环公式收窄输出预算并 continue 重试同轮；无法再收窄 → 与其它守卫一致的 `guardStop` 可见收尾；不再静默 throw 致 lane failed

- [ ] **Step 1: 通读镜像源与 lane 请求/catch（只读）**

读 `engine.mjs:628-710`（主循环溢出分支 verbatim：catch 入口 616-627、解析 638-657、forceCompact 调用 659-672、收窄 676-703）、`engine.mjs:1070-1080`（lane 请求构造：maxTokens 传参处）、`engine.mjs:1105-1125`（lane catch 全分支）。确认 `classifyApiError` 在 engine.mjs 的导入与 `kind === 'context-window'` 判定；确认 lane 请求错误对象（`err`）上 message 的形状（供正则解析）。再读 `kernel/api.mjs` 是否有既有 API 错误模拟（如产 `{ type: 'error' }` chunk 或 throw 带 context-window 文案），决定 lane 溢出 mock 的追加方式（报告记录实测结构与选择）。不臆造。

- [ ] **Step 2: 写失败测试**（先复现：lane 遇 400 直接 failed，无收窄重试）

新建 `server/engine-lane-overflow.test.mjs`（makeEnv 同 lane-trunc）。mock 方案：lane 首轮产"超窗 token 用量"使请求被 mock 判 400——若 api.mjs 的 context-window 错误模拟不存在，追加 lane marker（如 `[mock:lane-overflow]`）产一次"400 溢出错误"（首轮触发），随后 mock 正常产出成功 Bash（模拟收窄后重试成功）。用例断言：
```js
// 子 lane 溢出自愈（审计 #5）：context-window 400 时输出预算收窄重试而非静默 failed。
test('子 lane：上下文溢出后收窄重试成功，不以 failed 收场', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-overflow]' })
    // 子任务正常完成（通知存在、非 failed）
    const sys = env.events.filter((e) => e.type === 'system')
    const started = sys.find((e) => e.subtype === 'task_started')
    const notif = sys.find((e) => e.subtype === 'task_notification' && e.task_id === started?.task_id)
    assert.ok(notif, '应有 task_notification（lane 不应 failed）')
    // lane 转录含重试后的成功工具结果（echo mock-lane-overflow-ok），证明收窄后同轮继续
    const lane = readFileSync(env.laneFile(started.task_id), 'utf-8')
    assert.ok(lane.includes('mock-lane-overflow-ok'), `lane 应含收窄重试成功结果，实际：${lane.slice(-400)}`)
  } finally { env.cleanup() }
})
```
> 若实测 api.mjs 无法廉价模拟"400 后同轮重试成功"（如 mock 无 per-request 状态机），可退化为：断言 lane 不再以 `status='failed'` 收场、通知含收窄/溢出可见文案——报告记录取舍。测试意图不变：子 lane 遇 400 须有自愈路径，禁止静默 failed。

- [ ] **Step 3: 跑测试确认失败**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-lane-overflow.test.mjs`
Expected: FAIL —— 修复前 lane catch 对 context-window 抛 err → runLaneExecution 置 failed。

- [ ] **Step 4: 生产代码修复**（engine.mjs runSubAgentLoop，镜像主循环收窄公式）

① 在 lane 轮变量区（Task 1 的 `subErrorStreak` 旁）声明可变预算：
```js
let attemptMaxTokens = maxTokens   // P1-#5（子 lane，审计 #5）：溢出收窄的可变输出预算（初值同主循环 433）
```
并把 lane 请求处（约 1077）传 `maxTokens` 的位置改为传 `attemptMaxTokens`。
② 在 lane catch（约 1113-1121）的 abort/subStop/watchdog 分支之后、`else throw err` 之前插入 context-window 分支（镜像主循环 628-703 的收窄半臂——lane 无 compactor，**不做 forceCompact**）：
```js
        } else if (classifyApiError(err).kind === 'context-window') {
          // P1-#5（子 lane 镜像，审计 #5）：上下文溢出自愈——只做输出预算收窄重试（短会话
          // 设计无压缩，engine.mjs:1035-1036 注释）。正则/公式镜像主循环 638-639 / 685-689。
          const m = String(err?.message || err)
          const limit = /maximum context length is (\d+)/.exec(m)
          const promptN = /prompt contains (?:at least )?(\d+)/.exec(m)
          const limitN = limit ? Number(limit[1]) : 0
          const nextBudget = limitN > 0
            ? (promptN
                ? Math.max(2048, Math.min(attemptMaxTokens, limitN - Number(promptN[1]) - 2048))
                : Math.max(2048, Math.floor(attemptMaxTokens / 2)))
            : attemptMaxTokens
          if (nextBudget < attemptMaxTokens) {
            attemptMaxTokens = nextBudget
            continue // 收窄成功 → 同轮重试（受循环头墙钟/迭代上限守卫覆盖，无需额外防死循环）
          }
          return guardStop(stopNotice(
            '上下文已超出模型窗口，输出预算收窄仍无法腾出空间，本轮子任务已放弃执行。',
            'context-window',
          ))
        }
```
> `classifyApiError` 若未在 engine.mjs 顶层可见（研究确认 catch 已用 `classifyApiError(err).kind` 于主循环 622-628，同一模块内应可直接引用——以实际作用域为准）。`stopNotice`/`guardStop` 形参照抄既有调用。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-lane-overflow.test.mjs server/engine-lane-trunc.test.mjs server/engine-lane-meltdown.test.mjs server/compact.test.mjs`
Expected: PASS（新增 + 子 lane/compact 既有零回归）。

- [ ] **Step 6: Commit**

```bash
cd C:/Users/T203-15/ponos-dev && git add kernel/engine.mjs kernel/api.mjs server/engine-lane-overflow.test.mjs && git commit -m "fix(kernel): 子 lane 上下文溢出输出预算收窄自愈，不再静默 failed（审计 #5）"
```

---

### Task 3: #6 审批挂起超时——验证 HEAD 实现 + 补行为测试 + 文案动态化收尾

**Files:**
- Modify: `kernel/engine.mjs`（gateToolUse 超时 message 文案动态化，约 949-955）
- Test: `server/engine-approval-timeout.test.mjs`（新建）或追加 `server/engine-session.test.mjs`

**Interfaces:**
- Consumes: 审批等待现状（`engine.mjs:936-962`：`approvalWaiters` Map + setTimeout deadline；`PONOS_APPROVAL_TIMEOUT_MS` 默认 600_000，超时 resolve `{behavior:'timeout'}`，`behavior !== 'allow' && !== 'timeout'` 才计 denial）；既有审批挂起中 abort/hardStop 测试 `server/engine-session.test.mjs:177-241`（no-op wire 自动回执 allow 的注释见其 24 行）
- Produces: 审批超时行为有测试锁定（超时不卡死、按未授权回填、不计 denial、可配时长生效）；超时 message 与可配时长一致

- [ ] **Step 1: 验证 HEAD 现状（只读，记录结论）**

读 `engine.mjs:936-962`（gateToolUse 审批等待与超时语义）、`engine.mjs:380`/`1435-1441`/`1320-1329`（approvalWaiters 声明/外部 resolve/取消兜底）。**确认审计快照过时**：`git log -S PONOS_APPROVAL_TIMEOUT_MS --oneline` 唯一命中 0817e8d；`git show 0817e8d^:kernel/engine.mjs | sed -n '860,870p'` 验证彼时确无超时。把结论写入 Task 报告与 Task 5 回归记录（#6 同 #7 为过时快照，剩余空间 = 测试覆盖 + 文案一致性）。

- [ ] **Step 2: 写失败测试**（无覆盖 → 先 RED 锁定超时行为）

新文件或追加（**推荐新文件 `server/engine-approval-timeout.test.mjs`**，镜像 engine-session.test.mjs 的审批 harness 写法——先读该文件 177-241 与 dock-approval.test.mjs 的 wire stub 约定）。核心：engine 需 `skipPermissions: false` 且 wire.controlRequest 记录但不自动回执（engine-session 的 no-op wire 自动 allow 是为防挂起——本测试要**主动触发超时**，故 wire 必须不回执，靠 deadline resolve）。用例：
```js
// 审批超时（审计 #6 收尾）：PONOS_APPROVAL_TIMEOUT_MS 生效——超时按未授权回填、不卡死、不计 denial。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_APPROVAL_TIMEOUT_MS = '300'   // 收敛用例时长（须在 import engine 前冻结）
// ...（import 布局与 harness 镜像 engine-session.test.mjs 审批用例；wire 不回执 controlRequest）
test('审批挂起超时：行为=timeout、按未授权回填、不累计 denial', async () => {
  // 触发一次需审批的 Bash 工具调用（权限未预批、wire 不回执）
  // 断言：runTurn 在 ~300ms 后正常返回而非永久挂起；
  // 该工具结果 is_error 且提示超时/未执行（模型转向安全替代——mock 后续产出确认文本）；
  // denial 计数未因此超时递增（对照 engine-session 的 denial 降级用例语义）。
})
```
> 触发"需审批的 Bash"mock：以 engine-guard 系 harness（skipPermissions:true）为反例——本测试须 `skipPermissions: false` 并令 mock 产一个**未预批权限**的工具调用；mock 形态（Bash vs 其它工具、权限预批表位置）以读 engine-session.test.mjs/kernel-engine.test.mjs（审批闭环 258/290/312/466 行）实测为准。若既有审批测试无"未回执 wire"先例，报告记录你建的 stub 形状。

- [ ] **Step 3: 跑测试确认失败（或记录"已绿需强化断言"）**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-approval-timeout.test.mjs`
Expected: FAIL（无此测试文件/断言不过）——注意：**超时机制本体已实现**，本步 RED 的语义是"行为无测试锁定"，若 mock 一经搭好即绿，须补更强断言（如超时时长 ≈ 配置值、timeout 不计 denial 的对照断言）直到能区分"有 deadline"与"无 deadline"两种实现。测试须能证明：去掉 deadline（模拟审计旧快照）测试必红。

- [ ] **Step 4: 生产代码文案动态化**（小修）

`engine.mjs` 超时 resolve 的 message（约 954-955）把硬编码"审批等待超时（10 分钟未收到用户响应）"改为按 `approvalTimeoutMs` 动态（分钟/秒按值自适应）：
```js
          const mins = Math.round(approvalTimeoutMs / 60000)
          const label = approvalTimeoutMs % 60000 === 0 ? `${mins} 分钟` : `${Math.round(approvalTimeoutMs / 1000)} 秒`
          resolvePromise({ behavior: 'timeout', message: `审批等待超时（${label}未收到用户响应），未执行该操作` })
```
> 若 Step 2/3 的断言已覆盖 message 内容，改后须与断言一致；若断言不含 message，则本步为纯文案收尾（审计 #6 的"配置与文案不一致"边角）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-approval-timeout.test.mjs server/engine-session.test.mjs server/kernel-engine.test.mjs`
Expected: PASS（新增 + 审批既有零回归）。

- [ ] **Step 6: Commit**

```bash
cd C:/Users/T203-15/ponos-dev && git add kernel/engine.mjs server/engine-approval-timeout.test.mjs && git commit -m "test(kernel): 审批挂起超时行为测试 + 超时文案动态化（审计 #6 收尾）"
```

---

### Task 4: #11 全量门禁 flaky 治理——spawn/bridge 收集超时统一提升

**Files:**
- Modify: 定位所有 `collect`/`next`/`waitLogFile*` 的 5s 默认超时定义处（Grep 定位，预计在 `server/kernel-bridge.test.mjs`、`server/bridge-contract.test.mjs`、`server/kernel-contract.test.mjs`、`server/kernel-engine.test.mjs`、`server/zz-concurrency.test.mjs`、`server/stats.test.mjs`、`server/diag-info.test.mjs` 中的每文件内建 helper，或有共享 helper——以实测为准）
- Run only（验证）：全量 `node --test "server/*.test.mjs"` 连续两次

**Interfaces:**
- Consumes: 无
- Produces: 结构性脆弱点（5s 硬超时）消除——默认 15000 且支持 `PONOS_TEST_COLLECT_TIMEOUT_MS` 覆盖；全量门禁连续两次全绿为凭（#11 治理的"门禁可靠"判定）

- [ ] **Step 1: 定位全部收集超时默认值（只读）**

Run:
```bash
cd C:/Users/T203-15/ponos-dev && grep -rn "timeoutMs = 5000\|timeoutMs=5000\|= 5000\|5000" server/*.test.mjs | grep -iv "expect\|assert" | head -40
```
读命中的每处定义（collect/next/waitLogFile 等 helper 的函数头），确认是"每次调用默认参数"还是"共享常量"；若存在共享 helper 文件则统一改一处，否则逐文件改。

- [ ] **Step 2: 统一提升并支持 env 覆盖**

每处 helper 默认超时从 5000 改为读环境变量（镜像 engine.mjs 的 `envNonNeg` 风格，测试文件内就地实现）：
```js
const TEST_COLLECT_TIMEOUT_MS = Number(process.env.PONOS_TEST_COLLECT_TIMEOUT_MS) > 0
  ? Number(process.env.PONOS_TEST_COLLECT_TIMEOUT_MS) : 15000
```
并把该 helper 的 `timeoutMs = 5000` 默认/调用处替换为 `timeoutMs = TEST_COLLECT_TIMEOUT_MS`（或按实测 helper 签名就近替换）。**只在收集等待默认值处改，不改任何断言语义与超时后的错误信息格式**（错误文案被既有断言引用处保留）。

- [ ] **Step 3: 结构验证 + 全量门禁复跑**

Run:
```bash
cd C:/Users/T203-15/ponos-dev && grep -rn "timeoutMs = 5000" server/*.test.mjs || echo "无 5000 硬编码残留"
cd C:/Users/T203-15/ponos-dev && node --test "server/*.test.mjs"
```
Expected: grep 无残留；全量绿（513 + 本计划新增用例）。**再连续复跑第二次**确认稳定（门禁可靠凭据：两次连续全绿）。

- [ ] **Step 4: Commit**

```bash
cd C:/Users/T203-15/ponos-dev && git add server/ && git commit -m "test(kernel): spawn/bridge 类测试收集超时 5s→15s 并支持 env 覆盖，治理并行 flaky（审计 #11）"
```
> 若 Step 1 发现某些 5s 属于非收集性断言超时（语义敏感），跳过该处并在报告注明。

---

### Task 5: P1 修复后回归固化（含 #6/#7 快照过时结论记录）

**Files:**
- Run only（无源码改动）

**Interfaces:**
- Consumes: Task 1-4 已提交
- Produces: S2-P1 完成证据（并入 S3 迁移基线的回归记录）；审计项最终处置表

- [ ] **Step 1: 全量复跑**

Run:
```bash
cd C:/Users/T203-15/ponos-dev && node --test "server/*.test.mjs"
```
Expected: 全部 PASS（513 + 本计划新增 suite 数；两次复跑稳定）。

- [ ] **Step 2: 提交回归记录**

在本计划文档（`docs/superpowers/plans/2026-09-07-s2-p1-kernel-p1-fixes.md`，yfworking 库）末尾"执行记录"区追加：各 Task pass 数、审计项最终处置（#4/#5 修复+#测试、#6 验证快照过时（0817e8d 已实现）+补测试+文案动态化、#11 超时提升+两次全绿）、任何既有红项。随文档在 yfworking 提交：
```bash
cd C:/Users/T203-15/yfworking && git add docs/superpowers/plans/2026-09-07-s2-p1-kernel-p1-fixes.md && git commit -m "docs(plan): S2-P1 执行记录"
```

---

## 执行记录（S2-P1，待填充）

（执行后记录：各 commit、审计项最终处置、全量门禁结果）
