# -*- coding: utf-8 -*-
"""批量同步项目级 pending 经验到全局技能经验库"""
import json
from pathlib import Path

GLOBAL = Path(r"C:\Users\T203-15\.trae-cn\memory\skill_experiences")

PROJECTS = {
    "中瑞远博": r"D:\Projects\工作\【国高】20260622 深圳市中瑞远博智能系统有限公司\.trae\experience_base.json",
    "羽声": r"D:\Projects\工作\【国高】20260622 深圳羽声电子有限公司\.trae\project_knowledge\experience_base.json",
    "锐取": r"D:\Projects\工作\【国高】20260707 深圳锐取电子有限公司\.trae\experience_base.json",
}

ALL_CATEGORIES = ["common_issues", "validation_rules", "format_requirements",
                  "review_checkpoints", "best_practices", "skill_upgrade_triggers"]

pending_by_skill = {}

for proj_name, proj_path in PROJECTS.items():
    try:
        data = json.loads(Path(proj_path).read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"SKIP {proj_name}: {exc}")
        continue

    # 锐取项目的文件格式不一样（是list）
    if isinstance(data, list):
        for entry in data:
            if isinstance(entry, dict) and entry.get("status") == "pending":
                sid = entry.get("skill_name", "")
                pending_by_skill.setdefault(sid, []).append(entry)
    else:
        for cat in ALL_CATEGORIES:
            for entry in data.get(cat, []):
                if isinstance(entry, dict) and entry.get("status") == "pending":
                    # 确保有skill_name字段
                    if "skill_name" in entry:
                        sid = entry["skill_name"]
                        # 补充source_project如果缺失
                        if "source_project" not in entry:
                            entry["source_project"] = data.get("enterprise", proj_name)
                        pending_by_skill.setdefault(sid, []).append(entry)

# 去重：按 exp_id 分组检测跨项目冲突
# 两阶段：先分组发现冲突 → 再重命名冲突条目的exp_id
for sid in pending_by_skill:
    eid_groups = {}
    for e in pending_by_skill[sid]:
        eid = e.get("exp_id", "")
        eid_groups.setdefault(eid, []).append(e)

    unique = []
    for eid, group in eid_groups.items():
        if len(group) == 1:
            unique.append(group[0])
        else:
            # 跨项目冲突：保留第一条，其余重命名
            unique.append(group[0])
            for e in group[1:]:
                sp = e.get("source_project", "")
                short = ""
                for tag in ["羽声", "中瑞远博", "宏日嘉", "锐取", "爱康"]:
                    if tag in sp:
                        short = tag
                        break
                if short:
                    e = dict(e)
                    e["exp_id_original"] = eid
                    e["exp_id"] = f"{eid}-{short}"
                    unique.append(e)

    pending_by_skill[sid] = unique

print("=" * 60)
print(f"扫描结果: {sum(len(v) for v in pending_by_skill.values())} pending 经验 → {len(pending_by_skill)} 个技能")
print("=" * 60)

for sid, exps in sorted(pending_by_skill.items()):
    fp = GLOBAL / f"{sid}.json"
    # 读取现有全局文件
    existing = {}
    if fp.exists():
        try:
            existing = json.loads(fp.read_text(encoding="utf-8"))
        except:
            existing = {"skill_name": sid, "schema_version": "2.0",
                        "description": f"{sid} 技能经验库", "experiences": []}

    # 合并（用exp_id去重，覆盖已有的）
    old_map = {e.get("exp_id", ""): e for e in existing.get("experiences", [])}
    for e in exps:
        old_map[e["exp_id"]] = e

    merged = list(old_map.values())
    existing["experiences"] = merged
    existing["updated_at"] = "2026-07-23"
    existing["last_synced_from_project"] = "中瑞远博/羽声/锐取 三项目同步"

    # 备份
    if fp.exists():
        bak = fp.read_text(encoding="utf-8")
        Path(str(fp) + ".bak_sync").write_text(bak, encoding="utf-8")

    fp.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  ✓ {sid}: {len(merged)} 条 (新增 {len(exps)})")

# 回读验证
print("\n【回读验证】")
for sid in sorted(pending_by_skill.keys()):
    fp = GLOBAL / f"{sid}.json"
    data = json.loads(fp.read_text(encoding="utf-8"))
    pending_count = sum(1 for e in data["experiences"] if e.get("status") == "pending")
    pending_eids = [e["exp_id"] for e in data["experiences"] if e.get("status") == "pending"]
    print(f"  {sid}: {pending_count} pending → {pending_eids}")

print("\n✅ 同步完成")
