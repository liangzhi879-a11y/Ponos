# 资源浏览器增强：HTML 互动预览 + Office 可编辑写回 设计文档

日期：2026-08-17
状态：已批准（用户确认 A-E 五节设计）

## 背景与目标

应用内资源浏览器（FileBrowser）打开文件时：
1. **HTML 当前默认读源码**（FileEditor 在 CodeMirror 显示源码；FilePreview 弹窗虽能 iframe 渲染但 sandbox 缺 `allow-scripts`，brainstorming 等互动 HTML 的 JS 不执行）。目标：默认渲染预览页（放行 JS，支持 superpowers brainstorming 互动展示），可一键切回源码编辑。
2. **Word/Excel 仅只读**（`convert_docx.py`/`convert_xls.py` 转 HTML 只读预览）。目标：在应用内可编辑并写回原文件，保留格式/结构。

## 决策（用户已确认）

- HTML：默认渲染预览 + 可切源码（推荐项）
- Office：Excel + Word 均可编辑写回，基于现有 python 栈（openpyxl/python-docx），不引入重型前端引擎（推荐项）

## A. HTML 互动预览

- bridge `/raw-file` mime 表新增 `html → text/html`（文件以基准 URL 渲染，同目录相对 css/js/图片正常加载）。
- FilePreview 弹窗：html 分支的 iframe 由 `srcDoc={content}` 改为 `src={fileUrl}`，`sandbox="allow-scripts allow-same-origin"`（互动 JS 可执行）。
- FileEditor 独立窗口：html 打开时默认渲染预览（iframe 同上 sandbox），标题栏增加"预览/源码"切换按钮（Globe/FileCode 图标），源码模式即现有 CodeMirror。`isEditableFile` 逻辑不改，窗口内按扩展名分支。

## B. Excel 可编辑写回

### python `server/sheet_edit.py`
- `read`（argv: `read <path>`）：openpyxl `load_workbook(path, data_only=True)` 读 active sheet 值；再用 `data_only=False` 读公式判定（公式格标记）。输出 JSON：
  `{"ok":true,"sheets":[{"name":..., "rows":[[...]], "formulas":[[bool]]}]}`
- `write`（argv: `write <jsonPath>`，JSON 入参 `{path, sheet, updates:[{row,col,value}]}`）：openpyxl 非只读加载 → 对非公式单元格 `cell.value = value` → `save()`（字体/边框/填充/列宽保留；公式单元格跳过不写）。
- `.xls` 旧格式：xlrd 读 + xlutils.copy + xlwt 写回（尽力；能力受限返回明确错误提示改用 .xlsx）。若环境缺 xlutils，write 返回 `{ok:false,error:"xls 写回需 xlutils 库"}`。

### bridge 端点（沿用 convert-office 同款：resolve 校验、10MB 上限、15s 超时、findPythonExe）
- `GET /read-sheet?path=` → `{ok, sheets}`
- `POST /write-sheet` body `{path, sheet, updates}` → `{ok}`

### 前端 `src/components/editor/SheetEditor.tsx`
- 轻量可编辑网格：表头行样式（首行加粗）、单元格点击编辑（input）、Enter 下移 / Tab 右移 / 方向键导航、Esc 取消。
- 公式单元格：浅色角标标记 + 只读（保留原公式）。
- 改动本地缓存 → 保存按钮（复用 FileEditor 标题栏 Save）→ POST `/write-sheet` → 成功 `markFileSaved`。
- FileEditor Body 分支：`xlsx/xls` → SheetEditor（替换只读 OfficePreview 分支）。

## C. Word 可编辑写回

### python `server/docx_edit.py`
- `read`（argv: `read <path>`）：python-docx 读段落（Heading 1/2/3 → h1/h2/h3，其余 p）与表格（cell 文本二维），输出：
  `{"ok":true,"blocks":[{"kind":"h1"|"h2"|"h3"|"p"|"table","text"?,"rows"?}]}`
- `write`（argv: `write <jsonPath>`，入参 `{path, blocks}`）：python-docx 打开原文件 → 按块序对 paragraph 更新 `text`（保留段落样式；表格 cell 更新 `text`）→ `save()`。图片/嵌入对象不触碰。

### bridge 端点
- `GET /read-docx?path=` → `{ok, blocks}`
- `POST /write-docx` body `{path, blocks}` → `{ok}`

### 前端 `src/components/editor/DocxEditor.tsx`
- 块列表编辑：h1/h2/h3/p → 自适应高度 textarea；table → 可编辑网格。
- 保存 → POST `/write-docx` → 成功 `markFileSaved`。
- FileEditor Body 分支：`docx` → DocxEditor。

## D. 安全边界

- HTML sandbox 仅 `allow-scripts allow-same-origin`，不放 `allow-top-navigation`/`popups`/`allow-forms`（默认禁）。文件为本地用户自选，脚本可执行互动。
- 写回端点仅接受本地路径（`resolve()` 校验）、大小上限 10MB、超时 15s——与 convert-office 同款约束。

## E. 已知取舍

1. Word 段落内混排格式（局部加粗/颜色）整段改写时归一为段落默认样式——不做 run 级 diff。
2. Excel 仅编辑第一个 sheet（与现只读预览一致），sheet 切换后续可扩展。
3. 不做公式重算：编辑值直接存盘，公式单元格保留原公式不动。

## 验证清单

- [ ] HTML 互动页（含 JS 按钮/键盘交互）在 FilePreview 弹窗与 FileEditor 窗口均可玩
- [ ] HTML 可切源码再切回预览；源码修改后保存，预览刷新为新内容
- [ ] xlsx 编辑保存后重新打开：值已变、列宽/字体/边框保留、公式单元格未破坏
- [ ] docx 改标题/段落/表格文本保存后重开：文本已变、标题样式保留、图片仍在
- [ ] .xls 写回行为符合预期（或给出明确错误提示）
- [ ] 构建 + 同步 release 与 debug 双副本 + 重启加载

## 实现范围（本次不含）

- 多 sheet 编辑、公式重算、Word run 级样式编辑、PPT 编辑、OnlyOffice 级富编辑
