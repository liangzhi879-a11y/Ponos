// 知识库导入**异步任务**的测试（2026-09-14，契约 §4）。
// ---------------------------------------------------------------------------
// 纪律同 knowledge-import-routes.test.mjs：直调注册表/路由 + **注入假 spawnStream**，
// 绝不起内核子进程（本仓库有"测试起进程/起桥误杀运行中应用"的前车之鉴）。
//
// 本文件钉的是"任务语义"而不是内核能力：
//   · 进度按 NDJSON 行归约（plan 定 total、process 递进、done 收尾）且**单调**；
//   · 结果取**末行**——进度行与结果行必须分得清，且损坏行不影响结果判定；
//   · 错误映射与同步路径**同一张表**（复用 `importJobFailure`），非闸门失败不透 stderr 原文；
//   · TTL 回收与上限淘汰：**过期时绝不淘汰运行中的任务**（否则制造"有写入、无账目"的孤儿导入）。
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startImportJob, getImportJob, _resetImportJobs, importPercent } from './import-jobs.mjs'
import { handleKnowledgeRoute, importJobFailure } from './knowledge-routes.mjs'
import { _resetImportPolicyCache } from './knowledge-import-policy.cjs'

const homes = []
/** 临时 home：**绝不碰真实 ~/.yfworking**（导入策略从 config.json 读，写到真家目录就是污染） */
function tempHome(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-import-jobs-'))
  homes.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf-8')
  }
  return dir
}
const HOME = tempHome() // 无 config.json → 策略取默认档（500 文件 / 300MB）

beforeEach(() => {
  _resetImportJobs()
  _resetImportPolicyCache()
})
after(() => {
  _resetImportJobs()
  for (const d of homes) rmSync(d, { recursive: true, force: true })
})

/** 等一个微任务轮次，让"已启动但未结束"的任务跑到它的 await 点 */
const tick = () => new Promise((r) => setImmediate(r))

const ndjson = (o) => JSON.stringify(o)
const prog = (phase, extra = {}) => ndjson({ type: 'progress', phase, ...extra })

/**
 * 假流式 spawn（形状与 server/kernel-stream.mjs 的返回值一致）。
 * @param lines  逐行喂给 onLine 的 NDJSON
 * @param tail   返回的尾部原始行（`noLine:true` 时用来验证"调用方没接 onLine 也能取到结果"）
 * @param hold   true = 挂住不结束（用于在 running 态做断言），测试用 release() 放行
 * @param fail   非零退出/超时等：以 reject 表达（与真实现同纪律）
 */
function fakeStream({ lines = [], tail = [], hold = false, noLine = false, fail = null } = {}) {
  let release = () => {}
  const gate = new Promise((r) => { release = r })
  const fn = async (argsList, opts) => {
    fn.calls.push({ argsList, opts })
    if (!noLine) for (const l of lines) opts?.onLine?.(l)
    if (hold) await gate
    if (fail) throw fail
    return { code: 0, tail, bytes: 0 }
  }
  fn.calls = []
  fn.release = release
  return fn
}

const ARGS = ['--knowledge', 'import', '--src', 'D:/资料', '--space', 's']
const REPORT = {
  ok: true, spaceId: 's', counts: { total: 3, converted: 3, skipped: 0, failed: 0 },
  converted: [], skipped: [], failed: [], indexSync: 'reloaded', warnings: [],
}

test('归约：plan 定 total → process 递进 → 完成取末行 report（进度单调、percent 与 GUI 同口径）', async () => {
  const stream = fakeStream({
    hold: true,
    lines: [
      prog('plan', { done: 0, total: 3, totalBytes: 900, rejected: 0 }),
      prog('process', { done: 0, total: 3, current: 'a.docx' }),
      prog('process', { done: 1, total: 3, current: '子目录/b.pdf' }),
      ndjson(REPORT),
    ],
  })
  const { jobId, promise } = startImportJob({ args: ARGS, spawnStream: stream })
  assert.ok(typeof jobId === 'string' && jobId.length > 0, '要给出 jobId')
  await tick()

  // `--progress` 由任务层追加（同步路径的 stdout 契约恰好一行 JSON，不能在任何地方默认加）
  assert.deepEqual(stream.calls[0].argsList, [...ARGS, '--progress'])
  assert.ok(stream.calls[0].opts.onLine, '必须接 onLine，否则进度无从归约')

  const running = getImportJob(jobId)
  assert.equal(running.status, 'running')
  assert.equal(running.total, 3, 'plan 行定的 total 要立刻可见（"先查文件数"）')
  assert.equal(running.done, 1)
  assert.equal(running.current, '子目录/b.pdf')
  assert.equal(running.percent, 33, '1/3 → 四舍五入 33')
  assert.equal(typeof running.startedAt, 'number')
  assert.equal(running.report, undefined, 'running 态不该带 report（GUI 会误以为已完成）')

  stream.release()
  await promise
  const done = getImportJob(jobId)
  assert.equal(done.status, 'done')
  assert.deepEqual(done.report, REPORT, '报告必须逐字节原样（路由/任务层不重排字段）')
  assert.equal(done.done, 3)
  assert.equal(done.total, 3)
  assert.equal(done.percent, 100)
  assert.equal(typeof done.endedAt, 'number')
})

test('plan 之前 total 未知 → percent 0（不 NaN、不满格）；重复/落后的进度行不把进度拽回去', async () => {
  const stream = fakeStream({
    hold: true,
    tail: [ndjson(REPORT)],
    lines: [
      prog('process', { done: 5, total: 10, current: 'f5' }), // 乱序：先来 process（内核不会，但坏输入不能崩）
      prog('plan', { done: 0, total: 10 }),
      prog('process', { done: 7, total: 10, current: 'f7' }),
      prog('process', { done: 2, total: 10, current: 'f2' }), // 落后的行
    ],
  })
  const { jobId, promise } = startImportJob({ args: ARGS, spawnStream: stream })
  await tick()
  const j = getImportJob(jobId)
  assert.equal(j.total, 10)
  assert.equal(j.done, 7, '落后的进度行不能把进度条拉回去')
  assert.equal(j.percent, 70)
  stream.release()
  await promise
  assert.equal(getImportJob(jobId).status, 'done')
})

test('结果取**末行**：onLine 未被接/尾部还有垃圾行时，仍回溯取到 report（进度行不会被当结果）', async () => {
  // 「末行」不是"最后一行文本"，而是"最后一行**结果行**"：进程被 kill 时可能留半行、
  // 将来内核可能在结果后再写日志行。取错的后果是把半截垃圾当报告成功回给 GUI。
  const stream = fakeStream({ noLine: true, tail: [ndjson(REPORT), prog('done', { done: 3, total: 3 }), '{"cut":'] })
  const { jobId, promise } = startImportJob({ args: ARGS, spawnStream: stream })
  await promise
  const j = getImportJob(jobId)
  assert.equal(j.status, 'done')
  assert.deepEqual(j.report, REPORT)
  // 这条路上进度行整批都没经过 onLine ⇒ total 未知 ⇒ done/percent 以 0 计
  //（与 GUI 同口径：total 未知时不给假进度；GUI 靠 status=done 收尾，不靠 percent）
  assert.equal(j.total, 0)
  assert.equal(j.percent, 0)
})

test('完成即收敛到 total：收尾的 done 行丢了也不显示 99%（进度条卡住比没有进度更糟）', async () => {
  const stream = fakeStream({
    lines: [prog('plan', { done: 0, total: 3 }), prog('process', { done: 2, total: 3, current: 'c' })],
    tail: [ndjson(REPORT)],
  })
  const { jobId, promise } = startImportJob({ args: ARGS, spawnStream: stream })
  await promise
  const j = getImportJob(jobId)
  assert.equal(j.status, 'done')
  assert.equal(j.done, 3)
  assert.equal(j.percent, 100)
  assert.equal(j.current, undefined, 'done 态不再带 current（否则 UI 会显示"已完成 3/3：c"）')
})

test('进度行损坏不影响结果判定（解析不了的行一律忽略）', async () => {
  const stream = fakeStream({
    lines: [
      '这不是 JSON',
      '{"type":"progress",',           // 半截 JSON
      prog('plan', { done: 0, total: 2 }),
      '[1,2,3]',                        // 合法 JSON 但不是对象
      '"just a string"',
      prog('process', { done: 0, total: 2, current: 'x' }),
      ndjson(REPORT),
      'tail garbage',
    ],
  })
  const { jobId, promise } = startImportJob({ args: ARGS, spawnStream: stream })
  await promise
  const j = getImportJob(jobId)
  assert.equal(j.status, 'done')
  assert.deepEqual(j.report, REPORT, '损坏行不能顶替结果行')
})

test('exit 0 但没有任何结果行 → 任务失败（**不回空报告**：那会被渲染成"导入了 0 个文件，成功"）', async () => {
  const stream = fakeStream({ lines: [prog('plan', { done: 0, total: 1 }), prog('done', { done: 1, total: 1 })] })
  const { jobId, promise } = startImportJob({ args: ARGS, spawnStream: stream })
  await promise
  const j = getImportJob(jobId)
  assert.equal(j.status, 'error')
  assert.equal(j.code, 'kernel-failed')
  assert.match(j.error, /未返回结果/)
  assert.equal(j.report, undefined)
})

test('非零退出 → error + 码映射：与同步路径**同一张表**（闸门行按码透出理由）', async () => {
  // 用真内核捕获的 stderr 行（2026-09-14 实跑得到），而不是自己编一个 —— 这条映射是从文本里
  // **解析**码的，编的串只能证明"按我编的格式能解析"。
  const REAL = [
    ['[knowledge] readonly-space: space 不得以 "pack-" 开头（那是只读知识包的保留前缀）', 'readonly-space'],
    ['[knowledge] not-found: 导入源不存在：C:\\Users\\x\\AppData\\Local\\Temp\\no-such', 'not-found'],
    ['[knowledge] too-many-files: 文件数 501 超出单批上限 500（请分批导入）', 'too-many-files'],
    ['[knowledge] bad-max-files: import: --max-files 必须是 ≥1 的整数（收到 "0"）', 'bad-max-files'],
  ]
  for (const [line, code] of REAL) {
    const stream = fakeStream({ fail: new Error(line) })
    const { jobId, promise } = startImportJob({ args: ARGS, spawnStream: stream, mapError: importJobFailure })
    await promise
    const j = getImportJob(jobId)
    assert.equal(j.status, 'error', `${code} 应让任务进入 error`)
    assert.equal(j.code, code, '码原样透出（GUI 按码给针对性提示）')
    assert.ok(!j.error.startsWith('[knowledge]'), '内核前缀要剥掉')
    assert.ok(j.error.includes(code), '理由要留在文本里（"为什么被拒"）')
    assert.equal(typeof j.endedAt, 'number')
  }
  // 认不出的码：闸门行照旧给理由，但没有 code 字段（不瞎猜码）
  const s2 = fakeStream({ fail: new Error('[knowledge] 某个还没登记的新码: 原因') })
  const r2 = startImportJob({ args: ARGS, spawnStream: s2, mapError: importJobFailure })
  await r2.promise
  assert.equal(getImportJob(r2.jobId).code, undefined)
})

test('非闸门失败（崩溃/超时/stdout 超限）→ 定式消息，**不透 stderr 原文/绝对路径**', async () => {
  const crash = [
    'D:\\app\\resources\\kernel\\cli.mjs:123',
    '  throw new Error("boom")',
    'Error: boom',
    '    at Object.<anonymous> (D:\\app\\resources\\kernel\\cli.mjs:123:9)',
  ].join('\n')
  const stream = fakeStream({ fail: new Error(crash) })
  const { jobId, promise } = startImportJob({ args: ARGS, spawnStream: stream, mapError: importJobFailure })
  await promise
  const j = getImportJob(jobId)
  assert.equal(j.status, 'error')
  assert.equal(j.code, 'kernel-failed')
  const body = JSON.stringify(j)
  assert.ok(!body.includes('cli.mjs') && !body.includes('D:\\\\app'), `不该泄漏服务端路径/栈：${body}`)
  assert.match(j.error, /内核异常退出/)

  // 我们自己的 harness 消息（形状固定、不含路径）原样透出：调用方唯一能据以区分"跑太久"与"崩了"
  for (const line of ['[kernel-stream] timeout 900000ms', '[kernel-readonly] timeout 60000ms']) {
    const s = fakeStream({ fail: new Error(line) })
    const r = startImportJob({ args: ARGS, spawnStream: s, mapError: importJobFailure })
    await r.promise
    assert.equal(getImportJob(r.jobId).error, `导入失败：${line}`)
  }
})

test('TTL 回收：结束后保留 ttlMs 再消失（定时器 unref，不挂住进程）', async () => {
  const stream = fakeStream({ lines: [prog('plan', { done: 0, total: 1 })], tail: [ndjson(REPORT)] })
  const { jobId, promise } = startImportJob({ args: ARGS, spawnStream: stream, ttlMs: 25 })
  await promise
  assert.ok(getImportJob(jobId), '刚完成时必须还能查到（GUI 就是在这时取报告）')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(getImportJob(jobId), null, '超过保留期应被回收（避免无界堆积报告对象）')
})

test('上限淘汰：只淘汰**已结束**的任务，运行中的一个都不动', async () => {
  const running = fakeStream({ hold: true, lines: [prog('plan', { done: 0, total: 9 })] })
  const a = startImportJob({ args: ARGS, spawnStream: running, maxJobs: 2, ttlMs: 60_000 })
  await tick()
  const b = startImportJob({ args: ARGS, spawnStream: fakeStream({ tail: [ndjson(REPORT)] }), maxJobs: 2, ttlMs: 60_000 })
  await b.promise
  const c = startImportJob({ args: ARGS, spawnStream: fakeStream({ tail: [ndjson(REPORT)] }), maxJobs: 2, ttlMs: 60_000 })
  await c.promise
  assert.ok(getImportJob(a.jobId), '运行中的任务被淘汰 = 制造"有写入、无账目"的孤儿导入，绝不允许')
  assert.equal(getImportJob(a.jobId).status, 'running')
  assert.ok(getImportJob(c.jobId), '新任务必须能进来')
  assert.equal(getImportJob(b.jobId), null, '该被淘汰的是最旧的**已结束**任务')
  running.release()
})

test('上限淘汰：全在运行时超限放行（宁可多留一条记录，也不淘汰运行中的）', async () => {
  const s1 = fakeStream({ hold: true, lines: [prog('plan', { done: 0, total: 1 })] })
  const s2 = fakeStream({ hold: true, lines: [prog('plan', { done: 0, total: 1 })] })
  const a = startImportJob({ args: ARGS, spawnStream: s1, maxJobs: 1, ttlMs: 60_000 })
  await tick()
  const b = startImportJob({ args: ARGS, spawnStream: s2, maxJobs: 1, ttlMs: 60_000 })
  await tick()
  assert.equal(getImportJob(a.jobId).status, 'running')
  assert.equal(getImportJob(b.jobId).status, 'running')
  s1.release(); s2.release()
})

test('未知 id → null；路由折成 404（不冒充 200 空壳：那会让进度条永远不动）', async () => {
  assert.equal(getImportJob('no-such-id'), null)
  const r = await handleKnowledgeRoute({ method: 'GET', pathname: '/knowledge/import/jobs/no-such-id' })
  assert.equal(r.status, 404)
  assert.match(r.body.error, /未知的导入任务/)
  // 空 id / 多级路径（形状错）/ 非法百分号编码同 404，不 500（500 会让调用方去重试/报障）
  for (const path of ['/knowledge/import/jobs', '/knowledge/import/jobs/', '/knowledge/import/jobs/a/b', '/knowledge/import/jobs/%E4%']) {
    const rr = await handleKnowledgeRoute({ method: 'GET', pathname: path })
    assert.equal(rr.status, 404, `${path} 应 404`)
  }
  // 不是本端点的形状 → 落回 null（交后续路由），不冒充 404
  const n = await handleKnowledgeRoute({ method: 'GET', pathname: '/knowledge/import/jobsX' })
  assert.equal(n, null)
})

// ── 路由接线：POST /knowledge/import 的 async 分支 ────────────────────────────
function ctx({ body = null, callKernel, spawnStream } = {}) {
  return {
    method: 'POST', pathname: '/knowledge/import', searchParams: new URLSearchParams(),
    readJsonBody: async () => body, home: HOME,
    callKernel: callKernel || (async () => JSON.stringify(REPORT)),
    spawnStream,
  }
}

test('async:true → 202 { jobId }，argv 带上策略缺省上限与 --progress；不传 async 时同步路径 argv 逐字节不变', async () => {
  const stream = fakeStream({ hold: true, lines: [prog('plan', { done: 0, total: 2 })] })
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/资料', space: 's', async: true }, spawnStream: stream }))
  assert.equal(r.status, 202)
  assert.ok(r.body.jobId)
  assert.deepEqual(Object.keys(r.body), ['jobId'], '202 体只有 jobId（不夹带同步报告字段）')
  // 缺省上限来自 readImportPolicyCached()（HOME 无 config.json → 默认档 500 / 300MB）
  assert.deepEqual(stream.calls[0].argsList, [...ARGS, '--max-files', '500', '--max-total-mb', '300', '--progress'])
  assert.equal(stream.calls[0].opts.timeoutMs, 15 * 60 * 1000, '与同步路径同一超时窗口')
  assert.equal(stream.calls[0].opts.maxBuffer, 32 * 1024 * 1024)
  stream.release()

  // 不传 async（含 async:false / async:'true' 这类模糊值）→ 走**同步** callKernel，不进任务表
  for (const async of [undefined, null, false, 'true', 1]) {
    const spawnStream = fakeStream({})
    const callKernel = async () => JSON.stringify(REPORT)
    const rr = await handleKnowledgeRoute(ctx({ body: { from: 'D:/资料', space: 's', async }, callKernel, spawnStream }))
    assert.equal(rr.status, 200, `async=${JSON.stringify(async)} 应走同步路径`)
    assert.deepEqual(rr.body, REPORT)
    assert.equal(spawnStream.calls.length, 0, '同步路径不得起任务')
  }
})

test('上限显式覆盖：逐字段透传；非法值 400 且**不起任务**（不静默回落）', async () => {
  const stream = fakeStream({ hold: true })
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/资料', space: 's', async: true, maxFiles: 5000, maxTotalMb: 1024 }, spawnStream: stream }))
  assert.equal(r.status, 202)
  assert.deepEqual(stream.calls[0].argsList, [...ARGS, '--max-files', '5000', '--max-total-mb', '1024', '--progress'])
  stream.release()

  // 单给一个：另一个仍按策略缺省补齐（字段级缺省，不是"要么都给要么都不给"）
  const stream2 = fakeStream({ hold: true })
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/资料', space: 's', async: true, maxFiles: 800 }, spawnStream: stream2 }))
  assert.deepEqual(stream2.calls[0].argsList, [...ARGS, '--max-files', '800', '--max-total-mb', '300', '--progress'])
  stream2.release()

  for (const body of [
    { maxFiles: 0 }, { maxFiles: -1 }, { maxFiles: 1.5 }, { maxFiles: 'abc' }, { maxFiles: 99999 },
    { maxTotalMb: 0 }, { maxTotalMb: 99999 }, { maxTotalMb: '很多' },
  ]) {
    const s = fakeStream({})
    const rr = await handleKnowledgeRoute(ctx({ body: { from: 'D:/资料', space: 's', async: true, ...body }, spawnStream: s }))
    assert.equal(rr.status, 400, `${JSON.stringify(body)} 应 400（上限静默回落会让用户以为放宽了，实际整批被拒）`)
    assert.equal(s.calls.length, 0, '非法参数不该发起真进程')
  }
  // 同步路径**不追加**上限 flag（既有消费者与测试把它当契约）；显式覆盖除外
  const syncStream = fakeStream({})
  const calls = []
  const callKernel = async (args) => { calls.push(args); return JSON.stringify(REPORT) }
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/资料', space: 's' }, callKernel, spawnStream: syncStream }))
  assert.deepEqual(calls[0], ARGS, '同步路径 argv 逐字节不变（不读策略、不加 flag）')
  await handleKnowledgeRoute(ctx({ body: { from: 'D:/资料', space: 's', maxFiles: 3000 }, callKernel }))
  assert.deepEqual(calls[1], [...ARGS, '--max-files', '3000'], '同步路径也认显式覆盖（否则同一字段两种语义）')
})

test('路由轮询：running 态 → 200 running【percent】；完成后 → 200 done + report', async () => {
  const stream = fakeStream({
    hold: true,
    lines: [prog('plan', { done: 0, total: 4, totalBytes: 40 }), prog('process', { done: 1, total: 4, current: 'b.docx' })],
    tail: [ndjson(REPORT)],
  })
  const r = await handleKnowledgeRoute(ctx({ body: { from: 'D:/资料', space: 's', async: true }, spawnStream: stream }))
  await tick()
  const run = await handleKnowledgeRoute({ method: 'GET', pathname: `/knowledge/import/jobs/${r.body.jobId}` })
  assert.equal(run.status, 200)
  assert.deepEqual(run.body, {
    status: 'running', done: 1, total: 4, current: 'b.docx', percent: 25, startedAt: run.body.startedAt,
  })
  stream.release()
  await tick()
  await tick()
  const fin = await handleKnowledgeRoute({ method: 'GET', pathname: `/knowledge/import/jobs/${r.body.jobId}` })
  assert.equal(fin.body.status, 'done')
  assert.deepEqual(fin.body.report, REPORT)
  assert.equal(fin.body.percent, 100)
})

test('POST /knowledge/import/jobs/:id 落回 null（查询是 GET-only，不冒充 405）', async () => {
  const r = await handleKnowledgeRoute({ method: 'POST', pathname: '/knowledge/import/jobs/x', readJsonBody: async () => ({}) })
  assert.equal(r, null)
})

test('percent 与 GUI `importPercent` 逐位同口径（两端各写一套必然显示漂移）', async (t) => {
  let ui = null
  try {
    ui = await import('../src/lib/knowledgeImportUi.ts')
  } catch (e) {
    // 发布目录（release/YFWorking/）只发 server/ electron/ dist/，不含 src/ → 仅源码树里跑一致性守卫
    const notFound = e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND'
    if (!(notFound && /src[\\/]lib[\\/]knowledgeImportUi/.test(String(e?.message || '')))) throw e
    t.skip('发布目录无 src/，一致性守卫仅在源码树运行')
    return
  }
  const cases = [
    { done: 0, total: 0 }, { done: 5, total: 0 }, { done: 0, total: 5 }, { done: 1, total: 3 },
    { done: 2, total: 3 }, { done: 5, total: 10 }, { done: 10, total: 10 }, { done: 99, total: 10 },
    { done: NaN, total: 10 }, { done: 1, total: NaN }, { done: 1.7, total: 3.2 }, { done: -1, total: 10 },
  ]
  for (const c of cases) {
    assert.equal(importPercent(c), ui.importPercent(c), `percent 口径漂移：${JSON.stringify(c)}`)
  }
})
