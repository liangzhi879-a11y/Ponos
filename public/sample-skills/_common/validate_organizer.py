"""文件整理结果审核验证脚本

用途：审核 gxtz-file-organizer 技能执行结果是否合规，包括：
  1. 目录结构校验：四个输出目录是否存在
  2. 必要报告文件校验：整理报告/命名对照表/缺失清单/备份索引是否存在
  3. 内容完整性校验：文件计数、空文件检测、临时文件检测
  4. 命名合规校验：申报材料文件命名是否符合规范（IP/RD/PS/财务/税务）
  5. 时效性校验：过期资料目录中文件日期是否早于申报年份-3
  6. 跨卷校验：原始资料/申报材料/备案资料文件数量对比
  7. 文件大小校验：申报材料文件是否超过深圳市申报系统大小限制

用法：
  python validate_organizer.py validate --project-root "项目根目录" --year 申报年份 --enterprise "企业名称"

输出：JSON 格式审核报告，结构如下：
  {
    "passed": bool,
    "errors": [{"file": "...", "row": 0, "field": "...", "reason": "..."}],
    "warnings": [...],
    "stats": {
      "total_files": N,
      "raw_materials_files": N,
      "application_materials_files": N,
      "filing_materials_files": N,
      "backup_files": N,
      "expired_files": N,
      "categories_found": [...],
      "categories_missing": [...],
      "naming_compliance_rate": 0.95,
      "size_violations": [...]
    }
  }

退出码：审核通过 0，存在错误 1

依赖：仅使用 Python 标准库（os/re/json/argparse/pathlib）
"""

import os
import re
import sys
import json
import argparse


# ============================================================
# 常量定义
# ============================================================

REQUIRED_DIRECTORIES = [
    '000 原始资料',
    '000 申报材料',
    '000 备案资料',
    '_备份资料',
]

REQUIRED_REPORTS = {
    '000 原始资料': '_整理报告.md',
    '000 申报材料': '_命名对照表.md',
    '000 备案资料': '_缺失清单.md',
    '_备份资料': '_备份索引.json',
}

NINETEEN_CATEGORIES = [
    '1.IP证明材料（知识产权）',
    '2.企业研究开发活动情况证明材料-立项报告任务书验收报告（RD）',
    '3.PS证明材料（高新技术产品）',
    '4.科技成果转化',
    '5.标准资料（参与制定的各类标准文件）',
    '6.营业执照',
    '8.前三年财务审计报告',
    '9.前三年企业所得税纳税申报表',
    '10.前三年研发费用专项审计报告',
    '11.上年度高新产品（服务）收入专项审计报告',
    '12-15.组织管理制度',
    '16.人力资源情况证明材料',
    '17.上年度与高新技术产品（服务）相关的代表性的销售合同与发票',
    '18.往期项目资料',
    '19.补充资料',
    '_过期资料',
]

EXPIRED_DIR_NAME = '_过期资料'

IP_PATTERN = re.compile(r'^IP\d{2}_.+\.pdf$', re.IGNORECASE)
RD_PATTERN = re.compile(r'^RD\d{2}_.+\.pdf$', re.IGNORECASE)
PS_PATTERN = re.compile(r'^PS\d{2}_.+\.pdf$', re.IGNORECASE)
FINANCIAL_AUDIT_PATTERN = re.compile(r'^\d{4}_财务审计报告\.pdf$')
TAX_REPORT_PATTERN = re.compile(r'^\d{4}_企业所得税纳税申报表\.pdf$')
EXPECTED_PATTERNS = {
    'IP': IP_PATTERN,
    'RD': RD_PATTERN,
    'PS': PS_PATTERN,
    '财务审计报告': FINANCIAL_AUDIT_PATTERN,
    '企业所得税纳税申报表': TAX_REPORT_PATTERN,
}

PATTERN_DESCRIPTIONS = {
    'IP': 'IP{编号}_{知识产权名称}.pdf',
    'RD': 'RD{编号}_{研发活动名称}.pdf',
    'PS': 'PS{编号}_{产品名称}.pdf',
    '财务审计报告': '{年份}_财务审计报告.pdf',
    '企业所得税纳税申报表': '{年份}_企业所得税纳税申报表.pdf',
}

SIZE_LIMITS_MB = {
    'IP': 2,
    'RD': 2,
    'PS': 4,
    '科技成果转化': 2,
    '标准': 2,
    '营业执照': 0.5,
    '申报书封皮': 1,
    '财务审计报告': 100,
    '企业所得税纳税申报表': 5,
    '研发费用专审': 100,
    '高新收入专审': 100,
    '研发管理制度': 20,
    '产学研': 20,
    '激励制度': 5,
    '绩效奖励': 5,
    '人力资源': 8,
    '销售合同与发票': 20,
    '企业承诺书': 1,
    '申请书签字盖章': 1,
}
DEFAULT_SIZE_LIMIT_MB = 10

FILE_SIZE_HINTS = {
    1 * 1024 * 1024: '≤1M',
    2 * 1024 * 1024: '≤2M',
    4 * 1024 * 1024: '≤4M',
    5 * 1024 * 1024: '≤5M',
    8 * 1024 * 1024: '≤8M',
    10 * 1024 * 1024: '≤10M',
    20 * 1024 * 1024: '≤20M',
    100 * 1024 * 1024: '≤100M',
}


# ============================================================
# 工具函数
# ============================================================

def _count_files_recursive(directory):
    """递归统计目录内文件总数（排除目录本身和隐藏文件/备份文件）"""
    if not os.path.isdir(directory):
        return 0
    count = 0
    for root, dirs, files in os.walk(directory):
        for f in files:
            if f.startswith('~$'):
                continue
            if f.endswith('.bak'):
                continue
            count += 1
    return count


def _get_all_files(directory):
    """获取目录下所有文件的路径列表，排除目录"""
    result = []
    if not os.path.isdir(directory):
        return result
    for root, dirs, files in os.walk(directory):
        for f in files:
            result.append(os.path.join(root, f))
    return result


def _file_size_mb(file_path):
    """获取文件大小（MB）"""
    try:
        return os.path.getsize(file_path) / (1024 * 1024)
    except OSError:
        return -1


def _classify_file_category(filename):
    """根据文件名前缀判断文件属于哪个匹配模式
    
    返回：匹配的模式名（如 'IP', 'RD', 'PS', '财务审计报告', '企业所得税纳税申报表'）或 None
    """
    base = os.path.basename(filename)
    for name, pattern in EXPECTED_PATTERNS.items():
        if pattern.match(base):
            return name
    # 宽匹配：检查是否有 IP、RD、PS 前缀（忽略大小写）
    upper = base.upper()
    if upper.startswith('IP') and len(upper) > 2 and upper[2].isdigit():
        return 'IP'
    if upper.startswith('RD') and len(upper) > 2 and upper[2].isdigit():
        return 'RD'
    if upper.startswith('PS') and len(upper) > 2 and upper[2].isdigit():
        return 'PS'
    if '审计报告' in base and re.search(r'20\d{2}', base):
        return '财务审计报告'
    if '纳税申报' in base and re.search(r'20\d{2}', base):
        return '企业所得税纳税申报表'
    return None


def _get_size_limit_for_file(filename):
    """根据文件名判断适用的文件大小限制（MB）"""
    category = _classify_file_category(filename)
    if category and category in SIZE_LIMITS_MB:
        return SIZE_LIMITS_MB[category]
    for key, limit in SIZE_LIMITS_MB.items():
        if key in filename:
            return limit
    return DEFAULT_SIZE_LIMIT_MB


def _extract_year_from_filename(filename):
    """从文件名提取4位年份
    
    返回：年份（int）或 None
    """
    base = os.path.basename(filename)
    years = re.findall(r'(20\d{2})', base)
    if years:
        return int(years[0])
    return None


# ============================================================
# 校验函数
# ============================================================

def _check_directory_structure(project_root):
    """校验 a. 目录结构
    
    返回：(errors, warnings)
    """
    errors = []
    warnings = []
    for dir_name in REQUIRED_DIRECTORIES:
        dir_path = os.path.join(project_root, dir_name)
        if not os.path.exists(dir_path):
            errors.append({
                'file': dir_name, 'row': 0, 'field': 'directory',
                'reason': f'缺少必要目录: {dir_name}/',
            })
        elif not os.path.isdir(dir_path):
            errors.append({
                'file': dir_name, 'row': 0, 'field': 'directory',
                'reason': f'路径不是目录: {dir_name}',
            })
    return errors, warnings


def _check_required_reports(project_root):
    """校验 b. 必要报告文件
    
    返回：(errors, warnings)
    """
    errors = []
    warnings = []
    for dir_name, report_name in REQUIRED_REPORTS.items():
        report_path = os.path.join(project_root, dir_name, report_name)
        if not os.path.exists(report_path):
            msg = f'{dir_name}/{report_name}'
            errors.append({
                'file': msg, 'row': 0, 'field': 'report',
                'reason': f'缺少必要报告文件: {msg}',
            })
    return errors, warnings


def _check_content_integrity(project_root):
    """校验 c. 内容完整性
    
    返回：(errors, warnings, stats_partial)
    """
    errors = []
    warnings = []
    stats = {
        'temp_files': [],
        'empty_files': [],
    }

    for dir_name in REQUIRED_DIRECTORIES:
        dir_path = os.path.join(project_root, dir_name)
        if not os.path.isdir(dir_path):
            continue

        for root, dirs, files in os.walk(dir_path):
            for f in files:
                full_path = os.path.join(root, f)

                if f.startswith('~$'):
                    rel_path = os.path.relpath(full_path, project_root)
                    stats['temp_files'].append(rel_path)
                    errors.append({
                        'file': rel_path, 'row': 0, 'field': 'temp_file',
                        'reason': f'发现临时文件（~$开头）: {rel_path}，请清理后重新整理',
                    })
                    continue

                if f.endswith('.bak'):
                    continue

                file_size = os.path.getsize(full_path)
                if file_size == 0:
                    rel_path = os.path.relpath(full_path, project_root)
                    stats['empty_files'].append(rel_path)
                    warnings.append({
                        'file': rel_path, 'row': 0, 'field': 'empty_file',
                        'reason': f'文件大小为 0: {rel_path}',
                    })

    return errors, warnings, stats


def _check_naming_compliance(project_root):
    """校验 d. 命名合规性（针对 000 申报材料/）
    
    返回：(errors, warnings, rate, size_violations)
    """
    errors = []
    warnings = []
    app_dir = os.path.join(project_root, '000 申报材料')
    if not os.path.isdir(app_dir):
        return errors, warnings, 1.0, []

    all_files = []
    for root, dirs, files in os.walk(app_dir):
        for f in files:
            if f.startswith('~$') or f.startswith('_'):
                continue
            full_path = os.path.join(root, f)
            all_files.append((f, full_path))

    if not all_files:
        return errors, warnings, 1.0, []

    compliant_count = 0
    size_violations = []

    for fname, fpath in all_files:
        matched = False

        for name, pattern in EXPECTED_PATTERNS.items():
            if pattern.match(fname):
                matched = True
                compliant_count += 1
                break

        if not matched:
            warnings.append({
                'file': os.path.relpath(fpath, project_root), 'row': 0, 'field': 'naming',
                'reason': f'文件名不符合预期命名规范: {fname}',
            })
        else:
            file_size_mb_val = _file_size_mb(fpath)
            if file_size_mb_val > 0:
                size_limit = _get_size_limit_for_file(fname)
                if file_size_mb_val > size_limit:
                    rel_path = os.path.relpath(fpath, project_root)
                    size_violations.append({
                        'file': rel_path,
                        'size_mb': round(file_size_mb_val, 2),
                        'limit_mb': size_limit,
                    })
                    warnings.append({
                        'file': rel_path, 'row': 0, 'field': 'file_size',
                        'reason': f'文件大小 {file_size_mb_val:.1f}MB 超过限制 {size_limit}MB: {fname}',
                    })

    rate = compliant_count / len(all_files) if all_files else 1.0
    return errors, warnings, rate, size_violations


def _check_temporal_validity(project_root, year):
    """校验 e. 时效性
    
    - 000 原始资料/_过期资料/ 中的文件日期应早于 year-3
    - 000 申报材料/ 和 000 备案资料/ 中不应有过期文件
    
    返回：(errors, warnings, expired_count)
    """
    errors = []
    warnings = []
    expired_threshold = year - 3

    raw_dir = os.path.join(project_root, '000 原始资料')
    expired_dir = os.path.join(raw_dir, EXPIRED_DIR_NAME)

    if os.path.isdir(expired_dir):
        expired_files = []
        for root, dirs, files in os.walk(expired_dir):
            for f in files:
                if f.startswith('~$') or f.startswith('_'):
                    continue
                fpath = os.path.join(root, f)
                fyear = _extract_year_from_filename(f)
                if fyear is not None and fyear >= expired_threshold:
                    rel_path = os.path.relpath(fpath, project_root)
                    errors.append({
                        'file': rel_path, 'row': 0, 'field': 'expired',
                        'reason': f'过期资料目录中文件年份({fyear})不晚于{expired_threshold}年，不应归入过期资料: {f}',
                    })
                expired_files.append(fpath)

        expired_count = len(expired_files)

        if expired_count == 0:
            warnings.append({
                'file': '_过期资料/', 'row': 0, 'field': 'expired',
                'reason': '过期资料目录存在但为空',
            })
    else:
        warnings.append({
            'file': '000 原始资料/_过期资料/', 'row': 0, 'field': 'expired',
            'reason': '缺少 _过期资料/ 子目录，无法确认过期资料是否正确归档',
        })
        expired_count = 0

    for check_dir_name in ['000 申报材料', '000 备案资料']:
        check_dir = os.path.join(project_root, check_dir_name)
        if not os.path.isdir(check_dir):
            continue
        for root, dirs, files in os.walk(check_dir):
            for f in files:
                if f.startswith('~$') or f.startswith('_'):
                    continue
                fyear = _extract_year_from_filename(f)
                if fyear is not None and fyear < expired_threshold:
                    rel_path = os.path.relpath(os.path.join(root, f), project_root)
                    errors.append({
                        'file': rel_path, 'row': 0, 'field': 'expired',
                        'reason': f'{check_dir_name} 中发现过期文件（年份{fyear} < {expired_threshold}）: {f}',
                    })

    return errors, warnings, expired_count


def _check_cross_volume(project_root):
    """校验 f. 跨卷对比
    
    比较原始资料/申报材料/备案资料的文件数量，标记显著差异
    
    返回：(errors, warnings)
    """
    errors = []
    warnings = []

    volumes = {
        '000 原始资料': _count_files_recursive(os.path.join(project_root, '000 原始资料')),
        '000 申报材料': _count_files_recursive(os.path.join(project_root, '000 申报材料')),
        '000 备案资料': _count_files_recursive(os.path.join(project_root, '000 备案资料')),
    }

    raw_count = volumes.get('000 原始资料', 0)
    app_count = volumes.get('000 申报材料', 0)
    filing_count = volumes.get('000 备案资料', 0)

    if raw_count == 0:
        warnings.append({
            'file': '000 原始资料/', 'row': 0, 'field': 'file_count',
            'reason': '000 原始资料/ 中没有找到任何文件',
        })
    if app_count == 0:
        warnings.append({
            'file': '000 申报材料/', 'row': 0, 'field': 'file_count',
            'reason': '000 申报材料/ 中没有找到任何文件',
        })
    if filing_count == 0:
        warnings.append({
            'file': '000 备案资料/', 'row': 0, 'field': 'file_count',
            'reason': '000 备案资料/ 中没有找到任何文件',
        })

    if raw_count > 0 and app_count > 0:
        if app_count < raw_count * 0.1:
            errors.append({
                'file': '', 'row': 0, 'field': 'cross_volume',
                'reason': f'申报材料文件数({app_count})远少于原始资料({raw_count})，'
                          f'仅占 {app_count/raw_count*100:.0f}%，疑似申报材料未正确生成',
            })
        elif app_count < raw_count * 0.3:
            warnings.append({
                'file': '', 'row': 0, 'field': 'cross_volume',
                'reason': f'申报材料文件数({app_count})明显少于原始资料({raw_count})，'
                          f'占比 {app_count/raw_count*100:.0f}%，请确认是否有遗漏',
            })

    if raw_count > 0 and filing_count > 0:
        if filing_count < raw_count * 0.1:
            errors.append({
                'file': '', 'row': 0, 'field': 'cross_volume',
                'reason': f'备案资料文件数({filing_count})远少于原始资料({raw_count})，'
                          f'仅占 {filing_count/raw_count*100:.0f}%，疑似备案资料未正确生成',
            })

    return errors, warnings, volumes


def _check_categories(project_root):
    """校验原始资料目录下的分类是否覆盖19类
    
    返回：(categories_found, categories_missing)
    """
    raw_dir = os.path.join(project_root, '000 原始资料')
    if not os.path.isdir(raw_dir):
        return [], NINETEEN_CATEGORIES

    found = []
    for entry in os.listdir(raw_dir):
        entry_path = os.path.join(raw_dir, entry)
        if os.path.isdir(entry_path):
            found.append(entry)

    categories_found = [c for c in NINETEEN_CATEGORIES if c in found]
    categories_missing = [c for c in NINETEEN_CATEGORIES if c not in found]

    return categories_found, categories_missing


# ============================================================
# 主编审函数
# ============================================================

def validate_organizer(project_root, year, enterprise=None):
    """审核文件整理结果

    参数：
      project_root: 项目根目录
      year: 申报年份
      enterprise: 企业名称（保留参数，供未来扩展使用）

    返回：审核报告 dict
    """
    all_errors = []
    all_warnings = []
    stats = {
        'total_files': 0,
        'raw_materials_files': 0,
        'application_materials_files': 0,
        'filing_materials_files': 0,
        'backup_files': 0,
        'expired_files': 0,
        'categories_found': [],
        'categories_missing': [],
        'naming_compliance_rate': 1.0,
        'size_violations': [],
    }

    # ----------------------------------------
    # 预检：项目根目录是否存在
    # ----------------------------------------
    if not os.path.isdir(project_root):
        return {
            'passed': False,
            'errors': [{
                'file': project_root, 'row': 0, 'field': 'project_root',
                'reason': f'项目根目录不存在: {project_root}',
            }],
            'warnings': [],
            'stats': stats,
        }

    # ----------------------------------------
    # 校验 a: 目录结构
    # ----------------------------------------
    errs, warns = _check_directory_structure(project_root)
    all_errors.extend(errs)
    all_warnings.extend(warns)

    # ----------------------------------------
    # 校验 b: 必要报告文件
    # ----------------------------------------
    errs, warns = _check_required_reports(project_root)
    all_errors.extend(errs)
    all_warnings.extend(warns)

    # ----------------------------------------
    # 校验 c: 内容完整性
    # ----------------------------------------
    errs, warns, integrity_stats = _check_content_integrity(project_root)
    all_errors.extend(errs)
    all_warnings.extend(warns)

    # ----------------------------------------
    # 统计各类目录文件数
    # ----------------------------------------
    raw_materials_dir = os.path.join(project_root, '000 原始资料')
    app_materials_dir = os.path.join(project_root, '000 申报材料')
    filing_dir = os.path.join(project_root, '000 备案资料')
    backup_dir = os.path.join(project_root, '_备份资料')

    raw_count = _count_files_recursive(raw_materials_dir)
    app_count = _count_files_recursive(app_materials_dir)
    filing_count = _count_files_recursive(filing_dir)
    backup_count = _count_files_recursive(backup_dir)

    expired_dir = os.path.join(raw_materials_dir, EXPIRED_DIR_NAME)
    expired_in_raw = _count_files_recursive(expired_dir)

    stats['raw_materials_files'] = raw_count
    stats['application_materials_files'] = app_count
    stats['filing_materials_files'] = filing_count
    stats['backup_files'] = backup_count
    stats['expired_files'] = expired_in_raw

    total = 0
    for d in [raw_materials_dir, app_materials_dir, filing_dir, backup_dir]:
        if os.path.isdir(d):
            total += _count_files_recursive(d)
    stats['total_files'] = total

    # ----------------------------------------
    # 校验 d: 命名合规性
    # ----------------------------------------
    errs, warns, naming_rate, size_violations = _check_naming_compliance(project_root)
    all_errors.extend(errs)
    all_warnings.extend(warns)
    stats['naming_compliance_rate'] = naming_rate
    stats['size_violations'] = size_violations

    # ----------------------------------------
    # 校验 e: 时效性
    # ----------------------------------------
    errs, warns, _ = _check_temporal_validity(project_root, year)
    all_errors.extend(errs)
    all_warnings.extend(warns)

    # ----------------------------------------
    # 校验 f: 跨卷对比
    # ----------------------------------------
    errs, warns, _ = _check_cross_volume(project_root)
    all_errors.extend(errs)
    all_warnings.extend(warns)

    # ----------------------------------------
    # 分类覆盖统计
    # ----------------------------------------
    categories_found, categories_missing = _check_categories(project_root)
    stats['categories_found'] = categories_found
    stats['categories_missing'] = categories_missing

    if categories_missing:
        for cat in categories_missing:
            if cat == EXPIRED_DIR_NAME:
                continue
            all_warnings.append({
                'file': '000 原始资料/', 'row': 0, 'field': 'category',
                'reason': f'缺少分类目录: {cat}',
            })

    # ----------------------------------------
    # 汇总
    # ----------------------------------------
    passed = len(all_errors) == 0
    return {
        'passed': passed,
        'errors': all_errors,
        'warnings': all_warnings,
        'stats': stats,
    }


# ============================================================
# CLI 入口
# ============================================================

def main():
    """CLI 入口：解析参数并执行文件整理结果审核"""
    parser = argparse.ArgumentParser(
        description='文件整理结果审核脚本 - 校验 gxtz-file-organizer 技能执行结果合规性',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''示例：
  python validate_organizer.py validate --project-root "D:\\项目目录" --year 2026 --enterprise "深圳派成铝业科技"
''',
    )
    subparsers = parser.add_subparsers(dest='command', help='子命令')

    validate_parser = subparsers.add_parser('validate', help='执行审核验证')
    validate_parser.add_argument('--project-root', dest='project_root', required=True,
                                 help='项目根目录')
    validate_parser.add_argument('--year', type=int, required=True,
                                 help='申报年份（如 2026）')
    validate_parser.add_argument('--enterprise', dest='enterprise', default=None,
                                 help='企业名称')

    args = parser.parse_args()

    if args.command != 'validate':
        parser.print_help()
        sys.exit(1)

    report = validate_organizer(args.project_root, args.year, args.enterprise)
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    sys.exit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
