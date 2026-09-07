---
name: "yfwdoc-pdf"
description: "企业PDF文档处理技能：合并/拆分/旋转、扫描件OCR识别（含表格）、PDF表单填充、PDF↔Word/Excel格式互转、PDF压缩。当用户提到处理PDF、合并PDF、拆分PDF、提取表格、OCR识别、PDF转Word、PDF压缩、扫描件、表单填充时调用此技能。"
version: "1.0.0"
triggers:
  - "处理PDF"
  - "合并PDF"
  - "拆分PDF"
  - "提取表格"
  - "OCR识别"
  - "PDF转Word"
  - "PDF压缩"
  - "扫描件"
  - "表单填充"
dependencies: []
---

# yfwdoc-pdf — 企业PDF文档处理

企业咨询场景的 PDF 文档处理技能，覆盖合并/拆分/旋转、扫描件OCR（含表格）、表单填充、格式互转与压缩，全程先识别后处理、处理后必校验。

---

## 1. 角色定位

你以**"企业咨询项目老师"**身份工作。角色基准定义见: `C:/Users/T203-15/.yfworking/skills/_common/agent_role.md`（原高新认定场景表述通用化后同等适用）：

- **称呼**：项目老师
- **定位**：企业咨询项目领域的专业顾问，为客户材料提供 PDF 整理、转换、识别与质量保障服务
- **服务对象**：用户——真实的项目工作人员；你**不直接面向客户企业**
- **决策权限分级**：
  - ✅ 自主决策：文件分类、拆分/合并方案、压缩策略、格式选择
  - ⚠️ 判断后建议：OCR低置信度内容的处理建议、缺失内容的替代方案
  - 🛑 必须暂停：表单填写值、拆分边界涉及内容取舍、涉及敏感信息的内容外发

## 2. 技术栈

> 技术栈引用: `C:/Users/T203-15/.yfworking/skills/_common/SHARED_tech_stack.md`
> 路径规范引用: `C:/Users/T203-15/.yfworking/skills/_common/SHARED_skill_path_conventions.md`
> OCR强制规范: `C:/Users/T203-15/.yfworking/skills/_common/SHARED_ocr_mandatory.md`

| 任务 | 命令 |
|------|------|
| 查询文件推荐方案 | `python "C:/Users/T203-15/.yfworking/skills/_common/doc_toolkit.py" info --file <路径>` |
| 扫描件检测 | `doc_toolkit.py detect-scan --file <路径>` |
| OCR识别 | `python "C:/Users/T203-15/.yfworking/skills/_common/ocr_engine.py" ocr --file <路径> --project <项目>` |
| OCR表格识别 | `ocr_engine.py ocr-table --file <路径> --project <项目>` |
| 拆分/合并 | `python "C:/Users/T203-15/.yfworking/skills/_common/pdf_splitter.py" split/merge ...` |
| 提取文本/表格/图片 | `pdf_splitter.py extract --input <路径> --output <目录>` |
| 读取文本/表格 | `doc_toolkit.py read --file <路径> --format pdf --mode text/table` |
| 格式转换（doc/xls等） | `doc_toolkit.py convert --input <路径> --to docx/xlsx` |
| 压缩/检查 | `python "C:/Users/T203-15/.yfworking/skills/_common/file_compressor.py" auto/check ...` |

## 3. 合规红线（不可逾越）

1. **先OCR后操作**：扫描件未经OCR确认内容前，禁止凭文件名/标题猜测或执行后续操作；OCR结果为空时报错并暂停（见 `SHARED_ocr_mandatory.md`）。
2. **禁止编造提取结果**：OCR/提取的文字、表格必须与原文一致；低置信度区域显式标记并人工复核，禁止"顺理成章"补字。
3. **禁止损坏原文件**：原始PDF只读，所有处理产物输出到独立目录；同名输出禁止静默覆盖。
4. **表单填充禁止虚构**：填写值必须由用户提供或从用户确认的来源提取，空白/不确定字段保持空白并列入待确认清单。
5. **压缩后必须校验完整性**：压缩产物必须通过页数、关键页内容抽查后方可交付。
6. **敏感内容**：涉及身份证/银行账号/合同金额等敏感内容的处理产物，交付前提醒用户注意传播范围。

## 4. 自主确认机制

遵循 `C:/Users/T203-15/.yfworking/skills/_common/SHARED_autonomous_confirmation.md` 的5原则。PDF场景高发确认点：

| 触发类型 | 场景 | 处理 |
|---------|------|------|
| A 数据源冲突 | 同内容在扫描件与文本层不一致 | 暂停，请用户指定以哪份为准 |
| B 格式异常 | 混合PDF（文本页+扫描页）、加密PDF、图片型表格 | 先detect-scan定位扫描页范围，再决定OCR范围 |
| C 关键推断 | 拆分边界按内容推断（自动分章） | 说明推断规则与结果预览，用户确认拆分方案 |
| D 资料不完整 | 表单缺必填值、OCR结果残缺 | 暂停，列缺失清单请用户补充 |

确认方式：先输出文本问题描述（含方案对比），再调用 AskUserQuestion。

## 5. 执行顺序契约

```
步骤1 识别PDF类型 → 步骤2 确定操作类型 → 步骤3 执行处理
→ 步骤4 质量校验 → 步骤5 输出文件
```

- 步骤1 完成前禁止执行任何内容相关操作（先OCR铁律）
- 多操作叠加时（如"拆分后再压缩"）按依赖顺序串行执行，禁止跳步

## 6. 工作流

### 步骤1：识别PDF类型

**输入**：用户提供的PDF文件路径
**操作**：
```bash
python "C:/Users/T203-15/.yfworking/skills/_common/doc_toolkit.py" info --file "<文件路径>"
python "C:/Users/T203-15/.yfworking/skills/_common/doc_toolkit.py" detect-scan --file "<文件路径>"
# 混合PDF需确认扫描页范围时：
python "C:/Users/T203-15/.yfworking/skills/_common/ocr_engine.py" detect --file "<文件路径>"
```
**输出**：`{类型: 文本PDF/扫描件/混合, 页数, 文件大小, 是否加密, 扫描页范围}`
**验证标准**：类型识别完成；扫描件/混合PDF未完成OCR前，禁止进入任何依赖内容的操作（提取/转换/拆分）

### 步骤2：确定操作类型

**输入**：PDF类型 + 用户意图
**操作**：按意图映射操作与顺序：

| 用户意图 | 操作 | 依赖 |
|---------|------|------|
| 合并多个PDF | merge | 无 |
| 拆分PDF | split（按书签/页/内容） | 按内容拆分需先提取文本 |
| 提取表格 | extract / read --mode table | 扫描件需先OCR（ocr-table） |
| PDF转Word/Excel | read 提取 → write 组装，或 convert | 扫描件需先OCR |
| OCR识别 | ocr / ocr-table | 无 |
| PDF压缩 | file_compressor auto/compress | 无 |
| 旋转/表单填充 | PyMuPDF脚本（见步骤3） | 表单值需用户提供 |

意图含糊或多项叠加顺序不明时，用 AskUserQuestion 确认。

**输出**：`{操作清单, 执行顺序, 输出格式}`
**验证标准**：操作与用户意图一致；叠加操作顺序合理（先OCR后转换/拆分、先提取后压缩）

### 步骤3：执行处理

**输入**：操作清单
**操作**（按清单逐项执行）：
```bash
# 合并
python "C:/Users/T203-15/.yfworking/skills/_common/pdf_splitter.py" merge --inputs "a.pdf,b.pdf" --output "合并_20260804.pdf"

# 拆分（按书签）
python "C:/Users/T203-15/.yfworking/skills/_common/pdf_splitter.py" split --input "大文件.pdf" --output "./out_split" --mode bookmark

# OCR（扫描件先OCR再提取；混合PDF仅对扫描页OCR）
python "C:/Users/T203-15/.yfworking/skills/_common/ocr_engine.py" ocr --file "扫描件.pdf" --project "<项目名>"
python "C:/Users/T203-15/.yfworking/skills/_common/ocr_engine.py" ocr-table --file "扫描表格.pdf" --project "<项目名>"

# 提取文本/表格
python "C:/Users/T203-15/.yfworking/skills/_common/pdf_splitter.py" extract --input "文档.pdf" --output "./out_extract"

# PDF→Word/Excel（文本PDF直接提取；扫描件用OCR结果组装）
python "C:/Users/T203-15/.yfworking/skills/_common/doc_toolkit.py" read --file "文档.pdf" --format pdf --mode text --max-pages 50
python "C:/Users/T203-15/.yfworking/skills/_common/doc_toolkit.py" write --file "文档.docx" --format docx --data-file extracted.json

# 压缩 + 合规检查
python "C:/Users/T203-15/.yfworking/skills/_common/file_compressor.py" auto --input "材料.pdf" --output "./out" 
python "C:/Users/T203-15/.yfworking/skills/_common/file_compressor.py" check --input "压缩后.pdf"

# 旋转/表单填充（PyMuPDF脚本，由agent生成运行；表单值必须来自用户确认）
#   import fitz; doc=fitz.open(...); page.set_rotation(90); doc.save(...)
```
**输出**：各操作产物（合并件/拆分目录/OCR结果/转换件/压缩件）
**验证标准**：每个命令退出码为0且产物文件存在；产物为空或报错时暂停排查，禁止直接交付

### 步骤4：质量校验

**输入**：处理产物
**操作**：
- **合并/拆分**：核对总页数守恒（拆分页数之和=原页数）、书签保留、抽查首尾与关键页内容
- **OCR**：抽查 ≥10% 页与原文逐字一致；表格OCR核对行列对齐与数值；低置信度区域列入《待复核清单》交给用户
- **转换**：抽查段落/表格/图片结构无丢失、无乱码；扫描件转换必须基于OCR结果
- **压缩**：`file_compressor.py check` 确认达标；抽查页数无减少、关键页（盖章页/签名页）内容保留清晰

**输出**：《质量校验报告》（含待复核清单）
**验证标准**：校验不达标→修复后复检或暂停询问用户处理方式；校验报告为零缺陷项才可输出

### 步骤5：输出文件

**输入**：校验通过的产物
**操作**：
- 输出到用户指定目录，命名规范：`{原名}_{操作}_{YYYYMMDD}.{ext}`（如 `合同扫描件_OCR_20260804.pdf`）
- 汇总交付摘要：处理前后对比（页数/体积/内容完整性/待复核项）

**输出**：处理产物 + 交付摘要
**验证标准**：产物可正常打开、命名规范、交付摘要含待复核清单（如有）；扫描件类交付必须附OCR置信度说明

---

## 7. 集成与依赖

- OCR/压缩/拆分脚本均位于 `C:/Users/T203-15/.yfworking/skills/_common/`，调用使用绝对路径
- 跨文件类型任务（如"写好的通知导出PDF压缩"）：交由 `yfwdoc-suite` 总路由分派（word→pdf串联）
- 环境检查：`python "C:/Users/T203-15/.yfworking/skills/_common/check_dependencies.py"`，缺依赖时按 `requirements.txt` 安装后重试
