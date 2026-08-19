# Plan&Execute 执行模式协议化 + 内核清理 + 高风险审批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① 删除内核 plan mode/accept mode 实现（EnterPlanMode/ExitPlanMode/planModeV2/审批组件 + 约 20 处引用）并重建 bundle；② 纯协议两态（MILESTONES 声明=进度条、无=活动条，无 exec-mode 事件）；③ 新增 MILESTONE-START 协议（进行中里程碑信号 + tooltip 当前里程碑）；④ 高风险命令强制审批（扩展 destructiveCommandWarning.ts + BashTool safetyCheck ask + 前端原生审批弹窗，激活现存 PermissionDialog 死代码）。

**Architecture:** 与里程碑协议同构——纯函数模块（`server/milestones.mjs` 扩展 + 新增 `server/highrisk.mjs`）+ bridge 解析转发 + 前端 Zustand 状态与渲染。内核改动经 `bun scripts/build-bundle.ts` 重建 bundle。

**Tech Stack:** Node ESM（server/*.mjs）、Electron 主进程 WebSocket 广播、React + Zustand（src/）、TypeScript（tsc --noEmit 类型门禁）、Bun（内核 bundle）。

**Design spec:** `docs/superpowers/specs/2026-08-14-plan-execute-mode-design.md`

## Global Constraints

- **内核删除面**（用户决策：工具本体 + 直接引用）：删 `tools/EnterPlanModeTool/`、`tools/ExitPlanModeTool/`、`utils/planModeV2.ts`、`components/permissions/ExitPlanModePermissionRequest/`、`EnterPlanModePermissionRequest/`；修复 §8 清单约 20 处引用；**保留** PermissionMode 类型 / PERMISSION_MODE_CONFIG / swarm-teammate 引用（不连锁）
- **不改进度条渲染逻辑**（Sidebar `conv-progress-fill`/`conv-progress-flow` 判定）、`globals.css`、i18n；模式标签沿用现状硬编码中文约定
- **commit 只 add 本任务涉及的具体文件**（repo 有大量 WIP 改动，绝不用 `git add -A`）
- **release 运行副本需双份同步**（内核 bundle + milestones.mjs + highrisk.mjs + bridge.mjs + dist）；重启 live 实例前必须征得用户同意
- 高风险清单**双副本同源**：内核 `destructiveCommandWarning.ts`（BashTool 强制 ask 用）+ `server/highrisk.mjs`（bridge 弹窗判定用），两处模式数组保持一致
- 批准恢复消息格式**已实证固化**（Task 5 Step 4）：spawn 需 `--permission-prompt-tool stdio`，恢复消息为 control_response（spec §4.2）
- `conversationProgress`（含 inProgress）为 runtime-only，不持久化
- 无 exec-mode 三态事件 / 无 execmode.mjs（纯协议两态）

---

### Task 0: 正式计划落盘

- [x] **Step 1**: 将本计划保存为 `docs/superpowers/plans/2026-08-14-plan-execute-mode.md`（去掉本 Task 自身及其 checkbox）（12ef15b）
- [x] **Step 2**: 提交 `git add docs/superpowers/plans/2026-08-14-plan-execute-mode.md docs/superpowers/specs/2026-08-14-plan-execute-mode-design.md && git commit -m "docs(exec-mode): 协议化+内核清理+高风险审批设计定稿与实施计划"`（12ef15b）

---

### Task 1: milestones.mjs MILESTONE-START 解析（TDD）

**Files:**
- Modify: `server/milestones.mjs`
- Create: `scripts/verify-milestones-start.mjs`

- [x] **Step 1: 写失败测试 `scripts/verify-milestones-start.mjs`**（9a7ba32）

```js
import { extractMilestoneMarks } from '../server/milestones.mjs'

let failed = 0
const check = (cond, label) => {
  if (cond) console.log('ok: ' + label)
  else { console.error('FAIL: ' + label); failed++ }
}

// START 解析
const t1 = extractMilestoneMarks('开始执行<!--MILESTONE-START 1/3 需求分析-->然后写代码')
check(JSON.stringify(t1.starts) === JSON.stringify([{ index: 1, total: 3, name: '需求分析' }]),
  'START 解析 1/3 需求分析')
const t2 = extractMilestoneMarks('<!--MILESTONE-START 2/3 方案设计--><!--MILESTONE-START 3/3 编码实现-->')
check(t2.starts.length === 2 && t2.starts[1].name === '编码实现', '多个 START 顺序解析')

// 剥离：START 标记不出现在 stripped
check(!t1.stripped.includes('MILESTONE-START') && t1.stripped.includes('开始执行') && t1.stripped.includes('然后写代码'),
  'START 标记从对话流剥离，周围文本保留')

// 现有功能不回归
const t3 = extractMilestoneMarks('<!--MILESTONES 3 需求分析|方案设计|编码实现-->')
check(t3.milestones?.total === 3, 'MILESTONES 声明不回归')
const t4 = extractMilestoneMarks('完成<!--MILESTONE-OK 1/3 需求分析-->')
check(t4.oks.length === 1 && t4.stripped === '完成', 'MILESTONE-OK 不回归')

// 乱序/超界/畸形不崩溃
check(extractMilestoneMarks('<!--MILESTONE-START 9/3 越界-->').starts[0].index === 9, '超界 START 不崩溃')
check(extractMilestoneMarks('<!--MILESTONE-START abc/3 畸形-->').starts.length === 0, '畸形 START 忽略')
check(extractMilestoneMarks('<!--MILESTONE-START 1/3 名称缺失 -->').starts[0]?.name === '名称缺失', 'START 名称空格 trim')

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n全部通过')
```

- [x] **Step 2: 运行测试确认失败**（`node scripts/verify-milestones-start.mjs`，starts 为 undefined → FAIL）（9a7ba32）
- [x] **Step 3: 扩展 `server/milestones.mjs`**（9a7ba32）

```js
// 进行中信号：<!--MILESTONE-START i/N 名称-->
const startRe = /<!--MILESTONE-START\s+(\d+)\/(\d+)\s+([\s\S]*?)-->/g
let s
while ((s = startRe.exec(text)) !== null) {
  out.starts.push({
    index: parseInt(s[1], 10),
    total: parseInt(s[2], 10),
    name: s[3].trim(),
  })
}
```

`out` 初始化加 `starts: []`；剥离正则追加 `|<!--MILESTONE-START\s*[\s\S]*?-->`；`hasMark` 正则与 `out.milestones || out.oks.length` 判断补 `out.starts.length`。

- [x] **Step 4: 运行测试确认通过**（exit 0，`全部通过`）（9a7ba32）
- [x] **Step 5: 提交** `git add server/milestones.mjs scripts/verify-milestones-start.mjs && git commit -m "feat(exec-mode): MILESTONE-START 解析与剥离（TDD）"`（9a7ba32）

---

### Task 2: highrisk.mjs 清单与匹配（TDD）

**Files:**
- Create: `server/highrisk.mjs`
- Create: `scripts/verify-highrisk.mjs`

- [x] **Step 1: 写失败测试 `scripts/verify-highrisk.mjs`**（8-10 断言：`rm -rf`, `rm -f`, `git reset --hard`, `git push --force`, `del /s /q`, `rmdir /s`, `taskkill /f`, `kill`, `move`, `mv`, `format`, `DROP TABLE` 命中；`ls`, `npm install`, `git status`, `cat` 不命中；大小写与引号包裹容错）（1c27a81）
- [x] **Step 2: 运行确认失败**（ERR_MODULE_NOT_FOUND）（1c27a81）
- [x] **Step 3: 写实现 `server/highrisk.mjs`**（1c27a81）

```js
// 高风险命令匹配（与内核 destructiveCommandWarning.ts 同构，见 spec §2.5）
// bridge 用：检测 BashTool tool_use 是否命中清单 → 前端审批弹窗
export const HIGH_RISK_PATTERNS = [
  // git 破坏性
  /git\s+(?:reset|rebase|merge|push)\s+[^\n]*?(?:--hard|--force|-f\b)/i,
  /git\s+clean\s+-[^ ]*f/i,
  /git\s+checkout\s+(?:--|\.)/,
  /git\s+restore\s+\./,
  /git\s+stash\s+(?:drop|clear)/,
  /git\s+branch\s+-D\b/,
  /git\s+commit\s+[^\n]*--amend/,
  /git\s+commit\s+[^\n]*--no-verify/,
  // 文件/目录删除（Unix + Windows）
  /\brm\s+(-[^\n]*\bf\b|\s+)/i,      // rm -f / rm -rf / rm 后跟路径
  /\b(?:del|erase)\b/i,
  /\brmdir\b/i,
  /\brd\s+\/s/i,
  /\bmove\b/i,                        // Windows move（文件移动）
  /\bmv\b/i,
  /\btakeown\s+\/f/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  // 进程/服务终止
  /\btaskkill\b/i,
  /\bkill\b/i,
  /\bStop-Process\b/i,
  // 数据库/基础设施破坏性
  /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bkubectl\s+delete\b/i,
  /\bterraform\s+destroy\b/i,
]

export function matchesHighRisk(command) {
  if (typeof command !== 'string' || !command.trim()) return false
  const c = command.trim().replace(/^["']|["']$/g, '') // 引号包裹容错
  return HIGH_RISK_PATTERNS.some((re) => re.test(c))
}
```

- [x] **Step 4: 运行确认通过**（1c27a81）
- [x] **Step 5: 提交** `git add server/highrisk.mjs scripts/verify-highrisk.mjs && git commit -m "feat(exec-mode): 高风险命令清单与匹配模块（TDD）"`（1c27a81）

---

### Task 3: 系统提示协议段追加（bridge.mjs）

**Files:**
- Modify: `server/bridge.mjs`

- [x] **Step 1**: `YFW_MILESTONE_PROTOCOL`（L55-67）追加（12095da）：

```
- 开始执行某个里程碑时，先输出开始标记：<!--MILESTONE-START i/N 名称-->
- 实施阶段（已批准计划后）按里程碑逐项推进：输出 <!--MILESTONE-START i/N 名称--> 表示开始，
  完成后输出 <!--MILESTONE-OK i/N 名称-->；同一时刻只执行一个里程碑（至少一个处于进行中）。
```

- [x] **Step 2**: `node --check server/bridge.mjs` 通过（12095da）
- [x] **Step 3**: 提交 `git add server/bridge.mjs && git commit -m "feat(exec-mode): 系统提示追加 MILESTONE-START 与执行阶段指导"`（12095da）

---

### Task 4: 内核清理（删工具 + 引用修复 + 重建 bundle）

**Files:**
- Delete: `yfw-kernel/claude-code/src/tools/EnterPlanModeTool/`（4 文件）、`tools/ExitPlanModeTool/`（4 文件）、`utils/planModeV2.ts`、`components/permissions/ExitPlanModePermissionRequest/`、`components/permissions/EnterPlanModePermissionRequest/`
- Modify: 约 20 处引用（spec §8 清单）

- [x] **Step 1: 删除目录与文件**（`git rm -r` 或 rm + git add，确认无其他引用后）（a21c3f4）
- [x] **Step 2: 逐文件修复引用**（spec §8 清单，每处移除 import / case / 注册 / 提示段）（a21c3f4）：
  - `tools.ts`：移除 `ExitPlanModeV2Tool`（L58/L209）、`EnterPlanModeTool`（L85/L221）
  - `constants/tools.ts`：移除 import（L4-5）与相关注释（L100）
  - `utils/messages.ts`：移除 planModeV2 import（L85/L161）、ExitPlanModeV2Tool import（L112）、plan 阶段 Phase 5 提示段（L3286-3290）
  - `utils/api.ts`、`utils/plans.ts`、`utils/ultraplan/ccrSession.ts`（import L12 + 注释 L191/L332）、`utils/permissions/classifierDecision.ts`（L3-4）、`skills/bundled/batch.ts`（L3-4）
  - `tools/AskUserQuestionTool/prompt.ts`（L1）、`tools/AgentTool/agentToolUtils.ts`（L59）、`built-in/exploreAgent.ts`、`verificationAgent.ts`、`planAgent.ts`（L2 import；planAgent 视用途：无独立用途则一并删除该文件并清 tools.ts 注册）
  - `components/permissions/PermissionRequest.tsx`（L4-5 import + L63-65/L130-133 case）
  - `components/agents/ToolSelector.tsx`（L10 import + L53 toolNames）
  - `components/tasks/RemoteSessionDetailDialog.tsx`（L16）
  - `state/AppStateStore.ts`（L20 AllowedPrompt type → 本地定义或移除）
  - `schemas/hooks.ts`（L135 注释）
- [x] **Step 3: grep 复核无残留引用**（`EnterPlanMode|ExitPlanMode|planModeV2` 仅剩注释性/无关项）（a21c3f4）
- [x] **Step 4: 重建 bundle**（Task 5 Step 3 一并重建，最终 bundle 已验证启动）
- [x] **Step 5: 提交**（分两个 commit：删除 + 引用修复，或合并一个；只 add 内核改动文件）（a21c3f4）

---

### Task 5: 内核高风险审批（强制 ask + 实证恢复格式）

**Files:**
- Modify: `yfw-kernel/claude-code/src/tools/BashTool/destructiveCommandWarning.ts`
- Modify: BashTool 权限检查（canUseTool，`tools/BashTool/bashPermissions.ts` 或 BashTool.ts 内）

- [x] **Step 1: 扩展 DESTRUCTIVE_PATTERNS**：补 Windows 命令（del/erase/rmdir/rd /s/move/taskkill/kill/format/diskpart/reg delete/takeown /f/Stop-Process）+ `rm -f`（单文件）+ `mv`
- [x] **Step 2: BashTool 权限检查命中 → 强制 ask**：在 canUseTool 权限判定处（query 权限流程返回 `{behavior:'ask', decisionReason:{type:'safetyCheck'}}` 之前）插入命中检测——命中 DESTRUCTIVE_PATTERNS → `{behavior:'ask', decisionReason:{type:'safetyCheck', reason:'yfw-highrisk-command'}}`（bypass-immune，L1252-1260 先例）
- [x] **Step 3: 重建 bundle**
- [x] **Step 4: 实证恢复消息格式（spec §11.1）**：`scripts/verify-permission-flow.mjs` 实证——关键发现：**spawn 必须加 `--permission-prompt-tool stdio`**（否则 ask 退化为自动 deny，无批准途径）；恢复消息为 control_response（格式固化至 spec §4.2），allow/deny 两路径实证通过（exit 0）
- [x] **Step 5: 提交**（5ddb427）

---

### Task 6: bridge 审批链路 + START 转发

**Files:**
- Modify: `server/bridge.mjs`

- [x] **Step 1**: spawn 参数追加 `--permission-prompt-tool stdio`（会话 spawn，verify-provider 一次性探针无需）；import `matchesHighRisk`（`server/highrisk.mjs`）
- [x] **Step 2（偏差：弃用 assistant tool_use 预判分支）**: 弹窗触发源改为内核 `control_request`（can_use_tool）——实证发现该事件携带 request_id 且为权威门禁；assistant tool_use 分支缺 request_id 无法驱动响应，且清单不同步时会产生幽灵弹窗。每条 can_use_tool 内核都会挂起等待响应，必须逐一转发（`session._pendingApprovals` Map 记录 toolUseId→requestId）
- [x] **Step 3: START 转发**（text 块处理内）：`for (const st of mk.starts) send({type:'milestone-start', sessionId: sid, data: st})`；`structuredUsed` 计入 `starts.length`
- [x] **Step 4: ws 消息扩展**：`msg.type === 'approval-response'`（{sessionId, toolUseId, approved}）→ 查 `_pendingApprovals` → 按实证格式（spec §4.2）向 `session.proc.stdin` 注入 control_response → 删除映射 → 广播 `approval-resolved`
- [x] **Step 5: `node --check` + 提交**

---

### Task 7: 前端（inProgress + 审批弹窗 + tooltip）

**Files:**
- Modify: `src/types/index.ts`、`src/stores/chatStore.ts`、`src/hooks/useYFWCLI.ts`、`src/components/permissions/PermissionDialog.tsx`、`src/components/layout/Sidebar.tsx`

- [x] **Step 1**: `ConversationProgress` 加 `inProgress?: number`（2a7979f）
- [x] **Step 2**: chatStore 加 `setMilestoneStart(id, index)`（钳制：`Math.min(index, total)`，无现有 progress 时忽略）；`sendPermissionResponse` 经 ws 通道发 `approval-response`（2a7979f）
- [x] **Step 3**: useYFWCLI 加 `milestone-start` handler（setMilestoneStart）与 `approval` handler（addPermissionRequest，激活死代码）+ `approval-resolved` handler（2a7979f）
- [x] **Step 4**: PermissionDialog 激活：approval 事件入队，Approve/Deny 先 `sendPermissionResponse` 再 `resolvePermission`（2a7979f）
- [x] **Step 5**: Sidebar tooltip：有 total 时 `inProgress` 优先取里程碑名 `i/N`（`执行中 ${name} ${i}/${total}`），无 inProgress → `计划中`；无 total → `执行中`（2a7979f）
- [x] **Step 6**: `npx tsc --noEmit` 无新增错误 + 提交（2a7979f）

---

### Task 8: 构建、端到端验证与 release 同步

- [x] **Step 1**: `npx tsc --noEmit && npx vite build` 通过
- [x] **Step 2**: `node scripts/verify-milestones-start.mjs && node scripts/verify-highrisk.mjs` 全绿
- [ ] **Step 3**: 端到端手工验证（dev 模式）：
  1. 多里程碑任务 → START 后 tooltip 显示当前里程碑名 i/N；全部 done
  2. 简单任务 → 活动条 + 执行中
  3. 高风险命令（如 `git reset --hard` 测试副本 / `rm` 测试文件）→ 弹窗 → 批准执行 / 拒绝 is_error 回传
- [x] **Step 4**: release 副本同步：内核 bundle + `server/milestones.mjs` + `server/highrisk.mjs` + `server/bridge.mjs` + dist（双副本字节级一致 + node --check 语法 + 产物引用 + 内核启动冒烟探针全通过）
- [ ] **Step 5**: 重启 live 实例（**先征得用户同意**，memory: feedback_restart_permission）
- [ ] **Step 6**: 提交（如有同步期改动）

---

## Self-Review（写作时已自查）

- **Spec coverage**：spec §2.1 两态 → Task 1-3（协议）+ Task 7（前端）；§2.2 START → Task 1/3/7；§2.4 内核清理 → Task 4；§2.5 高风险审批 → Task 2/5/6/7；§4 bridge → Task 3/6；§5 前端 → Task 7；§8 影响范围全覆盖；§9 测试 → Task 1/2/5/8
- **Placeholder scan**：除 Task 5 Step 4（实证性未决项，实施时固化）外无 TBD
- **Type consistency**：`starts: [{index,total,name}]`、`inProgress?: number`、`{type:'approval', data:{toolUseId, command}}`、`{type:'approval-response', data:{toolUseId, approved}}` 全文档一致
