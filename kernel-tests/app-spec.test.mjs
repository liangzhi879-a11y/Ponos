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

/** 造 root；overrides 用于让不同 root 的 spec 内容可区分（验证"首个命中优先"必须内容不同） */
function fixture(overrides = {}) {
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
    ...overrides,
  }), 'utf-8')
  return root
}

const withFixture = (fn) => {
  const root = fixture()
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

const withTwo = (fn) => {
  const r1 = fixture({ desc: '来自-ROOT1' })
  const r2 = fixture({ desc: '来自-ROOT2' })
  try { return fn(r1, r2) } finally {
    rmSync(r1, { recursive: true, force: true })
    rmSync(r2, { recursive: true, force: true })
  }
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

test('listApps 容忍缺失的 registry.json（返回空数组不抛）', () => {
  assert.deepEqual(listApps({ roots: ['/definitely/not/exist'] }), [])
  assert.deepEqual(listApps({}), [])
  assert.deepEqual(listApps(), [])
})

test('listApps 容忍损坏的 registry.json（坏 JSON → 空数组，不抛）', () => {
  withFixture((root) => {
    writeFileSync(join(root, 'registry.json'), '{ 这不是 JSON', 'utf-8')
    assert.deepEqual(listApps({ roots: [root] }), [])
  })
})

test('listApps 跨 root 按 id 去重（与 loadSpec 首命中的口径一致）', () => {
  withTwo((r1, r2) => {
    assert.equal(listApps({ roots: [r1, r2] }).length, 1, '同一 id 不应产出两份')
  })
})

test('listApps 兼容裸数组形状的 registry.json', () => {
  withFixture((root) => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify([{ id: 'app-a', name: '甲' }]), 'utf-8')
    assert.equal(listApps({ roots: [root] }).length, 1)
  })
})

test('loadSpec 读单应用 spec.json；不存在返回 null', () => {
  withFixture((root) => {
    assert.equal(loadSpec({ roots: [root], appId: 'app-a' }).appId, 'app-a')
    assert.equal(loadSpec({ roots: [root], appId: 'nope' }), null)
    assert.equal(loadSpec({ roots: [root] }), null)
  })
})

test('loadSpec 容忍损坏的 spec.json（坏 JSON → null，不抛）', () => {
  withFixture((root) => {
    writeFileSync(join(root, 'app-a', 'spec.json'), '{ 坏 JSON', 'utf-8')
    assert.equal(loadSpec({ roots: [root], appId: 'app-a' }), null)
  })
})

test('loadSpec：spec.appId 与目录 appId 不一致 → 返回 null（防静默错配）', () => {
  withFixture((root) => {
    const p = join(root, 'app-a', 'spec.json')
    writeFileSync(p, JSON.stringify({
      specVersion: 1, appId: 'app-OTHER', name: '甲', target: { type: 'web' }, commands: [],
    }), 'utf-8')
    assert.equal(loadSpec({ roots: [root], appId: 'app-a' }), null)
  })
})

test('★ 多 root：首个命中优先（两侧内容不同，才能真正验证顺序）', () => {
  withTwo((r1, r2) => {
    assert.equal(loadSpec({ roots: [r1, r2], appId: 'app-a' }).desc, '来自-ROOT1')
    assert.equal(loadSpec({ roots: [r2, r1], appId: 'app-a' }).desc, '来自-ROOT2')
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

test('★ validateSpec 默认拒绝 expose.mode=public（防线：不得绕过控制台绑定）', () => {
  const base = { specVersion: 1, appId: 'x', name: 'x', target: { type: 'web' }, commands: [] }
  const r = validateSpec({ ...base, expose: { mode: 'public' } })
  assert.equal(r.ok, false, 'LLM 生成的 public 必须被拒')
  assert.ok(r.errors.some((e) => e.includes('public')), `实际错误：${r.errors}`)
  // 用户显式开启时才放行
  assert.equal(validateSpec({ ...base, expose: { mode: 'public' } }, { allowPublic: true }).ok, true)
})

test('validateSpec：未知 expose.mode 被捕获', () => {
  const r = validateSpec({
    specVersion: 1, appId: 'x', name: 'x', target: { type: 'web' },
    expose: { mode: 'wat' }, commands: [],
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('expose.mode')))
})

test('validateSpec：expectAppId 可挡下 id 错配', () => {
  const spec = { specVersion: 1, appId: 'app-a', name: 'x', target: { type: 'web' }, commands: [] }
  assert.equal(validateSpec(spec, { expectAppId: 'app-a' }).ok, true)
  const bad = validateSpec(spec, { expectAppId: 'app-b' })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((e) => e.includes('不一致')))
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

test('getBoundApp 容忍缺失与损坏的 binding.json', () => {
  withFixture((root) => {
    assert.equal(getBoundApp({ roots: [root], sessionId: 's1' }), null, '缺失')
    writeFileSync(join(root, 'binding.json'), '{ 坏 JSON', 'utf-8')
    assert.equal(getBoundApp({ roots: [root], sessionId: 's1' }), null, '损坏')
  })
})

test('端到端小闭环：绑定 → 可见 → 解绑 → 不可见', () => {
  withFixture((root) => {
    const spec = loadSpec({ roots: [root], appId: 'app-a' })
    const bp = join(root, 'binding.json')
    assert.equal(isAppVisible(spec, { boundApp: getBoundApp({ roots: [root], sessionId: 's1' }) }), false)
    writeFileSync(bp, JSON.stringify({ s1: { appId: 'app-a' } }), 'utf-8')
    assert.equal(isAppVisible(spec, { boundApp: getBoundApp({ roots: [root], sessionId: 's1' }) }), true)
    writeFileSync(bp, JSON.stringify({}), 'utf-8')
    assert.equal(isAppVisible(spec, { boundApp: getBoundApp({ roots: [root], sessionId: 's1' }) }), false)
  })
})
