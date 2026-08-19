"""管理制度材料审核脚本

用途：审核高新技术企业认定申报中的管理制度及证明材料是否合规，包括：
  1. 管理制度文档完整性：检查研发制度、辅助账、产学研合作等文档是否存在
  2. 研发制度校验：研发管理制度、研发人员考核激励制度、科技成果转化激励制度
  3. 研发辅助账校验：是否存在研发费用辅助账文件
  4. 产学研合作校验：是否有产学研合作协议
  5. 制度文档格式校验：检查 docx/pdf 格式
  6. 制度文档命名规范校验

用法：
  python validate_management.py --dir "管理制度材料目录"
  python validate_management.py --dir "管理制度材料目录" --project-root "项目根目录"
  python validate_management.py --file "单个制度文件.docx" --project-root "项目根目录"

输出：JSON 格式审核报告，结构如下：
  {
    "passed": bool,
    "errors": [{"file": "...", "row": 0, "field": "...", "reason": "..."}],
    "warnings": [...],
    "stats": {"total_docs": N, "valid_docs": N, "invalid_docs": N, ...}
  }

退出码：审核通过 0，存在错误 1

依赖：仅使用 Python 标准库（os/re/json/argparse）
"""

import os
import re
import sys
import json
import argparse


# ============================================================
# 常量定义
# ============================================================

# 制度文档支持的扩展名
DOC_EXTENSIONS = ('.docx', '.pdf', '.doc')

# 必备制度文档类别及其关键词映射
# 每个类别需至少匹配一个关键词
REQUIRED_REGULATIONS = {
    '研发管理制度': ['研发管理', '研发制度', '研发组织管理'],
    '研发人员考核激励制度': ['研发人员考核', '研发人员激励', '研发考核激励', '研发人员绩效'],
    '科技成果转化激励制度': ['科技成果转化激励', '成果转化激励', '成果转化奖励', '转化激励'],
}

# 研发辅助账关键词
AUXILIARY_ACCOUNT_KEYWORDS = ['辅助账', '研发费用辅助', '研发支出辅助']

# 产学研合作关键词
COLLABORATION_KEYWORDS = ['产学研', '校企合作', '院企合作', '产学研合作']

# 命名规范：建议格式为"类别_名称.docx"或包含制度类别关键词
# 禁止使用默认文件名（如"新建文档"、"未命名"、"Untitled"等）
INVALID_NAME_PATTERNS = [
    r'新建文档', r'未命名', r'Untitled', r'新建\s*Microsoft',
    r'文档\d', r'副本', r'\d{4}-\d{2}-\d{2}\.docx$',  # 纯日期命名
]

# 命名规范正则
INVALID_NAME_REGEX = re.compile('|'.join(INVALID_NAME_PATTERNS), re.IGNORECASE)


def _load_project_index(project_root):
    """加载 project_index.json，用于获取项目上下文信息

    查找顺序：
      1. project_root/.trae/project_knowledge/project_index.json
      2. project_root/.trae/project_index.json
    """
    if not project_root:
        return None
    candidates = [
        os.path.join(project_root, '.trae', 'project_knowledge', 'project_index.json'),
        os.path.join(project_root, '.trae', 'project_index.json'),
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, OSError):
                return None
    return None


def _scan_management_files(mgmt_dir):
    """扫描管理制度材料目录下的所有文档文件

    返回：[{'file': 文件名, 'path': 完整路径, 'ext': 扩展名(小写)}, ...]
    """
    docs = []
    if not os.path.isdir(mgmt_dir):
        return docs
    for entry in sorted(os.listdir(mgmt_dir)):
        ext = os.path.splitext(entry)[1].lower()
        if ext not in DOC_EXTENSIONS:
            continue
        docs.append({
            'file': entry,
            'path': os.path.join(mgmt_dir, entry),
            'ext': ext,
        })
    return docs


def _match_category(filename, keywords):
    """检查文件名是否包含指定类别关键词

    参数：
      filename: 文件名
      keywords: 关键词列表

    返回：匹配到的关键词，或 None
    """
    for kw in keywords:
        if kw in filename:
            return kw
    return None


def _check_name_convention(filename):
    """检查文件命名是否规范

    返回：(是否规范, 不规范原因)
    """
    # 检查是否使用默认/无效命名
    if INVALID_NAME_REGEX.search(filename):
        return False, '文件名疑似使用默认命名或包含不规范内容（如"新建文档"、"副本"等）'

    # 检查文件名长度（过短可能是命名不规范）
    name_without_ext = os.path.splitext(filename)[0]
    if len(name_without_ext) < 4:
        return False, f'文件名过短（"{name_without_ext}"），建议使用描述性命名'

    return True, None


def validate_management_directory(mgmt_dir, project_root=None):
    """审核管理制度材料目录

    参数：
      mgmt_dir: 管理制度材料目录路径
      project_root: 项目根目录（用于读取 project_index.json）

    返回：审核报告 dict
    """
    errors = []
    warnings = []
    stats = {
        'total_docs': 0,
        'valid_docs': 0,
        'invalid_docs': 0,
        'found_regulations': {},       # 已发现的制度类别
        'missing_regulations': [],     # 缺失的制度类别
        'has_auxiliary_account': False,
        'has_collaboration': False,
        'by_format': {'docx': 0, 'pdf': 0, 'doc': 0, 'other': 0},
    }

    # ============================================================
    # 校验 1：目录结构校验
    # ============================================================
    if not os.path.exists(mgmt_dir):
        errors.append({
            'file': mgmt_dir, 'row': 0, 'field': 'directory',
            'reason': f'管理制度材料目录不存在: {mgmt_dir}',
        })
        return {'passed': False, 'errors': errors, 'warnings': warnings, 'stats': stats}

    if not os.path.isdir(mgmt_dir):
        errors.append({
            'file': mgmt_dir, 'row': 0, 'field': 'directory',
            'reason': f'管理制度材料路径不是目录: {mgmt_dir}',
        })
        return {'passed': False, 'errors': errors, 'warnings': warnings, 'stats': stats}

    # 扫描目录下所有文档
    docs = _scan_management_files(mgmt_dir)
    stats['total_docs'] = len(docs)

    if stats['total_docs'] == 0:
        errors.append({
            'file': '', 'row': 0, 'field': 'documents',
            'reason': '管理制度材料目录下未找到任何文档文件（docx/pdf/doc）',
        })
        return {'passed': False, 'errors': errors, 'warnings': warnings, 'stats': stats}

    # ============================================================
    # 逐个校验文档
    # ============================================================
    found_regulations = {}  # 类别 -> 文件名
    has_auxiliary_account = False
    has_collaboration = False

    for doc in docs:
        fname = doc['file']
        ext = doc['ext']
        has_error = False

        # 校验 5：制度文档格式校验
        if ext == '.docx':
            stats['by_format']['docx'] += 1
        elif ext == '.pdf':
            stats['by_format']['pdf'] += 1
        elif ext == '.doc':
            stats['by_format']['doc'] += 1
            warnings.append({
                'file': fname, 'row': 0, 'field': 'format',
                'reason': '文档使用 .doc 格式，建议统一转换为 .docx 格式',
            })
        else:
            stats['by_format']['other'] += 1
            errors.append({
                'file': fname, 'row': 0, 'field': 'format',
                'reason': f'不支持的文档格式: {ext}（仅支持 docx/pdf）',
            })
            has_error = True

        # 校验 6：制度文档命名规范校验
        is_valid_name, name_reason = _check_name_convention(fname)
        if not is_valid_name:
            warnings.append({
                'file': fname, 'row': 0, 'field': 'naming',
                'reason': name_reason,
            })

        # 校验 2：研发制度类别匹配
        for category, keywords in REQUIRED_REGULATIONS.items():
            matched = _match_category(fname, keywords)
            if matched and category not in found_regulations:
                found_regulations[category] = fname

        # 校验 3：研发辅助账匹配
        if not has_auxiliary_account:
            matched = _match_category(fname, AUXILIARY_ACCOUNT_KEYWORDS)
            if matched:
                has_auxiliary_account = True

        # 校验 4：产学研合作匹配
        if not has_collaboration:
            matched = _match_category(fname, COLLABORATION_KEYWORDS)
            if matched:
                has_collaboration = True

        if has_error:
            stats['invalid_docs'] += 1
        else:
            stats['valid_docs'] += 1

    # ============================================================
    # 校验 2：研发制度完整性校验
    # ============================================================
    stats['found_regulations'] = found_regulations
    missing_regulations = [cat for cat in REQUIRED_REGULATIONS if cat not in found_regulations]
    stats['missing_regulations'] = missing_regulations

    for cat in missing_regulations:
        errors.append({
            'file': '', 'row': 0, 'field': 'regulation',
            'reason': f'缺少制度文档: {cat}（关键词: {REQUIRED_REGULATIONS[cat]}）',
        })

    # ============================================================
    # 校验 3：研发辅助账校验
    # ============================================================
    stats['has_auxiliary_account'] = has_auxiliary_account
    if not has_auxiliary_account:
        errors.append({
            'file': '', 'row': 0, 'field': 'auxiliary_account',
            'reason': '未找到研发费用辅助账文件（关键词: 辅助账/研发费用辅助）',
        })

    # ============================================================
    # 校验 4：产学研合作校验
    # ============================================================
    stats['has_collaboration'] = has_collaboration
    if not has_collaboration:
        warnings.append({
            'file': '', 'row': 0, 'field': 'collaboration',
            'reason': '未找到产学研合作协议文件（关键词: 产学研/校企合作），建议补充',
        })

    passed = len(errors) == 0
    return {
        'passed': passed,
        'errors': errors,
        'warnings': warnings,
        'stats': stats,
    }


def validate_single_management_file(file_path, project_root=None):
    """审核单个管理制度文档文件"""
    errors = []
    warnings = []
    stats = {
        'total_docs': 1,
        'valid_docs': 0,
        'invalid_docs': 0,
        'found_regulations': {},
        'missing_regulations': [],
        'has_auxiliary_account': False,
        'has_collaboration': False,
        'by_format': {'docx': 0, 'pdf': 0, 'doc': 0, 'other': 0},
    }

    if not os.path.exists(file_path):
        errors.append({
            'file': file_path, 'row': 0, 'field': 'file',
            'reason': f'文件不存在: {file_path}',
        })
        return {'passed': False, 'errors': errors, 'warnings': warnings, 'stats': stats}

    fname = os.path.basename(file_path)
    ext = os.path.splitext(fname)[1].lower()
    has_error = False

    # 格式校验
    if ext == '.docx':
        stats['by_format']['docx'] = 1
    elif ext == '.pdf':
        stats['by_format']['pdf'] = 1
    elif ext == '.doc':
        stats['by_format']['doc'] = 1
        warnings.append({
            'file': fname, 'row': 0, 'field': 'format',
            'reason': '文档使用 .doc 格式，建议统一转换为 .docx 格式',
        })
    else:
        stats['by_format']['other'] = 1
        errors.append({
            'file': fname, 'row': 0, 'field': 'format',
            'reason': f'不支持的文档格式: {ext}（仅支持 docx/pdf）',
        })
        has_error = True

    # 命名规范校验
    is_valid_name, name_reason = _check_name_convention(fname)
    if not is_valid_name:
        warnings.append({
            'file': fname, 'row': 0, 'field': 'naming',
            'reason': name_reason,
        })

    # 制度类别匹配
    found_regulations = {}
    for category, keywords in REQUIRED_REGULATIONS.items():
        if _match_category(fname, keywords):
            found_regulations[category] = fname
    stats['found_regulations'] = found_regulations
    stats['missing_regulations'] = [cat for cat in REQUIRED_REGULATIONS if cat not in found_regulations]

    # 辅助账匹配
    if _match_category(fname, AUXILIARY_ACCOUNT_KEYWORDS):
        stats['has_auxiliary_account'] = True

    # 产学研匹配
    if _match_category(fname, COLLABORATION_KEYWORDS):
        stats['has_collaboration'] = True

    if has_error:
        stats['invalid_docs'] = 1
    else:
        stats['valid_docs'] = 1

    passed = len(errors) == 0
    return {
        'passed': passed,
        'errors': errors,
        'warnings': warnings,
        'stats': stats,
    }


def main():
    """CLI 入口：解析参数并执行管理制度材料审核"""
    parser = argparse.ArgumentParser(
        description='管理制度材料审核脚本 - 校验高企认定管理制度及证明材料合规性',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''示例：
  python validate_management.py --dir "管理制度及证明材料"
  python validate_management.py --dir "管理制度及证明材料" --project-root "项目根目录"
  python validate_management.py --file "研发管理制度.docx" --project-root "项目根目录"
''',
    )
    parser.add_argument('--dir', help='管理制度材料所在目录')
    parser.add_argument('--file', help='单个管理制度文档文件路径')
    parser.add_argument('--project-root', dest='project_root',
                        help='项目根目录（用于读取 project_index.json 获取项目上下文）')
    args = parser.parse_args()

    if not args.dir and not args.file:
        parser.print_help()
        sys.exit(1)

    if args.dir:
        report = validate_management_directory(args.dir, args.project_root)
    else:
        report = validate_single_management_file(args.file, args.project_root)

    # 输出 JSON 格式审核报告
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    sys.exit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
