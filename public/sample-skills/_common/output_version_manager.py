#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
output_version_manager.py - 技能输出文档版本管理器

职责：
1. 技能产出文档时，自动将上一版本备份到 .trae/output_backup/{skill_name}/
2. 规定目录下仅保留最新有效版本
3. 过程版本以 .bak 后缀转移，命名规则：{原文件名}_{YYYYMMDD_HHMMSS}.bak

使用方式：
  # 技能产出新文档前调用（自动备份旧版本）
  from output_version_manager import backup_previous_version
  backup_previous_version(output_path, skill_name="gxtz-achievement-materials")

  # 命令行：清理目录（将所有非最新版本移入备份）
  python output_version_manager.py cleanup --dir "成果转化/" --skill "gxtz-achievement-materials"

  # 命令行：查看备份
  python output_version_manager.py list-backups --skill "gxtz-achievement-materials"
"""

import argparse
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path


PROJECT_ROOT = Path(__file__).parent.parent.parent
BACKUP_ROOT = PROJECT_ROOT / ".trae" / "output_backup"


# ============================================================
# 备份函数
# ============================================================
def backup_previous_version(output_path, skill_name="default"):
    """备份上一版本到备份文件夹

    在技能产出新文档前调用此函数，将已存在的同名文件移入备份文件夹。
    备份后的文件名：{原文件名}_{YYYYMMDD_HHMMSS}.bak{原扩展名}

    参数：
        output_path: 即将生成的新文件路径（如果已存在同名文件，会先备份）
        skill_name: 技能名（用于隔离不同技能的备份）

    返回：
        {
            "backed_up": bool,  # 是否执行了备份
            "backup_path": str,  # 备份文件路径
            "original_path": str,  # 原文件路径
        }
    """
    output_path = Path(output_path)
    if not output_path.exists():
        return {"backed_up": False, "backup_path": None, "original_path": str(output_path)}

    # 创建备份目录
    backup_dir = BACKUP_ROOT / skill_name
    backup_dir.mkdir(parents=True, exist_ok=True)

    # 生成备份文件名：{stem}_{YYYYMMDD_HHMMSS}.bak{suffix}
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_name = f"{output_path.stem}_{timestamp}.bak{output_path.suffix}"
    backup_path = backup_dir / backup_name

    # 移动文件（非复制，确保规定目录只保留最新版本）
    shutil.move(str(output_path), str(backup_path))

    # 更新备份索引
    _update_backup_index(skill_name, output_path, backup_path)

    print(f"[backup] 已备份: {output_path.name} -> {backup_path}")
    return {
        "backed_up": True,
        "backup_path": str(backup_path),
        "original_path": str(output_path),
    }


def _update_backup_index(skill_name, original_path, backup_path):
    """更新备份索引文件"""
    index_path = BACKUP_ROOT / skill_name / "backup_index.json"
    try:
        if index_path.exists():
            index = json.loads(index_path.read_text(encoding='utf-8'))
        else:
            index = {"entries": []}

        index["entries"].append({
            "original_path": str(original_path),
            "backup_path": str(backup_path),
            "backup_name": Path(backup_path).name,
            "backup_at": datetime.now().isoformat(),
            "file_size": Path(backup_path).stat().st_size if Path(backup_path).exists() else 0,
        })
        index["last_updated"] = datetime.now().isoformat()
        index["total_entries"] = len(index["entries"])

        index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception as e:
        print(f"[backup] WARN: 索引更新失败: {e}")


# ============================================================
# 清理函数
# ============================================================
def cleanup_directory(target_dir, skill_name="default", keep_latest=True):
    """清理目录：仅保留每个文件的最新版本，其余移入备份

    参数：
        target_dir: 待清理的目录
        skill_name: 技能名（备份隔离）
        keep_latest: True=保留最新版本，False=不清理
    """
    if not keep_latest:
        return {"cleaned": 0, "backed_up": 0}

    target_dir = Path(target_dir)
    if not target_dir.is_dir():
        print(f"[cleanup] ERROR: 不是目录: {target_dir}")
        return {"cleaned": 0, "backed_up": 0}

    # 找出所有过程版本文件（含 _v1, _v2, _backup, _fixed, _draft 等后缀）
    process_patterns = [
        r'.*_v\d+.*$',
        r'.*_backup.*$',
        r'.*_fixed.*$',
        r'.*_draft.*$',
        r'.*_old.*$',
        r'.*_tmp.*$',
        r'.*_\d{8}.*$',  # 含日期的中间版本
    ]
    import re

    backed_up_count = 0
    for file_path in target_dir.rglob("*"):
        if not file_path.is_file():
            continue
        name = file_path.stem.lower()
        is_process = any(re.search(p, name) for p in process_patterns)
        if is_process:
            result = backup_previous_version(file_path, skill_name)
            if result["backed_up"]:
                backed_up_count += 1

    print(f"[cleanup] 清理完成: {target_dir}（备份 {backed_up_count} 个过程版本）")
    return {"cleaned": backed_up_count, "backed_up": backed_up_count}


# ============================================================
# 查询函数
# ============================================================
def list_backups(skill_name):
    """列出指定技能的备份文件"""
    backup_dir = BACKUP_ROOT / skill_name
    if not backup_dir.exists():
        print(f"[list] 技能 {skill_name} 无备份")
        return {"entries": []}

    index_path = backup_dir / "backup_index.json"
    if not index_path.exists():
        # 无索引，直接扫描目录
        backups = []
        for f in backup_dir.glob("*.bak*"):
            backups.append({
                "backup_name": f.name,
                "backup_path": str(f),
                "file_size": f.stat().st_size,
            })
        print(f"[list] 技能 {skill_name} 有 {len(backups)} 个备份（无索引）")
        for b in backups:
            print(f"  {b['backup_name']} ({b['file_size']} bytes)")
        return {"entries": backups}

    # 从索引读取
    index = json.loads(index_path.read_text(encoding='utf-8'))
    entries = index.get("entries", [])
    print(f"\n[list] 技能 {skill_name} 备份列表（共{len(entries)}个）")
    print(f"{'备份时间':<25} {'原文件名':<40} {'备份文件名':<50} {'大小':<10}")
    print("-" * 130)
    for e in entries[-20:]:  # 最多显示20个
        original_name = Path(e.get("original_path", "")).name
        backup_name = e.get("backup_name", "")
        size = e.get("file_size", 0)
        size_str = f"{size/1024:.1f}KB" if size > 1024 else f"{size}B"
        backup_at = e.get("backup_at", "")[:19]
        print(f"{backup_at:<25} {original_name[:40]:<40} {backup_name[:50]:<50} {size_str:<10}")
    if len(entries) > 20:
        print(f"... 还有 {len(entries)-20} 个备份未显示")
    return {"entries": entries}


# ============================================================
# 命令行入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description='技能输出文档版本管理器（保留最新+过程版本.bak备份）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
示例：
  # 清理目录（过程版本移入备份）
  python output_version_manager.py cleanup --dir "成果转化/" --skill "gxtz-achievement-materials"

  # 查看备份
  python output_version_manager.py list-backups --skill "gxtz-achievement-materials"
        ''',
    )
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    # cleanup 子命令
    clean_parser = subparsers.add_parser("cleanup", help="清理目录，过程版本移入备份")
    clean_parser.add_argument("--dir", required=True, help="待清理目录")
    clean_parser.add_argument("--skill", default="default", help="技能名（备份隔离）")

    # list-backups 子命令
    list_parser = subparsers.add_parser("list-backups", help="查看备份列表")
    list_parser.add_argument("--skill", required=True, help="技能名")

    # backup 子命令（备份单个文件）
    backup_parser = subparsers.add_parser("backup", help="备份单个文件")
    backup_parser.add_argument("--file", required=True, help="待备份文件路径")
    backup_parser.add_argument("--skill", default="default", help="技能名")

    args = parser.parse_args()

    if args.command == "cleanup":
        result = cleanup_directory(args.dir, args.skill)
        sys.exit(0)
    elif args.command == "list-backups":
        list_backups(args.skill)
        sys.exit(0)
    elif args.command == "backup":
        result = backup_previous_version(args.file, args.skill)
        if result["backed_up"]:
            print(f"[backup] ✓ 已备份: {result['backup_path']}")
        else:
            print(f"[backup] 文件不存在，无需备份: {result['original_path']}")
        sys.exit(0)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
