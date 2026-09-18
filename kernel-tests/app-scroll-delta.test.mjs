// scroll 参数链路 + 内核 Browser 工具文案的回归网（P1 控制命令覆盖，2026-09-17）。
// ---------------------------------------------------------------------------
// 本文件锁一条**真实缺陷**的修复，而不是形式检查：
//   契约（`WEB_CONTRACT.scroll`）要求 `ref|delta`，执行器只读 `params.delta`（缺省 400px），
//   但 `stepParams` 此前**只转发 `direction`、从不转发 `delta`** ⇒
//   Spec 里写的滚动距离被**静默丢弃**，命令"看着跑了但没用你的值"，且不报错。
//
// 为什么值得为它单开一个测试文件：这类"静默回落缺省值"的故障现场特征是**没症状**——
// 日志全绿、结果也是成功，只有用户知道"我设的 800 怎么只滚了 400"。靠人工验收几乎抓不到。
// 运行：node --test kernel-tests/app-scroll-delta.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)
const { stepParams, runCommand, directionToDelta, SCROLL_DEFAULT_PX } = require_(join(ROOT, 'electron', 'app-runner.cjs'))

const SPEC = { appId: 't', driver: 'browser', target: { url: 'https://x.example/a/b' }, commands: [] }

test('delta 必须被转发（这是本次修的真实缺陷：此前它被静默丢掉）', () => {
  const p = stepParams({ act: 'scroll', delta: 120 }, {}, SPEC)
  assert.equal(p.delta, 120, 'delta 必须原样转发给执行器')
  // 显式 0 也要如实转发（由执行器报"缺少有效 ref 或 delta"），不能悄悄换成缺省 400
  assert.equal(stepParams({ act: 'scroll', delta: 0 }, {}, SPEC).delta, 0)
  // 负值（向上滚）同样如实转发
  assert.equal(stepParams({ act: 'scroll', delta: -250 }, {}, SPEC).delta, -250)
})

test('老字段 direction 归一为 delta（只做兼容，且语义明确）', () => {
  assert.equal(stepParams({ act: 'scroll', direction: 'down' }, {}, SPEC).delta, SCROLL_DEFAULT_PX)
  assert.equal(stepParams({ act: 'scroll', direction: 'up' }, {}, SPEC).delta, -SCROLL_DEFAULT_PX)
  assert.equal(stepParams({ act: 'scroll', direction: 'DOWN' }, {}, SPEC).delta, SCROLL_DEFAULT_PX, '大小写不敏感')
  assert.equal(stepParams({ act: 'scroll', direction: 300 }, {}, SPEC).delta, 300, '数字型 direction 视为像素')
  assert.equal(stepParams({ act: 'scroll', direction: '300' }, {}, SPEC).delta, 300, '数字字符串同样')
  assert.equal(stepParams({ act: 'scroll', direction: '乱写' }, {}, SPEC).delta, SCROLL_DEFAULT_PX, '无意义值回落缺省')
  // direction 不再被转发（执行器从不读它，转发只会让人以为它有用）
  assert.equal(stepParams({ act: 'scroll', direction: 'down' }, {}, SPEC).direction, undefined)
  // delta 优先于 direction（两个都写时以新字段为准）
  assert.equal(stepParams({ act: 'scroll', delta: 77, direction: 'up' }, {}, SPEC).delta, 77)
})

test('缺省像素与执行器同源（改了执行器这里必须跟着红）', () => {
  const src = readFileSync(join(ROOT, 'electron', 'browser-executor.cjs'), 'utf8')
  const m = /delta\s*!=\s*null\s*\?\s*params\.delta\s*:\s*(\d+)/.exec(src)
  assert.ok(m, '执行器 scroll 分支的缺省值取不到（写法变了？本断言需同步，不能删）')
  assert.equal(Number(m[1]), SCROLL_DEFAULT_PX, 'app-runner 的缺省像素与执行器不一致')
})

test('整链路：Spec 里的 delta 真能到达执行器（用假执行器录参数）', async () => {
  const seen = []
  const executor = { exec: async (sessionId, act, params) => { seen.push({ act, params }); return { ok: true, data: null } } }
  const spec = {
    appId: 't',
    driver: 'browser',
    target: { url: 'https://x.example/' },
    commands: [{ action: 'down', kind: 'read', params: [], steps: [{ act: 'goto', url: '/list' }, { act: 'scroll', delta: 850 }, { act: 'snapshot', save: 'text' }] }],
  }
  const r = await runCommand({ roots: {}, appId: 't', action: 'down', executor, spec, persist: false })
  assert.equal(r.ok, true, `命令应成功：${r.error}`)
  const scroll = seen.find((s) => s.act === 'scroll')
  assert.ok(scroll, 'scroll 步骤应被下发')
  assert.equal(scroll.params.delta, 850, 'Spec 写的 850 必须一路到达执行器（此前会变成缺省 400）')
  // 顺带确认没有把无用字段带下去（协议越干净，执行器越不需要兼容分支）
  assert.equal(scroll.params.direction, undefined)
})

test('内核 Browser 工具文案与执行器一致：说 delta，不说 direction', () => {
  const src = readFileSync(join(ROOT, 'kernel', 'tools.mjs'), 'utf8')
  assert.doesNotMatch(src, /scroll 需 direction/, '文案仍写 direction —— 而执行器从不读它，模型照抄就是静默 400px')
  assert.match(src, /scroll 需 delta/, '文案必须写清 scroll 用 delta（像素，正数向下）')
  // 执行器里确实不读 direction（若哪天读了，这里会提醒同步文案与归一逻辑）
  const exe = readFileSync(join(ROOT, 'electron', 'browser-executor.cjs'), 'utf8')
  assert.doesNotMatch(exe, /params\.direction/, '执行器开始读 direction 了？那 app-runner 的归一与本文案都要同步')
})

test('directionToDelta 边界：空/未定义不崩，零视为无效回落缺省', () => {
  assert.equal(directionToDelta(undefined), SCROLL_DEFAULT_PX)
  assert.equal(directionToDelta(null), SCROLL_DEFAULT_PX)
  assert.equal(directionToDelta(''), SCROLL_DEFAULT_PX)
  assert.equal(directionToDelta(0), SCROLL_DEFAULT_PX, '0 像素的滚动没有意义，回落缺省而不是"原地不动"')
  assert.equal(directionToDelta('bottom'), SCROLL_DEFAULT_PX)
  assert.equal(directionToDelta('top'), -SCROLL_DEFAULT_PX)
})
