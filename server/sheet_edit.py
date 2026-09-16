"""Excel 应用内编辑：结构化读取（行/列**内容指纹** + baseVersion）+ ops 写入。

用法:
  sheet_edit.py read  <path>
      → {"ok":true,"baseVersion":"<sha256>","sheetNames":[…],
         "sheets":[{"name","rows","formulas","rowIds","colIds"}]}
  sheet_edit.py write <jsonPath>
      → 入参 {"path","baseVersion","sheet"?,"ops":[{"op":"updateCell",…}, …]}
      → {"ok":true,"baseVersion":"<写入后的新版本>","applied":[…]}

—— 为什么写入长这样（spec §6.1 / 批注 #2 定案，都有实测依据）——
* **ops-only**：旧的全量 `updates:[{row,col,value}]` 写法**显式报错**（`legacy-updates-not-supported`），
  不静默降级。
* **`baseVersion` 必需**：缺失即拒；不匹配即拒（409 语义）—— 防丢失更新的唯一依据。
* **行身份用内容指纹、不用行号**（C5/B6）：这是整张表最关键的一条。行号寻址下，
  "在第 3 行插一行"会让第 4 行起**全部**变成"被修改行"（实测语境：20 行表 = 1 处插入 +
  17 处假修改）；内容指纹下，插一行只产生 **1 个新行 id，其余行 id 一个不动**。
* **列身份同理用内容指纹**：`C6` 要求支持插删列，而列号寻址有完全一样的漂移问题。
* **公式格只读，且必须明确报错**（C6/B8）：旧实现遇到 `=` 开头的格直接 `continue` ——
  不写、不报错、不告知，还返回 `{"ok":true}`。于是"某人改了公式"这个改动凭空消失，
  而调用方以为存好了。**静默丢弃比显式报错危险得多**。

—— 已知限制（登记终验）——
* 内容相同的行/列靠**出现序号**消歧，因此在别处插入同内容行会让后续同名行序号漂移
  （与 docx 的 blockId 同款取舍）。
* `.xls`（旧二进制格式）**只读**；结构写明确报错（D-5：本机缺 `xlutils`，写路径无法验证，
  S1 不交付"跑不到的分支"）。
"""
import json
import os
import sys

# 本仓库的 python 是**嵌入式发行版**（runtime/python 下有 `python312._pth`）：它按 `._pth`
# 决定 sys.path，**不会**像常规解释器那样自动把"脚本所在目录"加进去。所以这里必须显式补一次，
# 否则 `import office_common` 直接 ModuleNotFoundError（实测确实如此，不是理论风险）。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from office_common import assign_ids, file_sha256, norm_text

# ops 里支持的四种操作
_OPS = ("updateCell", "insertRow", "deleteRow", "insertCol", "deleteCol")

XLS_WRITE_MSG = (
    ".xls 为旧版二进制格式，当前不支持其结构写入（这是**格式限制**，不是文件损坏）；"
    "请在 Excel 中另存为 .xlsx 后再编辑。"
)


# ---------------------------------------------------------------------------
# 归一化与指纹
# ---------------------------------------------------------------------------

def _norm_cell(v):
    """单元格值的**归一化**形式（只用于指纹比对，不用于显示）。

    为什么数字要单独归一：Excel/各写入器对同一个数可能存成 `1`(int) 或 `1.0`(float)，
    重存一次类型就可能变；若不做归一，"内容没改"会被判成"整行改了"。
    布尔与数字分开标记（`True` 在 python 里等于 `1`，不分开会把它们看作同一个值）。

    **故意的区分**：空白格（`None`）与空串（`""`）归成**不同**内容。二者在 Excel 语义上
    确有区别（`ISBLANK` 可判别），归一会把"某格内容被清空"这类真实改动判成"没变"。
    宁可多出一种"表示差异"的假改动，也不要把真实改动吞掉 —— 前者用户看得见并可忽略，
    后者会静默丢内容。这一条是与注释对齐过的（首版注释写了"归一"，实现并没有，属注释说谎）。
    """
    if v is None:
        return ""
    if isinstance(v, bool):
        return "b:1" if v else "b:0"
    if isinstance(v, (int, float)):
        f = float(v)
        return "n:" + (str(int(f)) if f == int(f) else repr(f))
    if isinstance(v, str):
        return "s:" + norm_text(v)
    return "x:" + norm_text(str(v))


def _row_payload(cells):
    """一行的指纹载荷。用 `\\x1f`（单元分隔符）拼接：普通文本里不会出现，避免歧义。"""
    return "\x1f".join(_norm_cell(c) for c in cells)


def _col_payload(grid, ci):
    """一列的指纹载荷（跨该列所有行）。"""
    return "\x1f".join(_norm_cell(r[ci] if ci < len(r) else None) for r in grid)


def _grid_raw(ws, nrows, ncols):
    """按**显示行数/列数**取原始值（含公式串）的网格。

    为什么尺寸取自显示侧：`rows`（显示值）与 `rowIds`/`colIds` 必须**同序同长** ——
    前端按 `rows[r]` 渲染、按 `rowIds[r]` 提交，两者错位一格就会把改动写到相邻行上。
    值则取自原始侧（`data_only=False`）：公式格在显示侧是 `None`（无缓存值时），
    拿 `None` 当指纹会让"公式没变"与"值被清空"无法区分。
    """
    return [[ws.cell(row=r, column=c).value for c in range(1, ncols + 1)] for r in range(1, nrows + 1)]


# ---------------------------------------------------------------------------
# read
# ---------------------------------------------------------------------------

def read_xlsx(path):
    from openpyxl import load_workbook

    wb_val = load_workbook(path, data_only=True)
    wb_raw = load_workbook(path, data_only=False)
    ws_val = wb_val.active
    ws_raw = wb_raw.active

    rows, formulas = [], []
    for r in ws_val.iter_rows():
        row, frow = [], []
        for cell in r:
            row.append(cell.value)
            v = ws_raw.cell(row=cell.row, column=cell.column).value
            frow.append(isinstance(v, str) and v.startswith('='))
        rows.append(row)
        formulas.append(frow)

    nrows = len(rows)
    ncols = len(rows[0]) if rows else 0
    grid = _grid_raw(ws_raw, nrows, ncols)

    return {
        "ok": True,
        "baseVersion": file_sha256(path),
        # D-7：多表工作簿里"有哪些表"必须可见 —— 否则 ops 能写别 sheet 而 read 只给 active，
        # 形成信息不对称（用户以为看到的就是全部）。
        "sheetNames": list(wb_raw.sheetnames),
        "sheets": [{
            "name": ws_val.title,
            "rows": rows,
            "formulas": formulas,
            "rowIds": assign_ids("row", [_row_payload(r) for r in grid]),
            "colIds": assign_ids("col", [_col_payload(grid, c) for c in range(ncols)]),
        }],
    }


def read_xls(path):
    import xlrd

    wb = xlrd.open_workbook(path)
    ws = wb.sheet_by_index(0)
    rows = [[ws.cell_value(r, c) for c in range(ws.ncols)] for r in range(ws.nrows)]
    grid = [[cell for cell in row] for row in rows]
    ncols = len(rows[0]) if rows else 0
    return {
        "ok": True,
        "baseVersion": file_sha256(path),
        "sheetNames": wb.sheet_names(),
        "sheets": [{
            "name": ws.name,
            "rows": rows,
            # xlrd 的 cell_value 对公式格返回**计算值**，拿不到公式串 ⇒ 无法标记公式格。
            # 如实返回"全 false"，并在写入侧统一拒绝 .xls（D-5），不让这个盲区变成数据风险。
            "formulas": [[False] * len(rows[0]) for _ in rows] if rows else [],
            "rowIds": assign_ids("row", [_row_payload(r) for r in grid]),
            "colIds": assign_ids("col", [_col_payload(grid, c) for c in range(ncols)]),
        }],
    }


# ---------------------------------------------------------------------------
# write（ops-only）
# ---------------------------------------------------------------------------

def _err(code, message, **extra):
    payload = {"ok": False, "code": code, "error": message}
    payload.update(extra)
    return payload


def _resolve_row(row_at, deleted, rid, i, op_name):
    if rid in deleted:
        return None, _err("row-deleted", f"第 {i + 1} 个操作（{op_name}）引用的行已在本批次中被删除：{rid}")
    if rid not in row_at:
        return None, _err("row-not-found", f"第 {i + 1} 个操作（{op_name}）引用了不存在的行：{rid}")
    return row_at[rid], None


def _resolve_col(col_at, deleted, cid, i, op_name):
    if cid in deleted:
        return None, _err("col-deleted", f"第 {i + 1} 个操作（{op_name}）引用的列已在本批次中被删除：{cid}")
    if cid not in col_at:
        return None, _err("col-not-found", f"第 {i + 1} 个操作（{op_name}）引用了不存在的列：{cid}")
    return col_at[cid], None


def _apply_sheet_ops(ws, grid, ops):
    """在已打开的工作表上按序施加 ops。

    身份映射（`row_at`/`col_at`）**一次建于基线内容**，批内不再重算，理由：
    一次 ops 里可能有多条操作指向同一行（比如"改这行的两个格"）。若每条操作都按"当前内容"
    重算行 id，第一条改完这行内容就变了、id 随之改变 ⇒ 第二条立刻找不到该行。
    以基线为准既符合直觉（"我提交的是基于我读到的那份内容的改动"），也让批内行为可预测。
    """
    nrows = len(grid)
    ncols = len(grid[0]) if grid else 0

    row_ids = assign_ids("row", [_row_payload(r) for r in grid])
    col_ids = assign_ids("col", [_col_payload(grid, c) for c in range(ncols)])
    row_at = {rid: i for i, rid in enumerate(row_ids)}
    col_at = {cid: i for i, cid in enumerate(col_ids)}

    deleted_rows, deleted_cols = set(), set()
    applied = []

    for i, op in enumerate(ops):
        if not isinstance(op, dict):
            return _err("bad-op", f"第 {i + 1} 个操作不是对象")
        name = op.get("op")

        if name == "updateCell":
            rid, cid = op.get("rowId"), op.get("colId")
            r, bad = _resolve_row(row_at, deleted_rows, rid, i, name)
            if bad:
                return bad
            c, bad = _resolve_col(col_at, deleted_cols, cid, i, name)
            if bad:
                return bad
            if "value" not in op:
                return _err("value-required", f"第 {i + 1} 个操作（updateCell）缺少 value")
            cell = ws.cell(row=r + 1, column=c + 1)
            cur = cell.value
            if isinstance(cur, str) and cur.startswith('='):
                # C6/B8：公式格只读，且**明确报错**（旧实现在这里静默 continue 并返回 ok:true）
                return _err(
                    "formula-cell-readonly",
                    f"第 {i + 1} 个操作要写入公式格 {cell.coordinate}（当前为 {cur}）："
                    "公式格为只读，为避免公式被值覆盖，本次写入被拒绝。",
                    cell=cell.coordinate,
                )
            cell.value = op["value"]
            applied.append({"op": name, "rowId": rid, "colId": cid, "cell": cell.coordinate})

        elif name == "insertRow":
            after = op.get("after")
            if after:
                base, bad = _resolve_row(row_at, deleted_rows, after, i, name)
                if bad:
                    return bad
                idx = base + 1
            else:
                idx = 0  # 不指定锚点 = 插到最前
            ws.insert_rows(idx + 1, 1)
            values = op.get("values") or []
            for c, val in enumerate(values[:ncols] if ncols else values):
                ws.cell(row=idx + 1, column=c + 1).value = val
            for k, v in list(row_at.items()):
                if v >= idx:
                    row_at[k] = v + 1
            applied.append({"op": name, "after": after or None, "at": idx})

        elif name == "deleteRow":
            rid = op.get("rowId")
            idx, bad = _resolve_row(row_at, deleted_rows, rid, i, name)
            if bad:
                return bad
            ws.delete_rows(idx + 1, 1)
            del row_at[rid]
            deleted_rows.add(rid)
            for k, v in list(row_at.items()):
                if v > idx:
                    row_at[k] = v - 1
            applied.append({"op": name, "rowId": rid, "at": idx})

        elif name == "insertCol":
            after = op.get("after")
            if after:
                base, bad = _resolve_col(col_at, deleted_cols, after, i, name)
                if bad:
                    return bad
                idx = base + 1
            else:
                idx = 0
            ws.insert_cols(idx + 1, 1)
            values = op.get("values") or []
            for r, val in enumerate(values[:nrows] if nrows else values):
                ws.cell(row=r + 1, column=idx + 1).value = val
            for k, v in list(col_at.items()):
                if v >= idx:
                    col_at[k] = v + 1
            applied.append({"op": name, "after": after or None, "at": idx})

        elif name == "deleteCol":
            cid = op.get("colId")
            idx, bad = _resolve_col(col_at, deleted_cols, cid, i, name)
            if bad:
                return bad
            ws.delete_cols(idx + 1, 1)
            del col_at[cid]
            deleted_cols.add(cid)
            for k, v in list(col_at.items()):
                if v > idx:
                    col_at[k] = v - 1
            applied.append({"op": name, "colId": cid, "at": idx})

        else:
            return _err("unknown-op", f"第 {i + 1} 个操作类型无法识别：{name}")

    return {"ok": True, "applied": applied}


def write_xlsx(body):
    from openpyxl import load_workbook

    if not isinstance(body, dict):
        return _err("bad-request", "请求体必须是 JSON 对象")
    path = body.get("path")
    if not path:
        return _err("path-required", "缺少 path")

    ops = body.get("ops")
    if not ops:
        if "updates" in body:
            return _err(
                "legacy-updates-not-supported",
                "写入必须使用 ops：旧的 {row,col,value} 写法已停用 —— 它按**行号**寻址，"
                "插入/删除行后会把改动写到错误的行上（静默错位）。"
                "请改用 {\"ops\":[{\"op\":\"updateCell\",\"rowId\":…,\"colId\":…,\"value\":…}]}。",
            )
        return _err("ops-required", "缺少 ops（本次没有任何编辑操作）")

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

    wb = load_workbook(path, data_only=False)
    sheet_name = body.get("sheet") or wb.active.title
    if sheet_name not in wb.sheetnames:
        return _err("sheet-not-found", f"工作表不存在：{sheet_name}", sheetNames=list(wb.sheetnames))
    ws = wb[sheet_name]

    nrows = ws.max_row or 0
    ncols = ws.max_column or 0
    grid = [[ws.cell(row=r, column=c).value for c in range(1, ncols + 1)] for r in range(1, nrows + 1)]

    result = _apply_sheet_ops(ws, grid, ops)
    if not result.get("ok"):
        return result

    try:
        wb.save(path)
    except PermissionError as e:
        return _err("file-locked", f"文件被占用，无法写入（可能正被 Excel/网盘同步进程锁定）：{e}")

    return {"ok": True, "baseVersion": file_sha256(path), "applied": result["applied"]}


def write_xls(body):
    return _err("xls-write-unsupported", XLS_WRITE_MSG)


# ---------------------------------------------------------------------------

def main():
    mode, arg = sys.argv[1], sys.argv[2]
    if mode == "read":
        ext = os.path.splitext(arg)[1].lower()
        sheets = read_xlsx(arg) if ext == ".xlsx" else read_xls(arg)
        print(json.dumps(sheets))
    else:
        with open(arg, encoding="utf-8") as f:
            body = json.load(f)
        ext = os.path.splitext(body["path"])[1].lower()
        print(json.dumps(write_xlsx(body) if ext == ".xlsx" else write_xls(body)))


# 必须用 `__main__` 守卫：本文件会被测试/探针 **import**（例如"比对 base 与 insertrow 的行指纹"
# 这类需要直接调用函数的检查）。不守卫的话，import 时就会去读 `sys.argv[1]` 并抛 IndexError
# —— 实测踩到过：探针的 stdout 里混进一条 `{"ok":false,…IndexError…}`，看起来像功能坏了。
if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "code": "exception", "error": f"{type(e).__name__}: {e}"}))
