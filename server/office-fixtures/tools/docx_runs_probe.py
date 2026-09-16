#!/usr/bin/env python3
"""S1 测试探针：造一个"段内有 2 个 run（其一粗体）"的 docx，并回报其 run 级结构。

为什么要有这个脚本（而不是在 JS 测试里拼 python 源码）：
段内 run 结构（run 数、粗体分布）**没法从 `docx_edit.py read` 的输出看出来**——read 只给 `{kind,text}`，
run 级信息被抹掉了。要验证"写回是否丢格式"，必须绕过 read 直接问 python-docx。
放在这里而不是内联在测试里，是因为内联拼源码要跨 JS/Python 两层引号，极易写出**测试自身的语法错**
（首版就这么炸过），而且出错信息指向测试文件而不是被测对象，排查成本高。

用法：
  docx_runs_probe.py make <path>        造一份探针文档（一段两 run：粗体 + 普通）
  docx_runs_probe.py info <path>        以单行 JSON 回报 {"paragraphs":[{runs,bold,text},…]}
"""
import json
import sys

from docx import Document


def make(path: str) -> None:
    d = Document()
    p = d.add_paragraph()
    r1 = p.add_run("粗体部分")
    r1.bold = True
    p.add_run("普通部分")
    d.save(path)
    print(json.dumps({"ok": True, "path": path}))


def info(path: str) -> None:
    """回报每段的 run 级结构。

    除 run 数与粗体标志外，**还要逐 run 的文本**：只报 run 数/bold 会漏掉真实的失效形态 ——
    `docx_edit.set_para_text` 把新文本塞进"第一个非空 run"并清空其余 run 的文本，
    于是 run 数与 bold 序列**都不变**，但整段文字挂到了首 run 的格式上（原本普通的部分变成粗体）。
    没有 run 文本就无法把这件事看出来。
    """
    d = Document(path)
    out = []
    for p in d.paragraphs:
        out.append({
            "runs": len(p.runs),
            "bold": [bool(r.bold) for r in p.runs],
            "texts": [r.text for r in p.runs],
            "text": p.text,
        })
    print(json.dumps({"ok": True, "paragraphs": out}))


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "用法: docx_runs_probe.py make|info <path>"}))
        return 2
    mode, path = sys.argv[1], sys.argv[2]
    try:
        if mode == "make":
            make(path)
        elif mode == "info":
            info(path)
        else:
            print(json.dumps({"ok": False, "error": f"未知模式: {mode}"}))
            return 2
    except Exception as e:  # noqa: BLE001 - 探针要把失败如实回报给测试，而不是抛栈
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
