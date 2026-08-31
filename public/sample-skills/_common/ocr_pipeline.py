#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ocr_pipeline.py - 增强OCR管线（移植 dsh-pseudo-vision 的本地伪视觉思路）

在 ocr_engine.py 的 RapidOCR 基础上增加（零新依赖，PIL + numpy 已随 embedded python 分发）：
  1. 预处理：预算缩放、深色模式检测反色、灰度、对比度拉伸、条件椒盐降噪、轻锐化、白边
  2. 低置信度区域重试：bbox 裁剪 + 放大重读，置信度提升才替换（证据留痕）
  3. CJK 后处理：合并字间空格（"通 知"→"通知"）、剥离行首图标符号
  4. 数字复核：IP/URL/端口/长数字用 ASCII 白名单重读，同长度且置信提升才接受
  5. 超长截图分块：>3000px 按 2000px 块 + 100px overlap 切块，避免小字被压没
  6. 证据封顶：超长结果截断并显式标注（防上下文撑爆）

RapidOCR 输出格式：[ [box4, text, conf], ... ]，box4 = [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]（浮点坐标）。
低置信度重试 / 数字复核依赖 bbox，裁剪原图区域 + 放大重读。

设计对照 dsh-pseudo-vision（github.com/DDDFXYqiming/dsh-pseudo-vision）：
  - preprocess.ts  ->  preprocess_for_ocr / enhance_for_ocr
  - ocr.ts         ->  ocr_with_retry / verify_digit_tokens / apply_cjk_postprocess
  - chunk-ocr.ts   ->  chunked_ocr
"""

import re
from typing import Optional

import numpy as np

try:
    from PIL import Image, ImageFilter, ImageOps
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False

# ---------------------------------------------------------------------------
# 常量（对照 dsh-pseudo-vision preprocess.ts）
# ---------------------------------------------------------------------------
# 预算缩放：normal 约 1024²；超大图用 large（约 1448²）。RapidOCR 内部已有
# max_side_len 限制（默认 736/960），预算缩放主要保证"小图放大、超大图收敛"。
BUDGET_MAX_PIXELS = 1024 * 1024          # normal
BUDGET_MAX_PIXELS_LARGE = 1448 * 1448    # large
BUDGET_MIN_PIXELS = 224 * 224            # 低于该像素数则放大
BUDGET_FACTOR = 28                       # 吸附网格（VLM patch grid 惯例）
UPSCALE_MIN_DIMENSION = 800              # 小图自适应放大目标
WHITE_BORDER_PX = 10

# 椒盐噪声检测（conditional median）：干净 UI 截图通常为 0，含噪扫描件 >0
SALT_PEPPER_SCAN_WIDTH = 512
SALT_PEPPER_DENOISE_THRESHOLD = 0.0005

# 低置信度重试
CONFIDENCE_THRESHOLD = 60
MAX_RETRY_REGIONS = 8
RETRY_UPSCALE = 3                        # 裁剪放大倍数（小 CJK 字需要 ≥35-40px 高）
RETRY_PADDING = 16

# 数字复核
DIGIT_CRITICAL_RE = re.compile(r'(\d{1,3}\.){3}\d{1,3}|https?://|:\d{2,5}(?!\d)|\d{4,}', re.I)
DIGIT_WHITELIST = '0123456789.:/-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
DIGIT_MAX_FIXES = 6
DIGIT_CONF_DROP = 5                      # 接受重读需置信度提升 >= 5

# 分块
CHUNK_HEIGHT_THRESHOLD = 3000
CHUNK_TARGET_HEIGHT = 2000
CHUNK_OVERLAP = 100

# 证据封顶（约 8K tokens，CJK≈1 token/字保守估）
MAX_EVIDENCE_CHARS = 32_000


# ---------------------------------------------------------------------------
# 图像处理工具
# ---------------------------------------------------------------------------
def smart_resize(width: int, height: int, min_pixels: int, max_pixels: int,
                 factor: int = BUDGET_FACTOR) -> tuple:
    """缩放进 [minPixels, maxPixels] 区间并吸附到 factor 整数倍（对照 smartResize）。"""
    w, h = width, height
    total = max(1, w * h)
    if total < min_pixels:
        scale = (min_pixels / total) ** 0.5
        w, h = int(w * scale), int(h * scale)
    if w * h > max_pixels:
        scale = (max_pixels / (w * h)) ** 0.5
        w, h = int(w * scale), int(h * scale)
    snap = lambda v: max(factor, round(v / factor) * factor)
    w, h = snap(w), snap(h)
    while w * h > max_pixels and (w > factor or h > factor):
        if w >= h and w > factor:
            w -= factor
        elif h > factor:
            h -= factor
        else:
            break
    return w, h


def estimate_salt_pepper_rate(img_gray: 'Image.Image') -> float:
    """椒盐噪声估计：降采样到 512 宽，统计孤立黑白点占比。"""
    try:
        small = img_gray.convert('L').resize(
            (SALT_PEPPER_SCAN_WIDTH,
             max(1, int(img_gray.height * SALT_PEPPER_SCAN_WIDTH / max(1, img_gray.width)))))
        d = np.asarray(small, dtype=np.uint8)
        h, w = d.shape
        if h < 3 or w < 3:
            return 0.0
        isolated = 0
        total = 0
        for y in range(1, h - 1):
            for x in range(1, w - 1):
                v = int(d[y, x])
                salt = v > 225
                pepper = v < 30
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if dx == 0 and dy == 0:
                            continue
                        p = int(d[y + dy, x + dx])
                        if salt and p >= 180:
                            salt = False
                        if pepper and p <= 75:
                            pepper = False
                if salt or pepper:
                    isolated += 1
                total += 1
        return isolated / max(1, total)
    except Exception:
        return 0.0


def detect_dark_mode(img: 'Image.Image') -> bool:
    """颜色统计判断深色模式：亮色占比低且平均亮度低 → 深色背景。"""
    try:
        small = img.convert('RGB').resize((64, 64))
        d = np.asarray(small, dtype=np.float32)
        r, g, b = d[..., 0], d[..., 1], d[..., 2]
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        avg = float(lum.mean())
        bright = float(((r > 230) & (g > 230) & (b > 230)).mean())
        return bright < 0.4 and avg < 115
    except Exception:
        return False


def enhance_for_ocr(img: 'Image.Image', is_dark_mode: bool) -> 'Image.Image':
    """灰度 → （深色时反色）→ 对比度拉伸 → 条件椒盐降噪 → 轻锐化。

    顺序敏感：median 必须在 normalize 之后（先拉伸对比度再做中值降噪，
    否则细笔画先被抹平、整行漏检）。干净图跳过 median（防磨掉 1px 细笔画）。
    """
    gray = img.convert('L')
    if is_dark_mode:
        gray = ImageOps.invert(gray)
    denoise = estimate_salt_pepper_rate(gray) >= SALT_PEPPER_DENOISE_THRESHOLD
    if denoise:
        gray = ImageOps.autocontrast(gray).filter(ImageFilter.MedianFilter(3))
    else:
        gray = ImageOps.autocontrast(gray)
    gray = gray.filter(ImageFilter.UnsharpMask(radius=1, percent=60, threshold=3))
    return gray


def add_white_border(img: 'Image.Image', border_px: int = WHITE_BORDER_PX) -> 'Image.Image':
    return ImageOps.expand(img.convert('RGB'), border=border_px, fill=(255, 255, 255))


def preprocess_for_ocr(img: 'Image.Image', keep_original: bool = False) -> tuple:
    """完整预处理：预算缩放（可选）→ 自适应放大 → 深色检测 → 增强 → 白边。

    返回 (bytes_img, is_dark_mode)。keep_original=True 时跳过缩放（仍增强+白边）。
    """
    if not keep_original:
        w, h = img.size
        tw, th = smart_resize(w, h, BUDGET_MIN_PIXELS, BUDGET_MAX_PIXELS)
        if (tw, th) != (w, h):
            img = img.resize((tw, th), Image.LANCZOS)
        # 小图自适应放大（最长边不足 800）
        longest = max(img.size)
        if longest < UPSCALE_MIN_DIMENSION:
            scale = UPSCALE_MIN_DIMENSION / longest
            img = img.resize((max(1, int(img.width * scale)),
                              max(1, int(img.height * scale))), Image.LANCZOS)
    is_dark = detect_dark_mode(img)
    enhanced = enhance_for_ocr(img, is_dark)
    return add_white_border(enhanced), is_dark


# ---------------------------------------------------------------------------
# OCR 主识别 + 后处理
# ---------------------------------------------------------------------------
def extract_lines(ocr_result) -> list:
    """RapidOCR 结果 → 行列表 [{text, bbox, confidence}]（bbox = [x1,y1,x2,y2] 归一化）。"""
    lines = []
    if not ocr_result:
        return lines
    for item in ocr_result:
        if len(item) < 3:
            continue
        box4, text, conf = item[0], str(item[1]), float(item[2])
        try:
            xs = [p[0] for p in box4]
            ys = [p[1] for p in box4]
            lines.append({
                'text': text.strip(),
                'bbox': [min(xs), min(ys), max(xs), max(ys)],
                'confidence': conf,
            })
        except Exception:
            continue
    return [l for l in lines if l['text']]


def apply_cjk_postprocess(text: str) -> str:
    """CJK 后处理：合并字间空格（通 知→通知）、剥离行首图标符号（含 CJK 时）。"""
    out = re.sub(r'(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])', '', text)
    if re.search(r'[\u4e00-\u9fff]', out):
        out = re.sub(r'^[^\w]+', '', out, flags=re.UNICODE)
    return out


def is_digit_critical_token(text: str) -> bool:
    return bool(DIGIT_CRITICAL_RE.search(text))


def should_accept_digit_fix(old_text, new_text, old_conf, new_conf) -> bool:
    if not new_text or new_text == old_text:
        return False
    if len(new_text) != len(old_text):
        return False
    if not re.search(r'\d', new_text):
        return False
    return new_conf >= old_conf + DIGIT_CONF_DROP


def fuse_digit_reread(old_text: str, new_text: str) -> str:
    """标点位置保留首遍字符（切分通常对），字形取置信更高的重读（127-0.0.1 融合）。"""
    if len(old_text) != len(new_text):
        return new_text
    out = []
    for a, b in zip(old_text, new_text):
        if a == b or (a in '.-:/;,' and b in '.-:/;,'):
            out.append(a)
        else:
            out.append(b)
    return ''.join(out)


# ---------------------------------------------------------------------------
# 低置信度重试 + 数字复核
# ---------------------------------------------------------------------------
def ocr_with_retry(img: 'Image.Image', engine, budget_keep_original: bool = True) -> dict:
    """首遍 OCR → 低置信度区域裁剪放大重读 → 数字复核。

    返回 { initial_lines, lines(已修正), full_text, retries, digit_fixes, confidence }
    """
    prepared, is_dark = preprocess_for_ocr(img, keep_original=budget_keep_original)
    arr = np.array(prepared)
    ocr_result, _ = engine(arr)
    initial = extract_lines(ocr_result)

    # 1) 数字复核：IP/URL/端口/长数字裁剪重读（ASCII 白名单）
    digit_fixes = _verify_digit_tokens(prepared, initial, engine)

    # 2) 低置信度行重试：裁剪 + 放大 + 重读，置信提升才替换主行
    retries = []
    regions = _low_conf_regions(initial)[:MAX_RETRY_REGIONS]
    for region, line_index in regions:
        retry = _retry_region(prepared, region, engine)
        retries.append(retry)
        if line_index is not None and line_index < len(initial):
            orig = initial[line_index]
            reread_conf = retry['confidence']
            reread_text = retry['text']
            if reread_text and reread_conf > orig['confidence'] + DIGIT_CONF_DROP:
                initial[line_index] = {
                    'text': reread_text,
                    'bbox': orig['bbox'],
                    'confidence': reread_conf,
                }

    # 3) CJK 后处理 + 全文重建
    for l in initial:
        l['text'] = apply_cjk_postprocess(l['text'])
    lines = [l for l in initial if l['text']]
    full_text = '\n'.join(l['text'] for l in lines)
    confidence = sum(l['confidence'] for l in lines) / max(1, len(lines))

    return {
        'initial_lines': initial,
        'lines': lines,
        'full_text': full_text,
        'retries': retries,
        'digit_fixes': digit_fixes,
        'confidence': round(confidence, 4),
        'is_dark_mode': is_dark,
    }


def _low_conf_regions(lines: list) -> list:
    """低置信度行排序：含 CJK/字母的文字行优先，纯符号图标行排后。"""
    TEXT_LIKE = re.compile(r'[\u4e00-\u9fff\w]', re.UNICODE)
    candidates = []
    for i, l in enumerate(lines):
        if l['confidence'] >= CONFIDENCE_THRESHOLD:
            continue
        candidates.append((l['bbox'], i, 0 if TEXT_LIKE.search(l['text']) else 1, l['confidence']))
    candidates.sort(key=lambda t: (t[2], t[3]))
    return [(c[0], c[1]) for c in candidates]


def _retry_region(img: 'Image.Image', bbox: list, engine) -> dict:
    """裁剪 bbox 区域 → 3× Lanczos 放大 → 白边 → 单区域重读。"""
    w, h = img.size
    pad = RETRY_PADDING
    left = max(0, int(bbox[0] * w) - pad)
    top = max(0, int(bbox[1] * h) - pad)
    right = min(w, int(bbox[2] * w) + pad)
    bottom = min(h, int(bbox[3] * h) + pad)
    if right <= left or bottom <= top:
        return {'text': '', 'confidence': 0}
    crop = img.crop((left, top, right, bottom))
    crop = crop.resize((max(1, crop.width * RETRY_UPSCALE),
                        max(1, crop.height * RETRY_UPSCALE)), Image.LANCZOS)
    crop = ImageOps.expand(crop.convert('RGB'), border=10, fill=(255, 255, 255))
    arr = np.array(crop)
    ocr_result, _ = engine(arr)
    lines = extract_lines(ocr_result)
    if not lines:
        return {'text': '', 'confidence': 0}
    return {
        'text': ' '.join(l['text'] for l in lines).strip(),
        'confidence': max(l['confidence'] for l in lines),
        'bbox': bbox,
    }


def _verify_digit_tokens(img: 'Image.Image', lines: list, engine, max_fixes: int = DIGIT_MAX_FIXES) -> list:
    """数字复核：对 IP/URL/端口/长数字 token 裁剪 + 白名单单行重读。"""
    fixes = []
    candidates = []
    for li, l in enumerate(lines):
        text = l['text']
        for m in re.finditer(r'\S+', text):
            token = m.group(0)
            if not is_digit_critical_token(token):
                continue
            candidates.append((li, m.start(), m.end(), token, l['confidence']))
    candidates.sort(key=lambda c: c[4])  # 低置信优先
    w, h = img.size
    for li, start, end, token, old_conf in candidates[:max_fixes]:
        # 行内 token 的近似 bbox：按字符位置在行文本中的占比估算
        line = lines[li]
        line_len = max(1, len(line['text']))
        span_start = line['bbox'][0] + (line['bbox'][2] - line['bbox'][0]) * start / line_len
        span_end = line['bbox'][0] + (line['bbox'][2] - line['bbox'][0]) * end / line_len
        if span_end <= span_start:
            continue
        bbox = [span_start, line['bbox'][1], span_end, line['bbox'][3]]
        left = max(0, int(bbox[0] * w) - 4)
        top = max(0, int(bbox[1] * h) - 4)
        right = min(w, int(bbox[2] * w) + 4)
        bottom = min(h, int(bbox[3] * h) + 4)
        if right <= left or bottom <= top:
            continue
        crop = img.crop((left, top, right, bottom))
        crop = crop.resize((max(1, crop.width * 3), max(1, crop.height * 3)), Image.LANCZOS)
        crop = ImageOps.expand(crop.convert('RGB'), border=10, fill=(255, 255, 255))
        arr = np.array(crop)
        ocr_result, _ = engine(arr)
        reread = ''.join(str(item[1]) for item in (ocr_result or []) if len(item) >= 3)
        reread = re.sub(r'\s+', '', reread)
        new_text = fuse_digit_reread(token, reread)
        new_conf = max([float(item[2]) for item in (ocr_result or []) if len(item) >= 3] or [0])
        if not should_accept_digit_fix(token, new_text, old_conf, new_conf):
            continue
        lines[li]['text'] = lines[li]['text'].replace(token, new_text, 1)
        fixes.append({
            'original': token,
            'replacement': new_text,
            'old_confidence': round(old_conf, 1),
            'new_confidence': round(new_conf, 1),
        })
    return fixes


# ---------------------------------------------------------------------------
# 超长截图分块
# ---------------------------------------------------------------------------
def plan_chunk_tops(orig_h: int, target_height: int, overlap: int) -> list:
    if overlap < 0 or overlap * 2 >= target_height:
        return [0]
    step = target_height - overlap
    tops = list(range(0, orig_h, step))
    if tops and tops[-1] + target_height < orig_h:
        tops.append(orig_h - target_height)
    return sorted(set(tops))


def chunked_ocr(img: 'Image.Image', engine) -> dict:
    """高度 > 3000px 时切块（2000 块 + 100 overlap）逐块识别合并；短图整图识别。"""
    w, h = img.size
    if h <= CHUNK_HEIGHT_THRESHOLD:
        return ocr_with_retry(img, engine)

    chunks = []
    full_texts = []
    tops = plan_chunk_tops(h, CHUNK_TARGET_HEIGHT, CHUNK_OVERLAP)
    retry_count = 0
    digit_fix_count = 0
    for idx, top in enumerate(tops):
        bottom = min(top + CHUNK_TARGET_HEIGHT, h)
        chunk = img.crop((0, top, w, bottom))
        r = ocr_with_retry(chunk, engine)
        retry_count += len(r['retries'])
        digit_fix_count += len(r['digit_fixes'])
        header = f"[第 {idx + 1}/{len(tops)} 块，y={top}-{bottom}]"
        if r['full_text']:
            full_texts.append(f"{header}\n{r['full_text']}")
        chunks.append({'index': idx + 1, 'top': top, 'bottom': bottom, 'text': r['full_text']})
    return {
        'initial_lines': [],
        'lines': [],
        'full_text': '\n\n'.join(full_texts),
        'retries': [],
        'digit_fixes': [],
        'confidence': 0,
        'chunk_count': len(chunks),
        'retry_count': retry_count,
        'digit_fix_count': digit_fix_count,
        'is_dark_mode': False,
    }


# ---------------------------------------------------------------------------
# 对外主入口
# ---------------------------------------------------------------------------
def ocr_image_enhanced(image_path: str, engine, keep_original: bool = True,
                       max_chars: int = MAX_EVIDENCE_CHARS) -> dict:
    """增强 OCR 主入口：加载 → （超长分块）→ 重试/复核 → CJK 后处理 → 证据封顶。

    keep_original=True：跳过预算缩放（截图小字不因缩放丢失），只做增强+白边。
    返回与 ocr_engine.ocr_image 兼容的 dict（含 pages/text/confidence）。
    """
    if not HAVE_PIL:
        return {'error': 'PIL 不可用（embedded python 应已含 Pillow）', 'text': '', 'confidence': 0}
    try:
        img = Image.open(image_path)
        if img.mode == 'RGBA':
            img = img.convert('RGB')
        elif img.mode not in ('RGB', 'L'):
            img = img.convert('RGB')
    except Exception as e:
        return {'error': f'图片加载失败: {e}', 'text': '', 'confidence': 0}

    try:
        r = chunked_ocr(img, engine)
        full_text = r['full_text']
        confidence = r['confidence']
        original_len = len(full_text)
        capped = False
        if original_len > max_chars:
            full_text = full_text[:max_chars] + f"\n[证据已截断：原 {original_len} 字符 > {max_chars}]"
            capped = True
        meta = {
            'text': full_text,
            'confidence': confidence,
            'box_count': len(r['lines']),
            'page_type': 'image',
            'file': str(image_path),
            'pages': [{
                'page': 1,
                'text': full_text,
                'confidence': confidence,
                'page_type': 'image',
                'ocr_used': True,
                'box_count': len(r['lines']),
            }],
            'images': [],
            'enhanced': True,
            'pipeline': 'ocr-pipeline-v1',
            'is_dark_mode': r.get('is_dark_mode', False),
            'chunk_count': r.get('chunk_count', 1),
            'retry_count': r.get('retry_count', len(r['retries'])),
            'digit_fix_count': r.get('digit_fix_count', len(r['digit_fixes'])),
            'evidence_capped': capped,
        }
        if r['digit_fixes']:
            meta['digit_fixes'] = r['digit_fixes']
        if r['retries']:
            meta['retry_regions'] = len(r['retries'])
        return meta
    except Exception as e:
        return {'error': f'增强OCR失败: {e}', 'text': '', 'confidence': 0}


# ---------------------------------------------------------------------------
# CLI（独立运行验证用）
# ---------------------------------------------------------------------------
def main():
    import argparse
    import json
    parser = argparse.ArgumentParser(description='增强OCR管线（RapidOCR）')
    parser.add_argument('--image', required=True, help='图片路径')
    parser.add_argument('--keep-original', action='store_true', help='跳过预算缩放')
    parser.add_argument('--output', default=None, help='输出JSON路径')
    args = parser.parse_args()

    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
    result = ocr_image_enhanced(args.image, engine, keep_original=args.keep_original)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.output:
        import pathlib
        pathlib.Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
