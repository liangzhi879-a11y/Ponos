#!/usr/bin/env python
"""Convert TRAE skill definitions to Claude Code format."""
import os, re, shutil, json

SRC_BASE = r"C:/Users/T203-15/.trae-cn/skills/enterprise_project_skills"
DST_BASE = r"C:/Users/T203-15/Desktop/2023guogao/{{YFW_SKILLS}}"

# Skill mapping: (source_dir, dest_filename, triggers)
SKILLS = [
    ("gxtz-info-collector", "gxtz-info-collector.md", [
        "高新认定", "高企认定", "高新技术企业", "信息收集", "资料清单", "企业信息调查", "资料收集", "材料清单"
    ]),
    ("gxtz-management-materials", "gxtz-management-materials.md", [
        "管理制度", "研发制度", "研发机构", "产学研合作", "成果转化激励", "研发辅助账", "研发费用台账"
    ]),
    ("gxtz-audit-verification", "gxtz-audit-verification.md", [
        "专审报告核对", "审计核对", "研发费用专审", "高新收入专审", "审计报告核对", "专审核对"
    ]),
    ("gxtz-invoice-ps-matching", "gxtz-invoice-ps-matching.md", [
        "发票PS筛选", "PS匹配", "全量发票", "高新收入发票", "发票匹配", "PS发票"
    ]),
    ("gxtz-contract-review", "gxtz-contract-review.md", [
        "技术合同审查", "合同评估", "合同合规", "技术开发合同", "技术转让合同", "合同认定登记", "合同审查"
    ]),
    ("gxtz-wecom-collector", "gxtz-wecom-collector.md", [
        "企微", "企业微信", "wecom", "企业微信会话", "企微附件", "企微文件", "客户沟通记录", "企业微信资料"
    ]),
    ("gxtz-submission-packager", "gxtz-submission-packager.md", [
        "打包", "申报打包", "材料打包", "上传准备", "提交材料", "最终版本", "申报包", "提交系统", "申报系统要求"
    ]),
]

PATH_REPLACEMENTS = [
    (r"C:\\Users\\T203-15\\.trae-cn\\skills\\enterprise_project_skills\\_common\\", "{{YFW_SKILLS}}/_common/"),
    (r"C:\\Users\\T203-15\\.trae-cn\\skills\\enterprise_project_skills\\", "{{YFW_SKILLS}}/"),
    (r"C:\\Users\\T203-15\\.trae-cn\\skills\\", "{{YFW_SKILLS}}/"),
    (r".trae/skills/_common/", "{{YFW_SKILLS}}/_common/"),
    (r".trae/skills/", "{{YFW_SKILLS}}/"),
    (r".trae/", ".claude/"),
    # Windows line continuation
    (r" ^\n", r" \\\n"),
    (r" ^\r\n", r" \\\n"),
    # Fix duplicate forward slashes that might result
    (".claude//", ".claude/"),
]

def fix_frontmatter(content, triggers):
    """Add triggers to frontmatter, ensure Claude Code format."""
    # Find frontmatter boundaries
    lines = content.split('\n')
    if lines[0].strip() != '---':
        return content  # No frontmatter

    # Find end of frontmatter
    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == '---':
            end_idx = i
            break

    if end_idx is None:
        return content

    # Parse existing frontmatter
    fm_lines = lines[1:end_idx]
    has_triggers = any('triggers:' in l for l in fm_lines)

    if not has_triggers:
        # Insert triggers before the closing ---
        trigger_yaml = "triggers:\n" + "\n".join(f"  - \"{t}\"" for t in triggers)
        insert_idx = end_idx
        new_lines = lines[:insert_idx] + [trigger_yaml] + lines[insert_idx:]
        content = '\n'.join(new_lines)

    return content

def apply_path_replacements(content):
    """Apply all path replacements."""
    for old, new in PATH_REPLACEMENTS:
        content = content.replace(old, new)
    # Also handle the case where absolute Windows paths use different separators
    content = re.sub(
        r'C:\\Users\\T203-15\\.trae-cn\\skills\\enterprise_project_skills\\_common\\',
        '{{YFW_SKILLS}}/_common/',
        content
    )
    content = re.sub(
        r'C:\\Users\\T203-15\\.trae-cn\\skills\\enterprise_project_skills\\',
        '{{YFW_SKILLS}}/',
        content
    )
    return content

def replace_tool_references(content):
    """Replace TRAE-specific tool references with Claude Code equivalents."""
    replacements = [
        ("RunCommand", "Bash"),
        ("TRAE agent", "Claude Code agent"),
        ("TRAE", "Claude Code"),
    ]
    # Be careful with "TRAE" - only replace in tool/platform context, not in technical terms
    # Only replace standalone "TRAE" references, not in paths or URLs
    content = content.replace(" RunCommand ", " Bash ")
    content = content.replace("RunCommand", "Bash")
    # Replace TRAE agent references
    content = content.replace("TRAE agent", "Claude Code agent")
    content = content.replace("（由 TRAE agent 完成）", "（由 agent 完成）")
    return content

def convert_file(src_dir, dest_filename, triggers):
    """Convert a single skill file."""
    src_path = os.path.join(src_dir, "SKILL.md")
    if not os.path.exists(src_path):
        # Try reading from src base directly
        src_path = os.path.join(SRC_BASE, os.path.basename(src_dir), "SKILL.md")

    if not os.path.exists(src_path):
        print(f"ERROR: Source not found: {src_path}")
        return

    with open(src_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Apply path replacements
    content = apply_path_replacements(content)

    # Replace tool references
    content = replace_tool_references(content)

    # Fix frontmatter
    content = fix_frontmatter(content, triggers)

    # Write destination
    dest_path = os.path.join(DST_BASE, dest_filename)
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with open(dest_path, 'w', encoding='utf-8') as f:
        f.write(content)

    # Stats
    line_count = len(content.split('\n'))
    print(f"Converted: {src_path} -> {dest_path} ({line_count} lines)")

def main():
    # Check destination exists
    os.makedirs(DST_BASE, exist_ok=True)

    # Process each skill
    for skill_dir, dest_filename, triggers in SKILLS:
        src_full = os.path.join(SRC_BASE, skill_dir)
        if not os.path.exists(src_full):
            print(f"WARNING: Source dir not found: {src_full}")
            continue
        convert_file(src_full, dest_filename, triggers)

if __name__ == "__main__":
    main()
