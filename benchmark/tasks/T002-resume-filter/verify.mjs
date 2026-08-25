// T002 验收：
//  1. 源码断言：cli.mjs 的 seedHistory 过滤含 kind/compaction 排除条件
//  2. 行为冒烟：resume 含 compaction 条目的 transcript（PONOS_MOCK_API=1，兼容历史 base 内核的 YFW_MOCK_API）正常完成一轮
// 用法：node verify.mjs <workspace>
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const ws = process.argv[2]

// ── 1. 源码断言 ──────────────────────────────────────────────────────────────
const cliSrc = readFileSync(join(ws, 'kernel', 'cli.mjs'), 'utf8')
const seedFilterBlock = cliSrc.split('\n').filter((l) =>
  l.includes('filter') && (l.includes('type') || l.includes('seedHistory')) && l.includes('user') || l.includes('compaction')
).join('\n')
const hasKindGuard = /kind\s*!==?\s*['"]compaction['"]/.test(seedFilterBlock) ||
  /filter\([^)]*kind[^)]*compaction[^)]*\)/.test(cliSrc)
if (!hasKindGuard) {
  console.error('VERIFY_FAIL: cli.mjs seedHistory 过滤未排除 compaction 条目（未找到 kind 排除条件）')
  console.error('--- 相关代码片段 ---')
  console.error(seedFilterBlock.slice(0, 800) || '(未找到 filter 片段)')
  process.exit(1)
}

// ── 2. 行为冒烟：resume 含 compaction 条目的 transcript ─────────────────────
const home = mkdtempSync(join(tmpdir(), 'ponos-bench-t002-'))
const sid = 'bench-t002-session'
const projectDir = join(home, 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'))
mkdirSync(projectDir, { recursive: true })
const transcript = [
  { type: 'user', seq: 1, ts: '2026-08-20T00:00:00.000Z', message: { role: 'user', content: '你好' } },
  { type: 'assistant', seq: 2, ts: '2026-08-20T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '你好！' }] } },
  { type: 'assistant', seq: 3, kind: 'compaction', surfaceOp: 'replace', sourceEventSeqs: [2], ts: '2026-08-20T00:00:01.000Z', message: { role: 'assistant', content: [] } },
  { type: 'user', seq: 4, ts: '2026-08-20T00:00:02.000Z', message: { role: 'user', content: '继续' } },
].map((e) => JSON.stringify(e)).join('\n') + '\n'
writeFileSync(join(projectDir, `${sid}.jsonl`), transcript)

// 关键坑：不能 spawnSync 一次性写 input 再关闭 stdin——内核 readline 收到
// stdin close 即 process.exit(0)，异步 runTurn（mock 也要 await sleep）必被
// 截断、永不产出 result（实测任意内核版本都只出 init）。必须异步 spawn、
// 写 user 后保持 stdin 打开，等 result 出现再 end() 优雅退出。
const res = await new Promise((resolve) => {
  const child = spawn(process.execPath, [
    'kernel/cli.mjs',
    '--resume', sid,
    '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--add-dir', ws,
  ], { cwd: ws, env: { ...process.env, PONOS_MOCK_API: '1', YFW_MOCK_API: '1', PONOS_HOME: home, CLAUDE_CONFIG_DIR: home } })
  let stdout = ''
  let stderr = ''
  let settled = false
  const done = (code) => { if (!settled) { settled = true; resolve({ code, stdout, stderr }) } }
  child.stdout.on('data', (d) => {
    stdout += d
    // result 出现即本轮完成：关 stdin 让内核优雅退出（契约：stdin EOF → exit 0）
    if (/"type":"result"/.test(stdout)) { try { child.stdin.end() } catch { /* 忽略 */ } }
  })
  child.stderr.on('data', (d) => { stderr += d })
  child.on('close', (code) => done(code ?? 0))
  child.on('error', (e) => { stderr += 'SPAWN_ERROR: ' + e.message + '\n'; done(-2) })
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '请继续' } }) + '\n')
  // 兜底超时：60s 未出 result 按失败处理
  setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 忽略 */ } done(-1) }, 60000)
})
rmSync(home, { recursive: true, force: true })

const hasResult = /"type":"result"/.test(res.stdout || '')
const hasError = /处理出错/.test(res.stdout || '') || /(Error|error:)/.test(res.stderr || '')
if (!hasResult || hasError) {
  console.error('VERIFY_FAIL: resume 冒烟失败（无 result 或出现错误）')
  console.error('STDOUT tail:', (res.stdout || '').slice(-800))
  console.error('STDERR tail:', (res.stderr || '').slice(-800))
  process.exit(1)
}

console.log('VERIFY_PASS')
process.exit(0)
