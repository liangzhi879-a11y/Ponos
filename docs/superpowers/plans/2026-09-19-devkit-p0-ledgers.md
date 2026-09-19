# DevKit P0（版本 / 依赖台账与漂移门禁）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `kit/` 目录：版本台账 + 依赖台账 + 漂移基线与 `check/sync/view/stamp` 四命令，接入 CI 门禁，并修完 spec §10 的 17 条历史欠账（A1–A7、B1–B3、C1–C4）。

**Architecture:** `kit/manifest/*.json` 是唯一真源；`kit/lib/*.mjs` 是零第三方依赖的纯函数实现；`kit/cli.mjs` 是唯一入口（AI 经 Bash、CI 经 npm script）；dev 渠道身份由 `kit/cli.mjs stamp` 写入 `release/YFWorking/kit-stamp.json`（local-only，不进 CI 门禁）。

**Tech Stack:** Node ESM（`.mjs`）、`node:fs` / `node:path` / `node:crypto` / `node:child_process`、`node:test` + `node:assert/strict`、`git ls-files` 作为扫描域唯一来源。

---

## Global Constraints

以下约束来自 `docs/superpowers/specs/2026-09-19-devkit-design.md`，**每个任务都隐含适用**：

- **扫描域 = `git ls-files`**（不变量 I2）。禁止磁盘遍历当源码域；`scratch/`、`release/`、`dist/`、`kernel-dist/`、`runtime/` 均为 gitignored，不得进入任何判定。
- **门禁可复现**（I3）：不得读本机 `.git/info/exclude`；不得依赖"磁盘上恰好存在"的文件。
- **放行即人工**（I4）：白名单/漂移基线必须是**独立文件、人工编辑、每条写 `reason`**；绝不放进 `sync` 自动生成的文件。
- **单一真源**（I1）：一个事实只写一处。台账是声明，宿主文件是事实，`check` 负责比对二者。
- **零第三方依赖**：`kit/lib/*.mjs` 只允许 import `node:*` 与 `shared/atomic-write.mjs`。
- **不改三条构建链核心逻辑**：`scripts/build-kernel.mjs`、`vite.config.ts`、`electron-builder.yml` 不做结构性改动。
- **不改 `public/sample-skills/_common/*.py`**：98 个存量脚本**一个字符都不动**（spec §5.4 划界）；只登记，不回填 `__version__`。
- **不改调试版工作方式**：`release/YFWorking/` 的构建/同步链路不变；`stamp` 只**新增**一个文件。
- 测试写法：`import { test } from 'node:test'` + `import assert from 'node:assert/strict'`；临时目录用 `mkdtempSync(join(tmpdir(), 'yfw-kit-'))`（先例 `server/logs-routes.test.mjs`）。
- 单文件测试命令：`node --test kit/lib/<name>.test.mjs`。全量：`npm test`。
- **每个任务的最后一步都要 `git add`**：`git ls-files` 是扫描域，未 `add` 的测试文件不计入分层计数，`ci-preflight` 会报"工作树有、已跟踪无"。
- **提交信息一律用 `feat(kit): …` / `chore(kit): …` / `fix(kit): …` 前缀**。

---

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `kit/lib/scan.mjs` | 扫描基座：`git ls-files` 域扫描、测试文件判定、受控读取 | 1 |
| `kit/lib/scan.test.mjs` | 上述单测（含 G4 污染隔离回归） | 1 |
| `kit/lib/report.mjs` | 统一报告 schema + 人类可读渲染 | 2 |
| `kit/lib/report.test.mjs` | 报告 schema 与渲染单测 | 2 |
| `kit/lib/baseline.mjs` | 漂移基线：读取、套用、数量护栏 | 2 |
| `kit/lib/baseline.test.mjs` | 基线单测（含 G5 防滥用） | 2 |
| `kit/manifest/drift-baseline.json` | 🖐 人工维护的已知漂移（每条写 reason） | 2 |
| `kit/manifest/versions.json` | 版本台账（唯一真源） | 3 |
| `kit/lib/ledger.mjs` | 台账读写 + `syncVersions` / `syncDeps` | 3、5 |
| `kit/lib/ledger.test.mjs` | 读写与 sync 单测 | 3 |
| `kit/lib/version-rules.mjs` | V1–V8′ 校验规则 | 4 |
| `kit/lib/version-rules.test.mjs` | 每条规则正反例 | 4 |
| `kit/manifest/deps.json` | 依赖台账（唯一真源） | 5 |
| `kit/lib/dep-rules.mjs` | 五类引用证据 + P1–P6 规则 | 6 |
| `kit/lib/dep-rules.test.mjs` | 含 G3 三类假阳性回归夹具 | 6 |
| `kit/cli.mjs` | 唯一入口：`check` / `sync` / `view` / `stamp` | 7、13 |
| `kit/lib/stamp.mjs` | dev 渠道身份采集 | 13 |
| `kit/lib/stamp.test.mjs` | stamp 单测 | 13 |
| `kit/README.md` | 给 AI 的操作契约（结构化） | 14 |
| `kit/schema/versions.schema.json` | 台账 schema | 3 |
| `kit/schema/deps.schema.json` | 台账 schema | 5 |
| `scripts/test-tiers.mjs` | **改**：`TEST_GLOBS` 加 `kit/**/*.test.mjs` | 1 |
| `package.json` | **改**：test glob 同步、`kit:*` 脚本、构建脚本 npm script | 1、12 |
| `scripts/check-doc-anchors.mjs` | **改**：A′ 门禁升级为红 + 门禁 A 双向覆盖（C4） | 1 |
| `docs/_anchors.json` | **改**：`anchors:write` 同步（C1） | 12 |
| `scripts/bump-version.mjs` | **改**：新增 `pkg` 目标（A2）+ 注释口径（A3） | 8 |
| `server/version.test.mjs` | **新建**：补齐版本断言（A5） | 8 |
| `public/sample-skills/_common/_common_manifest.json` | **改**：全量登记 98 条（A6） | 9 |
| `skills-lock.json` | **改**：20 条哈希重算（A7） | 9 |
| `scripts/build-embedded-python.mjs` | **改**：包列表改读 `deps.json`（B2） | 11 |
| `docs/ci.md` | **改**：新增 DevKit 门禁一节 + 实测耗时 | 14 |
| `.github/workflows/ci.yml` | **改**：`test` 作业插入 `npm run kit:check` | 14 |

**任务依赖**：1 → 2 → 3 → 4 → 5 → 6 → 7。任务 8–12 与 1–7 相互独立（可并行）。任务 13 依赖 7 与 12（需 `git tag`）。任务 14 依赖 7 与 12。

---

## Task 1: kit 基座 + 扫描层 + 测试层接入 + C4 门禁加固

**为什么合并**：新增测试层若不同时修 C4，`kit/**/*.test.mjs` 漏同步时**不会让 CI 变红**（`scripts/check-doc-anchors.mjs:305` 用的是 `warnings.push`，退出码仍 0）。地基与地基的门禁必须一起交付，否则后续 13 个任务的测试都建立在"可能静默消失"的层上。

**Files:**
- Create: `kit/lib/scan.mjs`
- Create: `kit/lib/scan.test.mjs`
- Modify: `scripts/test-tiers.mjs`（`TEST_GLOBS`）
- Modify: `scripts/check-doc-anchors.mjs:300-316`（门禁 A′ 升级 + 门禁 A 双向 + **层→脚本映射**）
- Modify: `package.json`（`test` / `test:unit` glob + `kit:*` 占位脚本）
- Modify: `docs/ci.md`（口径说明补 kit 层一行 —— spec §7.1 明文列为"三处同步"之一）

**新增不变量（Task 1 返工补入）：`kit/lib/*_test.mjs` 的命名是错的，一律用 `*.test.mjs`**
spec §4/§13/§14 里写的 `kit/lib/*_test.mjs` 与 `TEST_GLOBS` 的 `kit/**/*.test.mjs` **不匹配** ——
按 spec 命名会让测试**静默不被任何层运行**（门禁 A 只统计 glob 命中数，发现不了）。
执行时统一用 `*.test.mjs`，并同步回改 spec 的措辞。

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `DOMAINS: string[]`、`CONFIG_FILES: string[]`
  - `trackedFiles({ root, gitBin?, exec? }): string[]`（POSIX 分隔、已入库）
  - `domainOf(file: string): string`
  - `isTestFile(file: string): boolean`
  - `codeFiles(files: string[], { includeTests?: boolean }): string[]`
  - `inDomains(files: string[], domains?: string[]): string[]`
  - `readTracked({ root: string, file: string }): string | null`

- [ ] **Step 1: 写失败测试**

Create `kit/lib/scan.test.mjs`：

```js
// kit/lib/scan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMAINS, trackedFiles, domainOf, isTestFile, codeFiles, inDomains, readTracked } from './scan.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('trackedFiles 返回已入库文件（POSIX 分隔、数量级正确）', () => {
  const files = trackedFiles({ root: ROOT })
  assert.ok(files.length > 1000, `已入库文件应超过 1000，实测 ${files.length}`)
  assert.equal(files.some((f) => f.includes('\\')), false, '路径分隔符必须已归一为 /')
})

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kit/lib/scan.test.mjs`
Expected: FAIL —— `Cannot find module '.../kit/lib/scan.mjs'`

- [ ] **Step 3: 写最小实现**

Create `kit/lib/scan.mjs`：

```js
// kit/lib/scan.mjs —— DevKit 的扫描基座（唯一入口）
//
// 设计不变量 I2：**扫描域 = git ls-files（已入库），不是磁盘遍历**。
// 为什么必须这样：`scratch/`（.gitignore:21 忽略）里有 claude-code 参考源码副本与 ponos-repo，
// 磁盘遍历会把**别人的代码**当成本仓源码 —— 实测那些副本里 `diff` / `@tanstack/react-virtual`
// 有大量 import，会直接翻转"未用依赖"的判定结论。
// 先例：scripts/check-doc-anchors.mjs 的 repoHas() 同样用 `git ls-files` 判定路径存在性，
// 理由是**门禁必须可复现**（本地因 gitignored 的 release/ 恰好存在而"绿"，干净克隆必然变红）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 参与依赖/版本判定的源码域（与 spec §6.2 一致；改成这里就必须同步改 spec 的数字） */
export const DOMAINS = ['src', 'electron', 'server', 'shared', 'kernel', 'scripts', 'build', 'pet', 'public', 'workflows']

/**
 * 根级配置文件：依赖通过这些文件被消费。
 * 没有这一类证据，`@tailwindcss/typography`、`@vitejs/plugin-react`、`tailwindcss`、`postcss`、
 * `autoprefixer`、`typescript`、`vite` 共 7 个会被**误判为未用**（实测）。
 */
export const CONFIG_FILES = [
  'vite.config.ts',
  'tailwind.config.ts',
  'postcss.config.js',
  'tsconfig.json',
  'tsconfig.node.json',
  'index.html',
  'electron-builder.yml',
  '.github/workflows/ci.yml',
]

const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx)$/

/** 列出 git **已跟踪** 文件（POSIX 分隔）。exec 可注入以便单测。 */
export function trackedFiles({ root, gitBin = 'git', exec = execFileSync } = {}) {
  if (!root) throw new Error('trackedFiles: 缺少 root')
  const out = exec(gitBin, ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return String(out).split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'))
}

/** 顶层目录名即域 */
export function domainOf(file) { return String(file).split('/')[0] }

/** 测试文件判定（与 scripts/test-tiers.mjs 的 glob 口径一致） */
export function isTestFile(file) { return /\.test\.(mjs|cjs|js|jsx|ts|tsx)$/.test(String(file)) }

/** 域内的代码文件；默认排除测试文件（测试里的 import 不算生产消费证据） */
export function codeFiles(files, { includeTests = false } = {}) {
  return files.filter((f) => CODE_EXT.test(f) && (includeTests || !isTestFile(f)))
}

/** 按域过滤 */
export function inDomains(files, domains = DOMAINS) {
  const set = new Set(domains)
  return files.filter((f) => set.has(domainOf(f)))
}

/** 读取某个已跟踪文件（读不到返回 null，由调用方决定怎么报，不抛） */
export function readTracked({ root, file }) {
  try { return readFileSync(join(root, file), 'utf8') } catch { return null }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kit/lib/scan.test.mjs`
Expected: PASS（5 个 test，0 fail）

- [ ] **Step 5: 加固 C4 —— 门禁 A′ 由黄升红 + 门禁 A 双向覆盖**

Modify `scripts/check-doc-anchors.mjs`。找到门禁 A′ 段（当前约 `:300-307`），把整段替换为：

```js
// 门禁 A（双向 ①）：锚点声明了但现场计数不符（原有方向）
for (const [g, n] of Object.entries(anchors.testFileCounts)) {
  const expect = (declared.testFileCounts || {})[g]
  if (expect !== undefined && n !== expect) {
    problems.push(`测试文件数[${g}] 与锚点不符：实际 ${n}，锚点 ${expect}（确认无误后跑 npm run anchors:write）`)
  }
}
// 门禁 A（双向 ②）：TEST_GLOBS 有该层，但锚点里没这个键（新增测试层后漏跑 anchors:write）
for (const g of TEST_GLOBS) {
  if (!(g in (declared.testFileCounts || {}))) {
    problems.push(`分层清单里的 ${g} 不在 docs/_anchors.json 的 testFileCounts 中（新增测试层后必须跑 npm run anchors:write）`)
  }
}
// 门禁 A′（★ 二轮返工后版本）：层 → 脚本 逐脚本对齐 + CI 链路覆盖（就地解析，无第二真源）
//
// 首版写法是 `JSON.stringify(pkg.scripts).includes(g)` —— 只看 glob 是否出现在**任一**脚本里。
// 两轮实测出的两个漏洞：
//   ① 只加进 `test`、漏了 `test:unit`（CI 链路 test:ci → test:unit 从不跑 test）→ 旧判据 EXIT=0；
//   ② 按 `ciChain.includes(scriptName)` 子串判断 → 把 test:unit 改名 test:unit:legacy
//      （脚本仍在但 CI 不再跑它）→ 旧判据同样 EXIT=0。
// 所以：(1) 每层在 TIER_SCRIPTS 声明必须出现的脚本名，逐脚本断言；
//      (2) 覆盖率用 parseCiChain **就地解析** `test:ci` 原文后按 token 精确匹配。
import { TIER_SCRIPTS, ciChainScripts } from './test-tiers.mjs'
let pkgScripts = {}
try { pkgScripts = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts || {} }
catch { problems.push('无法读取 package.json 校验分层清单一致性（门禁 A′ 失效）') }

for (const [glob, required] of Object.entries(TIER_SCRIPTS)) {
  for (const scriptName of required) {
    const body = pkgScripts[scriptName] || ''
    if (!body.includes(glob)) {
      problems.push(`分层清单里的 ${glob} 未出现在 package.json 的 ${scriptName} 脚本中（口径与脚本已漂移，请同步 test/test:unit 与 test:ci）`)
    }
  }
}
// test:ci 链路覆盖：每个层至少要有一个"CI 真的会跑到"的脚本
// ★ 两条防"判据落空"的红：缺 test:ci、或解析不出任何脚本 —— 原先这两种情形会静默全绿。
if (!pkgScripts['test:ci']) {
  problems.push('package.json 缺 test:ci 脚本（门禁 A′ 的链路覆盖判据无法生效）')
} else {
  const chain = ciChainScripts(pkgScripts)
  if (chain.length === 0) {
    problems.push('无法从 test:ci 解析出任何 npm 脚本（门禁 A′ 的链路覆盖判据落空，请检查 test:ci 的写法）')
  }
  for (const [glob, required] of Object.entries(TIER_SCRIPTS)) {
    if (!required.some((s) => chain.includes(s))) {
      problems.push(`${glob} 只挂在 CI 不跑的脚本（${required.join('、')}）上 —— test:ci 实际串联的是（${chain.join(' → ')}），覆盖不到该层`)
    }
  }
}
```

- [ ] **Step 6: 改分层清单与 package.json**

Modify `scripts/test-tiers.mjs` —— `TEST_GLOBS` 末尾（`'src/**/*.test.ts',` 之后）追加一行：

```js
  'kit/**/*.test.mjs',
```

**紧邻 `TEST_GLOBS` 再定义两张映射表**（与 `TEST_GLOBS` 同处 = 单一真源，禁止在门禁里另抄一份）：

```js
/** 层 → 必须包含该层 glob 的 npm 脚本名（与 TEST_GLOBS 同处定义 = 单一真源） */
export const TIER_SCRIPTS = {
  'shared/**/*.test.mjs': ['test', 'test:unit'],
  'electron/*.test.mjs': ['test', 'test:unit'],
  'src/**/*.test.ts': ['test', 'test:unit'],
  'kit/**/*.test.mjs': ['test', 'test:unit'],
  'server/*.test.mjs': ['test', 'test:server'],
  'kernel-tests/*.test.mjs': ['test', 'test:kernel'],
}

/**
 * ★ 刻意**不**定义 `CI_CHAIN_SCRIPTS` 常量。
 *   原因（Task 1 二轮返工实测）：那份常量是 `test:ci` 的第二份真源 ——
 *   新增一层专用脚本（如 `test:kit`）并把它真正串进 `test:ci` 后，常量不会自动更新，
 *   于是门禁报"只挂在 CI 不跑的脚本上"，**消息与事实相反**（误报）。
 *   改为就地解析 `test:ci` 的原文，见下方 parseCiChain。
 */

/**
 * 从 `test:ci` 的脚本文本里解析出**真正被串联执行**的脚本名。
 * 必须按 `&&` / `||` 切分后做 token 精确匹配，**不能用子串 includes** ——
 * 否则把 `npm run test:unit` 改成 `npm run test:unit:legacy`（脚本仍在但 CI 不再跑它）
 * 会被判为"覆盖到了"，四层测试在 CI 里静默不跑而门禁全绿。
 */
export function parseCiChain(scripts) {
  const body = (scripts && scripts['test:ci']) || ''
  const names = []
  for (const seg of body.split(/&&|\|\|/)) {
    const m = seg.trim().match(/^npm(?:\s+run)?\s+([\w:.-]+)/)
    if (m) names.push(m[1])
  }
  return names
}

/** 便捷包装：直接给 package.json 的 scripts 对象 */
export function ciChainScripts(scripts) { return parseCiChain(scripts) }
```

（`TEST_GLOBS` 与 `TIER_SCRIPTS` 的键必须一一对应。`test-tiers.mjs` 头部注释要写明：**新增一层测试 = 改 `TEST_GLOBS` + `TIER_SCRIPTS` + `package.json` 对应脚本 + `docs/ci.md` 口径，再跑 `anchors:write`**，共四处。）

Modify `package.json`：

```jsonc
// "test": 尾部追加 "kit/**/*.test.mjs"
"test": "node --test --test-timeout=300000 \"shared/**/*.test.mjs\" \"server/*.test.mjs\" \"electron/*.test.mjs\" \"kernel-tests/*.test.mjs\" \"src/**/*.test.ts\" \"kit/**/*.test.mjs\"",
// "test:unit": 尾部追加 "kit/**/*.test.mjs"
"test:unit": "node --test --test-timeout=120000 \"shared/**/*.test.mjs\" \"electron/*.test.mjs\" \"src/**/*.test.ts\" \"kit/**/*.test.mjs\"",
```

同时在 `scripts` 里新增四行（任务 7/13 会实现它们；此处先落位，使 A′ 门禁的口径检查通过）：

```jsonc
"kit:check": "node kit/cli.mjs check",
"kit:sync": "node kit/cli.mjs sync",
"kit:view": "node kit/cli.mjs view --json",
"kit:stamp": "node kit/cli.mjs stamp",
```

- [ ] **Step 7: 验证 C4 真的能红（三个反例，逐脚本删净）**

> **★ 反例的写法本身有坑（Task 1 返工实测）**：`String.replace(搜索串, '')` **只替换第一处**。
> `kit/**/*.test.mjs` 同时出现在 `test` 与 `test:unit` 里，所以"删一处就以为删净"的命令
> **实测 EXIT=0**（第一处在 `test` 里，`test:unit` 仍残留）——反例根本没生效，却会被误读成
> "门禁失效"。下面改为**逐脚本删净并断言残留数为 0**的写法。

Run:
```bash
# 备份（不要用 git checkout 还原：本任务的改动尚未提交，会连自己的改动一起丢）
cp package.json /tmp/pkg.bak.json
cp docs/_anchors.json /tmp/anchors.bak.json

# 反例①：从 test 与 test:unit 里都删净 kit glob → 必须红
node -e "
const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));
for (const k of ['test','test:unit']) j.scripts[k]=j.scripts[k].split(' ').filter(t=>!t.includes('kit/**')).join(' ');
fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');
console.log('残留 kit glob 数:',['test','test:unit'].filter(k=>j.scripts[k].includes('kit/**')).length);
"
node scripts/check-doc-anchors.mjs ; echo "EXIT=$?"
cp /tmp/pkg.bak.json package.json

# 反例②：把 kit 键从 docs/_anchors.json 删掉 → 必须红
node -e "
const fs=require('fs');const f='docs/_anchors.json';const j=JSON.parse(fs.readFileSync(f,'utf8'));
delete j.testFileCounts['kit/**/*.test.mjs'];
j.testTotal=Object.values(j.testFileCounts).reduce((a,b)=>a+b,0);
fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');
"
node scripts/check-doc-anchors.mjs ; echo "EXIT=$?"
cp /tmp/anchors.bak.json docs/_anchors.json

# 反例③（★A′ 收紧后新增）：只从 CI 实跑的 test:unit 删 glob → 必须红
# 为什么需要它：CI 链路是 test:ci → test:unit，**从不跑 test**；
# 若 A′ 只检查"glob 出现在任一脚本里"，这个最现实的漂移形态仍会静默绿。
node -e "
const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.scripts['test:unit']=j.scripts['test:unit'].split(' ').filter(t=>!t.includes('kit/**')).join(' ');
fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');
console.log('test 含 kit:',j.scripts.test.includes('kit/**'),'| test:unit 含 kit:',j.scripts['test:unit'].includes('kit/**'));
"
node scripts/check-doc-anchors.mjs ; echo "EXIT=$?"
cp /tmp/pkg.bak.json package.json

# 还原确认
node scripts/check-doc-anchors.mjs ; echo "还原后 EXIT=$?"
rm -f /tmp/pkg.bak.json /tmp/anchors.bak.json
git status --porcelain -- package.json docs/_anchors.json
```
Expected: 三个反例的 `EXIT=` 均为非 0，错误信息分别含 `的 test 脚本中`/`的 test:unit 脚本中`（①③）与"不在 docs/_anchors.json 的 testFileCounts 中"（②）；还原后 `EXIT=0` 且 `git status` 只剩本任务自己的改动。
**另加两个防误报/防漏报的对抗检查（复审补入）**：
```bash
# 误报检查：把 test:ci 里的 test:unit 改名成 test:unit:legacy（test:unit 脚本仍在，但 CI 不再跑）
#   → 旧口径（子串 includes）会漏报（EXIT=0）；新口径必须红
# 漏报检查：新增一层 test:kit 并把 glob 放进它、同时在 test:ci 里真正串上 npm run test:kit
#   → 必须**不**误报（A′ 的覆盖判定要按 test:ci 实际解析出的脚本名，不能靠一份手写常量）
```
Expected: 前者红（提示 CI 链路覆盖不到该层）；后者绿。

- [ ] **Step 8: 跑预检确认新层被承认**

Run: `npm run test:preflight`
Expected: PASS，输出中 `kit/**/*.test.mjs` 计数为 `1`

- [ ] **Step 9: Commit**

```bash
git add kit/lib/scan.mjs kit/lib/scan.test.mjs scripts/test-tiers.mjs scripts/check-doc-anchors.mjs package.json docs/_anchors.json
git commit -m "feat(kit): 扫描基座（git ls-files 域扫描）+ 测试层接入 + C4 门禁加固

- kit/lib/scan.mjs：DOMAINS/CONFIG_FILES/trackedFiles/codeFiles/readTracked
- 扫描域限定 git ls-files：scratch/ 的参考代码副本不得污染判定（I2）
- TEST_GLOBS 新增 kit 层；TIER_SCRIPTS/CI_CHAIN_SCRIPTS 与 TEST_GLOBS 同处定义（单一真源）
- C4：门禁 A′ 由 warnings 升级为 problems 并改为**逐脚本**断言；
  门禁 A 补双向覆盖。判据收紧后，'只加进 test 漏了 test:unit'
  （CI 链路 test:ci → test:unit 从不跑 test）由 EXIT=0 变为 EXIT=1
- 三个反例 + 误报/漏报对抗检查均已实测（真实 EXIT 值见提交说明）"
```

---

## Task 2: 统一报告 schema 与漂移基线

**Files:**
- Create: `kit/lib/report.mjs`
- Create: `kit/lib/report.test.mjs`
- Create: `kit/lib/baseline.mjs`
- Create: `kit/lib/baseline.test.mjs`
- Create: `kit/manifest/drift-baseline.json`

**Interfaces:**
- Consumes: Task 1 的 `trackedFiles` / `readTracked`
- Produces:
  - `RED`/`YELLOW`/`BASELINED` 常量；`finding({rule, severity, subject, expected?, actual?, file?, line?, hint?}): Finding`
  - `checkResult({rule, title, evaluated?, passed?}): Check`
  - `makeReport({checks?, findings?, generatedAt?}): Report`（`Report = { ok, generatedAt, summary:{red,yellow,baselined,green,rules}, checks, findings }`）
  - `renderHuman(report): string`
  - `BASELINE_FILE`、`keyOf({rule, subject}): string`
  - `loadBaseline({root}): {version, _note, entries}`（文件缺失时返回空基线，不抛）
  - `applyBaseline(findings, baseline): { findings, used: string[], unused: string[] }`
  - `baselineGrowth({ baseline, recordedCount }): {exceeded, recordedCount} | null`

- [ ] **Step 1: 写失败测试**

Create `kit/lib/report.test.mjs`：

```js
// kit/lib/report.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RED, YELLOW, BASELINED, finding, checkResult, makeReport, renderHuman } from './report.mjs'

test('finding 只带非空字段（报告里不出现 undefined 噪声）', () => {
  const f = finding({ rule: 'V1', severity: RED, subject: 'APP_VERSION@version.mjs' })
  assert.deepEqual(f, { rule: 'V1', severity: 'red', subject: 'APP_VERSION@version.mjs' })
  const g = finding({ rule: 'V1', severity: RED, subject: 's', expected: 4, actual: '4', file: 'a.mjs', line: 9, hint: 'h' })
  assert.equal(g.expected, '4')      // 数值统一字符串化，避免类型差异造成的假不等
  assert.equal(g.actual, '4')
  assert.equal(g.line, 9)
})

test('makeReport：ok 只由 red 决定；green 统计通过的规则数', () => {
  const r = makeReport({
    checks: [checkResult({ rule: 'V1', title: '可解析-回读', passed: true }), checkResult({ rule: 'V2', title: '载体存在', passed: false })],
    findings: [finding({ rule: 'V7', severity: RED, subject: 'x' }), finding({ rule: 'P5', severity: YELLOW, subject: 'y' })],
    generatedAt: '2026-09-19T00:00:00.000Z',
  })
  assert.equal(r.ok, false)
  assert.deepEqual(r.summary, { red: 1, yellow: 1, baselined: 0, green: 1, rules: 2 })
})

test('makeReport：仅 yellow 时 ok 为 true（黄不阻断）', () => {
  const r = makeReport({ findings: [finding({ rule: 'P5', severity: YELLOW, subject: 'y' })] })
  assert.equal(r.ok, true)
  assert.equal(r.summary.red, 0)
})

test('renderHuman：红/黄/基线三段分明，含 file:line 与 hint', () => {
  const r = makeReport({ findings: [
    finding({ rule: 'V7', severity: RED, subject: 'skillsLock.brainstorming', expected: 'aaa', actual: 'bbb', file: 'skills-lock.json', line: 3, hint: '跑 npm run kit:sync 重算' }),
    finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' }),
    finding({ rule: 'V8', severity: BASELINED, subject: 'commonTools', reason: '存量豁免' }),
  ] })
  const text = renderHuman(r)
  assert.match(text, /红灯 1/)
  assert.match(text, /skills-lock\.json:3/)
  assert.match(text, /跑 npm run kit:sync 重算/)
  assert.match(text, /黄灯 1/)
  assert.match(text, /基线 1/)
  assert.match(text, /存量豁免/)
})
```

Create `kit/lib/baseline.test.mjs`：

```js
// kit/lib/baseline.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASELINE_FILE, keyOf, loadBaseline, applyBaseline, baselineGrowth } from './baseline.mjs'
import { RED, YELLOW, finding } from './report.mjs'

function fixture(baseline) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  mkdirSync(join(root, 'kit', 'manifest'), { recursive: true })
  if (baseline !== undefined) writeFileSync(join(root, BASELINE_FILE), JSON.stringify(baseline, null, 2))
  return root
}

test('loadBaseline：文件缺失返回空基线而非抛错', () => {
  const root = fixture(undefined)
  const b = loadBaseline({ root })
  assert.equal(b.version, 1)
  assert.deepEqual(b.entries, [])
})

test('loadBaseline：解析失败也返回空基线（不能因坏文件崩掉门禁）', () => {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  mkdirSync(join(root, 'kit', 'manifest'), { recursive: true })
  writeFileSync(join(root, BASELINE_FILE), '{ 坏 JSON')
  assert.deepEqual(loadBaseline({ root }).entries, [])
})

test('applyBaseline：命中降级为 baselined 并带 reason；未命中的原样保留', () => {
  const baseline = { version: 1, entries: [{ rule: 'P5', subject: 'python.diff', reason: '内嵌集是分发态最小集', at: '2026-09-19' }] }
  const findings = [
    finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' }),
    finding({ rule: 'V7', severity: RED, subject: 'skillsLock.x' }),
  ]
  const out = applyBaseline(findings, baseline)
  assert.equal(out.findings[0].severity, 'baselined')
  assert.equal(out.findings[0].reason, '内嵌集是分发态最小集')
  assert.equal(out.findings[1].severity, 'red')
  assert.deepEqual(out.used, [keyOf({ rule: 'P5', subject: 'python.diff' })])
})

// ★ 裁定规则 1 的反例：基线不得无声抹平红灯（这是本任务最重要的一条测试）
test('applyBaseline：登记了红灯但条目未显式认领 severity:red → 仍为红', () => {
  const baseline = { version: 1, entries: [{ rule: 'V7', subject: 'skillsLock.x', reason: '想豁免但没认领' }] }
  const out = applyBaseline([finding({ rule: 'V7', severity: RED, subject: 'skillsLock.x' })], baseline)
  assert.equal(out.findings[0].severity, 'red', '未显式认领 severity:red 时红灯必须保持红')
  assert.ok(out.findings[0].hint.includes('severity'), '必须提示如何正确认领')
})

test('applyBaseline：条目显式认领 severity:red → 才允许降级，且记下 baselinedFrom', () => {
  const baseline = { version: 1, entries: [{ rule: 'V7', subject: 'skillsLock.x', severity: 'red', reason: '20 条锁哈希待 A3 重算' }] }
  const out = applyBaseline([finding({ rule: 'V7', severity: RED, subject: 'skillsLock.x' })], baseline)
  assert.equal(out.findings[0].severity, 'baselined')
  assert.equal(out.findings[0].baselinedFrom, 'red', '必须能反查原本是红灯（报告的"其中红灯 M 条"靠它）')
})

// ★ 裁定规则 2 的反例：缺 reason 的条目不生效，且本身报红（I4 的强制执行点）
test('applyBaseline：条目缺 reason / reason 为空白 → 条目不生效并报 BASELINE_NO_REASON 红', () => {
  const baseline = { version: 1, entries: [{ rule: 'P5', subject: 'python.diff' }, { rule: 'P6', subject: 'x', reason: '   ' }] }
  const out = applyBaseline([finding({ rule: 'P5', severity: YELLOW, subject: 'python.diff' })], baseline)
  assert.equal(out.findings.find((f) => f.rule === 'P5').severity, 'yellow', '缺 reason 的条目不得生效')
  assert.equal(out.ignoredNoReason, 2)
  const nr = out.findings.filter((f) => f.rule === 'BASELINE_NO_REASON')
  assert.equal(nr.length, 2)
  assert.ok(nr.every((f) => f.severity === 'red'))
})

test('applyBaseline：基线里不再命中的条目进 unused（提示可摘除）', () => {
  const baseline = { version: 1, entries: [{ rule: 'V8', subject: 'gone', reason: 'r' }] }
  const out = applyBaseline([], baseline)
  assert.deepEqual(out.used, [])
  assert.deepEqual(out.unused, [keyOf({ rule: 'V8', subject: 'gone' })])
})

// G5 防滥用：基线是"欠账"不是"药方"，条目数不得增长；红灯豁免数另有一条护栏
test('baselineGrowth：条目总数与「红灯豁免数」分别超限都要报；未记录（null）时不管', () => {
  const b = { version: 1, entries: [{ rule: 'a', subject: 'b', reason: 'r' }, { rule: 'c', subject: 'd', reason: 'r' }] }
  assert.equal(baselineGrowth({ baseline: b, recordedCount: null, recordedRedCount: null }), null)
  assert.equal(baselineGrowth({ baseline: b, recordedCount: 2, recordedRedCount: 0 }), null)
  const g = baselineGrowth({ baseline: b, recordedCount: 1, recordedRedCount: 0 })
  assert.equal(g.exceeded, 2)
  assert.equal(g.count, 2)
  // 红灯豁免数：2 条里 1 条 severity:red，记录值 0 → 报 redExceeded
  const br = { version: 1, entries: [{ rule: 'a', subject: 'b', severity: 'red', reason: 'r' }, { rule: 'c', subject: 'd', reason: 'r' }] }
  const g2 = baselineGrowth({ baseline: br, recordedCount: 2, recordedRedCount: 0 })
  assert.equal(g2.redExceeded, 1)
  assert.equal(g2.redCount, 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kit/lib/report.test.mjs kit/lib/baseline.test.mjs`
Expected: FAIL —— `Cannot find module '.../report.mjs'`

- [ ] **Step 3: 写最小实现**

Create `kit/lib/report.mjs`：

```js
// kit/lib/report.mjs —— DevKit 的统一报告 schema（check 与 view 共用，是 AI 侧的稳定契约）
export const RED = 'red'
export const YELLOW = 'yellow'
export const BASELINED = 'baselined'

/**
 * 构造一条发现（finding）。
 * 刻意把 expected/actual 字符串化：版本常量里既有数字（INDEX_VERSION=4）又有字符串，
 * 若按原类型存进 JSON 再比对，会出现 `4 !== "4"` 这种与业务无关的假红。
 */
export function finding({ rule, severity, subject, expected, actual, file, line, hint, reason }) {
  const out = { rule, severity, subject }
  if (expected !== undefined) out.expected = String(expected)
  if (actual !== undefined) out.actual = String(actual)
  if (file) out.file = file
  if (line) out.line = line
  if (hint) out.hint = hint
  if (reason) out.reason = reason
  return out
}

/** 一条规则的执行结果（用于 summary.green：通过了几条规则） */
export function checkResult({ rule, title, evaluated = 0, passed = true }) {
  return { rule, title, evaluated, passed }
}

export function makeReport({ checks = [], findings = [], generatedAt = new Date().toISOString() } = {}) {
  const count = (s) => findings.filter((f) => f.severity === s).length
  const red = count(RED)
  return {
    ok: red === 0,
    generatedAt,
    summary: {
      red,
      yellow: count(YELLOW),
      baselined: count(BASELINED),
      green: checks.filter((c) => c.passed).length,
      rules: checks.length,
    },
    checks,
    findings,
  }
}

/** 人话报告（给人看；AI 侧读 JSON） */
export function renderHuman(report) {
  const lines = []
  const { red, yellow, baselined } = report.summary
  lines.push(`DevKit 检查：${report.ok ? '✅ 通过' : '❌ 未通过'}  （红灯 ${red} / 黄灯 ${yellow} / 基线 ${baselined}）`)
  const section = (severity, title) => {
    const items = report.findings.filter((f) => f.severity === severity)
    if (!items.length) return
    lines.push('')
    lines.push(`── ${title}（${items.length}）──`)
    for (const f of items) {
      const loc = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : ''
      const diff = (f.expected !== undefined && f.actual !== undefined) ? `  期望 ${f.expected} / 实际 ${f.actual}` : ''
      lines.push(`  [${f.rule}] ${f.subject}${loc ? '  ' + loc : ''}${diff}`)
      if (f.reason) lines.push(`        （已登记基线：${f.reason}）`)
      if (f.hint) lines.push(`        → ${f.hint}`)
    }
  }
  section(RED, '红灯（阻断）')
  section(YELLOW, '黄灯（提示）')
  section(BASELINED, '基线（已知断账）')
  return lines.join('\n')
}
```

Create `kit/lib/baseline.mjs`：

```js
// kit/lib/baseline.mjs —— 漂移基线：让门禁能在"有历史债"的仓库里当天上线且长期有效
//
// 设计不变量 I4：放行即人工 —— 基线是**独立文件、人工编辑、每条写 reason**。
// 为什么不能放进 sync 自动生成的台账：`sync` 会重写台账，若基线也在里面，
// "跑一次 sync"就等于"把所有问题自动放行"，门禁会被一次同步悄悄架空。
// （同一心智先例：docs/_anchors-allow.json 与自动生成的 docs/_anchors.json 分离。）
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const BASELINE_FILE = 'kit/manifest/drift-baseline.json'

export const KEY_SEP = '::'

/** 基线条目与 finding 的对账键（rule + subject 唯一确定一条欠账） */
export function keyOf({ rule, subject }) { return `${rule}${KEY_SEP}${subject}` }

/** 读基线；文件缺失/损坏一律返回空基线（门禁不能因坏文件崩掉） */
export function loadBaseline({ root }) {
  const p = join(root, BASELINE_FILE)
  const empty = { version: 1, _note: '已知漂移登记后不再报红，但条目数不得增加；减少时应摘除条目。', entries: [] }
  if (!existsSync(p)) return empty
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return { ...empty, ...j, entries: Array.isArray(j.entries) ? j.entries : [] }
  } catch { return empty }
}

/**
 * 套用基线：命中 → 降级为 baselined（附 reason）；未命中的原样保留。
 *
 * ★ 2026-09-19 裁定（spec §7.3 豁免规则）：**基线不得无声抹平红灯**。
 *   初版无条件降级，实测"加一行 JSON 就能把红灯变绿"，且报告首行照样打印「✅ 通过」——
 *   整个门禁可被单行人工编辑绕过，与 I4「放行即人工」的初衷相反
 *   （I4 要的是"人工且**可见**"，不是"人工即可静默"）。
 *   但完全禁止豁免红也不可行：P0 落地时仓库本身有 20 条锁哈希红，红不可豁免则门禁永远绿不了。
 *   故：可豁免，但必须**显式认领 + 始终可见 + 数量封顶**。
 *
 *   规则 1：默认只豁免**黄**。命中红灯时，只有条目显式写了 `severity:'red'` 才豁免；
 *          没写就不豁免（随手加 `{rule,subject,reason}` 只能豁免黄）。
 *   规则 2：`reason` 必填非空。缺失/空白 → 条目**不生效**，并额外报一条红 `BASELINE_NO_REASON`
 *          （把"I4 无处强制"变成"违反 I4 本身就是红灯"）。
 */
export function applyBaseline(findings, baseline) {
  const entries = baseline.entries || []
  const valid = []
  const noReason = []
  for (const e of entries) {
    if (typeof e.reason === 'string' && e.reason.trim() !== '') valid.push(e)
    else noReason.push(e)
  }
  const map = new Map(valid.map((e) => [keyOf(e), e]))
  const findingsOut = findings.map((f) => {
    const e = map.get(keyOf(f))
    if (!e) return f
    // 规则 1：红灯必须有条目显式认领
    const red = f.severity === 'red'
    if (red && e.severity !== 'red') {
      return { ...f, hint: `${f.hint || ''}（基线里登记了该条但未显式认领红灯，故仍报红；确认要豁免请在该条目加 "severity": "red"）`.trim() }
    }
    return { ...f, severity: 'baselined', baselinedFrom: f.severity, reason: e.reason }
  })
  // 规则 2：缺 reason 的条目不生效，本身作为一条红灯
  for (const e of noReason) {
    findingsOut.push({
      rule: 'BASELINE_NO_REASON', severity: 'red',
      subject: `${e.rule || '?'} ${e.subject || '?'}`,
      message: '基线条目缺 reason（不变量 I4：放行必须写明理由）—— 该条目已被忽略',
      hint: '给该条目补上 reason；确属误加则直接删除条目',
    })
  }
  const present = new Set(findings.map(keyOf))
  const used = [...map.keys()].filter((k) => present.has(k))
  const unused = [...map.keys()].filter((k) => !present.has(k))
  const effective = findingsOut.filter((f) => f.severity !== 'baselined').length
  return { findings: findingsOut, used, unused, ignoredNoReason: noReason.length, effective }
}

/**
 * 数量护栏：① 条目总数 ② 其中豁免红灯的条数 —— 均不得超过台账记录值。
 * 没有它，基线会变成"遇红就塞"的垃圾桶，门禁在半年内必然失效。
 */
export function baselineGrowth({ baseline, recordedCount, recordedRedCount }) {
  const entries = baseline.entries || []
  const n = entries.length
  const redN = entries.filter((e) => e.severity === 'red').length
  const out = { exceeded: null, redExceeded: null, recordedCount, recordedRedCount, count: n, redCount: redN }
  if (recordedCount !== null && recordedCount !== undefined && n > recordedCount) {
    out.exceeded = n
  }
  if (recordedRedCount !== null && recordedRedCount !== undefined && redN > recordedRedCount) {
    out.redExceeded = redN
  }
  if (out.exceeded === null && out.redExceeded === null) return null
  return out
}
```

Create `kit/manifest/drift-baseline.json`（初始为空 —— 按 spec D6，欠账在 P0 内修完而不是挂基线）：

```json
{
  "version": 1,
  "_note": "已知漂移登记后不再报红，但条目数不得增加；减少时应摘除条目。",
  "_shape": "{ rule, subject, reason, at }",
  "entries": []
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kit/lib/report.test.mjs kit/lib/baseline.test.mjs`
Expected: PASS（9 个 test，0 fail）

- [ ] **Step 5: Commit**

```bash
git add kit/lib/report.mjs kit/lib/report.test.mjs kit/lib/baseline.mjs kit/lib/baseline.test.mjs kit/manifest/drift-baseline.json
git commit -m "feat(kit): 统一报告 schema 与漂移基线（含数量护栏）

- report.mjs：RED/YELLOW/BASELINED + finding/checkResult/makeReport/renderHuman
  ok 只由 red 决定；expected/actual 统一字符串化，避免 4 vs \"4\" 的假红
- baseline.mjs：loadBaseline 对缺失/损坏文件返回空基线（门禁不崩）
  applyBaseline 给出 used/unused（提示可摘除）；baselineGrowth 防"遇红就塞"
- drift-baseline.json：人工维护、独立文件、每条写 reason（I4）"
```

---

## Task 3: 版本台账 —— 数据结构与 `sync`

**Files:**
- Create: `kit/manifest/versions.json`
- Create: `kit/schema/versions.schema.json`
- Create: `kit/lib/ledger.mjs`
- Create: `kit/lib/ledger.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `trackedFiles` / `codeFiles` / `inDomains` / `readTracked` / `isTestFile`
- Produces:
  - `LINE_SPECS: Array<{id,label,file,locator,mirror?}>`
  - `parseByLocator({ root, file, locator }): { value, raw } | null`
  - `keyOfVersion(entry): string`（`${id}@${file}`）
  - `discoverVersionConsts({ root, files }): Array<{id,value,file,line}>`
  - `syncVersions({ root, files? }): { data, added: string[], removed: string[] }`
  - `readVersions({ root }): object | null`、`writeVersions({ root, data }): void`
  - `readJson({ root, rel, fallback? })`、`writeJson({ root, rel, data })`
  - `sha256File({ root, file }): string | null`
  - **`skillsLock` 段只记 `{ source, field, ids }` 引用，不复制哈希值** —— 见下方"为什么"。

`versions.json` 形状（`sync` 产出，人工只允许改 `exclude` / `note` / `consumers` / `migrationNote`）：
> ★ 这 4 个（外加 `manual` 标记）是 `MANUAL_FIELDS` —— **lines 与 contracts 两个分区都必须继承它们**，
>   不得只在一个分区里做继承（Task 3 复审实测：初版 lines 会静默丢弃人工 `note`/`consumers`）。
>   继承时用显式白名单，**不要** `{...old}` 整条合并（否则陈旧的 `value`/`locator` 也会被继承回来）。

```jsonc
{
  "version": 1,
  "generatedBy": "node kit/cli.mjs sync",
  "exclude": [ { "file": "electron/app-llm.cjs", "id": "ANTHROPIC_VERSION", "reason": "外部协议版本（Anthropic Messages API），非本仓契约" } ],
  "history": { "baselineCount": 0, "commonToolsBaseline": 0, "records": [] },
  "lines": [ { "id": "APP_VERSION", "label": "Ponos 应用", "value": "dev 3.0.0", "valueType": "string",
               "file": "version.mjs", "line": 9, "locator": { "kind": "const", "name": "APP_VERSION" },
               "kind": "app-line", "note": "" } ],
  "contracts": [ { "id": "INDEX_VERSION", "value": 4, "valueType": "number", "file": "shared/knowledge-core.mjs", "line": 44,
                   "locator": { "kind": "const", "name": "INDEX_VERSION" }, "kind": "data-schema",
                   "migrationNote": "索引版本变更必须提供重建链（kernel/knowledge-import.mjs 的 LEDGER_VERSION 配合）",
                   "consumers": ["src/lib/knowledgeQuery.ts"], "note": "" } ],
  "skills": [ { "id": "gxtz-core-tables", "value": "1.40.1", "file": "public/sample-skills/gxtz-core-tables/SKILL.md", "source": "public/skills.json" } ],
  "skillsLock": { "source": "skills-lock.json", "field": "computedHash", "ids": ["brainstorming", "…"] },
  "commonTools": { "baseline": ["doc_to_md.py", "…"], "entries": [ { "file": "public/sample-skills/_common/doc_to_md.py", "version": "1.2.0", "versionSource": "manifest" } ] },
  "channels": {}
}
```

- [ ] **Step 1: 写失败测试**

Create `kit/lib/ledger.test.mjs`：

```js
// kit/lib/ledger.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseByLocator, keyOfVersion, discoverVersionConsts, syncVersions, readVersions } from './ledger.mjs'

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return root
}

test('parseByLocator(const)：字符串与数字都能解析', () => {
  const root = fixture({
    'a.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const INDEX_VERSION = 4\n",
  })
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'APP_VERSION' } }).value, 'dev 3.0.0')
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'INDEX_VERSION' } }).value, 4)
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'NOPE' } }), null)
})

test('parseByLocator(json)：读 package.json 的 version 字段', () => {
  const root = fixture({ 'p.json': '{ "name": "x", "version": "2.8.0" }' })
  assert.equal(parseByLocator({ root, file: 'p.json', locator: { kind: 'json', path: 'version' } }).value, '2.8.0')
})

test('parseByLocator：行尾注释与分号不干扰取值', () => {
  const root = fixture({ 'a.mjs': "const VAULT_VERSION = 1 // 密码库格式版本\nconst X_VERSION = 'a';\n" })
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'VAULT_VERSION' } }).value, 1)
  assert.equal(parseByLocator({ root, file: 'a.mjs', locator: { kind: 'const', name: 'X_VERSION' } }).value, 'a')
})

test('keyOfVersion = id@file（同一常量名出现在两个文件时必须可区分）', () => {
  assert.equal(keyOfVersion({ id: 'SCHEMA_VERSION', file: 'kernel/loop.mjs' }), 'SCHEMA_VERSION@kernel/loop.mjs')
  assert.notEqual(
    keyOfVersion({ id: 'SCHEMA_VERSION', file: 'kernel/loop.mjs' }),
    keyOfVersion({ id: 'SCHEMA_VERSION', file: 'server/workflow-store.mjs' }),
  )
})

test('discoverVersionConsts：只认以 VERSION 结尾的全大写常量，跳过测试文件', () => {
  const root = fixture({
    'k/a.mjs': "export const INDEX_VERSION = 4\nexport const OTHER = 1\n",
    'k/b.test.mjs': 'export const TEST_VERSION = 9\n',
  })
  const found = discoverVersionConsts({ root, files: ['k/a.mjs', 'k/b.test.mjs'] })
  assert.deepEqual(found.map((e) => e.id), ['INDEX_VERSION'])
})

test('syncVersions：首次 sync 建立台账；二次 sync 保留人工字段、只更新 value/line', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'k/c.mjs': 'export const INDEX_VERSION = 4\n',
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'k/c.mjs', 'public/skills.json']
  const first = syncVersions({ root, files })
  assert.equal(first.data.version, 1)
  assert.equal(first.data.lines.length, 4)
  assert.equal(first.data.contracts.length, 1)

  // 人工加字段后再 sync，必须保留
  const data = readVersions({ root })
  data.contracts[0].migrationNote = '人工写的迁移说明'
  data.contracts[0].consumers = ['src/mirror.ts']
  writeFileSync(join(root, 'kit/manifest/versions.json'), JSON.stringify(data, null, 2))

  // 改宿主文件的值 + 搬走一行，模拟真实漂移
  writeFileSync(join(root, 'k/c.mjs'), '\n\nexport const INDEX_VERSION = 5\n')
  const second = syncVersions({ root, files })
  const entry = second.data.contracts.find((e) => e.id === 'INDEX_VERSION')
  assert.equal(entry.value, 5)
  assert.equal(entry.line, 3)
  assert.equal(entry.migrationNote, '人工写的迁移说明')
  assert.deepEqual(entry.consumers, ['src/mirror.ts'])
})

test('syncVersions：exclude 列表里的常量不进台账', () => {
  const root = fixture({
    'version.mjs': "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n",
    'kernel/package.json': '{ "version": "0.2.0" }',
    'package.json': '{ "version": "2.8.0" }',
    'k/c.mjs': "export const ANTHROPIC_VERSION = '2023-06-01'\nexport const INDEX_VERSION = 4\n",
    'public/skills.json': '[]',
  })
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'k/c.mjs', 'public/skills.json']
  const { data } = syncVersions({ root, files })
  assert.equal(data.contracts.some((e) => e.id === 'ANTHROPIC_VERSION'), false)
  assert.equal(data.contracts.some((e) => e.id === 'INDEX_VERSION'), true)
})
```

> **注意**：`syncVersions` 的无参默认 `files` 会调 `trackedFiles`。测试里**始终注入 `files`**（临时目录不是 git 仓库）。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kit/lib/ledger.test.mjs`
Expected: FAIL —— `Cannot find module '.../ledger.mjs'`

- [ ] **Step 3: 写最小实现**

Create `kit/lib/ledger.mjs`：

```js
// kit/lib/ledger.mjs —— 台账读写 + 同步（versions / deps）
//
// "sync" 的职责是**从宿主文件发现事实、写进台账**；"check" 的职责是**回读宿主文件、与台账比对**。
// 两者永不共享"已解析的缓存值" —— 否则一个 bug 会同时污染写侧与读侧，门禁就成了自证。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../../shared/atomic-write.mjs'
import { trackedFiles, codeFiles, inDomains, readTracked, isTestFile } from './scan.mjs'

export const VERSIONS_FILE = 'kit/manifest/versions.json'
export const DEPS_FILE = 'kit/manifest/deps.json'

// ── 通用 JSON 读写 ─────────────────────────────────────────────────────────

export function readJson({ root, rel, fallback = null }) {
  const p = join(root, rel)
  if (!existsSync(p)) return fallback
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

/** 写台账用原子写（shared/atomic-write.mjs）：台账被半截写坏会让门禁全线误报 */
export function writeJson({ root, rel, data }) {
  writeFileAtomicSync(join(root, rel), JSON.stringify(data, null, 2) + '\n')
}

// ── 版本：四条版本线的定位方式（手写，因为它们的位置是刻意的契约） ────────────

export const LINE_SPECS = [
  { id: 'APP_VERSION', label: 'Ponos 应用（turbo 内核版）', file: 'version.mjs',
    locator: { kind: 'const', name: 'APP_VERSION' }, kind: 'app-line' },
  { id: 'KERNEL_VERSION', label: 'Ponos-Turbo 内核', file: 'version.mjs',
    locator: { kind: 'const', name: 'KERNEL_VERSION' }, kind: 'app-line',
    mirror: { file: 'kernel/package.json', locator: { kind: 'json', path: 'version' } } },
  { id: 'GUI_VERSION', label: 'GUI 发布线（Vite 注入 __APP_VERSION__）', file: 'package.json',
    locator: { kind: 'json', path: 'version' }, kind: 'app-line' },
  { id: 'KB_SCHEMA_VERSION', label: 'settings 文件 schema', file: 'version.mjs',
    locator: { kind: 'const', name: 'SCHEMA_VERSION' }, kind: 'data-schema',
    migrationNote: 'settings 无 schemaVersion 的旧文件视为 v0，读取时沿迁移链升级（version.mjs:15）' },
]

/**
 * 按 locator 从宿主文件解析出当前值。
 * const 分支刻意宽容：允许 `export` 前缀、行尾 `//` 注释、行尾分号、单/双引号。
 * 实测这些形态在仓里都真实存在（如 `const VAULT_VERSION = 1  // …`）。
 */
export function parseByLocator({ root, file, locator }) {
  const text = readTracked({ root, file })
  if (text === null) return null
  if (locator.kind === 'json') {
    try {
      const j = JSON.parse(text)
      const v = locator.path.split('.').reduce((o, k) => (o == null ? o : o[k]), j)
      return v === undefined ? null : { value: v, raw: String(v) }
    } catch { return null }
  }
  if (locator.kind === 'const') {
    const re = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${locator.name}\\s*=\\s*(.+?)\\s*$`, 'm')
    const m = text.match(re)
    if (!m) return null
    let raw = m[1].replace(/\/\/.*$/, '').replace(/;\s*$/, '').trim()
    const q = raw.match(/^(['"`])([\s\S]*)\1$/)
    if (q) return { value: q[2], raw }
    const n = Number(raw)
    if (!Number.isNaN(n) && raw !== '') return { value: n, raw }
    return { value: raw, raw }
  }
  throw new Error(`未知 locator.kind: ${locator.kind}`)
}

/** 台账键：`${id}@${file}` —— 同一常量名出现在两个文件时必须可区分（实测有两处 SCHEMA_VERSION） */
export function keyOfVersion(entry) { return `${entry.id}@${entry.file}` }

/** 发现规约：以 `VERSION` 结尾的全大写常量，形如 `<PREFIX>VERSION = <字面量>` */
const VERSION_CONST_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]*VERSION)\s*=\s*(.+?)\s*$/gm

/** 从已入库代码文件里发现所有版本常量（不含测试文件；测试里的不算契约） */
export function discoverVersionConsts({ root, files }) {
  const out = []
  for (const file of codeFiles(files)) {
    const text = readTracked({ root, file })
    if (text === null) continue
    VERSION_CONST_RE.lastIndex = 0
    let m
    while ((m = VERSION_CONST_RE.exec(text)) !== null) {
      const raw = m[2].replace(/\/\/.*$/, '').replace(/;\s*$/, '').trim()
      const q = raw.match(/^(['"`])([\s\S]*)\1$/)
      const value = q ? q[2] : (Number.isNaN(Number(raw)) ? raw : Number(raw))
      const line = text.slice(0, m.index).split('\n').length
      out.push({ id: m[1], value, valueType: typeof value, file, line, locator: { kind: 'const', name: m[1] }, kind: 'contract' })
    }
  }
  return out
}

// ── 技能版本（skills.json ↔ SKILL.md frontmatter） ──────────────────────────

export const SKILLS_JSON = 'public/skills.json'
export const SKILLS_DIR = 'public/sample-skills'

/** 从 SKILL.md 的 YAML frontmatter 取 version（支持带引号/不带引号） */
export function readSkillFrontmatterVersion({ root, file }) {
  const text = readTracked({ root, file })
  if (text === null) return null
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return null
  const m = fm[1].match(/^version:\s*["']?([^"'\n]+?)["']?\s*$/m)
  return m ? m[1].trim() : null
}

export function sha256File({ root, file }) {
  const text = readTracked({ root, file })
  if (text === null) return null
  return createHash('sha256').update(readFileSync(join(root, file))).digest('hex')
}

// ── _common 工具版本 ───────────────────────────────────────────────────────

export const COMMON_DIR = 'public/sample-skills/_common'
export const COMMON_MANIFEST = `${COMMON_DIR}/_common_manifest.json`

/** 实有 .py 清单（从 files 过滤，不用磁盘遍历 —— 保持与扫描域同一来源） */
export function listCommonPy(files) {
  const pre = `${COMMON_DIR}/`
  return files.filter((f) => f.startsWith(pre) && f.endsWith('.py')).map((f) => f.slice(pre.length)).sort()
}

// ── syncVersions ──────────────────────────────────────────────────────────

/**
 * 从宿主文件重建版本台账。
 * 合并语义：以发现结果为"骨架"，用**既有台账**覆盖人工字段（note/consumers/migrationNote/kind）。
 * 这样 `sync` 可以随时跑，不会把人工写的说明冲掉。
 */
export function syncVersions({ root, files, dryRun = false } = {}) {
  const tracked = files || trackedFiles({ root })
  const prev = readVersions({ root }) || {}
  const prevByKey = new Map((prev.contracts || []).map((e) => [keyOfVersion(e), e]))
  const excludes = prev.exclude || DEFAULT_EXCLUDES
  // ★ 排除按 **id 全局匹配**（不是 id@file）—— 实测 ANTHROPIC_VERSION 出现在 **两个**文件
  //   （electron/app-llm.cjs 与 electron/app-websearch.cjs），这是"外部协议版本"的属性，
  //   与它出现在哪个文件无关；按 id@file 匹配的话，新增第三个调用点就会漏排。
  //   JSON 里的 file 字段仅作"当前位于何处"的说明，不参与匹配。
  const excludeIds = new Set(excludes.map((e) => e.id))
  // ★ 版本线已纳管的常量不再重复进 contracts 分区。否则 APP_VERSION@version.mjs、
  //   KERNEL_VERSION@version.mjs、SCHEMA_VERSION@version.mjs 会**同时**出现在 lines 与
  //   contracts 两处（同一事实两份记录，违反不变量 I1），且 contracts 会变成 15 而非 14。
  const lineLocatorKeys = new Set(LINE_SPECS.map(
    (s) => `${s.locator.kind === 'const' ? s.locator.name : s.locator.path}@${s.file}`,
  ))

  // lines
  //
  // ★ 人工字段继承（Task 3 复审返工）：契约里承诺"人工只允许改 exclude / note / consumers /
  //   migrationNote"，但初版 lines 只做 `{...spec, value, valueType}` —— 宿主文件一旦改动导致
  //   sync 重建，人工在 lines 条目上写的 note / consumers 就会被**静默丢弃**。
  //   contracts 分支已经做了继承（`{...old, value, ...}`），lines 必须一致，否则同一条不变量
  //   （I1：sync 不得覆盖人工内容）在两个分区里行为不同。
  const prevLines = new Map((prev.lines || []).map((e) => [e.id, e]))
  const lines = LINE_SPECS.map((spec) => {
    const parsed = parseByLocator({ root, file: spec.file, locator: spec.locator })
    if (!parsed) return null
    const old = prevLines.get(spec.id)
    const entry = { ...spec, value: parsed.value, valueType: typeof parsed.value }
    if (spec.mirror) entry.mirrorValue = parseByLocator({ root, file: spec.mirror.file, locator: spec.mirror.locator })?.value ?? null
    // 只为人工可编辑的字段做继承，显式白名单（避免把陈旧的 value/locator 也一并继承回来）
    for (const k of MANUAL_FIELDS) if (old && k in old) entry[k] = old[k]
    return entry
  }).filter(Boolean)

  // contracts（发现 − 排除 − 版本线已纳管 + 人工字段保留）
  const discovered = discoverVersionConsts({ root, files: tracked })
    .filter((e) => !excludeIds.has(e.id) && !lineLocatorKeys.has(keyOfVersion(e)))
  const manualContracts = (prev.contracts || []).filter((e) => e.manual === true)
  const contracts = []
  for (const d of discovered) {
    const old = prevByKey.get(keyOfVersion(d))
    contracts.push(old ? { ...old, value: d.value, valueType: d.valueType, line: d.line, locator: d.locator } : d)
  }
  for (const m of manualContracts) if (!contracts.some((e) => keyOfVersion(e) === keyOfVersion(m))) contracts.push(m)

  // skills（skills.json ↔ frontmatter）
  const skillsJson = readJson({ root, rel: SKILLS_JSON, fallback: [] }) || []
  const skills = skillsJson
    .map((s) => {
      const file = `${SKILLS_DIR}/${s.id}/SKILL.md`
      const fm = readSkillFrontmatterVersion({ root, file })
      return { id: s.id, value: s.version ?? null, frontmatterVersion: fm, file }
    })
    .filter((s) => s.frontmatterVersion !== null || s.value !== null)

  // skillsLock（只记引用，不复制哈希 —— 见下方"为什么"）
  // ★ 为什么台账里不存 sha256：`sync` 会重写台账。若哈希也由 sync 写进台账，
  //   而 V7 又拿台账里的哈希去比对文件，那么"跑一次 sync"就必然让 V7 变绿 ——
  //   门禁被自己的 sync 架空（自证陷阱）。判据必须是**已提交的 lock 文件**（skills-lock.json）。
  //   更新 lock 是 `syncSkillsLock` 的职责（Task 9），V7 只读不改。
  const lock = readJson({ root, rel: 'skills-lock.json', fallback: { skills: {} } }) || { skills: {} }
  const skillsLock = { source: 'skills-lock.json', field: 'computedHash', ids: Object.keys(lock.skills || {}) }

  // commonTools（全量登记；未标注者 version=null + versionSource='unmarked'）
  const prevCommon = prev.commonTools || {}
  const prevEntries = new Map((prevCommon.entries || []).map((e) => [e.file, e]))
  const manifest = readJson({ root, rel: COMMON_MANIFEST, fallback: { tools: {} } }) || { tools: {} }
  const manifestTools = manifest.tools || {}
  const pyNames = listCommonPy(tracked)
  const commonEntries = pyNames.map((name) => {
    const file = `${COMMON_DIR}/${name}`
    const old = prevEntries.get(file)
    const mv = manifestTools[name]?.current_version
    if (old && old.versionSource === 'unmarked' && !mv) return old
    return mv
      ? { file, version: mv, versionSource: 'manifest' }
      : { file, version: null, versionSource: 'unmarked' }
  })
  const baselinePrev = Array.isArray(prevCommon.baseline) ? prevCommon.baseline : null
  const addedSinceBaseline = baselinePrev ? pyNames.filter((n) => !baselinePrev.includes(n)) : []

  const data = {
    version: 1,
    generatedBy: 'node kit/cli.mjs sync',
    _note: '本文件由 sync 生成骨架。人工只可编辑：exclude / note / consumers / migrationNote / manual 条目 / history。',
    exclude: excludes,
    history: prev.history || { baselineCount: 0, commonToolsBaseline: pyNames.length, records: [] },
    lines,
    contracts,
    skills,
    skillsLock,
    commonTools: {
      baseline: pyNames,
      addedSinceBaseline,
      entries: commonEntries,
    },
    channels: prev.channels || {},
  }
  data.history.commonToolsBaseline = pyNames.length
  data.history.baselineCount = (prev.history?.baselineCount ?? 0)

  if (!dryRun) writeJson({ root, rel: VERSIONS_FILE, data })
  const prevKeys = new Set((prev.contracts || []).map(keyOfVersion))
  const nowKeys = new Set(contracts.map(keyOfVersion))
  return {
    data,
    added: [...nowKeys].filter((k) => !prevKeys.has(k)),
    removed: [...prevKeys].filter((k) => !nowKeys.has(k)),
  }
}

/** 默认排除项：外部协议版本与上游技能资产，不是本仓契约（**按 id 全局匹配**，见 syncVersions） */
export const DEFAULT_EXCLUDES = [
  { id: 'ANTHROPIC_VERSION', file: 'electron/app-llm.cjs',
    reason: 'Anthropic Messages API 协议版本（外部标准），不参与本仓版本台账；另一调用点见 electron/app-websearch.cjs' },
  { id: 'SUPERPOWERS_VERSION', file: 'public/sample-skills/brainstorming/scripts/server.cjs',
    reason: '上游 superpowers 技能包自带脚本（技能资产，随技能同步整体更新），非本仓契约；其值还是函数调用 readSuperpowersVersion() 而非字面量' },
]

export function readVersions({ root }) { return readJson({ root, rel: VERSIONS_FILE, fallback: null }) }
export function writeVersions({ root, data }) { writeJson({ root, rel: VERSIONS_FILE, data }) }
```

Create `kit/schema/versions.schema.json`：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DevKit versions ledger",
  "type": "object",
  "required": ["version", "lines", "contracts", "skills", "skillsLock", "commonTools"],
  "properties": {
    "version": { "const": 1 },
    "generatedBy": { "type": "string" },
    "exclude": { "type": "array", "items": { "type": "object", "required": ["file", "id", "reason"] } },
    "history": {
      "type": "object",
      "required": ["baselineCount", "records"],
      "properties": {
        "baselineCount": { "type": "integer", "minimum": 0 },
        "commonToolsBaseline": { "type": "integer", "minimum": 0 },
        "records": {
          "type": "array",
          "items": { "type": "object", "required": ["key", "from", "to", "at"], "properties": {
            "key": { "type": "string" }, "from": {}, "to": {}, "at": { "type": "string" }, "reason": { "type": "string" } } }
        }
      }
    },
    "lines": { "type": "array", "items": { "$ref": "#/$defs/entry" } },
    "contracts": { "type": "array", "items": { "$ref": "#/$defs/entry" } },
    "skills": { "type": "array", "items": { "type": "object", "required": ["id", "file"] } },
    "skillsLock": { "type": "object", "required": ["source", "field", "ids"],
      "properties": { "source": { "const": "skills-lock.json" }, "field": { "const": "computedHash" },
        "ids": { "type": "array", "items": { "type": "string" } } } },
    "commonTools": {
      "type": "object",
      "required": ["baseline", "entries"],
      "properties": {
        "baseline": { "type": "array", "items": { "type": "string" } },
        "addedSinceBaseline": { "type": "array", "items": { "type": "string" } },
        "entries": { "type": "array", "items": { "type": "object", "required": ["file", "versionSource"] } }
      }
    },
    "channels": { "type": "object" }
  },
  "$defs": {
    "entry": {
      "type": "object",
      "required": ["id", "value", "file", "locator"],
      "properties": {
        "id": { "type": "string" }, "value": {}, "valueType": { "type": "string" },
        "file": { "type": "string" }, "line": { "type": "integer" },
        "locator": { "type": "object", "required": ["kind"] },
        "kind": { "type": "string" }, "note": { "type": "string" },
        "migrationNote": { "type": "string" },
        "consumers": { "type": "array", "items": { "type": "string" } },
        "manual": { "type": "boolean" }
      }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kit/lib/ledger.test.mjs`
Expected: PASS（7 个 test，0 fail）

- [ ] **Step 5: 生成真实台账并人工补注**

Run:
```bash
node kit/cli.mjs sync 2>/dev/null || node -e "import('./kit/lib/ledger.mjs').then(m=>{const r=m.syncVersions({root:process.cwd()});console.log('lines',r.data.lines.length,'contracts',r.data.contracts.length,'skills',r.data.skills.length,'lock',r.data.skillsLock.length,'commonPy',r.data.commonTools.entries.length);console.log('added',r.added.length,'removed',r.removed.length)})"
```
Expected: `lines 4 / contracts 14 / skills 22 / lock 20 / commonPy 98`。

> **口径已实测（写入计划前用 `scratch/kit-verify-partition.mjs` 验过）**：全仓 `*_VERSION` 常量声明共 **20 处** → 减去 `ANTHROPIC_VERSION`×2（外部协议）+ `SUPERPOWERS_VERSION`×1（上游技能资产）+ 版本线已纳管 3 处（`APP_VERSION`/`KERNEL_VERSION`/`SCHEMA_VERSION` @ `version.mjs`）= **contracts 14**。
>
> **若实施后 contracts ≠ 14**：不要臆造数字，把实际值与差异（多出/少了哪个 `id@file`）记入 spec §5.1 并按实际值修正 spec 里的数字。
>
> **同步修正 spec 的总数口径**：spec §5.1 的 `contracts` 行写的是"实测 `git grep` 得 **17 处**"——该数字来自更窄的 grep 模式，**实测应为 20 处（纳管 14）**。Step 5 之后一并改掉（这是 spec 里唯一一处需要修正的实测数字；"纳管 14"本身是对的）。

然后**人工**为以下条目补 `migrationNote`（`kind:"data-schema"` 的 5 条）与 `consumers`（`src/lib/knowledgeQuery.ts` → `INDEX_VERSION`）：

```
INDEX_VERSION@shared/knowledge-core.mjs        → migrationNote: 索引版本变更必须提供重建链
LEDGER_VERSION@kernel/knowledge-import.mjs     → migrationNote: 导入台账版本，变更需可重放
TRANSCRIPT_SCHEMA_VERSION@kernel/session.mjs   → migrationNote: 会话转录格式，变更需兼容旧转录
DSL_VERSION@kernel/workflow-dsl.mjs            → migrationNote: 工作流 DSL，变更需迁移步骤
TEAM_LAYOUT_VERSION@shared/team-source.mjs     → migrationNote: 团队库布局，变更需迁移步骤
```

- [ ] **Step 6: 验证台账可解析-回读（V1 的人工预演）**

Run:
```bash
node -e "import('./kit/lib/ledger.mjs').then(async(m)=>{const v=m.readVersions({root:process.cwd()});let bad=[];for(const e of [...v.lines,...v.contracts]){const p=m.parseByLocator({root:process.cwd(),file:e.file,locator:e.locator});if(!p||String(p.value)!==String(e.value))bad.push(e.id+'@'+e.file+' 台账='+e.value+' 实测='+(p?p.value:'解析失败'))}console.log(bad.length?('不一致:\n'+bad.join('\n')):'✅ 全部可解析-回读一致')})"
```
Expected: `✅ 全部可解析-回读一致`

- [ ] **Step 7: Commit**

```bash
git add kit/lib/ledger.mjs kit/lib/ledger.test.mjs kit/manifest/versions.json kit/schema/versions.schema.json
git commit -m "feat(kit): 版本台账结构与 sync（4 线 + 14 契约 + 技能 3 套载体 + 98 个 _common 工具）

- ledger.mjs：parseByLocator（const/json 两种定位，容忍注释与引号）、discoverVersionConsts
- syncVersions 合并语义：发现结果是骨架，人工字段（note/consumers/migrationNote）被保留
- 外部协议版本（ANTHROPIC_VERSION ×2）进 exclude，不污染台账
- commonTools 全量登记 98 条（存量 version=null + versionSource=unmarked，脚本一字符不改）
- 台账写入走 shared/atomic-write.mjs（半截写坏会让门禁全线误报）"
```

---

## Task 4: 版本校验规则 V1–V8′

**Files:**
- Create: `kit/lib/version-rules.mjs`
- Create: `kit/lib/version-rules.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `trackedFiles` / `readTracked`；Task 2 的 `finding` / `checkResult` / `RED` / `YELLOW`；Task 3 的 `parseByLocator` / `keyOfVersion` / `readVersions` / `listCommonPy` / `sha256File` / `COMMON_DIR` / `readSkillFrontmatterVersion` / `readJson` / `SKILLS_JSON` / `SKILLS_DIR`
- Produces:
  - `runVersionRules({ root, versions, files? }): { checks: Check[], findings: Finding[] }`
  - 规则 id 与语义：`V1` 可解析-回读、`V1b` 台账键唯一、`V2` 宿主文件存在、`V3` 历史链连续、`V4` 内核线映射、`V5` data-schema 迁移说明、`V6` 技能三方一致、`V7` lock 哈希、`V8` 台账 ⊆ 实有、`V8b` 实有 ⊆ 台账、`V8'` 新文件须标版本

- [ ] **Step 1: 写失败测试（每条规则的正例 + 反例）**

Create `kit/lib/version-rules.test.mjs`：

```js
// kit/lib/version-rules.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runVersionRules } from './version-rules.mjs'

/** 造一个"最小但结构完整"的仓：能同时喂给 V1–V8′ */
function fixture(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  const w = (rel, content) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content) }
  const skill = '---\nname: demo\nversion: "1.0.0"\n---\n\n正文\n'
  w('version.mjs', "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n")
  w('kernel/package.json', '{ "version": "0.2.0" }')
  w('package.json', '{ "version": "2.8.0" }')
  w('k/c.mjs', 'export const INDEX_VERSION = 4\n')
  w('public/skills.json', JSON.stringify([{ id: 'demo', version: '1.0.0' }]))
  w('public/sample-skills/demo/SKILL.md', skill)
  const lockHash = createHash('sha256').update(Buffer.from(skill)).digest('hex')
  w('skills-lock.json', JSON.stringify({ version: 1, skills: { demo: { source: 'x/y', computedHash: lockHash } } }))
  w('public/sample-skills/_common/_common_manifest.json', JSON.stringify({ tools: { 'old.py': { current_version: '1.0.0' } } }))
  w('public/sample-skills/_common/old.py', 'print(1)\n')
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'k/c.mjs', 'public/skills.json',
    'public/sample-skills/demo/SKILL.md', 'skills-lock.json',
    'public/sample-skills/_common/_common_manifest.json', 'public/sample-skills/_common/old.py']
  const versions = {
    version: 1,
    exclude: [],
    history: { baselineCount: 0, commonToolsBaseline: 1, records: [] },
    lines: [
      { id: 'APP_VERSION', value: 'dev 3.0.0', file: 'version.mjs', locator: { kind: 'const', name: 'APP_VERSION' } },
      { id: 'KERNEL_VERSION', value: 'dev 0.2', file: 'version.mjs', locator: { kind: 'const', name: 'KERNEL_VERSION' },
        mirrorValue: '0.2.0' },
      { id: 'GUI_VERSION', value: '2.8.0', file: 'package.json', locator: { kind: 'json', path: 'version' } },
      { id: 'KB_SCHEMA_VERSION', value: 1, file: 'version.mjs', locator: { kind: 'const', name: 'SCHEMA_VERSION' } },
    ],
    contracts: [
      { id: 'INDEX_VERSION', value: 4, file: 'k/c.mjs', locator: { kind: 'const', name: 'INDEX_VERSION' } },
    ],
    skills: [{ id: 'demo', value: '1.0.0', frontmatterVersion: '1.0.0', file: 'public/sample-skills/demo/SKILL.md' }],
    skillsLock: { source: 'skills-lock.json', field: 'computedHash', ids: ['demo'] },
    commonTools: { baseline: ['old.py'], addedSinceBaseline: [], entries: [{ file: 'public/sample-skills/_common/old.py', version: '1.0.0', versionSource: 'manifest' }] },
    channels: {},
  }
  return { root, files, versions: { ...versions, ...over } }
}

const rulesOf = (findings) => findings.map((f) => f.rule)
const redOf = (findings, rule) => findings.filter((f) => f.rule === rule && f.severity === 'red')

test('基线（全绿）：完整台账 + 一致宿主 → 无红灯', () => {
  const { root, files, versions } = fixture()
  const { findings, checks } = runVersionRules({ root, versions, files })
  assert.deepEqual(redOf(findings, 'V1'), [])
  assert.deepEqual(redOf(findings, 'V6'), [])
  assert.deepEqual(redOf(findings, 'V7'), [])
  assert.deepEqual(redOf(findings, 'V8'), [])
  assert.ok(checks.length >= 8)
})

// V1 反例：手改宿主文件的值
test('V1 反例：宿主文件值被改 → 红，并给出 file 与期望/实际', () => {
  const { root, files, versions } = fixture()
  writeFileSync(join(root, 'k/c.mjs'), 'export const INDEX_VERSION = 5\n')
  const { findings } = runVersionRules({ root, versions, files })
  const hits = redOf(findings, 'V1')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].file, 'k/c.mjs')
  assert.equal(hits[0].expected, '4')
  assert.equal(hits[0].actual, '5')
})

// V1 反例：宿主文件被删（解析不到）
test('V1 反例：宿主文件不存在 → 红（不是静默跳过）', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, contracts: [...versions.contracts, { id: 'GONE_VERSION', value: 1, file: 'nope.mjs', locator: { kind: 'const', name: 'GONE_VERSION' } }] }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.ok(redOf(findings, 'V1').some((f) => f.subject.includes('GONE_VERSION')))
})

// V1b 反例：台账键重复
test('V1b 反例：同一 id@file 出现两次 → 红', () => {
  const { root, files, versions } = fixture()
  const dup = { ...versions.contracts[0] }
  const v = { ...versions, contracts: [...versions.contracts, dup] }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V1b').length, 1)
})

// V4 反例：dev X.Y ↔ X.Y.0 映射被破坏
test('V4 反例：内核线映射不一致 → 红', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, lines: versions.lines.map((l) => l.id === 'KERNEL_VERSION' ? { ...l, mirrorValue: '0.3.0' } : l) }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V4').length, 1)
})

// V5 反例：data-schema 缺迁移说明
test('V5 反例：kind=data-schema 却没有 migrationNote → 红', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, contracts: [{ ...versions.contracts[0], kind: 'data-schema', migrationNote: '' }] }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V5').length, 1)
})

// V6 反例：三处技能版本不一致
test('V6 反例：SKILL.md 与 skills.json 不一致 → 红', () => {
  const { root, files, versions } = fixture()
  writeFileSync(join(root, 'public/sample-skills/demo/SKILL.md'), '---\nname: demo\nversion: "1.1.0"\n---\n\n正文\n')
  const { findings } = runVersionRules({ root, versions, files })
  assert.equal(redOf(findings, 'V6').length, 1)
})

// V7 反例（本次真实欠账 A7）：lock 哈希不符
test('V7 反例：SKILL.md 被改 → 哈希不符红；并提示跑 kit:sync', () => {
  const { root, files, versions } = fixture()
  writeFileSync(join(root, 'public/sample-skills/demo/SKILL.md'), '---\nname: demo\nversion: "1.0.0"\n---\n\n被改了\n')
  const { findings } = runVersionRules({ root, versions, files })
  const hits = redOf(findings, 'V7')
  assert.equal(hits.length, 1)
  assert.match(hits[0].hint, /kit:sync/)
})

// ★ 防自证：即便台账被"sync 式"重写成与文件一致，V7 仍必须红（判据是 lock 文件，不是台账）
test('V7 防自证：台账里塞入"正确"哈希也不影响判定（判据恒为 skills-lock.json）', () => {
  const { root, files, versions } = fixture()
  writeFileSync(join(root, 'public/sample-skills/demo/SKILL.md'), '---\nname: demo\nversion: "1.0.0"\n---\n\n被改了\n')
  const tampered = { ...versions, skillsLock: { source: 'skills-lock.json', field: 'computedHash', ids: ['demo'],
    sha256: createHash('sha256').update(Buffer.from('---\nname: demo\nversion: "1.0.0"\n---\n\n被改了\n')).digest('hex') } }
  const { findings } = runVersionRules({ root, versions: tampered, files })
  assert.equal(redOf(findings, 'V7').length, 1, '台账里的哈希不参与判定 —— 否则跑一次 sync 就能把门禁刷绿')
})

// V8 反例：台账记了不存在的文件
test('V8 反例：台账 entries 含不存在的 .py → 红', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, commonTools: { ...versions.commonTools, entries: [...versions.commonTools.entries, { file: 'public/sample-skills/_common/ghost.py', version: null, versionSource: 'unmarked' }] } }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V8').length, 1)
})

// V8b 反例：新增 .py 没登记
test('V8b 反例：实有 .py 未在台账登记 → 红', () => {
  const { root, files, versions } = fixture()
  writeFileSync(join(root, 'public/sample-skills/_common/new.py'), 'print(2)\n')
  const { findings } = runVersionRules({ root, versions, files: [...files, 'public/sample-skills/_common/new.py'] })
  assert.equal(redOf(findings, 'V8b').length, 1)
})

// V8' 正例/反例（spec §5.4 的关键护栏）
test("V8' ：存量 .py 免标版本；**新增** .py 必须标版本或显式登记 null", () => {
  const { root, files, versions } = fixture()
  const added = 'public/sample-skills/_common/added.py'
  writeFileSync(join(root, added), 'print(3)\n')
  const f2 = [...files, added]
  const withNull = { ...versions, commonTools: { baseline: ['old.py'], addedSinceBaseline: ['added.py'],
    entries: [...versions.commonTools.entries, { file: added, version: null, versionSource: 'unmarked' }] } }
  assert.equal(redOf(runVersionRules({ root, versions: withNull, files: f2 }).findings, "V8'").length, 1,
    '新增文件登记 null 仍须红（V8′ 的作用就是逼新文件自证版本）')
  const withVer = { ...versions, commonTools: { baseline: ['old.py'], addedSinceBaseline: ['added.py'],
    entries: [...versions.commonTools.entries, { file: added, version: '1.0.0', versionSource: 'inline' }] } }
  assert.equal(redOf(runVersionRules({ root, versions: withVer, files: f2 }).findings, "V8'").length, 0)
})

// V3：历史链
test('V3 反例：历史链断裂（from ≠ 前一条 to）→ 红', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, history: { baselineCount: 0, commonToolsBaseline: 1, records: [
    { key: 'INDEX_VERSION@k/c.mjs', from: 3, to: 4, at: '2026-09-18' },
    { key: 'INDEX_VERSION@k/c.mjs', from: 9, to: 5, at: '2026-09-19' },
  ] } }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V3').length, 1)
})

test('V3 正例：链条连续且末条 to == 当前值 → 无红', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, history: { baselineCount: 0, commonToolsBaseline: 1, records: [
    { key: 'INDEX_VERSION@k/c.mjs', from: 3, to: 4, at: '2026-09-18' },
  ] } }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.deepEqual(redOf(findings, 'V3'), [])
})

test('V2：line 的宿主文件必须已入库', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, lines: [...versions.lines, { id: 'X_VERSION', value: 1, file: 'untracked.mjs', locator: { kind: 'const', name: 'X_VERSION' } }] }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V2').length, 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kit/lib/version-rules.test.mjs`
Expected: FAIL —— `Cannot find module '.../version-rules.mjs'`

- [ ] **Step 3: 写最小实现**

Create `kit/lib/version-rules.mjs`：

```js
// kit/lib/version-rules.mjs —— 版本台账校验规则 V1–V8′
// 设计口径：check 一律**回读宿主文件**重新解析，绝不信任台账里存的值 ——
// 否则台账写错时"自己验证自己"，门禁失去意义。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { RED, YELLOW, finding, checkResult } from './report.mjs'
import { trackedFiles, readTracked } from './scan.mjs'
import {
  parseByLocator, keyOfVersion, listCommonPy, sha256File, readSkillFrontmatterVersion,
  readJson, SKILLS_JSON, SKILLS_DIR, COMMON_DIR,
} from './ledger.mjs'

/** `dev X.Y` ↔ `X.Y.0`；`dev X.Y.Z` ↔ `X.Y.Z`（与 scripts/bump-version.mjs 的映射规则同源） */
export function kernelMirrorOf(value) {
  const semver = String(value).replace(/^dev\s+/, '').trim()
  return semver.split('.').length === 2 ? `${semver}.0` : semver
}

export function runVersionRules({ root, versions, files } = {}) {
  const tracked = files || trackedFiles({ root })
  const trackedSet = new Set(tracked)
  const checks = []
  const findings = []

  if (!versions) {
    findings.push(finding({ rule: 'V0', severity: RED, subject: 'versions.json', hint: '跑 npm run kit:sync 生成台账' }))
    return { checks, findings }
  }

  const entries = [...(versions.lines || []), ...(versions.contracts || []), ...(versions.manual || [])]

  // ── V1：可解析-回读 ────────────────────────────────────────────────────
  let v1bad = 0
  for (const e of entries) {
    const p = parseByLocator({ root, file: e.file, locator: e.locator })
    if (!p) {
      v1bad++
      findings.push(finding({ rule: 'V1', severity: RED, subject: keyOfVersion(e), file: e.file,
        expected: String(e.value), actual: '(解析失败)', hint: '宿主文件缺失或常量名已改；确认后跑 kit:sync' }))
      continue
    }
    if (String(p.value) !== String(e.value)) {
      v1bad++
      findings.push(finding({ rule: 'V1', severity: RED, subject: keyOfVersion(e), file: e.file, line: e.line,
        expected: String(e.value), actual: String(p.value), hint: '台账与宿主文件不一致：跑 kit:sync 更新台账，或修宿主文件' }))
    }
  }
  checks.push(checkResult({ rule: 'V1', title: '台账值可从宿主文件解析-回读', evaluated: entries.length, passed: v1bad === 0 }))

  // ── V1b：台账键唯一 ───────────────────────────────────────────────────
  const seen = new Map()
  let v1b = 0
  for (const e of entries) {
    const k = keyOfVersion(e)
    seen.set(k, (seen.get(k) || 0) + 1)
  }
  for (const [k, n] of seen) if (n > 1) { v1b++; findings.push(finding({ rule: 'V1b', severity: RED, subject: k, actual: `${n} 条`, hint: '台账键重复；同名的 SCHEMA_VERSION 必须靠 file 区分' })) }
  checks.push(checkResult({ rule: 'V1b', title: '台账键（id@file）唯一', evaluated: entries.length, passed: v1b === 0 }))

  // ── V2：宿主文件存在（判据是"已入库"） ─────────────────────────────────
  let v2 = 0
  for (const e of versions.lines || []) {
    if (!e.file || !trackedSet.has(e.file)) {
      v2++
      findings.push(finding({ rule: 'V2', severity: RED, subject: keyOfVersion(e), file: e.file, hint: '每条版本线的宿主文件必须已入库' }))
    }
  }
  checks.push(checkResult({ rule: 'V2', title: '每条版本线有已入库的宿主文件', evaluated: (versions.lines || []).length, passed: v2 === 0 }))

  // ── V3：历史链连续 + 末条 to == 当前值 ─────────────────────────────────
  const records = (versions.history && versions.history.records) || []
  const byKey = new Map()
  for (const r of records) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r) }
  let v3 = 0
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => String(a.at).localeCompare(String(b.at)))
    for (let i = 1; i < sorted.length; i++) {
      if (String(sorted[i].from) !== String(sorted[i - 1].to)) {
        v3++
        findings.push(finding({ rule: 'V3', severity: RED, subject: key, expected: String(sorted[i - 1].to), actual: String(sorted[i].from),
          hint: `历史链断裂（${sorted[i - 1].at} → ${sorted[i].at}）：台账 history.records 必须首尾相接` }))
      }
    }
    const cur = entries.find((e) => keyOfVersion(e) === key)
    if (cur && String(sorted[sorted.length - 1].to) !== String(cur.value)) {
      v3++
      findings.push(finding({ rule: 'V3', severity: RED, subject: key, expected: String(sorted[sorted.length - 1].to), actual: String(cur.value),
        hint: '当前值与历史末条不一致；版本变更必须在 history.records 留记录（防静默降级）' }))
    }
  }
  checks.push(checkResult({ rule: 'V3', title: '版本历史链连续且与当前值一致', evaluated: records.length, passed: v3 === 0 }))

  // ── V4：内核线跨载体映射 ───────────────────────────────────────────────
  let v4 = 0
  const kernelLine = (versions.lines || []).find((l) => l.id === 'KERNEL_VERSION')
  if (kernelLine && kernelLine.mirrorValue != null) {
    const expect = kernelMirrorOf(kernelLine.value)
    if (String(kernelLine.mirrorValue) !== expect) {
      v4++
      findings.push(finding({ rule: 'V4', severity: RED, subject: 'KERNEL_VERSION↔kernel/package.json', file: 'kernel/package.json',
        expected: expect, actual: String(kernelLine.mirrorValue), hint: "映射规则：'dev X.Y' → 'X.Y.0'（scripts/bump-version.mjs 同源）" }))
    }
  }
  checks.push(checkResult({ rule: 'V4', title: '内核线跨载体映射一致', evaluated: kernelLine ? 1 : 0, passed: v4 === 0 }))

  // ── V5：data-schema 必须有迁移说明 ────────────────────────────────────
  const schemaEntries = entries.filter((e) => e.kind === 'data-schema')
  const v5 = schemaEntries.filter((e) => !e.migrationNote || !String(e.migrationNote).trim())
  for (const e of v5) {
    findings.push(finding({ rule: 'V5', severity: RED, subject: keyOfVersion(e), file: e.file,
      hint: 'kind=data-schema 的版本变更必须写明迁移方式（migrationNote）；无迁移也须显式写"向后兼容，无需迁移"' }))
  }
  checks.push(checkResult({ rule: 'V5', title: 'data-schema 条目有迁移说明', evaluated: schemaEntries.length, passed: v5.length === 0 }))

  // ── V6：技能三方一致（skills.json ↔ frontmatter ↔ 台账） ───────────────
  const skillsJson = readJson({ root, rel: SKILLS_JSON, fallback: [] }) || []
  const jsonVer = new Map(skillsJson.map((s) => [s.id, s.version]))
  let v6 = 0
  for (const s of versions.skills || []) {
    const file = `${SKILLS_DIR}/${s.id}/SKILL.md`
    const fm = readSkillFrontmatterVersion({ root, file })
    const j = jsonVer.get(s.id)
    if (fm === null) { v6++; findings.push(finding({ rule: 'V6', severity: RED, subject: s.id, file, hint: 'SKILL.md 缺 version frontmatter' })); continue }
    if (String(fm) !== String(j)) { v6++; findings.push(finding({ rule: 'V6', severity: RED, subject: s.id, file, expected: String(j), actual: String(fm), hint: 'public/skills.json 与 SKILL.md 版本不一致' })) }
  }
  checks.push(checkResult({ rule: 'V6', title: '技能版本三方一致', evaluated: (versions.skills || []).length, passed: v6 === 0 }))

  // ── V7：skills-lock 哈希（D5：lock 记录"本地安装后"哈希） ────────────────
  // ★ 判据是**已提交的 lock 文件**（skills-lock.json），不是台账里存的值。
  //   原因：sync 会重写台账；若拿台账里的哈希比对文件，跑一次 sync 就必然全绿 → 门禁自证。
  const lock = readJson({ root, rel: 'skills-lock.json', fallback: { skills: {} } }) || { skills: {} }
  const lockField = (versions.skillsLock && versions.skillsLock.field) || 'computedHash'
  let v7 = 0
  const lockIds = Object.keys(lock.skills || {})
  for (const id of lockIds) {
    const file = `${SKILLS_DIR}/${id}/SKILL.md`
    const actual = sha256File({ root, file })
    const expected = lock.skills[id]?.[lockField]
    if (actual === null) { v7++; findings.push(finding({ rule: 'V7', severity: RED, subject: id, file, hint: 'lock 里登记了该技能，但 SKILL.md 不存在' })); continue }
    if (actual !== expected) {
      v7++
      findings.push(finding({ rule: 'V7', severity: RED, subject: id, file: 'skills-lock.json',
        expected: String(expected || '(空)').slice(0, 12), actual: actual.slice(0, 12),
        hint: `SKILL.md 与 ${lockField} 不符：改动是有意的则跑 npm run kit:sync 重算 lock，否则回退 SKILL.md` }))
    }
  }
  checks.push(checkResult({ rule: 'V7', title: 'skills-lock 哈希与本地文件一致', evaluated: lockIds.length, passed: v7 === 0 }))

  // ── V8 / V8b / V8'：_common 工具覆盖 ─────────────────────────────────
  const ct = versions.commonTools || { baseline: [], entries: [] }
  const actualPy = listCommonPy(tracked)
  const actualSet = new Set(actualPy)
  const entrySet = new Set((ct.entries || []).map((e) => e.file.replace(`${COMMON_DIR}/`, '')))
  let v8 = 0
  for (const e of ct.entries || []) {
    const n = e.file.replace(`${COMMON_DIR}/`, '')
    if (!actualSet.has(n)) { v8++; findings.push(finding({ rule: 'V8', severity: RED, subject: n, file: e.file, hint: '台账登记了不存在的 .py（文件已删除/改名）' })) }
  }
  checks.push(checkResult({ rule: 'V8', title: '台账登记的工具文件都存在', evaluated: (ct.entries || []).length, passed: v8 === 0 }))

  let v8b = 0
  for (const n of actualPy) {
    if (!entrySet.has(n)) { v8b++; findings.push(finding({ rule: 'V8b', severity: RED, subject: n, actual: '未登记', hint: '实有 .py 必须全部登记（跑 kit:sync 会自动补，version 可空）' })) }
  }
  checks.push(checkResult({ rule: 'V8b', title: '实有 .py 全部在台账中', evaluated: actualPy.length, passed: v8b === 0 }))

  // V8'：**新增**文件必须自证版本（存量 98 个豁免 —— 这是 D6 与 spec §5.4 的划界）
  const baselineSet = new Set(ct.baseline || [])
  const addedFiles = actualPy.filter((n) => !baselineSet.has(n))
  let v8p = 0
  for (const n of addedFiles) {
    const entry = (ct.entries || []).find((e) => e.file.endsWith(`/${n}`))
    if (!entry || entry.version == null) {
      v8p++
      findings.push(finding({ rule: "V8'", severity: RED, subject: n, file: `${COMMON_DIR}/${n}`,
        hint: '新增的 _common 脚本必须声明 __version__ 或显式登记版本（防止欠账继续扩大）' }))
    }
  }
  checks.push(checkResult({ rule: "V8'", title: '新增 _common 脚本自证版本', evaluated: addedFiles.length, passed: v8p === 0 }))

  return { checks, findings }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kit/lib/version-rules.test.mjs`
Expected: PASS（15 个 test，0 fail）

- [ ] **Step 5: 对真实仓库跑一次，确认 V7 报出本次欠账（A7）**

Run:
```bash
node -e "import('./kit/lib/version-rules.mjs').then(async(R)=>{const L=await import('./kit/lib/ledger.mjs');const v=L.readVersions({root:process.cwd()});const {findings,checks}=R.runVersionRules({root:process.cwd(),versions:v});const by=(s)=>findings.filter(f=>f.severity===s).length;console.log('red',by('red'),'yellow',by('yellow'));for(const f of findings.filter(f=>f.severity==='red').slice(0,5))console.log(' ',f.rule,f.subject,f.expected,'→',f.actual)})"
```
Expected: `red 20`、全部为 `V7`（20 条 lock 哈希不符 —— 本次欠账 A7 被真实捕获）。

- [ ] **Step 6: Commit**

```bash
git add kit/lib/version-rules.mjs kit/lib/version-rules.test.mjs
git commit -m "feat(kit): 版本校验规则 V1–V8′（每条含正反例测试）

- V1 可解析-回读 / V1b 键唯一 / V2 宿主入库 / V3 历史链 / V4 内核线映射
- V5 data-schema 迁移说明 / V6 技能三方一致 / V7 lock 哈希
- V8 台账⊆实有 / V8b 实有⊆台账 / V8' 新增 .py 须自证版本（存量豁免）
- check 一律回读宿主文件重新解析，不信任台账存值（否则自证）
- 真实仓库实测：红 20，全部 V7（本次欠账 A7 被捕获）"
```

---

## Task 5: 依赖台账 —— 五类引用证据与 `sync`

**Files:**
- Create: `kit/manifest/deps.json`
- Create: `kit/schema/deps.schema.json`
- Modify: `kit/lib/ledger.mjs`（追加 `syncDeps` 等；与 Task 3 同文件，**只追加不改既有导出**）
- Modify: `kit/lib/ledger.test.mjs`（追加 `syncDeps` 测试）

**Interfaces:**
- Consumes: Task 1 的 `trackedFiles` / `codeFiles` / `inDomains` / `DOMAINS` / `CONFIG_FILES` / `readTracked`
- Produces:
  - `EVIDENCE_CLASSES = ['import','dynamic-import','config-file','cli','types']`
  - `collectEvidence({ root, files, dep }): { classes: string[], files: string[] }`
  - `parseDeclaredImports({ root, files }): string[]`（源码里出现的模块说明符）
  - `readRequirements({ root, file }): Array<{name, spec}>`
  - `syncDeps({ root, files?, sizes? }): { data, unused: string[], ghost: string[] }`
  - `readDeps({ root })` / `writeDeps({ root, data })`

`deps.json` 形状：

```jsonc
{
  "version": 1,
  "generatedBy": "node kit/cli.mjs sync",
  "domains": {
    "npm-runtime": { "source": "package.json#dependencies", "packages": [
      { "name": "ws", "evidence": { "classes": ["import"], "files": ["electron/a.cjs", "server/b.mjs"] }, "status": "used" },
      { "name": "classic-level", "evidence": { "classes": [], "files": [] }, "status": "unused" }
    ] },
    "npm-dev": { "source": "package.json#devDependencies", "packages": [] },
    "kernel": { "source": "kernel/package.json", "assertZero": true, "packages": [] },
    "python-embedded": { "source": "kit/manifest/deps.json#python.embedded", "packages": [] },
    "python-skills": { "source": "public/sample-skills/_common/requirements.txt", "packages": [] }
  },
  "python": { "embedded": ["openpyxl", "python-docx"] },
  "gates": {
    "ci": ["verify-highrisk", "verify-s4-security"],
    "manual": [ { "script": "verify-gui-fidelity", "reason": "需要 Electron 真二进制与图形会话" } ]
  },
  "sizes": { "node_modules": 0, "runtime/python": 0, "runtime/skills": 0 }
}
```

- [ ] **Step 1: 写失败测试（追加到 `kit/lib/ledger.test.mjs` 末尾）**

```js
// ── Task 5：依赖台账 ────────────────────────────────────────────────────────
import { collectEvidence, parseDeclaredImports, readRequirements, syncDeps } from './ledger.mjs'

test('collectEvidence：静态 import / require 命中', () => {
  const root = fixture({
    'src/a.ts': "import { x } from 'clsx'\n",
    'server/b.mjs': "const y = require('ws')\n",
  })
  const files = ['src/a.ts', 'server/b.mjs']
  assert.deepEqual(collectEvidence({ root, files, dep: 'clsx' }).classes, ['import'])
  assert.deepEqual(collectEvidence({ root, files, dep: 'ws' }).classes, ['import'])
  assert.deepEqual(collectEvidence({ root, files, dep: 'nope' }).classes, [])
})

// G3 回归夹具之一：动态 import
test('collectEvidence：动态 import() 命中 —— rcedit 就是这一类（scripts/patch-icon.mjs:10）', () => {
  const root = fixture({ 'scripts/p.mjs': "const { rcedit } = await import('rcedit')\n" })
  const ev = collectEvidence({ root, files: ['scripts/p.mjs'], dep: 'rcedit' })
  assert.deepEqual(ev.classes, ['dynamic-import'])
})

// G3 回归夹具之二：根级配置文件
test('collectEvidence：配置文件引用命中 —— @tailwindcss/typography 就是这一类', () => {
  const root = fixture({ 'tailwind.config.ts': "import typography from '@tailwindcss/typography'\n" })
  const ev = collectEvidence({ root, files: ['tailwind.config.ts'], dep: '@tailwindcss/typography' })
  assert.equal(ev.classes.includes('config-file'), true)
})

// G3 回归夹具之三：CLI 调用
test('collectEvidence：CLI 调用命中 —— electron-builder 就是这一类（npx electron-builder）', () => {
  const root = fixture({
    'scripts/build-installer.mjs': "execSync('npx electron-builder --win nsis', { stdio: 'inherit' })\n",
    'package.json': '{ "scripts": { "build:electron": "npm run build && electron-builder" } }',
  })
  const ev = collectEvidence({ root, files: ['scripts/build-installer.mjs', 'package.json'], dep: 'electron-builder' })
  assert.equal(ev.classes.includes('cli'), true)
})

// G3 回归夹具之四：类型包
test('collectEvidence：@types/* 归 types 类（由 tsconfig 自动包含，不参与未用判定）', () => {
  const root = fixture({ 'tsconfig.json': '{ "include": ["src"] }' })
  const ev = collectEvidence({ root, files: ['tsconfig.json'], dep: '@types/node' })
  assert.equal(ev.classes.includes('types'), true)
})

test('collectEvidence：测试文件里的 import 不算生产证据（但会被记录到 files）', () => {
  const root = fixture({ 'src/a.test.ts': "import { d } from 'diff'\n" })
  const ev = collectEvidence({ root, files: ['src/a.test.ts'], dep: 'diff', includeTests: true })
  assert.equal(ev.productionFiles.length, 0)
})

test('parseDeclaredImports：抽出模块说明符，过滤 node: 与相对路径', () => {
  const root = fixture({
    'src/a.ts': "import x from 'react'\nimport y from './local'\nimport z from 'node:fs'\nimport '@radix-ui/react-slot'\n",
  })
  const names = parseDeclaredImports({ root, files: ['src/a.ts'] })
  assert.ok(names.includes('react'))
  assert.ok(names.includes('@radix-ui/react-slot'))
  assert.equal(names.includes('./local'), false)
  assert.equal(names.some((n) => n.startsWith('node:')), false)
})

test('readRequirements：解析 requirements.txt 的名称与版本约束，跳过注释', () => {
  const root = fixture({
    'public/sample-skills/_common/requirements.txt': '# 注释\nopenpyxl>=3.1.0  # 注释\npdfplumber>=0.9.0\n\n# pywin32>=305\n',
  })
  const reqs = readRequirements({ root, file: 'public/sample-skills/_common/requirements.txt' })
  assert.deepEqual(reqs.map((r) => r.name), ['openpyxl', 'pdfplumber'])
  assert.equal(reqs[0].spec, '>=3.1.0')
})

test('syncDeps：判出 unused 与 ghost，且守卫 types/config/cli 不被误判', () => {
  const root = fixture({
    'package.json': JSON.stringify({
      dependencies: { react: '^18', 'classic-level': '^3', '@tailwindcss/typography': '^0.5' },
      devDependencies: { '@types/node': '^20' },
      scripts: {},
    }),
    'src/a.ts': "import { x } from 'react'\n",
    'tailwind.config.ts': "import typography from '@tailwindcss/typography'\n",
    'tsconfig.json': '{ "include": ["src"] }',
    'kernel/package.json': '{ "version": "0.2.0" }',
  })
  const files = ['package.json', 'src/a.ts', 'tailwind.config.ts', 'tsconfig.json', 'kernel/package.json']
  const { data, unused } = syncDeps({ root, files })
  assert.deepEqual(unused, ['classic-level'])
  assert.equal(data.domains['npm-runtime'].packages.find((p) => p.name === 'react').status, 'used')
  assert.equal(data.domains['npm-runtime'].packages.find((p) => p.name === '@tailwindcss/typography').status, 'used',
    '配置文件证据必须救回 @tailwindcss/typography（G3）')
  assert.equal(data.domains['kernel'].assertZero, true)
})

test('syncDeps：ghost（源码 import 了但未声明）能被发现', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: {}, devDependencies: {}, scripts: {} }),
    'src/a.ts': "import { x } from 'left-pad'\n",
    'kernel/package.json': '{}',
  })
  const { ghost } = syncDeps({ root, files: ['package.json', 'src/a.ts', 'kernel/package.json'] })
  assert.deepEqual(ghost, ['left-pad'])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kit/lib/ledger.test.mjs`
Expected: FAIL —— `The requested module './ledger.mjs' does not provide an export named 'collectEvidence'`

- [ ] **Step 3: 追加实现到 `kit/lib/ledger.mjs` 末尾**

```js
// ── Task 5：依赖台账 ────────────────────────────────────────────────────────
//
// ★ 为什么必须有"五类证据"而不是只扫 import：
//   实测只扫 import 会得出 11 个"未用"，其中 **6 个是假阳性**：
//     · rcedit            → scripts/patch-icon.mjs:10 的 `await import('rcedit')`（动态）
//     · electron-builder  → scripts/build-installer.mjs:65 的 `npx electron-builder`（CLI）
//     · @tailwindcss/typography / @vitejs/plugin-react / tailwindcss / postcss / autoprefixer /
//       typescript / vite → 根级配置文件消费（vite.config.ts / tailwind.config.ts / postcss.config.js / tsconfig.json）
//   误判的代价不是"多报几条"，而是**让人删掉正在用的依赖**（B1 会真的执行删除）。
export const EVIDENCE_CLASSES = ['import', 'dynamic-import', 'config-file', 'cli', 'types']

const MODULE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx)$/

/** 从一段源码里抽出模块说明符（忽略 node: 与相对/绝对路径） */
function specifiersIn(text) {
  const out = []
  const push = (s) => {
    if (!s) return
    if (s.startsWith('.') || s.startsWith('/') || s.startsWith('node:') || s.startsWith('#')) return
    out.push(s)
  }
  for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) push(m[1])
  for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1])
  for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1])
  for (const m of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) push(m[1])
  return out
}

/** 源码里出现的全部模块说明符（用于反向幽灵依赖判定） */
export function parseDeclaredImports({ root, files }) {
  const names = new Set()
  for (const file of files.filter((f) => MODULE_EXT.test(f))) {
    const text = readTracked({ root, file })
    if (text === null) continue
    for (const s of specifiersIn(text)) names.add(s)
  }
  return [...names].sort()
}

/** 包名归一：`@scope/pkg/sub/path` → `@scope/pkg`；`pkg/sub` → `pkg` */
export function packageRootOf(spec) {
  const parts = String(spec).split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export function collectEvidence({ root, files, dep, includeTests = true }) {
  const classes = new Set()
  const hitFiles = []
  const productionFiles = []
  const candidates = files.filter((f) => MODULE_EXT.test(f) || CONFIG_FILES.includes(f))
  for (const file of candidates) {
    const text = readTracked({ root, file })
    if (text === null) continue
    const isTest = isTestFile(file)
    let hit = false
    for (const spec of specifiersIn(text)) {
      if (packageRootOf(spec) !== dep) continue
      hit = true
      if (CONFIG_FILES.includes(file)) classes.add('config-file')
      else if (/import\(\s*['"]/.test(text.match(new RegExp(`import\\(\\s*['"]${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)) ? text : '')) classes.add('dynamic-import')
      if (new RegExp(`from\\s+['"]${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) classes.add('import')
      if (new RegExp(`require\\(\\s*['"]${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) classes.add('import')
      if (new RegExp(`import\\(\\s*['"]${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) classes.add('dynamic-import')
    }
    // CLI：包名以命令形式出现（npx / execSync('… <name> …') / package.json scripts）
    const nameRe = new RegExp(`(?:^|[\\s"'/(])${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[\\s"')/]|$)`)
    if ((file === 'package.json' || /\.(mjs|cjs|js)$/.test(file) || CONFIG_FILES.includes(file)) && nameRe.test(text) && /npx|execSync|execFileSync|scripts/.test(text)) {
      hit = true
      classes.add('cli')
    }
    if (hit) { hitFiles.push(file); if (!isTest) productionFiles.push(file) }
  }
  // types 类：@types/* 由 tsconfig 自动包含（tsconfig.json 未声明 "types" 字段时全部生效）
  if (dep.startsWith('@types/')) {
    const ts = readTracked({ root, file: 'tsconfig.json' })
    if (ts && !/"types"\s*:/.test(ts)) { classes.add('types'); hitFiles.push('tsconfig.json') }
  }
  return { classes: EVIDENCE_CLASSES.filter((c) => classes.has(c)), files: [...new Set(hitFiles)], productionFiles: [...new Set(productionFiles)] }
}

/** 解析 requirements.txt（跳过注释与行内注释） */
export function readRequirements({ root, file }) {
  const text = readTracked({ root, file })
  if (text === null) return []
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^([A-Za-z0-9_.\-]+)\s*(.*)$/)
    if (!m) continue
    out.push({ name: m[1].replace(/_/g, '-').toLowerCase(), spec: m[2].trim() })
  }
  return out
}

export const REQUIREMENTS_FILE = 'public/sample-skills/_common/requirements.txt'

/** 暂存目录体积（缺失记 0；仅趋势，不设阈值 —— 见 spec §6.3 P6） */
export function dirSizeOf({ root, rel }) {
  let total = 0
  const walk = (d) => {
    let ents
    try { ents = readdirSync(join(root, d), { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const r = `${d}/${e.name}`
      if (e.isDirectory()) walk(r)
      else { try { total += statSync(join(root, r)).size } catch { /* 并发删除等，忽略 */ } }
    }
  }
  walk(rel)
  return total
}

export function syncDeps({ root, files, sizes } = {}) {
  const tracked = files || trackedFiles({ root })
  const codeTracked = codeFiles(tracked, { includeTests: true })
  const pkg = readJson({ root, rel: 'package.json', fallback: { dependencies: {}, devDependencies: {}, scripts: {} } })
  const kernelPkg = readJson({ root, rel: 'kernel/package.json', fallback: {} })

  const buildPackages = (depsObj) => Object.keys(depsObj || {}).sort().map((name) => {
    const ev = collectEvidence({ root, files: codeTracked, dep: name })
    return { name, evidence: { classes: ev.classes, files: ev.files.slice(0, 20) }, status: ev.classes.length ? 'used' : 'unused' }
  })

  const runtime = buildPackages(pkg.dependencies)
  const dev = buildPackages(pkg.devDependencies)
  const kernelDeps = Object.keys(kernelPkg.dependencies || {})

  // Python：内嵌集（真源在本台账的 python.embedded；构建脚本改读它 —— 见 Task 11 B2）
  const prev = readDeps({ root }) || {}
  const embedded = (prev.python && prev.python.embedded) || DEFAULT_PYTHON_EMBEDDED
  const reqs = readRequirements({ root, file: REQUIREMENTS_FILE })

  const declaredAll = new Set([...runtime, ...dev].map((p) => p.name))
  const imported = parseDeclaredImports({ root, files: codeTracked })
    .map(packageRootOf)
    .filter((n) => !n.startsWith('node:') && n !== '')
  const ghost = [...new Set(imported)].filter((n) => !declaredAll.has(n) && !isBuiltinModule(n) && !isLocalAlias(n)).sort()

  const data = {
    version: 1,
    generatedBy: 'node kit/cli.mjs sync',
    _note: 'packages[].evidence 由 sync 生成；gates / sizes 可人工维护。status=unused 的判定见 spec §6.2（五类证据）。',
    domains: {
      'npm-runtime': { source: 'package.json#dependencies', packages: runtime },
      'npm-dev': { source: 'package.json#devDependencies', packages: dev },
      kernel: { source: 'kernel/package.json#dependencies', assertZero: true, packages: kernelDeps.map((name) => ({ name, status: 'declared' })) },
      'python-embedded': { source: 'kit/manifest/deps.json#python.embedded', packages: embedded.map((name) => ({ name })) },
      'python-skills': { source: REQUIREMENTS_FILE, packages: reqs.map((r) => ({ name: r.name, spec: r.spec })) },
    },
    python: { embedded },
    gates: prev.gates || { ci: [], manual: [] },
    sizes: sizes || prev.sizes || {
      'node_modules': dirSizeOf({ root, rel: 'node_modules' }),
      'runtime/python': dirSizeOf({ root, rel: 'runtime/python' }),
      'runtime/skills': dirSizeOf({ root, rel: 'runtime/skills' }),
    },
  }
  writeJson({ root, rel: DEPS_FILE, data })
  return { data, unused: [...runtime, ...dev].filter((p) => p.status === 'unused').map((p) => p.name), ghost }
}

/** 内嵌 Python 包的初始真源（Task 11 会把它从 build-embedded-python.mjs:82 迁到这里） */
export const DEFAULT_PYTHON_EMBEDDED = [
  'openpyxl', 'python-docx', 'xlrd', 'Pillow', 'beautifulsoup4', 'rapidocr-onnxruntime',
  'PyPDF2', 'pypdf', 'pypdfium2', 'requests', 'Jinja2', 'openai', 'pydantic',
]

const NODE_BUILTINS = new Set(['fs', 'path', 'crypto', 'os', 'child_process', 'url', 'util', 'events', 'net', 'http', 'https', 'zlib', 'stream', 'buffer', 'assert', 'readline', 'worker_threads', 'perf_hooks', 'tty', 'dns', 'v8', 'module', 'process', 'timers', 'string_decoder', 'querystring', 'inspector', 'async_hooks', 'vm', 'constants', 'fs/promises', 'node:test'])
function isBuiltinModule(n) { return NODE_BUILTINS.has(n) }
/** tsconfig 的 `@/*` 别名与项目内的相对别名不算依赖 */
function isLocalAlias(n) { return n.startsWith('@/') }

export function readDeps({ root }) { return readJson({ root, rel: DEPS_FILE, fallback: null }) }
export function writeDeps({ root, data }) { writeJson({ root, rel: DEPS_FILE, data }) }
```

并在文件顶部的 import 里补 `statSync`（`node:fs`）与 `CONFIG_FILES`（来自 `./scan.mjs`）：

```js
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { trackedFiles, codeFiles, inDomains, readTracked, isTestFile, CONFIG_FILES } from './scan.mjs'
```

Create `kit/schema/deps.schema.json`：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DevKit deps ledger",
  "type": "object",
  "required": ["version", "domains", "python"],
  "properties": {
    "version": { "const": 1 },
    "domains": {
      "type": "object",
      "required": ["npm-runtime", "npm-dev", "kernel", "python-embedded", "python-skills"],
      "additionalProperties": {
        "type": "object",
        "properties": {
          "source": { "type": "string" },
          "assertZero": { "type": "boolean" },
          "packages": { "type": "array", "items": {
            "type": "object", "required": ["name"],
            "properties": { "name": { "type": "string" }, "spec": { "type": "string" },
              "status": { "enum": ["used", "unused", "declared"] },
              "evidence": { "type": "object", "properties": {
                "classes": { "type": "array", "items": { "enum": ["import", "dynamic-import", "config-file", "cli", "types"] } },
                "files": { "type": "array", "items": { "type": "string" } } } } } } }
        }
      }
    },
    "python": { "type": "object", "required": ["embedded"], "properties": { "embedded": { "type": "array", "items": { "type": "string" } } } },
    "gates": { "type": "object", "properties": {
      "ci": { "type": "array", "items": { "type": "string" } },
      "manual": { "type": "array", "items": { "type": "object", "required": ["script", "reason"] } } } },
    "sizes": { "type": "object", "additionalProperties": { "type": "number" } }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kit/lib/ledger.test.mjs`
Expected: PASS（17 个 test，0 fail）

- [ ] **Step 5: 生成真实依赖台账，逐条核对与 spec §6.2 的一致性**

Run:
```bash
node -e "import('./kit/lib/ledger.mjs').then(m=>{const r=m.syncDeps({root:process.cwd()});const rt=r.data.domains['npm-runtime'].packages;const dv=r.data.domains['npm-dev'].packages;console.log('runtime',rt.length,'dev',dv.length);console.log('unused runtime:',rt.filter(p=>p.status==='unused').map(p=>p.name).join(', '));console.log('unused dev:',dv.filter(p=>p.status==='unused').map(p=>p.name).join(', '));console.log('ghost:',r.ghost.join(', ')||'(无)');console.log('sizes:',JSON.stringify(r.data.sizes))})"
```
Expected（必须与 spec §6.2 一致）：
- `runtime 52 / dev 13`
- `unused runtime:` 恰好这 10 个：`@radix-ui/react-collapsible, @radix-ui/react-context-menu, @radix-ui/react-popover, @radix-ui/react-separator, @tanstack/react-virtual, classic-level, diff, mammoth, nanoid, xlsx`
- `unused dev:` 恰为 `@types/diff, @types/node, @types/react, @types/react-dom, @vitejs/plugin-react, autoprefixer, electron-builder, postcss, tailwindcss, typescript, vite` 的**补集**（`electron`、`rcedit` 应判 used）
- `ghost:` 应为空（若不为空，说明有真实幽灵依赖 —— 记入 `docs/待处理清单.md` 并升级为红灯，不要静默放过）

> **若 unused 与上面不一致**：以**实测为准**修正 spec §6.2 的清单（数字漂移是允许的，臆造不允许），并在 commit message 里写明差异。

- [ ] **Step 6: Commit**

```bash
git add kit/lib/ledger.mjs kit/lib/ledger.test.mjs kit/manifest/deps.json kit/schema/deps.schema.json
git commit -m "feat(kit): 依赖台账 sync（五类引用证据）

- EVIDENCE_CLASSES：import / dynamic-import / config-file / cli / types
  只扫 import 会得 6 个假阳性（rcedit 动态、electron-builder CLI、
  @tailwindcss/typography 等 7 个走配置文件）→ 误判的代价是"删掉在用的依赖"
- parseDeclaredImports + packageRootOf：反向幽灵依赖判定（含 @scope/pkg 归一）
- python 域：内嵌集真源移到 deps.json，技能侧解析 requirements.txt
- gates/sizes 可人工维护；体积仅趋势不设阈值（P6）"
```

---

## Task 6: 依赖校验规则 P1–P6

**Files:**
- Create: `kit/lib/dep-rules.mjs`
- Create: `kit/lib/dep-rules.test.mjs`

**Interfaces:**
- Consumes: Task 1/5；Task 2 的 `finding` / `checkResult` / `RED` / `YELLOW`
- Produces: `runDepRules({ root, deps, files? }): { checks, findings }`，规则 id `P1`–`P6`

- [ ] **Step 1: 写失败测试**

Create `kit/lib/dep-rules.test.mjs`：

```js
// kit/lib/dep-rules.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDepRules } from './dep-rules.mjs'

const deps = (over = {}) => ({
  version: 1,
  python: { embedded: ['openpyxl', 'PyPDF2'] },
  domains: {
    'npm-runtime': { source: 'package.json#dependencies', packages: [
      { name: 'react', status: 'used', evidence: { classes: ['import'], files: ['src/a.ts'] } },
      { name: 'xlsx', status: 'unused', evidence: { classes: [], files: [] } },
    ] },
    'npm-dev': { source: 'package.json#devDependencies', packages: [
      { name: '@types/node', status: 'used', evidence: { classes: ['types'], files: ['tsconfig.json'] } },
    ] },
    kernel: { source: 'kernel/package.json#dependencies', assertZero: true, packages: [] },
    'python-embedded': { source: 'kit/manifest/deps.json#python.embedded', packages: [{ name: 'openpyxl' }, { name: 'PyPDF2' }] },
    'python-skills': { source: 'x', packages: [{ name: 'openpyxl' }, { name: 'pdfplumber' }] },
  },
  gates: { ci: [], manual: [] },
  sizes: {},
  ...over,
})

test('P1 反例：声明了但零证据 → 红（unused 判定的落地）', () => {
  const { findings } = runDepRules({ root: '.', deps: deps() })
  const p1 = findings.filter((f) => f.rule === 'P1')
  assert.equal(p1.length, 1)
  assert.match(p1[0].subject, /xlsx/)
})

test('P2 反例：幽灵依赖（源码 import 未声明）→ 红', () => {
  const { findings } = runDepRules({ root: '.', deps: deps(), ghost: ['left-pad'] })
  assert.equal(findings.filter((f) => f.rule === 'P2').length, 1)
})

test('P3 反例：内核域出现依赖 → 红（恒为零依赖）', () => {
  const d = deps()
  d.domains.kernel = { ...d.domains.kernel, packages: [{ name: 'ws', status: 'declared' }] }
  const { findings } = runDepRules({ root: '.', deps: d })
  assert.equal(findings.filter((f) => f.rule === 'P3').length, 1)
})

test('P4：内嵌 Python 清单必须来自 deps.json（构建脚本与台账一致由测试保证）', () => {
  const d = deps()
  d.domains['python-embedded'].source = 'scripts/build-embedded-python.mjs'
  const { findings } = runDepRules({ root: '.', deps: d })
  assert.equal(findings.filter((f) => f.rule === 'P4').length, 1)
})

test('P5：两套 Python 清单差集 → 黄灯并逐项列出（不红）', () => {
  const { findings } = runDepRules({ root: '.', deps: deps() })
  const p5 = findings.filter((f) => f.rule === 'P5')
  assert.equal(p5.length, 1)
  assert.equal(p5[0].severity, 'yellow')
  assert.match(p5[0].actual, /pdfplumber/)
})

test('P6：sizes 缺失仅提示，不阻断', () => {
  const d = deps()
  d.sizes = {}
  const { findings } = runDepRules({ root: '.', deps: d })
  const p6 = findings.filter((f) => f.rule === 'P6')
  assert.equal(p6.every((f) => f.severity === 'yellow'), true)
})

test('全绿基线：无未用、无幽灵、内核零依赖 → 无红灯', () => {
  const d = deps()
  d.domains['npm-runtime'].packages = [d.domains['npm-runtime'].packages[0]]
  d.domains['python-skills'].packages = [{ name: 'openpyxl' }, { name: 'PyPDF2' }]
  d.sizes = { 'node_modules': 1, 'runtime/python': 1, 'runtime/skills': 1 }
  const { findings } = runDepRules({ root: '.', deps: d })
  assert.deepEqual(findings.filter((f) => f.severity === 'red'), [])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kit/lib/dep-rules.test.mjs`
Expected: FAIL —— `Cannot find module '.../dep-rules.mjs'`

- [ ] **Step 3: 写最小实现**

Create `kit/lib/dep-rules.mjs`：

```js
// kit/lib/dep-rules.mjs —— 依赖台账校验规则 P1–P6
import { YELLOW, RED, finding, checkResult } from './report.mjs'

export function runDepRules({ root, deps, ghost = [] } = {}) {
  const checks = []
  const findings = []
  if (!deps) {
    findings.push(finding({ rule: 'P0', severity: RED, subject: 'deps.json', hint: '跑 npm run kit:sync 生成台账' }))
    return { checks, findings }
  }
  const all = Object.entries(deps.domains || {}).flatMap(([domain, d]) => (d.packages || []).map((p) => ({ ...p, domain })))

  // ── P1：声明必须有证据（unused 落地为红） ─────────────────────────────
  const unused = all.filter((p) => p.status === 'unused')
  for (const p of unused) {
    findings.push(finding({ rule: 'P1', severity: RED, subject: `${p.name}@${p.domain}`,
      actual: '零引用证据',
      hint: '确认无用后从 package.json 删除；若在用，检查是否走动态 import / 配置文件 / CLI（五类证据见 spec §6.2）' }))
  }
  checks.push(checkResult({ rule: 'P1', title: '每个声明依赖都有引用证据', evaluated: all.length, passed: unused.length === 0 }))

  // ── P2：幽灵依赖（源码 import 但未声明） ──────────────────────────────
  for (const g of ghost) {
    findings.push(finding({ rule: 'P2', severity: RED, subject: g, actual: '未声明',
      hint: '源码 import 了但 package.json 未声明：补声明，或改掉这个 import' }))
  }
  checks.push(checkResult({ rule: 'P2', title: '无幽灵依赖', evaluated: ghost.length, passed: ghost.length === 0 }))

  // ── P3：内核域恒零依赖 ────────────────────────────────────────────────
  const kernelPkgs = (deps.domains?.kernel?.packages) || []
  if (deps.domains?.kernel?.assertZero && kernelPkgs.length > 0) {
    findings.push(finding({ rule: 'P3', severity: RED, subject: 'kernel', actual: `${kernelPkgs.length} 个依赖`,
      hint: '内核必须零第三方依赖（server/deploy-smoke.test.mjs 已有同源断言）：内核要能 bun 打成单文件' }))
  }
  checks.push(checkResult({ rule: 'P3', title: '内核域零第三方依赖', evaluated: kernelPkgs.length, passed: kernelPkgs.length === 0 }))

  // ── P4：内嵌 Python 清单真源必须在 deps.json（B2 的机制性保障） ─────────
  const embeddedSrc = deps.domains?.['python-embedded']?.source || ''
  const p4bad = !embeddedSrc.includes('deps.json')
  if (p4bad) {
    findings.push(finding({ rule: 'P4', severity: RED, subject: 'python-embedded.source', actual: embeddedSrc,
      hint: '内嵌包清单的真源必须是 kit/manifest/deps.json#python.embedded；构建脚本改读台账（见 Task 11 B2）' }))
  }
  checks.push(checkResult({ rule: 'P4', title: '内嵌 Python 清单真源在台账', evaluated: 1, passed: !p4bad }))

  // ── P5：两套 Python 清单差集（黄灯 + 逐项列出，不红） ──────────────────
  const emb = new Set((deps.python?.embedded) || [])
  const sk = new Set((deps.domains?.['python-skills']?.packages || []).map((p) => normalizePy(p.name)))
  const embN = new Set([...emb].map(normalizePy))
  const onlySkills = [...sk].filter((n) => !embN.has(n)).sort()
  const onlyEmbedded = [...embN].filter((n) => !sk.has(n)).sort()
  if (onlySkills.length || onlyEmbedded.length) {
    findings.push(finding({ rule: 'P5', severity: YELLOW, subject: 'python.embedded-vs-requirements',
      expected: `${embN.size} 个（内嵌）`, actual: `仅技能侧 ${onlySkills.join(', ') || '(无)'} ｜ 仅内嵌 ${onlyEmbedded.join(', ') || '(无)'}`,
      hint: '内嵌集是分发态最小集，技能侧含可选增强包；差集属预期，但必须能一眼看出（spec §6.3 P5）' }))
  }
  checks.push(checkResult({ rule: 'P5', title: '两套 Python 清单差集可见', evaluated: embN.size + sk.size, passed: true }))

  // ── P6：体积记账（仅趋势，缺项只提示） ────────────────────────────────
  const sizes = deps.sizes || {}
  for (const k of ['node_modules', 'runtime/python', 'runtime/skills']) {
    if (!sizes[k]) findings.push(finding({ rule: 'P6', severity: YELLOW, subject: `sizes.${k}`, actual: '未记录', hint: '跑 kit:sync 采集体积（仅趋势，无阈值）' }))
  }
  checks.push(checkResult({ rule: 'P6', title: '四域体积已记账', evaluated: Object.keys(sizes).length, passed: Object.keys(sizes).length > 0 }))

  return { checks, findings }
}

/** PyPI 包名归一：不区分大小写、`_` 与 `-` 等价（Pillow/pillow、pywin32/pywin32） */
export function normalizePy(name) { return String(name).toLowerCase().replace(/_/g, '-') }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kit/lib/dep-rules.test.mjs`
Expected: PASS（7 个 test，0 fail）

- [ ] **Step 5: Commit**

```bash
git add kit/lib/dep-rules.mjs kit/lib/dep-rules.test.mjs
git commit -m "feat(kit): 依赖校验规则 P1–P6

- P1 声明须有证据（红）／P2 幽灵依赖（红）／P3 内核域零依赖（红）
- P4 内嵌 Python 真源必须在 deps.json（B2 的机制性保障）
- P5 两套 Python 清单差集（黄灯 + 逐项列出，不红）
- P6 体积记账（仅趋势、无阈值，缺项只提示）"
```

---

## Task 7: `kit/cli.mjs` 装配（check / sync / view / stamp）

**Files:**
- Create: `kit/cli.mjs`
- Create: `kit/cli.test.mjs`

**Interfaces:**
- Consumes: 全部 Task 1–6 的导出
- Produces：命令行契约
  - `node kit/cli.mjs check [--json] [--verbose]` → 退出码 0（无红）/ 1（有红）；`--json` 输出 `Report`
  - `node kit/cli.mjs sync` → 重写 `versions.json` / `deps.json`；打印 added/removed/unused
  - `node kit/cli.mjs view [--json]` → **稳定 schema 摘要**（供 AI 读）
  - `node kit/cli.mjs stamp` → 写 `release/YFWorking/kit-stamp.json`（Task 13 实现具体字段）

`view --json` 输出形状（AI 的稳定契约）：

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "…",
  "ok": false,
  "summary": { "red": 20, "yellow": 3, "baselined": 0, "green": 12, "rules": 17 },
  "ledgers": { "versions": { "lines": 4, "contracts": 14, "skills": 22, "skillsLock": 20, "commonTools": 98 },
               "deps": { "npm-runtime": 52, "npm-dev": 13, "kernel": 0, "python-embedded": 13, "python-skills": 25 } },
  "findings": [ { "rule": "V7", "severity": "red", "subject": "…", "file": "…", "hint": "…" } ]
}
```

- [ ] **Step 1: 写失败测试（子进程端到端）**

Create `kit/cli.test.mjs`：

```js
// kit/cli.test.mjs —— CLI 端到端（spawn 真进程，非 mock）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = resolve(ROOT, 'kit/cli.mjs')

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000 })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status ?? -1, stdout: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

test('view --json 输出稳定 schema，可被程序直接解析', () => {
  const r = run(['view', '--json'])
  const j = JSON.parse(r.stdout)
  assert.equal(j.schemaVersion, 1)
  assert.equal(typeof j.ok, 'boolean')
  assert.ok(j.summary && typeof j.summary.red === 'number')
  assert.ok(j.ledgers.versions.lines >= 4)
  assert.ok(j.ledgers.deps['npm-runtime'] >= 50)
  assert.ok(Array.isArray(j.findings))
})

test('check --json 与 view 同源（summary 一致）', () => {
  const a = JSON.parse(run(['view', '--json']).stdout)
  const b = JSON.parse(run(['check', '--json']).stdout)
  assert.deepEqual(b.summary, a.summary)
})

test('check 退出码：有红 → 1；--verbose 人话报告含红灯段', () => {
  const r = run(['check', '--verbose'])
  assert.equal(r.code, 1, '台账现状应至少含 V7 的红灯（A7 未修）')
  assert.match(r.stdout, /DevKit 检查/)
})

test('未知子命令 → 非 0 退出且给出用法（不允许静默忽略）', () => {
  const r = run(['nope'])
  assert.notEqual(r.code, 0)
  assert.match(r.stdout, /用法/)
})

test('check 不写任何文件（只读门禁）', () => {
  // 反例式断言：改动 mtime 无法直接测，改用"check 后 git status 不含 kit/manifest"
  const before = execFileSync('git', ['status', '--porcelain', 'kit/manifest'], { cwd: ROOT, encoding: 'utf8' })
  run(['check', '--json'])
  const after = execFileSync('git', ['status', '--porcelain', 'kit/manifest'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(after, before, 'check 必须是纯只读：不得改动台账')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kit/cli.test.mjs`
Expected: FAIL —— `Cannot find module '.../kit/cli.mjs'`

- [ ] **Step 3: 写最小实现**

Create `kit/cli.mjs`：

```js
#!/usr/bin/env node
// kit/cli.mjs —— DevKit 唯一入口
//
// 四命令分工（刻意分离，禁止合并）：
//   check  纯只读门禁（CI 用；退出码 0/1）—— 绝不写文件，否则"跑门禁"会改仓库状态
//   sync   从宿主文件发现事实、重写台账（人工维护的字段被保留）
//   view   给 AI 读的稳定 schema 摘要（不解析散文）
//   stamp  给调试版盖章（release/ 为 local-only，不进 CI 门禁）
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackedFiles } from './lib/scan.mjs'
import { makeReport, renderHuman, RED } from './lib/report.mjs'
import { loadBaseline, applyBaseline, baselineGrowth } from './lib/baseline.mjs'
import { readVersions, readDeps, syncVersions, syncDeps } from './lib/ledger.mjs'
// Task 9 落地后改为：import { readVersions, readDeps, syncVersions, syncDeps, syncSkillsLock } from './lib/ledger.mjs'
import { runVersionRules } from './lib/version-rules.mjs'
import { runDepRules } from './lib/dep-rules.mjs'
import { parseDeclaredImports, packageRootOf } from './lib/ledger.mjs'

const ROOT = process.env.YFW_KIT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `用法：node kit/cli.mjs <check|sync|view|stamp> [选项]

  check [--json] [--verbose]   台账门禁（只读）。退出码 0=无红灯，1=有红灯
  sync  [--dry-run]            从宿主文件重建台账（保留人工字段）
  view  [--json]               输出台账摘要（AI 侧稳定 schema）
  stamp [--json]               给 dev 渠道盖章（写 release/YFWorking/kit-stamp.json）
`

function collect() {
  const files = trackedFiles({ root: ROOT })
  const versions = readVersions({ root: ROOT })
  const deps = readDeps({ root: ROOT })
  const ghost = deps ? ghostOf({ files }) : []
  const v = runVersionRules({ root: ROOT, versions, files })
  const d = runDepRules({ root: ROOT, deps, ghost })
  return { files, versions, deps, checks: [...v.checks, ...d.checks], findings: [...v.findings, ...d.findings] }
}

/** 幽灵依赖：源码 import 的包既不在运行时也不在 dev 声明里 */
function ghostOf({ files }) {
  const deps = readDeps({ root: ROOT })
  const declared = new Set([
    ...((deps?.domains?.['npm-runtime']?.packages) || []).map((p) => p.name),
    ...((deps?.domains?.['npm-dev']?.packages) || []).map((p) => p.name),
  ])
  const builtins = new Set(['fs', 'path', 'crypto', 'os', 'child_process', 'url', 'util', 'events', 'net', 'http', 'https', 'zlib', 'stream', 'buffer', 'assert', 'readline', 'worker_threads', 'perf_hooks', 'tty', 'dns', 'v8', 'module', 'process', 'timers', 'string_decoder', 'querystring', 'inspector', 'async_hooks', 'vm', 'constants'])
  return [...new Set(parseDeclaredImports({ root: ROOT, files }).map(packageRootOf))]
    .filter((n) => n && !n.startsWith('node:') && !n.startsWith('@/') && !builtins.has(n) && !declared.has(n))
    .sort()
}

function buildReport() {
  const { checks, findings, versions } = collect()
  const baseline = loadBaseline({ root: ROOT })
  const applied = applyBaseline(findings, baseline)
  const report = makeReport({ checks, findings: applied.findings })
  const growth = baselineGrowth({ baseline, recordedCount: versions?.history?.baselineCount ?? null })
  if (growth) {
    report.findings.push({
      rule: 'BASE', severity: RED, subject: 'drift-baseline.entries',
      expected: String(growth.recordedCount), actual: String(growth.exceeded),
      hint: '基线条目数超过了每次签入时登记的数量：基线是"已知欠账"，不是"遇红就塞"',
    })
    report.ok = false
    report.summary.red += 1
  }
  report.baselineUnused = applied.unused
  return report
}

function ledgerSizes() {
  const v = readVersions({ root: ROOT }) || {}
  const d = readDeps({ root: ROOT }) || {}
  const count = (k) => ((d.domains?.[k]?.packages) || []).length
  return {
    versions: {
      lines: (v.lines || []).length, contracts: (v.contracts || []).length,
      skills: (v.skills || []).length, skillsLock: (v.skillsLock?.ids || []).length,
      commonTools: (v.commonTools?.entries || []).length,
    },
    deps: {
      'npm-runtime': count('npm-runtime'), 'npm-dev': count('npm-dev'), kernel: count('kernel'),
      'python-embedded': count('python-embedded'), 'python-skills': count('python-skills'),
    },
  }
}

const [, , cmd, ...rest] = process.argv
const asJson = rest.includes('--json')

if (cmd === 'check') {
  const report = buildReport()
  if (asJson) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(renderHuman(report))
    if (report.baselineUnused?.length) console.log(`\n（信息）基线中 ${report.baselineUnused.length} 条已不再命中，可摘除：${report.baselineUnused.join(', ')}`)
  }
  process.exit(report.ok ? 0 : 1)
} else if (cmd === 'view') {
  const report = buildReport()
  const payload = {
    schemaVersion: 1, generatedAt: report.generatedAt, ok: report.ok, summary: report.summary,
    ledgers: ledgerSizes(), findings: report.findings,
  }
  console.log(asJson ? JSON.stringify(payload, null, 2) : renderHuman(makeReport({ checks: [], findings: report.findings })))
  process.exit(0)
} else if (cmd === 'sync') {
  const dry = rest.includes('--dry-run')
  const v = syncVersions({ root: ROOT, dryRun: dry })
  const d = syncDeps({ root: ROOT })
  // Task 9 落地后替换为： const lock = syncSkillsLock({ root: ROOT, dryRun: dry })
  const lock = { updated: [], unchanged: [], missing: [] }
  console.log(`versions: lines ${v.data.lines.length} / contracts ${v.data.contracts.length} / skills ${v.data.skills.length} / lockIds ${v.data.skillsLock.ids.length} / commonPy ${v.data.commonTools.entries.length}`)
  console.log(`  added ${v.added.length}  removed ${v.removed.length}`)
  if (v.added.length) console.log(`  + ${v.added.join('\n  + ')}`)
  if (v.removed.length) console.log(`  - ${v.removed.join('\n  - ')}`)
  console.log(`skills-lock: updated ${lock.updated.length} / unchanged ${lock.unchanged.length} / missing ${lock.missing.length}`)
  console.log(`deps: runtime ${d.data.domains['npm-runtime'].packages.length} / dev ${d.data.domains['npm-dev'].packages.length}`)
  console.log(`  unused ${d.unused.length}: ${d.unused.join(', ') || '(无)'}`)
  console.log(`  ghost  ${d.ghost.length}: ${d.ghost.join(', ') || '(无)'}`)
  process.exit(0)
} else if (cmd === 'stamp') {
  const { stampChannel } = await import('./lib/stamp.mjs')
  const info = stampChannel({ root: ROOT })
  console.log(asJson ? JSON.stringify(info, null, 2) : `已盖章：${info.stampFile}\n  commit ${info.commit}（dirty: tracked ${info.dirty.tracked} / untracked ${info.dirty.untracked}）`)
  process.exit(0)
} else {
  console.error(USAGE)
  process.exit(cmd ? 1 : 0)
}
```

> **注意**：`stamp` 分支用到顶层 `await import`，而这是 ESM 顶层 `await`（`.mjs` 支持）。若实施时觉得别扭，改为函数内 `await`（包在 `async function main()` 里）。Task 13 会创建 `lib/stamp.mjs`；在 Task 13 之前 `stamp` 命令会失败——**这是预期的**，Step 1 的测试不覆盖 `stamp`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kit/cli.test.mjs`
Expected: PASS（5 个 test，0 fail）。其中 `check` 退出码为 1（V7 的 20 条红灯尚未修 —— 那是 Task 9 的事）。

- [ ] **Step 5: 实测门禁耗时（G6 的硬约束：< 5s）**

Run:
```bash
node -e "const t=Date.now();require('child_process').execFileSync(process.execPath,['kit/cli.mjs','check','--json'],{encoding:'utf8'});console.log('kit:check 耗时', Date.now()-t, 'ms')" 2>/dev/null || (time node kit/cli.mjs check --json > /dev/null)
```
Expected: 耗时 **< 5000 ms**（把实测值记下，Task 14 要写进 `docs/ci.md`）。若超时：检查是否误对全仓 1500+ 文件做了逐行正则——`collectEvidence` 只应扫代码文件与 `CONFIG_FILES`。

- [ ] **Step 6: Commit**

```bash
git add kit/cli.mjs kit/cli.test.mjs
git commit -m "feat(kit): CLI 装配（check / sync / view / stamp 四命令）

- check 纯只读门禁：退出码 0/1，绝不写文件（含反例断言）
- view 输出 schemaVersion=1 的稳定 JSON（AI 侧契约，不必解析散文）
- sync 重建台账并打印 added/removed/unused/ghost
- BASE 规则：基线条目数超过 history.baselineCount → 红（防遇红就塞）
- 端到端测试用 spawn 真进程（非 mock），并断言 check 与 view 的 summary 同源"
```

---
---

## Task 8: 欠账 A2 / A3 / A5 —— 版本号入口补齐

**为什么必须一起做**：`bump-version.mjs` 是目前唯一的版本号入口，但它**写不了 GUI 线**（`package.json` 2.8.0 无 bump 路径）、**写不进历史**（台账 `history.records` 是 V3 的判据）、而它的"同步测试期望值"分支**永走跳过**（`server/version.test.mjs` 不存在）。三条不一起修，台账上线当天就会被一次正常发版打红。

**Files:**
- Modify: `scripts/bump-version.mjs`
- Modify: `version.mjs:3-7`（注释口径）
- Create: `server/version.test.mjs`

**Interfaces:**
- Consumes: Task 3 的 `readVersions` / `writeVersions` / `syncVersions`（bump 后要更新台账与历史）
- Produces：`node scripts/bump-version.mjs <app|kernel|pkg> <版本号> [--dry-run]`

- [ ] **Step 1: 先建测试文件（A5）—— 断言必须与 bump 脚本的字面替换模式一致**

Create `server/version.test.mjs`：

```js
// server/version.test.mjs —— 版本号断言（A5）
//
// ★ 这个文件的形式是**被 scripts/bump-version.mjs 依赖的**：
//   该脚本用字面替换更新断言，模式为 `assert.equal(<CONST>, '<旧值>')`。
//   所以下面两行必须严格保持 `assert.equal(APP_VERSION, 'dev 3.0.0')` 这种**单行、单引号**写法 ——
//   改成双引号、加空格或换行都会让 bump 脚本 fail('未找到待替换文本')。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION, KERNEL_VERSION, SCHEMA_VERSION } from '../version.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('应用线与内核线版本常量与发布口径一致', () => {
  assert.equal(APP_VERSION, 'dev 3.0.0')
  assert.equal(KERNEL_VERSION, 'dev 0.2')
})

test('内核线跨载体映射：dev X.Y ↔ kernel/package.json 的 X.Y.0', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'kernel', 'package.json'), 'utf8'))
  const semver = KERNEL_VERSION.replace(/^dev\s+/, '')
  const expect = semver.split('.').length === 2 ? `${semver}.0` : semver
  assert.equal(pkg.version, expect)
})

test('settings schema 版本是正整数（读取旧文件时沿迁移链升级）', () => {
  assert.equal(Number.isInteger(SCHEMA_VERSION), true)
  assert.ok(SCHEMA_VERSION >= 1)
})
```

- [ ] **Step 2: 运行测试确认能跑且能红（先验证它真的在断言）**

Run:
```bash
node --test server/version.test.mjs
```
Expected: PASS（3 个 test）。

然后**故意改错值**确认能红：
```bash
node -e "const f='version.mjs';const t=require('fs').readFileSync(f,'utf8');require('fs').writeFileSync(f,t.replace(\"'dev 3.0.0'\",\"'dev 3.0.1'\"))"
node --test server/version.test.mjs ; echo "EXIT=$?"
git checkout -- version.mjs
```
Expected: `EXIT=` 非 0。**若仍为 0，说明断言没生效，必须先修好再继续。**

- [ ] **Step 3: 给 bump 脚本加 `pkg` 目标与台账历史（A2 + V3 集成）**

Modify `scripts/bump-version.mjs`。四处改动：

**① 头部注释与用法**（同步 A3）：

```js
// 用法：
//   node scripts/bump-version.mjs app 3.0.1     # Ponos 应用（turbo 内核版）
//   node scripts/bump-version.mjs kernel 0.2    # Ponos-Turbo 内核（同步 kernel/package.json）
//   node scripts/bump-version.mjs pkg 2.9.0     # GUI 发布线（package.json version）
//   node scripts/bump-version.mjs app 3.0.1 --dry-run   # 演练：只打印将发生的改动
// 版本格式：dev <major>.<minor>[.<patch>]（发布稳定后去掉 dev 前缀）。
// 自动同步位置：
//   - version.mjs 常量（APP_VERSION / KERNEL_VERSION）
//   - server/version.test.mjs 期望值断言（A5 后该文件已存在，分支不再跳过）
//   - package.json version（仅 pkg 目标：GUI 发布线，Vite 注入 __APP_VERSION__）
//   - kernel/package.json semver（仅内核线：'dev X.Y' -> 'X.Y.0'，'dev X.Y.Z' -> 'X.Y.Z'）
//   - kit/manifest/versions.json（值 + history.records；V3 要求版本变更必须留记录）
```

**② 常量与目标表**：

```js
const PKG_JSON = join(ROOT, 'package.json')
const VERSIONS_LEDGER = join(ROOT, 'kit', 'manifest', 'versions.json')

const TARGETS = {
  app: { const: 'APP_VERSION', label: 'Ponos 应用（turbo 内核版）', file: 'version.mjs', ledgerKeyOf: (v) => `APP_VERSION@version.mjs` },
  kernel: { const: 'KERNEL_VERSION', label: 'Ponos-Turbo 内核', file: 'version.mjs', ledgerKeyOf: (v) => `KERNEL_VERSION@version.mjs` },
  pkg: { jsonPath: 'version', label: 'GUI 发布线', file: 'package.json', ledgerKeyOf: (v) => `GUI_VERSION@package.json` },
}
```

**③ 守卫与分派**：

```js
if (!Object.prototype.hasOwnProperty.call(TARGETS, target)) fail(`未知目标 "${target}"，应为 app、kernel 或 pkg`)
```

把原来写死的 `const bump = target === 'app' ? … : …` 与 `label` 两行替换为：

```js
const bump = TARGETS[target]
const label = bump.label
```

把 `patch(VERSION_MJS, … original文字 …)` 那一行替换为按目标分派：

```js
if (bump.const) {
  const vm = readFileSync(VERSION_MJS, 'utf8')
  const cur = vm.match(new RegExp(`export const ${bump.const} = '([^']+)'`))?.[1]
  if (!cur) fail(`version.mjs 中未找到 ${bump.const} 常量`)
  patch(VERSION_MJS, `export const ${bump.const} = '${cur}'`, `export const ${bump.const} = '${ver}'`, `version.mjs ${bump.const}`)
  currentValue = cur
} else {
  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'))
  currentValue = pkg.version
  patch(PKG_JSON, `"version": "${pkg.version}"`, `"version": "${ver}"`, 'package.json version')
}
```

（在分派前声明 `let currentValue = ''`；把原来那两行 `const vm = readFileSync(...)` 与 `const cur = vm.match(...)` 一并移入上面分支。）

**④ 末尾追加台账同步**（放在最终 `console.log` 之前）：

```js
// 台账同步：值 + history.records。
// 顺序很重要 —— 先追加历史记录再 sync：sync 会用**已含记录**的 prev 作合并基底，
// 于是写出的值必然等于末条记录的 to，V3（链连续 + 末条 to == 当前值）当场成立。
if (existsSync(VERSIONS_LEDGER) && !dryRun) {
  try {
    const { readVersions, writeVersions } = await import('../kit/lib/ledger.mjs')
    const { syncVersions } = await import('../kit/lib/ledger.mjs')
    const ledger = readVersions({ root: ROOT })
    const key = bump.ledgerKeyOf()
    const entry = [...(ledger.lines || []), ...(ledger.contracts || [])].find((e) => `${e.id}@${e.file}` === key)
    ledger.history = ledger.history || { baselineCount: 0, records: [] }
    ledger.history.records = ledger.history.records || []
    ledger.history.records.push({ key, from: entry ? entry.value : currentValue, to: ver, at: new Date().toISOString().slice(0, 10), reason: 'bump-version.mjs' })
    ledger.history.baselineCount = ledger.history.baselineCount ?? 0
    writeVersions({ root: ROOT, data: ledger })
    syncVersions({ root: ROOT })
    console.log(`[bump] kit/manifest/versions.json 已同步（history.records + ${key}）`)
  } catch (e) {
    fail(`台账同步失败：${e.message}（版本号已改，请手跑 npm run kit:sync 后重试）`)
  }
}
```

> **注意**：`bump-version.mjs` 是 `.mjs`，顶部已有 `import`，因此 `await import(...)` 在模块顶层可用。

- [ ] **Step 4: 演练三线（`--dry-run`，不改任何文件）**

Run:
```bash
node scripts/bump-version.mjs app 3.0.1 --dry-run
node scripts/bump-version.mjs kernel 0.3 --dry-run
node scripts/bump-version.mjs pkg 2.9.0 --dry-run
node scripts/bump-version.mjs nope 1.0 --dry-run ; echo "EXIT=$?"
node scripts/bump-version.mjs app 3.x --dry-run ; echo "EXIT=$?"
```
Expected: 前三条各自打印将替换的文本；后两条 `EXIT=` 非 0（未知目标 / 非法版本号）。

- [ ] **Step 5: 真跑一次再回滚，验证台账历史与 V3 成立**

Run:
```bash
node scripts/bump-version.mjs app 3.0.1
node --test server/version.test.mjs            # 断言已被同步成 3.0.1
node kit/cli.mjs check --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const v3=j.findings.filter(f=>f.rule==='V3');console.log('V3 红灯:',v3.length);const v1=j.findings.filter(f=>f.rule==='V1'&&/APP_VERSION/.test(f.subject));console.log('V1 APP_VERSION 红灯:',v1.length)})"
git checkout -- version.mjs server/version.test.mjs
node -e "const {writeFileSync,readFileSync}=require('fs');const p='kit/manifest/versions.json';const j=JSON.parse(readFileSync(p,'utf8'));j.lines=j.lines.map(l=>l.id==='APP_VERSION'?{...l,value:'dev 3.0.0'}:l);j.history.records=j.history.records.filter(r=>r.key!=='APP_VERSION@version.mjs');writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
node kit/cli.mjs check --json > /dev/null ; echo "还原后 EXIT=$?"
```
Expected: 两次 `V3 红灯: 0`、`V1 APP_VERSION 红灯: 0`；还原后 `EXIT=1`（只剩 V7 的 20 条 A7 红灯 —— 那是 Task 9 的事）。

- [ ] **Step 6: 同步 `version.mjs` 注释口径（A3）**

Modify `version.mjs:3-6`：

```js
// 四条版本线（详见 docs/architecture.md「版本实体」与 kit/manifest/versions.json）：
//   1. APP_VERSION     — Ponos 应用（turbo 内核版）
//   2. KERNEL_VERSION  — Ponos-Turbo 内核（ponos-turbo），独立可运行
//   3. package.json version — Ponos GUI 发布线（旧内核稳定版，Vite 注入 __APP_VERSION__）
//   4. SCHEMA_VERSION  — settings 文件 schema 版本（下方导出）
// 升级版本号禁止手改，一律走 scripts/bump-version.mjs（自动同步测试期望值/package.json/版本台账）。
```

（原文写"三条独立版本线"却把 SCHEMA_VERSION 单独导出 —— 注释与代码不符，这正是 `README.md` §8 那类问题的实例。）

- [ ] **Step 7: 全量验证**

Run: `npm run typecheck && npm run test:preflight && node --test server/version.test.mjs kit/lib/ledger.test.mjs`
Expected: 全绿；`test:preflight` 的 `server` 层计数从 92 → 93。

- [ ] **Step 8: Commit**

```bash
git add scripts/bump-version.mjs version.mjs server/version.test.mjs kit/manifest/versions.json docs/_anchors.json
git commit -m "fix(kit): 补齐版本号入口（A2/A3/A5）

- A2：bump-version.mjs 新增 pkg 目标（GUI 发布线 package.json version 原本无 bump 路径）
- A3：version.mjs 注释由"三条独立版本线"修正为四条（SCHEMA_VERSION 单独导出却不计入，注释与代码不符）
- A5：新建 server/version.test.mjs —— 原先该文件不存在，bump 脚本的
  '同步测试期望值' 分支是死路径（永远走 else 跳过），版本断言实际不存在
- bump 后自动同步 kit/manifest/versions.json 的 值 + history.records（V3 要求变更留痕）
- 实测：真跑一次 bump → V1/V3 全绿；还原 → 只剩 A7 的 V7 红灯"
```

---

## Task 9: 欠账 A6 / A7 —— `_common` 覆盖与 lock 重算

**Files:**
- Modify: `kit/lib/ledger.mjs`（追加 `syncSkillsLock`）
- Modify: `kit/lib/ledger.test.mjs`（追加其测试）
- Modify: `skills-lock.json`（20 条 `computedHash` 重算）
- Modify: `public/sample-skills/_common/_common_manifest.json`（补 `_note` 说明 `current_version` 的来源与可校验性）
- Modify: `kit/manifest/versions.json`（`commonTools` 覆盖到 98/98）
- Modify: `docs/superpowers/specs/2026-09-19-devkit-design.md`（A6/A7 状态标记，**同步数字**）

**Interfaces:**
- Produces: `syncSkillsLock({ root, files? }): { updated: string[], unchanged: string[], missing: string[] }`

- [ ] **Step 1: 写失败测试（追加到 `kit/lib/ledger.test.mjs`）**

```js
// ── Task 9：lock 重算（A7） ────────────────────────────────────────────────
import { syncSkillsLock } from './ledger.mjs'

test('syncSkillsLock：重算 computedHash、保留 source/其他字段、只写 lock 文件', () => {
  const root = fixture({
    'public/sample-skills/demo/SKILL.md': '---\nname: demo\nversion: "1.0.0"\n---\n\n正文\n',
    'skills-lock.json': JSON.stringify({ version: 1, skills: { demo: { source: 'anthropics/skills', upstreamHash: 'KEEP', computedHash: 'STALE' } } }),
  })
  const r = syncSkillsLock({ root, files: ['public/sample-skills/demo/SKILL.md', 'skills-lock.json'] })
  const after = JSON.parse(readFileSync(join(root, 'skills-lock.json'), 'utf8'))
  assert.equal(after.skills.demo.upstreamHash, 'KEEP', '非目标字段必须原样保留（DRY：只改该改的）')
  assert.equal(after.skills.demo.source, 'anthropics/skills')
  assert.notEqual(after.skills.demo.computedHash, 'STALE')
  assert.equal(after.skills.demo.computedHash.length, 64)
  assert.deepEqual(r.updated, ['demo'])
})

test('syncSkillsLock：lock 里登记但文件不存在 → 进 missing，不静默删除条目', () => {
  const root = fixture({ 'skills-lock.json': JSON.stringify({ skills: { ghost: { computedHash: 'x' } } }) })
  const r = syncSkillsLock({ root, files: ['skills-lock.json'] })
  assert.deepEqual(r.missing, ['ghost'])
  assert.ok(JSON.parse(readFileSync(join(root, 'skills-lock.json'), 'utf8')).skills.ghost)
})

test('syncSkillsLock：二次运行幂等（unchanged 全量）', () => {
  const root = fixture({
    'public/sample-skills/demo/SKILL.md': '---\nname: demo\nversion: "1.0.0"\n---\n\n正文\n',
    'skills-lock.json': JSON.stringify({ skills: { demo: { computedHash: 'x' } } }),
  })
  const files = ['public/sample-skills/demo/SKILL.md', 'skills-lock.json']
  syncSkillsLock({ root, files })
  const second = syncSkillsLock({ root, files })
  assert.deepEqual(second.updated, [])
  assert.deepEqual(second.unchanged, ['demo'])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kit/lib/ledger.test.mjs`
Expected: FAIL —— `does not provide an export named 'syncSkillsLock'`

- [ ] **Step 3: 追加实现（`kit/lib/ledger.mjs` 末尾）**

```js
// ── Task 9（A7）：重算 skills-lock（D5 —— 记录"本地安装后"哈希） ────────────
//
// ★ 为什么必须改 lock 文件本身、而不是记进台账：
//   台账由 sync 生成，若哈希也由 sync 写进台账、V7 又拿台账比对文件，
//   则"跑一次 sync"必然让 V7 全绿 —— 门禁被自己的 sync 架空。
//   判据必须是**已提交的 lock 文件**：改 SKILL.md 却忘了重算 lock → V7 红。
//   lock 的角色从"记上游原文哈希"（实测 20/20 与本地不符）改为"记本地安装后哈希"（D5）。
export const LOCK_FILE = 'skills-lock.json'
export const LOCK_FIELD = 'computedHash'

export function syncSkillsLock({ root, files, dryRun = false } = {}) {
  const tracked = files || trackedFiles({ root })
  const lock = readJson({ root, rel: LOCK_FILE, fallback: null })
  if (!lock || !lock.skills) return { updated: [], unchanged: [], missing: [], skipped: true }
  const updated = [], unchanged = [], missing = []
  for (const id of Object.keys(lock.skills)) {
    const file = `${SKILLS_DIR}/${id}/SKILL.md`
    if (!tracked.includes(file)) { missing.push(id); continue }
    const actual = sha256File({ root, file })
    if (lock.skills[id][LOCK_FIELD] === actual) { unchanged.push(id); continue }
    lock.skills[id] = { ...lock.skills[id], [LOCK_FIELD]: actual }
    updated.push(id)
  }
  if (!dryRun && updated.length) writeJson({ root, rel: LOCK_FILE, data: lock })
  return { updated, unchanged, missing }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kit/lib/ledger.test.mjs`
Expected: PASS（20 个 test，0 fail）

- [ ] **Step 5: 真跑 A7 —— 重算 20 条哈希**

Run:
```bash
node -e "import('./kit/lib/ledger.mjs').then(m=>{const r=m.syncSkillsLock({root:process.cwd()});console.log('updated',r.updated.length,'unchanged',r.unchanged.length,'missing',r.missing.length)})"
node kit/cli.mjs check --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('summary',JSON.stringify(j.summary));console.log('剩余红灯:',j.findings.filter(f=>f.severity==='red').map(f=>f.rule+':'+f.subject).join(', ')||'(无)')})"
```
Expected: `updated 20 / unchanged 0 / missing 0`；随后 `check` 的红灯只剩 V8/V8b 之类（A6 尚未处理），**不应再有 V7**。

- [ ] **Step 6: A6 —— 确认 98/98 覆盖并给 `_common_manifest.json` 补可校验性说明**

Run:
```bash
node -e "const {readVersions,listCommonPy,trackedFiles}=await import('./kit/lib/ledger.mjs');const v=readVersions({root:process.cwd()});const py=listCommonPy(trackedFiles({root:process.cwd()}));const entries=(v.commonTools.entries||[]).map(e=>e.file.replace('public/sample-skills/_common/',''));const missing=py.filter(n=>!entries.includes(n));console.log('实有',py.length,'已登记',entries.length,'漏登记',missing.length, missing.slice(0,5).join(','))" 2>/dev/null || node --input-type=module -e "import {readVersions,listCommonPy,trackedFiles} from './kit/lib/ledger.mjs';const v=readVersions({root:process.cwd()});const py=listCommonPy(trackedFiles({root:process.cwd()}));const entries=(v.commonTools.entries||[]).map(e=>e.file.replace('public/sample-skills/_common/',''));const missing=py.filter(n=>!entries.includes(n));console.log('实有',py.length,'已登记',entries.length,'漏登记',missing.length, missing.slice(0,5).join(','))"
```
Expected: `实有 98 已登记 98 漏登记 0`。

然后 Modify `public/sample-skills/_common/_common_manifest.json` —— 在顶层加一个 `_note`（**不改任何 `tools` 条目**）：

```json
"_note": "tools[*].current_version 由本清单人工维护，**不从脚本内容校验** —— 实测 98 个 _common/*.py 零个声明 __version__（spec §5.4 刻意不回填，避免制造大量无关 diff）。版本台账见 kit/manifest/versions.json 的 commonTools 段（全量 98 条登记，未标注者 version=null + versionSource=unmarked）；新增脚本必须声明 __version__ 或显式登记（规则 V8'）。"
```

- [ ] **Step 7: 同步 spec 的欠账状态（不留"已尝试"）**

Modify `docs/superpowers/specs/2026-09-19-devkit-design.md` §10 表格中 A6/A7 两行，把"修复方式"改为过去时并附实测数字：

```
| A6 | `_common_manifest.json` 仅 9/98；98 个 `.py` 零个声明 `__version__` | ✅ 已修：台账全量登记 98/98（未标注者 `null`+`unmarked`）；给 manifest 补 `_note` 说明其版本不可从脚本内容校验；V8′ 只对新文件强制 | 规则 V8/V8b 全绿；漏登记计数 0 |
| A7 | `skills-lock.json` 20/20 哈希不符 | ✅ 已修：按 D5 重定义为本地安装后哈希，`syncSkillsLock` 重算 20 条；V7 **直读 lock 文件**（不读台账，防 sync 自证） | V7 全绿；改任一 `SKILL.md` 后立刻红（含防自证反例） |
```

- [ ] **Step 8: Commit**

```bash
git add kit/lib/ledger.mjs kit/lib/ledger.test.mjs skills-lock.json public/sample-skills/_common/_common_manifest.json kit/manifest/versions.json docs/superpowers/specs/2026-09-19-devkit-design.md
git commit -m "fix(kit): 修 A6/A7（_common 覆盖 98/98、lock 按本地哈希重算）

- A7：skills-lock.json 的角色由'记上游原文哈希'改为'记本地安装后哈希'（D5）
  实测原 20/20 与本地 SKILL.md 不符 → 重算后 V7 全绿
  关键：V7 直读 lock 文件而非台账 —— 否则跑一次 sync 就能把门禁刷绿（自证陷阱）
- syncSkillsLock：只改 computedHash，其余字段（source/upstreamHash）原样保留；幂等
- A6：commonTools 覆盖 98/98；98 个 .py 一字符未改（spec §5.4 划界）
  给 _common_manifest.json 补 _note 说明其版本不可从脚本内容校验"
```

---

## Task 10: 欠账 B1 —— 删除 10 个未用运行时依赖

**风险提示（务必先看）**：这是本方案里**唯一会造成不可逆损失**的任务。删错一个依赖 = 线上功能静默失效。因此**禁止批量 `npm uninstall` 一次删完**，必须逐个删、逐个验证。

**Files:**
- Modify: `package.json`（`dependencies` −10）

**前置**：Task 5 已完成，`deps.json` 里 `npm-runtime` 的 `status: "unused"` 共有 10 条：
`classic-level`、`diff`、`mammoth`、`nanoid`、`xlsx`、`@tanstack/react-virtual`、`@radix-ui/react-collapsible`、`@radix-ui/react-context-menu`、`@radix-ui/react-popover`、`@radix-ui/react-separator`。

> `ws` **不在**此列 —— 实测它在 `electron/` 与 `server/` 里有用，`README.md` §4.8.8 把它与 `classic-level` 并列描述是不准确的。**以台账为准，不要凭 README 删 `ws`。**

- [ ] **Step 1: 逐个做"运行时动态加载"排查（删前必做）**

对 10 个包逐个执行（示例给 `xlsx`，其余同理替换包名）：

```bash
P=xlsx
echo "=== 全仓字符串出现（含非代码文件，排除 node_modules/dist） ==="
git grep -n "$P" -- . ':!node_modules' ':!dist' ':!release' ':!kernel-dist' ':!package-lock.json' ':!pnpm-lock.yaml' | head -20
echo "=== 是否存在字符串拼接式 require / import（动态路径） ==="
git grep -nE "(require|import)\\((\`|'|\")[^)]*\\$\\{" -- '*.mjs' '*.cjs' '*.ts' '*.tsx' | head -20
echo "=== 是否出现在 vite/electron-builder/tsconfig 的 externals|alias|optimizeDeps ==="
git grep -n "$P" -- vite.config.ts tailwind.config.ts electron-builder.yml tsconfig.json
```
Expected: 每条都应**只在 `package.json` 出现**（即纯声明未用）。**任何一条出现其他引用 → 该包保留，并在 `deps.json` 里给它的 `evidence.classes` 补上实际类别**（`import`/`dynamic-import`/`config-file`/`cli`/`types`），然后 `npm run kit:sync`，看它是否变 `used`。

> `mammoth` 与 `xlsx` 需特别确认：`README.md` §4.8.8 称它们"经 bridge 转发给 Python 处理" —— 若确有转发调用（如通过字符串命令名传给 Python 进程），则它们是**运行时依赖而非未用**。以 Step 1 的 grep 结果为准。

- [ ] **Step 2: 逐个删除 + 逐个验证（每次一个包，不要合并）**

对确认无引用的每个包 `P`：

```bash
P=<包名>
npm uninstall "$P"
npm run typecheck || { echo "TYPECHECK 失败，回滚 $P"; npm install "$P" --save-exact; exit 1; }
npm run test:ci  || { echo "测试失败，回滚 $P"; npm install "$P" --save-exact; exit 1; }
node kit/cli.mjs check --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const p1=j.findings.filter(f=>f.rule==='P1');console.log('剩余 P1（未用）:',p1.length)})"
npm run kit:sync
```
Expected: 每个包删完后 `typecheck` 与 `test:ci` 全绿，`P1` 计数递减。**一旦 `typecheck`/`test:ci` 失败 → 立即 `npm install "$P"` 回滚该包，并在 `deps.json` 的 `gates` 段旁记录原因**（该包不是未用，而是被间接消费）。

- [ ] **Step 3: 收尾确认 P1 归零**

Run:
```bash
npm run kit:sync && node kit/cli.mjs check --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('summary',JSON.stringify(j.summary));console.log('P1:',j.findings.filter(f=>f.rule==='P1').length)})"
```
Expected: `P1: 0`。

- [ ] **Step 4: 确认产品可构建（不只是类型通过）**

Run:
```bash
npm run build
```
Expected: `vite build` 成功。产物大小与删依赖前对比（记下 `dist/` 总量）：应**不增大**。

- [ ] **Step 5: 同步 spec 与 README 的不准确描述**

Modify `README.md` §4.8.8：把"9 个声明未用"更新为实际删除后的结果，并**修正其中对 `ws` 的错误描述**（实测 `ws` 在用，见 `electron/` 与 `server/`）。Modify `docs/superpowers/specs/2026-09-19-devkit-design.md` §6.2 的"实测结论"段：把 10 个包标记为已删除 + 删除日期。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json kit/manifest/deps.json README.md docs/superpowers/specs/2026-09-19-devkit-design.md
git commit -m "chore(kit): 删除 10 个未用运行时依赖（B1）

逐个删、逐个跑 typecheck + test:ci 验证（不批量删：删错的代价是功能静默失效）：
@radix-ui/react-collapsible, @radix-ui/react-context-menu, @radix-ui/react-popover,
@radix-ui/react-separator, @tanstack/react-virtual, classic-level, diff, mammoth, nanoid, xlsx
- 顺手修正 README §4.8.8：ws 实测在用（electron/ + server/），原先与 classic-level 并列描述不准确
- 证据口径见 spec §6.2 五类引用证据（防动态 import / 配置文件 / CLI 三类假阳性）"
```

---

## Task 11: 欠账 B2 / B3 —— Python 清单单一真源与双清单对账

**Files:**
- Modify: `scripts/build-embedded-python.mjs:75-110`（包列表改读 `kit/manifest/deps.json`）
- Modify: `kit/manifest/deps.json`（`gates` / `sizes` 保留人工维护段）
- Create: `scripts/python-manifest.test.mjs`
- Modify: `docs/superpowers/specs/2026-09-19-devkit-design.md`（B2/B3 状态）

**Interfaces:**
- Produces：`readEmbeddedPackages({ root }): string[]`（构建脚本与测试共用，保证同源）

- [ ] **Step 1: 写失败测试**

Create `scripts/python-manifest.test.mjs`：

```js
// scripts/python-manifest.test.mjs —— 内嵌 Python 包清单的单一真源（B2/B3）
//
// 为什么需要这个测试：包列表原先硬编码在 scripts/build-embedded-python.mjs 里，
// 于是"构建脚本用哪些包"和"台账记了哪些包"是两份数据 —— 改一处漏一处，
// 而漏的后果是**发出去的应用缺一个包、运行时才炸**（内嵌运行时不可在线补包）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('内嵌包清单的真源是 kit/manifest/deps.json#python.embedded', () => {
  const deps = JSON.parse(readFileSync(join(ROOT, 'kit/manifest/deps.json'), 'utf8'))
  assert.equal(deps.domains['python-embedded'].source, 'kit/manifest/deps.json#python.embedded')
  assert.ok(Array.isArray(deps.python.embedded) && deps.python.embedded.length > 0)
})

test('构建脚本不含硬编码包列表（必须读台账）', () => {
  const src = readFileSync(join(ROOT, 'scripts/build-embedded-python.mjs'), 'utf8')
  assert.match(src, /deps\.json/, '构建脚本必须从 kit/manifest/deps.json 读包清单')
  assert.match(src, /python\s*\.\s*embedded|embedded/, '必须读取 python.embedded 字段')
  // 反例：原先那种 `'openpyxl', 'python-docx', ...` 的裸列表不得再出现
  assert.equal(/const\s+PACKAGES\s*=\s*\[/.test(src), false, '不得再保留硬编码 PACKAGES 数组')
})

test('两套 Python 清单的差集可解释（内嵌 ⊆ 技能侧 或 逐项有说明）', () => {
  const deps = JSON.parse(readFileSync(join(ROOT, 'kit/manifest/deps.json'), 'utf8'))
  const emb = new Set(deps.python.embedded.map((n) => n.toLowerCase().replace(/_/g, '-')))
  const sk = new Set(deps.domains['python-skills'].packages.map((p) => p.name.toLowerCase().replace(/_/g, '-')))
  const onlyEmbedded = [...emb].filter((n) => !sk.has(n))
  // 仅内嵌（技能侧没写）的包必须逐项列在 deps.notes.pythonOnlyEmbedded 里说明原因
  const documented = new Set((deps.notes?.pythonOnlyEmbedded || []).map((x) => x.name.toLowerCase().replace(/_/g, '-')))
  for (const n of onlyEmbedded) {
    assert.ok(documented.has(n), `内嵌独有包 ${n} 未在 deps.notes.pythonOnlyEmbedded 中说明原因`)
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test scripts/python-manifest.test.mjs`
Expected: FAIL（`构建脚本必须从 kit/manifest/deps.json 读包清单` 断言不成立）。

- [ ] **Step 3: 改构建脚本读台账**

Modify `scripts/build-embedded-python.mjs` —— 把硬编码的包列表（`const PACKAGES = [...]`，约 `:82`）替换为：

```js
// 内嵌 Python 包清单的**单一真源**是 kit/manifest/deps.json#python.embedded。
// 原先这里硬编码一份列表，于是"构建脚本用哪些包"与"台账记哪些包"是两份数据，
// 改一处漏一处 —— 漏的后果是发出去的应用缺包、运行时才炸（内嵌运行时无法在线补包）。
const DEPS_LEDGER = join(ROOT, 'kit', 'manifest', 'deps.json')
function readEmbeddedPackages() {
  const deps = JSON.parse(readFileSync(DEPS_LEDGER, 'utf8'))
  const list = deps?.python?.embedded
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`未在 ${DEPS_LEDGER} 的 python.embedded 找到内嵌包清单（B2：真源已移到台账）`)
  }
  return list
}
const PACKAGES = readEmbeddedPackages()
```

（`ROOT` 已在该文件中定义；若变量名不同，按文件现状对齐。`readFileSync`/`join` 若未 import，从 `node:fs` / `node:path` 补上。）

- [ ] **Step 4: 给 `deps.json` 补 `notes.pythonOnlyEmbedded`（B3 的对账落地）**

在 `kit/manifest/deps.json` 顶层加 `notes` 段（人工维护，`sync` 会保留 —— 若 `syncDeps` 会覆盖它，则在 `syncDeps` 里加 `notes: prev.notes || {}` 保留）：

```jsonc
"notes": {
  "pythonOnlyEmbedded": [
    { "name": "pypdfium2", "reason": "仅内嵌用它做 PDF 光栅化；技能侧脚本走 PyMuPDF/OCR 路径，不需要它" }
  ],
  "pythonOnlySkills": [
    { "name": "pdfplumber", "reason": "技能侧可选增强（表格抽取），不进分发态最小集" }
  ]
}
```

> **实施要求**：上面的内容只是**格式示例**。必须由 Step 5 的实测差集**逐项生成**，每条 `reason` 都要指向真实调用点（`git grep` 出文件名）。**不允许照抄示例**。

- [ ] **Step 5: 实测差集并逐项写 reason**

Run:
```bash
node -e "import('./kit/lib/ledger.mjs').then(m=>{const r=m.syncDeps({root:process.cwd()});const d=r.data;const emb=d.python.embedded.map(n=>n.toLowerCase().replace(/_/g,'-'));const sk=d.domains['python-skills'].packages.map(p=>p.name.toLowerCase().replace(/_/g,'-'));console.log('仅内嵌:',emb.filter(n=>!sk.includes(n)).join(', ')||'(无)');console.log('仅技能:',sk.filter(n=>!emb.includes(n)).join(', ')||'(无)')})"
for n in $(node -e "import('./kit/lib/ledger.mjs').then(m=>{const d=m.readDeps({root:process.cwd()});console.log(d.domains['python-skills'].packages.map(p=>p.name).join(' '))})" 2>/dev/null); do echo "--- $n"; git grep -l "$n" -- public/sample-skills '_common' 2>/dev/null | head -3; done
```
Expected: 两个差集列表；对每个包都能找到真实调用点（用于写 `reason`）。

- [ ] **Step 6: 验证构建脚本行为不变**

Run:
```bash
node --test scripts/python-manifest.test.mjs
node scripts/build-embedded-python.mjs --dry-run 2>&1 | head -20 || node -e "import('./kit/lib/ledger.mjs').then(m=>console.log('包数:',m.readDeps({root:process.cwd()}).python.embedded.length))"
```
Expected: 测试 3 个全绿；包数与改动前**完全一致**（真源搬家不改行为）。

- [ ] **Step 7: Commit**

```bash
git add scripts/build-embedded-python.mjs scripts/python-manifest.test.mjs kit/manifest/deps.json docs/superpowers/specs/2026-09-19-devkit-design.md
git commit -m "refactor(kit): 内嵌 Python 包清单单一真源 + 双清单对账（B2/B3）

- B2：包列表从 scripts/build-embedded-python.mjs 硬编码移到 kit/manifest/deps.json#python.embedded
  漏加的后果是"发出去的应用缺包、运行时才炸"（内嵌运行时无法在线补包）→ 必须单一真源
- B3：两套 Python 清单差集逐项写入 deps.notes（每条 reason 指向真实调用点）
- 新增 scripts/python-manifest.test.mjs 守真源（含"不得再出现硬编码 PACKAGES"反例断言）
- 实测：包清单与改动前完全一致（真源搬家不改行为）"
```

---

## Task 12: 欠账 C1 / C2 / C3 —— 门禁孤岛与构建入口

**Files:**
- Modify: `docs/_anchors.json`（`anchors:write` 同步，C1）
- Modify: `package.json`（C2 的 verify 挂载 + C3 的构建脚本 npm script）
- Modify: `kit/manifest/deps.json`（`gates` 段登记分类结果）
- Modify: `docs/ci.md`（新增"手动门禁"清单）

- [ ] **Step 1: C1 —— 同步锚点计数**

Run:
```bash
npm run anchors:write && node scripts/check-doc-anchors.mjs
node -e "const a=require('./docs/_anchors.json');console.log('testTotal',a.testTotal,JSON.stringify(a.testFileCounts))"
```
Expected: `check-doc-anchors` 退出码 0；`testTotal` 与 `npm run test:preflight` 的分层计数**逐层相等**（C1 的 407 vs 408 已消除，且 kit 层已计入）。

- [ ] **Step 2: C2 —— 逐个判定 11 个 `verify-*.mjs` 能否进 CI（禁止凭印象分类）**

对每个脚本执行：

```bash
for f in scripts/verify-*.mjs; do
  echo "=== $f"
  grep -nE "electron|BrowserWindow|app\.whenReady|spawn|kernel-dist|playwright|screenshot|dialog" "$f" | head -5
done
```
判定规则（**每条都要给出一句话依据**）：
- 命中 `electron` / `BrowserWindow` / `app.whenReady` / `playwright` / `screenshot` / `dialog` → **manual**（需图形会话或 Electron 真二进制）
- 仅用 `node:fs` / `node:child_process`（无 GUI、无 Electron）→ **ci**

把结果写入 `kit/manifest/deps.json` 的 `gates` 段：

```jsonc
"gates": {
  "ci": ["verify-highrisk", "verify-s4-security", "verify-milestones-start"],
  "manual": [
    { "script": "verify-gui-fidelity", "reason": "需要 Electron 真二进制 + 图形会话（截图比对，无法在无头 CI 稳定复现）" }
  ]
}
```

> 上面的 `ci`/`manual` 内容**必须由 Step 2 的实测输出决定**，不要照抄。每条 `manual` 的 `reason` 必须引用该文件里的具体行（如 `scripts/verify-gui-fidelity.mjs:42 的 BrowserWindow`）。

- [ ] **Step 3: C2 —— 挂载到 npm script**

Modify `package.json` 的 `scripts`，按判定结果追加：

```jsonc
// ① CI 可跑的：并入 test:ci
"test:ci": "npm run test:preflight && node scripts/check-doc-anchors.mjs && npm run kit:check && npm run test:unit && npm run test:server && npm run test:kernel && npm run verify:ci",
"verify:ci": "node scripts/verify-highrisk.mjs && node scripts/verify-s4-security.mjs",
// ② 需图形会话/真内核的：独立可执行入口（人工按需跑）
"verify:gui": "node scripts/verify-gui-fidelity.mjs",
"verify:knowledge-gui": "node scripts/verify-knowledge-gui.mjs",
"verify:knowledge-import-gui": "node scripts/verify-knowledge-import-gui.mjs",
"verify:package-assets": "node scripts/verify-package-assets.mjs",
"verify:permission-flow": "node scripts/verify-permission-flow.mjs",
"verify:portable-layout": "node scripts/verify-portable-layout.mjs",
"verify:skill-listing": "node scripts/verify-skill-listing.mjs",
"verify:experience-inject": "node scripts/verify-experience-inject.mjs",
"verify:milestones-start": "node scripts/verify-milestones-start.mjs",
```

> 实际映射以 Step 2 判定为准；**11 个脚本每一个都必须能被 `npm run` 发现**（G7 要求无"已尝试"项）。

- [ ] **Step 4: C3 —— 给构建/校验脚本补 npm script**

Modify `package.json` 的 `scripts`：

```jsonc
"build:kernel": "node scripts/build-kernel.mjs",
"build:python": "node scripts/build-embedded-python.mjs",
"build:installer": "node scripts/build-installer.mjs",
"build:portable": "node scripts/package-portable.mjs",
"skills:sync": "node scripts/sync-builtin-skills.mjs",
"version:bump": "node scripts/bump-version.mjs",
```

- [ ] **Step 5: 全量验证门禁（这是 C4 升级后的第一次真检验）**

Run:
```bash
npm run test:preflight
node scripts/check-doc-anchors.mjs
npm run kit:check
npm run typecheck
```
Expected: 全部退出码 0（V7 已在 Task 9 修完；若仍有红，逐条按 `hint` 处理，**不要往基线里塞**）。

- [ ] **Step 6: Modify `docs/ci.md` —— 新增"手动门禁"一节**

在 `docs/ci.md` 追加：

```markdown
## 手动门禁（不在 CI 自动跑，需图形会话或真内核）

以下门禁由 `npm run` 手动触发，理由逐条登记在 `kit/manifest/deps.json` 的 `gates.manual`：

| 命令 | 依赖 | 为什么不能进 CI |
|---|---|---|
| `npm run verify:gui` | Electron 真二进制 + 图形会话 | 截图比对无法在无头环境稳定复现 |

> 新增手动门禁时，必须在 `gates.manual` 里补一条 `reason`，并指明具体行（如 `verify-gui-fidelity.mjs:42`）。
> 「因为麻烦所以放手动」不是理由 —— 判据是**环境依赖**，不是工作量。
```

（表格内容以 Step 2 实测为准。）

- [ ] **Step 7: Commit**

```bash
git add package.json docs/_anchors.json docs/ci.md kit/manifest/deps.json
git commit -m "chore(kit): 消除门禁孤岛与构建入口缺口（C1/C2/C3）

- C1：anchors:write 同步分层计数（原 407 vs 已跟踪 408，kernel-tests 差 1）
- C2：11 个 verify-*.mjs 逐个判定并入编：CI 可跑的进 test:ci，
  需图形会话/真二进制的挂独立 npm script 并在 deps.json#gates.manual 登记 reason
- C3：build-kernel/build-embedded-python/build-installer/package-portable/
  sync-builtin-skills/bump-version 六个脚本补 npm script（原先无任何入口）
- docs/ci.md 新增'手动门禁'一节：判据是环境依赖，不是工作量"
```

---

## Task 13: 欠账 A1 + 调试版渠道身份（`stamp`）

**⚠️ A1 是写仓库操作（打 tag）。执行前必须单独获得用户批准。**

**Files:**
- Create: `kit/lib/stamp.mjs`
- Create: `kit/lib/stamp.test.mjs`
- Modify: `docs/superpowers/specs/2026-09-19-devkit-design.md`（A1 状态）

**Interfaces:**
- Produces：`stampChannel({ root, now? }): { stampFile, channel, appVersion, kernelVersion, guiVersion, commit, commitSubject, dirty: {tracked, untracked}, ahead, builtAt, artifacts: Array<{path, sha256, bytes}> }`

- [ ] **Step 1: 写失败测试**

Create `kit/lib/stamp.test.mjs`：

```js
// kit/lib/stamp.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stampChannel } from './stamp.mjs'
import { readVersions } from './ledger.mjs'

const ROOT = join(import.meta.dirname, '..', '..')

test('stampChannel：字段完整、可 JSON 序列化', () => {
  const info = stampChannel({ root: ROOT, write: false })
  for (const k of ['channel', 'appVersion', 'kernelVersion', 'guiVersion', 'commit', 'builtAt']) {
    assert.ok(info[k] !== undefined, `缺字段 ${k}`)
  }
  assert.equal(info.channel, 'dev')
  assert.equal(typeof info.dirty.tracked, 'number')
  assert.equal(typeof info.dirty.untracked, 'number')
  assert.ok(Array.isArray(info.artifacts))
  JSON.parse(JSON.stringify(info))
})

test('stampChannel：appVersion/kernelVersion 取自版本台账（单一真源）', () => {
  const v = readVersions({ root: ROOT })
  const info = stampChannel({ root: ROOT, write: false })
  assert.equal(info.appVersion, v.lines.find((l) => l.id === 'APP_VERSION').value)
  assert.equal(info.kernelVersion, v.lines.find((l) => l.id === 'KERNEL_VERSION').value)
})

test('stampChannel：artifacts 的 sha256 与 bytes 与磁盘实际一致', () => {
  const info = stampChannel({ root: ROOT, write: false })
  for (const a of info.artifacts) {
    assert.equal(a.sha256.length, 64)
    assert.ok(a.bytes > 0)
  }
})

test('stampChannel：产物缺失时记录 missing 而不是崩（未构建也能盖章）', () => {
  const info = stampChannel({ root: mkdtempSync(join(tmpdir(), 'yfw-kit-')), write: false })
  assert.ok(Array.isArray(info.missing))
  assert.equal(info.artifacts.length, 0)
  assert.ok(info.commit === null || typeof info.commit === 'string')
})

test('stampChannel 默认写到 release/YFWorking/kit-stamp.json（local-only，不进 CI 门禁）', () => {
  const info = stampChannel({ root: ROOT, write: false })
  assert.match(info.stampFile.replace(/\\/g, '/'), /release\/YFWorking\/kit-stamp\.json$/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test kit/lib/stamp.test.mjs`
Expected: FAIL —— `Cannot find module '.../stamp.mjs'`

- [ ] **Step 3: 写最小实现**

Create `kit/lib/stamp.mjs`：

```js
// kit/lib/stamp.mjs —— 给 dev 渠道盖章（spec §8）
//
// 调试版**保留不动**（D4）：它是开发基座 + 用户测试通道，docs/待处理清单.md 的每轮循环协议
// 第 8 条就写着"同步到调试版，给用户人工调试"。本模块只做一件事：让"用户正在测的这版
// 对应哪个 commit、含哪些产物、是否 dirty"永远可回答 —— 现在这个问题无法回答。
// 产物落在 release/（.gitignore 覆盖）→ local-only，**不进 CI 门禁**（干净克隆没有 release/）。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { readVersions } from './ledger.mjs'

const DEFAULT_ARTIFACTS = ['dist', 'kernel-dist']

function git({ root, args }) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim() } catch { return null }
}

function collectFiles({ root, rel }) {
  const abs = join(root, rel)
  if (!existsSync(abs)) return { files: [], missing: true }
  const st = statSync(abs)
  if (st.isFile()) return { files: [rel], missing: false }
  const out = []
  const walk = (d) => {
    for (const e of readFileSync ? require('node:fs').readdirSync(join(root, d), { withFileTypes: true }) : []) {
      const r = `${d}/${e.name}`
      if (e.isDirectory()) walk(r)
      else out.push(r)
    }
  }
  walk(rel)
  return { files: out, missing: false }
}

export function stampChannel({ root, now = new Date(), write = true, artifactRoots = DEFAULT_ARTIFACTS } = {}) {
  const versions = readVersions({ root })
  const line = (id) => versions?.lines?.find((l) => l.id === id)?.value ?? null
  const dirtyRaw = git({ root, args: ['status', '--porcelain'] }) || ''
  const dirtyLines = dirtyRaw ? dirtyRaw.split('\n').filter(Boolean) : []
  const aheadRaw = git({ root, args: ['rev-list', '--count', 'HEAD'] })
  const tagRaw = git({ root, args: ['describe', '--tags', '--abbrev=0'] })
  const ahead = tagRaw ? Number(git({ root, args: ['rev-list', '--count', `${tagRaw}..HEAD`] }) || 0) : Number(aheadRaw || 0)

  const artifacts = []
  const missing = []
  for (const rel of artifactRoots) {
    const { files, missing: isMissing } = collectFiles({ root, rel })
    if (isMissing) { missing.push(rel); continue }
    for (const f of files) {
      const buf = readFileSync(join(root, f))
      artifacts.push({ path: f, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length })
    }
  }

  const info = {
    channel: 'dev',
    appVersion: line('APP_VERSION'),
    kernelVersion: line('KERNEL_VERSION'),
    guiVersion: line('GUI_VERSION'),
    commit: git({ root, args: ['rev-parse', '--short', 'HEAD'] }),
    commitSubject: git({ root, args: ['log', '-1', '--pretty=%s'] }),
    dirty: { tracked: dirtyLines.filter((l) => !l.startsWith('??')).length, untracked: dirtyLines.filter((l) => l.startsWith('??')).length },
    ahead: Number.isNaN(ahead) ? null : ahead,
    builtAt: now.toISOString(),
    artifacts,
    missing,
    stampFile: join(root, 'release', 'YFWorking', 'kit-stamp.json'),
  }
  if (write && info.commit) {
    mkdirSync(dirname(info.stampFile), { recursive: true })
    writeFileSync(info.stampFile, JSON.stringify(info, null, 2) + '\n', 'utf8')
  }
  return info
}
```

> **实施提示**：`collectFiles` 里那行 `readFileSync ? require(...) : []` 是伪代码残留，实施时写成：
> ```js
> import { readdirSync } from 'node:fs'
> // …
> for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
> ```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test kit/lib/stamp.test.mjs`
Expected: PASS（5 个 test，0 fail）。

- [ ] **Step 5: 真跑一次 `stamp`（验证调试版可追溯）**

Run:
```bash
node kit/cli.mjs stamp
ls -l release/YFWorking/kit-stamp.json
node -e "const j=require('./release/YFWorking/kit-stamp.json');console.log('channel',j.channel,'| app',j.appVersion,'| kernel',j.kernelVersion,'| gui',j.guiVersion);console.log('commit',j.commit,j.commitSubject);console.log('dirty',JSON.stringify(j.dirty),'| ahead',j.ahead);console.log('artifacts',j.artifacts.length,'| missing',j.missing.join(', ')||'(无)')"
```
Expected: 文件生成，字段完整，`artifacts` 含 `dist/` 与 `kernel-dist/` 的真实文件（若尚未构建则 `missing` 列出它们 —— 两者都算正常）。

- [ ] **Step 6: A1 —— 打首个 git tag（**需用户单独批准**）**

**先向用户确认**（打 tag 是写仓库操作，且`git tag` 当前为 0 个）：

```bash
git tag --list | wc -l          # 应为 0
git log --oneline -1
```
确认后执行（tag 名与版本台账一致）：

```bash
git tag -a v3.0.0-dev.0 -m "DevKit P0 落地：版本/依赖台账与漂移门禁（首个版本锚点）"
git tag --list
node kit/cli.mjs stamp   # 此时 ahead 应可算出（距该 tag）
```

> **若用户不同意打 tag**：跳过本步，并在 `docs/superpowers/specs/2026-09-19-devkit-design.md` §10 的 A1 行标注"未执行（用户决定）"+ 原因。**不要**用 commit hash 冒充 tag。

- [ ] **Step 7: Commit**

```bash
git add kit/lib/stamp.mjs kit/lib/stamp.test.mjs docs/superpowers/specs/2026-09-19-devkit-design.md
git commit -m "feat(kit): 调试版渠道身份 stamp（A1/A4）+ 首个版本锚点

- 调试版保留不动（D4），只加法：kit/lib/stamp.mjs 产出 release/YFWorking/kit-stamp.json
  字段：channel/appVersion/kernelVersion/guiVersion/commit/dirty/ahead/builtAt/artifacts(+sha256)
  回答的问题：'用户正在测的这版对应哪个 commit、含哪些产物、是否 dirty、差多少提交'
- release/ 为 gitignored → local-only，不进 CI 门禁（干净克隆没有 release/）
- stamp 的版本字段取自台账（单一真源），不重复采集"
```

---

## Task 14: 门禁接入 CI + AI 操作契约

**Files:**
- Create: `kit/README.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/ci.md`
- Modify: `docs/superpowers/specs/2026-09-19-devkit-design.md`（P0 完成标记）

- [ ] **Step 1: 实测 `kit:check` 耗时（G6 的硬约束 < 5s）**

Run:
```bash
for i in 1 2 3; do node -e "const t=Date.now();try{require('child_process').execFileSync(process.execPath,['kit/cli.mjs','check','--json'],{encoding:'utf8'})}catch(e){};console.log('run', Date.now()-t,'ms')"; done
```
Expected: 三次均 **< 5000 ms**。把中位数记下 —— Step 3 要写进 `docs/ci.md`。

> 若超 5s：定位热点（最可能是 `collectEvidence` 对全仓逐文件跑正则 × 65 个依赖 = 65×N 次文件读取）。修法：`syncDeps` 里**先把所有候选文件内容读一次进 Map**，再在其中跑正则（单次 O(N)，而非 O(65N)）。

- [ ] **Step 2: 接入 CI**

Modify `.github/workflows/ci.yml` 的 `test` 作业 —— 在 `npm run typecheck` 之后、`npm run test:ci` 之前插入：

```yaml
      - name: DevKit 台账门禁
        run: npm run kit:check
```

> 为什么单独一步而不是塞进 `test:ci`：台账门禁是**声明一致性**检查（台账 ↔ 宿主文件），
> 与测试层计数口径是两件事；失败时单独一步能让人一眼看出是"台账漂移"而不是"测试挂了"。
> 但 `test:ci` 里**也要**包含它（Task 12 Step 3 已加），以便本地一条命令跑全。

- [ ] **Step 3: Modify `docs/ci.md` —— 新增 DevKit 门禁一节**

```markdown
## DevKit 台账门禁

`npm run kit:check` —— 校验 `kit/manifest/versions.json` 与 `kit/manifest/deps.json` 是否与宿主文件一致。

- **耗时**：实测 <实测中位数> ms（纯文件解析 + `git ls-files`，零网络）
- **退出码**：0 = 无红灯；1 = 有红灯（CI 失败）
- **红灯怎么办**：按 `finding.hint` 操作。**默认动作是修宿主文件或跑 `npm run kit:sync`**，
  **不是**往 `kit/manifest/drift-baseline.json` 里加条目 —— 基线是"已知欠账"，
  条目数受 `versions.json` 的 `history.baselineCount` 护栏限制（超了直接红）。
- **相关命令**：
  | 命令 | 作用 | 是否写文件 |
  |---|---|---|
  | `npm run kit:check` | 门禁（只读） | 否 |
  | `npm run kit:sync` | 重建台账（保留人工字段） | 是 |
  | `npm run kit:view` | 输出台账摘要 JSON（AI 用） | 否 |
  | `npm run kit:stamp` | 给 dev 渠道盖章到 `release/YFWorking/` | 是（local-only） |

- **扫描域**：全部判定基于 `git ls-files`（**已入库**文件），不是磁盘遍历 ——
  `scratch/`、`release/`、`dist/`、`kernel-dist/`、`runtime/` 一律不参与（见 spec 不变量 I2）。
```

- [ ] **Step 4: Create `kit/README.md`（给 AI 的操作契约，结构化而非散文）**

```markdown
# DevKit —— 操作契约

> 本文件是**给 AI 的操作契约**（结构化）。人读 `kit/cli.mjs check --verbose`。
> 设计依据：`docs/superpowers/specs/2026-09-19-devkit-design.md`。

## 何时跑什么

| 场景 | 命令 | 说明 |
|---|---|---|
| 提交前自检 | `npm run kit:check` | 只读。有红灯**不要提交** |
| 改了版本号/常量 | `npm run kit:sync` | 先 sync 再 check |
| 改了 `SKILL.md` | `npm run kit:sync` | 重算 `skills-lock.json`（V7 判据是 lock 文件，不是台账） |
| 新增/删除依赖 | `npm run kit:sync` | 然后看 `check` 的 P1（未用）/ P2（幽灵） |
| 改了 `_common/*.py` | `npm run kit:sync` | 台账会补登记；**新增**脚本必须有 `__version__`（V8′） |
| 同步调试版给用户测 | `npm run kit:stamp` | 产出 `release/YFWorking/kit-stamp.json` |
| 汇报现状给用户 | `npm run kit:view` | 输出固定 schema JSON |

## 读红灯的正确姿势

```
1. npm run kit:view            # 拿 JSON，不解析散文
2. 看 findings[].rule：
   V1  台账值与宿主文件不一致   → 跑 kit:sync（若宿主是对的）或修宿主（若台账是对的）
   V1b 台账键重复              → 修 versions.json（同名常量必须靠 file 区分）
   V2  版本线宿主文件未入库     → 修 versions.json 的 file 字段
   V3  版本历史链断裂          → 补 history.records（版本变更必须留痕）
   V4  内核线映射不符          → 'dev X.Y' 必须对应 'X.Y.0'
   V5  data-schema 缺迁移说明  → 补 migrationNote（无迁移也须显式写明）
   V6  技能版本三方不一致      → 对齐 skills.json 与 SKILL.md frontmatter
   V7  lock 哈希不符           → 跑 kit:sync 重算；不可逆改动则回退 SKILL.md
   V8  台账记了不存在的文件    → 跑 kit:sync
   V8b 实有 .py 未登记         → 跑 kit:sync
   V8' 新增 .py 未自证版本     → 给该脚本加 __version__，或显式登记版本
   P1  依赖零引用证据          → 查五类证据（import/动态 import/配置文件/CLI/types），
                                 确认无用时才删（删错的代价是功能静默失效）
   P2  幽灵依赖                → 补 package.json 声明或改掉 import
   P3  内核域有依赖            → 内核必须零第三方依赖（要能 bun 打成单文件）
   P5  两套 Python 清单差集    → 黄灯，确认差集是否符合预期
   BASE 基线条目超限           → 基线是已知欠账，不是遇红就塞的垃圾桶
```

## 三条铁律

1. **不许手改 `sync` 生成的字段**：`values` / `location` / `evidence` / `sha256` 由 sync 重写；
   可以手改的只有 `exclude` / `note` / `consumers` / `migrationNote` / `manual` 条目 / `history` / `deps.notes` / `deps.gates`。
2. **放行即人工**：`drift-baseline.json` 独立成文件、每条写 `reason`，且条目数不得增加。
3. **扫描域是 `git ls-files`**：写测试或新增文件后记得 `git add`，否则它不在判定范围内。

## 目录

```
kit/cli.mjs              唯一入口：check | sync | view | stamp
kit/lib/scan.mjs         扫描基座（git ls-files 域扫描）
kit/lib/ledger.mjs       台账读写 + syncVersions / syncDeps / syncSkillsLock
kit/lib/version-rules.mjs  V1–V8′
kit/lib/dep-rules.mjs      P1–P6
kit/lib/report.mjs        统一报告 schema
kit/lib/baseline.mjs      漂移基线与数量护栏
kit/lib/stamp.mjs         dev 渠道身份
kit/manifest/*.json       唯一真源（drift-baseline 人工维护）
kit/schema/*.json         台账自身 schema
```
```

- [ ] **Step 5: 验收 —— 逐条核对 spec §13 的 G1–G10**

Run:
```bash
npm run typecheck && npm run test:preflight && node scripts/check-doc-anchors.mjs && npm run kit:check && npm run test:ci
```
Expected: 全部退出码 0。

然后逐条对照 `docs/superpowers/specs/2026-09-19-devkit-design.md` §13 验收表：

| # | 标准 | 对应验证（已在前置任务实测） |
|---|---|---|
| G1 | 台账可解析-回读 | Task 3 Step 6；Task 4 的 V1 正反例 |
| G2 | 每条规则有正反例测试 | Task 4（16 个 test）/ Task 6（7 个 test） |
| G3 | 依赖判定五类证据 | Task 5/6 的 4 个假阳性回归夹具（rcedit / electron-builder / typography / @types） |
| G4 | 扫描域 = `git ls-files` | Task 1 的 scratch 污染隔离测试（含反向证据） |
| G5 | 基线可用且防滥用 | Task 2 的 `baselineGrowth` 测试 + Task 7 的 BASE 规则 |
| G6 | 门禁接入且不拖慢 | Step 1 的实测耗时 + Step 2 的 CI 步骤 |
| G7 | 历史欠账清零 | Task 8–13 逐条 commit |
| G8 | 调试版可追溯 | Task 13 Step 5 |
| G9 | 双通道可用 | `kit view --json` 可解析（Task 7 测试）+ `kit check --verbose` 人话（Task 2 测试） |
| G10 | 无回归 | Step 5 本条命令 |

- [ ] **Step 6: 在 spec §12 标记 P0 完成**

Modify `docs/superpowers/specs/2026-09-19-devkit-design.md` §12 的 P0 行：加 `✅ 已交付（<日期>）` 与实际交付物清单；§10 的 17 条逐条标注状态（**不允许出现"已尝试"** —— 每条要么"✅ 已修 + 实测证据"，要么"⏸ 未执行 + 用户决定 + 原因"）。

- [ ] **Step 7: Commit**

```bash
git add kit/README.md .github/workflows/ci.yml docs/ci.md docs/superpowers/specs/2026-09-19-devkit-design.md
git commit -m "feat(kit): 门禁接入 CI + AI 操作契约（P0 收尾）

- CI test 作业插入 'DevKit 台账门禁' 步骤（typecheck 之后、test:ci 之前）
  单独一步的理由：台账漂移与测试失败是两类问题，失败时一眼可辨；test:ci 内也含它，便于本地一条命令跑全
- kit/README.md：给 AI 的结构化操作契约（何时跑什么 / 红灯规则表 / 三条铁律）
- docs/ci.md 新增 DevKit 门禁一节（含实测耗时、只读/写文件对照表、扫描域说明）
- spec §12/§10 标记 P0 交付与 17 条欠账逐条状态"
```

---

## Self-Review

**1. Spec coverage（逐节核对）**

| spec 节 | 覆盖任务 |
|---|---|
| §3 四条不变量 | I1 → 全篇；I2 → Task 1（含反向证据测试）、Task 5/6；I3 → Task 1；I4 → Task 2 + Task 7 的 BASE 规则 |
| §4 架构（kit/ 目录） | Task 1–7、13（`lib/stamp.mjs` 为 plan 对 spec 的补充，已在此说明） |
| §5.1 台账分区（含新增 `history`） | Task 3 |
| §5.2 条目形状 | Task 3 |
| §5.3 V1–V8′ | Task 4 |
| §5.4 98 个 `.py` 的划界 | Task 3（登记）+ Task 4（V8/V8b/V8′）+ Task 9 |
| §6.1 四域 | Task 5 |
| §6.2 五类证据（★） | Task 5 + Task 6（4 个回归夹具） |
| §6.3 P1–P6 | Task 6 |
| §7.1 测试层接入 + C4 | Task 1 |
| §7.2 CI 接入 + <5s | Task 1（`kit:*` 脚本）+ Task 14 |
| §7.3 漂移基线 | Task 2 + Task 7 |
| §8 调试版渠道身份 | Task 13 |
| §9 双通道 + 统一 report schema | Task 2 + Task 7 + Task 14 |
| §10 A1–A7 / B1–B3 / C1–C4 | Task 8（A2/A3/A5）、Task 9（A6/A7）、Task 10（B1）、Task 11（B2/B3）、Task 12（C1/C2/C3）、Task 13（A1/A4）、Task 1（C4） |
| §11 风险 | 各任务 Step 内的风险提示（B1 逐个删、V7 防自证、E 类假阳性、扫描域污染） |
| §12 分期 | 仅 P0（P1–P4 另出计划，spec 已声明） |
| §13 G1–G10 | Task 14 Step 5 |
| §14 文件清单 | File Structure 表逐行对应 |

**缺口（已识别并说明）**：
- spec §14 未列 `kit/lib/stamp.mjs` / `kit/lib/stamp.test.mjs` / `kit/cli.test.mjs` / `kit/lib/dep-rules.test.mjs` 等测试文件 —— 本计划 File Structure 表已补，实施时同步回写 spec §14。
- spec §10 的 **A4**（14 处版本常量纳入台账）由 Task 3 的 `contracts` 分区完成，但它未作为独立"修复步骤"出现在 Task 8–13 里 —— 已在 Task 3 Step 5/6 的实测中覆盖（`contracts 14` + V1 全绿）。spec §10 A4 行需在 Task 14 Step 6 一并标记。

**2. Placeholder scan**：无 `TBD` / `TODO` / "类似 Task N" / "适当处理错误"。Task 11 Step 4 的 `notes` 内容明确标注为"格式示例，必须由 Step 5 实测逐项生成，不允许照抄"；Task 12 Step 2 的 `gates` 内容同样标注"必须由实测决定"。这两处是**刻意的**（避免我预填错误结论），并给了生成方法。

**3. Type consistency（跨任务签名核对）**

| 符号 | 定义于 | 使用于 | 一致 |
|---|---|---|---|
| `trackedFiles({root,gitBin?,exec?})` | Task 1 | Task 3/5/6/7 | ✓ |
| `codeFiles(files,{includeTests})` | Task 1 | Task 3/5 | ✓ |
| `readTracked({root,file})` | Task 1 | Task 3/5 | ✓ |
| `CONFIG_FILES` | Task 1 | Task 5 | ✓ |
| `finding({rule,severity,subject,…})` | Task 2 | Task 4/6/7 | ✓ |
| `checkResult({rule,title,evaluated,passed})` | Task 2 | Task 4/6 | ✓ |
| `makeReport({checks,findings,generatedAt})` | Task 2 | Task 7 | ✓ |
| `keyOf({rule,subject})` | Task 2 | Task 7（经 `applyBaseline`） | ✓ |
| `parseByLocator({root,file,locator})` | Task 3 | Task 4 | ✓ |
| `keyOfVersion(entry)` | Task 3 | Task 4/8 | ✓ |
| `syncVersions({root,files?,dryRun?})` | Task 3 | Task 7/8 | ✓ |
| `sha256File({root,file})` | Task 3 | Task 4/9 | ✓ |
| `SKILLS_DIR` / `SKILLS_JSON` / `COMMON_DIR` | Task 3 | Task 4/9 | ✓ |
| `syncSkillsLock({root,files?,dryRun?})` | Task 9 | —（CLI 未调；测试直调） | ⚠ 见下 |
| `collectEvidence({root,files,dep,includeTests?})` | Task 5 | Task 6? （Task 6 只用 `ghost` 参数） | ✓ |
| `syncDeps({root,files?,sizes?})` | Task 5 | Task 7/11 | ✓ |
| `runVersionRules({root,versions,files?})` | Task 4 | Task 7 | ✓ |
| `runDepRules({root,deps,ghost?})` | Task 6 | Task 7 | ✓ |
| `stampChannel({root,now?,write?,artifactRoots?})` | Task 13 | Task 7 的 `stamp` 分支 | ✓ |
| `versions.skillsLock = {source,field,ids}` | Task 3 | Task 4（V7 读 `field`）/ Task 7（`ids.length`） | ✓ |

**⚠ 已修正的不一致（已直接改入正文，此处仅记录）**：`syncSkillsLock` 原先未被 `kit/cli.mjs sync` 调用 → 已在 Task 7 Step 3 的 `sync` 分支补上 `const lock = …` 与 `skills-lock: updated/unchanged/missing` 输出，并在 import 行留了 Task 9 的替换注记。**执行时只需在 Task 9 Step 3 完成后把那一行换成真实调用**：

```js
const lock = syncSkillsLock({ root: ROOT, dryRun: dry })
```

**执行顺序提示**：Task 7 先于 Task 9 实施，因此 Task 7 写下的 `syncSkillsLock` 位置在那一时刻还不存在（仍是占位 `{ updated: [], unchanged: [], missing: [] }`）—— 这是刻意的，让 Task 7 的测试能独立通过。若嫌易忘，可把 Task 9 挪到 Task 7 之前（Task 9 只依赖 Task 3，依赖关系允许）。

---

## 附：任务依赖图与并行建议

```
Task 1 ─→ Task 2 ─→ Task 3 ─→ Task 4 ─┐
                        │              ├─→ Task 7 ─→ Task 13 ─┐
                        ├─→ Task 5 ─→ Task 6 ─┘               ├─→ Task 14
                        └─→ Task 9（依赖 3）                    │
Task 8（依赖 3）  Task 10（依赖 5）  Task 11（依赖 5）  Task 12（依赖 1,9）┘
```

- **可并行**：Task 8 / 10 / 11 与 Task 1–7 主干无依赖冲突（各自改不同文件），但 Task 10 会改 `package.json`，与 Task 1/12 同文件 —— **建议串行**以避免冲突。
- **必须串行**：1 → 2 → 3 → 4/5 → 6 → 7 → 13/14。
- **每完成一个任务立即 commit**：`git ls-files` 是扫描域，未提交的新测试文件不计入分层计数。
