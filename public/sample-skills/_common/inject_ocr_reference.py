#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
inject_ocr_reference.py - 批量将OCR能力引用注入到所有gxtz技能的SKILL.md

注入位置：在「技术栈引用」节之后注入（保证OCR说明紧跟技术栈）
幂等性：检测到已存在则跳过

用法：
  python inject_ocr_reference.py              # 注入所有技能
  python inject_ocr_reference.py --dry-run    # 预览
  python inject_ocr_reference.py --remove     # 移除
"""

import argparse
import re
import sys
from pathlib import Path

SKILLS_DIR = Path(__file__).parent.parent
COMMON_DIR = Path(__file__).parent
REFERENCE_FILE = COMMON_DIR / "_ocr_reference.md"

BEGIN_MARKER = "<!-- SECTION_BEGIN: ocr_reference -->"
END_MARKER = "<!-- SECTION_END: ocr_reference -->"

# 在「技术栈引用」节之后注入；若无则在「合规红线」之前
INJECT_AFTER_PATTERN = r'<!-- SECTION_END: tech_stack_reference -->'
FALLBACK_PATTERN = r'^## 合规红线'


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
        print(f"[inject] SKIP: {skill_dir.name} 已包含OCR引用")
        return False

    # 优先：在技术栈引用之后
    match = re.search(INJECT_AFTER_PATTERN, content)
    if match:
        inject_pos = match.end()
        inject_anchor = "技术栈引用之后"
    else:
        # 备用：在合规红线之前
        match = re.search(FALLBACK_PATTERN, content, re.MULTILINE)
        if match:
            inject_pos = match.start()
            inject_anchor = "合规红线之前"
        else:
            print(f"[inject] WARN: {skill_dir.name} 未找到注入锚点，跳过")
            return False

    if dry_run:
        print(f"[inject] DRY-RUN: 将在 {skill_dir.name} 的「{inject_anchor}」注入OCR引用")
        return True

    # 插入引用（前后加空行）
    new_content = (
        content[:inject_pos]
        + "\n\n"
        + reference_content.strip()
        + "\n"
        + content[inject_pos:]
    )
    skill_md.write_text(new_content, encoding='utf-8')
    print(f"[inject] ✓ {skill_dir.name}: OCR引用已注入（位置：{inject_anchor}）")
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
    # 清理前面的空行
    while start > 0 and content[start - 1] in '\n':
        start -= 1
    content = content[:start] + content[end_pos:]
    content = re.sub(r'\n{3,}', '\n\n', content)
    skill_md.write_text(content, encoding='utf-8')
    print(f"[remove] ✓ {skill_dir.name}: OCR引用已移除")
    return True


def main():
    parser = argparse.ArgumentParser(description='批量注入OCR引用到gxtz技能')
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
