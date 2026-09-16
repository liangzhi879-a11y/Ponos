#!/usr/bin/env python3
"""S1 探针：造一份**块序已知**的 docx，用于独立验证 read 是否按"文档真序"取块。

为什么不能拿 `base.docx` 验证真序：它的块序实测是 `1ppp2pp3ppp2pppTT`（两个表恰好在末尾），
于是"真序"与旧实现的"先段落后表格"**恰好重合** —— 用它验证等于什么都没验证。
本探针造一份**表格夹在两段之间**的文档，顺序是人为设定且已知的（p、table、p、table、p），
因此 read 的输出顺序错了就一定会被抓到。

用法：
  docx_order_probe.py make <path>
"""
import json
import sys

from docx import Document


def make(path: str) -> None:
    d = Document()
    d.add_paragraph("第一段")
    t1 = d.add_table(rows=1, cols=2)
    t1.rows[0].cells[0].text = "表一甲"
    t1.rows[0].cells[1].text = "表一乙"
    d.add_paragraph("第二段")
    t2 = d.add_table(rows=1, cols=2)
    t2.rows[0].cells[0].text = "表二甲"
    t2.rows[0].cells[1].text = "表二乙"
    d.add_paragraph("第三段")
    d.save(path)
    print(json.dumps({"ok": True, "path": path, "expectedOrder": ["p", "table", "p", "table", "p"]}))


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "用法: docx_order_probe.py make <path>"}))
        return 2
    if sys.argv[1] != "make":
        print(json.dumps({"ok": False, "error": f"未知模式: {sys.argv[1]}"}))
        return 2
    try:
        make(sys.argv[2])
    except Exception as e:  # noqa: BLE001 - 探针把失败如实回报给测试
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
