# -*- coding: utf-8 -*-
"""最终收尾：项目级状态同步 + archive_and_clean"""
import json
from pathlib import Path

INTEGRATIONS = {
    "EXP-2026-07-23-010": "v1.38.0: 成果转化表列级精确写入替全局正则",
    "EXP-2026-07-23-011": "v1.38.0: 字数优化流程禁止截断",
    "EXP-2026-07-23-012": "v1.38.0: 数据溯源三权威源采集",
    "EXP-2026-07-23-013": "v1.38.0: 科技人员清单三方对比社保",
    "EXP-2026-07-23-014": "v1.38.0: I列禁止日期格式化保护",
    "EXP-2026-07-23-015": "v1.38.0: 成果名称'的研发'后缀优化",
    "EXP-2026-07-23-016": "v1.38.0: bak文件备份文件/子目录归集",
    "EXP-2026-07-23-017": "v1.38.0: 交叉依赖修复顺序RD→IP→PS→成果→全验",
}

# 1. 同步宏日嘉 project_knowledge
fp = Path(r"D:\Projects\工作\【国高】20260622 深圳市宏日嘉净化设备科技有限公司\.trae\project_knowledge\experience_base.json")
src = json.loads(fp.read_text(encoding="utf-8"))
# backup
bak = fp.read_text(encoding="utf-8")
Path(str(fp)+".bak_0723_final").write_text(bak, encoding="utf-8")

CATS = ["common_issues","validation_rules","format_requirements","review_checkpoints","best_practices","skill_upgrade_triggers"]
count = 0
for cat in CATS:
    for e in src.get(cat,[]):
        eid = e.get("exp_id","")
        if eid in INTEGRATIONS and e.get("status") == "pending":
            e["status"] = "consumed"
            e["consumed_at"] = "2026-07-23"
            e["consumed_version"] = "v1.38.0"
            e["integration_method"] = INTEGRATIONS[eid]
            count += 1
            print(f"  {eid} → consumed")
src["last_updated"] = "2026-07-23 (v1.38.0 template_injector + status sync)"
fp.write_text(json.dumps(src, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"宏日嘉 project_knowledge: {count} pending→consumed")

# 2. archive_and_clean 全局库
GLOBAL = Path(r"C:\Users\T203-15\.trae-cn\memory\skill_experiences")
all_archived = []
by_skill = {}

for fp_glob in sorted(GLOBAL.glob("*.json")):
    if ".bak" in fp_glob.name: continue
    data = json.loads(fp_glob.read_text(encoding="utf-8"))
    exps = data.get("experiences", [])
    if not exps: continue
    pending = [e for e in exps if e.get("status") == "pending"]
    to_archive = [e for e in exps if e.get("status") != "pending"]
    if not to_archive: continue

    for e in to_archive:
        e["archived_reason"] = "已沉淀到技能包 CHANGELOG/experience.json，2026-07-23 v1.3x.0 归档"
        all_archived.append(e)

    by_skill[fp_glob.stem] = len(to_archive)

    bak2 = fp_glob.read_text(encoding="utf-8")
    Path(str(fp_glob)+".bak_archive_0723_final").write_text(bak2, encoding="utf-8")

    data["experiences"] = pending
    data["updated_at"] = "2026-07-23"
    data["last_synced_from_project"] = "archive_and_clean 2026-07-23 模板注入大升级"
    fp_glob.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  {fp_glob.stem}: 归档{len(to_archive)}条 保留{len(pending)}pending")

if all_archived:
    _archive_dir = GLOBAL / "_archive"
    _archive_dir.mkdir(exist_ok=True)
    arch_fp = _archive_dir / "archive_2026-07-23_final.json"
    arch_data = {
        "archive_date":"2026-07-23",
        "description":"模板注入大升级归档（gxtz-core-tables v1.38.0 + 3技能剥离）",
        "archived_records":all_archived,
        "stats":{"total_archived":len(all_archived),"by_skill":by_skill}
    }
    arch_fp.write_text(json.dumps(arch_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n归档文件: {arch_fp}")

print("\n=== 最终验证 ===")
# 验证全局库0 pending
for fp_v in sorted(GLOBAL.glob("*.json")):
    if ".bak" in fp_v.name: continue
    d = json.loads(fp_v.read_text(encoding="utf-8"))
    p = sum(1 for e in d.get("experiences",[]) if e.get("status")=="pending")
    if p > 0: print(f"  ⚠ {fp_v.stem}: {p} pending!")
print("✅ 收尾完成")
