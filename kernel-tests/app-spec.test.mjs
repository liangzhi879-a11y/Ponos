// 应用智控：内核侧 Spec 读取 / 校验 / 可见性（纯函数，零 Electron 依赖）
// 说明：内核是独立进程，取工具时不能依赖 Electron，故这些逻辑放内核侧。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listApps,
  loadSpec,
  isAppVisible,
  validateSpec,
  getBoundApp,
  EXPOSE_MODES,
  MAX_COMMANDS_PER_APP,
} from '../kernel/app-spec.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'appspec-'))
  mkdirSync(join(root, 'app-a'), { recursive: true })
  writeFileSync(join(root, 'registry.json'), JSON.stringify({
    version: 1,
    apps: [{ id: 'app-a', name: '甲系统', targetType: 'web', enabled: true }],
  }), 'utf-8')
  writeFileSync(join(root, 'app-a', 'spec.json'), JSON.stringify({
    specVersion: 1, appId: 'app-a', name: '甲系统',
    target: { type: 'web', url: 'https://example.com' },
    expose: { mode: 'console' },
    commands: [{
      action: 'queryOrder', title: '查询订单', kind: 'read',
      params: [{ name: 'orderId', type: 'string', required: true, description: '订单号' }],
      steps: [{ act: 'goto', url: '/o' }],
    }],
  }), 'utf-8')
  return root
}

const withFixture = (fn) => {
  const root = fixture()
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('常量：expose 三态与命令上限', () => {
  assert.deepEqual(EXPOSE_MODES, ['private', 'console', 'public'])
  assert.equal(MAX_COMMANDS_PER_APP, 20)
})

test('listApps 读 registry.json 的 apps 数组', () => {
  withFixture((root) => {
    const apps = listApps({ roots: [root] })
    assert.equal(apps.length, 1)
    assert.equal(apps[0].id, 'app-a')
  })
})

test('listApps 容忍缺失/损坏的 registry.json（返回空数组不抛）', () => {
  assert.deepEqual(listApps({ roots: ['/definitely/not/exist'] }), [])
  assert.deepEqual(listApps({}), [])
  assert.deepEqual(listApps(), [])
})

test('loadSpec 读单应用 spec.json；不存在返回 null', () => {
  withFixture((root) => {
    assert.equal(loadSpec({ roots: [root], appId: 'app-a' }).appId, 'app-a')
    assert.equal(loadSpec({ roots: [root], appId: 'nope' }), null)
    assert.equal(loadSpec({ roots: [root] }), null)
  })
})

test('★ 可见性 console（默认）：仅当本会话绑定的就是本应用才可见', () => {
  withFixture((root) => {
    const spec = loadSpec({ roots: [root], appId: 'app-a' })
    assert.equal(isAppVisible(spec, { boundApp: null }), false, '未绑定应不可见')
    assert.equal(isAppVisible(spec, { boundApp: 'app-a' }), true, '绑定本应用应可见')
    assert.equal(isAppVisible(spec, { boundApp: 'app-other' }), false, '绑定别的应用应不可见')
  })
})

test('可见性 private 永不可见（即便已绑定）', () => {
  const spec = { appId: 'app-a', expose: { mode: 'private' }, commands: [] }
  assert.equal(isAppVisible(spec, { boundApp: 'app-a' }), false)
  assert.equal(isAppVisible(spec, { boundApp: null }), false)
})

test('可见性 public 始终可见', () => {
  const spec = { appId: 'app-a', expose: { mode: 'public' }, commands: [] }
  assert.equal(isAppVisible(spec, { boundApp: null }), true)
  assert.equal(isAppVisible(spec, { boundApp: 'app-other' }), true)
})

test('可见性：缺省 expose 等同 console', () => {
  const spec = { appId: 'app-a', commands: [] }
  assert.equal(isAppVisible(spec, { boundApp: null }), false)
  assert.equal(isAppVisible(spec, { boundApp: 'app-a' }), true)
})

test('可见性：未知 mode 一律不可见（fail-safe）', () => {
  const spec = { appId: 'app-a', expose: { mode: 'whatever' }, commands: [] }
  assert.equal(isAppVisible(spec, { boundApp: 'app-a' }), false)
})

test('可见性：spec 为空返回 false，不抛', () => {
  assert.equal(isAppVisible(null, { boundApp: 'x' }), false)
  assert.equal(isAppVisible(undefined, {}), false)
})

test('validateSpec 捕获结构非法', () => {
  assert.equal(validateSpec(null).ok, false)
  assert.equal(validateSpec([]).ok, false)
  assert.equal(validateSpec({}).ok, false)

  const bad = validateSpec({
    specVersion: 1, appId: 'x', name: 'x', target: { type: 'web' },
    commands: [{ action: 'a', kind: 'nope', steps: [] }],
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((e) => e.includes('kind')), `实际错误：${bad.errors}`)
})

test('validateSpec：target.type 仅允许 web / desktop', () => {
  const base = { specVersion: 1, appId: 'x', name: 'x', commands: [] }
  assert.equal(validateSpec({ ...base, target: { type: 'web' } }).ok, true)
  assert.equal(validateSpec({ ...base, target: { type: 'desktop' } }).ok, true)
  assert.equal(validateSpec({ ...base, target: { type: 'weird' } }).ok, false)
})

test('validateSpec：params 必须是数组（对齐 deriveInputSchema）', () => {
  const spec = {
    specVersion: 1, appId: 'x', name: 'x', target: { type: 'web' },
    commands: [{ action: 'a', kind: 'read', params: { orderId: 'string' }, steps: [{ act: 'goto' }] }],
  }
  const r = validateSpec(spec)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('params')), `实际错误：${r.errors}`)
})

test('validateSpec：action 重复被捕获', () => {
  const spec = {
    specVersion: 1, appId: 'x', name: 'x', target: { type: 'web' },
    commands: [
      { action: 'dup', kind: 'read', steps: [{ act: 'goto' }] },
      { action: 'dup', kind: 'read', steps: [{ act: 'goto' }] },
    ],
  }
  const r = validateSpec(spec)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('重复')))
})

test('validateSpec：命令数超上限被捕获', () => {
  const commands = Array.from({ length: MAX_COMMANDS_PER_APP + 1 }, (_, i) => (
    { action: `a${i}`, kind: 'read', steps: [{ act: 'goto' }] }
  ))
  const r = validateSpec({ specVersion: 1, appId: 'x', name: 'x', target: { type: 'web' }, commands })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('上限')))
})

test('validateSpec：缺 steps 被捕获', () => {
  const r = validateSpec({
    specVersion: 1, appId: 'x', name: 'x', target: { type: 'web' },
    commands: [{ action: 'a', kind: 'read' }],
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('steps')))
})

test('validateSpec 通过合法 Spec（含 params 数组）', () => {
  withFixture((root) => {
    const r = validateSpec(loadSpec({ roots: [root], appId: 'app-a' }))
    assert.equal(r.ok, true, `实际错误：${r.errors}`)
  })
})

test('getBoundApp 读 binding.json（严格单开）', () => {
  withFixture((root) => {
    writeFileSync(join(root, 'binding.json'), JSON.stringify({
      s1: { appId: 'app-a', boundAt: '2026-09-13T00:00:00.000Z' },
    }), 'utf-8')
    assert.equal(getBoundApp({ roots: [root], sessionId: 's1' }), 'app-a')
    assert.equal(getBoundApp({ roots: [root], sessionId: 's2' }), null)
    assert.equal(getBoundApp({ roots: [root], sessionId: null }), null)
    assert.equal(getBoundApp({ roots: [root] }), null)
  })
})

test('getBoundApp 容忍缺失/损坏的 binding.json', () => {
  withFixture((root) => {
    assert.equal(getBoundApp({ roots: [root], sessionId: 's1' }), null)
    writeFileSync(join(root, 'binding.json'), '{ 坏 JSON', 'utf-8')
    assert.equal(getBoundApp({ roots: [root], sessionId: 's1' }), null)
  })
})

test('多 root：首个命中优先', () => {
  const r1 = fixture()
  const r2 = fixture()
  try {
    assert.equal(listApps({ roots: [r1, r2] }).length, 2)
    assert.equal(loadSpec({ roots: [r2, r1], appId: 'app-a' }).appId, 'app-a')
  } finally {
    rmSync(r1, { recursive: true, force: true })
    rmSync(r2, { recursive: true, force: true })
  }
})
