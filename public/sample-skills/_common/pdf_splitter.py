#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
PDF拆分与合并资料整理工具（模块六）

用途：
    自动检测合并PDF（多文档合订），拆分前备份原件，支持按书签/按内容类型/按页三种拆分方式，
    并提取文本/表格/图片和对扫描页执行OCR识别。

核心原则：
    1. 所有PDF资料在进入分析流程前，必须先调用 detect_and_process_merged_pdf() 检测是否为合并PDF
    2. 拆分前必须备份原件到 _backup/pdf_original/ 目录，保留原始文件不变
    3. 拆分优先级：按书签 > 按内容类型 > 按页（智能选择最合适的拆分方式）
    4. 扫描页（无文本层）自动触发OCR识别

CLI 用法：
    # 拆分PDF（支持 page|bookmark|content 三种模式）
    python pdf_splitter.py split --input "PDF路径" --output "输出目录" --mode page|bookmark|content

    # 合并多个PDF
    python pdf_splitter.py merge --inputs "文件1,文件2" --output "合并后PDF路径"

    # 提取PDF内容（文本/表格/图片）
    python pdf_splitter.py extract --input "PDF路径" --output "输出目录"

    # 检测是否为合并PDF
    python pdf_splitter.py detect --input "PDF路径"
"""

import os
import re
import shutil
import json
import argparse
import numpy as np
from datetime import datetime

# PDF处理依赖
try:
    from PyPDF2 import PdfReader, PdfWriter
    import pdfplumber
    _PYPDF2_AVAILABLE = True
except ImportError:
    _PYPDF2_AVAILABLE = False

# OCR依赖（可选，按需启用）
try:
    import pytesseract
    from PIL import Image
    import pdf2image
    _OCR_AVAILABLE = True
except ImportError:
    _OCR_AVAILABLE = False


# ============================================================
# 配置
# ============================================================

# 合并PDF检测阈值
MERGED_PDF_PAGE_THRESHOLD = 15        # 超过15页疑似合并PDF
MERGED_PDF_BOOKMARK_THRESHOLD = 2     # 顶级书签≥2个判定为合并

# 内容类型识别关键词（按优先级）
CONTENT_TYPE_PATTERNS = [
    # (类型标识, 中文关键词列表, 英文/数字关键词列表)
    ('certificate', ['证书', '专利号', '授权', '授予', '登记'], ['CERTIFICATE', 'PATENT NO', 'ZL']),
    ('software_copyright', ['计算机软件著作权', '软著登记'], ['SOFTWARE COPYRIGHT']),
    ('notice', ['通知书', '受理通知书', '审查意见'], ['NOTICE', 'OFFICE ACTION']),
    ('specification', ['说明书', '权利要求书', '摘要'], ['SPECIFICATION', 'CLAIMS']),
    ('invoice', ['发票', '增值税', '专用发票', '年费缴费'], ['INVOICE', 'FAPIAO']),
    ('contract', ['合同', '协议', '转让合同', '许可协议'], ['CONTRACT', 'AGREEMENT']),
    ('report', ['报告', '审计报告', '检测报告', '验收报告'], ['REPORT']),
    ('social_security', ['社保', '社会保险', '缴费证明'], ['SOCIAL SECURITY']),
    ('id_card', ['身份证', '居民身份证'], ['ID CARD']),
    ('degree', ['毕业证', '学位证', '学历证书'], ['DIPLOMA', 'DEGREE']),
    ('seal', ['公章', '印章'], ['SEAL']),
    ('rd_report', ['立项报告', '研发项目', '可行性研究'], ['PROJECT REPORT']),
    ('ps_description', ['技术说明', '产品说明', '关键技术'], ['PRODUCT SPEC']),
    ('achievement', ['成果转化', '科技成果', '转化证明'], ['ACHIEVEMENT']),
    ('management', ['管理制度', '研发制度', '激励制度'], ['MANAGEMENT']),
]

# 文件命名前缀映射（用于拆分后命名）
CONTENT_TYPE_PREFIX = {
    'certificate': '证书',
    'software_copyright': '软著证书',
    'notice': '通知书',
    'specification': '说明书',
    'invoice': '发票',
    'contract': '合同',
    'report': '报告',
    'social_security': '社保',
    'id_card': '身份证',
    'degree': '学历证书',
    'seal': '公章材料',
    'rd_report': 'RD立项书',
    'ps_description': 'PS技术说明',
    'achievement': '成果转化',
    'management': '管理制度',
    'unknown': '其他',
}


# ============================================================
# 1. 备份原件
# ============================================================

def backup_pdf_before_split(pdf_path, backup_dir=None):
    """拆分前备份原件，保留原始文件不变

    Args:
        pdf_path: 原始PDF路径
        backup_dir: 备份目录，默认为 {企业材料目录}/_backup/pdf_original/

    Returns:
        str: 备份文件路径，失败返回None
    """
    if not os.path.exists(pdf_path):
        return None

    if backup_dir is None:
        # 默认备份到 {pdf所在目录}/_backup/pdf_original/
        parent = os.path.dirname(pdf_path)
        backup_dir = os.path.join(parent, '_backup', 'pdf_original')

    os.makedirs(backup_dir, exist_ok=True)

    base_name = os.path.basename(pdf_path)
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_name = f"{timestamp}_{base_name}"
    backup_path = os.path.join(backup_dir, backup_name)

    try:
        shutil.copy2(pdf_path, backup_path)
        return backup_path
    except Exception:
        return None


# ============================================================
# 2. 合并PDF检测
# ============================================================

def detect_merged_pdf(pdf_path):
    """检测PDF是否为合并PDF（多文档合订）

    判定规则（满足任一即判定为合并PDF）：
    1. 顶级书签≥2个
    2. 内容类型在不同页码段明显不同（≥2个内容段）
    3. 页面尺寸/方向变化频繁
    4. 页数超过阈值且无书签

    Returns:
        dict: {
            'is_merged': bool,
            'reason': str,
            'page_count': int,
            'bookmarks': list,
            'page_sizes': list,
            'content_types': list,
            'suggested_split_method': str,  # 'bookmark' | 'content_type' | 'page'
            'split_points': list,
        }
    """
    result = {
        'is_merged': False,
        'reason': '',
        'page_count': 0,
        'bookmarks': [],
        'page_sizes': [],
        'content_types': [],
        'suggested_split_method': 'page',
        'split_points': [],
    }

    if not _PYPDF2_AVAILABLE:
        result['reason'] = 'PyPDF2未安装'
        return result

    try:
        reader = PdfReader(pdf_path)
    except Exception:
        result['reason'] = 'PDF读取失败'
        return result

    page_count = len(reader.pages)
    result['page_count'] = page_count

    # ---- 规则1：书签检测 ----
    try:
        outlines = reader.outline
        top_bookmarks = _extract_top_level_bookmarks(outlines, reader)
        result['bookmarks'] = top_bookmarks
        if len(top_bookmarks) >= MERGED_PDF_BOOKMARK_THRESHOLD:
            result['is_merged'] = True
            result['reason'] = f'检测到{len(top_bookmarks)}个顶级书签'
            result['suggested_split_method'] = 'bookmark'
            result['split_points'] = [bm['page'] for bm in top_bookmarks]
            return result
    except Exception:
        pass

    # ---- 规则2：页面尺寸/方向 ----
    page_sizes = []
    for page in reader.pages:
        try:
            box = page.mediabox
            w, h = float(box.width), float(box.height)
            page_sizes.append((round(w, 1), round(h, 1)))
        except Exception:
            page_sizes.append((0, 0))
    result['page_sizes'] = page_sizes

    # ---- 规则3：内容类型检测 ----
    content_types = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text = _get_page_text_safe(pdf_path, page)
                content_types.append(_classify_page_content(text))
    except Exception:
        content_types = ['unknown'] * page_count
    result['content_types'] = content_types

    # 检测内容类型变化（连续相同类型视为一段，段数≥2为合并PDF）
    segments = _group_content_segments(content_types)
    if len(segments) >= 2:
        result['is_merged'] = True
        result['reason'] = f'检测到{len(segments)}个内容段（类型变化）'
        result['suggested_split_method'] = 'content_type'
        result['split_points'] = [seg['start_page'] for seg in segments[1:]]
        return result

    # ---- 规则4：页面尺寸变化频繁 ----
    unique_sizes = set(page_sizes)
    if len(unique_sizes) >= 3 and page_count >= 5:
        result['is_merged'] = True
        result['reason'] = f'检测到{len(unique_sizes)}种页面尺寸'
        result['suggested_split_method'] = 'content_type'
        return result

    # ---- 规则5：页数阈值 ----
    if page_count >= MERGED_PDF_PAGE_THRESHOLD:
        result['is_merged'] = True
        result['reason'] = f'页数过多({page_count}页)'
        result['suggested_split_method'] = 'page'
        return result

    result['reason'] = '未检测到合并特征'
    return result


def _extract_top_level_bookmarks(outlines, reader):
    """提取顶级书签（不递归子级）"""
    bookmarks = []
    if not outlines:
        return bookmarks
    for item in outlines:
        if isinstance(item, list):
            continue  # 子级书签，跳过
        try:
            page_num = reader.get_destination_page_number(item)
            title = str(item.title) if hasattr(item, 'title') else str(item)
            bookmarks.append({'title': title, 'page': page_num})
        except Exception:
            continue
    return bookmarks


def _classify_page_content(text):
    """根据页面文本分类内容类型"""
    if not text or not text.strip():
        return 'unknown'
    text_upper = text.upper()
    for ctype, cn_keywords, en_keywords in CONTENT_TYPE_PATTERNS:
        for kw in cn_keywords:
            if kw in text:
                return ctype
        for kw in en_keywords:
            if kw in text_upper:
                return ctype
    return 'unknown'


def _ocr_page_text(pdf_path, page_num):
    """对单页PDF执行OCR识别（无文本层的扫描件页面回退方案）

    使用 pypdfium2 渲染页面 → RapidOCR 识别。
    不使用 fitz/PyMuPDF，避免在复杂注释页面上卡死。
    """
    # RapidOCR 引擎（延迟加载，按需初始化）
    _rapid_ocr = None

    def _get_ocr():
        nonlocal _rapid_ocr
        if _rapid_ocr is None:
            try:
                from rapidocr_onnxruntime import RapidOCR as _RapidOCR
                _rapid_ocr = _RapidOCR()
            except ImportError:
                try:
                    from rapidocr_openvino import RapidOCR as _RapidOCR
                    _rapid_ocr = _RapidOCR()
                except ImportError:
                    _rapid_ocr = False
        return _rapid_ocr if _rapid_ocr is not False else None

    # 渲染引擎
    try:
        import pypdfium2 as pdfium
        _USE_PYPDFIUM = True
    except ImportError:
        _USE_PYPDFIUM = False

    if not _USE_PYPDFIUM and not _OCR_AVAILABLE:
        return ''

    # pypdfium2 主路径
    if _USE_PYPDFIUM:
        try:
            pdf = pdfium.PdfDocument(pdf_path)
            if page_num >= len(pdf):
                return ''
            page = pdf[page_num]
            bitmap = page.render(scale=2)
            pil_image = bitmap.to_pil()
            ocr_engine = _get_ocr()
            if ocr_engine is None:
                return ''
            ocr_result, _ = ocr_engine(np.array(pil_image))
            if ocr_result:
                lines = [str(item[1]) for item in ocr_result if len(item) >= 3]
                return '\n'.join(lines)
        except Exception:
            pass
        return ''

    # pdf2image 回退路径
    try:
        with open(pdf_path, 'rb') as f:
            images = pdf2image.convert_from_bytes(
                f.read(), first_page=page_num + 1, last_page=page_num + 1, dpi=150
            )
        if not images:
            return ''
        ocr_engine = _get_ocr()
        if ocr_engine is None:
            return ''
        ocr_result, _ = ocr_engine(np.array(images[0]))
        if ocr_result:
            lines = [str(item[1]) for item in ocr_result if len(item) >= 3]
            return '\n'.join(lines)
    except Exception:
        pass
    return ''


def _get_page_text_safe(pdf_path, page):
    """安全提取页面文本：pdfplumber优先 → OCR回退（扫描件）"""
    text = page.extract_text() or ''
    if text.strip():
        return text
    # 无文本层 → 尝试OCR
    try:
        page_num = page.page_number - 1  # pdfplumber 页码从1开始
    except Exception:
        return text
    ocr_text = _ocr_page_text(pdf_path, page_num)
    return ocr_text if ocr_text else text


def _group_content_segments(content_types):
    """将连续相同类型的页分组为段"""
    if not content_types:
        return []
    segments = []
    current_type = content_types[0]
    start = 0
    for i, ct in enumerate(content_types[1:], start=1):
        if ct != current_type and ct != 'unknown':
            segments.append({'type': current_type, 'start_page': start, 'end_page': i - 1})
            current_type = ct
            start = i
    segments.append({'type': current_type, 'start_page': start, 'end_page': len(content_types) - 1})
    # 过滤掉纯unknown的段
    return [seg for seg in segments if seg['type'] != 'unknown']


# ============================================================
# 3. 三种拆分方式
# ============================================================

def split_pdf_by_bookmark(pdf_path, output_dir, bookmarks):
    """按书签拆分PDF

    Args:
        pdf_path: 原始PDF路径
        output_dir: 输出目录
        bookmarks: detect_merged_pdf返回的bookmarks列表

    Returns:
        list: 拆分后的文件信息列表 [{path, title, page_range, content_type}]
    """
    if not _PYPDF2_AVAILABLE or not bookmarks:
        return []

    os.makedirs(output_dir, exist_ok=True)
    reader = PdfReader(pdf_path)
    total_pages = len(reader.pages)

    sorted_bms = sorted(bookmarks, key=lambda x: x['page'])
    results = []

    for idx, bm in enumerate(sorted_bms):
        start = bm['page']
        end = sorted_bms[idx + 1]['page'] - 1 if idx + 1 < len(sorted_bms) else total_pages - 1
        if start > end:
            continue

        writer = PdfWriter()
        for i in range(start, end + 1):
            writer.add_page(reader.pages[i])

        # 命名：{序号}_{书签标题}.pdf（清理非法字符）
        safe_title = re.sub(r'[\\/:*?"<>|]', '_', bm['title'])[:50]
        out_name = f"{idx + 1:02d}_{safe_title}.pdf"
        out_path = os.path.join(output_dir, out_name)

        with open(out_path, 'wb') as f:
            writer.write(f)

        results.append({
            'path': out_path,
            'title': bm['title'],
            'page_range': (start, end),
            'content_type': 'unknown',
        })

    return results


def split_pdf_by_content_type(pdf_path, output_dir, content_types=None):
    """按内容类型拆分PDF

    Args:
        pdf_path: 原始PDF路径
        output_dir: 输出目录
        content_types: 各页内容类型列表（如未提供则现场提取）

    Returns:
        list: 拆分后的文件信息列表
    """
    if not _PYPDF2_AVAILABLE:
        return []

    os.makedirs(output_dir, exist_ok=True)
    reader = PdfReader(pdf_path)
    total_pages = len(reader.pages)

    if content_types is None or len(content_types) != total_pages:
        content_types = []
        try:
            with pdfplumber.open(pdf_path) as pdf:
                for page in pdf.pages:
                    text = _get_page_text_safe(pdf_path, page)
                    content_types.append(_classify_page_content(text))
        except Exception:
            content_types = ['unknown'] * total_pages

    segments = _group_content_segments(content_types)
    if not segments:
        return []

    results = []
    for idx, seg in enumerate(segments):
        start, end = seg['start_page'], seg['end_page']
        if start > end:
            continue

        writer = PdfWriter()
        for i in range(start, end + 1):
            writer.add_page(reader.pages[i])

        ctype = seg['type']
        prefix = CONTENT_TYPE_PREFIX.get(ctype, '其他')
        out_name = f"{idx + 1:02d}_{prefix}_p{start + 1}-{end + 1}.pdf"
        out_path = os.path.join(output_dir, out_name)

        with open(out_path, 'wb') as f:
            writer.write(f)

        results.append({
            'path': out_path,
            'content_type': ctype,
            'page_range': (start, end),
        })

    return results


def split_pdf_by_page(pdf_path, output_dir, pages_per_file=1, page_ranges=None):
    """按页拆分PDF

    Args:
        pdf_path: 原始PDF路径
        output_dir: 输出目录
        pages_per_file: 每个文件包含的页数（默认每页一个文件）
        page_ranges: 自定义页码范围列表 [(0,2), (3,5), ...]，提供时忽略pages_per_file

    Returns:
        list: 拆分后的文件信息列表
    """
    if not _PYPDF2_AVAILABLE:
        return []

    os.makedirs(output_dir, exist_ok=True)
    reader = PdfReader(pdf_path)
    total_pages = len(reader.pages)

    if page_ranges is None:
        page_ranges = []
        for start in range(0, total_pages, pages_per_file):
            end = min(start + pages_per_file - 1, total_pages - 1)
            page_ranges.append((start, end))

    results = []
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]

    for idx, (start, end) in enumerate(page_ranges):
        if start > end or start >= total_pages:
            continue
        end = min(end, total_pages - 1)

        writer = PdfWriter()
        for i in range(start, end + 1):
            writer.add_page(reader.pages[i])

        out_name = f"{base_name}_p{start + 1}-{end + 1}.pdf"
        out_path = os.path.join(output_dir, out_name)

        with open(out_path, 'wb') as f:
            writer.write(f)

        results.append({
            'path': out_path,
            'page_range': (start, end),
        })

    return results


# ============================================================
# 4. 内容提取（文本/表格/图片）
# ============================================================

def extract_pdf_content(pdf_path, page_range=None):
    """提取PDF内容（文本/表格/图片）

    Args:
        pdf_path: PDF路径
        page_range: (start, end) 页码范围（0-based），None表示全部

    Returns:
        dict: {
            'text': str,
            'tables': list,
            'images': list,
            'page_count': int,
        }
    """
    result = {'text': '', 'tables': [], 'images': [], 'page_count': 0}

    if not _PYPDF2_AVAILABLE:
        return result

    try:
        with pdfplumber.open(pdf_path) as pdf:
            total = len(pdf.pages)
            result['page_count'] = total

            if page_range is None:
                start, end = 0, total - 1
            else:
                start, end = page_range
                end = min(end, total - 1)

            all_text = []
            for i in range(start, end + 1):
                page = pdf.pages[i]
                text = _get_page_text_safe(pdf_path, page)
                all_text.append(text)
                tables = page.extract_tables() or []
                result['tables'].extend(tables)
                try:
                    images = page.images or []
                    for img in images:
                        result['images'].append({
                            'page': i,
                            'bbox': img.get('bbox'),
                            'width': img.get('width'),
                            'height': img.get('height'),
                        })
                except Exception:
                    pass

            result['text'] = '\n'.join(all_text)
    except Exception:
        pass

    return result


def ocr_scanned_pdf(pdf_path, page_range=None, lang='chi_sim+eng'):
    """对扫描版PDF执行OCR识别

    Args:
        pdf_path: PDF路径
        page_range: (start, end) 页码范围，None表示全部
        lang: OCR语言，默认中英混合

    Returns:
        str: OCR识别的文本
    """
    if not _OCR_AVAILABLE:
        return ''

    try:
        reader = PdfReader(pdf_path)
        total = len(reader.pages)
        if page_range is None:
            start, end = 0, total - 1
        else:
            start, end = page_range
            end = min(end, total - 1)

        all_text = []
        pages = pdf2image.convert_from_path(
            pdf_path,
            first_page=start + 1,
            last_page=end + 1,
            dpi=200,
        )

        for page_img in pages:
            text = pytesseract.image_to_string(page_img, lang=lang)
            all_text.append(text)

        return '\n'.join(all_text)
    except Exception:
        return ''


# ============================================================
# 5. PDF合并（CLI merge 子命令使用）
# ============================================================

def merge_pdfs(pdf_paths, output_path):
    """合并多个PDF文件为一个

    Args:
        pdf_paths: PDF文件路径列表
        output_path: 合并后输出路径

    Returns:
        dict: {
            'success': bool,
            'output_path': str,
            'merged_count': int,
            'page_count': int,
            'error': str,  # 失败时存在
        }
    """
    if not _PYPDF2_AVAILABLE:
        return {'success': False, 'error': 'PyPDF2未安装'}

    if not pdf_paths:
        return {'success': False, 'error': '未提供PDF文件'}

    try:
        writer = PdfWriter()
        page_count = 0
        merged_paths = []
        missing_paths = []

        for pdf_path in pdf_paths:
            if not os.path.exists(pdf_path):
                missing_paths.append(pdf_path)
                continue
            reader = PdfReader(pdf_path)
            for page in reader.pages:
                writer.add_page(page)
                page_count += 1
            merged_paths.append(pdf_path)

        if not merged_paths:
            return {'success': False, 'error': f'所有文件均不存在: {missing_paths}'}

        # 确保输出目录存在
        out_dir = os.path.dirname(os.path.abspath(output_path))
        os.makedirs(out_dir, exist_ok=True)

        with open(output_path, 'wb') as f:
            writer.write(f)

        return {
            'success': True,
            'output_path': output_path,
            'merged_count': len(merged_paths),
            'page_count': page_count,
            'missing_paths': missing_paths,
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


# ============================================================
# 6. 主入口：自动检测并处理合并PDF
# ============================================================

def detect_and_process_merged_pdf(pdf_path, output_dir=None, enable_ocr=True):
    """自动检测并处理合并PDF的主入口

    工作流程：
    1. 检测是否为合并PDF（detect_merged_pdf）
    2. 如果是：备份原件 → 选择拆分方式 → 拆分 → 提取内容
    3. 如果否：直接提取内容

    Args:
        pdf_path: PDF路径
        output_dir: 拆分后文件输出目录，默认为 {pdf所在目录}/{pdf文件名}_拆分/
        enable_ocr: 是否对扫描页启用OCR（默认True）

    Returns:
        dict: {
            'is_merged': bool,
            'split_method': str,
            'backup_path': str,
            'split_files': list,
            'extracted_content': dict,
            'ocr_text': str,
            'detection_info': dict,
        }
    """
    if not os.path.exists(pdf_path):
        return {'is_merged': False, 'error': '文件不存在'}

    if output_dir is None:
        base = os.path.splitext(os.path.basename(pdf_path))[0]
        output_dir = os.path.join(os.path.dirname(pdf_path), f'{base}_拆分')

    # 1. 检测
    info = detect_merged_pdf(pdf_path)

    result = {
        'is_merged': info['is_merged'],
        'split_method': '',
        'backup_path': None,
        'split_files': [],
        'extracted_content': {},
        'ocr_text': '',
        'detection_info': info,
    }

    if not info['is_merged']:
        # 非合并PDF：直接提取内容
        result['extracted_content'] = extract_pdf_content(pdf_path)
        return result

    # 2. 备份原件
    backup_path = backup_pdf_before_split(pdf_path)
    result['backup_path'] = backup_path

    # 3. 选择拆分方式并执行
    method = info['suggested_split_method']
    result['split_method'] = method

    if method == 'bookmark' and info['bookmarks']:
        split_files = split_pdf_by_bookmark(pdf_path, output_dir, info['bookmarks'])
    elif method == 'content_type' and info['content_types']:
        split_files = split_pdf_by_content_type(pdf_path, output_dir, info['content_types'])
    else:
        # 按页拆分（每页一个文件）
        split_files = split_pdf_by_page(pdf_path, output_dir, pages_per_file=1)

    result['split_files'] = split_files

    # 4. 对每个拆分后文件提取内容
    for sf in split_files:
        content = extract_pdf_content(sf['path'])
        sf['content'] = content
        if 'content_type' not in sf or sf.get('content_type') == 'unknown':
            sf['content_type'] = _classify_page_content(content['text'][:500])

        # 5. 扫描页OCR
        if enable_ocr and not content['text'].strip():
            ocr_text = ocr_scanned_pdf(sf['path'])
            sf['ocr_text'] = ocr_text
            result['ocr_text'] += ocr_text + '\n'

    return result


def batch_process_merged_pdfs(data_dir, file_patterns=None, enable_ocr=True):
    """批量扫描目录下的PDF文件，自动检测并处理合并PDF

    Args:
        data_dir: 数据目录
        file_patterns: 文件名匹配模式列表，默认['.pdf']
        enable_ocr: 是否启用OCR

    Returns:
        dict: {
            'scanned': int,
            'merged_count': int,
            'processed': list,
            'skipped': list,
        }
    """
    if file_patterns is None:
        file_patterns = ['.pdf']

    results = {
        'scanned': 0,
        'merged_count': 0,
        'processed': [],
        'skipped': [],
    }

    # 收集所有PDF文件（含压缩文件内部）
    all_files = []
    for root, _, files in os.walk(data_dir):
        for f in files:
            if any(f.lower().endswith(ext) for ext in file_patterns):
                all_files.append(os.path.join(root, f))

    for pdf_path in all_files:
        results['scanned'] += 1
        try:
            proc = detect_and_process_merged_pdf(pdf_path, enable_ocr=enable_ocr)
            if proc['is_merged']:
                results['merged_count'] += 1
                results['processed'].append({
                    'path': pdf_path,
                    'result': proc,
                })
            else:
                results['skipped'].append({
                    'path': pdf_path,
                    'reason': '非合并PDF',
                })
        except Exception as e:
            results['skipped'].append({
                'path': pdf_path,
                'reason': str(e),
            })

    return results


# ============================================================
# 7. CLI 入口
# ============================================================

def main():
    """CLI 主入口

    支持 split/merge/extract 三个子命令，返回 JSON 格式结果。

    Returns:
        str: JSON 格式的执行结果
    """
    parser = argparse.ArgumentParser(
        description='PDF拆分与合并资料整理工具（模块六）：自动检测合并PDF、按书签/内容/页拆分、合并、提取内容',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
    # 按书签拆分PDF
    python pdf_splitter.py split --input "input.pdf" --output "./output" --mode bookmark

    # 合并多个PDF（逗号分隔）
    python pdf_splitter.py merge --inputs "file1.pdf,file2.pdf" --output "merged.pdf"

    # 提取PDF内容（文本/表格/图片）
    python pdf_splitter.py extract --input "input.pdf" --output "./output"
        """,
    )
    subparsers = parser.add_subparsers(dest='command', help='子命令')

    # split 子命令
    split_parser = subparsers.add_parser('split', help='拆分PDF')
    split_parser.add_argument('--input', required=True, help='输入PDF路径')
    split_parser.add_argument('--output', help='输出目录（默认 {input所在目录}/{文件名}_拆分/）')
    split_parser.add_argument('--mode', choices=['page', 'bookmark', 'content'],
                              default='bookmark', help='拆分模式（默认 bookmark）')

    # merge 子命令
    merge_parser = subparsers.add_parser('merge', help='合并多个PDF')
    merge_parser.add_argument('--inputs', required=True, help='输入PDF文件列表，逗号分隔')
    merge_parser.add_argument('--output', required=True, help='合并后PDF输出路径')

    # extract 子命令
    extract_parser = subparsers.add_parser('extract', help='提取PDF内容（文本/表格/图片）')
    extract_parser.add_argument('--input', required=True, help='输入PDF路径')
    extract_parser.add_argument('--output', help='输出目录（可选，提供则将文本/表格/图片写入文件）')

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        result = {'success': False, 'error': '未指定子命令'}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return json.dumps(result, ensure_ascii=False)

    result = {}

    # ------------------- split 子命令 -------------------
    if args.command == 'split':
        if not os.path.exists(args.input):
            result = {'success': False, 'error': f'输入文件不存在: {args.input}'}
        elif not _PYPDF2_AVAILABLE:
            result = {'success': False, 'error': 'PyPDF2/pdfplumber 未安装，无法拆分'}
        else:
            # 1. 检测合并PDF
            info = detect_merged_pdf(args.input)

            # 2. 备份原件（合并PDF才备份）
            backup_path = None
            if info['is_merged']:
                backup_path = backup_pdf_before_split(args.input)

            # 3. 根据用户指定 mode 执行拆分
            output_dir = args.output
            if output_dir is None:
                base = os.path.splitext(os.path.basename(args.input))[0]
                output_dir = os.path.join(os.path.dirname(os.path.abspath(args.input)), f'{base}_拆分')

            if args.mode == 'page':
                split_files = split_pdf_by_page(args.input, output_dir, pages_per_file=1)
            elif args.mode == 'content':
                split_files = split_pdf_by_content_type(args.input, output_dir, info.get('content_types'))
            else:  # bookmark
                if info['bookmarks']:
                    split_files = split_pdf_by_bookmark(args.input, output_dir, info['bookmarks'])
                elif info['content_types']:
                    # 无书签回退到内容类型
                    split_files = split_pdf_by_content_type(args.input, output_dir, info['content_types'])
                else:
                    split_files = split_pdf_by_page(args.input, output_dir, pages_per_file=1)

            result = {
                'success': True,
                'is_merged': info['is_merged'],
                'detection_reason': info['reason'],
                'page_count': info['page_count'],
                'suggested_split_method': info['suggested_split_method'],
                'actual_split_method': args.mode,
                'backup_path': backup_path,
                'output_dir': output_dir,
                'split_files': split_files,
            }

    # ------------------- merge 子命令 -------------------
    elif args.command == 'merge':
        pdf_paths = [p.strip() for p in args.inputs.split(',') if p.strip()]
        if not pdf_paths:
            result = {'success': False, 'error': '未提供任何PDF文件路径'}
        else:
            result = merge_pdfs(pdf_paths, args.output)

    # ------------------- extract 子命令 -------------------
    elif args.command == 'extract':
        if not os.path.exists(args.input):
            result = {'success': False, 'error': f'输入文件不存在: {args.input}'}
        elif not _PYPDF2_AVAILABLE:
            result = {'success': False, 'error': 'PyPDF2/pdfplumber 未安装，无法提取内容'}
        else:
            content = extract_pdf_content(args.input)

            output_files = {}
            # 如果有输出目录，将文本/表格/图片写入文件
            if args.output:
                os.makedirs(args.output, exist_ok=True)
                base_name = os.path.splitext(os.path.basename(args.input))[0]

                # 写入文本
                if content['text']:
                    text_path = os.path.join(args.output, f'{base_name}_text.txt')
                    with open(text_path, 'w', encoding='utf-8') as f:
                        f.write(content['text'])
                    output_files['text'] = text_path

                # 写入表格
                if content['tables']:
                    tables_path = os.path.join(args.output, f'{base_name}_tables.json')
                    with open(tables_path, 'w', encoding='utf-8') as f:
                        json.dump(content['tables'], f, ensure_ascii=False, indent=2, default=str)
                    output_files['tables'] = tables_path

                # 写入图片信息
                if content['images']:
                    images_path = os.path.join(args.output, f'{base_name}_images.json')
                    with open(images_path, 'w', encoding='utf-8') as f:
                        json.dump(content['images'], f, ensure_ascii=False, indent=2, default=str)
                    output_files['images'] = images_path

            result = {
                'success': True,
                'input': args.input,
                'page_count': content['page_count'],
                'text_length': len(content['text']),
                'tables_count': len(content['tables']),
                'images_count': len(content['images']),
                'output_files': output_files,
                # 完整文本内容（便于程序化处理）
                'text': content['text'],
                'tables': content['tables'],
                'images': content['images'],
            }

    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return json.dumps(result, ensure_ascii=False, default=str)


if __name__ == '__main__':
    main()
