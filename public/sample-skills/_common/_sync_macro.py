# -*- coding: utf-8 -*-
"""宏日嘉项目 6条新pending → 全局gxtz-core-tables库"""
import json
from pathlib import Path

# 源：宏日嘉 project_knowledge/experience_base.json
src_fp = Path(r"D:\Projects\工作\【国高】20260622 深圳市宏日嘉净化设备科技有限公司\.trae\project_knowledge\experience_base.json")
src = json.loads(src_fp.read_text(encoding="utf-8"))

# 提取所有 pending 经验
pending = []
CATS = ["common_issues","validation_rules","format_requirements","review_checkpoints","best_practices"]
for cat in CATS:
    for e in src.get(cat, []):
        if e.get("status") == "pending":
            e["_category"] = cat
            pending.append(e)

print(f"提取 pending: {len(pending)} 条")
for e in pending:
    print(f"  {e['exp_id']}: [{e['_category']}] {e['problem_desc'][:60]}...")

# 目标：全局 gxtz-core-tables.json
global_fp = Path(r"C:\Users\T203-15\.trae-cn\memory\skill_experiences\gxtz-core-tables.json")
if global_fp.exists():
    gdata = json.loads(global_fp.read_text(encoding="utf-8"))
    bak = global_fp.read_text(encoding="utf-8")
    Path(str(global_fp) + ".bak_0723_macro").write_text(bak, encoding="utf-8")
else:
    gdata = {"skill_name":"gxtz-core-tables","schema_version":"2.0","experiences":[]}

# 合并（exp_id去重）
eid_map = {e.get("exp_id",""): e for e in gdata.get("experiences",[])}
for e in pending:
    clean = {k:v for k,v in e.items() if k != "_category"}
    eid_map[clean["exp_id"]] = clean

gdata["experiences"] = list(eid_map.values())
gdata["updated_at"] = "2026-07-23"
gdata["last_synced_from_project"] = "宏日嘉 核心表格全面优化-20260723"

gdata["experiences"].sort(key=lambda x: x.get("exp_id",""))
global_fp.write_text(json.dumps(gdata, ensure_ascii=False, indent=2), encoding="utf-8")

# 回读验证
vdata = json.loads(global_fp.read_text(encoding="utf-8"))
v_pending = [e for e in vdata["experiences"] if e.get("status") == "pending"]
print(f"\n回读验证: {len(v_pending)} pending → {[e['exp_id'] for e in v_pending]}")

# 统计
src_consumed = sum(1 for cat in CATS for e in src.get(cat,[]) if e.get("status")=="consumed")
print(f"\n宏日嘉 project_knowledge: {len(pending)} pending + {src_consumed} consumed")
print("✅ 同步完成")
