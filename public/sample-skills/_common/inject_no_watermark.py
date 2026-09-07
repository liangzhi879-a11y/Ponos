#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
inject_no_watermark.py - 批量将"禁止AI水印"规则注入到所有gxtz技能的SKILL.md

注入位置：在「OCR能力引用」节之后注入（保证输出合规规则紧跟技术能力说明）
幂等性：检测到已存在则跳过

用法：
  python inject_no_watermark.py              # 注入所有技能
  python inject_no_watermark.py --dry-run    # 预览
  python inject_no_watermark.py --remove     # 移除
"""

import argparse
import re
import sys
from pathlib import Path

SKILLS_DIR = Path(__file__).parent.parent
COMMON_DIR = Path(__file__).parent
REFERENCE_FILE = COMMON_DIR / "_no_ai_watermark.md"

BEGIN_MARKER = "<!-- SECTION_BEGIN: no_ai_watermark -->"
END_MARKER = "<!-- SECTION_END: no_ai_watermark -->"

# 优先在OCR引用之后注入；若无则在技术栈引用之后；再无则在合规红线之前
INJECT_AFTER_OCR = r'<!-- SECTION_END: ocr_reference -->'
INJECT_AFTER_TECH = r'<!-- SECTION_END: tech_stack_reference -->'
FALLBACK_PATTERN = r'^## 合规红线'


def load_reference():
    if not REFERENCE_FILE.exists():
        print(f"[inject] ERROR: 规则文件不存在: {REFERENCE_FILE}")
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
        print(f"[inject] SKIP: {skill_dir.name} 已包含禁止AI水印规则")
        return False

    # 优先：OCR引用之后
    match = re.search(INJECT_AFTER_OCR, content)
    inject_after = "OCR能力引用"
    if not match:
        # 备用1：技术栈引用之后
        match = re.search(INJECT_AFTER_TECH, content)
        inject_after = "技术栈引用"
    if not match:
        # 备用2：合规红线之前
        match = re.search(FALLBACK_PATTERN, content, re.MULTILINE)
        inject_after = "合规红线之前"
    if not match:
        print(f"[inject] WARN: {skill_dir.name} 未找到注入锚点，跳过")
        return False

    if dry_run:
        print(f"[inject] DRY-RUN: 将在 {skill_dir.name} 的「{inject_after}」之后注入禁止AI水印规则")
        return True

    new_content = (
        content[:match.end()]
        + "\n\n"
        + reference_content.strip()
        + "\n"
        + content[match.end():]
    )
    skill_md.write_text(new_content, encoding='utf-8')
    print(f"[inject] ✓ {skill_dir.name}: 禁止AI水印规则已注入（位置：{inject_after}之后）")
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
    print(f"[remove] ✓ {skill_dir.name}: 禁止AI水印规则已移除")
    return True


def main():
    parser = argparse.ArgumentParser(description='批量注入禁止AI水印规则到gxtz技能')
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
