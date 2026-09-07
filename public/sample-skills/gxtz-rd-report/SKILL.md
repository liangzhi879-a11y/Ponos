---
name: gxtz-rd-report
description: "高新技术企业认定研发立项报告撰写。当用户提到研发立项报告、立项报告、RD报告、项目立项、研发项目报告时调用此技能。"
version: "1.34.0"
triggers:
  - 研发立项报告
  - 立项报告
  - RD报告
  - 项目立项
  - 研发项目报告
---

## 角色定位

> **你是"高新技术企业认定项目老师"**。服务于用户（项目人员），不直接面向客户企业。
> 完整角色定义（三角关系模型/专业领域/能力边界/决策权限/沟通准则）详见 `{{YFW_SKILLS}}/_common/agent_role.md`。

<!-- SECTION_BEGIN: tech_stack_reference -->
## 技术栈引用 → 详见 {{YFW_SKILLS}}/_common/SHARED_tech_stack.md
> 核心：处理文档前必须先 `python doc_toolkit.py info --file <路径>` 查表，禁止自行尝试不同库。
<!-- SECTION_END: tech_stack_reference -->

<!-- SECTION_BEGIN: ocr_reference -->
## OCR能力引用 → 详见 {{YFW_SKILLS}}/_common/SHARED_ocr_reference.md
> PDF混合型必须用 --mode auto 逐页处理。扫描件用RapidOCR(ONNX)，准确率>95%。
> ⚠️ OCR强制铁律：见 {{YFW_SKILLS}}/_common/SHARED_ocr_mandatory.md（先OCR后操作，禁止猜测，必须等待）
<!-- SECTION_END: ocr_reference -->

<!-- SECTION_BEGIN: no_ai_watermark -->
## 输出资料合规规则 → 详见 {{YFW_SKILLS}}/_common/SHARED_no_ai_watermark.md
> 禁止AI水印。文档版本管理: 旧版.bak备份。
<!-- SECTION_END: no_ai_watermark -->


## 合规红线（agent 执行前必读，违反即停止）

> **第一要求：严谨合规。所有数据必须真实可溯源，禁止任何形式的编造。**

### 禁止事项（违反任何一条立即停止并告警）

1. **禁止编造内容**：所有字段数据必须来自真实文件（立项书、证书、合同、发票、社保记录等），不得凭空编造
2. **禁止推断关键数据**：技术领域、研发费用、人员占比、专利状态等关键字段，必须以官方文档（所得税申报表/申请书/证书）为准，不得从项目名称推断
3. **禁止跳过脚本执行**：所有 `python {{YFW_SKILLS}}/_common/xxx.py` 命令必须通过 Bash 真正执行，不得"阅读脚本逻辑自行编写等效代码"
4. **禁止跳过审核步骤**：审核验证步骤必须执行且通过，未通过时不得继续后续步骤
5. **禁止自行兜底**：脚本报错时不得自行编写兜底代码，必须停止并告警由用户决定
6. **禁止合并/简化字段名**：所有表格字段名必须与模板完全一致，不得简化（如"编号"不得代替"知识产权编号"）
7. **禁止跨技能污染**：仅读取当前项目留痕，不跨项目读取；技能内步骤使用当前技能定义的脚本，蜂群编排层可调用_common公共脚本做协调

### 数据来源优先级（高 → 低）

- **官方文档**（所得税申报表 > 申请书 > 证书）：✅ 可直接采用
- **项目推断**（从 RD/IP 项目数据推断）：⚠️ 仅在官方文档缺失时使用，必须标注"推断"
- **联网搜索**（WebSearch 补充）：⚠️ 仅用于企业基本信息，不得用于技术数据
- **缺失**：❌ 不得编造，必须标注"待补充"

### 无法确认时的处理

- **关键字段无法确认**：填写"待补充（需提供 xxx 文件）"，不得编造
- **脚本报错**：立即停止，输出错误日志，由用户决定修复方案
- **审核不通过**：停止后续步骤，输出 ERROR 清单，由用户决定整改方案

## 自主确认机制

> 通用规范详见 {{YFW_SKILLS}}/_common/SHARED_autonomous_confirmation.md
> agent 必须遵守：5项判断原则 + 4类触发(A/B/C/D) + 每步自问5问 + 确认交互规范(AskUserQuestion) + 5条禁止行为。

### 典型场景示例（参考，非穷举）

以下场景需主动暂停确认（agent 应自主识别类似场景，不限于以下列举）：

- **辅助账文件冲突**：同名辅助账在多个文件中内容不同 → A 类
- **费用分配方式**：某年度辅助账是明细账格式，需按比例分配到项目 → C 类
- **RD 项目来源不一致**：立项报告与辅助账的 RD 项目不同 → A 类
- **IP 与 RD 匹配推断**：基于关键词匹配推断 IP 与 RD 关联 → C 类
- **专利文献缺失**：IP 清单中某些专利缺少专利文献 → D 类
- **发票未标注 PS**：上年度全量发票未标注 PS 归属 → D 类
- **社保缴费记录不完整**：缺少上年 12 月带公章的社保记录 → D 类
- **技术领域多源不一致**：申请书与所得税申报表的技术领域不同 → A 类
- **研发费用占比异常**：某年度研发费用占比明显偏低/偏高 → B 类
- **人员在职天数临界**：某人员在职天数在 180-185 天临界 → C 类
## 质疑与协同审查机制（通用规范）

> 通用规范详见 {{YFW_SKILLS}}/_common/SHARED_questioning_review.md
> agent 必须遵守：四类触发(E/F/G/H) + 6条自问 + 质疑交互规范(AskUserQuestion) + 6条禁止行为 + 人机协同流程 + 质疑记录要求。
## 蜂群协同

> 通用规范详见 {{YFW_SKILLS}}/_common/SHARED_swarm_collaboration.md
> 跨技能并行执行 + subagent规范 + file_lock并发控制。
## 交叉验证协议 → 详见 {{YFW_SKILLS}}/_common/SHARED_cross_validation.md
> 关键决策点强制交叉验证。调用: `python cross_model_validator.py validate --checkpoint-file <证据包> --skill <技能名>`
<!-- SECTION_END: cross_validation_protocol -->

## 执行顺序契约（agent 必须严格遵守）

### 执行原则

1. **顺序执行**：必须按第一步 → 第二步 → ... → 最后一步顺序执行，严禁跳过任何步骤
2. **失败即停**：任何步骤失败（脚本报错、校验不通过、数据缺失）立即停止，输出错误信息，不得继续
3. **不可并行（有依赖时）**：技能内步骤有数据依赖时不得并行；跨技能独立任务在蜂群编排下可并行执行，参见蜂群编排规范（_swarm_orchestration.md）
4. **不可跳过审核**：审核验证步骤必须执行且通过，未通过时不得进入下一步

### 步骤编号规则

- **第一步**：项目初始化（强制执行，不可跳过）
- **第二步 ~ 倒数第二步**：核心业务步骤
- **最后一步**：审核验证（必须通过才能提交）

### 失败处理标准流程

当任何步骤失败时，agent 必须执行以下流程：

1. **立即停止**当前步骤及后续所有步骤
2. **输出错误信息**：包含失败步骤、错误原因、脚本日志（如有）
3. **输出已完成的步骤清单**：让用户了解当前进度
4. **等待用户决定**：由用户决定修复方案（修复脚本/补充资料/手工处理）
5. **禁止自行兜底**：不得"阅读脚本逻辑自行编写等效代码"

### 脚本调用规范

所有脚本调用必须使用 Bash 工具，格式：

```
python {{YFW_SKILLS}}/_common/xxx.py <参数>
```

- 脚本路径必须使用项目相对路径
- 参数必须按脚本定义的 CLI 接口传递
- 不得通过"调用 xxx() 函数"的形式执行（函数描述不是可执行命令）

## 审核验证标准（agent 必须执行且通过）

### 审核脚本调用

最后一步必须执行对应的审核验证脚本：

```
python {{YFW_SKILLS}}/_common/validate_rd_report.py --dir "输出目录" --project-root "项目根目录"
```

### 审核通过条件

审核脚本返回 `passed: True` 且退出码为 0 时，方可进入提交流程。

### 审核失败处理

1. 审核脚本返回 `passed: False` 或退出码非 0 时，立即停止
2. 输出 ERROR 清单（包含每条错误的行号、字段、原因）
3. 根据 ERROR 清单逐一整改
4. 整改后重新执行审核脚本
5. 直到全部 PASS 方可提交

### 审核报告输出

审核脚本必须生成 JSON 格式的审核报告，包含：
- `passed`: bool（整体是否通过）
- `errors`: list（错误清单，每条含 file/row/col/field/reason）
- `warnings`: list（警告清单）
- `stats`: dict（统计信息）

# 研发立项报告撰写

## 描述
本技能用于撰写高新技术企业认定所需的研发项目立项报告。根据企业研究开发活动汇总表中的研发项目信息，生成符合申报要求的立项报告文档。

## 使用场景
- 用户提到"研发立项报告"、"立项报告"、"RD报告"
- 用户需要撰写或修改研发项目立项报告
- 用户提到"项目立项"、"研发项目报告"

## 全局知识库集成

本技能在执行时需要读取和更新全局项目知识库。

### 读取知识库
```python
def load_project_knowledge():
    """读取项目知识库"""
    knowledge_dir = ".claude/project_knowledge"
    
    if not os.path.exists(f"{knowledge_dir}/project_index.json"):
        return None
    
    with open(f"{knowledge_dir}/project_index.json", 'r', encoding='utf-8') as f:
        index = json.load(f)
    
    with open(f"{knowledge_dir}/enterprise_info.json", 'r', encoding='utf-8') as f:
        enterprise_info = json.load(f)
    
    return {
        'index': index,
        'enterprise_info': enterprise_info
    }
```

### 更新知识库
```python
def update_knowledge_after_report(rd_id, rd_name, report_path):
    """更新知识库（立项报告完成后）"""
    import json
    from datetime import datetime
    
    knowledge_dir = ".claude/project_knowledge"
    
    with open(f"{knowledge_dir}/project_index.json", 'r', encoding='utf-8') as f:
        index = json.load(f)
    
    # 更新文件结构图
    if "研发项目" not in index['file_structure']['tree']:
        index['file_structure']['tree']["研发项目"] = {}
    if "立项报告" not in index['file_structure']['tree']["研发项目"]:
        index['file_structure']['tree']["研发项目"]["立项报告"] = []
    
    index['file_structure']['tree']["研发项目"]["立项报告"].append({
        'name': f"{rd_id}_{rd_name}_立项报告.docx",
        'path': report_path,
        'status': '已完成',
        'verified': False,
        'rd_id': rd_id
    })
    
    # 更新进度追踪
    if "研发项目" not in index['progress_tracking']['categories']:
        index['progress_tracking']['categories']["研发项目"] = {
            'total': 0,
            'completed': 0,
            'status': '未开始',
            'items': []
        }
    
    cat = index['progress_tracking']['categories']["研发项目"]
    existing = [i for i in cat['items'] if i['name'] == f"{rd_id}_立项报告"]
    if not existing:
        cat['items'].append({
            'name': f"{rd_id}_立项报告",
            'status': '已完成',
            'file': report_path
        })
        cat['total'] += 1
    
    cat['completed'] = len([i for i in cat['items'] if i['status'] == '已完成'])
    if cat['completed'] == cat['total']:
        cat['status'] = '已完成'
    elif cat['completed'] > 0:
        cat['status'] = '进行中'
    
    # 更新知识图谱（添加RD节点）
    rd_node = {
        'id': rd_id,
        'type': '研发项目',
        'name': rd_name
    }
    existing_node = [n for n in index['knowledge_graph']['nodes'] if n['id'] == rd_id]
    if not existing_node:
        index['knowledge_graph']['nodes'].append(rd_node)
    
    index['updated_at'] = datetime.now().isoformat()
    
    with open(f"{knowledge_dir}/project_index.json", 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
```

---

## 统一输出目录规范

本技能生成的文件必须统一存放到项目输出根目录下，便于用户查看操作。

### 输出根目录
`{企业名称}_高新认定材料_{申报年份}/`

统一目录结构：00_核心表格 / 01_研发立项报告 / 02_知识产权证明 / 03_成果转化证明 / 04_高新产品证明 / 05_科技人员材料 / 06_管理制度材料 / 07_资料收集清单 / _校验报告

### 本技能输出子目录
`01_研发立项报告/`（校验/审核报告输出到 `_校验报告/`）

### 目录创建函数（通用）
```python
import os

def get_output_dir(enterprise_name, application_year, subdir):
    """获取并创建统一输出目录，返回子目录绝对路径"""
    root = f"{enterprise_name}_高新认定材料_{application_year}"
    output_dir = os.path.join(root, subdir)
    os.makedirs(output_dir, exist_ok=True)
    return output_dir
```

## 指令

**企微缓存预收集提示（可选）**：
如果补充资料目录为空或关键资料缺失，可调用企微 CLI 从企微缓存目录预收集：
python {{YFW_SKILLS}}/_common/wecom_query.py diagnose
详见模块十二：企业微信会话实时查询与附件收集。

### 第零步完：确认进度依赖（v1.34.1新增，进度管理集成）

在开始工作前，检查本技能的前置阶段是否已完成：

```bash
python {{YFW_SKILLS}}/_common/progress_sync.py check-deps ^
    --project-root "." ^
    --skill "gxtz-rd-report"
```

若返回 WARNING 提示存在未完成的前置阶段，agent 应提示用户先完成前置依赖。

> 进度管理集成说明详见: `{{YFW_SKILLS}}/gxtz-progress-manager/SKILL.md`


### 第一步：项目初始化（强制执行，不可跳过）

**执行以下命令初始化项目知识库**（在项目根目录运行）：

```bash
python {{YFW_SKILLS}}/_common/project_context_manager.py init --enterprise "{企业名称}" --year {申报年份}
```

此命令将创建 .claude/file_map.json、.claude/experience_base.json、.claude/project_index.json 并扫描项目文件分类到19类。

1. 在 .claude 目录创建 file_map.json（含enterprise/application_year/files字段）
2. 创建 experience_base.json（含enterprise/skill_executions字段）
3. 创建 project_index.json（含enterprise/application_year/skills_progress字段）
4. 扫描项目目录所有文件，按19类目录结构分类填充 file_map.json
5. 3个json文件必须生成，否则后续步骤无法正常工作

**初始化后读取**：读取 file_map.json 了解已有文件分布，读取 experience_base.json 获取历史经验。

**补充资料检查与整理**：
6. 调用 `generate_supplement_checklist(enterprise_name, application_year, 'gxtz-rd-report')` 生成/更新补充资料清单文档
7. 调用 `scan_supplement_dir(enterprise_name, application_year, 'gxtz-rd-report')` 扫描补充资料目录：
   - 如果有新文件：自动读取分析（支持压缩文件解压），添加到文件图谱
   - 如果有新文件：调用 `organize_supplement_files()` 整理到统一输出目录
   - 如果有新文件：调用 `update_experience_from_supplement()` 沉淀识别规则到经验库
8. 将补充资料分析结果作为本技能执行的输入数据

**合并PDF自动检测与拆分**：
9. 调用 `batch_process_merged_pdfs(data_dir)` 批量扫描数据目录下所有PDF文件，自动检测合并PDF（多文档合订）：
   - 检测到合并PDF：自动备份原件到 `_backup/pdf_original/` 目录（保留原始文件不变）
   - 按书签/内容类型/页三种方式智能选择拆分，生成拆分后文件到 `{原文件名}_拆分/` 目录
   - 对每个拆分后文件提取文本/表格/图片，扫描页（无文本层）自动触发 `ocr_scanned_pdf()` OCR识别
   - 拆分后的文件作为本技能的输入数据，替代原始合并PDF进行分析
   - 非合并PDF：直接提取内容，不拆分

### 第一步：读取知识库和RD表数据
1. 读取全局项目知识库（project_knowledge/project_index.json）
2. 读取企业基本信息（project_knowledge/enterprise_info.json）
3. 从核心表格中读取RD表数据
1. 从核心表格中读取RD表数据
2. 选择需要撰写立项报告的研发项目
3. 提取项目基本信息：编号、名称、技术领域、起止时间、经费预算、人员配置

## v1.33.0 模板内置打包 + 强制模板注入约束

> **背景**：中瑞远博项目中缺失模板导致 agent 手动拼表，将模板打包到技能包内确保所有项目可用。

**变更内容**：
1. **模板内置打包**：`_common/templates/企业研究开发活动汇总表（近三年执行的活动）.xlsx` 随技能包分发
2. **两级查找兜底**：`template_injector._resolve_template()` 改为 项目目录 → 内置模板 两级查找
3. **强制约束**：新增 ⛔ 硬约束 —— RD汇总表必须通过 `TemplateInjector.inject_rd_table()` 生成，禁止手动拼表
4. **修复模板关键词**：`"研发活动汇总表"` → `"研究开发活动汇总"`（匹配内置模板文件名）

涉及文件：
- `_common/templates/企业研究开发活动汇总表（近三年执行的活动）.xlsx`（新增内置模板）
- `_common/template_injector.py`
- SKILL.md（版本号 + 模板文件说明 + 强制约束）
- CHANGELOG.md

## v1.32.0 核心架构变更：提示词驱动内容生成 + 脚本注入

> **背景**：此前 RD 立项书的内容生成方式为 agent 自由撰写 + `template_filler.py` 混合填充，实际执行中容易退化为"提取 IP 摘要拼接 + fallback 模板句"，导致内容与项目脱节、风格不一致。
> **v1.32.0 彻底解耦**：内容生成全部由 agent 按标准提示词逐 RD 生成，`template_filler.py` 仅负责将已生成的内容注入模板（格式注入），不参与内容生成逻辑。

### 五步流水线（每份 RD 独立执行）

```
Phase 1: 准备上下文包
  └→ 打包 RD_NAME / RD编号 / 台账原始名称 / 关联IP全量信息（名称+摘要+先进性说明+支持作用） / PS名称 / 技术领域

Phase 2: 运行提示词生成内容（agent 核心工作）
  └→ agent 读取 RD 上下文包，按 RD立项书提示词 逐份生成 7 段内容

Phase 3: 质量门禁（agent 自动执行，不合格自动重跑）
  └→ 字数检查 / 编号泄露检查 / 夸大词检查 / AI词检查 / IP名称完整性检查

Phase 4: 不合格重跑
  └→ 带修正提示重新生成，最多重跑 2 次，仍不合格标记人工审核

Phase 5: 脚本注入（template_filler.py 仅负责格式注入）
  └→ 将 Phase 2 生成的内容作为 JSON 传入 template_filler.py → 填模板 → 脚本注入编号/日期/人员并标黄
```

### 提示词（RD立项书内容生成，每份 RD 独立运行）

> **出处**：`{{YFW_SKILLS}}/_common/RD立项书提示词.txt`
> agent 必须原样使用以下提示词，不得自行修改、精简或合并。

**提示词原文**：
```
根据上边提供的"TO-AI"资料表格，通过适当推理，拟写RDXX项目的：

一、项目简介（连贯整段话，描述项目立项背景，以及项目的研发目的，不少于500字）

二、主要研究内容

1、项目采用的关键技术（连贯整段话，表述项目关键研发技术方向，不少于400字）

2、主要技术参数指标（分点列出设计技术参数指标）

3、项目预期效果及创新性（分点列出，预期效果、创新性分开写，每部分不少于4点）

三、项目验收总结

1、项目完成内容（连贯整段话，不少于400字）

2、项目成果（包括知识产权情况，必须参照"TO-AI"表格中"RD-研发项目"工作簿的关联IP、隐性NIP写，考虑RD完成与IP申请之间时间前后关系，若RD在IP之前，则为孵化知识产权，若反之，则为挖掘技术积累，NIP只考虑内容，不能体现任何标题或编号数据）

3、项目的核心技术（分点表述，不少于4点400字）

4、技术创新点（分点表述，不少于4点400字）

5、项目产生的综合效益（连贯整段话，不少于300字）

要求：1、内容必须贴近公司实际情况，具体资料可参照表格提供的网站等信息来源，不要使用"领先"、"首创"等夸大其词的描述，不要说明任何领先地位。不要轻易使用"AI"等相关描述，除非项目资料中明确显示有"AI"字眼。2、语言正式，标点符号完整，非必要不使用"（……）"的注释，项目的研发内容注意参考关联IP。3、审查对数据很敏感，不要随意引用不相关数据，尽量使用概括语句。4、不要出现RD及IP编号，必要时用项目或知识产权名称或内容代替，项目名称、知识产权名称等重要信息引用必须完整不得遗漏。
```

### 执行策略（分批并行）

> RD 数量通常 15-26 份。单份提示词生成约 1-2 轮（含质量校验），全部串行执行效率过低。
> **推荐策略**：使用 Task subagent（general_purpose_task）分批并行，每批 5-6 个。

```
Round 1: RD01-RD06 (6 parallel subagents) → 各自输出 JSON
Round 2: RD07-RD12 (6 parallel subagents) → 各自输出 JSON
Round 3: RD13-RD18 (6 parallel subagents) → 各自输出 JSON
Round 4: RD19-RD24 (6 parallel subagents) → 各自输出 JSON
Round 5: RD25-RD26 (2 parallel subagents) → 各自输出 JSON
```

**每个 subagent 的任务**：
1. 读取该 RD 的上下文包（从 TO-AI 表格 + RDPS 表 + IP 表提取）
2. 按提示词生成 7 段内容
3. 质量自检（见下方质量门禁）
4. 不合格自动重跑（最多 2 次）
5. 输出结构化 JSON

### 质量门禁（每份 RD 生成后强制执行）

agent 必须在每份 RD 生成后运行以下检查，任一不通过即标记为不合格并重新生成：

| # | 检查项 | 规则 | 不通过处理 |
|---|--------|------|-----------|
| 1 | 项目简介字数 | ≥500 字 | 重新生成，提示"项目简介字数不足500，请扩充" |
| 2 | 关键技术字数 | ≥400 字 | 重新生成，提示"关键技术字数不足400，请扩充" |
| 3 | 项目完成内容字数 | ≥400 字 | 重新生成，提示"完成内容字数不足400，请扩充" |
| 4 | 核心技术点数 | ≥4 点，≥400 字 | 重新生成，提示"核心技术不足4点或字数不足" |
| 5 | 技术创新点点数 | ≥4 点，≥400 字 | 重新生成，提示"技术创新点不足4点或字数不足" |
| 6 | 综合效益字数 | ≥300 字 | 重新生成，提示"综合效益字数不足300，请扩充" |
| 7 | 预期效果点数 | ≥4 点 | 重新生成，提示"预期效果不足4点，请补充" |
| 8 | 创新性点数 | ≥4 点 | 重新生成，提示"创新性不足4点，请补充" |
| 9 | RD/IP 编号泄露检查 | 不含 RD01/RD02/IP01 等编号 | 重新生成，提示"不得出现编号，用名称代替" |
| 10 | 夸大词检查 | 不含"领先/首创/第一/唯一/国际先进/国内首创" | 重新生成，提示"移除夸大词汇" |
| 11 | AI 词检查 | 不含"AI/人工智能/机器学习" 除非 TO-AI 表明确有此描述 | 重新生成，提示"移除AI相关描述" |
| 12 | IP 名称完整性 | 所有引用的知识产权名称完整无遗漏 | 重新生成或手动补充 |
| 13 | 括号注释检查 | 避免使用"（……）"格式的注释 | 重新生成，提示"减少括号注释" |

**重跑上限**：每份 RD 最多重跑 2 次。2 次后仍未通过 → 标记 `needs_manual_review`，继续下一份，全部批量完成后统一人工处理。

### 输出 JSON 结构（每份 RD 生成后输出）

```json
{
  "rd_id": "RD01",
  "rd_name": "压缩空气精密过滤器研发",
  "rd_account_name": "压缩空气精密过滤器",
  "content": {
    "项目简介": "（≥500字整段文本）",
    "关键技术": "（≥400字整段文本）",
    "技术参数指标": ["参数1：xxx", "参数2：xxx"],
    "预期效果": ["效果1：xxx", "效果2：xxx", "..."],
    "创新性": ["创新1：xxx", "创新2：xxx", "..."],
    "项目完成内容": "（≥400字整段文本）",
    "项目成果": "（含知识产权情况）",
    "核心技术": ["点1：xxx", "点2：xxx", "点3：xxx", "点4：xxx"],
    "技术创新点": ["点1：xxx", "点2：xxx", "点3：xxx", "点4：xxx"],
    "综合效益": "（≥300字整段文本）"
  },
  "quality_gate": {
    "passed": true,
    "retries": 0,
    "checks": { "字数": "✓", "编号泄露": "✓", "夸大词": "✓", "AI词": "✓", "IP完整性": "✓" }
  }
}
```

### 第二步（旧）：模板选择与脚本注入（格式注入，非内容生成）

> **注意**：第二步中的内容已由上述提示词流程生成完毕。以下步骤仅负责「格式注入」——将已生成的 JSON 内容填入模板位置。

**模板选择**（按优先级）：
1. 用户指定过往项目报告路径 → 最高优先级
2. 项目 `_模板/` 目录下的 .docx → 自动扫描
3. 技能包内置 `templates/default_rd_template.docx` → fallback

**格式注入**：调用 `template_filler.py` 将 JSON 内容填入模板

```bash
# 单文件模式
python {{YFW_SKILLS}}/_common/template_filler.py \
  --template "选定的模板路径" \
  --data "rd数据.json" \
  --output "输出路径/{企业名称}-{RD编号}-{RD名称}立项报告.docx" \
  --verify --verbose

# 批量模式（全部 RD 的 JSON 生成完毕后一次性填入）
python {{YFW_SKILLS}}/_common/template_filler.py \
  --template "选定的模板路径" \
  --data "rd数据列表.json" \
  --output-dir "输出目录/" \
  --batch --verify --verbose
```

**JSON 数据准备**（从 Phase 2 输出汇总）：
1. 将所有 RD 的 JSON 汇总到 `rd数据列表.json`
2. 补充模板占位符字段：RD_NAME / RD_CODE / RD_PERIOD / ENTERPRISE_NAME
3. 章节内容直接使用 Phase 2 生成的质量已通过文本

**格式要求**：
- 内容填充: 走 `template_filler.py` XML级替换，100%保持模板格式
- `template_filler.py` 仅做格式注入，不参与内容生成，不得修改已通过质量门禁的文本
- 用户模板的章节结构以用户模板为准，默认模板为6章标准结构

**编号/日期/人员脚本注入（标黄）**：
```python
# Phase 5 最后一步：脚本注入结构化字段并标黄
from _common.template_injector import highlight_fields

highlight_fields(
    doc_path="输出路径/xxx立项报告.docx",
    fields={
        "项目编号": "2023RD01",
        "项目负责人": "张三",
        "起止日期": "2022/06/01 - 2023/05/31",
        "经费预算": "48万元"
    },
    highlight_color="FFFF00"
)
```

### 第三步：格式校验
1. 检查文档格式：字体、字号、行距、页边距
2. 检查字数限制：各章节是否符合字数要求
3. 检查数据一致性：与RD表中的数据是否一致
4. 保存文档，命名格式：{企业名称}-{RD编号}-{RD名称}立项报告.docx

### 第四步：生成校验报告
1. 验证所有立项报告是否已生成
2. 验证文档格式是否符合要求
3. 生成《立项报告撰写校验报告》

### 第五步：审核验证（必须通过才能提交）
1. **完整性审核**
   - 检查所有RD项目是否都有对应的立项报告
   - 检查立项报告是否包含所有必需章节（项目简介、主要研究内容、项目验收总结）
   - 检查各章节字数是否符合要求

2. **一致性审核**
   - 验证立项报告中的项目名称与RD表一致
   - 验证立项报告中的知识产权与RD表关联的IP一致
   - 验证立项报告中的时间范围与RD表一致
   - 验证立项报告中的经费与RD表一致
   - 验证技术内容与RD表、知识产权表描述一致

3. **规范性审核**
   - 检查文件命名是否符合规范（调用 `detect_naming_issues()` 检测hash命名/微信图片/扫描仪/手机/WPS拼图/多次优化/大小写不一致/学历不统一等问题，调用 `batch_validate_naming()` 批量校验IP/RD/PS/成果转化/财务/网报/学历/社保命名规范）
   - 检查字体格式：宋体（中文），Times New Roman（英文和数字）
   - 检查字号：小四号（12pt）
   - 检查行距：1.5倍行距
   - 检查段落格式：首行缩进2字符

4. **内容质量审核**
   - 验证项目简介≥500字
   - 验证关键技术≥400字
   - 验证项目完成内容≥400字
   - 验证综合效益≥300字
   - 验证预期效果≥4点
   - 验证创新性≥4点
   - 验证核心技术≥3点
   - 验证技术创新点≥3点
   - 检查是否避免使用"领先"、"首创"等夸大词汇
   - 检查是否谨慎使用"AI"等描述

5. **生成审核报告**
   - 生成《研发立项报告审核报告》
   - 列出所有审核问题及整改建议
   - 审核结论：通过/不通过

6. **审核通过条件**
   - 所有RD项目都有立项报告
   - 文档格式规范
   - 字数符合要求
   - 内容质量达标
   - 数据一致性检查通过

7. **审核不通过处理**
   - 列出所有问题清单
   - 提供整改建议
   - 要求整改后重新提交审核

8. **Dify工作流集成校验（如使用）**
   - 调用 `test_dify_workflow_connection()` 验证API连通性和变量匹配
   - 工作流执行后，检查 `downloaded_docs` 列表非空
   - 调用 `validate_rd_doc_quality()` 校验生成的文档质量（intro/tech/accept三段长度）
   - QC未通过时，在审核报告中标注并建议人工审核

### 第六步：生成立项决议文档（v1.29.0新增，v1.34.0重构）

> **v1.34.0 重构**：从"汇总表模式"改为"每RD独立文档模式"。默认每个RD生成一份独立的立项决议文档，不再生成汇总表。

#### 前置确认（v1.34.0新增，强制执行）

**生成前必须询问用户**：使用 AskUserQuestion 工具确认生成模式——

- **独立文档**（推荐，默认）：每个RD各生成一份独立立项决议.docx
- **汇总表**（旧版）：所有RD合并为一份汇总表.docx（用户明确要求时才选用）

> ⚠️ 不得假设汇总表模式，默认走独立文档。

#### 独立文档模式（v1.34.0默认）

为每个 RD 逐一生成独立的立项决议文档：

```bash
# 逐一生成（每个RD一份独立决议文档）
python {{YFW_SKILLS}}/_common/generate_approval_resolution.py \
  --rd-data "rd_summary.json" \
  --enterprise "{企业名称}" \
  --year {申报年份} \
  --output-dir "{输出目录}/立项决议/" \
  --mode individual
```

**文件命名**：`{企业名称}-{RD编号}-{项目名称}立项决议.docx`

**rd_summary.json 数据来源**：从已生成的立项报告中提取：
- code: RD编号
- name: 项目名称
- period: 起止时间
- approval_date: 决议日期（取RD立项开始日期，YYYY年MM月DD日格式）
- resolution: 立项决议内容（取每份报告第六章内容）

#### 独立文档结构规范（v1.34.0强制执行）

每份立项决议文档必须包含以下元素，不可缺失：

```
1. 标题：{企业名称}研发项目立项决议
2. 决议正文（整段表述）
3. 项目基本信息（编号/名称/起止时间/经费）
4. 右对齐企业名称落款（必含）
5. 右对齐日期落款（YYYY年MM月DD日格式，必含）
```

**禁止元素**：
- ❌ 审批人(签字)栏
- ❌ 审批人签名行
- ❌ 任何待签字空位

**日期格式规范**（v1.34.0强制执行）：
- 从RD数据中提取 start_date（格式 YYYY-MM-DD）
- 拆分为年/月/日后拼接为 `YYYY年MM月DD日`
- 示例：`2023-01-01` → `2023年01月01日`
- 禁止使用 `YYYY.MM` 格式
- 日期落款位置：文档末尾右对齐

**生成后必须逐份检查**：
```
□ 企业名称落款存在且右对齐
□ 日期落款存在（YYYY年MM月DD日）且右对齐
□ 无审批人签字栏
□ 文件名符合规范
```

#### 汇总表模式（旧版，仅用户明确要求时使用）

```bash
python {{YFW_SKILLS}}/_common/generate_approval_resolution.py \
  --rd-data "rd_summary.json" \
  --enterprise "{企业名称}" \
  --year {申报年份} \
  --output "{输出目录}/立项决议汇总.docx"
```

### 第七步：RD汇总表模板注入（v1.31.0新增，强制）

所有 RD 立项报告生成并通过审核后，调用 `template_injector` 将 RD 数据注入官方模板，输出《企业研究开发活动汇总表（近三年执行的活动）》。

```bash
python -c "
import sys
sys.path.insert(0, r'{{YFW_SKILLS}}/_common')
from template_injector import TemplateInjector

injector = TemplateInjector(
    template_dir='00_核心表格',
    output_dir='_output',
    enterprise_name='{企业名称}'
)

rd_data = [
    {
        '编号': 'RD01', '名称': 'xxx研发',
        '领域一级': '新能源与节能', '领域二级': '高效节能技术', '领域三级': '工业节能技术',
        '开始时间': '2023/01/03', '结束时间': '2023/05/31',
        '技术来源': '企业自有技术', 'IP编号': 'IP02',
        '预算': '48', '总支出': '55.09', '第一年': '55.09', '第二年': '', '第三年': '',
        '人员数': '5',
        '目的': '目的：xxx...', '核心技术': '核心技术：xxx...', '阶段成果': '2023年1-3月...'
    },
]

result_path = injector.inject_rd_table(rd_data)
print(f'RD汇总表已生成：{result_path}')
"
```

**数据采集来源**：
- RD编号/名称/日期/人员/预算 ← RD立项报告
- 技术领域（一级/二级/三级） ← RD立项书
- IP编号 ← RD-IP关联表
- 目的/核心技术/阶段成果 ← 立项报告对应段落

**禁止事项**：禁止 agent 从零生成表格，必须使用 `template_injector` 注入官方模板。

### 最终步前：同步进度（v1.34.1新增，进度管理集成）

完成所有工作后、文件整理前，更新进度看板：

```bash
python {{YFW_SKILLS}}/_common/progress_sync.py update-stage ^
    --project-root "." ^
    --skill "gxtz-rd-report" ^
    --status completed
```

此命令将自动匹配本技能对应的阶段并标记为"已完成"。
（注意：finalize 步骤也会自动同步进度，此步为双重保障。）

### 最终步：文件整理与知识库更新（强制执行，审核验证通过后必须执行）

**执行以下命令整理文件并更新知识库**（在项目根目录运行）：

```bash
python {{YFW_SKILLS}}/_common/project_context_manager.py finalize --enterprise "{企业名称}" --year {申报年份} --skill "gxtz-rd-report" --no-move
```

此命令将：按19类目录结构整理文件 → 生成 .claude/_file_management_report.md 整理报告 → 更新 file_map.json / experience_base.json / project_index.json → 校验3个json文件已生成。
- **finalize 后强制验证（v2.0 新增，不可跳过）**：
  1. 立即读取 `.claude/_finalize_diff.json`，检查 `moved_from_protected`（应为空）和 `warnings`（应为空）
  2. `ls` 扫描 01_立项报告（至少RD数量），确认文件数不少于预期
  3. 若 `moved_from_protected` 非空或目录文件减少，从 diff 报告的 `to` 位置 Copy-Item 恢复到 `from` 位置
  4. 向用户输出验证结果（✅/⚠ + 具体数字），不得隐藏问题

1. 按19类目录结构整理文件（先检查补充资料目录，将可归类的文件移动到匹配目录）
2. 生成 _file_management_report.md 整理报告（含已归类/未归类/各类别统计/产出校验）
3. 更新 file_map.json（更新文件路径）、experience_base.json（记录本次执行）、project_index.json（更新进度）
4. 校验3个json文件均已生成，如未生成则报错

**清理临时文件**：确保资料目录无Word临时文件（~$开头）和重复文件（(1)后缀等）。

## 工具依赖
- **python-docx**：创建Word .docx文件（`pip install python-docx`）
- **openpyxl**：读取Excel数据（`pip install openpyxl`）
- **注意**：输出必须是.docx格式，不能是旧版.doc格式

## OOXML技术要点（v1.21.0新增，基于中瑞项目经验）

### twips与EMU单位换算

python-docx 的 `paragraph_format.first_line_indent` 返回 `EMU`（英制公制单位），但底层 OOXML 属性 `w:firstLine` 存储的是 `twips`（二十分之一磅）。换算关系：**1 twip = 635 EMU**。

```python
# 读取缩进（EMU）
indent_emu = paragraph.paragraph_format.first_line_indent  # 如 266700 EMU

# 转换为 twips（OOXML实际值）
indent_twips = indent_emu // 635  # 266700 // 635 = 420 twips

# 设置缩进（twips → EMU）
paragraph.paragraph_format.first_line_indent = Cm(0.74)  # 420 twips ≈ 0.74cm
```

**标准缩进值**: 420 twips（0.74cm），对应首行缩进约2个中文字符。

### python-docx 常见坑点

1. **合并单元格后段落格式丢失**：`cell.merge(other_cell)` 后，被合并单元格的段落样式（字体、字号、缩进）不会自动继承到合并后的单元格。需在合并后重新设置段落格式。
2. **表格操作优先用 XML patch**：复杂表格操作（移动行、合并审批表到主表）建议直接操作 `doc.element.body` 中的 `w:tbl` 节点，而非通过 python-docx 高层 API。
3. **`cell.text` 读不到 vMerge 单元格内容**：被 vMerge 合并的续行单元格 `.text` 属性返回空字符串，需通过 lxml 直接访问 `<w:t>` 元素。
4. **Run 层级文本分割**：python-docx 会对包含不同格式的段落自动拆分为多个 Run，替换占位符时必须遍历 Paragraph.runs 而非直接操作 Paragraph.text。
5. **中文字体设置**：需同时设置 `run.font.name` 和设置 `w:rPr/w:rFonts` 的 `w:eastAsia` 属性，否则中文不生效。

### XML 直接操作注意事项

```python
from docx.oxml.ns import qn
import copy

# 移动表格行：必须先 deepcopy 再 remove
tr = copy.deepcopy(source_row._tr)
target_tbl.append(tr)
source_tbl.remove(source_row._tr)  # 注意索引偏移

# 移除合并单元格标记
from lxml import etree
for vmerge in cell._tc.findall('.//w:vMerge', nsmap):
    parent = vmerge.getparent()
    parent.remove(vmerge)
```

## 关键时间逻辑

### 申报年份确定
```
申报年份 = 用户指定的申报年份（如2025）
近三年 = [申报年份-2, 申报年份-1, 申报年份]
示例：2025年申报 → 近三年 = [2023, 2024, 2025]
```

### 研发项目时间约束
```
RD项目开始时间 >= 近三年第一年1月1日
RD项目结束时间 <= 申报年份12月31日
RD项目可以跨年度（如2024-04-01 ~ 2025-02-28）
RD项目必须覆盖近三年（每年至少有1个项目在执行）
```

### 立项报告时间约束
```
立项报告中的时间节点必须在RD项目时间范围内
阶段性成果的时间描述必须与RD项目时间一致
```

## 数据关联查找逻辑

### 1. 从RD表查找项目信息
```python
def find_rd_project(rd_id, rd_table):
    """
    从RD表中查找指定RD编号的项目信息
    rd_id: str，如"RD01"
    rd_table: DataFrame，RD表数据
    """
    project = rd_table[rd_table['研发活动编号'] == rd_id]
    if project.empty:
        raise ValueError(f"未找到RD编号为{rd_id}的项目")
    return project.iloc[0]
```

### 2. 从IP表查找关联知识产权
```python
def find_related_ips(ip_ids, ip_table):
    """
    从IP表中查找关联的知识产权信息
    ip_ids: list，如["IP01", "IP02"]
    ip_table: DataFrame，IP表数据
    """
    related_ips = ip_table[ip_table['知识产权编号'].isin(ip_ids)]
    return related_ips
```

### 3. 从成果转化表查找关联成果
```python
def find_related_achievements(rd_id, achievement_table):
    """
    从成果转化表中查找与RD项目关联的成果
    rd_id: str，如"RD01"
    achievement_table: DataFrame，成果转化表数据
    """
    achievements = achievement_table[achievement_table['关联RD'].str.contains(rd_id, na=False)]
    return achievements
```

### 4. 内容提取逻辑
```python
def extract_content_for_report(rd_project, ip_table, achievement_table):
    """
    从RD项目、IP表、成果转化表中提取立项报告所需内容
    """
    # 提取项目基本信息
    rd_id = rd_project['研发活动编号']
    rd_name = rd_project['研发活动名称']
    start_date = rd_project['开始时间']
    end_date = rd_project['结束时间']
    
    # 提取关联IP信息
    ip_ids = [x.strip() for x in rd_project['知识产权编号'].split(',') if x.strip()]
    related_ips = find_related_ips(ip_ids, ip_table)
    
    # 提取关联成果转化信息
    related_achievements = find_related_achievements(rd_id, achievement_table)
    
    # 提取项目描述内容
    purpose = rd_project['目的及组织实施方式（限400字）']
    tech_innovation = rd_project['核心技术及创新点（限400字）']
    achievements_desc = rd_project['取得的阶段性成果（限400字）']
    
    return {
        'rd_id': rd_id,
        'rd_name': rd_name,
        'start_date': start_date,
        'end_date': end_date,
        'related_ips': related_ips,
        'related_achievements': related_achievements,
        'purpose': purpose,
        'tech_innovation': tech_innovation,
        'achievements_desc': achievements_desc
    }
```

## Word模板批量生成方法论（v1.17.0新增，基于宏日嘉/爱康泉项目经验沉淀）

> **适用场景**：基于Word模板(.docx)批量生成多份RD立项报告时，必须遵循以下方法论，避免反复修改和产出废品。

> **报告书字数原则（v1.19.0新增）**：不同于表格有固定字数上限，立项报告书的字数可以浮动调整。报告书的内容完整性是第一优先级，不得因字数限制而删减必要的技术内容。如果报告某章节内容较长，允许超出字数建议值，以内容完整为准。各章节字数仅为参考范围，非硬性约束。

## 立项书格式模板规范（v1.21.0新增，基于中瑞/派成铝业项目经验）

基于实际项目中对基准模板与生成版本文档的7项格式差异分析，确立以下格式规范。后续所有RD立项书生成与格式化操作均以此为准。

### 模板格式对照表

| # | 格式项 | 规范 | 说明 |
|---|--------|------|------|
| 1 | **项目编号格式** | `{年份}RD{序号}`（如 `2023RD01`） | 含四位年份前缀，与RDPS表编号保持一致 |
| 2 | **首行缩进** | `420 twips`（≈0.74cm） | 对应约2个中文字符宽度；python-docx设置 `paragraph_format.first_line_indent = Cm(0.74)` |
| 3 | **创新点结构化** | "创新点："作为独立标头，后续各点分行列举 | 区别于将创新点内容混在一个段落的方式，提升可读性和审核友好度 |
| 4 | **成员填写规范** | 仅填写项目负责人姓名（如"林毅"），不列全员 | 与模板原格式保持一致，非"精简为1人"而是"仅展现负责人" |
| 5 | **预算表Col1统一** | 第1列统一填写"项目本年度预算支出" | 替代填写具体费用项目名（如"设备费""材料费"），与模板格式对齐 |
| 6 | **审批表并入主表** | 3表结构（主表+日程表嵌套+预算表），审批表合并到主表末尾 | 模板为3表结构，非4表（审批表独立），需通过XML patch将审批行移入主表 |
| 7 | **标黄字段** | 日期、人名、金额等关键变量字段使用黄色高亮（`FFFF00`） | 便于审核快速定位需确认的字段 |

### 格式校验清单

批量生成后必须逐份检查以下7项（参照 `validate_batch_reports()`）：

```
□ 1. 项目编号含年份前缀（如2023RD01，非RD01）
□ 2. 首行缩进为420 twips（≈0.74cm）
□ 3. "创新点："为独立标头，其后各点分行
□ 4. 成员列仅含项目负责人
□ 5. 预算表第1列内容为"项目本年度预算支出"
□ 6. 文档含3个表格（主表+日程表+预算表），审批内容在主表内
□ 7. 日期/人名/金额字段有黄色高亮
```

### 标黄（Highlight）实现

```python
from docx.oxml.ns import qn
from lxml import etree

def apply_highlight(run, color='FFFF00'):
    """对 Run 应用黄色高亮背景"""
    rpr = run._r.get_or_add_rPr()
    highlight = etree.SubElement(rpr, qn('w:highlight'))
    highlight.set(qn('w:val'), color)

def highlight_cell(cell, text, color='FFFF00'):
    """设置单元格文本并标黄"""
    cell.text = ''
    paragraph = cell.paragraphs[0]
    run = paragraph.add_run(text)
    apply_highlight(run, color)
```

### 对比先行工作流

当用户提供基准模板（优化版）时，必须遵循以下流程：

```
1. 读取基准文件 → 分析结构（analyze_template_structure）
2. 生成新版文档（禁止写入基准文件所在路径）
3. 逐项对比差异 → 生成差异报告（7项格式对照表）
4. 向用户展示差异 → 等待确认
5. 用户确认后 → 批量修改（先试改1份验证 → 批量执行）
6. 校验脚本逐份检查
```

### 1. 模板分析优先原则

**模板优先，先分析再生成**：拿到模板后，第一步不是写生成脚本，而是透彻理解模板结构。

```python
def analyze_template_structure(template_path):
    """完整打印模板的所有表格结构、单元格内容、嵌套关系"""
    from docx import Document
    doc = Document(template_path)

    print("=== 段落分析 ===")
    for i, para in enumerate(doc.paragraphs):
        if para.text.strip():
            print(f"  P{i}: [{para.style.name}] {para.text[:100]}")

    print(f"\n=== 表格分析 (共{len(doc.tables)}个) ===")
    for ti, table in enumerate(doc.tables):
        print(f"\n--- 表格 {ti} ({len(table.rows)}行×{len(table.columns)}列) ---")
        for ri, row in enumerate(table.rows):
            cells_text = []
            for ci, cell in enumerate(row.cells):
                text = cell.text.strip().replace('\n', '|')[:60]
                cells_text.append(f"  [{ri},{ci}] {text}")
                # 检测嵌套表格
                if cell.tables:
                    for sub_ti, sub_t in enumerate(cell.tables):
                        cells_text.append(f"    > 嵌套表{sub_ti}: {len(sub_t.rows)}行×{len(sub_t.columns)}列")
            print('\n'.join(cells_text))
```

**必须确认的信息**：
- 哪些单元格是占位符需要替换（如"【项目名称】"、"【RD编号】"）
- 主表格和嵌套表格的层级关系（`table.rows[row].cells[col].tables[0]`）
- 是否存在合并单元格（纵向vMerge / 横向hMerge）
- 日程表中每行是否需要独立拆分填充

### 2. 合并单元格处理（vMerge XML操作）

**问题**：Word模板中的日程表（进度表）第1列常使用纵向合并单元格（vMerge），`cell.text = "xxx"` 直接设置文本会导致所有合并行显示相同内容。

**LLM必须理解的核心原理**：
- 合并单元格在OOXML中通过 `<w:vMerge>` 标签实现
- 合并列的第一行有 `<w:vMerge w:val="restart"/>`（合并起始）
- 后续行有 `<w:vMerge/>`（合并继续）
- 必须先移除 `<w:vMerge>` 标签解除合并，再为每行创建独立的单元格元素

**不可行的做法**（will NOT work）：
```python
# ❌ 直接设置文本——所有合并行会显示相同内容
schedule_table.cell(0, 0).text = "第一阶段"
schedule_table.cell(1, 0).text = "第二阶段"  # 仍然是"第一阶段"！
```

**正确的做法**（must use XML）：
```python
from lxml import etree

def unmerge_column(table, col_idx):
    """解除表格指定列的所有纵向合并"""
    nsmap = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    for row in table.rows:
        if col_idx >= len(row.cells):
            continue
        tc = row.cells[col_idx]._tc
        # 移除所有 vMerge 标签
        for vm in tc.findall('.//w:vMerge', nsmap):
            vm.getparent().remove(vm)

def set_cell_text_independent(cell, text):
    """为单元格设置文本，确保不受合并影响"""
    # 先清除单元格内容
    for p in cell.paragraphs:
        for run in p.runs:
            run.clear()
    # 写入新内容
    cell.paragraphs[0].add_run(text)
```

### 3. 嵌套表格内容替换

**访问路径**：模板正文嵌套表格的访问路径通过 `table.rows[row].cells[col].tables[0]` 获取。

```python
# 典型场景：主表格第R行第C列包含一个子表格（如日程表/预算表）
main_table = doc.tables[0]
nested_table = main_table.rows[R].cells[C].tables[0]

# 替换嵌套表格中的占位符
for row in nested_table.rows:
    for cell in row.cells:
        if cell.text.strip() == '【费用合计】':
            cell.paragraphs[0].runs[0].text = '500,000'
```

### 4. 模板优先的克隆策略

**绝对不要从零创建文档**：用户要求"只替换内容不改变格式"，所以100%继承模板格式是最安全的方式。

```python
from docx import Document

def generate_rd_report_from_template(template_path, rd_data, output_path):
    """基于模板克隆生成RD立项报告（保留100%原始格式）"""
    # 1. 打开模板（克隆）
    doc = Document(template_path)

    # 2. 替换顶级占位符
    for para in doc.paragraphs:
        if '【RD名称】' in para.text:
            for run in para.runs:
                if '【RD名称】' in run.text:
                    run.text = run.text.replace('【RD名称】', rd_data['rd_name'])

    # 3. 处理主表格
    for table in doc.tables:
        _replace_table_placeholders(table, rd_data)

    # 4. 处理嵌套表格（日程/预算）
    _handle_nested_tables(doc, rd_data)

    # 5. 保存
    doc.save(output_path)
```

### 5. 增量生成策略（1份验证→批量生成）

**项目教训**：15份报告直接批量生成后发现格式问题，需要15次修改。
**正确策略**：先验证1份→确认无误→再跑全部，避免反复修改模板文件。

```
步骤1: 选取RD01作为验证样本，生成1份报告
步骤2: 人工/自动校验该报告的日程拆分、预算合计、审批文本、验收结论
步骤3: 确认无误后，批量生成全部剩余报告
步骤4: 全部生成完后运行校验脚本逐份检查
```

### 6. 全面校验脚本（不可省略）

**项目教训**：批量生成后必须自动校验，避免人工逐份15份文档检查。

```python
def validate_batch_reports(output_dir, rd_data_list):
    """批量校验清单（每项必须通过）"""
    issues = []
    for rd_data in rd_data_list:
        rd_id = rd_data['rd_id']
        doc_path = os.path.join(output_dir, f"{rd_id}_立项报告.docx")
        doc = Document(doc_path)

        # 1. 日程4阶段日期唯一性校验
        schedule_dates = _extract_schedule_dates(doc)
        if len(schedule_dates) != len(set(schedule_dates)):
            issues.append(f"{rd_id}: 日程日期存在重复")

        # 2. 预算合计校验
        budget_items = _extract_budget_items(doc)
        budget_total = _extract_budget_total(doc)
        if abs(sum(budget_items) - budget_total) > 0.01:
            issues.append(f"{rd_id}: 预算合计不一致（分项和{sum(budget_items)} vs 合计{budget_total}）")

        # 3. 审批文本完整性
        if not _has_approval_text(doc):
            issues.append(f"{rd_id}: 缺少审批文本")

        # 4. 验收结论无重复
        conclusions = _extract_conclusions(doc)
        if len(conclusions) != len(set(conclusions)):
            issues.append(f"{rd_id}: 验收结论存在重复")

        # 5. 项目名称跨表一致性
        if not _check_name_consistency(doc, rd_data['rd_name']):
            issues.append(f"{rd_id}: 项目名称跨表不一致")

    return {'passed': len(issues) == 0, 'issues': issues}
```

### 7. 文本字数优化策略（v1.19.0重写）

> **核心原则**：报告书内容完整性优先于字数限制。字数超标时通过优化表述缩减，不得使用算法强制截断。

```python
def optimize_text_length(text, max_chars):
    """通过表述优化将文本缩减到目标字数，而非截断
    优化策略（按优先级）：
    1. 合并重复表述
    2. 精简修饰性词汇
    3. 压缩长句为短句
    4. 上述策略均无法达标→保留原文，标记为字数隐患
    """
    if len(text) <= max_chars:
        return text, None

    optimized = text
    # 策略1：合并重复表述
    optimized = _merge_redundant_phrases(optimized)
    # 策略2：精简修饰词
    optimized = _trim_modifiers(optimized)
    # 策略3：压缩长句
    optimized = _compress_long_sentences(optimized)

    if len(optimized) <= max_chars:
        return optimized, None

    # 无法达标：保留优化后文本，标记为字数隐患（不做截断）
    return optimized, f"优化后仍超出 {max_chars} 字（当前{len(optimized)}字），需人工调整"
```

> **禁止行为**：严禁在任何情况下使用 `s[:N]`、`safe_clip()` 或任何形式的算法强制截断。字数超标时只允许通过优化表述缩减字数。

### §8 XML级格式保持操作（v1.29.0新增）

**核心原则**：填充模板时，通过 XML 层级操作而非 python-docx 高层 API，确保格式 100% 保持。

**技术要点**：

1. **字体保持**：仅替换 `run.text`，不动 `run._element.rPr`（字体/字号/颜色/加粗/斜体全部保留）
   ```python
   # ✅ 正确：只替换文本，格式不动
   run.text = run.text.replace('{{PLACEHOLDER}}', new_text)
   
   # ❌ 错误：重新设置 font 会触发样式层叠覆盖
   run.font.name = '宋体'
   run.text = new_text
   ```

2. **合并单元格处理**：检测 vMerge 后先 XML 解除再逐行填充
   - `vMerge` 有 `restart`（合并起点）和 `continue`（合并延续）两种模式
   - 先移除 `<w:vMerge>` 标签解除合并，再为每行独立填充内容

3. **嵌套表格路径**：先 `analyze_template_structure()` 打印完整层级，再 `cell.tables[0].rows[r].cells[c]` 访问

4. **克隆策略**：永远 `Document(TEMPLATE_PATH)` 克隆，不新建 `Document()`
   - 克隆继承：页面设置（页边距/纸张大小）、样式定义、表格结构、编号列表格式
   - 新建会丢失：所有自定义样式、页面布局

### §9 template_filler.py 模板填充引擎（v1.29.0新增）

**脚本路径**：`{{YFW_SKILLS}}/_common/template_filler.py`

**工作流程**：

```
用户指定模板 / 项目_模板/ / 默认模板
           │
           ▼
   template_filler.py
           │
           ├─ 1. analyze_template_structure() ─ 分析模板（占位符/合并单元格/嵌套表格）
           ├─ 2. Document(template) 克隆 ─ 继承全部格式
           ├─ 3. 遍历 paragraph → 匹配 {{PLACEHOLDER}} → 只替换 text
           ├─ 4. 遍历 table.cells → 解除 vMerge → 填充
           ├─ 5. 遍历嵌套 tables → 递归填充
           ├─ 6. 文本字数优化（不截断，优化表述）
           ├─ 7. 保存输出 docx
           └─ 8. --verify 模式 → 对比模板/产出样式差异
```

**批量生成策略**：
- `--batch` 模式：一次加载模板，循环填充 N 份 RD 数据
- 先验证 1 份（`--verify`），确认格式无误后再批量生成全部
- 批量生成后运行 `validate_rd_report.py --dir` 逐份检查

## 立项决议汇总文档（v1.29.0新增）

**触发时机**：所有 RD 立项报告生成完成后，自动生成立项决议汇总。

**脚本路径**：`{{YFW_SKILLS}}/_common/generate_approval_resolution.py`

**CLI 用法**：

```bash
python {{YFW_SKILLS}}/_common/generate_approval_resolution.py \
  --rd-data "path/to/rd_summary.json" \
  --enterprise "企业名称" \
  --year 2024 \
  --output "输出目录/立项决议汇总.docx"
```

**rd-summary.json 格式**：
```json
[
  {
    "code": "RD01",
    "name": "项目名称",
    "period": "2024.01 - 2024.12",
    "approval_date": "2024.01",
    "resolution": "经评审，该项目技术方案可行，同意立项..."
  }
]
```

**输出文档结构**：
1. 标题《研发项目立项决议汇总表》
2. 信息行（企业名称 / 申报年度 / 科技人员数）
3. 汇总表格（序号 / 项目编号 / 项目名称 / 起止时间 / 决议日期 / 审批结果）
4. 各项决议正文（逐项列出决议内容）
5. 审批人签字栏

## 输出规范

### 立项报告文档
```
文件命名：{企业名称}-{RD编号}-{RD名称}立项报告.docx
示例：云充科技-RD01-快速充电电路研发立项报告.docx

文档结构：

一、项目简介（不少于500字）
   - 项目立项背景
   - 项目研发目的
   - 要求：连贯整段话，描述清晰

二、主要研究内容
   1、项目采用的关键技术（不少于400字）
      - 连贯整段话，描述项目关键研发技术方向
   
   2、主要技术参数指标
      - 分点列出设计技术参数指标
   
   3、项目预期效果及创新性
      - 预期效果（不少于4点）
      - 创新性（不少于4点）
      - 分点列出

三、项目验收总结
   1、项目完成内容（不少于400字）
      - 连贯整段话，描述项目完成的具体内容
   
   2、项目成果
      - 包括知识产权情况
      - 一定要对应资料表格中的知识产权
      - 列出专利号/著作权号和名称
   
   3、项目的核心技术
      - 分点表述，不少于3点
   
   4、技术创新点
      - 分点表述，不少于3点
   
   5、项目产生的综合效益
      - 连贯整段话，不少于300字
      - 描述经济效益、社会效益等
```

## 撰写要求

### 核心撰写原则（必须严格遵守）

#### 1. 内容真实性要求
- **贴近实际**：内容必须贴近公司实际情况，具体资料可参照表格提供的网站等信息来源
- **避免夸大**：不要使用"领先"、"首创"等夸大其词的描述，不要说明任何领先地位
- **谨慎使用AI**：不要轻易使用"AI"等相关描述，除非项目资料中明确显示有"AI"字眼

#### 2. 语言规范要求
- **语言正式**：语言正式，标点符号完整，非必要不使用"（……）"的注释
- **关联IP**：项目的研发内容注意参考关联IP，确保技术内容一致
- **数据谨慎**：审查对数据很敏感，不要随意引用不相关数据，尽量使用概括语句
- **名称完整**：不要出现RD及IP编号，必要时用项目或知识产权名称或内容代替，项目名称、知识产权名称等重要信息引用必须完整不得遗漏

#### 3. 文档结构要求（严格按此结构撰写）

**一、项目简介（不少于500字）**
- 连贯整段话，描述项目立项背景，以及项目的研发目的
- 不要分点，要形成完整的段落

**二、主要研究内容**
1. **项目采用的关键技术（不少于400字）**
   - 连贯整段话，表述项目关键研发技术方向
   - 不要分点，要形成完整的段落

2. **主要技术参数指标**
   - 分点列出设计技术参数指标
   - 每个指标要具体、可量化

3. **项目预期效果及创新性**
   - 预期效果和创新性分开写
   - 分点列出，每部分不少于4点
   - 预期效果：描述项目完成后能达到的效果
   - 创新性：描述项目的技术创新之处

**三、项目验收总结**
1. **项目完成内容（不少于400字）**
   - 连贯整段话，描述项目完成的具体内容
   - 不要分点，要形成完整的段落

2. **项目成果**
   - 包括知识产权情况
   - **一定要对应资料表格中的知识产权**
   - 列出完整的知识产权名称（不要出现编号）

3. **项目的核心技术**
   - 分点表述，不少于3点
   - 每点要具体描述技术内容

4. **技术创新点**
   - 分点表述，不少于3点
   - 每点要突出创新之处

5. **项目产生的综合效益（不少于300字）**
   - 连贯整段话，描述经济效益、社会效益等
   - 不要分点，要形成完整的段落

### 格式要求
1. **字体**：宋体（中文），Times New Roman（英文和数字）
2. **字号**：小四号（12pt）
3. **行距**：1.5倍行距
4. **页边距**：上下2.54cm，左右3.17cm
5. **段落**：首行缩进2字符
6. **标题**：
   - 一级标题：黑体，小三号，加粗
   - 二级标题：黑体，四号，加粗
   - 三级标题：黑体，小四号，加粗

### 字数要求
- 项目简介：≥500字
- 关键技术：≥400字
- 项目完成内容：≥400字
- 综合效益：≥300字
- 预期效果：≥4点
- 创新性：≥4点
- 核心技术：≥3点
- 技术创新点：≥3点

## 数据来源
1. **项目简介**：从RD表的"目的及组织实施方式"字段提取
2. **关键技术**：从RD表的"核心技术及创新点"字段提取
3. **技术参数指标**：从RD表的"核心技术及创新点"字段提取
4. **预期效果及创新性**：从RD表的"核心技术及创新点"字段提取
5. **项目完成内容**：从RD表的"取得的阶段性成果"字段提取
6. **项目成果**：从RD表的"取得的阶段性成果"字段提取，结合知识产权表
7. **核心技术**：从RD表的"核心技术及创新点"字段提取
8. **技术创新点**：从RD表的"核心技术及创新点"字段提取
9. **综合效益**：从RD表的"取得的阶段性成果"字段提取

## 数据一致性检查
1. **项目名称一致性**：立项报告中的项目名称必须与RD表中的项目名称一致
2. **知识产权一致性**：立项报告中提到的知识产权必须与RD表关联的IP一致
3. **技术内容一致性**：立项报告中的技术描述必须与RD表、知识产权表中的描述一致
4. **时间一致性**：立项报告中的时间必须与RD表中的时间一致
5. **经费一致性**：立项报告中的经费必须与RD表中的经费一致

## 工作流程
1. **数据提取**：从RD表中提取项目基本信息
2. **关联查找**：查找关联的IP信息和成果转化信息
3. **内容撰写**：按照文档结构撰写各部分内容
4. **关联检查**：检查与知识产权表、成果转化表的一致性
5. **格式调整**：调整文档格式，确保符合申报要求
6. **字数检查**：检查各部分字数是否符合要求
7. **内容审核**：审核内容的准确性和规范性

### 通过Dify工作流生成RD立项书（可选，v1.11.0新增）

**适用场景**：需要批量生成RD立项书时，可通过Dify工作流平台自动化生成。

**前置条件**：
- 网络可访问Dify工作流API（http://218.17.137.219:9980）
- 已生成TO-AI表格（调用generate_to_ai_excel）
- 已有RD/PS汇总表

**执行步骤**：
1. 调用 `load_dify_config()` 加载配置
2. 调用 `test_dify_workflow_connection()` 测试连接和变量匹配
3. 调用 `generate_rd_report_via_dify(project_root, output_dir)` 完整执行：
   - 动态获取工作流参数（适配工作流更新）
   - 查找本地文件（RD/PS汇总表+TO-AI表格）
   - 匹配本地文件到工作流变量
   - 上传文件到Dify
   - 执行工作流（streaming模式）
   - 下载生成的文档
   - 校验文档质量

**适配机制**：
- 工作流应用更新时（变量增删改、类型变化），只需更新dify_config.json中的映射规则
- 每次执行前动态调GET /parameters获取最新变量定义
- 获取失败时回退到static_variables配置

**配置文件**：`{{YFW_SKILLS}}/_common/dify_config.json`

## 步骤X：生成RD表（v1.18.0新增，立项书产出后同步输出）

> **一张技能两张产出**：gxtz-rd-report 在生成立项书.docx 后，直接从立项书中提取关键字段生成RD表.xlsx。不再需要跨技能调用 gxtz-core-tables 填写RD表。

### 映射规则（立项书 → RD表）

| RD表列 | 映射来源 |
|------|------|
| 研发项目编号 | 立项书编号（RD01-RDxx） |
| 研发项目名称 | 立项书第0节.项目名称 |
| 技术领域 | 从 gxtz-core-tables 传入的RDPS表数据 |
| 开始时间 | 立项书.日程表.第一阶段开始日期 |
| 结束时间 | 立项书.日程表.最后阶段结束日期 |
| 研发经费预算 | 立项书.预算表.合计 |
| 研发经费实际支出 | 同预算（申报阶段预算=实际支出） |
| 项目来源 | 立项书第0节.项目来源 |
| 研发形式 | 立项书第0节.研发形式 |
| 项目组成员 | 立项书第0节.项目组成员 |
| 对应IP编号 | 从 gxtz-core-tables 传入的RDPS匹配结果 |
| 对应PS编号 | 从 gxtz-core-tables 传入的RDPS匹配结果 |

### 生成函数

```python
def generate_rd_table_from_reports(rd_data, report_dir, rdps_match):
    """从立项书中提取关键字段生成RD表
    rd_data: {rd_id: {rd_name, 领域一级, 领域二级, 领域三级, ...}}
    report_dir: 立项书输出目录（含RD01_立项报告.docx等）
    rdps_match: RD-PS-IP匹配结果
    """
    rd_table = []
    for rd_id in sorted(rd_data.keys()):
        rd = rd_data[rd_id]
        report_path = os.path.join(report_dir, f"{rd_id}_立项报告.docx")
        doc = Document(report_path)

        # 从立项书提取关键字段
        report_info = extract_report_fields(doc)

        rd_table.append({
            '研发项目编号': rd_id,
            '研发项目名称': report_info.get('项目名称', ''),
            '技术领域（一级）': rd.get('领域一级', ''),
            '技术领域（二级）': rd.get('领域二级', ''),
            '技术领域（三级）': rd.get('领域三级', ''),
            '开始时间': report_info.get('开始时间', ''),
            '结束时间': report_info.get('结束时间', ''),
            '研发经费预算（万元）': report_info.get('经费预算', 0),
            '研发经费实际支出（万元）': report_info.get('经费预算', 0),
            '项目来源': report_info.get('项目来源', '企业自主研发'),
            '研发形式': report_info.get('研发形式', '企业自有技术'),
            '项目组成员': ', '.join(report_info.get('项目组成员', [])),
            '对应IP编号': ', '.join(rdps_match.get(rd_id, {}).get('ip_ids', [])),
            '对应PS编号': ', '.join(rdps_match.get(rd_id, {}).get('ps_ids', [])),
        })

    # 输出RD表Excel
    save_rd_table(rd_table, os.path.join(report_dir, '..', '00_核心表格', 'RD表.xlsx'))
    print(f'[gxtz-rd-report] RD表已生成：{len(rd_table)}个RD')
    return rd_table
```

### 与 gxtz-core-tables 的交接

gxtz-rd-report 接受 gxtz-core-tables 输出的：
- `{项目}/00_核心表格/RDPS汇总表.xlsx` — RD定义 + IP/PS关联
- `{项目}/00_核心表格/RD-PS-IP关联汇总校验报告.json` — 匹配结果

产出：
- `{项目}/RD立项书/RDxx_立项报告.docx` — 全量立项书
- `{项目}/00_核心表格/RD表.xlsx` — RD表（本步骤新增）

> gxtz-core-tables 不再需要"步骤③ RD表"——该步骤已移入本技能闭环。

## v1.31.0 新增：RD汇总表模板注入

> **从 gxtz-core-tables v1.38.0 剥离**：RD汇总表（企业研究开发活动汇总表）生成职责移入本技能。生成立项报告时同步调用 `template_injector` 注入官方模板输出 RD 汇总表。

### 模板文件

`TemplateInjector` 按两级查找模板：
1. **项目目录**：`00_核心表格/` 下文件名含 **"企业研究开发活动汇总表（近三年执行的活动）"** 的 xlsx 文件
2. **内置模板**（兜底）：`_common/templates/企业研究开发活动汇总表（近三年执行的活动）.xlsx`，随技能包分发

> 项目有自定义模板时优先使用项目模板，无模板时自动使用内置模板。

### 列结构（18列）

| 列号 | 字段名 | 数据来源 |
|------|------|------|
| 1 | 编号 | RD立项报告.RD编号 |
| 2 | 名称 | RD立项报告.项目名称 |
| 3 | 领域一级 | RD立项书.技术领域 |
| 4 | 领域二级 | RD立项书.技术领域 |
| 5 | 领域三级 | RD立项书.技术领域 |
| 6 | 开始时间 | RD立项报告.起止时间 |
| 7 | 结束时间 | RD立项报告.起止时间 |
| 8 | 技术来源 | RD立项书 |
| 9 | IP编号 | RD-IP关联表 |
| 10 | 预算 | RD立项报告.经费预算 |
| 11 | 总支出 | RD立项报告（申报阶段预算=支出） |
| 12 | 第一年 | 按年度拆分 |
| 13 | 第二年 | 按年度拆分 |
| 14 | 第三年 | 按年度拆分 |
| 15 | 人员数 | RD立项报告.项目组成员数 |
| 16 | 目的（限400字） | 立项报告.一、项目简介段落 |
| 17 | 核心技术（限400字） | 立项报告.二、主要研究内容段落 |
| 18 | 阶段成果（限400字） | 立项报告.三、项目验收总结段落 |

### 下拉约束（template_injector 内置校验）

> 以下列有固定可选值，`TemplateInjector.inject_rd_table()` 内置 `RD_DROPDOWNS` 校验。不符合有效选项的值将打印 WARNING 但保留原值（不阻断注入），需人工确认后修正。

| 列序 | 列名 | 有效取值 |
|------|------|---------|
| 8 | 技术来源 | 大专院校 / 地方属科研院所 / 其它企业技术 / 引进技术本企业消化创新 / 国外技术 / 企业自有技术 / 中央属科研院所 |

### 调用方式

```python
from _common.template_injector import TemplateInjector

injector = TemplateInjector(
    template_dir="00_核心表格",
    output_dir="_output",
    enterprise_name=enterprise
)

rd_data = [
    {
        "编号": "RD01",
        "名称": "xxx研发",
        "领域一级": "新能源与节能",
        "领域二级": "高效节能技术",
        "领域三级": "工业节能技术",
        "开始时间": "2023/01/03",
        "结束时间": "2023/05/31",
        "技术来源": "企业自有技术",
        "IP编号": "IP02",
        "预算": "48",
        "总支出": "55.09",
        "第一年": "55.09",
        "第二年": "",
        "第三年": "",
        "人员数": "5",
        "目的": "目的：xxx...",
        "核心技术": "核心技术：xxx...",
        "阶段成果": "2023年1-3月..."
    },
]

result_path = injector.inject_rd_table(rd_data)
```
> ⛔ **强制约束**：RD汇总表必须通过 `TemplateInjector.inject_rd_table()` 生成，禁止 agent 自行从零拼表。内置模板自动兜底，不存在模板缺失理由。

### 数据采集来源

- **RD编号/名称/日期/人员/预算** ← RD立项报告
- **技术领域（一级/二级/三级）** ← RD立项书
- **IP编号** ← RD-IP关联表
- **目的/核心技术/阶段成果** ← 立项报告对应段落

### 禁止事项

- **禁止 agent 从零生成表格**：必须使用 `template_injector` 注入官方模板，不得自行创建 xlsx
- 日期格式必须统一为 `YYYY/MM/DD`，由 `template_injector` 自动设置 number_format
- 目的/核心技术/阶段成果三列有 400 字限制，`template_injector` 超标仅打印 WARNING 不截断

## 常见问题处理
1. **字数不足**：补充技术细节，扩展描述内容
2. **内容重复**：调整各部分内容的侧重点，避免重复
3. **技术描述不清**：参考知识产权表中的摘要和先进性说明
4. **成果描述不全**：补充所有关联的知识产权成果
5. **格式不规范**：严格按照格式要求调整
6. **日程表合并单元格内容重复**（v1.17.0新增）：使用 `unmerge_column()` 解除vMerge再逐行填充 → 参见"Word模板批量生成方法论 §2"
7. **嵌套表格访问报错**（v1.17.0新增）：先调用 `analyze_template_structure()` 分析嵌套层级，再通过 `table.rows[row].cells[col].tables[0]` 访问 → 参见"Word模板批量生成方法论 §3"
8. **长文本字数超标**（v1.19.0重写）：使用 `optimize_text_length()` 通过合并重复表述、精简修饰词、压缩长句等方式优化缩减字数，严禁使用 `s[:N]` 或 `safe_clip()` 硬截断 → 参见"Word模板批量生成方法论 §7"
9. **模板格式在保存后变化**（v1.17.0新增）：使用 `Document(TEMPLATE)` 克隆模板而非从零创建，确保字体/字号/页边距/表格样式100%继承 → 参见"Word模板批量生成方法论 §4"
10. **缩进值不匹配**（v1.21.0新增）：python-docx 的 `first_line_indent` 使用 EMU 单位，模板 OOXML 存储 twips，换算比 1:635。设置缩进时直接使用 `Cm(0.74)` 对应420 twips → 参见"OOXML技术要点 §twips与EMU"
11. **合并单元格后格式丢失**（v1.21.0新增）：`cell.merge()` 后段落样式不自动继承，需在合并后重新设置 `paragraph_format` 和字体 → 参见"OOXML技术要点 §python-docx常见坑点"
12. **批量操作误伤基准文件**（v1.21.0新增）：批量脚本运行前必须确认操作范围不包含用户指定的基准文件，批量路径与基准路径分离 → 参见"质疑审查机制 §禁止行为"

## 模板文件与示例输出

### 模板选择优先级（三级）

```
1. 用户显式指定的过往项目立项报告路径（最高优先级）
   → 用户说"用XX项目的RD报告作模板"时，以用户指定为准
   → 该模板仅用于格式参照，内容全部替换为新项目数据
   
2. 项目根目录 _模板/ 目录下的 .docx 文件
   → 自动扫描 _模板/ 下所有 .docx 文件
   → 优先选择文件名含"立项报告"或"RD"关键词的文件
   
3. 技能包内置默认模板 templates/default_rd_template.docx（fallback）
   → 当上述两级均无可用模板时，自动使用内置默认模板
   → 默认模板结构（基于标准高企立项报告）：
     Table[0] 立项报告主表（24行×9列）:
       Row 0: 项目名称 → {{project_name}}
       Row 1: 申报单位 → {{company_name}} / {{project_year}} / {{count_no}}
       Row 2: 项目经费 → {{budget}}
       Row 3: 起止时间 → {{start_date_cn_text}} ~ {{finish_date_cn_text}}
       Row 4: 负责人 → {{leader}}
       Row 5: 一、立项目的（标题行）
       Row 6: {{project_intro}}
       Row 7: 项目核心技术及创新点（标题行）
       Row 8: {{tech_innovation_p1}} ~ {{tech_innovation_p4}}（4段技术创新）
       Row 9-13: 三、项目实施计划进度安排（含时间/阶段子表）
       Row 14-18: 四、项目研究人员配备（含序号/职务/任务/人员子表）
       Row 19-20: 五、项目费用预算 → {{budget}}
       Row 21-23: 六、项目审批意见（部门审批/公司意见）
     Table[1] 项目验收报告（6行×3列）:
       Row 0: 编号 → YuanFang{{project_year}}-{{count_no}}
       Row 1: 项目名称 → {{project_name}}
       Row 2: 负责人 → {{leader}}
       Row 3: 验收内容 → {{finish_date_cn_text}}/{{project_name}}/{{project_deliverables}}/{{project_achievements}}/{{tech_innovation}}/{{comprehensive_profits}}/{{expenses}}/{{labor_costs}}/{{ip_count}}
       Row 4-5: 审查意见/日期
     段落占位符: {{project_year_cn}}（中文年份）
   → 路径：{{YFW_SKILLS}}/gxtz-rd-report/templates/default_rd_template.docx
```

**无论哪种模板，统一走 `template_filler.py` 填充引擎**，保证格式100%保持。

### 模板填充引擎 (template_filler.py)

**核心脚本**：`{{YFW_SKILLS}}/_common/template_filler.py`

**CLI 用法**：

```bash
# 单文件模式
python {{YFW_SKILLS}}/_common/template_filler.py \
  --template "path/to/template.docx" \
  --data "path/to/data.json" \
  --output "path/to/output.docx" \
  --verify \
  --verbose

# 批量模式（一次模板多次填充，适合所有RD统一格式）
python {{YFW_SKILLS}}/_common/template_filler.py \
  --template "path/to/template.docx" \
  --data "path/to/rd_data_list.json" \
  --output-dir "path/to/output_dir/" \
  --batch \
  --verify \
  --verbose
```

**data.json 格式**（单文件模式，21个占位符）：
```json
{
  "project_name": "项目名称",
  "company_name": "企业名称",
  "project_year": "2023",
  "project_year_cn": "二〇二三",
  "count_no": "01",
  "budget": "80",
  "start_date_cn_text": "2023年1月1日",
  "finish_date_cn_text": "2023年12月31日",
  "leader": "项目负责人",
  "project_intro": "一、立项目的及意义内容...",
  "tech_innovation_p1": "关键技术1...",
  "tech_innovation_p2": "关键技术2...",
  "tech_innovation_p3": "关键技术3...",
  "tech_innovation_p4": "技术创新总结...",
  "project_deliverables": "项目完成内容...",
  "project_achievements": "项目成果（知识产权/技术成果/经济效益）...",
  "tech_innovation": "核心技术及创新点...",
  "comprehensive_profits": "综合效益...",
  "expenses": "20",
  "labor_costs": "30",
  "ip_count": "3"
}
```

**格式保持原理**：
1. `Document(TEMPLATE)` 克隆模板 — 继承全部页面设置和样式
2. 遍历 paragraph.runs — 只替换 text 不动 run.font/run._element
3. 遍历 table.cells — 先解除 vMerge 合并再填充
4. 递归遍历嵌套表格 — 记录层级路径后逐层填充
5. `--verify` 模式 — 对比模板/产出字体/字号/颜色/加粗差异

### 模板文件查找规则
1. 优先查找项目目录下 `_模板/` 子目录中的 `.docx` 文件
2. 其次查找用户指定的模板路径
3. 模板文件仅允许以 `read-only` 方式读取，禁止任何写入

### 参考案例
以下案例文件用于格式参考（禁止修改）：
- 云充科技2021年研发立项报告（RD01-RD08）
- 云充科技2022年研发立项报告（RD09-RD14）
- 云充科技2023年研发立项报告（RD15-RD21）
- 派成铝业近三年开发情况说明（IP表编号化+RD表成果转化情况列的标准格式参考）

## 模块六：PDF拆分与OCR处理
> 详见脚本: {{YFW_SKILLS}}/_common/pdf_splitter.py
> CLI: `python pdf_splitter.py detect --file <path>` | `python pdf_splitter.py split --file <path> --method content_type`


## 模块七：文件分类整理
> 详见脚本: {{YFW_SKILLS}}/_common/file_content_classifier.py + {{YFW_SKILLS}}/_common/filing_mapper.py
> CLI: `python file_content_classifier.py classify --dir <目录>` | `python filing_mapper.py organize --dir <目录>`


## 模块八：政策合规校验
> 详见脚本: {{YFW_SKILLS}}/_common/policy_compliance.py
> CLI: `python policy_compliance.py validate --project-root <路径> --region shenzhen`


## 模块九：企业信息联网搜索
> 详见脚本: {{YFW_SKILLS}}/_common/enterprise_info_search.py
> CLI: `python enterprise_info_search.py search --enterprise "企业名"` | `python enterprise_info_search.py enrich --project-root <路径>`


## 输出隐患自查与汇报（v1.20.0升级，技能结束时强制执行）

> **强制要求**：生成立项书和RD表后，agent 必须按以下7个维度进行隐患自查，并将隐患点明确汇报给用户。

### 立项书隐患自查清单

| 维度 | 检查项 | 表现 |
|------|------|------|
| **1. 原始资料缺失** | 立项书模板文件是否存在 | 模板路径无效或文件缺失 |
| | 依赖的RDPS表/IP表文件是否存在 | 无法读取上游表格数据 |
| **2. 文本质量** | 各章节是否有空白占位符 | 存在"【待补充】""TBD"等标记 |
| | 技术内容是否有实质描述 | 纯套话无具体技术参数 |
| | 是否存在AI痕迹 | 重复句式、"显著提升""国际先进"等空泛词汇 |
| **3. 逻辑关联** | RD名称是否与RDPS表一致 | 立项书中RD名称≠RDPS表中RD名称 |
| | IP编号/名称是否与IP表一致 | 立项书成果章节IP信息与IP表不符 |
| | 预算合计是否等于各科目分项之和 | 预算汇总≠各科目累加 |
| **4. 字数问题** | 立项书各章节字数是否在参考范围内 | 字数偏离参考值较大（报告书字数浮动，内容完整性优先，仅标记不强制修改） |
| | 报告书内容是否有被不当压缩 | 因字数限制删减了必要技术内容 |
| **5. 文档格式** | 日期格式是否统一 | 存在多种日期格式 |
| | 预算金额格式是否规范 | 万元/元混用 |
| | 审批文本是否完整 | 审批意见空白或只有模板文字 |
| **6. 政策符合性** | RD项目是否符合高新领域要求 | RD所属技术领域不在高新八大领域内 |
| | 项目人员是否满足科技人员条件 | 立项书中的项目组成员未在科技人员清单中 |
| | 研发周期是否合理 | 研发周期过短（<6个月）且无说明 |
| **7. 数据可溯源性** | 立项书中的预算数据能否追溯到RDPS表 | 预算数据来源不明 |
| | 项目名称/编号是否与RDPS表一致 | 无法追溯确认 |

### RD表隐患自查清单

| 维度 | 检查项 |
|------|------|
| **数据完整性** | RD表15列是否全部填充 |
| **映射正确性** | 立项书→RD表的13项映射是否正确 |
| **关联完整性** | 每个RD是否关联了IP和PS |
| **政策符合性** | RD经费实际支出是否与专审报告一致 |

### 汇报格式

```
⚠️ gxtz-rd-report 输出隐患自查报告

【立项书】
1. 原始资料: ✓ / ⚠ {n}项缺失
2. 文本质量: ✓ / ⚠ {n}处隐患
3. 逻辑关联: ✓ / ⚠ {n}处不一致
4. 字数: ✓ / ⚠ {n}章偏离参考值
5. 文档格式: ✓ / ⚠ {n}处不规范
6. 政策符合性: ✓ / ⚠ {n}项不合规
7. 数据溯源: ✓ / ⚠ {n}字段无来源

【RD表】
数据完整性: ✓ / ⚠
映射正确性: ✓ / ⚠

待用户确认后进入下一步。
```


---

<!-- SECTION_BEGIN: provenance_verification v2.7 -->
## 溯源核验 → 详见 {{YFW_SKILLS}}/_common/SHARED_provenance.md
> 所有关键字段值必须与源文件精确一致，禁止改写。调用: set_provenance() → scan_and_correct()
<!-- SECTION_END: provenance_verification -->

---

<!-- SECTION_BEGIN: authoritative_terms_verification v2.6 -->
## 权威术语核验 → 详见 {{YFW_SKILLS}}/_common/SHARED_authoritative_terms.md
> 输出前强制扫描权威术语。禁止: "新能源及节能"(应为"与")等变异。调用: scan_and_correct()
<!-- SECTION_END: authoritative_terms_verification -->
