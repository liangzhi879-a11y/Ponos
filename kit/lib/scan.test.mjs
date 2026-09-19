// kit/lib/scan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMAINS, trackedFiles, domainOf, isTestFile, codeFiles, inDomains, readTracked } from './scan.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('trackedFiles 返回已入库文件（POSIX 分隔、数量级正确）', () => {
  const files = trackedFiles({ root: ROOT })
  assert.ok(files.length > 1000, `已入库文件应超过 1000，实测 ${files.length}`)
  assert.equal(files.some((f) => f.includes('\\')), false, '路径分隔符必须已归一为 /')
})

// G4 回归：扫描域 = git ls-files，**不是磁盘遍历**。
// ★ 构造要求（Task 1 二轮返工）：这里造的是**真实存在的目录与文件**（mkdtempSync），
//   而不是 `root:'/fake'` 那种"磁盘上一个文件都没有"的空场景 —— 后者下
//   "磁盘上有、git 未跟踪的文件不得进入结果"这句话是**空断言**（磁盘上根本没有那些文件，
//   任何实现都满足它）。实测：把 scan.mjs 改成"git ls-files ∪ 磁盘遍历"（即 G4 真正要防的回归），
//   空场景版本的测试仍 EXIT=0，**回归未被发现**。
//   同时不依赖本机环境：scratch/ 是 gitignored（.gitignore:21）且 CI 没有创建它的步骤，
//   依赖"本机恰好存在 scratch/"会让测试本地绿、CI 红。所以：临时目录 + 注入 exec。
test('trackedFiles 只含已跟踪文件：磁盘上真实存在但未入库的文件不得进入扫描域（G4）', () => {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  const onDiskButUntracked = ['scratch/ponos-repo/src/index.ts', 'scratch/claude-code-ref/a.ts', 'release/YFWorking/app.exe']
  const tracked = ['src/a.ts', 'kernel/b.mjs']
  // 1) 把"已跟踪"与"磁盘上有但未入库"的文件都**真实写到磁盘**
  for (const f of [...tracked, ...onDiskButUntracked]) {
    const abs = join(root, f)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `// ${f}\n`)
  }
  for (const f of onDiskButUntracked) {
    assert.equal(existsSync(join(root, f)), true, `前提：${f} 必须真实存在于磁盘（否则下面的断言没有约束力）`)
  }
  // 2) 注入 exec：模拟 `git ls-files -z` 只输出已跟踪文件
  const exec = (_bin, _args) => tracked.join('\0') + '\0'
  const files = trackedFiles({ root, gitBin: 'git', exec })
  // 正向：已入库的必须在
  for (const f of tracked) assert.ok(files.includes(f), `${f} 已入库，必须进入扫描域`)
  // 反向（G4 的约束力所在）：真实存在于磁盘但未入库的必须**不**在
  for (const f of onDiskButUntracked) {
    assert.equal(files.includes(f), false, `${f} 真实存在于磁盘但未入库，不得进入扫描域（扫描域只能是 git ls-files）`)
  }
  // 顺带断言精确相等（没有多出别的路径）
  assert.deepEqual(files, tracked)
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
