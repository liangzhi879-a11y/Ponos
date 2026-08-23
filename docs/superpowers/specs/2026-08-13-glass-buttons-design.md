# 磨砂玻璃主题：按钮质感升级（Glass Buttons）

日期：2026-08-13
状态：已批准实施（用户确认：半透明品牌玻璃 + 品牌辉光微上浮 + 全变体统一）

## 背景与问题

磨砂玻璃主题（theme-glass / theme-glass-warm）已覆盖面板、输入框、导航等，但按钮质感未对齐：
- **primary（15 处使用）**：实心 `var(--brand-500)` 色块，是所有玻璃面板中最突兀的实色块，无内高光、无辉光。
- **ghost（32 处，最常用）**：hover 时 `bg-hover` 半透明+模糊，已基本玻璃化，缺悬停反馈层次。
- **secondary / outline / danger / success**：半透明填充已有，缺统一的玻璃光影语言。

## 目标

按钮与磨砂玻璃主题统一视觉语言：半透明填充（随透光度滑块缩放）、顶部内高光、微光泽、悬停品牌辉光 + 微上浮、按下回落。仅作用于玻璃主题，其余 4 个主题零影响。

## 方案（已选定：方案 A）

- **button.tsx**：cva 基础类新增 `glass-btn`（1 行改动）。
- **globals.css**：新增 `:root[class*=theme-glass]` 作用域下的 `.glass-btn` 规则组（置于既有面板规则之后，靠后定义赢得同优先级竞争），单一来源维护玻璃按钮样式。

## 设计细节

### 1. 共享玻璃骨架（`.glass-btn`，玻璃主题内）

- 顶部内高光：`box-shadow: inset 0 1px rgba(255,255,255,.12)`
- 微光泽渐变：`background-image: linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,0) 45%)`（叠加在填充色之上）
- hover 微上浮：`transform: translateY(-1px)`；active 回落 `translateY(0)`
- `:disabled`：禁位移、禁辉光（`transform: none`）
- 过渡沿用现有 `transition-all duration-150`

### 2. primary — 半透明品牌玻璃

- 填充：`color-mix(in srgb, var(--brand-500) calc(var(--glass-opacity, .3) * 2.6), transparent)`
  - 默认 0.3 → 78% 通透；滑块拉高趋近实色（>100% 时 color-mix 钳制为 1.0），与主题整体行为一致
- 背景模糊：沿用既有 `[class*=bg-brand-]` 模糊规则（blur(18px) saturate(150%)）
- 文字：沿用 `text-inverse`（深色文字）
- hover：品牌辉光 `0 4px 24px -4px color-mix(in srgb, var(--brand-500) 60%, transparent)` + 上浮；填充透明度抬升
- active：辉光收拢、`translateY(0)`、填充压暗
- 排除标签页的 `bg-brand-500/15` 淡色（`:not([class*="bg-brand-500/"])`）

### 3. danger / success

- 保留现有 rgb 半透明填充（bg-error/15、bg-success/15）与描边
- hover：各自红/绿辉光 + 上浮；active 回落

### 4. ghost / secondary / outline

- 中性柔光：`0 4px 16px -4px rgba(255,255,255,.08)` + 上浮
- ghost 悬停保留现有 `bg-hover` 玻璃底；secondary 保留 `bg-elevated`；outline 保留描边

### 5. 不变项

- link 变体（文字链接）不套 `.glass-btn` 特效
- focus-visible 环、disabled opacity-50 保持现状
- 非玻璃主题（`theme-*` 其余 4 个）：所有规则位于 `:root[class*=theme-glass]` 作用域下，零影响

## 验证

- 构建后 Electron 无头实测（禁 transition 测稳态）：primary 在 op=0.3 为 ~78% 品牌色半透明 + 内高光 + 模糊；hover 辉光与上浮存在；danger/success/ghost/secondary 均含内高光与辉光；非玻璃主题按钮无变化。
- 同步 dist 至 release/Ponos 与 release/Ponos_ms92cd6u，用户手动重启。

## 范围外（YAGNI）

- 不做按钮涟漪/水波点击动效
- 不改动 link 变体与 focus 环
- 不新增组件级 props（loading 态等保持现状）
