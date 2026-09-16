// 进程级硬看门狗（2026-09-12 异步链失活事故）：请求层看门狗随迭代创建/清理，
// 请求异常终止（续体永不恢复）时内核"活着但永远空等"——inspector 实证仅剩
// stdio 三句柄、零定时器。cli 级硬看门狗独立于请求生命周期：轮次激活且 wire
// 无输出超过阈值 → 硬退出（bridge 收 close → 广播 closed → GUI 解锁）。
// 本测试 spawn 完整 cli 进程（engine 单测绕过 cli 层，覆盖不到）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))

function spawnKernel(env, dir) {
  const proc = spawn(process.execPath, [KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--add-dir', dir], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  const events = [] // 按 NDJSON 行解析（数据块可能把一行切成两半，不能用 includes）
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
  return { proc, events, get out() { return out }, get err() { return err } }
}

test('硬看门狗：异步链失活 → 超时硬退出（exit 7 + marker.err 自描述）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hard-wd-'))
  const { proc, out, err } = spawnKernel({
    PONOS_MOCK_API: '1',
    PONOS_KERNEL_HARD_TIMEOUT_MS: '4000',
    PONOS_CONFIG_DIR: dir,
    YFW_HOME: dir,
  }, dir)
  try {
    // 等 init
    await new Promise((r) => setTimeout(r, 800))
    proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'wd-session', message: { role: 'user', content: '[mock:hang-forever] 挂住我' } }) + '\n')
    const code = await new Promise((res) => { proc.on('close', res) })
    assert.equal(code, 7, `应被硬看门狗 exit(7) 退出（实际 ${code}）\nstdout=${out.slice(-300)}\nstderr=${err.slice(-300)}`)
    // marker 自描述落盘（bridge 下次 resume 可读回根因）；会话 id 由内核自生成，
    // 故按 *.err 通配查找
    const { existsSync, readFileSync, readdirSync } = await import('node:fs')
    const errs = readdirSync(join(dir, 'runs')).filter((f) => f.endsWith('.err'))
    assert.equal(errs.length, 1, '应写 1 个 marker.err，实际: ' + JSON.stringify(errs))
    assert.ok(readFileSync(join(dir, 'runs', errs[0]), 'utf8').includes('硬看门狗'), 'marker.err 应含硬看门狗自描述')
  } finally {
    try { proc.kill() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test('硬看门狗不误杀：正常轮次结束后（result 解除武装）进程持续存活', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hard-wd2-'))
  const { proc, events } = spawnKernel({
    PONOS_MOCK_API: '1',
    PONOS_KERNEL_HARD_TIMEOUT_MS: '3000',
    PONOS_CONFIG_DIR: dir,
    YFW_HOME: dir,
  }, dir)
  try {
    await new Promise((r) => setTimeout(r, 800))
    proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'wd2-session', message: { role: 'user', content: '正常回合' } }) + '\n')
    // 等 result 出现（按 NDJSON 事件判定）
    for (let i = 0; i < 30; i++) {
      if (events.some((e) => e.type === 'result')) break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.ok(events.some((e) => e.type === 'result'), '正常回合应产出 result')
    // result 解除武装后：再等 6s（>2×阈值）不应被误杀
    await new Promise((r) => setTimeout(r, 6000))
    assert.equal(proc.exitCode, null, '轮间空闲不得被硬看门狗误杀')
  } finally {
    try { proc.kill() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

// 2026-09-12 等待用户展期（T10①）：审批挂起时内核本来就零 wire 输出，等的是人。
// 旧行为下用户思考超过 hardTimeoutMs 就被 exit(7) 杀掉，且自杀前不写 result/error
// 帧——桥只看到 close，用户的作答落空（GUI 甚至还在等弹窗回执）。
// [mock:tool-catastrophic] → rm -rf / 命中硬黑名单（permissions.mjs:48），任何档位
// 都必须走 can_use_tool，正是不依赖审批档位的挂起入口。
test('审批等待期按上限展期：等待超过 hardTimeoutMs 不被误杀，回执后轮次正常收尾', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hard-wd3-'))
  const { proc, events } = spawnKernel({
    PONOS_MOCK_API: '1',
    PONOS_KERNEL_HARD_TIMEOUT_MS: '3000',
    PONOS_APPROVAL_TIMEOUT_MS: '30000', // 展期窗口 >> 基础阈值，才测得出"展期"
    PONOS_CONFIG_DIR: dir,
    YFW_HOME: dir,
  }, dir)
  try {
    await new Promise((r) => setTimeout(r, 800))
    proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'wd3-session', message: { role: 'user', content: '[mock:tool-catastrophic] 执行灾难命令' } }) + '\n')
    // 等挂起点：control_request(can_use_tool)
    for (let i = 0; i < 60; i++) {
      if (events.some((e) => e.type === 'control_request')) break
      await new Promise((r) => setTimeout(r, 200))
    }
    const req = events.find((e) => e.type === 'control_request')
    assert.ok(req, '灾难命令应产生 can_use_tool 挂起（硬黑名单任何档位都问）')
    assert.equal(req.request.tool_use_id, 'tool_use_mock_catastrophic')
    // 静默等待 7s（> 2×hardTimeoutMs）：展期生效则进程必须存活
    await new Promise((r) => setTimeout(r, 7000))
    assert.equal(proc.exitCode, null,
      '等待用户期间不得被硬看门狗误杀（阈值 3000ms + 审批上限 30000ms 展期）')
    // 回执（拒绝）→ 挂起解除 → 轮次继续并收尾（不再是"close 无 result"）
    proc.stdin.write(JSON.stringify({
      type: 'control_response',
      response: { response: { toolUseID: req.request.tool_use_id, behavior: 'deny', message: '测试拒绝' } },
    }) + '\n')
    for (let i = 0; i < 40; i++) {
      if (events.some((e) => e.type === 'result')) break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.ok(events.some((e) => e.type === 'result'), '回执后轮次必须 settle 为 result（而非无帧硬退）')
    assert.equal(proc.exitCode, null, '收尾后进程存活，不写 marker.err')
  } finally {
    try { proc.kill() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

// 展期必须**有界**（不变量：无界等待不存在）。展期额度与引擎自身审批上限同值
// （PONOS_APPROVAL_TIMEOUT_MS），故无人回执时由引擎先以 timeout 回填、轮次继续；
// 这里只需证明"长期无人回执同样不会残留纯静默"：要么 settle 出 result，要么被
// 硬看门狗按展期上限硬退出并留下 marker.err——两者都必须有可见收口。
test('无人回执的审批等待有界：不残留纯静默（必见 result 或 marker.err 之一）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hard-wd4-'))
  const { proc, events } = spawnKernel({
    PONOS_MOCK_API: '1',
    PONOS_KERNEL_HARD_TIMEOUT_MS: '2000',
    PONOS_APPROVAL_TIMEOUT_MS: '4000',
    PONOS_CONFIG_DIR: dir,
    YFW_HOME: dir,
  }, dir)
  try {
    await new Promise((r) => setTimeout(r, 800))
    proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'wd4-session', message: { role: 'user', content: '[mock:tool-catastrophic] 无人应答' } }) + '\n')
    for (let i = 0; i < 60; i++) {
      if (events.some((e) => e.type === 'control_request')) break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.ok(events.some((e) => e.type === 'control_request'), '应先挂起在审批上')
    // 全程不回执：等 12s（> 展期上限 2000+4000），然后断言"有可见收口"
    await new Promise((r) => setTimeout(r, 12000))
    const settled = events.some((e) => e.type === 'result')
    const errs = existsSync(join(dir, 'runs')) ? readdirSync(join(dir, 'runs')).filter((f) => f.endsWith('.err')) : []
    assert.ok(settled || errs.length > 0,
      `无人回执不得永久静默：应 settle 出 result 或被硬看门狗留下 marker.err（settled=${settled} errs=${JSON.stringify(errs)}）`)
  } finally {
    try { proc.kill() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})
