// 内核 wire 契约直连一致性测试（docs/bridge-contract.md §2/§3/§4）
// ---------------------------------------------------------------------------
// 直接 spawn mock-kernel.mjs（不走 bridge），按契约注入 stdin NDJSON 并断言
// stdout NDJSON 语义。这份测试同时是净室引擎重建的对照基线：替换内核后，
// 真实内核必须通过与本文件完全相同的协议断言（spawn 参数、事件形状、cancel/
// 审批/browser 挂起与解除语义）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const MOCK_KERNEL = join(dirname(fileURLToPath(import.meta.url)), 'mock-kernel.mjs')

const tmp = mkdtempSync(join(tmpdir(), 'kernel-contract-'))

// 契约 §2 spawn 参数（与 bridge.mjs getOrCreateSession 完全一致）
function contractArgs(extra = []) {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion',
  ]
  args.push(...extra)
  return args
}

// 行读取队列：event 到来时若有等待者则唤醒，否则入队（避免异步丢失）
function makeReader(stream) {
  const lines = []
  const waiters = []
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', (l) => {
    const line = l.trim()
    if (!line) return
    if (waiters.length) waiters.shift()(line)
    else lines.push(line)
  })
  return {
    next(timeoutMs = 5000) {
      if (lines.length) return Promise.resolve(lines.shift())
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { reject(new Error('read timeout, queue=' + JSON.stringify(lines))) }, timeoutMs)
        waiters.push((l) => { clearTimeout(t); resolve(l) })
      })
    },
    async nextEvent(timeoutMs = 5000) {
      const line = await this.next(timeoutMs)
      return JSON.parse(line)
    },
  }
}

function spawnMock({ args = contractArgs(), scenario = 'plain', extraEnv = {} } = {}) {
  const logPath = join(tmp, 'mock-' + Math.random().toString(36).slice(2) + '.jsonl')
  const child = spawn(process.execPath, [MOCK_KERNEL, ...args], {
    env: { ...process.env, MOCK_LOG: logPath, MOCK_SCENARIO: scenario, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  return {
    child,
    logPath,
    reader,
    send(obj) { child.stdin.write(JSON.stringify(obj) + '\n') },
    close() { try { child.stdin.end() } catch {} },
  }
}

// 轮询等待 MOCK_LOG 出现满足谓词的行
async function waitLog(logPath, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      for (const line of readFileSync(logPath, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        try {
          const rec = JSON.parse(line)
          if (predicate(rec)) return rec
        } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 30))
  }
  throw new Error('waitLog timeout: ' + logPath)
}

test('spawn 契约：argv 精确匹配 bridge 注入序列', async () => {
  const promptFile = join(tmp, 'sys-prompt.txt')
  writeFileSync(promptFile, 'Ponos identity prompt', 'utf-8')
  const cwd = tmp
  const m = spawnMock({ args: contractArgs([
    '--model', 'test-model',
    '--add-dir', cwd,
    '--append-system-prompt-file', promptFile,
  ]) })
  try {
    const rec = await waitLog(m.logPath, (r) => r.t === 'argv')
    assert.deepEqual(rec.argv, [
      '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--verbose', '--dangerously-skip-permissions',
      '--permission-prompt-tool', 'stdio',
      '--disallowedTools', 'AskUserQuestion',
      '--model', 'test-model',
      '--add-dir', cwd,
      '--append-system-prompt-file', promptFile,
    ])
  } finally { m.close() }
})

test('spawn 契约：buildChildEnv 关键 env 注入', async () => {
  const m = spawnMock({ extraEnv: { CLAUDE_CONFIG_DIR: '/test/cfg', PONOS_HOME: '/test/home' } })
  try {
    const rec = await waitLog(m.logPath, (r) => r.t === 'env')
    assert.equal(rec.env.CLAUDE_CONFIG_DIR, '/test/cfg')
    assert.equal(rec.env.PONOS_HOME, '/test/home')
  } finally { m.close() }
})

test('轮次闭环：user → assistant(text) → result(usage)', async () => {
  const m = spawnMock()
  try {
    m.send({ type: 'user', message: { role: 'user', content: 'hello contract' } })
    const ev = await m.reader.nextEvent()
    assert.equal(ev.type, 'assistant')
    assert.equal(ev.message.role, 'assistant')
    assert.ok(Array.isArray(ev.message.content))
    assert.equal(ev.message.content[0].type, 'text')
    assert.equal(ev.message.content[0].text, 'echo: hello contract')
    const res = await m.reader.nextEvent()
    assert.equal(res.type, 'result')
    assert.ok(res.usage.input_tokens >= 0 && res.usage.output_tokens >= 0)
  } finally { m.close() }
})

test('cancel 语义：挂起轮次优雅结束，进程保留可续聊', async () => {
  const m = spawnMock()
  try {
    m.send({ type: 'user', message: { role: 'user', content: '[scenario:slow] 开始' } })
    const ev = await m.reader.nextEvent()
    assert.equal(ev.type, 'assistant')
    assert.match(ev.message.content[0].text, /slow 场景开始/)
    // 契约 §8：control_request(cancel) 后内核发 result 结束被中断轮次
    m.send({ type: 'control_request', request_id: 'cancel-1', request: { subtype: 'cancel' } })
    const cancelled = await m.reader.nextEvent()
    assert.equal(cancelled.type, 'assistant')
    assert.match(cancelled.message.content[0].text, /已取消/)
    const res = await m.reader.nextEvent()
    assert.equal(res.type, 'result')
    // 进程保持存活：同 stdin 续聊
    m.send({ type: 'user', message: { role: 'user', content: '续聊' } })
    const again = await m.reader.nextEvent()
    assert.equal(again.type, 'assistant')
    assert.match(again.message.content[0].text, /echo: 续聊/)
    const recs = await waitLog(m.logPath, (r) => r.t === 'stdin' && r.data.type === 'control_request')
    assert.equal(recs.data.request.subtype, 'cancel')
  } finally { m.close() }
})

test('approval 语义：can_use_tool 挂起 → control_response(allow) 解除', async () => {
  const m = spawnMock()
  try {
    m.send({ type: 'user', message: { role: 'user', content: '[scenario:approval] 批准我' } })
    const cr = await m.reader.nextEvent()
    assert.equal(cr.type, 'control_request')
    assert.equal(cr.request.subtype, 'can_use_tool')
    assert.equal(cr.request.tool_use_id, 'tool_approve_1')
    assert.equal(cr.request.tool_name, 'Bash')
    assert.equal(cr.request.input.command, 'rm -rf /tmp/mock-target')
    assert.ok(cr.request_id)
    // 未回执前不得出现 result
    m.send({
      type: 'control_response',
      response: {
        request_id: cr.request_id,
        subtype: 'success',
        response: { behavior: 'allow', updatedInput: {}, toolUseID: 'tool_approve_1', decisionClassification: 'user_temporary' },
      },
    })
    const ev = await m.reader.nextEvent()
    assert.equal(ev.type, 'assistant')
    assert.match(ev.message.content[0].text, /approval 完成: behavior=allow/)
    const res = await m.reader.nextEvent()
    assert.equal(res.type, 'result')
  } finally { m.close() }
})

test('browser 语义：bridge_request(route=browser) → browser_response 解除挂起', async () => {
  const m = spawnMock()
  try {
    m.send({ type: 'user', message: { role: 'user', content: '[scenario:browser] 导航' } })
    const br = await m.reader.nextEvent()
    assert.equal(br.type, 'bridge_request')
    assert.equal(br.route, 'browser')
    assert.equal(br.payload.method, 'navigate')
    assert.equal(br.payload.url, 'https://example.com/mock')
    // 无执行器时 bridge 回写 browser_response error（bridge-contract 测试断言），
    // 内核收到后完成轮次
    m.send({
      type: 'control_request',
      request_id: 'br-resp-1',
      request: { subtype: 'browser_response', requestId: br.requestId, ok: false, error: 'executor 未连接' },
    })
    const ev = await m.reader.nextEvent()
    assert.equal(ev.type, 'assistant')
    assert.match(ev.message.content[0].text, /browser 完成/)
    const res = await m.reader.nextEvent()
    assert.equal(res.type, 'result')
  } finally { m.close() }
})

test('raw 行：非 JSON stdout 原样输出（bridge 以 raw 转发）', async () => {
  const m = spawnMock()
  try {
    m.send({ type: 'user', message: { role: 'user', content: '[scenario:raw] 原始行' } })
    const raw = await m.reader.next()
    assert.equal(raw, 'raw-line-from-mock')
    const ev = await m.reader.nextEvent()
    assert.equal(ev.type, 'assistant')
    const res = await m.reader.nextEvent()
    assert.equal(res.type, 'result')
  } finally { m.close() }
})

test('stream 语义：连续多个 assistant 事件后 result', async () => {
  const m = spawnMock()
  try {
    m.send({ type: 'user', message: { role: 'user', content: '[scenario:stream] 流式' } })
    for (let i = 1; i <= 3; i++) {
      const ev = await m.reader.nextEvent()
      assert.equal(ev.type, 'assistant')
      assert.equal(ev.message.content[0].text, `流式块 ${i}/3`)
    }
    const res = await m.reader.nextEvent()
    assert.equal(res.type, 'result')
  } finally { m.close() }
})

test('stdin 关闭：进程正常退出（exit 0）', async () => {
  const m = spawnMock()
  m.close()
  const code = await new Promise((resolve) => m.child.on('close', resolve))
  assert.equal(code, 0)
  const rec = await waitLog(m.logPath, (r) => r.t === 'stdin-close')
  assert.ok(rec)
})

test.after(() => {
  rmSync(tmp, { recursive: true, force: true })
})
