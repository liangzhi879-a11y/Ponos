---
name: gxtz-ip-materials
description: "高新技术企业认定知识产权证明材料整理，严格区分专利证书与其他专利资料文献（说明书、权利要求书、通知书、缴费凭证等），包括专利证书、软著证书及附属材料、专利状态证明、转让材料等。当用户提到知识产权、专利、软著、IP材料、整理知识产权证明材料时调用此技能。支持RD-IP-PS自主匹配校验，确保所有知识产权不闲置（每个IP都关联到RD），发明专利可作为技术基础关联较早RD。v1.25.0新增：IP→成果三层映射策略（精确匹配→规范化匹配→人工确认）。v1.24.0: SKILL.md瘦身。"
version: "1.25.0"
triggers:
  - 知识产权
  - 专利
  - 软著
  - IP材料
  - 整理知识产权证明材料
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


## 合规红线（agent 执行前必读，违反即停止）

> **第一要求：严谨合规。所有数据必须真实可溯源，禁止任何形式的编造。**

### 禁止事项（违反任何一条立即停止并告警）

1. **禁止编造内容**：所有字段数据必须来自真实文件（立项书、证书、合同、发票、社保记录等），不得凭空编造
2. **禁止推断关键数据**：技术领域、研发费用、人员占比、专利状态等关键字段，必须以官方文档（所得税申报表/申请书/证书）为准，不得从项目名称推断
3. **禁止跳过脚本执行**：所有 `python {{PONOS_SKILLS}}/_common/xxx.py` 命令必须通过 Bash 真正执行，不得"阅读脚本逻辑自行编写等效代码"
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
python {{PONOS_SKILLS}}/_common/xxx.py <参数>
```

- 脚本路径必须使用项目相对路径
- 参数必须按脚本定义的 CLI 接口传递
- 不得通过"调用 xxx() 函数"的形式执行（函数描述不是可执行命令）

## 审核验证标准（agent 必须执行且通过）

### 审核脚本调用

最后一步必须执行对应的审核验证脚本：

```
python {{PONOS_SKILLS}}/_common/validate_ip.py --dir "输出目录" --project-root "项目根目录"
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

# 知识产权证明材料整理（区分专利证书与其他专利资料文献）

## 描述
本技能用于整理高新技术企业认定所需的知识产权证明材料。**核心原则：严格区分专利证书与其他专利资料文献（说明书、权利要求书、通知书、缴费凭证等），分别排查、分别整理、分别命名。** 包括专利证书、软件著作权证书及附属材料（申请表、源程序、设计说明书）、专利状态证明材料（登记簿副本、年费缴费发票、评价报告）、转让/许可材料等。需确保知识产权与RD表、PS表、成果转化表的关联关系正确。

## 使用场景
- 用户提到"知识产权"、"专利"、"软著"、"IP材料"
- 用户需要整理或修改知识产权证明材料
- 用户需要区分专利证书与其他专利资料文献
- 用户需要整理软著附属材料（申请表、源程序、设计说明书）
- 用户需要整理专利转让材料（合同、手续合格通知书）

## 知识产权资料分类体系（核心：区分证书与其他文献）

### 一、证书扫描件（核心证明文件，网报必须上传）
| 序号 | 资料名称 | IP类型 | 适用条件 | 格式要求 |
|------|----------|--------|----------|----------|
| 1 | 发明专利证书扫描件 | I类 | 所有发明专利 | PDF，单个≤2M |
| 2 | 集成电路布图设计登记证书扫描件 | I类 | 所有集成电路布图 | PDF，单个≤2M |
| 3 | 实用新型专利证书扫描件 | II类 | 所有实用新型 | PDF，单个≤2M |
| 4 | 外观设计专利证书扫描件 | II类 | 所有外观设计 | PDF，单个≤2M |
| 5 | 软件著作权证书扫描件 | II类 | 所有软件著作权 | PDF，单个≤2M |

### 二、软著附属材料（证书之外的必备材料，仅软著需要）
| 序号 | 资料名称 | 适用条件 | 格式要求 |
|------|----------|----------|----------|
| 1 | 软件著作权申请表 | 每项软著1份 | PDF |
| 2 | 软件源程序文档 | 每项软著1份 | PDF/Word（前30页+后30页源代码，含软件名称页眉） |
| 3 | 软件设计说明书/用户手册 | 每项软著1份 | PDF（含软件功能描述、技术架构、操作说明） |

### 三、专利状态证明材料（验证专利有效性）
| 序号 | 资料名称 | 适用IP类型 | 适用条件 | 格式要求 |
|------|----------|------------|----------|----------|
| 1 | 专利登记簿副本 | 发明专利 | 建议提供，近3个月内出具 | PDF |
| 2 | 专利年费缴费发票 | 发明+实用新型 | **广东省必须提供**；深圳建议提供 | PDF/扫描件 |
| 3 | 专利权评价报告 | 实用新型+外观 | 建议提供，近3年内 | PDF |

### 四、转让/许可材料（如有转让或许可）
| 序号 | 资料名称 | 适用条件 | 格式要求 |
|------|----------|----------|----------|
| 1 | 知识产权转让合同/许可合同 | 受让或许可获得IP时 | PDF |
| 2 | 知识产权局手续合格通知书 | **必须提供**（仅合同无效） | PDF |
| 3 | 全球独占许可协议（5年以上） | II类IP授权不在近三年时 | PDF |

### 五、其他知识产权相关材料
| 序号 | 资料名称 | 适用条件 | 格式要求 |
|------|----------|----------|----------|
| 1 | 参与制订标准证明材料 | 加分项 | PDF |
| 2 | 知识产权获奖证书 | 有则提供 | PDF |
| 3 | 知识产权管理制度文件 | 有则提供 | PDF |

## 统一输出目录规范

本技能生成的文件必须统一存放到项目输出根目录下，便于用户查看操作。

### 输出根目录
`{企业名称}_高新认定材料_{申报年份}/`

统一目录结构：00_核心表格 / 01_研发立项报告 / 02_知识产权证明 / 03_成果转化证明 / 04_高新产品证明 / 05_科技人员材料 / 06_管理制度材料 / 07_资料收集清单 / _校验报告

### 本技能输出子目录
`02_知识产权证明/`（校验/审核报告输出到 `_校验报告/`）

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
python {{PONOS_SKILLS}}/_common/progress_sync.py check-deps ^
    --project-root "." ^
    --skill "gxtz-ip-materials"
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
6. 调用 `generate_supplement_checklist(enterprise_name, application_year, 'gxtz-ip-materials')` 生成/更新补充资料清单文档
7. 调用 `scan_supplement_dir(enterprise_name, application_year, 'gxtz-ip-materials')` 扫描补充资料目录：
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

### 第一步：读取IP表数据
1. 从核心表格中读取IP表数据
2. 提取知识产权基本信息：编号、名称、类别、专利号、授权日期、获得方式
3. 提取知识产权关联信息：关联RD项目、关联成果转化
4. 根据类别确定IP类型（I类/II类）和所需材料清单

### 第一步扩展：企微补充知识产权材料（v1.16.0新增，可选增强）

**触发条件**：本地缺失专利证书/软著证书 + wecom 数据源可用

**执行步骤**：
1. 诊断数据源：
   ```bash
   python {{PONOS_SKILLS}}/_common/wecom_query.py diagnose
   ```
   - 检查 `overall_ready=true`，否则跳过本扩展步骤

2. 一键式按企业名称收集知识产权材料：
   ```bash
   python {{PONOS_SKILLS}}/_common/wecom_query.py collect-by-enterprise \
     --enterprise "{企业}" \
     --out "{企业}_高新认定材料_{年份}/_补充资料/gxtz-ip-materials" \
     --keyword "专利,发明,实用新型,外观设计,软著,软件著作权" \
     --from {起始月} --to {结束月}
   ```

3. 审查收集结果：
   - 检查导出文件被 `scan_supplement_dir()` 识别并登记到 file_map.json
   - **会话归属一致性**：所有导出文件的 `.wecom_meta.json` 的 `conversation_id` 必须属于目标企业（无串客户）

详见模块十二：企业微信会话实时查询与附件收集。

### 第二步：分类查找知识产权相关文件（区分证书与其他文献）

**核心：使用 find_ip_related_files 查找每个IP的所有相关文件，然后用分类函数区分证书与其他文献。**

```python
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

def classify_ip_files_by_type(ip_files, ip_category, acquire_method, region='shenzhen'):
    """将IP相关文件按类型分类（区分证书与其他专利资料文献）
    
    Returns:
        dict: 按类型分类的文件字典
    """
    classified = {
        # 一、证书扫描件（核心证明文件）
        'certificate': None,
        # 二、软著附属材料（仅软著）
        'software_application_form': None,
        'source_code_document': None,
        'design_manual': None,
        # 三、专利状态证明材料
        'patent_register_copy': None,
        'annual_fee_invoice': None,
        'evaluation_report': None,
        # 四、转让/许可材料
        'transfer_contract': None,
        'transfer_notification': None,
        'exclusive_license': None,
        # 五、其他
        'other_files': []
    }
    
    # 证书文件关键词（仅匹配证书本身）
    certificate_keywords = {
        '发明专利': ['发明专利证书', '发明证书'],
        '集成电路布图': ['集成电路布图', '布图设计登记'],
        '实用新型': ['实用新型专利证书', '实用新型证书'],
        '外观设计': ['外观设计专利证书', '外观设计证书', '外观专利证书'],
        '软件著作权': ['软件著作权证书', '软著证书', '计算机软件著作权登记证书']
    }
    
    # 排除关键词（这些属于其他专利资料文献，不是证书）
    exclude_keywords = ['说明书', '权利要求书', '通知书', '缴费', '年费', '申请表', 
                        '源程序', '源代码', '用户手册', '设计说明书', '登记簿',
                        '评价报告', '转让合同', '许可合同', '手续合格']
    
    for file_path in ip_files:
        file_name = os.path.basename(file_path)
        
        # 1. 识别证书扫描件（排除其他文献）
        if not any(exclude in file_name for exclude in exclude_keywords):
            for cat, keywords in certificate_keywords.items():
                if cat in ip_category or any(kw in file_name for kw in keywords):
                    if file_path.endswith('.pdf') and classified['certificate'] is None:
                        classified['certificate'] = file_path
                        break
        
        # 2. 识别软著附属材料
        if '软件著作权' in ip_category or '软著' in ip_category:
            if '申请表' in file_name:
                classified['software_application_form'] = file_path
            elif '源程序' in file_name or '源代码' in file_name:
                classified['source_code_document'] = file_path
            elif '说明书' in file_name or '用户手册' in file_name or '设计说明' in file_name:
                classified['design_manual'] = file_path
        
        # 3. 识别专利状态证明材料
        if '登记簿' in file_name:
            classified['patent_register_copy'] = file_path
        elif '年费' in file_name or ('缴费' in file_name and '发票' in file_name):
            classified['annual_fee_invoice'] = file_path
        elif '评价报告' in file_name:
            classified['evaluation_report'] = file_path
        
        # 4. 识别转让/许可材料
        if '转让合同' in file_name or '许可合同' in file_name:
            classified['transfer_contract'] = file_path
        elif '手续合格' in file_name or '合格通知书' in file_name:
            classified['transfer_notification'] = file_path
        elif '独占许可' in file_name:
            classified['exclusive_license'] = file_path
        
        # 5. 未分类文件
        if not any([
            classified['certificate'] == file_path,
            classified['software_application_form'] == file_path,
            classified['source_code_document'] == file_path,
            classified['design_manual'] == file_path,
            classified['patent_register_copy'] == file_path,
            classified['annual_fee_invoice'] == file_path,
            classified['evaluation_report'] == file_path,
            classified['transfer_contract'] == file_path,
            classified['transfer_notification'] == file_path,
            classified['exclusive_license'] == file_path
        ]):
            classified['other_files'].append(file_path)
    
    return classified

def validate_ip_materials_completeness(classified_files, ip_row, region='shenzhen'):
    """验证知识产权材料的完整性（区分证书与其他文献）
    
    Returns:
        dict: 验证结果，包含缺失材料列表和问题列表
    """
    ip_category = ip_row.get('类别', '')
    acquire_method = ip_row.get('获得方式', '自主研发')
    
    result = {
        'complete': True,
        'missing': [],
        'issues': []
    }
    
    # 1. 证书扫描件（必须）
    if not classified_files.get('certificate'):
        result['missing'].append('证书扫描件')
        result['issues'].append(f"缺少{ip_category}证书扫描件")
        result['complete'] = False
    
    # 2. 软著附属材料（软著必须）
    if '软件著作权' in ip_category or '软著' in ip_category:
        if not classified_files.get('software_application_form'):
            result['missing'].append('软著申请表')
            result['issues'].append("缺少软件著作权申请表PDF")
            result['complete'] = False
        if not classified_files.get('source_code_document'):
            result['missing'].append('源程序文档')
            result['issues'].append("缺少软件源程序文档（前30页+后30页）")
            result['complete'] = False
        if not classified_files.get('design_manual'):
            result['missing'].append('设计说明书/用户手册')
            result['issues'].append("缺少软件设计说明书/用户手册")
            result['complete'] = False
    
    # 3. 专利状态证明材料
    # 发明专利：建议提供专利登记簿副本
    if '发明专利' in ip_category and not classified_files.get('patent_register_copy'):
        result['issues'].append("建议提供专利登记簿副本（近3个月内出具）")
    
    # 广东省：发明+实用新型必须提供年费缴费发票
    if region == 'guangdong' and ('发明专利' in ip_category or '实用新型' in ip_category):
        if not classified_files.get('annual_fee_invoice'):
            result['missing'].append('年费缴费发票')
            result['issues'].append("广东省申报必须提供最近年费缴费发票")
            result['complete'] = False
    
    # 实用新型+外观：建议提供专利权评价报告
    if ('实用新型' in ip_category or '外观设计' in ip_category) and not classified_files.get('evaluation_report'):
        result['issues'].append(f"建议提供{ip_category}专利权评价报告")
    
    # 4. 转让/许可材料（受让IP必须）
    if '受让' in acquire_method or '转让' in acquire_method:
        if not classified_files.get('transfer_contract'):
            result['missing'].append('转让合同/许可合同')
            result['issues'].append("受让IP缺少转让合同/许可合同")
            result['complete'] = False
        
        # 必须提供手续合格通知书（仅合同无效）
        if not classified_files.get('transfer_notification'):
            result['missing'].append('手续合格通知书')
            result['issues'].append("受让IP必须提供知识产权局手续合格通知书（仅合同无效）")
            result['complete'] = False
    
    return result
```

### 第三步：整理知识产权证明材料（按类型分别整理）

**核心：证书与其他专利资料文献分别整理、分别命名，避免混淆。**

```python
def organize_ip_materials_by_type(enterprise_name, ip_table, data_dir, output_dir, region='shenzhen'):
    """按类型分别整理知识产权证明材料"""
    
    output_files = []
    
    for _, ip_row in ip_table.iterrows():
        ip_id = ip_row['知识产权编号']
        ip_name = ip_row['知识产权名称']
        ip_category = ip_row.get('类别', '')
        ip_number = ip_row.get('专利号/著作权号', '')
        acquire_method = ip_row.get('获得方式', '自主研发')
        
        # 查找该IP的所有相关文件
        ip_files = find_ip_related_files(data_dir, ip_id, ip_name, ip_number)
        
        # 按类型分类文件（区分证书与其他文献）
        classified = classify_ip_files_by_type(ip_files, ip_category, acquire_method, region)
        
        # 验证材料完整性
        validation = validate_ip_materials_completeness(classified, ip_row, region)
        
        # 1. 整理证书扫描件（核心证明文件）
        cert_output = None
        if classified.get('certificate'):
            cert_output = os.path.join(output_dir, f"{ip_id}_{ip_name}.pdf")
            # 如果证书是单个PDF，直接复制；否则合并
            if len([classified['certificate']]) == 1 and classified['certificate'].endswith('.pdf'):
                shutil.copy2(classified['certificate'], cert_output)
            else:
                merge_ip_certificate_pdf([classified['certificate']], cert_output)
        
        # 2. 整理软著附属材料（合并到证书PDF中）
        if '软件著作权' in ip_category or '软著' in ip_category:
            sw_attachments = []
            if classified.get('software_application_form'):
                sw_attachments.append(classified['software_application_form'])
            if classified.get('source_code_document'):
                sw_attachments.append(classified['source_code_document'])
            if classified.get('design_manual'):
                sw_attachments.append(classified['design_manual'])
            
            # 将软著附属材料追加到证书PDF中
            if sw_attachments and cert_output and os.path.exists(cert_output):
                merge_additional_pages_to_pdf(cert_output, sw_attachments)
        
        # 3. 整理专利状态证明材料（单独保存，不合并到证书PDF）
        status_proofs = []
        if classified.get('patent_register_copy'):
            status_proofs.append(('专利登记簿副本', classified['patent_register_copy']))
        if classified.get('annual_fee_invoice'):
            status_proofs.append(('年费缴费发票', classified['annual_fee_invoice']))
        if classified.get('evaluation_report'):
            status_proofs.append(('专利权评价报告', classified['evaluation_report']))
        
        for proof_name, proof_file in status_proofs:
            proof_output = os.path.join(output_dir, f"{ip_id}_{ip_name}_{proof_name}.pdf")
            if proof_file.endswith('.pdf'):
                shutil.copy2(proof_file, proof_output)
        
        # 4. 整理转让/许可材料（单独保存）
        transfer_files = []
        if classified.get('transfer_contract'):
            transfer_files.append(('转让合同', classified['transfer_contract']))
        if classified.get('transfer_notification'):
            transfer_files.append(('手续合格通知书', classified['transfer_notification']))
        if classified.get('exclusive_license'):
            transfer_files.append(('独占许可协议', classified['exclusive_license']))
        
        for trans_name, trans_file in transfer_files:
            trans_output = os.path.join(output_dir, f"{ip_id}_{ip_name}_{trans_name}.pdf")
            if trans_file.endswith('.pdf'):
                shutil.copy2(trans_file, trans_output)
        
        output_files.append({
            'ip_id': ip_id,
            'ip_name': ip_name,
            'certificate_file': cert_output,
            'classified_files': classified,
            'validation': validation
        })
    
    return output_files

def merge_additional_pages_to_pdf(main_pdf_path, additional_files):
    """将附加文件追加到主PDF中（用于软著附属材料合并到证书PDF）"""
    try:
        merger = PdfMerger()
        merger.append(main_pdf_path)
        
        for file_path in additional_files:
            if file_path.lower().endswith('.pdf'):
                merger.append(file_path)
        
        # 写入临时文件后替换
        temp_path = main_pdf_path + '.tmp'
        merger.write(temp_path)
        merger.close()
        
        os.replace(temp_path, main_pdf_path)
        
        # 检查文件大小
        size_mb = os.path.getsize(main_pdf_path) / (1024 * 1024)
        if size_mb > 2:
            print(f"警告：{main_pdf_path}大小{size_mb:.2f}MB超过2MB限制")
    
    except Exception as e:
        print(f"合并PDF失败：{e}")
```

### 第四步：生成知识产权证明材料清单（区分证书与其他文献）

```python
def generate_ip_materials_checklist(enterprise_name, ip_table, rd_table, achievement_table, 
                                     organize_results, region='shenzhen'):
    """生成知识产权证明材料清单（区分证书与其他专利资料文献）"""
    
    wb = Workbook()
    ws = wb.active
    ws.title = '知识产权清单'
    
    # 表头（区分证书与其他文献）
    headers = ['序号', 'IP编号', '知识产权名称', '类别', 'IP类型', '专利号/著作权号', 
               '授权日期', '获得方式', '证书状态', '软著附属材料', '专利登记簿', 
               '年费缴费发票', '评价报告', '转让合同', '手续合格通知书', 
               '关联RD项目', '关联成果转化', '证明材料文件名', '存在问题', '补充要求']
    ws.append(headers)
    
    for idx, (ip_row, result) in enumerate(zip(ip_table.iterrows(), organize_results), 1):
        ip_id = ip_row[1]['知识产权编号']
        ip_name = ip_row[1]['知识产权名称']
        ip_category = ip_row[1].get('类别', '')
        classified = result['classified_files']
        validation = result['validation']
        
        # 确定IP类型
        ip_type = 'I类' if ('发明' in ip_category or '集成电路' in ip_category) else 'II类'
        
        # 查找关联RD和成果转化
        associations = find_ip_associations(ip_row[1], rd_table, achievement_table)
        
        # 软著附属材料状态
        if '软件著作权' in ip_category or '软著' in ip_category:
            sw_status = []
            sw_status.append('申请表✓' if classified.get('software_application_form') else '申请表✗')
            sw_status.append('源程序✓' if classified.get('source_code_document') else '源程序✗')
            sw_status.append('设计说明书✓' if classified.get('design_manual') else '设计说明书✗')
            sw_status_str = ' / '.join(sw_status)
        else:
            sw_status_str = '不适用'
        
        ws.append([
            idx,
            ip_id,
            ip_name,
            ip_category,
            ip_type,
            ip_row[1].get('专利号/著作权号', ''),
            pd.to_datetime(ip_row[1]['授权日期']).strftime('%Y-%m-%d') if '授权日期' in ip_row[1] else '',
            ip_row[1].get('获得方式', '自主研发'),
            '已提供' if classified.get('certificate') else '未提供',
            sw_status_str,
            '已提供' if classified.get('patent_register_copy') else '未提供',
            '已提供' if classified.get('annual_fee_invoice') else ('未提供' if region == 'guangdong' and ip_type in ['I类', 'II类'] and '发明' in ip_category or '实用新型' in ip_category else '不适用'),
            '已提供' if classified.get('evaluation_report') else '未提供',
            '已提供' if classified.get('transfer_contract') else ('未提供' if '受让' in ip_row[1].get('获得方式', '') else '不适用'),
            '已提供' if classified.get('transfer_notification') else ('未提供' if '受让' in ip_row[1].get('获得方式', '') else '不适用'),
            ','.join(associations['related_rd']),
            ','.join(str(x) for x in associations['related_achievements']),
            f"{ip_id}_{ip_name}.pdf",
            '；'.join(validation['issues']) if validation['issues'] else '',
            '；'.join(validation['missing']) if validation['missing'] else ''
        ])
    
    # 统计Sheet
    ws2 = wb.create_sheet('证书统计')
    ws2.append(['类别', 'IP类型', '数量', '占比', '证书已提供', '证书未提供'])
    category_counts = ip_table.groupby('类别').size()
    total = len(ip_table)
    for category, count in category_counts.items():
        ip_type = 'I类' if ('发明' in category or '集成电路' in category) else 'II类'
        ws2.append([category, ip_type, count, f"{count/total*100:.1f}%", '', ''])
    ws2.append(['合计', '', total, '100%', '', ''])
    
    output_path = f"{enterprise_name}-知识产权证明材料清单.xlsx"
    wb.save(output_path)
    return output_path
```

### 第五步：数据一致性校验
1. 验证IP表中的知识产权数量与证书数量一致
2. 验证RD表引用的IP编号在IP表中存在
3. 验证成果转化表引用的IP编号在IP表中存在
4. 验证知识产权授权时间符合近三年要求
5. 验证软著附属材料完整性（申请表+源程序+设计说明书）
6. 验证转让IP的手续合格通知书（必须提供）
7. 验证广东省发明+实用新型的年费缴费发票（必须提供）
8. 生成《知识产权数据校验报告》

### 第六步：审核验证（必须通过才能提交）
1. **完整性审核**
   - 检查所有知识产权是否都有证书扫描件
   - 检查发明专利是否都有专利登记簿副本
   - 检查所有知识产权是否都有缴费凭证
   - 检查有转让的知识产权是否都有受让/许可合同

2. **一致性审核**
   - 验证证书上的权利人与企业名称一致
   - 验证证书上的专利号/著作权号与IP表一致
   - 验证证书上的知识产权名称与IP表一致
   - 验证RD表、成果转化表引用的IP编号都在IP表中
   - 验证授权时间符合申报要求

3. **规范性审核**
   - 检查文件命名是否符合规范（调用 `detect_naming_issues()` 检测hash命名/微信图片/扫描仪/手机/WPS拼图/多次优化/大小写不一致/学历不统一等问题，调用 `batch_validate_naming()` 批量校验IP/RD/PS/成果转化/财务/网报/学历/社保命名规范）
   - 检查文件大小是否符合要求：单个证书≤2M
   - 检查PDF文件格式是否正确
   - 检查证书扫描件清晰度

4. **时间合规性审核**
   - 验证所有IP授权日期≤申报年份
   - 验证II类知识产权（实用新型、外观设计、软著）授权时间
   - 对于授权时间不在近三年的II类IP，确认是否有5年以上全球独占许可

**IP不闲置校验（v1.12.0）**：
- 调用match_rd_ip_ps_with_audit()，检查stats.idle_ip_count必须为0（所有知识产权都关联到RD）
- 检查发明专利是否正确作为技术基础关联到相关RD（invention豁免时间约束）
- 审阅audit_report第六章，对兜底分配的IP人工确认技术相关性

5. **生成审核报告**
   - 生成《知识产权证明材料审核报告》
   - 列出所有审核问题及整改建议
   - 审核结论：通过/不通过

6. **审核通过条件**
   - 所有知识产权证书齐全
   - 证书信息与IP表一致
   - 关联关系正确
   - 时间合规
   - 文件格式规范

7. **审核不通过处理**
   - 列出所有问题清单
   - 提供整改建议
   - 要求整改后重新提交审核

### 最终步前：同步进度（v1.x.1新增，进度管理集成）

完成所有工作后、文件整理前，更新进度看板：

```bash
python {{PONOS_SKILLS}}/_common/progress_sync.py update-stage ^
    --project-root "." ^
    --skill "gxtz-ip-materials" ^
    --status completed
```

此命令将自动匹配本技能对应的阶段并标记为"已完成"。
（注意：finalize 步骤也会自动同步进度，此步为双重保障。）


### 最终步：文件整理与知识库更新（强制执行，审核验证通过后必须执行）

**执行以下命令整理文件并更新知识库**（在项目根目录运行）：

```bash
python {{PONOS_SKILLS}}/_common/project_context_manager.py finalize --enterprise "{企业名称}" --year {申报年份} --skill "gxtz-ip-materials" --no-move
```

此命令将：按19类目录结构整理文件 → 生成 .claude/_file_management_report.md 整理报告 → 更新 file_map.json / experience_base.json / project_index.json → 校验3个json文件已生成。
- **finalize 后强制验证（v2.0 新增，不可跳过）**：
  1. 立即读取 `.claude/_finalize_diff.json`，检查 `moved_from_protected`（应为空）和 `warnings`（应为空）
  2. `ls` 扫描 02_知识产权证明（至少IP数量×2），确认文件数不少于预期
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

# PDF处理（如需要合并）
try:
    from PyPDF2 import PdfMerger, PdfReader, PdfWriter
except ImportError:
    pass

def find_certificate_files(data_dir, ip_row):
    """查找知识产权证书文件"""
    ip_name = ip_row['知识产权名称']
    ip_number = ip_row['专利号/著作权号']
    ip_id = ip_row['知识产权编号']
    
    # 搜索策略：按专利号、名称、编号搜索
    search_patterns = [
        os.path.join(data_dir, f'*{ip_number}*'),
        os.path.join(data_dir, f'*{ip_id}*'),
        os.path.join(data_dir, f'*{ip_name}*'),
    ]
    
    found_files = []
    for pattern in search_patterns:
        matches = glob.glob(pattern)
        found_files.extend(matches)
    
    return list(set(found_files))

def merge_ip_certificate_pdf(certificate_files, output_path, max_size_mb=2):
    """合并知识产权证书为PDF"""
    merger = PdfMerger()
    for f in certificate_files:
        if f.lower().endswith('.pdf'):
            merger.append(f)
    merger.write(output_path)
    merger.close()
    
    # 检查文件大小
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    if size_mb > max_size_mb:
        print(f"警告：文件{output_path}大小{size_mb:.2f}MB超过{max_size_mb}MB限制")
    
    return output_path
```

## 关键时间逻辑
```python
def validate_ip_time(ip_table, application_year):
    """验证知识产权时间约束"""
    errors = []
    
    # 近三年定义
    recent_three_years = [application_year - 3, application_year - 2, application_year - 1]
    
    for _, row in ip_table.iterrows():
        auth_date = pd.to_datetime(row['授权日期'])
        auth_year = auth_date.year
        
        # 规则1：授权日期必须在申报前
        if auth_date > datetime(application_year, 6, 30):  # 一般申报截止6月30日
            errors.append(f"{row['知识产权编号']}授权日期{auth_date.strftime('%Y-%m-%d')}晚于申报截止日期")
        
        # 规则2：I类知识产权无使用年限限制，II类知识产权需在近3年内授权或满足5年以上全球独占许可
        ip_category = row['类别']
        if '实用新型' in ip_category or '外观设计' in ip_category or '软件著作权' in ip_category:
            if auth_year not in recent_three_years:
                # II类知识产权授权时间不在近三年，需确认是否满足5年独占许可
                errors.append(f"{row['知识产权编号']}为II类知识产权，授权年份{auth_year}不在近三年{recent_three_years}内，需确认是否有5年以上全球独占许可")
    
    return errors
```

## 数据关联逻辑
```python
def load_ip_related_data(data_dir):
    """加载知识产权关联数据"""
    data = {}
    
    # 加载核心表格
    core_file = find_file(data_dir, '*核心表格*.xlsx')
    if core_file:
        data['ip_table'] = pd.read_excel(core_file, sheet_name='IP表')
        data['rd_table'] = pd.read_excel(core_file, sheet_name='RD表')
        data['ps_table'] = pd.read_excel(core_file, sheet_name='PS表')
        data['achievement_table'] = pd.read_excel(core_file, sheet_name='科技成果转化情况表')
    
    return data

def find_ip_associations(ip_row, rd_table, achievement_table):
    """查找知识产权的关联关系"""
    ip_id = ip_row['知识产权编号']
    
    # 1. 查找关联的RD项目
    related_rd = []
    for _, rd_row in rd_table.iterrows():
        rd_ip_ids = [x.strip() for x in str(rd_row.get('知识产权编号', '')).split(',') if x.strip()]
        if ip_id in rd_ip_ids:
            related_rd.append(rd_row['研发活动编号'])
    
    # 2. 查找关联的成果转化
    related_achievements = []
    for _, ach_row in achievement_table.iterrows():
        if ip_id in str(ach_row.get('关联IP', '')):
            related_achievements.append(ach_row['科技成果序号'])
    
    return {
        'ip_id': ip_id,
        'related_rd': related_rd,
        'related_achievements': related_achievements
    }

def validate_ip_rd_association(ip_table, rd_table):
    """验证IP表与RD表的关联一致性"""
    errors = []
    ip_ids = set(ip_table['知识产权编号'].tolist())
    
    for _, rd_row in rd_table.iterrows():
        rd_ip_field = str(rd_row.get('知识产权编号', ''))
        rd_ip_ids = [x.strip() for x in rd_ip_field.split(',') if x.strip()]
        
        for ip_id in rd_ip_ids:
            if ip_id not in ip_ids:
                errors.append(f"RD表{rd_row['研发活动编号']}引用的{ip_id}在IP表中不存在")
    
    return errors

def find_file(directory, pattern):
    """查找匹配模式的文件"""
    matches = glob.glob(os.path.join(directory, pattern))
    return matches[0] if matches else None
```

## 输入要求
1. **知识产权表**（IP表）- 包含IP编号、名称、类别、获得方式、专利号/著作权号、授权日期、所属单位、摘要、先进性说明、支持作用说明
2. **专利证书扫描件** - 在本地资料目录中查找
3. **软件著作权证书扫描件** - 在本地资料目录中查找
4. **RD表** - 用于验证IP与RD的关联关系
5. **科技成果转化情况表** - 用于验证IP与成果转化的关联关系

## 输出规范

### 1. 知识产权证明材料清单
```python
def generate_ip_materials_checklist(enterprise_name, ip_table, rd_table, achievement_table, certificate_status):
    """生成知识产权证明材料清单"""
    
    wb = Workbook()
    ws = wb.active
    ws.title = '知识产权清单'
    
    # 表头
    headers = ['序号', '知识产权编号', '知识产权名称', '类别', '专利号/著作权号', 
               '授权日期', '证书状态', '关联RD项目', '关联成果转化', '证明材料文件名', '备注']
    ws.append(headers)
    
    for idx, (_, row) in enumerate(ip_table.iterrows(), 1):
        ip_id = row['知识产权编号']
        
        # 查找关联RD和成果转化
        associations = find_ip_associations(row, rd_table, achievement_table)
        
        # 获取证书状态
        status = certificate_status.get(ip_id, '待确认')
        
        ws.append([
            idx,
            ip_id,
            row['知识产权名称'],
            row['类别'],
            row['专利号/著作权号'],
            pd.to_datetime(row['授权日期']).strftime('%Y-%m-%d'),
            status,
            ','.join(associations['related_rd']),
            ','.join(str(x) for x in associations['related_achievements']),
            f"{ip_id}_{row['知识产权名称']}.pdf",
            ''
        ])
    
    # 统计Sheet
    ws2 = wb.create_sheet('证书统计')
    ws2.append(['类别', '数量', '占比'])
    category_counts = ip_table['类别'].value_counts()
    total = len(ip_table)
    for category, count in category_counts.items():
        ws2.append([category, count, f"{count/total*100:.1f}%"])
    ws2.append(['合计', total, '100%'])
    
    output_path = f"{enterprise_name}-知识产权证明材料清单.xlsx"
    wb.save(output_path)
    return output_path
```

### 2. 知识产权证明材料文件
```python
def organize_ip_certificate_files(enterprise_name, ip_table, data_dir, output_dir):
    """整理知识产权证明材料文件"""
    
    output_files = []
    
    for _, row in ip_table.iterrows():
        ip_id = row['知识产权编号']
        ip_name = row['知识产权名称']
        
        # 查找证书文件
        cert_files = find_certificate_files(data_dir, row)
        
        if not cert_files:
            print(f"警告：未找到{ip_id}({ip_name})的证书文件")
            continue
        
        # 合并为PDF
        output_path = os.path.join(output_dir, f"{ip_id}_{ip_name}.pdf")
        merge_ip_certificate_pdf(cert_files, output_path)
        output_files.append(output_path)
    
    return output_files
```

## 整理要求
1. **证书完整性**：必须包含所有申报的知识产权证书
2. **名称一致性**：证书上的名称必须与IP表中的名称一致
3. **编号一致性**：专利号/著作权号必须与IP表中的编号一致
4. **授权时间**：授权日期必须在申报前，II类知识产权需在近三年内或满足5年独占许可
5. **权利人**：权利人必须是申报企业
6. **关联正确性**：IP与RD、成果转化的关联关系必须与核心表格一致

## 文件格式规范
1. **PDF格式**：.pdf格式
2. **文件大小**：单个证书≤2M
3. **文件命名**：{IP编号}_{知识产权名称}.pdf
4. **文件加密**：不得加密

## 数据一致性检查
```python
def validate_ip_consistency(ip_table, rd_table, achievement_table, certificate_status):
    """验证知识产权数据一致性"""
    errors = []
    
    # 1. 数量一致性
    ip_count = len(ip_table)
    cert_count = len([k for k, v in certificate_status.items() if v == '已提供'])
    if ip_count != cert_count:
        errors.append(f"知识产权数量({ip_count})与证书数量({cert_count})不一致")
    
    # 2. 编号一致性：RD表引用的IP编号必须存在于IP表
    errors.extend(validate_ip_rd_association(ip_table, rd_table))
    
    # 3. 时间一致性
    errors.extend(validate_ip_time(ip_table, datetime.now().year))
    
    # 4. 权利人一致性：证书上的权利人必须是申报企业
    # 需要人工核对证书扫描件
    
    return errors
```

## 工作流程
1. **加载数据**：读取IP表、RD表、科技成果转化表
2. **证书查找**：在本地资料目录中查找每个知识产权的证书文件
3. **信息核对**：核对证书信息与IP表的一致性（名称、编号、权利人、授权日期）
4. **关联验证**：验证IP与RD表、成果转化表的关联关系
5. **文件整理**：按照命名规范合并证书为PDF文件
6. **清单生成**：生成知识产权证明材料清单
7. **一致性检查**：运行数据一致性检查
8. **质量检查**：检查文件质量和完整性

## v1.25.0 IP→成果三层映射策略

> **经验来源**：EXP-2026-07-25-012（中瑞远博项目：23软著+2发明→26成果匹配）
> **背景**：软著全称与成果目录名不完全一致（如成果名含V1.0后缀、IP名不含），直接字符串匹配失败率高。部分成果无对应IP需标记缺失。

### 三层映射策略

```
第1层：精确名称匹配
  └→ 软著核心名 == 成果目录名（去除序号前缀）

第2层：去后缀规范化匹配
  └→ 去除V1.0/V2.0等版本后缀 + 去空格 + 去特殊字符
  └→ 例："中药可视化大数据中台系统V1.0" → "中药可视化大数据中台系统"

第3层：人工确认
  └→ 前两层均未匹配的成果/IP，输出三张清单供项目负责人确认
```

### 匹配后必须输出三张清单

```
1. 已匹配清单：N个成果已匹配 / M个IP已分配
2. 无IP成果清单：成果编号+成果名称（无对应知识产权），标记为"缺失"
3. 多余IP清单：IP名称（未关联到任何成果），保留在IP清单中但不强行关联
```

### 禁止事项

- ❌ 禁止将多余IP强行关联到不相关的成果
- ❌ 禁止仅凭成果名称关键词推测IP归属
- ❌ 禁止跳过三张清单的输出

---

**RD-IP-PS自主匹配校验（v1.12.0）**：整理知识产权材料时，应调用 `match_rd_ip_ps_with_audit(rd_list, ps_list, ip_list)` 校验每个IP是否都关联到RD；若 audit_report 显示 idle_ip_count>0，说明有IP闲置，需人工复核这些IP是否应纳入或补充关联RD。发明专利豁免时间约束，可关联较早年份RD作为技术基础。

## 常见问题处理
1. **证书缺失**：提示用户补充证书扫描件
2. **名称不一致**：核对专利局公告信息，确认以官方公告为准
3. **权利人变更**：需提供权利人变更证明
4. **II类知识产权超期**：确认是否有5年以上全球独占许可协议
5. **关联关系错误**：核对核心表格，修正RD表和成果转化表中的IP引用
6. **文件大小超限**：压缩图片分辨率或拆分文件

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
