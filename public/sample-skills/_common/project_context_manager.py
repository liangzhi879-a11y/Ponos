#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
project_context_manager.py - 高新认定项目文件管理器

用法：
  python project_context_manager.py init --enterprise "企业名称" --year 2026
  python project_context_manager.py finalize --enterprise "企业名称" --year 2026 --skill "gxtz-info-collector"
  python project_context_manager.py capture --project-root "D:\\项目路径" --skill "gxtz-core-tables" --enterprise "企业名称" --problem-type validation_rule --problem-desc "RD04未关联IP" --solution "补充RD-IP关联"

设计逻辑（agent可据此自主调改）：
  init: 创建 .trae 目录及3个核心json（file_map/experience_base/project_index），扫描项目文件初始化图谱
  finalize: 按19类目录整理文件 → 生成整理报告 → 更新3个json → 校验产出完整性

如果脚本执行报错，agent应阅读本文件的设计逻辑，自主编写等效Python代码实现以下功能：
  1. 确保 .trae/{file_map,experience_base,project_index}.json 三个文件存在
  2. 按19类目录结构整理文件（先检查19_补充资料，再扫描全目录）
  3. 生成 _file_management_report.md 整理报告
  4. 更新3个json文件内容
"""

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path


# ============================================================
# 19类目录结构定义
# ============================================================
FILE_ORGANIZER_CATEGORIES = {
    '1':  {'name': '1.IP证明材料（知识产权）',            'keywords': ['专利', '知识产权', 'IP', '软著', '证书', '发明', '实用新型', '外观设计']},
    '2':  {'name': '2.企业研究开发活动情况证明材料-立项报告任务书验收报告（RD）', 'keywords': ['RD', '立项', '研发项目', '任务书', '验收', '结题']},
    '3':  {'name': '3.PS证明材料（高新技术产品）',          'keywords': ['PS', '高新技术产品', '高新产品', '产品收入']},
    '4':  {'name': '4.科技成果转化',                        'keywords': ['成果转化', '转化证明', '转化报告']},
    '5':  {'name': '5.标准资料（参与制定的各类标准文件）',   'keywords': ['标准', '国标', '行标', '企标']},
    '6':  {'name': '6.营业执照',                           'keywords': ['营业执照', '工商', '统一社会信用']},
    '8':  {'name': '8.前三年财务审计报告',                  'keywords': ['审计', '财审', '财务报告']},
    '9':  {'name': '9.前三年企业所得税纳税申报表',          'keywords': ['纳税', '所得税', '申报表', '税务']},
    '10': {'name': '10.前三年研发费用专项审计报告',         'keywords': ['研发费用', '专项审计', '研发费']},
    '11': {'name': '11.上年度高新产品（服务）收入专项审计报告', 'keywords': ['高新产品收入', '收入专项', '产品收入审计']},
    '12': {'name': '12-15.组织管理制度',                   'keywords': ['管理制度', '研发制度', '组织管理', '产学研', '激励', '辅助账']},
    '16': {'name': '16.人力资源情况证明材料',              'keywords': ['人员', '花名册', '社保', '学历', '职称', '劳动合同', '考勤']},
    '17': {'name': '17.上年度与高新技术产品（服务）相关的代表性的销售合同与发票', 'keywords': ['合同', '发票', '销售', '订单']},
    '18': {'name': '18.往期项目资料',                      'keywords': ['往期', '历史', '之前', '上次']},
    '19': {'name': '19.补充资料',                          'keywords': []},  # 默认目录
    '98': {'name': '98.历史参考资料',                      'keywords': [], 'role': 'historical'},
    '99': {'name': '99.其他资料',                          'keywords': [], 'role': 'misc'},
}

# 有效但非当前申报需要的年份关键词（往期年份 → 历史）
HISTORICAL_YEAR_KEYWORDS = ['往期', '历史', '之前', '上次', '前次', '以往', '旧版', '历年', '往年']
# 临时/草稿/重复文件标志（→ 不移动，标记invalid）
INVALID_MARKERS = ['~$', '.tmp', '.bak', '.swp', '.DS_Store', 'Thumbs.db', '~WRL',
                   '草稿', 'draft', '副本', ' - 副本', '(1)', '(2)', '(3)', '新建', '未命名', '临时',
                   '._',  # macOS 资源文件前缀（._xxx.pdf）
                   ]
# 非资料文件扩展名（→ 不移动，标记invalid）
NON_ASSET_EXTENSIONS = ['.lnk', '.dat', '.exe', '.msi', '.dll', '.sys', '.crdownload', '.part',
                        '.tmp', '.swp', '.psd', '.xmind']

# 衍生资料标志（从其他文件抽取的页面/附件，归入99.其他资料避免与原文件重复）
DERIVED_MARKERS = ['提取自', '页面提取自', '页面提取', '提取页面', '提取自－', '提取自-']

# 历史项目目录前缀（整目录都是其他项目资料，归入98.历史参考资料）
HISTORICAL_PROJECT_PREFIXES = ['【专精特新】', '【年度更新】', '【技改】', '【贷款贴息】',
                                 '【工程技术中心】', '【省工程中心】', '【加计扣除】']

# 当前项目目录前缀（保留）
CURRENT_PROJECT_PREFIXES = ['【国高】', '【高新】']

# 版本后缀模式（同文件多版本，保留主文件，其余归入重复/历史）
# 注意：_扫描版/_电子版 不再视为版本后缀，改为扫描件标记（OCR处理时优先识别）
VERSION_SUFFIX_PATTERNS = [
    r'_backup_v?\d*$', r'_backups?$', r'_fixed$', r'_v\d+$', r'_\d+$',  # xxx_backup.docx, xxx_v2.docx
    r'_OK$', r'_ok$',
]

# 扫描件后缀模式（不视为重复文件，仅标记为扫描件）
SCAN_SUFFIX_PATTERNS = [
    r'_扫描版$', r'_电子版$', r'_扫描件$', r'_scan$',
]


def extract_years_from_filename(filename):
    """从文件名中提取所有年份（支持4位和2位年份）

    返回 [(year_int, format_str), ...] 其中 format_str 为 '4digit' 或 '2digit'
    """
    years = []
    # 4位年份：2022、2023 等
    for m in re.finditer(r'(?<!\d)(20\d{2})(?!\d)', filename):
        years.append((int(m.group(1)), '4digit'))
    # 2位年份：22财审、23财审、24财审 等（前后非数字，且紧跟财审/年度/年等词）
    for m in re.finditer(r'(?<!\d)(\d{2})(?=财审|年度|年)', filename):
        y2 = int(m.group(1))
        if 10 <= y2 <= 30:  # 合理范围：2010-2030
            years.append((2000 + y2, '2digit'))
    return years


def has_version_suffix(filename):
    """检测文件名是否含版本后缀（_backup/_fixed/_v2/_扫描版等），返回 (True, suffix_text) 或 (False, None)"""
    name_without_ext = os.path.splitext(filename)[0]
    for pattern in VERSION_SUFFIX_PATTERNS:
        m = re.search(pattern, name_without_ext)
        if m:
            return (True, m.group(0))
    return (False, None)


def evaluate_file_validity(filename, rel_path, category, application_year):
    """评估文件有效性，返回 (validity, target_category, reason)

    validity 取值：
      'valid'        - 有效资料，归类到19类对应目录
      'historical'   - 历史参考资料（往期年份/往期项目），归到 98.历史参考资料
      'misc'         - 有效但无法归入19类，归到 99.其他资料
      'duplicate'    - 版本后缀文件（_backup/_fixed/_扫描版等），归到 99.其他资料/重复文件/
      'invalid'      - 临时/草稿/类型不合规，不移动，仅在file_map中标记
    """
    name_lower = filename.lower()
    ext = os.path.splitext(filename)[1].lower()

    # 1. 非资料文件扩展名
    if ext in NON_ASSET_EXTENSIONS:
        return ('invalid', category, f'非资料文件扩展名{ext}')

    # 2. macOS 资源文件前缀（._xxx.pdf）
    if filename.startswith('._') or '._' in filename[:3]:
        return ('invalid', category, 'macOS资源文件前缀（._）')

    # 3. 临时/草稿/重复文件标志
    for marker in INVALID_MARKERS:
        if marker.lower() in name_lower:
            return ('invalid', category, f'临时/草稿/重复标志：{marker}')

    # 4. 版本后缀文件（_backup/_fixed/_v2等）→ 重复
    #    注意：_扫描版/_电子版 不再视为重复，改为扫描件标记
    has_vs, vs_text = has_version_suffix(filename)
    if has_vs:
        return ('duplicate', '99', f'版本后缀文件：{vs_text}（与主文件构成版本对）')

    # 4.5 扫描件标记（_扫描版/_电子版/_扫描件/_scan）→ 保留为有效，但标记扫描件
    scan_suffix = None
    for pattern in SCAN_SUFFIX_PATTERNS:
        m = re.search(pattern, name_lower)
        if m:
            scan_suffix = m.group()
            break

    # 5. 衍生资料标志（提取自/页面提取自）→ misc（归入99.其他资料）
    for marker in DERIVED_MARKERS:
        if marker in filename:
            return ('misc', '99', f'衍生资料：{marker}（从其他文件抽取的页面/附件）')

    # 6. 从文件名提取年份判断时效（支持4位和2位）
    years = extract_years_from_filename(filename)
    if years:
        recent_three = [application_year - 3, application_year - 2, application_year - 1]
        # 取文件名中最大年份判断时效
        max_year = max(y for y, _ in years)
        if max_year < min(recent_three):
            year_format = next((fmt for y, fmt in years if y == max_year), '4digit')
            return ('historical', '98', f'文件名年份{max_year}({year_format})早于近三年最早{min(recent_three)}')

    # 7. 往期项目关键词
    for kw in HISTORICAL_YEAR_KEYWORDS:
        if kw in filename:
            return ('historical', '98', f'文件名含历史关键词：{kw}')

    # 8. 历史项目目录前缀（基于文件相对路径判断）
    for prefix in HISTORICAL_PROJECT_PREFIXES:
        if prefix in rel_path:
            return ('historical', '98', f'历史项目目录：{prefix}（非当前国高申报资料）')

    # 9. 有效文件：根据类别判定归类目标
    if category == '19':
        # 无法归入19类的有效文件 → 其他资料
        return ('misc', '99', f'有效但无19类匹配，归入其他资料{"（扫描件：" + scan_suffix + "）" if scan_suffix else ""}')
    if scan_suffix:
        return ('valid', category, f'有效资料（扫描件：{scan_suffix}，需OCR识别），归入对应类别')
    return ('valid', category, '有效资料，归入对应类别')




def find_project_root(start_path=None):
    """从当前目录向上查找包含 .trae 目录的父目录"""
    cur = Path(start_path or os.getcwd()).resolve()
    for _ in range(10):
        if (cur / '.trae').is_dir():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    # 没找到.trae目录，返回当前目录作为项目根
    return Path(start_path or os.getcwd()).resolve()


def get_trae_dir(project_root):
    """获取或创建 .trae 目录"""
    trae_dir = project_root / '.trae'
    trae_dir.mkdir(parents=True, exist_ok=True)
    return trae_dir


def classify_file(filename, config_keywords=None):
    """文件归类决策：文件名前缀 > 关键词匹配 > 默认归到19_补充资料"""
    name_lower = filename.lower()

    # 前缀匹配（IP/RD/PS开头）
    if re.match(r'^(IP|ip)\d', filename):
        return '1'
    if re.match(r'^(RD|rd)\d', filename):
        return '2'
    if re.match(r'^(PS|ps)\d', filename):
        return '3'

    # 关键词匹配（按priority排序，编号小的优先）
    best_cat, best_score = '19', 0
    for cat_id, cat_info in FILE_ORGANIZER_CATEGORIES.items():
        if cat_id == '19':
            continue
        score = sum(1 for kw in cat_info['keywords'] if kw in filename)
        if score > best_score:
            best_score = score
            best_cat = cat_id

    return best_cat if best_score > 0 else '19'


# ============================================================
# init 子命令：初始化项目知识库
# ============================================================
def init_project(enterprise, year, project_root=None):
    """初始化项目知识库：创建3个核心json + 扫描文件初始化图谱"""
    root = find_project_root(project_root)
    trae_dir = get_trae_dir(root)
    print(f'[init] 项目根目录: {root}')
    print(f'[init] .trae目录: {trae_dir}')

    # 1. 创建 file_map.json
    file_map_path = trae_dir / 'file_map.json'
    if file_map_path.exists():
        print(f'[init] file_map.json 已存在，跳过创建')
        file_map = json.loads(file_map_path.read_text(encoding='utf-8'))
    else:
        file_map = {
            'enterprise': enterprise,
            'application_year': year,
            'created_at': datetime.now().isoformat(),
            'files': {},
        }
        file_map_path.write_text(json.dumps(file_map, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'[init] file_map.json 已创建')

    # 2. 创建 experience_base.json
    exp_path = trae_dir / 'experience_base.json'
    if exp_path.exists():
        print(f'[init] experience_base.json 已存在，跳过创建')
        experience = json.loads(exp_path.read_text(encoding='utf-8'))
    else:
        experience = {
            'enterprise': enterprise,
            'created_at': datetime.now().isoformat(),
            'common_issues': [],
            'validation_rules': [],
            'format_requirements': [],
            'skill_executions': [],
        }
        exp_path.write_text(json.dumps(experience, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'[init] experience_base.json 已创建')

    # 3. 创建 project_index.json
    idx_path = trae_dir / 'project_index.json'
    if idx_path.exists():
        print(f'[init] project_index.json 已存在，跳过创建')
        project_index = json.loads(idx_path.read_text(encoding='utf-8'))
    else:
        project_index = {
            'enterprise': enterprise,
            'application_year': year,
            'created_at': datetime.now().isoformat(),
            'last_updated': datetime.now().isoformat(),
            'skills_progress': {},
            'key_facts': {
                'recent_three_years': [year - 3, year - 2, year - 1],
                'last_year': year - 1,
            },
        }
        idx_path.write_text(json.dumps(project_index, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'[init] project_index.json 已创建')

    # 4. 扫描项目文件，初始化file_map
    scanned = 0
    for item in root.rglob('*'):
        if item.is_file() and '.trae' not in str(item) and '~$' not in item.name:
            rel_path = str(item.relative_to(root))
            if rel_path not in file_map['files']:
                cat_id = classify_file(item.name)
                file_map['files'][rel_path] = {
                    'category': cat_id,
                    'category_name': FILE_ORGANIZER_CATEGORIES[cat_id]['name'],
                    'filename': item.name,
                    'size': item.stat().st_size,
                    'added_at': datetime.now().isoformat(),
                }
                scanned += 1

    if scanned > 0:
        file_map_path.write_text(json.dumps(file_map, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'[init] 扫描到 {scanned} 个新文件，已添加到 file_map.json')

    # 5. 输出初始化摘要
    total_files = len(file_map['files'])
    categories = {}
    for f in file_map['files'].values():
        cat = f['category']
        categories[cat] = categories.get(cat, 0) + 1

    print(f'\n[init] === 初始化摘要 ===')
    print(f'[init] 企业: {enterprise}')
    print(f'[init] 申报年份: {year}')
    print(f'[init] 文件总数: {total_files}')
    print(f'[init] 各类别文件数:')
    for cat_id in sorted(categories.keys()):
        print(f'[init]   {FILE_ORGANIZER_CATEGORIES[cat_id]["name"]}: {categories[cat_id]}')
    print(f'[init] 3个核心json: {"OK" if all(p.exists() for p in [file_map_path, exp_path, idx_path]) else "FAIL"}')
    print(f'[init] 初始化完成。')

    return True


# ============================================================
# 经验流转闭环辅助函数（Work→全局→Code 闭环）
# ============================================================
import glob

# 经验类型→项目级experience_base.json分类映射
_EXPERIENCE_CATEGORY_MAP = {
    'common_issue': 'common_issues',
    'validation_rule': 'validation_rules',
    'format_requirement': 'format_requirements',
    'review_checkpoint': 'review_checkpoints',
    'best_practice': 'best_practices',
    'upgrade_trigger': 'skill_upgrade_triggers',
}


def _extract_experiences_from_validation_reports(project_trae_dir, skill_name, enterprise_name):
    """从校验报告自动提取经验（校验失败项作为common_issue，警告项作为format_requirement）

    校验报告位置：{project_root}/_校验报告/ 下的 *validation*.json 文件
    """
    experiences = []
    # project_trae_dir 是 {project_root}/.trae，校验报告在 {project_root}/_校验报告
    project_root_dir = os.path.dirname(str(project_trae_dir))
    validation_dir = os.path.join(project_root_dir, "_校验报告")

    if not os.path.exists(validation_dir):
        return experiences

    # 查找JSON校验报告
    for json_file in glob.glob(os.path.join(validation_dir, "*validation*.json")):
        try:
            with open(json_file, 'r', encoding='utf-8') as f:
                report = json.load(f)
        except Exception as e:
            print(f'[finalize] 读取校验报告失败 {json_file}: {e}')
            continue

        report_name = os.path.basename(json_file)

        # 校验失败项作为common_issue经验
        if not report.get("passed", True):
            for error in report.get("errors", []):
                experiences.append({
                    "problem_type": "common_issue",
                    "problem_desc": f"校验失败（{report_name}）：{error}",
                    "solution": "见校验报告整改建议",
                    "prevention": "技能执行时参考此经验避免重复犯错",
                    "status": "pending",
                })

        # 警告项作为format_requirement经验
        for warning in report.get("warnings", []):
            experiences.append({
                "problem_type": "format_requirement",
                "problem_desc": f"校验警告（{report_name}）：{warning}",
                "solution": "见校验报告",
                "prevention": "技能执行时注意此格式要求",
                "status": "pending",
            })

        # 特定校验项提取（如unassociated_rd、idle_ips等）
        stats = report.get("stats", {})
        if stats.get("unassociated_rd"):
            experiences.append({
                "problem_type": "validation_rule",
                "problem_desc": f"RD未关联IP（{report_name}）：{stats['unassociated_rd']}",
                "solution": "补充RD-IP关联关系",
                "prevention": "RD-IP-PS匹配时确保所有RD都关联至少1个IP",
                "status": "pending",
            })
        if stats.get("idle_ips"):
            experiences.append({
                "problem_type": "validation_rule",
                "problem_desc": f"IP闲置未关联（{report_name}）：{stats['idle_ips']}",
                "solution": "补充IP关联到对应RD",
                "prevention": "RD-IP-PS匹配时确保所有IP都被关联不闲置",
                "status": "pending",
            })

    return experiences


def _collect_structured_experiences(project_trae_dir, skill_name, enterprise_name):
    """收集结构化经验，来源：agent传入的pending_experiences.json + 校验报告自动提取

    返回经验列表，每条经验含：problem_type/problem_desc/solution/prevention/status
    """
    experiences = []

    # 来源1：agent执行过程中写入的pending_experiences.json（如有）
    pending_file = os.path.join(str(project_trae_dir), "pending_experiences.json")
    if os.path.exists(pending_file):
        try:
            with open(pending_file, 'r', encoding='utf-8') as f:
                experiences.extend(json.load(f))
            os.remove(pending_file)  # 读取后删除临时文件
            print(f'[finalize] 从pending_experiences.json加载{len(experiences)}条经验')
        except Exception as e:
            print(f'[finalize] 读取pending_experiences.json失败: {e}')

    # 来源2：从校验报告自动提取（校验失败项作为common_issue经验）
    validation_exps = _extract_experiences_from_validation_reports(project_trae_dir, skill_name, enterprise_name)
    experiences.extend(validation_exps)
    if validation_exps:
        print(f'[finalize] 从校验报告自动提取{len(validation_exps)}条经验')

    return experiences


def _append_working_trace(project_trae_dir, session_info):
    """追加会话留痕到working_trace.md（新留痕插入顶部）"""
    trace_file = os.path.join(str(project_trae_dir), "working_trace.md")
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    entry = f"""
## {timestamp} 会话（{session_info.get('skill', 'unknown')}）

### 核心任务
{session_info.get('task', '未记录')}

### 完成事项
{session_info.get('completed', '未记录')}

### 产出文件
{session_info.get('outputs', '未记录')}

### 经验沉淀
{session_info.get('experiences_count', 0)}条经验已沉淀到experience_base.json并汇聚到全局技能经验库

### 未完成待办
{session_info.get('pending', '无')}

---
"""

    if os.path.exists(trace_file):
        with open(trace_file, 'r', encoding='utf-8') as f:
            existing = f.read()
        # 新留痕插入顶部（# 工作留痕 标题之后）
        if '# 工作留痕' in existing:
            header_end = existing.index('# 工作留痕') + len('# 工作留痕')
            new_content = existing[:header_end] + '\n' + entry + existing[header_end:]
        else:
            new_content = f"# 工作留痕\n\n{entry}{existing}"
        with open(trace_file, 'w', encoding='utf-8') as f:
            f.write(new_content)
    else:
        with open(trace_file, 'w', encoding='utf-8') as f:
            f.write(f"# 工作留痕\n\n{entry}")

    print(f'[finalize] working_trace.md 已更新')


def _sync_to_global_skill_experiences(project_trae_dir, skill_name, enterprise_name, experiences):
    """汇聚经验到全局技能经验库 ~/.trae-cn/memory/skill_experiences/{skill_name}.json

    实现Work模式→全局共享区→Code模式的跨模式流转桥梁
    """
    global_dir = os.path.expanduser("~/.trae-cn/memory/skill_experiences")
    os.makedirs(global_dir, exist_ok=True)
    global_file = os.path.join(global_dir, f"{skill_name}.json")

    # 读取现有全局经验
    if os.path.exists(global_file):
        try:
            with open(global_file, 'r', encoding='utf-8') as f:
                global_data = json.load(f)
        except Exception as e:
            print(f'[finalize] 读取全局经验库失败，将重建: {e}')
            global_data = {
                "skill_name": skill_name,
                "schema_version": "2.0",
                "experiences": [],
                "updated_at": "",
                "last_synced_from_project": "",
            }
    else:
        global_data = {
            "skill_name": skill_name,
            "schema_version": "2.0",
            "experiences": [],
            "updated_at": "",
            "last_synced_from_project": "",
        }

    # 生成exp_id并追加新经验
    today = datetime.now().strftime("%Y-%m-%d")
    existing_ids = [e.get("exp_id", "") for e in global_data.get("experiences", [])]
    seq = len([i for i in existing_ids if today in i]) + 1

    for exp in experiences:
        exp_id = f"EXP-{today}-{seq:03d}"
        exp["exp_id"] = exp_id
        exp["source_project"] = enterprise_name
        exp["source_session"] = today
        exp["skill_name"] = skill_name
        exp.setdefault("status", "pending")
        exp.setdefault("created_at", today)
        global_data.setdefault("experiences", []).append(exp)
        seq += 1

    global_data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    global_data["last_synced_from_project"] = enterprise_name

    with open(global_file, 'w', encoding='utf-8') as f:
        json.dump(global_data, f, ensure_ascii=False, indent=2)

    print(f'[finalize] 已汇聚{len(experiences)}条经验到全局技能经验库: {global_file}')
    return len(experiences)


# ============================================================
# finalize 子命令：整理文件 + 生成报告 + 更新知识库 + 校验产出
# ============================================================
def finalize_project(enterprise, year, skill, project_root=None, experiences_json=None, no_move=False):
    """整理文件到19类目录（含有效性筛选） + 生成整理报告 + 更新3个json + 校验产出

    整理逻辑：
      1. 扫描所有文件
      2. 每个文件先调 classify_file() 判定类别
      3. 再调 evaluate_file_validity() 判定有效性
      4. 按有效性决定去向（no_move=True 时跳过实体移动，仅做分类登记）：
         - valid       → 移到19类对应目录 / no_move仅登记
         - historical  → 移到 98.历史参考资料/ / no_move仅登记
         - misc        → 移到 99.其他资料/ / no_move仅登记
         - invalid     → 不移动（草稿/临时/重复/类型不合规），仅在file_map中标记
    """
    root = find_project_root(project_root)
    trae_dir = get_trae_dir(root)
    print(f'[finalize] 项目根目录: {root}')
    print(f'[finalize] 技能: {skill}')

    # 1. 加载已有file_map
    file_map_path = trae_dir / 'file_map.json'
    if file_map_path.exists():
        file_map = json.loads(file_map_path.read_text(encoding='utf-8'))
    else:
        file_map = {'enterprise': enterprise, 'files': {}}

    # 2. 扫描所有文件并执行有效性筛选
    organized = []        # valid：移到19类目录
    organized_historical = []  # historical：移到98
    organized_misc = []   # misc：移到99
    organized_duplicate = []  # duplicate：移到99.其他资料/重复文件/
    invalid_files = []    # invalid：不移动

    # 重复检测：基于文件名+size判断
    seen_signatures = {}  # {(name, size): first_rel_path}

    all_files = []
    for item in root.rglob('*'):
        if item.is_file() and '.trae' not in str(item) and '~$' not in item.name:
            all_files.append(item)

    for fpath in all_files:
        rel_path = str(fpath.relative_to(root))
        filename = fpath.name
        size = fpath.stat().st_size

        # 先判定初步类别
        prelim_cat = classify_file(filename)

        # 重复检测（基于name+size，跨目录）
        sig = (filename.lower(), size)
        if sig in seen_signatures:
            # 同名同size的后续文件 → 标记为重复，移到 99.其他资料/重复文件/
            first_seen = seen_signatures[sig]
            current_dir = fpath.parent
            dup_target_dir = root / FILE_ORGANIZER_CATEGORIES['99']['name'] / '重复文件'
            dup_target_dir.mkdir(parents=True, exist_ok=True)
            target_path = dup_target_dir / filename
            # 同名冲突处理
            if target_path.exists() and target_path != fpath:
                base, ext = os.path.splitext(filename)
                target_path = dup_target_dir / f'{base}_dup{ext}'
            moved = False
            if target_path != fpath:
                if not no_move:
                    try:
                        shutil.move(str(fpath), str(target_path))
                        new_rel = str(target_path.relative_to(root))
                        organized_duplicate.append({
                            'file': filename, 'from': rel_path,
                            'to': str(target_path.relative_to(root)),
                            'first_seen': first_seen,
                        })
                        file_map['files'][new_rel] = {
                            'category': '99',
                            'category_name': FILE_ORGANIZER_CATEGORIES['99']['name'],
                            'filename': filename,
                            'size': size,
                            'added_at': datetime.now().isoformat(),
                            'validity': 'duplicate',
                            'validity_reason': f'与{first_seen}同名同size',
                        }
                        moved = True
                    except Exception as e:
                        invalid_files.append({
                            'file': filename, 'path': rel_path,
                            'reason': f'重复文件移动失败: {e}',
                        })
                else:
                    organized_duplicate.append({
                        'file': filename, 'from': rel_path,
                        'to': str(target_path.relative_to(root)) + ' (no_move)',
                        'first_seen': first_seen,
                    })
                    moved = True
            if not moved:
                file_map['files'][rel_path] = {
                    'category': prelim_cat,
                    'category_name': FILE_ORGANIZER_CATEGORIES[prelim_cat]['name'],
                    'filename': filename,
                    'size': size,
                    'added_at': datetime.now().isoformat(),
                    'validity': 'duplicate',
                    'validity_reason': f'与{first_seen}同名同size（移动失败保留原地）',
                }
            continue
        else:
            seen_signatures[sig] = rel_path

        # 有效性评估
        validity, target_cat, reason = evaluate_file_validity(
            filename, rel_path, prelim_cat, year
        )

        current_dir = fpath.parent
        # 决定是否移动：补充资料目录、根目录散落文件 → 需要整理
        # 已在分类目录中的文件不重复移动
        in_supplement = '19.补充资料' in str(current_dir)
        in_root = current_dir == root
        in_historical = '98.历史参考资料' in str(current_dir)
        in_misc = '99.其他资料' in str(current_dir)
        in_category_dir = any(
            FILE_ORGANIZER_CATEGORIES[c]['name'] in str(current_dir)
            for c in FILE_ORGANIZER_CATEGORIES if c not in ['98', '99']
        )

        # invalid 不移动，只标记
        if validity == 'invalid':
            invalid_files.append({
                'file': filename, 'path': rel_path, 'reason': reason,
            })
            file_map['files'][rel_path] = {
                'category': prelim_cat,
                'category_name': FILE_ORGANIZER_CATEGORIES[prelim_cat]['name'],
                'filename': filename,
                'size': size,
                'added_at': datetime.now().isoformat(),
                'validity': 'invalid',
                'validity_reason': reason,
            }
            continue

        # duplicate（版本后缀文件）→ 移到 99.其他资料/重复文件/
        # 注意：此处处理的是 evaluate_file_validity 返回的版本后缀类 duplicate，
        # 前面已处理"同名同size"的 duplicate，此分支处理 _backup/_fixed/_扫描版 等
        if validity == 'duplicate':
            dup_target_dir = root / FILE_ORGANIZER_CATEGORIES['99']['name'] / '重复文件'
            dup_target_dir.mkdir(parents=True, exist_ok=True)
            target_path = dup_target_dir / filename
            if target_path.exists() and target_path != fpath:
                base, ext = os.path.splitext(filename)
                target_path = dup_target_dir / f'{base}_v{ext}'
            if no_move:
                new_rel = str(target_path.relative_to(root))
                organized_duplicate.append({
                    'file': filename, 'from': rel_path,
                    'to': f'{new_rel} (no_move)',
                    'first_seen': '(版本后缀文件)',
                })
                file_map['files'][rel_path] = {
                    'category': prelim_cat,
                    'category_name': FILE_ORGANIZER_CATEGORIES[prelim_cat]['name'],
                    'filename': filename,
                    'size': size,
                    'added_at': datetime.now().isoformat(),
                    'validity': 'duplicate',
                    'validity_reason': reason + ' (no_move)',
                }
            else:
                moved_dup = False
                if target_path != fpath:
                    try:
                        shutil.move(str(fpath), str(target_path))
                        new_rel = str(target_path.relative_to(root))
                        organized_duplicate.append({
                            'file': filename, 'from': rel_path,
                            'to': new_rel,
                            'first_seen': '(版本后缀文件)',
                        })
                        file_map['files'][new_rel] = {
                            'category': '99',
                            'category_name': FILE_ORGANIZER_CATEGORIES['99']['name'],
                            'filename': filename,
                            'size': size,
                            'added_at': datetime.now().isoformat(),
                            'validity': 'duplicate',
                            'validity_reason': reason,
                        }
                        moved_dup = True
                    except Exception as e:
                        invalid_files.append({
                            'file': filename, 'path': rel_path,
                            'reason': f'版本后缀文件移动失败: {e}',
                        })
                if not moved_dup:
                    file_map['files'][rel_path] = {
                        'category': prelim_cat,
                        'category_name': FILE_ORGANIZER_CATEGORIES[prelim_cat]['name'],
                        'filename': filename,
                        'size': size,
                        'added_at': datetime.now().isoformat(),
                        'validity': 'duplicate',
                        'validity_reason': reason + '（移动失败保留原地）',
                    }
            continue

        # 需要移动：在补充目录/根目录/其他历史杂项目录中，且目标类别不同
        target_dir_name = FILE_ORGANIZER_CATEGORIES[target_cat]['name']
        target_dir = root / target_dir_name

        # 已在正确目录则不移动
        already_in_target = (target_dir_name in str(current_dir))
        # 已在某个分类目录且valid → 不移动（避免乱搬）
        if validity == 'valid' and in_category_dir and not in_supplement:
            should_move = False
        elif validity == 'historical' and in_historical:
            should_move = False
        elif validity == 'misc' and in_misc:
            should_move = False
        else:
            should_move = True

        if no_move and should_move and not already_in_target:
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = target_dir / filename
            if target_path.exists() and target_path != fpath:
                base, ext = os.path.splitext(filename)
                target_path = target_dir / f'{base}_dup{ext}'
            new_rel = str(target_path.relative_to(root))
            entry = {
                'file': filename,
                'from': str(current_dir.relative_to(root)) if current_dir != root else '(root)',
                'to': f'{target_dir_name} (no_move)',
                'category': target_cat,
                'reason': reason + ' [no_move: 未实际移动]',
            }
            if validity == 'valid':
                organized.append(entry)
            elif validity == 'historical':
                organized_historical.append(entry)
            else:
                organized_misc.append(entry)
            if rel_path not in file_map['files']:
                file_map['files'][rel_path] = {
                    'category': target_cat,
                    'category_name': target_dir_name,
                    'filename': filename,
                    'size': size,
                    'added_at': datetime.now().isoformat(),
                    'validity': validity,
                    'validity_reason': reason + ' (no_move)',
                }
            else:
                file_map['files'][rel_path].update({
                    'validity': validity,
                    'validity_reason': reason + ' (no_move)',
                })
        elif should_move and not already_in_target:
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = target_dir / filename

            # 同名冲突处理
            if target_path.exists() and target_path != fpath:
                base, ext = os.path.splitext(filename)
                target_path = target_dir / f'{base}_dup{ext}'

            if target_path != fpath:
                try:
                    shutil.move(str(fpath), str(target_path))
                    new_rel = str(target_path.relative_to(root))
                    entry = {
                        'file': filename,
                        'from': str(current_dir.relative_to(root)) if current_dir != root else '(root)',
                        'to': target_dir_name,
                        'category': target_cat,
                        'reason': reason,
                    }
                    if validity == 'valid':
                        organized.append(entry)
                    elif validity == 'historical':
                        organized_historical.append(entry)
                    else:
                        organized_misc.append(entry)

                    # 更新file_map
                    if rel_path in file_map['files']:
                        file_map['files'].pop(rel_path)
                    file_map['files'][new_rel] = {
                        'category': target_cat,
                        'category_name': target_dir_name,
                        'filename': filename,
                        'size': target_path.stat().st_size,
                        'added_at': datetime.now().isoformat(),
                        'validity': validity,
                        'validity_reason': reason,
                    }
                except Exception as e:
                    invalid_files.append({
                        'file': filename, 'path': rel_path,
                        'reason': f'移动失败: {e}',
                    })
        else:
            # 不移动但更新file_map
            if rel_path not in file_map['files']:
                file_map['files'][rel_path] = {
                    'category': target_cat,
                    'category_name': FILE_ORGANIZER_CATEGORIES[target_cat]['name'],
                    'filename': filename,
                    'size': size,
                    'added_at': datetime.now().isoformat(),
                    'validity': validity,
                    'validity_reason': reason,
                }
            else:
                file_map['files'][rel_path].update({
                    'validity': validity,
                    'validity_reason': reason,
                })

    # 3. 保存更新后的file_map.json
    file_map_path.write_text(json.dumps(file_map, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[finalize] file_map.json 已更新（{len(file_map["files"])}个文件）')

    # 4. 更新experience_base.json
    exp_path = trae_dir / 'experience_base.json'
    if exp_path.exists():
        experience = json.loads(exp_path.read_text(encoding='utf-8'))
    else:
        experience = {'enterprise': enterprise, 'skill_executions': []}
    experience.setdefault('skill_executions', []).append({
        'skill': skill,
        'timestamp': datetime.now().isoformat(),
        'organized_valid': len(organized),
        'organized_historical': len(organized_historical),
        'organized_misc': len(organized_misc),
        'organized_duplicate': len(organized_duplicate),
        'invalid_count': len(invalid_files),
    })

    # === 经验流转闭环：步骤1 - 结构化经验沉淀 ===
    # 如果agent通过--experiences参数传入了经验，先写入pending_experiences.json
    if experiences_json:
        try:
            pending_exps = json.loads(experiences_json)
            pending_file = trae_dir / 'pending_experiences.json'
            pending_file.write_text(json.dumps(pending_exps, ensure_ascii=False, indent=2), encoding='utf-8')
            print(f'[finalize] 从--experiences参数加载{len(pending_exps)}条经验')
        except Exception as e:
            print(f'[finalize] 解析--experiences参数失败: {e}')

    # 收集结构化经验（agent传入 + 校验报告自动提取）
    structured_exps = _collect_structured_experiences(trae_dir, skill, enterprise)

    if structured_exps:
        # 写入项目级experience_base.json的6个分类
        experience.setdefault('schema_version', '2.0')
        for exp in structured_exps:
            category = exp.get('problem_type', 'common_issue')
            target_category = _EXPERIENCE_CATEGORY_MAP.get(category, 'common_issues')
            experience.setdefault(target_category, []).append(exp)

        # 更新skill_experience_index索引
        experience.setdefault('skill_experience_index', {}).setdefault(skill, [])
        today_str = datetime.now().strftime("%Y-%m-%d")
        base_seq = len([k for k in experience['skill_experience_index'][skill] if today_str in k])
        for idx, exp in enumerate(structured_exps, start=base_seq + 1):
            exp_id = exp.get('exp_id', f"EXP-{today_str}-{idx:03d}")
            exp['exp_id'] = exp_id
            experience['skill_experience_index'][skill].append(exp_id)
        print(f'[finalize] 已沉淀{len(structured_exps)}条结构化经验到experience_base.json')

    exp_path.write_text(json.dumps(experience, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[finalize] experience_base.json 已更新')

    # === 经验流转闭环：步骤2 - 写入working_trace.md ===
    session_info = {
        'skill': skill,
        'task': f'执行{skill}技能，整理{len(organized)}个有效文件',
        'completed': f'文件整理完成（有效{len(organized)}/历史{len(organized_historical)}/其他{len(organized_misc)}/重复{len(organized_duplicate)}/无效{len(invalid_files)}）',
        'outputs': f'file_map.json/experience_base.json/project_index.json已更新；_file_management_report.md已生成',
        'experiences_count': len(structured_exps),
        'pending': '无',
    }
    _append_working_trace(trae_dir, session_info)

    # === 经验流转闭环：步骤3 - 汇聚到全局技能经验库 ===
    if structured_exps:
        _sync_to_global_skill_experiences(trae_dir, skill, enterprise, structured_exps)

    # 5. 更新project_index.json
    idx_path = trae_dir / 'project_index.json'
    if idx_path.exists():
        project_index = json.loads(idx_path.read_text(encoding='utf-8'))
    else:
        project_index = {'enterprise': enterprise, 'application_year': year, 'skills_progress': {}}
    project_index.setdefault('skills_progress', {})[skill] = {
        'status': 'completed',
        'completed_at': datetime.now().isoformat(),
    }
    project_index['last_updated'] = datetime.now().isoformat()
    idx_path.write_text(json.dumps(project_index, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[finalize] project_index.json 已更新')

    # 6. 生成整理报告
    report_path = trae_dir / '_file_management_report.md'
    report_lines = [
        '# 文件管理报告',
        '',
        f'生成时间：{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}',
        f'企业：{enterprise}',
        f'申报年份：{year}（近三年={year-3}/{year-2}/{year-1}，上年度={year-1}）',
        f'技能：{skill}',
        '',
        '## 一、整理概览',
        '',
        f'- 有效资料已归入19类目录：{len(organized)} 个',
        f'- 历史参考资料（移入 98.历史参考资料）：{len(organized_historical)} 个',
        f'- 其他资料（移入 99.其他资料）：{len(organized_misc)} 个',
        f'- 重复文件（移入 99.其他资料/重复文件/）：{len(organized_duplicate)} 个',
        f'- 无效文件（草稿/临时/类型不合规，未移动）：{len(invalid_files)} 个',
        f'- 文件图谱总文件数：{len(file_map["files"])}',
        '',
        '## 二、有效资料归入19类目录',
        '',
    ]
    if organized:
        by_cat = {}
        for o in organized:
            by_cat.setdefault(o['category'], []).append(o)
        for cat_id in sorted(by_cat.keys()):
            report_lines.append(f'### {FILE_ORGANIZER_CATEGORIES[cat_id]["name"]}')
            for o in by_cat[cat_id]:
                report_lines.append(f'- {o["file"]}（从 {o["from"]} 移入）')
            report_lines.append('')
    else:
        report_lines.append('（本次无有效资料移入19类）')
        report_lines.append('')

    report_lines += ['## 三、历史参考资料（98.历史参考资料）', '']
    if organized_historical:
        for o in organized_historical:
            report_lines.append(f'- {o["file"]}（从 {o["from"]} 移入；原因：{o["reason"]}）')
    else:
        report_lines.append('（无）')
    report_lines.append('')

    report_lines += ['## 四、其他资料（99.其他资料）', '']
    if organized_misc:
        for o in organized_misc:
            report_lines.append(f'- {o["file"]}（从 {o["from"]} 移入；原因：{o["reason"]}）')
    else:
        report_lines.append('（无）')
    report_lines.append('')

    report_lines += ['## 五、无效文件（未移动，需人工清理）', '']
    if invalid_files:
        for u in invalid_files:
            report_lines.append(f'- {u["file"]}（{u["path"]}）：{u["reason"]}')
    else:
        report_lines.append('（无）')
    report_lines.append('')

    report_lines += ['## 六、重复文件（已移入 99.其他资料/重复文件/）', '']
    if organized_duplicate:
        for d in organized_duplicate:
            report_lines.append(f'- {d["file"]}（从 {d["from"]} 移入；首见于 {d["first_seen"]}）')
    else:
        report_lines.append('（无）')
    report_lines.append('')

    # 各类别文件统计
    report_lines += ['## 七、各类别文件统计（含有效性分布）', '']
    cat_stats = {}
    for f in file_map['files'].values():
        cat = f.get('category', '19')
        v = f.get('validity', 'valid')
        cat_stats.setdefault(cat, {}).setdefault(v, 0)
        cat_stats[cat][v] += 1
    for cat_id in sorted(cat_stats.keys()):
        v_counts = cat_stats[cat_id]
        parts = ', '.join(f'{k}={v}' for k, v in sorted(v_counts.items()))
        report_lines.append(f'- {FILE_ORGANIZER_CATEGORIES[cat_id]["name"]}: {sum(v_counts.values())}个（{parts}）')
    report_lines.append('')

    # 产出校验
    report_lines += ['## 八、产出校验', '']
    checks = [
        ('file_map.json', file_map_path.exists()),
        ('experience_base.json', exp_path.exists()),
        ('project_index.json', idx_path.exists()),
    ]
    all_ok = True
    for name, ok in checks:
        report_lines.append(f'- {"OK" if ok else "FAIL"} {name}')
        if not ok:
            all_ok = False
    report_lines.append('')
    report_lines.append(f'**校验结果：{"全部通过" if all_ok else "存在缺失，需人工检查"}**')

    report_path.write_text('\n'.join(report_lines), encoding='utf-8')
    print(f'[finalize] 整理报告已生成: {report_path}')

    # 7. 校验产出
    if not all_ok:
        print(f'[finalize] ERROR: 产出校验失败，3个json文件未全部生成')
        return False

    print(f'\n[finalize] === 整理摘要 ===')
    print(f'[finalize] 有效资料移入19类: {len(organized)}')
    print(f'[finalize] 历史参考资料移入98: {len(organized_historical)}')
    print(f'[finalize] 其他资料移入99: {len(organized_misc)}')
    print(f'[finalize] 重复文件移入99/重复文件: {len(organized_duplicate)}')
    print(f'[finalize] 无效文件未移动: {len(invalid_files)}')
    print(f'[finalize] 文件图谱总数: {len(file_map["files"])}')
    print(f'[finalize] 3个核心json: OK')
    print(f'[finalize] 整理报告: {report_path.name}')
    print(f'[finalize] 整理完成。')
    return True


# ============================================================
# capture 子命令：agent主动提交单条经验（无需技能跑完）
# ============================================================
def capture_experience(project_root, skill, enterprise, problem_type,
                       problem_desc, solution, prevention=None, cross_validated=None):
    """agent在技能工作中任何时候遇到值得记录的问题/方案，主动调用此函数提交经验

    与finalize_project的区别：
      - finalize_project: 技能最终步调用，整理文件+生成报告+批量沉淀经验
      - capture_experience: 技能执行中任何时候可调用，只提交单条经验，不动文件

    交叉验证支持（v2.1新增）：
      - cross_validated参数：经过cross_model_validator.py验证后的状态
      - None: 未交叉验证（传统模式，兼容旧版）
      - "consensus": 双模型一致确认
      - "disputed": MiniMax有异议，需人工仲裁
      - "single_source": MiniMax不可用，单模型提交

    复用现有函数：
      - _sync_to_global_skill_experiences() 汇聚到全局技能经验库
      - _append_working_trace() 写入项目留痕（标记capture模式）
      - _EXPERIENCE_CATEGORY_MAP 写入项目级experience_base.json对应分类
    """
    root = find_project_root(project_root)
    trae_dir = get_trae_dir(root)
    print(f'[capture] 项目根目录: {root}')
    print(f'[capture] 技能: {skill}')
    print(f'[capture] 企业: {enterprise}')

    if prevention is None:
        prevention = '技能执行时参考此经验避免重复犯错'

    # 确定经验状态（交叉验证集成）
    if cross_validated is None:
        status = 'pending'
    elif cross_validated == 'consensus':
        status = 'pending'  # 双模型一致，正常pending等待Code消费
    elif cross_validated == 'disputed':
        status = 'disputed'  # 有争议，需人工仲裁
    elif cross_validated == 'single_source':
        status = 'single_source'  # 单模型提交
    else:
        status = cross_validated

    experience = {
        'problem_type': problem_type,
        'problem_desc': problem_desc,
        'solution': solution,
        'prevention': prevention,
        'status': status,
    }

    if cross_validated:
        experience['cross_validated'] = cross_validated

    # 1. 写入项目级experience_base.json对应分类
    exp_path = trae_dir / 'experience_base.json'
    if exp_path.exists():
        try:
            exp_data = json.loads(exp_path.read_text(encoding='utf-8'))
        except Exception as e:
            print(f'[capture] 读取experience_base.json失败，将重建: {e}')
            exp_data = {'enterprise': enterprise, 'skill_executions': []}
    else:
        exp_data = {
            'enterprise': enterprise,
            'created_at': datetime.now().isoformat(),
            'common_issues': [],
            'validation_rules': [],
            'format_requirements': [],
            'skill_executions': [],
        }

    exp_data.setdefault('schema_version', '2.0')
    target_category = _EXPERIENCE_CATEGORY_MAP.get(problem_type, 'common_issues')
    exp_data.setdefault(target_category, []).append(experience)

    # 更新skill_experience_index索引
    exp_data.setdefault('skill_experience_index', {}).setdefault(skill, [])
    today_str = datetime.now().strftime("%Y-%m-%d")
    base_seq = len([k for k in exp_data['skill_experience_index'][skill] if today_str in k])
    exp_id = f"EXP-{today_str}-{base_seq + 1:03d}"
    experience['exp_id'] = exp_id
    exp_data['skill_experience_index'][skill].append(exp_id)

    exp_path.write_text(json.dumps(exp_data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[capture] 经验已写入experience_base.json [{target_category}]，exp_id={exp_id}')

    # 2. 写入working_trace.md（标记capture模式，区分完整finalize留痕）
    session_info = {
        'skill': f'{skill} (capture)',
        'task': f'技能执行中主动提交经验：{problem_type}',
        'completed': f'问题：{problem_desc[:80]}{"..." if len(problem_desc) > 80 else ""}',
        'outputs': f'experience_base.json已更新；exp_id={exp_id}已汇聚到全局技能经验库',
        'experiences_count': 1,
        'pending': '无（capture模式，不触发文件整理）',
    }
    _append_working_trace(trae_dir, session_info)

    # 3. 汇聚到全局技能经验库（_sync函数会基于全局计数重新分配exp_id并回写）
    _sync_to_global_skill_experiences(trae_dir, skill, enterprise, [experience])
    final_exp_id = experience.get('exp_id', exp_id)

    print(f'[capture] === 经验提交摘要 ===')
    print(f'[capture] exp_id: {final_exp_id}')
    print(f'[capture] 类型: {problem_type}')
    print(f'[capture] 问题: {problem_desc[:80]}{"..." if len(problem_desc) > 80 else ""}')
    print(f'[capture] 状态: pending（待Code模式消费）')
    print(f'[capture] 经验提交完成。')
    return True


# ============================================================
# 命令行入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description='高新认定项目文件管理器',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
示例：
  python project_context_manager.py init --enterprise "深圳锐取电子有限公司" --year 2026
  python project_context_manager.py finalize --enterprise "深圳锐取电子有限公司" --year 2026 --skill "gxtz-info-collector"
  python project_context_manager.py finalize --enterprise "深圳锐取电子有限公司" --year 2026 --skill "gxtz-info-collector" --no-move

设计逻辑（agent可据此自主实现）：
  init: 在.trae目录创建file_map.json/experience_base.json/project_index.json，扫描项目文件
  finalize: 按19类目录整理文件 → 生成报告 → 更新3个json → 校验产出（--no-move 仅登记不移动）
        ''',
    )
    subparsers = parser.add_subparsers(dest='command', help='子命令')

    # init 子命令
    init_parser = subparsers.add_parser('init', help='初始化项目知识库')
    init_parser.add_argument('--enterprise', required=True, help='企业名称')
    init_parser.add_argument('--year', type=int, required=True, help='申报年份')
    init_parser.add_argument('--project-root', default=None, help='项目根目录（默认自动检测）')

    # finalize 子命令
    fin_parser = subparsers.add_parser('finalize', help='整理文件并更新知识库')
    fin_parser.add_argument('--enterprise', required=True, help='企业名称')
    fin_parser.add_argument('--year', type=int, required=True, help='申报年份')
    fin_parser.add_argument('--skill', required=True, help='当前执行的技能名称')
    fin_parser.add_argument('--project-root', default=None, help='项目根目录（默认自动检测）')
    fin_parser.add_argument('--experiences', type=str, default=None,
                            help='JSON字符串，agent主动传递的结构化经验（格式：[{"problem_type":"common_issue","problem_desc":"...","solution":"...","prevention":"...","status":"pending"}]）')
    fin_parser.add_argument('--no-move', action='store_true', default=False,
                            help='禁用文件实体移动，仅做分类登记和索引更新（默认不禁用）')

    # capture 子命令：agent主动提交单条经验（无需技能跑完）
    cap_parser = subparsers.add_parser('capture', help='主动提交单条经验（无需技能跑完）')
    cap_parser.add_argument('--project-root', required=True, help='项目根目录（D盘路径）')
    cap_parser.add_argument('--skill', required=True, help='技能名称（如gxtz-core-tables）')
    cap_parser.add_argument('--enterprise', required=True, help='企业名称（作为source_project）')
    cap_parser.add_argument('--problem-type', required=True,
                            choices=['common_issue', 'validation_rule', 'format_requirement',
                                     'review_checkpoint', 'best_practice', 'upgrade_trigger'],
                            help='经验类型')
    cap_parser.add_argument('--problem-desc', required=True, help='问题描述')
    cap_parser.add_argument('--solution', required=True, help='解决方案')
    cap_parser.add_argument('--prevention', default=None, help='预防/复用建议（可选）')
    cap_parser.add_argument('--cross-validated', default=None,
                            choices=['consensus', 'disputed', 'single_source'],
                            help='交叉验证状态（由cross_model_validator.py产出）')

    args = parser.parse_args()

    if args.command == 'init':
        success = init_project(args.enterprise, args.year, args.project_root)
        sys.exit(0 if success else 1)
    elif args.command == 'finalize':
        success = finalize_project(args.enterprise, args.year, args.skill, args.project_root, args.experiences, no_move=getattr(args, 'no_move', False))
        sys.exit(0 if success else 1)
    elif args.command == 'capture':
        success = capture_experience(
            args.project_root, args.skill, args.enterprise,
            args.problem_type, args.problem_desc, args.solution, args.prevention,
            args.cross_validated
        )
        sys.exit(0 if success else 1)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()
