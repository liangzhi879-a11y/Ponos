/**
 * 状态总线（纯逻辑，不依赖 electron，可单测）。
 * 渲染层窗口 publish 事件 → 主进程按 channel 广播给订阅者 + 写快照环形缓冲。
 * target 为 duck-typed webContents：只需 { send(channel, data) }。
 */
'use strict'

const SNAPSHOT_SIZE = 50

function createStateBus({ snapshotSize = SNAPSHOT_SIZE } = {}) {
  /** Map<channel, Set<target>> */
  const subscriptions = new Map()
  /** Map<channel, BusEvent[]> 环形缓冲（push 超量 shift） */
  const snapshots = new Map()

  function isValidEvent(e) {
    return !!(
      e && typeof e === 'object' &&
      typeof e.channel === 'string' && e.channel.length > 0 &&
      typeof e.action === 'string' && e.action.length > 0 &&
      typeof e.from === 'string' && e.from.length > 0
    )
  }

  function subscribe(channel, target) {
    if (!subscriptions.has(channel)) subscriptions.set(channel, new Set())
    subscriptions.get(channel).add(target)
  }

  function unsubscribe(channel, target) {
    subscriptions.get(channel)?.delete(target)
  }

  function detach(target) {
    for (const set of subscriptions.values()) set.delete(target)
  }

  function publish(event) {
    if (!isValidEvent(event)) return
    const ts = typeof event.ts === 'number' ? event.ts : Date.now()
    const full = { ...event, ts }
    // 快照环形缓冲
    const arr = snapshots.get(full.channel) || []
    arr.push(full)
    if (arr.length > snapshotSize) arr.splice(0, arr.length - snapshotSize)
    snapshots.set(full.channel, arr)
    // 广播
    const set = subscriptions.get(full.channel)
    if (!set) return
    for (const target of set) {
      try { target.send(`bus:event:${full.channel}`, full) } catch { /* 窗口销毁，忽略 */ }
    }
  }

  function getSnapshot(channel) {
    return [...(snapshots.get(channel) || [])]
  }

  return { subscribe, unsubscribe, detach, publish, getSnapshot }
}

module.exports = { createStateBus }
