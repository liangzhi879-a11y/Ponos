// src/components/mcp/mcpStatus.test.ts
// 测什么（挑真实会骗人的地方，不凑覆盖率）：
//   ① 内核从未上报 **不等于** 已生效 —— 面板据此显示"内核尚未启动"，
//      而不是"已接入 0 个工具"。混为一谈正是"添加成功了却用不上"的界面根源。
//   ② 汇总口径：失败的服务器计入总数（面板要能报失败），工具数只数成功接入的。
//
// 注：两个构造器只为了让断言聚焦"判定规则"本身（typecheck 要求完整形状，
// 而手写字面量会逼着每行都抄一遍 servers/failed/disabled 这些与判定无关的字段）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stalenessOf, kernelSummary, type McpKernelSnapshot, type McpStatusCache } from './mcpStatus.ts'

/** 只关心 kernel 与 stale 的最小状态缓存（其余字段与判定无关） */
const cache = (kernel: McpKernelSnapshot | null, stale: boolean): McpStatusCache => ({
  ok: true, config: { path: '/x/mcp.json', sig: 'sig' }, kernel, stale,
})

/** 只带签名的最小快照 */
const snap = (configSig: string): McpKernelSnapshot => ({ servers: {}, failed: {}, disabled: [], configSig })

test('stalenessOf：内核未上报 ≠ 已生效', () => {
  assert.equal(stalenessOf(null), 'unknown')
  assert.equal(stalenessOf(cache(null, false)), 'unknown',
    '内核从未上报 ⇒ 必须与"已生效"区分开，否则界面会谎称"已接入 0 个工具"')
  assert.equal(stalenessOf(cache(snap('a'), true)), 'stale')
  assert.equal(stalenessOf(cache(snap('a'), false)), 'fresh')
})

test('kernelSummary：按真实快照汇总服务器/工具数', () => {
  const s = kernelSummary({
    servers: { a: { tools: ['mcp__a__echo', 'mcp__a__whoami'], expose: 'public' },
               b: { tools: ['mcp__b__x'], expose: 'bound' } },
    failed: { c: '连接被拒绝' }, disabled: ['d'], configSig: 'sig',
  })
  assert.equal(s.totalServers, 3, '含失败的（面板要能报出失败）')
  assert.equal(s.totalTools, 3)
  assert.deepEqual(s.failedNames, ['c'])
  assert.deepEqual(s.disabledNames, ['d'])
})

test('kernelSummary：空快照不得显示成"已接入 0 个"以外的谎话', () => {
  const s = kernelSummary({ servers: {}, failed: {}, disabled: [], configSig: 'x' })
  assert.equal(s.totalServers, 0)
  assert.equal(s.totalTools, 0)
})
