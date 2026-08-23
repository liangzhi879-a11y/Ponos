# 上下文健康血条（HealthMeter）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以输入框下方常驻血条 + 红档边缘呼吸光晕 + 上浮建议卡片取代顶部 HealthBanner，纯前端改造。

**Architecture:** 三个独立组件（HealthMeter/HealthGlow/HealthSuggestCard）+ 一个纯逻辑模块（src/lib/healthUi.ts，node --test 可测）。数据源复用现有 healthStore（ponos_health/ponos_summary 事件链路零改动）；血条用 CSS transition 衔接档位跳变。删除 HealthBanner.tsx。

**Tech Stack:** React 18 + Tailwind（玻璃质感 tokens）+ zustand（healthStore）+ i18n（zh-CN/en-US）+ node --test（Node 24 原生 TS 剥离，仅测纯逻辑 .ts）。

## Global Constraints

- 项目前端测试框架为 `node --test`（Node 24 原生 TS 类型剥离），**无 vitest**；`.tsx` 组件不写单测，可测逻辑必须抽到无 JSX 的 `.ts` 模块
- node --test 相对导入必须带 `.ts` 扩展名（如 `import { meterState } from './healthUi.ts'`）
- 不引入新依赖；不改内核 / bridge / healthStore 结构与事件链路
- 血条提示行保持固定高度 `h-4 mt-1`，任何显隐不引起布局跳动
- 玻璃质感主题：动态元素用 `animate-pulse`；血条用半透明填充避免纯色刺眼
- i18n 双语（zh-CN/en-US）同步新增/删除
- 生效：`npm run build` 后同步 dist → release 双副本（Ponos + Ponos_ms92cd6u）

---

### Task 1: healthUi 纯逻辑模块（TDD）

**Files:**
- Create: `src/lib/healthUi.ts`
- Test: `src/lib/healthUi.test.ts`

**Interfaces:**
- Consumes: `import type { HealthInfo } from '../stores/healthStore.ts'`（结构：`{ score, tier: 'green'|'yellow'|'red', compactCount, remainingPct, remainingTurns, suggestNewSession, reason }`）
- Produces:
  - `export type MeterColor = 'green' | 'amber' | 'red'`
  - `export function meterState(health: HealthInfo | null): { widthPct: number; color: MeterColor }` —— null（首事件前）返回 `{ widthPct: 100, color: 'green' }` 占位；remainingPct 越界 clamp 到 0-100；tier 映射 green→'green'、yellow→'amber'、red→'red'
  - `export function shouldShowRedAlert(health: HealthInfo | null, dismissedUntil: number): boolean` —— `health 存在 && tier==='red' && Date.now() >= dismissedUntil`（光晕与卡片共用可见性判定）

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/healthUi.test.ts
// node --test src/lib/healthUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meterState, shouldShowRedAlert } from './healthUi.ts'
import type { HealthInfo } from '../stores/healthStore.ts'

function h(over: Partial<HealthInfo>): HealthInfo {
  return { score: 40, tier: 'green', compactCount: 0, remainingPct: 60, remainingTurns: 20, suggestNewSession: false, reason: '', ...over }
}

test('health 为 null 时血条占位满格绿色', () => {
  assert.deepEqual(meterState(null), { widthPct: 100, color: 'green' })
})

test('remainingPct 映射为宽度', () => {
  assert.equal(meterState(h({ remainingPct: 38 })).widthPct, 38)
})

test('tier 映射颜色：green→green / yellow→amber / red→red', () => {
  assert.equal(meterState(h({ tier: 'green' })).color, 'green')
  assert.equal(meterState(h({ tier: 'yellow' })).color, 'amber')
  assert.equal(meterState(h({ tier: 'red' })).color, 'red')
})

test('remainingPct 越界 clamp 到 0-100', () => {
  assert.equal(meterState(h({ remainingPct: 150 })).widthPct, 100)
  assert.equal(meterState(h({ remainingPct: -5 })).widthPct, 0)
})

test('shouldShowRedAlert：红档且未冷却为 true', () => {
  assert.equal(shouldShowRedAlert(h({ tier: 'red' }), Date.now() - 1000), true)
})

test('shouldShowRedAlert：冷却期内为 false', () => {
  assert.equal(shouldShowRedAlert(h({ tier: 'red' }), Date.now() + 60_000), false)
})

test('shouldShowRedAlert：非红档或 null 为 false', () => {
  assert.equal(shouldShowRedAlert(h({ tier: 'yellow' }), 0), false)
  assert.equal(shouldShowRedAlert(null, 0), false)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/lib/healthUi.test.ts`
Expected: FAIL — 模块不存在 / 函数未定义

- [ ] **Step 3: 最小实现**

```ts
// src/lib/healthUi.ts
import type { HealthInfo } from '../stores/healthStore.ts'

export type MeterColor = 'green' | 'amber' | 'red'

export interface MeterState {
  widthPct: number
  color: MeterColor
}

export function meterState(health: HealthInfo | null): MeterState {
  if (!health) return { widthPct: 100, color: 'green' }
  const widthPct = Math.max(0, Math.min(100, health.remainingPct))
  const color: MeterColor = health.tier === 'red' ? 'red' : health.tier === 'yellow' ? 'amber' : 'green'
  return { widthPct, color }
}

export function shouldShowRedAlert(health: HealthInfo | null, dismissedUntil: number): boolean {
  return !!health && health.tier === 'red' && Date.now() >= dismissedUntil
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test src/lib/healthUi.test.ts`
Expected: PASS（7 用例）

- [ ] **Step 5: 提交**

```bash
git add src/lib/healthUi.ts src/lib/healthUi.test.ts
git commit -m "feat(health): healthUi 纯逻辑模块（血条状态/红档可见性判定）"
```

---

### Task 2: HealthMeter 血条组件

**Files:**
- Create: `src/components/chat/HealthMeter.tsx`
- Modify: `src/components/chat/ChatInput.tsx:743-752`（Composer hint 行内嵌血条）
- Modify: `src/styles/globals.css`（新增一次性压缩脉冲动画）

**Interfaces:**
- Consumes: `meterState`（Task 1）、`useHealthStore`（health/summaryCompactCount）、`useTranslation`、`Tooltip`（`@/components/ui`）、`cn`（`@/lib/utils`）
- Produces: `export function HealthMeter(): JSX.Element | null`（始终渲染——常驻占位）

- [ ] **Step 1: 创建 HealthMeter 组件（含压缩脉冲动画）**

压缩动画信号：内核压缩发生时先发 `ponos_summary`（healthStore.summaryCompactCount 递增），下一轮 `ponos_health` 才更新血条宽度。用 `summaryCompactCount` 递增触发 1.2s 一次性高亮脉冲（`filter: brightness` 提升后回落，不破坏半透明 alpha），宽度随后由既有 `transition-[width]` 回涨——同一信号两段动画衔接。

```tsx
// src/components/chat/HealthMeter.tsx
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n/useTranslation'
import { useHealthStore } from '@/stores/healthStore'
import { meterState, type MeterColor } from '@/lib/healthUi'
import { Tooltip } from '@/components/ui'
import { cn } from '@/lib/utils'

const COLOR_CLASS: Record<MeterColor, string> = {
  green: 'bg-green-500/70',
  amber: 'bg-amber-500/80',
  red: 'bg-red-500/85',
}

/** 输入框下方常驻上下文血条：宽度=remainingPct，颜色=tier，跳变由 transition 衔接 */
export function HealthMeter() {
  const { t } = useTranslation()
  const health = useHealthStore(s => s.health)
  const summaryCompactCount = useHealthStore(s => s.summaryCompactCount)
  const [flash, setFlash] = useState(false)
  const prevCount = useRef(summaryCompactCount)

  // 压缩信号（ponos_summary 先于下一轮 ponos_health 到达）：血条一次性高亮脉冲，宽度随后回涨
  useEffect(() => {
    if (summaryCompactCount > prevCount.current) {
      prevCount.current = summaryCompactCount
      setFlash(true)
      const timer = setTimeout(() => setFlash(false), 1200)
      return () => clearTimeout(timer)
    }
    prevCount.current = summaryCompactCount
  }, [summaryCompactCount])

  const { widthPct, color } = meterState(health)
  const label = health
    ? `${t('health.remainingPct', { pct: health.remainingPct })} · ${t('health.remainingTurns', { turns: health.remainingTurns })}`
    : ''

  return (
    <Tooltip content={label}>
      <div className="absolute inset-y-0 left-0 right-0 z-0 flex items-center px-1">
        <div className="relative h-[2.5px] w-full overflow-hidden rounded-full bg-surface/60">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500 ease-out',
              COLOR_CLASS[color],
              flash && 'animate-compress-flash'
            )}
            style={{ width: `${widthPct}%` }}
          />
        </div>
      </div>
    </Tooltip>
  )
}
```

- [ ] **Step 1b: globals.css 追加压缩脉冲动画**

在 `src/styles/globals.css` 的 `locateFlash` 定义（:170-174）后追加（与既有一次性动画同模式，speed-mode 全局 `animation:none` 自动停用）：

```css
/* 压缩回涨提示：血条一次性高亮脉冲（压缩发生时宽度回涨前先闪一下） */
@keyframes compressFlash {
  0%   { filter: brightness(1); }
  40%  { filter: brightness(1.9); }
  100% { filter: brightness(1); }
}
.animate-compress-flash { animation: compressFlash 1.2s ease-out; }
```

- [ ] **Step 2: 挂载进 ChatInput 提示行**

将 `src/components/chat/ChatInput.tsx:743-752` 的 Composer hint 行改为（行容器改 `relative`，提示文字加 `relative z-10` 浮于血条之上，import 加入 `HealthMeter`）：

```tsx
        {/* Composer hint — reserved height so it never shifts the layout */}
        <div className="relative flex items-center justify-end h-4 mt-1 px-1 select-none">
          <HealthMeter />
          {!value.trim() && attachments.length === 0 && !activeSkill && (
            <span className="relative z-10 text-[10px] text-tertiary/80">
              {isStreaming
                ? t('chat.sendHintStreaming', { shortcut: formatShortcut(settings.interjectShortcut) })
                : t('chat.sendHint')}
            </span>
          )}
        </div>
```

- [ ] **Step 3: typecheck**

Run: `npx tsc --noEmit`
Expected: 无类型错误（注意 ChatInput 顶部 import 列表新增 `import { HealthMeter } from './HealthMeter'`）

- [ ] **Step 4: 提交**

```bash
git add src/components/chat/HealthMeter.tsx src/components/chat/ChatInput.tsx src/styles/globals.css
git commit -m "feat(health): HealthMeter 血条组件挂载输入框提示行（含压缩脉冲动画）"
```

---

### Task 3: HealthSuggestCard 上浮建议卡片

**Files:**
- Create: `src/components/chat/HealthSuggestCard.tsx`
- Modify: `src/components/chat/ChatInput.tsx`（根容器子级挂载）

**Interfaces:**
- Consumes: `shouldShowRedAlert`（Task 1）、`useHealthStore`（health/summary/dismissedUntil/dismiss）、`useChatStore`（createConversation）、`useUIStore`（setPendingInput）、`useTranslation`、`Button`（`@/components/ui`）
- Produces: `export function HealthSuggestCard(): JSX.Element | null`

- [ ] **Step 1: 创建 HealthSuggestCard 组件**

```tsx
// src/components/chat/HealthSuggestCard.tsx
import { useState } from 'react'
import { useTranslation } from '@/i18n/useTranslation'
import { useHealthStore } from '@/stores/healthStore'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { shouldShowRedAlert } from '@/lib/healthUi'
import { Button } from '@/components/ui'

/** 红档时从输入框向上浮出的"重新发起会话建议"卡片（非模态） */
export function HealthSuggestCard() {
  const { t } = useTranslation()
  const health = useHealthStore(s => s.health)
  const summary = useHealthStore(s => s.summary)
  const dismissedUntil = useHealthStore(s => s.dismissedUntil)
  const dismiss = useHealthStore(s => s.dismiss)
  const [carrySummary, setCarrySummary] = useState(true)

  if (!shouldShowRedAlert(health, dismissedUntil)) return null

  const handleNewSession = () => {
    const { conversations, activeConversationId, createConversation } = useChatStore.getState()
    const current = conversations.find(c => c.id === activeConversationId)
    createConversation(undefined, current?.agentId)
    if (carrySummary && summary) {
      useUIStore.getState().setPendingInput(summary, false)
    }
    dismiss()
  }

  const detail = `${t('health.remainingPct', { pct: health.remainingPct })} · ${t('health.remainingTurns', { turns: health.remainingTurns })}`

  return (
    <div className="absolute bottom-full left-2 right-2 mb-2 z-40 rounded-xl border border-red-500/25 bg-popover/95 backdrop-blur-xl shadow-2xl p-3 animate-slide-up">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-error">{health.reason || t('health.redTitle')}</span>
        <span className="text-xs text-red-500/80">{detail}</span>
      </div>
      {summary && (
        <div className="mt-2 max-h-20 overflow-y-auto rounded-lg bg-red-500/5 border border-red-500/10 px-2.5 py-1.5 text-xs text-secondary whitespace-pre-wrap">
          {summary}
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
          <input type="checkbox" checked={carrySummary} onChange={e => setCarrySummary(e.target.checked)} />
          {t('health.carrySummary')}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={handleNewSession} variant="danger" size="sm">
            {t('health.newSession')}
          </Button>
          <button onClick={dismiss} className="text-xs text-red-500/70 hover:text-red-500" aria-label={t('health.dismiss')}>
            {t('health.dismiss')}
          </button>
        </div>
      </div>
    </div>
  )
}
```

（`Button` 已确认有 `variant="danger"`：`bg-error/15 text-error border border-error/30`，玻璃质感半透明底，符合主题，勿再叠加实色 bg-red-600 className 覆盖。）

- [ ] **Step 2: 挂载进 ChatInput 根容器**

`ChatInput.tsx` 根容器（:525 `<div className="relative z-0 border-t bg-app">`）内、Slash command 面板旁新增（import 加入 `HealthSuggestCard`）：

```tsx
      {/* 红档"重新发起会话建议"卡片：从输入框向上浮出 */}
      <HealthSuggestCard />
```

- [ ] **Step 3: 验证红档横幅逻辑已完整迁移**

对比删除前的 `HealthBanner.tsx:19-27` handleNewSession：`createConversation(undefined, current?.agentId)` + `carrySummary && summary && setPendingInput(summary, false)` + `dismiss()` 均已包含。手动确认无遗漏后执行 typecheck：

Run: `npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add src/components/chat/HealthSuggestCard.tsx src/components/chat/ChatInput.tsx
git commit -m "feat(health): HealthSuggestCard 上浮建议卡片（开新会话/携带摘要/冷却）"
```

---

### Task 4: HealthGlow 边缘光晕 + 删除 HealthBanner + i18n 清理

**Files:**
- Create: `src/components/chat/HealthGlow.tsx`
- Modify: `src/components/chat/ChatWindow.tsx:8,199-201`（移除 HealthBanner、ScrollArea 外包 glow 层）
- Delete: `src/components/chat/HealthBanner.tsx`
- Modify: `src/i18n/translations/zh-CN.ts:115`、`src/i18n/translations/en-US.ts:111`（移除 yellowHint）

**Interfaces:**
- Consumes: `shouldShowRedAlert`（Task 1）、`useHealthStore`
- Produces: `export function HealthGlow(): JSX.Element | null`（红档未冷却时渲染光晕 overlay）

- [ ] **Step 1: 创建 HealthGlow 组件**

```tsx
// src/components/chat/HealthGlow.tsx
import { useHealthStore } from '@/stores/healthStore'
import { shouldShowRedAlert } from '@/lib/healthUi'

/** 红档时消息区四边呼吸红色光晕（pointer-events-none，不拦截交互） */
export function HealthGlow() {
  const health = useHealthStore(s => s.health)
  const dismissedUntil = useHealthStore(s => s.dismissedUntil)
  if (!shouldShowRedAlert(health, dismissedUntil)) return null
  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 rounded-lg animate-pulse"
      style={{ boxShadow: 'inset 0 0 24px 4px rgba(239,68,68,0.22)' }}
    />
  )
}
```

- [ ] **Step 2: ChatWindow 挂载并移除 HealthBanner**

`ChatWindow.tsx`：
1. 删除 import `HealthBanner`（:8），新增 `import { HealthGlow } from './HealthGlow'`
2. :200 删除 `<HealthBanner />`
3. 在根容器（:199 `flex-1 flex flex-col min-h-0 relative`，已 relative）内、ScrollArea 前插入 `<HealthGlow />`——glow 为 `absolute inset-0 z-0` 定位元素，层叠在普通流 ScrollArea 之上且 `pointer-events-none`，无需再包一层 div：

```tsx
  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <HealthGlow />
      <ScrollArea ref={scrollRef} className="flex-1" onScroll={handleScrollWithPin}>
        ...原内容...
      </ScrollArea>
```

- [ ] **Step 3: 删除 HealthBanner.tsx**

```bash
git rm src/components/chat/HealthBanner.tsx
```

- [ ] **Step 4: i18n 清理 yellowHint**

zh-CN.ts:115 删除 `yellowHint: '建议适时开始新会话',`；en-US.ts:111 删除 `yellowHint: 'Consider starting a new session',`。保留 redTitle/remainingPct/remainingTurns/carrySummary/newSession/dismiss。

- [ ] **Step 5: typecheck + 确认无残留引用**

```bash
npx tsc --noEmit
grep -rn "HealthBanner\|yellowHint" src/ || echo "CLEAN"
```
Expected: 无类型错误；grep 无输出（CLEAN）

- [ ] **Step 6: 提交**

```bash
git add -A src/components/chat/ src/i18n/
git commit -m "feat(health): HealthGlow 边缘光晕取代 HealthBanner，清理 i18n"
```

---

### Task 5: 构建 + 同步 release + 验证

**Files:**
- Build 输出: `dist/`（vite build）
- Sync: `release/Ponos/dist/`、`release/Ponos_ms92cd6u/dist/`（双副本）

- [ ] **Step 1: 全量构建**

```bash
npm run build
```
Expected: tsc 通过 + vite build 输出 dist/（含新组件代码的 assets 哈希文件）

- [ ] **Step 2: 运行逻辑测试确认无回归**

```bash
node --test src/lib/healthUi.test.ts
```
Expected: 7 用例 PASS

- [ ] **Step 3: 同步 release 双副本 dist**

```bash
cp -r dist/* release/Ponos/dist/
cp -r dist/* release/Ponos_ms92cd6u/dist/
```
（若 dist 含 index.html，同步后确认 release 的 index.html 引用新哈希 assets）

- [ ] **Step 4: 验证新构建含组件代码**

```bash
grep -rl "HealthMeter\|HealthGlow\|HealthSuggestCard" dist/assets/ | head
```
Expected: 输出至少一个匹配的 assets 文件（组件被引用进 bundle）

- [ ] **Step 5: CDP 重载验证（若 9223 可用）**

用既有 CDP 脚本（.salvage-work/cdp-*.cjs 模式）对 9223 的页面 target 执行 `Page.reload`；或由用户重启应用。确认 UI：输入框下方出现绿色血条；红档时出现边缘光晕与上浮卡片。

- [ ] **Step 6: 提交（若构建产物无变更则跳过）**

```bash
git add -A && git commit -m "chore(health): 同步 health-meter 构建产物至 release 双副本" || echo "无产物变更，跳过"
```
