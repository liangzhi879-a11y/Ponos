// E2 Task 2 Step 1：运行级授权里的「访问网络」（`grant.network`）此前是**空判据**。
//
// 事实（修复前）：GUI 上有开关（src/components/workflows/AuthzDialog.tsx:196「访问网络」→ 送
// `{ tools, write_dirs, network }`），宿主也把它逐字透传进运行级授权（server/workflow-host.mjs
// #mergeCapabilities），**但内核 grantDecision 只判 `tools` / `write_dirs`** ⇒ 用户勾掉
// 「访问网络」后 `http` 节点照样发请求：**开关是真的、判据是空的**。
//
// 本文件是修复的回归锁，断言刻意落在**副作用**（目标服务收到几次请求）而不是只看返回文案 ——
// 否则"文案改对了但仍把请求发出去"照样能绿。
//
// ★ 修复前本文件必须红：第 1 条会因为 hits===1（请求真的发出去了）而失败。
//
// ★ AI-03（出网**目标**策略，与本文件的「network 授权」是两道独立闸）：本文件的目标服务是
//   **本地回环**（`127.0.0.1:<随机端口>`，为了不依赖外网），而回环默认被地址策略拒绝。
//   放行方式是环境里显式声明允许（这正是产品给内部部署/本地联调的同一出口），
//   **断言一条都没放宽**：仍然要求"放行时请求真的发出去了 / 拒绝时一个都不发"。
process.env.PONOS_EGRESS_ALLOW = process.env.PONOS_EGRESS_ALLOW || '127.0.0.1'
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeExecutor } from '../kernel/workflow-nodes.mjs'
import { createWorkflowEngine } from '../kernel/workflow-engine.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'

/** 起一个本地回环服务当"出网"目标（只监听 127.0.0.1，不依赖外网），并记录收到几次请求 */
async function startTarget() {
  let hits = 0
  const srv = http.createServer((req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = /** @type {any} */ (srv.address())
  return { url: `http://127.0.0.1:${port}/probe`, get hits() { return hits }, close: () => new Promise((r) => srv.close(r)) }
}

test('★ 回归：grant.network=false 时 http 节点必须被拒，且请求一个都不许发出去', async () => {
  const target = await startTarget()
  try {
    const exec = createNodeExecutor({})
    const r = await exec(
      { id: 'h', type: 'http', url: target.url, method: 'GET' },
      { inputs: {}, vars: {}, var: {}, grant: { tools: [], write_dirs: [], network: false } },
    )
    assert.equal(r.isError, true, `未授权网络必须拒绝：${JSON.stringify(r)}`)
    assert.match(String(r.output ?? r.error), /network|网络/, '拒绝理由必须点明 network（否则用户看不出是哪个开关）')
    assert.equal(target.hits, 0, '被批准前一个请求都不许发出去（修复前这里是 1）')
  } finally { await target.close() }
})

test('grant.network=true 时 http 节点放行（GUI 的「访问网络」开关自此是真的了）', async () => {
  const target = await startTarget()
  try {
    const exec = createNodeExecutor({})
    const r = await exec(
      { id: 'h', type: 'http', url: target.url, method: 'GET' },
      { inputs: {}, vars: {}, var: {}, grant: { tools: [], write_dirs: [], network: true } },
    )
    // 成功路径的返回形状 = { ok:true, output:{...} }（**没有** isError 字段；权限拒绝才有）
    assert.equal(r.ok, true, `授权后应真的执行：${JSON.stringify(r)}`)
    assert.notEqual(r.isError, true, `授权后不得被拒：${JSON.stringify(r)}`)
    assert.equal(r.output?.status_code, 200)
    assert.equal(target.hits, 1, '授权后请求必须真的发出去（不是静默放行假象）')
  } finally { await target.close() }
})

test('★ 回归：真出网工具（WebFetch）在 tools 已授权但 network=false 时同样被拒', async () => {
  // 桩注册表：若判据缺失，这里会**真的执行**（返回 ran:true）⇒ 断言照样红，不会靠"注册表为 null 崩掉"蒙混
  const registry = { run: async () => ({ content: 'SHOULD-NOT-RUN', isError: false }) }
  const exec = createNodeExecutor({ registry })
  const r = await exec(
    { id: 't', type: 'tool', tool: 'WebFetch', input: { url: 'https://example.com' } },
    { inputs: {}, vars: {}, var: {}, grant: { tools: ['WebFetch'], write_dirs: [], network: false } },
  )
  assert.equal(r.isError, true, `出网工具也必须受「访问网络」约束：${JSON.stringify(r)}`)
  assert.match(String(r.output ?? r.error), /network|网络/)
  assert.ok(!String(r.output ?? '').includes('SHOULD-NOT-RUN'), '被拒的工具调用不得真的执行')
})

// ===================== 遗留 B 修复（2026-09-27）：无 grant 的形态不再"裸奔" =====================
// 背景：修复轮 R=1 这里钉的是**事实** —— "grant.network 只覆盖手动运行"（ctx.grant 只由 GUI 路径
// 下发；grantDecision 首行 `if (!grant) return null` ⇒ 定时/webhook/子流程触发的 http 节点根本
// 不被这条判据拦）。当时的注释**预先写好**了这次改动的交接说明：
//   ★ "若将来让无 grant 也 fail-closed（合理方向），本用例会红 —— 那时请**同时**更新
//     `shared/egress-capability.cjs#EGRESS_BOUNDARY.canBlock` 里'仅覆盖手动运行'那一条
//     （两处必须一起改，否则又是一次'文档与实现不符'）。"
// 2026-09-27 就是那次"将来"：内核侧改为**默认拒绝 + 工作流显式声明放行**，本条与
// EGRESS_BOUNDARY 那一条**同批**改（两处一起改的纪律在此兑现）。
test('★ 遗留 B：无 grant（定时/webhook/子流程形态）的 http 节点默认拒绝，声明 permissions.network 才放行', async () => {
  const target = await startTarget()
  try {
    const exec = createNodeExecutor({})
    // ① 无 grant 且**未声明** ⇒ 拒绝（此前是"照发请求"—— 开关在这些路径上整条失效）
    const r = await exec(
      { id: 'h', type: 'http', url: target.url, method: 'GET' },
      { inputs: {}, vars: {}, var: {} },   // ← 刻意不给 grant（触发路径的形态）
    )
    assert.equal(r.ok, true, `权限拒绝是节点的确定性结果（非 ok:false 硬失败）：${JSON.stringify(r)}`)
    assert.equal(r.isError, true, '无 grant 且未声明的 http 节点必须被拒（默认最严）')
    assert.match(String(r.output), /没有网络授权/, '拒绝理由必须可诊断（要告诉用户怎么放行）')
    assert.equal(target.hits, 0, '★ 核心断言：被拒的请求**不得真的发出**（此前这里断言的是 hits=1）')
    // ② 无 grant、但工作流**显式声明** permissions.network: true ⇒ 放行
    //    （`ctx.networkDeclared` 由 kernel/workflow-engine.mjs#run 从 wf.permissions 透传）
    const r2 = await exec(
      { id: 'h', type: 'http', url: target.url, method: 'GET' },
      { inputs: {}, vars: {}, var: {}, networkDeclared: true },
    )
    assert.notEqual(r2.isError, true, `显式声明后应放行：${JSON.stringify(r2)}`)
    assert.equal(target.hits, 1, '声明 permissions.network 后请求照发（默认最严 + **显式**放行）')
    // ③ 与登记文案对齐：EGRESS_BOUNDARY 必须写着新的覆盖面（不许只说"已接线"）
    const { EGRESS_BOUNDARY } = await import('../shared/egress-capability.cjs')
    const entry = EGRESS_BOUNDARY.canBlock.find((s) => String(s).includes('execHttp'))
    assert.ok(entry, 'http 节点开关的覆盖面必须在 EGRESS_BOUNDARY 里登记')
    assert.ok(String(entry).includes('所有触发路径'),
      '覆盖面已从"仅覆盖手动运行"变为"所有触发路径"——登记必须跟着改（两处一起改）')
    assert.ok(String(entry).includes('permissions.network'),
      '登记必须写明唯一放行依据（permissions.network），否则读者不知道该怎么放行')
  } finally { await target.close() }
})

// ★ 端到端（2026-09-27 补）：上面那条用例直接给 `ctx.networkDeclared`，**没走 `engine.run`** ——
//   而无人值守路径（定时 / webhook / 自动触发）在真实运行里是 `run()` 从 `wf.permissions` 读出来
//   再透传的。字段名写错、或 DSL 没把 `permissions` 带进来，上面那条**照样全绿**（它手动喂了值）。
//   本用例用**真引擎 + 真 YAML 文件**跑，把这条链路钉住：`permissions.network` 必须真的生效。
test('★ 端到端：engine.run 从 wf.permissions 读网络声明（无人值守形态的唯一放行依据）', async () => {
  const target = await startTarget()
  const root = mkdtempSync(join(tmpdir(), 'yfw-wfnet-'))
  try {
    const writeWf = (id, permissions) => {
      mkdirSync(join(root, 'wf', id), { recursive: true })
      writeFileSync(join(root, 'wf', id, 'workflow.yml'),
        `name: ${id}\nversion: 1.0.0\n${permissions}\n`
        + 'nodes:\n'
        + '  - { id: s, type: start }\n'
        + `  - { id: h, type: http, url: "${target.url}", method: GET }\n`
        + '  - { id: e, type: end }\n'
        + 'edges:\n'
        + '  - { id: e1, source: s, target: h }\n'
        + '  - { id: e2, source: h, target: e }\n', 'utf-8')
    }
    // ① 未声明 ⇒ 拒绝（这正是定时/webhook/自动触发的形态：无人给它 grant，也没自己声明）
    writeWf('nodeclared', '')
    // ② 声明 permissions.network: true ⇒ 放行
    writeWf('declared', 'permissions:\n  network: true\n')

    const registry = createToolRegistry({ cwd: root, addDirs: [root], skipPermissions: true })
    const engine = createWorkflowEngine({ configDir: root, registry, getModel: () => 'mock-model' })
    engine.addRoot(join(root, 'wf'))

    const r1 = await engine.run({ id: 'nodeclared', inputs: {} })   // ← 刻意不传 grant（无人值守形态）
    assert.equal(target.hits, 0, '★ 未声明 + 无 grant ⇒ 请求一个都不许发出去（此前会发）')
    const out1 = JSON.stringify(r1.outputs ?? r1)
    assert.match(out1, /没有网络授权/, `拒绝理由必须可诊断：${out1.slice(0, 300)}`)

    const r2 = await engine.run({ id: 'declared', inputs: {} })     // ← 同样不传 grant
    assert.equal(target.hits, 1, '声明 permissions.network: true 后请求必须真的发出（端到端放行）')
    assert.notEqual(r2.status, 'failed', `声明后不得因权限失败：${JSON.stringify(r2).slice(0, 300)}`)
  } finally {
    await target.close()
    rmSync(root, { recursive: true, force: true })
  }
})
