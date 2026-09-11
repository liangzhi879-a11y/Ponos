// workflow-serialize：serializeWorkflow / toModel 双向（画布 → YAML → 模型）。
// 契约：serialize 统一过 toModel（不靠启发式判断输入形态，否则静默丢 config）；
// toModel 幂等；输出稳定（同输入两次字节等价）；config 重新收拢为 `config:` 块。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeWorkflow, toModel, parseYaml, normalizeWorkflow, validateWorkflow } from '../kernel/workflow-dsl.mjs'

const MODEL = {
  name: 'demo', description: '演示', version: '1.0.0', triggers: ['演示'],
  trigger_config: { manual: true, webhook: false },
  settings: { max_parallel: 4 },
  inputs: [{ name: 'q', type: 'string', required: true, description: '问题' }],
  nodes: [
    { id: 'start', type: 'start', label: '开始', position: { x: 0, y: 0 } },
    { id: 'ask', type: 'llm', label: '生成', position: { x: 240, y: 0 }, prompt: '回答：{{inputs.q}}', retry: { max: 2, delay_ms: 500, on_error: 'fail' } },
    { id: 'done', type: 'end', label: '结束', position: { x: 480, y: 0 }, outputs: [{ name: 'text', selector: '{{ask}}' }] },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'ask' }, { id: 'e2', source: 'ask', target: 'done' }],
  expose: { mode: 'public', tool_name: 'run_demo' },
  permissions: { tools: ['Read'], network: false },
}

test('serialize → parse 往返：模型语义不变', () => {
  const yml = serializeWorkflow(MODEL)
  assert.match(yml, /^name: demo$/m)
  assert.match(yml, /^edges:$/m)
  const back = normalizeWorkflow(parseYaml(yml))
  assert.equal(back.nodes.find((n) => n.id === 'ask').prompt, '回答：{{inputs.q}}', 'config 摊平后应还原')
  assert.deepEqual(back.edges.map((e) => `${e.source}->${e.target}`), ['start->ask', 'ask->done'])
  assert.equal(back.expose.mode, 'public')
  assert.deepEqual(validateWorkflow(back).errors, [])
})

test('toModel：node 的非配置字段不进 config（label/position/retry 保持顶层）', () => {
  const wf = normalizeWorkflow(parseYaml(serializeWorkflow(MODEL)))
  const m = toModel(wf)
  const ask = m.nodes.find((n) => n.id === 'ask')
  assert.equal(ask.label, '生成')
  assert.deepEqual(ask.position, { x: 240, y: 0 })
  assert.equal(ask.retry.max, 2)
  const yml2 = serializeWorkflow(m)
  assert.match(yml2, /label: 生成/)
  assert.match(yml2, /position: \{x: 240, y: 0\}/)
})

test('serialize 稳定性 + 幂等（已是模型形态时不丢 config）', () => {
  assert.equal(serializeWorkflow(MODEL), serializeWorkflow(MODEL))
  // 幂等：把 toModel 的产物再喂回去，config 必须原样保留
  const once = toModel(MODEL)
  const twice = toModel(once)
  assert.deepEqual(twice.nodes.find((n) => n.id === 'ask').config, once.nodes.find((n) => n.id === 'ask').config)
  assert.match(serializeWorkflow(once), /prompt: 回答：\{\{inputs\.q\}\}/)
})
