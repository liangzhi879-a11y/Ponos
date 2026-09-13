// K2.1 `/api/usage` 异步化契约（2026-09-13「任务运行慢」系统性优化 Task 8）
// ---------------------------------------------------------------------------
// 要修的**不是**"返回值不对"，而是**桥的事件循环被堵死**：`execFileSync` 同步 spawn 整个内核
// 进程 + 全量聚合，实测 10.8–19.6s，这期间所有 WS 帧 / HTTP 响应 / 控制请求一起停摆；GUI 侧
// 超时 5s（src/lib/usageApi.ts）且驾驶舱每 5s 轮询一次（同值 ⇒ 必然堆积）。
//
// 故本文件的核心用例是「异步期间定时器照常触发，同步版则一次都跑不到」——直接度量那个病灶，
// 而不是只断言 JSON 能解析（那样即使退回 execFileSync 也全绿，等于空跑）。
//
// 另外三道保险是**异步化自己引入的责任**（execFileSync 的 timeout/maxBuffer 是免费的）：
// 超时必须 kill（否则路由永久悬挂，比同步版更糟）、stdout 必须封顶、同参必须单飞
// （异步化创造了并发，不设上界会同时 spawn 好几个内核进程）。三条各有独立用例。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { kernelReadonly, kernelReadonlySync } from './kernel-readonly.mjs'

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))

// Windows：被 kill 的子进程镜像尚未完全退出时会锁住目录（rmSync → EPERM）。
// 用例本身是"父进程 kill 掉了子进程"，故清理必须容忍这个竞态（短重试即可）。
async function rmDir(dir) {
  for (let i = 0; i < 20; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch { /* 稍后重试 */ }
    await sleep(25)
  }
  rmSync(dir, { recursive: true, force: true }) // 最后一次：真失败就让它抛，别静默
}

/** 真内核的 hermetic 环境（与 kernel-readonly.test.mjs 同款隔离） */
function realEnv(home) {
  const env = { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: home, YFWORKING_HOME: home }
  delete env.PONOS_HOME // 防宿主演进内核解析链
  delete env.YFWORKING_KERNEL // 必须走真内核（不是 mock）
  return env
}

/** 临时假内核（可注入任意行为）；返回其在磁盘上的路径 */
function fakeKernel(dir, body) {
  const p = join(dir, 'fake-cli.mjs')
  writeFileSync(p, body, 'utf8')
  return p
}

/** 在 YFWORKING_KERNEL 指向 fakeCli 的前提下跑 fn（resolveKernelCli 调用期读 env，无模块缓存） */
async function withFakeKernel(dir, body, fn) {
  const prev = process.env.YFWORKING_KERNEL
  process.env.YFWORKING_KERNEL = fakeKernel(dir, body)
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.YFWORKING_KERNEL
    else process.env.YFWORKING_KERNEL = prev
  }
}

test('核心契约：异步期间事件循环不阻塞（定时器照常触发）；同步版则完全停摆', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kra-'))
  const env = realEnv(home)
  try {
    // 异步：先挂一个 10ms 定时器，再做同量的活
    let ticks = 0
    let iv = setInterval(() => { ticks++ }, 10)
    try { await kernelReadonly(['--usage'], { env, cwd: process.cwd() }) } finally { clearInterval(iv) }
    const asyncTicks = ticks

    // 同步对照：同样的活，事件循环被堵死 ⇒ 定时器一次都跑不到
    ticks = 0
    iv = setInterval(() => { ticks++ }, 10)
    try { kernelReadonlySync(['--usage'], { env, cwd: process.cwd() }) } finally { clearInterval(iv) }
    const syncTicks = ticks

    // 子进程启动+模块加载的实测底 ≈150ms ⇒ 10ms 粒度下 3 次是宽松下界
    assert.ok(asyncTicks >= 3, `异步期间定时器必须照常触发（实际 ${asyncTicks} 次）`)
    assert.equal(syncTicks, 0, `同步版必须完全堵死事件循环（实际 ${syncTicks} 次）——这正是要修的病灶`)
  } finally { await rmDir(home) }
})

test('输出与同步版逐字节一致（异步化不得改变契约）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'yfw-kra-'))
  const env = realEnv(home)
  try {
    for (const args of [['--agents'], ['--usage'], ['--usage', '--scope', 'today']]) {
      const sync = kernelReadonlySync(args, { env, cwd: process.cwd() })
      const async_ = await kernelReadonly(args, { env, cwd: process.cwd() })
      assert.equal(async_, sync, `${args.join(' ')} 的 stdout 必须与同步版一致`)
    }
    // 返回值必须是**已 trim** 的纯 JSON（调用方直接 reply 出去）
    const usage = await kernelReadonly(['--usage'], { env, cwd: process.cwd() })
    assert.doesNotThrow(() => JSON.parse(usage))
    assert.equal(usage, usage.trim())
  } finally { await rmDir(home) }
})

test('非零退出 → reject，且 message 带上子进程 stderr（调用方据此回 502）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-kra-'))
  try {
    await withFakeKernel(dir, 'process.stderr.write("内核炸了：磁盘满\\n"); process.exit(3)\n', async () => {
      await assert.rejects(() => kernelReadonly(['--usage'], { env: process.env, cwd: dir }),
        (e) => { assert.match(e.message, /内核炸了/); return true })
    })
  } finally { await rmDir(dir) }
})

test('超时必须 kill + reject（不 kill 会让路由永久悬挂，比同步版更糟）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-kra-'))
  try {
    // 子进程活 60s：若父进程没杀它，本用例会一直等下去（而非"悄悄变慢"）
    await withFakeKernel(dir, 'setTimeout(() => {}, 60000)\n', async () => {
      const t0 = Date.now()
      await assert.rejects(() => kernelReadonly(['--usage'], { env: process.env, cwd: dir, timeoutMs: 300 }),
        /timeout 300ms/)
      assert.ok(Date.now() - t0 < 5000, '超时必须在 timeoutMs 附近就返回，不能等子进程自己结束')
    })
  } finally { await rmDir(dir) }
})

test('stdout 超上限 → kill + reject（防跑飞的子进程吃光桥内存）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-kra-'))
  try {
    await withFakeKernel(dir, 'setInterval(() => process.stdout.write("x".repeat(4096)), 1)\n', async () => {
      const t0 = Date.now()
      await assert.rejects(() => kernelReadonly(['--usage'], { env: process.env, cwd: dir, maxBuffer: 2000 }),
        /超过上限/)
      assert.ok(Date.now() - t0 < 5000, '超限必须立即 kill，不能等它自然结束')
    })
  } finally { await rmDir(dir) }
})

test('单飞：同一时刻的同参请求只 spawn 一次；异参各 spawn 一次；结算后可再次 spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-kra-'))
  const count = join(dir, 'spawns.txt')
  writeFileSync(count, '')
  try {
    // 假内核每次启动追加一行 → 直接观测"到底spawn了几次"
    const body = 'import { appendFileSync } from "node:fs"; appendFileSync(process.env.KR_COUNT, "x\\n"); console.log(JSON.stringify({ ok: true }))\n'
    await withFakeKernel(dir, body, async () => {
      const env = { ...process.env, KR_COUNT: count }
      // 三个同参并发：只应启动一个子进程（同参合并语义正确：同一问题同一时刻答案本就该一致）
      const rs = await Promise.all([
        kernelReadonly(['--usage'], { env, cwd: dir }),
        kernelReadonly(['--usage'], { env, cwd: dir }),
        kernelReadonly(['--usage'], { env, cwd: dir }),
      ])
      assert.deepEqual(rs, Array(3).fill(JSON.stringify({ ok: true })), '三个调用方都必须拿到结果')
      assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 1, '同参并发只应 spawn 1 次')
      // 异参：不得被合并
      await Promise.all([
        kernelReadonly(['--usage', '--scope', 'today'], { env, cwd: dir }),
        kernelReadonly(['--agents'], { env, cwd: dir }),
      ])
      assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 3, '异参必须各 spawn 一次')
      // 结算后同参必须重新 spawn（inFlight 摘除；否则会导致**永久陈旧**——比慢严重得多）
      await kernelReadonly(['--usage'], { env, cwd: dir })
      assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 4, '结算后同参必须重新 spawn')
    })
  } finally { await rmDir(dir) }
})

test('失败也要摘除 inFlight：一次报错不得让后续同参请求永久复用那个 rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-kra-'))
  const count = join(dir, 'spawns.txt')
  writeFileSync(count, '')
  try {
    const body = 'import { appendFileSync, readFileSync } from "node:fs"; appendFileSync(process.env.KR_COUNT, "x\\n");'
      + ' const n = readFileSync(process.env.KR_COUNT, "utf8").trim().split("\\n").length;'
      + ' if (n === 1) { process.stderr.write("第一次必失败\\n"); process.exit(1) } console.log(JSON.stringify({ ok: n }))\n'
    await withFakeKernel(dir, body, async () => {
      const env = { ...process.env, KR_COUNT: count }
      await assert.rejects(() => kernelReadonly(['--usage'], { env, cwd: dir }), /第一次必失败/)
      const ok = await kernelReadonly(['--usage'], { env, cwd: dir })
      assert.equal(ok, JSON.stringify({ ok: 2 }), '第二次必须真的重新 spawn 并成功')
    })
  } finally { await rmDir(dir) }
})

test('结构性守卫：/api/usage 路由必须走异步版（不启桥，故只能查源码）', () => {
  // 说明强度：这条是**源码断言**，不是行为测试——bridge 的 HTTP 处理是 createServer 内联闭包，
  // 没有可单测的接缝，而真起桥在测试里会误杀运行中的应用（见工作流计划的明确约束）。
  // 它的职责只有一个：防止有人把 await 改回 kernelReadonlySync 而无人察觉。
  // 真正的行为验证在 K2.1 的验收：改前用量面板 5s 超时失败 → 改后正常返回。
  const src = readFileSync(join(SERVER_DIR, 'bridge.mjs'), 'utf8')
  const at = src.indexOf("url.pathname === '/api/usage'")
  assert.ok(at > 0, '必须仍存在 /api/usage 路由')
  const block = src.slice(at, at + 3000)
  // K2.2 起路由经 `getReadonlyCache().get(key, () => kernelReadonly(...))` 取数：异步调用被
  // 挪进了取数回调，但**仍是 await 的**（且只有缓存未命中时才真的 spawn）。故断言改成
  // 「await 的那条链上必须有 kernelReadonly」——保住本守卫的职责（不许退回同步），
  // 同时不把结构钉死成 K2.1 当时的形状。
  assert.match(block, /await getReadonlyCache\(\)\.get\(/, '/api/usage 必须 await 缓存取数（异步链）')
  assert.match(block, /kernelReadonly\(\[sub, \.\.\.flags\]/, '缓存未命中时取数必须走 kernelReadonly')
  assert.doesNotMatch(block, /kernelReadonlySync\(/, '/api/usage 不得再用同步版（会阻塞桥事件循环）')
  assert.doesNotMatch(src, /import \{[^}]*kernelReadonlySync[^}]*\} from '\.\/kernel-readonly\.mjs'/, 'bridge 不应再导入同步版')
  // 同步版仍须存在（现有测试与离线脚本在用）
  assert.match(readFileSync(join(SERVER_DIR, 'kernel-readonly.mjs'), 'utf8'), /export function kernelReadonlySync/)
})
