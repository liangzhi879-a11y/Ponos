"""
compare_skill_versions.py - 技能版本升级详情提取 v1.0.0

对比本地与远程之间变更的 SKILL.md，提取版本号的版本升级详情。

用法：
  python compare_skill_versions.py <local_ref> <remote_ref>
  python compare_skill_versions.py HEAD origin/main
  python compare_skill_versions.py HEAD FETCH_HEAD

输出：
  - 每个变更技能：技能名、旧版本→新版本、变更文件
  - _common 脚本变更
"""

import sys
import re
import subprocess
from pathlib import Path

SKILLS_ROOT = Path(__file__).resolve().parent


def run_git(args, timeout=30):
    try:
        result = subprocess.run(
            ["git"] + args,
            cwd=str(SKILLS_ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return -1, "", ""


def extract_version_from_file(file_content):
    """从 SKILL.md 内容提取 version 字段"""
    match = re.search(r'version:\s*"([\d.]+)"', file_content)
    if match:
        return match.group(1)
    return None


def get_file_at_ref(ref, filepath):
    """获取指定 git ref 下的文件内容"""
    code, stdout, _ = run_git(["show", f"{ref}:{filepath}"])
    if code == 0:
        return stdout
    return None


def get_changed_skills(local, remote):
    """获取在 remote 中相对于 local 有变更的 SKILL.md 文件"""
    code, stdout, _ = run_git(["diff", "--name-only", local, remote])
    if code != 0 or not stdout:
        return [], []

    all_changed = stdout.split("\n")
    skill_files = [f for f in all_changed if f.startswith("gxtz-") and f.endswith("/SKILL.md")]
    script_files = [f for f in all_changed if f.startswith("_common/")]
    other_files = [
        f for f in all_changed
        if not (f.startswith("gxtz-") and f.endswith("/SKILL.md"))
        and not f.startswith("_common/")
        and f not in (".version_state.json",)
    ]
    return skill_files, script_files, other_files


def compare_skill_versions(local, remote):
    """对比本地与远程的技能版本"""
    skill_files, script_files, other_files = get_changed_skills(local, remote)

    results = {
        "skill_upgrades": [],
        "skill_new": [],
        "script_updates": script_files,
        "other_updates": other_files,
    }

    for skill_file in skill_files:
        skill_name = skill_file.split("/")[0]  # gxtz-xxx

        local_content = get_file_at_ref(local, skill_file)
        remote_content = get_file_at_ref(remote, skill_file)

        local_version = extract_version_from_file(local_content or "")
        remote_version = extract_version_from_file(remote_content or "")

        if local_version is None and remote_version is not None:
            results["skill_new"].append({
                "name": skill_name,
                "version": remote_version,
            })
        elif local_version and remote_version and local_version != remote_version:
            results["skill_upgrades"].append({
                "name": skill_name,
                "from_version": local_version,
                "to_version": remote_version,
            })
        elif local_version and remote_version and local_version == remote_version:
            # 版本号相同但内容变了（可能是描述修改）
            results["skill_upgrades"].append({
                "name": skill_name,
                "from_version": local_version,
                "to_version": f"{remote_version} (内容变更)",
            })
        elif local_version is not None and remote_version is None:
            results["skill_new"].append({
                "name": skill_name + " (远程可能丢失了版本号)",
                "version": local_version,
            })

    return results


def print_results(results):
    """格式化输出版本升级详情"""
    upgrades = results["skill_upgrades"]
    new_skills = results["skill_new"]
    script_updates = results["script_updates"]
    other_updates = results["other_updates"]

    if not upgrades and not new_skills and not script_updates and not other_updates:
        print("✓ 无变更")
        return

    if upgrades:
        print(f"\n┌─ 技能版本升级 ({len(upgrades)}) ─".ljust(60, "─"))
        max_name_len = max(len(u["name"]) for u in upgrades)
        for u in upgrades:
            print(f"│  {u['name']:<{max_name_len}}  {u['from_version']}  ->  {u['to_version']}")
        print("└" + "─" * 59)

    if new_skills:
        print(f"\n┌─ 新增技能 ({len(new_skills)}) ─".ljust(60, "─"))
        max_name_len = max(len(u["name"]) for u in new_skills)
        for u in new_skills:
            print(f"│  {u['name']:<{max_name_len}}  v{u['version']}")
        print("└" + "─" * 59)

    if script_updates:
        print(f"\n┌─ 公共脚本变更 ({len(script_updates)}) ─".ljust(60, "─"))
        for s in script_updates:
            print(f"│  {s}")
        print("└" + "─" * 59)

    if other_updates:
        print(f"\n┌─ 其他变更 ({len(other_updates)}) ─".ljust(60, "─"))
        for f in other_updates[:10]:  # 最多显示10个
            print(f"│  {f}")
        if len(other_updates) > 10:
            print(f"│  ... +{len(other_updates) - 10} 个文件")
        print("└" + "─" * 59)

    # 输出JSON供外部解析
    import json
    print("\n[VERSION_JSON]")
    print(json.dumps(results, ensure_ascii=False, indent=2))


def main():
    local = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
    remote = sys.argv[2] if len(sys.argv) > 2 else "origin/main"

    results = compare_skill_versions(local, remote)
    print_results(results)


if __name__ == "__main__":
    main()
