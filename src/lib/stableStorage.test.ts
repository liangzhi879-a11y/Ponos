// src/lib/stableStorage.test.ts —— R2 去重层的边界用例（纯逻辑，无 zustand、无 DOM）
// 运行：node --test src/lib/stableStorage.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PersistStorage } from 'zustand/middleware'
import { createStableStorage } from './stableStorage.ts'

// 计数版假 storage（模拟 localStorage：字符串进出）
function fakeStorage(seed: Record<string, string> = {}) {
  const mem = new Map<string, string>(Object.entries(seed))
  const calls = { getItem: 0, setItem: 0, removeItem: 0 }
  const base = {
    getItem: (name: string) => { calls.getItem++; const v = mem.get(name); return v === undefined ? null : JSON.parse(v) },
    setItem: (name: string, value: unknown) => {
      calls.setItem++
      // 真实 localStorage 能收任何值（它自己 stringify 失败会抛，但那是它的事）；
      // 这里只要**记下调用发生了**，不该因为替身自己的 stringify 而炸
      try { mem.set(name, JSON.stringify(value)) } catch { mem.set(name, '<unserializable>') }
    },
    removeItem: (name: string) => { calls.removeItem++; mem.delete(name) },
  } as unknown as PersistStorage<unknown>
  return { base, calls, mem, raw: (n: string) => mem.get(n) }
}

const payload = (state: Record<string, unknown>) => ({ state, version: 0 })

test('stableStorage：逐字节相同的负载不再落盘', () => {
  const { base, calls } = fakeStorage()
  const s = createStableStorage(base)!
  s.setItem('k', payload({ a: 1 }))
  assert.equal(calls.setItem, 1, '首次必须写（盘上本来就没有）')
  s.setItem('k', payload({ a: 1 }))
  s.setItem('k', payload({ a: 1 }))
  assert.equal(calls.setItem, 1, '同字节的后续写入被挡掉')
  s.setItem('k', payload({ a: 2 }))
  assert.equal(calls.setItem, 2, '真变化必须写')
})

test('stableStorage：冷启动先看盘上字节——上次会话存过同样的负载就不写', () => {
  const seed = { k: JSON.stringify(payload({ a: 1 })) }
  const { base, calls } = fakeStorage(seed)
  const s = createStableStorage(base)!
  s.setItem('k', payload({ a: 1 }))
  assert.equal(calls.getItem, 1, '首次写之前要读一次基线')
  assert.equal(calls.setItem, 0, '盘上已有同样字节 ⇒ 一次都不写')
  s.setItem('k', payload({ a: 2 }))
  assert.equal(calls.setItem, 1, '与基线不同 ⇒ 写')
})

test('stableStorage：按 name 分别记基线（多键互不串味）', () => {
  const { base, calls } = fakeStorage()
  const s = createStableStorage(base)!
  s.setItem('a', payload({ v: 1 }))
  s.setItem('b', payload({ v: 1 }))
  assert.equal(calls.setItem, 2)
  s.setItem('a', payload({ v: 1 }))
  s.setItem('b', payload({ v: 1 }))
  assert.equal(calls.setItem, 2, '两个键各自的基线独立生效')
})

test('stableStorage：removeItem 清基线（删后写同样的值必须真的写回去）', () => {
  const { base, calls, raw } = fakeStorage()
  const s = createStableStorage(base)!
  s.setItem('k', payload({ a: 1 }))
  s.removeItem('k')
  assert.equal(calls.removeItem, 1)
  assert.equal(raw('k'), undefined)
  s.setItem('k', payload({ a: 1 }))
  assert.equal(calls.setItem, 2, '删掉之后同样的值是一次真写入（否则数据永远回不来）')
  assert.notEqual(raw('k'), undefined)
})

test('stableStorage：序列化失败退回底层直写（本层不改变原有行为）', () => {
  const { base, calls } = fakeStorage()
  const s = createStableStorage(base)!
  const circular: Record<string, unknown> = {}
  circular.self = circular
  s.setItem('k', circular as unknown as { state: unknown; version?: number })
  assert.equal(calls.setItem, 1, '抛错也必须落到盘上（由底层自己吞）')
})

test('stableStorage：base 缺失时返回 undefined（不假装可用）', () => {
  assert.equal(createStableStorage(undefined), undefined)
  assert.equal(createStableStorage(null), undefined)
})
