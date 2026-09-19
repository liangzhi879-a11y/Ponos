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
//     且 `rawTypeCount === 出站出现数 + excluded.length`（提取守恒，**分母由独立重数给出**）。
//     ★ 这条断言必须是**可证伪**的：`rawTypeCount` 若与归因在同一遍循环里累加，等式恒成立、
//     永远不红（审查 M3：非 sink 处写 `{type:'zzz-typo-probe'}` 后 raw 111→112、excl 73→74，
//     断言照绿）。故 `rawTypeCount` 走**独立一遍**（自己的遍历、自己的正则、读 raw 文本），
//     而 `excluded`/`outOccurrences` 来自花括号深度归因 —— 两边独立 ⇒ 有一条没归宿就红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackedFiles, codeFiles, readTracked } from './scan.mjs'
import { extractWs, inWsDomain } from './contract-ws.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NL = String.fromCharCode(10)   // 行分隔符常量（源码里写裸转义会被编辑链吃掉）

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
  // ★ sink 之外的 `subtype:` 也是字面量（真形态 `server/workflow-host.mjs:192`、
  //   `server/workflow-routes.mjs:125`）：必须有归宿（历史实现直接 `continue` 掉 ⇒ 少算 6 条）
  'server/workflow-host.mjs': "export const toWorkflow = (id, inputs) => ({ subtype: 'run', payload: { workflow: id, inputs } })\n",
  // ★ UI 广播目标**别名**形态（真形态 `server/browser-routing.mjs:46-47`）：
  //   消息对象赋给变量，再由迭代客户端集合得到的循环变量发出 ⇒ 漏掉别名就会把
  //   `browser:event` 当"非消息"丢掉（它是真出站事件）
  'server/browser-routing.mjs': [
    'export function broadcast(sessionId, event) {',
    "  const msg = JSON.stringify({ type: 'browser:event', sessionId, event })",
    '  for (const c of clients) { try { c.send(msg) } catch {} }',
    '}',
    '',
  ].join('\n'),
  // ★ 无从归因的字面量（没有证据规则认领）**不得**被兜底桶悄悄吸收：它必须让守恒断言红
  //   （审查 M3 的探针形态）。夹具里放一条**有据**的同类字面量演示"证据规则"这一层：
  'server/entry-kind-fixture.mjs': [
    "export const listDir = (dir) => [{ name: 'a', path: dir + '/a', type: 'directory' }]",
    "export const probeTools = () => ({ tools: [{ name: 'noop', input_schema: { type: 'object', properties: {} } }] })",
    '',
  ].join('\n'),
  'server/packager-fixture.mjs': "export const skip = (f) => ({ type: 'personal', reason: `${f} 过滤 3 条敏感条目` })\n",
  // ★ stripComments 不认正则字面量（伪字符串会吞掉 `//`）⇒ 注释里的假类型必须被 raw 行拦下
  'server/leaky.mjs': ["const re = /'/", "// send({ type: 'fake_from_comment' })", 'export const x = re', ''].join('\n'),
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
  // `browser:event` 的真形态是**别名 sink**：`const msg = JSON.stringify({type:'browser:event',…})`
  // 之后 `for (const c of clients) c.send(msg)`（browser-routing.mjs:46-47）⇒ 是真出站事件。
  assert.deepEqual([...out.out].sort(), ['ack', 'bridge_hello', 'browser:event', 'cancelled', 'event', 'provider_updated'],
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
  assert.equal(out.out.has('fake_from_comment'), false, '注释行上的 type 不是字面量（raw 行兜底过滤）')
  assert.equal(out.excluded.some((e) => e.literal === 'fake_from_comment'), false, '注释里的不算 excluded 条目')
  assert.equal(out.in.has('milestones'), false,
    '`msg.type === \'milestones\'` 出现在出站低优先级判定里 —— 算成入站会让契约表说反话')
  assert.equal(out.in.has('raw'), false)
  assert.equal(out.out.has('milestones'), false, '夹具里 milestones 没有被 sink 发出（它只在出站判定里被读到）')
})

test('★提取守恒：rawTypeCount（独立重数）= 出站出现数 + excluded 条数（无归宿的必须让断言红）', () => {
  const { out, files, read } = extract()
  // 独立重数：直接数夹具源码里的 `(sub)type: '…'` 字面量个数（不依赖提取器的任何中间量）
  let literalTotal = 0
  for (const f of files) {
    const text = read(f)
    if (typeof text !== 'string') continue
    for (const line of text.split(NL)) {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue   // 注释行不是代码（raw 行口径，与提取器独立实现）
      literalTotal += (line.match(/(?:^|[^\w.$])(?:sub)?type\s*:\s*'/g) || []).length
    }
  }
  assert.ok(literalTotal >= 8, `夹具至少应有 8 个 type 字面量，实测 ${literalTotal}`)
  assert.equal(out.rawTypeCount, literalTotal, 'rawTypeCount 必须等于域内 (sub)type 字面量的独立重数')
  // ★ 守恒等式两侧来自**两条独立代码路径**（左=独立重数，右=花括号深度归因），故可证伪：
  //   任何"没被任何规则认领"的字面量都会让左边多 1 而右边不动 ⇒ 红。
  //   ―― 历史实现里这一等式是**构造恒等式**（同一遍循环两处累加），M3 探针插进去照绿。
  assert.equal(out.rawTypeCount, out.outOccurrences + out.excluded.length,
    `守恒破裂：raw=${out.rawTypeCount} 出站出现=${out.outOccurrences} excluded=${out.excluded.length}｜无归宿=${out.unattributed.map((u) => `${u.literal}@${u.file}:${u.line}`).join(' ')}`)
  assert.deepEqual(out.unattributed, [], '没有归宿的字面量必须为 0（每条字面量要么进 out 要么进 excluded）')
  // 出站侧的出现数：夹具里 sink 白名单命中 6 处：
  // bridge_hello / ack / cancelled / event / provider_updated（BRIDGE）+ browser:event（别名 sink）
  assert.equal(out.outOccurrences, 6,
    `出站出现数应为 6｜out=${[...out.out].join(',')}｜excluded=${out.excluded.map((e) => `${e.literal}@${e.file}:${e.line}`).join(' ')}`)
})

test('★sink 外的 `subtype:` 也有归宿（真形态 workflow-host.mjs:192 / workflow-routes.mjs:125）', () => {
  const { out } = extract()
  const host = out.excluded.find((e) => e.literal === 'run' && e.file === 'server/workflow-host.mjs')
  assert.ok(host, 'sink 外的 subtype（消息子命令名）必须进 excluded（历史实现 `continue` 掉 ⇒ 少算 6 条字面量）')
  assert.match(host.reason, /^subtype-elsewhere/)
  assert.equal(out.out.has('run'), false)
  assert.equal(out.in.has('run'), false)
})

test('★sink 别名形态：`for (const c of clients) c.send(msg)` 是 GUI 广播目标（真形态 browser-routing.mjs:46-47）', () => {
  const { out } = extract()
  assert.equal(out.out.has('browser:event'), true,
    '别名 sink（迭代客户端集合得到的循环变量 `.send(`）发出的消息是真出站事件，不得当"非消息"丢掉')
  assert.equal(out.excluded.some((e) => e.literal === 'browser:event'), false, '认领关系与 excluded 互斥')
  // 反向：执行器/内核的私有通道**不得**因为别名规则被算成 out（方向错比漏一条更贵）
  for (const wrong of ['app:exec', 'user', 'loop_command', 'mouseMoved', 'anchor_applied', 'send']) {
    assert.equal(out.out.has(wrong), false, `${wrong} 不是 GUI 出站事件`)
  }
})

test('★excluded 不得含兜底桶：reason 全部是有据分类（plan §7 反例 ⑥）', () => {
  // 兜底语义的桶名黑名单（**不许**把"其余全部"换个名字继续用）
  const FALLBACK_REASONS = ['non-message', 'other', 'others', 'misc', 'rest', 'remainder', 'unknown',
    'unclassified', 'fallback', 'catchall', 'catch-all', '其余', '其他', '其余全部', '其他全部', '其他东西']
  const { out } = extract()
  const reasons = [...new Set(out.excluded.map((e) => e.reason.split('：')[0]))].sort()
  for (const r of reasons) {
    assert.equal(FALLBACK_REASONS.includes(r), false,
      `reason '${r}' 是兜底桶语义（不是有据分类）｜现有 reason 集合=${reasons.join(',')}`)
  }
  // 真仓同一判据（夹具只覆盖夹具形态；兜底桶在真仓里更可能先冒出来）
  const realFiles = codeFiles(trackedFiles({ root: ROOT }), { includeTests: false })
  const real = extractWs({ files: realFiles, readTracked: (f) => readTracked({ root: ROOT, file: f }) })
  const realReasons = [...new Set(real.excluded.map((e) => e.reason.split('：')[0]))].sort()
  for (const r of realReasons) {
    assert.equal(FALLBACK_REASONS.includes(r), false,
      `真仓 reason '${r}' 是兜底桶语义｜真仓 reason 集合=${realReasons.join(',')}`)
  }
  assert.ok(realReasons.length >= 6, `真仓必须拆细成多个有据分类，实测 ${realReasons.join(',')}`)
  // 有据分类必须**逐条**落到证据上：条目 kind / JSON Schema 各自独立成类
  const bySlash = (p) => out.excluded.filter((e) => e.literal === p)
  assert.deepEqual(bySlash('directory').map((e) => e.reason.split('：')[0]), ['entry-kind'])
  assert.deepEqual(bySlash('object').map((e) => e.reason.split('：')[0]), ['json-schema'])
  assert.deepEqual(bySlash('personal').map((e) => e.reason.split('：')[0]), ['packager-manifest'])
  assert.deepEqual(bySlash('run').map((e) => e.reason.split('：')[0]), ['subtype-elsewhere'])
  assert.ok(out.excluded.some((e) => /^subtype-elsewhere/.test(e.reason)), 'sink 外 subtype 单列成类')
})

test('★无归宿的字面量必须让守恒断言红（自证式断言的替代品；审查 M3 的判据）', () => {
  // 非 sink 处写一个假类型：它**没有任何证据规则认领** ⇒ 必须进 unattributed，
  // 且等式 `rawTypeCount === outOccurrences + excluded.length` 必须**不成立**。
  // （历史实现：raw 与归因同一遍累加 ⇒ 等式恒成立、探针插进去照绿 —— 这个用例就是钉它。）
  const fx = fixture({ ...FIXTURE, 'server/zzz-typo.mjs': "export const probe = { type: 'zzz-typo-probe' }\n" })
  const files = codeFiles(trackedFiles({ root: fx.root }), { includeTests: false })
  const out = extractWs({ files, readTracked: fx.read })
  assert.deepEqual(out.unattributed.map((u) => `${u.literal}@${u.file}:${u.line}`), ['zzz-typo-probe@server/zzz-typo.mjs:1'],
    '无归宿的字面量必须被显式列出（不得默认丢进某个兜底桶）')
  assert.equal(out.excluded.some((e) => e.literal === 'zzz-typo-probe'), false, '没证据就不许写成 excluded 条目')
  assert.notEqual(out.rawTypeCount, out.outOccurrences + out.excluded.length,
    '守恒被打破时必须**真的**不相等（相等 = 等式是构造恒等式，判据失效）')
  assert.equal(out.rawTypeCount, out.outOccurrences + out.excluded.length + out.unattributed.length)
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
  // ★ 守恒真仓版：分母（rawTypeCount）由**独立重数**给出 —— 现场照 raw 文本重数一遍
  let recount = 0
  for (const f of files) {
    if (!inWsDomain(f)) continue
    const text = readTracked({ root: ROOT, file: f })
    if (typeof text !== 'string') continue
    for (const line of text.split(NL)) {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue
      recount += (line.match(/(?:^|[^\w.$])(?:sub)?type\s*:\s*'/g) || []).length
    }
  }
  assert.equal(out.rawTypeCount, recount, 'rawTypeCount 必须等于域内字面量独立重数（不是归因那一遍的副产品）')
  assert.equal(out.rawTypeCount, out.outOccurrences + out.excluded.length,
    `守恒破裂：raw=${out.rawTypeCount} 出站出现=${out.outOccurrences} excluded=${out.excluded.length}｜无归宿=${out.unattributed.map((u) => `${u.literal}@${u.file}:${u.line}`).join(' ')}`)
  assert.deepEqual(out.unattributed, [], '真仓每个 `(sub)type:` 字面量都必须有归宿（无归宿 ⇒ 提取器漏了一类形态）')
  // sink 外 subtype 的归宿（历史少算的 6 条）必须在真仓里可见
  assert.ok(out.excluded.filter((e) => /^subtype-elsewhere/.test(e.reason)).length >= 2,
    `真仓 sink 外 subtype 至少 2 条（workflow-host.mjs / workflow-routes.mjs），实测 ${JSON.stringify(out.excluded.filter((e) => /^subtype-elsewhere/.test(e.reason)))}`)
})
