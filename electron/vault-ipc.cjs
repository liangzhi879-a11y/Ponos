'use strict'
// electron/vault-ipc.cjs —— 密码库 IPC 面（spec §5）
//
// 只在主进程持有解密后的明文，渲染层按需单条申请（D3）。
//
// 一处刻意的设计：`vault:copy` 收的是**条目 id**，不是待复制的文本。
// 若收文本，渲染层就得先拿到明文再回传——等于把明文多走一趟 IPC、多留一份在渲染进程内存里。
// 收 id 则由主进程内部 reveal→写剪贴板，明文不落到渲染层（除用户点"显示"那一处）。
const { createVault } = require('./vault.cjs')

/** 剪贴板保留时长：够用户粘贴，又不至于长期躺在剪贴板历史里 */
const COPY_TTL_MS = 30_000

/**
 * 注册密码库通道。
 * @param {object} opts
 * @param {import('electron').IpcMain} opts.ipcMain
 * @param {string} opts.home                       数据根（ensureYfwHome()）
 * @param {any} opts.crypto                        加密器（Electron safeStorage）
 * @param {any} opts.clipboard                     Electron clipboard
 * @param {(fn:Function, ms:number)=>any} [opts.setTimer] 便于测试注入
 */
function registerVaultHandlers({ ipcMain, home, crypto, clipboard, setTimer = setTimeout }) {
  const vault = createVault({ home, crypto })

  // 剪贴板定时清空（D7 / A7）：只在"内容仍是我们写进去的"时候清，
  // 否则会覆盖用户后来复制的东西——那比不清更让人恼火。
  let timer = null
  let mine = null
  function copySecret(text) {
    clipboard.writeText(text)
    mine = text
    if (timer) clearTimeout(timer)
    timer = setTimer(() => {
      timer = null
      try {
        if (mine !== null && clipboard.readText() === mine) clipboard.clear()
      } catch { /* 剪贴板被占用/不可用：静默，不值得打断用户 */ }
      mine = null
    }, COPY_TTL_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()   // 不因待清空的定时器吊住进程
  }

  ipcMain.handle('vault:status', () => vault.status())
  ipcMain.handle('vault:list', () => vault.list())
  ipcMain.handle('vault:upsert', (_e, payload) => vault.upsert(payload))
  ipcMain.handle('vault:remove', (_e, id) => vault.remove(String(id || '')))
  ipcMain.handle('vault:reveal', (_e, id) => vault.reveal(String(id || '')))
  ipcMain.handle('vault:copy', (_e, id) => {
    const r = vault.reveal(String(id || ''))
    if (!r.ok) return r
    if (!r.password) return { ok: false, error: 'invalid', message: '该条目没有保存密码' }
    copySecret(r.password)
    return { ok: true, clearInMs: COPY_TTL_MS }
  })

  // ---- 应用密钥（secrets）：模型供应商 authToken 等 ----
  // 这些值不进密码列表 UI，只在启动注水 / 写入时经过 IPC。
  // 单独给 keys 通道：UI 想知道"配没配"时不必把值捞出来。
  ipcMain.handle('vault:secret-keys', () => vault.listSecretKeys())
  ipcMain.handle('vault:secret-get-all', () => vault.getSecrets())
  ipcMain.handle('vault:secret-set', (_e, key, value) => vault.setSecret(String(key ?? ''), value))
  ipcMain.handle('vault:secret-delete', (_e, key) => vault.deleteSecret(String(key ?? '')))

  return { vault, COPY_TTL_MS }
}

module.exports = { registerVaultHandlers, COPY_TTL_MS }
