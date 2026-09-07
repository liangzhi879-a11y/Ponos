#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""溯源核验模块 - 以官方源文件提取值为基准，强制矫正LLM输出中的偏离

核心功能：
    1. set_provenance()    — 技能从官方文件提取到关键字段值时，立即记录溯源
    2. get_provenance()    — 获取当前项目的所有溯源记录
    3. verify_against_provenance() — 扫描输出文本，用溯源值矫正所有偏离

设计原则：
    - provenance 记录的是 source document 中的实际值（不是标准术语）
    - 核验时逐字段比对：输出中任何不等于 provenance 值的写法都视为偏离
    - 两层防护：Layer1 provenance溯源核验 → Layer2 authoritative_terms.json 静态术语兜底

用法示例：
    # 技能从所得税申报表提取到技术领域后
    from provenance_manager import set_provenance, verify_against_provenance

    set_provenance(
        project_root="D:\\项目",
        field_name="tech_field_l1",
        value="新能源与节能",
        source="企业所得税年度纳税申报表",
        source_file="9.前三年企业所得税纳税申报表/2022企业所得税年度纳税申报表.pdf",
    )

    # 输出前核验
    output_text = "该项目属于新能源及节能领域..."
    corrected, corrections = verify_against_provenance(output_text, project_root)
    # corrected = "该项目属于新能源与节能领域..."
    # corrections = [{"field": "tech_field_l1", "original": "新能源及节能", "corrected": "新能源与节能"}]
"""

import os
import re
import json
import sys
from datetime import datetime
from pathlib import Path


# ============================================================
# 溯源字段注册表 — 哪些字段需要从官方文件提取并强制精确匹配
# ============================================================

PROVENANCE_FIELDS = {
    # === 一票否决级（名称错误直接导致项目核验无效）===
    "tech_field_l1": {
        "label": "技术领域（一级）",
        "source_hint": "企业所得税年度纳税申报表 → 高新技术企业情况附表 → 高新技术企业领域",
        "fallback_source": "高新技术企业认定申请书 → 企业基本情况 → 技术领域",
        "veto": True,
        "extraction_regex": r"高新技术领域[：:]\s*([^\n\r]+)",
    },
    "tech_field_l2": {
        "label": "技术领域（二级）",
        "source_hint": "同上",
        "veto": False,
    },
    "tech_field_l3": {
        "label": "技术领域（三级）",
        "source_hint": "同上",
        "veto": False,
    },

    # === 关键身份字段 ===
    "enterprise_name": {
        "label": "企业全称",
        "source_hint": "营业执照 → 名称",
        "veto": True,
        "extraction_regex": r"名称[：:]\s*([^\n\r]+)",
    },
    "unified_social_credit_code": {
        "label": "统一社会信用代码",
        "source_hint": "营业执照 → 统一社会信用代码",
        "veto": False,
        "extraction_regex": r"统一社会信用代码[：:]\s*([A-Za-z0-9]{18})",
    },
    "register_date": {
        "label": "成立日期",
        "source_hint": "营业执照 → 成立日期",
        "veto": False,
    },

    # === 财务关键字段 ===
    "high_tech_revenue": {
        "label": "高新技术产品收入",
        "source_hint": "上年度高新产品（服务）收入专项审计报告",
        "veto": False,
    },
    "total_revenue": {
        "label": "总收入",
        "source_hint": "前三年财务审计报告 → 利润表",
        "veto": False,
    },
    "rnd_expense_total": {
        "label": "近三年研发费用总额",
        "source_hint": "前三年研发费用专项审计报告",
        "veto": False,
    },
    "staff_count": {
        "label": "职工总数",
        "source_hint": "上年12月社保缴费记录 / 员工花名册",
        "veto": False,
    },
    "tech_staff_count": {
        "label": "科技人员数",
        "source_hint": "科技人员清单",
        "veto": False,
    },
}


def _get_project_root(project_root=None):
    """获取项目根目录"""
    if project_root:
        return Path(project_root)
    cwd = Path.cwd()
    for p in [cwd] + list(cwd.parents):
        if (p / '.trae').exists():
            return p
    return cwd


def _get_project_index_path(project_root=None):
    """获取 project_index.json 路径"""
    root = _get_project_root(project_root)
    idx_path = root / '.trae' / 'project_index.json'
    return idx_path


def _load_project_index(project_root=None):
    """加载 project_index.json"""
    idx_path = _get_project_index_path(project_root)
    if not idx_path.exists():
        return None
    try:
        with open(idx_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _save_project_index(project_index, project_root=None):
    """保存 project_index.json"""
    idx_path = _get_project_index_path(project_root)
    idx_path.parent.mkdir(parents=True, exist_ok=True)
    project_index['last_updated'] = datetime.now().isoformat()
    with open(idx_path, 'w', encoding='utf-8') as f:
        json.dump(project_index, f, ensure_ascii=False, indent=2)


# ============================================================
# 核心 API
# ============================================================

def set_provenance(field_name, value, source, source_file,
                   project_root=None, extraction_method="pdf_text_extraction"):
    """记录一个字段的溯源信息 — 技能从官方文件提取到值后立即调用

    会自动写入 project_index.json 的 provenance 节。

    Args:
        field_name: 字段名（如 tech_field_l1, enterprise_name）
        value: 从源文件中提取到的实际值
        source: 来源类型（如 income_tax_return, business_license）
        source_file: 来源文件路径（相对于项目根目录）
        project_root: 项目根目录
        extraction_method: 提取方式（pdf_text_extraction / ocr / manual）

    Returns:
        bool: 写入成功 True
    """
    if not value or not str(value).strip():
        print(f'[provenance] WARN: {field_name} 值为空，跳过溯源记录')
        return False

    value = str(value).strip()
    project_index = _load_project_index(project_root)

    if project_index is None:
        root = _get_project_root(project_root)
        project_index = {
            'enterprise': '',
            'application_year': 0,
            'created_at': datetime.now().isoformat(),
            'skills_progress': {},
            'provenance': {},
        }

    project_index.setdefault('provenance', {})

    now = datetime.now().isoformat(timespec='seconds')
    project_index['provenance'][field_name] = {
        'value': value,
        'source': source,
        'source_file': source_file,
        'extraction_method': extraction_method,
        'extracted_at': now,
        'last_verified_at': now,
        'verified': True,
    }

    _save_project_index(project_index, project_root)

    field_label = PROVENANCE_FIELDS.get(field_name, {}).get('label', field_name)
    print(f'[provenance] ✓ {field_label} = "{value}" (来源: {source_file})')
    return True


def get_provenance(project_root=None):
    """获取当前项目的所有溯源记录

    Returns:
        dict: {field_name: {value, source, source_file, ...}, ...}
        无溯源记录时返回 {}
    """
    project_index = _load_project_index(project_root)
    if not project_index:
        return {}
    return project_index.get('provenance', {})


def get_provenance_value(field_name, project_root=None):
    """获取单个溯源字段的值

    Returns:
        str or None
    """
    provenance = get_provenance(project_root)
    field = provenance.get(field_name, {})
    return field.get('value')


def has_provenance(field_name, project_root=None):
    """检查某个字段是否有溯源记录"""
    return get_provenance_value(field_name, project_root) is not None


def list_provenance_fields(project_root=None):
    """列出所有已记录的溯源字段

    Returns:
        list of str
    """
    return list(get_provenance(project_root).keys())


# ============================================================
# 变异检测 — 在文本中找到与溯源值"语义相同但词法不同"的片段
# ============================================================

def _generate_variations(value):
    """生成一个值可能的LLM变异形式（用于在文本中搜索偏离）

    覆盖LLM常见的改写模式：连词替换、后缀脱落、同义词替换、截断等。
    """
    variations = []

    # 1. 连词替换：「与」↔「及」↔「和」
    for old, new in [('与', '及'), ('与', '和'), ('及', '与'), ('及', '和'), ('和', '与'), ('和', '及')]:
        varied = value.replace(old, new)
        if varied != value:
            variations.append(varied)

    # 2. 末尾加后缀（LLM扩写）
    for suffix in ['技术', '业', '领域', '方向', '范畴']:
        if not value.endswith(suffix):
            variations.append(value + suffix)

    # 3. 去末尾后缀（LLM缩写）
    for suffix in ['技术', '科技', '业', '领域', '方向', '范畴',
                   '有限公司', '有限责任公司', '股份有限公司',
                   '（深圳）', '(深圳)', '（北京）', '(北京)']:
        if value.endswith(suffix):
            variations.append(value[:-len(suffix)])

    # 4. 末尾同义词替换（技术→科技, 科技→技术）
    for old_suffix, new_suffix in [('技术', '科技'), ('科技', '技术'), ('工程', '技术'), ('方法', '方式')]:
        if value.endswith(old_suffix):
            variations.append(value[:-len(old_suffix)] + new_suffix)

    # 5. 中间词替换（用于企业名称中的括号/空格变化）
    for old, new in [('（', '('), ('）', ')'), (' ', ''), ('\u3000', ''), ('-', '－'), ('－', '-')]:
        varied = value.replace(old, new)
        if varied != value:
            variations.append(varied)

    # 6. 缺失中间词（企业名称常见截断）
    if '有限公司' in value:
        idx = value.index('有限公司')
        base = value[:idx]
        if base and base != value:
            variations.append(base)  # "深圳派成铝业科技有限公司" → "深圳派成铝业科技"

    # 7. 插入空格
    spaced = ''.join(c + (' ' if i < len(value) - 1 and c != ' ' else '') for i, c in enumerate(value))
    variations.append(spaced)

    # 8. 常见错别字
    typo_map = {'技': '枝', '术': '朮', '与': '予', '铝': '侣', '能': '熊'}
    for correct, wrong in typo_map.items():
        if correct in value:
            variations.append(value.replace(correct, wrong))

    # 去重，过滤过短变异
    seen = {value}
    result = []
    for v in variations:
        if v not in seen and len(v) >= 2:
            seen.add(v)
            result.append(v)

    # 按长度降序（优先匹配长词）
    result.sort(key=len, reverse=True)
    return result


def _compute_similarity(a, b):
    """计算两个字符串的相似度（基于编辑距离）"""
    a = a.replace(' ', '').replace('\u3000', '')
    b = b.replace(' ', '').replace('\u3000', '')
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0

    # Levenshtein distance
    m, n = len(a), len(b)
    if m > n:
        a, b = b, a
        m, n = n, m

    # 快速路径：长度差异过大直接返回低相似度
    if n == 0:
        return 0.0
    if m == 0:
        return 0.0

    # 使用两行DP（节省空间）
    prev = list(range(n + 1))
    curr = [0] * (n + 1)
    for i in range(1, m + 1):
        curr[0] = i
        for j in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        prev, curr = curr, prev

    distance = prev[n]
    max_len = max(m, n)
    return 1.0 - (distance / max_len)


# ============================================================
# 溯源核验 — 核心算法
# ============================================================

def verify_against_provenance(text, project_root=None):
    """以溯源值为基准，扫描文本并矫正所有偏离

    对每个 provenance 字段，在输出文本中搜索语义相同但词法不同的片段，
    替换为 provenance 中记录的精确值。

    Args:
        text: 待核验的文本（技能输出内容）
        project_root: 项目根目录

    Returns:
        tuple: (corrected_text, corrections_list)
            corrected_text: 矫正后的文本
            corrections_list: [
                {"field": str, "source_value": str, "found": str, "source_file": str, "severity": str},
                ...
            ]
    """
    provenance = get_provenance(project_root)
    if not provenance:
        return text, []

    corrected = text
    corrections = []

    # 按 veto 权重排序：veto=True 的字段优先处理
    sorted_fields = sorted(
        provenance.items(),
        key=lambda x: (
            not PROVENANCE_FIELDS.get(x[0], {}).get('veto', False),  # veto 优先
            -len(x[1]['value']),  # 长值优先
        )
    )

    for field_name, field_info in sorted_fields:
        source_value = field_info['value']
        field_config = PROVENANCE_FIELDS.get(field_name, {})

        # 先检查精确匹配 — 如果源值本身已在文本中，跳过
        if source_value in corrected:
            continue

        # 生成变异形式并在文本中搜索
        variations = _generate_variations(source_value)

        found_mutations = []
        for var in variations:
            if var in corrected:
                found_mutations.append(var)

        # 如果变异检测未命中，尝试滑动窗口模糊匹配（针对长度≥4的值）
        if not found_mutations and len(source_value) >= 4:
            clean_text = re.sub(r'\s+', '', corrected)
            clean_source = re.sub(r'\s+', '', source_value)
            win_size = len(clean_source)
            # 在 ±2 字符窗口中搜索
            for offset in range(-2, 3):
                size = win_size + offset
                if size < 2:
                    continue
                for i in range(len(clean_text) - size + 1):
                    candidate = clean_text[i:i + size]
                    sim = _compute_similarity(candidate, clean_source)
                    if sim >= 0.75 and candidate != clean_source:
                        # 在原始文本中定位
                        found_mutations.append(candidate)
                        break
                if found_mutations:
                    break

        # 执行矫正 — 智能替换（处理子串残渣问题）
        for mutation in found_mutations:
            severity = 'CRITICAL' if field_config.get('veto') else 'ERROR'

            # 在文本中定位 mutation 的实际出现位置
            idx = corrected.find(mutation)
            if idx < 0:
                continue

            # 检测 mutation 后面是否跟着残留后缀字符（LLM改写遗留）
            # 例：源值=新型高效能量转换与储存技术, mutation=新型高效能量转换与储存,
            #     文本中=新型高效能量转换与储存科技 → 应替换整体 "新型高效能量转换与储存科技"
            actual_found = mutation
            after_mutation = corrected[idx + len(mutation):]
            # 常见残留后缀
            residual_suffixes = ['技术', '科技', '业', '领域', '方向', '范畴',
                                 '有限', '股份有限', '有限责任', '有限公司', '股份公司']
            for suffix in residual_suffixes:
                if after_mutation.startswith(suffix):
                    # mutation + suffix 整体构成一个错误变体，需要整体替换
                    actual_found = mutation + suffix
                    break

            corrected = corrected.replace(actual_found, source_value)
            corrections.append({
                'field': field_name,
                'field_label': field_config.get('label', field_name),
                'source_value': source_value,
                'found': actual_found,
                'source_file': field_info.get('source_file', ''),
                'source': field_info.get('source', ''),
                'severity': severity,
                'correction_type': 'mutation_detected',
            })

    return corrected, corrections


def verify_output_with_provenance(output_text, project_root=None):
    """完整的双层核验：先溯源，再静态术语库兜底

    Layer 1: provenance → 以源文件值为准
    Layer 2: authoritative_terms.json → 静态术语库兜底

    Args:
        output_text: 技能输出文本
        project_root: 项目根目录

    Returns:
        tuple: (corrected_text, all_corrections)
    """
    all_corrections = []

    # Layer 1: provenance 溯源核验
    text, corrections_l1 = verify_against_provenance(output_text, project_root)
    all_corrections.extend(corrections_l1)

    # Layer 2: 静态权威术语库兜底
    try:
        from verify_authoritative_terms import scan_and_correct
        text, corrections_l2 = scan_and_correct(text)
        all_corrections.extend(corrections_l2)
    except ImportError:
        pass

    return text, all_corrections


def generate_provenance_report(project_root=None):
    """生成溯源核验摘要报告

    Returns:
        dict: {
            "total_fields": int,
            "veto_fields": [str, ...],
            "by_source": {source: [fields...]},
            "gaps": [str, ...]  # 缺失溯源的关键字段
        }
    """
    provenance = get_provenance(project_root)
    report = {
        'total_fields': len(provenance),
        'veto_fields': [],
        'by_source': {},
        'gaps': [],
        'fields': {},
    }

    for field_name, field_info in provenance.items():
        field_config = PROVENANCE_FIELDS.get(field_name, {})
        report['fields'][field_name] = {
            'value': field_info['value'],
            'source': field_info['source'],
            'label': field_config.get('label', field_name),
            'veto': field_config.get('veto', False),
        }
        if field_config.get('veto'):
            report['veto_fields'].append(field_name)
        src = field_info.get('source', 'unknown')
        report['by_source'].setdefault(src, []).append(field_name)

    # 检查缺失
    for field_name, field_config in PROVENANCE_FIELDS.items():
        if field_config.get('veto') and field_name not in provenance:
            report['gaps'].append(f'{field_config["label"]}（来源: {field_config["source_hint"]}）')

    return report


# ============================================================
# CLI
# ============================================================

def main():
    import argparse
    parser = argparse.ArgumentParser(
        description='溯源核验模块 - 以官方源文件提取值为基准强制矫正LLM输出',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''示例：
  python provenance_manager.py set --field tech_field_l1 --value "新能源与节能" --source income_tax_return --file "申报表.pdf"
  python provenance_manager.py get --field tech_field_l1
  python provenance_manager.py verify --text "该项目属于新能源及节能领域"
  python provenance_manager.py report
''',
    )
    subparsers = parser.add_subparsers(dest='command', help='子命令')

    # set
    p_set = subparsers.add_parser('set', help='记录溯源字段')
    p_set.add_argument('--field', required=True)
    p_set.add_argument('--value', required=True)
    p_set.add_argument('--source', required=True)
    p_set.add_argument('--file', required=True, dest='source_file')
    p_set.add_argument('--project-root')

    # get
    p_get = subparsers.add_parser('get', help='获取溯源值')
    p_get.add_argument('--field', help='字段名，省略则返回全部')
    p_get.add_argument('--project-root')

    # verify
    p_verify = subparsers.add_parser('verify', help='核验文本')
    p_verify.add_argument('--text', required=True)
    p_verify.add_argument('--project-root')

    # report
    p_report = subparsers.add_parser('report', help='生成溯源报告')

    args = parser.parse_args()

    if args.command == 'set':
        ok = set_provenance(
            field_name=args.field,
            value=args.value,
            source=args.source,
            source_file=args.source_file,
            project_root=args.project_root if hasattr(args, 'project_root') else None,
        )
        sys.exit(0 if ok else 1)

    elif args.command == 'get':
        if hasattr(args, 'field') and args.field:
            val = get_provenance_value(args.field, args.project_root if hasattr(args, 'project_root') else None)
            if val:
                print(val)
            else:
                print(f'[NONE] {args.field} 无溯源记录')
                sys.exit(1)
        else:
            provenance = get_provenance(args.project_root if hasattr(args, 'project_root') else None)
            print(json.dumps(provenance, ensure_ascii=False, indent=2))

    elif args.command == 'verify':
        corrected, corrections = verify_against_provenance(
            args.text,
            args.project_root if hasattr(args, 'project_root') else None,
        )
        if corrections:
            print(f'原始文本：{args.text}')
            print(f'矫正文本：{corrected}')
            print(f'矫正 {len(corrections)} 处：')
            for c in corrections:
                print(f'  [{c["severity"]}] {c["field_label"]}: "{c["found"]}" → "{c["source_value"]}" (来源: {c["source_file"]})')
            sys.exit(1)
        else:
            print('OK: 文本与溯源值一致')
            sys.exit(0)

    elif args.command == 'report':
        report = generate_provenance_report()
        print(json.dumps(report, ensure_ascii=False, indent=2))
        if report['gaps']:
            print(f'\n[!] 缺失溯源的关键字段 ({len(report["gaps"])} 项):')
            for gap in report['gaps']:
                print(f'  - {gap}')

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()
