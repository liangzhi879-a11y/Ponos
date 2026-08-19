"""技能包版本批量升级脚本（v1.0 - 2026-07-14）

批量升级 8 个 gxtz-* 技能的版本号、CHANGELOG、_version_manifest.json
用于技能包重构后的版本归档

用法：
  python upgrade_versions.py --all --description "重构说明"
  python upgrade_versions.py --skill gxtz-core-tables --new-version 1.17.0
"""
import os
import re
import sys
import json
import argparse
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from path_config import get_skills_dir_str

SKILLS_DIR = get_skills_dir_str()

# 8 个技能的版本升级映射（MINOR 升级：功能新增）
VERSION_UPGRADES = {
    'gxtz-core-tables': {'from': '1.16.0', 'to': '1.17.0'},
    'gxtz-info-collector': {'from': '1.16.0', 'to': '1.17.0'},
    'gxtz-ip-materials': {'from': '1.13.0', 'to': '1.14.0'},
    'gxtz-achievement-materials': {'from': '1.13.0', 'to': '1.14.0'},
    'gxtz-ps-materials': {'from': '1.13.0', 'to': '1.14.0'},
    'gxtz-staff-materials': {'from': '1.13.0', 'to': '1.14.0'},
    'gxtz-management-materials': {'from': '1.13.0', 'to': '1.14.0'},
    'gxtz-rd-report': {'from': '1.13.0', 'to': '1.14.0'},
    'gxtz-contract-review': {'from': '0.0.0', 'to': '1.0.0'},
}

CHANGELOG_TEMPLATE = """### v{new_version} - {date}

**技能包重构：合规红线 + 执行顺序契约 + 审核验证标准 + 独立脚本抽取**。

本次重构解决 agent 不按技能要求执行的 6 大根因：
1. 指令形式错误（80% 是函数描述而非 RunCommand）
2. 文件膨胀（230-476KB，指令被淹没）
3. 放任兜底（21 处"自行编写等效代码"）
4. 执行顺序错乱（"第零步"出现在模块七之后）
5. 合规约束缺失（仅 1 处"禁止编造"声明）
6. 审核验证空壳（7/8 技能审核步骤无可执行脚本）

变更内容：
1. **删除内嵌代码**：移除"## 公共模块代码"章节，代码已抽取为 _common/ 下独立 .py 脚本
2. **添加合规红线**（置顶）：7 条禁止事项 + 数据来源优先级 + 无法确认时处理
3. **添加执行顺序契约**（置顶）：顺序执行、失败即停、不可并行、不可跳过审核
4. **添加审核验证标准**（置顶）：审核脚本调用、通过条件、失败处理、报告格式
5. **删除放任兜底**：所有"自行编写等效Python代码"替换为"立即停止，输出错误日志"
6. **修正步骤编号**："第零步"改为"第一步"
7. **删除模块错位插入**：模块七/八/九/十一在"## 指令"和"第一步"之间的错位内容已删除

新增独立脚本（_common/ 目录）：
- archive_extractor.py（模块一：压缩文件解压）
- knowledge_base.py（模块二：知识库共享）
- supplement_materials.py（模块五：补充资料机制）
- pdf_splitter.py（模块六：PDF拆分合并）
- policy_compliance.py（模块八：政策合规校验）
- enterprise_info_search.py（模块九：企业信息搜索）
- dify_workflow.py（模块十：Dify工作流集成）
- rd_ip_ps_matching.py（模块十一：RD-IP-PS匹配）

新增审核验证脚本（_common/ 目录）：
{validate_scripts}

文件大小变化：{old_size}KB → {new_size}KB（减少 {reduction}%）

### v{old_version} - （历史版本）
"""


def update_skill_md_version(skill_name, old_version, new_version):
    """更新 SKILL.md 中的版本号"""
    skill_md_path = os.path.join(SKILLS_DIR, skill_name, 'SKILL.md')
    with open(skill_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 替换 version: "x.y.z"
    old_pattern = f'version: "{old_version}"'
    new_pattern = f'version: "{new_version}"'
    if old_pattern in content:
        content = content.replace(old_pattern, new_pattern)
        with open(skill_md_path, 'w', encoding='utf-8') as f:
            f.write(content)
        return True
    else:
        # 尝试查找当前版本号
        match = re.search(r'version:\s*"(\d+\.\d+\.\d+)"', content)
        if match:
            current = match.group(1)
            content = content.replace(f'version: "{current}"', f'version: "{new_version}"')
            with open(skill_md_path, 'w', encoding='utf-8') as f:
                f.write(content)
            return True
    return False


def update_changelog(skill_name, old_version, new_version, old_size_kb, new_size_kb, validate_script):
    """在 CHANGELOG.md 顶部添加新版本记录"""
    changelog_path = os.path.join(SKILLS_DIR, skill_name, 'CHANGELOG.md')

    date = datetime.now().strftime('%Y-%m-%d')
    reduction = round((old_size_kb - new_size_kb) / old_size_kb * 100, 1)

    new_entry = CHANGELOG_TEMPLATE.format(
        new_version=new_version,
        old_version=old_version,
        date=date,
        validate_scripts=validate_script,
        old_size=old_size_kb,
        new_size=new_size_kb,
        reduction=reduction,
    )

    # 读取原文件
    with open(changelog_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 在"# 变更日志"后插入新条目
    if content.startswith('# 变更日志'):
        content = content.replace('# 变更日志\n', f'# 变更日志\n\n{new_entry}', 1)
    else:
        content = f'# 变更日志\n\n{new_entry}\n' + content

    with open(changelog_path, 'w', encoding='utf-8') as f:
        f.write(content)


def update_version_manifest(skill_name, old_version, new_version):
    """更新 _version_manifest.json 中的版本信息"""
    manifest_path = os.path.join(SKILLS_DIR, '_version_manifest.json')
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)

    if skill_name not in manifest['skills']:
        return False

    skill_info = manifest['skills'][skill_name]

    # 将当前版本移入历史
    if 'history' not in skill_info:
        skill_info['history'] = []

    skill_info['history'].insert(0, {
        'version': old_version,
        'date': skill_info.get('last_updated', '2026-07-13'),
        'change': skill_info.get('last_change', '')[:200] + '...' if len(skill_info.get('last_change', '')) > 200 else skill_info.get('last_change', ''),
    })

    # 保留最近 5 个历史版本
    skill_info['history'] = skill_info['history'][:5]

    # 更新当前版本
    skill_info['current_version'] = new_version
    skill_info['last_updated'] = datetime.now().strftime('%Y-%m-%d')
    skill_info['last_change'] = (
        '技能包重构：合规红线+执行顺序契约+审核验证标准+独立脚本抽取。'
        '删除内嵌代码（230-476KB→114-198KB），删除放任兜底，修正步骤编号。'
        '新增8个独立脚本（archive_extractor/knowledge_base/supplement_materials/pdf_splitter/'
        'policy_compliance/enterprise_info_search/dify_workflow/rd_ip_ps_matching）。'
        '新增7个审核验证脚本（validate_ip/achievement/ps/staff/management/rd_report/info_collector）。'
        '解决agent不按技能执行的6大根因。'
    )

    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    return True


def main():
    parser = argparse.ArgumentParser(description='批量升级技能包版本')
    parser.add_argument('--all', action='store_true', help='升级所有 8 个技能')
    parser.add_argument('--skill', type=str, help='升级指定技能')
    args = parser.parse_args()

    if args.all:
        upgrades = VERSION_UPGRADES
    elif args.skill:
        if args.skill in VERSION_UPGRADES:
            upgrades = {args.skill: VERSION_UPGRADES[args.skill]}
        else:
            print(f'未知技能: {args.skill}')
            return
    else:
        parser.print_help()
        return

    print('=' * 60)
    print('技能包版本批量升级')
    print('=' * 60)

    # 审核脚本映射
    validate_map = {
        'gxtz-core-tables': 'validate_tables.py',
        'gxtz-info-collector': 'validate_info_collector.py',
        'gxtz-ip-materials': 'validate_ip.py',
        'gxtz-achievement-materials': 'validate_achievement.py',
        'gxtz-ps-materials': 'validate_ps.py',
        'gxtz-staff-materials': 'validate_staff.py',
        'gxtz-management-materials': 'validate_management.py',
        'gxtz-rd-report': 'validate_rd_report.py',
    }

    for skill_name, versions in upgrades.items():
        old_v = versions['from']
        new_v = versions['to']

        print(f'\n升级 {skill_name}: {old_v} → {new_v}')

        # 获取文件大小
        skill_md_path = os.path.join(SKILLS_DIR, skill_name, 'SKILL.md')
        backup_path = os.path.join(SKILLS_DIR, '_backup_pre_rewrite', skill_name, 'SKILL.md')

        new_size_kb = round(os.path.getsize(skill_md_path) / 1024, 1)
        old_size_kb = round(os.path.getsize(backup_path) / 1024, 1) if os.path.exists(backup_path) else new_size_kb

        # 1. 更新 SKILL.md 版本号
        if update_skill_md_version(skill_name, old_v, new_v):
            print(f'  ✅ SKILL.md 版本号已更新')
        else:
            print(f'  ⚠️ SKILL.md 版本号未找到 {old_v}，尝试自动检测')

        # 2. 更新 CHANGELOG.md
        validate_script = f'- {validate_map[skill_name]}（{skill_name} 审核）'
        update_changelog(skill_name, old_v, new_v, old_size_kb, new_size_kb, validate_script)
        print(f'  ✅ CHANGELOG.md 已添加 v{new_v} 记录')

        # 3. 更新 _version_manifest.json
        if update_version_manifest(skill_name, old_v, new_v):
            print(f'  ✅ _version_manifest.json 已更新')

        print(f'  📊 文件大小: {old_size_kb}KB → {new_size_kb}KB')

    print('\n' + '=' * 60)
    print('版本升级完成')
    print('=' * 60)


if __name__ == '__main__':
    main()
