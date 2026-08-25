// workflow 引擎测试：loop/iterate 子图语义 + 审计链 + 事件
// 覆盖：基本循环 / break_conditions / while_conditions / 动态 count /
//       body 分支聚合（B1）/ 动态次数（B2）/ body 节点不误执行（B3）/
//       continue_on_error / max_duration_ms / body 事件 / 嵌套 loop / iterate 并行
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWorkflowEngine, discoverWorkflows, matchAutoTrigger } from '../kernel/workflow.mjs'

process.env.PONOS_MOCK_API = '1'

const MOCK_REGISTRY = {
  run: async () => ({ content: '(fake)', isError: true }),
  toolSchemas: () => [],
}

function makeEngine({ configDir, registry = MOCK_REGISTRY, onEvent } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-wf-'))
  const wfRoot = path.join(home, 'wf')
  const cfg = configDir || path.join(home, 'cfg')
  fs.mkdirSync(wfRoot, { recursive: true })
  const eng = createWorkflowEngine({ configDir: cfg, registry, onEvent })
  eng.addRoot(wfRoot)
  const add = (id, yaml) => {
    const dir = path.join(wfRoot, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'workflow.yml'), yaml, 'utf-8')
  }
  return { eng, add, home, cfg }
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ===================== 基础循环语义 =====================

test('loop：固定次数顺序执行，results 聚合每轮末节点输出', async () => {
  const { eng, add, home } = makeEngine()
  try {
    add('basic', `name: basic
nodes:
  - id: start
    type: start
  - id: lp
    type: loop
    count: 3
    body: [tpl]
  - id: tpl
    type: template
    template: 轮次{{iter}}@{{index}}
  - id: end
    type: end
    outputs:
      - name: results
        selector: lp.results
      - name: iterations
        selector: lp.iterations
      - name: broken
        selector: lp.broken
`)
    const r = await eng.run({ id: 'basic', inputs: {} })
    assert.equal(r.ok, true, r.error)
    const o = r.outputs.end.output
    assert.deepEqual(o.results, ['轮次0@0', '轮次1@1', '轮次2@2'])
    assert.equal(o.iterations, 3)
    assert.equal(o.broken, false)
    assert.equal(r.steps, 3, 'start/lp/end 三个主链节点，body 节点不被主循环执行')
  } finally { cleanup(home) }
})

test('loop：break_conditions 提前终止', async () => {
  const { eng, add, home } = makeEngine()
  try {
    add('brk', `name: brk
nodes:
  - id: start
    type: start
  - id: lp
    type: loop
    count: 10
    body: [judge]
    break_conditions:
      - var: judge
        op: is
        value: done
  - id: judge
    type: code
    variables:
      - variable: iter
        selector: iter
    code: "function main(inputs){ return Number(inputs.iter) >= 2 ? 'done' : 'cont' }"
  - id: end
    type: end
    outputs:
      - name: iterations
        selector: lp.iterations
      - name: broken
        selector: lp.broken
`)
    const r = await eng.run({ id: 'brk', inputs: {} })
    assert.equal(r.ok, true, r.error)
    const o = r.outputs.end.output
    assert.equal(o.iterations, 3, '第 3 轮（iter=2）判定 done → 提前终止')
    assert.equal(o.broken, true)
  } finally { cleanup(home) }
})

test('loop：body 内 if 路由到分支节点，聚合取实际执行末节点（B1 回归）', async () => {
  const { eng, add, home } = makeEngine()
  try {
    add('ifagg', `name: ifagg
nodes:
  - id: start
    type: start
  - id: lp
    type: loop
    count: 2
    body: [judge, br]
  - id: judge
    type: template
    template: "{{iter}}"
  - id: br
    type: if
    conditions:
      - var: judge
        op: is
        value: "0"
    next_true: br_a
    next_false: br_b
  - id: br_a
    type: template
    template: A-{{iter}}
  - id: br_b
    type: template
    template: B-{{iter}}
  - id: end
    type: end
    outputs:
      - name: results
        selector: lp.results
`)
    const r = await eng.run({ id: 'ifagg', inputs: {} })
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(r.outputs.end.output.results, ['A-0', 'B-1'], '分支节点输出而非 if 的 pass 判定')
  } finally { cleanup(home) }
})

test('loop：动态 count 支持模板变量（B2 回归）', async () => {
  const { eng, add, home } = makeEngine()
  try {
    add('dync', `name: dync
nodes:
  - id: start
    type: start
  - id: lp
    type: loop
    count: "{{inputs.n}}"
    body: [tpl]
  - id: tpl
    type: template
    template: 轮次{{iter}}
  - id: end
    type: end
    outputs:
      - name: iterations
        selector: lp.iterations
`)
    const r = await eng.run({ id: 'dync', inputs: { n: 4 } })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.outputs.end.output.iterations, 4, 'count 由 inputs.n 渲染为 4')
  } finally { cleanup(home) }
})

test('loop：body 节点不被主循环误执行（B3 回归）', async () => {
  const { eng, add, home } = makeEngine()
  try {
    add('accum', `name: accum
nodes:
  - id: start
    type: start
  - id: lp
    type: loop
    count: 3
    body: [acc]
  - id: acc
    type: assign
    items:
      - variable: acc_list
        value: iter
        operation: append
  - id: end
    type: end
    outputs:
      - name: acc
        selector: var.acc_list
`)
    const r = await eng.run({ id: 'accum', inputs: {} })
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(r.outputs.end.output.acc, [0, 1, 2], '恰好 3 轮 append，无顶层误执行追加 undefined')
  } finally { cleanup(home) }
})

test('loop：while_conditions 轮前检查，不满足立即终止', async () => {
  const { eng, add, home } = makeEngine()
  try {
    add('while', `name: while
nodes:
  - id: start
    type: start
  - id: init
    type: assign
    items:
      - variable: left
        selector: inputs.left
  - id: lp
    type: loop
    count: 100
    body: [dec, save]
    while_conditions:
      - var: var.left
        op: ">"
        value: 0
  - id: dec
    type: code
    variables:
      - variable: left
        selector: var.left
    code: "function main(inputs){ return { left: (Number(inputs.left)||0) - 1 } }"
  - id: save
    type: assign
    items:
      - variable: left
        selector: dec.left
  - id: end
    type: end
    outputs:
      - name: iterations
        selector: lp.iterations
`)
    const r = await eng.run({ id: 'while', inputs: { left: 3 } })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.outputs.end.output.iterations, 3, 'left 从 3 递减，3 轮后 while 不满足终止')
  } finally { cleanup(home) }
})

test('loop：continue_on_error 单轮失败记录 __error 继续', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-wf-'))
  const wfRoot = path.join(home, 'wf')
  fs.mkdirSync(wfRoot, { recursive: true })
  let calls = 0
  const registry = {
    run: async ({ name }) => {
      if (name === 'Boom') { calls++; if (calls === 1) throw new Error('首轮爆炸') }
      return { content: `ok-${calls}`, isError: false }
    },
    toolSchemas: () => [],
  }
  try {
    const eng = createWorkflowEngine({ configDir: path.join(home, 'cfg'), registry })
    eng.addRoot(wfRoot)
    const dir = path.join(wfRoot, 'cont')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'workflow.yml'), `name: cont
nodes:
  - id: start
    type: start
  - id: lp
    type: loop
    count: 2
    continue_on_error: true
    body: [t]
  - id: t
    type: tool
    tool: Boom
    input: {}
  - id: end
    type: end
    outputs:
      - name: results
        selector: lp.results
`, 'utf-8')
    const r = await eng.run({ id: 'cont', inputs: {} })
    assert.equal(r.ok, true, r.error)
    const results = r.outputs.end.output.results
    assert.equal(results.length, 2, '两轮都执行')
    assert.ok(results[0].__error && results[0].__error.includes('首轮爆炸'), '首轮失败被记录')
    assert.equal(results[1].__error, undefined, '次轮成功')
  } finally { cleanup(home) }
})

test('loop：max_duration_ms 整循环时间预算', async () => {
  const { eng, add, home } = makeEngine()
  try {
    add('budget', `name: budget
nodes:
  - id: start
    type: start
  - id: lp
    type: loop
    count: 100
    max_duration_ms: 40
    body: [tpl]
  - id: tpl
    type: code
    code: "function main(){ const t = Date.now(); while (Date.now() - t < 25) {} return 1 }"
  - id: end
    type: end
    outputs:
      - name: iterations
        selector: lp.iterations
`)
    const r = await eng.run({ id: 'budget', inputs: {} })
    assert.equal(r.ok, true, r.error)
    const it = r.outputs.end.output.iterations
    assert.ok(it >= 1 && it <= 3, `预算 40ms、单轮 25ms → 约 1-2 轮，实际 ${it}`)
  } finally { cleanup(home) }
})

// ===================== iterate =====================

test('iterate：数组迭代 + 每项 item/index 注入', async () => {
  const { eng, add, home } = makeEngine()
  try {
    add('it', `name: it
nodes:
  - id: start
    type: start
  - id: it
    type: iterate
    iterable: inputs.items
    body: [tpl]
  - id: tpl
    type: template
    template: 项{{item}}@{{index}}
  - id: end
    type: end
    outputs:
      - name: out
        selector: it
`)
    const r = await eng.run({ id: 'it', inputs: { items: ['甲', '乙', '丙'] } })
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(r.outputs.end.output.out, ['项甲@0', '项乙@1', '项丙@2'])
  } finally { cleanup(home) }
})

test('iterate：is_parallel 并行执行', async () => {
  const { eng, add, home } = makeEngine()
  try {
    add('itp', `name: itp
nodes:
  - id: start
    type: start
  - id: it
    type: iterate
    iterable: inputs.items
    is_parallel: true
    parallel_nums: 2
    body: [tpl]
  - id: tpl
    type: template
    template: 项{{item}}@{{index}}
  - id: end
    type: end
    outputs:
      - name: out
        selector: it
`)
    const r = await eng.run({ id: 'itp', inputs: { items: ['甲', '乙', '丙'] } })
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(r.outputs.end.output.out, ['项甲@0', '项乙@1', '项丙@2'])
  } finally { cleanup(home) }
})

// ===================== 嵌套与事件 =====================

test('loop：嵌套 loop（外层 body 含内层 loop）', async () => {
  const { eng, add, home } = makeEngine()
  try {
    add('nest', `name: nest
nodes:
  - id: start
    type: start
  - id: outer
    type: loop
    count: 2
    body: [inner]
  - id: inner
    type: loop
    count: 2
    body: [tpl]
  - id: tpl
    type: template
    template: "{{iter}}{{index}}"
  - id: end
    type: end
    outputs:
      - name: results
        selector: outer.results
`)
    const r = await eng.run({ id: 'nest', inputs: {} })
    assert.equal(r.ok, true, r.error)
    const results = r.outputs.end.output.results
    assert.equal(results.length, 2, '外层 2 轮')
    for (const round of results) {
      assert.ok(Array.isArray(round.results), '每轮为内层 loop 输出对象')
      assert.equal(round.results.length, 2, '内层 2 轮')
    }
  } finally { cleanup(home) }
})

test('loop：body 节点进度事件（in_body 标记）发出', async () => {
  const events = []
  const { eng, add, home } = makeEngine({ onEvent: (ev) => events.push(ev) })
  try {
    add('evt', `name: evt
nodes:
  - id: start
    type: start
  - id: lp
    type: loop
    count: 2
    body: [tpl]
  - id: tpl
    type: template
    template: 轮{{iter}}
  - id: end
    type: end
    outputs:
      - name: r
        selector: lp.results
`)
    const r = await eng.run({ id: 'evt', inputs: {} })
    assert.equal(r.ok, true, r.error)
    const bodyNodes = events.filter((e) => e.type === 'node' && e.in_body)
    assert.equal(bodyNodes.length, 2, '每轮 body 节点各发一次 node 事件')
    assert.ok(bodyNodes.every((e) => e.node === 'tpl' && e.status === 'done'))
  } finally { cleanup(home) }
})

test('审计：loop body 节点入哈希链，verifyRun 完整性可验', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-wf-'))
  const wfRoot = path.join(home, 'wf')
  fs.mkdirSync(wfRoot, { recursive: true })
  try {
    const eng = createWorkflowEngine({ configDir: path.join(home, 'cfg'), registry: MOCK_REGISTRY })
    eng.addRoot(wfRoot)
    const dir = path.join(wfRoot, 'aud')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'workflow.yml'), `name: aud
nodes:
  - id: start
    type: start
  - id: lp
    type: loop
    count: 2
    body: [tpl]
  - id: tpl
    type: template
    template: 轮{{iter}}
  - id: end
    type: end
    outputs:
      - name: r
        selector: lp.results
`, 'utf-8')
    const r = await eng.run({ id: 'aud', inputs: {} })
    assert.equal(r.ok, true, r.error)
    assert.ok(r.auditPath, '有审计路径')
    const v = eng.verify(r.auditPath)
    assert.equal(v.ok, true, `审计链完整：${JSON.stringify(v.tampered)}`)
    // start + lp + 2 轮 tpl + end = 5 条
    assert.equal(v.lines, 5)
  } finally { cleanup(home) }
})

// ===================== 自动触发（auto_trigger） =====================

test('discoverWorkflows：auto_trigger 字段解析', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-wf-'))
  const wfRoot = path.join(home, 'wf')
  fs.mkdirSync(path.join(wfRoot, 'on'), { recursive: true })
  fs.mkdirSync(path.join(wfRoot, 'off'), { recursive: true })
  try {
    fs.writeFileSync(path.join(wfRoot, 'on', 'workflow.yml'), 'name: on\nauto_trigger: true\ntriggers: [材料压缩]\nnodes:\n  - id: start\n    type: start\n', 'utf-8')
    fs.writeFileSync(path.join(wfRoot, 'off', 'workflow.yml'), 'name: off\ntriggers: [审计]\nnodes:\n  - id: start\n    type: start\n', 'utf-8')
    const wfs = discoverWorkflows({ root: wfRoot })
    const on = wfs.find((w) => w.id === 'on')
    const off = wfs.find((w) => w.id === 'off')
    assert.equal(on.autoTrigger, true, '显式 auto_trigger: true → 开启')
    assert.equal(off.autoTrigger, false, '未声明 → 默认关闭')
  } finally { cleanup(home) }
})

test('matchAutoTrigger：命中触发词返回工作流', () => {
  const wfs = [
    { id: 'a', autoTrigger: true, triggers: ['材料压缩'] },
    { id: 'b', autoTrigger: true, triggers: ['审计核对', '专审'] },
    { id: 'c', autoTrigger: false, triggers: ['成果转化'] },
  ]
  assert.equal(matchAutoTrigger(wfs, '帮我做材料压缩')?.id, 'a')
  assert.equal(matchAutoTrigger(wfs, '专审报告要核对')?.id, 'b')
  assert.equal(matchAutoTrigger(wfs, '成果转化材料'), null, 'auto_trigger=false 不触发')
  assert.equal(matchAutoTrigger(wfs, '你好'), null, '无触发词命中')
  assert.equal(matchAutoTrigger(wfs, ''), null, '空文本不触发')
})

test('matchAutoTrigger：触发词长度过滤（单字不触发）', () => {
  const wfs = [{ id: 'a', autoTrigger: true, triggers: ['审'] }]
  assert.equal(matchAutoTrigger(wfs, '审计'), null, '单字触发词被过滤')
})
