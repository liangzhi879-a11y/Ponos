import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProcessOrchestrator } from './process-orchestrator.cjs'
import { createStateBus } from '../../../electron/state-bus.cjs'

function fakeWin(bus) {
  const w = {
    destroyed: false, minimized: false, shown: false, bounds: { x: 0, y: 0, w: 900, h: 700 },
    listeners: {},
    isDestroyed() { return this.destroyed },
    isMinimized() { return this.minimized },
    restore() { this.minimized = false },
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
  chat: { id: 'chat', singleton: false, windowSpec: { width: 900, height: 700, minWidth: 600, minHeight: 400 } },
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
