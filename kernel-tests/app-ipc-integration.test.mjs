// Task 1.5~2.3 接线集成测试：用一个假 ipcMain 把 app:* 全部通道跑一遍
//
// 为什么需要它：单测各自覆盖了 profiler / runner / bindings，但"主进程注册层"的
// 组装错误（roots 传错、driver 分发漏分支、留痕漏调用）只在集成层面暴露。
// 这里不依赖 Electron：假 ipcMain 收下 handler 直接调用，数据根指向临时目录。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const home = mkdtempSync(join(tmpdir(), 'appipc-'))
process.env.YFWORKING_HOME = home
delete process.env.CLAUDE_CONFIG_DIR

const { registerAppHandlers } = require('../electron/app-ipc.cjs')

/** 假 ipcMain：收集 handler，暴露 invoke 便于按渠道调用 */
function fakeIpcMain() {
  const handlers = new Map()
  return {
    handle: (ch, fn) => handlers.set(ch, fn),
    invoke: (ch, ...args) => {
      const fn = handlers.get(ch)
      if (!fn) throw new Error(`未注册渠道：${ch}`)
      return fn({}, ...args)
    },
    channels: () => [...handlers.keys()],
  }
}

const fakeExecutor = (calls) => {
  const sessions = []   // 每次 exec 收到的会话/分区键（断言"键由 appSessionKey 产出"用）
  return {
    openedWindows: [],
    sessions,
    async openWindow(sessionId) { this.openedWindows.push(sessionId); return { ok: true } },
    exec: async (_s, act, params) => {
      calls.push([act, params])
      sessions.push(_s)
      if (act === 'goto' && String(params.url).includes('bad.example')) return { ok: false, error: '页面打不开' }
      return { ok: true, snapshot: { title: '示例站', url: params?.url, text: 'body', page: { url: params?.url, title: '示例站' } } }
    },
  }
}

const SPEC = {
  specVersion: 1, appId: 'demo', name: '演示站',
  driver: 'browser', target: { type: 'web', url: 'https://example.com' },
  expose: { mode: 'console' },
  commands: [
    { action: 'query', title: '查单', kind: 'read',
      params: [{ name: 'orderId', required: true }],
      steps: [{ act: 'goto', url: '/o/${orderId}' }, { act: 'snapshot', save: 'result' }] },
    { action: 'submit', title: '提交', kind: 'write', params: [], steps: [{ act: 'click', selector: '#ok' }] },
  ],
}

test('app:* 19 条通道全部注册（新增 app:login-done / app:login-cancel 登录信号）', () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor([]) })
  assert.equal(ipc.channels().length, 19)
})

test('CRUD → Spec → 自检 全链路（数据落在 YFWORKING_HOME/apps）', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor([]) })

  assert.deepEqual(await ipc.invoke('app:list'), [])
  await ipc.invoke('app:upsert', { id: 'demo', name: '演示站', targetType: 'web', enabled: true })
  const list = await ipc.invoke('app:list')
  assert.equal(list.length, 1)
  assert.ok(existsSync(join(home, 'apps', 'registry.json')))

  await ipc.invoke('app:write-spec', { appId: 'demo', spec: SPEC })
  assert.ok(existsSync(join(home, 'apps', 'demo', 'spec.json')))
  const spec = await ipc.invoke('app:read-spec', 'demo')
  assert.equal(spec.name, '演示站')

  assert.equal((await ipc.invoke('app:check', 'demo')).status, 'healthy')
})

test('app:probe（web）真实走执行器并回传 driver/title', async () => {
  const calls = []
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor(calls) })
  const r = await ipc.invoke('app:probe', { target: { type: 'web', url: 'https://example.com' } })
  assert.equal(r.driver, 'browser')
  assert.equal(r.reachable, true)
  assert.equal(r.title, '示例站')
  assert.deepEqual(calls.map((c) => c[0]), ['goto', 'snapshot'])
})

test('app:probe（web）不可达：ok=true 但 reachable=false 且带错误（不抛给渲染层）', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor([]) })
  const r = await ipc.invoke('app:probe', { target: { type: 'web', url: 'https://bad.example' } })
  assert.equal(r.ok, true)
  assert.equal(r.reachable, false)
  assert.ok(r.error.includes('打不开'))
})

test('app:probe 无执行器：明确报"未就绪"（不伪装成功）', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => null })
  const r = await ipc.invoke('app:probe', { target: { type: 'web', url: 'https://example.com' } })
  assert.equal(r.reachable, false)
  assert.ok(r.error.includes('未就绪'))
})

test('app:probe（desktop）目标无 CLI/脚本接口 → 降级 uia 且不报可达', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => null })
  // 造一个"看起来是可执行文件但其实跑不起来"的目标（空文件 + .exe 后缀）：
  // process 探测会因为无法执行而失败，script 探测因同级目录无脚本目录而失败 → uia
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'))
  const stub = join(stubDir, 'nope.exe')
  writeFileSync(stub, '', 'utf-8')
  try {
    const r = await ipc.invoke('app:probe', { target: { type: 'desktop', exePath: stub } })
    assert.equal(r.driver, 'uia')
    assert.equal(r.reachable, false, 'uia 后端未接入，不得报可达')
  } finally { rmSync(stubDir, { recursive: true, force: true }) }
})

test('app:probe（desktop）目标自带 CLI → process（真实跑了一次 --help）', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => null })
  const r = await ipc.invoke('app:probe', { target: { type: 'desktop', exePath: process.execPath } })
  assert.equal(r.driver, 'process')
  assert.equal(r.reachable, true, 'process 层可直接执行，视为可达')
  assert.ok(String(r.evidence?.help || '').length > 0, '应带回 --help 输出作为证据')
})

test('app:probe（desktop）系统目录目标被守卫拦下（不去拉系统进程）', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => null })
  const sysExe = process.platform === 'win32'
    ? (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\cmd.exe'
    : '/bin/sh'
  const r = await ipc.invoke('app:probe', { target: { type: 'desktop', exePath: sysExe } })
  assert.equal(r.driver, 'uia', '守卫拒绝后应降级而非报错')
  assert.equal(r.reachable, false)
})

test('app:run（browser）执行 + 留痕；缺参不执行', async () => {
  const calls = []
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor(calls) })

  const ok = await ipc.invoke('app:run', { appId: 'demo', action: 'query', args: { orderId: 'A1' }, sessionId: 's1' })
  assert.equal(ok.ok, true)
  assert.equal(ok.kind, 'read')
  // 相对路径必须补成绝对地址（白名单按主机名判定，相对路径会被误判为"不在白名单"）
  assert.equal(calls[0][1].url, 'https://example.com/o/A1')

  const before = calls.length
  const bad = await ipc.invoke('app:run', { appId: 'demo', action: 'query', args: {}, sessionId: 's1' })
  assert.equal(bad.ok, false)
  assert.equal(calls.length, before, '缺参不得发起任何浏览器动作')

  const hist = join(home, 'apps', 'demo', 'history')
  assert.ok(existsSync(hist), '执行必须留痕')
})

test('app:run（browser）无执行器 → 结构化错误', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => null })
  const r = await ipc.invoke('app:run', { appId: 'demo', action: 'query', args: { orderId: 'A1' }, sessionId: 's1' })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('未就绪'))
})

test('app:run（desktop, process 驱动）走 desktopRunner 并留痕', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor([]) })
  // 造一个真实可执行目标：node 自身 + --version（cli 步骤跑真进程，验证端到端）
  await ipc.invoke('app:write-spec', {
    appId: 'cli-app',
    spec: { specVersion: 1, appId: 'cli-app', name: 'CLI', driver: 'process',
            target: { type: 'desktop', exePath: process.execPath },
            expose: { mode: 'console' },
            commands: [{ action: 'ver', kind: 'read', params: [], steps: [{ act: 'cli', argv: ['--version'], save: 'out' }] }] },
  })
  const r = await ipc.invoke('app:run', { appId: 'cli-app', action: 'ver', args: {}, sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.ok(String(r.data).includes('v'), '应回传 node 版本')
  assert.ok(existsSync(join(home, 'apps', 'cli-app', 'history')), 'desktop 执行同样留痕')
})

test('控制台绑定：进入/查询/离开 + 严格单开', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor([]) })
  assert.equal(await ipc.invoke('app:console-bound', 's1'), null)
  await ipc.invoke('app:console-enter', { sessionId: 's1', appId: 'demo' })
  assert.equal(await ipc.invoke('app:console-bound', 's1'), 'demo')
  await ipc.invoke('app:console-enter', { sessionId: 's1', appId: 'cli-app' })
  assert.equal(await ipc.invoke('app:console-bound', 's1'), 'cli-app')
  // 迟到的 A 离开事件不得清掉当前的 cli-app
  await ipc.invoke('app:console-leave', { sessionId: 's1', appId: 'demo' })
  assert.equal(await ipc.invoke('app:console-bound', 's1'), 'cli-app')
  await ipc.invoke('app:console-leave', { sessionId: 's1', appId: 'cli-app' })
  assert.equal(await ipc.invoke('app:console-bound', 's1'), null)
})

test('内核侧能读到完全相同的绑定文件（跨层口径一致）', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor([]) })
  await ipc.invoke('app:console-enter', { sessionId: 'kernel-sid', appId: 'demo' })
  const raw = JSON.parse(readFileSync(join(home, 'apps', 'binding.json'), 'utf-8'))
  assert.equal(raw['kernel-sid'].appId, 'demo')
})

test('app:remove 删除条目（列表随之清空）', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor([]) })
  await ipc.invoke('app:remove', 'cli-app')
  const list = await ipc.invoke('app:list')
  assert.ok(!list.some((a) => a.id === 'cli-app'))
})

test('app:check 对损坏 Spec → broken（不让用户进空壳控制台）', async () => {
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor([]) })
  writeFileSync(join(home, 'apps', 'demo', 'spec.json'), JSON.stringify({
    specVersion: 1, appId: 'demo', name: '坏', driver: 'browser',
    target: { type: 'web', url: 'not-a-url' }, commands: [],
  }), 'utf-8')
  const c = await ipc.invoke('app:check', 'demo')
  assert.equal(c.status, 'broken')
  assert.ok(c.issues.length >= 2)
})

test.after(() => { rmSync(home, { recursive: true, force: true }) })

// ---------- app:login：可见登录窗口（"带登录态探索"的入口） ----------
//
// 自动化窗口平时是隐藏的（用户要求"能不弹就不弹"），于是用户没有任何地方可以登录。
// app:login 提供一个**用户主动触发**的可见窗口，并且必须与应用命令/模型探索共用同一个会话
//   —— 否则登录了也对命令没用（cookie 是按 persist:automation-<sessionId> 分区存的）。

test('app:login：用**站点级分区键**打开可见窗口并导航到目标网址（chat sessionId 不再决定分区）', async () => {
  const calls = []
  const exec = fakeExecutor(calls)
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => exec })
  // 渲染层仍在传 chat sessionId；契约：分区键一律由 appSessionKey 产出（web 按站点），
  // 否则换个聊天会话就要重新登录，且与生成/执行的登录态互相看不见。
  const r = await ipc.invoke('app:login', { url: 'kimi.com', sessionId: 'sess-42' })
  assert.equal(r.ok, true)
  assert.equal(r.key, 'app-site-kimi.com', '键的唯一出处是 appSessionKey')
  assert.equal(r.sessionId, r.key, 'sessionId 字段保留（= 键）以兼容渲染层旧代码')
  assert.deepEqual(exec.openedWindows, ['app-site-kimi.com'], '要显式打开（显示）窗口——这是用户主动要的')
  assert.deepEqual(exec.sessions, ['app-site-kimi.com'], '导航也必须用同一个键（登录态就存在这个分区里）')
  assert.deepEqual(calls[0], ['goto', { url: 'https://kimi.com/' }], '不带协议头的网址要被归一')
})

test('app:login：网址不合法/执行器未就绪 → 如实报错（不静默）', async () => {
  const ipc1 = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc1, getExecutor: () => fakeExecutor([]) })
  const bad = await ipc1.invoke('app:login', { url: '不是网址' })
  assert.equal(bad.ok, false)
  assert.ok(String(bad.error).includes('不合法'), bad.error)

  const ipc2 = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc2, getExecutor: () => null })
  const noExec = await ipc2.invoke('app:login', { url: 'https://example.com/' })
  assert.equal(noExec.ok, false)
  assert.ok(String(noExec.error).includes('未就绪'), noExec.error)
})

test('app:login：导航被拒时如实返回失败原因', async () => {
  const exec = fakeExecutor([])
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => exec })
  const r = await ipc.invoke('app:login', { url: 'https://bad.example/' })
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('打不开'), r.error)
})

// ---------- Task 6：登录态支持（键统一 + 两条登录信号通道 + 自检叠加登录结论） ----------

test('会话键统一：app:probe / app:run 一律用站点级键（chat sessionId 不再决定分区）', async () => {
  const probeCalls = []
  const probeExec = fakeExecutor(probeCalls)
  const ipc1 = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc1, getExecutor: () => probeExec })
  await ipc1.invoke('app:probe', { target: { type: 'web', url: 'https://example.com' }, appId: 'demo', sessionId: 'chat-s1' })
  assert.ok(probeExec.sessions.length >= 1)
  assert.ok(probeExec.sessions.every((s) => s === 'app-site-example.com'), `探测必须用站点级键：${JSON.stringify(probeExec.sessions)}`)

  const runCalls = []
  const runExec = fakeExecutor(runCalls)
  const ipc2 = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc2, getExecutor: () => runExec })
  await ipc2.invoke('app:write-spec', { appId: 'demo', spec: SPEC })
  const r = await ipc2.invoke('app:run', { appId: 'demo', action: 'query', args: { orderId: 'A1' }, sessionId: 'chat-s1' })
  assert.equal(r.ok, true)
  assert.ok(runExec.sessions.every((s) => s === 'app-site-example.com'), `执行必须用站点级键（登录态跨会话复用）：${JSON.stringify(runExec.sessions)}`)
})

test('app:check 叠加运行时登录结论：需要登录 + 分区无 Cookie → drifted + 中文提示（app-profiler 保持纯 node）', async () => {
  const spec = { ...SPEC, auth: { needsLogin: true, loginUrl: 'https://example.com/login' } }
  const withExec = (fingerprint) => {
    const exec = fakeExecutor([])
    exec.getCookieFingerprint = async (key, url) => { exec.fpArgs = [key, url]; return fingerprint }
    return exec
  }
  // ① 分区里没有 cookie（getCookieFingerprint 返回 'empty'）→ 如实报"未检测到登录态"
  const exec = withExec('empty')
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => exec })
  await ipc.invoke('app:write-spec', { appId: 'demo', spec })
  const drifted = await ipc.invoke('app:check', 'demo')
  assert.equal(drifted.status, 'drifted', `需要登录却无登录态 → 不能报 healthy：${JSON.stringify(drifted)}`)
  assert.ok(drifted.issues.some((i) => i.includes('需要登录') && i.includes('未检测到登录态')), drifted.issues.join('｜'))
  assert.ok(drifted.issues.some((i) => i.includes('登录此应用')), '要告诉用户下一步怎么办')
  assert.deepEqual(exec.fpArgs, ['app-site-example.com', 'https://example.com'], '自检必须按站点级键 + 目标 URL 读该分区的登录态')

  // ② 有 cookie → 保持原来的结论（不虚报问题）
  const ipc2 = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc2, getExecutor: () => withExec('n1:abc') })
  await ipc2.invoke('app:write-spec', { appId: 'demo', spec })
  assert.equal((await ipc2.invoke('app:check', 'demo')).status, 'healthy')

  // ③ 读 cookie 抛异常（执行器未就绪/electron 不可用）→ 按 'empty' 处理，绝不冒泡
  const bad = fakeExecutor([])
  bad.getCookieFingerprint = async () => { throw new Error('no electron') }
  const ipc3 = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc3, getExecutor: () => bad })
  await ipc3.invoke('app:write-spec', { appId: 'demo', spec })
  const r3 = await ipc3.invoke('app:check', 'demo')
  assert.equal(r3.status, 'drifted')
})

test('app:login-done / app:login-cancel：给等待中的登录发信号（false = 当前没有等待中的登录，不是错误）', async () => {
  const appLogin = require('../electron/app-login.cjs')
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor([]) })
  // 没有等待中的登录 → {ok:false}（只回传布尔值，渲染层不该当成"出错/请重试"）
  assert.deepEqual(await ipc.invoke('app:login-done', { key: 'nobody' }), { ok: false })
  assert.deepEqual(await ipc.invoke('app:login-cancel', { key: 'nobody' }), { ok: false })

  // 真实的登录编排等在那里（键与 app:generate/app:login 是同一个），用户点「我已完成登录」
  const key = 'app-site-x.com'
  const waiting = appLogin.ensureLoggedIn({
    key, url: 'https://x.com/login', executor: fakeExecutor([]), waitMs: 500, pollMs: 5,
  })
  assert.equal(appLogin.pendingCount(), 1, '前置：编排已在等待')
  assert.deepEqual(await ipc.invoke('app:login-done', { key }), { ok: true })
  const res = await waiting
  assert.equal(res.ok, true)
  assert.equal(res.reason, 'user-confirmed')
  // 结算即摘除登记：第二次发同一个键返回 false（这是必然结果，不是异常）
  assert.deepEqual(await ipc.invoke('app:login-done', { key }), { ok: false })
  assert.equal(appLogin.pendingCount(), 0)

  // 取消同理
  const waiting2 = appLogin.ensureLoggedIn({ key, url: 'https://x.com/login', executor: fakeExecutor([]), waitMs: 500, pollMs: 5 })
  assert.deepEqual(await ipc.invoke('app:login-cancel', { key }), { ok: true })
  const res2 = await waiting2
  assert.equal(res2.ok, false)
  assert.equal(res2.reason, 'cancelled')
})

// ─────────── 修补：会话键统一后，旧的固定探测会话常量已成死代码 ───────────
// 键必须由 appSessionKey() 产出（web 按站点、desktop 按 appId、兜底 app-probe）。
// 留一个"固定 app-probe"的导出极易被后来者当成可用常量去拼键 → 静默落到兜底分区 → Cookie 读空。
test('app-ipc 不再导出固定的探测会话常量（键一律由 appSessionKey 产出）', () => {
  const mod = require('../electron/app-ipc.cjs')
  assert.ok(!('PROBE_SESSION' in mod), 'PROBE_SESSION 已废弃，不得继续导出（会被误用于拼键）')
  const { appSessionKey } = require('../electron/app-session-key.cjs')
  assert.equal(typeof appSessionKey, 'function')
  assert.equal(appSessionKey({ appId: 'x', target: { type: 'web', url: 'https://www.x.com/a' } }), 'app-site-x.com')
})
