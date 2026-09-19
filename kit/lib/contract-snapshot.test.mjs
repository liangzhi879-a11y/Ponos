// kit/lib/contract-snapshot.test.mjs —— 契约快照（T6）
//
// 本文件钉住四件事（每条都能独立失败）：
//   ① **形状**：`assertChannelsShape()` 是**零依赖**形状断言（仓里没有 JSON Schema 校验器 ——
//      `versions.schema.json` 全仓零引用，故"收紧 schema"本身不产生约束力，形状必须在这里与 CT0 里各判一次）；
//   ② **搬家免疫**：`routes` 只存语义键（值恒为 null），**绝不存 file:line**（plan §6 D2）；`excluded` 只带
//      `{kind, literal, reason}`。判据写成"逐条键名断言"，因为这是快照能被信任的全部理由；
//   ③ **合并写**：`syncVersions` 对 `channels` 必须是 `{...prev, ...next}`（不是 `prev.channels || {}` 也不是
//      `next` 覆盖），否则 `scopeCount` / `history` 这类**人工封顶值**会被一次 sync 静默冲掉；
//   ④ **diff**：机器字段差异逐条列出；`snapshotAt` / 人工段差异**不算差异**（否则每次 sync 都"有变化"，
//      幂等断言永远红）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  buildSnapshot, readSnapshot, diffSnapshot, channelsProblems,
  CHANNELS_FIELD, MACHINE_FIELDS,
} from './contract-snapshot.mjs'
import { syncVersions } from './ledger.mjs'

/** 夹具仓：**不依赖 git**（`files` 显式传入 ⇒ 不走 trackedFiles） */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'yfw-snap-'))
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write('server/demo-routes.mjs', [
    "export function handle(pathname, method) {",
    "  if (pathname === '/demo') return 'GET'",
    "  if (pathname.startsWith('/ns/')) return 'NS'",
    "  return null",
    "}",
  ].join('\n'))
  // 非端点字面量（进 excluded，带 reason）—— 用来钉"excluded 只带 kind/literal/reason"
  write('scripts/probe.mjs', "if (path === '/') throw new Error('root')\n")
  write('electron/preload.cjs', [
    "const { ipcRenderer } = require('electron')",
    "ipcRenderer.invoke('demo:get', 1)",
    "ipcRenderer.on('demo:push', () => {})",
  ].join('\n'))
  write('electron/main.cjs', [
    "const { ipcMain } = require('electron')",
    "ipcMain.handle('demo:get', () => 1)",
    "mainWindow.webContents.send('demo:push', 1)",
  ].join('\n'))
  write('kit/manifest/versions.json', JSON.stringify({
    version: 1, lines: [], contracts: [], skills: [],
    skillsLock: { source: 'skills-lock.json', field: 'computedHash', ids: [] },
    commonTools: { baseline: [], entries: [] },
    channels: {
      snapshotAt: '2026-09-19T00:00:00.000Z',
      routes: { 'ANY /stale': null },
      wsOut: [], wsIn: [],
      ipc: { invoke: [], handle: [], send: [], on: [], push: [] },
      tools: {}, staticToolCount: 0, toolSources: {}, excluded: [],
      scopeCount: 7, scopeRedCount: 9, history: { records: [], note: '人工段' },
    },
  }, null, 2))
  const files = ['server/demo-routes.mjs', 'scripts/probe.mjs', 'electron/preload.cjs', 'electron/main.cjs']
  return { root, files }
}

/** 零依赖形状断言（plan §4：仓里没有 schema 校验器，故形状必须显式判） */
function assertChannelsShape(s, label = 'channels') {
  assert.deepEqual(channelsProblems(s), [], `${label} 形状必须完整：${JSON.stringify(channelsProblems(s))}`)
  for (const k of MACHINE_FIELDS) assert.ok(Object.hasOwn(s, k), `${label}.${k} 必须存在`)
  assert.equal(Object.values(s.routes).every((v) => v === null), true, 'routes 的值恒为 null（只存语义键）')
}

test('buildSnapshot：形状完整（assertChannelsShape）+ 机器字段齐全', async () => {
  const { root, files } = fixtureRepo()
  const s = await buildSnapshot({ root, files, now: '2026-09-19T00:00:00.000Z' })
  assertChannelsShape(s)
  assert.equal(s.snapshotAt, '2026-09-19T00:00:00.000Z')
  assert.deepEqual(Object.keys(s.routes), ['GET /demo'], '端点键 = `<METHOD> <path>`（方法由守卫窗口推得）')
  assert.deepEqual(Object.keys(s.routePrefixes), ['/ns/'], '动态前缀不进 routes，必须单列（/workflows/:id 系只能靠它表达）')
  assert.equal(s.routePrefixes['/ns/'].childCount, 0)
  assert.deepEqual(s.ipc.invoke, ['demo:get'])
  assert.deepEqual(s.ipc.handle, ['demo:get'])
  assert.deepEqual(s.ipc.push, ['demo:push'])
  // 夹具里没有 kernel/tools.mjs：**不抛错**、如实报 present:false（"提取不到 ≠ 不存在"）
  assert.deepEqual(s.tools, {})
  assert.equal(s.staticToolCount, 0)
  assert.equal(s.toolSources.static.present, false)
  assert.ok(s.excluded.length >= 1, 'root-path-check 必须逐条进 excluded')
  assert.deepEqual([...new Set(s.excluded.map((e) => e.kind))].includes('root-path-check'), true)
})

test('★搬家免疫：routes 只有语义键、excluded 只有 kind/literal/reason —— 绝不存 file:line', async () => {
  const { root, files } = fixtureRepo()
  const s = await buildSnapshot({ root, files, now: 'x' })
  // ★ 判据的**范围**要说清（否则会误伤 `toolSources.static.file` —— 那是"动态源登记"的内容本身，
  //   不是"某条端点判定落在哪个文件"，两者语义不同）：这里禁的是**端点/事件/通道/排除**这几类的
  //   判定位置。`toolSources[].file` 由 T4 的 TOOL_SOURCES 常量给出（语义登记），保留。
  const semantic = JSON.stringify({
    routes: s.routes, routePrefixes: s.routePrefixes, wsOut: s.wsOut, wsIn: s.wsIn, ipc: s.ipc, excluded: s.excluded,
  })
  assert.equal(semantic.includes('"file"'), false, '快照的契约字段不得出现 file（搬家重构免疫：plan §6 D2）')
  assert.equal(semantic.includes('"line"'), false, '快照的契约字段不得出现 line')
  for (const e of s.excluded) assert.deepEqual(Object.keys(e).sort(), ['kind', 'literal', 'reason'])
  for (const v of Object.values(s.routes)) assert.equal(v, null)
  assert.equal(Object.hasOwn(s, 'hints'), false)
})

test('buildSnapshot：确定性（同输入两次逐字相等，含 snapshotAt=now 固定）', async () => {
  const { root, files } = fixtureRepo()
  const a = await buildSnapshot({ root, files, now: 'T' })
  const b = await buildSnapshot({ root, files, now: 'T' })
  assert.deepEqual(a, b)
})

test('readSnapshot：读 versions.json#channels；缺失/坏形状 → null', () => {
  const { root } = fixtureRepo()
  assert.equal(readSnapshot({ root }).scopeCount, 7)
  assert.equal(CHANNELS_FIELD, 'channels')
  const empty = mkdtempSync(join(tmpdir(), 'yfw-snap-null-'))
  assert.equal(readSnapshot({ root: empty }), null, '没有台账必须返回 null（由 CT0 报红，不是静默空快照）')
  mkdirSync(join(empty, 'kit/manifest'), { recursive: true })
  writeFileSync(join(empty, 'kit/manifest/versions.json'), '{ "channels": [] }')
  assert.equal(readSnapshot({ root: empty }), null, 'channels 是数组 ⇒ 坏形状，同样返回 null')
})

test('diffSnapshot：逐类列出差异；snapshotAt 与人工段差异**不算**差异', async () => {
  const { root, files } = fixtureRepo()
  const live = await buildSnapshot({ root, files, now: 'T2' })
  const recorded = await buildSnapshot({ root, files, now: 'T1' })
  assert.equal(diffSnapshot(recorded, live).equal, true, 'snapshotAt 不同不算差异（否则 sync 永不幂等）')

  // 手改快照一个端点 → 必报差异（CT1 的变异①）
  const handEdited = { ...recorded, routes: { ...recorded.routes, 'POST /zzz': null } }
  const d1 = diffSnapshot(handEdited, live)
  assert.equal(d1.equal, false)
  assert.deepEqual(d1.diffs.map((x) => `${x.kind}:${x.key}`).sort(), ['routes:POST /zzz'])

  // 删一个 wsOut / 改 ipc handle / 改 toolSources.present / 改 excluded reason → 各自成一条差异
  const cases = [
    ['wsOut', (s) => ({ ...s, wsOut: [...s.wsOut, 'ghost_event'] })],
    ['wsIn', (s) => ({ ...s, wsIn: [...s.wsIn, 'ghost_in'] })],
    ['ipc', (s) => ({ ...s, ipc: { ...s.ipc, handle: [...s.ipc.handle, 'demo:ghost'] } })],
    ['excluded', (s) => ({ ...s, excluded: s.excluded.map((e) => ({ ...e, reason: '改了理由' })) })],
    ['staticToolCount', (s) => ({ ...s, staticToolCount: 99 })],
    ['routePrefixes', (s) => ({ ...s, routePrefixes: {} })],
    ['toolSources', (s) => ({ ...s, toolSources: { ...s.toolSources, static: { ...s.toolSources.static, present: true } } })],
  ]
  for (const [kind, mutate] of cases) {
    const d = diffSnapshot(mutate(recorded), live)
    assert.equal(d.equal, false, `${kind} 改了必须报差异`)
    assert.ok(d.diffs.some((x) => x.kind === kind || x.kind.startsWith(`${kind}.`)),
      `${kind} 必须出现在差异里，实测 ${d.diffs.map((x) => x.kind).join(',')}`)
  }
  // 人工段（scopeCount / history）被手改**不得**报差异：它们不是"从代码复算"的事实
  const humanEdited = { ...recorded, scopeCount: 999, history: { records: [{ key: 'x', from: 1, to: 2, at: 'T' }] } }
  assert.equal(diffSnapshot(humanEdited, live).equal, true, 'scopeCount/history 是人工段，不参与 CT1 重算')
})

test('channelsProblems：逐字段点出缺项（CT0 的判据来源）', async () => {
  const { root, files } = fixtureRepo()
  const s = await buildSnapshot({ root, files, now: 'x' })
  assert.deepEqual(channelsProblems(s), [])
  const del = (k) => { const c = { ...s }; delete c[k]; return channelsProblems(c) }
  assert.ok(del('routes').some((m) => /routes/.test(m)))
  assert.ok(del('ipc').some((m) => /ipc/.test(m)))
  assert.ok(del('toolSources').some((m) => /toolSources/.test(m)))
  assert.ok(del('staticToolCount').some((m) => /staticToolCount/.test(m)))
  assert.deepEqual(channelsProblems(null), ['channels 缺失或不是对象（versions.json#channels）'])
  assert.ok(channelsProblems({ ...s, scopeCount: '7' }).some((m) => /scopeCount/.test(m)), '人工封顶值存在时类型也要判')
})

test('★T6③：syncVersions 对 channels 是**合并写** —— scopeCount/history 不被冲掉（改回 `channels:{}` 即红）', async () => {
  const { root, files } = fixtureRepo()
  const next = {
    snapshotAt: '2026-09-20T00:00:00.000Z',
    routes: { 'ANY /fresh': null },
    wsOut: ['a'], wsIn: [],
    ipc: { invoke: [], handle: [], send: [], on: [], push: [] },
    tools: {}, staticToolCount: 0, toolSources: {}, excluded: [],
  }
  const r = syncVersions({ root, files, channels: next })
  const written = readSnapshot({ root })
  assert.deepEqual(written, r.data.channels, '返回的 data 必须与落盘内容一致')
  assert.deepEqual(written.routes, { 'ANY /fresh': null }, '机器字段以本次为准（旧 routes 不得残留）')
  assert.equal(written.snapshotAt, '2026-09-20T00:00:00.000Z')
  assert.equal(written.scopeCount, 7, 'scopeCount 是人工封顶值：sync 不得冲掉（改回 `channels: {}` 时这里必红）')
  assert.equal(written.scopeRedCount, 9)
  assert.deepEqual(written.history, { records: [], note: '人工段' })
  // 二次 sync（同 next）逐字节幂等
  const before = readFileSync(join(root, 'kit/manifest/versions.json'), 'utf8')
  syncVersions({ root, files, channels: next })
  assert.equal(readFileSync(join(root, 'kit/manifest/versions.json'), 'utf8'), before)
  // dry-run 不得写盘
  syncVersions({ root, files, dryRun: true, channels: { ...next, routes: { 'ANY /nope': null } } })
  assert.equal(readSnapshot({ root }).routes['ANY /nope'], undefined, 'dryRun 不得落盘')
})
