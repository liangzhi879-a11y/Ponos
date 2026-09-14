// chat 会话模式隔离（2026-09-12 用户指令：「chat模式要与任务模式隔离开，只做类似网页
// agent 的服务，系统提示也要针对性优化」）
// ---------------------------------------------------------------------------
// 病灶（实测证据）：chat 会话的工具表里赫然出现工作流动态工具 run_spec_dev 与 Skill，
// 系统提示仍是任务模式那一整套（教"改文件前先 Read"、列技能/工作流/子 Agent 清单），
// 模型据此答"Skill 工具在此不可用"、承诺去看用户本机项目 —— 能力声明与实际工具集
// 自相矛盾，用户看到的"聊天助手"是个残废的任务 Agent。
// 修复：内核 --session-mode chat 单一开关收口（技能根/工作流根置空、不注入子 Agent/
// 项目指令/记忆、系统提示换 chat 专用版、禁工具表内核自持），bridge 只负责传 flag。
//
// 断言口子：系统提示不落盘（transcript 只有 user/assistant）⇒ 用 PONOS_MOCK_SYS_PROBE
// 多针探针（'|' 分隔，回 SYS_PROBE:<bits>，位序 = NEEDLES 顺序）；工具表/计数读 init 帧。
// 两组用例必须成对：chat 全 0 只有在 task 对照全 1 时才证明"隔离生效"而非"资产没装上"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAT_MODE_DISALLOWED, createToolRegistry } from '../kernel/tools.mjs'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const BRIDGE_SRC = fileURLToPath(new URL('../server/bridge.mjs', import.meta.url))
const BUILTIN_WF = fileURLToPath(new URL('../workflows/spec-dev/workflow.yml', import.meta.url))

// 探针针脚（顺序即 bits 顺序）：前三项 = 任务模式的三张清单，第四项 = AGENTS.md 项目
// 指令块头，第五项 = chat 专用身份（任务模式提示词里不存在）。
const NEEDLES = ['【可用技能】', '【可用工作流】', '【可用子 Agent】', '项目指令（', '联网助理']

// 会话 home：技能（目录形式 SKILL.md）+ 工作流（内置 spec-dev 原件）+ AGENTS.md
// 三件任务资产齐备 —— 缺了任何一件，chat 侧的"不可见"就可能是"没装上"而非"被隔离"。
function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mode-'))
  mkdirSync(join(dir, 'skills', 'demo-skill'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: 演示技能\ntriggers:\n  - 演示触发\n---\n步骤一\n')
  mkdirSync(join(dir, 'workflows', 'spec-dev'), { recursive: true })
  copyFileSync(BUILTIN_WF, join(dir, 'workflows', 'spec-dev', 'workflow.yml'))
  writeFileSync(join(dir, 'AGENTS.md'), '# 项目指令\n演示项目\n')
  return dir
}

// spawn 完整内核进程（engine 单测绕过 cli 层，覆盖不到 spawn 参数 → 提示词的全链）
function spawnKernel(env, dir, extraArgs) {
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir, ...extraArgs,
  ], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let buf = ''
  const events = [] // 按 NDJSON 行解析（数据块会把一行切两半，不能用 includes 判行）
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
  return { proc, events, get out() { return out } }
}

// assistant 文本拼接：mock 的长文本被切成多个 text 块（'SYS_P'/'ROBE:'/'00001'），
// 原始 stdout 里因此拼不出完整 needle ⇒ 必须按事件聚合，不能在 raw 上正则。
function assistantText(events) {
  return events
    .filter((e) => e.type === 'assistant')
    .map((e) => (e.message?.content || []).map((b) => (b?.type === 'text' ? b.text : '')).join(''))
    .join('')
}

// 跑一轮真实会话：等 init → 发一条普通用户消息 → 关 stdin → 收全部事件。
// 消息文本刻意不含 spec-dev 触发词（避免 task 对照跑被自动触发的工作流干扰）。
async function runTurn({ chat }) {
  const dir = makeHome()
  // 注意：句柄整体持有，别解构 —— out 是 getter（解构会在空字符串那一刻定格）
  const h = spawnKernel({
    PONOS_MOCK_API: '1',
    PONOS_MOCK_SYS_PROBE: NEEDLES.join('|'),
    CLAUDE_CONFIG_DIR: dir,
    YFW_HOME: dir,
  }, dir, chat ? ['--session-mode', 'chat'] : [])
  try {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !h.events.some((e) => e.type === 'system' && e.subtype === 'init')) {
      await new Promise((r) => setTimeout(r, 20))
    }
    h.proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'chat-mode-session', message: { role: 'user', content: '你好，介绍一下你能帮我做什么' } }) + '\n')
    h.proc.stdin.end()
    const code = await new Promise((res) => { h.proc.on('close', res) })
    const init = h.events.find((e) => e.type === 'system' && e.subtype === 'init')
    const text = assistantText(h.events)
    const bits = (text.match(/SYS_PROBE:([01]+)/) || [])[1]
    return { code, init, bits, out: h.out }
  } finally {
    try { h.proc.kill() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
}

test('chat 模式：技能/工作流/子 Agent/项目指令全不注入，身份换成联网助理', async () => {
  const r = await runTurn({ chat: true })
  assert.equal(r.code, 0, `chat 轮次应正常退出（实际 ${r.code}）\nstdout=${r.out.slice(-400)}`)
  assert.ok(r.bits, `探针未回显（应见 SYS_PROBE:…，stdout=${r.out.slice(-400)}）`)
  assert.equal(r.bits, '00001',
    `chat 提示词只应有联网助理身份（第 5 位），任务区块一律不得出现；实际 ${r.bits}（针脚顺序 ${NEEDLES.join(' / ')}）`)
  assert.equal(r.init?.session_mode, 'chat', 'init 帧应回显 session_mode=chat')
  assert.equal(r.init?.skills, 0, 'chat 不得发现任何技能')
  assert.equal(r.init?.workflows, 0, 'chat 不得发现任何工作流')
})

test('task 模式（缺省，零回归锁）：三张清单与项目指令照常注入 —— chat 的全 0 因此才有意义', async () => {
  const r = await runTurn({ chat: false })
  assert.equal(r.code, 0, `task 轮次应正常退出（实际 ${r.code}）\nstdout=${r.out.slice(-400)}`)
  assert.equal(r.bits, '11110',
    `task 提示词应含技能/工作流/子 Agent 清单与项目指令，且无 chat 身份；实际 ${r.bits}（针脚顺序 ${NEEDLES.join(' / ')}）`)
  assert.equal(r.init?.session_mode, 'task', 'init 帧应回显 session_mode=task')
  // 恰好 1（= fixtures 里唯一的目录形式技能 demo-skill）：平铺的 AGENTS.md 不再是技能
  // （P2-1 修复的端到端锁——此前这里会数到 2）
  assert.equal(r.init?.skills, 1, `task 应只发现 fixtures 的目录形式技能（实际 ${r.init?.skills}）`)
  assert.ok(r.init?.workflows >= 1, `task 应发现工作流（实际 ${r.init?.workflows}）`)
})

test('chat 模式工具表：本地工具与工作流工具全部不可调用（能力声明与工具集自洽）', async () => {
  const chat = await runTurn({ chat: true })
  const tools = chat.init?.tools || []
  assert.ok(tools.length > 0, `init 帧应带工具表（实际 ${JSON.stringify(chat.init?.tools)}）`)
  for (const t of CHAT_MODE_DISALLOWED) {
    assert.ok(!tools.includes(t), `chat 工具表不得含 ${t}（实际 ${tools.join(', ')}）`)
  }
  assert.ok(!tools.some((t) => String(t).startsWith('run_')), `chat 不得有工作流动态工具（实际 ${tools.join(', ')}）`)
  for (const t of ['WebSearch', 'WebFetch']) {
    assert.ok(tools.includes(t), `chat 必须保留联网工具 ${t}（实际 ${tools.join(', ')}）`)
  }
  // 对照：task 模式下这些工具都在 —— 排除不是"工具没注册"造成的假象
  const task = await runTurn({ chat: false })
  const taskTools = task.init?.tools || []
  for (const t of ['Bash', 'Read', 'Agent']) {
    assert.ok(taskTools.includes(t), `task 工具表应含 ${t}（实际 ${taskTools.join(', ')}）`)
  }
  assert.ok(taskTools.some((t) => String(t) === 'run_spec_dev'), `task 应暴露工作流工具 run_spec_dev（实际 ${taskTools.join(', ')}）`)
})

// 专测一条（T5）：KnowledgeImport 是**写盘类**能力（往知识空间落文件）——chat 必须禁。
// 单独成例而不是只靠上面的逐项比对：deepEqual 红在"两张表不一致"上，而"只在一边 = 漏挡"
// 这种故障（另一条路径照样能写盘）需要点名到具体工具才看得懂。
test('KnowledgeImport（写盘类）必须同时存在于内核权威表与 bridge 拷贝表', () => {
  const src = readFileSync(BRIDGE_SRC, 'utf-8')
  const m = src.match(/export const CHAT_DISALLOWED = \[([^\]]*)\]/)
  assert.ok(m, 'bridge 的 CHAT_DISALLOWED 必须仍存在')
  // 解析数组字面量而不是原串 includes：注释里提到工具名不算"在表里"
  const bridgeIds = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  assert.ok(CHAT_MODE_DISALLOWED.includes('KnowledgeImport'), '内核权威表必须含 KnowledgeImport')
  assert.ok(bridgeIds.includes('KnowledgeImport'), 'bridge 拷贝表必须含 KnowledgeImport（只在一边 = 漏挡）')
})

test('禁工具表双份同源：bridge 拷贝（旧缓存内核兜底）与内核权威表逐项一致', () => {
  const src = readFileSync(BRIDGE_SRC, 'utf-8')
  const m = src.match(/export const CHAT_DISALLOWED = \[([^\]]*)\]/)
  assert.ok(m, 'bridge 的 CHAT_DISALLOWED 必须仍存在（不认 --session-mode 的旧缓存内核的兼容兜底）')
  const ids = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  assert.deepEqual(ids, CHAT_MODE_DISALLOWED, '内核为权威源、bridge 为拷贝，两者必须逐项一致')
  // 双向差集（deepEqual 的补充，不是重复）：deepEqual 红在"数组不同"上，读不出**往哪边漏**，
  // 而两类漂移的后果完全不同 —— 只在 bridge 里 = 权威表漏挡（chat 走内核这条路照样能写盘）；
  // 只在权威表里 = 拷贝漏挡（跑旧缓存内核的用户那条兜底路径放行）。故补双向差集并点名到项。
  const onlyKernel = CHAT_MODE_DISALLOWED.filter((n) => !ids.includes(n))
  const onlyBridge = ids.filter((n) => !CHAT_MODE_DISALLOWED.includes(n))
  assert.deepEqual(onlyKernel, [], `只在权威表里（bridge 拷贝漏了）：${onlyKernel.join(', ')}`)
  assert.deepEqual(onlyBridge, [], `只在 bridge 拷贝里（权威表漏了）：${onlyBridge.join(', ')}`)
  // 手写拷贝最易出的另一类漂移：重复项。行为上无差别，但证明"逐项拷贝"已不再逐项——
  // 下一次改动必然还会错，故当错误暴露而不是放过。
  assert.equal(new Set(CHAT_MODE_DISALLOWED).size, CHAT_MODE_DISALLOWED.length, '权威表不得有重复项')
  assert.equal(new Set(ids).size, ids.length, 'bridge 拷贝表不得有重复项')
})

// 两表"逐项一致"只证明它们**互相**没漂：两边同时把 'KnowledgeImport' 写成 'KnowledgImport'
// （或表里留着一个已改名的工具）时全都绿，而实际效果是**静默漏挡**——chat 里那个工具照样
// 能被调用（禁用的是个不存在的名字）。故再钉一层：每项都必须是注册表里真实存在的工具名。
test('禁工具表不得有死名字：每一项都必须是注册表里真实的工具（拼错 = 静默漏挡）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mode-names-'))
  try {
    const names = new Set(createToolRegistry({ cwd: dir, addDirs: [] }).toolNames)
    assert.ok(names.has('KnowledgeImport'), `前置：注册表应含 KnowledgeImport（实际 ${[...names].join(', ')}）`)
    const dead = CHAT_MODE_DISALLOWED.filter((n) => !names.has(n))
    assert.deepEqual(dead, [], `权威表里的这些名字在注册表中不存在（拼错/已改名的条目等于没禁）：${dead.join(', ')}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
