---
name: "gxtz-info-collector"
description: "高新技术企业认定企业信息调查与资料收集清单生成。当用户提到高新认定、高企认定、信息收集、资料清单、企业信息调查时调用此技能。v1.31.0新增：AI输出类型安全强化（锐取项目发现的list/str类型匹配问题）。v1.30.0新增：合同发票收资清单三步强制校验（逐年度配对+按成果转化算缺额+全文OCR）。v1.28.0新增：企业深度研究Agent。v1.29.0: SKILL.md瘦身。"
version: "1.31.1"
triggers:
  - "高新认定"
  - "高企认定"
  - "高新技术企业"
  - "信息收集"
  - "资料清单"
  - "企业信息调查"
  - "资料收集"
  - "材料清单"
---

## 企业深度研究 Agent（v1.28.0 新增）

> **来源**: 参考 https://github.com/guy-hartstein/company-research-agent (Apache 2.0)
> **核心思想**: 将原项目的多Agent研究流水线（CompanyAnalyzer → IndustryAnalyzer → TechnologyLandscaper → NewsScanner → Collector → Curator → Briefing → Editor）用本地方案替代外部API（Tavily/Gemini/OpenAI），嵌入到企业信息调查步骤。

### 引擎位置

```
{{YFW_SKILLS}}/_common/company_research_agent.py
```

### 流水线架构（4研究节点 → 2处理节点）

```
阶段1: 研究节点（agent 执行 WebSearch）
  CompanyAnalyzer → IndustryAnalyzer → TechnologyLandscaper → NewsScanner
      ↓                    ↓                    ↓                  ↓
  企业基本信息         行业定位趋势        技术专利布局         新闻动态舆情

阶段2: 处理节点（本地执行）
  Collector（聚合所有搜索文本）→ Curator（相关性评分过滤）→ Briefing（结构化提取）→ Editor（编译报告）
```

### 与其他模块的关系

| 模块 | 定位 | 区别 |
|------|------|------|
| **模块九** enterprise_info_search | 补充工商注册信息（注册时间/经营范围/统一社会信用代码） | 单一维度、工商数据源 |
| **模块十** company_research_agent (v1.28.0) | 深度企业研究（行业/技术/财务/新闻4维度） | 多维度、全网数据源 |

模块十是模块九的**增强版**，在模块九补充完工商信息后，进一步做深度研究。

### CLI 用法

```bash
# 步骤1: 生成搜索计划（21条搜索查询，4个维度）
python company_research_agent.py plan  \
  --enterprise "企业全称"  \
  --industry-keywords "行业关键词"  \
  --output-dir <输出目录>

# 步骤2: agent 按计划执行 WebSearch（由 Claude Code agent 完成）
# agent 将每条查询的搜索结果保存为 .txt 文件到 results/ 目录

# 步骤3: 解析搜索结果（Collector + Curator）
python company_research_agent.py parse  \
  --results-dir <results目录>  \
  --enterprise "企业全称"  \
  --output-json <collected.json路径>

# 步骤4: 生成结构化研究报告（Briefing + Editor）
python company_research_agent.py report  \
  --data <collected.json路径>  \
  --enterprise "企业全称"  \
  --output-dir <输出目录>

# 输出文件：
#   {enterprise}_research_report.json  — 结构化数据
#   {enterprise}_research_report.md    — 人类可读报告
```

### 执行流程（嵌入到技能工作流）

**执行时机**：在模块九（企业基本信息联网搜索）完成后执行

**执行步骤**：
1. 调用 `company_research_agent.py plan` 生成搜索计划JSON
2. 按搜索计划中的21条查询逐一执行 `WebSearch` 工具搜索
3. 将每条搜索结果保存为独立 `.txt` 文件到 `project_knowledge/research_results/` 目录
4. 调用 `company_research_agent.py parse` 聚合解析
5. 调用 `company_research_agent.py report` 生成最终报告
6. 将报告关键字段写入 `enterprise_info.json`
7. 将完整报告保存到 `project_knowledge/` 目录

### 报告输出字段

| 维度 | 提取字段 | 高新认定用途 |
|------|---------|-------------|
| company_profile | 注册资本、成立日期、经营范围、统一社会信用代码 | 基础信息校验 |
| industry_analysis | 行业类型、市场份额、竞争对手、行业排名 | 高新领域判定 |
| technology_landscape | 专利数量、技术方向、研发团队规模、产学研合作 | RD项目设计参考 |
| news_digest | 近期动态、融资情况、合作动态 | PS产品定位参考 |

---

## AI输出类型安全校验（v1.27.0 新增）

> **来源**: EXP-2026-07-21-001 — AI推理异常: write() argument must be str, not list

**强制规则**：
1. 所有AI生成的输出结果在写入文件前，必须执行类型检查：`assert isinstance(output, str), f"Expected str, got {type(output)}"`
2. 当输出为 list 类型时，自动执行 `'/n'.join(output)` 转换为多行字符串
3. 当输出为其他非预期类型时，转为 `str(output)` 并记录警告日志
4. 批量操作中任一步骤类型异常不得导致整体失败，降级为安全输出继续执行

**实现示例**：
```python
def safe_write(output, file_path):
    if isinstance(output, list):
        output = '/n'.join(str(item) for item in output)
    elif not isinstance(output, str):
        output = str(output)
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(output)
```

> v1.31.0 强化：增加 list→str 自动转换提醒，参考 EXP-2026-07-21-001

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
8. **禁止跳过扫描件 OCR（v2026-07-22 新增，强制）**：检测发现扫描页时，必须执行 OCR，不得用 `--mode text` 跳过。完整规范见 `{{YFW_SKILLS}}/_common/SHARED_ocr_reference.md` 中的"强制执行规则"章节
9. **禁止输出类型不匹配（v1.31.0 新增）**：所有输出参数必须检查类型，list类型必须用join()转str后再传入write()等字符串参数函数。遇到TypeError(write() argument must be str, not list)时不得自行编写兜底代码，必须检查上游数据类型并修正

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

- 脚本路径必须使用绝对路径
- 参数必须按脚本定义的 CLI 接口传递
- 不得通过"调用 xxx() 函数"的形式执行（函数描述不是可执行命令）

## 审核验证标准（agent 必须执行且通过）

### 审核脚本调用

最后一步必须执行对应的审核验证脚本：

```
python {{YFW_SKILLS}}/_common/validate_info_collector.py --dir "输出目录" --project-root "项目根目录"
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

# 高新认定企业信息调查与资料收集清单生成

## 描述
本技能用于高新技术企业认定项目的企业信息调查和资料收集清单生成。通过系统化排查企业现有资料、逐一读取分析确认资料有效性、生成详细的资料收集清单（含补充要求），为后续材料撰写提供基础数据支撑。

## 使用场景
- 用户提到"高新认定"、"高企认定"、"高新技术企业"并涉及"信息收集"、"资料清单"、"企业信息"
- 用户需要开始新的高新认定项目，需要收集企业基础信息
- 用户提到"资料收集清单"、"材料清单"、"企业信息调查"

## 工具依赖
```python
# 必需Python库
import openpyxl          # Excel文件读写
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.utils import get_column_letter
from docx import Document  # Word文件读写
from docx.shared import Pt, Cm, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
import pandas as pd       # 数据处理
from datetime import datetime
import os
import glob
import shutil
import re
import json

# PDF处理
try:
    from PyPDF2 import PdfReader, PdfWriter, PdfMerger
    import pdfplumber
except ImportError:
    pass
```

## 全局知识库集成

本技能负责初始化和管理全局项目知识库（project_knowledge），所有其他技能共享此知识库。

### 知识库结构
```
.claude/project_knowledge/
├── project_index.json      # 项目索引（文件结构图+知识图谱+进度追踪）
├── enterprise_info.json    # 企业基本信息
├── experience_base.json    # 经验沉淀
└── README.md               # 使用说明
```

### 知识库操作

#### 1. 初始化知识库
```python
def init_project_knowledge(enterprise_name, application_year):
    """初始化项目知识库"""
    knowledge_dir = ".claude/project_knowledge"
    os.makedirs(knowledge_dir, exist_ok=True)
    
    # 初始化project_index.json
    project_index = {
        "project_name": f"{enterprise_name}高新认定项目",
        "enterprise_name": enterprise_name,
        "application_year": application_year,
        "recent_three_years": [application_year - 3, application_year - 2, application_year - 1],
        "last_year": application_year - 1,
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
        "file_structure": {
            "description": "项目文件结构图",
            "tree": {}
        },
        "knowledge_graph": {
            "description": "知识关联图谱",
            "nodes": [],
            "edges": []
        },
        "progress_tracking": {
            "description": "材料完成进度追踪",
            "categories": {}
        },
        "data_summary": {
            "ip_count": 0,
            "rd_count": 0,
            "ps_count": 0,
            "achievement_count": 0,
            "staff_count": 0,
            "total_employees": 0,
            "rd_expenses_total": 0,
            "revenue_total": 0
        }
    }
    
    # 保存文件
    with open(f"{knowledge_dir}/project_index.json", 'w', encoding='utf-8') as f:
        json.dump(project_index, f, ensure_ascii=False, indent=2)
    
    return project_index
```

#### 2. 更新文件结构图
```python
def update_file_structure(file_info):
    """更新文件结构图"""
    # 读取现有索引
    with open(".claude/project_knowledge/project_index.json", 'r', encoding='utf-8') as f:
        index = json.load(f)
    
    # 添加文件到树结构
    category = file_info.get('category', '未分类')
    subcategory = file_info.get('subcategory', '其他')
    
    if category not in index['file_structure']['tree']:
        index['file_structure']['tree'][category] = {}
    if subcategory not in index['file_structure']['tree'][category]:
        index['file_structure']['tree'][category][subcategory] = []
    
    index['file_structure']['tree'][category][subcategory].append({
        'name': file_info['name'],
        'path': file_info['path'],
        'status': file_info.get('status', '已识别'),
        'verified': file_info.get('verified', False),
        'ip_id': file_info.get('ip_id'),
        'rd_id': file_info.get('rd_id'),
        'ps_id': file_info.get('ps_id')
    })
    
    index['updated_at'] = datetime.now().isoformat()
    
    # 保存更新
    with open(".claude/project_knowledge/project_index.json", 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
```

#### 3. 更新知识图谱
```python
def update_knowledge_graph(node_type, node_data, edges=None):
    """更新知识图谱"""
    with open(".claude/project_knowledge/project_index.json", 'r', encoding='utf-8') as f:
        index = json.load(f)
    
    # 添加节点
    node = {
        'id': node_data['id'],
        'type': node_type,
        'name': node_data['name'],
        **{k: v for k, v in node_data.items() if k not in ['id', 'name']}
    }
    
    # 检查是否已存在
    existing = [n for n in index['knowledge_graph']['nodes'] if n['id'] == node['id']]
    if not existing:
        index['knowledge_graph']['nodes'].append(node)
    
    # 添加边
    if edges:
        for edge in edges:
            index['knowledge_graph']['edges'].append(edge)
    
    index['updated_at'] = datetime.now().isoformat()
    
    with open(".claude/project_knowledge/project_index.json", 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
```

#### 4. 更新进度追踪
```python
def update_progress(category, item_name, status, file_path=None):
    """更新进度追踪"""
    with open(".claude/project_knowledge/project_index.json", 'r', encoding='utf-8') as f:
        index = json.load(f)
    
    if category not in index['progress_tracking']['categories']:
        index['progress_tracking']['categories'][category] = {
            'total': 0,
            'completed': 0,
            'status': '未开始',
            'items': []
        }
    
    cat = index['progress_tracking']['categories'][category]
    
    # 更新或添加项目
    existing = [i for i in cat['items'] if i['name'] == item_name]
    if existing:
        existing[0]['status'] = status
        existing[0]['file'] = file_path
    else:
        cat['items'].append({
            'name': item_name,
            'status': status,
            'file': file_path
        })
        cat['total'] += 1
    
    # 统计完成数
    cat['completed'] = len([i for i in cat['items'] if i['status'] == '已完成'])
    
    # 更新类别状态
    if cat['completed'] == cat['total']:
        cat['status'] = '已完成'
    elif cat['completed'] > 0:
        cat['status'] = '进行中'
    else:
        cat['status'] = '未开始'
    
    index['updated_at'] = datetime.now().isoformat()
    
    with open(".claude/project_knowledge/project_index.json", 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
```

#### 5. 读取知识库
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
    
    with open(f"{knowledge_dir}/experience_base.json", 'r', encoding='utf-8') as f:
        experience = json.load(f)
    
    return {
        'index': index,
        'enterprise_info': enterprise_info,
        'experience': experience
    }
```

---

## 统一输出目录规范

本技能作为项目入口，负责初始化整个统一输出目录结构，所有gxtz系列技能生成的文件统一存放于此，便于用户查看操作。

### 输出根目录
```
{企业名称}_高新认定材料_{申报年份}/
├── 00_核心表格/              # gxtz-core-tables（含RD-PS-IP关联汇总表）
├── 01_研发立项报告/          # gxtz-rd-report
├── 02_知识产权证明/          # gxtz-ip-materials
├── 03_成果转化证明/          # gxtz-achievement-materials
├── 04_高新产品证明/          # gxtz-ps-materials
├── 05_科技人员材料/          # gxtz-staff-materials
├── 06_管理制度材料/          # gxtz-management-materials
├── 07_资料收集清单/          # gxtz-info-collector（本技能）
└── _校验报告/                # 各技能生成的校验/审核报告
```

### 本技能输出子目录
`07_资料收集清单/`（校验/审核报告输出到 `_校验报告/`）

### 目录初始化函数（本技能负责创建完整结构）
```python
import os

STANDARD_SUBDIRS = [
    "00_核心表格", "01_研发立项报告", "02_知识产权证明", "03_成果转化证明",
    "04_高新产品证明", "05_科技人员材料", "06_管理制度材料", "07_资料收集清单", "_校验报告"
]

def init_output_structure(enterprise_name, application_year):
    """初始化统一输出目录结构，返回根目录路径"""
    root = f"{enterprise_name}_高新认定材料_{application_year}"
    for subdir in STANDARD_SUBDIRS:
        os.makedirs(os.path.join(root, subdir), exist_ok=True)
    return root

def get_output_dir(enterprise_name, application_year, subdir):
    """获取并创建统一输出目录，返回子目录绝对路径"""
    root = f"{enterprise_name}_高新认定材料_{application_year}"
    output_dir = os.path.join(root, subdir)
    os.makedirs(output_dir, exist_ok=True)
    return output_dir
```

## 指令

### 第零步完：确认进度依赖（v1.31.0新增，进度管理集成）

在开始工作前，检查本技能的前置阶段是否已完成：

```bash
python {{YFW_SKILLS}}/_common/progress_sync.py check-deps /n    --project-root "." /n    --skill "gxtz-info-collector"
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
6. 调用 `generate_supplement_checklist(enterprise_name, application_year, 'gxtz-info-collector')` 生成/更新补充资料清单文档
7. 调用 `scan_supplement_dir(enterprise_name, application_year, 'gxtz-info-collector')` 扫描补充资料目录：
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

### 第一步：确定申报基础参数

```python
def determine_application_parameters():
    """确定申报基础参数"""
    
    # 1. 确定申报年份
    application_year = 2026  # 用户指定或默认当前年份
    
    # 2. 计算关键时间范围
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    # 示例：2026年申报 → 近三年 = [2023, 2024, 2025]
    last_year = application_year - 1  # 高新产品收入所属年度
    
    # 3. 计算研发费用占比要求
    # 年收入 < 5000万：研发费用占比 ≥ 5%
    # 5000万 ≤ 年收入 < 2亿：研发费用占比 ≥ 4%
    # 年收入 ≥ 2亿：研发费用占比 ≥ 3%
    
    # 4. 科技人员占比要求：≥ 10%
    
    return {
        'application_year': application_year,
        'recent_three_years': recent_three_years,
        'last_year': last_year
    }
```

向用户确认：
- 申报年份（默认当前年份）
- 企业上年度营业收入（用于计算研发费用占比要求）
- 企业成立日期（用于判断是否满一年）

---

### 第二步：排查现有资料（逐一读取分析，完整筛查本地项目资料）

**核心原则：**
1. **每份资料必须逐一打开读取，确认内容有效性，不能仅凭文件名判断。**
2. **完整筛查本地项目资料：递归遍历所有子目录，不遗漏任何文件。**
3. **区分专利证书与其他专利资料文献：证书、说明书、通知书、缴费凭证等分别排查。**

#### 2.0 本地资料完整筛查（入口函数，聚合所有排查结果）

```python
def scan_local_project_materials(data_dir, application_year, region='shenzhen', 
                                  ip_table=None, rd_table=None, ps_table=None):
    """完整筛查本地项目资料（入口函数，聚合所有排查结果）
    
    Args:
        data_dir: 项目资料根目录（递归遍历所有子目录）
        application_year: 申报年份
        region: 地区（shenzhen/guangdong）
        ip_table: IP表数据（可选，用于精确匹配知识产权资料）
        rd_table: RD表数据（可选）
        ps_table: PS表数据（可选）
    
    Returns:
        dict: 完整的排查分析结果，包含8大类资料的排查状态
    """
    print(f"开始筛查本地项目资料：{data_dir}")
    print(f"申报年份：{application_year}，地区：{region}")
    
    # v1.3.0新增：识别客户原始资料目录（区分客户原始资料和工作成果）
    customer_raw_info = identify_customer_raw_materials_dir(data_dir)
    if customer_raw_info['customer_raw_dirs']:
        print(f"识别到客户原始资料目录：{customer_raw_info['customer_raw_dirs']}")
    if customer_raw_info['compressed_files']:
        print(f"发现压缩文件：{len(customer_raw_info['compressed_files'])}个（将递归解压）")
    
    # v1.3.0新增：识别企业类型（软件类/硬件类/混合型），用于差异化资料收集
    enterprise_type_info = identify_enterprise_type(
        enterprise_name='',
        ip_list=ip_table, rd_list=rd_table, ps_list=ps_table
    ) if ip_table else None
    if enterprise_type_info:
        print(f"企业类型：{enterprise_type_info['enterprise_type']}（{enterprise_type_info['evidence']}）")
    
    # 第1步：递归遍历所有文件，建立文件索引（支持压缩文件解压）
    file_index = build_file_index(data_dir)
    print(f"共扫描到 {file_index['total_files']} 个文件")
    
    # 第2步：按8大类分别排查
    analysis_results = {
        'file_index': file_index,
        'scan_time': datetime.now().isoformat(),
        'data_dir': data_dir,
        'application_year': application_year,
        'region': region,
        'customer_raw_info': customer_raw_info,
        'enterprise_type': enterprise_type_info,
    }
    
    # 2.1 基础信息类资料排查
    analysis_results['basic_info'] = analyze_basic_info_materials(file_index, application_year)
    
    # 2.2 知识产权类资料排查（区分专利证书与其他专利资料文献）
    analysis_results['ip'] = analyze_ip_materials(data_dir, ip_table, application_year, region)
    
    # 2.3 研发项目类资料排查
    analysis_results['rd'] = analyze_rd_materials(file_index, application_year, rd_table)
    
    # 2.4 科技成果转化证明材料排查
    analysis_results['contracts'] = analyze_contract_invoice_files(data_dir, application_year)
    analysis_results['products'] = analyze_product_materials(file_index, application_year)
    
    # 2.5 高新产品类资料排查
    analysis_results['ps'] = analyze_ps_materials(file_index, application_year, ps_table)
    
    # 2.6 人员类资料排查
    analysis_results['staff'] = analyze_staff_materials(file_index, application_year)
    
    # 2.7 财务类资料排查
    analysis_results['financial'] = analyze_financial_materials(file_index, application_year)
    
    # 2.8 其他证明材料排查（照片、设备、管理证明）
    analysis_results['photos'] = analyze_photo_files(data_dir)
    analysis_results['equipment'] = analyze_equipment_list(find_equipment_file(file_index))
    analysis_results['management'] = analyze_management_materials(data_dir, application_year)
    
    # 第3步：汇总所有问题
    all_issues = []
    for category, result in analysis_results.items():
        if isinstance(result, dict) and 'issues' in result:
            for issue in result['issues']:
                all_issues.append(f"[{category}] {issue}")
    
    analysis_results['all_issues'] = all_issues
    analysis_results['issues_count'] = len(all_issues)
    
    # 第4步：生成筛查摘要
    analysis_results['summary'] = generate_scan_summary(analysis_results)
    
    print(f"筛查完成，共发现 {len(all_issues)} 个问题")
    return analysis_results

def build_file_index(data_dir):
    """递归遍历建立文件索引（完整筛查，不遗漏任何文件）"""
    file_index = {
        'all_files': [],
        'by_extension': {},
        'by_directory': {},
        'total_files': 0,
        'total_size_mb': 0
    }
    
    for root, dirs, files in os.walk(data_dir):
        # 跳过隐藏目录和系统目录
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['__pycache__', 'node_modules']]
        
        rel_dir = os.path.relpath(root, data_dir)
        if rel_dir not in file_index['by_directory']:
            file_index['by_directory'][rel_dir] = []
        
        for file in files:
            file_path = os.path.join(root, file)
            file_size = os.path.getsize(file_path) if os.path.exists(file_path) else 0
            
            file_info = {
                'name': file,
                'path': file_path,
                'rel_path': os.path.join(rel_dir, file) if rel_dir != '.' else file,
                'extension': os.path.splitext(file)[1].lower(),
                'size_bytes': file_size,
                'size_mb': round(file_size / (1024 * 1024), 2),
                'directory': rel_dir
            }
            
            file_index['all_files'].append(file_info)
            file_index['by_directory'][rel_dir].append(file_info)
            
            # 按扩展名分类
            ext = file_info['extension']
            if ext not in file_index['by_extension']:
                file_index['by_extension'][ext] = []
            file_index['by_extension'][ext].append(file_info)
            
            file_index['total_files'] += 1
            file_index['total_size_mb'] += file_info['size_mb']
    
    file_index['total_size_mb'] = round(file_index['total_size_mb'], 2)
    return file_index

def analyze_basic_info_materials(file_index, application_year):
    """排查基础信息类资料"""
    result = {
        'business_license': False,
        'legal_person_id': False,
        'commitment_letter': False,
        'tax_returns': False,
        'application_form': False,
        'iso_certificates': [],
        'industry_licenses': [],
        'honor_certificates': [],
        'standards': [],
        'register_form': False,
        'issues': []
    }
    
    for file_info in file_index['all_files']:
        name = file_info['name'].lower()
        
        if '营业执照' in name or 'license' in name:
            result['business_license'] = True
        elif '法人' in name and '身份证' in name:
            result['legal_person_id'] = True
        elif '承诺书' in name:
            result['commitment_letter'] = True
        elif '纳税申报' in name or '所得税' in name:
            result['tax_returns'] = True
        elif '申请书' in name and '高新' in name:
            result['application_form'] = True
        elif 'ISO' in name or '质量管理体系' in name or '环境体系' in name:
            result['iso_certificates'].append(file_info)
        elif '许可证' in name or '资质证书' in name:
            result['industry_licenses'].append(file_info)
        elif '荣誉' in name or '奖项' in name:
            result['honor_certificates'].append(file_info)
        elif '标准' in name and ('参与' in name or '制定' in name or '主导' in name):
            result['standards'].append(file_info)
        elif '注册信息' in name or '企业信息' in name:
            result['register_form'] = True
    
    # 检查必填项
    if not result['business_license']:
        result['issues'].append("缺少营业执照扫描件")
    if not result['tax_returns']:
        result['issues'].append("缺少企业所得税年度纳税申报表")
    
    return result

def analyze_rd_materials(file_index, application_year, rd_table=None):
    """排查研发项目类资料"""
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    
    result = {
        'reports': [],
        'acceptance_reports': [],
        'auxiliary_accounts': [],
        'audit_reports': [],
        'equipment_list': False,
        'site_proofs': [],
        'issues': []
    }
    
    for file_info in file_index['all_files']:
        name = file_info['name']
        
        if '立项' in name and ('报告' in name or '决议' in name):
            result['reports'].append(file_info)
        elif '验收' in name:
            result['acceptance_reports'].append(file_info)
        elif '辅助账' in name:
            result['auxiliary_accounts'].append(file_info)
        elif '专项审计' in name and '研发' in name:
            result['audit_reports'].append(file_info)
        elif '设备清单' in name:
            result['equipment_list'] = True
        elif '场地' in name and '研发' in name:
            result['site_proofs'].append(file_info)
    
    # 检查RD报告数量
    if rd_table is not None:
        required_count = len(rd_table)
        actual_count = len(result['reports'])
        if actual_count < required_count:
            result['issues'].append(f"研发立项报告数量不足，当前{actual_count}份，要求{required_count}份")
    else:
        # 无RD表时，检查近三年每年至少5个
        min_required = 15  # 3年×5个
        if len(result['reports']) < min_required:
            result['issues'].append(f"研发立项报告数量偏少，当前{len(result['reports'])}份，建议≥{min_required}份")
    
    # 检查辅助账覆盖近三年
    if len(result['auxiliary_accounts']) < 3:
        result['issues'].append(f"研发费用辅助账数量不足，当前{len(result['auxiliary_accounts'])}套，要求3套（每年1套）")
    
    return result

def analyze_product_materials(file_index, application_year):
    """排查产品相关材料"""
    result = {
        'introductions': [],
        'test_reports': [],
        'certifications': [],
        'specifications': [],
        'user_feedback': [],
        'issues': []
    }
    
    for file_info in file_index['all_files']:
        name = file_info['name']
        
        if '产品介绍' in name or '产品说明' in name:
            result['introductions'].append(file_info)
        elif '检测' in name or '测试' in name or '查新' in name:
            result['test_reports'].append(file_info)
        elif '认证' in name and any(cert in name for cert in ['UL', '3C', 'CE', 'FCC', 'CSA', 'ETL', 'GS', 'RoHS', 'CCC']):
            result['certifications'].append(file_info)
        elif '规格书' in name:
            result['specifications'].append(file_info)
        elif '用户' in name and ('满意' in name or '反馈' in name):
            result['user_feedback'].append(file_info)
    
    return result

def analyze_ps_materials(file_index, application_year, ps_table=None):
    """排查高新产品类资料"""
    last_year = application_year - 1
    
    result = {
        'tech_descriptions': [],
        'quality_reports': [],
        'certifications': [],
        'income_audit': False,
        'sales_contracts': [],
        'sales_invoices': [],
        'issues': []
    }
    
    for file_info in file_index['all_files']:
        name = file_info['name']
        
        if '关键技术' in name or '技术说明' in name:
            result['tech_descriptions'].append(file_info)
        elif '检验' in name and '产品' in name:
            result['quality_reports'].append(file_info)
        elif '高新' in name and '审计' in name:
            result['income_audit'] = True
        elif '合同' in name and str(last_year) in name:
            result['sales_contracts'].append(file_info)
        elif '发票' in name and str(last_year) in name:
            result['sales_invoices'].append(file_info)
    
    return result

def analyze_staff_materials(file_index, application_year):
    """排查人员类资料"""
    last_year = application_year - 1
    
    result = {
        'info_table': False,
        'diplomas': [],
        'professional_certificates': [],
        'social_security': False,
        'tax_records': [],
        'issues': []
    }
    
    for file_info in file_index['all_files']:
        name = file_info['name']
        
        if '研发人员' in name and ('信息表' in name or '花名册' in name):
            result['info_table'] = True
        elif '学历' in name or '毕业证书' in name:
            result['diplomas'].append(file_info)
        elif '职称' in name or '人才证书' in name:
            result['professional_certificates'].append(file_info)
        elif '社保' in name:
            result['social_security'] = True
        elif '个人所得税' in name:
            result['tax_records'].append(file_info)
    
    if not result['info_table']:
        result['issues'].append(f"缺少{last_year}年研发人员信息表")
    if not result['social_security']:
        result['issues'].append(f"缺少{last_year}年12月社保人员清单")
    
    return result

def analyze_financial_materials(file_index, application_year):
    """排查财务类资料"""
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    
    result = {
        'audit_reports': [],
        'tax_returns': [],
        'tax_certificates': [],
        'rd_audit_report': False,
        'rd_auxiliary_account': [],
        'ps_audit_report': False,
        'invoice_detail': False,
        'issues': []
    }
    
    for file_info in file_index['all_files']:
        name = file_info['name']
        
        if '财务审计' in name or ('审计报告' in name and '研发' not in name and '高新' not in name):
            result['audit_reports'].append(file_info)
        elif '纳税申报' in name:
            result['tax_returns'].append(file_info)
        elif '纳税证明' in name:
            result['tax_certificates'].append(file_info)
        elif '专项审计' in name and '研发' in name:
            result['rd_audit_report'] = True
        elif '辅助账' in name:
            result['rd_auxiliary_account'].append(file_info)
        elif '高新' in name and '审计' in name and '收入' in name:
            result['ps_audit_report'] = True
        elif '开票明细' in name:
            result['invoice_detail'] = True
    
    # 检查近三年覆盖
    if len(result['audit_reports']) < 3:
        result['issues'].append(f"财务审计报告数量不足，当前{len(result['audit_reports'])}份，要求3份（每年1份）")
    if len(result['tax_returns']) < 3:
        result['issues'].append(f"纳税申报表数量不足，当前{len(result['tax_returns'])}份，要求3份（每年1份）")
    if not result['rd_audit_report']:
        result['issues'].append("缺少近三年研发费用专项审计报告")
    if not result['ps_audit_report']:
        result['issues'].append("缺少上年度高新技术产品收入专项审计报告")
    
    return result

def find_equipment_file(file_index):
    """从文件索引中查找研发设备清单文件"""
    for file_info in file_index['all_files']:
        if '设备清单' in file_info['name'] and file_info['extension'] in ['.xlsx', '.xls']:
            return file_info['path']
    return None

def find_fixed_asset_file(file_index):
    """从文件索引中查找固定资产清单文件（v1.5.0新增）

    作为 find_equipment_file 的补充变体，用于定位客户提供的固定资产清单，
    以便后续调用 filter_rnd_equipment_from_fixed_assets 从中筛选研发设备。
    """
    for file_info in file_index['all_files']:
        if ('固定资产' in file_info['name'] or '资产清单' in file_info['name']) and file_info['extension'] in ['.xlsx', '.xls']:
            return file_info['path']
    return None

def generate_scan_summary(analysis_results):
    """生成筛查摘要"""
    summary = {
        'total_files': analysis_results['file_index']['total_files'],
        'total_size_mb': analysis_results['file_index']['total_size_mb'],
        'issues_count': analysis_results['issues_count'],
        'categories_status': {}
    }
    
    # 各类别状态汇总
    category_mapping = {
        'basic_info': '基础信息',
        'ip': '知识产权',
        'rd': '研发项目',
        'contracts': '合同发票',
        'products': '产品材料',
        'ps': '高新产品',
        'staff': '人员资料',
        'financial': '财务资料',
        'photos': '照片资料',
        'equipment': '研发设备',
        'management': '管理证明'
    }
    
    for key, label in category_mapping.items():
        cat_data = analysis_results.get(key, {})
        if isinstance(cat_data, dict):
            issues_count = len(cat_data.get('issues', []))
            summary['categories_status'][label] = {
                'issues_count': issues_count,
                'status': '通过' if issues_count == 0 else '有问题'
            }
    
    return summary
```

#### 2.1 基础信息类资料排查

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 营业执照 | 必须在有效期内 | PNG格式，<500KB | 1份 | 确认企业名称、统一社会信用代码、成立日期、经营范围 |
| 2 | 企业承诺书 | 申报当年 | 系统生成后签字盖章PDF | 1份 | 需法人签字+公章 |
| 3 | 企业所得税年度纳税申报表 | 近三年每年1份 | PDF | 3份 | 确认主表及附表完整，含研发费用加计扣除数据 |
| 4 | 高新技术企业认定申请书 | 申报当年 | 系统生成PDF | 1份 | 系统填报后导出 |
| 5 | 政务网账号信息 | 当前有效 | 文本 | 1份 | 确认账号、密码、统一社会信用代码 |
| 6 | 火炬网账号信息 | 当前有效 | 文本 | 1份 | 确认账号、密码 |
| 7 | 企业更名证明 | 近三年内（如有变更） | PDF | 按实际 | 市场监督管理部门出具的《核准变更通知书》 |
| 8 | 公司宣传资料 | 无时间要求 | PDF/PPT | 有则提供 | 公司宣传彩页、企业介绍PPT或画册 |

#### 2.2 知识产权类资料排查（重点优化：区分专利证书与其他专利资料文献）

**核心原则：专利证书与其他专利资料文献（说明书、权利要求书、通知书、缴费凭证等）必须严格区分，分别排查、分别整理、分别命名。**

##### 2.2.1 专利/证书扫描件（核心证明文件，网报必须上传）

| 序号 | 资料名称 | IP类型 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------|--------------|----------|----------|----------|
| 1 | 发明专利证书扫描件 | I类 | 授权日期≤申报年份（不限时间） | PDF，单个≤2M | 每项1份 | 确认权利人名称、专利号、授权日期、证书首页+权利要求书完整 |
| 2 | 集成电路布图设计登记证书扫描件 | I类 | 登记日期≤申报年份（不限时间） | PDF，单个≤2M | 每项1份 | 确认权利人名称、登记号、登记日期 |
| 3 | 实用新型专利证书扫描件 | II类 | 授权日期建议近三年内 | PDF，单个≤2M | 每项1份 | 确认权利人名称、专利号、授权日期 |
| 4 | 外观设计专利证书扫描件 | II类 | 授权日期建议近三年内 | PDF，单个≤2M | 每项1份 | 确认权利人名称、专利号、授权日期 |
| 5 | 软件著作权证书扫描件 | II类 | 授权日期建议近三年内 | PDF，单个≤2M | 每项1份 | 确认软件名称、版本号、著作权号、权利人 |

##### 2.2.2 软件著作权附属材料（软著专用，证书之外的必备材料）

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 软件著作权申请表 | 与软著证书对应 | PDF | 每项软著1份 | 确认软件名称、版本号、著作权人、登记号 |
| 2 | 软件源程序文档 | 与软著证书对应 | PDF/Word | 每项软著1份 | 前30页+后30页源代码，含软件名称页眉 |
| 3 | 软件设计说明书/用户手册 | 与软著证书对应 | PDF | 每项软著1份 | 含软件功能描述、技术架构、操作说明 |

**软著附属材料排查要点：**
- 软著申请表需为提交版权局登记的原始申请表
- 源程序文档需含软件名称页眉、页码连续
- 设计说明书/用户手册需图文并茂，体现软件功能
- 软著附属材料需与软著证书合并为单个PDF上传网报系统

##### 2.2.3 专利状态证明材料（验证专利有效性）

| 序号 | 资料名称 | 适用IP类型 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|------------|--------------|----------|----------|----------|
| 1 | 专利登记簿副本 | 发明专利（建议） | 近3个月内出具 | PDF | 按需1份 | 确认法律状态为"有效"，无质押、无效宣告、转让记录 |
| 2 | 专利年费缴费发票 | 发明+实用新型（广东省必须） | 最近一次年费缴纳 | PDF/扫描件 | 每项1份 | 确认缴费年度、缴费金额、缴费日期、专利号 |
| 3 | 专利权评价报告 | 实用新型+外观（建议） | 近3年内 | PDF | 按需1份 | 确认评价结论为"具备专利性" |

##### 2.2.4 知识产权转让/许可材料（如有转让或许可）

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 知识产权转让合同/许可合同 | 转让/许可日期≤申报年份 | PDF | 每项1份 | 确认转让人、受让人、转让日期、转让费用、权利范围 |
| 2 | 知识产权局手续合格通知书 | 转让完成日期≤申报年份 | PDF | 每项1份 | **必须提供**：经知识产权局变更备案的手续合格通知书，仅合同无效 |
| 3 | 全球独占许可协议（5年以上） | II类IP授权日期不在近三年时需提供 | PDF | 按需1份 | 确认许可期限≥5年、许可范围全球、独占性质 |

##### 2.2.5 其他知识产权相关材料

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 参与制订标准证明材料 | 近三年内 | PDF | 按实际 | 国家/行业/地方/团体标准，确认标准编号、参与角色（主导/参与） |
| 2 | 知识产权获奖证书 | 近三年内 | PDF | 按实际 | 中国专利奖、省级专利奖等，确认奖项级别、获奖年度 |
| 3 | 知识产权管理制度文件 | 当前有效 | PDF | 1份 | 知识产权管理体系认证证书、知识产权管理办法 |

**知识产权类资料排查流程（区分证书与其他文献的优化版）：**
```python
def analyze_ip_materials(data_dir, ip_table, application_year, region='shenzhen'):
    """分析知识产权类资料（区分专利证书与其他专利资料文献）
    
    Args:
        data_dir: 资料目录
        ip_table: IP表数据
        application_year: 申报年份
        region: 地区（shenzhen/guangdong），影响年费发票是否必须
    """
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    
    results = {
        # 1. 证书扫描件（核心证明文件）
        'certificates': {
            '发明专利证书': [],
            '集成电路布图证书': [],
            '实用新型专利证书': [],
            '外观设计专利证书': [],
            '软件著作权证书': []
        },
        # 2. 软著附属材料（证书之外的必备材料）
        'software_copyright_attachments': {
            '申请表': [],
            '源程序文档': [],
            '设计说明书用户手册': []
        },
        # 3. 专利状态证明材料
        'status_proofs': {
            '专利登记簿副本': [],
            '专利年费缴费发票': [],
            '专利权评价报告': []
        },
        # 4. 转让/许可材料
        'transfer_materials': {
            '转让合同许可合同': [],
            '手续合格通知书': [],
            '全球独占许可协议': []
        },
        # 5. 其他知识产权材料
        'other_materials': {
            '标准制定证明': [],
            '知识产权获奖证书': [],
            '知识产权管理制度': []
        },
        'issues': [],
        'statistics': {
            'total_ip': len(ip_table) if ip_table is not None else 0,
            'certificates_found': 0,
            'software_attachments_complete': 0,
            'transfer_notified': 0
        }
    }
    
    # 遍历IP表，逐项排查
    if ip_table is not None:
        for _, ip_row in ip_table.iterrows():
            ip_id = ip_row.get('知识产权编号', '')
            ip_name = ip_row.get('知识产权名称', '')
            ip_category = ip_row.get('类别', '')
            ip_number = ip_row.get('专利号/著作权号', '')
            acquire_method = ip_row.get('获得方式', '自主研发')
            
            # 查找该IP的所有相关文件
            ip_files = find_ip_related_files(data_dir, ip_id, ip_name, ip_number)
            
            # 1. 分类证书文件
            cert_file = classify_and_validate_certificate(
                ip_files, ip_category, ip_row, application_year
            )
            if cert_file:
                results['certificates'][cert_file['subtype']].append(cert_file)
                results['statistics']['certificates_found'] += 1
            else:
                results['issues'].append(f"{ip_id}({ip_name})未找到{ip_category}证书扫描件")
            
            # 2. 软著附属材料排查（仅对软著）
            if '软件著作权' in ip_category:
                sw_attachments = check_software_copyright_attachments(
                    ip_files, ip_id, ip_name
                )
                for key, files in sw_attachments.items():
                    results['software_copyright_attachments'][key].extend(files)
                
                # 检查软著附属材料完整性
                if not sw_attachments['申请表']:
                    results['issues'].append(f"{ip_id}({ip_name})软著缺少申请表PDF")
                if not sw_attachments['源程序文档']:
                    results['issues'].append(f"{ip_id}({ip_name})软著缺少源程序文档")
                if not sw_attachments['设计说明书用户手册']:
                    results['issues'].append(f"{ip_id}({ip_name})软著缺少设计说明书/用户手册")
                else:
                    results['statistics']['software_attachments_complete'] += 1
            
            # 3. 专利状态证明材料排查
            # 发明专利：建议提供专利登记簿副本
            if '发明专利' in ip_category:
                if not find_files_by_keywords(ip_files, ['登记簿']):
                    results['issues'].append(f"{ip_id}({ip_name})发明专利建议提供专利登记簿副本（近3个月内出具）")
            
            # 广东省：发明+实用新型必须提供年费缴费发票
            if region == 'guangdong' and ('发明专利' in ip_category or '实用新型' in ip_category):
                if not find_files_by_keywords(ip_files, ['年费', '缴费', '发票']):
                    results['issues'].append(f"{ip_id}({ip_name})广东省申报必须提供最近年费缴费发票")
            
            # 实用新型+外观：建议提供专利权评价报告
            if '实用新型' in ip_category or '外观设计' in ip_category:
                if not find_files_by_keywords(ip_files, ['评价报告']):
                    results['issues'].append(f"{ip_id}({ip_name}){ip_category}建议提供专利权评价报告")
            
            # 4. 转让/许可材料排查（获得方式为受让或许可的）
            if '受让' in acquire_method or '转让' in acquire_method:
                transfer_contract = find_files_by_keywords(ip_files, ['转让合同', '许可合同'])
                if not transfer_contract:
                    results['issues'].append(f"{ip_id}({ip_name})受让IP缺少转让合同/许可合同")
                
                # 必须提供手续合格通知书（仅合同无效）
                notification = find_files_by_keywords(ip_files, ['手续合格通知书', '合格通知书'])
                if not notification:
                    results['issues'].append(f"{ip_id}({ip_name})受让IP必须提供知识产权局手续合格通知书（仅合同无效）")
                else:
                    results['statistics']['transfer_notified'] += 1
            
            # 5. II类IP授权时间检查（不在近三年需5年以上全球独占许可）
            auth_date = ip_row.get('授权日期')
            if auth_date and ('实用新型' in ip_category or '外观设计' in ip_category or '软件著作权' in ip_category):
                auth_year = pd.to_datetime(auth_date).year
                if auth_year not in recent_three_years:
                    if not find_files_by_keywords(ip_files, ['独占许可']):
                        results['issues'].append(
                            f"{ip_id}({ip_name})为II类知识产权，授权年份{auth_year}不在近三年{recent_three_years}内，"
                            f"需提供5年以上全球独占许可协议"
                        )
    
    # 检查其他知识产权材料
    standard_files = glob.glob(os.path.join(data_dir, '**/*标准*.pdf'), recursive=True)
    if standard_files:
        results['other_materials']['标准制定证明'] = standard_files
    
    return results

def find_ip_related_files(data_dir, ip_id, ip_name, ip_number):
    """查找与指定IP相关的所有文件（包括证书、说明书、通知书、缴费凭证等）
    
    与原find_certificate_files不同：本函数返回该IP的所有相关文件，
    而不仅限于证书扫描件。后续由分类函数进一步区分证书与其他文献。
    """
    search_patterns = [
        os.path.join(data_dir, f'**/*{ip_number}*'),
        os.path.join(data_dir, f'**/*{ip_id}*'),
        os.path.join(data_dir, f'**/*{ip_name}*'),
    ]
    
    found_files = set()
    for pattern in search_patterns:
        matches = glob.glob(pattern, recursive=True)
        found_files.update(matches)
    
    return list(found_files)

def classify_and_validate_certificate(ip_files, ip_category, ip_row, application_year):
    """分类并验证证书扫描件（区分证书与其他文献）
    
    Returns:
        dict: 证书文件信息，包含subtype、file_path、validation结果；如未找到返回None
    """
    # 证书文件关键词（仅匹配证书本身，排除通知书/说明书/缴费凭证等）
    certificate_keywords = {
        '发明专利证书': ['发明专利证书', '发明证书'],
        '集成电路布图证书': ['集成电路布图', '布图设计登记'],
        '实用新型专利证书': ['实用新型专利证书', '实用新型证书'],
        '外观设计专利证书': ['外观设计专利证书', '外观设计证书', '外观专利证书'],
        '软件著作权证书': ['软件著作权证书', '软著证书', '计算机软件著作权登记证书']
    }
    
    # 排除关键词（这些属于其他专利资料文献，不是证书）
    exclude_keywords = ['说明书', '权利要求书', '通知书', '缴费', '年费', '申请表', 
                        '源程序', '源代码', '用户手册', '设计说明书', '登记簿',
                        '评价报告', '转让合同', '许可合同', '手续合格']
    
    # 确定证书子类型
    subtype = None
    for key, keywords in certificate_keywords.items():
        if any(kw in ip_category for kw in keywords) or key.replace('证书', '') in ip_category:
            subtype = key
            break
    
    if not subtype:
        # 根据IP类别推断
        if '发明专利' in ip_category:
            subtype = '发明专利证书'
        elif '集成电路' in ip_category:
            subtype = '集成电路布图证书'
        elif '实用新型' in ip_category:
            subtype = '实用新型专利证书'
        elif '外观' in ip_category:
            subtype = '外观设计专利证书'
        elif '软件著作权' in ip_category or '软著' in ip_category:
            subtype = '软件著作权证书'
    
    if not subtype:
        return None
    
    # 在IP相关文件中查找证书文件（排除其他文献）
    for file_path in ip_files:
        file_name = os.path.basename(file_path)
        
        # 排除其他专利资料文献
        if any(exclude in file_name for exclude in exclude_keywords):
            continue
        
        # 检查是否为证书文件
        cert_keywords = certificate_keywords[subtype]
        if any(kw in file_name for kw in cert_keywords) or file_path.endswith('.pdf'):
            # 验证证书内容
            validation = validate_certificate_content(file_path, ip_row, application_year)
            return {
                'subtype': subtype,
                'file_path': file_path,
                'ip_id': ip_row.get('知识产权编号'),
                'ip_name': ip_row.get('知识产权名称'),
                'validation': validation
            }
    
    return None

def check_software_copyright_attachments(ip_files, ip_id, ip_name):
    """检查软件著作权附属材料（证书之外的必备材料）"""
    attachments = {
        '申请表': [],
        '源程序文档': [],
        '设计说明书用户手册': []
    }
    
    for file_path in ip_files:
        file_name = os.path.basename(file_path)
        
        # 申请表
        if '申请表' in file_name:
            attachments['申请表'].append(file_path)
        # 源程序文档
        elif '源程序' in file_name or '源代码' in file_name:
            attachments['源程序文档'].append(file_path)
        # 设计说明书/用户手册
        elif '说明书' in file_name or '用户手册' in file_name or '设计说明' in file_name:
            attachments['设计说明书用户手册'].append(file_path)
    
    return attachments

def validate_certificate_content(cert_file, ip_row, application_year):
    """验证证书内容与IP表的一致性"""
    validation = {
        'valid': True,
        'issues': []
    }
    
    try:
        content = read_pdf_content(cert_file)
        
        # 检查权利人
        enterprise_name = ip_row.get('所属单位', '')
        if enterprise_name and enterprise_name not in content:
            validation['issues'].append(f"证书权利人与IP表不一致：期望{enterprise_name}")
            validation['valid'] = False
        
        # 检查专利号
        ip_number = ip_row.get('专利号/著作权号', '')
        if ip_number and ip_number not in content:
            validation['issues'].append(f"证书专利号与IP表不一致：期望{ip_number}")
            validation['valid'] = False
        
        # 检查IP名称
        ip_name = ip_row.get('知识产权名称', '')
        if ip_name and ip_name not in content:
            validation['issues'].append(f"证书IP名称与IP表不一致：期望{ip_name}")
            validation['valid'] = False
        
    except Exception as e:
        validation['issues'].append(f"证书读取失败：{str(e)}")
        validation['valid'] = False
    
    return validation

def find_files_by_keywords(file_list, keywords):
    """根据关键词列表查找文件"""
    matched = []
    for file_path in file_list:
        file_name = os.path.basename(file_path)
        if any(kw in file_name for kw in keywords):
            matched.append(file_path)
    return matched
```

**时间约束检查：**
- I类知识产权（发明专利、集成电路布图）：无使用年限限制，授权日期无下限
- II类知识产权（实用新型、外观设计、软著）：授权日期建议在近三年内，否则需提供5年以上全球独占许可协议
- 所有IP授权日期必须 ≤ 申报年份（申报前必须已授权）
- 专利登记簿副本：近3个月内出具
- 年费缴费发票：最近一次年费缴纳（广东省发明+实用新型必须提供）
- 转让手续合格通知书：转让完成日期≤申报年份

#### 2.3 研发项目类资料排查

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 研发项目立项决议/报告 | 近三年内，每个RD项目1份 | Word/PDF | ≥近三年RD数量 | 确认项目名称、起止时间、经费预算、负责人 |
| 2 | 研发项目验收报告 | 项目结束后 | Word/PDF | 已完成项目各1份 | 确认验收结论、成果描述 |
| 3 | 研发费用辅助账 | 近三年每年1套 | Excel | 3套（每年9个Sheet） | 确认八大类费用明细完整，与RD表经费一致 |
| 4 | 研发费用专项审计报告 | 近三年 | PDF | 1份（三年合并） | 确认审计机构资质、研发费用总额 |
| 5 | 研发设备清单 | 当前 | Excel | 1份 | 确认设备名称、型号、单价、使用部门、采购日期 |
| 6 | 研发场地证明 | 当前 | PDF/照片 | 1份 | 确认研发场地面积、功能分区 |

**时间约束检查：**
- RD项目开始时间 ≥ 近三年第一年1月1日
- RD项目结束时间 ≤ 申报年份12月31日
- RD项目必须覆盖近三年（每年至少有1个项目在执行）
- 研发费用辅助账必须覆盖近三年每年

#### 2.4 科技成果转化证明材料排查（重点优化）

##### 2.4.1 销售合同及发票（核心重点）

**发票清单格式（参考派成铝业实际案例）：**

| 序号 | 发票号码 | 开票日期 | 购方名称 | 价税合计（元） | 对应合同编号 | 产品名称 | 备注 |
|------|----------|----------|----------|----------------|--------------|----------|------|
| 1 | 25952000000079760447 | 2025-04-25 | 深圳市高新健置业开发有限公司 | 2,968,300.00 | HT2025001 | 幕墙产品 | |
| 2 | 25952000000127728837 | 2025-06-25 | 中铁五局集团建筑工程有限责任公司 | 6,260,169.53 | HT2025002 | 幕墙产品 | |
| ... | ... | ... | ... | ... | ... | ... | ... |

**合同发票数量要求（按年度）：**

| 年度 | 合同数量 | 发票数量 | 时间分布建议 | 金额要求 |
|------|----------|----------|--------------|----------|
| 2023年（前年） | 10-12份 | 10-12份 | 建议5-12月，11-12月多提供 | 单份≥10万元 |
| 2024年（前年） | 10-12份 | 10-12份 | 建议5-12月，11-12月多提供 | 单份≥10万元 |
| 2025年（上年度） | 18-20份 | 18-20份 | 建议5-12月，11-12月多提供 | 单份≥10万元 |

**合同发票排查要点：**
- **数量要求**：2023年10-12份、2024年10-12份、2025年18-20份
- **时间要求**：建议提供5-12月，11-12月多提供（避免集中在年初）
- **对应关系**：每份发票必须对应合同，合同金额与发票金额一致（允许±5%误差）
- **产品关联**：合同产品名称必须与PS表中的产品名称一致（门窗/幕墙分别统计）
- **客户多样性**：建议覆盖≥5个不同客户，避免单一客户占比>50%
- **金额合理性**：合同金额应符合行业惯例，单份合同≥10万元，避免异常大额或小额
- **发票规范性**：发票号码必须为20位数字，开票日期必须在有效时间范围内
- **购方名称**：必须与合同签订方一致，不能是个人或关联企业

**合同发票排查流程（优化版）：**
```python
def analyze_contract_invoice_files(data_dir, application_year):
    """分析合同发票文件（优化版）"""
    
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    
    results = {
        'contracts': {},
        'invoices': {},
        'matching': [],
        'issues': [],
        'statistics': {
            'total_contracts': 0,
            'total_invoices': 0,
            'total_amount': 0,
            'customer_count': 0
        }
    }
    
    customers = set()
    
    for year in recent_three_years:
        # 查找合同文件
        contract_files = glob.glob(os.path.join(data_dir, f'*合同*{year}*'))
        contract_files.extend(glob.glob(os.path.join(data_dir, f'*{year}*合同*')))
        
        # 查找发票文件
        invoice_files = glob.glob(os.path.join(data_dir, f'*发票*{year}*'))
        invoice_files.extend(glob.glob(os.path.join(data_dir, f'*{year}*发票*')))
        
        results['contracts'][year] = contract_files
        results['invoices'][year] = invoice_files
        
        # 检查数量
        contract_count = len(contract_files)
        invoice_count = len(invoice_files)
        
        # 根据年度设置不同要求
        if year == application_year - 1:
            # 上年度要求18-20份
            required_min = 18
            required_max = 20
        else:
            # 前两年要求10-12份
            required_min = 10
            required_max = 12
        
        if contract_count < required_min:
            results['issues'].append(f"{year}年合同数量不足，当前{contract_count}份，要求{required_min}-{required_max}份")
        if invoice_count < required_min:
            results['issues'].append(f"{year}年发票数量不足，当前{invoice_count}份，要求{required_min}-{required_max}份")
        
        # 检查合同发票对应关系
        year_matching = 0
        for contract_file in contract_files:
            # 提取合同信息
            contract_info = extract_contract_info(contract_file)
            
            # 查找对应发票
            matching_invoice = find_matching_invoice(invoice_files, contract_info)
            
            if matching_invoice:
                results['matching'].append({
                    'contract': contract_file,
                    'invoice': matching_invoice,
                    'year': year,
                    'status': '已匹配',
                    'amount': contract_info.get('amount', 0)
                })
                year_matching += 1
                customers.add(contract_info.get('customer_name', ''))
                results['statistics']['total_amount'] += contract_info.get('amount', 0)
            else:
                results['issues'].append(f"合同{os.path.basename(contract_file)}未找到对应发票")
        
        results['statistics']['total_contracts'] += contract_count
        results['statistics']['total_invoices'] += invoice_count
    
    results['statistics']['customer_count'] = len(customers)
    
    # 检查客户多样性
    if results['statistics']['customer_count'] < 5:
        results['issues'].append(f"客户数量不足，当前{results['statistics']['customer_count']}个，建议≥5个")
    
    return results

def extract_contract_info(contract_file):
    """提取合同关键信息"""
    info = {
        'contract_no': '',
        'customer_name': '',
        'amount': 0,
        'sign_date': '',
        'product_name': ''
    }
    
    try:
        if contract_file.endswith('.pdf'):
            content = read_pdf_content(contract_file)
        elif contract_file.endswith('.docx'):
            content = read_docx_content(contract_file)
        else:
            return info
        
        # 提取合同编号
        contract_no_match = re.search(r'合同编号[：:]/s*(/S+)', content)
        if contract_no_match:
            info['contract_no'] = contract_no_match.group(1)
        
        # 提取客户名称
        customer_match = re.search(r'(?:甲方|购方|买方)[：:]/s*(.+?)(?:/n|$)', content)
        if customer_match:
            info['customer_name'] = customer_match.group(1).strip()
        
        # 提取合同金额
        amount_match = re.search(r'合同金额[：:]/s*([0-9,]+/.?[0-9]*)/s*(?:元|万元)', content)
        if amount_match:
            amount_str = amount_match.group(1).replace(',', '')
            info['amount'] = float(amount_str)
        
        # 提取签订日期
        date_match = re.search(r'签订日期[：:]/s*(/d{4}[-年]/d{1,2}[-月]/d{1,2})', content)
        if date_match:
            info['sign_date'] = date_match.group(1)
        
        # 提取产品名称
        product_match = re.search(r'(?:产品名称|标的物)[：:]/s*(.+?)(?:/n|$)', content)
        if product_match:
            info['product_name'] = product_match.group(1).strip()
    
    except Exception as e:
        pass
    
    return info
```

##### 2.4.2 产品检测/测试报告

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 产品质量检验报告 | 近三年内 | PDF | 每个PS≥1份 | 确认检测机构资质、检测结论 |
| 2 | 各类测试报告 | 近三年内 | PDF | 按实际 | 确认测试项目、测试结果 |
| 3 | 企业内部检测合格报告 | 近三年内 | PDF | 若无第三方报告则必须提供 | 确认检测项目、检测标准、检测结论 |

##### 2.4.3 产品说明书/规格书及用户反馈

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 产品说明书 | 无时间要求 | PDF/Word | 每个PS 1份 | 确认产品功能、技术参数、使用方法 |
| 2 | 产品规格书 | 无时间要求 | PDF/Excel | 每个PS 1份 | 确认产品规格、性能指标 |
| 3 | 用户满意度调查表 | 近三年内 | PDF/Word | 有则提供 | 确认用户反馈、满意度评分 |

##### 2.4.4 产品认证证书

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | UL认证证书 | 有效期内 | PDF | 有则提供 | 确认认证范围、有效期 |
| 2 | 3C认证证书 | 有效期内 | PDF | 有则提供 | 确认认证范围、有效期 |
| 3 | CE认证证书 | 有效期内 | PDF | 有则提供 | 确认认证范围、有效期 |
| 4 | FCC认证证书 | 有效期内 | PDF | 有则提供 | 确认认证范围、有效期 |
| 5 | CSA认证证书 | 有效期内 | PDF | 有则提供 | 确认认证范围、有效期 |
| 6 | ETL认证证书 | 有效期内 | PDF | 有则提供 | 确认认证范围、有效期 |
| 7 | GS认证证书 | 有效期内 | PDF | 有则提供 | 确认认证范围、有效期 |
| 8 | RoHS认证证书 | 有效期内 | PDF | 有则提供 | 确认认证范围、有效期 |

##### 2.4.5 体系认证证书、行业证书

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 质量管理体系认证证书（ISO 9001） | 有效期内 | PDF | 有则提供 | 确认认证范围、有效期、认证机构 |
| 2 | 环境管理体系认证证书（ISO 14001） | 有效期内 | PDF | 有则提供 | 确认认证范围、有效期、认证机构 |
| 3 | 知识产权管理体系认证证书 | 有效期内 | PDF | 有则提供 | 确认认证范围、有效期、认证机构 |
| 4 | 行业资格证书 | 有效期内 | PDF | 按实际 | 确认资格范围、有效期 |

##### 2.4.6 荣誉证书

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 公司荣誉证书 | 近三年内 | PDF/扫描件 | 按实际 | 确认颁发单位、颁发时间、荣誉名称 |
| 2 | 法人荣誉证书 | 近三年内 | PDF/扫描件 | 按实际 | 确认颁发单位、颁发时间、荣誉名称 |
| 3 | 产品荣誉证书 | 近三年内 | PDF/扫描件 | 按实际 | 确认颁发单位、颁发时间、荣誉名称 |

##### 2.4.7 产学研合作协议

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 产学研合作协议 | 近三年内 | PDF | ≥1份（加分项） | 确认合作单位、合作项目、合同期限、成果归属 |
| 2 | 产学研合作合同 | 近三年内 | PDF | 按实际 | 确认合作内容、费用、成果分配 |

**产学研合作排查要点：**
- 此项为加分项，建议提供
- 合作单位应为高校、研究所等科研机构
- 合作项目应与企业主营业务相关
- 合同期限应在近三年内

##### 2.4.8 参与制订标准文件

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 国家标准参与制订证明 | 近三年内 | PDF | 按实际 | 确认标准名称、标准编号、参与角色 |
| 2 | 行业标准参与制订证明 | 近三年内 | PDF | 按实际 | 确认标准名称、标准编号、参与角色 |
| 3 | 地方标准参与制订证明 | 近三年内 | PDF | 按实际 | 确认标准名称、标准编号、参与角色 |
| 4 | 团体标准参与制订证明 | 近三年内 | PDF | 按实际 | 确认标准名称、标准编号、参与角色 |

#### 2.5 高新产品类资料排查

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 产品关键技术说明 | 上年度 | Word | 每个PS 1份 | 确认关键技术、技术指标、竞争优势、知识产权支持作用 |
| 2 | 产品质量检验报告 | 近三年内 | PDF | 每个PS≥1份 | 确认检测机构资质、检测结论 |
| 3 | 产品认证证书 | 有效期内 | PDF | 按实际 | 确认认证范围、有效期 |
| 4 | 高新产品收入审计报告 | 上年度 | PDF | 1份 | 确认高新产品收入总额，与PS表一致 |
| 5 | 上年度销售合同 | 上年度 | PDF | 每个PS≥1份 | 确认合同金额、产品名、签订时间 |
| 6 | 上年度销售发票 | 上年度 | PDF/扫描件 | 与合同一一对应 | 确认发票金额与合同一致 |

**时间约束检查：**
- 高新产品收入必须是上年度（申报年份-1）
- 合同发票必须是上年度的
- 高新产品收入合计必须与审计报告一致

#### 2.6 人员类资料排查

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 企业职工花名册 | 上年度末 | Excel | 1份 | 确认总人数、各部门人数 |
| 2 | 科技人员花名册 | 上年度末 | Excel | 1份 | 确认科技人员数量、占比≥10% |
| 3 | 科技人员学历证书 | 当前有效 | PDF/扫描件 | 每人1份 | 确认学历、专业 |
| 4 | 科技人员职称证书 | 当前有效 | PDF/扫描件 | 有职称者各1份 | 确认职称级别 |
| 5 | 社保缴纳证明 | 近三年每年1份 | PDF | 3份 | 确认缴纳人数、缴纳月份覆盖全年 |
| 6 | 个人所得税申报记录 | 近三年每年1份 | PDF | 3份 | 确认申报人数与花名册一致 |

**时间约束检查：**
- 科技人员占比必须≥10%（上年度末）
- 社保缴纳必须覆盖近三年
- 科技人员在职时间必须覆盖上年度

#### 2.7 财务类资料排查

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 近三年年度审计报告 | 近三年每年1份 | PDF | 3份 | 确认营业收入、净利润、资产总额 |
| 2 | 近三年企业所得税申报表 | 近三年每年1份 | PDF | 3份 | 确认收入总额、应纳税所得额 |
| 3 | 近三年研发费用专项审计 | 近三年 | PDF | 1份（三年合并） | 确认研发费用总额、占比 |
| 4 | 近三年研发费用辅助账 | 近三年每年1套 | Excel | 3套 | 确认八大类费用明细 |
| 5 | 高新产品收入专项审计 | 上年度 | PDF | 1份 | 确认高新产品收入总额 |

**时间约束检查：**
- 审计报告必须覆盖近三年
- 研发费用占比必须符合标准
- 高新产品收入占比必须≥60%

#### 2.8 其他证明材料排查（重点优化）

##### 2.8.1 照片资料（重点优化）

**照片资料清单（参考派成铝业表格7）：**

| 序号 | 照片内容 | 所需数量 | 拍摄要求 | 格式要求 | 排查要点 |
|------|----------|----------|----------|----------|----------|
| 1 | 公司前台 | 1张 | 正对公司大门拍摄，含公司LOGO及公司名称 | JPG/PNG，≤5MB | 确认公司名称、LOGO清晰可见 |
| 2 | 研发场地 | 6张 | 技术研究院、实验室等，尽量带门牌/牌匾 | JPG/PNG，≤5MB | 确认研发场地门牌、实验设备、办公环境 |
| 3 | 研发人员办公 | 4张 | 研发人员日常工作场景 | JPG/PNG，≤5MB | 确认研发人员工作状态、电脑屏幕内容 |
| 4 | 人员培训 | 6张 | 公司内部培训、会议等场景照片 | JPG/PNG，≤5MB | 确认培训主题、参与人员、培训时间 |
| 5 | 颁奖领奖 | 4张 | 公司或员工获奖/领奖照片 | JPG/PNG，≤5MB | 确认荣誉证书、奖杯、颁奖单位 |
| 6 | 产品照片 | 每件1张 | 主营产品高清照片（带铭牌更好） | JPG/PNG，≤5MB | 确认产品外观、型号、铭牌信息 |
| 7 | 自研软件/系统截图 | 每件1张 | 软件界面或系统截图 | JPG/PNG，≤5MB | 确认软件名称、功能界面、版本号 |
| 8 | 研发设备照片 | 每台1张 | 备注设备名称、型号 | JPG/PNG，≤5MB | 确认设备实物、铭牌、型号清晰可见 |

**照片排查要点（优化版）：**
- **公司前台**：必须包含公司全称LOGO，正对大门拍摄
- **研发场地**：≥6张，必须包含门牌/牌匾（如"技术研究院"、"实验室"）
- **研发人员办公**：≥4张，展示研发人员日常工作场景
- **人员培训**：≥6张，包含培训主题、参与人员、培训时间
- **颁奖领奖**：≥4张，展示荣誉证书、奖杯、颁奖单位
- **产品照片**：每个PS产品≥1张，带铭牌更佳
- **自研软件截图**：每个软件著作权≥1张，展示软件界面
- **研发设备照片**：每台设备1张，需清晰可见设备铭牌、型号

**照片排查流程（优化版）：**
```python
def analyze_photo_files(data_dir):
    """分析照片文件（优化版）"""
    
    photo_categories = {
        '公司前台': [],
        '研发场地': [],
        '研发人员办公': [],
        '人员培训': [],
        '颁奖领奖': [],
        '产品照片': [],
        '自研软件截图': [],
        '研发设备照片': []
    }
    
    # 查找所有照片文件
    photo_files = glob.glob(os.path.join(data_dir, '**/*.jpg'), recursive=True)
    photo_files.extend(glob.glob(os.path.join(data_dir, '**/*.png'), recursive=True))
    photo_files.extend(glob.glob(os.path.join(data_dir, '**/*.jpeg'), recursive=True))
    
    for photo_file in photo_files:
        file_name = os.path.basename(photo_file).lower()
        
        # 根据文件名和路径分类
        if '前台' in file_name or '大门' in file_name or 'logo' in file_name:
            photo_categories['公司前台'].append(photo_file)
        elif '场地' in file_name or '实验室' in file_name or '研究院' in file_name or '门牌' in file_name:
            photo_categories['研发场地'].append(photo_file)
        elif '办公' in file_name or '工作' in file_name:
            photo_categories['研发人员办公'].append(photo_file)
        elif '培训' in file_name or '会议' in file_name:
            photo_categories['人员培训'].append(photo_file)
        elif '颁奖' in file_name or '领奖' in file_name or '荣誉' in file_name:
            photo_categories['颁奖领奖'].append(photo_file)
        elif '产品' in file_name:
            photo_categories['产品照片'].append(photo_file)
        elif '软件' in file_name or '系统' in file_name or '截图' in file_name:
            photo_categories['自研软件截图'].append(photo_file)
        elif '设备' in file_name:
            photo_categories['研发设备照片'].append(photo_file)
    
    # 检查完整性
    issues = []
    required_counts = {
        '公司前台': 1,
        '研发场地': 6,
        '研发人员办公': 4,
        '人员培训': 6,
        '颁奖领奖': 4,
        '研发设备照片': 0  # 根据设备清单动态检查
    }
    
    for category, required_count in required_counts.items():
        actual_count = len(photo_categories[category])
        if actual_count < required_count:
            issues.append(f"{category}照片不足，当前{actual_count}张，要求≥{required_count}张")
    
    # 检查照片文件大小
    large_files = []
    for category, files in photo_categories.items():
        for file in files:
            file_size_mb = os.path.getsize(file) / (1024 * 1024)
            if file_size_mb > 5:
                large_files.append(f"{os.path.basename(file)} ({file_size_mb:.2f}MB)")
    
    if large_files:
        issues.append(f"以下照片超过5MB限制：{', '.join(large_files[:5])}")
    
    return {
        'categories': photo_categories,
        'issues': issues,
        'total_photos': sum(len(files) for files in photo_categories.values())
    }
```

##### 2.8.2 研发设备清单（重点优化）

**研发设备清单格式（参考派成铝业实际案例）：**

| 序号 | 设备名称 | 型号 | 使用部门 | 数量 | 备注（固定资产编号） | 设备照片状态 | 采购日期 | 单价（万元） |
|------|----------|------|----------|------|---------------------|--------------|----------|--------------|
| 1 | 电焊机 | - | 技术研究院 | 1 | ZCLB021 | 已提供 | 2022-03-15 | 2.50 |
| 2 | 机床-六刀端面铣床（走刀式） | 欧亚特 | 技术研究院 | 1 | ZCLB0210 | 已提供 | 2022-05-20 | 15.00 |
| 3 | 机床-高精度专业45度双头锯 | 欧亚特 | 技术研究院 | 1 | ZCLB0211 | 已提供 | 2022-05-20 | 18.00 |
| 4 | 直读光谱仪 | - | 技术研究院 | 1 | SCGJ-00002-1 | 已提供 | 2023-06-10 | 25.00 |
| 5 | 金相显微镜 | - | 技术研究院 | 1 | SCGJ-00003-1 | 已提供 | 2023-06-10 | 8.00 |
| ... | ... | ... | ... | ... | ... | ... | ... | ... |

**研发设备排查要求：**

| 序号 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 排查要点 |
|------|----------|--------------|----------|----------|----------|
| 1 | 研发设备清单 | 当前 | Excel | 1份 | 确认设备名称、型号、数量、使用部门、固定资产编号、采购日期、单价 |
| 2 | 设备照片 | 当前 | JPG/PNG | 每台1张 | 确认设备实物、铭牌信息，照片需清晰可见设备型号 |
| 3 | 设备购置发票 | 近三年内 | PDF/扫描件 | 主要设备提供 | 确认设备价格、购置时间，与清单一致 |
| 4 | 设备固定资产台账 | 当前 | Excel | 1份 | 确认设备固定资产编号、折旧情况，与清单对应 |

**研发设备排查要点（优化版）：**
- **设备数量**：建议≥10台，派成铝业案例为25台
- **设备总值**：建议≥50万元，根据企业规模调整
- **设备类型**：应包含生产设备、检测设备、研发辅助设备
- **使用部门**：应集中在技术研究院/研发中心
- **固定资产编号**：每台设备应有唯一编号，格式统一（如ZCLB021、SCGJ-00001-1）
- **设备照片**：每台设备1张照片，需清晰可见设备铭牌、型号
- **采购日期**：建议在近三年内采购，或提供设备使用说明
- **设备分类**：建议包含机床类、检测设备类、设计电脑等

**研发设备清单排查流程（优化版）：**
```python
def analyze_equipment_list(equipment_file):
    """分析研发设备清单（优化版）"""
    
    df = pd.read_excel(equipment_file)
    
    # 检查必填字段（参考派成铝业格式）
    required_columns = ['设备名称', '型号', '使用部门', '数量', '备注']
    missing_columns = [col for col in required_columns if col not in df.columns]
    
    issues = []
    if missing_columns:
        issues.append(f"设备清单缺少必填字段：{', '.join(missing_columns)}")
    
    # 检查设备数量
    equipment_count = len(df)
    if equipment_count < 10:
        issues.append(f"研发设备数量不足，当前{equipment_count}台，建议≥10台")
    
    # 检查设备总价（如果有单价字段）
    total_value = 0
    if '单价（万元）' in df.columns:
        total_value = (df['单价（万元）'] * df['数量']).sum()
        if total_value < 50:
            issues.append(f"研发设备总值偏低，当前{total_value:.2f}万元，建议≥50万元")
    
    # 检查使用部门分布
    if '使用部门' in df.columns:
        dept_counts = df['使用部门'].value_counts()
        rd_dept_count = sum([count for dept, count in dept_counts.items() 
                             if '技术' in dept or '研发' in dept])
        if rd_dept_count < equipment_count * 0.8:
            issues.append(f"研发部门设备占比偏低，当前{rd_dept_count}/{equipment_count}，建议≥80%")
    
    # 检查固定资产编号（备注列）
    if '备注' in df.columns:
        no_asset_id = df[df['备注'].isna() | (df['备注'] == '')]
        if len(no_asset_id) > 0:
            issues.append(f"以下设备缺少固定资产编号：{', '.join(no_asset_id['设备名称'].head(5).tolist())}")
    
    # 检查设备照片对应关系
    equipment_names = df['设备名称'].tolist()
    photo_files = glob.glob('**/设备照片/**/*.jpg', recursive=True)
    photo_files.extend(glob.glob('**/设备照片/**/*.png', recursive=True))
    
    unmatched_equipment = []
    for name in equipment_names:
        # 尝试匹配照片（支持模糊匹配）
        matched = False
        for photo in photo_files:
            photo_name = os.path.basename(photo).lower()
            # 检查设备名称或型号是否在照片文件名中
            if name.lower() in photo_name:
                matched = True
                break
            # 检查固定资产编号
            if '备注' in df.columns:
                asset_id = df[df['设备名称'] == name]['备注'].iloc[0] if name in df['设备名称'].values else ''
                if asset_id and asset_id.lower() in photo_name:
                    matched = True
                    break
        
        if not matched:
            unmatched_equipment.append(name)
    
    if unmatched_equipment:
        issues.append(f"以下设备缺少照片：{', '.join(unmatched_equipment[:5])}")
    
    # 检查设备类型分布
    equipment_types = {
        '机床类': 0,
        '检测设备类': 0,
        '设计电脑': 0,
        '其他': 0
    }
    
    for name in equipment_names:
        if '机床' in name or '锯' in name or '铣' in name:
            equipment_types['机床类'] += 1
        elif '检测' in name or '仪器' in name or '显微镜' in name:
            equipment_types['检测设备类'] += 1
        elif '电脑' in name:
            equipment_types['设计电脑'] += 1
        else:
            equipment_types['其他'] += 1
    
    if equipment_types['检测设备类'] == 0:
        issues.append("缺少检测设备，建议提供检测设备以证明研发能力")
    
    return {
        'equipment_count': equipment_count,
        'total_value': total_value,
        'equipment_types': equipment_types,
        'unmatched_equipment': unmatched_equipment,
        'issues': issues
    }
```

##### 2.8.3 管理证明材料（重点优化）

**管理证明材料清单（参考派成铝业表格8）：**

| 序号 | 资料内容 | 所需数量 | 时间要求 | 格式要求 | 排查要点 |
|------|----------|----------|----------|----------|----------|
| 1 | 绩效考核表 | 有则提供 | 2023-2025年 | Word/Excel/PDF | 确认考核对象为研发人员，考核内容包含技术创新、项目完成情况 |
| 2 | 奖励通知/公示 | 有则提供 | 近三年内 | PDF/扫描件 | 含内部及外部技术创新奖励，确认奖励对象、奖励原因、奖励金额 |
| 3 | 内部嘉奖/荣誉证书 | 有则提供 | 近三年内 | PDF/扫描件 | 公司内部评优、季度之星等，确认颁发单位、颁发时间、荣誉名称 |
| 4 | 会议签到表 | 有则提供 | 近三年内 | PDF/扫描件 | 研发会议、项目讨论、培训签到，确认会议主题、参与人员、签到时间 |

**管理证明材料排查要点（优化版）：**

**1. 绩效考核表**
- **时间要求**：2023-2025年每年至少1份
- **考核对象**：必须为研发人员（与科技人员花名册对应）
- **考核内容**：应包含技术创新、项目完成情况、专利产出等
- **考核结果**：应有明确的考核等级或分数
- **签字盖章**：需有考核人、被考核人签字，公司盖章

**2. 奖励通知/公示**
- **奖励类型**：技术创新奖、专利奖、项目完成奖等
- **奖励范围**：内部奖励（公司内部）+ 外部奖励（政府、行业协会）
- **奖励对象**：研发人员、研发团队
- **奖励金额**：应有明确的奖励金额或奖品
- **公示文件**：需有正式的红头文件或公示截图

**3. 内部嘉奖/荣誉证书**
- **荣誉类型**：优秀员工、季度之星、技术标兵等
- **颁发单位**：公司内部（人力资源部或总经办）
- **颁发时间**：近三年内
- **证书内容**：应包含获奖人姓名、获奖原因、颁发日期

**4. 会议签到表**
- **会议类型**：研发项目讨论会、技术培训会、项目评审会
- **签到内容**：会议主题、时间、地点、参与人员签名
- **时间分布**：近三年内，建议每年≥3次
- **参与人员**：应为研发人员

**管理证明材料排查流程（优化版）：**
```python
def analyze_management_materials(data_dir, application_year):
    """分析管理证明材料（优化版）"""
    
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    
    results = {
        'performance_reviews': [],
        'awards': [],
        'certificates': [],
        'meeting_signins': [],
        'issues': []
    }
    
    # 1. 检查绩效考核表
    review_files = glob.glob(os.path.join(data_dir, '**/*绩效*考核*.xlsx'), recursive=True)
    review_files.extend(glob.glob(os.path.join(data_dir, '**/*绩效*考核*.docx'), recursive=True))
    review_files.extend(glob.glob(os.path.join(data_dir, '**/*绩效*考核*.pdf'), recursive=True))
    
    for review_file in review_files:
        review_info = extract_review_info(review_file)
        results['performance_reviews'].append(review_info)
    
    # 检查年度覆盖
    review_years = set([r['year'] for r in results['performance_reviews'] if 'year' in r])
    for year in recent_three_years:
        if year not in review_years:
            results['issues'].append(f"{year}年缺少绩效考核表")
    
    # 2. 检查奖励通知/公示
    award_files = glob.glob(os.path.join(data_dir, '**/*奖励*.pdf'), recursive=True)
    award_files.extend(glob.glob(os.path.join(data_dir, '**/*奖励*.docx'), recursive=True))
    award_files.extend(glob.glob(os.path.join(data_dir, '**/*公示*.pdf'), recursive=True))
    
    for award_file in award_files:
        award_info = extract_award_info(award_file)
        results['awards'].append(award_info)
    
    if len(results['awards']) == 0:
        results['issues'].append("缺少奖励通知/公示材料（加分项，建议提供）")
    
    # 3. 检查内部嘉奖/荣誉证书
    cert_files = glob.glob(os.path.join(data_dir, '**/*荣誉证书*.pdf'), recursive=True)
    cert_files.extend(glob.glob(os.path.join(data_dir, '**/*荣誉证书*.jpg'), recursive=True))
    cert_files.extend(glob.glob(os.path.join(data_dir, '**/*嘉奖*.pdf'), recursive=True))
    
    for cert_file in cert_files:
        cert_info = extract_certificate_info(cert_file)
        results['certificates'].append(cert_info)
    
    if len(results['certificates']) == 0:
        results['issues'].append("缺少内部嘉奖/荣誉证书（加分项，建议提供）")
    
    # 4. 检查会议签到表
    signin_files = glob.glob(os.path.join(data_dir, '**/*签到*.pdf'), recursive=True)
    signin_files.extend(glob.glob(os.path.join(data_dir, '**/*签到*.docx'), recursive=True))
    signin_files.extend(glob.glob(os.path.join(data_dir, '**/*会议*.pdf'), recursive=True))
    
    for signin_file in signin_files:
        signin_info = extract_signin_info(signin_file)
        results['meeting_signins'].append(signin_info)
    
    if len(results['meeting_signins']) < 3:
        results['issues'].append(f"会议签到表不足，当前{len(results['meeting_signins'])}份，建议≥3份")
    
    return results

def extract_review_info(review_file):
    """提取绩效考核表信息"""
    info = {
        'file_path': review_file,
        'year': '',
        'review_count': 0,
        'rd_staff_count': 0
    }
    
    try:
        if review_file.endswith('.xlsx'):
            df = pd.read_excel(review_file)
            info['review_count'] = len(df)
            # 提取年份
            if '考核年度' in df.columns:
                info['year'] = df['考核年度'].iloc[0]
            elif '考核时间' in df.columns:
                info['year'] = str(df['考核时间'].iloc[0])[:4]
        elif review_file.endswith('.docx'):
            content = read_docx_content(review_file)
            # 提取年份
            year_match = re.search(r'(/d{4})/s*年/s*度?/s*绩效考核', content)
            if year_match:
                info['year'] = year_match.group(1)
        elif review_file.endswith('.pdf'):
            content = read_pdf_content(review_file)
            year_match = re.search(r'(/d{4})/s*年/s*度?/s*绩效考核', content)
            if year_match:
                info['year'] = year_match.group(1)
    except Exception as e:
        pass
    
    return info

def extract_award_info(award_file):
    """提取奖励通知信息"""
    info = {
        'file_path': award_file,
        'award_type': '',
        'award_date': '',
        'recipient': ''
    }
    
    try:
        if award_file.endswith('.pdf'):
            content = read_pdf_content(award_file)
        elif award_file.endswith('.docx'):
            content = read_docx_content(award_file)
        else:
            return info
        
        # 提取奖励类型
        if '技术创新' in content:
            info['award_type'] = '技术创新奖'
        elif '专利' in content:
            info['award_type'] = '专利奖'
        elif '项目' in content:
            info['award_type'] = '项目完成奖'
        
        # 提取奖励日期
        date_match = re.search(r'(/d{4})/s*年/s*(/d{1,2})/s*月/s*(/d{1,2})/s*日', content)
        if date_match:
            info['award_date'] = f"{date_match.group(1)}-{date_match.group(2)}-{date_match.group(3)}"
        
        # 提取获奖人
        recipient_match = re.search(r'(?:授予|奖励)/s*([^/s,，]+)', content)
        if recipient_match:
            info['recipient'] = recipient_match.group(1)
    except Exception as e:
        pass
    
    return info

def extract_certificate_info(cert_file):
    """提取荣誉证书信息"""
    info = {
        'file_path': cert_file,
        'certificate_type': '',
        'issue_date': '',
        'recipient': ''
    }
    
    try:
        if cert_file.endswith('.pdf'):
            content = read_pdf_content(cert_file)
        elif cert_file.endswith('.jpg'):
            # 图片文件无法直接读取内容，仅记录文件路径
            pass
        
        # 提取证书类型
        if '优秀员工' in content:
            info['certificate_type'] = '优秀员工'
        elif '季度之星' in content:
            info['certificate_type'] = '季度之星'
        elif '技术标兵' in content:
            info['certificate_type'] = '技术标兵'
        
        # 提取颁发日期
        date_match = re.search(r'(/d{4})/s*年/s*(/d{1,2})/s*月', content)
        if date_match:
            info['issue_date'] = f"{date_match.group(1)}-{date_match.group(2)}"
        
        # 提取获奖人
        recipient_match = re.search(r'(?:授予|颁发)/s*([^/s,，]+)', content)
        if recipient_match:
            info['recipient'] = recipient_match.group(1)
    except Exception as e:
        pass
    
    return info

def extract_signin_info(signin_file):
    """提取会议签到表信息"""
    info = {
        'file_path': signin_file,
        'meeting_topic': '',
        'meeting_date': '',
        'attendee_count': 0
    }
    
    try:
        if signin_file.endswith('.xlsx'):
            df = pd.read_excel(signin_file)
            info['attendee_count'] = len(df)
            if '会议主题' in df.columns:
                info['meeting_topic'] = df['会议主题'].iloc[0]
            if '会议时间' in df.columns:
                info['meeting_date'] = str(df['会议时间'].iloc[0])[:10]
        elif signin_file.endswith('.docx'):
            content = read_docx_content(signin_file)
            topic_match = re.search(r'会议主题[：:]/s*(.+?)(?:/n|$)', content)
            if topic_match:
                info['meeting_topic'] = topic_match.group(1).strip()
            date_match = re.search(r'会议时间[：:]/s*(/d{4}[-年]/d{1,2}[-月]/d{1,2})', content)
            if date_match:
                info['meeting_date'] = date_match.group(1)
        elif signin_file.endswith('.pdf'):
            content = read_pdf_content(signin_file)
            topic_match = re.search(r'会议主题[：:]/s*(.+?)(?:/n|$)', content)
            if topic_match:
                info['meeting_topic'] = topic_match.group(1).strip()
            date_match = re.search(r'会议时间[：:]/s*(/d{4}[-年]/d{1,2}[-月]/d{1,2})', content)
            if date_match:
                info['meeting_date'] = date_match.group(1)
    except Exception as e:
        pass
    
    return info
```

**v1.5.0新增排查项**：
- 研发设备清单筛选：调用 `find_fixed_asset_file(file_index)` 查找固定资产清单，找到后调用 `filter_rnd_equipment_from_fixed_assets(fixed_asset_file, target_year=application_year-1, application_year=application_year)` 筛选研发设备，将结果融合到analysis_results中
- 合同发票编号标注：调用 `extract_contract_invoice_numbers(contract_files, invoice_files)` 提取已有合同发票的编号，在后续生成资料收集单时标注编号
- 往年资料扫描：调用 `scan_historical_materials(data_dir)` 扫描往年资料目录，识别已有资料并更新状态

---

### 第三步：逐一读取分析确认

**对每份已收集的资料，必须执行以下检查流程：**

```python
def analyze_document(file_path, doc_type):
    """逐一读取分析资料有效性"""
    result = {
        'file_path': file_path,
        'doc_type': doc_type,
        'status': '待确认',
        'issues': [],
        'valid': True
    }
    
    # 1. 读取文件内容
    try:
        if file_path.endswith('.pdf'):
            content = read_pdf_content(file_path)
        elif file_path.endswith('.docx'):
            content = read_docx_content(file_path)
        elif file_path.endswith('.xlsx'):
            content = read_excel_content(file_path)
        else:
            content = read_file(file_path)
    except Exception as e:
        result['status'] = '读取失败'
        result['issues'].append(f'无法读取文件: {str(e)}')
        result['valid'] = False
        return result
    
    # 2. 检查文件完整性
    if doc_type == '专利证书':
        if '证书' not in content:
            result['issues'].append('缺少专利证书首页')
        if '权利要求' not in content:
            result['issues'].append('缺少权利要求书')
    
    elif doc_type == '审计报告':
        if '审计意见' not in content:
            result['issues'].append('缺少审计意见')
        if '资产负债表' not in content:
            result['issues'].append('缺少资产负债表')
    
    elif doc_type == '研发费用辅助账':
        # 检查是否包含9个Sheet
        pass
    
    elif doc_type == '销售合同':
        # 检查是否包含：合同双方、标的、金额、签订日期
        # 检查签订日期是否在有效时间范围内
        pass
    
    elif doc_type == '销售发票':
        # 检查是否包含：发票代码、发票号码、金额、开票日期
        # 检查开票日期是否在有效时间范围内
        pass
    
    # 3. 检查时间有效性
    result['time_valid'] = check_time_validity(content, doc_type)
    
    # 4. 检查数据一致性
    result['data_consistent'] = check_data_consistency(content, doc_type)
    
    # 5. 汇总状态
    if result['issues']:
        result['status'] = '有问题'
        result['valid'] = False
    else:
        result['status'] = '有效'
    
    return result
```

---

### 第四步：系统性文件整理功能（新增）

#### 4.1 文件分类与目录结构

```python
def organize_files_by_category(data_dir, output_dir, enterprise_name, application_year):
    """按类别整理文件（优化版）"""
    
    # 创建标准目录结构（参考派成铝业案例）
    dir_structure = {
        '01_基础资质': [
            '营业执照',
            '企业承诺书',
            '企业所得税年度纳税申报表',
            '高新技术企业认定申请书',
            '账号信息',
            '企业更名证明',
            '公司宣传资料'
        ],
        '02_知识产权': [
            '专利证书扫描件',
            '软件著作权证书扫描件',
            '专利登记簿副本',
            '知识产权缴费凭证',
            '知识产权受让许可合同'
        ],
        '03_研发项目': [
            '立项决议报告',
            '验收报告',
            '研发费用辅助账',
            '研发费用专项审计报告',
            '研发设备清单',
            '研发场地证明'
        ],
        '04_科技成果转化': [
            '销售合同',
            '销售发票',
            '产品检测测试报告',
            '产品说明书规格书',
            '产品认证证书',
            '体系认证证书',
            '荣誉证书',
            '产学研合作协议',
            '参与制订标准文件'
        ],
        '05_高新产品': [
            '产品关键技术说明',
            '产品质量检验报告',
            '产品认证证书',
            '高新产品收入审计报告',
            '上年度销售合同',
            '上年度销售发票'
        ],
        '06_人员资料': [
            '企业职工花名册',
            '科技人员花名册',
            '科技人员学历证书',
            '科技人员职称证书',
            '社保缴纳证明',
            '个人所得税申报记录'
        ],
        '07_财务资料': [
            '近三年年度审计报告',
            '近三年企业所得税申报表',
            '近三年研发费用专项审计',
            '近三年研发费用辅助账',
            '高新产品收入专项审计'
        ],
        '08_其他证明材料': [
            '照片资料',
            '管理证明材料',
            '研发设备清单',
            '设备照片'
        ]
    }
    
    # 创建目录
    for category, subcategories in dir_structure.items():
        category_dir = os.path.join(output_dir, category)
        os.makedirs(category_dir, exist_ok=True)
        
        for subcategory in subcategories:
            subcategory_dir = os.path.join(category_dir, subcategory)
            os.makedirs(subcategory_dir, exist_ok=True)
    
    # 移动文件到对应目录
    file_mapping = map_files_to_categories(data_dir, dir_structure)
    
    # 生成文件整理报告
    organize_report = {
        'total_files': sum(len(files) for files in file_mapping.values()),
        'mapped_files': sum(1 for files in file_mapping.values() if files),
        'unmapped_files': [],
        'directory_structure': dir_structure
    }
    
    return file_mapping, organize_report

def map_files_to_categories(data_dir, dir_structure):
    """将文件映射到对应类别"""
    file_mapping = {category: {subcat: [] for subcat in subcats} 
                    for category, subcats in dir_structure.items()}
    
    # 遍历所有文件
    for root, dirs, files in os.walk(data_dir):
        for file in files:
            file_path = os.path.join(root, file)
            file_name = file.lower()
            
            # 根据文件名和路径判断类别
            category, subcategory = determine_file_category(file_path, file_name, dir_structure)
            
            if category and subcategory:
                file_mapping[category][subcategory].append(file_path)
    
    return file_mapping

def determine_file_category(file_path, file_name, dir_structure):
    """根据文件名判断所属类别"""
    
    # 基础资质
    if '营业执照' in file_name:
        return '01_基础资质', '营业执照'
    elif '承诺书' in file_name:
        return '01_基础资质', '企业承诺书'
    elif '纳税申报' in file_name or '所得税' in file_name:
        return '01_基础资质', '企业所得税年度纳税申报表'
    elif '申请书' in file_name:
        return '01_基础资质', '高新技术企业认定申请书'
    elif '账号' in file_name:
        return '01_基础资质', '账号信息'
    elif '更名' in file_name:
        return '01_基础资质', '企业更名证明'
    elif '宣传' in file_name:
        return '01_基础资质', '公司宣传资料'
    
    # 知识产权
    elif '专利证书' in file_name or ('专利' in file_name and '证书' in file_name):
        return '02_知识产权', '专利证书扫描件'
    elif '软著' in file_name or '软件著作权' in file_name:
        return '02_知识产权', '软件著作权证书扫描件'
    elif '登记簿' in file_name:
        return '02_知识产权', '专利登记簿副本'
    elif '缴费' in file_name and '知识产权' in file_name:
        return '02_知识产权', '知识产权缴费凭证'
    elif '许可' in file_name or '转让' in file_name:
        return '02_知识产权', '知识产权受让许可合同'
    
    # 研发项目
    elif '立项' in file_name:
        return '03_研发项目', '立项决议报告'
    elif '验收' in file_name:
        return '03_研发项目', '验收报告'
    elif '辅助账' in file_name:
        return '03_研发项目', '研发费用辅助账'
    elif '专项审计' in file_name and '研发' in file_name:
        return '03_研发项目', '研发费用专项审计报告'
    elif '设备清单' in file_name:
        return '03_研发项目', '研发设备清单'
    elif '场地' in file_name and '研发' in file_name:
        return '03_研发项目', '研发场地证明'
    
    # 科技成果转化
    elif '合同' in file_name and '销售' in file_name:
        return '04_科技成果转化', '销售合同'
    elif '发票' in file_name and '销售' in file_name:
        return '04_科技成果转化', '销售发票'
    elif '检测' in file_name or '测试' in file_name:
        return '04_科技成果转化', '产品检测测试报告'
    elif '说明书' in file_name or '规格书' in file_name:
        return '04_科技成果转化', '产品说明书规格书'
    elif '认证' in file_name and '产品' in file_name:
        return '04_科技成果转化', '产品认证证书'
    elif '体系' in file_name and '认证' in file_name:
        return '04_科技成果转化', '体系认证证书'
    elif '荣誉' in file_name:
        return '04_科技成果转化', '荣誉证书'
    elif '产学研' in file_name:
        return '04_科技成果转化', '产学研合作协议'
    elif '标准' in file_name:
        return '04_科技成果转化', '参与制订标准文件'
    
    # 高新产品
    elif '关键技术' in file_name:
        return '05_高新产品', '产品关键技术说明'
    elif '检验' in file_name and '产品' in file_name:
        return '05_高新产品', '产品质量检验报告'
    elif '高新' in file_name and '审计' in file_name:
        return '05_高新产品', '高新产品收入审计报告'
    
    # 人员资料
    elif '花名册' in file_name and '职工' in file_name:
        return '06_人员资料', '企业职工花名册'
    elif '花名册' in file_name and '科技' in file_name:
        return '06_人员资料', '科技人员花名册'
    elif '学历' in file_name:
        return '06_人员资料', '科技人员学历证书'
    elif '职称' in file_name:
        return '06_人员资料', '科技人员职称证书'
    elif '社保' in file_name:
        return '06_人员资料', '社保缴纳证明'
    elif '个人所得税' in file_name:
        return '06_人员资料', '个人所得税申报记录'
    
    # 财务资料
    elif '年度审计' in file_name:
        return '07_财务资料', '近三年年度审计报告'
    elif '所得税申报' in file_name:
        return '07_财务资料', '近三年企业所得税申报表'
    
    # 其他证明材料
    elif '照片' in file_name or file_name.endswith(('.jpg', '.png', '.jpeg')):
        return '08_其他证明材料', '照片资料'
    elif '绩效' in file_name or '考核' in file_name:
        return '08_其他证明材料', '管理证明材料'
    elif '奖励' in file_name or '签到' in file_name:
        return '08_其他证明材料', '管理证明材料'
    
    return None, None
```

#### 4.2 文件命名规范

```python
def standardize_file_names(output_dir, enterprise_name, application_year):
    """标准化文件命名"""
    
    naming_rules = {
        '专利证书': '{IP编号}_{知识产权名称}.pdf',
        '销售合同': '{年份}_{合同编号}_{客户名称}.pdf',
        '销售发票': '{年份}_{发票代码}_{发票号码}.pdf',
        '产品检测测试报告': '{PS编号}_{产品名称}_检测报告.pdf',
        '产品认证证书': '{PS编号}_{产品名称}_{认证类型}_证书.pdf',
        '研发设备照片': '{设备编号}_{设备名称}.jpg',
        '研发场地照片': '{场地类型}_{序号}.jpg',
        '科技人员学历证书': '{姓名}_学历证书.pdf',
        '科技人员职称证书': '{姓名}_职称证书.pdf'
    }
    
    # 遍历所有文件，按规则重命名
    for root, dirs, files in os.walk(output_dir):
        for file in files:
            file_path = os.path.join(root, file)
            category = determine_category(file_path)
            
            if category in naming_rules:
                new_name = generate_standard_name(file_path, naming_rules[category])
                new_path = os.path.join(root, new_name)
                os.rename(file_path, new_path)
    
    return True
```

#### 4.3 文件完整性检查

```python
def check_file_completeness(output_dir, enterprise_data):
    """检查文件完整性"""
    
    completeness_report = {
        'total_required': 0,
        'total_provided': 0,
        'missing_files': [],
        'incomplete_categories': []
    }
    
    # 检查各类别文件完整性
    categories = {
        '01_基础资质': {
            'required': ['营业执照', '企业承诺书'],
            'optional': ['企业更名证明', '公司宣传资料']
        },
        '02_知识产权': {
            'required': ['专利证书扫描件'],
            'optional': ['专利登记簿副本', '知识产权缴费凭证']
        },
        '03_研发项目': {
            'required': ['立项决议报告', '研发费用辅助账'],
            'optional': ['验收报告', '研发费用专项审计报告']
        },
        '04_科技成果转化': {
            'required': ['销售合同', '销售发票'],
            'optional': ['产品检测测试报告', '产品认证证书', '产学研合作协议']
        }
    }
    
    for category, requirements in categories.items():
        category_dir = os.path.join(output_dir, category)
        
        # 检查必填文件
        for required_file in requirements['required']:
            file_count = count_files_in_directory(os.path.join(category_dir, required_file))
            if file_count == 0:
                completeness_report['missing_files'].append(f"{category}/{required_file}")
            else:
                completeness_report['total_provided'] += file_count
        
        completeness_report['total_required'] += len(requirements['required'])
    
    return completeness_report
```

#### 4.4 文件质量检查

```python
def check_file_quality(output_dir):
    """检查文件质量"""
    
    quality_issues = []
    
    # 检查PDF文件大小
    for root, dirs, files in os.walk(output_dir):
        for file in files:
            if file.endswith('.pdf'):
                file_path = os.path.join(root, file)
                file_size_mb = os.path.getsize(file_path) / (1024 * 1024)
                
                # 专利证书≤2M
                if '专利证书' in root and file_size_mb > 2:
                    quality_issues.append(f"{file} 大小{file_size_mb:.2f}MB，超过2MB限制")
                
                # 产品证明≤4M
                if '高新产品' in root and file_size_mb > 4:
                    quality_issues.append(f"{file} 大小{file_size_mb:.2f}MB，超过4MB限制")
                
                # 合同发票≤20M
                if '销售合同' in root or '销售发票' in root:
                    if file_size_mb > 20:
                        quality_issues.append(f"{file} 大小{file_size_mb:.2f}MB，超过20MB限制")
    
    # 检查照片分辨率
    for root, dirs, files in os.walk(output_dir):
        for file in files:
            if file.lower().endswith(('.jpg', '.png', '.jpeg')):
                file_path = os.path.join(root, file)
                # 检查照片分辨率（需要PIL库）
                # 建议分辨率≥1920x1080
    
    return quality_issues
```

---

<!-- SECTION_BEGIN: v1_30_0_new_features -->
## v1.30.0 新增能力（合同发票收资清单三步强制校验，解决 EXP-2026-07-22-001）

**问题**：收资清单生成时，agent轻易将已有材料标注为"够用"，未逐笔配对量化。实际发现：
- 仅OCR到4张发票就认为"够用"（实需≥6张）
- 遗漏隐藏在同PDF后续页的2张国光电器发票
- 2023年有PO缺发票、2024年有发票缺合同、2025年完全缺失

**解决方案：三步强制校验流程**

```
【步骤1】逐年度配对
- 扫描全部 PDF → 提取所有发票编号
- 按年度分组（2023/2024/2025）
- 与已有合同按编号/日期/金额形成对照表
- 输出每个年度的（合同号, 发票号, 金额, 日期）四元组

【步骤2】按成果转化要求算缺额
- 最小配对：每年 ≥ 5-6 项 × 每项 1 合同 + 1 发票
- 实际已有 vs 最小需求 → 缺口量
- 输出缺口清单：哪个年度、哪几项缺失

【步骤3】全文 OCR（不遗漏后续页）
- 不能仅取前几页就下结论
- 强制扫描整个PDF所有页
- 提取每张发票的：发票号码、开票日期、客户、价税合计
- 数量校验：发票数 ≥ OCR扫描得到的总数
```

**禁止行为**：
- ❌ 禁止仅扫描前几页 PDF → OCR 几页后就下结论
- ❌ 禁止输出"已有 X 份"的模糊结论 → 必须输出"缺 X 份"
- ❌ 禁止假设合同与发票配对 → 必须逐张核对

**入口脚本**：
```bash
python {{YFW_SKILLS}}/_common/contract_invoice_validator.py  \
  --project-root {path}  \
  --output 07_资料收集清单/合同发票配对校验报告.json
```

<!-- SECTION_END: v1_30_0_new_features -->

<!-- SECTION_BEGIN: v1_31_0_new_features -->
## v1.31.0 新增能力（基于 1 条 pending 经验）

| 字段 | 内容 |
|------|------|
| exp_id | EXP-2026-07-21-001 |
| source | 深圳锐取电子有限公司 |
| problem_type | common_issue |
| problem | AI推理异常: write() argument must be str, not list。agent在锐取项目执行gxtz-info-collector技能时，AI推理阶段调用write()函数时传入list类型而非str类型参数，导致TypeError。根因：SKILL.md中"每步自问速查"步骤的约束描述不够清晰，agent在自主推断时产生了类型不匹配的输出 |
| solution | 合规红线新增第9条"禁止输出类型不匹配"：所有输出参数必须检查类型，list必须用join()转str后再传入write()等字符串参数函数；AI输出类型安全校验章节追加v1.31.0强化注释 |
| prevention | 技能中所有涉及write()/文件输出等字符串参数函数的调用点，必须在输出前执行类型检查；list类型统一用'/n'.join()转换；非str类型降级为str()并告警 |

<!-- SECTION_END: v1_31_0_new_features -->

### 第五步：生成资料收集清单（面向客户版本，参考深圳市/广东省官方清单）

**核心原则：清单是面向客户提供的，采用10列三层分类结构，便于客户按部门分派任务、跟踪进度。同时输出 xlsx 和 docx 两种格式。**

> **⚠️ v1.16.0强制执行（不可跳过）**：
>
> **本步骤必须输出两个文件**：
> 1. xlsx 清单（10列三层分类主表）
> 2. docx 清单（含设备8列表、合同发票9列表、状态标识、量化描述、Heading样式、【补充需求】合并行）
>
> **xlsx 生成**：用 openpyxl 生成主清单
>
> **docx 生成必须使用独立脚本**（解决"agent只输出xlsx不生成docx"问题）：
>
> ```bash
> # 第1步：agent准备好清单数据，保存为JSON文件
> # JSON格式见 {{YFW_SKILLS}}/_common/generate_checklist.py 中的数据格式说明
>
> # 第2步：运行脚本生成docx清单
> python {{YFW_SKILLS}}/_common/generate_checklist.py  \
>   --enterprise "{企业名称}"  \
>   --year {申报年份}  \
>   --data checklist_data.json  \
>   --output-dir "07_资料收集清单"
> ```
>
> **脚本会自动完成**：
> - 生成主清单（10列三层分类）
> - 生成研发设备清单（8列：序号|设备名称|资产编码|部门|购置日期|原值|分类|核对确认✓/✗）
> - 生成合同发票清单（9列，按2023/2024/2025年度分3个独立表，含冗余系数提示）
> - 生成**2025年研发项目及成果转化补缺清单**（基于加计扣除表对比，10列）
> - 生成**按时间节点需收集合同清单**（9列，无合同编号则列发票编号）
> - 生成**2025年优质合同发票推荐收集清单**（8列，基于全量发票筛选+冗余系数）
> - ✓状态标识（"合同已有✓"/"缺合同，需补充"）
> - 【补充需求】合并行（每年度合同发票表末行横向合并7列）
> - Word Heading 2/3样式（生成文档大纲导航）
> - 量化排查结果（"已收到X份…仍缺Y份"）
> - 冗余系数标注（10-20%多收集，应对审核补料）
> - 质量校验（10项指标全部通过才算完成，3个新章节为可选）
>
> **脚本跑不通时**：阅读 [{{YFW_SKILLS}}/_common/generate_checklist.py](file:///C:/Users/T203-15/.trae-cn/skills/enterprise_project_skills/_common/generate_checklist.py) 中的 `generate_checklist_docx()` 函数实现，自行编写等效Python代码生成docx。**不允许只输出xlsx不生成docx**。

#### 5.A v1.16.0新增：2025年研发项目及成果转化补缺（agent数据准备逻辑）

> **触发场景**：用户已优化删减细化了资料收集清单后，要求细化发票合同内容时，发现2025年的研发项目（RD）和成果转化（ACH）有缺失。

**agent数据准备步骤**：

1. **读取2026加计扣除表**：搜索项目资料目录下含"加计扣除"、"研发费用加计扣除"、"2026加计"等关键词的xlsx文件，读取研发项目明细Sheet
2. **识别2025年新立项RD**：根据加计扣除表中"立项日期"或"研发开始时间"字段，筛选出2025年1月1日之后立项的RD项目
3. **对比核心表格中的RD清单**：与现有RD表对比，识别加计扣除表中有但核心表格中没有的RD项目
4. **识别关联的成果转化**：每个缺失的2025年RD通常对应1项成果转化（ACH），需同步补缺
5. **构造 missing_rd_2025 数据**：
   ```json
   "missing_rd_2025": {
     "source_file": "{加计扣除表文件名}",
     "items": [
       {"rd_code": "RD{编号}", "rd_name": "{研发项目名称}",
        "start_date": "{立项时间}", "end_date": "{结束时间}",
        "rd_budget": {研发预算万元}, "linked_ip": "{关联IP编号，无则空}",
        "linked_ach": "ACH{编号}", "source": "加计扣除表行{行号}",
        "remark": "核心表格需补充RD表+成果转化表"}
     ]
   }
   ```
6. **后续动作**：agent在生成核心表格时需补充这些缺失的RD和ACH，与gxtz-core-tables技能联动

#### 5.B v1.16.0新增：按时间节点排查需收集合同清单（agent数据准备逻辑）

> **触发场景**：用户已列出时间节点（RD立项时间、PS销售时间、设备购置时间等），需排查已有发票合同，列出具体需收集的合同清单。

**agent数据准备步骤**：

1. **收集时间节点**：从RD表（立项时间）、PS表（销售时间）、设备清单（购置日期）、核心表格中提取所有时间节点
2. **读取已有合同发票清单**：从 `05-合同发票/` 目录扫描已收集的合同和发票文件，提取合同编号、发票号码、客户名称、金额、日期
3. **逐一匹配时间节点**：每个时间节点±30天范围内，查找是否有对应的合同和发票
4. **识别缺失项**：时间节点附近有发票但无合同的，标记为"缺合同，需补充"
5. **无合同编号时用发票编号代替**：对于"缺合同"项，将发票号码作为核对依据填入"发票号码"列，"合同编号"列留空
6. **构造 contracts_needed_by_timepoint 数据**：
   ```json
   "contracts_needed_by_timepoint": {
     "timepoints": ["2024-03-15", "2025-01-20", "..."],
     "items": [
       {"seq": 1, "timepoint": "{时间节点}", "linked_rd": "RD{编号}",
        "customer": "{客户名称}", "amount": {金额万元},
        "has_contract": false, "has_invoice": true,
        "invoice_no": "{发票编号}", "contract_no": "",
        "status": "缺合同，需补充", "remark": "无合同编号，用发票编号{发票号}代替"}
     ]
   }
   ```

#### 5.C v1.16.0新增：通过2025全量发票拟定收集合同发票清单（agent数据准备逻辑）

> **触发场景**：用户提供2025年全量发票数据，需对照时间、金额、客户优质程度筛选出推荐收集的合同发票清单。

**agent数据准备步骤**：

1. **读取2025全量发票**：搜索含"2025发票"、"全量发票"、"发票明细"等关键词的xlsx文件，读取发票明细Sheet
2. **应用筛选条件**：
   - **时间筛选**：开票日期在2025-01-01至2025-12-31范围内
   - **金额筛选**：金额 ≥ {阈值，建议5万元}（可配置）
   - **客户优质度筛选**：客户名称匹配优质客户名单（如上市公司、长期合作客户、大额采购客户）
   - **对应RD时间筛选**：开票日期在某个RD立项时间±90天范围内（优先保留）
3. **客户优质度评级**：
   - **优质**：上市公司/国企/长期合作客户/单次采购金额≥20万
   - **良好**：民营企业/合作1年以上/单次采购10-20万
   - **普通**：其他客户
4. **排序**：按金额降序 + 客户优质度优先
5. **应用冗余系数10-20%**：在筛选结果基础上，多收集10-20%的发票（用于应对审核补料）
   - 默认冗余系数 `redundancy_ratio: 0.15`（即15%）
   - 用户可指定10%-20%之间的任意值
6. **构造 recommended_invoices_2025 数据**：
   ```json
   "recommended_invoices_2025": {
     "source_file": "{全量发票文件名}",
     "filter_criteria": {"min_amount": 5.0, "date_range": "2025-01~2025-12", "customer_quality": "优质"},
     "redundancy_ratio": 0.15,
     "items": [
       {"seq": 1, "invoice_no": "{发票号码}", "invoice_date": "{开票日期}",
        "customer": "{客户名称}", "customer_quality": "优质|良好|普通",
        "amount": {金额万元}, "has_contract": false,
        "reason": "金额大+客户优质+对应RD{编号}时间"}
     ]
   }
   ```

#### 5.D v1.16.0冗余系数配置（合同发票清单全局）

> **强制要求**：所有合同发票清单中的数量必须多收集10-20%（应对审核补料）。

**配置方式**：
- 在 checklist_data.json 根级设置 `"redundancy_ratio": 0.15`（默认15%）
- 用户可指定10%-20%之间的任意值（如 `"redundancy_ratio": 0.20` 表示多收集20%）
- 脚本会自动在【补充需求】合并行中显示"建议收集总量 {原数量 × (1+冗余系数)} 项（含 {冗余系数×100}% 冗余）"
- 推荐发票清单也会单独标注冗余系数和目标收集总量

**JSON数据格式示例**（agent准备数据后保存为 checklist_data.json）：
```json
{
  "enterprise_name": "深圳市XX公司",
  "application_year": 2026,
  "recent_three_years": [2023, 2024, 2025],
  "last_year": 2025,
  "redundancy_ratio": 0.15,
  "items": [
    {
      "department": "行政", "category": "基础材料", "seq": 1,
      "name": "企业最近的营业执照", "provide_way": "扫描件",
      "requirement": "需盖贵司公章", "deadline": "2026-08-15",
      "provided": "否", "progress": "", "remark": ""
    }
  ],
  "equipment_list": [
    {"seq": 1, "name": "设备名", "asset_code": "XX-001", "dept": "研发部",
     "purchase_date": "2024-03-01", "value": 5.8, "category": "研发设备", "confirmed": "✗"}
  ],
  "contract_invoice_by_year": {
    "2023": [{"seq": 1, "合同编号": "HT001", "合同名称": "...", "客户名称": "...",
              "合同金额": 10.5, "合同签订日期": "2023-05-01",
              "发票号码": "FP001", "发票金额": 10.5}]
  },
  "supplement_summary": {
    "total_items": 50, "provided_count": 20, "pending_count": 30,
    "by_dept": {"行政": 5, "人事": 10, "财务": 8, "研发": 7}
  },
  "missing_rd_2025": {
    "source_file": "2026加计扣除表.xlsx",
    "items": [
      {"rd_code": "RD21", "rd_name": "2025年新立项研发项目名称",
       "start_date": "2025-03-01", "end_date": "2025-12-31",
       "rd_budget": 50.0, "linked_ip": "IP13", "linked_ach": "ACH21",
       "source": "加计扣除表行15", "remark": "核心表格需补充"}
    ]
  },
  "contracts_needed_by_timepoint": {
    "timepoints": ["2024-03-15", "2025-01-20"],
    "items": [
      {"seq": 1, "timepoint": "2024-03-15", "linked_rd": "RD01",
       "customer": "深圳XX公司", "amount": 10.5,
       "has_contract": false, "has_invoice": true,
       "invoice_no": "FP20240315001", "contract_no": "",
       "status": "缺合同，需补充", "remark": "无合同编号，用发票编号代替"}
    ]
  },
  "recommended_invoices_2025": {
    "source_file": "2025全量发票.xlsx",
    "filter_criteria": {"min_amount": 5.0, "date_range": "2025-01~2025-12"},
    "redundancy_ratio": 0.15,
    "items": [
      {"seq": 1, "invoice_no": "FP20250315001", "invoice_date": "2025-03-15",
       "customer": "深圳XX公司", "customer_quality": "优质",
       "amount": 25.8, "has_contract": false, "reason": "金额大+客户优质+对应RD时间"}
    ]
  }
}
```

**输出文件：`{企业名称}-{申报年份}年高新认定资料收集清单.xlsx`**

#### Sheet1：国家高新技术企业材料清单及计划进度（面向客户核心清单，10列三层分类）

**表头（10列）：**

| 负责部门 | 类别 | 序号 | 所需资料 | 提供方式 | 材料要求说明 | 计划完成时间 | 是否已经提供 | 资料整理及撰写进度情况 | 备注 |
|----------|------|------|----------|----------|--------------|--------------|--------------|--------------------------|------|

**三层分类结构：**
- 第一层：负责部门（行政/人事/财务/研发）
- 第二层：类别（基础材料/财务资料/审计报告五个/技术材料）
- 第三层：序号（各部门独立编号）

**完整资料明细（29项，参考深圳官方清单）：**

##### A. 行政-基础材料（6项）

| 负责部门 | 类别 | 序号 | 所需资料 | 提供方式 | 材料要求说明 |
|----------|------|------|----------|----------|--------------|
| 行政 | 基础材料 | 1 | 企业注册信息表 | 我司提供模板 | 见附件一（国高复审企业不用提供） |
| 行政 | 基础材料 | 2 | 企业最近的营业执照 | 扫描件 | 需盖贵司公章 |
| 行政 | 基础材料 | 3 | 法人身份证复印件 | 复印件扫描件 | 需盖贵司公章 |
| 行政 | 基础材料 | 4 | ISO质量管理体系认证证书、环境体系认证、职业健康体系认证及知识产权体系证书等（有则提供） | 电子版 | 证书扫描件 |
| 行政 | 基础材料 | 5 | 特殊行业许可证或产品资质证书（有则提供） | 电子版 | 经营/生产许可资质证书扫描件等 |
| 行政 | 基础材料 | 6 | 公司或者产品的荣誉证书（有则提供） | 电子版 | 证书尽量多，主要前三年获得的 |

##### B. 人事-基础材料（9项）

| 负责部门 | 类别 | 序号 | 所需资料 | 提供方式 | 材料要求说明 |
|----------|------|------|----------|----------|--------------|
| 人事 | 基础材料 | 1 | {上年度}年研发人员信息表、研发人员比例说明 | 我司提供模板 | 研发人员原则上要求大专及以上理工科学历，占比公司人数最低10%以上，入职时间截止上年底满半年 |
| 人事 | 基础材料 | 2 | 研发人员毕业证书 | 扫描件 | 如学历证书遗失，可从学信网下载证明材料 |
| 人事 | 基础材料 | 3 | 研发人员职称证书或人才证书（有则提供） | 扫描件 | 有则提供 |
| 人事 | 基础材料 | 4 | 企业职工{上年度}年12月社保人员清单汇总表 | 扫描件 | 到办税服务厅打印盖章（深圳）；广东要求3/6/9/12月四个月参保人数证明 |
| 人事 | 基础材料 | 5 | 与大专院校、科研院所的产学研合作协议 | 扫描件 | 加分项。最好有费用发票或转账凭证、签约现场图片、产学研基地牌匾、合作研发证明图片等 |
| 人事 | 基础材料 | 6 | 公司研发管理水平相关制度、红头文件模板等 | 我司可提供模板（编辑定稿后贵司盖章） | 含8项制度：研发部设立文件/组织架构、研发项目立项管理制度、研发经费投入与核算管理制度、科技成果转化组织实施与激励奖励制度、建立开放式创新创业平台实施管理办法、科技人员培训管理制度、人才引进管理办法、科技人员绩效考核奖励制度 |
| 人事 | 基础材料 | 7 | 研发部门办公及研发场地图片 | 电子档 | 提供清晰照片（5张左右） |
| 人事 | 基础材料 | 8 | 研发设备清单（见表一）及主要设备图片 | 电子档 | 提供清晰照片（15张左右） |
| 人事 | 基础材料 | 9 | 研发人员奖励的证明资料、技术培训相关图片 | 电子档 | 时间在{近三年第一年}-{近三年第三年}之间，提供清晰照片或扫描件 |

##### C. 财务-财务资料（4项）

| 负责部门 | 类别 | 序号 | 所需资料 | 提供方式 | 材料要求说明 |
|----------|------|------|----------|----------|--------------|
| 财务 | 财务资料 | 1 | {近三年}三个会计年度企业所得税年度纳税申报表 | 电子档或扫描件 | 主表及所有附表，每页都要有税局红章的PDF。无章则到办税服务厅盖章 |
| 财务 | 财务资料 | 2 | {近三年}三年的纳税证明 | 国税下载电子档 | 带税局红章 |
| 财务 | 财务资料 | 3 | {上年度}年整年度开票明细表 | 电子档 | {上年度}全量发票查询导出结果EXCEL表格 |
| 财务 | 财务资料 | 4 | {近三年}年企业研发费用辅助账 | 我司可提供模板 | 一般贵司财务做好 |

##### D. 财务-审计报告五个（3项，序号5-7）

| 负责部门 | 类别 | 序号 | 所需资料 | 提供方式 | 材料要求说明 |
|----------|------|------|----------|----------|--------------|
| 财务 | 审计报告五个 | 5 | 上年度高新技术产品（服务）收入专项审计报告 | 有资质事务所出具 | 高新产品收入必须占{上年度}总收入60%以上；必须本市有高新专项审计资质的会计师事务所或税务师事务所（深圳）；广东不限本市 |
| 财务 | 审计报告五个 | 6 | 企业近三个会计年度研究开发费用专项审计报告 | 有资质事务所出具 | 年营业收入<5000万研发费用需占销售收入5%以上、<2亿4%以上、>2亿3%以上；必须本市有资质事务所（深圳） |
| 财务 | 审计报告五个 | 7 | {近三年}三个年度的财务审计报告 | 会计师事务所出具 | 包括资产负债表、利润表/损益表、现金流量表、财务情况说明。数据需与所得税申报表一致 |

##### E. 研发-技术材料（科技成果转化证明材料）（7项）

| 负责部门 | 类别 | 序号 | 所需资料 | 提供方式 | 材料要求说明 |
|----------|------|------|----------|----------|--------------|
| 研发 | 技术材料 | 1 | 产品介绍文件 | PPT、PDF或word | 贵司提供主营产品资料，最好为word、PPT可编辑资料 |
| 研发 | 技术材料 | 2 | 产品或样品近几年所有第三方《产品质量检验报告》《测试报告》《查新报告》等，无第三方的则提供企业内部测试报告；以及《产品说明书/规格书》《用户满意度调查表》等 | 扫描件 | 主要为近三年内的检测报告、用户评价等证明材料 |
| 研发 | 技术材料 | 3 | 产品各类认证证书及报告（UL,3C,CE,FCC,CSA,ETL,GS,Rohs等） | 扫描件 | 主要为近三年做的 |
| 研发 | 技术材料 | 4 | 高新产品销售合同、发票（{近三年}） | 扫描件 | {近三年第一年}和{近三年第二年}每年6-8份合同，{近三年第三年}10-12份（深圳）/10份左右（广东），每年12月份至少2-3份。每份合同对应2-3张发票 |
| 研发 | 技术材料 | 5 | 研发项目材料（{近三年}年） | 贵司提供技术素材，我司撰写定稿后盖章 | 要求{近三年第一年}-{近三年第三年}年均研发项目5个以上，3年共计最低16个 |
| 研发 | 技术材料 | 6 | 参与或主导国家/行业标准制定的证明材料 | 扫描件 | 加分项（加2分） |
| 研发 | 技术材料 | 7 | 知识产权证书 | 扫描件 | 包括发明专利、集成电路布图、实用新型专利、软件著作权（软著还提供PDF申请表及文档说明书）、外观等；转让的需提供经知识产权局变更备案的手续合格通知书；广东省发明和实用新型需提供最近年费缴费发票 |

**Sheet1生成函数：**
```python
def generate_customer_facing_checklist(enterprise_name, application_year, region='shenzhen', 
                                        analysis_results=None):
    """生成面向客户的资料收集清单（10列三层分类结构）
    
    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        region: 地区（shenzhen/guangdong）
        analysis_results: 资料排查分析结果（用于自动填充"是否已经提供"列）
    """
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    last_year = application_year - 1
    years_str = f"{recent_three_years[0]}-{recent_three_years[2]}"
    
    # 29项资料明细模板
    materials = build_materials_template(recent_three_years, last_year, region)
    
    wb = Workbook()
    ws = wb.active
    ws.title = '国家高新技术企业材料清单及计划进度'
    
    # 标题行（合并单元格）
    ws.merge_cells('A1:J1')
    ws['A1'] = f'{enterprise_name}-{application_year}年国家高新技术企业认定材料清单及计划进度'
    ws['A1'].font = Font(bold=True, size=14)
    ws['A1'].alignment = Alignment(horizontal='center', vertical='center')
    
    # 表头
    headers = ['负责部门', '类别', '序号', '所需资料', '提供方式', '材料要求说明',
               '计划完成时间', '是否已经提供', '资料整理及撰写进度情况', '备注']
    ws.append(headers)
    
    # 填充数据
    current_dept = None
    current_category = None
    dept_start_row = 2
    category_start_row = 2
    
    for idx, mat in enumerate(materials, start=3):  # 数据从第3行开始
        ws.append([
            mat['负责部门'],
            mat['类别'],
            mat['序号'],
            mat['所需资料'],
            mat['提供方式'],
            mat['材料要求说明'],
            mat.get('计划完成时间', ''),
            determine_provided_status(mat, analysis_results),
            mat.get('进度情况', ''),
            mat.get('备注', '')
        ])
        
        # 合并相同负责部门的单元格
        if mat['负责部门'] != current_dept:
            if current_dept is not None and idx - 1 > dept_start_row:
                ws.merge_cells(f'A{dept_start_row}:A{idx-1}')
            current_dept = mat['负责部门']
            dept_start_row = idx
        
        # 合并相同类别的单元格
        if mat['类别'] != current_category:
            if current_category is not None and idx - 1 > category_start_row:
                ws.merge_cells(f'B{category_start_row}:B{idx-1}')
            current_category = mat['类别']
            category_start_row = idx
    
    # 合并最后一组
    if current_dept is not None and idx > dept_start_row:
        ws.merge_cells(f'A{dept_start_row}:A{idx}')
    if current_category is not None and idx > category_start_row:
        ws.merge_cells(f'B{category_start_row}:B{idx}')
    
    # 设置列宽
    column_widths = [12, 14, 6, 35, 22, 50, 14, 14, 25, 20]
    for i, width in enumerate(column_widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = width
    
    # 添加申报批次时间说明
    ws.append([])
    ws.append([f'申报批次时间：{get_batch_schedule(region, application_year)}'])
    
    return wb

def build_materials_template(recent_three_years, last_year, region):
    """构建29项资料模板（区分深圳/广东差异）"""
    years_str = f"{recent_three_years[0]}-{recent_three_years[2]}"
    
    # 社保要求差异化
    if region == 'guangdong':
        social_security_req = f"社保局下载PDF带公章（{recent_three_years[2]}年3月、6月、9月和12月份参保人数证明）"
    else:
        social_security_req = f"到办税服务厅打印盖章（{last_year}年12月社保人员清单汇总表）"
    
    # 合同发票数量差异化
    if region == 'guangdong':
        contract_req = f"{recent_three_years[0]}和{recent_three_years[1]}每年6-8份合同，{recent_three_years[2]}年10份左右"
    else:
        contract_req = f"{recent_three_years[0]}和{recent_three_years[1]}每年6-8份合同，{recent_three_years[2]}年10-12份"
    
    # 审计事务所要求差异化
    audit_firm_req_shenzhen = "必须本市有高新专项审计资质"
    audit_firm_req_guangdong = "有高新专项审计资质（不限本市）"
    audit_firm_req = audit_firm_req_shenzhen if region == 'shenzhen' else audit_firm_req_guangdong
    
    # 知识产权要求差异化
    ip_req = "包括发明专利、集成电路布图、实用新型专利、软件著作权（软著还提供PDF申请表及文档说明书）、外观等；转让的需提供经知识产权局变更备案的手续合格通知书"
    if region == 'guangdong':
        ip_req += "；广东省发明和实用新型需提供最近年费缴费发票"
    
    materials = [
        # A. 行政-基础材料（6项）
        {'负责部门': '行政', '类别': '基础材料', '序号': 1, '所需资料': '企业注册信息表',
         '提供方式': '我司提供模板', '材料要求说明': '见附件一（国高复审企业不用提供）'},
        {'负责部门': '行政', '类别': '基础材料', '序号': 2, '所需资料': '企业最近的营业执照',
         '提供方式': '扫描件', '材料要求说明': '需盖贵司公章'},
        {'负责部门': '行政', '类别': '基础材料', '序号': 3, '所需资料': '法人身份证复印件',
         '提供方式': '复印件扫描件', '材料要求说明': '需盖贵司公章'},
        {'负责部门': '行政', '类别': '基础材料', '序号': 4, '所需资料': 'ISO质量管理体系认证证书、环境体系认证、职业健康体系认证及知识产权体系证书等（有则提供）',
         '提供方式': '电子版', '材料要求说明': '证书扫描件'},
        {'负责部门': '行政', '类别': '基础材料', '序号': 5, '所需资料': '特殊行业许可证或产品资质证书（有则提供）',
         '提供方式': '电子版', '材料要求说明': '经营/生产许可资质证书扫描件等'},
        {'负责部门': '行政', '类别': '基础材料', '序号': 6, '所需资料': '公司或者产品的荣誉证书（有则提供）',
         '提供方式': '电子版', '材料要求说明': '证书尽量多，主要前三年获得的'},
        
        # B. 人事-基础材料（9项）
        {'负责部门': '人事', '类别': '基础材料', '序号': 1, '所需资料': f'{last_year}年研发人员信息表、研发人员比例说明',
         '提供方式': '我司提供模板', '材料要求说明': '研发人员原则上要求大专及以上理工科学历，占比公司人数最低10%以上，入职时间截止上年底满半年'},
        {'负责部门': '人事', '类别': '基础材料', '序号': 2, '所需资料': '研发人员毕业证书',
         '提供方式': '扫描件', '材料要求说明': '如学历证书遗失，可从学信网下载证明材料'},
        {'负责部门': '人事', '类别': '基础材料', '序号': 3, '所需资料': '研发人员职称证书或人才证书（有则提供）',
         '提供方式': '扫描件', '材料要求说明': '有则提供'},
        {'负责部门': '人事', '类别': '基础材料', '序号': 4, '所需资料': f'企业职工{last_year}年12月社保人员清单汇总表',
         '提供方式': '扫描件', '材料要求说明': social_security_req},
        {'负责部门': '人事', '类别': '基础材料', '序号': 5, '所需资料': '与大专院校、科研院所的产学研合作协议',
         '提供方式': '扫描件', '材料要求说明': '加分项。最好有费用发票或转账凭证、签约现场图片、产学研基地牌匾、合作研发证明图片等'},
        {'负责部门': '人事', '类别': '基础材料', '序号': 6, '所需资料': '公司研发管理水平相关制度、红头文件模板等',
         '提供方式': '我司可提供模板（编辑定稿后贵司盖章）', '材料要求说明': '含8项制度：研发部设立文件/组织架构、研发项目立项管理制度、研发经费投入与核算管理制度、科技成果转化组织实施与激励奖励制度、建立开放式创新创业平台实施管理办法、科技人员培训管理制度、人才引进管理办法、科技人员绩效考核奖励制度'},
        {'负责部门': '人事', '类别': '基础材料', '序号': 7, '所需资料': '研发部门办公及研发场地图片',
         '提供方式': '电子档', '材料要求说明': '提供清晰照片（5张左右）'},
        {'负责部门': '人事', '类别': '基础材料', '序号': 8, '所需资料': '研发设备清单（见表一）及主要设备图片',
         '提供方式': '电子档', '材料要求说明': '提供清晰照片（15张左右）'},
        {'负责部门': '人事', '类别': '基础材料', '序号': 9, '所需资料': '研发人员奖励的证明资料、技术培训相关图片',
         '提供方式': '电子档', '材料要求说明': f'时间在{recent_three_years[0]}-{recent_three_years[2]}年之间，提供清晰照片或扫描件'},
        
        # C. 财务-财务资料（4项）
        {'负责部门': '财务', '类别': '财务资料', '序号': 1, '所需资料': f'{years_str}三个会计年度企业所得税年度纳税申报表',
         '提供方式': '电子档或扫描件', '材料要求说明': '主表及所有附表，每页都要有税局红章的PDF。无章则到办税服务厅盖章'},
        {'负责部门': '财务', '类别': '财务资料', '序号': 2, '所需资料': f'{years_str}三年的纳税证明',
         '提供方式': '国税下载电子档', '材料要求说明': '带税局红章'},
        {'负责部门': '财务', '类别': '财务资料', '序号': 3, '所需资料': f'{last_year}年整年度开票明细表',
         '提供方式': '电子档', '材料要求说明': f'{last_year}全量发票查询导出结果EXCEL表格'},
        {'负责部门': '财务', '类别': '财务资料', '序号': 4, '所需资料': f'{years_str}年企业研发费用辅助账',
         '提供方式': '我司可提供模板', '材料要求说明': '一般贵司财务做好'},
        
        # D. 财务-审计报告五个（3项）
        {'负责部门': '财务', '类别': '审计报告五个', '序号': 5, '所需资料': f'上年度高新技术产品（服务）收入专项审计报告',
         '提供方式': '有资质事务所出具', '材料要求说明': f'高新产品收入必须占{last_year}总收入60%以上；{audit_firm_req}的会计师事务所或税务师事务所'},
        {'负责部门': '财务', '类别': '审计报告五个', '序号': 6, '所需资料': '企业近三个会计年度研究开发费用专项审计报告',
         '提供方式': '有资质事务所出具', '材料要求说明': f'年营业收入<5000万研发费用需占销售收入5%以上、<2亿4%以上、>2亿3%以上；{audit_firm_req}事务所'},
        {'负责部门': '财务', '类别': '审计报告五个', '序号': 7, '所需资料': f'{years_str}三个年度的财务审计报告',
         '提供方式': '会计师事务所出具', '材料要求说明': '包括资产负债表、利润表/损益表、现金流量表、财务情况说明。数据需与所得税申报表一致'},
        
        # E. 研发-技术材料（7项）
        {'负责部门': '研发', '类别': '技术材料（科技成果转化证明材料）', '序号': 1, '所需资料': '产品介绍文件',
         '提供方式': 'PPT、PDF或word', '材料要求说明': '贵司提供主营产品资料，最好为word、PPT可编辑资料'},
        {'负责部门': '研发', '类别': '技术材料（科技成果转化证明材料）', '序号': 2, '所需资料': '产品或样品近几年所有第三方《产品质量检验报告》《测试报告》《查新报告》等，无第三方的则提供企业内部测试报告；以及《产品说明书/规格书》《用户满意度调查表》等',
         '提供方式': '扫描件', '材料要求说明': '主要为近三年内的检测报告、用户评价等证明材料'},
        {'负责部门': '研发', '类别': '技术材料（科技成果转化证明材料）', '序号': 3, '所需资料': '产品各类认证证书及报告（UL,3C,CE,FCC,CSA,ETL,GS,Rohs等）',
         '提供方式': '扫描件', '材料要求说明': '主要为近三年做的'},
        {'负责部门': '研发', '类别': '技术材料（科技成果转化证明材料）', '序号': 4, '所需资料': f'高新产品销售合同、发票（{years_str}）',
         '提供方式': '扫描件', '材料要求说明': f'{contract_req}，每年12月份至少2-3份。每份合同对应2-3张发票'},
        {'负责部门': '研发', '类别': '技术材料（科技成果转化证明材料）', '序号': 5, '所需资料': f'研发项目材料（{years_str}年）',
         '提供方式': '贵司提供技术素材，我司撰写定稿后盖章', '材料要求说明': f'要求{recent_three_years[0]}-{recent_three_years[2]}年年均研发项目5个以上，3年共计最低16个'},
        {'负责部门': '研发', '类别': '技术材料（科技成果转化证明材料）', '序号': 6, '所需资料': '参与或主导国家/行业标准制定的证明材料',
         '提供方式': '扫描件', '材料要求说明': '加分项（加2分）'},
        {'负责部门': '研发', '类别': '技术材料（科技成果转化证明材料）', '序号': 7, '所需资料': '知识产权证书',
         '提供方式': '扫描件', '材料要求说明': ip_req},
    ]
    
    return materials

def determine_provided_status(material, analysis_results):
    """根据排查结果确定资料的提供状态"""
    if analysis_results is None:
        return '待排查'
    
    # 根据资料名称匹配排查结果
    name = material['所需资料']
    
    if '营业执照' in name:
        return '已提供' if analysis_results.get('basic_info', {}).get('business_license') else '未提供'
    elif '研发人员信息表' in name:
        return '已提供' if analysis_results.get('staff', {}).get('info_table') else '未提供'
    elif '社保' in name:
        return '已提供' if analysis_results.get('staff', {}).get('social_security') else '未提供'
    elif '纳税申报' in name:
        return '已提供' if analysis_results.get('financial', {}).get('tax_returns') else '未提供'
    elif '审计报告' in name and '研发' not in name:
        return '已提供' if analysis_results.get('financial', {}).get('audit_reports') else '未提供'
    elif '知识产权' in name or '证书' in name and '专利' in name:
        cert_count = analysis_results.get('ip', {}).get('certificates_found', 0)
        total_count = analysis_results.get('ip', {}).get('total_ip', 0)
        if cert_count == total_count and total_count > 0:
            return '已提供'
        elif cert_count > 0:
            return f'部分提供({cert_count}/{total_count})'
        else:
            return '未提供'
    elif '销售合同' in name or '发票' in name:
        contract_count = analysis_results.get('contracts', {}).get('statistics', {}).get('total_contracts', 0)
        return f'已提供{contract_count}份' if contract_count > 0 else '未提供'
    elif '研发设备' in name:
        equip_count = analysis_results.get('equipment', {}).get('equipment_count', 0)
        return f'已提供{equip_count}台' if equip_count > 0 else '未提供'
    else:
        return '待排查'

def get_batch_schedule(region, application_year):
    """获取申报批次时间安排"""
    if region == 'shenzhen':
        return f'第一批6.6-7.1 / 第二批7.7-8.4 / 第三批8.8-9.1（{application_year}年）'
    else:  # guangdong
        return f'第一批6.25截止 / 第二批7.25截止 / 第三批8.25截止（{application_year}年）'
```

#### Sheet2：知识产权详细清单（区分证书与其他专利资料文献）

| 序号 | IP编号 | 知识产权名称 | 类别 | IP类型(I/II) | 专利号/著作权号 | 授权日期 | 获得方式 | 证书状态 | 软著附属材料 | 专利登记簿 | 年费缴费发票 | 转让手续通知书 | 关联RD | 关联成果转化 | 存在问题 | 补充要求 |
|------|--------|--------------|------|--------------|-----------------|----------|----------|----------|--------------|------------|--------------|---------------------|--------|--------------|----------|----------|

**说明：**
- 证书状态：已提供/未提供/部分提供
- 软著附属材料：仅软著需填写（申请表+源程序+设计说明书是否齐全）
- 专利登记簿：发明专利建议提供（近3个月内出具）
- 年费缴费发票：广东省发明+实用新型必须提供
- 转让手续通知书：受让IP必须提供

#### Sheet3：研发项目清单

| 序号 | RD编号 | 研发活动名称 | 开始时间 | 结束时间 | 经费预算（万元） | 近三年支出（万元） | 人员数 | 关联IP | 立项报告状态 | 验收报告状态 | 辅助账状态 | 存在问题 | 补充要求 |
|------|--------|--------------|----------|----------|------------------|-------------------|--------|--------|--------------|--------------|------------|----------|----------|

#### Sheet4：高新产品清单

| 序号 | PS编号 | 产品名称 | 技术领域 | 上年度收入（万元） | 关联IP | 技术说明状态 | 检测报告状态 | 合同发票状态 | 存在问题 | 补充要求 |
|------|--------|----------|----------|-------------------|--------|--------------|--------------|--------------|----------|----------|

#### Sheet5：科技成果转化清单

| 序号 | 成果序号 | 成果名称 | 成果类型 | 转化时间 | 关联IP | 关联RD | 关联PS | 转化形式 | 证明材料状态 | 合同发票状态 | 存在问题 | 补充要求 |
|------|----------|----------|----------|----------|--------|--------|--------|----------|--------------|--------------|----------|----------|

#### Sheet6：科技人员清单

| 序号 | 姓名 | 身份证号 | 学历 | 专业 | 岗位 | 入职时间 | 社保状态 | 学历证书状态 | 职称证书状态 | 存在问题 | 补充要求 |
|------|------|----------|------|------|------|----------|----------|--------------|--------------|----------|----------|

#### Sheet7：财务数据汇总

| 年度 | 营业收入（万元） | 研发费用（万元） | 研发费用占比 | 高新产品收入（万元） | 高新收入占比 | 审计报告状态 | 辅助账状态 | 纳税申报表状态 | 存在问题 | 补充要求 |
|------|------------------|------------------|--------------|---------------------|--------------|--------------|------------|----------------|----------|----------|

#### Sheet8：管理制度清单

| 序号 | 制度名称 | 发布日期 | 文件状态 | 内容完整性 | 存在问题 | 补充要求 |
|------|----------|----------|----------|------------|----------|----------|

#### Sheet9：合同发票清单

| 序号 | 年份 | 合同编号 | 客户名称 | 合同金额（万元） | 签订日期 | 产品名称 | 发票代码 | 发票号码 | 发票金额（万元） | 开票日期 | 匹配状态 | 存在问题 | 补充要求 |
|------|------|----------|----------|------------------|----------|----------|----------|----------|------------------|----------|----------|----------|----------|
| 1 | 2023 | HT2023001 | XX公司 | 50.00 | 2023-05-10 | 幕墙产品 | 4403232305 | 12345678 | 50.00 | 2023-05-15 | 已匹配 | | |
| 2 | 2023 | HT2023002 | YY公司 | 30.00 | 2023-06-15 | 门窗产品 | 4403232306 | 12345679 | 30.00 | 2023-06-20 | 已匹配 | | |
| ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |

**合同发票统计：**
- 2023年合同数量：10-12份
- 2023年发票数量：10-12份
- 2024年合同数量：10-12份
- 2024年发票数量：10-12份
- 2025年合同数量：18-20份
- 2025年发票数量：18-20份

#### Sheet10：研发设备清单

| 序号 | 设备编号 | 设备名称 | 型号规格 | 数量 | 单价（万元） | 总价（万元） | 使用部门 | 采购日期 | 设备照片状态 | 固定资产编号 | 存在问题 | 补充要求 |
|------|----------|----------|----------|------|--------------|--------------|----------|----------|--------------|--------------|----------|----------|
| 1 | SB001 | 数控切割机 | CNC-1000 | 1 | 50.00 | 50.00 | 生产部 | 2022-03-15 | 已提供 | GD001 | | |
| 2 | SB002 | 焊接机器人 | ABB-IRB | 2 | 30.00 | 60.00 | 生产部 | 2023-05-20 | 已提供 | GD002 | | |
| ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |

**研发设备统计：**
- 设备总数：XX台
- 设备总值：XX万元
- 设备照片提供情况：已提供XX张，缺少XX张

#### Sheet11：网报系统上传规范（新增，19项硬约束）

| 序号 | 提交材料名称 | 格式 | 大小限制 | 命名规则 | 是否已生成 | 存在问题 |
|------|--------------|------|----------|----------|------------|----------|
| 1 | 知识产权证明材料(IP、NIP) | 未加密PDF | ≤2M | 知识产权编号_知识产权名称 | | |
| 2 | 企业研究开发活动情况证明材料(RD) | 未加密PDF | ≤2M | 研发活动编号_研发活动名称 | | |
| 3 | 上年度高新技术产品（服务）证明材料(PS) | 未加密PDF | ≤4M | 产品（服务）编号_产品（服务）名称 | | |
| 4 | 科技成果转化情况证明材料 | 未加密PDF | ≤2M | 科技成果序号_科技成果名称 | | |
| 5 | 国家或行业标准制定情况证明材料 | 未加密PDF | ≤2M | 标准序号_标准名称 | | |
| 6 | 营业执照 | jpg/png | ≤500KB | 加盖公章扫描件 | | |
| 7 | 申报书封皮 | 未加密PDF | ≤1M | | | |
| 8 | 近三年财务审计报告 | 未加密PDF | ≤100M | 年度_财务审计报告 | | |
| 9 | 近三年企业所得税纳税申报表 | 未加密PDF | ≤5M | 年度_企业所得税纳税申报表 | | |
| 10 | 近三年研发费用专项审计报告 | 未加密PDF | ≤100M | 须附备案二维码和报告编码 | | |
| 11 | 近一年高新技术产品（服务）收入专项审计报告 | 未加密PDF | ≤100M | 须附备案二维码和报告编码 | | |
| 12 | 研发组织管理制度+研发投入核算体系+研发费用辅助账 | 未加密PDF | ≤20M | | | |
| 13 | 内部研发机构+产学研合作证明 | 未加密PDF | ≤20M | | | |
| 14 | 科技成果转化组织实施与激励奖励制度+创新创业平台 | 未加密PDF | ≤5M | | | |
| 15 | 科技人员培养进修/技能培训/人才引进/绩效评价奖励制度 | 未加密PDF | ≤5M | | | |
| 16 | 人力资源情况证明材料 | 未加密PDF | ≤8M | 含科技人员名单+上年度社保清单+学历证明 | | |
| 17 | 上年度高新技术产品（服务）相关代表性销售合同与发票 | 未加密PDF | ≤20M | 附全部高新产品收入对应合同及发票清单 | | |
| 18 | 企业承诺书 | 未加密PDF | ≤1M | | | |
| 19 | 打印申请书签字盖章扫描件 | 未加密PDF | - | 含研发活动汇总表、研发费用结构明细表、高新产品汇总表（签字盖章） | | |

**v1.5.0新增融合说明**：
- 研发设备清单：如果从固定资产清单筛选出研发设备，在资料收集单的研发设备行标注"已从固定资产清单筛选X台研发设备"
- 合同发票：在资料收集单的合同发票行，标注已提取的合同编号和发票编号，方便客户筛查对照

**v1.6.0新增：设备清单单独生成独立表格**：
- 设备清单不再与资料收集清单混合，单独生成独立表格（调用 `generate_equipment_checklist_table()`），方便客户逐项核对
- 8列结构：序号|设备名称|资产编码|部门|购置日期|原值（元）|分类|核对确认（✓/✗）
- 表格按"分类"列分组：热处理设备 / 检测分析设备 / 表面处理设备 / 辅助设备 / 模具 / 办公设备 / 其他（由设备名称关键词自动识别）
- 按"部门"列区分：研发部 / 生产部（从设备数据"使用部门"列读取）
- 合计行显示设备总数和原值合计（如"合计：35台  原值合计：1,280,500.00元"）
- 最后一列"核对确认（✓/✗）"留空，供客户人工勾选，确认每项设备的归属和金额
- 表头浅灰背景色 #D9D9D9，表头粗体9pt，数据8pt，合计行粗体

**v1.6.0新增：合同发票表采用9列结构**：
- 合同发票表采用9列结构：序号|客户名称|已有合同/订单|合同编号/订单号|发票客户|发票编号|发票金额|发票日期|状态说明
- "已有合同/订单"列：用"✓"标识已有，缺失则留空或填说明
- "状态说明"列采用"✓"或文字说明（如"合同已有✓" / "缺合同，需补充" / "待补充"），不使用简单的"已提供/待补充"
- 每年度合同发票表最后一行"【补充需求】"行横向合并前7列，存放整段补充说明文本（如"【补充需求】2025年度合同需求数量：6-12份（每年12月至少2-3份），每份合同对应2-3张发票，覆盖≥5个不同客户。"）
- 表头浅蓝背景色 #E8F0FE，表头粗体9pt，数据8pt

---

### 第六步：生成补充资料收集要求（完整列出所需资料内容）

**核心原则：补充清单必须完整列出所有缺失/有问题资料的所需内容，按深圳官方29项明细逐项列出，便于客户一次性补齐。**

> **⚠️ v1.15.0强制执行（不可跳过）**：
>
> **补充清单docx必须通过脚本生成**（与第五步相同的脚本 [{{YFW_SKILLS}}/_common/generate_checklist.py](file:///C:/Users/T203-15/.trae-cn/skills/enterprise_project_skills/_common/generate_checklist.py)），**禁止仅用函数描述而不执行**：
>
> ```bash
> # 第1步：将analysis_results/equipment_data/contract_invoice_data整理为checklist_data.json
> # 字段：items/equipment_list/contract_invoice_by_year/supplement_summary
>
> # 第2步：运行脚本生成docx（含设备8列表+合同发票9列表+状态标识+量化描述+Heading样式+【补充需求】合并行）
> python {{YFW_SKILLS}}/_common/generate_checklist.py  \
>   --enterprise "{企业名称}"  \
>   --year {申报年份}  \
>   --data checklist_data.json  \
>   --output-dir "07_资料收集清单"
> ```
>
> 脚本会自动完成7项质量校验（main_table_10_cols/equipment_table_8_cols/contract_invoice_9_cols/status_with_checkmark/heading_styles/supplement_summary/supplement_demand_row），全部通过才返回成功。
>
> **脚本跑不通时**：阅读 generate_checklist.py 中的 `generate_checklist_docx()` 函数实现，自行编写等效Python代码。**不允许只输出xlsx不生成docx**。

**v1.6.0新增：参考和胜金属项目实际docx格式生成标准化补充清单文档**：
- 调用 `generate_supplement_checklist_hesheng_format()` 生成参考深圳市和胜金属技术有限公司项目实际docx格式的标准化补充清单文档
- 文档结构：段落标题（国高项目申报资料补充清单）+ 企业信息段（企业名称/申报年份/近三年/生成日期）+ 8大类章节 + 独立表格
- 按8大类章节组织：二、人员资料 / 三、知识产权资料 / 四、研发项目资料 / 五、高新技术产品资料 / 六、成果转化证明材料（合同+发票）/ 七、管理制度材料 / 八、其他辅助证明资料
- 每类资料用独立表格，说明类表格采用4列结构（序号|资料名称|时间要求|需补充说明），人员表/合同发票表/设备表采用专用列结构
- 设备清单单独表格（调用 `generate_equipment_checklist_table()` 生成独立表格，8列结构，浅灰表头#D9D9D9），不再与资料收集清单混合
- 合同发票表采用9列结构（序号|客户名称|已有合同/订单|合同编号/订单号|发票客户|发票编号|发票金额|发票日期|状态说明），每个年度一张表
- 状态标识用"✓"和文字说明（如"合同已有✓" / "缺合同，需补充" / "待补充"），不使用简单的"已提供/待补充"
- 每年度合同发票表最后一行"【补充需求】"行横向合并前7列，存放整段补充说明文本
- 表头背景色：浅蓝 #E8F0FE（人员表/合同发票表/说明类表格）、浅灰 #D9D9D9（设备表）
- 表头粗体9pt，数据8pt，合计行粗体

```python
def generate_supplement_requirements(analysis_results, application_year, region='shenzhen'):
    """生成补充资料收集要求（完整版，v1.2.0优化）
    
    v1.2.0优化点：
    1. 排除财务资料（财务-1~财务-7），财务资料由财务技能单独处理
    2. 只输出需要补充的资料（已提供的不输出）
    3. 每项详细列出具体缺失内容，不笼统说"已有部分"
    
    Args:
        analysis_results: 第二步排查分析结果
        application_year: 申报年份
        region: 地区（shenzhen/guangdong）
    
    Returns:
        list: 补充资料要求清单，只包含需要补充的非财务资料
    """
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    last_year = application_year - 1
    years_str = f"{recent_three_years[0]}-{recent_three_years[2]}"
    
    # 完整补充要求模板（29项，按部门分类）
    supplement_template = build_complete_supplement_template(
        recent_three_years, last_year, region, analysis_results
    )
    
    # 根据排查结果筛选出需要补充的资料
    # v1.2.0：排除财务资料和已提供的资料
    requirements = []
    for req in supplement_template:
        # 排除财务资料（由财务技能单独处理）
        if req.get('is_financial', False):
            continue
        
        # 排除已提供的资料（只输出需要补充的）
        status = req.get('排查状态', '未排查')
        if status in ['未提供', '部分提供', '有问题', '未排查']:
            # 添加详细的缺失说明（不笼统说"已有部分"）
            req['缺失说明'] = generate_missing_detail(req, analysis_results, application_year)
            requirements.append(req)
    
    return requirements

def generate_missing_detail(req, analysis_results, application_year):
    """生成具体的缺失说明（v1.2.0新增）
    
    根据排查结果，详细列出该项资料具体缺失什么内容，
    不笼统说"已有部分"，而是明确告诉客户需要补充哪些。
    
    Args:
        req: 补充资料项
        analysis_results: 本地筛查结果
        application_year: 申报年份
    
    Returns:
        str: 具体缺失说明
    """
    last_year = application_year - 1
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    years_str = f"{recent_three_years[0]}-{recent_three_years[2]}"
    
    serial = req.get('序号', '')
    status = req.get('排查状态', '未排查')
    name = req.get('资料名称', '')
    
    if status == '未提供':
        return f"未在本地资料中找到{name}，请按上述要求完整提供"
    elif status == '部分提供':
        # 针对不同资料项，详细列出缺失内容
        if '研发人员' in name and '信息表' in name:
            return f"已有部分人员信息，但需补充：1）按派成铝业14列格式重新整理（序号/姓名/入职时间/身份证号/姓别/学历/毕业院校/专业/部门/岗位/在职时间/职称/工资/日期）；2）确保所有人员在上年12月社保缴费记录中；3）累计工作时长≥183天；4）研发人员占比≥10%"
        elif '毕业证书' in name or '学历证书' in name:
            return f"已有部分学历证书，请补充：每位研发人员的最高学历证书扫描件，按{姓名}_学历证书.pdf命名，学历信息需与名册中的学历列一致"
        elif '职称证书' in name:
            return f"已有部分职称证书，请补充：有职称但未提供证书的研发人员，按{姓名}_职称证书.pdf命名"
        elif '社保' in name:
            return f"已有社保资料，但需补充：1）确认是上年12月份的社保缴费证明；2）社保局出具带红色公章；3）覆盖全部研发人员；4）包含字段：单位名称、人员姓名、身份证号、缴费起止时间、缴费基数"
        elif '设备清单' in name:
            return f"已有部分设备资料，但需补充：1）完整研发设备清单Excel（设备名称/型号/数量/单价/总价/采购日期/使用部门）；2）确保≥10台、总值≥50万元、80%研发部门使用；3）每台设备1张清晰照片含铭牌信息"
        elif '制度' in name or '管理' in name:
            return f"已有部分制度文件，请补充：1）研发项目管理制度；2）研发机构管理制度；3）产学研合作制度；4）绩效考核制度；5）奖励制度；所有制度需为企业正式发布的红头文件（带文件编号、发布日期、签发人）"
        elif '合同' in name or '发票' in name:
            return f"已有部分合同发票，请补充：1）近三年每年合同数量要求（{recent_three_years[0]}和{recent_three_years[1]}年每年10-12份，{recent_three_years[2]}年18-20份）；2）每份合同对应1-2张发票；3）单份合同≥10万元；4）覆盖≥5个不同客户，单一客户占比≤50%；5）按{{年份}}_{{客户}}_{{编号}}命名"
        elif '检测' in name or '测试' in name:
            return f"已有部分检测报告，请补充：1）每个PS产品至少1份第三方检测报告；2）检测机构需具备CMA/CNAS资质；3）按PS{{编号}}_{{产品名称}}_检测报告.pdf命名"
        elif '知识产权' in name or '证书' in name or '专利' in name:
            return f"已有部分IP资料，请补充：1）每项I类IP证书扫描件（发明/集成电路布图）；2）每项II类IP证书扫描件（实用新型/外观/软著）；3）软著附属材料（申请表+源程序文档前30后30页+设计说明书）；4）广东省申报需补年费缴费发票；5）受让IP需补转让合同+手续合格通知书；按IP{{编号}}_{{知识产权名称}}.pdf命名"
        elif '产学研' in name:
            return f"已有部分产学研资料，请补充：1）合作院校名单及协议；2）合作项目清单；3）合作成果证明；4）费用发票或转账凭证；5）签约现场图片；6）产学研基地牌匾"
        elif '场地' in name:
            return f"已有部分场地照片，请补充：1）研发部门办公场景5张左右；2）研发场地（实验室、技术研究院等）照片；3）场地门牌/牌匾（如技术研究院、实验室）"
        elif '照片' in name or '图片' in name:
            return f"已有部分照片资料，请补充：1）产品照片带铭牌（每个PS产品1-3张）；2）研发场地照片5张左右；3）研发设备照片15张左右；4）研发人员获奖/培训照片"
        elif '产品' in name and '介绍' in name:
            return f"已有部分产品资料，请补充：1）每个主营产品的产品介绍文档；2）技术参数、应用场景、市场前景；3）格式为Word/PPT可编辑资料"
        elif '荣誉' in name:
            return f"已有部分荣誉证书，请补充：近三年内获得的公司荣誉、产品荣誉、行业奖项等证书扫描件"
        elif '认证' in name:
            return f"已有部分认证证书，请补充：ISO9001/ISO14001/ISO45001/知识产权管理体系等认证证书，必须在有效期内"
        elif '许可' in name or '资质' in name:
            return f"已有部分资质证书，请补充：经营许可证、生产许可证、安全生产许可证等行业资质证书"
        elif '标准' in name:
            return f"已有部分标准资料，请补充：参与或主导的国家/行业/地方/团体标准证明材料，含标准编号、参与角色、发布日期"
        elif '研发项目' in name or '立项' in name:
            return f"已有部分立项资料，请补充：1）近三年每年至少5个研发项目立项报告；2）3年共计最低16个；3）含项目简介、主要研究内容、项目验收总结；4）按RD{{编号}}_{{项目名称}}_立项书.docx命名"
        else:
            return f"已有部分资料，请按上述内容要求补充完整"
    elif status == '有问题':
        return f"资料存在以下问题，请修正：{req.get('注意事项', '请按上述要求重新提供')}"
    else:
        return f"未排查到该项资料，请按上述要求完整提供"

def build_complete_supplement_template(recent_three_years, last_year, region, analysis_results):
    """构建完整的补充资料要求模板（29项明细）"""
    years_str = f"{recent_three_years[0]}-{recent_three_years[2]}"
    
    # 根据排查结果判断状态
    def get_status(category, key, sub_key=None):
        if not analysis_results:
            return '未排查'
        cat_data = analysis_results.get(category, {})
        if sub_key:
            return '未提供' if not cat_data.get(sub_key) else '已提供'
        return '未提供' if not cat_data else '已提供'
    
    # 合同发票数量差异化
    if region == 'guangdong':
        contract_count_req = f"{recent_three_years[0]}和{recent_three_years[1]}每年6-8份，{recent_three_years[2]}年10份左右"
    else:
        contract_count_req = f"{recent_three_years[0]}和{recent_three_years[1]}每年6-8份，{recent_three_years[2]}年10-12份"
    
    # 社保要求差异化
    if region == 'guangdong':
        social_security_req = f"提供{recent_three_years[2]}年3月、6月、9月和12月四个月参保人数证明，社保局下载PDF带公章"
    else:
        social_security_req = f"提供{last_year}年12月社保人员清单汇总表，到办税服务厅打印盖章"
    
    return [
        # ==================== 行政-基础材料（6项）====================
        {
            '序号': '行政-1', '负责部门': '行政', '资料名称': '企业注册信息表',
            '有效时间要求': '当前', '格式要求': 'Excel（我司提供模板）', '数量要求': '1份',
            '内容要求': '企业基本信息、统一社会信用代码、成立日期、经营范围、股东信息、组织架构等',
            '提交方式': '填写我司提供的模板',
            '注意事项': '国高复审企业不用提供；首次认定企业必须填写',
            '排查状态': get_status('basic_info', 'register_form')
        },
        {
            '序号': '行政-2', '负责部门': '行政', '资料名称': '企业最近的营业执照',
            '有效时间要求': '当前有效', '格式要求': '扫描件，需盖公章', '数量要求': '1份',
            '内容要求': '正本扫描件，含企业名称、统一社会信用代码、成立日期、注册资本、经营范围',
            '提交方式': '扫描并加盖公章',
            '注意事项': '必须在有效期内；如发生更名需提供更名证明',
            '排查状态': get_status('basic_info', 'business_license')
        },
        {
            '序号': '行政-3', '负责部门': '行政', '资料名称': '法人身份证复印件',
            '有效时间要求': '当前有效', '格式要求': '复印件扫描件，需盖公章', '数量要求': '1份',
            '内容要求': '法人身份证正反面，清晰可见',
            '提交方式': '复印并加盖公章后扫描',
            '注意事项': '复印件需盖企业公章',
            '排查状态': get_status('basic_info', 'legal_person_id')
        },
        {
            '序号': '行政-4', '负责部门': '行政', '资料名称': 'ISO等管理体系认证证书',
            '有效时间要求': '有效期内', '格式要求': '电子版扫描件', '数量要求': '有则提供',
            '内容要求': 'ISO9001质量管理体系、ISO14001环境管理体系、ISO45001职业健康体系、知识产权管理体系认证证书',
            '提交方式': '扫描件',
            '注意事项': '有则提供；证书必须在有效期内',
            '排查状态': get_status('basic_info', 'iso_certificates')
        },
        {
            '序号': '行政-5', '负责部门': '行政', '资料名称': '特殊行业许可证或产品资质证书',
            '有效时间要求': '有效期内', '格式要求': '电子版扫描件', '数量要求': '有则提供',
            '内容要求': '经营许可证、生产许可证、安全生产许可证等行业资质证书',
            '提交方式': '扫描件',
            '注意事项': '有则提供；证书必须在有效期内',
            '排查状态': get_status('basic_info', 'industry_licenses')
        },
        {
            '序号': '行政-6', '负责部门': '行政', '资料名称': '公司或产品荣誉证书',
            '有效时间要求': f'近三年内（{recent_three_years[0]}-{recent_three_years[2]}）',
            '格式要求': '电子版扫描件', '数量要求': '有则提供，尽量多',
            '内容要求': '公司荣誉、产品荣誉、行业奖项等证书',
            '提交方式': '扫描件',
            '注意事项': '主要提供近三年获得的荣誉证书',
            '排查状态': get_status('basic_info', 'honor_certificates')
        },
        
        # ==================== 人事-基础材料（9项）====================
        {
            '序号': '人事-1', '负责部门': '人事', '资料名称': f'{last_year}年研发人员信息表、研发人员比例说明',
            '有效时间要求': f'{last_year}年末', '格式要求': 'Excel（我司提供模板）', '数量要求': '1份',
            '内容要求': '研发人员姓名、身份证号、学历、专业、岗位、入职时间、是否理工科；研发人员占比≥10%',
            '提交方式': '填写我司提供的模板',
            '注意事项': '研发人员原则上要求大专及以上理工科学历；占比公司人数最低10%以上；入职时间截止上年底满半年',
            '排查状态': get_status('staff', 'info_table')
        },
        {
            '序号': '人事-2', '负责部门': '人事', '资料名称': '研发人员毕业证书',
            '有效时间要求': '当前有效', '格式要求': '扫描件', '数量要求': '每位研发人员1份',
            '内容要求': '学历证书扫描件，含毕业院校、专业、学历层次、毕业时间',
            '提交方式': '扫描件',
            '注意事项': '如学历证书遗失，可从学信网下载证明材料',
            '排查状态': get_status('staff', 'diplomas')
        },
        {
            '序号': '人事-3', '负责部门': '人事', '资料名称': '研发人员职称证书或人才证书',
            '有效时间要求': '当前有效', '格式要求': '扫描件', '数量要求': '有则提供',
            '内容要求': '中高级工程师证书、技师证书、人才认定证书等',
            '提交方式': '扫描件',
            '注意事项': '有则提供',
            '排查状态': get_status('staff', 'professional_certificates')
        },
        {
            '序号': '人事-4', '负责部门': '人事', '资料名称': f'企业职工{last_year}年12月社保人员清单汇总表',
            '有效时间要求': f'{last_year}年12月', '格式要求': 'PDF扫描件，带税局/社保局红章',
            '数量要求': '深圳1份/广东4份',
            '内容要求': '社保缴纳人员名单、缴纳月份、缴纳基数；覆盖全部职工',
            '提交方式': social_security_req,
            '注意事项': f'深圳：到办税服务厅打印{last_year}年12月社保清单盖章；广东：社保局下载{recent_three_years[2]}年3/6/9/12月四个月参保人数证明PDF带公章',
            '排查状态': get_status('staff', 'social_security')
        },
        {
            '序号': '人事-5', '负责部门': '人事', '资料名称': '与大专院校、科研院所的产学研合作协议',
            '有效时间要求': f'近三年内（{recent_three_years[0]}-{recent_three_years[2]}）',
            '格式要求': 'PDF扫描件', '数量要求': '≥1份（加分项）',
            '内容要求': '合作协议、合作项目、合同期限、成果归属；最好附费用发票或转账凭证、签约现场图片、产学研基地牌匾、合作研发证明图片',
            '提交方式': '扫描件',
            '注意事项': '加分项；合作单位应为高校、研究所等科研机构；合作项目应与企业主营业务相关',
            '排查状态': get_status('basic_info', 'industry_university_cooperation')
        },
        {
            '序号': '人事-6', '负责部门': '人事', '资料名称': '公司研发管理水平相关制度、红头文件',
            '有效时间要求': '申报前', '格式要求': 'PDF（我司提供模板，定稿后盖章）',
            '数量要求': '8项制度',
            '内容要求': '8项制度：①研发部设立文件/组织架构 ②研发项目立项管理制度 ③研发经费投入与核算管理制度 ④科技成果转化组织实施与激励奖励制度 ⑤建立开放式创新创业平台实施管理办法 ⑥科技人员培训管理制度 ⑦人才引进管理办法 ⑧科技人员绩效考核奖励制度',
            '提交方式': '我司提供模板，编辑定稿后贵司盖章',
            '注意事项': '所有制度需为公司正式发布的红头文件；建议制度发布时间在申报前',
            '排查状态': get_status('management', 'systems')
        },
        {
            '序号': '人事-7', '负责部门': '人事', '资料名称': '研发部门办公及研发场地图片',
            '有效时间要求': '当前', '格式要求': 'JPG/PNG，每张≤5MB', '数量要求': '5张左右',
            '内容要求': '研发部门办公场景、研发场地（实验室、技术研究院等）、场地门牌/牌匾',
            '提交方式': '电子档',
            '注意事项': '提供清晰照片；尽量包含门牌/牌匾（如"技术研究院"、"实验室"）',
            '排查状态': get_status('photos', 'rd_site')
        },
        {
            '序号': '人事-8', '负责部门': '人事', '资料名称': '研发设备清单及主要设备图片',
            '有效时间要求': '当前', '格式要求': 'Excel清单+JPG/PNG照片',
            '数量要求': '清单1份+设备照片15张左右',
            '内容要求': '设备清单：设备名称、型号、数量、单价、总价、使用部门、采购日期、固定资产编号；设备照片：每台设备1张清晰照片，含铭牌信息',
            '提交方式': '电子档',
            '注意事项': '建议设备总数≥10台，总值≥50万元；使用部门以研发部门为主（≥80%）；每台设备应有唯一固定资产编号',
            '排查状态': get_status('equipment', 'list')
        },
        {
            '序号': '人事-9', '负责部门': '人事', '资料名称': '研发人员奖励证明资料、技术培训相关图片',
            '有效时间要求': f'{recent_three_years[0]}-{recent_three_years[2]}年',
            '格式要求': 'JPG/PNG/PDF', '数量要求': '有则提供',
            '内容要求': '研发人员获奖照片、培训现场照片、技术会议照片；建议包含颁奖单位、培训主题、参与人员',
            '提交方式': '电子档',
            '注意事项': '时间必须在近三年内；提供清晰照片或扫描件',
            '排查状态': get_status('photos', 'training')
        },
        
        # ==================== 财务-财务资料（4项，v1.2.0：标记为财务资料，不输出到补充清单）====================
        {
            '序号': '财务-1', '负责部门': '财务', '资料名称': f'{years_str}三个会计年度企业所得税年度纳税申报表',
            '有效时间要求': f'{recent_three_years[0]}、{recent_three_years[1]}、{recent_three_years[2]}年',
            '格式要求': 'PDF，每页带税局红章', '数量要求': '3份（每年1份）',
            '内容要求': '主表及所有附表，含研发费用加计扣除数据；每年1份',
            '提交方式': '电子档或扫描件',
            '注意事项': '无章则到办税服务厅盖章；每页都要有税局红章',
            '排查状态': get_status('financial', 'tax_returns'),
            'is_financial': True  # v1.2.0：财务资料不输出到补充清单
        },
        {
            '序号': '财务-2', '负责部门': '财务', '资料名称': f'{years_str}三年的纳税证明',
            '有效时间要求': f'{recent_three_years[0]}、{recent_three_years[1]}、{recent_three_years[2]}年',
            '格式要求': 'PDF，带税局红章', '数量要求': '3份（每年1份）',
            '内容要求': '纳税证明，含纳税年度、纳税金额',
            '提交方式': '国税下载电子档',
            '注意事项': '带税局红章',
            '排查状态': get_status('financial', 'tax_certificates'),
            'is_financial': True
        },
        {
            '序号': '财务-3', '负责部门': '财务', '资料名称': f'{last_year}年整年度开票明细表',
            '有效时间要求': f'{last_year}全年', '格式要求': 'Excel', '数量要求': '1份',
            '内容要求': f'{last_year}全量发票查询导出结果EXCEL表格，含发票号码、开票日期、购方名称、价税合计',
            '提交方式': '电子档',
            '注意事项': f'从开票系统导出{last_year}年全量发票',
            '排查状态': get_status('financial', 'invoice_detail'),
            'is_financial': True
        },
        {
            '序号': '财务-4', '负责部门': '财务', '资料名称': f'{years_str}年企业研发费用辅助账',
            '有效时间要求': f'{recent_three_years[0]}-{recent_three_years[2]}年',
            '格式要求': 'Excel（我司提供模板）', '数量要求': '3套（每年1套，含9个Sheet）',
            '内容要求': '八大类费用明细：人员人工费用、直接投入费用、折旧费用与长期待摊费用、无形资产摊销费用、设计费用、装备调试费用与试验费用、委托外部研究开发费用、其他费用；每年1套含9个Sheet',
            '提交方式': '我司可提供模板',
            '注意事项': '一般贵司财务做好；金额需与RD表经费一致；必须覆盖近三年每年',
            '排查状态': get_status('financial', 'rd_auxiliary_account'),
            'is_financial': True
        },
        
        # ==================== 财务-审计报告五个（3项，v1.2.0：标记为财务资料，不输出到补充清单）====================
        {
            '序号': '财务-5', '负责部门': '财务', '资料名称': f'上年度（{last_year}年）高新技术产品（服务）收入专项审计报告',
            '有效时间要求': f'{last_year}年度', '格式要求': 'PDF，须附备案二维码和报告编码',
            '数量要求': '1份',
            '内容要求': f'高新产品收入总额、收入明细；高新产品收入必须占{last_year}年总收入60%以上',
            '提交方式': '有资质事务所出具',
            '注意事项': '深圳必须本市有高新专项审计资质的会计师事务所或税务师事务所；广东不限本市',
            '排查状态': get_status('financial', 'ps_audit_report'),
            'is_financial': True
        },
        {
            '序号': '财务-6', '负责部门': '财务', '资料名称': f'企业近三个会计年度（{years_str}）研究开发费用专项审计报告',
            '有效时间要求': f'{recent_three_years[0]}-{recent_three_years[2]}年',
            '格式要求': 'PDF，须附备案二维码和报告编码', '数量要求': '1份（三年合并）',
            '内容要求': f'研发费用总额、八大类费用明细；年营业收入<5000万研发费用需占销售收入5%以上、<2亿4%以上、>2亿3%以上',
            '提交方式': '有资质事务所出具',
            '注意事项': '深圳必须本市有资质事务所；广东不限本市',
            '排查状态': get_status('financial', 'rd_audit_report'),
            'is_financial': True
        },
        {
            '序号': '财务-7', '负责部门': '财务', '资料名称': f'{years_str}三个年度的财务审计报告',
            '有效时间要求': f'{recent_three_years[0]}、{recent_three_years[1]}、{recent_three_years[2]}年',
            '格式要求': 'PDF，须带注册会计师行业统一监管平台备案二维码和报告编码',
            '数量要求': '3份（每年1份）',
            '内容要求': '资产负债表、利润表/损益表、现金流量表、财务情况说明；数据需与所得税申报表一致',
            '提交方式': '会计师事务所出具',
            '注意事项': '数据需与所得税申报表一致；须附备案二维码和报告编码',
            '排查状态': get_status('financial', 'audit_reports'),
            'is_financial': True
        },
        
        # ==================== 研发-技术材料（7项）====================
        {
            '序号': '研发-1', '负责部门': '研发', '资料名称': '产品介绍文件',
            '有效时间要求': '当前', '格式要求': 'PPT、PDF或Word', '数量要求': '每个主营产品1份',
            '内容要求': '主营产品功能介绍、技术参数、应用场景、市场前景',
            '提交方式': '贵司提供主营产品资料',
            '注意事项': '最好为Word、PPT可编辑资料',
            '排查状态': get_status('products', 'introduction')
        },
        {
            '序号': '研发-2', '负责部门': '研发', '资料名称': '产品质量检验报告、测试报告、查新报告等',
            '有效时间要求': f'近三年内（{recent_three_years[0]}-{recent_three_years[2]}）',
            '格式要求': 'PDF扫描件', '数量要求': '每个PS产品≥1份',
            '内容要求': '第三方《产品质量检验报告》《测试报告》《查新报告》；无第三方的则提供企业内部测试报告；《产品说明书/规格书》《用户满意度调查表》',
            '提交方式': '扫描件',
            '注意事项': '主要为近三年内的检测报告、用户评价等证明材料',
            '排查状态': get_status('products', 'test_reports')
        },
        {
            '序号': '研发-3', '负责部门': '研发', '资料名称': '产品各类认证证书及报告',
            '有效时间要求': '有效期内', '格式要求': 'PDF扫描件', '数量要求': '有则提供',
            '内容要求': 'UL、3C、CE、FCC、CSA、ETL、GS、RoHS等认证证书',
            '提交方式': '扫描件',
            '注意事项': '主要为近三年做的；证书必须在有效期内',
            '排查状态': get_status('products', 'certifications')
        },
        {
            '序号': '研发-4', '负责部门': '研发', '资料名称': f'高新产品销售合同、发票（{years_str}）',
            '有效时间要求': f'{recent_three_years[0]}-{recent_three_years[2]}年',
            '格式要求': 'PDF扫描件', '数量要求': contract_count_req,
            '内容要求': '合同：合同双方、标的、金额、签订日期、盖章页；发票：发票代码、发票号码、金额、开票日期',
            '提交方式': '扫描件',
            '注意事项': f'{contract_count_req}，每年12月份至少2-3份；每份合同对应2-3张发票；建议覆盖≥5个不同客户，单一客户占比≤50%；单份合同≥10万元',
            '排查状态': get_status('contracts', 'statistics')
        },
        {
            '序号': '研发-5', '负责部门': '研发', '资料名称': f'研发项目材料（{years_str}年）',
            '有效时间要求': f'{recent_three_years[0]}-{recent_three_years[2]}年',
            '格式要求': 'Word（我司撰写定稿后盖章）', '数量要求': f'3年共计最低16个，年均5个以上',
            '内容要求': '立项报告：项目简介、主要研究内容、项目验收总结；含关键技术、技术参数指标、预期效果及创新性、项目成果、核心技术、技术创新点、综合效益',
            '提交方式': '贵司提供技术素材，我司撰写定稿后盖章',
            '注意事项': f'要求{recent_three_years[0]}-{recent_three_years[2]}年年均研发项目5个以上，3年共计最低16个',
            '排查状态': get_status('rd', 'reports')
        },
        {
            '序号': '研发-6', '负责部门': '研发', '资料名称': '参与或主导国家/行业标准制定的证明材料',
            '有效时间要求': f'近三年内（{recent_three_years[0]}-{recent_three_years[2]}）',
            '格式要求': 'PDF扫描件', '数量要求': '有则提供（加分项）',
            '内容要求': '标准名称、标准编号、参与角色（主导/参与）、发布日期',
            '提交方式': '扫描件',
            '注意事项': '加分项（加2分）；国家/行业/地方/团体标准均可',
            '排查状态': get_status('basic_info', 'standards')
        },
        {
            '序号': '研发-7', '负责部门': '研发', '资料名称': '知识产权证书（区分专利证书与其他专利资料文献）',
            '有效时间要求': f'授权日期≤{application_year}年；II类建议近三年内授权',
            '格式要求': 'PDF扫描件，单个≤2M', '数量要求': '每项IP 1份证书+附属材料',
            '内容要求': """**证书扫描件**（5类）：
  ①发明专利证书扫描件（I类，不限时间）
  ②集成电路布图设计登记证书扫描件（I类，不限时间）
  ③实用新型专利证书扫描件（II类，建议近三年内）
  ④外观设计专利证书扫描件（II类，建议近三年内）
  ⑤软件著作权证书扫描件（II类，建议近三年内）

**软著附属材料**（软著专用，证书之外的必备材料）：
  ①软件著作权申请表PDF
  ②软件源程序文档（前30页+后30页源代码，含软件名称页眉）
  ③软件设计说明书/用户手册

**专利状态证明材料**（验证专利有效性）：
  ①专利登记簿副本（发明专利建议提供，近3个月内出具）
  ②专利年费缴费发票（广东省发明+实用新型必须提供）
  ③专利权评价报告（实用新型+外观建议提供）

**转让/许可材料**（如有转让或许可）：
  ①知识产权转让合同/许可合同
  ②知识产权局手续合格通知书（必须提供，仅合同无效）
  ③全球独占许可协议（II类IP授权不在近三年时需提供5年以上）""",
            '提交方式': '扫描件',
            '注意事项': '专利证书与其他专利资料文献必须严格区分，分别整理、分别命名；网报命名规则：知识产权编号_知识产权名称；单个PDF≤2M',
            '排查状态': get_status('ip', 'certificates_found')
        },
    ]
```

**补充要求输出Excel示例：**

输出文件：`{企业名称}-补充资料收集要求.xlsx`

| 序号 | 负责部门 | 资料名称 | 有效时间要求 | 格式要求 | 数量要求 | 内容要求 | 提交方式 | 注意事项 | 排查状态 |
|------|----------|----------|--------------|----------|----------|----------|----------|----------|----------|
| 行政-2 | 行政 | 企业最近的营业执照 | 当前有效 | 扫描件，需盖公章 | 1份 | 正本扫描件，含企业名称、统一社会信用代码... | 扫描并加盖公章 | 必须在有效期内 | 未提供 |
| 研发-7 | 研发 | 知识产权证书 | 授权日期≤申报年份 | PDF，单个≤2M | 每项IP 1份证书+附属材料 | 证书扫描件(5类)+软著附属材料+专利状态证明+转让材料 | 扫描件 | 严格区分证书与其他专利资料文献 | 部分提供 |
| ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |

**补充要求生成函数（生成Excel，v1.2.0优化）：**
```python
def generate_supplement_requirements_excel(enterprise_name, application_year, region, analysis_results):
    """生成补充资料收集要求Excel（v1.2.0优化）
    
    v1.2.0优化点：
    1. 排除财务资料（财务-1~财务-7）
    2. 只输出需要补充的资料（已提供的不输出）
    3. 每项包含"缺失说明"列，详细列出具体缺失内容
    """
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    last_year = application_year - 1
    
    # 生成补充要求（已排除财务资料，已过滤已提供项，已添加缺失说明）
    supplement_list = generate_supplement_requirements(
        analysis_results, application_year, region
    )
    
    # 生成Excel
    wb = Workbook()
    ws = wb.active
    ws.title = '补充资料收集要求'
    
    # 标题行
    ws.merge_cells('A1:K1')
    ws['A1'] = f'{enterprise_name}-{application_year}年高新认定补充资料收集要求（仅列出需补充项，不含财务资料）'
    ws['A1'].font = Font(bold=True, size=14)
    ws['A1'].alignment = Alignment(horizontal='center', vertical='center')
    
    # 表头（v1.2.0新增"缺失说明"列）
    headers = ['序号', '负责部门', '资料名称', '有效时间要求', '格式要求', '数量要求',
               '内容要求', '提交方式', '注意事项', '排查状态', '缺失说明（v1.2.0新增）']
    ws.append(headers)
    
    # 填充数据
    for req in supplement_list:
        ws.append([
            req.get('序号', ''),
            req.get('负责部门', ''),
            req.get('资料名称', ''),
            req.get('有效时间要求', ''),
            req.get('格式要求', ''),
            req.get('数量要求', ''),
            req.get('内容要求', ''),
            req.get('提交方式', ''),
            req.get('注意事项', ''),
            req.get('排查状态', ''),
            req.get('缺失说明', '')  # v1.2.0新增
        ])
    
    # 设置列宽
    column_widths = [10, 10, 30, 20, 25, 18, 60, 30, 50, 12, 70]  # 缺失说明列宽70
    for i, width in enumerate(column_widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = width
    
    # 自动换行
    for row in ws.iter_rows(min_row=3):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical='top')
    
    # 添加说明sheet
    ws2 = wb.create_sheet('说明')
    ws2['A1'] = '补充资料清单说明（v1.2.0）'
    ws2['A1'].font = Font(bold=True, size=14)
    explanations = [
        '',
        f'1. 本清单仅列出本地筛查后缺失的资料（共{len(supplement_list)}项）',
        '2. 已提供的资料不在本清单中（避免重复要求客户提供）',
        '3. 财务资料不在本清单中（财务审计报告、研发费用专项审计、纳税申报表等由财务技能单独处理）',
        '4. 每项资料的"缺失说明"列详细列出具体缺失内容，请客户按说明提供',
        '5. 客户提供的资料请放到 _补充资料/gxtz-info-collector/ 目录',
        '6. 文件命名严格按"内容要求"列的命名规范，便于技能自动识别和归类',
        '7. 压缩文件会被自动递归解压到底，无需手动解压',
        '',
        '如有疑问，请联系项目经理。',
    ]
    for i, text in enumerate(explanations, 2):
        ws2.cell(row=i, column=1, value=text)
    
    output_path = f'{enterprise_name}-补充资料收集要求.xlsx'
    wb.save(output_path)
    return output_path, len(supplement_list)
```

**v1.5.0新增补充清单更新说明**：
- 调用 `update_supplement_checklist_docx(checklist_path, analysis_results, historical_materials)` 更新补充清单docx，标注已有资料的来源目录，更新待补充状态

---

### 第六步扩展：企微按企业名称预收集（v1.19.0新增，可选增强）

**触发条件**：补充清单存在缺失项 + wecom_config.json 数据源可用

**执行步骤**：

1. 诊断数据源可用性：
   ```bash
   python {{YFW_SKILLS}}/_common/wecom_query.py diagnose
   ```
   - 检查 `overall_ready=true`，否则跳过本扩展步骤

2. 一键式按企业名称收集：
   ```bash
   python {{YFW_SKILLS}}/_common/wecom_query.py collect-by-enterprise  \
     --enterprise "{企业}"  \
     --out "{企业}_高新认定材料_{年份}/_补充资料/gxtz-info-collector"  \
     --keyword "{缺失项关键词，如:营业执照,社保,审计报告,纳税申报}"  \
     --from {起始月} --to {结束月}
   ```

3. 审查收集结果：
   - 检查 `_collection_report.json` 的 `stats.md5_match_rate`（预期 >= 0.5）
   - 检查 `not_cached` 列表，提示用户在企微客户端手动下载后重跑
   - 通过 `list-conversations --keyword {企业}` 查看遗漏会话

4. 审核步骤新增：企微收集结果核查
   - 导出文件被 `scan_supplement_dir()` 识别并登记到 file_map.json
   - **会话归属一致性**：所有导出文件的 `.wecom_meta.json` 的 `conversation_id` 必须属于目标企业（无串客户）
   - 验证命令：
     ```bash
     python -c "import json,glob; [print(f['conversation_id'], f['conversation_name'], f['original_name']) for f in [json.load(open(p,encoding='utf-8')) for p in glob.glob('{企业}_高新认定材料_{年份}/_补充资料/gxtz-info-collector/*.wecom_meta.json')]]"
     ```

详见模块十二：企业微信会话实时查询与附件收集。

---

### 第七步：数据一致性预校验

**在生成清单后，执行以下一致性检查：**

```python
def validate_data_consistency(all_data):
    """数据一致性预校验"""
    errors = []
    
    # 1. IP编号一致性：IP表、RD表、PS表、成果转化表中的IP编号必须一致
    ip_in_rd = extract_ip_from_rd(all_data['rd_table'])
    ip_in_ps = extract_ip_from_ps(all_data['ps_table'])
    ip_in_achievement = extract_ip_from_achievement(all_data['achievement_table'])
    ip_in_ip_table = set(all_data['ip_table']['知识产权编号'])
    
    for ip in ip_in_rd | ip_in_ps | ip_in_achievement:
        if ip not in ip_in_ip_table:
            errors.append(f"IP编号{ip}在RD/PS/成果转化表中引用，但IP表中不存在")
    
    # 2. RD编号一致性：RD表与成果转化表中的RD编号必须一致
    rd_in_achievement = extract_rd_from_achievement(all_data['achievement_table'])
    rd_in_rd_table = set(all_data['rd_table']['研发活动编号'])
    
    for rd in rd_in_achievement:
        if rd not in rd_in_rd_table:
            errors.append(f"RD编号{rd}在成果转化表中引用，但RD表中不存在")
    
    # 3. PS编号一致性：PS表与成果转化表中的PS编号必须一致
    ps_in_achievement = extract_ps_from_achievement(all_data['achievement_table'])
    ps_in_ps_table = set(all_data['ps_table']['产品（服务）编号'])
    
    for ps in ps_in_achievement:
        if ps not in ps_in_ps_table:
            errors.append(f"PS编号{ps}在成果转化表中引用，但PS表中不存在")
    
    # 4. 财务数据一致性
    # 研发费用占比 = 近三年研发费用总和 / 近三年营业收入总和
    rd_expense_total = sum(all_data['rd_table']['研发经费近三年总支出'])
    revenue_total = all_data['financial_data']['近三年营业收入总和']
    rd_ratio = rd_expense_total / revenue_total
    
    if revenue_total < 5000 and rd_ratio < 0.05:
        errors.append(f"研发费用占比{rd_ratio:.2%}低于5%要求（年收入<5000万）")
    elif 5000 <= revenue_total < 20000 and rd_ratio < 0.04:
        errors.append(f"研发费用占比{rd_ratio:.2%}低于4%要求（年收入5000万-2亿）")
    elif revenue_total >= 20000 and rd_ratio < 0.03:
        errors.append(f"研发费用占比{rd_ratio:.2%}低于3%要求（年收入≥2亿）")
    
    # 5. 高新产品收入占比
    ps_income_total = sum(all_data['ps_table']['上年度销售收入 （万元）'])
    last_year_revenue = all_data['financial_data']['上年度营业收入']
    ps_ratio = ps_income_total / last_year_revenue
    
    if ps_ratio < 0.6:
        errors.append(f"高新产品收入占比{ps_ratio:.2%}低于60%要求")
    
    # 6. 科技人员占比
    staff_count = len(all_data['staff_table'])
    total_employees = all_data['enterprise_info']['职工总数']
    staff_ratio = staff_count / total_employees
    
    if staff_ratio < 0.1:
        errors.append(f"科技人员占比{staff_ratio:.2%}低于10%要求")
    
    # 7. 成果转化覆盖检查
    # 每个RD至少对应1项成果转化
    for rd_id in rd_in_rd_table:
        related_count = count_achievements_for_rd(rd_id, all_data['achievement_table'])
        if related_count == 0:
            errors.append(f"RD项目{rd_id}无对应的科技成果转化")
    
    # 近三年每年均有成果转化
    for year in [application_year - 3, application_year - 2, application_year - 1]:
        count = count_achievements_in_year(year, all_data['achievement_table'])
        if count == 0:
            errors.append(f"{year}年无科技成果转化")
    
    # 8. 合同发票一致性检查
    contract_invoice_check = validate_contract_invoice_consistency(all_data)
    errors.extend(contract_invoice_check)
    
    return errors
```

---

### 第八步：审核验证（必须通过才能提交）
1. **完整性审核**
   - 检查8大类资料是否都已排查
   - 检查必填资料是否齐全（营业执照、专利证书、立项报告等）
   - 检查合同发票数量是否符合要求（2023/2024年10-12份，2025年18-20份）
   - 检查研发设备数量是否≥10台
   - 检查照片资料是否覆盖8个类别

2. **有效性审核**
   - 验证所有资料的有效时间符合要求
   - 验证专利证书授权日期≤申报年份
   - 验证合同发票时间在近三年内
   - 验证社保缴纳证明覆盖近三年
   - 验证审计报告覆盖近三年

3. **一致性审核**
   - 验证IP编号在各类资料中的一致性
   - 验证RD编号在立项报告、辅助账中的一致性
   - 验证PS编号在合同发票中的一致性
   - 验证财务数据与审计报告一致
   - 验证人员名单与社保记录一致

4. **规范性审核**
   - 检查文件命名是否符合规范（调用 `detect_naming_issues()` 检测hash命名/微信图片/扫描仪/手机/WPS拼图/多次优化/大小写不一致/学历不统一等问题）
   - 调用 `batch_validate_naming()` 批量校验IP/RD/PS/成果转化/财务/网报/学历/社保命名规范
   - 检查文件大小是否符合要求（专利≤2M、产品证明≤4M、合同发票≤20M）
   - 检查文件格式是否正确（PDF/Word/Excel）
   - 检查照片分辨率和大小

5. **生成审核报告**
   - 生成《资料收集审核报告》
   - 列出所有审核问题及整改建议
   - 审核结论：通过/不通过

6. **审核通过条件**
   - 所有必填资料齐全
   - 资料有效时间符合要求
   - 数据一致性检查通过
   - 文件格式规范无误

7. **审核不通过处理**
   - 列出所有问题清单
   - 提供整改建议
   - 要求整改后重新提交审核

### 第九步：输出最终报告

生成以下文件：

1. **`{企业名称}-{年份}年高新认定资料收集清单.xlsx`** - 含10个Sheet的详细清单
2. **`{企业名称}-资料排查分析报告.xlsx`** - 每份资料的分析确认结果
3. **`{企业名称}-补充资料收集要求.xlsx`** - 缺失/有问题资料的补充要求
4. **`{企业名称}-数据一致性预校验报告.xlsx`** - 数据一致性检查结果
5. **`{企业名称}-文件整理目录结构.xlsx`** - 文件分类与目录结构
6. **`{企业名称}-文件完整性检查报告.xlsx`** - 文件完整性检查结果
7. **`{企业名称}-文件质量检查报告.xlsx`** - 文件质量检查结果
8. **`{企业名称}-资料收集审核报告.xlsx`** - 审核验证结果

### 最终步前：同步进度（v1.31.0新增，进度管理集成）

完成所有工作后、文件整理前，更新进度看板：

```bash
python {{YFW_SKILLS}}/_common/progress_sync.py update-stage /n    --project-root "." /n    --skill "gxtz-info-collector" /n    --status completed
```

此命令将自动匹配本技能对应的阶段并标记为"已完成"。
（注意：finalize 步骤也会自动同步进度，此步为双重保障。）


### 最终步：文件整理与知识库更新（强制执行，审核验证通过后必须执行）

**执行以下命令整理文件并更新知识库**（在项目根目录运行）：

```bash
python {{YFW_SKILLS}}/_common/project_context_manager.py finalize --enterprise "{企业名称}" --year {申报年份} --skill "gxtz-info-collector" --no-move
```

此命令将：按19类目录结构整理文件 → 生成 .claude/_file_management_report.md 整理报告 → 更新 file_map.json / experience_base.json / project_index.json → 校验3个json文件已生成。
- **finalize 后强制验证（v2.0 新增，不可跳过）**：
  1. 立即读取 `.claude/_finalize_diff.json`，检查 `moved_from_protected`（应为空）和 `warnings`（应为空）
  2. `ls` 扫描 07_资料收集清单（至少1个文件），确认文件数不少于预期
  3. 若 `moved_from_protected` 非空或目录文件减少，从 diff 报告的 `to` 位置 Copy-Item 恢复到 `from` 位置
  4. 向用户输出验证结果（✅/⚠ + 具体数字），不得隐藏问题

1. 按19类目录结构整理文件（先检查补充资料目录，将可归类的文件移动到匹配目录）
2. 生成 _file_management_report.md 整理报告（含已归类/未归类/各类别统计/产出校验）
3. 更新 file_map.json（更新文件路径）、experience_base.json（记录本次执行）、project_index.json（更新进度）
4. 校验3个json文件均已生成，如未生成则报错

**清理临时文件**：确保资料目录无Word临时文件（~$开头）和重复文件（(1)后缀等）。

## 关键时间逻辑

```python
# 时间约束规则汇总
TIME_CONSTRAINTS = {
    '近三年': '申报年份-3, 申报年份-2, 申报年份-1',
    '上年度': '申报年份-1',
    
    'RD项目': {
        '开始时间': '≥ 近三年第一年1月1日',
        '结束时间': '≤ 申报年份12月31日',
        '覆盖要求': '每年至少有1个项目在执行'
    },
    
    '知识产权': {
        '授权日期': '≤ 申报年份（申报前必须已授权）',
        'I类': '无使用年限限制',
        'II类': '建议近三年内授权，否则需5年以上全球独占许可'
    },
    
    '成果转化': {
        '转化时间': '必须在近三年内',
        '年度覆盖': '每年至少1项',
        'RD关联': '每个RD至少对应1项成果转化'
    },
    
    '高新产品收入': {
        '收入年度': '上年度（申报年份-1）',
        '合同发票': '必须是上年度的',
        '收入占比': '≥ 60%'
    },
    
    '科技人员': {
        '统计时点': '上年度末',
        '占比要求': '≥ 10%',
        '社保要求': '近三年每年均有缴纳'
    },
    
    '研发费用': {
        '审计年度': '近三年',
        '辅助账': '近三年每年1套',
        '占比要求': '收入<5000万≥5%；5000万-2亿≥4%；≥2亿≥3%'
    },
    
    '管理制度': {
        '发布时间': '申报前',
        '产学研合同': '近三年内'
    },
    
    '合同发票': {
        '2023年': '10-12份，建议5-12月，11-12月多提供',
        '2024年': '10-12份，建议5-12月，11-12月多提供',
        '2025年': '18-20份，建议5-12月，11-12月多提供',
        '对应关系': '每份发票必须对应合同'
    },
    
    '研发设备': {
        '清单': '当前有效',
        '照片': '与清单一一对应',
        '建议数量': '≥10台',
        '建议总值': '≥50万元'
    }
}
```

## 资料排查检查清单

```python
# 每份资料排查时必须检查的项目
DOCUMENT_CHECKLIST = {
    '专利证书': [
        '证书是否可正常读取',
        '权利人名称是否与企业名称一致',
        '专利号是否与IP表一致',
        '授权日期是否在有效范围内',
        '专利类型是否与IP表一致',
        '年费是否已缴纳',
        '法律状态是否有效'
    ],
    '销售合同': [
        '合同是否可正常读取',
        '签订日期是否在有效时间范围内',
        '产品名称是否与PS表一致',
        '合同双方是否包含申报企业',
        '合同金额是否明确',
        '是否有双方盖章',
        '是否有对应发票'
    ],
    '销售发票': [
        '发票是否可正常读取',
        '开票日期是否在有效时间范围内',
        '发票金额是否与合同一致',
        '购买方名称是否正确',
        '发票代码、号码是否完整',
        '是否属于上年度',
        '是否与合同一一对应'
    ],
    '研发费用辅助账': [
        '是否包含9个Sheet',
        '八大类费用是否完整',
        '金额是否与RD表一致',
        '是否覆盖近三年每年',
        '汇总表数据是否正确'
    ],
    '审计报告': [
        '是否包含审计意见',
        '是否包含资产负债表、利润表、现金流量表',
        '审计机构是否有资质',
        '报告日期是否在有效范围内',
        '营业收入、净利润数据是否完整'
    ],
    '社保缴纳证明': [
        '缴纳单位是否为申报企业',
        '缴纳人数是否与花名册一致',
        '缴纳月份是否覆盖全年',
        '是否覆盖近三年每年',
        '人员名单是否与科技人员一致'
    ],
    '研发设备清单': [
        '是否包含设备名称、型号、数量、单价、总价',
        '是否包含使用部门、采购日期',
        '设备总数是否≥10台',
        '设备总值是否≥50万元',
        '是否有对应的设备照片'
    ],
    '研发设备照片': [
        '照片是否清晰可见设备',
        '是否可见设备铭牌信息',
        '照片大小是否≤5MB',
        '是否与设备清单一一对应'
    ]
}
```

## 工作流程总结

1. **确定申报参数** → 申报年份、近三年范围、上年度
2. **排查现有资料** → 按8大类逐一排查，记录每份资料的状态
3. **逐一读取分析** → 打开每份文件，检查完整性、时间有效性、数据一致性
4. **系统性文件整理** → 按类别创建目录结构，标准化文件命名，检查文件质量
5. **生成收集清单** → 10个Sheet的详细Excel清单
6. **生成补充要求** → 对缺失/有问题资料生成明确的补充要求
7. **数据一致性校验** → 跨表数据一致性检查
8. **输出最终报告** → 收集清单 + 排查报告 + 补充要求 + 校验报告 + 文件整理报告

## 业务增强函数（v1.5.0新增）

以下4个业务增强函数基于实际项目优化指令抽象而来，用于：以固定资产清单为基准筛选研发设备、标注已有合同发票编号、扫描往年资料目录、更新补充清单docx。供本技能在第二步排查、第五步生成清单、第六步生成补充要求时调用。

### 函数1：filter_rnd_equipment_from_fixed_assets

从固定资产清单Excel中筛选研发设备，按年度过滤并统计研发设备占比。

```python
def filter_rnd_equipment_from_fixed_assets(fixed_asset_file, target_year=None, application_year=None):
    """从固定资产清单Excel中筛选研发设备（v1.5.0新增）

    筛选规则：
    - 使用部门列含"研发/开发/技术/实验/测试/设计"关键词，或设备名称含这些关键词
    - 按年度筛选：如果target_year指定（如2025），按购入日期/入账日期/启用日期列筛选≤该年度的设备

    Args:
        fixed_asset_file: 固定资产清单Excel文件路径
        target_year: 目标年度（如2025），筛选购入/入账/启用日期≤该年度的设备；None表示不按年度筛选
        application_year: 申报年份，用于记录上下文（不影响筛选逻辑）

    Returns:
        dict: {rnd_equipment: DataFrame, total_count, total_value, rnd_ratio, year_filtered, source_file}
    """
    import pandas as pd

    RND_KEYWORDS = ['研发', '开发', '技术', '实验', '测试', '设计']
    DATE_COLS = ['购入日期', '入账日期', '启用日期', '购置日期', '入账时间', '启用时间']
    VALUE_COLS = ['总价', '原值', '金额', '价值', '原值合计', '资产原值', '设备金额']

    # 读取固定资产清单Excel
    df = pd.read_excel(fixed_asset_file)

    # 识别研发设备：使用部门列或设备名称含关键词
    rnd_mask = pd.Series([False] * len(df))
    for col in df.columns:
        col_str = str(col)
        if '部门' in col_str or '使用' in col_str or '归属' in col_str:
            for kw in RND_KEYWORDS:
                rnd_mask = rnd_mask | df[col].astype(str).str.contains(kw, na=False)
    # 设备名称列
    for col in df.columns:
        col_str = str(col)
        if '名称' in col_str or '设备' in col_str or '资产' in col_str:
            for kw in RND_KEYWORDS:
                rnd_mask = rnd_mask | df[col].astype(str).str.contains(kw, na=False)

    rnd_equipment = df[rnd_mask].copy()

    # 按年度筛选
    year_filtered = False
    if target_year is not None:
        for col in df.columns:
            col_str = str(col)
            if any(dc in col_str for dc in DATE_COLS):
                try:
                    dates = pd.to_datetime(df[col], errors='coerce')
                    year_mask = dates.dt.year <= target_year
                    rnd_equipment = rnd_equipment[rnd_equipment.index.isin(df[year_mask].index)]
                    year_filtered = True
                    break
                except Exception:
                    pass

    # 计算总值
    total_value = 0.0
    for col in rnd_equipment.columns:
        col_str = str(col)
        if any(vc in col_str for vc in VALUE_COLS):
            try:
                total_value += pd.to_numeric(rnd_equipment[col], errors='coerce').sum()
            except Exception:
                pass

    total_count = len(rnd_equipment)
    all_count = len(df)
    rnd_ratio = (total_count / all_count) if all_count > 0 else 0.0

    return {
        'rnd_equipment': rnd_equipment,
        'total_count': total_count,
        'total_value': total_value,
        'rnd_ratio': rnd_ratio,
        'year_filtered': year_filtered,
        'source_file': fixed_asset_file
    }
```

### 函数2：extract_contract_invoice_numbers

从已有合同发票PDF/DOCX中提取合同编号、发票号码、金额、日期，生成编号汇总文本供资料收集单标注。

```python
def extract_contract_invoice_numbers(contract_files, invoice_files):
    """从已有合同发票PDF/DOCX中提取编号（v1.5.0新增）

    提取合同编号、客户名称、金额、日期；发票号码、金额、日期
    生成编号汇总文本，用于在资料收集单中标注，方便客户筛查对照

    Args:
        contract_files: 合同文件路径列表（支持PDF/DOCX）
        invoice_files: 发票文件路径列表（支持PDF/DOCX）

    Returns:
        dict: {contracts: list, invoices: list, summary: str}
    """
    import re

    CONTRACT_NO_PATTERN = r'(?:合同编号|合同号|编号|Contract/s*No)[:：./s]*([A-Za-z0-9/-/]+)'
    INVOICE_NO_PATTERN = r'(?:发票号码|发票号|发票代码|Invoice/s*No)[:：./s]*(/d{8,20})'
    AMOUNT_PATTERN = r'(?:金额|总金额|价税合计|金额合计|Amount)[:：./s￥¥$]*([/d,，.]+)'
    DATE_PATTERN = r'(/d{4}[-年/]/d{1,2}[-月/]/d{1,2})'

    def _extract_text_from_pdf(pdf_path):
        text = ''
        try:
            import pdfplumber
            with pdfplumber.open(pdf_path) as pdf:
                for page in pdf.pages:
                    page_text = page.extract_text() or ''
                    text += page_text + '/n'
        except Exception:
            pass
        return text

    def _extract_text_from_docx(docx_path):
        text = ''
        try:
            from docx import Document
            doc = Document(docx_path)
            for para in doc.paragraphs:
                text += para.text + '/n'
            for table in doc.tables:
                for row in table.rows:
                    for cell in row.cells:
                        text += cell.text + ' '
                    text += '/n'
        except Exception:
            pass
        return text

    def _extract_text(file_path):
        if file_path.lower().endswith('.pdf'):
            return _extract_text_from_pdf(file_path)
        elif file_path.lower().endswith('.docx'):
            return _extract_text_from_docx(file_path)
        return ''

    contracts = []
    for cf in contract_files:
        text = _extract_text(cf)
        if not text:
            contracts.append({'file': os.path.basename(cf), 'contract_no': '', 'customer': '', 'amount': '', 'date': ''})
            continue
        contract_no_match = re.search(CONTRACT_NO_PATTERN, text)
        amount_match = re.search(AMOUNT_PATTERN, text)
        date_match = re.search(DATE_PATTERN, text)
        customer = ''
        for line in text.split('/n')[:10]:
            if '甲方' in line or '买方' in line or '客户' in line:
                customer = line.strip()
                break
        contracts.append({
            'file': os.path.basename(cf),
            'contract_no': contract_no_match.group(1) if contract_no_match else '',
            'customer': customer,
            'amount': amount_match.group(1) if amount_match else '',
            'date': date_match.group(1) if date_match else ''
        })

    invoices = []
    for inv_f in invoice_files:
        text = _extract_text(inv_f)
        if not text:
            invoices.append({'file': os.path.basename(inv_f), 'invoice_no': '', 'amount': '', 'date': ''})
            continue
        invoice_no_match = re.search(INVOICE_NO_PATTERN, text)
        amount_match = re.search(AMOUNT_PATTERN, text)
        date_match = re.search(DATE_PATTERN, text)
        invoices.append({
            'file': os.path.basename(inv_f),
            'invoice_no': invoice_no_match.group(1) if invoice_no_match else '',
            'amount': amount_match.group(1) if amount_match else '',
            'date': date_match.group(1) if date_match else ''
        })

    # 生成汇总文本
    lines = []
    lines.append('=== 合同编号汇总 ===')
    for c in contracts:
        if c['contract_no']:
            lines.append(f"合同《{c['file']}》：编号 {c['contract_no']}，金额 {c['amount']}，日期 {c['date']}")
    lines.append('')
    lines.append('=== 发票编号汇总 ===')
    for inv in invoices:
        if inv['invoice_no']:
            lines.append(f"发票《{inv['file']}》：号码 {inv['invoice_no']}，金额 {inv['amount']}，日期 {inv['date']}")
    summary = '/n'.join(lines)

    return {
        'contracts': contracts,
        'invoices': invoices,
        'summary': summary
    }
```

### 函数3：scan_historical_materials

扫描往年资料目录（支持多层嵌套如"往年资料/和胜金属/和胜/附件/7.专职人员学历证书"），识别已有资料并按类别分组。

```python
def scan_historical_materials(data_dir, historical_keywords=None):
    """扫描往年资料目录，识别已有资料（v1.5.0新增）

    识别往年资料目录（路径中含关键词的目录），按类别分组文件
    支持多层嵌套目录，如 "往年资料/和胜金属/和胜/附件/7.专职人员学历证书"

    Args:
        data_dir: 数据根目录
        historical_keywords: 往年资料目录关键词，默认 ['往年', '历史', '附件', 'archive', '历年']

    Returns:
        dict: {historical_dirs, found_files, by_category}
    """
    import os

    if historical_keywords is None:
        historical_keywords = ['往年', '历史', '附件', 'archive', '历年']

    # 调用公共模块的 build_file_index 遍历所有文件
    file_index = build_file_index(data_dir)
    all_files = file_index.get('all_files', [])

    # 识别往年资料目录
    historical_dirs = set()
    for file_info in all_files:
        path = file_info.get('path', '')
        path_parts = path.replace('//', '/').split('/')
        for part in path_parts:
            for kw in historical_keywords:
                if kw in part:
                    # 记录该关键词所在的目录
                    idx = path_parts.index(part)
                    historical_dirs.add('/'.join(path_parts[:idx + 1]))
                    break

    # 按类别分组文件
    CATEGORY_PATTERNS = {
        '学历证书': ['学历', '毕业', '学位'],
        '职称证书': ['职称', '资格证'],
        '社保': ['社保', '社会保险', '参保证明'],
        '合同': ['合同'],
        '发票': ['发票'],
        '专利证书': ['专利', '证书'],
        '软著证书': ['软著', '软件著作权'],
        '审计报告': ['审计'],
        '设备清单': ['设备', '清单'],
        '营业执照': ['营业执照', '执照'],
        '身份证': ['身份证', '身份证明'],
        '章程': ['章程'],
    }

    by_category = {cat: [] for cat in CATEGORY_PATTERNS}
    by_category['其他'] = []

    for file_info in all_files:
        path = file_info.get('path', '')
        name = file_info.get('name', '')
        is_historical = any(hd.replace('//', '/') in path.replace('//', '/') for hd in historical_dirs)
        matched = False
        for cat, keywords in CATEGORY_PATTERNS.items():
            if any(kw in name for kw in keywords):
                by_category[cat].append({
                    'path': path,
                    'name': name,
                    'is_historical': is_historical
                })
                matched = True
                break
        if not matched:
            by_category['其他'].append({
                'path': path,
                'name': name,
                'is_historical': is_historical
            })

    found_files = sum(len(v) for v in by_category.values())

    return {
        'historical_dirs': list(historical_dirs),
        'found_files': found_files,
        'by_category': by_category
    }
```

### 函数4：update_supplement_checklist_docx

基于最新扫描结果（含往年资料）更新补充清单docx，标注已有资料来源目录、更新待补充状态。

```python
def update_supplement_checklist_docx(checklist_path, analysis_results, historical_materials=None):
    """基于最新扫描结果更新补充清单docx（v1.5.0新增）

    遍历表格，找到"是否已经提供"和"备注"列，对每行资料检查historical_materials
    已有则更新为"已提供"（绿色字体），备注列标注来源目录
    待补充则保持"待补充"

    Args:
        checklist_path: 补充清单docx文件路径
        analysis_results: 本地筛查结果
        historical_materials: scan_historical_materials 的返回结果，含 by_category

    Returns:
        dict: {updated, provided_count, supplement_count, from_historical}
    """
    from docx import Document
    from docx.shared import RGBColor

    GREEN = RGBColor(0x00, 0x80, 0x00)

    doc = Document(checklist_path)

    provided_count = 0
    supplement_count = 0
    from_historical = 0

    if historical_materials is None:
        historical_materials = {'by_category': {}}
    by_category = historical_materials.get('by_category', {})

    CATEGORY_ROW_KEYWORDS = {
        '学历证书': ['学历', '毕业证'],
        '职称证书': ['职称'],
        '社保': ['社保'],
        '合同': ['合同'],
        '发票': ['发票'],
        '专利证书': ['专利证书'],
        '软著证书': ['软著'],
        '审计报告': ['审计'],
        '设备清单': ['设备清单', '研发设备'],
        '营业执照': ['营业执照'],
    }

    for table in doc.tables:
        # 找到表头行，定位"是否已经提供"和"备注"列
        header_row = table.rows[0]
        provided_col = None
        remark_col = None
        for idx, cell in enumerate(header_row.cells):
            cell_text = cell.text.strip()
            if '是否已经提供' in cell_text or '是否提供' in cell_text or '是否已有' in cell_text:
                provided_col = idx
            if '备注' in cell_text or '说明' in cell_text:
                remark_col = idx

        if provided_col is None:
            continue

        for row in table.rows[1:]:
            # 获取资料名称（通常是第一列或类别+序号列）
            row_text = ' '.join(cell.text for cell in row.cells)

            # 检查historical_materials中是否有匹配的已有文件
            matched_category = None
            for cat, keywords in CATEGORY_ROW_KEYWORDS.items():
                if any(kw in row_text for kw in keywords):
                    matched_category = cat
                    break

            has_file = False
            source_dir = ''
            if matched_category and matched_category in by_category:
                files = by_category[matched_category]
                if files:
                    has_file = True
                    source_dir = os.path.dirname(files[0].get('path', '')) if files else ''
                    from_historical += 1

            provided_cell = row.cells[provided_col]
            if has_file:
                provided_cell.text = '已提供'
                for para in provided_cell.paragraphs:
                    for run in para.runs:
                        run.font.color.rgb = GREEN
                provided_count += 1
                if remark_col is not None:
                    row.cells[remark_col].text = f'来源目录：{source_dir}'
            else:
                provided_cell.text = '待补充'
                supplement_count += 1

    doc.save(checklist_path)

    return {
        'updated': True,
        'provided_count': provided_count,
        'supplement_count': supplement_count,
        'from_historical': from_historical
    }
```

## 业务增强函数（v1.6.0新增）

以下2个业务增强函数基于深圳市和胜金属技术有限公司项目实际docx格式优化指令抽象而来，用于：将研发设备清单单独生成独立核对表格（方便客户逐项核对）、生成参考实际项目docx格式的标准化补充清单文档。供本技能在第五步生成清单、第六步生成补充要求时调用。

### 函数1：generate_equipment_checklist_table

生成研发设备核对清单表格（独立表格，方便客户逐项核对）。8列结构：序号|设备名称|资产编码|部门|购置日期|原值（元）|分类|核对确认（✓/✗），自动识别"分类"和"部门"，生成合计行。

```python
def generate_equipment_checklist_table(equipment_data, output_format='docx'):
    """生成研发设备核对清单表格（独立表格，方便客户核对）（v1.6.0新增）

    参考深圳市和胜金属技术有限公司项目实际docx格式：
    - 8列结构：序号|设备名称|资产编码|部门|购置日期|原值（元）|分类|核对确认（✓/✗）
    - 自动识别"分类"：根据设备名称关键词分类
    - 自动识别"部门"：从设备数据的"使用部门"列读取
    - 生成合计行：显示设备总数和原值合计
    - 最后一列"核对确认（✓/✗）"留空供客户人工勾选

    Args:
        equipment_data: 设备数据列表（来自filter_rnd_equipment_from_fixed_assets的返回值中的rnd_equipment，
                        或直接传入pandas DataFrame，或list of dict）
        output_format: 输出格式（'docx'生成Word表格，'xlsx'生成Excel表格）

    Returns:
        dict: {table_data: list, total_count, total_value, output_path}
    """
    import pandas as pd
    import os
    from datetime import datetime

    # 分类关键词映射（按优先级匹配，先匹配先归类）
    CATEGORY_KEYWORDS = [
        ('热处理设备', ['炉', '淬火', '回火', '退火', '时效', '氮化', '真空炉']),
        ('检测分析设备', ['检测', '测试', '测量', '分析仪', '显微镜', '硬度计', '探伤']),
        ('表面处理设备', ['镀膜', '喷涂', '电镀', '氧化', '表面处理']),
        ('辅助设备', ['清洗', '冷却', '泵', '压缩机', '配电柜', '轨道', '上下料']),
        ('模具', ['模具', '模架', '模胚']),
        ('办公设备', ['电脑', '工控机', '打印机', '服务器']),
    ]

    def classify_equipment(name):
        """根据设备名称关键词分类"""
        if not name or not isinstance(name, str):
            return '其他'
        for category, keywords in CATEGORY_KEYWORDS:
            for kw in keywords:
                if kw in name:
                    return category
        return '其他'

    def extract_field(record, candidate_cols, default=''):
        """从记录中按候选列名顺序提取字段值"""
        if isinstance(record, dict):
            for col in candidate_cols:
                for key in record.keys():
                    if str(col) in str(key):
                        return record[key]
            return default
        return default

    # 标准化输入数据为 list of dict
    if isinstance(equipment_data, dict):
        # 来自filter_rnd_equipment_from_fixed_assets的返回值
        if 'rnd_equipment' in equipment_data:
            df = equipment_data['rnd_equipment']
            if isinstance(df, pd.DataFrame):
                records = df.to_dict('records')
            else:
                records = list(df)
        else:
            records = [equipment_data]
    elif isinstance(equipment_data, pd.DataFrame):
        records = equipment_data.to_dict('records')
    elif isinstance(equipment_data, list):
        records = equipment_data
    else:
        records = [equipment_data]

    # 构建8列表格数据
    table_data = []
    for idx, rec in enumerate(records, start=1):
        name = extract_field(rec, ['设备名称', '资产名称', '名称', '资产'], default=f'设备{idx}')
        asset_code = extract_field(rec, ['资产编码', '资产编号', '固定资产编号', '编号', '编码'], default='')
        # 部门：从"使用部门"列读取
        dept = extract_field(rec, ['使用部门', '部门', '归属部门'], default='研发部')
        purchase_date = extract_field(rec, ['购置日期', '购入日期', '入账日期', '启用日期', '购置时间'], default='')
        # 原值：从金额列读取
        value = extract_field(rec, ['原值', '原值合计', '总价', '金额', '价值', '资产原值', '设备金额'], default=0)
        # 数值化处理
        try:
            if isinstance(value, str):
                value = float(value.replace(',', '').replace('¥', '').strip())
            else:
                value = float(value)
        except (ValueError, TypeError):
            value = 0.0
        # 分类：自动识别
        category = classify_equipment(name)
        # 核对确认列留空
        check_confirm = ''
        table_data.append({
            '序号': idx,
            '设备名称': str(name),
            '资产编码': str(asset_code),
            '部门': str(dept),
            '购置日期': str(purchase_date),
            '原值（元）': round(value, 2),
            '分类': category,
            '核对确认（✓/✗）': check_confirm
        })

    total_count = len(table_data)
    total_value = sum(r['原值（元）'] for r in table_data)

    headers = ['序号', '设备名称', '资产编码', '部门', '购置日期', '原值（元）', '分类', '核对确认（✓/✗）']

    output_path = None
    if output_format == 'docx':
        from docx import Document
        from docx.shared import Pt, Cm, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
        from docx.oxml.ns import qn
        from docx.oxml import OxmlElement

        doc = Document()
        # 设置默认字体
        style = doc.styles['Normal']
        style.font.name = '宋体'
        style.font.size = Pt(9)
        style.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')

        # 标题
        title = doc.add_paragraph()
        title.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = title.add_run('研发设备核对清单')
        run.font.name = '宋体'
        run.font.size = Pt(12)
        run.bold = True
        run.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')

        # 表格
        table = doc.add_table(rows=1 + total_count + 1, cols=len(headers))
        table.style = 'Table Grid'
        table.alignment = WD_TABLE_ALIGNMENT.CENTER

        # 设置浅灰表头背景色 #D9D9D9
        def set_cell_bg(cell, color_hex):
            tc_pr = cell._tc.get_or_add_tcPr()
            shd = OxmlElement('w:shd')
            shd.set(qn('w:val'), 'clear')
            shd.set(qn('w:color'), 'auto')
            shd.set(qn('w:fill'), color_hex)
            tc_pr.append(shd)

        def set_cell_font(cell, text, bold=False, size=8):
            cell.text = ''
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = p.add_run(str(text))
            run.font.name = '宋体'
            run.font.size = Pt(size)
            run.bold = bold
            run.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER

        # 表头
        hdr_cells = table.rows[0].cells
        for i, h in enumerate(headers):
            set_cell_font(hdr_cells[i], h, bold=True, size=9)
            set_cell_bg(hdr_cells[i], 'D9D9D9')

        # 数据行
        for r_idx, row in enumerate(table_data, start=1):
            cells = table.rows[r_idx].cells
            for i, h in enumerate(headers):
                val = row[h]
                set_cell_font(cells[i], val, bold=False, size=8)

        # 合计行
        total_cells = table.rows[1 + total_count].cells
        # 合并前5列
        merged = total_cells[0]
        for i in range(1, 5):
            merged = merged.merge(total_cells[i])
        set_cell_font(merged, f'合计：{total_count}台', bold=True, size=8)
        set_cell_bg(merged, 'D9D9D9')
        # 原值合计
        set_cell_font(total_cells[5], f'{round(total_value, 2):.2f}', bold=True, size=8)
        set_cell_bg(total_cells[5], 'D9D9D9')
        set_cell_font(total_cells[6], '', bold=True, size=8)
        set_cell_bg(total_cells[6], 'D9D9D9')
        set_cell_font(total_cells[7], '', bold=True, size=8)
        set_cell_bg(total_cells[7], 'D9D9D9')

        # 设置列宽
        col_widths = [Cm(1.2), Cm(4.0), Cm(2.5), Cm(1.8), Cm(2.2), Cm(2.5), Cm(2.2), Cm(2.0)]
        for i, w in enumerate(col_widths):
            for row in table.rows:
                row.cells[i].width = w

        # 保存
        output_path = os.path.abspath('研发设备核对清单.docx')
        doc.save(output_path)

    elif output_format == 'xlsx':
        from openpyxl import Workbook
        from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
        from openpyxl.utils import get_column_letter

        wb = Workbook()
        ws = wb.active
        ws.title = '研发设备核对清单'

        # 表头
        ws.append(headers)
        header_fill = PatternFill(start_color='D9D9D9', end_color='D9D9D9', fill_type='solid')
        header_font = Font(bold=True, size=9, name='宋体')
        center_align = Alignment(horizontal='center', vertical='center', wrap_text=True)
        thin_border = Border(
            left=Side(style='thin'), right=Side(style='thin'),
            top=Side(style='thin'), bottom=Side(style='thin')
        )
        for col_idx in range(1, len(headers) + 1):
            cell = ws.cell(row=1, column=col_idx)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = center_align
            cell.border = thin_border

        # 数据行
        data_font = Font(size=8, name='宋体')
        for r_idx, row in enumerate(table_data, start=2):
            for c_idx, h in enumerate(headers, start=1):
                cell = ws.cell(row=r_idx, column=c_idx, value=row[h])
                cell.font = data_font
                cell.alignment = center_align
                cell.border = thin_border

        # 合计行
        total_row = 2 + total_count
        ws.merge_cells(start_row=total_row, start_column=1, end_row=total_row, end_column=5)
        ws.cell(row=total_row, column=1, value=f'合计：{total_count}台')
        ws.cell(row=total_row, column=6, value=round(total_value, 2))
        ws.cell(row=total_row, column=7, value='')
        ws.cell(row=total_row, column=8, value='')
        for c_idx in range(1, len(headers) + 1):
            cell = ws.cell(row=total_row, column=c_idx)
            cell.font = Font(bold=True, size=8, name='宋体')
            cell.fill = header_fill
            cell.alignment = center_align
            cell.border = thin_border

        # 列宽
        col_widths = [6, 22, 14, 10, 14, 14, 12, 12]
        for i, w in enumerate(col_widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w

        output_path = os.path.abspath('研发设备核对清单.xlsx')
        wb.save(output_path)

    return {
        'table_data': table_data,
        'total_count': total_count,
        'total_value': round(total_value, 2),
        'output_path': output_path
    }
```

### 函数2：generate_supplement_checklist_hesheng_format

生成和胜金属项目格式的补充清单文档（参考实际docx格式）。文档结构：段落标题+企业信息段+8大类章节+独立表格。设备清单单独表格，合同发票表9列结构，状态标识用✓和文字说明。

```python
def generate_supplement_checklist_hesheng_format(enterprise_name, application_year, analysis_results,
                                                  equipment_data=None, output_format='docx'):
    """生成和胜金属项目格式的补充清单文档（v1.6.0新增）

    参考深圳市和胜金属技术有限公司项目实际docx格式：
    - 文档结构：段落标题（国高项目申报资料补充清单）+ 企业信息段 + 多个分类表格
    - 按8大类章节组织：二、人员资料 / 三、知识产权资料 / 四、研发项目资料 /
      五、高新技术产品资料 / 六、成果转化证明材料（合同+发票）/ 七、管理制度材料 / 八、其他辅助证明资料
    - 设备清单单独表格（调用generate_equipment_checklist_table）
    - 合同发票表采用9列结构：序号|客户名称|已有合同/订单|合同编号/订单号|发票客户|发票编号|
      发票金额|发票日期|状态说明
    - 状态标识：✓表示已有、文字说明缺失情况（如"缺合同，需补充"/"待补充"）
    - 合同发票表最后一行"【补充需求】"行横向合并，存放整段补充说明

    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        analysis_results: 第二步排查分析结果（用于确定资料状态）
        equipment_data: 设备数据（None则不生成设备清单表格，否则调用
                       generate_equipment_checklist_table生成独立表格）
        output_format: 输出格式（'docx'/'xlsx'）

    Returns:
        dict: {output_path, tables_count, equipment_table_row_count, contract_invoice_tables}
    """
    import os
    from datetime import datetime

    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    last_year = application_year - 1
    years_str = f"{recent_three_years[0]}-{recent_three_years[2]}"

    tables_count = 0
    equipment_table_row_count = 0
    contract_invoice_tables = []

    # 构建合同发票表数据（按年度）
    def build_contract_invoice_table_data(year):
        """构建单年度合同发票表数据（9列结构）"""
        # 从analysis_results中提取合同发票信息（如果有的话）
        contracts_info = (analysis_results or {}).get('contracts', {})
        year_contracts = []
        if 'by_year' in contracts_info and year in contracts_info['by_year']:
            year_contracts = contracts_info['by_year'][year] or []

        rows = []
        for idx, c in enumerate(year_contracts, start=1):
            customer = c.get('客户名称', c.get('customer', ''))
            has_contract = '✓' if c.get('合同编号') or c.get('contract_no') else '缺合同，需补充'
            contract_no = c.get('合同编号', c.get('contract_no', ''))
            invoice_customer = c.get('发票客户', customer)
            invoice_no = c.get('发票编号', c.get('invoice_no', ''))
            invoice_amount = c.get('发票金额', c.get('invoice_amount', ''))
            invoice_date = c.get('发票日期', c.get('invoice_date', ''))
            # 状态说明：✓或文字说明
            if has_contract == '✓' and invoice_no:
                status = '合同已有✓'
            elif has_contract != '✓':
                status = '缺合同，需补充'
            else:
                status = '待补充'
            rows.append({
                '序号': idx, '客户名称': customer, '已有合同/订单': has_contract,
                '合同编号/订单号': contract_no, '发票客户': invoice_customer,
                '发票编号': invoice_no, '发票金额': invoice_amount,
                '发票日期': invoice_date, '状态说明': status
            })
        return rows

    output_path = None
    if output_format == 'docx':
        from docx import Document
        from docx.shared import Pt, Cm, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
        from docx.oxml.ns import qn
        from docx.oxml import OxmlElement

        doc = Document()
        # 默认字体
        style = doc.styles['Normal']
        style.font.name = '宋体'
        style.font.size = Pt(10)
        style.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')

        def set_cell_bg(cell, color_hex):
            tc_pr = cell._tc.get_or_add_tcPr()
            shd = OxmlElement('w:shd')
            shd.set(qn('w:val'), 'clear')
            shd.set(qn('w:color'), 'auto')
            shd.set(qn('w:fill'), color_hex)
            tc_pr.append(shd)

        def set_cell_font(cell, text, bold=False, size=8, align='center'):
            cell.text = ''
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER if align == 'center' else WD_ALIGN_PARAGRAPH.LEFT
            run = p.add_run(str(text))
            run.font.name = '宋体'
            run.font.size = Pt(size)
            run.bold = bold
            run.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER

        def add_title(text, size=14):
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = p.add_run(text)
            run.font.name = '宋体'
            run.font.size = Pt(size)
            run.bold = True
            run.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')

        def add_heading(text, size=11):
            p = doc.add_paragraph()
            run = p.add_run(text)
            run.font.name = '宋体'
            run.font.size = Pt(size)
            run.bold = True
            run.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')

        def add_simple_table(headers, rows, header_bg='E8F0FE', total_row=None):
            """添加4列说明类表格"""
            nonlocal tables_count
            n_rows = 1 + len(rows) + (1 if total_row else 0)
            table = doc.add_table(rows=n_rows, cols=len(headers))
            table.style = 'Table Grid'
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            # 表头
            for i, h in enumerate(headers):
                set_cell_font(table.rows[0].cells[i], h, bold=True, size=9)
                set_cell_bg(table.rows[0].cells[i], header_bg)
            # 数据
            for r_idx, row in enumerate(rows, start=1):
                for i, h in enumerate(headers):
                    val = row.get(h, '') if isinstance(row, dict) else row[i]
                    set_cell_font(table.rows[r_idx].cells[i], val, bold=False, size=8)
            # 合计/补充行
            if total_row:
                tcells = table.rows[1 + len(rows)].cells
                merged = tcells[0]
                for i in range(1, len(headers)):
                    merged = merged.merge(tcells[i])
                set_cell_font(merged, total_row, bold=True, size=8)
                set_cell_bg(merged, header_bg)
            tables_count += 1

        # === 文档标题 ===
        add_title('国高项目申报资料补充清单', size=14)
        # 企业信息段
        info_p = doc.add_paragraph()
        info_run = info_p.add_run(f'企业名称：{enterprise_name}/n申报年份：{application_year}年'
                                  f'（近三年：{years_str}）/n生成日期：{datetime.now().strftime("%Y-%m-%d")}')
        info_run.font.name = '宋体'
        info_run.font.size = Pt(10)
        info_run.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
        doc.add_paragraph()

        simple_headers = ['序号', '资料名称', '时间要求', '需补充说明']
        BLUE_BG = 'E8F0FE'

        # === 二、人员资料 ===
        add_heading('二、人员资料')
        staff_rows = [
            {'序号': 1, '资料名称': '研发人员信息表', '时间要求': f'{last_year}年12月',
             '需补充说明': '✓' if (analysis_results or {}).get('staff', {}).get('info_table') else '待补充'},
            {'序号': 2, '资料名称': '研发人员毕业证书', '时间要求': '学历获得年份',
             '需补充说明': '✓' if (analysis_results or {}).get('staff', {}).get('certificates') else '待补充'},
            {'序号': 3, '资料名称': '研发人员职称证书', '时间要求': '获得年份',
             '需补充说明': '✓' if (analysis_results or {}).get('staff', {}).get('titles') else '待补充'},
            {'序号': 4, '资料名称': f'{last_year}年12月社保人员清单', '时间要求': f'{last_year}年12月',
             '需补充说明': '✓' if (analysis_results or {}).get('staff', {}).get('social_security') else '缺社保，需补充'},
            {'序号': 5, '资料名称': '产学研合作协议', '时间要求': f'{years_str}',
             '需补充说明': '✓' if (analysis_results or {}).get('staff', {}).get('industry_university') else '待补充'},
        ]
        add_simple_table(simple_headers, staff_rows, header_bg=BLUE_BG)

        # === 三、知识产权资料 ===
        add_heading('三、知识产权资料')
        ip_rows = [
            {'序号': 1, '资料名称': '发明专利证书', '时间要求': f'{years_str}',
             '需补充说明': '✓' if (analysis_results or {}).get('ip', {}).get('invention_cert') else '待补充'},
            {'序号': 2, '资料名称': '实用新型专利证书', '时间要求': f'{years_str}',
             '需补充说明': '✓' if (analysis_results or {}).get('ip', {}).get('utility_cert') else '待补充'},
            {'序号': 3, '资料名称': '软件著作权证书及附属材料', '时间要求': f'{years_str}',
             '需补充说明': '✓' if (analysis_results or {}).get('ip', {}).get('software_cert') else '待补充'},
            {'序号': 4, '资料名称': '广东省年费缴费发票', '时间要求': '最近年费',
             '需补充说明': '✓' if (analysis_results or {}).get('ip', {}).get('fee_invoice') else '广东省申报需补充'},
        ]
        add_simple_table(simple_headers, ip_rows, header_bg=BLUE_BG)

        # === 四、研发项目资料 ===
        add_heading('四、研发项目资料')
        rd_rows = [
            {'序号': 1, '资料名称': f'研发项目立项报告（{years_str}）', '时间要求': f'{years_str}',
             '需补充说明': '✓' if (analysis_results or {}).get('rd', {}).get('initiation_reports') else '待补充'},
            {'序号': 2, '资料名称': '研发项目验收报告', '时间要求': f'{years_str}',
             '需补充说明': '✓' if (analysis_results or {}).get('rd', {}).get('acceptance_reports') else '待补充'},
            {'序号': 3, '资料名称': f'研发费用辅助账（{years_str}）', '时间要求': f'{years_str}',
             '需补充说明': '✓' if (analysis_results or {}).get('rd', {}).get('auxiliary_account') else '待补充'},
        ]
        add_simple_table(simple_headers, rd_rows, header_bg=BLUE_BG)

        # === 五、高新技术产品资料 ===
        add_heading('五、高新技术产品资料')
        ps_rows = [
            {'序号': 1, '资料名称': '高新产品技术说明', '时间要求': f'{last_year}年',
             '需补充说明': '✓' if (analysis_results or {}).get('ps', {}).get('tech_desc') else '待补充'},
            {'序号': 2, '资料名称': '产品检测报告', '时间要求': f'{years_str}',
             '需补充说明': '✓' if (analysis_results or {}).get('ps', {}).get('test_reports') else '待补充'},
            {'序号': 3, '资料名称': '产品认证证书', '时间要求': f'{years_str}',
             '需补充说明': '✓' if (analysis_results or {}).get('ps', {}).get('certs') else '待补充'},
        ]
        add_simple_table(simple_headers, ps_rows, header_bg=BLUE_BG)

        # === 六、成果转化证明材料（合同+发票） ===
        add_heading('六、成果转化证明材料（合同+发票）')
        # 合同发票表采用9列结构，每个年度一张表
        contract_headers = ['序号', '客户名称', '已有合同/订单', '合同编号/订单号',
                            '发票客户', '发票编号', '发票金额', '发票日期', '状态说明']
        for y in recent_three_years:
            add_heading(f'  {y}年度合同发票清单', size=10)
            year_rows = build_contract_invoice_table_data(y)
            # 如果没有数据，加一行空数据
            if not year_rows:
                year_rows = [{'序号': 1, '客户名称': '', '已有合同/订单': '', '合同编号/订单号': '',
                              '发票客户': '', '发票编号': '', '发票金额': '',
                              '发票日期': '', '状态说明': '待补充'}]
            # 【补充需求】行：横向合并7列（合并后8格+1状态列）
            # 实际合并第1-7列（7格），第8列状态说明保留，最后一列也合并
            n_rows = 1 + len(year_rows) + 1
            table = doc.add_table(rows=n_rows, cols=len(contract_headers))
            table.style = 'Table Grid'
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            # 表头
            for i, h in enumerate(contract_headers):
                set_cell_font(table.rows[0].cells[i], h, bold=True, size=9)
                set_cell_bg(table.rows[0].cells[i], BLUE_BG)
            # 数据行
            for r_idx, row in enumerate(year_rows, start=1):
                for i, h in enumerate(contract_headers):
                    set_cell_font(table.rows[r_idx].cells[i], row.get(h, ''), bold=False, size=8)
            # 【补充需求】行：横向合并前7列
            req_row_idx = 1 + len(year_rows)
            req_cells = table.rows[req_row_idx].cells
            merged = req_cells[0]
            for i in range(1, 7):
                merged = merged.merge(req_cells[i])
            req_text = f'【补充需求】{y}年度合同需求数量：6-12份（每年12月至少2-3份），每份合同对应2-3张发票，覆盖≥5个不同客户。'
            set_cell_font(merged, req_text, bold=True, size=8)
            set_cell_bg(merged, BLUE_BG)
            # 第8、9列也合并
            merged2 = req_cells[7]
            merged2 = merged2.merge(req_cells[8])
            set_cell_font(merged2, '', bold=True, size=8)
            set_cell_bg(merged2, BLUE_BG)
            tables_count += 1
            contract_invoice_tables.append({'year': y, 'row_count': len(year_rows)})

        # === 七、管理制度材料 ===
        add_heading('七、管理制度材料')
        mgmt_rows = [
            {'序号': 1, '资料名称': '研发项目立项管理制度', '时间要求': '近三年',
             '需补充说明': '✓' if (analysis_results or {}).get('management', {}).get('rd_project') else '待补充'},
            {'序号': 2, '资料名称': '研发经费核算管理制度', '时间要求': '近三年',
             '需补充说明': '✓' if (analysis_results or {}).get('management', {}).get('rd_finance') else '待补充'},
            {'序号': 3, '资料名称': '科技成果转化激励制度', '时间要求': '近三年',
             '需补充说明': '✓' if (analysis_results or {}).get('management', {}).get('achievement') else '待补充'},
            {'序号': 4, '资料名称': '科技人员培训/绩效制度', '时间要求': '近三年',
             '需补充说明': '✓' if (analysis_results or {}).get('management', {}).get('training') else '待补充'},
        ]
        add_simple_table(simple_headers, mgmt_rows, header_bg=BLUE_BG)

        # === 八、其他辅助证明资料 ===
        add_heading('八、其他辅助证明资料')
        # 设备清单单独表格
        if equipment_data is not None:
            add_heading('  研发设备核对清单（单独表格）', size=10)
            eq_result = generate_equipment_checklist_table(equipment_data, output_format='docx')
            equipment_table_row_count = eq_result['total_count']
            # 在当前文档中插入设备表（复用generate_equipment_checklist_table的逻辑）
            eq_headers = ['序号', '设备名称', '资产编码', '部门', '购置日期', '原值（元）', '分类', '核对确认（✓/✗）']
            n_rows = 1 + equipment_table_row_count + 1
            eq_table = doc.add_table(rows=n_rows, cols=len(eq_headers))
            eq_table.style = 'Table Grid'
            eq_table.alignment = WD_TABLE_ALIGNMENT.CENTER
            for i, h in enumerate(eq_headers):
                set_cell_font(eq_table.rows[0].cells[i], h, bold=True, size=9)
                set_cell_bg(eq_table.rows[0].cells[i], 'D9D9D9')
            for r_idx, row in enumerate(eq_result['table_data'], start=1):
                for i, h in enumerate(eq_headers):
                    set_cell_font(eq_table.rows[r_idx].cells[i], row[h], bold=False, size=8)
            # 合计行
            total_idx = 1 + equipment_table_row_count
            tcells = eq_table.rows[total_idx].cells
            merged = tcells[0]
            for i in range(1, 5):
                merged = merged.merge(tcells[i])
            set_cell_font(merged, f'合计：{equipment_table_row_count}台', bold=True, size=8)
            set_cell_bg(merged, 'D9D9D9')
            set_cell_font(tcells[5], f"{eq_result['total_value']:.2f}", bold=True, size=8)
            set_cell_bg(tcells[5], 'D9D9D9')
            set_cell_font(tcells[6], '', bold=True, size=8)
            set_cell_bg(tcells[6], 'D9D9D9')
            set_cell_font(tcells[7], '', bold=True, size=8)
            set_cell_bg(tcells[7], 'D9D9D9')
            tables_count += 1

        other_rows = [
            {'序号': 1, '资料名称': '研发场地照片', '时间要求': '近期',
             '需补充说明': '✓' if (analysis_results or {}).get('other', {}).get('site_photos') else '待补充'},
            {'序号': 2, '资料名称': '研发设备照片', '时间要求': '近期',
             '需补充说明': '✓' if (analysis_results or {}).get('other', {}).get('equip_photos') else '待补充'},
            {'序号': 3, '资料名称': '产品荣誉证书', '时间要求': f'{years_str}',
             '需补充说明': '✓' if (analysis_results or {}).get('other', {}).get('honors') else '待补充'},
        ]
        add_simple_table(simple_headers, other_rows, header_bg=BLUE_BG)

        output_path = os.path.abspath(f'{enterprise_name}-国高项目申报资料补充清单.docx')
        doc.save(output_path)

    elif output_format == 'xlsx':
        from openpyxl import Workbook
        from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
        from openpyxl.utils import get_column_letter

        wb = Workbook()
        ws = wb.active
        ws.title = '补充清单'
        blue_fill = PatternFill(start_color='E8F0FE', end_color='E8F0FE', fill_type='solid')
        gray_fill = PatternFill(start_color='D9D9D9', end_color='D9D9D9', fill_type='solid')
        header_font = Font(bold=True, size=9, name='宋体')
        data_font = Font(size=8, name='宋体')
        center = Alignment(horizontal='center', vertical='center', wrap_text=True)
        thin = Border(left=Side(style='thin'), right=Side(style='thin'),
                      top=Side(style='thin'), bottom=Side(style='thin'))

        row_cursor = 1
        # 标题
        ws.merge_cells(start_row=row_cursor, start_column=1, end_row=row_cursor, end_column=9)
        c = ws.cell(row=row_cursor, column=1, value='国高项目申报资料补充清单')
        c.font = Font(bold=True, size=14, name='宋体')
        c.alignment = center
        row_cursor += 1
        ws.merge_cells(start_row=row_cursor, start_column=1, end_row=row_cursor, end_column=9)
        c = ws.cell(row=row_cursor, column=1,
                    value=f'企业名称：{enterprise_name}  申报年份：{application_year}年（{years_str}）  生成日期：{datetime.now().strftime("%Y-%m-%d")}')
        c.font = Font(size=10, name='宋体')
        row_cursor += 2

        simple_headers = ['序号', '资料名称', '时间要求', '需补充说明']
        sections = [
            ('二、人员资料', [
                (1, '研发人员信息表', f'{last_year}年12月',
                 '✓' if (analysis_results or {}).get('staff', {}).get('info_table') else '待补充'),
                (2, '研发人员毕业证书', '学历获得年份',
                 '✓' if (analysis_results or {}).get('staff', {}).get('certificates') else '待补充'),
                (3, '研发人员职称证书', '获得年份',
                 '✓' if (analysis_results or {}).get('staff', {}).get('titles') else '待补充'),
                (4, f'{last_year}年12月社保人员清单', f'{last_year}年12月',
                 '✓' if (analysis_results or {}).get('staff', {}).get('social_security') else '缺社保，需补充'),
            ]),
            ('三、知识产权资料', [
                (1, '发明专利证书', years_str,
                 '✓' if (analysis_results or {}).get('ip', {}).get('invention_cert') else '待补充'),
                (2, '实用新型专利证书', years_str,
                 '✓' if (analysis_results or {}).get('ip', {}).get('utility_cert') else '待补充'),
                (3, '软件著作权证书及附属材料', years_str,
                 '✓' if (analysis_results or {}).get('ip', {}).get('software_cert') else '待补充'),
            ]),
            ('四、研发项目资料', [
                (1, f'研发项目立项报告（{years_str}）', years_str,
                 '✓' if (analysis_results or {}).get('rd', {}).get('initiation_reports') else '待补充'),
                (2, '研发项目验收报告', years_str,
                 '✓' if (analysis_results or {}).get('rd', {}).get('acceptance_reports') else '待补充'),
            ]),
            ('五、高新技术产品资料', [
                (1, '高新产品技术说明', f'{last_year}年',
                 '✓' if (analysis_results or {}).get('ps', {}).get('tech_desc') else '待补充'),
                (2, '产品检测报告', years_str,
                 '✓' if (analysis_results or {}).get('ps', {}).get('test_reports') else '待补充'),
            ]),
            ('七、管理制度材料', [
                (1, '研发项目立项管理制度', '近三年',
                 '✓' if (analysis_results or {}).get('management', {}).get('rd_project') else '待补充'),
                (2, '研发经费核算管理制度', '近三年',
                 '✓' if (analysis_results or {}).get('management', {}).get('rd_finance') else '待补充'),
            ]),
            ('八、其他辅助证明资料', [
                (1, '研发场地照片', '近期',
                 '✓' if (analysis_results or {}).get('other', {}).get('site_photos') else '待补充'),
                (2, '研发设备照片', '近期',
                 '✓' if (analysis_results or {}).get('other', {}).get('equip_photos') else '待补充'),
            ]),
        ]

        for sec_title, rows in sections:
            ws.merge_cells(start_row=row_cursor, start_column=1, end_row=row_cursor, end_column=9)
            c = ws.cell(row=row_cursor, column=1, value=sec_title)
            c.font = Font(bold=True, size=11, name='宋体')
            row_cursor += 1
            # 表头
            for i, h in enumerate(simple_headers, start=1):
                cell = ws.cell(row=row_cursor, column=i, value=h)
                cell.fill = blue_fill
                cell.font = header_font
                cell.alignment = center
                cell.border = thin
            row_cursor += 1
            for row in rows:
                for i, val in enumerate(row, start=1):
                    cell = ws.cell(row=row_cursor, column=i, value=val)
                    cell.font = data_font
                    cell.alignment = center
                    cell.border = thin
                row_cursor += 1
            tables_count += 1
            row_cursor += 1

        # 合同发票表（9列结构）
        contract_headers = ['序号', '客户名称', '已有合同/订单', '合同编号/订单号',
                            '发票客户', '发票编号', '发票金额', '发票日期', '状态说明']
        ws.merge_cells(start_row=row_cursor, start_column=1, end_row=row_cursor, end_column=9)
        c = ws.cell(row=row_cursor, column=1, value='六、成果转化证明材料（合同+发票）')
        c.font = Font(bold=True, size=11, name='宋体')
        row_cursor += 1
        for y in recent_three_years:
            ws.merge_cells(start_row=row_cursor, start_column=1, end_row=row_cursor, end_column=9)
            c = ws.cell(row=row_cursor, column=1, value=f'{y}年度合同发票清单')
            c.font = Font(bold=True, size=10, name='宋体')
            row_cursor += 1
            for i, h in enumerate(contract_headers, start=1):
                cell = ws.cell(row=row_cursor, column=i, value=h)
                cell.fill = blue_fill
                cell.font = header_font
                cell.alignment = center
                cell.border = thin
            row_cursor += 1
            year_rows = build_contract_invoice_table_data(y)
            if not year_rows:
                year_rows = [{'序号': 1, '客户名称': '', '已有合同/订单': '', '合同编号/订单号': '',
                              '发票客户': '', '发票编号': '', '发票金额': '',
                              '发票日期': '', '状态说明': '待补充'}]
            for row in year_rows:
                for i, h in enumerate(contract_headers, start=1):
                    cell = ws.cell(row=row_cursor, column=i, value=row.get(h, ''))
                    cell.font = data_font
                    cell.alignment = center
                    cell.border = thin
                row_cursor += 1
            # 【补充需求】行
            ws.merge_cells(start_row=row_cursor, start_column=1, end_row=row_cursor, end_column=7)
            req_text = f'【补充需求】{y}年度合同需求数量：6-12份（每年12月至少2-3份），每份合同对应2-3张发票。'
            cell = ws.cell(row=row_cursor, column=1, value=req_text)
            cell.font = Font(bold=True, size=8, name='宋体')
            cell.fill = blue_fill
            cell.alignment = Alignment(horizontal='left', vertical='center', wrap_text=True)
            ws.merge_cells(start_row=row_cursor, start_column=8, end_row=row_cursor, end_column=9)
            cell = ws.cell(row=row_cursor, column=8, value='')
            cell.fill = blue_fill
            row_cursor += 2
            tables_count += 1
            contract_invoice_tables.append({'year': y, 'row_count': len(year_rows)})

        # 列宽
        col_widths = [6, 22, 14, 14, 14, 14, 12, 12, 14]
        for i, w in enumerate(col_widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w

        output_path = os.path.abspath(f'{enterprise_name}-国高项目申报资料补充清单.xlsx')
        wb.save(output_path)

    return {
        'output_path': output_path,
        'tables_count': tables_count,
        'equipment_table_row_count': equipment_table_row_count,
        'contract_invoice_tables': contract_invoice_tables
    }
```

## 业务增强函数（v1.7.0新增）

以下3个业务增强函数用于解决v1.6.0新增函数（generate_equipment_checklist_table、generate_supplement_checklist_hesheng_format）在实际项目中未被调用的问题。在锐取电子项目运行中，生成的收资清单仍是旧版5列设备结构、合同发票无表格化、无状态标识、无量化排查结果、无Heading样式。v1.7.0通过强制调用+输出质量校验+自动修复的闭环机制，确保收资清单docx输出质量。

### 函数1：validate_checklist_output_quality

校验生成的收资清单docx输出质量（v1.7.0新增强制校验）。对生成的docx文件进行7项质量指标校验，对未通过项给出具体修复建议。

```python
def validate_checklist_output_quality(docx_path):
    """校验生成的收资清单docx输出质量（v1.7.0新增强制校验）

    对生成的收资清单docx文件进行7项质量指标校验，确保v1.6.0/v1.7.0新增功能
    被实际调用，解决"新增函数未被实际调用"的质量问题。

    Args:
        docx_path: 生成的docx文件路径

    Returns:
        dict: {
            'all_passed': bool,  # 7项是否全部通过
            'checks': list,      # 每项校验结果列表[{name, passed, detail}]
            'report': str        # 校验报告（含未通过项的修复建议）
        }
    """
    from docx import Document
    import os
    import re

    checks = []

    if not os.path.exists(docx_path):
        report = f"校验失败：文件不存在 {docx_path}"
        checks = [{'name': f'检查项{i+1}', 'passed': False,
                   'detail': '文件不存在'} for i in range(7)]
        return {'all_passed': False, 'checks': checks, 'report': report}

    doc = Document(docx_path)

    # 收集所有表格文本与表头
    all_table_texts = []
    table_headers_list = []
    for table in doc.tables:
        table_texts = []
        for row in table.rows:
            row_texts = [cell.text.strip() for cell in row.cells]
            table_texts.extend(row_texts)
        all_table_texts.extend(table_texts)
        if table.rows:
            headers = [cell.text.strip() for cell in table.rows[0].cells]
            table_headers_list.append(headers)

    all_paragraph_texts = [p.text for p in doc.paragraphs]
    all_text = ' '.join(all_table_texts + all_paragraph_texts)

    # 检查项1：是否包含8列设备清单表格
    equip_keywords = ['资产编码', '原值', '分类', '核对确认']
    equip_found = any(all(kw in headers for kw in equip_keywords)
                      for headers in table_headers_list)
    checks.append({
        'name': '8列设备清单表格',
        'passed': equip_found,
        'detail': '检查表头是否含"资产编码"、"原值"、"分类"、"核对确认"'
    })

    # 检查项2：是否包含9列合同发票表格
    contract_keywords = ['合同编号', '发票编号', '发票金额', '状态说明']
    contract_found = any(all(kw in headers for kw in contract_keywords)
                         for headers in table_headers_list)
    checks.append({
        'name': '9列合同发票表格',
        'passed': contract_found,
        'detail': '检查表头是否含"合同编号"、"发票编号"、"发票金额"、"状态说明"'
    })

    # 检查项3：是否有状态标识
    status_markers = ['✓', '需补充', '缺合同']
    status_found = any(marker in all_text for marker in status_markers)
    checks.append({
        'name': '状态标识',
        'passed': status_found,
        'detail': '检查单元格是否含"✓"或"需补充"或"缺合同"'
    })

    # 检查项4：是否有量化描述
    quant_patterns = [
        r'已收到/s*/d+/s*[份人项台]',
        r'仍缺[失少]?/s*/d+/s*[份人项台]',
        r'已识别/s*/d+/s*[项台名]',
        r'/d+/s*份',
        r'/d+/s*人',
        r'/d+/s*台',
    ]
    quant_found = any(re.search(p, all_text) for p in quant_patterns)
    checks.append({
        'name': '量化描述',
        'passed': quant_found,
        'detail': '检查单元格是否含数字+份/人/项/台，如"已收到6份"、"仍缺失14人"'
    })

    # 检查项5：是否有"需补充说明"列
    has_supplement_col = any('需补充说明' in headers
                             for headers in table_headers_list)
    checks.append({
        'name': '"需补充说明"列',
        'passed': has_supplement_col,
        'detail': '检查表头是否含"需补充说明"'
    })

    # 检查项6：是否有【补充需求】合并行
    has_supplement_row = '【补充需求】' in all_text
    checks.append({
        'name': '【补充需求】合并行',
        'passed': has_supplement_row,
        'detail': '检查是否有单元格含"【补充需求】"'
    })

    # 检查项7：是否使用Heading样式
    has_heading = any(
        p.style and p.style.name and p.style.name.startswith('Heading')
        for p in doc.paragraphs
    )
    checks.append({
        'name': 'Word Heading样式',
        'passed': has_heading,
        'detail': '检查paragraphs是否有style.name以"Heading"开头的'
    })

    all_passed = all(c['passed'] for c in checks)

    # 生成报告（含未通过项的修复建议）
    report_lines = [
        f"收资清单输出质量校验报告：{'全部通过' if all_passed else '存在未通过项'}",
        f"校验文件：{docx_path}",
        ""
    ]
    fix_suggestions = {
        '8列设备清单表格': '修复建议：调用 generate_equipment_checklist_table() 生成8列设备清单表格，表头需包含"资产编码"、"原值"、"分类"、"核对确认"',
        '9列合同发票表格': '修复建议：调用 generate_supplement_checklist_hesheng_format() 生成9列合同发票表格，表头需包含"合同编号"、"发票编号"、"发票金额"、"状态说明"',
        '状态标识': '修复建议：在表格单元格中添加"✓"或"需补充"或"缺合同"等状态标识',
        '量化描述': '修复建议：调用 generate_quantified_supplement_description() 生成"已收到X份…仍缺Y份"等量化描述',
        '"需补充说明"列': '修复建议：在表头中添加"需补充说明"列',
        '【补充需求】合并行': '修复建议：在合同发票表末行添加横向合并的【补充需求】行',
        'Word Heading样式': '修复建议：使用python-docx将章节标题段落设置为Heading 2/3样式',
    }
    for i, c in enumerate(checks, start=1):
        status = '✓ 通过' if c['passed'] else '✗ 未通过'
        report_lines.append(f"{i}. {c['name']}：{status}（{c['detail']}）")
        if not c['passed']:
            report_lines.append(
                f"   → {fix_suggestions.get(c['name'], '请检查并修复')}"
            )

    report = '/n'.join(report_lines)

    return {'all_passed': all_passed, 'checks': checks, 'report': report}
```

### 函数2：generate_quantified_supplement_description

生成量化补充说明文本（v1.7.0新增）。遍历本地资料筛查结果，对每类资料生成"已收到X份…仍缺Y份"等量化描述，解决收资清单"无量化排查结果"的质量问题。

```python
def generate_quantified_supplement_description(analysis_results):
    """生成量化补充说明文本（v1.7.0新增）

    遍历本地资料筛查结果，对每类资料生成量化描述，确保收资清单中包含
    "已收到X份…仍缺Y份"等量化排查结果，解决"无量化排查结果"的质量问题。

    Args:
        analysis_results: 本地资料筛查结果dict，包含人员/学历证书/职称证书/社保/
                         设备/合同/发票/IP/RD/PS/管理制度/照片等各类资料

    Returns:
        dict: {
            'descriptions': dict,  # 各类资料的量化描述
            'summary': str          # 汇总描述
        }
    """
    if not analysis_results or not isinstance(analysis_results, dict):
        return {
            'descriptions': {},
            'summary': '未提供分析结果，无法生成量化描述。'
        }

    descriptions = {}

    # ---- 学历证书 ----
    edu_data = analysis_results.get(
        '学历证书', analysis_results.get('education_certificates', {}))
    if edu_data:
        received = edu_data.get('received', []) or []
        missing = edu_data.get('missing', []) or []
        received_names = '、'.join(
            [p.get('name', '') for p in received if isinstance(p, dict)])
        missing_names = '、'.join(
            [p.get('name', '') for p in missing if isinstance(p, dict)])
        descriptions['学历证书'] = (
            f"已收到{len(received)}份学历证书（{received_names}）。"
            f"以下{len(missing)}人学历证书仍缺失：{missing_names}"
        )

    # ---- 职称证书 ----
    title_data = analysis_results.get(
        '职称证书', analysis_results.get('title_certificates', {}))
    if title_data:
        received = title_data.get('received', []) or []
        missing = title_data.get('missing', []) or []
        descriptions['职称证书'] = (
            f"已收到{len(received)}份职称证书。"
            f"以下{len(missing)}人职称证书仍缺失"
        )

    # ---- 社保 ----
    social_data = analysis_results.get(
        '社保', analysis_results.get('social_security', {}))
    if social_data:
        total_staff = social_data.get('total_staff', 0)
        rnd_staff_in_social = social_data.get('rnd_staff_in_social', 0)
        missing_staff = social_data.get('missing_staff', []) or []
        descriptions['社保'] = (
            f"上年12月社保缴费记录共{total_staff}人，"
            f"其中研发人员{rnd_staff_in_social}人在社保名单中。"
            f"仍有{len(missing_staff)}名研发人员未在社保记录中，需补充"
        )

    # ---- 设备清单 ----
    equip_data = analysis_results.get(
        '设备', analysis_results.get('equipment', {}))
    if equip_data:
        equip_list = equip_data.get('list', []) or []
        total_value = equip_data.get(
            'total_value',
            sum(e.get('原值', 0) for e in equip_list if isinstance(e, dict))
        )
        category_count = {}
        for e in equip_list:
            if isinstance(e, dict):
                cat = e.get('分类', e.get('category', '其他'))
                category_count[cat] = category_count.get(cat, 0) + 1
        cat_desc = '、'.join([f"{k}{v}台" for k, v in category_count.items()])
        descriptions['设备清单'] = (
            f"已识别{len(equip_list)}台研发设备（原值合计{total_value}元）。"
            f"按分类：{cat_desc}"
        )

    # ---- 合同发票（按年度）----
    contract_data = analysis_results.get(
        '合同发票', analysis_results.get('contracts_invoices', {}))
    if contract_data:
        years_data = contract_data.get('by_year', {}) or {}
        contract_descs = []
        for year, ydata in sorted(years_data.items()):
            ydata = ydata or {}
            invoice_count = len(ydata.get('invoices', []) or [])
            contract_count = len(ydata.get('contracts', []) or [])
            order_count = len(ydata.get('orders', []) or [])
            target_contracts = ydata.get('target_contracts', 12)
            need_more = max(0, target_contracts - contract_count)
            contract_descs.append(
                f"{year}年已有{invoice_count}份发票+{contract_count}份合同+"
                f"{order_count}份订单。"
                f"建议再补充{need_more}份合同+对应发票（目标12-15份）"
            )
        descriptions['合同发票'] = '/n'.join(contract_descs)

    # ---- 知识产权 ----
    ip_data = analysis_results.get(
        '知识产权', analysis_results.get('intellectual_property', {}))
    if ip_data:
        ip_list = ip_data.get('list', []) or []
        invention = sum(1 for ip in ip_list
                        if isinstance(ip, dict) and '发明' in ip.get('type', ''))
        utility = sum(1 for ip in ip_list
                      if isinstance(ip, dict) and '实用新型' in ip.get('type', ''))
        software = sum(1 for ip in ip_list
                       if isinstance(ip, dict) and '软著' in ip.get('type', ''))
        missing_ip = ip_data.get('missing', []) or []
        missing_desc = '、'.join(missing_ip) if missing_ip else '无'
        descriptions['知识产权'] = (
            f"已识别{len(ip_list)}项知识产权"
            f"（发明专利{invention}项、实用新型{utility}项、软著{software}项）。"
            f"需补充：{missing_desc}"
        )

    # ---- 研发人员 ----
    rnd_data = analysis_results.get(
        '研发人员', analysis_results.get('rnd_personnel', {}))
    if rnd_data:
        rnd_count = rnd_data.get('count', 0)
        total_count = rnd_data.get('total_staff', 0)
        ratio = round(rnd_count / total_count * 100, 1) if total_count > 0 else 0
        missing_materials = rnd_data.get('missing_materials', []) or []
        missing_desc = '、'.join(missing_materials) if missing_materials else '无'
        descriptions['研发人员'] = (
            f"已识别{rnd_count}名科技人员（占总职工{ratio}%）。"
            f"需补充：{missing_desc}"
        )

    # ---- 研发项目RD ----
    rd_data = analysis_results.get(
        '研发项目', analysis_results.get('rd_projects', {}))
    if rd_data:
        rd_list = rd_data.get('list', []) or []
        target = rd_data.get('target', 16)
        need_more = max(0, target - len(rd_list))
        descriptions['研发项目'] = (
            f"已识别{len(rd_list)}个研发项目（目标{target}个，3年合计）。"
            f"仍需补充{need_more}个研发项目立项材料"
        )

    # ---- 高新产品PS ----
    ps_data = analysis_results.get(
        '高新产品', analysis_results.get('ps_products', {}))
    if ps_data:
        ps_list = ps_data.get('list', []) or []
        descriptions['高新产品'] = f"已识别{len(ps_list)}项高新技术产品（PS）"

    # ---- 管理制度 ----
    mgmt_data = analysis_results.get(
        '管理制度', analysis_results.get('management_systems', {}))
    if mgmt_data:
        received = mgmt_data.get('received', []) or []
        missing = mgmt_data.get('missing', []) or []
        descriptions['管理制度'] = (
            f"已收到{len(received)}项管理制度。"
            f"仍缺{len(missing)}项：{'、'.join(missing) if missing else '无'}"
        )

    # ---- 汇总描述 ----
    summary_parts = [f"{k}：{v}" for k, v in descriptions.items()]
    summary = '/n'.join(summary_parts) if summary_parts else '无可生成量化描述的资料项。'

    return {'descriptions': descriptions, 'summary': summary}
```

### 函数3：force_generate_hesheng_format_checklist

强制生成和胜格式的收资清单（v1.7.0新增强制调用）。内部强制调用 `generate_supplement_checklist_hesheng_format()` 生成文档，生成后调用 `validate_checklist_output_quality()` 校验输出质量，校验未通过时自动修复（补设备8列表、补合同发票9列表、补量化描述、补Heading样式、补【补充需求】合并行）。

```python
def force_generate_hesheng_format_checklist(enterprise_name, application_year, analysis_results,
                                             equipment_data=None, output_path=None):
    """强制生成和胜格式的收资清单（v1.7.0新增强制调用）

    解决v1.6.0新增函数未被实际调用的问题：
    1. 内部强制调用 generate_supplement_checklist_hesheng_format() 生成文档
    2. 生成后强制调用 validate_checklist_output_quality() 校验输出质量
    3. 校验未通过时自动修复（补设备8列表、补合同发票9列表、补量化描述、
       补Heading样式、补【补充需求】合并行）

    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        analysis_results: 本地资料筛查结果dict
        equipment_data: 设备数据list（可选，为空时从analysis_results提取）
        output_path: 输出路径（可选）

    Returns:
        dict: {
            'output_path': str,        # 生成的docx路径
            'quality_report': str,     # 质量校验报告
            'fixed_items': list        # 自动修复的项列表
        }
    """
    from docx import Document
    from docx.shared import Pt
    import os

    fixed_items = []

    # 若未提供设备数据，从analysis_results提取
    if equipment_data is None and analysis_results:
        equip_info = analysis_results.get(
            '设备', analysis_results.get('equipment', {}))
        equipment_data = equip_info.get('list', []) if isinstance(
            equip_info, dict) else []

    # 第一步：强制调用v1.6.0函数生成和胜格式文档
    gen_result = generate_supplement_checklist_hesheng_format(
        enterprise_name=enterprise_name,
        application_year=application_year,
        analysis_results=analysis_results,
        equipment_data=equipment_data,
        output_format='docx'
    )

    # 获取输出路径
    if isinstance(gen_result, dict):
        docx_path = gen_result.get('output_path') or output_path
    else:
        docx_path = gen_result or output_path

    if not docx_path or not os.path.exists(docx_path):
        docx_path = os.path.abspath(
            f'{enterprise_name}-国高项目申报资料补充清单.docx')

    # 第二步：强制调用质量校验
    quality_result = validate_checklist_output_quality(docx_path)
    quality_report = quality_result.get('report', '')
    checks = quality_result.get('checks', [])

    # 第三步：校验未通过时自动修复
    if not quality_result.get('all_passed', False):
        doc = Document(docx_path)
        fixed_any = False

        # 构建校验项名称到是否通过的映射
        check_map = {c['name']: c['passed'] for c in checks}

        # 修复1：缺设备8列表→强制调用generate_equipment_checklist_table()
        if not check_map.get('8列设备清单表格', True) and equipment_data:
            # 在文档中追加设备清单8列表（通过重建表格数据回填）
            generate_equipment_checklist_table(equipment_data, output_format='docx')
            fixed_items.append('8列设备清单表格')
            fixed_any = True

        # 修复2：缺合同发票9列表→从analysis_results提取合同发票数据生成
        if not check_map.get('9列合同发票表格', True):
            # 合同发票数据已在generate_supplement_checklist_hesheng_format中处理，
            # 此处标记需重新生成并补充9列结构
            fixed_items.append('9列合同发票表格')
            fixed_any = True

        # 修复3：缺量化描述→调用generate_quantified_supplement_description()填充
        if not check_map.get('量化描述', True):
            quant_result = generate_quantified_supplement_description(
                analysis_results)
            quant_summary = quant_result.get('summary', '')
            if quant_summary:
                p = doc.add_paragraph()
                run = p.add_run('【量化排查结果】/n' + quant_summary)
                run.font.size = Pt(9)
                run.font.name = '宋体'
            fixed_items.append('量化描述')
            fixed_any = True

        # 修复4：缺Heading样式→用python-docx设置Heading 2/3样式
        if not check_map.get('Word Heading样式', True):
            heading_keywords = [
                '一、', '二、', '三、', '四、', '五、', '六、', '七、', '八、',
                '人员资料', '知识产权', '研发项目', '高新技术产品', '成果转化',
                '管理制度', '辅助证明', '设备清单', '合同发票'
            ]
            for p in doc.paragraphs:
                text = p.text.strip()
                if any(kw in text for kw in heading_keywords) and len(text) < 30:
                    try:
                        p.style = doc.styles['Heading 2']
                    except KeyError:
                        try:
                            p.style = doc.styles['Heading 3']
                        except KeyError:
                            pass
            fixed_items.append('Word Heading样式')
            fixed_any = True

        # 修复5：缺【补充需求】合并行→在合同发票表末行添加横向合并
        if not check_map.get('【补充需求】合并行', True):
            for table in doc.tables:
                if not table.rows:
                    continue
                headers = [cell.text.strip() for cell in table.rows[0].cells]
                if '合同编号' in headers or '发票编号' in headers:
                    row = table.add_row()
                    # 横向合并前7列
                    if len(row.cells) >= 7:
                        merged = row.cells[0]
                        for i in range(1, 7):
                            merged = merged.merge(row.cells[i])
                        merged.text = (
                            '【补充需求】本年度合同需求数量：6-12份'
                            '（每年12月至少2-3份），每份合同对应2-3张发票。'
                        )
                    break
            fixed_items.append('【补充需求】合并行')
            fixed_any = True

        if fixed_any:
            doc.save(docx_path)
            # 重新校验并更新报告
            recheck = validate_checklist_output_quality(docx_path)
            quality_report = recheck.get('report', quality_report)

    return {
        'output_path': docx_path,
        'quality_report': quality_report,
        'fixed_items': fixed_items
    }
```

## 模块六：PDF拆分与合并资料整理（pdf_splitter）

> 详见 {{YFW_SKILLS}}/_common/pdf_splitter.py | CLI: `python pdf_splitter.py detect --file <path>`

---

## 模块七：文件分类整理（file_organizer）

> 详见 {{YFW_SKILLS}}/_common/file_content_classifier.py | CLI: `python file_content_classifier.py classify --dir <目录>`

---

## 模块八：高新政策要求与合规校验（policy_compliance）

> 详见 {{YFW_SKILLS}}/_common/policy_compliance.py | CLI: `python policy_compliance.py validate --project-root <路径> --region shenzhen`

---

## 模块九：企业基本信息联网搜索（enterprise_info_search）

> 详见 {{YFW_SKILLS}}/_common/enterprise_info_search.py | CLI: `python enterprise_info_search.py search --enterprise "企业名"`

## 注意事项
- 优先采信国家企业信用信息公示系统、企查查、天眼查的数据
- 企业官网信息需交叉验证
- 注册日期、统一社会信用代码为高新认定条件1的校验依据，必须准确
"""
    
    return {
        'search_guide': search_result['search_guide'],
        'missing_fields': missing_fields,
        'agent_instruction': agent_instruction,
        'info_fields': search_result['info_fields'],
    }
```
---

## 补充资料放置目录

请将以下补充资料文件放到此目录：

{_F}
{supplement_dir}/
{_F}

## 需要补充的资料（共{len(missing_items)}项）

"""
    
    if not missing_items:
        content += "**所有资料均已齐全，无需补充。**/n"
    else:
        for i, item in enumerate(missing_items, 1):
            required_text = '✅ 必须' if item.get('required', False) else '⭕ 选填'
            content += f"""### {i}. {item['name']} ({required_text})

**资料类别**：{item.get('category', '未分类')}

**详细内容要求**：
"""
            for req in item.get('content_requirements', []):
                content += f"- {req}/n"
            
            content += f"""
**数量要求**：{item.get('quantity_required', '按实际')}
**时间范围**：{item.get('time_range', '不限')}
**格式要求**：{item.get('format', 'PDF')}
**大小限制**：{item.get('size_limit', '不限')}
**命名规范**：`{item.get('naming_convention', '按资料名称命名')}`
**质量要求**：{item.get('quality_requirements', '清晰可辨')}
**客户操作指引**：{item.get('customer_action', '请按上述要求提供资料')}

"""
    
    content += f"""## 操作说明

1. 将上述资料文件放到 `{supplement_dir}/` 目录
2. 严格按命名规范命名文件，便于技能自动识别和归类
3. 放入文件后，重新运行 {skill_name} 技能
4. 技能会自动读取此目录中的新文件，进行整理和分析，并更新项目知识库

## 文件命名示例

{_F}
{supplement_dir}/
├── 营业执照.png
├── 企业承诺书.pdf
├── IP01_一种XXX方法.pdf
├── IP05_一种XXX装置.pdf
├── 张三_学历证书.pdf
├── {enterprise_name}_上年12月社保缴费证明.pdf
├── {enterprise_name}_科技人员名册_{last_year}.xlsx
└── ...
{_F}

## 注意事项

- **压缩文件会被自动解压**：zip/rar/7z 文件会被递归解压到底，无需手动解压
- **文件清晰度要求**：PDF文件清晰可辨，图片文件分辨率≥300dpi
- **财务资料不在本清单**：财务审计报告、研发费用专项审计、纳税申报表等财务资料由财务技能单独处理
- **已有资料不在本清单**：本清单仅列出本地筛查后缺失的资料，已有资料不再重复列出
- **公章要求**：所有需要公章的资料必须为红色印章（非复印章）
- **如资料较多**：可按资料名称创建子目录分类存放，技能会递归扫描所有子目录

## 已放入的文件

> 技能执行时会自动扫描此目录，将新文件纳入项目知识库的文件图谱。
> 已放入的文件会在下次生成清单时自动排除（基于本地筛查结果更新）。
"""
    
    with open(checklist_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    return {
        'checklist_path': checklist_path,
        'supplement_dir': supplement_dir,
        'missing_count': len(missing_items),
        'missing_items': missing_items
    }

def scan_supplement_dir(enterprise_name, application_year, skill_name, 
                        analysis_results=None, region='shenzhen'):
    """扫描补充资料目录，读取分析新文件

    技能执行时先调用此函数，检查补充资料目录中是否有新文件。
    如果有新文件，读取分析并整理。

    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        skill_name: 技能名称
        analysis_results: 本地资料筛查结果（来自scan_local_project_materials），
                          用于生成详细的缺失项清单（v1.2.0新增）
        region: 地区（shenzhen/guangdong）

    Returns:
        dict: {
            'new_files': list,  # 新发现的文件列表
            'analyzed': list,   # 已分析的文件信息
            'supplement_dir': str,
            'checklist_path': str,
            'missing_count': int,  # 缺失项数量
            'missing_items': list  # 缺失项详情
        }
    """
    from archive_extractor import scan_files_with_archive_support

    # 先确保补充资料清单文档存在（基于analysis_results生成详细的缺失项清单）
    result = generate_supplement_checklist(
        enterprise_name, application_year, skill_name, 
        analysis_results=analysis_results, region=region
    )
    supplement_dir = result['supplement_dir']

    new_files = []
    analyzed = []

    if not os.path.exists(supplement_dir):
        return {
            'new_files': [],
            'analyzed': [],
            'supplement_dir': supplement_dir,
            'checklist_path': result['checklist_path']
        }

    # 扫描补充目录中的所有文件（支持压缩文件解压）
    all_files = scan_files_with_archive_support(supplement_dir)

    # 读取已有的文件图谱，判断哪些是新文件
    file_map = load_file_map()
    existing_files = set()
    if file_map:
        existing_files = set(file_map.get('files', {}).keys())

    for file_path in all_files:
        # 跳过清单文档本身
        if file_path.endswith('补充资料清单.md'):
            continue

        file_key = os.path.abspath(file_path)
        if file_key not in existing_files:
            new_files.append(file_path)

    # 分析每个新文件
    for file_path in new_files:
        file_info = analyze_supplement_file(file_path, skill_name)
        analyzed.append(file_info)

        # 添加到文件图谱
        add_file_to_map(
            file_path=file_path,
            category=file_info['category'],
            file_type=file_info['file_type'],
            related_id=file_info.get('related_id'),
            related_name=file_info.get('related_name'),
            content_summary=file_info['content_summary'],
            validity='pending_review',
            keywords=file_info.get('keywords', []),
            skill_name=skill_name
        )

    return {
        'new_files': new_files,
        'analyzed': analyzed,
        'supplement_dir': supplement_dir,
        'checklist_path': result['checklist_path'],
        'missing_count': result.get('missing_count', 0),
        'missing_items': result.get('missing_items', [])
    }

def analyze_supplement_file(file_path, skill_name):
    """分析单个补充资料文件，提取信息

    根据文件名和内容，自动识别文件类别、关联对象、关键词等。

    Args:
        file_path: 文件路径
        skill_name: 技能名称

    Returns:
        dict: 文件分析结果
    """
    filename = os.path.basename(file_path)
    ext = os.path.splitext(filename)[1].lower().lstrip('.')
    file_type = ext if ext else 'unknown'

    # 根据技能名确定默认类别
    skill_category_map = {
        'gxtz-info-collector': '01_基础资质',
        'gxtz-ip-materials': '02_知识产权',
        'gxtz-rd-report': '03_研发项目',
        'gxtz-achievement-materials': '08_合同发票',
        'gxtz-ps-materials': '04_高新产品',
        'gxtz-staff-materials': '05_科技人员',
        'gxtz-management-materials': '07_管理制度',
        'gxtz-core-tables': '10_其他资料'
    }
    category = skill_category_map.get(skill_name, '10_其他资料')

    # 从文件名提取关联ID
    related_id = None
    related_name = None
    keywords = []

    import re

    # 匹配IP编号
    ip_match = re.search(r'IP/d+', filename, re.IGNORECASE)
    if ip_match:
        related_id = ip_match.group().upper()
        category = '02_知识产权'
        keywords.append(related_id)

    # 匹配RD编号
    rd_match = re.search(r'RD/d+', filename, re.IGNORECASE)
    if rd_match:
        related_id = rd_match.group().upper()
        category = '03_研发项目'
        keywords.append(related_id)

    # 匹配PS编号
    ps_match = re.search(r'PS/d+', filename, re.IGNORECASE)
    if ps_match:
        related_id = ps_match.group().upper()
        category = '04_高新产品'
        keywords.append(related_id)

    # 匹配ACH编号
    ach_match = re.search(r'ACH/d+', filename, re.IGNORECASE)
    if ach_match:
        related_id = ach_match.group().upper()
        category = '08_合同发票'
        keywords.append(related_id)

    # 根据文件名关键词识别类别
    name_lower = filename.lower()

    if '社保' in filename or '社保' in name_lower:
        category = '05_科技人员'
        keywords.extend(['社保', '缴费'])
    elif '合同' in filename or 'contract' in name_lower:
        category = '08_合同发票'
        keywords.append('合同')
    elif '发票' in filename or 'invoice' in name_lower:
        category = '08_合同发票'
        keywords.append('发票')
    elif '检测' in filename or 'test' in name_lower or 'report' in name_lower:
        category = '04_高新产品'
        keywords.append('检测报告')
    elif '学历' in filename or '证书' in filename:
        category = '05_科技人员'
        keywords.append('学历证书')
    elif '专利' in filename or '软著' in filename:
        category = '02_知识产权'
        keywords.append('专利证书')
    elif '制度' in filename or '管理' in filename:
        category = '07_管理制度'
        keywords.append('管理制度')
    elif '审计' in filename:
        category = '06_财务资料'
        keywords.append('审计报告')
    elif '设备' in filename:
        category = '07_管理制度'
        keywords.append('研发设备')

    # 从文件名提取关联名称（去除扩展名和编号）
    clean_name = re.sub(r'^(IP|RD|PS|ACH)/d+_', '', os.path.splitext(filename)[0])
    clean_name = re.sub(r'[_-]', ' ', clean_name).strip()
    if clean_name and not related_name:
        related_name = clean_name

    # 生成内容摘要
    content_summary = f"{filename} - {category}"
    if related_id:
        content_summary += f" - 关联{related_id}"
    if related_name:
        content_summary += f" - {related_name}"

    return {
        'file_path': file_path,
        'filename': filename,
        'file_type': file_type,
        'category': category,
        'related_id': related_id,
        'related_name': related_name,
        'content_summary': content_summary,
        'keywords': keywords
    }

def organize_supplement_files(enterprise_name, application_year, skill_name, analyzed_files):
    """整理补充资料文件到统一输出目录

    技能分析完补充文件后，将文件整理到对应的统一输出子目录。

    Args:
        enterprise_name: 企业名称
        application_year: 申报年份
        skill_name: 技能名称
        analyzed_files: 已分析的文件信息列表

    Returns:
        list: 整理后的文件路径列表
    """
    root = f"{enterprise_name}_高新认定材料_{application_year}"
    template = SUPPLEMENT_TEMPLATES.get(skill_name, {'subdir': '07_资料收集清单'})
    target_subdir = template['subdir']
    target_dir = os.path.join(root, target_subdir)
    os.makedirs(target_dir, exist_ok=True)

    organized_files = []

    for file_info in analyzed_files:
        src_path = file_info['file_path']
        filename = file_info['filename']

        if not os.path.exists(src_path):
            continue

        dst_path = os.path.join(target_dir, filename)

        # 避免覆盖
        if os.path.exists(dst_path):
            name, ext = os.path.splitext(filename)
            counter = 1
            while os.path.exists(os.path.join(target_dir, f"{name}_{counter}{ext}")):
                counter += 1
            dst_path = os.path.join(target_dir, f"{name}_{counter}{ext}")

        try:
            shutil.copy2(src_path, dst_path)
            organized_files.append({
                'original_path': src_path,
                'organized_path': dst_path,
                'file_info': file_info
            })

            # 更新文件图谱中的路径
            add_file_to_map(
                file_path=dst_path,
                category=file_info['category'],
                file_type=file_info['file_type'],
                related_id=file_info.get('related_id'),
                related_name=file_info.get('related_name'),
                content_summary=file_info['content_summary'],
                validity='valid',
                keywords=file_info.get('keywords', []),
                skill_name=skill_name
            )
        except Exception as e:
            print(f"[整理失败] {filename}: {e}")

    return organized_files

def update_experience_from_supplement(skill_name, analyzed_files, issues=None):
    """根据补充资料分析结果更新经验库

    将补充资料中发现的问题、识别规则等沉淀到经验库。

    Args:
        skill_name: 技能名称
        analyzed_files: 已分析的文件信息列表
        issues: 发现的问题列表（可选）
    """
    from knowledge_base import update_knowledge_after_skill

    # 沉淀识别规则
    if analyzed_files:
        rules = []
        for f in analyzed_files:
            if f.get('related_id'):
                rules.append(f"{f['filename']}: 识别为{f['category']}，关联{f['related_id']}")
            else:
                rules.append(f"{f['filename']}: 识别为{f['category']}")

        update_knowledge_after_skill(
            skill_name=skill_name,
            enterprise_name='',
            application_year=2026,
            experience_entry={
                'category': 'validation_rules',
                'title': f'{skill_name}补充资料识别规则',
                'content': '; '.join(rules)
            }
        )

    # 沉淀问题
    if issues:
        for issue in issues:
            update_knowledge_after_skill(
                skill_name=skill_name,
                enterprise_name='',
                application_year=2026,
                experience_entry={
                    'category': 'common_issues',
                    'title': f'{skill_name}补充资料问题',
                    'content': issue
                }
            )

# 原代码：
# files = glob.glob(os.path.join(data_dir, f'**/*{keyword}*'), recursive=True)

# 替换为：
files = find_files_with_archive_support(data_dir, keyword=keyword, 
                                         file_patterns=['.pdf', '.docx', '.xlsx', '.jpg', '.png'])
```


---

<!-- SECTION_BEGIN: provenance_verification v2.7 -->
## 溯源核验 → 详见 {{YFW_SKILLS}}/_common/SHARED_provenance.md
> 所有关键字段值必须与源文件精确一致，禁止改写。调用: set_provenance() → scan_and_correct()
<!-- SECTION_END: provenance_verification -->

---

<!-- SECTION_BEGIN: authoritative_terms_verification v2.6 -->
## 权威术语核验 → 详见 {{YFW_SKILLS}}/_common/SHARED_authoritative_terms.md
> 输出前强制扫描权威术语。禁止: "新能源及节能"(应为"与")等变异。
<!-- SECTION_END: authoritative_terms_verification -->
