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
