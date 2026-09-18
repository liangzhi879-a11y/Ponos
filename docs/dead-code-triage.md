# 死代码三态判定（P2）

结论先行：全仓 **10 个模块属"真死候选"**（9 个前端组件 + 1 个 e2e 脚本），另有 2 个"仅测试引用"应**保留**、23 个"动态/间接引用"**不得当死代码删除**。**其中 5 个已确认删除**（见文末"清理结果"）。

> ⚠️ **2026-09-17 复核修正**：本清单的 10 条里有 **1 条判错**（`dropdown-menu.tsx` 实为活代码，被 `EffortPicker` / `ApprovalModePicker` 使用并经 barrel 再导出），另有 **1 条分类不当**（`interject.e2e.mjs` 不是死代码，而是服务于活跃功能的手工探针）。**修正后的"真死候选"为 8 个前端组件；剩 3 个待删。** 详见文末「第二批调研（复核 + 处置建议）」——**该节结论优先于本清单**。

复现方式：判定器脚本在会话临时目录（非仓库内），核心逻辑见下方"方法"。

## 为什么不能只问"有没有人 import"

只做单跳静态扫描会把三类完全不同的东西混成一个"没人用"的清单：

| 类别 | 含义 | 处置 |
|---|---|---|
| ① 真死代码 | 无静态引用、无测试引用、无字符串引用 | 可删（需确认） |
| ② 仅测试引用 | 产品代码不用，但测试在用 | **保留**——它就是测试基建，删它等于删测试 |
| ③ 动态/间接引用 | 只通过字符串路径引用（入口、CLI、注册表、模板） | **不是死代码** |

## 方法：判定前必须先修的五个扫描缺陷

这些坑每一个都会造出成片的假"死代码"，逐个踩过：

1. **未跟踪文件**：只用 `git ls-files` 会漏掉尚未 `git add` 的新模块 → 它们会被判成"没人引用"。须并入 `git ls-files --others --exclude-standard`。
2. **`@/` 路径别名**：前端大量用 `@/components/...`，不解析这个别名会让 `src/` 下大面积误报。别名指向 `src/`。
3. **`export … from` 转出**：barrel 文件（`index.ts`）用 `export { Button } from './button'`，只匹配 `import … from` 会把被转出的模块误判为死代码。
4. **构建脚本也是引用来源**：`scripts/` 与 `build/` 下的工具脚本会 import 产品模块（例：`kernel/config-scan.mjs` 由 `scripts/build-arch-graph.mjs` 引入）。若把 `scripts/` 排除在**扫描来源**之外，就会误报。正确做法是：`scripts/` 参与引用扫描，但不作为"可能删除"的候选。
5. **模板目录按设计不被 import**：`build/templates/**` 由打包脚本按**目录名**复制进产物，模块图里自然没有它。须从候选中排除。

另注：注释里提到文件名**不算引用**。例如 `LogoMorph` 在 `CockpitScreen.tsx` 与 `ViewRouter.tsx` 中出现，但两处都只是说明性注释（"过渡 morph 由本组件持有"），故 `LogoMorph.tsx` 仍判为真死——这正是需要逐个看行的原因。

## ① 真死候选（10）

全部经人工核对：其名字在其它文件中出现时**均为注释/说明文本**，无 import、无动态路径、无测试引用。

**前端组件（9 → 复核后 8）——多为"职责已被吸收/迁移后遗留的原件"**

- `src/components/chat/MessageBubble.tsx`、`src/components/chat/TaskCwdBar.tsx`、`src/components/chat/FirstBytePendingBar.tsx`、`src/components/chat/KernelStallBar.tsx`、`src/components/chat/SystemWarningStrip.tsx` —— 这几个的注释多处写着"自 X 迁入/从 X 抽出"，说明其职责已并入其它组件。（**均已删除**，见文末）
- `src/components/diagnostic/DiagnosticBanner.tsx`
- `src/components/browser/BrowserStatusBar.tsx`
- `src/components/boot/LogoMorph.tsx` —— 过渡动画已由 `src/components/layout/ViewRouter.tsx` 自行持有；仅剩注释提及。
- ~~`src/components/ui/dropdown-menu.tsx`~~ —— ❌ **判定错误，已撤回**。复核发现它被 `src/components/chat/EffortPicker.tsx:20` 与 `src/components/layout/ApprovalModePicker.tsx:26` 实际使用，并经 `src/components/ui/index.ts:23`（barrel）再导出。**属活代码，不得删除。**

**脚本（1 → 复核后 0，改列保留）**

- ~~`server/interject.e2e.mjs`~~ —— ❌ **分类不当，已改列"保留"**。它对应的功能（生成中插队/紧急插话）在 `kernel/cli.mjs` 中**活跃**，且它是该功能**唯一的端到端探针**（`README.md` 端口表与测试说明均有登记）。删除会丢掉唯一 e2e 覆盖，与"清死代码"目的相反。详见文末复核。

## ② 仅测试引用（2）—— 保留

- `server/test-bridge-auth.mjs` —— 被 **20 个** server 测试引用（起桥鉴权的公共辅助）。
- `kernel-tests/helpers/fidelity-fixture.mjs` —— 被 `kernel-tests/compact-fidelity.test.mjs` 引用。

这两个是**测试基建**，产品代码不用属正常。列入此处只为说明"它们不是死代码"，**不建议删除**。

## ③ 动态/间接引用（23）—— 不得当死代码删

含应用入口与 CLI（如 `electron/main.cjs`、`src/main.tsx`）、fixture、以及通过字符串路径被工具引用的模块。

⚠️ 这一栏是**宽松启发式**（判据：其它文件中出现该模块的完整文件名）。它的价值是**拦住误删**，**不是**断言"该模块确实被字符串引用了"——其中有若干只是名字偶然出现在无关文本里（配置文件、说明文字）。因此本栏的正确用法是：**看到自己关心的模块出现在这里，就必须人工确认，而不能直接删**。

## 决策：只判定、不批量删除（删除按风险分批）

1. **判定 ≠ 删除。** P2 这一项要的是"哪些能删"的结论，删代码是独立的、可回滚性更低的一步，应由人点头。
2. **风险不对称。** 删 9 个组件若其中有一个实际被用到，代价是运行时白屏；保留它们的代价只是几 KB 体积。在证据只覆盖静态图的情况下，不值得赌。
3. **可安全执行的验证路径**：删一批 → 跑 `npm run typecheck`、`npm run build`、`npm run test:ci`，三步全绿即视为安全；再继续下一批。

## 清理结果

### 已删除（第一批 5 个，2026-09-17）

`src/components/chat/` 下 5 个组件，判定依据一致——**注释多处写着"自 X 迁入/从 X 抽出"，说明职责已并入其它组件**，且文件名在其它源码中出现的位置**全部是注释**（无 import、无动态路径、无测试引用）：

- `src/components/chat/MessageBubble.tsx`
- `src/components/chat/TaskCwdBar.tsx`
- `src/components/chat/FirstBytePendingBar.tsx`（与后两者的名字互相出现在对方注释里，属同批遗留）
- `src/components/chat/KernelStallBar.tsx`
- `src/components/chat/SystemWarningStrip.tsx`

**删除前复核**：`grep` 全仓确认非注释引用为 0。仅剩的命中位于 `.worktrees/*`（其它 git 工作树）与参考代码目录，均非本项目源码。

**验证**：`typecheck` 0 错、`build` 通过、`unit` / `server` / `kernel` 三层全绿、文档口径门禁通过（并已把被删路径登记进白名单，理由：本文档的职责就是记录"哪些被判死代码、依据是什么"，必须能指名它们）。

### 保留待定 → 复核结论（2026-09-17 已完成，证据见文末）

| 文件 | 复核结论 | 一句话依据 |
|---|---|---|
| `src/components/boot/LogoMorph.tsx` | ✅ **可删** | 2026-09-10 **有意退役**（`ViewRouter.tsx:14` 注释"morph 退役…改为直切"）；**framer-motion 的唯一使用者** ⇒ 删除可连带卸载该运行时依赖 |
| `src/components/diagnostic/DiagnosticBanner.tsx` | ✅ **可删** | 职责已"收栏"进 `RightStatusRail`（同文件注释「诊断错误横幅收栏（2026-09-10）」：同 store、同 `openDiagnostics()` 动作、同 5s 自动隐去） |
| `src/components/browser/BrowserStatusBar.tsx` | ✅ **可删** | 职责已"收栏"进 `RightStatusRail` 浏览器段（打开窗口 / 暂停-恢复 / 清除 + 模仿徽标，控制齐全） |
| `src/components/ui/dropdown-menu.tsx` | ⛔ **不可删（原判定错误）** | 被 `src/components/chat/EffortPicker.tsx:20`、`src/components/layout/ApprovalModePicker.tsx:26` 使用 + `src/components/ui/index.ts:23` barrel 再导出 —— **活代码** |
| `src/components/settings/experienceFormat.ts` | ⛔ **不可删（另一处判定错误）** | 被 `ExperiencePanel.tsx:26` 导入、经 `SettingsView.tsx` 渲染（`section==='experience'`）；且有 `experienceFormat.test.ts` —— **活代码**（该条错记在规格文档 P2-3 章节，已同步纠正） |
| `server/interject.e2e.mjs` | ⏸ **保留** | 服务活跃功能（生成中插队/紧急插话）的**唯一端到端探针**，README 端口表与测试说明均有登记 |

> **原"理由"段已作废**：原先写"这 4 个组件的判定证据同样充分（仅注释提及）"——这句话对 `dropdown-menu.tsx` **不成立**（它有真实 import，不是"仅注释提及"）。保留它的真实理由（"基础件可能被留作后续 UI 使用"）也无法解释它**已在被两个组件使用**。**教训**：把"待定"与"已确证"混在一句里作概括，会把未验证的条目也染上已验证的语气。

---

## 第二批调研（2026-09-17）：复核 + 处置建议

### 一、两处判定错误（必须先纠正，否则会删坏构建）

**错误 1 · `src/components/ui/dropdown-menu.tsx`（记在本清单，误标"真死"）**
- 原文写"未被任何页面或 barrel 使用"——**与事实相反**。实测：
  - `src/components/chat/EffortPicker.tsx:20` → `import { DropdownMenu, … } from '@/components/ui/dropdown-menu'`
  - `src/components/layout/ApprovalModePicker.tsx:26` → 同上
  - `src/components/ui/index.ts:23` → barrel 再导出
- 若照原判定删除，`EffortPicker`（思考力度选择）与 `ApprovalModePicker`（审批模式选择）**直接编译失败**。

**错误 2 · `src/components/settings/experienceFormat.ts`（记在规格文档 P2-3 章节，误标"已确认无任何 import（仅注释提及）⇒ 优先删"）**
- 实测：`ExperiencePanel.tsx:26` 导入 `{ fmtAge, fmtBytes, normalizeInjectMax }`；`SettingsView.tsx:20` 导入 `ExperiencePanel` 并在 `:382`（`section === 'experience'`）渲染；另存在 `experienceFormat.test.ts`。**在设置页的活跃渲染路径上。**
- 附带风险：该文件承载一条**跨模块一致性约束**（`normalizeInjectMax` 的默认值须与 `server/bridge.mjs` 的 `experienceInjectConfig()` 一致）——删掉它，这条约束会失去前端侧的唯一落点。

### 二、误判根因（可防复发）

**不是时序问题**。所有使用方的引入时间都**早于**本清单：

| 文件 | 首次出现 |
|---|---|
| `src/components/ui/index.ts`（barrel 再导出 dropdown-menu） | 2026-09-08 |
| `src/components/settings/ExperiencePanel.tsx` | 2026-09-08 |
| `src/components/chat/EffortPicker.tsx`（引用 dropdown-menu） | 2026-09-09 |
| `src/components/layout/ApprovalModePicker.tsx` | 2026-09-12 |
| `src/components/settings/experienceFormat.ts` | 2026-09-14 |
| **本清单 `dead-code-triage.md`** | **2026-09-17** |

⇒ 使用关系在清单撰写前就全部存在，是**扫描漏判**。讽刺的是：本清单开头的"方法"节自称已修 **defect 2（`@/` 别名）** 与 **defect 3（barrel 再导出）**——而 `dropdown-menu` 恰恰**同时经由这两条路径**被使用，即那两个"已修缺陷"在这条上**仍然复发**。

**防复发做法（可执行）**：候选清单里的每一条，**必须用一个独立于原扫描器的方法逐条正面复核**，而不是信任扫描输出。最小可靠复核命令（对每个候选 `<Name>`）：
```bash
# 正面找"谁 import/export 了它"——不看扫描器的结论，直接问仓库
grep -rn "<Name>" --include=*.ts --include=*.tsx src/ | grep -vE "^src/.*/<Name>\.[tj]sx?$"
# 期望：只有注释行（含"morph/Morph"等说明性文字）才是真孤立的证据；
#       出现 `import`/`export … from` 行即立刻排除
```
> 本次三条"真孤立"（LogoMorph / DiagnosticBanner / BrowserStatusBar）就是用这个方法确认的：`LogoMorph` 只在 `CockpitScreen.tsx:32`、`ViewRouter.tsx:10` 的**注释**里出现，另两者全仓零提及。

### 三、三个真死组件的处置建议（证据充分，可安全删）

| 文件 | 行数 | 处置 | 关键证据 |
|---|---|---|---|
| `src/components/boot/LogoMorph.tsx` | 87 | **删除**（连带卸载依赖） | ① `ViewRouter.tsx:14` 明载「2026-09-10（**morph 退役**）：驾驶舱 ⇄ 工作屏过渡改为直切…morph overlay 反而制造延迟与闪烁」——**有意退役**，非未完成；② 全仓无 import，仅 2 处注释提及；③ 它是 **`framer-motion` 的唯一运行时使用者**（`package.json` 依赖 + `vite.config.ts:39` 的 `vendor-framer` 分包规则的唯一理由）⇒ 删除后可一并移除依赖、分包规则与 lockfile 条目，**净减维护面**（含供应链面）；④ 无伴生测试 |
| `src/components/diagnostic/DiagnosticBanner.tsx` | 32 | **删除** | ① `RightStatusRail` 内注释「**诊断错误横幅收栏（2026-09-10）**」——职责已迁入；② 同 store（`useDiagStore`）、同动作（`openDiagnostics()`）、同行为（5s 自动隐去）；③ 全仓零提及；④ `diagStore` 另有 4 处使用 ⇒ **无级联影响**；⑤ 无测试 |
| `src/components/browser/BrowserStatusBar.tsx` | 114 | **删除** | ① `RightStatusRail` 浏览器段已含 `openWindow` / 暂停-恢复 / 清除 全套控制 + 模仿徽标；② 全仓零提及；③ `browserStore` 另有 `RightStatusRail`、`useYFWCLI` 使用 ⇒ **无级联**；④ 无测试 |

**删除时的注意事项**
- **不要顺手改 `ViewRouter`/`RightStatusBar` 的注释**：它们描述的是**现状**（过渡直切、收栏）而非"引用了 LogoMorph/DiagnosticBanner"——只有 `CockpitScreen.tsx:32` 那类"通知 ViewRouter 播放 LogoMorph"的**过期注释**需要一并清除（该功能已不存在）。
- 删除会改变图谱数字（文件数 −3）⇒ 需重跑 `node scripts/build-arch-graph.mjs` 并同步文档（门禁 C 会逐条列出待改处）。
- 卸载 `framer-motion` 后须删 `vite.config.ts` 的 `vendor-framer` 分包规则（留着会生成一个空的 vendor chunk）。

### 四、`server/interject.e2e.mjs`：建议保留（不是死代码）

- 它对应的功能**活跃**：`kernel/cli.mjs` 有生成中"排队插话/紧急插话"的完整实现（P8）。
- 它是该功能**唯一的端到端探针**（真实 spawn 桥 + 内核，走 WebSocket），且 `README.md` 的端口表与测试说明**明确登记**了它（并说明它不匹配 `npm test` 的 glob，故需手跑）。
- **删除会丢掉唯一的 e2e 覆盖**——与"清理死代码"的目标相反。
- 可选的改进（非本次范围）：给它加一个 `npm run e2e:interject` 脚本，降低"因为难跑而失修"的风险。**在没有该脚本前，它的风险是 bit-rot（引用的消息名/端口变化后无人发现），而不是"占体积"。**

### 五、净收益小结

**删除 3 个前端组件（233 行）+ 卸载 1 个运行时依赖（`framer-motion`）**，**保留** 3 个被误判的活代码（`dropdown-menu`、`experienceFormat`、`interject.e2e.mjs`）。

> **本次调研最主要的产出其实是"阻止了 2 次误删"**——若按原清单执行，会破坏 `EffortPicker`、`ApprovalModePicker` 与设置页经验面板三处功能。**删除动作本身仍在等待人工确认**（判定 ≠ 删除）。

### 六、顺带复核：规格点名的"其余后端模块"（原为未决项）

规格 P2-3 曾列 5 个后端模块"先判动态加载 or 废弃"，但本清单**从未收录它们**（属漏落）。现一并复核：

| 模块 | 结论 | 依据 |
|---|---|---|
| `server/provider-profile.mjs` | ✅ **活代码** | `server/bridge.mjs:106` 静态导入 |
| `server/provider-probe.mjs` | ✅ **活代码** | `server/bridge.mjs:107` 静态导入 |
| `server/workflow-store.mjs` | ✅ **活代码** | `server/workflow-routes.mjs:12` 导入 |
| `kernel/config-scan.mjs` | ✅ **保留**（工具脚本） | 无 import 是**设计如此**——独立 CLI / 开发期文档生成器（`node kernel/config-scan.mjs [--out]`），已在 `docs/architecture.md` 与 `docs/2026-09-15-五引擎架构性能对比分析.md` 登记为"工具脚本" |
| ~~`knowledge-export`~~ | ⚠️ **该名字在仓库中不存在** | 规格里的写法为过期/笔误，需修正规格（不要在清单里留幽灵条目） |
| `shared/office-merge.mjs`（409 行 + 340 行测试） | 🔶 **未完成的集成（切勿当死代码删）** | 见下 |

**`shared/office-merge.mjs` 是"未接线"而非"废弃"**——证据链完整且两端都对不上：
- **UI 端**：`src/components/editor/FileCollabBar.tsx:282` 提供 `edit-merge`（"编辑合并"）按钮；`:54` 的类型里也有该选项。
- **决策端**：`kernel/file-collab.mjs:467` 注释明说"`edit-merge` 分支不在本函数里做合并：合并是 S1 的 `shared/office-merge.mjs` 的职责，**由上层按文件模态（docx 块 / xlsx 行）选择对应函数后调用**，本函数只给出'该去合并'的决策"。
- **实际**：全仓**没有任何代码调用** `office-merge` 的合并函数（`mergeDocxBlocks` / `mergeSheetRows` / `threeWayMerge` …）——唯一的 import 者是它**自己的测试**（`office-merge.test.mjs:27`）。
- ⇒ **用户在 UI 上点"编辑合并"后，合并动作无人执行**。这是**功能缺口**（或已放弃的功能），**不是死代码**。
- **需人决策**：①**接线**（在 HTTP/UI 层补调用，功能即补齐——测试已就绪，成本可控）；②**移除**（连 409+340 行一起删，并在 UI 上去掉按钮，避免留一个死按钮）。
- **在决策前不得删除**：删掉它会让 `FileCollabBar` 的 `edit-merge` 成为永久空操作，且丢失 S1 已写好的三路合并（含测试）。

> **本条对"孤立模块"清单的启示**：图上的"孤立"有三种截然不同的成因——**废弃**（可删）、**工具/入口**（设计如此，保留）、**未接线**（功能缺口，需决策）。**只看"孤立 + 无 import"无法区分三者**，必须去看"谁本该调用它"（如本例的注释与 UI 按钮）。
