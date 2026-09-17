// kernel-tests/mcp-registry.test.mjs
// MCP 注册表（Task 2/10）：开关跳过、按 agentId 组装视图、snapshot 上报。
//
// 为什么这些行为值得真起子进程来测：授权判定错一格的后果是**权限事故**而非界面瑕疵 ——
// 把 bound 判成 public 等于把带凭证的服务器给了所有 agent；把 disabled 判成启用等于
// 用户以为停用了却仍在连接。"看代码好像对"在这里不够，必须让真实的连接/发现路径跑一遍。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMcpRegistry } from '../kernel/mcp-tools.mjs'

const STUB = fileURLToPath(new URL('./fixtures/mcp-stub-server.mjs', import.meta.url))
const NODE = process.execPath
/** 桩服务器暴露 5 个工具：echo / boom / hang / die / plain */
// 桩服务器工具数：5 个原生工具 + 第二批固定追加的 2 个资源工具（list_resources / read_resource）
const STUB_TOOLS = 7

function tmpCfg(servers) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-mcp-reg-'))
  const p = join(dir, 'mcp.json')
  writeFileSync(p, JSON.stringify({ servers }, null, 2), 'utf-8')
  return { dir, p }
}

test('enabled:false 的服务器**根本不连接**，且记入 disabled', async () => {
  // 用不存在的命令是刻意的：若它被尝试连接，就会进 failed；
  // 断言它进 disabled 而非 failed，才真正证明"连尝试都没有"（只看 snapshot 里没它是不够的）。
  const { dir, p } = tmpCfg({ off: { command: 'definitely-not-a-real-command-xyz-12345', enabled: false } })
  try {
    const reg = createMcpRegistry({ configPath: p, log: () => {} })
    await reg.ready()
    const snap = reg.snapshot()
    assert.deepEqual(snap.disabled, ['off'])
    assert.deepEqual(Object.keys(snap.failed), [], '关闭的服务器不该出现在 failed —— 那是"试了没成"，不是"没试"')
    assert.deepEqual(snap.servers, {}, '关闭的服务器不产生任何工具')
    assert.deepEqual(reg.view({ agentId: null }), {})
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('未配置 ⇒ 空视图与空快照（既有行为零变化）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-mcp-reg-empty-'))
  try {
    const reg = createMcpRegistry({ configPath: join(dir, 'nope.json'), log: () => {} })
    assert.deepEqual(reg.view({ agentId: null }), {}, '同步视图：未就绪时必须是空对象，不能是 undefined')
    await reg.ready()
    const snap = reg.snapshot()
    assert.deepEqual(snap.servers, {})
    assert.deepEqual(snap.disabled, [])
    assert.match(snap.configSig, /^[0-9a-f]{16}$/, '未配置也要有签名（空配置的签名），否则桥会误判为"已变更"')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('view() 无参等价于 agentId:null（既有调用点零改动）', async () => {
  const { dir, p } = tmpCfg({})
  try {
    const reg = createMcpRegistry({ configPath: p, log: () => {} })
    assert.deepEqual(reg.view(), reg.view({ agentId: null }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('可见性过滤：private 不给任何 AI、bound 只给列出的 agent、public 给所有', async () => {
  const mk = () => ({ command: NODE, args: [STUB], timeoutMs: 15000 })
  const { dir, p } = tmpCfg({
    pub: { ...mk(), expose: { mode: 'public' } },
    priv: { ...mk(), expose: { mode: 'private' } },
    bnd: { ...mk(), expose: { mode: 'bound', bindAgents: ['researcher'] } },
  })
  const reg = createMcpRegistry({ configPath: p, log: () => {} })
  try {
    await reg.ready()
    const snap = reg.snapshot()

    // ① 发现层：三台都连上了，各自都发现了桩的全部工具 —— **snapshot 不做可见性过滤**。
    //    这是刻意的：面板要能展示"台子上有什么"，而"谁看得见"是配置维度的另一维信息。
    for (const n of ['pub', 'priv', 'bnd']) {
      assert.equal(snap.servers[n]?.tools.length, STUB_TOOLS,
        `${n} 应发现 ${STUB_TOOLS} 个工具（snapshot 报实际发现，不看可见性）`)
    }
    assert.equal(snap.servers.priv.expose, 'private')
    assert.equal(snap.servers.bnd.expose, 'bound')

    // ② 主会话：只有 public
    const main = reg.view({ agentId: null })
    assert.ok(main['mcp__pub__echo'], 'public：主会话可用')
    assert.equal(main['mcp__priv__echo'], undefined, 'private（仅测试）：主会话不可用')
    assert.equal(main['mcp__bnd__echo'], undefined, 'bound：主会话不可用（与 dyntools 同义）')

    // ③ 被指定的 agent：public + bound
    const researcher = reg.view({ agentId: 'researcher' })
    assert.ok(researcher['mcp__pub__echo'])
    assert.equal(researcher['mcp__priv__echo'], undefined)
    assert.ok(researcher['mcp__bnd__echo'], 'bound：列出的 agent 可用')

    // ④ 没被指定的 agent：只有 public
    const other = reg.view({ agentId: 'other' })
    assert.ok(other['mcp__pub__echo'])
    assert.equal(other['mcp__bnd__echo'], undefined, 'bound：不在列表里的 agent 不可用')

    // ⑤ 视图条目要能真的被调用（不能只有键名）
    assert.equal(typeof main['mcp__pub__echo'].run, 'function', '视图条目须含 run —— 否则工具表里是个点不动的壳')
    assert.equal(typeof main['mcp__pub__echo'].description, 'string')
  } finally { reg.closeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('连接失败只影响那一台：进 failed 并带原因，其余照常可用', async () => {
  const { dir, p } = tmpCfg({
    bad: { command: 'definitely-not-a-real-command-xyz-12345', timeoutMs: 5000 },
    good: { command: NODE, args: [STUB], timeoutMs: 15000 },
  })
  const reg = createMcpRegistry({ configPath: p, log: () => {} })
  try {
    await reg.ready()
    const snap = reg.snapshot()
    assert.ok(snap.failed.bad, '失败的服务器要在 failed 里带原因（面板据此显示"启动失败：…"）')
    assert.equal(snap.failed.good, undefined)
    assert.ok(reg.view({ agentId: null })['mcp__good__echo'], '一台坏了不该拖垮另一台')
    assert.ok(reg.toolNames().includes('mcp__good__echo'))
  } finally { reg.closeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('snapshot 的 configSig 跟随配置内容（桥据此判断"配置比内核新"）', async () => {
  const mk = () => ({ command: NODE, args: [STUB], timeoutMs: 15000 })
  const { dir, p } = tmpCfg({ a: { ...mk(), expose: { mode: 'public' } } })
  const reg1 = createMcpRegistry({ configPath: p, log: () => {} })
  try {
    await reg1.ready()
    const sig1 = reg1.snapshot().configSig

    writeFileSync(p, JSON.stringify({ servers: { a: { ...mk(), expose: { mode: 'private' } } } }), 'utf-8')
    const reg2 = createMcpRegistry({ configPath: p, log: () => {} })
    await reg2.ready()
    assert.notEqual(reg2.snapshot().configSig, sig1, '授权变更必须让签名变 —— 否则改了授权内核不会重载')
    reg2.closeAll()
  } finally { reg1.closeAll(); rmSync(dir, { recursive: true, force: true }) }
})
