// provider 行为画像纯函数测试（2026-09-09 本地模型系统性适配 P3）
// ---------------------------------------------------------------------------
// 覆盖：画像判定（显式三值/启发式矩阵，含 218.17.137.219 http→local 固化）、
// 云端零注入（=现状）、local 默认表、显式字段覆盖（两画像）、非法值跳过、
// 用户 env 优先、身份模板双插值。纯函数：无 fs/无真实 env/无网络。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveProviderProfile,
  providerProfileEnv,
  activeProviderModel,
  buildIdentityPrompt,
  MANAGED_KEYS,
} from './provider-profile.mjs'

// —— 画像判定 ——

test('resolveProviderProfile：显式 profile 三值', () => {
  assert.equal(resolveProviderProfile({ profile: 'local', apiBaseUrl: 'https://api.deepseek.com' }), 'local')
  assert.equal(resolveProviderProfile({ profile: 'cloud', apiBaseUrl: 'http://127.0.0.1:8900' }), 'cloud')
  assert.equal(resolveProviderProfile({ profile: 'AUTO', apiBaseUrl: 'http://127.0.0.1:8900' }), 'local') // 大小写归一
  assert.equal(resolveProviderProfile({ profile: 'weird', apiBaseUrl: 'http://127.0.0.1:8900' }), 'local') // 未知值按 auto
})

test('resolveProviderProfile：私有网段/本机 → local', () => {
  for (const u of ['http://127.0.0.1:8900', 'http://10.1.2.3:8080', 'http://192.168.1.10/v1', 'http://172.16.0.5:8900', 'http://172.31.255.1:9', 'http://localhost:11434', 'http://[::1]:8000']) {
    assert.equal(resolveProviderProfile({ apiBaseUrl: u }), 'local', u)
  }
})

test('resolveProviderProfile：已知云域名 → cloud', () => {
  for (const u of ['https://api.deepseek.com/anthropic', 'https://api.minimaxi.com/anthropic', 'https://api.anthropic.com/v1', 'http://api.deepseek.com/x']) {
    assert.equal(resolveProviderProfile({ apiBaseUrl: u }), 'cloud', u)
  }
})

test('resolveProviderProfile：https+公网IP → cloud；http 明文公网IP → local（1106 服务器固化）', () => {
  // 218.17.137.219 是公网 IP + 明文 http——自建 vLLM 服务的典型形态，必须判 local
  assert.equal(resolveProviderProfile({ apiBaseUrl: 'http://218.17.137.219:8900' }), 'local')
  assert.equal(resolveProviderProfile({ apiBaseUrl: 'https://218.17.137.219:8900' }), 'cloud')
})

test('resolveProviderProfile：空/非法 baseUrl → cloud（安全默认）', () => {
  assert.equal(resolveProviderProfile({}), 'cloud')
  assert.equal(resolveProviderProfile({ apiBaseUrl: '' }), 'cloud')
  assert.equal(resolveProviderProfile({ apiBaseUrl: 'not-a-url' }), 'cloud')
})

// —— env 映射 ——

test('providerProfileEnv：local 默认表（2026-09-10 CC 对标：温度 1.0 / 输出 8K）', () => {
  const env = providerProfileEnv({ profile: 'local', apiBaseUrl: 'http://218.17.137.219:8900' })
  assert.equal(env.PONOS_TEMPERATURE, '1.0')
  assert.equal(env.PONOS_PROMPT_TIER, 'lean')
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8192')
  assert.equal(env.PONOS_PROMPT_CACHE, undefined, 'vLLM 前缀缓存是服务端行为，不设')
  assert.equal(env.PONOS_STREAM_FIRST_BYTE_MS, undefined, '看门狗窗口用内核默认（已按本地标定）')
  assert.equal(env.PONOS_STREAM_IDLE_MS, undefined)
})

test('providerProfileEnv：cloud → 仅画像标记（2026-09-10：内核窗口默认分辨率需要；其余一行不注入）', () => {
  assert.deepEqual(providerProfileEnv({ profile: 'cloud', apiBaseUrl: 'https://api.deepseek.com/anthropic' }), { PONOS_PROVIDER_PROFILE: 'cloud' })
  assert.deepEqual(providerProfileEnv({ apiBaseUrl: 'https://api.minimaxi.com/anthropic' }), { PONOS_PROVIDER_PROFILE: 'cloud' })
})

test('providerProfileEnv：显式字段覆盖任何画像', () => {
  const local = providerProfileEnv({ profile: 'local', temperature: 1.2, maxOutputTokens: 32768, firstByteMs: 600000, idleMs: 240000 })
  assert.equal(local.PONOS_TEMPERATURE, '1.2')
  assert.equal(local.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '32768')
  assert.equal(local.PONOS_STREAM_FIRST_BYTE_MS, '600000')
  assert.equal(local.PONOS_STREAM_IDLE_MS, '240000')
  const cloud = providerProfileEnv({ profile: 'cloud', temperature: 0.3 })
  assert.deepEqual(cloud, { PONOS_TEMPERATURE: '0.3', PONOS_PROVIDER_PROFILE: 'cloud' })
})

test('providerProfileEnv：非法数值跳过（宁缺勿崩）', () => {
  const env = providerProfileEnv({ profile: 'local', temperature: 3, maxOutputTokens: -5, firstByteMs: 'abc', idleMs: 0 })
  assert.equal(env.PONOS_TEMPERATURE, '1.0', '非法显式温度回退 local 默认（2026-09-10 CC 对标 1.0）')
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8192', '非法预算回退默认（2026-09-10 CC 对标 8K）')
  assert.equal(env.PONOS_STREAM_FIRST_BYTE_MS, undefined)
  assert.equal(env.PONOS_STREAM_IDLE_MS, undefined)
})

test('providerProfileEnv：用户 env 已有同键 → 该键不产出', () => {
  const env = providerProfileEnv({ profile: 'local' }, { env: { PONOS_TEMPERATURE: '0.9' } })
  assert.equal(env.PONOS_TEMPERATURE, undefined, '用户 env 优先')
  assert.equal(env.PONOS_PROMPT_TIER, 'lean', '其余键正常产出')
})

// —— 辅助函数 ——

test('activeProviderModel：active 命中 / fallback 首个 / 空', () => {
  const cfg = {
    activeProvider: 'b',
    providers: [
      { id: 'a', primaryModel: 'model-a' },
      { id: 'b', primaryModel: 'model-b', models: ['x'] },
    ],
  }
  assert.equal(activeProviderModel(cfg), 'model-b')
  assert.equal(activeProviderModel({ ...cfg, activeProvider: 'missing' }), 'model-a')
  assert.equal(activeProviderModel({ ...cfg, activeProvider: 'missing', providers: [{ id: 'c', models: ['only-models'] }] }), 'only-models')
  assert.equal(activeProviderModel({}), '')
})

test('buildIdentityPrompt：模型名双插值（身份+回答模板），空模型回退占位', () => {
  const withModel = buildIdentityPrompt('Qwen3.8-27B')
  assert.ok(withModel.includes('（当前为 Qwen3.8-27B）'), '身份行应插值模型名')
  assert.ok(withModel.includes('当前由 Qwen3.8-27B 模型驱动'), '回答模板应插值模型名')
  assert.ok(!withModel.includes('deepseek-v4-flash'), '不得再出现硬编码模型名')
  const fallback = buildIdentityPrompt('')
  assert.ok(fallback.includes('用户配置的模型'))
  assert.ok(fallback.includes('用户配置的模型驱动'), '空模型回答模板应自然通顺')
  assert.ok(!fallback.includes('由用户配置的模型 模型驱动'), '不得出现双重表述')
  // 协议文本拼接
  const composed = buildIdentityPrompt('m', { askuserFormat: 'ASK_USER_BLOCK', milestoneProtocol: 'MILESTONE_BLOCK' })
  assert.ok(composed.includes('ASK_USER_BLOCK'))
  assert.ok(composed.includes('MILESTONE_BLOCK'))
  assert.ok(composed.includes('使用简体中文与用户交流，回答直接、专业、简洁。'), '收尾句保留')
  assert.ok(composed.includes('文件操作审批铁律'), '审批铁律段保留')
})

test('MANAGED_KEYS：七个受管键齐备（syncKernelSettings 剔除规则依赖）', () => {
  assert.deepEqual(MANAGED_KEYS.sort(), [
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'PONOS_PROMPT_CACHE',
    'PONOS_PROMPT_TIER',
    'PONOS_PROVIDER_PROFILE',
    'PONOS_STREAM_FIRST_BYTE_MS',
    'PONOS_STREAM_IDLE_MS',
    'PONOS_TEMPERATURE',
  ].sort())
})
