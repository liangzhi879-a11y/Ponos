#!/usr/bin/env python3
"""S1/C3+C4 探针：对 docx 施加**受控的单一变更**，供测试断言"这个改动是否可见"。

为什么需要它：C4 要证明的是"**某一种**格式改动能被检测到"，而 C3 要证明"**某一个单元格**
的改动不会让整表看起来都变了"。手工在测试里拼多行 python 代码容易出错，也看不清改了哪一处。
本探针每种模式只做一件事，并回报改了什么。

用法：
  docx_mutate_probe.py bold    <path> <paraIdx>            # 该段第一个 run 设为粗体（运行级格式）
  docx_mutate_probe.py table-jc <path> <tableIdx>          # 表加 w:jc=center（表级格式，**不在**物化组内）
  docx_mutate_probe.py dup-row    <path> <tableIdx> <rowIdx>        # 复制该行并插到其后（模拟"原样复制一行"）
  docx_mutate_probe.py insert-row <path> <tableIdx> <afterIdx> <txt>  # 在 afterIdx 后插入一行**全新内容**
  docx_mutate_probe.py set-text   <path> <paraIdx> <text>          # 改写某段文字（模拟外部编辑）
  docx_mutate_probe.py insert-para <path> <afterIdx> <text>        # 在某段之后插入新段（T6 用）
  docx_mutate_probe.py table-set-cell <path> <tIdx> <r> <c> <txt>  # 改表格某格（B2 用）
"""
import copy
import json
import sys

from docx import Document
from docx.oxml.ns import qn


def _save(d, path, note):
    d.save(path)
    print(json.dumps({"ok": True, "changed": note}, ensure_ascii=False))
    return 0


def bold(path, idx):
    d = Document(path)
    p = d.paragraphs[int(idx)]
    if not p.runs:
        print(json.dumps({"ok": False, "error": f"段 {idx} 没有 run，无法设置粗体"}))
        return 1
    p.runs[0].bold = True
    return _save(d, path, f"paragraph[{idx}].runs[0].bold=True")


def table_jc(path, idx):
    d = Document(path)
    t = d.tables[int(idx)]
    tbl_pr = t._tbl.find(qn("w:tblPr"))
    if tbl_pr is None:
        print(json.dumps({"ok": False, "error": "表没有 tblPr"}))
        return 1
    jc = tbl_pr.find(qn("w:jc"))
    if jc is None:
        jc = tbl_pr.makeelement(qn("w:jc"), {})
        tbl_pr.append(jc)
    jc.set(qn("w:val"), "center")
    return _save(d, path, f"table[{idx}].tblPr/w:jc=center")


def dup_row(path, t_idx, r_idx):
    d = Document(path)
    t = d.tables[int(t_idx)]
    src = t.rows[int(r_idx)]._tr
    src.addnext(copy.deepcopy(src))
    return _save(d, path, f"table[{t_idx}].row[{r_idx}] duplicated after itself")


def insert_row(path, t_idx, after_idx, text):
    """在 after_idx 之后插入一行**内容全新**的行。

    为什么不用 `dup-row` 充当"插一行"：复制出来的行与原行**内容相同**，而纯内容指纹在
    重复内容上必须靠"出现序号"消歧（office_common 的 `assign_ids`）⇒ 新行会让后续同内容行的
    序号整体漂移，于是"0 处修改"这条性质**本来就测不出来**（那是 D-2 登记的已知限制）。
    插一行全新内容才能真正检验"插入不打扰其他行"。
    """
    d = Document(path)
    t = d.tables[int(t_idx)]
    src = t.rows[int(after_idx)]._tr
    src.addnext(copy.deepcopy(src))
    new_row = t.rows[int(after_idx) + 1]
    for ci, cell in enumerate(new_row.cells):
        cell.text = f"{text}-{ci}"
    return _save(d, path, f"table[{t_idx}]: inserted new row after row[{after_idx}]")


def set_text(path, idx, text):
    """改写某正文段的文字（模拟"外部在 Word 里改了一段"）。"""
    d = Document(path)
    d.paragraphs[int(idx)].text = text
    return _save(d, path, f"paragraph[{idx}].text = {text!r}")


def insert_para(path, after_idx, text):
    """在某正文段之后插入一个新段（模拟"外部插了一段"；三路合并 T6 用）。

    做法是**复制原段的 XML 再改文字**，而不是 `doc.add_paragraph`（后者只能加到文档末尾）——
    T6 要的是"在中间插入"，插到末尾测不出"内容对齐能否吸收插入"。
    """
    from docx.text.paragraph import Paragraph

    d = Document(path)
    src = d.paragraphs[int(after_idx)]._p
    new_el = copy.deepcopy(src)
    src.addnext(new_el)
    Paragraph(new_el, d.paragraphs[int(after_idx)]._parent).text = text
    return _save(d, path, f"inserted paragraph after [{after_idx}]: {text!r}")


def table_set_cell(path, t_idx, r, c, text):
    """改写表格某格的文字（模拟"外部改了表格里的一个格"；B2 用）。"""
    d = Document(path)
    d.tables[int(t_idx)].cell(int(r), int(c)).text = text
    return _save(d, path, f"table[{t_idx}].cell({r},{c}).text = {text!r}")


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"ok": False, "error": "参数不足"}))
        return 2
    mode = sys.argv[1]
    try:
        if mode == "bold":
            return bold(sys.argv[2], sys.argv[3])
        if mode == "table-jc":
            return table_jc(sys.argv[2], sys.argv[3])
        if mode == "dup-row":
            return dup_row(sys.argv[2], sys.argv[3], sys.argv[4])
        if mode == "insert-row":
            return insert_row(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        if mode == "set-text":
            return set_text(sys.argv[2], sys.argv[3], sys.argv[4])
        if mode == "insert-para":
            return insert_para(sys.argv[2], sys.argv[3], sys.argv[4])
        if mode == "table-set-cell":
            return table_set_cell(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6])
    except Exception as e:  # noqa: BLE001 - 探针把失败如实回报给测试
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 1
    print(json.dumps({"ok": False, "error": f"未知模式: {mode}"}))
    return 2


if __name__ == "__main__":
    sys.exit(main())
