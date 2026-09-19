// kit/lib/scan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMAINS, trackedFiles, domainOf, isTestFile, codeFiles, inDomains, readTracked } from './scan.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('trackedFiles 返回已入库文件（POSIX 分隔、数量级正确）', () => {
  const files = trackedFiles({ root: ROOT })
  assert.ok(files.length > 1000, `已入库文件应超过 1000，实测 ${files.length}`)
  assert.equal(files.some((f) => f.includes('\\')), false, '路径分隔符必须已归一为 /')
})

// G4 回归：扫描域 = git ls-files，不是磁盘遍历。
// ★ 必须可注入构造（Task 1 返工）：**不得**依赖本机 disk 上恰好存在 scratch/ ——
//    scratch/ 是 gitignored（.gitignore:21）、不入库，CI 工作流也没有任何创建它的步骤，
//    于是"本地绿、CI 红"。用注入的 exec 造出"磁盘有、git 未跟踪"的场景，
//    约束力不依赖环境，且正反两面都能断言。
test('trackedFiles 只含已跟踪文件：磁盘上存在但未入库的文件不得进入扫描域（G4）', () => {
  const onDiskButUntracked = ['scratch/ponos-repo/src/index.ts', 'scratch/claude-code-ref/a.ts', 'release/YFWorking/app.exe']
  const tracked = ['src/a.ts', 'kernel/b.mjs']
  // 注入 exec：模拟 `git ls-files -z` 只输出已跟踪文件
  const exec = (_bin, _args) => tracked.join('\0') + '\0'
  const files = trackedFiles({ root: '/fake', gitBin: 'git', exec })
  assert.deepEqual(files, tracked)
  for (const f of onDiskButUntracked) {
    assert.equal(files.includes(f), false, `${f} 在磁盘上但未入库，不得进入扫描域`)
  }
})

test('trackedFiles（真实仓库）：不含 scratch/ 与构建产物目录', () => {
  const files = trackedFiles({ root: ROOT })
  assert.ok(files.length > 1000, `已入库文件应超过 1000，实测 ${files.length}`)
  for (const prefix of ['scratch/', 'release/', 'dist/', 'kernel-dist/', 'runtime/']) {
    assert.equal(files.some((f) => f.startsWith(prefix)), false, `${prefix} 不得进入扫描域`)
  }
})

test('domainOf / inDomains 按顶层目录归属', () => {
  assert.equal(domainOf('src/lib/foo.ts'), 'src')
  assert.equal(domainOf('kernel/cli.mjs'), 'kernel')
  const picked = inDomains(['src/a.ts', 'kernel/b.mjs', 'docs/c.md'], ['src'])
  assert.deepEqual(picked, ['src/a.ts'])
  assert.ok(DOMAINS.includes('kernel') && DOMAINS.includes('public'))
})

test('isTestFile / codeFiles 排除测试文件', () => {
  assert.equal(isTestFile('src/lib/utils.test.ts'), true)
  assert.equal(isTestFile('src/lib/utils.ts'), false)
  const files = ['src/a.ts', 'src/a.test.ts', 'kernel/b.mjs', 'docs/c.md']
  assert.deepEqual(codeFiles(files), ['src/a.ts', 'kernel/b.mjs'])
  assert.deepEqual(codeFiles(files, { includeTests: true }), ['src/a.ts', 'src/a.test.ts', 'kernel/b.mjs'])
})

test('readTracked 读得到真实文件、读不到时返回 null', () => {
  assert.ok(readTracked({ root: ROOT, file: 'version.mjs' }).includes('APP_VERSION'))
  assert.equal(readTracked({ root: ROOT, file: 'no/such/file.mjs' }), null)
})
