import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProcessOrchestrator } from './process-orchestrator.cjs'
import { createStateBus } from '../../../electron/state-bus.cjs'

function fakeWin(bus) {
  const w = {
    destroyed: false, minimized: false, maximized: false, shown: false, bounds: { x: 0, y: 0, w: 900, h: 700 },
    listeners: {},
    isDestroyed() { return this.destroyed },
    isMinimized() { return this.minimized },
    minimize() { this.minimized = true },
    restore() { this.minimized = false },
    isMaximized() { return this.maximized },
    maximize() { this.maximized = true },
    unmaximize() { this.maximized = false },
    show() { this.shown = true },
    focus() {},
    getBounds() { return this.bounds },
    setBounds(b) { this.bounds = b },
    close() { this.destroyed = true },
    destroy() { this.destroyed = true; this.emit('closed') },
    on(ev, cb) { (this.listeners[ev] ||= []).push(cb) },
    emit(ev, ...args) { (this.listeners[ev] || []).forEach(cb => cb(...args)) },
  }
  return w
}

const MODS = {
  chat: { id: 'chat', name: '聊天', singleton: false, windowSpec: { width: 900, height: 700, minWidth: 600, minHeight: 400 } },
  state: { id: 'state', runtime: 'node-worker', singleton: true },
  settings: { id: 'settings', name: '设置', runtime: 'ui-renderer', singleton: false, windowSpec: { width: 720, height: 560, minWidth: 480, minHeight: 400 } },
}

test('open/close/typeOf 与旧 window-manager 语义一致', () => {
  const bus = createStateBus()
  const created = []
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id],
    bus,
    createWindow: (mod, params) => { const w = fakeWin(bus); created.push(w); return w },
    onClosed: () => {},
    hooks: {},
  })
  const r = orch.open('chat', { conversation: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.windowId, 'chat::s1')
  assert.equal(orch.typeOf('chat'), 'module')
  assert.equal(created.length, 1)
  orch.close('chat', { conversation: 's1' })
  assert.equal(created[0].destroyed, true)
})

test('render-process-gone 触发 crashReboot 重建同 key 窗口', async () => {
  const bus = createStateBus()
  let winCount = 0
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id],
    bus,
    createWindow: (mod, params) => {
      winCount++
      return fakeWin(bus)
    },
    onClosed: () => {},
    hooks: {},
  })
  orch.open('chat', { conversation: 's1' })
  const first = orch.getByParams('chat', { conversation: 's1' })
  assert.ok(first)
  first.emit('render-process-gone', {}, { reason: 'crashed' })
  await new Promise(r => setTimeout(r, 700))
  const rebooted = orch.getByParams('chat', { conversation: 's1' })
  assert.ok(rebooted, '重建后的窗口应可查')
  assert.equal(winCount, 2)
})

test('崩溃延迟窗口期内手动 open 同 key → 到期不重复重建', async () => {
  const bus = createStateBus()
  let winCount = 0
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id],
    bus,
    createWindow: (mod, params) => {
      winCount++
      return fakeWin(bus)
    },
    onClosed: () => {},
    hooks: {},
  })
  orch.open('chat', { conversation: 's1' })
  const first = orch.getByParams('chat', { conversation: 's1' })
  assert.ok(first)

  // 崩溃 → 进入 500ms 延迟重建窗口期
  first.emit('render-process-gone', {}, { reason: 'crashed' })

  // 延迟窗口期内：宿主手动重建同 key（销毁崩溃窗口后 open，映射被替换为新窗口）
  first.destroy()
  const manual = orch.open('chat', { conversation: 's1' })
  assert.equal(manual.ok, true)
  assert.equal(winCount, 2, '手动重建应创建新窗口')
  const manualWin = orch.getByParams('chat', { conversation: 's1' })
  assert.notEqual(manualWin, first, '映射应指向手动重建的新窗口')

  // 延迟到期：映射已被替换 → 跳过重建（winCount 不变），手动窗口映射不被误删
  await new Promise(r => setTimeout(r, 700))
  assert.equal(winCount, 2, '延迟到期后不应重复重建')
  assert.equal(orch.getByParams('chat', { conversation: 's1' }), manualWin, '手动重建窗口的映射不应被 destroy 清理误删')
  assert.equal(manualWin.destroyed, false, '手动重建窗口不应被销毁')
  const restarted = bus.getSnapshot('module').filter(e => e.action === 'restarted')
  assert.equal(restarted.length, 0, '映射已被替换 → 不应再发布 restarted 重建事件')
})

test('崩溃延迟窗口期内旧窗口自毁 → 到期仍正常重建并发布 restarted', async () => {
  const bus = createStateBus()
  let winCount = 0
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id],
    bus,
    createWindow: (mod, params) => {
      winCount++
      return fakeWin(bus)
    },
    onClosed: () => {},
    hooks: {},
  })
  orch.open('chat', { conversation: 's1' })
  const first = orch.getByParams('chat', { conversation: 's1' })
  assert.ok(first)

  // 崩溃 → 进入 500ms 延迟重建窗口期
  first.emit('render-process-gone', {}, { reason: 'crashed' })

  // 延迟窗口期内：旧窗口自毁（emit closed + destroyed=true）→ closed 清理已删除映射
  first.destroy()
  assert.equal(orch.getByParams('chat', { conversation: 's1' }), null, '自毁后映射应已被清理')

  // 延迟到期：映射不存在（cur === undefined）→ 应正常重建，不得静默跳过
  await new Promise(r => setTimeout(r, 700))
  assert.equal(winCount, 2, '自毁路径应正常重建（winCount 增加）')
  const rebooted = orch.getByParams('chat', { conversation: 's1' })
  assert.ok(rebooted, '重建后的窗口应可查')
  assert.notEqual(rebooted, first, '重建窗口应为新窗口（非已自毁旧窗口）')
  const restarted = bus.getSnapshot('module').filter(e => e.action === 'restarted')
  assert.equal(restarted.length, 1, '应发布一次 restarted 重建事件')
  assert.equal(restarted[0].payload.windowId, 'chat::s1')
})

test('崩溃重建路径：旧窗 closed 异步迟到 → 实例守卫不清 successor 映射', async () => {
  const bus = createStateBus()
  let winCount = 0
  const closedKeys = []
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id],
    bus,
    createWindow: (mod, params) => {
      winCount++
      // 专用 fakeWin：destroy 延迟发射 closed（模拟真实 Electron 时序不定：destroy 后
      // 'closed' 可能在 successor 已重建同 key 之后才异步触发）
      const w = fakeWin(bus)
      w.destroy = function () { this.destroyed = true; queueMicrotask(() => this.emit('closed')) }
      return w
    },
    onClosed: key => closedKeys.push(key),
    hooks: {},
  })
  orch.open('chat', { conversation: 's1' })
  const first = orch.getByParams('chat', { conversation: 's1' })
  assert.ok(first)

  // 崩溃 → 500ms 延迟重建：到期时 orchestrator 先 destroy 旧窗（closed 异步未发），
  // 随即 open 重建同 key successor（映射已指向 successor）→ 微任务才执行旧窗迟到 closed
  first.emit('render-process-gone', {}, { reason: 'crashed' })
  await new Promise(r => setTimeout(r, 700))

  assert.equal(winCount, 2, '崩溃路径应重建 successor')
  const cur = orch.getByParams('chat', { conversation: 's1' })
  assert.ok(cur, 'successor 映射不应被迟到 closed 清掉')
  assert.notEqual(cur, first, '查询应返回 successor 而非已销毁旧窗')
  assert.equal(cur.destroyed, false, 'successor 不应被误销毁')
  assert.equal(orch.listWindows().length, 1, '映射应仅剩 successor 一条')
  assert.equal(closedKeys.length, 0, '迟到 closed 不应触发 onClosed（否则主进程 mr.detach 断流）')
  const restarted = bus.getSnapshot('module').filter(e => e.action === 'restarted')
  assert.equal(restarted.length, 1, '应发布一次 restarted 重建事件')
  assert.equal(restarted[0].payload.windowId, 'chat::s1')
})

function fakeWorker() {
  const listeners = {}
  return {
    on(ev, cb) { (listeners[ev] ||= []).push(cb) },
    emit(ev, ...a) { (listeners[ev] || []).forEach(cb => cb(...a)) },
    postMessage() {}, terminate() { this.terminated = true },
  }
}

test('startWorker 创建 worker、发布 started、重复启动报 ALREADY_RUNNING', () => {
  const bus = createStateBus()
  const created = []
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus, createWindow: () => fakeWin(bus),
    createWorker: mod => { const w = fakeWorker(); created.push(w); return w },
    onClosed: () => {}, hooks: {},
  })
  const r = orch.startWorker('state')
  assert.equal(r.ok, true)
  assert.equal(created.length, 1)
  assert.equal(orch.startWorker('state').error, 'ALREADY_RUNNING')
  assert.equal(bus.getSnapshot('worker').filter(e => e.action === 'started').length, 1)
})

test('worker 崩溃 → 500ms 延迟 respawn 并发布 restarted', async () => {
  const bus = createStateBus()
  let n = 0
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus, createWindow: () => fakeWin(bus),
    createWorker: () => { n++; return fakeWorker() },
    onClosed: () => {}, hooks: {},
  })
  orch.startWorker('state')
  const first = orch.getWorker('state')
  first.emit('error', new Error('boom'))
  await new Promise(r => setTimeout(r, 700))
  assert.equal(n, 2)
  assert.ok(orch.getWorker('state'))
  assert.notEqual(orch.getWorker('state'), first)
  assert.equal(bus.getSnapshot('worker').filter(e => e.action === 'restarted').length, 1)
})

test('worker error→exit 真实序列：exit 先清理映射，respawn 仍发生', async () => {
  const bus = createStateBus()
  let n = 0
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus, createWindow: () => fakeWin(bus),
    createWorker: () => { n++; return fakeWorker() },
    onClosed: () => {}, hooks: {},
  })
  orch.startWorker('state')
  const first = orch.getWorker('state')
  first.emit('error', new Error('boom'))   // 先 error（排程 respawn）
  first.emit('exit')                        // 后 exit（真实序列：映射先被清理）
  await new Promise(r => setTimeout(r, 700))
  assert.equal(n, 2, 'error 后 exit 清理映射，respawn 应仍发生')
  assert.ok(orch.getWorker('state'))
  assert.notEqual(orch.getWorker('state'), first)
  assert.equal(bus.getSnapshot('worker').filter(e => e.action === 'restarted').length, 1)
})

test('worker exit → 清理映射并触发 onWorkerExit；ui-renderer 模块不可 startWorker', () => {
  const bus = createStateBus()
  const exited = []
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus, createWindow: () => fakeWin(bus),
    createWorker: () => fakeWorker(),
    onClosed: () => {}, onWorkerExit: id => exited.push(id), hooks: {},
  })
  orch.startWorker('state')
  const w = orch.getWorker('state')
  w.emit('exit')
  assert.equal(orch.getWorker('state'), null)
  assert.deepEqual(exited, ['state'])
  assert.equal(orch.startWorker('settings').error, 'not a node-worker module')
})

test('minimize/maximize/contextByKey 按 key 定位窗口操作', () => {
  const bus = createStateBus()
  const created = []
  const orch = createProcessOrchestrator({
    getModule: id => MODS[id], bus,
    createWindow: (mod, params) => { const w = fakeWin(bus); w.key = orch.keyOf(mod.id, params); created.push(w); return w },
    onClosed: () => {}, hooks: {},
  })
  orch.open('chat', { conversation: 's1' })
  const win = created[0]
  assert.equal(orch.minimize('chat::s1').ok, true)
  assert.equal(win.minimized, true)
  assert.equal(orch.maximize('chat::s1').ok, true)
  const ctx = orch.context('chat::s1')
  assert.equal(ctx.ok, true)
  assert.equal(ctx.result.name, '聊天')
  assert.deepEqual(ctx.result.conversations, ['s1'])
  assert.equal(ctx.result.current, 's1')
  assert.equal(orch.minimize('chat::nope').ok, false)
})
