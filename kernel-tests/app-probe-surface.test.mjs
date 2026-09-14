// M5：控制台要把能力清单画出来，而清单必须从主进程送到渲染层。
// 通道沿用既有的 app:probe（preload 已暴露 appProbe，**本期不改 preload**，也不加新通道）。
// 用假执行器 + 临时目录里的假 exe：不碰网络、不真的拉起程序。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { registerAppHandlers } = require('../electron/app-ipc.cjs')

const fakeIpcMain = () => {
  const handlers = new Map()
  return { handle: (c, f) => handlers.set(c, f), invoke: (c, ...a) => handlers.get(c)({}, ...a) }
}
const fakeExecutor = () => ({
  exec: async (_sid, act) => (act === 'snapshot'
    ? { ok: true, snapshot: { page: { url: 'https://example.com/', title: '示例站' }, text: 'body', interactives: [{ ref: 1, tag: 'a', label: '入口' }] } }
    : { ok: true }),
})

test('★ app:probe（web）：返回值带上 surface（三态 + 通道 + 证据 + 下一步）', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: fakeExecutor, getWebContents: () => ({ send: () => {} }) })
  const r = await ipc.invoke('app:probe', { target: { type: 'web', url: 'https://example.com' } })
  assert.equal(r.reachable, true)
  assert.ok(r.surface && Array.isArray(r.surface.capabilities), `要带 surface：${JSON.stringify(r.surface)}`)
  assert.equal(r.surface.verdict, 'connectable')
  const webui = r.surface.capabilities.find((c) => c.channel === 'web-ui')
  assert.ok(webui, 'web 侧至少要有 web-ui 通道')
  assert.equal(webui.confidence, 'verified')
  assert.ok(webui.label && webui.evidence, '界面要展示的证据/标签不能是空串')
})

test('★ app:probe（desktop）：surface 来自探测结果（含各层真实原因）', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => null, getWebContents: () => ({ send: () => {} }) })
  // 空文件 + .exe 后缀：process/script/file 三层探测都会失败 → 清单里是 unusable（带已排查原因）
  const dir = mkdtempSync(join(tmpdir(), 'probesurface-'))
  const stub = join(dir, 'nope.exe')
  writeFileSync(stub, '', 'utf-8')
  try {
    const r = await ipc.invoke('app:probe', { target: { type: 'desktop', exePath: stub } })
    assert.equal(r.driver, 'uia')
    assert.ok(r.surface, 'desktop 侧也要带 surface（这正是"无法接入"要讲清楚证据的地方）')
    assert.equal(r.surface.verdict, 'unusable')
    const dead = r.surface.capabilities.find((c) => c.channel === 'unusable')
    assert.ok(dead, '全不成立时要有 unusable 条目')
    assert.ok(String(dead.evidence).length > 0, '证据不能为空（用户要看到"排查过哪些通道、为什么不行"）')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
  }
})

test('app:probe 失败/不可达路径也带 surface 字段（值为 null，界面据此不渲染清单）', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => null, getWebContents: () => ({ send: () => {} }) })
  const r = await ipc.invoke('app:probe', { target: { type: 'web', url: 'https://example.com' } })
  assert.equal(r.reachable, false)
  assert.equal(r.surface, null, '执行器未就绪 ⇒ 没有清单可展示，如实给 null')
})
