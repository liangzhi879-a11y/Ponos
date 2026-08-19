# -*- coding: utf-8 -*-
"""豆包图片去水印后处理：右下角水印区域检测 + OpenCV inpaint，降级裁剪。
CLI: python watermark_remove.py <input> [--mode auto|crop] [--output <path>]
stdout 单行 JSON: {"ok":true,"output":"...","mode":"inpaint|crop","region":[x,y,w,h]}
"""
import json, os, sys

# ===== 可调参数（P0 用真实豆包图校准） =====
# 扫描框：右下角区域占图宽高的比例
SCAN_W_RATIO = 0.35
SCAN_H_RATIO = 0.35
# inpaint 膨胀半径（像素，按原图尺寸线性缩放）
DILATE_RATIO = 0.008
# 检测阈值：区域内与背景亮度差异超过该值视为水印像素
THRESH = 25
# =========================================

def parse_args(argv):
    mode = 'auto'
    out = None
    src = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--mode':
            mode = argv[i + 1]; i += 2
        elif a == '--output':
            out = argv[i + 1]; i += 2
        else:
            src = a; i += 1
    return src, mode, out

def main(argv):
    src, mode, out = parse_args(argv)
    if not src or not os.path.exists(src):
        print(json.dumps({'ok': False, 'error': 'input not found'}, ensure_ascii=False))
        return 1
    if out is None:
        base, ext = os.path.splitext(src)
        out = base + '_clean.png'
    try:
        import cv2
        import numpy as np
        img = cv2.imread(src)
        if img is None:
            raise RuntimeError('cannot decode image')
        h, w = img.shape[:2]
        sw, sh = int(w * SCAN_W_RATIO), int(h * SCAN_H_RATIO)
        if mode == 'crop':
            region = [0, 0, sw, sh]
            cropped = img[sh:, sw:]  # 裁掉左上角水印块
            cv2.imwrite(out, cropped)
            print(json.dumps({'ok': True, 'output': os.path.abspath(out), 'mode': 'crop', 'region': region}, ensure_ascii=False))
            return 0
        # auto：左上角区域灰度差检测 → mask → inpaint
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        x0, y0 = 0, 0
        region_gray = gray[y0:y0 + sh, x0:x0 + sw]
        # 背景亮度用区域外右下邻接条（若存在）或区域均值近似
        if y0 + sh < h:
            bg = float(np.mean(gray[y0 + sh:y0 + sh + 1, x0:x0 + sw]))
        else:
            bg = float(np.mean(region_gray))
        mask = np.where(np.abs(region_gray.astype(int) - bg) > THRESH, 255, 0).astype('uint8')
        # 形态学闭合 + 膨胀，让 logo 区域连续
        k = max(3, int(min(w, h) * DILATE_RATIO) | 1)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.dilate(mask, kernel)
        if int(mask.sum()) == 0:
            # 检测不到水印像素 → 降级裁剪左上块
            region = [0, 0, sw, sh]
            cv2.imwrite(out, img[sh:, sw:])
            print(json.dumps({'ok': True, 'output': os.path.abspath(out), 'mode': 'crop', 'region': region}, ensure_ascii=False))
            return 0
        full_mask = np.zeros((h, w), dtype='uint8')
        full_mask[y0:y0 + sh, x0:x0 + sw] = mask
        result = cv2.inpaint(img, full_mask, 3, cv2.INPAINT_TELEA)
        cv2.imwrite(out, result)
        ys, xs = np.where(full_mask > 0)
        region = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min()), int(ys.max() - ys.min())]
        print(json.dumps({'ok': True, 'output': os.path.abspath(out), 'mode': 'inpaint', 'region': region}, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        return 1

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
