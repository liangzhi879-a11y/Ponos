# 子项目：部署与分发（P6）—— production-plan Phase 6 细化

> 所属总纲：docs/production-plan.md §4 Phase 6
> 场景定位：个人重度 + 团队协作（多机升级、版本漂移、配置文档化、安装包分发）
> 更新日期：2026-08-21

---

## 1. 场景与压力

| 压力 | 量化基线 | 说明 |
|---|---|---|
| 升级频率 | 月均 2~5 次发布 | 用户手动拉取 + 自动更新；升级不得破坏已有会话/配置 |
| 版本漂移 | 团队 2~10 台机器 | 同一技能/配置在不同机器行为不一致 → 排查成本高 |
| 配置复杂度 | 50+ 可配置项 | env/CLI/settings 三入口，缺文档则不可用 |
| 旧数据兼容 | 累计 1000+ 会话 transcript | 升级后旧 transcript 必须可恢复/可读，格式变化需迁移 |

当前架构：electron-builder 打包（yfw-packaging 技能，electron/ 侧）；内核零依赖、随用随启；配置散落在 env/CLI/前端 settingsStore，无 schema/版本化；transcript JSONL 无版本标记。

## 2. 现状（已有能力映射）

| 能力 | 现状位置 | 覆盖程度 |
|---|---|---|
| 打包分发 | electron-builder + yfw-packaging 技能（NSIS 安装包/跨设备） | ✅ 已有（GUI 侧） |
| 内核独立部署 | kernel/ 零 npm 依赖，可独立 node 运行 | ✅ 已有 |
| 配置文档 | docs/manual 产品说明书（持续维护中） | ⚠️ 有但未覆盖内核 env/CLI 全量 |
| 配置 schema 版本化 | 无（settingsStore 前端默认值散落） | ❌ 缺失 |
| transcript 兼容标记 | session.mjs JSONL 无版本字段 | ❌ 缺失 |
| 升级迁移脚本 | 无（配置/transcript 变更靠手动） | ❌ 缺失 |
| 版本一致性校验 | 无（无单文件版本号可查） | ❌ 缺失 |

## 3. 目标与验收标准

| # | 目标 | 验收标准（可测） |
|---|---|---|
| D1 | 配置全量可查 | 所有 env/CLI/settings 项有单一文档来源（docs/manual 或生成式 reference），每项含默认值/示例 |
| D2 | 升级不破坏数据 | 旧版本 settings/transcript 在新版本可读：schema 版本化 + 迁移路径，迁移失败有明确报错 |
| D3 | 内核可独立部署 | 内核 + 配置示例 = 可直接运行的最小包（无 GUI 依赖），README 一步启动 |
| D4 | 版本可审计 | 内核/bridge/GUI 暴露统一版本号（/diag 含 kernelVersion + schemaVersion + buildId），可交叉比对 |

## 4. 任务清单

**P0（上线底线）**
- [ ] D1-1 内核配置清单：盘点 kernel/ 全部 env（ANTHROPIC_*、CLAUDE_CODE_*、YFW_* 等）+ CLI flag → docs/manual 生成式 reference（每项：名称/默认值/示例/影响面）
- [ ] D3-1 独立部署包：`kernel/ + package.json + .env.example` 最小发布形态，`npm start` 或 `node cli.mjs` 一步跑通；文档化与 GUI 集成两用方式

**P1（规模化）**
- [ ] D2-1 schema 版本化：settings 文件头写 `schemaVersion`（对照 claude settings schema），读取时校验：高于当前 → 拒绝并提示升级；低于当前 → 迁移函数链（v1→v2→…）
- [ ] D2-2 transcript 版本标记：session.mjs 写 `{"type":"meta","schemaVersion":N}` 首行；读取时旧格式自动适配（无版本字段视为 v1）
- [ ] D4-1 版本号统一：kernel package.json + bridge /diag/info 返回 kernelVersion/schemaVersion/buildId；构建时注入 buildId

**P2（增强）**
- [ ] D2-3 迁移演练：构造 v1 settings/transcript 样本 → 升级后自动迁移 → 断言内容等价（测试夹具）
- [ ] D1-2 配置漂移检测：/diag 对比运行配置 vs schema 默认值，标注非默认项（`changedFromDefault`），帮助排查"为什么这台机器行为不同"

## 5. 前端集成点

| 前端能力 | 落点 |
|---|---|
| settingsStore / SettingsView | D2-1 schema 版本与前端默认值对齐（同一版本号） |
| 升级流程（electron 自动更新/手动安装包） | D2-2 升级前 transcript 兼容预检 |
| diagnostic 面板 | D4-1 版本号展示 + D1-2 配置漂移标注 |
| docs/manual 产品说明书 | D1-1 配置 reference 宿主 |

## 6. 验证方式

- 单元：schema 迁移函数链测试（v1→v2 字段映射）；transcript 无版本字段读取兼容测试
- 端到端：构建独立部署包 → 干净机器（无 GUI）运行内核完成一轮对话；升级旧 settings → /diag 确认迁移
- 回归：全量测试 + T001-T006 确认版本化改动不影响内核行为
