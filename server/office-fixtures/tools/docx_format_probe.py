#!/usr/bin/env python3
"""S1/C4 探针：量测**两个 docx 之间**的段落/运行格式 XML 差异（先实测噪声，再定归一化规则）。

为什么必须先量测：C4 要把格式指纹并入 `blockId`。若指纹里掺进 Word 每次重存都会改动的
噪声（`rsid*`、`w:proofErr` 之类），那么"用户只是在 Word 里打开又保存"就会让**全文 blockId
全部改变** ⇒ 三路合并会把整篇判成"全被改了"，协同直接失效。
所以顺序只能是：**先看清重存到底改了什么**，再决定归一化要剔除哪些。

用法：
  docx_format_probe.py diff <a.docx> <b.docx>
      → {"ok":true,"blocks":N,"paraDiff":[…],"runDiffCount":N,"samples":[…]}
"""
import json
import sys

from docx import Document
from docx.oxml.ns import qn

# lxml 序列化：带上命名空间前缀，便于人读
from lxml import etree


def _ser(el):
    if el is None:
        return ""
    return etree.tostring(el, encoding="unicode")


def _blocks(doc):
    """按 body 真序取 (kind, text, pPr-xml, [rPr-xml…])。"""
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    out = []
    for child in doc.element.body.iterchildren():
        if child.tag == qn("w:p"):
            p = Paragraph(child, doc)
            pPr = child.find(qn("w:pPr"))
            runs = [(r.text, _ser(r._r.find(qn("w:rPr")))) for r in p.runs]
            out.append({
                "kind": "para",
                "text": p.text,
                "pPr": _ser(pPr),
                "runs": runs,
            })
        elif child.tag == qn("w:tbl"):
            t = Table(child, doc)
            out.append({"kind": "table", "text": "", "pPr": "", "runs": []})
    return out


def diff(a_path, b_path):
    a = _blocks(Document(a_path))
    b = _blocks(Document(b_path))
    n = min(len(a), len(b))

    para_diff = []
    run_diff = []
    samples = []
    for i in range(n):
        x, y = a[i], b[i]
        if x["kind"] != "para":
            continue
        if x["pPr"] != y["pPr"]:
            para_diff.append(i)
            if len(samples) < 3:
                samples.append({"i": i, "what": "pPr", "a": x["pPr"][:300], "b": y["pPr"][:300]})
        if len(x["runs"]) != len(y["runs"]):
            run_diff.append({"i": i, "why": "run-count", "a": len(x["runs"]), "b": len(y["runs"])})
            if len(samples) < 6:
                samples.append({
                    "i": i, "what": "runs",
                    "a": [t for t, _ in x["runs"]][:6],
                    "b": [t for t, _ in y["runs"]][:6],
                })
            continue
        for j, ((ta, ra), (tb, rb)) in enumerate(zip(x["runs"], y["runs"])):
            if ra != rb:
                run_diff.append({"i": i, "j": j, "why": "rPr"})
                if len(samples) < 9:
                    samples.append({"i": i, "j": j, "what": "rPr", "a": ra[:300], "b": rb[:300]})
                break

    return {
        "ok": True,
        "blocksA": len(a),
        "blocksB": len(b),
        "paraDiff": para_diff,
        "runDiffCount": len(run_diff),
        "runDiff": run_diff[:10],
        "samples": samples,
    }


def main():
    mode = sys.argv[1]
    if mode != "diff":
        print(json.dumps({"ok": False, "error": f"未知模式: {mode}"}))
        return 2
    print(json.dumps(diff(sys.argv[2], sys.argv[3]), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
