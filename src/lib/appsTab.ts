// src/lib/appsTab.ts —— 应用页（AppConsole）三标签的取值与持久化（纯逻辑，零依赖）
//
// 为什么单独成文件：`.tsx` 无法被 `node --test` 直接加载（见 appQuality.ts 头注同款理由），
// 而"脏值归一"与"per-app 隔离"是本页最容易出错、最该被断言的两件事：
//   · 归一：localStorage 里的值可能是旧版本/手改/别的页面同名键写进来的 ⇒ 必须落到合法 tab，
//     否则 Radix Tabs 的受控 value 指向不存在的 trigger = **三个标签全不高亮、内容区空白**，
//     用户看到的是"应用页坏了"，而不是"存了个脏值"；
//   · 隔离：key 里不带 appId 就会串味——在 A 应用切到"命令"再打开 B 应用，B 也落在"命令"，
//     而 B 的默认落点**必须是 agent**（生成后要立刻看到质检在跑）。
//
// 键名带 `yfworking.` 前缀：localStorage 是本机全局命名空间，与其它面板的键同名会互相覆盖。

/** 三个标签的稳定 id（顺序即展示顺序）。改这里必须同步 i18n 的 apps.tabAgent/tabDiagnose/tabCommands */
export const APPS_TABS = ['agent', 'diagnose', 'commands'] as const

export type AppsTab = (typeof APPS_TABS)[number]

/** 默认落点：**agent**（应用生成后用户要看的是"质检在跑 + 能直接下指令"，不是命令清单） */
export const DEFAULT_APPS_TAB: AppsTab = 'agent'

/**
 * 脏值归一：只接受三个合法 id 的**原样**，其余一律回落 agent。
 * 不做 trim / 大小写折叠——持久化层写进去的永远是本模块自己的常量，
 * 出现 `'Agent'` 只可能是外人写错，静默纠正反而掩盖问题；回落是明确的兜底语义。
 */
export function sanitizeAppsTab(v: unknown): AppsTab {
  return typeof v === 'string' && (APPS_TABS as readonly string[]).includes(v) ? (v as AppsTab) : DEFAULT_APPS_TAB
}

/** per-app 键：appId 相同恒得同一个键，不同应用互不覆盖 */
function keyOf(appId: string): string {
  return `yfworking.apps.tab.${(appId || '').trim()}`
}

/**
 * 取 localStorage。三条兜底都必要：
 *   · SSR / node --test 里 `localStorage` **未定义**（Node 24 要 `--experimental-webstorage` 才有）；
 *   · Electron 隐私模式/配额异常时读属性本身可能抛；
 *   · 拿到 null 时调用方只需"当作没有持久化"，不该崩。
 */
function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 读该应用上次停留的标签；缺键/脏值/读失败 ⇒ agent（绝不抛） */
export function readAppsTab(appId: string): AppsTab {
  const id = (appId || '').trim()
  if (!id) return DEFAULT_APPS_TAB
  try {
    return sanitizeAppsTab(store()?.getItem(keyOf(id)))
  } catch {
    return DEFAULT_APPS_TAB
  }
}

/**
 * 写该应用停留的标签，返回**实际生效**的值（已归一）。
 * 写失败（配额/隐私模式）只影响"下次进这个应用回到哪个标签"，不影响本次会话 ⇒ 静默吞掉。
 */
export function writeAppsTab(appId: string, tab: unknown): AppsTab {
  const safe = sanitizeAppsTab(tab)
  const id = (appId || '').trim()
  if (!id) return safe
  try {
    store()?.setItem(keyOf(id), safe)
  } catch { /* 写不进去不影响本次会话（内存里的 tab state 才是本帧真源） */ }
  return safe
}
