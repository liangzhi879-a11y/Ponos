# 技术栈使用指南（agent 必读）

> **核心问题**：过去 agent 处理文档时浪费大量时间尝试不同库和方案。
> **解决方案**：预置工具包 + 决策表，agent 直接查表调用，不再尝试。

## 快速决策流程

```
agent 收到文件处理任务
    ↓
第一步：查表（1次调用，<1秒）
    python doc_toolkit.py info --file <文件路径>
    → 返回推荐库、读取命令、写入命令、常见场景
    ↓
第二步：按返回的方案直接调用（不再尝试）
    - 读取：python doc_toolkit.py read --file <路径> --format <格式>
    - 写入：python doc_toolkit.py write --file <路径> --format <格式> --data <json>
    - 转换：python doc_toolkit.py convert --input <路径> --to <格式>
    ↓
第三步：如需复杂处理，调用专用脚本（见下表）
```

## 文件类型 → 处理方案速查表

| 扩展名 | 推荐库 | 读取命令 | 写入命令 | 专用脚本 |
|--------|--------|---------|---------|---------|
| `.xlsx` | openpyxl | `doc_toolkit.py read --file X --format xlsx` | `doc_toolkit.py write --file X --format xlsx --data <json>` | generate_tables_from_template.py（模板生成） |
| `.xls` | xlrd | `doc_toolkit.py read --file X --format xls` | 建议转xlsx | `doc_toolkit.py convert --input X --to xlsx` |
| `.docx` | python-docx | `doc_toolkit.py read --file X --format docx` | `doc_toolkit.py write --file X --format docx --data <json>` | generate_checklist.py（清单生成） |
| `.doc` | pywin32 | `doc_toolkit.py read --file X --format doc` | 先转docx | `doc_toolkit.py convert --input X --to docx` |
| `.pdf` | PyMuPDF | `doc_toolkit.py read --file X --format pdf --mode text` | — | pdf_splitter.py（拆分合并） |
| `.pdf` (表格) | pdfplumber | `doc_toolkit.py read --file X --format pdf --mode table` | — | invoice_ps_matcher.py（申请书PS提取） |
| `.txt` | 标准库 | `doc_toolkit.py read --file X --format txt` | `doc_toolkit.py write --file X --format txt --data <json>` | — |
| `.json` | 标准库 | `doc_toolkit.py read --file X --format json` | `doc_toolkit.py write --file X --format json --data <json>` | — |
| `.jpg/.png` | Pillow | `doc_toolkit.py info --ext .jpg` | — | — |
| `.zip` | 标准库 zipfile | — | — | archive_extractor.py |
| `.rar/.7z` | archive_extractor | — | — | archive_extractor.py |

## 任务 → 专用脚本速查表

| 任务 | 专用脚本 | 命令 |
|------|---------|------|
| 生成核心表格（RD/PS/IP/TOAI/成果转化） | generate_tables_from_template.py | `python generate_tables_from_template.py --template <模板> --output <输出> --data <data.json>` |
| 生成资料收集清单 | generate_checklist.py | `python generate_checklist.py --output <输出.docx> --data <data.json>` |
| 发票匹配PS产品 | invoice_ps_matcher.py | `python invoice_ps_matcher.py --application-pdf <申请书.pdf> --invoices <发票.xlsx>` |
| RD-IP-PS三角映射 | rd_ip_ps_matching.py | `python rd_ip_ps_matching.py --project-root <根目录>` |
| 专审报告核对 | audit_report_verifier.py | `python audit_report_verifier.py --audit-pdf <报告.pdf> --core-tables <表格目录>` |
| PDF拆分/合并 | pdf_splitter.py | `python pdf_splitter.py split --input <file> --pages <range> --output <dir>` |
| 企微会话查询 | wecom_query.py | `python wecom_query.py --action search --keyword <关键词>` |
| Dify工作流生成RD立项书 | dify_workflow.py | `python dify_workflow.py --action generate --rd-id <id> --count <n>` |
| 项目文件类型扫描 | detect_file_types.py | `python detect_file_types.py --dir <目录> --recommend` |
| 依赖环境检查 | check_dependencies.py | `python check_dependencies.py` |

## 禁止的低效模式

| ❌ 禁止 | ✓ 正确做法 |
|---------|-----------|
| 用 openpyxl 读 .doc | 先 `doc_toolkit.py convert --to docx` 转换 |
| 从头创建 xlsx 文件 | 用 `generate_tables_from_template.py` 从模板复制 |
| 手动逐字节解析 PDF | 用 `doc_toolkit.py read --format pdf` |
| 用 json 读非 json 文件 | 先 `doc_toolkit.py info --file X` 确认格式 |
| 尝试不同库直到成功 | 先 `doc_toolkit.py info` 查推荐方案 |
| 用 requests 下载本地文件 | 用 `shutil.copy` 或 `open()` |

## 环境初始化（新项目第一次执行）

```bash
# 1. 检查依赖
python .trae/skills/_common/check_dependencies.py

# 2. 如有缺失，一键安装
pip install -r .trae/skills/_common/requirements.txt

# 3. 扫描项目文件类型
python .trae/skills/_common/detect_file_types.py --dir "项目根目录" --recommend

# 4. 测试文档工具包
python .trae/skills/_common/doc_toolkit.py info --ext .xlsx
```

## 依赖清单（requirements.txt）

| 类别 | 库 | 用途 |
|------|-----|------|
| 核心 | openpyxl | .xlsx 读写 |
| 核心 | python-docx | .docx 读写 |
| 核心 | PyPDF2 | PDF 拆分/合并 |
| 核心 | pdfplumber | PDF 文本/表格提取 |
| 核心 | PyMuPDF | PDF 高效读取（申请书） |
| 核心 | Pillow | 图像提取 |
| 核心 | requests | HTTP 请求 |
| 企微 | pycryptodome | AES 解密 |
| 可选 | jieba | 中文分词 |
| 可选 | portalocker | 跨进程文件锁 |
| Windows | pywin32 | .doc→.docx 转换 |
| Windows | xlrd | .xls 读取 |

## 决策树（复杂场景）

```
需要读取PDF内容
├── 只需文本 → doc_toolkit.py read --format pdf --mode text
├── 需要表格 → doc_toolkit.py read --format pdf --mode table
├── 需要拆分 → pdf_splitter.py split
├── 需要从申请书提取PS → invoice_ps_matcher.py（专用）
└── 需要提取图片 → pdf_splitter.py extract-images

需要生成Excel表格
├── 是核心表格（RD/PS/IP/TOAI/成果转化）→ generate_tables_from_template.py
├── 是普通数据表 → doc_toolkit.py write --format xlsx
└── 需要校验对齐 → validate_tables.py

需要处理Word文档
├── 是.docx → doc_toolkit.py read/write --format docx
├── 是.doc → 先 convert --to docx，再按docx处理
├── 是资料清单 → generate_checklist.py
└── 需要对比两份docx → compare_docx.py
```
