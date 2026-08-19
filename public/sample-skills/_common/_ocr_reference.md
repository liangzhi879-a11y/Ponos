<!-- SECTION_BEGIN: ocr_reference -->
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

**示例**：102页PDF（40页电子发票+62页合同扫描件）
- 40页文本页：用fitz提取，100%准确
- 62页扫描件页：用RapidOCR识别，平均置信度98.9%
- 总耗时：约3-5分钟（首次），缓存后秒级

### 命令速查

| 场景 | 命令 |
|------|------|
| **读PDF（推荐默认）** | `python doc_toolkit.py read --file <path> --format pdf --mode auto --project <project>` |
| 强制全部OCR（跳过文本层） | `python doc_toolkit.py read --file <path> --format pdf --mode ocr --force-ocr --project <project>` |
| 检测是否扫描件/混合型 | `python doc_toolkit.py detect-scan --file <path>` |
| OCR引擎直接调用 | `python ocr_engine.py ocr --file <path> --project <project>` |
| 合同字段提取 | `python contract_invoice_extractor.py extract --file <合同.pdf> --output-dir <dir>` |
| 发票字段提取 | `python contract_invoice_extractor.py extract --file <发票.pdf> --output-dir <dir>` |
| 批量提取目录 | `python contract_invoice_extractor.py batch --dir <目录> --output-dir <结果目录>` |
| 查询OCR缓存 | `python ocr_engine.py cache-list --project <project>` |

### OCR缓存机制（项目隔离，agent可重复读取）

- **缓存目录**: `.trae/ocr_cache/{project_name}/{file_md5}.json`
- **缓存key**: 文件内容MD5（文件变更后自动重新OCR）
- **项目隔离**: 通过 `--project` 参数指定项目名，不同项目缓存独立
- **项目名读取**: 自动从 `.trae/project_config.json` 读取 `project_name`
- **缓存命中**: 第二次读取同一文件直接读缓存，秒级返回

### 合同发票字段提取（针对扫描件的解决方案）

**合同字段**（contract_invoice_extractor.py 自动提取）：
- 合同编号、甲方、乙方、签订日期、合同金额、标的物、有效期

**发票字段**：
- 发票号、开票日期、购方名称、销方名称、纳税人识别号
- 货物明细（名称/规格/数量/单价/金额/税率/税额）
- 合计金额、合计税额、价税合计

**输出格式**: JSON（程序消费） + Excel（人工核验）双格式

### 禁止行为

| ❌ 禁止 | ✓ 正确做法 |
|---------|-----------|
| 用 `--mode text` 读混合型PDF（扫描件页会丢失） | 用 `--mode auto` 逐页智能处理 |
| 用整体`text.strip()==''`判定扫描件 | 用 `doc_toolkit.py detect-scan` 逐页检测 |
| 重复OCR同一文件 | 用 `--project` 参数启用缓存 |
| 手动写正则从扫描件提取字段 | 用 `contract_invoice_extractor.py extract` |
| 跳过OCR直接认为扫描件无内容 | 扫描件必须OCR后才能判断内容 |

### 环境依赖

```bash
# OCR必需库（已加入requirements.txt）
pip install rapidocr-onnxruntime onnxruntime pdf2image opencv-python

# 验证安装
python check_dependencies.py
# 预期：rapidocr_onnxruntime/onnxruntime/cv2/pdf2image 全部 ✓
```
<!-- SECTION_END: ocr_reference -->
