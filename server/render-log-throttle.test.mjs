// R1（2026-09-13）：渲染器高频日志的闸门 + 缓冲写
// ---------------------------------------------------------------------------
// 病根：渲染层 `[WS] recv:` 每个下行帧一行 → 主进程 console-message → **两次**
// statSync+appendFileSync（app.log 经 log-tee 一份 + renderer-console.log 一份）。
// 实测 22 小时写掉 17MB，全是这一行。
// 本文件钉死五件事：① 只对**帧级正文复本**采样、且**异常永不被采样**；② 被采样掉多少条
// 必须记在下一个放行行上（"什么都没记"这种最坏情况不允许出现）；③ **判据必须窄**——
// 真实回放显示宽判据会连带吃掉 kernel-stderr 转发与 tool_result/告警行；④ 落盘走缓冲且
// **退出/崩溃必须 flush**（缓冲只能省系统调用，不能改变"写过就该在盘上"的语义边界）；
// ⑤ 门控在**组装字符串之前**（不然省下的只是 IO，字符串构造与 IPC 成本照付）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBufferedWriter, createLineGate, createRendererConsoleSink, writeLogLines,
  RENDER_CHATTER_PATTERNS,
} from './log-policy.cjs'

const tmp = (tag) => mkdtempSync(join(tmpdir(), `render-log-${tag}-`))

// 真实行形状（发射点 `src/hooks/useYFWCLI.ts:174` = `[WS] recv: <msg.type> <sid> <data.type>`）：
// 全量日志里 98.5% 的噪声都是这一种。
const FRAME = '[WS] recv: event 4f2a1b9c assistant'

// 注入时钟的闸门：不依赖真实时间（相对断言抗 CI 抖动）
function gateAt(t0 = 0, opts = {}) {
  let t = t0
  const gate = createLineGate({ now: () => t, ...opts })
  return { gate, tick: (ms) => { t += ms } }
}

test('createLineGate：帧级正文复本按窗口采样，窗口内多行只放行第一行', () => {
  const { gate, tick } = gateAt()
  assert.equal(gate.allow(FRAME).allow, true, '窗口首行放行')
  for (let i = 0; i < 20; i++) {
    assert.equal(gate.allow(FRAME).allow, false, '窗口内其余行被采样掉')
  }
  tick(1999)
  assert.equal(gate.allow(FRAME).allow, false, '窗口未满仍不放行')
  tick(1)
  const v = gate.allow(FRAME)
  assert.equal(v.allow, true, '窗口满后放行')
  assert.equal(v.suppressed, 21, '期间被采样掉的条数必须带出来（诊断不降级为"什么都没有"）')
})

test('RENDER_CHATTER_PATTERNS：判据必须窄（放宽到 [WS] recv: 会吃掉 stderr 与状态迁移行）', () => {
  const hit = (s) => RENDER_CHATTER_PATTERNS.some((re) => re.test(s))
  assert.equal(hit(FRAME), true, '帧级正文复本 = 噪声，可采样')
  // 下面每一条都在真实日志里出现过；宽判据（`[WS] recv:`）实测会采样掉今天 487 行诊断里的 396 行。
  for (const line of [
    '[WS] recv: stderr [api] POST 1280ms',                    // kernel stderr 转发 = 唯一的内核诊断入口
    '[WS] recv: event 4f2a1b9c tool_result',                  // 状态迁移（紧随 assistant 帧到达，最易被误伤）
    '[WS] recv: event 4f2a1b9c result',
    '[WS] recv: event 4f2a1b9c ponos_warning',
    '[WS] recv: event 4f2a1b9c ponos_health',
    '[WS] recv: event 4f2a1b9c system',
    '[WS] recv: question 4f2a1b9c',
    '[WS] recv: approval 4f2a1b9c',
    '[WS] recv: kernel-stall 4f2a1b9c',
    '[WS] connected', '[WS] closed: 1006', '[WS] resync 4f2a1b9c netGain=3',
  ]) assert.equal(hit(line), false, `${line} 绝不能被采样`)
})

test('createLineGate：非帧级行全量保留（只针对已知噪声，不是一刀切）', () => {
  const { gate } = gateAt()
  for (const line of [
    '[WS] recv: stderr [api] POST 1280ms',
    '[WS] recv: event 4f2a1b9c tool_result',
    '[WS] recv: event 4f2a1b9c ponos_warning',
    '[WS] connected', '[WS] closed: 1006', '[compact] 断线时压缩指示悬挂', '随便什么',
  ]) {
    for (let i = 0; i < 5; i++) assert.equal(gate.allow(line).allow, true, `${line} 不得被采样`)
  }
})

test('createLineGate：异常行永不被采样（错误全量是硬约束，对更宽的判据同样成立）', () => {
  // 用放宽后的判据（模拟将来有人改宽）验证第二道防线：命中判据 + 含异常词 ⇒ 仍必须放行。
  const { gate } = gateAt(0, { patterns: [/^\[WS\] recv:/] })
  gate.allow(FRAME)
  for (const line of [
    '[WS] recv: stderr [api] POST failed',
    '[WS] recv: event 4f2a1b9c parse error',
    '[WS] recv: event 4f2a1b9c timeout',
    '[WS] recv: event 4f2a1b9c unresponsive',
    '[WS] recv: event 4f2a1b9c ponos_warning: 网关重试',
  ]) {
    assert.equal(gate.allow(line).allow, true, `${line} 必须放行`)
  }
  assert.equal(gate.pendingSuppressed(), 0, '异常行不得计入被采样数')
})

test('createLineGate：PONOS_RENDER_LOG_FULL=1 全量还原（排障开关，惰性读）', () => {
  const { gate } = gateAt()
  gate.allow(FRAME)
  assert.equal(gate.allow(FRAME).allow, false)
  process.env.PONOS_RENDER_LOG_FULL = '1'
  try {
    for (let i = 0; i < 3; i++) assert.equal(gate.allow(FRAME).allow, true, '开关打开后全量')
  } finally { delete process.env.PONOS_RENDER_LOG_FULL }
  assert.equal(gate.allow(FRAME).allow, false, '关掉开关应立刻恢复采样（惰性读）')
})

test('createLineGate：WINDOW_MS=0 等价全量；非法值回落默认窗口', () => {
  const { gate } = gateAt()
  process.env.PONOS_RENDER_LOG_WINDOW_MS = '0'
  try {
    for (let i = 0; i < 5; i++) assert.equal(gate.allow(FRAME).allow, true)
  } finally { delete process.env.PONOS_RENDER_LOG_WINDOW_MS }
  process.env.PONOS_RENDER_LOG_WINDOW_MS = '不是数字'
  try {
    gate.allow(FRAME)
    assert.equal(gate.allow(FRAME).allow, false, '非法值应回落默认 2000ms 窗口（而不是变成全量）')
  } finally { delete process.env.PONOS_RENDER_LOG_WINDOW_MS }
})

test('createBufferedWriter：到量即落盘、到点即落盘、flush 清空', () => {
  const batches = []
  const timers = []
  const bw = createBufferedWriter({
    write: (lines) => batches.push(lines),
    maxBufferSize: 3,
    setTimeoutFn: (fn) => { timers.push(fn); return { unref() {} } },
    clearTimeoutFn: () => {},
  })
  bw.push('a')
  bw.push('b')
  assert.equal(batches.length, 0, '两条不该落盘')
  bw.push('c')
  return new Promise((resolve) => setImmediate(() => {
    assert.deepEqual(batches, [['a', 'b', 'c']], '满 3 行经 setImmediate 落盘')
    bw.push('d')
    bw.push('e')
    assert.equal(batches.length, 1)
    assert.equal(bw.flush(), 2, 'flush 返回落盘条数并清空')
    assert.deepEqual(batches[1], ['d', 'e'])
    assert.equal(bw.size(), 0)
    assert.equal(bw.flush(), 0, '空缓冲 flush 是幂等的')
    assert.equal(timers.length, 2, '两次 push 各起了一个定时器（第一次被清掉、第二次被 flush 清掉）')
    resolve()
  }))
})

test('createBufferedWriter：写盘抛错不影响调用方（日志设施自身出错不拖垮主流程）', () => {
  const bw = createBufferedWriter({ write: () => { throw new Error('磁盘满了') }, maxBufferSize: 1 })
  assert.doesNotThrow(() => { bw.push('x') })
  return new Promise((resolve) => setImmediate(() => { assert.equal(bw.size(), 0); resolve() }))
})

test('writeLogLines：批量写与逐行写字节完全一致（缓冲不引入第二条写路径）', () => {
  const dir = tmp('batch')
  try {
    const one = join(dir, 'one.log')
    const many = join(dir, 'many.log')
    const policy = { persist: true, level: 'info', maxFileBytes: 5 * 1024 * 1024, maxFiles: 3, maxAgeDays: 14 }
    for (const line of ['第一行', '第二行', '第三行']) writeLogLines(one, [line], policy, 'info')
    assert.equal(writeLogLines(many, ['第一行', '第二行', '第三行'], policy, 'info'), 3)
    assert.equal(readFileSync(many, 'utf-8'), readFileSync(one, 'utf-8'), '字节级一致（含换行数）')
    assert.equal(writeLogLines(many, [], policy, 'info'), 0, '空批次不写')
    assert.equal(writeLogLines(join(dir, 'off.log'), ['x'], { ...policy, persist: false }), 0, 'persist:false 不写不建文件')
    assert.equal(existsSync(join(dir, 'off.log')), false)
    assert.equal(writeLogLines(join(dir, 'lv.log'), ['x'], policy, 'debug'), 0, '低于等级门槛的行被丢弃（debug < info）')
    assert.equal(writeLogLines(join(dir, 'lv.log'), ['x'], policy, 'error'), 1, '高等级行照写')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('createRendererConsoleSink：被采样行不进 console 也不落盘；放行行带被采样计数', () => {
  const dir = tmp('sink')
  try {
    const printed = []
    let t = 0
    const sink = createRendererConsoleSink({
      home: dir,
      gate: createLineGate({ now: () => t }),
      log: (l) => printed.push(l),
    })
    sink.handle(FRAME, 'app.js', 10)
    for (let i = 0; i < 7; i++) sink.handle(FRAME, 'app.js', 10)
    assert.equal(printed.length, 1, '窗口内只输出一行')
    assert.equal(sink.size(), 1, '缓冲里也只有一行（不落盘也不缓冲）')
    t += 2000
    sink.handle(FRAME, 'app.js', 11)
    assert.equal(printed.length, 2)
    assert.match(printed[1], /\(\+7 条同类被采样\)/, '被吃掉多少必须写出来')
    assert.match(printed[1], /^\[render:console\] \[WS\] recv: event 4f2a1b9c assistant \(app\.js:11\)/)
    // 退出路径 flush → 两行都在盘上，且只经一次批量写
    assert.equal(sink.flush(), 2)
    const text = readFileSync(join(dir, 'logs', 'renderer-console.log'), 'utf-8')
    assert.equal(text.split('\n').filter(Boolean).length, 2, '盘上恰好两行')
    assert.ok(!text.includes('条同类被采样)  ('), '行结构未被破坏')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('createRendererConsoleSink：门控在组装字符串之前（不给被采样行付组装成本）', () => {
  const dir = tmp('gate-first')
  try {
    // 门控拿到的必须**仍是原始消息**（无 `[render:console]` 前缀、无 sourceId 行号）
    // ⇒ 组装发生在其后。若哪天有人把组装提到门控之前，seen 里就会出现带前缀的行。
    const seen = []
    const gating = { allow: (m) => { seen.push(m); return { allow: false, suppressed: 0 } } }
    const printed = []
    const sink = createRendererConsoleSink({ home: dir, gate: gating, log: (l) => printed.push(l) })
    sink.handle(FRAME, 'app.js', 10)
    assert.deepEqual(seen, [FRAME], '门控看到的是原始消息')
    assert.deepEqual(printed, [], '被采样行不得调 console')
    assert.equal(sink.size(), 0, '被采样行不得进缓冲')
    // 正对照：放行的同一条消息，console 收到的才是组装后的行
    const passing = { allow: (m) => { seen.push(m); return { allow: true, suppressed: 0 } } }
    const sink2 = createRendererConsoleSink({ home: dir, gate: passing, log: (l) => printed.push(l) })
    sink2.handle(FRAME, 'app.js', 10)
    assert.deepEqual(seen[1], FRAME, '同一个原始消息')
    assert.deepEqual(printed, [`[render:console] ${FRAME} (app.js:10)`], '组装后的行才进 console')
    assert.equal(sink2.size(), 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('createRendererConsoleSink：persist:false 时不建文件，但 console 原输出不变', () => {
  const dir = tmp('persist-off')
  try {
    const printed = []
    const sink = createRendererConsoleSink({ home: dir, log: (l) => printed.push(l) })
    // 直接改策略最省事：写一个 persist:false 的 config.json（readLogPolicyCached 现读）
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ logPolicy: { persist: false } }))
    sink.handle('[WS] connected', 'app.js', 1)
    sink.flush()
    assert.equal(printed.length, 1, '原输出行为不变')
    assert.equal(existsSync(join(dir, 'logs', 'renderer-console.log')), false, 'persist:false → 不建文件')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
