// kernel-tests/disabled-e2e.test.mjs
// 停用开关的**真进程端到端**证据（2026-09-15，P1「agent和skill页面及功能需要大改」D 条款）。
//
// ## 为什么必须 spawn 真内核，而不是只测函数
//
// 本条款唯一要防的故障是**假开关**：界面上关了、内核照旧加载/调用。而"注册表文件 → cli 读它 →
// 提示词技能清单 / 工具池 / resolveAgents"这条链有 4 个环节，任一环漏读都仍然"测试全绿"：
//   · 只测 `readDisabled` → 文件读得对，但 cli 可能根本没调用它；
//   · 只测 `discoverSkillsAll(disabled)` → 过滤逻辑对，但 cli 可能没把 disabled 传进去。
// 故这里用真内核 + mock API（`PONOS_MOCK_API=1`，无网络、确定性）+ 系统提示探针
// （`PONOS_MOCK_SYS_PROBE`，把"某技能名是否出现在提示词里"编码成 bits），
// 直接观察**提示词里还有没有那个技能**——这正是模型能看到的东西。
//
// 隔离纪律：configDir/YFW_HOME 与夹具全在 mkdtempSync 临时目录内，绝不碰真实 home。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))

/** 两个技能：alpha 会被停用，beta 作为对照（证明"只停用目标项，不误伤"）。 */
const SKILL_IDS = ['demo-alpha', 'demo-beta']
/** 探针针脚顺序即 bits 顺序：0=alpha 名出现，1=beta 名出现，2=停用清单出现在 init/日志（可选）。 */
const NEEDLES = SKILL_IDS

function makeHome({ skills = SKILL_IDS, disabled } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-disabled-e2e-'))
  for (const id of skills) {
    const d = join(dir, 'skills', id)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${id} 的测试说明（用于验证全局停用是否真的生效）\n---\n\n# ${id}\n\n步骤：先读，再做。\n`,
      'utf-8')
  }
  if (disabled) {
    writeFileSync(join(dir, 'disabled.json'), JSON.stringify(disabled, null, 2), 'utf-8')
  }
  return dir
}

/** 跑一轮真会话，回 bits（系统提示探针）+ init 帧。
 *  `needles` 必须可传：技能用例探技能名、agent 用例探 agent 说明串。**初版漏了这个参数**
 *  （固定用模块级 NEEDLES=技能 id），agent 用例于是永远得到 '00'，看起来像"功能没生效"的假红灯。 */
async function runTurn({ dir, userText = '你好', needles = NEEDLES } = {}) {
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir,
  ], {
    env: {
      ...process.env, PONOS_MOCK_API: '1', PONOS_MOCK_SYS_PROBE: needles.join('|'),
      PONOS_CONFIG_DIR: dir, YFW_HOME: dir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let buf = ''
  const events = []
  proc.stdout.on('data', (d) => {
    out += d
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 半行/脏行跳过 */ }
    }
  })
  try {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !events.some((e) => e.type === 'system' && e.subtype === 'init')) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
    proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'disabled-e2e', message: { role: 'user', content: userText } }) + '\n')
    proc.stdin.end()
    const code = await new Promise((res) => { proc.on('close', res) })
    const text = events.filter((e) => e.type === 'assistant')
      .map((e) => (e.message?.content || []).map((b) => (b?.type === 'text' ? b.text : '')).join('')).join('')
    return { code, bits: (text.match(/SYS_PROBE:([01]+)/) || [])[1], init, out }
  } finally {
    try { proc.kill() } catch {}
  }
}

test('基线：未停用时两个技能都进提示词（否则下面的对比无意义）', async () => {
  const dir = makeHome()
  try {
    const r = await runTurn({ dir })
    assert.equal(r.code, 0, `内核应正常退出\nstdout=${r.out.slice(-400)}`)
    assert.ok(r.bits, `探针未回显：${r.out.slice(-400)}`)
    assert.equal(r.bits[0], '1', '基线：demo-alpha 应在提示词技能清单里')
    assert.equal(r.bits[1], '1', '基线：demo-beta 应在提示词技能清单里')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('**核心**：disabled.json 停用 demo-alpha 后，真内核的提示词里不再有它（且不误伤 beta）', async () => {
  const dir = makeHome({ disabled: { schemaVersion: 1, skills: ['demo-alpha'], agents: [] } })
  try {
    const r = await runTurn({ dir })
    assert.equal(r.code, 0, `内核应正常退出\nstdout=${r.out.slice(-400)}`)
    assert.ok(r.bits, `探针未回显：${r.out.slice(-400)}`)
    assert.equal(r.bits[0], '0', '**核心断言**：停用后模型看不到该技能（这才叫真开关，而不是界面自嗨）')
    assert.equal(r.bits[1], '1', '对照项：未停用的 beta 必须照旧可用（不得误伤）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('容错：disabled.json 损坏 → 退化为"全部可用"（内核不崩，功能不丢）', async () => {
  const dir = makeHome()
  try {
    writeFileSync(join(dir, 'disabled.json'), '{ 这不是合法 JSON', 'utf-8')
    const r = await runTurn({ dir })
    assert.equal(r.code, 0, '读坏注册表也必须能起会话（否则一个手改坏的文件会让整个应用不可用）')
    assert.ok(r.bits, `探针未回显：${r.out.slice(-400)}`)
    assert.equal(r.bits[0], '1', '读失败退化为"未停用"：两个技能都在')
    assert.equal(r.bits[1], '1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('恢复：删掉停用项后技能回到提示词（开关是双向的，不是单向自杀）', async () => {
  const dir = makeHome({ disabled: { schemaVersion: 1, skills: ['demo-alpha'], agents: [] } })
  try {
    const off = await runTurn({ dir })
    assert.equal(off.bits?.[0], '0', '前置：已停用')
    // 模拟用户在界面上重新启用（等价于写回空清单）
    writeFileSync(join(dir, 'disabled.json'), JSON.stringify({ schemaVersion: 1, skills: [], agents: [] }), 'utf-8')
    const on = await runTurn({ dir })
    assert.equal(on.bits?.[0], '1', '重新启用后必须恢复可用（否则"停用"成了不可逆操作）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── agent 侧：停用后不得出现在「可用子 Agent」表里 ───────────────────────────
//
// 先确认过观测口：子 Agent 表是 **系统提示**里的 `【可用子 Agent】` 区块
// （kernel/prompt.mjs:192-197，`- id：description（tools: …）`），故用与技能同一套
// `PONOS_MOCK_SYS_PROBE`（而非 ANCHOR_PROBE——后者只看非 system 条目，而 agent 表不在那里；
// 初版误用 ANCHOR_PROBE，基线直接为 0，正是"探针选错观测口"的典型假红灯）。
//
// 为什么值得单独跑一次真进程：agent 停用走 `resolveAgents`，与技能那条链是**完全不同的代码路径**。

/** 造一个自定义 agent 的 .md 夹具（description 里埋独特针脚）。 */
function writeAgentFixture(dir, id, marker) {
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'agents', `${id}.md`),
    `---\nname: ${id}\ndescription: ${marker}\n---\n\n你是 ${id}。\n`, 'utf-8')
}

test('**核心**：停用 agent 后，真内核的「可用子 Agent」表里不再有它', async () => {
  const MARK_A = 'ALPHA_AGENT_MARKER_独特说明串'
  const MARK_B = 'BETA_AGENT_MARKER_独特说明串'
  const dir = mkdtempSync(join(tmpdir(), 'ponos-disabled-agent-'))
  try {
    writeAgentFixture(dir, 'demo-agent-alpha', MARK_A)
    writeAgentFixture(dir, 'demo-agent-beta', MARK_B)

    // 基线：两个 agent 都进系统提示的可用子 Agent 表
    const base = await runTurn({ dir, needles: [MARK_A, MARK_B] })
    assert.ok(base.bits, `探针未回显：${base.out.slice(-300)}`)
    assert.equal(base.bits[0], '1', '基线：alpha agent 应在可用子 Agent 表里')
    assert.equal(base.bits[1], '1', '基线：beta agent 应在可用子 Agent 表里')

    // 停用 alpha：写注册表（写文件还不够——必须证明 resolveAgents 真的读了它）
    writeFileSync(join(dir, 'disabled.json'),
      JSON.stringify({ schemaVersion: 1, agents: ['demo-agent-alpha'], skills: [] }), 'utf-8')
    const after = await runTurn({ dir, needles: [MARK_A, MARK_B] })
    assert.ok(after.bits, `探针未回显：${after.out.slice(-300)}`)
    assert.equal(after.bits[0], '0', '**核心断言**：停用后模型看不到它 —— 连"可派发"的暗示都不剩')
    assert.equal(after.bits[1], '1', '对照项：未停用的 beta agent 必须照旧可派发')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── H 条款：**内核硬编码内置** agent 也能被停用（原先界面上看不到、也就停不掉） ──────────
//
// 为什么必须单独测这一条：`researcher`/`implementer`/`reviewer`/`explorer`/`planner` 的定义
// 在 `kernel/agents.mjs` 的 `BUILTIN_AGENTS` 里，**不在 GUI 的 agent 列表**中。故：
//   · 它们**没有 .md 文件**，`agents:sync` 的 enabled 机制对它们无效 —— 只能靠停用注册表；
//   · 这正是 D 条款曾经的覆盖缺口（机制支持、但没有入口）。
// 观测口同上（系统提示的「可用子 Agent」表），针脚取内置 agent 的 description 片段。

test('**核心（H）**：内核硬编码内置 agent 也能被停用（researcher 这类没有 .md 的）', async () => {
  // 针脚 = 内置 agent description 的唯一片段（不用 id：id 还可能出现在 Task 工具说明里，会误判）
  const NEEDLE_RESEARCHER = '调查与研究类任务'
  const NEEDLE_PLANNER = '规划者'
  const dir = mkdtempSync(join(tmpdir(), 'ponos-disabled-builtin-'))
  try {
    // 基线：内置 agent 本来在「可用子 Agent」表里
    const base = await runTurn({ dir, needles: [NEEDLE_RESEARCHER, NEEDLE_PLANNER] })
    assert.ok(base.bits, `探针未回显：${base.out.slice(-300)}`)
    assert.equal(base.bits[0], '1', '基线：researcher 应在可用子 Agent 表里')
    assert.equal(base.bits[1], '1', '基线：planner 应在可用子 Agent 表里')

    // 只写注册表（没有 .md 可同步）—— 这正是内置 agent 唯一可行的停用路径
    writeFileSync(join(dir, 'disabled.json'),
      JSON.stringify({ schemaVersion: 1, agents: ['researcher'], skills: [] }), 'utf-8')
    const after = await runTurn({ dir, needles: [NEEDLE_RESEARCHER, NEEDLE_PLANNER] })
    assert.ok(after.bits, `探针未回显：${after.out.slice(-300)}`)
    assert.equal(after.bits[0], '0', '**H 核心断言**：内置 agent 也必须真的停得掉（原先硬编码表是豁免区）')
    assert.equal(after.bits[1], '1', '对照项：未停用的 planner 必须照旧可派发')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
