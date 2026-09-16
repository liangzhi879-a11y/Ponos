// Task 4.3：端到端回归（纯文件级，无需 GUI/真实模型/真实网络）
//
// 链路：假模型生成 Spec（不落盘）→ 用户确认保存 → 绑定到会话 → 内核出现 app_ 工具
//       → 执行（走真实 runner + 真实 history 留痕）→ 解绑 → 工具消失 → 回滚到旧版本
//
// 这条链路把「渲染层能做什么」（IPC）、「内核看到什么」（工具表）、
// 「磁盘上留下什么」（spec.json / history / 备份）三处串起来验证。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)

const home = mkdtempSync(join(tmpdir(), 'appe2e-'))
process.env.YFWORKING_HOME = home
delete process.env.PONOS_CONFIG_DIR

const ROOT = join(home, 'apps')
const roots = [ROOT]
const registry = require('../electron/app-registry.cjs')
const bindings = require('../electron/app-bindings.cjs')

const SPEC_TEXT = JSON.stringify({
  specVersion: 1, appId: 'demo', name: '示例站', desc: '演示用',
  target: { type: 'web', url: 'https://example.com' },
  expose: { mode: 'console' },
  commands: [
    { action: 'listRecent', title: '最近列表', kind: 'read', params: [], steps: [{ act: 'goto', url: '/recent' }, { act: 'snapshot', save: 'result' }] },
    { action: 'submit', title: '提交', kind: 'write', params: [], steps: [{ act: 'goto', url: '/new' }, { act: 'snapshot' }, { act: 'click', ref: 1 }] },
  ],
})

/** 造一个"渲染层 + 主进程"的最小环境：真 IPC handler、假执行器、假模型 */
function bootRenderer() {
  const handlers = new Map()
  const events = []
  require('../electron/app-ipc.cjs').registerAppHandlers({
    ipcMain: { handle: (c, f) => handlers.set(c, f) },
    getExecutor: () => ({
      exec: async (_sid, act) => (act === 'snapshot'
        ? { ok: true, snapshot: { page: { url: 'https://example.com/recent', title: '最近', readyState: 'complete' }, text: 'body', interactives: [{ ref: 'e1', tag: 'a', label: '查看', path_hint: 'div>a' }] } }
        : { ok: true }),
    }),
    getWebContents: () => ({ send: (ch, p) => events.push([ch, p]) }),
    deps: { callLlm: async () => ({ ok: true, text: SPEC_TEXT, error: null, chars: SPEC_TEXT.length }) },
  })
  return { invoke: (ch, ...a) => handlers.get(ch)({}, ...a), events }
}

test('端到端：生成不落盘 → 确认保存 → 绑定出现工具 → 执行留痕 → 解绑消失', async () => {
  const app = bootRenderer()

  // ── ① 生成：探测真实页面（假执行器）+ 假模型 → 结果只在内存里
  const gen = await app.invoke('app:generate', { target: { type: 'web', url: 'https://example.com' }, appId: 'demo', sessionId: 'sess-1' })
  assert.equal(gen.ok, true, `生成应成功：${gen.error}`)
  assert.equal(gen.driver, 'browser')
  assert.equal(gen.spec.commands.length, 2)
  assert.equal(existsSync(join(ROOT, 'demo', 'spec.json')), false, '★ 未确认前绝不落盘')
  assert.deepEqual(gen.verify.tried, ['listRecent'])
  assert.deepEqual(gen.verify.notRun, ['submit'], 'write 不试跑')

  // ── ② 用户点「确认并保存」
  await app.invoke('app:upsert', { id: 'demo', name: '示例站', desc: '演示用', targetType: 'web', enabled: true })
  await app.invoke('app:write-spec', { appId: 'demo', spec: gen.spec })
  assert.equal(existsSync(join(ROOT, 'demo', 'spec.json')), true, '确认后才写盘')
  assert.equal(registry.readSpec({ roots, appId: 'demo' }).appId, 'demo')

  // ── ③ 内核侧：未绑定 → 0 个应用工具
  const { buildAppTools } = await import(pathToFileURL(join(process.cwd(), 'kernel', 'app-tools.mjs')).href)
  const runner = async ({ action }) => {
    if (action === 'listRecent') {
      // 走真实 runner 语义：真执行 + 真留痕
      return require('../electron/app-runner.cjs').runCommand({
        roots, appId: 'demo', action, args: {}, sessionId: 'sess-1',
        executor: { exec: async () => ({ ok: true, snapshot: { page: { title: 'T' }, text: 'body' } }) },
      })
    }
    return { ok: true, data: null }
  }
  assert.equal(Object.keys(buildAppTools({ roots, sessionId: 'sess-1', runner })).length, 0, '未绑定 → 没有工具')

  // ── ④ 进入控制台（绑定）→ 出现 app_ 工具
  await app.invoke('app:console-enter', { sessionId: 'sess-1', appId: 'demo' })
  const tools = buildAppTools({ roots, sessionId: 'sess-1', runner })
  const names = Object.keys(tools)
  assert.equal(names.length, 2, `应有 2 个工具，实际 ${names.join(',')}`)
  assert.ok(names.every((n) => n.startsWith('app_')), '工具名必须带 app_ 前缀')
  const readTool = tools[names.find((n) => n.toLowerCase().includes('listrecent'))]
  assert.equal(readTool.concurrencySafe, true, 'read 命令并发安全')
  assert.equal(tools[names.find((n) => n.toLowerCase().includes('submit'))].concurrencySafe, false, 'write 命令不安全')
  assert.ok(/需确认/.test(String(tools[names.find((n) => n.toLowerCase().includes('submit'))].description)), 'write 描述要提示需确认')

  // ── ⑤ 让 AI 真的用一次（工具 run）→ 留痕 + 内核侧拿到结果
  const res = await readTool.run({})
  assert.equal(res.isError, false, `工具执行应成功：${JSON.stringify(res).slice(0, 200)}`)
  const histDir = join(ROOT, 'demo', 'history')
  assert.equal(existsSync(histDir), true, '执行必须留痕')
  const histFiles = readdirSync(histDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  assert.ok(histFiles.length >= 1, 'history 下应有当日文件')
  const entries = readFileSync(join(histDir, histFiles[0]), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(entries.some((e) => e.action === 'listRecent'), '留痕里应有这次执行')

  // ── ⑥ 其它会话看不到（console 模式的严格单开）
  assert.equal(Object.keys(buildAppTools({ roots, sessionId: 'other-sess', runner })).length, 0, '别的会话不该看到该应用工具')

  // ── ⑦ 离开控制台（解绑）→ 工具消失
  await app.invoke('app:console-leave', { sessionId: 'sess-1', appId: 'demo' })
  assert.equal(Object.keys(buildAppTools({ roots, sessionId: 'sess-1', runner })).length, 0, '解绑后工具应消失')
})

test('端到端：改 Spec 后可回滚，且回滚本身也留备份', async () => {
  const app = bootRenderer()
  const oldSpec = registry.readSpec({ roots, appId: 'demo' })
  // 改一版（走 IPC，和界面同一条路径）
  const changed = { ...oldSpec, name: '改过的名字' }
  await app.invoke('app:write-spec', { appId: 'demo', spec: changed })
  assert.equal(registry.readSpec({ roots, appId: 'demo' }).name, '改过的名字')

  const backups = await app.invoke('app:list-backups', 'demo')
  assert.ok(backups.length >= 1, '应产生备份')
  assert.ok(backups[0].ts >= backups[backups.length - 1].ts, '倒序（新在前）')

  const r = await app.invoke('app:restore-spec', { appId: 'demo', backupName: backups[0].name })
  assert.equal(r.ok, true, `回滚应成功：${r.error}`)
  assert.equal(registry.readSpec({ roots, appId: 'demo' }).name, oldSpec.name, '内容回到旧版')

  const after = await app.invoke('app:list-backups', 'demo')
  assert.equal(after.length, backups.length + 1, '回滚动作本身也留了备份（可再切回来）')
})

test('端到端：保存前校验能拦住非法 Spec（界面「不合法就不保存」的依托）', async () => {
  const app = bootRenderer()
  const bad = { specVersion: 1, appId: 'demo', name: 'x', target: { type: 'web', url: '不是URL' }, commands: [] }
  const v = await app.invoke('app:check-spec', { spec: bad })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.includes('url')), `应指出 URL 问题：${v.errors.join('；')}`)
  assert.ok(v.errors.some((e) => e.includes('commands')), '应指出命令为空')
  const good = await app.invoke('app:check-spec', { spec: registry.readSpec({ roots, appId: 'demo' }) })
  assert.equal(good.ok, true, `合法 Spec 应通过：${good.errors.join('；')}`)
})

test('端到端：默认拒绝 public，界面显式选「全局可用」才放行', async () => {
  const app = bootRenderer()
  const spec = registry.readSpec({ roots, appId: 'demo' })
  const pub = { ...spec, expose: { mode: 'public' } }
  const def = await app.invoke('app:check-spec', { spec: pub })
  assert.equal(def.ok, false, '默认不放行 public（避免绕过控制台绑定机制）')
  assert.ok(def.errors.some((e) => e.includes('public')), `应指出 public 问题：${def.errors.join('；')}`)
  const explicit = await app.invoke('app:check-spec', { spec: pub, allowPublic: true })
  assert.equal(explicit.ok, true, `用户在界面上显式选择后应放行：${explicit.errors.join('；')}`)
})

test('端到端：损坏/越权输入不会写坏磁盘（防御路径）', async () => {
  const app = bootRenderer()
  const before = readFileSync(join(ROOT, 'demo', 'spec.json'), 'utf-8')
  const r = await app.invoke('app:restore-spec', { appId: 'demo', backupName: '../../恶意.json' })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('不合法'), `应明确拒绝：${r.error}`)
  assert.equal(readFileSync(join(ROOT, 'demo', 'spec.json'), 'utf-8'), before, 'Spec 未被改动')
})

test('端到端：修复只动失败命令，且必须先备份', async () => {
  const app = bootRenderer()
  const { repairApp } = require('../electron/app-validator.cjs')
  const spec = registry.readSpec({ roots, appId: 'demo' })
  const r = await repairApp({
    roots, appId: 'demo',
    deps: {
      findFailures: async () => [{ action: 'listRecent', error: '页面改版' }],
      regenerateCommand: async () => ({ ...spec.commands[0], title: '新标题' }),
      checkApp: async () => ({ status: 'drifted', issues: [] }),
    },
  })
  assert.equal(r.ok, true, `修复应成功：${r.reason}`)
  assert.ok(r.backup, '写盘前必须有备份')
  const after = registry.readSpec({ roots, appId: 'demo' })
  assert.equal(after.commands[0].title, '新标题')
  assert.equal(after.commands[1].title, spec.commands[1].title, '未失败的命令必须原样')
  void app
})

test.after(() => { rmSync(home, { recursive: true, force: true }) })
