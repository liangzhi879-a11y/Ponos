// 每模型上下文窗口分辨率 + 调用时输出预算钳制（2026-09-10 小窗口本地模型切换适配）
// ---------------------------------------------------------------------------
// 背景：MODEL_CONTEXT_WINDOWS 原只有 2 个硬编码云端模型，其余模型一律回落 200K——
// 本地 32K 级小窗口模型按 200K 规划永不主动压缩，每轮撞 400（用户侧：切换本地
// 模型后任务不可续）。修复：画像感知默认（local → 64K 保守，cloud → 200K）+ 调用时
// 预算钳制（pi clampMaxTokensToContext 语义，input+max_tokens 恒 ≤ 窗口）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextWindowFor, clampOutputBudgetForWindow, LOCAL_DEFAULT_WINDOW, DEFAULT_WINDOW } from '../kernel/context.mjs'

test('contextWindowFor：内置模型表优先于注入（表=事实窗口，防 provider 手配虚高）', () => {
  // 2026-09-11：deepseek provider 手配 1M 在 flash（真实 200K）上虚高的根因修复——
  // 已知模型以表为准，未知模型才尊重注入值
  assert.equal(contextWindowFor('deepseek-v4-flash', { PONOS_AUTO_COMPACT_WINDOW: '1000000' }), 200_000, 'flash 表 200K 压过注入 1M')
  assert.equal(contextWindowFor('unknown-model', { PONOS_AUTO_COMPACT_WINDOW: '131072', PONOS_PROVIDER_PROFILE: 'local' }), 131072, '未知模型注入优先')
  assert.equal(contextWindowFor('MiniMax-M3[1m]', { PONOS_AUTO_COMPACT_WINDOW: '1000000' }), 1_000_000, '带后缀不命中表 → 注入生效')
})

test('contextWindowFor：内置模型表精确命中', () => {
  assert.equal(contextWindowFor('deepseek-v4-flash', {}), 200_000)
  assert.equal(contextWindowFor('deepseek-v4-pro', {}), 1_000_000)
  assert.equal(contextWindowFor('MiniMax-M3', {}), 262_144)
})

test('contextWindowFor：local 画像未命中表 → 64K 保守默认（不虚高撑爆小窗口）', () => {
  assert.equal(contextWindowFor('Qwen3.8-27B', { PONOS_PROVIDER_PROFILE: 'local' }), LOCAL_DEFAULT_WINDOW)
})

test('contextWindowFor：cloud/未知画像未命中表 → 200K 默认（既有行为）', () => {
  assert.equal(contextWindowFor('some-cloud-model', { PONOS_PROVIDER_PROFILE: 'cloud' }), DEFAULT_WINDOW)
  assert.equal(contextWindowFor('some-model', {}), DEFAULT_WINDOW)
})

test('contextWindowFor：注入 0/NaN/非法值视为未注入（回落表/画像默认）', () => {
  assert.equal(contextWindowFor('m', { PONOS_AUTO_COMPACT_WINDOW: '0', PONOS_PROVIDER_PROFILE: 'cloud' }), DEFAULT_WINDOW)
  assert.equal(contextWindowFor('m', { PONOS_AUTO_COMPACT_WINDOW: 'abc', PONOS_PROVIDER_PROFILE: 'cloud' }), DEFAULT_WINDOW)
  assert.equal(contextWindowFor('deepseek-v4-flash', { PONOS_AUTO_COMPACT_WINDOW: '0' }), 200_000, '注入 0 时表仍生效')
})

test('clampOutputBudgetForWindow：预算装得下不动', () => {
  assert.equal(clampOutputBudgetForWindow({ window: 200_000, inputEst: 100_000, budget: 64000 }), 64000)
})

test('clampOutputBudgetForWindow：超窗收窄到 window − est − reserve', () => {
  assert.equal(clampOutputBudgetForWindow({ window: 32768, inputEst: 20000, budget: 64000 }), 32768 - 20000 - 2048)
})

test('clampOutputBudgetForWindow：cap 低于 floor 返回 floor（宁小勿大，装不下由 400 自愈兜底）', () => {
  assert.equal(clampOutputBudgetForWindow({ window: 4000, inputEst: 3000, budget: 64000 }), 1024)
})

test('clampOutputBudgetForWindow：est 缺省按 0 计（估算失败不放大预算）', () => {
  assert.equal(clampOutputBudgetForWindow({ window: 10000, inputEst: NaN, budget: 64000 }), 10000 - 2048)
})

test('clampOutputBudgetForWindow：非法参数返回 null（调用方跳过钳制）', () => {
  assert.equal(clampOutputBudgetForWindow({ window: 0, inputEst: 10, budget: 100 }), null)
  assert.equal(clampOutputBudgetForWindow({ window: 1000, inputEst: 10, budget: NaN }), null)
  assert.equal(clampOutputBudgetForWindow({ window: NaN, inputEst: 10, budget: 100 }), null)
})
