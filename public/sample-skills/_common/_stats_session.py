# -*- coding: utf-8 -*-
"""扫描本会话所有经验，统计涉及的项目和技能。"""
import json
import os
from pathlib import Path
from collections import defaultdict

BASE = Path(r"C:\Users\T203-15\.trae-cn\memory\skill_experiences")

PROJECTS = {
    "宏日嘉": ["宏日嘉", "宏日嘉净化"],
    "羽声": ["羽声", "国光电器"],
    "2023guogao参考": ["2023guogao", "模板脚本", "高新技术企业认定", "高新模板"],
    "其他/未明确": [],
}

ALL = []

for fp in sorted(BASE.rglob("*.json")):
    fp_str = str(fp)
    if "_archive" not in fp_str and ".bak" not in fp_str:
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
            skill = fp.stem
            if isinstance(data, dict) and "experiences" in data:
                for e in data["experiences"]:
                    e["_skill_file"] = skill
                    e["_source"] = "current"
                    ALL.append(e)
        except Exception as exc:
            print(f"skip {fp}: {exc}")

arch_fp = BASE / "_archive" / "archive_2026-07-22.json"
if arch_fp.exists():
    data = json.loads(arch_fp.read_text(encoding="utf-8"))
    for e in data.get("archived_records", []):
        e["_skill_file"] = e.get("skill_name")
        e["_source"] = "archive"
        ALL.append(e)

for e in ALL:
    desc = (e.get("problem_desc", "") or "") + (e.get("solution", "") or "") + (e.get("source_project", "") or "")
    matched = []
    for proj, keys in PROJECTS.items():
        for k in keys:
            if k in desc:
                matched.append(proj)
                break
    e["_projects"] = matched if matched else ["未明确/项目内通用"]


by_skill = defaultdict(int)
by_project = defaultdict(int)
cross = defaultdict(lambda: defaultdict(int))
for e in ALL:
    skill = e["_skill_file"]
    by_skill[skill] += 1
    for p in e["_projects"]:
        by_project[p] += 1
        cross[p][skill] += 1

print("=" * 70)
print(f"本次会话经验汇总（共 {len(ALL)} 条）")
print("=" * 70)

print("\n【按技能分组】")
for s, c in sorted(by_skill.items(), key=lambda x: -x[1]):
    print(f"  {s}: {c} 条")

print("\n【按项目分组】")
for p, c in sorted(by_project.items(), key=lambda x: -x[1]):
    print(f"  {p}: {c} 条")

print("\n【项目×技能交叉分布】")
print(f"  {'项目':<20} | " + " | ".join(f"{s:<25}" for s in sorted(by_skill.keys())))
print("  " + "-" * 90)
for p in sorted(by_project.keys()):
    row = f"  {p:<20} | "
    for s in sorted(by_skill.keys()):
        cnt = cross[p][s]
        row += f"{str(cnt)+' 条':<27} | "
    print(row)

print("\n【所有经验列表】")
for e in ALL:
    src = e.get("_source", "?")
    sid = e.get("_skill_file", "?")
    eid = e.get("exp_id", "?")
    pjs = ",".join(e["_projects"])
    print(f"  [{src}] {eid:<28} {sid:<28} → {pjs}")
