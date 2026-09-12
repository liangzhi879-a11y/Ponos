// ASK_USER 阻塞等待（2026-09-12「审批/提问与会话进度不一致」的系统修复）：
// 此前内核对提问标记**零感知**——模型写完问题即继续跑完整个回合，用户看到卡片时模型
// 早已跑远，这正是"审批时消息已过期"的同源病灶。用户选定语义 = 与审批同构的真阻塞：
// 挂起 → 作答经 cli 注入当前轮（queueNext → 工具边界吸收）→ 继续同一步；超时收尾本轮。
//
// 本文件是**进程级**测试（spawn 完整 cli）：阻塞语义横跨 cli 路由（作答不能排队等下一轮）
// 与 engine 挂起两面，engine 单测覆盖不到 cli 那半。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function spawnKernel(env, dir) {
  const proc = spawn(process.execPath, [KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--add-dir', dir], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  const events = []
  let buf = ''
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
  proc.stderr.on('data', (d) => err += d)
  const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n')
  const assistantText = () => events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => (e.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text))
    .join('')
  const results = () => events.filter((e) => e.type === 'result')
  return { proc, events, send, assistantText, results, get out() { return out }, get err() { return err } }
}

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = fn()
    if (v) return v
    await sleep(75)
  }
  return null
}

const ASK = '[mock:ask-user] 帮我确认一下'
// 镜像桥的作答格式（server/bridge.mjs 的 answer 分支）与**无 priority** 的写法
const ANSWER = { type: 'user', message: { role: 'user', content: '用户回答：\n- 问题 "继续吗？": 选择了 "继续"\n\n请继续推进任务。' } }

test('提问即挂起：模型产出提问后必须停住等作答（不得自行跑完回合）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-block-'))
  const k = spawnKernel({ PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: dir, YFW_HOME: dir, PONOS_ASK_USER_TIMEOUT_MS: '30000' }, dir)
  try {
    await sleep(800) // 等 init
    k.send({ type: 'user', session_id: 'ask-1', message: { role: 'user', content: ASK } })
    const asked = await waitFor(() => k.assistantText().includes('<!--ASK_USER'))
    assert.ok(asked, `应产出提问标记文本\nstdout=${k.out.slice(-400)}\nstderr=${k.err.slice(-300)}`)
    // 挂起窗口：远小于提问超时（30s），期内不得出现 result
    await sleep(2500)
    assert.equal(k.results().length, 0, '提问后必须停住等作答，不得自行产出 result（原病灶：模型跑完整个回合）')
    assert.equal(k.proc.exitCode, null, '挂起期间内核必须存活')
    // 作答（无 priority，与桥一致）→ 必须唤醒并**在同一轮内**继续
    k.send({ ...ANSWER, session_id: 'ask-1' })
    const res = await waitFor(() => k.results()[0], 10000)
    assert.ok(res, `作答后应产出 result\nstdout=${k.out.slice(-400)}\nstderr=${k.err.slice(-300)}`)
    assert.equal(k.results().length, 1, '作答必须注入**当前轮**：若被当新轮排队，这里会出现 2 个 result')
    assert.ok(k.assistantText().includes('用户回答'), '模型必须真的看到作答内容（同轮上下文可见）')
    // 问题文本必须落盘为**独立** assistant 条目，不得与作答后的回复拼成同一条
    // （步内 continue 若不清 textBuf 就会拼接——截断续写路径的同款陷阱）
    const entries = []
    for (const f of readdirSync(dir, { recursive: true }).filter((p) => String(p).endsWith('.jsonl'))) {
      for (const line of readFileSync(join(dir, String(f)), 'utf-8').split('\n')) {
        if (!line.trim()) continue
        try { entries.push(JSON.parse(line)) } catch { /* 半行跳过 */ }
      }
    }
    const assistantTexts = entries
      .filter((e) => e?.message?.role === 'assistant')
      .map((e) => (e.message.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join(''))
    const askEntry = assistantTexts.filter((t) => t.includes('<!--ASK_USER'))
    const answerEntry = assistantTexts.filter((t) => t.includes('用户回答'))
    assert.equal(askEntry.length, 1, `问题应恰好落盘为 1 条独立 assistant 条目（实际 ${askEntry.length}）`)
    assert.equal(answerEntry.length, 1, `作答后的回复应恰好 1 条（实际 ${answerEntry.length}）`)
    assert.ok(
      !assistantTexts.some((t) => t.includes('<!--ASK_USER') && t.includes('用户回答')),
      '问题与作答后的回复不得拼进同一条 assistant 消息',
    )
  } finally {
    try { k.proc.kill() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test('挂起期间硬看门狗展期：等待作答不得被 exit(7) 误杀', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-grace-'))
  // 硬看门狗 2s（无展期必然误杀），提问上限 20s
  const k = spawnKernel({
    PONOS_MOCK_API: '1',
    CLAUDE_CONFIG_DIR: dir,
    YFW_HOME: dir,
    PONOS_KERNEL_HARD_TIMEOUT_MS: '2000',
    PONOS_ASK_USER_TIMEOUT_MS: '20000',
  }, dir)
  try {
    await sleep(800)
    k.send({ type: 'user', session_id: 'ask-2', message: { role: 'user', content: ASK } })
    assert.ok(await waitFor(() => k.assistantText().includes('<!--ASK_USER')), `应产出提问标记\nstderr=${k.err.slice(-300)}`)
    // 静默等待远超硬看门狗阈值：等的是人，不得被杀（等待期展期）
    await sleep(5000)
    assert.equal(k.proc.exitCode, null, `等待作答期间不得被硬看门狗杀掉（exit=${k.proc.exitCode}）\nstderr=${k.err.slice(-400)}`)
    assert.equal(k.err.includes('硬看门狗'), false, '不得写硬看门狗 marker')
    k.send({ ...ANSWER, session_id: 'ask-2' })
    assert.ok(await waitFor(() => k.results()[0], 10000), '展期后作答仍应能唤醒并完成本轮')
  } finally {
    try { k.proc.kill() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test('等待有界：无人作答时按提问上限收尾本轮（不留永久挂起）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-timeout-'))
  const k = spawnKernel({
    PONOS_MOCK_API: '1',
    CLAUDE_CONFIG_DIR: dir,
    YFW_HOME: dir,
    PONOS_ASK_USER_TIMEOUT_MS: '2500',
  }, dir)
  try {
    await sleep(800)
    k.send({ type: 'user', session_id: 'ask-3', message: { role: 'user', content: ASK } })
    assert.ok(await waitFor(() => k.assistantText().includes('<!--ASK_USER')), '应产出提问标记')
    const res = await waitFor(() => k.results()[0], 12000)
    assert.ok(res, `超时后必须收尾本轮（不变量：任何等待都有界）\nstderr=${k.err.slice(-400)}`)
    assert.equal(k.results().length, 1, '超时收尾恰好一个 result')
    assert.match(k.err, /ASK_USER 等待作答复超时/, '超时应有可诊断日志（kernel-stderr 真源）')
  } finally {
    try { k.proc.kill() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})
