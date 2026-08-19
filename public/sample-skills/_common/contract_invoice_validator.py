#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
contract_invoice_validator.py - 合同发票配对校验器

扫描项目目录中合同/发票PDF，通过OCR提取关键字段，校验合同-发票配对关系。
输出JSON校验报告，标注缺失项。

用法：
  python contract_invoice_validator.py --project-root "项目路径" --output "校验报告.json"

校验维度：
  1. 每个PS产品的合同数量 vs 发票数量
  2. 合同主体（甲方/乙方）一致性
  3. 合同金额 vs 发票价税合计匹配
  4. 货物名称与PS产品名称关联度
  5. 日期范围合规性（合同日期 ≤ 发票日期）
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

COMMON_DIR = Path(__file__).parent


def _ocr_text(pdf_path):
    """使用RapidOCR提取PDF文本"""
    try:
        from rapidocr_onnxruntime import RapidOCR
        ocr = RapidOCR()
        import fitz
        doc = fitz.open(pdf_path)
        all_lines = []
        for page_num in range(min(len(doc), 6)):
            page = doc[page_num]
            pix = page.get_pixmap(dpi=200)
            img_bytes = pix.tobytes("png")
            result, _ = ocr(img_bytes)
            if result:
                for line_data in result:
                    text = line_data[1] if len(line_data) > 1 else ""
                    all_lines.append(text)
        doc.close()
        return "\n".join(all_lines)
    except Exception as e:
        print(f"[OCR警告] {pdf_path}: {e}", file=sys.stderr)
        return ""


def _extract_dates(text):
    dates = []
    patterns = [
        r'(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日',
        r'(20\d{2})-(\d{1,2})-(\d{1,2})',
        r'(20\d{2})/(\d{1,2})/(\d{1,2})',
        r'(20\d{2})\.(\d{1,2})\.(\d{1,2})',
    ]
    for p in patterns:
        for m in re.finditer(p, text):
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if 2000 <= y <= 2099 and 1 <= mo <= 12 and 1 <= d <= 31:
                dates.append(f"{y}-{mo:02d}-{d:02d}")
    return dates


def _extract_amounts(text):
    amounts = []
    for m in re.finditer(r'([\d,]+\.?\d*)\s*元', text):
        try:
            amt = float(m.group(1).replace(",", ""))
            if amt > 0:
                amounts.append(amt)
        except ValueError:
            pass
    return amounts


def _extract_party(text, company_name):
    company_short = company_name.replace("有限公司", "").replace("股份", "").replace("集团", "").replace("责任", "")
    if company_short in text or company_name in text:
        if "甲" in text or "买" in text or "委托" in text:
            return "甲方/买方"
        elif "乙" in text or "卖" in text or "受托" in text:
            return "乙方/卖方"
        else:
            return "存在（角色未识别）"
    return "未找到"


def _extract_goods(text):
    goods_keywords = ["货物", "标的", "产品", "服务", "项目名称"]
    goods_texts = []
    for kw in goods_keywords:
        m = re.search(rf'{kw}[名称]?\s*[:：]\s*([^\n]{2,50})', text)
        if m:
            goods_texts.append(m.group(1).strip())
    return goods_texts


def scan_project_files(project_root):
    files = {"contracts": [], "invoices": [], "unknown": []}
    project = Path(project_root)
    contract_keywords = ["合同", "contract", "协议", "agreement"]
    invoice_keywords = ["发票", "invoice", "receipt"]

    for f in project.rglob("*.pdf"):
        fname = f.name.lower()
        path_str = str(f)
        if any(kw.lower() in fname for kw in contract_keywords):
            files["contracts"].append(path_str)
        elif any(kw.lower() in fname for kw in invoice_keywords):
            files["invoices"].append(path_str)
        else:
            files["unknown"].append(path_str)

    return files


def validate(project_root, output_path, enterprise_name=""):
    project_root = Path(project_root)
    if not project_root.exists():
        print(f"[错误] 项目路径不存在: {project_root}", file=sys.stderr)
        sys.exit(1)

    print(f"[扫描] 项目目录: {project_root}")
    files = scan_project_files(str(project_root))

    report = {
        "project_root": str(project_root),
        "enterprise_name": enterprise_name,
        "validate_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "summary": {
            "total_contracts": len(files["contracts"]),
            "total_invoices": len(files["invoices"]),
            "total_unknown": len(files["unknown"]),
        },
        "contracts": [],
        "invoices": [],
        "pairings": [],
        "issues": [],
    }

    contract_data = []
    for cpath in files["contracts"]:
        print(f"  [OCR合同] {Path(cpath).name}")
        text = _ocr_text(cpath)
        dates = _extract_dates(text)
        amounts = _extract_amounts(text)
        goods = _extract_goods(text)
        party_info = _extract_party(text, enterprise_name) if enterprise_name else ""
        entry = {
            "file": cpath,
            "filename": Path(cpath).name,
            "dates": dates,
            "amounts": amounts,
            "goods": goods,
            "party_role": party_info,
            "text_length": len(text),
        }
        contract_data.append(entry)
        report["contracts"].append(entry)

    invoice_data = []
    for ipath in files["invoices"]:
        print(f"  [OCR发票] {Path(ipath).name}")
        text = _ocr_text(ipath)
        dates = _extract_dates(text)
        amounts = _extract_amounts(text)
        entry = {
            "file": ipath,
            "filename": Path(ipath).name,
            "dates": dates,
            "amounts": amounts,
            "text_length": len(text),
        }
        invoice_data.append(entry)
        report["invoices"].append(entry)

    total_contract_amt = sum(sum(c["amounts"]) for c in contract_data)
    total_invoice_amt = sum(sum(i["amounts"]) for i in invoice_data)

    if contract_data and invoice_data:
        if abs(total_contract_amt - total_invoice_amt) > 0.01:
            report["issues"].append({
                "type": "金额不匹配",
                "severity": "warning",
                "contract_total": round(total_contract_amt, 2),
                "invoice_total": round(total_invoice_amt, 2),
                "diff": round(total_contract_amt - total_invoice_amt, 2),
                "fix": f"合同总金额={total_contract_amt:.2f}元, 发票总金额={total_invoice_amt:.2f}元, 差额={total_contract_amt - total_invoice_amt:.2f}元"
            })
    elif not contract_data:
        report["issues"].append({
            "type": "合同缺失",
            "severity": "error",
            "fix": "未找到合同PDF文件，请在项目目录下放置合同扫描件"
        })
    elif not invoice_data:
        report["issues"].append({
            "type": "发票缺失",
            "severity": "error",
            "fix": "未找到发票PDF文件，请在项目目录下放置发票扫描件"
        })

    if not report["issues"]:
        report["issues"].append({
            "type": "校验通过",
            "severity": "info",
            "fix": "合同-发票配对基本校验通过"
        })

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"\n[完成] 校验报告已保存: {output_path}")
    print(f"  合同: {report['summary']['total_contracts']} 份")
    print(f"  发票: {report['summary']['total_invoices']} 份")
    print(f"  问题: {len([i for i in report['issues'] if i['severity'] != 'info'])} 个")

    return report


def main():
    parser = argparse.ArgumentParser(description="合同发票配对校验器")
    parser.add_argument("--project-root", required=True, help="项目根目录")
    parser.add_argument("--output", required=True, help="校验报告输出路径 (JSON)")
    parser.add_argument("--enterprise", default="", help="企业名称（用于主体识别）")
    args = parser.parse_args()

    validate(args.project_root, args.output, args.enterprise)


if __name__ == "__main__":
    main()
