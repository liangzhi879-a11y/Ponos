// 后台 Bash（2026-09-21 长任务可靠性 P1 Task 7）。
//
// 症状：Bash 是纯前台语义，agent 要"跑一段长程序"只能自行 start /b —— 内核既不知道
// 它在跑（退出判据不含）、也不知道它何时结束 ⇒ 只能靠用户手动发消息唤起
// （用户反馈："跑后台程序时…任务结束并不能唤醒 agent，需人工发送指令"）。
//
// 修法：run_in_background 让内核可见地起后台进程；输出落 runDir；结束时经
// notifyBackgroundDone 走与子代理**同一条**唤醒通路（engine.opts.onBackgroundFinished）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'kernel', 'tools.mjs'), 'utf8')
const cliSrc = readFileSync(join(here, '..', 'kernel', 'cli.mjs'), 'utf8')
const engineSrc = readFileSync(join(here, '..', 'kernel', 'engine.mjs'), 'utf8')
const { createToolRegistry } = await import('../kernel/tools.mjs')

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bg-bash-'))
  // Windows：被 kill 的子进程会短暂持有 cwd ⇒ rmSync 需重试，避免清理阶段误报
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

function makeRegistry(dir, hooks = {}) {
  return createToolRegistry({
    cwd: dir,
    addDirs: [dir],
    skillsDirs: [],
    skipPermissions: true,
    runDir: dir,
    onBackgroundChange: hooks.onBackgroundChange,
    notifyBackgroundDone: hooks.notifyBackgroundDone,
  })
}

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50))
}

// ── 源码对账 ──────────────────────────────────────────────────────────────────

test('实现了后台执行（落 runDir）', () => {
  assert.match(src, /function runShellBackground/, '应有后台执行实现')
  assert.match(src, /runDir/, '应支持后台日志落盘目录')
})

test('Bash schema 暴露 run_in_background（是字段声明，不只是描述里提到）', () => {
  const i = src.indexOf('Bash: {')
  assert.ok(i > 0, '应存在 Bash 工具定义')
  // ★ 必须断言字段声明形态：description 文案里也会出现 "run_in_background" 字样，
  //   只匹配字符串会让"没实现参数"的版本假通过（本测试第一版就踩了）
  assert.match(src.slice(i, i + 2500), /run_in_background:\s*\{/, 'schema 应声明 run_in_background 字段')
})

test('后台完成经 notifyBackgroundDone 回报（与子代理共用唤醒通路）', () => {
  assert.match(src, /notifyBackgroundDone/, '后台结束应回调宿主')
})

test('engine 注入 runDir 与后台进程计数（供 cli 退出判据）', () => {
  assert.match(engineSrc, /onBackgroundChange/, 'engine 应注入后台进程增减通知')
  assert.match(engineSrc, /pendingBackgroundBashCount/, 'engine 应暴露后台进程计数')
})

test('cli 退出判据纳入后台 Bash 活跃数（有存活后台进程时不退）', () => {
  assert.match(cliSrc, /pendingBackgroundBashCount/, 'cli 应查询后台 Bash 计数')
  assert.match(cliSrc, /bgBusy|bashBusy/, '退出判据应纳入它')
})

test('并发上限常量存在（防无限起后台进程）', () => {
  assert.match(src, /BG_MAX|PONOS_BG_MAX/, '应有并发上限')
})

// ── 真实行为 ──────────────────────────────────────────────────────────────────

test('行为：立即返回句柄（不阻塞轮次），完成后回调并落盘输出', async () => {
  const { dir, cleanup } = makeDir()
  try {
    const done = []
    let alive = 0
    const tr = makeRegistry(dir, {
      onBackgroundChange: (d) => { alive += d },
      notifyBackgroundDone: (info) => done.push(info),
    })
    const t0 = Date.now()
    const r = await tr.registry.Bash.run({ command: 'echo bg-hello', run_in_background: true })
    const dt = Date.now() - t0

    assert.equal(r.isError, false, `后台启动不应报错: ${String(r?.content).slice(0, 200)}`)
    assert.ok(dt < 1000, `应立即返回句柄（不阻塞），实际 ${dt}ms`)
    assert.match(String(r.content), /bg-/, '应返回 task_id / 日志路径')
    assert.equal(alive, 1, '启动时应 +1 上报（供退出判据）')

    await waitFor(() => done.length >= 1)
    assert.equal(done.length, 1, '完成后应回调一次')
    assert.equal(done[0].kind, 'bash', 'kind 应为 bash（与子代理区分）')
    assert.equal(done[0].status, 'completed', '退出码 0 → completed')
    assert.equal(alive, 0, '结束后应 -1 上报（计数归零）')

    const logFile = done[0].logFile
    assert.ok(logFile && existsSync(logFile), `日志文件应存在: ${logFile}`)
    assert.match(readFileSync(logFile, 'utf8'), /bg-hello/, '日志应含命令输出')
  } finally {
    cleanup()
  }
})

test('行为：非零退出码 → status failed（供唤醒文本正确表述）', async () => {
  const { dir, cleanup } = makeDir()
  try {
    const done = []
    const tr = makeRegistry(dir, { onBackgroundChange: () => {}, notifyBackgroundDone: (i) => done.push(i) })
    await tr.registry.Bash.run({ command: 'exit 3', run_in_background: true })
    await waitFor(() => done.length >= 1)
    assert.equal(done[0].status, 'failed', '非零退出应记 failed')
    assert.match(String(done[0].summary), /3/, '摘要应含退出码')
  } finally {
    cleanup()
  }
})

test('行为：前台语义不受影响（不传 run_in_background 仍同步返回结果）', async () => {
  const { dir, cleanup } = makeDir()
  try {
    const tr = makeRegistry(dir, { onBackgroundChange: () => {}, notifyBackgroundDone: () => {} })
    const r = await tr.registry.Bash.run({ command: 'echo foreground' })
    assert.equal(r.isError, false)
    assert.match(String(r.content), /foreground/)
  } finally {
    cleanup()
  }
})
