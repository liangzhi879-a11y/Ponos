// 演化 P1：`--evolution-candidates` 只读镜像（D9）—— 共享实现 + CLI 短路端到端
// ---------------------------------------------------------------------------
// 设计真源：docs/superpowers/specs/2026-10-08-runtime-evolution-loop-design.md §4.5；
// 施工 brief：docs/superpowers/plans/2026-10-09-p1-opportunity-layer.md（T3 / D9）。
// 语义：投影（runEvolutionReport 同源）→ 挖掘（mineCandidates）→ stdout JSON，**不写盘**。
// 纪律：与 --evolution-report 同款"永不抛给调用方"契约（异常折 code=1 + error）。
// 运行：node --test kernel-tests/evolution-cli-candidates.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEvolutionCandidates } from '../kernel/readonly.mjs'
// 候选行 schema 版本（升版触发存量行重物化，见 opportunity-mine.mjs#MINE_V）
import { MINE_V } from '../kernel/opportunity-mine.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KERNEL_CLI = join(__dirname, '..', 'kernel', 'cli.mjs')
const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9]/g, '-')

function mkHome() {
  const dir = mkdtempSync(join(tmpdir(), 'evo-cli-cand-'))
  return { dir, home: join(dir, 'home'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 写一个含 5 次 Bash 工具失败（≥K₁=5）的转录，形状与 evolution-patches 夹具同源。 */
function seedHotspotSession(home, sessionId = 's1') {
  const projDir = join(home, 'projects', sanitize('proj-a'))
  mkdirSync(projDir, { recursive: true })
  const at = (i) => `2026-10-0${8}T00:0${i}:00.000Z`
  const lines = [
    JSON.stringify({ type: 'user', seq: 1, timestamp: at(0), message: { role: 'user', content: '帮我跑个任务' } }),
  ]
  for (let i = 0; i < 5; i++) {
    const id = `c${i}`
    lines.push(JSON.stringify({ type: 'assistant', seq: 2 + i * 2, timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { cmd: 'x' } }], model: 'm' } }))
    lines.push(JSON.stringify({ type: 'user', seq: 3 + i * 2, timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'err', is_error: true }] } }))
  }
  writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
}

function runCli(args, env) {
  // 与 server/kernel-readonly.mjs 同款前置：main() 的格式闸在只读短路**之前**（cli.mjs:415）
  const r = spawnSync(process.execPath, [KERNEL_CLI, '--output-format', 'stream-json', '--input-format', 'stream-json', ...args], {
    encoding: 'utf-8',
    env: { ...process.env, PONOS_MOCK_API: '1', ...env },
    timeout: 60_000,
  })
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

// ── 共享实现（runEvolutionCandidates）────────────────────────────────────
test('空库 ⇒ candidates=[] + counts 全 0 + v/window/generatedAt 形状齐（空不是错）', () => {
  const { home, cleanup } = mkHome()
  try {
    const out = runEvolutionCandidates({ configDir: home, now: '2026-10-09T12:00:00.000Z' })
    // ★ 2026-10-14：1 → 2（候选行 schema 版本，见 kernel/opportunity-mine.mjs#MINE_V）。
    //   用 MINE_V 而不是字面量：这条断言要钉的是"输出带**当前**版本号"，写死字面量会在每次升版时
    //   变成一次纯机械改动（而它的语义从未变过）。
    assert.equal(out.v, MINE_V)
    assert.equal(out.generatedAt, '2026-10-09T12:00:00.000Z')
    assert.deepEqual(out.counts, { total: 0, pin: 0, list: 0, collapsed: 0 })
    assert.deepEqual(out.candidates, [])
    assert.deepEqual(out.window, { from: '2026-09-10', to: '2026-10-09', days: 30 })
  } finally { cleanup() }
})

test('热点转录（Bash 失败 5 次 / 调用 5 次 = 100%）⇒ OPP-1 候选带 tier（与投影同源、与挖矿规则一致）', () => {
  const { home, cleanup } = mkHome()
  try {
    seedHotspotSession(home)
    const out = runEvolutionCandidates({ configDir: home, now: '2026-10-09T12:00:00.000Z' })
    // ★ 2026-10-14 修正断言的**范围**（不是放宽）：原写作 `out.candidates.length === 1`，
    //   把"候选集里恰好只有 OPP-1"当成了不变量。但 A2 档新增的 **OPP-7（能力缺口）判的是另一件事**：
    //   "同一会话内同一工具反复失败 ≥2 次且全程零技能加载" —— 本 fixture 恰好满足 ⇒ 它会**正当地**
    //   多出 OPP-7 候选（其建议是 create-skill/revise-existing）。所以"候选数 == 1"不再是正确的是不变量，
    //   本用例真正要钉的是 **OPP-1 自身**的行为 ⇒ 改为按规则取候选判定（更强：不依赖"没有别的规则"）。
    const opp1 = out.candidates.filter((c) => c.ruleId === 'OPP-1')
    assert.equal(opp1.length, 1, 'OPP-1 恰好一条（其余规则是否出候选与本用例无关）')
    const c = opp1[0]
    assert.equal(c.subject, 'Bash')
    assert.equal(c.count, 5)
    assert.equal(c.state, 'new')
    // ★ 2026-10-10 口径变更：OPP-1 强度从"失败次数"改成"**错误率**"。
    //   本 fixture 是 5 次调用 5 次失败（100%）⇒ freqRatio=100%/15%=6.67 ⇒ freq 饱和 ⇒ score=1×fresh(1d)=0.9667 ⇒ pin。
    //   （旧口径按次数算：5/5=1 ⇒ freq=1/1.5 ⇒ 只有 list —— 两种"5 次失败"的严重度本就不该相同：
    //    5 次全失败 vs 5 次失败/1000 次调用，后者才是常态。）
    assert.equal(c.tier, 'pin', '100% 错误率 ⇒ freq 饱和 ⇒ pin')
    assert.equal(c.score, 0.95) // freq=1 × sev=1 × fresh（lastAt=10-08T00:01Z 距 now=10-09T12:00Z ≈1.5 天 ⇒ 1−1.5/30=0.95）
    assert.equal(c.metrics.errRate, 1)
    assert.equal(c.metrics.calls, 5)
    // ★ 2026-10-14 加（"事实行"要用的实测数字）：倍数由**内核**算好给出，前端不再算第二遍
    //   （同一件事两处实现 = 漂移源）。本 fixture：Bash 100% ÷ 全局 100% ⇒ 1 倍。
    assert.equal(c.metrics.multiple, 1, '倍数在 metrics 里给出（供事实行与评审提示词共用）')
    // 计数按**全量候选**算（与上面按规则判定不矛盾：这里钉的是"tier 分档统计与候选集自洽"）
    const total = out.candidates.length
    assert.deepEqual(out.counts, {
      total,
      pin: out.candidates.filter((x) => x.tier === 'pin').length,
      list: out.candidates.filter((x) => x.tier === 'list').length,
      collapsed: out.candidates.filter((x) => x.tier === 'collapsed').length,
    }, 'counts 必须与候选集自洽')
    // 证据可回跳：firstRef 来自投影（会话 + seq + ts）
    assert.equal(c.evidence[0].sessionId, 's1')
    assert.equal(typeof c.evidence[0].seq, 'number')
  } finally { cleanup() }
})

test('★ 降噪（2026-10-10）：同样 5 次失败但调用 1000 次（0.5%）⇒ 不出候选（常态错误不是机会）', () => {
  const { home, cleanup } = mkHome()
  try {
    // 在热点会话之外，追加一个"大量成功 Bash 调用"的会话 ⇒ 把 Bash 的错误率摊薄到 0.5%
    const projDir = join(home, 'projects', sanitize('proj-a'))
    mkdirSync(projDir, { recursive: true })
    seedHotspotSession(home, 's1')
    const lines = [JSON.stringify({ type: 'user', seq: 1, timestamp: '2026-10-08T01:00:00.000Z', message: { role: 'user', content: '跑很多命令' } })]
    for (let i = 0; i < 995; i++) {
      const id = `ok${i}`
      lines.push(JSON.stringify({ type: 'assistant', seq: 2 + i * 2, timestamp: '2026-10-08T01:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { cmd: 'x' } }], model: 'm' } }))
      lines.push(JSON.stringify({ type: 'user', seq: 3 + i * 2, timestamp: '2026-10-08T01:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }))
    }
    writeFileSync(join(projDir, 's2.jsonl'), lines.join('\n') + '\n')
    const out = runEvolutionCandidates({ configDir: home, now: '2026-10-09T12:00:00.000Z' })
    // ★ 2026-10-14 修正断言**范围**（不是放宽）：原写 `deepEqual(out.candidates, [])` ——
    //   降噪针对的是 **OPP-1（工具失败热点）**"常态错误率不算机会"。而 OPP-7（能力缺口）判的是
    //   另一件事（同会话同工具反复失败 + 零技能加载），本 fixture 里它**应当**命中：
    //   摊薄的是**错误率**，不是"该工具反复失败"这个事实。两者本就该各自成立。
    const opp1 = out.candidates.filter((c) => c.ruleId === 'OPP-1')
    assert.deepEqual(opp1, [], 'Bash 5/1000=0.5% ⇒ 常态错误率，不得出 OPP-1（这正是降噪要消掉的那批）')
    assert.ok(out.candidates.every((c) => c.ruleId !== 'OPP-1'), '候选集里一个 OPP-1 都不许有')
    // ★ 2026-10-14 换掉"前置证明"的做法：原先借 OPP-7（能力缺口）命中来证明"候选集非空"，
    //   但 OPP-7 判据本轮改成**要求跨 ≥2 会话**，本 fixture 只有 1 个被摊薄的会话 ⇒ 不再命中。
    //   改用**对比反证**（更强且与其他规则解耦）：把同样的 fixture 的失败次数提上去（错误率达到门），
    //   OPP-1 **必须**出现 —— 这才证明"没有 OPP-1"是**错误率门**在起作用，而不是夹具本身不产候选。
    const lines2 = [JSON.stringify({ type: 'user', seq: 1, timestamp: '2026-10-08T01:00:00.000Z', message: { role: 'user', content: '跑很多命令' } })]
    for (let i = 0; i < 200; i++) {
      const id = `bad${i}`
      lines2.push(JSON.stringify({ type: 'assistant', seq: 2 + i * 2, timestamp: '2026-10-08T01:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { cmd: 'x' } }], model: 'm' } }))
      lines2.push(JSON.stringify({ type: 'user', seq: 3 + i * 2, timestamp: '2026-10-08T01:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'boom', is_error: true }] } }))
    }
    writeFileSync(join(projDir, 's3.jsonl'), lines2.join('\n') + '\n')
    const out2 = runEvolutionCandidates({ configDir: home, now: '2026-10-09T12:00:00.000Z' })
    assert.equal(out2.candidates.filter((c) => c.ruleId === 'OPP-1').length, 1,
      '★ 对比反证：把失败次数提上去（错误率达标）⇒ OPP-1 必须出现（否则上一条是恒真的）')
  } finally { cleanup() }
})

// ── CLI 短路（真实 spawn，空库）───────────────────────────────────────────
test('CLI：--evolution-candidates 出纯 JSON（空库 candidates=[]，EXIT=0）', () => {
  const { home, cleanup } = mkHome()
  try {
    mkdirSync(home, { recursive: true })
    const r = runCli(['--evolution-candidates'], { PONOS_CONFIG_DIR: home })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.v, MINE_V, '输出带当前 schema 版本（用 MINE_V，不写死字面量）')
    assert.deepEqual(out.candidates, [])
    assert.deepEqual(out.counts, { total: 0, pin: 0, list: 0, collapsed: 0 })
  } finally { cleanup() }
})

test('CLI：--evolution-report 不互踩（新增 flag 后仍出 records/summary 形状）', () => {
  const { home, cleanup } = mkHome()
  try {
    mkdirSync(home, { recursive: true })
    const r = runCli(['--evolution-report'], { PONOS_CONFIG_DIR: home })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.records, [])
    assert.ok(out.summary && typeof out.summary === 'object', '报告形状（records/summary）不受新增子命令影响')
  } finally { cleanup() }
})

test('CLI：--evolution-candidates --window 7d ⇒ window.days=7（白名单参数贯通）', () => {
  const { home, cleanup } = mkHome()
  try {
    mkdirSync(home, { recursive: true })
    const r = runCli(['--evolution-candidates', '--window', '7d'], { PONOS_CONFIG_DIR: home })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.window.days, 7)
  } finally { cleanup() }
})
