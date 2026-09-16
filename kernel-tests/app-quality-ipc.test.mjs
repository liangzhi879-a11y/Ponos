// 质检 IPC（Task 4）：app:verify / app:mark-quality 的**行为 + 静态**双守卫
//
// 为什么两条都要：
//   · 行为（用假 ipcMain 真跑一遍）：证明"试跑确实跑到了真实执行器、失败原因确实带回来、
//     history/备份确实没被污染"——这些只有跑起来才看得出来；
//   · 静态（源码断言）：证明 persist 固定 false、标记走 upsertApp 而不是 writeSpec。
//     它们是**将来被顺手改掉就会静默变味**的那种约束（比如有人把 persist 改成 true，
//     行为测试若只断言"试跑结果"照样全绿）。
//
// ★ 每个 test 用**独立的数据根**（临时目录）：备份数量/目录内容是断言对象，
//   共享一个 home 时前一个 test 的 write-spec 会留下 spec.bak，后一个 test 的
//   "不得产生备份"必然假红（第一版就是这么写错的）。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)

const { registerAppHandlers } = require('../electron/app-ipc.cjs')

const homes = []
/** 新建一个空的数据根并把它设为当前 YFWORKING_HOME（roots 是延迟解析的，注册前后设都行） */
function freshHome() {
  const h = mkdtempSync(join(tmpdir(), 'appquality-'))
  homes.push(h)
  process.env.YFWORKING_HOME = h
  delete process.env.PONOS_CONFIG_DIR
  return h
}

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

/** 假浏览器执行器：goto bad.example 必失败，其余动作成功（复刻 app-ipc-integration 的口径） */
function fakeExecutor() {
  return {
    async openWindow() { return { ok: true } },
    exec: async (_s, act, params) => {
      if (act === 'goto' && String(params?.url).includes('bad.example')) return { ok: false, error: '页面打不开' }
      return { ok: true, snapshot: { title: '示例站', url: params?.url, text: 'body', page: { url: params?.url, title: '示例站' } } }
    },
  }
}

const SPEC = {
  specVersion: 1, appId: 'demo', name: '演示站',
  driver: 'browser', target: { type: 'web', url: 'https://example.com' },
  expose: { mode: 'console' },
  commands: [
    { action: 'ok', title: '正常查询', kind: 'read', params: [], steps: [{ act: 'snapshot' }] },
    { action: 'bad', title: '会失败', kind: 'read', params: [], steps: [{ act: 'goto', url: 'https://bad.example/' }] },
    { action: 'withParam', title: '需要参数', kind: 'read', params: [{ name: 'id', required: true }], steps: [{ act: 'snapshot' }] },
    { action: 'submit', title: '写操作', kind: 'write', params: [], steps: [{ act: 'click', ref: 1 }] },
  ],
}

/** 建一个带 demo 应用 + Spec 的场景，返回 { ipc, home } */
async function setup({ executor = fakeExecutor() } = {}) {
  const home = freshHome()
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => executor })
  await ipc.invoke('app:upsert', { id: 'demo', name: '演示站', targetType: 'web', enabled: true, requirement: '要能查单' })
  await ipc.invoke('app:write-spec', { appId: 'demo', spec: SPEC })
  return { ipc, home }
}

const src = readFileSync(fileURLToPath(new URL('../electron/app-ipc.cjs', import.meta.url)), 'utf-8')

// ---- 静态守卫 ----

test('静态：app:verify 与 app:mark-quality 两个 handler 都存在', () => {
  assert.ok(src.includes("ipcMain.handle('app:verify'"), 'app:verify 未注册')
  assert.ok(src.includes("ipcMain.handle('app:mark-quality'"), 'app:mark-quality 未注册')
})

test('静态：app:verify 的试跑固定 persist:false（试跑不是"用户执行"，不得写 history）', () => {
  const i = src.indexOf("ipcMain.handle('app:verify'")
  const j = src.indexOf("ipcMain.handle('app:mark-quality'")
  assert.ok(i > 0 && j > i, '两个 handler 的位置必须能定位')
  const block = src.slice(i, j)
  const falses = block.match(/persist:\s*false/g) || []
  // 两条执行分支（browser → runCommand；其余 → runNonBrowser）都必须显式关掉留痕
  assert.equal(falses.length, 2, `两条执行分支都要固定 persist:false（实际 ${falses.length} 处）`)
  assert.doesNotMatch(block, /persist:\s*true/, 'app:verify 绝不能写 history（那会把用户真实执行记录淹没）')
  // 复用生成期同一套试跑机制（verifySpec），不要另写一套"只跑一部分命令"的逻辑
  assert.match(block, /verifySpec\(\{/, 'app:verify 必须复用 verifySpec')
})

test('静态：app:mark-quality 走 upsertApp（注册表），绝不用 writeSpec（会淹没备份列表）', () => {
  const i = src.indexOf("ipcMain.handle('app:mark-quality'")
  assert.ok(i > 0)
  const block = src.slice(i, i + 900)
  assert.match(block, /appRegistry\.upsertApp\(/, '标记必须落注册表（upsertApp 的合并语义 ⇒ 其余字段不丢）')
  assert.doesNotMatch(block, /writeSpec/, '质检标记不得写 spec.json（writeSpec 每次都先备份）')
  assert.match(block, /listApps\(/, '先校验应用存在（不存在要如实报错，而不是凭空建一条）')
})

// ---- 行为 ----

test('app:verify：只跑无需必填参数的 read，write/需参数进 notRun/skipped，失败带 action+error', async () => {
  const { ipc } = await setup()
  const r = await ipc.invoke('app:verify', 'demo')
  assert.equal(r.ok, false, '有失败命令 → ok:false（界面据此判定"未通过"）')
  assert.deepEqual(r.tried, ['ok', 'bad'], '只试跑无需必填参数的 read 命令')
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].action, 'bad')
  assert.match(r.failures[0].error, /页面打不开/, '失败原因必须如实带回来（不能只说"失败了"）')
  assert.deepEqual(r.notRun, ['submit'], 'write 命令绝不试跑，只登记为"未试跑"')
  assert.deepEqual(r.skipped, ['withParam'], '需要必填参数的命令不能自动试跑，单独登记')
})

test('app:verify：全部通过时 ok:true（干净结论靠真实执行，不是靠"没报错"）', async () => {
  const home = freshHome()
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor() })
  await ipc.invoke('app:upsert', { id: 'demo', name: '演示站', targetType: 'web', enabled: true })
  await ipc.invoke('app:write-spec', { appId: 'demo', spec: { ...SPEC, commands: SPEC.commands.slice(0, 1) } })
  const r = await ipc.invoke('app:verify', 'demo')
  assert.equal(r.ok, true)
  assert.deepEqual(r.tried, ['ok'])
  assert.deepEqual(r.failures, [])
  assert.equal(existsSync(join(home, 'apps', 'demo', 'history')), false)
})

test('app:verify：试跑不写 history、不产生备份（试跑不是"用户执行"）', async () => {
  const { ipc, home } = await setup()
  const before = readdirSync(join(home, 'apps', 'demo')).sort()
  await ipc.invoke('app:verify', 'demo')
  assert.equal(existsSync(join(home, 'apps', 'demo', 'history')), false,
    '试跑不得写 history（每次进应用页都会跑一轮，写进去就把用户真实执行记录淹没）')
  assert.deepEqual(readdirSync(join(home, 'apps', 'demo')).sort(), before, '试跑不得产生任何文件（含 spec.bak）')
  assert.deepEqual(await ipc.invoke('app:list-backups', 'demo'), [], '试跑不得产生备份')
})

test('app:verify：Spec 不存在 → ok:false + 人话原因 + 空结果（不抛给渲染层）', async () => {
  freshHome()
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor() })
  const r = await ipc.invoke('app:verify', 'not-there')
  assert.equal(r.ok, false)
  assert.equal(r.error, '应用 Spec 不存在')
  assert.deepEqual(r.tried, [])
  assert.deepEqual(r.failures, [])
  assert.deepEqual(r.notRun, [])
  assert.deepEqual(r.skipped, [])
})

test('app:verify：执行器未就绪 → 如实报"未就绪"，而不是把每条命令都记成失败', async () => {
  const { ipc } = await setup({ executor: null })
  const r = await ipc.invoke('app:verify', 'demo')
  assert.equal(r.ok, false)
  assert.equal(r.error, '浏览器执行器未就绪')
  assert.deepEqual(r.failures, [], '执行器没起来 ≠ 应用坏了（否则用户对着一片红猜）')
})

test('app:mark-quality：落注册表且**其余字段不丢**，不碰 spec.json / 不产生备份', async () => {
  const { ipc, home } = await setup()
  const before = readdirSync(join(home, 'apps', 'demo')).sort()

  const mark = { fingerprint: 'abcd1234', checkedAt: 1700000000000, clean: false, findings: 2 }
  assert.deepEqual(await ipc.invoke('app:mark-quality', { appId: 'demo', quality: mark }), { ok: true })

  const app = (await ipc.invoke('app:list')).find((a) => a.id === 'demo')
  assert.deepEqual(app.quality, mark, '标记要落注册表（界面据此决定"这一版查过了，不重跑"）')
  assert.equal(app.name, '演示站', '合并语义：其余字段不得丢')
  assert.equal(app.requirement, '要能查单', '合并语义：requirement 等字段不得丢')
  assert.deepEqual(readdirSync(join(home, 'apps', 'demo')).sort(), before, '写标记不得碰 spec.json（否则每次质检都多一个备份）')
  assert.deepEqual(await ipc.invoke('app:list-backups', 'demo'), [])

  // quality=null 表示清掉标记（界面"重新体检"时先把旧结论抹掉）
  assert.deepEqual(await ipc.invoke('app:mark-quality', { appId: 'demo', quality: null }), { ok: true })
  assert.equal((await ipc.invoke('app:list')).find((a) => a.id === 'demo').quality, null)
})

test('app:mark-quality：应用不存在 → ok:false（不得凭空建一条应用记录）', async () => {
  freshHome()
  const ipc = fakeIpcMain()
  registerAppHandlers({ ipcMain: ipc, getExecutor: () => fakeExecutor() })
  const r = await ipc.invoke('app:mark-quality', { appId: 'ghost', quality: { fingerprint: 'x', checkedAt: 1, clean: true, findings: 0 } })
  assert.equal(r.ok, false)
  assert.match(r.error, /不存在/)
  assert.deepEqual((await ipc.invoke('app:list')).filter((a) => a.id === 'ghost'), [])
})

// 接线守卫：「指纹变化即重跑」是**接线层**的行为，单测 lib 的函数看不出来 ——
// 若有人把"进入应用页"重新加上一次性门槛（如按 autoQualityId 只在生成后为真），
// shouldAutoQuality 的测试照样全绿，但手工改完 spec 回来复验这条能力会静默消失。
test('接线守卫：进入应用页恒允许自动质检（指纹变化即重跑）+ 返回列表刷新 store', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const panel = readFileSync(join(root, 'src/components/apps/AppsPanel.tsx'), 'utf-8')
  const consoleSrc = readFileSync(join(root, 'src/components/apps/AppConsole.tsx'), 'utf-8')

  assert.ok(!/autoQualityId/.test(panel), '不得再有"仅生成后"的一次性门槛（会让 spec 改动后不复验）')
  assert.match(panel, /^\s*autoQuality\s*$/m, '进入应用页须无条件传 autoQuality（真跑否由指纹判定）')
  assert.match(
    panel,
    /onBack=\{\(\) => \{ void load\(\); setOpenId\(null\) \}\}/,
    '返回列表必须刷新 store：quality 标记写在 registry，内存旧值会让"指纹一致就跳过"失效 ⇒ 每次进入都重跑',
  )
  assert.match(
    consoleSrc,
    /shouldAutoQuality\(\{ autoQuality: true, quality: app\.quality, fingerprint/,
    '判定口径：恒 autoQuality=true + 比 app.quality 的指纹',
  )
})

test.after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }) })
