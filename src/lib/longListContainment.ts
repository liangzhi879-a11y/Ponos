// 长会话消息列表的 containment 开关（R6，2026-09-13「任务运行慢」系统性优化）
// ---------------------------------------------------------------------------
// 病根：消息列表没有虚拟化（`ChatWindow.tsx` 的注释明确记着"虚拟列表是被移除的"），
// 每条消息的整棵子树都参与排版。真 Chromium（Electron 探针）实测**首屏首排**：
//   100 条 33ms / 200 条 62ms / 400 条 147ms（≈0.35ms/条），
// 且此后每次**内容变化**（流式追加、高亮翻转…）都要把整表重排一遍：
//   每条消息追加后强排 0.13ms @100 条 → 0.31ms @400 条。
//
// 做法：给消息节点挂 `content-visibility: auto` + `contain-intrinsic-size: auto 120px`
// （规则在 `src/styles/globals.css`，本模块只负责"什么时候挂"）。离屏子树跳过
// style/layout/paint，滚到附近才排版。同一组用例实测：
//   首排 0.3–2.8ms（≈50×）、追加后强排 0.003ms（≈50–100×）。
//
// 为什么**不做**原计划的另一半 `useVirtualScroll + useSyncExternalStore`：
// 用真 React 探针量化过 —— 一次滚动事件里 `setState` 一个**同值**布尔值，跨 100 个独立
// task 只产生 **1 次**渲染（React 自身对同值的 bailout）；换成快照 store 是 **0 次**。
// 省下的就是这一次，却要引入整条快照链路。原计划的前提是"普通滚轮 tick 会触发 commit"，
// 实测该前提本就不成立 ⇒ 不值得。
//
// 代价（必须知道，不藏着）：被跳过**且从未排版过**的消息只能按估算高度计入总高 ⇒
// 滚动条/scrollHeight 不准。应用形态的混合样本（短消息 / 中等 / 带代码块）实测：
//   估算总高 = 真实总高的 0.742（中位消息真实高 198px）——**低估**，不是高估。
// 低估方向更安全：上翻时未排版的内容只会**变高**，Chromium 的 scroll anchoring
// （`overflow-anchor` 默认 `auto`，已在探针里核对）会保持视口内容不跳。
// 且一旦某条消息排版过一次，`auto` 关键字就记住它的真实高度，不再用估算值。
// HistoryView 的跳转（`querySelector + scrollIntoView({block:'center'})`）也已实测：
// 目标是跳过态（高度=估算 133px）时跳过去会就地排版成真实 261px 并居中（偏差 1px），
// 跳转后继续滚动正常 —— 该功能不受影响。
//
// 阈值：**仅对长会话启用**。首排开销要到 100 条（≈33ms）才有感知，短会话挂着只有估算
// 误差、没有收益。60 条 ≈ 20 屏，已是明确的"长会话"（实机长会话的请求面在 174–226 条）。
export const CONTAINMENT_MIN_MESSAGES = 60

/** 挂在滚动容器上的类名；`src/styles/globals.css` 里的规则依赖它，改名必须同步（有测试钉死） */
export const CONTAINMENT_CLASS = 'msg-contain'

/** 消息条数是否达到启用 containment 的门槛（`NaN` / `undefined` 天然比较为 false = 不启用） */
export function shouldContainMessageList(messageCount: number, min = CONTAINMENT_MIN_MESSAGES): boolean {
  return messageCount >= min
}

/**
 * 滚动容器的类名：达到门槛才追加 {@link CONTAINMENT_CLASS}。
 * 抽成纯函数是为了让"挂没挂、挂几条才算长"这件事能被 `npm test` 钉住——组件本体是 `.tsx`，
 * 而 Node 的类型擦除不认 `.tsx`（实测 `Unknown file extension ".tsx"`，本仓不引打包器跑测试），
 * 留在 JSX 里的表达式任何单测都够不着。
 */
export function viewportClassName(base: string, messageCount: number, min = CONTAINMENT_MIN_MESSAGES): string {
  return shouldContainMessageList(messageCount, min) ? `${base} ${CONTAINMENT_CLASS}` : base
}
