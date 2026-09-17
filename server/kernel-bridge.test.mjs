// 净室真实内核 ↔ spawn 会话协议接线测试（S4 Task 5）
// ---------------------------------------------------------------------------
// 适配自 pd（ponos-dev）server/kernel-bridge.test.mjs 测试族，但按净室差异改写：
//   - pd 版经 PONOS_KERNEL + PONOS_BUN=node 由 bridge 起内核、WebSocket 驱动；
//     净室无 PONOS_KERNEL 名（D8 逃生口 = YFWORKING_KERNEL，属产品层），本测试
//     不启动 bridge/完整 GUI，直接以 `node kernel/cli.mjs` spawn 真实内核进程，
//     经 stdin/stdout NDJSON 走完整会话协议（docs/bridge-contract.md §3/§4/§5）。
//   - spawn 参数与 server/bridge.mjs getOrCreateSession（F8）一致（最小必要集，
//     无 --resume/--append-system-prompt-file 时按会话契约注入 home/projects 转录）。
//   - 环境隔离：PONOS_CONFIG_DIR（内核 resolveConfigDir 读取，config.mjs）与
//     YFWORKING_HOME 均指向测试临时目录，PONOS_MOCK_API=1 免网络——不触碰真实
//     ~/.yfworking / ~/.ponos。
//   - 本文件被 npm test 的 `server/*.test.mjs` glob 收录，必须在无真实 config、
//     无网络下通过；spawn 子进程在 finally 中必然 EOF/kill 收尾，不留悬挂句柄。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeSegment } from '../kernel/session.mjs'
import { approvalSpawnArgs, DEFAULT_APPROVAL_MODE } from './approval-mode.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const KERNEL_CLI = join(REPO_ROOT, 'kernel', 'cli.mjs')

// 事件收集默认超时：15000ms，可用 PONOS_TEST_COLLECT_TIMEOUT_MS 覆盖（pd 同款）
const COLLECT_TIMEOUT_MS = Number(process.env.PONOS_TEST_COLLECT_TIMEOUT_MS) > 0
  ? Number(process.env.PONOS_TEST_COLLECT_TIMEOUT_MS) : 15000

// Windows 并发下子进程句柄释放有延迟，rmSync 会偶发 EPERM——重试兜底
function rmSyncRetry(path, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return } catch (e) {
      if (i === attempts - 1) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// —— 真实内核子进程会话封装 ——
// spawn `node kernel/cli.mjs` + bridge 会话契约参数（F8 最小必要集），stdout 逐行
// NDJSON 收集（坏行忽略），提供 collect/send/endInput/stop 原语。
function spawnKernel({ home, workDir, resume, approvalMode }) {
  const args = [
    '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose',
    // 档位参数与 server/bridge.mjs getOrCreateSession 同源（approvalSpawnArgs）：
    // 缺省 loose = 原硬编码 --dangerously-skip-permissions 的等价物（今天的行为），
    // 显式传值才能测 manual/auto/bypass（见下方"档位端到端"用例）。
    ...approvalSpawnArgs(approvalMode ?? DEFAULT_APPROVAL_MODE),
    '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion',
  ]
  if (resume) args.push('--resume', resume)
  args.push('--add-dir', workDir)

  const env = {
    ...process.env,
    PONOS_MOCK_API: '1',                 // mock：免网络免真实 config
    PONOS_CONFIG_DIR: home,             // 内核数据根（config.mjs resolveConfigDir）
    YFWORKING_HOME: home,                // 净室 home 语义一致性（内核不读，产品层用）
  }
  delete env.PONOS_HOME                  // 防止宿主演进到内核解析链

  const proc = spawn(process.execPath, [KERNEL_CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const events = []
  const waiters = new Set()
  let buf = ''
  let stderrBuf = ''
  let exitInfo = null
  let killed = false

  const wake = () => { for (const w of [...waiters]) w() }

  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => {
    buf += String(d)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* 非 NDJSON 噪音行忽略 */ }
      wake()
    }
  })
  proc.stderr.on('data', (d) => { stderrBuf += String(d) })
  const exitPromise = new Promise((resolve) => {
    proc.once('exit', (code, signal) => { exitInfo = { code, signal }; wake(); resolve(exitInfo) })
  })

  const send = (obj) => new Promise((resolve, reject) => {
    try { proc.stdin.write(JSON.stringify(obj) + '\n', resolve) } catch (e) { reject(e) }
  })

  // 等待一条满足 predicate 的事件（消费式：命中即从缓冲移除）
  function collect(pred, { timeoutMs = COLLECT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(scan)
        const brief = events.slice(0, 5).map((e) => {
          const s = JSON.stringify(e)
          return s.length > 200 ? s.slice(0, 200) + '…' : s
        })
        reject(new Error(
          `collect timeout (${timeoutMs}ms) after ${exitInfo ? `exit(${exitInfo.code})` : 'process alive'}; ` +
          `buffered=${events.length} ${brief.join(' | ')}; stderr tail: ${stderrBuf.slice(-600)}`
        ))
      }, timeoutMs)
      const scan = () => {
        const i = events.findIndex(pred)
        if (i >= 0) {
          const e = events.splice(i, 1)[0]
          clearTimeout(timer)
          waiters.delete(scan)
          resolve(e)
        }
      }
      waiters.add(scan)
      scan()
    })
  }

  // 收集一轮：assistant 事件 text 块拼接，直到 result（与 pd collectTurn 同语义）
  async function collectTurn() {
    const texts = []
    while (true) {
      const ev = await collect((m) => m.type === 'assistant' || m.type === 'result')
      if (ev.type === 'result') return { text: texts.join(''), result: ev }
      for (const b of ev.message?.content || []) if (b?.type === 'text') texts.push(b.text)
    }
  }

  // 优雅停止：EOF → 等退出（默认 6s）；未退则强杀。成功 EOF 路径内核 exit 0
  // （cli.mjs stdin close → shutdown(0) 契约）。
  async function stop({ graceMs = 6000 } = {}) {
    if (!exitInfo) {
      try { if (!proc.stdin.writableEnded) proc.stdin.end() } catch { /* ignore */ }
      await Promise.race([exitPromise, sleep(graceMs)])
    }
    if (!exitInfo && !killed) {
      killed = true
      try { proc.kill() } catch { /* ignore */ }
      await Promise.race([exitPromise, sleep(2000)])
    }
    if (!exitInfo) {
      // 杀不掉：记录 PID 留给主线程，不反复强杀
      console.error(`[kernel-bridge.test] 子进程未退出，PID=${proc.pid}（交由主线程处置）`)
    }
    return exitInfo
  }

  return {
    proc, send, collect, collectTurn, stop,
    get exitInfo() { return exitInfo },
    get pid() { return proc.pid },
    get stderrTail() { return stderrBuf.slice(-600) },
  }
}

// 转录文件路径与内核 session.mjs / server/transcript.mjs 读取路径一致
function transcriptPath(home, cwd, sessionId) {
  return join(home, 'projects', sanitizeSegment(cwd), `${sessionId}.jsonl`)
}

// system(init) 事件：会话身份（session_id）由内核生成并经 init 携带
async function spawnAndInit({ home, workDir, resume, approvalMode }) {
  const k = spawnKernel({ home, workDir, resume, approvalMode })
  const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
  return { k, init }
}

test('协议闭环：bridge 会话 spawn 参数 → system(init) → user → assistant/result → EOF exit 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kb-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-kb-work-'))
  let k
  try {
    const { k: kk, init } = await spawnAndInit({ home, workDir })
    k = kk
    // init 契约字段（cli.mjs wire.system('init')：session_id/tools/capacity）
    assert.ok(init.session_id, 'init 应携带 session_id')
    assert.ok(Array.isArray(init.tools), 'init.tools 应为数组')
    assert.ok(init.tools.includes('Bash'), '工具清单应含 Bash')
    assert.ok(Number.isFinite(init.capacity) && init.capacity >= 1, 'init.capacity 应 >= 1')
    const sid = init.session_id

    // 一轮 mock 对话：user → assistant 文本回显 → result
    await k.send({ type: 'user', message: { role: 'user', content: '你好内核' } })
    const { text, result } = await k.collectTurn()
    assert.equal(text, 'mock: 你好内核 (turn=1)')
    assert.equal(result.subtype, 'success')

    // 转录落盘在 bridge/transcript 读取路径（<configDir>/projects/<cwd>/<sid>.jsonl），
    // 首行为 meta 版本标记，后续 user + assistant（D2-2）
    const file = transcriptPath(home, workDir, sid)
    assert.ok(existsSync(file), 'transcript 文件应落在内核 store 路径')
    const entries = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(entries.length, 3)
    assert.equal(entries[0].type, 'meta')
    assert.equal(entries[1].type, 'user')
    assert.equal(entries[1].message.content, '你好内核')
    assert.equal(entries[2].type, 'assistant')

    // EOF 优雅退出契约：stdin 关闭 → exit 0
    const info = await k.stop()
    assert.ok(info, '进程应已退出')
    assert.equal(info.code, 0)
  } finally {
    if (k) await k.stop()
    rmSyncRetry(workDir)
    rmSyncRetry(home)
  }
})

test('审批闭环：高危 Bash 触发 can_use_tool control_request → control_response(allow) → 工具执行 → result', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kb-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-kb-work-'))
  let k
  try {
    const { k: kk } = await spawnAndInit({ home, workDir })
    k = kk
    await k.send({ type: 'user', message: { role: 'user', content: '[mock:tool] 清理' } })
    // mock 引擎产 Bash(rm -rf) tool_use → 权限门 ask → control_request(can_use_tool)
    const req = await k.collect((m) => m.type === 'control_request' && m.request?.subtype === 'can_use_tool')
    assert.ok(req.request_id)
    assert.equal(req.request.tool_name, 'Bash')
    assert.match(String(req.request.input?.command ?? ''), /rm -rf/)
    assert.ok(req.request.tool_use_id)

    // GUI 批准 → stdin 注入 control_response（与 bridge.mjs approval-response 写形状一致）
    await k.send({
      type: 'control_response',
      response: {
        request_id: req.request_id,
        subtype: 'success',
        response: {
          behavior: 'allow',
          updatedInput: {},
          toolUseID: req.request.tool_use_id,
          decisionClassification: 'user_temporary',
        },
      },
    })
    // 工具结果回合 mock 回显 → 本轮正常 result
    const { text } = await k.collectTurn()
    assert.match(text, /工具执行完成：/)
    const info = await k.stop()
    assert.ok(info)
    assert.equal(info.code, 0)
  } finally {
    if (k) await k.stop()
    rmSyncRetry(workDir)
    rmSyncRetry(home)
  }
})

test('档位端到端：manual 档下普通 Bash 也触发 can_use_tool（档位确实传进了内核）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kb-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-kb-work-'))
  let k
  try {
    const { k: kk, init } = await spawnAndInit({ home, workDir, approvalMode: 'manual' })
    k = kk
    // init 回显生效档位（桥据此比对旧缓存内核是否忽略了新 flag）
    assert.equal(init.approval_mode, 'manual', 'init 应回显内核真正生效的档位')

    await k.send({ type: 'user', message: { role: 'user', content: '[mock:tool-safe] 看一眼' } })
    // manual = 连普通命令都要问（loose 档不会出现这条 control_request）
    const req = await k.collect((m) => m.type === 'control_request' && m.request?.subtype === 'can_use_tool')
    assert.equal(req.request.tool_name, 'Bash')
    assert.match(String(req.request.input?.command ?? ''), /echo mock-safe/)
    assert.equal(req.request.hard, undefined, '普通命令不应带硬黑名单标记')
    assert.equal(req.request.mode, 'manual', '载荷应回带生效档位')

    await k.send({
      type: 'control_response',
      response: {
        request_id: req.request_id,
        subtype: 'success',
        response: { behavior: 'allow', updatedInput: {}, toolUseID: req.request.tool_use_id, decisionClassification: 'user_temporary' },
      },
    })
    const { result } = await k.collectTurn()
    assert.equal(result.subtype, 'success', '批准后本轮应正常收尾')
    const info = await k.stop()
    assert.ok(info)
    assert.equal(info.code, 0)
  } finally {
    if (k) await k.stop()
    rmSyncRetry(workDir)
    rmSyncRetry(home)
  }
})

test('档位端到端：bypass 档下高危 Bash 不发 can_use_tool，轮次正常收尾', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kb-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-kb-work-'))
  let k
  try {
    const { k: kk, init } = await spawnAndInit({ home, workDir, approvalMode: 'bypass' })
    k = kk
    assert.equal(init.approval_mode, 'bypass')
    // [mock:tool] 的 rm -rf /tmp/ponos-mock-target 是"高危但非灾难"——bypass 下应直接执行
    await k.send({ type: 'user', message: { role: 'user', content: '[mock:tool] 清理' } })
    // 并发监听审批请求：一旦弹出即使本轮挂住也能立刻判失败（而不是等 collect 超时）
    const asked = k.collect(
      (m) => m.type === 'control_request' && m.request?.subtype === 'can_use_tool',
      { timeoutMs: 1500 },
    ).then(() => true, () => false)
    const { result } = await k.collectTurn()
    assert.equal(await asked, false, 'bypass 档不应发 can_use_tool（高危命令应自动放行）')
    assert.equal(result.subtype, 'success')
    const info = await k.stop()
    assert.ok(info)
    assert.equal(info.code, 0)
  } finally {
    if (k) await k.stop()
    rmSyncRetry(workDir)
    rmSyncRetry(home)
  }
})

test('档位端到端：硬黑名单（rm -rf /）在 bypass 档仍触发 can_use_tool 且带 hard 标记', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kb-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-kb-work-'))
  let k
  try {
    const { k: kk } = await spawnAndInit({ home, workDir, approvalMode: 'bypass' })
    k = kk
    await k.send({ type: 'user', message: { role: 'user', content: '[mock:tool-catastrophic] 清空' } })
    const req = await k.collect((m) => m.type === 'control_request' && m.request?.subtype === 'can_use_tool')
    // ⚠️ 绝不能批准：这条 tool_use 真的是 rm -rf /（GNU rm 的 --preserve-root 是唯一防线）
    assert.equal(req.request.input?.command, 'rm -rf /')
    assert.equal(req.request.hard, true, '灾难命令应带硬黑名单标记')
    assert.match(String(req.request.decision_reason ?? ''), /硬黑名单/)
    // 拒绝 → 本轮收尾（模型收到"未执行"回填），进程仍可优雅退出
    await k.send({
      type: 'control_response',
      response: {
        request_id: req.request_id,
        subtype: 'success',
        response: { behavior: 'deny', message: '测试拒绝：灾难命令', toolUseID: req.request.tool_use_id, decisionClassification: 'user_reject' },
      },
    })
    const { result } = await k.collectTurn()
    assert.equal(result.subtype, 'success')
    const info = await k.stop()
    assert.ok(info)
    assert.equal(info.code, 0)
  } finally {
    if (k) await k.stop()
    rmSyncRetry(workDir)
    rmSyncRetry(home)
  }
})

// 时序回归（2026-09-17 假告警修复的机制前提）：桥判定"内核认不认 --approval-mode"用的是
// init 回显，而 init 回显反映的是 **spawn 参数**（不是后到的热切值）——否则桥在
// "spawn→init 窗口内用户切档"（生产实测窗口 7s）时会拿实时档位当基准，把认账了新 flag 的
// 内核误判成旧缓存内核，广播假降级告警并把徽标回写成 spawn 档（界面说反话）。
// 本用例用真实内核把这条时序钉死：窗口内注入的热切不改 init 回显，但最终仍生效；
// init 之后的补 push（桥的 realign 路径）同样是内核读到的最后一条 ⇒ 生效值 = 当前档。
test('档位时序：init 前注入的热切不改 init 回显（回显 = spawn 档），init 后补 push 生效', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kb-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-kb-work-'))
  let k
  try {
    const kk = spawnKernel({ home, workDir, approvalMode: 'loose' })
    k = kk
    // 模拟桥的状态栏热切：spawn 已发生、init 尚未到达（此后到 init 之间内核在读历史/压缩）
    await k.send({ type: 'control_request', request_id: 'pre-init', request: { subtype: 'approval_mode', payload: { value: 'bypass' } } })

    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    // ★ 修复所依赖的事实：回显 = spawn 档（loose），不是窗口内切到的 bypass。
    //   桥若拿"此刻生效档位"当基准，即在此处误报旧缓存内核（假告警回归点）。
    assert.equal(init.approval_mode, 'loose', 'init 回显必须是 spawn 档，窗口内热切不得改写它')

    // 窗口内那次热切最终仍会被内核读到（stdin 管道保序）→ 生效档位切到 bypass
    const upd = await k.collect((m) => m.type === 'system'
      && (m.subtype === 'approval_mode_updated' || m.subtype === 'approval_mode_rejected'))
    assert.equal(upd.subtype, 'approval_mode_updated', '合法档位应回 updated 而非 rejected')
    assert.equal(upd.value, 'bypass')

    // 桥的 realign 路径：init 之后补 push 当前档位 —— 管道保序 ⇒ 内核读到的最后一条即当前档
    await k.send({ type: 'control_request', request_id: 'post-init', request: { subtype: 'approval_mode', payload: { value: 'manual' } } })
    const upd2 = await k.collect((m) => m.type === 'system' && m.subtype === 'approval_mode_updated')
    assert.equal(upd2.value, 'manual')

    // 端到端确认"最后一条生效"：manual 档下普通 Bash 必发 can_use_tool 且载荷回带 manual
    await k.send({ type: 'user', message: { role: 'user', content: '[mock:tool-safe] 看一眼' } })
    const req = await k.collect((m) => m.type === 'control_request' && m.request?.subtype === 'can_use_tool')
    assert.equal(req.request.mode, 'manual', 'init 后的补 push 必须真正生效（否则内核停在更宽的档）')
    await k.send({
      type: 'control_response',
      response: {
        request_id: req.request_id,
        subtype: 'success',
        response: { behavior: 'allow', updatedInput: {}, toolUseID: req.request.tool_use_id, decisionClassification: 'user_temporary' },
      },
    })
    const { result } = await k.collectTurn()
    assert.equal(result.subtype, 'success', '批准后本轮应正常收尾')
    const info = await k.stop()
    assert.ok(info)
    assert.equal(info.code, 0)
  } finally {
    if (k) await k.stop()
    rmSyncRetry(workDir)
    rmSyncRetry(home)
  }
})

test('cancel 闭环：control_request(cancel) → assistant(已取消。)+result → 会话保留可续聊', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kb-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-kb-work-'))
  let k
  try {
    const { k: kk } = await spawnAndInit({ home, workDir })
    k = kk
    // 空转 cancel（无活跃轮次）：内核同步收尾 已取消。+ result（契约 §8，bridge 依赖
    // result 复位 _cancelPending）
    await k.send({ type: 'control_request', request_id: 'cancel-test-1', request: { subtype: 'cancel' } })
    const { text, result } = await k.collectTurn()
    assert.equal(text, '已取消。')
    assert.equal(result.subtype, 'success')
    // 会话保留：同进程续聊仍可正常完成一轮（同进程首条 user → turn=1）
    await k.send({ type: 'user', message: { role: 'user', content: '接着聊' } })
    const again = await k.collectTurn()
    assert.equal(again.text, 'mock: 接着聊 (turn=1)')
    const info = await k.stop()
    assert.ok(info)
    assert.equal(info.code, 0)
  } finally {
    if (k) await k.stop()
    rmSyncRetry(workDir)
    rmSyncRetry(home)
  }
})

test('resume 兼容：--resume <session_id> 重开进程加载同转录 → init 会话身份保留 + 历史上下文续聊', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kb-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-kb-work-'))
  let k
  try {
    // 第一进程：新会话一轮
    const a = await spawnAndInit({ home, workDir })
    k = a.k
    const sid = a.init.session_id
    await a.k.send({ type: 'user', message: { role: 'user', content: '第一轮' } })
    const t1 = await a.k.collectTurn()
    assert.equal(t1.text, 'mock: 第一轮 (turn=1)')
    // 转录已含 meta + user + assistant（result 前 finalizeUsage 已落盘）
    const file = transcriptPath(home, workDir, sid)
    assert.ok(existsSync(file))
    // EOF 优雅退出后重开（进程级 --resume，模拟 GUI 恢复会话场景）
    const infoA = await a.k.stop()
    assert.equal(infoA.code, 0)
    k = null

    // 第二进程：--resume sid → init 会话身份保留
    const b = await spawnAndInit({ home, workDir, resume: sid })
    k = b.k
    assert.equal(b.init.session_id, sid, 'resume init 应携带同一 session_id')
    // 历史上下文保留：请求面含第一轮 user+assistant → mock 回显 turn 计数为 2
    await b.k.send({ type: 'user', message: { role: 'user', content: '第二轮' } })
    const t2 = await b.k.collectTurn()
    assert.equal(t2.text, 'mock: 第二轮 (turn=2)')
    // 同一转录文件追加续写（meta+user1+assistant1+user2+assistant2）
    const entries = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(entries.length, 5)
    assert.equal(entries[3].message.content, '第二轮')
    const infoB = await b.k.stop()
    assert.equal(infoB.code, 0)
  } finally {
    if (k) await k.stop()
    rmSyncRetry(workDir)
    rmSyncRetry(home)
  }
})
