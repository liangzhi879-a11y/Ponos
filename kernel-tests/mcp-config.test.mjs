// kernel-tests/mcp-config.test.mjs —— MCP 配置的读写面（`normalizeMcpServers` / `writeMcpServers` /
// `readMcpServers`，2026-09-15 P1-6「MCP 配置界面」的服务端）。
//
// 为什么这一层要独立成测（而不是只测 HTTP handler）：这些函数是**磁盘前的最后一道闸**。
//   · 校验漏一条 → GUI 显示"保存成功"，内核 `loadMcpServers` 却读不出这个服务器（静默失效）
//   · 非原子写    → 内核恰好在写的中途重读，读到半截 JSON → 整个 MCP 配置被当成"损坏"跳过
//   · 读时抛异常  → GUI 直接白屏，用户连"哪个文件坏了"都看不到
// 全部用 mkdtempSync 隔离，不碰真实 ~/.yfworking。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_MCP_TIMEOUT_MS, normalizeMcpServers, writeMcpServers, readMcpServers, loadMcpServers,
  EXPOSE_MODES, normalizeExpose, normalizeEnabled, mcpVisibilityOf, mcpConfigSig,
} from '../kernel/mcp.mjs'

const mkTmp = () => mkdtempSync(join(tmpdir(), 'yfw-mcp-config-'))
/**
 * 归一到 loadMcpServers 的形状：空 cwd 时它给 null，而 normalize 是"不设该键"——同一件事。
 * `enabled`/`expose` 是 2026-09-16 新增的字段：**存量配置没有它们，归一化后必然出现**，
 * 故比较前在这里补齐缺省值。不补的话，"往返一致"会被误判成回归，其实只是契约扩展。
 */
const canon = (servers) => Object.fromEntries(
  Object.entries(servers).map(([k, v]) => [k, {
    ...v,
    cwd: v.cwd ?? null,
    enabled: v.enabled === false ? false : true,
    expose: v.expose ?? { mode: 'public', bindAgents: [] },
  }]),
)

// ---------------------------------------------------------------------------
test('normalizeMcpServers：顶层必须是对象；servers 缺省视为 {}；servers 非对象报错', () => {
  for (const bad of [null, undefined, 42, 'x', [], true]) {
    const r = normalizeMcpServers(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒（数组尤其危险：放行等于"用 [] 清空配置"）`)
    assert.ok(r.error, '必须给出可展示的 error')
  }
  assert.deepEqual(normalizeMcpServers({}), { ok: true, servers: {} }, 'servers 缺省 = 空配置')
  assert.deepEqual(normalizeMcpServers({ servers: {} }), { ok: true, servers: {} })
  for (const badServers of ['oops', 42, [], null]) {
    assert.equal(normalizeMcpServers({ servers: badServers }).ok, false, `servers=${JSON.stringify(badServers)} 应报错`)
  }
})

test('normalizeMcpServers：条目必须带非空 command（含空名），错误文案点名到具体服务器', () => {
  const r = normalizeMcpServers({ servers: { bad: { args: ['a'] } } })
  assert.equal(r.ok, false)
  assert.match(r.error, /缺少 command/)
  assert.match(r.error, /bad/, '错误要点名哪个服务器，否则多服务器配置里用户无从定位')

  assert.equal(normalizeMcpServers({ servers: { x: { command: '   ' } } }).ok, false, '空白 command 不算数')
  assert.equal(normalizeMcpServers({ servers: { x: null } }).ok, false, 'null 条目同样读不出 command')
  assert.equal(normalizeMcpServers({ servers: { '  ': { command: 'node' } } }).ok, false, '空名必须报错（工具前缀会变成 mcp____x）')
  assert.equal(normalizeMcpServers({ servers: { ' ok ': { command: 'node' } } }).servers.ok.command, 'node', '名字应去空白')
})

test('normalizeMcpServers：args/env/cwd/timeoutMs 归一规则（与 loadMcpServers 对齐）', () => {
  const r = normalizeMcpServers({
    servers: {
      s: {
        command: '  node  ',
        args: ['a.mjs', 1, true],                  // 非字符串元素 → 字符串化
        env: { A: 'x', N: 2, B: false, O: { k: 1 }, L: [1] }, // 只有原始类型值保留
        cwd: '  /tmp/work  ',
        timeoutMs: 500,
      },
      d: { command: 'node', args: 'not-array', env: [], cwd: '   ', timeoutMs: -5 },
    },
  })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.servers.s.command, 'node', 'command 去空白')
  assert.deepEqual(r.servers.s.args, ['a.mjs', '1', 'true'])
  assert.deepEqual(r.servers.s.env, { A: 'x', N: '2', B: 'false' }, '对象/数组值丢弃（写进文件只会让人以为内核不认）')
  assert.equal(r.servers.s.cwd, '/tmp/work')
  assert.equal(r.servers.s.timeoutMs, 500)

  assert.deepEqual(r.servers.d.args, [], 'args 非数组 → []')
  assert.deepEqual(r.servers.d.env, {}, 'env 非对象 → {}')
  assert.equal('cwd' in r.servers.d, false, 'cwd 为空必须**不设键**（留空串会让 spawn 以空 cwd 报错）')
  assert.equal(r.servers.d.timeoutMs, DEFAULT_MCP_TIMEOUT_MS, '非正 timeoutMs 回落默认值')
  assert.ok('cwd' in r.servers.s, 'cwd 非空时必须写入')
})

test('normalizeMcpServers 是纯函数：不改动入参（GUI 拿到原对象后还要继续用）', () => {
  const input = { servers: { s: { command: 'node', args: ['a'], env: { K: 1 } } } }
  const snapshot = JSON.stringify(input)
  normalizeMcpServers(input)
  assert.equal(JSON.stringify(input), snapshot, '归一化不得就地修改调用方对象')
})

test('writeMcpServers：校验不通过 → 直接返回且**绝不触碰磁盘**', () => {
  const dir = mkTmp()
  try {
    const file = join(dir, 'mcp.json')
    const known = JSON.stringify({ servers: { keep: { command: 'node' } } }, null, 2) + '\n'
    writeFileSync(file, known, 'utf-8')
    const before = readFileSync(file)

    for (const badServers of [{ x: { args: [] } }, { x: { command: '' } }, 'oops', []]) {
      const w = writeMcpServers(file, badServers)
      assert.equal(w.ok, false, `${JSON.stringify(badServers)} 应被拒`)
      assert.ok(w.error, '必须给出 error')
      assert.equal(readFileSync(file).equals(before), true, '被拒的写入不得改动既有文件（逐字节比较）')
    }
    assert.equal(existsSync(`${file}.tmp`), false, '被拒的写入不得留下 .tmp 残渣')

    // 目标文件不存在时，校验失败也不得"顺手创建"
    const fresh = join(dir, 'sub', 'mcp.json')
    assert.equal(writeMcpServers(fresh, { x: {} }).ok, false)
    assert.equal(existsSync(fresh), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writeMcpServers：原子写（无 .tmp 残留）+ 目录自动创建 + 内核读回等价内容（往返一致）', () => {
  const dir = mkTmp()
  try {
    // 深一层目录：GUI 的 YFW_HOME 可能还不存在，写不进去会表现为"保存无效"
    const file = join(dir, 'nested', 'deep', 'mcp.json')
    const servers = {
      alpha: { command: 'node', args: ['a.mjs'], env: { K: 'v' }, cwd: dir, timeoutMs: 777 },
      beta: { command: 'npx', args: [], env: {}, timeoutMs: DEFAULT_MCP_TIMEOUT_MS },
    }
    const w = writeMcpServers(file, servers)
    assert.equal(w.ok, true, w.error)
    assert.deepEqual(w, { ok: true }, '成功返回值就是 {ok:true}（不多塞字段，调用方按契约判断）')
    assert.equal(existsSync(`${file}.tmp`), false, 'rename 之后不得留下 .tmp（残留会被用户当成垃圾文件）')
    assert.equal(JSON.parse(readFileSync(file, 'utf-8')).servers !== undefined, true)

    // **强约束**：写出的文件必须能被 loadMcpServers 读回等价内容
    const back = loadMcpServers(file)
    assert.deepEqual(canon(back), canon(servers), '往返必须一致，否则用户会看到"保存成功但服务器消失"')
    assert.deepEqual(Object.keys(back).sort(), ['alpha', 'beta'])
    assert.equal(back.alpha.timeoutMs, 777)
    assert.equal(back.alpha.cwd, dir)
    // 再写一次（覆盖）也要一致：覆盖路径不得累积脏数据
    assert.equal(writeMcpServers(file, { alpha: { command: 'node' } }).ok, true)
    assert.deepEqual(Object.keys(loadMcpServers(file)), ['alpha'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writeMcpServers：保留现有文件里的未知顶层键（只覆盖 servers）', () => {
  const dir = mkTmp()
  try {
    const file = join(dir, 'mcp.json')
    writeFileSync(file, JSON.stringify({ foo: 1, nested: { a: [1, 2] }, servers: { old: { command: 'node' } } }), 'utf-8')
    assert.equal(writeMcpServers(file, { fresh: { command: 'node' } }).ok, true)
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    assert.equal(onDisk.foo, 1)
    assert.deepEqual(onDisk.nested, { a: [1, 2] })
    assert.deepEqual(Object.keys(onDisk.servers), ['fresh'])

    // 现有文件损坏时：无法保留未知键，但必须仍能把**合规的新配置**写下去（否则用户永久卡死）
    writeFileSync(file, '{ 坏的', 'utf-8')
    assert.equal(writeMcpServers(file, { fresh: { command: 'node' } }).ok, true)
    assert.deepEqual(Object.keys(loadMcpServers(file)), ['fresh'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readMcpServers：缺文件 → 空配置；坏 JSON / 结构不对 → ok:false 且**绝不抛出**', () => {
  const dir = mkTmp()
  try {
    assert.deepEqual(readMcpServers(join(dir, 'none.json')), { ok: true, servers: {} })
    assert.deepEqual(readMcpServers(), { ok: true, servers: {} }, '无路径也不得抛')

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ 这不是 JSON', 'utf-8')
    const r1 = readMcpServers(bad)          // 关键：这一行不能抛（GUI 要显示错误而不是白屏）
    assert.equal(r1.ok, false)
    assert.ok(String(r1.error || '').length > 0)

    const partial = join(dir, 'partial.json')
    writeFileSync(partial, JSON.stringify({ servers: { good: { command: 'node' }, bad: {} } }), 'utf-8')
    const r2 = readMcpServers(partial)
    assert.equal(r2.ok, false, '有条目不合法就整体报错，让用户去修，而不是静默少一个服务器')
    assert.match(String(r2.error), /bad/)

    const okFile = join(dir, 'ok.json')
    writeFileSync(okFile, JSON.stringify({ servers: { s: { command: 'node', args: ['a.mjs'] } } }), 'utf-8')
    const r3 = readMcpServers(okFile)
    assert.equal(r3.ok, true, r3.error)
    assert.deepEqual(Object.keys(r3.servers), ['s'])
    assert.deepEqual(canon(r3.servers), canon(loadMcpServers(okFile)), 'read 与内核 load 必须给出等价结果')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loadMcpServers 既有语义未被本次追加改动（缺文件 {} / 坏 JSON 抛出 / 无 command 忽略）', () => {
  const dir = mkTmp()
  try {
    assert.deepEqual(loadMcpServers(join(dir, 'none.json')), {})
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{坏')
    assert.throws(() => loadMcpServers(bad), '内核侧仍必须抛出（由注册表捕获记日志），不得被改成静默返回')
    const f = join(dir, 'ok.json')
    writeFileSync(f, JSON.stringify({ servers: { n: { args: ['x'] }, y: { command: 'node', timeoutMs: -1 } } }), 'utf-8')
    const cfg = loadMcpServers(f)
    assert.deepEqual(Object.keys(cfg), ['y'], '无 command 的条目仍然被忽略')
    assert.equal(cfg.y.timeoutMs, DEFAULT_MCP_TIMEOUT_MS)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writeMcpServers：路径缺失时报错而不是抛（调用方是 HTTP handler，抛出去就是 500 白屏）', () => {
  const dir = mkTmp()
  try {
    const w = writeMcpServers('', { s: { command: 'node' } })
    assert.equal(w.ok, false)
    assert.ok(w.error)
    // 目录被占位成文件（模拟 IO 失败）→ 返回 ok:false，不抛
    const blocked = join(dir, 'blocked.json')
    mkdirSync(join(dir, 'dir'))
    writeFileSync(blocked, 'x', 'utf-8')
    const w2 = writeMcpServers(join(blocked, 'mcp.json'), { s: { command: 'node' } })
    assert.equal(w2.ok, false, 'IO 失败必须是 {ok:false}，由 handler 转成 500')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 授权模型（2026-09-16 P1-6「MCP 顶层面板」）：`enabled` + 三档 `expose`。
//
// 为什么这一层要测：判定错一格，后果是**权限事故**而非界面小瑕疵 ——
// 把"仅特定 agent"判成"公开"，等于把带凭证的服务器给了所有 agent；
// 把"关闭"判成"开启"，等于用户以为停用了却仍在连接。故这里必须把三档 × agentId 全部钉住。

test('expose 归一化：缺省 = public（存量配置行为不变，升级后工具不消失）', () => {
  const n = normalizeMcpServers({ servers: { a: { command: 'npx' } } })
  assert.equal(n.ok, true)
  assert.deepEqual(n.servers.a.expose, { mode: 'public', bindAgents: [] })
  assert.equal(n.servers.a.enabled, true, 'enabled 缺省必须是 true，否则升级后所有工具突然消失')
  assert.deepEqual(EXPOSE_MODES, ['private', 'public', 'bound'])
})

test('enabled 只认显式 false —— 解析歧义不该悄悄关掉用户的服务器', () => {
  const mk = (v) => normalizeMcpServers({ servers: { a: { command: 'npx', enabled: v } } }).servers.a.enabled
  assert.equal(mk(false), false)
  assert.equal(mk(true), true)
  assert.equal(mk(undefined), true)
  assert.equal(mk('false'), true, '字符串 "false" 视为开启：宁可多连一次，也不要静默停用')
  assert.equal(mk(0), true)
  assert.equal(mk(null), true)
  assert.equal(normalizeEnabled(false), false)
  assert.equal(normalizeEnabled('false'), true)
})

test('expose.mode 非法值 → 整份配置判失败，并点名服务器与合法取值', () => {
  const n = normalizeMcpServers({ servers: { jira: { url: 'https://e.com/mcp', expose: { mode: 'nope' } } } })
  assert.equal(n.ok, false)
  assert.match(n.error, /jira/)
  assert.match(n.error, /private|public|bound/)
  // 非对象 / 数组同样拒绝（放行等于把畸形值当缺省 public，那是权限放大）
  assert.equal(normalizeExpose([]).ok, false)
  assert.equal(normalizeExpose('public').ok, false)
  assert.equal(normalizeExpose(null).ok, true, 'null = 未设置 = 缺省，不算错')
})

test('bound 必须至少指定一个 agent（fail-closed 的写侧对应）', () => {
  const n = normalizeMcpServers({ servers: { j: { command: 'x', expose: { mode: 'bound', bindAgents: [] } } } })
  assert.equal(n.ok, false, 'bound 而无人可用几乎总是漏填 ⇒ 保存时就该报错，而不是保存后发现"授权了却没生效"')
  assert.match(n.error, /agent/)
  assert.equal(normalizeExpose({ mode: 'bound', bindAgents: ['a'] }).ok, true)
})

test('bound 归一化：去空项、去重、保序；空项判非法', () => {
  const ok = normalizeExpose({ mode: 'bound', bindAgents: ['a', ' a ', 'b', 'a'] })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.expose.bindAgents, ['a', 'b'], '去重保序：重复项会让界面显示重复标签')
  assert.equal(normalizeExpose({ mode: 'bound', bindAgents: ['a', ''] }).ok, false, '空项是漏填的信号')
  assert.equal(normalizeExpose({ mode: 'bound', bindAgents: 'a' }).ok, false, '必须是数组')
})

test('可见性：三档 × agentId（bound 对主会话不可见，与 dyntools 同义）', () => {
  const pub = { enabled: true, expose: { mode: 'public', bindAgents: [] } }
  const priv = { enabled: true, expose: { mode: 'private', bindAgents: [] } }
  const bound = { enabled: true, expose: { mode: 'bound', bindAgents: ['researcher'] } }
  const off = { enabled: false, expose: { mode: 'public', bindAgents: [] } }

  assert.equal(mcpVisibilityOf(pub, null), 'public')
  assert.equal(mcpVisibilityOf(pub, 'researcher'), 'public')
  assert.equal(mcpVisibilityOf(priv, null), null, '仅测试：谁都不能用（面板仍可探测）')
  assert.equal(mcpVisibilityOf(priv, 'researcher'), null)
  assert.equal(mcpVisibilityOf(bound, 'researcher'), 'bound')
  assert.equal(mcpVisibilityOf(bound, 'other'), null)
  assert.equal(mcpVisibilityOf(bound, null), null, 'bound 对主会话不可见（与 dyntools.visibilityOf 同义）')
  assert.equal(mcpVisibilityOf(off, null), null, '关闭的服务器对谁都不可见')
  assert.equal(mcpVisibilityOf(off, 'researcher'), null)
})

test('fail-closed：任何畸形输入一律不可见，绝不退化成 public', () => {
  // 归一化拦住了这些配置，但读侧可能遇到手写文件/旧版本产物 ⇒ 判定必须向"更严"一侧失败
  assert.equal(mcpVisibilityOf({ enabled: true, expose: { mode: 'bound', bindAgents: [] } }, 'x'), null)
  assert.equal(mcpVisibilityOf({ enabled: true, expose: { mode: 'bound' } }, 'x'), null)
  assert.equal(mcpVisibilityOf({ enabled: true, expose: { mode: '怪值' } }, 'x'), null, '未知 mode 一律不可见')
  assert.equal(mcpVisibilityOf(null, 'x'), null)
  assert.equal(mcpVisibilityOf(undefined, 'x'), null)
  assert.equal(mcpVisibilityOf({ enabled: true }, 'x'), 'public', '无 expose 字段 = 存量配置 = public')
})

test('配置签名：键序无关；enabled/expose/args 变化则变化', () => {
  assert.equal(
    mcpConfigSig({ s: { command: 'npx', args: ['-y', 'x'] } }),
    mcpConfigSig({ s: { args: ['-y', 'x'], command: 'npx' } }),
    '键序不该影响签名，否则重存一次配置就白重启一次内核',
  )

  const base = { s: { command: 'npx', args: [], enabled: true, expose: { mode: 'public', bindAgents: [] } } }
  const sig = mcpConfigSig(base)
  assert.match(sig, /^[0-9a-f]{16}$/)
  assert.notEqual(mcpConfigSig({ s: { ...base.s, enabled: false } }), sig, '开关变更必须触发重载')
  assert.notEqual(mcpConfigSig({ s: { ...base.s, expose: { mode: 'private', bindAgents: [] } } }), sig,
    '授权变更同样必须触发重载，否则用户改了授权看不到效果')
  assert.notEqual(mcpConfigSig({ s: { ...base.s, expose: { mode: 'bound', bindAgents: ['r'] } } }), sig)
  assert.notEqual(mcpConfigSig({ s: { ...base.s, args: ['z'] } }), sig)
  assert.equal(mcpConfigSig({}), mcpConfigSig({}))
  assert.equal(mcpConfigSig(null), mcpConfigSig({}), '空与未配置等价，避免一次空读就触发重载')
})

test('loadMcpServers 也带 enabled/expose（内核启动路径据此过滤，缺了就是"配置读到了但没生效"）', () => {
  const dir = mkTmp()
  try {
    const f = join(dir, 'mcp.json')
    writeFileSync(f, JSON.stringify({
      servers: {
        a: { command: 'node', expose: { mode: 'private' } },
        b: { command: 'node', enabled: false },
        c: { command: 'node', expose: { mode: 'bound', bindAgents: ['r'] } },
      },
    }), 'utf-8')
    const cfg = loadMcpServers(f)
    assert.equal(cfg.a.enabled, true, '未写 enabled = 开启')
    assert.deepEqual(cfg.a.expose, { mode: 'private', bindAgents: [] })
    assert.equal(cfg.b.enabled, false, '内核读取必须保留关闭状态，否则"关闭"只在 GUI 里生效')
    assert.deepEqual(cfg.c.expose, { mode: 'bound', bindAgents: ['r'] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 关闭的"占位"条目（2026-09-16，跨层不一致修复）：界面按设计放行"关闭跳过必填校验"，
// 而内核原先在 enabled 判定**之前**跑传输校验 ⇒ 同一动作被两侧给出相反答案，
// 用户新建卡片设为「关闭」后点保存只得到 400，卡在"存不下也改不掉"。
// 关闭的服务器根本不连接，故"存下『关闭』这个状态"不该以"先填出合法定义"为前提。

test('关闭 + 什么都没填 ⇒ 可保存（两侧必须给同一答案）', () => {
  const n = normalizeMcpServers({ servers: { draft: { enabled: false, expose: { mode: 'private' } } } })
  assert.equal(n.ok, true, '这是合法的"占位"：关闭的服务器不连接，不需要填出定义')
  assert.deepEqual(n.servers.draft.expose, { mode: 'private', bindAgents: [] })
  assert.equal(n.servers.draft.enabled, false)
  assert.equal(n.servers.draft.command, undefined, '占位条目不该被塞入假 command')
})

test('关闭的占位条目能被读回，且保留在 out 里（否则面板"已关闭"清单看不到它）', () => {
  const dir = mkTmp()
  try {
    const f = join(dir, 'mcp.json')
    writeFileSync(f, JSON.stringify({ servers: { draft: { enabled: false } } }), 'utf-8')
    const cfg = loadMcpServers(f)
    assert.ok(cfg.draft, '读侧丢掉它 ⇒ 注册表拿不到它 ⇒ snapshot().disabled 里没有它 ⇒ 面板显示成"不存在"')
    assert.equal(cfg.draft.enabled, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('放宽只限"什么都没填"：真错配置（含真二义）仍报错，绝不静默丢弃字段', () => {
  const mk = (v) => normalizeMcpServers({ servers: { x: v } })
  // headers 却无 url：这是填到一半的真错，若放行会把 headers 悄悄丢掉
  assert.equal(mk({ enabled: false, headers: { Authorization: 'Bearer x' } }).ok, false)
  assert.match(mk({ enabled: false, headers: { A: 'b' } }).error, /缺少 command 或 url/)
  // command 与 url 同时给出 = 真二义，与开关状态无关
  assert.equal(mk({ enabled: false, command: 'npx', url: 'https://e.com/mcp' }).ok, false)
  // env/args/cwd 同理（放行等于静默丢字段）
  assert.equal(mk({ enabled: false, env: { A: '1' } }).ok, false)
  assert.equal(mk({ enabled: false, args: ['-y'] }).ok, false)
  // url 非法仍是错（有值 ⇒ 不是占位）
  assert.equal(mk({ enabled: false, url: 'ftp://e.com' }).ok, false)
})

test('放宽只限"关闭"：启用态的空条目照旧报错（别把哑条目变成可运行服务器）', () => {
  const n = normalizeMcpServers({ servers: { x: { enabled: true } } })
  assert.equal(n.ok, false)
  assert.match(n.error, /缺少 command 或 url/)
  assert.equal(normalizeMcpServers({ servers: { x: {} } }).ok, false, '缺省开启 ⇒ 同样报错')
})

test('占位条目保留 timeoutMs（用户填过的值不该在保存时蒸发）', () => {
  const n = normalizeMcpServers({ servers: { d: { enabled: false, timeoutMs: 12345 } } })
  assert.equal(n.ok, true)
  assert.equal(n.servers.d.timeoutMs, 12345)
})
