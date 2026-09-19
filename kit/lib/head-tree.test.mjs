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
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { materializeHead, headTreeDir } from './head-tree.mjs'

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
  const h = materializeHead({ root, cacheDir: cacheDir() })
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

  const h = materializeHead({ root, cacheDir: cacheDir() })
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
  const first = materializeHead({ root, cacheDir: cache })
  assert.equal(first.cached, false, '首次必须真的物化')
  const again = materializeHead({ root, cacheDir: cache })
  assert.equal(again.cached, true, '同 sha 必须命中缓存（否则每次 check 都写 35MB）')
  assert.equal(again.dir, first.dir)

  writeFileSync(join(root, 'server/b.mjs'), "export const b = (p) => p === '/b'\n")
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'add b'])
  const after = materializeHead({ root, cacheDir: cache })
  assert.equal(after.cached, false, '新提交 ⇒ 新 sha ⇒ 必须重建')
  assert.notEqual(after.sha, first.sha)
  assert.deepEqual(after.files.sort(), [...Object.keys(FILES), 'server/b.mjs'].sort())
  assert.equal(readFileSync(join(after.dir, 'server/b.mjs'), 'utf8'), "export const b = (p) => p === '/b'\n")
})

test('headTreeDir：缓存目录键控 (仓路径, sha) —— 不同 sha / 不同仓不得共用目录', () => {
  const a = headTreeDir({ cacheDir: '/tmp/c', root: '/repo/one', sha: 'a'.repeat(40) })
  const b = headTreeDir({ cacheDir: '/tmp/c', root: '/repo/one', sha: 'b'.repeat(40) })
  const c = headTreeDir({ cacheDir: '/tmp/c', root: '/repo/two', sha: 'a'.repeat(40) })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.equal(headTreeDir({ cacheDir: '/tmp/c', root: '/repo/one', sha: 'a'.repeat(40) }), a)
})

test('★HEAD 不可读（空仓/非仓）→ available:false + error，不抛（由调用方报出来）', () => {
  const empty = repo({ 'a.txt': 'x\n' }, { commit: false })   // git init + add，没有提交
  const h = materializeHead({ root: empty, cacheDir: cacheDir() })
  assert.equal(h.available, false)
  assert.equal(h.dir, null)
  assert.equal(typeof h.error, 'string')
  assert.ok(h.error.length > 0)
  const stray = mkdtempSync(join(tmpdir(), 'yfw-nogit-'))
  const h2 = materializeHead({ root: stray, cacheDir: cacheDir() })
  assert.equal(h2.available, false, '非 git 目录同样返回 available:false，不得抛')
})
