// kit/lib/contract-ws.test.mjs —— T2 WS 事件提取器（DevKit P1 · 契约快照）
//
// 为什么必须有这些断言：
//   · **裸抓 `type:` 必错**（D6）：内核 stdin 的 `type:'user'`/`'loop_command'`、执行器的
//     `type:'mouseMoved'`、`event.data.type` 里的嵌套 `'system'` 都不是 GUI 事件 ⇒
//     出站集合**只认发送函数白名单**（`send()` / `broadcastGui()` / `sendToThis()` / `ws.send()`）。
//   · `first_byte_pending` 是**嵌套**（`{type:'event',data:{type:'system',subtype:'first_byte_pending'}}`）
//     ⇒ 不得出现在顶层出站集合里。
//   · 入站集合只认 `ws.on('message')` 处理器里的 `msg.type === '…'`：同一个 `msg.type === 'milestones'`
//     写法出现在**出站判定**（isLowPriorityMessage）里就不能算入站（方向搞反会让契约表说反话）。
//   · "提取不到 ≠ 不存在"：每个没进集合的 `type:` 字面量都要在 excluded 里带 reason，
//     且 `rawTypeCount === 出站出现数 + excluded.length`（提取守恒，夹具里独立重数一遍）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackedFiles, codeFiles, readTracked } from './scan.mjs'
import { extractWs } from './contract-ws.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function fixture(filesMap) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-ct-ws-'))
  for (const [rel, content] of Object.entries(filesMap)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return { root, read: (file) => readTracked({ root, file }) }
}

const BRIDGE = [
  '// 出站三处 sink（真形态 bridge.mjs:2132 / :994 / :3341）',
  "function send(msg) { for (const c of wsClients) c.send(JSON.stringify(msg)) }",
  "function broadcastGui(msg) { for (const c of wsClients) c.send(JSON.stringify(msg)) }",
  'function onConnect(ws, sessions) {',
  "  try { ws.send(JSON.stringify({ type: 'bridge_hello', id: BRIDGE_INSTANCE_ID })) } catch {}",
  "  ws.on('message', (raw) => {",
  '    const msg = JSON.parse(raw.toString())',
  "    if (msg.type === 'executor:hello') {",
  '      register()',
  "    } else if (msg.type === 'send') {",
  "      session.proc.stdin.write(JSON.stringify({",
  "        type: 'user',",
  '        message: { role: "user", content: msg.prompt },',
  "      }) + '\\n')",
  "      send({ type: 'ack', data: { requestId: msg.requestId } })",
  "    } else if (msg.type === 'cancel') {",
  "      s.proc.stdin.write(JSON.stringify({ type: 'loop_command', op: 'stop', args: [] }) + '\\n')",
  "      send({ type: 'cancelled', data: { sessionId: sid } })",
  '    }',
  '  })',
  '}',
  "if (busy) send({ type: 'event', data: { type: 'system', subtype: 'first_byte_pending', silentMs: 1 }, sessionId: sid })",
  "broadcastGui({ type: 'provider_updated', data: { providerId: id, updates, notes } })",
  "function isLowPriorityMessage(msg) {",
  "  if (msg.type === 'milestones' || msg.type === 'raw') return true",
  "  if (msg.type === 'event' && msg.data && msg.data.type === 'system') return true",
  '  return false',
  '}',
  '',
].join('\n')

const FIXTURE = {
  'server/bridge.mjs': BRIDGE,
  'server/health-anchor.mjs': "export const buildAnchor = (sid, list) => ({ sessionId: sid, message: { type: 'anchor_applied', issueIds: list } })\n",
  'server/app-routing.mjs': "executor.send(JSON.stringify({ type: 'app:exec', requestId, sessionId, payload }))\n",
  'server/interject.e2e.mjs': "ws.send(JSON.stringify({ type: 'send', prompt: '你好', sessionId: sid }))\n",
  'electron/browser-executor.cjs': "await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.cx, y: box.cy })\n",
}

function extract(filesMap = FIXTURE) {
  const fx = fixture(filesMap)
  const files = codeFiles(trackedFiles({ root: fx.root }), { includeTests: false })
  return { ...fx, files, out: extractWs({ files, readTracked: fx.read }) }
}

test('★出站只认发送函数白名单：内核 stdin / 执行器 / 嵌套 一律不进集合', () => {
  const { out } = extract()
  assert.deepEqual([...out.out].sort(), ['ack', 'bridge_hello', 'cancelled', 'event', 'provider_updated'],
    '出站集合必须恰好是 sink 白名单里那些（多一个 = 把别人的协议当 GUI 事件）')
  for (const wrong of ['user', 'loop_command', 'anchor_applied', 'mouseMoved', 'app:exec', 'first_byte_pending', 'system']) {
    assert.equal(out.out.has(wrong), false, `${wrong} 不是 GUI 出站事件，不得进 out`)
  }
})

test('★内核 stdin / 执行器协议 / 反向脚本 逐条进 excluded 且带 reason', () => {
  const { out } = extract()
  const by = (lit) => out.excluded.filter((e) => e.literal === lit)
  assert.deepEqual(by('user').map((e) => e.file), ['server/bridge.mjs'])
  assert.match(by('user')[0].reason, /^kernel-stdin/)
  assert.match(by('loop_command')[0].reason, /^kernel-stdin/)
  assert.match(by('anchor_applied')[0].reason, /^kernel-stdin/,
    'message:{type:…} 形态是内核 stdin 消息（构造点在 server/health-anchor.mjs，发送点在 bridge）')
  assert.match(by('mouseMoved')[0].reason, /^executor-protocol/)
  assert.match(by('app:exec')[0].reason, /^executor-protocol/)
  assert.match(by('send')[0].reason, /^client-harness/,
    'interject.e2e.mjs 的 ws.send 是"发给桥"（方向相反），不是桥的广播')
  for (const e of out.excluded) {
    assert.match(e.reason, /^[a-z-]+：/, `reason 必须带可机读前缀：${JSON.stringify(e)}`)
    assert.ok(e.file && e.line > 0)
    assert.equal(/其余|其他全部|rest of/i.test(e.reason), false, '禁止兜底条目')
  }
})

test('★first_byte_pending 判为嵌套：不进顶层，但在 excluded 里能查到', () => {
  const { out } = extract()
  assert.equal(out.out.has('first_byte_pending'), false)
  assert.equal(out.in.has('first_byte_pending'), false)
  const nested = out.excluded.filter((e) => e.literal === 'first_byte_pending')
  assert.equal(nested.length, 1)
  assert.match(nested[0].reason, /^nested/)
  assert.equal(nested[0].file, 'server/bridge.mjs')
  // 同一条消息的顶层类型照常入集（`event` 是出站）
  assert.equal(out.out.has('event'), true)
})

test('★入站只认 ws.on("message") 处理器里的 msg.type 比较（方向不得反）', () => {
  const { out } = extract()
  assert.deepEqual([...out.in].sort(), ['cancel', 'executor:hello', 'send'])
  assert.equal(out.in.has('milestones'), false,
    '`msg.type === \'milestones\'` 出现在出站低优先级判定里 —— 算成入站会让契约表说反话')
  assert.equal(out.in.has('raw'), false)
  assert.equal(out.out.has('milestones'), false, '夹具里 milestones 没有被 sink 发出（它只在出站判定里被读到）')
})

test('★提取守恒：rawTypeCount = 出站出现数 + excluded 条数（夹具里独立重数一遍）', () => {
  const { out, files, read } = extract()
  // 独立重数：直接数夹具源码里的 `type: '…'` 字面量个数（不依赖提取器的任何中间量）
  let literalTotal = 0
  for (const f of files) {
    const text = read(f)
    if (typeof text !== 'string') continue
    literalTotal += (text.match(/type\s*:\s*'/g) || []).length
  }
  assert.ok(literalTotal >= 8, `夹具至少应有 8 个 type 字面量，实测 ${literalTotal}`)
  assert.equal(out.rawTypeCount, literalTotal, 'rawTypeCount 必须等于域内 type 字面量总出现数')
  // 出站侧的出现数：每条 out 类型至少 1 处 sink 命中，加上 excluded 正好守恒
  // 夹具里 sink 白名单命中 5 处：bridge_hello / ack / cancelled / event / provider_updated
  // ⇒ 其余 8 条字面量必须**逐条**在 excluded 里（守恒不是"剩下的都算排除"，要条数对得上）
  assert.equal(out.rawTypeCount - out.excluded.length, 5,
    `出站出现数=${out.rawTypeCount - out.excluded.length}（应为 5）｜out=${[...out.out].join(',')}｜excluded=${out.excluded.map((e) => `${e.literal}@${e.file}:${e.line}`).join(' ')}`)
})

test('真仓：出站 26 / 入站 16 量级，且集合与排除清单都能复算', () => {
  const files = codeFiles(trackedFiles({ root: ROOT }), { includeTests: false })
  const out = extractWs({ files, readTracked: (f) => readTracked({ root: ROOT, file: f }) })
  for (const t of ['ack', 'closed', 'kernel-stall', 'bridge_hello', 'pong', 'workflow_event',
    'approval-mode-changed', 'knowledge_changed', 'provider_updated', 'question', 'milestones']) {
    assert.ok(out.out.has(t), `真仓出站事件 ${t} 必须提取到（实测 out=${out.out.size}）`)
  }
  for (const t of ['send', 'cancel', 'answer', 'approval-response', 'browser_control', 'ping', 'effort', 'app:exec:response']) {
    assert.ok(out.in.has(t), `真仓入站消息 ${t} 必须提取到（实测 in=${out.in.size}）`)
  }
  assert.ok(out.out.size >= 24, `出站事件应在 26 条量级（P1 计划记 26），实测 ${out.out.size}`)
  assert.ok(out.in.size >= 14, `入站消息应在 16 条量级（P1 计划记 16），实测 ${out.in.size}`)
  assert.equal(out.out.has('user') || out.in.has('user'), false, '内核 stdin 的 user 不是 GUI 协议')
  assert.equal(out.out.has('first_byte_pending'), false)
  assert.ok(out.rawTypeCount > out.out.size, '真仓 type 字面量总出现数必须显著大于出站集合（否则守恒无意义）')
  assert.ok(out.excluded.length >= 20, `真仓不可提取区必须逐条登记，实测 ${out.excluded.length}`)
})
