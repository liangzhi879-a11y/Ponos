---
name: gxtz-rd-tables
description: "RD研发项目表生成 — 项目概况/预算/人员/进度/验收。负责高新技术企业认定中RD研发项目汇总表的生成与模板注入，包括研发活动编号、名称、技术领域、时间、经费、人员、长文本字段（目的/核心技术/阶段成果）。数据来源于立项报告、验收报告、研发费用辅助账。对应TRAE源技能gxtz-core-tables的RD表部分。"
version: "1.40.1"
triggers:
  - RD表
  - 研发项目表
  - 研发立项表
  - 项目概况表
  - 研发活动汇总
  - 研究开发活动汇总
---

## 角色定位

本技能负责高新技术企业认定中**RD研发项目汇总表**的生成与模板注入。数据来源于企业立项报告、验收报告和研发费用辅助账。

## 输出文件

- `{企业名称}-企业研究开发活动汇总表（近三年执行的活动）.xlsx`
- 存放到 `00_核心表格/` 目录

## 核心脚本

```bash
# 生成RD表
python {{PONOS_SKILLS}}/_common/generate_rd_table.py --project-root "."
# 校验RD表
python {{PONOS_SKILLS}}/_common/validate_rd_table.py --input "00_核心表格/RD表.xlsx"
```

或者使用模板注入方式：

```python
from _common.template_injector import TemplateInjector

injector = TemplateInjector(template_dir="00_核心表格", output_dir="_output", enterprise_name="企业名")
injector.inject_rd_table(rd_data)
```

### 模板搜索

RD汇总表模板搜索关键词：`研究开发活动汇总`
两级查找：项目目录 → 内置模板（`_common/templates/`）

## 数据来源

- 立项报告（2.RD证明材料/）
- 验收报告
- 研发费用辅助账

## RD表字段定义（18列）

| 列号 | 字段名 | 说明 | 字数限制 |
|:---:|------|------|:--------:|
| 1 | 研发活动编号 | RD01, RD02...（自动生成） | - |
| 2 | 研发活动名称 | 完整项目名称+"研发" | - |
| 3 | 技术领域（一级） | 从国家重点支持的高新技术领域中选择 | - |
| 4 | 技术领域（二级） | 从国家重点支持的高新技术领域中选择 | - |
| 5 | 技术领域（三级） | 从国家重点支持的高新技术领域中选择 | - |
| 6 | 开始时间 | YYYY-MM-DD格式 | - |
| 7 | 结束时间 | YYYY-MM-DD格式 | - |
| 8 | 技术来源 | 企业自有技术/合作开发/引进技术 | - |
| 9 | 知识产权编号 | 关联的IP编号，逗号分隔（如IP01,IP02） | - |
| 10 | 研发经费总预算（万元） | 项目总预算 | - |
| 11 | 研发经费近三年总支出（万元） | 近三年实际支出 | - |
| 12 | 其中：第一年支出（万元） | 第一年实际支出 | - |
| 13 | 其中：第二年支出（万元） | 第二年实际支出 | - |
| 14 | 其中：第三年支出（万元） | 第三年实际支出 | - |
| 15 | 研发活动人员数 | 参与研发的人员数量 | - |
| 16 | 目的及组织实施方式（限400字） | 从立项报告中提取 | 限400字（≥280字） |
| 17 | 核心技术及创新点（限400字） | 从立项报告中提取 | 限400字（≥350字） |
| 18 | 取得的阶段性成果（限400字） | 从立项报告中提取 | 限400字（≥280字） |

### RD表模板字段名对照（15列，必须严格按此名称）

| 列号 | 字段名 |
|:---:|------|
| 1 | 研发项目编号 |
| 2 | 研发项目名称 |
| 3 | 技术领域（一级） |
| 4 | 技术领域（二级） |
| 5 | 技术领域（三级） |
| 6 | 开始时间 |
| 7 | 结束时间 |
| 8 | 研发经费预算（万元） |
| 9 | 研发经费实际支出（万元） |
| 10 | 项目来源 |
| 11 | 研发形式 |
| 12 | 项目组成员 |
| 13 | 对应IP编号 |
| 14 | 对应PS编号 |
| 15 | 备注 |

注意：不同的模板版本字段名不同，请根据实际使用的模板严格对齐。使用前先读取模板结构。

### 字段提取方法

```python
def extract_rd_fields(rd_project, year):
    """
    从RD项目信息中提取字段
    rd_project: dict，包含项目基本信息
    year: int，申报年份
    """
    rd_data = {
        '研发活动编号': rd_project['rd_id'],  # 如RD01
        '研发活动名称': rd_project['name'],    # 如"快速充电电路研发"
        '技术领域（一级）': rd_project['tech_field_1'],
        '技术领域（二级）': rd_project['tech_field_2'],
        '技术领域（三级）': rd_project['tech_field_3'],
        '开始时间': rd_project['start_date'],
        '结束时间': rd_project['end_date'],
        '技术来源': rd_project['tech_source'],  # "企业自有技术"
        '知识产权编号': ','.join(rd_project['ip_ids']),
        '研发经费总预算（万元）': rd_project['budget'],
        '研发经费近三年总支出（万元）': rd_project['total_expenditure'],
        '其中：第一年支出（万元）': rd_project['year1_expenditure'],
        '其中：第二年支出（万元）': rd_project['year2_expenditure'],
        '其中：第三年支出（万元）': rd_project['year3_expenditure'],
        '研发活动人员数': rd_project['staff_count'],
        '目的及组织实施方式（限400字）': rd_project['purpose'],
        '核心技术及创新点（限400字）': rd_project['tech_innovation'],
        '取得的阶段性成果（限400字）': rd_project['achievements']
    }
    return rd_data
```

## 长文本字段生成规范（v1.39.0）

RD表的3个长文本字段必须由 agent 按提示词生成，禁止算法拼接或 `optimize_text_to_fit()` 截断：

| 字段 | 字数要求 | 生成方式 |
|------|:--------:|---------|
| 目的及组织实施方式 | 280-400字 | 从立项书中提取，分"目的"和"实施方式"两部分 |
| 核心技术及创新点 | 350-400字 | 从立项书中提取核心技术描述，创新点分点列出 |
| 取得的阶段性成果 | 280-400字 | 按时间顺序描述项目进展，提及关联知识产权 |

### 撰写要求

1. 项目名称后必须加"研发"二字
2. 技术领域必须从《国家重点支持的高新技术领域》中选择
3. 目的及组织实施方式要分"目的"和"实施方式"两部分
4. 核心技术要详细描述技术内容，创新点要分点列出
5. 阶段性成果要按时间顺序描述项目进展
6. 成果中要提及关联的知识产权（专利号+名称）
7. 不要出现RD及IP编号，用项目或知识产权名称代替
8. 语言正式，避免使用"领先"、"首创"等夸大词汇
9. 不要轻易使用"AI"等描述，除非项目资料中明确显示

## 经费一致性校验

```python
def validate_rd_budget(rd_table):
    """校验RD表经费一致性"""
    for _, row in rd_table.iterrows():
        total = float(row['研发经费近三年总支出（万元）'])
        year1 = float(row['其中：第一年支出（万元）'])
        year2 = float(row['其中：第二年支出（万元）'])
        year3 = float(row['其中：第三年支出（万元）'])
        budget = float(row['研发经费总预算（万元）'])
        
        if abs(total - (year1 + year2 + year3)) > 0.01:
            raise ValueError(f"RD项目{row['研发活动编号']}近三年总支出不等于三年支出之和")
        if total > budget:
            raise ValueError(f"RD项目{row['研发活动编号']}近三年总支出超过总预算")
```

## 时间约束

```
RD项目开始时间 >= 近三年第一年1月1日
RD项目结束时间 <= 申报年份12月31日
RD项目可以跨年度（如2024-04-01 ~ 2025-02-28）
RD项目必须覆盖近三年（每年至少有1个项目在执行）
```

## 审核校验

### 字段命名校验
- 禁止使用"起止时间"代替"开始时间"+"结束时间"（分两列）
- 禁止使用"技术领域"合并字段代替"技术领域（一级/二级/三级）"3列
- 禁止使用"自主研发"作为技术来源（必须用"企业自有技术"）

### 字数审核
- 目的及组织实施方式（≥280字，≤400字）
- 核心技术及创新点（≥350字，≤400字）
- 取得的阶段性成果（≥280字，≤400字）

### 生成前自检清单

```
□ RD表列名从第1列到第15列逐一核对
□ "开始时间"/"结束时间"分两列（非"起止时间"合并）
□ "技术领域"三列独立（一级/二级/三级），不合并为单列
□ 使用"企业自有技术"而非"自主研发"
□ 列序与模板完全一致
```

## 关联校验

### IP编号关联校验
RD表中的知识产权编号必须是IP表中知识产权编号的子集。

```python
def validate_ip_association(rd_table, ip_table):
    ip_ids = set(ip_table['知识产权编号'].tolist())
    for _, row in rd_table.iterrows():
        rd_ip_ids = [x.strip() for x in row['知识产权编号'].split(',') if x.strip()]
        for ip_id in rd_ip_ids:
            if ip_id not in ip_ids:
                raise ValueError(f"RD表中的{ip_id}在IP表中不存在")
```

### 时间一致性校验

```python
def validate_time_constraints(rd_table, year):
    from datetime import datetime
    start_date = datetime(year-2, 1, 1)
    end_date = datetime(year, 12, 31)
    for _, row in rd_table.iterrows():
        rd_start = datetime.strptime(row['开始时间'], '%Y-%m-%d')
        rd_end = datetime.strptime(row['结束时间'], '%Y-%m-%d')
        if rd_start < start_date:
            raise ValueError(f"RD项目{row['研发活动编号']}开始时间早于近三年")
        if rd_end > end_date:
            raise ValueError(f"RD项目{row['研发活动编号']}结束时间晚于申报年份")
```

## 模板对齐规范

- 表头：宋体 12号 bold、左对齐、自动换行、行高 46.8 或 78
- 数据：宋体 11号、左对齐、自动换行
- 所有单元格：thin 边框
- 禁止合并标题行（第1行必须直接是表头）
- 生成前必须先读取模板结构

## 输出规范

文件命名：`{企业名称}-企业研究开发活动汇总表（近三年执行的活动）.xlsx`

## 通用禁止事项

1. 禁止编造内容，所有数据必须来自真实文件
2. 禁止跳过脚本执行
3. 禁止跳过审核步骤
4. 禁止自行兜底（脚本报错时不得自行编写等效代码）
5. 禁止合并/简化字段名
6. 禁止从零模仿模板生成表格（必须使用 template_injector.py）
