// kernel-tests/workflow-prompt-refresh.test.mjs —— 【可用工作流】清单必须随盘面变化重算
//
// 病灶（2026-09-17）：系统提示词里的【可用工作流】区块只在**内核启动时**组装一次，
// 而 engine 每次请求都读同一份快照（engine.mjs:2342 getSystem: () => systemPrompt）。
// 于是会话存活期间被删除的工作流，在提示词里纹丝不动 —— agent 照着旧清单声称
// "我可以调用 run_xxx"，可 run_<slug> 工具**已随盘面签名失效而从工具池消失**
// （kernel/dyntools.mjs 的盘面签名含工作流根条目名列表），真调必然失败。
// 用户侧观测到的就是"工作流已删除了、agent 仍能获取到（但一跑就没输出）"。
//
// 断言口子：PONOS_MOCK_SYS_PROBE（kernel/api.mjs）——mock 把"系统提示词里是否含某子串"
// 编码成 SYS_PROBE:<bits> 回给模型。**这是唯一能从进程外看到真实提示词的口子**
// （提示词不落盘：transcript 只有 user/assistant），故必须走真实内核进程 + mock API。
//
// 覆盖：
//   ① 基线：工作流存在 → 探针命中（否则下面的对比无意义）
//   ② 核心：同进程会话内删掉该工作流 → **第二轮请求的提示词里不再有它**
//   ③ 反向（防过度刷新/误伤）：另建一个工作流 → 第二轮提示词里出现（发现面不被冻住）
//   ④ 工具池与清单同口径：删除后 run_<slug> 不再出现在 tools 列表（init 帧之外另取一帧）
//      —— 单测见 kernel-tests/workflow-dyntools.test.mjs，此处只做"提示词 vs 工具池"的对照。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 允许指向另一份内核（PONOS_KERNEL_CLI=release/YFWorking/kernel/cli.mjs），
// 用于验证「精准移植到运行版」的那份 cli.mjs 同样具备每轮刷新。
const KERNEL_CLI = process.env.PONOS_KERNEL_CLI
  ? join(process.cwd(), process.env.PONOS_KERNEL_CLI)
  : join(__dirname, '..', 'kernel', 'cli.mjs')

// DSL v2 合法工作流（start → template → end）：必须能被 resolveSkillRoots/发现链正常解析，
// 否则它压根不进清单，探针恒 0 → 测试失去意义。
// **`expose.mode: public` 不可省**：listVisibleWorkflows 对 mode 缺省的工作流按 private 处理
// 并直接排除（kernel/dyntools.mjs visibilityOf），漏了它 → 基线轮就命中不到（探针恒 00）。
const wf = (name) => `name: ${name}
version: 1.0.0
description: ${name} 的测试说明
expose:
  mode: public
nodes:
  - { id: start, type: start }
  - { id: t, type: template, template: "hi" }
  - { id: done, type: end }
edges:
  - { id: e1, source: start, target: t }
  - { id: e2, source: t, target: done }
`

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-wf-refresh-'))
  // 工作流发现根 = [...skillRoots, <configDir>/workflows]（kernel/cli.mjs workflowRoots）
  mkdirSync(join(dir, 'workflows', 'e2e-alpha'), { recursive: true })
  writeFileSync(join(dir, 'workflows', 'e2e-alpha', 'workflow.yml'), wf('e2e-alpha'), 'utf-8')
  return dir
}

function spawnKernel(dir, needles) {
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir,
  ], {
    env: {
      ...process.env,
      PONOS_MOCK_API: '1',
      PONOS_MOCK_SYS_PROBE: needles.join('|'),
      PONOS_CONFIG_DIR: dir,
      YFW_HOME: dir,
    },
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const st = { proc, events: [], buf: '', out: '', err: '' }
  proc.stdout.on('data', (d) => {
    st.out += d
    st.buf += d
    // 逐行切分：半行留在 buf 里等下一批数据（跨 chunk 的 JSON 行不能当脏行丢掉）
    let idx
    while ((idx = st.buf.indexOf('\n')) >= 0) {
      const l = st.buf.slice(0, idx).trim()
      st.buf = st.buf.slice(idx + 1)
      if (!l) continue
      try { st.events.push({ ...JSON.parse(l), idx: st.events.length }) } catch { /* 半行/脏行跳过 */ }
    }
  })
  proc.stderr.on('data', (d) => { st.err += d })
  return st
}

async function waitForEvent(k, pred, timeoutMs, from = 0) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    for (let i = from; i < k.events.length; i++) if (pred(k.events[i])) return k.events[i]
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

const isResult = (e) => e.type === 'result'
/**
 * 收集**每一轮** assistant 文本里的 SYS_PROBE bit 串（每轮一次请求 → 一个 bit 串）。
 * 必须按**事件顺序拼接 assistant 文本块**再匹配：探针文本是流式分块下发的
 * （实测被切成 "SYS_" / "PROB" / "E:00" 三个 text block），直接对原始 stdout 正则
 * 永远匹配不到 —— 分隔符是 JSON 结构，`SYS_PROBE:` 在原始流里根本不连续。
 */
const probesOf = (k) => [...k.events
  .filter((e) => e.type === 'assistant')
  .map((e) => (e.message?.content || []).map((b) => (b?.type === 'text' ? b.text : '')).join(''))
  .join('')
  .matchAll(/SYS_PROBE:([01]+)/g)].map((m) => m[1])

/**
 * 两轮会话：第 1 轮后调用 midTurn() 改盘，第 2 轮再问一次。
 * 返回两轮的 bit 串 + init 帧（用于对照工具池）。
 */
async function runTwoTurns({ dir, needles, midTurn }) {
  const k = spawnKernel(dir, needles)
  try {
    const init = await waitForEvent(k, (e) => e.type === 'system' && e.subtype === 'init', 25_000)
    assert.ok(init, `内核未就绪；stdout=${k.out.slice(-400)} stderr=${k.err.slice(-400)}`)
    const send = (n) => k.proc.stdin.write(JSON.stringify({
      type: 'user',
      session_id: 'wf-prompt-refresh',
      message: { role: 'user', content: `第 ${n} 轮：你好` },
    }) + '\n')
    let from = 0
    send(1)
    const r1 = await waitForEvent(k, isResult, 30_000, from)
    assert.ok(r1, `第 1 轮无 result；stdout=${k.out.slice(-400)}`)
    from = r1.idx + 1
    await midTurn() // 会话存活期间改盘（等价于面板里点了删除 / 导入了新工作流）
    send(2)
    const r2 = await waitForEvent(k, isResult, 30_000, from)
    assert.ok(r2, `第 2 轮无 result；stdout=${k.out.slice(-400)}`)
    return { init, probes: probesOf(k), out: k.out, err: k.err }
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 400)) // Windows：等句柄释放，否则上层 rmSync 报 EPERM
  }
}

test('**核心**：会话存活期间删除工作流 → 下一轮提示词里不再有它（提示词与工具池同口径）', async () => {
  const dir = makeHome()
  const needles = ['e2e-alpha', 'e2e-gamma']
  try {
    const { probes, out, err } = await runTwoTurns({
      dir,
      needles,
      midTurn: async () => {
        // 删除本体（面板删除 = DELETE 路由 → rmSync 目录），kernel 侧看不到任何广播
        rmSync(join(dir, 'workflows', 'e2e-alpha'), { recursive: true, force: true })
        // 同时新增一个：一并验证「新增也能被发现」（不是把清单冻在启动态的另一半）
        mkdirSync(join(dir, 'workflows', 'e2e-gamma'), { recursive: true })
        writeFileSync(join(dir, 'workflows', 'e2e-gamma', 'workflow.yml'), wf('e2e-gamma'), 'utf-8')
      },
    })
    assert.ok(probes.length >= 2, `应有两轮探针回显，实得 ${JSON.stringify(probes)}；out=${out.slice(-400)}`)
    assert.equal(probes[0][0], '1', '基线（第 1 轮）：e2e-alpha 应在提示词里')
    assert.equal(probes[0][1], '0', '基线（第 1 轮）：e2e-gamma 尚不存在')
    assert.equal(probes[1][0], '0', '**核心断言**：删除后第 2 轮提示词里不得再有 e2e-alpha（修复前恒为 1）')
    assert.equal(probes[1][1], '1', '反向：会话中新增的工作流应被发现（清单不冻在启动态）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    void needles
  }
})

test('对照：工作流不删时两轮都在（确认上面的 0 是删除导致的，不是探针/解析抖动）', async () => {
  const dir = makeHome()
  try {
    const { probes } = await runTwoTurns({ dir, needles: ['e2e-alpha'], midTurn: async () => { /* 什么都不改 */ } })
    assert.ok(probes.length >= 2, `应有两轮探针回显，实得 ${JSON.stringify(probes)}`)
    assert.equal(probes[0][0], '1')
    assert.equal(probes[1][0], '1', '未删除 → 两轮都必须命中（反证核心断言的 0 来自删除）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
