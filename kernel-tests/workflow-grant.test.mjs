// workflow-grant：运行级授权（ctx.grant）——命中放行 / 未命中 fail-closed 不挂起 /
// Write/Edit 受 grant.write_dirs 约束（越界拒绝）。
//
// 注（偏离 brief 逐字值的唯一一处）：brief 写 `assert.equal(denied.ok, false)`，而内核已提交
// 契约（kernel-tests/workflow-nodes.test.mjs「Bash fail-closed」）把"权限门拒绝"表达为
// { ok:true, isError:true, output:<拒绝原因> }——schedule 视 ok:false 为硬失败会中断其余
// 分支，故断言 isError（语义 fail-closed 不减）。

process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeExecutor } from '../kernel/workflow-nodes.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

test('grant：命中授权清单放行，未命中 fail-closed 且不挂起', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-grant-'))
  try {
    // 无 permissionGate（脱离引擎）时：Bash 默认拒绝；grant 命中则放行
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const exec = createNodeExecutor({ registry, getModel: () => 'mock' })
    const denied = await exec({ id: 't', type: 'tool', tool: 'Bash', input: { command: 'echo hi' } }, { inputs: {}, vars: {}, var: {} })
    assert.equal(denied.isError, true, '无 grant 时 Bash 应 fail-closed')
    assert.equal(denied.ok, true, '拒绝是节点的确定性结果（非 ok:false 硬失败）')
    assert.match(String(denied.error ?? denied.output), /拒绝|无审批通道/)

    const granted = await exec({ id: 't', type: 'tool', tool: 'Bash', input: { command: 'echo hi' } }, { inputs: {}, vars: {}, var: {}, grant: { tools: ['Bash'], write_dirs: [], network: false } })
    assert.equal(granted.ok, true, `grant 命中应放行：${JSON.stringify(granted)}`)
    assert.equal(granted.isError, false)
    assert.equal(String(granted.output).includes('hi'), true, 'grant 命中须真的执行（非静默放行假象）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('grant：write_dirs 约束写入落点', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-grant2-'))
  try {
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const exec = createNodeExecutor({ registry, getModel: () => 'mock' })
    const outside = await exec({ id: 'w', type: 'tool', tool: 'Write', input: { file_path: join(root, '..', 'evil.txt'), content: 'x' } }, { inputs: {}, vars: {}, var: {}, grant: { tools: ['Write'], write_dirs: [join(root, 'ok')], network: false } })
    assert.equal(outside.isError, true, '越界写入应被拒绝')
    assert.equal(outside.ok, true)
    assert.match(String(outside.error ?? outside.output), /授权目录/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('grant：write_dirs 归一化后拒 `..` 穿越（<dir>/../evil.txt 不得落盘）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-grant4-'))
  const okDir = join(root, 'ok')
  try {
    mkdirSync(okDir, { recursive: true })
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const exec = createNodeExecutor({ registry, getModel: () => 'mock' })
    const grant = { tools: ['Write'], write_dirs: [okDir], network: false }
    // 朴素前缀比较会把它判为"在 ok 之下"而放行；归一化后落点是 <root>/evil.txt（越界）
    const escaped = await exec({ id: 'w', type: 'tool', tool: 'Write', input: { file_path: join(okDir, '..', 'evil.txt'), content: 'x' } }, { inputs: {}, vars: {}, var: {}, grant })
    assert.equal(escaped.isError, true, '`<dir>/../evil.txt` 必须被拒绝')
    assert.equal(escaped.ok, true)
    assert.match(String(escaped.error ?? escaped.output), /授权目录/)
    assert.equal(existsSync(join(root, 'evil.txt')), false, '越界文件不得真的落盘')
    // 归一化后仍在授权目录之内 → 放行（且真写了）
    const inside = await exec({ id: 'w2', type: 'tool', tool: 'Write', input: { file_path: join(okDir, 'sub', '..', 'ok.txt'), content: 'y' } }, { inputs: {}, vars: {}, var: {}, grant })
    assert.equal(inside.isError, false, `授权目录内的写入应放行：${JSON.stringify(inside)}`)
    assert.equal(existsSync(join(okDir, 'ok.txt')), true, '授权目录内写入须真的落盘')
    // 同前缀兄弟目录仍须拒绝（目录段边界，不能退化成纯字符串前缀）
    const sibling = await exec({ id: 'w3', type: 'tool', tool: 'Write', input: { file_path: join(root, 'ok2', 'x.txt'), content: 'z' } }, { inputs: {}, vars: {}, var: {}, grant })
    assert.equal(sibling.isError, true, '同前缀兄弟目录 ok2 不得被判为在 ok 之下')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('grant：write_dirs 内的写入放行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-grant3-'))
  try {
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const exec = createNodeExecutor({ registry, getModel: () => 'mock' })
    writeFileSync(join(root, 'ok.txt'), 'seed')
    const inside = await exec({ id: 'w', type: 'tool', tool: 'Read', input: { file_path: join(root, 'ok.txt') } }, { inputs: {}, vars: {}, var: {}, grant: { tools: ['Read'], write_dirs: [root], network: false } })
    assert.equal(inside.isError, false, `授权内工具应放行：${JSON.stringify(inside)}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
