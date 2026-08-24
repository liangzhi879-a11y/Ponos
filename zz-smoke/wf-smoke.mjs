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

rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
