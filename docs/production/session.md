# 子项目：长会话与记忆（P5）—— production-plan Phase 5 细化

> 所属总纲：docs/production-plan.md §4 Phase 5
> 场景定位：个人重度 + 团队协作（500+ 轮长会话、跨会话上下文、上下文退化）
> 更新日期：2026-08-21

---

## 1. 场景与压力

| 压力 | 量化基线 | 说明 |
|---|---|---|
| 长会话轮次 | 单会话 200~500+ 轮 | 工具往返多、上下文持续累积 |
| 上下文体积 | 单会话积累 >100K token | compact 时机与质量决定成败 |
| 跨会话任务 | 多天连续工作 | 记忆跨会话可检索 |
| 团队知识 | 共享项目规范/经验 | AGENTS.md + 经验沉淀 |

当前架构：compact.mjs（275 行）按预算裁剪 + context.mjs（127 行）；记忆在 GUI/个人层（~/.yfworking/memory），内核未集成。

## 2. 现状（已有能力映射）

| 能力 | 现状位置 | 覆盖程度 |
|---|---|---|
| 上下文压缩 | kernel/compact.mjs（275 行）+ CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES 工具结果落盘 | ✅ 基础版 |
| 上下文健康 | kernel/context.mjs（127 行）+ GUI HealthMeter | ✅ 已有雏形 |
| 会话恢复 | session.mjs JSONL + --resume | ✅ 已有 |
| 记忆 | ~/.yfworking/memory（GUI 层沉淀） | ⚠️ 内核未集成 |
| 工具结果重放 | persistToolResult（落盘 + <persisted-output> 预览 + Read 补读） | ✅ 已有 |
| compact 预算配置 | 无（硬编码/单 env） | ❌ 缺失 |

## 3. 目标与验收标准

| # | 目标 | 验收标准（可测） |
|---|---|---|
| L1 | compact 质量不退化 | 500 轮长会话：compact 后关键信息（当前任务/todo/文件状态/决策）保留率 ≥90%（抽样检查） |
| L2 | token 预算可配置 | 按 provider contextWindow 自动设 compact 阈值；手动覆盖 |
| L3 | 记忆内核化 | 关键经验（偏好/业务事实）自动沉淀 → 跨会话注入系统提示，可检索 |
| L4 | 上下文健康可预测 | 预估剩余容量（token 增长速率）→ 提前 N 轮预警压缩 |

## 4. 任务清单

**P0（长会话基线）**
- [ ] L1-1 compact 关键信息保留：compact 时保留 todo 清单/最近决策/未完成任务/文件变更清单（对照 dsh compaction-basic 的 keyInfo 保留）
- [ ] L2-1 预算配置化：`settings.compact: { thresholdTokens, reserveTokens, maxToolResults }`（对照 pi CompactionSettings）；默认按 provider contextWindow × 0.8

**P1（规模化）**
- [ ] L3-1 经验捕获内核化：内核侧关键事件（任务完成/用户纠错/业务事实）→ 结构化记忆条目 → ~/.yfworking/memory 落盘（对照 claude autoMemory / YFW 经验沉淀机制）
- [ ] L3-2 记忆注入：会话启动注入相关记忆（按任务标签检索），系统提示附"记忆来源"标注
- [ ] L4-1 上下文预测：token 增长速率 = 最近 K 轮平均 → 预测达到阈值轮数 → HealthMeter 预警（context.mjs 扩展）

**P2（增强）**
- [ ] L1-2 compact 回测：用真实长会话 transcript 回放 compact，比较压缩前后问答质量（评测扩展）
- [ ] L3-3 记忆管理 UI：记忆浏览/删除/置顶（GUI 记忆面板）

## 5. 前端集成点

| 前端能力 | 落点 |
|---|---|
| HealthMeter（src/components/chat/HealthMeter.tsx） | L4-1 预警展示 |
| compact 设置（settingsStore） | L2-1 配置入口 |
| 经验面板（experience.mjs / src 经验相关） | L3-2/L3-3 记忆浏览 |
| transcript（历史回放） | L1-2 compact 回测数据源 |

## 6. 验证方式

- 单元：compact 保留率抽样断言（构造含关键信息的 100 轮上下文 → compact → 检查保留）
- 端到端：mock 长会话（500 轮）跑通 + HealthMeter 预警触发
- 评测：SWE 系列任务回放 compact 前后对比正确性
