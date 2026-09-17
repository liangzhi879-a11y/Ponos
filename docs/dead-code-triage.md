# 死代码三态判定（P2）

结论先行：全仓 **10 个模块属"真死候选"**（9 个前端组件 + 1 个 e2e 脚本），另有 2 个"仅测试引用"应**保留**、23 个"动态/间接引用"**不得当死代码删除**。**本文只做判定，不执行删除**（理由见末节）。

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

**前端组件（9）——多为"职责已被吸收/迁移后遗留的原件"**

- `src/components/chat/MessageBubble.tsx`、`src/components/chat/TaskCwdBar.tsx`、`src/components/chat/FirstBytePendingBar.tsx`、`src/components/chat/KernelStallBar.tsx`、`src/components/chat/SystemWarningStrip.tsx` —— 这几个的注释多处写着"自 X 迁入/从 X 抽出"，说明其职责已并入其它组件。
- `src/components/diagnostic/DiagnosticBanner.tsx`
- `src/components/browser/BrowserStatusBar.tsx`
- `src/components/boot/LogoMorph.tsx` —— 过渡动画已由 `src/components/layout/ViewRouter.tsx` 自行持有；仅剩注释提及。
- `src/components/ui/dropdown-menu.tsx` —— shadcn 式基础件，未被任何页面或 barrel 使用。

**脚本（1）**

- `server/interject.e2e.mjs` —— `.e2e.mjs` 属手工运行的端到端脚手架，不在模块依赖图内；判定为"无运行入口"，但**是否仍需保留应问维护者**（它可能是有意留在仓库、按需手跑的探针）。

## ② 仅测试引用（2）—— 保留

- `server/test-bridge-auth.mjs` —— 被 **20 个** server 测试引用（起桥鉴权的公共辅助）。
- `kernel-tests/helpers/fidelity-fixture.mjs` —— 被 `kernel-tests/compact-fidelity.test.mjs` 引用。

这两个是**测试基建**，产品代码不用属正常。列入此处只为说明"它们不是死代码"，**不建议删除**。

## ③ 动态/间接引用（23）—— 不得当死代码删

含应用入口与 CLI（如 `electron/main.cjs`、`src/main.tsx`）、fixture、以及通过字符串路径被工具引用的模块。

⚠️ 这一栏是**宽松启发式**（判据：其它文件中出现该模块的完整文件名）。它的价值是**拦住误删**，**不是**断言"该模块确实被字符串引用了"——其中有若干只是名字偶然出现在无关文本里（配置文件、说明文字）。因此本栏的正确用法是：**看到自己关心的模块出现在这里，就必须人工确认，而不能直接删**。

## 决策：本次不执行删除

1. **判定 ≠ 删除。** P2 这一项要的是"哪些能删"的结论，删代码是独立的、可回滚性更低的一步，应由人点头。
2. **风险不对称。** 删 9 个组件若其中有一个实际被用到，代价是运行时白屏；保留它们的代价只是几 KB 体积。在证据只覆盖静态图的情况下，不值得赌。
3. **可安全执行的验证路径**（建议下一步按此走）：先删 ① 中**明确是遗留原件**的 5 个 `src/components/chat/*`，然后依次跑 `npm run typecheck`、`npm run build`、`npm run test:ci` —— 三步全绿即视为安全；`LogoMorph.tsx` 与 `dropdown-menu.tsx` 建议单独确认（前者是本轮 logo 相关改动的产物，后者可能被有意留作后续 UI 使用）。
