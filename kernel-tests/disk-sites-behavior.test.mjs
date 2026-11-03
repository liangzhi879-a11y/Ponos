// 落盘埋点的**语义守恒行为测试**（2026-09-23 Task 3 review 定点补）
// ---------------------------------------------------------------------------
// 为什么必须有这个文件（review 实测教训）：`disk-sites-wiring.test.mjs` + `disk-telemetry.test.mjs`
// 只钉住 `diskWrite` **自身**（透传/不抛/记账），对"5 个**调用点**失败时如何表现"一条断言都没有 ⇒
// 下列变异**全部绿**（坏掉也拦不住，即"静默退化"）：
//   · loop-state：删掉整段一次性告警块（用户再也看不到"断点续跑不可用"）
//   · tool-result：把 `return content` 改成返回随机串（失败时把**输出正文**换成垃圾）
//   · transcript-usage：改成**重抛**（破坏"内存已更新、静默降级"）
//   · session-memory：改成**重抛**（破坏 best-effort 静默）
// ⇒ 本文件逐条钉住这 5 处：每个调用点的失败语义（**重抛喂自愈** / 静默降级 / 退回原文 / 告警一次）
// 都必须与包装前逐字一致。每条用例的 "★ 变异即红" 注释标明该断言杀死哪个变异。
//
// 遥测记账取数说明：4 个调用点内部硬编码 `getDiskTelemetry()`（进程级单例）⇒ **无法注入实例**。
// 故本文件对调用点相关的记账断言一律"先 `resetDiskTelemetry()` 拿干净单例、再读它的 snapshot"
// （等价于显式实例隔离：reset 后无跨用例串账）；`diskWrite` 自身的口径仍用显式实例钉（见 wiring）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// PONOS_* 阈值在 engine.mjs **模块求值期**冻结 ⇒ env 必须在动态 import 之前设定（本文件其余用例
// 不读这些变量，故顶层设置无副作用）。与 engine-tool-result.test.mjs 同一手法。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_MOCK_LOOP = 'ok'          // mock 每次请求产 Bash(echo mock-loop-ok)
process.env.PONOS_LOOP_MAX_ITERATIONS = '1' // 防迭代失控
process.env.PONOS_STREAM_IDLE_MS = '5000'
// 阈值压到 10 字节：`echo mock-loop-ok`（14 字节）必然超限 ⇒ 必走 persistToolResult 落盘分支
process.env.PONOS_TOOL_RESULT_BUDGET_BYTES = '10'

const { diskWrite, resetDiskTelemetry, getDiskTelemetry } = await import('../kernel/disk-write.mjs')
const { createDiskTelemetry } = await import('../kernel/disk-telemetry.mjs')
const { createSessionStore } = await import('../kernel/session.mjs')

/** 把 p 造成"不可用"的位置：写成一个**文件**，随后对它的 mkdir/写必失败（错误码见各用例）。 */
function blockPath(p) {
  writeFileSync(p, 'not a directory')
  assert.equal(existsSync(p), true, '前提：占位文件已建')
}
/** 解掉占位，便于 rmSync 干净收尾。 */
function unblockPath(p) { try { unlinkSync(p) } catch { /* 已不存在 */ } }
/** 按行去掉 `//` 之后部分，再去掉 `/* *\/` 块（本仓无嵌套块注释/无此类正则字面量，足够精确）。 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l })
    .join('\n')
}

// ── ① transcript-append（session.mjs#writeEntry）：**异常仍按原语义上抛** + 失败被遥测记账 ──────
// writeEntry 失败必须**上抛**，因为 append 的 ENOENT 分支是唯一消费者：`err?.code === 'ENOENT'`
// ⇒ 清 dirEnsured、重建目录、重试一次（运行期目录被删后的自愈）。若埋点把异常吃掉，则"目录被删"
// 后**静默丢写**（内存有、盘上没有）。故本用例以**可观测的自愈结果**钉住"上抛"这条语义。
test('transcript-append：失败仍上抛给调用方（自愈重试真的发生）+ 该次失败被遥测记账', () => {
  resetDiskTelemetry()
  const home = mkdtempSync(join(tmpdir(), 'diskbeh-append-'))
  try {
    const s = createSessionStore({ configDir: home, cwd: home, sessionId: 'append-heal' })
    assert.equal(existsSync(s.file), true, '前提：构造期已落 meta 首行')
    const telemetry = getDiskTelemetry()
    const before = telemetry.snapshot().sites['transcript-append']
    rmSync(join(home, 'projects'), { recursive: true, force: true }) // 运行期目录被删（用户清理/夹具）
    s.appendUser('删除后')
    assert.equal(existsSync(s.file), true,
      '★ 变异即红：删掉 `if (!w.ok) throw w.error` ⇒ append 的 ENOENT 自愈分支永不触发、文件不复建')
    const contents = readFileSync(s.file, 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((e) => e?.type === 'user').map((e) => e.message.content)
    assert.deepEqual(contents, ['删除后'], '重试后必须真的落盘（不是"看起来没报错"）')
    const after = telemetry.snapshot().sites['transcript-append']
    // 批 2（Task 7）自愈：该点是关键项且失败 ⇒ L0"立即重试一次"**真的发生**（目录没被重建 ⇒ 两次都失败）
    // ⇒ **一次逻辑写 = 2 次 attempt**，故记账按 attempt 计为 +2（口径见 disk-heal「L0 重试成功 ⇒ failures
    // 仍 +1」：自愈成功也要如实记失败，因为"自愈成功"正是靠失败计数才看得见）。
    assert.equal(after.failures - before.failures, 2,
      'L0 重试 ⇒ 两次失败尝试都被记账（failures +2）——埋点不得因为"包装内部会重试"而漏记')
    // 3 次 attempt = ① 首次失败 ② L0 重试也失败（⇒ L3、包装交回 ok:false）③ 调用点重建目录后的成功写。
    // 其中 ① ② 由**包装内部**重试产生、③ 由 session#append 的 ENOENT 自愈产生 —— 两层自愈都真的发生了。
    assert.equal(after.count - before.count, 3, '本次共 3 次 attempt（穿透两层自愈）')
    assert.match(after.lastError, /ENOENT/, 'lastError 须含真实错误码（排障时要有线索）')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── ② transcript-usage（session.mjs#setEntryUsage）：**不抛**、返回原 entry、内存已更新、记账 ──
// 场景：transcript 路径被目录占住 ⇒ 包装内的 readFileSync(file) 抛 EISDIR（读-改-写整段必失败）。
// 上游调用点 engine.mjs#finalizeUsage 无 try ⇒ 这里抛出去就是把"静默降级"变成"打断收尾轮"。
test('transcript-usage：落盘失败**不抛**、仍返回该 entry、内存 usage 已更新 + 遥测记账 +1', () => {
  resetDiskTelemetry()
  const home = mkdtempSync(join(tmpdir(), 'diskbeh-usage-'))
  try {
    const s = createSessionStore({ configDir: home, cwd: home, sessionId: 'usage-fail' })
    const entry = s.appendUser('一条')
    unlinkSync(s.file)
    mkdirSync(s.file) // 占掉文件位：readFileSync ⇒ EISDIR
    const telemetry = getDiskTelemetry()
    const before = telemetry.snapshot().sites['transcript-usage']
    let ret
    assert.doesNotThrow(() => {
      ret = s.setEntryUsage(entry, { input_tokens: 11, output_tokens: 22 })
    }, '★ 变异即红：改成重抛 ⇒ 本断言失败（该点必须静默降级）')
    assert.equal(ret, entry, '返回值必须仍是那个 entry（调用方依赖它）')
    assert.deepEqual(entry.message.usage, { input_tokens: 11, output_tokens: 22 }, '内存里的 usage 必须已更新')
    const after = telemetry.snapshot().sites['transcript-usage']
    // 同 ① 的口径：失败 ⇒ L0 重试真的再试一次（EISDIR 是稳定失败）⇒ 一次逻辑写 = 2 次 attempt ⇒ failures +2。
    // 该点非关键项 ⇒ 走到 L2"舍掉"（shed）；调用点仍静默降级，语义未变。
    assert.equal(after.failures - before.failures, 2, '两次失败尝试都要记账（否则隐患不可见）')
    assert.match(after.lastError, /EISDIR|EACCES|EPERM|ENOTDIR/,
      'lastError 须含真实错误码（"磁盘不可写"类失败要有据可查）')
  } finally {
    unblockPath(join(home, 'projects'))
    rmSync(home, { recursive: true, force: true })
  }
})

// ── ③ loop-state（loop.mjs#persist）：失败**恰好告警一次**（level/message 逐字）+ 第二次不告警 ──
// persist 的 dir 是 `join(configDir, 'loop')`；把 configDir 指成一个**文件** ⇒
// mkdirSync(dir, {recursive:true}) 抛 ENOTDIR ⇒ 走 !w.ok 分支。文案逐字取自 loop.mjs
// （注意 "磁盘不可写？" 是全角问号，改一个字就是行为变化）。
test('loop-state：落盘必失败 ⇒ 告警恰好一次（level/message 逐字）、第二次不再告警、返回值不变', async () => {
  const { createLoopController } = await import('../kernel/loop.mjs')
  resetDiskTelemetry()
  const home = mkdtempSync(join(tmpdir(), 'diskbeh-loop-'))
  try {
    const dirAsFile = join(home, 'configdir-is-a-file')
    blockPath(dirAsFile) // mkdirSync(dirAsFile + '/loop') ⇒ ENOTDIR
    const warnings = []
    const wire = { warning: (w) => warnings.push(w), loop: () => {}, assistant: () => {}, health: () => {} }
    const lc = createLoopController({ wire, engine: {}, configDir: dirAsFile, sessionId: 's1', cwd: home })
    assert.equal(lc.persist(), false, '返回值与原语义一致：落盘失败 ⇒ false（原 catch 后 return false）')
    assert.equal(warnings.length, 1,
      '★ 变异即红：删掉整段一次性告警块 ⇒ 本断言失败（用户再也看不到"断点续跑不可用"）')
    assert.deepEqual(warnings[0], {
      level: 'loop_persist',
      message: 'loop 状态落盘失败（磁盘不可写？），断点续跑能力不可用',
    }, '告警 level/message 必须与既有文案**逐字**相等')
    assert.equal(lc.persist(), false, '第二次仍返回 false（返回值语义不因告警门闩而变）')
    assert.equal(warnings.length, 1, '★ 一次性告警：第二次失败**不再**告警（persistWarned 门闩）')
    assert.equal(getDiskTelemetry().snapshot().sites['loop-state'].failures >= 2, true,
      '两次失败都应记账（告警只发一次，但账要记全）')
  } finally {
    unblockPath(join(home, 'configdir-is-a-file'))
    rmSync(home, { recursive: true, force: true })
  }
})

// ── ④ tool-result（engine.mjs#persistToolResult）：落盘失败 ⇒ **不抛**且**退回原文** ───────────
// 场景：会话落盘段 `projects/proj` 是**文件** ⇒ join(dirname(target.file),'tool-results') 的
// mkdirSync 抛 ENOTDIR ⇒ 走 !w.ok ⇒ 必须 `return content` 原文（不是落盘路径、不是空串）。
// 端到端走真实 engine + mock API：wire.toolResult 回传的 content 就是模型实际拿到的正文。
test('tool-result：落盘失败（ENOTDIR）**不抛**且退回**原文**（不是落盘路径、不是空串）', async () => {
  const { createEngine } = await import('../kernel/engine.mjs')
  resetDiskTelemetry()
  const home = mkdtempSync(join(tmpdir(), 'diskbeh-toolresult-'))
  try {
    mkdirSync(join(home, 'projects'), { recursive: true })
    blockPath(join(home, 'projects', 'proj'))
    const got = []
    const wire = {
      assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
      summary: () => {}, health: () => {}, warning: () => {}, toolResult: (e) => got.push(e),
    }
    const session = createSessionStore({
      configDir: home, cwd: 'proj', sessionId: '00000000-0000-0000-0000-0000000000aa',
    })
    const engine = createEngine({
      opts: { model: 'm', addDirs: [home], skipPermissions: true, systemPrompt: '' }, wire, session,
    })
    await engine.runTurn({ content: '[mock:loop]' })
    const snap = getDiskTelemetry().snapshot().sites['tool-result']
    assert.ok(snap.failures >= 1, `前提：tool-result 确实落盘失败了（failures=${snap.failures}）`)
    assert.ok(got.length >= 1, '应至少回传 1 条 tool_result')
    for (const g of got) {
      assert.equal(typeof g.content, 'string')
      assert.equal(g.content, 'mock-loop-ok',
        '★ 变异即红：把 `if (!w.ok) return content` 改成返回随机串/落盘路径 ⇒ 本断言失败'
        + `（实际 ${JSON.stringify(g.content)}）`)
      assert.equal(String(g.content).includes('<persisted-output'), false,
        '落盘失败时不得声称"已落盘"（那会引导模型去 Read 一个不存在的文件）')
    }
  } finally {
    unblockPath(join(home, 'projects', 'proj'))
    rmSync(home, { recursive: true, force: true })
  }
})

// ── ⑤ session-memory（cli.mjs，埋在 main() 内 ⇒ 用静态断言兜住形态）──────────────────────────
// 两条必须同时成立：
//  (a) **best-effort 静默**：埋点处 `diskWrite(...)` 之后不得出现 `throw`（该点的静默由外层
//      `catch { /* 工作记忆写失败不影响主流程 */ }` 实现，抛出去同样会破坏它）。
//  (b) **控制流逐字回原**（Task 3 review 修的真缺陷）：原本 writeFileSync 抛错 ⇒ 跳到外层 catch
//      ⇒ **跳过** syncKnowledgeIndex；包装吞掉失败后若仍无条件同步，就变成"对未更新的文件做索引
//      同步"（未命中时还会 load({}) 全量重载索引 ⇒ 退化磁盘上反而加延迟）。
//      ⇒ syncKnowledgeIndex 必须被 `w.ok` 保护。
test('session-memory：静默（埋点后无 throw）且索引同步被 w.ok 保护（失败即跳过）', () => {
  const src = readFileSync(fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url)), 'utf8')
  const start = src.indexOf('// disk-site: session-memory')
  assert.ok(start > 0, '前提：cli.mjs 里应有 `// disk-site: session-memory` 埋点标记')
  const endMarker = src.indexOf('// S1+/O4', start) // 下一个块的首注释 = 本块右边界
  const seg = stripComments(src.slice(start, endMarker > start ? endMarker : start + 1500))
  assert.ok(!/\bthrow\b/.test(seg),
    '★ 变异即红：session-memory 改成重抛 ⇒ 本断言失败（该点必须保持 best-effort 静默）')
  const syncLines = seg.split('\n').filter((l) => l.includes('syncKnowledgeIndex('))
  assert.equal(syncLines.length, 1, `该块内 syncKnowledgeIndex 应恰调用一次（实际 ${syncLines.length} 次）`)
  assert.match(syncLines[0], /if \(w\.ok\)\s*syncKnowledgeIndex\(/,
    '★ syncKnowledgeIndex 必须被 `if (w.ok)` 保护：落盘失败 ⇒ 跳过索引同步（与包装前控制流逐字一致）')
})

// ── ⑥ diskWrite 自身：**遥测异常不得外溢、也不得误报成落盘失败**（Task 3 review ⑤）────────────
// 病态遥测（end 抛错）下：成功路径若把 `t.end` 的异常交给自己的 catch，会 ① 二次调用 end（重复计数）
// ② 把**遥测异常**包装成 `{ok:false}` ⇒ 调用点据此重抛/告警/退回原文，等于"观测把自己变成故障源"。
test('diskWrite：遥测 end 抛错时仍返回 {ok:true, value}，且不二次 end（观测异常不外溢）', () => {
  let ends = 0
  const bad = {
    begin: () => ({ site: 'transcript-append', t0: 0 }),
    end: () => { ends += 1; throw new Error('telemetry bug') },
  }
  let res
  assert.doesNotThrow(() => { res = diskWrite(bad, 'transcript-append', () => 'written') },
    '遥测自身异常绝不允许外溢到调用点')
  assert.deepEqual(res, { ok: true, value: 'written', level: null, reason: null }, '成功路径语义必须逐字透传（不得因遥测异常变成 ok:false）')
  assert.equal(ends, 1, '★ 不得二次调用 end（重复计数 = 观测面失真）')
  // 失败路径同理：写入异常 + 遥测异常 ⇒ 仍如实返回写入错误，而不是遥测错误
  const boom = new Error('EACCES')
  const bad2 = { begin: () => ({}), end: () => { throw new Error('telemetry bug 2') } }
  let res2
  assert.doesNotThrow(() => { res2 = diskWrite(bad2, 'transcript-append', () => { throw boom }) })
  assert.equal(res2.ok, false)
  assert.equal(res2.error, boom, '失败路径须把**写入错误**原样交回（不得被遥测异常顶替，否则调用点会重抛错的东西）')
})

// ── ⑦ diskWrite 自身：显式实例的记账口径（本文件其余用例读单例 snapshot 的对照基准）──────────
test('diskWrite：成功透传 / 失败退 {ok:false} 不抛，账目逐次如实（显式实例，不碰单例）', () => {
  const telemetry = createDiskTelemetry({ slowMs: 0 })
  assert.deepEqual(diskWrite(telemetry, 'loop-state', () => 42), { ok: true, value: 42, level: null, reason: null })
  const err = new Error('ENOSPC: no space left on device')
  const bad = diskWrite(telemetry, 'loop-state', () => { throw err })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, err, '交回调用点的仍是**首次**尝试的写入错误')
  assert.equal(bad.level, 'L2', '非关键项但**未显式**传 critical ⇒ 按 site 判定 ⇒ 舍掉（L2）')
  assert.equal(bad.shed, true, '舍掉才是"降规模"，与 L3 的"告警"分开')
  const st = telemetry.snapshot().sites['loop-state']
  assert.equal(st.count, 3, '1 次成功 + 2 次失败尝试（L0 重试）= 3 次 attempt')
  assert.equal(st.failures, 2, '失败按 attempt 计（自愈会真的再试一次）')
  assert.match(st.lastError, /ENOSPC/)
})
