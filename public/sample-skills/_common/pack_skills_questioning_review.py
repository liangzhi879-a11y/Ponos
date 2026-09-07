"""批量打包 gxtz-* 技能为带版本号的 zip 文件（v1.0 - 2026-07-14）

功能：
  1. 自动发现 skills 目录下所有 gxtz-* 技能目录
  2. 从每个 SKILL.md 读取 version 字段
  3. 归档旧版 zip 到 _versions/ 目录
  4. 创建新 zip：gxtz-{name}-v{version}.zip
     - 包含 SKILL.md 和 CHANGELOG.md（如存在）
     - 输出到 skills/ 目录

用法：
  python pack_skills_questioning_review.py --skills-dir "C:\\path\\to\\skills"
  python pack_skills_questioning_review.py --skills-dir "C:\\path\\to\\skills" --dry-run
"""
import os
import re
import argparse
import zipfile
import shutil
from pathlib import Path


def get_skill_version(skill_md_path):
    """从 SKILL.md 读取 version 字段"""
    with open(skill_md_path, 'r', encoding='utf-8') as f:
        content = f.read()
    match = re.search(r'^version:\s*"?(\d+\.\d+\.\d+)"?', content, re.MULTILINE)
    if match:
        return match.group(1)
    return '1.0.0'


def archive_old_zips(skills_dir, skill_name, new_zip_name, versions_dir):
    """归档旧版 zip 到 _versions/ 目录"""
    if not os.path.exists(versions_dir):
        os.makedirs(versions_dir, exist_ok=True)

    pattern = f'{skill_name}-v'
    archived = []
    for entry in os.listdir(skills_dir):
        if (entry.startswith(pattern)
                and entry.endswith('.zip')
                and entry != new_zip_name):
            src = os.path.join(skills_dir, entry)
            dst = os.path.join(versions_dir, entry)
            if os.path.exists(dst):
                os.remove(dst)
            shutil.move(src, dst)
            archived.append(entry)
    return archived


def create_zip(zip_path, skill_dir):
    """创建 zip 文件，包含 SKILL.md 和 CHANGELOG.md"""
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        skill_md = os.path.join(skill_dir, 'SKILL.md')
        if os.path.exists(skill_md):
            zf.write(skill_md, 'SKILL.md')

        changelog_md = os.path.join(skill_dir, 'CHANGELOG.md')
        if os.path.exists(changelog_md):
            zf.write(changelog_md, 'CHANGELOG.md')

        # 包含 policy_shenzhen.json（如存在）
        policy_json = os.path.join(skill_dir, 'policy_shenzhen.json')
        if os.path.exists(policy_json):
            zf.write(policy_json, 'policy_shenzhen.json')


def discover_skill_dirs(skills_dir):
    """发现所有 gxtz-* 技能目录"""
    skills_path = Path(skills_dir)
    skill_dirs = []
    for entry in sorted(skills_path.iterdir()):
        if entry.is_dir() and entry.name.startswith('gxtz-'):
            if (entry / 'SKILL.md').exists():
                skill_dirs.append(str(entry))
    return skill_dirs


def main():
    parser = argparse.ArgumentParser(
        description='批量打包 gxtz-* 技能为带版本号的 zip 文件'
    )
    parser.add_argument(
        '--skills-dir',
        required=True,
        help='skills 目录的绝对路径',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='试运行模式：只输出计划，不创建/移动文件',
    )
    args = parser.parse_args()

    skills_dir = args.skills_dir
    versions_dir = os.path.join(skills_dir, '_versions')

    print('=' * 70)
    print('批量打包 gxtz-* 技能 zip')
    print(f'skills 目录：{skills_dir}')
    print(f'归档目录：{versions_dir}')
    print(f'试运行：{"是" if args.dry_run else "否"}')
    print('=' * 70)

    skill_dirs = discover_skill_dirs(skills_dir)
    if not skill_dirs:
        print('未发现任何 gxtz-* 技能目录')
        return

    print(f'发现 {len(skill_dirs)} 个技能：')
    for sd in skill_dirs:
        print(f'  - {os.path.basename(sd)}')

    print('\n' + '-' * 70)
    print('开始打包...')
    print('-' * 70)

    results = []
    for skill_dir in skill_dirs:
        skill_name = os.path.basename(skill_dir)
        skill_md_path = os.path.join(skill_dir, 'SKILL.md')
        version = get_skill_version(skill_md_path)
        zip_name = f'{skill_name}-v{version}.zip'
        zip_path = os.path.join(skills_dir, zip_name)

        print(f'\n处理 {skill_name} (v{version}) ...')

        # 归档旧版 zip
        archived = archive_old_zips(skills_dir, skill_name, zip_name, versions_dir)
        if archived:
            for a in archived:
                print(f'  归档旧版：{a} -> _versions/')

        # 创建新 zip
        if not args.dry_run:
            if os.path.exists(zip_path):
                os.remove(zip_path)
            create_zip(zip_path, skill_dir)
            size = os.path.getsize(zip_path)
            print(f'  ✅ 创建 {zip_name} ({size} bytes)')
        else:
            print(f'  [dry-run] 将创建 {zip_name}')

        results.append({
            'skill': skill_name,
            'version': version,
            'zip_name': zip_name,
            'zip_path': zip_path,
            'archived': archived,
        })

    # 汇总
    print('\n' + '=' * 70)
    print('打包汇总')
    print('=' * 70)
    print(f'{"技能":<35} {"版本":>10} {"zip 文件":>40}')
    print('-' * 90)
    for r in results:
        print(f'{r["skill"]:<35} {r["version"]:>10} {r["zip_name"]:>40}')
    print('-' * 90)
    print(f'总计：{len(results)} 个技能已打包')
    if args.dry_run:
        print('（试运行模式，未实际创建文件）')
    print()


if __name__ == '__main__':
    main()
