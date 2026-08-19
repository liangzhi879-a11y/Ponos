#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
progress_sync.py - 项目进度同步公共模块 v1.0.0

用法：
  python progress_sync.py load --project-root "."
  python progress_sync.py update-stage --project-root "." --project-id "main" --stage-id "stage1" --status "completed"
  python progress_sync.py check-deps --project-root "." --skill "gxtz-rd-report"
  python progress_sync.py update-materials --project-root "." --project-id "main" --scan-result ".trae/_scan_result.json"

进度数据文件: {project_root}/.trae/project_progress.json
项目类型配置: {project_root}/.trae/project_types_config.json
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path


PROGRESS_FILE = ".trae/project_progress.json"
TYPES_CONFIG_FILE = ".trae/project_types_config.json"

EMPTY_PROGRESS_TEMPLATE = {
    "schema_version": "1.0",
    "generated_at": "",
    "generated_by": "progress_sync",
    "project_root": ".",
    "projects": [],
    "sticky_notes": []
}


def load_progress(project_root):
    path = os.path.join(project_root, PROGRESS_FILE)
    if not os.path.exists(path):
        return dict(EMPTY_PROGRESS_TEMPLATE)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_progress(project_root, data):
    path = os.path.join(project_root, PROGRESS_FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data["generated_at"] = datetime.now().isoformat()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_types_config(project_root):
    path = os.path.join(project_root, TYPES_CONFIG_FILE)
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_project(data, project_id):
    for p in data.get("projects", []):
        if p.get("id") == project_id:
            return p
    return None


def find_project_by_path(data, sub_path):
    for p in data.get("projects", []):
        if p.get("sub_path") == sub_path:
            return p
    return None


def update_stage_status(project_root, project_id, stage_id, status, skill_name=None):
    data = load_progress(project_root)
    project = get_project(data, project_id)
    if not project:
        print(f"ERROR: 项目 {project_id} 不存在")
        return False

    for stage in project.get("stages", []):
        if stage.get("id") == stage_id:
            stage["status"] = status
            now = datetime.now().strftime("%Y-%m-%d")
            if status == "in_progress" and not stage.get("started_at"):
                stage["started_at"] = now
            if status == "completed":
                stage["completed_at"] = now
                for step in stage.get("steps", []):
                    step["status"] = "completed"
            if skill_name:
                project["last_skill_run"] = skill_name
            save_progress(project_root, data)
            print(f"OK: 项目 {project_id} 阶段 {stage_id} 状态更新为 {status}")
            return True

    print(f"ERROR: 阶段 {stage_id} 不存在于项目 {project_id}")
    return False


def update_material_stats(project_root, project_id, scan_result_path):
    data = load_progress(project_root)
    project = get_project(data, project_id)
    if not project:
        print(f"ERROR: 项目 {project_id} 不存在")
        return False

    if not os.path.exists(scan_result_path):
        print(f"ERROR: 扫描结果文件不存在: {scan_result_path}")
        return False

    with open(scan_result_path, "r", encoding="utf-8") as f:
        scan_result = json.load(f)

    materials_map = {}
    for m in scan_result.get("materials", {}).values():
        materials_map[m.get("category_id", m.get("id", ""))] = m

    for mat in project.get("materials", []):
        cid = mat.get("category_id", "")
        if cid in materials_map:
            sm = materials_map[cid]
            mat["valid_count"] = sm.get("valid", 0)
            mat["expired_count"] = sm.get("expired", 0)
            mat["invalid_count"] = sm.get("invalid", 0)
            mat["total_files"] = sm.get("total", 0)
            mat["completeness_pct"] = sm.get("completeness_pct", 0)
            mat["files"] = sm.get("files", [])

    project["last_scan_at"] = datetime.now().isoformat()
    save_progress(project_root, data)
    print(f"OK: 项目 {project_id} 材料统计已更新")
    return True


def list_pending_stages(project_root, project_id):
    data = load_progress(project_root)
    project = get_project(data, project_id)
    if not project:
        return []

    pending = []
    for stage in project.get("stages", []):
        if stage.get("status") != "completed":
            deps = stage.get("depends_on", [])
            deps_met = all(
                any(s.get("id") == d and s.get("status") == "completed" for s in project.get("stages", []))
                for d in deps
            )
            pending.append({
                "id": stage["id"],
                "name": stage["name"],
                "status": stage.get("status", "not_started"),
                "deps_met": deps_met,
                "deps": deps
            })
    return pending


def check_skill_deps(project_root, skill_name):
    """检查skill的前置阶段依赖是否已满足"""
    data = load_progress(project_root)
    types_config = load_types_config(project_root)

    for project in data.get("projects", []):
        ptype = project.get("type", "")
        type_cfg = types_config.get(ptype, {})
        for stage in type_cfg.get("stages", []):
            for step in stage.get("steps", []):
                if skill_name in step.get("skills", []):
                    deps = stage.get("depends_on", [])
                    unmet = []
                    for dep_id in deps:
                        dep_stage = None
                        for s in project.get("stages", []):
                            if s.get("id") == dep_id:
                                dep_stage = s
                                break
                        if not dep_stage or dep_stage.get("status") != "completed":
                            dep_name = dep_id
                            for ts in type_cfg.get("stages", []):
                                if ts.get("id") == dep_id:
                                    dep_name = ts.get("name", dep_id)
                            unmet.append({"id": dep_id, "name": dep_name})
                    if unmet:
                        print(f"WARNING: 技能 {skill_name} 的前置阶段未完成:")
                        for u in unmet:
                            print(f"  - {u['name']} ({u['id']})")
                        return unmet
                    print(f"OK: 技能 {skill_name} 所有前置阶段已完成")
                    return []
    return []


def init_project_in_progress(project_root, project_id, project_type, name, enterprise, year, sub_path="."):
    data = load_progress(project_root)
    types_config = load_types_config(project_root)
    type_cfg = types_config.get(project_type, {})

    existing = get_project(data, project_id)
    if existing:
        print(f"INFO: 项目 {project_id} 已存在，刷新阶段和材料定义")
        project = existing
    else:
        project = {
            "id": project_id,
            "name": name,
            "type": project_type,
            "sub_path": sub_path,
            "enterprise": enterprise,
            "year": year,
            "overall_status": "in_progress",
            "stages": [],
            "materials": [],
            "data_summary": {
                "ip_count": 0, "rd_count": 0, "ps_count": 0,
                "achievement_count": 0, "staff_count": 0,
                "total_employees": 0, "rd_expenses_total": 0, "revenue_total": 0
            },
            "last_scan_at": "",
            "last_skill_run": ""
        }
        data["projects"].append(project)

    stage_ids_existing = {s["id"] for s in project.get("stages", [])}
    for ts in type_cfg.get("stages", []):
        if ts["id"] not in stage_ids_existing:
            project["stages"].append({
                "id": ts["id"],
                "name": ts["name"],
                "order": ts.get("order", 0),
                "depends_on": ts.get("depends_on", []),
                "parallel_group": ts.get("parallel_group"),
                "steps": [{"name": s["name"], "skills": s.get("skills", []), "status": "not_started"}
                          for s in ts.get("steps", [])],
                "status": "not_started",
                "started_at": "",
                "completed_at": ""
            })

    mat_ids_existing = {m["category_id"] for m in project.get("materials", [])}
    for tc in type_cfg.get("material_categories", []):
        if tc["id"] not in mat_ids_existing:
            project["materials"].append({
                "category_id": tc["id"],
                "category_name": tc["name"],
                "directory": tc.get("dir_pattern", ""),
                "required": tc.get("required", False),
                "expected_min": tc.get("expected_min", 0),
                "valid_count": 0,
                "expired_count": 0,
                "invalid_count": 0,
                "total_files": 0,
                "completeness_pct": 0,
                "files": []
            })

    save_progress(project_root, data)
    print(f"OK: 项目 {project_id} ({name}) 已初始化")
    return True


def _find_stage_for_skill(project_root, skill_name):
    """根据技能名查找对应的阶段ID和项目ID"""
    data = load_progress(project_root)
    types_config = load_types_config(project_root)
    for project in data.get("projects", []):
        ptype = project.get("type", "")
        type_cfg = types_config.get(ptype, {})
        for stage in type_cfg.get("stages", []):
            for step in stage.get("steps", []):
                if skill_name in step.get("skills", []):
                    return project.get("id", "main"), stage.get("id", ""), stage.get("name", "")
    return None, None, None


def main():
    parser = argparse.ArgumentParser(description="项目进度同步公共模块")
    subparsers = parser.add_subparsers(dest="command")

    cmd_load = subparsers.add_parser("load")
    cmd_load.add_argument("--project-root", default=".")

    cmd_update = subparsers.add_parser("update-stage")
    cmd_update.add_argument("--project-root", default=".")
    cmd_update.add_argument("--project-id", default=None)
    cmd_update.add_argument("--stage-id", default=None)
    cmd_update.add_argument("--status", required=True, choices=["not_started", "in_progress", "completed", "blocked"])
    cmd_update.add_argument("--skill", default=None)

    cmd_deps = subparsers.add_parser("check-deps")
    cmd_deps.add_argument("--project-root", default=".")
    cmd_deps.add_argument("--skill", required=True)

    cmd_materials = subparsers.add_parser("update-materials")
    cmd_materials.add_argument("--project-root", default=".")
    cmd_materials.add_argument("--project-id", default="main")
    cmd_materials.add_argument("--scan-result", required=True)

    cmd_init = subparsers.add_parser("init-project")
    cmd_init.add_argument("--project-root", default=".")
    cmd_init.add_argument("--project-id", default="main")
    cmd_init.add_argument("--type", required=True)
    cmd_init.add_argument("--name", required=True)
    cmd_init.add_argument("--enterprise", default="")
    cmd_init.add_argument("--year", type=int, default=2026)
    cmd_init.add_argument("--sub-path", default=".")

    cmd_pending = subparsers.add_parser("list-pending")
    cmd_pending.add_argument("--project-root", default=".")
    cmd_pending.add_argument("--project-id", default="main")

    args = parser.parse_args()

    if args.command == "load":
        data = load_progress(args.project_root)
        print(json.dumps(data, ensure_ascii=False, indent=2))

    elif args.command == "update-stage":
        skill_name = args.skill or ""
        stage_id = args.stage_id
        project_id = args.project_id or "main"
        if not stage_id and skill_name:
            pid, sid, sname = _find_stage_for_skill(args.project_root, skill_name)
            if sid:
                stage_id = sid
                project_id = pid
                print(f"INFO: 自动匹配技能 {skill_name} → 项目 {pid} 阶段 {sid} ({sname})")
            else:
                print(f"WARNING: 未找到技能 {skill_name} 对应的阶段，将跳过更新")
                sys.exit(0)
        if not stage_id:
            print("ERROR: 请指定 --stage-id 或 --skill（用于自动匹配）")
            sys.exit(1)
        ok = update_stage_status(args.project_root, project_id,
                                 stage_id, args.status, skill_name)
        if not ok:
            sys.exit(1)

    elif args.command == "check-deps":
        unmet = check_skill_deps(args.project_root, args.skill)
        if unmet:
            sys.exit(1)

    elif args.command == "update-materials":
        ok = update_material_stats(args.project_root, args.project_id, args.scan_result)
        if not ok:
            sys.exit(1)

    elif args.command == "init-project":
        ok = init_project_in_progress(args.project_root, args.project_id,
                                      args.type, args.name, args.enterprise,
                                      args.year, args.sub_path)
        if not ok:
            sys.exit(1)

    elif args.command == "list-pending":
        pending = list_pending_stages(args.project_root, args.project_id)
        print(json.dumps(pending, ensure_ascii=False, indent=2))

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
