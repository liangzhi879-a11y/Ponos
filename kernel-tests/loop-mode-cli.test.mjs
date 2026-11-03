// cli 循环模式接线（2026-10-06 三层升级 §4 A26）：--loop-mode/--router-model 解析 →
// init 回显 → stdin 热切换（updated/rejected）。模板 = approval-mode-cli.test.mjs。
// 编排扩展（2026-10-07 T6）：custom:<workflowId> 选择器——解析/回显/诊断/热切换全触点。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from '../kernel/cli.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KERNEL_CLI = join(__dirname, '..', 'kernel', 'cli.mjs')

test('parseArgs：--loop-mode/--router-model 取值；缺省 null（不预设档位）', () => {
  assert.equal(parseArgs(['--loop-mode', 'plan']).loopMode, 'plan')
  assert.equal(parseArgs(['--loop-mode', 'auto']).loopMode, 'auto')
  assert.equal(parseArgs([]).loopMode, null)
  assert.equal(parseArgs(['--loop-mode']).loopMode, null, 'flag 后无值 → null（不得变 undefined 被 || 链跳过）')
  assert.equal(parseArgs(['--router-model', 'r-x']).routerModel, 'r-x')
  assert.equal(parseArgs([]).routerModel, null)
  // 非法值原样带出，由 opts 组装处诊断并回落（解析层不抛）
  assert.equal(parseArgs(['--loop-mode', 'turbo', '--verbose']).verbose, true, '后续参数仍正常解析')
  // custom 选择器：解析层原样透传（形态校验在 opts 组装处，与枚举同口径）
  assert.equal(parseArgs(['--loop-mode', 'custom:Gen-Review']).loopMode, 'custom:Gen-Review')
  assert.equal(parseArgs(['--loop-mode', 'custom:']).loopMode, 'custom:', '非法形态也原样带出（诊断+回落在下游）')
})

// —— 进程级：init 回显 + 热切换 ——
function spawnCli({ home, workDir, args = [] }) {
  // ★ 2026-10-10（既有红修复）：显式给出"当前激活模型"，不再依赖宿主环境碰巧配了模型。
  //   成因（实测）：本文件有一条断言「空串 = 回落当前激活模型 ⇒ effective 非空」，而
  //   "当前激活模型"的来源是 provider/model（env PONOS_MODEL 或 config 播种）——`PONOS_CONFIG_DIR`
  //   已被隔离到临时 home，于是整个判定退化成"宿主 env 有没有 PONOS_MODEL"：
  //   开发机（bridge 注入过模型）绿、干净环境红。这是**环境依赖型**红，不是内核缺陷。
  //   处置：把假设显式化（此处给定），断言一字不动——修复后可复现，且不再看宿主脸色。
  const env = {
    ...process.env, PONOS_MOCK_API: '1', PONOS_CONFIG_DIR: home,
    PONOS_MODEL: 'kernel-test-model',
  }
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--permission-prompt-tool', 'stdio', '--add-dir', workDir, ...args,
  ], { cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = []
  let buf = ''
  let errBuf = ''
  const waiters = new Set()
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (d) => { errBuf += String(d) })
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d) => {
    buf += String(d)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* 非 NDJSON 行忽略 */ }
      for (const w of [...waiters]) w()
    }
  })
  const collect = (pred, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiters.delete(scan); reject(new Error(`collect timeout; events=${JSON.stringify(events.slice(0, 6))}`)) }, timeoutMs)
    const scan = () => {
      const i = events.findIndex(pred)
      if (i >= 0) { waiters.delete(scan); clearTimeout(t); resolve(events.splice(i, 1)[0]) }
    }
    waiters.add(scan)
    scan()
  })
  const send = (obj) => new Promise((res) => proc.stdin.write(JSON.stringify(obj) + '\n', res))
  const stop = async () => {
    try { if (!proc.stdin.writableEnded) proc.stdin.end() } catch { /* ignore */ }
    await new Promise((res) => { const t = setTimeout(() => { try { proc.kill() } catch {} ; res() }, 5000); proc.once('exit', () => { clearTimeout(t); res() }) })
  }
  // stderr 轮询等待（诊断行经管道异步到达；init 已达 ≠ stderr 已达）
  const waitStderr = (re, timeoutMs = 2000) => new Promise((resolve, reject) => {
    if (re.test(errBuf)) return resolve(undefined)
    const t = setTimeout(() => { clearInterval(iv); reject(new Error(`stderr 未见 ${re}；got=${JSON.stringify(errBuf.slice(0, 400))}`)) }, timeoutMs)
    const iv = setInterval(() => {
      if (re.test(errBuf)) { clearInterval(iv); clearTimeout(t); resolve(undefined) }
    }, 25)
  })
  return { proc, collect, send, stop, waitStderr }
}

async function withCli({ args = [] } = {}, fn) {
  const home = mkdtempSync(join(tmpdir(), 'yfw-lmode-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-lmode-work-'))
  const k = spawnCli({ home, workDir, args })
  try { return await fn(k) }
  finally { await k.stop(); rmSync(workDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }
}

test('init 回显：缺省 auto/react、钉住 plan 即 plan、router_model 透传', async () => {
  await withCli({}, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.loop_mode, 'auto', '缺省选择态 = auto（交还路由）')
    assert.equal(init.loop_mode_effective, 'react', '缺省实际模式 = react（零回归基线）')
    assert.equal(init.router_model, '', '未配路由模型 ⇒ 空串（解析时回落当前激活模型）')
  })
  await withCli({ args: ['--loop-mode', 'plan'] }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.loop_mode, 'plan')
    assert.equal(init.loop_mode_effective, 'plan', '钉住即生效态')
  })
  await withCli({ args: ['--loop-mode', 'plan', '--router-model', 'router-x'] }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.loop_mode, 'plan')
    assert.equal(init.router_model, 'router-x')
  })
})

test('非法 --loop-mode → 不静默进入非法档：init 回显 auto（诊断在 stderr）', async () => {
  await withCli({ args: ['--loop-mode', 'turbo'] }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.loop_mode, 'auto', '非法值不得落到引擎（回落缺省）')
    assert.equal(init.loop_mode_effective, 'react')
  })
})

test('stdin 热切换：loop_mode → updated / 非法值 → rejected（不改档，回带回执）', async () => {
  await withCli({ args: ['--loop-mode', 'plan'] }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.loop_mode, 'plan')
    // 切 reflect
    await k.send({ type: 'control_request', request_id: 'r1', request: { subtype: 'loop_mode', payload: { value: 'reflect' } } })
    const upd = await k.collect((m) => m.type === 'system' && m.subtype === 'loop_mode_updated')
    assert.equal(upd.value, 'reflect')
    assert.equal(upd.selected, 'reflect')
    assert.equal(upd.effective, 'reflect', '钉住模式立即改生效态（下一轮用）')
    // 非法值：拒绝 + 档位不变（回执必须带回当前档位，GUI 据此回滚选择器）
    await k.send({ type: 'control_request', request_id: 'r2', request: { subtype: 'loop_mode', payload: { value: 'turbo' } } })
    const rej = await k.collect((m) => m.type === 'system' && m.subtype === 'loop_mode_rejected')
    assert.equal(rej.selected, 'reflect', '拒绝后档位仍是 reflect（不改档）')
    assert.equal(rej.effective, 'reflect')
    assert.match(String(rej.reason), /非法循环模式/)
    // 切 auto：选择态交还路由，但**生效态保持 reflect**（D14 连续性：直到下一次判定）
    await k.send({ type: 'control_request', request_id: 'r3', request: { subtype: 'loop_mode', payload: { value: 'AUTO' } } })
    const upd2 = await k.collect((m) => m.type === 'system' && m.subtype === 'loop_mode_updated')
    assert.equal(upd2.selected, 'auto', '大小写容错')
    assert.equal(upd2.effective, 'reflect', 'auto 不重置在途模式（下一轮轮首由路由接管）')
  })
})

test('stdin 热切换：router_model → updated（空串 = 回落当前激活模型）', async () => {
  await withCli({}, async (k) => {
    await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    await k.send({ type: 'control_request', request_id: 'r1', request: { subtype: 'router_model', payload: { value: 'router-y' } } })
    const upd = await k.collect((m) => m.type === 'system' && m.subtype === 'router_model_updated')
    assert.equal(upd.value, 'router-y')
    await k.send({ type: 'control_request', request_id: 'r2', request: { subtype: 'router_model', payload: { value: '' } } })
    const upd2 = await k.collect((m) => m.type === 'system' && m.subtype === 'router_model_updated')
    assert.equal(upd2.value, '', '空串清空 = 回落当前激活模型')
    assert.ok(typeof upd2.effective === 'string' && upd2.effective.length > 0, '回执带解析后的实际生效模型')
    // ★ 2026-10-10 收紧：从"非空"改成"精确等于注入的激活模型"——非空只证明"有个值",
    //   精确值才证明"回落到的确实是当前激活模型"（本用例的标题语义）。收紧不放宽。
    assert.equal(upd2.effective, 'kernel-test-model', '回落到 PONOS_MODEL（当前激活模型），而不是别的来源')
  })
})

// ★ 2026-10-10（同日发现的真缺陷，本用例为它落地）：热切换回执的 effective 必须与
//   **路由模型的唯一解析实现**同口径（mode-router#resolveRouterModel：
//   routerModel → PONOS_ROUTER_MODEL → 当前激活模型）。原先 engine 的 applyRouterModel
//   自带一份 `opts.model || getProvider().model || ''` ⇒ 漏了 env 一级：
//   只配 PONOS_ROUTER_MODEL 的用户清空选择时，回执 effective 为空串（GUI 显示"生效模型为空"，
//   而实际请求用的就是该 env 模型）。
test('stdin 热切换：只配 PONOS_ROUTER_MODEL 时，空串回落必须给该 env 值（不是空串）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-lmode-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'yfw-lmode-work-'))
  // 覆盖 spawnCli 注入的 PONOS_MODEL：本用例只留路由模型这一级，验证它确实被解析到
  const saved = { m: process.env.PONOS_MODEL, r: process.env.PONOS_ROUTER_MODEL }
  process.env.PONOS_MODEL = ''
  process.env.PONOS_ROUTER_MODEL = 'router-env-model'
  const k = spawnCli({ home, workDir, args: [] })
  try {
    await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    await k.send({ type: 'control_request', request_id: 'r1', request: { subtype: 'router_model', payload: { value: '' } } })
    const upd = await k.collect((m) => m.type === 'system' && m.subtype === 'router_model_updated')
    assert.equal(upd.value, '')
    assert.equal(upd.effective, 'router-env-model',
      'PONOS_ROUTER_MODEL 必须进回落链（权威实现 mode-router#resolveRouterModel 的第二级）')
  } finally {
    await k.stop()
    if (saved.m === undefined) delete process.env.PONOS_MODEL; else process.env.PONOS_MODEL = saved.m
    if (saved.r === undefined) delete process.env.PONOS_ROUTER_MODEL; else process.env.PONOS_ROUTER_MODEL = saved.r
    rmSync(workDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// —— 编排扩展（2026-10-07 T6）：custom:<workflowId> 全触点 ——

test('--loop-mode custom:<workflowId>：init 回显 selected 带 id、effective 压成字面量 custom', async () => {
  await withCli({ args: ['--loop-mode', 'custom:Gen-Review_1.0'] }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.loop_mode, 'custom:Gen-Review_1.0', 'id 是磁盘目录名：大小写/下划线/点原样保留')
    assert.equal(init.loop_mode_effective, 'custom', '委派态字面量（GUI 徽标/路由判定口径；存在性留给轮首解析）')
  })
})

test('非法 custom 形态 --loop-mode：不落引擎（回显 auto）+ stderr 诊断带 custom:<workflowId> 指引', async () => {
  await withCli({ args: ['--loop-mode', 'custom:'] }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.loop_mode, 'auto', '非法形态不得落到引擎（回落缺省）')
    assert.equal(init.loop_mode_effective, 'react')
    await k.waitStderr(/忽略非法 --loop-mode/)
    // 同一行诊断必须带定制选择器形态指引（否则用户无从修正非法值）
    await k.waitStderr(/custom:<workflowId>/)
  })
  await withCli({ args: ['--loop-mode', 'Custom:foo'] }, async (k) => {
    const init = await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    assert.equal(init.loop_mode, 'auto', '前缀大小写不容错（跨层字面量小写 custom:）')
    await k.waitStderr(/忽略非法 --loop-mode/)
  })
})

test('stdin 热切换：custom:<id> → updated（effective=custom）；非法 custom 形态 → rejected 不改档', async () => {
  await withCli({ args: ['--loop-mode', 'plan'] }, async (k) => {
    await k.collect((m) => m.type === 'system' && m.subtype === 'init')
    // 形态合法即接受——即便工作流不存在（零状态纪律：存在性留给轮首解析，D23）
    await k.send({ type: 'control_request', request_id: 'r1', request: { subtype: 'loop_mode', payload: { value: 'custom:ghost-not-exist' } } })
    const upd = await k.collect((m) => m.type === 'system' && m.subtype === 'loop_mode_updated')
    assert.equal(upd.value, 'custom:ghost-not-exist')
    assert.equal(upd.selected, 'custom:ghost-not-exist')
    assert.equal(upd.effective, 'custom', '委派态立即生效（下一轮轮首执行编排）')
    // 非法形态：拒绝 + 档位不变 + 回执引导到定制选择器
    await k.send({ type: 'control_request', request_id: 'r2', request: { subtype: 'loop_mode', payload: { value: 'custom: has space' } } })
    const rej = await k.collect((m) => m.type === 'system' && m.subtype === 'loop_mode_rejected')
    assert.equal(rej.selected, 'custom:ghost-not-exist', '拒绝后档位不变')
    assert.equal(rej.effective, 'custom')
    assert.match(String(rej.reason), /custom:<workflowId>/)
    // 切回三模式：枚举直通（custom 与枚举互不吞并）
    await k.send({ type: 'control_request', request_id: 'r3', request: { subtype: 'loop_mode', payload: { value: 'reflect' } } })
    const upd2 = await k.collect((m) => m.type === 'system' && m.subtype === 'loop_mode_updated')
    assert.equal(upd2.selected, 'reflect')
    assert.equal(upd2.effective, 'reflect')
  })
})
