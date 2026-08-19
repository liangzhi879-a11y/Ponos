# -*- coding: utf-8 -*-
"""修复项目级 experience_base.json: pending→consumed，同步技能升级后的状态"""
import json
from pathlib import Path

FILES = [
    (r"D:\Projects\工作\【国高】20260622 深圳市中瑞远博智能系统有限公司\.trae\experience_base.json", "中瑞远博"),
    (r"D:\Projects\工作\【国高】20260622 深圳羽声电子有限公司\.trae\project_knowledge\experience_base.json", "羽声"),
    (r"D:\Projects\工作\【国高】20260707 深圳锐取电子有限公司\.trae\experience_base.json", "锐取"),
]

CATEGORIES = ["common_issues", "validation_rules", "format_requirements",
              "review_checkpoints", "best_practices", "skill_upgrade_triggers"]

CONSUMED_MAP = {
    # audit-verification → v1.10.0
    "EXP-2026-07-22-001": ("v1.10.0", "gxtz-audit-verification v1.10.0: SKILL.md新增Doc转换Fallback链章节"),
    "EXP-2026-07-22-002": ("v1.10.0", "gxtz-audit-verification v1.10.0: SKILL.md新增RAR版本MD5检测章节"),
    "EXP-2026-07-22-003": ("v1.10.0", "gxtz-audit-verification v1.10.0: SKILL.md新增技术领域逐字比对章节"),
    "EXP-2026-07-22-004": ("v1.10.0", "gxtz-audit-verification v1.10.0: SKILL.md新增Locate文件名校验权重章节"),
    # core-tables → v1.36.0
    "EXP-2026-07-22-005": ("v1.36.0", "gxtz-core-tables v1.36.0: 科技人员清单基准名单规则"),
    "EXP-2026-07-22-006": ("v1.36.0", "gxtz-core-tables v1.36.0: 项目路径确认"),
    "EXP-2026-07-22-007": ("v1.36.0", "gxtz-core-tables v1.36.0: TO-AI联网搜索"),
    "EXP-2026-07-22-008": ("v1.36.0", "gxtz-core-tables v1.36.0: .xls格式兼容"),
    # info-collector → v1.31.0
    "EXP-2026-07-21-001": ("v1.31.0", "gxtz-info-collector v1.31.0: AI输出类型安全强化"),
}

total = 0

for fp_str, name in FILES:
    fp = Path(fp_str)
    if not fp.exists():
        print(f"  SKIP {name}: file not found")
        continue

    data = json.loads(fp.read_text(encoding="utf-8"))

    # backup
    bak = fp.read_text(encoding="utf-8")
    Path(str(fp) + ".bak_0723_status_sync").write_text(bak, encoding="utf-8")

    count = 0

    # 锐取是list格式
    if isinstance(data, list):
        for entry in data:
            if isinstance(entry, dict):
                eid = entry.get("exp_id", "")
                if eid in CONSUMED_MAP and entry.get("status") == "pending":
                    ver, method = CONSUMED_MAP[eid]
                    entry["status"] = "consumed"
                    entry["consumed_at"] = "2026-07-23"
                    entry["consumed_version"] = ver
                    entry["integration_method"] = method
                    count += 1
                    print(f"    {eid} → consumed ({ver})")
    else:
        for cat in CATEGORIES:
            for entry in data.get(cat, []):
                if not isinstance(entry, dict):
                    continue
                eid = entry.get("exp_id", "")
                if eid in CONSUMED_MAP and entry.get("status") == "pending":
                    ver, method = CONSUMED_MAP[eid]
                    entry["status"] = "consumed"
                    entry["consumed_at"] = "2026-07-23"
                    entry["consumed_version"] = ver
                    entry["integration_method"] = method
                    count += 1
                    print(f"    [{cat}] {eid} → consumed ({ver})")

    if count > 0:
        if isinstance(data, dict):
            data["last_updated"] = "2026-07-23 (status sync: pending→consumed)"
        fp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  ✓ {name}: {count} 条 pending→consumed")
    else:
        print(f"  - {name}: 无需更新")
    total += count

print(f"\n✅ 完成: {total} 条项目级经验状态同步")
