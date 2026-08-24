// 临时冒烟测试：workflow 引擎核心功能（不依赖 cli）
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkflowEngine, parseYaml, renderTemplate, verifyRun } from '../kernel/workflow.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

let pass = 0, fail = 0
function assert(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${detail}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. YAML 解析
console.log('== YAML 解析 ==')
const yml = `
name: test-wf
description: 冒烟测试
triggers:
  - 测试
  - smoke
inputs:
  - name: text
    type: string
    required: true
nodes:
  - id: start
    type: start
  - id: upper
    type: code
    code: |
      function main(inputs) { return { result: String(inputs.text).toUpperCase() } }
    variables:
      - variable: text
        selector: inputs.text
    output: out
  - id: check
    type: if
    conditions:
      - var: "{{upper.result}}"
        op: contains
        value: "ABC"
    next_true: tpl
    next_false: end
  - id: tpl
    type: template
    template: "处理结果: {{upper.result}}"
    output: final
  - id: end
    type: end
    outputs:
      - variable: result
        selector: "{{tpl}}"
`
const parsed = parseYaml(yml)
assert('name', parsed.name === 'test-wf')
assert('triggers 列表', Array.isArray(parsed.triggers) && parsed.triggers.length === 2)
assert('nodes 数量', Array.isArray(parsed.nodes) && parsed.nodes.length === 5)
assert('code 多行块', parsed.nodes[1].code.includes('function main'))
assert('inputs', parsed.inputs[0].name === 'text' && parsed.inputs[0].required === true)

// 2. 模板渲染
console.log('== 模板 ==')
assert('深路径插值', renderTemplate('a={{inputs.text}} b={{upper.result}}', { inputs: { text: 'x' }, upper: { result: 'Y' } }) === 'a=x b=Y')

// 3. 引擎线性 + 分支 + 审计
console.log('== 引擎执行 ==')
const tmp = join(tmpdir(), 'wf-test-' + Date.now())
mkdirSync(tmp, { recursive: true })
const wfDir = join(tmp, 'workflows')
mkdirSync(wfDir, { recursive: true })
writeFileSync(join(wfDir, 'test-wf.yml'), yml)
const registry = createToolRegistry({ cwd: tmp, addDirs: [tmp] })
const events = []
const engine = createWorkflowEngine({
  configDir: tmp,
  registry,
  onEvent: (ev) => events.push(ev),
  getModel: () => 'mock-model',
})
engine.addRoot(wfDir)
const r = await engine.run({ id: 'test-wf', inputs: { text: 'abc' } })
assert('run ok', r.ok, JSON.stringify(r))
assert("steps", r.steps === 5, `steps=${r.steps}`)
assert('分支走 true 链（tpl）', r.outputs.tpl?.output === '处理结果: ABC', JSON.stringify(r.outputs))
assert('end 输出', r.outputs.end?.output?.result === "处理结果: ABC", JSON.stringify(r.outputs.end))
assert('事件序列', events.some((e) => e.type === 'start') && events.some((e) => e.type === 'end'))
assert('审计文件', r.auditPath && readFileSync(r.auditPath, 'utf-8').split('\n').filter(Boolean).length === 5)

// 4. 审计哈希链
console.log('== 审计 ==')
const v = engine.verify(r.auditPath)
assert('verify ok', v.ok, JSON.stringify(v))
assert("verify 行数", v.lines === 5)

// 5. if 走 false 链
console.log('== 分支 ==')
const r2 = await engine.run({ id: 'test-wf', inputs: { text: 'xyz' } })
assert('false 链跳过 tpl', r2.ok && r2.outputs.tpl === undefined, JSON.stringify(r2.outputs))
assert('end 直接收尾', r2.outputs.end?.output?.result === undefined, JSON.stringify(r2.outputs.end))

// 6. tool 节点
console.log('== tool 节点 ==')
const ymlTool = `
name: tool-wf
description: 工具节点测试
nodes:
  - id: start
    type: start
  - id: t1
    type: tool
    tool: Glob
    input:
      pattern: "*.yml"
    output: files
  - id: end
    type: end
    outputs:
      - variable: files
        selector: "{{t1}}"
`
writeFileSync(join(wfDir, 'tool-wf.yml'), ymlTool)
const r3 = await engine.run({ id: 'tool-wf', inputs: {} })
assert('tool 节点执行', r3.ok, JSON.stringify(r3))
assert('Glob 返回文件', r3.outputs.t1?.output?.includes('test-wf.yml'), JSON.stringify(r3.outputs.t1))

// 7. 未知工作流
console.log('== 错误处理 ==')
const r4 = await engine.run({ id: 'no-such-wf', inputs: {} })
assert('未知工作流报错', !r4.ok && r4.error.includes('不存在'))

// 8. 循环检测
console.log('== 循环检测 ==')
const ymlLoop = `
name: loop-wf
description: 循环检测
nodes:
  - id: a
    type: assign
    items:
      - variable: x
        value: "1"
    next: b
  - id: b
    type: assign
    items:
      - variable: y
        value: "2"
    next: a
`
writeFileSync(join(wfDir, 'loop-wf.yml'), ymlLoop)
const r5 = await engine.run({ id: 'loop-wf', inputs: {} })
assert('循环检测报错', !r5.ok && r5.error.includes('循环'), JSON.stringify(r5))

// 9. iterate 迭代（串行 + body 子图 + item/index 注入）
console.log('== iterate 迭代 ==')
const ymlIterate = `
name: iter-wf
description: 迭代测试
inputs:
  - name: items
    type: array
nodes:
  - id: start
    type: start
  - id: it
    type: iterate
    iterable: "{{inputs.items}}"
    body: [process, mark]
  - id: process
    type: code
    code: |
      function main(inputs) { return { val: inputs.item * 2 } }
    variables:
      - variable: item
        selector: item
  - id: mark
    type: code
    code: |
      function main(inputs) { return { tagged: inputs.val + '-' + inputs.index } }
    variables:
      - variable: val
        selector: process.val
      - variable: index
        selector: index
  - id: end
    type: end
    outputs:
      - variable: results
        selector: "{{it}}"
`
writeFileSync(join(wfDir, 'iter-wf.yml'), ymlIterate)
const r6 = await engine.run({ id: 'iter-wf', inputs: { items: [1, 2, 3] } })
assert('iterate ok', r6.ok, JSON.stringify(r6))
assert('iterate 聚合 3 项', Array.isArray(r6.outputs.it?.output) && r6.outputs.it.output.length === 3, JSON.stringify(r6.outputs.it))
assert('item/index 注入正确', r6.outputs.it.output[1]?.tagged === '4-1', JSON.stringify(r6.outputs.it))
assert('end 输出迭代结果', r6.outputs.end?.output?.results?.length === 3, JSON.stringify(r6.outputs.end))

// 10. iterate 并行
console.log('== iterate 并行 ==')
const ymlIterateP = `
name: iterp-wf
description: 迭代并行测试
inputs:
  - name: items
    type: array
nodes:
  - id: start
    type: start
  - id: it
    type: iterate
    iterable: "{{inputs.items}}"
    is_parallel: true
    parallel_nums: 2
    body: [process]
  - id: process
    type: code
    code: |
      function main(inputs) { return { v: inputs.item * 3 } }
    variables:
      - variable: item
        selector: item
  - id: end
    type: end
    outputs:
      - variable: results
        selector: "{{it}}"
`
writeFileSync(join(wfDir, 'iterp-wf.yml'), ymlIterateP)
const r7 = await engine.run({ id: 'iterp-wf', inputs: { items: [1, 2, 3, 4] } })
assert('iterate 并行 ok', r7.ok && r7.outputs.it?.output?.map((x) => x?.v).join(',') === '3,6,9,12', JSON.stringify(r7.outputs.it))

// 11. loop 循环 + break 条件
console.log('== loop 循环 ==')
const ymlLoopNode = `
name: lp-wf
description: loop 节点测试
inputs:
  - name: target
    type: number
nodes:
  - id: start
    type: start
  - id: lp
    type: loop
    count: 5
    body: [step, check]
  - id: step
    type: assign
    items:
      - variable: acc
        value: "{{var.acc}}"
        operation: append
  - id: check
    type: if
    conditions:
      - var: "{{var.acc.length}}"
        op: ">="
        value: "3"
  - id: end
    type: end
    outputs:
      - variable: results
        selector: "{{lp.results}}"
      - variable: iterations
        selector: "{{lp.iterations}}"
`
writeFileSync(join(wfDir, 'lp-wf.yml'), ymlLoopNode)
const r8 = await engine.run({ id: 'lp-wf', inputs: { target: 3 } })
assert('loop ok', r8.ok, JSON.stringify(r8))
assert('loop 跑满 5 轮', r8.outputs.lp?.output?.iterations === 5, JSON.stringify(r8.outputs.lp))
assert('loop 每轮 append', r8.outputs.lp?.output?.results?.length === 5, JSON.stringify(r8.outputs.lp))

// 12. classify 分类（mock 回显类别）
console.log('== classify 分类 ==')
process.env.PONOS_MOCK_API = '1'
const ymlClassify = `
name: clf-wf
description: 分类测试
inputs:
  - name: question
    type: string
nodes:
  - id: start
    type: start
  - id: clf
    type: classify
    query: "{{inputs.question}}"
    classes: [文件处理, 查询历史, 其他]
    routes: [file_flow, query_flow, other_flow]
  - id: file_flow
    type: template
    template: "走文件处理: {{clf.category}}"
  - id: query_flow
    type: template
    template: "走查询: {{clf.category}}"
  - id: other_flow
    type: template
    template: "走其他: {{clf.category}}"
  - id: end
    type: end
    outputs:
      - variable: result
        selector: "{{file_flow}}"
`
writeFileSync(join(wfDir, 'clf-wf.yml'), ymlClassify)
const r9 = await engine.run({ id: 'clf-wf', inputs: { question: '上传合同文件' } })
assert('classify ok', r9.ok, JSON.stringify(r9))
assert('classify 输出类别', r9.outputs.clf?.output?.category !== undefined, JSON.stringify(r9.outputs.clf))

// 13. extract 提取（mock 返回 JSON）
console.log('== extract 提取 ==')
const ymlExtract = `
name: ext-wf
description: 提取测试
inputs:
  - name: text
    type: string
nodes:
  - id: start
    type: start
  - id: ext
    type: extract
    query: "{{inputs.text}}"
    instruction: "提取 SQL"
    parameters:
      - name: sql
        type: string
        description: SQL 查询语句
  - id: end
    type: end
    outputs:
      - variable: sql
        selector: "{{ext.sql}}"
`
writeFileSync(join(wfDir, 'ext-wf.yml'), ymlExtract)
const r10 = await engine.run({ id: 'ext-wf', inputs: { text: 'select * from users' } })
assert('extract ok', r10.ok, JSON.stringify(r10))
assert('extract 含字段', r10.outputs.ext?.output?.sql !== undefined || r10.outputs.ext?.output?._raw !== undefined, JSON.stringify(r10.outputs.ext))

// 14. memory 检索 + store 写入
console.log('== memory/store ==')
const memDir = join(tmp, 'memory')
const ymlMem = `
name: mem-wf
description: 记忆测试
inputs:
  - name: topic
    type: string
nodes:
  - id: start
    type: start
  - id: mem
    type: memory
    query: "{{inputs.topic}}"
  - id: st
    type: store
    theme: "工作流测试"
    tag: "wf-smoke"
    summary: "测试记忆条目"
  - id: end
    type: end
    outputs:
      - variable: mem_text
        selector: "{{mem.text}}"
      - variable: stored
        selector: "{{st.ok}}"
`
writeFileSync(join(wfDir, 'mem-wf.yml'), ymlMem)
const memEngine = createWorkflowEngine({
  configDir: tmp,
  registry,
  onEvent: () => {},
  getModel: () => 'mock-model',
  memoryRoot: memDir,
})
memEngine.addRoot(wfDir)
const r11 = await memEngine.run({ id: 'mem-wf', inputs: { topic: '工作流' } })
assert('memory ok', r11.ok, JSON.stringify(r11))
assert('store 写入成功', r11.outputs.st?.output?.ok === true, JSON.stringify(r11.outputs.st))

// 15. agent 节点（mock 对话 + 工具循环）
console.log('== agent 节点 ==')
const ymlAgent = `
name: ag-wf
description: agent 测试
inputs:
  - name: task
    type: string
nodes:
  - id: start
    type: start
  - id: ag
    type: agent
    prompt: "执行任务: {{inputs.task}}"
    tools: [Bash]
  - id: end
    type: end
    outputs:
      - variable: text
        selector: "{{ag.text}}"
      - variable: iters
        selector: "{{ag.iters}}"
`
writeFileSync(join(wfDir, 'ag-wf.yml'), ymlAgent)
const r12 = await engine.run({ id: 'ag-wf', inputs: { task: '测试' } })
assert('agent ok', r12.ok, JSON.stringify(r12))
assert('agent 有输出', typeof r12.outputs.ag?.output?.text === 'string', JSON.stringify(r12.outputs.ag))

// 16. confirm 人工审批（批准链）
console.log('== confirm 审批 ==')
const ymlConfirm = `
name: cnf-wf
description: 审批测试
inputs:
  - name: data
    type: string
nodes:
  - id: start
    type: start
  - id: cf
    type: confirm
    message: "确认数据: {{inputs.data}}"
    inputs:
      - name: comment
        type: paragraph
        required: false
    next_approve: approved_flow
    next_reject: rejected_flow
    next_timeout: timeout_flow
  - id: approved_flow
    type: template
    template: "已批准: {{cf.comment}}"
  - id: rejected_flow
    type: template
    template: "已拒绝"
  - id: timeout_flow
    type: template
    template: "超时"
  - id: end
    type: end
    outputs:
      - variable: result
        selector: "{{approved_flow}}"
`
writeFileSync(join(wfDir, 'cnf-wf.yml'), ymlConfirm)
const cnfEngine = createWorkflowEngine({
  configDir: tmp,
  registry,
  onEvent: (ev) => { events.push(ev) },
  getModel: () => 'mock-model',
})
cnfEngine.addRoot(wfDir)
const r13P = cnfEngine.run({ id: 'cnf-wf', inputs: { data: 'abc' } })
await sleep(300)
const confirmReq = events.filter((e) => e.type === 'confirm_request').pop()
assert('confirm_request 事件', confirmReq && confirmReq.message.includes('abc'), JSON.stringify(confirmReq))
const res13 = cnfEngine.resolveConfirm(confirmReq.runId, confirmReq.node, { action: 'approved', comment: 'OK' })
assert('resolveConfirm ok', res13.ok, JSON.stringify(res13))
const r13 = await r13P
assert('confirm 批准链', r13.ok && r13.outputs.approved_flow?.output === '已批准: OK', JSON.stringify(r13.outputs))

// 17. confirm 拒绝链
console.log('== confirm 拒绝 ==')
const r14P = cnfEngine.run({ id: 'cnf-wf', inputs: { data: 'x' } })
await sleep(300)
const confirmReq2 = events.filter((e) => e.type === 'confirm_request').pop()
cnfEngine.resolveConfirm(confirmReq2.runId, confirmReq2.node, { action: 'rejected', comment: 'no' })
const r14 = await r14P
assert('confirm 拒绝链', r14.ok && r14.outputs.rejected_flow?.output === '已拒绝', JSON.stringify(r14.outputs))

// 18. confirm 超时
console.log('== confirm 超时 ==')
const ymlConfirmTimeout = `
name: cnf-t
description: 审批超时测试
nodes:
  - id: start
    type: start
  - id: cf
    type: confirm
    message: "快速超时"
    timeout_ms: 200
    next_timeout: tflow
  - id: tflow
    type: template
    template: "超时分支"
  - id: end
    type: end
    outputs:
      - variable: result
        selector: "{{tflow}}"
`
writeFileSync(join(wfDir, 'cnf-t.yml'), ymlConfirmTimeout)
const r15 = await cnfEngine.run({ id: 'cnf-t', inputs: {} })
assert('confirm 超时分支', r15.ok && r15.outputs.tflow?.output === '超时分支', JSON.stringify(r15.outputs))

// 19. cron 匹配
console.log('== cron 匹配 ==')
assert('* * * * * 匹配', cnfEngine.cronMatches('* * * * *', new Date('2026-08-24T10:30:00')))
assert('30 10 * * * 匹配', cnfEngine.cronMatches('30 10 * * *', new Date('2026-08-24T10:30:00')))
assert('30 10 * * * 不匹配', !cnfEngine.cronMatches('30 10 * * *', new Date('2026-08-24T10:31:00')))
assert('*/5 分段匹配', cnfEngine.cronMatches('*/5 * * * *', new Date('2026-08-24T10:25:00')))
assert('*/5 不匹配', !cnfEngine.cronMatches('*/5 * * * *', new Date('2026-08-24T10:26:00')))

// 20. webhook 服务
console.log('== webhook ==')
const wfYml = `
name: wh-wf
description: webhook 测试
inputs:
  - name: name
    type: string
nodes:
  - id: start
    type: start
  - id: t
    type: template
    template: "hello {{inputs.name}}"
  - id: end
    type: end
    outputs:
      - variable: result
        selector: "{{t}}"
`
writeFileSync(join(wfDir, 'wh-wf.yml'), wfYml)
const server = cnfEngine.createWebhookServer()
await new Promise((resolve) => server.listen(0, resolve))
const port = server.address().port
const resp = await fetch(`http://localhost:${port}/wf/run/wh-wf`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'world' }),
})
const body = await resp.json()
assert('webhook 触发 run', resp.status === 200 && body.ok && body.status === 'completed', JSON.stringify(body))
const listResp = await fetch(`http://localhost:${port}/wf/list`)
const listBody = await listResp.json()
assert('webhook list', listBody.workflows?.some((w) => w.id === 'wh-wf'), JSON.stringify(listBody))
await new Promise((resolve) => server.close(resolve))

rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
