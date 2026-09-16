# Plan：S1 文档协同模型（块模型 + ops 写入 + baseVersion）（2026-09-16）

> spec：`2026-09-14-team-collaboration-design.md` §6.1（S1 详设 C1–C6 + 写入契约 + `baseVersion` 两阶段 + blockId 三性质 + 非目标）、§9（S1 测试项：先补 `docx_edit`/`sheet_edit` 回归网、复用 `collab-experiment` 语料覆盖 T5–T7/T9）、§13（闸门）。
> 闸门：**`#2` 已决**（2026-09-14 用户定案："一步换掉，只留 `ops`；由 GUI 计算 diff"）⇒ 无阻塞。
> 前置：S3 已完成（`d0e3a1e`）。**S1 独立于 S3**（`baseVersion` 两阶段设计使其不必等版本链）。

## 0. 勘察结论（探索子代理实测，逐条可核验）

| 事实 | 证据 |
|---|---|
| `server/docx_edit.py` 88 行：`read <path>` / `write <jsonPath>`；输出 `{ok,blocks:[{kind,text}|{kind:'table',rows}]}`，**无 id** | `docx_edit.py:14-31,73-82` |
| B1 根除对象 = **Python 内置 `zip()`**（按位配对、短序列截断 ⇒ 尾部静默丢弃），非压缩包；`:70` `doc.save()` 原地整包重写 | `docx_edit.py:53-70` |
| **B3 复现**：块序 = `1ppp2pp3ppp2pppTT`（2 个表全在末尾）≠ 文档真序 | 实测 |
| **T1 幂等成立**（连续 3 次 read 输出 md5 全等）、**T2 稳定成立**（`base.docx` vs `word_resaved.docx` 输出 md5 相同，因只读 `p.text`） | 实测复核 spec §6.1 |
| `server/sheet_edit.py` 92 行：`read` 只读 **active sheet**；`write_xlsx` 入参 `{path,sheet,updates:[{row,col,value}]}`，公式格 `:50` **静默跳过**（B8）；`.xls` 写回因缺 `xlutils` **恒失败** | `sheet_edit.py:14-32,40-56,59-79` |
| 唯一调度入口：`server/bridge.mjs` `runOfficeScript`（spawn python，**timeout 15s**）；4 个路由 `/read-sheet`/`/write-sheet`/`/read-docx`/`/write-docx` 内联在 `bridge.mjs:2212-2268`；错误一律 **500**（**无 4xx 语义**） | `bridge.mjs:2190-2268` |
| 前端唯一消费者：`DocxEditor.tsx`（`dirtyRef` 是 **boolean** `:41`、按下标改 `:59-70`、`key={i}` `:121/143`）、`SheetEditor.tsx`（`dirtyRef` 是 **Map** `:43`，即 spec 让照抄的现成写法） | 实测 |
| **`scratch/collab-experiment/`（语料 + `merge_sim.py`/`cmp_blocks.py`/`xl_tests.py`）被 `.gitignore:21` 忽略** ⇒ `git ls-files` 里一个都没有 | `git check-ignore -v` |
| Python 侧**无 pytest、无 `server/*.test.py`**；`npm test` 不含 python；既有 mjs 测试**刻意不 spawn python** ⇒ 这两个脚本**当前零覆盖** | `package.json:19`；`kernel-tests/knowledge-import.test.mjs:3-6` |
| 依赖（`runtime/python/python.exe`）：python-docx 1.2.0 ✓、openpyxl 3.1.5 ✓、xlrd 2.0.2 ✓、**xlutils ✗**、pytest ✗ | 实测 |
| 单次"冷启 python + 解析 base.docx" ≈ **0.33s** ⇒ 真机测试可行 | 实测 |

## 1. 决策（用户授权"自行评估、不用问"，故按工程默认落定；**每条给理由/代价/可逆性**，全部登记终验）

| # | 决策 | 理由 | 代价 / 可逆性 |
|---|---|---|---|
| **D-1 语料** | **受控目录 `server/office-fixtures/`** 只入库**不可生成的关键对**：`base.docx`+`word_resaved.docx`（T2 必须用**真 Word 重存**的字节，无 Word 无法生成）、`xl_base.xlsx`+`xl_insertrow.xlsx`（B6 对拍语料，无既有生成器）；其余变体由**提交进仓库的生成脚本**（python-docx/openpyxl）在测试时确定性生成 | spec §9 说"复用 collab-experiment 语料"，但 `scratch/` 被 gitignore ⇒ 照字面做 = 测试依赖未跟踪文件、换机必红 | ≈170KB 二进制入库；可逆（改生成器即可缩到 78KB） |
| **D-2 blockId** | `内容指纹(kind+归一化文本)` 前 12 位 **+ `:` + 同内容出现序号**（occurrence）。**不物化书签**。⚠️ **步骤 5 实测修正**：格式指纹**不进 id**，改为块的**独立字段** `format` | 纯内容哈希在"文档里有两段相同文字"时**必然撞车**（T1/T2 只覆盖无重复文档）；物化 `w:bookmarkStart` 会**改用户文件本体**（不可逆，且 Word 可能丢弃/重排）；序号方案把漂移面**收敛到"同内容重复段"这一种**，且将来可升级为物化 id 而**不改字段名**。<br>**为何修正**：① spec 明写 blockId 稳定"因基于 `p.text`"；② 实测 `w:pStyle/@w:val` 在 python-docx 是**样式名**（`Heading1`）、Word 重存变 **styleId**（`3`），格式进 id 会让"在 Word 里打开又保存"把标题块 id 全换掉；③ 语义上"甲改格式 + 乙改文字"应落在**同一 id** 上才能合并，进 id 则退化成"删除+新增"而必然互斥 | "在他处插入同内容段"会使序号漂移；**登记终验** |
| **D-3 C3 表格降维** | 采纳**双视图**：粗粒度整表块（`rows`，**UI 继续走这条**）+ 细粒度子块（`tableCells`，供合并粒度下沉） | spec §6.1 非目标明写"不改编辑器 UI" ⇒ 若只留细粒度，`DocxEditor` 表格渲染**必须**改（与自己的非目标冲突） | read 负载变大；可逆（将来 UI 改细粒度即可丢粗视图） |
| **D-4 格式指纹粒度** | 段级 `pPr` + run 级 `rPr` **规范化摘要**，剔除修订噪声（`rsid*`/`w:proofErr`/`w:ins`/`w:del`）。**步骤 5 先实测噪声再定系数**，本步只锁现状 ⇒ **已实测并落地**：① 摊平为「格式项集合」再排序（不比 XML 书写顺序与命名空间声明，实测后者会造成假差异）；② `pStyle`/`rStyle`/`tblStyle` 的 `val` 换成**样式名**（实测重存使 `Heading1`→`3`、`TableGrid`→`33`）；③ 剔除"与样式链/docDefaults 继承值相同"的**冗余直配**（Word 物化）；④ 相邻同格式 run **折叠**（重切 run 是表示差异）；⑤ 表级**剔除物化组** `tblBorders/tblCellMar/tblInd/tblLayout/tblLook`。**单元格级格式指纹放弃**（Word 把**单元格样式**属性物化成单元格段落直配，取值属表样式链，S1 不解析 ⇒ 纳入必破 T2） | spec 自标"C2+C4 联调须重验 T2"（Word 重存可能改 run 切分） | 实测后已调整；**代价**：表级"直接格式改边框/边距"与**单元格内文字格式**在指纹里不可见（登记终验） |
| **D-5 `.xls`** | **只读**；结构写**明确报错**，且错误文案说清"格式限制、非文件损坏"。**不入 S1 的 ops 范围** | 本机缺 `xlutils` ⇒ 写路径**无法验证**；S1 不应交付"跑不到的分支"（同 L2 定案口径） | 用户若需 `.xls` 写入须另开条目 |
| **D-6 `baseVersion` 口径** | S1 用**整文件 sha256**；不匹配 → **409 + 强制重载** | spec 明示"文件内容哈希"；S1 无版本链，规范化哈希会让"内容变了但规范化后相同"漏过，**削弱防丢失更新** | 外部编辑器"打开-另存"即 409（宁可多让用户重载，属安全方向）；**登记终验** |
| **D-7 多 sheet** | `read` **增**返回 `sheetNames`（纯增字段，向后安全）；ops 仍带 `sheet` 名 | 避免 read 只给 active sheet 而 ops 能写别 sheet 的**信息不对称** | 无 |
| **D-8 失败上浮** | 允许改 `FileEditor.tsx:37/41` 检查 `save()` 返回值并把失败显示在**窗口级** | 否则"ops 被拒（409/400）"在 UI 上**静默无感**，用户以为已保存 | 动到编辑器壳层（超出"只改两个编辑器"的最小面，但为正确性所必需） |
| **D-9 未验证项** | `word_resave.py` 需本机 Word COM ⇒ **不纳入测试**；`gen_variants.py` 确定性在步骤 1 用"与既有 scratch 产物逐字节比对"验证，不成立则以生成器为准重定基线 | 不把不可复现的东西写进测试 | — |

**命名避撞（B-7）**：`blockId` 已被知识库 md 切块占用（`shared/knowledge-core.mjs:547` `toBlockId`，`kernel/knowledge.mjs:952/1138` 在用）。Office 侧字段名沿用 spec 的 `blockId`（契约要求），但**模块与测试文件一律带 `office-`/`docx-` 前缀**，避免读者把两者混为一谈。

## 2. 步骤（每步独立可测，不必起桥）

| 步 | 内容 | 改动 | 验证 |
|---|---|---|---|
| **1** | **测试网（spec 强制前置）**：语料入受控目录 + 生成脚本；用 `node:test` + spawn python 锁住**现有**行为 | 新增 `server/office-fixtures/`、`server/docx-python.test.mjs`、`server/sheet-python.test.mjs` | `node --test server/docx-python.test.mjs server/sheet-python.test.mjs` |
| **2** | **C2 块模型 + `baseVersion`**：`read_docx` 遍历 `body` 子元素取**真序**、给稳定 `blockId`、返回 `baseVersion` | `server/docx_edit.py`、抽 `server/office-routes.mjs`、`DocxEditor.tsx`、（D-7）`sheet_edit.py` | `node --test server/office-blocks.test.mjs`（幂等/重存稳定/真序） |
| **3** | **C1 ops 写入**（后端与 GUI **同批**）：只认 `{path,baseVersion,ops[]}`；`insert/delete/update/move` 以 `blockId` 寻址；旧 `blocks` **显式报错**；**删除 `zip` 路径** | `server/docx_edit.py`、`server/office-routes.mjs`（400/409）、`DocxEditor.tsx`（dirtyRef→Map，照抄 `SheetEditor.tsx:43/70/84/86/106/116`）、`FileEditor.tsx`（D-8） | `node --test server/docx-ops.test.mjs` + `npm run typecheck` |
| **4** | **C5/C6 xlsx**：行**内容指纹**寻址、归一化、插删行列、公式格**明确报错**、`baseVersion` | `server/sheet_edit.py`、`server/office-routes.mjs`、`SheetEditor.tsx` | `node --test server/sheet-ops.test.mjs`（B6：插 1 行 = "1 行插入 + 0 处修改"） |
| **5** | **C3 表格降维 + C4 格式指纹**（含 C2+C4 联调重验 T2） | `server/docx_edit.py`、`DocxEditor.tsx`（D-3 双视图） | `node --test server/docx-table-format.test.mjs` + 重跑 T2 |
| **6** | **三路合并对拍**（验收 1–7）：T5/T6/T9 = 0 冲突、T7 = 1 冲突、B2（同表不同单元格）= 0 冲突 | 新增 `server/collab-merge.test.mjs`；`docs/bridge-contract.md:258` 同步 | `node --test server/collab-merge.test.mjs` |

## 3. 测试网原则（步骤 1 的关键）

B1/B3/B8 的断言写成 **"记录现状 + `TODO-C1/C2/C6` 标注"**，而不是直接断言"正确行为"——这样后续步骤落地时是**改断言**（有据可依）而不是**删测试**（掩盖倒退）。同时断言"改后必须相反"的**意图**写在用例名里，便于对照。

## 4. 边界（诚实说明）

1. **S1 只做 docx/xlsx 侧**；不做 CRDT/OT、不做实时协同、**不改编辑器 UI 的交互形态**（D-3 用双视图避开）。节 §6.1 非目标。
2. **`.xls` 结构写不支持**（D-5，本机缺 `xlutils`，写路径无法验证）。
3. **blockId 在"同内容重复段"上的序号漂移**是已知限制（D-2），待终验决定是否物化。
4. **S1 的 `baseVersion` 是整文件哈希**（D-6），不是版本链 id；S3/S4 阶段换来源但**字段名与语义不变**。
5. 步骤 2–6 尚未开始；本 plan 会随每步完成补"验收结果"。

## 5. 实施结果（六步全部完成）

| 步 | 提交 | 落点与关键实测 |
|---|---|---|
| 1 | `00cca3b` | `server/office-fixtures/`（4 份受控语料，md5 与来源一致）+ 3 个探针 + 双网 16/16。**实测校正**：行列是 **1-based**（首版按 0-based 写，红）；写回不改 run 数与粗体标志（新文本落进首 run、其余清空） |
| 2+3 | `9adbdc4` | C2 真序（根除 B3：表格不再全堆末尾）+ 稳定 `blockId` + `baseVersion`；C1 ops-only（旧 `blocks` 显式拒绝；序号寻址废弃）+ 路由错误码→4xx（409 冲突 / 400 请求不可用）+ 前端 `dirtyRef` boolean→Map、句柄 `lastError()`、`FileEditor` 失败上浮。`docx-ops` 8/8 + `docx-python` 反转后 8/8 |
| 4 | `2fa2fd8` | C5 行列内容指纹（**B6：插 1 行 = 1 插入 + 0 修改；行号口径误报 19 处**）+ C6 结构操作/公式格明确报错/`.xls` 明确不支持 + D-7 `sheetNames` + `office_common.py`（归一化单一真相源）。`sheet-ops` 9/9 + `sheet-python` 反转后 6/6 |
| 5 | `817bbad` | C4 格式指纹（B4 根除：仅改粗体也能检出）+ C3 表格双视图（`tableCells` 细粒度）+ **T2 联调重验通过**。实测噪声三类：`pStyle` 样式名↔styleId、Word 物化继承外观（表 `tblBorders` 等 / 单元格段 `spacing`）、命名空间声明顺序。`docx-table-format` 8/8 |
| 6 | 见下条 | `shared/office-merge.mjs` 三路合并（块级→行级→单元格级递归下沉）+ `blocksToOps`/`sheetMergeToOps` 落盘闭环。`office-merge` **15/15**，含 T5/T6/T9/B2 = 0 冲突、T7 = 1 冲突 |

**验收映射（spec §10 的 S1 项）**：#5 格式变更不再被判成"无变化" ✓（步骤 5）；T5/T6/T7/T9/B2 ✓（步骤 6，且闭合到"落盘后读回一致"）。

**与既定 D 项的偏差（均为实测驱动，已在 §2 表内记档）**：
1. **D-2 修正**：格式指纹**不进 `blockId`**，改作块的独立字段 —— spec 明写 id 稳定"因基于 `p.text`"；且进 id 会让"甲改格式+乙改文字"退化成"删除+新增"而必然互斥。
2. **D-3 收窄**：`DocxEditor.tsx` **未改**（双视图只加读取面）—— 改 UI 会与 spec §6.1 非目标"不改编辑器 UI"冲突。
3. **D-4 代价**：表级"直接格式改边框/边距"与**单元格内文字格式**在指纹里不可见（Word 物化单元格样式属性，纳入必破 T2）。
4. 计划中的 `server/office-routes.mjs` **未抽**（路由留在 `bridge.mjs`）：抽取会让本步 diff 扩大到无关路由；ops 契约本身已由 `docx-ops`/`sheet-ops` 两张网覆盖。

**已知限制（登记终验）**：① 同内容重复块的序号漂移（D-2）；② `baseVersion` 是整文件哈希 ⇒ 外部编辑器另存即 409（D-6）；③ 上述 D-4 代价；④ `.xls` 只读（D-5）。
