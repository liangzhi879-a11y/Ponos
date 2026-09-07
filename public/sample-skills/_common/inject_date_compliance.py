#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
inject_date_compliance.py - 将日期合规规则注入到 gxtz-achievement-materials 的 SKILL.md

注入位置：在 "## 执行顺序契约" 之前（与交叉验证协议同级）
仅注入到 gxtz-achievement-materials（其他技能不需要此规则）

用法：
  python inject_date_compliance.py              # 注入
  python inject_date_compliance.py --dry-run    # 预览
  python inject_date_compliance.py --remove     # 移除
"""

import argparse
import re
import sys
from pathlib import Path

SKILLS_DIR = Path(__file__).parent.parent
COMMON_DIR = Path(__file__).parent
RULES_FILE = COMMON_DIR / "_date_compliance_rules.md"

BEGIN_MARKER = "<!-- SECTION_BEGIN: date_compliance_rules -->"
END_MARKER = "<!-- SECTION_END: date_compliance_rules -->"

INJECT_BEFORE_PATTERN = r'^## 执行顺序契约'
FALLBACK_PATTERN = r'^## 合规红线'

TARGET_SKILL = "gxtz-achievement-materials"


def load_rules():
    if not RULES_FILE.exists():
        print(f"[inject] ERROR: 规则文件不存在: {RULES_FILE}")
        return None
    return RULES_FILE.read_text(encoding='utf-8')


def has_rules(content):
    return BEGIN_MARKER in content and END_MARKER in content


def inject(dry_run=False):
    skill_dir = SKILLS_DIR / TARGET_SKILL
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        print(f"[inject] ERROR: {skill_md} 不存在")
        return False

    content = skill_md.read_text(encoding='utf-8')
    if has_rules(content):
        print(f"[inject] SKIP: {TARGET_SKILL} 已包含日期合规规则")
        return False

    rules_content = load_rules()
    if not rules_content:
        return False

    match = re.search(INJECT_BEFORE_PATTERN, content, re.MULTILINE)
    inject_before = "执行顺序契约"
    if not match:
        match = re.search(FALLBACK_PATTERN, content, re.MULTILINE)
        inject_before = "合规红线"
    if not match:
        print(f"[inject] WARN: 未找到注入锚点")
        return False

    if dry_run:
        print(f"[inject] DRY-RUN: 将在 {TARGET_SKILL} 的「{inject_before}」之前注入日期合规规则")
        return True

    new_content = (
        content[:match.start()]
        + rules_content.strip()
        + "\n\n"
        + content[match.start():]
    )
    skill_md.write_text(new_content, encoding='utf-8')
    print(f"[inject] ✓ {TARGET_SKILL}: 日期合规规则已注入")
    return True


def remove():
    skill_dir = SKILLS_DIR / TARGET_SKILL
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return False

    content = skill_md.read_text(encoding='utf-8')
    if not has_rules(content):
        print(f"[remove] SKIP: {TARGET_SKILL} 未包含日期合规规则")
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
    print(f"[remove] ✓ {TARGET_SKILL}: 日期合规规则已移除")
    return True


def main():
    parser = argparse.ArgumentParser(description='注入日期合规规则到gxtz-achievement-materials')
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--remove", action="store_true")
    args = parser.parse_args()

    if args.remove:
        success = remove()
    else:
        success = inject(args.dry_run)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
