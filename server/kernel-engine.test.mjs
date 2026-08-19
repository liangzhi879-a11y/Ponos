// 净室内核引擎直连 wire 测试（kernel/cli.mjs —— docs/bridge-contract.md §2-§4）
// ---------------------------------------------------------------------------
// 直接 spawn kernel/cli.mjs（node 运行，与 bun 运行共享同一实现），断言其
// stdout NDJSON 语义。YFW_MOCK_API=1 走内置 mock 流（无网络、幂等）。
// 对照基线：kernel-contract.test.mjs（mock 内核断言同一套 wire 协议）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { parseArgs } from '../kernel/cli.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')

const tmp = mkdtempSync(join(tmpdir(), 'kernel-engine-'))

// 与 bridge getOrCreateSession 注入序列一致的 spawn 参数
function contractArgs(extra = []) {
  return [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion',
    ...extra,
  ]
}

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

function spawnKernel({ extraArgs = [], extraEnv = {} } = {}) {
  const child = spawn(process.execPath, [CLI, ...contractArgs(extraArgs)], {
    env: { ...process.env, YFW_MOCK_API: '1', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  return {
    child,
    reader,
    send(obj) { child.stdin.write(JSON.stringify(obj) + '\n') },
    close() { try { child.stdin.end() } catch {} },
  }
}

// 收集一整轮：连续 assistant 事件（拼接 text）直到 result
async function collectTurn(reader) {
  const texts = []
  let usage = null
  let eventCount = 0
  while (true) {
    const ev = await reader.nextEvent()
    if (ev.type === 'assistant') {
      eventCount++
      for (const b of ev.message.content) if (b.type === 'text') texts.push(b.text)
    } else if (ev.type === 'result') {
      usage = ev.usage
      break
    }
  }
  return { text: texts.join(''), usage, eventCount }
}

async function readInit(reader) {
  const ev = await reader.nextEvent()
  assert.equal(ev.type, 'system')
  assert.equal(ev.subtype, 'init')
  return ev
}

test('spawn 即发 system(init)，携带 model 与 tools 字段（/test-provider 依赖）', async () => {
  const m = spawnKernel({ extraArgs: ['--model', 'test-model'] })
  try {
    const ev = await readInit(m.reader)
    assert.equal(ev.model, 'test-model')
    assert.ok(Array.isArray(ev.tools))
  } finally { m.close() }
})

test('轮次闭环：user → assistant(mock 流式多段) → result(usage)', async () => {
  const m = spawnKernel()
  try {
    await readInit(m.reader)
    m.send({ type: 'user', message: { role: 'user', content: 'hello engine' } })
    const turn = await collectTurn(m.reader)
    assert.equal(turn.text, 'mock: hello engine')
    // 流式：mock 切 3 段 → 至少 2 个 assistant 事件
    assert.ok(turn.eventCount >= 2, `expected streamed events, got ${turn.eventCount}`)
    assert.ok(turn.usage.input_tokens >= 0 && turn.usage.output_tokens >= 0)
  } finally { m.close() }
})

test('cancel 语义：轮次进行中 cancel → 已取消 + result，进程保留可续聊', async () => {
  const m = spawnKernel()
  try {
    await readInit(m.reader)
    m.send({ type: 'user', message: { role: 'user', content: '慢任务' } })
    await new Promise((r) => setTimeout(r, 50)) // mock 流已开始（段间 sleep 30ms）
    m.send({ type: 'control_request', request_id: 'c1', request: { subtype: 'cancel' } })
    const turn = await collectTurn(m.reader)
    // cancel 前已流出的文本保留，cancel 生效以 '已取消。' 收尾
    assert.match(turn.text, /已取消。$/)
    // 进程保留：续聊正常
    m.send({ type: 'user', message: { role: 'user', content: '续聊' } })
    const again = await collectTurn(m.reader)
    assert.equal(again.text, 'mock: 续聊')
  } finally { m.close() }
})

test('cancel 空转：无活跃轮次 cancel → 已取消 + result（bridge _cancelPending 复位依赖）', async () => {
  const m = spawnKernel()
  try {
    await readInit(m.reader)
    m.send({ type: 'control_request', request_id: 'c2', request: { subtype: 'cancel' } })
    const turn = await collectTurn(m.reader)
    assert.equal(turn.text, '已取消。')
  } finally { m.close() }
})

test('轮次队列：turnActive 时后续 user 排队，result 后顺序处理', async () => {
  const m = spawnKernel()
  try {
    await readInit(m.reader)
    m.send({ type: 'user', message: { role: 'user', content: '第一条' } })
    await new Promise((r) => setTimeout(r, 20))
    m.send({ type: 'user', message: { role: 'user', content: '第二条' } })
    const t1 = await collectTurn(m.reader)
    assert.equal(t1.text, 'mock: 第一条')
    const t2 = await collectTurn(m.reader)
    assert.equal(t2.text, 'mock: 第二条')
  } finally { m.close() }
})

test('多轮上下文：历史保留，第二轮携带前轮对话（mock 回显取最后 user 内容验证队列顺序）', async () => {
  const m = spawnKernel()
  try {
    await readInit(m.reader)
    m.send({ type: 'user', message: { role: 'user', content: '第一问' } })
    const t1 = await collectTurn(m.reader)
    assert.equal(t1.text, 'mock: 第一问')
    m.send({ type: 'user', message: { role: 'user', content: '第二问' } })
    const t2 = await collectTurn(m.reader)
    assert.equal(t2.text, 'mock: 第二问')
  } finally { m.close() }
})

test('参数解析：parseArgs 精确还原契约参数', () => {
  const promptFile = join(tmp, 'prompt.txt')
  const args = parseArgs(contractArgs([
    '--model', 'test-model',
    '--add-dir', '/cwd',
    '--resume', 's-abc',
    '--append-system-prompt-file', promptFile,
  ]))
  assert.equal(args.print, true)
  assert.equal(args.outputFormat, 'stream-json')
  assert.equal(args.inputFormat, 'stream-json')
  assert.equal(args.verbose, true)
  assert.equal(args.skipPermissions, true)
  assert.equal(args.permissionPromptTool, 'stdio')
  assert.deepEqual(args.disallowedTools, ['AskUserQuestion'])
  assert.equal(args.model, 'test-model')
  assert.deepEqual(args.addDirs, ['/cwd'])
  assert.equal(args.resume, 's-abc')
  assert.equal(args.appendSystemPromptFile, promptFile)
})

test('参数解析：非 stream-json 格式拒绝（exit 2）', async () => {
  const child = spawn(process.execPath, [CLI, '--print', '--output-format', 'text', '--input-format', 'text'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.equal(code, 2)
})

test('stdin 关闭：进程正常退出（exit 0）', async () => {
  const m = spawnKernel()
  await readInit(m.reader)
  m.close()
  const code = await new Promise((resolve) => m.child.on('close', resolve))
  assert.equal(code, 0)
})

test('resume/model/prompt-file：init 携带 model，轮次正常', async () => {
  const promptFile = join(tmp, 'resume-prompt.txt')
  writeFileSync(promptFile, '身份提示词内容', 'utf-8')
  const m = spawnKernel({ extraArgs: ['--resume', 's-resume', '--model', 'm-resume', '--append-system-prompt-file', promptFile] })
  try {
    const init = await readInit(m.reader)
    assert.equal(init.model, 'm-resume')
    m.send({ type: 'user', message: { role: 'user', content: 'resume 后继续' } })
    const turn = await collectTurn(m.reader)
    assert.equal(turn.text, 'mock: resume 后继续')
  } finally { m.close() }
})

test.after(() => {
  rmSync(tmp, { recursive: true, force: true })
})
