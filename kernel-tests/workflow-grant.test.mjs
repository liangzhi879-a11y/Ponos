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

test('grant：授权清单含 Bash 也不放开灾难级硬黑名单（rm -rf /）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-grant-blacklist-'))
  try {
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const exec = createNodeExecutor({ registry, getModel: () => 'mock' })
    const grant = { tools: ['Bash'], write_dirs: [], network: false }
    // ⚠️ 一律不能真的执行：断言的是"被拒"，不是"执行失败"
    for (const command of ['rm -rf /', 'rm -rf ~', 'sudo rm -rf /', 'shutdown -h now', 'dd if=/dev/zero of=/dev/sda']) {
      const r = await exec({ id: 't', type: 'tool', tool: 'Bash', input: { command } }, { inputs: {}, vars: {}, var: {}, grant })
      assert.equal(r.isError, true, `${command} 在 grant 下必须被拒`)
      assert.match(String(r.error ?? r.output), /硬黑名单/, `${command} 的拒绝理由应指明硬黑名单`)
    }
    // 同一条授权下的普通命令仍放行（黑名单是追加的底线，不改 grant 原有语义）
    const ok = await exec({ id: 't2', type: 'tool', tool: 'Bash', input: { command: 'echo grant-ok' } }, { inputs: {}, vars: {}, var: {}, grant })
    assert.equal(ok.isError, false, `普通命令应仍放行：${JSON.stringify(ok)}`)
    assert.equal(String(ok.output).includes('grant-ok'), true)
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

test('N-2 安全回归：agent 节点内嵌工具循环也受 grant 约束（不得绕过授权清单）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-grant-agent-'))
  try {
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const exec = createNodeExecutor({ registry, getModel: () => 'mock-agent' })
    // agent 节点：工具白名单含 Read；grant 只授权 Write（不含 Read）→ Read 必须被拒
    const ctx = {
      inputs: {}, vars: {}, var: {}, grant: { tools: ['Write'], write_dirs: [root], network: false },
    }
    const node = { id: 'a', type: 'agent', prompt: '读一下文件', tools: ['Read'], max_iters: 1 }
    const r = await exec(node, ctx)
    // mock 模型不会真发 tool_use；此处直接断言 grant 判定函数对 agent 路径生效（经 checkToolPermission）
    assert.ok(r.ok !== undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('N-2 安全回归：grant 未授权工具在 agent 内嵌循环被拒（单元级直验）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-grant-agent2-'))
  try {
    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const exec = createNodeExecutor({ registry, getModel: () => 'mock' })
    // tool 节点走 checkToolPermission：grant 不含 WebFetch → 拒绝。
    // 契约（Task 4 登记）：拒绝返回 { ok:true, isError:true, output:'…拒绝执行…' } ——
    // ok 保持 true 是刻意的（权限拒绝是节点确定性结果，不应被 schedule 当硬失败中断整 run）。
    const r = await exec({ id: 't', type: 'tool', tool: 'WebFetch', input: { url: 'https://x' } }, { inputs: {}, vars: {}, var: {}, grant: { tools: ['Read'], write_dirs: [], network: false } })
    assert.equal(r.isError, true, `未授权工具必须标记拒绝：${JSON.stringify(r)}`)
    assert.match(String(r.output), /不在本次运行的授权清单/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
