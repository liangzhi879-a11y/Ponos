// Task 2.2：desktop 驱动执行（process / script / uia）
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { desktopRunner, buildArgv, runUia } = require('../electron/app-runner-desktop.cjs')

test('buildArgv 完成插值', () => {
  assert.deepEqual(buildArgv(['list', '--id', '${id}'], { id: 'X' }), ['list', '--id', 'X'])
})

test('process 驱动：cli 步骤拼 argv 并返回 stdout', async () => {
  const r = await desktopRunner({
    appId: 'app-d', action: 'ls', args: { id: 'X' },
    spec: { driver: 'process', target: { exePath: 'C:/x/a.exe' },
            commands: [{ action: 'ls', kind: 'read', params: [{ name: 'id', required: true }],
                         steps: [{ act: 'cli', argv: ['list', '--id', '${id}'], save: 'out' }] }] },
    deps: { runCli: async () => ({ ok: true, stdout: 'done' }) },
  })
  assert.equal(r.ok, true)
  assert.equal(r.data, 'done')
})

test('script 驱动：script 步骤被派发', async () => {
  let got = null
  const r = await desktopRunner({
    appId: 'app-d', action: 'gen', args: {},
    spec: { driver: 'script', target: { exePath: 'C:/x/a.exe' },
            commands: [{ action: 'gen', kind: 'read', params: [], steps: [{ act: 'script', lang: 'lua', code: 'return 1', save: 'out' }] }] },
    deps: { runScript: async (p) => { got = p; return { ok: true, stdout: '1' } } },
  })
  assert.equal(r.ok, true)
  assert.equal(got.lang, 'lua')
})

test('uia 驱动：无脚本接口时走 UI 自动化', async () => {
  let got = null
  // 2026-09-17（P1 控制命令覆盖）：本用例原用 `act:'click'` —— 而 `click` **从来不在**
  // `ACTS_BY_DRIVER.uia`（['focus','type','key','wait']）里，即这个 fixture 本身就是一个
  // "契约没放行、运行器却照收"的实例。运行器现已按契约校验 act，故改用契约内的 `focus`。
  // 断言意图与强度不变：仍是"uia 步骤能把参数原样交给 runUia 并成功返回"。
  const r = await desktopRunner({
    appId: 'app-d', action: 'tap', args: {},
    spec: { driver: 'uia', target: { exePath: 'C:/x/a.exe' },
            commands: [{ action: 'tap', kind: 'write', params: [], steps: [{ act: 'focus', selector: 'ok' }] }] },
    deps: { runUia: async (p) => { got = p; return { ok: true } } },
  })
  assert.equal(r.ok, true)
  assert.equal(got.act, 'focus')
})

test('未知 driver → 明确报错', async () => {
  const r = await desktopRunner({ appId: 'a', action: 'x', args: {}, spec: { driver: 'nope', commands: [] } })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('nope'))
})

test('未知 action → 报错不抛', async () => {
  const r = await desktopRunner({ appId: 'a', action: 'x', args: {}, spec: { driver: 'process', commands: [] } })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('x'))
})

test('缺必填参数 → 不派发任何步骤', async () => {
  let called = false
  const r = await desktopRunner({
    appId: 'a', action: 'ls', args: {},
    spec: { driver: 'process', target: { exePath: 'C:/x/a.exe' },
            commands: [{ action: 'ls', kind: 'read', params: [{ name: 'id', required: true }], steps: [{ act: 'cli', argv: ['x'] }] }] },
    deps: { runCli: async () => { called = true; return { ok: true, stdout: '' } } },
  })
  assert.equal(r.ok, false)
  assert.equal(called, false)
})

test('步骤失败 → 保留错误、不再继续后续步骤', async () => {
  const called = []
  const r = await desktopRunner({
    appId: 'a', action: 'three', args: {},
    spec: { driver: 'process', target: { exePath: 'C:/x/a.exe' },
            commands: [{ action: 'three', kind: 'write', params: [], steps: [
              { act: 'cli', argv: ['a'] }, { act: 'cli', argv: ['b'] }, { act: 'cli', argv: ['c'] }] }] },
    deps: { runCli: async (p) => { called.push(p.argv[0]); return { ok: p.argv[0] !== 'b', error: '退出码 1' } } },
  })
  assert.equal(r.ok, false)
  assert.deepEqual(called, ['a', 'b'], 'b 失败后不得再执行 c')
  assert.ok(r.error.includes('退出码 1'))
})

test('driver=process 但步骤是 script → 明确报错（不静默跳过）', async () => {
  const r = await desktopRunner({
    appId: 'a', action: 'mix', args: {},
    spec: { driver: 'process', target: { exePath: 'C:/x/a.exe' },
            commands: [{ action: 'mix', kind: 'read', params: [], steps: [{ act: 'script', lang: 'lua', code: '1' }] }] },
    deps: { runScript: async () => ({ ok: true }) },
  })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('不支持步骤'))
})

test('默认 runUia 未接入后端时必须明确失败（绝不假装成功）', async () => {
  const r = await runUia({ act: 'click' })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('尚未接入'))
})
