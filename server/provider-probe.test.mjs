// API 能力探测的纯推导函数测试（2026-09-09）——网络探测层真机手工验证，
// 推导逻辑（applyProbeResults/resolveWindowFromProbe/deriveFirstByteMs/
// maybeAdoptWindowFromEvent）全矩阵单测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyProbeResults,
  resolveWindowFromProbe,
  deriveFirstByteMs,
  maybeAdoptWindowFromEvent,
  modelMetaUrlCandidates,
} from './provider-probe.mjs'

test('modelMetaUrlCandidates：anthropic 端点剥后缀试 OpenAI 根（deepseek 双协议实测）', () => {
  const c1 = modelMetaUrlCandidates('https://api.deepseek.com/anthropic')
  assert.ok(c1.includes('https://api.deepseek.com/anthropic/v1/models'), '原样候选')
  assert.ok(c1.includes('https://api.deepseek.com/v1/models'), '剥 /anthropic 试 OpenAI 根')
  const c2 = modelMetaUrlCandidates('https://api.deepseek.com/anthropic/v1')
  assert.ok(c2.includes('https://api.deepseek.com/v1/models'), '剥 /anthropic/v1')
  const c3 = modelMetaUrlCandidates('http://218.17.137.219:8900')
  assert.ok(c3.includes('http://218.17.137.219:8900/v1/models'), 'vLLM 无后缀保持原样')
  assert.ok(new Set(c3).size === c3.length, '候选去重')
})

test('resolveWindowFromProbe：模型名精确匹配 maxModelLen', () => {
  const p = { primaryModel: 'Qwen3.8-27B' }
  const probe = { modelsMeta: [{ id: 'other', maxModelLen: 999 }, { id: 'Qwen3.8-27B', maxModelLen: 180000 }] }
  assert.equal(resolveWindowFromProbe(p, probe), 180000)
})

test('resolveWindowFromProbe：无精确匹配但单模型列表 → 唯一项', () => {
  const p = { primaryModel: 'whatever' }
  const probe = { modelsMeta: [{ id: 'Qwen3.8-27B', maxModelLen: 180000 }] }
  assert.equal(resolveWindowFromProbe(p, probe), 180000)
})

test('resolveWindowFromProbe：多模型无匹配 / 无元数据 → null', () => {
  const probe = { modelsMeta: [{ id: 'a', maxModelLen: 1 }, { id: 'b', maxModelLen: 2 }] }
  assert.equal(resolveWindowFromProbe({ primaryModel: 'c' }, probe), null)
  assert.equal(resolveWindowFromProbe({ primaryModel: 'c' }, { modelsMeta: null }), null)
  assert.equal(resolveWindowFromProbe({ primaryModel: 'c' }, {}), null)
})

test('deriveFirstByteMs：最坏 prefill × 系数，local 2x / cloud 3x，封顶 480s', () => {
  // cloud：180k tokens @ 1860 tok/s ≈ 96.8s → ×3 ≈ 290.3s
  assert.equal(deriveFirstByteMs(180000, 1860), 290323)
  // cloud：180k @ 500 tok/s = 360s → ×3 = 1080s → 封顶 480s
  assert.equal(deriveFirstByteMs(180000, 500), 480000)
  // local：×2 系数，下限 60s → 193.5s
  assert.equal(deriveFirstByteMs(180000, 1860, { profile: 'local' }), 193549)
  // local 慢吞吐：×2 = 720s → 同样封顶 480s
  assert.equal(deriveFirstByteMs(180000, 500, { profile: 'local' }), 480000)
  // 无吞吐/无窗口 → null
  assert.equal(deriveFirstByteMs(null, 500), null)
  assert.equal(deriveFirstByteMs(180000, null), null)
  assert.equal(deriveFirstByteMs(180000, 0), null)
})

test('applyProbeResults：空位回填三字段（local 画像）', () => {
  const { updates, notes } = applyProbeResults(
    { primaryModel: 'Qwen3.8-27B' },
    { modelsMeta: [{ id: 'Qwen3.8-27B', maxModelLen: 180000 }], prefillTokPerSec: 1860 },
    { profile: 'local' },
  )
  assert.equal(updates.contextWindow, 180000)
  assert.equal(updates.firstByteMs, 193549) // local ×2：96.8s×2 ≈ 193.5s
  assert.equal(updates.maxOutputTokens, 16384) // min(16384, 180000/8=22500)
  assert.ok(notes.length >= 3)
})

test('applyProbeResults：服务端实测窗口覆盖预置（2026-09-11 实测优先，防 1M 虚高）', () => {
  const provider = { primaryModel: 'm', contextWindow: 1000000, firstByteMs: 120000, maxOutputTokens: 4096 }
  const { updates, notes } = applyProbeResults(
    provider,
    { modelsMeta: [{ id: 'm', maxModelLen: 180000 }], prefillTokPerSec: 1860 },
    { profile: 'local' },
  )
  assert.equal(updates.contextWindow, 180000, '实测窗口覆盖预置 1M')
  assert.ok(notes.some((n) => String(n).includes('已校正')), '校正应显式注明')
  assert.equal(updates.firstByteMs, undefined, 'firstByteMs 仍只填空位（用户手配保留）')
  assert.equal(updates.maxOutputTokens, undefined, 'maxOutputTokens 仍只填空位')
})

test('applyProbeResults：欠费检测——billing 异常显式报告且不阻塞其他回填', () => {
  const { updates, notes } = applyProbeResults(
    { primaryModel: 'm' },
    { modelsMeta: [{ id: 'm', maxModelLen: 180000 }], billing: 'insufficient_balance' },
    { profile: 'cloud' },
  )
  assert.equal(updates.contextWindow, 180000, '窗口照常实测回填')
  assert.ok(notes.some((n) => String(n).includes('欠费')), '欠费提示必须出现在 notes')
})

test('applyProbeResults：云端画像——输出预算填内核默认 64000（可见性），温度 0', () => {
  const { updates } = applyProbeResults(
    { primaryModel: 'MiniMax-M3[1m]' },
    { modelsMeta: [{ id: 'MiniMax-M3[1m]', maxModelLen: 1000000 }], prefillTokPerSec: 5000 },
    { profile: 'cloud' },
  )
  assert.equal(updates.contextWindow, 1000000)
  // cloud ×3：1M @ 5000 = 200s → ×3 = 600s → 封顶 480s
  assert.equal(updates.firstByteMs, 480000)
  assert.equal(updates.maxOutputTokens, 64000, '云端预算填内核默认 64000（与默认一致，注入行为不变）')
  assert.equal(updates.temperature, 0, '云端温度填内核默认 0')
  assert.equal(updates.idleMs, 300000)
})

test('applyProbeResults：无元数据 → 可见性默认回填（温度/空闲窗口），窗口类不填', () => {
  const { updates } = applyProbeResults({ primaryModel: 'm' }, { prefillTokPerSec: 1000 }, { profile: 'local' })
  assert.deepEqual(updates, { temperature: 1.0, idleMs: 300000 }, 'local：温度 1.0 + 空闲 300000（内核默认），窗口/首字节无实测不填')
})

test('applyProbeResults：可用模型清单实测同步（2026-09-11 实时更新）', () => {
  const probe = { modelsMeta: [{ id: 'model-a', maxModelLen: 180000 }, { id: 'model-b', maxModelLen: null }] }
  // 清单不同 → 更新 models；primaryModel 不在新清单 → 落到首项
  const r1 = applyProbeResults({ primaryModel: 'old-model', models: ['old-model'] }, probe, { profile: 'cloud' })
  assert.deepEqual(r1.updates.models, ['model-a', 'model-b'])
  assert.equal(r1.updates.primaryModel, 'model-a', 'primaryModel 不在实测清单 → 落首项')
  assert.ok(r1.notes.some((n) => String(n).includes('可用模型')))
  // 清单一致 → 不动；primaryModel 在清单内 → 保留用户选择
  const r2 = applyProbeResults({ primaryModel: 'model-b', models: ['model-a', 'model-b'] }, probe, { profile: 'cloud' })
  assert.equal(r2.updates.models, undefined, '清单一致不重复更新')
  assert.equal(r2.updates.primaryModel, undefined, 'primaryModel 有效则保留')
  // 旧模型下线 → 主/子/视觉模型全部适配到首项（提供方改名场景）
  const r3 = applyProbeResults(
    { primaryModel: 'deepseek-chat', subagentModel: 'deepseek-chat', visionModel: 'deepseek-chat-vision', models: ['deepseek-chat'] },
    { modelsMeta: [{ id: 'deepseek-v4-flash', maxModelLen: 200000 }] },
    { profile: 'cloud' },
  )
  assert.deepEqual(r3.updates.models, ['deepseek-v4-flash'])
  assert.equal(r3.updates.primaryModel, 'deepseek-v4-flash', '主模型自动适配新名')
  assert.equal(r3.updates.subagentModel, 'deepseek-v4-flash', '子 Agent 模型跟随')
  assert.equal(r3.updates.visionModel, 'deepseek-v4-flash', '视觉模型跟随')
  assert.ok(r3.notes.some((n) => String(n).includes('已下线')), '适配原因显式注明')
})

test('maybeAdoptWindowFromEvent：只下调（采纳窗口小于配置值才采纳）', () => {
  assert.equal(maybeAdoptWindowFromEvent({ contextWindow: 1000000 }, 180000), 180000)
  assert.equal(maybeAdoptWindowFromEvent({ contextWindow: 180000 }, 180000), null, '相等不采纳')
  assert.equal(maybeAdoptWindowFromEvent({ contextWindow: 131072 }, 180000), null, '上调拒绝')
  assert.equal(maybeAdoptWindowFromEvent({}, 180000), 180000, '空位可填')
  assert.equal(maybeAdoptWindowFromEvent({}, 0), null)
  assert.equal(maybeAdoptWindowFromEvent({}, 'abc'), null)
})
