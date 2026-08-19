#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
高新政策要求与合规校验工具（模块八）

用途：
    依据《高新技术企业认定管理办法》（国科发火〔2016〕32号）和《高新技术企业认定管理工作指引》
    （国科发火〔2016〕194号）及深圳市地方政策，对企业的8大认定条件进行合规校验，
    输出合规报告。政策依据作为独立JSON配置文件（policy_shenzhen.json），技能执行时读取配置
    而非内嵌到代码中，防止上下文过长。

配置文件路径：
    _common/policy_shenzhen.json（基于 __file__ 推断，向上5级回退查找）

八大认定条件（均嵌入JSON配置）：
    1. 企业注册成立满一年（一票否决）
    2. 自主知识产权（I类≥1项 或 II类≥5项）（一票否决）
    3. 核心技术属于国家支持的高新技术领域8大领域之一（一票否决）
    4. 科技人员占比≥10%（一票否决）
    5. 研发费用占比达标（按销售收入分档3%/4%/5%）（一票否决）
    6. 高新技术产品收入占比≥60%（一票否决）
    7. 企业创新能力评价≥70分（知识产权30+成果转化30+研发组织管理20+企业成长20）
    8. 前一年内无重大安全/质量事故/严重环境违法/严重失信（一票否决）

CLI 用法：
    # 校验8大认定条件
    python policy_compliance.py validate --project-root "项目根目录"

    # 生成合规报告
    python policy_compliance.py report --project-root "项目根目录" --output "报告路径"

输出：
    main() 返回并打印 JSON 格式结果：{"passed": bool, "errors": [...], "warnings": [...]}
"""

import os
import json
import argparse
from datetime import datetime, timedelta

# 政策配置文件路径（脚本位于 _common 目录下，配置文件同目录）
POLICY_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'policy_shenzhen.json')


def load_policy_config(region='shenzhen'):
    """加载政策配置文件（v1.9.0新增）

    从独立JSON配置文件读取政策依据，避免内嵌到SKILL.md导致上下文过长。

    Args:
        region: 地区（默认shenzhen，当前只支持深圳）

    Returns:
        dict: 政策配置字典，包含eight_conditions/quantitative_thresholds/shenzhen_specific/tech_fields等
    """
    config_path = POLICY_CONFIG_PATH
    if not os.path.exists(config_path):
        # 回退查找：从当前工作目录逐级向上查找 .trae/skills/_common/policy_shenzhen.json
        current_dir = os.getcwd()
        for _ in range(5):
            candidate = os.path.join(current_dir, '.trae', 'skills', '_common', 'policy_shenzhen.json')
            if os.path.exists(candidate):
                config_path = candidate
                break
            current_dir = os.path.dirname(current_dir)

    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    return config


def validate_policy_compliance(enterprise_data, analysis_results=None, policy_config=None):
    """政策合规统一校验函数（v1.9.0新增）

    校验8大认定条件，输出合规报告。每个条件含政策依据、定量阈值、校验结果。

    Args:
        enterprise_data: 企业数据dict，包含：
            - register_date: 注册日期（YYYY-MM-DD）
            - declaration_date: 申报日期（YYYY-MM-DD）
            - ip_list: 知识产权清单 [{ip_id, ip_class(I/II), ip_name, auth_date}]
            - tech_field: 技术领域（8大领域之一）
            - total_staff: 职工总数
            - rnd_staff: 科技人员数
            - staff_work_days: {员工ID: 累计工作天数}
            - annual_sales: 近三年销售收入列表 [year1, year2, year3]
            - rnd_expense_total: 近三年研发费用总额
            - rnd_expense_domestic: 境内研发费用
            - high_tech_revenue: 高新技术产品收入
            - total_revenue: 总收入
            - innovation_scores: {ip_score, transform_score, management_score, growth_score}
            - has_major_safety_accident: 是否有重大安全事故
            - has_major_quality_accident: 是否有重大质量事故
            - has_serious_environmental_violation: 是否有严重环境违法
            - has_serious_dishonesty: 是否有严重失信
        analysis_results: 资料分析结果（可选，用于补充校验数据）
        policy_config: 政策配置（可选，默认自动加载）

    Returns:
        dict: {
            'all_passed': bool,  # 是否全部通过（一票否决项全通过且总分≥70）
            'total_score': float,  # 创新能力总分
            'conditions': list,  # 8大条件校验结果
            'veto_failed': list,  # 一票否决未通过项
            'report': str,  # 合规报告文本
            'policy_basis': str,  # 政策依据
        }
    """
    if policy_config is None:
        policy_config = load_policy_config()

    conditions_result = []
    veto_failed = []

    for condition in policy_config.get('eight_conditions', []):
        cid = condition['condition_id']
        cname = condition['condition_name']
        is_veto = condition.get('is_veto', False)
        func_name = condition.get('validation_function', '')
        basis = condition.get('policy_basis', '')

        result = {
            'condition_id': cid,
            'condition_name': cname,
            'policy_basis': basis,
            'is_veto': is_veto,
            'passed': True,
            'detail': '',
            'actual_value': None,
            'required_value': None,
        }

        # 条件1：注册满一年
        if cid == 1:
            register_date = enterprise_data.get('register_date', '')
            decl_date = enterprise_data.get('declaration_date', datetime.now().strftime('%Y-%m-%d'))
            if register_date:
                try:
                    reg_dt = datetime.strptime(register_date, '%Y-%m-%d')
                    decl_dt = datetime.strptime(decl_date, '%Y-%m-%d')
                    days = (decl_dt - reg_dt).days
                    result['actual_value'] = days
                    result['required_value'] = 365
                    result['passed'] = days >= 365
                    result['detail'] = f'注册日期{register_date}，距申报日期{decl_date}共{days}天'
                except ValueError:
                    result['passed'] = False
                    result['detail'] = f'注册日期格式错误: {register_date}'
            else:
                result['passed'] = False
                result['detail'] = '缺少注册日期数据'

        # 条件2：知识产权
        elif cid == 2:
            ip_list = enterprise_data.get('ip_list', [])
            class1_count = sum(1 for ip in ip_list if ip.get('ip_class') == 'I')
            class2_count = sum(1 for ip in ip_list if ip.get('ip_class') == 'II')
            result['actual_value'] = {'I类': class1_count, 'II类': class2_count}
            result['required_value'] = 'I类≥1 或 II类≥5'
            result['passed'] = class1_count >= 1 or class2_count >= 5
            result['detail'] = f'I类{class1_count}项，II类{class2_count}项'

        # 条件3：技术领域
        elif cid == 3:
            tech_field = enterprise_data.get('tech_field', '')
            valid_fields = [f['name'] for f in policy_config.get('tech_fields', [])]
            result['actual_value'] = tech_field
            result['required_value'] = valid_fields
            result['passed'] = tech_field in valid_fields
            result['detail'] = f'技术领域: {tech_field}'

        # 条件4：科技人员占比
        elif cid == 4:
            total_staff = enterprise_data.get('total_staff', 0)
            rnd_staff = enterprise_data.get('rnd_staff', 0)
            ratio = rnd_staff / total_staff if total_staff > 0 else 0
            threshold = policy_config['quantitative_thresholds']['staff_ratio']['min']
            result['actual_value'] = f'{ratio:.2%}'
            result['required_value'] = f'{threshold:.0%}'
            result['passed'] = ratio >= threshold
            result['detail'] = f'科技人员{rnd_staff}人/职工总数{total_staff}人={ratio:.2%}'

        # 条件5：研发费用占比
        elif cid == 5:
            sales = enterprise_data.get('annual_sales', [0, 0, 0])
            total_sales = sum(sales) if sales else 0
            rnd_total = enterprise_data.get('rnd_expense_total', 0)
            ratio = rnd_total / total_sales if total_sales > 0 else 0

            thresholds = policy_config['quantitative_thresholds']['rnd_expense_ratio']
            if total_sales < 50000000:
                required = thresholds['below_50m']
                tier = '销售收入<5000万'
            elif total_sales < 200000000:
                required = thresholds['50m_to_200m']
                tier = '5000万≤销售收入<2亿'
            else:
                required = thresholds['above_200m']
                tier = '销售收入≥2亿'

            # 境内占比
            rnd_domestic = enterprise_data.get('rnd_expense_domestic', 0)
            domestic_ratio = rnd_domestic / rnd_total if rnd_total > 0 else 0
            domestic_required = policy_config['quantitative_thresholds']['rnd_expense_domestic_ratio']['min']

            result['actual_value'] = {'研发费用占比': f'{ratio:.2%}', '境内占比': f'{domestic_ratio:.2%}'}
            result['required_value'] = {'研发费用占比': f'{required:.0%}({tier})', '境内占比': f'{domestic_required:.0%}'}
            result['passed'] = ratio >= required and domestic_ratio >= domestic_required
            result['detail'] = f'{tier}，研发费用占比{ratio:.2%}(要求≥{required:.0%})，境内占比{domestic_ratio:.2%}(要求≥{domestic_required:.0%})'

        # 条件6：高新收入占比
        elif cid == 6:
            high_tech_rev = enterprise_data.get('high_tech_revenue', 0)
            total_rev = enterprise_data.get('total_revenue', 0)
            ratio = high_tech_rev / total_rev if total_rev > 0 else 0
            threshold = policy_config['quantitative_thresholds']['high_tech_revenue_ratio']['min']
            result['actual_value'] = f'{ratio:.2%}'
            result['required_value'] = f'{threshold:.0%}'
            result['passed'] = ratio >= threshold
            result['detail'] = f'高新收入{high_tech_rev}/总收入{total_rev}={ratio:.2%}'

        # 条件7：创新能力评价
        elif cid == 7:
            scores = enterprise_data.get('innovation_scores', {})
            ip_score = scores.get('ip_score', 0)
            transform_score = scores.get('transform_score', 0)
            mgmt_score = scores.get('management_score', 0)
            growth_score = scores.get('growth_score', 0)
            total_score = ip_score + transform_score + mgmt_score + growth_score
            threshold = policy_config['quantitative_thresholds']['innovation_score']['min']
            result['actual_value'] = f'{total_score}分(IP:{ip_score}+转化:{transform_score}+管理:{mgmt_score}+成长:{growth_score})'
            result['required_value'] = f'{threshold}分'
            result['passed'] = total_score >= threshold
            result['detail'] = result['actual_value']

        # 条件8：无重大违规
        elif cid == 8:
            has_safety = enterprise_data.get('has_major_safety_accident', False)
            has_quality = enterprise_data.get('has_major_quality_accident', False)
            has_env = enterprise_data.get('has_serious_environmental_violation', False)
            has_dishonesty = enterprise_data.get('has_serious_dishonesty', False)
            violations = []
            if has_safety: violations.append('重大安全事故')
            if has_quality: violations.append('重大质量事故')
            if has_env: violations.append('严重环境违法')
            if has_dishonesty: violations.append('严重违法失信')
            result['actual_value'] = '无' if not violations else '、'.join(violations)
            result['required_value'] = '无重大违规'
            result['passed'] = len(violations) == 0
            result['detail'] = result['actual_value']

        conditions_result.append(result)

        if is_veto and not result['passed']:
            veto_failed.append(result)

    # 创新能力总分
    innovation_scores = enterprise_data.get('innovation_scores', {})
    total_score = sum(innovation_scores.values()) if innovation_scores else 0

    all_passed = len(veto_failed) == 0 and total_score >= 70

    # 生成报告
    report_lines = [
        f'# 高新认定政策合规校验报告',
        f'',
        f'**政策依据**：{", ".join(policy_config.get("policy_sources", {}).get("national", [{}])[0].get("doc_id", ""))}',
        f'**地区**：{policy_config.get("region", "深圳市")}',
        f'**校验时间**：{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}',
        f'',
        f'## 校验结果',
        f'',
        f'- 总体结论：{"✓ 通过" if all_passed else "✗ 未通过"}',
        f'- 一票否决项：{len(veto_failed)}项未通过',
        f'- 创新能力总分：{total_score}分（要求≥70分）',
        f'',
        f'## 八大认定条件明细',
        f'',
    ]

    for r in conditions_result:
        status = '✓ 通过' if r['passed'] else ('❌ 一票否决' if r['is_veto'] else '⚠ 未达标')
        report_lines.append(f'### 条件{r["condition_id"]}：{r["condition_name"]} {status}')
        report_lines.append(f'- 政策依据：{r["policy_basis"]}')
        report_lines.append(f'- 实际值：{r["actual_value"]}')
        report_lines.append(f'- 要求值：{r["required_value"]}')
        report_lines.append(f'- 说明：{r["detail"]}')
        report_lines.append('')

    report = '\n'.join(report_lines)

    return {
        'all_passed': all_passed,
        'total_score': total_score,
        'conditions': conditions_result,
        'veto_failed': veto_failed,
        'report': report,
        'policy_basis': '国科发火〔2016〕32号 + 国科发火〔2016〕194号',
    }


def get_shenzhen_specific_requirements():
    """获取深圳市地方政策差异（v1.9.0新增）

    返回深圳市与国家政策的差异点，供技能校验时参考。

    Returns:
        dict: 深圳市地方政策差异
    """
    config = load_policy_config()
    return config.get('shenzhen_specific', {})


def validate_shenzhen_ip_policy(ip_list):
    """深圳市知识产权政策校验（v1.9.0新增）

    深圳市特殊政策：
    - I类IP有1项即可
    - II类IP可5项以上但不超过15项计分
    - 无II类知识产权占比不超过50%的限制

    Args:
        ip_list: 知识产权清单

    Returns:
        dict: 校验结果
    """
    config = load_policy_config()
    shenzhen_ip = config.get('shenzhen_specific', {}).get('ip_policy', {})

    class1_count = sum(1 for ip in ip_list if ip.get('ip_class') == 'I')
    class2_count = sum(1 for ip in ip_list if ip.get('ip_class') == 'II')

    max_class2 = shenzhen_ip.get('class2_max_count_for_scoring', 15)

    passed = class1_count >= 1 or class2_count >= 5
    scoring_warning = class2_count > max_class2

    return {
        'passed': passed,
        'class1_count': class1_count,
        'class2_count': class2_count,
        'class2_max_for_scoring': max_class2,
        'scoring_warning': scoring_warning,
        'detail': f'I类{class1_count}项，II类{class2_count}项（计分上限{max_class2}项）',
        'local_policy': shenzhen_ip.get('note', '')
    }


# ============================================================
# CLI 辅助函数
# ============================================================

def load_enterprise_data_from_project(project_root):
    """从项目根目录加载企业数据

    在项目根目录下查找企业数据JSON文件（候选文件名顺序匹配）。

    Args:
        project_root: 项目根目录

    Returns:
        tuple: (enterprise_data dict 或 None, data_source 文件路径 或 None)
    """
    # 候选文件名（按优先级）
    candidates = [
        'enterprise_data.json',
        '_enterprise_data.json',
        '.trae/enterprise_data.json',
        '.trae/_enterprise_data.json',
        '企业数据.json',
    ]

    for candidate in candidates:
        path = os.path.join(project_root, candidate)
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                return data, path
            except Exception:
                continue

    return None, None


# ============================================================
# CLI 入口
# ============================================================

def main():
    """CLI 主入口

    支持 validate/report 两个子命令，返回 JSON 格式结果：
    {"passed": bool, "errors": [...], "warnings": [...]}

    Returns:
        str: JSON 格式的执行结果
    """
    parser = argparse.ArgumentParser(
        description='高新政策要求与合规校验工具（模块八）：校验8大认定条件并生成合规报告',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
    # 校验8大认定条件
    python policy_compliance.py validate --project-root "C:\\Projects\\MyEnterprise"

    # 生成合规报告
    python policy_compliance.py report --project-root "C:\\Projects\\MyEnterprise" --output "report.md"

企业数据文件位置（任选其一，按优先级匹配）：
    {project_root}/enterprise_data.json
    {project_root}/_enterprise_data.json
    {project_root}/.trae/enterprise_data.json
    {project_root}/.trae/_enterprise_data.json
    {project_root}/企业数据.json

也可通过 --data-file 参数显式指定企业数据文件路径。
        """,
    )
    subparsers = parser.add_subparsers(dest='command', help='子命令')

    # validate 子命令
    validate_parser = subparsers.add_parser('validate', help='校验8大认定条件')
    validate_parser.add_argument('--project-root', required=True, help='项目根目录')
    validate_parser.add_argument('--data-file', help='企业数据文件路径（可选，默认从项目根目录查找）')

    # report 子命令
    report_parser = subparsers.add_parser('report', help='生成合规报告')
    report_parser.add_argument('--project-root', required=True, help='项目根目录')
    report_parser.add_argument('--output', help='报告输出路径（可选，提供则将报告写入文件）')
    report_parser.add_argument('--data-file', help='企业数据文件路径（可选）')

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        result = {'passed': False, 'errors': ['未指定子命令'], 'warnings': []}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return json.dumps(result, ensure_ascii=False)

    # 加载企业数据
    enterprise_data = None
    data_source = ''

    if getattr(args, 'data_file', None) and args.data_file:
        if os.path.exists(args.data_file):
            try:
                with open(args.data_file, 'r', encoding='utf-8') as f:
                    enterprise_data = json.load(f)
                data_source = args.data_file
            except Exception as e:
                result = {
                    'passed': False,
                    'errors': [f'企业数据文件解析失败: {e}'],
                    'warnings': [],
                }
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return json.dumps(result, ensure_ascii=False)
        else:
            result = {
                'passed': False,
                'errors': [f'指定的企业数据文件不存在: {args.data_file}'],
                'warnings': [],
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return json.dumps(result, ensure_ascii=False)
    else:
        enterprise_data, data_source = load_enterprise_data_from_project(args.project_root)

    if enterprise_data is None:
        result = {
            'passed': False,
            'errors': [
                f'未在项目根目录找到企业数据文件，请通过 --data-file 参数指定，'
                f'或在项目根目录下放置 enterprise_data.json / _enterprise_data.json / .trae/enterprise_data.json'
            ],
            'warnings': [],
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return json.dumps(result, ensure_ascii=False)

    # 执行校验
    try:
        validation = validate_policy_compliance(enterprise_data)
    except Exception as e:
        result = {
            'passed': False,
            'errors': [f'校验过程异常: {e}'],
            'warnings': [],
            'data_source': data_source,
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return json.dumps(result, ensure_ascii=False)

    # 收集错误和警告
    errors = []
    warnings = []
    for cond in validation['conditions']:
        if not cond['passed']:
            msg = f"[条件{cond['condition_id']}] {cond['condition_name']}: {cond['detail']}"
            if cond['is_veto']:
                errors.append(msg)
            else:
                warnings.append(msg)

    # 一票否决未通过也算错误
    for v in validation['veto_failed']:
        msg = f"[一票否决] 条件{v['condition_id']}: {v['condition_name']} - {v['detail']}"
        if msg not in errors:
            errors.append(msg)

    # 创新能力总分不达标作为警告
    if validation['total_score'] < 70 and not any('创新能力' in e for e in errors):
        warnings.append(f"创新能力总分 {validation['total_score']} 分，未达到 70 分要求")

    if args.command == 'validate':
        result = {
            'passed': validation['all_passed'],
            'total_score': validation['total_score'],
            'errors': errors,
            'warnings': warnings,
            'conditions': validation['conditions'],
            'data_source': data_source,
        }

    elif args.command == 'report':
        report_text = validation['report']

        # 如果指定输出路径，写入文件
        output_path = None
        if args.output:
            out_dir = os.path.dirname(os.path.abspath(args.output))
            os.makedirs(out_dir, exist_ok=True)
            with open(args.output, 'w', encoding='utf-8') as f:
                f.write(report_text)
            output_path = args.output

        result = {
            'passed': validation['all_passed'],
            'total_score': validation['total_score'],
            'errors': errors,
            'warnings': warnings,
            'report_path': output_path,
            'report_text': report_text,
            'data_source': data_source,
        }

    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return json.dumps(result, ensure_ascii=False, default=str)


if __name__ == '__main__':
    main()
