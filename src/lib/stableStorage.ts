import type { PersistStorage } from 'zustand/middleware'

/**
 * 给 persist 的 storage 加一层「字节没变就不写」闸门（R2，2026-09-13）。
 *
 * 为什么需要：`zustand@4.5.7/middleware.js:500-511` 里 `set` 被包成
 * `config(() => { set(...); void setItem() })` —— **无条件**落盘，与 updater 返回什么
 * 毫无关系。而落盘 = `partialize(get())` + `JSON.stringify` + `storage.setItem`
 * （默认 localStorage，同步）。于是两类代价本不该发生却每帧都在发生：
 *   1. 只改了**不参与持久化**的键（`openFiles[*].content`、`previewFile`、
 *      `pendingAttachments`、`kernelStalls`、`firstByteWait`…）→ 序列化结果逐字节相同，
 *      却仍然走一遍 stringify + localStorage 同步写；
 *   2. 「删空键」这类空操作返回 `{}`，看起来像短路，其实**不是**：既照写 localStorage，
 *      又换掉 state 对象引用 → 订阅者（`useUIStore()` 整店订阅）白重建一次。
 *   ⇒ 这一类在流式期是**每帧 2 次**（`useYFWCLI.ts:883-884` 对每个 event 帧都清一次），
 *      实测刷屏的正是同一批 `[WS] recv: event … assistant` 帧（13–45 帧/秒）。
 *
 * 只做**去重**、不做防抖：uiStore 的持久化子集很小，且剩余写入都是人手速率（切栏、
 * 拖宽、置顶技能）。防抖会引入"窗口内未落盘"的丢失面（chatStore 为此不得不挂
 * beforeunload + visibilitychange 冲刷），去重没有这个代价。
 *
 * 语义边界（刻意保留）：
 * - `getItem`/`removeItem` 原样透传；`removeItem` 同时清掉去重缓存，避免"删了又写同样的值"
 *   被误判成重复。
 * - 真·写入失败（配额/隐私模式）由底层 storage 自己吞（`createJSONStorage` 的既有语义）。
 * - 序列化失败时**退回原值直写**，不因为这一层而改变行为。
 *
 * 冷启动：去重缓存是**惰性**从盘上取的——第一次写之前先 `getItem` 看一眼现在的字节。
 * 于是「上次会话已存过同样的负载」这一次也能免掉（正常用户每次启动都处在这个状态）；
 * 盘上确实什么都没有时照写一次，那本来就是真实变化，不是浪费。
 */
export function createStableStorage<T>(
  base: PersistStorage<T> | undefined | null,
): PersistStorage<T> | undefined {
  if (!base) return undefined
  const lastByKey = new Map<string, string>()
  return {
    getItem: (name) => base.getItem(name),
    setItem: (name, value) => {
      let text: string
      try {
        text = JSON.stringify(value)
      } catch {
        return base.setItem(name, value)  // 序列化失败：交回底层，行为与本层引入前一致
      }
      if (!lastByKey.has(name)) {
        try {
          const onDisk = base.getItem(name)
          // 异步 storage（IndexedDB 之类）这里拿到 Promise——本层只服务同步 localStorage，
          // 遇到就退化成"没有基线"，即只做同会话内的去重
          if (!(onDisk instanceof Promise)) lastByKey.set(name, JSON.stringify(onDisk ?? null))
        } catch { /* 读不到就当盘上还没有 */ }
      }
      if (lastByKey.get(name) === text) return undefined
      lastByKey.set(name, text)
      return base.setItem(name, value)
    },
    removeItem: (name) => {
      lastByKey.delete(name)
      return base.removeItem(name)
    },
  }
}
