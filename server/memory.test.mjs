// server/memory.test.mjs —— P5 L3-1 记忆内核化（与 GUI experience.mjs 同数据源/格式/去重算法）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMemoryEntry, readMemoryEntries, buildMemoryIndex, captureMemoryCandidates, hashLine } from '../kernel/memory.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'yfw-mem-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('hashLine：与 experience.mjs 同算法（兼容 GUI 面板去重）', () => {
  const ref = (text) => {
    let h = 0
    for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  const t = '- [会话|测试] 摘要 -- 全文'
  assert.equal(hashLine(t), ref(t))
  assert.equal(hashLine('abc'), hashLine('abc'))
  assert.notEqual(hashLine('abc'), hashLine('abd'))
})

test('appendMemoryEntry：写文件 + 读回 + 去重', () => {
  const root = join(tmp, 'mem1')
  mkdirSync(root, { recursive: true })
  const r1 = appendMemoryEntry({ root, theme: 'workflow', tag: '测试', summary: '摘要一', full: '全文一' })
  assert.equal(r1.ok, true)
  const r2 = appendMemoryEntry({ root, theme: 'workflow', tag: '测试', summary: '摘要一', full: '全文一' })
  assert.equal(r2.deduped, true)
  const entries = readMemoryEntries({ root, theme: 'workflow' })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].tag, '测试')
  assert.equal(entries[0].summary, '摘要一')
  assert.equal(entries[0].full, '全文一')
  const raw = readFileSync(join(root, 'workflow.md'), 'utf-8')
  assert.ok(raw.startsWith('---\nname: workflow'))
  assert.ok(raw.includes('- [会话|测试] 摘要一 -- 全文一'))
})

test('buildMemoryIndex：格式与 experience.mjs 索引一致', () => {
  const root = join(tmp, 'mem2')
  mkdirSync(root, { recursive: true })
  appendMemoryEntry({ root, theme: 'workflow', tag: '导出', summary: 's', full: 'f' })
  const idx = buildMemoryIndex({ root })
  assert.ok(idx.includes('【个人经验索引】'))
  assert.ok(idx.includes('[workflow|导出]'))
  assert.ok(idx.trim().endsWith('.md')) // 末行携带文件路径（与 GUI 索引同格式，行尾换行）
})

test('captureMemoryCandidates：纠错 → workflow / 偏好 → communication', () => {
  assert.deepEqual(captureMemoryCandidates({ userText: '以后不要用 sed 改文件' }).map((c) => c.theme), ['workflow'])
  assert.deepEqual(captureMemoryCandidates({ userText: '我习惯先读文件再改' }).map((c) => c.theme), ['communication'])
  assert.deepEqual(captureMemoryCandidates({ userText: '实现导出功能' }), [])
})

import { composeSystemPrompt } from '../kernel/prompt.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')

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

test('composeSystemPrompt：memory 区块在 skills 之后、append 之前', () => {
  const p = composeSystemPrompt({
    toolNames: ['Bash'], agents: [], subagents: [], cwd: '/x',
    skills: [{ id: 's1', description: 'd1' }],
    memory: '\n\n【个人经验索引】测试\n- [workflow|tag] 1 条',
    append: 'APPEND_MARK',
  })
  assert.ok(p.includes('【个人经验索引】测试'))
  const mi = p.indexOf('【个人经验索引】')
  const ai = p.indexOf('APPEND_MARK')
  const si = p.indexOf('s1')
  assert.ok(si < mi && mi < ai, '顺序: skills < memory < append')
})

test('集成：轮末捕获命中 → configDir/memory/personal 落盘条目', async () => {
  const configDir = join(tmp, 'mcfg')
  const cwd = join(tmp, 'mproj')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--add-dir', cwd,
  ], {
    env: { ...process.env, YFW_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = makeReader(child.stdout)
  try {
    await reader.nextEvent() // init
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '以后不要用 sed 改文件' } }) + '\n')
    while (true) { const ev = await reader.nextEvent(); if (ev.type === 'result') break }
    // 捕获在轮末 finally（result 事件后）——Windows 管道小写同步落盘，外部观察者
    // 可能早于文件写入看到 result，轮询等待（内核内顺序不变：捕获 → turnActive 复位）
    const fp = join(configDir, 'memory', 'personal', 'workflow.md')
    let seen = false
    for (let i = 0; i < 20 && !seen; i++) {
      if (existsSync(fp)) seen = true
      else await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(seen, 'workflow.md 已落盘')
    assert.ok(readFileSync(fp, 'utf-8').includes('以后不要用 sed 改文件'))
  } finally {
    try { child.stdin.end() } catch {}
  }
})
