---
name: "gxtz-submission-packager"
description: "高新技术企业认定申报材料打包，根据申报系统要求（资料要求.xlsx）处理用户指定的证明材料（扫描→排序→合并→压缩→命名校验→校验），生成最终上传包。v1.1.0：新增交付前AI水印强制检测（validate_submission.py 第7维校验）。v1.0.0初始版本：19类材料打包+OCR强制校验+缺失材料确认协议+五级递进压缩+命名合规校验。"
version: "1.1.0"
triggers:
  - "打包"
  - "申报打包"
  - "材料打包"
  - "上传准备"
  - "提交材料"
  - "最终版本"
  - "申报包"
  - "提交系统"
  - "申报系统要求"
---

<!-- SECTION_BEGIN: ocr_mandatory -->
## OCR强制规范 → 详见 {{PONOS_SKILLS}}/_common/SHARED_ocr_mandatory.md
> ⚠️ 核心铁律：先OCR后操作，禁止猜测，必须等待，结果空则报错。
> 速查：`python ocr_engine.py detect --file <path>` → `python ocr_engine.py ocr --file <path> --project <project>`
<!-- SECTION_END: ocr_mandatory -->

# 申报材料打包技能 (gxtz-submission-packager)

## 触发条件

当用户提到以下关键词时调用此技能：

**主触发词**：打包、申报打包、材料打包、上传准备、提交材料、最终版本、申报包、提交系统
**辅触发词**：申报系统要求、资料要求、上传文件、19类材料、申报校验
**上下文词**：高新申报、打包、上传、提交、校验、最终

---

## 角色定位

你是高新技术企业认定申报材料打包助手。在这个阶段，所有19类材料已经由各专项技能生成/整理完毕。你的任务是：

1. **扫描**项目目录，按19类材料分组，OCR强制识别所有扫描件内容
2. **排序**按申报系统要求的顺序排列
3. **合并**多文件按策略合并（per-item / per-category）
4. **压缩**调用 file_compressor 五级递进压缩到目标大小
5. **命名**校验并修正文件名符合规范
6. **校验**输出6维完整性检查报告
7. **缺失确认**发现缺失材料列出清单，交由用户确认，**绝不自动生成**

---

## 合规红线

1. **绝不自动生成任何材料文件** — 到打包阶段资料应该已完善，缺失时只列出清单与用户确认
2. **OCR强制校验** — 所有扫描件必须通过OCR内容验证，不得跳过
3. **不修改原始文件** — 所有操作在 `_最终申报包/` 目录下完成
4. **不丢弃文件** — 压缩失败的文件标记警告但保留，不删除
5. **AI水印零容忍** — 交付材料不得包含任何AI生成水印字样，检测命中必须清除

---

## 执行顺序契约

1. **顺序执行**：scan → 用户确认 → pack → validate，不可跳过
2. **失败即停**：scan 发现整个类别缺失时，阻止 pack（除非 `--force`）
3. **不可跳过审核**：pack 完成后必须先 validate 校验
4. **脚本调用规范**：所有操作通过 `Bash` 调用 `_common/` 下脚本，禁止 agent 自行编写等效代码

---

## 审核验证标准

| 维度 | 检查项 | 阈值 | 不通过处理 |
|------|--------|------|------------|
| 完整性 | 19类是否齐全 | 100% | ⚠ 警告，列出缺失 |
| 命名 | 文件名是否符合规范 | 正则匹配 | ⚠ 警告，自动修正 |
| 大小 | 每文件 ≤ 上限 | ≤100% | ✗ 错误，需重新压缩 |
| 格式 | PDF未加密、可打开 | 100% | ✗ 错误 |
| PDF页数 | 非空PDF | ≥1页 | ✗ 错误 |
| OCR可读 | 扫描件文本层 | 智能检测 | ⚠ 警告 |
| AI水印 | 内容不得含AI生成标识 | 零命中 | ✗ 错误，必须清除后重新打包 |

**通过条件**：无 ✗ 错误项，⚠ 警告项已记录并告知用户。
**失败处理**：有 ✗ 错误项时，修正后重新执行 pack。

---

## 核心工作流

### Step 0: 环境检查

```
python {{PONOS_SKILLS}}/_common/check_dependencies.py --skill submission-packager
```

### Step 1: scan — 扫描预览

扫描项目目录，按19类材料分组，OCR强制识别，生成预览报告。

```bash
python {{PONOS_SKILLS}}/_common/submission_packager.py scan  \
    --project-root "项目目录"  \
    --requirements "99.其他资料/资料要求.xlsx"
```

**输出**：
- `_扫描预览报告.json` — 完整JSON扫描结果
- 控制台摘要：完整/不完整/缺失统计 + OCR统计 + 缺失清单

**scan 阶段 OCR 要求**：
- 对所有PDF文件执行 `ocr_engine.py detect` 检测是否为扫描件
- 对扫描件执行 `ocr_engine.py ocr` 提取文本
- 验证提取文本是否包含该类材料的预期关键词
- OCR失败的扫描件列入警告清单
- **禁止跳过任何PDF的OCR检测**

### Step 2: 用户确认

scan 输出预览报告后，agent 必须：

1. 清晰展示预览摘要（完整/不完整/缺失各类数量）
2. **缺失类别**：明确告知用户哪些类别缺失，要求补充
3. **超限文件**：告知哪些文件超标，pack 阶段将自动压缩
4. **OCR失败文件**：告知哪些扫描件OCR失败，建议检查
5. **命名不合规**：告知哪些文件命名不规范，pack 阶段将自动修正
6. **内容不匹配**：告知哪些文件OCR内容与预期不符，建议人工核查

等待用户确认后再执行 pack。

### Step 3: pack — 执行打包

```bash
# 全部19类打包
python {{PONOS_SKILLS}}/_common/submission_packager.py pack  \
    --project-root "项目目录"  \
    --requirements "99.其他资料/资料要求.xlsx"  \
    --output-dir "_最终申报包"

# 仅处理指定类别
python {{PONOS_SKILLS}}/_common/submission_packager.py pack  \
    --project-root "项目目录"  \
    --categories "1,2,3,6,7,8,9"  \
    --force  # 跳过确认
```

**pack 内部流程**（按类别逐类处理）：
1. 扫描源文件（递归搜索项目目录，排除 .trae 和 _最终申报包）
2. 按类别规则排序
3. 按策略合并PDF（调用 pdf_splitter.merge_pdfs）
4. 压缩到目标大小（调用 file_compressor.auto_compress → compress --quick）
5. 按命名规则重命名
6. OCR校验输出文件

**合并策略**：

| 材料类别 | 策略 | 说明 |
|----------|------|------|
| IP/RD/PS（1-3） | per-item | 每个IP/RD/PS独立一个PDF |
| 成果转化/标准（4-5） | per-item | 每个成果/标准独立一个PDF |
| 财务/纳税（8-9） | per-year | 每年一个PDF |
| 营业执照（6） | single | 仅1个JPG/PNG |
| 其余（7,10-19） | single | 合并为1个PDF |

**压缩策略**：
```
Round 1: 合并后检查大小
Round 2: 超标 → file_compressor auto（balanced模式）
Round 3: 仍超标 → file_compressor compress --quick（直跳ultra DPI降级）
Round 4: 仍超标 → ⚠ "需手动处理"，不丢弃
```

### Step 4: validate — 最终校验

```bash
python {{PONOS_SKILLS}}/_common/submission_packager.py validate  \
    --output-dir "_最终申报包/"
```

或使用独立校验脚本：

```bash
python {{PONOS_SKILLS}}/_common/validate_submission.py  \
    --output-dir "_最终申报包/"
```

**validate 检查项**（7维）：
- 19类是否齐全
- 文件命名是否合规
- 文件大小是否 ≤ 上限
- PDF是否未加密、可打开、非空
- 扫描件OCR可读性
- 内容关键词匹配
- **AI水印检测**（v1.1.0新增）：扫描全部文件文本层，检测AI生成水印字样，命中则 🚫 报错

### Step 5: 输出目录结构

```
_最终申报包/
├── 01_知识产权证明材料/IP01_xxx.pdf, IP02_xxx.pdf ...
├── 02_企业研究开发活动情况证明材料/RD01_xxx.pdf ...
├── ...
├── 19_打印申请书签字盖章扫描件/打印申请书签字盖章扫描件.pdf
├── _打包校验报告.md
└── _缺失材料清单.xlsx（如有缺失）
```

---

## 19类材料速查表

| 序号 | 材料名称 | 合并策略 | 大小上限 | 允许格式 |
|------|----------|----------|----------|----------|
| 1 | 知识产权证明材料 | per-item | 2MB | PDF |
| 2 | 企业研究开发活动情况证明材料 | per-item | 2MB | PDF |
| 3 | 上年度高新技术产品（服务）证明材料 | per-item | 4MB | PDF |
| 4 | 科技成果转化情况证明材料 | per-item | 2MB | PDF |
| 5 | 国家或行业标准制定情况证明材料 | per-item | 2MB | PDF |
| 6 | 营业执照 | single | 0.5MB | JPG/PNG |
| 7 | 申报书封皮 | single | 1MB | PDF |
| 8 | 近三年财务审计报告 | per-year | 100MB | PDF |
| 9 | 近三年企业所得税纳税申报表 | per-year | 5MB | PDF |
| 10 | 近三年研发费用专项审计报告 | single | 100MB | PDF |
| 11 | 近一年高新产品收入专项审计报告 | single | 100MB | PDF |
| 12 | 研发组织管理制度及辅助账 | single | 20MB | PDF |
| 13 | 研发机构设立及产学研合作证明材料 | single | 20MB | PDF |
| 14 | 科技成果转化激励制度及双创平台 | single | 5MB | PDF |
| 15 | 科技人员培养引进及绩效奖励制度 | single | 5MB | PDF |
| 16 | 人力资源情况证明材料 | single | 8MB | PDF |
| 17 | 上年度代表性销售合同与发票 | single | 20MB | PDF |
| 18 | 企业承诺书 | single | 1MB | PDF |
| 19 | 打印申请书签字盖章扫描件 | single | 50MB | PDF |

> 特殊：材料6（营业执照）是唯一不允许PDF格式的项目，仅接受JPG/PNG。

---

## OCR 强制要求

> **所有扫描件必须通过OCR内容验证，不允许跳过。** 这是本技能区别于其他技能的强制性要求。

OCR执行策略：
- **scan阶段**：对每个PDF执行 `ocr_engine.py detect`，判断是否为扫描件
- **扫描件**：执行 `ocr_engine.py ocr` 提取文本内容
- **内容验证**：比对提取文本是否包含该类材料的预期关键词
- **pack后**：对输出文件执行二次OCR，确保合并/压缩后仍可读
- **失败处理**：OCR失败标记警告，列入报告，但不阻止打包（可能有水印/低质量扫描件）

OCR配置：
- 引擎：RapidOCR ONNX（主）+ OpenVINO（回退）
- 语言：ch（中文）
- DPI：300
- 最低置信度：0.6

---

## 缺失材料处理协议

> **到打包阶段，资料应该已经比较完善。如果有缺失，第一时间与用户确认，绝不自动生成/撰写/编造任何材料。**

| 缺失类型 | 处理方式 |
|----------|----------|
| 整个类别缺失 | ⚠ 列入缺失清单，阻止pack（除非 --force） |
| 类别中个别项目缺失 | ⚠ 列入警告，提示核查，不阻止 |
| 内容疑似不对（OCR不匹配） | ⚠ 列入待确认清单，提示人工核查 |
| 文件损坏（无法打开） | ✗ 错误，阻止pack |
| 文件大小远超限制（2倍以上） | ⚠ 警告，标注需手工处理 |

---

## 技术依赖

### 脚本依赖（_common/）

| 脚本 | 用途 | 调用方式 |
|------|------|----------|
| `submission_packager.py` | 打包引擎（scan/pack/validate/list-requirements） | Bash |
| `validate_submission.py` | 独立校验脚本 | Bash |
| `file_compressor.py` | PDF/图片压缩 | 由 submission_packager 内部调用 |
| `pdf_splitter.py` | PDF合并 | 由 submission_packager 内部调用 |
| `ocr_engine.py` | OCR检测与识别 | 由 submission_packager 内部调用 |
| `naming_compliance.py` | 命名合规 | 可被调用（命名规则引用） |
| `output_version_manager.py` | 输出版本管理 | 打包前备份 |

### Python依赖

所有依赖已在 `_common/requirements.txt` 中就绪：
- `PyMuPDF (fitz)` — PDF读取/合并
- `PyPDF2`, `pdfplumber` — PDF文本提取
- `rapidocr-onnxruntime` / `rapidocr-openvino` — OCR引擎
- `Pillow` — 图片处理
- `openpyxl` — 读取资料要求.xlsx

---

## 输出隐患自查（8维度）

技能结束任务后，必须按以下8个维度进行隐患自查并汇报：

| 维度 | 检查内容 |
|------|----------|
| ①原始资料缺失 | _缺失材料清单中是否有未补充的必传项 |
| ②文本质量 | OCR失败的扫描件数量、比例，是否存在低置信度文件 |
| ③逻辑关联 | IP/RD/PS编号是否连续，文件名编号是否与核心表格一致 |
| ④字数问题 | 合并后的PDF文件是否有空白页（0页检测） |
| ⑤文档格式 | 是否有非允许格式文件混入，PDF是否加密 |
| ⑥政策符合性 | 19类是否齐全，IP≥5件、RD≥5项、PS≥1项（硬指标） |
| ⑦数据可溯源性 | 每个输出文件是否能追溯到源文件路径 |
| ⑧AI水印 | 所有输出文件是否通过AI水印检测（v1.1.0新增，命中即报错） |

汇报格式：每个维度 ✓/⚠/✗ 状态 + 具体隐患说明。

---

## 使用 `list-requirements` 快速查看要求

```bash
python {{PONOS_SKILLS}}/_common/submission_packager.py list-requirements
python {{PONOS_SKILLS}}/_common/submission_packager.py list-requirements --format json
```

---

## 经验沉淀

技能执行中遇到问题，即时调用 capture 提交经验；收工时调用 finalize 汇聚经验。

```bash
python {{PONOS_SKILLS}}/_common/project_context_manager.py capture  \
    --project-root "项目路径"  \
    --skill "gxtz-submission-packager"  \
    --enterprise "企业名"  \
    --problem-type common_issue  \
    --problem-desc "问题描述"  \
    --solution "解决方案"
```
