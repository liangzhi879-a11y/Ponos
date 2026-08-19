#!/usr/bin/env python3
"""
gxtz-contract-review 验证脚本
验证合同评估报告的完整性和合规性
"""

import argparse
import json
import os
import sys
from datetime import datetime


REQUIRED_DIMENSIONS = ["dim1", "dim2", "dim3", "dim4", "dim5", "dim6", "dim7", "dim8", "dim9", "dim10"]

REQUIRED_REPORT_SECTIONS = [
    "评估概要",
    "各维度审查明细",
    "整改建议汇总",
    "政策适用提示",
    "风险评估",
]


def validate_report(report_dir, project_root):
    errors = []
    warnings = []
    stats = {}

    # 1. 检查输出目录是否存在
    if not os.path.isdir(report_dir):
        errors.append({
            "type": "missing_directory",
            "message": f"评估报告输出目录不存在：{report_dir}",
        })
        return {
            "passed": False,
            "errors": errors,
            "warnings": warnings,
            "stats": stats,
        }

    # 2. 查找报告文件
    json_files = [f for f in os.listdir(report_dir) if f.endswith('.json') and '评估明细' in f]
    md_files = [f for f in os.listdir(report_dir) if f.endswith('.md') and '评估报告' in f]
    checklist_files = [f for f in os.listdir(report_dir) if f.endswith('.md') and '整改建议' in f]

    stats["report_file_count"] = len(json_files) + len(md_files) + len(checklist_files)

    if not json_files:
        errors.append({
            "type": "missing_file",
            "message": "缺少合同评估明细JSON文件",
            "expected": "合同评估明细_{合同名称}.json",
        })
    else:
        stats["json_file"] = json_files[0]

    if not md_files:
        errors.append({
            "type": "missing_file",
            "message": "缺少合同评估报告Markdown文件",
            "expected": "合同评估报告_{合同名称}.md",
        })
    else:
        stats["md_file"] = md_files[0]

    if not checklist_files:
        warnings.append({
            "type": "missing_file",
            "message": "缺少整改建议清单Markdown文件（非必需）",
        })

    # 3. 验证JSON审查结果
    if json_files:
        json_path = os.path.join(report_dir, json_files[0])
        try:
            with open(json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            errors.append({
                "type": "invalid_json",
                "message": f"无法解析JSON文件：{e}",
            })
            return {
                "passed": False,
                "errors": errors,
                "warnings": warnings,
                "stats": stats,
            }

        # 验证技能信息
        if not data.get("skill"):
            errors.append({"type": "missing_field", "message": "缺少skill字段"})
        else:
            stats["skill"] = data["skill"]
            stats["version"] = data.get("version", "unknown")

        # 验证企业名称
        if not data.get("enterprise"):
            warnings.append({"type": "missing_field", "message": "缺少企业名称"})

        # 验证摘要
        summary = data.get("summary", {})
        if not summary:
            errors.append({"type": "missing_section", "message": "缺少审查摘要(summary)"})
        else:
            required_summary_fields = ["overall_conclusion", "risk_level", "issue_summary"]
            for field in required_summary_fields:
                if field not in summary:
                    errors.append({
                        "type": "missing_field",
                        "message": f"摘要缺少{field}字段",
                    })
            stats["issue_total"] = summary.get("issue_summary", {}).get("total", "N/A")

        # 验证10维审查结果
        dimensions = data.get("dimensions", {})
        missing_dims = [d for d in REQUIRED_DIMENSIONS if d not in dimensions]
        if missing_dims:
            errors.append({
                "type": "missing_dimension",
                "message": f"缺少以下审查维度：{', '.join(missing_dims)}",
            })
        stats["dimensions_covered"] = len([d for d in REQUIRED_DIMENSIONS if d in dimensions])

        # 验证问题列表
        issues = data.get("issues", [])
        stats["total_issues"] = len(issues)

        f_issues = [i for i in issues if i.get("level") == "F"]
        h_issues = [i for i in issues if i.get("level") == "H"]

        # 检查F/H级问题是否有整改建议
        issues_without_suggestion = [
            i for i in issues
            if i.get("level") in ("F", "H") and not i.get("suggestion")
        ]
        if issues_without_suggestion:
            errors.append({
                "type": "missing_suggestion",
                "message": f"F/H级问题中{len(issues_without_suggestion)}条缺少整改建议",
            })

        # 检查问题是否有法规依据
        issues_without_law = [
            i for i in issues
            if not i.get("law_reference")
        ]
        if issues_without_law:
            errors.append({
                "type": "missing_law_ref",
                "message": f"{len(issues_without_law)}条问题缺少法规依据引用",
            })

        # 检查问题编号唯一性
        issue_ids = [i.get("id") for i in issues if i.get("id")]
        duplicates = [id for id in issue_ids if issue_ids.count(id) > 1]
        if duplicates:
            errors.append({
                "type": "duplicate_issue_id",
                "message": f"存在重复的问题编号：{list(set(duplicates))}",
            })

    # 4. 验证Markdown报告完整性
    if md_files:
        md_path = os.path.join(report_dir, md_files[0])
        try:
            with open(md_path, 'r', encoding='utf-8') as f:
                md_content = f.read()
        except FileNotFoundError:
            errors.append({
                "type": "file_not_found",
                "message": f"无法读取报告文件：{md_path}",
            })
        else:
            for section in REQUIRED_REPORT_SECTIONS:
                if section not in md_content:
                    warnings.append({
                        "type": "missing_section",
                        "message": f"报告缺少'{section}'章节",
                    })

    # 5. 判定通过条件
    fatal_errors = [
        e for e in errors
        if e.get("type") in ("missing_directory", "invalid_json", "missing_dimension")
    ]
    passed = len(fatal_errors) == 0 and len(errors) <= 3

    result = {
        "passed": passed,
        "errors": errors,
        "warnings": warnings,
        "stats": stats,
        "validated_at": datetime.now().isoformat(),
    }

    return result


def main():
    parser = argparse.ArgumentParser(
        description="gxtz-contract-review 验证脚本"
    )
    parser.add_argument("--dir", required=True, help="评估报告输出目录")
    parser.add_argument("--project-root", default=".", help="项目根目录")

    args = parser.parse_args()

    result = validate_report(args.dir, args.project_root)

    if result["passed"]:
        print(f"[PASS] 验证通过")
    else:
        print(f"[FAIL] 验证不通过")

    print(f"\n统计信息：")
    for k, v in result["stats"].items():
        print(f"  {k}: {v}")

    if result["errors"]:
        print(f"\n错误 ({len(result['errors'])}条)：")
        for e in result["errors"]:
            print(f"  ✗ [{e['type']}] {e['message']}")

    if result["warnings"]:
        print(f"\n警告 ({len(result['warnings'])}条)：")
        for w in result["warnings"]:
            print(f"  ⚠ [{w['type']}] {w['message']}")

    sys.exit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
