import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampBounds, createWindowManager } from '../electron/window-manager.cjs'

const SPEC = { width: 900, height: 700, minWidth: 600, minHeight: 400 }
const WA = { x: 0, y: 0, width: 1920, height: 1080 }

test('clampBounds 缺失/越界值回落默认，且受 min/max 约束', () => {
  assert.deepEqual(clampBounds({}, SPEC, WA), { x: 660, y: 190, w: 900, h: 700 })
  // 越界宽高 → 夹到 workArea 内
  const out = clampBounds({ x: 0, y: 0, w: 5000, h: 5000 }, SPEC, WA)
  assert.equal(out.w, 1920)
  assert.equal(out.h, 1080)
  // 小于 min → 提升到 min
  const small = clampBounds({ x: 0, y: 0, w: 100, h: 100 }, SPEC, WA)
  assert.equal(small.w, 600)
  assert.equal(small.h, 400)
  // 负坐标 → 拉回 0
  assert.ok(clampBounds({ x: -50, y: -50, w: 800, h: 600 }, SPEC, WA).x >= 0)
})

function makeWindowManager() {
  let seq = 0
  const bus = { publish() {} }
  const wins = new Map()
  const wm = createWindowManager({
    // 未知模块返回 undefined，使 open('nope') 能走到 unknown module 分支（brief 原版 fake 恒返回对象，无法触发）
    getModule: (id) => (id === 'nope' ? undefined : { id, windowSpec: SPEC, singleton: id !== 'chat', name: id }),
    bus,
    createWindow: (id, params) => {
      seq += 1
      const fake = {
        id: `win-${seq}`, destroyed: false,
        isDestroyed: () => fake.destroyed,
        getBounds: () => ({ x: 0, y: 0, w: 900, h: 700 }),
        setBounds: () => {},
        loadURL: () => {}, show: () => {}, focus: () => {}, restore: () => {},
        isMinimized: () => false, on: () => {},
        close: () => { fake.destroyed = true },
      }
      wins.set(`win-${seq}`, fake)
      return fake
    },
    onClosed: (winId) => wins.delete(winId),
  })
  return { wm, wins }
}

test('open 创建窗口并返回 windowId；singleton 复用不重复创建', () => {
  const { wm, wins } = makeWindowManager()
  const r1 = wm.open('files')
  assert.equal(r1.ok, true)
  assert.equal(wins.size, 1)
  const r2 = wm.open('files')
  assert.equal(r2.ok, true)
  assert.equal(r2.reused, true)
  assert.equal(wins.size, 1)
})

test('open 非 singleton（chat）可多开', () => {
  const { wm, wins } = makeWindowManager()
  wm.open('chat', { conversation: 'c1' })
  wm.open('chat', { conversation: 'c2' })
  assert.equal(wins.size, 2)
})

test('close 关闭窗口并从注册表移除', () => {
  const { wm, wins } = makeWindowManager()
  const r = wm.open('files')
  const winId = r.windowId
  wm.close('files')
  assert.equal(wins.has(winId), false)
})

test('open 未知模块返回 error', () => {
  const { wm } = makeWindowManager()
  const r = wm.open('nope')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /unknown module/)
})
