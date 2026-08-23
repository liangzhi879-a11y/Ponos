// server/session-long.test.mjs —— P5 端到端：settings.compact 低阈值触发压缩全链路验收
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'ponos-long-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

function makeReader(stream) {
  const lines = []
  const waiters = []
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', (l) => {
    const line = l.trim()
    if (!line) return
    if (waiters.length) waiters.shift()(line)
    else lines.push(line)
  })
  return {
    nextEvent(timeoutMs = 5000) {
      if (lines.length) return Promise.resolve(JSON.parse(lines.shift()))
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('read timeout: ' + JSON.stringify(lines))), timeoutMs)
        waiters.push((l) => { clearTimeout(t); resolve(JSON.parse(l)) })
      })
    },
  }
}

function sanitizeSegment(s) {
  return String(s).replace(/[^a-zA-Z0-9\u4e00-\u9fa5.-]/g, '-')
}

test('端到端：低阈值 settings.compact → 多轮后触发压缩 → ponos_summary + 落盘', async () => {
  const configDir = join(tmp, 'lcfg')
  const cwd = join(tmp, 'lproj')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(cwd, '.ponos'), { recursive: true })
  writeFileSync(join(cwd, '.ponos', 'settings.json'), JSON.stringify({
    compact: { thresholdTokens: 1, reserveTokens: 1 },
  }), 'utf-8')
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW 缩小窗口（bridge 生产同样注入）：window=200 →
  // thresholdRatio clamp(1/200, 0.01, 1)=0.01 → threshold=2 token，任何历史即超阈值
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd,
  ], {
    env: { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  let sid = ''
  const events = []
  try {
    const init = await reader.nextEvent()
    sid = init.session_id
    // 第 1 轮：积累 user + assistant 历史
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '[mock:tool-safe] 第一轮' } }) + '\n')
    while (true) { const ev = await reader.nextEvent(); events.push(ev); if (ev.type === 'result') break }
    // 第 2 轮：pre-step 测压 → threshold=1 必触发 → cut 有效（有 assistant 历史）→ 摘要
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '[mock:tool-safe] 第二轮' } }) + '\n')
    while (true) {
      const ev = await reader.nextEvent()
      events.push(ev)
      if (ev.type === 'result') break
    }
  } finally {
    try { child.stdin.end() } catch {}
  }
  // 压缩发生：ponos_summary 事件（health.recordCompaction 单通道）
  const summaryEv = events.find((e) => e.type === 'ponos_summary')
  assert.ok(summaryEv, '出现 ponos_summary 事件')
  assert.ok(String(summaryEv.text ?? JSON.stringify(summaryEv)).includes('mock 摘要'))
  // 落盘：transcript 含 compaction 记录
  const transcriptPath = join(configDir, 'projects', sanitizeSegment(cwd), sid + '.jsonl')
  assert.ok(existsSync(transcriptPath))
  const raw = readFileSync(transcriptPath, 'utf-8')
  assert.ok(raw.includes('compaction'), 'transcript 含 compaction 记录')
})
