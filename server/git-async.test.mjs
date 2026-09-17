// 异步 git 调用层测试（P1 批次 1 新增）
// ---------------------------------------------------------------------------
// 覆盖两件事：
//   1. **解析正确性** —— 其中 parseWorktrees 带一条回归：原实现用 `slice(21)` 取分支名，
//      而 'branch refs/heads/' 只有 18 字符，导致每个分支名被截掉前 3 个字符
//      （实测真实输出：`feature/app-universal-onboarding` → `ture/app-universal-onboarding`，
//      `knowledge-s1` → `wledge-s1`）。工作树面板因此一直显示错名。
//   2. **不阻塞事件循环** —— 这是本次从 execSync 改异步的**唯一目的**。桥是单进程单事件循环，
//      同步 git 会让全部会话的 token 流与 WS 心跳停摆到 timeout（10s）。下面的"调度不变量"
//      测试专门守住这一点：它对本仓库的其它异步改造同样适用。
//
// 运行：node --test server/git-async.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitOut, parseWorktrees, parseBranches } from './git-async.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

// ── parseWorktrees ────────────────────────────────────────────────────────
// 取自本仓库的真实输出形态（含空行分隔、Windows 反斜杠路径、refs/heads/ 前缀）
const REAL_PORCELAIN = [
  'worktree C:/Users/T203-15/yfworking',
  'HEAD dee7c2886ddc7b7099ee15192ae779ce887d5588',
  'branch refs/heads/feature/app-universal-onboarding',
  '',
  'worktree C:\\Users\\T203-15\\yfworking\\.worktrees\\knowledge-s1',
  'HEAD f620444ea328225463ed28f3cf6967bcc01d4c05',
  'branch refs/heads/knowledge-s1',
  '',
].join('\n')

test('parseWorktrees：分支名不得被截断（回归 slice(21) 的 off-by-3）', () => {
  const w = parseWorktrees(REAL_PORCELAIN)
  assert.equal(w.length, 2)
  assert.equal(w[0].branch, 'feature/app-universal-onboarding')   // 旧实现得到 'ture/app-universal-onboarding'
  assert.equal(w[1].branch, 'knowledge-s1')                        // 旧实现得到 'wledge-s1'
})

test('parseWorktrees：路径统一为正斜杠，主工作树与子工作树都取到', () => {
  const w = parseWorktrees(REAL_PORCELAIN)
  assert.equal(w[0].path, 'C:/Users/T203-15/yfworking')
  assert.equal(w[1].path, 'C:/Users/T203-15/yfworking/.worktrees/knowledge-s1')
  assert.ok(!w.some((x) => x.path.includes('\\')), ' 反斜杠必须已归一')
})

test('parseWorktrees：无 branch 行时回退 (detached)，不吞掉该条目', () => {
  const w = parseWorktrees('worktree /repo\nHEAD 1234567890abcdef\n\n')
  assert.deepEqual(w, [{ path: '/repo', branch: '(detached)' }])
})

test('parseWorktrees：空输出 → 空数组（git 无工作树时不抛）', () => {
  assert.deepEqual(parseWorktrees(''), [])
  assert.deepEqual(parseWorktrees('\n\n'), [])
})

// ── parseBranches ─────────────────────────────────────────────────────────
test('parseBranches：逐行 trim、丢弃空行与末尾换行', () => {
  assert.deepEqual(parseBranches('main\n  dev \n\n  feature/x\n\n'), ['main', 'dev', 'feature/x'])
  assert.deepEqual(parseBranches('   \n'), [])
})

// ── gitOut 真实调用 ───────────────────────────────────────────────────────
test('gitOut：真实调用返回 stdout（已 trim）', async () => {
  const out = await gitOut(['--version'])
  assert.match(out, /^git version/)
})

test('gitOut：非 git 目录 → reject，且错误信息来自 git 的 stderr（比"exit 128"有用）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'yfw-git-async-'))
  try {
    await assert.rejects(
      () => gitOut(['rev-parse', '--show-toplevel'], { cwd: tmp }),
      (e) => e instanceof Error && e.message.length > 0 && !/退出码/.test(e.message),
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('gitOut：输出超过 maxBuffer → reject 并说明上限（防跑飞子进程吃光内存）', async () => {
  // `git --version` 稳定输出 ~28B，用 10B 上限必然触发
  await assert.rejects(
    () => gitOut(['--version'], { maxBuffer: 10 }),
    /超过上限/,
  )
})

test('gitOut：cwd 不存在 → reject（不抛出未捕获异常）', async () => {
  await assert.rejects(() => gitOut(['--version'], { cwd: join(tmpdir(), 'yfw-no-such-dir-xyz') }))
})

// ── 关键不变量：不阻塞事件循环 ────────────────────────────────────────────
test('调度不变量：git 子进程运行期间事件循环仍可调度（这正是弃用 execSync 的原因）', async () => {
  let settled = false
  const p = gitOut(['--version']).then(() => { settled = true })
  // 让出一次事件循环：若实现是同步的（execSync），此刻 git 早已跑完、settled 必为 true
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false, 'git 尚未返回时事件循环必须已获得调度机会')
  await p
  assert.equal(settled, true)
})

test('并发：多个 git 调用可同时在飞（同步实现只能串行）', async () => {
  const started = Date.now()
  const outs = await Promise.all([
    gitOut(['--version']),
    gitOut(['worktree', 'list', '--porcelain'], { cwd: REPO }),
    gitOut(['branch', '-a', '--format=%(refname:short)'], { cwd: REPO }),
  ])
  assert.match(outs[0], /^git version/)
  // 真实解析一遍，确保参数数组形态（非 shell 拼接）能被 git 正确接受
  assert.ok(Array.isArray(parseWorktrees(outs[1])))
  assert.ok(Array.isArray(parseBranches(outs[2])))
  assert.ok(Date.now() - started < 30_000, ' 三个调用不应慢到像串行 + 阻塞')
})
