// Grep/Glob 路径收窄 + 可中断遍历 + 扫描预算（2026-09-11 卡死事故修复）
// ---------------------------------------------------------------------------
// 背景：会话以 --add-dir "C:/Users/T203-15"（整个 home，实测 83.6 万文件）启动，
// 模型按标准 Grep API 传了 path 指向单个 .json 文件——但旧 grepSearch 既不读
// input.path 也不让出事件循环，于是"只搜这一个文件"静默降级成 83.6 万文件的全树
// 同步遍历：事件循环被占满 → stdin 的 cancel 控制请求读不到（Stop 键完全失效）、
// engine 的 withToolDeadline 永不触发（它只包住已求值的返回值）。实测冻结 33 分钟。
// 修复四件事，本文件逐一钉死：
//   1) path 参数真正收窄遍历根（且越界/不存在一律拒绝，不静默降级为全树）
//   2) 遍历可中断：每 SCAN_YIELD_EVERY 个条目 setImmediate 让出（宏任务，微任务不够）
//   3) 时间/条目双预算，超预算返回已得结果 + 渐进式披露提示，而非空手失败
//   4) 截断导致的"零结果"不得回报为"无匹配"（否则误导模型判定目标不存在而收手）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolRegistry } from '../kernel/tools.mjs'
import { createLogger } from '../kernel/log.mjs'

// 目录布局：
//   <dir>/work/            ← cwd（会话目录，唯一 allowDir）
//     sub/a.txt            'NEEDLE in sub'
//     other/b.txt          'NEEDLE in other'
//     big/000..399.txt     （可中断遍历用）
//   <dir>/secret/c.txt     'NEEDLE outside'（会话目录之外）
function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'search-scope-'))
  const cwd = join(dir, 'work')
  mkdirSync(join(cwd, 'sub'), { recursive: true })
  mkdirSync(join(cwd, 'other'), { recursive: true })
  mkdirSync(join(dir, 'secret'), { recursive: true })
  writeFileSync(join(cwd, 'sub', 'a.txt'), 'NEEDLE in sub\n')
  writeFileSync(join(cwd, 'other', 'b.txt'), 'NEEDLE in other\n')
  writeFileSync(join(dir, 'secret', 'c.txt'), 'NEEDLE outside\n')
  const tools = createToolRegistry({ cwd, addDirs: [], skipPermissions: true, memoryRoot: null })
  return { tools, cwd, dir, secret: join(dir, 'secret'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('Grep：path 指向目录时只搜该目录，兄弟目录不扫（本次事故的核心触发面）', async () => {
  const env = makeEnv()
  try {
    const r = await env.tools.registry.Grep.run({ pattern: 'NEEDLE', path: join(env.cwd, 'sub') })
    assert.ok(!r.isError, `不应报错：${r.content}`)
    assert.match(String(r.content), /a\.txt/)          // 范围内的命中
    assert.doesNotMatch(String(r.content), /b\.txt/)   // 兄弟目录不得出现
  } finally { env.cleanup() }
})

test('Grep：path 指向单个文件（事故现场的原形：path 指向一个 .json）', async () => {
  const env = makeEnv()
  try {
    const r = await env.tools.registry.Grep.run({ pattern: 'NEEDLE', path: join(env.cwd, 'sub', 'a.txt') })
    assert.ok(!r.isError, `不应报错：${r.content}`)
    assert.match(String(r.content), /a\.txt/)
    assert.doesNotMatch(String(r.content), /b\.txt/)
  } finally { env.cleanup() }
})

test('Grep：path 用相对路径（相对 cwd 解析）', async () => {
  const env = makeEnv()
  try {
    const r = await env.tools.registry.Grep.run({ pattern: 'NEEDLE', path: 'sub' })
    assert.ok(!r.isError, `不应报错：${r.content}`)
    assert.match(String(r.content), /a\.txt/)
    assert.doesNotMatch(String(r.content), /b\.txt/)
  } finally { env.cleanup() }
})

test('Grep：省略 path 遍历全部会话目录（既有语义零回归）', async () => {
  const env = makeEnv()
  try {
    const r = await env.tools.registry.Grep.run({ pattern: 'NEEDLE' })
    assert.ok(!r.isError, `不应报错：${r.content}`)
    assert.match(String(r.content), /a\.txt/)
    assert.match(String(r.content), /b\.txt/)
  } finally { env.cleanup() }
})

test('Grep：path 指向点目录内文件仍可搜（事故现场原形：path 指向 .yfw 里的 .json）', async () => {
  // 遍历默认跳过点目录（.git/.yfw 等），但**显式指定的 path 是根节点**，
  // 不经父级剪枝——否则"只搜这一个文件"会被剪枝误伤成全无结果。
  const env = makeEnv()
  try {
    const dotDir = join(env.cwd, '.yfw', 'projects', 'x')
    mkdirSync(dotDir, { recursive: true })
    const target = join(dotDir, 'call_00_abc.json')
    writeFileSync(target, '{"tool":"Grep","NEEDLE":"here"}\n')
    const r = await env.tools.registry.Grep.run({ pattern: 'NEEDLE', path: target })
    assert.ok(!r.isError, `显式 path 应穿透点目录剪枝：${r.content}`)
    assert.match(String(r.content), /NEEDLE/)
  } finally { env.cleanup() }
})

test('Grep：path 越界拒绝，且不静默降级为全树扫描', async () => {
  const env = makeEnv()
  try {
    const r = await env.tools.registry.Grep.run({ pattern: 'NEEDLE', path: env.secret })
    assert.equal(r.isError, true)
    assert.match(String(r.content), /拒绝访问：路径超出会话目录边界/)
    // 关键：越界不能"忽略 path 照常全树搜"——那正是旧行为的错法
    assert.doesNotMatch(String(r.content), /b\.txt/)
  } finally { env.cleanup() }
})

test('Grep：path 不存在 → 明确报错（不降级为全树）', async () => {
  const env = makeEnv()
  try {
    const r = await env.tools.registry.Grep.run({ pattern: 'NEEDLE', path: join(env.cwd, 'nope') })
    assert.equal(r.isError, true)
    assert.match(String(r.content), /路径不存在/)
  } finally { env.cleanup() }
})

test('Glob：path 收窄生效，越界拒绝', async () => {
  const env = makeEnv()
  try {
    const scoped = await env.tools.registry.Glob.run({ pattern: '**/*.txt', path: join(env.cwd, 'sub') })
    assert.ok(!scoped.isError, `不应报错：${scoped.content}`)
    assert.match(String(scoped.content), /a\.txt/)
    assert.doesNotMatch(String(scoped.content), /b\.txt/)

    const denied = await env.tools.registry.Glob.run({ pattern: '**/*.txt', path: env.secret })
    assert.equal(denied.isError, true)
    assert.match(String(denied.content), /拒绝访问：路径超出会话目录边界/)
  } finally { env.cleanup() }
})

test('Grep：条目预算触发时返回已得结果 + 收窄提示（不是空手失败）', async () => {
  const env = makeEnv()
  const prevEntries = process.env.YFW_TOOL_SCAN_BUDGET_ENTRIES
  const prevMs = process.env.YFW_TOOL_SCAN_BUDGET_MS
  process.env.YFW_TOOL_SCAN_BUDGET_ENTRIES = '2' // 第 3 个条目即超预算
  process.env.YFW_TOOL_SCAN_BUDGET_MS = '600000' // 时间预算放宽，隔离出条目预算
  try {
    // cwd 下两个子目录各含一个匹配文件：无论 readdir 顺序如何，第 2 个条目
    // （先被遍历的那个目录里的文件）必已产出结果，第 3 个条目触发截断
    const r = await env.tools.registry.Grep.run({ pattern: 'NEEDLE', path: env.cwd })
    const rec = String(r.content)
    assert.ok(!r.isError, `有结果就不该报错：${rec}`)
    assert.match(rec, /NEEDLE/)                 // 已得结果被保留
    assert.match(rec, /(a|b)\.txt/)             // 确有一处命中留下
    assert.match(rec, /⚠ 扫描超出条目预算/)      // 且明确标注不完整
    assert.match(rec, /收窄 path/)               // 渐进式披露：给出下一步
  } finally {
    if (prevEntries === undefined) delete process.env.YFW_TOOL_SCAN_BUDGET_ENTRIES
    else process.env.YFW_TOOL_SCAN_BUDGET_ENTRIES = prevEntries
    if (prevMs === undefined) delete process.env.YFW_TOOL_SCAN_BUDGET_MS
    else process.env.YFW_TOOL_SCAN_BUDGET_MS = prevMs
    env.cleanup()
  }
})

test('Grep：截断导致的零结果不得回报"无匹配"（否则模型会判定目标不存在而收手）', async () => {
  const env = makeEnv()
  const prevEntries = process.env.YFW_TOOL_SCAN_BUDGET_ENTRIES
  const prevMs = process.env.YFW_TOOL_SCAN_BUDGET_MS
  process.env.YFW_TOOL_SCAN_BUDGET_ENTRIES = '1'
  process.env.YFW_TOOL_SCAN_BUDGET_MS = '600000'
  try {
    // 遍历根是目录：第 1 个条目用于进入子目录，真正的文件在第 2 个条目就被预算掐掉
    const r = await env.tools.registry.Grep.run({ pattern: 'NEEDLE', path: env.cwd })
    assert.equal(r.isError, true)
    assert.match(String(r.content), /不能据此判定不存在/)
    assert.doesNotMatch(String(r.content), /无匹配行/)
  } finally {
    if (prevEntries === undefined) delete process.env.YFW_TOOL_SCAN_BUDGET_ENTRIES
    else process.env.YFW_TOOL_SCAN_BUDGET_ENTRIES = prevEntries
    if (prevMs === undefined) delete process.env.YFW_TOOL_SCAN_BUDGET_MS
    else process.env.YFW_TOOL_SCAN_BUDGET_MS = prevMs
    env.cleanup()
  }
})

test('Grep：真无匹配（未截断）时给出无匹配 + 调整提示', async () => {
  const env = makeEnv()
  try {
    const r = await env.tools.registry.Grep.run({ pattern: 'ZZZ_NOT_THERE_ZZZ', path: join(env.cwd, 'sub') })
    // "无匹配"沿用原实现的语义：不置 isError（空结果是正常答案，不是工具失败——
    // 置 error 会触发 engine 的失败/修复路径）。此处钉死以免后续误改。
    assert.ok(!r.isError, `无匹配不该是 error：${r.content}`)
    assert.match(String(r.content), /无匹配行/)
    assert.match(String(r.content), /勿反复试探/)
  } finally { env.cleanup() }
})

test('Grep：已取消的 signal 使扫描立即中止并如实说明（Stop 键链路）', async () => {
  const env = makeEnv()
  try {
    const ac = new AbortController()
    ac.abort()
    const r = await env.tools.registry.Grep.run({ pattern: 'NEEDLE' }, { signal: ac.signal })
    assert.equal(r.isError, true)
    assert.match(String(r.content), /扫描被取消/)
    assert.doesNotMatch(String(r.content), /无匹配行/)
  } finally { env.cleanup() }
})

test('Grep：遍历中让出事件循环——setTimeout 能在扫描未结束时插入并取消它', async () => {
  // 旧实现同步遍历，此测试必失败（timer 永远排不进来，扫描一路跑完返回命中结果）。
  const dir = mkdtempSync(join(tmpdir(), 'search-yield-'))
  const cwd = join(dir, 'work')
  const big = join(cwd, 'big')
  mkdirSync(big, { recursive: true })
  for (let i = 0; i < 400; i++) writeFileSync(join(big, `${String(i).padStart(3, '0')}.txt`), `NEEDLE ${i}\n`)
  const tools = createToolRegistry({ cwd, addDirs: [], skipPermissions: true, memoryRoot: null })
  try {
    const ac = new AbortController()
    // 扫描开始后才安排的取消：只有遍历在让出，它才可能被观测到
    setTimeout(() => ac.abort(), 0)
    const r = await tools.registry.Grep.run({ pattern: 'NEEDLE', maxResults: 500 }, { signal: ac.signal })
    const rec = String(r.content)
    // 观察到了取消 = 遍历确实在让出（旧实现同步跑完，此断言必失败）
    assert.match(rec, /⚠ 扫描被取消/, '扫描应在中途被取消，而非跑完全部 400 个文件')
    const blocks = (rec.match(/—— /g) || []).length
    assert.ok(blocks < 400, `应提前停下（实际 ${blocks}/400）`)
    assert.ok(blocks > 0, '已得结果应当保留，不能因取消而空手返回')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// logger：保留结构化崩溃信息（cli.mjs 的 crash_recovered 埋点）
// ---------------------------------------------------------------------------
function captureLogger(opts) {
  const lines = []
  const sink = { write: (s) => { lines.push(s) } }
  return { log: createLogger({ sink, ...opts }), lines, parsed: () => lines.map((l) => JSON.parse(l)) }
}

test('logger：结构化对象不再塌成 [object Object]，各字段完整保留', () => {
  const c = captureLogger()
  c.log.warn('previous run crashed', { pid: 4242, prevTs: '2026-09-10T01:02:03.000Z', exitCode: 3, err: 'Error: boom at line 7' })
  assert.equal(c.lines.length, 1)
  const rec = c.parsed()[0]
  assert.equal(rec.level, 'warn')
  assert.equal(rec.msg, 'previous run crashed')
  assert.equal(rec.pid, 4242)
  assert.equal(rec.prevTs, '2026-09-10T01:02:03.000Z')
  assert.equal(rec.exitCode, 3)
  assert.equal(rec.err, 'Error: boom at line 7')
  assert.doesNotMatch(c.lines[0], /\[object Object\]/)
})

test('logger：Error 与字符串第二参照常工作（零回归）', () => {
  const c = captureLogger()
  c.log.warn('permission rules 解析失败', new Error('Unexpected token }'))
  c.log.warn('permission rules 文件不存在', '/tmp/x.json')
  const [a, b] = c.parsed()
  assert.equal(a.err, 'Unexpected token }')
  assert.equal(b.err, '/tmp/x.json')
})

test('logger：嵌套 Error 值取 message（避免序列化成 {} 丢信息）', () => {
  const c = captureLogger()
  c.log.error('turn failed', { phase: 'stream', cause: new Error('socket hang up') })
  const rec = c.parsed()[0]
  assert.equal(rec.phase, 'stream')
  assert.equal(rec.cause, 'socket hang up')
})

test('logger：extra 不得覆写核心字段 ts/level/sid/msg', () => {
  const c = captureLogger({ level: 'debug', sid: 'S1' })
  c.log.log('warn', 'REAL_MSG', { ts: 'NOT_A_TS', level: 'debug', sid: 'EVIL', msg: 'EVIL' })
  const rec = c.parsed()[0]
  assert.equal(rec.msg, 'REAL_MSG')
  assert.equal(rec.level, 'warn')
  assert.equal(rec.sid, 'S1')
  assert.notEqual(rec.ts, 'NOT_A_TS')
  assert.ok(!Number.isNaN(Date.parse(rec.ts)), 'ts 应是真实可解析的时间戳')
})

test('logger：err 字段落盘前脱敏', () => {
  if (process.env.PONOS_KEEP_SECRETS === '1') return // 用户显式要求保留原文
  const c = captureLogger()
  c.log.error('api failed', { err: 'auth failed: sk-abcdefghijklmnop failed' })
  const rec = c.parsed()[0]
  assert.doesNotMatch(rec.err, /sk-abcdefghijklmnop/)
  assert.match(rec.err, /auth failed/)
})
