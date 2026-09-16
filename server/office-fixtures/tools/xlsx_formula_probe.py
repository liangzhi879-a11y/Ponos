#!/usr/bin/env python3
"""S1 测试探针：生成"含公式格"的 xlsx。

为什么需要它：受控语料 `xl_base.xlsx` 里**一个公式格都没有**（实测），于是"B8：公式格被静默跳过"
这条现状无法用它演示。为了不污染受控语料（它得保持与来源逐字节一致），改为**测试时生成**。

用法：
  xlsx_formula_probe.py make <path>   造一份 3×3 表，其中 B2 = `=A1+A2`（公式），其余为普通值
"""
import json
import sys

from openpyxl import Workbook


def make(path: str) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "sheet1"
    ws["A1"] = 1
    ws["A2"] = 2
    ws["B2"] = "=A1+A2"   # 公式格 —— B8 的靶子
    ws["C3"] = "普通文本"
    wb.save(path)
    print(json.dumps({"ok": True, "path": path, "formulaCell": "B2"}))


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "用法: xlsx_formula_probe.py make <path>"}))
        return 2
    mode, path = sys.argv[1], sys.argv[2]
    if mode != "make":
        print(json.dumps({"ok": False, "error": f"未知模式: {mode}"}))
        return 2
    try:
        make(path)
    except Exception as e:  # noqa: BLE001 - 探针应把失败如实回报给测试
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
