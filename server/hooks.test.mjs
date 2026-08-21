// server/hooks.test.mjs —— hooks 生命周期执行器（docs/production/platform.md P4-2）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHooks, matchHook } from '../kernel/hooks.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'yfw-hooks-'))
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
