// Task 2.3：绑定生命周期语义（进入即接、离开即断、严格单开、竞态保护）
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const bind = require('../electron/app-bindings.cjs')

const mk = () => mkdtempSync(join(tmpdir(), 'applife-'))

test('进入 A → 绑定 A；切换到 B → 只剩 B（严格单开）', () => {
  const root = mk()
  try {
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), 'app-a')
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-b' })
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), 'app-b')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('离开 B 后无绑定（agent 侧工具消失）', () => {
  const root = mk()
  try {
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-b' })
    bind.unbindApp({ roots: [root], sessionId: 's1', appId: 'app-b' })
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('竞态：A 离开晚于 B 进入，不应清掉 B', () => {
  const root = mk()
  try {
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-b' })   // 用户已切到 B
    bind.unbindApp({ roots: [root], sessionId: 's1', appId: 'app-a' }) // A 的离开事件迟到
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), 'app-b', 'B 不应被误清')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('落盘格式与内核侧 getBoundApp 读取口径一致（{ sessionId: { appId, boundAt } }）', () => {
  const root = mk()
  try {
    bind.bindApp({ roots: [root], sessionId: 's9', appId: 'app-x' })
    const raw = JSON.parse(readFileSync(join(root, 'binding.json'), 'utf-8'))
    assert.equal(raw.s9.appId, 'app-x')
    assert.equal(typeof raw.s9.boundAt, 'string')
    assert.equal(Array.isArray(raw.s9), false, '值必须是对象而非数组（严格单开的物理保证）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('会话隔离：s1 的绑定不影响 s2', () => {
  const root = mk()
  try {
    bind.bindApp({ roots: [root], sessionId: 's1', appId: 'app-a' })
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's2' }), null)
    bind.bindApp({ roots: [root], sessionId: 's2', appId: 'app-b' })
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's1' }), 'app-a')
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: 's2' }), 'app-b')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('缺 sessionId → 读取返回 null、绑定抛错（不静默写脏数据）', () => {
  const root = mk()
  try {
    assert.equal(bind.getBoundApp({ roots: [root], sessionId: null }), null)
    assert.throws(() => bind.bindApp({ roots: [root], sessionId: '', appId: 'app-a' }))
    assert.equal(existsSync(join(root, 'binding.json')), false, '抛错不应留下半成品文件')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
