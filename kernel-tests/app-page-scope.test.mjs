// 应用页模式（--app-page）的**进程级**验收（2026-09-16，P2「应用页会话」）
// ---------------------------------------------------------------------------
// 为什么要起真进程：`--app-page` 这一跳的失效方式是**静默**的
//   ① 内核 parseArgs 漏登记该 flag → 未知 `--` 参数被无声忽略（本仓库已三次踩过：
//      --spaces / --confirm / --knowledge-spaces），单测全绿而功能完全不存在；
//   ② 作用域传到了但判定写错（比如被 public 旁路）→ 应用页里混着别的公共应用，
//      界面上只表现为"模型能调别的系统"，源码断言查不出来。
// 只有"起内核 + 看它真的发给模型什么工具"才能同时覆盖这两点。
//
// 手法与 app-tools-mount.test.mjs 同源：临时 configDir（<dir>/apps 放 registry/spec，
// **刻意不放 binding.json**）+ 本机假 Anthropic 端点（SSE），断言 init 帧与真实请求体的 tools。
// 对照用例（不带 flag）同样重要：它证明这个 fixture 本来会把 public app-b 放进池子
// ——否则"app-b 没出现"可能只是因为 fixture 写错了，而不是作用域生效了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appToolName } from '../kernel/app-naming.mjs'

const KERNEL_CLI = process.env.YFW_TEST_KERNEL_CLI || fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Windows：被刚 kill 的子进程仍持有 cwd/handle 时 rmSync 会 EPERM（内核工作根就是它）。
// 清理失败会让用例在 finally 里假失败——重试兜底（本仓库既有做法，见 kernel-bridge.test.mjs）。
function rmSyncRetry(path, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch (e) {
      if (i === attempts - 1) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

const cmd = (action, title) => ({ action, title, kind: 'read', params: [], steps: [{ act: 'goto', url: '/' }] })

/**
 * 临时 configDir：apps/ 下 app-a（console）+ app-b（public），**不放 binding.json**。
 * 不放是刻意的：作用域命中就应可见，不该依赖"先绑定一次"（应用页会话不经过控制台绑定流程）。
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'apppage-'))
  const apps = join(dir, 'apps')
  const aSpec = { specVersion: 1, appId: 'app-a', name: '甲系统', target: { type: 'web', url: 'https://example.com' }, expose: { mode: 'console' }, commands: [cmd('queryOrder', '查询订单')] }
  const bSpec = { specVersion: 1, appId: 'app-b', name: '乙系统', target: { type: 'web', url: 'https://example.com' }, expose: { mode: 'public' }, commands: [cmd('listItems', '列出条目')] }
  mkdirSync(join(apps, 'app-a'), { recursive: true })
  mkdirSync(join(apps, 'app-b'), { recursive: true })
  writeFileSync(join(apps, 'registry.json'), JSON.stringify({
    version: 1,
    apps: [{ id: 'app-a', name: '甲系统', targetType: 'web', enabled: true }, { id: 'app-b', name: '乙系统', targetType: 'web', enabled: true }],
  }), 'utf-8')
  writeFileSync(join(apps, 'app-a', 'spec.json'), JSON.stringify(aSpec), 'utf-8')
  writeFileSync(join(apps, 'app-b', 'spec.json'), JSON.stringify(bSpec), 'utf-8')
  return { dir, aTool: appToolName(aSpec, 'queryOrder'), bTool: appToolName(bSpec, 'listItems') }
}

/** 假 Anthropic 端点：一律回文本收尾（本文件只关心"送出去的 tools"，不关心执行往返） */
async function startApi() {
  const bodies = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      try { bodies.push(JSON.parse(raw)) } catch { bodies.push({}) }
      const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '收到。' } })
      sse({ type: 'content_block_stop', index: 0 })
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
      sse({ type: 'message_stop' })
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { bodies, port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

function spawnKernel(dir, port, extraArgs = []) {
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir, ...extraArgs,
  ], {
    env: {
      ...process.env,
      PONOS_MOCK_API: '', // 走真实 HTTP 路径（假端点在本地）
      PONOS_BASE_URL: `http://127.0.0.1:${port}`,
      PONOS_AUTH_TOKEN: 'test-token',
      PONOS_MODEL: 'test-model',
      PONOS_CONFIG_DIR: dir,
      YFW_HOME: dir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  let buf = ''
  let err = ''
  proc.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 坏行忽略 */ }
    }
  })
  proc.stderr.on('data', (d) => { err += d })
  return {
    proc, events,
    send: (o) => proc.stdin.write(JSON.stringify(o) + '\n'),
    get err() { return err },
  }
}

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = fn()
    if (v) return v
    await sleep(50)
  }
  return null
}

/** 起内核 → 拿到 init → 发一条消息（让 tools 真的进请求体）→ 交出 init/请求体/工具名 */
async function runKernel(dir, extraArgs, assertFn) {
  const api = await startApi()
  const k = spawnKernel(dir, api.port, extraArgs)
  try {
    const init = await waitFor(() => k.events.find((e) => e.type === 'system' && e.subtype === 'init'))
    assert.ok(init, `应收到 init 帧\nstderr=${k.err.slice(-800)}`)
    k.send({ type: 'user', session_id: init.session_id, message: { role: 'user', content: '你好' } })
    const body = await waitFor(() => api.bodies.find((b) => Array.isArray(b.tools)))
    assert.ok(body, `应有一次带 tools 的请求\nstderr=${k.err.slice(-800)}`)
    const appNames = (arr) => (arr || []).filter((x) => String(x?.name || x).startsWith('app_')).map((x) => String(x?.name || x)).sort()
    assertFn({ init, body, initAppTools: appNames(init.tools), bodyAppTools: appNames(body.tools), stderr: () => k.err })
  } finally {
    try { k.proc.kill() } catch { /* 已退出 */ }
    await api.close()
    rmSyncRetry(dir)
  }
}

test('★ --app-page app-a ⇒ 工具池只含 app-a（public app-b 也被挡住），且真的发给了模型', async () => {
  const { dir, aTool, bTool } = fixture()
  await runKernel(dir, ['--app-page', 'app-a'], ({ initAppTools, bodyAppTools }) => {
    assert.deepEqual(initAppTools, [aTool], `init.tools 只应含 app-a 的工具（实际 ${JSON.stringify(initAppTools)}）`)
    assert.deepEqual(bodyAppTools, [aTool], '请求体（真正发给模型的工具表）同样只应含 app-a')
    assert.ok(!bodyAppTools.includes(bTool), 'public 应用不得旁路（否则"应用页"里照样能调别的系统）')
  })
})

test('不带 --app-page（对照）：同一 fixture 下 public app-b 进池、console app-a 不进（证明作用域确实起了作用）', async () => {
  const { dir, aTool, bTool } = fixture()
  await runKernel(dir, [], ({ bodyAppTools }) => {
    assert.ok(bodyAppTools.includes(bTool), `无作用域时 public app-b 本应在池（实际 ${JSON.stringify(bodyAppTools)}）`)
    assert.ok(!bodyAppTools.includes(aTool), '无作用域且未绑定 ⇒ console app-a 不可见（fail-closed）')
  })
})

test('--app-page 指向不存在的应用 ⇒ 无任何 app_* 工具，且 stderr 有明确 warn（不是"模型说没有这个工具"）', async () => {
  const { dir } = fixture()
  await runKernel(dir, ['--app-page', 'app-nope'], ({ initAppTools, bodyAppTools, stderr }) => {
    assert.deepEqual(initAppTools, [], '作用域指向不存在的应用 ⇒ 一个应用工具都不给（fail-closed）')
    assert.deepEqual(bodyAppTools, [])
    // 这条 warn 是唯一的事后线索：没有它，"应用页里没有工具"无从排查
    assert.match(stderr(), /--app-page app-nope 未找到对应应用/, `stderr 应含缺应用告警，实际尾部：${stderr().slice(-400)}`)
  })
})
