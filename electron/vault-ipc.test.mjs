// electron/vault-ipc.test.mjs —— 密码库 IPC 面 + 接线守卫
// node --test electron/vault-ipc.test.mjs
//
// 两件事：
//   ① 用假 ipcMain/clipboard 跑通 registerVaultHandlers，覆盖 A7（剪贴板定时清空）；
//   ② 源码级接线守卫：main.cjs 必须真的注册（且传 safeStorage）、preload 必须真的暴露
//      6 个方法。这类"漏接线"不会让任何编译或单测变红，只会表现为"点了没反应"，
//      所以必须显式钉住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerVaultHandlers, COPY_TTL_MS } from './vault-ipc.cjs'

function fakeCrypto() {
  return {
    isAvailable: () => true,
    encryptString: s => Buffer.from('X' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: b => Buffer.from(Buffer.from(b).toString('utf8').slice(1), 'base64').toString('utf8'),
  }
}

/** 收集注册的通道，返回触发函数 */
function fakeIpc() {
  const handlers = new Map()
  return {
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    call: (ch, ...args) => {
      const fn = handlers.get(ch)
      if (!fn) throw new Error(`通道未注册：${ch}`)
      return fn({}, ...args)
    },
    channels: () => [...handlers.keys()].sort(),
  }
}

function fakeClipboard() {
  const state = { text: '', clearCount: 0 }
  return {
    state,
    clipboard: {
      writeText: t => { state.text = t },
      readText: () => state.text,
      clear: () => { state.text = ''; state.clearCount++ },
    },
  }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'yfw-vault-ipc-'))
  const ipc = fakeIpc()
  const cb = fakeClipboard()
  const pending = []
  const api = registerVaultHandlers({
    ipcMain: ipc.ipcMain,
    home,
    crypto: fakeCrypto(),
    clipboard: cb.clipboard,
    setTimer: (fn, ms) => { pending.push({ fn, ms }); return { unref() {} } },
  })
  return { home, ipc, cb, pending, api, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/** 源码级守卫必须只看**代码**：注释里常写着"本模块不 require('electron')"这类话，
 * 直接在原文上断言会把说明文字当成违规（假红），进而逼人去删掉有用的注释。
 * 这里剥掉块注释与行注释；`https://` 这类字符串因前一个字符是 `:` 而不被剥离。 */
function codeOf(fileUrl) {
  return readFileSync(fileUrl, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

test('6 条通道全部注册（spec §5）', () => {
  const s = setup()
  try {
    assert.deepEqual(s.ipc.channels(), ['vault:copy', 'vault:list', 'vault:remove', 'vault:reveal', 'vault:status', 'vault:upsert', 'vault:secret-delete', 'vault:secret-get-all', 'vault:secret-keys', 'vault:secret-set'].sort())
  } finally { s.cleanup() }
})

test('IPC 往返：新增 → 列表（无 password）→ reveal → copy → 删除', async () => {
  const s = setup()
  try {
    const up = await s.ipc.call('vault:upsert', { name: '某系统', username: 'u', password: 'pw-123' })
    assert.equal(up.ok, true)
    assert.equal(up.entry.password, undefined, 'list/upsert 出站不得带 password')

    const list = await s.ipc.call('vault:list')
    assert.equal(list.entries.length, 1)
    assert.ok(!('password' in list.entries[0]))

    const rv = await s.ipc.call('vault:reveal', up.entry.id)
    assert.deepEqual(rv, { ok: true, password: 'pw-123' })

    const cp = await s.ipc.call('vault:copy', up.entry.id)
    assert.deepEqual(cp, { ok: true, clearInMs: COPY_TTL_MS })
    assert.equal(s.cb.state.text, 'pw-123', '复制应把密码写进剪贴板')

    assert.deepEqual(await s.ipc.call('vault:remove', up.entry.id), { ok: true })
    assert.deepEqual((await s.ipc.call('vault:list')).entries, [])
  } finally { s.cleanup() }
})

test('A7 剪贴板：TTL 到期且内容未变 → 清空', () => {
  const s = setup()
  try {
    const up = s.ipc.call('vault:upsert', { name: 'n', password: 'pw' })
    s.ipc.call('vault:copy', up.entry.id)
    assert.equal(s.cb.state.text, 'pw')
    assert.equal(s.pending.length, 1)
    assert.equal(s.pending[0].ms, COPY_TTL_MS)
    s.pending[0].fn()
    assert.equal(s.cb.state.text, '')
    assert.equal(s.cb.state.clearCount, 1)
  } finally { s.cleanup() }
})

test('A7 剪贴板：用户后来复制了别的东西 → 绝不覆盖（比不清空更让人恼火）', () => {
  const s = setup()
  try {
    const up = s.ipc.call('vault:upsert', { name: 'n', password: 'pw' })
    s.ipc.call('vault:copy', up.entry.id)
    s.cb.state.text = '用户自己后复制的内容'   // 模拟用户后续复制
    s.pending[0].fn()
    assert.equal(s.cb.state.text, '用户自己后复制的内容', '不得清掉用户的剪贴板')
    assert.equal(s.cb.state.clearCount, 0)
  } finally { s.cleanup() }
})

test('连续复制两条：旧定时器被取消，只有最后一枚定时器会动作', () => {
  const s = setup()
  try {
    const a = s.ipc.call('vault:upsert', { name: 'a', password: 'pw-a' })
    const b = s.ipc.call('vault:upsert', { name: 'b', password: 'pw-b' })
    void b
    s.ipc.call('vault:copy', a.entry.id)
    const bId = s.ipc.call('vault:list').entries.find(e => e.name === 'b').id
    s.ipc.call('vault:copy', bId)
    assert.equal(s.cb.state.text, 'pw-b')
    assert.equal(s.pending.length, 2)
    // 只跑最后一枚：仍在 TTL 内，内容应保持
    s.pending[1].fn()
    assert.equal(s.cb.state.text, '')
  } finally { s.cleanup() }
})

test('copy 的失败分支：不存在 / 空密码', () => {
  const s = setup()
  try {
    assert.equal(s.ipc.call('vault:copy', 'no-such-id').error, 'not_found')
    const up = s.ipc.call('vault:upsert', { name: 'n', password: 'p' })
    s.ipc.call('vault:upsert', { id: up.entry.id, name: 'n', password: '' })   // 显式清空
    const r = s.ipc.call('vault:copy', up.entry.id)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'invalid')
    assert.equal(s.cb.state.text, '', '失败时不得往剪贴板写东西')
  } finally { s.cleanup() }
})

test('安全性：copy 收 id 而非文本（明文不经渲染层）', () => {
  const src = readFileSync(new URL('./vault-ipc.cjs', import.meta.url), 'utf8')
  assert.match(src, /ipcMain\.handle\('vault:copy',\s*\(_e, id\)/, 'vault:copy 必须收 id')
  assert.ok(!/vault:copy',\s*\(_e, text/.test(src), 'vault:copy 不得接收明文文本')
  assert.ok(!/console\s*\./.test(src), 'vault-ipc.cjs 不得有 console 输出（明文可能进日志）')
})

test('接线守卫：main.cjs 真的注册了 vault 且传的是 safeStorage', () => {
  const src = readFileSync(new URL('./main.cjs', import.meta.url), 'utf8')
  assert.match(src, /require\('\.\/vault-ipc\.cjs'\)/, 'main.cjs 未 require vault-ipc')
  assert.match(src, /registerVaultHandlers\(\{/, 'main.cjs 未调用 registerVaultHandlers')
  assert.match(src, /crypto:\s*safeStorage/, '必须传 Electron safeStorage 作为加密器（OS 级加密）')
  assert.match(src, /clipboard\s*,?\s*\}/, '必须传 clipboard（复制能力）')
  // safeStorage 必须在 electron 解构里（漏了就是 undefined，运行期才炸）
  assert.match(src, /require\('electron'\)/, 'main.cjs 未 require electron')
  assert.match(src, /\bsafeStorage\b[^\n]*\}\s*=\s*require\('electron'\)/, 'safeStorage 未从 electron 解构')
})

test('接线守卫：preload 暴露 yfworkingVault 且方法齐全', () => {
  const src = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8')
  assert.match(src, /exposeInMainWorld\('yfworkingVault'/, 'preload 未暴露 yfworkingVault')
  for (const m of ['status', 'list', 'upsert', 'remove', 'reveal', 'copy']) {
    assert.ok(src.includes(m + ':'), `preload 缺方法 ${m}`)
  }
  for (const ch of ['vault:status', 'vault:list', 'vault:upsert', 'vault:remove', 'vault:reveal', 'vault:copy']) {
    assert.ok(src.includes(`invoke('${ch}'`), `preload 未转发通道 ${ch}`)
  }
})

test('UI 守卫：VaultPanel 走 vaultApi、不直连 bridge、不打印密码', () => {
  const src = codeOf(new URL('../src/components/vault/VaultPanel.tsx', import.meta.url))
  assert.match(src, /from '@\/lib\/vaultApi'/, 'UI 必须经数据层取数')
  assert.ok(!/window\.yfworkingVault/.test(src), 'UI 不得直接访问 bridge（降级与校验会绕过）')
  assert.ok(!/console\s*\./.test(src), 'UI 不得有 console 输出（可能带上明文密码）')
  // 编辑态留空必须"省略字段"：主进程把 password === '' 视为"清空"，
  // 若无条件提交 editor.password，编辑任何条目都会把已存密码清掉。
  assert.match(
    src,
    /\.\.\.\(editor\.password \? \{ password: editor\.password \} : \(editor\.id \? \{\} : \{ password: '' \}\)\)/,
    '编辑态留空必须省略 password 字段（传 "" 会被主进程理解为清空已存密码）',
  )
  // 失败态不得与空库混同
  assert.match(src, /list\.ok/, 'UI 必须显式区分 list 失败')
})

test('文件不落地于仓库：vault 数据只写 YFW_HOME', () => {
  const src = readFileSync(new URL('./vault.cjs', import.meta.url), 'utf8')
  assert.ok(!/process\.cwd\(\)/.test(src), '不得把库写到当前工作目录（会污染用户项目）')
  assert.match(src, /join\(home, FILE_NAME\)/, '库路径应由传入的 home 派生')
})

test('无侵入：vault 模块不 require electron（保证可在 node 下单测）', () => {
  assert.ok(!/require\('electron'\)/.test(codeOf(new URL('./vault.cjs', import.meta.url))), 'vault.cjs 不应直接 require electron')
  // vault-ipc 也不直接 require electron：加密器/剪贴板由 main.cjs 注入
  assert.ok(!/require\('electron'\)/.test(codeOf(new URL('./vault-ipc.cjs', import.meta.url))), 'vault-ipc 不应直接 require electron')
})

// ---------------- secrets（应用密钥）链路的守卫 ----------------

test('secrets IPC：注水 / 只回键名 / 写入 / 删除 全链路', () => {
  const s = setup()
  try {
    const chans = s.ipc.channels()
    for (const c of ['vault:secret-keys', 'vault:secret-get-all', 'vault:secret-set', 'vault:secret-delete']) {
      assert.ok(chans.includes(c), `缺通道 ${c}`)
    }
    assert.deepEqual(s.ipc.call('vault:secret-keys'), { ok: true, keys: [] })
    assert.equal(s.ipc.call('vault:secret-set', 'provider:p1:token', 'sk-live').ok, true)
    assert.deepEqual(s.ipc.call('vault:secret-keys'), { ok: true, keys: ['provider:p1:token'] })
    assert.deepEqual(s.ipc.call('vault:secret-get-all'), { ok: true, secrets: { 'provider:p1:token': 'sk-live' } })
    assert.equal(s.ipc.call('vault:secret-delete', 'provider:p1:token').ok, true)
    assert.deepEqual(s.ipc.call('vault:secret-get-all').secrets, {})
  } finally { s.cleanup() }
})

test('secrets 不混进密码列表（用户不该在界面上看到/删掉模型凭证）', () => {
  const s = setup()
  try {
    s.ipc.call('vault:secret-set', 'provider:p1:token', 'sk-live')
    assert.deepEqual(s.ipc.call('vault:list').entries, [], 'secrets 不得出现在密码条目列表里')
    const up = s.ipc.call('vault:upsert', { name: '某系统', password: 'p' })
    assert.equal(up.ok, true)
    assert.deepEqual(s.ipc.call('vault:list').entries.length, 1)
    assert.deepEqual(s.ipc.call('vault:secret-keys').keys, ['provider:p1:token'], '写密码不得影响密钥')
  } finally { s.cleanup() }
})

test('接线守卫：preload 暴露 secrets 四方法', () => {
  const src = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8')
  for (const m of ['secretKeys', 'secretGetAll', 'secretSet', 'secretDelete']) {
    assert.ok(src.includes(m + ':'), `preload 缺方法 ${m}`)
  }
  for (const ch of ['vault:secret-keys', 'vault:secret-get-all', 'vault:secret-set', 'vault:secret-delete']) {
    assert.ok(src.includes(`invoke('${ch}'`), `preload 未转发通道 ${ch}`)
  }
})

test('守卫：localStorage 不再残留密钥（partialize 剥秘密 + 启动注水 + 擦除历史明文）', () => {
  const src = codeOf(new URL('../src/stores/settingsStore.ts', import.meta.url))
  assert.match(src, /partialize:\s*\(state\)\s*=>\s*\(\{\s*settings:\s*stripSecretsFromPersisted\(/, 'persist 必须剥离密钥后再落盘')
  assert.match(src, /hydrateSecretsFromVault/, '必须提供启动注水')
  assert.match(src, /secretGate\.canSync\(\)/, '写回必须过注水闸门（否则注水前会清空全部密钥）')
  // 擦除历史明文：注水后触发一次全量持久化重写
  assert.match(src, /markHydrated\(\)/, '注水完成后必须开闸')
  const main = codeOf(new URL('../src/main.tsx', import.meta.url))
  assert.match(main, /hydrateSecretsFromVault\(\)/, '每个渲染进程入口都要触发注水（否则界面看到"没配密钥"）')
})
