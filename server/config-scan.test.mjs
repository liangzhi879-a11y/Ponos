// server/config-scan.test.mjs —— P6 D1-1 配置清单生成式 reference（env/CLI flag 盘点）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanKernelConfig, renderConfigReference } from '../kernel/config-scan.mjs'

const KERNEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel')

test('scanKernelConfig：盘点 env 引用（关键项存在）', () => {
  const r = scanKernelConfig({ dir: KERNEL_DIR })
  assert.ok(r.env.includes('ANTHROPIC_BASE_URL'))
  assert.ok(r.env.includes('ANTHROPIC_AUTH_TOKEN'))
  assert.ok(r.env.includes('CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS'))
  assert.ok(r.env.includes('PONOS_MOCK_API'))
  assert.ok(r.env.includes('CLAUDE_CONFIG_DIR'))
  // 去重 + 排序
  assert.equal(new Set(r.env).size, r.env.length)
  assert.deepEqual(r.env, [...r.env].sort())
})

test('scanKernelConfig：盘点 CLI flag（关键项存在）', () => {
  const r = scanKernelConfig({ dir: KERNEL_DIR })
  for (const f of ['--output-format', '--input-format', '--add-dir', '--resume', '--model', '--append-system-prompt-file']) {
    assert.ok(r.flags.includes(f), `flag 存在: ${f}`)
  }
})

test('renderConfigReference：markdown 输出含 env/flags 两节', () => {
  const md = renderConfigReference({ env: ['ANTHROPIC_BASE_URL'], flags: ['--add-dir'] })
  assert.ok(md.includes('# 内核配置参考'))
  assert.ok(md.includes('| 环境变量 | 默认值 | 示例 | 影响面 |'))
  assert.ok(md.includes('ANTHROPIC_BASE_URL'))
  assert.ok(md.includes('| 命令行参数 | 说明 |'))
  assert.ok(md.includes('--add-dir'))
})
