"""
push_skill_updates.py - 技能变更一键推送 v1.0

自动将当前项目的技能变更同步到C盘仓库并推送到GitHub。

流程：
  1. 对比 项目.trae/skills/ 与 C盘仓库，找出变更文件
  2. 将变更文件复制到C盘仓库
  3. git add + commit + push
  4. 输出变更摘要

用法：
  python push_skill_updates.py              # 交互模式，预览后确认提交
  python push_skill_updates.py --dry-run    # 仅预览，不执行
  python push_skill_updates.py --yes        # 跳过确认，直接提交

解决痛点：
  此前修改 SKILL.md / experience.json 后需要手动复制到C盘仓库再 git push，
  本脚本一次完成所有步骤。
"""

import os
import sys
import shutil
import json
import hashlib
import subprocess
import argparse
from pathlib import Path
from datetime import datetime

REPO_DIR = Path(r"C:\Users\T203-15\.trae-cn\skills\enterprise_project_skills")
_project_root = None

SYNCABLE_FILES = ["SKILL.md", "experience.json", "CHANGELOG.md", "policy_shenzhen.json"]
SYNCABLE_DIRS = ["_common"]


def file_md5(path):
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def find_project_skill_dirs():
    """扫描项目下所有技能目录"""
    dirs = []
    skills_dir = Path(_project_root) / ".trae" / "skills"
    if not skills_dir.exists():
        return dirs
    for d in sorted(skills_dir.iterdir()):
        if d.is_dir() and d.name.startswith("gxtz-"):
            dirs.append(d)
    return dirs


def scan_changes(dry_run=True):
    """扫描变更：对比项目目录与C盘仓库"""
    changes = []
    skill_dirs = find_project_skill_dirs()

    for proj_dir in skill_dirs:
        skill_name = proj_dir.name
        repo_dir = REPO_DIR / skill_name

        for fname in SYNCABLE_FILES:
            proj_file = proj_dir / fname
            repo_file = repo_dir / fname

            if not proj_file.exists():
                continue

            proj_hash = file_md5(proj_file)
            if repo_file.exists():
                repo_hash = file_md5(repo_file)
                if proj_hash == repo_hash:
                    continue
                change_type = "modified"
            else:
                change_type = "new"

            changes.append({
                "skill": skill_name,
                "file": fname,
                "type": change_type,
                "src": str(proj_file),
                "dst": str(repo_file),
                "size": proj_file.stat().st_size,
            })

    # _common 目录
    proj_common = Path(_project_root) / ".trae" / "skills" / "_common"
    repo_common = REPO_DIR / "_common"
    if proj_common.exists():
        for f in sorted(proj_common.iterdir()):
            if f.is_dir():
                continue
            proj_hash = file_md5(f)
            repo_file = repo_common / f.name
            if repo_file.exists():
                repo_hash = file_md5(repo_file)
                if proj_hash == repo_hash:
                    continue
                change_type = "modified"
            else:
                change_type = "new"

            changes.append({
                "skill": "_common",
                "file": f.name,
                "type": change_type,
                "src": str(f),
                "dst": str(repo_file),
                "size": f.stat().st_size,
            })

    return changes


def print_changes(changes):
    if not changes:
        print("✓ 无变更，项目技能与仓库一致。")
        return

    print(f"\n发现 {len(changes)} 个文件变更:\n")
    print(f"{'类型':8} {'技能':30} {'文件':25} {'大小':>8}")
    print("-" * 75)
    for c in changes:
        size_kb = c["size"] / 1024
        print(f"{c['type']:8} {c['skill']:30} {c['file']:25} {size_kb:>7.1f}KB")


def apply_changes(changes):
    """复制文件到C盘仓库"""
    ok = 0
    fail = 0
    for c in changes:
        try:
            os.makedirs(os.path.dirname(c["dst"]), exist_ok=True)
            shutil.copy2(c["src"], c["dst"])
            ok += 1
        except Exception as e:
            print(f"  ✗ 复制失败 {c['skill']}/{c['file']}: {e}")
            fail += 1
    return ok, fail


def git_commit_and_push(commit_msg=None):
    """在C盘仓库执行 git add + commit + push"""
    if commit_msg is None:
        commit_msg = f"chore: sync skill updates ({datetime.now().strftime('%Y-%m-%d %H:%M')})"

    try:
        subprocess.run(["git", "add", "-A"], cwd=str(REPO_DIR),
                       check=True, capture_output=True, text=True)

        result = subprocess.run(["git", "diff", "--cached", "--stat"],
                                cwd=str(REPO_DIR), capture_output=True, text=True)
        if result.stdout.strip():
            print(f"\n变更统计:\n{result.stdout}")

        result = subprocess.run(
            ["git", "commit", "-m", commit_msg],
            cwd=str(REPO_DIR), capture_output=True, text=True
        )
        if result.returncode == 0:
            print(f"✓ 提交成功: {result.stdout.strip()}")
        elif "nothing to commit" in result.stdout + result.stderr:
            print("○ 无内容需提交")
            return True
        else:
            print(f"✗ 提交失败: {result.stderr}")
            return False

        result = subprocess.run(
            ["git", "push", "origin", "main"],
            cwd=str(REPO_DIR), capture_output=True, text=True
        )
        if result.returncode == 0:
            print("✓ 推送成功")
            return True
        else:
            print(f"✗ 推送失败: {result.stderr}")
            return False

    except subprocess.CalledProcessError as e:
        print(f"✗ Git操作失败: {e}")
        return False
    except FileNotFoundError:
        print("✗ 未找到git命令，请确认git已安装且在PATH中")
        return False


def main():
    parser = argparse.ArgumentParser(description="技能变更一键推送到GitHub")
    parser.add_argument("--dry-run", action="store_true", help="仅预览变更，不执行")
    parser.add_argument("--yes", "-y", action="store_true", help="跳过确认，直接执行")
    parser.add_argument("--message", "-m", help="自定义commit信息")
    parser.add_argument("--project-root", default=None, help="项目根目录（默认：当前目录）")
    args = parser.parse_args()

    global _project_root
    if args.project_root:
        _project_root = args.project_root
    else:
        _project_root = os.getcwd()

    print("=" * 60)
    print("  技能变更一键推送")
    print(f"  项目: {_project_root}")
    print(f"  仓库: {REPO_DIR}")
    print("=" * 60)

    # 1. 扫描变更
    changes = scan_changes()
    print_changes(changes)

    if not changes:
        return 0

    if args.dry_run:
        print("\n[dry-run 模式，未执行实际操作]")
        return 0

    # 2. 确认
    if not args.yes:
        resp = input("\n确认提交并推送这些变更? [y/N]: ").strip().lower()
        if resp not in ("y", "yes"):
            print("已取消。")
            return 0

    # 3. 复制文件
    print("\n正在同步文件到仓库...")
    ok, fail = apply_changes(changes)
    if fail > 0:
        print(f"⚠ {fail} 个文件复制失败，请手动检查")
        if ok == 0:
            return 1
    print(f"✓ {ok} 个文件已同步")

    # 4. Git提交推送
    print("\n正在提交到Git仓库...")
    commit_msg = args.message or f"chore: sync skill updates ({datetime.now().strftime('%Y-%m-%d %H:%M')})"
    success = git_commit_and_push(commit_msg)

    if success:
        print("\n" + "=" * 60)
        print("  ✓ 全部完成！")
        print("  其他项目运行 sync_version.py --sync 即可拉取更新")
        print("=" * 60)
    else:
        print("\n⚠ 部分步骤失败，请检查上述错误信息")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
