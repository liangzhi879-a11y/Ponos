# 子项目：安全与审计（P2）—— production-plan Phase 2 细化

> 所属总纲：docs/production-plan.md §4 Phase 2
> 场景定位：个人重度 + 团队协作（多人共享机器/技能、隐私数据、合规审计）
> 更新日期：2026-08-21

---

## 1. 场景与压力

| 压力 | 量化基线 | 说明 |
|---|---|---|
| 多人共享 | 同机 2~5 用户 / 共享技能库 | 配置与技能互不污染、密钥互不可见 |
| 隐私数据 | 对话含 API key/客户数据/代码 | transcript 落盘含敏感信息 |
| 合规审计 | "执行过什么"可追溯 | 工具调用/文件改动/命令全量审计 |
| 恶意输入 | 提示注入、路径穿越、命令注入 | agent 执行环境暴露面 |

当前架构：权限 = hardcode highrisk.mjs（33 行）+ permissions.mjs（26 行），密钥 = env 全量读取并透传子进程。

## 2. 现状（已有能力映射）

| 能力 | 现状位置 | 覆盖程度 |
|---|---|---|
| 高危命令识别 | kernel/highrisk.mjs（rm/drop/格式化等硬编码） | ⚠️ 规则少、不可配置 |
| 路径边界 | kernel/tools.mjs withinBoundary（cwd + addDirs 白名单） | ⚠️ 无符号链接/穿越检测 |
| 审批流 | engine decideToolPermission + GUI permissions 面板 + autoApprove* 设置 | ✅ 已有，可扩展 |
| 拒绝降级 | engine P1-7 denial 计数降级（连续 3 次/累计 20 次） | ✅ 已有 |
| transcript 审计源 | kernel/session.mjs JSONL（完整 tool_use/tool_result） | ✅ 权威源已有 |
| 密钥脱敏 | 无（日志/transcript 原样） | ❌ 缺失 |
| 规则文件 | 无（settings 无权限规则） | ❌ 缺失 |

## 3. 目标与验收标准

| # | 目标 | 验收标准（可测） |
|---|---|---|
| S1 | 工具调用全量可审计 | 审计导出含：时间/会话/工具/参数摘要/结果摘要/耗时；可搜索 |
| S2 | 密钥零泄漏 | transcript 与日志中 key/token 均脱敏（`sk-***`）；子进程 env 白名单化 |
| S3 | 权限可配置 | settings 支持命令/路径/工具三级 allow/deny/ask 规则，GUI permissions 面板读写 |
| S4 | 路径边界加固 | 符号链接逃逸/路径穿越/大小写混淆均被拦截 |
| S5 | 多人共享隔离 | 用户级配置/密钥与项目级隔离；技能库只读共享或按用户挂载 |

## 4. 任务清单

**P0（合规底线）**
- [ ] S2-1 transcript 脱敏：写 session 时对已知敏感 pattern（sk-、auth token、AK 开头密钥）打码；保留原文仅当 PONOS_KEEP_SECRETS=1
- [ ] S2-2 子进程 env 白名单：spawn Bash/OCR 时仅透传白名单 env（路径/编码/代理），剥离 API key
- [ ] S1-1 审计导出：/audit REST（按会话/时间范围查询），复用 transcript JSONL 做聚合视图

**P1（规模化）**
- [ ] S3-1 权限规则 schema：settings.json `permissions: { allow: [], deny: [], ask: [], rules: [{match, decision}] }`（命令 pattern/路径 glob/工具名三级），merge 进 decideToolPermission
- [ ] S3-2 GUI permissions 面板扩展：规则编辑（allow/deny/ask 增删改），bridge /permissions REST
- [ ] S4-1 路径加固：realpath 检测符号链接（resolve 后 realpath 再 withinBoundary）；拒绝 `..` 逃逸；Windows 大小写归一
- [ ] S5-1 配置隔离：configDir 按用户分层（~/.ponos/user 个人 + ~/.ponos/shared 共享只读）

**P2（增强）**
- [ ] S1-2 审计可视化：GUI 审计视图（时间线 + 过滤 + 导出 CSV）
- [ ] S4-2 危险命令沙箱提示：高危命令执行前展示将影响的路径/命令树（diff 预览）

## 5. 前端集成点

| 前端能力 | 落点 |
|---|---|
| permissions 面板（src/components/permissions/） | S3-2 规则编辑 UI |
| restrictedDirectories 设置 | S4-1 与内核路径边界合并（同一数据源） |
| AppSettings autoApprove* | S3-1 与规则文件 merge（GUI 开关 = 全局默认规则） |
| transcript 搜索（/transcript/search） | S1-1 审计查询入口 |
| settingsStore | permissions 规则数组持久化 |

## 6. 验证方式

- 单元：脱敏正则测试（sk- 等 pattern）；withinBoundary 符号链接/穿越/大小写用例（server/tools-ext.test.mjs 扩展）
- 端到端：配置 allow/deny 规则 → 触发高危命令 → GUI 审批流验证；审计 API 查询时间范围
- 安全测试：提示注入样本集（transcript 注入指令 → 内核不执行）；路径穿越样本集
