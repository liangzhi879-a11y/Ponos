// Bash 超时可配（2026-09-21 长任务可靠性 P1 Task 6）。
//
// 事故：BASH_TIMEOUT_MS 硬编码 120s 且**不可配置** ⇒ 打包 / OCR 批处理 / 大目录遍历等
// 长活必被腰斩。会话记录中「命令超时（120000ms）」实测出现 277 次。
//
// 本文件两部分：① 源码对账（盯住 env 与 schema 不再退回硬编码 / 单参形态）；
// ② 真实行为（timeout_ms 真的生效、不再等满 120s）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'kernel', 'tools.mjs'), 'utf8')
const { createToolRegistry } = await import('../kernel/tools.mjs')

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bash-timeout-'))
  // Windows：被 kill 的子进程会短暂持有 cwd 句柄，立即 rmSync 会 EPERM
  // ⇒ 重试若干次（不影响断言，只避免清理阶段误报失败）
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

function makeBash(dir) {
  const tr = createToolRegistry({ cwd: dir, addDirs: [dir], skillsDirs: [], skipPermissions: true })
  return tr.registry.Bash
}

// ── ① 源码对账 ────────────────────────────────────────────────────────────────

test('BASH_TIMEOUT_MS 走 env（PONOS_BASH_TIMEOUT_MS），默认 120_000', () => {
  assert.match(src, /PONOS_BASH_TIMEOUT_MS/, '应支持环境变量覆盖（原为硬编码，不可配置）')
  assert.match(src, /envNonNeg\('PONOS_BASH_TIMEOUT_MS',\s*120_000\)/, '应以 envNonNeg 解析并保留原默认值')
})

test('存在上限常量（防单条命令无限占住内核）', () => {
  assert.match(src, /BASH_TIMEOUT_MAX_MS\s*=\s*30\s*\*\s*60_000/, '应有 30min 上限常量')
})

test('runShell 接收 timeoutMs 第三参并在定时器里用它', () => {
  assert.match(src, /function runShell\(command, cwd, timeoutMs/, 'runShell 应可接收超时参数')
  assert.match(src, /setTimeout\([^)]*limit|const limit = /, '定时器应使用解析后的 limit')
})

test('Bash schema 暴露 timeout_ms，且 run 把它传下去', () => {
  const i = src.indexOf('Bash: {')
  assert.ok(i > 0, '应存在 Bash 工具定义')
  const seg = src.slice(i, i + 2000)
  assert.match(seg, /timeout_ms/, 'schema 应声明 timeout_ms')
  assert.match(seg, /input\?\.timeout_ms|input\.timeout_ms/, 'run 应把 timeout_ms 传给 runShell')
})

test('description 不再宣称"不可调"的 120s（应说明可覆盖）', () => {
  const i = src.indexOf('Bash: {')
  const seg = src.slice(i, i + 2000)
  assert.match(seg, /timeout_ms/, '描述里应提到 timeout_ms 用法')
})

// ── ② 真实行为 ────────────────────────────────────────────────────────────────

test('行为：timeout_ms 真的生效（短超时应被砍，而不是等满默认 120s）', async () => {
  const { dir, cleanup } = makeDir()
  try {
    const bash = makeBash(dir)
    // ★ 同机基线（2026-10-27）：先量"这条命令自然跑完要多久"，再量"被 800ms 砍掉用多久"。
    //   绝对阈值（如 dt < 5000）在满负载机器上会假红 —— spawn+kill 本身就可能超 5s；
    //   而"被砍的必须比跑完的快"是与机器快慢无关的结构性事实。
    const full0 = Date.now()
    const full = await bash.run({ command: 'node -e "setTimeout(()=>{},3000)"', timeout_ms: 10000 })
    const dtFull = Date.now() - full0
    assert.equal(full.isError, false, `基线（不砍）应正常结束，实际: ${String(full.content).slice(0, 120)}`)

    const t0 = Date.now()
    const r = await bash.run({ command: 'node -e "setTimeout(()=>{},3000)"', timeout_ms: 800 })
    const dt = Date.now() - t0
    assert.equal(r.isError, true, '超时应标记为错误')
    assert.match(r.content, /命令超时（800ms）/, `报错应回显生效的超时值，实际: ${String(r.content).slice(0, 200)}`)
    assert.ok(dt < dtFull, `被砍的（${dt}ms）必须比跑完的（${dtFull}ms）快，否则说明 timeout_ms 未生效`)
    // ★ 约定（P1 Task 9）：超时结果必须带 meta.timeout —— 内核据此把"在等长命令"（在忙）
    //   与"真失败"分开计时，否则长命令期间会被判"无实质进展"而中断（症状①）
    assert.equal(r.meta?.timeout, true, '超时结果必须带 meta.timeout')
  } finally {
    cleanup()
  }
})

test('行为：不传 timeout_ms 时按默认执行（正常命令成功返回）', async () => {
  const { dir, cleanup } = makeDir()
  try {
    const bash = makeBash(dir)
    const r = await bash.run({ command: 'echo hello-bash' })
    assert.equal(r.isError, false, `普通命令应成功，实际: ${String(r.content).slice(0, 200)}`)
    assert.match(String(r.content), /hello-bash/)
  } finally {
    cleanup()
  }
})

test('行为：超上限的 timeout_ms 被夹到上限（不得无限等待）', async () => {
  const { dir, cleanup } = makeDir()
  try {
    const bash = makeBash(dir)
    // 请求 100 小时，应被夹到 30min 上限；用一条秒回命令验证不报错、不挂住
    const r = await bash.run({ command: 'echo capped', timeout_ms: 360_000_000 })
    assert.equal(r.isError, false)
    assert.match(String(r.content), /capped/)
  } finally {
    cleanup()
  }
})
