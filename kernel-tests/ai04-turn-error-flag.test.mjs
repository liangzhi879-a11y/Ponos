// AI-04 修复验证（P2）：故障轮的 outcome 与正常轮同形，下游无法区分"回答了"与"崩了"。
//
// 【缺陷实况（kernel/engine.mjs 的 runTurn catch 块，修前）】
//   ```js
//   pushMemory({ role: 'assistant', content: `【系统】本轮执行出现内部错误：${errMsg}` })
//   outcome = { usage: null, model: ..., text: errText }
//   ```
//   两个后果：
//   ① **错误文本被写进对话记忆**（非 session 模式下）：下一轮模型会把它当成
//      "自己刚才说过的话"，越错越偏 —— 错误自我强化。错误是**事件**不是**内容**。
//   ② **outcome 没有 isError**：下游（GUI 状态 / 用量统计 / 诊断 / OPP 演进环）
//      无法区分"模型正常回答了"与"本轮内部崩了"。
//      实测影响：演进环把故障轮当正常轮计入统计 ⇒ 错误率被稀释，真实故障看起来像正常波动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENGINE = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')
/** 剥整行注释（本仓纪律：修复说明里会合法引用旧写法） */
const strip = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const SRC = strip(ENGINE)

test('★ AI-04：故障轮必须打 isError 标记（下游才能区分"崩了"与"答了"）', () => {
  const i = SRC.indexOf('本轮执行出现内部错误')
  assert.ok(i > -1, '必须有故障轮的错误提示文案')
  // 取该文案之后的 outcome 赋值块
  const tail = SRC.slice(i, i + 1600)
  assert.match(tail, /isError:\s*true/,
    '故障轮的 outcome 必须带 isError:true —— 原来它与正常轮结构相同，'
    + '下游（GUI/统计/诊断/演进环）无法区分"本轮崩了"')
  assert.match(tail, /errorKind/,
    '必须带 errorKind（timeout/internal…）—— 只说"失败了"无法指导排查')
})

test('★ AI-04：错误文本**不得**写进对话记忆（否则模型会自我强化错误）', () => {
  const i = SRC.indexOf('本轮执行出现内部错误')
  const tail = SRC.slice(Math.max(0, i - 800), i + 800)
  assert.ok(!/pushMemory\(\s*\{\s*role:\s*'assistant'[^}]*内部错误/.test(tail),
    '错误文本不得 pushMemory 进对话记忆 —— 错误是**事件**不是**内容**，'
    + '写进记忆后下一轮模型会把它当成"自己说过的话"，越错越偏')
})

test('★ AI-04：故障标记必须透出到轮次统计（否则统计口径把故障算成正常）', () => {
  const i = SRC.indexOf('turnStats.push(')
  assert.ok(i > -1, '必须有 turnStats.push')
  const block = SRC.slice(i, i + 900)
  assert.match(block, /outcome\.isError/,
    'turnStats 必须带上故障标记 —— 否则用量/健康度/演进环把"本轮崩了"'
    + '当成"模型正常回答"计入，错误率被稀释')
})

test('★ AI-04：故障标记必须透出到 runTurn 返回值（调用方可判断）', () => {
  // 找 return { usage: outcome.usage, ... } 那个块
  const i = SRC.indexOf('return {\n        usage: outcome.usage')
  assert.ok(i > -1, '必须有 runTurn 的返回值块')
  const block = SRC.slice(i, i + 700)
  assert.match(block, /outcome\.isError/,
    'runTurn 返回值必须透出 isError —— 调用方（loop 控制器/CLI/演进环）'
    + '应据此判断本轮成败，而不是去匹配错误文本（文本会变，中英文都可能）')
})

test('★ AI-04：正常轮不得被误标为失败（反向守卫）', () => {
  // 正常轮（成功路径）不得出现无条件 isError:true
  const successIdx = SRC.indexOf("wire.result(outcome.usage")
  const near = SRC.slice(Math.max(0, successIdx - 2500), successIdx)
  // 允许出现 `outcome.isError ? {...}` 这种条件展开，但不允许裸赋值 `isError: true` 在成功路径上无条件写死
  const bad = /outcome\.isError\s*=\s*true/.test(near)
  assert.ok(!bad, '不得在成功路径上无条件把 isError 置 true')
})
