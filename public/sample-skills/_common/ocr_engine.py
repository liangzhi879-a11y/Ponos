#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ocr_engine.py - OCR引擎核心模块（基于RapidOCR）

选择RapidOCR的原因：
  - 基于ONNX Runtime推理，无Windows兼容性问题
  - 使用PaddleOCR的PP-OCRv4模型，中文识别准确率与PaddleOCR一致
  - 安装轻量（约50MB），无需PaddlePaddle框架（800MB+）
  - 无需系统Tesseract二进制

功能：
  1. 扫描件智能检测（文本层为空 OR 图片像素占比>80%）
  2. OCR文本识别（PP-OCRv4中文模型）
  3. 结果缓存（按项目隔离，MD5为key，agent可重复读取）

用法：
  python ocr_engine.py detect --file "扫描件.pdf"
  python ocr_engine.py ocr --file "扫描件.pdf" --project "2023guogao"
  python ocr_engine.py ocr --file "发票.jpg" --project "2023guogao"
  python ocr_engine.py ocr-image --file "截图.png" --project "2023guogao"
  python ocr_engine.py ocr-table --file "发票.pdf" --project "2023guogao"
  python ocr_engine.py cache-list --project "2023guogao"

设计逻辑（agent可据此自主调改）：
  detect: 用fitz提取文本+统计图片，判断是否扫描件
  ocr: 先查缓存，未命中则调用RapidOCR，结果写入 .trae/ocr_cache/{project}/{md5}.json
  如果脚本执行报错，agent应阅读本文件的设计逻辑，自主编写等效Python代码实现。
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np

COMMON_DIR = Path(__file__).parent
PROJECT_ROOT = COMMON_DIR.parent.parent.parent
CACHE_ROOT = PROJECT_ROOT / ".trae" / "ocr_cache"

OCR_RENDER_SCALE = 1.5
OCR_MAX_WORKERS = min(os.cpu_count() or 4, 8)
OCR_BACKEND_PREFERENCE = ["rapidocr_openvino", "rapidocr_onnxruntime"]


# ============================================================
# 工具函数
# ============================================================
def get_file_md5(file_path):
    """计算文件MD5（用于缓存key）"""
    h = hashlib.md5()
    with open(file_path, 'rb') as f:
        while True:
            chunk = f.read(8192)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def get_project_name(project_root=None):
    """从project_config.json读取项目名"""
    if project_root is None:
        project_root = PROJECT_ROOT
    config_path = Path(project_root) / ".trae" / "project_config.json"
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text(encoding='utf-8'))
            return config.get("project_name") or config.get("enterprise_name") or Path(project_root).name
        except Exception:
            pass
    return Path(project_root).name


def get_cache_dir(project_name):
    """获取项目缓存目录"""
    cache_dir = CACHE_ROOT / project_name
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def get_cache_path(file_md5, project_name, suffix=""):
    """获取缓存文件路径"""
    return get_cache_dir(project_name) / f"{file_md5}{suffix}.json"


def get_cache_index_path(project_name):
    """获取缓存索引文件路径"""
    return get_cache_dir(project_name) / "index.json"


# ============================================================
# OCR引擎单例（基于RapidOCR）
# ============================================================
class OCREngine:
    """RapidOCR引擎封装（单例懒加载，多后端自动切换）

    后端优先级：OpenVINO > ONNX Runtime（按OCR_BACKEND_PREFERENCE顺序）
    - rapidocr_openvino: Intel CPU OpenVINO推理，速度最快
    - rapidocr_onnxruntime: ONNX Runtime推理，兼容性最好
    """

    _instance = None
    _engine = None
    _backend = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self, lang="ch", use_angle_cls=True, dpi=None, max_workers=None):
        self.lang = lang
        self.use_angle_cls = use_angle_cls
        self.initialized = False
        self.render_scale = dpi or OCR_RENDER_SCALE
        self.max_workers = max_workers or OCR_MAX_WORKERS

    def _ensure_engine(self):
        """懒加载RapidOCR实例（按优先级尝试后端，首次3-5秒）

        后端自动切换策略：
          1. 尝试 rapidocr_openvino（Intel加速）
          2. 回退 rapidocr_onnxruntime（通用）
          3. 均已安装时优先OpenVINO
        """
        if self._engine is not None:
            return self._engine

        for backend in OCR_BACKEND_PREFERENCE:
            try:
                if backend == "rapidocr_openvino":
                    from rapidocr_openvino import RapidOCR
                    print("[ocr] 初始化RapidOCR引擎（OpenVINO后端，首次加载约3-5秒）...")
                else:
                    from rapidocr_onnxruntime import RapidOCR
                    print("[ocr] 初始化RapidOCR引擎（ONNX Runtime后端，首次加载约3-5秒）...")

                self._engine = RapidOCR()
                self._backend = backend
                self.initialized = True
                print(f"[ocr] RapidOCR引擎初始化完成（后端: {backend}）")
                return self._engine
            except ImportError:
                print(f"[ocr] {backend} 未安装，尝试下一个后端...")
                continue
            except Exception as e:
                print(f"[ocr] {backend} 初始化失败: {e}，尝试下一个后端...")
                continue

        print("[ocr] ERROR: 无可用的RapidOCR后端")
        print("[ocr] 安装: pip install rapidocr-openvino (推荐) 或 pip install rapidocr-onnxruntime")
        return None

    def warm_up(self):
        """预热OCR引擎（后台预初始化，消除首次调用延迟）"""
        import threading

        def _warm():
            print("[ocr] 后台预热OCR引擎...")
            self._ensure_engine()

        t = threading.Thread(target=_warm, daemon=True)
        t.start()
        return t

    # --------------------------------------------------------
    # 扫描件检测（逐页）
    # --------------------------------------------------------
    def detect_scanned_pdf(self, pdf_path):
        """检测PDF是否为扫描件（智能判定，含混合型PDF）

        判定规则（任一满足即为扫描件）：
          1. 文本层字符数 < 50（每页平均<10字符）
          2. 图片像素占比 > 80%
          3. **逐页检测发现任一扫描页**（混合型 PDF 的关键修复，v2026-07-22）
          4. （外部）--force-ocr 强制

        v2026-07-22 修复：先串联 detect_pages_by_type 逐页检测，
        只要存在扫描页就标记为扫描件，避免混合型PDF被误判为非扫描件。
        """
        try:
            import fitz
        except ImportError:
            return {"is_scanned": False, "reason": "PyMuPDF不可用，无法检测", "text_chars": -1, "image_ratio": -1, "page_count": -1}

        try:
            doc = fitz.open(pdf_path)
            total_text_chars = 0
            total_image_area = 0
            total_page_area = 0
            page_count = len(doc)

            for page in doc:
                text = page.get_text()
                total_text_chars += len(text.strip())

                page_area = page.rect.width * page.rect.height
                total_page_area += page_area
                try:
                    for block in page.get_text("dict")["blocks"]:
                        if block.get("type") == 1:  # image block
                            bbox = block.get("bbox", [0, 0, 0, 0])
                            img_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
                            total_image_area += img_area
                except Exception:
                    continue

            doc.close()

            avg_text_per_page = total_text_chars / max(page_count, 1)
            image_ratio = total_image_area / max(total_page_area, 1)

            is_scanned = False
            reason = ""
            page_info = None

            # 先做整体判定
            if total_text_chars < 50:
                is_scanned = True
                reason = f"文本层字符数过少（{total_text_chars}字符，平均{avg_text_per_page:.1f}/页）"
            elif image_ratio > 0.8:
                is_scanned = True
                reason = f"图片占比过高（{image_ratio*100:.1f}%）"

            # v2026-07-22 关键修复：整体判定未命中时，串联逐页检测
            # 解决混合型 PDF 被误判为非扫描件的问题
            if not is_scanned:
                page_info = self.detect_pages_by_type(pdf_path)
                if page_info["scan_page_count"] > 0:
                    is_scanned = True
                    reason = (
                        f"检测到扫描页（{page_info['scan_page_count']}/{page_info['total_pages']}页为扫描件，"
                        f"混合型PDF，已联动 detect_pages_by_type 标记为扫描件）"
                    )

            result = {
                "is_scanned": is_scanned,
                "reason": reason or "文本层正常，非扫描件",
                "text_chars": total_text_chars,
                "image_ratio": round(image_ratio, 4),
                "page_count": page_count,
                "avg_text_per_page": round(avg_text_per_page, 1),
            }

            if page_info is not None:
                result["page_analysis"] = {
                    "text_page_count": page_info["text_page_count"],
                    "scan_page_count": page_info["scan_page_count"],
                    "empty_page_count": page_info["empty_page_count"],
                    "is_mixed": page_info["is_mixed"],
                }

            return result
        except Exception as e:
            return {"is_scanned": False, "reason": f"检测异常: {e}", "text_chars": -1, "image_ratio": -1, "page_count": -1}

    def detect_pages_by_type(self, pdf_path):
        """逐页检测PDF页面类型（处理混合型PDF）

        返回：
            {
                "page_types": [{"page": 1, "type": "text"|"scan"|"empty", "char_count": N, "image_count": N}],
                "text_page_count": N,
                "scan_page_count": N,
                "empty_page_count": N,
                "is_mixed": bool,  # 是否混合型
            }
        """
        try:
            import fitz
        except ImportError:
            return {"page_types": [], "text_page_count": 0, "scan_page_count": 0, "empty_page_count": 0, "is_mixed": False}

        doc = fitz.open(pdf_path)
        page_types = []
        text_count = 0
        scan_count = 0
        empty_count = 0

        for i, page in enumerate(doc):
            text = page.get_text()
            char_count = len(text.strip())
            image_count = len(page.get_images())

            if char_count < 10:
                if image_count > 0:
                    page_type = "scan"
                    scan_count += 1
                else:
                    page_type = "empty"
                    empty_count += 1
            elif char_count < 100 and image_count > 0:
                page_type = "scan"  # 少文本+有图，疑似扫描件
                scan_count += 1
            else:
                page_type = "text"
                text_count += 1

            page_types.append({
                "page": i + 1,
                "type": page_type,
                "char_count": char_count,
                "image_count": image_count,
            })

        doc.close()

        # 判定是否混合型：同时存在文本页和扫描件页
        is_mixed = text_count > 0 and scan_count > 0

        return {
            "page_types": page_types,
            "text_page_count": text_count,
            "scan_page_count": scan_count,
            "empty_page_count": empty_count,
            "is_mixed": is_mixed,
            "total_pages": len(page_types),
        }

    # --------------------------------------------------------
    # OCR识别（含缓存）- 支持逐页混合处理
    # --------------------------------------------------------
    def ocr_pdf(self, pdf_path, force_ocr=False, use_cache=True, project_name="default",
                parallel=True):
        """对PDF执行OCR识别（支持混合型PDF逐页处理 + 并行加速 + 页面级缓存）

        混合处理策略：
          1. 逐页检测页面类型（text/scan/empty）
          2. text页：用fitz直接提取文本层（快速、100%准确）
          3. scan页：用RapidOCR识别（扫描件必须OCR），支持多线程并行
          4. empty页：跳过
          5. force_ocr=True时：所有页都用OCR

        参数：
            pdf_path: PDF文件路径
            force_ocr: 强制OCR（所有页面都OCR，跳过文本层）
            use_cache: 是否使用缓存
            project_name: 项目名（用于缓存隔离）
            parallel: 是否对扫描件页启用多线程并行处理
        """
        start_time = time.time()
        file_path = str(pdf_path)

        file_md5 = get_file_md5(file_path)

        page_info = self.detect_pages_by_type(file_path)
        total_pages = page_info["total_pages"]
        text_pages = page_info["text_page_count"]
        scan_pages = page_info["scan_page_count"]
        empty_pages = page_info["empty_page_count"]

        print(f"[ocr] PDF页面分析: 共{total_pages}页（文本页{text_pages} + 扫描件页{scan_pages} + 空白页{empty_pages}）")

        if force_ocr:
            strategy = "force_ocr"
        elif scan_pages == 0:
            strategy = "text_only"
        elif text_pages == 0:
            strategy = "ocr_only"
        else:
            strategy = "mixed"

        print(f"[ocr] 模式: {strategy} | Scale: {self.render_scale}x | 并行: {parallel}")

        # 全量缓存检查（force_ocr模式下也检查，因为策略固定）
        cache_strategy_key = strategy if force_ocr else "auto"
        if use_cache:
            full_cache = self._get_full_cache(file_md5, project_name, cache_strategy_key)
            if full_cache:
                full_cache["cache_hit"] = True
                print(f"[ocr] 命中完整缓存: {file_md5}")
                return full_cache

        # 初始化OCR引擎（仅在有扫描件页或force_ocr时）
        engine = None
        if strategy in ("force_ocr", "ocr_only", "mixed"):
            engine = self._ensure_engine()
            if engine is None:
                return {
                    "file_md5": file_md5,
                    "original_path": file_path,
                    "project_name": project_name,
                    "ocr_engine": "none",
                    "is_scanned": scan_pages > 0,
                    "detection": page_info,
                    "pages": [],
                    "text": "",
                    "error": "RapidOCR不可用",
                    "cache_hit": False,
                    "processing_time_seconds": round(time.time() - start_time, 2),
                }

        # 逐页处理（页面级缓存 + 并行）
        pages = self._process_pdf_pages(
            file_path, page_info, engine, strategy,
            use_cache=use_cache, project_name=project_name,
            parallel=parallel and scan_pages > 1
        )

        full_text = "\n".join(p.get("text", "") for p in pages)

        result = {
            "file_md5": file_md5,
            "original_path": file_path,
            "project_name": project_name,
            "ocr_at": datetime.now().isoformat(),
            "ocr_engine": f"rapidocr({self._backend})+fitz" if strategy == "mixed" else (
                f"rapidocr({self._backend})" if strategy in ("force_ocr", "ocr_only") else "fitz"),
            "ocr_model": f"PP-OCRv4 (via {self._backend})" if engine else "fitz text layer",
            "is_scanned": scan_pages > 0,
            "is_mixed": page_info["is_mixed"],
            "detection": page_info,
            "strategy": strategy,
            "pages": pages,
            "text": full_text,
            "cache_hit": False,
            "processing_time_seconds": round(time.time() - start_time, 2),
            "page_stats": {
                "total": total_pages,
                "text_pages": text_pages,
                "scan_pages_ocr": sum(1 for p in pages if p.get("ocr_used")),
                "empty_pages": empty_pages,
            },
        }

        if use_cache:
            self._save_full_cache(file_md5, project_name, cache_strategy_key, result)

        print(f"[ocr] 处理完成，耗时: {result['processing_time_seconds']:.1f}秒")
        return result

    def _process_pdf_pages(self, pdf_path, page_info, engine, strategy,
                           use_cache=True, project_name="default", parallel=False):
        """逐页处理PDF（预渲染 + 页面级缓存 + 多线程并行OCR）

        优化要点：
          - 主线程一次打开PDF预渲染所有扫描页为numpy数组（避免每线程重复fitz.open）
          - 渲染DPI=1.5（减少44%像素量）+ 灰度化（减少75%数据量）
          - pix.samples直接构造numpy数组（消除PNG编解码开销）
          - ThreadPoolExecutor并行OCR预渲染数组
          - 页面级缓存：单页命中则跳过渲染+OCR
        """
        pages = [None] * page_info["total_pages"]
        page_types = page_info["page_types"]
        scan_requests = []
        rendered_images = {}

        file_md5 = get_file_md5(pdf_path) if use_cache else None

        try:
            import fitz
            doc = fitz.open(pdf_path)

            for i, page in enumerate(doc):
                page_num = i + 1
                page_type = page_types[i]["type"] if i < len(page_types) else "text"

                use_ocr = (strategy == "force_ocr") or (strategy == "ocr_only") or \
                          (strategy == "mixed" and page_type == "scan")

                if not use_ocr:
                    text = page.get_text()
                    pages[i] = {
                        "page": page_num,
                        "text": text,
                        "confidence": 1.0,
                        "page_type": page_type,
                        "ocr_used": False,
                    }
                    continue

                if page_type == "empty" and strategy != "force_ocr":
                    pages[i] = {
                        "page": page_num,
                        "text": "",
                        "confidence": 0,
                        "page_type": "empty",
                        "ocr_used": False,
                    }
                    continue

                if use_cache and file_md5:
                    page_cache = self._get_page_cache(file_md5, project_name, page_num, strategy)
                    if page_cache is not None:
                        pages[i] = page_cache
                        continue

                mat = fitz.Matrix(self.render_scale, self.render_scale)
                pix = page.get_pixmap(matrix=mat, colorspace=fitz.csGRAY)

                img_array = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                    pix.height, pix.width, pix.n
                )
                if pix.n == 1:
                    img_array = np.repeat(img_array, 3, axis=2)

                rendered_images[i] = img_array
                scan_requests.append(i)

            doc.close()

        except Exception as e:
            print(f"[ocr] PDF预渲染失败: {e}")
            for i in range(len(pages)):
                if pages[i] is None:
                    pages[i] = {
                        "page": i + 1,
                        "text": "",
                        "confidence": 0,
                        "page_type": "error",
                        "ocr_used": False,
                        "error": str(e),
                    }
            return pages

        if not scan_requests:
            assert all(p is not None for p in pages)
            return pages

        if parallel and len(scan_requests) > 1:
            pages = self._ocr_pages_parallel(
                pages, scan_requests, rendered_images,
                file_md5, project_name, strategy, use_cache
            )
        else:
            pages = self._ocr_pages_sequential(
                pages, scan_requests, rendered_images,
                file_md5, project_name, strategy, use_cache
            )

        return pages

    def _ocr_single_image(self, img_array, engine):
        """OCR单页预渲染图像（纯OCR推理，不再打开PDF）

        输入为已渲染的numpy数组（灰度→RGB 3通道），输出OCR文本+置信度。
        """
        try:
            ocr_result, elapsed = engine(img_array)

            page_text = []
            total_conf = 0
            box_count = 0
            if ocr_result:
                for item in ocr_result:
                    if len(item) >= 3:
                        page_text.append(str(item[1]))
                        total_conf += float(item[2])
                        box_count += 1

            avg_conf = total_conf / box_count if box_count > 0 else 0
            return {
                "text": "\n".join(page_text),
                "confidence": round(avg_conf, 4),
                "box_count": box_count,
                "page_type": "scan",
                "ocr_used": True,
            }
        except Exception as e:
            return {
                "text": "",
                "confidence": 0,
                "page_type": "scan",
                "ocr_used": True,
                "error": str(e),
            }

    def _ocr_pages_sequential(self, pages, scan_indices, rendered_images,
                               file_md5, project_name, strategy, use_cache):
        """串行OCR预渲染图像"""
        engine = self._ensure_engine()
        for idx in scan_indices:
            page_num = idx + 1
            img_array = rendered_images[idx]
            result = self._ocr_single_image(img_array, engine)
            result["page"] = page_num
            pages[idx] = result
            if use_cache and file_md5:
                self._save_page_cache(file_md5, project_name, page_num, strategy, result)
        return pages

    def _ocr_pages_parallel(self, pages, scan_indices, rendered_images,
                             file_md5, project_name, strategy, use_cache):
        """多线程并行OCR预渲染图像"""
        engine = self._ensure_engine()
        workers = min(self.max_workers, len(scan_indices))

        print(f"[ocr] 并行处理 {len(scan_indices)} 页扫描件（{workers}线程）...")

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {}
            for idx in scan_indices:
                page_num = idx + 1
                img_array = rendered_images[idx]
                future = executor.submit(self._ocr_single_image, img_array, engine)
                futures[future] = (idx, page_num)

            for future in as_completed(futures):
                idx, page_num = futures[future]
                try:
                    result = future.result()
                except Exception as e:
                    result = {
                        "text": "",
                        "confidence": 0,
                        "page_type": "scan",
                        "ocr_used": True,
                        "error": str(e),
                    }
                result["page"] = page_num
                pages[idx] = result

                if use_cache and file_md5:
                    self._save_page_cache(file_md5, project_name, page_num, strategy, result)

        return pages

    # --------------------------------------------------------
    # 表格识别（基于OCR结果+正则，无需PP-Structure）
    # --------------------------------------------------------
    def ocr_with_table(self, pdf_path, project_name="default"):
        """对PDF执行OCR识别+表格区域识别

        RapidOCR本身不做表格结构识别，但能识别表格内的文字。
        本函数通过OCR所有文字后，用正则识别表格行（连续的多列数据）。
        """
        # 先执行普通OCR（命中缓存）
        base_result = self.ocr_pdf(pdf_path, project_name=project_name)

        # 从OCR文本中尝试识别表格行
        tables = []
        try:
            for page_info in base_result.get("pages", []):
                page_text = page_info.get("text", "")
                page_num = page_info.get("page", 1)
                # 简单表格识别：连续多列数字的行视为表格行
                table_rows = self._detect_table_rows_from_text(page_text)
                if table_rows:
                    tables.append({
                        "page": page_num,
                        "table_index": 0,
                        "data": table_rows,
                    })
        except Exception as e:
            print(f"[ocr] 表格识别失败: {e}")

        base_result["tables"] = tables
        return base_result

    def _detect_table_rows_from_text(self, text):
        """从OCR文本中识别表格行（启发式：多个数字/金额列的行）"""
        rows = []
        for line in text.split("\n"):
            # 含2个以上数字/金额的行视为表格行
            numbers = re.findall(r'\d+\.?\d*', line)
            if len(numbers) >= 2:
                # 按空格/制表符分割
                cells = re.split(r'\s+', line.strip())
                cells = [c for c in cells if c]
                if len(cells) >= 2:
                    rows.append(cells)
        return rows

    def ocr_page(self, pdf_path, page_index, project_name="default"):
        """对 PDF 单页执行 OCR 识别（优化版：统一1.5x灰度渲染，消PNG编解码）

        用于混合型 PDF 的逐页 OCR 处理（_read_pdf_mixed 调用）。

        优化：与 _ocr_single_page 统一渲染参数，消除 PNG 编解码往返开销。
        """
        try:
            import fitz
        except ImportError:
            return {"text": "", "confidence": 0, "page": page_index + 1, "error": "PyMuPDF未安装"}

        path = Path(pdf_path)
        if not path.exists():
            return {"text": "", "confidence": 0, "page": page_index + 1, "error": f"PDF不存在: {pdf_path}"}

        engine = self._ensure_engine()
        if engine is None:
            return {"text": "", "confidence": 0, "page": page_index + 1, "error": "OCR引擎不可用"}

        try:
            doc = fitz.open(pdf_path)
            if page_index < 0 or page_index >= len(doc):
                doc.close()
                return {"text": "", "confidence": 0, "page": page_index + 1, "error": f"页面索引越界: {page_index}/{len(doc)}"}

            page_num = page_index + 1
            page = doc[page_index]

            mat = fitz.Matrix(self.render_scale, self.render_scale)
            pix = page.get_pixmap(matrix=mat, colorspace=fitz.csGRAY)
            doc.close()

            img_array = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, pix.n
            )
            if pix.n == 1:
                img_array = np.repeat(img_array, 3, axis=2)

            ocr_result, elapsed = engine(img_array)

            page_text = []
            total_conf = 0
            box_count = 0
            if ocr_result:
                for item in ocr_result:
                    if len(item) >= 3:
                        page_text.append(str(item[1]))
                        total_conf += float(item[2])
                        box_count += 1

            avg_conf = total_conf / box_count if box_count > 0 else 0
            return {
                "text": "\n".join(page_text),
                "confidence": round(avg_conf, 4),
                "page": page_num,
            }
        except Exception as e:
            return {"text": "", "confidence": 0, "page": page_index + 1, "error": str(e)}

    def ocr_image(self, image_path, project_name="default"):
        """对单张图片（PNG/JPG/JPEG）执行 OCR 识别（优化版）

        Args:
            image_path: 图片文件路径
            project_name: 项目名（用于缓存隔离）

        Returns:
            dict: {"text": str, "confidence": float, "page_type": "image", "pages": [...]}
        """
        import hashlib

        path = Path(image_path)
        if not path.exists():
            return {"text": "", "confidence": 0, "error": f"文件不存在: {image_path}"}

        file_md5 = hashlib.md5(path.read_bytes()).hexdigest()

        cached = self._get_full_cache(file_md5, project_name, "image")
        if cached:
            cached["cache_hit"] = True
            return cached

        try:
            from PIL import Image
            pil_img = Image.open(str(path))
            if pil_img.mode == 'RGBA':
                pil_img = pil_img.convert('RGB')
            if pil_img.mode != 'L':
                pil_img = pil_img.convert('L')
            img_array = np.array(pil_img)
            if img_array.ndim == 2:
                img_array = np.repeat(img_array[:, :, np.newaxis], 3, axis=2)
        except Exception as e:
            return {"text": "", "confidence": 0, "error": f"图片加载失败: {e}"}

        engine = self._ensure_engine()
        try:
            ocr_result, elapsed = engine(img_array)
            lines = []
            total_conf = 0
            box_count = 0
            if ocr_result:
                for item in ocr_result:
                    if len(item) >= 3:
                        lines.append(str(item[1]))
                        total_conf += float(item[2])
                        box_count += 1
            avg_conf = total_conf / box_count if box_count > 0 else 0
        except Exception as e:
            return {"text": "", "confidence": 0, "error": f"OCR失败: {e}"}

        result = {
            "text": "\n".join(lines),
            "confidence": round(avg_conf, 4),
            "box_count": box_count,
            "page_type": "image",
            "file": str(path),
            "pages": [{
                "page": 1,
                "text": "\n".join(lines),
                "confidence": round(avg_conf, 4),
                "page_type": "image",
                "ocr_used": True,
                "box_count": box_count,
            }],
            "images": [],
        }

        self._save_full_cache(file_md5, project_name, "image", result)
        return result

    # --------------------------------------------------------
    # 缓存读写（全量缓存 + 页面级缓存 + 索引管理）
    # --------------------------------------------------------
    def _get_full_cache(self, file_md5, project_name, strategy_key="auto"):
        """读取完整PDF缓存（按策略key区分）"""
        cache_path = get_cache_path(file_md5, project_name, suffix=f".{strategy_key}")
        if cache_path.exists():
            try:
                return json.loads(cache_path.read_text(encoding='utf-8'))
            except Exception:
                return None
        return None

    def _save_full_cache(self, file_md5, project_name, strategy_key, result):
        """写入完整PDF缓存并更新索引"""
        cache_path = get_cache_path(file_md5, project_name, suffix=f".{strategy_key}")
        try:
            cache_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            self._update_cache_index(file_md5, project_name, result)
            print(f"[ocr] 完整缓存已保存: {cache_path}")
        except Exception as e:
            print(f"[ocr] 完整缓存写入失败: {e}")

    def _get_page_cache(self, file_md5, project_name, page_num, strategy):
        """读取单页缓存"""
        page_key = f"{file_md5}_{page_num}_{strategy}"
        cache_path = get_cache_path(page_key, project_name, suffix=".page")
        if cache_path.exists():
            try:
                return json.loads(cache_path.read_text(encoding='utf-8'))
            except Exception:
                return None
        return None

    def _save_page_cache(self, file_md5, project_name, page_num, strategy, result):
        """写入单页缓存"""
        page_key = f"{file_md5}_{page_num}_{strategy}"
        cache_path = get_cache_path(page_key, project_name, suffix=".page")
        try:
            cache_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        except Exception:
            pass

    def _update_cache_index(self, file_md5, project_name, result):
        """更新缓存索引"""
        index_path = get_cache_index_path(project_name)
        try:
            if index_path.exists():
                index = json.loads(index_path.read_text(encoding='utf-8'))
            else:
                index = {"entries": {}}

            index["entries"][file_md5] = {
                "original_path": result.get("original_path", ""),
                "ocr_at": result.get("ocr_at", ""),
                "ocr_engine": result.get("ocr_engine", ""),
                "is_scanned": result.get("is_scanned", False),
                "page_count": len(result.get("pages", [])),
                "table_count": len(result.get("tables", [])),
            }
            index["last_updated"] = datetime.now().isoformat()
            index["total_entries"] = len(index["entries"])

            index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding='utf-8')
        except Exception as e:
            print(f"[ocr] 索引更新失败: {e}")


# ============================================================
# 模块级便捷函数
# ============================================================
_engine_instance = None

def get_engine():
    """获取OCR引擎单例"""
    global _engine_instance
    if _engine_instance is None:
        _engine_instance = OCREngine()
    return _engine_instance


def detect_scanned_pdf(pdf_path):
    """便捷函数：检测扫描件"""
    return get_engine().detect_scanned_pdf(pdf_path)


def ocr_pdf(pdf_path, force_ocr=False, use_cache=True, project_name="default"):
    """便捷函数：OCR识别"""
    return get_engine().ocr_pdf(pdf_path, force_ocr, use_cache, project_name)


def ocr_with_table(pdf_path, project_name="default"):
    """便捷函数：含表格识别的OCR（PDF）"""
    return get_engine().ocr_with_table(pdf_path, project_name)


def ocr_image(image_path, project_name="default"):
    """便捷函数：OCR识别单张图片（PNG/JPG/JPEG）"""
    return get_engine().ocr_image(image_path, project_name)


def warm_up_ocr():
    """便捷函数：后台预热OCR引擎（消除首次调用延迟）"""
    return get_engine().warm_up()


# ============================================================
# 命令行入口
# ============================================================
def cmd_detect(args):
    """检测是否扫描件"""
    info = detect_scanned_pdf(args.file)
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return True


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".gif", ".webp"}


def is_image_file(file_path):
    """判断文件是否为支持的图片格式"""
    return Path(file_path).suffix.lower() in IMAGE_EXTENSIONS


def cmd_ocr(args):
    """执行OCR识别（图片自动分流到图片引擎）"""
    if is_image_file(args.file):
        result = ocr_image(args.file, project_name=args.project)
        result["force_ocr"] = args.force_ocr
        result["cache_hit"] = result.get("cache_hit", False)
        result["is_scanned"] = True
        result["detection"] = {"reason": "图片文件，直接OCR", "method": "image"}
        print(f"\n[ocr] 文件: {args.file}")
    else:
        result = ocr_pdf(args.file, force_ocr=args.force_ocr, use_cache=not args.no_cache, project_name=args.project)
        print(f"\n[ocr] 文件: {args.file}")
    print(f"[ocr] 扫描件: {result.get('is_scanned', False)}")
    print(f"[ocr] 检测: {result.get('detection', {}).get('reason', '')}")
    print(f"[ocr] 页数: {len(result.get('pages', []))}")
    print(f"[ocr] 缓存命中: {result.get('cache_hit', False)}")
    print(f"[ocr] 耗时: {result.get('processing_time_seconds', 0)}秒")
    if result.get("text"):
        preview = result["text"][:500] + "..." if len(result["text"]) > 500 else result["text"]
        print(f"[ocr] 文本预览:\n{preview}")
    if args.output:
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f"[ocr] 完整结果已保存: {args.output}")
    return True


def cmd_ocr_image(args):
    """执行单张图片OCR识别"""
    if not is_image_file(args.file):
        print(json.dumps({"error": f"不支持的图片格式: {args.file}", "text": "", "confidence": 0}, ensure_ascii=False))
        return True
    result = ocr_image(args.file, project_name=args.project)
    print(f"\n[ocr-image] 文件: {args.file}")
    print(f"[ocr-image] 缓存命中: {result.get('cache_hit', False)}")
    print(f"[ocr-image] 置信度: {result.get('confidence', 0)}")
    if result.get("text"):
        preview = result["text"][:500] + "..." if len(result["text"]) > 500 else result["text"]
        print(f"[ocr-image] 文本预览:\n{preview}")
    if args.output:
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f"[ocr-image] 完整结果已保存: {args.output}")
    return True


def cmd_ocr_table(args):
    """执行表格识别"""
    result = ocr_with_table(args.file, project_name=args.project)
    print(f"\n[ocr-table] 文件: {args.file}")
    print(f"[ocr-table] 表格数: {len(result.get('tables', []))}")
    for i, t in enumerate(result.get("tables", [])):
        print(f"  表格{i+1} (第{t['page']}页): {len(t.get('data', []))}行")
    if args.output:
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f"[ocr-table] 完整结果已保存: {args.output}")
    return True


def cmd_cache_list(args):
    """列出缓存"""
    cache_dir = CACHE_ROOT / args.project
    if not cache_dir.exists():
        print(f"[cache-list] 项目 {args.project} 无缓存")
        return True
    index_path = cache_dir / "index.json"
    if not index_path.exists():
        print(f"[cache-list] 项目 {args.project} 无索引")
        return True
    index = json.loads(index_path.read_text(encoding='utf-8'))
    print(f"\n[cache-list] 项目: {args.project}")
    print(f"[cache-list] 缓存条目: {index.get('total_entries', 0)}")
    print(f"[cache-list] 最后更新: {index.get('last_updated', '')}")
    print()
    for md5, info in index.get("entries", {}).items():
        print(f"  {md5[:16]}... | {info.get('original_path', '')[:50]}")
        print(f"    扫描件: {info.get('is_scanned')} | 页数: {info.get('page_count')} | 表格: {info.get('table_count')}")
    return True


def main():
    parser = argparse.ArgumentParser(
        description='OCR引擎核心模块（基于RapidOCR + ONNX Runtime）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
示例：
  python ocr_engine.py detect --file "扫描件.pdf"
  python ocr_engine.py ocr --file "发票.pdf" --project "2023guogao"
  python ocr_engine.py ocr --file "合同.pdf" --force-ocr --output result.json
  python ocr_engine.py ocr-table --file "发票.pdf" --project "2023guogao"
  python ocr_engine.py cache-list --project "2023guogao"

引擎说明：
  RapidOCR基于PaddleOCR PP-OCRv4模型，但使用ONNX Runtime推理。
  优势：无Windows兼容性问题、安装轻量（约50MB）、无需PaddlePaddle框架。
        ''',
    )
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    det_parser = subparsers.add_parser("detect", help="检测PDF是否为扫描件")
    det_parser.add_argument("--file", required=True, help="PDF文件路径")

    ocr_parser = subparsers.add_parser("ocr", help="OCR识别PDF")
    ocr_parser.add_argument("--file", required=True, help="PDF文件路径")
    ocr_parser.add_argument("--project", default="default", help="项目名（用于缓存隔离）")
    ocr_parser.add_argument("--force-ocr", action="store_true", help="强制OCR（跳过文本层）")
    ocr_parser.add_argument("--no-cache", action="store_true", help="不使用缓存")
    ocr_parser.add_argument("--output", default=None, help="输出JSON文件路径")

    ocr_img_parser = subparsers.add_parser("ocr-image", help="OCR识别单张图片（PNG/JPG/JPEG/TIFF等）")
    ocr_img_parser.add_argument("--file", required=True, help="图片文件路径")
    ocr_img_parser.add_argument("--project", default="default", help="项目名（用于缓存隔离）")
    ocr_img_parser.add_argument("--output", default=None, help="输出JSON文件路径")

    ocr_t_parser = subparsers.add_parser("ocr-table", help="表格识别")
    ocr_t_parser.add_argument("--file", required=True, help="PDF文件路径")
    ocr_t_parser.add_argument("--project", default="default", help="项目名")
    ocr_t_parser.add_argument("--output", default=None, help="输出JSON文件路径")

    cl_parser = subparsers.add_parser("cache-list", help="列出缓存")
    cl_parser.add_argument("--project", default="default", help="项目名")

    args = parser.parse_args()

    if args.command == "detect":
        success = cmd_detect(args)
    elif args.command == "ocr":
        success = cmd_ocr(args)
    elif args.command == "ocr-image":
        success = cmd_ocr_image(args)
    elif args.command == "ocr-table":
        success = cmd_ocr_table(args)
    elif args.command == "cache-list":
        success = cmd_cache_list(args)
    else:
        parser.print_help()
        success = False

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
