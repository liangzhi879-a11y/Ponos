# office-fixtures —— `docx_edit.py` / `sheet_edit.py` 的**测试语料**

本目录是 `server/docx_edit.py`（Word 读写）与 `server/sheet_edit.py`（Excel 读写）的
回归网语料库。两个脚本此前**零测试覆盖**，本目录 + 同级两个 `.test.mjs` 是它们的第一层网。

来源：`scratch/collab-experiment/`（2026-09-14 文件协同可行性实验，
见该目录 `FINDINGS.md`）。**`scratch/` 被 `.gitignore:21` 忽略、不在版本控制内**，
因此测试**不能**直接引用它——换一台机器克隆仓库后那些文件不存在，测试会假红。
所以关键语料必须复制进本目录（已被 git 跟踪）。

---

## 一、入库的语料（bytes）**为什么是这 4 个**

取舍标准只有一条：**能否在不依赖外部商业软件的前提下复现**。

| 文件 | 体积 | 为什么必须入库（而不是现场生成） |
|---|---|---|
| `base.docx` | 37,781 B | 实验主文档（15 段 + 2 表，含混合 run 格式）。虽然 `tools/gen_docx.py` 能确定性生成同内容文档，但**入库一份固定字节**才能钉住"语料不被静默替换"——`docx-python.test.mjs` 有一条断言要求"生成脚本产物"与"入库字节"的 `read` 输出逐字节相等。 |
| `word_resaved.docx` | 40,192 B | **真 Word 2016 重存**同名文档（内容未改）。用于 T2「块序列稳定性」。**无法在本机复现**：python-docx 生成不出真 Word 的 zip 结构/run 重切方式，而 Word 不装就没有。这是唯一一条"必须入库字节"的硬理由。 |
| `xl_base.xlsx` | 31,326 B | Excel 主表（1 张表 `sheet1`，21 行 × 18 列，0 个公式）。生成脚本可复现内容，入库理由同 `base.docx`。 |
| `xl_insertrow.xlsx` | 28,584 B | `xl_base.xlsx` 在第 3 行插入一行后的版本。用于后续 C5「插入行导致坐标漂移」的指纹实验（当前测试网未使用，先入库备查）。 |

> 复制时已用 `md5sum` 逐对比对，与 `scratch/collab-experiment/` 原件一致。

## 二、由生成脚本现场生成的变体（不占版本库体积）

确定性可复现的变体一律**只入库脚本**，测试运行时生成到临时目录：

| 脚本 | 产出 |
|---|---|
| `tools/gen_docx.py` | `base.docx`（用于校验入库语料未被替换） |
| `tools/gen_variants.py` | `edit_one.docx` / `insert_one.docx` / `bold_one.docx` / `del_one.docx` / `table_edit.docx`（模拟应用内编辑的 5 类改动） |
| `tools/gen_xlsx_variants.py` | `formula.xlsx`（含公式格 `A22=SUM(A2:A8)`，锁 B8 现状）、`multi_sheet.xlsx`（第二张表 + active 切到 `Second`，锁"只读 active sheet"现状） |
| `tools/inspect_docx_runs.py` | **只读检查器**，输出段落的 run 分段与格式（`docx_edit.py read` 看不到 run，而 `set_para_text` 的行为恰恰在 run 层，必须直接看 XML 层） |

脚本约定：

- **不硬编码绝对路径**。输出目录按「参数 → env `YFW_FIXTURE_OUT` → 系统临时目录」解析，
  默认落在临时目录，绝不污染仓库。
- 只依赖 `python-docx` / `openpyxl`（仓库自带 python 已装），**不依赖 Word/Excel**。
- 变体全部是"对 base 的定点文本改写"，无随机、无时间戳 ⇒ 可重复生成。
  唯一不可重复的 zip 内部时间戳字节，正是 `base.docx` / `word_resaved.docx` 入库字节的理由。

## 三、怎么跑

```bash
node --test --test-timeout=300000 server/docx-python.test.mjs server/sheet-python.test.mjs
```

测试用 `kernel/knowledge-import.mjs` 的 `resolvePython()` 定位解释器
（`PONOS_PYTHON`/`YFWORKING_PYTHON` → 自带 `runtime/python/python.exe` → PATH）。
**这两个测试需要能跑 python 与上述两个库**；纯 node 环境会红，这是预期行为
（被测对象本身就是 python 脚本）。
