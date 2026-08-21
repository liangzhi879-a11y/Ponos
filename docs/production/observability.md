# 子项目：可观测与运维（P3）—— production-plan Phase 3 细化

> 所属总纲：docs/production-plan.md §4 Phase 3
> 场景定位：个人重度 + 团队协作（长会话退化定位、成本失控预警、故障诊断）
> 更新日期：2026-08-21

---

## 1. 场景与压力

| 压力 | 量化基线 | 说明 |
|---|---|---|
| 长会话退化 | 单会话 500 轮后响应质量/延迟变化 | 需定位 compact 时机是否失准 |
| 成本失控 | 月 token 消耗、缓存命中率变化 | 需用量/成本趋势 |
| 故障定位 | 会话卡住/失败原因 | 需链路日志 + 指标 |
| 多会话健康 | 20 并发会话的负载 | 需全局视图 |

当前架构：benchmark 有 usage/成本统计（评测侧），产品侧只有 health.mjs（112 行）+ /health + /diag/info + /test-provider。

## 2. 现状（已有能力映射）

| 能力 | 现状位置 | 覆盖程度 |
|---|---|---|
| 用量统计 | benchmark/harness/yfw.mjs usage（含 cache_read 已修）+ lib/llm-api.mjs costOf | ⚠️ 评测侧有，产品侧无 |
| 健康检查 | kernel/health.mjs（112 行）+ bridge /health | ⚠️ 基础版（进程存活） |
| 诊断 | bridge /diag/info + /test-provider + GUI diagnostic/doctor 面板 | ✅ 已有可扩展 |
| 会话统计 | /transcript/stats（transcript.mjs） | ✅ 已有 |
| 指标采集 | 无（无结构化指标存储/趋势） | ❌ 缺失 |
| 错误追踪 | 无（错误仅在日志） | ❌ 缺失 |

## 3. 目标与验收标准

| # | 目标 | 验收标准（可测） |
|---|---|---|
| O1 | 每会话用量可查 | 每轮 token（含 cache）/延迟/工具分布/成本 → 结构化 JSON 落盘，可查询 |
| O2 | 健康接口完备 | /health 返回：内存/会话数/API 连通/队列深度/磁盘水位；GUI 展示 |
| O3 | 故障可诊断 | /diag 全量：env 脱敏/工具清单/配置/技能/skills-lock/版本；一键导出 |
| O4 | 成本可预警 | 月度用量/成本趋势 + 缓存命中率指标；超阈值提示 |

## 4. 任务清单

**P0（基线）**
- [ ] O1-1 内核用量回传：engine finalizeUsage 已有 → 每次 result 事件透传完整 usage（含 cache_read/creation）→ session 落盘
- [ ] O2-1 health.mjs 扩展：内存（process.memoryUsage）/会话数（bridge 统计）/API 连通（最近一次调用结果）/队列深度（pending turns）
- [ ] O3-1 /diag/info 补全：配置项（脱敏）、skills-lock 版本、transcript 目录大小

**P1（规模化）**
- [ ] O1-2 会话用量视图：/transcript/stats 扩展按会话聚合 token/成本/工具分布；GUI 会话侧栏展示
- [ ] O4-1 成本统计：复用 costOf（含 cache 计费已实现），按会话/天聚合；设置月度预算阈值 → GUI 提示
- [ ] O2-2 GUI 健康面板增强（healthUi.ts）：会话列表 + 每会话活跃/用量/错误数

**P2（增强）**
- [ ] O4-2 缓存命中率指标：cache_read/(input+cache_read) 趋势——指导 prompt cache 策略调优
- [ ] O3-2 故障一键导出：/diag/export → 打包 env(脱敏)+日志+transcript 摘要，供支持排查

## 5. 前端集成点

| 前端能力 | 落点 |
|---|---|
| healthUi.ts / HealthMeter | O2-2 会话健康视图 |
| diagnostic / doctor 面板 | O3-1/O3-2 诊断与导出 |
| history 面板 + /transcript/* | O1-2 会话用量侧栏 |
| settingsStore | 月度预算阈值、缓存策略开关 |

## 6. 验证方式

- 单元：usage 字段完整性（含 cache 四类）；costOf 计费断言（已实现）
- 端到端：mock 会话后查询 /transcript/stats 聚合正确；/diag 导出不含密钥
- 评测联动：benchmark 成本统计与产品侧口径对齐（同一 costOf）
