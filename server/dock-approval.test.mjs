import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDockService } from '../electron/dock-service.cjs'
import { createApprovalCenter } from '../electron/approval-center.cjs'

// --- DockService ---

function fakeScreen() {
  return {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 1915, y: 500 }),  // 靠近右缘 → 触发滑出
  }
}

function fakeWin() {
  const handlers = {}
  const win = {
    destroyed: false,
    bounds: { x: 0, y: 0, width: 64, height: 1080 },
    setBounds: (b) => { win.bounds = { ...b } },
    getBounds: () => win.bounds,
    setAlwaysOnTop: () => {},
    setResizable: () => {},
    isDestroyed: () => win.destroyed,
    on: (ev, fn) => { handlers[ev] = fn },
  }
  return { win, handlers }
}

test('DockService attach 贴右缘 + 启动轮询（鼠标靠近右缘滑出）', () => {
  const dock = createDockService({ screen: fakeScreen() })
  const { win } = fakeWin()
  dock.attach(win)
  assert.equal(dock.isDocked(), true)
  // attach 后 bounds 贴右缘（x = 1920-64 = 1856）
  assert.equal(win.bounds.x, 1856)
  assert.equal(win.bounds.width, 64)
  dock.stopWatch()
})

test('DockService moved 拖离右缘 → 解除吸附（悬浮模式）', () => {
  const dock = createDockService({ screen: fakeScreen() })
  const { win, handlers } = fakeWin()
  dock.attach(win)
  assert.equal(dock.isDocked(), true)
  // 拖离：窗口移到屏幕中间（右缘距离远超 SNAP=60）
  win.bounds = { x: 800, y: 100, width: 64, height: 480 }
  handlers.moved()
  assert.equal(dock.isDocked(), false)
  dock.detach()
})

test('DockService moved 拖到右缘附近 → 自动吸附回贴', () => {
  const dock = createDockService({ screen: fakeScreen() })
  const { win, handlers } = fakeWin()
  dock.attach(win)
  // 先拖离（悬浮）
  win.bounds = { x: 800, y: 100, width: 64, height: 480 }
  handlers.moved()
  assert.equal(dock.isDocked(), false)
  // 拖到右缘附近（右缘距离 = 1920-(1850+64) = 6 ≤ SNAP=60）
  win.bounds = { x: 1850, y: 100, width: 64, height: 480 }
  handlers.moved()
  assert.equal(dock.isDocked(), true)
  // 自动吸附后贴回右缘（x = 1920-64 = 1856）
  assert.equal(win.bounds.x, 1856)
  dock.detach()
})

test('DockService detach 清理状态', () => {
  const dock = createDockService({ screen: fakeScreen() })
  const { win } = fakeWin()
  dock.attach(win)
  dock.detach()
  assert.equal(dock.isDocked(), false)
})

// --- ApprovalCenter ---

function fakeWM() {
  const opened = []
  return {
    opened,
    open: (id) => { opened.push(id); return { ok: true } },
  }
}

test('ApprovalCenter pending 入队并打开审批窗口，重复 pending 去重', () => {
  const wm = fakeWM()
  const center = createApprovalCenter({ windowManager: wm, bus: {} })
  center.handleEvent({ channel: 'approval', action: 'pending', payload: { conversationId: 'c1', toolUseId: 't1' } })
  center.handleEvent({ channel: 'approval', action: 'pending', payload: { conversationId: 'c1', toolUseId: 't1' } })  // 重复
  assert.equal(center.pendingCount(), 1)
  assert.deepEqual(wm.opened, ['approval'])
})

test('ApprovalCenter resolved 出队', () => {
  const wm = fakeWM()
  const center = createApprovalCenter({ windowManager: wm, bus: {} })
  center.handleEvent({ channel: 'approval', action: 'pending', payload: { conversationId: 'c1', toolUseId: 't1' } })
  assert.equal(center.pendingCount(), 1)
  center.handleEvent({ channel: 'approval', action: 'resolved', payload: { conversationId: 'c1', toolUseId: 't1' } })
  assert.equal(center.pendingCount(), 0)
})

test('ApprovalCenter 非 approval 事件忽略', () => {
  const wm = fakeWM()
  const center = createApprovalCenter({ windowManager: wm, bus: {} })
  center.handleEvent({ channel: 'task', action: 'pending', payload: {} })
  assert.equal(center.pendingCount(), 0)
  assert.deepEqual(wm.opened, [])
})
