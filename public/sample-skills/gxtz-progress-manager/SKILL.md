---
name: "gxtz-progress-manager"
description: "【触发场景】用户说'查看项目进度/生成进度看板/更新进度/扫描项目资料'时使用。可视化进度管理技能，全面扫描项目资料，生成HTML进度看板，支持多项目管理和进度自动同步。v1.0.0"
version: "1.0.0"
---

<!-- SECTION_BEGIN: ocr_mandatory -->
## OCR强制规范 → 详见 {{PONOS_SKILLS}}/_common/SHARED_ocr_mandatory.md
> ⚠️ 核心铁律：先OCR后操作，禁止猜测，必须等待，结果空则报错。
> 速查：`python ocr_engine.py detect --file <path>` → `python ocr_engine.py ocr --file <path> --project <project>`
<!-- SECTION_END: ocr_mandatory -->

# 可视化进度管理技能

## 触发场景（agent 选择技能时参考）

> **何时使用本技能**：当用户请求涉及以下场景时，agent 应优先选择本技能。

| 用户可能的表述 | 匹配关键词 | 置信度 |
|--------------|-----------|--------|
| "查看项目进度" | 进度、项目、查看 | 高 |
| "生成进度看板" | 生成、看板、dashboard | 高 |
| "更新项目进度" | 更新、进度、扫描 | 高 |
| "扫描项目资料完整度" | 扫描、资料、完整度 | 高 |
| "新增一个项目到看板" | 新增、项目、看板 | 中 |

**强触发词**：进度、看板、dashboard、进度管理、项目进度
**辅助触发词**：扫描、资料完整度、项目状态

## 合规红线（agent 执行前必读，违反即停止）

### 禁止事项（违反任何一条立即停止并告警）

1. **禁止仅靠文件名分类**：文件扫描必须读取文件内容进行内容级判断，文件名仅作辅助线索
2. **禁止跳过内容识别步骤**：每个文件必须经过内容识别校验，不得跳过直接按文件名归类
3. **禁止移动原始文件**：本技能为只读扫描，不移动/修改任何项目文件
4. **禁止编造进度数据**：所有进度信息必须来自实际文件扫描和技能执行记录
5. **禁止跳过审核步骤**：审核验证步骤必须执行且通过

### 数据来源优先级（高 → 低）

- **文件系统扫描结果**：✅ 直接采用
- **内容识别结果**：✅ 作为分类依据
- **技能执行记录**（experience/working_trace）：✅ 用于判断阶段状态
- **缺失**：❌ 不得编造，标记为 "not_started" 或 "missing"

## 执行顺序契约（agent 必须严格遵守）

### 执行原则

1. **顺序执行**：必须按第一步 → 第二步 → ... → 最后一步顺序执行
2. **失败即停**：任何步骤失败立即停止，输出错误信息
3. **不可跳过审核**：审核验证步骤必须执行且通过

### 脚本调用规范

所有脚本调用必须使用 Bash 工具，格式：

```
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\xxx.py <参数>
```

## 描述

本技能对项目工作推进的整体进度进行评估，包括资料完整度、工作进度等，使用本地HTML脚本实现可视化和统计的实时更新。

核心功能：
1. **项目资料扫描** — 双模式扫描（申报材料扫描 + 全量扫描），严格校验文件有效性
2. **进度汇总** — 按项目类型配置的阶段和材料类别汇总进度数据
3. **HTML看板生成** — 生成自包含的交互式进度看板，支持多项目切换、备忘贴、手动编辑
4. **进度同步** — 提供标准接口供其他技能启动/完成时同步进度

## 输入输出

- **输入**：
  - 项目根目录（包含所有项目资料和 .trae 配置）
  - `.claude/project_types_config.json`（项目类型定义）
  - `.claude/project_config.json`（项目配置）
- **输出**：
  - `.claude/project_progress.json` — 进度数据文件
  - `0000_项目进度/index.html` — 可视化进度看板

## 执行步骤

### 第零步：项目初始化（强制执行，不可跳过）

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\project_context_manager.py init ^
    --enterprise "企业名称" ^
    --year 申报年份
```
- 失败处理：立即停止，输出错误日志，不得自行兜底

### 第一步：读取/创建项目类型配置

检查 `.claude/project_types_config.json` 是否存在：
- 存在：读取并解析项目类型定义（stages、material_categories）
- 不存在：使用 `progress_sync.py` 自动创建默认配置（基于 project_workflow.md 的11阶段定义）

### 第二步：自动发现子项目

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_scanner.py discover ^
    --project-root "." ^
    --output ".claude/_discovered_projects.json"
```

解析输出JSON，获取所有子项目列表。主项目（根目录）始终作为一个项目。

对于每个发现的项目，调用 init-project 初始化进度结构：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_sync.py init-project ^
    --project-root "." ^
    --project-id "main" ^
    --type "gxtz" ^
    --name "云充科技-2026高新认定" ^
    --enterprise "云充科技" ^
    --year 2026
```

### 第三步：双模式文件扫描

对每个项目执行两种扫描：

**3.1 申报材料扫描（scan-materials）**：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_scanner.py scan ^
    --project-root "." ^
    --project-id "main" ^
    --output ".claude/_scan_result_main.json"
```

此命令将：
- 只扫描申报相关格式（.pdf/.docx/.xlsx/.jpg/.png/.doc/.xls）
- 排除 .claude/_*/98.*/99.*/0000_* 目录
- 排除临时文件/草稿/衍生资料
- 对每个文件进行内容校验和时效性判断
- 按 material_categories 匹配归类
- 输出分类结果 + 置信度 + 有效性标记

**3.2 全量扫描（可选，仅统计文件数量）**：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_scanner.py scan ^
    --project-root "." ^
    --project-id "main" ^
    --output ".claude/_scan_result_main_all.json"
```

### 第四步：汇总进度数据

用扫描结果更新 project_progress.json 中的材料统计：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_sync.py update-materials ^
    --project-root "." ^
    --project-id "main" ^
    --scan-result ".claude/_scan_result_main.json"
```

对每个子项目重复此步骤。

### 第五步：检查技能执行状态

读取 `.claude/project_knowledge/experience_base.json` 和各技能的 experience.json，推断各阶段关联技能的执行状态。

对于有执行记录的技能，标记对应阶段为 completed；对于无记录的技能，保持 not_started。

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_sync.py list-pending ^
    --project-root "." ^
    --project-id "main"
```

### 第六步：生成HTML看板

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_dashboard.py generate ^
    --project-root "." ^
    --output "0000_项目进度/index.html"
```

此命令将：
- 读取 project_progress.json 和 project_types_config.json
- 生成自包含HTML文件（内嵌CSS + JS + JSON数据）
- 确保 0000_项目进度/ 目录存在（首次自动创建）

### 第七步：审核验证

检查生成的文件和数据完整性：

| 检查项 | 方法 |
|--------|------|
| project_progress.json 结构完整 | 读取JSON，确认 projects 数组非空 |
| HTML 文件存在 | 检查 0000_项目进度/index.html |
| HTML 文件大小合理 | 应 > 10KB |
| 数据嵌入正确 | 读取HTML，确认 `<script id="progress-data">` 标签包含有效JSON |

### 第八步：Finalize

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\project_context_manager.py finalize ^
    --enterprise "企业名称" ^
    --year 申报年份 ^
    --skill "gxtz-progress-manager" --no-move
```

- 更新 file_map.json / experience_base.json / project_index.json
- 汇聚经验到全局技能经验库
- 写入 working_trace.md

### 第九步：输出隐患自查

技能结束任务后，必须按以下7个维度对输出内容进行隐患自查并汇报：

| 维度 | 检查项 | 状态 |
|------|--------|------|
| ① 原始资料缺失 | 是否有文件无法读取内容？是否有加密PDF未处理？ | ✓/⚠ |
| ② 文本质量 | 材料分类名称是否符合规范？无AI痕迹表述？ | ✓/⚠ |
| ③ 逻辑关联 | 阶段顺序是否正确？阶段依赖关系是否与 project_workflow.md 一致？ | ✓/⚠ |
| ④ 数据完整性 | project_progress.json 所有字段填充率？空值比例？ | ✓/⚠ |
| ⑤ 文档格式 | HTML看板CSS/JS是否正确嵌入？无外部依赖遗漏？ | ✓/⚠ |
| ⑥ 项目配置 | project_types_config.json 阶段定义是否与 project_workflow.md 匹配？ | ✓/⚠ |
| ⑦ 数据可溯源性 | 每个材料分类的文件数能否追溯回实际扫描的文件？ | ✓/⚠ |

每个维度标注 ✓（合格）或 ⚠（有隐患），对隐患给出具体说明。

## 进度同步接口（供其他技能使用）

其他 gxtz 技能可通过以下命令同步进度：

### 启动时：检查前置依赖

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_sync.py check-deps ^
    --project-root "." ^
    --skill "gxtz-rd-report"
```

### 完成时：更新阶段状态

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_sync.py update-stage ^
    --project-root "." ^
    --project-id "main" ^
    --stage-id "stage6" ^
    --status "completed" ^
    --skill "gxtz-rd-report"
```

### 查看待办阶段

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_sync.py list-pending ^
    --project-root "." ^
    --project-id "main"
```

## 附录

### 附录A：项目类型扩展指南

新增项目类型只需在 `.claude/project_types_config.json` 中添加一个条目：

```json
{
  "new_type": {
    "name": "新项目类型名称",
    "icon": "📦",
    "skill_prefix": "gxtz-",
    "stages": [
      { "id": "s1", "name": "阶段1", "order": 1, "depends_on": [], "steps": [...] }
    ],
    "material_categories": [
      { "id": "1", "name": "材料类别", "dir_pattern": "目录*", "required": true, "expected_min": 1, "keywords": [...], "file_types": [...] }
    ]
  }
}
```

### 附录B：HTML看板交互说明

- **项目切换**：点击顶部Tab切换不同项目
- **新增项目**：点击 "+ 新增项目" 按钮弹出表单
- **阶段状态切换**：点击阶段右侧的 "↻" 按钮循环切换状态（未开始→进行中→已完成→已阻塞）
- **备忘贴**：点击右下角 "+" 按钮创建，可拖拽、编辑内容、切换颜色、删除
- **数据持久化**：备忘贴保存在浏览器 localStorage，不随看板刷新丢失
