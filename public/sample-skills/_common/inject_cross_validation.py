#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
inject_cross_validation.py - 批量将交叉验证协议注入到所有gxtz技能的SKILL.md

注入位置：在 "## 执行顺序契约" 之前插入（与质疑审查机制同级）
幂等性：检测到已存在则跳过，不会重复注入

用法：
  python inject_cross_validation.py              # 注入所有技能
  python inject_cross_validation.py --skill gxtz-core-tables  # 仅注入指定技能
  python inject_cross_validation.py --dry-run    # 预览，不实际修改
  python inject_cross_validation.py --remove     # 移除已注入的协议
"""

import argparse
import re
import sys
from pathlib import Path

SKILLS_DIR = Path(__file__).parent.parent
COMMON_DIR = Path(__file__).parent
PROTOCOL_FILE = COMMON_DIR / "_cross_validation_protocol.md"

SECTION_BEGIN_MARKER = "<!-- SECTION_BEGIN: cross_validation_protocol -->"
SECTION_END_MARKER = "<!-- SECTION_END: cross_validation_protocol -->"

# 注入锚点：在执行顺序契约之前
INJECT_BEFORE_PATTERN = r'^## 执行顺序契约'
# 备用锚点：如果没有执行顺序契约，则在合规红线之前
FALLBACK_PATTERN = r'^## 合规红线'


def load_protocol():
    """加载交叉验证协议内容"""
    if not PROTOCOL_FILE.exists():
        print(f"[inject] ERROR: 协议文件不存在: {PROTOCOL_FILE}")
        return None
    return PROTOCOL_FILE.read_text(encoding='utf-8')


def extract_section(content, begin_marker, end_marker):
    """从文件中提取指定section（含marker）"""
    start = content.find(begin_marker)
    if start == -1:
        return None
    end = content.find(end_marker)
    if end == -1:
        return None
    end_pos = end + len(end_marker)
    # 包含后续换行
    while end_pos < len(content) and content[end_pos] in '\r\n':
        end_pos += 1
    return content[start:end_pos]


def has_protocol(content):
    """检测内容是否已包含交叉验证协议"""
    return SECTION_BEGIN_MARKER in content and SECTION_END_MARKER in content


def inject_to_skill(skill_dir, protocol_content, dry_run=False):
    """将协议注入到单个技能的SKILL.md"""
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        print(f"[inject] SKIP: {skill_dir.name} 无SKILL.md")
        return False

    content = skill_md.read_text(encoding='utf-8')

    # 检查是否已注入
    if has_protocol(content):
        print(f"[inject] SKIP: {skill_dir.name} 已包含交叉验证协议")
        return False

    # 寻找注入位置
    inject_pos = None
    inject_before_match = None

    # 优先：执行顺序契约之前
    match = re.search(INJECT_BEFORE_PATTERN, content, re.MULTILINE)
    if match:
        inject_pos = match.start()
        inject_before_match = "执行顺序契约"
    else:
        # 备用：合规红线之前
        match = re.search(FALLBACK_PATTERN, content, re.MULTILINE)
        if match:
            inject_pos = match.start()
            inject_before_match = "合规红线"

    if inject_pos is None:
        print(f"[inject] WARN: {skill_dir.name} 未找到注入锚点（执行顺序契约/合规红线），跳过")
        return False

    if dry_run:
        print(f"[inject] DRY-RUN: 将在 {skill_dir.name} 的「{inject_before_match}」之前注入协议")
        return True

    # 插入协议（前后加空行确保格式）
    new_content = (
        content[:inject_pos]
        + protocol_content.strip()
        + "\n\n"
        + content[inject_pos:]
    )

    skill_md.write_text(new_content, encoding='utf-8')
    print(f"[inject] ✓ {skill_dir.name}：协议已注入（位置：{inject_before_match}之前）")
    return True


def remove_from_skill(skill_dir):
    """从技能SKILL.md中移除交叉验证协议"""
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return False

    content = skill_md.read_text(encoding='utf-8')
    if not has_protocol(content):
        print(f"[remove] SKIP: {skill_dir.name} 未包含交叉验证协议")
        return False

    section = extract_section(content, SECTION_BEGIN_MARKER, SECTION_END_MARKER)
    if section:
        content = content.replace(section, "")
        # 清理多余空行
        content = re.sub(r'\n{3,}', '\n\n', content)
        skill_md.write_text(content, encoding='utf-8')
        print(f"[remove] ✓ {skill_dir.name}：协议已移除")
        return True
    return False


def main():
    parser = argparse.ArgumentParser(
        description='批量注入/移除交叉验证协议到gxtz技能',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--skill", default=None, help="仅注入指定技能（如 gxtz-core-tables）")
    parser.add_argument("--dry-run", action="store_true", help="预览，不实际修改")
    parser.add_argument("--remove", action="store_true", help="移除而非注入")
    args = parser.parse_args()

    protocol_content = load_protocol()
    if not protocol_content:
        sys.exit(1)

    # 收集目标技能
    if args.skill:
        target_skills = [SKILLS_DIR / args.skill]
    else:
        target_skills = [
            d for d in SKILLS_DIR.iterdir()
            if d.is_dir() and d.name.startswith("gxtz-") and (d / "SKILL.md").exists()
        ]

    print(f"[inject] 目标技能数: {len(target_skills)}")
    print(f"[inject] 模式: {'移除' if args.remove else '注入'}{' (dry-run)' if args.dry_run else ''}")
    print()

    success_count = 0
    for skill_dir in sorted(target_skills):
        if args.remove:
            if remove_from_skill(skill_dir):
                success_count += 1
        else:
            if inject_to_skill(skill_dir, protocol_content, args.dry_run):
                success_count += 1

    print(f"\n[inject] 完成：{success_count}/{len(target_skills)} 个技能{'已移除' if args.remove else '已注入'}")


if __name__ == "__main__":
    main()
