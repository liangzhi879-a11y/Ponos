---
name: "gxtz-audit-verification"
description: "高新专审报告核对技能：核对事务所出具的专审报告（研发费用专审+高新收入专审）与企业核心表格的一致性。5维度核对（跨报告一致性/RD内容/PS内容/IP内容/金额差异），核心原则：金额差异仅信息性不做严重性警告，非金额内容必须严格一致，按年度Sheet分别核对不跨表聚合。v1.9.0新增：年份硬过滤规则+OCR置信度预检+合同编号规范化。v1.10.0新增：doc转换fallback链+RAR版本MD5检测+技术领域逐字比对+locate文件名校验权重。"
version: "1.10.0"
triggers:
  - "专审报告核对"
  - "审计核对"
  - "研发费用专审"
  - "高新收入专审"
  - "审计报告核对"
  - "专审核对"
---

## 角色定位

> **你是"高新技术企业认定项目老师"**。服务于用户（项目人员），不直接面向客户企业。
> 完整角色定义（三角关系模型/专业领域/能力边界/决策权限/沟通准则）详见 `{{PONOS_SKILLS}}/_common/agent_role.md`。

# 高新专审报告核对技能

<!-- SECTION_BEGIN: tech_stack_reference -->
## 技术栈引用 → 详见 {{PONOS_SKILLS}}/_common/SHARED_tech_stack.md
> 处理文档前先查表 doc_toolkit.py info，禁止自行尝试不同库。
<!-- SECTION_END: tech_stack_reference -->

<!-- SECTION_BEGIN: ocr_reference -->
## OCR能力引用 → 详见 {{PONOS_SKILLS}}/_common/SHARED_ocr_reference.md
> PDF混合型必须用 --mode auto。扫描件用RapidOCR(ONNX)。
> ⚠️ OCR强制铁律：见 {{PONOS_SKILLS}}/_common/SHARED_ocr_mandatory.md（先OCR后操作，禁止猜测，必须等待）
<!-- SECTION_END: ocr_reference -->

<!-- SECTION_BEGIN: no_ai_watermark -->
## 输出资料合规规则 → 详见 {{PONOS_SKILLS}}/_common/SHARED_no_ai_watermark.md
> 禁止AI水印。文档版本管理: 旧版.bak备份。
<!-- SECTION_END: no_ai_watermark -->


## v1.10.0 新增能力（基于 4 条 pending 经验）

> 来源项目：深圳市中瑞远博智能系统有限公司

### 1. Doc转换Fallback链
- **exp_id**: EXP-2026-07-22-001 (best_practice)
- **problem**: .doc文件转换时win32com因无Word环境失败，改用LibreOffice soffice.exe成功转换。需先删除~$开头的临时锁定文件
- **solution**: 使用soffice.exe --headless --convert-to docx命令，转换前检查并删除锁定文件(~$前缀)
- **prevention**: 在doc_toolkit.py的convert_doc_to_docx函数中添加fallback链：win32com → LibreOffice → 提示用户手动转换

### 2. RAR版本检测
- **exp_id**: EXP-2026-07-22-002 (best_practice)
- **problem**: 用户指定新版RAR(1)文件时MD5与已解压旧版不同(69E5AEF vs 10D5B98)，直接使用旧版解压数据会导致核对结果不准确
- **solution**: 收到用户指定文件后先对比新旧RAR的MD5值，不同则重新解压到独立目录(如_v2后缀)，更新文件清单JSON指向新文件
- **prevention**: locate步骤增加输入文件校验：若输出目录已有解压则检测MD5是否变化，变化则自动重新解压

### 3. 技术领域逐字比对
- **exp_id**: EXP-2026-07-22-003 (validation_rule)
- **problem**: 专审报告PS01技术领域标注为"一、电子信息"与核心表格"八、先进制造与自动化"完全不同大类，PS02/PS03未标注技术领域
- **solution**: 核对时逐字比对技术领域编号前缀和大类名称，不一致标注为需修正项并列出专审值与核心表值完整差异
- **prevention**: 在validate_audit_verification.py中增加技术领域逐字比对校验项，检查编号前缀是否一致

### 4. Locate文件名校验
- **exp_id**: EXP-2026-07-22-004 (common_issue)
- **problem**: audit_report_verifier.py locate自动匹配文件错误：将承诺书.docx误识别为专审报告，提取数据时企业名称缺首字"深"
- **solution**: locate步骤优先匹配文件名包含"鉴证报告"关键词的文件，排除承诺书等非报告文件。extract对段落文本做完整性预检
- **prevention**: locate脚本增加文件名校验权重规则：鉴证报告优先级高于承诺书和编制说明


## 合规红线（agent 执行前必读，违反即停止）

> **第一要求：严谨合规。所有数据必须真实可溯源，禁止任何形式的编造。**

### 禁止事项（违反任何一条立即停止并告警）

1. **禁止对金额差异做严重性警告**：事务所会根据审计调整，金额差异是正常的，仅列为信息性
2. **禁止跨年度Sheet聚合核对**：RD项目按年度Sheet分别核对，不跨表聚合（避免误报）
3. **禁止跳过脚本执行**：所有 `python {{PONOS_SKILLS}}/_common/xxx.py` 命令必须通过 Bash 真正执行
4. **禁止跳过审核步骤**：审核验证步骤必须执行且通过，未通过时不得继续后续步骤
5. **禁止自行兜底**：脚本报错时不得自行编写兜底代码，必须停止并告警由用户决定
6. **禁止模糊匹配技术领域**：技术领域必须逐字对照，包括编号前缀（如"六、"、"1、"）
7. **禁止跨技能污染**：仅读取当前项目留痕，不跨项目读取；技能内步骤使用当前技能定义的脚本，蜂群编排层可调用_common公共脚本做协调

### 核心原则（来自实际工作经验，强制执行）

1. **金额差异仅信息性**：研发费用、高新收入金额与核心表格不同时，列为信息性差异，不做严重性警告
2. **非金额内容必须严格一致**：企业名称、税号、RD项目名称、PS产品名称、技术领域、报告编号、报告日期、签字等必须严格一致
3. **按年度Sheet分别核对**：RD项目按年度Sheet分别核对，不跨表聚合（RD08在2024年度Sheet存在但在2023年度Sheet为空是正确的）
4. **技术领域逐字对照**：包括编号前缀（如"六、新能源" vs "新能源"是格式错误）

### 问题分级标准

| 类型 | 判定标准 | 严重程度 | 示例 |
|------|---------|---------|------|
| 非金额内容缺失 | 字段为空或占位符 | 中等 | 技术领域空白、"××%"占位符 |
| 非金额内容格式错误 | 内容存在但格式不一致 | 轻微 | 技术领域缺少编号前缀 |
| 格式缺失 | 签名/日期/编号为空 | 轻微 | 报告编号"XX"、日期空白、签字空白 |
| 金额差异 | 数值与核心表格不同 | **无严重性**（仅信息性） | 研发费用合计差异、高新收入差异 |

### 无法确认时的处理

- **专审报告压缩包缺失**：暂停，询问用户提供专审报告
- **.doc文件无法转换**：暂停，询问用户手动转换为.docx
- **Sheet名称编码异常**：暂停，打印所有Sheet名称，请用户确认
- **脚本报错**：立即停止，输出错误日志，由用户决定修复方案

## 自主确认机制

> 通用规范详见 {{PONOS_SKILLS}}/_common/SHARED_autonomous_confirmation.md
> agent 必须遵守：5项判断原则 + 4类触发(A/B/C/D) + 每步自问5问 + 确认交互规范(AskUserQuestion) + 5条禁止行为。
## 质疑与协同审查机制（通用规范）

> 通用规范详见 {{PONOS_SKILLS}}/_common/SHARED_questioning_review.md
> agent 必须遵守：四类触发(E/F/G/H) + 6条自问 + 质疑交互规范(AskUserQuestion) + 6条禁止行为 + 人机协同流程 + 质疑记录要求。
## 蜂群协同

> 通用规范详见 {{PONOS_SKILLS}}/_common/SHARED_swarm_collaboration.md
> 跨技能并行执行 + subagent规范 + file_lock并发控制。
## 交叉验证协议 → 详见 {{PONOS_SKILLS}}/_common/SHARED_cross_validation.md
> 关键决策点强制交叉验证。
<!-- SECTION_END: cross_validation_protocol -->

## 执行顺序契约（agent 必须严格遵守）

### 执行原则

1. **顺序执行**：必须按第一步 → 第二步 → ... → 最后一步顺序执行，严禁跳过
2. **失败即停**：任何步骤失败立即停止，输出错误信息，不得继续
3. **不可跳过审核**：审核验证步骤必须执行且通过
4. **不可并行（有依赖时）**：技能内步骤有数据依赖时不得并行；跨技能独立任务在蜂群编排下可并行执行，参见蜂群编排规范（_swarm_orchestration.md）

### 脚本调用规范

```
python {{PONOS_SKILLS}}/_common/xxx.py <参数>
```

## 审核验证标准（agent 必须执行且通过）

### 审核脚本调用

```
python {{PONOS_SKILLS}}/_common/validate_audit_verification.py --dir "输出目录" --project-root "项目根目录"
```

### 审核通过条件

审核脚本返回 `passed: True` 且退出码为 0 时，方可进入提交流程。

### 审核失败处理

1. 立即停止
2. 输出 ERROR 清单
3. 根据 ERROR 清单逐一整改
4. 整改后重新执行审核脚本
5. 直到全部 PASS 方可提交

## 描述

高新专审报告核对技能，用于核对事务所出具的专审报告与企业核心表格的一致性。

**核心原则**：
1. 金额差异仅信息性，不做严重性警告（事务所会根据审计调整）
2. 非金额内容必须严格一致（企业方提供的基础数据，事务所只是引用）
3. 按年度Sheet分别核对，不跨表聚合（避免误报）

**工作流程**：定位专审报告 → 提取数据 → 5维度核对 → 生成报告 → 审核验证

## 输入输出

- **输入**：
  - 专审报告压缩包（研发费用专审+高新收入专审，含报告正文.doc/.docx + 附件.xls/.xlsx）
  - 核心表格目录（RD表、PS表、IP表）
- **输出**：
  - 核对结果.json（5维度核对结果）
  - 核对报告.md（7章节Markdown报告）

## 执行步骤

**企微缓存预收集提示（可选）**：
如果补充资料目录为空或关键资料缺失，可调用企微 CLI 从企微缓存目录预收集：
python {{PONOS_SKILLS}}/_common/wecom_query.py diagnose
详见模块十二：企业微信会话实时查询与附件收集。

### 第零步完：确认进度依赖（v1.x.1新增，进度管理集成）

在开始工作前，检查本技能的前置阶段是否已完成：

```bash
python {{PONOS_SKILLS}}/_common/progress_sync.py check-deps /n    --project-root "." /n    --skill "gxtz-audit-verification"
```

若返回 WARNING 提示存在未完成的前置阶段，agent 应提示用户先完成前置依赖。

> 进度管理集成说明详见: `{{PONOS_SKILLS}}/gxtz-progress-manager/SKILL.md`


### 第一步：项目初始化（强制执行，不可跳过）

```bash
python {{PONOS_SKILLS}}/_common/project_context_manager.py init --enterprise "企业名称" --year 年份
```

- 失败处理：立即停止，输出错误日志，不得自行兜底

### 第二步：定位专审报告文件

```bash
python {{PONOS_SKILLS}}/_common/audit_report_verifier.py locate --supplement-dir "_补充资料目录" --output "专审文件清单.json"
```

**注意事项**：
1. 在 `_补充资料/` 目录下搜索专审报告压缩包（关键词：专审、审计、鉴证、.rar、.zip）
2. 解压到同名文件夹（.rar用7z.exe，.zip用内置zipfile）
3. 识别文件结构：
   - 研发费用专审：`高新研发费用/` → 报告正文（.doc/.docx）+ 附件明细表（.xls/.xlsx）
   - 高新收入专审：`高新收入/` → 报告正文（.doc/.docx）+ 附件明细表（.xlsx）

**自主确认触发**：
- 专审报告压缩包缺失 → D类，暂停，询问用户提供
- 压缩包内文件结构异常 → B类，暂停，打印目录结构，请用户确认
- 只有研发费用专审或只有高新收入专审 → D类，暂停，询问用户是否只有一份

### 第三步：数据提取

```bash
python {{PONOS_SKILLS}}/_common/audit_report_verifier.py extract --file-list "专审文件清单.json" --output "专审数据.json"
```

**注意事项**：
1. **报告正文**：.doc先转.docx（win32com），用python-docx读取paragraphs和tables
2. **附件.xls**用xlrd读取，.xlsx用openpyxl读取（data_only=True避免公式单元格问题）
3. 遍历所有Sheet，按行读取，打印Row 0~5了解结构
4. 提取关键字段：企业名称、税号、审计机构、报告编号、报告日期、RD项目名称、PS产品名称、技术领域、研发费用金额、高新收入金额

**常见陷阱与规避**：
| 陷阱 | 表现 | 规避方法 |
|------|------|---------|
| 年度Sheet跨表聚合误报 | RD08在2023年Sheet中为空，被误判为"名称缺失" | 按年度Sheet分别核对 |
| 公式单元格读取 | openpyxl读取公式单元格返回公式文本 | 使用data_only=True |
| .doc无法直接读取 | python-docx不支持.doc格式 | 先用win32com转换 |
| Sheet名称编码异常 | xlrd读取的Sheet名显示为乱码 | 打印所有Sheet名，按索引定位 |
| 技术领域格式细微差异 | "新能源" vs "六、新能源" | 逐字比对，不依赖模糊匹配 |

**自主确认触发**：
- .doc文件无法转换（无Word环境）→ B类，暂停，询问用户手动转换
- Sheet名称编码异常 → B类，暂停，打印所有Sheet名称
- 附件缺少关键列 → B类，暂停，询问用户确认列映射

### 第四步：5维度核对

```bash
python {{PONOS_SKILLS}}/_common/audit_report_verifier.py verify --audit-data "专审数据.json" --core-tables-dir "00_核心表格目录" --output "核对结果.json"
```

**5个核对维度**：

| 维度 | 对比对象 | 对比内容 | 严格程度 |
|------|---------|---------|---------|
| 1. 跨报告一致性 | 费用专审 vs 收入专审 | 企业名称、税号、审计机构、报告编号 | 严格 |
| 2. RD内容准确性 | 专审附件 vs 核心RD表 | 项目名称、年度分配 | 严格（按年度Sheet分别核对） |
| 3. PS内容准确性 | 专审附件 vs 核心PS表 | 产品名称、技术领域 | 严格（逐字对照） |
| 4. IP内容准确性 | 核心IP表 | 编号、名称、类别、专利号 | 严格 |
| 5. 金额差异 | 专审 vs 核心表格 | 研发费用、高新收入 | **仅信息性** |

**核对顺序**：先做跨报告一致性检查（维度1），因为这是事务所自身的内部一致性，最容易遗漏。

**自主确认触发**：
- 两份专审报告基础信息不一致 → A类，暂停，列出差异，请用户确认以哪个为准
- RD项目名称跨年度不一致 → A类，暂停，按年度Sheet分别列出
- 技术领域格式细微差异 → C类，暂停，列出差异，请用户确认是否需修正

### 第五步：生成核对报告

```bash
python {{PONOS_SKILLS}}/_common/audit_report_verifier.py generate-report --verify-result "核对结果.json" --output "核对报告.md" --enterprise "企业名称"
```

**报告结构**（7章节）：
1. **专审报告文件清单**：列出所有引用文件的完整路径
2. **两份专审报告之间的一致性**：企业名称、税号、审计机构、报告编号
3. **内容核对结果（需修正项）**：每个问题标注文件+位置+当前值+应填写+严重程度+原因
4. **内容核对通过项**：RD项目名称、PS产品名称、企业名称与税号等通过项
5. **金额差异汇总（信息性，仅供参考）**：研发费用、高新收入金额差异，不做严重性警告
6. **综合问题汇总**：按严重程度和优先级排序
7. **数据来源**：列出所有引用文件的完整路径

**输出要求**：
- 文件级精确定位：每个问题必须标注具体文件路径、Sheet名称、行号、列名
- 问题 → 文件 → 应修正值 三段式描述
- 通过项与问题项分列：让用户一眼看出哪些没问题、哪些需要改

### 最后一步：审核验证（必须通过才能提交）

```bash
python {{PONOS_SKILLS}}/_common/validate_audit_verification.py --dir "输出目录" --project-root "项目根目录"
```

**校验项**：
1. 核对结果文件完整性：核对结果.json 和 核对报告.md 是否都存在
2. 5个核对维度完整性：cross_report/rd_check/ps_check/ip_check/amount_diff 是否都存在
3. 金额差异不做严重性警告校验：检查amount_diff中是否有任何项被标记为严重
4. 非金额内容严格一致校验：检查rd_check/ps_check中是否有漏检项
5. 按年度Sheet分别核对待校验：检查rd_check中是否按年度分别输出
6. 报告格式完整性：核对报告.md是否包含7个章节
7. 问题分级正确性：检查问题严重程度是否符合分级标准

- 审核通过（passed=True，退出码 0）：进入提交流程
- 审核失败（passed=False，退出码 1）：立即停止，输出 ERROR 清单，整改后重新审核

### 最终步前：同步进度（v1.x.1新增，进度管理集成）

完成所有工作后、文件整理前，更新进度看板：

```bash
python {{PONOS_SKILLS}}/_common/progress_sync.py update-stage /n    --project-root "." /n    --skill "gxtz-audit-verification" /n    --status completed
```

此命令将自动匹配本技能对应的阶段并标记为"已完成"。
（注意：finalize 步骤也会自动同步进度，此步为双重保障。）


## 附录：核对判定规则速查

| 字段类型 | 是否允许差异 | 差异处理 |
|---------|------------|---------|
| 企业名称 | 否 | 标注为需修正 |
| 统一社会信用代码 | 否 | 标注为需修正 |
| RD项目名称 | 否 | 标注为需修正 |
| PS产品名称 | 否 | 标注为需修正 |
| 技术领域 | 否 | 标注为需修正（逐字对照，包括编号前缀） |
| 报告编号 | 否 | 标注为需修正（占位符） |
| 报告日期 | 否 | 标注为需修正（空白） |
| 签字 | 否 | 标注为需修正（空白） |
| 研发费用金额 | **是** | 列为信息性差异（无严重性） |
| 高新收入金额 | **是** | 列为信息性差异（无严重性） |
| 高新收入占比 | **否**（占位符） | 标注为需修正 |

## 附录：文件格式兼容

| 源格式 | 读取工具 | 转换需求 | 注意事项 |
|--------|---------|---------|---------|
| .doc | win32com → python-docx | 需先转为.docx | Word COM自动化，需安装Word |
| .docx | python-docx | 无需转换 | paragraphs + tables |
| .xls | xlrd | 无需转换 | 只读，Sheet名可能有编码问题 |
| .xlsx | openpyxl | 无需转换 | 读写均可，data_only=True避免公式问题 |
| .rar | 7z.exe | 需解压 | 7z x -o<输出目录> |
| .zip | zipfile | 需解压 | 内置库 |

## 附录：与其他技能的衔接关系

| 衔接方向 | 技能 | 说明 |
|---------|------|------|
| **上游** | gxtz-core-tables | 核心表格（RD/PS/IP）作为核对基准 |
| **上游** | gxtz-info-collector | 补充资料目录中包含专审报告 |
| **下游** | gxtz-core-tables | 核对结果反馈到核心表格，标记需调整项 |
| **并行** | gxtz-invoice-ps-matching | 发票PS筛选与专审核对可并行执行 |

---

<!-- SECTION_BEGIN: provenance_verification v2.7 -->
## 溯源核验 → 详见 {{PONOS_SKILLS}}/_common/SHARED_provenance.md
> 关键字段值必须与源文件精确一致，禁止改写。
<!-- SECTION_END: provenance_verification -->

---

<!-- SECTION_BEGIN: authoritative_terms_verification v2.6 -->
## 权威术语核验 → 详见 {{PONOS_SKILLS}}/_common/SHARED_authoritative_terms.md
> 输出前强制扫描权威术语。
<!-- SECTION_END: authoritative_terms_verification -->

---

## 年份硬过滤规则（v1.9.0 新增）

> **来源**: EXP-2026-07-21-001 — 步骤3发票匹配未按年份过滤，导致跨年数据混入

**强制规则**：
1. 步骤3「发票匹配」执行前，必须先计算 `VALID_YEARS = {Y-3, Y-2, Y-1}`（Y=申报年度）
2. 所有发票必须在 VALID_YEARS 范围内，超出范围的发票硬性排除并输出跳过清单
3. 合同日期与发票年份必须同年在 VALID_YEARS 内配对

**CLI 调用**（审核心流）：
```
在步骤3执行前，agent须自问：
  - VALID_YEARS 是否已计算？
  - 是否有跨年发票/合同被混入？
  - 跳过清单是否已输出到审核报告？
```

---

## OCR置信度预检规则（v1.9.0 新增）

> **来源**: EXP-2026-07-21-002 — OCR识别置信度过低导致数据提取错误

**强制规则**：
1. 所有扫描件页面OCR识别后，必须逐页记录平均置信度
2. 平均置信度 < 80% 的页面 → 标记为"低置信度"，输出预警清单
3. 低置信度页面的关键字段（金额/日期/编号） → **禁止自动提取**，提示用户手动录入

**置信度计算**：
```
avg_confidence = sum(line.confidence for line in ocr_result) / len(ocr_result)
```

---

## 合同编号规范化规则（v1.9.0 新增）

> **来源**: EXP-2026-07-21-003 — 合同编号格式不统一，影响自动匹配

**规范化步骤**：
1. **去空格**：移除合同编号中的所有空格字符
2. **统一分隔符**：将 `-` `_` `—` `/` 统一为 `-`
3. **大小写统一**：英文合同编号转为大写
4. **格式校验**：校验规范化后的编号是否符合常见模式（如 `HT-YYYY-NNNN`）

**示例**：
```
输入: "HT 2023 _ 001"  → 规范化: "HT-2023-001"
输入: "fw-2023/056"    → 规范化: "FW-2023-056"
输入: "CG—2023—A01"   → 规范化: "CG-2023-A01"
```
