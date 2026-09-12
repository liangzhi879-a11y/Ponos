// 引擎内容侧观测 → health.recordTurnContent（上下文失真，2026-09-12 spec §4.2/§6.1）
// 验收点：轮尾必须把 user/assistant 文本与工具摘要（含失败真值）交给 health，
// 否则 fidelity 的陈旧引用检测没有真值源可用（整条失真链路失效）。
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_STREAM_IDLE_MS = '5000'
const { createEngine } = await import('../kernel/engine.mjs')
const { createSessionStore } = await import('../kernel/session.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function mkWire() {
  return {
    assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {}, toolResult: () => {},
    commandLifecycle: () => {},
  }
}

const SID = '00000000-0000-0000-0000-0000000000f1'

test('引擎轮尾把 user/assistant/toolDigest 交给 health（含失败 Read 真值）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-fidelity-'))
  const calls = []
  const health = { record: () => {}, recordTurnContent: (d) => calls.push(d), recordFailure: () => {} }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: SID })
  try {
    const engine = createEngine({
      opts: { model: 'mock-model', addDirs: [dir], skipPermissions: true, systemPrompt: '' },
      wire: mkWire(), session, health,
    })
    await engine.runTurn({ content: '[mock:fidelity-read-fail] 读取一下那个文件' })
    assert.equal(calls.length, 1, '每轮恰好上报一次')
    const d = calls[0]
    assert.ok(d.user.includes('fidelity-read-fail'), 'user 文本原样带上')
    assert.ok(Array.isArray(d.toolDigest) && d.toolDigest.length >= 1, '工具摘要非空')
    const t = d.toolDigest.find((x) => x.name === 'Read')
    assert.ok(t, `应收录 Read 调用：${JSON.stringify(d.toolDigest)}`)
    assert.equal(t.isError, true, '不存在的文件必须记为失败（陈旧引用的真值来源）')
    assert.ok(String(t.path).includes('__yfw_fidelity_missing__.md'), '路径要带上')
    assert.ok(String(t.errorText).length > 0 && String(t.errorText).length <= 200, '错误文本截断保留')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('health.recordTurnContent 抛异常不影响轮次结果（侧路不得拖垮主流程）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-fidelity-bo-'))
  const health = {
    record: () => {}, recordFailure: () => {},
    recordTurnContent: () => { throw new Error('boom') },
  }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: SID })
  try {
    const engine = createEngine({
      opts: { model: 'mock-model', addDirs: [dir], skipPermissions: true, systemPrompt: '' },
      wire: mkWire(), session, health,
    })
    const r = await engine.runTurn({ content: '[mock:fidelity-read-fail] 再来一次' })
    assert.ok(r && typeof r.text === 'string' && r.text.length > 0, '轮次结果仍正常返回')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('health 未装配（无 recordTurnContent）时不抛：老装配路径兼容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-fidelity-legacy-'))
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: SID })
  try {
    const engine = createEngine({
      opts: { model: 'mock-model', addDirs: [dir], skipPermissions: true, systemPrompt: '' },
      wire: mkWire(), session, health: { record: () => {} },
    })
    const r = await engine.runTurn({ content: '[mock:fidelity-read-fail] 兼容性' })
    assert.ok(r && typeof r.text === 'string', '老 health 装配（无新方法）不得抛')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
