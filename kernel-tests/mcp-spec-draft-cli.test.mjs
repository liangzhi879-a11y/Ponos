import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))

/**
 * 跑 CLI 并解析最后一行的 JSON。
 * ★ 用 spawn 而不是 execFile：约定里"没写成"用**退出码 1** 表达，
 *   而 execFile 在非零退出时拿不到 stdout（e.stdout 是 undefined）⇒ 会把"如实拒绝"读成"崩溃"。
 */
const runCli = (home, args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, PONOS_HOME: home } })
  let out = ''
  let errText = ''
  p.stdout.on('data', (d) => { out += String(d) })
  p.stderr.on('data', (d) => { errText += String(d) })
  p.on('close', (code) => {
    const line = out.trim().split('\n').filter(Boolean).pop() || '{}'
    try { resolve({ code, json: JSON.parse(line) }) } catch {
      reject(new Error(`stdout 不是 JSON（exit ${code}）: ${out.slice(0, 200)} | stderr: ${errText.slice(0, 200)}`))
    }
  })
})

test('P5c CLI：--mcp-draft 落草稿到 evolution/drafts，且第二次不覆盖', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-cli-'))
  const first = await runCli(home, ['--mcp-draft', 'api.example.com'])
  assert.equal(first.code, 0, '写成 ⇒ 退出码 0')
  assert.equal(first.json.ok, true, JSON.stringify(first.json))
  assert.ok(existsSync(first.json.path), '草稿文件应存在')
  const spec = JSON.parse(readFileSync(first.json.path, 'utf8'))
  assert.equal(spec.kind, 'mcp')
  assert.equal(spec.writeOps, false)
  assert.equal(spec.server.auth.credentialSlot, '', '凭据槽位必须空着')

  const second = await runCli(home, ['--mcp-draft', 'api.example.com'])
  assert.equal(second.code, 1, '没写成 ⇒ 退出码 1（如实拒绝，不是崩溃）')
  assert.equal(second.json.ok, false)
  assert.equal(second.json.reason, 'exists', '重复挖掘不得覆盖人改过的草稿')
  rmSync(home, { recursive: true, force: true })
})

test('P5c CLI：空域名 → 不出草稿（如实报 no-domain，而不是写个空壳）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-cli2-'))
  const r = await runCli(home, ['--mcp-draft', '   '])
  assert.equal(r.code, 1)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'no-domain')
  rmSync(home, { recursive: true, force: true })
})
