# 内核 P0-2：保真审计前置（把「后置观测」变成「写入决策的输入」）

- 日期：2026-09-16
- 来源：`docs/2026-09-15-五引擎架构性能对比分析.md` §5 P0-2
- 级别：P1（需 spec → plan → 验证）
- 参考实现：codex `compact.rs` 的「写入前重建校验」

## 1. 问题（已用代码核实）

文档该条描述**准确**：

- `kernel/compact.mjs` 的 `landSummary()` 顺序是：`appendCompactionStart` → `appendCompactionSummary`（**已写盘**）→ 再跑确定性审计 `auditSummaryFidelity()` 并经 `onCompactionAudit` 上报。
- 即审计结论**永远晚于落地**：审计就算发现「关键事实大面积丢失」，那份低保真摘要也**已经在会话里了**，没有任何机制据此换切点重压。
- 代码注释原文更直白：「保真审计（spec §4.1）：**必须在压缩落地之后**」——这是当初的有意设计（避免审计拖慢落地），但也正是本条要改的点。

**代价**：`~/.yfworking` 实测会话转录 2.3G（见清单另一条），长会话高频压缩；一次低保真压缩会**长期污染**后续所有推理（摘要读起来通顺，但前提是错的），这正是失真最难发现的形式。

## 2. 目标与非目标

### 目标
- G1：确定性审计（零模型成本、同步、纯函数）移到**写入决策之前**，其结果成为「是否用这份摘要落地」的输入。
- G2：审计不通过 → **换切点重压**（复用既有的"扩大 retainTokens → 取更晚切点 → 覆盖消息更少 → 摘要负担更轻"自愈路径），而非直接落地。
- G3：**不破坏既有不变量**——① `压缩必须落地`（宁可有损，不无限重试烧时间）；② 重试预算沿用既有 `retries`（默认 3），不新增无界循环；③ LLM 审计（`auditFidelityAsync`）仍为 fire-and-forget，不进 await 链（绝不拖慢轮次时延）；④ `onCompactionAudit` 载荷形状不变（消费方零风险）。
- G4：可观测——门禁触发的重压次数与「预算耗尽降级」必须可从返回值/上报看出，不能静默。

### 非目标（明确不做）
- ❌ LLM 审计（方法 B）前置：它有模型成本与时延，前置进决策链等于把压缩时延绑在又一次模型调用上（与既有「不进 await 链」原则冲突）。
- ❌ 分块路径（chunked）的换切点重压：该路径的摘要由多块**顺序合并**而成，换切点重压＝把全部分块重跑一遍（代价随块数线性增长）。该路径仍**在写入前**过门禁并如实上报，但不重压（边界见 §6）。
- ❌ 改保持比例/压缩触发阈值：属 P4 档位决策，与本条正交。

## 3. 设计

### 3.1 门禁判据（纯函数 `fidelityGate`，导出以便单测）

```
pass  ⇔  audit.skipped  ∨  audit.missing.length < 3  ∨  audit.ratio < 0.5
fail  ⇔  非 skipped ∧ missing ≥ 3 ∧ ratio ≥ 0.5
```

**阈值刻意保守**，理由是成本不对称：

| 判错方向 | 代价 |
|---|---|
| 该拦没拦（漏拦） | 一份低保真摘要落地 —— 与改前**相同**（不劣化现状） |
| 不该拦却拦（滥拦） | **又一次完整摘要调用**（数百秒级 + token 成本），且压缩延时要用户等 |

因此只在「证据确凿的大面积丢失」（≥3 个高信号实体且缺失率 ≥50%）时才付重压代价。`missing ≥ 3` 与 `ratio ≥ 0.5` 是**与**关系：单看比例，3 个实体丢 2 个就有 0.67，样本太小不足为凭。

### 3.2 落点

1. **`fidelityGate({covered, summary})`**（模块级，紧跟 `auditSummaryFidelity`）：返回 `{pass, audit}`，纯计算无副作用。
2. **`landSummary(summary, c, coveredTk, audit, gate)`**：改为接收**已算好的**审计（不再在写盘后自行计算），先把审计上报、再落盘——顺序上审计成为落地的**前置条件输入**。未传审计时（分块路径）内部按同口径补算（仍在写盘之前）。
3. **单发收敛分支**（`if (summaryTokens < coveredTokens)`）：改为**收敛 ∧ 门禁通过**才落地；门禁不通过则**不 break**，落入循环底部既有的"扩大 retainTokens、取更晚切点"自愈路径（`continue` 语义），并计数 `gateFailures++`。
4. **末次尝试分支**：区分两种情形——
   - 未收敛（既有）：截断 60% 落地（不变）；
   - **收敛但门禁不通过**：原样落地 + `gateExhausted = true`（截断只会更差，且"必须落地"是不变量）。
5. **计数与上报**：`gateFailures` / `gateExhausted` 加在**返回值**上（可观测、可测），**不动 `onCompactionAudit` 载荷形状**（`recordCompactionAudit` 虽容忍额外键，但改形状会给 GUI/health 消费面带来无谓风险）。
6. **计数器独立性**：门禁失败**不**`consecutiveFailures++`——该计数器是"落地失败"的熔断信号（返回 `no-convergence` 的判据），门禁失败最终仍会落地，混入会污染熔断语义。用具独立计数器。

## 4. 验证（不可伪造）

| 层 | 验证 |
|---|---|
| 判据单测 | `kernel-tests/compact-fidelity.test.mjs` 增：skipped→pass；missing=2→pass；ratio=0.49→pass；missing=3∧ratio=0.5→**fail**（边界）；**防御误报**（实体充足的普通会话不触发重压） |
| 机制 e2e | 同文件增：构造 covered 含 ≥3 个高信号实体、mock 摘要（`mock 摘要`，必然丢实体）→ 断言 ①**门禁真的触发了重压**（`gateFailures ≥ 1`）②**仍然落地**（`compactCount === 1`，不变量）③`gateExhausted === true`（预算耗尽降级） |
| 不变量回归 | `kernel-tests/compact-chunked.test.mjs`、`compact-count-gate.test.mjs`、`compact-*` 全量 + `npm test` |
| 反证 | 关掉门禁条件 → 上述 ②③ 必变（`gateFailures` 归 0）⇒ 证明计数非硬编码 |

**防假绿纪律**：必须同时断言「门禁触发了重压」**与**「压缩仍然落地」。只断言前者无法发现"改坏了落地"；只断言后者在门禁根本没接线时会假绿。

## 5. 影响面

- `kernel/compact.mjs`（新增纯函数 + 3 处改造：landSummary / 收敛分支 / 末次分支）
- `kernel-tests/compact-fidelity.test.mjs`（增用例）
- **不改** `api.mjs`（mock 摘要文本已足够触发门禁，无需新标记）、**不改** `fidelity.mjs`（`recordCompactionAudit` 载荷不变）、**不改** engine/GUI（返回值多两个字段，消费方只读已知键）

## 6. 已知边界（诚实记录）

- **分块路径不重压**：chunked 摘要由多块合并，换切点重压要重跑全部分块，故只做"写入前审计 + 如实上报"。即该路径上本条的收益是"审计不再晚于落地、且结论可见"，不包含自动重压。
- **门禁只覆盖字面实体丢失**：`auditSummaryFidelity`（方法 A）只发现"字面丢失"，发现不了"被改写"（`MySQL→PostgreSQL` 类）——改写检测在 LLM 审计（方法 B）里，而 B 仍保持 fire-and-forget（见非目标）。故 G1 的"门禁"是**字面保真**门禁。
- **重压可能连续两次都不过门禁**：受 `retries` 约束（默认 3），最终以 `gateExhausted` 落地。不追求"一定达标"，只追求"不静默"。
