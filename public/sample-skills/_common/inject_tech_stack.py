#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
inject_tech_stack.py - 批量将技术栈引用注入到所有gxtz技能的SKILL.md

注入位置：在 "## 合规红线" 之前插入（确保agent第一时间看到）
幂等性：检测到已存在则跳过

用法：
  python inject_tech_stack.py              # 注入所有技能
  python inject_tech_stack.py --dry-run    # 预览
  python inject_tech_stack.py --remove     # 移除
"""

import argparse
import re
import sys
from pathlib import Path

SKILLS_DIR = Path(__file__).parent.parent
COMMON_DIR = Path(__file__).parent
REFERENCE_FILE = COMMON_DIR / "_tech_stack_reference.md"

BEGIN_MARKER = "<!-- SECTION_BEGIN: tech_stack_reference -->"
END_MARKER = "<!-- SECTION_END: tech_stack_reference -->"

INJECT_BEFORE_PATTERN = r'^## 合规红线'


def load_reference():
    if not REFERENCE_FILE.exists():
        print(f"[inject] ERROR: 引用文件不存在: {REFERENCE_FILE}")
        return None
    return REFERENCE_FILE.read_text(encoding='utf-8')


def has_reference(content):
    return BEGIN_MARKER in content and END_MARKER in content


def inject_to_skill(skill_dir, reference_content, dry_run=False):
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return False

    content = skill_md.read_text(encoding='utf-8')
    if has_reference(content):
        print(f"[inject] SKIP: {skill_dir.name} 已包含技术栈引用")
        return False

    match = re.search(INJECT_BEFORE_PATTERN, content, re.MULTILINE)
    if not match:
        print(f"[inject] WARN: {skill_dir.name} 未找到合规红线锚点，跳过")
        return False

    if dry_run:
        print(f"[inject] DRY-RUN: 将在 {skill_dir.name} 的合规红线之前注入技术栈引用")
        return True

    new_content = (
        content[:match.start()]
        + reference_content.strip()
        + "\n\n"
        + content[match.start():]
    )
    skill_md.write_text(new_content, encoding='utf-8')
    print(f"[inject] ✓ {skill_dir.name}: 技术栈引用已注入")
    return True


def remove_from_skill(skill_dir):
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return False

    content = skill_md.read_text(encoding='utf-8')
    if not has_reference(content):
        return False

    start = content.find(BEGIN_MARKER)
    end = content.find(END_MARKER)
    if start == -1 or end == -1:
        return False
    end_pos = end + len(END_MARKER)
    while end_pos < len(content) and content[end_pos] in '\r\n':
        end_pos += 1
    content = content[:start] + content[end_pos:]
    content = re.sub(r'\n{3,}', '\n\n', content)
    skill_md.write_text(content, encoding='utf-8')
    print(f"[remove] ✓ {skill_dir.name}: 技术栈引用已移除")
    return True


def main():
    parser = argparse.ArgumentParser(description='批量注入技术栈引用到gxtz技能')
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--remove", action="store_true")
    args = parser.parse_args()

    reference_content = load_reference()
    if not reference_content:
        sys.exit(1)

    target_skills = [
        d for d in SKILLS_DIR.iterdir()
        if d.is_dir() and d.name.startswith("gxtz-") and (d / "SKILL.md").exists()
    ]

    print(f"[inject] 目标技能数: {len(target_skills)}")
    print(f"[inject] 模式: {'移除' if args.remove else '注入'}{' (dry-run)' if args.dry_run else ''}\n")

    success_count = 0
    for skill_dir in sorted(target_skills):
        if args.remove:
            if remove_from_skill(skill_dir):
                success_count += 1
        else:
            if inject_to_skill(skill_dir, reference_content, args.dry_run):
                success_count += 1

    print(f"\n[inject] 完成: {success_count}/{len(target_skills)}")


if __name__ == "__main__":
    main()
