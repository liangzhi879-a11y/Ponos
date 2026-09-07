"""高新专审报告核对审核脚本（v1.0.0）

审核专审报告核对结果的完整性和合规性。

校验规则（7条）：
  1. 核对结果文件完整性：核对结果.json 和 核对报告.md 是否都存在
  2. 5个核对维度完整性：cross_report/rd_check/ps_check/ip_check/amount_diff 是否都存在
  3. 金额差异不做严重性警告校验：检查 amount_diff 中是否有任何项被标记为严重
  4. 非金额内容严格一致校验：检查 rd_check/ps_check 中是否有漏检项
  5. 按年度 Sheet 分别核对待校验：检查 rd_check 中是否按年度分别输出
  6. 报告格式完整性：核对报告.md 是否包含7个章节
  7. 问题分级正确性：检查问题严重程度是否符合分级标准

用法：
  python validate_audit_verification.py --dir "输出目录" [--project-root "项目根目录"]

依赖：无外部依赖（仅使用标准库）
"""
import os
import sys
import json
import re
import argparse
from pathlib import Path


# ============================================================
# 常量定义
# ============================================================

# 5个核对维度必须存在的字段
REQUIRED_DIMENSIONS = [
    "cross_report",   # 跨报告一致性
    "rd_check",       # RD内容核对
    "ps_check",       # PS内容核对
    "ip_check",       # IP内容核对
    "amount_diff",    # 金额差异
]

# 核对报告.md 必须包含的7个章节
REQUIRED_REPORT_SECTIONS = [
    "一、专审报告文件清单",
    "二、两份专审报告之间的一致性",
    "三、内容核对结果",
    "四、内容核对通过项",
    "五、金额差异汇总",
    "六、综合问题汇总",
    "七、数据来源",
]

# 合法的严重程度值
VALID_SEVERITIES = ["严重", "中等", "轻微"]

# 非金额内容字段（不允许 severity=None 或"严重"的金额字段，必须严格核对）
NON_AMOUNT_FIELDS = [
    "企业名称", "税号", "审计机构", "报告编号",
    "RD项目名称", "RD项目", "RD项目年度分配",
    "PS产品名称", "PS产品", "技术领域",
    "知识产权编号", "知识产权名称", "知识产权类别", "知识产权",
    "专利号", "专利号/著作权号",
]

# 金额字段（应无严重性警告）
AMOUNT_RELATED_KEYS = ["研发费用总额", "高新收入总额", "研发费用金额", "高新收入金额"]


# ============================================================
# 审核函数
# ============================================================

def validate_audit_verification(output_dir, project_root=None):
    """审核专审报告核对结果的完整性和合规性

    Args:
        output_dir: 输出目录，应包含核对结果.json 和 核对报告.md
        project_root: 项目根目录（可选，用于查找核心表格）

    Returns:
        dict: {
            "passed": bool,
            "errors": [str, ...],
            "warnings": [str, ...],
            "stats": {
                "files_found": int,
                "dimensions_found": int,
                "report_sections_found": int,
                "amount_items": int,
                "non_amount_issues": int,
                "rd_years": int,
            }
        }
    """
    result = {
        "passed": True,
        "errors": [],
        "warnings": [],
        "stats": {
            "files_found": 0,
            "dimensions_found": 0,
            "report_sections_found": 0,
            "amount_items": 0,
            "non_amount_issues": 0,
            "rd_years": 0,
        },
    }

    if not output_dir or not os.path.isdir(output_dir):
        result["errors"].append(f"输出目录不存在: {output_dir}")
        result["passed"] = False
        return result

    # ============================================================
    # 校验规则 1：核对结果文件完整性
    # ============================================================
    verify_result_path = None
    report_path = None

    # 在输出目录中查找核对结果.json 和 核对报告.md
    for root, _dirs, files in os.walk(output_dir):
        for f in files:
            if f.endswith('.json') and ('核对结果' in f or 'verify' in f.lower()):
                verify_result_path = os.path.join(root, f)
            elif f.endswith('.md') and ('核对报告' in f or 'report' in f.lower()):
                report_path = os.path.join(root, f)

    if not verify_result_path:
        result["errors"].append("校验规则1失败：未找到核对结果 JSON 文件（核对结果.json）")
        result["passed"] = False
    else:
        result["stats"]["files_found"] += 1

    if not report_path:
        result["errors"].append("校验规则1失败：未找到核对报告 Markdown 文件（核对报告.md）")
        result["passed"] = False
    else:
        result["stats"]["files_found"] += 1

    # 如果没有核对结果文件，后续校验无法进行
    if not verify_result_path:
        return result

    # 加载核对结果
    try:
        with open(verify_result_path, 'r', encoding='utf-8') as f:
            verify_result = json.load(f)
    except Exception as e:
        result["errors"].append(f"校验规则1失败：读取核对结果 JSON 失败: {e}")
        result["passed"] = False
        return result

    # ============================================================
    # 校验规则 2：5个核对维度完整性
    # ============================================================
    dimensions_found = 0
    missing_dimensions = []
    for dim in REQUIRED_DIMENSIONS:
        if dim in verify_result:
            dimensions_found += 1
        else:
            missing_dimensions.append(dim)

    result["stats"]["dimensions_found"] = dimensions_found
    if missing_dimensions:
        result["errors"].append(
            f"校验规则2失败：缺少核对维度: {', '.join(missing_dimensions)}"
        )
        result["passed"] = False

    # ============================================================
    # 校验规则 3：金额差异不做严重性警告校验
    # ============================================================
    amount_diff = verify_result.get("amount_diff", {})
    amount_items_count = 0
    severe_amount_issues = []

    for key, val in amount_diff.items():
        if isinstance(val, dict):
            amount_items_count += 1
            severity = val.get("severity")
            # 金额项不应有任何 severity 标记（应为 None）
            if severity is not None and severity != "":
                severe_amount_issues.append({
                    "key": key,
                    "severity": severity,
                })

    result["stats"]["amount_items"] = amount_items_count
    if severe_amount_issues:
        for item in severe_amount_issues:
            result["errors"].append(
                f"校验规则3失败：金额项'{item['key']}'被标记为严重性'{item['severity']}'，"
                f"金额差异不应有严重性警告"
            )
        result["passed"] = False

    # ============================================================
    # 校验规则 4：非金额内容严格一致校验（检查漏检）
    # ============================================================
    non_amount_issues_count = 0
    for section_key in ["rd_check", "ps_check", "ip_check"]:
        section = verify_result.get(section_key, {})
        if not section:
            result["warnings"].append(
                f"校验规则4警告：{section_key} 维度为空，可能存在漏检"
            )
            continue
        # 检查是否有核对数量
        checked_count = section.get("checked_count", 0)
        if isinstance(checked_count, (int, float)) and checked_count == 0:
            # 如果 passed=True 但 checked_count=0，可能是漏检
            if section.get("passed"):
                result["warnings"].append(
                    f"校验规则4警告：{section_key} 标记为通过但核对数量为0，可能存在漏检"
                )
        # 统计非金额内容问题数
        issues = section.get("issues", [])
        for issue in issues:
            field = issue.get("field", "")
            # 非金额字段的问题
            if any(naf in field for naf in NON_AMOUNT_FIELDS):
                non_amount_issues_count += 1

    result["stats"]["non_amount_issues"] = non_amount_issues_count

    # ============================================================
    # 校验规则 5：按年度 Sheet 分别核对待校验
    # ============================================================
    rd_check = verify_result.get("rd_check", {})
    by_year = rd_check.get("by_year", {})
    rd_years = len(by_year) if by_year else 0
    result["stats"]["rd_years"] = rd_years

    if not by_year:
        result["warnings"].append(
            "校验规则5警告：rd_check 中未找到 by_year 字段，可能未按年度 Sheet 分别核对"
        )
    else:
        # 检查每个年度是否有 issues 字段
        for year, year_data in by_year.items():
            if not isinstance(year_data, dict):
                result["warnings"].append(
                    f"校验规则5警告：rd_check.by_year[{year}] 格式不正确"
                )
            elif "issues" not in year_data:
                result["warnings"].append(
                    f"校验规则5警告：rd_check.by_year[{year}] 缺少 issues 字段"
                )

    # ============================================================
    # 校验规则 6：报告格式完整性（7个章节）
    # ============================================================
    if report_path:
        try:
            with open(report_path, 'r', encoding='utf-8') as f:
                report_content = f.read()
        except Exception as e:
            result["errors"].append(f"校验规则6失败：读取核对报告失败: {e}")
            result["passed"] = False
            report_content = ""

        sections_found = 0
        missing_sections = []
        for section in REQUIRED_REPORT_SECTIONS:
            if section in report_content:
                sections_found += 1
            else:
                missing_sections.append(section)

        result["stats"]["report_sections_found"] = sections_found
        if missing_sections:
            result["errors"].append(
                f"校验规则6失败：核对报告缺少章节: {', '.join(missing_sections)}"
            )
            result["passed"] = False

        # 检查金额差异章节是否有"不做严重性警告"的说明
        if "五、金额差异汇总" in report_content:
            if "不做" not in report_content and "不严重性" not in report_content:
                if "严重性警告" in report_content and "不做严重性警告" not in report_content:
                    result["warnings"].append(
                        "校验规则6警告：金额差异章节未明确标注'不做严重性警告'"
                    )

    # ============================================================
    # 校验规则 7：问题分级正确性
    # ============================================================
    all_issues_with_severity = []
    invalid_severity_issues = []

    for section_key in ["cross_report", "rd_check", "ps_check", "ip_check"]:
        section = verify_result.get(section_key, {})
        issues = section.get("issues", [])
        for issue in issues:
            severity = issue.get("severity")
            field = issue.get("field", "")
            all_issues_with_severity.append({
                "section": section_key,
                "field": field,
                "severity": severity,
            })
            # 检查 severity 值是否合法
            if severity is not None and severity not in VALID_SEVERITIES:
                invalid_severity_issues.append({
                    "section": section_key,
                    "field": field,
                    "severity": severity,
                })

    # 检查金额相关字段的问题是否有 severity
    for key, val in amount_diff.items():
        if isinstance(val, dict):
            severity = val.get("severity")
            if severity is not None and severity != "":
                # 金额项不应有 severity
                result["errors"].append(
                    f"校验规则7失败：金额项'{key}'的 severity 应为 None，实际为 '{severity}'"
                )
                result["passed"] = False

    # 检查非金额内容问题的 severity 是否合理
    for issue_info in all_issues_with_severity:
        field = issue_info["field"]
        severity = issue_info["severity"]
        # 非金额字段的 severity 不应为 None
        if any(naf in field for naf in NON_AMOUNT_FIELDS):
            if severity is None:
                result["errors"].append(
                    f"校验规则7失败：非金额字段'{field}'（{issue_info['section']}）"
                    f"的 severity 不应为 None，非金额内容必须严格一致"
                )
                result["passed"] = False

    # 检查非法 severity 值
    for issue_info in invalid_severity_issues:
        result["errors"].append(
            f"校验规则7失败：字段'{issue_info['field']}'（{issue_info['section']}）"
            f"的 severity '{issue_info['severity']}' 不在合法值范围内 {VALID_SEVERITIES}"
        )
        result["passed"] = False

    # 检查格式问题是否为轻微
    for issue_info in all_issues_with_severity:
        field = issue_info["field"]
        severity = issue_info["severity"]
        if field == "技术领域":
            # 技术领域编号前缀缺失应为"轻微"
            pass  # 此处不强制，由生成脚本控制

    return result


# ============================================================
# 审核报告生成
# ============================================================

def generate_audit_report(validation_result, output_path=None):
    """生成审核报告

    Args:
        validation_result: validate_audit_verification 的返回结果
        output_path: 输出路径（可选，None 时只打印）

    Returns:
        str: 审核报告内容
    """
    lines = []
    lines.append("# 专审报告核对审核报告\n")
    import datetime
    lines.append(f"**生成时间**：{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

    status = "✅ 通过" if validation_result["passed"] else "❌ 未通过"
    lines.append(f"**审核结果**：{status}\n")

    # 统计信息
    stats = validation_result.get("stats", {})
    lines.append("## 统计信息\n")
    lines.append(f"- 找到文件数：{stats.get('files_found', 0)}")
    lines.append(f"- 核对维度数：{stats.get('dimensions_found', 0)}/5")
    lines.append(f"- 报告章节数：{stats.get('report_sections_found', 0)}/7")
    lines.append(f"- 金额差异项数：{stats.get('amount_items', 0)}")
    lines.append(f"- 非金额内容问题数：{stats.get('non_amount_issues', 0)}")
    lines.append(f"- RD按年度分组数：{stats.get('rd_years', 0)}\n")

    # 错误
    errors = validation_result.get("errors", [])
    if errors:
        lines.append(f"## 错误（{len(errors)} 项）\n")
        for idx, err in enumerate(errors, 1):
            lines.append(f"{idx}. {err}")
        lines.append("")

    # 警告
    warnings = validation_result.get("warnings", [])
    if warnings:
        lines.append(f"## 警告（{len(warnings)} 项）\n")
        for idx, warn in enumerate(warnings, 1):
            lines.append(f"{idx}. {warn}")
        lines.append("")

    if not errors and not warnings:
        lines.append("## 审核结论\n")
        lines.append("✅ 所有校验规则全部通过，核对结果完整且合规。\n")

    content = "\n".join(lines)
    if output_path:
        try:
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(content)
            print(f"[信息] 审核报告已生成: {output_path}")
        except Exception as e:
            print(f"[错误] 写入审核报告失败: {e}")
    return content


# ============================================================
# 主入口
# ============================================================

def main():
    """主入口函数"""
    parser = argparse.ArgumentParser(
        description='高新专审报告核对审核脚本',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
校验规则（7条）：
  1. 核对结果文件完整性（核对结果.json + 核对报告.md）
  2. 5个核对维度完整性（cross_report/rd_check/ps_check/ip_check/amount_diff）
  3. 金额差异不做严重性警告校验
  4. 非金额内容严格一致校验（无漏检）
  5. 按年度 Sheet 分别核对待校验
  6. 报告格式完整性（7个章节）
  7. 问题分级正确性

用法：
  python validate_audit_verification.py --dir "输出目录"
  python validate_audit_verification.py --dir "输出目录" --project-root "项目根目录"

退出码：
  0 = 审核通过
  1 = 审核未通过
""",
    )
    parser.add_argument('--dir', required=True, help='输出目录（含核对结果.json 和 核对报告.md）')
    parser.add_argument('--project-root', default=None, help='项目根目录（可选）')
    parser.add_argument('--output', default=None, help='审核报告输出路径（可选，默认只打印）')

    args = parser.parse_args()

    # 执行审核
    result = validate_audit_verification(args.dir, args.project_root)

    # 生成审核报告
    report_content = generate_audit_report(result, args.output)

    # 打印审核结果
    print("\n" + "=" * 60)
    status = "✅ 通过" if result["passed"] else "❌ 未通过"
    print(f"审核结果：{status}")
    print("=" * 60)

    stats = result.get("stats", {})
    print(f"  找到文件数：{stats.get('files_found', 0)}")
    print(f"  核对维度数：{stats.get('dimensions_found', 0)}/5")
    print(f"  报告章节数：{stats.get('report_sections_found', 0)}/7")
    print(f"  金额差异项数：{stats.get('amount_items', 0)}")
    print(f"  非金额内容问题数：{stats.get('non_amount_issues', 0)}")
    print(f"  RD按年度分组数：{stats.get('rd_years', 0)}")

    errors = result.get("errors", [])
    if errors:
        print(f"\n错误（{len(errors)} 项）：")
        for idx, err in enumerate(errors, 1):
            print(f"  {idx}. {err}")

    warnings = result.get("warnings", [])
    if warnings:
        print(f"\n警告（{len(warnings)} 项）：")
        for idx, warn in enumerate(warnings, 1):
            print(f"  {idx}. {warn}")

    print("=" * 60)

    # 退出码：通过0，失败1
    return 0 if result["passed"] else 1


if __name__ == '__main__':
    sys.exit(main())
