# -*- coding: utf-8 -*-
"""宏日嘉 project_knowledge: pending→consumed + archive_and_clean"""
import json
from pathlib import Path

# 1. 修复项目级状态
src_fp = Path(r"D:\Projects\工作\【国高】20260622 深圳市宏日嘉净化设备科技有限公司\.trae\project_knowledge\experience_base.json")
src = json.loads(src_fp.read_text(encoding="utf-8"))

INTEGRATIONS = {
    "EXP-2026-07-23-001": "v1.37.0: SKILL.md新增核心表格格式化规则-日期格式YYYY/MM/DD",
    "EXP-2026-07-23-002": "v1.37.0: SKILL.md新增表格内容分配规则-三层引用规则",
    "EXP-2026-07-23-003": "v1.37.0: SKILL.md新增表格内容分配规则-K/L列内容分配",
    "EXP-2026-07-23-004": "v1.37.0: SKILL.md新增核心表格格式化规则-IP摘要空格+外观设计完整性",
    "EXP-2026-07-23-005": "v1.37.0: SKILL.md新增文件管理工作流-备份文件归集",
    "EXP-2026-07-23-006": "v1.37.0: SKILL.md新增字数修复工作流-并行Subagent禁止截断",
}

CATS = ["common_issues","validation_rules","format_requirements","review_checkpoints","best_practices"]
count = 0
for cat in CATS:
    for e in src.get(cat, []):
        eid = e.get("exp_id","")
        if eid in INTEGRATIONS and e.get("status") == "pending":
            e["status"] = "consumed"
            e["consumed_at"] = "2026-07-23"
            e["consumed_version"] = "v1.37.0"
            e["integration_method"] = INTEGRATIONS[eid]
            count += 1

src["last_updated"] = "2026-07-23 (status sync: pending→consumed v1.37.0)"
bak = src_fp.read_text(encoding="utf-8")
Path(str(src_fp) + ".bak_0723_consumed").write_text(bak, encoding="utf-8")
src_fp.write_text(json.dumps(src, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"宏日嘉 project_knowledge: {count} pending→consumed")

# 2. archive_and_clean: 全局库清理
GLOBAL = Path(r"C:\Users\T203-15\.trae-cn\memory\skill_experiences")
all_archived = []
by_skill = {}

for fp in sorted(GLOBAL.glob("*.json")):
    if ".bak" in fp.name:
        continue
    data = json.loads(fp.read_text(encoding="utf-8"))
    exps = data.get("experiences", [])
    if not exps:
        continue
    pending = [e for e in exps if e.get("status") == "pending"]
    to_archive = [e for e in exps if e.get("status") != "pending"]
    if not to_archive:
        continue

    for e in to_archive:
        e["archived_reason"] = "已沉淀到技能包 CHANGELOG/experience.json，2026-07-23 归档清理"
        all_archived.append(e)

    by_skill[fp.stem] = len(to_archive)

    bak_content = fp.read_text(encoding="utf-8")
    Path(str(fp) + ".bak_archive_0723_v2").write_text(bak_content, encoding="utf-8")

    data["experiences"] = pending
    data["updated_at"] = "2026-07-23"
    data["last_synced_from_project"] = f"archive_and_clean 2026-07-23"
    fp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  {fp.stem}: 归档 {len(to_archive)} 条, 保留 {len(pending)} pending")

if all_archived:
    _archive_dir = GLOBAL / "_archive"
    _archive_dir.mkdir(exist_ok=True)
    arch_fp = _archive_dir / f"archive_2026-07-23_v2.json"
    arch_data = {
        "archive_date": "2026-07-23",
        "description": "宏日嘉6条核心表格经验归档备份",
        "archived_records": all_archived,
        "stats": {"total_archived": len(all_archived), "by_skill": by_skill}
    }
    arch_fp.write_text(json.dumps(arch_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n归档文件: {arch_fp}")
    print(f"总计归档: {len(all_archived)} 条")

print("\n✅ 状态同步+归档完成")
