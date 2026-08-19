# 主题系统 v2 设计规格 — 远方红·Accent 注入 + 6 套主题定位

| 字段 | 值 |
|---|---|
| 日期 | 2026-08-16 |
| 状态 | 设计定稿 / 待实施 |
| 涉及文件（参考） | `src/styles/themes.css`、`src/components/settings/SettingsView.tsx`、`src/types/index.ts`（`THEMES` 元数据） |
| 决策记录 | 远方红 = `--accent-red`（强调色，不替换现有 `--accent`）；6 套 = 1 远方 + 3 实色 + 2 玻璃 |

---

## 1. 设计目标

将原"6 主题色相堆叠"思路收敛为**两个独立维度的正交组合**：

- **角色维度**（做什么用）：`--accent`（主品牌动作）、`--accent-red`（强调/点高）、`--error`（错误）、`--warning`（警告）
- **视觉维度**（长什么样）：实色（Opaque）/ 玻璃（Glass blur）

最终规格：
- **远方红 #ff2400 落位**：作为远方橙主题内的"强调色"，与主品牌橙同调但更纯、更亮，用于"需点高 / 需重视 / 链接 hover / 重要提示"
- **主题总数**：6 套
  - 1 套远方品牌（yuanfang 系列，暖白/暖深）
  - 3 套实色对照（dark / light / yuanfang-deep 中选 3）
  - 2 套玻璃（glass 冷色 + glass-warm 暖色）

---

## 2. 设计原则

### 2.1 变量名语义化（已读 themes.css 既有约定）

所有色板遵循"语义令牌 → 用途"两层结构：
```
--brand-50..950   品牌色阶（主调渐变，不直接用）
--accent-*        当前主题强调色（默认与 brand-500 联动）
--accent-red-*    【新增】远方案强调色（独立色阶）
--error/warning/info/success-*   状态色
--bg-* / --text-* / --border-*   语义令牌
```

### 2.2 远方红的定位

| 维度 | `--accent`（现有） | `--accent-red`（新增） |
|---|---|---|
| 色相 | 与 brand-500 同色（橙） | #ff2400 纯红（独立色阶） |
| 用法 | 主按钮、激活态、品牌徽标 | 链接 hover、重要提示、需点高 |
| 与主品牌关系 | = 主品牌 | 互补强调（不替换） |
| 错误色 | `--error` 红（#dc2626）独立 | 与 `--error` 拉开亮度差 |

**关键约束**：`--accent-red` 与 `--accent` 共存，不互相替换。组件层使用 `var(--accent-red)` 时才引用，否则保持 `var(--accent)`。

### 2.3 6 套主题的角色

| 编号 | ID | 类别 | 主调色相 | 用途场景 |
|---|---|---|---|---|
| T1 | `yuanfang-light` | 远方品牌（实色浅） | 暖白 + 橙 | 默认 / 白天工作 / 品牌展示 |
| T2 | `yuanfang` | 远方品牌（实色深） | 暖深 + 橙 | 夜间工作 / 沉浸阅读 |
| T3 | `dark` | 实色（对照） | 深灰 + 青 | 长时间代码专注 |
| T4 | `light` | 实色（对照） | 浅灰 + 靛 | 白天纯文本阅读 |
| T5 | `glass` | 玻璃（磨砂冷） | 深紫 + 极光 | 创意氛围 / 演示 |
| T6 | `glass-warm` | 玻璃（磨砂暖） | 深棕 + 橙光晕 | 品牌氛围 / 沉浸 |

---

## 3. 变量表 — 新增 `--accent-red-*` 色阶

### 3.1 完整色阶（11 档）

```css
/* 浅色场景：纯红核心 + 浅暖边 */
--accent-red-50:   #fff1ed;   /* 极浅红底 */
--accent-red-100:  #ffe0d6;
--accent-red-200:  #ffbaa3;
--accent-red-300:  #ff8d6e;
--accent-red-400:  #ff573b;
--accent-red-500:  #ff2400;   /* ★ 品牌纯红（核心） */
--accent-red-600:  #e31e00;
--accent-red-700:  #b81700;
--accent-red-800:  #8c1100;
--accent-red-900:  #5f0b00;
--accent-red-950:  #330600;
```

### 3.2 语义令牌（按主题实例化）

每套主题都需要定义这套语义令牌：

```css
--accent-red:        var(--accent-red-500);   /* 默认 */
--accent-red-hover:  var(--accent-red-600);   /* hover */
--accent-red-active: var(--accent-red-700);   /* active */
--accent-red-subtle: rgba(255, 36, 0, 0.10);  /* 背景轻染 */
--accent-red-soft:   rgba(255, 36, 0, 0.18);  /* 选中态背景 */
--accent-red-fg:     #ffffff;                 /* 在 red 背景上的文字色 */
--accent-red-ring:   rgba(255, 36, 0, 0.35);  /* focus ring */
```

### 3.3 主题实例化要点

#### T1 yuanfang-light / T4 light（浅色背景）
- `--accent-red` = `#ff2400`
- `--accent-red-hover` = `#e31e00`
- `--accent-red-subtle` = `rgba(255,36,0,0.10)`
- `--accent-red-fg` = `#ffffff`

#### T2 yuanfang / T3 dark（深色背景）
- `--accent-red` = `#ff573b`（略提亮补偿暗底）
- `--accent-red-hover` = `#ff8d6e`
- `--accent-red-subtle` = `rgba(255,87,59,0.14)`
- `--accent-red-fg` = `#0e1118`

#### T5 glass / T6 glass-warm（玻璃背景）
- `--accent-red` = `#ff2400`（玻璃面板透光度下保持高饱）
- `--accent-red-hover` = `#ff573b`
- `--accent-red-subtle` = `rgba(255,36,0,0.16)`
- `--accent-red-fg` = `#ffffff`
- `--accent-red-ring` = `rgba(255,36,0,0.45)`

---

## 4. 6 套主题元数据（THEMES 数组）

`src/types/index.ts` 中 `THEMES` 需调整/补全：

```ts
export const THEMES: ThemeMeta[] = [
  {
    id: 'yuanfang-light',
    name: '远方',
    variant: 'Light',
    tagline: '暖白 + 橙 · 默认品牌',
    surface: '#f0f2f5',
    primary: '#ff6a00',
    deep: '#9a3412',
    glyph: 'YF·L',
    category: 'brand',         // 1/6 远方品牌
    isDefault: true,
  },
  {
    id: 'yuanfang',
    name: '远方',
    variant: 'Deep',
    tagline: '暖深 + 橙 · 沉浸阅读',
    surface: '#100c08',
    primary: '#e06b36',
    deep: '#9c411f',
    glyph: 'YF·D',
    category: 'brand',         // 与 light 合并为"1 套远方品牌"
    isDefault: false,
  },
  {
    id: 'dark',
    name: 'Graphite',
    variant: 'Midnight',
    tagline: '深灰 + 青 · 代码专注',
    surface: '#0c0e12',
    primary: '#0ea5e9',
    deep: '#0369a1',
    glyph: 'GR',
    category: 'solid',         // 3 实色之 1
    isDefault: false,
  },
  {
    id: 'light',
    name: 'Clean Slate',
    variant: 'Daylight',
    tagline: '浅灰 + 靛 · 纯文本阅读',
    surface: '#f2f4f7',
    primary: '#4f46e5',
    deep: '#3730a3',
    glyph: 'CS',
    category: 'solid',         // 3 实色之 2
    isDefault: false,
  },
  {
    id: 'glass',
    name: 'Aurora Glass',
    variant: 'Cold',
    tagline: '深紫 + 极光 · 创意氛围',
    surface: 'rgba(13,18,36,0.30)',
    primary: '#a78bfa',
    deep: '#6d28d9',
    glyph: 'AG·C',
    category: 'glass',         // 2 玻璃之 1
    isDefault: false,
  },
  {
    id: 'glass-warm',
    name: 'Aurora Glass',
    variant: 'Warm',
    tagline: '深棕 + 橙光晕 · 品牌氛围',
    surface: 'rgba(22,14,6,0.30)',
    primary: '#ff6a00',
    deep: '#c2410c',
    glyph: 'AG·W',
    category: 'glass',         // 2 玻璃之 2
    isDefault: false,
  },
];
```

**注**：原 themes.css 已有 6 套（yuanfang-light / yuanfang / dark / light / glass / glass-warm），本规格的"6 套"是**重新归类**（按"1 远方 + 3 实色 + 2 玻璃"分类标签），而非新增/删除。

---

## 5. 组件层使用约定

### 5.1 何时用 `--accent-red`

| 场景 | 用哪个变量 | 备注 |
|---|---|---|
| 主操作按钮（Send / Save / Confirm） | `--accent` | 保持品牌主调 |
| 危险操作按钮（Delete / Remove） | `--error` | 现有约定 |
| 链接 / 文字 hover | `--accent-red` | 需点高但不打断品牌主调 |
| 重要提示 badge | `--accent-red` + `--accent-red-subtle` 底 | 与成功/警告区分 |
| Tab 选中态 | `--accent` | 主品牌色，避免误用 |
| Loading 强调 | `--accent-red` | 吸引注意 |
| 关键状态（已选 / 焦点） | `--accent-red-ring` | focus 可见性 |

### 5.2 推荐改造点（按优先级）

1. **ChatInput 的 Send 按钮**：可保留 `--accent`，**不动**
2. **侧边栏 chat 项 hover**：从 `--bg-hover` → 增加 `--accent-red-subtle` 文字强调（可选）
3. **SettingsView 内"测试连接成功"提示**：从 `--success` 改为可区分层级——`--success`（成功）、`--accent-red`（需操作）
4. **QuestionCard 选项 hover**：可考虑用 `--accent-red-soft` 而非 `--accent-subtle`
5. **链接/面包屑 hover**：统一改为 `--accent-red`

### 5.3 禁止混用场景

- 错误提示 **不得** 用 `--accent-red`（用 `--error`）
- 成功提示 **不得** 用 `--accent-red`（用 `--success`）
- 主按钮 **不得** 用 `--accent-red` 替换 `--accent`（保持品牌识别）

---

## 6. 实施检查清单（待代码落地）

> 本设计文档**不直接修改代码**。以下为下一轮实施时的具体改动清单：

- [ ] `src/styles/themes.css`
  - 6 个 `.theme-*` 块各增加 `--accent-red-*` 7 个令牌
  - `--color-scheme` 块保持不变
- [ ] `src/types/index.ts`
  - `THEMES` 数组补全 `category` 字段（brand / solid / glass）
  - 卡片预览组件可按 `category` 分组渲染（如分组标题）
- [ ] `src/components/settings/SettingsView.tsx`
  - `ThemePicker` 渲染时按 `category` 分组
  - 元信息显示"6 主题 · 1 远方 + 3 实色 + 2 玻璃"
- [ ] `src/stores/settingsStore.ts`
  - 无需改动（默认值仍是 `yuanfang-light`）
- [ ] 选中 5 处组件层使用点（按 5.2 优先级），引入 `--accent-red` 引用
- [ ] 视觉回归：6 主题各跑一次，确认红与橙不撞色、不刺眼

---

## 7. 与既有系统的兼容

| 既有约定 | 影响 |
|---|---|
| `--accent-default` / `--accent-hover` / `--accent-subtle` | **保留不动**，新 `--accent-red` 独立存在 |
| `--error` / `--warning` / `--success` / `--info` | **保留不动**，与 `--accent-red` 拉开色相差 |
| 玻璃主题的 `color-mix(in srgb, ... var(--glass-opacity))` 机制 | **沿用**，仅在 `--accent-red-*` 透色时用预乘 alpha |
| `defaultSettings.theme = 'yuanfang-light'` | **保留**，默认主题不变 |
| SettingsView 的 `ThemePreviewCard` | 仅补 `category` 字段，分组渲染 |

---

## 8. 风险与权衡

| 风险 | 缓解 |
|---|---|
| 红色与橙色相近（hue 0° vs 24°），易撞色 | 远方红 `#ff2400` 比 brand `#ff6a00` 更纯、更深；保持"红用于强调、橙用于主操作"分工 |
| 玻璃主题下红色透光刺眼 | 玻璃专用 `--accent-red` 提亮（`#ff573b`）+ 降低 alpha（subtle 0.16） |
| 现有组件已用 `brand-500` 误用为"强调" | 不替换，只新增；逐步迁移而非大改 |
| 6 套主题用户认知负担 | ThemePicker 按"1 远方 + 3 实色 + 2 玻璃"分组显示，引导选择 |

---

## 9. 验收标准

1. 6 套主题均含 `--accent-red-*` 7 个变量，可被组件引用
2. ThemePicker 按 category 分组（3 个 group）
3. 至少 1 个新组件层引用点完成（如链接 hover）
4. 玻璃主题下 `--accent-red-subtle` 视觉无刺眼感
5. 红色与橙色在 6 套主题下不撞色（视觉验证 ≥ 3 套）
6. 现有 `--accent` / `--error` / `--success` 等令牌 0 改动

---

## 10. 后续

- 本设计实施完成后，导出"主题设计 token 总表"作为下游组件参考
- 后续如需新增主题色（如 #00b894 海绿），按相同流程：选角色 → 选主题 → 加变量 → 加元数据 → 选使用场景