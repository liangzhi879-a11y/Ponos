// src/components/settings/mcpFormat.test.ts
// MCP 面板状态归并的测试。
//
// 测什么（挑真实风险，不凑覆盖率）：
//   ① **running 必须压过旧结论**：点「测试」时若仍显示上一次的「✓ 5 个工具」，
//      用户会以为测完了、拿旧结果当新结论。
//   ② **toolsOf 仅在成功时给清单**：失败后若还留着上次的工具名，是明确的误导。
//   ③ **统计只认当前配置里的服务器**：用户删掉一台后，残留的测试记录不得再计入
//      「N 通 / M 失败」，否则汇总数字与实际配置对不上。
//   ④ **一台失败不影响另一台**：这是「多服务器支持」在 UI 层的体现——
//      2 通 1 失败必须如实呈现为 2 通 1 失败，而不是整体判失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  badgeOf, toolsOf, errorOf, summarize, summaryText, transportOf,
  type McpTestState,
} from './mcpFormat.ts'

const TOOLS = [{ name: 'echo' }, { name: 'boom' }]
const OK: McpTestState = { ok: true, tools: TOOLS }
const BAD: McpTestState = { ok: false, error: '已退出（code=1）' }

test('badgeOf：未测试=untested；running 优先于旧结论', () => {
  assert.equal(badgeOf(undefined), 'untested')
  assert.equal(badgeOf(OK), 'ok')
  assert.equal(badgeOf(BAD), 'failed')
  // 关键：测试进行中即便带着上一次的 ok，也必须显示 running
  assert.equal(badgeOf({ running: true, ok: true, tools: TOOLS }), 'running')
  assert.equal(badgeOf({ running: true, ok: false }), 'running')
})

test('toolsOf：仅在「已测且成功」时返回清单', () => {
  assert.deepEqual(toolsOf(OK).map(t => t.name), ['echo', 'boom'])
  assert.deepEqual(toolsOf(BAD), [], '失败不得残留上次工具清单')
  assert.deepEqual(toolsOf(undefined), [])
  assert.deepEqual(toolsOf({ running: true, ok: true, tools: TOOLS }), [], '测试中不得把旧清单当结论')
})

test('errorOf：仅在「已测且失败」时返回原因', () => {
  assert.equal(errorOf(BAD), '已退出（code=1）')
  assert.equal(errorOf(OK), '', '成功不得显示错误')
  assert.equal(errorOf({ running: true, ok: false, error: 'x' }), '', '测试中不显示上一次的失败')
  assert.equal(errorOf(undefined), '')
})

test('summarize：多服务器如实呈现（2 通 1 失败 ≠ 整体失败）', () => {
  const tests = { a: OK, b: OK, c: BAD }
  const s = summarize(['a', 'b', 'c'], tests)
  assert.deepEqual(
    { total: s.total, ok: s.ok, failed: s.failed, untested: s.untested },
    { total: 3, ok: 2, failed: 1, untested: 0 },
  )
  assert.equal(s.settled, true)
})

test('summarize：只统计当前配置里的服务器（删掉的残留记录不计入）', () => {
  // 配置里只剩 a，但 tests 里还留着已删的 z 的记录
  const s = summarize(['a'], { a: OK, z: BAD })
  assert.equal(s.total, 1)
  assert.equal(s.failed, 0, '已删除服务器的失败记录不得计入汇总')
  assert.equal(s.ok, 1)
})

test('summarize：空配置与未测试状态', () => {
  const empty = summarize([], {})
  assert.equal(empty.total, 0)
  assert.equal(empty.settled, true, '没有任何服务器时视为已就绪（按钮不该永远忙碌）')

  const notRun = summarize(['a', 'b'], {})
  assert.equal(notRun.untested, 2)
  assert.equal(notRun.settled, false)

  const running = summarize(['a'], { a: { running: true } })
  assert.equal(running.testing, 1)
  assert.equal(running.settled, false)
})

test('summaryText：全通时不列 0 项（避免「2 通 · 0 失败 · 0 未测」噪声）', () => {
  const L = { ok: '通', failed: '失败', testing: '测试中', untested: '未测' }
  assert.equal(summaryText(summarize(['a', 'b'], { a: OK, b: OK }), L), '2 通')
  assert.equal(summaryText(summarize(['a', 'b', 'c'], { a: OK, b: OK, c: BAD }), L), '2 通 · 1 失败')
  assert.equal(summaryText(summarize([], {}), L), '', '无服务器时无文案')
})

// 【HTTP 传输，2026-09-16】传输类型判定必须是纯函数：
// 面板要用它决定渲染哪一组字段，且「切换传输时清另一侧字段」也读它。
// 判定口径与内核 normalizeMcpServers 一致（按 url 是否存在），
// 但**不做**校验（command+url 并存仍报 'http'，交给内核 400 兜底）——
// 前端重复实现校验规则只会造出第二份会漂移的真源。
test('transportOf：按 url 判定传输类型（有 url 即 HTTP，否则 stdio）', () => {
  assert.equal(transportOf({ command: 'npx', args: [] }), 'stdio')
  assert.equal(transportOf({ url: 'https://e.com/mcp' }), 'http')
  assert.equal(transportOf({ url: 'http://127.0.0.1:8080/mcp', headers: { A: 'B' }, timeoutMs: 5000 }), 'http')
  assert.equal(transportOf({ command: 'node', args: [], env: {}, cwd: '/tmp', timeoutMs: 1000 }), 'stdio')
})
