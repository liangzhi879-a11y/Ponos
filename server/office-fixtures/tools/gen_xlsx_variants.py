# -*- coding: utf-8 -*-
"""生成 sheet 侧的**确定性**测试变体（openpyxl 直接构造，无 Word/Excel 依赖、无随机）。

  formula.xlsx    —— xl_base.xlsx 的副本 + 一个公式格 A22=`=SUM(A2:A8)`
                     用于锁 `sheet_edit.py` 对公式格「静默跳过」的现状（B8）
  multi_sheet.xlsx—— xl_base.xlsx 的副本 + 第二张表 `Second`，**并把 active 切到 Second**
                     用于锁 `read` 「只读 active sheet、其余表完全不可见」的现状

用法：
    python gen_xlsx_variants.py [输出目录]
    # 不传参数时：输出目录 = env `YFW_FIXTURE_OUT` 或系统临时目录

**为什么入库的是脚本而不是这两个产物**：它们完全由 openpyxl 确定性构造（不需要
Excel/Word 这类外部软件），入库脚本即可随处重建；而 `word_resaved.docx`（真 Word 重存
字节）无法在本机复现，只能入库字节。二者的取舍标准一致：**能否不依赖外部软件复现**。
"""
import os
import shutil
import sys
import tempfile

from openpyxl import load_workbook

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'xl_base.xlsx')
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else (
    os.environ.get('YFW_FIXTURE_OUT') or tempfile.gettempdir()
)
os.makedirs(OUTDIR, exist_ok=True)


def out(name):
    return os.path.join(OUTDIR, name)


# 1) formula.xlsx —— 公式格
f1 = out('formula.xlsx')
shutil.copy(SRC, f1)
wb = load_workbook(f1)
wb.active.cell(row=22, column=1).value = '=SUM(A2:A8)'
wb.save(f1)
print('formula.xlsx:    A22 = =SUM(A2:A8)')

# 2) multi_sheet.xlsx —— 第二张表 + active 切到它
m1 = out('multi_sheet.xlsx')
shutil.copy(SRC, m1)
wb = load_workbook(m1)
ws2 = wb.create_sheet('Second')
ws2.cell(row=1, column=1).value = 'SECOND-MARKER'
wb.active = wb.sheetnames.index('Second')
wb.save(m1)
print('multi_sheet.xlsx: sheets =', load_workbook(m1).sheetnames, 'active = Second')

print('outdir:', OUTDIR)
