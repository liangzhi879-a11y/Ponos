"""Word 应用内编辑：块模型读取（真序 + 稳定 blockId + baseVersion）+ ops 写入。

用法:
  docx_edit.py read  <path>
      → {"ok":true,"baseVersion":"<sha256>",
         "blocks":[{"blockId":..,"kind":"h1|h2|h3|p","text":..} | {"blockId":..,"kind":"table","rows":..}]}
  docx_edit.py write <jsonPath>
      → 入参 {"path","baseVersion","ops":[{"op":"update","blockId":..,"text":..}, …]}
      → {"ok":true,"baseVersion":"<写入后的新版本>"}

—— 为什么写入契约长这样（spec §6.1 / 批注 #2 定案，都是实测逼出来的）——
* **旧的全量 `blocks` 写入不保留**：收到只带 `blocks` 的请求 ⇒ **显式报错**，不得静默降级到旧逻辑。
* **`zip()` 原地覆盖已删除**（B1 根除）。它最致命的形态不是"写错"，而是**数量不匹配时静默按位错位**：
  客户端少发一个块，第 2 段的内容就会被写进第 1 段 —— 不报错、不告警，用户以为存好了。
* **寻址一律用 `blockId`，禁用序号**（B5 实测：序号寻址在插入/删除后 17/17 崩到 2/17）。
* **`baseVersion` 必需**：它是"提交时基线"与**防丢失更新**的唯一依据。缺即拒绝；不匹配即拒绝
  （用户重新载入，而不是让他的改动去覆盖别人的改动）。

—— blockId 的三性质（spec §6.1）与实现取舍 ——
* **幂等**：同一文件多次读 ⇒ 同一 id。做法：id 只由**内容**决定（不掺位置、不掺时间）。
* **稳定**：内容相同、XML 表示不同的文件（Word 重存）⇒ 同一 id。做法：只用 `p.text`（归一化后的
  文本）与表格 cell 文本，**绝不掺 `rsid`/`w:proofErr` 等修订噪声**（Word 每次重存都会改它们）。
* **归一化**：比对前抹平空白差异（连续空白折成一个空格、去首尾）——沿用仓库既有先例
  （`TEXT_EXTS` 行尾归一）的口径。
* **重复内容的消歧**：纯内容哈希在"文档里有两段一模一样的文字"时必然撞车，故追加**出现序号**
  （`<12位hex>:<第几次出现>`）。代价：在别处插入同内容段会让后续同名块序号漂移 —— 这是已知限制，
  已在 plan 的 D-2 记录（将来若要根除，需把 id 物化进文档，属改用户文件本体，未做）。
"""
import json
import os
import sys

from docx.oxml.ns import qn

# 本仓库的 python 是**嵌入式发行版**（runtime/python 下有 `python312._pth`）：它按 `._pth`
# 决定 sys.path，**不会**像常规解释器那样自动把"脚本所在目录"加进去。所以这里必须显式补一次，
# 否则 `import office_common` 直接 ModuleNotFoundError（实测确实如此，不是理论风险）。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 归一化与版本口径取自共享件（与 sheet_edit.py **同一套规则**）：
# 两边各写一份会漂移，而"两边判等口径不一致"在协同里直接表现为合并结果悄悄不对。
from office_common import assign_ids, content_id, digest12, file_sha256, norm_text

# 可识别的块标签（body 的子元素里，只有这两种是"块"；其余如 w:sectPr 是节属性，跳过）
_BLOCK_TAGS = (qn("w:p"), qn("w:tbl"))

# 标题样式名 → 块 kind（沿用旧实现的识别口径，保证既有前端不受影响）
_HEADING_KINDS = (("Heading 1", "h1"), ("Heading 2", "h2"), ("Heading 3", "h3"))

# kind → python-docx 的样式名（新建块用；样式缺失时退回默认，不因样式问题让整批失败）
_KIND_TO_STYLE = {"h1": "Heading 1", "h2": "Heading 2", "h3": "Heading 3"}


# ---------------------------------------------------------------------------
# 基础
# ---------------------------------------------------------------------------
# 归一化（norm_text）、内容指纹（content_id）与版本哈希（file_sha256）定义在 `office_common.py`，
# 与 `sheet_edit.py` 共用同一份实现 —— 见该文件顶部说明。


def _para_kind(p):
    style = p.style.name if p.style else ""
    for name, kind in _HEADING_KINDS:
        if name in style:
            return kind
    return "p"


def _table_rows(table):
    return [[cell.text for cell in row.cells] for row in table.rows]


def _rows_payload(rows):
    """表格的指纹载荷：紧凑 JSON（键序无关由列表结构天然保证）。"""
    return json.dumps(rows, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------------------
# C4 格式指纹：把"格式"变成块模型里**可见**的东西（B4）
# ---------------------------------------------------------------------------
# B4 的现象：只读 `p.text` ⇒ "仅把某段改成粗体"会被判定为**块序列完全一致**，
# 格式修改在协同里彻底不可见（验收标准 §10-S1-5 要求"不再被判定为无变化"）。
#
# —— 为什么不把格式并进 blockId（对 D-2 的实测修正）——
# spec 明写 blockId 的稳定性"因基于 p.text"，且 C4 引入格式指纹后须**重验 T2**。
# 实测（tools/docx_format_probe.py diff base.docx word_resaved.docx）发现一处真实噪声：
#   python-docx 写 `w:pStyle w:val="Heading1"`（**样式名**），
#   Word 重存后变成 `w:pStyle w:val="3"`（**styleId**）—— 同一段落、同一外观。
# 若格式并进 id，这类噪声会让"用户在 Word 里打开又保存"把标题块的 id 全部换掉，
# 三路合并随即把整篇判成"删旧增新"。而把格式作为**独立字段**还能带来一个关键好处：
# "甲改格式 + 乙改文字"落在同一个 blockId 上 ⇒ 可合并；并进 id 则退化成删除+新增 ⇒ 必然互斥。

# 修订噪声：Word 每次重存/编辑轨迹都可能改这些，且它们**不是外观**
_NOISE_TAGS = {
    "proofErr",          # 拼写/语法标记
    "ins", "del",        # 修订插入/删除
    "moveFrom", "moveTo",
    "rPrChange", "pPrChange", "tblPrChange", "trPrChange", "tcPrChange", "sectPrChange",
    "bookmarkStart", "bookmarkEnd",  # 书签位置随编辑漂移
    "lastRenderedPageBreak",
}

# Word 保存时会把"表样式里继承来的外观"**物化**成直接格式（实测：补写下列元素，取值等于
# 样式自身定义，外观未变）。它们不参与表格格式指纹，否则 T2 必然失败 —— 详见 `_table_format`。
_TABLE_MATERIALIZED = {
    "tblBorders", "tblCellMar", "tblInd", "tblLayout", "tblLook",
    "top", "left", "bottom", "right", "insideH", "insideV", "start", "end",
}


def _canon_attrs(node):
    """规范化属性：丢掉 `rsid*` 类噪声（`w:rsidR`/`w:rsidRPr`…每次保存都可能变）。"""
    out = {}
    for k, v in node.attrib.items():
        name = k.split("}")[-1]
        if name.startswith("rsid"):
            continue
        out[name] = v
    return out


def _fmt_items(el, style_name=None, style_tags=("pStyle", "rStyle"), skip_tags=()):
    """把 `pPr`/`rPr`/`tblPr` 元素摊平成 (标签, 规范化属性) 列表。

    **先摊平再排序**是有意为之：只比较"格式项的集合"，不比较 XML 书写顺序与命名空间声明
    —— 实测那两项都会因序列化工具不同而产生**假差异**（首版探针就踩过：run 级报 1 处差异，
    剥掉命名空间声明后差异为 0）。
    `pStyle`/`rStyle`/`tblStyle` 的 `val` 换成**样式名**：实测这是重存噪声的修法 ——
    python-docx 写 `w:pStyle w:val="Heading1"`（样式名）而 Word 重存写 `w:val="3"`（styleId）；
    表同理（`TableGrid` → `33`）。
    """
    if el is None:
        return []
    items = []
    for node in el.iter():
        if node is el:
            continue
        tag = node.tag.split("}")[-1]
        if tag in _NOISE_TAGS or tag in skip_tags:
            continue
        attrs = _canon_attrs(node)
        if tag in style_tags and style_name:
            attrs["val"] = style_name
        items.append((tag, tuple(sorted(attrs.items()))))
    return items


def _digest_of(items):
    """格式项集合 → 12 位摘要（同一外观即同一摘要）。"""
    payload = json.dumps(sorted(items), ensure_ascii=False, separators=(",", ":"))
    return digest12("format", payload)


def _style_name_of(style):
    try:
        return style.name if style else None
    except Exception:
        return None


def _doc_defaults_items(part, which):
    """文档默认值（`docDefaults`）里的格式项 —— 继承链的最顶端。"""
    try:
        styles_el = part.styles_element
    except Exception:
        return set()
    node = styles_el.find(qn("w:docDefaults"))
    if node is None:
        return set()
    holder = node.find(qn("w:rPrDefault")) if which == "rPr" else node.find(qn("w:pPrDefault"))
    if holder is None:
        return set()
    return {_item_key(it) for it in _fmt_items(holder.find(qn("w:" + which)))}


def _inherited_items(style, part, which):
    """汇总"从样式继承而来的格式项"（样式链 + 文档默认值）。

    用途：**剔除 Word 物化出的冗余直配**。实测（base.docx vs word_resaved.docx）Word 保存时
    会把"从样式继承来的外观"写成**直接格式**：单元格段落被补上
    `w:spacing(after=0,line=240,lineRule=auto)`，而该值正是单元格样式本身的定义，外观一字未变。
    若不做这个剔除，T2 必红（每次"在 Word 里打开又保存"都被读成"格式被改"）。

    这个口径同时**提高判别力**：指纹反映的是**有效外观**而非 XML 书写方式 ——
    "把段落间距设成与样式相同的值"本就不改变外观，不该算格式变更。
    """
    out = _doc_defaults_items(part, which)
    seen = 0
    while style is not None and seen < 10:
        el = getattr(style, "element", None)
        if el is not None:
            node = el.find(qn("w:" + which))
            for it in _fmt_items(node):
                out.add(_item_key(it))
        style = getattr(style, "base_style", None)
        seen += 1
    return out


def _item_key(item):
    return (item[0], tuple(sorted(item[1])))


def _direct_items(el, style_name, inherited, style_tags=("pStyle", "rStyle"), skip_tags=()):
    """取"直接格式项"，剔除与继承值相同的冗余项（见 `_inherited_items`）。"""
    items = _fmt_items(el, style_name, style_tags=style_tags, skip_tags=skip_tags)
    # 样式引用（pStyle/rStyle）本身就是"继承"的意思，必须保留（换标题层级是真变更）
    keep = []
    for it in items:
        if it[0] in ("pStyle", "rStyle", "tblStyle"):
            keep.append(it)
        elif _item_key(it) not in inherited:
            keep.append(it)
    return keep


def _para_format(p):
    """段落的格式指纹：段级 `pPr` + run 级 `rPr`（相邻同格式的 run 折叠；继承冗余项剔除）。

    为什么折叠相邻同格式 run：`<w:r>ab</w:r>` 与 `<w:r>a</w:r><w:r>b</w:r>`（格式相同）
    是**同一外观的两种表示**，Word 重存就可能这么改。不折叠的话"重存"会被读成格式变更。
    折叠只去掉"表示差异"：格式**真正交替**（粗体→正常→粗体）时序列原样保留。
    """
    part = p.part
    p_pr = p._p.find(qn("w:pPr"))
    style_name = _style_name_of(p.style)
    para_items = _direct_items(p_pr, style_name, _inherited_items(p.style, part, "pPr"))

    para_rpr_inherited = _inherited_items(p.style, part, "rPr")
    run_digests = []
    for r in p.runs:
        inherited = set(para_rpr_inherited) | _inherited_items(getattr(r, "style", None), part, "rPr")
        d = _digest_of(_direct_items(r._r.find(qn("w:rPr")), _style_name_of(getattr(r, "style", None)), inherited))
        if not run_digests or run_digests[-1] != d:
            run_digests.append(d)
    return {
        "digest": _digest_of(para_items + [("__runs__", tuple(run_digests))]),
        "style": style_name,
        "runFormats": len(run_digests),
    }


def _table_format(table):
    """表格的格式指纹：`tblPr` 摘要（剔除"可被物化"的属性组）+ 表样式名。

    实测依据（tools/docx_format_probe.py 对比 base.docx 与 word_resaved.docx）：
    Word 保存时会把**表样式里继承来的外观物化成直接格式** —— 实测补写了
    `tblBorders`/`tblCellMar`/`tblInd`/`tblLayout`/`tblLook`，取值等于样式自身的定义，
    **外观一字未变**。若不剔除，那么"用户在 Word 里打开又保存"会被读成"整表格式被改"，
    T2（spec 明列的不变量）必然失败。

    代价（如实记账，登记终验）：**用直接格式改表格边框/边距/缩进/布局**这类改动在本指纹里
    **不可见**；表格的**结构**变更（增删行列、单元格文本）以及表样式切换仍完全可见。
    选它是因为 T2 是硬不变量，而"改边框"属低频且不影响内容正确性的改动。
    """
    return {
        "digest": _digest_of(_fmt_items(
            table._tbl.find(qn("w:tblPr")),
            _style_name_of(table.style),
            style_tags=("tblStyle",),
            skip_tags=_TABLE_MATERIALIZED,
        )),
        "style": _style_name_of(table.style),
    }


def _texts_payload(texts):
    """一行/一列的指纹载荷（单元格文本归一化后拼接；`\\x1f` 不会出现在正常文本里）。"""
    return "\x1f".join(norm_text(t) for t in texts)


def _table_cells_view(rows):
    """C3 细粒度视图：把整表降维成"行 id + 列 id"的单元格网格。

    spec §6.1-C3 要的是"合并粒度下沉到单元格"（B2：甲改 (1,1)、乙改 (1,2) 应能自动合成，
    而整表原子性让它们被误判为 1 冲突）。这里给出对齐所需的坐标框架：
      * `rowIds` 按**行内容指纹**算 ⇒ 在某处插入一行不会让其他行的身份漂移（B6 的表格版）；
      * `colIds` 同理按列内容指纹算；
      * 单元格身份 = `rowId + '#' + colId`（组合规则公开，调用方无需再学一套 id 生成）；
      * `values` 与 `rowIds`/`colIds` **同序同长**（错位一格就会把改动写到别的格上）。

    —— 为什么不给每格加"格式指纹"（实测取舍，登记终验）——
    曾实现 `cellFormats`（每格格式摘要），**T2 立即失败**：Word 保存时把**单元格样式**的属性
    物化成单元格段落的直配 —— 实测 base 的单元格段落无 `w:spacing`，重存后被补上
    `(after=0, line=240, lineRule=auto)`，而该值属于**表/单元格样式链**（同一段落的段落样式
    Normal 在重存件里是 `(after=200, line=276)`，两者不同），故"剔除继承冗余项"这条通用修法
    在此够不着（S1 不解析表样式链）。另一可选方案是"运行级白名单"，但它依赖
    "Word 不会物化运行级属性"这一**未经证实的假设**，一旦不成立就以 T2 全线失守为代价。
    取舍：**放弃单元格级格式指纹，保住 T2（spec 明列的硬不变量）**。单元格的**文本**改动与
    表格**结构**改动仍完全可见；段落级格式指纹（含 run 级）与表格级指纹照常提供。

    **保留粗粒度 `rows` 是有意的（D-3 双视图）**：spec §6.1 非目标明写"不改编辑器 UI"，
    而 `DocxEditor` 现按 `rows` 渲染 ⇒ 若只留细粒度，就必须改 UI（与自身非目标冲突）。
    """
    ncols = max((len(r) for r in rows), default=0)
    padded = [list(r) + [""] * (ncols - len(r)) for r in rows]
    row_ids = assign_ids("trow", [_texts_payload(r) for r in padded])
    col_ids = assign_ids("tcol", [_texts_payload([r[c] if c < len(r) else "" for r in padded]) for c in range(ncols)])
    return {"rowIds": row_ids, "colIds": col_ids, "values": padded}


def _enumerate_blocks(doc):
    """按 **body 子元素真序** 产出块（表格穿插在正确位置），并附元素引用供写入使用。

    这是 C2 的核心修正：旧实现先把 `doc.paragraphs` 全列出来、再列 `doc.tables`，
    于是**所有表格被挪到末尾**（B3）。块序错 ⇒ 序号寻址会插错位置、三路合并的下标映射整体错位。
    """
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    out = []
    occurrence = {}
    for child in doc.element.body.iterchildren():
        if child.tag not in _BLOCK_TAGS:
            continue  # 例如 w:sectPr：节属性，不是内容块
        if child.tag == qn("w:p"):
            para = Paragraph(child, doc)
            kind = _para_kind(para)
            payload = norm_text(para.text)
            key = (kind, payload)
            occurrence[key] = occurrence.get(key, 0) + 1
            out.append({
                "blockId": content_id(kind, payload, occurrence[key]),
                "kind": kind,
                "text": para.text,
                # C4：格式进入块模型（不入 id —— 理由见 `_NOISE_TAGS` 上方说明）
                "format": _para_format(para),
                "obj": para,
                "element": child,
            })
        else:
            table = Table(child, doc)
            rows = _table_rows(table)
            key = ("table", _rows_payload(rows))
            occurrence[key] = occurrence.get(key, 0) + 1
            out.append({
                "blockId": content_id("table", key[1], occurrence[key]),
                "kind": "table",
                "rows": rows,
                # C3：细粒度单元格视图（与粗粒度 rows 并存，双视图）
                "tableCells": _table_cells_view(rows),
                "format": _table_format(table),
                "obj": table,
                "element": child,
            })
    return out


def _public_blocks(blocks):
    """剥掉仅供内部使用的元素引用，产出可序列化的块（保证输出里没有非 JSON 字段）。"""
    out = []
    for b in blocks:
        if b["kind"] == "table":
            out.append({
                "blockId": b["blockId"], "kind": "table", "rows": b["rows"],
                "tableCells": b["tableCells"], "format": b["format"],
            })
        else:
            out.append({
                "blockId": b["blockId"], "kind": b["kind"], "text": b["text"], "format": b["format"],
            })
    return out


def _err(code, message, **extra):
    payload = {"ok": False, "code": code, "error": message}
    payload.update(extra)
    return payload


# ---------------------------------------------------------------------------
# read
# ---------------------------------------------------------------------------

def read_docx(path):
    from docx import Document
    if not path or not os.path.exists(path):
        return _err("file-missing", f"文件不存在：{path}")
    doc = Document(path)
    blocks = _enumerate_blocks(doc)
    return {"ok": True, "baseVersion": file_sha256(path), "blocks": _public_blocks(blocks)}


# ---------------------------------------------------------------------------
# 写：段落 / 表格
# ---------------------------------------------------------------------------

def set_para_text(p, new_text):
    """整段改写文本：写入第一个有文本的 run，其余 run 文本清空（保留段落样式）。
    纯图片/无文本 run 的段落跳过，不破坏嵌入对象。
    注意：p.runs 每次访问重建包装对象，必须按索引操作，不能比较对象同一性。

    ⚠️ 已知行为（步骤 1 的测试已锁住，属 C4 范围）：新文本整体落进**第一个 run**、其余 run 清空，
    因此整段会继承首 run 的格式（原本"粗体+普通"的混合段落会变成全粗体）。S1 的 C4 要求
    "格式变更不得静默丢弃"；在此之前，这一行为是**已知且被测试钉住**的，不是意外。
    """
    runs = p.runs
    if not runs:
        return
    texts = [r.text for r in runs]
    if not any(texts):
        return  # 纯图片/空段，不写
    idx = next((i for i, t in enumerate(texts) if t), 0)
    runs[idx].text = new_text
    for i, r in enumerate(runs):
        if i != idx:
            r.text = ""


def _write_table_rows(table, rows):
    """按行覆盖表格 cell 文本（保留表结构）。

    仍是"按位覆盖"的粗粒度写：C3 会把表格降维成行/单元格子块、让粒度下沉到单元格。
    此阶段保持该能力，是为了不把"表格能编辑"这件事在 C1 里丢掉（否则 UI 的表格编辑会直接不可用）。
    """
    for ri, row in enumerate(rows):
        if ri >= len(table.rows):
            break
        cells = table.rows[ri].cells
        for ci, val in enumerate(row):
            if ci >= len(cells):
                break
            if cells[ci].paragraphs:
                set_para_text(cells[ci].paragraphs[0], str(val))


# ---------------------------------------------------------------------------
# 写：新建块 / 插入位置
# ---------------------------------------------------------------------------

def _first_block_element(doc):
    for child in doc.element.body.iterchildren():
        if child.tag in _BLOCK_TAGS:
            return child
    return None


def _insert_element(doc, element, after_id, by_id):
    """把 element 放到 after_id 指定块之后；after_id 为空 ⇒ 放到文档最前。"""
    if after_id:
        ref = by_id.get(after_id)
        if ref is None:
            return _err("block-not-found", f"ops 引用了不存在的块：{after_id}")
        ref["element"].addnext(element)
        return None
    first = _first_block_element(doc)
    if first is not None:
        first.addprevious(element)
        return None
    # 空文档：body 里可能只有 sectPr，必须插到它**之前**（sectPr 必须留在最后）
    sect = doc.element.body.find(qn("w:sectPr"))
    if sect is not None:
        sect.addprevious(element)
    else:
        doc.element.body.append(element)
    return None


def _make_block(doc, spec):
    """按 {"kind","text"|"rows"} 造一个新块，返回其元素。"""
    kind = (spec or {}).get("kind") or "p"
    if kind == "table":
        rows = spec.get("rows") or []
        ncols = max((len(r) for r in rows), default=0)
        table = doc.add_table(rows=max(len(rows), 1), cols=max(ncols, 1))
        _write_table_rows(table, rows)
        return table._element

    text = spec.get("text") or ""
    style = _KIND_TO_STYLE.get(kind)
    if style:
        try:
            return doc.add_paragraph(text, style=style)._element
        except KeyError:
            # 样式不在该文档的样式表里：退回默认段落，**不因样式缺失让整批失败**
            # （宁可少一个标题层级，也不要用户"改一个字都存不进去"）
            pass
    return doc.add_paragraph(text)._element


# ---------------------------------------------------------------------------
# write（ops-only）
# ---------------------------------------------------------------------------

def write_docx(body):
    from docx import Document

    if not isinstance(body, dict):
        return _err("bad-request", "请求体必须是 JSON 对象")
    path = body.get("path")
    if not path:
        return _err("path-required", "缺少 path")

    # ① 旧写法必须**显式报错**，不得静默降级（批注 #2 定案）
    if not body.get("ops"):
        if "blocks" in body:
            return _err(
                "legacy-blocks-not-supported",
                "写入必须使用 ops：旧的全量 blocks 写法已停用（它在数量不匹配时会静默按位错位写，造成数据丢失）。"
                "请改用 {\"ops\":[{\"op\":\"update\",\"blockId\":…,\"text\":…}]} 形式。",
            )
        return _err("ops-required", "缺少 ops（本次没有任何编辑操作）")

    # ② baseVersion 必需（防丢失更新）
    base_version = body.get("baseVersion")
    if not base_version:
        return _err("base-version-required", "缺少 baseVersion：它是防止覆盖他人改动的依据，必需字段")
    if not os.path.exists(path):
        return _err("file-missing", f"文件不存在：{path}")
    actual = file_sha256(path)
    if actual != base_version:
        return _err(
            "base-version-mismatch",
            "文件已被其他程序或协作者修改，为避免覆盖对方的改动，本次写入被拒绝；请重新载入后再编辑。",
            expected=base_version,
            actual=actual,
        )

    doc = Document(path)
    base_blocks = _enumerate_blocks(doc)
    by_id = {b["blockId"]: b for b in base_blocks}

    deleted = set()
    applied = []
    for i, op in enumerate(body["ops"]):
        if not isinstance(op, dict):
            return _err("bad-op", f"第 {i + 1} 个操作不是对象")
        name = op.get("op")

        if name == "update":
            target = op.get("blockId")
            b = by_id.get(target)
            if b is None:
                return _err("block-not-found", f"第 {i + 1} 个操作引用了不存在的块：{target}")
            if target in deleted:
                return _err("block-deleted", f"第 {i + 1} 个操作引用了本批次中已删除的块：{target}")
            if b["kind"] == "table":
                if op.get("rows") is None:
                    return _err("rows-required", f"第 {i + 1} 个操作更新表格但缺少 rows")
                _write_table_rows(b["obj"], op["rows"])
            else:
                if op.get("text") is None:
                    return _err("text-required", f"第 {i + 1} 个操作更新段落但缺少 text")
                set_para_text(b["obj"], op["text"])
            applied.append({"op": "update", "blockId": target})

        elif name == "delete":
            target = op.get("blockId")
            b = by_id.get(target)
            if b is None:
                return _err("block-not-found", f"第 {i + 1} 个操作引用了不存在的块：{target}")
            if target in deleted:
                return _err("block-deleted", f"第 {i + 1} 个操作重复删除同一块：{target}")
            parent = b["element"].getparent()
            if parent is not None:
                parent.remove(b["element"])
            deleted.add(target)
            applied.append({"op": "delete", "blockId": target})

        elif name == "insert":
            element = _make_block(doc, op.get("block") or {})
            after_id = op.get("after")
            if after_id and after_id in deleted:
                return _err("block-deleted", f"第 {i + 1} 个操作的锚点块已被本批次删除：{after_id}")
            bad = _insert_element(doc, element, after_id, by_id)
            if bad:
                return bad
            applied.append({"op": "insert", "after": after_id or None})

        elif name == "move":
            target = op.get("blockId")
            b = by_id.get(target)
            if b is None:
                return _err("block-not-found", f"第 {i + 1} 个操作引用了不存在的块：{target}")
            if target in deleted:
                return _err("block-deleted", f"第 {i + 1} 个操作引用了已删除的块：{target}")
            after_id = op.get("after")
            if after_id == target:
                return _err("bad-move", f"第 {i + 1} 个操作试图把块移动到自己之后")
            if after_id and after_id in deleted:
                return _err("block-deleted", f"第 {i + 1} 个操作的锚点块已被本批次删除：{after_id}")
            element = b["element"]
            parent = element.getparent()
            if parent is not None:
                parent.remove(element)
            bad = _insert_element(doc, element, after_id, by_id)
            if bad:
                return bad
            applied.append({"op": "move", "blockId": target, "after": after_id or None})

        else:
            return _err("unknown-op", f"第 {i + 1} 个操作类型无法识别：{name}")

    try:
        doc.save(path)
    except PermissionError as e:
        return _err("file-locked", f"文件被占用，无法写入（可能正被 Word/网盘同步进程锁定）：{e}")

    return {"ok": True, "baseVersion": file_sha256(path), "applied": applied}


# ---------------------------------------------------------------------------

def main():
    mode, arg = sys.argv[1], sys.argv[2]
    if mode == "read":
        print(json.dumps(read_docx(arg)))
    else:
        with open(arg, encoding="utf-8") as f:
            body = json.load(f)
        print(json.dumps(write_docx(body)))


# 必须用 `__main__` 守卫：本文件会被测试/探针 **import**（需要直接调用 read/write 函数做比对）。
# 不守卫的话 import 时就会去读 `sys.argv[1]` 并抛 IndexError —— 实测踩到过：调用方的 stdout 里
# 混进一条 `{"ok":false,…IndexError…}`，看起来像功能坏了，实际只是导入副作用。
if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "code": "exception", "error": f"{type(e).__name__}: {e}"}))
