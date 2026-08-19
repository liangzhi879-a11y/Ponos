# 导航栏会话里程碑进度条 — 设计文档

日期：2026-08-10
状态：已确认（用户逐节批准）

## 1. 背景与目标

导航栏会话列表中，执行中的会话需要"在背景显示任务进度"。内核（Claude Code CLI）是开放式 agent 循环，没有真实的 0-100% 总进度信号，因此**不伪造百分比**，改为**里程碑驱动的真实进度**：

- agent 在任务开工前（内部）拟定任务目标与阶段/里程碑清单
- 到达每个里程碑时输出结构化 check 标记
- 前端解析标记 → 按"当前里程碑/总里程碑"显示真实进度

### 明确的产品语义（用户确认）

- 里程碑标记与计划**全部从对话流剥离**——不显示计划文本、不显示标记本身
- 会话标签标题**保持不变**，进度条仅作为会话条目**背景**的动态元素
- 除 spec/plan 这类用户主导的明确项外，agent 无需向用户提供里程碑信息
- 无里程碑的简单任务（闲聊/单步问答）回退为**活动条**（中间亮光、两端渐细）

## 2. 方案选型

**采用方案 A：系统提示协议**（用户确认）。

- bridge 已在 spawn CLI 时通过 `--append-system-prompt-file` 注入 `YFW_SYSTEM_PROMPT` + 技能清单（bridge.mjs `buildChildEnv` 附近、约 line 537）
- 在该系统提示中**追加里程碑协议规则**，约定 agent 行为
- 结构化标记由 bridge 解析剥离并转发事件——与提问卡片（`<!--ASK_USER-->`）机制完全同构
- 不改内核 bundle（避免重建产物的既定风险）；"强制 check"依赖模型遵循系统提示

## 3. 里程碑协议

### 3.1 agent 行为规则（注入 YFW_SYSTEM_PROMPT 的追加段落）

```
【任务里程碑进度协议】
- 执行多步骤/多阶段任务时：开始实施前，先内部拟定任务目标与阶段/里程碑清单，
  并用一行结构化标记声明总里程碑数及各里程碑名称：
  <!--MILESTONES 3 需求分析|方案设计|编码实现-->
- 每完成一个里程碑，立即输出该里程碑的达成标记：
  <!--MILESTONE-OK 1/3 需求分析-->
- 简单任务（闲聊、单步问答）无需声明里程碑。
- 以上标记仅用于进度展示，不要向用户解释标记本身。
- spec/plan 任务：以用户主导的计划步骤作为里程碑。
```

### 3.2 标记格式

- 计划声明（一条，单行）：`<!--MILESTONES <total> <名称1>|<名称2>|...-->`
  - `<total>`：正整数，总里程碑数
  - 名称列表以 `|` 分隔（名称内允许空格/中文，不含 `|`）
- 达成 check（可多条，单行）：`<!--MILESTONE-OK <index>/<total> <名称>-->`
  - `<index>` 从 1 开始

## 4. 事件流

### 4.1 bridge 解析（server/bridge.mjs，现有 assistant 文本解析处，与提问卡片同构）

在 `parsed.type === 'assistant'` 遍历 text block 时：

1. 正则提取 `<!--MILESTONES ...-->` 与 `<!--MILESTONE-OK ...-->`
2. 从文本中**剥离**匹配到的标记（剩余文本照常作为 assistant 内容转发，对话流无标记残留）
3. 转发事件：
   - `{ type: 'milestones', sessionId, data: { total, names: string[] } }`
   - `{ type: 'milestone-ok', sessionId, data: { index, total, name } }`

### 4.2 前端状态（src/stores/chatStore.ts）

```ts
// per-conversation
conversationProgress: Record<string, {
  total: number          // 总里程碑数
  names: string[]        // 里程碑名称列表（tooltip 用）
  current: number        // 当前已完成里程碑数，0..total
}>

setConversationMilestones(conversationId, total, names)  // 收到 milestones 事件；覆盖旧计划
setMilestoneDone(conversationId, index)                  // 收到 milestone-ok 事件；current = max(current, index)
clearConversationProgress(conversationId)                // 删除会话时清理
```

- 新里程碑计划到达时整体覆盖（total/names/current 重置）
- 事件到达时若会话未在 streaming（异常场景）也应记录，避免丢进度

## 5. Sidebar 渲染（src/components/layout/Sidebar.tsx）

ConversationItem 条目**底部 2px 背景进度条**：

| 会话状态 | 进度条形态 |
|---|---|
| 执行中 + 有里程碑 | 真实进度：填充宽度 = current/total × 100%，平滑过渡 |
| 执行中 + 无里程碑 | 活动条：光带左右循环流动 |
| 待回复（isAwaiting） | 冻结当前宽度（不动画不增长），保持显示 |
| 非执行中 | 不显示 |

- hover tooltip：有里程碑显示 `当前里程碑名  index/total`（如"方案设计 2/3"）；活动条显示"执行中"
- 进度条为背景装饰，不影响标题布局；`conv.pinned`/加载图标/待回复圆点等现有元素不变

### 5.1 视觉规范（用户确认，适配四主题）

全部使用主题 CSS 变量（`--brand-300/400/500` 等，4 主题各自定义 → 自动适配）：

- **真实进度**：尾端渐细、头部亮光
  - 填充层 `background: linear-gradient(90deg, transparent 0%, var(--brand-500) ~55%, var(--brand-300) 100%)`
  - 尾部（左端）渐细：CSS mask 线性渐变淡出
  - 头部（右端，前进方向）亮光：`box-shadow: 0 0 6px var(--brand-400)` + 头部亮色（--brand-300）
- **活动条**：中间亮光、两端渐细
  - 一条约 40% 宽的光带在条内左右循环流动
  - `background: linear-gradient(90deg, transparent, var(--brand-400) 50%, transparent)`
  - CSS animation 平移循环（暂停于 `isAwaiting`/`prefers-reduced-motion`）

## 6. 边界处理

- 达成 index 超出 total → 钳制到 total；current 取 `max(current, index)`（容忍乱序 check）
- 计划声明但零 check → 进度 0%，正常结束（非 streaming 后不渲染，无碍）
- 新计划覆盖旧计划（多轮任务）
- 删除会话 → `clearConversationProgress` 同步清理
- 标记格式异常（total 非数字等）→ 忽略该标记，不崩溃，走活动条回退
- `prefers-reduced-motion` 时活动条静态显示（不流动）

## 7. 影响范围

- `server/bridge.mjs`：系统提示追加协议段落 + assistant 解析处提取/剥离/转发
- `src/stores/chatStore.ts`：`conversationProgress` + 3 个 action（type 定义 + persist 默认值）
- `src/hooks/useYFWCLI.ts`：新增 `milestones` / `milestone-ok` 事件 handler
- `src/components/layout/Sidebar.tsx`：ConversationItem 背景进度条 + tooltip
- `src/styles/globals.css`（或新增局部样式）：进度条 CSS（动画、渐变、mask、glow）
- **不改**：内核 bundle、会话标题、对话流内容、i18n（进度条无文案，tooltip 用现有翻译/硬编码样式统一处理）

## 8. 测试

1. **bridge 单元验证**：构造含标记的 assistant 文本 → 断言剥离干净、`milestones`/`milestone-ok` 事件正确；乱序/超界/畸形标记不崩溃
2. **前端状态**：mock 事件流 → store 的 current/total 推进正确（含覆盖、钳制、清理）
3. **渲染**：Sidebar 三种形态（真实进度/活动条/无）+ 四个主题（yuanfang-light/yuanfang/dark/light）视觉一致
4. **端到端**：真实多步骤任务观察进度推进；简单任务验证活动条；提问卡片期间验证冻结
5. **回归**：`npx tsc --noEmit` + `npx vite build` 通过；同步 release 副本（bridge.mjs + dist）

## 9. 未决项（实现时顺带确认）

- 四主题下 glow 强度是否需要深浅差异微调（light 主题 glow 收敛）——实现时按变量微调，不单独开议题
