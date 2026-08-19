---
name: gxtz-core-tables
description: "高新技术企业认定核心表格统筹 — 协调RD表/PS表/IP表/TOAI汇总表的生成与交叉校验。v1.40.0新增：模板内置打包+两级查找兜底+强制模板注入约束。v1.39.0核心架构变更：长文本字段统一采用提示词驱动生成，禁止算法拼接或模板句填充。当用户提到核心表格、知识产权表、RD-PS-IP关联汇总表、科技人员清单、人员三方对比、TOAI表时调用此技能。"
version: "1.40.1"
triggers:
  - 核心表格
  - 汇总表
  - 四表联动
  - 交叉校验
  - 生成核心表
  - RD表
  - PS表
  - IP表
  - TOAI表
  - 知识产权表
  - RD-PS-IP关联汇总表
  - 科技人员清单
  - 人员三方对比
---

## 角色定位

> 你是"高新技术企业认定项目老师"。服务于用户（项目人员），不直接面向客户企业。
> 完整角色定义（三角关系模型/专业领域/能力边界/决策权限/沟通准则）详见 `{{YFW_SKILLS}}/_common/agent_role.md`。

## 技术栈引用

参见 `{{YFW_SKILLS}}/_common/SHARED_tech_stack.md`：
- 处理文档前必须先 `python doc_toolkit.py info --file <路径>` 查表，禁止自行尝试不同库
- 速查: xlsx→openpyxl, docx→python-docx, pdf文本→PyMuPDF, pdf表格→pdfplumber, pdf混合→--mode auto

## OCR能力引用

参见 `{{YFW_SKILLS}}/_common/SHARED_ocr_reference.md`：
- PDF混合型必须用 --mode auto 逐页智能处理。扫描件用RapidOCR(ONNX)，准确率>95%。
- 命令：`python doc_toolkit.py read --file X --format pdf --mode auto --project <project>`
- OCR强制铁律：见 `{{YFW_SKILLS}}/_common/SHARED_ocr_mandatory.md`（先OCR后操作，禁止猜测，必须等待）

## 输出资料合规规则

参见 `{{YFW_SKILLS}}/_common/SHARED_no_ai_watermark.md`：
- 禁止AI水印: 禁止脚本署名、AI工具署名、模型标识、生成声明
- 文档版本管理: 旧版.bak备份

## 技能架构

本技能(gxtz-core-tables)是**核心表格统筹技能**，协调以下4个子技能的生成与交叉校验：

| 子技能 | 负责表格 | 调用方式 |
|--------|---------|---------|
| `/gxtz-rd-tables` | RD研发项目表（项目概况/预算/人员/进度） | 子技能 |
| `/gxtz-ps-tables` | PS高新产品表（产品规格/收入占比/证明材料） | 子技能 |
| `/gxtz-ip-tables` | IP知识产权表（专利/软著/授权状态/与PS关联） | 子技能 |
| `/gxtz-toai-tables` | TOAI汇总表（四表联动汇总/高新占比） | 子技能 |

### 7表严格生成顺序（agent 必须严格遵守）

高新项目全部配套资料由7张表串联驱动，顺序不可打乱。

```
【本技能：4张核心表】
① RDPS表 ──→ ② 科技人员清单 ──→ ③ IP表 ──→ ④ TOAI表
      │
【子技能：3张派生表】              │
      └──→ ⑤ RD立项书 + RD表（gxtz-rd-tables）
                └──→ ⑥ 成果转化表（gxtz-achievement-materials）
                          └──→ ⑦ PS表（gxtz-ps-materials）
```

| 序号 | 表名 | 负责技能 | 角色 | 依赖上游 |
|:---:|------|---------|------|---------|
| ① | **RDPS表** | gxtz-core-tables | 全局锚点，定义RD/IP/PS关联关系 | 企业基础数据 |
| ② | **科技人员清单** | gxtz-core-tables | 人员资质合规，确定研发人力 | ①的RD列表 |
| ③ | **IP表** | gxtz-ip-tables | 人工提供→agent梳理排序（I类/II类×时间序） | ①的IP-RD关联 |
| ④ | **TOAI表** | gxtz-toai-tables | 汇总①②③，向系统/AI提交核心数据 | ①②③的全部数据 |
| ⑤ | **RD立项书 + RD表** | **gxtz-rd-tables** | 立项书.docx + RD表（一张技能两张产出） | ①的RD定义 + ③的IP成果 |
| ⑥ | **成果转化表** | gxtz-achievement-materials | 成果转化证明材料 + 表格 | ③的IP成果 + ⑤的RD表 |
| ⑦ | **PS表** | **gxtz-ps-tables** | 合同发票证明材料 + 表格 | ⑥的成果转化表 + PS证明材料 |

## 执行流程

```
1. 依赖检查 → 2. 并行生成三表 → 3. TOAI汇总 → 4. 交叉校验 → 5. 修正闭环
```

### 执行原则

1. **顺序执行**：必须按步骤顺序执行，严禁跳过任何步骤
2. **失败即停**：任何步骤失败立即停止，输出错误信息，不得继续
3. **不可并行（有依赖时）**：技能内步骤有数据依赖时不得并行
4. **不可跳过审核**：审核验证步骤必须执行且通过，未通过时不得进入下一步

### 失败处理标准流程

1. **立即停止**当前步骤及后续所有步骤
2. **输出错误信息**：包含失败步骤、错误原因、脚本日志
3. **输出已完成的步骤清单**
4. **等待用户决定**：由用户决定修复方案
5. **禁止自行兜底**：不得"阅读脚本逻辑自行编写等效代码"

## 统一输出目录规范

```
{企业名称}_高新认定材料_{申报年份}/
├── 00_核心表格/              # 本技能输出（含RD-PS-IP关联汇总表）
├── 01_研发立项报告/          # gxtz-rd-tables
├── 02_知识产权证明/          # gxtz-ip-materials
├── 03_成果转化证明/          # gxtz-achievement-materials
├── 04_高新产品证明/          # gxtz-ps-materials
├── 05_科技人员材料/          # gxtz-staff-materials
├── 06_管理制度材料/          # gxtz-management-materials
├── 07_资料收集清单/          # gxtz-info-collector
└── _校验报告/                # 各技能生成的校验/审核报告
```

## 核心脚本

```bash
# 交叉校验
python {{YFW_SKILLS}}/_common/validate_cross_tables.py --rd RD表 --ps PS表 --ip IP表 --toai TOAI表
# 审核验证
python {{YFW_SKILLS}}/_common/validate_tables.py --dir "输出目录" --project-root "项目根目录"
# 进度同步
python {{YFW_SKILLS}}/_common/progress_sync.py status --project-root "."
```

### 审核通过条件

审核脚本返回 `passed: True` 且退出码为 0 时，方可进入提交流程。

### 审核失败处理

1. 审核脚本返回 `passed: False` 或退出码非 0 时，立即停止
2. 输出 ERROR 清单（包含每条错误的行号、字段、原因）
3. 根据 ERROR 清单逐一整改
4. 整改后重新执行审核脚本，直到全部 PASS 方可提交

## 模板注入模式（v1.38.0+）

> 核心变更：不再由 agent 从零模仿模板生成表格。改为搜索官方模板 → 调用 template_injector.py 将数据注入模板。

```python
from _common.template_injector import TemplateInjector

injector = TemplateInjector(template_dir="00_核心表格", output_dir="_output", enterprise_name="企业名")
injector.inject_ip_table(ip_data)
```

> 强制约束：IP表必须通过 `TemplateInjector.inject_ip_table()` 生成，禁止 agent 自行从零拼表。内置模板自动兜底。

### 模板搜索规则

两级查找，优先项目目录，兜底内置模板（`_common/templates/`，随技能包分发）：
- IP表关键词：`知识产权表`
- RD汇总表关键词：`研究开发活动汇总`
- PS明细表关键词：`高新技术产品明细`
- 成果转化表关键词：`科技成果转化汇总`

### IP表下拉约束（template_injector 内置校验）

`TemplateInjector.inject_ip_table()` 内置 `IP_DROPDOWNS` 校验：

| 列序 | 列名 | 有效取值 |
|------|------|---------|
| 3 | 类别 | 实用新型专利 / 外观设计专利 / 软件著作权 / 发明专利(非国防专利) / 发明专利(国防专利) / 植物新品种 / 国家级农作物品种 / 国家新药 / 国家一级中药保护品种 / 集成电路布图设计专有权 |
| 4 | 获得方式 | 自主研发 / 受让 / 受赠 / 并购 / 其他 |

注意：发明专利分为"发明专利(非国防专利)"和"发明专利(国防专利)"两个选项。

## 经验沉淀

| exp_id | 类型 | 问题摘要 | 处理方法 |
|--------|------|---------|---------|
| EXP-2026-07-23-010 | common_issue | 成果转化表修复脚本误将RD完成日期写入I列 | 列级精确写入替代全局正则替换；禁止对非目标列执行日期格式化 |
| EXP-2026-07-23-011 | common_issue | 成果转化表K列和L列超出400字限制 | 字数优化：禁止safe_clip/截断，通过优化表述调整 |
| EXP-2026-07-23-012 | common_issue | PS收入/RD费用等数据与审计报告不一致 | 生成前采集3个权威数据源写入采集数据.json |
| EXP-2026-07-23-013 | validation_rule | 科技人员清单需按社保逐人核对 | 交叉比对姓名/身份证号与社保缴费记录，生成三方对比表 |
| EXP-2026-07-23-014 | validation_rule | 成果转化表I列(关联PS)被误写为日期 | 禁止对I列执行日期格式自动修复 |
| EXP-2026-07-23-015 | format_requirement | 成果转化表B列沿用RD立项报告完整名称 | 成果名称去掉"的研发"后缀后提请用户确认 |
| EXP-2026-07-23-016 | format_requirement | 核心表格目录混杂备份文件 | 每次保存前备份到备份文件/子目录 |
| EXP-2026-07-23-017 | best_practice | 修复后不及时验证关联列导致数据不一致扩散 | 修改按RD→IP→PS→成果转化→全量验证顺序 |

## v1.39.0 核心架构变更：长文本字段提示词驱动生成

> 所有长文本字段统一由 agent 按提示词逐IP/PS生成，禁止算法拼接或 `optimize_text_to_fit()` 截断。

| 表格 | 字段 | 限字 | 生成方式 |
|------|------|------|---------|
| IP表 | 先进性说明 | 300-400字 | agent 结合 IP 摘要 + RD 技术方向生成 |
| IP表 | 支持作用说明 | 300-400字 | agent 结合 IP 与关联 PS 的技术匹配关系生成 |
| PS表 | 关键技术及主要技术指标 | 350-400字 | 由 gxtz-ps-tables 生成 |
| PS表 | 竞争优势 | 350-400字 | 由 gxtz-ps-tables 生成 |
| PS表 | 知识产权支持作用 | 350-400字 | 由 gxtz-ps-tables 生成 |
| 成果转化表 | K列（涉及关键技术） | ≤400字 | 由 gxtz-achievement-materials 生成 |
| 成果转化表 | L列（成效） | ≤400字 | 由 gxtz-achievement-materials 生成 |
| RD汇总表 | 目的/核心技术/阶段成果 | ≤400字 | 由 gxtz-rd-tables 生成 |

### 生成流程（以 IP 表为例）

```
对于每个 IP:
  Phase 1: 构建上下文包
    └→ IP名称 + IP摘要原文 + IP类型 + 关联RD名称 + 关联RD技术方向 + 关联PS名称
  Phase 2: agent 按以下要求生成先进性说明（300-400字）
    └→ 结合 IP 的技术创新点与关联 RD 的研发方向
    └→ 不出现编号（RD01/IP01），不出现夸大词（领先/首创）
    └→ 语言正式，采用概括性表述
  Phase 3: agent 按以下要求生成支持作用说明（300-400字）
    └→ 说明该 IP 如何支撑关联 PS 产品的核心技术
    └→ 明确 IP 对产品性能/功能/质量的具体支撑关系
    └→ 不出现编号，不出现夸大词
  Phase 4: 质量门禁
    └→ 字数检查（≥300字）/ 编号泄露检查 / 夸大词检查
    └→ 不合格自动重跑（最多2次）
  Phase 5: 脚本注入
    └→ template_injector.inject_ip_table() 将生成内容注入模板
```

### 禁止事项

- **禁止 `optimize_text_to_fit()` 截断**：不得对长文本执行自动截断
- **禁止算法拼接**：不得从摘要中提取关键词拼接
- **禁止 fallback 模板句**：不得使用"该技术具有较高的先进性"等通用模板句
- **禁止批量算法生成**：每份长文本必须独立生成

## 禁止事项（所有子技能通用）

1. **禁止编造内容**：所有字段数据必须来自真实文件
2. **禁止推断关键数据**：技术领域、研发费用、人员占比等以官方文档为准
3. **禁止跳过脚本执行**：所有命令必须真正执行
4. **禁止跳过审核步骤**：审核验证必须执行且通过
5. **禁止自行兜底**：脚本报错时禁止自行编写兜底代码
6. **禁止合并/简化字段名**：字段名必须与模板完全一致
7. **禁止跨技能污染**：仅读取当前项目留痕
8. **禁止从零模仿模板生成表格**：所有核心表格必须使用 template_injector.py

## 数据来源优先级（高到低）

- **官方文档**（所得税申报表 > 申请书 > 证书）：可直接采用
- **项目推断**：仅在官方文档缺失时使用，必须标注"推断"
- **联网搜索**：仅用于企业基本信息，不得用于技术数据
- **缺失**：不得编造，必须标注"待补充"

## 高新技术领域确定规则（v1.16.0强制执行）

**优先级链**（从高到低）：
1. **企业所得税年度纳税申报表**（最高优先级）
2. **高新技术企业认定申请书**（次高优先级）
3. 项目资料推断（仅当前两者都不存在时使用）
4. 联网搜索企业经营范围（最后兜底）

**强制规则**：
- 同时存在所得税申报表和申请书时，一律以所得税申报表为准
- 只有其一则以存在的为准
- 都不存在时列入待补充清单

### 实现函数

```python
def determine_tech_field_from_official_docs(data_dir, application_year):
    """从官方登记文件确定高新技术领域
    
    优先级：所得税申报表 > 申请书 > 项目资料推断 > 联网搜索
    
    返回 {
        'tech_field': str,   # 确定的技术领域
        'source': str,       # 来源标识
        'source_file': str,  # 来源文件路径
        'warning': str,      # 警告信息
    }
    """
    import os, re
    
    # 1. 优先查找所得税申报表
    income_tax_keywords = ['企业所得税年度纳税申报表', '企业所得税申报表', '所得税申报表', '年度纳税申报表']
    income_tax_files = []
    for root, dirs, files in os.walk(data_dir):
        for f in files:
            if any(kw in f for kw in income_tax_keywords) and f.lower().endswith(('.pdf', '.doc', '.docx')):
                income_tax_files.append(os.path.join(root, f))
    
    # 2. 次优先查找申请书
    application_keywords = ['高新技术企业认定申请书', '认定申请书', '高企申请书']
    application_files = []
    for root, dirs, files in os.walk(data_dir):
        for f in files:
            if any(kw in f for kw in application_keywords) and f.lower().endswith(('.pdf', '.doc', '.docx')):
                application_files.append(os.path.join(root, f))
    
    # 3. 按优先级提取
    if income_tax_files:
        tech_field, source_file = extract_tech_field_from_pdf(income_tax_files[0])
        if tech_field:
            return {'tech_field': tech_field, 'source': 'income_tax_return', 'source_file': source_file, 'warning': ''}
    
    if application_files:
        tech_field, source_file = extract_tech_field_from_pdf(application_files[0])
        if tech_field:
            warning = '' if income_tax_files else '未找到所得税申报表，暂以申请书为准，建议补充核对'
            return {'tech_field': tech_field, 'source': 'application_form', 'source_file': source_file, 'warning': warning}
    
    # 4. 都不存在时推断
    inferred_field = infer_tech_field_from_projects(data_dir)
    if inferred_field:
        return {'tech_field': inferred_field, 'source': 'project_inferred', 'source_file': '', 'warning': f'临时根据项目资料推断，必须补充官方依据'}
    
    return {'tech_field': '', 'source': 'missing', 'source_file': '', 'warning': '高新技术领域来源缺失'}

def extract_tech_field_from_pdf(pdf_path):
    """从 PDF 中提取高新技术领域字段值"""
    import re
    text = ''
    try:
        import fitz
        doc = fitz.open(pdf_path)
        for page in doc:
            text += page.get_text()
        doc.close()
    except ImportError:
        try:
            import pdfplumber
            with pdfplumber.open(pdf_path) as pdf:
                for page in pdf.pages:
                    text += page.extract_text() or ''
        except ImportError:
            return ('', pdf_path)
    
    patterns = [
        r'高新技术领域[：:]\s*([^\n\r,，。；;]+)',
        r'技术领域[：:]\s*([^\n\r,，。；;]+)',
        r'所属领域[：:]\s*([^\n\r,，。；;]+)',
        r'高新技术企业领域[：:]\s*([^\n\r,，。；;]+)',
    ]
    for pattern in patterns:
        m = re.search(pattern, text)
        if m:
            return (m.group(1).strip(), pdf_path)
    return ('', pdf_path)

def infer_tech_field_from_projects(data_dir):
    """从 RD/PS 项目资料中推断最频繁的技术领域（临时方案）"""
    # 8大领域：电子信息、生物与新医药、航空航天、新材料、高技术服务、新能源与节能、资源与环境、先进制造与自动化
    return ''
```

### 审核要求

| source 值 | 审核结果 | 处理流程 |
|-----------|---------|----------|
| `income_tax_return` | 通过 | 以所得税申报表为准 |
| `application_form` | 通过（附警告） | 建议补充所得税申报表核对 |
| `project_inferred` | 不通过 | 列入待补充清单 |
| `missing` | 不通过 | 必须补充所得税申报表或申请书 |

## 模板对齐规范（强制执行）

1. **禁止合并标题行**：第1行必须直接是表头
2. **字段名必须完整**：使用模板的完整字段名，不允许简化
3. **字段顺序和列数必须对齐模板**
4. **样式严格对齐模板**：宋体12号bold表头、11号数据、thin边框、浅色表头背景
5. **数据完整性要求**：所有字段必须填充实质内容

## 文本字数优化策略

```python
def optimize_text_to_fit(text, max_chars):
    """通过表述优化将文本缩减到目标字数
    优化策略（按优先级）：
    1. 合并重复表述
    2. 精简修饰性词汇
    3. 压缩冗余句式
    4. 无法达标→保留原文，标记为字数隐患汇报用户
    禁止：任何形式的算法截断
    """
    if len(text) <= max_chars:
        return text, None
    optimized = _merge_redundant_phrases(text)
    optimized = _trim_modifiers(optimized)
    optimized = _compress_redundant_sentences(optimized)
    if len(optimized) <= max_chars:
        return optimized, None
    return optimized, f"优化后仍超出 {max_chars} 字（当前{len(optimized)}字），需人工调整"
```

### 字数校验规则

| 表格 | 字段 | 字数范围 | 不合规时处理 |
|------|------|---------|------------|
| IP表 | 摘要 | 不校验 | 严格按专利说明书原文 |
| IP表 | 先进性说明 | 300-400字 | 超限/不足→停止写入，告警agent重写 |
| IP表 | 支持作用说明 | 300-400字 | 同上 |
| PS表 | 关键技术及主要技术指标 | 350-400字 | 同上 |
| PS表 | 竞争优势 | 350-400字 | 同上 |
| PS表 | 知识产权支持作用 | 350-400字 | 同上 |
| 成果转化表 | 涉及关键技术 | 370-410字 | 同上 |
| 成果转化表 | 成效 | 370-410字 | 同上 |

## 审核验证标准

### L1 格式校验
字数达标、字段完整性、日期格式、编号格式——每张表生成后立即执行

### L2 内容校验
名称/编号/技术领域逐字对比，跨表一致性——全套表格生成后执行

### L3 逻辑校验
时间先后、关联关系、占比合规、金额合计——最终提交前执行

### 审核通过条件

- 所有表格数据完整
- 跨表关联关系正确
- 时间逻辑符合要求
- 经费收入数据一致
- 格式规范无误
- 模板对齐校验全部通过
- 字数下限校验全部通过

## 输出隐患自查与汇报（技能结束时强制执行）

| 维度 | 检查项 |
|------|--------|
| 1. 原始资料缺失 | 企业数据文件是否存在，外部技能依赖项是否就绪 |
| 2. 文本质量 | 是否存在AI痕迹，技术描述是否有实质内容 |
| 3. 逻辑关联 | RD-IP-PS关联是否完整，闲置IP数是否为0 |
| 4. 字数问题 | 各字段字数是否合规（严禁算法截断） |
| 5. 文档格式 | 日期/编号/金额格式是否统一 |
| 6. 政策符合性 | 技术领域是否正确，高新收入占比≥60% |
| 7. 数据可溯源性 | 每个数据字段能否追溯到源文件 |

### 汇报格式

```
⚠️ gxtz-core-tables 输出隐患自查报告

1. 原始资料: ✓ 全部就绪 / ⚠ 缺失{n}项
2. 文本质量: ✓ / ⚠ {n}处空泛表述
3. 逻辑关联: ✓ / ⚠ {n}个隐患
4. 字数合规: ✓ / ⚠ {n}字段需优化
5. 文档格式: ✓ / ⚠ {n}处不规范
6. 政策符合性: ✓ / ⚠ {n}项不满足
7. 数据可溯源: ✓ / ⚠ {n}字段无明确来源
```

## 溯源核验

参见 `{{YFW_SKILLS}}/_common/SHARED_provenance.md`
所有关键字段值必须与源文件精确一致，禁止改写/换词/扩写/缩写。

## 权威术语核验

参见 `{{YFW_SKILLS}}/_common/SHARED_authoritative_terms.md`
输出前强制扫描权威术语。禁止: "新能源及节能"(应为"与")、"高技术服务业"(应为"服务")等。

## 关键时间逻辑

### 申报年份确定
```
申报年份 = 用户指定的申报年份（如2025）
近三年 = [申报年份-2, 申报年份-1, 申报年份]
```

### 研发项目时间约束
```
RD项目开始时间 >= 近三年第一年1月1日
RD项目结束时间 <= 申报年份12月31日
RD项目可以跨年度
RD项目必须覆盖近三年
```

### 知识产权时间约束
```
IP授权日期 <= 申报年份
```

### 高新产品收入时间约束
```
PS上年度收入 = 申报年份前一年的收入
PS收入必须与审计报告一致
```

## 子技能调用说明

完成本技能的前期工作（RDPS关联表+科技人员清单）后，按顺序调用子技能：
1. `/gxtz-ip-tables` — 生成IP知识产权表
2. `/gxtz-toai-tables` — 生成TOAI汇总表
3. 然后按流程调用外部技能生成RD表、成果转化表、PS表
