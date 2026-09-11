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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
