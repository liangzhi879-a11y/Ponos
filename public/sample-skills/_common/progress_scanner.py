#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
progress_scanner.py - 双模式文件扫描器 v1.0.0

用法：
  python progress_scanner.py scan --project-root "." --project-id "main" --output ".trae/_scan_result.json"
  python progress_scanner.py discover --project-root "." --output ".trae/_discovered_projects.json"

模式一 scan（默认）：申报材料扫描
  - 只扫描申报相关格式：.pdf .docx .xlsx .jpg .png .doc .xls
  - 排除目录：.trae _* node_modules __pycache__ 98.* 99.* 0000_*
  - 排除文件：临时文件/草稿/衍生资料
  - 严格校验：文件内容可读 + 时效性判断
  - 按项目类型配置的 material_categories 进行匹配

模式二 discover：子项目自动发现
  - 扫描一级子目录中是否存在 .trae/project_config.json
  - 提取 project_type 字段
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from glob import glob
from pathlib import Path


ASSET_EXTENSIONS = {".pdf", ".docx", ".xlsx", ".jpg", ".jpeg", ".png", ".doc", ".xls"}
EXCLUDE_DIRS = {".trae", "node_modules", "__pycache__", ".git", ".locks", "0000_项目进度"}
EXCLUDE_DIR_PREFIXES = ("_", "98.", "99.")
INVALID_MARKERS = ["~$", ".tmp", ".bak", ".swp", ".DS_Store", "Thumbs.db", "~WRL",
                   "草稿", "draft", "副本", " - 副本", "新建", "未命名", "临时", "._"]
DERIVED_MARKERS = ["提取自", "页面提取"]
NON_ASSET_EXTENSIONS = {".lnk", ".dat", ".exe", ".msi", ".dll", ".sys", ".crdownload",
                        ".part", ".tmp", ".swp", ".psd", ".xmind", ".py", ".json",
                        ".md", ".bat", ".html", ".css", ".js", ".zip", ".rar", ".7z"}


def load_types_config(project_root):
    path = os.path.join(project_root, ".trae", "project_types_config.json")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_progress(project_root):
    path = os.path.join(project_root, ".trae", "project_progress.json")
    if not os.path.exists(path):
        return {"projects": []}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def is_excluded_dir(dirname):
    if dirname in EXCLUDE_DIRS:
        return True
    for prefix in EXCLUDE_DIR_PREFIXES:
        if dirname.startswith(prefix):
            return True
    return False


def is_invalid_file(filename):
    for marker in INVALID_MARKERS:
        if marker in filename:
            return True
    ext = os.path.splitext(filename)[1].lower()
    if ext in NON_ASSET_EXTENSIONS:
        return True
    for marker in DERIVED_MARKERS:
        if marker in filename:
            return True
    return False


def match_category(filepath, material_categories):
    filename = os.path.basename(filepath)
    dirname = os.path.basename(os.path.dirname(filepath)) if os.path.dirname(filepath) else ""

    for cat in material_categories:
        dir_pattern = cat.get("dir_pattern", "")
        if dir_pattern and dir_pattern != "*":
            if glob_match(dir_pattern, dirname):
                return cat

        keywords = cat.get("keywords", [])
        if keywords:
            for kw in keywords:
                if kw.lower() in filename.lower():
                    return cat

        file_types = cat.get("file_types", [])
        ext = os.path.splitext(filename)[1].lower()
        if ext not in file_types:
            continue

    return None


def glob_match(pattern, text):
    if not pattern or not text:
        return False
    if pattern == "*":
        return True
    if pattern.endswith("*"):
        return text.startswith(pattern[:-1])
    if pattern.startswith("*"):
        return text.endswith(pattern[1:])
    return pattern.lower() == text.lower()


def extract_date_from_filename(filename):
    date_patterns = [
        r'(20\d{2})[年\-.](\d{1,2})[月\-.](\d{1,2})',
        r'(20\d{2})(\d{2})(\d{2})',
        r'(20\d{2})',
    ]
    for pattern in date_patterns:
        match = re.search(pattern, filename)
        if match:
            if len(match.groups()) >= 3:
                return f"{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
            elif len(match.groups()) == 1:
                return match.group(1)
    return None


def check_timeliness(extracted_date, year):
    if not extracted_date:
        return None
    date_str = str(extracted_date)
    if len(date_str) == 4:
        try:
            y = int(date_str)
            return y >= year - 3 and y <= year - 1
        except ValueError:
            return None
    try:
        d = datetime.strptime(date_str[:10], "%Y-%m-%d")
        return d.year >= year - 3 and d.year <= year - 1
    except ValueError:
        return None


def scan_materials(project_root, project_id):
    types_config = load_types_config(project_root)
    progress = load_progress(project_root)

    project = None
    for p in progress.get("projects", []):
        if p.get("id") == project_id:
            project = p
            break

    if not project:
        return {"error": f"项目 {project_id} 不存在"}

    ptype = project.get("type", "gxtz")
    type_cfg = types_config.get(ptype, {})
    material_categories = type_cfg.get("material_categories", [])
    year = project.get("year", 2026)
    sub_path = project.get("sub_path", ".")

    scan_root = os.path.join(project_root, sub_path) if sub_path != "." else project_root

    categories_result = {}
    for cat in material_categories:
        categories_result[cat["id"]] = {
            "category_id": cat["id"],
            "category_name": cat["name"],
            "valid": 0,
            "expired": 0,
            "invalid": 0,
            "total": 0,
            "completeness_pct": 0,
            "files": []
        }

    total_scanned = 0
    valid_total = 0
    expired_total = 0
    invalid_total = 0

    for root, dirs, files in os.walk(scan_root):
        dirs[:] = [d for d in dirs if not is_excluded_dir(d)]
        for filename in files:
            if is_invalid_file(filename):
                continue

            ext = os.path.splitext(filename)[1].lower()
            if ext not in ASSET_EXTENSIONS:
                continue

            filepath = os.path.join(root, filename)
            relpath = os.path.relpath(filepath, scan_root)
            total_scanned += 1

            cat = match_category(relpath, material_categories)
            if not cat:
                cat = match_category(filename, material_categories)

            cat_id = cat["id"] if cat else None
            if cat_id and cat_id not in categories_result:
                cat_id = None

            extracted_date = extract_date_from_filename(filename)
            is_timely = check_timeliness(extracted_date, year)

            file_size = 0
            try:
                file_size = os.path.getsize(filepath)
            except OSError:
                pass

            if file_size == 0:
                status = "invalid"
            elif is_timely is False:
                status = "expired"
            elif is_timely is None and extracted_date:
                status = "expired"
            else:
                status = "valid"

            file_info = {
                "path": relpath,
                "size": file_size,
                "status": status,
                "extracted_date": extracted_date or "",
                "confidence": 0.8 if cat else 0.3
            }

            if cat_id:
                categories_result[cat_id]["files"].append(file_info)
                categories_result[cat_id][status] += 1
                categories_result[cat_id]["total"] += 1
            else:
                invalid_total += 1

            if status == "valid":
                valid_total += 1
            elif status == "expired":
                expired_total += 1
            else:
                invalid_total += 1

    for cat_id, cr in categories_result.items():
        expected = 0
        for cat in material_categories:
            if cat["id"] == cat_id:
                expected = cat.get("expected_min", 0)
                break
        if expected > 0:
            cr["completeness_pct"] = min(100, round(cr["valid"] / expected * 100))
        elif cr["total"] > 0:
            cr["completeness_pct"] = 100
        else:
            cr["completeness_pct"] = 0

    missing_categories = []
    for cat_id, cr in categories_result.items():
        for cat in material_categories:
            if cat["id"] == cat_id and cat.get("required") and cr["valid"] == 0:
                missing_categories.append(cat["name"])

    return {
        "scan_mode": "scan-materials",
        "scan_time": datetime.now().isoformat(),
        "project_id": project_id,
        "total_scanned": total_scanned,
        "materials": categories_result,
        "summary": {
            "valid_total": valid_total,
            "expired_total": expired_total,
            "invalid_total": invalid_total,
            "missing_categories": missing_categories
        }
    }


def discover_projects(project_root):
    projects = [
        {
            "id": "main",
            "name": "",
            "type": "",
            "sub_path": ".",
            "has_config": os.path.exists(os.path.join(project_root, ".trae", "project_config.json"))
        }
    ]

    main_config_path = os.path.join(project_root, ".trae", "project_config.json")
    if os.path.exists(main_config_path):
        with open(main_config_path, "r", encoding="utf-8") as f:
            main_config = json.load(f)
        projects[0]["type"] = main_config.get("project_type", "")
        projects[0]["name"] = main_config.get("project_name", os.path.basename(project_root))

    if not projects[0]["name"]:
        projects[0]["name"] = os.path.basename(project_root)

    try:
        for entry in os.scandir(project_root):
            if not entry.is_dir():
                continue
            if entry.name.startswith(".") or entry.name.startswith("_"):
                continue
            if entry.name.startswith("000"):
                continue

            config_path = os.path.join(entry.path, ".trae", "project_config.json")
            if os.path.exists(config_path):
                with open(config_path, "r", encoding="utf-8") as f:
                    sub_config = json.load(f)
                sub_type = sub_config.get("project_type", "")
                if sub_type:
                    projects.append({
                        "id": entry.name,
                        "name": sub_config.get("project_name", entry.name),
                        "type": sub_type,
                        "sub_path": entry.name,
                        "has_config": True
                    })
    except OSError:
        pass

    return {"discover_time": datetime.now().isoformat(), "project_root": project_root, "projects": projects}


def main():
    parser = argparse.ArgumentParser(description="双模式文件扫描器")
    subparsers = parser.add_subparsers(dest="command")

    cmd_scan = subparsers.add_parser("scan")
    cmd_scan.add_argument("--project-root", default=".")
    cmd_scan.add_argument("--project-id", default="main")
    cmd_scan.add_argument("--output", default=".trae/_scan_result.json")

    cmd_disc = subparsers.add_parser("discover")
    cmd_disc.add_argument("--project-root", default=".")
    cmd_disc.add_argument("--output", default=".trae/_discovered_projects.json")

    args = parser.parse_args()

    if args.command == "scan":
        result = scan_materials(args.project_root, args.project_id)
        output_path = os.path.join(args.project_root, args.output) if not os.path.isabs(args.output) else args.output
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"OK: 扫描完成，共 {result.get('total_scanned', 0)} 个文件")
        print(f"  有效: {result['summary']['valid_total']}")
        print(f"  过期: {result['summary']['expired_total']}")
        print(f"  无效: {result['summary']['invalid_total']}")
        if result["summary"]["missing_categories"]:
            print(f"  缺失类别: {', '.join(result['summary']['missing_categories'])}")
        print(f"  结果已保存到: {output_path}")

    elif args.command == "discover":
        result = discover_projects(args.project_root)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if args.output:
            output_path = os.path.join(args.project_root, args.output) if not os.path.isabs(args.output) else args.output
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
