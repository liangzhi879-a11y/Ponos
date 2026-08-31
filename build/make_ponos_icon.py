"""Ponos 品牌图标生成：霓虹漩涡 P。
用法: python build/make_ponos_icon.py  （在仓库根目录运行）
产出: public/icon*.png / icon.ico / logo.png / shadow-theme/icon-vortex.png
"""
import os
from PIL import Image, ImageDraw

PINK = (255, 45, 148)      # #ff2d94
CYAN = (31, 216, 240)      # #1fd8f0
DARK = (13, 13, 17)        # #0d0d11

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def draw_vortex_p(size: int, bg: bool = True) -> Image.Image:
    """绘制霓虹漩涡 P：暗底圆角方块 + 粉→青渐变 P 字母 + 漩涡尾迹。"""
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # 圆角方底（暗色，半透明圆角）
    if bg:
        radius = int(size * 0.22)
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=DARK + (255,))
        # 外圈霓虹描边
        d.rounded_rectangle([1, 1, size - 2, size - 2], radius=radius, outline=PINK + (200,), width=max(2, size // 60))
    # P 字母：竖线 + 半圆头 + 漩涡尾迹（分段渐变）
    cx, cy, w = size * 0.30, size * 0.50, size * 0.16   # P 主体位置
    lw = max(3, size * 0.09)                            # 笔画宽度
    # 竖线（粉→青渐变，自上而下）
    steps = 24
    for i in range(steps):
        t = i / (steps - 1)
        y0 = cy - size * 0.30 + i * (size * 0.62 / steps)
        d.line([cx, y0, cx, y0 + size * 0.62 / steps + 1], fill=lerp(PINK, CYAN, t), width=int(lw))
    # 半圆头（P 的圆弧，青→粉）
    bbox = [cx - lw / 2, cy - size * 0.30, cx + size * 0.26, cy - size * 0.30 + size * 0.52]
    d.arc(bbox, start=90, end=270, fill=CYAN, width=int(lw))
    # 漩涡尾迹：从 P 右下向外螺旋（多段短线，透明度递增）
    import math
    for k in range(40):
        t = k / 39
        ang = t * math.pi * 2.2
        r = size * (0.10 + t * 0.16)
        x0 = cx + size * 0.20 + r * math.cos(ang)
        y0 = cy + size * 0.42 + r * math.sin(ang) * 0.5
        a = int(255 * (1 - t) * 0.9)
        d.ellipse([x0 - lw * 0.3, y0 - lw * 0.3, x0 + lw * 0.3, y0 + lw * 0.3], fill=lerp(PINK, CYAN, t) + (a,))
    return im

def main():
    root = os.path.join(os.path.dirname(__file__), '..', 'public')
    # 应用图标多尺寸
    for px in [16, 32, 48, 64, 128, 256]:
        draw_vortex_p(px).save(os.path.join(root, f'icon-{px}.png'))
    draw_vortex_p(256).save(os.path.join(root, 'icon.png'))
    # ICO 多尺寸合并（主图须为最大尺寸，否则 Pillow 会跳过更大的 size 项）
    imgs = [draw_vortex_p(px) for px in [16, 32, 48, 64, 128, 256]]
    imgs[-1].save(os.path.join(root, 'icon.ico'), sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)], append_images=imgs[:-1])
    # logo（透明底，Header/登录/驾驶舱用）
    draw_vortex_p(256, bg=False).resize((239, 241), Image.LANCZOS).save(os.path.join(root, 'logo.png'))
    draw_vortex_p(512).save(os.path.join(root, 'shadow-theme', 'icon-vortex.png'))
    print('icons generated')

if __name__ == '__main__':
    main()
