// 模型单价三级解析：provider 显式配置 > 内置价表 > 估算兜底（P1-2）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelPrices, parseModelPricesEnv, BUILTIN_PRICES } from '../kernel/model-prices.mjs'

const ENV = { PONOS_PRICE_PER_M_INPUT: '0.2', PONOS_PRICE_PER_M_OUTPUT: '1.2', PONOS_CACHE_READ_RATIO: '0.1' }

test('provider 显式配置优先于内置价表', () => {
  const cfg = { models: [{ id: 'deepseek-chat', inputPricePerM: 3, outputPricePerM: 9, cacheReadRatio: 0.25 }] }
  const r = resolveModelPrices('deepseek-chat', cfg, ENV)
  assert.equal(r.pricePerMInput, 3)
  assert.equal(r.pricePerMOutput, 9)
  assert.equal(r.cacheReadRatio, 0.25)
  assert.equal(r.source, 'provider')
})

test('provider 配置缺字段 → 该字段回落内置价表', () => {
  const cfg = { models: [{ id: 'deepseek-chat', inputPricePerM: 3 }] }
  const r = resolveModelPrices('deepseek-chat', cfg, ENV)
  const builtin = BUILTIN_PRICES['deepseek-chat']
  assert.equal(r.pricePerMInput, 3)          // 显式给的
  assert.equal(r.pricePerMOutput, builtin.output) // 未给的回落内置
  assert.equal(r.source, 'provider')
})

test('无 provider 配置 → 用内置价表', () => {
  const r = resolveModelPrices('deepseek-chat', null, ENV)
  const builtin = BUILTIN_PRICES['deepseek-chat']
  assert.equal(r.pricePerMInput, builtin.input)
  assert.equal(r.pricePerMOutput, builtin.output)
  assert.equal(r.source, 'builtin')
})

test('模型名大小写与供应商前缀归一化', () => {
  const a = resolveModelPrices('DeepSeek-Chat', null, ENV)
  const b = resolveModelPrices('deepseek/deepseek-chat', null, ENV)
  assert.equal(a.source, 'builtin')
  assert.equal(b.source, 'builtin')
  assert.equal(a.pricePerMInput, b.pricePerMInput)
})

test('未知模型 → 回落 env 默认且 source=estimate', () => {
  const r = resolveModelPrices('totally-unknown-model-xyz', null, ENV)
  assert.equal(r.source, 'estimate')
  assert.equal(r.pricePerMInput, 0.2)
  assert.equal(r.pricePerMOutput, 1.2)
  assert.equal(r.cacheReadRatio, 0.1)
})

test('env 缺失 → estimate 用硬编码兜底（旧行为）', () => {
  const r = resolveModelPrices('unknown-xyz', null, {})
  assert.equal(r.source, 'estimate')
  assert.equal(r.pricePerMInput, 0.2)
  assert.equal(r.pricePerMOutput, 1.2)
})

test('非法/负数显式配置被忽略（不污染成本）', () => {
  const cfg = { models: [{ id: 'deepseek-chat', inputPricePerM: -1, outputPricePerM: 'abc' }] }
  const r = resolveModelPrices('deepseek-chat', cfg, ENV)
  const builtin = BUILTIN_PRICES['deepseek-chat']
  assert.equal(r.pricePerMInput, builtin.input)
  assert.equal(r.pricePerMOutput, builtin.output)
})

// 审查加固（M-1）：上一条用例的 ENV 三个值恰好等于模块内的 FALLBACK 常量，因此
// 无法区分「env 被正确读取」与「env 被完全忽略、永远走 FALLBACK」。用一组与默认值
// 明确不同的 env 才能锁住"env 生效"这条真实语义（spec §5 P1-2 的第 ③ 层）。
test('env 值被真实读取（与内置默认不同，锁住第 ③ 层语义）', () => {
  const ENV2 = { PONOS_PRICE_PER_M_INPUT: '9.9', PONOS_PRICE_PER_M_OUTPUT: '88', PONOS_CACHE_READ_RATIO: '0.4' }
  const r = resolveModelPrices('unknown-model-xyz', null, ENV2)
  assert.equal(r.source, 'estimate')
  assert.equal(r.pricePerMInput, 9.9, 'env 的输入单价必须生效（而非回落硬编码 0.2）')
  assert.equal(r.pricePerMOutput, 88, 'env 的输出单价必须生效')
  assert.equal(r.cacheReadRatio, 0.4, 'env 的缓存比例必须生效')
})

test('env 非法值 → 回落硬编码默认（不产生 NaN 成本）', () => {
  const r = resolveModelPrices('unknown-model-xyz', null, {
    PONOS_PRICE_PER_M_INPUT: '-5', PONOS_PRICE_PER_M_OUTPUT: 'abc', PONOS_CACHE_READ_RATIO: '',
  })
  assert.equal(r.pricePerMInput, 0.2)
  assert.equal(r.pricePerMOutput, 1.2)
  assert.equal(r.cacheReadRatio, 0.1)
})

// —— env 通道（Task 13 / P1-2 闭环）——
// 设置页把用户填的单价写进 config.json 的 providers[].modelPrices，bridge 在 spawn 时
// 序列化成 PONOS_MODEL_PRICES 注入内核 —— 这是"三级解析第 ① 层（provider 显式配置）"
// 唯一的**生产调用方**。缺了它，第 ① 层是死代码（用户配了价也不生效）。
// 本组用例钉的是：env → providerCfg 的解析通道正确，且**任一异常都退回旧行为**（不抛、
// 不产生 NaN 定价），因为"价格配错"绝不能影响循环运行（全局约束：静默降级）。
const PRICES_ENV = JSON.stringify({ 'deepseek-chat': { input: 5, output: 15, cacheReadRatio: 0.3 } })

test('PONOS_MODEL_PRICES 作为 provider 配置源生效（source=provider）', () => {
  const env = { PONOS_MODEL_PRICES: PRICES_ENV }
  const r = resolveModelPrices('deepseek-chat', parseModelPricesEnv(env), env)
  assert.equal(r.source, 'provider')
  assert.equal(r.pricePerMInput, 5, '必须用用户配的 5，而不是内置价表的 0.27')
  assert.equal(r.pricePerMOutput, 15, '必须用用户配的 15，而不是内置价表的 1.1')
  assert.equal(r.cacheReadRatio, 0.3)
})

test('PONOS_MODEL_PRICES 非法 JSON → 不抛，回落内置价表', () => {
  const env = { PONOS_MODEL_PRICES: '{not json' }
  assert.equal(parseModelPricesEnv(env), null, '非法 JSON 必须当"未配置"处理')
  const r = resolveModelPrices('deepseek-chat', parseModelPricesEnv(env), env)
  assert.equal(r.source, 'builtin')
  assert.equal(r.pricePerMInput, BUILTIN_PRICES['deepseek-chat'].input)
})

test('未注入 PONOS_MODEL_PRICES → 回落内置价表（旧行为逐字不变）', () => {
  const env = {}
  assert.equal(parseModelPricesEnv(env), null)
  const r = resolveModelPrices('deepseek-chat', parseModelPricesEnv(env), env)
  assert.equal(r.source, 'builtin')
  assert.equal(r.pricePerMInput, BUILTIN_PRICES['deepseek-chat'].input)
  assert.equal(r.pricePerMOutput, BUILTIN_PRICES['deepseek-chat'].output)
})

test('价格表里没有当前模型 → 不误用别的模型价，回落内置价表', () => {
  const env = { PONOS_MODEL_PRICES: JSON.stringify({ 'glm-4-plus': { input: 99, output: 99 } }) }
  const r = resolveModelPrices('deepseek-chat', parseModelPricesEnv(env), env)
  assert.equal(r.source, 'builtin')
  assert.equal(r.pricePerMInput, BUILTIN_PRICES['deepseek-chat'].input)
})

test('未知模型 + 无对应价格配置 → 回落估算（第 ③ 层）', () => {
  const env = { PONOS_MODEL_PRICES: JSON.stringify({ 'glm-4-plus': { input: 1, output: 2 } }) }
  const r = resolveModelPrices('totally-unknown-model-xyz', parseModelPricesEnv(env), env)
  assert.equal(r.source, 'estimate')
})

test('空对象 / 数组 / 空串 → 视为未配置（不产生空 providerCfg）', () => {
  assert.equal(parseModelPricesEnv({ PONOS_MODEL_PRICES: '{}' }), null)
  assert.equal(parseModelPricesEnv({ PONOS_MODEL_PRICES: '[]' }), null)
  assert.equal(parseModelPricesEnv({ PONOS_MODEL_PRICES: '' }), null)
  assert.equal(parseModelPricesEnv({}), null)
})

test('数值字符串单价也生效（GUI 表单/手改 config 的容错），非法值忽略', () => {
  const env = { PONOS_MODEL_PRICES: JSON.stringify({ 'deepseek-chat': { input: '5', output: '15', cacheReadRatio: 'abc' } }) }
  const r = resolveModelPrices('deepseek-chat', parseModelPricesEnv(env), env)
  assert.equal(r.source, 'provider')
  assert.equal(r.pricePerMInput, 5)
  assert.equal(r.pricePerMOutput, 15)
  // cacheReadRatio 非法 → 该字段回落内置价表（逐项回落语义）
  assert.equal(r.cacheReadRatio, BUILTIN_PRICES['deepseek-chat'].cacheReadRatio)
})

test('带供应商前缀/大小写的模型名仍能匹配到价格配置（与 resolve 同一归一化口径）', () => {
  const env = { PONOS_MODEL_PRICES: PRICES_ENV }
  const r = resolveModelPrices('DeepSeek/deepseek-chat', parseModelPricesEnv(env), env)
  assert.equal(r.source, 'provider')
  assert.equal(r.pricePerMInput, 5)
})
