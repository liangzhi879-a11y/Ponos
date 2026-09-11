import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseYaml, loadWorkflow, validateWorkflow, normalizeWorkflow, DSL_VERSION } from '../kernel/workflow-dsl.mjs'

const GOOD = `name: demo
version: 1.0.0
triggers: [演示]
settings: { max_parallel: 4 }
trigger_config: { manual: true, webhook: false }
inputs:
  - { name: q, type: string, required: true, description: 问题 }
nodes:
  - { id: start, type: start, label: 开始, position: {x: 0, y: 0} }
  - id: ask
    type: llm
    label: 生成
    config: { prompt: "回答：{{inputs.q}}" }
    retry: { max: 2, delay_ms: 500, on_error: fail }
  - { id: done, type: end, label: 结束, config: { outputs: [{ name: text, selector: "{{ask}}" }] } }
edges:
  - { id: e1, source: start, target: ask }
  - { id: e2, source: ask, target: done }
`

function withFile(content, fn) {
  const root = mkdtempSync(join(tmpdir(), 'wf-dsl-'))
  try {
    mkdirSync(join(root, 'demo'), { recursive: true })
    writeFileSync(join(root, 'demo', 'workflow.yml'), content, 'utf-8')
    return fn(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('DSL v2：加载后 config 摊平、edges 保留、校验通过', () => {
  withFile(GOOD, (root) => {
    const wf = loadWorkflow({ roots: [root], id: 'demo' })
    assert.equal(wf.dslVersion, DSL_VERSION)
    const ask = wf.nodes.find((n) => n.id === 'ask')
    assert.equal(ask.prompt, '回答：{{inputs.q}}', 'config.prompt 应摊平到节点')
    assert.equal(ask.retry.max, 2, 'retry 留在节点顶层')
    assert.equal(ask.config, undefined, 'config 键应被消费掉')
    assert.equal(wf.edges.length, 2)
    const v = validateWorkflow(wf)
    assert.deepEqual(v.errors, [], `不应有错误：${JSON.stringify(v.errors)}`)
  })
})

test('校验器：缺 edges → LEGACY_DSL', () => {
  const legacy = GOOD.replace(/edges:[\s\S]*$/, '')
  const wf = normalizeWorkflow(parseYaml(legacy))
  const v = validateWorkflow(wf)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.code === 'LEGACY_DSL'))
})

test('校验器：环 / 悬空边 / 重复 id / 缺 start', () => {
  const cyc = normalizeWorkflow({ nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'llm' }], edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }] })
  assert.ok(validateWorkflow(cyc).errors.some((e) => e.code === 'CYCLE'))

  const dang = normalizeWorkflow({ nodes: [{ id: 'a', type: 'start' }], edges: [{ id: 'e1', source: 'a', target: 'nope' }] })
  assert.ok(validateWorkflow(dang).errors.some((e) => e.code === 'DANGLING_EDGE'))

  const dup = normalizeWorkflow({ nodes: [{ id: 'a', type: 'start' }, { id: 'a', type: 'end' }], edges: [] })
  assert.ok(validateWorkflow(dup).errors.some((e) => e.code === 'DUP_NODE_ID'))

  const nostart = normalizeWorkflow({ nodes: [{ id: 'a', type: 'llm' }], edges: [] })
  assert.ok(validateWorkflow(nostart).errors.some((e) => e.code === 'NO_START'))
})

test('校验器：body 越界与跨子图边', () => {
  const wf = normalizeWorkflow({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'lp', type: 'loop', body: ['body1', 'ghost'] },
      { id: 'body1', type: 'llm', prompt: 'x' },
      { id: 'done', type: 'end' },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'lp' },
      { id: 'e2', source: 'lp', target: 'done' },
      { id: 'e3', source: 'body1', target: 'done' },
    ],
  })
  const codes = validateWorkflow(wf).errors.map((e) => e.code)
  assert.ok(codes.includes('BODY_MEMBER_MISSING'), `应报 body 成员不存在：${codes}`)
  assert.ok(codes.includes('BODY_ESCAPE'), `应报跨子图边：${codes}`)
})
