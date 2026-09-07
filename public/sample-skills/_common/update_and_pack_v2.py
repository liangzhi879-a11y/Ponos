"""批量更新版本清单和打包 zip（自主确认机制版本）"""
import os
import sys
import json
import shutil
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from path_config import get_skills_dir_str

SKILLS_DIR = get_skills_dir_str()
VERSIONS_DIR = os.path.join(SKILLS_DIR, '_versions')

VERSION_UPGRADES = {
    'gxtz-core-tables': {'from': '1.17.0', 'to': '1.18.0'},
    'gxtz-info-collector': {'from': '1.17.0', 'to': '1.18.0'},
    'gxtz-ip-materials': {'from': '1.14.0', 'to': '1.15.0'},
    'gxtz-achievement-materials': {'from': '1.14.0', 'to': '1.15.0'},
    'gxtz-ps-materials': {'from': '1.14.0', 'to': '1.15.0'},
    'gxtz-staff-materials': {'from': '1.14.0', 'to': '1.15.0'},
    'gxtz-management-materials': {'from': '1.14.0', 'to': '1.15.0'},
    'gxtz-rd-report': {'from': '1.14.0', 'to': '1.15.0'},
    'gxtz-contract-review': {'from': '0.0.0', 'to': '1.0.0'},
}

CHANGELOG_ENTRY = """### v{new_version} - {date}

**新增自主确认机制：agent 自主分辨能力，遇异常主动暂停确认。**

本次升级解决"agent 遇到资料不全、数据冲突等情况时自行决定后继续，导致输出质量不达标"的问题。

新增内容：
1. **5 个判断原则**：数据一致性、完整性、推断性、异常性、质量保证
2. **4 类触发条件**：A 类数据源冲突、B 类格式异常、C 类关键推断、D 类资料缺失
3. **每步自问速查**：5 个问题，任一答案为"是"立即暂停
4. **确认对话格式规范**：问题描述 → 方案对比 → 推荐方案 → 等待确认
5. **5 条禁止行为**：禁止自行决定数据源、禁止自行做假设、禁止事后告知、禁止模糊确认、禁止假设同意
6. **自主分辨能力要点**：场景无关、数据驱动、主动识别、动态适应、质量导向

核心区别：本机制不是预设问题清单，而是赋予 agent 自主分辨能力，适应任何新情况。

### v{old_version} - （历史版本）
"""

def update_changelog(skill_name, old_version, new_version):
    """更新 CHANGELOG.md"""
    changelog_path = os.path.join(SKILLS_DIR, skill_name, 'CHANGELOG.md')
    date = datetime.now().strftime('%Y-%m-%d')
    entry = CHANGELOG_ENTRY.format(new_version=new_version, old_version=old_version, date=date)

    with open(changelog_path, 'r', encoding='utf-8') as f:
        content = f.read()

    if content.startswith('# 变更日志'):
        content = content.replace('# 变更日志\n', f'# 变更日志\n\n{entry}', 1)
    else:
        content = f'# 变更日志\n\n{entry}\n' + content

    with open(changelog_path, 'w', encoding='utf-8') as f:
        f.write(content)

def update_manifest(skill_name, old_version, new_version):
    """更新 _version_manifest.json"""
    manifest_path = os.path.join(SKILLS_DIR, '_version_manifest.json')
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)

    if skill_name not in manifest['skills']:
        return False

    skill_info = manifest['skills'][skill_name]
    if 'history' not in skill_info:
        skill_info['history'] = []

    skill_info['history'].insert(0, {
        'version': old_version,
        'date': skill_info.get('last_updated', '2026-07-14'),
        'change': skill_info.get('last_change', '')[:200] + '...' if len(skill_info.get('last_change', '')) > 200 else skill_info.get('last_change', ''),
    })
    skill_info['history'] = skill_info['history'][:5]

    skill_info['current_version'] = new_version
    skill_info['last_updated'] = datetime.now().strftime('%Y-%m-%d')
    skill_info['last_change'] = (
        '新增自主确认机制：5个判断原则+4类触发条件+每步自问+确认对话格式+5条禁止行为。'
        '赋予agent自主分辨能力，遇资料不全/数据冲突/关键推断/格式异常时主动暂停确认，'
        '而非自行决定后继续。区别于预设问题清单，本机制场景无关、数据驱动、主动识别、动态适应。'
    )

    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return True

def pack_skill(skill_name, new_version, old_zip_name):
    """打包技能 zip 并归档旧版本"""
    import subprocess
    skill_dir = os.path.join(SKILLS_DIR, skill_name)
    staging = os.path.join(os.environ.get('TEMP', '/tmp'), f'pack_{skill_name}')

    if os.path.exists(staging):
        shutil.rmtree(staging)
    os.makedirs(staging, exist_ok=True)

    # 复制 SKILL.md, CHANGELOG.md, policy_shenzhen.json
    for fname in ['SKILL.md', 'CHANGELOG.md', 'policy_shenzhen.json']:
        src = os.path.join(skill_dir, fname)
        if os.path.exists(src):
            shutil.copy2(src, staging)

    # 打包
    out_zip = os.path.join(SKILLS_DIR, f'{skill_name}-v{new_version}.zip')
    if os.path.exists(out_zip):
        os.remove(out_zip)

    # 使用 PowerShell Compress-Archive
    ps_cmd = f'Compress-Archive -Path "{staging}\\*" -DestinationPath "{out_zip}" -CompressionLevel Optimal'
    subprocess.run(['powershell', '-Command', ps_cmd], check=True, capture_output=True)

    shutil.rmtree(staging)

    # 归档旧版本
    old_zip_path = os.path.join(SKILLS_DIR, old_zip_name)
    if os.path.exists(old_zip_path):
        shutil.move(old_zip_path, os.path.join(VERSIONS_DIR, old_zip_name))
        return True, '归档'
    return True, '旧版本已在_versions/'


def main():
    print('=' * 60)
    print('版本清单更新 + 打包归档')
    print('=' * 60)

    for skill_name, versions in VERSION_UPGRADES.items():
        old_v = versions['from']
        new_v = versions['to']
        old_zip = f'{skill_name}-v{old_v}.zip'

        print(f'\n{skill_name}: {old_v} → {new_v}')

        # 更新 CHANGELOG
        update_changelog(skill_name, old_v, new_v)
        print(f'  ✅ CHANGELOG.md 已更新')

        # 更新 _version_manifest.json
        update_manifest(skill_name, old_v, new_v)
        print(f'  ✅ _version_manifest.json 已更新')

        # 打包
        try:
            success, msg = pack_skill(skill_name, new_v, old_zip)
            if success:
                print(f'  ✅ 打包完成（{msg}）')
        except Exception as e:
            print(f'  ❌ 打包失败: {e}')

    print('\n' + '=' * 60)
    print('全部完成')
    print('=' * 60)


if __name__ == '__main__':
    main()
