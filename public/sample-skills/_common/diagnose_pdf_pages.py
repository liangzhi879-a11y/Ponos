#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diagnose_pdf_pages.py - 逐页诊断PDF文本层情况，找出扫描件页面
"""

import sys
from pathlib import Path

def diagnose_pdf(pdf_path):
    import fitz
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    print(f"\n{'='*100}")
    print(f"  PDF逐页诊断: {pdf_path}")
    print(f"  总页数: {total_pages}")
    print(f"{'='*100}")
    print(f"{'页码':<6} {'字符数':<10} {'图片数':<8} {'页面尺寸':<20} {'判定':<15}")
    print("-"*100)

    scanned_pages = []
    text_pages = []
    empty_pages = []

    for i, page in enumerate(doc):
        text = page.get_text()
        char_count = len(text.strip())
        image_count = len(page.get_images())
        page_size = f"{page.rect.width:.0f}x{page.rect.height:.0f}"

        # 判定
        if char_count < 10:
            if image_count > 0:
                verdict = "🔍 扫描件(有图无文)"
                scanned_pages.append(i+1)
            else:
                verdict = "⚠ 空白页"
                empty_pages.append(i+1)
        elif char_count < 100:
            verdict = "🔍 疑似扫描件(少文)"
            scanned_pages.append(i+1)
        else:
            verdict = "📄 文本页"
            text_pages.append(i+1)

        # 只打印前20页和后10页，中间只打印扫描件
        if i < 20 or i >= total_pages - 10 or "扫描" in verdict or "疑似" in verdict:
            print(f"{i+1:<6} {char_count:<10} {image_count:<8} {page_size:<20} {verdict}")
        elif i == 20:
            print(f"... (省略中间文本页，仅显示扫描件) ...")

    doc.close()

    print(f"\n{'='*100}")
    print(f"  诊断汇总")
    print(f"{'='*100}")
    print(f"  总页数: {total_pages}")
    print(f"  文本页: {len(text_pages)}个")
    print(f"  扫描件页: {len(scanned_pages)}个")
    print(f"  空白页: {len(empty_pages)}个")

    if scanned_pages:
        print(f"\n  扫描件页码列表（这些页面需要OCR）:")
        # 分组连续页码
        groups = []
        start = scanned_pages[0]
        prev = start
        for p in scanned_pages[1:]:
            if p == prev + 1:
                prev = p
            else:
                groups.append((start, prev) if start != prev else (start,))
                start = p
                prev = p
        groups.append((start, prev) if start != prev else (start,))

        for g in groups:
            if len(g) == 1:
                print(f"    第{g[0]}页")
            else:
                print(f"    第{g[0]}-{g[1]}页（共{g[1]-g[0]+1}页）")

    return {
        "total": total_pages,
        "text_pages": text_pages,
        "scanned_pages": scanned_pages,
        "empty_pages": empty_pages,
    }

if __name__ == "__main__":
    diagnose_pdf(sys.argv[1] if len(sys.argv) > 1 else "00 高新模板（全）/17、云充科技上年度-2023年高新产品代表性客户销售合同及发票.pdf")
