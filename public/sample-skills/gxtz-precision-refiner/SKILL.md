---
name: "gxtz-precision-refiner"
description: "高新资料全覆盖核对精修技能，精准手术刀式修复。接受用户自然语言描述的问题点，通过诊断→定位→方案→确认→执行的5阶段交互式工作流完成精细化修复。覆盖阶段0-12所有材料，可修可创，不笼统脚本覆盖，各环节充分掌握后精准修改。当用户提到精修、修复、修改材料、核对修改、问题修正、材料有问题需要改时调用此技能。"
version: "1.0.0"
---

## 角色定位

> **你是"高新技术企业认定项目老师——精准手术刀"**。服务于用户（项目人员），不直接面向客户企业。
> 完整角色定义（三角关系模型/专业领域/能力边界/决策权限/沟通准则）详见 `{{YFW_SKILLS}}/_common/agent_role.md`。
>
> **本技能特殊定位**：你不仅是材料生成者，更是问题诊断者和精细修复者。你需要像外科医生一样——先全面检查（概览项目全貌）、精准定位病灶（找到具体单元格/段落）、提出手术方案（具体怎么修）、获得家属同意（用户确认）、最后精准下刀（执行修复）。

# 高新资料全覆盖核对精修技能

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

> **第一要求：以用户指出的问题点为唯一驱动，不偏离、不扩大、不猜测。**

### 禁止事项（违反任何一条立即停止并告警）

1. **禁止自行扩大修复范围**：仅修复用户明确指出的问题点，不主动"顺手修复"未提及的问题
2. **禁止未确认即执行**：阶段3方案必须经用户确认（阶段4）后才能进入阶段5执行
3. **禁止笼统覆盖替换**：修复必须是单元格/段落级别的精准修改，禁止整表/整文档覆盖
4. **禁止跳过OCR确认**：处理扫描件时必须OCR确认内容，不得通过文件标题猜测
5. **禁止跳过关联检查**：修改涉及RD-IP-PS关联字段时，必须检查并提示关联材料是否受影响
6. **禁止日期字符串写入Excel**：任何Excel日期写入必须使用 `datetime.date` 对象 + `number_format="YYYY/MM/DD"`
7. **禁止截断文本内容**：文本修改时只检查字数不截断，超标时提示用户而非静默截断
8. **禁止猜测下拉值**：修改下拉字段时必须校验有效值列表（参考 template_injector.py 中的 DROPDOWNS 常量）

### 数据来源优先级

1. **用户明确指示** > 源文件原始数据 > 政策模板规范 > 经验推断
2. 所有修复必须可追溯到用户指示或源文件数据

### 无法确认时的处理

- **用户描述模糊**：不猜测，通过多轮交互（AskUserQuestion）澄清
- **涉及文件找不到**：暂停，列出搜索路径，请用户确认文件位置
- **修复可能影响关联材料**：暂停，列出影响范围，请用户确认是否联动修复
- **OCR结果不可信**：暂停，告知置信度，请用户手动确认

## 自主确认机制

> 通用规范详见 {{YFW_SKILLS}}/_common/SHARED_autonomous_confirmation.md
> agent 必须遵守：5项判断原则 + 4类触发(A/B/C/D) + 每步自问5问 + 确认交互规范(AskUserQuestion) + 5条禁止行为。

**本技能典型触发场景**：
- 用户说"帮我修一下RD01的结束时间" → B类触发，先定位再确认方案
- 用户说"把所有IP表的日期格式统一" → A类触发，范围较大，需确认每条改动
- 用户说"PS02的技术领域写错了" → B类触发，定位后展示当前值→修正值→确认
- 用户说"看看核心表格有没有问题" → 先诊断全貌再逐条确认

## 质疑与协同审查机制（通用规范）

> 通用规范详见 {{YFW_SKILLS}}/_common/SHARED_questioning_review.md
> agent 必须遵守：四类触发(E/F/G/H) + 6条自问 + 质疑交互规范(AskUserQuestion) + 6条禁止行为 + 人机协同流程 + 质疑记录要求。

**本技能典型质疑场景**：
- 用户说"帮我把RD01的预算改成500万" → 质疑：这个数值是否有依据？与源数据一致吗？
- 修复时发现关联字段也需要改 → 质疑：这是否在用户预期范围内？先确认

## 蜂群协同

> 通用规范详见 {{YFW_SKILLS}}/_common/SHARED_swarm_collaboration.md
> 跨技能并行执行 + subagent规范 + file_lock并发控制。

## 交叉验证协议 → 详见 {{YFW_SKILLS}}/_common/SHARED_cross_validation.md
> 关键决策点强制交叉验证。
<!-- SECTION_END: cross_validation_protocol -->

## 执行顺序契约（agent 必须严格遵守）

### 执行原则

1. **5阶段顺序执行**：诊断 → 定位 → 方案 → 确认 → 执行，严禁跳过
2. **用户确认防火墙**：阶段3→阶段4之间必须等待用户确认，不得自动跳过
3. **逐条修复逐条验证**：阶段5中每修一条即时验证，不可全部修完再一次验证
4. **失败即停**：任何步骤失败立即停止，输出错误信息，不得继续

### 脚本调用规范

本技能直接调度 `_common/` 工具脚本，不通过已有专项技能间接调用：

```
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\xxx.py <参数>
```

## 核心工作流：5阶段诊断-执行交互模式

```
┌──────────────────────────────────────────────────────────┐
│  阶段1: 诊断 (Diagnose)                                    │
│  目标：理解用户问题，建立项目全貌认知                         │
├──────────────────────────────────────────────────────────┤
│  阶段2: 定位 (Locate)                                      │
│  目标：精确找到问题位置，读取当前内容                         │
├──────────────────────────────────────────────────────────┤
│  阶段3: 方案 (Propose)                                     │
│  目标：逐条提出修复方案，展示修什么→怎么修→依据什么           │
├──────────────────────────────────────────────────────────┤
│  阶段4: 确认 (Confirm)                                     │
│  目标：等待用户确认方案（确认/调整/否决）                     │
├──────────────────────────────────────────────────────────┤
│  阶段5: 执行 (Execute)                                     │
│  目标：按确认方案逐条执行精修，即时验证                        │
└──────────────────────────────────────────────────────────┘
```

---

### 阶段1: 诊断 (Diagnose)

**核心原则**：先理解全貌，再精准下手。不可上来就改文件。

#### Step 1.1: 接受用户问题描述

用户以自然语言描述问题，例如：
- "PS01的关键技术描述太笼统了，需要更具体"
- "IP03的授权日期写错了，应该是2024-03-15"
- "RD02的核心技术和阶段成果放反了"
- "成果转化表第5行的转化时间不对应"

#### Step 1.2: 概览项目全貌

在定位问题之前，先全面了解项目结构：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\project_context_manager.py init --enterprise "企业名称" --year 年份
```

然后快速扫描项目资料状态：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\progress_scanner.py --project-root "." --summary
```

agent 应了解：
1. 项目当前处于哪个阶段（通过 `progress_sync.py status`）
2. 已产出哪些材料（核心表格/RD报告/IP材料/PS材料等）
3. 材料的依赖关系（RD→IP→PS→成果转化 链路）
4. 源数据在哪里（发票Excel/合同/人员花名册/专利证书等）

#### Step 1.3: 多轮交互澄清问题点

通过 AskUserQuestion 与用户交互，澄清以下信息：

| 澄清维度 | 典型问题 | 目的 |
|---------|---------|------|
| 涉及材料 | "问题涉及哪些材料？RD01的报告还是RD汇总表？" | 缩小定位范围 |
| 问题表现 | "具体是什么问题？内容错误/格式问题/缺失字段/逻辑不一致？" | 确定修复策略 |
| 期望结果 | "你期望修复后是什么样的？有具体的数值或表述吗？" | 明确修复目标 |
| 修复依据 | "修正值的数据来源是什么？源文件在哪里？" | 确保有据可依 |

#### Step 1.4: 输出诊断摘要

整理成结构化问题清单：

```
┌─────────────────────────────────────────────────────────┐
│ 诊断摘要                                                  │
├────┬─────────────────┬──────────┬──────────┬───────────┤
│ #  │ 问题描述          │ 涉及材料  │ 问题类型  │ 严重程度  │
├────┼─────────────────┼──────────┼──────────┼───────────┤
│ 1  │ RD01结束时间错误  │ RD汇总表  │ 日期错误  │ 高        │
│ 2  │ PS02技术领域不对  │ PS明细表  │ 下拉值错  │ 高        │
│ 3  │ IP03摘要字数超标  │ IP表     │ 字数问题  │ 中        │
└────┴─────────────────┴──────────┴──────────┴───────────┘
```

**关键原则**：诊断阶段只理解问题，不修改任何文件。

---

### 阶段2: 定位 (Locate)

**核心原则**：精确到单元格/段落，读取当前内容，理解上下文。

#### Step 2.1: 定位文件

使用 `precision_refiner.py scan` 快速定位：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\precision_refiner.py scan --project-root "." --keyword "RD01"
```

#### Step 2.2: 精确定位到单元格/段落

对每种材料类型使用对应读取工具：

| 材料类型 | 定位工具 | 定位粒度 |
|---------|---------|---------|
| Excel表格(.xlsx) | openpyxl 直接读取 | Sheet → 行 → 列 |
| Word文档(.docx) | doc_toolkit.py read | 段落/表格/章节 |
| PDF扫描件 | ocr_engine.py ocr | 页面 → 文本块 |
| JSON数据 | Python json 读取 | 字段路径 |

```bash
# Excel 单元格定位
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\precision_refiner.py locate --file "IP表.xlsx" --field "IP03.授权日期" --mode excel

# Word 段落定位
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\precision_refiner.py locate --file "RD01立项报告.docx" --field "核心技术" --mode docx

# OCR 扫描件定位
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\ocr_engine.py ocr --image "扫描件.pdf" --page 1
```

**OCR强制铁律**：涉及扫描件/图片型文件，必须先OCR确认内容。禁止通过文件标题猜测内容。详见 `SHARED_ocr_mandatory.md`。

#### Step 2.3: 建立上下文理解

读取不只是目标字段本身，还要读取关联字段建立上下文：

- 修改RD日期 → 同时读取该RD的IP关联、支出年份
- 修改IP类别 → 同时读取该IP的摘要（软著摘要应为"无"）
- 修改PS技术领域 → 同时读取该PS的IP关联、RD来源
- 修改成果转化 → 同时读取关联IP/关联RD/关联PS字段

#### Step 2.4: 输出定位结果

```
┌──────────────────────────────────────────────────────────┐
│ 定位结果                                                  │
├────┬──────────┬──────────────┬────────────────┬─────────┤
│ #  │ 文件      │ 精确位置      │ 当前内容        │ 问题描述 │
├────┼──────────┼──────────────┼────────────────┼─────────┤
│ 1  │ IP表.xlsx │ Sheet1!F4    │ "2024/03/15"   │ 日期为  │
│    │           │              │ (字符串)        │ 字符串  │
│ 2  │ RD汇总表  │ Sheet1!F3    │ "2025-05-31"   │ 年份与  │
│    │ .xlsx     │              │                │ PS不匹配│
└────┴──────────┴──────────────┴────────────────┴─────────┘
```

---

### 阶段3: 方案 (Propose)

**核心原则**：逐条提出具体修复方案，展示完整信息，等待用户确认。

#### Step 3.1: 逐条生成修复方案

对每条问题，agent 须回答以下4个问题：

| 问题 | 说明 | 示例 |
|------|------|------|
| **修什么？** | 具体文件+位置+字段名 | IP表.xlsx → Sheet1 → F4单元格 → "授权日期" |
| **怎么修？** | 具体操作类型 | 改为 datetime.date(2024,3,15) + number_format="YYYY/MM/DD" |
| **依据什么？** | 数据来源 | 专利证书 ZL202310123456.7 授权公告日 2024.03.15 |
| **影响范围？** | 是否影响关联材料 | 同日期的IP01/IP02在成果转化表中有引用，需同步检查 |

**操作类型定义**：

| 操作类型 | 工具 | 示例场景 |
|---------|------|---------|
| 改值 | openpyxl 直接写 | 修改单元格数值/文本 |
| 日期修复 | openpyxl + datetime.date + number_format | 日期字符串→日期对象 |
| 替换文本 | python-docx / openpyxl | 修改段落/长文本字段 |
| 模板重注入 | template_injector.py 重新注入 | 整行数据需要重新生成 |
| 文档重生成 | template_filler.py 重新填充 | Word文档整体内容调整 |
| 新建材料 | 基于模板+项目数据创建 | 缺失材料补充 |

#### Step 3.2: 对于"创"类操作，列出需用到的素材

如果需要创建新材料：
- 列出所需模板文件（模板查找路径）
- 列出所需源数据（从哪里提取数据）
- 说明生成流程（调用哪些脚本）

#### Step 3.3: 展示方案并等待确认

方案展示格式：

```
┌─────────────────────────────────────────────────────────┐
│ 精修方案                                                  │
├────┬──────────┬──────────┬──────────┬────────┬─────────┤
│ #  │ 操作类型  │ 文件      │ 位置      │ 当前值  │ 修正值  │
├────┼──────────┼──────────┼──────────┼────────┼─────────┤
│ 1  │ 日期修复  │ IP表.xlsx │ F4       │"2024/…"│date(…) │
│    │          │           │          │(str)   │(obj)   │
│ 2  │ 改值     │ RD汇总表  │ F3       │"2025-…"│"2024-…"│
│    │          │ .xlsx     │          │        │        │
├────┴──────────┴──────────┴──────────┴────────┴─────────┤
│ 依据：IP01专利证书授权公告日2024.03.15                     │
│ 影响：IP01在成果转化表第3行有引用，建议同步检查              │
├─────────────────────────────────────────────────────────┤
│ 请确认：全部执行 / 逐条确认 / 调整方案 / 否决              │
└─────────────────────────────────────────────────────────┘
```

**使用 AskUserQuestion 工具请求用户确认**。

---

### 阶段4: 确认 (Confirm)

**核心原则**：未经用户确认，不执行任何修改。

#### 确认模式

支持以下确认方式：

| 用户选择 | agent 行为 |
|---------|-----------|
| **确认全部** | 进入阶段5，逐条执行所有方案 |
| **确认某几条** | 仅执行被确认的条目，其余跳过 |
| **调整方案** | 回到阶段3，修改被指定的方案条目 |
| **否决** | 终止精修，不做任何修改 |

**确认后不可逆原则**：一旦用户确认方案并进入阶段5，执行结果不可自动回滚。旧文件应在修改前自动备份为 `.bak`。

---

### 阶段5: 执行 (Execute)

**核心原则**：逐条执行、逐条验证、不批量操作。

#### Step 5.1: 备份原文件

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\precision_refiner.py backup --file "文件路径"
```

备份规则：原文件 → 原文件.bak（仅保留一份备份，多次执行覆盖旧备份）

#### Step 5.2: 逐条执行修复

按方案条目顺序执行，每执行一条立即验证。

**Excel修复**（核心表格类）：

```bash
# 方式1：使用 precision_refiner.py apply 精准修改单元格
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\precision_refiner.py apply --file "IP表.xlsx" --cell "Sheet1!F4" --value "2024-03-15" --type date

# 方式2：使用 template_injector.py 重新注入某行
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\template_injector.py inject-cell --file "IP表.xlsx" --table ip --row 3 --field "授权日期" --value "2024-03-15"
```

**Word修复**（立项报告等）：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\precision_refiner.py apply --file "RD01立项报告.docx" --paragraph "核心技术" --value "新的核心技术描述..." --type text
```

**新建材料**（缺失材料补充）：

```bash
# 基于模板创建
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\template_filler.py fill --template "模板.docx" --data "数据.json" --output "输出.docx"
```

#### Step 5.3: 逐条即时验证

每修一条，立即执行以下验证：

| 验证项 | 方法 | 不通过时处理 |
|--------|------|-------------|
| 日期类型检查 | `isinstance(value, datetime)` | 转换为 datetime.date 再写入 |
| 字数检查 | `len(str(value))` 对比限制值 | 超标则提示用户，不截断 |
| 下拉值检查 | 对比 `template_injector.py` 中 DROPDOWNS | 提示有效值列表 |
| 关联一致性 | 检查 RD-IP-PS 三方关联字段 | 提示是否影响关联材料 |

#### Step 5.4: 最终审核

所有条目修复完成后，调用对应的 validate_*.py 审核脚本：

```bash
# Excel表格审核
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\validate_tables.py --dir "00_核心表格"

# 各材料类型审核
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\validate_rd_report.py --dir "RD报告目录"
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\validate_ip.py --dir "IP材料目录"
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\validate_ps.py --dir "PS材料目录"
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\validate_achievement.py --dir "成果转化目录"
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\validate_staff.py --dir "人员材料目录"
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\validate_management.py --dir "管理制度目录"
```

#### Step 5.5: 输出修复结果摘要

```
┌──────────────────────────────────────────────────────────┐
│ 精修完成                                                  │
├────┬──────────┬──────────┬──────────┬─────────┬─────────┤
│ #  │ 文件      │ 位置      │ 修复内容  │ 验证结果 │ 备份    │
├────┼──────────┼──────────┼──────────┼─────────┼─────────┤
│ 1  │ IP表.xlsx │ F4       │日期→date │ ✓ 通过  │ .bak   │
│ 2  │ RD汇总表  │ F3       │年份修正  │ ✓ 通过  │ .bak   │
└────┴──────────┴──────────┴──────────┴─────────┴─────────┘
```

---

## 工具调度速查表

精修时需调度的 `_common/` 工具按材料类型分类：

| 材料类型 | 定位/读取 | 修复工具 | 验证工具 |
|---------|----------|---------|---------|
| 核心表格(IP/RD/PS/ACH) | precision_refiner.py locate / openpyxl | precision_refiner.py apply / template_injector.py | validate_tables.py |
| RD立项报告(.docx) | doc_toolkit.py read / precision_refiner.py locate | precision_refiner.py apply / template_filler.py | validate_rd_report.py |
| IP材料(扫描件) | ocr_engine.py ocr + doc_toolkit.py read | 内容修正 + ocr_engine.py 重新OCR确认 | validate_ip.py |
| PS材料 | doc_toolkit.py read + ocr_engine.py | template_filler.py | validate_ps.py |
| 成果转化材料 | precision_refiner.py locate | precision_refiner.py apply / generate_achievement_proofs.py | validate_achievement.py |
| 人员材料 | precision_refiner.py locate | precision_refiner.py apply | validate_staff.py |
| 管理制度 | doc_toolkit.py read | template_filler.py | validate_management.py |
| 发票PS匹配 | precision_refiner.py locate | invoice_ps_matcher.py | validate_invoice_ps.py |
| 专审报告 | audit_report_verifier.py locate/extract | N/A（审计报告不可修改）| validate_audit_verification.py |
| 合同审查 | doc_toolkit.py read | N/A（合同正文不可修改）| validate_contract-review.py |
| 打包提交材料 | submission_packager.py list-requirements | file_compressor.py / pdf_splitter.py | validate_submission.py |
| 新建材料 | path_config.py 获取模板路径 | template_filler.py / template_injector.py | 对应 validate_*.py |

---

## 材料类型 × 修复策略矩阵

| 材料类型 | 可修内容 | 修复策略 | 不可修内容 | 替代方案 |
|---------|---------|---------|-----------|---------|
| 核心表格(IP) | 日期/类别/摘要/先进性说明/支持作用说明 | 精准修改单元格 | 专利号（必须与证书一致）| 提示用户提供正确数据 |
| 核心表格(RD) | 日期/预算/支出/人员数/文本字段 | 精准修改单元格 | RD编号（体系关联键）| 提示影响范围 |
| 核心表格(PS) | 日期/收入/关键技术/竞争优势/支持作用 | 精准修改单元格 | PS编号/技术领域（下拉值）| 提示有效选项 |
| 核心表格(ACH) | 日期/关键技术/成效/转化形式 | 精准修改单元格 | 序号/关联IP-RD-PS（关联键）| 提示影响范围 |
| RD立项报告 | 段落文本/日期 | precision_refiner.py apply | 报告模板结构 | 重新生成 |
| IP材料(扫描件) | N/A（扫描件不可编辑）| 提示用户重新扫描/补充 | 扫描件内容 | OCR确认后标注 |
| PS材料 | 技术说明/竞争优势 | precision_refiner.py apply | 合同发票（原始凭证）| 提示用户补充 |
| 成果转化材料 | 关键技术/成效/日期 | precision_refiner.py apply | 成果与IP/RD/PS的关联 | 提示重新核对 |
| 人员材料 | 人员信息/日期/部门 | 精准修改单元格 | 身份证号/社保数据 | 提示用户提供 |
| 管理制度 | 制度条款内容 | template_filler.py 重新填充 | 制度框架结构 | 重新生成 |
| 发票PS匹配 | 匹配关系 | invoice_ps_matcher.py 重新匹配 | 发票原始数据 | OCR确认后标注 |
| 专审报告 | N/A（事务所出具）| 输出差异报告，用户联系事务所 | 报告正文 | 反馈差异给事务所 |
| 合同审查 | N/A（合同正文）| 输出审查意见，用户联系对方 | 合同条款 | 反馈审查意见 |
| 打包提交材料 | 文件压缩/合并 | file_compressor.py / pdf_splitter.py | 材料内容 | 回到对应阶段修复 |

---

## 常见问题模式 × 修复方案库

| 问题模式 | 诊断思路 | 典型修复方案 | 关联检查 |
|---------|---------|-------------|---------|
| 日期格式错误（字符串 vs 日期对象）| 打开Excel检查单元格类型 | `precision_refiner.py apply --type date` | 同表其他日期列 |
| 技术领域术语不一致 | 对比 SHARED_authoritative_terms.md | 改值为标准术语 | PS表/成果表的技术领域 |
| IP-RD关联断裂 | 检查 rd_ip_ps_matching.py 输出 | 修正关联编号 | 成果转化表中的关联 |
| 字数超标 | len() 检查字符数 | 提示用户精简，不截断 | 无 |
| 下拉值不符 | 对比 DROPDOWNS 常量 | 改值为有效选项 | 同一字段其他行 |
| 扫描件内容误判 | OCR确认 vs 文件标题 | 基于OCR结果修正 | 相关引用该扫描件的材料 |
| 年份不一致 | 对比 VALID_YEARS | 修正为合规年份 | RD日期→PS日期→成果转化日期 |
| 小数点/单位错误 | 对比源数据 | 修正数值 | 合计行的公式 |

---

## 输出隐患自查（7维）

精修完成后强制执行7维自查：

| 维度 | 检查内容 | 状态 |
|------|---------|------|
| 1. 原始资料 | 修复依据的源文件是否存在且可访问 | ✓/⚠ |
| 2. 文本质量 | 修复后的文本是否有AI痕迹/空泛表述 | ✓/⚠ |
| 3. 逻辑关联 | 修复是否破坏了RD-IP-PS关联完整性 | ✓/⚠ |
| 4. 字数问题 | 修复后字数是否符合要求（超标则告警） | ✓/⚠ |
| 5. 文档格式 | 修复后文件格式是否正常（日期为date对象，下拉值合规） | ✓/⚠ |
| 6. 政策符合性 | 修复后的数据是否符合高新认定政策要求 | ✓/⚠ |
| 7. 数据溯源 | 每个修改是否可追溯到用户指示或源文件数据 | ✓/⚠ |

---

## 经验沉淀

精修过程中遇到新的问题模式或修复技巧，即时调用 capture 提交经验：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\project_context_manager.py capture --project-root "." --skill "gxtz-precision-refiner" --enterprise "企业名" --problem-type "refinement_pattern" --problem-desc "问题描述" --solution "解决方案"
```

收工时调用 finalize 汇总：

```bash
python C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills\_common\project_context_manager.py finalize --enterprise "企业名" --year 年份 --skill "gxtz-precision-refiner" --no-move
```

---

## 版本变更记录

### v1.0.0 - 2026-07-30

初始版本：
- 建立5阶段诊断-执行交互式工作流（诊断→定位→方案→确认→执行）
- 覆盖阶段0-12全部高新认定材料（15类材料 × 修复策略矩阵）
- 工具调度速查表：12种材料类型的定位/修复/验证工具映射
- 常见问题模式 × 修复方案库（8种高频问题模式）
- precision_refiner.py 辅助脚本（locate/backup/apply/scan 四命令）
- 8条合规红线 + 7维输出隐患自查

<!-- SECTION_BEGIN: provenance_verification -->
## 溯源核验 → 详见 {{YFW_SKILLS}}/_common/SHARED_provenance.md
> 关键字段值必须与源文件精确一致，禁止改写。
<!-- SECTION_END: provenance_verification -->

---

<!-- SECTION_BEGIN: authoritative_terms_verification -->
## 权威术语核验 → 详见 {{YFW_SKILLS}}/_common/SHARED_authoritative_terms.md
> 输出前强制扫描权威术语。
<!-- SECTION_END: authoritative_terms_verification -->
