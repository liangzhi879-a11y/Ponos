// server/hooks.test.mjs —— hooks 生命周期执行器（docs/production/platform.md P4-2）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHooks, matchHook } from '../kernel/hooks.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'ponos-hooks-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('matchHook：event 精确 + tools 列表过滤 + 缺省匹配全部', () => {
  const rules = [
    { event: 'preToolUse', tools: 'Bash,Read', command: 'a' },
    { event: 'preToolUse', command: 'b' },
    { event: 'postToolUse', command: 'c' },
  ]
  assert.equal(matchHook(rules, 'preToolUse', 'Bash').length, 2)
  assert.equal(matchHook(rules, 'preToolUse', 'Write').length, 1)
  assert.equal(matchHook(rules, 'postToolUse', 'Bash').length, 1)
  assert.equal(matchHook(rules, 'sessionStart', 'Bash').length, 0)
})

test('createHooks.run：preToolUse deny 解析 + 未匹配返回 matched=false', async () => {
  const script = join(tmp, 'deny.mjs')
  writeFileSync(script, `
    import { readFileSync } from 'node:fs'
    const line = readFileSync(0, 'utf-8').trim()
    const p = JSON.parse(line)
    process.stdout.write(JSON.stringify({ deny: true, message: 'hook 拒绝 ' + p.toolName }))
  `, 'utf-8')
  const hooks = createHooks({ rules: [{ event: 'preToolUse', tools: 'Bash', command: process.execPath, args: [script] }] })
  const r = await hooks.run('preToolUse', { toolName: 'Bash', toolUseId: 'tu1', input: { command: 'echo hi' } })
  assert.equal(r.matched, true)
  assert.equal(r.deny, true)
  assert.ok(r.message.includes('hook 拒绝 Bash'))
  assert.equal(r.exitCode, 0)

  const miss = await hooks.run('preToolUse', { toolName: 'Read', toolUseId: 'tu2', input: {} })
  assert.equal(miss.matched, false)
})

test('createHooks.run：userPromptSubmit stop 解析', async () => {
  const script = join(tmp, 'stop.mjs')
  writeFileSync(script, `
    import { readFileSync } from 'node:fs'
    readFileSync(0, 'utf-8')
    process.stdout.write(JSON.stringify({ stop: true, message: 'intercepted' }))
  `, 'utf-8')
  const hooks = createHooks({ rules: [{ event: 'userPromptSubmit', command: process.execPath, args: [script] }] })
  const r = await hooks.run('userPromptSubmit', { prompt: 'hello' })
  assert.equal(r.stop, true)
  assert.equal(r.message, 'intercepted')
})

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')

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
    nextEvent(timeoutMs = 5000) {
      if (lines.length) return Promise.resolve(JSON.parse(lines.shift()))
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('read timeout: ' + JSON.stringify(lines))), timeoutMs)
        waiters.push((l) => { clearTimeout(t); resolve(JSON.parse(l)) })
      })
    },
  }
}

function sanitizeSegment(s) {
  return String(s).replace(/[^a-zA-Z0-9\u4e00-\u9fa5.-]/g, '-')
}

test('hooks 集成：preToolUse deny → tool_result 携带 hook 消息', async () => {
  const configDir = join(tmp, 'hcfg')
  const cwd = join(tmp, 'hproj')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(cwd, '.ponos'), { recursive: true })
  const script = join(tmp, 'deny-all.mjs')
  writeFileSync(script, `
    import { readFileSync } from 'node:fs'
    readFileSync(0, 'utf-8')
    process.stdout.write(JSON.stringify({ deny: true, message: 'HOOK_DENY_MARK' }))
  `, 'utf-8')
  writeFileSync(join(cwd, '.ponos', 'settings.json'), JSON.stringify({
    hooks: [{ event: 'preToolUse', tools: 'Bash', command: process.execPath, args: [script] }],
  }), 'utf-8')
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd,
  ], {
    env: { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  try {
    const init = await reader.nextEvent()
    const sid = init.session_id
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '[mock:tool-safe]' } }) + '\n')
    while (true) {
      const ev = await reader.nextEvent()
      if (ev.type === 'result') break
    }
    const transcriptPath = join(configDir, 'projects', sanitizeSegment(cwd), sid + '.jsonl')
    assert.ok(existsSync(transcriptPath), 'transcript 存在: ' + transcriptPath)
    assert.ok(readFileSync(transcriptPath, 'utf-8').includes('HOOK_DENY_MARK'), 'tool_result 含 hook 拒绝消息')
  } finally {
    try { child.stdin.end() } catch {}
  }
})

test('hooks 集成：userPromptSubmit stop → 拦截不进轮次', async () => {
  const configDir = join(tmp, 'hcfg2')
  const cwd = join(tmp, 'hproj2')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(cwd, '.ponos'), { recursive: true })
  const script = join(tmp, 'stop-all.mjs')
  writeFileSync(script, `
    import { readFileSync } from 'node:fs'
    readFileSync(0, 'utf-8')
    process.stdout.write(JSON.stringify({ stop: true, message: 'STOPPED_BY_HOOK' }))
  `, 'utf-8')
  writeFileSync(join(cwd, '.ponos', 'settings.json'), JSON.stringify({
    hooks: [{ event: 'userPromptSubmit', command: process.execPath, args: [script] }],
  }), 'utf-8')
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd,
  ], {
    env: { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  try {
    await reader.nextEvent() // init
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
    const a1 = await reader.nextEvent()
    assert.equal(a1.type, 'assistant')
    // wire.assistant 形态：message.content 文本块（无顶层 .text）
    assert.ok(JSON.stringify(a1).includes('STOPPED_BY_HOOK'), 'assistant 事件携带 hook 拦截消息')
    const r1 = await reader.nextEvent()
    assert.equal(r1.type, 'result')
  } finally {
    try { child.stdin.end() } catch {}
  }
})
