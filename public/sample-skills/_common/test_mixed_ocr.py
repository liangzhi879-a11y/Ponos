#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""快速验证混合处理：只处理前10页（含扫描件和文本页）"""
import sys
sys.path.insert(0, '.trae/skills/_common')
from ocr_engine import OCREngine

pdf = "00 高新模板（全）/17、云充科技上年度-2023年高新产品代表性客户销售合同及发票.pdf"
engine = OCREngine()

# 1. 逐页检测
page_info = engine.detect_pages_by_type(pdf)
print(f"\n页面分析: 共{page_info['total_pages']}页")
print(f"  文本页: {page_info['text_page_count']}")
print(f"  扫描件页: {page_info['scan_page_count']}")
print(f"  空白页: {page_info['empty_page_count']}")
print(f"  混合型: {page_info['is_mixed']}")

# 2. 只处理前10页
import fitz
import numpy as np
from PIL import Image
import io

doc = fitz.open(pdf)
rapid_engine = engine._ensure_engine()

print(f"\n{'='*100}")
print(f"  前10页混合处理结果")
print(f"{'='*100}")
print(f"{'页码':<6} {'类型':<8} {'处理方式':<12} {'字符数':<10} {'OCR框数':<10} {'置信度':<10}")
print("-"*100)

for i in range(min(10, len(doc))):
    page = doc[i]
    page_type = page_info["page_types"][i]["type"]
    text = page.get_text()
    char_count = len(text.strip())

    if page_type == "scan" or (page_type == "empty" and len(page.get_images()) > 0):
        # OCR处理
        mat = fitz.Matrix(2.0, 2.0)
        pix = page.get_pixmap(matrix=mat)
        img_bytes = pix.tobytes("png")
        pil_img = Image.open(io.BytesIO(img_bytes))
        img_array = np.array(pil_img)

        ocr_result, elapsed = rapid_engine(img_array)
        page_text = []
        total_conf = 0
        box_count = 0
        if ocr_result:
            for item in ocr_result:
                if len(item) >= 3:
                    page_text.append(str(item[1]))
                    total_conf += float(item[2])
                    box_count += 1

        avg_conf = total_conf / box_count if box_count > 0 else 0
        full_text = "\n".join(page_text)
        print(f"{i+1:<6} {page_type:<8} {'OCR':<12} {len(full_text):<10} {box_count:<10} {avg_conf:<10.3f}")

        # 显示前300字符
        if full_text:
            preview = full_text[:300].replace('\n', ' | ')
            print(f"       预览: {preview}")
    else:
        # 文本提取
        print(f"{i+1:<6} {page_type:<8} {'fitz':<12} {char_count:<10} {'-':<10} {'1.000':<10}")
        if text:
            preview = text[:300].replace('\n', ' | ')
            print(f"       预览: {preview}")

doc.close()
