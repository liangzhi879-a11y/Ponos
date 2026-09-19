// kit/lib/contract-ipc.mjs —— Electron IPC 通道提取器（DevKit P1 · T3）
//
// 设计不变量（每条都由 kit/lib/contract-ipc.test.mjs 的断言钉住）：
//   I1 IPC 是**两方协议**，五个集合就是它的两侧：
//        · `invoke` ↔ `handle`   —— `ipcRenderer.invoke` ↔ `ipcMain.handle`（请求/应答）
//        · `send`   ↔ `on`（main 侧）—— `ipcRenderer.send` ↔ `ipcMain.on`（单向投递）
//        · `push`   ↔ `on`（renderer 侧）—— 主进程推送 ↔ `ipcRenderer.on` 订阅
//      **`on` 是两侧注册的并集**（契约里只有五个键，没有第六个 `sub`）：真仓 main 侧 10 条、
//      renderer 侧 7 条，两侧互不重叠。配对要按 side 拆时，用 `files` 子集再跑一次即可
//      （测试里有这用法：只传 preload 的候选文件 → 只拿到 renderer 侧）——这样既守住了
//      契约的固定形状，又不必再开第六个键。
//   I2 推送侧白名单必须含**别名可选链**：真形态 `electron/app-ipc.cjs:140`
//      `wc?.send?.('app:generate-progress', …)` —— 只认 `webContents.send(` 会静默漏一条。
//   I3 `removeListener` / `off` **不是注册**：只写过 removeListener 的通道不得进集合
//      （真形态 preload.cjs 的 `return () => ipcRenderer.removeListener('app:generate-progress', l)`）。
//   I4 扫描域 = `electron/**`（主进程与 preload 才持有 ipcMain/ipcRenderer）；渲染层源码里的
//      同名字符串不是 IPC 注册。
import { stripComments } from './scan.mjs'

/** 扫描域：只有 Electron 主进程/preload 一侧会注册通道 */
export function inIpcDomain(file) {
  return file.startsWith('electron/') && /\.(?:cjs|mjs|js)$/.test(file)
}

/** 五个集合各自的识别式（左 = 渲染层调用侧，右 = 主进程注册侧 / 推送侧） */
const PATTERNS = {
  invoke: /ipcRenderer\s*\.\s*invoke\s*\(\s*'([^']+)'/g,
  send: /ipcRenderer\s*\.\s*send\s*\(\s*'([^']+)'/g,
  onRenderer: /ipcRenderer\s*\.\s*on\s*\(\s*'([^']+)'/g,
  handle: /ipcMain\s*\.\s*handle\s*\(\s*'([^']+)'/g,
  onMain: /ipcMain\s*\.\s*on\s*\(\s*'([^']+)'/g,
}

/** 主进程 → 渲染层推送：`webContents.send('ch'…)` 与别名可选链 `wc?.send?.('ch'…)`。
 *  ★ `?.` 两处都要能缺省：`webContents.send(` / `mainWindow.webContents.send(` /
 *  `wc?.send?.(`) —— 少写一个 `.` 就会"整条静默漏掉"（本文件最初就漏了这处）。 */
const PUSH_PATTERNS = [
  /webContents\s*\??\s*\.\s*send\s*\??\s*\.?\s*\(\s*'([^']+)'/g,
  /(?<![\w.])(?:wc|win|w|mainWindow|editorWin|editorWindow|browserWin)\s*\?\s*\.\s*send\s*\?\s*\.?\s*\(\s*'([^']+)'/g,
]

/** 每类的出现次数（用于"提取守恒"：集合去重后的条数不能大于出现次数） */
function collect(re, code, into, counter) {
  const rx = new RegExp(re.source, 'g')
  let m
  while ((m = rx.exec(code))) { into.add(m[1]); counter.n++ }
}

/**
 * 提取 IPC 通道（五个集合都是 `Set<string>`）。
 * @param {{files?: string[], readTracked?: (file: string) => (string|null)}} p
 * @returns {{invoke:Set<string>, handle:Set<string>, send:Set<string>, on:Set<string>, push:Set<string>}}
 */
export function extractIpc({ files = [], readTracked } = {}) {
  if (!Array.isArray(files)) throw new Error('extractIpc: files 必须是数组（来自 scan.mjs#trackedFiles）')
  if (typeof readTracked !== 'function') throw new Error('extractIpc: readTracked(file) 必须注入')

  const invoke = new Set()
  const handle = new Set()
  const send = new Set()
  const on = new Set()
  const push = new Set()
  const counter = { n: 0 }

  for (const file of files) {
    if (!inIpcDomain(file)) continue
    const text = readTracked(file)
    if (typeof text !== 'string') continue
    const code = stripComments(text)
    collect(PATTERNS.invoke, code, invoke, counter)
    collect(PATTERNS.handle, code, handle, counter)
    collect(PATTERNS.send, code, send, counter)
    collect(PATTERNS.onRenderer, code, on, counter)
    collect(PATTERNS.onMain, code, on, counter)
    for (const re of PUSH_PATTERNS) collect(re, code, push, counter)
  }
  return { invoke, handle, send, on, push }
}
