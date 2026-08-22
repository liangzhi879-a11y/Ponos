# -*- coding: utf-8 -*-
"""
make_dafeiyu_sprites.py — 大肥鱼换皮素材生成器

从大肥鱼三视图（正面/侧面/背面，透明抠图）程序化生成嘉嘉引擎规格的
动画精灵图（408×512 帧，透明底），输出到 pet/assets/：

  dafeiyu-idle-spritesheet.png    8 帧 · 正面呼吸浮动
  dafeiyu-walk-spritesheet.png    8 帧 · 侧面镜像摆动
  dafeiyu-sleep-spritesheet.png   8 帧 · 正面下沉微动
  dafeiyu-grabbed-spritesheet.png 8 帧 · 侧面左右晃动
  dafeiyu-release-spritesheet.png 4 帧 · 晃动衰减归位

运行：python pet/make_dafeiyu_sprites.py
"""
import math
import os
import sys
from pathlib import Path

from PIL import Image

FRAME_W, FRAME_H = 408, 512
OUT_DIR = Path(__file__).resolve().parent / 'assets'
SRC_DIR = Path(__file__).resolve().parent / 'dafeiyu-pet' / 'sprites'


def load_view(name):
    img = Image.open(SRC_DIR / ('%s.png' % name)).convert('RGBA')
    return img


def fit(img, height):
    """等比缩放到指定高度，返回缩放后的透明图。"""
    w = round(img.width * height / img.height)
    return img.resize((w, height), Image.LANCZOS)


def frame_center(img):
    """把精灵画到 408×512 透明画布：水平居中、底部对齐。"""
    canvas = Image.new('RGBA', (FRAME_W, FRAME_H), (0, 0, 0, 0))
    x = (FRAME_W - img.width) // 2
    y = FRAME_H - img.height
    canvas.paste(img, (x, y), img)
    return canvas


def offset(canvas, dx, dy):
    """平移画布内容（透明边缘自然留白）。"""
    out = Image.new('RGBA', (FRAME_W, FRAME_H), (0, 0, 0, 0))
    out.paste(canvas, (dx, dy), canvas)
    return out


def scale_paste(canvas, factor):
    """以画面中心为基准整体缩放（呼吸效果）。"""
    w = max(1, round(canvas.width * factor))
    h = max(1, round(canvas.height * factor))
    resized = canvas.resize((w, h), Image.LANCZOS)
    out = Image.new('RGBA', (FRAME_W, FRAME_H), (0, 0, 0, 0))
    out.paste(resized, ((FRAME_W - w) // 2, (FRAME_H - h) // 2), resized)
    return out


def make_sheet(frames):
    sheet = Image.new('RGBA', (FRAME_W * len(frames), FRAME_H), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.paste(f, (i * FRAME_W, 0), f)
    return sheet


def gen_anim(views, spec):
    """spec: list of (view_name, dx, dy, scale, mirror)"""
    base = {name: fit(load_view(name), 430) for name in views}
    frames = []
    for (name, dx, dy, scale, mirror) in spec:
        img = base[name]
        if mirror:
            img = img.transpose(Image.FLIP_LEFT_RIGHT)
        canvas = frame_center(img)
        if scale != 1.0:
            canvas = scale_paste(canvas, scale)
        if dx or dy:
            canvas = offset(canvas, dx, dy)
        frames.append(canvas)
    return frames


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    n = 8
    # idle：正面呼吸浮动（y 正弦 ±6，缩放 1±0.015）
    idle = gen_anim(['正面'], [
        ('正面', 0, round(math.sin(i / n * 2 * math.pi) * 6),
         1.0 + math.sin(i / n * 2 * math.pi + math.pi) * 0.015, False)
        for i in range(n)
    ])
    # walk：侧面镜像交替 + x 摆动
    walk = gen_anim(['侧面'], [
        ('侧面', round(math.cos(i / n * 2 * math.pi) * 5), 0, 1.0, i % 2 == 1)
        for i in range(n)
    ])
    # sleep：正面下沉 + 微弱浮动
    sleep = gen_anim(['正面'], [
        ('正面', 0, 12 + round(math.sin(i / n * 2 * math.pi) * 2), 0.92, False)
        for i in range(n)
    ])
    # grabbed：侧面左右晃动
    grabbed = gen_anim(['侧面'], [
        ('侧面', round(math.sin(i / n * 2 * math.pi) * 8), 0, 1.0, i % 2 == 1)
        for i in range(n)
    ])
    # release：晃动衰减归位（4 帧）
    release = gen_anim(['侧面'], [
        ('侧面', dx, 0, 1.0, False) for dx in (8, 4, 1, 0)
    ])

    for key, frames in (('idle', idle), ('walk', walk), ('sleep', sleep),
                        ('grabbed', grabbed), ('release', release)):
        sheet = make_sheet(frames)
        out = OUT_DIR / ('dafeiyu-%s-spritesheet.png' % key)
        sheet.save(out)
        print('wrote %s (%dx%d, %d frames)' % (out.name, sheet.width, sheet.height, len(frames)))


if __name__ == '__main__':
    main()
