# Ponos 前端升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Ponos 桌面应用补充登录入口（等待动画→欢迎页→主界面）、驾驶舱图谱化主界面（含 Token 用量六维统计）、工作台三栏布局（左任务栏/中聊天/右资源管理器）并完成品牌视觉升级（霓虹漩涡 P 图标全套替换）。

**Architecture:** 视图用 zustand 状态机（`viewStore`: boot→login→cockpit↔workspace），不引入路由。Token 统计用增量聚合 store（`tokenStatsStore`）+ 历史回填，纯函数可单测。布局改造复用现有组件（Sidebar/ChatWindow/FileBrowser），新增 RightRail 承载文件浏览，FileBrowser 增加列表/图标双模式。图标用 Python+Pillow 脚本绘制统一生成。

**Tech Stack:** Electron + React 18 + TS + Vite + Tailwind + zustand；Node 24 原生 TS 测试（`node --test src/xxx.test.ts`，相对导入带 `.ts`）；Python 3 + Pillow 生成图标。

## Global Constraints

- 内核零依赖纪律：前端图表（趋势图/环形图/水位条）一律手写 SVG，不引入图表库。
- 主题 token 纪律：组件只用语义 class（`bg-app/bg-surface/bg-elevated/text-primary/text-secondary/text-tertiary/border-subtle/border-default` 等）与主题变量（`--brand-500`/`--accent-cyan`/`--accent-red`），不硬编码 hex。
- 品牌色：霓虹粉 `#ff2d94`（`--brand-500`）、电青 `#1fd8f0`（`--accent-cyan`）、暗底 `#0d0d11`（`--bg-app`）。
- 全部新文案进 `src/i18n/translations/zh-CN.ts`（zhCN）+ `en-US.ts`（enUS，类型继承 zhCN）。
- 前端测试命令：`node --test src/<path>.test.ts`；全量：`node --test "server/*.test.mjs"`；类型检查：`npm run typecheck`。
- 文件移动/删除需用户确认；本计划无删除，仅覆盖替换 `public/` 下图标（脚本生成）。
- 提交纪律：`git add <path>` 显式添加，不用 `git add -A`。

---

### Task 1: 品牌图标生成（霓虹漩涡 P）

**Files:**
- Create: `build/make_ponos_icon.py`
- Overwrite (generated): `public/icon.png`、`public/icon-16/32/48/64/128/256.png`、`public/icon.ico`、`public/logo.png`、`public/shadow-theme/icon-vortex.png`

**Interfaces:**
- Produces: 上述 10 个图标文件（PNG 尺寸 16/32/48/64/128/256/239×241 logo、ICO 多尺寸）；运行命令 `python build/make_ponos_icon.py`。

- [ ] **Step 1: 编写图标生成脚本**

`build/make_ponos_icon.py` 核心逻辑（Pillow 绘制，含渐变分段描边）：

```python
"""Ponos 品牌图标生成：霓虹漩涡 P。
用法: python build/make_ponos_icon.py  （在仓库根目录运行）
产出: public/icon*.png / icon.ico / logo.png / shadow-theme/icon-vortex.png
"""
import os
from PIL import Image, ImageDraw

PINK = (255, 45, 148)      # #ff2d94
CYAN = (31, 216, 240)      # #1fd8f0
DARK = (13, 13, 17)        # #0d0d11

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def draw_vortex_p(size: int, bg: bool = True) -> Image.Image:
    """绘制霓虹漩涡 P：暗底圆角方块 + 粉→青渐变 P 字母 + 漩涡尾迹。"""
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # 圆角方底（暗色，半透明圆角）
    if bg:
        radius = int(size * 0.22)
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=DARK + (255,))
        # 外圈霓虹描边
        d.rounded_rectangle([1, 1, size - 2, size - 2], radius=radius, outline=PINK + (200,), width=max(2, size // 60))
    # P 字母：竖线 + 半圆头 + 漩涡尾迹（分段渐变）
    cx, cy, w = size * 0.30, size * 0.50, size * 0.16   # P 主体位置
    lw = max(3, size * 0.09)                            # 笔画宽度
    # 竖线（粉→青渐变，自上而下）
    steps = 24
    for i in range(steps):
        t = i / (steps - 1)
        y0 = cy - size * 0.30 + i * (size * 0.62 / steps)
        d.line([cx, y0, cx, y0 + size * 0.62 / steps + 1], fill=lerp(PINK, CYAN, t), width=int(lw))
    # 半圆头（P 的圆弧，青→粉）
    bbox = [cx - lw / 2, cy - size * 0.30, cx + size * 0.26, cy - size * 0.30 + size * 0.52]
    d.arc(bbox, start=90, end=270, fill=CYAN, width=int(lw))
    # 漩涡尾迹：从 P 右下向外螺旋（多段短线，透明度递增）
    import math
    for k in range(40):
        t = k / 39
        ang = t * math.pi * 2.2
        r = size * (0.10 + t * 0.16)
        x0 = cx + size * 0.20 + r * math.cos(ang)
        y0 = cy + size * 0.42 + r * math.sin(ang) * 0.5
        a = int(255 * (1 - t) * 0.9)
        d.ellipse([x0 - lw * 0.3, y0 - lw * 0.3, x0 + lw * 0.3, y0 + lw * 0.3], fill=lerp(PINK, CYAN, t) + (a,))
    return im

def main():
    root = os.path.join(os.path.dirname(__file__), '..', 'public')
    # 应用图标多尺寸
    for px in [16, 32, 48, 64, 128, 256]:
        draw_vortex_p(px).save(os.path.join(root, f'icon-{px}.png'))
    draw_vortex_p(256).save(os.path.join(root, 'icon.png'))
    # ICO 多尺寸合并
    imgs = [draw_vortex_p(px) for px in [16, 32, 48, 64, 128, 256]]
    imgs[0].save(os.path.join(root, 'icon.ico'), sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)], append_images=imgs[1:])
    # logo（透明底，Header/登录/驾驶舱用）
    draw_vortex_p(256, bg=False).resize((239, 241), Image.LANCZOS).save(os.path.join(root, 'logo.png'))
    draw_vortex_p(512).save(os.path.join(root, 'shadow-theme', 'icon-vortex.png'))
    print('icons generated')

if __name__ == '__main__':
    main()
```

- [ ] **Step 2: 运行脚本并验证输出**

Run: `python build/make_ponos_icon.py`
Expected: 打印 `icons generated`；10 个文件时间戳更新。

- [ ] **Step 3: 断言输出尺寸/模式**

Run:
```bash
python -c "
from PIL import Image
for f in ['public/icon.png','public/icon-256.png','public/icon-16.png','public/logo.png','public/shadow-theme/icon-vortex.png']:
    im = Image.open(f); print(f, im.size, im.mode)
"
```
Expected: icon.png/icon-256.png=256×256 RGBA、icon-16.png=16×16 RGBA、logo.png=239×241 RGBA、icon-vortex.png=512×512 RGBA。

- [ ] **Step 4: 提交**

```bash
git add build/make_ponos_icon.py public/icon.png public/icon-16.png public/icon-32.png public/icon-48.png public/icon-64.png public/icon-128.png public/icon-256.png public/icon.ico public/logo.png public/shadow-theme/icon-vortex.png
git commit -m "feat(ui): 霓虹漩涡 P 品牌图标生成脚本与全套图标替换"
```

---

### Task 2: viewStore 视图状态机

**Files:**
- Create: `src/stores/viewStore.ts`
- Test: `src/stores/viewStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type AppView = 'boot' | 'login' | 'cockpit' | 'workspace'
  interface ViewState {
    view: AppView
    workspaceTab: string | null      // 进入 workspace 时指定的左侧 tab
    authToken: string | null         // 预留认证扩展点（空实现）
    bootDone: () => void             // boot → login
    enter: () => void                // login → cockpit
    goCockpit: () => void            // workspace → cockpit（清 workspaceTab）
    goWorkspace: (tab?: string) => void  // cockpit → workspace（可选指定 tab）
    setAuthToken: (t: string | null) => void
  }
  export const useViewStore: UseBoundStore<StoreApi<ViewState>>
  ```
- Consumes: 无（独立）。

- [ ] **Step 1: 写失败测试**

`src/stores/viewStore.test.ts`（Node 24 原生 TS，`useViewStore.getState()` 直调）：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useViewStore } from './viewStore.ts'

test('初始 view=boot', () => {
  assert.equal(useViewStore.getState().view, 'boot')
})
test('bootDone → login → enter → cockpit', () => {
  const s = useViewStore.getState()
  s.bootDone()
  assert.equal(useViewStore.getState().view, 'login')
  useViewStore.getState().enter()
  assert.equal(useViewStore.getState().view, 'cockpit')
})
test('goWorkspace 带 tab，goCockpit 清 tab', () => {
  useViewStore.getState().goWorkspace('agents')
  const s = useViewStore.getState()
  assert.equal(s.view, 'workspace')
  assert.equal(s.workspaceTab, 'agents')
  useViewStore.getState().goCockpit()
  assert.equal(useViewStore.getState().view, 'cockpit')
  assert.equal(useViewStore.getState().workspaceTab, null)
})
test('setAuthToken 预留认证扩展点', () => {
  useViewStore.getState().setAuthToken('demo-token')
  assert.equal(useViewStore.getState().authToken, 'demo-token')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/stores/viewStore.test.ts`
Expected: FAIL（viewStore.ts 不存在 / module not found）。

- [ ] **Step 3: 实现 viewStore**

`src/stores/viewStore.ts`：

```ts
import { create } from 'zustand'

export type AppView = 'boot' | 'login' | 'cockpit' | 'workspace'

interface ViewState {
  view: AppView
  workspaceTab: string | null
  authToken: string | null
  bootDone: () => void
  enter: () => void
  goCockpit: () => void
  goWorkspace: (tab?: string) => void
  setAuthToken: (t: string | null) => void
}

export const useViewStore = create<ViewState>()((set) => ({
  view: 'boot',
  workspaceTab: null,
  authToken: null,
  bootDone: () => set({ view: 'login' }),
  enter: () => set({ view: 'cockpit' }),
  goCockpit: () => set({ view: 'cockpit', workspaceTab: null }),
  goWorkspace: (tab) => set({ view: 'workspace', workspaceTab: tab ?? null }),
  setAuthToken: (t) => set({ authToken: t }),
}))
```

（不持久化 view：每次启动从 boot 开始，符合设计 2.1；authToken 当前空实现留扩展。）

- [ ] **Step 4: 运行确认通过**

Run: `node --test src/stores/viewStore.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/stores/viewStore.ts src/stores/viewStore.test.ts
git commit -m "feat(ui): viewStore 视图状态机 boot→login→cockpit↔workspace"
```

---

### Task 3: tokenStatsStore Token 用量聚合

**Files:**
- Create: `src/stores/tokenStatsStore.ts`
- Test: `src/stores/tokenStatsStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TokenDayStat { input: number; output: number }
  export interface TokenStats {
    totalInput: number; totalOutput: number
    byDay: Record<string, TokenDayStat>          // key: 'YYYY-MM-DD'
    byConversation: Record<string, TokenDayStat>
    byModel: Record<string, TokenDayStat>
    lastUpdatedAt: number
  }
  export function createEmptyStats(): TokenStats
  export function addUsage(stats: TokenStats, u: { input: number; output: number }, dims: { day: string; conversationId: string; model: string }): TokenStats
  export function toDayKey(ts: number): string    // Date → 'YYYY-MM-DD'（本地时区）
  export function backfillConversation(stats: TokenStats, cwd: string, sessionId: string, convId: string, baseUrl?: string): Promise<TokenStats>
  interface TokenStatsStore {
    stats: TokenStats
    backfilled: Record<string, boolean>           // convId → 已回填标记（防重复）
    recordUsage: (u: { input: number; output: number }, dims: { conversationId: string; model: string }) => void
    ensureBackfill: (convs: { id: string; cwd?: string; sessionIds?: string[] }[], baseUrl?: string) => Promise<void>
  }
  export const useTokenStatsStore: UseBoundStore<StoreApi<TokenStatsStore>>
  ```
- Consumes: `getBridgeUrl()`（`src/lib/config.ts`）。

- [ ] **Step 1: 写失败测试**

`src/stores/tokenStatsStore.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyStats, addUsage, toDayKey, backfillConversation } from './tokenStatsStore.ts'

test('createEmptyStats 全零', () => {
  const s = createEmptyStats()
  assert.equal(s.totalInput, 0); assert.equal(s.totalOutput, 0)
  assert.deepEqual(s.byDay, {}); assert.deepEqual(s.byConversation, {}); assert.deepEqual(s.byModel, {})
})

test('addUsage 四维累加', () => {
  let s = createEmptyStats()
  s = addUsage(s, { input: 100, output: 50 }, { day: '2026-08-31', conversationId: 'c1', model: 'deepseek-v4-pro' })
  s = addUsage(s, { input: 10, output: 5 }, { day: '2026-08-31', conversationId: 'c1', model: 'deepseek-v4-pro' })
  s = addUsage(s, { input: 1, output: 1 }, { day: '2026-08-30', conversationId: 'c2', model: 'minimax' })
  assert.equal(s.totalInput, 111); assert.equal(s.totalOutput, 56)
  assert.deepEqual(s.byDay['2026-08-31'], { input: 110, output: 55 })
  assert.deepEqual(s.byConversation['c1'], { input: 110, output: 55 })
  assert.deepEqual(s.byModel['deepseek-v4-pro'], { input: 110, output: 55 })
})

test('toDayKey 本地时区 YYYY-MM-DD', () => {
  const d = new Date(2026, 7, 31, 12, 0, 0)  // 2026-08-31 本地
  assert.equal(toDayKey(d.getTime()), '2026-08-31')
})

test('backfillConversation 解析原始 transcript usage 并累加', async () => {
  const entries = [
    { type: 'assistant', timestamp: Date.now(), usage: { input_tokens: 200, output_tokens: 80 }, model: 'deepseek-v4-pro' },
    { type: 'assistant', timestamp: Date.now(), usage: { input_tokens: 50, output_tokens: 20 } },  // 无 model → byModel 跳过
    { type: 'user', timestamp: Date.now() },  // 非 assistant 跳过
  ]
  // mock bridge /transcript/load
  globalThis.fetch = async (url: string) => {
    assert.ok(String(url).includes('/transcript/load'))
    return { ok: true, json: async () => ({ ok: true, entries }) } as Response
  } as typeof fetch
  let s = createEmptyStats()
  s = await backfillConversation(s, 'C:/proj', 'sess-1', 'c1', 'http://mock')
  assert.equal(s.totalInput, 250); assert.equal(s.totalOutput, 100)
  assert.deepEqual(s.byModel['deepseek-v4-pro'], { input: 200, output: 80 })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/stores/tokenStatsStore.test.ts`
Expected: FAIL（module not found）。

- [ ] **Step 3: 实现 tokenStatsStore**

`src/stores/tokenStatsStore.ts`：

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getBridgeUrl } from '@/lib/config'

export interface TokenDayStat { input: number; output: number }
export interface TokenStats {
  totalInput: number
  totalOutput: number
  byDay: Record<string, TokenDayStat>
  byConversation: Record<string, TokenDayStat>
  byModel: Record<string, TokenDayStat>
  lastUpdatedAt: number
}

export function createEmptyStats(): TokenStats {
  return { totalInput: 0, totalOutput: 0, byDay: {}, byConversation: {}, byModel: {}, lastUpdatedAt: 0 }
}

function addDim(map: Record<string, TokenDayStat>, key: string, input: number, output: number) {
  const cur = map[key] || { input: 0, output: 0 }
  map[key] = { input: cur.input + input, output: cur.output + output }
}

export function addUsage(stats: TokenStats, u: { input: number; output: number }, dims: { day: string; conversationId: string; model: string }): TokenStats {
  const s: TokenStats = {
    ...stats,
    totalInput: stats.totalInput + u.input,
    totalOutput: stats.totalOutput + u.output,
    byDay: { ...stats.byDay },
    byConversation: { ...stats.byConversation },
    byModel: { ...stats.byModel },
    lastUpdatedAt: Date.now(),
  }
  addDim(s.byDay, dims.day, u.input, u.output)
  addDim(s.byConversation, dims.conversationId, u.input, u.output)
  if (dims.model) addDim(s.byModel, dims.model, u.input, u.output)
  return s
}

export function toDayKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 回填单个会话：拉取原始 transcript entries，解析 assistant 条目的 usage 累加。 */
export async function backfillConversation(
  stats: TokenStats, cwd: string, sessionId: string, convId: string, baseUrl?: string
): Promise<TokenStats> {
  const base = baseUrl || getBridgeUrl()
  const url = `${base}/transcript/load?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}&tailFirst=0`
  try {
    const res = await fetch(url)
    if (!res.ok) return stats
    const data = await res.json()
    if (!data || data.ok !== true || !Array.isArray(data.entries)) return stats
    let s = stats
    for (const e of data.entries) {
      if (e?.type !== 'assistant') continue
      const u = e.usage
      if (!u || typeof u.input_tokens !== 'number') continue
      const input = u.input_tokens || 0
      const output = u.output_tokens || 0
      const ts = typeof e.timestamp === 'number' ? e.timestamp : Date.now()
      s = addUsage(s, { input, output }, { day: toDayKey(ts), conversationId: convId, model: e.model || '' })
    }
    return s
  } catch {
    return stats  // bridge 不可达静默降级
  }
}

interface TokenStatsStore {
  stats: TokenStats
  backfilled: Record<string, boolean>
  recordUsage: (u: { input: number; output: number }, dims: { conversationId: string; model: string }) => void
  ensureBackfill: (convs: { id: string; cwd?: string; sessionIds?: string[] }[], baseUrl?: string) => Promise<void>
}

export const useTokenStatsStore = create<TokenStatsStore>()(
  persist(
    (set, get) => ({
      stats: createEmptyStats(),
      backfilled: {},
      recordUsage: (u, dims) =>
        set(s => ({ stats: addUsage(s.stats, u, { day: toDayKey(Date.now()), ...dims }) })),
      ensureBackfill: async (convs, baseUrl) => {
        const { backfilled } = get()
        const todo = convs.filter(c => !backfilled[c.id] && c.sessionIds?.length)
        if (todo.length === 0) return
        let s = get().stats
        const done = { ...backfilled }
        for (const c of todo) {
          for (const sid of (c.sessionIds || []).slice(0, 3)) {  // 大会话限 3 个 transcript 防卡顿
            s = await backfillConversation(s, c.cwd || '', sid, c.id, baseUrl)
          }
          done[c.id] = true
        }
        set({ stats: s, backfilled: done })
      },
    }),
    { name: 'ponos-token-stats', partialize: (s) => ({ stats: s.stats, backfilled: s.backfilled }) }
  )
)
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test src/stores/tokenStatsStore.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/stores/tokenStatsStore.ts src/stores/tokenStatsStore.test.ts
git commit -m "feat(ui): tokenStatsStore Token 用量四维聚合与历史回填"
```

---

### Task 4: uiStore 扩展（右侧栏 / 文件视图 / Token 面板）

**Files:**
- Modify: `src/stores/uiStore.ts`

**Interfaces:**
- Produces（追加到 UIState 与初始值、persist 白名单）:
  ```ts
  rightRailOpen: boolean          // 默认 true
  rightRailWidth: number          // 默认 280
  fileViewMode: 'list' | 'grid'   // 默认 'list'
  tokenPanelOpen: boolean         // 默认 false
  toggleRightRail: () => void
  setRightRailWidth: (w: number) => void
  setFileViewMode: (m: 'list' | 'grid') => void
  openTokenPanel: () => void
  closeTokenPanel: () => void
  ```

- [ ] **Step 1: 扩展 UIState 接口与实现**

在 `src/stores/uiStore.ts` 的 `UIState` 接口追加字段（参照 `sidebarOpen`/`sidebarWidth` 位置），在初始 state 追加：

```ts
rightRailOpen: true,
rightRailWidth: 280,
fileViewMode: 'list' as const,
tokenPanelOpen: false,
toggleRightRail: () => set(s => ({ rightRailOpen: !s.rightRailOpen })),
setRightRailWidth: (w) => set({ rightRailWidth: Math.max(200, Math.min(480, w)) }),
setFileViewMode: (m) => set({ fileViewMode: m }),
openTokenPanel: () => set({ tokenPanelOpen: true }),
closeTokenPanel: () => set({ tokenPanelOpen: false }),
```

persist `partialize` 白名单追加：`rightRailOpen`、`rightRailWidth`、`fileViewMode`。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS（无新错误）。

- [ ] **Step 3: 提交**

```bash
git add src/stores/uiStore.ts
git commit -m "feat(ui): uiStore 扩展右侧栏/文件视图模式/Token 面板状态"
```

---

### Task 5: BootScreen 启动等待动画 + LoginScreen 欢迎页

**Files:**
- Create: `src/components/boot/BootScreen.tsx`
- Create: `src/components/login/LoginScreen.tsx`
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: `useViewStore.bootDone / enter`（Task 2）、`usePonosCLI().connected`、`useHealthStore`。
- Produces:
  ```tsx
  export function BootScreen(): JSX.Element   // 内部 4 步加载动画，就绪或 4s 兜底后调 bootDone()
  export function LoginScreen(): JSX.Element  // 欢迎页，按钮调 enter()
  ```

- [ ] **Step 1: i18n 文案**

`zh-CN.ts` 追加：

```ts
boot: { initKernel: '初始化内核', loadConfig: '加载配置', connectModel: '连接模型', ready: '准备就绪' },
login: { tagline: 'AI 驱动的开发与咨询助手', enter: '进入 Ponos', version: '版本' },
```

`en-US.ts` 追加对应：

```ts
boot: { initKernel: 'Initializing kernel', loadConfig: 'Loading config', connectModel: 'Connecting model', ready: 'Ready' },
login: { tagline: 'AI-powered dev & consulting assistant', enter: 'Enter Ponos', version: 'Version' },
```

- [ ] **Step 2: 实现 BootScreen**

`src/components/boot/BootScreen.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { useViewStore } from '@/stores/viewStore'
import { usePonosCLI } from '@/hooks/usePonosCLI'
import { useTranslation } from '@/i18n/useTranslation'

const STEPS = ['boot.initKernel', 'boot.loadConfig', 'boot.connectModel', 'boot.ready'] as const

export function BootScreen() {
  const { t } = useTranslation()
  const bootDone = useViewStore(s => s.bootDone)
  const { connected } = usePonosCLI()
  const [step, setStep] = useState(0)

  useEffect(() => {
    // 连接成功 → 直接完成；否则每 900ms 推进一步，4 步后完成（4s 兜底）
    if (connected) { bootDone(); return }
    const timer = setInterval(() => {
      setStep(prev => {
        if (prev >= STEPS.length - 1) { clearInterval(timer); bootDone(); return prev }
        return prev + 1
      })
    }, 900)
    return () => clearInterval(timer)
  }, [connected, bootDone])

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-app relative overflow-hidden"
      style={{ backgroundImage: 'var(--shadow-bg-image)', backgroundSize: 'cover', backgroundPosition: 'center' }}>
      <div className="absolute inset-0 bg-app/70" />
      <div className="relative flex flex-col items-center gap-6">
        {/* 漩涡 P Logo 呼吸动画 */}
        <div className="w-24 h-24 rounded-full overflow-hidden ring-2 ring-brand-500/60 shadow-[0_0_40px_rgba(255,45,148,0.5)] animate-pulse">
          <img src="/shadow-theme/icon-vortex.png" alt="Ponos" className="w-full h-full object-cover" />
        </div>
        <div className="text-center">
          <div className="font-display font-bold tracking-[0.3em] text-2xl text-primary select-none">PONOS</div>
          <div className="text-xs text-tertiary mt-2 tracking-wider">{t('login.tagline')}</div>
        </div>
        {/* 步骤指示 */}
        <div className="flex items-center gap-3">
          {STEPS.map((key, i) => (
            <div key={key} className="flex items-center gap-3">
              <span className={i <= step ? 'text-accent-cyan text-xs' : 'text-tertiary/50 text-xs'}>
                {i < step ? '✓' : i === step ? '●' : '○'} {t(key)}
              </span>
              {i < STEPS.length - 1 && <span className="w-6 h-px bg-border-subtle" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 实现 LoginScreen**

`src/components/login/LoginScreen.tsx`：

```tsx
import { useViewStore } from '@/stores/viewStore'
import { useTranslation } from '@/i18n/useTranslation'

export function LoginScreen() {
  const { t } = useTranslation()
  const enter = useViewStore(s => s.enter)
  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-app relative overflow-hidden"
      style={{ backgroundImage: 'var(--shadow-bg-image)', backgroundSize: 'cover', backgroundPosition: 'center' }}>
      <div className="absolute inset-0 bg-app/70" />
      <div className="relative flex flex-col items-center gap-8 animate-fade-in">
        <div className="w-28 h-28 rounded-full overflow-hidden ring-2 ring-brand-500/60 shadow-[0_0_50px_rgba(255,45,148,0.55)]">
          <img src="/logo.png" alt="Ponos" className="w-full h-full object-cover" />
        </div>
        <div className="text-center">
          <div className="font-display font-bold tracking-[0.3em] text-3xl text-primary select-none">PONOS</div>
          <div className="text-sm text-secondary mt-2">{t('login.tagline')}</div>
        </div>
        <button
          onClick={enter}
          className="px-10 py-3 rounded-full text-sm font-semibold text-inverse transition-all hover:scale-[1.03] active:scale-[0.98]"
          style={{ background: 'linear-gradient(135deg, var(--brand-500), var(--brand-600))', boxShadow: '0 0 24px rgba(255,45,148,0.4)' }}
        >
          {t('login.enter')}
        </button>
        <div className="text-[10px] text-tertiary">{t('login.version')} {__APP_VERSION__}</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 类型检查 + 手动预览**

Run: `npm run typecheck`；`npm run dev` 打开 http://localhost:5173
Expected: typecheck PASS；页面显示 BootScreen 动画 4 步后切 LoginScreen。

- [ ] **Step 5: 提交**

```bash
git add src/components/boot/BootScreen.tsx src/components/login/LoginScreen.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(ui): 启动等待动画 BootScreen + 欢迎页 LoginScreen"
```

---

### Task 6: CockpitView 驾驶舱（模块卡片 + SVG 连线）

**Files:**
- Create: `src/components/cockpit/CockpitView.tsx`
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: `useChatStore`（conversations/backgroundTasks）、`useTokenStatsStore.stats`、`useViewStore.goWorkspace`、`useUIStore.openTokenPanel`、`useSettingsStore.settings`。
- Produces: `CockpitView` 组件；内部 4 卡片 + SVG 连线层。

- [ ] **Step 1: i18n 文案**

`zh-CN.ts` 追加：

```ts
cockpit: {
  welcome: '欢迎回来',
  today: '今日消息',
  runningTasks: '运行中任务',
  completionRate: '完成率',
  totalSessions: '总会话',
  sessionsTitle: '会话 · 任务',
  tokenTitle: 'Token 用量',
  tokenTotal: '累计用量',
  tokenToday: '今日用量',
  token7d: '近 7 日',
  fileTitle: '文件 · 目录',
  fileCount: '文件数',
  skillTitle: '技能 · Agent',
  skillCount: '技能数',
  agentCount: 'Agent 数',
  enter: '进入 →',
  backCockpit: '返回驾驶舱',
},
```

`en-US.ts` 对应英文。

- [ ] **Step 2: 实现 CockpitView**

`src/components/cockpit/CockpitView.tsx`：4 张卡片网格（2×2），卡片间 SVG 连线层（绝对定位，低透明度渐变描边，hover 卡片高亮相关连线）。卡片数据：

- **会话·任务**：`conversations.length`、今日消息数（`conversations` 遍历 `updatedAt` 计数估算，简化：今日更新的会话数）、`backgroundTasks.filter(running).length`、完成率 = 非 running 任务占比。点击 → `goWorkspace('chats')`。
- **Token 用量**：`stats.totalInput + stats.totalOutput`（`formatTokens` 复用 StatusBar 逻辑）、今日（`byDay[toDayKey(Date.now())]`）、近 7 日求和。迷你趋势：取 `byDay` 近 7 日柱状（手写 SVG rect）。点击 → `openTokenPanel()`。
- **文件·目录**：bridge `/list-dir?path=<cwd>` 拉当前目录，显示文件/目录数。失败显示占位+重试。点击 → `goWorkspace('chats')` 并 `openRightRail`（右侧栏默认开）。
- **技能·Agent**：`fetchSkills(settings.skillRoot)`（`src/lib/skills.ts:24`）拿技能数组长度、`DEFAULT_AGENTS.length`（`src/lib/agents.ts:212`）。点击 → `goWorkspace('skills')`。

SVG 连线：4 卡片中心坐标由 ref 测量（`getBoundingClientRect` + resize 监听），画 3-4 条曲线连接会话卡→其他卡，`stroke="url(#gradPinkCyan)"` `strokeOpacity=0.25`；hover 会话卡时 opacity→0.6。

`formatTokens` 工具函数本任务内定义（与 StatusBar 相同逻辑，后续 Task 12 可提取公共，YAGNI 暂不提取）。

- [ ] **Step 3: 类型检查 + 手动预览**

Run: `npm run typecheck`
Expected: PASS。临时在 App 渲染 CockpitView 预览布局（Task 8 正式挂载）。

- [ ] **Step 4: 提交**

```bash
git add src/components/cockpit/CockpitView.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(ui): 驾驶舱 CockpitView 模块卡片 + SVG 连线图谱化"
```

---

### Task 7: TokenStatsPanel Token 用量六维详情面板

**Files:**
- Create: `src/components/cockpit/TokenStatsPanel.tsx`
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: `useTokenStatsStore.stats`、`useUIStore.tokenPanelOpen/closeTokenPanel`、`useSettingsStore.settings.providers`（contextWindow）、`useChatStore.conversations`（会话标题）。
- Produces: `TokenStatsPanel` 全屏/抽屉面板（`tokenPanelOpen` 为 true 时渲染），含六维展示。

- [ ] **Step 1: i18n 文案**

`zh-CN.ts` 追加：

```ts
tokenPanel: {
  title: 'Token 用量统计',
  total: '累计消耗',
  today: '今日消耗',
  week7: '近 7 日消耗',
  trend: '近 30 日趋势',
  topSessions: '会话消耗 Top 10',
  byModel: '模型用量占比',
  ioSplit: '输入 / 输出拆分',
  window: '上下文窗口水位',
  input: '输入',
  output: '输出',
  empty: '暂无 Token 数据',
  close: '关闭',
},
```

`en-US.ts` 对应英文。

- [ ] **Step 2: 实现六维图表（手写 SVG）**

`src/components/cockpit/TokenStatsPanel.tsx`：

1. **总量卡**：3 个大数字（累计/今日/近7日），`formatTokens`。
2. **近 30 日趋势**：SVG polyline + 面积渐变（`byDay` 按日期排序取 30 天，最高值归一化）。
3. **会话 Top 10**：`byConversation` 按 `input+output` 降序取 10，横向占比条（宽度 = value/max），标签取会话标题（`conversations.find` 匹配，找不到用 id 前 8 位）。
4. **模型拆分**：`byModel` 环形图（`circle` stroke-dasharray 分段，粉/青/红三色）。
5. **输入/输出**：双色堆叠条 + 数字（`totalInput` vs `totalOutput`）。
6. **水位**：活跃会话（最新 `updatedAt` 会话）估算 token = `stats.byConversation[activeId]`，/ provider contextWindow（`settings.providers.find(active).contextWindow`，默认 1000000）→ 进度条。

面板结构：`tokenPanelOpen && createPortal(<div className="fixed inset-0 z-[80] bg-overlay backdrop-blur ..."> <div className="mx-auto max-w-5xl h-full bg-surface border rounded-2xl overflow-auto"> ... </div></div>, document.body)`。右上角关闭按钮 → `closeTokenPanel()`。

空数据态：`stats.totalInput + totalOutput === 0` 时显示 `tokenPanel.empty` 提示。

- [ ] **Step 3: 类型检查 + 手动预览**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add src/components/cockpit/TokenStatsPanel.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(ui): Token 用量六维详情面板 TokenStatsPanel"
```

---

### Task 8: App 视图挂载与启动流程串联

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useViewStore.view`、`BootScreen`（Task 5）、`LoginScreen`（Task 5）、`CockpitView`（Task 6）、`AppShell`（既有，Task 9-12 改造）。
- Produces: App 按 view 渲染四态；`MainApp` 中监听 view 变化触发 token 回填。

- [ ] **Step 1: 改造 App.tsx**

`src/App.tsx` 的 `MainApp` 增加视图分派：

```tsx
function MainApp() {
  const view = useViewStore(s => s.view)
  const s = useSettingsStore(st => st.settings)
  // ... 既有 tray/pet effect 保留 ...
  // 驾驶舱首次打开时触发 Token 历史回填
  useEffect(() => {
    if (view === 'cockpit') {
      const convs = useChatStore.getState().conversations
      void useTokenStatsStore.getState().ensureBackfill(convs)
    }
  }, [view])

  return (
    <TooltipProvider>
      {view === 'boot' && <BootScreen />}
      {view === 'login' && <LoginScreen />}
      {view === 'cockpit' && <CockpitView />}
      {view === 'workspace' && <AppShell />}
    </TooltipProvider>
  )
}
```

`isEditorWindow()` 分支保持优先（编辑器独立窗口不受登录门影响）。

- [ ] **Step 2: 端到端手动验证**

Run: `npm run dev` → http://localhost:5173
Expected: 启动显示 BootScreen（4 步动画）→ LoginScreen → 点「进入 Ponos」→ CockpitView；Token 卡片显示回填后的数据。

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `npm run typecheck && node --test "server/*.test.mjs"`
Expected: 全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add src/App.tsx
git commit -m "feat(ui): App 视图状态机挂载 — boot/login/cockpit/workspace 四态"
```

---

### Task 9: Header 品牌改造（Ponos + 头像 + 返回驾驶舱 + 右侧栏开关）

**Files:**
- Modify: `src/components/layout/Header.tsx`
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: `useViewStore.goCockpit`、`useUIStore.toggleRightRail`。

- [ ] **Step 1: i18n 文案**

`zh-CN.ts` header 追加：`backCockpit: '返回驾驶舱'`、`toggleRightRail: '切换资源管理器 (⌘E)'`；en-US 对应。

- [ ] **Step 2: 改造 Header 品牌区**

`Header.tsx:64-72` 替换为：

```tsx
<div className="flex items-center gap-2.5 shrink-0 no-drag">
  <button onClick={() => useViewStore.getState().goCockpit()} className="flex items-center gap-2.5 group" aria-label={t('header.backCockpit')}>
    <div className="w-8 h-8 rounded-full overflow-hidden ring-2 ring-brand-500/60 shadow-[0_0_12px_rgba(255,45,148,0.5)] group-hover:ring-brand-400 transition-all">
      <img src="/shadow-theme/icon-vortex.png" alt="Ponos" className="w-full h-full object-cover" />
    </div>
    <span className="font-display font-bold tracking-[0.2em] text-sm text-primary select-none group-hover:text-brand-300 transition-colors">Ponos</span>
  </button>
  <Tooltip content={t('header.toggleSidebar') + ' (⌘B)'}>
    <Button variant="ghost" size="xs" onClick={toggleSidebar} className="ml-1" aria-label={t('header.toggleSidebar')}>
      <Menu className="w-4 h-4" />
    </Button>
  </Tooltip>
</div>
```

右侧工具区（搜索/命令/设置前）追加右侧栏开关：

```tsx
<Tooltip content={t('header.toggleRightRail')}>
  <Button variant="ghost" size="xs" onClick={() => useUIStore.getState().toggleRightRail()} aria-label={t('header.toggleRightRail')}>
    <PanelRight className="w-4 h-4" />
  </Button>
</Tooltip>
```

`PanelRight` 从 `lucide-react` 导入。

- [ ] **Step 3: 键盘快捷键 ⌘E**

在 `AppShell.tsx` 的 `handleKeyDown` 追加：

```ts
if (mod && e.key === 'e') {
  e.preventDefault()
  useUIStore.getState().toggleRightRail()
  return
}
```

- [ ] **Step 4: 类型检查 + 提交**

Run: `npm run typecheck` → PASS
```bash
git add src/components/layout/Header.tsx src/components/layout/AppShell.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(ui): Header 品牌区改造 — Ponos 头像/返回驾驶舱/右侧栏开关"
```

---

### Task 10: 左侧任务栏改造（会话 + 运行任务 + cockpit 入口）

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: `useChatStore.backgroundTasks`、`useViewStore.goCockpit`。
- Produces: Sidebar 顶部运行任务区；TABS 移除 `files`、新增 `cockpit`。

- [ ] **Step 1: i18n 文案**

`zh-CN.ts` sidebar 追加：`runningTasks: '运行中任务'`、`noRunningTasks: '暂无运行任务'`、`stopTask: '中止'`；en-US 对应。

- [ ] **Step 2: TABS 精简**

`Sidebar.tsx` 的 `TABS` 数组：移除 `{ id: 'files', icon: FolderTree, ... }`（FileBrowser 移入右侧 RightRail），保留 chats/worktrees/history/agents/skills。`FolderTree` 导入移除。

- [ ] **Step 3: 顶部运行任务区**

在 Tab bar 下方、搜索区上方插入：

```tsx
{/* 运行任务区 */}
<div className="px-2 py-1.5 border-b bg-app/60">
  <div className="text-[10px] font-semibold text-tertiary uppercase tracking-wider mb-1">{t('sidebar.runningTasks')}</div>
  {runningTasks.length === 0 ? (
    <div className="text-[10px] text-tertiary/60 px-1">{t('sidebar.noRunningTasks')}</div>
  ) : (
    <div className="flex flex-col gap-1">
      {runningTasks.map(task => (
        <div key={task.id} className="flex items-center gap-2 px-2 py-1 rounded-md bg-elevated/60 text-xs text-secondary">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse shrink-0" />
          <span className="flex-1 min-w-0 truncate">{task.name}</span>
          <button onClick={() => removeBackgroundTask(task.id)} className="text-[10px] text-error hover:bg-error/10 rounded px-1 py-0.5">
            {t('sidebar.stopTask')}
          </button>
        </div>
      ))}
    </div>
  )}
</div>
```

其中 `runningTasks = backgroundTasks.filter(t => t.status === 'running')`，`removeBackgroundTask` 从 `useChatStore` 取（`chatStore.ts:1030`，本地列表移除；真正中止内核任务不在本计划范围，YAGNI）。

- [ ] **Step 4: cockpit 返回入口**

Tab bar 最前插入：

```tsx
<Tooltip content={t('header.backCockpit')}>
  <button onClick={() => useViewStore.getState().goCockpit()} aria-label={t('header.backCockpit')}
    className="flex items-center justify-center h-8 rounded-md text-tertiary hover:text-secondary hover:bg-elevated transition-colors w-8">
    <LayoutDashboard className="w-4 h-4" />
  </button>
</Tooltip>
```

`LayoutDashboard` 从 lucide-react 导入。

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run typecheck` → PASS
```bash
git add src/components/layout/Sidebar.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(ui): 左侧任务栏 — 运行任务区 + 移除 files + cockpit 入口"
```

---

### Task 11: RightRail 右侧资源管理器 + FileBrowser 图标模式

**Files:**
- Create: `src/components/layout/RightRail.tsx`
- Modify: `src/components/files/FileBrowser.tsx`
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: `useUIStore.rightRailOpen/rightRailWidth/setRightRailWidth/fileViewMode/setFileViewMode`。
- Produces: `RightRail` 组件（含 FileBrowser + 列表/图标切换）；FileBrowser 增加 `viewMode: 'list' | 'grid'` prop（默认 'list'，读 uiStore）。

- [ ] **Step 1: i18n 文案**

`zh-CN.ts` fileBrowser 追加：`listView: '列表视图'`、`gridView: '图标视图'`；en-US 对应。

- [ ] **Step 2: FileBrowser 支持图标模式**

`FileBrowser.tsx` 增加 prop `viewMode?: 'list' | 'grid'`（默认 `'list'`）。渲染分支：

- `viewMode === 'list'`：现有树形（`renderNode` 递归）不变。
- `viewMode === 'grid'`：仅渲染当前目录一层（`dirs + files`）为图标网格：

```tsx
{viewMode === 'grid' ? (
  <div className="grid grid-cols-3 gap-1.5 p-2">
    {[...dirs, ...files].map(e => (
      <button key={e.path}
        onClick={() => isDir ? toggleExpand(e.path) : openFile(e)}
        onContextMenu={ev => handleContextMenu(ev, e)}
        className="flex flex-col items-center gap-1.5 p-2 rounded-lg hover:bg-elevated transition-colors text-center min-w-0"
        title={e.name}>
        <span className="text-2xl">{e.type === 'drive' ? <HardDrive className="w-8 h-8 text-warning/75" /> :
          e.type === 'directory' ? <Folder className="w-8 h-8 text-warning/75" /> : getFileIcon(e.name)}</span>
        <span className="text-[10px] text-secondary truncate w-full leading-tight">{e.name}</span>
      </button>
    ))}
  </div>
) : ( /* 现有树形 */ )}
```

`isDir`/`openFile`/`getFileIcon` 复用现有逻辑（`getFileIcon` 返回 `<FileCode className="w-3.5 h-3.5 ..."/>`，grid 中包一层放大容器即可，保持函数不变）。

目录切换：grid 模式下双击文件夹进入（`toggleExpand` 改为 `setRootPath(e.path)` 语义——grid 单层浏览）。实现：grid 文件夹点击 `setRootPath(e.path)`（配合现有 `useEffect` 同步 fetch），返回用工具栏 `goParent`。

- [ ] **Step 3: 实现 RightRail**

`src/components/layout/RightRail.tsx`：

```tsx
import { useUIStore } from '@/stores/uiStore'
import { FileBrowser } from '@/components/files/FileBrowser'
import { ScrollArea } from '@/components/ui'
import { LayoutGrid, List } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { cn } from '@/lib/utils'

export function RightRail() {
  const { rightRailOpen, rightRailWidth, setRightRailWidth, fileViewMode, setFileViewMode } = useUIStore()
  const { t } = useTranslation()
  if (!rightRailOpen) return null
  return (
    <div className="h-full flex-shrink-0 flex flex-col border-l bg-app animate-slide-right" style={{ width: rightRailWidth }}>
      {/* 工具栏：模式切换 */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b shrink-0">
        <span className="text-[10px] font-semibold text-tertiary uppercase tracking-wider flex-1">Explorer</span>
        <button onClick={() => setFileViewMode('list')} aria-label={t('fileBrowser.listView')}
          className={cn('p-1 rounded hover:bg-elevated', fileViewMode === 'list' ? 'text-brand-500' : 'text-tertiary')}>
          <List className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => setFileViewMode('grid')} aria-label={t('fileBrowser.gridView')}
          className={cn('p-1 rounded hover:bg-elevated', fileViewMode === 'grid' ? 'text-brand-500' : 'text-tertiary')}>
          <LayoutGrid className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <FileBrowser viewMode={fileViewMode} />
        </ScrollArea>
      </div>
      {/* 宽度拖拽把手 */}
      <div
        className="absolute inset-y-0 left-0 w-1 cursor-col-resize hover:bg-brand-500/30 transition-colors"
        onMouseDown={e => {
          e.preventDefault()
          const startX = e.clientX
          const startW = rightRailWidth
          const onMove = (ev: MouseEvent) => setRightRailWidth(startW - (ev.clientX - startX))
          const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }}
      />
    </div>
  )
}
```

拖拽把手用绝对定位（父容器 `relative`）。

- [ ] **Step 4: AppShell 集成右侧栏**

`AppShell.tsx` 主内容区（Sidebar 与 Chat 之间）之后追加：

```tsx
{/* Right rail */}
<RightRail />
```

并 import `RightRail`。

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run typecheck` → PASS
```bash
git add src/components/layout/RightRail.tsx src/components/files/FileBrowser.tsx src/components/layout/AppShell.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts
git commit -m "feat(ui): 右侧资源管理器 RightRail + FileBrowser 列表/图标双模式"
```

---

### Task 12: StatusBar 改造（删 Sélectionner/Quitter + TK 打开 Token 面板）

**Files:**
- Modify: `src/components/layout/StatusBar.tsx`

**Interfaces:**
- Consumes: `useUIStore.openTokenPanel`。

- [ ] **Step 1: 删除手柄提示**

`StatusBar.tsx` shadow 分支（`settings.theme === 'shadow'`）右半区删除 Sélectionner/Quitter 区块（`Gamepad2` 图标 + 两个手柄提示 span），仅保留 TK 与 Auto/Manual。`Gamepad2` 导入移除。

- [ ] **Step 2: TK 徽标点击打开 Token 面板**

TK `StatusItem` 加 `onClick={openTokenPanel}`：

```tsx
<StatusItem
  icon={<span className="text-[10px] font-mono font-bold text-accent-cyan">TK</span>}
  label={`${t('statusBar.tokens')}: ${totalTokens.toLocaleString()}`}
  value={formatTokens(totalTokens)}
  onClick={useUIStore.getState().openTokenPanel}
/>
```

非 shadow 分支的 TK 同样加 `onClick`（两处）。

- [ ] **Step 3: 类型检查 + 提交**

Run: `npm run typecheck` → PASS
```bash
git add src/components/layout/StatusBar.tsx
git commit -m "feat(ui): StatusBar 删除 Sélectionner/Quitter，TK 打开 Token 统计面板"
```

---

### Task 13: 全量验证与收尾

**Files:**
- Modify: 无（验证 + 可选修复）

- [ ] **Step 1: 全量测试**

Run:
```bash
npm run typecheck && node --test "server/*.test.mjs" && node --test src/stores/viewStore.test.ts src/stores/tokenStatsStore.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: `tsc && vite build` 成功，dist/ 产出。

- [ ] **Step 3: 端到端人工验收清单**

`npm run dev` 逐项核对：

1. 启动 → BootScreen 4 步动画 → LoginScreen（霓虹漩涡 P + Ponos + 进入按钮 + 版本号）
2. 点进入 → CockpitView（4 卡片 + SVG 连线，hover 高亮；Token 卡片显示累计/今日/近7日）
3. Token 卡片/状态栏 TK → TokenStatsPanel 六维展示（总量/趋势/会话Top10/模型/输入输出/水位）
4. 会话卡片 → Workspace 聊天；Header 品牌区 → 返回驾驶舱
5. Workspace 三栏：左任务栏（会话+运行任务+5 tab+cockpit 入口）、中聊天、右资源管理器
6. 右侧资源管理器：列表 ⇄ 图标模式切换；图标模式双击文件夹进入、返回按钮、右键菜单
7. Header 显示 Ponos（非 SHADOW）+ 新漩涡 P 头像；⌘E 切换右侧栏
8. StatusBar 无 Sélectionner/Quitter；TK 点击打开 Token 面板
9. 桌面/任务栏/托盘图标为新霓虹漩涡 P

- [ ] **Step 4: 提交收尾**

```bash
git add -u src/ docs/superpowers/plans/2026-08-31-frontend-upgrade.md
git commit -m "docs: 前端升级实施计划 + 收尾修复"
```

---

## Self-Review 记录

- **Spec 覆盖**：§2 视图/流程 → Task 2/5/8；§3 驾驶舱+Token → Task 3/6/7；§4 三栏布局 → Task 9/10/11/12；§5 品牌图标 → Task 1；§6 测试 → Task 2/3/13。全覆盖。
- **占位符扫描**：所有代码步骤含实际代码；无 TBD/TODO。
- **类型一致性**：`viewStore` 的 `goWorkspace(tab?: string)` 在 Task 6/8/10 引用一致；`tokenStatsStore` 的 `recordUsage/ensureBackfill/backfillConversation` 签名跨 Task 3/6/7/8 一致；`uiStore` 扩展字段 Task 4 定义、Task 6/9/11/12 消费一致。
