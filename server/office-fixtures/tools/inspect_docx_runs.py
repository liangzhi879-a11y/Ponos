# -*- coding: utf-8 -*-
"""只读检查器：输出 docx 段落的 **run 分段与格式**，供 mjs 测试断言。

`docx_edit.py` 的 `read` 只返回 `p.text`，**看不到 run**；而 `set_para_text` 的行为
恰恰是「把全部文本塞进第一个非空 run，其余 run 清空」——要证明这件事，必须直接看 XML 层
的 run。本工具不做任何写操作，只读文件。

用法：
    python inspect_docx_runs.py <path> [段落序号]
    # 不传段落序号则输出全部段落

输出（stdout，JSON 单行，ASCII 转义以保证跨 locale 稳定）：
    {"ok":true,"paragraphs":[
       {"index":3,"style":"Normal","text":"...",
        "runs":[{"text":"...","bold":true,"italic":null}, ...]}]}
"""
import json
import sys

from docx import Document


def main():
    path = sys.argv[1]
    only = int(sys.argv[2]) if len(sys.argv) > 2 else None
    doc = Document(path)
    out = []
    for i, p in enumerate(doc.paragraphs):
        if only is not None and i != only:
            continue
        out.append({
            'index': i,
            'style': p.style.name if p.style else '',
            'text': p.text,
            'runs': [
                {'text': r.text, 'bold': r.bold, 'italic': r.italic}
                for r in p.runs
            ],
        })
    print(json.dumps({'ok': True, 'paragraphs': out}))


try:
    main()
except Exception as e:  # 与 docx_edit.py 同一约定：错误也走 stdout 的 JSON
    print(json.dumps({'ok': False, 'error': str(e)}))
