#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""权威术语核验 + 溯源核验 规则注入脚本 v2.7

注入两层核验规则到各技能 SKILL.md：
  1. 权威术语强制核验（v2.6） — authoritative_terms.json 静态术语库
  2. 溯源核验（v2.7新增）     — provenance 源文件值比对
"""

import os
import re
import sys

SKILLS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMMON_DIR = os.path.dirname(os.path.abspath(__file__))

# 读取两个参考文件
TERMS_REF = os.path.join(COMMON_DIR, '_authoritative_terms_reference.md')
PROV_REF = os.path.join(COMMON_DIR, '_provenance_reference.md')

if not os.path.exists(TERMS_REF):
    print(f'[ERROR] 文件不存在: {TERMS_REF}')
    sys.exit(1)
if not os.path.exists(PROV_REF):
    print(f'[ERROR] 文件不存在: {PROV_REF}')
    sys.exit(1)

with open(TERMS_REF, 'r', encoding='utf-8') as f:
    terms_content = f.read()
with open(PROV_REF, 'r', encoding='utf-8') as f:
    prov_content = f.read()

# 构建注入章节
INJECT_SECTION = f"""

---

<!-- SECTION_BEGIN: provenance_verification v2.7 -->
## 溯源核验 — 以源文件值为基准（v2.7 - 强制）

{prov_content}
<!-- SECTION_END: provenance_verification -->

---

<!-- SECTION_BEGIN: authoritative_terms_verification v2.6 -->
## 权威术语强制核验（v2.6 - 强制）

{terms_content}
<!-- SECTION_END: authoritative_terms_verification -->
"""

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

for skill_name in TARGET_SKILLS:
    skill_md = os.path.join(SKILLS_DIR, skill_name, 'SKILL.md')
    if not os.path.exists(skill_md):
        print(f'[SKIP] {skill_name}/SKILL.md 不存在')
        continue

    with open(skill_md, 'r', encoding='utf-8') as f:
        content = f.read()

    # 移除旧版 SECTION（如果存在）
    old_v26_start = '<!-- SECTION_BEGIN: authoritative_terms_verification v2.6 -->'
    old_v26_end = '<!-- SECTION_END: authoritative_terms_verification -->'
    old_v27_start = '<!-- SECTION_BEGIN: provenance_verification v2.7 -->'
    old_v27_end = '<!-- SECTION_END: provenance_verification -->'

    # 移除旧版 authoritative_terms section
    if old_v26_start in content:
        start = content.find(old_v26_start)
        end = content.find(old_v26_end)
        if end >= 0:
            end += len(old_v26_end)
            # 也移除前面的 --- 分隔符
            prefix_start = max(0, start - 7)
            if content[prefix_start:start].strip() == '---':
                start = prefix_start
            content = content[:start] + content[end:]

    # 移除旧版 provenance section
    if old_v27_start in content:
        start = content.find(old_v27_start)
        end = content.find(old_v27_end)
        if end >= 0:
            end += len(old_v27_end)
            prefix_start = max(0, start - 7)
            if content[prefix_start:start].strip() == '---':
                start = prefix_start
            content = content[:start] + content[end:]

    # 追加新的双层核验章节
    content = content.rstrip() + '\n' + INJECT_SECTION

    with open(skill_md, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'[INJECT] {skill_name}/SKILL.md - 已注入双层核验规则（provenance + authoritative_terms）')

print(f'\n[DONE] 9 个技能注入完成')
