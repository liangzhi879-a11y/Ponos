#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""doc_to_md.py —— 文件知识库导入：文档 → 结构化内容（唯一权威解析器）

为什么放在 `runtime/skills/_common/`：release 形态下内核是 `resources/kernel/cli.mjs`
**单文件 bundle**（kernel-dist 只打包 cli.mjs），内核/其它脚本无法定位 app 内的任意文件；
而 `runtime/skills` 是 extraResources **全量打包**且内核已有探测范式（findOcrEngine）。
同目录还有 OCR 引擎 ocr_engine.py —— 本脚本复用它的表格/图片识别能力，不另造一套 OCR。

分层（这是本脚本存在的理由）：本脚本**只做"文件 → 结构化 JSON"**，没有写盘权限；
白名单 / 体积 / 路径穿越 / md 组装 / 台账 / 索引同步全部在 node 侧（kernel/knowledge-import.mjs）。
如此"解析口径"只有一份，落盘防护也只有一份，两边不会漂移。

用法：
  python doc_to_md.py --input <文件> [--project kb-import] [--max-ocr-pages 200]
                      [--max-table-rows 500] [--ocr-engine <ocr_engine.py 路径>]

stdout 契约：**恰好一行 UTF-8 JSON**（日志一律走 stderr，绝不污染 stdout）——
  成功 {"ok":true,"converter":"pdf-text","title":...,"sections":[...],
        "warnings":[...],"sourceBytes":N,"pages":N}
  失败 {"ok":false,"error":"<code>","message":"<可读原因>","warnings":[...],"sourceBytes":N|null}
错误对象与成功对象字段对齐（warnings/sourceBytes 恒存在，未知取 null），node 侧只需一条读取路径。
错误码：not-found / unsupported / encrypted / empty / ocr-unavailable / parse-error。
（命令行参数本身写错也走 parse-error JSON，而不是吐一段 usage —— stdout 永不是"非 JSON"。）

pages 取值：pdf=源文件页数；pptx=幻灯片数；xlsx/xls=工作表数；ocr=图片数(≥1)；text/csv=1；
docx=null（Word 分页要渲染才知道，**不猜**）。

sections 统一模型（node 侧只有一份 md 渲染器，不给每种格式各写一条渲染路径）：
  [{"heading": str|None, "level": int, "text": str, "tables": [[[cell,...],...]]}]
converter 取值：pdf-text | pdf-ocr | docx | xlsx | pptx | ocr | text | csv
"""
import argparse
import csv
import datetime
import decimal
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

# ── 常量 ────────────────────────────────────────────────────────────────────
# PDF 判定"有没有文本层"的阈值：每页平均非空白字符数。低于它整篇走 OCR。
# 取 12 是保守值——真实扫描件是 0~2，而正常 PDF 哪怕以图为主也常带页眉/页码（≥20）。
# 宁可偶尔多 OCR 一篇（慢但内容全），也不要漏掉扫描件（产出空文档 = 静默丢数据）。
PDF_TEXT_MIN_PER_PAGE = 12
OCR_TIMEOUT_S = 600          # OCR 是重活（首次加载模型 + 逐页识别），内核侧同量级
MAX_TABLE_ROWS = 500         # 单表最多转多少行（超出截断 + warning，不静默丢）
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp'}
TEXT_EXTS = {'.txt', '.md', '.markdown', '.log', '.json', '.yaml', '.yml', '.html', '.htm'}


def emit(obj):
    """stdout 只允许一行 JSON（日志用 stderr）。

    两个 Windows 细节必须显式处理，否则"一行 UTF-8 JSON"会漂：
      1) 解释器默认 stdout 是本地编码（本机 cp936），写中文可能变成 GBK 字节甚至 U+FFFD；
         这里直接写 **UTF-8 字节**（node 侧按 utf8 读），与 locale / 控制台代码页无关。
      2) 文本模式会把 \\n 翻成 \\r\\n；写字节就只留一个 \\n，父进程 split('\\n') 更干净。
    刻意用 sys.__stdout__ 而非 sys.stdout：解析期间 sys.stdout 被改道到 stderr（见 main），
    保证任何库/子模块的 print 都进不了契约通道。
    """
    line = json.dumps(obj, ensure_ascii=False)
    buf = getattr(sys.__stdout__, 'buffer', None)
    if buf is not None:
        buf.write(line.encode('utf-8') + b'\n')
        buf.flush()
    else:  # 极端情况（测试桩把 stdout 换成 StringIO）
        sys.__stdout__.write(line + '\n')
        sys.__stdout__.flush()


def emit_error(code, message, source_bytes=None, warnings=None):
    """错误对象：字段与成功对象对齐，warnings/sourceBytes 恒存在。"""
    return emit({'ok': False, 'error': code, 'message': message,
                 'warnings': list(warnings or []), 'sourceBytes': source_bytes})


def log(msg):
    sys.stderr.write(str(msg) + "\n")


def _jsonable(v):
    """openpyxl/xlrd 会给 datetime/Decimal/bytes —— 直接 json.dumps 会炸。"""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, datetime.datetime):
        return v.strftime('%Y-%m-%d %H:%M:%S')
    if isinstance(v, datetime.date):
        return v.strftime('%Y-%m-%d')
    if isinstance(v, decimal.Decimal):
        f = float(v)
        return int(f) if f.is_integer() else f
    if isinstance(v, bytes):
        try:
            return v.decode('utf-8', 'replace')
        except Exception:
            return ''
    return str(v)


def cell(v):
    """单元格 → 字符串（去首尾空白；None → 空串，避免 md 表格里出现 'None'）。"""
    v = _jsonable(v)
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).replace('\r\n', '\n').replace('\n', ' ').strip()


def clean_text(s):
    """轻噪声清理：连续空行归并 + 去行尾空白。
    刻意保守——只处理**纯格式**噪声；页眉页脚这类"看起来像内容"的重复行不在这里猜
    （猜错就是删正文，比留着噪声更贵）。"""
    if not s:
        return ''
    s = s.replace('\r\n', '\n').replace('\r', '\n')
    lines = [ln.rstrip() for ln in s.split('\n')]
    out = []
    blank = 0
    for ln in lines:
        if ln.strip():
            blank = 0
            out.append(ln)
        else:
            blank += 1
            if blank <= 1:
                out.append('')
    return '\n'.join(out).strip()


def truncate_rows(rows, max_rows, warnings, what):
    if len(rows) <= max_rows:
        return rows
    warnings.append(f'{what}共 {len(rows)} 行，超出单表上限 {max_rows}，已截断（前 {max_rows} 行已入库）')
    return rows[:max_rows]


# OLE2 复合文档头。OOXML 一旦被口令加密就不再有 zip 结构（`PK\x03\x04`），
# 而是变成 OLE2 容器 —— 两者字节级互斥，是确定性判定，不需要"猜是不是加密"。
OLE2_MAGIC = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'

# 三个 zip 系格式共用一条文案：命中 OLE2 有且只有两种可能，用户动作也一样，不必分叉。
# 注意 str.format 的替换字段只能取属性，不能调方法（写 {fmt.lower()} 会在运行时炸）。
_ENCRYPTED_OOXML_MSG = ('{fmt} 无法解析：文件是 OLE2 复合文档（被口令加密的 Office 文件，'
                        '或旧版 {legacy} 改了扩展名）。请解除密码保护，或用 Office 另存为标准 {target}')


def is_ole2(path):
    """`.docx/.xlsx/.pptx` 是不是 OLE2 容器（= 加密的 Office 文件，或旧二进制格式改了扩展名）。

    **只对 zip 系格式（docx/xlsx/pptx/docm/xlsm/pptm）调用**：`.doc/.xls/.ppt` 天生就是
    OLE2，对它们判会把每一个正常旧文件都误报成"已加密"。
    命中时返回 encrypted 而非 parse-error：前者告诉用户"解除密码保护"（可操作），
    后者只会说"损坏"（用户不知道该干什么）。
    """
    try:
        with open(path, 'rb') as f:
            return f.read(8) == OLE2_MAGIC
    except OSError:
        return False


def tail_error(s, limit=300):
    """从引擎/库的 stderr+stdout 里取**最后一条非空行**当错误原因。

    引擎未捕获异常时整段 traceback 都在 stderr，整段贴进 message 既不可读、又会被长度上限
    截断 —— 而截掉的恰好是最后那行真原因（实测 `KeyError: 'total_pages'` 就是这么被截没的）。
    """
    lines = [ln.strip() for ln in (s or '').replace('\r', '').split('\n') if ln.strip()]
    if not lines:
        return '（引擎无输出）'
    for ln in reversed(lines):
        if not ln.startswith(('{', '[')):
            return ln[:limit]
    return lines[-1][:limit]


def _child_env():
    """OCR 子进程环境：强制 UTF-8。

    实测（Windows / cp936）：不设 PYTHONIOENCODING 时，子进程里
    `print(json.dumps(result, ensure_ascii=False))` 会被本地编码破坏——中文变 U+FFFD 或
    GBK 字节，父进程按 utf8 解出来就是乱码。同一台机器上引擎自己写盘的缓存文件是**好的**，
    坏的只是 stdout 通道，所以只在这一处修正，不去动 ocr_engine.py（T1 范围外）。
    """
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'
    return env


# ── 文本 / CSV ──────────────────────────────────────────────────────────────
def parse_text(path, opts, warnings):
    raw = None
    for enc in ('utf-8-sig', 'utf-8', 'gbk', 'latin-1'):
        try:
            with open(path, 'r', encoding=enc) as f:
                raw = f.read()
            break
        except (UnicodeDecodeError, UnicodeError):
            continue
        except OSError as e:
            return None, 'parse-error', str(e)
    if raw is None:
        return None, 'parse-error', '无法以常见编码解码该文本文件'
    ext = os.path.splitext(path)[1].lower()
    # md 输入剥掉自带 frontmatter：导入器会写入自己的溯源 frontmatter，
    # 留着旧的会出现两个 frontmatter 块（第二个被当成正文，索引里多出噪声块）。
    if ext in ('.md', '.markdown'):
        m = re.match(r'^---\r?\n[\s\S]*?\r?\n---\r?\n?', raw)
        if m:
            raw = raw[m.end():]
    return {
        'converter': 'text',
        'title': None,
        'pages': 1,
        'sections': [{'heading': None, 'level': 0, 'text': clean_text(raw), 'tables': []}],
    }, None, None


def parse_csv(path, opts, warnings):
    rows = []
    raw = None
    for enc in ('utf-8-sig', 'gbk', 'latin-1'):
        try:
            with open(path, 'r', encoding=enc, newline='') as f:
                raw = f.read()
            break
        except (UnicodeDecodeError, UnicodeError):
            continue
        except OSError as e:
            return None, 'parse-error', str(e)
    if raw is None:
        return None, 'parse-error', '无法以常见编码解码该 CSV'
    try:
        dialect = csv.Sniffer().sniff(raw[:4096], delimiters=',;\t|')
    except Exception:
        dialect = csv.excel
    for r in csv.reader(io.StringIO(raw), dialect):
        if any((c or '').strip() for c in r):
            rows.append([cell(c) for c in r])
    rows = truncate_rows(rows, opts.max_table_rows, warnings, 'CSV')
    tables = [rows] if rows else []
    return {
        'converter': 'csv',
        'title': None,
        'pages': 1,
        'sections': [{'heading': None, 'level': 0, 'text': '', 'tables': tables}],
    }, None, None


# ── Word ───────────────────────────────────────────────────────────────────
_HEADING_RE = re.compile(r'(heading|标题|title)\s*(\d+)?', re.I)


def _docx_heading_level(p):
    try:
        name = (p.style.name or '')
    except Exception:
        return 0
    m = _HEADING_RE.match(name)
    if not m:
        return 0
    try:
        return int(m.group(2) or 1)
    except Exception:
        return 1


def parse_docx(path, opts, warnings):
    try:
        import docx  # python-docx
    except Exception as e:
        return None, 'parse-error', f'缺少 python-docx：{e}'
    if is_ole2(path):
        return None, 'encrypted', _ENCRYPTED_OOXML_MSG.format(fmt='DOCX', legacy='.doc', target='.docx')
    try:
        doc = docx.Document(path)
    except Exception as e:
        # 加密/损坏的 docx 在这里抛（zip 结构读不出）
        return None, 'parse-error', f'DOCX 打开失败（可能是加密或已损坏）：{e}'
    try:
        from docx.oxml.ns import qn
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except Exception:
        qn = None

    sections = []
    cur = {'heading': None, 'level': 0, 'text': [], 'tables': []}
    title = None

    def flush():
        nonlocal cur
        txt = clean_text('\n'.join(cur['text']))
        if txt or cur['tables'] or cur['heading']:
            sections.append({'heading': cur['heading'], 'level': cur['level'],
                             'text': txt, 'tables': cur['tables']})
        cur = {'heading': None, 'level': 0, 'text': [], 'tables': []}

    def add_table(tbl):
        rows = []
        for r in tbl.rows:
            rows.append([cell(c.text) for c in r.cells])
        rows = truncate_rows(rows, opts.max_table_rows, warnings, '表格')
        if rows:
            cur['tables'].append(rows)

    try:
        body = doc.element.body if (qn and hasattr(doc, 'element')) else None
        if body is not None:
            # 保序遍历 body 子元素：python-docx 的 doc.paragraphs / doc.tables 是**两个独立
            # 列表**，分别遍历会丢掉"表格插在段落之间"的位置关系（导出的 md 里表格全部堆到末尾）。
            for child in body.iterchildren():
                tag = child.tag
                if tag.endswith('}p'):
                    p = Paragraph(child, doc)
                    lvl = _docx_heading_level(p)
                    txt = (p.text or '').strip()
                    if lvl and txt:
                        flush()
                        if title is None:
                            title = txt
                        cur['heading'] = txt
                        cur['level'] = lvl
                    elif txt:
                        cur['text'].append(txt)
                    else:
                        cur['text'].append('')
                elif tag.endswith('}tbl'):
                    add_table(Table(child, doc))
        else:
            for p in doc.paragraphs:
                lvl = _docx_heading_level(p)
                txt = (p.text or '').strip()
                if lvl and txt:
                    flush()
                    if title is None:
                        title = txt
                    cur['heading'] = txt
                    cur['level'] = lvl
                elif txt:
                    cur['text'].append(txt)
            for t in doc.tables:
                add_table(t)
        flush()
    except Exception as e:
        return None, 'parse-error', f'DOCX 解析失败：{e}'
    if not sections:
        return None, 'empty', 'DOCX 未提取到任何文本或表格'
    # pages 留 null：Word 的真实分页要渲染引擎才知道，编一个"1 页"会误导 T2 的展示。
    return {'converter': 'docx', 'title': title, 'pages': None, 'sections': sections}, None, None


# ── Excel ──────────────────────────────────────────────────────────────────
def _sheets_to_sections(iter_sheets, warnings, opts):
    """工作表 → sections。逐行**流式**读取，取满上限就停：
    十万行级的工作表若全量物化会打满内存，而反正要按 --max-table-rows 截断——
    所以既不物化也不谎报总行数（后面用明确的"超过上限"warning 说明是截断而非表就这么大）。
    """
    sections = []
    for name, row_iter in iter_sheets:
        max_rows = opts.max_table_rows
        rows = []
        truncated = False
        for r in row_iter:
            vals = [cell(v) for v in r]
            if not any(v for v in vals):
                continue
            if len(rows) >= max_rows:
                truncated = True
                break
            rows.append(vals)
        if truncated:
            warnings.append(f'工作表「{name}」超过单表上限 {max_rows} 行，已截断（仅前 {max_rows} 行入库）')
        if rows or name:
            sections.append({'heading': name, 'level': 2, 'text': '', 'tables': [rows] if rows else []})
    return sections


def parse_xlsx(path, opts, warnings):
    try:
        from openpyxl import load_workbook
    except Exception as e:
        return None, 'parse-error', f'缺少 openpyxl：{e}'
    if is_ole2(path):
        return None, 'encrypted', _ENCRYPTED_OOXML_MSG.format(fmt='XLSX', legacy='.xls', target='.xlsx')
    try:
        # read_only=True：不把整个工作簿读进内存（大表会吃光内存）；
        # data_only=True：取公式的**缓存值**（否则 md 里全是 "=SUM(...)"，检索不到数字）。
        wb = load_workbook(path, read_only=True, data_only=True)
    except Exception as e:
        return None, 'parse-error', f'XLSX 打开失败（可能是加密或已损坏）：{e}'
    try:
        sheets = []
        for ws in wb.worksheets:
            sheets.append((ws.title, ws.iter_rows(values_only=True)))
        sections = _sheets_to_sections(sheets, warnings, opts)
    except Exception as e:
        return None, 'parse-error', f'XLSX 解析失败：{e}'
    finally:
        try:
            wb.close()
        except Exception:
            pass
    if not sections:
        return None, 'empty', 'XLSX 未提取到任何内容'
    return {'converter': 'xlsx', 'title': None, 'pages': len(sections), 'sections': sections}, None, None


def parse_xls(path, opts, warnings):
    try:
        import xlrd
    except Exception as e:
        return None, 'parse-error', f'缺少 xlrd：{e}'
    try:
        book = xlrd.open_workbook(path)
    except Exception as e:
        # .xls 天生就是 OLE2，不能按签名判加密；但 xlrd 对加密工作簿会明说 "encrypted"，
        # 按文案分流即可（比笼统报 parse-error 更贴近用户能采取的动作）。
        if 'encrypt' in str(e).lower():
            return None, 'encrypted', f'XLS 已加密（需口令），无法读取：{e}'
        return None, 'parse-error', f'XLS 打开失败（可能是加密或已损坏）：{e}'
    sheets = []
    for sh in book.sheets():
        sheets.append((sh.name, (sh.row_values(i) for i in range(sh.nrows))))
    try:
        sections = _sheets_to_sections(sheets, warnings, opts)
    except Exception as e:
        return None, 'parse-error', f'XLS 解析失败：{e}'
    if not sections:
        return None, 'empty', 'XLS 未提取到任何内容'
    return {'converter': 'xlsx', 'title': None, 'pages': len(sections), 'sections': sections}, None, None


# ── PowerPoint（自研：无 python-pptx，pptx 本质是 zip + OOXML）──────────────
_A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'


def _pptx_slide_text(xml_bytes):
    """一页 slide/notesSlide → (段落文本列表, 表格列表)。用 lxml（已在依赖里）。"""
    from lxml import etree
    try:
        root = etree.fromstring(xml_bytes)
    except Exception:
        return [], []
    texts, tables = [], []
    for tbl in root.iter(f'{{{_A_NS}}}tbl'):
        rows = []
        for tr in tbl.iter(f'{{{_A_NS}}}tr'):
            row = []
            for tc in tr.iter(f'{{{_A_NS}}}tc'):
                parts = [(t.text or '') for t in tc.iter(f'{{{_A_NS}}}t')]
                row.append(cell(''.join(parts)))
            if any(row):
                rows.append(row)
        if rows:
            tables.append(rows)
    # 段落：<a:p> 内的多个 <a:t> 属于同一段（一个词一个 t 是 PPT 常态，逐 t 换行会碎成一片）
    for p in root.iter(f'{{{_A_NS}}}p'):
        parts = [(t.text or '') for t in p.iter(f'{{{_A_NS}}}t')]
        line = ''.join(parts).strip()
        if line:
            texts.append(line)
    return texts, tables


def parse_pptx(path, opts, warnings):
    if is_ole2(path):
        return None, 'encrypted', _ENCRYPTED_OOXML_MSG.format(fmt='PPTX', legacy='.ppt', target='.pptx')
    try:
        zf = zipfile.ZipFile(path)
    except Exception as e:
        return None, 'parse-error', f'PPTX 打开失败（可能是加密或已损坏）：{e}'
    with zf:
        names = zf.namelist()
        slide_re = re.compile(r'^ppt/slides/slide(\d+)\.xml$')
        slides = sorted(((int(m.group(1)), n) for n in names for m in [slide_re.match(n)] if m))
        if not slides:
            return None, 'empty', 'PPTX 内未找到任何幻灯片'
        notes = {}
        notes_re = re.compile(r'^ppt/notesSlides/notesSlide(\d+)\.xml$')
        for n in names:
            m = notes_re.match(n)
            if m:
                notes[int(m.group(1))] = n
        sections = []
        title = None
        for idx, (num, name) in enumerate(slides):
            try:
                texts, tables = _pptx_slide_text(zf.read(name))
            except Exception as e:
                warnings.append(f'第 {num} 页解析失败：{e}')
                continue
            # 备注页与幻灯片**编号不保证一一对应**（删页后 OOXML 编号会错位）。
            # 故只在数量一致时按序号取备注，否则放弃备注而不是把别人的备注挂错页（张冠李戴比缺失更坏）。
            if len(notes) == len(slides):
                notes_name = notes.get(num)
                if notes_name:
                    try:
                        note_lines, _ = _pptx_slide_text(zf.read(notes_name))
                        if note_lines:
                            texts.append('备注：' + ' / '.join(note_lines[:40]))
                    except Exception:
                        pass
            if idx == 0 and texts:
                title = texts[0]
            sections.append({
                'heading': f'第 {num} 页', 'level': 2, 'text': clean_text('\n'.join(texts)),
                'tables': [truncate_rows(t, opts.max_table_rows, warnings, f'第 {num} 页表格') for t in tables],
            })
    if not sections:
        return None, 'empty', 'PPTX 未提取到任何文本'
    return {'converter': 'pptx', 'title': title, 'pages': len(slides), 'sections': sections}, None, None


# ── PDF ────────────────────────────────────────────────────────────────────
def _looks_encrypted(err):
    """从异常文本判加密：pypdf 的 PasswordRequiredError / FileNotDecryptedError 措辞不固定，
    按关键词判；宁可漏判成 parse-error，也不要误判把损坏文件说成"需要口令"。"""
    s = str(err or '').lower()
    return ('encrypt' in s) or ('password' in s) or ('decrypt' in s)


def _pdf_pages_text(path):
    """→ (pages: [str]|None, encrypted: bool)。优先 pypdf，回退 PyPDF2。"""
    reader = None
    last_err = None
    missing = 0
    for mod in ('pypdf', 'PyPDF2'):
        try:
            m = __import__(mod)
        except Exception as e:
            missing += 1          # "库没装"与"文件打不开"是两回事，分开记（见下）
            last_err = last_err or e
            continue
        try:
            reader = m.PdfReader(path)
            break
        except Exception as e:
            last_err = e
            reader = None
            continue
    if reader is None:
        if _looks_encrypted(last_err):
            return None, True
        if missing == 2:
            raise RuntimeError('未安装 pypdf/PyPDF2（无法解析 PDF）')
        # 只带原因，不带 "PDF 打开失败" 前缀：调用方 parse_pdf 会加前缀，否则文案重复两遍。
        raise RuntimeError(str(last_err))
    if getattr(reader, 'is_encrypted', False):
        # 空口令能开的加密 PDF（仅权限位加密）很常见，先试一次；不行才判失败。
        opened = False
        try:
            opened = bool(reader.decrypt(''))
        except Exception:
            opened = False
        if not opened:
            return None, True
    pages = []
    for p in reader.pages:
        try:
            pages.append(p.extract_text() or '')
        except Exception:
            pages.append('')
    return pages, False


def _run_ocr_engine(engine, args, cwd):
    """spawn OCR 引擎（与其 CLI 契约一致）。返回 (ok, stdout, stderr)。"""
    py = os.environ.get('PONOS_PYTHON') or os.environ.get('YFWORKING_PYTHON') or sys.executable
    try:
        r = subprocess.run([py, engine] + args, capture_output=True, cwd=cwd,
                           timeout=OCR_TIMEOUT_S, env=_child_env())
    except subprocess.TimeoutExpired:
        return False, '', f'OCR 超时（>{OCR_TIMEOUT_S}s）'
    except Exception as e:
        return False, '', str(e)
    out = (r.stdout or b'').decode('utf-8', 'replace')
    err = (r.stderr or b'').decode('utf-8', 'replace')
    return r.returncode == 0, out, err


def _ocr_pdf(path, opts, warnings):
    """扫描件 PDF → pages/tables（走 OCR 引擎 CLI 的 --output JSON，不解析它的 stdout）。"""
    if not opts.ocr_engine or not os.path.exists(opts.ocr_engine):
        return None, 'ocr-unavailable', '未找到 OCR 引擎 ocr_engine.py（设置 PONOS_OCR_ENGINE 或确认技能库已安装）'
    # 每次调用用一个全新临时目录：避免复用上一次的结果文件，把旧的失败/旧内容读成"本次成功"。
    tmpdir = tempfile.mkdtemp(prefix='yfw-doc2md-')
    out_json = os.path.join(tmpdir, 'ocr.json')
    try:
        cmd = ['ocr-table', '--file', path, '--project', opts.project, '--output', out_json]
        ok, out, err = _run_ocr_engine(opts.ocr_engine, cmd, os.path.dirname(path) or None)
        data = None
        try:
            with open(out_json, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception:
            data = None
        if data is None:
            if not ok:
                return None, 'ocr-unavailable', f'OCR 引擎执行失败：{tail_error(err or out)}'
            return None, 'ocr-unavailable', 'OCR 引擎未产出结果文件'
        # 引擎把"引擎不可用"写在 error 字段里（退出码仍是 0）——必须映射成 ocr-unavailable，
        # 否则会落到 empty("没识别到文字")，把环境问题说成文件问题。
        if data.get('error') and not (data.get('pages') or data.get('text')):
            return None, 'ocr-unavailable', f"OCR 引擎不可用：{data['error']}"
        return data, None, None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# 扫描件 PDF 的**回退** OCR 通道：自己渲染页面再逐页调 ocr_image。
#
# 为什么需要它（实测事实，不是防御性编程）：2026-09-14 之前本仓库 bundled python **没有
# PyMuPDF(fitz)**（site-packages 里有 pypdfium2 但没有 fitz），而 ocr_engine.detect_pages_by_type
# 在 `import fitz` 失败时走早退分支、返回的 dict **不含 total_pages**，紧接着 ocr_pdf 读
# `page_info["total_pages"]` → `KeyError: 'total_pages'`。净效果：走引擎 CLI 的
# `ocr`/`ocr-table` 处理扫描件 PDF 必然崩。而图片路径（ocr_image，用 PIL/cv2）是好的 ——
# 所以这里用**已安装的 pypdfium2** 把每页渲成 PNG，再喂给 ocr_image，等于绕开唯一缺的那块。
#
# 2026-09-14 后续：已把 PyMuPDF 装进 bundled python（`pip install PyMuPDF` → 1.28.2），
# 引擎直读 PDF 与文本层 PDF 的表格提取都已实测可用（detect/ocr-table 均正常，文本层 PDF 能出表格）。
# **这条回退仍然保留**：它是"引擎 CLI 不可用"时的兜底（缺依赖、引擎脚本被改坏、OCR 引擎路径找不到
# 等），成本只是一段备用代码；而一旦删掉，将来任何一次依赖变动都会让扫描件直接变成"导入失败"。
# 另注：引擎里用的是 `import fitz`，PyMuPDF 1.28 仍提供该兼容名（仅 DeprecationWarning，
# 且本进程的 stderr 被丢弃），未来某版移除时会触发本回退——这正是它存在的意义。
#
# 为什么整篇放在**一个**子进程里：OCR 引擎首次加载模型要数秒到数十秒，
# 逐页起进程会把"10 页扫描件"变成"10 次模型加载"。一次进程、循环渲染+识别。
_OCR_RENDER_SCRIPT = r'''
import sys, json, os, tempfile
engine_dir, pdf, project, max_pages = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
sys.path.insert(0, engine_dir)
from ocr_engine import ocr_image
import pypdfium2 as pdfium
doc = pdfium.PdfDocument(pdf)
total = len(doc)
n = min(total, max_pages)
tmpdir = tempfile.mkdtemp(prefix='yfw-kb-ocr-')
pages = []
for i in range(n):
    img_path = os.path.join(tmpdir, 'p%d.png' % (i + 1))
    page = doc[i]
    page.render(scale=2.0).to_pil().save(img_path)
    try:
        r = ocr_image(img_path, project)
    except TypeError:
        r = ocr_image(img_path)
    if isinstance(r, tuple):
        r = r[0] if r and isinstance(r[0], dict) else {}
    r = r if isinstance(r, dict) else {}
    texts = [p.get('text') or '' for p in (r.get('pages') or [])]
    if not texts and r.get('text'):
        texts = [r.get('text')]
    pages.append({'page': i + 1, 'text': '\n'.join(t for t in texts if t)})
    try:
        os.remove(img_path)
    except OSError:
        pass
print(json.dumps({'pages': pages, 'totalPages': total}, ensure_ascii=False))
'''

# 页面渲染脚本（供视觉模型识别表格用）：把 PDF 每页渲成 PNG **保留**在指定目录。
# 与上面的 OCR 脚本分开：OCR 要的是"文字"，视觉模型要的是"图"，且页数上限/触发条件不同。
_RENDER_PAGES_SCRIPT = r'''
import sys, json, os
pdf, out_dir, max_pages = sys.argv[1], sys.argv[2], int(sys.argv[3])
import pypdfium2 as pdfium
out_dir = os.path.abspath(out_dir)
doc = pdfium.PdfDocument(pdf)
total = len(doc)
n = min(total, max_pages)
os.makedirs(out_dir, exist_ok=True)
images = []
for i in range(n):
    img_path = os.path.abspath(os.path.join(out_dir, 'page-%04d.png' % (i + 1)))
    doc[i].render(scale=2.0).to_pil().save(img_path)
    images.append({'page': i + 1, 'path': img_path})
print(json.dumps({'images': images, 'totalPages': total}, ensure_ascii=False))
'''


def render_pdf_pages(path, out_dir, max_pages, warnings):
    """PDF → 每页 PNG（保留在 out_dir），返回 `[{page, path}]`（视觉模型识别表格用）。

    渲染失败**不致命**：返回空列表 + warning，上层据此跳过视觉表格提取，
    正文与 OCR 文本照常入库（表格是增益，不是主体）。
    """
    py = os.environ.get('PONOS_PYTHON') or os.environ.get('YFWORKING_PYTHON') or sys.executable
    try:
        r = subprocess.run([py, '-c', _RENDER_PAGES_SCRIPT, path, out_dir, str(max_pages)],
                           capture_output=True, cwd=os.path.dirname(path) or None,
                           timeout=OCR_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        warnings.append(f'页面渲染超时（>{OCR_TIMEOUT_S}s），跳过视觉表格提取')
        return []
    except Exception as e:
        warnings.append(f'页面渲染启动失败：{e}')
        return []
    out = (r.stdout or b'').decode('utf-8', 'replace')
    err = (r.stderr or b'').decode('utf-8', 'replace')
    line = None
    for ln in reversed(out.split('\n')):
        if ln.strip().startswith('{'):
            line = ln.strip()
            break
    if not line:
        warnings.append(f'页面渲染无输出：{(err or out).strip()[:200]}')
        return []
    try:
        data = json.loads(line)
    except Exception as e:
        warnings.append(f'页面渲染输出非法 JSON：{e}')
        return []
    total = data.get('totalPages') or 0
    if total > max_pages:
        warnings.append(f'仅渲染前 {max_pages}/{total} 页图片（视觉表格提取页数上限）')
    return data.get('images') or []


def _ocr_pdf_via_render(path, opts, warnings):
    """用 pypdfium2 渲染 + ocr_image 逐页识别（引擎 CLI 不可用时的回退通道）。"""
    if not opts.ocr_engine or not os.path.exists(opts.ocr_engine):
        return None, 'ocr-unavailable', '未找到 OCR 引擎 ocr_engine.py'
    py = os.environ.get('PONOS_PYTHON') or os.environ.get('YFWORKING_PYTHON') or sys.executable
    cmd = [py, '-c', _OCR_RENDER_SCRIPT, os.path.dirname(opts.ocr_engine), path,
           opts.project, str(opts.max_ocr_pages)]
    try:
        r = subprocess.run(cmd, capture_output=True, cwd=os.path.dirname(path) or None,
                           timeout=OCR_TIMEOUT_S, env=_child_env())
    except subprocess.TimeoutExpired:
        return None, 'ocr-unavailable', f'扫描件渲染 OCR 超时（>{OCR_TIMEOUT_S}s）'
    except Exception as e:
        return None, 'ocr-unavailable', f'扫描件渲染 OCR 启动失败：{e}'
    out = (r.stdout or b'').decode('utf-8', 'replace')
    err = (r.stderr or b'').decode('utf-8', 'replace')
    line = None
    for ln in reversed(out.split('\n')):
        if ln.strip().startswith('{'):
            line = ln.strip()
            break
    if not line:
        return None, 'ocr-unavailable', f'扫描件渲染 OCR 无输出：{(err or out).strip()[:400]}'
    try:
        data = json.loads(line)
    except Exception as e:
        return None, 'ocr-unavailable', f'扫描件渲染 OCR 输出非法 JSON：{e}'
    if data.get('totalPages', 0) > opts.max_ocr_pages:
        warnings.append(f'扫描件共 {data["totalPages"]} 页，超出 OCR 上限 {opts.max_ocr_pages} 页，'
                        f'仅入库前 {opts.max_ocr_pages} 页')
    return data, None, None


def _pdf_tables_via_pymupdf(path, max_rows, warnings, max_pages=200):
    """文本层 PDF 的**真表格**提取（PyMuPDF `find_tables`）→ {页码: [表格(行×列)]}。

    为什么需要它（实测缺口，2026-09-14）：解析器的文本层分支原先只取 `extract_text()`，
    于是"从 Excel/Word 导出的 PDF"里的表格被压成一行行文本 —— 列关系丢失后，
    Markdown 里就没有表格（而检索也问不出"材料费是多少"这类按列的问题）。
    实测 PyMuPDF 的 `find_tables()` 对带表格线的文本层 PDF 能正确还原行列
    （样件 4 行 × 3 列，单元格内容与坐标一致）。

    为什么用 PyMuPDF 而不是复用 OCR 引擎的表格启发式：引擎那条是**纯文本行**启发式
    （要求每行 ≥2 个数字且空格分隔），而 OCR 文本通常不保留列间距 —— 实测扫描件走引擎
    `ocr-table` 的表格数是 0。文本层 PDF 有真实坐标，直接用 `find_tables()` 才是对的工具。

    约束：
    - 仅文本层 PDF 走这里（扫描件没有坐标可查，仍靠 OCR 通道）。
    - 页数上限 `max_pages`：`find_tables` 要逐页做线框分析，几百页会明显变慢；
      超限只扫前 N 页并**出声**（不静默少给表格）。
    - 任何异常都降级为"无表格 + warning"，**不让整个文档解析失败**
      （表格是增益，正文才是主体；为表格放弃整篇是本末倒置）。
    """
    try:
        try:
            import pymupdf
        except Exception:
            import fitz as pymupdf      # 旧名兼容（PyMuPDF 1.28 仍提供）
    except Exception as e:
        warnings.append(f'未安装 PyMuPDF，跳过文本层表格提取：{e}')
        return {}
    out = {}
    try:
        doc = pymupdf.open(path)
    except Exception as e:
        warnings.append(f'表格提取打开 PDF 失败：{e}')
        return {}
    try:
        n = len(doc)
        if n > max_pages:
            warnings.append(f'表格提取仅扫描前 {max_pages}/{n} 页（超出上限）')
        for i in range(min(n, max_pages)):
            try:
                tabs = doc[i].find_tables()
            except Exception as e:
                warnings.append(f'第 {i + 1} 页表格提取失败：{e}')
                continue
            for t in getattr(tabs, 'tables', []) or []:
                try:
                    rows = [[cell(c) for c in r] for r in (t.extract() or [])]
                except Exception:
                    continue
                rows = [r for r in rows if any(v for v in r)]
                if rows:
                    out.setdefault(i + 1, []).append(
                        truncate_rows(rows, max_rows, warnings, f'第 {i + 1} 页表格'))
    finally:
        try:
            doc.close()
        except Exception:
            pass
    return out


def parse_pdf(path, opts, warnings):
    try:
        pages, encrypted = _pdf_pages_text(path)
    except Exception as e:
        return None, 'parse-error', f'PDF 打开失败：{e}'
    if encrypted:
        return None, 'encrypted', 'PDF 已加密（需口令），无法读取文本层'
    npages = len(pages or [])
    if npages == 0:
        return None, 'empty', 'PDF 没有页面（0 页）'
    total_chars = sum(len(re.sub(r'\s', '', p or '')) for p in (pages or []))
    has_text = total_chars >= PDF_TEXT_MIN_PER_PAGE * npages

    if has_text:
        # 文本层 PDF：正文取 pypdf 的文本，**表格另走 PyMuPDF find_tables**（见该函数头注）
        page_tables = _pdf_tables_via_pymupdf(path, opts.max_table_rows, warnings)
        sections = []
        for i, p in enumerate(pages, 1):
            txt = clean_text(p or '')
            tables = page_tables.get(i, [])
            if txt or tables:
                # 正文为空但该页有表格时也要出节：否则"整页都是表格"的 PDF 会漏掉整页
                sections.append({'heading': f'第 {i} 页', 'level': 1, 'text': txt, 'tables': tables})
        if sections:
            return {'converter': 'pdf-text', 'title': None, 'pages': npages, 'sections': sections}, None, None

    # 扫描件：整篇走 OCR（OCR 引擎自带 is_scanned 判定与逐页结果）
    warnings.append(f'PDF 文本层不足（共 {total_chars} 字 / {npages} 页，低于阈值 '
                    f'{PDF_TEXT_MIN_PER_PAGE} 字/页），已整篇转 OCR 识别')
    data, err_code, err_msg = _ocr_pdf(path, opts, warnings)
    if data is None:
        # 引擎 CLI 不可用（历史上实测的那次：打包 python 缺 PyMuPDF → detect_pages_by_type 早退
        # → ocr_pdf 读 page_info["total_pages"] 抛 KeyError；该依赖 2026-09-14 已补装，
        # 但引擎脚本被改坏/依赖被移除/路径找不到时同样会走到这里）
        # → 回退到 pypdfium2 渲染 + ocr_image。两条都失败时把**两个原因都**报出来，
        # 否则用户只看到"OCR 失败"，分不清是缺依赖还是文件坏了。
        warnings.append(f'OCR 引擎直读失败，已回退渲染识别：{err_msg}')
        data2, code2, msg2 = _ocr_pdf_via_render(path, opts, warnings)
        if data2 is None:
            return None, code2, f'{err_msg}；回退渲染识别也失败：{msg2}'
        data = data2
    all_pages = data.get('pages') or []
    if not all_pages and data.get('text'):
        all_pages = [{'page': 1, 'text': data.get('text')}]
    total_pages = npages or len(all_pages)
    ocr_pages = all_pages
    if len(ocr_pages) > opts.max_ocr_pages:
        warnings.append(f'扫描件共 {len(ocr_pages)} 页，超出 OCR 上限 {opts.max_ocr_pages} 页，'
                        f'仅入库前 {opts.max_ocr_pages} 页')
        ocr_pages = ocr_pages[:opts.max_ocr_pages]
    tables_by_page = {}
    for t in (data.get('tables') or []):
        try:
            tables_by_page.setdefault(int(t.get('page') or 1), []).append(t.get('data') or [])
        except Exception:
            continue
    sections = []
    for p in ocr_pages:
        num = p.get('page') or (len(sections) + 1)
        try:
            num = int(num)
        except Exception:
            num = len(sections) + 1
        rows = [truncate_rows(r, opts.max_table_rows, warnings, f'第 {num} 页表格')
                for r in tables_by_page.get(num, [])]
        txt = clean_text(p.get('text') or '')
        if txt or rows:
            sections.append({'heading': f'第 {num} 页', 'level': 2, 'text': txt, 'tables': rows})
    if not sections:
        return None, 'empty', 'OCR 未识别到任何文本（页面可能为空白或图片质量过低）'
    # 扫描件要识别表格只能靠视觉模型（OCR 文本没有列坐标，引擎的文本启发式实测恒为 0）。
    # 渲染页数上限 = max_vision_pages（视觉调用按页计费/耗时），而不是 max_ocr_pages。
    page_images = []
    if getattr(opts, 'want_page_images', False):
        page_images = render_pdf_pages(path, opts.page_images_dir, opts.max_vision_pages, warnings)
    return {'converter': 'pdf-ocr', 'title': None, 'pages': total_pages,
            'pageImages': page_images, 'sections': sections}, None, None


# ── 图片 ───────────────────────────────────────────────────────────────────
def parse_image(path, opts, warnings):
    if not opts.ocr_engine or not os.path.exists(opts.ocr_engine):
        return None, 'ocr-unavailable', '未找到 OCR 引擎 ocr_engine.py（设置 PONOS_OCR_ENGINE 或确认技能库已安装）'
    # 图片走引擎的**内联函数**而非 CLI：CLI 的 ocr 子命令面向 PDF（用 fitz 包装图片会被判为空白页）。
    # 与内核 OCR 工具的做法一致（kernel/tools.mjs:893-903）——同一条既有结论，不重新踩一遍。
    # 签名跨版本确实有差异（实测：本机三个副本里 .ponos 版是 ocr_image(path, project_name, enhance=True)），
    # 故**不写死一个签名**：两个位置参数 → 关键字 → 单参数，依次尝试，任一收得下即用。
    script = '\n'.join([
        'import sys, json',
        f'sys.path.insert(0, {json.dumps(os.path.dirname(opts.ocr_engine))})',
        'from ocr_engine import ocr_image',
        f'P = {json.dumps(path)}',
        f'PR = {json.dumps(opts.project)}',
        'forms = (lambda: ocr_image(P, PR), lambda: ocr_image(P, project_name=PR), lambda: ocr_image(P))',
        'r = None',
        'e = None',
        'for fn in forms:',
        '    try:',
        '        r = fn(); break',
        '    except TypeError as exc:',
        '        e = exc',
        'print(json.dumps(r if r is not None else {"error": "ocr_image 调用失败：" + str(e)}, ensure_ascii=False))',
    ])
    py = os.environ.get('PONOS_PYTHON') or os.environ.get('YFWORKING_PYTHON') or sys.executable
    try:
        r = subprocess.run([py, '-c', script], capture_output=True, env=_child_env(),
                           cwd=os.path.dirname(path) or None, timeout=OCR_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None, 'ocr-unavailable', f'OCR 超时（>{OCR_TIMEOUT_S}s）'
    except Exception as e:
        return None, 'ocr-unavailable', f'OCR 引擎启动失败：{e}'
    out = (r.stdout or b'').decode('utf-8', 'replace')
    err = (r.stderr or b'').decode('utf-8', 'replace')
    # 引擎初始化日志会混进 stdout —— JSON 是最后一个以 { 开头的行（同内核做法）
    line = None
    for ln in reversed(out.split('\n')):
        if ln.strip().startswith('{'):
            line = ln.strip()
            break
    data = None
    if line:
        try:
            data = json.loads(line)
        except Exception:
            data = None
    if data is None:
        return None, 'ocr-unavailable', f'OCR 引擎输出无效：{tail_error(err or out)}'
    if data.get('error'):
        return None, 'ocr-unavailable', f"OCR 失败：{data['error']}"
    pages = data.get('pages') or []
    texts = [clean_text(p.get('text') or '') for p in pages] if pages else [clean_text(data.get('text') or '')]
    txt = clean_text('\n'.join(t for t in texts if t))
    tables = [truncate_rows(t.get('data') or [], opts.max_table_rows, warnings, '图片表格')
              for t in (data.get('tables') or [])]
    if not txt and not any(tables):
        return None, 'empty', 'OCR 未在图片中识别到文本'
    # 视觉模型要识别表格就得有"图"。图片输入本身就是图，**直接复用原文件**（不复制、不重编码），
    # 页码固定 1 —— 上层按 page 号找 section 时能对上（图片只有一个无标题 section）。
    page_images = [{'page': 1, 'path': path}] if getattr(opts, 'want_page_images', False) else []
    return {'converter': 'ocr', 'title': None, 'pages': max(1, len(pages)),
            'pageImages': page_images,
            'sections': [{'heading': None, 'level': 0, 'text': txt, 'tables': [t for t in tables if t]}]}, None, None


# ── 分派 ───────────────────────────────────────────────────────────────────
DISPATCH = {
    '.docx': parse_docx,
    '.docm': parse_docx,     # 带宏 Word：同样是 OOXML zip，python-docx 直接能读
    '.xlsx': parse_xlsx,
    '.xlsm': parse_xlsx,     # 带宏 Excel：openpyxl 同样能读（只取取值，不碰宏）
    '.xls': parse_xls,
    '.pptx': parse_pptx,
    '.pptm': parse_pptx,
    '.pdf': parse_pdf,
    '.csv': parse_csv,
    '.tsv': parse_csv,       # 制表符分隔：交给 CSV 的 Sniffer 判分隔符即可
}
# main 用它在分派**之前**给出确定性的错误优先级：not-found > unsupported > empty > 各解析错误。
SUPPORTED_EXTS = set(DISPATCH) | set(IMAGE_EXTS) | set(TEXT_EXTS)
_LEGACY_MSG = '{ext} 是旧版二进制 Office 格式，暂不支持（请另存为 {target} 后重试）'


def parse_one(path, opts, warnings):
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXTS:
        return parse_image(path, opts, warnings)
    if ext in DISPATCH:
        return DISPATCH[ext](path, opts, warnings)
    if ext in TEXT_EXTS:
        return parse_text(path, opts, warnings)
    # .doc/.ppt（97-2003 二进制格式）没有可用解析器：明确报不支持，而不是产出空文档。
    if ext in ('.doc', '.ppt'):
        return None, 'unsupported', _LEGACY_MSG.format(
            ext=ext, target='.docx' if ext == '.doc' else '.pptx')
    return None, 'unsupported', f'不支持的扩展名：{ext or "(无扩展名)"}'


def main():
    ap = argparse.ArgumentParser(description='文档 → 结构化内容（文件知识库导入用）')
    ap.add_argument('--input', required=True, help='源文件路径')
    ap.add_argument('--project', default='kb-import', help='OCR 缓存隔离用项目名')
    ap.add_argument('--max-ocr-pages', type=int, default=200)
    ap.add_argument('--max-table-rows', type=int, default=MAX_TABLE_ROWS)
    ap.add_argument('--ocr-engine', default=None, help='ocr_engine.py 路径（缺省用同目录）')
    # 视觉模型识别表格（2026-09-14）：只在调用方明确给出目录时才渲染/返回页面图片。
    # 为什么用"给目录"而不是布尔开关：渲染出的 PNG 必须**留在磁盘上**给上层的视觉调用读，
    # 所以调用方（node）得指定一个自己负责清理的目录 —— 避免解析器猜临时路径、
    # 也避免默认行为变化（不给参数就完全不渲染，零磁盘与零耗时开销）。
    ap.add_argument('--emit-page-images', default=None, metavar='DIR',
                    help='把 PDF 每页渲染成 PNG 写入该目录，并在结果里返回 pageImages（视觉模型识别表格用）')
    ap.add_argument('--max-vision-pages', type=int, default=20,
                    help='渲染/交给视觉模型的最大页数（默认 20；视觉调用按页计费与耗时）')
    try:
        opts = ap.parse_args()
    except SystemExit as e:
        if e.code in (0, None):      # -h/--help：正常退出，不塞 JSON
            raise
        # 参数写错也让 stdout 保持"一行 JSON"——T2 只有一条读取路径，不需要额外的 usage 分支。
        return emit_error('parse-error', '命令行参数无效：需要 --input <文件>（详见 --help）')
    opts.max_ocr_pages = max(0, int(opts.max_ocr_pages))
    opts.max_table_rows = max(0, int(opts.max_table_rows))
    opts.max_vision_pages = max(0, int(getattr(opts, 'max_vision_pages', 20)))
    opts.page_images_dir = getattr(opts, 'emit_page_images', None)
    opts.want_page_images = bool(opts.page_images_dir)
    if not opts.ocr_engine:
        cand = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ocr_engine.py')
        opts.ocr_engine = os.environ.get('PONOS_OCR_ENGINE') or (cand if os.path.exists(cand) else None)
    if opts.ocr_engine:
        # 必须**绝对化**：OCR 子进程的 cwd 是源文件所在目录，相对路径（含 sys.path 里的目录）
        # 会在那边解析到别处，症状是"引擎明明存在却 can't open file"。
        opts.ocr_engine = os.path.abspath(opts.ocr_engine)

    # 解析期间把 sys.stdout 改道到 stderr：万一某个库往 stdout print（极难排查），
    # 契约通道（sys.__stdout__，见 emit）也不会出现第二行 JSON。
    sys.stdout = sys.stderr

    path = os.path.abspath(opts.input)
    if not os.path.exists(path):
        return emit_error('not-found', f'文件不存在：{path}')
    if os.path.isdir(path):
        return emit_error('not-found', f'是目录不是文件：{path}')
    try:
        source_bytes = os.path.getsize(path)
    except OSError:
        source_bytes = None
    ext = os.path.splitext(path)[1].lower()
    if ext not in SUPPORTED_EXTS:
        if ext in ('.doc', '.ppt'):
            msg = _LEGACY_MSG.format(ext=ext, target='.docx' if ext == '.doc' else '.pptx')
        else:
            msg = f'不支持的扩展名：{ext or "(无扩展名)"}'
        return emit_error('unsupported', msg, source_bytes)
    if source_bytes == 0:
        # 0 字节任何格式都读不出内容：统一报 empty（不要让它落到各库的异常里变成 parse-error）。
        return emit_error('empty', '文件为空（0 字节）', source_bytes)

    warnings = []
    try:
        result, err_code, err_msg = parse_one(path, opts, warnings)
    except Exception as e:
        result, err_code, err_msg = None, 'parse-error', f'未预期错误：{e}'
    if result is None:
        return emit_error(err_code or 'parse-error', err_msg or '解析失败', source_bytes, warnings)
    for s in result.get('sections') or []:
        # 契约归一：sections 四项恒存在，node 侧渲染器不必到处判 undefined。
        s.setdefault('heading', None)
        s.setdefault('level', 0)
        s.setdefault('text', '')
        s.setdefault('tables', [])
    # 空正文（只解析出标题/空节）也算失败：入库空文档会在索引里留一个查不到的壳，
    # 用户看到"导入成功"却搜不到任何内容——比明说失败更坏。
    if not any((s.get('text') or '').strip() or s.get('tables') for s in result.get('sections') or []):
        return emit_error('empty', '未提取到任何可入库内容', source_bytes, warnings)
    result.setdefault('title', None)
    result.setdefault('pages', None)
    result.update({'ok': True, 'sourceBytes': source_bytes,
                   'warnings': warnings + list(result.get('warnings') or [])})
    return emit(result)


if __name__ == '__main__':
    main()
