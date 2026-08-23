---
name: gxtz-achievement-materials
description: "高新技术企业认定科技成果转化证明材料整理，确保成果与IP、RD、PS关联正确。当用户提到科技成果转化、成果转化、转化证明、整理成果转化材料时调用此技能。"
version: "1.38.0"
triggers:
  - 科技成果转化
  - 成果转化
  - 转化证明
  - 整理成果转化材料
---
## 角色定位

> **你是"高新技术企业认定项目老师"**。服务于用户（项目人员），不直接面向客户企业。
> 完整角色定义（三角关系模型/专业领域/能力边界/决策权限/沟通准则）详见 `{{PONOS_SKILLS}}/_common/agent_role.md`。

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

<!-- SECTION_BEGIN: v1_35_0_new_features -->
## v1.35.0 模板内置打包 + 两级查找兜底 + 强制约束

> **背景**：中瑞远博项目中缺失科技成果转化模板，agent 未使用 `template_injector` 而是手动拼凑了 11 列表格，导致列数错误、列序混乱、下拉值全部违规、字数全部超标。

**变更内容**：
1. **模板内置打包**：4 个官方模板放入 `_common/templates/` 随技能包分发，无需每个项目手动放置
2. **两级查找兜底**：`template_injector._resolve_template()` 改为 项目目录 → 内置模板 两级查找，找不到时抛异常而非 agent 手动兜底
3. **强制模板注入约束**：新增 ⛔ 硬约束 —— 成果转化表必须通过 `TemplateInjector.inject_achievement_table()` 生成，禁止手动拼表
4. **修复示例代码 bug**：示例中 `"成果类型": "发明专利"` → `"专利"`（下拉无"发明专利"选项）
5. **修复 RD 模板关键词**：`"研发活动汇总表"` → `"研究开发活动汇总"`（匹配官方模板文件名）

涉及文件：
- `{{PONOS_SKILLS}}/_common/templates/科技成果转化情况汇总表.xlsx`（新增内置模板）
- `{{PONOS_SKILLS}}/_common/template_injector.py`（`_resolve_template` 两级查找 + `_get_builtin_template_dir`）
- SKILL.md（版本号 + 模板查找说明 + 强制约束）
- CHANGELOG.md（本条目）
<!-- SECTION_END: v1_35_0_new_features -->

<!-- SECTION_BEGIN: v1_36_0_new_features -->
## v1.36.0 证明材料附件PDF生成脚本

> **背景**：此前技能仅生成成果转化汇总表（文案表格），不具备生成证明材料附件PDF的能力。
> agent 需要在执行流程中手动分配合同发票到各成果目录，然后调用脚本合并。

**变更内容**：
1. **新增脚本** `{{PONOS_SKILLS}}/_common/generate_achievement_proofs.py`：三模式（preview / organize / auto-scan）
2. **preview 模式**：预览每项成果的材料匹配情况（IP证书 + 合同 + 发票 + 其他），不生成PDF
3. **organize 模式**（推荐）：从按成果归类的材料目录读取合同发票，自动匹配IP证书，合并为PDF
4. **auto-scan 模式**：从合同发票目录自动按年份匹配，合并为PDF
5. **输出规范**：`{序号两位}_{成果名称}.pdf` + `_生成报告.json` 写入 `最终版本/`
6. **超限告警**：PDF > 2MB 时输出 file_compressor.py 压缩命令

**调用方式**：

```bash
# 步骤1: 先预览，确认材料匹配情况
python {{PONOS_SKILLS}}/_common/generate_achievement_proofs.py preview ^
    --achievement-table "03_成果转化证明/成果转化汇总表.xlsx" ^
    --materials-dir "03_成果转化证明/" ^
    --ip-dir "02_知识产权证明/"

# 步骤2: 生成证明材料PDF
python {{PONOS_SKILLS}}/_common/generate_achievement_proofs.py organize ^
    --achievement-table "03_成果转化证明/成果转化汇总表.xlsx" ^
    --materials-dir "03_成果转化证明/" ^
    --ip-dir "02_知识产权证明/" ^
    --output-dir "03_成果转化证明/最终版本/" ^
    --application-year 2026
```

**agent 执行流程变更**：
- 第四步"整理成果转化证明材料"不再使用 inline 伪代码，改为：
  1. agent 先手工分配合同发票到各成果子目录（`成果XX_名称/`）
  2. agent 调用 `generate_achievement_proofs.py preview` 预览确认
  3. agent 调用 `generate_achievement_proofs.py organize` 生成PDF
  4. 超限文件调用 `file_compressor.py auto` 压缩

涉及文件：
- `{{PONOS_SKILLS}}/_common/generate_achievement_proofs.py`（新增）
- `{{PONOS_SKILLS}}/_common/tech_stack.json`（新增条目）
- SKILL.md（版本号 + 第四步引用更新 + 输出规范更新）
- CHANGELOG.md（本条目）
<!-- SECTION_END: v1_36_0_new_features -->

<!-- SECTION_BEGIN: v1_37_0_new_features -->
## v1.37.0 证明材料整理经验规则集成（8条中瑞远博项目经验）

> **背景**：中瑞远博项目中整理26个成果转化证明材料时暴露出多个流程缺陷——重复文件、排序混乱、案例来源标注不当、OneDrive路径兼容、材料分发策略粗放等。本版本将8条实战经验固化为技能规则。

### 新增规则

| 规则 | 类别 | 内容 | 来源 |
|------|------|------|------|
| **R10** | 材料去重 | 合并PDF前强制去重：按文件名前缀分组，同前缀保留最大文件，删除残留副本 | EXP-2026-07-25-010 |
| **R11** | 标准排序 | PDF合并顺序：01_IP证书→02_合同→03_发票→04_体系认证→05_产品认证→06_检测报告→09_应用案例 | EXP-2026-07-25-011 |
| **R12** | 案例规范 | 案例PDF不标注来源URL和采集日期，仅保留项目名称/客户名称/设备方案/应用领域+企业名称 | EXP-2026-07-25-008 |
| **R13** | 路径兼容 | OneDrive路径含全角括号【】，用os.path+原始字符串r''，避免pathlib.resolve() | EXP-2026-07-25-015 |
| **R14** | 三级分发 | 检测报告按关联度分发：强关联(设备控制/自动化)→全部报告，中关联(信息管理)→1份，出厂检测→仅同合同成果 | EXP-2026-07-25-009 |
| **R15** | 公司认证 | ISO三体系+CE等公司级资质默认分发到所有成果，不按产品类型区分 | EXP-2026-07-25-013 |
| **R16** | 截图技术 | 案例截图用Playwright自动化，img2pdf转PDF（优于ReportLab），FitMode.into自动分页 | EXP-2026-07-25-007/014 |

### R10 材料去重（强制执行）

> **根因**：多次运行分发脚本向同一目录重复复制源文件，导致合并PDF页数膨胀（如成果01从48页→198页）。

**去重SOP**（合并前强制执行）：
```
1. 扫描目标目录所有文件
2. 按文件名前缀分组（去除(1)/(2)等副本标记）
3. 同前缀保留最大的文件（源文件），删除较小的（残留副本）
4. 去重后重新计算总页数，与预期值对比
5. 异常时输出告警
```

**禁止**：多次执行同一分发脚本而不先清理目标目录。

### R11 标准合并顺序（强制执行）

> **根因**：不同成果PDF内部材料排列混乱，各类证书/合同/发票/报告顺序不统一。

**PREFIX_ORDER 排序定义**：
```python
PREFIX_ORDER = [
    '01_IP证书', '02_合同', '03_发票',
    '04_体系认证',        # ISO9001/ISO14001/ISO45001
    '05_产品认证',        # CE/LVD/EMC等
    '06_检测报告',        # GGD/MNS+出厂检测
    '09_应用案例',        # 官网截图/案例
]
```

所有成果证明材料PDF内部文件按此顺序排列。调用 `generate_achievement_proofs.py` 时自动应用 sort_key 排序。

### R12 案例PDF规范（强制执行）

> **根因**：案例页面标注"来源：公司官网 | 采集日期：2026-07-25"，用户要求申报材料中不要标来源。

**案例页面内容**（仅保留）：
- 项目名称
- 客户名称
- 设备/方案
- 应用领域
- 底部：企业名称 + 产品分类

**禁止标注**：
- ❌ 来源URL
- ❌ 采集日期
- ❌ 数据来源说明
- ❌ 任何"仅供参考"等免责声明

### R13 OneDrive路径兼容（强制执行）

> **根因**：项目路径含全角括号【】且为OneDrive同步目录，python-docx和pathlib.Path.resolve()可能触发OSError。

**路径使用规范**：
```python
# ✅ 正确：os.path.join + 原始字符串
import os
base = r'D:\OneDrive\文档\工作\【国高】xxx'
path = os.path.join(base, '03_成果转化证明', '最终版本')

# ❌ 错误：pathlib.resolve()可能失败
from pathlib import Path
path = Path(base).resolve()  # 可能OSError
```

**遵守原则**：
1. 所有Python脚本使用原始字符串(r'...')指定绝对路径
2. 文件读写使用os.path.join拼接路径，避免pathlib.resolve()
3. 项目初始化时将路径记录到project_config.json
4. 脚本入口统一检查路径可用性

### R14 OneDrive CldFlt数据安全（强制执行）

> **根因**：CldFlt.sys内核驱动在OneDrive.exe未运行时仍拦截文件写入，导致"写入成功但文件随后被清空"的现象（见EXP-2026-07-25-001）。实测D:\OneDrive文件脱水率96.5%，Storage Sense脱水阈值0天，任何自动化工具在OneDrive同步根下写入文件都可能随机丢失。

**安全工作区策略**（自动启用）：

1. `generate_achievement_proofs.py v1.2.0+` 自动检测输出目录是否在OneDrive同步根下
2. 检测到OneDrive → 自动将写入重定向到 `d:\Projects\gxtz_safe\`
3. 完成后自动将产物同步回原始输出目录 + `attrib +p` 钉选防脱水
4. 安全区保留7天备份，agent下次启动时自动清理过期备份
5. 可通过 `--no-safe-workspace` 禁用（不推荐，仅排查问题时使用）

**环境预检**（agent在操作OneDrive路径前强制执行）：
```bash
python {{PONOS_SKILLS}}/_common/onedrive_utils.py
```

输出中 `CldFlt 驱动运行中: True` + `在 OneDrive 同步根下: True` → 必须使用安全工作区。

**手动安全工作区**（agent未使用脚本时的操作规范）：
```
1. 不在 D:\OneDrive\ 下执行任何写入操作
2. 将所有源材料复制到 d:\Projects\gxtz_safe\[企业名]\source\
3. 在 d:\Projects\gxtz_safe\[企业名]\output\ 生成产物
4. 完成后将产物复制回 OneDrive 目标目录
5. 对复制回的产物执行: attrib +p [文件路径]
6. 验证每个产物: size > 0 且内容可读
```


### R15 检测报告三级关联分发策略

> **根因**：检测报告最初仅分发给硬件类成果，但软件成果涉及设备控制/数据采集同样与检测报告有关联。

**三级分发策略**：
| 级别 | 关联度 | 覆盖成果 | 分发数量 |
|------|--------|---------|---------|
| **强关联** | 设备控制/自动化/MES/IoT/数字孪生 | 涉及PLC群控、设备监控、产线自动化的成果 | 全部3份GGD/MNS检测报告 |
| **中关联** | 信息管理类 | 数据查询、资源管理等纯软件成果 | 仅GGD1600A 1份 |
| **出厂检测** | 同合同项目 | 与出厂检测报告关联同一合同项目的成果 | 仅对应1份出厂检测报告 |

**执行前必须**：读取各成果docx简介中的关键技术描述，分析是否涉及设备控制、数据采集、产线自动化等硬件交互内容，据此决定分发范围。

### R16 公司级认证默认全部成果

> **根因**：CE证书和ISO三体系证书最初仅分发部分成果，用户要求所有成果补齐。

**默认分发清单**（每项成果均含）：
- ISO9001质量管理体系认证
- ISO14001环境管理体系认证
- ISO45001职业健康安全管理体系认证
- CE认证（含LVD+EMC，如企业持有）

**区分原则**：
- 公司级资质 → 所有成果默认包含
- 产品特定认证（特定型号检测报告） → 按关联性分发

### R17 Playwright案例截图自动化 + img2pdf

> **根因**：官网案例页面有CDN防盗链，直接下载图片失败。ReportLab生成PDF遇到长截图布局问题。

**推荐技术栈**：
```
Playwright → 浏览器自动化截图（绕过防盗链）
Pillow → 裁剪浏览器UI元素
img2pdf → 转换A4 PDF（FitMode.into自动分页，优于ReportLab）
```

**Playwright截图流程**：
```
browser_navigate(URL) → browser_wait_for(内容加载) → browser_evaluate(内容区坐标) → browser_take_screenshot(全页) → Pillow.crop(内容区) → img2pdf.convert(A4)
```

**文件命名**：`caseshow-{id}_content.png`（content后缀表示已裁剪）

<!-- SECTION_END: v1_37_0_new_features -->
## v1.34.0 核心架构变更：K/L列内容提示词驱动生成

> **背景**：此前成果转化表的 K列（涉及关键技术）和 L列（成效）内容采用"从 IP 先进性说明/技术说明提取"的方式，本质是算法提取+拼接，缺乏针对每项成果转化的针对性描述。
> **v1.34.0 彻底改造**：K/L列内容统一由 agent 按提示词逐项成果转化生成，禁止算法提取或模板句填充。

### 生成提示词（每项成果转化独立运行）

> **出处**：`C:\Users\T203-15\Desktop\2023guogao\核心表格提示词（除IP表格外）.txt` 中的"科技成果转化"部分

**提示词原文**（每项成果转化独立运行）：
```
仅根据当前提供的立项资料，总结提取以下两项内容：
1、项目研发涉及的关键技术（分点总结，限370-410字）
2、项目研发成效及创新性（成效、创新性分开总结，两部分均分点写，限370-410字）

注意：1、仅根据立项书资料，不要引用网络资料。2、采用概括性文字，不要体现具体的数字数据百分比等。3、语气要正式，字数要严格符合限制要求，如字数不够，通过适当的套话、修饰补充足量。4、文本不要出现"首次"、"创新性地"等夸大字眼，要符合实际。
```

### 五步流水线（每项成果转化独立执行）

```
对于每项成果转化:
  Phase 1: 构建上下文包
    └→ 成果名称 + 关联RD名称及技术方向 + 关联IP名称及摘要 + 关联PS名称

  Phase 2: agent 运行提示词生成 K列（涉及关键技术）
    └→ 分点总结，370-410字，纯技术描述
    └→ 不含"创新"关键词、不含《ZL》引用、不含编号

  Phase 3: agent 运行提示词生成 L列（成效+创新性）
    └→ 成效和创新性分开总结，两部分均分点写
    └→ 370-410字，不含夸大词、不含编号

  Phase 4: 质量门禁
    └→ K列：字数检查 / 无"创新"关键词 / 无ZL引用 / 无编号泄露
    └→ L列：字数检查 / 夸大词检查 / 两段式检查 / 无编号泄露
    └→ 不合格自动重跑（最多2次）

  Phase 5: 脚本注入
    └→ TemplateInjector.inject_achievement_table() 将生成内容注入模板
```

### 质量门禁（每项成果转化生成后强制执行）

| # | 检查项 | 规则 | 不通过处理 |
|---|--------|------|-----------|
| 1 | K列字数 | 370-410字 | 重新生成，提示字数范围 |
| 2 | L列字数 | 370-410字 | 重新生成，提示字数范围 |
| 3 | K列"创新"关键词检查 | 不含"创新/创新性/创新点" | 重新生成，提示移除创新相关描述 |
| 4 | K列ZL引用检查 | 不含《ZL...》引用 | 重新生成，提示改为通用描述 |
| 5 | L列两段式检查 | 必须分成效段+创新性段 | 重新生成，提示两段式结构 |
| 6 | 编号泄露检查 | 不含RD01/IP01/PS01等 | 重新生成，提示用名称代替 |
| 7 | 夸大词检查 | 不含"领先/首创/第一/唯一" | 重新生成，提示移除夸大词汇 |
| 8 | K/L内容重叠检查 | K列零"创新"关键词，L列含创新性段 | 手动调整或重跑 |

### 禁止事项（v1.34.0新增）

- **禁止从 IP 先进性说明直接提取**：K列内容必须针对每项成果转化独立生成，不得复制粘贴 IP 表的先进性说明
- **禁止模板句**：不得使用"该成果转化取得了显著的经济效益"等通用模板句
- **禁止 K/L 内容重叠**：K列纯技术，L列成效+创新性，两列内容不重复

<!-- SECTION_END: v1_34_0_new_features -->

## 合规红线（agent 执行前必读，违反即停止）

## 步骤X：生成成果转化表（v1.17.0新增 → v1.33.0升级为模板注入）

> **一张技能两张产出**：gxtz-achievement-materials 在整理完成果转化证明材料后，同步生成成果转化汇总表。不再需要跨技能调用 gxtz-core-tables 填写成果转化表。
>
> **v1.33.0 升级**：改为使用 `TemplateInjector.inject_achievement_table()` 注入官方模板，替代 `generate_achievement_table()` 从零生成。详见上方 [v1.33.0 新增章节](#v1330-新增成果转化汇总表模板注入从-gxtz-core-tables-剥离)。

### 映射规则（证明材料 + RD表 → 成果转化表 12列）

| 成果转化表列 | 映射来源 |
|------|------|
| 科技成果序号 | 1,2,3...按成果排序 |
| 科技成果名称 | 证明材料中的成果名称（专利名称/软著名称/技术报告名称） |
| 成果类型 | 从证明材料提取（发明专利/实用新型/软著等） |
| 成果来源 | 从证明材料提取（自主研发/合作开发/委托开发等） |
| 转化结果 | 新产品/新工艺/新技术/新服务 |
| 转化时间 | RD完成日期（从RD表提取） |
| 关联IP | 从RDPS关联表的IP编号 |
| 关联RD | 从RDPS关联表的RD编号 |
| 关联PS | 从RDPS关联表的PS编号 |
| 转化形式 | 自行投资实施转化 |
| 涉及关键技术 | 从IP先进性说明/技术说明提取（限400字，纯技术描述） |
| 成效 | 从经济效益数据/应用证明提取（限400字，成效+创新性两段式） |

### 调用方式（v1.33.0 模板注入）

> 模板查找：项目 `00_核心表格/` 优先 → 兜底 `{{PONOS_SKILLS}}/_common/templates/科技成果转化情况汇总表.xlsx`（内置，随技能包分发，无需项目手动放置）。详见 `template_injector._resolve_template()`。

```python
from _common.template_injector import TemplateInjector

injector = TemplateInjector(
    template_dir="00_核心表格",
    output_dir="_output",
    enterprise_name=enterprise
)

ach_data = [
    {
        "序号": "1",
        "名称": "成果名称",
        "成果类型": "专利",
        "成果来源": "自主研发",
        "转化结果": "新产品",
        "转化时间": "2023/05/31",
        "关联IP": "IP02",
        "关联RD": "RD01",
        "关联PS": "PS03",
        "转化形式": "自行投资实施转化",
        "涉及关键技术": "核心技术：xxx...",
        "成效": "成效：xxx...",
    },
]

result_path = injector.inject_achievement_table(ach_data)
```

> ⛔ **强制约束**：成果转化表必须通过 `TemplateInjector.inject_achievement_table()` 生成，禁止 agent 自行从零拼表（手动 openpyxl 创建、手动 set 表头/数据均禁止）。模板缺失时内置模板自动兜底，不存在模板缺失的合理理由。

### 输入依赖

本技能接收上游产出物：
- `{项目}/00_核心表格/IP表.xlsx` — 知识产权清单
- `{项目}/00_核心表格/RD表.xlsx` — RD表（gxtz-rd-report 产出）

产出：
- `{项目}/01_成果转化材料/{企业名称}-科技成果转化情况汇总表.xlsx` — 本步骤新增

> 成果转化表从 gxtz-core-tables 移出，归入本技能闭环。v1.33.0 改为模板注入方式生成。

> **第一要求：严谨合规。所有数据必须真实可溯源，禁止任何形式的编造。**

### 禁止事项（违反任何一条立即停止并告警）

1. **禁止编造内容**：所有字段数据必须来自真实文件（立项书、证书、合同、发票、社保记录等），不得凭空编造
2. **禁止推断关键数据**：技术领域、研发费用、人员占比、专利状态等关键字段，必须以官方文档（所得税申报表/申请书/证书）为准，不得从项目名称推断
3. **禁止跳过脚本执行**：所有 `python {{PONOS_SKILLS}}/_common/xxx.py` 命令必须通过 Bash 真正执行，不得"阅读脚本逻辑自行编写等效代码"
4. **禁止跳过审核步骤**：审核验证步骤必须执行且通过，未通过时不得继续后续步骤
5. **禁止自行兜底**：脚本报错时不得自行编写兜底代码，必须停止并告警由用户决定
6. **禁止合并/简化字段名**：所有表格字段名必须与模板完全一致，不得简化（如"编号"不得代替"知识产权编号"）
7. **禁止跨技能污染**：仅读取当前项目留痕，不跨项目读取；技能内步骤使用当前技能定义的脚本，蜂群编排层可调用_common公共脚本做协调
8. **禁止跳过扫描件 OCR（v2026-07-22 新增，强制）**：检测发现扫描页时，必须执行 OCR，不得用 `--mode text` 跳过。完整规范见 `{{PONOS_SKILLS}}/_common/SHARED_ocr_reference.md` 中的"强制执行规则"章节

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

> 通用规范详见 {{PONOS_SKILLS}}/_common/SHARED_autonomous_confirmation.md
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

> 通用规范详见 {{PONOS_SKILLS}}/_common/SHARED_questioning_review.md
> agent 必须遵守：四类触发(E/F/G/H) + 6条自问 + 质疑交互规范(AskUserQuestion) + 6条禁止行为 + 人机协同流程 + 质疑记录要求。
## 蜂群协同

> 通用规范详见 {{PONOS_SKILLS}}/_common/SHARED_swarm_collaboration.md
> 跨技能并行执行 + subagent规范 + file_lock并发控制。
## 交叉验证协议 → 详见 {{PONOS_SKILLS}}/_common/SHARED_cross_validation.md
> 关键决策点强制交叉验证。
<!-- SECTION_END: cross_validation_protocol -->

<!-- SECTION_BEGIN: date_compliance_rules -->
## 日期合规规则（强制执行，违反即停止）

> **经验来源**：EXP-2026-07-17-001（成果转化证明材料日期严重越界问题）
> **核心原则**：所有合同、发票、测试报告的日期必须限定在近三年内，且与成果转化年份一致。
> 违反任一规则，专审会被直接驳回。**禁止跳过本节校验**。

### 近三年计算

```
申报年份 Y → 近三年 = {Y-3, Y-2, Y-1}
例如 Y=2026 → 近三年 = {2023, 2024, 2025}
```

### 5条强制规则

| 规则 | 内容 | 违反后果 |
|------|------|---------|
| **规则1** | 年份硬过滤：所有合同/发票/测试报告的日期必须在近三年内 | ⛔ 直接驳回 |
| **规则2** | 同一转化年份配对：成果转化年份=合同年份=发票年份 | ⛔ 证据链无效 |
| **规则3** | 测试报告不跨年：检测日期年份=成果转化年份 | ⛔ 标记为无效证明 |
| **规则4** | 专利证书优先：只放证书，不放说明书/权利要求书/审查意见 | ⛔ 证明效力不足 |
| **规则5** | 文件名年份校验：HXS编码+dzfp时间戳，辅以PDF内容交叉验证 | ⚠ 仅凭文件名判断会误判 |

### 操作流程SOP（agent 必须按序执行）

```
1. 确定申报年份 Y，计算近三年 = {Y-3, Y-2, Y-1}
2. 从成果转化表读取每项成果的转化年份
3. 扫描源目录所有合同/发票文件，提取年份信息：
   a. 优先从文件名提取（HXS编码、dzfp时间戳）
   b. 次选从PDF内容提取签订日期/开票日期
   c. 标记年份不明确的文件为"待确认"
4. 硬过滤：排除所有年份不在近三年内的文件
5. 按年份分组可用的合同和发票
6. 为每项成果分配同年的1合同+1发票
7. 对测试报告执行相同的年份过滤和匹配
8. 最终检查：每个成果的合同年份=发票年份=成果转化年份=测试报告年份
```

### 执行方式（Bash 调用，禁止跳过）

**年份合规校验脚本**：

```bash
python {{PONOS_SKILLS}}/_common/year_compliance_checker.py ^
    --apply-year {申报年份} ^
    --check-dir "{成果转化目录}" ^
    --achievement-table "{成果转化表.xlsx}"
```

退出码含义：
- 0 = 全部合规，可继续提交
- 1 = 存在 critical 违规，必须修正后重新校验
- 2 = 执行错误，检查目录路径

**单文件年份提取（调试用）**：

```bash
python {{PONOS_SKILLS}}/_common/year_compliance_checker.py ^
    --extract-year --file "某合同.pdf"
```

### 文件名年份提取规则

| 格式 | 示例 | 提取年份 |
|------|------|---------|
| HXS编码 | HXS2025082001 | 2025（8月） |
| dzfp时间戳 | 20251219182622 | 2025（12月19日） |
| 通用日期 | 2024-06-15 / 2024/06/15 / 2024年6月15日 | 2024 |
| 纯年份 | 报告2023 | 2023 |

> ⚠️ **文件名年份仅作参考**，必须打开PDF核验实际签订日期/开票日期（规则5要求交叉验证）。

### 常见陷坑（agent 必读）

| 陷坑 | 表现 | 规避方式 |
|------|------|---------|
| 合同编号与年份无关 | "SC155014"看似正常编号，实际签订日期可能是2015年 | 必须从PDF内容提取签订日期 |
| 发票文件名含导出时间戳 | dzfp文件的14位时间戳是开票平台的导出时间，不是开票日期 | 打开PDF核验实际开票日期 |
| 同一客户多年合同混放 | "安徽捷迅"的合同有2023年也有2024年的 | 按年份分目录存放源文件 |
| 发票图片命名歧义 | "202303"可能被误解为"2020年03月" | 约定发票文件名格式为"客户名_发票_YYYYMMDD" |
| 测试报告日期隐藏在正文中 | 文件名无日期，日期在报告正文某处 | 必须打开阅读至少前几页提取检测日期 |
| 专利说明书当证书用 | 文件名含"说明书"/"权利要求书" | 排除，只保留证书文件 |

### 禁止事项（违反即停止）

- ❌ 禁止将2022年及更早的合同/发票/测试报告放入任何成果
- ❌ 禁止合同和发票跨年配对
- ❌ 禁止合同发票与成果转化年份不一致
- ❌ 禁止用专利说明书代替专利证书
- ❌ 禁止仅凭文件名年份判断（必须交叉验证PDF内容日期）
- ❌ 禁止将同一合同或发票重复分配给多个成果
<!-- SECTION_END: date_compliance_rules -->

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

```bash
python {{PONOS_SKILLS}}/_common/xxx.py <参数>
```

- 脚本路径必须使用绝对路径
- 参数必须按脚本定义的 CLI 接口传递
- 不得通过"调用 xxx() 函数"的形式执行（函数描述不是可执行命令）

## 审核验证标准（agent 必须执行且通过）

### 审核脚本调用

最后一步必须执行对应的审核验证脚本：

```bash
python {{PONOS_SKILLS}}/_common/validate_achievement.py --dir "输出目录" --project-root "项目根目录"
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

# 科技成果转化证明材料整理

## 描述
本技能用于整理高新技术企业认定所需的科技成果转化证明材料。成果转化是高企认定的核心指标之一，要求近三年每年均有转化成果，且每个RD项目至少对应1项转化成果。需确保成果与IP、RD、PS的关联关系正确，合同发票唯一匹配。

## 使用场景
- 用户提到"科技成果转化"、"成果转化"、"转化证明"
- 用户需要整理或修改科技成果转化证明材料

## 统一输出目录规范

本技能生成的文件必须统一存放到项目输出根目录下，便于用户查看操作。

### 输出根目录
`{企业名称}_高新认定材料_{申报年份}/`

统一目录结构：00_核心表格 / 01_研发立项报告 / 02_知识产权证明 / 03_成果转化证明 / 04_高新产品证明 / 05_科技人员材料 / 06_管理制度材料 / 07_资料收集清单 / _校验报告

### 本技能输出子目录
`03_成果转化证明/`（校验/审核报告输出到 `_校验报告/`）

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
```bash
python {{PONOS_SKILLS}}/_common/wecom_query.py diagnose
```
详见模块十二：企业微信会话实时查询与附件收集。

### 第零步完：确认进度依赖（v1.x.1新增，进度管理集成）

在开始工作前，检查本技能的前置阶段是否已完成：

```bash
python {{PONOS_SKILLS}}/_common/progress_sync.py check-deps ^
    --project-root "." ^
    --skill "gxtz-achievement-materials"
```

若返回 WARNING 提示存在未完成的前置阶段，agent 应提示用户先完成前置依赖。

> 进度管理集成说明详见: `{{PONOS_SKILLS}}/gxtz-progress-manager/SKILL.md`


### 第一步：项目初始化（强制执行，不可跳过）

**执行以下命令初始化项目知识库**（在项目根目录运行）：

```bash
python {{PONOS_SKILLS}}/_common/project_context_manager.py init --enterprise "{企业名称}" --year {申报年份}
```

此命令将创建 .claude/file_map.json、.claude/experience_base.json、.claude/project_index.json 并扫描项目文件分类到19类。

1. 在 .claude 目录创建 file_map.json（含enterprise/application_year/files字段）
2. 创建 experience_base.json（含enterprise/skill_executions字段）
3. 创建 project_index.json（含enterprise/application_year/skills_progress字段）
4. 扫描项目目录所有文件，按19类目录结构分类填充 file_map.json
5. 3个json文件必须生成，否则后续步骤无法正常工作

**初始化后读取**：读取 file_map.json 了解已有文件分布，读取 experience_base.json 获取历史经验。

**补充资料检查与整理**：
6. 调用 `generate_supplement_checklist(enterprise_name, application_year, 'gxtz-achievement-materials')` 生成/更新补充资料清单文档
7. 调用 `scan_supplement_dir(enterprise_name, application_year, 'gxtz-achievement-materials')` 扫描补充资料目录：
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

### 第一步：读取成果转化表数据
1. 从核心表格中读取科技成果转化情况表
2. 提取成果基本信息：序号、名称、类型、来源、转化结果、转化时间
3. 提取关联信息：关联IP、关联RD、关联PS

### 第二步：验证成果转化关联关系
1. 验证每个RD项目至少对应1项成果转化
2. 验证近三年每年均有成果转化（每年至少1项）
3. 验证成果与IP、RD、PS的关联关系正确
4. 生成《成果转化关联关系校验报告》

### 第三步：查找成果转化证明材料
1. 在本地资料目录中搜索每个成果的证明材料
2. 证明材料包括：专利证书、合同、发票、质量管理体系证书、检测报告（第三方/内部）、产品说明
3. 搜索策略：按成果序号、成果名称、转化时间搜索
4. 记录找到的证明材料文件路径

### 第四步：整理成果转化证明材料
1. agent 为每个成果转化创建证明材料子目录（`成果XX_名称/`），放入合同、发票等材料
2. agent 调用 `generate_achievement_proofs.py preview` 预览每项成果的材料匹配情况
3. agent 调用 `generate_achievement_proofs.py organize` 合并证明材料为单个PDF
   ```bash
   python {{PONOS_SKILLS}}/_common/generate_achievement_proofs.py organize ^
       --achievement-table "03_成果转化证明/成果转化汇总表.xlsx" ^
       --materials-dir "03_成果转化证明/" ^
       --ip-dir "02_知识产权证明/" ^
       --output-dir "03_成果转化证明/最终版本/" ^
       --application-year {申报年份}
   ```
4. 超限文件（>2MB）调用 `{{PONOS_SKILLS}}/_common/file_compressor.py auto` 压缩
5. 命名格式：`{序号}_{成果名称}.pdf`（序号为两位数字）

### 第五步：生成科技成果转化证明材料清单
1. 创建Excel文件
2. 填写成果转化清单：序号、科技成果名称、成果类型、转化时间、关联IP、关联RD、关联PS、证明材料内容、证明材料文件名
3. 添加统计Sheet：按年度统计转化数量、按类型统计
4. 保存文件，命名格式：{企业名称}-科技成果转化证明材料清单.xlsx

### 第六步：数据一致性校验
1. 验证成果转化数量与清单一致
2. 验证每个RD至少对应1项成果转化
3. 验证近三年每年均有成果转化
4. 验证成果与IP、RD、PS的关联关系正确
5. 生成《成果转化数据校验报告》

### 第七步：审核验证（必须通过才能提交）
1. **完整性审核**
   - 检查所有RD项目是否都有对应的成果转化
   - 检查近三年每年是否都有转化成果
   - 检查所有成果是否都有对应的证明材料
   - 检查合同发票是否一一对应

2. **一致性审核**
   - 验证成果与IP、RD、PS的关联关系与核心表格一致
   - 验证转化时间、合同发票时间在近三年内
   - 验证发票唯一性（每张发票仅归属一个成果）

3. **规范性审核**
   - 检查文件命名是否符合规范（调用 `detect_naming_issues()` 检测hash命名/微信图片/扫描仪/手机/WPS拼图/多次优化/大小写不一致/学历不统一等问题，调用 `batch_validate_naming()` 批量校验IP/RD/PS/成果转化/财务/网报/学历/社保命名规范）
   - 检查文件大小是否符合要求：单个成果≤2M
   - 检查PDF文件格式是否正确

**成果转化链条校验（v1.12.0）**：
- 调用match_rd_ip_ps_with_audit()，检查每个RD是否都有关联IP（stats.rd_without_ip应尽量为空）构成成果转化
- 检查stats.idle_ip_count=0（所有知识产权成果都参与转化）
- 审阅audit_report，确认RD→IP→PS链条完整，满足每RD至少1项成果转化要求

4. **生成审核报告**
   - 生成《科技成果转化材料审核报告》
   - 列出所有审核问题及整改建议
   - 审核结论：通过/不通过

5. **审核通过条件**
   - 所有RD项目都有对应成果转化
   - 近三年每年都有转化成果
   - 所有关联关系正确
   - 所有文件格式规范
   - 无严重错误

6. **审核不通过处理**
   - 列出所有问题清单
   - 提供整改建议
   - 要求整改后重新提交审核

### 最终步前：同步进度（v1.x.1新增，进度管理集成）

完成所有工作后、文件整理前，更新进度看板：

```bash
python {{PONOS_SKILLS}}/_common/progress_sync.py update-stage ^
    --project-root "." ^
    --skill "gxtz-achievement-materials" ^
    --status completed
```

此命令将自动匹配本技能对应的阶段并标记为"已完成"。
（注意：finalize 步骤也会自动同步进度，此步为双重保障。）


### 最终步：文件整理与知识库更新（强制执行，审核验证通过后必须执行）

**执行以下命令整理文件并更新知识库**（在项目根目录运行）：

```bash
python {{PONOS_SKILLS}}/_common/project_context_manager.py finalize --enterprise "{企业名称}" --year {申报年份} --skill "gxtz-achievement-materials" --no-move
```

此命令将：按19类目录结构整理文件 → 生成 .claude/_file_management_report.md 整理报告 → 更新 file_map.json / experience_base.json / project_index.json → 校验3个json文件已生成。
- **finalize 后强制验证（v2.0 新增，不可跳过）**：
  1. 立即读取 `.claude/_finalize_diff.json`，检查 `moved_from_protected`（应为空）和 `warnings`（应为空）
  2. `ls` 扫描 03_成果转化证明（至少成果转化数量），确认文件数不少于预期
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

# PDF处理
try:
    from PyPDF2 import PdfMerger, PdfReader, PdfWriter
except ImportError:
    pass

def find_contract_invoice_files(data_dir, year=None):
    """查找合同和发票文件（递归搜索子目录）"""
    patterns = []
    if year:
        patterns = [
            os.path.join(data_dir, f'**/*合同*{year}*'),
            os.path.join(data_dir, f'**/*{year}*合同*'),
        ]
    else:
        patterns = [
            os.path.join(data_dir, '**/*合同*'),
        ]
    
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
        patterns = [
            os.path.join(data_dir, '**/*发票*'),
        ]
    
    found_files = []
    for pattern in patterns:
        matches = glob.glob(pattern, recursive=True)
        found_files.extend(matches)
    
    return list(set(found_files))

def find_product_proof_files(data_dir, product_name=None):
    """查找产品证明材料（递归搜索子目录）"""
    patterns = [
        os.path.join(data_dir, '**/*查新报告*'),
        os.path.join(data_dir, '**/*检测报告*'),
        os.path.join(data_dir, '**/*质量检验*'),
        os.path.join(data_dir, '**/*质量管理*'),
        os.path.join(data_dir, '**/*产品说明*'),
        os.path.join(data_dir, '**/*认证证书*'),
    ]
    if product_name:
        patterns.append(os.path.join(data_dir, f'**/*{product_name}*'))
    
    found_files = []
    for pattern in patterns:
        matches = glob.glob(pattern, recursive=True)
        found_files.extend(matches)
    
    return list(set(found_files))

def merge_achievement_pdf(file_list, output_path, max_size_mb=2):
    """合并成果转化证明材料为PDF"""
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
```

## 关键时间逻辑
```python
def validate_achievement_time(achievement_table, application_year):
    """验证成果转化时间约束"""
    errors = []
    
    # 近三年定义
    recent_years = [application_year - 3, application_year - 2, application_year - 1]
    
    # 规则1：每个近三年年份至少有一项转化成果
    year_counts = {y: 0 for y in recent_years}
    for _, row in achievement_table.iterrows():
        convert_year = pd.to_datetime(row['转化时间']).year
        if convert_year in year_counts:
            year_counts[convert_year] += 1
    
    for year, count in year_counts.items():
        if count == 0:
            errors.append(f"{year}年无科技成果转化记录，近三年每年至少需1项")
    
    # 规则2：转化时间必须在近三年内
    for _, row in achievement_table.iterrows():
        convert_year = pd.to_datetime(row['转化时间']).year
        if convert_year not in recent_years:
            errors.append(f"成果{row['科技成果序号']}转化时间{row['转化时间']}不在近三年{recent_years}内")
    
    # 规则3：代表性合同与发票必须是上年度（application_year - 1）
    last_year = application_year - 1
    
    return {
        'recent_years': recent_years,
        'last_year': last_year,
        'year_counts': year_counts,
        'errors': errors
    }

def validate_rd_achievement_coverage(rd_table, achievement_table):
    """验证每个RD项目至少对应1项成果转化"""
    errors = []
    
    for _, rd_row in rd_table.iterrows():
        rd_id = rd_row['研发活动编号']
        # 查找关联的成果转化
        related_count = 0
        for _, ach_row in achievement_table.iterrows():
            if rd_id in str(ach_row.get('关联RD', '')):
                related_count += 1
        
        if related_count == 0:
            errors.append(f"RD项目{rd_id}({rd_row['研发活动名称']})无对应的科技成果转化")
    
    return errors
```

## 数据关联逻辑
```python
def load_achievement_data(data_dir):
    """加载成果转化相关数据"""
    data = {}
    
    core_file = find_file(data_dir, '**/*核心表格*.xlsx')
    if core_file:
        data['ip_table'] = pd.read_excel(core_file, sheet_name='IP表')
        data['rd_table'] = pd.read_excel(core_file, sheet_name='RD表')
        data['ps_table'] = pd.read_excel(core_file, sheet_name='PS表')
        data['achievement_table'] = pd.read_excel(core_file, sheet_name='科技成果转化情况表')
    
    return data

def find_achievement_associations(achievement_row, ip_table, rd_table, ps_table):
    """查找成果转化的完整关联关系"""
    ach_id = achievement_row['科技成果序号']
    
    # 1. 查找关联的IP
    related_ips = []
    ip_field = str(achievement_row.get('关联IP', ''))
    ip_ids = [x.strip() for x in ip_field.split(',') if x.strip()]
    for ip_id in ip_ids:
        ip_row = ip_table[ip_table['知识产权编号'] == ip_id]
        if not ip_row.empty:
            related_ips.append({
                'ip_id': ip_id,
                'name': ip_row.iloc[0]['知识产权名称'],
                'category': ip_row.iloc[0]['类别']
            })
    
    # 2. 查找关联的RD
    related_rds = []
    rd_field = str(achievement_row.get('关联RD', ''))
    rd_ids = [x.strip() for x in rd_field.split(',') if x.strip()]
    for rd_id in rd_ids:
        rd_row = rd_table[rd_table['研发活动编号'] == rd_id]
        if not rd_row.empty:
            related_rds.append({
                'rd_id': rd_id,
                'name': rd_row.iloc[0]['研发活动名称']
            })
    
    # 3. 查找关联的PS
    related_ps = []
    ps_field = str(achievement_row.get('关联PS', ''))
    ps_ids = [x.strip() for x in ps_field.split(',') if x.strip()]
    for ps_id in ps_ids:
        ps_row = ps_table[ps_table['产品（服务）编号'] == ps_id]
        if not ps_row.empty:
            related_ps.append({
                'ps_id': ps_id,
                'name': ps_row.iloc[0]['产品（服务）名称']
            })
    
    return {
        'achievement_id': ach_id,
        'related_ips': related_ips,
        'related_rds': related_rds,
        'related_ps': related_ps
    }

def validate_achievement_consistency(achievement_table, ip_table, rd_table, ps_table):
    """验证成果转化数据一致性"""
    errors = []
    
    ip_ids = set(ip_table['知识产权编号'].tolist())
    rd_ids = set(rd_table['研发活动编号'].tolist())
    ps_ids = set(ps_table['产品（服务）编号'].tolist())
    
    for _, ach_row in achievement_table.iterrows():
        ach_id = ach_row['科技成果序号']
        
        # 检查IP引用
        for ip_id in [x.strip() for x in str(ach_row.get('关联IP', '')).split(',') if x.strip()]:
            if ip_id not in ip_ids:
                errors.append(f"成果{ach_id}引用的{ip_id}在IP表中不存在")
        
        # 检查RD引用
        for rd_id in [x.strip() for x in str(ach_row.get('关联RD', '')).split(',') if x.strip()]:
            if rd_id not in rd_ids:
                errors.append(f"成果{ach_id}引用的{rd_id}在RD表中不存在")
        
        # 检查PS引用
        for ps_id in [x.strip() for x in str(ach_row.get('关联PS', '')).split(',') if x.strip()]:
            if ps_id not in ps_ids:
                errors.append(f"成果{ach_id}引用的{ps_id}在PS表中不存在")
    
    return errors

def find_file(directory, pattern):
    """查找匹配模式的文件（递归搜索子目录）"""
    matches = glob.glob(os.path.join(directory, pattern), recursive=True)
    return matches[0] if matches else None
```

## 输入要求
1. **科技成果转化情况汇总表**（包含序号、成果名称、成果类型、转化时间、关联IP/RD/PS）
2. **专利证书**（与成果关联的知识产权证书）- 从IP证明材料获取
3. **销售合同**（当年当期合同，可多份）- 在本地资料目录查找
4. **销售发票**（与合同匹配，发票只能唯一匹配一个成果）- 在本地资料目录查找
5. **产品证明材料**（查新报告、检测报告、质量管理体系认证、产品说明书、产品照片等）
6. **RD表、IP表、PS表** - 用于验证关联关系

## 输出规范

### 1. 科技成果转化证明材料清单
```python
def generate_achievement_checklist(enterprise_name, achievement_table, ip_table, rd_table, ps_table, application_year):
    """生成科技成果转化证明材料清单"""
    
    wb = Workbook()
    ws = wb.active
    ws.title = '成果转化清单'
    
    headers = ['序号', '科技成果名称', '成果类型', '转化时间', '关联IP', '关联RD', '关联PS', 
               '证明材料内容', '证明材料文件名', '备注']
    ws.append(headers)
    
    recent_years = [application_year - 3, application_year - 2, application_year - 1]
    
    for _, row in achievement_table.iterrows():
        ach_id = row['科技成果序号']
        associations = find_achievement_associations(row, ip_table, rd_table, ps_table)
        
        ip_names = ','.join([ip['name'] for ip in associations['related_ips']])
        rd_names = ','.join([rd['rd_id'] + '(' + rd['name'] + ')' for rd in associations['related_rds']])
        ps_names = ','.join([ps['ps_id'] + '(' + ps['name'] + ')' for ps in associations['related_ps']])
        
        ws.append([
            ach_id,
            row['科技成果名称'],
            row['成果类型'],
            pd.to_datetime(row['转化时间']).strftime('%Y-%m-%d'),
            ip_names,
            rd_names,
            ps_names,
            '专利证书+合同+发票+质量管理体系认证+检测报告+产品说明',
            f"{ach_id}_{row['科技成果名称']}.pdf",
            ''
        ])
    
    # 合同发票清单Sheet
    ws2 = wb.create_sheet('合同发票清单')
    ws2.append(['序号', '成果名称', '合同编号', '甲方', '乙方', '合同金额', '签订时间', 
                '发票代码', '发票号码', '发票金额', '高新收入金额', '备注'])
    
    output_path = f"{enterprise_name}-科技成果转化证明材料清单.xlsx"
    wb.save(output_path)
    return output_path
```

### 2. 科技成果转化证明材料文件
> **v1.36.0**：证明材料附件PDF生成改用专用脚本 `generate_achievement_proofs.py`。
> agent 先手工分配合同发票到各成果子目录，然后调用脚本合并。
>
> 调用：`python {{PONOS_SKILLS}}/_common/generate_achievement_proofs.py organize --achievement-table ... --materials-dir ... --ip-dir ... --output-dir ...`
> 详见上方 v1.36.0 新增章节及第四步操作流程。

## 整理要求
1. **成果完整性**：每个RD项目至少对应1项科技成果转化
2. **年度覆盖性**：近三年每年至少有1项转化成果
3. **关联准确性**：关联IP、RD、PS必须与汇总表及核心表格一致
4. **时间一致性**：转化时间必须在近三年内
5. **合同发票匹配**：发票必须与合同唯一匹配，一个发票只能归属一个成果
6. **产品相关性**：产品证明材料必须与转化成果相关
7. **上年度范围**：代表性合同与发票必须是上年度的

## 文件格式规范
1. **PDF格式**：.pdf格式
2. **文件大小**：单个成果≤2M
3. **文件命名**：{成果序号}_{成果名称}.pdf
4. **文件加密**：不得加密
5. **合同发票**：合同与发票必须对应放置，顺序清晰

## 数据一致性检查
```python
def full_validation(achievement_table, ip_table, rd_table, ps_table, application_year):
    """完整数据一致性检查"""
    all_errors = []
    
    # 1. 关联一致性
    all_errors.extend(validate_achievement_consistency(achievement_table, ip_table, rd_table, ps_table))
    
    # 2. 时间一致性
    time_result = validate_achievement_time(achievement_table, application_year)
    all_errors.extend(time_result['errors'])
    
    # 3. RD覆盖检查
    all_errors.extend(validate_rd_achievement_coverage(rd_table, achievement_table))
    
    # 4. 发票唯一性检查（需要合同发票数据）
    # 需要用户提供合同发票清单后验证
    
    return all_errors
```

## 工作流程
1. **加载数据**：读取核心表格（IP/RD/PS/成果转化表）
2. **成果梳理**：梳理所有科技成果转化项目，检查年度覆盖性
3. **关联验证**：验证成果与IP、RD、PS的关联关系
4. **RD覆盖检查**：确保每个RD项目至少有1项转化成果
5. **材料收集**：收集每个成果的证明材料（专利、合同、发票、质量管理体系证书、检测报告、产品说明等）
6. **合同发票匹配**：确保合同与发票一一对应，发票唯一匹配成果
7. **文件整理**：按照命名规范合并为PDF文件，合同发票对应放置
8. **成果转化汇总表模板注入**（v1.33.0新增）：采集成果转化汇总数据 → 调用 `TemplateInjector.inject_achievement_table()` 注入模板
9. **清单生成**：生成科技成果转化证明材料清单
10. **一致性检查**：运行完整数据一致性检查
11. **质量检查**：检查材料完整性、关联准确性和文件格式

**RD-IP-PS匹配（v1.12.0）**：整理成果转化材料时，应调用 `match_rd_ip_ps_with_audit(rd_list, ps_list, ip_list)` 得到 RD→IP→PS 的匹配关系，作为"每RD至少1项成果转化、近三年每年至少1项"的证据基础；根据匹配结果的 assignment 字段构建每个RD的成果转化（RD产出的IP、支撑的PS），确保每项成果转化都有匹配的知识产权支撑。

## 常见问题处理
1. **合同发票不匹配**：重新核对合同和发票，确保一一对应
2. **证明材料不全**：补充查新报告、检测报告（第三方/内部）、质量管理体系认证、产品说明书等
3. **关联关系错误**：核对成果转化汇总表，修正关联IP、RD、PS
4. **时间不符合**：确保转化时间在近三年内
5. **文件大小超限**：压缩图片或拆分文件
6. **RD项目无转化**：为缺少转化成果的RD项目补充关联成果
7. **年度覆盖缺失**：补充缺失年份的转化成果
8. **发票重复归属**：确保每张发票仅归属一个成果转化项目

## 输出隐患自查与汇报（v1.19.0升级，技能结束时强制执行）

> **强制要求**：整理完成果转化证明材料后，agent 必须按以下7个维度进行隐患自查并汇报。

### 自查清单（7维覆盖）

| 维度 | 检查项 | 表现 |
|------|------|------|
| **1. 原始资料缺失** | 每项成果是否有对应的证明材料文件 | 成果清单中有条目但无对应PDF/图片文件 |
| | 证明材料是否可打开、内容清晰可读 | 文件损坏、扫描件模糊 |
| | 依赖的上游文件（IP表.xlsx/RD表.xlsx）是否存在 | 无法读取关联表 |
| **2. 文本质量** | 成果转化表中的关键技术描述是否有实质内容 | 纯套话，无具体技术参数 |
| | 成效描述是否有具体数据支撑 | "经济效益显著"但无收入/利润数据 |
| | 是否存在AI痕迹 | 重复句式、空泛表述 |
| **3. 逻辑关联** | 每项成果转化是否匹配了知识产权 | 成果无IP支撑 |
| | 每项成果转化的RD和PS关联是否完整 | 成果转化表关联列为空 |
| | 成果数量 ≥ 近三年RD项目数 × 3 | 成果转化数量不达标 |
| **4. 字数问题** | 成果转化表关键技术 370-410字 | 字数超标（需优化非截断） |
| | 成效描述 370-410字 | 字数不足或超标 |
| **5. 文档格式** | 文件命名是否符合`{序号}_{文件名}`格式 | 命名不规范 |
| | PDF文件是否已正确合并（多页合并） | 多页未合并为一页 |
| | 证明材料日期是否按时间排序 | 日期混乱 |
| **6. 政策符合性** | 成果转化数量是否满足高新认定最低要求 | 近三年转化成果<15项 |
| | 每项成果是否都有对应的知识产权支撑 | 成果转化无IP对应 |
| | 转化形式分类是否正确 | 自行转化/合作转化/许可转让分类错误 |
| **7. 数据可溯源性** | 成果转化表中的关键技术可否追溯到IP先进性说明 | 内容来源不明确 |
| | 成效数据可否追溯到应用证明/销售合同 | 数据无出处 |

### 汇报格式

```
⚠️ gxtz-achievement-materials 输出隐患自查报告

1. 原始资料: ✓ / ⚠ {n}项缺失
2. 文本质量: ✓ / ⚠ {n}处空泛
3. 逻辑关联: ✓ / ⚠ {n}项未关联
4. 字数合规: ✓ / ⚠ {n}字段需优化
5. 文档格式: ✓ / ⚠ {n}处不规范
6. 政策符合性: ✓ / ⚠ {n}项不合规
7. 数据溯源: ✓ / ⚠ {n}字段无来源

待用户确认后进入下一步。
```

## 模块六：PDF拆分与合并资料整理（pdf_splitter）

> 详见 {{PONOS_SKILLS}}/_common/pdf_splitter.py

---

## 模块七：文件分类整理（file_organizer）

> 详见 {{PONOS_SKILLS}}/_common/file_content_classifier.py

---

## 模块八：高新政策要求与合规校验（policy_compliance）

> 详见 {{PONOS_SKILLS}}/_common/policy_compliance.py

---

## 模块九：企业基本信息联网搜索（enterprise_info_search）

> 详见 {{PONOS_SKILLS}}/_common/enterprise_info_search.py

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
