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

// —— 工具能力探测（2026-09-12 线上 400 事故）——
// 事故：自建 vLLM + Qwen3.8-27B 未以 --enable-auto-tool-choice --tool-call-parser
// 启动 → 内核任何带 tools 的请求回 400。旧探测只发不带 tools 的 ping → 端点全绿，
// 用户直到首个回合才看到裸英文 400。本组钉死：①判定三态（接受/明确拒绝/不确定），
// 不确定不猜；②与内核分类器同源语义（交叉校验防正则漂移）；③只报告不改行为。
import { classifyApiError, toolsUnsupportedError } from '../kernel/api.mjs'
import { classifyToolProbeResult } from './provider-probe.mjs'

const LIVE_DETAIL = '{"type":"error","error":{"type":"BadRequestError","message":""auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"}}'

test('classifyToolProbeResult：接受 → true；vLLM 缺启动参数 → false；其余不确定 → null', () => {
  assert.equal(classifyToolProbeResult({ ok: true }), true)
  assert.equal(classifyToolProbeResult({ ok: false, status: 400, detail: LIVE_DETAIL }), false)
  assert.equal(classifyToolProbeResult({ ok: false, status: 422, detail: 'tool calling is not enabled' }), false)
  // 不确定不猜：无关 400（模型名/字段错误）、5xx、超时、网络失败都不得报"不支持工具"
  assert.equal(classifyToolProbeResult({ ok: false, status: 400, detail: '{"error":{"message":"model not found"}}' }), null)
  assert.equal(classifyToolProbeResult({ ok: false, status: 503, detail: LIVE_DETAIL }), null, '5xx 是瞬时故障，与工具能力无关')
  assert.equal(classifyToolProbeResult({ ok: false }), null)
  assert.equal(classifyToolProbeResult(undefined), null)
})

test('与内核分类器同源：同一报文两边结论一致（防两处正则漂移）', () => {
  const corpus = [
    LIVE_DETAIL,
    'This model does not support tools',
    'tools are not supported by this model',
    'tool calling is not enabled for this deployment',
    'tool_choice is not available',
    'response_format json_schema is not supported',
  ]
  for (const detail of corpus) {
    const kernelErr = new Error(`内核：API 请求失败 400 ${detail}`)
    kernelErr.status = 400
    const kernelSays = classifyApiError(kernelErr).kind === 'tools-unsupported'
    const probeSays = classifyToolProbeResult({ ok: false, status: 400, detail }) === false
    assert.equal(probeSays, kernelSays, `内核/探测判定须一致：${detail}`)
  }
  // 内核错误构造器产出的报文，探测侧必须同样判 false（同一事故两种观测路径）
  assert.equal(classifyToolProbeResult({ ok: false, status: 400, detail: toolsUnsupportedError().message }), false)
})

test('applyProbeResults：工具能力只报告不改行为（false 出警示，true/未知不出警示）', () => {
  const bad = applyProbeResults({}, { ok: true, toolsSupported: false }, { profile: 'cloud' })
  const warn = bad.notes.find((n) => String(n).includes('未开启工具调用'))
  assert.ok(warn, `应出工具能力警示，实际：${JSON.stringify(bad.notes)}`)
  assert.ok(warn.includes('--enable-auto-tool-choice') && warn.includes('--tool-call-parser'), '警示须给出可操作启动参数')
  assert.ok(!Object.keys(bad.updates).some((k) => /tool/i.test(k)), '不得因工具能力写任何配置项（无自动降级）')

  const good = applyProbeResults({}, { ok: true, toolsSupported: true }, { profile: 'cloud' })
  assert.ok(good.notes.some((n) => String(n).includes('工具调用可用')), '可用时报告实测结论')
  assert.ok(!good.notes.some((n) => String(n).includes('未开启')), '可用时不得出警示')

  const unknown = applyProbeResults({}, { ok: true, toolsSupported: null }, { profile: 'cloud' })
  assert.ok(!unknown.notes.some((n) => String(n).includes('工具调用')), '不确定时保持沉默（不猜）')
})
