# -*- coding: utf-8 -*-
"""
YFWorking 产品使用说明书 → PDF 生成脚本
格式遵循《远方文档标准化》：
  - 封面：品牌 Logo（新远方数据横版）+ 产品标题 + 版本信息
  - 目录：仿宋 20 号加粗「目录」，一级/二级条目仿宋 12 号加粗，附页码
  - 正文：章节标题 仿宋 14 号加粗（远方橙 #FF4200）；小节标题 仿宋 12 号加粗（远方红 #FF2400）
  - 正文：仿宋 12 号；金额数据 ￥123,456,789.00 用楷体斜体 12 号
  - 页码：仿宋斜体 12 号（页脚）
流程：Markdown → HTML（python-markdown）→ Playwright Chromium 渲染 PDF，
      正文首遍渲染后用 PyMuPDF 定位各章节页码，回填目录后再合并封面+目录+正文。
"""
import os
import re
import base64

import fitz  # PyMuPDF
import markdown
from playwright.sync_api import sync_playwright

BASE = r"C:\Users\T203-15\claude-code-gui"
MD_FILE = os.path.join(BASE, "docs", "manual", "YFWorking产品使用说明书.md")
IMG_DIR = os.path.join(BASE, "docs", "manual", "images")
LOGO_PNG = os.path.join(IMG_DIR, "logo_新远方数据LOGO横版.png")
BUILD_DIR = os.path.join(BASE, "docs", "manual", "_build")
OUT_FINAL = os.path.join(BASE, "docs", "manual", "YFWorking产品使用说明书.pdf")

# ---------------- 品牌 / 版式常量 ----------------
ORANGE = "#FF4200"   # 远方橙
RED = "#FF2400"      # 远方红
FANGSONG = '"仿宋", FangSong, SimSun, serif'   # 仿宋
KAITI = '"楷体", KaiTi, cursive'               # 楷体

# ---------------- 1. 读取并预处理 Markdown ----------------
md = open(MD_FILE, encoding="utf-8").read()

# 1.1 移除文首「关于截图」元信息
md = re.sub(r"> \*\*关于截图\*\*：.*?\n\n", "", md, flags=re.S)

# 1.2 移除文首文档大标题（封面已含标题）
md = re.sub(r"^# YFWorking 产品使用说明书\s*\n+", "", md)

# 1.3 提取封面信息表（第一张表），随后从正文删除
m = re.search(r"\| 项目 \| 内容 \|.*?(?=\n\n)", md, flags=re.S)
cover_table_md = m.group(0) if m else ""
cover_rows = []
if m:
    md = md.replace(cover_table_md, "", 1)
    for r in re.findall(r"\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|", cover_table_md):
        if r[0].strip() not in ("项目", "---"):
            cover_rows.append((r[0].strip(), re.sub(r"\*\*", "", r[1]).strip()))

# 1.4 删除 Markdown 自带的「目录」节
md = re.sub(r"## 目录.*?(?=## 1\. 产品概述)", "", md, flags=re.S)

# 1.5 删除「9.2 截图清单（待补充）」节（成品中不保留内部截图清单）
md = re.sub(r"### 9\.2 截图清单（待补充）.*?(?=### 9\.3 技能清单与使用说明)", "", md, flags=re.S)

# 1.6 「**截图内容**：xxx」+ 紧随图片 → <figure> 图文对（图注在图片下方）
fig_n = [0]
def pair_caption(mt):
    fig_n[0] += 1
    caption = mt.group(1).strip()
    path = mt.group(2).strip()
    return ('\n\n<figure data-fig="%d"><img src="%s" alt=""/>\n'
            '<figcaption>图 %d　%s</figcaption></figure>\n\n'
            % (fig_n[0], path, fig_n[0], caption))
md = re.sub(r"\*\*截图内容\*\*：([^\n]+)\n\n!\[[^\]]*\]\(([^)]+)\)", pair_caption, md)

# 1.7 记录目录结构（## 一级章节，### 二级小节）
chapters = re.findall(r"^## (.+)$", md, flags=re.M)
sections = re.findall(r"^### (.+)$", md, flags=re.M)

# ---------------- 2. Markdown → HTML ----------------
html = markdown.markdown(md, extensions=["tables", "fenced_code", "sane_lists"])

def img_to_b64(path):
    if os.path.isabs(path):
        full = path
    elif path.startswith("images/"):
        full = os.path.join(os.path.dirname(MD_FILE), path)  # 相对 manual/ 目录
    else:
        full = os.path.join(IMG_DIR, path)
    with open(full, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()

html = re.sub(r'src="([^"]+\.png)"',
              lambda m: 'src="%s"' % img_to_b64(m.group(1)), html)

# 金额数据：￥123,456,789.00 → 楷体斜体
html = re.sub(r'￥[\d,]+\.\d{2}',
              lambda m: '<span class="money">%s</span>' % m.group(0), html)

# ---------------- 3. 样式 ----------------
CSS = """
@page { size: A4; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: %s; font-size: 12pt; line-height: 1.75;
  color: #1a1a1a; background: #fff;
}
/* ===== 正文标题 ===== */
h1, h2, h3, h4, h5 { font-family: %s; color: #1a1a1a; }
h1 {
  font-size: 14pt; font-weight: bold; color: %s;
  border-bottom: 2px solid %s; padding-bottom: 4px;
  margin: 18px 0 12px 0; page-break-before: always;
  page-break-after: avoid;
}
h1:first-child { page-break-before: avoid; }
h2 { font-size: 12pt; font-weight: bold; color: %s; margin: 14px 0 8px 0; page-break-after: avoid; }
h3, h4, h5 { font-size: 12pt; font-weight: bold; margin: 12px 0 6px 0; page-break-after: avoid; }
p { margin: 6px 0; text-align: justify; }
ul, ol { margin: 6px 0; padding-left: 2em; }
li { margin: 3px 0; }
strong { font-weight: bold; }
/* ===== 表格 ===== */
table { border-collapse: collapse; width: 100%%; margin: 10px 0; font-size: 10.5pt; page-break-inside: auto; }
th, td { border: 1px solid #c9c9c9; padding: 5px 8px; vertical-align: top; }
th { background: #FFF0EA; color: %s; font-weight: bold; }
tr { page-break-inside: avoid; }
/* ===== 图片 ===== */
img { max-width: 100%%; height: auto; }
figure { margin: 12px 0; page-break-inside: avoid; text-align: center; }
figcaption {
  font-family: %s; font-size: 10.5pt; color: #555;
  margin-top: 4px; text-align: center;
}
/* ===== 引用 / 提示框 ===== */
blockquote {
  background: #FFF7F2; border-left: 4px solid %s;
  margin: 10px 0; padding: 8px 14px; color: #333;
}
blockquote p { margin: 2px 0; }
code {
  font-family: Consolas, "Courier New", monospace; font-size: 10.5pt;
  background: #F4F4F4; padding: 0 4px; border-radius: 3px;
}
.money { font-family: %s; font-style: italic; font-size: 12pt; }
/* ===== 封面 ===== */
.cover { text-align: center; padding-top: 24mm; page-break-after: always; }
.cover .logo { width: 62mm; margin-bottom: 14mm; }
.cover .title {
  font-family: %s; font-size: 30pt; font-weight: bold; color: %s;
  line-height: 1.35; letter-spacing: 2px;
}
.cover .subtitle {
  font-family: %s; font-size: 15pt; color: #444; margin-top: 8mm; letter-spacing: 6px;
}
.cover .rule {
  width: 62mm; margin: 10mm auto 0 auto; border-top: 2.5px solid %s; position: relative;
}
.cover .rule::after {
  content: ""; display: block; border-top: 1px solid %s; margin-top: 3px;
}
.cover table { width: 120mm; margin: 12mm auto 0 auto; font-size: 12pt; }
.cover table td { border: none; padding: 4px 10px; }
.cover table td:first-child { width: 40mm; text-align: right; color: %s; font-weight: bold; }
.cover table td:last-child { text-align: left; }
.cover .version { font-family: %s; font-size: 14pt; margin-top: 12mm; color: #333; }
.cover .company { font-family: %s; font-size: 14pt; margin-top: 6mm; color: %s; }
/* ===== 目录 ===== */
.toc { page-break-after: always; }
.toc h1 {
  font-size: 20pt; font-weight: bold; color: %s; text-align: center;
  border-bottom: 2px solid %s; padding-bottom: 8px;
}
.toc .toc-row {
  display: flex; align-items: baseline; margin: 3px 0; font-size: 12pt;
}
.toc .toc-row.chapter { font-weight: bold; margin-top: 8px; }
.toc .toc-row.section { padding-left: 2.5em; font-weight: bold; }
.toc .toc-title { white-space: nowrap; }
.toc .toc-leader { flex: 1; border-bottom: 1px dotted #aaa; margin: 0 8px; transform: translateY(-3px); }
.toc .toc-page { white-space: nowrap; }
""" % (FANGSONG, FANGSONG, ORANGE, ORANGE, RED,
       ORANGE, FANGSONG, ORANGE, KAITI,
       FANGSONG, ORANGE, FANGSONG, ORANGE, RED,
       ORANGE, FANGSONG, FANGSONG, ORANGE, ORANGE, ORANGE)

FOOTER_TPL = ('<div style="width:100%%;margin:0;padding:0;font-size:0;">'
              '<div style="font-size:12pt;text-align:center;font-family:%s;font-style:italic;color:#333;">'
              '第 <span class="pageNumber"></span> 页　共 <span class="totalPages"></span> 页'
              '</div></div>') % FANGSONG

# ---------------- 4. 渲染工具 ----------------
def render_pdf(html_str, out_path, footer=True):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.set_content(html_str, wait_until="load")
        page.wait_for_timeout(600)
        page.pdf(
            path=out_path, format="A4", print_background=True,
            margin={"top": "20mm", "bottom": "22mm", "left": "20mm", "right": "20mm"},
            display_header_footer=footer,
            header_template="<span></span>",
            footer_template=FOOTER_TPL if footer else "<span></span>",
        )
        browser.close()

def wrap(inner):
    return ('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
            '<style>%s</style></head><body>%s</body></html>' % (CSS, inner))

# ---------------- 5. 正文首遍渲染 + 章节页码定位 ----------------
os.makedirs(BUILD_DIR, exist_ok=True)
BODY1 = os.path.join(BUILD_DIR, "body.pdf")
render_pdf(wrap(html), BODY1, footer=True)

def heading_page(text):
    doc = fitz.open(BODY1)
    try:
        for i, pg in enumerate(doc):
            if pg.search_for(text):
                return i + 1
    finally:
        doc.close()
    return None

toc_entries = []
for h in chapters:
    toc_entries.append(("chapter", h, heading_page(h)))
for h in sections:
    toc_entries.append(("section", h, heading_page(h)))
missing = [e for e in toc_entries if e[2] is None]
if missing:
    print("[warn] 未定位到页码的标题：", [e[1] for e in missing])

# ---------------- 6. 封面 + 目录 ----------------
logo_b64 = img_to_b64(LOGO_PNG)
info_rows = "".join(
    '<tr><td>%s</td><td>%s</td></tr>' % (k, v) for k, v in cover_rows
)
toc_rows = "".join(
    '<div class="toc-row %s"><span class="toc-title">%s</span>'
    '<span class="toc-leader"></span><span class="toc-page">%s</span></div>'
    % (level, title, page if page else "·")
    for level, title, page in toc_entries
)

front_html = wrap(
    '<div class="cover">'
    '<img class="logo" src="%s" alt="新远方数据 Logo"/>'
    '<div class="title">YFWorking<br/>产品使用说明书</div>'
    '<div class="subtitle">企业咨询项目与开发的 AI 工作台</div>'
    '<div class="rule"></div>'
    '<table><tbody>%s</tbody></table>'
    '<div class="version">V2.2.0　·　2026-08-07</div>'
    '<div class="company">新远方数据</div>'
    '</div>'
    '<div class="toc"><h1>目　录</h1>%s</div>'
    % (logo_b64, info_rows, toc_rows)
)
FRONT = os.path.join(BUILD_DIR, "front.pdf")
render_pdf(front_html, FRONT, footer=False)

# ---------------- 7. 合并 封面+目录+正文 ----------------
final = fitz.open()
for part in (FRONT, BODY1):
    d = fitz.open(part)
    final.insert_pdf(d)
    d.close()
final.save(OUT_FINAL)
final.close()

print("OK:", OUT_FINAL)
print("封面信息:", cover_rows)
print("章节数:", len(chapters), "小节数:", len(sections), "图片数:", fig_n[0])
print("目录页码:", [(t, p) for _, t, p in toc_entries])
