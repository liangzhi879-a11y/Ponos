# 子项目：平台化（P4）—— production-plan Phase 4 细化

> 所属总纲：docs/production-plan.md §4 Phase 4
> 场景定位：个人重度 + 团队协作（多模型切换、技能共享、自动化 hooks、分层配置）
> 更新日期：2026-08-21

---

## 1. 场景与压力

| 压力 | 量化基线 | 说明 |
|---|---|---|
| 多模型 | 2~10 个 provider（含视觉桥接） | 按任务切换模型/成本分层 |
| 模型热切换 | 会话暂停时秒级切换（连带 baseUrl/url） | 切换不重启进程、不丢会话上下文（现状：换 provider 必须 kill 会话进程重启） |
| 技能共享 | 团队共用 20+ 技能（gxtz-*/yfwx-* 系列） | 技能注册/启用/更新/版本一致 |
| 自动化 | hooks 触发运维动作 | 工具调用前后/提示提交时执行脚本 |
| 配置分层 | 用户级/项目级/团队级 | 三级合并、覆盖与继承 |

关键现状：**前端已实现多 provider、MCP、skills、permissions 的管理 UI 与 bridge REST**——本子项目的重心是"内核化对齐"（把前端已有能力落到内核配置/执行层），而非从零新建。

## 2. 现状（已有能力映射）

| 能力 | 现状位置 | 覆盖程度 |
|---|---|---|
| 多 provider | bridge /config + /providers（PonosConfigV2/ModelProvider：apiBaseUrl/models/primaryModel/subagentModel/effortLevel/contextWindow/authToken/visionModel） | ✅ 前端/桥接已有 |
| 视觉桥接 | AppSettings autoImageBridge + visionProviderId | ✅ 已有 |
| MCP | src/components/mcp + server mcp 相关 | ✅ 已有 |
| 技能系统 | skills-lock.json + src/lib/skills.ts + skills 面板 + skillRoot/autoCapture | ✅ 已有 |
| hooks | 无 | ❌ 缺失（依赖 update-config 技能，内核未支持） |
| 分层 settings | 无（内核只读 env/CLI） | ❌ 缺失 |
| 多 provider 内核化 | kernel/api.mjs 每次请求读 process.env（ANTHROPIC_*） | ❌ 内核未接前端 provider 配置；env 是 spawn 快照，运行中不可变 |
| provider 激活 | bridge buildChildEnv 注入 env + /verify-provider spawn 一次性进程探测 | ⚠️ 可用但笨重：切换=重启会话进程，探测靠临时 CLI |

## 3. 目标与验收标准

| # | 目标 | 验收标准（可测） |
|---|---|---|
| P4-1 | 内核读取前端 provider 配置 | 内核从 bridge 配置（或生成的 env/settings）解析模型/端点/密钥，替代硬编码 ANTHROPIC_* 读取 |
| P4-2 | hooks 生命周期可执行 | PreToolUse/PostToolUse/UserPromptSubmit/SessionStart 四钩子，JSON 配置化，脚本可跑通 |
| P4-3 | 分层 settings 合并 | user/project/local 三级 merge（深合并），内核行为随配置生效 |
| P4-4 | 技能挂载闭环 | skills-lock 注册 → 内核可发现 → prompt 注入 → 版本一致校验 |
| P4-5 | 内核原生 provider 热切换 | 会话暂停时下发 switch_provider（baseUrl+token+model 一并切换），下一轮走新配置；进程不重启、transcript 连续、busy 轮拒绝 |

## 4. 任务清单

**P0（内核化对齐 + 热切换）**
- [ ] P4-1-1 配置传递链：bridge /config → spawn 内核时生成 `PONOS_PROVIDER_<id>_BASE_URL/MODEL/AUTH_TOKEN` env 或 settings 文件 → kernel/api.mjs 解析（保留 ANTHROPIC_* 回退兼容）
- [ ] P4-1-2 视觉模型透传：visionModel → Vision 工具/图片桥接走独立 provider（内核侧透传配置即可，执行在 GUI 侧已有）
- [ ] P4-5-1 provider 注册表：kernel/provider.mjs——`getProvider()/setProvider(patch)` 原子替换 + 校验（baseUrl 格式/token 非空/模型名）+ 版本号递增；初始状态来自 env（ANTHROPIC_*/PONOS_PROVIDER_*），env 仅为默认值
- [ ] P4-5-2 switch_provider wire 协议：control_request 新 subtype，payload `{ providerId?, baseUrl, authToken, model, contextWindow }`；**仅 `!turnActive`（会话暂停）接受**，busy → 拒绝回执；成功 → `system(provider_switched, { providerId, model, version })` + transcript 追加 meta 事件（审计）；api.mjs 请求从 registry 取配置（不再每次读 process.env）
- [ ] P4-5-3 bridge 免重启切换链路：/providers 保存后若该 provider 有活跃内核会话 → 发 switch_provider control_request（不 kill 进程）；内核无此 subtype（旧版本）→ 回退现状重启流程

**P1（平台能力）**
- [ ] P4-3-1 settings schema：`~/.ponos/settings.json`（user）+ 项目 `.ponos/settings.json`（project）+ 会话内覆盖（local），深合并（对照 claude settings.ts 优先级）
- [ ] P4-2-1 hooks 执行器：kernel/hooks.mjs——事件 → 规则匹配（tool/pattern）→ spawn 脚本（超时/退出码/输出回填 tool_result）；`permissions` 部分并入 security.md S3-1
- [ ] P4-4-1 skills 发现内核化：内核读 skills-lock.json → 工具描述/系统提示注入（当前靠 append 文件，改为结构化加载）；与前端 skills 面板同一数据源

**P2（增强）**
- [ ] P4-2-2 hooks GUI：settings 面板 hooks 编辑 + 事件日志视图
- [ ] P4-4-2 技能版本校验：skills-lock 与磁盘技能 hash 校验，不一致提示更新

## 5. 前端集成点

| 前端能力 | 落点 |
|---|---|
| /config + /providers REST | P4-1 配置传递链上游；P4-5-3 保存后热切换入口 |
| settings 面板 / SettingsView | P4-3 分层 settings 编辑（user/project 切换）；P4-5 切换模型即时生效（无重启提示） |
| MCP 面板 | 与 hooks 并列的自动化配置入口 |
| skills 面板 + skills-lock.json | P4-4 挂载闭环的 UI 侧 |
| settingsStore AppSettings | 与内核 settings 字段映射（同一键名） |

## 6. 验证方式

- 单元：settings 深合并优先级测试；hooks 事件 → 脚本执行 → 输出回填测试（mock）；provider 注册表 setProvider 校验/版本递增测试
- 端到端：配置 2 个 provider → 会话暂停 → switch_provider → 下一轮请求走新 baseUrl（mock 双端点断言）；busy 轮次中 switch_provider → 拒绝回执；hooks 脚本在 PreToolUse 触发
- 评测：T003 以 provider 配置方式运行（验证配置传递不破坏内核行为）
