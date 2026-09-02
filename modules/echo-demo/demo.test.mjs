import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('echo-demo 可 spawn 并响应 RPC（e2e，环境无 python 则跳过）', async () => {
  const child = spawn('python', [path.join(__dirname, 'main.py')], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', d => { out += d.toString() })
  await new Promise((resolve, reject) => {
    child.stderr.on('data', d => reject(new Error('stderr: ' + d)))
    child.on('error', () => { resolve('SKIP') })  // python 不存在 → 标记跳过
    const timer = setTimeout(() => resolve('READY'), 1500)
    child.on('spawn', () => { clearTimeout(timer); resolve('READY') })
  }).then(async status => {
    if (status !== 'READY') { console.log('SKIP: python 不可用'); child.kill(); return }
    const got = new Promise(res => { const probe = setInterval(() => { const i = out.indexOf('\n'); if (i !== -1) { clearInterval(probe); res(JSON.parse(out.slice(0, i))) } }, 50) })
    child.stdin.write(JSON.stringify({ id: 1, method: 'echo.echo', params: { text: '你好' } }) + '\n')
    const msg = await got
    assert.equal(msg.result.ok, true)
    assert.equal(msg.result.result.text, '你好')
    child.kill()
  })
})
