// 内核 provider 环境签名（2026-09-10 模型热切换修复）：同一聊天内切换模型
// 不生效的根因是桥无条件复用活内核——新模型永远到不了 spawn 环节。修复后
// send 时以本签名比对 spawn 冻结值，不一致即收割重启（--resume 保留历史）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
// bridge.mjs 模块求值即监听端口——测试环境必须在 import 前关掉顶层 listen
//（YFW_BRIDGE_NO_LISTEN 约定），故用动态导入。
process.env.YFW_BRIDGE_NO_LISTEN = '1'
const { providerEnvSig } = await import('./bridge.mjs')

test('providerEnvSig：baseUrl/model/auth 任一变化 → 签名不同', () => {
  const base = {
    PONOS_BASE_URL: 'http://a:8900',
    PONOS_MODEL: 'Qwen3.8-27B',
    PONOS_AUTH_TOKEN: 'tok-1',
  }
  const sig0 = providerEnvSig(base)
  assert.equal(sig0, providerEnvSig(base), '同配置签名稳定')
  assert.notEqual(sig0, providerEnvSig({ ...base, PONOS_MODEL: 'deepseek-v4-flash' }), '换模型')
  assert.notEqual(sig0, providerEnvSig({ ...base, PONOS_BASE_URL: 'http://b:9000' }), '换端点')
  assert.notEqual(sig0, providerEnvSig({ ...base, PONOS_AUTH_TOKEN: 'tok-2' }), '换凭证')
})

test('providerEnvSig：无关环境变量不影响签名', () => {
  const a = { PONOS_BASE_URL: 'u', PONOS_MODEL: 'm', PONOS_AUTH_TOKEN: 't' }
  assert.equal(providerEnvSig(a), providerEnvSig({ ...a, PONOS_REASONING_EFFORT: 'max', PATH: 'x' }))
})

test('providerEnvSig：缺失字段按空串归一（不产生 undefined/null 漂移）', () => {
  assert.equal(providerEnvSig({}), providerEnvSig({ PONOS_BASE_URL: '', PONOS_MODEL: '', PONOS_AUTH_TOKEN: '' }))
})
