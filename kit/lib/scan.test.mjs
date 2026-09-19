// kit/lib/scan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMAINS, trackedFiles, domainOf, isTestFile, codeFiles, inDomains, readTracked, stripComments } from './scan.mjs'

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

// ★ 第 4 批（收口，plan §6 D7）：域有两档 —— 契约**真值侧**仍是 `git ls-files`（索引，I2 不变）；
//   CT8 的**工作树侧**必须多含"未忽略的未跟踪文件"，否则 `git add` 之前的新路由模块对 CT8
//   完全不可见（审查实测：`?? server/zzz-wip-routes.mjs` 摆在磁盘上，CT8 却打印"与 HEAD 一致"）。
//   三条判据：① 未跟踪且未忽略的进；② 已跟踪的仍在；③ 被 .gitignore 覆盖的**不进**（域边界）。
//   ⚠️ 这不许退化成 readdirSync 磁盘遍历（D4：`release/` `kernel-dist/` 里的 `*-routes.mjs`
//   是**镜像副本**）：域仍由 git 给出，只是把"未忽略的未跟踪"也交给 git 列出来。
test('trackedFiles：默认只含索引；includeUntracked 时追加"未忽略的未跟踪文件"（CT8 的域）', () => {
  const root = mkdtempSync(join(tmpdir(), 'yfw-scan-wt-'))
  const write = (f) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), `// ${f}\n`) }
  for (const f of ['kitsrc/tracked.mjs', 'kitsrc/untracked.mjs', 'ignored/skip.mjs']) write(f)
  writeFileSync(join(root, '.gitignore'), 'ignored/\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', 'kitsrc/tracked.mjs', '.gitignore'], { cwd: root })   // 只 add，不提交

  const index = trackedFiles({ root })
  assert.deepEqual(index.slice().sort(), ['.gitignore', 'kitsrc/tracked.mjs'].sort(),
    '默认口径 = 索引（I2 不变：契约真值侧与既有全部规则靠它）')
  const work = trackedFiles({ root, includeUntracked: true })
  assert.equal(work.includes('kitsrc/untracked.mjs'), true,
    '未跟踪且未忽略的新文件必须进 CT8 的域（D7：它就是"磁盘有、索引无"的路由模块）')
  assert.equal(work.includes('kitsrc/tracked.mjs'), true, '已跟踪的仍在（域是"索引 ∪ 未忽略的未跟踪"，不是替换）')
  assert.equal(work.includes('ignored/skip.mjs'), false,
    '被 .gitignore 覆盖的不进（域边界；`release/` `kernel-dist/` `node_modules` 等副本同理在域外 —— D4）')
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

// ── stripComments（2026-09-19 P1 收尾）：源码级静态走查的"代码视图" ─────────────────
// 动机（实测误报）：脚本在注释里也会看见关键字 —— 审查在组件**注释**里写
// `import('@/lib/knowledgeApi')`（说明文字）就让 verify-knowledge-import-gui 假红了。

test('stripComments：行注释与块注释被剥掉（块注释里的换行保留）', () => {
  const src = [
    'const a = 1 // 注释里的 danger 字样',
    'const b = 2',
    'const c = 3 /* 多行块注释',
    '第二行仍注释 */ + 4',
    'const d = 5',
  ].join('\n')
  const view = stripComments(src)
  assert.equal(view.includes('danger'), false, '行注释内容必须被剥掉（否则注释会触发 import 关键字断言）')
  assert.equal(view.includes('注释'), false, '块注释内容必须被剥掉')
  assert.equal(view.split('\n').length, src.split('\n').length,
    '块注释里的换行必须保留：`^[ \\t]*key:` 这类按行判据依赖换行，缺了会跨行误匹配到上一行')
  assert.ok(view.includes('const a = 1') && view.includes('const d = 5') && view.includes('+ 4'), '真代码不得丢')
})

test('stripComments：字符串字面量里的 `//` 不被误剥（URL / 转义引号 / 模板串）', () => {
  const src = [
    "const url = 'https://example.com/a//b'",
    'const s = "见 // 这里"',
    'const t = `模板 // 保留`',
    "const e = 'it\\'s // 仍属字符串'",
    "const b = '/* 不是注释 */'",
    'const v = 6',
  ].join('\n')
  const view = stripComments(src)
  assert.ok(view.includes("'https://example.com/a//b'"), 'URL 里的 // 必须原样保留（否则会把整行后半截吃掉）')
  assert.ok(view.includes('"见 // 这里"'), '双引号字符串同理')
  assert.ok(view.includes('`模板 // 保留`'), '模板字符串同理')
  assert.ok(view.includes("'it\\'s // 仍属字符串'"), '转义引号不得被当字符串结束（提前结束会让 js 代码被当字符串、注释反而不剥）')
  assert.ok(view.includes("'/* 不是注释 */'"), '字符串里的块注释符号不得被误剥')
  assert.ok(view.includes('const v = 6'))
})

test('stripComments：JSX 的注释块同样被剥掉（这一类正是本轮误报来源）', () => {
  const tsx = [
    'export function A() {',
    '  return (',
    '    <div>',
    "      {/* 这里写 import('@/lib/knowledgeApi') 只是说明文字 */}",
    '      <span>ok</span>',
    '    </div>',
    '  )',
    '}',
  ].join('\n')
  const view = stripComments(tsx)
  assert.equal(view.includes('knowledgeApi'), false, 'JSX 注释块里的字面量必须被剥掉')
  assert.ok(view.includes('<span>ok</span>') && view.includes('</div>'), 'JSX 结构本身不得被破坏')
})

// ★ 本组是这次收口的**核心不变量**：剥注释只改"扫哪段文本"，不得改"值导入即红 / import type 放行"。
//   判据（verify-knowledge-import-gui 的 importSpecifiers 谓词）在代码视图里数说明符字面量：
//   注释里的提及必须消失，真代码里的**值**导入（静态/动态）必须一个不少地留着。
test('★ stripComments 只剥注释、不放宽判据：注释里的 knowledgeApi 提及消失，真代码的值导入仍在', () => {
  const code = [
    "// 说明：子组件曾经这么直连数据层 → import('@/lib/knowledgeApi')",
    "/* 旧写法：import { listSpaces } from '@/lib/knowledgeApi' */",
    "import type { KnowledgeDoc } from '@/lib/knowledgeApi'",
    "export async function probe() { return await import('@/lib/knowledgeApi') }",
    "import { listSpaces } from '@/lib/knowledgeApi'",
  ].join('\n')
  const view = stripComments(code)
  assert.ok(view.includes("import('@/lib/knowledgeApi')"), '真代码里的**动态值导入**必须留在代码视图（丢了门禁就假绿）')
  assert.ok(/import\s*\{\s*listSpaces\s*\}\s*from\s*'@\/lib\/knowledgeApi'/.test(view),
    '真代码里的**静态值导入**必须留在代码视图')
  assert.ok(view.includes('import type { KnowledgeDoc }'), 'import type 不受影响（它本就是允许的写法）')
  const mentions = view.split('@/lib/knowledgeApi').length - 1
  assert.equal(mentions, 3,
    `注释里的 2 处说明文字必须被剥掉，代码视图里只剩 3 处真代码引用（实测 ${mentions}）`)
})

// 已知边界如实钉住（方向必须偏**保守**）：JSX 文本里的撇号会被当字符串起始，
// 于是该段内的注释**漏剥**（不是误剥）。宁可漏剥（注释多留一点），绝不误剥（真代码被吃掉）。
test('stripComments 已知边界：JSX 文本里的撇号之后注释漏剥（偏保守，绝不误剥真代码）', () => {
  const tsx = ["<p>It's fine</p>", 'const a = 1 // 漏剥的注释', 'const b = 2'].join('\n')
  const view = stripComments(tsx)
  assert.ok(view.includes('const b = 2'), '真代码一个字都不能丢（误剥是危险方向）')
  assert.ok(view.includes('// 漏剥的注释'), '该边界下注释原样保留 = 漏剥（偏保守，允许）')
})
