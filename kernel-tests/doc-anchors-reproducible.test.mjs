// kernel-tests/doc-anchors-reproducible.test.mjs —— 门禁 C 必须「处处绿」，不能只在本地绿
// ---------------------------------------------------------------------------
// 事故背景（2026-09-18，本测试就是为它而写）：
// `scripts/check-doc-anchors.mjs` 的「文档路径存在性」判据原本是 `existsSync(resolve(ROOT, p))`
// —— 拿**工作树**判定。于是同一提交出现两种结果：
//   · 本地：0 问题（因为 gitignored 的 `release/`、`scratch/`、`kernel-dist/` 恰好在磁盘上）；
//   · 干净检出（CI / 新克隆 / 审查者）：**13 处**悬空引用。
// 这类"只在本地绿"的门禁**无法进 CI**，也就等于没有门禁 —— 而进 CI 正是 P2-4① 的全部目的。
//
// 修法：判据改为「**是否入库**」（`git ls-files` 成员），并把"本地/构建产物目录"的引用
// 整体跳过（它们不在仓库内容范围内，门禁的用途对它们不适用）。
//
// 本测试用 `git worktree` 造一个**只含已跟踪文件**的检出 —— 那正是 CI / 新克隆的视角。
// 若判据哪天退回"盘上是否有"，本地仍会绿，但这里会红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = 'scripts/check-doc-anchors.mjs'

test('门禁在「只含已跟踪文件」的干净检出里必须通过（防"只在本地绿"）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'yfw-doc-anchors-'))
  const wt = join(tmp, 'clean-checkout')
  try {
    // git worktree 的检出只含**已跟踪**文件 ⇒ 精确模拟 CI / 新克隆（无 release/、无 scratch/、无 node_modules）
    execFileSync('git', ['worktree', 'add', '--detach', '--quiet', wt, 'HEAD'], { cwd: ROOT, stdio: 'pipe' })
    const r = spawnSync(process.execPath, [GATE], { cwd: wt, encoding: 'utf8' })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    assert.equal(r.status, 0,
      '门禁在干净检出里失败 —— 说明判据依赖了工作树（gitignored 文件/构建产物），'
      + '这类门禁无法进 CI。原始输出：\n' + out.slice(-4000))
    assert.match(out, /文档路径存在性/, '门禁应照常输出检查项')
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT, stdio: 'pipe' }) } catch { /* 尽力清理 */ }
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('门禁的路径判据是「是否入库」，不是「盘上是否有」（回归守卫）', () => {
  const src = readFileSync(join(ROOT, GATE), 'utf8')
  // ① 曾经的反模式：拿工作树判定文档路径。它一旦回来，"本地绿/CI 红"就会重现。
  assert.equal(/existsSync\(resolve\(ROOT, p\)\)/.test(src), false,
    '文档路径的存在性判据不得退回 existsSync(工作树) —— 那会让门禁在干净检出里失败')
  // ② 正确判据的依据：git 跟踪清单
  assert.match(src, /'ls-files'/, '判据应基于 git ls-files（入库文件清单）')
  // ③ 本地/构建产物目录的跳过清单必须是**已提交的显式清单**（用 git check-ignore 会让结果随本机
  //    的 .git/info/exclude 变化 —— 那正是要消灭的不可复现）
  assert.match(src, /LOCAL_PREFIXES/, '应有本地/产物目录的跳过清单')
  assert.equal(/check-ignore/.test(src), false,
    '不得用 git check-ignore 判本地路径（它读本机的 .git/info/exclude，结果不可复现）')
})

test('本地/构建产物清单覆盖 release/、scratch/、kernel-dist/ 等非仓库内容', () => {
  const src = readFileSync(join(ROOT, GATE), 'utf8')
  const m = src.match(/const LOCAL_PREFIXES = \[([^\]]*)\]/)
  assert.ok(m, '找不到 LOCAL_PREFIXES 定义')
  const list = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  for (const want of ['scratch/', 'release/', 'kernel-dist/', 'dist/']) {
    assert.ok(list.includes(want), `LOCAL_PREFIXES 应包含 ${want}（本地/构建产物，不在仓库内容范围内）`)
  }
})
