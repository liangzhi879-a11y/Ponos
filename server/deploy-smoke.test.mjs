// server/deploy-smoke.test.mjs —— P6 D3-1 独立部署包冒烟（package.json/.env.example/README + 独立运行）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const KERNEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel')
const tmp = mkdtempSync(join(tmpdir(), 'yfw-deploy-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('部署包：package.json 零依赖 + start 指向 cli.mjs + bin', () => {
  const pkg = JSON.parse(readFileSync(join(KERNEL_DIR, 'package.json'), 'utf-8'))
  assert.equal(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0, true)
  assert.ok(pkg.scripts?.start?.includes('cli.mjs'))
  assert.ok(pkg.bin && Object.values(pkg.bin).some((v) => v.includes('cli.mjs')))
})

test('部署包：.env.example 含必需 env 模板', () => {
  const sample = readFileSync(join(KERNEL_DIR, '.env.example'), 'utf-8')
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR']) {
    assert.ok(sample.includes(key), `.env.example 含 ${key}`)
  }
})

test('部署包：独立运行冒烟——--help 退出 0', async () => {
  const child = spawn(process.execPath, [join(KERNEL_DIR, 'cli.mjs'), '--help'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let code = null
  child.on('close', (c) => { code = c })
  const deadline = Date.now() + 8000
  while (code === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  assert.equal(code, 0)
})

test('部署包：无 GUI mock 完成一轮对话', async () => {
  const configDir = join(tmp, 'c')
  mkdirSync(configDir, { recursive: true })
  const child = spawn(process.execPath, [
    join(KERNEL_DIR, 'cli.mjs'), '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion',
  ], {
    env: { ...process.env, YFW_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  const waiters = []
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const t = l.trim()
    if (!t) return
    if (waiters.length) waiters.shift()(t)
    else lines.push(t)
  })
  const nextEvent = (ms = 5000) => {
    if (lines.length) return Promise.resolve(JSON.parse(lines.shift()))
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout')), ms)
      waiters.push((l) => { clearTimeout(to); res(JSON.parse(l)) })
    })
  }
  try {
    const init = await nextEvent()
    assert.equal(init.subtype, 'init')
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n')
    // 流式契约：文本分块产出多个 assistant 事件，循环直至 result（期间须见过 assistant）
    let sawAssistant = false
    let r = null
    for (;;) {
      const ev = await nextEvent()
      if (ev.type === 'assistant') { sawAssistant = true; continue }
      if (ev.type === 'result') { r = ev; break }
    }
    assert.ok(sawAssistant, '收到至少一个 assistant 事件')
    assert.equal(r.type, 'result')
  } finally {
    try { child.stdin.end() } catch {}
  }
})
