import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))

const runCli = (home) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [CLI, '--flow-candidates'], { env: { ...process.env, PONOS_HOME: home } })
  let out = ''
  let errText = ''
  p.stdout.on('data', (d) => { out += String(d) })
  p.stderr.on('data', (d) => { errText += String(d) })
  p.on('close', (code) => {
    try { resolve({ code, json: JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}') }) } catch {
      reject(new Error(`stdout 不是 JSON（exit ${code}）: ${out.slice(0, 200)} | stderr: ${errText.slice(0, 200)}`))
    }
  })
})

const line = (obj) => `${JSON.stringify(obj)}\n`
const bash = (command, ts) => line({ timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
const user = (text, ts) => line({ timestamp: ts, message: { role: 'user', content: text } })

test('P5b CLI：--flow-candidates 读 transcript 出候选；`cd`/回环地址不入候选', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flow-cli-'))
  const dir = join(home, 'projects', 'C--proj')
  mkdirSync(dir, { recursive: true })
  // 两个会话各 3 条 curl 同一外部系统（不同命令）
  for (const sid of ['s1', 's2']) {
    let body = ''
    for (let i = 0; i < 3; i += 1) body += bash(`curl -s https://api.vendor.io/v${i}/orders`, `2026-10-2${i}T10:00:00.000Z`)
    body += bash('cd /tmp && npm test', '2026-10-27T10:00:00.000Z')
    body += bash('curl http://127.0.0.1:28717/health', '2026-10-27T10:00:01.000Z')
    writeFileSync(join(dir, `${sid}.jsonl`), body, 'utf8')
  }
  const { code, json } = await runCli(home)
  assert.equal(code, 0, JSON.stringify(json))
  assert.equal(json.files, 2)
  const subs = json.candidates.map((c) => c.subject)
  assert.ok(subs.includes('api.vendor.io'), `应出 api.vendor.io，实际 ${JSON.stringify(subs)}`)
  assert.equal(subs.includes('cd'), false, '`cd` 不是外部系统')
  assert.equal(subs.some((s) => s.includes('127.0.0.1')), false, '回环地址是自家 bridge，不是外部系统')
  const c = json.candidates.find((x) => x.subject === 'api.vendor.io')
  assert.equal(c.ruleId, 'OPP-14a')
  assert.equal(c.metrics.sessions, 2)
  rmSync(home, { recursive: true, force: true })
})

test('P5b CLI：只有单会话的重复命令 ⇒ 不出候选（跨会话是硬门）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flow-cli2-'))
  const dir = join(home, 'projects')
  mkdirSync(dir, { recursive: true })
  let body = ''
  for (let i = 0; i < 9; i += 1) body += bash(`curl -s https://api.solo.io/v${i}`, '2026-10-27T10:00:00.000Z')
  writeFileSync(join(dir, 'only.jsonl'), body, 'utf8')
  const { json } = await runCli(home)
  assert.equal(json.candidates.length, 0, JSON.stringify(json.candidates))
  rmSync(home, { recursive: true, force: true })
})
