#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
文件压缩工具（file_compressor v2.1）

将PDF和图片文件压缩到符合高新技术企业认定申报系统要求的大小。

核心原则：
1. 优先保证内容可读性，在可读性前提下尽可能压缩体积
2. PDF压缩采用智能五级递进策略：light→medium→deep→(有效性检测)→extreme→ultra
3. 压缩有效性检测：deep压缩比<5%时自动跳过extreme（扫描件/图片密集PDF）
4. ultra采用自适应DPI计算：DPI ≈ sqrt(目标体积/原始体积) × 300，质量优先从高到低
5. --quick 模式直跳ultra，适用于已知扫描件/图片密集场景，大幅节省时间

材料类型与大小限制（来源：资料要求.xlsx）：
    IP证明材料: ≤2MB (PDF)
    RD证明材料: ≤2MB (PDF)
    PS证明材料: ≤4MB (PDF)
    科技成果转化: ≤2MB (PDF)
    国标/行标: ≤2MB (PDF)
    营业执照: ≤500KB (JPG/PNG)
    申报书封皮: ≤1MB (PDF)
    财务审计报告: ≤100MB (PDF)
    所得税纳税申报表: ≤5MB (PDF)
    研发费用专审: ≤100MB (PDF)
    高新收入专审: ≤100MB (PDF)
    研发管理制度: ≤20MB (PDF)
    研发机构及产学研: ≤20MB (PDF)
    成果转化激励制度: ≤5MB (PDF)
    科技人员培养制度: ≤5MB (PDF)
    人力资源情况: ≤8MB (PDF)
    销售合同与发票: ≤20MB (PDF)
    企业承诺书: ≤1MB (PDF)
    申请书签字盖章: ≤50MB (PDF, 无明确限制取50MB)

CLI 用法:
    # 按材料类型压缩（自动匹配目标大小）
    python file_compressor.py compress --input "文件路径" --type PS --output "输出路径"

    # 按目标大小压缩（MB）
    python file_compressor.py compress --input "文件路径" --max-size 4 --output "输出路径"

    # 仅检查文件大小是否合规
    python file_compressor.py check --input "文件路径" --type PS

    # 检查并压缩（合规则跳过）
    python file_compressor.py auto --input "文件路径" --type PS --output "输出路径"

输出：JSON 格式结果 {"success": bool, "original_size_mb": float, "compressed_size_mb": float,
        "compression_ratio": str, "meets_limit": bool, "method": str, "error": str|null}
"""

import os
import io
import json
import argparse
import shutil
from pathlib import Path

try:
    import fitz
    _FITZ_AVAILABLE = True
except ImportError:
    _FITZ_AVAILABLE = False

try:
    from PIL import Image
    _PIL_AVAILABLE = True
except ImportError:
    _PIL_AVAILABLE = False


# ============================================================
# 材料类型 → 目标大小映射（MB）
# ============================================================

_MATERIAL_SIZE_LIMITS = {
    "IP": 2, "NIP": 2,
    "RD": 2,
    "PS": 4,
    "ACHIEVEMENT": 2, "成果转化": 2,
    "STANDARD": 2, "国标": 2, "行标": 2,
    "LICENSE": 0.5, "营业执照": 0.5,
    "COVER": 1, "封皮": 1, "申报书封皮": 1,
    "AUDIT_FINANCIAL": 100, "财务审计报告": 100,
    "TAX": 5, "所得税": 5, "纳税申报表": 5,
    "AUDIT_RD": 100, "研发费用专审": 100,
    "AUDIT_PS": 100, "高新收入专审": 100,
    "MANAGEMENT": 20, "研发管理制度": 20,
    "INSTITUTION": 20, "研发机构": 20, "产学研": 20,
    "INCENTIVE": 5, "成果转化激励": 5,
    "TRAINING": 5, "科技人员培养": 5,
    "HR": 8, "人力资源": 8,
    "CONTRACT": 20, "合同发票": 20, "销售合同": 20,
    "PROMISE": 1, "承诺书": 1,
    "APPLICATION": 50, "申请书": 50, "签字盖章": 50,
}

_MATERIAL_TYPE_ALIASES = {
    "IP": "IP", "NIP": "IP", "知识产权": "IP",
    "RD": "RD", "研发活动": "RD", "研发": "RD",
    "PS": "PS", "高新产品": "PS", "产品": "PS",
    "ACHIEVEMENT": "ACHIEVEMENT", "成果转化": "ACHIEVEMENT", "成果": "ACHIEVEMENT",
    "STANDARD": "STANDARD", "国标": "STANDARD", "行标": "STANDARD", "标准": "STANDARD",
    "LICENSE": "LICENSE", "营业执照": "LICENSE",
    "COVER": "COVER", "封皮": "COVER", "申报书封皮": "COVER",
    "AUDIT_FINANCIAL": "AUDIT_FINANCIAL", "财务审计报告": "AUDIT_FINANCIAL", "财务审计": "AUDIT_FINANCIAL",
    "TAX": "TAX", "所得税": "TAX", "纳税申报表": "TAX", "企业所得税": "TAX",
    "AUDIT_RD": "AUDIT_RD", "研发费用专审": "AUDIT_RD",
    "AUDIT_PS": "AUDIT_PS", "高新收入专审": "AUDIT_PS",
    "MANAGEMENT": "MANAGEMENT", "研发管理制度": "MANAGEMENT", "管理制度": "MANAGEMENT",
    "INSTITUTION": "INSTITUTION", "研发机构": "INSTITUTION", "产学研": "INSTITUTION",
    "INCENTIVE": "INCENTIVE", "成果转化激励": "INCENTIVE", "激励制度": "INCENTIVE",
    "TRAINING": "TRAINING", "科技人员培养": "TRAINING", "人员培养": "TRAINING",
    "HR": "HR", "人力资源": "HR", "人员": "HR",
    "CONTRACT": "CONTRACT", "合同发票": "CONTRACT", "销售合同": "CONTRACT", "合同": "CONTRACT",
    "PROMISE": "PROMISE", "承诺书": "PROMISE",
    "APPLICATION": "APPLICATION", "申请书": "APPLICATION", "签字盖章": "APPLICATION",
}


def _get_size_limit(material_type):
    """根据材料类型获取目标大小（MB）"""
    key = _MATERIAL_TYPE_ALIASES.get(material_type.upper(), material_type.upper())
    return _MATERIAL_SIZE_LIMITS.get(key, _MATERIAL_SIZE_LIMITS.get(material_type, 4))


def get_file_size_mb(file_path):
    """获取文件大小（MB）"""
    return os.path.getsize(file_path) / (1024 * 1024)


def check_file_size(file_path, limit_mb):
    """检查文件大小是否合规"""
    size = get_file_size_mb(file_path)
    return size <= limit_mb, size


# ============================================================
# PDF 压缩引擎（PyMuPDF/fitz）
# ============================================================

def _compress_pdf_light(input_path, output_path):
    """轻量压缩：垃圾回收 + deflate + 线性化"""
    doc = fitz.open(input_path)
    doc.save(output_path, garbage=3, deflate=True)
    doc.close()


def _compress_pdf_medium(input_path, output_path):
    """中度压缩：垃圾回收(4) + deflate + 清理内容流"""
    doc = fitz.open(input_path)
    doc.save(output_path, garbage=4, deflate=True, clean=True)
    doc.close()


def _compress_pdf_deep(input_path, output_path):
    """深度压缩：中度基础上 + 图片deflate + 字体deflate"""
    doc = fitz.open(input_path)
    doc.save(output_path, garbage=4, deflate=True, clean=True,
             deflate_images=True, deflate_fonts=True)
    doc.close()


def _compress_pdf_extreme(input_path, output_path, image_quality=50):
    """极限压缩：深度基础上 + 图片重压缩"""
    doc = fitz.open(input_path)
    for page in doc:
        page.clean_contents()
    doc.save(output_path, garbage=4, deflate=True, clean=True,
             deflate_images=True, deflate_fonts=True)
    doc.close()

    need_image_recompress = get_file_size_mb(output_path) > 1
    if need_image_recompress:
        _recompress_images_in_pdf(output_path, output_path, image_quality)


def _is_scanned_pdf(input_path, image_threshold=0.7):
    """检测是否为扫描件PDF（页面内容以图片为主）"""
    doc = fitz.open(input_path)
    total_pages = len(doc)
    image_pages = 0
    for page in doc:
        text = page.get_text().strip()
        images = page.get_images(full=True)
        if len(text) < 50 and len(images) > 0:
            image_pages += 1
    doc.close()
    if total_pages == 0:
        return False
    return (image_pages / total_pages) >= image_threshold


def _recompress_images_in_pdf(input_path, output_path, jpeg_quality=50):
    """对PDF中的图片进行重压缩（含JPEG2000→JPEG转换 + 整页渲染fallback）"""
    doc = fitz.open(input_path)
    recompressed_count = 0
    failed_count = 0

    for page_num in range(len(doc)):
        page = doc[page_num]
        images = page.get_images(full=True)
        if not images:
            continue
        for img_info in images:
            xref = img_info[0]
            try:
                base_image = doc.extract_image(xref)
                if base_image is None:
                    continue
                img_bytes = base_image.get("image")
                if img_bytes is None:
                    continue
                img_ext = base_image.get("ext", "").lower()

                pil_img = Image.open(io.BytesIO(img_bytes))
                if pil_img.mode in ("RGBA", "P", "LA"):
                    pil_img = pil_img.convert("RGB")

                buf = io.BytesIO()
                bbox = page.get_image_bbox(img_info)

                # JPEG2000(jpx/jp2/j2k) 需先渲染再压缩，直接replace_image不可靠
                if img_ext in ("jpx", "jp2", "j2k"):
                    # 判断图片是否覆盖整页（扫描件特征），如有bbox则用replace_image否则跳过
                    if bbox and bbox.width > 0 and bbox.height > 0:
                        try:
                            pil_img.save(buf, format="JPEG", quality=jpeg_quality, optimize=True,
                                         subsampling="4:2:0")
                            buf.seek(0)
                            page.replace_image(xref, stream=buf.read())
                            recompressed_count += 1
                        except Exception:
                            failed_count += 1
                    else:
                        failed_count += 1
                else:
                    pil_img.save(buf, format="JPEG", quality=jpeg_quality, optimize=True,
                                 subsampling="4:2:0")
                    buf.seek(0)
                    if bbox and bbox.width > 0 and bbox.height > 0:
                        try:
                            page.replace_image(xref, stream=buf.read())
                            recompressed_count += 1
                        except Exception:
                            failed_count += 1
                    else:
                        recompressed_count += 1
            except Exception:
                failed_count += 1
                continue

    doc.save(output_path, garbage=4, deflate=True, deflate_images=True, clean=True)
    doc.close()

    # 如果重压缩完全失败（所有图都是JPEG2000且无法replace），返回False让调用方降级到ultra
    if recompressed_count == 0 and failed_count > 0:
        return False
    return True


def _compress_pdf_ultra(input_path, output_path, dpi=100, grayscale=True):
    """
    超强压缩：DPI栅格化 + 灰度转换 + chroma子采样 (参考 PDFCompressor 策略)
    将每页渲染为低DPI图片后重建PDF，专治几十MB→个位数MB的极端场景
    """
    doc = fitz.open(input_path)
    new_doc = fitz.open()

    for page in doc:
        colorspace = fitz.csGRAY if grayscale else fitz.csRGB
        pix = page.get_pixmap(dpi=dpi, colorspace=colorspace)

        pil_img = Image.open(io.BytesIO(pix.tobytes("png")))
        if pil_img.mode not in ("RGB", "L"):
            pil_img = pil_img.convert("RGB")

        buf = io.BytesIO()
        pil_img.save(buf, format="JPEG", quality=30, optimize=True,
                     subsampling="4:2:0")
        buf.seek(0)

        img_bytes = buf.read()
        new_page = new_doc.new_page(width=pix.width, height=pix.height)
        new_page.insert_image(new_page.rect, stream=img_bytes)

    new_doc.save(output_path, garbage=4, deflate=True, deflate_images=True)
    new_doc.close()
    doc.close()


def _compress_pdf_ultra_color(input_path, output_path, dpi=100):
    """超强压缩（彩色版）：保留颜色但降DPI"""
    return _compress_pdf_ultra(input_path, output_path, dpi=dpi, grayscale=False)


def _estimate_ultra_dpi(original_mb, target_mb, color=True):
    """根据原始体积和目标体积估算需要的DPI（基于面积比开方，彩色降系数）"""
    if target_mb <= 0 or original_mb <= 0:
        return 100
    ratio = (target_mb / original_mb) ** 0.5
    # 彩色JPEG(chroma 4:2:0)体积约是灰度的1.5倍，DPI需额外降低
    if color:
        ratio = ratio / (1.5 ** 0.5)  # ≈ ratio / 1.225
    estimated = int(300 * ratio)
    return max(50, min(200, estimated))


def _try_ultra_levels(input_path, output_path, max_size_mb, start_dpi=None):
    """尝试不同DPI的ultra压缩，优先彩色扫描找最高DPI，彩色全线超标再降灰度"""
    if start_dpi is None:
        original_size = get_file_size_mb(input_path)
        start_dpi = _estimate_ultra_dpi(original_size, max_size_mb, color=True)
        start_dpi = min(start_dpi + 20, 200)

    all_dpis = [200, 180, 160, 150, 140, 130, 120, 110, 100, 95, 90, 85, 80, 75, 70, 65, 60, 50]
    dpi_levels = [d for d in all_dpis if d <= start_dpi]
    if not dpi_levels:
        dpi_levels = all_dpis

    # 第一轮：仅彩色，从高到低找最高不超标DPI（质量优先）
    for dpi in dpi_levels:
        try:
            _compress_pdf_ultra_color(input_path, output_path, dpi=dpi)
            current_size = get_file_size_mb(output_path)
            if current_size <= max_size_mb:
                return True, current_size, f"ultra_color_dpi{dpi}"
        except Exception:
            continue

    # 第二轮：彩色全线超标，降灰度重试
    for dpi in dpi_levels:
        try:
            _compress_pdf_ultra(input_path, output_path, dpi=dpi, grayscale=True)
            current_size = get_file_size_mb(output_path)
            if current_size <= max_size_mb:
                return True, current_size, f"ultra_gray_dpi{dpi}"
        except Exception:
            continue

    return False, get_file_size_mb(output_path), "ultra_failed"


def compress_pdf(input_path, output_path, max_size_mb, image_quality=50, quick=False):
    """
    多级递进PDF压缩策略（v2.1 优化版）
    - 压缩有效性检测：deep<5%跳过extreme
    - 自适应DPI计算，找到最小不超标DPI（质量优先）
    - quick=True 直跳ultra（适用于已知扫描件/图片密集PDF）
    返回: (success, compressed_size_mb, method)
    """
    original_size = get_file_size_mb(input_path)

    if original_size <= max_size_mb:
        if input_path != output_path:
            shutil.copy2(input_path, output_path)
        return True, original_size, "no_compression_needed"

    if not _FITZ_AVAILABLE:
        return False, original_size, "PyMuPDF_not_available"

    # ---- quick模式：直跳ultra ----
    if quick:
        start_dpi = _estimate_ultra_dpi(original_size, max_size_mb) + 20
        ok, final_size, method = _try_ultra_levels(input_path, output_path, max_size_mb, start_dpi)
        if ok:
            return ok, final_size, "quick_" + method
        current_size = get_file_size_mb(output_path)
        return current_size <= max_size_mb, current_size, "quick_best_effort"

    # ---- 阶段1：light → medium → deep（快速尝试）----
    strategies = [
        ("light", lambda: _compress_pdf_light(input_path, output_path)),
        ("medium", lambda: _compress_pdf_medium(input_path, output_path)),
        ("deep", lambda: _compress_pdf_deep(input_path, output_path)),
    ]
    for method_name, compress_fn in strategies:
        try:
            compress_fn()
            current_size = get_file_size_mb(output_path)
            if current_size <= max_size_mb:
                return True, current_size, method_name
        except Exception:
            continue

    # ---- 阶段2：检查deep是否有效（压缩比>5%），无效则跳过extreme ----
    deep_size = get_file_size_mb(output_path)
    deep_reduction = (original_size - deep_size) / original_size if original_size > 0 else 0
    deep_effective = deep_reduction >= 0.05

    # ---- 阶段3：extreme（仅deep有效时尝试，含JPEG2000重压缩）----
    if deep_effective:
        quality_levels = [75, 60, 50, 40, 30]
        for q in quality_levels:
            try:
                # 直接对源文件做extreme（含图片重压缩）
                _compress_pdf_extreme(input_path, output_path, image_quality=q)
                current_size = get_file_size_mb(output_path)
                if current_size <= max_size_mb:
                    return True, current_size, f"extreme_q{q}"
            except Exception:
                continue

    # ---- 阶段4：检查当前最佳结果 ----
    try:
        current_size = get_file_size_mb(output_path)
    except Exception:
        current_size = original_size
    if current_size <= max_size_mb:
        return True, current_size, "current_best"

    # ---- 阶段5：ultra（DPI栅格化，自适应计算）+ 质量优先 ----
    start_dpi = _estimate_ultra_dpi(original_size, max_size_mb) + 20
    ok, final_size, method = _try_ultra_levels(input_path, output_path, max_size_mb, start_dpi)
    if ok:
        return ok, final_size, method

    current_size = get_file_size_mb(output_path)
    return current_size <= max_size_mb, current_size, "best_effort"


# ============================================================
# 图片压缩引擎（Pillow）
# ============================================================

_MAX_IMAGE_DIMENSION = 2048


def _quantize_png(img, colors=256):
    """PNG色深量化（参考Caesium/pngquant思路）"""
    if img.mode == "RGBA":
        alpha = img.split()[-1]
        rgb_img = img.convert("RGB")
        quantized = rgb_img.quantize(colors=min(colors, 255), method=Image.Quantize.MEDIANCUT)
        quantized = quantized.convert("RGB")
        result = Image.new("RGBA", img.size)
        result.paste(quantized, (0, 0))
        result.putalpha(alpha)
        return result
    elif img.mode == "RGB":
        quantized = img.quantize(colors=min(colors, 255), method=Image.Quantize.MEDIANCUT)
        return quantized.convert("RGB")
    else:
        return img.convert("RGB").quantize(colors=min(colors, 255), method=Image.Quantize.MEDIANCUT).convert("RGB")


def compress_image(input_path, output_path, max_size_kb, jpeg_quality_start=85):
    """
    图片压缩策略（支持JPG/PNG/BMP/GIF/TIFF/WEBP）
    返回: (success, compressed_size_kb, method)
    """
    original_size_kb = os.path.getsize(input_path) / 1024

    if original_size_kb <= max_size_kb:
        if input_path != output_path:
            shutil.copy2(input_path, output_path)
        return True, original_size_kb, "no_compression_needed"

    if not _PIL_AVAILABLE:
        return False, original_size_kb, "Pillow_not_available"

    img = Image.open(input_path)
    original_mode = img.mode

    width, height = img.size
    max_dim = max(width, height)
    resize_applied = False
    if max_dim > _MAX_IMAGE_DIMENSION:
        scale = _MAX_IMAGE_DIMENSION / max_dim
        new_size = (int(width * scale), int(height * scale))
        img = img.resize(new_size, Image.LANCZOS)
        resize_applied = True

    ext = os.path.splitext(output_path)[1].lower()
    if not ext:
        ext = os.path.splitext(input_path)[1].lower()

    if ext in ('.png',):
        return _compress_as_png(img, output_path, max_size_kb, original_mode, resize_applied)
    else:
        jpeg_ok, jpeg_kb, jpeg_method = _compress_as_jpeg(
            img, output_path, max_size_kb, original_mode,
            jpeg_quality_start, resize_applied, ext)
        if jpeg_ok:
            return jpeg_ok, jpeg_kb, jpeg_method
        return _compress_as_webp(img, output_path, max_size_kb, resize_applied)


def _compress_as_jpeg(img, output_path, max_size_kb, original_mode,
                       quality_start, resize_applied, ext):
    """JPEG/WebP 质量递减压缩（chroma子采样4:2:0）"""
    if original_mode in ("RGBA", "P", "LA"):
        converted = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode == "RGBA":
            converted.paste(img, mask=img.split()[3])
        else:
            converted.paste(img)
        img = converted

    format_map = {'.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WEBP', '.bmp': 'JPEG', '.tiff': 'JPEG'}
    save_format = format_map.get(ext, 'JPEG')

    qualities = [quality_start, 75, 60, 50, 40, 30, 20]
    for q in qualities:
        buf = io.BytesIO()
        if save_format == 'JPEG':
            img.save(buf, format=save_format, quality=q, optimize=True,
                     subsampling="4:2:0")
        else:
            img.save(buf, format=save_format, quality=q, optimize=True)
        size_kb = buf.tell() / 1024
        if size_kb <= max_size_kb:
            with open(output_path, 'wb') as f:
                f.write(buf.getvalue())
            return True, size_kb, f"{save_format.lower()}_q{q}" + ("_resized" if resize_applied else "")

    with open(output_path, 'wb') as f:
        f.write(buf.getvalue())
    current_kb = os.path.getsize(output_path) / 1024
    return current_kb <= max_size_kb, current_kb, "best_effort_jpeg"


def _compress_as_webp(img, output_path, max_size_kb, resize_applied):
    """WebP格式转换（参考Squoosh CLI策略）：体积通常比JPEG小25-35%"""
    if img.mode in ("RGBA", "P", "LA"):
        converted = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode == "RGBA":
            converted.paste(img, mask=img.split()[3])
        else:
            converted.paste(img)
        img = converted

    qualities = [75, 60, 50, 40, 30, 20, 10]
    for q in qualities:
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=q, optimize=True)
        size_kb = buf.tell() / 1024
        if size_kb <= max_size_kb:
            with open(output_path, 'wb') as f:
                f.write(buf.getvalue())
            return True, size_kb, f"webp_q{q}" + ("_resized" if resize_applied else "")

    with open(output_path, 'wb') as f:
        f.write(buf.getvalue())
    current_kb = os.path.getsize(output_path) / 1024
    return current_kb <= max_size_kb, current_kb, "best_effort_webp"


def _compress_as_png(img, output_path, max_size_kb, original_mode, resize_applied):
    """PNG压缩：优化PNG → PNG量化256色(参考Caesium/pngquant) → 转JPEG → 转WebP"""
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    size_kb = buf.tell() / 1024
    if size_kb <= max_size_kb:
        with open(output_path, 'wb') as f:
            f.write(buf.getvalue())
        return True, size_kb, "png_optimized" + ("_resized" if resize_applied else "")

    try:
        quantized = _quantize_png(img, colors=256)
        buf = io.BytesIO()
        quantized.save(buf, format='PNG', optimize=True)
        size_kb = buf.tell() / 1024
        if size_kb <= max_size_kb:
            with open(output_path, 'wb') as f:
                f.write(buf.getvalue())
            return True, size_kb, "png_quantized_256" + ("_resized" if resize_applied else "")
        img = quantized
    except Exception:
        pass

    if original_mode in ("RGBA", "P", "LA"):
        converted = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode == "RGBA":
            converted.paste(img, mask=img.split()[3])
        else:
            converted.paste(img)
        img = converted

    jpeg_ok, jpeg_kb, jpeg_method = _compress_as_jpeg(
        img, output_path, max_size_kb, "RGB", 85, resize_applied, '.jpg')
    if jpeg_ok:
        return jpeg_ok, jpeg_kb, jpeg_method

    return _compress_as_webp(img, output_path, max_size_kb, resize_applied)


# ============================================================
# 统一入口
# ============================================================

def compress_file(input_path, output_path, max_size_mb=None, material_type=None,
                  image_quality=50, jpeg_quality=85, quick=False):
    """
    统一压缩入口

    参数:
        input_path: 输入文件路径
        output_path: 输出文件路径
        max_size_mb: 目标大小（MB），为None时通过material_type推断
        material_type: 材料类型（如"PS"/"IP"/"营业执照"等）
        image_quality: PDF图片压缩质量(1-100)
        jpeg_quality: JPEG图片压缩起始质量(1-100)
        quick: 直跳ultra模式（适用于已知扫描件/图片密集PDF）

    返回:
        dict: {
            "success": bool,
            "original_size_mb": float,
            "compressed_size_mb": float,
            "compression_ratio": str,
            "meets_limit": bool,
            "method": str,
            "error": str|null
        }
    """
    result = {
        "success": False,
        "original_size_mb": 0,
        "compressed_size_mb": 0,
        "compression_ratio": "0%",
        "meets_limit": False,
        "method": "unknown",
        "error": None
    }

    try:
        if not os.path.exists(input_path):
            result["error"] = f"输入文件不存在: {input_path}"
            return result

        original_size = get_file_size_mb(input_path)
        result["original_size_mb"] = round(original_size, 3)

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

        ext = os.path.splitext(input_path)[1].lower()
        is_image = ext in ('.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.webp')
        is_pdf = ext == '.pdf'

        if max_size_mb is None and material_type is not None:
            max_size_mb = _get_size_limit(material_type)
        elif max_size_mb is None:
            max_size_mb = 4

        if is_pdf:
            ok, compressed_size, method = compress_pdf(
                input_path, output_path, max_size_mb, image_quality, quick=quick
            )
            result["compressed_size_mb"] = round(compressed_size, 3)
        elif is_image:
            max_size_kb = max_size_mb * 1024
            ok, compressed_size_kb, method = compress_image(
                input_path, output_path, max_size_kb, jpeg_quality
            )
            result["compressed_size_mb"] = round(compressed_size_kb / 1024, 3)
        else:
            shutil.copy2(input_path, output_path)
            result["compressed_size_mb"] = round(original_size, 3)
            result["method"] = "unsupported_type_copied"
            result["meets_limit"] = original_size <= max_size_mb
            result["success"] = True
            result["error"] = f"不支持的文件类型({ext})，已原样复制"
            return result

        result["success"] = ok
        result["method"] = method

        if original_size > 0:
            ratio = (1 - result["compressed_size_mb"] / original_size) * 100
            result["compression_ratio"] = f"{ratio:.1f}%"

        result["meets_limit"] = result["compressed_size_mb"] <= max_size_mb

    except Exception as e:
        result["error"] = str(e)

    return result


def auto_compress(input_path, output_path, material_type=None, max_size_mb=None):
    """自动检查并压缩：合规则跳过，不合规则压缩"""
    if max_size_mb is None:
        max_size_mb = _get_size_limit(material_type) if material_type else 4

    ok, current_size = check_file_size(input_path, max_size_mb)
    if ok:
        if input_path != output_path:
            shutil.copy2(input_path, output_path)
        return {
            "success": True,
            "original_size_mb": round(current_size, 3),
            "compressed_size_mb": round(current_size, 3),
            "compression_ratio": "0%",
            "meets_limit": True,
            "method": "already_compliant",
            "error": None
        }

    return compress_file(input_path, output_path, max_size_mb, material_type)


# ============================================================
# CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="文件压缩工具 - 高新技术企业认定申报材料压缩"
    )
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    compress_parser = subparsers.add_parser("compress", help="压缩文件")
    compress_parser.add_argument("--input", required=True, help="输入文件路径")
    compress_parser.add_argument("--output", required=True, help="输出文件路径")
    compress_parser.add_argument("--quick", action="store_true", help="快速模式：直跳ultra压缩（适用于扫描件/图片密集PDF）")
    group = compress_parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--type", dest="material_type", help="材料类型（如PS/IP/RD/营业执照等）")
    group.add_argument("--max-size", type=float, dest="max_size_mb", help="目标文件大小（MB）")

    check_parser = subparsers.add_parser("check", help="检查文件大小")
    check_parser.add_argument("--input", required=True, help="输入文件路径")
    check_group = check_parser.add_mutually_exclusive_group(required=True)
    check_group.add_argument("--type", dest="material_type", help="材料类型")
    check_group.add_argument("--max-size", type=float, dest="max_size_mb", help="目标大小（MB）")

    auto_parser = subparsers.add_parser("auto", help="自动检查并压缩")
    auto_parser.add_argument("--input", required=True, help="输入文件路径")
    auto_parser.add_argument("--output", required=True, help="输出文件路径")
    auto_group = auto_parser.add_mutually_exclusive_group(required=True)
    auto_group.add_argument("--type", dest="material_type", help="材料类型")
    auto_group.add_argument("--max-size", type=float, dest="max_size_mb", help="目标大小（MB）")

    list_parser = subparsers.add_parser("list-limits", help="列出所有材料类型的大小限制")

    args = parser.parse_args()

    if args.command == "list-limits":
        seen = set()
        for alias, canonical in sorted(_MATERIAL_TYPE_ALIASES.items()):
            key = (canonical, _MATERIAL_SIZE_LIMITS[canonical])
            if key not in seen:
                seen.add(key)
                print(f"{canonical}: ≤{_MATERIAL_SIZE_LIMITS[canonical]}MB")
        return

    if args.command == "check":
        if args.max_size_mb:
            limit = args.max_size_mb
        else:
            limit = _get_size_limit(args.material_type)
        ok, size = check_file_size(args.input, limit)
        print(json.dumps({
            "file": args.input,
            "size_mb": round(size, 3),
            "limit_mb": limit,
            "meets_limit": ok
        }, ensure_ascii=False, indent=2))
        return

    if args.command == "compress":
        quick = getattr(args, 'quick', False)
        result = compress_file(
            args.input, args.output,
            max_size_mb=args.max_size_mb,
            material_type=args.material_type,
            quick=quick
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    if args.command == "auto":
        result = auto_compress(
            args.input, args.output,
            material_type=args.material_type,
            max_size_mb=args.max_size_mb
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return


if __name__ == "__main__":
    main()
