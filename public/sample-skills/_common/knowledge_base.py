#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
知识库共享工具（knowledge_base）

用途：所有技能共享项目进度和项目专属知识图谱，实现经验沉淀和技能间数据共享。
      读取/更新 project_index、enterprise_info、experience_base 三个 JSON 文件。

CLI 用法：
    # 加载知识库
    python knowledge_base.py load --project-root "项目根目录"

    # 更新知识库（记录技能执行）
    python knowledge_base.py update --project-root "项目根目录" --skill "技能名"

    # 按关键词查询知识库
    python knowledge_base.py query --project-root "项目根目录" --keyword "关键词"

输出：JSON 格式结果
"""

import os
import sys
import json
import argparse
from datetime import datetime

# 蜂群协同并发控制：导入 file_lock（同目录模块）
try:
    from file_lock import file_lock, read_json_safe, write_json_safe
except ImportError:
    # 兼容直接运行/外部调用场景：将 _common 目录加入 sys.path 后重试
    _COMMON_DIR = os.path.dirname(os.path.abspath(__file__))
    if _COMMON_DIR not in sys.path:
        sys.path.insert(0, _COMMON_DIR)
    from file_lock import file_lock, read_json_safe, write_json_safe

KNOWLEDGE_BASE_DIR = os.path.join('.trae', 'project_knowledge')


def load_project_knowledge():
    """读取项目知识库（所有技能共用）
    
    返回包含 project_index、enterprise_info、experience_base 三个字典的复合对象。
    如果知识库不存在或为空模板，返回空结构。
    """
    result = {
        'project_index': {},
        'enterprise_info': {},
        'experience_base': {}
    }
    
    files = {
        'project_index': 'project_index.json',
        'enterprise_info': 'enterprise_info.json',
        'experience_base': 'experience_base.json'
    }
    
    for key, filename in files.items():
        filepath = os.path.join(KNOWLEDGE_BASE_DIR, filename)
        if os.path.exists(filepath):
            try:
                # 蜂群协同：使用文件锁防止并发读写冲突
                with file_lock(filename):
                    with open(filepath, 'r', encoding='utf-8') as f:
                        result[key] = json.load(f)
            except (json.JSONDecodeError, IOError):
                pass

    return result


def update_knowledge_after_skill(skill_name, enterprise_name, application_year,
                                  nodes=None, edges=None, progress_item=None,
                                  file_structure_entries=None, data_summary_updates=None,
                                  experience_entry=None):
    """技能执行后更新知识库（所有技能共用）
    
    在每个技能的最后一个步骤（审核验证通过后）自动调用此函数。
    
    Args:
        skill_name: 技能名称（如 'gxtz-ip-materials'）
        enterprise_name: 企业名称
        application_year: 申报年份
        nodes: 要添加到知识图谱的节点列表，每个节点为 dict:
               {'node_id': str, 'node_type': 'IP'|'RD'|'PS'|'ACH'|'STAFF'|'FIN'|'DOC',
                'node_data': dict}
        edges: 要添加到知识图谱的边列表，每条边为 dict:
               {'source': node_id, 'target': node_id, 'relation': str}
        progress_item: 进度更新项，dict:
               {'category': str, 'item_name': str, 'status': 'completed'|'in_progress'|'pending',
                'file_path': str}
        file_structure_entries: 文件结构更新项列表，每项为 dict:
               {'path': str, 'type': 'file'|'dir', 'status': str, 'related_id': str}
        data_summary_updates: 数据统计更新，dict:
               {'ip_count': int, 'rd_count': int, 'ps_count': int, ...}
        experience_entry: 经验沉淀项，dict:
               {'category': 'common_issues'|'validation_rules'|'format_requirements'|
                            'review_checkpoints'|'best_practices',
                'title': str, 'content': str}
    """
    os.makedirs(KNOWLEDGE_BASE_DIR, exist_ok=True)
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    
    # 1. 更新 project_index.json
    index_path = os.path.join(KNOWLEDGE_BASE_DIR, 'project_index.json')
    index_data = {}
    # 蜂群协同：读取加锁
    if os.path.exists(index_path):
        try:
            with file_lock('project_index.json'):
                with open(index_path, 'r', encoding='utf-8') as f:
                    index_data = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    
    # 确保基本结构存在
    index_data.setdefault('enterprise_name', enterprise_name)
    index_data.setdefault('application_year', application_year)
    index_data.setdefault('updated_at', now)
    
    # 更新文件结构图
    if file_structure_entries:
        index_data.setdefault('file_structure', {'description': '已识别文件结构图', 'tree': {}})
        tree = index_data['file_structure'].setdefault('tree', {})
        for entry in file_structure_entries:
            tree[entry['path']] = {
                'type': entry.get('type', 'file'),
                'status': entry.get('status', 'identified'),
                'related_id': entry.get('related_id', ''),
                'updated_by': skill_name,
                'updated_at': now
            }
    
    # 更新知识图谱（节点和边）
    if nodes or edges:
        index_data.setdefault('knowledge_graph', {
            'description': 'IP/RD/PS/成果/人员/财务关联图谱',
            'nodes': [],
            'edges': []
        })
        kg = index_data['knowledge_graph']
        existing_node_ids = {n.get('node_id') for n in kg.get('nodes', [])}
        
        if nodes:
            for node in nodes:
                if node['node_id'] not in existing_node_ids:
                    kg['nodes'].append({
                        'node_id': node['node_id'],
                        'node_type': node['node_type'],
                        'node_data': node.get('node_data', {}),
                        'added_by': skill_name,
                        'added_at': now
                    })
                    existing_node_ids.add(node['node_id'])
        
        if edges:
            for edge in edges:
                # 避免重复边
                edge_key = f"{edge['source']}->{edge['target']}->{edge['relation']}"
                existing_edges = {f"{e.get('source')}->{e.get('target')}->{e.get('relation')}" 
                                  for e in kg.get('edges', [])}
                if edge_key not in existing_edges:
                    kg['edges'].append({
                        'source': edge['source'],
                        'target': edge['target'],
                        'relation': edge['relation'],
                        'added_by': skill_name,
                        'added_at': now
                    })
    
    # 更新进度追踪
    if progress_item:
        index_data.setdefault('progress_tracking', {
            'description': '各类材料完成进度',
            'categories': {}
        })
        cat = progress_item['category']
        categories = index_data['progress_tracking'].setdefault('categories', {})
        if cat not in categories:
            categories[cat] = {}
        categories[cat][progress_item['item_name']] = {
            'status': progress_item.get('status', 'completed'),
            'file_path': progress_item.get('file_path', ''),
            'updated_by': skill_name,
            'updated_at': now
        }
    
    # 更新数据统计
    if data_summary_updates:
        index_data.setdefault('data_summary', {
            'description': '项目数据统计汇总',
            'ip_count': 0, 'rd_count': 0, 'ps_count': 0,
            'achievement_count': 0, 'staff_count': 0,
            'total_employees': 0, 'rd_expenses_total': 0, 'revenue_total': 0
        })
        for k, v in data_summary_updates.items():
            index_data['data_summary'][k] = v
    
    index_data['updated_at'] = now
    # 蜂群协同：写入加锁
    with file_lock('project_index.json'):
        with open(index_path, 'w', encoding='utf-8') as f:
            json.dump(index_data, f, ensure_ascii=False, indent=2)

    # 2. 更新 enterprise_info.json（如果传入了企业信息更新）
    # 通常由 info-collector 负责更新，其他技能只读取

    # 3. 更新 experience_base.json（经验沉淀）
    if experience_entry:
        exp_path = os.path.join(KNOWLEDGE_BASE_DIR, 'experience_base.json')
        exp_data = {}
        # 蜂群协同：读取加锁
        if os.path.exists(exp_path):
            try:
                with file_lock('experience_base.json'):
                    with open(exp_path, 'r', encoding='utf-8') as f:
                        exp_data = json.load(f)
            except (json.JSONDecodeError, IOError):
                pass

        exp_data.setdefault('common_issues', [])
        exp_data.setdefault('validation_rules', [])
        exp_data.setdefault('format_requirements', [])
        exp_data.setdefault('review_checkpoints', [])
        exp_data.setdefault('best_practices', [])

        cat = experience_entry['category']
        if cat in exp_data:
            exp_data[cat].append({
                'title': experience_entry.get('title', ''),
                'content': experience_entry.get('content', ''),
                'source_skill': skill_name,
                'added_at': now
            })

        exp_data['updated_at'] = now
        # 蜂群协同：写入加锁
        with file_lock('experience_base.json'):
            with open(exp_path, 'w', encoding='utf-8') as f:
                json.dump(exp_data, f, ensure_ascii=False, indent=2)
    
    print(f"[知识库] {skill_name} 已更新项目知识库（{now}）")


def init_project_knowledge_if_needed(enterprise_name='', application_year=2026):
    """如果知识库不存在，则初始化（所有技能可安全调用）"""
    os.makedirs(KNOWLEDGE_BASE_DIR, exist_ok=True)
    index_path = os.path.join(KNOWLEDGE_BASE_DIR, 'project_index.json')
    
    if not os.path.exists(index_path):
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        index_data = {
            'project_name': f"{enterprise_name}_高新认定_{application_year}",
            'enterprise_name': enterprise_name,
            'application_year': application_year,
            'recent_three_years': [application_year - 3, application_year - 2, application_year - 1],
            'last_year': application_year - 1,
            'created_at': now,
            'updated_at': now,
            'file_structure': {'description': '已识别文件结构图', 'tree': {}},
            'knowledge_graph': {'description': '关联图谱', 'nodes': [], 'edges': []},
            'progress_tracking': {'description': '完成进度', 'categories': {}},
            'data_summary': {
                'description': '数据统计',
                'ip_count': 0, 'rd_count': 0, 'ps_count': 0,
                'achievement_count': 0, 'staff_count': 0,
                'total_employees': 0, 'rd_expenses_total': 0, 'revenue_total': 0
            }
        }
        # 蜂群协同：写入加锁
        with file_lock('project_index.json'):
            with open(index_path, 'w', encoding='utf-8') as f:
                json.dump(index_data, f, ensure_ascii=False, indent=2)

        # 初始化企业信息模板
        ent_path = os.path.join(KNOWLEDGE_BASE_DIR, 'enterprise_info.json')
        if not os.path.exists(ent_path):
            ent_data = {
                'enterprise_name': enterprise_name,
                'registered_address': '', 'establishment_date': '',
                'business_scope': '', 'main_business': '',
                'tech_field': '', 'tech_field_code': '',
                'total_employees': 0, 'rd_staff_count': 0, 'rd_staff_ratio': 0,
                'rd_site_area': 0, 'rd_equipment_total_value': 0, 'rd_equipment_count': 0,
                'contact_person': '', 'contact_phone': '', 'contact_email': '',
                'application_year': application_year,
                'recent_three_years': [application_year - 3, application_year - 2, application_year - 1],
                'last_year': application_year - 1,
                'updated_at': now
            }
            # 蜂群协同：写入加锁
            with file_lock('enterprise_info.json'):
                with open(ent_path, 'w', encoding='utf-8') as f:
                    json.dump(ent_data, f, ensure_ascii=False, indent=2)

        # 初始化经验库模板
        exp_path = os.path.join(KNOWLEDGE_BASE_DIR, 'experience_base.json')
        if not os.path.exists(exp_path):
            exp_data = {
                'common_issues': [], 'validation_rules': [],
                'format_requirements': [], 'review_checkpoints': [],
                'best_practices': [], 'updated_at': now
            }
            # 蜂群协同：写入加锁
            with file_lock('experience_base.json'):
                with open(exp_path, 'w', encoding='utf-8') as f:
                    json.dump(exp_data, f, ensure_ascii=False, indent=2)
        
        print(f"[知识库] 已初始化项目知识库（{enterprise_name}_{application_year}）")


# ============================================================
# 蜂群协同：安全读写函数（v1.0新增，带文件锁的并发控制）
# 用于 subagent 并行执行场景下安全访问 project_knowledge 的 JSON 文件
# ============================================================

# 知识库 key 到文件名的映射
_KNOWLEDGE_KEY_TO_FILE = {
    'project_index': 'project_index.json',
    'enterprise_info': 'enterprise_info.json',
    'experience_base': 'experience_base.json',
    'file_map': 'file_map.json',
}


def read_knowledge_safe(key):
    """带文件锁的安全读取（蜂群协同专用）

    Args:
        key: 知识库键名，支持：
            - 'project_index'  → project_index.json
            - 'enterprise_info' → enterprise_info.json
            - 'experience_base' → experience_base.json
            - 'file_map'       → file_map.json
            - 也可直接传入文件名（如 'project_index.json'）

    Returns:
        dict: JSON 数据；文件不存在或解析失败时返回空字典 {}

    Example:
        data = read_knowledge_safe('project_index')
    """
    filename = _KNOWLEDGE_KEY_TO_FILE.get(key, key if key.endswith('.json') else f'{key}.json')
    filepath = os.path.join(KNOWLEDGE_BASE_DIR, filename)
    if not os.path.exists(filepath):
        return {}
    try:
        with file_lock(filename):
            with open(filepath, 'r', encoding='utf-8') as f:
                return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def write_knowledge_safe(key, value):
    """带文件锁的安全写入（蜂群协同专用）

    Args:
        key: 知识库键名（同 read_knowledge_safe）
        value: 要写入的字典数据

    Returns:
        bool: 写入成功返回 True，失败返回 False

    Example:
        data = read_knowledge_safe('project_index')
        data['progress_tracking'] = {...}
        write_knowledge_safe('project_index', data)
    """
    os.makedirs(KNOWLEDGE_BASE_DIR, exist_ok=True)
    filename = _KNOWLEDGE_KEY_TO_FILE.get(key, key if key.endswith('.json') else f'{key}.json')
    filepath = os.path.join(KNOWLEDGE_BASE_DIR, filename)
    try:
        with file_lock(filename):
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(value, f, ensure_ascii=False, indent=2)
        return True
    except (IOError, OSError, TypeError, ValueError):
        return False


# ============================================================
# 网报系统编号映射表（v1.3.0新增，基于量必达、安高模具、盛迪嘉支付项目分析）
# 实际项目中"00 合订本"目录按网报系统上传顺序编号01-25
# 此映射表用于：
#   1. 生成合订本时自动编号
#   2. 识别已上传文件对应的资料类别
#   3. 校验网报上传完整性
# ============================================================

NETWORK_REPORT_NUMBER_MAPPING = {
    # 编号: (资料类别, 文件描述, 对应技能, 是否必须)
    '01': ('申报书', '申报书封皮', 'gxtz-core-tables', True),
    '02': ('申报书', '企业承诺书', 'gxtz-core-tables', True),
    '03': ('申报书', '高新技术企业认定申请书', 'gxtz-core-tables', True),
    '04': ('基础资质', '营业执照', 'gxtz-info-collector', True),
    '05': ('基础资质', '法定代表人身份证', 'gxtz-info-collector', True),
    '06': ('财务资料', '{近三年第一年}财务审计报告', None, True),  # 外部资料
    '07': ('财务资料', '{近三年第二年}财务审计报告', None, True),
    '08': ('财务资料', '{近三年第三年}财务审计报告', None, True),
    '09': ('财务资料', '近三年研发费用专项审计报告', None, True),
    '10': ('财务资料', '上年度高新技术产品（服务）收入专项审计报告', None, True),
    '11': ('财务资料', '{近三年第一年}企业所得税纳税申报表', None, True),
    '12': ('财务资料', '{近三年第二年}企业所得税纳税申报表', None, True),
    '13': ('财务资料', '{近三年第三年}企业所得税纳税申报表', None, True),
    '14': ('管理制度', '企业研究开发组织管理制度+研发投入核算体系+研发费用辅助账证明材料', 'gxtz-management-materials', True),
    '15': ('管理制度', '设立内部研发机构+产学研合作证明材料', 'gxtz-management-materials', True),
    '16': ('管理制度', '科技成果转化组织实施与激励奖励制度+创新创业平台证明材料', 'gxtz-management-materials', True),
    '17': ('管理制度', '科技人员培养进修+人才引进+绩效评价奖励制度证明材料', 'gxtz-management-materials', True),
    '18': ('科技人员', '人力资源情况证明材料', 'gxtz-staff-materials', True),
    '19': ('知识产权', '知识产权汇总（IP.pdf合并件）', 'gxtz-ip-materials', True),
    '20': ('研发项目', '研发项目汇总（RD.pdf合并件）', 'gxtz-rd-report', True),
    '21': ('高新产品', '高新技术产品（服务）明细PS01', 'gxtz-ps-materials', True),
    '22': ('高新产品', '高新技术产品（服务）明细PS02+（如有多个PS依次编号）', 'gxtz-ps-materials', True),
    '23': ('合同发票', '上年度与高新技术产品相关的代表性销售合同与发票', 'gxtz-ps-materials', True),
    '24': ('成果转化', '科技成果转化情况汇总（成果转化.pdf合并件）', 'gxtz-achievement-materials', True),
    '25': ('申报书', '企业承诺书（结尾重复）', 'gxtz-core-tables', True),
}


def get_network_report_number(material_category, material_description=''):
    """根据资料类别获取网报编号（v1.3.0新增）
    
    Args:
        material_category: 资料类别（如'知识产权'、'研发项目'、'管理制度'等）
        material_description: 资料描述（可选，用于精确匹配）
        
    Returns:
        str: 网报编号（如'19'），未找到返回None
    """
    for number, (category, desc, _, _) in NETWORK_REPORT_NUMBER_MAPPING.items():
        if category == material_category:
            if not material_description or material_description in desc or desc in material_description:
                return number
    return None


def validate_network_report_completeness(project_root):
    """校验网报上传完整性（v1.3.0新增）
    
    检查"00 合订本"目录下的文件是否覆盖所有必须的网报编号（01-25）。
    基于实际项目分析，"00 合订本"目录的文件以"两位数字序号 + 描述.pdf"命名。
    
    Args:
        project_root: 项目根目录路径
        
    Returns:
        dict: {
            'found_numbers': [已找到的编号列表],
            'missing_numbers': [缺失的编号列表],
            'missing_descriptions': [缺失项的描述列表],
            'extra_files': [未识别编号的文件列表],
            'is_complete': bool
        }
    """
    import re
    
    # 查找"00 合订本"目录
    hedingben_dir = None
    for entry in os.listdir(project_root):
        full_path = os.path.join(project_root, entry)
        if os.path.isdir(full_path) and '合订本' in entry:
            hedingben_dir = full_path
            break
    
    if not hedingben_dir:
        return {
            'found_numbers': [],
            'missing_numbers': list(NETWORK_REPORT_NUMBER_MAPPING.keys()),
            'missing_descriptions': [v[1] for v in NETWORK_REPORT_NUMBER_MAPPING.values()],
            'extra_files': [],
            'is_complete': False,
            'error': '未找到"00 合订本"目录'
        }
    
    found_numbers = set()
    extra_files = []
    
    # 扫描合订本目录下的文件
    for entry in os.listdir(hedingben_dir):
        if os.path.isfile(os.path.join(hedingben_dir, entry)):
            # 提取文件名开头的两位数字
            match = re.match(r'^(\d{2})\s', entry)
            if match:
                number = match.group(1)
                if number in NETWORK_REPORT_NUMBER_MAPPING:
                    found_numbers.add(number)
                else:
                    extra_files.append(entry)
            else:
                # 非编号文件（如目录.docx、章节标题.docx等）
                if entry not in ['目录.docx', '目录.pdf', '章节标题.docx', '章节标题.pdf']:
                    extra_files.append(entry)
    
    # 计算缺失项
    missing_numbers = [n for n in NETWORK_REPORT_NUMBER_MAPPING.keys() if n not in found_numbers]
    missing_descriptions = [NETWORK_REPORT_NUMBER_MAPPING[n][1] for n in missing_numbers]
    
    return {
        'found_numbers': sorted(found_numbers),
        'missing_numbers': sorted(missing_numbers),
        'missing_descriptions': missing_descriptions,
        'extra_files': extra_files,
        'is_complete': len(missing_numbers) == 0
    }


def _query_knowledge(knowledge, keyword):
    """在知识库中按关键词查询（内部辅助函数）
    
    遍历 project_index、enterprise_info、experience_base 三个字典，
    搜索所有字符串值中包含关键词的条目。
    
    Args:
        knowledge: load_project_knowledge() 返回的知识库字典
        keyword: 搜索关键词
        
    Returns:
        dict: 查询结果
    """
    keyword_lower = keyword.lower()
    matches = {
        'keyword': keyword,
        'enterprise_info_matches': [],
        'project_index_matches': [],
        'experience_matches': []
    }
    
    # 搜索企业信息
    ent_info = knowledge.get('enterprise_info', {})
    for key, value in ent_info.items():
        if isinstance(value, str) and keyword_lower in value.lower():
            matches['enterprise_info_matches'].append({'field': key, 'value': value})
    
    # 搜索项目索引（文件结构、知识图谱、进度追踪）
    index = knowledge.get('project_index', {})
    # 搜索文件结构
    file_structure = index.get('file_structure', {})
    tree = file_structure.get('tree', {}) if isinstance(file_structure, dict) else {}
    for path, info in tree.items():
        if keyword_lower in path.lower():
            matches['project_index_matches'].append({'type': 'file_structure', 'path': path, 'info': info})
    
    # 搜索知识图谱节点
    kg = index.get('knowledge_graph', {})
    nodes = kg.get('nodes', []) if isinstance(kg, dict) else []
    for node in nodes:
        node_data = node.get('node_data', {})
        node_str = json.dumps(node_data, ensure_ascii=False)
        if keyword_lower in node_str.lower() or keyword_lower in node.get('node_id', '').lower():
            matches['project_index_matches'].append({'type': 'knowledge_node', 'node': node})
    
    # 搜索进度追踪
    progress = index.get('progress_tracking', {})
    categories = progress.get('categories', {}) if isinstance(progress, dict) else {}
    for cat_name, items in categories.items():
        for item_name, item_info in items.items():
            item_str = f"{cat_name} {item_name} {json.dumps(item_info, ensure_ascii=False)}"
            if keyword_lower in item_str.lower():
                matches['project_index_matches'].append({
                    'type': 'progress', 'category': cat_name, 'item': item_name, 'info': item_info
                })
    
    # 搜索经验库
    exp = knowledge.get('experience_base', {})
    for cat_name in ['common_issues', 'validation_rules', 'format_requirements',
                     'review_checkpoints', 'best_practices']:
        entries = exp.get(cat_name, [])
        for entry in entries:
            entry_str = json.dumps(entry, ensure_ascii=False)
            if keyword_lower in entry_str.lower():
                matches['experience_matches'].append({'category': cat_name, 'entry': entry})
    
    matches['total_matches'] = (
        len(matches['enterprise_info_matches']) +
        len(matches['project_index_matches']) +
        len(matches['experience_matches'])
    )
    return matches


def main():
    """CLI 入口：支持 load、update、query 三个子命令
    
    返回 JSON 格式结果。
    """
    parser = argparse.ArgumentParser(
        description='知识库共享工具 - 读取/更新/查询项目知识库'
    )
    subparsers = parser.add_subparsers(dest='command', help='子命令')

    # load 子命令：加载知识库
    load_parser = subparsers.add_parser('load', help='加载知识库')
    load_parser.add_argument('--project-root', required=True, help='项目根目录')

    # update 子命令：更新知识库
    update_parser = subparsers.add_parser('update', help='更新知识库（记录技能执行）')
    update_parser.add_argument('--project-root', required=True, help='项目根目录')
    update_parser.add_argument('--skill', required=True, help='技能名')

    # query 子命令：按关键词查询知识库
    query_parser = subparsers.add_parser('query', help='按关键词查询知识库')
    query_parser.add_argument('--project-root', required=True, help='项目根目录')
    query_parser.add_argument('--keyword', required=True, help='关键词')

    args = parser.parse_args()

    # 切换到项目根目录，使 KNOWLEDGE_BASE_DIR 相对路径生效
    original_dir = os.getcwd()
    if args.project_root:
        os.chdir(args.project_root)

    try:
        if args.command == 'load':
            # 初始化（如果不存在）后加载
            init_project_knowledge_if_needed()
            knowledge = load_project_knowledge()
            print(json.dumps(knowledge, ensure_ascii=False, default=str))

        elif args.command == 'update':
            # 初始化知识库后记录技能执行
            init_project_knowledge_if_needed()
            knowledge = load_project_knowledge()
            enterprise_name = knowledge.get('enterprise_info', {}).get('enterprise_name', '')
            application_year = knowledge.get('project_index', {}).get('application_year', 2026)

            update_knowledge_after_skill(
                skill_name=args.skill,
                enterprise_name=enterprise_name,
                application_year=application_year,
                progress_item={
                    'category': args.skill,
                    'item_name': '技能执行',
                    'status': 'completed',
                    'file_path': ''
                }
            )
            # 重新加载返回更新后的知识库
            knowledge = load_project_knowledge()
            print(json.dumps(
                {"status": "updated", "skill": args.skill, "knowledge": knowledge},
                ensure_ascii=False, default=str
            ))

        elif args.command == 'query':
            # 按关键词查询知识库
            knowledge = load_project_knowledge()
            results = _query_knowledge(knowledge, args.keyword)
            print(json.dumps(results, ensure_ascii=False, default=str))

        else:
            parser.print_help()
    finally:
        os.chdir(original_dir)


if __name__ == '__main__':
    main()
