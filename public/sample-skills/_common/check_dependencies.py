#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_dependencies.py - gxtz技能系统依赖环境检查

用途：agent 启动前调用此脚本，确认所有必需库已安装，避免运行时才发现缺失。

用法：
  python check_dependencies.py                    # 检查所有依赖
  python check_dependencies.py --fix               # 检查并尝试安装缺失依赖
  python check_dependencies.py --json              # 输出JSON格式（供agent解析）
  python check_dependencies.py --skill gxtz-core-tables  # 仅检查某技能所需依赖

退出码：
  0 = 所有必需依赖已安装
  1 = 有必需依赖缺失
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

COMMON_DIR = Path(__file__).parent
REQUIREMENTS_FILE = COMMON_DIR / "requirements.txt"
TECH_STACK_FILE = COMMON_DIR / "tech_stack.json"


# ============================================================
# 依赖清单（与 requirements.txt 对应）
# ============================================================
# 格式: import_name -> {pip_package, required, category, used_by}
DEPENDENCIES = {
    # 核心文档处理（必需）
    "openpyxl": {
        "pip_package": "openpyxl",
        "required": True,
        "category": "核心文档处理",
        "used_by": "generate_tables_from_template.py, validate_tables.py, invoice_ps_matcher.py, audit_report_verifier.py",
        "handles": ".xlsx 读写",
    },
    "docx": {
        "pip_package": "python-docx",
        "required": True,
        "category": "核心文档处理",
        "used_by": "generate_checklist.py, audit_report_verifier.py, compare_docx.py",
        "handles": ".docx 读写",
    },
    "PyPDF2": {
        "pip_package": "PyPDF2",
        "required": True,
        "category": "核心文档处理",
        "used_by": "pdf_splitter.py",
        "handles": "PDF 拆分/合并",
    },
    "pdfplumber": {
        "pip_package": "pdfplumber",
        "required": True,
        "category": "核心文档处理",
        "used_by": "pdf_splitter.py",
        "handles": "PDF 文本/表格提取",
    },
    "fitz": {
        "pip_package": "PyMuPDF",
        "required": True,
        "category": "核心文档处理",
        "used_by": "invoice_ps_matcher.py",
        "handles": "PDF 高效读取（申请书解析）",
    },
    "PIL": {
        "pip_package": "Pillow",
        "required": True,
        "category": "核心文档处理",
        "used_by": "pdf_splitter.py",
        "handles": "图像提取",
    },

    # 网络与API（必需）
    "requests": {
        "pip_package": "requests",
        "required": True,
        "category": "网络与API",
        "used_by": "dify_workflow.py, cross_model_validator.py",
        "handles": "HTTP 请求（Dify/MiniMax）",
    },

    # 企微解密（gxtz-wecom-collector专用）
    "Crypto": {
        "pip_package": "pycryptodome",
        "required": True,
        "category": "企微解密",
        "used_by": "wecom_crypto.py",
        "handles": "AES-128-CBC 解密",
    },

    # OCR识别（必需，用于扫描件PDF）
    "rapidocr_onnxruntime": {
        "pip_package": "rapidocr-onnxruntime",
        "required": True,
        "category": "OCR识别",
        "used_by": "ocr_engine.py, contract_invoice_extractor.py",
        "handles": "扫描件PDF OCR识别（中文，PP-OCRv4 via ONNX Runtime）",
    },
    "rapidocr_openvino": {
        "pip_package": "rapidocr-openvino",
        "required": False,
        "category": "OCR识别 [推荐]",
        "used_by": "ocr_engine.py（优选后端）",
        "handles": "Intel CPU OpenVINO加速，比ONNX Runtime快30-50%",
    },
    "onnxruntime": {
        "pip_package": "onnxruntime",
        "required": True,
        "category": "OCR识别",
        "used_by": "ocr_engine.py（RapidOCR依赖）",
        "handles": "ONNX推理引擎",
    },
    "cv2": {
        "pip_package": "opencv-python",
        "required": True,
        "category": "OCR识别",
        "used_by": "ocr_engine.py（RapidOCR依赖）",
        "handles": "图像处理",
    },
    "pdf2image": {
        "pip_package": "pdf2image",
        "required": True,
        "category": "OCR识别",
        "used_by": "ocr_engine.py（扫描件检测辅助）",
        "handles": "PDF转图片（需系统安装poppler）",
    },

    # 增强功能（可选）
    "jieba": {
        "pip_package": "jieba",
        "required": False,
        "category": "增强功能",
        "used_by": "invoice_ps_matcher.py",
        "handles": "中文分词（发票匹配优化）",
    },
    "portalocker": {
        "pip_package": "portalocker",
        "required": False,
        "category": "增强功能",
        "used_by": "file_lock.py",
        "handles": "跨进程文件锁（缺失时回退msvcrt）",
    },
    "pytesseract": {
        "pip_package": "pytesseract",
        "required": False,
        "category": "OCR降级备用",
        "used_by": "pdf_splitter.py（RapidOCR不可用时降级）",
        "handles": "Tesseract OCR（需系统安装Tesseract-OCR）",
    },

    # Windows 专用
    "win32com": {
        "pip_package": "pywin32",
        "required": "windows",
        "category": "Windows专用",
        "used_by": "audit_report_verifier.py",
        "handles": ".doc→.docx 转换",
    },
    "xlrd": {
        "pip_package": "xlrd",
        "required": False,
        "category": "Windows专用",
        "used_by": "audit_report_verifier.py（声明但未实际使用）",
        "handles": "旧版 .xls 读取",
    },
}

# 技能→依赖映射（用于 --skill 参数）
SKILL_DEPENDENCIES = {
    "gxtz-core-tables": ["openpyxl"],
    "gxtz-info-collector": ["openpyxl", "docx"],
    "gxtz-rd-report": ["docx", "openpyxl", "requests", "rapidocr_onnxruntime"],
    "gxtz-ip-materials": ["rapidocr_onnxruntime"],
    "gxtz-achievement-materials": ["openpyxl", "rapidocr_onnxruntime"],
    "gxtz-staff-materials": ["openpyxl"],
    "gxtz-ps-materials": ["openpyxl"],
    "gxtz-management-materials": ["docx"],
    "gxtz-invoice-ps-matching": ["openpyxl", "fitz", "jieba", "rapidocr_onnxruntime"],
    "gxtz-audit-verification": ["openpyxl", "docx", "win32com", "rapidocr_onnxruntime"],
    "gxtz-wecom-collector": ["Crypto"],
}


def check_import(import_name):
    """检查某个库是否可导入"""
    try:
        __import__(import_name)
        return True, None
    except ImportError as e:
        return False, str(e)


def is_windows():
    """判断是否Windows平台"""
    return sys.platform == "win32"


def check_all_dependencies(skill_filter=None):
    """检查所有依赖，返回结果列表"""
    results = []

    for import_name, info in DEPENDENCIES.items():
        # 平台过滤
        if info["required"] == "windows" and not is_windows():
            results.append({
                "import_name": import_name,
                "pip_package": info["pip_package"],
                "required": "windows-only",
                "category": info["category"],
                "installed": False,
                "status": "skip_non_windows",
                "handles": info["handles"],
                "used_by": info["used_by"],
            })
            continue

        # 技能过滤
        if skill_filter:
            skill_deps = SKILL_DEPENDENCIES.get(skill_filter, [])
            if import_name not in skill_deps:
                continue

        # 检查导入
        installed, error = check_import(import_name)

        # 判断必需性
        required = info["required"]
        if required == "windows":
            required_label = "windows-only"
        elif required:
            required_label = "required"
        else:
            required_label = "optional"

        if installed:
            status = "ok"
        elif required_label == "required":
            status = "missing_required"
        elif required_label == "optional":
            status = "missing_optional"
        else:
            status = "missing_windows"

        results.append({
            "import_name": import_name,
            "pip_package": info["pip_package"],
            "required": required_label,
            "category": info["category"],
            "installed": installed,
            "status": status,
            "handles": info["handles"],
            "used_by": info["used_by"],
        })

    return results


def install_package(pip_package):
    """尝试用pip安装某个包"""
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", pip_package],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except subprocess.CalledProcessError:
        return False


def print_report(results, json_output=False):
    """打印检查报告"""
    if json_output:
        print(json.dumps({
            "total": len(results),
            "installed": sum(1 for r in results if r["installed"]),
            "missing_required": sum(1 for r in results if r["status"] == "missing_required"),
            "missing_optional": sum(1 for r in results if r["status"] == "missing_optional"),
            "results": results,
        }, ensure_ascii=False, indent=2))
        return

    print(f"\n{'='*80}")
    print(f"  gxtz 技能系统依赖检查报告")
    print(f"  平台: {sys.platform}")
    print(f"  Python: {sys.version.split()[0]}")
    print(f"{'='*80}\n")

    # 按类别分组
    categories = {}
    for r in results:
        categories.setdefault(r["category"], []).append(r)

    status_emoji = {
        "ok": "✓",
        "missing_required": "✗",
        "missing_optional": "⚠",
        "missing_windows": "⚠",
        "skip_non_windows": "—",
    }

    for category, items in categories.items():
        print(f"【{category}】")
        for item in items:
            emoji = status_emoji.get(item["status"], "?")
            req_tag = f"[{item['required']}]"
            print(f"  {emoji} {item['import_name']:<15} {req_tag:<18} {item['pip_package']}")
            if item["status"] == "missing_required":
                print(f"      安装: pip install {item['pip_package']}")
                print(f"      用途: {item['handles']}")
            elif item["status"] == "missing_optional":
                print(f"      (可选) 安装: pip install {item['pip_package']}")
        print()

    # 汇总
    total = len(results)
    installed = sum(1 for r in results if r["installed"])
    missing_required = sum(1 for r in results if r["status"] == "missing_required")
    missing_optional = sum(1 for r in results if r["status"] == "missing_optional")

    print(f"{'='*80}")
    print(f"  汇总: {installed}/{total} 已安装 | {missing_required} 必需缺失 | {missing_optional} 可选缺失")
    print(f"{'='*80}")

    if missing_required > 0:
        print(f"\n  ⛔ 有 {missing_required} 个必需依赖缺失，请安装后再执行技能")
        print(f"  一键安装: pip install -r {REQUIREMENTS_FILE}")
    elif missing_optional > 0:
        print(f"\n  ⚠ 有 {missing_optional} 个可选依赖缺失，技能可运行但部分功能降级")
    else:
        print(f"\n  ✓ 所有必需依赖已安装，技能系统就绪")


def main():
    parser = argparse.ArgumentParser(description='gxtz技能系统依赖检查')
    parser.add_argument("--fix", action="store_true", help="尝试安装缺失的必需依赖")
    parser.add_argument("--json", action="store_true", help="输出JSON格式")
    parser.add_argument("--skill", default=None, help="仅检查某技能所需依赖")
    args = parser.parse_args()

    results = check_all_dependencies(args.skill)

    if args.fix:
        print("[fix] 尝试安装缺失的必需依赖...")
        for r in results:
            if r["status"] == "missing_required":
                print(f"  安装 {r['pip_package']}...")
                if install_package(r["pip_package"]):
                    print(f"  ✓ {r['pip_package']} 安装成功")
                else:
                    print(f"  ✗ {r['pip_package']} 安装失败")
        # 重新检查
        results = check_all_dependencies(args.skill)

    print_report(results, args.json)

    # 退出码
    missing_required = sum(1 for r in results if r["status"] == "missing_required")
    sys.exit(1 if missing_required > 0 else 0)


if __name__ == "__main__":
    main()
