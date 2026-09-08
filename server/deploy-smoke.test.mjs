// server/deploy-smoke.test.mjs
// S6 部署冒烟：内核独立部署包零 npm 依赖 + node 直跑 + 产品 bin 契约（DoD 四层审计「依赖面」）
// 事实依据：kernel/package.json 无 dependencies 键（2026-09-08 实测）；bin 指向 cli.mjs、main 指向 engine.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('内核独立部署包 package.json 零 npm 依赖且入口指向 cli.mjs', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'kernel', 'package.json'), 'utf8'))
  assert.ok(!('dependencies' in pkg), 'kernel/package.json 不得声明 npm dependencies')
  assert.equal(pkg.bin?.['ponos-kernel'], 'cli.mjs')
  assert.equal(pkg.main, 'engine.mjs')
  assert.ok((pkg.engines?.node ?? '').includes('>=18'))
})

test('内核 cli.mjs 可经 node 直跑 --help（exit 0 且有输出）', () => {
  // 2026-09-08 实测：cli.mjs 把 --help 用法文本写到 stderr（stdout 为空），exit 0；
  // 故以 spawnSync 合并 stdout+stderr 断言「exit 0 且有输出」的真实行为。
  const res = spawnSync(process.execPath, [join(ROOT, 'kernel', 'cli.mjs'), '--help'], {
    encoding: 'utf8', timeout: 30000,
  })
  assert.equal(res.status, 0)
  assert.ok(((res.stdout || '') + (res.stderr || '')).length > 0)
})

test('产品 bin/cli.mjs 默认端口为新版隔离值', () => {
  const src = readFileSync(join(ROOT, 'bin', 'cli.mjs'), 'utf8')
  assert.match(src, /YFW_BRIDGE_PORT \|\| '51517'/)
  assert.match(src, /YFW_VITE_PORT \|\| '5197'/)
})
