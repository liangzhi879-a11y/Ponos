// src/stores/uiStore.test.ts —— R2（2026-09-13）瞬时态写入成本的**行为**测试
// 运行：node --test src/stores/uiStore.test.ts（Node 24 原生 TS）
//
// 测的是**缺陷**而不是返回值：
//   `[WS] recv: event … assistant` 帧（实测 13–45 帧/秒）每来一帧就调一次
//   `clearKernelStall` + `clearFirstByteWait`（useYFWCLI.ts:883-884）。旧实现里这两条
//   即使无键可删也走 `set(s => ({}))` —— 而 zustand persist 把 `set` 包成**无条件**
//   `setItem`（middleware.js:500-511），于是每帧白付一次 partialize + JSON.stringify +
//   localStorage 同步写，并且**换掉 state 引用** ⇒ 整店订阅者白重建（R2×R3 的叠加效应）。
//
// 假 localStorage 必须在 import uiStore **之前**装好：`createJSONStorage` 在模块求值时
// 就会调 `getStorage()` 并把结果捕获下来（middleware.js:281-286）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const writes: string[] = []
const mem = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { writes.push(v); mem.set(k, v) },
  removeItem: (k: string) => { mem.delete(k) },
}

const { useUIStore } = await import('./uiStore.ts')
await new Promise((r) => setImmediate(r)) // 等 persist 水合落定（水合本身不写盘）

const st = () => useUIStore.getState()

// 稳定态基线：先造两次真·持久化变化（来回切侧栏 = 内容还原成初始值），把"盘上已有
// 当前负载"这一正常用户状态建好。冷启动那一次写入的合理性由 stableStorage.test.ts 覆盖，
// 这里只测稳定态——那才是流式期每帧发生的事。
st().toggleSidebar()
st().toggleSidebar()
writes.length = 0

test('R2：清空不存在的瞬时态是零成本空操作（不换引用、不落 localStorage）', () => {
  const before = st()
  for (let i = 0; i < 100; i++) {
    st().clearKernelStall('conv-ghost')   // 逐帧路径的真实调用形状
    st().clearFirstByteWait('conv-ghost')
  }
  assert.equal(st(), before, 'state 引用必须逐次不变 ⇒ 订阅者不重建')
  assert.deepEqual(writes, [], '不得有任何 localStorage 写入')
})

test('R2：只在白名单外的键变化 ⇒ 换引用但**不**落 localStorage', () => {
  const before = st()
  st().setKernelStall('conv-a', 5000)
  assert.notEqual(st(), before, '真变化必须换引用，否则等待条不会更新')
  assert.equal(st().kernelStalls['conv-a'], 5000)
  assert.deepEqual(writes, [], '持久化子集逐字节未变 ⇒ 不该写')
})

test('R2：同值重复置位是空操作（倒计时重挂/重放帧）', () => {
  st().setKernelStall('conv-b', 111)
  st().setFirstByteWait('conv-b', 222)
  const before = st()
  st().setKernelStall('conv-b', 111)
  st().setFirstByteWait('conv-b', 222)
  assert.equal(st(), before, '两条同值置位都必须无动作')
  assert.deepEqual(writes, [])
})

test('R2：守卫不得过度拦截——不同值照常生效，删除照常生效', () => {
  const before = st()
  st().setKernelStall('conv-c', 6000)
  assert.notEqual(st(), before)
  assert.equal(st().kernelStalls['conv-c'], 6000, '新值必须写进 state')
  const mid = st()
  st().clearKernelStall('conv-c')
  assert.notEqual(st(), mid, '有键可删时必须换引用')
  assert.equal('conv-c' in st().kernelStalls, false, '键必须真的删掉')
  const after = st()
  st().clearKernelStall('conv-c')
  assert.equal(st(), after, '再删一次无动作')
})

test('R2：白名单内的键变化照写一次，负载仍是 {state,version} 且不含瞬时态', () => {
  st().toggleSidebar()
  assert.equal(writes.length, 1, '白名单变化必须落盘一次（去重不得误吞真变化）')
  const payload = JSON.parse(writes[0]) as { state: Record<string, unknown>; version?: number }
  assert.equal(typeof payload.state.sidebarOpen, 'boolean')
  assert.equal('kernelStalls' in payload.state, false, '瞬时态不得进持久化负载')
  assert.equal('firstByteWait' in payload.state, false)
  assert.equal('openFiles' in payload.state, false, '编辑器内容也不进（它才是逐键写入的大头）')
  st().toggleSidebar()
  assert.equal(writes.length, 2, '再切回来是另一次真变化 ⇒ 另写一次')
})

test('R2：去重不破坏回读（盘上就是最后一次写入的字节，且原样可解析）', () => {
  const last = writes[writes.length - 1]
  assert.equal(mem.get('yfworking-ui'), last)
  const back = JSON.parse(mem.get('yfworking-ui')!) as { state: { sidebarOpen: boolean } }
  assert.equal(back.state.sidebarOpen, st().sidebarOpen)
})
