// kit/lib/head-tree.test.mjs —— 提交态（HEAD）物化（DevKit P1 第 3 批）
//
// 为什么必须真 git 仓：本能力**全部价值**在于"回答的是提交态，不是工作树" ——
// 用假 exec 冒充只会把"在途改动被当提交态"这个唯一要防的错误掩盖掉（同 kit/cli.test.mjs 的夹具理由）。
//
// 每条断言都能独立失败：
//   ① 物化树的内容/文件集 = HEAD（不是工作树）；
//   ② 在途改动（改文件 + 新增未跟踪文件）**不进**物化树，且工作树本身**不被碰**（check 只读）；
//   ③ 缓存按 sha 键控：同 sha 命中缓存、新提交后自动重建；
//   ④ HEAD 不可读（空仓）→ 返回 `available:false` 而**不抛**（由调用方决定怎么报，不许崩）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { materializeHead, headTreeDir, worktreeClean } from './head-tree.mjs'

function git(root, args) {
  return execFileSync('git', ['-c', 'user.email=fx@example.com', '-c', 'user.name=fx', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' })
}

/** 真 git 夹具仓：写文件 → init → add → commit（HEAD 存在） */
function repo(files, { commit = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-head-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  git(root, ['init', '-q'])
  git(root, ['add', '-A'])
  if (commit) git(root, ['commit', '-qm', 'init'])
  return root
}
const cacheDir = () => mkdtempSync(join(tmpdir(), 'yfw-head-cache-'))
const FILES = {
  'package.json': '{"name":"fx","version":"1.0.0"}\n',
  'server/a.mjs': "export const route = (p) => p === '/a'\n",
  'docs/bridge-contract.md': '# 契约\n',
}

test('materializeHead：物化树的文件集与内容 = HEAD（不是工作树）', () => {
  const root = repo(FILES)
  const h = materializeHead({ root, cacheRoot: cacheDir() })
  assert.equal(h.available, true, `物化必须成功：${h.error}`)
  assert.equal(typeof h.sha, 'string')
  assert.deepEqual(h.files.sort(), Object.keys(FILES).sort())
  assert.equal(readFileSync(join(h.dir, 'server/a.mjs'), 'utf8'), FILES['server/a.mjs'])
})

test('★在途改动不进物化树，且物化不动工作树（check 只读仓库内文件）', () => {
  const root = repo(FILES)
  // 在途：改一个已入库文件 + 新增一个未入库文件（他人正在做的事）
  writeFileSync(join(root, 'server/a.mjs'), "export const route = (p) => p === '/wip'\n")
  writeFileSync(join(root, 'server/wip-routes.mjs'), "export const x = (p) => p === '/wip2'\n")
  const statusBefore = git(root, ['status', '--porcelain'])

  const h = materializeHead({ root, cacheRoot: cacheDir() })
  assert.equal(readFileSync(join(h.dir, 'server/a.mjs'), 'utf8'), FILES['server/a.mjs'],
    '物化树里必须是 HEAD 的内容（在途改动必须看不见）')
  assert.equal(existsSync(join(h.dir, 'server/wip-routes.mjs')), false, '未入库文件不得出现在物化树')
  assert.equal(h.files.includes('server/wip-routes.mjs'), false)
  // 工作树原样（物化只写系统临时目录）
  assert.equal(readFileSync(join(root, 'server/a.mjs'), 'utf8'), "export const route = (p) => p === '/wip'\n")
  assert.equal(git(root, ['status', '--porcelain']), statusBefore)
})

test('★缓存按 sha 键控：同 sha 命中；新提交后重建（含新提交的内容）', () => {
  const root = repo(FILES)
  const cache = cacheDir()
  const first = materializeHead({ root, cacheRoot: cache })
  assert.equal(first.cached, false, '首次必须真的物化')
  const again = materializeHead({ root, cacheRoot: cache })
  assert.equal(again.cached, true, '同 sha 必须命中缓存（否则每次 check 都写 35MB）')
  assert.equal(again.dir, first.dir)

  writeFileSync(join(root, 'server/b.mjs'), "export const b = (p) => p === '/b'\n")
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'add b'])
  const after = materializeHead({ root, cacheRoot: cache })
  assert.equal(after.cached, false, '新提交 ⇒ 新 sha ⇒ 必须重建')
  assert.notEqual(after.sha, first.sha)
  assert.deepEqual(after.files.sort(), [...Object.keys(FILES), 'server/b.mjs'].sort())
  assert.equal(readFileSync(join(after.dir, 'server/b.mjs'), 'utf8'), "export const b = (p) => p === '/b'\n")
})

test('headTreeDir：缓存目录键控 (仓路径, sha) —— 不同 sha / 不同仓不得共用目录', () => {
  const a = headTreeDir({ cacheRoot: '/tmp/c', root: '/repo/one', sha: 'a'.repeat(40) })
  const b = headTreeDir({ cacheRoot: '/tmp/c', root: '/repo/one', sha: 'b'.repeat(40) })
  const c = headTreeDir({ cacheRoot: '/tmp/c', root: '/repo/two', sha: 'a'.repeat(40) })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.equal(headTreeDir({ cacheRoot: '/tmp/c', root: '/repo/one', sha: 'a'.repeat(40) }), a)
})

test('★worktreeClean：只在"与 HEAD 完全一致"时为 true（改文件 / 未跟踪 / 暂存后都算脏）', () => {
  const root = repo(FILES)
  assert.equal(worktreeClean({ root }), true, '刚提交过的仓 = 干净')
  writeFileSync(join(root, 'server/a.mjs'), "export const route = (p) => p === '/wip'\n")
  assert.equal(worktreeClean({ root }), false, '改了已入库文件 ⇒ 脏')
  git(root, ['checkout', '--', 'server/a.mjs'])
  assert.equal(worktreeClean({ root }), true)
  writeFileSync(join(root, 'server/new.mjs'), "export const x = (p) => p === '/n'\n")
  assert.equal(worktreeClean({ root }), false, '未跟踪新文件 ⇒ 脏（否则 CT8 会漏报在途新端点）')
  git(root, ['add', '-A'])
  assert.equal(worktreeClean({ root }), false, '已暂存未提交 ⇒ 仍算脏')
  git(root, ['commit', '-qm', 'new'])
  assert.equal(worktreeClean({ root }), true)
  assert.equal(worktreeClean({ root: mkdtempSync(join(tmpdir(), 'yfw-nogit2-')) }), false,
    '非 git 目录 ⇒ false（保守：照常逐项比对，不假装"一致"）')
})

// ★ 第 4 批（收口，低危）：`git status` 会被 `assume-unchanged` / `skip-worktree` **骗过**。
//   审查实测：`git update-index --assume-unchanged <file>` 后往该文件追加真端点 ⇒ `worktreeClean=true`
//   ⇒ CT8 的等价性捷径直接跳过第二遍提取 ⇒ 在途端点**静默**。
//   危害等级：只丢**黄灯信息**（CT8 是"只报不拦"），不影响任何红 —— 所以这里不引入新的红，
//   只把"捷径的前提"补严：`status` 为空 **且** 索引里没有特殊标记（`git ls-files -v` 全为 `H`）。
//   保守方向明确：判错只会"多跑一遍全量提取"（≈0.8 s），绝不漏报。
test('★worktreeClean：assume-unchanged / skip-worktree 下不得假装"干净"（否则 CT8 捷径静默漏报）', () => {
  const root = repo(FILES)
  assert.equal(worktreeClean({ root }), true)
  git(root, ['update-index', '--assume-unchanged', 'server/a.mjs'])
  writeFileSync(join(root, 'server/a.mjs'), "export const route = (p) => p === '/wip'\n")
  assert.equal(git(root, ['status', '--porcelain']), '', '前提：assume-unchanged 的用途就是让 status **看不见**这处改动')
  assert.equal(worktreeClean({ root }), false, 'status 被骗过时必须由索引标记兜住 ⇒ 按脏处理（宁可多跑一遍，不多报/漏报）')
  git(root, ['update-index', '--no-assume-unchanged', 'server/a.mjs'])
  git(root, ['checkout', '--', 'server/a.mjs'])
  assert.equal(worktreeClean({ root }), true, '恢复正常后照旧 true（捷径没有被永久关掉）')
  git(root, ['update-index', '--skip-worktree', 'server/a.mjs'])
  writeFileSync(join(root, 'server/a.mjs'), "export const route = (p) => p === '/wip2'\n")
  assert.equal(git(root, ['status', '--porcelain']), '', '前提：skip-worktree 同样让 status 看不见改动')
  assert.equal(worktreeClean({ root }), false, 'skip-worktree 同样按脏处理')
})

test('★HEAD 不可读（空仓/非仓）→ available:false + error，不抛（由调用方报出来）', () => {
  const empty = repo({ 'a.txt': 'x\n' }, { commit: false })   // git init + add，没有提交
  const h = materializeHead({ root: empty, cacheRoot: cacheDir() })
  assert.equal(h.available, false)
  assert.equal(h.dir, null)
  assert.equal(typeof h.error, 'string')
  assert.ok(h.error.length > 0)
  const stray = mkdtempSync(join(tmpdir(), 'yfw-nogit-'))
  const h2 = materializeHead({ root: stray, cacheRoot: cacheDir() })
  assert.equal(h2.available, false, '非 git 目录同样返回 available:false，不得抛')
})

// ── ★ 并发回归（第 8 批）：并发跑门禁不得出现"半棵树" ──────────────────────────────
// 背景：物化缓存以前在**最终目录里原地** `rmSync` + 重建 ⇒ 两个进程同时冷启动会互删半棵树，
// 而 marker 又可能落在被删过的那棵上 ⇒ `usable()`（只看 "marker 在 + 首文件在"）误判完整
// ⇒ **稳定假红**（实测：干净缓存 + 4 并发 `check` ⇒ 2 个"红 0 / EXIT=0"、2 个"红 3 / EXIT=1"）。
// 现改为：构建全程在私有 staging 完成，安装只做一步 `rename`（同盘同父 ⇒ 原子）
// ⇒ 读者只会看到"旧的完整 / 新的完整 / 没有"，看不到半棵。
// ★ 两个设计要点让这条测试**不靠碰运气**：
//   ① 冷启动缓存（每个进程都必须自己构建）＋ **注入慢 exec** 人为拉长构建窗口 ⇒ "两个进程同时在构建"必然发生；
//   ② 断言的是**不变量**（4 个进程都必须拿到**完整**树、且至少一个真的构建过），与调度顺序无关。
test('★并发物化同一 sha：4 个进程各自构建也不得出现半棵树（原子安装）', async () => {
  const root = repo(FILES)
  const cache = mkdtempSync(join(tmpdir(), 'yfw-head-race-'))
  const mod = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'head-tree.mjs')).href
  const code = [
    "import { existsSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "import { execFileSync } from 'node:child_process'",
    `import { materializeHead } from ${JSON.stringify(mod)}`,
    'const [root, cacheRoot, delay] = process.argv.slice(1)',
    '// 每次 git 调用后拖一下：拉长"构建中"的窗口，制造必然的并发重叠',
    'const slow = (...args) => {',
    '  const out = execFileSync(...args)',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(delay))',
    '  return out',
    '}',
    'const r = materializeHead({ root, cacheRoot, exec: slow })',
    // 完整性自检：物化树里**每个**文件都必须真的存在（半棵树会让这里爆掉）
    'let missing = 0',
    'for (const f of r.files) if (!existsSync(join(r.dir, f))) missing++',
    'process.stdout.write(JSON.stringify({ available: r.available, cached: r.cached, files: r.files.length, missing, error: r.error }))',
  ].join('\n')
  const runOne = () => new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code, root, cache, '150'],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { err += d })
    c.on('close', (exit) => res({ exit, out, err }))
  })

  const results = await Promise.all([runOne(), runOne(), runOne(), runOne()])
  for (const r of results) {
    assert.equal(r.exit, 0, `子进程应正常退出（stderr：${r.err.slice(0, 300)}）`)
    const o = JSON.parse(r.out)
    assert.equal(o.available, true, `并发下也必须物化成功（error：${o.error}）`)
    assert.equal(o.missing, 0, `★ 不允许半棵树：${o.files} 个文件里有 ${o.missing} 个缺失`)
    assert.equal(o.files, Object.keys(FILES).length, '文件清单应与提交态一致')
  }
  // 反向自证：至少有一个进程**真的构建过**（否则可能 4 个都在读现成缓存 ⇒ 这条测试什么都没验证）
  const built = results.filter((r) => JSON.parse(r.out).cached === false).length
  assert.ok(built >= 1, `至少应有一个进程真的执行了构建，实际 cached:false 的只有 ${built} 个`)

  rmSync(cache, { recursive: true, force: true })
})
