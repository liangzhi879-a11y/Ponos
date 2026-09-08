# -*- coding: utf-8 -*-
"""S6 Batch B 图标资产生成：.ai(矢量/PDF) → public/ 图标族。

源（用户素材，YF/ 只读，不入 git）：
  YF/icon-logo.ai   551x551 方形徽标  -> icon-{16,32,48,64,128,256}.png + icon.png + icon.ico
  YF/boost-logo.ai  544x378 横版标识  -> logo.png（宽 512 透明渲染）
                                      -> favicon 方形化（contain 居中）16/32/48/64 -> favicon.ico
渲染 = pymupdf 每尺寸直接从矢量栅格化（避免缩放混叠）。ico 打包复用 png-to-ico.cjs。
依赖：python 3.12 + pymupdf（pip install pymupdf）。源缺失时报错退出（exit 1）。
"""
import os
import subprocess
import sys

import fitz  # pymupdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repo 根
PUBLIC = os.path.join(ROOT, "public")
ICON_SRC = os.path.join(ROOT, "YF", "icon-logo.ai")
BOOST_SRC = os.path.join(ROOT, "YF", "boost-logo.ai")

ICON_SIZES = [16, 32, 48, 64, 128, 256]
FAVICON_SIZES = [16, 32, 48, 64]


def check_src(path):
    if not os.path.exists(path):
        print(f"ERROR: 源缺失（用户素材 YF/ 须在位）：{path}", file=sys.stderr)
        sys.exit(1)


def render_rect(doc, page_index, target_w, target_h, out_path, pad=False):
    """按画板渲染；pad=True 时内容 contain 居中于方形透明画布（favicon 用，Pillow 合成）。"""
    from PIL import Image  # render 前置依赖：pymupdf + pillow（均已在系统 python 3.12 验证）
    import io
    page = doc[page_index]
    r = page.rect
    scale = (min(target_w / r.width, target_h / r.height) if pad
             else target_w / r.width)
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=True)
    if not pad:
        pix.save(out_path)
        print(f"  created {out_path} ({pix.width}x{pix.height})")
        return
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGBA")
    canvas_img = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    x = (target_w - img.width) // 2
    y = (target_h - img.height) // 2
    canvas_img.paste(img, (x, y), img)
    canvas_img.save(out_path)
    print(f"  created {out_path} ({canvas_img.width}x{canvas_img.height}, contain)")


def main():
    check_src(ICON_SRC)
    check_src(BOOST_SRC)
    os.makedirs(PUBLIC, exist_ok=True)

    # 1) 应用图标族（icon-logo.ai，方形，每尺寸矢量直接栅格化）
    icon_doc = fitz.open(ICON_SRC)
    if icon_doc.page_count < 1 or icon_doc[0].rect.width != icon_doc[0].rect.height:
        print(f"WARNING: icon-logo.ai 画板非方形（{icon_doc[0].rect}），按宽度渲染")
    for size in ICON_SIZES:
        render_rect(icon_doc, 0, size, size, os.path.join(PUBLIC, f"icon-{size}.png"))
    icon_doc.close()
    # icon.png = 256 拷贝（main.cjs ICON_PATH / 快捷方式等引用）
    import shutil
    shutil.copyfile(os.path.join(PUBLIC, "icon-256.png"), os.path.join(PUBLIC, "icon.png"))

    # 2) UI 品牌 logo（boost-logo.ai 横版 → logo.png 宽 512 透明）
    boost_doc = fitz.open(BOOST_SRC)
    bpage = boost_doc[0]
    logo_w = 512
    scale = logo_w / bpage.rect.width
    lpix = bpage.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=True)
    lpix.save(os.path.join(PUBLIC, "logo.png"))
    print(f"  created {os.path.join(PUBLIC, 'logo.png')} ({lpix.width}x{lpix.height})")

    # 3) favicon（boost 方形化 contain 居中 → favicon-*.png）
    for size in FAVICON_SIZES:
        render_rect(boost_doc, 0, size, size,
                    os.path.join(PUBLIC, f"favicon-{size}.png"), pad=True)
    boost_doc.close()

    # 4) ico 打包（png-to-ico.cjs 参数化：basename 前缀 + 输出路径）
    for base, out in (("icon", "icon.ico"), ("favicon", "favicon.ico")):
        subprocess.run(
            ["node", os.path.join(ROOT, "scripts", "png-to-ico.cjs"),
             base, os.path.join(PUBLIC, out)],
            check=True, cwd=ROOT,
        )
    print("Done. 图标族已生成于 public/")


if __name__ == "__main__":
    main()
