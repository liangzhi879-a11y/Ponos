// src/lib/visionUi.test.ts
// 运行：node --test src/lib/visionUi.test.ts（Node 24 原生 TS，相对导入必须带 .ts）
//
// 这两条判定是"设置页"与"知识库导入提示"共用的唯一一份视觉能力口径。一旦它与内核口径分叉，
// 用户就会看到"设置页说配好了、导入却提示未配置"——这种矛盾用户无法自行判断，故在这里钉住。
//
// 内核侧对应实现：kernel/provider.mjs 的 visionEnv / visionAvailable（同样只要求 baseUrl + model，
// 不要求 token；本地网关常无 token）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveVisionProvider, isVisionConfigured, providerHasVision } from './visionUi.ts'
import type { AppSettings, ModelProvider } from '@/types'

const prov = (over: Partial<ModelProvider> = {}): ModelProvider => ({
  id: 'p1', name: 'P1', apiBaseUrl: 'http://gw/v1', models: ['m'], primaryModel: 'm',
  subagentModel: 'm', effortLevel: 'max', contextWindow: 1000, authToken: 't', ...over,
} as ModelProvider)

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  providers: [prov(), prov({ id: 'p2', name: 'P2' })],
  activeProvider: 'p1',
  visionProviderId: '',
  ...over,
} as AppSettings)

test('视觉来源：未指定 visionProviderId 时跟随 activeProvider', () => {
  assert.equal(resolveVisionProvider(settings())?.id, 'p1')
  assert.equal(resolveVisionProvider(settings({ activeProvider: 'p2' }))?.id, 'p2')
})

test('视觉来源：visionProviderId 优先；指向不存在的 id 时回落 activeProvider（不静默消失）', () => {
  assert.equal(resolveVisionProvider(settings({ visionProviderId: 'p2' }))?.id, 'p2')
  assert.equal(resolveVisionProvider(settings({ visionProviderId: 'ghost' }))?.id, 'p1')
})

test('视觉可用：baseUrl + visionModel 齐备才可用（不要求 token）', () => {
  const withProv = (over: Partial<ModelProvider>) => settings({ providers: [prov(over)], activeProvider: 'p1' })
  assert.equal(isVisionConfigured(withProv({ visionModel: 'MiniMax-M3' })), true)
  // 没有 visionModel = 用户没启用视觉（类型注释明确"留空=不启用 VisionTool 与自动桥接"）
  assert.equal(isVisionConfigured(withProv({})), false)
  assert.equal(isVisionConfigured(withProv({ visionModel: '   ' })), false, '空白串不算配置')
  assert.equal(isVisionConfigured(withProv({ visionModel: 'm', apiBaseUrl: '' })), false, '缺 baseUrl 内核调不通')
  assert.equal(isVisionConfigured(withProv({ visionModel: 'm', apiBaseUrl: '  ' })), false)
  // 无 token 但其余齐备：GUI 必须判"可用"——内核 visionAvailable 也只要求 baseUrl+model，
  // 两边不同口径会让本地网关用户看到"内核在用视觉、GUI 却提示未配置"。
  assert.equal(isVisionConfigured(withProv({ visionModel: 'm', authToken: '' })), true)
})

test('视觉可用：按 visionProviderId 指向的 provider 判定（跨 provider 用视觉）', () => {
  const cross = settings({
    providers: [prov({ visionModel: '' }), prov({ id: 'p2', visionModel: 'sees' })],
    activeProvider: 'p1', visionProviderId: 'p2',
  })
  assert.equal(isVisionConfigured(cross), true, 'activeProvider 无视觉模型，但指定了有视觉的 p2')
})

test('视觉可用：providers 缺失/为空时安全为 false（不得抛）', () => {
  assert.equal(isVisionConfigured(settings({ providers: [] })), false)
  assert.equal(resolveVisionProvider(settings({ providers: [] })), undefined)
  assert.equal(isVisionConfigured({ providers: undefined } as unknown as AppSettings), false)
  assert.equal(providerHasVision(undefined), false)
})
