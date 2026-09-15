// 旧格式迁移器（kernel/workflow-dsl.mjs migrateLegacy）：
//   ① brief 三例：顺序补边 + if 双分支条件边 + 旧字段清理；trigger_config 收敛；classify route 边；
//   ② 确定性/幂等：同输入两次字节等价；已迁移结果再迁移不新增边；不改动入参对象；
//   ③ 真实样本形状（agent 节点 + loop body + if 双分支）：补边不得跨子图边界（BODY_ESCAPE 回归）；
//   ④ 内置 workflows/spec-dev/workflow.yml（仍为旧格式时）迁移后自校验通过（Task 8 重写后自动跳过）；
//   ⑤ kernel/workflow.mjs 兼容层已 re-export migrateLegacy。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrateLegacy, validateWorkflow, parseYaml, appendEdges, renderEdgesYaml, normalizeWorkflow } from '../kernel/workflow-dsl.mjs'

const LEGACY = {
  name: 'old', schedule: '0 18 * * 5', auto_trigger: true, triggers: ['日报'],
  nodes: [
    { id: 'start', type: 'start', next: 'gate' },
    { id: 'gate', type: 'if', conditions: [{ var: 'inputs.n', op: '>', value: 3 }], next_true: 'big', next_false: 'small' },
    { id: 'big', type: 'llm', prompt: '大' },
    { id: 'small', type: 'llm', prompt: '小' },
    { id: 'out', type: 'end', outputs: [{ name: 'r', selector: '{{big}}' }] },
  ],
}

test('迁移：数组顺序补边 + if 双分支条件边 + 旧字段清理', () => {
  const { workflow, notes } = migrateLegacy(LEGACY)
  const byPair = workflow.edges.map((e) => `${e.source}->${e.target}${e.sourceHandle ? ':' + e.sourceHandle : ''}`)
  assert.ok(byPair.includes('start->gate'), `顺序边缺失：${byPair}`)
  assert.ok(byPair.includes('gate->big:true'), `true 分支缺失：${byPair}`)
  assert.ok(byPair.includes('gate->small:false'), `false 分支缺失：${byPair}`)
  assert.ok(byPair.includes('big->out'), `big 顺序补边缺失：${byPair}`)
  assert.ok(byPair.includes('small->out'), `small 顺序补边缺失：${byPair}`)
  assert.equal(workflow.nodes.some((n) => 'next' in n || 'next_true' in n || 'next_false' in n), false)
  assert.ok(notes.length >= 3)
  assert.deepEqual(validateWorkflow(workflow).errors, [], '迁移结果必须自校验通过')
})

test('迁移：schedule/auto_trigger 收敛进 trigger_config 并删原字段', () => {
  const { workflow } = migrateLegacy(LEGACY)
  assert.equal(workflow.trigger_config.schedule, '0 18 * * 5')
  assert.equal(workflow.trigger_config.auto_trigger, true)
  assert.equal(workflow.schedule, undefined)
  assert.equal(workflow.auto_trigger, undefined)
})

test('迁移：classify routes → route:<i> 条件边', () => {
  const { workflow } = migrateLegacy({
    nodes: [
      { id: 'start', type: 'start', next: 'c' },
      { id: 'c', type: 'classify', classes: ['甲', '乙'], routes: ['a', 'b'] },
      { id: 'a', type: 'llm', prompt: 'A' },
      { id: 'b', type: 'llm', prompt: 'B' },
      { id: 'e', type: 'end' },
    ],
  })
  const pairs = workflow.edges.map((x) => `${x.source}->${x.target}${x.sourceHandle ? ':' + x.sourceHandle : ''}`)
  assert.ok(pairs.includes('c->a:route:0'), pairs.join(','))
  assert.ok(pairs.includes('c->b:route:1'), pairs.join(','))
  assert.deepEqual(validateWorkflow(workflow).errors, [], '迁移结果必须自校验通过')
})

test('迁移：条件分支目标不被当作顺延后继（否则分支会被串成假顺序链）', () => {
  const { workflow } = migrateLegacy(LEGACY)
  const pairs = workflow.edges.map((e) => `${e.source}->${e.target}`)
  assert.ok(!pairs.includes('big->small'), `分支节点间不应有顺序边：${pairs}`)
  const ids = workflow.edges.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length, '边 id 必须唯一')
})

test('迁移确定性：同输入两次字节等价 + 幂等 + 不改动入参', () => {
  const a = migrateLegacy(LEGACY)
  const b = migrateLegacy(LEGACY)
  assert.equal(JSON.stringify(a.workflow), JSON.stringify(b.workflow), '同输入必须字节等价')
  assert.equal(JSON.stringify(a.notes), JSON.stringify(b.notes))
  assert.equal(LEGACY.nodes[0].next, 'gate', '迁移不得改动入参（GUI 需保留原模型做备份）')
  assert.equal(LEGACY.schedule, '0 18 * * 5', '迁移不得删除入参上的旧字段')
  const again = migrateLegacy(a.workflow)
  assert.deepEqual(again.workflow.edges, a.workflow.edges, '已迁移结果再迁移不得新增/改动边')
  assert.deepEqual(validateWorkflow(again.workflow).errors, [])
})

// 真实样本形状（对齐 workflows/spec-dev/workflow.yml）：agent 节点 + loop(body) + if 双分支，
// loop 末位 body 成员显式 next: null —— 顺延规则若漏子图边界判断，这里会补出
// converge → done 的跨子图边（validateWorkflow 报 BODY_ESCAPE）。
const LEGACY_SHAPE = `name: legacy-shape
description: 真实样本形状（agent 节点 + loop body + if 双分支）
version: 1.0.0
triggers: 规格驱动
schedule: 0 18 * * 5
auto_trigger: true
inputs:
  - {name: requirement, type: string, required: true}
nodes:
  - id: start
    type: start
    next: check
  - id: check
    type: if
    conditions: [{var: inputs.requirement, op: not empty}]
    next_true: plan
    next_false: reject
  - id: plan
    type: agent
    prompt: |
      读 {{inputs.requirement}}，在 .yfw-spec 下写 plan.md
    max_iters: 10
    next: impl_loop
  - id: reject
    type: agent
    prompt: 说明为何拒绝并归档
    max_iters: 3
    next: done
  - id: impl_loop
    type: loop
    count: 3
    continue_on_error: false
    body: [implement, converge]
    break_conditions:
      - var: converge.text
        op: contains
        value: 已收敛
    next: done
  - id: implement
    type: agent
    prompt: 派 implementer 子 Agent 实现，再派 reviewer 审查
    max_iters: 20
    next: converge
  - id: converge
    type: agent
    prompt: 三方一致性检查；输出以「已收敛」或「未收敛」开头
    max_iters: 10
    next: null
  - id: done
    type: end
    outputs: [{name: r, selector: "{{plan}}"}]
`

test('迁移：真实样本形状（agent + loop body + if）不得补出跨子图边且自校验通过', () => {
  const { workflow } = migrateLegacy(parseYaml(LEGACY_SHAPE))
  const pairs = workflow.edges.map((e) => `${e.source}->${e.target}${e.sourceHandle ? ':' + e.sourceHandle : ''}`)
  for (const want of ['start->check', 'check->plan:true', 'check->reject:false', 'plan->impl_loop', 'reject->done', 'impl_loop->done', 'implement->converge']) {
    assert.ok(pairs.includes(want), `缺少 ${want}：${pairs}`)
  }
  assert.ok(!pairs.some((p) => p.startsWith('converge->')), `body 末节点不得有出边（BODY_ESCAPE）：${pairs}`)
  assert.ok(!pairs.some((p) => p.startsWith('implement->done')), `body 成员不得连到主图节点：${pairs}`)
  assert.equal(workflow.nodes.some((n) => 'next' in n || 'next_true' in n || 'next_false' in n), false)
  const v = validateWorkflow(workflow)
  assert.deepEqual(v.errors, [], `迁移结果必须自校验通过：${JSON.stringify(v.errors)}`)
  assert.deepEqual(v.warnings, [])
  // loop body 声明与 break_conditions 等旧字段原样保留（不迁移语义，只换执行顺序表达）
  const loop = workflow.nodes.find((n) => n.id === 'impl_loop')
  assert.deepEqual(loop.body, ['implement', 'converge'])
  assert.equal(loop.count, 3)
  assert.equal(workflow.trigger_config.schedule, '0 18 * * 5')
  assert.equal(workflow.trigger_config.auto_trigger, true)
})

test('迁移：body 顺序补边按 body 数组（不依赖 nodes 相邻），显式 null 不补边', () => {
  const { workflow } = migrateLegacy({
    nodes: [
      { id: 'start', type: 'start', next: 'lp' },
      // body 顺序与 nodes 数组顺序刻意不同：nodes 里 b 在 a 前
      { id: 'lp', type: 'loop', count: 2, body: ['a', 'b'], next: 'done' },
      { id: 'b', type: 'llm', prompt: 'B', next: null },
      { id: 'a', type: 'llm', prompt: 'A' },
      { id: 'done', type: 'end' },
    ],
  })
  const pairs = workflow.edges.map((e) => `${e.source}->${e.target}`)
  assert.ok(pairs.includes('a->b'), `body 顺序补边缺失：${pairs}`)
  assert.ok(pairs.includes('lp->done'), `loop 出边缺失：${pairs}`)
  assert.equal(pairs.filter((p) => p.startsWith('b->')).length, 0, `next: null 的末位成员不得补边：${pairs}`)
  assert.ok(!pairs.some((p) => p === 'lp->b'), `loop 节点不得直接连 body 成员：${pairs}`)
  assert.deepEqual(validateWorkflow(workflow).errors, [], '迁移结果必须自校验通过')
})

test('迁移：confirm 三分支 → 条件边 approved/rejected/timeout，next 作 default 兜底', () => {
  const { workflow, notes } = migrateLegacy({
    nodes: [
      { id: 'start', type: 'start', next: 'ok' },
      { id: 'ok', type: 'confirm', message: '确认？', next: 'after', next_approve: 'after', next_reject: 'no', next_timeout: 'no' },
      { id: 'after', type: 'llm', prompt: 'A' },
      { id: 'no', type: 'llm', prompt: 'N' },
      { id: 'done', type: 'end' },
    ],
  })
  const pairs = workflow.edges.map((e) => `${e.source}->${e.target}${e.sourceHandle ? ':' + e.sourceHandle : ''}`)
  assert.ok(pairs.includes('start->ok'), pairs.join(','))
  assert.ok(pairs.includes('ok->after:approved'), `approved 条件边缺失：${pairs}`)
  assert.ok(pairs.includes('ok->no:rejected'), `rejected 条件边缺失：${pairs}`)
  assert.ok(pairs.includes('ok->no:timeout'), `timeout 条件边缺失：${pairs}`)
  assert.ok(pairs.includes('ok->after:default'), `next 应作 default 兜底边（三态未命中才走）：${pairs}`)
  assert.ok(!pairs.includes('ok->after'), `有分支字段时不得再无 handle 边（会与命中分支同时触发）：${pairs}`)
  const ok = workflow.nodes.find((n) => n.id === 'ok')
  assert.equal(ok.next_approve, undefined, '审批分支字段应随 edges 删除')
  assert.equal(ok.next_reject, undefined)
  assert.equal(ok.next_timeout, undefined)
  assert.ok(notes.some((s) => s.includes('next_reject') && s.includes('条件边')), `应留下条件边提示：${notes.join('|')}`)
  assert.deepEqual(validateWorkflow(workflow).errors, [], '迁移结果必须自校验通过')
})

test('迁移：confirm 只有部分分支字段 → 只生成该分支边（不臆造缺失分支）', () => {
  const { workflow } = migrateLegacy({
    nodes: [
      { id: 'start', type: 'start', next: 'ok' },
      { id: 'ok', type: 'confirm', next_reject: 'no' },
      { id: 'no', type: 'llm', prompt: 'N' },
      { id: 'done', type: 'end' },
    ],
  })
  const pairs = workflow.edges.map((e) => `${e.source}->${e.target}${e.sourceHandle ? ':' + e.sourceHandle : ''}`)
  assert.ok(pairs.includes('ok->no:rejected'), pairs.join(','))
  assert.ok(!pairs.some((p) => p.endsWith(':approved') || p.endsWith(':timeout')), `缺失分支不得生成边：${pairs}`)
  assert.deepEqual(validateWorkflow(workflow).errors, [], '迁移结果必须自校验通过')
})

test('迁移：无分支字段的 confirm 保持普通顺序边（不引入 default handle）', () => {
  const { workflow } = migrateLegacy({
    nodes: [
      { id: 'start', type: 'start', next: 'ok' },
      { id: 'ok', type: 'confirm' },
      { id: 'done', type: 'end' },
    ],
  })
  const pairs = workflow.edges.map((e) => `${e.source}->${e.target}${e.sourceHandle ? ':' + e.sourceHandle : ''}`)
  assert.ok(pairs.includes('ok->done'), `应保持无 handle 顺序边：${pairs}`)
  assert.ok(!pairs.some((p) => p.includes(':default')), `无分支字段时不应有 default：${pairs}`)
})

test('迁移落盘辅助：renderEdgesYaml/appendEdges 产出可回读的 edges（handle 不被解析成布尔）', () => {
  const raw = 'name: old\nnodes:\n  - { id: start, type: start, next: g }\n  - { id: g, type: if, next_true: a, next_false: b }\n  - { id: a, type: template, template: "A" }\n  - { id: b, type: template, template: "B" }\n  - { id: done, type: end }\n'
  const { workflow } = migrateLegacy(parseYaml(raw))
  const text = appendEdges(raw, workflow.edges)
  assert.ok(text.startsWith(raw), 'appended 文本必须保留原文前缀')
  assert.ok(renderEdgesYaml(workflow.edges).startsWith('edges:'), 'edges 块必须是顶层键')
  const re = parseYaml(text)
  assert.equal(re.edges.length, workflow.edges.length, `edges 应逐条回读：${JSON.stringify(re.edges)}`)
  const handles = re.edges.map((e) => String(e.sourceHandle ?? ''))
  assert.deepEqual(handles.filter(Boolean).sort(), ['false', 'true'], `handle 必须回读为字符串（否则 route 精确匹配失效）：${JSON.stringify(re.edges)}`)
  const reWf = normalizeWorkflow(re)
  assert.deepEqual(validateWorkflow(reWf).errors, [], '回读后必须自校验通过（旧格式 → v2）')
})

test('迁移：已是 DSL v2 的模型原样返回（幂等护栏）', () => {
  const v2 = {
    name: 'v2',
    nodes: [{ id: 'start', type: 'start' }, { id: 'a', type: 'llm', prompt: 'x' }, { id: 'done', type: 'end' }],
    edges: [{ id: 'x1', source: 'start', target: 'a' }, { id: 'x2', source: 'a', target: 'done' }],
  }
  const { workflow, notes } = migrateLegacy(v2)
  assert.deepEqual(workflow.edges, v2.edges)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /无需迁移/)
})

test('迁移：内置 workflows/spec-dev/workflow.yml（旧格式时）自校验通过', (t) => {
  const p = join(process.cwd(), 'workflows', 'spec-dev', 'workflow.yml')
  const parsed = parseYaml(readFileSync(p, 'utf-8'))
  if (Array.isArray(parsed.edges)) return t.skip('spec-dev 已是 DSL v2（Task 8 已重写），无需迁移')
  const { workflow } = migrateLegacy(parsed)
  const pairs = workflow.edges.map((e) => `${e.source}->${e.target}`)
  assert.ok(pairs.includes('start->specify'), pairs.join(','))
  assert.ok(pairs.includes('implement->converge'), pairs.join(','))
  assert.ok(pairs.includes('impl_loop->end'), pairs.join(','))
  assert.ok(!pairs.some((p) => p.startsWith('converge->')), `body 末节点不得有出边：${pairs}`)
  const v = validateWorkflow(workflow)
  assert.deepEqual(v.errors, [], `迁移结果必须自校验通过：${JSON.stringify(v.errors)}`)
})

test('kernel/workflow.mjs 兼容层已 re-export migrateLegacy', async () => {
  const mod = await import('../kernel/workflow.mjs')
  assert.equal(typeof mod.migrateLegacy, 'function')
  const { workflow } = mod.migrateLegacy(LEGACY)
  assert.ok(workflow.edges.length >= 5, `应生成边：${JSON.stringify(workflow.edges)}`)
})
