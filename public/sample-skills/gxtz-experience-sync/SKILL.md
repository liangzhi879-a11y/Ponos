---
name: "gxtz-experience-sync"
description: "经验积累与同步技能。Work模式：agent在技能执行中即时捕获经验（capture/fallback直接写入）或收工时汇总经验（finalize）。Code模式：agent读取全局经验库（待消费清单/已验证清单），用于技能迭代升级；支持归档已消费经验并移除。v1.4.0适配C盘统一架构：project_context_manager.py从C盘调用，新增版本检查。当用户提到经验积累、经验同步、提交经验、查看经验、capture、finalize、经验流转、归档经验、清理经验时调用此技能。"
version: "1.4.0"
---

<!-- SECTION_BEGIN: ocr_mandatory -->
## OCR强制规范 → 详见 {{PONOS_SKILLS}}/_common/SHARED_ocr_mandatory.md
> ⚠️ 核心铁律：先OCR后操作，禁止猜测，必须等待，结果空则报错。
> 速查：`python ocr_engine.py detect --file <path>` → `python ocr_engine.py ocr --file <path> --project <project>`
<!-- SECTION_END: ocr_mandatory -->

# 经验积累与同步

## 角色定位

本技能封装三层经验库的读写操作。**不新建基础设施**，底层复用 `project_context_manager.py` 的 capture / finalize CLI 和已有的全局技能经验库文件。

## v1.4.0 C盘统一架构适配

> **v1.4.0 架构变更**：`project_context_manager.py` 不再位于项目目录，而是统一存储在 C盘 `{{PONOS_SKILLS}}/_common/`。
> 所有 CLI 命令使用 C盘绝对路径调用，`--project-root` 参数必须显式指定项目路径。

### 版本检查（技能启动时）

在执行任何 capture/finalize 操作前，应先检查技能版本是否为最新：

```bash
python C:/Users/T203-15/.trae-cn/skills/enterprise_project_skills/sync_version.py --notify
```

- 退出码 0：版本最新，继续执行
- 退出码 1：有新版本，建议先 pull 更新
- 退出码 2：网络不可用，使用本地缓存版本继续

如需同步到最新：
```bash
python C:/Users/T203-15/.trae-cn/skills/enterprise_project_skills/sync_version.py --sync
```

### 关键路径速查

| 资源 | 路径 |
|------|------|
| `project_context_manager.py` | `{{PONOS_SKILLS}}/_common/project_context_manager.py` |
| 全局技能经验库 | `C:/Users/T203-15/.trae-cn/memory/skill_experiences/{skill_name}.json` |
| 项目经验库 | `{project_root}/.claude/project_knowledge/experience_base.json` |
| 项目留痕 | `{project_root}/.claude/working_trace.md` |

## 三层架构速查

```
Work agent (项目工作)                          Code agent (技能开发)
       │                                               │
       │ capture / finalize                             │ 读取文件
       ▼                                               ▼
┌──────────────────┐    _sync_to_global    ┌──────────────────────────────┐
│ .claude/           │ ──────────────────►  │ ~/.trae-cn/memory/           │
│ experience_base  │                      │ skill_experiences/           │
│ .json            │                      │ {skill_name}.json            │
│ (项目级)          │                      │ (全局，跨项目汇聚)             │
└──────────────────┘                      └──────────────────────────────┘
                                                     │
                                                     │ Code升级时沉淀
                                                     ▼
                                          ┌──────────────────────────────┐
                                          │ {skill}/experience.json       │
                                          │ (技能包内，执行时参考)          │
                                          └──────────────────────────────┘
```

---

# Work 端：提交经验

## 核心原则

1. **即时优先**：技能执行中遇到问题/发现规律/手动修复，立即调用 capture，不等技能跑完
2. **收工必做**：技能跑完或接到收工/trace指令，必须调用 finalize
3. **字段必填**：capture 的 problem_type / problem_desc / solution 三个字段必填
4. **禁止只口头记录**：经验不能只说"我记下来了"，必须调用 capture CLI 写入文件
5. **全局同步不可跳过**：项目级写入完成后，**必须立即**同步到全局技能经验库，不等收工、不延迟。写入后**必须回读验证**（`json.load` 确认新 exp_id 存在）

### 第零步完：确认进度依赖（v1.4.0新增，进度管理集成）

在开始工作前，检查本技能的前置阶段是否已完成：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_sync.py check-deps ^
    --project-root "." ^
    --skill "gxtz-experience-sync"
```

若返回 WARNING 提示存在未完成的前置阶段，agent 应提示用户先完成前置依赖。

> 进度管理集成说明详见: `{{PONOS_SKILLS}}/gxtz-progress-manager/SKILL.md`


## 路径一：即时捕获 (capture)

**触发时机** -- 技能执行中任何时候遇到以下情况：

- 校验发现问题但未跑完整个技能
- 手动修复了某个问题
- 发现格式要求或最佳实践
- 遇到异常并找到了解决方案
- RD-IP-PS关联缺失、序号断裂等数据问题

**CLI 命令**（在项目根目录运行）：

```bash
python {{PONOS_SKILLS}}/_common/project_context_manager.py capture \
  --project-root "{项目绝对路径}" \
  --skill "{技能名}" \
  --enterprise "{企业名称}" \
  --problem-type "{经验类型}" \
  --problem-desc "{问题描述}" \
  --solution "{解决方案}" \
  --prevention "{预防建议}" \
  --cross-validated "{交叉验证状态}"
```

### 参数说明

| 参数 | 必填 | 示例值 | 说明 |
|------|------|--------|------|
| `--project-root` | 是 | `C:\Users\T203-15\Desktop\2023guogao` | 项目根目录绝对路径 |
| `--skill` | 是 | `gxtz-core-tables` | 当前使用的技能名 |
| `--enterprise` | 是 | `深圳市中瑞电子有限公司` | 企业名称 |
| `--problem-type` | 是 | 见下表 | 经验类型，6选1 |
| `--problem-desc` | 是 | `RD04未关联任何IP` | 问题描述 |
| `--solution` | 是 | `从RDPS表补充RD04→IP05的关联` | 解决方案 |
| `--prevention` | 否 | `生成RD表后校验每RD至少关联1个IP` | 预防建议 |
| `--cross-validated` | 否 | `consensus` | consensus/disputed/single_source |

### 经验类型 (--problem-type)

| 值 | 分类 | 典型场景 |
|----|------|---------|
| `common_issue` | 常见问题 | RD-IP关联缺失、序号断裂、合同发票不匹配 |
| `validation_rule` | 校验规则 | 发票唯一匹配、近三年每年有转化、高新收入≥60% |
| `format_requirement` | 格式要求 | 字段名严格对照、模板列序一致、标黄规范 |
| `review_checkpoint` | 审核检查点 | 跨表一致性校验、A107041锚点、审批文本完整 |
| `best_practice` | 最佳实践 | 对比先行工作流、分步试探、先改1份验证 |
| `upgrade_trigger` | 触发升级 | 政策变化、模板更新、新项目类型 |

### capture 示例

```bash
# 示例1：发现校验问题
python {{PONOS_SKILLS}}/_common/project_context_manager.py capture \
  --project-root "C:\Users\T203-15\Desktop\2023guogao" \
  --skill "gxtz-achievement-materials" \
  --enterprise "深圳市中瑞电子有限公司" \
  --problem-type "validation_rule" \
  --problem-desc "第3项成果转化的发票同时归属了第5项成果，违反发票唯一匹配规则" \
  --solution "将发票归属调整为第5项成果，第3项成果补充新的对应发票" \
  --prevention "整理合同发票时，每张发票标注唯一归属成果编号，生成后交叉校验"

# 示例2：发现格式规律
python {{PONOS_SKILLS}}/_common/project_context_manager.py capture \
  --project-root "C:\Users\T203-15\Desktop\2023guogao" \
  --skill "gxtz-rd-report" \
  --enterprise "深圳市中瑞电子有限公司" \
  --problem-type "format_requirement" \
  --problem-desc "立项书审批表需从独立表合并到主表末尾（4表→3表结构）" \
  --solution "通过XML patch方式将审批行移动到主表最后一个w:tbl节点" \
  --prevention "生成立项书时按3表结构生成，不创建第4张审批表"
```

### capture 工作流程

```
agent调用capture → 写入experience_base.json
                → 追加working_trace.md
                → **必须**同步到全局技能经验库（不可跳过）
                → **必须**回读全局文件验证（json.load确认新exp_id存在）
                → 打印 exp_id 确认
```

⚠️ 全局同步+回读验证是 **强制步骤**，不是可选的。即使 CLI 模式中 `_sync_to_global()` 是内置的，也必须手动检查全局文件是否实际写入了新经验。

---

## 路径二：收工汇总 (finalize)

**触发时机**：技能跑完、或收到"收工"/trace指令

**CLI 命令**：

```bash
python {{PONOS_SKILLS}}/_common/project_context_manager.py finalize \
  --enterprise "{企业名称}" \
  --year {申报年份} \
  --skill "{技能名}" --no-move
```

### finalize 工作流程

```
1. 收集经验（pending_experiences.json + _校验报告/ 自动提取）
2. 写入项目级 experience_base.json（6分类 + 索引）
3. 追加 working_trace.md（标准化会话留痕）
4. 汇聚到全局技能经验库
5. **回读验证**：读取全局文件确认新经验已写入
6. 文件扫描与整理（5级有效性筛选）
7. 更新 file_map.json / project_index.json
8. 生成 _file_management_report.md
9. 产出校验（3个json存在性检查 + 全局同步验证）
```

---

## 路径三：手动汇聚 (/sync_experience)

**触发时机**：需要将项目经验跨技能批量同步到全局经验库

**CLI 命令**：

需读取 `.claude/project_knowledge/experience_base.json`，遍历 `skill_experience_index`，按 `skill_name` 分组后调用 `_sync_to_global_skill_experiences()` 逐技能同步。

**agent 操作指南**：
1. 读取 `.claude/project_knowledge/experience_base.json`
2. 遍历 `skill_experience_index` 中的每个 skill_name
3. 对每个技能，提取其关联的 exp_id 列表中的经验
4. 写入 `~/.trae-cn/memory/skill_experiences/{skill_name}.json`
5. status=pending 的经验标记为"待技能升级消费"

---

## Fallback 模式：CLI 不可用时的直接写入

当 `project_context_manager.py` 不在当前项目目录、或 agent 工作目录不在项目根目录时，退化为直接读写 JSON 文件。

### 适用场景

- agent 在 D 盘项目工作，CLI 在 C 盘 `2023guogao` 中
- 项目目录中确实没有 `project_context_manager.py`
- CLI 调用报错（Python环境/路径问题）

### Fallback 写入经验（等价于 capture）

**Step 1** — 读取项目级经验库：

```
文件路径: {project_root}/.claude/project_knowledge/experience_base.json
如文件不存在，按下方经验格式创建新文件
```

**Step 2** — 生成 exp_id：

```
格式: EXP-YYYY-MM-DD-NNN
NNN 从当前最大编号+1（如已有 EXP-2026-07-17-001，则生成 EXP-2026-07-18-001）
```

**Step 3** — 新增经验记录到对应分类数组：

```json
{
  "exp_id": "EXP-2026-07-18-001",
  "source_project": "{企业名称}",
  "source_session": "{当前会话描述}",
  "skill_name": "{技能名}",
  "problem_type": "common_issue",
  "problem_desc": "{问题描述}",
  "solution": "{解决方案}",
  "prevention": "{预防建议}",
  "status": "pending",
  "created_at": "2026-07-18",
  "triggered_version": "{触发时的技能版本}"
}
```

按 problem_type 写入对应分类：
- `common_issue` → `common_issues[]`
- `validation_rule` → `validation_rules[]`
- `format_requirement` → `format_requirements[]`
- `review_checkpoint` → `review_checkpoints[]`
- `best_practice` → `best_practices[]`
- `upgrade_trigger` → `skill_upgrade_triggers[]`

**Step 4** — 更新 `skill_experience_index`:

```json
"skill_experience_index": {
  "gxtz-core-tables": ["EXP-2026-07-13-001", "EXP-2026-07-18-001"]
}
```

**Step 5** — **【强制】同步到全局技能经验库**：

> ⚠️ 此步骤不再是可选的，**任何情况下都必须执行**。不可延迟到收工、不可因"CLI模式内置同步"而跳过。

```json
// 文件: ~/.trae-cn/memory/skill_experiences/{skill_name}.json
// 追加到 experiences[] 数组
{
  "exp_id": "EXP-2026-07-18-001",
  "source_project": "{企业名称}",
  "source_session": "{当前会话描述}",
  "skill_name": "{技能名}",
  "problem_type": "common_issue",
  "problem_desc": "{问题描述}",
  "solution": "{解决方案}",
  "prevention": "{预防建议}",
  "status": "pending",
  "created_at": "2026-07-18",
  "triggered_version": "{触发时的技能版本}"
}
```

**Step 6** — **【强制】回读验证全局文件**：

```python
# agent必须执行这段验证逻辑（概念上的，用实际工具实现）
# 1. 读取 ~/.trae-cn/memory/skill_experiences/{skill_name}.json
# 2. 用 json.load 解析
# 3. 遍历 experiences[] 确认新 exp_id 存在
# 4. 如不存在 → 重新执行 Step 5，不得跳过
```

验证成功标准：全局文件中 `experiences[]` 数组包含本次新增的 exp_id。

**Step 7** — **JSON 安全规则**：

⚠️ `problem_desc` 和 `solution` 字段中 **不得使用未转义的 ASCII 双引号 `"`**（U+0022）。这些字段是 JSON 字符串值，内部的引号会破坏 JSON 结构。规则：

1. **始终用 `json.dump(data, f, ensure_ascii=False, indent=2)` 写入 JSON**，不要手动拼接 JSON 字符串
2. **如必须手动构造 JSON**，文本中的中文引号 `""`（U+201C/U+201D）和 ASCII 引号 `"`（U+0022）全部替换为单引号 `'`
3. **写入后立即用 `json.load()` 回读验证**，JSON解析失败说明存在格式错误

### Fallback 注意事项

1. **exp_id 编号不能冲突**：读取现有经验库的最大编号再+1
2. **写入前先 backup**：复制一份原文件到 `.claude/_backup/` 目录
3. **编码**：JSON 文件使用 UTF-8（无 BOM），Windows 下用 `utf-8` 编码保存
4. **原子性**：先写入临时文件 `.tmp`，rename 覆盖原文件，避免写入中断导致文件损坏
5. **全局同步不可延迟**：Step 5 和 Step 6 必须在同一次 capture 调用中完成，**禁止说"收工时统一汇聚"**。实测证明 agent 在收工时往往会忘记这一步
6. **JSON 安全**：写入后必须 `json.load` 回读验证，防止内嵌双引号损坏 JSON

---

# Code 端：读取经验

## 操作一：查看待消费清单

**CLI 命令**：

```bash
python {{PONOS_SKILLS}}/_common/project_context_manager.py skill-loop
```

**agent 也可以直接读文件**：

1. 列出 `~/.trae-cn/memory/skill_experiences/` 目录下所有 .json 文件
2. 对每个文件，筛选 `status == "pending"` 的经验
3. 按技能名分组输出待消费清单

### 输出格式

```
【待消费经验清单】

gxtz-core-tables (3条pending):
  EXP-2026-07-13-001 | validation_rule | RD04未关联IP
  EXP-2026-07-13-002 | format_requirement | IP表摘要列名未对齐
  EXP-2026-07-16-005 | upgrade_trigger | TOAI表改为强制生成

gxtz-rd-report (2条pending):
  EXP-2026-07-17-001 | best_practice | 对比先行工作流
  EXP-2026-07-17-002 | format_requirement | 缩进twips/EMU换算
```

## 操作二：标记已消费 (pending → consumed)

**触发时机**：Code 模式完成技能升级，经验已体现在新版本中

**操作**：直接编辑 `~/.trae-cn/memory/skill_experiences/{skill_name}.json`：

```json
{
  "exp_id": "EXP-2026-07-13-001",
  "status": "consumed",
  "consumed_at": "2026-07-18",
  "integration_method": "已在 v1.22.0 新增XX章节中解决"
}
```

**要求**：每条 pending 经验必须在 CHANGELOG 中逐条回应（如何解决的、在哪个版本解决的）。

## 操作三：标记已验证 (consumed → verified)

**触发时机**：升级后的技能在新项目中执行通过，验证升级有效

**操作**：

```json
{
  "exp_id": "EXP-2026-07-13-001",
  "status": "verified",
  "verified_at": "2026-07-18",
  "verify_result": "pass - 在xx项目中验证通过"
}
```

验证失败则回退：

```json
{
  "exp_id": "EXP-2026-07-13-001",
  "status": "pending",
  "verify_result": "failed - 在xx项目中验证失败，原因：..."
}
```

---

# 经验状态流转

```
                      ┌── closed（不触发升级，独立沉淀）
                      │
pending（待消费） ──► consumed（已消费） ──► verified（已验证） ──► archived（已归档）
  ▲                      │                       │
  │                      │                       │
  └── failed ◄───────────┘                       │
        （验证失败，回退pending）                   │
                                                 │
                                   pass（验证通过）─┘
```

- **pending**：Work agent 刚提交，等待 Code agent 消费升级
- **consumed**：Code agent 已升级到技能新版本，等待验证
- **verified**：在新项目中验证通过，流转结束
- **failed**：在新项目中验证失败，回退 pending 重新升级
- **closed**：不触发技能升级的经验，独立沉淀不流转
- **archived**：经验已沉淀到技能包 experience.json，从全局库备份后移除，仅保留在归档文件中

---
## 操作四：归档已消费/已验证经验并移除 (archive_and_clean)

**触发时机**：Code 模式完成经验消费 → 已沉淀到技能包 experience.json → 经验可安全从全局库移除

**触发关键词**："备份经验"、"清理经验"、"归档经验"、"移除已消费经验"

**操作流程**：

### Step 1 — 扫描全局技能经验库

列出 `~/.trae-cn/memory/skill_experiences/` 目录下所有 .json 文件，逐文件读取 `experiences[]` 数组。

### Step 2 — 按状态分类

```
保留（留在全局库）: status == "pending" 的经验
归档（备份后移除）: status == "consumed" | "verified" | "closed" 的经验
```

### Step 3 — 创建归档备份

将归档的经验写入备份文件：

```
备份路径: ~/.trae-cn/memory/skill_experiences/_archive/archive_{YYYY-MM-DD}.json
```

备份文件结构：
```json
{
  "archive_date": "2026-07-18",
  "description": "已消费/已验证经验归档备份",
  "archived_records": [
    {
      "skill_name": "gxtz-rd-report",
      "exp_id": "EXP-2026-07-16-001",
      "status": "consumed",
      "problem_desc": "...",
      "solution": "...",
      "integration_method": "...",
      "archived_reason": "已沉淀到技能包 experience.json"
    }
  ],
  "stats": {
    "total_archived": 30,
    "by_skill": {"gxtz-rd-report": 5, "gxtz-core-tables": 10}
  }
}
```

### Step 4 — 从全局库移除已归档经验

对每个 `{skill_name}.json`：
- 保留 `status == "pending"` 的经验
- 移除 `status != "pending"` 的经验（已备份到归档文件）
- 更新 `updated_at` 和 `last_synced_from_project`
- 如果某技能保留后 experiences 为空，可以保留空数组（文件不删除）

### Step 5 — 同步更新项目级经验库

如果项目 `experience_base.json` 中存在已归档的经验：
- 将经验 status 更新为 `archived`
- 在 `skill_experience_index` 中添加 `archived_at` 标记

### Step 6 — 产出报告

```
【经验归档报告】

归档日期: 2026-07-18
归档文件: ~/.trae-cn/memory/skill_experiences/_archive/archive_2026-07-18.json

| 技能 | 归档数 | 保留(pending) |
|------|--------|-------------|
| gxtz-rd-report | 7 | 0 |
| gxtz-core-tables | 10 | 3 |
| gxtz-info-collector | 4 | 0 |
| ... | ... | ... |
| 合计 | 30 | 3 |

已归档经验可从 backup 文件恢复，全局库现仅保留 pending 经验。
```

### Fallback 模式：直接文件操作

当 CLI 不可用时，agent 直接读写 JSON 文件：

1. 读取所有 `{skill_name}.json` → 分类 pending / 可归档
2. 创建 `_archive/archive_{date}.json` → 写入归档记录
3. 重写各 `{skill_name}.json` → 仅保留 pending
4. 读取项目 `experience_base.json` → 标记已归档经验为 archived
5. 输出归档报告

### 禁止行为

1. **禁止不备份直接删除**：必须先创建归档备份再移除
2. **禁止移除 pending 经验**：pending 经验仍在等待消费，不可移除
3. **禁止备份后不验证**：移除前必须确认归档文件已成功写入
4. **禁止跳过技能包沉淀直接归档**：先确认经验已写入技能包 experience.json 再归档

---

### 最终步前：同步进度（v1.4.0新增，进度管理集成）

完成所有工作后、文件整理前，更新进度看板：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_sync.py update-stage ^
    --project-root "." ^
    --skill "gxtz-experience-sync" ^
    --status completed
```

此命令将自动匹配本技能对应的阶段并标记为"已完成"。
（注意：finalize 步骤也会自动同步进度，此步为双重保障。）


---

# 禁止行为

1. **禁止只口头记录不调用 capture**：经验必须写入文件，不得只说"我记下来了"
2. **禁止 capture/finalize 时缺少必填字段**：project-root / skill / enterprise / problem-type / problem-desc / solution 缺一不可
3. **禁止 Code 端跳过经验读取直接升级**：升级前必须先读取全局经验库的 pending 清单
4. **禁止升级方案未逐条回应 pending 经验**：每条 pending 必须在 CHANGELOG 中标注如何解决
5. **禁止经验只汇聚不沉淀到技能包**：消费完 pending 后必须更新技能包内 experience.json
6. **禁止不备份直接移除已消费经验**：必须先创建归档备份再移除，禁止直接删除
7. **禁止在未沉淀到技能包前归档**：先确认经验已写入技能包 experience.json 再归档
8. **禁止 Fallback 模式跳过 Step 5 全局同步**：全局同步是强制步骤，不可延迟、不可省略、不可说"收工时统一汇聚"
9. **禁止全局同步后不回读验证**：写入全局文件后必须 json.load 回读确认 exp_id 存在，不验证=未完成

---

# 输出隐患自查与汇报

技能执行结束后，按以下7维自查并汇报：

| 维度 | 检查内容 |
|------|---------|
| ① 原始资料缺失 | capture 调用是否成功写入 experience_base.json |
| ② 文本质量 | problem_desc / solution 是否具体可执行，无空泛表述 |
| ③ 逻辑关联 | 经验是否关联正确的 skill_name 和 problem_type |
| ④ 字数问题 | 不涉及 |
| ⑤ 文档格式 | JSON 写入格式是否正确 |
| ⑥ 政策符合性 | 不涉及 |
| ⑦ 数据可溯源性 | exp_id 是否可追溯到具体会话和项目 |
