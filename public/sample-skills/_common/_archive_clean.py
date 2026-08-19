# -*- coding: utf-8 -*-
"""archive_and_clean: 归档已消费/已验证经验，仅保留pending"""
import json
from pathlib import Path
from datetime import date

GLOBAL = Path(r"C:\Users\T203-15\.trae-cn\memory\skill_experiences")

all_archived = []
by_skill = {}
kept = {}

for fp in sorted(GLOBAL.glob("*.json")):
    if fp.stem.startswith("_") or ".bak" in fp.name:
        continue
    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  SKIP {fp.name}: {e}")
        continue

    exps = data.get("experiences", [])
    if not exps:
        kept[fp.stem] = 0
        continue

    pending = [e for e in exps if e.get("status") == "pending"]
    to_archive = [e for e in exps if e.get("status") != "pending"]

    for e in to_archive:
        e["archived_reason"] = f"已沉淀到技能包 CHANGELOG/experience.json，{date.today()} 归档清理"
        all_archived.append(e)

    by_skill[fp.stem] = len(to_archive)
    kept[fp.stem] = len(pending)

    # 重写全局文件：仅保留pending
    bak_content = fp.read_text(encoding="utf-8")
    Path(str(fp) + f".bak_archive_{date.today().strftime('%m%d')}").write_text(bak_content, encoding="utf-8")

    data["experiences"] = pending
    data["updated_at"] = str(date.today())
    data["last_synced_from_project"] = f"archive_and_clean {date.today()}"
    fp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  ✓ {fp.stem}: 归档 {len(to_archive)} 条, 保留 {len(pending)} 条 pending")

# 写归档文件
total = len(all_archived)
if total > 0:
    _archive_dir = GLOBAL / "_archive"
    _archive_dir.mkdir(exist_ok=True)
    arch_fp = _archive_dir / f"archive_{date.today()}.json"
    arch_data = {
        "archive_date": str(date.today()),
        "description": "已消费/已验证经验归档备份",
        "archived_records": all_archived,
        "stats": {
            "total_archived": total,
            "by_skill": by_skill
        }
    }
    arch_fp.write_text(json.dumps(arch_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  📦 归档文件: {arch_fp}")
    print(f"  📦 备份文件: *.json.bak_archive_{date.today().strftime('%m%d')}")

print("\n" + "=" * 60)
print(f"【经验归档报告】")
print(f"归档日期: {date.today()}")
print(f"")
print(f"{'技能':<32}{'归档':>6}{'保留(pending)':>16}")
print("-" * 56)
for s, a in sorted(by_skill.items()):
    k = kept.get(s, 0)
    if a > 0 or k > 0:
        print(f"{s:<34}{a:>4}{k:>16}")
print("-" * 56)
print(f"{'合计':<34}{total:>4}{sum(kept.values()):>16}")
print(f"\n已归档经验可从 backup 文件恢复，全局库现仅保留 pending 经验。")
