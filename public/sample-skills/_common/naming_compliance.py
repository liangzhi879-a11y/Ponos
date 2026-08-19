#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
naming_compliance.py - 高新认定申报材料命名合规脚本

用法：
  python naming_compliance.py organize --source "源目录" --target "目标目录" --requirement "资料要求.xlsx路径"

功能：
  读取资料要求.xlsx的19项材料清单，扫描源目录文件，
  按命名规范重命名并复制到目标目录，生成命名对照表。
"""

import argparse
import os
import re
import shutil
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# ============================================================
# 19项命名规则
# ============================================================
NAMING_RULES = {
    1:  {"name": "知识产权证明材料(IP、NIP)*", "format": "IP{编号}_{名称}.pdf", "max_size_mb": 2},
    2:  {"name": "企业研究开发活动(RD)*", "format": "RD{编号}_{研发活动名称}.pdf", "max_size_mb": 2},
    3:  {"name": "高新产品(服务)证明材料(PS)*", "format": "PS{编号}_{产品名称}.pdf", "max_size_mb": 4},
    4:  {"name": "科技成果转化情况证明材料*", "format": "{序号}_{成果名称}.pdf", "max_size_mb": 2},
    5:  {"name": "国家或行业标准制定情况证明材料", "format": "{序号}_{标准名称}.pdf", "max_size_mb": 2},
    6:  {"name": "营业执照*", "format": "营业执照.pdf", "max_size_mb": 0.5, "allowed_exts": [".jpg", ".jpeg", ".png"]},
    7:  {"name": "申报书封皮*", "format": "申报书封皮.pdf", "max_size_mb": 1},
    8:  {"name": "近三年财务审计报告*", "format": "{年份}_财务审计报告.pdf", "max_size_mb": 100},
    9:  {"name": "近三年企业所得税纳税申报表*", "format": "{年份}_企业所得税纳税申报表.pdf", "max_size_mb": 5},
    10: {"name": "近三年研发费用专项审计报告*", "format": "研发费用专项审计报告.pdf", "max_size_mb": 100},
    11: {"name": "高新产品收入专项审计报告*", "format": "高新产品收入专项审计报告.pdf", "max_size_mb": 100},
    12: {"name": "研发组织管理制度*", "format": "研发组织管理制度及辅助账.pdf", "max_size_mb": 20},
    13: {"name": "研发机构及产学研合作*", "format": "研发机构设立及产学研合作证明材料.pdf", "max_size_mb": 20},
    14: {"name": "科技成果转化激励制度*", "format": "科技成果转化激励制度及双创平台.pdf", "max_size_mb": 5},
    15: {"name": "科技人员培养奖励制度*", "format": "科技人员培养引进及绩效奖励制度.pdf", "max_size_mb": 5},
    16: {"name": "人力资源情况*", "format": "人力资源情况证明材料.pdf", "max_size_mb": 8},
    17: {"name": "销售合同与发票*", "format": "上年度代表性销售合同与发票.pdf", "max_size_mb": 20},
    18: {"name": "企业承诺书*", "format": "企业承诺书.pdf", "max_size_mb": 1},
    19: {"name": "申请书签字盖章扫描件*", "format": "打印申请书签字盖章扫描件.pdf", "max_size_mb": 1},
}

# 目录名 → 项目编号映射（用于根据源目录匹配项目）
DIR_TO_ITEM_MAP = {
    "1": 1, "ip": 1, "知识产权": 1, "ip证明材料": 1,
    "2": 2, "rd": 2, "研发": 2, "研发活动": 2, "立项": 2,
    "3": 3, "ps": 3, "高新产品": 3, "高新技术产品": 3,
    "4": 4, "成果转化": 4, "科技成果转化": 4,
    "5": 5, "标准": 5, "国标": 5, "行标": 5,
    "6": 6, "营业执照": 6,
    "7": 7, "封皮": 7, "申报书封皮": 7,
    "8": 8, "审计": 8, "财务审计": 8, "财审": 8,
    "9": 9, "纳税": 9, "所得税": 9, "申报表": 9,
    "10": 10, "研发费用": 10, "专项审计": 10, "研发费": 10,
    "11": 11, "高新产品收入": 11, "收入专项": 11,
    "12": 12, "管理制度": 12, "研发制度": 12, "组织管理": 12,
    "13": 13, "产学研": 13, "研发机构": 13,
    "14": 14, "激励": 14, "双创": 14,
    "15": 15, "人员培养": 15, "绩效": 15, "奖励": 15,
    "16": 16, "人力资源": 16, "人员": 16, "社保": 16, "学历": 16,
    "17": 17, "合同": 17, "发票": 17, "销售": 17,
    "18": 18, "承诺书": 18,
    "19": 19, "申请书": 19, "签字盖章": 19, "扫描件": 19,
}


def sanitize_filename(name):
    r"""移除Windows文件名非法字符 \/:*?"<>|，替换为下划线"""
    illegal_chars = r'[\\/:*?"<>|]'
    cleaned = re.sub(illegal_chars, '_', name)
    cleaned = cleaned.strip()
    if cleaned.endswith('.'):
        cleaned = cleaned[:-1] + '_'
    cleaned = re.sub(r'[\x00-\x1f]', '', cleaned)
    cleaned = re.sub(r'_+', '_', cleaned)
    cleaned = cleaned.strip('_')
    if not cleaned:
        cleaned = "unnamed"
    return cleaned


def try_import_openpyxl():
    try:
        import openpyxl
        return openpyxl
    except ImportError:
        print("[警告] openpyxl 未安装，将使用内置默认规则。安装命令: pip install openpyxl")
        return None


def try_read_pdf_text(filepath):
    """尝试读取PDF文本内容，用于提取IP/RD/PS名称和年份"""
    text = ""
    try:
        import pdfplumber
        with pdfplumber.open(filepath) as pdf:
            for page in pdf.pages[:3]:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n"
    except ImportError:
        pass
    except Exception:
        pass

    if not text:
        try:
            import fitz
            doc = fitz.open(filepath)
            for i in range(min(3, len(doc))):
                text += doc[i].get_text() + "\n"
            doc.close()
        except ImportError:
            pass
        except Exception:
            pass

    return text.strip()


def try_read_docx_text(filepath):
    """尝试读取DOCX文本内容"""
    try:
        import docx
        doc = docx.Document(filepath)
        text = "\n".join(p.text for p in doc.paragraphs)
        return text.strip()
    except ImportError:
        return ""
    except Exception:
        return ""


def try_read_xlsx_text(filepath):
    """尝试读取XLSX内容（前几行）"""
    openpyxl = try_import_openpyxl()
    if not openpyxl:
        return ""
    try:
        wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
        ws = wb.active
        rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= 20:
                break
            row_text = " ".join(str(c) for c in row if c is not None)
            if row_text.strip():
                rows.append(row_text)
        wb.close()
        return "\n".join(rows)
    except Exception:
        return ""


def read_file_content(filepath):
    """读取文件文本内容（支持PDF/DOCX/XLSX）"""
    ext = Path(filepath).suffix.lower()
    if ext == '.pdf':
        return try_read_pdf_text(filepath)
    elif ext in ('.docx', '.doc'):
        return try_read_docx_text(filepath)
    elif ext in ('.xlsx', '.xls'):
        return try_read_xlsx_text(filepath)
    elif ext in ('.txt', '.md'):
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                return f.read()
        except Exception:
            return ""
    return ""


def extract_ip_name(content, filename):
    """从内容或文件名中提取知识产权名称"""
    sources = [filename]
    if content:
        sources.insert(0, content)

    for src in sources:
        m = re.search(r'专利[名称][：:]\s*[“"「]?(.+?)[”"」]?(?:\s|$)', src)
        if m:
            return m.group(1).strip()

    for src in sources:
        m = re.search(r'发明[名称][：:]\s*(.+?)(?:\s|$)', src)
        if m:
            return m.group(1).strip()

    for src in sources:
        m = re.search(
            r'(?:实用新型名称|外观设计名称|发明名称|实用新型|外观设计|发明)\s*[：:]\s*(.+?)(?:\s|$)',
            src
        )
        if m:
            return m.group(1).strip()

    for src in sources:
        m = re.search(r'一种[^\s,，。；;]{2,40}', src)
        if m:
            return m.group(0).strip()

    stem = Path(filename).stem
    stem = re.sub(r'^[_\s\d\-.]+', '', stem)
    stem = re.sub(r'证书|扫描|盖章|登记簿|副本', '', stem)
    if len(stem) >= 3:
        return stem.strip()

    return None


def extract_rd_name(content, filename):
    """从内容或文件名中提取研发活动名称"""
    sources = [filename]
    if content:
        sources.insert(0, content)

    for src in sources:
        m = re.search(r'项目名称[：:]\s*(.+?)(?:\s|$)', src)
        if m:
            return m.group(1).strip()

    for src in sources:
        m = re.search(r'研发项目[：:]\s*(.+?)(?:\s|$)', src)
        if m:
            return m.group(1).strip()

    for src in sources:
        m = re.search(r'(?:RD\d{0,2}|立项)[：:]\s*(.+?)(?:\s|$)', src)
        if m:
            return m.group(1).strip()

    stem = Path(filename).stem
    stem = re.sub(r'^[_\s\d\-.]+', '', stem)
    stem = re.sub(r'报告|立项|任务书|验收|扫描|盖章', '', stem)
    if len(stem) >= 3:
        return stem.strip()

    return None


def extract_ps_name(content, filename):
    """从内容或文件名中提取高新产品名称"""
    sources = [filename]
    if content:
        sources.insert(0, content)

    for src in sources:
        m = re.search(r'产品名称[：:]\s*(.+?)(?:\s|$)', src)
        if m:
            return m.group(1).strip()

    stem = Path(filename).stem
    stem = re.sub(r'^[_\s\d\-.]+', '', stem)
    stem = re.sub(r'技术说明|证明材料|扫描|盖章|PS\d*', '', stem)
    if len(stem) >= 3:
        return stem.strip()

    return None


def extract_year(content, filename):
    """从内容或文件名中提取年份"""
    year_pattern = re.compile(r'(?:20\d{2})\s*年')
    sources = [filename]
    if content:
        sources.insert(0, content)

    for src in sources:
        years = year_pattern.findall(src)
        if years:
            return re.search(r'20\d{2}', years[0]).group(0)

    for src in sources:
        m = re.search(r'20\d{2}', src)
        if m:
            return m.group(0)

    return None


def extract_achievement_name(content, filename):
    """从内容或文件名中提取成果名称"""
    for src in [content, filename]:
        if not src:
            continue
        m = re.search(r'成果[名称][：:]\s*(.+?)(?:\s|$)', src)
        if m:
            return m.group(1).strip()
        m = re.search(r'转化[：:]\s*(.+?)(?:\s|$)', src)
        if m:
            return m.group(1).strip()

    stem = Path(filename).stem
    stem = re.sub(r'^[_\s\d\-.]+', '', stem)
    stem = re.sub(r'证明|材料|扫描|盖章', '', stem)
    if len(stem) >= 3:
        return stem.strip()

    return None


def extract_standard_name(content, filename):
    """从内容或文件名中提取标准名称"""
    for src in [content, filename]:
        if not src:
            continue
        m = re.search(r'标准[名称][：:]\s*(.+?)(?:\s|$)', src)
        if m:
            return m.group(1).strip()

    stem = Path(filename).stem
    stem = re.sub(r'^[_\s\d\-.]+', '', stem)
    stem = re.sub(r'标准|文件|扫描|盖章', '', stem)
    if len(stem) >= 3:
        return stem.strip()

    return None


def match_file_to_item(filepath):
    """根据文件所在目录名和文件名内容匹配到对应的材料项"""
    abspath = Path(filepath).resolve()
    filename = abspath.name.lower()
    dirname = abspath.parent.name.lower()

    scored = []

    for key_str, item_id in DIR_TO_ITEM_MAP.items():
        score = 0
        if key_str in dirname:
            score += 10
        if key_str in filename:
            score += 5
        if score > 0:
            scored.append((score, item_id))

    if not scored:
        if any(kw in dirname for kw in ['过期', '历史', '备份', '其他']):
            return None
        return 19

    scored.sort(key=lambda x: x[0], reverse=True)

    best_score = scored[0][0]
    best_items = [item_id for score, item_id in scored if score == best_score]

    if len(best_items) == 1:
        return best_items[0]

    for item_id in [1, 2, 3, 4]:
        if item_id in best_items:
            return item_id

    return best_items[0]


def item_has_multiple_files(item_id):
    """判断某个材料项是否允许/期望多个文件"""
    return item_id in (1, 2, 3, 4, 5, 8, 9)


def scan_source_directory(source_dir):
    """递归扫描源目录，返回文件列表及其分类结果"""
    source_path = Path(source_dir)
    if not source_path.exists():
        print(f"[错误] 源目录不存在: {source_dir}")
        return []

    files_by_item = defaultdict(list)
    all_files = []

    for root, dirs, filenames in os.walk(source_dir):
        for fn in filenames:
            if fn.startswith(('~$', '.')):
                continue
            if fn.lower().endswith(('.tmp', '.bak', '.swp', '.lnk')):
                continue
            filepath = os.path.join(root, fn)
            all_files.append(filepath)

    for filepath in all_files:
        item_id = match_file_to_item(filepath)
        if item_id is not None:
            files_by_item[item_id].append(filepath)

    return files_by_item


def generate_target_name(item_id, filepath, content, counter, item_counters):
    """根据命名规则生成目标文件名"""
    ext = Path(filepath).suffix.lower()
    rule = NAMING_RULES.get(item_id, {})

    # 营业执照特殊处理：允许图片格式
    if item_id == 6:
        allowed = rule.get("allowed_exts", [".jpg", ".jpeg", ".png"])
        if ext in allowed:
            return "营业执照" + ext

    target_ext = ".pdf"

    if item_id == 1:
        ip_name = extract_ip_name(content, Path(filepath).name)
        if ip_name:
            ip_name = sanitize_filename(ip_name)
        else:
            ip_name = "知识产权"
        num = item_counters[item_id]
        item_counters[item_id] += 1
        return f"IP{num:02d}_{ip_name}{target_ext}"

    elif item_id == 2:
        rd_name = extract_rd_name(content, Path(filepath).name)
        if rd_name:
            rd_name = sanitize_filename(rd_name)
        else:
            rd_name = "研发活动"
        num = item_counters[item_id]
        item_counters[item_id] += 1
        return f"RD{num:02d}_{rd_name}{target_ext}"

    elif item_id == 3:
        ps_name = extract_ps_name(content, Path(filepath).name)
        if ps_name:
            ps_name = sanitize_filename(ps_name)
        else:
            ps_name = "高新产品"
        num = item_counters[item_id]
        item_counters[item_id] += 1
        return f"PS{num:02d}_{ps_name}{target_ext}"

    elif item_id == 4:
        ach_name = extract_achievement_name(content, Path(filepath).name)
        if ach_name:
            ach_name = sanitize_filename(ach_name)
        else:
            ach_name = "成果转化"
        num = item_counters[item_id]
        item_counters[item_id] += 1
        return f"{num:02d}_{ach_name}{target_ext}"

    elif item_id == 5:
        std_name = extract_standard_name(content, Path(filepath).name)
        if std_name:
            std_name = sanitize_filename(std_name)
        else:
            std_name = "标准"
        num = item_counters[item_id]
        item_counters[item_id] += 1
        return f"{num:02d}_{std_name}{target_ext}"

    elif item_id in (8, 9):
        year = extract_year(content, Path(filepath).name)
        if not year:
            year = "未知年份"
        base = rule["format"].replace("{年份}", year)
        base = sanitize_filename(base.replace(".pdf", ""))
        return f"{base}{target_ext}"

    else:
        base = rule.get("format", "").replace(".pdf", "")
        base = sanitize_filename(base)
        if not base:
            base = f"材料{item_id:02d}"
        return f"{base}{target_ext}"


def check_size_limit(filepath, item_id):
    """检查文件大小是否超限"""
    rule = NAMING_RULES.get(item_id, {})
    max_mb = rule.get("max_size_mb", 100)
    size_mb = os.path.getsize(filepath) / (1024 * 1024)
    if size_mb > max_mb:
        return size_mb, max_mb, True
    return size_mb, max_mb, False


def organize(args):
    """主执行逻辑：扫描、匹配、重命名、复制"""
    source_dir = args.source
    target_dir = args.target
    requirement_path = args.requirement

    print(f"=== 命名合规脚本 ===")
    print(f"源目录: {source_dir}")
    print(f"目标目录: {target_dir}")
    print(f"资料要求: {requirement_path}")

    # 验证资料要求文件
    if not os.path.isfile(requirement_path):
        print(f"[警告] 资料要求文件不存在: {requirement_path}，使用内置规则")

    # 创建目标目录
    os.makedirs(target_dir, exist_ok=True)

    # 扫描源目录
    print("\n[1/5] 扫描源目录文件...")
    files_by_item = scan_source_directory(source_dir)

    total_files = sum(len(files) for files in files_by_item.values())
    print(f"  发现 {total_files} 个文件，分布在 {len(files_by_item)} 个材料项中")

    # 生成目标文件名
    print("\n[2/5] 生成规范文件名...")
    item_counters = {item_id: 1 for item_id in NAMING_RULES}
    target_names_used = defaultdict(int)
    rename_map = []
    size_warnings = []

    for item_id in sorted(NAMING_RULES.keys()):
        if item_id not in files_by_item:
            continue

        rule = NAMING_RULES[item_id]
        files = files_by_item[item_id]

        for filepath in files:
            content = read_file_content(filepath)
            target_name = generate_target_name(item_id, filepath, content, 0, item_counters)

            # 处理重名
            base, ext = os.path.splitext(target_name)
            if target_name in target_names_used:
                dup_count = target_names_used[target_name]
                target_name = f"{base}_dup{dup_count}{ext}"
                target_names_used[target_name] += 1
            else:
                target_names_used[target_name] = 1

            # 检查大小
            size_mb, max_mb, over = check_size_limit(filepath, item_id)
            if over:
                size_warnings.append(
                    f"⚠ {target_name}: {size_mb:.1f}MB > {max_mb}MB 上限"
                )

            original_name = os.path.basename(filepath)
            rename_map.append({
                "item_id": item_id,
                "item_name": rule["name"],
                "original": original_name,
                "new_name": target_name,
                "size_mb": size_mb,
                "max_mb": max_mb,
                "over_limit": over,
            })

    # 复制文件
    print("\n[3/5] 复制文件到目标目录...")
    copied = 0
    for entry in rename_map:
        item_id = entry["item_id"]
        new_name = entry["new_name"]
        original = entry.get("original", "")

        # 查找原始文件完整路径
        orig_full_path = None
        for fp in files_by_item.get(item_id, []):
            if os.path.basename(fp) == original:
                orig_full_path = fp
                break

        if not orig_full_path or not os.path.isfile(orig_full_path):
            print(f"  [跳过] 找不到原始文件: {original}")
            continue

        dest_path = os.path.join(target_dir, new_name)
        try:
            shutil.copy2(orig_full_path, dest_path)
            copied += 1
        except Exception as e:
            print(f"  [复制失败] {original} -> {new_name}: {e}")

    print(f"  成功复制 {copied}/{len(rename_map)} 个文件")

    # 生成命名对照表
    print("\n[4/5] 生成命名对照表...")
    mapping_md_path = os.path.join(target_dir, "_命名对照表.md")
    generate_mapping_report(mapping_md_path, rename_map, size_warnings)

    # 输出大小警告
    print("\n[5/5] 文件大小校验...")
    if size_warnings:
        print(f"  发现 {len(size_warnings)} 个超限文件:")
        for w in size_warnings:
            print(f"    {w}")
    else:
        print("  ✓ 所有文件大小均在限制范围内")

    print(f"\n=== 完成 ===")
    print(f"输出目录: {target_dir}")
    print(f"命名对照表: {mapping_md_path}")

    return rename_map


def generate_mapping_report(report_path, rename_map, size_warnings):
    """生成 _命名对照表.md"""
    lines = []
    lines.append("# 命名对照表")
    lines.append("")
    lines.append(f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")

    # 按材料项分组
    by_item = defaultdict(list)
    for entry in rename_map:
        by_item[entry["item_id"]].append(entry)

    for item_id in sorted(by_item.keys()):
        entries = by_item[item_id]
        rule = NAMING_RULES.get(item_id, {})
        item_name = rule.get("name", f"材料项{item_id}")
        max_mb = rule.get("max_size_mb", "无限制")

        lines.append(f"## 材料{item_id}：{item_name}")
        lines.append("")
        lines.append(f"| 序号 | 原始文件名 | 规范文件名 | 大小(MB) | 上限(MB) | 状态 |")
        lines.append(f"|------|-----------|-----------|---------|---------|------|")

        for i, entry in enumerate(entries, 1):
            status = "⚠超限" if entry.get("over_limit") else "✓"
            lines.append(
                f"| {i} | {entry['original']} | {entry['new_name']} "
                f"| {entry['size_mb']:.1f} | {entry['max_mb']} | {status} |"
            )
        lines.append("")

    if size_warnings:
        lines.append("## ⚠ 文件大小警告")
        lines.append("")
        for w in size_warnings:
            lines.append(f"- {w}")
        lines.append("")

    lines.append("---")
    lines.append(f"*共 {len(rename_map)} 个文件*")
    lines.append("")

    with open(report_path, 'w', encoding='utf-8') as f:
        f.write("\n".join(lines))


def main():
    parser = argparse.ArgumentParser(
        description="高新认定申报材料命名合规脚本"
    )
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    # organize 子命令
    organize_parser = subparsers.add_parser(
        "organize",
        help="按19项材料命名规范整理文件"
    )
    organize_parser.add_argument(
        "--source", required=True,
        help="源目录（已按19类分类的原始资料目录）"
    )
    organize_parser.add_argument(
        "--target", required=True,
        help="目标目录（规范命名后的输出目录）"
    )
    organize_parser.add_argument(
        "--requirement", required=True,
        help="资料要求.xlsx 文件路径"
    )

    args = parser.parse_args()

    if args.command == "organize":
        organize(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
