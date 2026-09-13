// kernel-tests/readonly-mtime-prune.test.mjs —— K2.2 文件级剪枝（2026-09-13「任务运行慢」系统性优化 Task 9）
// ---------------------------------------------------------------------------
// 要修的**不是**"结果不对"，而是**先整文件读完再按日期过滤**：真机 36.8MB / 134 文件里只有
// 10 个文件（5.7MB）沾今天，`--scope today` 却要付全量 520ms。剪枝把日期窗口下推成 mtime 下界，
// 实测 520ms → 250ms（2.1×，剩余主要是 150ms 的进程启动地板）。
//
// 故本文件有两条主线，缺一不可：
//   ① **不许静默漏数据**（正确性）：剪枝前后的结果必须逐条相等（含"文件含窗口外条目"、
//      "非日期 from"、"开关关闭"三种情形），以及**安全边距必须真的在起作用**（去掉它必红）。
//   ② **必须真的省下读盘**（性能）：用一个 4 万行的旧文件量"剪枝开/关"的耗时比——只断言"结果
//      一样"的话，把整段剪枝代码删掉也全绿，等于空跑。
// 日期全部用**固定过去日期**（2020-01），不依赖真实时钟 ⇒ 不会在跨零点/换机器时抖动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTranscriptFiles, mtimeCutoff } from '../kernel/readonly.mjs'

/** 造一个 hermetic 的 <home>/projects/<proj>/<sid>.jsonl */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'yfw-prune-'))
  return {
    home,
    /** 写一个会话文件；mtime 显式设为给定时刻（ISO）——这是本用例的核心输入 */
    write(proj, sid, lines, mtimeIso) {
      const dir = join(home, 'projects', proj)
      mkdirSync(dir, { recursive: true })
      const p = join(dir, `${sid}.jsonl`)
      writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
      const t = Date.parse(mtimeIso) / 1000
      utimesSync(p, t, t)
      return p
    },
    cleanup() { rmSync(home, { recursive: true, force: true }) },
  }
}

/** 一条最小 transcript 条目（只带聚合需要的字段） */
function line(ts, sid) {
  return { type: 'assistant', timestamp: ts, sessionId: sid, message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } }
}

/** 在指定开关值下取一次结果（env 是调用期惰性读，故可逐次切换） */
function collect(home, opts, pruneFlag) {
  const prev = process.env.PONOS_USAGE_MTIME_PRUNE
  if (pruneFlag === undefined) delete process.env.PONOS_USAGE_MTIME_PRUNE
  else process.env.PONOS_USAGE_MTIME_PRUNE = pruneFlag
  try {
    return collectTranscriptFiles({ configDir: home, ...opts })
  } finally {
    if (prev === undefined) delete process.env.PONOS_USAGE_MTIME_PRUNE
    else process.env.PONOS_USAGE_MTIME_PRUNE = prev
  }
}

const key = (e) => `${e.sessionId}@${e.timestamp}`

test('剪枝前后结果逐条相等（不许静默漏数据）', () => {
  const f = fixture()
  try {
    // 早于窗口：整个文件都不合格（剪枝会跳过它）——mtime 也在窗口前
    f.write('proj-a', 'old', [
      line('2020-01-01T10:00:00.000Z', 'old'),
      line('2020-01-01T11:00:00.000Z', 'old'),
    ], '2020-01-01T12:00:00.000Z')
    // 跨窗口：含窗口外(01-01)与窗口内(01-02/01-03)的条目，mtime 在窗口后 ⇒ **必须整个读**
    f.write('proj-a', 'span', [
      line('2020-01-01T23:59:59.000Z', 'span'),
      line('2020-01-02T00:00:00.000Z', 'span'),
      line('2020-01-03T09:00:00.000Z', 'span'),
    ], '2020-01-03T10:00:00.000Z')
    // 另一个项目（project 过滤的正交性）
    f.write('proj-b', 'other', [line('2020-01-02T08:00:00.000Z', 'other')], '2020-01-02T08:00:00.000Z')

    for (const opts of [
      { from: '2020-01-02' },                                  // 窗口下界
      { from: '2020-01-02', to: '2020-01-02' },                // 闭区间
      { from: '2020-01-05' },                                  // 窗口在所有文件之后（全剪）
      { from: '2019-12-01' },                                  // 窗口在所有文件之前（一个都不剪）
      { from: '2020-01-02', project: 'proj-a' },               // 与 project 过滤正交
      { from: '2020-01-02', sessionId: 'span' },               // 与 sessionId 过滤正交
      {},                                                      // 无 from ⇒ 不剪枝
    ]) {
      const on = collect(f.home, opts).map(key).sort()
      const off = collect(f.home, opts, '0').map(key).sort()
      assert.deepEqual(on, off, `剪枝改变了结果：${JSON.stringify(opts)}`)
    }

    // 单边性：跨窗口文件的**窗口外条目**必须仍在无 from 查询里（证明我们没有按 to 去剪文件）
    const noFrom = collect(f.home, {}).map(key)
    assert.ok(noFrom.includes('span@2020-01-01T23:59:59.000Z'), '含窗口外条目的文件必须被完整读取')
    // 且带 from 时，是 **ts 过滤**（而不是剪枝）把旧条目排除的
    const withFrom = collect(f.home, { from: '2020-01-02' }).map(key)
    assert.deepEqual(withFrom.sort(), [
      'other@2020-01-02T08:00:00.000Z',
      'span@2020-01-02T00:00:00.000Z',
      'span@2020-01-03T09:00:00.000Z',
    ])
  } finally { f.cleanup() }
})

test('安全边距是承重的：零点前 30 分钟的文件不得被剪（时钟回跳的保险）', () => {
  const f = fixture()
  try {
    // 条目日期 01-02、mtime 01-01T23:30Z：落在「窗口起点前 1 小时」边距内 ⇒ 必须照读
    f.write('proj-a', 'edge', [line('2020-01-02T00:00:00.000Z', 'edge')], '2020-01-01T23:30:00.000Z')
    // 对照：mtime 更早（23:00 之前）⇒ 剪掉是安全的（它确实不可能有条目落在 01-02 之后……
    // 除非时钟回跳 > 1h，那正是被明确记录在案的残余风险）
    f.write('proj-a', 'far', [line('2020-01-02T00:00:00.000Z', 'far')], '2020-01-01T20:00:00.000Z')

    const got = collect(f.home, { from: '2020-01-02', to: '2020-01-02' }).map(key)
    assert.deepEqual(got, ['edge@2020-01-02T00:00:00.000Z'],
      '边距内的文件必须照读；去掉 MTIME_SAFETY_MS 本断言必红')
  } finally { f.cleanup() }
})

test('只有严格 YYYY-MM-DD 才允许剪枝（安全关键判据的直接断言）', () => {
  const day = Date.parse('2020-01-02T00:00:00.000Z')
  assert.equal(mtimeCutoff('2020-01-02'), day - 3_600_000, '严格日期 → 零点减 1 小时安全边距')
  // '2019' / '2020' / '2020-01' 是**实测能被 Date.parse 宽松解析**的（→ 该年/该月 1 日），
  // 去掉正则后它们会产出非零 cutoff ⇒ 这三条必红（它们就是正则在防的东西）。
  // 其中 '2020-01'（月粒度）会真的造成分歧：字符串比较把它当"2020-01 之后"，日期解析
  // 却回退到 2020-01-01 零点 ⇒ 剪掉 mtime 在 2019 末尾的文件，而那些文件里的 2020-01-15
  // 条目本该被保留。别把它当成理论顾虑。
  for (const bad of ['2019', '2020', '2020-01', '2020-1-2', '2020-01-2', '2020/01/02', 'yesterday', '', '2020-01-02T00:00:00Z', '2020-13-45']) {
    assert.equal(mtimeCutoff(bad), 0, `${JSON.stringify(bad)} 必须一律不剪枝（宁可多读，不可漏算）`)
  }
  // 开关关闭 → 恒不剪枝
  const prev = process.env.PONOS_USAGE_MTIME_PRUNE
  process.env.PONOS_USAGE_MTIME_PRUNE = '0'
  try { assert.equal(mtimeCutoff('2020-01-02'), 0, 'PONOS_USAGE_MTIME_PRUNE=0 必须完全关掉剪枝') }
  finally {
    if (prev === undefined) delete process.env.PONOS_USAGE_MTIME_PRUNE
    else process.env.PONOS_USAGE_MTIME_PRUNE = prev
  }
})

test('畸形 from 下剪枝与全量**结果一致**（不认识的格式绝不据此丢文件）', () => {
  const f = fixture()
  try {
    f.write('proj-a', 'a', [line('2020-01-02T10:00:00.000Z', 'a')], '2020-01-01T00:00:00.000Z')
    f.write('proj-a', 'b', [line('2020-01-02T11:00:00.000Z', 'b')], '2020-01-02T11:00:00.000Z')
    // 'mon' 这个文件是给 '2020-01' 准备的：条目在 2020-01-15（字符串比较下 >= '2020-01' ⇒ 该保留），
    // mtime 却在 2019 年末。**去掉正则**后 '2020-01' 会被解析成 2020-01-01 零点 ⇒ 本文件被剪 ⇒
    // 两路结果分歧 ⇒ 本用例必红。
    f.write('proj-a', 'mon', [line('2020-01-15T10:00:00.000Z', 'mon')], '2019-12-31T12:00:00.000Z')
    // 注：'2020-1-2' 这类**本来就**被上游的字符串日期比较过滤掉（现存行为，与剪枝无关）——
    // 故这里只断言"剪枝前后相等"，不对具体条数做假设。
    for (const from of ['2020-1-2', '2020-01-2', '2019', '2020', '2020-01', 'yesterday', '2020/01/02', '']) {
      const on = collect(f.home, { from }).map(key).sort()
      const off = collect(f.home, { from }, '0').map(key).sort()
      assert.deepEqual(on, off, `from=${JSON.stringify(from)} 剪枝改变了结果`)
    }
  } finally { f.cleanup() }
})

test('核心性能契约：旧文件**根本不被读**——剪枝开/关的耗时比是承重的', () => {
  const f = fixture()
  try {
    const n = 40_000
    const lines = []
    for (let i = 0; i < n; i++) lines.push(line('2020-01-01T10:00:00.000Z', 'big'))
    f.write('proj-a', 'big', lines, '2020-01-01T12:00:00.000Z')      // 窗口前的大文件
    f.write('proj-a', 'today', [line('2020-01-02T10:00:00.000Z', 'today')], '2020-01-02T10:00:00.000Z')

    const t = (flag) => {
      const s = performance.now()
      const got = collect(f.home, { from: '2020-01-02' }, flag)
      return { ms: performance.now() - s, n: got.length }
    }
    const off = t('0')
    const on = t(undefined) // 默认开
    assert.equal(on.n, 1, '剪枝后仍必须拿到窗口内那一条')
    assert.equal(off.n, 1, '两条路径的**结果**必须一样（差别只在读不读那份 4 万行）')
    assert.ok(
      on.ms * 5 < off.ms,
      `剪枝必须真的省下读盘：开=${on.ms.toFixed(1)}ms 关=${off.ms.toFixed(1)}ms（需要 5× 差距）。` +
      '若这条红了，说明大文件仍被读取——剪枝没生效或已被改回全量读',
    )
  } finally { f.cleanup() }
})
