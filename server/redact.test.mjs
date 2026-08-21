// server/redact.test.mjs —— 密钥脱敏（docs/production/security.md S2-1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactText, redactEntry } from '../kernel/redact.mjs'

test('redactText：sk- / AKIA / key=value / Bearer 打码', () => {
  assert.equal(redactText('key sk-abc12345XYZ end'), 'key sk-*** end')
  assert.equal(redactText('AKIAIOSFODNN7EXAMPLE'), 'AKIA***')
  assert.equal(redactText('api_key = "supersecret123"'), 'api_key = "***"')
  assert.equal(redactText('Bearer eyJhbGciOiJIUzI1NiJ9.abc'), 'Bearer ***')
  assert.equal(redactText('普通文本无敏感'), '普通文本无敏感')
  assert.equal(redactText(''), '')
  assert.equal(redactText(null), null)
})

test('redactEntry：content 字符串/文本块/工具输入递归打码；YFW_KEEP_SECRETS=1 保留', () => {
  const prev = process.env.YFW_KEEP_SECRETS
  try {
    process.env.YFW_KEEP_SECRETS = ''
    const e = redactEntry({
      type: 'assistant', message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'token is sk-abc12345XYZ' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer sk-secret9999" http://x' } },
        ],
      },
    })
    assert.match(e.message.content[0].text, /sk-\*\*\*/)
    assert.match(e.message.content[1].input.command, /Bearer \*\*\*/)
    process.env.YFW_KEEP_SECRETS = '1'
    const keep = redactEntry({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'sk-abc12345XYZ' }] } })
    assert.equal(keep.message.content[0].text, 'sk-abc12345XYZ')
  } finally {
    process.env.YFW_KEEP_SECRETS = prev || ''
  }
})
