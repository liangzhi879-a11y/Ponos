// 兼容垫片契约测试：旧名 → PONOS_* 主名的映射语义（主名优先、只兜底、不删除旧名）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_ENV_ALIASES, applyLegacyEnvAliases, legacyNamesOf } from './legacy-env.mjs'

test('映射表：键为主名 PONOS_*，值非空且无自映射', () => {
  const entries = Object.entries(LEGACY_ENV_ALIASES)
  assert.ok(entries.length > 30, `映射条目应覆盖全部历史遗留名，实得 ${entries.length}`)
  for (const [canonical, legacyNames] of entries) {
    assert.match(canonical, /^PONOS_[A-Z0-9_]+$/, `主名须为 PONOS_* 形态：${canonical}`)
    assert.ok(Array.isArray(legacyNames) && legacyNames.length > 0, `${canonical} 的旧名列表不得为空`)
    for (const legacy of legacyNames) {
      assert.notEqual(legacy, canonical, `${canonical} 不得自映射`)
      assert.doesNotMatch(legacy, /^PONOS_/, `旧名列表不得混入主名：${legacy}`)
    }
  }
})

test('protocol 边界：ANTHROPIC_VERSION 不在映射表内（属 wire 头契约，须保留原名）', () => {
  const allLegacy = Object.values(LEGACY_ENV_ALIASES).flat()
  assert.ok(!allLegacy.includes('ANTHROPIC_VERSION'))
  assert.ok(!allLegacy.includes('anthropic-version'))
  assert.ok(!Object.keys(LEGACY_ENV_ALIASES).includes('PONOS_VERSION'))
})

test('主名优先：主名已有值时，旧名不覆盖', () => {
  const env = { PONOS_BASE_URL: 'https://new.example', ANTHROPIC_BASE_URL: 'https://old.example' }
  const applied = applyLegacyEnvAliases(env)
  assert.equal(env.PONOS_BASE_URL, 'https://new.example')
  assert.ok(!applied.includes('ANTHROPIC_BASE_URL→PONOS_BASE_URL'))
})

test('兜底生效：仅设旧名时，映射到主名并回报映射对', () => {
  const env = { ANTHROPIC_BASE_URL: 'https://old.example', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096' }
  const applied = applyLegacyEnvAliases(env)
  assert.equal(env.PONOS_BASE_URL, 'https://old.example')
  assert.equal(env.PONOS_MAX_OUTPUT_TOKENS, '4096')
  assert.deepEqual(applied.sort(), ['ANTHROPIC_BASE_URL→PONOS_BASE_URL', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS→PONOS_MAX_OUTPUT_TOKENS'])
  // 旧名原样保留，不做删除（保持可观测与可回退）
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://old.example')
})

test('多旧名候选：按优先级取首个命中（工具结果预算的布尔形态旧名兜底）', () => {
  const env = { CLAUDE_CODE_TOOL_RESULT_BUDGET: 'true' }
  applyLegacyEnvAliases(env)
  assert.equal(env.PONOS_TOOL_RESULT_BUDGET_BYTES, 'true')
  assert.deepEqual(legacyNamesOf('PONOS_TOOL_RESULT_BUDGET_BYTES'), ['CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES', 'CLAUDE_CODE_TOOL_RESULT_BUDGET'])
})

test('空串视为未设置：空值旧名不参与映射，避免把空配置当真值写进主名', () => {
  const env = { ANTHROPIC_MODEL: '' }
  const applied = applyLegacyEnvAliases(env)
  assert.equal(env.PONOS_MODEL, undefined)
  assert.deepEqual(applied, [])
})

test('无旧名时零副作用（幂等，可重复调用）', () => {
  const env = { PONOS_MODEL: 'x' }
  assert.deepEqual(applyLegacyEnvAliases(env), [])
  assert.deepEqual(applyLegacyEnvAliases(env), [])
  assert.deepEqual(Object.keys(env), ['PONOS_MODEL'])
})

test('覆盖三类历史命名的代表性旧名均能映射', () => {
  const env = {
    CLAUDE_CONFIG_DIR: '/tmp/cfg',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
  }
  applyLegacyEnvAliases(env)
  assert.equal(env.PONOS_CONFIG_DIR, '/tmp/cfg')
  assert.equal(env.PONOS_AUTH_TOKEN, 'tok')
  assert.equal(env.PONOS_AUTO_COMPACT_WINDOW, '200000')
  assert.equal(env.PONOS_REASONING_EFFORT, 'high')
})
