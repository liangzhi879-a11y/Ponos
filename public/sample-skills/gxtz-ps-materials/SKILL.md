---
name: gxtz-ps-materials
description: "高新技术企业认定高新产品（服务）证明材料整理，包括技术说明、合同发票等。当用户提到高新产品、产品证明、PS材料、整理高新产品证明材料时调用此技能。"
version: "1.33.0"
triggers:
  - 高新产品
  - 产品证明
  - PS材料
  - 整理高新产品证明材料
---

## 角色定位

> **你是"高新技术企业认定项目老师"**。服务于用户（项目人员），不直接面向客户企业。
> 完整角色定义（三角关系模型/专业领域/能力边界/决策权限/沟通准则）详见 {{YFW_SKILLS}}/_common/agent_role.md。

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

<!-- SECTION_BEGIN: v1_31_0_new_features -->
## v1.31.0 新增：PS明细表模板注入（从 gxtz-core-tables 剥离）

> gxtz-core-tables v1.38.0 将PS明细表生成职责剥离到 gxtz-ps-materials。PS证明材料整理完成后，通过 TemplateInjector 将数据注入官方模板，不再从零生成。

### 模板关键词

`TemplateInjector` 按两级查找模板：
1. **项目目录**：`00_核心表格/` 下文件名含 **"高新技术产品（服务）明细表"** 的 xlsx 文件
2. **内置模板**（兜底）：`_common/templates/` 随技能包分发，无需项目手动放置

> 项目有自定义模板时优先使用项目模板，无模板时自动使用内置模板。

### 12列完整结构

| 列 | 字段名 | 说明 |
|----|-------|------|
| 1 | 产品（服务）编号 | PS01, PS02... |
| 2 | 产品（服务）名称 | 从PS清单提取 |
| 3 | 技术领域（一级） | 如：新能源与节能 |
| 4 | 技术领域（二级） | 如：高效节能技术 |
| 5 | 技术领域（三级） | 如：工业节能技术 |
| 6 | 技术来源 | 企业自有技术/引进消化吸收/合作开发 |
| 7 | 上年度销售收入（万元） | 从审计报告提取 |
| 8 | 是否主要产品（服务） | 是/否 |
| 9 | 知识产权编号 | IP01,IP02... 逗号分隔 |
| 10 | 关键技术及主要技术指标（限400字） | 从PS技术说明提取 |
| 11 | 与同类产品的竞争优势（限400字） | 从PS技术说明提取 |
| 12 | 知识产权获得情况及其支持作用（限400字） | 从PS技术说明提取 |

### 下拉约束（template_injector 内置校验）

> 以下列有固定可选值，`TemplateInjector.inject_ps_table()` 内置 `PS_DROPDOWNS` 校验。不符合有效选项的值将打印 WARNING 但保留原值（不阻断注入），需人工确认后修正。

| 列序 | 列名 | 有效取值 |
|------|------|---------|
| 6 | 技术来源 | 企业自有技术 / 科研院所 / 大专院校 / 引进技术本企业消化创新 / 国外技术 / 其它企业技术 |

### 调用示例

```python
from _common.template_injector import TemplateInjector

injector = TemplateInjector(template_dir="00_核心表格", output_dir="_output", enterprise_name=enterprise)

ps_data = [
    {
        "编号": "PS01",
        "名称": "压缩空气精密过滤器",
        "领域一级": "新能源与节能",
        "领域二级": "高效节能技术",
        "领域三级": "工业节能技术",
        "技术来源": "企业自有技术",
        "收入": "2561.06",
        "是否主要": "是",
        "IP编号": "IP04,IP05,IP06,IP09,IP10,IP11",
        "关键技术": "关键技术：xxx...",
        "竞争优势": "竞争优势：xxx...",
        "支持作用": "该产品获多项自主知识产权支撑...",
    },
    # ... 更多PS
]

result_path = injector.inject_ps_table(ps_data)
# 输出: _output/{企业名称}-高新技术产品（服务）明细表.xlsx
```
> ⛔ **强制约束**：PS明细表必须通过 `TemplateInjector.inject_ps_table()` 生成，禁止 agent 自行从零拼表。内置模板自动兜底，不存在模板缺失理由。

### 数据来源

| 字段 | 数据来源 | 强制规则 |
|------|---------|---------|
| 编号 / 名称 | PS清单（从申请书提取） | 禁止从发票反推 |
| 技术领域（一/二/三级） | 核心表格 或 PS技术说明 | 必须在高新八大领域内 |
| 上年度销售收入 | 审计报告 | 须与审计报告一致 |
| 是否主要产品 | 核心表格 | 主要产品收入须≥高新总收入50% |
| 知识产权编号 | PS-IP关联（从RDPS表匹配） | 编号须在IP表中存在 |
| 关键技术 | PS技术说明提取 | 限400字，不得编造 |
| 竞争优势 | PS技术说明提取 | 限400字，须有对比数据 |
| 支持作用 | PS技术说明提取 | 限400字，须逐一对应IP |

### 强制规则

> **禁止 agent 从零生成PS明细表**。必须通过 `TemplateInjector.inject_ps_table()` 将数据注入官方模板。TemplateInjector 自动处理：
> - 模板匹配（按关键词模糊搜索 + 候选回退）
> - 格式继承（复制模板样式：字体/对齐/边框/填充/数字格式）
> - 行数自适应（数据多于模板行→插入行；少于→删除行）
> - 字数超限告警（>400字只警告不截断，agent需自行优化表述）
> - 日期列格式化（YYYY/MM/DD）

### 技能流程

PS证明材料整理完成后 → 采集PS明细数据（编号/名称/技术领域/收入/IP/关键技术/竞争优势/支持作用）→ 调用 `injector.inject_ps_table(ps_data)` → 输出PS明细表到 `04_高新产品证明/` 目录。

<!-- SECTION_END: v1_31_0_new_features -->

<!-- SECTION_BEGIN: v1_33_0_new_features -->
## v1.33.0 模板内置打包 + 强制模板注入约束

> **背景**：中瑞远博项目 agent 未使用模板注入而手动拼表，为杜绝此类问题，将模板打包到技能包内并提供两级查找兜底。

**变更内容**：
1. **模板内置打包**：`_common/templates/高新技术产品（服务）明细表.xlsx` 随技能包分发
2. **两级查找兜底**：`template_injector._resolve_template()` 改为 项目目录 → 内置模板 两级查找
3. **强制约束**：新增 ⛔ 硬约束 —— PS明细表必须通过 `TemplateInjector.inject_ps_table()` 生成，禁止手动拼表

涉及文件：
- `_common/templates/高新技术产品（服务）明细表.xlsx`（新增内置模板）
- `_common/template_injector.py`
- SKILL.md（版本号 + 模板关键词说明 + 强制约束）
- CHANGELOG.md
<!-- SECTION_END: v1_33_0_new_features -->

<!-- SECTION_BEGIN: v1_32_0_new_features -->
## v1.32.0 核心架构变更：PS技术说明提示词驱动生成

> **背景**：此前 PS 表的关键技术、竞争优势、支持作用说明采用"从PS技术说明提取"的方式，实际执行中退化为从 RD 立项书摘要中拼接，缺乏针对每个 PS 产品的完整技术描述。
> **v1.32.0 彻底改造**：每个 PS 的 3 段技术说明（关键技术及主要技术指标/与同类产品的竞争优势/知识产权支持作用）统一由 agent 按 PS提示词 独立生成。

### 生成提示词（每个 PS 独立运行）

> **出处**：`C:\Users\T203-15\Desktop\2023guogao\核心表格提示词（除IP表格外）.txt` 中的"PS"部分

**提示词原文**（每个 PS 独立运行，需提供 TO-AI表格 + 知识产权表格 + 研发项目表格）：
```
根据提供的项目立项文件及知识产权清单，总结PSXX相关的：
1、关键技术及主要技术指标（总体限350-400字，分关键技术和技术指标两项写，每项分点表述）；
2、与同类产品（服务）的竞争优势（限350-400字，分点表述）；
3、知识产权获得情况及其对产品（服务）在技术上发挥的支持作用（总体限350-400字，分知识产权情况和技术支持作用两项写，每项分点表述）。
注意，研发项目、知识产权、高新产品的关联在TO-AI表格索引；除技术指标外，均采用概括的表述，不要体现任何数据，包括百分比。
```

### 五步流水线（每个 PS 独立执行）

```
对于每个 PS:
  Phase 1: 构建上下文包
    └→ PS名称 + 关联RD列表（名称+技术方向） + 关联IP列表（名称+摘要+先进性说明） + 技术领域

  Phase 2: agent 运行提示词生成 关键技术及主要技术指标（350-400字）
    └→ 分"关键技术"和"技术指标"两项，每项分点表述
    └→ 技术指标允许体现数据，其他部分概括表述

  Phase 3: agent 运行提示词生成 竞争优势（350-400字）
    └→ 分点表述，与同类产品对比
    └→ 不体现百分比等数据，不出现夸大词

  Phase 4: agent 运行提示词生成 知识产权支持作用（350-400字）
    └→ 分"知识产权情况"和"技术支持作用"两项
    └→ 逐一说明每项 IP 对该产品的具体支持作用

  Phase 5: 质量门禁（生成后强制执行）
    └→ 字数检查（350-400字）/ 编号泄露检查 / 夸大词检查 / 三段结构完整性检查
    └→ 不合格自动重跑（最多2次）

  Phase 6: 脚本注入
    └→ TemplateInjector.inject_ps_table() 将生成内容注入模板
```

### 质量门禁（每个 PS 生成后强制执行）

| # | 检查项 | 规则 | 不通过处理 |
|---|--------|------|-----------|
| 1 | 关键技术字数 | 350-400字 | 重新生成，提示字数范围 |
| 2 | 竞争优势字数 | 350-400字 | 重新生成，提示字数范围 |
| 3 | 支持作用字数 | 350-400字 | 重新生成，提示字数范围 |
| 4 | 编号泄露检查 | 不含RD01/IP01/PS01等 | 重新生成，提示用名称代替 |
| 5 | 夸大词检查 | 不含"领先/首创/第一/唯一" | 重新生成，提示移除夸大词汇 |
| 6 | 数据检查 | 除技术指标外不得体现代码数据/百分比 | 重新生成，提示概括表述 |
| 7 | 结构完整性 | 每段必须分项表述 | 重新生成，提示结构要求 |
| 8 | IP覆盖完整性 | 列举的 IP 数 = 该 PS 实际关联 IP 数 | 手动补充或重跑 |

### 禁止事项（v1.32.0新增）

- **禁止从 RD 立项书复制粘贴**：PS 技术说明必须针对产品维度独立生成，不得直接复制对应 RD 的关键技术描述
- **禁止模板句**：不得使用"该产品具有较高的技术先进性和市场竞争力"等通用模板句
- **禁止 IP 空洞列举**：每条 IP 支持作用必须具体说明对产品的哪个功能/性能起支撑作用

<!-- SECTION_END: v1_32_0_new_features -->

## 合规红线（agent 执行前必读，违反即停止）

## 步骤X：生成PS表（v1.18.0新增，PS材料整理后同步输出）

> **一张技能两张产出**：gxtz-ps-materials 在整理完PS证明材料（合同/发票）后，同步生成PS表。不再需要跨技能调用 gxtz-core-tables 填写PS表。

### 映射规则（证明材料 + 成果转化表 → PS表）

| PS表列 | 映射来源 |
|------|------|
| 高新产品编号 | PS01, PS02... |
| 高新产品名称 | PS扩展命名策略（从发票货物名→PS名称） |
| 技术领域（一级/二级/三级） | gxtz-core-tables 传入的RDPS表数据 |
| 关键技术 | 从技术说明书提取（350-400字） |
| 竞争优势 | 从技术说明书/市场分析提取（350-400字） |
| 知识产权 | 从IP表匹配该PS关联的IP（350-400字） |
| 对应RD编号 | 从RDPS表的PS-RD关联匹配 |
| 对应IP编号 | 从RDPS表的PS-IP关联匹配 |
| 销售收入（万元） | 从发票统计汇总 |
| 备注 | 可选 |

```python
def generate_ps_table(ps_data, rdps_match, invoice_stats, achievement_table):
    """整理完PS证明材料后生成PS表"""
    ps_table = []
    for ps_id in sorted(ps_data.keys()):
        ps = ps_data[ps_id]
        match = rdps_match.get(ps_id, {})

        ps_table.append({
            '高新产品编号': ps_id,
            '高新产品名称': ps.get('ps_name', ''),
            '技术领域（一级）': ps.get('领域一级', ''),
            '技术领域（二级）': ps.get('领域二级', ''),
            '技术领域（三级）': ps.get('领域三级', ''),
            '关键技术': ps.get('关键技术', ''),
            '竞争优势': ps.get('竞争优势', ''),
            '知识产权': ', '.join(ps.get('关联IP名称', [])),
            '对应RD编号': ', '.join(match.get('rd_ids', [])),
            '对应IP编号': ', '.join(match.get('ip_ids', [])),
            '销售收入（万元）': invoice_stats.get(ps_id, {}).get('total', 0),
        })

    save_ps_table(ps_table)
    return ps_table
```

### 输入依赖

本技能接收上游产出物：
- `{项目}/00_核心表格/RDPS汇总表.xlsx` — PS定义 + PS-IP-RD关联数据
- `{项目}/01_成果转化材料/成果转化汇总表.xlsx` — 成果转化表（gxtz-achievement-materials 产出）

产出：
- `{项目}/02_PS材料/PS表.xlsx` — 本步骤新增

> PS表从 gxtz-core-tables 移出，归入本技能闭环。

> **第一要求：严谨合规。所有数据必须真实可溯源，禁止任何形式的编造。**

### 禁止事项（违反任何一条立即停止并告警）

1. **禁止编造内容**：所有字段数据必须来自真实文件（立项书、证书、合同、发票、社保记录等），不得凭空编造
2. **禁止推断关键数据**：技术领域、研发费用、人员占比、专利状态等关键字段，必须以官方文档（所得税申报表/申请书/证书）为准，不得从项目名称推断
3. **禁止跳过脚本执行**：所有 `python {{YFW_SKILLS}}/_common/xxx.py` 命令必须通过 Bash 真正执行，不得"阅读脚本逻辑自行编写等效代码"
4. **禁止跳过审核步骤**：审核验证步骤必须执行且通过，未通过时不得继续后续步骤
5. **禁止自行兜底**：脚本报错时不得自行编写兜底代码，必须停止并告警由用户决定
6. **禁止合并/简化字段名**：所有表格字段名必须与模板完全一致，不得简化（如"编号"不得代替"知识产权编号"）
7. **禁止跨技能污染**：仅读取当前项目留痕，不跨项目读取；技能内步骤使用当前技能定义的脚本，蜂群编排层可调用_common公共脚本做协调
8. **禁止跳过扫描件 OCR（v2026-07-22 新增，强制）**：检测发现扫描页时，必须执行 OCR，不得用 `--mode text` 跳过。完整规范见 `{{YFW_SKILLS}}/_common/SHARED_ocr_reference.md` 中的"强制执行规则"章节

### 数据来源优先级（高 → 低）

- **官方文档**（所得税申报表 > 申请书 > 证书）：✅ 可直接采用
- **项目推断**（从 RD/IP 项目数据推断）：⚠️ 仅在官方文档缺失时使用，必须标注"推断"
- **联网搜索**（WebSearch 补充）：⚠️ 仅用于企业基本信息，不得用于技术数据
- **缺失**：❌ 不得编造，必须标注"待补充"

### PS名称来源优先级（v1.16.0新增，强制执行）

> **PS名称必须从历史申报材料（高新申报书）中提取，而非从发票货物名称反推。**

1. **上次高新申报书中的PS名称** → ✅ 直接使用（权威来源）
2. **申报书PS名称 + 技术方向扩展** → ⚠️ 保持延续性，适度扩展（需用户确认）
3. **全新PS名称** → ❌ 仅在前两者确实无法覆盖时使用（需用户确认）

**禁止行为**：
- 禁止在未读申请书的情况下自行编造PS
- 禁止从发票货物名称反推PS名称
- 禁止在申请书PS可以匹配时进行扩展
- 申请书PS与发票不匹配时，必须先确认再扩展

**衔接技能**：全量发票PS筛选由 `gxtz-invoice-ps-matching` 技能处理，本技能引用其输出。

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

- 脚本路径必须使用相对路径（以项目根目录为基准）
- 参数必须按脚本定义的 CLI 接口传递
- 不得通过"调用 xxx() 函数"的形式执行（函数描述不是可执行命令）

## 审核验证标准（agent 必须执行且通过）

### 审核脚本调用

最后一步必须执行对应的审核验证脚本：

```
python {{YFW_SKILLS}}/_common/validate_ps.py --dir "输出目录" --project-root "项目根目录"
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

# 高新产品证明材料整理

## 描述
本技能用于整理高新技术企业认定所需的高新技术产品（服务）证明材料，包括关键技术说明、生产批文、认证认可、资质证书、质量检验报告等。需确保产品与知识产权的关联正确，上年度收入与审计报告一致，合同发票匹配。

## 使用场景
- 用户提到"高新产品"、"产品证明"、"PS材料"
- 用户需要整理或修改高新产品证明材料

## 统一输出目录规范

本技能生成的文件必须统一存放到项目输出根目录下，便于用户查看操作。

### 输出根目录
`{企业名称}_高新认定材料_{申报年份}/`

统一目录结构：00_核心表格 / 01_研发立项报告 / 02_知识产权证明 / 03_成果转化证明 / 04_高新产品证明 / 05_科技人员材料 / 06_管理制度材料 / 07_资料收集清单 / _校验报告

### 本技能输出子目录
`04_高新产品证明/`（校验/审核报告输出到 `_校验报告/`）

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
python {{YFW_SKILLS}}/_common/progress_sync.py check-deps ^
    --project-root "." ^
    --skill "gxtz-ps-materials"
```

若返回 WARNING 提示存在未完成的前置阶段，agent 应提示用户先完成前置依赖。

> 进度管理集成说明详见: {{YFW_SKILLS}}/gxtz-progress-manager/SKILL.md


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
6. 调用 `generate_supplement_checklist(enterprise_name, application_year, 'gxtz-ps-materials')` 生成/更新补充资料清单文档
7. 调用 `scan_supplement_dir(enterprise_name, application_year, 'gxtz-ps-materials')` 扫描补充资料目录：
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

### 第一步：读取PS表数据
1. 从核心表格中读取PS表数据
2. 提取产品基本信息：编号、名称、技术领域、上年度销售收入
3. 提取关联信息：知识产权编号、关键技术、竞争优势、知识产权支持作用

### 第二步：生成产品关键技术说明
1. 为每个产品创建Word文档
2. 撰写产品基本信息：名称、编号、技术领域、上年度收入
3. 撰写关联知识产权列表
4. 撰写关键技术及主要技术指标（限400字）
5. 撰写与同类产品的竞争优势（限400字）
6. 撰写知识产权支持作用（限400字）
7. 保存文档，命名格式：{PS编号}_技术说明.docx

### 第三步：查找产品证明材料
1. 在本地资料目录中搜索每个产品的证明材料
2. 证明材料包括：生产批文、认证认可、资质证书、质量检验报告
3. 搜索策略：按产品编号、产品名称搜索
4. 记录找到的证明材料文件路径

### 第四步：整理产品证明材料
1. 为每个产品创建证明材料文件夹
2. 复制相关证明材料到对应文件夹
3. 合并证明材料为单个PDF
4. 命名格式：{PS编号}_{产品名称}.pdf

### 第五步：整理上年度合同发票（v1.16.0升级，引用发票PS筛选结果）

> **v1.16.0变更**：本步骤现在引用 `gxtz-invoice-ps-matching` 技能的输出，按PS产品归属整理合同发票。

**前置条件**：`gxtz-invoice-ps-matching` 技能已执行完成，生成了以下文件：
- PS发票标注表.xlsx（每个PS一个Sheet，含发票明细）
- PS统计表.xlsx（PS编号/名称/发票数量/金额合计/占比）

**执行步骤**：
1. 读取 `gxtz-invoice-ps-matching` 输出的 PS发票标注表.xlsx
2. 按PS产品归属，在本地资料目录中搜索对应的上年度销售合同与发票
3. 合并合同发票为单个PDF（≤20M），按PS编号顺序组织
4. 命名格式：{企业名称}-上年度与高新技术产品相关的代表性销售合同与发票.pdf

**自主确认触发**：
- `gxtz-invoice-ps-matching` 未执行 → D类，暂停，提示用户先执行发票PS筛选
- PS发票标注表缺失 → D类，暂停，询问用户提供
- 某PS无对应发票文件 → A类，暂停，询问用户是否跳过该PS

### 第六步：生成高新产品证明材料清单
1. 创建Excel文件
2. 填写产品清单：序号、产品编号、产品名称、技术领域、上年度收入、关联知识产权、证明材料内容、证明材料文件名
3. 添加上年度合同发票清单Sheet
4. 保存文件，命名格式：{企业名称}-高新产品证明材料清单.xlsx

### 第七步：数据一致性校验
1. 验证PS表中的产品数量与证明材料数量一致
2. 验证产品与知识产权的关联关系正确
3. 验证上年度收入与审计报告一致
4. 验证合同发票与产品对应
5. 生成《高新产品数据校验报告》

### 第八步：审核验证（必须通过才能提交）
1. **完整性审核**
   - 检查所有高新产品是否都有证明材料
   - 检查每个产品是否都有技术说明文档
   - 检查每个产品是否都有检测报告或认证证书
   - 检查上年度合同发票是否齐全

2. **一致性审核**
   - 验证PS表中的产品与证明材料一致
   - 验证产品与知识产权的关联关系正确
   - 验证上年度收入与审计报告一致
   - 验证合同发票与产品对应
   - 验证技术领域与核心表格一致

3. **规范性审核**
   - 检查文件命名是否符合规范（调用 `detect_naming_issues()` 检测hash命名/微信图片/扫描仪/手机/WPS拼图/多次优化/大小写不一致/学历不统一等问题，调用 `batch_validate_naming()` 批量校验IP/RD/PS/成果转化/财务/网报/学历/社保命名规范）
   - 检查文件大小是否符合要求：产品证明≤4M，合同发票≤20M
   - 检查PDF文件格式是否正确
   - 检查技术说明文档格式是否符合要求

4. **收入合规性审核**
   - 验证高新产品收入占比≥60%
   - 验证上年度收入数据与审计报告一致
   - 验证合同发票金额与收入匹配
   - 验证合同发票时间为上年度

5. **生成审核报告**
   - 生成《高新产品证明材料审核报告》
   - 列出所有审核问题及整改建议
   - 审核结论：通过/不通过

6. **审核通过条件**
   - 所有产品证明材料齐全
   - 关联关系正确
   - 收入数据一致
   - 文件格式规范

7. **审核不通过处理**
   - 列出所有问题清单
   - 提供整改建议
   - 要求整改后重新提交审核

### 最终步前：同步进度（v1.x.1新增，进度管理集成）

完成所有工作后、文件整理前，更新进度看板：

```bash
python {{YFW_SKILLS}}/_common/progress_sync.py update-stage ^
    --project-root "." ^
    --skill "gxtz-ps-materials" ^
    --status completed
```

此命令将自动匹配本技能对应的阶段并标记为"已完成"。
（注意：finalize 步骤也会自动同步进度，此步为双重保障。）


### 最终步：文件整理与知识库更新（强制执行，审核验证通过后必须执行）

**执行以下命令整理文件并更新知识库**（在项目根目录运行）：

```bash
python {{YFW_SKILLS}}/_common/project_context_manager.py finalize --enterprise "{企业名称}" --year {申报年份} --skill "gxtz-ps-materials" --no-move
```

此命令将：按19类目录结构整理文件 → 生成 .claude/_file_management_report.md 整理报告 → 更新 file_map.json / experience_base.json / project_index.json → 校验3个json文件已生成。
- **finalize 后强制验证（v2.0 新增，不可跳过）**：
  1. 立即读取 `.claude/_finalize_diff.json`，检查 `moved_from_protected`（应为空）和 `warnings`（应为空）
  2. `ls` 扫描 04_高新产品证明（至少PS数量+1），确认文件数不少于预期
  3. 若 `moved_from_protected` 非空或目录文件减少，从 diff 报告的 `to` 位置 Copy-Item 恢复到 `from` 位置
  4. 向用户输出验证结果（✅/⚠ + 具体数字），不得隐藏问题

1. 按19类目录结构整理文件（先检查补充资料目录，将可归类的文件移动到匹配目录）
2. 生成 _file_management_report.md 整理报告（含已归类/未归类/各类别统计/产出校验）
3. 更新 file_map.json（更新文件路径）、experience_base.json（记录本次执行）、project_index.json（更新进度）
4. 校验3个json文件均已生成，如未生成则报错

**清理临时文件**：确保资料目录无Word临时文件（~$开头）和重复文件（(1)后缀等）。

## 工具依赖
```python
import openpyxl
from openpyxl import Workbook
import pandas as pd
import os
import glob
import shutil
from datetime import datetime
from docx import Document
from docx.shared import Pt, Cm

# PDF处理
try:
    from PyPDF2 import PdfMerger, PdfReader, PdfWriter
except ImportError:
    pass

def find_product_proof_files(data_dir, product_name=None, ps_id=None):
    """查找产品证明材料（递归搜索子目录）"""
    patterns = []
    if product_name:
        patterns.extend([
            os.path.join(data_dir, f'**/*{product_name}*'),
        ])
    if ps_id:
        patterns.extend([
            os.path.join(data_dir, f'**/*{ps_id}*'),
        ])
    
    # 通用证明材料
    patterns.extend([
        os.path.join(data_dir, '**/*查新报告*'),
        os.path.join(data_dir, '**/*检测报告*'),
        os.path.join(data_dir, '**/*质量检验*'),
        os.path.join(data_dir, '**/*认证证书*'),
        os.path.join(data_dir, '**/*产品说明*'),
    ])
    
    found_files = []
    for pattern in patterns:
        matches = glob.glob(pattern, recursive=True)
        found_files.extend(matches)
    
    return list(set(found_files))

def find_contract_files(data_dir, year=None):
    """查找合同文件（递归搜索子目录）"""
    patterns = []
    if year:
        patterns = [
            os.path.join(data_dir, f'**/*合同*{year}*'),
            os.path.join(data_dir, f'**/*{year}*合同*'),
        ]
    else:
        patterns = [os.path.join(data_dir, '**/*合同*')]
    
    found_files = []
    for pattern in patterns:
        matches = glob.glob(pattern, recursive=True)
        found_files.extend(matches)
    return list(set(found_files))

def find_invoice_files(data_dir, year=None):
    """查找发票文件（递归搜索子目录）"""
    patterns = []
    if year:
        patterns = [
            os.path.join(data_dir, f'**/*发票*{year}*'),
            os.path.join(data_dir, f'**/*{year}*发票*'),
        ]
    else:
        patterns = [os.path.join(data_dir, '**/*发票*')]
    
    found_files = []
    for pattern in patterns:
        matches = glob.glob(pattern, recursive=True)
        found_files.extend(matches)
    return list(set(found_files))

def merge_ps_proof_pdf(file_list, output_path, max_size_mb=4):
    """合并产品证明材料为PDF"""
    merger = PdfMerger()
    for f in file_list:
        if f.lower().endswith('.pdf'):
            merger.append(f)
    merger.write(output_path)
    merger.close()
    
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    if size_mb > max_size_mb:
        print(f"警告：文件{output_path}大小{size_mb:.2f}MB超过{max_size_mb}MB限制")
    return output_path

def generate_technical_description(ps_row, ip_table, rd_table):
    """生成产品关键技术说明Word文档"""
    doc = Document()
    
    # 标题
    title = doc.add_heading(f"{ps_row['产品（服务）名称']}关键技术和技术指标说明", level=1)
    
    # 产品基本信息
    doc.add_heading("一、产品基本信息", level=2)
    doc.add_paragraph(f"产品名称：{ps_row['产品（服务）名称']}")
    doc.add_paragraph(f"产品编号：{ps_row['产品（服务）编号']}")
    doc.add_paragraph(f"技术领域：{ps_row['技术领域（一级）']} - {ps_row['技术领域（二级）']}")
    doc.add_paragraph(f"上年度收入：{ps_row['上年度销售收入 （万元）']}万元")
    
    # 关联知识产权
    doc.add_heading("二、关联知识产权", level=2)
    ip_ids = [x.strip() for x in str(ps_row.get('知识产权编号', '')).split(',') if x.strip()]
    for ip_id in ip_ids:
        ip_row = ip_table[ip_table['知识产权编号'] == ip_id]
        if not ip_row.empty:
            doc.add_paragraph(f"{ip_id}：{ip_row.iloc[0]['知识产权名称']}（{ip_row.iloc[0]['类别']}）")
    
    # 关键技术说明
    doc.add_heading("三、关键技术说明", level=2)
    key_tech = ps_row.get('关键技术及主要技术指标（限400字）', '')
    if key_tech:
        doc.add_paragraph(key_tech)
    
    # 竞争优势
    doc.add_heading("四、与同类产品的竞争优势", level=2)
    competition_adv = ps_row.get('与同类产品（服务）的竞争优势（限400字）', '')
    if competition_adv:
        doc.add_paragraph(competition_adv)
    
    # 知识产权支持作用
    doc.add_heading("五、知识产权支持作用", level=2)
    ip_support = ps_row.get('知识产权获得情况及其对产品（服务）在技术上发挥的支持作用（限400字）', '')
    if ip_support:
        doc.add_paragraph(ip_support)
    
    return doc

def find_file(directory, pattern):
    """查找匹配模式的文件（递归搜索子目录）"""
    matches = glob.glob(os.path.join(directory, pattern), recursive=True)
    return matches[0] if matches else None
```

## 关键时间逻辑
```python
def validate_ps_time(ps_table, application_year):
    """验证高新产品时间约束"""
    errors = []
    
    # 上年度定义
    last_year = application_year - 1
    
    # 规则1：高新产品收入必须是上年度的
    for _, row in ps_table.iterrows():
        income = row.get('上年度销售收入 （万元）', 0)
        if income > 0:
            # 确认收入属于上年度
            pass  # 收入数据默认是上年度的
    
    # 规则2：代表性合同与发票必须是上年度的
    # 需要在整理合同发票时验证
    
    return {
        'last_year': last_year,
        'errors': errors
    }
```

## 数据关联逻辑
```python
def load_ps_data(data_dir):
    """加载高新产品相关数据"""
    data = {}
    
    core_file = find_file(data_dir, '**/*核心表格*.xlsx')
    if core_file:
        data['ip_table'] = pd.read_excel(core_file, sheet_name='IP表')
        data['rd_table'] = pd.read_excel(core_file, sheet_name='RD表')
        data['ps_table'] = pd.read_excel(core_file, sheet_name='PS表')
        data['achievement_table'] = pd.read_excel(core_file, sheet_name='科技成果转化情况表')
    
    return data

def find_ps_associations(ps_row, ip_table, achievement_table):
    """查找高新产品的关联关系"""
    ps_id = ps_row['产品（服务）编号']
    
    # 1. 查找关联的IP
    related_ips = []
    ip_field = str(ps_row.get('知识产权编号', ''))
    ip_ids = [x.strip() for x in ip_field.split(',') if x.strip()]
    for ip_id in ip_ids:
        ip_row = ip_table[ip_table['知识产权编号'] == ip_id]
        if not ip_row.empty:
            related_ips.append({
                'ip_id': ip_id,
                'name': ip_row.iloc[0]['知识产权名称'],
                'category': ip_row.iloc[0]['类别']
            })
    
    # 2. 查找关联的成果转化（通过IP间接关联）
    related_achievements = []
    for _, ach_row in achievement_table.iterrows():
        ach_ips = [x.strip() for x in str(ach_row.get('关联IP', '')).split(',') if x.strip()]
        if any(ip_id in ach_ips for ip_id in ip_ids):
            related_achievements.append(ach_row['科技成果序号'])
    
    return {
        'ps_id': ps_id,
        'related_ips': related_ips,
        'related_achievements': related_achievements
    }

def validate_ps_ip_association(ps_table, ip_table):
    """验证PS表与IP表的关联一致性"""
    errors = []
    ip_ids = set(ip_table['知识产权编号'].tolist())
    
    for _, ps_row in ps_table.iterrows():
        ps_ip_field = str(ps_row.get('知识产权编号', ''))
        ps_ip_ids = [x.strip() for x in ps_ip_field.split(',') if x.strip()]
        
        for ip_id in ps_ip_ids:
            if ip_id not in ip_ids:
                errors.append(f"PS表{ps_row['产品（服务）编号']}引用的{ip_id}在IP表中不存在")
    
    return errors

def validate_ps_income(ps_table, audit_income_total):
    """验证高新产品收入与审计报告一致性"""
    errors = []
    
    total_income = ps_table['上年度销售收入 （万元）'].sum()
    if abs(total_income - audit_income_total) > 0.01:
        errors.append(f"高新产品收入合计{total_income:.2f}万元与审计报告{audit_income_total:.2f}万元不一致")
    
    return errors

def deduplicate_achievement_files(ps_row, achievement_table, data_dir):
    """获取与产品关联的成果转化证明材料（去重后合并）"""
    ps_id = ps_row['产品（服务）编号']
    ip_ids = [x.strip() for x in str(ps_row.get('知识产权编号', '')).split(',') if x.strip()]
    
    # 查找关联的成果转化
    related_achievements = []
    for _, ach_row in achievement_table.iterrows():
        ach_ips = [x.strip() for x in str(ach_row.get('关联IP', '')).split(',') if x.strip()]
        if any(ip_id in ach_ips for ip_id in ip_ids):
            related_achievements.append(ach_row)
    
    # 收集证明材料文件（去重）
    all_files = set()
    for ach_row in related_achievements:
        ach_id = ach_row['科技成果序号']
        ach_files = glob.glob(os.path.join(data_dir, f'**/*{ach_id}*'), recursive=True)
        all_files.update(ach_files)
    
    return list(all_files)
```

## 输入要求
1. **高新技术产品（服务）明细表**（PS表）- 包含PS编号、名称、技术领域、收入、关联知识产权等
2. **产品关键技术和技术指标说明** - 从PS表提取或单独提供
3. **生产批文、认证认可和资质证书** - 在本地资料目录查找
4. **产品质量检验报告** - 在本地资料目录查找
5. **科技成果转化证明材料** - 从成果转化材料获取（去重后合并）
6. **上年度销售合同与发票** - 在本地资料目录查找
7. **高新产品收入审计报告** - 用于验证收入一致性

## 输出规范

### 1. 高新产品证明材料清单
```python
def generate_ps_materials_checklist(enterprise_name, ps_table, ip_table, achievement_table, application_year):
    """生成高新产品证明材料清单"""
    
    wb = Workbook()
    ws = wb.active
    ws.title = '产品清单'
    
    headers = ['序号', '产品编号', '产品名称', '技术领域', '上年度收入（万元）', 
               '关联知识产权', '证明材料内容', '证明材料文件名', '备注']
    ws.append(headers)
    
    for idx, (_, row) in enumerate(ps_table.iterrows(), 1):
        ps_id = row['产品（服务）编号']
        associations = find_ps_associations(row, ip_table, achievement_table)
        
        ip_names = ','.join([f"{ip['ip_id']}({ip['name']})" for ip in associations['related_ips']])
        
        ws.append([
            idx,
            ps_id,
            row['产品（服务）名称'],
            f"{row.get('技术领域（一级）', '')}-{row.get('技术领域（二级）', '')}",
            row.get('上年度销售收入 （万元）', 0),
            ip_names,
            '技术说明+检测报告+认证证书+产品说明',
            f"{ps_id}_{row['产品（服务）名称']}.pdf",
            ''
        ])
    
    # 上年度合同发票清单Sheet
    ws2 = wb.create_sheet('上年度合同发票清单')
    ws2.append(['序号', '产品编号', '产品名称', '合同编号', '甲方', '乙方', '合同金额', 
                '签订时间', '履约期限', '发票代码', '发票号码', '发票金额', '高新收入金额', '备注'])
    
    output_path = f"{enterprise_name}-高新产品证明材料清单.xlsx"
    wb.save(output_path)
    return output_path
```

### 2. 高新产品证明材料文件
```python
def organize_ps_proof_files(enterprise_name, ps_table, ip_table, achievement_table, data_dir, output_dir):
    """整理高新产品证明材料文件"""
    
    output_files = []
    
    for _, row in ps_table.iterrows():
        ps_id = row['产品（服务）编号']
        ps_name = row['产品（服务）名称']
        
        file_list = []
        
        # 1. 生成关键技术说明
        tech_doc = generate_technical_description(row, ip_table, pd.read_excel(find_file(data_dir, '**/*核心表格*.xlsx'), sheet_name='RD表'))
        tech_path = os.path.join(output_dir, f"{ps_id}_技术说明.docx")
        tech_doc.save(tech_path)
        file_list.append(tech_path)
        
        # 2. 查找生产批文、认证证书
        cert_files = find_product_proof_files(data_dir, ps_name, ps_id)
        file_list.extend(cert_files)
        
        # 3. 合并关联的成果转化证明材料（去重）
        achievement_files = deduplicate_achievement_files(row, achievement_table, data_dir)
        file_list.extend(achievement_files)
        
        # 合并为PDF
        if file_list:
            output_path = os.path.join(output_dir, f"{ps_id}_{ps_name}.pdf")
            merge_ps_proof_pdf(file_list, output_path)
            output_files.append(output_path)
    
    return output_files
```

### 3. 上年度代表性销售合同与发票
```python
def organize_last_year_contracts_invoices(enterprise_name, ps_table, data_dir, output_dir, application_year):
    """整理上年度代表性销售合同与发票"""
    
    last_year = application_year - 1
    file_list = []
    
    # 查找上年度合同
    contract_files = find_contract_files(data_dir, last_year)
    file_list.extend(contract_files)
    
    # 查找上年度发票
    invoice_files = find_invoice_files(data_dir, last_year)
    file_list.extend(invoice_files)
    
    # 合并为PDF（仅允许1个PDF文件，≤20M）
    output_path = os.path.join(output_dir, f"{enterprise_name}-上年度与高新技术产品相关的代表性销售合同与发票.pdf")
    merger = PdfMerger()
    for f in file_list:
        if f.lower().endswith('.pdf'):
            merger.append(f)
    merger.write(output_path)
    merger.close()
    
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    if size_mb > 20:
        print(f"警告：合同发票文件{size_mb:.2f}MB超过20MB限制")
    
    return output_path
```

## 整理要求
1. **产品完整性**：必须包含所有申报的高新产品
2. **关联准确性**：关联知识产权必须与PS表及IP表一致
3. **收入一致性**：上年度收入必须与高新产品收入审计报告一致
4. **技术相关性**：证明材料必须与产品关键技术相关
5. **上年度范围**：代表性合同与发票必须是上年度的
6. **知识产权支撑**：必须反映知识产权的核心支撑作用
7. **成果转化去重**：与产品关联的成果转化证明材料需去重后合并

## 文件格式规范
1. **PDF格式**：.pdf格式
2. **文件大小**：产品证明≤4M，合同发票≤20M
3. **文件命名**：{PS编号}_{产品名称}.pdf
4. **文件加密**：不得加密
5. **合同发票**：合同与发票必须对应放置，顺序清晰
6. **合同发票文件数**：仅允许上传1个PDF文件

## 数据一致性检查
```python
def validate_ps_consistency(ps_table, ip_table, achievement_table, audit_income_total, application_year):
    """完整数据一致性检查"""
    all_errors = []
    
    # 1. 产品数量一致性
    # 检查PS表中的产品数量与证明材料数量
    
    # 2. 关联一致性
    all_errors.extend(validate_ps_ip_association(ps_table, ip_table))
    
    # 3. 收入一致性
    all_errors.extend(validate_ps_income(ps_table, audit_income_total))
    
    # 4. 时间一致性
    time_result = validate_ps_time(ps_table, application_year)
    all_errors.extend(time_result['errors'])
    
    # 5. 技术领域一致性
    # 检查PS表中的技术领域是否符合高new技术认定范围
    
    return all_errors
```

## 工作流程
1. **加载数据**：读取核心表格（IP/RD/PS/成果转化表）
2. **产品梳理**：梳理所有高新技术产品，核对产品数量
3. **关联验证**：验证产品与知识产权的关联关系
4. **收入核对**：核对高新产品收入与审计报告一致性
5. **技术说明生成**：为每个产品生成关键技术说明文档
6. **材料收集**：收集每个产品的证明材料（技术说明、检测报告、认证证书等）
7. **成果转化合并**：将与产品关联的科技成果转化证明材料合并去重
8. **合同发票整理**：整理上年度代表性合同与发票，生成清单
9. **文件整理**：按照命名规范合并为PDF文件
10. **清单生成**：生成高新产品证明材料清单
11. **一致性检查**：运行完整数据一致性检查
12. **质量检查**：检查材料完整性、关联准确性和文件格式

## 常见问题处理
1. **证明材料不全**：补充技术说明、检测报告、认证证书等
2. **关联关系错误**：核对高新产品明细表，修正关联知识产权
3. **合同发票不匹配**：重新核对合同和发票，确保一一对应
4. **收入不一致**：核对高新产品收入审计报告，统一数据口径
5. **文件大小超限**：压缩图片或拆分文件
6. **合同发票超20M**：压缩图片分辨率，或仅保留代表性合同发票
7. **产品技术领域不符**：核对产品是否属于国家重点支持的高新技术领域

## 输出隐患自查与汇报（v1.20.0升级，技能结束时强制执行）

> **强制要求**：整理完PS证明材料后，agent 必须按以下7个维度进行隐患自查并汇报。

### 自查清单（7维覆盖）

| 维度 | 检查项 | 表现 |
|------|------|------|
| **1. 原始资料缺失** | 合同/发票是否齐全 | 合同缺失或发票不完整 |
| | 关键技术说明是否完整 | 技术说明书为空或内容过少 |
| | 依赖的上游文件是否存在 | 无法读取RDPS汇总表.xlsx/成果转化汇总表.xlsx |
| **2. 文本质量** | PS关键技术描述是否有实质内容 | 纯套话，无具体技术参数 |
| | 竞争优势描述是否有对比数据 | "行业领先"但无具体竞品对比 |
| | 是否存在AI痕迹 | 重复句式、空泛表述 |
| **3. 逻辑关联** | 每个PS是否关联了足够的RD支撑 | PS零RD关联或关联数不足 |
| | 每个PS的IP关联是否完整 | PS有RD支撑但无IP支撑 |
| | PS表中的销售收入是否与发票统计一致 | 汇总金额 ≠ 发票明细合计 |
| **4. 字数问题** | PS关键技术 350-400字 | 字数超标（需优化非截断） |
| | 竞争优势 350-400字 | 字数不足或超标 |
| | 知识产权 350-400字 | 字数超标 |
| **5. 文档格式** | 合同/发票扫描件是否清晰可读 | 扫描件模糊、印章不清 |
| | 文件命名是否符合`{序号}_{文件名}`格式 | 命名不规范 |
| | PS技术说明书是否包含必要的章节结构 | 缺少关键技术/竞争优势章节 |
| **6. 政策符合性** | PS名称是否从申请书提取（非自创） | PS名称无依据 |
| | 高新产品收入占比≥60% | 高新收入占比不达标 |
| | PS对应的技术领域是否在高新八大领域内 | 技术领域不符合高新认定 |
| **7. 数据可溯源性** | 销售收入数据可否追溯到全量发票统计 | 销售收入数据来源不明 |
| | 关键技术描述可否追溯到技术说明书 | 内容无出处 |

### 汇报格式

```
⚠️ gxtz-ps-materials 输出隐患自查报告

1. 原始资料: ✓ / ⚠ {n}项缺失
2. 文本质量: ✓ / ⚠ {n}处空泛
3. 逻辑关联: ✓ / ⚠ {n}个隐患
4. 字数合规: ✓ / ⚠ {n}字段需优化
5. 文档格式: ✓ / ⚠ {n}处不规范
6. 政策符合性: ✓ / ⚠ {n}项不合规
7. 数据溯源: ✓ / ⚠ {n}字段无来源

待用户确认后进入下一步。
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

---

<!-- SECTION_BEGIN: provenance_verification v2.7 -->
## 溯源核验 → 详见 {{YFW_SKILLS}}/_common/SHARED_provenance.md
> 关键字段值必须与源文件精确一致，禁止改写。
<!-- SECTION_END: provenance_verification -->

---

<!-- SECTION_BEGIN: authoritative_terms_verification v2.6 -->
## 权威术语核验 → 详见 {{YFW_SKILLS}}/_common/SHARED_authoritative_terms.md
> 输出前强制扫描权威术语。
<!-- SECTION_END: authoritative_terms_verification -->
