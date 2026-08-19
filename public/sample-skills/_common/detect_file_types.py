#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
detect_file_types.py - 项目文件类型探测与统计

用途：扫描项目目录，统计文件类型分布，给出每个文件推荐的工具栈。
agent 处理新项目时第一步调用此脚本，快速了解项目资料构成。

用法：
  python detect_file_types.py --dir "项目目录"
  python detect_file_types.py --dir "项目目录" --json
  python detect_file_types.py --dir "项目目录" --recommend  # 每个文件推荐处理方案
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

COMMON_DIR = Path(__file__).parent
TECH_STACK_FILE = COMMON_DIR / "tech_stack.json"

# 忽略的目录
IGNORE_DIRS = {'.trae', '__pycache__', '.git', 'node_modules', '.venv', 'venv'}
# 忽略的扩展名（非资料文件）
IGNORE_EXTENSIONS = {'.pyc', '.tmp', '.bak', '.swp', '.DS_Store', '.Thumbs.db', '.lnk'}


def load_tech_stack():
    """加载技术栈配置"""
    if not TECH_STACK_FILE.exists():
        return {}
    try:
        return json.loads(TECH_STACK_FILE.read_text(encoding='utf-8'))
    except Exception:
        return {}


def format_size(size_bytes):
    """格式化文件大小"""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"


def scan_directory(directory, max_files=10000):
    """扫描目录，统计文件类型

    返回：
        {
            "total_files": 207,
            "total_size": 123456789,
            "by_extension": {
                ".pdf": {"count": 127, "size": 98000000, "files": [...]},
                ...
            },
            "unknown_extensions": [...],
            "no_extension_files": [...],
        }
    """
    directory = Path(directory)
    result = {
        "scanned_at": datetime.now().isoformat(),
        "directory": str(directory),
        "total_files": 0,
        "total_size": 0,
        "by_extension": defaultdict(lambda: {"count": 0, "size": 0, "files": []}),
        "unknown_extensions": [],
        "no_extension_files": [],
    }

    file_count = 0
    for root, dirs, files in os.walk(directory):
        # 过滤忽略目录
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]

        for filename in files:
            if file_count >= max_files:
                result["truncated"] = True
                break

            filepath = Path(root) / filename
            try:
                size = filepath.stat().st_size
            except (OSError, PermissionError):
                continue

            ext = filepath.suffix.lower()

            # 忽略非资料文件
            if ext in IGNORE_EXTENSIONS:
                continue

            rel_path = str(filepath.relative_to(directory))

            if ext == "":
                result["no_extension_files"].append(rel_path)
            else:
                ext_data = result["by_extension"][ext]
                ext_data["count"] += 1
                ext_data["size"] += size
                # 每种类型最多保留10个样本路径
                if len(ext_data["files"]) < 10:
                    ext_data["files"].append(rel_path)

            result["total_files"] += 1
            result["total_size"] += size
            file_count += 1

    # 转换 defaultdict 为普通 dict 并排序
    sorted_exts = sorted(result["by_extension"].items(),
                         key=lambda x: x[1]["count"], reverse=True)
    result["by_extension"] = {
        ext: {**data, "size_formatted": format_size(data["size"])}
        for ext, data in sorted_exts
    }

    # 检查未知扩展名（不在 tech_stack.json 中的）
    tech_stack = load_tech_stack()
    handlers = tech_stack.get("file_type_handlers", {})
    for ext in result["by_extension"]:
        if ext not in handlers:
            result["unknown_extensions"].append(ext)

    return result


def recommend_toolkit(ext, tech_stack):
    """为某扩展名推荐工具栈"""
    handlers = tech_stack.get("file_type_handlers", {})
    if ext not in handlers:
        return None
    handler = handlers[ext]
    return {
        "description": handler.get("description", ""),
        "primary_library": handler.get("primary_library", ""),
        "library_install": handler.get("library_install", ""),
        "read_command": handler.get("read", {}).get("toolkit_command", ""),
        "common_scenarios": handler.get("common_scenarios", {}),
    }


def print_report(scan_result, tech_stack, show_recommend=False, json_output=False):
    """打印扫描报告"""
    if json_output:
        print(json.dumps(scan_result, ensure_ascii=False, indent=2, default=str))
        return

    print(f"\n{'='*80}")
    print(f"  项目文件类型探测报告")
    print(f"{'='*80}")
    print(f"  扫描目录: {scan_result['directory']}")
    print(f"  扫描时间: {scan_result['scanned_at']}")
    print(f"  总文件数: {scan_result['total_files']}")
    print(f"  总大小:   {format_size(scan_result['total_size'])}")
    print(f"{'='*80}\n")

    print(f"{'扩展名':<10} {'数量':<8} {'大小':<12} {'推荐库':<20} {'描述'}")
    print("-" * 100)

    for ext, data in scan_result["by_extension"].items():
        rec = recommend_toolkit(ext, tech_stack)
        lib = rec["primary_library"] if rec else "(未配置)"
        desc = (rec["description"][:30] + "...") if rec and len(rec["description"]) > 30 else (rec["description"] if rec else "(未知类型)")
        print(f"{ext:<10} {data['count']:<8} {data['size_formatted']:<12} {lib:<20} {desc}")

    # 未知扩展名警告
    if scan_result["unknown_extensions"]:
        print(f"\n⚠ 未知扩展名（tech_stack.json 未配置处理方案）:")
        for ext in scan_result["unknown_extensions"]:
            count = scan_result["by_extension"][ext]["count"]
            print(f"  {ext}: {count}个文件")

    # 推荐处理方案
    if show_recommend:
        print(f"\n{'='*80}")
        print(f"  各文件类型推荐处理方案")
        print(f"{'='*80}")
        for ext, data in scan_result["by_extension"].items():
            rec = recommend_toolkit(ext, tech_stack)
            if rec:
                print(f"\n【{ext}】{rec['description']}")
                print(f"  推荐库: {rec['primary_library']}")
                print(f"  安装:   {rec['library_install']}")
                if rec["read_command"]:
                    print(f"  读取:   {rec['read_command']}")
                if rec["common_scenarios"]:
                    print(f"  常见场景:")
                    for scenario, method in rec["common_scenarios"].items():
                        print(f"    - {scenario}: {method}")
            else:
                print(f"\n【{ext}】⚠ 无推荐方案（未在 tech_stack.json 中配置）")

    # 样本文件列表
    print(f"\n{'='*80}")
    print(f"  各类型样本文件（最多10个）")
    print(f"{'='*80}")
    for ext, data in scan_result["by_extension"].items():
        print(f"\n【{ext}】({data['count']}个)")
        for f in data["files"]:
            print(f"  {f}")


def main():
    parser = argparse.ArgumentParser(description='项目文件类型探测与统计')
    parser.add_argument("--dir", required=True, help="要扫描的目录")
    parser.add_argument("--json", action="store_true", help="输出JSON格式")
    parser.add_argument("--recommend", action="store_true", help="显示每个类型的推荐处理方案")
    args = parser.parse_args()

    if not Path(args.dir).exists():
        print(f"[ERROR] 目录不存在: {args.dir}")
        sys.exit(1)

    tech_stack = load_tech_stack()
    scan_result = scan_directory(args.dir)
    print_report(scan_result, tech_stack, args.recommend, args.json)


if __name__ == "__main__":
    main()
