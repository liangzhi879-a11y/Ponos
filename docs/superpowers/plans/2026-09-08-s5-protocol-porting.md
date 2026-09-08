# S5 协议增强移植实施计划

- 日期：2026-09-08
- 执行仓库：`C:\Users\T203-15\yfworking`（净室，HEAD 5bc5ce1，S4 完结态）
- 上级权威：`docs/superpowers/specs/2026-09-07-yfworking-ponos-kernel-switch-design.md` §10（移植方法）/§4（DoD）/§6（子工程表）
- 输入基线：S1 清单②（audit doc `docs/superpowers/audits/2026-09-07-s1-diff-audit.md`，9 项候选 complete）；pd 参照证据包 `.superpowers/sdd/2026-09-08-s5-protocol-porting/pd-reference-pack.md`（scratch，pd HEAD 1696286 只读采集）
- 前置状态：S4 完结（双版隔离 51517/5197/4197 已落地）；产品基线 139/139（server/electron node --test）、kernel-tests 50/50；GUI src 无自动测试设施（package.json test 不含 src）

## 1. 目标

按 S1 清单②把 pd 侧 server/GUI 协议增强中**净室仍缺的 4 项**移植进净室：②-03 技能清单去重、②-07 WS 半开心跳、②-05 守卫自愈接线、②-02 压缩可见化。移植单元 = 代码改动 + 配套测试（测试权威：先锁基线再改实现）。**不携带 v3 UI**；内核侧能力（审批门/守卫/CJK 估算/compaction 事件源等）已随 S3 迁入，不重复移植。

**范围边界**：kernel/、kernel-tests/ **零改动**（S5 全部改动落在 server/electron/src/scripts；内核行为用 server/ 侧跨层 import 单测锁住，不动内核实现）。不含 ②-08（内核已支持 reasoning_effort/switch_provider——净室 cli.mjs:595/620，bridge 透传 + GUI 入口价值有限，延后记 S5 backlog）。不含 ②-04（净室已含，见 F4）。不做任何 GUI 视觉重构。

## 2. 调研结论（2026-09-08 实测，plan 依据）

### 2.1 净室现状事实（控制器现场核实）

| # | 事实 | 证据 |
|---|---|---|
| F1 | **②-03 双份实锤**：内核 composeSystemPrompt 注入【可用技能】块（技能 roots = --add-dir 叠加 <configDir>/skills）；bridge 宿主 appendSkillList 仍在 new+resume 双路径注入【已安装技能清单】 | kernel/prompt.mjs:100；server/bridge.mjs:915/938 |
| F2 | **②-03 内核侧等价块净室已随迁**（pd prompt.mjs:97 同源）；bridge 已把技能根作为 `--add-dir` 传入（cli 自发现） | kernel/prompt.mjs:85-115；server/bridge.mjs:955 |
| F3 | **②-07 净室 bridge 仅 ws 库级 ping**（server→client，:2002/:2087），无应用层 GUI ping/60s 判死；GUI useYFWCLI 无心跳（重连走指数退避 86-97） | server/bridge.mjs:2002；src/hooks/useYFWCLI.ts:102-130 |
| F4 | **②-04 已落地**：净室 electron/browser-executor.cjs:121/164/170 含 isInsideOverlay，行号与 pd 全同 → 不需移植 | electron/browser-executor.cjs |
| F5 | **②-05/②-02 事件源净室全齐**：compaction system 事件（compact.mjs:374 start/:427 done，finally 对称补发）；loop 帧（protocol.mjs:61 type:'loop'）；bridge 失速看门狗发顶层 kernel-stall（bridge.mjs:2049-2065，只告警不杀，stdout 行刷新 _lastOutAt） | kernel/compact.mjs；kernel/protocol.mjs；server/bridge.mjs:2049-2065 |
| F6 | **bridge 内核事件全量透传**：NDJSON 原帧 → `{type:'event', data: parsed}`（:1135）→ GUI handleMessage event 分支 | server/bridge.mjs:1135；useYFWCLI.ts:531 |
| F7 | **净室 GUI 零消费**：useYFWCLI system 分支仅 init/task_started/task_progress/task_notification（572-607）；无 kernel-stall（顶层 msg）case、无 loop/compaction 分支（grep 0） | useYFWCLI.ts:572-607 |
| F8 | **GUI 挂载面现成**：ChatWindow 顶部 HealthGlow/BrowserStatusBar（202-204）、底部 RunningAgentsBar/CompressedToast（399-402）；CompressedToast 走 yfw_summary→healthStore（与 ②-02 的 system/compaction 进行中态互补不冲突） | ChatWindow.tsx；CompressedToast.tsx:14 |
| F9 | **GUI store 结构**：uiStore = zustand persist（partialize 白名单 263-272，新瞬时字段不入持久化）；chatStore persist 有回退修复 + runtime-only 先例（milestone progress，:347）。瞬态 stall/loop/compacting 应放非持久区 | uiStore.ts:263-272；chatStore.ts:347 |
| F10 | **GUI 停止能力现成**：streamingSessions Set（:38）+ stopStreaming（chatStore）+ cancel 发送路径（:362-367）→ KernelStallBar 取消按钮可复用 | useYFWCLI.ts:362-367 |
| F11 | **测试设施边界**：npm test = `node --test "server/*.test.mjs" "electron/*.test.mjs"`（不含 src）→ server 侧改动可加 node --test（仿 S4 kernel-bridge.test.mjs）；GUI 改动验证 = typecheck + vite build + manual | package.json:19 |
| F12 | **宿主技能拼装区**：appendSkillList/buildCompactSkillSection/formatSkillEntry/listInstalledSkills/skillDirFingerprint 及其缓存全局，唯一外部消费 `scripts/verify-skill-listing.mjs`（cg 迁入，import 面 T1 第一步核对） | server/bridge.mjs:773-878；scripts/verify-skill-listing.mjs |
| F13 | bridge WS onmessage 分支现为 executor:hello/browser:exec:response/browser:event/send/cancel 链（2060-2145 区）——ping→pong 分支插入点明确 | server/bridge.mjs:2060-2145 |

### 2.2 pd 参照要点（详细证据包见 scratch pd-reference-pack.md）

| 候选 | pd 现状 | 移植形态 |
|---|---|---|
| ②-03 | pd bridge 宿主注入已停用（:990/:1013 注释 P8），appendSkillList 保留导出仅 `scripts/verify-skill-listing.mjs:7` 用；resume/new 剩余 append = ASKUSER + MILESTONE（+经验注入）；技能根 `--add-dir`（:1033） | 净室做同款停用；ASKUSER/MILESTONE/经验注入保留；宿主技能拼装删除或仅保留回归导出（T1 按净室 verify-skill-listing 引用面定，见 Task 1） |
| ②-05 | GUI 在 **pd v2 src/**（与净室同构，可移植性最高）：KernelStallBar.tsx（uiStore.kernelStalls[sid]=silentMs，取消=stopStreaming+stop）；LoopStatusBar.tsx（chatStore.loopStates[sid]，reason 五值）；usePonosCLI:613-616（kernel-stall）、:617-620（任何 event/error/cancelled/closed 到达 clearKernelStall）、:638-650（loop start/iter/end 归约）；LoopState 类型见 types/index.ts:49-63 | store 字段 + hook 分支 + 组件 + ChatWindow 挂载，按净室样式系统（tailwind class + i18n 键）重写 |
| ②-02 | 事件负载 `system('compaction',{state:'start',covered,coveredTokens})` / `{state:'done',ok}`；GUI 归约纯函数（session.ts:137-145 幂等 start set/ done+error reset）；指示条 `busy && tree.compacting` | useYFWCLI system 分支归约 + 净室指示条组件；compacting 状态放 chatStore runtime-only |
| ②-07 | bridge `msg.type==='ping'`→回 `{type:'pong',t}`（:2311-2315，注释：半开时浏览器 send 静默失败，仅协议层 ping 无法感知）；GUI startHeartbeat 15s ping / 60s 无任何消息判死强关 `s.close()` 走重连（usePonosCLI.ts:107-127），onmessage 刷 lastWsActivity、:169 滤 pong | bridge 一行分支 + GUI 心跳（接现有 getOrCreateWS 生命周期 + 指数退避重连） |

### 2.3 已敲定决策（D 表）

| # | 决策 | 内容 | 验证/兜底 |
|---|---|---|---|
| D1 | **技能可见性由内核承担** | 停用净室 bridge 宿主技能清单注入；技能清单唯一来源 = 内核 composeSystemPrompt【可用技能】块（经 --add-dir 技能根发现）；宿主保留 ASKUSER/MILESTONE/经验注入。宿主技能拼装函数与缓存的保留面由 T1 按 `scripts/verify-skill-listing.mjs` 引用决定（其 import 被删导出 → 改指 kernel/prompt.mjs 断言，语义宿主清单→内核技能块） | T1：先加 server/prompt-skills.test.mjs 锁内核技能块行为基线，再删宿主注入，npm test 全量回归 + verify-skill-listing 绿 + GUI manual 技能调用闭环 |
| D2 | **GUI 瞬态状态存放** | kernelStalls → uiStore（Record<convId,silentMs>，不入 partialize）；loopStates / compacting → chatStore runtime-only（复用 milestone runtime-only 先例 :347） | T3/T4 typecheck 保类型；manual 验证 |
| D3 | **②-07 心跳参数同 pd**：15s ping / 60s 无消息判死强关 | bridge 只回 pong 不判超时（自愈在 GUI 侧，复用现有指数退避重连）；ws 库级 ping（server→client 僵尸回收）保留不动 | T2 server/ws-heartbeat.test.mjs（spawn bridge mock + WS ping→pong 断言） |
| D4 | **②-08 排除出本 S5**（内核已支持，bridge 透传 + GUI 档位入口价值有限且面板 v3 排除） | 记 S5 backlog，S6 前如产品明确运行时热切需求再评估 | roadmap 完结记录标注 |
| D5 | **GUI 验证口径**：src 无测试设施且不引入 vitest（纪律）→ GUI 改动验证 = `npm run typecheck` + `npm run build` + 授权 manual 冒烟行（沿用 S4 GUI manual 先例）；业务归约逻辑尽量抽纯函数由 server/ 跨层测试锁定（②-03 内核技能块、②-02 归约可测部分） | 各 Task 验证命令节写明；manual 行标 manual | 

## 3. S1 清单② → Task 消费映射

| Task | 候选 | 面 | 核心改动 |
|---|---|---|---|
| T1 | ②-03 技能清单去重 | server | bridge 停宿主注入；server/prompt-skills.test.mjs 锁内核技能块 |
| T2 | ②-07 WS 半开心跳 | server+GUI | bridge ping→pong；GUI startHeartbeat/判死；ws-heartbeat.test.mjs |
| T3 | ②-05 守卫自愈接线 | GUI | KernelStallBar + LoopStatusBar + store 字段 + hook 分支 + 挂载 |
| T4 | ②-02 压缩可见化 | GUI | system/compaction 归约 + 指示条 + 挂载 |
| T5 | 完结 | docs | roadmap S5 标注勾选 + 执行记录 + S5 backlog 移交 + ledger + completion report |

## 4. Task 明细

---

## Task 1 — ②-03 技能清单去重（server）

**范围**：停净室 bridge 宿主技能清单注入，使技能清单唯一来源为内核【可用技能】块；不触碰 kernel/。

步骤：
1. **锁内核技能块基线（先行）**：新增 `server/prompt-skills.test.mjs`（node --test，仿 S4 kernel-bridge.test.mjs 基建；import `../kernel/prompt.mjs`——跨层 import 先例 review-task5 minor#3 已认可为受控 touchpoint）：`composeSystemPrompt({ toolNames:[], skills:[{id:'sample-skill',triggers:['x','y']}], ... })` 输出含【可用技能】块、技能 id 与触发词、父子内联；skills 为空时不产出技能块。跑绿即基线。
2. **核对引用面**：读 `scripts/verify-skill-listing.mjs` 首部 import——若 import 了 `server/bridge.mjs` 的 appendSkillList/listInstalledSkills/formatSkillEntry 任一：
   - 语义若为"宿主技能清单格式回归"→ 改脚本 import 源为 `../kernel/prompt.mjs` 的 composeSystemPrompt（断言内核技能块格式），或改为对 `listInstalledSkills` 等价行为的样本断言（实现者按脚本现状最小处置，report 说明）；
   - 语义与宿主注入无关 → 不动。
3. **改 `server/bridge.mjs`**：删除宿主技能注入面 = `appendSkillList`/`buildCompactSkillSection`/`formatSkillEntry`（若 verify-skill-listing 已不再引用）及 `skillListCache`/`skillListCacheKey` 全局；new 路径（:938）与 resume 路径（:915）改回纯"互动协议 + 经验注入"拼装（resume 去掉 `buildCompactSkillSection` 调用，保留 ASKUSER+MILESTONE+经验段；new 保留系统提示 + ASKUSER+MILESTONE+经验段，不再 append 技能清单）；`--add-dir` 技能根（:955）与 `findSkillRoot` **保留**（内核发现入口）。若 `listInstalledSkills` 仍有其它消费（如 transcript/诊断）则仅删技能拼装段，report 列出最终保留面。
4. **回归**：`npm run typecheck`；`npm test`（139+ 新增全绿）；`node --test kernel-tests/*.mjs`（50/50 应不受影响）；若脚本被改则单跑改后脚本绿；`npm run build`。
5. **GUI manual 行（授权标注）**：dev GUI 新会话 + resume 会话各发一句含技能触发词任务，确认 Skill 工具被调用且会话系统上下文无重复技能清单（对 %TEMP% 提示文件删除前取样或据 resp 行为确认）。

产出 commit：`refactor(s5)` + `test(s5)`。

---

## Task 2 — ②-07 WS 半开心跳（server + GUI）

**范围**：bridge 应用层 ping→pong + GUI 心跳判死自愈。

步骤：
1. **bridge**：`server/bridge.mjs` WS onmessage 分支链（:2060-2145）加 `else if (msg.type === 'ping')` → `ws.send(JSON.stringify({ type:'pong', t: Date.now() }))`（try/catch 包裹；注释说明半开语义，参照 pd :2311-2315）。
2. **测试（先行或同步）**：新增 `server/ws-heartbeat.test.mjs`：临时 home + PONOS_MOCK_API=1 + 随机空闲口 spawn 本库 bridge（spawn 模式仿 S4 kernel-bridge.test.mjs 的环境隔离：CLAUDE_CONFIG_DIR/YFWORKING_HOME=临时、删除 PONOS_HOME）；等 ready 后开 WebSocket（node 全局 WebSocket）连入；send `{type:'ping'}`；断言收 `{type:'pong'}`（含 t 数值）；收毕关闭并清理进程/目录。单用例即可，事件驱动等待 + 超时兜底。
3. **GUI**：`src/hooks/useYFWCLI.ts`：
   - 模块级 `lastWsActivity`/`heartbeatDead`/`heartbeatTimer` + 常量 `WS_HEARTBEAT_INTERVAL_MS=15000`、`WS_HEARTBEAT_TIMEOUT_MS=60000`；
   - `startHeartbeat()`：每 15s，`ws.OPEN` 时 `idle = now-lastWsActivity`；`idle>60000` → `heartbeatDead=true; try{s.close()}catch{}`（触发既有重连）；否则 `send({type:'ping'})`；
   - onopen 与 onmessage 均刷 `lastWsActivity`；onmessage 顶部 `if (msg.type==='pong') return`（不进业务分发）；
   - getOrCreateWS 建连（:107 前后）启动 heartbeat、onclose 停；重连路径（scheduleReconnect）清 `heartbeatDead`。
4. **验证**：`npm run typecheck`；`npm run build`；`npm test`（新用例并入绿）。manual（可选，授权标注）：dev GUI 运行中停 bridge 进程 → GUI 60s 内判死重建提示；恢复后会话可续。

产出 commit：`feat(s5)` + `test(s5)`。

---

## Task 3 — ②-05 守卫自愈接线（GUI：KernelStallBar + LoopStatusBar）

**范围**：纯 GUI 接线，消费净室已存在事件（bridge kernel-stall 顶层消息 + 内核 loop 帧经 event 透传）。bridge/server/kernel 零改动。

步骤：
1. **类型**：`src/types/index.ts` 加 `LoopState`（pd types/index.ts:49-63 形状）：`{ active; index; total; until?; fresh?; reason?: 'completed'|'until_hit'|'cancelled'|'judge_error'; judgeReason? }`。
2. **uiStore**（`src/stores/uiStore.ts`）：state 加 `kernelStalls: Record<string, number>`（convId→silentMs）+ `setKernelStall(id, ms)`（merge）/`clearKernelStall(id)`（delete 幂等）；**不加入 partialize**（瞬时态）。
3. **chatStore**（`src/stores/chatStore.ts` runtime-only，:347 先例区）：`loopStates: Record<string, LoopState>` + `setLoopState(id, patch)`（merge prev 默认 `{active:false,index:0,total:1}`）/`clearLoopState(id)`；不进 persist。
4. **useYFWCLI**（handleMessage）：
   - 顶层：`if (msg.type === 'kernel-stall') { setKernelStall(sid, Number(msg.data?.silentMs)||0); return }`；
   - 自愈清除：`event`/`error`/`cancelled`/`closed` 到达（含顶层与 event 分支）→ `clearKernelStall(sid)`（任何内核输出 = 已自愈）；
   - event wrapper 内：`if (data.type === 'loop')`：`state==='start'` → `setLoopState(sid,{active:true,index:0,total,until,fresh})`；`state==='iter'` → `{index,total,judgeReason}`；`state==='end'` → `{active:false,index,total,reason}`（净室 kernel loop 帧 state 值域 start/iter/end，见 protocol.mjs:61）。
5. **组件**（参照 pd v2 组件语义，按净室 tailwind/i18n 重写）：
   - `src/components/chat/KernelStallBar.tsx`：`kernelStalls[conversationId]` 非 number 即 null；显示「内核静默 Xs，可能失速」+ 取消（`stopStreaming(convId)`+hook stop/cancel 发送，复用 F10）+ 关闭（clearKernelStall）；
   - `src/components/chat/LoopStatusBar.tsx`：`loopStates[convId]` 非 active 即 null；index/total/until/judgeReason + reason 文案 map；≤8 轮点进度。
   - i18n 键：zh-CN/en-US translations（对照现有 health 组键位）。
6. **挂载**：`src/components/chat/ChatWindow.tsx` 顶部状态区（:202-204 HealthGlow/BrowserStatusBar 旁）挂 KernelStallBar；消息流/输入上方挂 LoopStatusBar（实现者按布局就近，最小侵入）。
7. **验证**：`npm run typecheck`；`npm run build`。manual（授权标注）：dev GUI 触发 agent/多轮 loop 会话看 LoopStatusBar 轮次条；失速可用暂停/挂起内核子进程制造（或临时调低看门狗阈值后恢复）看 KernelStallBar 出现与取消/自愈清除。

产出 commit：`feat(s5)`。

---

## Task 4 — ②-02 压缩可见化（GUI）

**范围**：纯 GUI 接线，消费净室内核已发 system/compaction（compact.mjs:374/427）。bridge/kernel 零改动。

步骤：
1. **归约**：`useYFWCLI.ts` event 分支 system 链（:607 task_notification 后）加 `subtype === 'compaction'`：`state==='start'` → `setCompacting(sid, true)`；`state==='done'||state==='error'` → `setCompacting(sid, false)`；幂等（start 时已 true 不重复置、done 时非 true 不动作——语义参照 pd session.ts:137-145）。
2. **chatStore runtime-only**：`compactingBySession: Record<string, boolean>` + `setCompacting(id, v)`。
3. **组件**：`src/components/chat/CompactingBar.tsx`（或并入消息流顶部条）：`compactingBySession[conversationId]` 为真即渲染「正在压缩上下文…（整理历史消息以腾出空间）」+ 轻量 spinner；i18n 键。净室侧判断：compaction 必发生在内核 turn 中、done 由 finally 对称补发 → 无需额外 busy 闸（pd 的 busy 闸属 v3 会话树模型，净室 streamingSessions 语义不完全对应，简化以 compacting 标志为渲染条件；report 说明取舍）。
4. **挂载**：ChatWindow 消息区顶/输入区上方（紧邻现有 RunningAgentsBar/CompressedToast 布局族，最小侵入）。
5. **验证**：`npm run typecheck`；`npm run build`。manual（授权标注）：dev GUI 长会话触发真实压缩（上下文越窗；可临时用 CLAUDE_CODE_AUTO_COMPACT_WINDOW 低阈值加速）→ 观察压缩期指示条出现、done 后消失；done/error 均不悬挂。

产出 commit：`feat(s5)`。

---

## Task 5 — 完结（docs + 收口）

1. roadmap `docs/superpowers/plans/2026-09-07-s3-s6-cleanroom-roadmap.md` S5 节：三条【推进标注】勾选（S1 清单② 完成、pd 对照表 → 引用 evidence pack、v3 边界逐项确认）；追加「执行记录（2026-09-08，S5 完结）」：commit 链、D1-D5、四项候选实测结论、②-04 已落地/②-08 延后说明、verify-skill-listing 处置、S5→S6 backlog 移交（②-08 热切需求、S6 backlog ①-⑩ 保持）。commit `docs(s5)`。
2. ledger `.superpowers/sdd/2026-09-08-s5-protocol-porting/progress.md`：T1-T5 状态 + review verdicts + 执行记录（scratch）。
3. completion report（scratch）：仿 S4 task-6-report.md——每 Task verbatim 验证结果、残余扫描（产品树 grep 确认无新 yfw/claude 字面量）、S6 交接。
4. S5 完结汇报（M4 里程碑）。

## 5. 门禁与纪律

- 每 Task implementer（subagent）+ 1 轮 reviewer（只读复核，仿 S4：spec 合规 + quality，blocking/minor 分级）。
- **kernel/、kernel-tests/ 零改动**（含注释）；`YF/` untracked 用户素材零触碰；`git add` 不得误收。
- GUI 相关 = typecheck + build + 授权 manual 行（沿用 S4 GUI manual 标注先例）；不引入 vitest/新依赖。
- commit 前缀：feat/refactor/test/docs + `(s5)`。
- 回归基线：`npm test` 全量（原 139 + 新增）、`node --test kernel-tests/*.mjs`（50）、`npm run typecheck`、`npm run build` 每 Task 收尾绿。
