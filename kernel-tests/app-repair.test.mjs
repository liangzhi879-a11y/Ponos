// Task 3.4：漂移修复（只修失败命令 / 先备份 / 必回报 / 不碰 broken / 不合法不写盘）
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const registry = require('../electron/app-registry.cjs')
const { repairApp, findFailingCommands, readHistory, extractCommand, defaultRegenerateCommand } = require('../electron/app-validator.cjs')

const mk = () => {
  const root = mkdtempSync(join(tmpdir(), 'apprep-'))
  return { roots: [root], root }
}
const CMD = (action, title, kind = 'read') => ({ action, title, kind, params: [], steps: [{ act: 'goto', url: `/${action}` }] })
const spec = (...cmds) => ({
  specVersion: 1, appId: 'demo', name: '示例', driver: 'browser',
  target: { type: 'web', url: 'https://a.com' }, expose: { mode: 'console' }, commands: cmds,
})
const writeHistory = (root, appId, entries) => {
  const dir = join(root, appId, 'history')
  mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  writeFileSync(join(dir, `${day}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
  return day
}
const now = () => new Date().toISOString()

// ---------- findFailingCommands ----------

test('findFailingCommands：只看每个命令的「最近一次」结果', () => {
  const { roots, root } = mk()
  writeHistory(root, 'demo', [
    { action: 'a', ok: false, error: '旧失败', at: '2026-09-13T01:00:00Z' },
    { action: 'a', ok: true, at: '2026-09-13T02:00:00Z' },   // 后来成功了 → 不该再算待修
    { action: 'b', ok: false, error: '选择器没找到', at: now() },
  ])
  const f = findFailingCommands({ roots, appId: 'demo' })
  assert.deepEqual(f.map((x) => x.action), ['b'])
  assert.equal(f[0].error, '选择器没找到')
})

test('findFailingCommands：坏行/坏文件不影响（历史是留痕不是唯一真源）', () => {
  const { roots, root } = mk()
  const dir = join(root, 'demo', 'history')
  mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  writeFileSync(join(dir, `${day}.jsonl`), '{坏行\n' + JSON.stringify({ action: 'x', ok: false, error: 'e', at: now() }) + '\n', 'utf-8')
  writeFileSync(join(dir, 'not-a-date.txt'), 'ignore', 'utf-8')
  assert.deepEqual(findFailingCommands({ roots, appId: 'demo' }).map((x) => x.action), ['x'])
})

test('findFailingCommands：没有历史 → 空数组', () => {
  const { roots } = mk()
  assert.deepEqual(findFailingCommands({ roots, appId: 'none' }), [])
})

// ---------- repairApp ----------

test('repairApp：只改失败的命令，其余命令逐字不动', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: spec(CMD('a', '旧A'), CMD('b', 'B'), CMD('c', 'C')) })
  const r = await repairApp({
    roots, appId: 'demo',
    deps: {
      findFailures: async () => [{ action: 'a', error: '页面改版' }],
      regenerateCommand: async () => CMD('a', '新A'),
      checkApp: async () => ({ status: 'drifted', issues: [] }),
    },
  })
  assert.equal(r.ok, true)
  const after = registry.readSpec({ roots, appId: 'demo' })
  assert.equal(after.commands.find((c) => c.action === 'a').title, '新A', '失败的命令被修好')
  assert.deepEqual(after.commands[1], CMD('b', 'B'), '未失败的命令必须逐字不变')
  assert.deepEqual(after.commands[2], CMD('c', 'C'), '未失败的命令必须逐字不变')
})

test('repairApp：必须回报 repaired 明细（不得静默改）', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: spec(CMD('a', '旧A')) })
  const r = await repairApp({
    roots, appId: 'demo',
    deps: {
      findFailures: async () => [{ action: 'a', error: '选择器失效' }],
      regenerateCommand: async () => CMD('a', '新A'),
      checkApp: async () => ({ status: 'drifted', issues: [] }),
    },
  })
  assert.equal(r.repaired.length, 1)
  const d = r.repaired[0]
  assert.equal(d.action, 'a')
  assert.equal(d.from.title, '旧A')
  assert.equal(d.to.title, '新A')
  assert.equal(d.reason, '选择器失效', '要说明为什么修（真实报错）')
})

test('repairApp：写盘前必有备份，且返回备份名', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: spec(CMD('a', '旧A')) })
  const r = await repairApp({
    roots, appId: 'demo',
    deps: { findFailures: async () => [{ action: 'a', error: 'e' }], regenerateCommand: async () => CMD('a', '新A'), checkApp: async () => ({ status: 'drifted' }) },
  })
  assert.equal(r.ok, true)
  assert.ok(r.backup && /^spec\.bak\.\d+\.json$/.test(r.backup), `应有备份：${r.backup}`)
  assert.ok(registry.listBackups({ roots, appId: 'demo' }).some((b) => b.name === r.backup))
})

test('repairApp：没有失败命令 → 不写盘、不产生备份', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: spec(CMD('a', 'A')) })
  const before = readFileSync(join(roots[0], 'demo', 'spec.json'), 'utf-8')
  const r = await repairApp({
    roots, appId: 'demo',
    deps: { findFailures: async () => [], checkApp: async () => ({ status: 'healthy', issues: [] }) },
  })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('没有发现'))
  assert.equal(readFileSync(join(roots[0], 'demo', 'spec.json'), 'utf-8'), before, 'Spec 未被改动')
  assert.equal(registry.listBackups({ roots, appId: 'demo' }).length, 0, '不该产生无意义备份')
})

test('repairApp：修复后整体不合法 → 放弃写盘（宁可不修，不可改坏）', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: spec(CMD('a', '旧A')) })
  const before = readFileSync(join(roots[0], 'demo', 'spec.json'), 'utf-8')
  const r = await repairApp({
    roots, appId: 'demo',
    deps: {
      findFailures: async () => [{ action: 'a', error: 'e' }],
      regenerateCommand: async () => ({ ...CMD('a', '新A'), steps: [] }),   // steps 空 = 非法
      checkApp: async () => ({ status: 'drifted' }),
    },
  })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('不合法'))
  assert.equal(readFileSync(join(roots[0], 'demo', 'spec.json'), 'utf-8'), before, 'Spec 未被改动')
  assert.equal(registry.listBackups({ roots, appId: 'demo' }).length, 0, '未写盘就不该有备份')
})

test('repairApp：broken 状态不自动修复（连失败命令都不去查）', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: spec(CMD('a', 'A')) })
  let findCalls = 0
  let regenCalls = 0
  const r = await repairApp({
    roots, appId: 'demo',
    deps: {
      checkApp: async () => ({ status: 'broken', issues: ['exePath 不存在'] }),
      findFailures: async () => { findCalls += 1; return [{ action: 'a', error: 'e' }] },
      regenerateCommand: async () => { regenCalls += 1; return CMD('a', 'x') },
    },
  })
  assert.equal(r.ok, false)
  assert.equal(r.status, 'broken')
  assert.ok(r.reason.includes('broken'))
  assert.equal(findCalls, 0, 'broken 时不该继续找失败命令')
  assert.equal(regenCalls, 0, 'broken 时不该重新生成')
})

test('repairApp：Spec 不存在 → 明确报错（不崩）', async () => {
  const { roots } = mk()
  const r = await repairApp({ roots, appId: 'none', deps: { checkApp: async () => ({ status: 'healthy' }) } })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('Spec 不存在'))
})

test('repairApp：新命令 action 与原命令不一致 → 放弃该条（避免错位覆盖）', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: spec(CMD('a', '旧A'), CMD('b', 'B')) })
  const r = await repairApp({
    roots, appId: 'demo',
    deps: {
      findFailures: async () => [{ action: 'a', error: 'e' }],
      regenerateCommand: async () => CMD('完全不同', '新'),
      checkApp: async () => ({ status: 'drifted' }),
    },
  })
  assert.equal(r.ok, false)
  assert.ok(r.failed[0].reason.includes('不一致'))
  assert.deepEqual(registry.readSpec({ roots, appId: 'demo' }).commands, [CMD('a', '旧A'), CMD('b', 'B')], 'Spec 未变')
})

test('repairApp：重新生成抛错 → 记为 failed，不炸整个修复', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: spec(CMD('a', '旧A')) })
  const r = await repairApp({
    roots, appId: 'demo',
    deps: { findFailures: async () => [{ action: 'a', error: 'e' }], regenerateCommand: async () => { throw new Error('模型超时') }, checkApp: async () => ({ status: 'drifted' }) },
  })
  assert.equal(r.ok, false)
  assert.ok(r.failed[0].reason.includes('模型超时'))
})

test('repairApp：部分成功 → 写盘且如实列出失败项', async () => {
  const { roots } = mk()
  registry.writeSpec({ roots, appId: 'demo', spec: spec(CMD('a', '旧A'), CMD('b', '旧B')) })
  const r = await repairApp({
    roots, appId: 'demo',
    deps: {
      findFailures: async () => [{ action: 'a', error: 'e1' }, { action: 'b', error: 'e2' }],
      regenerateCommand: async ({ command }) => (command.action === 'a' ? CMD('a', '新A') : null),
      checkApp: async () => ({ status: 'drifted' }),
    },
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.repaired.map((x) => x.action), ['a'])
  assert.deepEqual(r.failed.map((x) => x.action), ['b'])
  const after = registry.readSpec({ roots, appId: 'demo' })
  assert.equal(after.commands[0].title, '新A')
  assert.equal(after.commands[1].title, '旧B', '没修出来的那条保持原样')
})

test('repairApp：maxRepair 限制单次修复条数', async () => {
  const { roots } = mk()
  const cmds = ['a', 'b', 'c', 'd'].map((x) => CMD(x, x.toUpperCase()))
  registry.writeSpec({ roots, appId: 'demo', spec: spec(...cmds) })
  const r = await repairApp({
    roots, appId: 'demo', maxRepair: 2,
    deps: {
      findFailures: async () => ['a', 'b', 'c', 'd'].map((x) => ({ action: x, error: 'e' })),
      regenerateCommand: async ({ command }) => CMD(command.action, '新' + command.action),
      checkApp: async () => ({ status: 'drifted' }),
    },
  })
  assert.equal(r.repaired.length, 2)
})

// ---------- 默认实现的安全底线 ----------

test('defaultRegenerateCommand：未注入 callLlm → 返回 null（绝不假装修复成功）', async () => {
  const fn = defaultRegenerateCommand({})
  assert.equal(await fn({ spec: spec(CMD('a', 'A')), command: CMD('a', 'A'), error: 'e' }), null)
})

test('extractCommand：兼容整份 spec / 命令数组 / 单个命令对象', () => {
  assert.equal(extractCommand('{"commands":[{"action":"a"}]}').action, 'a')
  assert.equal(extractCommand('```json\n{"action":"b","steps":[]}\n```').action, 'b')
  assert.equal(extractCommand('不是 JSON'), null)
})

test('readHistory 只读最近 N 天的 YYYY-MM-DD.jsonl', () => {
  const { roots, root } = mk()
  writeHistory(root, 'demo', [{ action: 'x', ok: false, at: now() }])
  mkdirSync(join(root, 'demo', 'history'), { recursive: true })
  writeFileSync(join(root, 'demo', 'history', '2019-01-01.jsonl'), JSON.stringify({ action: 'old', ok: false, at: '2019-01-01T00:00:00Z' }) + '\n', 'utf-8')
  const h = readHistory({ roots, appId: 'demo' })
  assert.ok(h.some((e) => e.action === 'x'))
  assert.ok(!h.some((e) => e.action === 'old'), '超出窗口的旧记录不算（太久以前的失败不具参考性）')
})

test.after(() => { /* 保留临时目录便于失败排查 */ })
