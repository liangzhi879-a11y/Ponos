# 个人经验沉积 + 跨设备分享 设计文档

- 日期：2026-08-15
- 状态：已批准（brainstorming 流程）
- 范围：Ponos 桌面应用（Electron + React + server/bridge.mjs + ponos-kernel 内核）

## 1. 背景与目标

用户诉求："越用越好用""越用越懂业务"——Ponos 应能自动沉积个人使用经验，并在多设备间继承项目与分享经验。

现状盘点（可复用资产）：
- **gxtz 业务经验库**：`~/.ponos/memory/skill_experiences/{技能}.json` 全局汇聚 + 项目级 `.ponos/` 经验库，状态流转 pending→consumed→verified→archived，capture/finalize CLI 可用——面向高企申报业务，技能级。
- **auto memory 系统**：内核内置，项目级目录 `{项目}/.ponos/projects/{hash}/memory/`，MEMORY.md 索引 + user/feedback/project/reference 四类记忆，自动静默写入。
- **技能库**：`~/.ponos/skills/` 实体化归位，内核实时扫描。
- **注入链路**：`server/bridge.mjs` 已在 spawn 内核时使用 `--append-system-prompt-file`（bridge.mjs:751/767），可复用。

缺口：
1. 经验沉积是"业务技能"专属，无**通用个人经验**自动沉积链路。
2. 所有数据在本机 `~/.ponos/`，无跨设备机制。

### 需求决策记录（已与用户确认）

| 决策 | 选择 |
|------|------|
| 经验覆盖范围 | 通用层（偏好/知识/工作流）+ 业务层（gxtz 技能经验）都要，两层打通 |
| 跨设备同步机制 | 手动导入导出（GUI 打包/导入，不做自动云同步） |
| 沉积方式 | 全自动静默（系统从会话自动提取写入，无需打断用户） |
| 导出粒度 | 分类型可选打包（6 类数据源） |
| 架构方案 | 方案 A：文件库中心 + 内核原生注入（零内核改动） |
| 业务场景适配 | 预置通用工作业务主题域：财务、政策、项目申报材料、办公文档等 |

## 2. 架构总览（零内核改动）

```
内核 auto memory 引导 ──自动写入──► ~/.ponos/memory/personal/{主题}.md   [沉积]
bridge spawn 时 ──合并注入──► 现有 prompt 文件（技能清单 + 经验注入段）        [反哺]
GUI 经验面板 ──浏览/管理/导出导入──► 全局经验库 + 分类型 zip 打包              [管理/分享]
```

设计原则：
- **不修改内核代码**（ponos-kernel/claude-code 为发行版）。全部复用现有机制：auto memory 写入约定 + `--append-system-prompt-file` 注入。
- 通用个人经验与业务技能经验（skill_experiences）**并轨不合并**，导出时作为独立类型。
- 注入规模受控（默认上限 4KB），与既有 token 预算优化方向一致。

## 3. 数据层

### 3.1 全局个人经验库

- 根目录：`~/.ponos/memory/personal/`
- 按**主题域**分文件：`{主题}.md`
- 每条经验一个 bullet：`- [会话来源] 经验内容`
- frontmatter：`name` / `description` / `active`（激活状态，默认 true）

预置主题域（首次使用时自动创建，覆盖通用工作业务场景）：

| 主题文件 | 覆盖内容 |
|----------|---------|
| `communication.md` | 沟通偏好：回复风格、语气、汇报粒度 |
| `code-style.md` | 编码偏好：语言、风格、测试习惯、工具用法 |
| `workflow.md` | 工作流心得：处理任务的通用方法、分步试探、验证习惯 |
| `finance.md` | 财务业务经验：报销、账务、财务表格处理、财税政策要点 |
| `policy.md` | 政策业务经验：政策解读、申报条件、时效节点、口径变化 |
| `project-application.md` | 项目申报经验：申报材料组织、系统填报、材料要点（与 gxtz 技能经验衔接） |
| `office-docs.md` | 办公文档经验：Word/PPT/PDF/Excel 处理心得、模板使用 |

主题文件不存在时由内核写文件自动创建；GUI 可新增/重命名主题。

### 3.2 索引

- `~/.ponos/memory/personal/_index.json`：`{ "themes": { "{主题}": { "file": "...", "entry_count": n, "updated_at": "...", "active": true, "inject_bytes": n } } }`
- 索引由 GUI/服务端维护（沉积写入后重扫），内核不负责写索引。

### 3.3 与现有库的关系

| 库 | 位置 | 内容 | 写者 |
|----|------|------|------|
| 个人经验库（新） | `~/.ponos/memory/personal/` | 通用工作业务经验 md | 内核（auto memory 引导） |
| 业务技能经验库（已有） | `~/.ponos/memory/skill_experiences/` | gxtz 等技能经验 json | gxtz-experience-sync 技能 |
| 项目记忆（已有） | `{项目}/.ponos/projects/{hash}/memory/` | 项目级记忆 | 内核 auto memory |

## 4. 自动沉积（全自动静默）

- bridge 维护一段"经验沉淀引导"文本（`EXP_SEDIMENT_PROMPT`），追加进注入 prompt 文件（与技能清单同文件）。
- 引导内容：指示内核在会话中遇到 ①用户明确偏好 ②业务事实（财务/政策/申报口径）③问题-解决模式 ④工作流心得 时，用写文件工具追加到 `~/.ponos/memory/personal/{主题}.md` 对应主题文件；文件不存在则按 frontmatter 模板创建。
- 去重：引导要求写入前读文件，相同描述不重复追加。
- 敏感边界：引导明确禁止写入密钥/密码/API token/身份证号/银行账号等隐私；GUI 导出时另有黑名单过滤兜底。
- 不打断用户：不弹确认框、不要求用户操作。

## 5. 反哺注入

- spawn 内核时（bridge.mjs 现有 prompt 文件组装处，751/767 附近），bridge 读取个人经验库中 `active: true` 的条目 → 生成"经验注入段" → 合并进现有 prompt 文件（追加在技能清单之后）。
- 规模控制：默认上限 **4KB**；超出部分取最近更新的激活条目（按 updated_at 降序截断）。上限可在 GUI 设置调整。
- 用户可在 GUI 停用某主题/某条目 → 不再注入。
- 实现要点：现有代码 `args.push('--append-system-prompt-file', q(promptFile))` 在 resume 与新建会话两个分支各 push 一次，经验注入段需在两个分支的 prompt 内容组装处都合并，保证 resume 会话同样受益。

## 6. GUI 经验面板

- 入口：Settings 页新增"经验"分区（默认；侧边栏新 tab 为备选，仅当 Settings 放不下时采用）。
- 功能：
  - 按主题分组的全局经验列表：搜索、查看详情、删除、激活/停用
  - 统计：各主题条数、当前注入量 KB、注入上限
  - 设置：注入总开关、注入上限（KB）、敏感词黑名单（导出时过滤）
  - 打开经验库目录按钮（复用 `shell:open-path` IPC）

## 7. 导出/导入（分类型可选打包）

### 7.1 数据源映射（6 类型）

| 类型 id | 名称 | 数据源 |
|---------|------|--------|
| `personal` | 个人记忆 | `~/.ponos/memory/personal/` |
| `skill_exp` | 技能经验库 | `~/.ponos/memory/skill_experiences/` |
| `skills` | 技能库 | `~/.ponos/skills/` |
| `config` | 全局配置 | `~/.ponos/config.json` + GUI 设置（localStorage settings key） |
| `chats` | 会话历史 | localStorage 会话数据（chatStore persist key） |
| `project` | 项目数据 | 当前项目 `.ponos/` |

### 7.2 打包格式

- 单文件 zip，顶层 `manifest.json`：
  ```json
  {
    "format_version": 1,
    "app_version": "2.5.0",
    "created_at": "2026-08-15T10:00:00+08:00",
    "origin_device": "PC-WORK",
    "included": ["personal", "skill_exp", "chats"],
    "stats": { "personal": { "files": 5, "entries": 42, "bytes": 8192 }, ... }
  }
  ```
- 目录结构：`manifest.json` + `personal/`、`skill_exp/`、`skills/`、`config/`、`chats/`、`project/`（仅含被勾选类型）。
- 敏感过滤：导出前对 personal/skill_exp 条目按黑名单关键词扫描，命中条目跳过并计入报告（条目级跳过，不整体失败）。

### 7.3 导入

- 选择 zip → 校验 `manifest.json`（存在、format_version 兼容）→ 展示包含类型与统计 → 按类型勾选恢复 → 冲突处理选项 → 结果报告。
- 冲突处理三种模式：
  - `skip`：已存在的目标文件/条目跳过
  - `overwrite`：覆盖目标
  - `merge`：按条目 hash 去重合并（personal 按行内容 hash，skill_exp 按 exp_id，chats 按会话 id，skills/config/project 按文件路径）
- 原子性：解包到临时目录 → 校验 → 校验通过后写入目标；失败不残留半状态。
- 导入后：重扫个人经验索引、通知设置/会话存储刷新。

## 8. 错误处理与测试

### 错误处理

- manifest 缺失 / format_version 不支持 → 拒绝导入，明确报错。
- 导出目录不可写 / 磁盘不足 → 报错并保留临时文件便于排查。
- 经验库文件损坏（md/json 解析失败）→ 面板显示损坏条目并允许删除，不阻塞其他功能。
- 注入段生成失败 → 跳过注入（仅记日志），不影响会话启动。

### 测试

- 单元：打包↔解包往返、manifest 生成/校验、三种冲突模式、敏感过滤、注入段组装与 4KB 截断。
- 端到端：导出 zip → 导入到临时 HOME 目录 → 验证文件与索引恢复；resume 会话注入段存在。
- 回归：现有 skill 清单注入、`--append-system-prompt-file` 行为不受影响。

## 9. 范围与未来扩展

本期不做：
- 自动云同步/多设备实时合并（用户已选手动导出导入）
- 相关性语义筛选注入（本期用"激活 + 最近更新 + 4KB 截断"，不做向量检索）
- 会话历史在线漫游

未来可选：
- 导入冲突的 GUI 差异对比界面
- 注入相关性排序（关键词/向量）
- 定时自动导出提醒

## 10. 涉及文件（实施时）

- `server/` 新增 `experience.mjs`（经验库读写、注入段组装、索引维护）
- `server/bridge.mjs`：引导文本合并、注入段合并、resume 分支
- `server/` 新增 `packager.mjs`（导出/导入、manifest、冲突合并）
- `electron/main.cjs`：新增 IPC（experience:list / experience:set-active / experience:delete / experience:export / experience:import / settings 相关）
- `electron/preload.cjs`：暴露对应 API
- `src/` 新增经验面板组件 + 设置项 + store
- 测试脚本：`server/` 或 `scripts/` 下新增 packager/experience 单元测试
