// Task：Vault 工具（用户密码库 agent 通路，2026-10-22）。
// 覆盖：聊天模式禁用、注册表形状、无执行器时明确失败、driver 透传、描述不含越权承诺。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolRegistry as createTools, CHAT_MODE_DISALLOWED } from '../kernel/tools.mjs'

test('★ Vault 必须在聊天模式禁用名单里（明文会留在会话历史）', () => {
  assert.ok(CHAT_MODE_DISALLOWED.includes('Vault'),
    '纯聊会话无任务上下文，密码库明文进对话 = 用户凭据留在历史里（同 Screen/Browser 理由）')
})

test('Vault 已注册，描述说清动作与"敏感数据先入库"的行为约束', () => {
  const t = createTools({})
  assert.ok(t.registry.Vault, 'Vault 工具必须存在')
  const d = t.registry.Vault.description
  assert.match(d, /list/, '应列出 list 动作')
  assert.match(d, /get/, '应列出 get 动作')
  assert.match(d, /set/, '应列出 set 动作')
  assert.match(d, /批准|审批/, '必须告知模型访问会请求用户批准')
  assert.match(d, /密码库/, '必须说明敏感数据应存入密码库而不是写进文件/命令')
  assert.ok(d.length <= 360, `描述必须 ≤360 字（紧凑预算），实际 ${d.length}`)
})

test('input_schema：action 必填，params 可选，additionalProperties:false', () => {
  const t = createTools({})
  const s = t.registry.Vault.input_schema
  assert.deepEqual(s.required, ['action'])
  assert.ok(s.properties.params)
  assert.equal(s.additionalProperties, false)
})

test('未注入 vaultDriver 时必须明确报错（绝不静默成功）', async () => {
  const t = createTools({})
  const r = await t.registry.Vault.run({ action: 'list' }, {})
  assert.equal(r.isError, true)
  assert.match(r.content, /不可用|未注册/)
})

test('注入 vaultDriver 后透传 action/params', async () => {
  const calls = []
  const t = createTools({})
  const r = await t.registry.Vault.run({ action: 'get', params: { name: 'bank' } },
    { vaultDriver: async (a, p) => { calls.push([a, p]); return { content: 'ok', isError: false } } })
  assert.deepEqual(calls, [['get', { name: 'bank' }]])
  assert.equal(r.content, 'ok')
})
