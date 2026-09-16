# 实施计划：内核 P0-2 保真审计前置

对应 spec：`docs/superpowers/specs/2026-09-16-fidelity-gate-precheck-design.md`
执行纪律：每步先跑该步验证命令，绿了再进下一步；任何一步红了就地修复，不带病前进。

## S1 — 新增纯函数 `fidelityGate`（模块级，导出）

在 `kernel/compact.mjs` 的 `auditSummaryFidelity` 之后、`FIDELITY_AUDIT_INSTRUCTION` 之前插入：

- 常量 `FIDELITY_GATE_MIN_MISSING = 3`、`FIDELITY_GATE_RATIO = 0.5`（附"为何保守"注释：滥拦=又一次数百秒级摘要调用）。
- `export function fidelityGate({ covered, summary } = {})` → `{ pass, audit }`。
- 注释写明与 `auditSummaryFidelity` 的分工（后者只产出审计，本函数给出**决策判据**）。

**验证 S1**：`node --check kernel/compact.mjs`

## S2 — `landSummary` 改为「前置审计输入」

- 签名加两个可选参数：`audit`（已算好的审计）、`gate`（`{failures, exhausted}`）。
- 把原来的「先写盘 → 再算审计 → 上报」改为：**先确定审计（传入值，缺省则现算）→ 上报 → 再写盘**。
- 删除原先写盘后才计算审计的那段；`auditFidelityAsync`（LLM 审计）保持在落地之后 fire-and-forget（不变）。
- 上报口径不变（仅 `!audit.skipped` 才上报），载荷形状不变。

**验证 S2**：`node --check kernel/compact.mjs` + `node --test kernel-tests/compact-fidelity.test.mjs`（既有用例必须全绿——证明审计口径未变）

## S3 — 单发收敛分支：门禁不通过则不落地、换切点重压

- `if (summaryTokens < coveredTokens) { summary = s; converged = true; break }`
  → 改为：先 `fidelityGate({covered: cut.covered, summary: s})`；
  - `pass` → 原逻辑（赋值 + `converged = true` + `break`），并把审计存入 `gateAudit`；
  - 不通过 → `gateFailures++`、记 `gateAudit`，**不 break**（落入循环底部既有自愈：`retainTokens` 扩大 → `findCutPoint` 取更晚切点），`continue` 语义与"未收敛"一致。
- 新增循环外变量：`gateFailures = 0`、`gateExhausted = false`、`gateAudit = null`。

**验证 S3**：`node --check kernel/compact.mjs` + `node --test kernel-tests/compact-chunked.test.mjs`

## S4 — 末次尝试分支：区分「未收敛」与「收敛但门禁不通过」

- 末次（`attempt === retries - 1`）：
  - **已收敛**（`summaryTokens < coveredTokens`）→ 原样落地（`gateExhausted = true`），**不截断**（截断只会更差）；
  - 未收敛 → 既有截断 60% 逻辑（不变）。

**验证 S4**：`node --check kernel/compact.mjs`

## S5 — 返回值带出门禁信息

- 收敛路径：`return landSummary(summary, cut, coveredTokens, gateAudit, { failures: gateFailures, exhausted: gateExhausted })`
- 分块路径：`landSummary(rolling, cut, coveredTokens, null, { failures: 0, exhausted: false })`（内部现算审计，写盘前）
- 返回值（`action: 'summarized'`）增 `gateFailures` / `gateExhausted` 两个字段（消费方只读已知键，安全）。

**验证 S5**：`node --check kernel/compact.mjs` + `node --test kernel-tests/compact-*.test.mjs`

## S6 — 测试（判据单测 + 机制 e2e + 防御误报）

`kernel-tests/compact-fidelity.test.mjs` 追加：

1. `fidelityGate` 判据：`skipped→pass`、`missing=2→pass`、`ratio<0.5→pass`、`missing=3 ∧ ratio=0.5→fail`（边界）、空输入不抛。
2. **防御误报**：实体充足的普通会话（covered 不含高信号实体 → audit.skipped）→ 门禁 pass、`gateFailures === 0`。
3. **机制 e2e**：covered 含 ≥3 个高信号实体 + mock 摘要（`mock 摘要`，必丢实体）→ 断言三件事同时成立：
   - `gateFailures >= 1`（**门禁真的触发了重压**——防"门禁没接线"假绿）；
   - `session.compactCount() === 1`（**仍然落地**——不变量，防"改坏了落地"）；
   - `gateExhausted === true`（预算耗尽如实降级，不静默）。

**验证 S6**：`node --test kernel-tests/compact-fidelity.test.mjs`

## S7 — 反证演练（证明计数非硬编码、门禁真的在起作用）

临时把 `fidelityGate` 的判据改为恒 `pass` → 用例 3 的 `gateFailures >= 1` 必须**变红**（改为 0）；恢复后回绿。
把两次观察记入报告（改前/改后对照），随后 `git diff` 确认无演练残留。

**验证 S7**：演练期红、恢复后绿 + `grep` 无残留。

## S8 — 全量门禁 + 回归

1. `npm run typecheck`
2. `node --test kernel-tests/*.test.mjs`（**并行全量**；首轮若出现 `engine-perf-log` 一类 `ENOTEMPTY`/`EPERM` 临时目录清理失败，按既有 flake 口径单跑复核后重跑取次轮）
3. `node --test "src/**/*.test.ts"`
4. `node --test server/*.test.mjs`（已知 4 项环境性时序 flake：`pending-replay`/`reap-guard`/`stall-watchdog`，与内核改动无关，用**路径限定 stash 基线对照**确认）

**验证 S8**：各命令 pass/fail 汇总数字。

## S9 — 同步调试版（交付人工调试）

1. `kernel/compact.mjs` → `release/YFWorking/kernel/`，`md5` 核对 + `diff -rq kernel release/YFWorking/kernel`
2. `node --check release/YFWorking/kernel/compact.mjs`
3. 对**调试版副本**跑功能探针：`import` 调试版 `compact.mjs` 的 `fidelityGate`，用「丢 3 实体」样例验证返回 `pass:false`，用「无实体」样例验证 `pass:true`
4. 若 `release` 内 `compact.mjs` 与源码逐字节一致 → 内核测试覆盖直接适用（写明）

**验证 S9**：md5 一致 + 探针输出正确。

## S10 — 更新清单 + 报告

- `P1` 五引擎条目**保持未勾选**（P0-4 待用户决策），把该条的 P0-2 段从"未做"更新为"本轮完成（附证据）"。
- 输出本轮摘要：任务、结果、证据、清单变更、下一轮建议。
