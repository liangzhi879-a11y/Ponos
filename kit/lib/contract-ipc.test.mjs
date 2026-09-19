// kit/lib/contract-ipc.test.mjs —— T3 IPC 通道提取器（DevKit P1 · 契约快照）
//
// 为什么必须有这些断言：
//   · IPC 是**两方协议**：`ipcRenderer.invoke` ↔ `ipcMain.handle`、`ipcRenderer.send` ↔
//     `ipcMain.on`、主进程推送（`webContents.send` / 别名可选链 `wc?.send?.()`）↔
//     `ipcRenderer.on`。少一侧就是"渲染层点了没反应"，且不会有任何报错。
//   · 别名可选链**必须算推送侧**：真形态 `electron/app-ipc.cjs:140` 的
//     `wc?.send?.('app:generate-progress', …)` —— 只认 `webContents.send(` 的实现在真仓会漏 1 条。
//   · `on` 是**两个方向**的注册（main 侧 `ipcMain.on` 收 `send`；renderer 侧 `ipcRenderer.on` 收推送），
//     两侧在真仓互不重叠 ⇒ 测试要钉住"拆得开、且两两配对差集为空"。
//   · `removeListener('x')` 不是注册：只写过 removeListener 的通道不得进集合。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackedFiles, codeFiles, readTracked } from './scan.mjs'
import { extractIpc } from './contract-ipc.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function fixture(filesMap) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-ct-ipc-'))
  for (const [rel, content] of Object.entries(filesMap)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return { root, read: (file) => readTracked({ root, file }) }
}

const PRELOAD = [
  'const { contextBridge, ipcRenderer } = require("electron")',
  'contextBridge.exposeInMainWorld("yfworking", {',
  "  appList: () => ipcRenderer.invoke('app:list'),",
  "  vaultStatus: () => ipcRenderer.invoke('vault:status'),",
  "  appRun: (payload) => ipcRenderer.invoke('app:run', payload)",
  "  missingHandler: () => ipcRenderer.invoke('app:missing'),",   // 无 handle（真仓不该有，夹具用来钉差集）
  "  close: () => ipcRenderer.send('window:close'),",
  "  onBootProgress: (l) => { ipcRenderer.on('boot:progress', l); return () => ipcRenderer.removeListener('boot:progress', l) },",
  "  onGenerateProgress: (l) => ipcRenderer.on('app:generate-progress', l),",
  "  onNeverRegistered: () => ipcRenderer.removeListener('app:never-registered', () => {}),",
  '})',
  '',
].join('\n')

const MAIN = [
  'const { ipcMain, BrowserWindow } = require("electron")',
  "ipcMain.handle('app:list', () => registry.listApps())",
  "ipcMain.handle('app:extra', () => 1)",                        // 对端没 invoke（夹具用来钉差集）
  "ipcMain.on('window:close', () => win.close())",
  "function boot() { mainWindow.webContents.send('boot:progress', { step: 1 }) }",
  '',
].join('\n')

const APP_IPC = [
  "ipcMain.handle('app:run', (_e, payload) => runAppCommand(payload))",
  "function emit(p) { wc?.send?.('app:generate-progress', { appId: p.appId, at: Date.now() }) }",
  '',
].join('\n')

const VAULT_IPC = [
  "ipcMain.handle('vault:status', () => vault.status())",
  '',
].join('\n')

const FIXTURE = {
  'electron/preload.cjs': PRELOAD,
  'electron/main.cjs': MAIN,
  'electron/app-ipc.cjs': APP_IPC,
  'electron/vault-ipc.cjs': VAULT_IPC,
  'src/lib/fake.ts': "window.ipcRenderer.invoke('nope:channel')\n",   // 域外：渲染层不直接持有 ipcRenderer
}

function extract(filesMap = FIXTURE) {
  const fx = fixture(filesMap)
  const files = codeFiles(trackedFiles({ root: fx.root }), { includeTests: false })
  return { ...fx, files, out: extractIpc({ files, readTracked: fx.read }) }
}

test('★五方集合：invoke / handle / send / on / push 各就各位（域外文件不参与）', () => {
  const { out, files } = extract()
  assert.deepEqual([...out.invoke].sort(), ['app:list', 'app:missing', 'app:run', 'vault:status'])
  assert.deepEqual([...out.handle].sort(), ['app:extra', 'app:list', 'app:run', 'vault:status'])
  assert.deepEqual([...out.send].sort(), ['window:close'])
  assert.deepEqual([...out.on].sort(), ['app:generate-progress', 'boot:progress', 'window:close'],
    'on 是两侧注册的并集：main 侧 ipcMain.on(window:close) + renderer 侧 ipcRenderer.on[boot:progress, app:generate-progress]')
  assert.deepEqual([...out.push].sort(), ['app:generate-progress', 'boot:progress'])
  assert.equal([...out.invoke].includes('nope:channel'), false, '扫描域 = electron/**；渲染层源码里的字符串不是 IPC 注册')
  assert.deepEqual(files, [...files].sort())
})

test('★别名可选链 wc?.send?.() 也算推送侧（否则 app:generate-progress 静默漏掉）', () => {
  const { out } = extract()
  assert.ok(out.push.has('app:generate-progress'))
  assert.equal(out.on.has('app:generate-progress'), true, '渲染层订阅与主进程推送必须能配对')
})

test('★removeListener 不是注册：只写过 removeListener 的通道不得进 on', () => {
  const { out } = extract()
  assert.equal(out.on.has('app:never-registered'), false)
  assert.equal([...out.on].includes('app:never-registered'), false)
  assert.equal(out.push.has('app:never-registered'), false)
})

test('★两方配对差集：invoke↔handle 与 send↔main-on 的缺侧必须一眼可辨（夹具里刻意造缺侧）', () => {
  const { out, files, read } = extract()
  const invokeOnly = [...out.invoke].filter((c) => !out.handle.has(c)).sort()
  const handleOnly = [...out.handle].filter((c) => !out.invoke.has(c)).sort()
  assert.deepEqual(invokeOnly, ['app:missing'], '缺 handle 的 invoke 必须能列出来（CT5 的判据）')
  assert.deepEqual(handleOnly, ['app:extra'], '缺 invoke 的 handle 同样')
  // 推送侧：每条 push 都要有 renderer 侧订阅（否则消息发出去没人收）
  const pushOnly = [...out.push].filter((c) => !out.on.has(c)).sort()
  assert.deepEqual(pushOnly, [])
  // 两侧拆得开（本提取器只给并集，配对要按 side 拆 ⇒ 用文件子集再跑一次）
  const preloadOnly = extractIpc({ files: files.filter((f) => f.includes('preload')), readTracked: read })
  const mainOnly = extractIpc({ files: files.filter((f) => !f.includes('preload')), readTracked: read })
  assert.deepEqual([...preloadOnly.on].sort(), ['app:generate-progress', 'boot:progress'],
    'renderer 侧的 on 只有订阅通道')
  assert.deepEqual([...mainOnly.on].sort(), ['window:close'], 'main 侧的 on 只有 ipcMain.on')
  assert.deepEqual([...preloadOnly.push].sort(), [], 'preload 里没有推送发送点')
  assert.deepEqual([...mainOnly.push].sort(), ['app:generate-progress', 'boot:progress'])
})

test('真仓：invoke=handle=61、send=mainOn=10、push=rendererOn=7，且四方配对差集为空', () => {
  const files = codeFiles(trackedFiles({ root: ROOT }), { includeTests: false })
  const out = extractIpc({ files, readTracked: (f) => readTracked({ root: ROOT, file: f }) })
  assert.equal(out.invoke.size, 61, 'preload 的 invoke 通道数（P1 计划记 61）')
  assert.equal(out.handle.size, 61, 'main.cjs 28 + app-ipc.cjs 23 + vault-ipc.cjs 10 = 61')
  assert.equal(out.send.size, 10)
  assert.equal(out.push.size, 7)
  assert.equal(out.on.size, 17, 'on = main 侧 10 + renderer 侧 7（两侧互不重叠）')
  // ★ 真仓的配对必须**零缺侧**：少一侧 = 调用打空且不报错，这是 CT5 在生产里守的东西
  assert.deepEqual([...out.invoke].filter((c) => !out.handle.has(c)), [], '有 invoke 无 handle')
  assert.deepEqual([...out.handle].filter((c) => !out.invoke.has(c)), [], '有 handle 无 invoke')
  const preloadOnly = extractIpc({ files: files.filter((f) => f.includes('preload')), readTracked: (f) => readTracked({ root: ROOT, file: f }) })
  const mainOnly = extractIpc({ files: files.filter((f) => !f.includes('preload')), readTracked: (f) => readTracked({ root: ROOT, file: f }) })
  assert.equal(preloadOnly.on.size, 7, 'renderer 侧订阅数')
  assert.equal(mainOnly.on.size, 10, 'main 侧 ipcMain.on 数')
  assert.deepEqual([...out.send].filter((c) => !mainOnly.on.has(c)), [], '有 send 无 ipcMain.on')
  assert.deepEqual([...out.push].filter((c) => !preloadOnly.on.has(c)), [], '有推送无渲染层订阅')
})
