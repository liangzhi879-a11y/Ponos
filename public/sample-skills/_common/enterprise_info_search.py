#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
企业基本信息联网搜索工具（模块九）

用途：
    通过联网搜索补充企业基本信息（注册时间、经营范围、简介、官方网站等），减少客户手动填写工作量。

设计思路：
    本脚本只做数据整理和输出，实际搜索由 agent 调用 WebSearch/WebFetch 工具完成。
    工作流程：
        1. agent 调用本脚本 search 命令生成搜索指南
        2. agent 按指南执行 WebSearch 搜索
        3. agent 将搜索结果文本保存到文件，通过 --results-file 参数传给本脚本解析
        4. 本脚本调用 parse_enterprise_info_from_search 解析结果
        5. 合并到企业信息中

可补充的信息：
    - 企业全称、曾用名
    - 注册时间、注册资本
    - 法定代表人
    - 经营范围
    - 企业简介
    - 官方网站
    - 联系方式
    - 所属行业
    - 统一社会信用代码

信息来源：
    - 企查查/天眼查公开信息
    - 国家企业信用信息公示系统
    - 企业官方网站
    - 上市公司公告（如适用）

CLI 用法：
    # 生成企业信息搜索指南
    python enterprise_info_search.py search --enterprise "企业名称"

    # 生成搜索指南并解析已有的搜索结果文件
    python enterprise_info_search.py search --enterprise "企业名称" --results-file "搜索结果.txt"

    # 补充项目中的企业信息（生成缺失字段补充指南）
    python enterprise_info_search.py enrich --project-root "项目根目录"

输出：
    main() 返回并打印 JSON 格式结果。
"""

import os
import re
import json
import argparse
from datetime import datetime


def search_enterprise_info(enterprise_name, search_keywords=None):
    """联网搜索企业基本信息（v1.9.0新增）

    通过WebSearch工具搜索企业公开信息，补充收资清单中需要客户手动填写的字段。

    ⚠️ 本函数需要agent调用WebSearch工具，函数本身只构造搜索查询和建议，
    实际搜索由agent在技能执行时完成。

    Args:
        enterprise_name: 企业全称
        search_keywords: 额外搜索关键词列表（可选）

    Returns:
        dict: {
            'search_queries': list,  # 建议的搜索查询列表
            'info_fields': list,  # 需要补充的字段列表
            'search_guide': str,  # 搜索指南文本
            'parse_guide': str,  # 解析指南
        }
    """
    # 构造搜索查询
    queries = [
        f'{enterprise_name} 企业信息 注册时间 经营范围',
        f'{enterprise_name} 统一社会信用代码 法定代表人',
        f'{enterprise_name} 官网 企业简介',
        f'{enterprise_name} 企查查',
        f'{enterprise_name} 天眼查',
    ]

    if search_keywords:
        for kw in search_keywords:
            queries.append(f'{enterprise_name} {kw}')

    # 需要补充的字段
    info_fields = [
        {'field': 'enterprise_full_name', 'label': '企业全称', 'source': '工商注册信息', 'required': True},
        {'field': 'former_name', 'label': '曾用名', 'source': '工商注册信息', 'required': False},
        {'field': 'register_date', 'label': '注册日期', 'source': '工商注册信息', 'required': True, 'policy_basis': '条件1：注册满一年'},
        {'field': 'register_capital', 'label': '注册资本', 'source': '工商注册信息', 'required': True},
        {'field': 'legal_representative', 'label': '法定代表人', 'source': '工商注册信息', 'required': True},
        {'field': 'business_scope', 'label': '经营范围', 'source': '工商注册信息', 'required': True},
        {'field': 'unified_social_credit_code', 'label': '统一社会信用代码', 'source': '工商注册信息', 'required': True},
        {'field': 'official_website', 'label': '官方网站', 'source': '搜索结果', 'required': False},
        {'field': 'enterprise_intro', 'label': '企业简介', 'source': '企业官网/公开资料', 'required': False},
        {'field': 'contact_info', 'label': '联系方式', 'source': '企业官网', 'required': False},
        {'field': 'industry', 'label': '所属行业', 'source': '工商注册信息', 'required': True},
        {'field': 'enterprise_type', 'label': '企业类型', 'source': '工商注册信息', 'required': True},
        {'field': 'address', 'label': '注册地址', 'source': '工商注册信息', 'required': True},
    ]

    search_guide = f"""# 企业信息联网搜索指南

## 搜索目标企业：{enterprise_name}

## 搜索查询（按顺序执行）
"""
    for i, q in enumerate(queries, 1):
        search_guide += f"{i}. {q}\n"

    search_guide += f"""
## 需要补充的字段（{len(info_fields)}项）
"""
    for f in info_fields:
        required_mark = '★必须' if f['required'] else '可选'
        basis = f.get('policy_basis', '')
        basis_str = f'（{basis}）' if basis else ''
        search_guide += f"- [{required_mark}] {f['label']}（{f['source']}）{basis_str}\n"

    parse_guide = """## 信息解析规则

1. **注册日期**：从工商信息提取，格式YYYY-MM-DD
2. **注册资本**：提取数字+单位（万元/元）
3. **经营范围**：完整提取，用于判断技术领域归属
4. **统一社会信用代码**：18位代码
5. **官方网站**：提取URL，验证可访问性
6. **企业简介**：提取前500字，用于申报书"企业简介"部分

## 搜索结果可信度判断
- 企查查/天眼查：高可信度（工商数据源）
- 国家企业信用信息公示系统：最高可信度（官方）
- 企业官网：中可信度（需交叉验证）
- 第三方报道：低可信度（需交叉验证）
"""

    return {
        'search_queries': queries,
        'info_fields': info_fields,
        'search_guide': search_guide,
        'parse_guide': parse_guide,
    }


def parse_enterprise_info_from_search(search_results, enterprise_name):
    """从搜索结果解析企业信息（v1.9.0新增）

    将WebSearch/WebFetch返回的搜索结果文本解析为结构化企业信息。

    Args:
        search_results: 搜索结果文本列表
        enterprise_name: 企业名称

    Returns:
        dict: 解析后的企业信息
    """
    parsed = {
        'enterprise_full_name': enterprise_name,
        'former_name': None,
        'register_date': None,
        'register_capital': None,
        'legal_representative': None,
        'business_scope': None,
        'unified_social_credit_code': None,
        'official_website': None,
        'enterprise_intro': None,
        'industry': None,
        'enterprise_type': None,
        'address': None,
        'parse_confidence': {},
    }

    all_text = '\n'.join(search_results) if isinstance(search_results, list) else str(search_results)

    # 解析统一社会信用代码（18位字母数字）
    code_match = re.search(r'统一社会信用代码[：:]\s*([0-9A-Z]{18})', all_text)
    if code_match:
        parsed['unified_social_credit_code'] = code_match.group(1)
        parsed['parse_confidence']['unified_social_credit_code'] = 'high'
    else:
        # 尝试匹配18位代码
        code_match2 = re.search(r'\b([0-9A-Z]{18})\b', all_text)
        if code_match2:
            parsed['unified_social_credit_code'] = code_match2.group(1)
            parsed['parse_confidence']['unified_social_credit_code'] = 'medium'

    # 解析注册日期
    date_match = re.search(r'成立日期[：:]\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})', all_text)
    if date_match:
        date_str = date_match.group(1).replace('年', '-').replace('月', '-').replace('/', '-')
        parsed['register_date'] = date_str
        parsed['parse_confidence']['register_date'] = 'high'
    else:
        date_match2 = re.search(r'(\d{4}[-/]\d{1,2}[-/]\d{1,2}).*成立', all_text)
        if date_match2:
            parsed['register_date'] = date_match2.group(1).replace('/', '-')
            parsed['parse_confidence']['register_date'] = 'medium'

    # 解析注册资本
    capital_match = re.search(r'注册资本[：:]\s*([\d,.]+)\s*(万?元)', all_text)
    if capital_match:
        parsed['register_capital'] = f'{capital_match.group(1)}{capital_match.group(2)}'
        parsed['parse_confidence']['register_capital'] = 'high'

    # 解析法定代表人
    legal_match = re.search(r'法定代表人[：:]\s*([\u4e00-\u9fa5]{2,4})', all_text)
    if legal_match:
        parsed['legal_representative'] = legal_match.group(1)
        parsed['parse_confidence']['legal_representative'] = 'high'

    # 解析经营范围
    scope_match = re.search(r'经营范围[：:]\s*(.+?)(?:\n|$)', all_text)
    if scope_match:
        parsed['business_scope'] = scope_match.group(1).strip()
        parsed['parse_confidence']['business_scope'] = 'high'

    # 解析官方网站
    url_match = re.search(r'(?:官网|官方网站|网站)[：:]\s*(https?://[^\s]+)', all_text, re.IGNORECASE)
    if url_match:
        parsed['official_website'] = url_match.group(1)
        parsed['parse_confidence']['official_website'] = 'high'
    else:
        url_match2 = re.search(r'(https?://(?:www\.)?' + re.escape(enterprise_name[:4]) + r'[^\s]+)', all_text, re.IGNORECASE)
        if url_match2:
            parsed['official_website'] = url_match2.group(1)
            parsed['parse_confidence']['official_website'] = 'medium'

    # 解析企业简介
    intro_match = re.search(r'(?:简介|企业简介|公司简介)[：:]\s*(.+?)(?:\n\n|\n##|\n#|$)', all_text, re.DOTALL)
    if intro_match:
        intro = intro_match.group(1).strip()
        parsed['enterprise_intro'] = intro[:500] if len(intro) > 500 else intro
        parsed['parse_confidence']['enterprise_intro'] = 'high'

    # 解析企业类型
    type_match = re.search(r'企业类型[：:]\s*(.+?)(?:\n|$)', all_text)
    if type_match:
        parsed['enterprise_type'] = type_match.group(1).strip()
        parsed['parse_confidence']['enterprise_type'] = 'high'

    return parsed


def supplement_enterprise_info_from_search(enterprise_name, existing_info=None):
    """通过联网搜索补充企业信息（v1.9.0新增，供agent调用）

    ⚠️ 本函数生成搜索指南，实际搜索由agent执行WebSearch工具完成。
    Agent调用流程：
    1. 调用本函数获取搜索指南
    2. 按指南执行WebSearch搜索
    3. 调用parse_enterprise_info_from_search解析结果
    4. 合并到existing_info中

    Args:
        enterprise_name: 企业名称
        existing_info: 已有企业信息（可选，用于标记缺失字段）

    Returns:
        dict: {
            'search_guide': str,  # 搜索指南
            'missing_fields': list,  # 缺失字段
            'agent_instruction': str,  # agent执行指令
        }
    """
    search_result = search_enterprise_info(enterprise_name)

    # 找出缺失字段
    missing_fields = []
    if existing_info:
        for field_info in search_result['info_fields']:
            field_name = field_info['field']
            if not existing_info.get(field_name):
                missing_fields.append(field_info)
    else:
        missing_fields = search_result['info_fields']

    agent_instruction = f"""# 企业信息联网搜索执行指令

## 搜索目标
企业名称：{enterprise_name}

## 缺失字段（{len(missing_fields)}项需补充）
"""
    for f in missing_fields:
        required_mark = '★必须' if f['required'] else '可选'
        basis = f.get('policy_basis', '')
        basis_str = f'（{basis}）' if basis else ''
        agent_instruction += f"- [{required_mark}] {f['label']}（来源：{f['source']}）{basis_str}\n"

    agent_instruction += f"""
## 执行步骤
1. 对以下查询依次执行WebSearch搜索：
"""
    for i, q in enumerate(search_result['search_queries'], 1):
        agent_instruction += f"   {i}. \"{q}\"\n"

    agent_instruction += """
2. 对搜索结果中包含企业工商信息的网页，使用WebFetch获取详细内容
3. 调用parse_enterprise_info_from_search解析搜索结果
4. 将解析结果合并到企业信息中
5. 标记信息来源和可信度

## 注意事项
- 优先采信国家企业信用信息公示系统、企查查、天眼查的数据
- 企业官网信息需交叉验证
- 注册日期、统一社会信用代码为高新认定条件1的校验依据，必须准确
"""

    return {
        'search_guide': search_result['search_guide'],
        'missing_fields': missing_fields,
        'agent_instruction': agent_instruction,
        'info_fields': search_result['info_fields'],
    }


# ============================================================
# CLI 辅助函数
# ============================================================

def load_enterprise_info_from_project(project_root):
    """从项目根目录加载已有企业信息

    在项目根目录下查找企业信息JSON文件（候选文件名顺序匹配）。

    Args:
        project_root: 项目根目录

    Returns:
        tuple: (enterprise_info dict 或 None, data_source 文件路径 或 None)
    """
    # 候选文件名（按优先级）
    candidates = [
        'enterprise_info.json',
        '_enterprise_info.json',
        'enterprise_data.json',
        '_enterprise_data.json',
        '.trae/enterprise_info.json',
        '.trae/enterprise_data.json',
        '企业信息.json',
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

    支持 search/enrich 两个子命令，返回 JSON 格式结果。

    Returns:
        str: JSON 格式的执行结果
    """
    parser = argparse.ArgumentParser(
        description='企业基本信息联网搜索工具（模块九）：生成搜索指南、解析搜索结果、补充企业信息',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
    # 生成企业信息搜索指南
    python enterprise_info_search.py search --enterprise "深圳某某科技有限公司"

    # 生成搜索指南并解析已有的搜索结果文件
    python enterprise_info_search.py search --enterprise "深圳某某科技有限公司" --results-file "search_results.txt"

    # 补充项目中的企业信息（基于已有信息生成缺失字段补充指南）
    python enterprise_info_search.py enrich --project-root "C:\\Projects\\MyEnterprise"

    # 补充项目中的企业信息并解析搜索结果
    python enterprise_info_search.py enrich --project-root "C:\\Projects\\MyEnterprise" --results-file "search_results.txt"

说明：
    - 联网搜索功能由 agent 调用 WebSearch 工具完成，本脚本只做数据整理和输出。
    - --results-file 参数用于传入 agent 已执行的搜索结果文本文件，脚本会解析为结构化信息。
        """,
    )
    subparsers = parser.add_subparsers(dest='command', help='子命令')

    # search 子命令
    search_parser = subparsers.add_parser('search', help='生成企业信息搜索指南')
    search_parser.add_argument('--enterprise', required=True, help='企业名称')
    search_parser.add_argument('--results-file', help='搜索结果文件路径（可选，提供则解析结果）')
    search_parser.add_argument('--output', help='输出文件路径（可选，提供则将结果写入文件）')
    search_parser.add_argument('--keywords', help='额外搜索关键词，逗号分隔（可选）')

    # enrich 子命令
    enrich_parser = subparsers.add_parser('enrich', help='补充项目中的企业信息')
    enrich_parser.add_argument('--project-root', required=True, help='项目根目录')
    enrich_parser.add_argument('--results-file', help='搜索结果文件路径（可选）')
    enrich_parser.add_argument('--output', help='输出文件路径（可选）')
    enrich_parser.add_argument('--enterprise', help='企业名称（可选，默认从项目信息文件读取）')

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        result = {'success': False, 'error': '未指定子命令'}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return json.dumps(result, ensure_ascii=False)

    result = {}

    # ------------------- search 子命令 -------------------
    if args.command == 'search':
        # 解析额外关键词
        extra_keywords = None
        if args.keywords:
            extra_keywords = [k.strip() for k in args.keywords.split(',') if k.strip()]

        # 生成搜索指南
        search_info = search_enterprise_info(args.enterprise, search_keywords=extra_keywords)

        result = {
            'success': True,
            'enterprise': args.enterprise,
            'search_queries': search_info['search_queries'],
            'info_fields': search_info['info_fields'],
            'search_guide': search_info['search_guide'],
            'parse_guide': search_info['parse_guide'],
        }

        # 如果提供了搜索结果文件，则解析
        if args.results_file and os.path.exists(args.results_file):
            try:
                with open(args.results_file, 'r', encoding='utf-8') as f:
                    search_results = f.read()
                parsed = parse_enterprise_info_from_search(search_results, args.enterprise)
                result['parsed_info'] = parsed
                result['parsed_confidence'] = parsed.get('parse_confidence', {})
            except Exception as e:
                result['parse_error'] = f'搜索结果解析失败: {e}'
        elif args.results_file and not os.path.exists(args.results_file):
            result['parse_error'] = f'搜索结果文件不存在: {args.results_file}'

    # ------------------- enrich 子命令 -------------------
    elif args.command == 'enrich':
        # 从项目根目录加载企业信息
        enterprise_info, data_source = load_enterprise_info_from_project(args.project_root)

        # 确定企业名称
        enterprise_name = ''
        if args.enterprise:
            enterprise_name = args.enterprise
        elif enterprise_info:
            enterprise_name = enterprise_info.get('enterprise_full_name') or enterprise_info.get('enterprise_name', '')

        if not enterprise_name:
            result = {
                'success': False,
                'error': '未找到企业名称，请通过 --enterprise 参数指定，或在项目信息文件中设置 enterprise_full_name 字段',
                'project_root': args.project_root,
                'data_source': data_source,
            }
        else:
            # 生成补充指南
            supplement = supplement_enterprise_info_from_search(enterprise_name, enterprise_info)

            result = {
                'success': True,
                'enterprise': enterprise_name,
                'project_root': args.project_root,
                'data_source': data_source,
                'existing_info': enterprise_info,
                'missing_fields': supplement['missing_fields'],
                'missing_count': len(supplement['missing_fields']),
                'search_guide': supplement['search_guide'],
                'agent_instruction': supplement['agent_instruction'],
                'info_fields': supplement['info_fields'],
            }

            # 如果提供了搜索结果文件，则解析
            if args.results_file and os.path.exists(args.results_file):
                try:
                    with open(args.results_file, 'r', encoding='utf-8') as f:
                        search_results = f.read()
                    parsed = parse_enterprise_info_from_search(search_results, enterprise_name)

                    # 合并到已有信息（解析结果优先）
                    merged_info = {}
                    if enterprise_info:
                        merged_info.update(enterprise_info)
                    # 只合并非None的解析结果
                    for k, v in parsed.items():
                        if k == 'parse_confidence':
                            continue
                        if v is not None:
                            merged_info[k] = v

                    result['parsed_info'] = parsed
                    result['merged_info'] = merged_info
                    result['parsed_confidence'] = parsed.get('parse_confidence', {})
                except Exception as e:
                    result['parse_error'] = f'搜索结果解析失败: {e}'
            elif args.results_file and not os.path.exists(args.results_file):
                result['parse_error'] = f'搜索结果文件不存在: {args.results_file}'

    # 如果指定输出路径，写入文件
    if args.output and result.get('success'):
        out_dir = os.path.dirname(os.path.abspath(args.output))
        os.makedirs(out_dir, exist_ok=True)
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2, default=str)
        result['output_path'] = args.output

    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return json.dumps(result, ensure_ascii=False, default=str)


if __name__ == '__main__':
    main()
