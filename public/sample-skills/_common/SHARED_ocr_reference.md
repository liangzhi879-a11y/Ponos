# SHARED: OCR能力引用 — 所有 gxtz-* 技能共享
# 来源: gxtz-core-tables SKILL.md v1.34.0 (extracted 2026-07-21)
# 修改此文件即可同步所有技能

## OCR能力引用（agent 处理PDF前必读）

> **核心原则**：项目PDF可能是**混合型**（电子发票页+扫描件合同页混合），
> 必须用 `--mode auto` 逐页智能处理，**不能假设整个PDF都是文本页或都是扫描件**。
> 直接用 `--mode text` 会跳过扫描件页，导致合同内容完全丢失！

### OCR引擎：RapidOCR（基于ONNX Runtime）

**选择RapidOCR的原因**：
- 基于ONNX Runtime推理，**无Windows兼容性问题**
- 使用PaddleOCR的PP-OCRv4模型，中文识别准确率>95%（实测合同扫描件98.9%）
- 安装轻量（约50MB），无需PaddlePaddle框架（800MB+）
- 无需系统Tesseract二进制

### 混合型PDF处理策略（核心机制）

`--mode auto`（默认）会逐页检测页面类型，自动选择最优处理方式：

| 页面类型 | 检测条件 | 处理方式 | 速度 |
|---------|---------|---------|------|
| **text** | 字符数≥100 | fitz直接提取文本层 | 极快（100%准确） |
| **scan** | 字符数<10 + 有图片 | RapidOCR识别 | 约2-5秒/页 |
| **empty** | 字符数<10 + 无图片 | 跳过 | - |

### 命令速查

| 场景 | 命令 |
|------|------|
| **读PDF（推荐默认）** | `python doc_toolkit.py read --file <path> --format pdf --mode auto --project <project>` |
| 强制全部OCR | `python doc_toolkit.py read --file <path> --format pdf --mode ocr --force-ocr --project <project>` |
| 检测扫描件/混合型 | `python doc_toolkit.py detect-scan --file <path>` |
| OCR引擎直接调用 | `python ocr_engine.py ocr --file <path> --project <project>` |
| 合同字段提取 | `python contract_invoice_extractor.py extract --file <合同.pdf> --output-dir <dir>` |
| 发票字段提取 | `python contract_invoice_extractor.py extract --file <发票.pdf> --output-dir <dir>` |

### OCR缓存机制

- **缓存目录**: `.trae/ocr_cache/{project_name}/{file_md5}.json`
- **缓存key**: 文件内容MD5（文件变更后自动重新OCR）
- **项目隔离**: 通过 `--project` 参数指定，缓存独立

### 禁止行为

| ❌ 禁止 | ✓ 正确做法 |
|---------|-----------|
| 用 `--mode text` 读混合型PDF | 用 `--mode auto` 逐页智能处理 |
| 用整体`text.strip()==''`判定扫描件 | 用 `doc_toolkit.py detect-scan` 逐页检测 |
| 重复OCR同一文件 | 用 `--project` 参数启用缓存 |
| 手动写正则从扫描件提取字段 | 用 `contract_invoice_extractor.py extract` |
| **检测到扫描页但跳过 OCR**（v2026-07-22 新增） | **必须 OCR 处理所有扫描页，结果空则报错** |

### 强制执行规则（v2026-07-22 新增，违反立即停止）

**PDF 处理必须按以下顺序执行，禁止跳过任何步骤**：

```
步骤1：先检测（强制）
  python doc_toolkit.py detect-scan --file <path>
  ↓
  必须查看输出：
    - is_mixed=True → 跳到步骤2A（混合型处理）
    - is_scanned=True → 跳到步骤2B（纯扫描件 OCR）
    - 都是 False → 跳到步骤2C（纯文本提取）

步骤2A：混合型 PDF（v2026-07-22 关键修复点）
  python doc_toolkit.py read --file <path> --mode auto --project <project>
  ↓
  auto 模式会逐页处理：
    - 文本页 → 直接提取
    - 扫描页 → 自动 OCR
  ↓
  校验输出：
    - text_page_count + scan_page_count 应 = total_pages
    - 扫描页 ocr_text 不应为空（空则报错"扫描页未识别"）

步骤2B：纯扫描件
  python doc_toolkit.py read --file <path> --mode auto --project <project>
  ↓
  整本 OCR，结果不为空才算成功

步骤2C：纯文本 PDF
  python doc_toolkit.py read --file <path> --mode auto --project <project>
  ↓
  整本文本提取

步骤3：执行后校验（强制，v2026-07-22 新增）
  ✓ 扫描页数 = 0 → 纯文本提取正常
  ✓ 扫描页数 > 0 且 OCR 结果非空 → 正常
  ✗ 扫描页数 > 0 且 OCR 结果为空 → 报错"扫描页未识别"，禁止继续
```

**agent 责任红线**：
- ❌ 禁止仅用 `--mode text` 处理 PDF（混合型/扫描件数据会全部丢失）
- ❌ 禁止"OCR 失败后静默退回文本模式"（必须修复 OCR 错误或报错）
- ❌ 禁止"扫描件不重要可以跳过"（扫描件中可能有关键合同/发票数据）
- ❌ 禁止跳过步骤3的执行后校验（校验失败必须报错，不允许继续后续步骤）
- ✓ 检测发现扫描页 → 必须 OCR，结果空时报错

### 环境依赖

```bash
pip install rapidocr-onnxruntime onnxruntime pdf2image opencv-python
python check_dependencies.py
```
