// shared/egress-tools.mjs —— 「出网工具」名单的**唯一真源**（E2 Task 2 修复轮 R=1 新增）。
//
// ★ 为什么必须合并成一份（病根）：同一个事实（"这个工具真的发网络请求"）此前散在**两份名单**里：
//   · `kernel/workflow-nodes.mjs` 的 `EGRESS_TOOLS = new Set(['WebFetch','WebSearch'])`
//     —— 决定 `grant.network` 是不是必填（= 授权卡上「访问网络」开关有没有判据）；
//   · `kernel/approval-mode.mjs` 的 `NET_TOOLS = new Set([WebFetch, WebSearch, Vision, SkillSearch])`
//     —— 决定审批档位里"出网"类从哪一档起自动放行。
//   名单漂移的后果不是"文案不一致"，而是**开关静默失效**：新增一个真出网工具、只改了其中一份，
//   另一处的判据就对这个工具不存在（正是本轮要消灭的"假开关"形态）。
//   ⇒ 现在两侧 import 同一常量；渲染层那份由跨边界守卫测试钉住（见下）。
//
// ★ 两组名单的语义（**不要合并成一组**）：
//   · `EGRESS_WEB_TOOLS` = 打**公网**的工具 ⇒ 需要「访问网络」运行级授权（`grant.network`）。
//   · `EGRESS_NET_TOOLS` = **所有**出网工具（含只走 provider 的 `Vision`、只抓技能市场的 `SkillSearch`）
//     ⇒ 审批档位里同归 `net` 类。两组都必须包含前者：`Vision` 出网但不必过 `grant.network`
//     （它走 provider 能力，由 `shared/egress-capability.cjs` 的 `provider` 类管），
//     把它并进 `EGRESS_WEB_TOOLS` 会让授权卡多勾一项**内核并不检查**的开关 —— 那是反向的"假开关"。
//   ⇒ 不变量 `EGRESS_WEB_TOOLS ⊂ EGRESS_NET_TOOLS` 由 `src/lib/workflowModel.test.ts` 的同名用例断言。
//
// ★ 为什么渲染层（`src/**`）**不** import 本文件（不是懒，是**做不到**；登记于此，避免后人重试）：
//   `tsconfig.json` 未开 `allowJs` 且 `include: ["src"]` ⇒ 从 src import `shared/*.mjs` 会让
//   `tsc` 直接 TS2307（无类型声明）⇒ `npm run build` 红。仓内明文约定见 `src/lib/knowledgeQuery.ts:4`
//   （「前端不 import shared/*.mjs」），既有先例（`src/lib/proxyUi.ts` ↔ `shared/proxy-config.cjs`）的
//   解法 = **UI 侧手写同口径常量 + 跨边界守卫测试**。
//   ⇒ UI 那份 = `src/lib/workflowModel.ts#NETWORK_TOOLS`，由 `src/lib/workflowModel.test.ts` 的
//   「出网工具名单跨边界一致」用例断言：UI == 本文件 == `classifyTool` 的实际分类，
//   且 UI「联网」分组新增而未登记的工具会被判红。新增出网工具时漏改任一侧 ⇒ 测试红，不会静默漂移。
export const EGRESS_WEB_TOOLS = Object.freeze(['WebFetch', 'WebSearch'])
export const EGRESS_NET_TOOLS = Object.freeze(['WebFetch', 'WebSearch', 'Vision', 'SkillSearch'])
