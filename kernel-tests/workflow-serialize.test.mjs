// workflow-serialize：serializeWorkflow / toModel 双向（画布 → YAML → 模型）。
// 契约：serialize 统一过 toModel（不靠启发式判断输入形态，否则静默丢 config）；
// toModel 幂等；输出稳定（同输入两次字节等价）；config 重新收拢为 `config:` 块。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeWorkflow, toModel, parseYaml, normalizeWorkflow, validateWorkflow, discoverWorkflows } from '../kernel/workflow-dsl.mjs'

function withYml(content, fn) {
  const root = mkdtempSync(join(tmpdir(), 'wf-trig-'))
  try {
    mkdirSync(join(root, 'demo'), { recursive: true })
    writeFileSync(join(root, 'demo', 'workflow.yml'), content, 'utf-8')
    return fn(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

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
  // 含 `{}` 的值必加引号（流式上下文中 `{{...}}` 是括号，裸写会被当嵌套结构）
  assert.match(serializeWorkflow(once), /prompt: "回答：\{\{inputs\.q\}\}"/)
})

// —— 复杂值往返（C1/C2）：ASCII 逗号、中文引号、`{{inputs.x}}`、换行、Windows 路径、
// 含 `:` 与 `#` 的值、数字/布尔型字符串、空容器、嵌套对象 —— 一次性踩完引号与转义。
const PROMPT = '你好：「世界」, 第二行\n{{inputs.q}} 与 #注释, 结尾\nWindows 路径 D:\\a\\b\n含冒号: 值\t尾 '
const COMPLEX = {
  name: 'complex, demo', description: 'a: b # c', version: '2.0.0',
  triggers: ['每日报表', 'a,b', ' 留白 '],
  trigger_config: { manual: true, note: 'x, y' },
  settings: { max_parallel: 4, flags: [], env: {} },
  inputs: [{ name: 'q', type: 'string', required: true, description: '问题, 含逗号' }],
  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    { id: 'ask', type: 'llm', label: '逗号, 与「引号」', position: { x: 240, y: 0 }, prompt: PROMPT,
      note: 'a: b', answer: 'say "hi", ok', path: 'D:\\a\\b', num: '42', boolText: 'true', empty: '',
      retry: { max: 2, delay_ms: 500, on_error: 'fail' },
      http: { url: 'http://x/?a=1,2', headers: { 'X-Test': 'a: b', 'X,Comma': '[x]' } },
      tags: [], opts: {},
      outputs: [{ name: 'text', selector: '{{ask}}' }] },
    { id: 'done', type: 'end', label: '结束', position: { x: 480, y: 0 } },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'ask' }, { id: 'e2', source: 'ask', target: 'done' }],
  expose: { mode: 'public', tool_name: 'run_demo' },
  permissions: { tools: ['Read'], network: false },
}

test('serialize → parse 往返：复杂值深比较（逗号/引号/换行/路径/冒号井号/空容器）', () => {
  const yml = serializeWorkflow(COMPLEX)
  const back = normalizeWorkflow(parseYaml(yml))
  assert.deepEqual(back, normalizeWorkflow(COMPLEX), `往返失真：\n${yml}`)
  const ask = back.nodes.find((n) => n.id === 'ask')
  assert.equal(ask.prompt, PROMPT, '多行 prompt 的换行必须还原（非字面 \\n）')
  assert.equal(ask.answer, 'say "hi", ok')
  assert.equal(ask.path, 'D:\\a\\b', 'Windows 路径的反斜杠必须还原')
  assert.equal(ask.note, 'a: b')
  assert.equal(ask.num, '42', '数字型字符串不得被解析成数字')
  assert.equal(ask.boolText, 'true', '布尔型字符串不得被解析成布尔')
  assert.equal(ask.empty, '')
  assert.deepEqual(ask.http, { url: 'http://x/?a=1,2', headers: { 'X-Test': 'a: b', 'X,Comma': '[x]' } })
  assert.deepEqual(ask.tags, [])
  assert.deepEqual(ask.opts, {})
  assert.deepEqual(back.edges.map((e) => `${e.source}->${e.target}`), ['start->ask', 'ask->done'])
  assert.deepEqual(validateWorkflow(back).errors, [])
})

test('serialize → parse 往返：空数组/空对象不丢型（I2）', () => {
  const model = { name: 'empty', trigger_config: {}, settings: {}, inputs: [], nodes: [{ id: 'a', type: 'start' }], edges: [] }
  const yml = serializeWorkflow(model)
  assert.match(yml, /^inputs: \[\]$/m)
  assert.match(yml, /^edges: \[\]$/m)
  const back = normalizeWorkflow(parseYaml(yml))
  assert.deepEqual(back.inputs, [], 'inputs: [] 须还原为数组')
  assert.deepEqual(back.edges, [], 'edges: [] 须还原为数组（裸 `edges:` 会被解析成 {} → LEGACY_DSL）')
  assert.deepEqual(back.settings, {})
  assert.deepEqual(validateWorkflow(back).errors.filter((e) => e.code === 'LEGACY_DSL'), [])
})

// ---------- 触发开关持久化链（2026-10-09 发布 UX 线）：trigger_config.auto_trigger ----------
// GUI 发布对话框把触发开关写进 `trigger_config.auto_trigger`（保留其它键，见 setAutoTrigger）；
// 内核读回口径 = trigCfg.auto_trigger === true || 顶层平铺 auto_trigger === true（见
// discoverWorkflows）。本测试钉整链（serialize → parse → discover），GUI/服务端 meta 沿此口径对齐。

test('触发开关链：auto_trigger 经 serialize→parse→discover 恒可达（含严格 === true 与非命中负例）', () => {
  // ① 模型（GUI 发布对话框产物）→ YAML：开关在 trigger_config 内，其它键整包保真
  const model = {
    name: 'trig', triggers: ['日报'],
    trigger_config: { manual: true, auto_trigger: true, schedule: '0 9 * * *' },
    nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'end' }],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
  }
  const yml = serializeWorkflow(model)
  const back = normalizeWorkflow(parseYaml(yml))
  assert.deepEqual(back.trigger_config, { manual: true, auto_trigger: true, schedule: '0 9 * * *' },
    'trigger_config 整包往返（auto_trigger 不得挤掉/覆盖其它键）')
  // ② 落盘文件 → discover 读回（内核触发面的消费口径）
  withYml(yml, (root) => {
    const list = discoverWorkflows({ root })
    assert.equal(list.length, 1)
    assert.equal(list[0].autoTrigger, true, 'trigger_config.auto_trigger=true 必须被 discover 读回')
    assert.deepEqual(list[0].triggers, ['日报'], '触发词同链读回')
  })
  // ③ 块式 trigger_config（YAML 直写形态）：同一读回口径
  const block = 'name: t\ntrigger_config:\n  manual: true\n  auto_trigger: true\nnodes: [{ id: a, type: start }, { id: b, type: end }]\nedges: [{ id: e1, source: a, target: b }]\n'
  withYml(block, (root) => {
    assert.equal(discoverWorkflows({ root })[0].autoTrigger, true, '块式 trigger_config 同样读回')
  })
  // ④ 负例：false / 字符串 "true" / 数字 1 / 缺省 —— 严格 === true，勿放宽
  for (const frag of ['auto_trigger: false', 'auto_trigger: "true"', 'auto_trigger: 1', '']) {
    const text = `name: t\ntrigger_config: { manual: true${frag ? ', ' + frag : ''} }\nnodes: [{ id: a, type: start }, { id: b, type: end }]\nedges: [{ id: e1, source: a, target: b }]\n`
    withYml(text, (root) => {
      assert.equal(discoverWorkflows({ root })[0].autoTrigger, false, `不应命中：${frag || '缺省'}`)
    })
  }
  // ⑤ legacy 平铺回退：旧文件顶层 `auto_trigger: true`（无 trigger_config）仍须读回 true
  //    （migrateLegacy 之前的形态；GUI 侧 foldLegacyAutoTrigger 负责打开时归一，两侧不得说反话）
  const legacy = 'name: t\nauto_trigger: true\nnodes: [{ id: a, type: start }, { id: b, type: end }]\nedges: [{ id: e1, source: a, target: b }]\n'
  withYml(legacy, (root) => {
    assert.equal(discoverWorkflows({ root })[0].autoTrigger, true, '顶层平铺 auto_trigger 回退不得失效')
  })
})
