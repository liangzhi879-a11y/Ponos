#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""权威术语核验规则注入脚本

将 _authoritative_terms_reference.md 注入到各技能 SKILL.md 中，
在隐患自查章节后追加权威术语核验规则。
"""

import os
import re
import sys

SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 上一级 = skills/
COMMON_DIR = os.path.dirname(os.path.abspath(__file__))

REFERENCE_FILE = os.path.join(COMMON_DIR, '_authoritative_terms_reference.md')
if not os.path.exists(REFERENCE_FILE):
    print(f'[ERROR] 引用文件不存在: {REFERENCE_FILE}')
    sys.exit(1)

with open(REFERENCE_FILE, 'r', encoding='utf-8') as f:
    reference_content = f.read()

# 封装为可注入的 SKILL.md 章节
INJECT_SECTION = f"""

---

<!-- SECTION_BEGIN: authoritative_terms_verification v2.6 -->
## 权威术语强制核验（v2.6 - 强制）

{reference_content}
<!-- SECTION_END: authoritative_terms_verification -->
"""

# 需要注入的技能目录
TARGET_SKILLS = [
    'gxtz-core-tables',
    'gxtz-rd-report',
    'gxtz-ps-materials',
    'gxtz-achievement-materials',
    'gxtz-ip-materials',
    'gxtz-staff-materials',
    'gxtz-info-collector',
    'gxtz-management-materials',
    'gxtz-audit-verification',
]

ANCHOR_PATTERN = re.compile(
    r'(<!-- SECTION_END:\s*output_self_check.*?-->)',
    re.DOTALL
)

for skill_name in TARGET_SKILLS:
    skill_md = os.path.join(SKILLS_DIR, skill_name, 'SKILL.md')
    if not os.path.exists(skill_md):
        print(f'[SKIP] {skill_name}/SKILL.md 不存在')
        continue

    with open(skill_md, 'r', encoding='utf-8') as f:
        content = f.read()

    # 检查是否已注入
    if 'SECTION_BEGIN: authoritative_terms_verification' in content:
        # 已存在则替换
        start = content.find('<!-- SECTION_BEGIN: authoritative_terms_verification')
        end = content.find('<!-- SECTION_END: authoritative_terms_verification -->')
        if start >= 0 and end >= 0:
            end += len('<!-- SECTION_END: authoritative_terms_verification -->')
            content = content[:start] + INJECT_SECTION.strip() + content[end:]
            with open(skill_md, 'w', encoding='utf-8') as f:
                f.write(content)
            print(f'[REPLACE] {skill_name}/SKILL.md - 已更新权威术语核验章节')
    else:
        # 在隐患自检章节后注入
        match = ANCHOR_PATTERN.search(content)
        if match:
            insert_pos = match.end()
            content = content[:insert_pos] + '\n' + INJECT_SECTION + content[insert_pos:]
            with open(skill_md, 'w', encoding='utf-8') as f:
                f.write(content)
            print(f'[INJECT] {skill_name}/SKILL.md - 已注入权威术语核验章节')
        else:
            print(f'[WARN] {skill_name}/SKILL.md - 未找到锚点，追加到文件末尾')
            with open(skill_md, 'a', encoding='utf-8') as f:
                f.write('\n' + INJECT_SECTION)

print('\n[DONE] 权威术语核验规则注入完成')
