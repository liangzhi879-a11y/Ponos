// kernel-tests/session-tail-repair.test.mjs —— K2.5 撕裂尾部修复 + K2.4 尾部反查
// （2026-09-13「任务运行慢」系统性优化 Task 10）
// ---------------------------------------------------------------------------
// K2.5 要修的**不是"读不了"**：`load()` 的 readLines 与 bridge 的 transcript.mjs 都逐行
// try/catch 跳过坏行（bridge 还会报 skipped）。真正的病灶是**下一次 append 与残行黏连**——
// `writeEntry` 走 `appendFileSync(line + '\n')`，若崩溃留下的是**没有换行**的半行，新条目会被
// 拼到同一行上 ⇒ 整行 parse 失败 ⇒ **新条目静默丢失**。故核心用例必须走"先制造撕裂尾部 →
// 加载 → 再 append 一条 → 重载后新条目必须在"，而不是只断言"加载不抛错"（那种断言在修复前
// 也是绿的，等于空跑）。
//
// K2.4 要修的**不是"补不上 usage"**，而是补 usage 时**逐行 JSON.parse 整个文件**去反查 seq。
// 故核心用例是"尾部快路径真的没扫全文件"——只看结果的话，把 TAIL_SCAN 改成 0（全量回退）
// 也全绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore, newSessionId } from '../kernel/session.mjs'

function newHome() {
  const home = mkdtempSync(join(tmpdir(), 'yfw-tail-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const CWD = 'C:\\proj\\demo'

/** 建 store（并写一条 user 条目，确保文件存在且以 '\n' 结尾） */
function seed(home, sid) {
  const s = createSessionStore({ configDir: home, cwd: CWD, sessionId: sid })
  s.appendUser('第一条')
  s.appendAssistant([{ type: 'text', text: '回复' }])
  return s
}

const entry = (seq, text) => JSON.stringify({
  type: 'user', id: `id-${seq}`, seq, timestamp: '2026-01-01T00:00:00.000Z',
  surfaceOp: 'append', message: { role: 'user', content: text },
})

test('核心：撕裂尾部（无换行）必须先修复，否则紧接着的 append 会被黏连丢失', async () => {
  const { home, cleanup } = newHome()
  try {
    const sid = newSessionId()
    const s = seed(home, sid)
    // 制造撕裂：末尾追加半行 JSON（**不带换行**）
    const partial = '{"type":"user","id":"torn","seq":99,"message":{"role":"user","con'
    appendFileSync(s.file, partial, 'utf-8')
    assert.ok(!readFileSync(s.file, 'utf-8').endsWith('\n'), '夹具前提：末尾无换行')

    const s2 = createSessionStore({ configDir: home, cwd: CWD, sessionId: sid })
    const loaded = await s2.load()
    assert.ok(loaded.tornTailDropped > 0, '必须报告丢弃了残行字节数（诊断不降级）')
    assert.ok(readFileSync(s.file, 'utf-8').endsWith('\n'), '修复后文件必须以换行结尾')

    // 关键断言：修复之后写入的新条目**必须能读回来**（修复前会与残行黏连 ⇒ 丢失）
    s2.appendUser('修复后的新条目')
    const s3 = createSessionStore({ configDir: home, cwd: CWD, sessionId: sid })
    const again = await s3.load()
    const texts = again.entries.filter((e) => e?.message?.content).map((e) => e.message.content)
    assert.ok(texts.includes('修复后的新条目'), '修复后 append 的条目不得丢失（这就是病灶本身）')
    assert.ok(!texts.some((t) => typeof t === 'string' && t.includes('"id":"torn"')), '残行不得被当成内容')
    assert.equal(again.tornTailDropped, 0, '已被修复 ⇒ 第二次加载无事可做')
  } finally { cleanup() }
})

test('残行本身是完整 JSON（崩溃恰落在对象结尾）⇒ 只补换行，一个字节都不丢', async () => {
  const { home, cleanup } = newHome()
  try {
    const sid = newSessionId()
    const s = seed(home, sid)
    appendFileSync(s.file, entry(77, '完好的最后一条'), 'utf-8') // 完整 JSON，但**没有结尾换行**
    const before = readFileSync(s.file, 'utf-8')

    const s2 = createSessionStore({ configDir: home, cwd: CWD, sessionId: sid })
    const loaded = await s2.load()
    assert.equal(loaded.tornTailDropped, 0, '完整 JSON 只补换行，不算丢弃')
    const after = readFileSync(s.file, 'utf-8')
    assert.equal(after, before + '\n', '内容必须逐字节保留，只多一个换行')
    assert.ok(loaded.entries.some((e) => e?.message?.content === '完好的最后一条'), '该条必须仍可读')

    s2.appendUser('后续')
    const s3 = createSessionStore({ configDir: home, cwd: CWD, sessionId: sid })
    const again = await s3.load()
    assert.ok(again.entries.some((e) => e?.message?.content === '后续'), '后续 append 不得被黏连')
  } finally { cleanup() }
})

test('健康文件零改动：内容逐字节不变、mtime 不变（不许"顺手"重写）', async () => {
  const { home, cleanup } = newHome()
  try {
    const sid = newSessionId()
    const s = seed(home, sid)
    await sleep(30) // 越过 Windows mtime 粒度（15.6ms）
    const before = readFileSync(s.file, 'utf-8')
    const mtimeBefore = statSync(s.file).mtimeMs
    const s2 = createSessionStore({ configDir: home, cwd: CWD, sessionId: sid })
    const loaded = await s2.load()
    assert.equal(loaded.tornTailDropped, 0)
    assert.equal(readFileSync(s.file, 'utf-8'), before, '健康文件不得被改写')
    assert.equal(statSync(s.file).mtimeMs, mtimeBefore, 'mtime 不变 ⇒ 确实没写过盘')
  } finally { cleanup() }
})

test('坏行在**中间**：只有末尾残行被处理，尾部完整条目必须留下', async () => {
  const { home, cleanup } = newHome()
  try {
    const sid = newSessionId()
    const s = seed(home, sid)
    // 中间插一条坏行（**带换行**：完整但损坏），随后是完好的尾部残行（无换行）
    appendFileSync(s.file, '{"坏行": ,,,}\n' + entry(88, '尾巴'), 'utf-8')
    const s2 = createSessionStore({ configDir: home, cwd: CWD, sessionId: sid })
    const loaded = await s2.load()
    const texts = loaded.entries.map((e) => e?.message?.content)
    assert.ok(texts.includes('尾巴'), '尾部残行是完整 JSON ⇒ 必须保留')
    assert.ok(texts.includes('第一条'), '更早的条目不受影响')
    // 中间坏行仍在盘上（它带换行、不构成黏连风险，留着供排查；加载侧照旧跳过）
    assert.ok(readFileSync(s.file, 'utf-8').includes('{"坏行"'), '中间坏行不因本次修复被删')
  } finally { cleanup() }
})

test('K2.4 尾部快路径：末条命中时不得逐行 parse 整个文件', async () => {
  const { home, cleanup } = newHome()
  try {
    const sid = newSessionId()
    const s = seed(home, sid)
    // 造长历史（行要**像真机那样肥**：实测均长 4.6KB/行），再把待补 usage 的条目写到末尾
    const big = []
    for (let i = 0; i < 1500; i++) big.push(entry(1000 + i, `历史 ${i} `.padEnd(4400, 'x')))
    appendFileSync(s.file, big.join('\n') + '\n', 'utf-8')
    const target = s.appendAssistant([{ type: 'text', text: '末条' }])
    const loaded = await s.load()
    const midEntry = loaded.entries.find((e) => e?.seq === 1000 + 750)
    assert.ok(midEntry?.message, '夹具前提：中部目标存在')

    // 直接数 JSON.parse 的次数——这是本任务要修的**病灶本身**。原实现自头 findIndex，
    // 付费 = 目标行距文件头的行数：对**唯一真实调用点**（末条补 usage，engine.mjs:1049）
    // 就是整文件；对中部条目是半文件。故对照组取中部条目——它走的是**仍保留的**原回退路径，
    // 量出来的就是"原实现要付多少"，无需在测试里重抄一份老代码。
    // 不用耗时做判据：readFileSync + 整文件重写（temp+rename，为保原子性必须保留）占了约 2/3，
    // 耗时比最多 ~1.5×，拿它当断言既弱又受机器抖动影响。
    const realParse = JSON.parse
    const countParses = (fn) => {
      let n = 0
      JSON.parse = (t, rev) => { n++; return realParse(t, rev) }
      try { fn() } finally { JSON.parse = realParse }
      return n
    }
    const tailParses = countParses(() => s.setEntryUsage(target, { input_tokens: 5, output_tokens: 7 }))
    const midParses = countParses(() => s.setEntryUsage(midEntry, { input_tokens: 9, output_tokens: 9 }))

    assert.ok(tailParses <= 8, `末条命中只许 parse 尾部有限条，实测 ${tailParses} 次`)
    assert.ok(midParses > 700, `回退路径必须仍按原语义自头反查（中部条目 ⇒ 700+ 次），实测 ${midParses} 次`)
    assert.ok(tailParses * 50 < midParses, `两路差距必须是量级差：${tailParses} vs ${midParses}`)

    // 语义正确性：usage 确实落到各自目标行上（快路径与回退路径都要对）
    const rows = readFileSync(s.file, 'utf-8').split('\n')
      .map((l) => { try { return realParse(l) } catch { return null } })
    const at = (seq) => rows.find((e) => e && e.seq === seq)
    assert.deepEqual(at(target.seq).message.usage, { input_tokens: 5, output_tokens: 7 })
    assert.deepEqual(at(midEntry.seq).message.usage, { input_tokens: 9, output_tokens: 9 })
    assert.equal(rows.filter((e) => e?.message?.usage).length, 2, '只许改目标这两行')
  } finally { cleanup() }
})

test('K2.4 幂等：usage 已是目标值 ⇒ 不重写文件（mtime 不变）', async () => {
  const { home, cleanup } = newHome()
  try {
    const sid = newSessionId()
    const s = seed(home, sid)
    const target = s.appendAssistant([{ type: 'text', text: '末条' }])
    s.setEntryUsage(target, { input_tokens: 3, output_tokens: 4 })
    await sleep(30)
    const before = readFileSync(s.file, 'utf-8')
    const mtimeBefore = statSync(s.file).mtimeMs
    s.setEntryUsage(target, { input_tokens: 3, output_tokens: 4 }) // 同值再补一次
    assert.equal(readFileSync(s.file, 'utf-8'), before, '内容不变')
    assert.equal(statSync(s.file).mtimeMs, mtimeBefore, '没写过盘 ⇒ mtime 不变')
  } finally { cleanup() }
})

test('K2.4 回退语义不变：目标在文件开头时仍能改写（且只改那一行）', async () => {
  const { home, cleanup } = newHome()
  try {
    const sid = newSessionId()
    const s = seed(home, sid)
    const firstSeq = 1 // seed 的第一条 user 条目
    for (let i = 0; i < 50; i++) s.appendUser(`填充 ${i}`)
    s.setEntryUsage({ seq: firstSeq, message: { role: 'user', content: '第一条' } }, { input_tokens: 11, output_tokens: 22 })
    const lines = readFileSync(s.file, 'utf-8').split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } })
    const patched = lines.find((e) => e && e.seq === firstSeq)
    assert.deepEqual(patched.message.usage, { input_tokens: 11, output_tokens: 22 }, '开头那条必须被改写')
    assert.equal(lines.filter((e) => e?.message?.usage).length, 1, '只许改一行')
  } finally { cleanup() }
})
