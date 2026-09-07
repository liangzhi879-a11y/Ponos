#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
year_compliance_checker.py - 成果转化证明材料日期合规校验工具

依据经验 EXP-2026-07-17-001 升级，强制执行5条日期合规规则：
  规则1：年份硬过滤（所有文件日期必须在 VALID_YEARS 内）
  规则2：同一转化年份配对（成果年份=合同年份=发票年份）
  规则3：测试报告不跨年（检测日期年份=转化年份）
  规则4：专利证书优先（不放说明书/权利要求书/审查意见）
  规则5：文件名年份校验（HXS编码 + dzfp时间戳，辅以PDF内容交叉验证）

用法：
  python year_compliance_checker.py --apply-year 2026 --source-dir "成果转化源目录" --achievement-table "成果转化表.xlsx"
  python year_compliance_checker.py --apply-year 2026 --check-dir "已整理的成果目录"
  python year_compliance_checker.py --extract-year --file "某合同.pdf"

退出码：
  0 = 全部合规
  1 = 存在违规（输出违规清单）
  2 = 执行错误
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

# 确保 _common 目录在 sys.path 中（支持直接运行和外部调用）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# ============================================================
# 规则1：年份硬过滤
# ============================================================
def get_valid_years(apply_year):
    """计算近三年有效年份

    规则：VALID_YEARS = {申报年份-3, 申报年份-2, 申报年份-1}
    例如申报2026年，近三年 = {2023, 2024, 2025}
    """
    return {apply_year - 3, apply_year - 2, apply_year - 1}


# ============================================================
# 规则5：文件名年份提取
# ============================================================
# HXS编码格式：HXS{年份4位}{月份2位}{序号}（如HXS2025082001 = 2025年8月）
HXS_PATTERN = re.compile(r'HXS(\d{4})(\d{2})\d+', re.IGNORECASE)
# dzfp发票文件名：{年份4位}{月2位}{日2位}{时分秒}（如20251219182622）
DZFP_PATTERN = re.compile(r'(\d{4})(\d{2})(\d{2})\d{6}')
# 通用日期格式：YYYY-MM-DD / YYYY/MM/DD / YYYY年MM月DD日
DATE_PATTERN_GENERIC = re.compile(r'(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})?')
# 纯年份：YYYY
YEAR_ONLY_PATTERN = re.compile(r'(?<!\d)(20\d{2})(?!\d)')


def extract_year_from_filename(filename):
    """从文件名提取年份信息

    优先级：
      1. HXS编码（合同编号格式）
      2. dzfp时间戳（电子发票导出格式）
      3. 通用日期格式
      4. 纯年份

    返回：
      (year, source) 或 (None, None)
      source: 'hxs' / 'dzfp' / 'date' / 'year_only'
    """
    name = os.path.basename(filename)
    name_without_ext = os.path.splitext(name)[0]

    # 1. HXS编码
    m = HXS_PATTERN.search(name_without_ext)
    if m:
        return int(m.group(1)), 'hxs'

    # 2. dzfp时间戳（14位连续数字）
    m = DZFP_PATTERN.search(name_without_ext)
    if m:
        return int(m.group(1)), 'dzfp'

    # 3. 通用日期格式
    m = DATE_PATTERN_GENERIC.search(name_without_ext)
    if m:
        return int(m.group(1)), 'date'

    # 4. 纯年份
    m = YEAR_ONLY_PATTERN.search(name_without_ext)
    if m:
        year = int(m.group(1))
        if 2020 <= year <= 2030:
            return year, 'year_only'

    return None, None


def extract_year_from_pdf(pdf_path, max_pages=5, use_ocr=True):
    """从PDF内容提取签订日期/开票日期

    辅助验证：当文件名无法提取年份时，从PDF前几页提取日期。
    使用 PyMuPDF (fitz) 提取文本，查找日期模式。
    v1.1新增：OCR fallback，扫描件自动触发OCR识别。
    """
    try:
        import fitz
    except ImportError:
        return None, None

    try:
        doc = fitz.open(pdf_path)
        text = ""
        for i, page in enumerate(doc):
            if i >= max_pages:
                break
            text += page.get_text()
        doc.close()
    except Exception:
        return None, None

    # OCR fallback：文本层为空时触发OCR
    if not text.strip() and use_ocr:
        try:
            from ocr_engine import ocr_pdf, detect_scanned_pdf
            scan_info = detect_scanned_pdf(str(pdf_path))
            if scan_info.get("is_scanned"):
                ocr_result = ocr_pdf(str(pdf_path), project_name="year_compliance")
                text = ocr_result.get("text", "")
        except ImportError:
            pass  # OCR引擎不可用，降级为空文本
        except Exception:
            pass  # OCR异常不影响主流程

    # 查找"签订日期"/"开票日期"/"检测日期"等关键词后的日期
    keywords = ['签订日期', '签订时间', '开票日期', '开票时间', '检测日期', '报告日期', '出具日期', '日期']
    for kw in keywords:
        pattern = re.compile(kw + r'[:：\s]*([20]\d{2})[-/年](\d{1,2})[-/月]?(\d{1,2})?')
        m = pattern.search(text)
        if m:
            return int(m.group(1)), f'pdf:{kw}'

    # 退化：查找文本中的第一个日期
    m = DATE_PATTERN_GENERIC.search(text)
    if m:
        year = int(m.group(1))
        if 2020 <= year <= 2030:
            return year, 'pdf_generic'

    return None, None


def extract_year(filepath):
    """提取文件的年份信息（文件名优先，PDF内容辅证）

    返回：
      {
        "file": "文件路径",
        "year": 2024 或 None,
        "source": "hxs/dzfp/date/year_only/pdf:xxx/pdf_generic" 或 None,
        "pdf_verified": True/False,  # 是否经过PDF内容验证
        "confidence": "high/medium/low/unknown"
      }
    """
    result = {
        "file": str(filepath),
        "year": None,
        "source": None,
        "pdf_verified": False,
        "confidence": "unknown",
    }

    # 1. 文件名提取
    year, source = extract_year_from_filename(filepath)
    if year:
        result["year"] = year
        result["source"] = source
        result["confidence"] = "high" if source in ('hxs', 'dzfp') else "medium"

    # 2. PDF内容交叉验证（规则5要求）
    if filepath.suffix.lower() == '.pdf':
        pdf_year, pdf_source = extract_year_from_pdf(filepath)
        if pdf_year:
            result["pdf_verified"] = True
            if not year:
                # 文件名无法提取，使用PDF年份
                result["year"] = pdf_year
                result["source"] = pdf_source
                result["confidence"] = "medium"
            elif year != pdf_year:
                # 文件名年份与PDF内容年份不一致（陷坑1/2）
                result["confidence"] = "low"
                result["warning"] = f"文件名年份({year})与PDF内容年份({pdf_year})不一致"

    return result


# ============================================================
# 规则1校验：年份硬过滤
# ============================================================
def check_year_filter(file_info, valid_years):
    """检查文件年份是否在有效年份内"""
    year = file_info.get("year")
    if year is None:
        return {"compliant": False, "reason": "年份未提取", "severity": "warning"}
    if year not in valid_years:
        return {
            "compliant": False,
            "reason": f"文件年份{year}不在近三年{sorted(valid_years)}内",
            "severity": "critical",
        }
    return {"compliant": True, "reason": "ok"}


# ============================================================
# 规则2校验：同一转化年份配对
# ============================================================
def check_year_pairing(achievement_id, conversion_year, contract_year, invoice_year):
    """检查合同和发票是否与成果转化年份一致"""
    violations = []
    if contract_year is None:
        violations.append({"rule": 2, "severity": "warning", "reason": f"{achievement_id}: 合同年份未提取"})
    elif contract_year != conversion_year:
        violations.append({
            "rule": 2,
            "severity": "critical",
            "reason": f"{achievement_id}: 合同年份({contract_year})≠转化年份({conversion_year})",
        })

    if invoice_year is None:
        violations.append({"rule": 2, "severity": "warning", "reason": f"{achievement_id}: 发票年份未提取"})
    elif invoice_year != conversion_year:
        violations.append({
            "rule": 2,
            "severity": "critical",
            "reason": f"{achievement_id}: 发票年份({invoice_year})≠转化年份({conversion_year})",
        })

    # 合同发票间隔检查（≤6个月，简化为同年检查）
    if contract_year and invoice_year and contract_year != invoice_year:
        violations.append({
            "rule": 2,
            "severity": "critical",
            "reason": f"{achievement_id}: 合同年份({contract_year})≠发票年份({invoice_year})，跨年配对",
        })

    return violations


# ============================================================
# 规则3校验：测试报告不跨年
# ============================================================
def check_test_report_year(test_report_info, conversion_year):
    """检查测试报告日期是否与转化年份一致"""
    year = test_report_info.get("year")
    if year is None:
        return [{"rule": 3, "severity": "warning", "reason": "测试报告年份未提取"}]
    if year != conversion_year:
        return [{
            "rule": 3,
            "severity": "critical",
            "reason": f"测试报告年份({year})≠转化年份({conversion_year})，跨年匹配",
        }]
    return []


# ============================================================
# 规则4校验：专利证书优先
# ============================================================
# 不应放入成果转化证明的专利文件类型
PATENT_NON_CERTIFICATE_KEYWORDS = [
    '说明书', '权利要求书', '审查意见', '审查通知书', '补正书', '意见陈述书',
    '受理通知书', '缴费凭证', '年费缴费', '手续文件', '中间文件',
]

def check_patent_certificate(filepath):
    """检查是否误用专利说明书代替证书"""
    name = os.path.basename(filepath)
    for kw in PATENT_NON_CERTIFICATE_KEYWORDS:
        if kw in name:
            return {
                "compliant": False,
                "reason": f"文件名含'{kw}'，疑似专利说明书/权利要求书等非证书文件",
                "severity": "critical",
                "rule": 4,
            }
    return {"compliant": True, "reason": "ok"}


# ============================================================
# 综合校验：扫描整个成果目录
# ============================================================
def scan_achievement_directory(achievement_dir, valid_years, achievement_table=None):
    """扫描成果转化目录，执行全规则校验

    参数：
        achievement_dir: 成果转化根目录（下有成果1/成果2/...子目录）
        valid_years: 近三年有效年份集合
        achievement_table: 成果转化表（含每项成果的转化年份）

    返回：
        {
            "total_achievements": 20,
            "total_files": 150,
            "violations": [...],
            "warnings": [...],
            "summary": {...}
        }
    """
    results = {
        "scanned_at": datetime.now().isoformat(),
        "achievement_dir": str(achievement_dir),
        "valid_years": sorted(valid_years),
        "total_achievements": 0,
        "total_files": 0,
        "violations": [],
        "warnings": [],
        "file_year_map": {},  # 文件路径 -> 年份信息
    }

    # 加载成果转化表（转化年份）
    conversion_years = {}  # achievement_id -> year
    if achievement_table and os.path.exists(achievement_table):
        try:
            import openpyxl
            wb = openpyxl.load_workbook(achievement_table, data_only=True)
            ws = wb.active
            for row in ws.iter_rows(min_row=2, values_only=True):
                if row[0] and row[1]:
                    ach_id = str(row[0]).strip()
                    # 假设转化年份在某列，这里简化处理
                    for cell in row[1:]:
                        if cell and isinstance(cell, (int, float)) and 2020 <= cell <= 2030:
                            conversion_years[ach_id] = int(cell)
                            break
        except Exception as e:
            results["warnings"].append(f"加载成果转化表失败: {e}")

    # 扫描每个成果子目录
    achievement_root = Path(achievement_dir)
    for ach_dir in sorted(achievement_root.iterdir()):
        if not ach_dir.is_dir():
            continue

        results["total_achievements"] += 1
        ach_id = ach_dir.name  # 如"成果1"或"1"
        conversion_year = conversion_years.get(ach_id)

        contract_year = None
        invoice_year = None
        test_report_infos = []

        # 扫描成果目录下所有文件
        for filepath in ach_dir.rglob("*"):
            if not filepath.is_file():
                continue
            if filepath.suffix.lower() not in ('.pdf', '.jpg', '.png', '.xlsx', '.doc', '.docx'):
                continue

            results["total_files"] += 1
            rel_path = str(filepath.relative_to(achievement_root))

            # 提取年份
            file_info = extract_year(filepath)
            results["file_year_map"][rel_path] = file_info

            # 规则1：年份硬过滤
            rule1 = check_year_filter(file_info, valid_years)
            if not rule1["compliant"]:
                if rule1["severity"] == "critical":
                    results["violations"].append({
                        "rule": 1,
                        "file": rel_path,
                        "achievement": ach_id,
                        **rule1,
                    })
                else:
                    results["warnings"].append({
                        "rule": 1,
                        "file": rel_path,
                        "achievement": ach_id,
                        **rule1,
                    })

            # 规则4：专利证书优先
            rule4 = check_patent_certificate(filepath)
            if not rule4["compliant"]:
                results["violations"].append({
                    "rule": 4,
                    "file": rel_path,
                    "achievement": ach_id,
                    **rule4,
                })

            # 识别文件类型（合同/发票/测试报告）
            name_lower = filepath.name.lower()
            if '合同' in filepath.name or 'contract' in name_lower:
                if file_info["year"]:
                    contract_year = file_info["year"]
            elif '发票' in filepath.name or 'invoice' in name_lower or 'dzfp' in name_lower:
                if file_info["year"]:
                    invoice_year = file_info["year"]
            elif '测试' in filepath.name or '检测' in filepath.name or '报告' in filepath.name:
                test_report_infos.append(file_info)

        # 规则2：同一转化年份配对
        if conversion_year:
            rule2_violations = check_year_pairing(ach_id, conversion_year, contract_year, invoice_year)
            for v in rule2_violations:
                if v["severity"] == "critical":
                    results["violations"].append({"achievement": ach_id, **v})
                else:
                    results["warnings"].append({"achievement": ach_id, **v})

        # 规则3：测试报告不跨年
        if conversion_year and test_report_infos:
            for tri in test_report_infos:
                rule3_violations = check_test_report_year(tri, conversion_year)
                for v in rule3_violations:
                    if v["severity"] == "critical":
                        results["violations"].append({
                            "achievement": ach_id,
                            "file": tri["file"],
                            **v,
                        })
                    else:
                        results["warnings"].append({
                            "achievement": ach_id,
                            "file": tri["file"],
                            **v,
                        })

    # 汇总
    results["summary"] = {
        "total_achievements": results["total_achievements"],
        "total_files": results["total_files"],
        "total_violations": len(results["violations"]),
        "total_warnings": len(results["warnings"]),
        "critical_count": sum(1 for v in results["violations"] if v.get("severity") == "critical"),
        "rule_breakdown": {
            f"规则{r}": sum(1 for v in results["violations"] + results["warnings"] if v.get("rule") == r)
            for r in range(1, 6)
        },
    }

    return results


def print_report(results, json_output=False):
    """打印校验报告"""
    if json_output:
        print(json.dumps(results, ensure_ascii=False, indent=2, default=str))
        return

    print(f"\n{'='*80}")
    print(f"  成果转化证明材料日期合规校验报告")
    print(f"{'='*80}")
    print(f"  扫描目录: {results['achievement_dir']}")
    print(f"  扫描时间: {results['scanned_at']}")
    print(f"  有效年份: {results['valid_years']}")
    print(f"{'='*80}\n")

    s = results["summary"]
    print(f"  成果数: {s['total_achievements']} | 文件数: {s['total_files']}")
    print(f"  违规: {s['total_violations']} (critical: {s['critical_count']}) | 警告: {s['total_warnings']}")
    print(f"  规则分布: {s['rule_breakdown']}")
    print()

    if results["violations"]:
        print(f"{'='*80}")
        print(f"  ⛔ 违规清单（critical，必须修正）")
        print(f"{'='*80}")
        for v in results["violations"]:
            print(f"  [规则{v.get('rule', '?')}] {v.get('achievement', '')} - {v.get('file', '')}")
            print(f"    {v.get('reason', '')}")
            print()

    if results["warnings"]:
        print(f"{'='*80}")
        print(f"  ⚠ 警告清单（需人工确认）")
        print(f"{'='*80}")
        for w in results["warnings"]:
            print(f"  [规则{w.get('rule', '?')}] {w.get('achievement', '')} - {w.get('file', '')}")
            print(f"    {w.get('reason', '')}")
        print()

    if not results["violations"] and not results["warnings"]:
        print(f"  ✓ 全部合规")


# ============================================================
# 命令行入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description='成果转化证明材料日期合规校验（5条强制规则）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
经验来源：EXP-2026-07-17-001（成果转化证明材料日期合规）

5条强制规则：
  规则1：年份硬过滤（所有文件日期必须在近三年内）
  规则2：同一转化年份配对（成果年份=合同年份=发票年份）
  规则3：测试报告不跨年（检测日期年份=转化年份）
  规则4：专利证书优先（不放说明书/权利要求书/审查意见）
  规则5：文件名年份校验（HXS编码+dzfp时间戳，辅以PDF交叉验证）

示例：
  python year_compliance_checker.py --apply-year 2026 --check-dir "成果转化目录"
  python year_compliance_checker.py --apply-year 2026 --source-dir "源目录" --achievement-table "成果转化表.xlsx"
  python year_compliance_checker.py --extract-year --file "某合同.pdf"
        ''',
    )

    parser.add_argument("--apply-year", type=int, default=None, help="申报年份（如2026）")
    parser.add_argument("--check-dir", default=None, help="已整理的成果转化目录")
    parser.add_argument("--source-dir", default=None, help="源文件目录（扫描提取年份）")
    parser.add_argument("--achievement-table", default=None, help="成果转化表xlsx（含转化年份）")
    parser.add_argument("--extract-year", action="store_true", help="仅提取单文件年份（调试用）")
    parser.add_argument("--file", default=None, help="单文件路径（配合--extract-year）")
    parser.add_argument("--json", action="store_true", help="输出JSON格式")

    args = parser.parse_args()

    # 单文件年份提取
    if args.extract_year and args.file:
        filepath = Path(args.file)
        if not filepath.exists():
            print(f"[ERROR] 文件不存在: {args.file}")
            sys.exit(2)
        info = extract_year(filepath)
        print(json.dumps(info, ensure_ascii=False, indent=2))
        sys.exit(0)

    # 目录校验
    if not args.apply_year:
        print("[ERROR] 必须指定 --apply-year（申报年份）")
        sys.exit(2)

    if not args.check_dir and not args.source_dir:
        print("[ERROR] 必须指定 --check-dir 或 --source-dir")
        sys.exit(2)

    valid_years = get_valid_years(args.apply_year)
    print(f"[check] 申报年份: {args.apply_year}")
    print(f"[check] 近三年有效年份: {sorted(valid_years)}")

    target_dir = args.check_dir or args.source_dir
    if not os.path.exists(target_dir):
        print(f"[ERROR] 目录不存在: {target_dir}")
        sys.exit(2)

    print(f"[check] 扫描目录: {target_dir}")
    if args.achievement_table:
        print(f"[check] 成果转化表: {args.achievement_table}")

    results = scan_achievement_directory(target_dir, valid_years, args.achievement_table)
    print_report(results, args.json)

    # 退出码：有critical违规则退出1
    sys.exit(1 if results["summary"]["critical_count"] > 0 else 0)


if __name__ == "__main__":
    main()
