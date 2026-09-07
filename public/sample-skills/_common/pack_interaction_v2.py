"""pack_interaction_v2.py
================================================================
配套 upgrade_interaction_v2.py 的打包脚本：
- 对 10 个 gxtz-* 技能按新版本号打包 zip 到 skills 根目录
- 旧版本 zip 归档到 _versions/ 目录
- 包内容：SKILL.md + CHANGELOG.md + policy_shenzhen.json（若有）

使用方式：
    python pack_interaction_v2.py [--skills-dir <路径>] [--dry-run]
================================================================
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import zipfile
from pathlib import Path


# 10 个技能的版本映射（旧版本 → 新版本）
PACKAGES = [
    ("gxtz-achievement-materials", "1.15.2", "1.15.3"),
    ("gxtz-audit-verification", "1.0.2", "1.0.3"),
    ("gxtz-core-tables", "1.18.3", "1.18.4"),
    ("gxtz-info-collector", "1.18.2", "1.18.3"),
    ("gxtz-invoice-ps-matching", "1.0.2", "1.0.3"),
    ("gxtz-ip-materials", "1.15.2", "1.15.3"),
    ("gxtz-management-materials", "1.15.2", "1.15.3"),
    ("gxtz-ps-materials", "1.16.2", "1.16.3"),
    ("gxtz-rd-report", "1.15.2", "1.15.3"),
    ("gxtz-staff-materials", "1.15.2", "1.15.3"),
    ("gxtz-contract-review", "0.0.0", "1.0.0"),
]

# 打包时需包含的文件
PACK_FILES = ["SKILL.md", "CHANGELOG.md", "policy_shenzhen.json"]


def pack_skill(skills_dir: Path, versions_dir: Path, skill: str, old_v: str, new_v: str, dry_run: bool) -> dict:
    """打包单个技能 zip 并归档旧版本。"""
    skill_dir = skills_dir / skill
    new_zip = skills_dir / f"{skill}-v{new_v}.zip"
    old_zip_name = f"{skill}-v{old_v}.zip"
    old_zip_path = skills_dir / old_zip_name

    result = {
        "skill": skill,
        "old_version": old_v,
        "new_version": new_v,
        "new_zip_created": False,
        "old_zip_archived": False,
        "old_zip_status": "",
    }

    if dry_run:
        result["new_zip_created"] = True
        result["old_zip_archived"] = old_zip_path.exists()
        result["old_zip_status"] = "旧zip存在，将归档" if old_zip_path.exists() else "旧zip不在根目录"
        return result

    # 打包新 zip
    if new_zip.exists():
        new_zip.unlink()
    with zipfile.ZipFile(new_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in PACK_FILES:
            fpath = skill_dir / fname
            if fpath.exists():
                zf.write(fpath, fname)

    result["new_zip_created"] = new_zip.exists()

    # 归档旧版本
    if old_zip_path.exists():
        target = versions_dir / old_zip_name
        if target.exists():
            target.unlink()
        shutil.move(str(old_zip_path), str(target))
        result["old_zip_archived"] = True
        result["old_zip_status"] = "已归档到_versions/"
    else:
        result["old_zip_status"] = "旧zip不在根目录（可能已归档）"

    return result


def main():
    parser = argparse.ArgumentParser(description="打包 10 个 gxtz-* 技能 zip 并归档旧版本")
    parser.add_argument(
        "--skills-dir",
        default=None,
        help="技能根目录（默认基于 path_config 推断，可设置 GXTZ_SKILLS_DIR 环境变量覆盖）",
    )
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不实际打包")
    args = parser.parse_args()

    # 默认值通过 path_config 推断（v1.0.1 改造：移除硬编码个人路径）
    if args.skills_dir is None:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from path_config import get_skills_dir_str
        args.skills_dir = get_skills_dir_str()

    skills_dir = Path(args.skills_dir)
    versions_dir = skills_dir / "_versions"
    versions_dir.mkdir(exist_ok=True)

    print("=" * 70)
    print(f"批量打包技能 zip (dry_run={args.dry_run})")
    print(f"技能根目录: {skills_dir}")
    print(f"归档目录: {versions_dir}")
    print(f"待打包技能数: {len(PACKAGES)}")
    print("=" * 70)

    success_count = 0
    for skill, old_v, new_v in PACKAGES:
        try:
            r = pack_skill(skills_dir, versions_dir, skill, old_v, new_v, args.dry_run)
            print(
                f"[OK] {r['skill']}: v{r['old_version']} -> v{r['new_version']} | "
                f"新zip={r['new_zip_created']} | {r['old_zip_status']}"
            )
            success_count += 1
        except Exception as e:
            print(f"[失败] {skill}: {e}")

    print("=" * 70)
    print(f"汇总: 成功 {success_count} / 总计 {len(PACKAGES)}")
    print("=" * 70)
    return 0 if success_count == len(PACKAGES) else 2


if __name__ == "__main__":
    sys.exit(main())
