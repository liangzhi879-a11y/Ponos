// Task 2.1：Spec 解释执行 + 执行留痕（browser 驱动）
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { runCommand, interpolate, checkRequired, resolveStepUrl } = require('../electron/app-runner.cjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'apprun-'))
  mkdirSync(join(root, 'app-a'), { recursive: true })
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ version: 1, apps: [{ id: 'app-a', name: '甲' }] }), 'utf-8')
  writeFileSync(join(root, 'app-a', 'spec.json'), JSON.stringify({
    specVersion: 1, appId: 'app-a', name: '甲',
    target: { type: 'web', url: 'https://example.com' },
    expose: { mode: 'console' },
    commands: [
      { action: 'query', title: '查', kind: 'read',
        params: [{ name: 'orderId', type: 'string', required: true }],
        steps: [{ act: 'goto', url: '/o/${orderId}' }, { act: 'snapshot', save: 'result' }],
        returns: { type: 'text', from: 'result' } },
      { action: 'submit', title: '交', kind: 'write', params: [], steps: [{ act: 'click', selector: '#ok' }] },
    ],
  }), 'utf-8')
  return root
}

test('interpolate 替换 ${param}', () => {
  assert.equal(interpolate('/o/${orderId}', { orderId: 'A1' }), '/o/A1')
  assert.equal(interpolate('/o/${missing}', {}), '/o/')
})

test('checkRequired 缺必填则报错', () => {
  const r = checkRequired([{ name: 'x', required: true }], {})
  assert.equal(r.ok, false)
  assert.ok(r.errors[0].includes('x'))
})

test('read 命令按 steps 顺序执行并返回快照', async () => {
  const root = fixture()
  try {
    const calls = []
    const executor = { exec: async (_s, action, params) => { calls.push([action, params]); return { ok: true, snapshot: { text: 'ok' } } } }
    const r = await runCommand({ roots: [root], appId: 'app-a', action: 'query', args: { orderId: 'A1' }, executor, sessionId: 's1' })
    assert.equal(r.ok, true)
    assert.equal(r.kind, 'read')
    assert.deepEqual(calls.map((c) => c[0]), ['goto', 'snapshot'])
    // 相对路径要做两件事：插值 + 按应用 target 补成绝对地址。
    // 补全不是锦上添花——白名单按主机名判定，相对路径会被误判为"不在白名单"而拒绝导航
    //（真机故障：`已拒绝导航: /protected`），表现就是"命令看着没问题、一跑就失败"。
    assert.equal(calls[0][1].url, 'https://example.com/o/A1', 'goto 步骤应完成插值并按 target 补成绝对地址')
    assert.equal(r.data, 'ok')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('缺必填参数：不执行任何动作并返回错误', async () => {
  const root = fixture()
  try {
    let called = false
    const executor = { exec: async () => { called = true; return { ok: true } } }
    const r = await runCommand({ roots: [root], appId: 'app-a', action: 'query', args: {}, executor, sessionId: 's1' })
    assert.equal(r.ok, false)
    assert.equal(called, false, '缺参不应发起任何动作')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('未知 action 返回错误而非抛错', async () => {
  const root = fixture()
  try {
    const r = await runCommand({ roots: [root], appId: 'app-a', action: 'nope', args: {}, executor: { exec: async () => ({ ok: true }) }, sessionId: 's1' })
    assert.equal(r.ok, false)
    assert.ok(/nope/.test(r.error))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('执行留痕：history 有 jsonl 且含 kind', async () => {
  const root = fixture()
  try {
    const executor = { exec: async () => ({ ok: true, snapshot: {} }) }
    await runCommand({ roots: [root], appId: 'app-a', action: 'query', args: { orderId: 'A1' }, executor, sessionId: 's1' })
    await runCommand({ roots: [root], appId: 'app-a', action: 'submit', args: {}, executor, sessionId: 's1' })
    const dir = join(root, 'app-a', 'history')
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    const lines = readFileSync(join(dir, files[0]), 'utf-8').trim().split('\n')
    assert.equal(lines.length, 2, '两次执行都应留痕')
    assert.equal(JSON.parse(lines[1]).kind, 'write')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('失败也留痕（留痕口径：任何执行含失败都写）', async () => {
  const root = fixture()
  try {
    const executor = { exec: async () => ({ ok: false, error: '页面崩了' }) }
    const r = await runCommand({ roots: [root], appId: 'app-a', action: 'query', args: { orderId: 'A1' }, executor, sessionId: 's1' })
    assert.equal(r.ok, false)
    const dir = join(root, 'app-a', 'history')
    const files = readdirSync(dir)
    const entry = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    assert.equal(entry.ok, false)
    assert.ok(entry.error.includes('页面崩了'))
    assert.equal(entry.kind, 'read')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Spec 不存在 → 结构化错误（不抛）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'apprun-'))
  try {
    const r = await runCommand({ roots: [root], appId: 'ghost', action: 'x', args: {}, executor: { exec: async () => ({ ok: true }) }, sessionId: 's1' })
    assert.equal(r.ok, false)
    assert.ok(r.error.includes('ghost'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('执行器缺失 → 结构化错误（不抛）', async () => {
  const root = fixture()
  try {
    const r = await runCommand({ roots: [root], appId: 'app-a', action: 'query', args: { orderId: 'A1' }, executor: null, sessionId: 's1' })
    assert.equal(r.ok, false)
    assert.ok(r.error.includes('执行器'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---------- 步骤字段契约（真实故障：`步骤 js 失败：js 缺少 expression`） ----------

/** 造一个只含指定命令的 app，便于单独跑某个步骤写法 */
function specWith(steps, { kind = 'read', params = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'appstep-'))
  mkdirSync(join(root, 'app-a'), { recursive: true })
  writeFileSync(join(root, 'app-a', 'spec.json'), JSON.stringify({
    specVersion: 1, appId: 'app-a', name: '甲', target: { type: 'web', url: 'https://example.com' }, expose: { mode: 'console' },
    commands: [{ action: 'run', title: '跑', kind, params, steps }],
  }), 'utf-8')
  return root
}

test('js 步骤：字段名是 expression（正确写法能跑）', async () => {
  const root = specWith([{ act: 'goto', url: '/' }, { act: 'js', expression: 'document.title', save: 'r' }])
  try {
    const seen = []
    const executor = { exec: async (_s, act, p) => { seen.push({ act, p }); return { ok: true, data: '标题', snapshot: {} } } }
    const r = await runCommand({ roots: [root], appId: 'app-a', action: 'run', args: {}, executor, sessionId: 's1' })
    assert.equal(r.ok, true)
    assert.equal(seen[1].p.expression, 'document.title', 'expression 必须原样传给执行器')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('js 步骤：表达式被写进 code/script/value 时兜底仍能跑（旧 Spec 不该因字段别名失效）', async () => {
  for (const alias of ['code', 'script', 'value', 'expr']) {
    const root = specWith([{ act: 'js', [alias]: 'document.title' }])
    try {
      const seen = []
      const executor = { exec: async (_s, act, p) => { seen.push({ act, p }); return { ok: true, data: 'x' } } }
      const r = await runCommand({ roots: [root], appId: 'app-a', action: 'run', args: {}, executor, sessionId: 's1' })
      assert.equal(r.ok, true, `${alias} 应被兜底为 expression`)
      assert.equal(seen[0].p.expression, 'document.title', `${alias} → expression 的映射要生效`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('js 步骤：参数插值同样作用于别名写法', async () => {
  const root = specWith([{ act: 'js', code: 'document.title + "${q}"' }], { params: [{ name: 'q', type: 'string', required: true }] })
  try {
    const seen = []
    const executor = { exec: async (_s, act, p) => { seen.push({ act, p }); return { ok: true, data: 'x' } } }
    await runCommand({ roots: [root], appId: 'app-a', action: 'run', args: { q: 'Z' }, executor, sessionId: 's1' })
    assert.equal(seen[0].p.expression, 'document.title + "Z"')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('click/type 写成 selector（而非 ref）→ 报可操作的错误，而不是执行器的原始报错', async () => {
  const root = specWith([{ act: 'click', selector: '#ok' }], { kind: 'write' })
  try {
    const executor = { exec: async () => ({ ok: true }) }
    const r = await runCommand({ roots: [root], appId: 'app-a', action: 'run', args: {}, executor, sessionId: 's1' })
    assert.equal(r.ok, false)
    assert.ok(r.error.includes('ref'), `应点名 ref：${r.error}`)
    assert.ok(r.error.includes('#ok'), '要带上用户写的选择器，便于定位')
    assert.ok(r.error.includes('js') || r.error.includes('snapshot'), '要给出改法')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('ref 类动作给了 ref 就照常执行（不误报）', async () => {
  const root = specWith([{ act: 'goto', url: '/' }, { act: 'click', ref: 2 }], { kind: 'write' })
  try {
    const seen = []
    const executor = { exec: async (_s, act, p) => { seen.push({ act, p }); return { ok: true } } }
    const r = await runCommand({ roots: [root], appId: 'app-a', action: 'run', args: {}, executor, sessionId: 's1' })
    assert.equal(r.ok, true)
    assert.equal(seen[1].p.ref, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---------- 相对网址补全（真机故障：相对路径被白名单误判为"不在白名单"） ----------
//
// Spec 里写 `/protected`、`/list?page=2` 是非常自然的写法，但白名单按**主机名**判定，
// 拿 "/protected" 去判会被当成"不在白名单"而直接拒绝导航（真机报：`已拒绝导航: /protected`），
// 表现就是"命令看着没问题、一跑就失败"。基准必须取应用自己的 target.url。

test('resolveStepUrl：相对路径按应用 target 补全，绝对地址原样保留', () => {
  const spec = { target: { type: 'web', url: 'https://example.com/app/' } }
  assert.equal(resolveStepUrl('/protected', spec), 'https://example.com/protected')
  assert.equal(resolveStepUrl('list?page=2', spec), 'https://example.com/app/list?page=2')
  assert.equal(resolveStepUrl('https://other.com/x', spec), 'https://other.com/x', '绝对地址不动')
  assert.equal(resolveStepUrl('http://localhost:8080/y', spec), 'http://localhost:8080/y')
  assert.equal(resolveStepUrl('', spec), '', '空值不编')
  assert.equal(resolveStepUrl('/x', { target: { type: 'desktop', exePath: 'C:/a.exe' } }), '/x', '没有 web target 时不硬猜')
  assert.equal(resolveStepUrl('/x', {}), '/x')
})

test('runCommand：步骤里的相对路径会被补成绝对地址后才交给执行器', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yfw-runner-rel-'))
  try {
    mkdirSync(join(root, 'app-a'), { recursive: true })
    writeFileSync(join(root, 'app-a', 'spec.json'), JSON.stringify({
      specVersion: 1, appId: 'app-a', name: 'A', target: { type: 'web', url: 'https://example.com/app/' }, expose: { mode: 'console' },
      commands: [{ action: 'readIt', title: '读取', kind: 'read', params: [], steps: [{ act: 'goto', url: '/protected' }, { act: 'snapshot', save: 'r' }] }],
    }))
    const seen = []
    const executor = { exec: async (_s, act, p) => { seen.push({ act, p }); return { ok: true, snapshot: { info: [] } } } }
    const r = await runCommand({ roots: [root], appId: 'app-a', action: 'readIt', args: {}, executor, sessionId: 's1' })
    assert.equal(r.ok, true, r.error)
    assert.equal(seen[0].act, 'goto')
    assert.equal(seen[0].p.url, 'https://example.com/protected', `相对路径必须补全后再交给执行器：${JSON.stringify(seen[0].p)}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
