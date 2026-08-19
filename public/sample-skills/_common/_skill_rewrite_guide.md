# SKILL.md 重写指南（v1.0 - 2026-07-14）

> **目标**：将 8 个 gxtz-* 技能的 SKILL.md 从"230-476KB 内嵌代码膨胀"重构为"50KB 以内纯指令集"，确保 agent 严格按技能执行。

---

## 一、重写原则

### 1. 删除所有内嵌代码
- 删除"## 公共模块代码"章节（原第 600-5800 行的 Python 代码块）
- 删除所有 ```python 代码块（除字段定义表外）
- 代码已抽取为 _common/ 下的独立 .py 脚本，SKILL.md 只引用脚本路径

### 2. 改为 RunCommand 指令
- 所有"调用 xxx() 函数"改为 `python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\xxx.py <参数>`
- 所有"使用 xxx 模块"改为具体的 RunCommand 命令
- 禁止出现"调用"、"使用"等函数描述形式

### 3. 添加合规红线（置顶）
- 在 frontmatter 后、## 描述 之前，添加"## 合规红线"章节
- 内容参见 _compliance_templates.md 标准章节一

### 4. 添加执行顺序契约（置顶）
- 在合规红线后添加"## 执行顺序契约"章节
- 内容参见 _compliance_templates.md 标准章节二

### 5. 添加审核验证标准（置顶）
- 在执行顺序契约后添加"## 审核验证标准"章节
- 内容参见 _compliance_templates.md 标准章节三

### 6. 删除放任兜底
- 删除所有"如果脚本报错或不可用：阅读 xxx.py 中的设计逻辑，自行编写等效Python代码实现"
- 替换为"如果脚本报错：立即停止，输出错误日志，由用户决定修复方案"

### 7. 修正执行顺序
- "第零步"改为"第一步"
- 删除"模块七/八/九/十一"在"## 指令"和"第零步"之间的错位插入
- 统一改为：合规红线 → 执行顺序契约 → 审核验证标准 → 描述 → 输入输出 → 执行步骤 → 附录

---

## 二、脚本调用映射表

| 原模块描述 | 新 RunCommand 指令 |
|-----------|-------------------|
| 调用 `scan_files_with_archive_support()` | `python _common/archive_extractor.py scan --path "目录路径"` |
| 调用 `load_project_knowledge()` | `python _common/knowledge_base.py load --project-root "项目根目录"` |
| 调用 `update_knowledge_after_skill()` | `python _common/knowledge_base.py update --project-root "项目根目录" --skill "技能名"` |
| 调用 `unified_finalize_materials()` | `python _common/project_context_manager.py finalize --enterprise "企业" --year 年份 --skill "技能名"` |
| 调用 `organize_files_to_categories()` | `python _common/project_context_manager.py finalize --enterprise "企业" --year 年份 --skill "技能名"` |
| 调用 `validate_policy_compliance()` | `python _common/policy_compliance.py validate --project-root "项目根目录"` |
| 调用 `search_enterprise_info()` | `python _common/enterprise_info_search.py search --enterprise "企业名称"` |
| 调用 `generate_rd_report_via_dify()` | `python _common/dify_workflow.py rd-report --enterprise "企业名称" --count N` |
| 调用 `match_rd_ip_ps_with_audit()` | `python _common/rd_ip_ps_matching.py match --project-root "项目根目录"` |
| 调用 `detect_and_process_merged_pdf()` | `python _common/pdf_splitter.py split --input "PDF路径" --output "输出目录"` |
| 调用 `generate_supplement_checklist()` | `python _common/supplement_materials.py checklist --project-root "项目根目录" --skill "技能名"` |
| 调用 `scan_supplement_dir()` | `python _common/supplement_materials.py scan --project-root "项目根目录" --skill "技能名"` |
| 调用 `generate_tables_from_template()` | `python _common/generate_tables_from_template.py --enterprise "企业" --year 年份 ...` |
| 调用 `generate_checklist()` | `python _common/generate_checklist.py ...` |

---

## 三、审核脚本映射表

| 技能 | 审核脚本 | RunCommand 指令 |
|------|---------|----------------|
| gxtz-core-tables | validate_tables.py | `python _common/validate_tables.py --dir "核心表格目录"` |
| gxtz-ip-materials | validate_ip.py | `python _common/validate_ip.py --dir "IP材料目录" --project-root "项目根目录"` |
| gxtz-achievement-materials | validate_achievement.py | `python _common/validate_achievement.py --dir "成果转化材料目录" --project-root "项目根目录"` |
| gxtz-ps-materials | validate_ps.py | `python _common/validate_ps.py --dir "PS材料目录" --project-root "项目根目录"` |
| gxtz-staff-materials | validate_staff.py | `python _common/validate_staff.py --dir "人员材料目录" --project-root "项目根目录"` |
| gxtz-management-materials | validate_management.py | `python _common/validate_management.py --dir "管理制度目录" --project-root "项目根目录"` |
| gxtz-rd-report | validate_rd_report.py | `python _common/validate_rd_report.py --dir "RD报告目录" --project-root "项目根目录"` |
| gxtz-info-collector | validate_info_collector.py | `python _common/validate_info_collector.py --dir "资料清单目录" --project-root "项目根目录"` |

---

## 四、标准 SKILL.md 结构

```markdown
---
name: "gxtz-xxx"
description: "【触发场景】用户说'整理XX/生成XX/校验XX'时使用。高新技术企业认定XX技能。vN.N.N"
version: "x.y.z"
---

# 技能名称

## 触发场景（agent 选择技能时参考）
[嵌入 _attention_optimized_template.md 触发场景节，含强触发词/辅助触发词]

## 合规红线（agent 执行前必读，违反即停止）
[嵌入 _compliance_templates.md 标准章节一]

## 交叉验证协议（双模型校验，关键决策点强制执行）
[由 inject_cross_validation.py 自动注入，详见 _cross_validation_protocol.md]

## 执行顺序契约（agent 必须严格遵守）
[嵌入 _compliance_templates.md 标准章节二]

## 审核验证标准（agent 必须执行且通过）
[嵌入 _compliance_templates.md 标准章节三，替换为对应审核脚本]

## 描述
[技能简介，1-2 段]

## 输入输出
- **输入**：[输入资料清单]
- **输出**：[输出产物清单]

## 执行步骤

### 第一步：项目初始化（强制执行，不可跳过）
```bash
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\project_context_manager.py init --enterprise "企业名称" --year 年份
```
- 失败处理：立即停止，输出错误日志，不得自行兜底

### 第二步：xxx
```bash
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\xxx.py <参数>
```
- 失败处理：立即停止，输出错误日志，不得自行兜底

### ...

### 第N步：交叉验证（关键决策点，双模型校验）
[在关键决策完成后、审核验证前执行]
```bash
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\skill_orchestrator.py checkpoint ^
    --skill gxtz-xxx --checkpoint-id xxx --evidence-file checkpoint.json
```
- 退出码0（pass）：继续
- 退出码2（blocked）：立即停止，等待人工仲裁

### 最后一步：审核验证（必须通过才能提交）
```bash
python c:\Users\T203-15\Desktop\2023guogao\.trae\skills\_common\validate_xxx.py --dir "输出目录" --project-root "项目根目录"
```
- 审核通过（passed=True，退出码 0）：进入提交流程
- 审核失败（passed=False，退出码 1）：立即停止，输出 ERROR 清单，整改后重新审核

## 附录：字段定义与模板对齐
[保留原 SKILL.md 中的字段定义表、模板对齐规范、字数要求等关键内容]
```

---

## 五、重写检查清单

每个重写后的 SKILL.md 必须满足以下条件：

- [ ] 文件大小 ≤ 80KB（原 230-476KB）
- [ ] 无"## 公共模块代码"章节
- [ ] 无 ```python 代码块（字段定义表除外）
- [ ] 无"调用 xxx() 函数"的函数描述
- [ ] 无"自行编写等效Python代码"的放任兜底
- [ ] 有"## 合规红线"章节（置顶）
- [ ] 有"## 执行顺序契约"章节（置顶）
- [ ] 有"## 审核验证标准"章节（置顶）
- [ ] 步骤编号为"第一步、第二步、..."（无"第零步"）
- [ ] 每个步骤有明确的 RunCommand 指令
- [ ] 最后一步是审核验证脚本调用
- [ ] 失败处理统一为"立即停止，输出错误日志"

---

## 变更记录

- v1.0 (2026-07-14)：初始版本，定义重写原则、脚本映射表、标准结构、检查清单
