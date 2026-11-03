// 失败测试（**先写、先红**）：EVO-08 —— OPP-1「工具失败热点」把「命令正常非零退出」计成「工具故障」。
//
// 根因链（Phase 1 已核实，行号即证据）：
//   kernel/tools.mjs:146        Bash 前台：`finish(body, code !== 0)` ⇒ 非零退出即 isError
//   kernel/engine.mjs:1728      is_error 原样写进 tool_result
//   kernel/trace-project.mjs:133  `if (b.is_error !== true) continue` ⇒ 所有 is_error 计入 failures
//   kernel/opportunity-mine.mjs:437  OPP-1 直接拿它当分子算 errRate
//   ⇒ `grep` 无匹配（exit 1）、`test` 不成立、`diff` 有差异、**故意跑失败的测试** 全被算成"工具故障"
//
// 为什么这是缺陷而不是"设计如此"：Bash 的 isError 面向**模型**（提示"这条命令没成功"），
//   对模型是正确语义；但 OPP-1 面向**统计**（"工具本身反复出问题"），两者不是同一个概念。
//   本仓已有同款判断的先例：`meta.timeout` 就是为区分"长命令在忙"与"真失败"而加的（engine.mjs:1730 注释）。
//
// ★ 修复方向（不得碰 tools.mjs 的 isError 语义，模型侧依赖它）：
//   在**投影期**按 tool_result 的内容把失败分流 —— 命令非零 vs 工具级异常；
//   OPP-1/OPP-7 只用「工具级异常」做分子。
//
// 判别依据（确定性、纯函数）：Bash 非零退出时 content 恒以 `退出码 <N>` 开头（tools.mjs:143-146）。
//   命令超时 → `命令超时（<ms>ms）`；启动失败 → `命令启动失败：…`。三者可区分。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectSession, summarizeRecords } from '../kernel/trace-project.mjs'
import { mineCandidates } from '../kernel/opportunity-mine.mjs'

const entry = (o, { seq, min }) => ({
  type: o.type, seq, timestamp: `2026-10-17T10:${String(min).padStart(2, '0')}:00.000Z`,
  sessionId: 's1', message: o.message, surfaceOp: o.surfaceOp || 'append',
})

/** tool_use：assistant 发起一次工具调用 */
const toolUse = (id, name, seq, min) => entry({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
}, { seq, min })

/** tool_result：is_error + **content**（content 决定失败类别，这是本次修复的判据来源） */
const toolResult = (id, isError, content, seq, min) => entry({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? content : 'ok', is_error: isError }] },
}, { seq, min })

/**
 * 造一个会话：ok 次成功、exit1 次「grep 无匹配」这类正常非零、fault 次工具级异常（超时）。
 * ★ 夹具陷阱（2026-10-17 实测踩到）：id 必须**先算好再自增**，否则 tool_use 与 tool_result 的
 *   id 错配 ⇒ 投影期 `toolNameById.get()` 取不到 ⇒ 失败全归到 'unknown' 工具，
 *   于是"OPP-1 不产候选"这类断言会**假绿**（被测对象根本没被命中）。测试通过前必须确认命中的是 Bash。
 */
function makeSession({ exit1 = 0, fault = 0, ok = 0 }) {
  const list = []
  let n = 0
  const add = (mk) => list.push(mk)
  let min = 0
  for (let i = 0; i < ok; i++) {
    const id = `u${n}`
    add(toolUse(id, 'Bash', n + 1, min))
    add(toolResult(id, false, '输出', n + 2, min))
    n += 2; min += 1
  }
  for (let i = 0; i < exit1; i++) {
    const id = `u${n}`
    add(toolUse(id, 'Bash', n + 1, min))
    // ★ 关键：Bash 正常非零的形状 —— tools.mjs:144 生成的 `退出码 1\n<out>`
    add(toolResult(id, true, '退出码 1\n(无输出)', n + 2, min))
    n += 2; min += 1
  }
  for (let i = 0; i < fault; i++) {
    const id = `u${n}`
    add(toolUse(id, 'Bash', n + 1, min))
    // 工具级异常：超时（tools.mjs 超时路径 / stream-runtime.withToolDeadline）
    add(toolResult(id, true, '命令超时（120000ms）', n + 2, min))
    n += 2; min += 1
  }
  return list
}

test('★ EVO-08：投影期必须把「命令非零退出」与「工具级异常」分开计数', () => {
  const rec = projectSession('s1', makeSession({ ok: 2, exit1: 3, fault: 1 }))
  const bash = (rec.tools.errors || []).find((e) => e.tool === 'Bash')
  assert.ok(bash, 'Bash 必须出现在 errors 里（它确实有 is_error）')
  assert.equal(bash.count, 4, 'count 仍应是全部 is_error（向后兼容：既有消费方口径不变）')
  // ★ 新增两个细分字段（本次修复的核心）
  assert.equal(bash.commandNonZero, 3, `正常非零（退出码 1）应计 3，实得 ${bash.commandNonZero}`)
  assert.equal(bash.toolFault, 1, `工具级异常（超时）应计 1，实得 ${bash.toolFault}`)
})

test('★ EVO-08：非 Bash 工具的 is_error 一律算工具级异常（没有"正常非零"概念）', () => {
  const list = []
  let seq = 1
  for (let i = 0; i < 2; i++) {
    list.push(toolUse(`r${seq}`, 'Read', seq, i)); seq++
    list.push(toolResult(`r${seq - 1}`, true, '文件不存在', seq, i)); seq++
  }
  const rec = projectSession('s1', list)
  const r = (rec.tools.errors || []).find((e) => e.tool === 'Read')
  assert.equal(r.toolFault, 2, 'Read 的失败全是工具级异常')
  assert.equal(r.commandNonZero, 0, 'Read 不应有"命令非零"分类')
})

test('★ EVO-08：OPP-1 的分子只取工具级异常 ⇒ 纯"命令非零"不再造出假热点', () => {
  // 一个会话：Bash 被调用 40 次，其中 20 次是 grep/diff 的正常非零，0 次真故障。
  // 旧口径：failures=20 / calls=40 = 50% ≥ 15% ⇒ 产出"Bash 工具失败热点"（假）。
  // 新口径：toolFault=0 / calls=40 = 0% ⇒ 不产候选。
  const rec = projectSession('s1', makeSession({ ok: 20, exit1: 20, fault: 0 }))
  const sum = summarizeRecords([rec])
  const cands = mineCandidates([rec], { nowMs: Date.parse('2026-10-17T12:00:00.000Z'), windowDays: 30, existingPatterns: [], summary: sum })
  const hot = cands.filter((c) => c.ruleId === 'OPP-1' && (c.metrics?.tools || [c.subject]).includes?.('Bash'))
  const bashCand = cands.filter((c) => c.ruleId === 'OPP-1' && String(c.subject) === 'Bash')
  assert.equal(bashCand.length, 0,
    `纯命令非零不应产出 OPP-1 热点；实得 ${bashCand.length} 条（metrics=${JSON.stringify(bashCand[0]?.metrics)}）`)
})

test('★ EVO-08：真工具级异常仍要产出热点（修复不能把真信号一起压掉）', () => {
  const rec = projectSession('s1', makeSession({ ok: 5, exit1: 0, fault: 12 }))
  const sum = summarizeRecords([rec])
  const cands = mineCandidates([rec], { nowMs: Date.parse('2026-10-17T12:00:00.000Z'), windowDays: 30, existingPatterns: [], summary: sum })
  const bash = cands.filter((c) => c.ruleId === 'OPP-1' && String(c.subject) === 'Bash')
  assert.equal(bash.length, 1, '12 次工具级异常 / 17 次调用 = 71% 必须产出热点（真信号不能被压掉）')
})
