// 真机验收回归：**快照形状契约**（2026-09-13 真机链路暴露的一类缺陷）
//
// 背景（真实事故）：真机跑「真页面 + 真模型」时发现三处按错误口径读快照的代码，
// 它们的共同根因是——测试里的假执行器都额外带了 `text` 字段，而真实快照
// （electron/browser-common.cjs 的 buildSnapshot）**没有顶层 text/url/title**：
//   ① app-runner 的 save 语义读 res.snapshot.text → 真机 save 拿到整坨快照对象（1KB+ JSON）
//   ② app-profiler.probeWeb 读 snapshot.title → 真机探测标题恒为 null
//   ③ app-ipc.profiledSnapshot 读 snap.url/title → 界面探测结果网址/标题恒为空
// 本文件的用例全部使用**真实形状**的快照（不含 text），把这条契约钉住。
// 附带钉住另一个真机发现：模型写出 {{param}} 而原实现只认 ${param} → 参数化命令静默失效。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { snapshotToText, interpolate, SNAPSHOT_TEXT_CAP } = require('../electron/app-util.cjs')
const { runCommand } = require('../electron/app-runner.cjs')
const { probeWeb } = require('../electron/app-profiler.cjs')
const { profiledSnapshot } = require('../electron/app-ipc.cjs')
const { snapshotForPrompt } = require('../electron/app-generate.cjs')

/** 真实快照：字段照 electron/browser-common.cjs 的 buildSnapshot，**刻意不含 text** */
const REAL_SNAP = {
  page: { url: 'http://127.0.0.1:1/orders', title: '示例订单管理系统', readyState: 'complete', loading: false, captcha: false, logged_in: true },
  alerts: ['库存不足'],
  changes: '首次快照',
  interactives: [
    { ref: 1, tag: 'textbox', label: '订单号', value: '', path_hint: 'form#searchForm > input' },
    { ref: 2, tag: 'button', label: '查询订单', path_hint: 'form#searchForm > button' },
  ],
  info: [{ label: 'A1', value: '已支付' }, { label: 'A2', value: '待发货' }],
  downloads: [],
  viewport: { w: 1100, h: 780 },
  scrollY: 0,
  truncated: 0,
}

test('interpolate：${name} 与 {{name}} 都替换（真机里模型写的是后者）', () => {
  assert.equal(interpolate('/o/${orderId}', { orderId: 'A1' }), '/o/A1')
  assert.equal(interpolate('/o/{{orderId}}', { orderId: 'A1' }), '/o/A1', '{{name}} 必须也能替换')
  assert.equal(interpolate('{{missing}}', {}), '', '未知参数替换为空串（与 ${} 口径一致）')
})

test('snapshotToText：真实形状（无 text）→ 可读文本，而不是整坨 JSON', () => {
  const txt = snapshotToText(REAL_SNAP)
  assert.equal(typeof txt, 'string')
  assert.ok(txt.includes('示例订单管理系统'), '应含页面标题')
  assert.ok(txt.includes('查询订单'), '应含交互元素标签')
  assert.ok(txt.includes('已支付'), '应含页面内容（info）')
  assert.ok(txt.includes('库存不足'), '应含 alerts')
  assert.ok(!txt.startsWith('{'), '不得是 JSON 原文')
})

test('snapshotToText：仍带 text 的执行器优先用 text（不破坏既有语义）', () => {
  assert.equal(snapshotToText({ text: 'body 文本' }), 'body 文本')
})

test('snapshotToText：超长截断并标注（工具结果不能撑爆上下文）', () => {
  const big = { page: { title: 'T' }, info: Array.from({ length: 400 }, (_, i) => ({ label: `行${i}`, value: 'x'.repeat(80) })) }
  const txt = snapshotToText(big)
  assert.ok(txt.length <= SNAPSHOT_TEXT_CAP + 20, `应被截断（实际 ${txt.length}）`)
  assert.ok(txt.includes('已截断'))
})

test('runCommand 的 save：真实形状快照 → data 是可读字符串（真机缺陷①的回归）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'appsnap-'))
  try {
    mkdirSync(join(root, 'app-a'), { recursive: true })
    writeFileSync(join(root, 'app-a', 'spec.json'), JSON.stringify({
      specVersion: 1, appId: 'app-a', name: '甲', target: { type: 'web', url: 'https://example.com' }, expose: { mode: 'console' },
      commands: [{ action: 'list', title: '列', kind: 'read', params: [], steps: [{ act: 'goto', url: '/' }, { act: 'snapshot', save: 'r' }] }],
    }), 'utf-8')
    const executor = { exec: async (_s, act) => (act === 'snapshot' ? { ok: true, snapshot: REAL_SNAP } : { ok: true }) }
    const r = await runCommand({ roots: [root], appId: 'app-a', action: 'list', args: {}, executor, sessionId: 's1' })
    assert.equal(r.ok, true)
    assert.equal(typeof r.data, 'string', 'data 必须是文本，不能是快照对象')
    assert.ok(r.data.includes('查询订单'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('probeWeb：真实形状 → title 取自 page.title（真机缺陷②的回归）', async () => {
  const executor = { exec: async (_s, act) => ({ ok: true, snapshot: act === 'snapshot' ? REAL_SNAP : undefined }) }
  const r = await probeWeb({ url: 'https://e.com', executor, sessionId: 'p' })
  assert.equal(r.title, '示例订单管理系统')
})

test('probeWeb：扁平形状仍兼容（执行器可注入，两种口径都要认）', async () => {
  const executor = { exec: async () => ({ ok: true, snapshot: { title: 'T', url: 'u' } }) }
  const r = await probeWeb({ url: 'https://e.com', executor, sessionId: 'p' })
  assert.equal(r.title, 'T')
})

test('profiledSnapshot：真实形状 → url/title 取自 page（真机缺陷③的回归）', () => {
  const p = profiledSnapshot(REAL_SNAP)
  assert.equal(p.title, '示例订单管理系统')
  assert.equal(p.url, 'http://127.0.0.1:1/orders')
  assert.equal(p.interactiveCount, 2)
})

test('snapshotForPrompt：info（页面正文）进生成素材，供模型看到"页面里有什么"', () => {
  const m = snapshotForPrompt(REAL_SNAP)
  assert.equal(m.page.title, '示例订单管理系统')
  assert.deepEqual(m.info, REAL_SNAP.info)
  assert.equal(m.interactives.length, 2)
})
