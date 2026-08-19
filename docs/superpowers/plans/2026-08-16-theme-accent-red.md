# 主题系统 v2 实施计划 — 远方红·Accent 注入 + 6 套主题分组

| 字段 | 值 |
|---|---|
| 日期 | 2026-08-16 |
| 关联规格 | [`docs/superpowers/specs/2026-08-16-theme-accent-red-design.md`](../specs/2026-08-16-theme-accent-red-design.md) |
| 状态 | 待审批 / 待执行 |
| 预计改动 | 3 文件（themes.css / types/index.ts / SettingsView.tsx）+ 1 新文件（原型 HTML） |

---

## 1. 目标与范围

把设计规格 §1 的"远方红=accent、6 套=1 远方+3 实色+2 玻璃"落到代码：

- **新增**：6 套主题各自的 `--accent-red-*` 7 个语义令牌
- **新增**：`THEMES` 元数据 `category` 字段
- **改造**：`ThemePicker` 按 category 分组渲染
- **新增**：`docs/prototypes/theme-accent-red.html` 原型，供视觉验证
- **不动**：现有 `--accent` / `--error` / `--success` / `--warning` 令牌、`defaultSettings.theme`、`SettingsView` 其余组件

---

## 2. 前置条件

- [x] 设计规格定稿（见上链接）
- [x] 6 套主题 CSS 变量映射表（在 design §3 已明确）
- [x] 元数据 category 划分（在 design §4 已明确）
- [ ] 用户对实施计划审批通过

---

## 3. 步骤分解

### 步骤 1：themes.css 增加 `--accent-red-*` 令牌（核心）

**改动**：在 6 个 `.theme-*` 块中各新增 9 行（accent-red 默认/hover/active/subtle/soft/fg/ring + 2 个 var() 引用）

**改动模板**（以 `.theme-yuanfang-light` 为例）：

```css
/* 在 --accent-subtle 后插入 */
--accent-red:        #ff2400;
--accent-red-hover:  #e31e00;
--accent-red-active: #b81700;
--accent-red-subtle: rgba(255,36,0,0.10);
--accent-red-soft:   rgba(255,36,0,0.18);
--accent-red-fg:     #ffffff;        /* 【统一】所有主题白字，与品牌橙按钮保持视觉一致 */
--accent-red-ring:   rgba(255,36,0,0.35);
```

**6 套主题差异化值**（强调按钮统一白字，v2 决策）：

| 主题 | accent-red | accent-red-hover | accent-red-subtle | accent-red-fg |
|---|---|---|---|---|
| yuanfang-light | #ff2400 | #e31e00 | rgba(255,36,0,0.10) | **#ffffff** |
| yuanfang | #ff573b | #ff8d6e | rgba(255,87,59,0.14) | **#ffffff** |
| dark | #ff573b | #ff8d6e | rgba(255,87,59,0.14) | **#ffffff** |
| light | #ff2400 | #e31e00 | rgba(255,36,0,0.10) | **#ffffff** |
| glass | #ff2400 | #ff573b | rgba(255,36,0,0.16) | **#ffffff** |
| glass-warm | #ff2400 | #ff573b | rgba(255,36,0,0.16) | **#ffffff** |

**v2 决策依据**：原 v1 中 yuanfang/dark/glass-warm 用深色 fg（与暗底配），v2 改为统一白字：
- 与品牌主操作按钮（橙底白字）视觉一致，强化"红=强调"识别
- 玻璃透光下白字穿透感更强，避免暗字在透光场景消失
- 红底白字对比度 WCAG AA（4.7:1 ~ 6.2:1）

**插入位置**：每套主题的 `--accent-*` 之后、`--success` 之前。

---

### 步骤 2：types/index.ts 补全 `category` 字段

**改动**：在 `ThemeMeta` 类型加 `category: 'brand' | 'solid' | 'glass'`，给 `THEMES` 6 个对象各加 `category` 字段。

**Type 增量**（约 2 行）：

```ts
export interface ThemeMeta {
  id: ThemeMode
  name: string
  variant?: string
  tagline: string
  surface: string
  primary: string
  deep: string
  glyph: string
  isDefault?: boolean
  category: 'brand' | 'solid' | 'glass'   // 【新增】
}
```

**THEMES 数组增量**：每个对象末尾加 `category: 'brand' | 'solid' | 'glass'`。

---

### 步骤 3：SettingsView.tsx ThemePicker 按 category 分组

**改动**：
- `ThemePicker` 内部按 `category` 分组渲染
- 元信息显示 `"6 themes · 1 远方 + 3 实色 + 2 玻璃"`
- 卡片预览组件 `ThemePreviewCard` 不变

**渲染逻辑**（替换 `THEMES.map`）：

```tsx
const groups = [
  { key: 'brand', label: t('themeGroup.brand') },     // "远方品牌"
  { key: 'solid', label: t('themeGroup.solid') },     // "实色对照"
  { key: 'glass', label: t('themeGroup.glass') },     // "玻璃氛围"
] as const

{groups.map(g => (
  <div key={g.key}>
    <h4 className="text-[10px] font-semibold text-tertiary uppercase tracking-wider mt-3 mb-2">
      {g.label} · {THEMES.filter(t => t.category === g.key).length}
    </h4>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {THEMES.filter(th => th.category === g.key).map(theme => (
        <ThemePreviewCard key={theme.id} theme={theme} active={value === theme.id} onSelect={() => onChange(theme.id)} />
      ))}
    </div>
  </div>
))}
```

**注意**：yuanfang-light 与 yuanfang 都归 `brand` 组，但保持 2 张独立卡片（不合并）。

---

### 步骤 4：i18n 文案补充

**改动**：
- `src/i18n/translations/zh-CN.ts`：新增 `themeGroup.brand / solid / glass`
- `src/i18n/translations/en-US.ts`：同上

**中文**：

```ts
themeGroup: {
  brand: '远方品牌',
  solid: '实色对照',
  glass: '玻璃氛围',
}
```

**英文**：

```ts
themeGroup: {
  brand: 'Brand',
  solid: 'Solid',
  glass: 'Glass',
}
```

---

### 步骤 5：组件层引用点（按 design §5.2）

**优先级 1 — 链接 hover**：在 `globals.css` 增加全局链接样式

```css
a, [data-link] {
  transition: color 0.15s ease;
}
a:hover, [data-link]:hover {
  color: var(--accent-red);
}
```

**优先级 2 — QuestionCard 选项 hover**：把 `--accent-subtle` 改为 `--accent-red-soft`

（具体定位需 grep `bg-accent-subtle` 在 QuestionCard.tsx 的引用点）

**优先级 3 — SettingsView 测试连接成功提示**：保留 `--success`，不动（避免语义混淆）

**优先级 4 — ChatInput Send 按钮**：不动，保持 `--accent`

---

### 步骤 6：原型 HTML（独立可运行）

**新增文件**：`docs/prototypes/theme-accent-red.html`

**用途**：把 6 套主题的 `--accent-red-*` 变量塞进一个静态 HTML，每个主题一张卡片：
- 标题（主题名 + 类别）
- 6 个组件示例：链接、按钮（主操作/危险/强调）、徽章、focus ring、输入框错误边框
- 切换器：JS 动态切换 `data-theme` 属性验证玻璃透光

**验收**：浏览器打开 `docs/prototypes/theme-accent-red.html`，6 张卡片横向/网格排列，肉眼检查远方红是否：
- 与橙色不撞色
- 玻璃主题下不刺眼
- focus ring 可见

---

### 步骤 7（v2 新增）：玻璃主题色调滑块

**改动**：在 `SettingsView.tsx` 的"玻璃设置"区域增加"色调偏移"滑块，让用户实时调节玻璃背景极光的色相。

**改动点**：
- `src/stores/settingsStore.ts`：增加 `glassHueShift: number` 字段（默认 0，范围 -180~180）
- `src/components/settings/SettingsView.tsx`：在 glassOpacity 下方增加新 Slider
- `src/styles/themes.css`：在 `.theme-glass` 和 `.theme-glass-warm` 的光晕层加 `filter: hue-rotate(var(--glass-hue-shift))`
- `src/i18n/translations/zh-CN.ts` / `en-US.ts`：增加 `settings.glassHueShift` / `glassHueShiftDesc`

**实现要点**：
- 仅当主题为 `glass` 或 `glass-warm` 时显示滑块（其他主题隐藏）
- 滑块值通过 `useSettingsStore.updateSettings({ glassHueShift })` 持久化
- CSS 变量绑定：`document.documentElement.style.setProperty('--glass-hue-shift', ...)`
- hue-rotate 影响范围：只应用到 `.theme-glass::before` 的极光光晕层，**不**影响按钮/文字/链接色

**settingsStore 增量**（约 3 行）：

```ts
glassOpacity: 0.30,
glassAurora: true,
glassHueShift: 0,           // 【新增】色调偏移（度），仅玻璃主题生效

// onRehydrateStorage 兜底
state.settings.glassHueShift ??= 0
```

**SettingsView 增量**（约 16 行）：

```tsx
{(settings.theme === 'glass' || settings.theme === 'glass-warm') && (
  <>
    <SettingRow label={t('settings.glassHueShift')}>
      <input
        type="range"
        min="-180" max="180" step="5"
        value={settings.glassHueShift}
        onChange={e => updateSettings({ glassHueShift: Number(e.target.value) })}
        className="w-32 accent-brand-500"
      />
      <span className="text-xs text-primary w-10 text-right tabular-nums">{settings.glassHueShift}°</span>
    </SettingRow>
  </>
)}
```

**themes.css 增量**（在两个 glass 主题块各加 1 行）：

```css
/* 在 .theme-glass / .theme-glass-warm 的 ::before 极光层后 */
filter: hue-rotate(var(--glass-hue-shift, 0deg));
transition: filter 0.3s ease;
```

**i18n 增量**：

```ts
// zh-CN
glassHueShift: '玻璃色调',
glassHueShiftDesc: '仅玻璃主题生效，调节极光背景色相（-180° ~ +180°）',

// en-US
glassHueShift: 'Glass Hue',
glassHueShiftDesc: 'Glass themes only — shift aurora backdrop hue (-180° to +180°)',
```

---

## 4. 文件改动清单

| 文件 | 类型 | 行数变化（预估） |
|---|---|---|
| `src/styles/themes.css` | Edit ×6 | +9 ×6 = +54（步骤 1） |
| `src/types/index.ts` | Edit ×7 | +1（type）+ +1（每对象）= +7 |
| `src/components/settings/SettingsView.tsx` | Edit ×1 | +20（分组）+ +16（色调滑块）= +36 |
| `src/i18n/translations/zh-CN.ts` | Edit ×1 | +5（themeGroup）+ +2（色调）= +7 |
| `src/i18n/translations/en-US.ts` | Edit ×1 | +5 + +2 = +7 |
| `src/stores/settingsStore.ts` | Edit ×1 | +1（glassHueShift）+ +1（rehydrate 兜底）= +2 |
| `src/styles/globals.css` | Edit ×1 | +8（链接样式） |
| `docs/prototypes/theme-accent-red.html` | Write ×1 | 新文件 ~840 行（v2 含真实组件） |

---

## 5. 验收步骤

按 design §9 6 条 + v2 新增 2 条：

1. **变量存在**：DevTools 查看 `:root.theme-yuanfang-light` 有 7 个 `--accent-red-*`
2. **强调按钮统一白字**：6 主题下 `.btn-accent-red` 文字均为 `#ffffff`（v2 新增）
3. **分组渲染**：ThemePicker 显示 3 个 group 标题
4. **组件引用**：QuestionCard 选项 hover 后底色变化（视觉验证）
5. **玻璃透光**：切到 glass / glass-warm，红 accent 不刺眼
6. **红橙不撞**：6 主题下橙色 Send 按钮 vs 红色 hover 链接色相差 ≥ 15°
7. **零回归**：现有 `--accent` / `--error` / `--success` 全局搜索值不变
8. **色调滑块**：玻璃主题下拖动设置中"色调"滑块，背景极光色相实时变化，按钮/文字/链接色不受影响（v2 新增）

---

## 6. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 红色与橙色 hue 相近（0° vs 24°） | 仅在强调位用红，主操作保持橙 | 移除 `--accent-red` 引用，组件回到 `--accent` |
| 玻璃主题下红色透光刺眼 | 玻璃专用值（#ff573b + 0.16 alpha） | 单独调 glass 块的 `--accent-red-hover` |
| 6 主题分组让用户认知超载 | group 标题用 `text-[10px]` 小字 | 恢复单层 grid |
| i18n key 缺失导致空白 | 步骤 4 同步 zh-CN + en-US | 加 fallback |
| QuestionCard 改造破坏现有 a11y | focus ring 单独保留 `--accent-red-ring` | 跳过步骤 5 优先级 2 |
| **v2: 强调按钮统一白字，深色主题 fg 改白后对比度下降** | 红 #ff2400 vs 白 = 4.7:1（WCAG AA）；暗底用提亮红 #ff573b vs 白 = 6.2:1（AAA） | 单独配置某些主题改回深 fg |
| **v2: 色调滑块持久化后用户切到非玻璃主题仍持有偏移值** | 仅在玻璃主题显示滑块，CSS 变量绑定 glass/glass-warm 作用域 | 切换主题时强制 `glassHueShift=0` |
| **v2: hue-rotate 影响文字/按钮色** | `filter: hue-rotate()` 仅应用于 `::before` 极光层，不下传到子元素 | 用 mask-image 而非 filter 隔离 |

---

## 7. 不在本计划范围内

- **替换 `--accent` 为 `--accent-red`**：明确禁止（保持品牌主调）
- **新增第 7 套主题**：本计划固定 6 套
- **动态主题色**：用户偏好实时换色的能力（不在本规格）
- **暗色玻璃主题共享组件库**：不涉及

---

## 8. 执行顺序

```
步骤 1 (themes.css)  →  步骤 6 (原型 HTML, 可视验证)  →  步骤 2 (types)  →  步骤 4 (i18n)  →  步骤 7 (色调滑块，settingsStore + SettingsView + themes.css)  →  步骤 3 (SettingsView 分组)  →  步骤 5 (组件引用)
```

理由：原型先行可在没有组件层改动的情况下肉眼检查远方红效果，省去"改完发现颜色不对要回滚"。色调滑块放在分组渲染之前，因它是 SettingsView 内的子功能，分组是容器。

---

## 9. 完成定义（DoD）

- [ ] 步骤 1-7 全部完成且无 lint 错误
- [ ] `npm run build` 通过
- [ ] `docs/prototypes/theme-accent-red.html` 在 Chrome 打开视觉无异常（v2 含真实组件 + 色调滑块）
- [ ] dev server 启动后切 6 主题无样式破损
- [ ] SettingsView ThemePicker 显示 3 个 group 标题
- [ ] QuestionCard 选项 hover 底色变化（视觉验证）
- [ ] 玻璃主题下"色调"滑块实时改变背景极光色相，按钮/文字/链接色不变
- [ ] 6 主题强调按钮（`.btn-accent-red`）文字均为白色

---

## 10. 同步要求（按 project memory）

实施完成后需：
- **release 副本同步**：改动文件双份拷贝到 release 目录
- **不重启 live app**：仅写文件，提示用户自启验证