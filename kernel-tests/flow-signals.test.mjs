import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractFlowSignals, mineFlowCandidates, targetOf, flowCandidateId, FLOW_THRESHOLDS } from '../kernel/flow-signals.mjs'

/** 造一行 transcript（形态与 kernel/tui.mjs#readTranscriptHistory 认的一致） */
const userLine = (text, ts = '2026-10-27T10:00:00.000Z') => ({ timestamp: ts, message: { role: 'user', content: text } })
const bashLine = (command, ts = '2026-10-27T10:00:01.000Z') => ({
  timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
})

test('P5b 信号层：从 transcript 行抽 Bash 命令与版式信号词', () => {
  const s = extractFlowSignals([
    userLine('把这些整理成表格吧'),
    bashLine('curl -s https://api.vendor.io/v1/orders'),
    bashLine('echo hi'),
    { timestamp: null, message: { role: 'user', content: [{ type: 'text', text: '再出一个看板' }] } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }] } },
  ], { sessionId: 's1' })
  assert.equal(s.commands.length, 2, '只认 Bash')
  assert.equal(s.commands[0].target, 'api.vendor.io')
  assert.deepEqual(s.layoutHits.map((h) => h.word), ['表格', '看板'])
  assert.ok(s.layoutHits.every((h) => h.sessionId === 's1'))
})

test('P5b target 只认 URL 主机；没有主机 ⇒ 空（真机实测把 `cd` 推上榜首的教训）', () => {
  assert.equal(targetOf('curl -X POST https://Pay.Vendor.io:8443/api?x=1'), 'pay.vendor.io')
  // shell 内命令不是"外部系统"：`cd` 曾以 33279 次/266 会话霸榜，那是噪声不是需求
  assert.equal(targetOf('  git   status  '), '')
  assert.equal(targetOf('cd /x && npm test'), '')
  // 回环地址不是"外部系统"：那是我们自己的 bridge，照它出 MCP 草稿毫无意义
  assert.equal(targetOf('curl http://127.0.0.1:28717/health'), '')
  assert.equal(targetOf('curl http://localhost:3000/x'), '')
  assert.equal(targetOf(''), '')
})

test('P5b OPP-14a：调用数/跨会话/不同命令三个门**同时**过才出候选', () => {
  const th = FLOW_THRESHOLDS['OPP-14a']
  const mk = (n, sessions, distinct) => {
    const commands = []
    for (let i = 0; i < n; i += 1) {
      commands.push({
        sessionId: `s${i % sessions}`,
        ts: '2026-10-27T10:00:00.000Z',
        command: `curl https://api.vendor.io/v${i % distinct}`,
        target: 'api.vendor.io',
      })
    }
    return mineFlowCandidates({ commands })
  }
  // 差一个：调用数不足
  assert.equal(mk(th.minCalls - 1, 3, th.minCommands).length, 0)
  // 差一个：只有单会话
  assert.equal(mk(th.minCalls + 2, 1, th.minCommands).length, 0)
  // 差一个：命令全一样（同一个动作重复 ≠ 一条操作序列）
  assert.equal(mk(th.minCalls + 2, 3, th.minCommands - 1).length, 0)
  // 三者都满足
  const ok = mk(th.minCalls + 2, 3, th.minCommands)
  assert.equal(ok.length, 1)
  assert.equal(ok[0].ruleId, 'OPP-14a')
  assert.equal(ok[0].subject, 'api.vendor.io')
  assert.equal(ok[0].metrics.distinctCommands, th.minCommands)
  assert.ok(ok[0].metrics.freqRatio > 1, '超过阈值 ⇒ 强度 > 1')
})

test('P5b OPP-14b：同会话里同一个词说两遍只算一次；必须跨会话', () => {
  const hits = (spec) => spec.flatMap(([sid, words]) => words.map((word) => ({ sessionId: sid, ts: null, word })))
  // 一个会话里"表格"说 3 遍 ⇒ 1 次；不够跨会话 ⇒ 不出
  assert.equal(mineFlowCandidates({ layoutHits: hits([['s1', ['表格', '表格', '表格']]]) }).length, 0)
  // 两个会话各一次 ⇒ 出，且必须要求 ui
  const ok = mineFlowCandidates({ layoutHits: hits([['s1', ['表格']], ['s2', ['表格']]]) })
  assert.equal(ok.length, 1)
  assert.equal(ok[0].ruleId, 'OPP-14b')
  assert.equal(ok[0].metrics.requiresUi, true, '14b 的产物必须带 ui（版式从 L3 里选）')
})

test('P5b 输出稳定：同强度按规则、主题排序（台账不能因输入顺序而漂）', () => {
  const commands = []
  for (const host of ['b.io', 'a.io']) {
    for (let i = 0; i < 7; i += 1) {
      commands.push({ sessionId: `s${i % 2}`, ts: null, command: `curl https://${host}/${i % 3}`, target: host })
    }
  }
  const a = mineFlowCandidates({ commands })
  const b = mineFlowCandidates({ commands: [...commands].reverse() })
  assert.deepEqual(a.map((c) => c.subject), b.map((c) => c.subject))
  assert.deepEqual(a.map((c) => c.subject), ['a.io', 'b.io'])
})

test('P5b 候选 id 与既有规则同规则（sha256 前 12 位，跨扫描可归并）', () => {
  assert.equal(flowCandidateId('OPP-14a', 'api.vendor.io'), flowCandidateId('OPP-14a', 'api.vendor.io'))
  assert.notEqual(flowCandidateId('OPP-14a', 'a.io'), flowCandidateId('OPP-14b', 'a.io'))
  assert.match(flowCandidateId('OPP-14a', 'x'), /^[0-9a-f]{12}$/)
})
