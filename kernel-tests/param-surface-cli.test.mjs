import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))

function run(home) {
  const r = spawnSync(process.execPath, [CLI, '--params'], {
    encoding: 'utf8',
    env: { ...process.env, PONOS_HOME: home },
  })
  assert.equal(r.status, 0, r.stderr)
  return { raw: r.stdout, json: JSON.parse(String(r.stdout).trim().split('\n').pop()) }
}

test('P4 参数面 CLI：无配置 ⇒ 全默认值 + 声明一并返回', () => {
  const home = mkdtempSync(join(tmpdir(), 'params-cli-'))
  const { json } = run(home)
  assert.deepEqual(json.params, { 'context.injectBudgetKb': 96, 'model.preferred': null })
  assert.deepEqual(json.spec.map((s) => s.key), ['context.injectBudgetKb', 'model.preferred'])
  rmSync(home, { recursive: true, force: true })
})

test('P4 参数面 CLI：读生效值，且**绝不把凭据打出来**', () => {
  const home = mkdtempSync(join(tmpdir(), 'params-cli2-'))
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    activeProvider: 'deepseek',
    // 刻意**不用** `sk-` 前缀：仓库有明文凭据扫描器，任何像真钥匙的字面量都会被拦（这是对的）
    providers: [{ id: 'deepseek', apiKey: 'FAKE-KEY-FOR-TEST-ONLY' }],
    context: { injectBudgetKb: 128 },
    model: { preferred: 'deepseek-chat' },
  }), 'utf8')

  const { raw, json } = run(home)
  assert.equal(json.params['context.injectBudgetKb'], 128)
  assert.equal(json.params['model.preferred'], 'deepseek-chat')
  assert.equal(raw.includes('FAKE-KEY-FOR-TEST-ONLY'), false, '参数面只输出登记过的参数，不许带出 provider 配置')
  assert.equal(raw.includes('activeProvider'), false)
  rmSync(home, { recursive: true, force: true })
})
