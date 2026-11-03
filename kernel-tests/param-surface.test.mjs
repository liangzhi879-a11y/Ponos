import { test } from 'node:test'
import assert from 'node:assert/strict'
import { L1_PARAMS, checkValue, resolveParams, validatePatch, applyPatch, paramDescs, pickModel, suggestPatchFromCandidate, explicitParams, atlasBudgetBytes } from '../kernel/param-surface.mjs'

test('L1 参数面：缺键/坏值一律回落默认（永不抛错）', () => {
  assert.deepEqual(resolveParams({}), {
    'context.injectBudgetKb': 96,
    'model.preferred': null,
  })
  // 坏类型 / 越界 / 格式不对 ⇒ 全部回落
  assert.equal(resolveParams({ context: { injectBudgetKb: '128' } })['context.injectBudgetKb'], 96)
  assert.equal(resolveParams({ context: { injectBudgetKb: 4 } })['context.injectBudgetKb'], 96)
  assert.equal(resolveParams({ context: { injectBudgetKb: 900 } })['context.injectBudgetKb'], 96)
  assert.equal(resolveParams({ model: { preferred: '有 空格 的模型' } })['model.preferred'], null)
  // null / undefined / 非对象 config 都不炸
  assert.equal(resolveParams(null)['context.injectBudgetKb'], 96)
  assert.equal(resolveParams(undefined)['model.preferred'], null)
})

test('L1 参数面：合法值原样生效（含边界值）', () => {
  assert.equal(resolveParams({ context: { injectBudgetKb: 8 } })['context.injectBudgetKb'], 8)
  assert.equal(resolveParams({ context: { injectBudgetKb: 512 } })['context.injectBudgetKb'], 512)
  assert.equal(resolveParams({ model: { preferred: 'deepseek-chat' } })['model.preferred'], 'deepseek-chat')
})

test('L1 参数面：未登记的键一律拒（提案面不许开口子）', () => {
  assert.deepEqual(validatePatch({ 'network.provider': false }), { ok: false, errors: [{ key: 'network.provider', code: 'unknown-key' }] })
  assert.deepEqual(validatePatch({ 'providers': [] }), { ok: false, errors: [{ key: 'providers', code: 'unknown-key' }] })
  assert.deepEqual(validatePatch({}), { ok: false, errors: [{ key: '', code: 'empty' }] })
  assert.deepEqual(validatePatch(null), { ok: false, errors: [{ key: '', code: 'not-object' }] })
})

test('L1 参数面：值的错误码区分类型/范围/格式', () => {
  assert.equal(checkValue('context.injectBudgetKb', 'x').code, 'bad-type')
  assert.equal(checkValue('context.injectBudgetKb', 0).code, 'out-of-range')
  assert.equal(checkValue('model.preferred', 'a b').code, 'bad-format')
  assert.equal(checkValue('nope', 1).code, 'unknown-key')
  assert.deepEqual(checkValue('model.preferred', null), { ok: true })
})

test('L1 参数面：applyPatch 只写登记键，其它字段原样带过去（绝不清凭据）', () => {
  const cfg = {
    activeProvider: 'deepseek',
    providers: [{ id: 'deepseek', apiKeyRef: 'vault:deepseek' }],
    network: { provider: true },
    context: { injectBudgetKb: 96, other: 'keep-me' },
  }
  const r = applyPatch(cfg, { 'context.injectBudgetKb': 128 })
  assert.equal(r.ok, true)
  assert.equal(r.config.context.injectBudgetKb, 128)
  assert.equal(r.config.context.other, 'keep-me', '同一节里的其它键必须保留')
  assert.equal(r.config.activeProvider, 'deepseek')
  assert.deepEqual(r.config.providers, cfg.providers)
  assert.deepEqual(r.config.network, { provider: true })
  assert.equal(cfg.context.injectBudgetKb, 96, '入参不得被改（快照/回滚要用原值）')
})

test('L1 参数面：applyPatch 拒绝坏补丁且不产生半截配置', () => {
  const r = applyPatch({}, { 'context.injectBudgetKb': 1, 'model.preferred': 'ok' })
  assert.equal(r.ok, false)
  assert.equal(r.config, undefined)
  assert.deepEqual(r.errors, [{ key: 'context.injectBudgetKb', code: 'out-of-range' }])
})

test('L1 参数面：声明表带范围/说明（界面与文档同源）', () => {
  const rows = paramDescs()
  assert.equal(rows.length, 2)
  const budget = rows.find((r) => r.key === 'context.injectBudgetKb')
  assert.equal(budget.type, 'number')
  assert.equal(budget.min, 8)
  assert.equal(budget.max, 512)
  assert.ok(String(budget.desc).length > 10)
  assert.deepEqual(Object.keys(L1_PARAMS).sort(), ['context.injectBudgetKb', 'model.preferred'])
})

// ── P4：模型优先级（唯一实现）与"能不能生效"的如实披露 ────────────────────────
test('P4 模型优先级：--model > preferred > provider > settings', () => {
  const all = { arg: 'arg-m', preferred: 'pref-m', providerModel: 'prov-m', settingsModel: 'set-m' }
  assert.equal(pickModel(all), 'arg-m')
  assert.equal(pickModel({ ...all, arg: null }), 'pref-m', '★ preferred 必须高于 provider.model，否则"改首选模型"永远不生效')
  assert.equal(pickModel({ ...all, arg: '', preferred: undefined }), 'prov-m')
  assert.equal(pickModel({ arg: '  ', preferred: null, providerModel: '', settingsModel: 'set-m' }), 'set-m')
  assert.equal(pickModel({}), '', '全空 ⇒ 空串（让上层回落 provider 默认，而不是猜一个模型）')
})

test('P4 参数面：每个参数都披露 consumer（pending = 改了不会改变行为）', () => {
  const rows = paramDescs()
  assert.equal(typeof rows.find((r) => r.key === 'model.preferred').consumer, 'string')
  assert.match(String(rows.find((r) => r.key === 'model.preferred').consumer), /cli\.mjs/)
  assert.match(String(rows.find((r) => r.key === 'context.injectBudgetKb').consumer), /atlas|注入块预算/,
    'P4 已接线：显式设置时覆盖 ProjectAtlas 注入块预算')
})

// ── P4 闭环：候选 → 参数补丁（只对**有消费方**的参数出补丁）──────────────────────
test('P4 候选→补丁：OPP-12 清空偏好；不猜"哪个模型更好"', () => {
  const r = suggestPatchFromCandidate({ ruleId: 'OPP-12', subject: 'm-bad' }, { currentPreferred: 'm-bad' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.patch, { 'model.preferred': null }, '只清空偏好，回到跟随 provider')
  assert.match(r.rationale, /m-bad/)
})

test('P4 候选→补丁：没设过偏好 / 候选说的不是当前偏好 ⇒ 不出补丁（不猜）', () => {
  assert.equal(suggestPatchFromCandidate({ ruleId: 'OPP-12', subject: 'x' }, { currentPreferred: null }).reason, 'no-preference-set')
  assert.equal(suggestPatchFromCandidate({ ruleId: 'OPP-12', subject: 'x' }, { currentPreferred: 'y' }).reason, 'subject-is-not-preferred')
})

test('★ P4 候选→补丁：OPP-11 拒绝出补丁（consumer 尚未接线，改了不改变行为）', () => {
  const r = suggestPatchFromCandidate({ ruleId: 'OPP-11' }, {})
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /consumer-pending/)
})

test('P4 候选→补丁：非参数类规则 ⇒ not-a-param-rule', () => {
  assert.equal(suggestPatchFromCandidate({ ruleId: 'OPP-7' }, {}).reason, 'not-a-param-rule')
})

// ── P4 消费方接线：只认「显式设置」，默认值不许改变既有行为 ─────────────────────
test('P4 explicitParams：只返回用户在 config.json 里真写下的键', () => {
  assert.deepEqual(explicitParams({}), {}, '空配置 ⇒ 一个都不算显式设置')
  assert.deepEqual(explicitParams({ context: { injectBudgetKb: 128 } }), { 'context.injectBudgetKb': 128 })
  assert.deepEqual(explicitParams({ model: { preferred: 'm1' } }), { 'model.preferred': 'm1' })
})

test('P4 explicitParams：非法值当作"没设置"（回落默认，不是崩掉也不是硬用）', () => {
  assert.deepEqual(explicitParams({ context: { injectBudgetKb: '128' } }), {}, '字符串不是合法数字')
  assert.deepEqual(explicitParams({ context: { injectBudgetKb: 9999 } }), {}, '超上限')
  assert.deepEqual(explicitParams({ context: { injectBudgetKb: 1 } }), {}, '低于下限')
  assert.deepEqual(explicitParams({ model: { preferred: '  ' } }), {}, '空白串')
})

test('P4：默认值不等于"已设置" —— 这条是"没人改 = 行为不变"的机械保证', () => {
  const resolved = resolveParams({})
  assert.equal(resolved['context.injectBudgetKb'], 96, '默认值仍在（给人看/给界面显示）')
  assert.equal('context.injectBudgetKb' in explicitParams({}), false, '但绝不能被当成"用户显式设置"去覆盖既有预算链')
})

// ── P4 消费方：注入块预算判定（显式 > 既有预算链；lane 半额且不超主预算）───────────
test('P4 注入预算：未显式设置 ⇒ 逐字沿用既有预算链（行为不变）', () => {
  assert.equal(atlasBudgetBytes({ fallbackBytes: 6144 }), 6144)
  assert.equal(atlasBudgetBytes({ fallbackBytes: 6144, lane: true, laneFallbackBytes: 4096 }), 4096)
})

test('P4 注入预算：显式设置 ⇒ 覆盖；lane 取半额且不超主预算', () => {
  assert.equal(atlasBudgetBytes({ explicitKb: 128, fallbackBytes: 6144 }), 131072)
  assert.equal(atlasBudgetBytes({ explicitKb: 128, fallbackBytes: 6144, lane: true, laneFallbackBytes: 4096 }), 65536)
  // 用户把主预算调得很小 ⇒ lane 不得反过来比主预算还大
  assert.equal(atlasBudgetBytes({ explicitKb: 8, fallbackBytes: 6144, lane: true, laneFallbackBytes: 40960 }), 8192)
})
