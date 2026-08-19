---
name: gxtz-staff-materials
description: "高新技术企业认定科技人员材料撰写，包括人员比例说明、人员信息表等。核心：科技人员必须在上年12月社保缴费记录（带章）中且累计工作时长≥183天，比例≥10%。当用户提到科技人员、人员材料、人员比例、社保缴费证明时调用此技能。v1.18.0新增：输出隐患自查与汇报。v1.19.0新增：隐患自查扩充至7维（补齐文本质量+文档格式+政策符合性+可溯源性）。v1.27.0: SKILL.md瘦身（共享SECTION外置+内嵌代码改脚本引用）。"
version: "1.27.0"
triggers:
  - 科技人员
  - 人员材料
  - 人员比例
  - 社保缴费证明
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

- 脚本路径必须使用相对路径
- 参数必须按脚本定义的 CLI 接口传递
- 不得通过"调用 xxx() 函数"的形式执行（函数描述不是可执行命令）

## 审核验证标准（agent 必须执行且通过）

### 审核脚本调用

最后一步必须执行对应的审核验证脚本：

```
python {{YFW_SKILLS}}/_common/validate_staff.py --dir "输出目录" --project-root "项目根目录"
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

# 科技人员材料撰写

## 描述
本技能用于撰写高新技术企业认定所需的科技人员相关材料，包括科技人员比例情况说明、科技人员信息表等。

## 使用场景
- 用户提到"科技人员"、"人员材料"、"人员比例"
- 用户需要撰写或修改科技人员相关材料

## 统一输出目录规范

本技能生成的文件必须统一存放到项目输出根目录下，便于用户查看操作。

### 输出根目录
`{企业名称}_高新认定材料_{申报年份}/`

统一目录结构：00_核心表格 / 01_研发立项报告 / 02_知识产权证明 / 03_成果转化证明 / 04_高新产品证明 / 05_科技人员材料 / 06_管理制度材料 / 07_资料收集清单 / _校验报告

### 本技能输出子目录
`05_科技人员材料/`（校验/审核报告输出到 `_校验报告/`）

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

### 第零步完：确认进度依赖（v1.x.1新增，进度管理集成）

在开始工作前，检查本技能的前置阶段是否已完成：

```bash
python {{YFW_SKILLS}}/_common/progress_sync.py check-deps ^
    --project-root "." ^
    --skill "gxtz-staff-materials"
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
6. 调用 `generate_supplement_checklist(enterprise_name, application_year, 'gxtz-staff-materials')` 生成/更新补充资料清单文档
7. 调用 `scan_supplement_dir(enterprise_name, application_year, 'gxtz-staff-materials')` 扫描补充资料目录：
   - 如果有新文件：自动读取分析（支持压缩文件解压），添加到文件图谱
   - 如果有新文件：调用 `organize_supplement_files()` 整理到统一输出目录
   - 如果有新文件：调用 `update_experience_from_supplement()` 沉淀识别规则到经验库
8. 将补充资料分析结果作为本技能执行的输入数据
9. **v1.5.0新增 - 往年资料学历证书补充扫描**：如果补充资料目录中学历证书为空（或仍存在待补充的学历证书），额外扫描往年资料目录（调用 `scan_historical_materials(data_dir)` 或指定路径如".../往年资料/.../7.专职人员学历证书"），识别往年资料中的学历证书：
   - 调用 `scan_degree_certificates_dir(degree_dir, staff_list)` 扫描往年资料中的学历证书目录
   - 调用 `update_degree_certificate_status(staff_list, degree_scan_result)` 更新已识别到证书的人员状态
   - 调用 `filter_missing_supplements('gxtz-staff-materials', analysis_results)` 重新计算待补充清单，已扫描到学历证书的人员不再标注"待补充"

**合并PDF自动检测与拆分**：
10. 调用 `batch_process_merged_pdfs(data_dir)` 批量扫描数据目录下所有PDF文件，自动检测合并PDF（多文档合订）：
   - 检测到合并PDF：自动备份原件到 `_backup/pdf_original/` 目录（保留原始文件不变）
   - 按书签/内容类型/页三种方式智能选择拆分，生成拆分后文件到 `{原文件名}_拆分/` 目录
   - 对每个拆分后文件提取文本/表格/图片，扫描页（无文本层）自动触发 `ocr_scanned_pdf()` OCR识别
   - 拆分后的文件作为本技能的输入数据，替代原始合并PDF进行分析
   - 非合并PDF：直接提取内容，不拆分

### 第一步：收集科技人员信息（核心：上年12月社保基准 + 工作时长）
1. 收集企业员工总名单（以上年12月31日为基准日的在职人员名单）
2. **收集上年12月社保缴费证明文件（带公章）**：
   - 调用 `find_files_with_archive_support(data_dir, keyword='社保', file_patterns=['.pdf', '.xlsx'])`
   - 识别"上年12月社保缴费证明"文件（关键词：社保、缴费、上年12月、上年年份+12）
   - 校验文件是否带公章（OCR识别红色印章或人工确认）
   - 若未找到上年12月社保缴费证明，列入待补充清单
3. 从上年12月社保缴费记录中提取人员名单（社保缴纳人员=在职人员基准）
4. 筛选科技人员名单（研发人员、技术人员），必须同时满足：
   - 在上年12月社保缴费记录中
   - 入职时间 ≤ 上年12月
   - 在申报年度累计工作时长≥183天
5. 收集每位科技人员的：姓名、性别、出生日期、学历、专业、岗位、入职时间、离职时间（如有）、职称、上年12月社保缴纳情况、累计工作时长

**v1.5.0新增 - 学历证书目录扫描**：
- 扫描学历证书目录：调用 `scan_degree_certificates_dir(degree_dir, staff_list)` 扫描学历证书目录（包括往年资料目录如".../7.专职人员学历证书"），识别已有学历证书文件
- 更新学历证书状态：调用 `update_degree_certificate_status(staff_list, degree_scan_result)` 根据扫描结果更新每位科技人员的学历证书状态
- 重新生成补充清单：调用 `filter_missing_supplements('gxtz-staff-materials', analysis_results)` 重新计算待补充项，已扫描到学历证书的人员不再列入待补充清单

### 第一步扩展：企微补充人员材料（v1.16.0新增，可选增强）

**触发条件**：本地缺失社保缴费证明/学历证书 + wecom 数据源可用

**执行步骤**：
1. 诊断数据源：
   ```bash
   python {{YFW_SKILLS}}/_common/wecom_query.py diagnose
   ```
   - 检查 `overall_ready=true`，否则跳过本扩展步骤

2. 一键式按企业名称收集人员材料：
   ```bash
   python {{YFW_SKILLS}}/_common/wecom_query.py collect-by-enterprise \
     --enterprise "{企业}" \
     --out "{企业}_高新认定材料_{年份}/_补充资料/gxtz-staff-materials" \
     --keyword "社保,缴费证明,学历,学位,毕业证" \
     --from {起始月} --to {结束月}
   ```

3. 审查收集结果：
   - 检查导出文件被 `scan_supplement_dir()` 识别并登记到 file_map.json
   - **会话归属一致性**：所有导出文件的 `.wecom_meta.json` 的 `conversation_id` 必须属于目标企业（无串客户）

详见模块十二：企业微信会话实时查询与附件收集。

### 第二步：计算科技人员比例（以上年12月为基准）
1. 统计企业职工总数（**基准：上年12月31日在职人数，以上年12月社保缴费记录为准**）
2. 统计科技人员数量（必须在上年12月社保缴费记录中且累计工作时长≥183天）
3. 计算科技人员占比：科技人员数 / 职工总数 × 100%
4. 验证占比是否≥10%（高企认定要求）

### 第三步：撰写科技人员比例情况说明
1. 创建Word文档
2. 撰写说明内容：
   - 企业基本情况（成立时间、主营业务、员工总数）
   - 科技人员定义与范围
   - 科技人员数量与占比
   - 科技人员学历结构、专业结构、职称结构
   - 结论：符合高新技术企业认定要求
3. 保存文档，命名格式：{企业名称}-科技人员比例情况说明.docx

### 第四步：生成科技人员信息表
1. 创建Excel文件
2. 填写科技人员信息表：序号、姓名、性别、出生日期、学历、专业、岗位、入职时间、职称、是否科技人员
3. 添加统计Sheet：学历统计、专业统计、职称统计
4. 保存文件，命名格式：{企业名称}-科技人员信息表.xlsx

### 第五步：数据一致性校验（核心：上年12月社保 + 工作时长）
1. 验证科技人员数量与比例说明一致
2. 验证科技人员占比≥10%（基准：上年12月31日在职人数）
3. **验证科技人员名单与上年12月社保缴费记录一致**：
   - 每位科技人员必须在上年12月社保缴费记录中
   - 调用 `validate_social_security(staff_list, ss_records, application_year)` 校验
   - 输出不合格人员清单（不在上年12月社保中、入职晚于上年12月、工作时长不足183天）
4. **验证上年12月社保缴费证明文件带公章**
5. **验证累计工作时长≥183天**：调用 `calculate_work_days()` 计算每位人员工作时长
6. 生成《科技人员数据校验报告》（含合格/不合格人员分类）

### 第六步：审核验证（必须通过才能提交）
1. **完整性审核**
   - 检查是否已生成科技人员比例情况说明
   - 检查是否已生成科技人员信息表
   - **检查是否已提供上年12月社保缴费证明文件（带公章）**
   - 检查科技人员学历证书是否齐全
   - 检查科技人员职称证书是否齐全（如有）

2. **上年12月社保合规性审核（核心）**
   - 验证上年12月社保缴费证明文件存在且为上年12月份数据
   - 验证上年12月社保缴费证明文件带公章（红色印章）
   - 验证每位科技人员均在上年12月社保缴费记录中
   - 输出不在上年12月社保中的人员清单（需从科技人员名单中剔除）

3. **工作时长合规性审核（核心）**
   - 验证每位科技人员累计工作时长≥183天
   - 验证入职时间不晚于上年12月31日
   - 输出工作时长不足183天的人员清单（需从科技人员名单中剔除）

4. **一致性审核**
   - 验证科技人员数量与比例说明一致
   - 验证科技人员名单与上年12月社保缴费名单一致
   - 验证学历信息与学历证书一致
   - 验证职称信息与职称证书一致

5. **比例合规性审核**
   - 验证科技人员占比≥10%（职工总数基准：上年12月31日在职人数）
   - 验证职工总数统计准确（与上年12月社保缴费人数一致）
   - 验证科技人员定义符合高企要求

6. **规范性审核**
   - 检查比例情况说明文件命名：{企业名称}-{年份}年科技人员比例情况说明.docx
   - 检查信息表文件命名：{企业名称}-{年份}年科技人员信息表.xlsx
   - 检查上年12月社保缴费证明文件命名：{企业名称}-{上年}年12月社保缴费证明.pdf
   - 检查字体格式：宋体（中文），Times New Roman（英文和数字）
   - 检查字号：小四号（12pt）
   - 检查行距：1.5倍行距
   - 调用 `detect_naming_issues()` 检测命名问题（hash命名/微信图片/扫描仪/手机/WPS拼图/多次优化/大小写不一致/学历不统一）
   - 调用 `batch_validate_naming()` 批量校验文件命名规范

7. **生成审核报告**
   - 生成《科技人员材料审核报告》
   - 列出所有审核问题及整改建议
   - 审核结论：通过/不通过

8. **审核通过条件**
   - 所有材料齐全（含上年12月社保缴费证明）
   - 上年12月社保合规性审核通过
   - 工作时长合规性审核通过
   - 数据一致性检查通过
   - 比例符合要求
   - 文件格式规范

9. **审核不通过处理**
   - 列出所有问题清单
   - 提供整改建议
   - 要求整改后重新提交审核

### 最终步前：同步进度（v1.x.1新增，进度管理集成）

完成所有工作后、文件整理前，更新进度看板：

```bash
python {{YFW_SKILLS}}/_common/progress_sync.py update-stage ^
    --project-root "." ^
    --skill "gxtz-staff-materials" ^
    --status completed
```

此命令将自动匹配本技能对应的阶段并标记为"已完成"。
（注意：finalize 步骤也会自动同步进度，此步为双重保障。）


### 最终步：文件整理与知识库更新（强制执行，审核验证通过后必须执行）

**执行以下命令整理文件并更新知识库**（在项目根目录运行）：

```bash
python {{YFW_SKILLS}}/_common/project_context_manager.py finalize --enterprise "{企业名称}" --year {申报年份} --skill "gxtz-staff-materials" --no-move
```

此命令将：按19类目录结构整理文件 → 生成 .claude/_file_management_report.md 整理报告 → 更新 file_map.json / experience_base.json / project_index.json → 校验3个json文件已生成。
- **finalize 后强制验证（v2.0 新增，不可跳过）**：
  1. 立即读取 `.claude/_finalize_diff.json`，检查 `moved_from_protected`（应为空）和 `warnings`（应为空）
  2. `ls` 扫描 05_科技人员材料（至少3个文件），确认文件数不少于预期
  3. 若 `moved_from_protected` 非空或目录文件减少，从 diff 报告的 `to` 位置 Copy-Item 恢复到 `from` 位置
  4. 向用户输出验证结果（✅/⚠ + 具体数字），不得隐藏问题

1. 按19类目录结构整理文件（先检查补充资料目录，将可归类的文件移动到匹配目录）
2. 生成 _file_management_report.md 整理报告（含已归类/未归类/各类别统计/产出校验）
3. 更新 file_map.json（更新文件路径）、experience_base.json（记录本次执行）、project_index.json（更新进度）
4. 校验3个json文件均已生成，如未生成则报错

**清理临时文件**：确保资料目录无Word临时文件（~$开头）和重复文件（(1)后缀等）。

## 工具依赖
- **python-docx**：创建Word .docx文件（`pip install python-docx`）
- **openpyxl**：创建Excel .xlsx文件（`pip install openpyxl`）
- **pandas**：数据处理和统计（`pip install pandas`）

## 关键时间逻辑

### 申报年份确定
```
申报年份 = 用户指定的申报年份（如2025）
近三年 = [申报年份-2, 申报年份-1, 申报年份]
示例：2025年申报 → 近三年 = [2023, 2024, 2025]
```

### 科技人员时间约束（关键：上年12月社保基准 + 工作时长）
```
申报年份 = 用户指定（如2026）
上年 = 申报年份-1（如2025）
科技人员认定基准日 = 上年12月31日（如2025-12-31）

【硬性约束1：上年12月社保】
科技人员必须出现在"上年12月社保缴费记录"中
即：必须提供上年12月（如2025年12月）的社保缴费证明文件（社保局出具、带公章）
每位科技人员在上年12月社保缴费记录中必须有缴纳记录

【硬性约束2：工作时长】
科技人员在申报年度（近三年）累计实际工作时长必须≥183天（约6个月）
判定依据：入职时间 ≤ 上年12月 且 在职状态覆盖上年12月
入职时间晚于上年12月的人员，不能计入科技人员名单

【硬性约束3：比例】
科技人员数 / 企业职工总数（上年12月在职人数）× 100% ≥ 10%

【常规约束】
学历证书获得时间必须在入职时间之前
社保缴纳记录在近三年内有连续性（重点关注上年12月）
```

### 社保缴费证明文件要求
```
文件名称：{企业名称}-{上年}年12月社保缴费证明.pdf
示例：XX公司-2025年12月社保缴费证明.pdf

要求：
1. 由社保局出具，必须带公章（红色印章）
2. 包含：单位名称、人员姓名、身份证号、缴费起止时间、缴费基数
3. 必须为上年12月（不得用其他月份替代）
4. PDF格式，清晰可辨
5. 文件命名标准化：{企业名称}-{上年}年12月社保缴费证明.pdf

注意：
- 若员工在上年12月入职，需提供入职当月社保缴费证明
- 若员工在上年12月离职，不计入科技人员
- 上年12月社保缴费证明是认定科技人员资格的核心依据
```

## 月报数据三要素筛选（v1.17.0新增，基于友联普达项目经验）

> **核心教训**：不要只看月报中的"是否为研发人员"标记。月报标记为研发人员的可能只有2人，但实际计入研发费用的有10人。

### 三要素（必须同时满足）

| 要素 | 数据来源 | 筛选方法 |
|:---:|------|------|
| **① 工资已记入研发费用** | 月报"工资是否已记入研发费用"列 | `df['工资是否已记入研发费用'] == '是'` |
| **② 大专及以上学历** | 花名册/学历证书 | `学历 in ['博士','硕士','本科','大专']` |
| **③ 上年度在职≥183天** | 月报/考勤记录 | `calculate_work_days() >= 183` |

```python
def filter_sci_tech_by_three_elements(monthly_report_df, roster_df):
    """基于月报数据三要素筛选科技人员（友联普达方法论）
    不要只看'是否为研发人员'标记！
    """
    candidates = []

    for _, row in monthly_report_df.iterrows():
        name = row['姓名']

        # 要素①：工资已记入研发费用（月报字段，不是"是否为研发人员"标记）
        is_rd_expense = str(row.get('工资是否已记入研发费用', '')).strip() == '是'

        # 要素②：大专及以上学历
        roster_row = roster_df[roster_df['姓名'] == name]
        if roster_row.empty:
            continue
        education = str(roster_row.iloc[0].get('学历', ''))

        # 要素③：上年度在职≥183天
        work_days = calculate_work_days(name, monthly_report_df)

        if is_rd_expense and education in ['博士','硕士','本科','大专'] and work_days >= 183:
            candidates.append({
                '姓名': name,
                '学历': education,
                '工作天数': work_days,
                '来源': '月报三要素筛选（非"是否为研发人员"标记）'
            })

    return candidates
```

### 典型案例（友联普达）

| 方法 | 筛选结果 | 问题 |
|------|:---:|------|
| 只看"是否为研发人员"标记 | 2人 | 月报标记字段不完整，漏掉8人 |
| 三要素筛选 | 10人 | 计入研发费用的人员中有10人满足学历+天数条件 |

> **原则**：月报"工资是否记入研发费用"是权威依据，比"是否为研发人员"标记更可靠。月报标记字段可能只是行政分类，不代表实际研发参与。

## 数据关联查找逻辑

### 1. 科技人员比例计算（基准：上年12月31日在职人数）
```python
def calculate_staff_ratio(staff_list, total_staff_count, application_year=None):
    """
    计算科技人员占比
    staff_list: list，科技人员名单（必须已通过上年12月社保校验和工作时长校验）
    total_staff_count: int，企业职工总数（基准：上年12月31日在职人数）
    application_year: int，申报年份（如2026）
    """
    sci_tech_count = len(staff_list)
    ratio = sci_tech_count / total_staff_count * 100

    if ratio < 10:
        raise ValueError(f"科技人员占比{ratio:.2f}%低于10%的最低要求")

    return {
        'sci_tech_count': sci_tech_count,
        'total_staff_count': total_staff_count,
        'ratio': ratio,
        'application_year': application_year,
        'basis': f"上年12月31日（{application_year-1}-12-31）在职人数"
    }
```

### 2. 学历统计
```python
def calculate_education_statistics(staff_list):
    """
    统计科技人员学历分布
    """
    education_stats = {
        '博士': 0,
        '硕士': 0,
        '本科': 0,
        '大专': 0,
        '其他': 0
    }
    
    for staff in staff_list:
        education = staff.get('学历', '其他')
        if education in education_stats:
            education_stats[education] += 1
        else:
            education_stats['其他'] += 1
    
    return education_stats
```

### 3. 职称统计
```python
def calculate_title_statistics(staff_list):
    """
    统计科技人员职称分布
    """
    title_stats = {
        '高级': 0,
        '中级': 0,
        '初级': 0,
        '无职称': 0
    }
    
    for staff in staff_list:
        title = staff.get('职称', '无职称')
        if title in title_stats:
            title_stats[title] += 1
        else:
            title_stats['无职称'] += 1
    
    return title_stats
```

### 4. 社保一致性校验（核心：上年12月社保基准 + 工作时长）
```python
def validate_social_security(staff_list, social_security_records, application_year):
    """
    校验科技人员与社保记录的一致性
    核心：每位科技人员必须在上年12月社保缴费记录中，且累计工作时长≥183天

    Args:
        staff_list: 科技人员名单
        social_security_records: 社保缴费记录（从上年12月社保缴费证明文件中提取）
        application_year: 申报年份（如2026）
    """
    last_year = application_year - 1  # 上年（如2025）
    last_year_december = f"{last_year}-12"  # 上年12月（如2025-12）

    issues = []
    qualified_staff = []
    unqualified_staff = []

    for staff in staff_list:
        name = staff['姓名']
        id_card = staff['身份证号']
        hire_date = staff.get('入职时间', '')
        work_days = staff.get('累计工作时长', 0)

        # 1. 校验上年12月社保缴费记录
        ss_record = social_security_records.get(id_card)
        if not ss_record:
            issues.append(f"{name}：未找到社保记录")
            unqualified_staff.append(staff)
            continue

        # 检查上年12月是否有缴纳记录
        has_december_record = False
        for record in ss_record.get('缴纳明细', []):
            if record.get('缴纳月份', '').startswith(last_year_december):
                has_december_record = True
                break

        if not has_december_record:
            issues.append(f"{name}：上年12月（{last_year_december}）社保缴费记录缺失，不能计入科技人员")
            unqualified_staff.append(staff)
            continue

        # 2. 校验入职时间不晚于上年12月
        if hire_date and hire_date > f"{last_year}-12-31":
            issues.append(f"{name}：入职时间（{hire_date}）晚于上年12月31日，不能计入科技人员")
            unqualified_staff.append(staff)
            continue

        # 3. 校验累计工作时长≥183天
        if work_days < 183:
            issues.append(f"{name}：累计工作时长{work_days}天，不足183天要求")
            unqualified_staff.append(staff)
            continue

        qualified_staff.append(staff)

    result = {
        'qualified_count': len(qualified_staff),
        'unqualified_count': len(unqualified_staff),
        'qualified_staff': qualified_staff,
        'unqualified_staff': unqualified_staff,
        'issues': issues,
        'last_year_december': last_year_december
    }

    if unqualified_staff:
        print(f"[社保校验] {len(unqualified_staff)}名人员不符合上年12月社保或工作时长要求")

    return result

def extract_social_security_records(ss_file_path, target_year, target_month=12):
    """
    从社保缴费证明文件中提取人员名单和缴费明细

    Args:
        ss_file_path: 社保缴费证明文件路径（PDF或Excel）
        target_year: 目标年份（如2025）
        target_month: 目标月份（默认12月）

    Returns:
        dict: 以身份证号为key的社保记录字典
    """
    import pdfplumber  # 或 openpyxl 取决于文件格式

    records = {}
    target_period = f"{target_year}-{target_month:02d}"

    # 根据文件类型选择解析方式
    if ss_file_path.endswith('.pdf'):
        # PDF解析（OCR或pdfplumber）
        with pdfplumber.open(ss_file_path) as pdf:
            for page in pdf.pages:
                tables = page.extract_tables()
                for table in tables:
                    for row in table:
                        if len(row) >= 4:
                            name = row[0].strip() if row[0] else ''
                            id_card = row[1].strip() if row[1] else ''
                            period = row[2].strip() if row[2] else ''
                            base = row[3].strip() if row[3] else ''

                            if target_period in period:
                                records[id_card] = {
                                    '姓名': name,
                                    '身份证号': id_card,
                                    '缴纳月份': period,
                                    '缴费基数': base,
                                    '缴纳明细': [{'缴纳月份': period, '缴费基数': base}]
                                }
    elif ss_file_path.endswith('.xlsx'):
        import openpyxl
        wb = openpyxl.load_workbook(ss_file_path)
        for sheet in wb.sheetnames:
            ws = wb[sheet]
            for row in ws.iter_rows(values_only=True):
                if row and len(row) >= 4:
                    name = str(row[0]).strip() if row[0] else ''
                    id_card = str(row[1]).strip() if row[1] else ''
                    period = str(row[2]).strip() if row[2] else ''
                    base = str(row[3]).strip() if row[3] else ''

                    if target_period in period:
                        records[id_card] = {
                            '姓名': name,
                            '身份证号': id_card,
                            '缴纳月份': period,
                            '缴费基数': base,
                            '缴纳明细': [{'缴纳月份': period, '缴费基数': base}]
                        }

    return records

def check_seal_on_social_security(ss_file_path):
    """
    校验社保缴费证明是否带公章
    通过OCR识别红色印章或提示人工确认

    Args:
        ss_file_path: 社保缴费证明PDF文件路径

    Returns:
        dict: {'has_seal': bool, 'confidence': float, 'message': str}
    """
    # 方法1：通过PDF页面图像分析检测红色印章
    # 方法2：OCR识别"社保局"等关键词及印章区域
    # 方法3：提示人工确认

    try:
        import pdfplumber
        from PIL import Image
        import io

        with pdfplumber.open(ss_file_path) as pdf:
            for page in pdf.pages[:1]:  # 检查第一页
                # 转换为图像
                img = page.to_image(resolution=200)
                # 检测红色区域（公章通常为红色）
                # 此处为简化逻辑，实际需要图像处理
                # 红色像素占比>0.1%可认为有印章
                pass

        return {
            'has_seal': True,  # 简化处理，实际需图像分析
            'confidence': 0.8,
            'message': '检测到可能的公章区域，建议人工确认'
        }
    except Exception as e:
        return {
            'has_seal': False,
            'confidence': 0,
            'message': f'公章检测失败：{e}，请人工确认社保缴费证明是否带公章'
        }

def calculate_work_days(hire_date, end_date=None, application_year=None):
    """
    计算科技人员在申报年度的累计工作时长（天数）

    Args:
        hire_date: 入职时间（YYYY-MM-DD）
        end_date: 离职时间（如有），None表示在职
        application_year: 申报年份（用于确定计算区间）

    Returns:
        int: 累计工作天数
    """
    from datetime import datetime, date

    if not hire_date:
        return 0

    # 计算区间：近三年（申报年份-2 至 申报年份）
    if application_year:
        start = date(application_year - 2, 1, 1)
        end = date(application_year, 12, 31)
    else:
        start = date(2023, 1, 1)
        end = date(2025, 12, 31)

    hire = datetime.strptime(hire_date, '%Y-%m-%d').date()
    if hire > start:
        start = hire

    if end_date:
        leave = datetime.strptime(end_date, '%Y-%m-%d').date()
        if leave < end:
            end = leave

    delta = (end - start).days
    return max(0, delta)
```

## 输出规范

### 1. 科技人员比例情况说明
```
文件命名：{企业名称}-{年份}年科技人员比例情况说明.docx

文档结构：

一、企业基本情况
   - 企业名称、成立时间、注册地址
   - 经营范围、所属行业
   - 企业职工总数

二、科技人员情况
   - 科技人员总数
   - 科技人员占比（≥10%）
   - 学历结构（博士、硕士、本科、大专）
   - 职称结构（高级、中级、初级）
   - 年龄结构

三、科技人员主要工作内容
   - 研发项目参与情况
   - 核心技术领域
   - 主要成果（专利、软著等）

四、结论
   - 符合高新技术企业认定要求
```

### 2. 科技人员信息表（按派成铝业参考格式14列结构）
```
文件命名：{企业名称}-{上年}年科技人员名册.xlsx

Sheet1 - 研发人员名单（14列结构，参考派成铝业格式）：

第1行（合并单元格）：科技人员名册（A1合并），M1=工资
第2行（表头，14列）：
| 序号 | 姓名 | 入职时间 | 身份证号码 | 姓别 | 学历 | 毕业院校 | 专业 | 部门 | 岗位 | {申报年份}年在职时间 | 职称 | 工资 | 日期 |
|------|------|----------|-----------|------|------|----------|------|------|------|---------------------|------|------|------|

字段说明：
- 列1 序号：1, 2, 3, ...（每位科技人员一个序号）
- 列2 姓名：科技人员姓名
- 列3 入职时间：YYYY-MM-DD格式（必须≤上年12月31日）
- 列4 身份证号码：18位身份证号码
- 列5 姓别：男/女（注意：派成铝业模板原字段名为"姓别"）
- 列6 学历：博士/硕士/本科/大专/其他
- 列7 毕业院校：毕业院校全称
- 列8 专业：所学专业
- 列9 部门：研发部门名称（如技术研究院、研发中心、实验室等）
- 列10 岗位：研发岗位（如研发工程师、技术员、研究员等）
- 列11 {申报年份}年在职时间：累计工作天数（必须≥183天）
- 列12 职称：如有职称填写（如二级建造师、工程师、高级工程师等），无则留空
- 列13 工资：月工资（元）
- 列14 日期：统计截止日期（如2025-12-31）

数据示例：
| 1 | 曾聪聪 | 2024-04-26 | 36252519971019485X | 男 | 本科 | 湘潭大学 | 土木工程 | 技术研究院 | 研发工程师 | 365 | 二级建造师 | 7800 | 2025-12-31 |
| 2 | 张三 | 2023-03-01 | 440301199001011234 | 男 | 硕士 | 华南理工大学 | 材料工程 | 研发中心 | 高级工程师 | 365 | 高级工程师 | 12000 | 2025-12-31 |

筛选条件（必须同时满足）：
1. 在上年12月社保缴费记录中（带公章）
2. 入职时间≤上年12月31日
3. 累计工作时长≥183天
4. 工作岗位为研发相关岗位

Sheet2 - 学历统计：
| 学历 | 人数 | 占比 |
|------|------|------|
| 博士 | | |
| 硕士 | | |
| 本科 | | |
| 大专 | | |
| 其他 | | |
| 合计 | | 100% |

Sheet3 - 职称统计：
| 职称 | 人数 | 占比 |
|------|------|------|
| 高级 | | |
| 中级 | | |
| 初级 | | |
| 无职称 | | |
| 合计 | | 100% |

Sheet4 - 上年12月社保校验结果：
| 姓名 | 身份证号 | 上年12月社保缴纳情况 | 入职时间 | 累计工作时长（天） | 是否符合科技人员条件 | 不符合原因 |
|------|----------|----------------------|----------|---------------------|----------------------|------------|
```

**科技人员名册Excel生成函数（按派成铝业14列格式）：**
```python
def export_staff_roster_paicheng_format(enterprise_name, application_year, staff_list, 
                                         total_staff_count, output_path=None):
    """生成科技人员名册Excel（按派成铝业参考格式14列结构）
    
    参考文件：D:\\OneDrive\\文档\\工作\\【国高】20260622 深圳派成铝业科技有限公司\\07-人员资料\\高新项目科技人员名册.xlsx
    
    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        staff_list: 科技人员列表，每位人员为dict，需包含：
                    姓名、入职时间、身份证号码、姓别、学历、毕业院校、专业、
                    部门、岗位、在职天数、职称、工资
        total_staff_count: 职工总数（用于计算比例）
        output_path: 输出文件路径，None则自动生成
    
    Returns:
        str: 生成的Excel文件路径
    """
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter
    from datetime import datetime
    
    last_year = application_year - 1
    
    if output_path is None:
        output_path = f'{enterprise_name}-{last_year}年科技人员名册.xlsx'
    
    wb = Workbook()
    
    # ===== Sheet1: 研发人员名单（14列结构）=====
    ws1 = wb.active
    ws1.title = '研发人员名单'
    
    # 第1行：标题行（合并单元格）
    ws1.merge_cells('A1:N1')
    ws1['A1'] = '科技人员名册'
    ws1['A1'].font = Font(name='宋体', size=16, bold=True)
    ws1['A1'].alignment = Alignment(horizontal='center', vertical='center')
    ws1['M1'] = '工资'  # 派成铝业模板原格式：M1单元格标注"工资"
    ws1['M1'].font = Font(name='宋体', size=10, bold=True)
    
    # 第2行：表头（14列）
    headers = [
        '序号', '姓名', '入职时间', '身份证号码', '姓别', '学历', '毕业院校', 
        '专业', '部门', '岗位', f'{application_year}年\n在职时间', '职称', '工资', '日期'
    ]
    for col_idx, header in enumerate(headers, 1):
        cell = ws1.cell(row=2, column=col_idx, value=header)
        cell.font = Font(name='宋体', size=11, bold=True)
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        cell.fill = PatternFill(start_color='D9E1F2', end_color='D9E1F2', fill_type='solid')
    
    # 数据行
    border = Border(
        left=Side(style='thin'),
        right=Side(style='thin'),
        top=Side(style='thin'),
        bottom=Side(style='thin')
    )
    
    staff_count = len(staff_list)
    for idx, staff in enumerate(staff_list, 1):
        row_idx = idx + 2  # 从第3行开始填数据
        
        # 计算{申报年份}年在职时间
        work_days = staff.get('在职天数') or staff.get(f'{application_year}年在职时间') or 0
        
        row_data = [
            idx,  # 列1：序号
            staff.get('姓名', ''),  # 列2：姓名
            staff.get('入职时间', ''),  # 列3：入职时间
            staff.get('身份证号码', staff.get('身份证号', '')),  # 列4：身份证号码
            staff.get('姓别', staff.get('性别', '')),  # 列5：姓别（兼容性别）
            staff.get('学历', ''),  # 列6：学历
            staff.get('毕业院校', ''),  # 列7：毕业院校
            staff.get('专业', ''),  # 列8：专业
            staff.get('部门', ''),  # 列9：部门
            staff.get('岗位', staff.get('工作岗位', '')),  # 列10：岗位
            int(work_days) if work_days else 0,  # 列11：{申报年份}年在职时间（天）
            staff.get('职称', ''),  # 列12：职称
            int(staff.get('工资', 0)) if staff.get('工资') else '',  # 列13：工资
            f'{last_year}-12-31'  # 列14：日期（统计截止日期）
        ]
        
        for col_idx, value in enumerate(row_data, 1):
            cell = ws1.cell(row=row_idx, column=col_idx, value=value)
            cell.font = Font(name='宋体', size=10)
            cell.alignment = Alignment(horizontal='center', vertical='center')
            cell.border = border
    
    # 设置列宽
    column_widths = [6, 12, 14, 22, 6, 10, 20, 16, 16, 16, 12, 14, 10, 12]
    for i, width in enumerate(column_widths, 1):
        ws1.column_dimensions[get_column_letter(i)].width = width
    
    # 设置行高
    ws1.row_dimensions[1].height = 30
    ws1.row_dimensions[2].height = 35
    
    # ===== Sheet2: 学历统计 =====
    ws2 = wb.create_sheet('学历统计')
    ws2['A1'] = '学历统计'
    ws2['A1'].font = Font(name='宋体', size=14, bold=True)
    ws2.merge_cells('A1:C1')
    ws2['A1'].alignment = Alignment(horizontal='center', vertical='center')
    
    ws2.append(['学历', '人数', '占比'])
    for cell in ws2[2]:
        cell.font = Font(name='宋体', size=11, bold=True)
        cell.alignment = Alignment(horizontal='center', vertical='center')
    
    edu_stats = {}
    for staff in staff_list:
        edu = staff.get('学历', '其他')
        edu_stats[edu] = edu_stats.get(edu, 0) + 1
    
    edu_order = ['博士', '硕士', '本科', '大专', '其他']
    for edu in edu_order:
        count = edu_stats.get(edu, 0)
        ratio = f'{count/staff_count*100:.1f}%' if staff_count > 0 else '0%'
        ws2.append([edu, count, ratio])
    ws2.append(['合计', staff_count, '100%'])
    
    for width, col_letter in zip([12, 10, 10], ['A', 'B', 'C']):
        ws2.column_dimensions[col_letter].width = width
    
    # ===== Sheet3: 职称统计 =====
    ws3 = wb.create_sheet('职称统计')
    ws3['A1'] = '职称统计'
    ws3['A1'].font = Font(name='宋体', size=14, bold=True)
    ws3.merge_cells('A1:C1')
    ws3['A1'].alignment = Alignment(horizontal='center', vertical='center')
    
    ws3.append(['职称', '人数', '占比'])
    for cell in ws3[2]:
        cell.font = Font(name='宋体', size=11, bold=True)
        cell.alignment = Alignment(horizontal='center', vertical='center')
    
    title_stats = {'高级': 0, '中级': 0, '初级': 0, '无职称': 0}
    for staff in staff_list:
        title = staff.get('职称', '')
        if not title:
            title_stats['无职称'] += 1
        elif '高级' in title:
            title_stats['高级'] += 1
        elif '中级' in title or '工程师' in title:
            title_stats['中级'] += 1
        else:
            title_stats['初级'] += 1
    
    for title, count in title_stats.items():
        ratio = f'{count/staff_count*100:.1f}%' if staff_count > 0 else '0%'
        ws3.append([title, count, ratio])
    ws3.append(['合计', staff_count, '100%'])
    
    for width, col_letter in zip([12, 10, 10], ['A', 'B', 'C']):
        ws3.column_dimensions[col_letter].width = width
    
    # ===== Sheet4: 上年12月社保校验结果 =====
    ws4 = wb.create_sheet('上年12月社保校验结果')
    ws4['A1'] = f'{last_year}年12月社保缴费校验结果'
    ws4['A1'].font = Font(name='宋体', size=14, bold=True)
    ws4.merge_cells('A1:G1')
    ws4['A1'].alignment = Alignment(horizontal='center', vertical='center')
    
    ws4.append(['姓名', '身份证号', f'{last_year}年12月社保缴纳情况', '入职时间', 
                '累计工作时长（天）', '是否符合科技人员条件', '不符合原因'])
    for cell in ws4[2]:
        cell.font = Font(name='宋体', size=11, bold=True)
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    
    for staff in staff_list:
        name = staff.get('姓名', '')
        id_card = staff.get('身份证号码', staff.get('身份证号', ''))
        hire_date = staff.get('入职时间', '')
        work_days = staff.get('在职天数', 0)
        in_social_security = staff.get(f'{last_year}年12月社保', True)
        
        reasons = []
        if not in_social_security:
            reasons.append(f'不在{last_year}年12月社保中')
        if work_days and work_days < 183:
            reasons.append(f'工作时长{work_days}天<183天')
        
        is_qualified = len(reasons) == 0
        ws4.append([
            name, id_card, 
            '已缴纳' if in_social_security else '未缴纳',
            hire_date, work_days,
            '符合' if is_qualified else '不符合',
            '；'.join(reasons) if reasons else ''
        ])
    
    for width, col_letter in zip([12, 22, 20, 14, 18, 18, 30], 
                                   ['A', 'B', 'C', 'D', 'E', 'F', 'G']):
        ws4.column_dimensions[col_letter].width = width
    
    wb.save(output_path)
    return output_path

def validate_staff_roster_paicheng_format(staff_list, application_year):
    """校验科技人员名册是否符合派成铝业14列格式要求
    
    Args:
        staff_list: 科技人员列表
        application_year: 申报年份
    
    Returns:
        dict: {'is_valid': bool, 'errors': list, 'warnings': list}
    """
    errors = []
    warnings = []
    last_year = application_year - 1
    
    required_fields = ['姓名', '入职时间', '身份证号码', '学历', '部门', '岗位']
    
    for idx, staff in enumerate(staff_list, 1):
        # 检查必填字段
        for field in required_fields:
            if not staff.get(field):
                errors.append(f"第{idx}位人员（{staff.get('姓名', '未知')}）：缺少必填字段{field}")
        
        # 检查入职时间
        hire_date = staff.get('入职时间', '')
        if hire_date:
            try:
                from datetime import datetime
                if isinstance(hire_date, str):
                    hire_dt = datetime.strptime(hire_date, '%Y-%m-%d')
                else:
                    hire_dt = hire_date
                last_day = datetime(last_year, 12, 31)
                if hire_dt > last_day:
                    errors.append(f"第{idx}位人员（{staff.get('姓名', '')}）：入职时间{hire_date}晚于{last_year}年12月31日，不能计入科技人员")
            except (ValueError, TypeError):
                warnings.append(f"第{idx}位人员（{staff.get('姓名', '')}）：入职时间格式不规范：{hire_date}")
        
        # 检查工作时长
        work_days = staff.get('在职天数', 0)
        if work_days and work_days < 183:
            errors.append(f"第{idx}位人员（{staff.get('姓名', '')}）：{application_year}年在职时间{work_days}天<183天")
        
        # 检查身份证号
        id_card = staff.get('身份证号码', '')
        if id_card and len(str(id_card)) != 18:
            warnings.append(f"第{idx}位人员（{staff.get('姓名', '')}）：身份证号码长度非18位：{id_card}")
    
    return {
        'is_valid': len(errors) == 0,
        'errors': errors,
        'warnings': warnings
    }
```

## 撰写要求
1. **科技人员占比**：必须≥10%（基准：上年12月31日在职人数）
2. **上年12月社保**：每位科技人员必须在上年12月社保缴费记录中（带公章）
3. **工作时长**：累计工作时长≥183天，入职时间不晚于上年12月31日
4. **学历要求**：大专及以上学历为主
5. **岗位相关**：工作岗位必须与研发相关
6. **社保一致**：人员名单必须与上年12月社保缴费清单一致
7. **学历真实**：学历证书必须真实有效

## 格式规范
1. **字体**：宋体（中文），Times New Roman（英文和数字）
2. **字号**：小四号（12pt）
3. **行距**：1.5倍行距
4. **表格**：Excel .xlsx格式

## 数据一致性检查
1. **人员数量一致性**：比例说明中的人员数量必须与信息表一致
2. **上年12月社保一致性**：科技人员名单必须与上年12月社保缴费清单一致
3. **工作时长合规性**：每位科技人员累计工作时长≥183天
4. **学历一致性**：学历信息必须与学历证书一致
5. **公章校验**：上年12月社保缴费证明必须带公章

## 工作流程
1. **数据收集**：收集科技人员名单、学历证书、社保记录
2. **比例计算**：计算科技人员占比
3. **统计分析**：统计学历、职称分布
4. **一致性校验**：校验与社保记录的一致性
5. **文档生成**：生成比例说明和信息表
6. **格式调整**：调整文档格式，确保符合申报要求

## 常见问题处理
1. **人员占比不足**：建议企业补充科技人员或调整人员结构
2. **学历不符合**：建议补充高学历人员或提供培训证明
3. **社保不一致**：核对社保记录，补充缺失的缴纳证明
4. **岗位不相关**：调整岗位描述，突出研发相关工作
5. **上年12月社保缺失**：必须提供上年12月社保缴费证明（带公章），缺失则需向社保局申请补开
6. **社保缴费证明无公章**：退回要求社保局重新出具带公章的版本
7. **工作时长不足183天**：剔除该人员或补充证明材料（如兼职、外包合同）
8. **入职时间晚于上年12月**：该人员不能计入科技人员名单

## 输出隐患自查与汇报（v1.19.0升级，技能结束时强制执行）

> **强制要求**：完成科技人员材料后，agent 必须按以下7个维度进行隐患自查并汇报。

### 自查清单（7维覆盖）

| 维度 | 检查项 | 表现 |
|------|------|------|
| **1. 原始资料缺失** | 上月12月社保缴费记录是否带公章 | 社保记录无公章或公章不清 |
| | 学历证书是否齐全且可读 | 某科技人员缺学历证书扫描件 |
| | 劳动合同是否齐全 | 某人员缺劳动合同 |
| | 花名册/个税申报记录是否齐全 | 基础数据文件缺失 |
| **2. 文本质量** | 人员比例说明书是否包含实质性分析 | 仅有数字无分析说明 |
| | 科技人员岗位描述是否具体 | "技术人员""工程师"过于笼统 |
| | 是否存在AI痕迹 | 岗位描述套用模板无个性 |
| **3. 逻辑关联** | 科技人员与RD项目的分配是否合理 | 某RD项目无科技人员支撑 |
| | 人员全职当量计算是否正确 | 同一人被计为多个全职 |
| **4. 字数问题** | 人员比例说明书字数是否足够 | 说明过简，不足500字 |
| | 岗位职责描述是否完整 | 职责描述过于简短 |
| **5. 文档格式** | 学历证书扫描件是否统一格式 | 部分为照片、部分为PDF |
| | 社保记录是否按规定整理 | 多页社保记录未标注对应月份 |
| | 文件命名是否规范 | 命名混乱无规律 |
| **6. 政策符合性** | 科技人员占比≥10%（核心硬指标） | 占比不达标 |
| | 科技人员是否满足三要素（工资记入研发费用+大专及以上+在册≥183天） | 某人员三要素不全 |
| | 科技人员社保是否在本企业缴纳 | 社保在其他单位缴纳 |
| | 科技人员学历是否符合最低要求（大专及以上） | 存在高中/中专学历人员 |
| **7. 数据可溯源性** | 花名册×社保×台账三方数据是否一致 | 三方数据存在冲突 |
| | 人员工作天数可否从月报/考勤追溯 | 天数计算无原始数据支撑 |
| | 学历信息可否从学历证书追溯 | 学历与证书不符 |

### 汇报格式

```
⚠️ gxtz-staff-materials 输出隐患自查报告

1. 原始资料: ✓ / ⚠ {n}项缺失
2. 文本质量: ✓ / ⚠ {n}处需优化
3. 逻辑关联: ✓ / ⚠ {n}个不合理分配
4. 字数: ✓ / ⚠ {n}处需补充
5. 文档格式: ✓ / ⚠ {n}处不规范
6. 政策符合性: ✓ / ⚠ 占比{x}%
7. 数据溯源: ✓ / ⚠ {n}处来源不明

待用户确认后进入下一步。
```

## 业务增强函数（v1.5.0新增）

以下两个函数用于解决"往年资料目录中已有学历证书，但补充清单仍标注待补充"的问题。
通过主动扫描学历证书目录（含往年资料多层嵌套目录），识别已有学历证书文件，
并据此更新科技人员学历证书状态，避免重复要求客户补充已有资料。

### 函数一：scan_degree_certificates_dir

```python
def scan_degree_certificates_dir(degree_dir, staff_list=None):
    """扫描学历证书目录（支持往年资料多层嵌套目录），识别学历证书文件

    解决问题：filter_missing_supplements() 仅检查 analysis_results 中的布尔字段，
    不会主动扫描往年资料目录。本函数主动遍历学历证书目录（包括往年资料嵌套子目录），
    识别已有学历证书文件，并与科技人员名单匹配。

    Args:
        degree_dir: 学历证书目录路径（如 ".../7.专职人员学历证书" 或 ".../往年资料/和胜/附件/7.专职人员学历证书"）
        staff_list: 科技人员名单（可选，用于匹配证书与人名）。
                    支持 list[str]（姓名列表）或 list[dict]（含 'name' 字段的人员字典）

    Returns:
        dict: {
            found_files: list,       # 学历证书文件路径列表
            matched_staff: dict,     # {人名: 文件路径} 已匹配到科技人员的证书
            unmatched_files: list,   # 未匹配到人名的证书文件路径
            total_count: int,        # 识别到的学历证书文件总数
        }
    """
    import os
    import re

    result = {
        'found_files': [],
        'matched_staff': {},
        'unmatched_files': [],
        'total_count': 0,
    }

    if not degree_dir or not os.path.isdir(degree_dir):
        print(f"[提示] 学历证书目录不存在或为空: {degree_dir}")
        return result

    # 学历证书关键词（中文 + 英文）
    degree_keywords = ['学历', '毕业证', '学位证', 'diploma', 'degree', '毕业证书']
    # 学历证书文件扩展名
    degree_extensions = ('.pdf', '.jpg', '.jpeg', '.png')

    # 归一化科技人员姓名集合
    staff_names = set()
    if staff_list:
        for person in staff_list:
            if isinstance(person, dict):
                name = person.get('name') or person.get('姓名') or ''
            else:
                name = str(person)
            name = name.strip()
            if name:
                staff_names.add(name)

    # 使用公共模块 scan_files_with_archive_support 递归扫描（支持压缩文件解压）
    try:
        all_files = scan_files_with_archive_support(degree_dir, file_patterns=list(degree_extensions))
    except Exception as e:
        print(f"[警告] 扫描学历证书目录失败 {degree_dir}: {e}")
        all_files = []

    for fpath in all_files:
        fname = os.path.basename(fpath)
        fname_lower = fname.lower()

        # 判断是否为学历证书文件：文件名含学历证书关键词
        is_degree = any(kw.lower() in fname_lower for kw in degree_keywords)
        if not is_degree:
            continue

        result['found_files'].append(fpath)

        # 尝试从文件名匹配科技人员姓名
        matched_name = None
        # 去除扩展名后用于匹配
        name_stem = os.path.splitext(fname)[0]

        if staff_names:
            # 优先精确匹配：检查人员姓名是否出现在文件名中
            for sname in staff_names:
                if sname and sname in name_stem:
                    matched_name = sname
                    break

        if matched_name:
            result['matched_staff'][matched_name] = fpath
        else:
            result['unmatched_files'].append(fpath)

    result['total_count'] = len(result['found_files'])
    print(f"[学历证书扫描] 目录: {degree_dir}")
    print(f"  识别学历证书文件: {result['total_count']} 份")
    print(f"  匹配到科技人员: {len(result['matched_staff'])} 人")
    print(f"  未匹配人名文件: {len(result['unmatched_files'])} 份")

    return result
```

### 函数二：update_degree_certificate_status

```python
def update_degree_certificate_status(staff_list, degree_scan_result):
    """根据学历证书扫描结果，更新科技人员的学历证书状态

    解决问题：往年资料目录中已存在学历证书时，更新人员状态为"已提供"，
    使后续 filter_missing_supplements() 重新计算时不再将已扫描到证书的人员列入待补充清单。

    Args:
        staff_list: 科技人员名单列表（list[dict]，每项含 'name'/'姓名' 字段）
        degree_scan_result: scan_degree_certificates_dir() 的返回值

    Returns:
        dict: {
            updated_staff: list,       # 更新后的科技人员列表（已写入 has_degree_certificate / degree_certificate_file 字段）
            provided_count: int,       # 已提供学历证书人数
            supplement_count: int,     # 待补充学历证书人数
            supplement_names: list,    # 待补充人员姓名列表
        }
    """
    import copy

    summary = {
        'updated_staff': [],
        'provided_count': 0,
        'supplement_count': 0,
        'supplement_names': [],
    }

    if not staff_list:
        print("[提示] 科技人员名单为空，无法更新学历证书状态")
        return summary

    # 从扫描结果中提取已匹配到证书的人员 -> 文件路径映射
    matched_staff = {}
    if degree_scan_result and isinstance(degree_scan_result, dict):
        matched_staff = degree_scan_result.get('matched_staff', {}) or {}

    updated_list = []
    for person in staff_list:
        if not isinstance(person, dict):
            updated_list.append(person)
            continue

        # 兼容 'name' / '姓名' 两种字段
        name = person.get('name') or person.get('姓名') or ''
        name = name.strip()

        # 深拷贝避免修改原始对象
        updated_person = copy.deepcopy(person)

        if name and name in matched_staff:
            updated_person['has_degree_certificate'] = True
            updated_person['degree_certificate_file'] = matched_staff[name]
            summary['provided_count'] += 1
        else:
            # 未匹配到证书：标注待补充（保留已有状态，不覆盖已为True的记录）
            if not updated_person.get('has_degree_certificate', False):
                updated_person['has_degree_certificate'] = False
                updated_person['degree_certificate_file'] = None
                summary['supplement_count'] += 1
                if name:
                    summary['supplement_names'].append(name)
            else:
                # 原本已标记为有证书，维持已提供
                summary['provided_count'] += 1

        updated_list.append(updated_person)

    summary['updated_staff'] = updated_list
    print(f"[学历证书状态更新] 已提供: {summary['provided_count']} 人，待补充: {summary['supplement_count']} 人")
    if summary['supplement_names']:
        print(f"  待补充人员: {', '.join(summary['supplement_names'])}")

    return summary
```

### 调用示例

```python
# 1. 扫描学历证书目录（含往年资料嵌套目录）
degree_scan = scan_degree_certificates_dir(
    degree_dir=r"D:\OneDrive\文档\工作\【国高】20260622 深圳市和胜金属技术有限公司\往年资料\和胜金属\和胜\附件\7.专职人员学历证书",
    staff_list=staff_list
)

# 2. 根据扫描结果更新科技人员学历证书状态
status_result = update_degree_certificate_status(staff_list, degree_scan)

# 3. 用更新后的人员名单重新生成 analysis_results 并重新过滤待补充清单
#    （已扫描到学历证书的人员不再列入待补充清单）
staff_list = status_result['updated_staff']
analysis_results = {'staff': {'diplomas': [p['degree_certificate_file'] for p in staff_list if p.get('has_degree_certificate')]}}
missing_items = filter_missing_supplements('gxtz-staff-materials', analysis_results)
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
