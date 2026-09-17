// 启动期「源码 → 便携版」同步的回归网（2026-09-17）。
//
// 为什么要有它：本机应用实际加载 `release/YFWorking/`（便携调试版）整棵树，而 repo 只有手工跑
// `scripts/package-portable.cjs` 才会进树 ⇒ 反复出现「改了源码、应用仍跑旧代码」：
//   · kernel/cli.mjs 的工作流修复漏同步（功能一直没生效）；
//   · electron/preload.cjs 未暴露 appNextId/appVerify ⇒ 渲染层调用**静默失效**（可选链不报错）；
//   · server/{docx,sheet}_edit.py 落后 ⇒ Word/Excel 编辑返回 `{ok:true}` 却什么都没改（假成功）；
//   · office_common.py 缺失 ⇒ 新版脚本 ModuleNotFoundError。
// 本模块把该同步自动化并加门控（只对带 marker 的便携版生效），本文件钉住其判定与安全边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const {
  MARKER_FILE, SYNC_DIRS, looksLikeSourceRoot, readMarker, writeMarker, planSync, maybeAutoSync, describeReport,
} = require('../electron/dev-source-sync.cjs')

/** 造一个"看起来像源码根"的目录（looksLikeSourceRoot 的判定依据：kernel/cli.mjs + server/bridge.mjs + shared/） */
function mkSourceRoot(root, extra = {}) {
  mkdirSync(join(root, 'kernel'), { recursive: true })
  mkdirSync(join(root, 'shared'), { recursive: true })
  mkdirSync(join(root, 'server'), { recursive: true })
  mkdirSync(join(root, 'electron'), { recursive: true })
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'kernel', 'cli.mjs'), 'export const v = 2\n')
  writeFileSync(join(root, 'server', 'bridge.mjs'), '// bridge v2\n')
  writeFileSync(join(root, 'server', 'docx_edit.py'), 'print("v2")\n')
  writeFileSync(join(root, 'shared', 'core.mjs'), 'export const c = 2\n')
  writeFileSync(join(root, 'electron', 'preload.cjs'), 'module.exports = { appNextId: true }\n')
  writeFileSync(join(root, 'dist', 'index.html'), '<html>v2</html>\n')
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

/** 造一个"已部署但落后一版"的便携版树 */
function mkAppRoot(root) {
  mkdirSync(join(root, 'kernel'), { recursive: true })
  mkdirSync(join(root, 'shared'), { recursive: true })
  mkdirSync(join(root, 'server'), { recursive: true })
  mkdirSync(join(root, 'electron'), { recursive: true })
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'kernel', 'cli.mjs'), 'export const v = 1\n')
  writeFileSync(join(root, 'server', 'bridge.mjs'), '// bridge v1\n')
  writeFileSync(join(root, 'shared', 'core.mjs'), 'export const c = 1\n')
  writeFileSync(join(root, 'electron', 'preload.cjs'), 'module.exports = {}\n')
  writeFileSync(join(root, 'dist', 'index.html'), '<html>v1</html>\n')
  return root
}

const tmp = () => mkdtempSync(join(tmpdir(), 'yfw-sync-'))

test('① 门控：启动期自动路径（无 marker、无显式 sourceRoot）一律不动', () => {
  const app = mkAppRoot(tmp()), src = mkSourceRoot(tmp())
  // 刻意**不传** sourceRoot：这就是 electron/main.cjs 的调用形态（发布到用户机上的形态）
  const r = maybeAutoSync({ appRoot: app, env: {} })
  assert.equal(r.status, 'skipped')
  assert.equal(r.reason, 'no-marker')
  // 关键：应用树内容必须原样未动
  assert.equal(readFileSync(join(app, 'kernel', 'cli.mjs'), 'utf8'), 'export const v = 1\n')
  assert.equal(readFileSync(join(app, 'electron', 'preload.cjs'), 'utf8'), 'module.exports = {}\n')
  // 且不得"顺手"去读邻居目录（sourceRoot 未提供 = 不知道源码根在哪）
  assert.ok(!existsSync(join(src, MARKER_FILE)) === true, '不得往源码根写标记')
})

test('② 门控：marker 显式 autoSync:false 与 YFW_NO_DEV_SYNC=1 都能关掉', () => {
  const app = mkAppRoot(tmp()), src = mkSourceRoot(tmp())
  writeMarker(app, { sourceRoot: src, autoSync: false })
  assert.equal(maybeAutoSync({ appRoot: app, env: {} }).reason, 'marker-disabled')
  writeMarker(app, { sourceRoot: src, autoSync: true })
  assert.equal(maybeAutoSync({ appRoot: app, env: { YFW_NO_DEV_SYNC: '1' } }).reason, 'env-disabled')
  assert.equal(readFileSync(join(app, 'kernel', 'cli.mjs'), 'utf8'), 'export const v = 1\n', '两种关闭方式都不得改动文件')
})

test('③ 门控：sourceRoot 不存在 / 不像源码根 / 与 appRoot 同目录 → 跳过', () => {
  const app = mkAppRoot(tmp())
  writeMarker(app, { sourceRoot: join(tmp(), 'nonexistent') })
  assert.equal(maybeAutoSync({ appRoot: app, env: {} }).reason, 'source-unavailable')

  // "像源码根"的判定依据：kernel/cli.mjs + server/bridge.mjs + shared/ 三者齐备
  const bogusDir = tmp()   // 空目录
  assert.equal(looksLikeSourceRoot(bogusDir), false)
  const halfBaked = tmp()  // 只有 kernel/cli.mjs，缺 shared/
  mkdirSync(join(halfBaked, 'kernel'), { recursive: true })
  writeFileSync(join(halfBaked, 'kernel', 'cli.mjs'), 'x\n')
  assert.equal(looksLikeSourceRoot(halfBaked), false, '三要素不全不得当作源码根（避免误同步任意目录）')
  const app2 = mkAppRoot(tmp())
  writeMarker(app2, { sourceRoot: bogusDir })
  assert.equal(maybeAutoSync({ appRoot: app2, env: {} }).reason, 'source-unavailable')

  const app3 = mkAppRoot(tmp())
  writeMarker(app3, { sourceRoot: app3 })
  assert.equal(maybeAutoSync({ appRoot: app3, env: {} }).reason, 'same-root')
})

test('③b 显式传 sourceRoot = 明确授权：无 marker 也可同步（供 CLI 一次性修复用）', () => {
  const app = mkAppRoot(tmp())
  const src = mkSourceRoot(tmp())
  const r = maybeAutoSync({ appRoot: app, sourceRoot: src, env: {} })
  assert.equal(r.status, 'synced', '显式指定源码根即授权，不应被 marker 挡住')
  assert.equal(readFileSync(join(app, 'kernel', 'cli.mjs'), 'utf8'), 'export const v = 2\n')

  // 但 tree 所有者显式声明 autoSync:false 时，声明优先于请求
  const app2 = mkAppRoot(tmp())
  const src2 = mkSourceRoot(tmp())
  writeMarker(app2, { sourceRoot: src2, autoSync: false })
  assert.equal(maybeAutoSync({ appRoot: app2, sourceRoot: src2, env: {} }).reason, 'marker-disabled')
  assert.equal(readFileSync(join(app2, 'kernel', 'cli.mjs'), 'utf8'), 'export const v = 1\n')
})

test('④ 同步：覆盖改动、补齐缺失（含 *.py）、带上 dist', () => {
  const app = mkAppRoot(tmp())
  const src = mkSourceRoot(tmp(), { 'server/office_common.py': 'HELPERS = 1\n' })
  writeMarker(app, { sourceRoot: src })
  const r = maybeAutoSync({ appRoot: app, env: {} })
  assert.equal(r.status, 'synced')
  // 内容被更新
  assert.equal(readFileSync(join(app, 'kernel', 'cli.mjs'), 'utf8'), 'export const v = 2\n')
  assert.equal(readFileSync(join(app, 'electron', 'preload.cjs'), 'utf8'), 'module.exports = { appNextId: true }\n')
  // *.py 必须被同步（正是此前漏检的一类：Word/Excel 编辑"假成功"）
  assert.equal(readFileSync(join(app, 'server', 'docx_edit.py'), 'utf8'), 'print("v2")\n')
  // 缺失文件被补齐（office_common.py 曾整个缺失 ⇒ ModuleNotFoundError）
  assert.ok(existsSync(join(app, 'server', 'office_common.py')), '缺失的运行时脚本必须补齐')
  assert.ok(r.missingInApp.includes('server/office_common.py'))
  // dist 也在同步范围内（否则会出现"新 UI 在 repo、旧 UI 在应用"）
  assert.equal(readFileSync(join(app, 'dist', 'index.html'), 'utf8'), '<html>v2</html>\n')
  // 覆盖"全部运行时执行体"：内核/共享/服务端/主进程/渲染产物 + 运行时静态资源
  for (const d of ['kernel', 'shared', 'server', 'electron', 'dist']) assert.ok(SYNC_DIRS.includes(d), `同步集应含 ${d}`)
  // public/sample-skills 与 build/templates 都是运行时读取的静态资源（样本技能、模板），
  // 不纳入就会出现"repo 有新模板、应用看不到"这类静默不一致
  assert.ok(SYNC_DIRS.includes('public'), '应含 public（运行时读 public/sample-skills）')
  assert.ok(SYNC_DIRS.includes('build/templates'), '应含 build/templates（模板资源）')
  // 大类运行时（下载/解压得到的技能与 python 运行时）刻意不同步：体量大且不随源码迭代
  assert.ok(!SYNC_DIRS.some((d) => d.startsWith('runtime')), 'runtime/**（数百 MB）不参与源码同步')
})

test('⑤ 同尺寸但已改动（mtime 变）必须被发现——只看尺寸会漏检', () => {
  const app = mkAppRoot(tmp())
  const src = mkSourceRoot(tmp())
  // 构造与 app 同尺寸、不同内容的文件（编辑必然改 mtime）
  writeFileSync(join(src, 'kernel', 'cli.mjs'), 'export const v = 9\n')
  writeFileSync(join(app, 'kernel', 'cli.mjs'), 'export const v = 8\n')
  // 明确拉开 mtime，避免依赖"同一毫秒内两次写入"的偶然性
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(app, 'kernel', 'cli.mjs'), old, old)
  assert.equal(statSync(join(src, 'kernel', 'cli.mjs')).size, statSync(join(app, 'kernel', 'cli.mjs')).size, '前置条件：两者尺寸相同')
  const plan = planSync({ appRoot: app, sourceRoot: src })
  assert.ok(plan.toCopy.includes('kernel/cli.mjs'), `同尺寸但已改动必须进同步清单（实得 ${JSON.stringify(plan.toCopy)}）`)
  maybeAutoSync({ appRoot: app, sourceRoot: src, env: {} })
  assert.equal(readFileSync(join(app, 'kernel', 'cli.mjs'), 'utf8'), 'export const v = 9\n')
})

test('⑤b 已知取舍：尺寸与 mtime 都相同则视为未变（强保证由哈希复核兜底）', () => {
  // 这是**刻意的**性能取舍：用尺寸+mtime 代替逐文件哈希，把每次启动的扫描从约 0.9s 降到毫秒级。
  // 唯一漏检情形是"编辑同时保持尺寸与 mtime 不变"——实践中改文件必改 mtime。
  // 需要强保证时由 scratch/verify-probe.mjs 的哈希逐文件比对做独立复核（它不受此取舍影响）。
  const app = mkAppRoot(tmp())
  const src = mkSourceRoot(tmp())
  writeFileSync(join(src, 'kernel', 'cli.mjs'), 'export const v = 9\n')
  writeFileSync(join(app, 'kernel', 'cli.mjs'), 'export const v = 8\n')
  const stamp = new Date(Date.now() - 120_000)
  utimesSync(join(src, 'kernel', 'cli.mjs'), stamp, stamp)
  utimesSync(join(app, 'kernel', 'cli.mjs'), stamp, stamp)   // 人为抹平 mtime
  const plan = planSync({ appRoot: app, sourceRoot: src })
  assert.ok(!plan.toCopy.includes('kernel/cli.mjs'), '尺寸与 mtime 双等 ⇒ 视为未变（刻意取舍）')
  // 但哈希复核仍能发现（说明两条防线互补，而不是"检查失效"）
  const h = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
  assert.notEqual(h(join(src, 'kernel', 'cli.mjs')), h(join(app, 'kernel', 'cli.mjs')), '内容其实不同 → 哈希复核能抓到')
})

test('⑥ 安全边界：只覆盖补齐，绝不删除应用树里的多余文件', () => {
  const app = mkAppRoot(tmp())
  const src = mkSourceRoot(tmp())
  // 应用树里有源码没有的文件（如发布时才生成的产物 / 改名后的陈旧文件）
  writeFileSync(join(app, 'electron', 'release-only.cjs'), 'keep me\n')
  writeFileSync(join(app, 'server', 'legacy_removed.py'), 'stale\n')
  const r = maybeAutoSync({ appRoot: app, sourceRoot: src, env: {} })
  assert.equal(r.status, 'synced')
  assert.ok(existsSync(join(app, 'electron', 'release-only.cjs')), '不得删除应用树多余文件')
  assert.ok(existsSync(join(app, 'server', 'legacy_removed.py')), '不得删除应用树多余文件')
  assert.ok(r.extraInApp.includes('electron/release-only.cjs'), '但要在报告里如实列出，便于人工判断')
})

test('⑦ 不变量：跑完一遍再跑一遍应无事可做（幂等，避免每次启动重复写盘）', () => {
  const app = mkAppRoot(tmp())
  const src = mkSourceRoot(tmp())
  writeMarker(app, { sourceRoot: src })
  const r1 = maybeAutoSync({ appRoot: app, env: {} })
  assert.ok(r1.copied > 0, '首跑应有内容可同步')
  const r2 = maybeAutoSync({ appRoot: app, env: {} })
  assert.equal(r2.copied, 0, `幂等：二次运行不应再拷贝（实得 ${r2.copied}）`)
  assert.equal(r2.toCopy.length, 0)
  assert.equal(r2.scanned, r1.scanned, '扫描规模应稳定')
})

test('⑧ 跳过 dev 专有内容：node_modules / .log / .bak 不进同步集', () => {
  const app = mkAppRoot(tmp())
  const src = mkSourceRoot(tmp(), {
    'server/node_modules/dep/index.js': 'x\n',
    'kernel/debug.log': 'log\n',
    'shared/old.mjs.bak': 'bak\n',
  })
  const plan = planSync({ appRoot: app, sourceRoot: src })
  const joined = plan.toCopy.join('|')
  assert.ok(!/node_modules/.test(joined), 'node_modules 不参与同步')
  assert.ok(!/\.log$/.test(joined), '*.log 不参与同步')
  assert.ok(!/\.bak$/.test(joined), '*.bak 不参与同步')
})

test('⑨ 报告可读：状态与关键数字都能从日志看出（不是"悄悄改了代码"）', () => {
  const app = mkAppRoot(tmp())
  const src = mkSourceRoot(tmp())
  writeMarker(app, { sourceRoot: src })
  const r = maybeAutoSync({ appRoot: app, env: {} })
  const line = describeReport(r)
  assert.match(line, /已同步/)
  assert.match(line, /\d+ 个文件/)
  assert.match(line, /ms/)
  // 无 marker 的场景不打日志（module 层已保证），此处只验文本
  assert.match(describeReport({ status: 'skipped', reason: 'no-marker' }), /跳过/)
  assert.match(describeReport({ status: 'error', reason: 'boom' }), /应用继续启动/, '失败必须说明不影响启动')
})

test('⑩ dry-run 不落盘（打包/排查时可先预演）', () => {
  const app = mkAppRoot(tmp())
  const src = mkSourceRoot(tmp())
  writeMarker(app, { sourceRoot: src })
  const r = maybeAutoSync({ appRoot: app, sourceRoot: src, env: {}, dryRun: true })
  assert.equal(r.status, 'dry-run')
  assert.ok(r.toCopy.length > 0)
  assert.equal(readFileSync(join(app, 'kernel', 'cli.mjs'), 'utf8'), 'export const v = 1\n', 'dry-run 不得改动文件')
})

test('⑪ marker 格式：损坏/缺字段时视为无 marker（退回跳过，不误判）', () => {
  const app = mkAppRoot(tmp())
  const src = mkSourceRoot(tmp())
  writeFileSync(join(app, MARKER_FILE), '{ broken json')
  assert.equal(readMarker(app), null)
  assert.equal(maybeAutoSync({ appRoot: app, env: {} }).reason, 'no-marker')
  writeFileSync(join(app, MARKER_FILE), JSON.stringify({ autoSync: true }))   // 缺 sourceRoot
  assert.equal(readMarker(app), null)
  writeMarker(app, { sourceRoot: src })
  const m = readMarker(app)
  assert.equal(m.sourceRoot, src)
  assert.equal(m.autoSync, true)
  rmSync(join(app, MARKER_FILE))
  assert.equal(readMarker(app), null)
})

test('⑫ 排除生成物与测试：__pycache__ / *.test.* 不进同步集', () => {
  const app = mkAppRoot(tmp())
  const src = mkSourceRoot(tmp(), {
    'server/__pycache__/docx_edit.cpython-312.pyc': 'bytecode',
    'server/bridge.test.mjs': 'test code',
    'electron/foo.test.cjs': 'test code',
    'shared/x.test.ts': 'test code',
  })
  const plan = planSync({ appRoot: app, sourceRoot: src })
  const j = plan.toCopy.join('|')
  assert.ok(!/__pycache__/.test(j), '__pycache__ 是生成物，不进同步集')
  assert.ok(!/\.test\./.test(j), '测试文件不是运行时执行体，不进同步集（避免报告失真）')
  // 但同一目录下的运行时文件仍要同步（别因排除规则误伤）
  assert.ok(plan.toCopy.includes('server/docx_edit.py'), '排除规则不得误伤同目录的运行时 .py')
})
