// K3.1 思考策略判据表（纯函数）+ 「只降不升」不变量
// ---------------------------------------------------------------------------
// 本文件只测判据本身（不碰网络）。判据真的换到了请求字段上，由 effort-wire.test.mjs
// 用本地 http server 抓真实请求体验证——两层分开，改判据不会掩盖接线错误，反之亦然。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_EFFORT_POLICY, EFFORT_POLICIES, effortPolicyFromEnv, pickStepThinking, resolveEffortPolicy,
} from '../kernel/effort-policy.mjs'

test('resolveEffortPolicy：合法值原样、别名归一、未知与空走默认，绝不抛', () => {
  assert.deepEqual(EFFORT_POLICIES, ['graded', 'off'])
  assert.equal(DEFAULT_EFFORT_POLICY, 'graded', '用户 2026-09-13 决策：默认开启（只降摘要步）')
  for (const v of EFFORT_POLICIES) assert.equal(resolveEffortPolicy(v), v)
  // 别名/误写 → 唯一语义（不静默变成另一个意思）
  for (const v of ['on', 'true', '1', 'enabled', ' Graded ', 'OFF']) {
    assert.ok(EFFORT_POLICIES.includes(resolveEffortPolicy(v)), `${v} 应归一到合法值`)
  }
  assert.equal(resolveEffortPolicy('disabled'), 'off')
  assert.equal(resolveEffortPolicy('none'), 'off')
  assert.equal(resolveEffortPolicy('0'), 'off')
  // 未知值 → 默认（静默降级是内核契约，不得抛）
  for (const v of ['', '   ', null, undefined, 'yolo', '3']) {
    assert.equal(resolveEffortPolicy(v), DEFAULT_EFFORT_POLICY, `${JSON.stringify(v)} 应回落默认`)
  }
})

test('pickStepThinking：graded 只降摘要/压缩步，常规步与审计步维持现状', () => {
  assert.equal(pickStepThinking({ kind: 'summary', policy: 'graded' }), 'off')
  for (const kind of ['step', 'audit', 'anything', undefined]) {
    assert.equal(pickStepThinking({ kind, policy: 'graded' }), 'on', `${kind} 不得被降档`)
  }
})

test('pickStepThinking：policy=off 时策略完全不干预（任何 kind 都是 on）', () => {
  for (const kind of ['summary', 'step', 'audit', undefined]) {
    assert.equal(pickStepThinking({ kind, policy: 'off' }), 'on', `回退开关下 ${kind} 也不得干预`)
  }
})

test('懒读 env：模块求值之后注入 PONOS_EFFORT_POLICY 必须生效（settings.env 通道）', () => {
  // cli.mjs 的 settings.env 注入发生在所有 ESM 模块求值之后（本文件顶部已 import）⇒
  // 写成模块级常量必然拿不到。这条锁死懒读，回退开关才真的能一键生效。
  const saved = process.env.PONOS_EFFORT_POLICY
  try {
    delete process.env.PONOS_EFFORT_POLICY
    assert.equal(effortPolicyFromEnv(), 'graded')
    assert.equal(pickStepThinking({ kind: 'summary' }), 'off', '默认应降摘要步')
    process.env.PONOS_EFFORT_POLICY = 'off'
    assert.equal(effortPolicyFromEnv(), 'off')
    assert.equal(pickStepThinking({ kind: 'summary' }), 'on', '注入后必须立即改判（懒读）')
  } finally {
    if (saved === undefined) delete process.env.PONOS_EFFORT_POLICY
    else process.env.PONOS_EFFORT_POLICY = saved
  }
})

test('不变量：只降不升 —— 返回值只有 on/off，且 summary 是唯一的 off 来源', () => {
  const kinds = ['summary', 'step', 'audit', 'lane', 'compact', 'workflow-node', undefined, null, '未知种类']
  for (const policy of EFFORT_POLICIES) {
    for (const kind of kinds) {
      const v = pickStepThinking({ kind, policy })
      assert.ok(v === 'on' || v === 'off', `必须二值，实际 ${JSON.stringify(v)}`)
      if (v === 'off') assert.equal(kind, 'summary', `只有摘要步可能是 off，实际 kind=${kind}`)
    }
  }
  // 'on' 的语义是「不干预」：策略不产生任何"强制开思考"的返回值 ⇒ 不可能把用户关掉的
  // 思考打开（用户 off 档由 api.effortParam 的 ① 分支独立生效，优先级更高）。
  assert.equal(pickStepThinking({ kind: 'summary', policy: 'off' }), 'on')
})
