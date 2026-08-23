# 上下文健康血条交互设计（HealthMeter）

日期：2026-08-18
状态：已确认（用户逐节批准）
关联：2026-08-13-health-monitor-design.md（内核健康计算）、healthMonitor.ts（内核 sdk 放行修复已完成）

## 背景与动机

现有"上下文健康警示"是聊天区顶部横幅（HealthBanner.tsx）：黄档纯文本条、红档含"开新会话"按钮的横幅。用户希望改为更沉浸、更贴近玻璃质感主题的**血条仪表**形态，并已确认以下决策：

| 决策点 | 选择 |
|---|---|
| 与顶部横幅关系 | **取代**（删除 HealthBanner） |
| 显示时机 | **常驻**（绿/黄/红全程可见） |
| 数据驱动 | 现有 ponos_health 档位事件 + CSS 扣血动画衔接（**不动内核**） |
| 红档呼吸警告 | **消息区边缘呼吸光晕** |
| 红档会话建议 | **输入框上浮卡片**（非模态） |
| 代码组织 | **独立三组件**：HealthMeter / HealthGlow / HealthSuggestCard |

## 目标

- 血条常驻输入框下方提示行（与输入框等长、衬于背景之上），随上下文剩余缩短、压缩后回涨
- 红档时双信号：消息区边缘呼吸光晕 + 上浮"重新发起会话建议"卡片
- 保持玻璃质感主题、不干扰消息阅读、不引起布局跳动
- 纯前端改造，无内核/无重启需求（前端构建同步 release 生效）

## 架构

### 组件划分

```
ChatWindow.tsx
├── HealthGlow            ← 消息区四边红色光晕（红档 + 未冷却时）
│   └── ScrollArea        ← 消息列表（现有）
└── ChatInput.tsx
    ├── HealthMeter       ← 提示行内血条（常驻，与输入框等长）
    └── HealthSuggestCard ← 提示行向上浮出的建议卡片（红档 + 未冷却时）
```

- `HealthMeter.tsx`：血条仪表（新）
- `HealthGlow.tsx`：边缘光晕 overlay（新）
- `HealthSuggestCard.tsx`：上浮建议卡片（新）
- `HealthBanner.tsx`：删除
- `healthStore.ts`：结构不变，语义微调（见下）

### 数据与状态层（healthStore）

现有结构**保持不变**（health/summary/summaryCompactCount/dismissedUntil + update/setSummary/dismiss/reset），语义重映射：

| 状态 | 旧用途 | 新用途 |
|---|---|---|
| `health` | 横幅数据源 | 三组件共享数据源（血条宽度/颜色、光晕开关、卡片内容） |
| `summary` | 红档携带摘要 | 卡片携带摘要（ponos_summary 事件链路不变） |
| `dismissedUntil` | 横幅关闭冷却（5min） | 卡片"稍后再说"冷却（沿用 RED_DISMISS_MS） |
| `dismiss()` | 横幅关闭 | 卡片关闭 |

- 红档可见性统一判定：`health.tier === 'red' && Date.now() >= dismissedUntil`（光晕与卡片同源，冷却期一起熄灭）
- 内核 `ponos_health`/`ponos_summary` → usePonosCLI.ts:512 事件链路**零改动**

## 组件设计

### HealthMeter（血条）

- 位置：ChatInput.tsx Composer hint 行（现 :744 `h-4 mt-1`），容器改 `relative`
- 形态：高 2.5px `rounded-full` 细条，绝对定位铺满整行（left-0/right-0 与输入框同宽），垂直居中；提示文字（"Enter 发送 · Shift+Enter 换行"）以 `z-10` 叠加其上保持原样
- 宽度：`width: remainingPct%`；health 为 null（首事件前）时显示 100% 极淡细线占位
- 颜色：`tier` 决定——green → `text-green-500`、yellow → `text-amber-500`、red → `text-red-500`（玻璃质感下用半透明渐变填充，避免纯色刺眼）
- 动画：`transition: width .45s ease-out`（扣血/回涨平滑衔接，档位跳变不突兀）
- 压缩动画：压缩发生时（`summaryCompactCount` 递增，ponos_summary 先于下一轮 ponos_health 到达）血条一次性高亮脉冲 1.2s（`filter: brightness` 提升后回落，不破坏半透明 alpha），宽度随后由 transition 回涨——同一信号两段动画衔接
- hover：复用现有 `Tooltip` 组件（ChatInput 已导入）显示「剩余 X% · 约 N 轮」补足黄档信息

### HealthGlow（边缘呼吸光晕）

- 位置：包裹消息区 ScrollArea 外层
- 形态：绝对定位 overlay（inset-0，`pointer-events-none`），四边红色 box-shadow（如 `0 0 24px 6px` rgba(red, .25)），`animate-pulse` 呼吸
- 触发：红档且未冷却（与卡片同源）

### HealthSuggestCard（上浮建议卡片）

- 位置：ChatInput 容器内 `absolute bottom-full` 向上浮出（与现有 Skill picker 面板同定位方式，ChatInput.tsx:767）
- 内容：
  - 标题：`health.reason`（如"已压缩3次 · 上下文剩余11%"）
  - 摘要预览 + 「携带摘要到新会话」勾选（默认勾选，carrySummary 逻辑复用）
  - 「开新会话」：执行现有 `createConversation(undefined, current?.agentId)` + `setPendingInput(summary, false)`（HealthBanner.tsx:19-27 逻辑迁移）
  - 「稍后再说」：`dismiss()`（5 分钟冷却）
- 动画：`animate-slide-up` + 浅阴影，与 Skill picker 面板同风格

### 挂载与删除

- 删除 `src/components/chat/HealthBanner.tsx`
- ChatWindow.tsx：移除 `<HealthBanner />`（:200），ScrollArea 外包 HealthGlow
- ChatInput.tsx：提示行内嵌 HealthMeter；容器挂 HealthSuggestCard
- i18n（zh-CN/en-US）：新增血条/卡片文案；清理不再使用的 `health.yellowHint`

## 测试

- healthStore 无行为变更，现有测试保持通过
- HealthMeter：宽度=remainingPct%、tier→颜色映射、health null 占位 100%
- HealthSuggestCard：红档显示 / 冷却隐藏 / 开新会话调用链（createConversation + setPendingInput）
- 纯前端组件测试（vitest），无内核改动

## 非目标

- 不改内核 healthMonitor 发射频率（档位跳变由前端动画衔接）
- 不做 token 级实时估算（用户确认"不平滑没事"）
- 不引入新的全局状态库

## 生效方式

前端构建（vite build）→ 同步 release 双副本 dist/assets → CDP 重载或重启生效（无内核、无 bridge 改动）。
