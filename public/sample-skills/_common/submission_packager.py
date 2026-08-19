#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
submission_packager.py - 高新技术企业认定申报材料打包引擎 v1.0.0

按申报系统要求（资料要求.xlsx）处理19类证明材料：扫描→排序→合并→压缩→命名→输出。

核心原则：
1. 所有扫描件强制OCR验证，不得跳过
2. 缺失材料列出清单与用户确认，绝不自动生成
3. 不修改原始文件，所有操作在输出目录完成
4. scan→确认→pack→validate 四步工作流

CLI 用法:
    python submission_packager.py scan --project-root "项目目录"
    python submission_packager.py pack --project-root "项目目录"
    python submission_packager.py validate --output-dir "_最终申报包/"
    python submission_packager.py list-requirements
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

COMMON_DIR = Path(__file__).parent

DEFAULT_REQUIREMENTS = "99.其他资料/资料要求.xlsx"
DEFAULT_OUTPUT_DIR = "_最终申报包"

MATERIAL_TYPE_MAP = {
    1: "IP", 2: "RD", 3: "PS", 4: "ACHIEVEMENT", 5: "STANDARD",
    6: "LICENSE", 7: "COVER", 8: "AUDIT_FINANCIAL", 9: "TAX",
    10: "AUDIT_RD", 11: "AUDIT_PS", 12: "MANAGEMENT", 13: "INSTITUTION",
    14: "INCENTIVE", 15: "TRAINING", 16: "HR", 17: "CONTRACT",
    18: "PROMISE", 19: "APPLICATION",
}

CATEGORY_DIR_NAMES = {
    1: "01_知识产权证明材料",
    2: "02_企业研究开发活动情况证明材料",
    3: "03_上年度高新技术产品（服务）证明材料",
    4: "04_科技成果转化情况证明材料",
    5: "05_国家或行业标准制定情况证明材料",
    6: "06_营业执照",
    7: "07_申报书封皮",
    8: "08_近三年财务审计报告",
    9: "09_近三年企业所得税纳税申报表",
    10: "10_近三年研发费用专项审计报告",
    11: "11_近一年高新产品收入专项审计报告",
    12: "12_研发组织管理制度及辅助账",
    13: "13_研发机构设立及产学研合作证明材料",
    14: "14_科技成果转化激励制度及双创平台",
    15: "15_科技人员培养引进及绩效奖励制度",
    16: "16_人力资源情况证明材料",
    17: "17_上年度代表性销售合同与发票",
    18: "18_企业承诺书",
    19: "19_打印申请书签字盖章扫描件",
}

CATEGORY_CONFIGS = {
    1: {
        "name": "知识产权证明材料",
        "source_patterns": ["IP*.pdf", "专利证书*.pdf", "软著*.pdf", "知识产权*.pdf", "NIP*.pdf"],
        "merge_strategy": "per-item",
        "naming_rule": "IP{编号}_{名称}.pdf",
        "size_limit_mb": 2,
        "allowed_formats": [".pdf"],
        "sort_rule": "ip_number_asc",
        "expected_content_keywords": ["专利", "知识产权", "证书", "登记", "著作权"],
        "id_pattern": re.compile(r"IP(\d{1,2})", re.IGNORECASE),
    },
    2: {
        "name": "企业研究开发活动情况证明材料",
        "source_patterns": ["RD*.pdf", "立项报告*.pdf", "研发项目*.pdf", "立项*.pdf"],
        "merge_strategy": "per-item",
        "naming_rule": "RD{编号}_{名称}.pdf",
        "size_limit_mb": 2,
        "allowed_formats": [".pdf"],
        "sort_rule": "rd_number_asc",
        "expected_content_keywords": ["研发", "立项", "项目", "技术", "开发"],
        "id_pattern": re.compile(r"RD(\d{1,2})", re.IGNORECASE),
    },
    3: {
        "name": "上年度高新技术产品（服务）证明材料",
        "source_patterns": ["PS*.pdf", "产品*.pdf", "高新产品*.pdf"],
        "merge_strategy": "per-item",
        "naming_rule": "PS{编号}_{名称}.pdf",
        "size_limit_mb": 4,
        "allowed_formats": [".pdf"],
        "sort_rule": "ps_number_asc",
        "expected_content_keywords": ["产品", "技术", "指标", "检测", "认证", "服务"],
        "id_pattern": re.compile(r"PS(\d{1,2})", re.IGNORECASE),
    },
    4: {
        "name": "科技成果转化情况证明材料",
        "source_patterns": ["0*.pdf", "1*.pdf", "成果*.pdf", "转化*.pdf"],
        "merge_strategy": "per-item",
        "naming_rule": "{编号}_{名称}.pdf",
        "size_limit_mb": 2,
        "allowed_formats": [".pdf"],
        "sort_rule": "achievement_number_asc",
        "expected_content_keywords": ["成果", "转化", "应用", "合同", "发票"],
        "id_pattern": re.compile(r"^(\d{1,2})[_.\-]"),
    },
    5: {
        "name": "国家或行业标准制定情况证明材料",
        "source_patterns": ["标准*.pdf", "国标*.pdf", "行标*.pdf", "规范*.pdf"],
        "merge_strategy": "per-item",
        "naming_rule": "{编号}_{名称}.pdf",
        "size_limit_mb": 2,
        "allowed_formats": [".pdf"],
        "sort_rule": "number_asc",
        "expected_content_keywords": ["标准", "规范", "行业", "检测方法"],
        "id_pattern": re.compile(r"^(\d{1,2})[_.\-]"),
    },
    6: {
        "name": "营业执照",
        "source_patterns": ["营业执照.*", "执照.*", "license.*"],
        "merge_strategy": "single",
        "naming_rule": "营业执照",
        "size_limit_mb": 0.5,
        "allowed_formats": [".jpg", ".jpeg", ".png"],
        "sort_rule": "none",
        "expected_content_keywords": ["营业执照", "统一社会信用代码", "法定代表人"],
        "note": "唯一不允许PDF格式的材料项",
    },
    7: {
        "name": "申报书封皮",
        "source_patterns": ["封皮*.pdf", "封面*.pdf", "申报书封皮*.pdf", "申请书封皮*.pdf"],
        "merge_strategy": "single",
        "naming_rule": "申报书封皮.pdf",
        "size_limit_mb": 1,
        "allowed_formats": [".pdf"],
        "sort_rule": "none",
        "expected_content_keywords": ["高新技术企业", "认定", "申请书"],
    },
    8: {
        "name": "近三年财务审计报告",
        "source_patterns": ["*财务审计*.pdf", "*审计报告*.pdf"],
        "merge_strategy": "per-year",
        "naming_rule": "{年份}_财务审计报告.pdf",
        "size_limit_mb": 100,
        "allowed_formats": [".pdf"],
        "sort_rule": "year_asc",
        "expected_content_keywords": ["审计", "财务报表", "注册会计师"],
        "years": [2021, 2022, 2023],
        "year_pattern": re.compile(r"(20\d{2})"),
    },
    9: {
        "name": "近三年企业所得税纳税申报表",
        "source_patterns": ["*纳税*.pdf", "*所得税*.pdf", "*申报表*.pdf"],
        "merge_strategy": "per-year",
        "naming_rule": "{年份}_企业所得税纳税申报表.pdf",
        "size_limit_mb": 5,
        "allowed_formats": [".pdf"],
        "sort_rule": "year_asc",
        "expected_content_keywords": ["企业所得税", "纳税", "申报表", "税务局"],
        "years": [2021, 2022, 2023],
        "year_pattern": re.compile(r"(20\d{2})"),
    },
    10: {
        "name": "近三年研发费用专项审计报告",
        "source_patterns": ["*研发费用*审计*.pdf", "*研发专审*.pdf", "*研发费用专审*.pdf", "*专项审计*.pdf"],
        "merge_strategy": "single",
        "naming_rule": "研发费用专项审计报告.pdf",
        "size_limit_mb": 100,
        "allowed_formats": [".pdf"],
        "sort_rule": "none",
        "expected_content_keywords": ["研发费用", "审计", "专项", "注册会计师"],
    },
    11: {
        "name": "近一年高新技术产品（服务）收入专项审计报告",
        "source_patterns": ["*高新收入*审计*.pdf", "*高新产品*审计*.pdf", "*收入专审*.pdf"],
        "merge_strategy": "single",
        "naming_rule": "高新产品收入专项审计报告.pdf",
        "size_limit_mb": 100,
        "allowed_formats": [".pdf"],
        "sort_rule": "none",
        "expected_content_keywords": ["高新技术产品", "收入", "审计", "专项"],
    },
    12: {
        "name": "研发组织管理制度、研发投入核算、辅助账",
        "source_patterns": ["*管理制度*.pdf", "*辅助账*.pdf", "*核算*.pdf", "*研发制度*.pdf"],
        "merge_strategy": "single",
        "naming_rule": "研发组织管理制度及辅助账.pdf",
        "size_limit_mb": 20,
        "allowed_formats": [".pdf"],
        "sort_rule": "logical_order",
        "expected_content_keywords": ["管理", "制度", "研发", "核算", "辅助账"],
    },
    13: {
        "name": "研发机构设立及产学研合作证明材料",
        "source_patterns": ["*研发机构*.pdf", "*产学研*.pdf", "*合作*.pdf", "*设备*.pdf", "*场地*.pdf"],
        "merge_strategy": "single",
        "naming_rule": "研发机构设立及产学研合作证明材料.pdf",
        "size_limit_mb": 20,
        "allowed_formats": [".pdf"],
        "sort_rule": "logical_order",
        "expected_content_keywords": ["研发机构", "产学研", "合作", "设备", "场地"],
    },
    14: {
        "name": "科技成果转化激励制度及双创平台",
        "source_patterns": ["*激励*.pdf", "*奖励*.pdf", "*双创*.pdf", "*创新创业*.pdf", "*转化制度*.pdf"],
        "merge_strategy": "single",
        "naming_rule": "科技成果转化激励制度及双创平台.pdf",
        "size_limit_mb": 5,
        "allowed_formats": [".pdf"],
        "sort_rule": "logical_order",
        "expected_content_keywords": ["激励", "转化", "奖励", "双创", "创新创业"],
    },
    15: {
        "name": "科技人员培养引进及绩效奖励制度",
        "source_patterns": ["*培养*.pdf", "*引进*.pdf", "*绩效*.pdf", "*培训*.pdf", "*人员制度*.pdf"],
        "merge_strategy": "single",
        "naming_rule": "科技人员培养引进及绩效奖励制度.pdf",
        "size_limit_mb": 5,
        "allowed_formats": [".pdf"],
        "sort_rule": "logical_order",
        "expected_content_keywords": ["培养", "引进", "绩效", "科技人员", "培训"],
    },
    16: {
        "name": "人力资源情况证明材料",
        "source_patterns": ["*人力资源*.pdf", "*人员*.pdf", "*社保*.pdf", "*科技人员*.pdf", "*花名册*.pdf"],
        "merge_strategy": "single",
        "naming_rule": "人力资源情况证明材料.pdf",
        "size_limit_mb": 8,
        "allowed_formats": [".pdf"],
        "sort_rule": "logical_order",
        "expected_content_keywords": ["科技人员", "社保", "学历", "劳动合同", "花名册"],
    },
    17: {
        "name": "上年度代表性销售合同与发票",
        "source_patterns": ["*合同*.pdf", "*发票*.pdf", "*销售*.pdf"],
        "merge_strategy": "single",
        "naming_rule": "上年度代表性销售合同与发票.pdf",
        "size_limit_mb": 20,
        "allowed_formats": [".pdf"],
        "sort_rule": "logical_order",
        "expected_content_keywords": ["合同", "发票", "销售", "金额"],
    },
    18: {
        "name": "企业承诺书",
        "source_patterns": ["*承诺书*.pdf", "*承诺*.pdf"],
        "merge_strategy": "single",
        "naming_rule": "企业承诺书.pdf",
        "size_limit_mb": 1,
        "allowed_formats": [".pdf"],
        "sort_rule": "none",
        "expected_content_keywords": ["承诺", "盖章", "企业"],
    },
    19: {
        "name": "打印申请书签字盖章扫描件",
        "source_patterns": ["*申请书*.pdf", "*申报书*.pdf"],
        "merge_strategy": "single",
        "naming_rule": "打印申请书签字盖章扫描件.pdf",
        "size_limit_mb": 50,
        "allowed_formats": [".pdf"],
        "sort_rule": "none",
        "expected_content_keywords": ["申请书", "签字", "盖章", "高新技术企业"],
    },
}


def get_file_size_mb(file_path):
    return round(os.path.getsize(file_path) / (1024 * 1024), 3)


def _run_command(cmd, cwd=None, timeout=600):
    try:
        result = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"
    except Exception as e:
        return -1, "", str(e)


def _call_ocr(file_path, project_root):
    ocr_script = COMMON_DIR / "ocr_engine.py"
    cmd = [
        sys.executable, str(ocr_script), "detect",
        "--file", str(file_path),
    ]
    code, stdout, stderr = _run_command(cmd, cwd=project_root, timeout=300)
    if code != 0:
        return {"is_scanned": False, "error": stderr.strip() or "OCR detect failed"}

    try:
        if stdout.strip():
            detect_result = json.loads(stdout.strip().split("\n")[-1])
            if isinstance(detect_result, dict) and detect_result.get("is_scanned"):
                cmd2 = [
                    sys.executable, str(ocr_script), "ocr",
                    "--file", str(file_path),
                    "--project", str(Path(project_root).name),
                ]
                code2, stdout2, stderr2 = _run_command(cmd2, cwd=project_root, timeout=600)
                if code2 == 0 and stdout2.strip():
                    ocr_result = json.loads(stdout2.strip().split("\n")[-1])
                    if isinstance(ocr_result, dict):
                        return {
                            "is_scanned": True,
                            "ocr_passed": True,
                            "text": ocr_result.get("text", ""),
                            "confidence": ocr_result.get("confidence", 0),
                            "page_count": ocr_result.get("page_count", 0),
                        }
                return {"is_scanned": True, "ocr_passed": False, "error": stderr2.strip() or "OCR failed"}
            return detect_result
    except (json.JSONDecodeError, IndexError):
        pass

    return {"is_scanned": False, "error": "OCR parse failed"}


def _verify_content_keywords(ocr_text, expected_keywords):
    if not ocr_text:
        return False, []
    ocr_lower = ocr_text.lower()
    matched = [kw for kw in expected_keywords if kw.lower() in ocr_lower]
    return len(matched) >= 1, matched


def _extract_id_from_filename(filename, id_pattern):
    if not id_pattern:
        return None
    match = id_pattern.search(filename)
    return int(match.group(1)) if match else None


def _extract_year_from_filename(filename, year_pattern):
    if not year_pattern:
        return None
    matches = year_pattern.findall(filename)
    return min(int(y) for y in matches) if matches else None


def find_source_files(project_root, cat_id, cat_config, source_dirs=None):
    project_root = Path(project_root)
    found = []

    if source_dirs:
        search_dirs = [Path(d) for d in source_dirs]
    else:
        search_dirs = [project_root]

    patterns = cat_config["source_patterns"]
    allowed_exts = [ext.lower() for ext in cat_config["allowed_formats"]]

    for search_dir in search_dirs:
        if not search_dir.exists():
            continue
        for root, dirs, files in os.walk(search_dir):
            if ".trae" in root or "_最终申报包" in root or "__pycache__" in root:
                continue
            for fname in files:
                ext = os.path.splitext(fname)[1].lower()
                if ext not in allowed_exts:
                    continue
                for pattern in patterns:
                    if _glob_match(fname, pattern):
                        found.append(os.path.join(root, fname))
                        break

    deduped = list(dict.fromkeys(found))
    return deduped


def _glob_match(filename, pattern):
    import fnmatch
    return fnmatch.fnmatch(filename, pattern)


def sort_files(file_paths, sort_rule, cat_config=None):
    if sort_rule == "none":
        return file_paths

    if sort_rule in ("ip_number_asc", "rd_number_asc", "ps_number_asc"):
        id_pattern = cat_config.get("id_pattern") if cat_config else None

        def sort_key(fp):
            fname = os.path.basename(fp)
            num = _extract_id_from_filename(fname, id_pattern)
            return (0, num or 0) if num is not None else (1, fname)

        return sorted(file_paths, key=sort_key)

    if sort_rule == "achievement_number_asc":
        id_pattern = cat_config.get("id_pattern") if cat_config else re.compile(r"^(\d{1,2})[_.\-]")

        def sort_key(fp):
            fname = os.path.basename(fp)
            num = _extract_id_from_filename(fname, id_pattern)
            return (0, num or 0) if num is not None else (1, fname)

        return sorted(file_paths, key=sort_key)

    if sort_rule == "number_asc":
        def sort_key(fp):
            fname = os.path.basename(fp)
            nums = re.findall(r"\d+", fname)
            return tuple(int(n) for n in nums) if nums else (9999, fname)
        return sorted(file_paths, key=sort_key)

    if sort_rule == "year_asc":
        year_pattern = cat_config.get("year_pattern") if cat_config else re.compile(r"(20\d{2})")

        def sort_key(fp):
            fname = os.path.basename(fp)
            y = _extract_year_from_filename(fname, year_pattern)
            return y or 9999

        return sorted(file_paths, key=sort_key)

    if sort_rule == "logical_order":
        priority_keywords = ["制度", "办法", "管理", "核算", "辅助账", "成立", "简介", "清单", "设备", "场地", "荣誉", "激励", "奖励", "双创", "培养", "引进", "绩效", "合同", "发票"]
        def sort_key(fp):
            fname = os.path.basename(fp)
            for i, kw in enumerate(priority_keywords):
                if kw in fname:
                    return i
            return len(priority_keywords)
        return sorted(file_paths, key=sort_key)

    return file_paths


def _call_file_compressor(input_path, output_path, material_type, quick=False):
    compressor = COMMON_DIR / "file_compressor.py"
    if quick:
        cmd = [
            sys.executable, str(compressor), "compress",
            "--input", str(input_path),
            "--output", str(output_path),
            "--type", material_type,
            "--quick",
        ]
    else:
        cmd = [
            sys.executable, str(compressor), "auto",
            "--input", str(input_path),
            "--output", str(output_path),
            "--type", material_type,
        ]
    code, stdout, stderr = _run_command(cmd, timeout=300)
    if code != 0:
        return {"success": False, "error": stderr.strip() or "compression failed"}
    try:
        return json.loads(stdout.strip().split("\n")[-1])
    except (json.JSONDecodeError, IndexError):
        return {"success": False, "error": "parse failed"}


def _call_pdf_merge(pdf_paths, output_path):
    splitter = COMMON_DIR / "pdf_splitter.py"
    from pdf_splitter import merge_pdfs
    return merge_pdfs(pdf_paths, str(output_path))


def _generate_naming(cat_config, index=None, item_name=None, year=None):
    rule = cat_config["naming_rule"]
    if "{编号}" in rule or "{名称}" in rule:
        if index is not None:
            num_str = f"{index:02d}"
            rule = rule.replace("{编号}", num_str).replace("{两位编号}", num_str)
        if item_name:
            rule = rule.replace("{名称}", item_name)
    if "{年份}" in rule and year:
        rule = rule.replace("{年份}", str(year))
    return rule


def cmd_scan(args):
    project_root = Path(args.project_root).resolve()
    if not project_root.exists():
        print(json.dumps({"error": f"项目目录不存在: {project_root}"}, ensure_ascii=False))
        sys.exit(1)

    requirements_path = project_root / args.requirements
    if not requirements_path.exists():
        print(json.dumps({"error": f"资料要求文件不存在: {requirements_path}"}, ensure_ascii=False))
        sys.exit(1)

    categories = args.categories.split(",") if args.categories and args.categories != "all" else None
    if categories:
        categories = [int(c.strip()) for c in categories if c.strip().isdigit()]
    else:
        categories = list(range(1, 20))

    source_dirs = None
    if args.source_dirs:
        source_dirs = [str(project_root / d.strip()) for d in args.source_dirs.split(",")]

    print(f"[scan] 扫描项目: {project_root}")
    print(f"[scan] 资料要求: {requirements_path}")
    print(f"[scan] 处理类别: {categories}")

    result = {
        "scan_time": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "project_root": str(project_root),
        "summary": {"total_categories": len(categories), "complete": 0, "incomplete": 0, "missing": 0},
        "categories": {},
        "missing_list": [],
        "ocr_summary": {"total_scanned": 0, "ocr_passed": 0, "ocr_failed": 0, "failed_files": []},
    }

    for cat_id in categories:
        cat_config = CATEGORY_CONFIGS.get(cat_id)
        if not cat_config:
            continue

        cat_name = cat_config["name"]
        source_files = find_source_files(project_root, cat_id, cat_config, source_dirs)
        files_info = []
        issues = []

        for fp in source_files:
            fname = os.path.basename(fp)
            size_mb = get_file_size_mb(fp)
            limit_mb = cat_config["size_limit_mb"]
            ext = os.path.splitext(fp)[1].lower()
            name_valid = True

            is_scanned = False
            ocr_result = None

            if ext == ".pdf":
                ocr_result = _call_ocr(fp, project_root)
                result["ocr_summary"]["total_scanned"] += 1
                if ocr_result.get("is_scanned"):
                    is_scanned = True
                    if ocr_result.get("ocr_passed"):
                        result["ocr_summary"]["ocr_passed"] += 1
                    else:
                        result["ocr_summary"]["ocr_failed"] += 1
                        result["ocr_summary"]["failed_files"].append(fp)

            content_ok = True
            if ocr_result and ocr_result.get("text"):
                ok, matched = _verify_content_keywords(
                    ocr_result["text"], cat_config["expected_content_keywords"]
                )
                content_ok = ok
                if not ok and is_scanned:
                    issues.append({
                        "file": fname,
                        "issue": "content_mismatch",
                        "detail": f"OCR未匹配到预期关键词: {cat_config['expected_content_keywords']}",
                    })

            if size_mb > limit_mb:
                issues.append({
                    "file": fname,
                    "issue": "size_exceeded",
                    "current": size_mb,
                    "limit": limit_mb,
                })

            if ext not in cat_config["allowed_formats"]:
                issues.append({
                    "file": fname,
                    "issue": "format_invalid",
                    "current": ext,
                    "allowed": cat_config["allowed_formats"],
                })

            files_info.append({
                "path": fp,
                "size_mb": size_mb,
                "limit_mb": limit_mb,
                "name_valid": name_valid,
                "content_verified": content_ok,
                "is_scanned": is_scanned,
                "ocr_passed": ocr_result.get("ocr_passed", False) if ocr_result else False,
            })

        if not source_files:
            status = "missing"
            result["summary"]["missing"] += 1
            issues.append({"issue": "file_not_found"})
            result["missing_list"].append({
                "category": str(cat_id),
                "name": cat_name,
                "required": True,
            })
        elif issues:
            status = "incomplete"
            result["summary"]["incomplete"] += 1
        else:
            status = "complete"
            result["summary"]["complete"] += 1

        result["categories"][str(cat_id)] = {
            "name": cat_name,
            "status": status,
            "files": files_info,
            "issues": issues,
            "file_count": len(source_files),
        }

    report_path = project_root / "_扫描预览报告.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n[scan] 预览报告已保存: {report_path}")

    _print_scan_summary(result)

    print(json.dumps(result, ensure_ascii=False, indent=2))


def _print_scan_summary(result):
    s = result["summary"]
    print(f"\n{'='*60}")
    print(f"  扫描完成: {s['total_categories']}类材料")
    print(f"  ✓ 完整: {s['complete']}  |  ⚠ 不完整: {s['incomplete']}  |  ✗ 缺失: {s['missing']}")
    print(f"  OCR扫描: {result['ocr_summary']['total_scanned']}件, "
          f"通过: {result['ocr_summary']['ocr_passed']}, "
          f"失败: {result['ocr_summary']['ocr_failed']}")
    if result["missing_list"]:
        print(f"\n  ⚠ 缺失材料清单（请补充后再执行 pack）：")
        for m in result["missing_list"]:
            print(f"    ✗ 材料{m['category']} - {m['name']}")
    if result["ocr_summary"]["failed_files"]:
        print(f"\n  ⚠ OCR失败文件（需检查）：")
        for f in result["ocr_summary"]["failed_files"]:
            print(f"    ✗ {f}")
    print(f"{'='*60}\n")


def cmd_pack(args):
    project_root = Path(args.project_root).resolve()
    if not project_root.exists():
        print(f"[错误] 项目目录不存在: {project_root}")
        sys.exit(1)

    requirements_path = project_root / args.requirements
    output_dir = project_root / args.output_dir

    categories = args.categories.split(",") if args.categories and args.categories != "all" else None
    if categories:
        categories = [int(c.strip()) for c in categories if c.strip().isdigit()]
    else:
        categories = list(range(1, 20))

    if not args.force:
        print(f"[pack] 将处理以下类别: {categories}")
        print(f"[pack] 输出目录: {output_dir}")
        confirm = input("确认开始打包？[y/N]: ")
        if confirm.lower() != "y":
            print("[pack] 已取消")
            return

    output_dir.mkdir(parents=True, exist_ok=True)
    pack_log = {
        "pack_time": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "project_root": str(project_root),
        "output_dir": str(output_dir),
        "categories": {},
    }

    for cat_id in categories:
        cat_config = CATEGORY_CONFIGS.get(cat_id)
        if not cat_config:
            continue

        cat_name = cat_config["name"]
        cat_dir_name = CATEGORY_DIR_NAMES.get(cat_id, f"{cat_id:02d}_{cat_name}")
        cat_output_dir = output_dir / cat_dir_name
        cat_output_dir.mkdir(parents=True, exist_ok=True)

        source_files = find_source_files(project_root, cat_id, cat_config)

        if not source_files:
            print(f"[pack] ⚠ 材料{cat_id} ({cat_name}): 未找到文件，跳过")
            pack_log["categories"][str(cat_id)] = {
                "name": cat_name, "status": "skipped", "reason": "no_source_files"
            }
            continue

        sorted_files = sort_files(source_files, cat_config["sort_rule"], cat_config)
        strategy = cat_config["merge_strategy"]
        size_limit_mb = cat_config["size_limit_mb"]
        material_type = MATERIAL_TYPE_MAP.get(cat_id, "APPLICATION")

        category_log = {"name": cat_name, "status": "ok", "files": [], "errors": []}

        if strategy == "per-item":
            for i, src in enumerate(sorted_files):
                src_path = Path(src)
                item_name = src_path.stem
                out_name = _generate_naming(cat_config, index=i + 1, item_name=item_name)
                if not out_name.endswith(".pdf"):
                    out_name += ".pdf"
                out_path = cat_output_dir / out_name

                shutil.copy2(src, out_path)
                size_mb = get_file_size_mb(out_path)
                if size_mb > size_limit_mb:
                    print(f"[pack] 压缩: {out_name} ({size_mb}MB > {size_limit_mb}MB)")
                    comp_result = _call_file_compressor(
                        str(out_path), str(out_path), material_type
                    )
                    if not comp_result.get("success"):
                        comp_result = _call_file_compressor(
                            str(out_path), str(out_path), material_type, quick=True
                        )
                    new_size = get_file_size_mb(out_path)
                    if new_size > size_limit_mb:
                        category_log["errors"].append({
                            "file": out_name,
                            "issue": "still_oversized",
                            "size_mb": new_size,
                            "limit_mb": size_limit_mb,
                        })

                ocr_result = _call_ocr(out_path, project_root)
                category_log["files"].append({
                    "name": out_name,
                    "size_mb": get_file_size_mb(out_path),
                    "ocr_ok": ocr_result.get("ocr_passed", False) if ocr_result else True,
                })

        elif strategy == "per-year":
            years = cat_config.get("years", [])
            year_files = {}
            year_pattern = cat_config.get("year_pattern", re.compile(r"(20\d{2})"))
            for src in sorted_files:
                y = _extract_year_from_filename(os.path.basename(src), year_pattern)
                if y:
                    year_files.setdefault(y, []).append(src)
                else:
                    category_log["errors"].append({
                        "file": os.path.basename(src),
                        "issue": "cannot_extract_year",
                    })

            for year in years:
                files_for_year = year_files.get(year, [])
                if not files_for_year:
                    category_log["errors"].append({
                        "year": year,
                        "issue": "no_file_for_year",
                    })
                    continue

                out_name = _generate_naming(cat_config, year=year)
                out_path = cat_output_dir / out_name

                if len(files_for_year) == 1:
                    shutil.copy2(files_for_year[0], out_path)
                else:
                    merge_result = _call_pdf_merge(files_for_year, out_path)
                    if not merge_result.get("success"):
                        category_log["errors"].append({
                            "file": out_name,
                            "issue": "merge_failed",
                            "error": merge_result.get("error", "unknown"),
                        })
                        shutil.copy2(files_for_year[0], out_path)

                size_mb = get_file_size_mb(out_path)
                if size_mb > size_limit_mb:
                    _call_file_compressor(str(out_path), str(out_path), material_type)

                category_log["files"].append({
                    "name": out_name,
                    "size_mb": get_file_size_mb(out_path),
                })

        else:
            out_name = cat_config["naming_rule"]
            out_path = cat_output_dir / out_name

            if cat_id == 6:
                for src in sorted_files:
                    ext = os.path.splitext(src)[1].lower()
                    if ext in [".jpg", ".jpeg", ".png"]:
                        shutil.copy2(src, str(out_path) + ext)
                        out_path = Path(str(out_path) + ext)
                        break
                else:
                    category_log["errors"].append({
                        "issue": "no_valid_format",
                        "detail": "营业执照需JPG/PNG格式",
                    })
            else:
                if len(sorted_files) == 1:
                    shutil.copy2(sorted_files[0], out_path)
                else:
                    merge_result = _call_pdf_merge(sorted_files, out_path)
                    if not merge_result.get("success"):
                        category_log["errors"].append({
                            "issue": "merge_failed",
                            "error": merge_result.get("error", "unknown"),
                        })
                        for src in sorted_files:
                            shutil.copy2(src, cat_output_dir / os.path.basename(src))
                        category_log["status"] = "partial"

                if out_path.exists():
                    size_mb = get_file_size_mb(out_path)
                    if size_mb > size_limit_mb:
                        comp_result = _call_file_compressor(
                            str(out_path), str(out_path), material_type
                        )
                        if not comp_result.get("success"):
                            _call_file_compressor(
                                str(out_path), str(out_path), material_type, quick=True
                            )

                    ocr_result = _call_ocr(out_path, project_root)
                    category_log["files"].append({
                        "name": out_name,
                        "size_mb": get_file_size_mb(out_path),
                        "ocr_ok": ocr_result.get("ocr_passed", False) if ocr_result else True,
                    })

        pack_log["categories"][str(cat_id)] = category_log
        print(f"[pack] ✓ 材料{cat_id} ({cat_name}): {category_log['status']}")

    log_path = output_dir / "_pack_log.json"
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(pack_log, f, ensure_ascii=False, indent=2)

    _print_pack_summary(pack_log)
    print(f"\n[pack] 打包完成，输出: {output_dir}")
    print(f"[pack] 日志: {log_path}")


def _print_pack_summary(pack_log):
    print(f"\n{'='*60}")
    print(f"  打包完成")
    ok = sum(1 for c in pack_log["categories"].values() if c["status"] == "ok")
    skipped = sum(1 for c in pack_log["categories"].values() if c["status"] == "skipped")
    partial = sum(1 for c in pack_log["categories"].values() if c["status"] == "partial")
    print(f"  ✓ 成功: {ok}  |  ⚠ 跳过: {skipped}  |  △ 部分: {partial}")
    for cat_id_str, cat_log in pack_log["categories"].items():
        if cat_log.get("errors"):
            print(f"  ⚠ 材料{cat_id_str} ({cat_log['name']}):")
            for err in cat_log["errors"]:
                print(f"      - {err.get('issue')}: {err.get('detail', err.get('error', ''))}")
    print(f"{'='*60}")


def cmd_validate(args):
    output_dir = Path(args.output_dir).resolve()
    if not output_dir.exists():
        print(json.dumps({"error": f"输出目录不存在: {output_dir}"}, ensure_ascii=False))
        sys.exit(1)

    requirements_path = Path(args.requirements) if not Path(args.requirements).is_absolute() else Path(args.requirements)
    if not requirements_path.is_absolute():
        requirements_path = output_dir.parent / args.requirements

    print(f"[validate] 校验目录: {output_dir}")

    report = {
        "validate_time": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "output_dir": str(output_dir),
        "checks": [],
        "summary": {"pass": 0, "warn": 0, "fail": 0},
    }

    for cat_id in range(1, 20):
        cat_config = CATEGORY_CONFIGS.get(cat_id)
        if not cat_config:
            continue
        cat_dir_name = CATEGORY_DIR_NAMES.get(cat_id)
        cat_dir = output_dir / cat_dir_name
        cat_name = cat_config["name"]

        if not cat_dir.exists():
            report["checks"].append({
                "category": cat_id, "name": cat_name,
                "status": "fail", "issue": "directory_missing",
            })
            report["summary"]["fail"] += 1
            continue

        files_in_dir = list(cat_dir.iterdir())
        if not files_in_dir:
            report["checks"].append({
                "category": cat_id, "name": cat_name,
                "status": "fail", "issue": "no_files",
            })
            report["summary"]["fail"] += 1
            continue

        file_checks = []
        for f in files_in_dir:
            if f.suffix.lower() in [".json", ".md", ".xlsx"]:
                continue
            ext = f.suffix.lower()
            size_mb = get_file_size_mb(str(f))
            limit_mb = cat_config["size_limit_mb"]

            fc = {"file": f.name, "size_mb": size_mb}

            if ext not in cat_config["allowed_formats"]:
                fc["status"] = "fail"
                fc["issue"] = f"invalid_format: {ext}"
            elif size_mb > limit_mb * 1.05:
                fc["status"] = "fail"
                fc["issue"] = f"oversized: {size_mb}MB > {limit_mb}MB"
            elif ext == ".pdf":
                try:
                    import fitz
                    doc = fitz.open(str(f))
                    page_count = len(doc)
                    is_encrypted = doc.is_encrypted
                    doc.close()
                    if is_encrypted:
                        fc["status"] = "fail"
                        fc["issue"] = "pdf_encrypted"
                    elif page_count == 0:
                        fc["status"] = "fail"
                        fc["issue"] = "pdf_empty"
                    else:
                        fc["status"] = "pass"
                        fc["pages"] = page_count
                except Exception:
                    fc["status"] = "fail"
                    fc["issue"] = "pdf_corrupted"
            else:
                fc["status"] = "pass"

            file_checks.append(fc)

        has_fail = any(fc["status"] == "fail" for fc in file_checks)
        has_warn = any(fc["status"] == "warn" for fc in file_checks)

        if has_fail:
            report["checks"].append({
                "category": cat_id, "name": cat_name,
                "status": "fail", "files": file_checks,
            })
            report["summary"]["fail"] += 1
        elif has_warn:
            report["checks"].append({
                "category": cat_id, "name": cat_name,
                "status": "warn", "files": file_checks,
            })
            report["summary"]["warn"] += 1
        else:
            report["checks"].append({
                "category": cat_id, "name": cat_name,
                "status": "pass", "files": file_checks,
            })
            report["summary"]["pass"] += 1

    report_path = output_dir / "_校验报告.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    _print_validate_summary(report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


def _print_validate_summary(report):
    s = report["summary"]
    print(f"\n{'='*60}")
    print(f"  校验完成")
    print(f"  ✓ 通过: {s['pass']}  |  ⚠ 警告: {s['warn']}  |  ✗ 失败: {s['fail']}")
    for check in report["checks"]:
        if check["status"] == "fail":
            print(f"  ✗ 材料{check['category']} ({check['name']}): {check.get('issue', '文件检查失败')}")
            if "files" in check:
                for fc in check["files"]:
                    if fc["status"] == "fail":
                        print(f"      - {fc['file']}: {fc.get('issue', '')}")
    print(f"{'='*60}")


def cmd_list_requirements(args):
    requirements_path = Path(args.requirements)
    if not requirements_path.is_absolute():
        requirements_path = Path.cwd() / args.requirements

    fmt = args.format or "table"

    if fmt == "json":
        output = {str(k): {
            "name": v["name"],
            "merge_strategy": v["merge_strategy"],
            "naming_rule": v["naming_rule"],
            "size_limit_mb": v["size_limit_mb"],
            "allowed_formats": v["allowed_formats"],
        } for k, v in CATEGORY_CONFIGS.items()}
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print(f"\n{'='*100}")
        print(f"{'序号':<6}{'材料名称':<36}{'合并策略':<14}{'大小上限':<10}{'允许格式'}")
        print(f"{'='*100}")
        for cat_id in range(1, 20):
            c = CATEGORY_CONFIGS[cat_id]
            print(f"{cat_id:<6}{c['name']:<36}{c['merge_strategy']:<14}{c['size_limit_mb']}MB{'':>5}{', '.join(c['allowed_formats'])}")
        print(f"{'='*100}\n")


def main():
    parser = argparse.ArgumentParser(
        description="申报材料打包引擎 - 高新技术企业认定申报材料打包（scan→pack→validate）"
    )
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    scan_parser = subparsers.add_parser("scan", help="扫描项目目录，输出预览报告")
    scan_parser.add_argument("--project-root", default=".", help="项目根目录")
    scan_parser.add_argument("--requirements", default=DEFAULT_REQUIREMENTS, help="资料要求.xlsx路径")
    scan_parser.add_argument("--categories", default="all", help="指定处理的类别（如 1,2,3 或 all）")
    scan_parser.add_argument("--source-dirs", default=None, help="自定义源文件目录（逗号分隔）")

    pack_parser = subparsers.add_parser("pack", help="执行打包：排序→合并→压缩→输出")
    pack_parser.add_argument("--project-root", default=".", help="项目根目录")
    pack_parser.add_argument("--requirements", default=DEFAULT_REQUIREMENTS, help="资料要求.xlsx路径")
    pack_parser.add_argument("--categories", default="all", help="指定处理的类别（如 1,2,3 或 all）")
    pack_parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR, help="输出目录")
    pack_parser.add_argument("--force", action="store_true", help="跳过确认直接打包")

    validate_parser = subparsers.add_parser("validate", help="校验已打包输出")
    validate_parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR, help="已打包输出目录")
    validate_parser.add_argument("--requirements", default=DEFAULT_REQUIREMENTS, help="资料要求.xlsx路径")

    list_parser = subparsers.add_parser("list-requirements", help="列出19类材料要求")
    list_parser.add_argument("--requirements", default=DEFAULT_REQUIREMENTS, help="资料要求.xlsx路径")
    list_parser.add_argument("--format", choices=["table", "json"], default="table")

    args = parser.parse_args()

    if args.command == "scan":
        cmd_scan(args)
    elif args.command == "pack":
        cmd_pack(args)
    elif args.command == "validate":
        cmd_validate(args)
    elif args.command == "list-requirements":
        cmd_list_requirements(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
