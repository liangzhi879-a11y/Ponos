# -*- coding: utf-8 -*-
"""生成 docx 变体，模拟「应用内编辑」路径的几种改动类型。

  edit_one.docx    —— 改第 5 段（正文）一个字
  insert_one.docx  —— 在第 2 段之后插入一个新段落
  bold_one.docx    —— 仅把第 5 段设为粗体（文字不变）
  del_one.docx     —— 删除第 6 段
  table_edit.docx  —— 改表格 1 里的一个单元格

用法：
    python gen_variants.py <源 docx> [输出目录]
    # 不传参数时：源 = 本目录上一级的 base.docx，输出目录 = env `YFW_FIXTURE_OUT` 或系统临时目录

移植自 scratch/collab-experiment/gen_variants.py（2026-09-14）。
改写点：原版把 `SRC` 写死为相对路径 `'base.docx'` 且输出到 CWD —— **依赖调用方的
当前工作目录**，换机/换 CWD 必红。现改为源文件与输出目录均由参数/env 注入。

**确定性**：全部 5 个变体都只依赖 base.docx 的文本内容做「定点改写」（无随机、无
时间戳、不依赖 Word）⇒ 可重复生成。唯一不可重复的是 zip 内部时间戳字节，因此
`base.docx` / `word_resaved.docx` 的关键字节另行入库。
"""
import os
import sys
import tempfile

from docx import Document

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = os.path.join(HERE, '..', 'base.docx')
DEFAULT_OUTROOT = os.environ.get('YFW_FIXTURE_OUT') or tempfile.gettempdir()

SRC = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
OUTDIR = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUTROOT

os.makedirs(OUTDIR, exist_ok=True)


def out(name):
    return os.path.join(OUTDIR, name)


def load():
    return Document(SRC)


def body_paras(doc):
    """按 body 顺序取段落（排除表格内的段落）"""
    out_ = []
    for child in doc.element.body.iterchildren():
        if child.tag.endswith('}p'):
            out_.append(child)
    return out_


from docx.text.paragraph import Paragraph  # noqa: E402

# 1) 改第 5 段一个字
d = load()
ps = body_paras(d)
p5 = Paragraph(ps[5], d)
old = p5.text
new = old.replace('人工录入', '手工录入')
for r in p5.runs:
    if '人工录入' in r.text:
        r.text = r.text.replace('人工录入', '手工录入')
        break
else:
    p5.runs[0].text = new
d.save(out('edit_one.docx'))
print('edit_one:  ', old[:30], '->', Paragraph(ps[5], d).text[:30])

# 2) 在第 2 段之后插入一段
d = load()
ps = body_paras(d)
anchor = Paragraph(ps[2], d)
anchor.insert_paragraph_before('【新增】本段为并行编辑时插入的段落，用于测试块序位移。')
d.save(out('insert_one.docx'))
print('insert_one: 在第 3 段前插入新段落（等价于第 2 段之后）')

# 3) 仅改格式（粗体），文字不变
d = load()
ps = body_paras(d)
p5 = Paragraph(ps[5], d)
for r in p5.runs:
    r.bold = True
d.save(out('bold_one.docx'))
print('bold_one:  第 5 段设为粗体，文字不变 ->', p5.text[:30])

# 4) 删除第 6 段
d = load()
ps = body_paras(d)
p6 = Paragraph(ps[6], d)
removed = p6.text
p6._element.getparent().remove(p6._element)
d.save(out('del_one.docx'))
print('del_one:   删除段落 ->', removed[:30])

# 5) 改表格单元格
d = load()
cell = d.tables[0].rows[1].cells[1]
old = cell.text
cell.text = '王五'
d.save(out('table_edit.docx'))
print('table_edit: 表格(1,1)', old, '->', '王五')
