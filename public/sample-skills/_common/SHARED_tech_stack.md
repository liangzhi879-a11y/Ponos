# SHARED: 技术栈引用 — 所有 gxtz-* 技能共享
# 来源: gxtz-core-tables SKILL.md v1.34.0 (extracted 2026-07-21)
# 修改此文件即可同步所有技能，禁止在各 SKILL.md 中直接修改技术栈章节

## 技术栈引用（agent 处理文档前必读，禁止尝试不同方案）

> **核心原则**：本项目已预置成熟的文档处理工具包，agent 处理任何文件前必须先查表获取推荐方案，
> 禁止自行尝试不同库和方案。这能节省 80% 的文档处理探索时间。

### 快速决策流程（3步，不再尝试）

```
第一步：查表（1次调用，<1秒）
  python doc_toolkit.py info --file <文件路径>
  → 返回推荐库、读取命令、写入命令、常见场景

第二步：按返回方案直接调用（不再尝试）
  读取：python doc_toolkit.py read --file <路径> --format <格式>
  写入：python doc_toolkit.py write --file <路径> --format <格式> --data <json>
  转换：python doc_toolkit.py convert --input <路径> --to <格式>

第三步：如需复杂处理，调用专用脚本（见 _tech_stack_guide.md）
```

### 文件类型 → 处理方案速查表

| 扩展名 | 推荐库 | 读取命令 |
|--------|--------|---------|
| `.xlsx` | openpyxl | `doc_toolkit.py read --file X --format xlsx` |
| `.xls` | xlrd | `doc_toolkit.py read --file X --format xls` |
| `.docx` | python-docx | `doc_toolkit.py read --file X --format docx` |
| `.doc` | pywin32 | `doc_toolkit.py convert --input X --to docx`（先转换） |
| `.pdf` (文本) | PyMuPDF | `doc_toolkit.py read --file X --format pdf --mode text` |
| `.pdf` (表格) | pdfplumber | `doc_toolkit.py read --file X --format pdf --mode table` |
| `.txt` | 标准库 | `doc_toolkit.py read --file X --format txt` |
| `.json` | 标准库 | `doc_toolkit.py read --file X --format json` |

### 专用脚本速查（复杂任务直接调用）

| 任务 | 专用脚本 |
|------|---------|
| 生成核心表格（RD/PS/IP/TOAI/成果转化） | `generate_tables_from_template.py` |
| 生成资料收集清单 | `generate_checklist.py` |
| 发票匹配PS产品 | `invoice_ps_matcher.py` |
| RD-IP-PS三角映射 | `rd_ip_ps_matching.py` |
| 专审报告核对 | `audit_report_verifier.py` |
| PDF拆分/合并 | `pdf_splitter.py` |
| 企微会话查询 | `wecom_query.py` |
| Dify工作流生成RD立项书 | `dify_workflow.py` |
| 项目文件类型扫描 | `detect_file_types.py` |
| 依赖环境检查 | `check_dependencies.py` |

### 禁止的低效模式

| ❌ 禁止 | ✓ 正确做法 |
|---------|-----------|
| 用 openpyxl 读 .doc | 先 `doc_toolkit.py convert --to docx` |
| 从头创建 xlsx 文件 | 用 `generate_tables_from_template.py` 从模板复制 |
| 手动逐字节解析 PDF | 用 `doc_toolkit.py read --format pdf` |
| 尝试不同库直到成功 | 先 `doc_toolkit.py info` 查推荐方案 |
| 用 json 读非 json 文件 | 先 `doc_toolkit.py info --file X` 确认格式 |

### 环境初始化

```bash
python check_dependencies.py
pip install -r requirements.txt
python detect_file_types.py --dir "项目根目录" --recommend
```

完整技术栈指南：`_common/_tech_stack_guide.md`
