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
import hashlib
import json
import os
import re
import sys

from docx.oxml.ns import qn

# 可识别的块标签（body 的子元素里，只有这两种是"块"；其余如 w:sectPr 是节属性，跳过）
_BLOCK_TAGS = (qn("w:p"), qn("w:tbl"))

# 标题样式名 → 块 kind（沿用旧实现的识别口径，保证既有前端不受影响）
_HEADING_KINDS = (("Heading 1", "h1"), ("Heading 2", "h2"), ("Heading 3", "h3"))

# kind → python-docx 的样式名（新建块用；样式缺失时退回默认，不因样式问题让整批失败）
_KIND_TO_STYLE = {"h1": "Heading 1", "h2": "Heading 2", "h3": "Heading 3"}


# ---------------------------------------------------------------------------
# 基础
# ---------------------------------------------------------------------------

def _file_sha256(path):
    """整文件内容哈希（S1 阶段的 baseVersion 来源）。

    为什么用整文件而不是"规范化内容哈希"：S1 无版本链，而这里要防的是**丢失更新** ——
    任何人（外部 Word/网盘同步/另一个客户端）动过文件，就应该让本次提交失败并让用户重新载入。
    整文件哈希对"文件被动过"最敏感，宁可多让用户重载一次，也不要用宽容的口径把别人的改动覆盖掉。
    （S3/S4 阶段换来源为版本链 versionId，字段名与语义不变。）
    """
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _norm_text(text):
    """归一化文本用于 id 与比对：连续空白折成一个空格、去首尾。

    不动的部分：大小写、标点、中文全/半角 —— 那些是**内容差异**，抹掉它们会把不同的段判成同一段。
    """
    return re.sub(r"\s+", " ", text or "").strip()


def _block_id(kind, payload, occurrence):
    """blockId = 内容指纹前 12 位 + 出现序号。内容相同 ⇒ id 相同（幂等/稳定），重复内容靠序号区分。"""
    digest = hashlib.sha256(f"{kind}\x00{payload}".encode("utf-8")).hexdigest()[:12]
    return f"{digest}:{occurrence}"


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
            payload = _norm_text(para.text)
            key = (kind, payload)
            occurrence[key] = occurrence.get(key, 0) + 1
            out.append({
                "blockId": _block_id(kind, payload, occurrence[key]),
                "kind": kind,
                "text": para.text,
                "obj": para,
                "element": child,
            })
        else:
            table = Table(child, doc)
            rows = _table_rows(table)
            key = ("table", _rows_payload(rows))
            occurrence[key] = occurrence.get(key, 0) + 1
            out.append({
                "blockId": _block_id("table", key[1], occurrence[key]),
                "kind": "table",
                "rows": rows,
                "obj": table,
                "element": child,
            })
    return out


def _public_blocks(blocks):
    """剥掉仅供内部使用的元素引用，产出可序列化的块（保证输出里没有非 JSON 字段）。"""
    out = []
    for b in blocks:
        if b["kind"] == "table":
            out.append({"blockId": b["blockId"], "kind": "table", "rows": b["rows"]})
        else:
            out.append({"blockId": b["blockId"], "kind": b["kind"], "text": b["text"]})
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
    return {"ok": True, "baseVersion": _file_sha256(path), "blocks": _public_blocks(blocks)}


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
    actual = _file_sha256(path)
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

    return {"ok": True, "baseVersion": _file_sha256(path), "applied": applied}


# ---------------------------------------------------------------------------

def main():
    mode, arg = sys.argv[1], sys.argv[2]
    if mode == "read":
        print(json.dumps(read_docx(arg)))
    else:
        with open(arg, encoding="utf-8") as f:
            body = json.load(f)
        print(json.dumps(write_docx(body)))


try:
    main()
except Exception as e:
    print(json.dumps({"ok": False, "code": "exception", "error": f"{type(e).__name__}: {e}"}))
