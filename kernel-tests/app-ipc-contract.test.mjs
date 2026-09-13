// 应用智控 IPC 契约：preload 实际暴露的 API ↔ 主进程注册的通道，必须完全一致
//
// 为什么要有这个测试（真实事故）：preload 与主进程各写一遍渠道名字符串，任一侧改名/漏写
// 就变成"点了没反应"（invoke 永不返回 → 前端 Promise 挂起，且没有任何报错）。
//
// ★ 教训：最初版本只用 `grep` 断言"文件里出现过 'app:list'"——结果 11 个方法被插进了
//   隔壁的 yfworkingWindow 对象（而不是 yfworkingAPI），文本断言照样通过，症状是
//   "点新增应用毫无反应"。所以现在改为**用 mock electron 真加载 preload.cjs**，
//   直接枚举 contextBridge 暴露出来的键，并断言它们落在 yfworkingAPI 上。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)

// ★ 必须 fileURLToPath：Windows 上 URL.pathname 会带前导斜杠（/C:/...），require 解析不了
const PRELOAD = fileURLToPath(new URL('../electron/preload.cjs', import.meta.url))

/** 渠道 → 渲染层方法名（本文件是唯一真源，按任务递增） */
const CHANNELS = {
  'app:list': 'appList',
  'app:upsert': 'appUpsert',
  'app:remove': 'appRemove',
  'app:read-spec': 'appReadSpec',
  'app:write-spec': 'appWriteSpec',
  'app:console-enter': 'appEnterConsole',
  'app:console-leave': 'appLeaveConsole',
  'app:console-bound': 'appBound',
  'app:probe': 'appProbe',
  'app:run': 'appRun',
  'app:check': 'appCheck',
}

// 主进程侧 handler 落在独立模块（app-ipc.cjs），main.cjs 只调用其注册函数——
// 故"主进程侧声明"= 两个文件合并看，与 preload 对称。
const MAIN_FILES = ['../electron/main.cjs', '../electron/app-ipc.cjs']
// 既有非应用智控的 app:* 通道（托盘/通知/主题落盘），不属于本模块
const PRE_EXISTING = new Set(['app:set-tray-behavior', 'app:notify-task', 'app:save-theme'])

const readMainSide = () =>
  MAIN_FILES.map((f) => readFileSync(new URL(f, import.meta.url), 'utf-8')).join('\n')

/**
 * 用 mock 的 electron 模块加载 preload.cjs，返回 contextBridge 真正暴露的全部键值。
 * 这是唯一能证明"渲染层拿得到"的方式——文本匹配证明不了对象层级。
 */
function loadExposed() {
  const Module = require('node:module')
  const exposed = {}
  const calls = []
  const ipcRenderer = {
    invoke: (ch, ...a) => { const r = { ch, a, value: null }; calls.push(r); return Promise.resolve(r) },
    send: () => {}, on: () => {}, once: () => {}, removeListener: () => {}, removeAllListeners: () => {},
  }
  const orig = Module._load
  Module._load = function (req) {
    if (req === 'electron') {
      return {
        ipcRenderer,
        contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v } },
        ipcMain: { handle: () => {} },
        app: { getPath: () => require('node:os').homedir() },
        shell: {},
      }
    }
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(PRELOAD)]
    require(PRELOAD)
  } finally {
    Module._load = orig
  }
  return { exposed, calls }
}

test('preload 真加载：11 个 app 方法都暴露在 yfworkingAPI 上', () => {
  const { exposed } = loadExposed()
  const api = exposed.yfworkingAPI
  assert.ok(api, 'preload 必须暴露 yfworkingAPI')
  for (const [ch, method] of Object.entries(CHANNELS)) {
    assert.equal(typeof api[method], 'function', `yfworkingAPI.${method} 缺失（渠道 ${ch}）`)
  }
})

test('preload 真加载：app 方法不得错位到其它 world 对象（本轮真实事故的回归）', () => {
  const { exposed } = loadExposed()
  for (const [world, obj] of Object.entries(exposed)) {
    if (world === 'yfworkingAPI') continue
    for (const method of Object.values(CHANNELS)) {
      assert.notEqual(typeof obj?.[method], 'function', `${method} 错位暴露在 ${world} 上`)
    }
  }
})

test('preload 真加载：调用方法确实发出对应渠道（名对名）', async () => {
  const { exposed, calls } = loadExposed()
  const api = exposed.yfworkingAPI
  for (const [ch, method] of Object.entries(CHANNELS)) {
    calls.length = 0
    await api[method]('payload')
    assert.equal(calls.length, 1, `${method} 未发出调用`)
    assert.equal(calls[0].ch, ch, `${method} 发出的是 ${calls[0].ch}，应为 ${ch}`)
  }
})

test('主进程侧：11 条渠道全部注册（文本层面）', () => {
  const main = readMainSide()
  for (const ch of Object.keys(CHANNELS)) {
    assert.ok(main.includes(`'${ch}'`), `main 缺少渠道 ${ch}`)
  }
})

test('main 侧不得出现未在清单中的 app: 渠道（防漏登记）', () => {
  const main = readMainSide()
  const found = new Set([...main.matchAll(/ipcMain\.handle\(\s*'(app:[^']+)'/g)].map((m) => m[1]))
  for (const ch of found) {
    if (PRE_EXISTING.has(ch)) continue
    assert.ok(Object.keys(CHANNELS).includes(ch), `main 注册了未登记渠道 ${ch}（请同步 CHANNELS 与 preload）`)
  }
})

test('main.cjs 真的调用了 registerAppHandlers（否则通道永不注册）', () => {
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf-8')
  assert.match(main, /registerAppHandlers\(\{/, 'main.cjs 未调用 registerAppHandlers')
  assert.match(main, /require\('\.\/app-ipc\.cjs'\)/, 'main.cjs 未引入 app-ipc.cjs')
})
