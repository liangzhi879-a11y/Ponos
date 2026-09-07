#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_dates_amounts.py - 从OCR结果中提取所有日期和金额，供准确率核对
"""

import json
import re
import sys
from pathlib import Path

def extract_dates_and_amounts(ocr_result_path):
    """从OCR结果中提取所有日期和金额"""
    data = json.loads(Path(ocr_result_path).read_text(encoding='utf-8'))

    pages = data.get("pages", [])
    print(f"\n{'='*80}")
    print(f"  OCR结果准确率核对报告")
    print(f"{'='*80}")
    print(f"  文件: {data.get('original_path', '')}")
    print(f"  总页数: {len(pages)}")
    print(f"  OCR引擎: {data.get('ocr_engine', '')}")
    print(f"  总字符数: {sum(len(p.get('text','')) for p in pages)}")
    print(f"{'='*80}")

    # 日期模式
    date_patterns = [
        (r'(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?', '中文日期'),
        (r'(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})', '数字日期'),
    ]

    # 金额模式
    amount_patterns = [
        (r'[￥¥]\s*([\d,]+\.?\d*)', '人民币金额'),
        (r'价税合计[^¥￥]*[￥¥]\s*([\d,]+\.?\d*)', '价税合计'),
        (r'金额[^¥￥]*[￥¥]?\s*([\d,]+\.?\d*)', '金额'),
        (r'税额[^¥￥]*[￥¥]?\s*([\d,]+\.?\d*)', '税额'),
        (r'单价[^¥￥]*[￥¥]?\s*([\d,]+\.?\d*)', '单价'),
        (r'数量[:：\s]*([\d.]+)', '数量'),
        (r'税率[/征收率]*[:：\s]*(\d+%)', '税率'),
        (r'发票号码[:：\s]*(\d+)', '发票号码'),
    ]

    all_dates = []
    all_amounts = []
    all_invoice_nos = []

    for page in pages:
        page_num = page.get("page", 0)
        text = page.get("text", "")
        confidence = page.get("confidence", 0)

        if not text.strip():
            continue

        # 提取日期
        for pattern, label in date_patterns:
            for m in re.finditer(pattern, text):
                year, month, day = m.group(1), m.group(2), m.group(3)
                date_str = f"{year}-{int(month):02d}-{int(day):02d}"
                # 上下文（前后30字符）
                start = max(0, m.start() - 30)
                end = min(len(text), m.end() + 30)
                context = text[start:end].replace('\n', ' ').strip()
                all_dates.append({
                    "page": page_num,
                    "date": date_str,
                    "raw": m.group(0),
                    "context": context,
                    "confidence": confidence,
                })

        # 提取金额
        for pattern, label in amount_patterns:
            for m in re.finditer(pattern, text):
                value = m.group(1)
                start = max(0, m.start() - 30)
                end = min(len(text), m.end() + 30)
                context = text[start:end].replace('\n', ' ').strip()
                all_amounts.append({
                    "page": page_num,
                    "type": label,
                    "value": value,
                    "context": context,
                    "confidence": confidence,
                })

        # 发票号码
        for m in re.finditer(r'发票号码[:：\s]*(\d{8,20})', text):
            all_invoice_nos.append({
                "page": page_num,
                "invoice_no": m.group(1),
            })

    # 去重
    seen_dates = set()
    unique_dates = []
    for d in all_dates:
        key = (d["page"], d["date"], d["raw"])
        if key not in seen_dates:
            seen_dates.add(key)
            unique_dates.append(d)

    seen_amounts = set()
    unique_amounts = []
    for a in all_amounts:
        key = (a["page"], a["type"], a["value"])
        if key not in seen_amounts:
            seen_amounts.add(key)
            unique_amounts.append(a)

    # 打印日期
    print(f"\n{'='*80}")
    print(f"  📅 日期识别结果（共{len(unique_dates)}个，去重后）")
    print(f"{'='*80}")
    print(f"{'页码':<6} {'识别日期':<15} {'原始文本':<20} {'置信度':<8} 上下文")
    print("-" * 100)
    for d in unique_dates[:50]:  # 最多显示50个
        print(f"{d['page']:<6} {d['date']:<15} {d['raw']:<20} {d['confidence']:<8.3f} {d['context'][:50]}")
    if len(unique_dates) > 50:
        print(f"... 还有 {len(unique_dates)-50} 个日期未显示")

    # 打印金额
    print(f"\n{'='*80}")
    print(f"  💰 金额识别结果（共{len(unique_amounts)}个，去重后）")
    print(f"{'='*80}")
    print(f"{'页码':<6} {'类型':<12} {'金额':<20} {'置信度':<8} 上下文")
    print("-" * 100)
    for a in unique_amounts[:80]:
        print(f"{a['page']:<6} {a['type']:<12} {a['value']:<20} {a['confidence']:<8.3f} {a['context'][:50]}")
    if len(unique_amounts) > 80:
        print(f"... 还有 {len(unique_amounts)-80} 个金额未显示")

    # 打印发票号码
    print(f"\n{'='*80}")
    print(f"  🧾 发票号码识别结果（共{len(all_invoice_nos)}个）")
    print(f"{'='*80}")
    for inv in all_invoice_nos[:20]:
        print(f"  第{inv['page']}页: {inv['invoice_no']}")

    # 汇总
    print(f"\n{'='*80}")
    print(f"  📊 识别汇总")
    print(f"{'='*80}")
    print(f"  日期总数: {len(unique_dates)}")
    print(f"  金额总数: {len(unique_amounts)}")
    print(f"  发票号码: {len(all_invoice_nos)}")

    # 按类型分组金额
    type_counts = {}
    for a in unique_amounts:
        type_counts[a["type"]] = type_counts.get(a["type"], 0) + 1
    print(f"\n  金额类型分布:")
    for t, c in type_counts.items():
        print(f"    {t}: {c}个")

    # 写入文件
    output_path = Path(".trae/ocr_test/accuracy_report.txt")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    import io
    buffer = io.StringIO()
    buffer.write(f"OCR准确率核对报告\n")
    buffer.write(f"文件: {data.get('original_path', '')}\n")
    buffer.write(f"总页数: {len(pages)}\n")
    buffer.write(f"OCR引擎: {data.get('ocr_engine', '')}\n")
    buffer.write(f"总字符数: {sum(len(p.get('text','')) for p in pages)}\n\n")

    buffer.write(f"="*80 + "\n")
    buffer.write(f"📅 日期识别结果（共{len(unique_dates)}个，去重后）\n")
    buffer.write(f"="*80 + "\n")
    buffer.write(f"{'页码':<6} {'识别日期':<15} {'原始文本':<20} {'置信度':<8} 上下文\n")
    buffer.write("-"*100 + "\n")
    for d in unique_dates:
        buffer.write(f"{d['page']:<6} {d['date']:<15} {d['raw']:<20} {d['confidence']:<8.3f} {d['context'][:50]}\n")

    buffer.write(f"\n{'='*80}\n")
    buffer.write(f"💰 金额识别结果（共{len(unique_amounts)}个，去重后）\n")
    buffer.write(f"{'='*80}\n")
    buffer.write(f"{'页码':<6} {'类型':<12} {'金额':<20} {'置信度':<8} 上下文\n")
    buffer.write("-"*100 + "\n")
    for a in unique_amounts:
        buffer.write(f"{a['page']:<6} {a['type']:<12} {a['value']:<20} {a['confidence']:<8.3f} {a['context'][:50]}\n")

    buffer.write(f"\n{'='*80}\n")
    buffer.write(f"🧾 发票号码识别结果（共{len(all_invoice_nos)}个）\n")
    buffer.write(f"{'='*80}\n")
    for inv in all_invoice_nos:
        buffer.write(f"  第{inv['page']}页: {inv['invoice_no']}\n")

    buffer.write(f"\n{'='*80}\n")
    buffer.write(f"📊 识别汇总\n")
    buffer.write(f"{'='*80}\n")
    buffer.write(f"日期总数: {len(unique_dates)}\n")
    buffer.write(f"金额总数: {len(unique_amounts)}\n")
    buffer.write(f"发票号码: {len(all_invoice_nos)}\n")
    buffer.write(f"\n金额类型分布:\n")
    for t, c in type_counts.items():
        buffer.write(f"  {t}: {c}个\n")

    output_path.write_text(buffer.getvalue(), encoding='utf-8')
    print(f"\n[report] 报告已保存: {output_path}")

    return {
        "dates": unique_dates,
        "amounts": unique_amounts,
        "invoice_nos": all_invoice_nos,
    }


if __name__ == "__main__":
    result = extract_dates_and_amounts(sys.argv[1] if len(sys.argv) > 1 else ".trae/ocr_test/full_ocr_result.json")
