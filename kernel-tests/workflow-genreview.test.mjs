// gen-review 编排内置工作流（2026-10-07 循环编排扩展 D26 / spec §4.7）：发现/解析 + 引擎语义 + 可见性
// ---------------------------------------------------------------------------
// ① 真实预置发现/解析/校验：DAG 结构齐全；★ 红线守卫——validateWorkflow 必须全过。
//    若 generate 提示词改回直引 {{review.text}}，内核会以 VAR_UNREACHABLE 拒绝整份定义
//    （review 在 DAG 上不是 generate 的上游、跨轮前向引用不被解析）——轮间反馈只能走
//    var 作用域（save: assign → var.last_review，generate 再读）：
// ② mock 引擎真跑真实预置：主图 scoping + 跨轮 var 反馈 + 判词命中「通过」第 1 轮提前终止；
// ③ 同构 DAG 冒烟（真节点语义镜像 ②）：3 轮回环时逐轮反馈精确入参、首轮空值语义；
//    「通过」判词 → iterations===1 提前终止；
// ④ 可见性（D16 两消费面分界的活例）：私有缺省——编排段对选择器可见，
//    对工具池 / 提示词工作流清单**不可见**。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverWorkflows, loadWorkflow, createWorkflowEngine } from '../kernel/workflow.mjs'
import { validateWorkflow } from '../kernel/workflow-dsl.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { buildWorkflowTools, listVisibleWorkflows } from '../kernel/dyntools.mjs'

// 仓库根相对定位（不依赖 cwd）：在 kernel/ 下跑 npm test 也能找到内置工作流
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO_ROOT, 'workflows', 'gen-review', 'workflow.yml')

// gen-review 结构的同构冒烟件（真节点语义）：start → lp[gen → rev → mem]×≤3 → answer → end。
// gen 用 template（纯字符串输出，可精确断言渲染结果）；rev 用 agent（输出 {text}，复刻
// break_conditions 的 review.text 路径、以及 {{rev.text}} 在 assign 里的取值形态）；
// verdict 由输入注入 → 分别实证「3 轮回环、逐轮反馈」与「判词命中、首轮即止」。
const GENREVIEW_DAG = `name: gen-review-dag
version: 1.0.0
inputs:
  - { name: verdict, type: string, required: true }
nodes:
  - { id: start, type: start }
  - { id: lp, type: loop, count: 3, body: [gen, rev, mem], break_conditions: [{ var: rev.text, op: contains, value: 通过 }] }
  - { id: gen, type: template, template: "上轮意见[{{var.last_review}}]；第 {{iter}} 轮生成" }
  - { id: rev, type: agent, prompt: "{{inputs.verdict}}" }
  - { id: mem, type: assign, items: [{ variable: last_review, value: "{{rev.text}}" }] }
  - { id: answer, type: answer, template: "{{gen}}" }
  - { id: end, type: end }
edges:
  - { id: e1, source: start, target: lp }
  - { id: e2, source: lp, target: answer }
  - { id: e3, source: answer, target: end }
  - { id: e4, source: gen, target: rev }
  - { id: e5, source: rev, target: mem }
`

test('gen-review 发现与解析：DAG 结构齐全 + 校验全过（VAR_UNREACHABLE 红线守卫）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-genreview-'))
  try {
    mkdirSync(join(root, 'gen-review'), { recursive: true })
    copyFileSync(SRC, join(root, 'gen-review', 'workflow.yml'))
    const wfs = discoverWorkflows({ root })
    assert.equal(wfs.length, 1)
    assert.equal(wfs[0].name, 'gen-review')
    assert.equal(wfs[0].legacy, false, 'DSL v2：有 edges 即非旧格式')
    assert.equal(wfs[0].orchestrate?.display_name, '生成-审查循环', '编排段声明（选择器消费面）')
    const wf = loadWorkflow({ roots: [root], id: 'gen-review' })
    assert.ok(wf, 'loadWorkflow 应解析成功')
    const ids = wf.nodes.map((n) => n.id)
    for (const id of ['start', 'rl_loop', 'generate', 'review', 'save', 'answer', 'end']) {
      assert.ok(ids.includes(id), `应有节点 ${id}`)
    }
    const pairs = wf.edges.map((e) => `${e.source}->${e.target}`)
    for (const p of ['start->rl_loop', 'rl_loop->answer', 'answer->end', 'generate->review', 'review->save']) {
      assert.ok(pairs.includes(p), `应有边 ${p}：${pairs.join(',')}`)
    }
    const loop = wf.nodes.find((n) => n.id === 'rl_loop')
    assert.equal(loop.type, 'loop')
    assert.equal(loop.count, 3, '≤3 轮兜底')
    assert.deepEqual(loop.body, ['generate', 'review', 'save'])
    assert.ok(Array.isArray(loop.break_conditions) && loop.break_conditions.length === 1, '断点：判词命中即停')
    assert.deepEqual(loop.break_conditions[0], { var: 'review.text', op: 'contains', value: '通过' })
    // 轮间反馈：generate 读 {{var.last_review}}（首轮渲染空串 = 首版）；save 写 var.last_review。
    // ★ 不得把 generate 改回直引 {{review.text}}：跨轮前向引用（review 不是 generate 的 DAG 上游）
    //   会被 validateWorkflow 以 VAR_UNREACHABLE 拒绝整份定义——下面的 validate 断言就是那条红线。
    const gen = wf.nodes.find((n) => n.id === 'generate')
    assert.match(String(gen.prompt), /\{\{var\.last_review\}\}/, 'generate 应读轮间反馈变量')
    assert.doesNotMatch(String(gen.prompt), /\{\{review/, 'generate 不得直引 review（跨轮前向引用会被内核拒绝）')
    const rev = wf.nodes.find((n) => n.id === 'review')
    assert.match(String(rev.prompt), /通过/, '判词规则：无问题以「通过」开头')
    assert.match(String(rev.prompt), /需修改/, '判词规则：有问题以「需修改：」开头')
    assert.match(String(rev.prompt), /\{\{generate\.text\}\}/, '审查对象 = 当轮交付物')
    const save = wf.nodes.find((n) => n.id === 'save')
    assert.equal(save.type, 'assign')
    assert.deepEqual(save.items, [{ variable: 'last_review', value: '{{review.text}}' }], 'save 写当轮审查意见')
    const answer = wf.nodes.find((n) => n.id === 'answer')
    assert.equal(answer.type, 'answer')
    assert.equal(answer.template, '{{generate.text}}', '回复合成：answer 取末轮交付物')
    assert.equal(wf.trigger_config?.auto_trigger, false, '编排预置不得自动触发')
    const v = validateWorkflow(wf)
    assert.equal(v.ok, true, JSON.stringify(v.errors))
    assert.deepEqual(v.errors, [], '校验错误必须为空（红线守卫）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('gen-review 引擎真跑真实预置（mock）：主图 scoping + 跨轮 var 反馈 + 判词命中第 1 轮提前终止', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-genreview-run-'))
  try {
    mkdirSync(join(root, 'gen-review'), { recursive: true })
    copyFileSync(SRC, join(root, 'gen-review', 'workflow.yml'))
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const engine = createWorkflowEngine({ configDir: root })
    const events = []
    engine.setDeps({ registry, getModel: () => 'mock-model', onEvent: (e) => events.push(e) })
    engine.addRoot(root)
    const r = await engine.run({ id: 'gen-review', inputs: { message: '编写一段产品介绍' } })
    assert.equal(r.ok, true, `应可执行：${JSON.stringify(r).slice(0, 300)}`)
    assert.equal(r.status, 'completed')
    for (const id of ['start', 'rl_loop', 'answer', 'end']) {
      assert.ok(r.settled.has(id), `主链节点应 settled：${id}（${[...r.settled.keys()].join(',')}）`)
    }
    // body 成员不进主图 settled（loop 内子图递归执行）
    for (const id of ['generate', 'review', 'save']) {
      assert.equal(r.settled.has(id), false, `body 成员不得出现在主 settled：${id}`)
    }
    const loopOut = r.outputs.rl_loop.output
    // mock 回显 = 提示词前 120 字符；review 提示词把判词规则放在最前（「通过」在 ~15 字符处），
    // 首轮回显即命中 break_conditions → iterations===1, broken===true。
    // ★ 这条断言同时守卫提示词布局：判词规则若被挪到交付物之后、超出回显窗口，broken 会变 false。
    assert.equal(loopOut.iterations, 1, `判词命中应第 1 轮即停（实际 ${loopOut.iterations} 轮）`)
    assert.equal(loopOut.broken, true, '断点条件应命中「通过」')
    assert.ok(Array.isArray(loopOut.results) && loopOut.results.length === loopOut.iterations, 'results 与轮数一致')
    const nodeEvents = (id) => events.filter((e) => e.type === 'node' && e.node === id)
    const gen = nodeEvents('generate')
    const rev = nodeEvents('review')
    const sav = nodeEvents('save')
    for (const [id, list] of [['generate', gen], ['review', rev], ['save', sav]]) {
      assert.equal(list.length, loopOut.iterations, `${id} 执行轮数应与 loop 轮数一致：${list.length}`)
      assert.ok(list.every((e) => e.in_body === true), `${id} 事件应带 in_body`)
    }
    const revText = rev[0].output.text
    assert.match(String(revText), /^mock: /, 'mock 回显形态')
    assert.ok(String(revText).includes('通过'), `首轮回显应含「通过」（窗口余量）：${String(revText).slice(0, 80)}`)
    assert.equal(sav[0].output.last_review, revText, 'save 应把当轮审查意见写进 var.last_review')
    assert.equal(r.finalOutput.answer, gen[0].output.text, 'answer 节点应取末轮 generate 输出（跨轮覆盖后 = 最后一版）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('gen-review 同构 DAG 冒烟：3 轮回环逐轮反馈（首轮空值）+「通过」首轮提前终止', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-genreview-dag-'))
  try {
    mkdirSync(join(root, 'gen-review-dag'), { recursive: true })
    writeFileSync(join(root, 'gen-review-dag', 'workflow.yml'), GENREVIEW_DAG, 'utf-8')
    const run = async (verdict) => {
      const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
      const engine = createWorkflowEngine({ configDir: root })
      const events = []
      engine.setDeps({ registry, getModel: () => 'mock-model', onEvent: (e) => events.push(e) })
      engine.addRoot(root)
      const r = await engine.run({ id: 'gen-review-dag', inputs: { verdict } })
      const nodeEvents = (id) => events.filter((e) => e.type === 'node' && e.node === id)
      return { r, gen: nodeEvents('gen'), rev: nodeEvents('rev'), mem: nodeEvents('mem') }
    }
    // A：判词不通过 → 跑满 3 轮；逐轮反馈 = 上一轮审查原文（跨轮 var 可见性），首轮为空串
    const A = await run('需修改：版本一有问题')
    assert.equal(A.r.ok, true, `应可执行：${JSON.stringify(A.r).slice(0, 300)}`)
    const loopA = A.r.outputs.lp.output
    assert.equal(loopA.iterations, 3, '未命中判词应跑满 count 上限')
    assert.equal(loopA.broken, false, '判词未命中不得判 break')
    assert.equal(A.gen.length, 3)
    assert.equal(A.rev.length, 3)
    assert.equal(A.mem.length, 3)
    const revText = A.rev[0].output.text
    assert.match(String(revText), /^mock: 需修改/, 'mock 回显判词原文')
    assert.deepEqual(A.gen.map((e) => e.output), [
      '上轮意见[]；第 0 轮生成',
      `上轮意见[${revText}]；第 1 轮生成`,
      `上轮意见[${revText}]；第 2 轮生成`,
    ], '首轮 var.last_review 为空（首版语义）；其后逐轮携带上一轮审查原文（跨轮反馈）')
    for (const m of A.mem) assert.equal(m.output.last_review, revText, 'mem 每轮应写入 var.last_review')
    assert.equal(A.r.finalOutput.answer, A.gen[2].output, 'answer 应取末轮 gen 输出')
    // B：判词通过 → 第 1 轮即终止（不消耗剩余轮次）
    const B = await run('通过')
    assert.equal(B.r.ok, true)
    const loopB = B.r.outputs.lp.output
    assert.equal(loopB.iterations, 1, '判词命中应第 1 轮即停')
    assert.equal(loopB.broken, true)
    assert.deepEqual(B.gen.map((e) => e.output), ['上轮意见[]；第 0 轮生成'])
    assert.equal(B.r.finalOutput.answer, B.gen[0].output)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('gen-review 可见性：私有缺省——编排段可见（选择器），工具池/提示词清单不可见（D16 两消费面）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-genreview-exp-'))
  try {
    mkdirSync(join(root, 'gen-review'), { recursive: true })
    copyFileSync(SRC, join(root, 'gen-review', 'workflow.yml'))
    const [meta] = discoverWorkflows({ root })
    assert.notEqual(meta.expose?.mode, 'public', `编排预置不得 expose public：${JSON.stringify(meta.expose)}`)
    assert.equal(meta.orchestrate?.display_name, '生成-审查循环', '声明仍在——选择器消费面不受影响')
    const visible = listVisibleWorkflows({ roots: [root] }).map((w) => w.id)
    assert.deepEqual(visible, [], `private 工作流不得进提示词清单：${visible}`)
    const tools = buildWorkflowTools({ roots: [root], engine: { run: async () => ({ ok: true, finalOutput: {} }) } })
    assert.deepEqual(Object.keys(tools), [], `private 工作流不得注册工具：${Object.keys(tools)}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
