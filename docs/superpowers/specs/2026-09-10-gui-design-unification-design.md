# GUI 设计语言统一：驾驶舱基线 · 四主题收敛 · 单对角切角

> **状态**：已批准（2026-09-10：4 决策点逐轮确认 + 执行方案 A 确认 + §1-3 设计呈现确认）｜**实施完成 2026-09-11（plan T1-T11 全绿）**
> **实施验证**：tsc 绿 · vite build 绿（105KB CSS）· npm test 185/185 过 · src/lib 69/69 过 · 构建产物四主题块各 93 变量一致 · 旧主题 ID 零残留（themeMap 迁移表除外）· 驾驶舱 `node --check` 过 · emoji 契约审计全清
> **范围**：`src/` 样式体系与全部界面重皮（登录/首设/锁定小窗、boot、work shell、设置、命令面板、浮层）+ `public/cockpit/` iframe 令牌桥接 + `src/types`、`src/stores/settingsStore`、`src/main.tsx` 主题迁移
> **不动**：`kernel/`、`server/`、`cockpit.js` 交互逻辑（仅 token CSS + 主题映射）、`electron/main.cjs` 窗口**编排**逻辑（仅 `GLASS_THEMES` 列表与窗口 backgroundColor 兜底色值更新，见 §2.2）
> **上游参考**：`docs/superpowers/specs/2026-09-08-gui-onboarding-cockpit-redesign-design.md`（视图机/认证/三段式基线，其 D1-D13 继续有效）
> **视觉验收基准**：`scratch/unified-design-mockup.html`（原型，含 明暗/切角·圆角/光效三档 实时切换）

## Goal

把全部前端界面统一在一套设计语言上：**驾驶舱的「科技感 + 扁平商务」风格**——Boost 橙单一品牌色、单对角切角（左上+右下）签名形状、1px 细线 + 克制光晕、8-9px letter-spaced 英文微标、chip/渐变进度数据表达。主题收敛为 **4 套**（深/浅 × 实色/玻璃），登录小窗**完全跟随当前主题**（含浅色与玻璃形态），科技感取**克制档**（大面积扁平，光效仅 5 项白名单）。

## 决策记录（用户已确认，verbatim anchors）

| # | 决策点 | 确认结果 |
|---|--------|----------|
| D1 | 主题集 | **收敛 4 套**：深色·实色 / 浅色·实色 / 深色·玻璃 / 浅色·玻璃（新增）；品牌色统一 Boost 橙 `#FF7429`，消除现有 6 主题多强调色（橙/青/靛/紫） |
| D2 | 科技感强度 | **克制档**：大面积扁平商务；glow 只给 5 项白名单（§3.3） |
| D3 | 形状语言 | **单对角切角（左上+右下）**为签名形状，1px 细线沿切角闭合；刻度 12/10/8/6px；圆形元素（chip/头像/开关/状态点/进度轨道）保持圆角 |
| D4 | 登录/首设小窗 | **完全跟随当前主题**（含浅色与玻璃形态），移除恒定深色 `.auth-bg` |
| D5 | 执行方案 | **A：Token 先行三阶段**——P1 令牌地基 → P2 核心工作界面 → P3 品牌屏 + 全量回归 |

## 现状锚点（本 spec 依赖的事实基线）

- 主题体系：`src/styles/themes.css` 6 主题块（`yuanfang-light`/`yuanfang`/`dark`/`light`/`glass`/`glass-warm`），语义 token `--bg-*/--text-*/--border-*` + 玻璃机制（`--glass-opacity`/`--glass-hue-shift`/aurora，`globals.css` 提供 backdrop-filter）。组件只引用语义变量、无裸 hex（既有纪律，保持）。
- 主题应用链：`main.tsx` 预挂载 `THEME_BG/THEME_FG`（6 项，首帧防闪）→ `settingsStore` persist（`yfworking-settings`，含 `onRehydrateStorage` 补缺默认值钩子）→ `ViewRouter` effect 切 `html` class + 写玻璃变量。默认主题 `yuanfang-light`。
- `THEMES`/`ThemeMeta`：`src/types/index.ts:159`（6 条目，`category: brand|solid|glass`，`ThemePicker` 按 category 分组，设置页标注「6 themes · 1+3+2」）。
- 驾驶舱 iframe（`public/cockpit/index.html` + `cockpit.js`）：独立 token 集（`--paper/--panel/--card/--card-hv/--ink/--ink2/--faint/--line/--line-hot/--tri-*/--chip-*`），仅 `theme-light`/默认深色两态；`?theme=` 首帧 + `yfw:theme {mode, speedMode}` 热切；hover-panel/dp-frame 为四角切角 + 1px 橙线（本 spec 改单对角）。
- 登录小窗：`AuthScreen.tsx` AuthFrame 整屏 `.auth-bg`（恒定深色渐变，`globals.css:828`）+ 白字标 `BOOST_LOGO_LIGHT` + `.auth-card`（popover 磨砂）。资产已有双版：`src/lib/assets.ts` `BOOST_LOGO_LIGHT`（白，深底用）/ `BOOST_LOGO_DARK`（深色，浅底用）。
- boot 屏：`.boot-bg`（与 auth-bg 同族硬编码深色渐变）。
- 窗口透明（glass 专属）：渲染层切主题经 IPC 写 `theme.json` → `electron/main.cjs:442 GLASS_THEMES = ['glass','glass-warm']` 读取判定，仅 glass 主题建**真透明窗**（`main.cjs:481 transparent: isGlass`）；非 glass 窗口 backgroundColor 兜底 `#f7f8fa`/`#100c08`（`main.cjs:482`）。
- 驾驶舱桥接现态：`CockpitScreen.tsx` `themeModeOf()` 从 ThemeMeta 派生 light/dark 后发 `yfw:theme {mode, speedMode}`；iframe src 首挂载定型（`?theme=` query），保活不重载。
- 图标契约：lucide 全局唯一、禁 emoji（2026-09-08 spec §8.2 + audit 表），**本次不改图标映射**。
- 测试基线：`npm test` 184 过、`npm run typecheck`、`npm run build`。

## §1 设计令牌地基

### 1.1 主题 ID 收敛（6 → 4）

| 新 ID | 名称 | 旧值迁移映射 | color-scheme |
|-------|------|--------------|--------------|
| `dark` | 远方 · 深色（实色，默认） | `yuanfang`、`dark` | dark |
| `light` | 远方 · 浅色（实色） | `yuanfang-light`、`light` | light |
| `dark-glass` | 远方 · 深色玻璃 | `glass`、`glass-warm` | dark |
| `light-glass` | 远方 · 浅色玻璃（**新增**） | —（无旧值） | light |

- `THEMES` 改 4 条目（`ThemeMeta` 结构不变；`isDefault` 落在 `dark`）；`THEME_CLASS_NAMES` 自动随动。
- **迁移纯函数** `src/lib/themeMap.ts`：`migrateThemeId(old?: string): ThemeMode`——映射表如上，未知/缺省 → `dark`。单测覆盖：6 旧值、undefined、垃圾值、新值幂等（新值输入原样返回）。
- 三处消费同一映射：`settingsStore.onRehydrateStorage`（持久化旧值一次归一）、`main.tsx` 预挂载（冷启动不闪错主题）、`ViewRouter`（运行时）。
- `defaultSettings.theme`：`'yuanfang-light'` → `'dark'`（品牌开场链登录→boot→驾驶舱统一深色；一行可改）。
- `main.tsx THEME_BG/THEME_FG` 改 4 项（值取各主题 `--bg-app`/`--text-primary` 的实色值；玻璃主题取面板基色兜底，首帧由 class 接管）。

### 1.2 品牌色与驾驶舱语言变量

- 品牌刻度统一：4 主题 `--brand-500 = #FF7429`；浅色主题文字型强调用 `--brand-600/700`（`#E8590C`/`#C2410C`）保证白底对比。`--accent-default` 全主题 = `#FF7429`（hover `#FF9A55`，subtle `rgba(255,116,41,.12)`）。
- **新增驾驶舱语言变量**（每主题块内各给一套）：

| 变量 | 含义 | 深色/深玻璃 | 浅色/浅玻璃 |
|------|------|-------------|-------------|
| `--grad-brand` | 品牌渐变（主按钮/进度条/开关 on） | `linear-gradient(135deg,#FFA268,#FF4200)` | 同（浅底对比足够） |
| `--line-hot` | hot 细线（强调边框/hover 边） | `rgba(255,116,41,.45)` | `rgba(255,116,41,.55)` |
| `--glow-soft` | 卡片浮起柔光 | `0 8px 24px rgba(255,90,20,.14)` | `0 8px 24px rgba(180,100,40,.12)` |
| `--glow-hot` | 强调光晕（hover/选中） | `0 6px 18px rgba(255,116,41,.30)` | `0 6px 16px rgba(255,116,41,.22)` |
| `--halo` | logo 呼吸光晕 | `rgba(255,116,41,.42)` | `rgba(255,116,41,.20)` |
| `--micro-track` | 微标字距 | `.22em` | `.22em` |

### 1.3 `.cut` 切角工具类（`globals.css`）

单对角（左上+右下），1px 外层即细线（与驾驶舱 hover-panel 同工艺）：

```css
.cut{position:relative;padding:1px;background:var(--border-default);
  clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px);}
.cut>.ci{background:var(--bg-elevated);
  clip-path:polygon(11px 0,100% 0,100% calc(100% - 11px),calc(100% - 11px) 100%,0 100%,0 11px);}
/* 刻度：.cut=12 .cut-btn=10 .cut-sm=8 .cut-xs=6；hot 变体 .cut.hot{background:var(--line-hot)} */
```

- 内容一律放 `>.ci` 内层；`.ci` 背景按语义可覆写（`--bg-surface`/`--bg-modal`/`--popover-bg` 等）。
- **切角适用范围**：卡片/面板/输入框/主按钮/浮层（modal/popover/菜单/二级面板行/气泡/提问卡）。
- **不切角**：tooltip（极小，小圆角）、chip/徽章、头像、开关、状态点、进度轨道、代码块（代码块保持矩形）。
- Tailwind 色彩体系零改动（继续语义变量）；radius 刻度保留给不切角元素。

## §2 四主题色彩规格

### 2.1 实色两态 = 驾驶舱现有 token 直接采用（零发明，同源保证）

| Token | `dark`（深空墨） | `light`（暖白） |
|-------|------------------|------------------|
| `--bg-app` | `#0B0E14` | `#FDF9F5` |
| `--bg-surface` | `#11161F` | `#FFFDFB` |
| `--bg-elevated` | `#161C28` | `#FFFFFF` |
| `--bg-hover` / `--bg-active` | `#1E2533` / `#262E3D` | `#FFF6EF` / `#FFEDDD` |
| `--bg-input` / `--bg-toolbar` | `#11161F` | `#FFFDFB` |
| `--bg-modal` / `--bg-popover` | `#161C28` | `#FFFFFF` |
| `--bg-code` / `--code-text` | `#080A0D` / `#D8DCE3` | `#24272C` / `#F0E6D8` |
| `--text-primary/secondary/tertiary` | `#F0E6D8` / `#B8AFA2` / `#6E7480` | `#24272C` / `#5E636C` / `#9AA1AC` |
| `--border-default/subtle/strong` | `rgba(255,180,140,.10/.06/.22)` | `rgba(34,38,44,.10/.06/.22)` |
| 状态色 | success `#34d399` / warning `#FFC53D` / error `#F87171` / info `#A0D2EB` | success `#047857` / warning `#B45309` / error `#DC2626` / info `#0369A1` |
| 磨砂浮层 | `--popover-bg: rgba(17,22,31,.72)` + blur 14px | `rgba(255,253,251,.86)` + blur 16px |

`--s-*` 表面刻度按各自基底派生（dark = 墨系 10 级，light = 暖白 10 级，实施时按上表端点插值）。

### 2.2 玻璃两态（共享现有玻璃机制：`--glass-opacity` color-mix + backdrop-filter + aurora 光晕）

| Token | `dark-glass` | `light-glass`（新增） |
|-------|--------------|------------------------|
| `--bg-app` | transparent（露出桌面） | transparent（露出桌面） |
| 面板基色（color-mix 基底） | 墨系 `#0B0E14`/`#11161F`/`#161C28`… | 白系 `#FFFDFB`/`#FFFFFF`… |
| 文字 | 同 `dark` | 同 `light` |
| 边框 | `rgba(255,240,220,.14)` 系列 | `rgba(34,38,44,.14)` 系列 |
| aurora 光晕 | 暖橙主晕 `rgba(255,116,41,.5)` + 冷蓝副晕 `rgba(80,160,200,.35)`（替换现靛紫双晕） | 暖金微光 `rgba(255,170,90,.35)` + 淡青副晕 `rgba(120,170,200,.25)`（低透明度） |
| `--halo` | 同 dark | 同 light |

- 现有 `glassOpacity`/`glassHueShift`/`glassAurora` 三设置**字段不变**，条件渲染从 `glass||glass-warm` 改为 `dark-glass||light-glass`；`glassHueShift` 对 aurora 色相继续生效（默认 0 = 上表色）。
- 玻璃主题下主窗口/认证小窗真透明：`electron/main.cjs:442 GLASS_THEMES` 由 `['glass','glass-warm']` 改为 `['dark-glass','light-glass']`（一行值更新，非编排逻辑改动）；渲染层写 `theme.json` 的 IPC 链路不变。

## §3 设计规范（全界面共用语言规则）

### 3.1 切角
单对角（左上+右下）。刻度：12 卡/面板/输入、10 按钮、8 小控件/浮层行/气泡、6 微件（选项行/标签）。**不做镜像**（右上+左下），规则唯一；如需全局翻转属后续独立决策。

### 3.2 细线
默认 1px `--border-default`；强调 `--line-hot`。**2.5px 品牌渐变顶线**（`#FFA268→#FF4200`，带 14px 橙 glow）是签名元素，**仅两处**：登录/首设卡顶、驾驶舱详情面板顶（`.dp-frame::before` 已有）。

### 3.3 光效白名单（克制档，共 5 项，其余禁止）
1. **logo 呼吸光晕**：登录卡上方 / boot / 驾驶舱 hub（`--halo` + breath 4.5s）
2. **hover/选中 `--glow-hot`**：rail 激活项、任务行 hover、主题卡选中、选项行 hover
3. **运行状态点脉冲**：1.5s pulse（仅"运行中"语义点）
4. **品牌静态渐变**：主按钮 / 进度条 / 开关 on / 图表柱（静态，不流动）
5. **hot 描边**：登录卡 / 提问卡 / 激活输入框

工作界面**无**粒子/涟漪/大面积渐变。`speedMode` 全局关动效机制沿用（白名单中 ①③ 属动画项，均被其覆盖；②④⑤ 为静态样式不受影响）。

### 3.4 微标排版（micro-label 约定）
8–9px Arial 全大写、`letter-spacing: var(--micro-track)`、`--text-tertiary`。固定位置：区块标题英文副标（`外观 APPEARANCE`）、面板头（`任务 TASKS`）、状态栏、卡片脚注、驾驶舱 HUD。数字一律 `tabular-nums`（Arial）。微标为固定英文装饰，**不进 i18n**（中英界面同显）。

### 3.5 数据表达
chip 三态：运行 `#FF7429`/等待 `#FFC53D`/完成 success（驾驶舱 `.dp-chip` 同款）；进度条 90° `--grad-brand`；网格小卡（`--bg-elevated` 底 + 细线）。

## §4 逐屏改造

### 4.1 登录/首设/锁定（认证小窗）
- 移除 `.auth-bg` 硬编码深色渐变 → AuthFrame 背景 = `var(--bg-app)` + 两枚品牌光晕 orb（`--halo` 派生，径向 65% 淡出，blur 70px；玻璃主题下 orb 叠加在桌面透显之上）。
- 字标按主题明暗切换：dark/dark-glass → `BOOST_LOGO_LIGHT`（白）；light/light-glass → `BOOST_LOGO_DARK`（深）。
- 卡：`.auth-card` → `.cut.hot` 切角玻璃卡 + 2.5px 渐变顶线；标题 + 微标（`YFWORKING · 远方工作台`）。
- 口令输入 `.cut`、主按钮 `.cut-btn`（`--grad-brand`）、锁定/重试按同一语言。首设向导/锁定视图同构（共用 AuthFrame）。
- IPC `auth:granted` 链路零改动。

### 4.2 boot 加载屏
- `.boot-bg` → 同 4.1 主题跟随（`--bg-app` + orb）；logo 光晕 = `--halo` 呼吸；流光进度条 = shimmer（品牌渐变往返，属装饰动画，受 speedMode 覆盖）；阶段小字 → 微标。

### 4.3 驾驶舱 iframe（`public/cockpit/`）
- `yfw:theme` 载荷：`{mode, speedMode}` → `{theme: 'dark'|'light'|'dark-glass'|'light-glass', speedMode, glassOpacity}`（`glassOpacity` 供 cockpit 玻璃态面板 `color-mix` 用，iframe 读不到父级变量）；`CockpitScreen.tsx` 侧 `themeModeOf()`（现派生 light/dark）改为 `settings.theme` 全 ID 直传，首挂载 `?theme=` query 同步用四值。
- `index.html` `:root` 四主题块：dark/light = 现有值不动；`dark-glass` = `--paper` transparent + 面板 `color-mix(墨基底, --glass-opacity)` + 暖橙主晕；`light-glass` = `--paper` transparent + 面板 `color-mix(白基底, α)` + 墨字 + 暖金微光。玻璃两态下 `body` 背景透明（主窗口透明透桌面，与 work 玻璃态一致）。
- 首帧 `?theme=` 参数四值同步；standalone（无主程序）缺省仍为 dark。
- 切角：hover-panel / dp-frame 四角切角 → 单对角（左上+右下），1px 线工艺不变；`cockpit.js` 交互逻辑零改动。

### 4.4 工作界面（WorkShell）
- **Header**：logo 热区不变；logo 旁加微标 `YFWORKING`（固定渲染，窄窗 `<720px` 时隐藏，媒体查询实现）。
- **rail**：激活项 = 品牌橙 + 左侧 2.5px 渐变指示条（带 glow）；非激活 `--text-tertiary`；图标映射不变。
- **二级面板**：任务行 `.cut-sm`（hover `--glow-hot`）；状态点三态 + 运行脉冲；进度条 `--grad-brand`；面板头 = 中文标题 + 微标 + `.cut-xs` 新建钮。
- **聊天区**：用户气泡 `.cut-sm`；助手气泡保持平铺无边框（弱化处理）；**提问卡 `.cut.hot`** + 选项行 `.cut-xs`（首选项 hot 边）；模式徽标 chip（对话/任务，色区分沿用）。
- **输入条**：`.cut`（激活态 hot 边）；effort 标签 `.cut-xs`；发送钮 `.cut-btn` 方形渐变。
- **StatusBar**：文字 → 微标；健康点沿用。
- **浮层**：modal `.cut`（`--bg-modal` + `--shadow-modal`）、popover/菜单 `.cut-sm`、tooltip 保持小圆角；次级浮层（文件/历史/用量/工作树）容器 `.cut`。

### 4.5 设置（SettingsView + 独立设置窗）
- **ThemePicker**：4 卡（2×2：深色/浅色 × 实色/玻璃），卡 = mini 预览（各主题 `--bg-app` 底 + 3 条面板线 + 品牌强调条 + 玻璃态加半透明叠层示意）+ 名称 + 变体；选中 = `--line-hot` 边 + `--glow-hot`；分组文案「6 themes · 1+3+2」→「4 themes · 2+2」。
- 玻璃三设置行：条件改 `dark-glass||light-glass`；行结构 SettingRow 不变；开关 on 态 → `--grad-brand`；range `accent-color` → `#FF7429`。
- 区块标题加微标（`外观 APPEARANCE` 等）；i18n 增 4 主题名/标语键（zh-CN + en-US）。

### 4.6 命令面板 / 其他
- CommandPalette 容器 `.cut` + 行 hover hot 边（行不切角，快浮层）；shortcuts help 等 overlay 同 modal 规则。
- 编辑器独立窗（`?editor=1`）：容器 token 跟随（`--bg-app`/`--bg-surface` 已有语义消费），代码块不切角。

## §5 迁移与兼容
- 旧 `settings.theme` 值经 `migrateThemeId` 一次归一（6→4 映射表见 §1.1）；未知值 → `dark`。
- localStorage `yfworking-settings` 结构不变（仅 theme 字段取值域收窄）；跨窗口 storage 同步机制不变。
- `glassOpacity/glassHueShift/glassAurora` 字段保留，对两个玻璃主题生效。
- speedMode 全局关动效机制不变（白名单动画项均在其覆盖内）。
- i18n：主题名/标语/设置行文案进 i18n；微标英文固定不翻译。
- **回归底线**：kernel/server/electron 认证编排不动；cockpit.js 仅 CSS token 与主题映射；既有 lucide 图标契约与 184 测试不破。

## §6 测试策略
- **单测**（node:test，沿用 usageUi 先例）：`migrateThemeId`（6 旧值/undefined/垃圾值/新值幂等）；`THEMES` 完整性（4 条目、`THEME_CLASS_NAMES` 同步、`isDefault` 唯一）。
- **构建**：`npm run typecheck` + `npm run build` 绿。
- **回归**：`npm test` 184 全过。
- **手工冒烟矩阵**（4 主题 × 6 屏）：认证小窗（登录/首设/锁定三态）/ boot / 驾驶舱（4 模式 + speedMode + hub 进出）/ 工作界面（rail/二级面板/聊天/提问卡/输入/浮层）/ 设置（ThemePicker 切换 + 玻璃三设置 + 独立设置窗跨窗同步）/ 命令面板。重点：切主题零闪烁（首帧 class）、玻璃透光度热调、浅色主题白 logo 不出现（字标切换）。
- **视觉验收**：与 `scratch/unified-design-mockup.html` 并排比对（原型即验收基准：切角/细线/微标/光效/数据表达逐项核对）。

## 风险与未决
- **浅色玻璃全新无先例**：文字对比/桌面透显不可控 → `glassOpacity` 默认 0.3 起步，验收不达则调白基底与文字 `--s` 刻度；风险接受（可单主题回退隐藏，不影响实色两态）。
- **驾驶舱玻璃态透显**：iframe 透明背景依赖主窗口透明（玻璃主题既有机制）；若某平台 backdrop 异常，兜底 = 玻璃态 cockpit 用墨/白半透明不透明底（不露桌面）。
- **默认主题改为 dark**：首启体验由浅转深 → 首启登录窗现随主题（深色品牌开场，与 boot/驾驶舱一致）；如用户偏好浅色默认，改 `defaultSettings.theme` 一行即可（验收时最终确认）。
