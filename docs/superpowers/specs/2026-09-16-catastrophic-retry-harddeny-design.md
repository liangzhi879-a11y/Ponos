# 内核 P0-3：审批不可绕过化（灾难命令拒绝后同族重试硬拒）

- 日期：2026-09-16
- 来源：`docs/2026-09-15-五引擎架构性能对比分析.md` §5「P0 — 把『有实现』变成『有闭环』」第 3 条
- 级别：P1（内核安全底线，需 spec → plan → 验证）
- 参考实现：codex `orchestrator.rs:387-389`「升权重试也硬拒」

## 1. 问题（已用代码核实，非采信文档）

**文档该条描述准确**：

- `kernel/permissions.mjs:48-50` 对灾难命令返回 `{ decision: 'ask', hard: true }`；
- `kernel/engine.mjs:1869` 把 `hard` **豁免**于拒绝降级计数（`!perm.hard && (denialStreak >= 3 || …)`）；
- `kernel/engine.mjs:1910` 对 `hard` 同样豁免计数累加；
- 结论：`hard` 目前只保证「**每次都问**」，**完全没有**「拒绝后重试不再问」的拦截层。用户拒绝 `rm -rf /` 后，模型在同一轮内重发（含改写/升权变体 `rm -rf /*`、`sudo rm -rf /`）会**再次弹窗**——反复弹窗正是「审批疲劳」，用户在第三、四次点击「允许」的概率显著上升，这才是该条要堵的口子。

**为什么这是安全缺陷而不只是体验问题**：`permissions.mjs` 的设计意图是「底线拦截」，但拦截只作用于「判定」，不作用于「同一意图的重复尝试」。底线被「重试」绕过时，底线就不再是底线。

## 2. 目标与非目标

### 目标
- G1：同一轮内，用户已**拒绝**过某灾难族后，模型再发**同族**命令 → **不再弹窗，直接拒绝**（tool_result 明示原因）。
- G2：同族判定要覆盖**改写/升权变体**（`rm -rf /` → `rm -rf /*` / `sudo rm -rf /` / `bash -c "rm -rf /"`），而不只是字面相同的命令。「字面相同」挡不住真实的升级重试。
- G3：不破坏既有不变量——① 硬黑名单在任何档位（含 `bypass`）都必须**首次**可问；② 拒绝不计入降级计数（`hard` 豁免语义不变）；③ 超时不算「用户拒绝」；④ `deny` 规则与 hooks 行为不变。
- G4：所有改动可单测 + 有真进程 e2e 证据。

### 非目标（明确不做，避免范围蔓延）
- ❌ 不做「用户已**放行**过的命令重试免问」：放行缓存会改变安全姿态（灾难命令自动放行），文档未要求。
- ❌ 不做跨轮记忆：文档明确「在同一 turn 内」。跨轮重提属新的用户意图，应当重新询问。
- ❌ 不改默认审批档（文档 P0-4 是独立条目，且属产品决策，需用户拍板）。
- ❌ 不做 P0-2（保真审计前置）：属独立条目，其「审计不通过则换切点重压」会改动压缩收敛循环，风险面不同，单独一轮处理。

## 3. 设计

### 3.1 族的判定复用（单一真相源）

族信息必须与「是否灾难」共用**同一份词表与判定逻辑**，否则两处会漂移（本仓库已有过「漏同步 → 静默不一致」事故）。

`kernel/blacklist.mjs` 重构：把内部 `scanSegment` 的返回值从 `boolean` 改为 **`familyId | null`**，派生两个导出：

- `catastrophicFamily(command) → familyId | null`（新）
- `matchesCatastrophic(command) → boolean` = `catastrophicFamily(command) !== null`（**语义与返回值逐字节不变**，既有调用方零影响）

族 id 复用既有 `CATASTROPHIC_FAMILIES` 五族命名：`root-or-home-recursive-delete` / `mkfs` / `format-partition` / `dd-raw-device` / `power-control`。`diskpart|fdisk|parted` 归 `format-partition`（分区工具）；`init 0|6`、`systemctl reboot` 归 `power-control`。

### 3.2 拦截层落点（engine）

- **状态**：`const deniedCatastrophicFamilies = new Set()`，与 `denialStreak`（`engine.mjs:1843`）同级（engine 作用域，`gateToolUse` 闭包可见）。
- **轮内语义**：`runTurnInternal()` 开头 `clear()` —— 严格对齐文档的「同一 turn 内」。清空点是「轮起点」，不是「工具执行点」。
- **拦截位置**：`gateToolUse` 内 `perm.decision === 'ask'` 分支的**最前面**，先于降级计数检查与 `wire.controlRequest`：
  - 命中 → `return { allowed: false, message: … }`（**不发 control_request、不计 streak**）。放在降级检查之前是有意的：本拦截与降级计数是两套独立机制，若排在后面，连续拒绝 3 次后文案会退化成「用户已连续拒绝 3 次」而掩盖真实原因。
- **记录时机**：仅在 `decision.behavior !== 'allow' && !== 'timeout'`（= 用户明确拒绝）时把族写入集合。超时（用户没看到弹窗）**不记录**——否则用户错过一次弹窗就永久失去放行该命令的能力。

### 3.3 文案

被硬拒时 tool_result 必须让模型**清楚停止**（而不是换个写法再试），并说明这是「用户已拒绝」而非「系统错误」。

## 4. 验证（不可伪造）

| 层 | 验证 |
|---|---|
| 族判定 | `kernel-tests/blacklist.test.mjs` 增：五族各返回预期 family id；非灾难返回 `null`；**一致性不变量**（`matchesCatastrophic(cmd) === (catastrophicFamily(cmd) !== null)` 对全量用例成立）；包装器/改写变体归同族（`rm -rf /` 与 `rm -rf /*` 与 `sudo rm -rf /` 同族） |
| 拦截机制（e2e，真进程不行则真 engine） | 新增 `kernel-tests/catastrophic-retry.test.mjs`：mock 在**同一轮内**连发同族灾难命令 → 断言「模型确实重试了」**且**「只弹了一次窗」；第二次收到硬拒文案；重新开轮后**能再次弹窗**（防「一次拒绝永久封禁」）|
| 不变量回归 | `kernel-tests/permission-gate-mode.test.mjs` 既有 4 档挂起 + 拒绝不计降级计数 + `--disallowedTools` 用例必须全绿 |

**防假绿纪律**：e2e 必须同时断言「重试真的发生了」（否则模型只试一次时，`asks===1` 会假绿）与「只问了一次」。二者同时成立才证明拦截生效。

## 5. 影响面

- `kernel/blacklist.mjs`（重构返回值 + 新导出）
- `kernel/engine.mjs`（新增集合 + 清空点 + 拦截分支 + 记录分支）
- `kernel-tests/blacklist.test.mjs`、新增 `kernel-tests/catastrophic-retry.test.mjs`
- 不改 `permissions.mjs`（`hard` 语义不变）、不改 `protocol.mjs`（载荷不变）、不改 GUI（弹窗数量减少，无需新 UI）

## 6. 已知边界（诚实记录）

- 族粒度拦截意味着：用户拒绝了 `rm -rf /` 后，同轮内**任何**同族命令（如 `rm -rf ~`）都不再询问而是直接拒绝。这是**有意**的（同族即同一毁灭意图，且属升权重试的常见形态）；代价是「同轮内想再批准另一条同族命令」做不到——需下一轮再说。
- 仅覆盖 `blacklist.mjs` 的五族灾难命令；普通高危（`highrisk.mjs`）**不**适用（文档明确只针对 `hard:true`）。普通高危仍按原「每次可问」语义。
