# office-merge：它要做什么、现在差哪一段（2026-09-18）

> 背景：P2-3 死代码清点时发现 `shared/office-merge.mjs`（409 行 + 340 行测试）在依赖图上"孤立"，
> 但**不是废弃代码，而是未接线的功能**。本文说明它到底要实现什么，供决策"接线 / 移除 / 搁置"。
> 结论速览：**合并算法与落盘闭环都已写完并有 15 项测试（含端到端），唯独 HTTP 层少一段编排。**

---

## 一、一句话

**它要做的是"团队协作里两个人都改了同一份 Office 文件时的三路合并"**——把 base（共同基线）/ mine（我的）/ theirs（对方的）三方内容合并成一份，能自动合的就合，不能判定的就**报冲突交给人**，绝不静默取舍。

## 二、用户视角：它在哪个流程里出现

```
两人协同编辑同一份 docx/xlsx
        ↓
后提交者被判定"版本冲突"（防丢失更新）
        ↓
弹出处置选择：①接受对方 ②保留我的 ③另存草稿 ④【进入编辑器逐处合并】
        ↓  ←──── office-merge 应该在这一步工作
        ↓
出结果：合并成功 → 落盘 / 有冲突 → 逐处提示让人选
```

第 ④ 项"**进入编辑器逐处合并**"就是它的入口（`src/components/editor/FileCollabBar.tsx` 的 `edit-merge` 按钮）。这也是为什么它"必须有"——没有它，用户在"全丢我的"和"全丢对方"之间**没有第三条路**。

## 三、要达成的验收标准（来自 spec，已有对应测试）

| 用例 | 场景 | 期望 |
|---|---|---|
| **T5** | 甲改第 5 段、乙改第 9 段 | 0 冲突，两处改动都保住 |
| **T6** | 甲改一段、乙插一段 | 0 冲突，插入被吸收且位置正确 |
| **T7** | 甲乙改**同一段** | **1 冲突**（必须报出来，不能悄悄取舍） |
| **T9** | xlsx 两人改**不同单元格** | 0 冲突，两处都保住 |
| **B2** | 同一表格两人改**不同格** | 0 冲突（**粒度下沉到单元格**，不是整表冲突） |

## 四、核心设计（两句话）

1. **对齐锚 = 内容指纹 id，空档按位置兜底**：块/行 id 由内容算出，所以未改动的块在三个版本里 id 相同 → 天然对齐锚点；被改过的块 id 变了，落在两个锚点之间按**位置** 1:1 配对（这正是"同一段被两人各自改了"能识别为冲突、而不是"删一段+插两段"的原因）。
2. **冲突宁多报，不可静默取舍**：无法自动判定的（一侧删一侧改、结构增删数量不等）一律记为冲突并原样带出两侧内容。**S1 只要求"判定 + 报出"，交互式选择留给后续**（spec §6.1 明列为非目标）。

> 有个踩坑记录值得保留：早期版本用"列 id 序列是否相等"判断列框架是否一致 → 结果"同表两人各改一格"被判成 21 处 `column-structure-diverged`（B2/T9 全红）。正确做法是让列也走通用对齐、按位置配对。**这类细节说明这套代码是真调试过的，不是空壳。**

## 五、现状：已经做完的（比预想的多）

| 层 | 状态 | 位置 |
|---|---|---|
| **决策层** | ✅ 完成 | `shared/file-modal.mjs`：`edit-merge` → `{ action: 'merge-then-write', content: null }`（明确**交接**给合并库） |
| **合并库** | ✅ 完成 + **15 项测试** | `shared/office-merge.mjs`：`threeWayMerge` / `mergeDocxBlocks` / `mergeSheetRows` |
| **落盘（ops）** | ✅ 完成 + 测试 | 同文件：`blocksToOps` / `sheetMergeToOps`（生成 `update`/`insert`/`delete`、`updateCell`/`insertRow`/`deleteRow`） |
| **读写原语** | ✅ 已存在 | `server/office-routes.mjs`：`/read-docx`、`/write-docx`、`/read-sheet`、`/write-sheet`（含 `baseVersion` 乐观并发，防丢失更新） |
| **端到端闭环测试** | ✅ 已有 | `shared/office-merge.test.mjs` 含「合并产物 → ops → 落盘 → 读回」真文件闭环（docx 与 xlsx 各一） |
| **HTTP 编排** | ❌ **缺这一段** | `server/collab-routes.mjs` 的 `/file-collab/conflict` 路由 |

## 六、缺的那一段，具体是什么

`server/collab-routes.mjs` 的 `/file-collab/conflict` 现在长这样：

```js
const r = prepareConflictResolution({ ..., choice: body.choice })
if (r && r.ok) {
  const { content, ...rest } = r          // content 是 Buffer，不进 JSON
  return s4Reject({ ...rest, bytes: content ? content.length : 0 })
}
```

对 `edit-merge` 这条，`planConflict` 返回的是 `{ action: 'merge-then-write', content: null }` ⇒ **HTTP 层没有对应分支**：它把 `bytes: 0` 返回给前端就结束了，**既没合并、也没落盘**。

需要补的是一段**按文件模态分派的编排**（`kernel/file-collab.mjs` 的注释把职责写得很明确：「由上层按文件模态（docx 块 / xlsx 行）选择对应函数后调用」）：

```
当 choice === 'edit-merge':
  1. 把 base/mine/theirs 三个版本 buffer 落到临时文件
  2. 按模态读取块/行：
     docx → /read-docx 得 blocks；xlsx → /read-sheet 得 { rows, rowIds, colIds }
  3. 调 mergeDocxBlocks(base, mine, theirs) 或 mergeSheetRows(...)
  4. 若 ok  → blocksToOps / sheetMergeToOps → POST /write-docx 或 /write-sheet
              （带上磁盘当前的 baseVersion，乐观并发）
     若不 ok → 把 conflicts 返回前端，逐处让人选（T7 的"必须报出来"）
```

**规模判断**：这是一个**分派函数 + 模态分支**，量级约 60–120 行，**不需要写新的算法**。风险点有两个：①三个版本 buffer 要经临时文件喂给 python 脚本（现有原语都是按路径读）；②`conflicts` 需要一条回前端的结构化通道（当前响应只有 `action/source/bytes` 等字段）。

## 七、现在的实际表现（为什么会误以为它"能用"）

用户点"进入编辑器逐处合并"后，前端会提示：

> **已交给三路合并**（内容落盘需重新载入后再保存）　— `src/components/editor/FileCollabBar.tsx`

**这句话与事实不符**：没有编辑器打开、没有任何内容被合并或落盘、冲突依旧存在。`bytes: 0` 就是这个空操作留下的痕迹。

⇒ **当前状态是"一个会骗人的提示"**：它不是"点了报错"，而是"点了说成功"。这个差异很重要——**它掩盖了功能缺口**，也可能让用户在以为已合并的情况下继续操作。

## 八、三个选项

| 选项 | 要做什么 | 成本 | 适合的情形 |
|---|---|---|---|
| **A. 接线** | 补上述分派编排（60–120 行）+ conflicts 回传通道 + 一处 e2e；合并算法与落盘闭环**已就绪** | 中（1 个焦点工作包） | 团队协同是这个产品的**在售能力**（不是试验品） |
| **B. 移除** | 删 `shared/office-merge.mjs` + 其测试（749 行）、去掉 `edit-merge` 按钮与 `planConflict` 的该分支、改 3 处测试断言 | 中（且**删掉已完成的算法资产**） | 已确定**不做**协同合并（仅保留"接受对方/保留我的/另存草稿"） |
| **C. 搁置 + 消除误导** | **只改前端那一句提示**（如「该功能尚未接入，请改用其它处置方式」），或临时隐藏 `edit-merge` 按钮；代码原地保留 | **低（几行）** | 暂不决定方向，但**不想让用户被误导** |

## 九、建议

**倾向 A，但至少要做 C。**

理由：
1. **沉没成本已花且质量不差**——409 行算法 + 340 行测试覆盖 T5/T6/T7/T9/B2 与落盘闭环，且注释里留有真实调试教训（列 id 那处）。**移除等于把已完成的算法资产丢掉**，而算法才是这件事里最难的部分；缺的只是编排。
2. **同步看，缺口不是"少个按钮"而是"少条出路"**——没有它，冲突处置只有"全丢我的 / 全丢对方的"，恰恰是协同编辑最需要自动化的场景。
3. **但 C 是底线**：无论最终选 A 还是 B，**当前那句"已交给三路合并"都必须改**——一个声称成功却什么都没做的提示，比按钮不存在更糟。
4. 若决定搁置，建议把「`edit-merge` 未接线」登记进待办清单，并在 `shared/office-merge.mjs` 文件头加一行 `⚠️ 未接线` 说明，避免下一个人再次把它当死代码评估（本次就发生了这个循环）。

---

## 附：可核实的关键位置

| 内容 | 位置 |
|---|---|
| 合并算法与领域封装 | `shared/office-merge.mjs` |
| 合并库测试（15 项，含端到端闭环） | `shared/office-merge.test.mjs` |
| `edit-merge` 决策（交接点） | `shared/file-modal.mjs` 的 `planConflict` |
| 「由上层按文件模态选择函数」的职责说明 | `kernel/file-collab.mjs` 的 `prepareConflictResolution` 注释 |
| **缺失编排的位置** | `server/collab-routes.mjs` 的 `/file-collab/conflict` 路由 |
| 读写原语（含 `baseVersion` 乐观并发） | `server/office-routes.mjs` |
| 会误导的 UI 提示 | `src/components/editor/FileCollabBar.tsx` |
