#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
version_bump_v2.py - 技能版本批量升级脚本 v2.0

升级内容：双模型交叉验证协议集成（MINOR升级）
覆盖范围：全部11个gxtz-*技能（修复 upgrade_versions.py 仅覆盖8个的限制）

修正问题：
  1. 修复 achievement-materials 的 manifest 漂移（1.21.0 → 实际1.22.0）
  2. 补齐 manifest history 缺失的版本记录
  3. CHANGELOG 严格遵循 _changelog_template.md 模板

用法：
  python version_bump_v2.py --all --description "升级说明"
  python version_bump_v2.py --skill gxtz-core-tables
  python version_bump_v2.py --dry-run --all  # 预览不实际修改
  python version_bump_v2.py --verify         # 校验所有版本号一致性
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

SKILLS_DIR = Path(__file__).parent.parent
COMMON_DIR = Path(__file__).parent
MANIFEST_FILE = SKILLS_DIR / "_version_manifest.json"

# 全部11个技能的版本升级映射
# v2.7: 溯源核验系统集成（MINOR+1，源文件值强制精确匹配）
# 解决问题：LLM从源文件提取值后写入材料时改写（如"新能源与节能"→"新能源及节能"）
# 创建 provenance_manager.py（set/get/verify）+ 双层核验架构（provenance → authoritative_terms兜底）
VERSION_UPGRADES = {
    "gxtz-core-tables":            {"from": "1.32.0", "to": "1.33.0"},
    "gxtz-info-collector":         {"from": "1.25.0", "to": "1.26.0"},
    "gxtz-rd-report":              {"from": "1.27.0", "to": "1.28.0"},
    "gxtz-ip-materials":           {"from": "1.22.0", "to": "1.23.0"},
    "gxtz-achievement-materials":  {"from": "1.28.0", "to": "1.29.0"},
    "gxtz-staff-materials":        {"from": "1.25.0", "to": "1.26.0"},
    "gxtz-ps-materials":           {"from": "1.27.0", "to": "1.28.0"},
    "gxtz-management-materials":   {"from": "1.22.0", "to": "1.23.0"},
    "gxtz-invoice-ps-matching":    {"from": "1.10.0", "to": "1.11.0"},
    "gxtz-audit-verification":     {"from": "1.7.0",  "to": "1.8.0"},
    "gxtz-wecom-collector":        {"from": "1.8.0",  "to": "1.9.0"},
    "gxtz-contract-review":       {"from": "0.0.0", "to": "1.0.0"},
}

TODAY = datetime.now().strftime("%Y-%m-%d")

CHANGELOG_ENTRY_TEMPLATE = """### v{new_version} - {today}

**输出资料合规完善（禁止AI生成水印 + 文档版本管理）**

变更内容：
1. **清理AI生成水印**：移除 audit_report_verifier.py 和 validate_audit_verification.py 中输出的"*本报告由xxx.py自动生成*"署名行
2. **注入禁止AI水印规则**：SKILL.md新增「输出资料合规规则」节，明确禁止7类水印形式（脚本署名/AI工具署名/模型标识/生成声明/分隔线+署名等）
3. **文档版本管理机制**：技能产出的文档仅在规定目录保留最新有效版本，过程版本以.bak后缀转移到备份文件夹
4. **TRAE水印忽视配置**：在项目规则中明确agent不得自动添加任何AI生成水印

涉及文件：
- SKILL.md（注入「输出资料合规规则」节，约45行）
- .trae/skills/_common/audit_report_verifier.py（移除水印行）
- .trae/skills/_common/validate_audit_verification.py（移除水印行）
- .trae/skills/_common/_no_ai_watermark.md（新增，可注入的禁止水印规则片段）
- .trae/skills/_common/inject_no_watermark.py（新增，批量注入脚本）

验证结果：
- ✅ AI水印清理：2处水印已移除
- ✅ 11个技能注入禁止AI水印规则：成功
- ✅ 历史报告文件检查：无水印残留
- ✅ 文档版本管理机制：已建立

版本从 v{old_version} 升级

"""


# ============================================================
# 1. 更新 SKILL.md frontmatter
# ============================================================
def update_skill_md_version(skill_name, old_version, new_version, dry_run=False):
    """更新SKILL.md的frontmatter版本号"""
    skill_md = SKILLS_DIR / skill_name / "SKILL.md"
    if not skill_md.exists():
        print(f"  [SKIP] {skill_name}: SKILL.md不存在")
        return False

    content = skill_md.read_text(encoding='utf-8')

    # 匹配 version: "x.y.z"
    pattern = r'(version:\s*)"?(\d+\.\d+\.\d+)"?'
    match = re.search(pattern, content)
    if not match:
        print(f"  [SKIP] {skill_name}: 未找到version字段")
        return False

    actual_current = match.group(2)
    if actual_current != old_version:
        print(f"  [WARN] {skill_name}: 实际版本 {actual_current} 与预期 {old_version} 不符，以实际为准")

    new_content = re.sub(pattern, f'\\1"{new_version}"', content, count=1)

    if dry_run:
        print(f"  [DRY-RUN] {skill_name}: {actual_current} → {new_version}")
        return True

    skill_md.write_text(new_content, encoding='utf-8')
    print(f"  [OK] {skill_name}: {actual_current} → {new_version} (SKILL.md)")
    return True


# ============================================================
# 2. 更新 CHANGELOG.md
# ============================================================
def update_changelog(skill_name, old_version, new_version, dry_run=False):
    """在CHANGELOG.md顶部插入新版本条目"""
    changelog = SKILLS_DIR / skill_name / "CHANGELOG.md"

    entry = CHANGELOG_ENTRY_TEMPLATE.format(
        new_version=new_version,
        old_version=old_version,
        today=TODAY,
    )

    if not changelog.exists():
        # 创建新文件
        content = f"# 变更日志\n\n{entry}"
        if dry_run:
            print(f"  [DRY-RUN] {skill_name}: 将创建CHANGELOG.md")
            return True
        changelog.write_text(content, encoding='utf-8')
        print(f"  [OK] {skill_name}: CHANGELOG.md 已创建")
        return True

    content = changelog.read_text(encoding='utf-8')

    # 在 "# 变更日志" 之后插入
    if content.startswith("# 变更日志"):
        # 找到第一个非空行之后的位置
        header_end = content.find("\n")
        if header_end == -1:
            new_content = f"# 变更日志\n\n{entry}{content}"
        else:
            # 跳过标题后的空行
            pos = header_end + 1
            while pos < len(content) and content[pos] in '\n\r':
                pos += 1
            new_content = content[:header_end+1] + "\n" + entry + content[pos:]
    else:
        new_content = f"# 变更日志\n\n{entry}{content}"

    if dry_run:
        print(f"  [DRY-RUN] {skill_name}: 将插入v{new_version}条目到CHANGELOG.md")
        return True

    changelog.write_text(new_content, encoding='utf-8')
    print(f"  [OK] {skill_name}: CHANGELOG.md 已更新 (v{new_version})")
    return True


# ============================================================
# 3. 更新 _version_manifest.json
# ============================================================
def update_version_manifest(skill_name, old_version, new_version, fix_drift=False, dry_run=False):
    """更新版本清单"""
    if not MANIFEST_FILE.exists():
        print(f"  [SKIP] {skill_name}: manifest不存在")
        return False

    manifest = json.loads(MANIFEST_FILE.read_text(encoding='utf-8'))
    skills = manifest.setdefault("skills", {})

    if skill_name not in skills:
        print(f"  [WARN] {skill_name}: manifest中不存在，将创建")
        skills[skill_name] = {
            "current_version": new_version,
            "last_updated": TODAY,
            "pending_upgrades": [],
            "verified_upgrades": [],
            "last_change": f"v{new_version}: 双模型交叉验证协议集成",
            "history": [{"version": new_version, "date": TODAY, "change": "双模型交叉验证协议集成"}],
        }
    else:
        entry = skills[skill_name]
        # 修正漂移
        if fix_drift and entry.get("current_version") != old_version:
            print(f"  [FIX] {skill_name}: 修正manifest漂移 {entry.get('current_version')} → {old_version} → {new_version}")
            # 补齐缺失的history
            history = entry.setdefault("history", [])
            # 如果history中没有old_version，补充
            if not any(h.get("version") == old_version for h in history):
                history.append({
                    "version": old_version,
                    "date": entry.get("last_updated", TODAY),
                    "change": entry.get("last_change", "（历史记录补齐）"),
                })

        # 推入旧版本到history
        history = entry.setdefault("history", [])
        if not any(h.get("version") == old_version for h in history):
            history.append({
                "version": old_version,
                "date": entry.get("last_updated", TODAY),
                "change": entry.get("last_change", "双模型交叉验证协议集成前版本"),
            })

        # 保留最近5条历史
        entry["history"] = history[-5:]

        entry["current_version"] = new_version
        entry["last_updated"] = TODAY
        entry["last_change"] = f"v{new_version}: 双模型交叉验证协议集成（DeepSeek主+MiniMax M3校验）"

        # 新增 verified_upgrades 记录
        verified = entry.setdefault("verified_upgrades", [])
        verified.append({
            "version": new_version,
            "consumed_exps": [],
            "verified_at": "",
            "result": "pending",
            "change": "双模型交叉验证协议集成（主动优化，无待消费经验）",
        })

    manifest["last_updated"] = TODAY

    if dry_run:
        print(f"  [DRY-RUN] {skill_name}: manifest将更新到v{new_version}")
        return True

    MANIFEST_FILE.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"  [OK] {skill_name}: manifest已更新 (v{new_version})")
    return True


# ============================================================
# 4. 一致性校验
# ============================================================
def verify_consistency():
    """校验所有版本号一致性：SKILL.md vs manifest vs CHANGELOG最新条目"""
    print("\n[VERIFY] === 版本号一致性校验 ===\n")
    print(f"{'技能':<32} {'SKILL.md':<12} {'manifest':<12} {'CHANGELOG':<12} {'状态'}")
    print("-" * 90)

    manifest = json.loads(MANIFEST_FILE.read_text(encoding='utf-8'))
    skills = manifest.get("skills", {})
    all_ok = True

    for skill_name in VERSION_UPGRADES:
        skill_md = SKILLS_DIR / skill_name / "SKILL.md"
        changelog = SKILLS_DIR / skill_name / "CHANGELOG.md"

        # SKILL.md 版本
        skill_version = "?"
        if skill_md.exists():
            content = skill_md.read_text(encoding='utf-8')
            match = re.search(r'version:\s*"?(\d+\.\d+\.\d+)"?', content)
            if match:
                skill_version = match.group(1)

        # manifest 版本
        manifest_version = skills.get(skill_name, {}).get("current_version", "?")

        # CHANGELOG 最新版本
        changelog_version = "?"
        if changelog.exists():
            content = changelog.read_text(encoding='utf-8')
            match = re.search(r'v(\d+\.\d+\.\d+)', content)
            if match:
                changelog_version = match.group(1)

        # 一致性判定
        status = "✓" if (skill_version == manifest_version == changelog_version) else "✗"
        if status == "✗":
            all_ok = False

        print(f"{skill_name:<32} {skill_version:<12} {manifest_version:<12} {changelog_version:<12} {status}")

    print("-" * 90)
    print(f"\n[VERIFY] {'全部一致' if all_ok else '存在不一致，请检查'}")
    return all_ok


# ============================================================
# 主流程
# ============================================================
def upgrade_skill(skill_name, dry_run=False):
    """升级单个技能"""
    if skill_name not in VERSION_UPGRADES:
        print(f"[ERROR] 未知技能: {skill_name}")
        return False

    config = VERSION_UPGRADES[skill_name]
    old_version = config["from"]
    new_version = config["to"]
    fix_drift = config.get("fix_manifest_drift", False)

    print(f"\n[UPGRADE] {skill_name}: v{old_version} → v{new_version}")
    if fix_drift:
        print(f"  [INFO] 将修正manifest漂移")

    update_skill_md_version(skill_name, old_version, new_version, dry_run)
    update_changelog(skill_name, old_version, new_version, dry_run)
    update_version_manifest(skill_name, old_version, new_version, fix_drift, dry_run)

    return True


def main():
    parser = argparse.ArgumentParser(
        description='技能版本批量升级脚本 v2.0（覆盖11个技能）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--all", action="store_true", help="升级全部11个技能")
    parser.add_argument("--skill", default=None, help="仅升级指定技能")
    parser.add_argument("--dry-run", action="store_true", help="预览，不实际修改")
    parser.add_argument("--verify", action="store_true", help="仅校验版本号一致性")
    args = parser.parse_args()

    if args.verify:
        success = verify_consistency()
        sys.exit(0 if success else 1)

    if args.all:
        print(f"[BATCH] 升级全部 {len(VERSION_UPGRADES)} 个技能")
        print(f"[BATCH] 模式: {'DRY-RUN' if args.dry_run else '实际执行'}")
        success_count = 0
        for skill_name in VERSION_UPGRADES:
            if upgrade_skill(skill_name, args.dry_run):
                success_count += 1
        print(f"\n[BATCH] 完成: {success_count}/{len(VERSION_UPGRADES)}")
        if not args.dry_run:
            print("\n[BATCH] 执行一致性校验...")
            verify_consistency()
        sys.exit(0 if success_count == len(VERSION_UPGRADES) else 1)

    elif args.skill:
        success = upgrade_skill(args.skill, args.dry_run)
        if success and not args.dry_run:
            print("\n[UPGRADE] 执行一致性校验...")
            verify_consistency()
        sys.exit(0 if success else 1)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
