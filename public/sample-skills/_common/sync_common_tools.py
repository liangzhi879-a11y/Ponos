#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
公共工具版本管理（sync_common_tools）

管理 `_common/` 目录下所有共享工具的版本和变更记录。
提供：版本追踪、变更记录、引用校验、一键状态报告。

用法:
    # 查看所有公共工具版本状态
    python sync_common_tools.py status

    # 记录某个工具的版本变更
    python sync_common_tools.py bump --tool file_compressor.py --from 2.0 --to 2.1 \\
        --summary "彩色优先策略+自适应DPI+压缩有效性检测"

    # 校验所有技能引用的工具是否最新
    python sync_common_tools.py check

    # 生成变更报告
    python sync_common_tools.py report --since 2026-07-01
"""

import os
import sys
import json
import argparse
from datetime import datetime
from pathlib import Path

COMMON_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = COMMON_DIR / '_common_manifest.json'
SKILLS_DIR = COMMON_DIR.parent


# ============================================================
# 版本清单结构
# ============================================================

def load_manifest():
    if MANIFEST_PATH.exists():
        with open(MANIFEST_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {
        "schema_version": "1.0",
        "created_at": datetime.now().isoformat(),
        "tools": {}
    }


def save_manifest(m):
    m["updated_at"] = datetime.now().isoformat()
    with open(MANIFEST_PATH, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=2)


# ============================================================
# 自动发现公共工具
# ============================================================

def discover_tools():
    """扫描 _common/ 目录，识别所有可执行工具"""
    tools = {}
    for f in sorted(COMMON_DIR.glob("*.py")):
        if f.name.startswith("_"):
            continue  # 跳过内部工具
        content = f.read_text(encoding='utf-8', errors='ignore')
        # 提取 shebang + 文档描述
        first_lines = content.split('\n')[:5]
        desc = ""
        version = "unknown"
        for line in first_lines:
            if 'version' in line.lower() or 'v2.' in line or 'v1.' in line:
                version = line.strip().strip('"').strip("'")
            if f.name.replace('.py', '') in line and '—' in line:
                desc = line.strip('# ').strip()
        tools[f.name] = {
            "path": str(f.relative_to(COMMON_DIR.parent)),
            "version": version,
            "description": desc,
            "last_modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat()
        }
    # 也扫描 JSON 配置
    for f in sorted(COMMON_DIR.glob("*.json")):
        if f.name.startswith("_"):
            continue
        tools[f.name] = {
            "path": str(f.relative_to(COMMON_DIR.parent)),
            "version": "n/a",
            "description": "配置文件",
            "last_modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat()
        }
    return tools


# ============================================================
# 引用分析
# ============================================================

def find_tool_references(tool_name):
    """查找哪些技能引用了某个公共工具"""
    refs = []
    tool_basename = tool_name.replace('.py', '').replace('.json', '')
    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir() or skill_dir.name.startswith('_'):
            continue
        skill_md = skill_dir / 'SKILL.md'
        if not skill_md.exists():
            continue
        content = skill_md.read_text(encoding='utf-8', errors='ignore')
        if tool_basename in content:
            refs.append(skill_dir.name)
    return refs


# ============================================================
# 命令实现
# ============================================================

def cmd_status():
    """显示所有公共工具的状态"""
    manifest = load_manifest()
    tools = discover_tools()

    print("=" * 70)
    print(f"公共工具状态报告 - {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"目录: {COMMON_DIR}")
    print("=" * 70)

    total = 0
    tracked = 0
    for name, info in tools.items():
        total += 1
        if name in manifest.get("tools", {}):
            tracked += 1
            m = manifest["tools"][name]
            status = "✓ 已追踪"
        else:
            status = "○ 未追踪"

        refs = find_tool_references(name)
        ref_str = f"  引用: {', '.join(refs)}" if refs else "  引用: (无)"

        print(f"\n  [{status}] {name}")
        print(f"  修改时间: {info['last_modified'][:19]}")
        if info['version'] != 'unknown' and info['version'] != 'n/a':
            print(f"  版本: {info['version']}")
        print(ref_str)

    print(f"\n---")
    print(f"总计: {total} 个工具, {tracked} 个已追踪")


def cmd_bump(tool_name, old_v, new_v, summary):
    """记录版本变更"""
    manifest = load_manifest()
    tools = manifest.setdefault("tools", {})

    if tool_name not in tools:
        tools[tool_name] = {"versions": [], "history": []}

    tools[tool_name]["current_version"] = new_v
    tools[tool_name]["history"].append({
        "from": old_v,
        "to": new_v,
        "date": datetime.now().isoformat(),
        "summary": summary
    })

    save_manifest(manifest)
    refs = find_tool_references(tool_name)
    print(f"✓ {tool_name}: {old_v} → {new_v}")
    print(f"  摘要: {summary}")
    if refs:
        print(f"  受影响技能: {', '.join(refs)}")


def cmd_check():
    """校验引用一致性"""
    manifest = load_manifest()
    tools = discover_tools()
    issues = []

    for name, info in tools.items():
        if name in manifest.get("tools", {}):
            m = manifest["tools"][name]
            if m.get("current_version", "unknown") != info.get("version", "unknown"):
                issues.append(f"  {name}: 清单版本={m.get('current_version')}, 实际={info.get('version')}")

    if issues:
        print("⚠ 发现版本不一致:")
        for i in issues:
            print(i)
    else:
        print("✓ 所有已追踪工具版本一致")

    # 检查是否有未追踪的新工具
    untracked = [n for n in tools if n not in manifest.get("tools", {})]
    if untracked:
        print(f"\n○ {len(untracked)} 个未追踪工具: {', '.join(untracked)}")
        print("  run 'python sync_common_tools.py status' 查看详情")


def cmd_report(since_date=None):
    """生成变更报告"""
    manifest = load_manifest()
    tools = discover_tools()

    print("=" * 70)
    print(f"公共工具变更报告 - {datetime.now().strftime('%Y-%m-%d')}")
    print("=" * 70)

    for name in sorted(tools.keys()):
        if name not in manifest.get("tools", {}):
            continue
        m = manifest["tools"][name]
        history = m.get("history", [])
        if not history:
            continue
        print(f"\n## {name} (v{m.get('current_version', '?')})")
        for h in history:
            date = h["date"][:10]
            if since_date and date < since_date:
                continue
            print(f"  {date}: {h['from']} → {h['to']} — {h['summary']}")

    print(f"\n---")
    print(f"文件修改时间统计:")
    for name, info in sorted(tools.items()):
        print(f"  {info['last_modified'][:19]}  {name}")


# ============================================================
# CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="公共工具版本管理")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("status", help="查看所有工具版本状态")

    bump_p = sub.add_parser("bump", help="记录版本变更")
    bump_p.add_argument("--tool", required=True, help="工具文件名")
    bump_p.add_argument("--from", dest="old_v", required=True, help="旧版本")
    bump_p.add_argument("--to", dest="new_v", required=True, help="新版本")
    bump_p.add_argument("--summary", required=True, help="变更摘要")

    sub.add_parser("check", help="校验引用一致性")

    report_p = sub.add_parser("report", help="生成变更报告")
    report_p.add_argument("--since", help="起始日期 (YYYY-MM-DD)")

    args = parser.parse_args()

    if args.cmd == "status":
        cmd_status()
    elif args.cmd == "bump":
        cmd_bump(args.tool, args.old_v, args.new_v, args.summary)
    elif args.cmd == "check":
        cmd_check()
    elif args.cmd == "report":
        cmd_report(args.since)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
