# GUI 设计语言统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全前端界面统一到驾驶舱设计语言（Boost 橙 `#FF7429` + 单对角切角 + 克制光效 + 微标排版），主题 6→4（深/浅 × 实色/玻璃），登录/首设/锁定/boot/驾驶舱 iframe 全主题跟随。

**Architecture:** Token 先行三阶段：P1（T1-T4）主题 ID 收敛 + 驾驶舱语言变量 + `.cut` 工具类 + 设置页；P2（T5-T7）工作界面/聊天/浮层消费新语言；P3（T8-T11）品牌屏（登录/boot/驾驶舱桥接）+ 全量回归。每个任务独立可提交、可验收。

**Tech Stack:** React 19 + Tailwind v4（语义 token，零裸 hex）+ CSS 变量（themes.css 主题块）+ Electron（GLASS_THEMES 透明窗）+ Node 24 原生 TS `node:test`。

**Spec:** `docs/superpowers/specs/2026-09-10-gui-design-unification-design.md`（唯一事实源，本计划与其一致）。
**视觉验收基准:** `scratch/unified-design-mockup.html`（浏览器打开，含 明暗/切角·圆角/光效三档 切换）。

## Global Constraints

- 组件样式只引用语义变量（`--bg-*/--text-*/--border-*/--brand-*/--accent-*`）+ T3 新增语言变量（`--grad-brand/--line-hot/--glow-soft/--glow-hot/--halo/--micro-track`）；**禁止新增裸 hex**（ThemePicker 卡内 mini 预览与 cockpit `public/` 独立文件除外，后者自有 token 集）。
- 切角 = 单对角（左上+右下），刻度 12/10/8/6px；**不切角**：tooltip、chip/徽章、头像、开关、状态点、进度轨道、代码块。不做镜像。
- 光效仅 5 项白名单（spec §3.3）：① logo 呼吸光晕 ② hover/选中 `--glow-hot` ③ 运行状态点脉冲 ④ 品牌静态渐变 ⑤ hot 描边。工作界面禁止粒子/涟漪/大面积渐变。
- 微标：8.5px Arial 全大写 letter-spacing `var(--micro-track)`，固定英文不进 i18n；数字 `tabular-nums`。
- 2.5px 品牌渐变顶线（`.topline`）仅两处：登录卡顶、驾驶舱详情面板顶（已有）。
- 图标契约不变：lucide 全局唯一、禁 emoji（2026-09-08 spec §8.2）。
- 不动 `kernel/`、`server/`；`electron/main.cjs` 仅改 `GLASS_THEMES` 列表值与 backgroundColor 兜底两个 hex。
- 测试基线：`npm run typecheck`、`npm run build`（tsc && vite build）、`npm test`（server+electron）、`node --test src/lib/*.test.ts`（Node 24 原生 TS，**相对导入必须带 `.ts` 后缀**）。
- 每任务提交一次，commit message：`feat/refactor/docs(gui-ux): <中文摘要>`。

## File Structure

| 文件 | 职责 | 涉及任务 |
|------|------|----------|
| `src/lib/themeMap.ts`（新） | 旧主题 ID → 新 ID 纯函数 + ThemeId 常量 | T1 |
| `src/lib/themeMap.test.ts`（新） | 上述单测 | T1 |
| `src/types/index.ts` | `ThemeMode` 联合类型、`THEMES`（4 条）、`THEME_CLASS_NAMES` | T2 |
| `src/main.tsx` | 预挂载 THEME_BG/THEME_FG（4 项）+ 迁移 | T2 |
| `src/stores/settingsStore.ts` | 默认主题 `dark` + rehydrate 迁移 | T2 |
| `electron/main.cjs` | `GLASS_THEMES`（:442）、backgroundColor 兜底（:482） | T2 |
| `src/styles/themes.css` | 6 主题块 → 4 主题块 + 语言变量 | T2 |
| `src/styles/globals.css` | `.cut` 族/`.topline`/`.micro`/`.orb`/动画/玻璃 backdrop 选择器 | T3 |
| `src/components/settings/SettingsView.tsx` | ThemePicker（1144 行起内部函数）、玻璃条件、i18n | T4 |
| `src/components/ui/switch.tsx` | on 态品牌渐变 | T4 |
| `src/i18n/translations/zh-CN.ts` / `en-US.ts` | 主题计数文案键（themeCount） | T4 |
| `src/components/layout/{Header,RailNav,SecondPanel,StatusBar}.tsx` | 工作屏 chrome | T5 |
| `src/components/chat/{MessageBubble,QuestionCard,FloatingQuestionCard,ChatInput,EffortPicker}.tsx` | 聊天族 | T6 |
| `src/components/ui/{dialog,dropdown-menu}.tsx`、`src/components/command-palette/CommandPalette.tsx` | 浮层 | T7 |
| `src/components/auth/AuthScreen.tsx` + `globals.css`(.auth-bg) | 登录/首设/锁定 | T8 |
| `src/components/boot/BootScreen.tsx` + `src/styles/boot.css` | 加载屏 | T9 |
| `src/components/cockpit/CockpitScreen.tsx` + `public/cockpit/index.html` | 驾驶舱桥接 + 4 模式 + 单对角 | T10 |

---

### Task 1: migrateThemeId 迁移纯函数

**Files:**
- Create: `src/lib/themeMap.ts`
- Test: `src/lib/themeMap.test.ts`

**Interfaces:**
- Produces: `THEME_IDS: readonly ['dark','light','dark-glass','light-glass']`、`type ThemeId`、`migrateThemeId(old?: string): ThemeId`（T2 消费）。

- [ ] **Step 1: 写失败测试** `src/lib/themeMap.test.ts`

```ts
// src/lib/themeMap.test.ts
// node --test src/lib/themeMap.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateThemeId, THEME_IDS } from './themeMap.ts'

test('旧值 6 个 → 新 4 值', () => {
  assert.equal(migrateThemeId('yuanfang'), 'dark')
  assert.equal(migrateThemeId('dark'), 'dark')
  assert.equal(migrateThemeId('yuanfang-light'), 'light')
  assert.equal(migrateThemeId('light'), 'light')
  assert.equal(migrateThemeId('glass'), 'dark-glass')
  assert.equal(migrateThemeId('glass-warm'), 'dark-glass')
})
test('缺省/垃圾值 → dark', () => {
  assert.equal(migrateThemeId(undefined), 'dark')
  assert.equal(migrateThemeId(''), 'dark')
  assert.equal(migrateThemeId('??'), 'dark')
})
test('新值幂等', () => {
  for (const id of THEME_IDS) assert.equal(migrateThemeId(id), id)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/lib/themeMap.test.ts`
Expected: FAIL（Cannot find module './themeMap.ts'）

- [ ] **Step 3: 实现** `src/lib/themeMap.ts`

```ts
// src/lib/themeMap.ts —— 主题 ID 收敛 6→4 的迁移纯函数
// 映射表（spec §1.1）：旧值 → 新值；未知/缺省 → 'dark'；新值幂等。
export const THEME_IDS = ['dark', 'light', 'dark-glass', 'light-glass'] as const
export type ThemeId = (typeof THEME_IDS)[number]

const LEGACY_MAP: Record<string, ThemeId> = {
  'yuanfang': 'dark',
  'dark': 'dark',
  'yuanfang-light': 'light',
  'light': 'light',
  'glass': 'dark-glass',
  'glass-warm': 'dark-glass',
}

export function migrateThemeId(old?: string): ThemeId {
  if (old && (THEME_IDS as readonly string[]).includes(old)) return old as ThemeId
  return (old && LEGACY_MAP[old]) || 'dark'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/lib/themeMap.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/lib/themeMap.ts src/lib/themeMap.test.ts
git commit -m "feat(gui-ux): 主题 ID 收敛迁移纯函数 migrateThemeId（6→4，旧值/垃圾值兜底 dark）"
```

---

### Task 2: 主题 ID 收敛切换（types + 预挂载 + store + electron + themes.css 四块）

> 原子任务：类型、消费点、CSS 主题块必须同一提交落地（拆开即 typecheck 红或视觉断档）。

**Files:**
- Modify: `src/types/index.ts`（ThemeMode 联合类型 + `THEMES` 数组 + `THEME_CLASS_NAMES`）
- Modify: `src/main.tsx`（THEME_BG/THEME_FG 4 项 + 预挂载迁移）
- Modify: `src/stores/settingsStore.ts`（:37 默认值、:230 onRehydrateStorage）
- Modify: `electron/main.cjs`（:442 GLASS_THEMES、:482 backgroundColor 两个 hex）
- Modify: `src/styles/themes.css`（6 块 → 4 块；:685-691 color-scheme 6 行 → 4 行）
- Modify: `src/styles/globals.css`（搜 `theme-glass` 的 backdrop-filter 选择器，扩入新类名）

**Interfaces:**
- Consumes: `migrateThemeId`、`THEME_IDS`（T1）
- Produces: `ThemeMode = 'dark'|'light'|'dark-glass'|'light-glass'`、4 条 `THEMES`、html 类名 `theme-dark|theme-light|theme-dark-glass|theme-light-glass`、语言变量（T3 起消费）

- [ ] **Step 1: types/index.ts 三处替换**

`ThemeMode` 联合类型 → `export type ThemeMode = 'dark' | 'light' | 'dark-glass' | 'light-glass'`
（若 ThemeMode 定义在 ThemeMeta 之前/别处，全局搜 `yuanfang-light` 于 types 内一并清理。）

`THEMES` 数组整体替换（ThemeMeta 字段结构不变；`category` 取值收窄为 `'solid'|'glass'`，同步改字段类型声明）：

```ts
export const THEMES: readonly ThemeMeta[] = [
  { id: 'dark', name: '远方', variant: '深色', tagline: '深空墨 · Boost 橙', glyph: '远',
    primary: '#ff7429', deep: '#f05a0a', surface: '#0b0e14', isDefault: true,
    mode: 'dark', category: 'solid' },
  { id: 'light', name: '远方', variant: '浅色', tagline: '暖白 · Boost 橙', glyph: '远',
    primary: '#ff7429', deep: '#e8590c', surface: '#fdf9f5',
    mode: 'light', category: 'solid' },
  { id: 'dark-glass', name: '远方', variant: '深色玻璃', tagline: '墨玻璃 · 暖橙极光', glyph: '璃',
    primary: '#ff7429', deep: '#f05a0a', surface: '#0b0e14',
    mode: 'dark', category: 'glass' },
  { id: 'light-glass', name: '远方', variant: '浅色玻璃', tagline: '暖金微光 · 白磨砂', glyph: '璃',
    primary: '#ff7429', deep: '#e8590c', surface: '#fdf9f5',
    mode: 'light', category: 'glass' },
]
```

`THEME_CLASS_NAMES` → `{ dark: 'theme-dark', light: 'theme-light', 'dark-glass': 'theme-dark-glass', 'light-glass': 'theme-light-glass' }`

- [ ] **Step 2: main.tsx 预挂载**

顶部 import 增 `import { migrateThemeId } from './lib/themeMap.ts'`；两个 map 替换为：

```ts
const THEME_BG: Record<ThemeMode, string> = {
  'dark': '#0b0e14', 'light': '#fdf9f5',
  'dark-glass': '#11161f', 'light-glass': '#fffdfb',   // 玻璃取面板基色兜底
}
const THEME_FG: Record<ThemeMode, string> = {
  'dark': '#f0e6d8', 'light': '#24272c',
  'dark-glass': '#f0e6d8', 'light-glass': '#24272c',
}
```

预挂载判断块：`const theme = parsed?.state?.settings?.theme` 之后、`if (THEMES.some(...))` 改为：

```ts
const tid = migrateThemeId(theme)
if (THEME_BG[tid]) {
  const root = document.documentElement
  root.classList.remove(...THEME_CLASS_NAMES)
  root.classList.add(`theme-${tid}`)
  document.body.style.background = THEME_BG[tid]
  document.body.style.color = THEME_FG[tid]
}
```

- [ ] **Step 3: settingsStore.ts**

:37 `theme: 'yuanfang-light'` → `theme: 'dark'`。
:230 `onRehydrateStorage` 回调内、现有补缺逻辑**之前**插入：

```ts
const nextTheme = migrateThemeId(state.settings.theme)
if (nextTheme !== state.settings.theme) state.settings.theme = nextTheme
```
（import `migrateThemeId`。若该钩子不回写 localStorage 则不必额外处理——重放幂等。）
另跑 `grep -n "theme" src/components/layout/ViewRouter.tsx`：html class 切换 effect 只读 `store.settings.theme`（rehydrate 已归一）则**无需改动**；若发现旧 ID 字面量直接引用，按新 ID 改。

- [ ] **Step 4: electron/main.cjs**

:442 → `const GLASS_THEMES = ['dark-glass', 'light-glass']`
:482 backgroundColor 兜底两 hex → 浅色 `'#fdf9f5'`、深色 `'#0b0e14'`（保持 `themeMeta.mode === 'light' ? ... : ...` 结构不动）。
同文件若还有按旧主题 ID 的判定（`glass-warm` 字样）一并替换。

- [ ] **Step 5: themes.css 重写为 4 块**

方法：以现 `.theme-glass-warm`（:582）块的**变量清单**为结构模板（变量名/顺序保持一致，保证组件零改动），新 4 块取值如下；完成后**删除**旧 6 块（:47 .theme-yuanfang-light、:153 .theme-yuanfang、:259 .theme-dark、:365 .theme-light、:472 .theme-glass、:582 .theme-glass-warm）；:685-691 color-scheme 6 行 →
`:root{color-scheme:light} / :root.theme-light{color-scheme:light} / :root.theme-light-glass{color-scheme:light} / :root.theme-dark{color-scheme:dark} / :root.theme-dark-glass{color-scheme:dark}`。

**`dark` 块**（深空墨 = 驾驶舱 dark token 直接采用）：

```css
.theme-dark {
  --s-50:#0b0e14; --s-100:#11161f; --s-200:#161c28; --s-300:#1e2533; --s-400:#262e3d;
  --s-500:#3a4150; --s-600:#565e6e; --s-700:#7a828f; --s-800:#a8adb5; --s-900:#d9d5cc; --s-950:#f0e6d8;
  --brand-50:#fff3ea; --brand-100:#ffe6d5; --brand-200:#ffd1ae; --brand-300:#ffb88a; --brand-400:#ffa268;
  --brand-500:#ff7429; --brand-600:#f05a0a; --brand-700:#c2410c; --brand-800:#9a3412; --brand-900:#7c2d12; --brand-950:#431407;
  --bg-app:#0b0e14; --bg-surface:#11161f; --bg-elevated:#161c28; --bg-hover:#1e2533; --bg-active:#262e3d;
  --bg-input:#11161f; --bg-toolbar:#11161f; --bg-modal:#161c28; --bg-popover:#161c28; --bg-tooltip:#1e2533;
  --bg-code:#080a0d; --code-text:#d8dce3; --bg-prose:#11161f; --bg-kbd:#1e2533;
  --popover-bg:rgba(22,28,40,.92); --tooltip-bg:rgba(30,37,51,.96); --modal-bg:rgba(22,28,40,.92); --popover-blur:14px;
  --text-primary:#f0e6d8; --text-secondary:#b8afa2; --text-tertiary:#6e7480; --text-inverse:#0b0e14;
  --border-default:rgba(255,180,140,.10); --border-subtle:rgba(255,180,140,.06); --border-strong:rgba(255,180,140,.22);
  --accent-default:#ff7429; --accent-hover:#ff9a55; --accent-subtle:rgba(255,116,41,.12);
  --accent-red:#ff4d3a;
  /* 语言变量（spec §1.2）*/
  --grad-brand:linear-gradient(135deg,#ffa268,#ff4200); --line-hot:rgba(255,116,41,.45);
  --glow-soft:0 8px 24px rgba(255,90,20,.14); --glow-hot:0 6px 18px rgba(255,116,41,.30);
  --halo:rgba(255,116,41,.42); --micro-track:.22em;
  --modal-drop:0 10px 28px rgba(8,10,14,.5);   /* T7 dialog 用（clip-path 会裁掉 box-shadow，改 drop-shadow）*/
}
```

**`light` 块**（暖白 = 驾驶舱 light token 直接采用）：

```css
.theme-light {
  --s-50:#fdf9f5; --s-100:#fffdfb; --s-200:#ffffff; --s-300:#fff6ef; --s-400:#ffeddd;
  --s-500:#f0ddd0; --s-600:#d9c6b8; --s-700:#b3a99e; --s-800:#8e8880; --s-900:#5e636c; --s-950:#24272c;
  --brand-50:#fff3ea; --brand-100:#ffe6d5; --brand-200:#ffd1ae; --brand-300:#ffb88a; --brand-400:#ffa268;
  --brand-500:#ff7429; --brand-600:#e8590c; --brand-700:#c2410c; --brand-800:#9a3412; --brand-900:#7c2d12; --brand-950:#431407;
  --bg-app:#fdf9f5; --bg-surface:#fffdfb; --bg-elevated:#ffffff; --bg-hover:#fff6ef; --bg-active:#ffeddd;
  --bg-input:#fffdfb; --bg-toolbar:#fffdfb; --bg-modal:#ffffff; --bg-popover:#ffffff; --bg-tooltip:#24272c;
  --bg-code:#24272c; --code-text:#f0e6d8; --bg-prose:#fffdfb; --bg-kbd:#fff6ef;
  --popover-bg:rgba(255,253,251,.92); --tooltip-bg:rgba(36,39,44,.96); --modal-bg:rgba(255,253,251,.94); --popover-blur:16px;
  --text-primary:#24272c; --text-secondary:#5e636c; --text-tertiary:#9aa1ac; --text-inverse:#fffdfb;
  --border-default:rgba(34,38,44,.10); --border-subtle:rgba(34,38,44,.06); --border-strong:rgba(34,38,44,.22);
  --accent-default:#ff7429; --accent-hover:#ff9a55; --accent-subtle:rgba(255,116,41,.12);
  --accent-red:#dc2626;
  --grad-brand:linear-gradient(135deg,#ffa268,#ff4200); --line-hot:rgba(255,116,41,.55);
  --glow-soft:0 8px 24px rgba(180,100,40,.12); --glow-hot:0 6px 16px rgba(255,116,41,.22);
  --halo:rgba(255,116,41,.20); --micro-track:.22em;
  --modal-drop:0 10px 24px rgba(70,50,30,.22);
}
```
（浅底文字型强调统一用 `brand-600/700`，组件里已用 `text-brand-500` 的地方若对比不足改 600。）

**变量清单规则**：新 4 块的变量名集合 = 旧块变量全集（shadow/scrollbar/selection 等表外变量保留旧值、按墨系/暖白系微调）+ 上述语言变量（含 `--modal-drop`）；下表只列**改动**取值。完成后 diff 校验变量名无缺失。

**`dark-glass` 块**（结构 = 旧 .theme-glass 块：透明 app + color-mix 面板 + aurora；变量名以旧块为准，取值替换）：面板基色 `--bg-app:transparent`；surface/input/toolbar `#0b0e14`、elevated `#11161f`、hover `#161c28`、active `#1e2533`、modal/tooltip `#11161f`、popover `#161c28`、code `#080a0d`（`--code-text:#d8dce3`）、kbd `#1e2533`、prose `#0b0e14`（均 `color-mix(in srgb, <hex> calc(var(--glass-opacity, .3) * 100%), transparent)` 形式）；文字同 dark 块；border `rgba(255,240,220,.14/.08/.24)`；accent 同 dark；aurora 主晕色 → `rgba(255,116,41,.5)`、副晕 → `rgba(80,160,200,.35)`（变量名沿用旧 .theme-glass 的 aurora 命名）；语言变量同 dark 块。

**`light-glass` 块**：同结构，面板基色 surface/input/toolbar `#fffdfb`、elevated `#ffffff`、hover `#fff6ef`、active `#ffeddd`、modal/tooltip `#ffffff`、popover `#fffdfb`、code `#24272c`（`--code-text:#f0e6d8`）、kbd `#fff6ef`、prose `#fffdfb`；文字同 light 块；border `rgba(34,38,44,.14/.08/.24)`；accent 同 light；aurora 主晕 `rgba(255,170,90,.35)`、副晕 `rgba(120,170,200,.25)`；语言变量同 light 块。

- [ ] **Step 6: globals.css 玻璃 backdrop 选择器**

`grep -n "theme-glass" src/styles/globals.css` → 每个引用旧玻璃类名的选择器扩入 `.theme-dark-glass, .theme-light-glass`（保持原规则不变）。

- [ ] **Step 7: 全量验证**

Run: `npm run typecheck && npm run build && npm test && node --test src/lib/*.test.ts`
Expected: 全绿（typecheck 会揪出所有漏改的旧 ID 消费点——逐一按新 ID 修）。

- [ ] **Step 8: 提交**

```bash
git add -A && git commit -m "refactor(gui-ux): 主题 6→4 收敛（dark/light/dark-glass/light-glass）+ 驾驶舱语言变量 + 旧值迁移"
```

---

### Task 3: 设计语言工具类（globals.css）

**Files:**
- Modify: `src/styles/globals.css`（文件末尾新增「设计语言」段）

**Interfaces:**
- Produces（T4-T10 消费）：`.cut/.cut-btn/.cut-sm/.cut-xs` + `>.ci` 内层 + `.hot` 变体；`.topline`；`.micro`；`.orb`；`.breath`；`.pulse-dot`；`.grad-brand`；`.glow-hover`。

- [ ] **Step 1: 追加 CSS**（globals.css 末尾，新注释段）

```css
/* ============ 设计语言（spec 2026-09-10）：单对角切角/细线/光效/微标 ============ */
/* 切角 = 单对角（左上+右下）；1px 外层即细线；内容放 >.ci 内层 */
.cut{position:relative;padding:1px;background:var(--border-default);
  clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px);}
.cut>.ci{background:var(--bg-elevated);
  clip-path:polygon(11px 0,100% 0,100% calc(100% - 11px),calc(100% - 11px) 100%,0 100%,0 11px);}
.cut-btn{position:relative;padding:1px;background:var(--border-default);
  clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);}
.cut-btn>.ci{background:var(--bg-elevated);
  clip-path:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px);}
.cut-sm{position:relative;padding:1px;background:var(--border-default);
  clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px);}
.cut-sm>.ci{background:var(--bg-elevated);
  clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px);}
.cut-xs{position:relative;padding:1px;background:var(--border-default);
  clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px);}
.cut-xs>.ci{background:var(--bg-elevated);
  clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px);}
.cut.hot,.cut-btn.hot,.cut-sm.hot,.cut-xs.hot{background:var(--line-hot);}
/* .ci 背景统一 --bg-elevated（卡/气泡/面板）；仅两个浮层变体（T7 消费）+ 输入框焦点热边 */
.cut-modal>.ci{background:var(--bg-modal);}
.cut-pop>.ci{background:var(--popover-bg);}
.cut.focusable:focus-within{background:var(--line-hot);}
/* 签名：2.5px 品牌渐变顶线（仅登录卡/驾驶舱详情面板两处）*/
.topline{position:relative;}
.topline::before{content:"";position:absolute;top:0;left:0;right:0;height:2.5px;
  background:linear-gradient(90deg,#ffa268,#ff4200);box-shadow:0 0 14px rgba(255,116,41,.55);z-index:1;}
/* 微标（8.5px Arial 全大写，固定英文不进 i18n）*/
.micro{font:600 8.5px/1.5 Arial,Helvetica,sans-serif;letter-spacing:var(--micro-track);
  text-transform:uppercase;color:var(--text-tertiary);font-variant-numeric:tabular-nums;}
/* 品牌光晕 orb（auth/boot 背景）*/
.orb{position:absolute;border-radius:50%;filter:blur(70px);pointer-events:none;
  background:radial-gradient(circle,var(--halo),transparent 65%);}
/* 光效白名单①：logo 呼吸光晕 */
@keyframes yfw-breath{0%,100%{transform:scale(1);opacity:.55}50%{transform:scale(1.18);opacity:.22}}
.breath{animation:yfw-breath 4.5s ease-in-out infinite;}
/* 光效白名单③：运行状态点脉冲 */
@keyframes yfw-pulse{0%,100%{opacity:1}50%{opacity:.3}}
.pulse-dot{animation:yfw-pulse 1.5s ease-in-out infinite;}
/* 光效白名单④：品牌静态渐变 */
.grad-brand{background:var(--grad-brand);}
/* .ci 上叠加品牌渐变（发送钮等）：提高优先级压过 .cut*.ci 默认底 */
.cut>.ci.grad-brand,.cut-btn>.ci.grad-brand,.cut-sm>.ci.grad-brand,.cut-xs>.ci.grad-brand{background:var(--grad-brand);}
/* 光效白名单②：hover/选中柔光 */
.glow-hover{transition:box-shadow .2s ease;}
.glow-hover:hover{box-shadow:var(--glow-hot);}
```

- [ ] **Step 2: speedMode 覆盖确认**

Run: `grep -n "speed" src/styles/globals.css | head`
确认既有全局关动画选择器（如 `[data-speed-mode="on"] *` 之类）能覆盖新增 `yfw-breath/yfw-pulse`；若选择器是显式类名清单则把 `.breath,.pulse-dot` 加进去。

- [ ] **Step 3: 验证 + 提交**

Run: `npm run build`（CSS 语法/变量引用检查）
```bash
git add src/styles/globals.css && git commit -m "feat(gui-ux): 设计语言工具类（.cut 单对角切角族/.topline/.micro/.orb/光效白名单动画）"
```
EOF
echo done && wc -l "C:/Users/T203-15/yfworking/docs/superpowers/plans/2026-09-10-gui-design-unification.md"

---

### Task 4: 设置页（ThemePicker 4 卡 + 玻璃条件 + i18n + switch）

**Files:**
- Modify: `src/components/settings/SettingsView.tsx`（内部函数 `ThemePicker` :1144 起、:1151 分组文案、玻璃三设置条件）
- Modify: `src/components/ui/switch.tsx`（on 态品牌渐变）
- Modify: `src/locales/zh-CN.json`、`src/locales/en-US.json`（主题标语/计数文案键）

**Interfaces:**
- Consumes: `THEMES`（T2，4 条）、`.cut-sm/.cut-xs/.micro`（T3）
- Produces: 无（叶子任务）

- [ ] **Step 1: switch.tsx on 态**

`data-[state=checked]:bg-brand-500` 替换为自定义类 `sw-on`（Tailwind 无法直接输出渐变变量背景）：

```tsx
'data-[state=checked]:sw-on data-[state=unchecked]:bg-active',
```

globals.css「设计语言」段追加：`.sw-on{background:var(--grad-brand)!important;}` 与 `input[type="range"]{accent-color:var(--brand-500);}`（range 滑块品牌色）。

- [ ] **Step 2: 玻璃三设置条件**

Run: `grep -n "'glass'\|glass-warm" src/components/settings/SettingsView.tsx`
把所有 `theme === 'glass' || theme === 'glass-warm'` 形式的条件替换为 `theme === 'dark-glass' || theme === 'light-glass'`。

- [ ] **Step 3: ThemePicker 重写为 2×2 四卡**

`SettingsView.tsx:1144` 起的 `ThemePicker` 函数体整体替换（数据源 `THEMES` 4 条；mini 预览用内联 hex 常量属「预览 mock」豁免）：

```tsx
const PREVIEW: Record<ThemeMode, { bg: string; bar: string; glass?: boolean }> = {
  'dark':        { bg: '#0b0e14', bar: '#2a3040' },
  'light':       { bg: '#fdf9f5', bar: '#ddd6cb' },
  'dark-glass':  { bg: '#0b0e14', bar: '#2a3040', glass: true },
  'light-glass': { bg: '#fdf9f5', bar: '#ddd6cb', glass: true },
}
function ThemePicker({ value, onChange, t }: { value: ThemeMode; onChange: (v: ThemeMode) => void; t: (k: string) => string }) {
  const activeTheme = THEMES.find(th => th.id === value) ?? THEMES[0]
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        {THEMES.map(th => {
          const pv = PREVIEW[th.id]
          const selected = th.id === value
          return (
            <button key={th.id} onClick={() => onChange(th.id)}
              className={cn('cut-sm text-left', selected && 'hot glow-hover')} aria-pressed={selected}>
              <div className="ci px-3 py-3">
                <div className="relative h-14 overflow-hidden border border-subtle" style={{ background: pv.bg }}>
                  {pv.glass && <div className="absolute inset-0" style={{ background: 'repeating-linear-gradient(45deg, rgba(255,255,255,.06) 0 6px, transparent 6px 12px)' }} />}
                  <div className="absolute left-2 top-3 h-1 w-8" style={{ background: '#ff7429' }} />
                  <div className="absolute left-2 top-6 right-6 h-1" style={{ background: pv.bar }} />
                  <div className="absolute left-2 top-9 right-10 h-1" style={{ background: pv.bar }} />
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-xs font-semibold text-primary">{th.name} · {th.variant}</span>
                  {th.isDefault && <span className="text-[10px] text-brand-500">{t('common.default')}</span>}
                </div>
                <div className="mt-0.5 text-[10px] text-tertiary">{th.tagline}</div>
              </div>
            </button>
          )
        })}
      </div>
      <div className="mt-2 text-[10px] text-tertiary">
        {activeTheme.name}{activeTheme.variant ? ` · ${activeTheme.variant}` : ''} {activeTheme.isDefault ? `· ${t('common.default')}` : ''} · {t('settings.themeCount')}
      </div>
    </div>
  )
}
```
（签名与现有 ThemePicker 一致，调用点不动。移除原 category 分组逻辑与「6 themes · 1+3+2」行；`cn` 未引入则补 `import { cn } from '@/lib/utils'`。替换后 `grep -n "ThemePreviewCard" src/components/settings/SettingsView.tsx`：旧 `ThemePreviewCard`（:1179 定义）无引用即整函数删除；i18n 键 `themeGroup.*` 闲置保留不删。）

- [ ] **Step 4: i18n**

`src/i18n/translations/zh-CN.ts` 与 `en-US.ts` 的 `settings` 对象内、现有 `'theme'` 键旁加 `themeCount: '4 themes · 2+2'`（固定英文装饰文案，两语言同值）。

- [ ] **Step 5: 区块标题微标**

`SettingsView.tsx` 各区块标题（外观/动画/系统/关于等，实际以文件内区块为准）标题文字后加 `<span className="micro ml-1.5">EN</span>`；EN 固定英文不进 i18n：外观→`APPEARANCE`、玻璃效果→`GLASS`、动画→`MOTION`、系统→`SYSTEM`、关于→`ABOUT`、通用→`GENERAL`。

- [ ] **Step 6: 验证 + 提交**

Run: `npm run typecheck && npm run build`
手工：`npm run dev` 打开设置 → 4 卡渲染、点击切换主题生效、玻璃主题下三设置行出现、区块标题带微标。
```bash
git add -A && git commit -m "feat(gui-ux): ThemePicker 四主题卡（2×2 实色/玻璃）+ 玻璃条件迁移 + switch 品牌渐变 + i18n"
```

---

### Task 5: 工作屏 chrome（Header / RailNav / SecondPanel / StatusBar）

**Files:**
- Modify: `src/components/layout/Header.tsx`（logo 旁微标）
- Modify: `src/components/layout/RailNav.tsx`（激活指示条）
- Modify: `src/components/layout/SecondPanel.tsx`（任务行 `.cut-sm`、状态点、进度条、面板头）
- Modify: `src/components/layout/StatusBar.tsx`（微标化）
- Modify: `src/styles/globals.css`（`.rail-ind` 追加到设计语言段）

**Interfaces:**
- Consumes: `.cut-sm/.micro/.pulse-dot/.grad-brand/.glow-hover`（T3）
- Produces: 无（叶子任务）

- [ ] **Step 1: Header 微标**

logo `<img>` 之后加 `<span className="micro hidden min-[720px]:inline-block ml-2">YFWORKING</span>`（窄窗隐藏，微标不进 i18n）。

- [ ] **Step 2: RailNav 激活指示条**

`.rail-ind` 追加到 globals.css 设计语言段：

```css
.rail-ind{position:absolute;left:-6px;top:8px;bottom:8px;width:2.5px;border-radius:2px;
  background:var(--grad-brand);box-shadow:0 0 8px rgba(255,116,41,.7);}
```

`RailNav.tsx`：按钮容器类补 `relative`；`railButton(active)` 返回的 active 分支中，在 `<Icon>` 前插入 `{active && <span className="rail-ind" aria-hidden />}`。非激活色保持 `text-tertiary`。

- [ ] **Step 3: SecondPanel 任务行**

打开 `SecondPanel.tsx`，定位任务行渲染（map conversations/tasks 的行元素，现状 `rounded-*` + `border` + `bg-*` 容器）：
- 行容器：`rounded-*` 与 `border` 类移除 → `cut-sm glow-hover`；内容包进 `<div className="ci px-3 py-2 ...">`（原 padding/内容不动）。
- 状态点：保持 `rounded-full`；「运行中」点追加 `pulse-dot` 类；三态色保持（brand/warning/success 语义类不动）。
- 行内进度条：轨道保持圆角；填充类替换为 `grad-brand h-full`（宽度沿用原百分比样式）。
- 面板头（标题 + 新建按钮）：标题后加 `<span className="micro ml-1">TASKS</span>`；新建按钮 `rounded-*` → `cut-xs`，内容包 `ci`（`w-5 h-5 flex items-center justify-center`）。

- [ ] **Step 4: StatusBar 微标化**

`StatusBar.tsx:69` footer 内各文本 span 的 `text-xs`（及同类小字）替换为 `micro` 类（保留原 flex/颜色类；健康点 `rounded-full` 不动）。

- [ ] **Step 5: 验证 + 提交**

Run: `npm run typecheck && npm run build`
手工（`npm run dev`）：rail 激活橙 + 左侧渐变条带 glow；任务行 hover 出柔光；运行点脉冲；StatusBar 全微标；4 主题各看一遍无断色。
```bash
git add -A && git commit -m "feat(gui-ux): 工作屏 chrome 驾驶舱化（Header 微标/Rail 渐变指示条/任务行切角/StatusBar 微标）"
```

---

### Task 6: 聊天族（气泡 / 提问卡 / 输入条 / effort）

**Files:**
- Modify: `src/components/chat/MessageBubble.tsx`（:75 气泡容器）
- Modify: `src/components/chat/QuestionCard.tsx`（提问卡 + 选项行）
- Modify: `src/components/chat/FloatingQuestionCard.tsx`（浮层提问卡同构）
- Modify: `src/components/chat/ChatInput.tsx`（输入条 + 发送钮）
- Modify: `src/components/chat/EffortPicker.tsx`（effort 标签）

**Interfaces:**
- Consumes: `.cut/.cut-sm/.cut-xs/.cut-btn/.hot/.focusable/.grad-brand/.ci`（T3）
- Produces: 无（叶子任务）

- [ ] **Step 1: MessageBubble 气泡切角**

:75 容器 `w-full max-w-[640px] my-4 bg-surface/60 border border-default rounded-lg overflow-hidden animate-slide-up` →
外层：`cut-sm w-full max-w-[640px] my-4 animate-slide-up`；内容全部包进 `<div className="ci overflow-hidden ...">`（原 `bg-surface/60 border rounded-lg` 移除，气泡底色统一 `--bg-elevated`；助手气泡若为平铺无边框变体则保持不动，只切用户气泡与带框变体）。

- [ ] **Step 2: QuestionCard / FloatingQuestionCard**

两文件同一处理：
- 卡容器 `rounded-*` + `border` → `cut hot`，内容包 `ci`（保留原 padding）。
- 选项行：`rounded-*` + `border` → `cut-xs`，内容包 `ci`（保留 flex/gap/文字类）；**第一个选项**（推荐项）外层加 `hot` 类。
- 卡顶不加 `.topline`（顶线仅登录/驾驶舱两处）。

- [ ] **Step 3: ChatInput 输入条**

输入条外层容器（现状 `rounded-*` + `border` 的包裹 div）→ `cut focusable`；内容包 `ci flex items-center gap-2 px-3 ...`（原内边距/结构不动）。
发送钮（原生 `<button>`）：元素类 `rounded-*` 移除 → `cut-btn w-8 h-8`，内部图标包 `<span className="ci grad-brand flex items-center justify-center w-full h-full text-white">`（禁用态样式类保留）。

- [ ] **Step 4: EffortPicker 标签**

trigger 按钮 `rounded-*` → `cut-xs` + 内容包 `ci`（文字/图标类不动）；下拉面板本体属浮层（Task 7 统一）。

- [ ] **Step 5: 验证 + 提交**

Run: `npm run typecheck && npm run build`
手工（`npm run dev`）：发一条消息看用户气泡单对角切角；触发提问卡看 hot 描边 + 选项切角；输入条聚焦时热边点亮；effort 标签切角；4 主题各一遍。
```bash
git add -A && git commit -m "feat(gui-ux): 聊天族驾驶舱化（气泡/提问卡/输入条/effort 切角 + 热边）"
```

---

### Task 7: 浮层（modal / dropdown / 命令面板）

**Files:**
- Modify: `src/components/ui/dialog.tsx`（DialogContent → `.cut-modal`）
- Modify: `src/components/ui/dropdown-menu.tsx`（菜单容器 → `.cut-sm`）
- Modify: `src/components/command-palette/CommandPalette.tsx`（行 hover 热边）
- 不改: `src/components/ui/tooltip.tsx`（tooltip 保持小圆角，规则例外）

**Interfaces:**
- Consumes: `.cut-modal/.cut-sm/.ci/.hot`（T3）
- Produces: 无（叶子任务）

- [ ] **Step 1: dialog.tsx DialogContent**

`DialogContent` 的 `DialogPrimitive.Content`：`className` 移除 `rounded-xl`、`border border-subtle`，加入 `cut-modal`；`style` 移除 `background: 'var(--modal-bg)'`、`boxShadow` 改 `filter: 'drop-shadow(var(--modal-drop))'`（`backdropFilter` 两行保留）。`{children}` 与关闭按钮一起包进内层：

```tsx
<div className="ci flex flex-col"
  style={{ background: 'var(--modal-bg)', backdropFilter: 'blur(var(--popover-blur))', WebkitBackdropFilter: 'blur(var(--popover-blur))' }}>
  {children}
  {/* 原 DialogPrimitive.Close 原样移入此 div */}
</div>
```
（关闭按钮 absolute 相对 Content 根，定位效果不变；DialogHeader/Body/Footer 在 ci 内消费，不动。）

- [ ] **Step 2: dropdown-menu.tsx**

`DropdownMenuContent` 的 `rounded-*` + `border` → `cut-sm`，内容包 `ci`（保留 backdrop blur 类，玻璃/磨砂效果不变）；MenuItem 的 `rounded-*` 保持（小行元素不切角）。

- [ ] **Step 3: CommandPalette 行热边**

`CommandPalette.tsx` 列表行 hover 类补 `hover:border-[color:var(--line-hot)]`（现状 hover 背景类保留）；容器随 dialog 改自动切角。

- [ ] **Step 4: 其余浮起卡**

Run: `grep -rn "bg-modal\|rounded-xl\|rounded-2xl" src/components --include="*.tsx" | grep -v test`
所有浮起**卡**容器（`rounded-*` + `border`/`shadow`/`bg-modal`）同 dialog 处理：移除 `rounded-*`/`border` → `cut-modal`，内容包 `ci`（背景 `var(--modal-bg)` + blur 移入 ci 的 style）。已知目标：`src/components/files/FilePreview.tsx:78`（`bg-modal border border rounded-xl overflow-hidden`）及 grep 命中的同类。滚动区放 ci 内（外层不 overflow）。**不切**：全屏遮罩（Overlay）、关闭按钮、图片等小元素的 `rounded`。

- [ ] **Step 5: 验证 + 提交**

Run: `npm run typecheck && npm run build`
手工（`npm run dev`）：打开设置 dialog / 任一下拉菜单 / ⌘K 命令面板 / 文件预览——容器单对角切角 + 1px 细线 + drop-shadow 随切角形；tooltip 仍圆角；4 主题各一遍（modal 背景 `--modal-bg` 正确）。
```bash
git add -A && git commit -m "feat(gui-ux): 浮层驾驶舱化（dialog/dropdown/文件预览切角 + 命令面板行热边；tooltip 例外保持圆角）"
```

---

### Task 8: 登录/首设/锁定（认证小窗全主题跟随）

**Files:**
- Modify: `src/components/auth/AuthScreen.tsx`（AuthFrame 背景/字标/卡；:36-39 锚点）
- Modify: `src/styles/globals.css`（删除 `.auth-bg` 定义 :828 起 + 注释段）
- Modify: `src/components/auth/SetupWizard.tsx`（若卡结构独立于 AuthFrame 则同步切角；共用 AuthFrame 则自动）

**Interfaces:**
- Consumes: `.cut.hot/.topline/.orb/.micro/.cut/.cut-btn/.grad-brand`（T3）；`BOOST_LOGO_DARK`（assets.ts 已有）
- Produces: 无（叶子任务）

- [ ] **Step 1: AuthScreen 背景与字标**

`:36` 容器 `h-full w-full auth-bg flex items-center justify-center overflow-hidden` → `h-full w-full bg-app flex items-center justify-center overflow-hidden relative`，并加两枚 orb（登录小窗 420×560 内定位）：

```tsx
<div className="orb" style={{ width: 340, height: 340, left: -90, top: -70 }} />
<div className="orb" style={{ width: 300, height: 300, right: -70, bottom: -70, opacity: .7 }} />
```

字标（:38）：`BOOST_LOGO_LIGHT` 改为按主题明暗切换——
```tsx
const theme = useSettingsStore(s => s.settings.theme)
const darkTheme = theme === 'dark' || theme === 'dark-glass'
...
<img src={darkTheme ? BOOST_LOGO_LIGHT : BOOST_LOGO_DARK} alt="YFWorking" className="boot-logo mb-2" draggable={false} />
<div className="micro mb-8">YFWORKING · YF Working</div>
```
（import `BOOST_LOGO_DARK`、`useSettingsStore`；logo 上包 `relative` 容器 + `<div className="breath absolute -inset-10 rounded-full" style={{ background: 'radial-gradient(circle, var(--halo), transparent 62%)' }} />` 实现呼吸光晕（白名单①）。）

- [ ] **Step 2: 卡切角 + 顶线**

`:39` 容器类 `.auth-card w-full rounded-2xl p-6 animate-scale-in` → `cut hot topline w-full animate-scale-in`，加 `style={{ filter: 'drop-shadow(var(--modal-drop))' }}`（clip-path 会裁掉 box-shadow，用 drop-shadow 随切角形），内容包 `<div className="ci p-6">`。`globals.css:836` 的 `.auth-card` 规则（popover-bg+border+shadow+blur）整条删除（磨砂/底色由 `ci` 的 `--bg-elevated` 接管，玻璃主题自动半透明）。

- [ ] **Step 3: 删除 .auth-bg**

`globals.css` :821-828 注释段 + `.auth-bg{...}` 整段删除（`grep -n "auth-bg" src` 确认无残留引用；boot.css 不动）。
口令输入框：外层包裹 `rounded-*` + `border` → `cut focusable`，内容包 `ci`（原内边距保留）。
主按钮（`:98` `<Button className="w-full" size="lg" ...>`，**不改 button.tsx**）：外包两层——`<div className="cut-btn w-full"><div className="ci"><Button ...原 props 不变/></div></div>`（Button 自带 rounded-md 被 `.ci` 的 9px 切角 clip 裁掉，即出签名斜边；ci 底 elevated 被 w-full h-10 按钮完全遮盖）。首设向导/锁定屏的主按钮若为独立 `Button`，同法包一层。
锁定/重试/其他次级按钮：保持 Button 原圆角（小元素不切角，符合规则）。

- [ ] **Step 4: 验证 + 提交**

Run: `npm run typecheck && npm run build`
手工：4 主题 × （登录/首设/锁定）——深色主题白字标 + 橙光晕；浅色主题深字标（**不得白上白**）；玻璃主题卡半透明透桌面；顶线 2.5px 渐变。
```bash
git add -A && git commit -m "feat(gui-ux): 登录/首设/锁定全主题跟随（auth-bg 移除 → bg-app + orb，字标明暗切换，卡切角 + 顶线）"
```

---

### Task 9: boot 加载屏（主题跟随）

**Files:**
- Modify: `src/components/boot/BootScreen.tsx`（容器/光晕/进度/阶段字）
- Modify: `src/styles/boot.css`（`.boot-bg` 渐变 → 主题底）

**Interfaces:**
- Consumes: `.orb/.breath/.grad-brand/.micro`（T3）
- Produces: 无（叶子任务）

- [ ] **Step 1: boot.css**

`.boot-bg`（:13）的硬编码深色渐变 background → `background: var(--bg-app);`（保留该类名供容器使用）。

- [ ] **Step 2: BootScreen**

- 容器保持 `boot-bg`，追加 `relative overflow-hidden` + 两枚 `.orb`（同 T8 尺寸/定位，opacity .8/.55）。
- logo：外包 `relative` 容器 + breath 光晕 div（同 T8 写法）；logo 源按主题明暗切换（同 T8 `darkTheme ? BOOST_LOGO_LIGHT : BOOST_LOGO_DARK`）。
- 进度/流光条：填充类 → `grad-brand`（shimmer 位移动画保留，属装饰动画，speedMode 下由全局机制关闭）。
- 阶段小字（如「内核就绪」）：`text-xs text-tertiary` 类 → `micro`。

- [ ] **Step 3: 验证 + 提交**

Run: `npm run typecheck && npm run build`
手工：清 localStorage 重启走首设 → boot 屏；4 主题各看一遍（浅色底 + 深字标可读）。
```bash
git add -A && git commit -m "feat(gui-ux): boot 屏主题跟随（boot-bg → bg-app + orb，字标明暗切换，流光品牌渐变）"
```

---

### Task 10: 驾驶舱桥接（4 模式 + glassOpacity + 单对角切角）

**Files:**
- Modify: `src/components/cockpit/CockpitScreen.tsx`（:25 themeModeOf、:34-35 src query、:55 消息载荷）
- Modify: `public/cockpit/index.html`（:root 四主题 + 玻璃两态 + 切角 6 点 polygon）

**Interfaces:**
- Consumes: `settings.theme`（T2 新 4 ID）、`settings.glassOpacity`
- Produces: 无（叶子任务；cockpit.js 交互零改动）

- [ ] **Step 1: CockpitScreen 载荷升级**

- `themeModeOf(theme)` 保留（内部改为按 `THEMES.find(t=>t.id===theme)?.mode`，新 ID 已含 mode 字段）；新增直传全 ID。
- :34-35 首挂载：`?theme=${useSettingsStore.getState().settings.theme}`（四值直传，不再只传 light/dark）。
- :55 消息：`{ type: 'yfw:theme', theme, speedMode: speed, glassOpacity: useSettingsStore.getState().settings.glassOpacity ?? 0.3 }`（主题变/透光度变都触发，沿用现有 effect 依赖）。

- [ ] **Step 2: public/cockpit/index.html 四主题**

- 现有 `?theme=` 首帧判定（`_q==='light'` 加 `theme-light` class）扩展为四值：
```js
var _q = new URLSearchParams(location.search).get('theme') || 'dark';
if (_q !== 'dark') document.body.className = 'theme-' + _q;   // theme-light / theme-dark-glass / theme-light-glass
```
- `onmessage` `yfw:theme` 分支：除 speedMode 外，同步 `body.className = 'theme-' + msg.theme`，玻璃态写 `document.documentElement.style.setProperty('--glass-opacity', msg.glassOpacity)`。
- CSS 追加两块（结构对齐现有 `--paper/--panel/--card/--card-hv/--ink/--ink2/--faint/--line`）：
```css
/* 深色玻璃：透桌面 + 墨玻璃面板 + 暖橙主晕（aurora 变量沿用现有命名改色）*/
body.theme-dark-glass{
  --paper:transparent;
  --panel:color-mix(in srgb, #11161f calc(var(--glass-opacity,.3) * 100%), transparent);
  --card:color-mix(in srgb, #161c28 calc(var(--glass-opacity,.3) * 100%), transparent);
  --card-hv:color-mix(in srgb, #1e2533 calc(var(--glass-opacity,.3) * 100%), transparent);
  backdrop-filter:blur(14px);
}
body.theme-light-glass{
  --paper:transparent; --panel:color-mix(in srgb, #fffdfb calc(var(--glass-opacity,.3) * 100%), transparent);
  --card:color-mix(in srgb, #ffffff calc(var(--glass-opacity,.3) * 100%), transparent);
  --card-hv:color-mix(in srgb, #fff6ef calc(var(--glass-opacity,.3) * 100%), transparent);
  --ink:#24272c; --ink2:#5e636c; --faint:#9aa1ac;
  --line:rgba(34,38,44,.14);
  backdrop-filter:blur(14px);
}
```
  aurora 背景晕：`theme-dark-glass` 主晕改 `rgba(255,116,41,.5)` + 副晕 `rgba(80,160,200,.35)`；`theme-light-glass` 主晕 `rgba(255,170,90,.35)` + 副晕 `rgba(120,170,200,.25)`（改现有 aurora 背景规则按 body class 分支，变量名沿用）。
- **切角单对角化**：hover-panel / dp-frame 现有 8 点四角 polygon（13px）→ 6 点单对角（尺寸 13 不变）：
  外层 `polygon(13px 0,100% 0,100% calc(100% - 13px),calc(100% - 13px) 100%,0 100%,0 13px)`；内层 1px 线工艺同现有（内框 12px 同构）。`cockpit.js` 不动。

- [ ] **Step 3: 验证 + 提交**

Run: `npm run typecheck && npm run build`
手工：4 主题 × 驾驶舱——dark/light 与现网一致；dark-glass 透桌面 + 墨玻璃面板；light-glass 白玻璃 + 墨字；hub 进出、悬浮面板单对角切角；standalone 直开 `public/cockpit/index.html` 仍为 dark 缺省。
```bash
git add -A && git commit -m "feat(gui-ux): 驾驶舱 4 模式桥接（yfw:theme 全 ID + glassOpacity，玻璃两态，hover/dp 面板单对角切角）"
```

---

### Task 11: 全量回归 + 视觉验收

**Files:** 无代码改动（纯验证 + 收尾提交/回滚修复）

- [ ] **Step 1: 自动化全绿**

Run: `npm run typecheck && npm run build && npm test && node --test src/lib/*.test.ts`
Expected: 全绿（含 T1 新增 3 测试 + 既有 184 基线）。

- [ ] **Step 2: 手工冒烟矩阵（4 主题 × 6 屏）**

`npm run dev`（或 `npm run electron`）逐格过：
1. 认证小窗：登录/首设/锁定 × 4 主题（浅色主题无白上白；玻璃主题透桌面）
2. boot：× 4 主题
3. 驾驶舱：4 模式 + speedMode 开关 + hub 进出
4. 工作界面：rail 指示条/任务行 hover/聊天气泡/提问卡/输入条热边/浮层
5. 设置：ThemePicker 切换 + 玻璃三设置（仅玻璃主题出现）+ 独立设置窗跨窗同步
6. 命令面板：⌘K 切角 + 行热边
重点项：切主题**首帧零闪烁**（预挂载 class）；透光度滑杆热调；旧主题值用户升级后自动落 4 值（清 `yfworking-settings` 前手工写入 `{"state":{"settings":{"theme":"glass-warm"}}}` 重启验证 → 落 dark-glass）。

- [ ] **Step 3: 视觉验收（原型并排比对）**

浏览器双开：`scratch/unified-design-mockup.html` vs 应用各屏。逐项核对：切角方向（左上+右下）/ 1px 细线 / 2.5px 顶线仅两处 / 微标位置 / 光效 5 白名单无越界 / chip 三态 / 进度渐变。

- [ ] **Step 4: 图标契约 audit**

Run: `grep -rn "emoji\|🚀\|✨" src/components --include="*.tsx" | grep -v test` 应为空；新改动文件无新增非 lucide 图标。

- [ ] **Step 5: 收尾提交（如有验收微调）+ 状态更新**

```bash
git add -A && git commit -m "chore(gui-ux): 设计语言统一验收收尾（视觉微调/冒烟修复）"
```
在 spec 文件头部「状态」行追加：`实施完成 2026-09-11（plan T1-T11 全绿）`（日期按实际）。
