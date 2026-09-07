---
name: "gxtz-management-materials"
description: "高新技术企业认定管理制度及证明材料撰写，包括研发制度、辅助账、产学研合作等。当用户提到管理制度、研发制度、研发机构、产学研合作、成果转化激励、研发辅助账时调用此技能。v1.26.0新增：提示词驱动制度条款内容生成+质量复查步骤。v1.25.0新增：OneDrive占位符双路径输出+旧制度模板残留审查+用户格式偏好确认+研发机构简介别名映射+专精特新OCR复用+日期策略参数化。"
version: "1.26.0"
triggers:
  - "管理制度"
  - "研发制度"
  - "研发机构"
  - "产学研合作"
  - "成果转化激励"
  - "研发辅助账"
  - "研发费用台账"
---

## 角色定位

> **你是"高新技术企业认定项目老师"**。服务于用户（项目人员），不直接面向客户企业。
> 完整角色定义（三角关系模型/专业领域/能力边界/决策权限/沟通准则）详见 `{{YFW_SKILLS}}/_common/agent_role.md`。

<!-- SECTION_BEGIN: tech_stack_reference -->
## 技术栈引用 → 详见 {{YFW_SKILLS}}/_common/SHARED_tech_stack.md
> 处理文档前先查表 doc_toolkit.py info，禁止自行尝试不同库。
<!-- SECTION_END: tech_stack_reference -->

<!-- SECTION_BEGIN: ocr_reference -->
## OCR能力引用 → 详见 {{YFW_SKILLS}}/_common/SHARED_ocr_reference.md
> PDF混合型必须用 --mode auto。扫描件用RapidOCR(ONNX)。
> ⚠️ OCR强制铁律：见 {{YFW_SKILLS}}/_common/SHARED_ocr_mandatory.md（先OCR后操作，禁止猜测，必须等待）
<!-- SECTION_END: ocr_reference -->

<!-- SECTION_BEGIN: no_ai_watermark -->
## 输出资料合规规则 → 详见 {{YFW_SKILLS}}/_common/SHARED_no_ai_watermark.md
> 禁止AI水印。文档版本管理: 旧版.bak备份。
<!-- SECTION_END: no_ai_watermark -->

<!-- SECTION_BEGIN: v1_25_0_new_features -->
## v1.26.0 核心架构变更：制度条款内容提示词驱动生成 + 质量复查

> **背景**：此前管理制度采用函数模板拼接（`generate_rd_organization_system()` 等），章节结构、条款文字在函数中硬编码，仅企业名/人数/金额等变量来自数据。这导致不同企业的制度内容高度雷同，缺乏企业特色。
> **v1.26.0 改造**：制度文档的主体条款内容由 agent 结合企业实际数据按提示词生成，保留模板化的章节结构和格式框架。

### 改造范围（7项制度）

| 制度 | 生成方式 | agent 需结合的企业数据 |
|------|---------|---------------------|
| 研发组织管理制度 | 提示词生成制度条款 + 模板注入章节结构 | 企业组织架构、研发人员数量、研发场地面积 |
| 研发投入核算制度 | 提示词生成核算条款 + 模板注入框架 | 研发费用总额、八大类费用分布、审计报告数据 |
| 三年研发费用辅助账 | 纯算法生成（表格型） | RD表费用数据，禁止提示词编造 |
| 研发机构成立文件 | 提示词生成机构说明 + 模板注入框架 | 设备清单、研发场地、人员配置、机构名称 |
| 产学研合作制度 | 提示词生成合作条款 + 模板注入框架 | 企业实际合作情况（无则说明规划方向） |
| 成果转化激励制度 | 提示词生成激励条款 + 模板注入框架 | 企业知识产权数量、成果转化数量 |
| 科技人员培养制度 | 提示词生成培养条款 + 模板注入框架 | 科技人员数量、培训记录、人才引进计划 |

### 生成提示词（每项制度独立运行）

> agent 为每项制度生成条款内容时，必须结合以下要求：

```
根据提供的企业资料，撰写{制度名称}的条款内容，要求：
1. 条款内容必须贴近企业实际情况，引用企业真实数据（人员数量/费用金额/设备清单等）
2. 条款结构参照《高新技术企业认定管理办法》中对应制度的标准框架
3. 语言正式规范，不使用"领先"、"首创"等夸大词汇
4. 不编造无数据支撑的内容，无数据则标注"待制定"或"规划中"
5. 每项制度8-12条条款，每条100-200字
```

### 质量复查步骤（v1.26.0新增）

生成 7 项制度后，agent 必须逐项执行以下复查：

| # | 复查项 | 检查方法 |
|---|--------|---------|
| 1 | 企业数据溯源 | 每条引用的数字（人数/金额/面积）追溯回原始文件 |
| 2 | 旧制度模板残留 | 全文搜索其他公司名称（"锐恩微电子"等） |
| 3 | 日期合理性 | 制定/修订日期分布合理，不集中同一天 |
| 4 | 制度间一致性 | 同一数据（如研发人数）在多项制度中一致 |
| 5 | 高新政策符合 | 制度内容覆盖高新认定要求的 7 项制度清单全量 |
| 6 | AI 痕迹检查 | 无明显的 AI 生成套路句（"在当今竞争激烈的市场环境中"等） |
| 7 | 编号/名称泄露 | 制度文档中不出现 RD/IP/PS 编号 |

### 禁止事项（v1.26.0新增）

- **禁止函数模板拼接**：不得使用预硬编码的 `generate_rd_organization_system()` 等函数生成制度内容
- **禁止跨企业复制**：每项制度必须基于当前企业数据独立生成
- **禁止编造合作方**：产学研合作制度中提到的合作院校/机构必须是企业真实合作的（无则标注"规划中"）

<!-- SECTION_END: v1_26_0_new_features -->

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
> 关键决策点强制交叉验证。
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

- 脚本路径必须使用绝对路径
- 参数必须按脚本定义的 CLI 接口传递
- 不得通过"调用 xxx() 函数"的形式执行（函数描述不是可执行命令）

## 审核验证标准（agent 必须执行且通过）

### 审核脚本调用

最后一步必须执行对应的审核验证脚本：

```
python {{YFW_SKILLS}}/_common/validate_management.py --dir "输出目录" --project-root "项目根目录"
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

# 管理制度及证明材料撰写

## 描述
本技能用于撰写高新技术企业认定所需的管理制度文档及整理相关证明材料，包括研发组织管理制度、研发投入核算体系、研发费用辅助账、研发机构设立文件、产学研合作证明、科技成果转化激励制度、科技人员培养制度等。

## 使用场景
- 用户提到"管理制度"、"研发制度"、"研发机构"
- 用户需要撰写或修改研发组织管理制度、研发投入核算体系
- 用户提到"产学研合作"、"成果转化激励"、"人员培养制度"
- 用户提到"研发辅助账"、"研发费用台账"

## 统一输出目录规范

本技能生成的文件必须统一存放到项目输出根目录下，便于用户查看操作。

### 输出根目录
`{企业名称}_高新认定材料_{申报年份}/`

统一目录结构：00_核心表格 / 01_研发立项报告 / 02_知识产权证明 / 03_成果转化证明 / 04_高新产品证明 / 05_科技人员材料 / 06_管理制度材料 / 07_资料收集清单 / _校验报告

### 本技能输出子目录
`06_管理制度材料/`（校验/审核报告输出到 `_校验报告/`）

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

### 第零步完：确认进度依赖（v1.x.1新增，进度管理集成）

在开始工作前，检查本技能的前置阶段是否已完成：

```bash
python {{YFW_SKILLS}}/_common/progress_sync.py check-deps /n    --project-root "." /n    --skill "gxtz-management-materials"
```

若返回 WARNING 提示存在未完成的前置阶段，agent 应提示用户先完成前置依赖。

> 进度管理集成说明详见: `{{YFW_SKILLS}}/gxtz-progress-manager/SKILL.md`


### 第一步：项目初始化（强制执行，不可跳过）

**执行以下命令初始化项目知识库**（在项目根目录运行）：

```bash
python {{YFW_SKILLS}}/_common/project_context_manager.py init --enterprise "{企业名称}" --year {申报年份}
```

此命令将创建 .claude/file_map.json、.claude/experience_base.json、.claude/project_index.json 并扫描项目文件分类到19类。

1. 在 .trae 目录创建 file_map.json（含enterprise/application_year/files字段）
2. 创建 experience_base.json（含enterprise/skill_executions字段）
3. 创建 project_index.json（含enterprise/application_year/skills_progress字段）
4. 扫描项目目录所有文件，按19类目录结构分类填充 file_map.json
5. 3个json文件必须生成，否则后续步骤无法正常工作

**初始化后读取**：读取 file_map.json 了解已有文件分布，读取 experience_base.json 获取历史经验。

**补充资料检查与整理**：
6. 调用 `generate_supplement_checklist(enterprise_name, application_year, 'gxtz-management-materials')` 生成/更新补充资料清单文档
7. 调用 `scan_supplement_dir(enterprise_name, application_year, 'gxtz-management-materials')` 扫描补充资料目录：
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

### 第一步：撰写企业研究开发组织管理制度
1. 创建Word文档
2. 撰写总则：目的、适用范围、基本原则
3. 撰写研发组织机构：研发中心设置、职责
4. 撰写研发项目管理：立项流程、实施管理、验收评审
5. 撰写研发人员管理：人员配置、培训、考核
6. 撰写研发经费管理：经费预算、使用、监督
7. 撰写知识产权管理：申请、维护、奖励
8. 保存文档，命名格式：{企业名称}-企业研究开发组织管理制度.docx

### 第二步：撰写研发投入核算管理制度
1. 创建Word文档
2. 撰写总则：目的、适用范围、核算原则
3. 撰写研发费用归集范围：八大类费用详细说明
4. 撰写研发费用核算流程：费用归集、分配、核算、审核
5. 撰写研发费用辅助账编制要求
6. 保存文档，命名格式：{企业名称}-研发投入核算管理制度.docx

### 第三步：编制三年研发费用辅助账
1. 为近三年每年创建Excel文件
2. 创建9个Sheet：人员人工费用、直接投入费用、折旧费用与长期待摊费用、无形资产摊销费用、设计费用、装备调试费用与试验费用、委托外部研究开发费用、其他费用、研发费用汇总表
3. 填写各年度研发费用明细
4. 保存文件，命名格式：{企业名称}-{年份}年研发费用辅助账.xlsx

### 第四步：撰写研发机构成立文件
1. 创建Word文档
2. 撰写成立背景：企业发展需求、创新能力提升
3. 撰写研发机构名称与地址
4. 撰写研发机构职责：技术研发、产品开发、成果转化、人才培养
5. 撰写研发场地及设备：场地面积、设备清单、设备总值
   - **v1.5.0新增**：如果研发设备清单来自固定资产清单筛选（`load_enterprise_data()` 未找到独立研发设备清单，而通过 `filter_rnd_equipment_from_fixed_assets()` 从固定资产清单筛选），在研发机构成立文件的"四、研发场地及设备"章节中注明"设备清单基于固定资产清单筛选"，并附设备总数、总值及筛选来源文件，确保材料可溯源
   - **v1.6.0新增**：撰写研发机构成立文件前，必须先调用 `validate_equipment_in_fixed_assets(equipment_list_from_system, fixed_asset_file)` 校验本次申报设备清单中的每台设备是否都在固定资产清单中有对应记录
   - **v1.6.0新增**：如果有往年制度文件（如"企业内部科学技术研究开发机构并具备相应科研条件、与国内外研究开发机构开展多种形式的产学研合作.pdf"），先调用 `load_equipment_from_pdf(pdf_path)` 提取往年设备清单，再与本次固定资产清单校验（往年清单中的设备也需在本次固定资产清单中有对应记录）
   - **v1.6.0新增**：根据校验报告处理：
     - 未匹配的设备（unmatched_count 中包含的设备）：需在研发机构成立文件中标注说明（如"该设备已于XX年报废/转让"），或直接从设备清单中剔除
     - 部分匹配的设备（partial_count 中包含的设备）：人工复核后决定是否保留
     - 已匹配的设备：可直接写入研发机构成立文件
   - **v1.6.0新增**：在研发机构成立文件的"四、研发场地及设备"章节中注明校验结果，例如"经核对，本次申报的32项研发设备全部在固定资产清单中有对应记录"，并附校验报告路径，确保材料可溯源
6. 撰写研发人员配置：人员数量、学历结构、职称结构
7. 保存文档，命名格式：{企业名称}-研发中心成立文件.docx

### 第五步：撰写产学研合作管理制度
1. 创建Word文档
2. 撰写总则：目的、适用范围、合作原则
3. 撰写合作形式：联合研发、技术转让、技术咨询、技术服务
4. 撰写合作流程：需求提出、合作方选择、合同签订、项目实施、成果验收
5. 撰写合作成果管理：成果归属、收益分配、知识产权管理
6. 保存文档，命名格式：{企业名称}-产学研合作管理制度.docx

### 第六步：撰写科技成果转化激励制度
1. 创建Word文档
2. 撰写总则：目的、适用范围、激励原则
3. 撰写激励对象：研发人员、成果转化人员、管理人员
4. 撰写激励方式：奖金、股权、晋升、荣誉
5. 撰写激励标准：根据转化效果、经济效益设定标准
6. 撰写激励流程：申请、评审、审批、发放
7. 保存文档，命名格式：{企业名称}-科技成果转化激励制度.docx

### 第七步：撰写科技人员培养制度
1. 创建Word文档
2. 撰写总则：目的、适用范围、培养原则
3. 撰写培养目标：短期目标、中期目标、长期目标
4. 撰写培养方式：内部培训、外部培训、学术交流、项目实践
5. 撰写培养内容：专业知识、技能提升、创新能力、管理能力
6. 撰写培养考核：考核标准、考核方式、考核结果应用
7. 保存文档，命名格式：{企业名称}-科技人员培养制度.docx

### 第八步：整理相关证明材料
1. 整理研发机构成立证明材料：场地照片、设备清单、人员配置
2. 整理产学研合作证明材料：合作协议、项目成果、付款凭证
3. 整理科技人员培训证明材料：培训计划、培训记录、培训证书
4. 整理科技成果转化证明材料：转化合同、发票、产品说明

### 第九步：数据一致性校验
1. 验证制度中的人员数量与科技人员表一致
2. 验证制度中的设备数量与研发设备清单一致
3. 验证制度中的场地面积与企业信息一致
4. 验证研发费用数据与RD表、辅助账一致
5. 生成《管理制度数据校验报告》

### 第十步：审核验证（必须通过才能提交）
1. **完整性审核**
   - 检查7项管理制度是否都已撰写（研发组织管理、研发投入核算、产学研合作、成果转化激励、科技人员培养）
   - 检查三年研发费用辅助账是否都已编制（2023-2025年）
   - 检查研发机构成立文件是否已撰写
   - 检查相关证明材料是否都已整理

2. **一致性审核**
   - 验证制度中的人员数量与科技人员表一致
   - 验证制度中的设备数量与研发设备清单一致
   - 验证制度中的场地面积与企业信息一致
   - 验证研发费用数据与RD表、辅助账一致
   - 验证产学研合作合同时间在近三年内

3. **设备清单校验审核（v1.6.0新增）**
   - 调用 `validate_equipment_in_fixed_assets(equipment_list_from_system, fixed_asset_file)` 验证研发设备清单中的每台设备都在固定资产清单中有对应记录
   - 校验返回值中 `unmatched_count` 应为 0（所有设备均已匹配）；若 `unmatched_count > 0`，审核不通过，需返回第四步处理未匹配设备
   - 校验返回值中 `partial_count` 需人工复核确认，并在审核报告中记录复核结论
   - 如有往年制度文件，调用 `load_equipment_from_pdf(pdf_path)` 提取的往年设备清单也需通过校验（`unmatched_count` 应为 0）
   - 在《管理制度及证明材料审核报告》中附设备校验报告（含 total_count、matched_count、unmatched_count、partial_count 及 details 明细）

4. **规范性审核**
   - 检查文件命名是否符合规范（调用 `detect_naming_issues()` 检测hash命名/微信图片/扫描仪/手机/WPS拼图/多次优化/大小写不一致/学历不统一等问题，调用 `batch_validate_naming()` 批量校验IP/RD/PS/成果转化/财务/网报/学历/社保命名规范）
   - 检查辅助账Excel格式是否正确（9个Sheet）
   - 检查研发费用数据是否完整覆盖近三年
   - 检查文件格式是否符合要求（Word/Excel）

5. **内容完整性审核**
   - 验证研发组织管理制度包含：组织机构、项目管理、人员管理、经费管理、知识产权管理
   - 验证研发投入核算制度包含：八大类费用、核算流程、辅助账编制要求
   - 验证研发机构成立文件包含：场地面积、设备清单、人员配置
   - 验证产学研合作制度包含：合作形式、流程、成果管理

6. **生成审核报告**
   - 生成《管理制度及证明材料审核报告》
   - 列出所有审核问题及整改建议
   - 审核结论：通过/不通过

7. **审核通过条件**
   - 所有制度文件齐全
   - 数据一致性检查通过
   - **设备清单校验通过（v1.6.0新增）**：研发设备清单中所有设备在固定资产清单中均有对应记录（`unmatched_count == 0`）
   - 辅助账覆盖近三年
   - 内容完整规范

8. **审核不通过处理**
   - 列出所有问题清单
   - 提供整改建议
   - 要求整改后重新提交审核

### 最终步前：同步进度（v1.x.1新增，进度管理集成）

完成所有工作后、文件整理前，更新进度看板：

```bash
python {{YFW_SKILLS}}/_common/progress_sync.py update-stage /n    --project-root "." /n    --skill "gxtz-management-materials" /n    --status completed
```

此命令将自动匹配本技能对应的阶段并标记为"已完成"。
（注意：finalize 步骤也会自动同步进度，此步为双重保障。）


### 最终步：文件整理与知识库更新（强制执行，审核验证通过后必须执行）

**执行以下命令整理文件并更新知识库**（在项目根目录运行）：

```bash
python {{YFW_SKILLS}}/_common/project_context_manager.py finalize --enterprise "{企业名称}" --year {申报年份} --skill "gxtz-management-materials" --no-move
```

此命令将：按19类目录结构整理文件 → 生成 .claude/_file_management_report.md 整理报告 → 更新 file_map.json / experience_base.json / project_index.json → 校验3个json文件已生成。
- **finalize 后强制验证（v2.0 新增，不可跳过）**：
  1. 立即读取 `.claude/_finalize_diff.json`，检查 `moved_from_protected`（应为空）和 `warnings`（应为空）
  2. `ls` 扫描 06_管理制度材料（至少5个文件），确认文件数不少于预期
  3. 若 `moved_from_protected` 非空或目录文件减少，从 diff 报告的 `to` 位置 Copy-Item 恢复到 `from` 位置
  4. 向用户输出验证结果（✅/⚠ + 具体数字），不得隐藏问题

1. 按19类目录结构整理文件（先检查补充资料目录，将可归类的文件移动到匹配目录）
2. 生成 _file_management_report.md 整理报告（含已归类/未归类/各类别统计/产出校验）
3. 更新 file_map.json（更新文件路径）、experience_base.json（记录本次执行）、project_index.json（更新进度）
4. 校验3个json文件均已生成，如未生成则报错

**清理临时文件**：确保资料目录无Word临时文件（~$开头）和重复文件（(1)后缀等）。

## 工具依赖
```python
# 必需Python库
import openpyxl          # Excel文件读写
from openpyxl import Workbook
from docx import Document  # Word文件读写
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
import pandas as pd       # 数据处理
from datetime import datetime
import os
import shutil

# 文件处理函数
def create_word_document(title, content_sections, output_path):
    """创建Word文档"""
    doc = Document()
    # 设置标题
    heading = doc.add_heading(title, level=1)
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
    
    # 添加内容章节
    for section in content_sections:
        doc.add_heading(section['title'], level=2)
        for para in section['content']:
            p = doc.add_paragraph(para)
            p.paragraph_format.first_line_indent = Cm(0.74)
            p.paragraph_format.line_spacing = 1.5
    
    doc.save(output_path)
    return output_path

def create_auxiliary_accounting(enterprise_name, year, rd_expenses, output_dir):
    """创建研发费用辅助账"""
    wb = Workbook()
    # 创建9个Sheet
    sheets = ['人员人工费用', '直接投入费用', '折旧费用与长期待摊费用', 
              '无形资产摊销费用', '设计费用', '装备调试费用与试验费用',
              '委托外部研究开发费用', '其他费用', '研发费用汇总表']
    
    for idx, sheet_name in enumerate(sheets):
        if idx == 0:
            ws = wb.active
            ws.title = sheet_name
        else:
            ws = wb.create_sheet(title=sheet_name)
        
        # 根据sheet类型填充数据
        if sheet_name == '研发费用汇总表':
            ws.append(['费用类别', '金额（万元）', '占比'])
            for expense_type, amount in rd_expenses.items():
                ws.append([expense_type, amount, f"{amount/sum(rd_expenses.values())*100:.2f}%"])
            ws.append(['合计', sum(rd_expenses.values()), '100%'])
    
    output_path = os.path.join(output_dir, f"{enterprise_name}-{year}年研发费用辅助账.xlsx")
    wb.save(output_path)
    return output_path
```

## 关键时间逻辑
```python
# 时间约束规则
def validate_time_constraints(application_year):
    """验证时间约束"""
    # 近三年定义
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    
    # 制度文件时间要求
    time_rules = {
        '研发费用辅助账': recent_three_years,  # 必须覆盖近三年
        '产学研合作合同': recent_three_years,  # 合同必须在近三年内
        '科技人员培训记录': recent_three_years,  # 培训记录在近三年内
        '研发机构成立文件': None,  # 无时间限制，但需在申报前
        '知识产权管理办法': None,  # 无时间限制
        '成果转化奖励制度': None  # 无时间限制，但需在申报前发布
    }
    
    return {
        'recent_three_years': recent_three_years,
        'time_rules': time_rules,
        'application_year': application_year
    }
```

## 数据关联逻辑
```python
def load_enterprise_data(data_dir, application_year=None):
    """加载企业数据"""
    data = {}
    
    # 1. 加载核心表格数据
    core_tables_file = find_file(data_dir, '*核心表格*.xlsx')
    if core_tables_file:
        data['ip_table'] = pd.read_excel(core_tables_file, sheet_name='IP表')
        data['rd_table'] = pd.read_excel(core_tables_file, sheet_name='RD表')
        data['ps_table'] = pd.read_excel(core_tables_file, sheet_name='PS表')
        data['achievement_table'] = pd.read_excel(core_tables_file, sheet_name='科技成果转化情况表')
    
    # 2. 加载科技人员信息
    staff_file = find_file(data_dir, '*科技人员*.xlsx')
    if staff_file:
        data['staff_table'] = pd.read_excel(staff_file)
    
    # 3. 加载研发费用数据
    expense_file = find_file(data_dir, '*研发费用*.xlsx')
    if expense_file:
        data['expense_data'] = pd.read_excel(expense_file)
    
    # 4. 加载研发设备信息
    equipment_file = find_file(data_dir, '*研发设备*.xlsx')
    if equipment_file:
        data['equipment_table'] = pd.read_excel(equipment_file)
    else:
        # v1.5.0新增：未找到研发设备清单时，从固定资产清单筛选研发设备
        fixed_asset_file = find_file(data_dir, '*固定资产*.xlsx') or find_file(data_dir, '*资产清单*.xlsx')
        if fixed_asset_file:
            rnd_result = filter_rnd_equipment_from_fixed_assets(
                fixed_asset_file,
                target_year=application_year - 1 if application_year else None
            )
            data['equipment_table'] = rnd_result.get('rnd_equipment')
            data['equipment_source'] = '固定资产清单筛选'
            data['equipment_total_value'] = rnd_result.get('total_value', 0)
            data['equipment_count'] = rnd_result.get('total_count', 0)
            data['equipment_source_file'] = rnd_result.get('source_file')
    
    return data

def find_related_data(enterprise_data, document_type):
    """查找关联数据"""
    related_data = {}
    
    if document_type == '研发组织管理制度':
        # 需要关联：研发项目、科技人员、研发设备
        related_data['rd_projects'] = enterprise_data.get('rd_table', [])
        related_data['staff'] = enterprise_data.get('staff_table', [])
        related_data['equipment'] = enterprise_data.get('equipment_table', [])
        
    elif document_type == '研发投入核算管理制度':
        # 需要关联：研发费用数据
        related_data['expense_data'] = enterprise_data.get('expense_data', [])
        
    elif document_type == '产学研合作管理办法':
        # 需要关联：知识产权、研发项目
        related_data['ip_list'] = enterprise_data.get('ip_table', [])
        related_data['rd_projects'] = enterprise_data.get('rd_table', [])
        
    elif document_type == '科技成果转化奖励办法':
        # 需要关联：科技成果转化情况
        related_data['achievements'] = enterprise_data.get('achievement_table', [])
    
    return related_data

def find_file(directory, pattern):
    """查找匹配模式的文件"""
    import glob
    matches = glob.glob(os.path.join(directory, pattern))
    return matches[0] if matches else None
```

## 输入要求
1. **企业基本信息**（企业名称、注册地址、成立时间等）
2. **研发项目信息**（RD编号、名称、经费、人员等）- 从RD表获取
3. **知识产权信息**（IP编号、名称、类型等）- 从IP表获取
4. **科技人员信息**（人员名单、学历、岗位等）- 从科技人员表获取
5. **研发设备信息**（设备名称、型号、数量、价值等）- 从研发设备清单获取
6. **研发场地信息**（场地面积、位置等）- 从企业信息获取
7. **产学研合作信息**（合作单位、合作项目、合同等）- 从现有材料获取
8. **研发费用数据**（近三年研发费用明细）- 从财务数据获取

## 输出规范

### 一、研发组织管理制度及研发投入核算体系

#### 1. 企业研究开发组织管理制度
```python
def generate_rd_organization_system(enterprise_name, enterprise_info, rd_data, staff_data, equipment_data):
    """生成研发组织管理制度"""
    
    content_sections = [
        {
            'title': '第一章 总则',
            'content': [
                f'第一条 为规范{enterprise_name}（以下简称"公司"）的研究开发工作，提高自主创新能力，特制定本制度。',
                '第二条 本制度适用于公司所有研发项目的管理。',
                '第三条 公司研发工作遵循"市场导向、技术创新、规范管理、注重实效"的原则。'
            ]
        },
        {
            'title': '第二章 研发组织机构',
            'content': [
                f'第四条 公司设立{enterprise_info.get("研发机构名称", "研发中心")}，负责统筹管理公司研发工作。',
                f'第五条 研发中心占地面积{enterprise_info.get("研发场地面积", "XXX")}平方米，配备研发人员{len(staff_data)}人。',
                '第六条 研发中心主要职责：',
                '（一）制定公司技术发展战略和研发规划；',
                '（二）组织开展技术研发、产品开发和技术创新；',
                '（三）负责研发项目的全过程管理；',
                '（四）负责知识产权的申请、维护和管理；',
                '（五）负责研发成果的市场转化。'
            ]
        },
        {
            'title': '第三章 研发项目管理',
            'content': [
                '第七条 研发项目立项流程：',
                '（一）项目提案：研发人员根据市场需求或技术发展趋势提出项目提案；',
                '（二）可行性论证：研发中心组织专家对项目进行可行性论证；',
                '（三）立项审批：经公司总经理办公会审批通过后，正式立项；',
                '（四）项目实施：项目组按照项目计划组织实施；',
                '（五）项目验收：项目完成后，组织验收评审。',
                f'第八条 近三年公司共开展研发项目{len(rd_data)}项，累计投入研发经费{sum(rd_data["研发经费近三年总支出"]):.2f}万元。'
            ]
        }
    ]
    
    output_path = f"{enterprise_name}-企业研究开发组织管理制度.docx"
    return create_word_document(f"{enterprise_name}研究开发组织管理制度", content_sections, output_path)
```

#### 2. 研发投入核算管理制度
```python
def generate_rd_expense_accounting_system(enterprise_name, expense_data):
    """生成研发投入核算管理制度"""
    
    # 计算近三年研发费用
    total_expense = sum(expense_data.get('近三年总支出', 0))
    
    content_sections = [
        {
            'title': '第一章 总则',
            'content': [
                f'第一条 为规范{enterprise_name}研发费用的核算管理，确保研发费用归集准确、完整，特制定本制度。',
                '第二条 本制度适用于公司所有研发项目的费用核算管理。',
                '第三条 研发费用核算遵循"真实、准确、完整、规范"的原则。'
            ]
        },
        {
            'title': '第二章 研发费用归集范围',
            'content': [
                '第四条 研发费用包括以下八大类：',
                '（一）人员人工费用：研发人员的工资薪金、基本养老保险费、基本医疗保险费、失业保险费、工伤保险费、生育保险费和住房公积金，以及外聘研发人员的劳务费用。',
                '（二）直接投入费用：研发活动直接消耗的材料、燃料和动力费用；用于中间试验和产品试制的模具、工艺装备开发及制造费；用于不构成固定资产的样品、样机及一般测试手段购置费；用于试制产品的检验费；用于研发活动的仪器、设备的运行维护、调整、检验、维修等费用；用于研发活动的房屋租金。',
                '（三）折旧费用与长期待摊费用：用于研发活动的仪器、设备的折旧费；研发设施的改建、改装和装修等长期待摊费用。',
                '（四）无形资产摊销费用：用于研发活动的软件、专利权、非专利技术等无形资产的摊销费用。',
                '（五）设计费用：为新产品和新工艺进行构思、开发和制造，进行工序、技术规范、操作特性方面的设计等发生的费用。',
                '（六）装备调试费用与试验费用：工装准备过程中研究开发活动发生的费用，包括研制特殊、专用的生产装备发生的费用；新药研制的临床试验费；勘探开发技术的现场试验费。',
                '（七）委托外部研究开发费用：企业委托境内外部机构或专家进行研发活动所发生的费用。',
                '（八）其他费用：与研发活动直接相关的其他费用，如技术图书资料费、资料翻译费、专家咨询费、研发成果检索分析费、知识产权申请费、注册费、代理费、差旅费、会议费等。'
            ]
        },
        {
            'title': '第三章 研发费用核算流程',
            'content': [
                '第五条 研发费用核算流程：',
                '（一）费用归集：财务人员根据研发项目实际发生的费用，按照费用类别进行归集；',
                '（二）费用分配：对于多个研发项目共同发生的费用，按照合理的分配标准进行分配；',
                '（三）费用核算：财务人员按照会计准则和公司财务制度进行核算；',
                '（四）费用审核：财务负责人对研发费用进行审核，确保费用归集准确、完整。',
                f'第六条 公司近三年累计研发投入{total_expense:.2f}万元，年均研发投入增长率为{calculate_growth_rate(expense_data):.2f}%。'
            ]
        }
    ]
    
    output_path = f"{enterprise_name}-研发投入核算管理制度.docx"
    return create_word_document(f"{enterprise_name}研发投入核算管理制度", content_sections, output_path)
```

#### 3. 三年研发费用辅助账
```python
def generate_three_year_auxiliary_accounting(enterprise_name, application_year, expense_data):
    """生成三年研发费用辅助账"""
    
    recent_years = [application_year - 3, application_year - 2, application_year - 1]
    output_files = []
    
    for year in recent_years:
        year_expenses = expense_data.get(year, {})
        
        # 构建费用数据
        rd_expenses = {
            '人员人工费用': year_expenses.get('人员人工费用', 0),
            '直接投入费用': year_expenses.get('直接投入费用', 0),
            '折旧费用与长期待摊费用': year_expenses.get('折旧费用', 0),
            '无形资产摊销费用': year_expenses.get('无形资产摊销', 0),
            '设计费用': year_expenses.get('设计费用', 0),
            '装备调试费用与试验费用': year_expenses.get('装备调试费用', 0),
            '委托外部研究开发费用': year_expenses.get('委托外部费用', 0),
            '其他费用': year_expenses.get('其他费用', 0)
        }
        
        output_path = create_auxiliary_accounting(enterprise_name, year, rd_expenses, '.')
        output_files.append(output_path)
    
    return output_files
```

### 二、研发机构设立文件及科研条件证明

#### 1. 研发机构成立文件
```python
def generate_rd_institution_establishment(enterprise_name, enterprise_info, staff_data, equipment_data):
    """生成研发机构成立文件"""
    
    content_sections = [
        {
            'title': '一、成立背景',
            'content': [
                f'{enterprise_name}成立于{enterprise_info.get("成立日期", "XXXX年")}，是一家专注于{enterprise_info.get("主营业务", "新能源与节能")}领域的高新技术企业。',
                '为提升公司自主创新能力，加快科技成果转化，公司决定设立专门的研发机构。'
            ]
        },
        {
            'title': '二、研发机构名称',
            'content': [
                f'机构名称：{enterprise_name}研发中心',
                f'机构地址：{enterprise_info.get("注册地址", "深圳市")}'
            ]
        },
        {
            'title': '三、研发机构职责',
            'content': [
                '（一）技术研发：开展{enterprise_info.get("技术领域", "新能源与节能")}领域的技术研究；',
                '（二）产品开发：根据市场需求开发新产品；',
                '（三）成果转化：推动研发成果的市场化应用；',
                '（四）人才培养：培养和引进高层次技术人才。'
            ]
        },
        {
            'title': '四、研发场地及设备',
            'content': [
                f'研发中心占地面积{enterprise_info.get("研发场地面积", "XXX")}平方米，其中：',
                '- 研发实验室：XXX平方米',
                '- 测试中心：XXX平方米',
                '- 办公区域：XXX平方米',
                f'主要研发设备{len(equipment_data)}台（套），设备总值{sum(equipment_data.get("总价", [])):.2f}万元。'
            ]
        },
        {
            'title': '五、研发人员配置',
            'content': [
                f'研发中心现有人员{len(staff_data)}人，其中：',
                f'- 博士学历：{len([s for s in staff_data if s.get("学历") == "博士"])}人',
                f'- 硕士学历：{len([s for s in staff_data if s.get("学历") == "硕士"])}人',
                f'- 本科学历：{len([s for s in staff_data if s.get("学历") == "本科"])}人',
                f'- 高级职称：{len([s for s in staff_data if s.get("职称") == "高级"])}人',
                f'- 中级职称：{len([s for s in staff_data if s.get("职称") == "中级"])}人'
            ]
        }
    ]
    
    output_path = f"{enterprise_name}-研发中心成立文件.docx"
    return create_word_document(f"{enterprise_name}研发中心成立文件", content_sections, output_path)
```

## 撰写要求
1. **贴近实际**：制度内容必须贴近企业实际情况，不得照搬模板
2. **完整规范**：制度结构完整，条款清晰，语言规范
3. **可操作性**：制度具有可操作性，流程明确
4. **一致性**：制度中的人员、设备、场地等信息必须与其他材料一致
5. **格式规范**：Word文档格式规范，字体、字号、行距符合要求
6. **数据准确**：研发费用数据必须与辅助账、RD表一致

## 格式规范
1. **字体**：宋体（中文），Times New Roman（英文和数字）
2. **字号**：小四号（12pt）
3. **行距**：1.5倍行距
4. **页边距**：上下2.54cm，左右3.17cm
5. **段落**：首行缩进2字符
6. **标题**：
   - 一级标题：黑体，小三号，加粗
   - 二级标题：黑体，四号，加粗
   - 三级标题：黑体，小四号，加粗

## 数据一致性检查
```python
def validate_consistency(enterprise_data, generated_documents):
    """验证数据一致性"""
    errors = []
    
    # 1. 人员一致性检查
    staff_count = len(enterprise_data.get('staff_table', []))
    for doc in generated_documents:
        if '研发组织管理制度' in doc:
            # 检查制度中的人员数量是否与科技人员表一致
            pass
    
    # 2. 设备一致性检查
    equipment_count = len(enterprise_data.get('equipment_table', []))
    equipment_total = sum(enterprise_data.get('equipment_table', {}).get('总价', []))
    
    # 3. 场地一致性检查
    rd_area = enterprise_data.get('enterprise_info', {}).get('研发场地面积', 0)
    
    # 4. 经费一致性检查
    rd_expenses = sum(enterprise_data.get('rd_table', {}).get('研发经费近三年总支出', []))
    
    # 5. 知识产权一致性检查
    ip_count = len(enterprise_data.get('ip_table', []))
    
    return errors
```

## 工作流程
1. **信息收集**：收集企业研发组织、人员、设备、场地等基本信息
2. **数据关联**：从核心表格、科技人员表、研发设备清单等获取关联数据
3. **制度撰写**：按照文档结构撰写各项制度
4. **辅助账编制**：编制三年研发费用辅助账
5. **证明材料整理**：整理相关证明材料（照片、证书、合同等）
6. **一致性检查**：检查制度内容与其他材料的一致性
7. **格式调整**：调整文档格式，确保符合申报要求
8. **质量审核**：审核制度内容的完整性和规范性

## 常见问题处理
1. **制度内容空洞**：补充具体条款，增强可操作性
2. **数据不一致**：核对其他材料，统一数据口径
3. **证明材料不全**：补充照片、证书、合同等证明材料
4. **辅助账不完整**：补充缺失的费用项目
5. **格式不规范**：严格按照格式要求调整
6. **研发费用归集错误**：按照八大类重新归集研发费用

## 业务增强函数（v1.5.0新增）

以下函数为 v1.5.0 新增的业务增强能力，用于在缺少独立研发设备清单时，从固定资产清单中筛选研发设备。`load_enterprise_data()` 在未找到 `*研发设备*.xlsx` 时会自动调用 `filter_rnd_equipment_from_fixed_assets()`，无需外部导入。

```python
def filter_rnd_equipment_from_fixed_assets(fixed_asset_file, target_year=None, application_year=None):
    """从固定资产清单Excel中筛选研发设备

    当企业未提供独立的研发设备清单（如"研发设备清单.xlsx"），
    但提供了"固定资产清单.xlsx"时，通过使用部门关键词及购入年度筛选研发设备。

    参数:
        fixed_asset_file (str): 固定资产清单Excel文件路径
        target_year (int, optional): 设备购入/入账/启用日期需 ≤ 该年度。优先使用该参数；
            若为 None 但 application_year 有值，则取 application_year - 1
        application_year (int, optional): 申报年份，用于推算 target_year

    返回:
        dict: {
            'rnd_equipment': DataFrame,   # 筛选出的研发设备清单
            'total_count': int,            # 研发设备总数
            'total_value': float,         # 研发设备总值（万元）
            'rnd_ratio': float,            # 研发设备占全部固定资产数量比
            'source_file': str            # 固定资产清单文件路径
        }
    """
    import pandas as pd
    import re

    # 1. 确定年度筛选阈值
    if target_year is None and application_year is not None:
        target_year = application_year - 1

    # 2. 读取固定资产清单Excel
    df = pd.read_excel(fixed_asset_file)

    # 3. 识别"使用部门"列（兼容多种命名）
    dept_col = None
    for col in df.columns:
        col_str = str(col)
        if '使用部门' in col_str or '所属部门' in col_str or '部门' == col_str.strip():
            dept_col = col
            break

    # 4. 识别设备名称列（兼容多种命名）
    name_col = None
    for col in df.columns:
        col_str = str(col)
        if '设备名称' in col_str or '资产名称' in col_str or '名称' == col_str.strip():
            name_col = col
            break

    # 5. 识别价值列（兼容原值/净值/单价/总价）
    value_col = None
    for col in df.columns:
        col_str = str(col)
        if any(k in col_str for k in ['原值', '原价', '单价', '总价', '金额', '价值']):
            value_col = col
            break

    # 6. 识别日期列（购入日期/入账日期/启用日期）
    date_col = None
    for col in df.columns:
        col_str = str(col)
        if any(k in col_str for k in ['购入日期', '入账日期', '启用日期', '购置日期', '取得日期', '入账时间']):
            date_col = col
            break

    # 7. 按使用部门关键词筛选研发设备
    rnd_keywords = ['研发', '开发', '技术', '实验', '测试', '设计']
    rnd_mask = None
    if dept_col is not None:
        dept_series = df[dept_col].astype(str).fillna('')
        rnd_mask = dept_series.apply(
            lambda x: any(kw in x for kw in rnd_keywords)
        )
        rnd_df = df[rnd_mask].copy()
    else:
        # 无使用部门列时，尝试从设备名称中匹配研发关键词
        if name_col is not None:
            name_series = df[name_col].astype(str).fillna('')
            rnd_mask = name_series.apply(
                lambda x: any(kw in x for kw in rnd_keywords)
            )
            rnd_df = df[rnd_mask].copy()
        else:
            rnd_df = df.iloc[0:0].copy()

    # 8. 按年度筛选（设备购入/入账/启用日期 ≤ target_year）
    if target_year is not None and date_col is not None and not rnd_df.empty:
        def _parse_year(val):
            try:
                s = str(val)
                # 提取4位年份
                m = re.search(r'(20/d{2}|19/d{2})', s)
                if m:
                    return int(m.group(1))
            except Exception:
                pass
            return None

        year_series = rnd_df[date_col].apply(_parse_year)
        year_valid = year_series.notna()
        rnd_df = rnd_df[year_valid].copy()
        rnd_df = rnd_df[year_series[year_valid] <= target_year]

    # 9. 计算统计指标
    total_count = len(rnd_df)
    all_count = len(df)
    rnd_ratio = round(total_count / all_count, 4) if all_count > 0 else 0.0

    total_value = 0.0
    if value_col is not None and not rnd_df.empty:
        try:
            total_value = float(
                pd.to_numeric(rnd_df[value_col], errors='coerce').fillna(0).sum()
            )
        except Exception:
            total_value = 0.0

    return {
        'rnd_equipment': rnd_df,
        'total_count': total_count,
        'total_value': total_value,
        'rnd_ratio': rnd_ratio,
        'source_file': fixed_asset_file,
    }
```

## 业务增强函数（v1.6.0新增）

以下函数为 v1.6.0 新增的业务增强能力，用于在撰写研发机构成立文件前校验研发设备清单中的每台设备是否都在本次固定资产清单中有对应记录。支持从往年制度文件 PDF 中提取设备清单并与本次固定资产清单交叉校验，确保申报材料中列出的研发设备真实存在且可溯源。第四步撰写研发机构成立文件前必须先调用 `validate_equipment_in_fixed_assets()` 进行校验。

```python
def validate_equipment_in_fixed_assets(equipment_list_from_system, fixed_asset_file):
    """校验研发设备清单中的每台设备是否都在固定资产清单中

    在撰写研发机构成立文件前调用，对研发设备清单（来自制度文件或往年申报材料）
    中的每台设备，在固定资产清单Excel中查找匹配（设备名称模糊匹配，相似度≥0.6视为匹配）。

    参数:
        equipment_list_from_system (list of dict): 研发设备清单，每个dict含name字段
            示例: [{'name': '主链淬火炉'}, {'name': '双室真空油淬'}, ...]
        fixed_asset_file (str): 固定资产清单Excel路径

    返回:
        dict: {
            'total_count': int,      # 研发设备总数
            'matched_count': int,    # 已匹配数量（相似度≥0.6）
            'unmatched_count': int,  # 未匹配数量（相似度<0.6）
            'partial_count': int,    # 部分匹配数量（0.3≤相似度<0.6）
            'details': list,         # 每个设备的详细匹配结果
            'summary': str           # 汇总说明
        }
    """
    import pandas as pd
    from difflib import SequenceMatcher

    # 1. 读取固定资产清单Excel
    try:
        df_assets = pd.read_excel(fixed_asset_file)
    except Exception as e:
        return {
            'total_count': len(equipment_list_from_system) if equipment_list_from_system else 0,
            'matched_count': 0,
            'unmatched_count': len(equipment_list_from_system) if equipment_list_from_system else 0,
            'partial_count': 0,
            'details': [],
            'summary': f"读取固定资产清单失败：{e}",
        }

    if equipment_list_from_system is None or len(equipment_list_from_system) == 0:
        return {
            'total_count': 0,
            'matched_count': 0,
            'unmatched_count': 0,
            'partial_count': 0,
            'details': [],
            'summary': '研发设备清单为空，无需校验',
        }

    # 2. 识别固定资产清单中的设备/资产名称列（兼容多种命名）
    name_col = None
    for col in df_assets.columns:
        col_str = str(col)
        if any(k in col_str for k in ['设备名称', '资产名称', '固定资产名称', '名称']):
            name_col = col
            break
    if name_col is None:
        # 退化：取第一列作为名称列
        name_col = df_assets.columns[0]

    asset_names = df_assets[name_col].astype(str).fillna('').tolist()

    # 3. 对每个研发设备在固定资产清单中查找最佳匹配
    SIMILARITY_THRESHOLD = 0.6  # ≥0.6 视为已匹配
    PARTIAL_THRESHOLD = 0.3     # 0.3≤相似度<0.6 视为部分匹配

    details = []
    matched_count = 0
    unmatched_count = 0
    partial_count = 0

    for equip in equipment_list_from_system:
        equip_name = str(equip.get('name', '') or equip.get('设备名称', '')).strip()
        if not equip_name:
            continue

        best_ratio = 0.0
        best_match_name = ''
        best_match_idx = -1
        for idx, asset_name in enumerate(asset_names):
            asset_name_clean = str(asset_name).strip()
            if not asset_name_clean:
                continue
            ratio = SequenceMatcher(None, equip_name, asset_name_clean).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_match_name = asset_name_clean
                best_match_idx = idx

        # 判定匹配状态
        if best_ratio >= SIMILARITY_THRESHOLD:
            status = '已匹配'
            matched_count += 1
        elif best_ratio >= PARTIAL_THRESHOLD:
            status = '部分匹配'
            partial_count += 1
        else:
            status = '未匹配'
            unmatched_count += 1

        # 提取匹配到的固定资产记录
        matched_record = None
        if best_match_idx >= 0 and best_ratio >= PARTIAL_THRESHOLD:
            matched_record = df_assets.iloc[best_match_idx].to_dict()

        details.append({
            'equipment_name': equip_name,
            'status': status,
            'similarity': round(best_ratio, 4),
            'matched_asset_name': best_match_name if best_ratio >= PARTIAL_THRESHOLD else '',
            'matched_record': matched_record,
        })

    total_count = len(details)
    summary = (
        f"研发设备清单校验完成：共{total_count}项设备，"
        f"已匹配{matched_count}项，部分匹配{partial_count}项，未匹配{unmatched_count}项。"
    )
    if unmatched_count > 0:
        unmatched_names = [d['equipment_name'] for d in details if d['status'] == '未匹配']
        summary += f" 未匹配设备：{', '.join(unmatched_names)}。需在研发机构成立文件中标注说明或从设备清单中剔除。"

    return {
        'total_count': total_count,
        'matched_count': matched_count,
        'unmatched_count': unmatched_count,
        'partial_count': partial_count,
        'details': details,
        'summary': summary,
    }

def load_equipment_from_pdf(pdf_path):
    """从制度文件PDF中提取设备清单（支持自定义字体编码的PDF）

    用于读取往年制度文件（如"企业内部科学技术研究开发机构并具备相应科研条件、
    与国内外研究开发机构开展多种形式的产学研合作"等文件），提取其中列出的研发设备清单，
    便于与本次固定资产清单交叉校验。

    参数:
        pdf_path (str): 制度文件PDF路径

    返回:
        dict: {
            'equipment_list': list,    # 设备列表，每个元素为 dict（含 name 等字段）
            'total_count': int,       # 设备总数
            'source_section': str     # 来源章节名称
        }
    """
    import re

    equipment_list = []
    source_section = ''
    total_count = 0

    # 1. 尝试用 PyMuPDF(fitz) 读取PDF（兼容自定义字体编码）
    try:
        import fitz  # PyMuPDF
    except ImportError:
        # 退化：尝试用 pdfplumber
        try:
            import pdfplumber
            with pdfplumber.open(pdf_path) as pdf:
                full_text = ''
                for page in pdf.pages:
                    page_text = page.extract_text() or ''
                    full_text += page_text + '/n'
            return _parse_equipment_from_text(full_text)
        except Exception:
            return {
                'equipment_list': [],
                'total_count': 0,
                'source_section': '',
            }

    # 2. 提取PDF全部文本
    full_text = ''
    try:
        doc = fitz.open(pdf_path)
        for page in doc:
            full_text += page.get_text() + '/n'
        doc.close()
    except Exception:
        return {
            'equipment_list': [],
            'total_count': 0,
            'source_section': '',
        }

    # 3. 识别设备清单章节并提取设备
    return _parse_equipment_from_text(full_text)

def _parse_equipment_from_text(full_text):
    """从PDF提取的文本中识别设备清单章节并解析设备列表（内部辅助函数）"""
    import re

    equipment_list = []
    source_section = ''

    # 识别设备清单章节标题（兼容多种命名）
    section_patterns = [
        r'(研发部门科研条件[^。/n]*)',
        r'(设备投入情况[^。/n]*)',
        r'(设备清单[^。/n]*)',
        r'(科研条件[^。/n]*)',
        r'(主要研发设备[^。/n]*)',
        r'(研发设备[^。/n]*)',
    ]
    for pattern in section_patterns:
        m = re.search(pattern, full_text)
        if m:
            source_section = m.group(1).strip()
            break

    # 提取设备清单表格行：序号 | 设备名称 | 设备型号 | 数量
    # 兼容多种分隔符（空格、制表符、多个空格）
    # 序号1-99，后跟设备名称
    equip_pattern = re.compile(
        r'(?:^|/n)/s*(/d{1,2})/s*[/.、/)]?/s+([/u4e00-/u9fa5A-Za-z][/u4e00-/u9fa5A-Za-z0-9/-/(/)（）//]{1,40})'
    )
    seen_names = set()
    for match in equip_pattern.finditer(full_text):
        seq = match.group(1)
        name = match.group(2).strip()
        # 过滤明显非设备名称的内容
        if not name or len(name) < 2:
            continue
        if name in seen_names:
            continue
        # 过滤数字开头的非名称
        if name.isdigit():
            continue
        seen_names.add(name)
        equipment_list.append({
            'seq': int(seq),
            'name': name,
            'model': '',
            'quantity': 1,
        })

    # 按序号排序
    equipment_list.sort(key=lambda x: x.get('seq', 0))
    total_count = len(equipment_list)

    return {
        'equipment_list': equipment_list,
        'total_count': total_count,
        'source_section': source_section,
    }
```

## 模块六：PDF拆分与合并资料整理（pdf_splitter）
> 详见 {{YFW_SKILLS}}/_common/pdf_splitter.py

---

## 模块七：文件分类整理（file_organizer）
> 详见 {{YFW_SKILLS}}/_common/file_content_classifier.py

---

## 模块八：高新政策要求与合规校验（policy_compliance）
> 详见 {{YFW_SKILLS}}/_common/policy_compliance.py

---

## 模块九：企业基本信息联网搜索（enterprise_info_search）
> 详见 {{YFW_SKILLS}}/_common/enterprise_info_search.py

<!-- SECTION_BEGIN: provenance_verification v2.7 -->
## 溯源核验 → 详见 {{YFW_SKILLS}}/_common/SHARED_provenance.md
> 关键字段值必须与源文件精确一致。调用: set_provenance() → scan_and_correct()
<!-- SECTION_END: provenance_verification -->

---

<!-- SECTION_BEGIN: authoritative_terms_verification v2.6 -->
## 权威术语核验 → 详见 {{YFW_SKILLS}}/_common/SHARED_authoritative_terms.md
> 输出前强制扫描权威术语。
<!-- SECTION_END: authoritative_terms_verification -->
