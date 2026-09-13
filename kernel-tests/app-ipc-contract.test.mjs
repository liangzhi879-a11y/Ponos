// 应用智控 IPC 契约：preload 与 main 侧声明的 app:* 渠道必须完全一致
//
// 为什么要有这个测试：preload 用 `ipcRenderer.invoke('app:x')`，主进程用
// `ipcMain.handle('app:x')` —— 两侧各写一遍字符串，任一侧改名/漏写就变成
// "点了没反应"（invoke 永不返回 → 前端 Promise 挂起，且没有任何报错）。
// 这类漂移在 tsc 与功能测试里都照不出来（渠道名只是普通字符串），故单独锁契约。
//
// 渠道清单按任务递增（本文件是唯一真源）：
//   Task 1.5：8 条（列表 / CRUD / Spec / 控制台绑定）
//   Task 1.7：+ app:probe（驱动探测）
//   Task 2.1：+ app:run（解释执行）
//   Task 2.3：+ app:check（进入控制台前的自检）
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const EXPECTED = [
  'app:list', 'app:upsert', 'app:remove', 'app:read-spec', 'app:write-spec',
  'app:console-enter', 'app:console-leave', 'app:console-bound',
  'app:probe', 'app:run', 'app:check',
]

// 主进程侧 handler 落在独立模块（app-ipc.cjs），main.cjs 只调用其注册函数——
// 故"主进程侧声明"= 两个文件合并看，与 preload 对称。
const MAIN_FILES = ['../electron/main.cjs', '../electron/app-ipc.cjs']

// 既有非应用智控的 app:* 通道（托盘/通知/主题落盘），不属于本模块
const PRE_EXISTING = new Set(['app:set-tray-behavior', 'app:notify-task', 'app:save-theme'])

function readMainSide() {
  return MAIN_FILES.map((f) => readFileSync(new URL(f, import.meta.url), 'utf-8')).join('\n')
}

test('preload 与 main 声明的 app:* 渠道完全一致', () => {
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf-8')
  const main = readMainSide()
  for (const ch of EXPECTED) {
    assert.ok(preload.includes(`'${ch}'`), `preload 缺少渠道 ${ch}`)
    assert.ok(main.includes(`'${ch}'`), `main 缺少渠道 ${ch}`)
  }
})

test('main 侧不得出现未在清单中的 app: 渠道（防漏登记）', () => {
  const main = readMainSide()
  const found = new Set([...main.matchAll(/ipcMain\.handle\(\s*'(app:[^']+)'/g)].map((m) => m[1]))
  for (const ch of found) {
    if (PRE_EXISTING.has(ch)) continue
    assert.ok(EXPECTED.includes(ch), `main 注册了未登记渠道 ${ch}（请同步 EXPECTED 与 preload）`)
  }
})

test('preload 不得出现 main 未注册的 app:* 渠道（反向防漏登记）', () => {
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf-8')
  const found = new Set([...preload.matchAll(/ipcRenderer\.invoke\(\s*'(app:[^']+)'/g)].map((m) => m[1]))
  for (const ch of found) {
    if (PRE_EXISTING.has(ch)) continue
    assert.ok(EXPECTED.includes(ch), `preload 调用了未登记渠道 ${ch}`)
  }
})
