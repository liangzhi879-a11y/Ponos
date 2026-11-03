// Task 8：Screen 工具注册 + 聊天模式禁用。
// ★ 相对 brief 的**唯一**偏离：brief 里写的是 `createTools`，但 `kernel/tools.mjs` 从未导出
//   这个名字（registry 工厂是 `createToolRegistry`，见 `:1001`）—— 逐字照抄会让本文件在
//   import 阶段就 `SyntaxError: does not provide an export named 'createTools'`，
//   永远绿不了。故改为真实导出名；**断言一条未动、未放宽**（实测 `createToolRegistry({})`
//   与 brief 设想的语义一致：22 个静态工具全在、Browser 无 driver 时明确报错）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolRegistry as createTools, CHAT_MODE_DISALLOWED } from '../kernel/tools.mjs'

test('★ Screen 必须在聊天模式禁用名单里（截图会把屏幕内容留在会话历史）', () => {
  assert.ok(CHAT_MODE_DISALLOWED.includes('Screen'),
    '聊天模式无任务上下文，截图进对话 = 屏幕内容留在会话历史（同 Browser 理由）')
})

test('Screen 工具已注册，描述含关键约束', () => {
  const t = createTools({})
  assert.ok(t.registry.Screen, 'Screen 工具必须存在')
  const d = t.registry.Screen.description
  assert.match(d, /displays/, '应列出 act')
  assert.match(d, /只读/, '应说明本版本只读')
  assert.match(d, /空白帧|空图/, '应说明空白帧会明确报错')
  assert.match(d, /排除清单|隐私/, '应说明排除清单机制')
})

test('★ I4：描述不得宣称本期拿不到的授权（scope:"all" 在 P2a 不支持，GUI 入口属 P2b）', () => {
  // 原描述写着 `scope:"all"` 全屏"需单独授权"，而 electron/main.cjs **硬编码**
  // `allowFullScreen:false`（spec §7 把 GUI 授权入口放 P2b）⇒ 模型会反复尝试一个**永远拿不到**
  // 的授权。断言按新文案**收紧**（不是删断言）：必须点明"不支持/P2b"，且不得再承诺可获得授权。
  const t = createTools({})
  const d = t.registry.Screen.description
  assert.match(d, /scope:"all"[^）]*不支持/, '必须明说 scope:"all" 在 P2a 不支持')
  assert.match(d, /P2b/, '必须点明 GUI 授权入口属 P2b（而不是让模型去找一个不存在的入口）')
  assert.match(d, /元数据|不把像素交给模型/, 'capture 必须说明返回的是元数据（C1：像素不交给模型）')
  assert.ok(!d.includes('需单独授权'), '不得再写"需单独授权"—— P2a 拿不到该授权')
  const p = t.registry.Screen.input_schema.properties.params.description
  assert.ok(!/全屏，需授权/.test(p), 'params 描述同样不得承诺可获得的全屏授权')
  assert.match(p, /不支持/, 'params 描述必须说明 "all" 在 P2a 不支持')
})

test('input_schema：action 必填，params 可选，additionalProperties:false', () => {
  const t = createTools({})
  const s = t.registry.Screen.input_schema
  assert.deepEqual(s.required, ['action'])
  assert.ok(s.properties.params)
  assert.equal(s.additionalProperties, false)
})

test('未注入 screenDriver 时必须明确报错（绝不静默成功）', async () => {
  const t = createTools({})
  const r = await t.registry.Screen.run({ action: 'displays' }, {})
  assert.equal(r.isError, true)
  assert.match(r.content, /不可用|未注册/)
})

test('注入 screenDriver 后透传 action/params', async () => {
  const calls = []
  const t = createTools({})
  const r = await t.registry.Screen.run({ action: 'capture', params: { window: 'x' } },
    { screenDriver: async (a, p) => { calls.push([a, p]); return { content: 'ok', isError: false } } })
  assert.deepEqual(calls, [['capture', { window: 'x' }]])
  assert.equal(r.content, 'ok')
})
