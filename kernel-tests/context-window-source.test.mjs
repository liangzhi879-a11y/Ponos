// 窗口来源分流（2026-10-26）
// ---------------------------------------------------------------------------
// 病灶：探测值（服务端 /v1/models 自报，例：deepseek 返回 1048576）与手配值共用
// `PONOS_AUTO_COMPACT_WINDOW` 一条通道 ⇒ 2026-09-11 立的"表压过手配值"判据把探测
// 事实也一起吞掉（真机 1048576 被表值 1_000_000 顶掉，且重启无法自愈）。
//
// 修法：按**来源**分流，不反转原判据——
//   探测 > 表 > 手配 > 画像默认
// 本文件把四段优先级逐条钉死，特别是"手配仍斗不过表"（保护 2026-09-11）与
// "探测斗得过表"（本次新增）必须**同时**成立。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveContextWindowFor, contextWindowFor, LOCAL_DEFAULT_WINDOW, DEFAULT_WINDOW } from '../kernel/context.mjs'

test('探测 env 通道：压过模型表（服务端实测 > 内置表）', () => {
  assert.equal(
    resolveContextWindowFor({ model: 'deepseek-flash', env: { PONOS_PROBED_CONTEXT_WINDOW: '1048576' } }),
    1048576,
    '探测值 1048576 必须压过表值 1_000_000（真机复现点）',
  )
  assert.equal(
    resolveContextWindowFor({ model: 'MiniMax-M3', env: { PONOS_PROBED_CONTEXT_WINDOW: '1048576' } }),
    1048576,
    '表里 262144 也要让位给服务端实测',
  )
})

test('探测 env 通道：非法值不生效，回落表（不因脏数据把窗口打坏）', () => {
  for (const bad of ['0', '-1', 'abc', '', 'NaN']) {
    assert.equal(
      resolveContextWindowFor({ model: 'deepseek-flash', env: { PONOS_PROBED_CONTEXT_WINDOW: bad } }),
      1_000_000,
      `探测值 ${JSON.stringify(bad)} 非法时必须回落表值`,
    )
  }
})

test('provider 上的 probe 标记：压过表（热切换路径用）', () => {
  assert.equal(
    resolveContextWindowFor({ model: 'deepseek-flash', configured: 1048576, source: 'probe', env: {} }),
    1048576,
  )
  assert.equal(
    resolveContextWindowFor({ model: 'deepseek-flash', configured: 0, source: 'probe', env: {} }),
    1_000_000,
    'probe 标记但配置值为 0（无实测值）→ 回落表',
  )
})

test('★ 手配值仍斗不过表（2026-09-11 判据未反转）', () => {
  assert.equal(
    resolveContextWindowFor({ model: 'MiniMax-M3', configured: 1_000_000, env: {} }),
    262_144,
    '无 probe 标记的手配 1M 必须被表压过',
  )
  assert.equal(
    resolveContextWindowFor({ model: 'deepseek-flash', configured: 32_000, env: {} }),
    1_000_000,
    '反方向同样表准（配小了也不信手配）——双向钉死',
  )
  assert.equal(
    resolveContextWindowFor({ model: 'MiniMax-M3', configured: 1_000_000, source: 'manual', env: {} }),
    262_144,
    '显式 manual 标记同样是手配身份',
  )
})

test('未知模型：probe > 手配 > env 注入 > 画像默认', () => {
  assert.equal(resolveContextWindowFor({ model: 'x', configured: 100000, source: 'probe', env: {} }), 100000)
  assert.equal(resolveContextWindowFor({ model: 'x', configured: 100000, env: {} }), 100000)
  assert.equal(
    resolveContextWindowFor({ model: 'x', env: { PONOS_AUTO_COMPACT_WINDOW: '131072' } }),
    131072,
    '未知模型仍尊重注入值',
  )
  assert.equal(
    resolveContextWindowFor({ model: 'x', env: { PONOS_PROVIDER_PROFILE: 'local' } }),
    LOCAL_DEFAULT_WINDOW,
  )
  assert.equal(resolveContextWindowFor({ model: 'x', env: {} }), DEFAULT_WINDOW)
})

test('contextWindowFor 兼容入口：旧语义逐条不变（表优先于注入）', () => {
  assert.equal(contextWindowFor('MiniMax-M3', { PONOS_AUTO_COMPACT_WINDOW: '1000000' }), 262_144)
  assert.equal(contextWindowFor('unknown-model', { PONOS_AUTO_COMPACT_WINDOW: '131072' }), 131072)
  assert.equal(contextWindowFor('MiniMax-M3[1m]', { PONOS_AUTO_COMPACT_WINDOW: '1000000' }), 1_000_000)
  assert.equal(contextWindowFor('deepseek-flash', {}), 1_000_000)
})

test('兼容入口也吃得下探测通道（启动路径不需要改签名）', () => {
  assert.equal(
    contextWindowFor('deepseek-flash', { PONOS_PROBED_CONTEXT_WINDOW: '1048576' }),
    1048576,
    'bridge 注入探测通道后，启动路径自动生效',
  )
})
