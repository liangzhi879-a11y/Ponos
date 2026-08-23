#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ponos 安装包视觉素材生成器
生成 electron-builder NSIS 所需的位图：
  - build/installerSidebar.bmp   164x314  欢迎/完成页左侧边栏
  - build/uninstallerSidebar.bmp 164x314  卸载程序欢迎页
配色取自 src/styles/themes.css 的 yuanfang 主题（--brand-500 #ff6a00、深色底 #171109）。
用法：python build/make_installer_art.py
"""
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO_PATH = os.path.join(ROOT, "public", "logo.png")
OUT_DIR = os.path.join(ROOT, "build")

SIDEBAR_W, SIDEBAR_H = 164, 314

# ---- 主题色 ----
BG_TOP = (30, 22, 15)       # #1e160f
BG_MID = (23, 17, 9)        # #171109
BG_BOTTOM = (14, 10, 6)     # #0e0a06
BRAND = (255, 106, 0)       # #ff6a00
BRAND_SOFT = (251, 146, 60)  # #fb923c


def gradient_bg(w, h):
    """纵向三色渐变背景。"""
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / (h - 1)
        if t < 0.55:
            k = t / 0.55
            c = tuple(round(BG_TOP[i] + (BG_MID[i] - BG_TOP[i]) * k) for i in range(3))
        else:
            k = (t - 0.55) / 0.45
            c = tuple(round(BG_MID[i] + (BG_BOTTOM[i] - BG_MID[i]) * k) for i in range(3))
        for x in range(w):
            px[x, y] = c
    return img


def radial_glow_mask(w, h, cx, cy, radius, peak_alpha):
    """返回径向光晕的灰度蒙版（中心最亮，向边缘衰减）。"""
    glow = Image.new("L", (w, h), 0)
    gd = ImageDraw.Draw(glow)
    for r in range(radius, 0, -2):
        a = int(peak_alpha * (1 - r / radius) ** 2)
        if a <= 0:
            continue
        gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=a)
    return glow.filter(ImageFilter.GaussianBlur(radius / 3))


def make_sidebar(out_path, preview_path):
    img = gradient_bg(SIDEBAR_W, SIDEBAR_H)

    # 中央偏下的品牌光晕（加法叠加，不压暗背景）
    glow_mask = radial_glow_mask(SIDEBAR_W, SIDEBAR_H, 82, 148, 95, 42)
    glow_layer = Image.new("RGBA", (SIDEBAR_W, SIDEBAR_H), BRAND + (0,))
    glow_layer.putalpha(glow_mask)
    img = Image.alpha_composite(img.convert("RGBA"), glow_layer).convert("RGB")

    # 右上角微弱斜向高光
    highlight = Image.new("L", (SIDEBAR_W, SIDEBAR_H), 0)
    hd = ImageDraw.Draw(highlight)
    for i in range(0, 46, 3):
        hd.line([(SIDEBAR_W - 10 - i, 4), (SIDEBAR_W + 20 - i, 4)], fill=14 - i)
    highlight = highlight.filter(ImageFilter.GaussianBlur(2))
    light = Image.new("RGB", (SIDEBAR_W, SIDEBAR_H), (255, 244, 232))
    img = Image.composite(light, img, highlight)

    # 品牌 Logo（缩放后居中于上方区域）
    logo = Image.open(LOGO_PATH).convert("RGBA")
    target_h = 128
    ratio = target_h / logo.height
    logo = logo.resize((max(1, round(logo.width * ratio)), target_h), Image.LANCZOS)
    lx = (SIDEBAR_W - logo.width) // 2
    ly = 44
    img.paste(logo, (lx, ly), logo)

    # 品牌字标（Logo 下方居中）+ 橙色点缀短线（绘制在最终图像上）
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 17)
    except OSError:
        font = ImageFont.load_default()
    word = "Ponos"
    w = draw.textlength(word, font=font)
    draw.text(((SIDEBAR_W - w) / 2, 186), word, font=font, fill=(245, 236, 224))

    dot_w = 26
    dot_x0 = (SIDEBAR_W - dot_w) // 2
    for x in range(dot_x0, dot_x0 + dot_w):
        k = x - dot_x0
        a = 1 - abs((k - dot_w / 2) / (dot_w / 2))  # 中心最亮，两端渐隐
        col = tuple(round(BRAND_SOFT[i] * (0.35 + 0.65 * a)) for i in range(3))
        draw.line([(x, 212), (x, 212)], fill=col)

    # 底部细幅橙色渐变线（装饰）
    for x in range(SIDEBAR_W):
        k = x / (SIDEBAR_W - 1)
        col = tuple(round(BRAND_SOFT[i] * (0.25 + 0.75 * (1 - abs(k - 0.5) * 2))) for i in range(3))
        draw.line([(x, SIDEBAR_H - 26), (x, SIDEBAR_H - 26)], fill=col)

    img.save(preview_path, "PNG")
    # BMP：NSIS 需要无 alpha 的 RGB 位图
    bmp = img.convert("RGB")
    bmp.save(out_path, "BMP")
    print(f"written: {out_path} ({img.size})  preview: {preview_path}")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    make_sidebar(
        os.path.join(OUT_DIR, "installerSidebar.bmp"),
        os.path.join(OUT_DIR, "installerSidebar.preview.png"),
    )
    make_sidebar(
        os.path.join(OUT_DIR, "uninstallerSidebar.bmp"),
        os.path.join(OUT_DIR, "uninstallerSidebar.preview.png"),
    )


if __name__ == "__main__":
    main()
