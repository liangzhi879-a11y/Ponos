"""知识产权（IP）材料审核脚本

用途：审核高新技术企业认定申报中的知识产权证明材料是否合规，包括：
  1. 目录结构校验：检查 IP 证明材料目录是否存在
  2. 证书完整性校验：每个 IP 是否有对应的证书文件（PDF/图片）
  3. 专利状态校验：授权日期是否有效、是否在有效期内
  4. IP 分类校验：发明专利/实用新型/外观设计/软件著作权分类是否正确
  5. 深圳地区 IP 计分上限校验：IP 数量是否超过 15 项计分上限
  6. IP 与 RD 关联校验：检查 IP 是否有关联的 RD（读取 project_index.json）

用法：
  python validate_ip.py --dir "IP材料目录"
  python validate_ip.py --dir "IP材料目录" --project-root "项目根目录"
  python validate_ip.py --file "单个IP证书文件" --project-root "项目根目录"

输出：JSON 格式审核报告，结构如下：
  {
    "passed": bool,
    "errors": [{"file": "...", "row": 0, "field": "...", "reason": "..."}],
    "warnings": [...],
    "stats": {"total_ip": N, "valid_ip": N, "invalid_ip": N, ...}
  }

退出码：审核通过 0，存在错误 1

依赖：仅使用 Python 标准库（os/re/json/argparse/datetime/pathlib）
"""

import os
import re
import sys
import json
import argparse
from datetime import datetime


# ============================================================
# 常量定义
# ============================================================

# 证书文件支持的扩展名
CERTIFICATE_EXTENSIONS = ('.pdf', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp')

# IP 分类关键词映射（用于从文件名推断 IP 类型）
IP_TYPE_KEYWORDS = {
    '发明专利': ['发明'],
    '实用新型': ['实用新型'],
    '外观设计': ['外观设计', '外观'],
    '软件著作权': ['软件著作权', '软著', '软件', '系统', '上位机', '控制器', '监控器', '管理系统'],
}

# I类知识产权（发明专利）vs II类知识产权（实用新型/外观设计/软件著作权）
IP_CLASS_MAP = {
    '发明专利': 'I',
    '实用新型': 'II',
    '外观设计': 'II',
    '软件著作权': 'II',
}

# 深圳地区 II 类知识产权计分上限
SHENZHEN_IP_SCORE_MAX = 15

# 专利有效期（年）：发明专利 20 年，实用新型 10 年，外观设计 15 年
PATENT_VALIDITY_YEARS = {
    '发明专利': 20,
    '实用新型': 10,
    '外观设计': 15,
    '软件著作权': 50,  # 软著保护期 50 年（一般不会过期）
}

# IP 编号正则（IP01、IP02...）
IP_NUMBER_PATTERN = re.compile(r'IP(\d{1,3})', re.IGNORECASE)


def _load_project_index(project_root):
    """加载 project_index.json，用于 IP 与 RD 关联校验

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


def _extract_ip_number(filename):
    """从文件名提取 IP 编号（如 IP01 → 1）"""
    m = IP_NUMBER_PATTERN.search(filename)
    return int(m.group(1)) if m else None


def _classify_ip_type(filename):
    """根据文件名推断 IP 类型

    返回：IP 类型字符串（发明专利/实用新型/外观设计/软件著作权）或 None
    """
    # 软著关键词优先判定（避免"系统"等词误判）
    if any(kw in filename for kw in IP_TYPE_KEYWORDS['软件著作权']):
        # 但若同时包含"发明"或"实用新型"，则按专利判定
        if any(kw in filename for kw in IP_TYPE_KEYWORDS['发明专利']):
            return '发明专利'
        if any(kw in filename for kw in IP_TYPE_KEYWORDS['实用新型']):
            return '实用新型'
        if any(kw in filename for kw in IP_TYPE_KEYWORDS['外观设计']):
            return '外观设计'
        return '软件著作权'
    for ip_type, keywords in IP_TYPE_KEYWORDS.items():
        if ip_type == '软件著作权':
            continue
        for kw in keywords:
            if kw in filename:
                return ip_type
    return None


def _scan_ip_files(ip_dir):
    """扫描 IP 目录下的证书文件

    返回：[{'file': 文件名, 'path': 完整路径, 'ip_no': IP编号, 'ip_type': IP类型}, ...]
    """
    ip_files = []
    if not os.path.isdir(ip_dir):
        return ip_files
    for entry in sorted(os.listdir(ip_dir)):
        ext = os.path.splitext(entry)[1].lower()
        if ext not in CERTIFICATE_EXTENSIONS:
            continue
        full_path = os.path.join(ip_dir, entry)
        ip_no = _extract_ip_number(entry)
        ip_type = _classify_ip_type(entry)
        ip_files.append({
            'file': entry,
            'path': full_path,
            'ip_no': ip_no,
            'ip_type': ip_type,
        })
    return ip_files


def _parse_date(value):
    """解析日期字符串，支持 YYYY-MM-DD / YYYY/MM/DD / YYYY年MM月DD日 / YYYYMMDD"""
    if value is None or value == '':
        return None
    s = str(value).strip()
    formats = ['%Y-%m-%d', '%Y/%m/%d', '%Y年%m月%d日', '%Y.%m.%d', '%Y%m%d', '%Y-%m', '%Y/%m', '%Y年%m月']
    for fmt in formats:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    # 尝试提取 4 位年份
    m = re.search(r'(19|20)\d{2}', s)
    if m:
        try:
            return datetime(int(m.group(0)), 1, 1)
        except ValueError:
            pass
    return None


def validate_ip_directory(ip_dir, project_root=None, reference_year=None):
    """审核 IP 材料目录

    参数：
      ip_dir: IP 证明材料目录路径
      project_root: 项目根目录（用于读取 project_index.json）
      reference_year: 申报年份（用于计算专利有效期，默认取当前年份）

    返回：审核报告 dict
    """
    errors = []
    warnings = []
    stats = {
        'total_ip': 0,
        'valid_ip': 0,
        'invalid_ip': 0,
        'by_type': {'发明专利': 0, '实用新型': 0, '外观设计': 0, '软件著作权': 0, '未分类': 0},
        'by_class': {'I': 0, 'II': 0},
        'with_rd_relation': 0,
        'without_rd_relation': 0,
    }

    # 参考年份（用于专利有效期判断）
    if reference_year is None:
        reference_year = datetime.now().year
    ref_date = datetime(reference_year, 12, 31)

    # ============================================================
    # 校验 1：目录结构校验
    # ============================================================
    if not os.path.exists(ip_dir):
        errors.append({
            'file': ip_dir, 'row': 0, 'field': 'directory',
            'reason': f'IP 证明材料目录不存在: {ip_dir}',
        })
        return {
            'passed': False,
            'errors': errors,
            'warnings': warnings,
            'stats': stats,
        }

    if not os.path.isdir(ip_dir):
        errors.append({
            'file': ip_dir, 'row': 0, 'field': 'directory',
            'reason': f'IP 证明材料路径不是目录: {ip_dir}',
        })
        return {
            'passed': False,
            'errors': errors,
            'warnings': warnings,
            'stats': stats,
        }

    ip_files = _scan_ip_files(ip_dir)
    stats['total_ip'] = len(ip_files)

    if stats['total_ip'] == 0:
        errors.append({
            'file': '', 'row': 0, 'field': 'certificate',
            'reason': 'IP 证明材料目录下未找到任何证书文件（PDF/图片）',
        })
        return {
            'passed': False,
            'errors': errors,
            'warnings': warnings,
            'stats': stats,
        }

    # ============================================================
    # 加载 project_index.json（用于 IP-RD 关联校验）
    # ============================================================
    project_index = _load_project_index(project_root)
    ip_rd_relations = {}  # ip_no -> [rd_ids]
    if project_index and isinstance(project_index.get('knowledge_graph'), dict):
        edges = project_index['knowledge_graph'].get('edges', []) or []
        for edge in edges:
            if not isinstance(edge, dict):
                continue
            src = str(edge.get('source', ''))
            tgt = str(edge.get('target', ''))
            rel = str(edge.get('relation', ''))
            # 查找 IP->RD 的关联
            if rel in ('related_rd', 'ip_rd', 'supports'):
                for ip_no_str, rd_id in [(src, tgt), (tgt, src)]:
                    m = IP_NUMBER_PATTERN.search(ip_no_str)
                    if m:
                        ip_no = int(m.group(1))
                        ip_rd_relations.setdefault(ip_no, []).append(rd_id)

    # ============================================================
    # 逐个校验 IP 证书文件
    # ============================================================
    seen_ip_nos = set()
    for item in ip_files:
        fname = item['file']
        ip_no = item['ip_no']
        ip_type = item['ip_type']

        has_error = False

        # 校验 2：证书完整性（文件存在性已由扫描保证，这里校验 IP 编号）
        if ip_no is None:
            warnings.append({
                'file': fname, 'row': 0, 'field': 'ip_no',
                'reason': '文件名中未识别到 IP 编号（建议命名格式：IP01_证书名称.pdf）',
            })
        else:
            if ip_no in seen_ip_nos:
                errors.append({
                    'file': fname, 'row': 0, 'field': 'ip_no',
                    'reason': f'IP 编号重复: IP{ip_no:02d}',
                })
                has_error = True
            seen_ip_nos.add(ip_no)

        # 校验 4：IP 分类校验
        if ip_type is None:
            stats['by_type']['未分类'] += 1
            warnings.append({
                'file': fname, 'row': 0, 'field': 'ip_type',
                'reason': '无法从文件名识别 IP 类型（发明专利/实用新型/外观设计/软件著作权）',
            })
        else:
            stats['by_type'][ip_type] = stats['by_type'].get(ip_type, 0) + 1
            ip_class = IP_CLASS_MAP.get(ip_type)
            if ip_class:
                stats['by_class'][ip_class] = stats['by_class'].get(ip_class, 0) + 1

        # 校验 3：专利状态校验（基于文件名无法精确获取授权日期，
        #         这里检查文件名是否包含日期线索，并提示需人工核对）
        # 文件名中查找年份
        year_match = re.search(r'(20\d{2})', fname)
        if year_match:
            auth_year = int(year_match.group(1))
            # 检查授权年份是否合理（不能晚于申报年份，不能早于 1985 年专利法实施）
            if auth_year > reference_year:
                errors.append({
                    'file': fname, 'row': 0, 'field': 'auth_date',
                    'reason': f'授权日期年份 {auth_year} 晚于申报年份 {reference_year}，疑似日期错误',
                })
                has_error = True
            elif auth_year < 1985:
                errors.append({
                    'file': fname, 'row': 0, 'field': 'auth_date',
                    'reason': f'授权日期年份 {auth_year} 早于 1985 年（专利法实施年份），日期无效',
                })
                has_error = True
            else:
                # 专利有效期校验
                if ip_type and ip_type in PATENT_VALIDITY_YEARS:
                    validity = PATENT_VALIDITY_YEARS[ip_type]
                    expire_year = auth_year + validity
                    if expire_year < reference_year:
                        errors.append({
                            'file': fname, 'row': 0, 'field': 'expiry_date',
                            'reason': f'{ip_type}授权年份 {auth_year}，有效期 {validity} 年，已于 {expire_year} 年过期',
                        })
                        has_error = True
        else:
            warnings.append({
                'file': fname, 'row': 0, 'field': 'auth_date',
                'reason': '文件名未包含授权日期年份，需人工核对专利有效期',
            })

        # 校验 6：IP 与 RD 关联校验
        if project_index is not None:
            if ip_no is not None and ip_no in ip_rd_relations:
                stats['with_rd_relation'] += 1
            elif ip_no is not None:
                stats['without_rd_relation'] += 1
                warnings.append({
                    'file': fname, 'row': 0, 'field': 'rd_relation',
                    'reason': f'IP{ip_no:02d} 在 project_index.json 中未找到关联的 RD',
                })

        if has_error:
            stats['invalid_ip'] += 1
        else:
            stats['valid_ip'] += 1

    # ============================================================
    # 校验 5：深圳地区 IP 计分上限校验（II 类 IP ≤ 15 项）
    # ============================================================
    class2_count = stats['by_class'].get('II', 0)
    if class2_count > SHENZHEN_IP_SCORE_MAX:
        errors.append({
            'file': '', 'row': 0, 'field': 'ip_count',
            'reason': f'深圳地区 II 类知识产权计分上限为 {SHENZHEN_IP_SCORE_MAX} 项，当前 {class2_count} 项超出上限（超出部分不计分）',
        })

    # I 类 IP 至少 1 项的硬性要求
    class1_count = stats['by_class'].get('I', 0)
    if class1_count == 0 and class2_count < 5:
        errors.append({
            'file': '', 'row': 0, 'field': 'ip_class',
            'reason': f'无 I 类知识产权，且 II 类仅 {class2_count} 项（不足 5 项），不满足认定基本要求',
        })

    # IP-RD 关联整体校验
    if project_index is not None and stats['without_rd_relation'] > 0:
        warnings.append({
            'file': '', 'row': 0, 'field': 'rd_relation',
            'reason': f'共 {stats["without_rd_relation"]} 项 IP 未关联 RD，建议补充关联关系',
        })

    passed = len(errors) == 0
    return {
        'passed': passed,
        'errors': errors,
        'warnings': warnings,
        'stats': stats,
    }


def validate_single_ip_file(file_path, project_root=None, reference_year=None):
    """审核单个 IP 证书文件"""
    errors = []
    warnings = []
    stats = {
        'total_ip': 1,
        'valid_ip': 0,
        'invalid_ip': 0,
        'by_type': {'发明专利': 0, '实用新型': 0, '外观设计': 0, '软件著作权': 0, '未分类': 0},
        'by_class': {'I': 0, 'II': 0},
    }

    if reference_year is None:
        reference_year = datetime.now().year

    if not os.path.exists(file_path):
        errors.append({
            'file': file_path, 'row': 0, 'field': 'file',
            'reason': f'文件不存在: {file_path}',
        })
        return {'passed': False, 'errors': errors, 'warnings': warnings, 'stats': stats}

    fname = os.path.basename(file_path)
    ext = os.path.splitext(fname)[1].lower()
    if ext not in CERTIFICATE_EXTENSIONS:
        errors.append({
            'file': fname, 'row': 0, 'field': 'extension',
            'reason': f'不支持的证书文件格式: {ext}（支持 PDF/图片）',
        })

    ip_no = _extract_ip_number(fname)
    ip_type = _classify_ip_type(fname)

    if ip_no is None:
        warnings.append({
            'file': fname, 'row': 0, 'field': 'ip_no',
            'reason': '文件名中未识别到 IP 编号',
        })

    if ip_type is None:
        stats['by_type']['未分类'] = 1
        warnings.append({
            'file': fname, 'row': 0, 'field': 'ip_type',
            'reason': '无法识别 IP 类型',
        })
    else:
        stats['by_type'][ip_type] = 1
        stats['by_class'][IP_CLASS_MAP.get(ip_type, 'II')] = 1

    has_error = len(errors) > 0
    stats['valid_ip' if not has_error else 'invalid_ip'] = 1
    return {
        'passed': not has_error,
        'errors': errors,
        'warnings': warnings,
        'stats': stats,
    }


def main():
    """CLI 入口：解析参数并执行 IP 材料审核"""
    parser = argparse.ArgumentParser(
        description='知识产权（IP）材料审核脚本 - 校验高企认定 IP 证明材料合规性',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''示例：
  python validate_ip.py --dir "知识产权证书扫描件"
  python validate_ip.py --dir "知识产权证书扫描件" --project-root "项目根目录"
  python validate_ip.py --file "IP01_某专利证书.pdf" --project-root "项目根目录"
''',
    )
    parser.add_argument('--dir', help='IP 证明材料所在目录')
    parser.add_argument('--file', help='单个 IP 证书文件路径')
    parser.add_argument('--project-root', dest='project_root',
                        help='项目根目录（用于读取 project_index.json 进行 IP-RD 关联校验）')
    parser.add_argument('--year', type=int, default=None,
                        help='申报年份（默认取当前年份，用于专利有效期计算）')
    args = parser.parse_args()

    if not args.dir and not args.file:
        parser.print_help()
        sys.exit(1)

    if args.dir:
        report = validate_ip_directory(args.dir, args.project_root, args.year)
    else:
        report = validate_single_ip_file(args.file, args.project_root, args.year)

    # 输出 JSON 格式审核报告
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    sys.exit(0 if report['passed'] else 1)


if __name__ == '__main__':
    main()
