// T2.1（治理计划 2026-10-20-token-context-governance）：工具结果内联采样（头 + 尾）。
//
// 问题（问0）：超阈值工具结果会全文落盘，但内联预览原来是 `slice(0, 2000)` —— **只留开头**。
// 而 Bash / 测试 / 构建类输出的关键信息几乎总在**结尾**（退出码汇总、失败用例名、`npm ERR!`、
// 构建报错）。只给开头等于"让你看日志前 2000 字，报错自己读文件找" ⇒ 模型要么重跑命令、
// 要么盲读整文件 —— 成本与质量双输。
//
// 改法：预览改成**头 2,000 + 尾 4,000**，交界给显式省略标记 + 恢复路径；内联阈值默认
// 20,000 → 8,000 字符（**仍全文落盘 ⇒ 无损**）；`PONOS_TOOL_RESULT_BUDGET_BYTES=20000` 一行回退。
//
// 本文件钉住 6 条（前 3 条在改动前必红）：
//   ① ★ 长内容采样后必须**同时**含开头与结尾（旧实现只有开头 ⇒ 尾断言必红）
//   ② ★ 采样必须给出省略标记与"省略了多少字符"（否则模型以为看到了全部）
//   ③ ★ 内联体积 ≤ 12,000 字符（计划约束）
//   ④ 短内容零变化（"采样"不该在没超阈值时引入任何字符）
//   ⑤ 头尾预算可配，且 0 预算不炸（head=0 时只有尾）
//   ⑥ 非字符串输入不抛（工具结果偶尔给对象/undefined）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sampleToolOutput, SAMPLE_MARKER } from '../kernel/result-sample.mjs'

/** 造一段"头尾可分"的长文本：开头 START、中段填充、结尾 END/报错 */
function longText(n = 50_000) {
  return 'START-OF-OUTPUT\n' + 'x'.repeat(n) + '\nFAILED tests: 3\nEND-OF-OUTPUT'
}

test('★★ ① 长内容采样后必须同时含开头与结尾（旧实现只有开头）', () => {
  const src = longText()
  const r = sampleToolOutput(src, { headChars: 2000, tailChars: 4000 })
  assert.equal(r.sampled, true)
  assert.ok(r.text.startsWith('START-OF-OUTPUT'), '开头必须保留')
  assert.ok(r.text.endsWith('END-OF-OUTPUT'), `★ 结尾必须保留（报错都在尾部；旧实现丢掉了它）`)
  assert.ok(r.text.includes('FAILED tests: 3'), '★ 尾部关键信息（失败汇总）必须在预览里')
})

test('★ ② 省略标记必须说明省略了多少字符', () => {
  const src = longText()
  const r = sampleToolOutput(src, { headChars: 2000, tailChars: 4000 })
  assert.ok(r.omitted > 40_000, `省略字符数应如实（实测 ${r.omitted}）`)
  assert.ok(r.text.includes('中间省略'), '必须有"中间省略"字样（否则模型以为看到全部）')
  assert.ok(r.text.includes(String(r.omitted)), '标记里要给出具体省略量')
  assert.ok(r.text.includes('Read') && r.text.includes('Grep'), '必须提示怎么恢复（Read/Grep 定位）')
  // 三种片段拼起来长度守恒：head + marker + tail
  assert.equal(r.text.length, 2000 + SAMPLE_MARKER(r.omitted).length + 4000)
})

test('★ ③ 内联体积 ≤ 12,000 字符（计划约束）', () => {
  const r = sampleToolOutput(longText(200_000), { headChars: 2000, tailChars: 4000 })
  assert.ok(r.text.length <= 12_000, `采样后 ${r.text.length} 字符 > 12,000（计划约束）`)
})

test('④ 短内容零变化（不引入任何字符）', () => {
  for (const s of ['', 'ok', 'x'.repeat(6000)]) {
    const r = sampleToolOutput(s, { headChars: 2000, tailChars: 4000 })
    assert.equal(r.sampled, false)
    assert.equal(r.text, s, '未超阈值必须逐字节原样')
    assert.equal(r.omitted, 0)
  }
})

test('⑤ 头尾预算可配；head=0 时只有尾（不炸）', () => {
  const src = longText()
  const tailOnly = sampleToolOutput(src, { headChars: 0, tailChars: 1000 })
  assert.equal(tailOnly.sampled, true)
  assert.ok(tailOnly.text.endsWith('END-OF-OUTPUT'))
  assert.equal(tailOnly.text.startsWith('START-OF-OUTPUT'), false, 'head=0 时不该保留开头')
  // 异常预算不炸（NaN/负数 ⇒ 视作 0）
  const weird = sampleToolOutput(src, { headChars: Number.NaN, tailChars: -10 })
  assert.equal(weird.sampled, true)
  assert.ok(weird.text.includes('中间省略'))
})

test('⑥ 非字符串输入不抛', () => {
  assert.doesNotThrow(() => sampleToolOutput(undefined))
  assert.doesNotThrow(() => sampleToolOutput(null))
  assert.equal(sampleToolOutput(undefined).text, '')
  assert.equal(sampleToolOutput(12345).text, '12345')
})
