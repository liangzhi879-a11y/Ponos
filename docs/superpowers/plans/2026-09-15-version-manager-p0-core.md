# 版本管理器 P0（核心引擎 + CLI）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可用的版本快照核心引擎与命令行工具：能在任意 git 仓库中创建「捕获未提交改动」的影子引用快照、对比差异、软/全量回退（带回退前强制保护快照）、按保留策略清理，并提供版本号提升脚本。

**Architecture:** `server/version-store.mjs` 为唯一核心（纯 git plumbing，零 bridge 依赖，`exec` 可注入以便单测）；`scripts/yfw-version.mjs` 为 agent 侧 CLI；`scripts/bump-version.mjs` 补齐 `version.mjs` 与 `knowledge-routes.mjs:291` 两处文档已声明但缺失的脚本。本计划为 P0，完成即「命令行可用且有测试保障」；P1（HTTP 路由 + GUI 面板）、P2（自动触发）、P3（清理归档 UI + agent 技能）另出独立计划。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:child_process.execFileSync`、`node:test` + `node:assert/strict`、git plumbing（`add`/`write-tree`/`commit-tree`/`update-ref`/`for-each-ref`/`diff --numstat`/`checkout`）

## Global Constraints

以下约束来自设计文档 `docs/superpowers/specs/2026-09-15-version-manager-design.md`，每个任务都隐含适用：

- **只写 `refs/yfw/snap/*`**；绝不使用 `git reset --hard`、`git clean -fd`，绝不自动执行 `git gc`。
- **临时索引必须位于仓库之外**（`os.tmpdir()`）。实测确认：放仓库内会被 `git add -A` 自己捕获（快照中出现 `.tmpidx.lock`）。
- **读取 ref 用 `%(refname)` 不用 `%(refname:short)`**。实测：`%(refname:short)` 输出 `yfw/snap/x`（剥掉 `refs/` 前缀），拼接必然出错。
- **git 身份兜底必须有**。实测：无 `user.email` 配置时 `commit-tree` 报 `fatal: empty ident name (for <>) not allowed`。
- **破坏性操作必须 dry-run 优先**：CLI 的 `restore` / `prune` 无 `--yes` 时只打印将执行的动作。
- **回退前强制创建 `pre-restore` 保护快照**，不可配置关闭。
- `manual` / `archive` / `pre-restore` 三类快照**永不自动删除**。
- 快照 ref 前缀常量：`refs/yfw/snap/`；消息头常量：`yfw-snap v1`。
- 测试命令：`npm test`（即 `node --test --test-timeout=300000 "shared/**/*.test.mjs" "server/*.test.mjs" ...`）。跑单个文件：`node --test server/version-store.test.mjs`。
- 测试风格：`import { test } from 'node:test'` + `import assert from 'node:assert/strict'`，fixture 用 `mkdtempSync(join(tmpdir(), ...))`（先例：`server/logs-routes.test.mjs`、`server/log-policy.test.mjs`）。

---

## File Structure

| 文件 | 职责 | 本计划任务 |
|---|---|---|
| `server/version-store.mjs`（新增） | 核心：消息编解码、快照创建、列表、差异、回退、清理规划 | Task 1–5 |
| `server/version-store.test.mjs`（新增） | 上述核心的单测（真实临时 git 仓库） | Task 1–5 |
| `scripts/yfw-version.mjs`（新增） | CLI（agent 经 Bash 调用），`--json` 机器可读 | Task 6 |
| `scripts/yfw-version.test.mjs`（新增） | CLI 端到端（spawn node） | Task 6 |
| `scripts/bump-version.mjs`（新增） | 版本号提升 + 漂移检查 + 测试期望值同步 | Task 7 |
| `scripts/bump-version.test.mjs`（新增） | 上述纯函数与 CLI 单测 | Task 7 |

**不改动任何既有文件**。`server/bridge.mjs` 的接入属 P1/P2。

**任务依赖**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6；Task 7 与 Task 1–6 相互独立，可并行。

---

### Task 1: 快照消息编解码与列表

**Files:**
- Create: `server/version-store.mjs`
- Test: `server/version-store.test.mjs`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - 常量：`SNAP_REF_PREFIX`（`'refs/yfw/snap/'`）、`SNAP_MSG_HEADER`（`'yfw-snap v1'`）、`SNAPSHOT_KINDS`、`PROTECTED_KINDS`、`DEFAULT_RETENTION`、`MAX_SNAPSHOT_FILES`、`MAX_SNAPSHOT_BYTES`、`EMPTY_TREE`
  - `encodeSnapshotMessage(meta: object): string`
  - `decodeSnapshotMessage(text: string): SnapshotMeta | null`，`SnapshotMeta = { name, kind, at, branch, session, milestone, files, note }`（全部为 string，缺省 `''`）
  - `isGitRepo({ repoPath, exec }): boolean`
  - `currentBranch({ repoPath, exec }): string`（detached 返回 `'(detached)'`）
  - `listSnapshots({ repoPath, exec }): Snapshot[]`，`Snapshot = SnapshotMeta & { ref, sha }`，按 `at` 降序
  - `isoWithOffset(d?: Date): string`
  - `defaultGitExec(args: string[], { repoPath, env }): string`
  - `run`/`tryRun` 内部辅助不在导出契约内

- [ ] **Step 1: 写失败的测试**

创建 `server/version-store.test.mjs`：

```js
// 版本快照核心：消息编解码 / 列表（真实临时 git 仓库，不 mock git）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SNAP_REF_PREFIX, SNAP_MSG_HEADER, encodeSnapshotMessage, decodeSnapshotMessage,
  isGitRepo, currentBranch, listSnapshots, isoWithOffset,
} from './version-store.mjs'

/** 建一个临时 git 仓库（含身份配置，避免 commit-tree 因缺 ident 失败） */
export function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-ver-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  if (t) t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, git }
}

test('isoWithOffset 带时区偏移且可被 Date 解析', () => {
  const s = isoWithOffset(new Date(2026, 8, 15, 10, 32, 11))
  assert.match(s, /^2026-09-15T10:32:11[+-]\d{2}:\d{2}$/)
  assert.ok(!Number.isNaN(Date.parse(s)))
})

test('快照消息编解码往返一致（多行 note + 非 ASCII 名）', () => {
  const meta = {
    name: '里程碑1-完成', kind: 'milestone', at: '2026-09-15T10:32:11+08:00',
    branch: 'feature/x', session: 'sess-1', milestone: '1/3',
    files: '12  +340  -88', note: '第一行\n第二行\n\n第四行',
  }
  const back = decodeSnapshotMessage(encodeSnapshotMessage(meta))
  assert.equal(back.name, meta.name)
  assert.equal(back.kind, meta.kind)
  assert.equal(back.at, meta.at)
  assert.equal(back.branch, meta.branch)
  assert.equal(back.session, meta.session)
  assert.equal(back.milestone, meta.milestone)
  assert.equal(back.files, meta.files)
  assert.equal(back.note, meta.note, '多行 note 必须原样还原')
})

test('非快照消息解码为 null', () => {
  assert.equal(decodeSnapshotMessage('普通提交信息'), null)
  assert.equal(decodeSnapshotMessage(''), null)
  assert.equal(decodeSnapshotMessage(null), null)
})

test('空字段不写入消息，解码回空串', () => {
  const text = encodeSnapshotMessage({ name: 'n', kind: 'manual' })
  assert.ok(!/session:/.test(text))
  const back = decodeSnapshotMessage(text)
  assert.equal(back.session, '')
  assert.equal(back.note, '')
})

test('isGitRepo 区分 git 与非 git 目录', (t) => {
  const { dir } = makeRepo(t)
  assert.equal(isGitRepo({ repoPath: dir }), true)
  const plain = mkdtempSync(join(tmpdir(), 'yfw-plain-'))
  t.after(() => rmSync(plain, { recursive: true, force: true }))
  assert.equal(isGitRepo({ repoPath: plain }), false)
})

test('currentBranch 返回分支名，detached 时返回 (detached)', (t) => {
  const { dir, git } = makeRepo(t)
  assert.equal(currentBranch({ repoPath: dir }), 'main')
  writeFileSync(join(dir, 'a.txt'), 'x\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  git('checkout', '-q', '--detach')
  assert.equal(currentBranch({ repoPath: dir }), '(detached)')
})

test('listSnapshots 空仓库返回空数组', (t) => {
  const { dir } = makeRepo(t)
  assert.deepEqual(listSnapshots({ repoPath: dir }), [])
})

test('listSnapshots 读回 ref/sha/meta，按时间降序且 short 前缀不出错', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'x\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const head = git('rev-parse', 'HEAD').trim()
  const mk = (ref, at, name) => {
    const sha = git('commit-tree', `${head}^{tree}`, '-p', head, '-m', encodeSnapshotMessage({ name, kind: 'manual', at })).trim()
    git('update-ref', SNAP_REF_PREFIX + ref, sha)
    return sha
  }
  const shaOld = mk('20260915-100000-old', '2026-09-15T10:00:00+08:00', '旧')
  const shaNew = mk('20260915-110000-new', '2026-09-15T11:00:00+08:00', '新')
  const list = listSnapshots({ repoPath: dir })
  assert.equal(list.length, 2)
  assert.equal(list[0].name, '新', '按 at 降序，最新的在前')
  assert.equal(list[0].sha, shaNew)
  assert.equal(list[1].sha, shaOld)
  assert.equal(list[0].ref, SNAP_REF_PREFIX + '20260915-110000-new', 'ref 必须是完整引用（含 refs/）')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/version-store.test.mjs`
Expected: FAIL —— `Cannot find module './version-store.mjs'`

- [ ] **Step 3: 写最小实现**

创建 `server/version-store.mjs`：

```js
// server/version-store.mjs —— 版本快照核心（影子引用 refs/yfw/snap/*）
// ---------------------------------------------------------------------------
// 快照 = 写入 refs/yfw/snap/<id> 的**合成提交**，经临时索引捕获当前工作区
// （含未提交改动）。不移动 HEAD、不切分支、不触碰真实 .git/index、不出现在
// `git branch`。元数据全部编码在 commit message 里 → 无需索引文件，不存在
// 缓存失效与并发写一致性问题。列表用单次 `for-each-ref` 取全。
//
// 三条实测约束（改动前务必先读，均有测试兜底）：
//   ① 临时索引必须放**仓库之外**——放仓库内会被 `git add -A` 自己捕获；
//   ② 读 ref 必须用 %(refname)，%(refname:short) 会剥掉 `refs/` 前缀；
//   ③ 无 git 身份配置时 commit-tree 直接失败，必须注入 GIT_AUTHOR/COMMITTER。
//
// exec 可注入（测试用），缺省走 execFileSync —— 参数数组免 shell quoting。
import { execFileSync } from 'node:child_process'

export const SNAP_REF_PREFIX = 'refs/yfw/snap/'
export const SNAP_MSG_HEADER = 'yfw-snap v1'
export const SNAPSHOT_KINDS = ['manual', 'turn', 'milestone', 'threshold', 'precommit', 'archive', 'pre-restore']
// 永不自动删除的三类：手动、归档、回退前保护
export const PROTECTED_KINDS = ['manual', 'archive', 'pre-restore']
export const DEFAULT_RETENTION = 20
export const MAX_SNAPSHOT_FILES = 20000
export const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024
// 公认的空树对象哈希（无 HEAD 时的比较基线）
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const RECORD_SEP = '@@YFWEND@@'
const DEFAULT_IDENT = { name: 'YFWorking Version Manager', email: 'version@yfworking.local' }

/** 缺省 git 执行器：参数数组 + cwd，免 shell quoting（对比 execSync 拼接需转义） */
export function defaultGitExec(args, { repoPath, env } = {}) {
  return execFileSync('git', args, {
    cwd: repoPath,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function run(args, opts = {}) {
  const fn = opts.exec || defaultGitExec
  return fn(args, { repoPath: opts.repoPath, env: opts.env })
}

function tryRun(args, opts = {}) {
  try { return run(args, opts) } catch { return null }
}

export function isGitRepo({ repoPath, exec } = {}) {
  const out = tryRun(['rev-parse', '--is-inside-work-tree'], { repoPath, exec })
  return !!(out && out.trim() === 'true')
}

export function currentBranch({ repoPath, exec } = {}) {
  const b = (tryRun(['rev-parse', '--abbrev-ref', 'HEAD'], { repoPath, exec }) || '').trim()
  return !b || b === 'HEAD' ? '(detached)' : b
}

export function isoWithOffset(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 单行字段顺序固定；空值不写入（解码回 ''）；note 用 YAML 块标量风格 */
export function encodeSnapshotMessage(meta = {}) {
  const lines = [SNAP_MSG_HEADER]
  const put = (k, v) => { if (v !== undefined && v !== null && String(v) !== '') lines.push(`${k}: ${v}`) }
  put('name', meta.name)
  put('kind', meta.kind || 'manual')
  put('at', meta.at)
  put('branch', meta.branch)
  put('session', meta.session)
  put('milestone', meta.milestone)
  put('files', meta.files)
  if (meta.note) {
    lines.push('note: |')
    for (const l of String(meta.note).replace(/\r\n/g, '\n').split('\n')) lines.push(`  ${l}`)
  }
  return lines.join('\n') + '\n'
}

export function decodeSnapshotMessage(text) {
  if (!text) return null
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  if ((lines[0] || '').trim() !== SNAP_MSG_HEADER) return null
  const meta = { name: '', kind: 'manual', at: '', branch: '', session: '', milestone: '', files: '', note: '' }
  const noteLines = []
  let inNote = false
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (inNote) {
      if (line.startsWith('  ')) { noteLines.push(line.slice(2)); continue }
      if (line.trim() === '') { noteLines.push(''); continue }
      inNote = false
    }
    const m = /^([a-z]+):\s?(.*)$/.exec(line)
    if (!m) continue
    const [, key, val] = m
    if (key === 'note') { inNote = true; if (val && val !== '|') noteLines.push(val); continue }
    if (key in meta) meta[key] = val
  }
  meta.note = noteLines.join('\n').replace(/\n+$/, '')
  return meta
}

/** 单次 for-each-ref 取全 ref+sha+完整 message（比 N 次 log 少 N-1 个进程） */
export function listSnapshots({ repoPath, exec } = {}) {
  const fmt = `%(refname)%00%(objectname)%00%(contents)${RECORD_SEP}`
  const out = tryRun(['for-each-ref', SNAP_REF_PREFIX, `--format=${fmt}`], { repoPath, exec })
  if (!out) return []
  const snaps = []
  for (const chunk of out.split(RECORD_SEP)) {
    const rec = chunk.replace(/^\r?\n/, '')
    if (!rec.trim()) continue
    const parts = rec.split('\x00')
    if (parts.length < 3) continue
    const ref = parts[0].trim()
    const sha = parts[1].trim()
    const meta = decodeSnapshotMessage(parts.slice(2).join('\x00'))
    if (!meta) continue
    snaps.push({ ref, sha, ...meta })
  }
  // at 降序；同秒并列时按 ref 降序，保证顺序稳定
  return snaps.sort((a, b) => (a.at === b.at ? (a.ref < b.ref ? 1 : -1) : (a.at < b.at ? 1 : -1)))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/version-store.test.mjs`
Expected: PASS（8 个 test 全绿）

- [ ] **Step 5: 提交**

```bash
git add server/version-store.mjs server/version-store.test.mjs
git commit -m "feat(version-store): 快照消息编解码与列表读取（单次 for-each-ref）"
```

---

### Task 2: 快照创建（临时索引 + 空改动跳过 + 体积护栏）

**Files:**
- Modify: `server/version-store.mjs`（追加）
- Test: `server/version-store.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 的 `SNAP_REF_PREFIX`、`encodeSnapshotMessage`、`isGitRepo`、`currentBranch`、`isoWithOffset`、`EMPTY_TREE`、`run`、`tryRun`、`MAX_SNAPSHOT_FILES`、`MAX_SNAPSHOT_BYTES`
- Produces:
  - `createSnapshot({ repoPath, name?, note?, kind?, session?, milestone?, exec?, now?, tmpRoot?, limits?, gitEnv? }): CreateResult`
  - `CreateResult` 三态：
    - 成功 `{ ok: true, ref, sha, at, branch, kind, name, files, insertions, deletions }`
    - 跳过 `{ ok: true, skipped: true, reason: 'no-changes', branch, at }`
    - 失败 `{ ok: false, error: 'not-a-git-repo' | 'write-tree-failed' | 'commit-tree-failed' | 'too-large', files?, bytes?, maxFiles?, maxBytes? }`
  - `limits` 形如 `{ maxFiles?, maxBytes? }`，缺省用模块常量（**供测试注入小阈值**）
  - `gitEnv`：额外环境变量（合并进 process.env），**供测试隔离 git 身份配置**（如 `GIT_CONFIG_GLOBAL` 指向不存在路径）
  - 内部：`parseNumstat`、`treeSize`、`slugify`、`nextRef`、`defaultName`、`identityEnv`

- [ ] **Step 1: 写失败的测试**

追加到 `server/version-store.test.mjs`：

```js
import { createSnapshot } from './version-store.mjs'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'

test('createSnapshot 捕获未提交改动与未跟踪文件（方案核心价值）', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  writeFileSync(join(dir, 'a.txt'), 'hello\nworld\n')   // 已跟踪文件未提交改动
  writeFileSync(join(dir, 'b.txt'), 'new file\n')       // 未跟踪文件
  const r = createSnapshot({ repoPath: dir, name: '测试快照' })
  assert.equal(r.ok, true)
  assert.equal(r.skipped, undefined)
  assert.equal(r.files, 2, 'a.txt 改动 + b.txt 新增')
  assert.equal(r.kind, 'manual')
  // 快照内容确实含未提交改动——这是方案 A（tag）做不到的核心能力
  const content = execFileSync('git', ['show', `${r.ref}:b.txt`], { cwd: dir, encoding: 'utf8' })
  assert.equal(content, 'new file\n')
  const listed = listSnapshots({ repoPath: dir })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, '测试快照')
  assert.match(listed[0].files, /^2 {2}\+\d+ {2}-\d+$/)
})

test('createSnapshot 不污染真实 index、HEAD 与分支列表', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  writeFileSync(join(dir, 'a.txt'), 'changed\n')
  const statusBefore = git('status', '--porcelain')
  const headBefore = git('rev-parse', 'HEAD')
  const branchesBefore = git('branch', '--format=%(refname:short)')
  createSnapshot({ repoPath: dir })
  assert.equal(git('status', '--porcelain'), statusBefore, '真实 index 不得被改动')
  assert.equal(git('rev-parse', 'HEAD'), headBefore, 'HEAD 不得移动')
  assert.equal(git('branch', '--format=%(refname:short)'), branchesBefore, '不得产生可见分支')
})

test('createSnapshot 空改动跳过（幂等）', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const r = createSnapshot({ repoPath: dir })
  assert.equal(r.ok, true)
  assert.equal(r.skipped, true)
  assert.equal(r.reason, 'no-changes')
  assert.equal(listSnapshots({ repoPath: dir }).length, 0, '跳过的快照不得落 ref')
})

test('createSnapshot 尊重 .gitignore（忽略项不入快照）', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  writeFileSync(join(dir, 'ignored.txt'), 'should not be captured\n')
  const r = createSnapshot({ repoPath: dir })
  assert.equal(r.skipped, true, '仅忽略文件变化 → 视为无改动')
})

test('createSnapshot 在无提交的空仓库可工作（基线用空树）', (t) => {
  const { dir } = makeRepo(t)
  writeFileSync(join(dir, 'first.txt'), 'first\n')
  const r = createSnapshot({ repoPath: dir })
  assert.equal(r.ok, true)
  assert.equal(r.files, 1)
  assert.equal(r.insertions, 1)
})

test('createSnapshot 超限拒绝（files 与 bytes 两条护栏）', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  writeFileSync(join(dir, 'b.txt'), 'x\n')
  writeFileSync(join(dir, 'c.txt'), 'y\n')
  const byFiles = createSnapshot({ repoPath: dir, limits: { maxFiles: 1 } })
  assert.equal(byFiles.ok, false)
  assert.equal(byFiles.error, 'too-large')
  assert.equal(byFiles.maxFiles, 1)
  const byBytes = createSnapshot({ repoPath: dir, limits: { maxBytes: 2 } })
  assert.equal(byBytes.ok, false)
  assert.equal(byBytes.error, 'too-large')
  assert.equal(byBytes.maxBytes, 2)
})

test('createSnapshot 对非 git 目录返回明确错误而非崩溃', (t) => {
  const plain = mkdtempSync(join(tmpdir(), 'yfw-plain-'))
  t.after(() => rmSync(plain, { recursive: true, force: true }))
  const r = createSnapshot({ repoPath: plain })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'not-a-git-repo')
})

test('createSnapshot 同秒多次调用 ref 不冲突（自动加序号）', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), '1\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const at = new Date(2026, 8, 15, 10, 0, 0)
  const r1 = createSnapshot({ repoPath: dir, name: 'same', now: at })
  writeFileSync(join(dir, 'a.txt'), '2\n')
  const r2 = createSnapshot({ repoPath: dir, name: 'same', now: at })
  writeFileSync(join(dir, 'a.txt'), '3\n')
  const r3 = createSnapshot({ repoPath: dir, name: 'same', now: at })
  assert.equal(new Set([r1.ref, r2.ref, r3.ref]).size, 3, '三个 ref 必须互异')
  assert.equal(listSnapshots({ repoPath: dir }).length, 3)
})

test('createSnapshot 无 git 身份配置时仍可创建（身份兜底）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-noident-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 关键：必须把"无身份"的环境**注入 createSnapshot**（gitEnv），否则它读的是
  // 真实全局配置 → 兜底分支根本不会被走到，测试形同虚设。
  const noIdent = {
    GIT_CONFIG_GLOBAL: join(dir, 'nonexistent-gitconfig'),
    GIT_CONFIG_SYSTEM: join(dir, 'nonexistent-gitconfig'),
  }
  const git = (...args) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...noIdent },
  })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'x\n')
  // 前置断言：确认该环境下确实读不到身份，否则测试无意义
  const probed = execFileSync('git', ['config', 'user.email'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...noIdent } })
  assert.equal(probed.trim(), '', '前置条件：该环境下不应有 user.email')
  const r = createSnapshot({ repoPath: dir, gitEnv: noIdent })
  assert.equal(r.ok, true, `应靠身份兜底成功，实际：${JSON.stringify(r)}`)
})

test('createSnapshot 临时索引文件不落在仓库内', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), '1\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  writeFileSync(join(dir, 'a.txt'), '2\n')
  createSnapshot({ repoPath: dir })
  const entries = git('status', '--porcelain', '--untracked-files=all')
  assert.ok(!/tmpidx|veridx/.test(entries), `仓库内不得残留索引文件，实际 status:\n${entries}`)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/version-store.test.mjs`
Expected: FAIL —— `createSnapshot is not a function`（或 `SyntaxError: The requested module does not provide an export named 'createSnapshot'`）

- [ ] **Step 3: 写最小实现**

追加到 `server/version-store.mjs`（同时把 `import { mkdtempSync, rmSync } from 'node:fs'`、`import { tmpdir } from 'node:os'`、`import { join } from 'node:path'` 补到文件顶部 import 区）：

```js
const KIND_LABEL = {
  manual: '手动', turn: '回合', milestone: '里程碑',
  threshold: '大改动', precommit: '提交前', archive: '归档', 'pre-restore': '回退前保护',
}

function defaultName(kind, at) {
  return `${KIND_LABEL[kind] || kind} ${at.slice(0, 19).replace('T', ' ')}`
}

function slugify(label, kind) {
  const s = String(label || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 32)
  return s || kind
}

/** ref id：yyyyMMddHHmmss-<slug>（时区相关字段已由 isoWithOffset 固定为本地时间） */
function refBaseId(at, label, kind) {
  return `${at.slice(0, 19).replace(/[-:T]/g, '')}-${slugify(label, kind)}`
}

function nextRef({ repoPath, exec, at, label, kind }) {
  const id = refBaseId(at, label, kind)
  let candidate = SNAP_REF_PREFIX + id
  let n = 1
  // 上界防御：git 持续报错时不得死循环
  while (n < 50 && tryRun(['rev-parse', '--verify', '--quiet', candidate], { repoPath, exec }) !== null) {
    n++
    candidate = `${SNAP_REF_PREFIX}${id}-${n}`
  }
  return candidate
}

/** 无 user.email 时注入默认身份——实测无身份 commit-tree 会 fatal 失败 */
function identityEnv({ repoPath, exec, gitEnv } = {}) {
  const email = (tryRun(['config', 'user.email'], { repoPath, exec, env: gitEnv }) || '').trim()
  if (email) return {}
  return {
    GIT_AUTHOR_NAME: DEFAULT_IDENT.name, GIT_AUTHOR_EMAIL: DEFAULT_IDENT.email,
    GIT_COMMITTER_NAME: DEFAULT_IDENT.name, GIT_COMMITTER_EMAIL: DEFAULT_IDENT.email,
  }
}

function parseNumstat(out) {
  let files = 0, insertions = 0, deletions = 0
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue
    const [ins, del] = line.split('\t')
    files++
    if (ins !== '-') insertions += Number(ins) || 0   // '-' = 二进制文件，不计行数
    if (del !== '-') deletions += Number(del) || 0
  }
  return { files, insertions, deletions }
}

function treeSize({ repoPath, exec, tree }) {
  const out = tryRun(['ls-tree', '-r', '-l', tree], { repoPath, exec }) || ''
  let bytes = 0, count = 0
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const m = /\s(\d+|-)\t/.exec(line)
    count++
    if (m && m[1] !== '-') bytes += Number(m[1]) || 0
  }
  return { count, bytes }
}

export function createSnapshot({
  repoPath, name = '', note = '', kind = 'manual', session = '', milestone = '',
  exec, now = new Date(), tmpRoot, limits = {}, gitEnv,
} = {}) {
  if (!isGitRepo({ repoPath, exec })) return { ok: false, error: 'not-a-git-repo' }
  const maxFiles = limits.maxFiles ?? MAX_SNAPSHOT_FILES
  const maxBytes = limits.maxBytes ?? MAX_SNAPSHOT_BYTES
  const at = isoWithOffset(now)
  const branch = currentBranch({ repoPath, exec })
  const gitOpts = { repoPath, exec, env: gitEnv }
  const head = ((tryRun(['rev-parse', 'HEAD'], gitOpts) || '').trim()) || null
  const base = head || EMPTY_TREE

  // ① 临时索引必须放仓库之外：放仓库内会被 git add -A 自己捕获（实测确认）
  const idxDir = mkdtempSync(join(tmpRoot || tmpdir(), 'yfw-veridx-'))
  const idxEnv = {
    GIT_INDEX_FILE: join(idxDir, 'index'),
    ...identityEnv({ repoPath, exec, gitEnv }),
  }
  try {
    run(['add', '-A'], { ...gitOpts, env: idxEnv })
    const tree = (run(['write-tree'], { ...gitOpts, env: idxEnv }) || '').trim()
    if (!tree) return { ok: false, error: 'write-tree-failed' }

    const stat = parseNumstat(run(['diff', '--numstat', base, tree], gitOpts))
    if (stat.files === 0) return { ok: true, skipped: true, reason: 'no-changes', branch, at }

    const size = treeSize({ repoPath, exec, tree })
    if (stat.files > maxFiles || size.bytes > maxBytes) {
      return { ok: false, error: 'too-large', files: stat.files, bytes: size.bytes, maxFiles, maxBytes }
    }

    const label = name || defaultName(kind, at)
    const message = encodeSnapshotMessage({
      name: label, kind, at, branch,
      session: session || undefined,
      milestone: milestone || undefined,
      files: `${stat.files}  +${stat.insertions}  -${stat.deletions}`,
      note,
    })
    const args = ['commit-tree', tree]
    if (head) args.push('-p', head)
    args.push('-m', message)
    const sha = (run(args, { ...gitOpts, env: idxEnv }) || '').trim()
    if (!sha) return { ok: false, error: 'commit-tree-failed' }

    const ref = nextRef({ repoPath, exec, at, label, kind })
    run(['update-ref', ref, sha], gitOpts)
    return { ok: true, ref, sha, at, branch, kind, name: label, ...stat }
  } finally {
    rmSync(idxDir, { recursive: true, force: true })   // 异常路径也必须清理
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/version-store.test.mjs`
Expected: PASS（Task 1 的 8 个 + 本任务 10 个 = 18 个全绿）

- [ ] **Step 5: 提交**

```bash
git add server/version-store.mjs server/version-store.test.mjs
git commit -m "feat(version-store): 创建快照（临时索引捕获未提交改动 + 空改动跳过 + 体积护栏）"
```

---

### Task 3: 差异对比

**Files:**
- Modify: `server/version-store.mjs`（追加）
- Test: `server/version-store.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1–2 的 `tryRun`、`run`、`createSnapshot`
- Produces:
  - `diffSnapshots({ repoPath, a, b?, exec }): { ok, files: DiffFile[], totalInsertions, totalDeletions, error? }`，`DiffFile = { path, insertions, deletions, binary }`。**`b` 省略时比较 `a` 与当前工作区**
  - `diffPatch({ repoPath, a, b?, path?, exec, maxBytes? }): string`，`maxBytes` 缺省 200000，超限截断并追加 `\n…（已截断）`

- [ ] **Step 1: 写失败的测试**

追加到 `server/version-store.test.mjs`：

```js
import { diffSnapshots, diffPatch } from './version-store.mjs'

test('diffSnapshots 与工作区比较（b 省略）', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const s1 = createSnapshot({ repoPath: dir, name: '基线' })
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  const d = diffSnapshots({ repoPath: dir, a: s1.ref })
  assert.equal(d.ok, true)
  assert.equal(d.files.length, 1)
  assert.equal(d.files[0].path, 'a.txt')
  assert.equal(d.files[0].insertions, 2)
  assert.equal(d.files[0].deletions, 0)
  assert.equal(d.totalInsertions, 2)
})

test('diffSnapshots 两快照间比较，含新增与删除', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  writeFileSync(join(dir, 'gone.txt'), 'bye\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const s1 = createSnapshot({ repoPath: dir, name: 's1' })
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  git('rm', '-q', 'gone.txt')
  writeFileSync(join(dir, 'c.txt'), 'cc\n')
  const s2 = createSnapshot({ repoPath: dir, name: 's2' })
  const d = diffSnapshots({ repoPath: dir, a: s1.ref, b: s2.ref })
  const paths = d.files.map(f => f.path).sort()
  assert.deepEqual(paths, ['a.txt', 'c.txt', 'gone.txt'])
  assert.equal(d.totalInsertions, 3)   // a.txt +1, c.txt +1(新文件1行) ... 见下断言
  const gone = d.files.find(f => f.path === 'gone.txt')
  assert.equal(gone.deletions, 1)
})

test('diffSnapshots 未知 ref 返回 ok:false 而非抛错', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'x\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const d = diffSnapshots({ repoPath: dir, a: 'refs/yfw/snap/nope', b: 'HEAD' })
  assert.equal(d.ok, false)
  assert.equal(d.error, 'diff-failed')
  assert.deepEqual(d.files, [])
})

test('diffPatch 只输出指定文件的 patch，超限截断', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  writeFileSync(join(dir, 'b.txt'), 'bee\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const s1 = createSnapshot({ repoPath: dir, name: 's1' })
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(dir, 'b.txt'), 'bee\nsee\n')
  const onlyA = diffPatch({ repoPath: dir, a: s1.ref, path: 'a.txt' })
  assert.match(onlyA, /a\/a\.txt/)
  assert.ok(!/b\/b\.txt/.test(onlyA), '未指定文件不得出现在 patch 中')
  const tiny = diffPatch({ repoPath: dir, a: s1.ref, path: 'a.txt', maxBytes: 10 })
  assert.ok(tiny.includes('已截断'))
})
```

> 注：第二个 test 的 `totalInsertions` 精确值取决于 git 对「删除文件」与「新增文件」的计数方式。**Step 3 实现后按实际运行结果修正该断言为正确值**（预期 a.txt +1、c.txt +1、gone.txt 0 = 3）；若 git 计数不同，以实际值为准并保留注释说明。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/version-store.test.mjs`
Expected: FAIL —— 未导出 `diffSnapshots`

- [ ] **Step 3: 写最小实现**

追加到 `server/version-store.mjs`：

```js
/** b 省略 = a 与当前工作区比较（最常用形态："我改了什么"） */
export function diffSnapshots({ repoPath, a, b, exec } = {}) {
  const args = ['diff', '--numstat', a]
  if (b) args.push(b)
  const out = tryRun(args, { repoPath, exec })
  if (out === null) return { ok: false, error: 'diff-failed', files: [], totalInsertions: 0, totalDeletions: 0 }
  const files = []
  let totalInsertions = 0, totalDeletions = 0
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [ins, del, ...rest] = line.split('\t')
    const binary = ins === '-'
    const insertions = binary ? 0 : Number(ins) || 0
    const deletions = binary ? 0 : Number(del) || 0
    files.push({ path: rest.join('\t'), insertions, deletions, binary })
    totalInsertions += insertions
    totalDeletions += deletions
  }
  return { ok: true, files, totalInsertions, totalDeletions }
}

export function diffPatch({ repoPath, a, b, path, exec, maxBytes = 200_000 } = {}) {
  const args = ['diff', '--no-color', a]
  if (b) args.push(b)
  if (path) args.push('--', path)
  const out = tryRun(args, { repoPath, exec })
  if (out === null) return ''
  if (out.length <= maxBytes) return out
  return out.slice(0, maxBytes) + '\n…（已截断）'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/version-store.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/version-store.mjs server/version-store.test.mjs
git commit -m "feat(version-store): 快照差异统计与单文件 patch"
```

---

### Task 4: 回退/恢复（软恢复 + 全量恢复 + 强制保护快照）

**Files:**
- Modify: `server/version-store.mjs`（追加）
- Test: `server/version-store.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1–3 的 `isGitRepo`、`tryRun`、`run`、`createSnapshot`、`SNAP_REF_PREFIX`
- Produces:
  - `restoreSnapshot({ repoPath, ref, paths?, mode?, exec?, now? }): RestoreResult`
  - `RestoreResult`：
    - 成功 `{ ok: true, ref, sha, mode, restored: string[], protectionRef, protectionSkipped }`
    - 失败 `{ ok: false, error: 'not-a-git-repo' | 'bad-ref' | 'paths-required' | 'restore-failed', ref?, message?, protectionRef? }`
  - `mode`：`'soft'`（缺省，仅还原 `paths`）/ `'full'`（**忽略 `paths`**，还原全工作树）
  - **硬约束**：`mode='soft'` 且 `paths` 为空 → 返回 `paths-required`，绝不隐式全量

- [ ] **Step 1: 写失败的测试**

追加到 `server/version-store.test.mjs`：

```js
import { restoreSnapshot } from './version-store.mjs'

test('软恢复只影响指定路径，其他改动保持原样', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'A1\n')
  writeFileSync(join(dir, 'b.txt'), 'B1\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const s1 = createSnapshot({ repoPath: dir, name: '基线' })
  writeFileSync(join(dir, 'a.txt'), 'A2\n')
  writeFileSync(join(dir, 'b.txt'), 'B2\n')
  const r = restoreSnapshot({ repoPath: dir, ref: s1.ref, paths: ['a.txt'] })
  assert.equal(r.ok, true)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A1\n', 'a.txt 应还原')
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'B2\n', 'b.txt 不得被触碰')
})

test('软恢复未给 paths 时拒绝（绝不隐式全量）', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'A1\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const s1 = createSnapshot({ repoPath: dir, name: '基线' })
  writeFileSync(join(dir, 'a.txt'), 'A2\n')
  const r = restoreSnapshot({ repoPath: dir, ref: s1.ref })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'paths-required')
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A2\n', '拒绝时不得改动任何文件')
})

test('全量恢复忽略 paths 并还原整个工作树', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'A1\n')
  writeFileSync(join(dir, 'b.txt'), 'B1\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const s1 = createSnapshot({ repoPath: dir, name: '基线' })
  writeFileSync(join(dir, 'a.txt'), 'A2\n')
  writeFileSync(join(dir, 'b.txt'), 'B2\n')
  const r = restoreSnapshot({ repoPath: dir, ref: s1.ref, mode: 'full', paths: ['a.txt'] })
  assert.equal(r.ok, true)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A1\n')
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'B1\n', 'full 模式必须忽略 paths')
  assert.deepEqual(r.restored, ['.'])
})

test('回退前强制生成 pre-restore 保护快照（不可关闭）', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'A1\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const s1 = createSnapshot({ repoPath: dir, name: '基线' })
  writeFileSync(join(dir, 'a.txt'), 'A2-need-protection\n')
  const r = restoreSnapshot({ repoPath: dir, ref: s1.ref, paths: ['a.txt'] })
  assert.equal(r.ok, true)
  assert.ok(r.protectionRef, '必须返回保护快照 ref')
  const list = listSnapshots({ repoPath: dir })
  const prot = list.find(s => s.kind === 'pre-restore')
  assert.ok(prot, '保护快照必须真实落地')
  assert.equal(prot.ref, r.protectionRef)
  assert.match(prot.note, /回退目标/)
  // 保护快照内容 = 回退前的 A2，使回退可反悔
  assert.equal(execFileSync('git', ['show', `${prot.ref}:a.txt`], { cwd: dir, encoding: 'utf8' }), 'A2-need-protection\n')
})

test('工作区无改动时回退：保护快照跳过但回退照常执行', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'A1\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const s1 = createSnapshot({ repoPath: dir, name: '基线' })
  writeFileSync(join(dir, 'a.txt'), 'A2\n')
  createSnapshot({ repoPath: dir, name: '含A2' })   // 工作区已被快照，当前无未提交改动
  const r = restoreSnapshot({ repoPath: dir, ref: s1.ref, paths: ['a.txt'] })
  assert.equal(r.ok, true)
  assert.equal(r.protectionSkipped, true)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A1\n')
})

test('回退不会删除未跟踪文件（不得使用 clean -fd）', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'A1\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const s1 = createSnapshot({ repoPath: dir, name: '基线' })
  writeFileSync(join(dir, 'brand-new.txt'), 'keep me\n')
  const r = restoreSnapshot({ repoPath: dir, ref: s1.ref, mode: 'full' })
  assert.equal(r.ok, true)
  assert.equal(readFileSync(join(dir, 'brand-new.txt'), 'utf8'), 'keep me\n', '未跟踪文件必须保留')
})

test('非法 ref 返回 bad-ref 且不产生保护快照', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'x\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  const r = restoreSnapshot({ repoPath: dir, ref: 'refs/yfw/snap/does-not-exist', paths: ['a.txt'] })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'bad-ref')
  assert.equal(listSnapshots({ repoPath: dir }).length, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/version-store.test.mjs`
Expected: FAIL —— 未导出 `restoreSnapshot`

- [ ] **Step 3: 写最小实现**

追加到 `server/version-store.mjs`：

```js
/**
 * 回退/恢复。两条不可协商的硬约束：
 *   ① 绝不用 `reset --hard` / `clean -fd`（会毁掉未提交工作且无法追回）
 *      —— 只用 `checkout <sha> -- <paths>`，未跟踪文件天然不受影响；
 *   ② 回退前**强制**创建 pre-restore 保护快照（不可配置关闭），使回退必然可反悔。
 */
export function restoreSnapshot({ repoPath, ref, paths = [], mode = 'soft', exec, now = new Date() } = {}) {
  if (!isGitRepo({ repoPath, exec })) return { ok: false, error: 'not-a-git-repo' }
  const sha = ((tryRun(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { repoPath, exec }) || '')).trim()
  if (!sha) return { ok: false, error: 'bad-ref', ref }
  if (mode !== 'full' && (!Array.isArray(paths) || paths.length === 0)) {
    return { ok: false, error: 'paths-required', ref }
  }

  const protection = createSnapshot({
    repoPath, kind: 'pre-restore', exec, now,
    name: `恢复前保护 → ${ref}`,
    note: `回退目标 ${ref} (${sha})` + (mode === 'full' ? ' · 全量模式' : ` · 路径: ${paths.join(', ')}`),
  })

  try {
    const args = mode === 'full' ? ['checkout', sha, '--', '.'] : ['checkout', sha, '--', ...paths]
    run(args, { repoPath, exec })
  } catch (e) {
    return { ok: false, error: 'restore-failed', ref, message: String(e?.message || e), protectionRef: protection.ref || '' }
  }
  return {
    ok: true, ref, sha, mode,
    restored: mode === 'full' ? ['.'] : paths,
    protectionRef: protection.ref || '',
    protectionSkipped: !!protection.skipped,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/version-store.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/version-store.mjs server/version-store.test.mjs
git commit -m "feat(version-store): 回退/恢复（软恢复 + 全量 + 强制保护快照，拒绝 reset --hard）"
```

---

### Task 5: 清理规划与执行（保留策略 + 保护类型）

**Files:**
- Modify: `server/version-store.mjs`（追加）
- Test: `server/version-store.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1–4 的 `listSnapshots`、`run`、`SNAP_REF_PREFIX`、`PROTECTED_KINDS`、`DEFAULT_RETENTION`
- Produces:
  - `planPrune({ repoPath, retention?, exec? }): { ok, retention, candidates: Snapshot[], groups: PruneGroup[] }`
    - `PruneGroup = { branch, total, auto, keep, drop }`（均为 number，`branch` 为 string）
    - `candidates` = 超出保留额度的**自动类**快照（`PROTECTED_KINDS` 永不出现在其中）
    - 分组依据是快照 message 里的 `branch` 字段；分支已被删除的快照归入 `'(未知分支)'`
  - `pruneSnapshots({ repoPath, refs?, exec? }): { ok, removed: string[], failed: { ref, error }[] }`
    - **只接受 `refs/yfw/snap/` 前缀**，其他 ref（如 `refs/heads/main`）归入 `failed`

- [ ] **Step 1: 写失败的测试**

追加到 `server/version-store.test.mjs`：

```js
import { planPrune, pruneSnapshots } from './version-store.mjs'

/** 造 n 个自动类（turn）快照，每个都有真实改动 */
function seedTurns(dir, git, n) {
  writeFileSync(join(dir, 'a.txt'), 'seed\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, 'a.txt'), `v${i}\n`)
    const r = createSnapshot({ repoPath: dir, kind: 'turn', name: `turn-${i}` })
    assert.equal(r.ok, true, `seedTurns 第 ${i} 个失败：${JSON.stringify(r)}`)
  }
}

test('planPrune 按分支保留最近 N 个自动快照', (t) => {
  const { dir, git } = makeRepo(t)
  seedTurns(dir, git, 5)
  const p = planPrune({ repoPath: dir, retention: 3 })
  assert.equal(p.ok, true)
  assert.equal(p.candidates.length, 2, '5 个自动快照保留 3 → 2 个候选')
  assert.equal(p.groups.length, 1)
  assert.equal(p.groups[0].branch, 'main')
  assert.equal(p.groups[0].total, 5)
  assert.equal(p.groups[0].drop, 2)
  // 候选必须是较旧的（列表按 at 降序，保留前 3 个）
  const kept = listSnapshots({ repoPath: dir }).slice(0, 3).map(s => s.ref)
  for (const c of p.candidates) assert.ok(!kept.includes(c.ref), '候选不得包含被保留项')
})

test('planPrune 永不把 manual/archive/pre-restore 列为候选', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'seed\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  writeFileSync(join(dir, 'a.txt'), 'm\n')
  createSnapshot({ repoPath: dir, kind: 'manual', name: '手动' })
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  createSnapshot({ repoPath: dir, kind: 'archive', name: '归档' })
  writeFileSync(join(dir, 'a.txt'), 'p\n')
  createSnapshot({ repoPath: dir, kind: 'pre-restore', name: '保护' })
  seedTurns(dir, git, 3)
  const p = planPrune({ repoPath: dir, retention: 1 })
  const kinds = p.candidates.map(c => c.kind)
  assert.equal(kinds.length, 2, '3 个 turn 保留 1 → 2 个候选')
  assert.ok(!kinds.includes('manual'))
  assert.ok(!kinds.includes('archive'))
  assert.ok(!kinds.includes('pre-restore'))
})

test('planPrune 分支已删除的自动快照归入未知分支组', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'seed\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  git('checkout', '-q', '-b', 'topic')
  seedTurns(dir, git, 4)
  git('checkout', '-q', 'main')
  git('branch', '-q', '-D', 'topic')
  const p = planPrune({ repoPath: dir, retention: 1 })
  assert.equal(p.groups.length, 1)
  assert.equal(p.groups[0].branch, 'topic', 'branch 字段记录的是创建时分支，不随分支删除而变')
  assert.equal(p.candidates.length, 3)
})

test('pruneSnapshots 只删 refs/yfw/snap/ 下的引用，其他 ref 归 failed', (t) => {
  const { dir, git } = makeRepo(t)
  seedTurns(dir, git, 3)
  const p = planPrune({ repoPath: dir, retention: 1 })
  const refs = [p.candidates[0].ref, 'refs/heads/main']
  const r = pruneSnapshots({ repoPath: dir, refs })
  assert.deepEqual(r.removed, [p.candidates[0].ref])
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].ref, 'refs/heads/main')
  assert.equal(r.failed[0].error, 'bad-ref')
  assert.equal(r.ok, false, '有失败项时 ok 为 false')
  // main 分支必须安然无恙
  assert.ok(git('rev-parse', '--verify', 'main').trim())
})

test('pruneSnapshots 删除后 listSnapshots 不再返回该项', (t) => {
  const { dir, git } = makeRepo(t)
  seedTurns(dir, git, 3)
  const p = planPrune({ repoPath: dir, retention: 1 })
  const before = listSnapshots({ repoPath: dir }).length
  const r = pruneSnapshots({ repoPath: dir, refs: p.candidates.map(c => c.ref) })
  assert.equal(r.ok, true)
  assert.equal(r.removed.length, 2)
  assert.equal(listSnapshots({ repoPath: dir }).length, before - 2)
})

test('pruneSnapshots 对不存在的 ref 归 failed 而非抛错', (t) => {
  const { dir } = makeRepo(t)
  const r = pruneSnapshots({ repoPath: dir, refs: [SNAP_REF_PREFIX + 'not-exist'] })
  assert.equal(r.removed.length, 0)
  assert.equal(r.failed.length, 1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/version-store.test.mjs`
Expected: FAIL —— 未导出 `planPrune`

- [ ] **Step 3: 写最小实现**

追加到 `server/version-store.mjs`：

```js
/**
 * 清理规划（只读，不改动任何东西）。分组依据是 message 里记录的 branch 字段
 * —— 快照 ref 本身不隶属分支；分支已删除者归入「未知分支」组。
 * PROTECTED_KINDS（manual/archive/pre-restore）永不进入候选。
 */
export function planPrune({ repoPath, retention = DEFAULT_RETENTION, exec } = {}) {
  const snaps = listSnapshots({ repoPath, exec })   // 已按 at 降序
  const byBranch = new Map()
  for (const s of snaps) {
    const key = s.branch || '(未知分支)'
    if (!byBranch.has(key)) byBranch.set(key, [])
    byBranch.get(key).push(s)
  }
  const groups = []
  const candidates = []
  for (const [branch, list] of byBranch) {
    const auto = list.filter(s => !PROTECTED_KINDS.includes(s.kind))
    const keep = auto.slice(0, retention)
    const drop = auto.slice(retention)
    candidates.push(...drop)
    groups.push({
      branch, total: list.length, auto: auto.length,
      keep: keep.length, drop: drop.length,
    })
  }
  return { ok: true, retention, candidates, groups }
}

/** 执行删除。只接受 refs/yfw/snap/ 前缀——这是防止误删分支/标签的最后一道闸 */
export function pruneSnapshots({ repoPath, refs = [], exec } = {}) {
  const removed = []
  const failed = []
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.startsWith(SNAP_REF_PREFIX)) {
      failed.push({ ref, error: 'bad-ref' })
      continue
    }
    try {
      run(['update-ref', '-d', ref], { repoPath, exec })
      removed.push(ref)
    } catch (e) {
      failed.push({ ref, error: String(e?.message || e) })
    }
  }
  return { ok: failed.length === 0, removed, failed }
}
```

> 注意：本任务**不做** `git gc`。对象回收由用户在明确知晓时手动执行（设计 §7.4）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/version-store.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/version-store.mjs server/version-store.test.mjs
git commit -m "feat(version-store): 清理规划与执行（保留策略 + 保护类型 + ref 前缀闸）"
```

---

### Task 6: CLI `scripts/yfw-version.mjs`

**Files:**
- Create: `scripts/yfw-version.mjs`
- Test: `scripts/yfw-version.test.mjs`

**Interfaces:**
- Consumes: Task 1–5 的 `createSnapshot`、`listSnapshots`、`diffSnapshots`、`diffPatch`、`restoreSnapshot`、`planPrune`、`pruneSnapshots`、`isGitRepo`、`currentBranch`、`DEFAULT_RETENTION`
- Produces: 可执行 CLI，`runCli(argv, { cwd, log }): number`（返回退出码，可单测）
  - `snap [--name n] [--note t] [--kind k] [--json] [--repo p]`
  - `list [--json] [--limit N] [--repo p]`
  - `diff [<a>] [<b>] [--patch <file>] [--json] [--repo p]`
  - `restore <ref> [--paths a,b] [--mode soft|full] [--yes] [--json] [--repo p]`
  - `prune [--refs r1,r2] [--retention N] [--yes] [--json] [--repo p]`
  - `status [--json] [--repo p]`
  - **无 `--yes` 时 `restore` / `prune` 只打印将执行的动作**（dry-run），退出码 0
  - 退出码约定：成功 0；用法错误 2；操作失败 1

- [ ] **Step 1: 写失败的测试**

创建 `scripts/yfw-version.test.mjs`：

```js
// CLI 端到端：spawn 真实 node 进程（覆盖参数解析 + 退出码 + dry-run 安全语义）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'yfw-version.mjs')

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-cli-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'a.txt'), 'A1\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  if (t) t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, git }
}

/** 跑 CLI；返回 { code, stdout }（非零退出不抛，便于断言退出码） */
function cli(args, { cwd } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || '') }
  }
}

test('snap --json 输出机器可读结果', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'A2\n')
  const r = cli(['snap', '--json', '--name', '测试'], { cwd: dir })
  assert.equal(r.code, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, true)
  assert.match(out.ref, /^refs\/yfw\/snap\//)
  assert.equal(out.files, 1)
})

test('snap 空改动时 skipped 且退出码 0', (t) => {
  const { dir } = makeRepo(t)
  const r = cli(['snap', '--json'], { cwd: dir })
  assert.equal(r.code, 0)
  assert.equal(JSON.parse(r.stdout).skipped, true)
})

test('list 返回时间线，limit 生效', (t) => {
  const { dir, git } = makeRepo(t)
  for (const v of ['A2', 'A3', 'A4']) {
    writeFileSync(join(dir, 'a.txt'), `${v}\n`)
    assert.equal(cli(['snap', '--json', '--name', v], { cwd: dir }).code, 0)
  }
  const all = JSON.parse(cli(['list', '--json'], { cwd: dir }).stdout)
  assert.equal(all.snapshots.length, 3)
  const limited = JSON.parse(cli(['list', '--json', '--limit', '2'], { cwd: dir }).stdout)
  assert.equal(limited.snapshots.length, 2)
})

test('restore 无 --yes 时只 dry-run，不改动文件', (t) => {
  const { dir, git } = makeRepo(t)
  const snap = JSON.parse(cli(['snap', '--json', '--name', '基线'], { cwd: dir }).stdout)
  writeFileSync(join(dir, 'a.txt'), 'A2\n')
  const r = cli(['restore', snap.ref, '--paths', 'a.txt'], { cwd: dir })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /dry-run/i)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A2\n', 'dry-run 不得改动文件')
  const list = JSON.parse(cli(['list', '--json'], { cwd: dir }).stdout)
  assert.equal(list.snapshots.length, 1, 'dry-run 不得产生保护快照')
})

test('restore --yes 真正执行并生成保护快照', (t) => {
  const { dir, git } = makeRepo(t)
  const snap = JSON.parse(cli(['snap', '--json', '--name', '基线'], { cwd: dir }).stdout)
  writeFileSync(join(dir, 'a.txt'), 'A2\n')
  const r = cli(['restore', snap.ref, '--paths', 'a.txt', '--yes', '--json'], { cwd: dir })
  assert.equal(r.code, 0)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A1\n')
  const list = JSON.parse(cli(['list', '--json'], { cwd: dir }).stdout)
  assert.ok(list.snapshots.some(s => s.kind === 'pre-restore'))
})

test('prune 无 --yes 时只列出候选，不删除', (t) => {
  const { dir, git } = makeRepo(t)
  for (const v of ['A2', 'A3', 'A4']) {
    writeFileSync(join(dir, 'a.txt'), `${v}\n`)
    cli(['snap', '--json', '--kind', 'turn'], { cwd: dir })
  }
  const dry = cli(['prune', '--retention', '1'], { cwd: dir })
  assert.equal(dry.code, 0)
  assert.match(dry.stdout, /dry-run/i)
  const list = JSON.parse(cli(['list', '--json'], { cwd: dir }).stdout)
  assert.equal(list.snapshots.length, 3, 'dry-run 不得删除')
})

test('prune --yes --refs 执行删除，且拒绝非快照 ref', (t) => {
  const { dir, git } = makeRepo(t)
  for (const v of ['A2', 'A3']) {
    writeFileSync(join(dir, 'a.txt'), `${v}\n`)
    cli(['snap', '--json', '--kind', 'turn'], { cwd: dir })
  }
  const cands = JSON.parse(cli(['prune', '--retention', '1', '--json'], { cwd: dir }).stdout).candidates
  assert.equal(cands.length, 1)
  const r = cli(['prune', '--refs', `${cands[0].ref},refs/heads/main`, '--yes', '--json'], { cwd: dir })
  assert.equal(r.code, 1, '含非法 ref → 退出码 1')
  const out = JSON.parse(r.stdout)
  assert.equal(out.removed.length, 1)
  assert.equal(out.failed.length, 1)
  assert.ok(git('rev-parse', '--verify', 'main').trim(), 'main 分支必须安然无恙')
})

test('status 汇总各 kind 计数与可清理数', (t) => {
  const { dir, git } = makeRepo(t)
  writeFileSync(join(dir, 'a.txt'), 'A2\n')
  cli(['snap', '--json', '--kind', 'manual'], { cwd: dir })
  const s = JSON.parse(cli(['status', '--json'], { cwd: dir }).stdout)
  assert.equal(s.branch, 'main')
  assert.equal(s.snapshotCount, 1)
  assert.equal(s.byKind.manual, 1)
  assert.equal(typeof s.cleanable, 'number')
})

test('非 git 目录给出明确错误与退出码 1（不崩栈）', (t) => {
  const plain = mkdtempSync(join(tmpdir(), 'yfw-cliplain-'))
  t.after(() => rmSync(plain, { recursive: true, force: true }))
  const r = cli(['snap', '--json'], { cwd: plain })
  assert.equal(r.code, 1)
  assert.match(r.stdout + r.code, /not-a-git-repo|1/)
})

test('未知子命令退出码 2 并打印用法', (t) => {
  const { dir } = makeRepo(t)
  const r = cli(['frobnicate'], { cwd: dir })
  assert.equal(r.code, 2)
  assert.match(r.stdout, /用法|usage/i)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/yfw-version.test.mjs`
Expected: FAIL —— CLI 文件不存在（`Cannot find module` 或 `ENOENT`）

- [ ] **Step 3: 写最小实现**

创建 `scripts/yfw-version.mjs`：

```js
#!/usr/bin/env node
// scripts/yfw-version.mjs —— 版本快照 CLI
// ---------------------------------------------------------------------------
// 为什么走 CLI 而不是内核路由：本仓库既有的版本操作惯例就是脚本
// （version.mjs 明文"升级版本号禁止手改，一律走 scripts/*.mjs"），且 agent 天然
// 有 Bash，零内核改动即可用。GUI 侧走 P1 的 HTTP 路由，两者同源调用
// server/version-store.mjs——判定逻辑只写一遍，避免漂移。
//
// 安全语义：restore / prune 无 --yes 时**只打印将执行的动作**（dry-run），
// 落实"删除类操作需审批"铁律。agent 必须显式加 --yes 才会真正改动。
import { resolve } from 'node:path'
import {
  createSnapshot, listSnapshots, diffSnapshots, diffPatch,
  restoreSnapshot, planPrune, pruneSnapshots, isGitRepo, currentBranch,
  DEFAULT_RETENTION, SNAPSHOT_KINDS,
} from '../server/version-store.mjs'

const USAGE = `用法：node scripts/yfw-version.mjs <命令> [选项]

命令：
  snap     打快照           [--name n] [--note t] [--kind ${SNAPSHOT_KINDS.join('|')}]
  list     列出快照         [--limit N]
  diff     对比差异         [<a>] [<b>] [--patch <file>]
  restore  回退/恢复        <ref> [--paths a,b] [--mode soft|full] [--yes]
  prune    清理快照         [--refs r1,r2] [--retention N] [--yes]
  status   汇总状态

公共选项：--repo <path>（缺省当前目录）  --json（机器可读输出）

注意：restore / prune 不加 --yes 时只做 dry-run（仅打印，不执行）。`

export function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { positional.push(a); continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { flags[key] = true; continue }
    flags[key] = next
    i++
  }
  return { positional, flags }
}

function fail(log, json, code, obj, text) {
  log(json ? JSON.stringify(obj, null, 2) : text)
  return code
}

export function runCli(argv, { cwd = process.cwd(), log = console.log } = {}) {
  const { positional, flags } = parseArgs(argv)
  const cmd = positional[0]
  const json = !!flags.json
  const repoPath = resolve(cwd, typeof flags.repo === 'string' ? flags.repo : '.')
  const emit = (obj, text) => log(json ? JSON.stringify(obj, null, 2) : text)

  if (!cmd || flags.help) { log(USAGE); return cmd ? 0 : 2 }
  if (!['snap', 'list', 'diff', 'restore', 'prune', 'status'].includes(cmd)) {
    log(`未知命令：${cmd}\n\n${USAGE}`)
    return 2
  }
  if (!isGitRepo({ repoPath })) {
    return fail(log, json, 1, { ok: false, error: 'not-a-git-repo', repoPath }, `不是 git 仓库：${repoPath}`)
  }

  if (cmd === 'snap') {
    const r = createSnapshot({
      repoPath,
      name: typeof flags.name === 'string' ? flags.name : '',
      note: typeof flags.note === 'string' ? flags.note : '',
      kind: typeof flags.kind === 'string' ? flags.kind : 'manual',
    })
    if (!r.ok) return fail(log, json, 1, r, `打快照失败：${r.error}`)
    if (r.skipped) return fail(log, json, 0, r, '无改动，已跳过（幂等）')
    emit(r, `已创建快照 ${r.ref}\n  ${r.files} 个文件  +${r.insertions}  -${r.deletions}\n  分支 ${r.branch}`)
    return 0
  }

  if (cmd === 'list') {
    let snaps = listSnapshots({ repoPath })
    const limit = Number(flags.limit)
    if (Number.isFinite(limit) && limit > 0) snaps = snaps.slice(0, limit)
    emit(
      { ok: true, branch: currentBranch({ repoPath }), snapshots: snaps },
      snaps.length === 0 ? '（无快照）' : snaps.map(s =>
        `${s.at}  [${s.kind}]  ${s.name}\n    ${s.ref}  ${s.files || ''}`).join('\n'),
    )
    return 0
  }

  if (cmd === 'diff') {
    const a = positional[1] || 'HEAD'
    const b = positional[2]
    if (typeof flags.patch === 'string') {
      const text = diffPatch({ repoPath, a, b, path: flags.patch })
      log(json ? JSON.stringify({ ok: true, patch: text }, null, 2) : text || '（无差异）')
      return 0
    }
    const d = diffSnapshots({ repoPath, a, b })
    if (!d.ok) return fail(log, json, 1, d, `对比失败：${d.error}（检查 ref 是否存在）`)
    emit(d, d.files.length === 0 ? '（无差异）' : d.files.map(f =>
      `${f.insertions}\t${f.deletions}\t${f.path}${f.binary ? '  (binary)' : ''}`).join('\n')
      + `\n共 ${d.files.length} 个文件  +${d.totalInsertions}  -${d.totalDeletions}`)
    return 0
  }

  if (cmd === 'restore') {
    const ref = positional[1]
    if (!ref) { log(`restore 需要 <ref>\n\n${USAGE}`); return 2 }
    const mode = flags.mode === 'full' ? 'full' : 'soft'
    const paths = typeof flags.paths === 'string' ? flags.paths.split(',').map(s => s.trim()).filter(Boolean) : []
    if (!flags.yes) {
      emit(
        { ok: true, dryRun: true, ref, mode, paths },
        `[dry-run] 将回退到 ${ref}（模式 ${mode}）\n` +
        (mode === 'full' ? '  影响范围：整个工作树（忽略 --paths）' : `  影响路径：${paths.join(', ') || '(未指定——实际执行会拒绝)'}`) +
        '\n  回退前会自动创建 pre-restore 保护快照\n  确认无误后加 --yes 执行',
      )
      return 0
    }
    const r = restoreSnapshot({ repoPath, ref, paths, mode })
    if (!r.ok) return fail(log, json, 1, r, `回退失败：${r.error}${r.message ? ` — ${r.message}` : ''}`)
    emit(r, `已回退到 ${ref}（模式 ${mode}）\n  影响：${r.restored.join(', ')}\n  保护快照：${r.protectionRef || '(无改动，已跳过)'}`)
    return 0
  }

  if (cmd === 'prune') {
    const retention = Number(flags.retention)
    const plan = planPrune({ repoPath, retention: Number.isFinite(retention) && retention >= 0 ? retention : DEFAULT_RETENTION })
    const explicit = typeof flags.refs === 'string' ? flags.refs.split(',').map(s => s.trim()).filter(Boolean) : null
    const targets = explicit || plan.candidates.map(c => c.ref)

    if (!flags.yes) {
      emit(
        { ok: true, dryRun: true, retention: plan.retention, candidates: explicit ? targets.map(ref => ({ ref })) : plan.candidates, groups: plan.groups },
        `[dry-run] 保留策略：每分支自动快照保留最近 ${plan.retention} 个\n` +
        (targets.length === 0 ? '  无可清理项' : `  将删除 ${targets.length} 个：\n` + targets.map(r => `    ${r}`).join('\n')) +
        '\n  manual/archive/pre-restore 三类永不自动删除\n  确认无误后加 --yes 执行',
      )
      return 0
    }
    const r = pruneSnapshots({ repoPath, refs: targets })
    const text = `已删除 ${r.removed.length} 个快照` +
      (r.failed.length ? `\n  失败 ${r.failed.length} 个：\n` + r.failed.map(f => `    ${f.ref} — ${f.error}`).join('\n') : '')
    emit(r, text)
    return r.failed.length === 0 ? 0 : 1
  }

  // status
  const snaps = listSnapshots({ repoPath })
  const byKind = {}
  for (const s of snaps) byKind[s.kind] = (byKind[s.kind] || 0) + 1
  const plan = planPrune({ repoPath })
  const out = {
    ok: true, repoPath, branch: currentBranch({ repoPath }),
    snapshotCount: snaps.length, byKind,
    retention: plan.retention, cleanable: plan.candidates.length, groups: plan.groups,
  }
  emit(out, `仓库 ${repoPath}\n分支 ${out.branch}\n快照 ${snaps.length} 个：` +
    (snaps.length === 0 ? '（无）' : Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join('  ')) +
    `\n可清理 ${out.cleanable} 个（保留策略 ${out.retention}/分支）`)
  return 0
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) process.exit(runCli(process.argv.slice(2)))
```

> Windows 路径注意：`isMain` 判断若在本机不成立，改用 `import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))` 等价的宽松判断（Step 4 若发现 CLI 被 import 后仍执行或反之，按实际修正）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/yfw-version.test.mjs`
Expected: PASS（11 个 test）

- [ ] **Step 5: 提交**

```bash
git add scripts/yfw-version.mjs scripts/yfw-version.test.mjs
git commit -m "feat(cli): yfw-version 版本快照命令行（dry-run 优先 + --json 机器可读）"
```

---

### Task 7: `scripts/bump-version.mjs`（补齐两处文档已声明却缺失的脚本）

**Files:**
- Create: `scripts/bump-version.mjs`
- Test: `scripts/bump-version.test.mjs`

**背景（两个既有漂移，实施时必须先看清）：**

1. `version.mjs` 注释声明"升级版本号禁止手改，一律走 `scripts/bump-version.mjs`（自动同步测试期望值/package.json）"——**该文件不存在**。
2. `server/knowledge-routes.mjs:291` 声明"`package.json.version` 是打包唯一可见的版本源，且与 `APP_VERSION` 由 `scripts/bump-version.mjs` 同步"——**同样指向这个不存在的脚本**。

**当前实际漂移（实测）：**

| 版本线 | `version.mjs` | 对应 package.json | 状态 |
|---|---|---|---|
| app | `dev 3.0.0` | `package.json` = `2.8.0` | **漂移** |
| kernel | `dev 0.2` | `kernel/package.json` = `0.2.0` | 等价（2 段 ↔ 3 段语义一致） |

**Interfaces:**
- Consumes: 无（独立于 Task 1–6）
- Produces: `scripts/bump-version.mjs`，导出可单测的纯函数 + `runCli(argv, { root, log }): number`
  - `parseVersion(str): { dev: boolean, parts: number[] } | null`——接受 `dev 3.0.0` / `3.0.0` / `dev 0.2` / `0.2`
  - `formatVersion(v): string`——`dev` 前缀保留，段数保留
  - `bumpSemver(v, level): { dev, parts } | null`，`level ∈ major|minor|patch`
  - `readVersions(root): { app: string, kernel: string, pkg: string, kernelPkg: string }`
  - `writeVersions(root, { app?, kernel? }): string[]`（返回被改写的文件相对路径）
  - `checkDrift(root): { app: DriftItem, kernel: DriftItem }`，`DriftItem = { source, pkg, drift: boolean, normalizedSource, normalizedPkg }`
  - `planTestSync(root, { app }): { file, from, to, count }[]`
  - `applyTestSync(root, { app }, { write = false })`
  - CLI：`check [--json]` / `bump <app|kernel> <major|minor|patch>` / `set <app|kernel> <version>` / `sync-tests [--write]`
  - 退出码：成功 0；用法错误 2；`check` 发现漂移 **1**（可直接用于 CI/门禁）

- [ ] **Step 1: 写失败的测试**

创建 `scripts/bump-version.test.mjs`：

```js
// bump-version：解析/递增/漂移检查/测试期望值同步（纯函数 + 真实文件读写）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseVersion, formatVersion, bumpSemver, readVersions, writeVersions,
  checkDrift, planTestSync, applyTestSync,
} from './bump-version.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'bump-version.mjs')

/** 造一个最小仓库骨架：version.mjs + package.json + kernel/package.json + 一个测试文件 */
function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-bump-'))
  writeFileSync(join(root, 'version.mjs'), [
    "export const APP_VERSION = 'dev 3.0.0'",
    "export const KERNEL_VERSION = 'dev 0.2'",
    'export const SCHEMA_VERSION = 1',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '3.0.0' }, null, 2) + '\n')
  mkdirSync(join(root, 'kernel'), { recursive: true })
  writeFileSync(join(root, 'kernel', 'package.json'), JSON.stringify({ name: 'k', version: '0.2.0' }, null, 2) + '\n')
  mkdirSync(join(root, 'shared'), { recursive: true })
  writeFileSync(join(root, 'shared', 'knowledge-pack.test.mjs'),
    "const a = 'dev 3.0.0'\nconst b = 'dev 3.0.0'\n")
  if (t) t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('parseVersion 支持 dev 前缀与 2/3 段', () => {
  assert.deepEqual(parseVersion('dev 3.0.0'), { dev: true, parts: [3, 0, 0] })
  assert.deepEqual(parseVersion('3.0.0'), { dev: false, parts: [3, 0, 0] })
  assert.deepEqual(parseVersion('dev 0.2'), { dev: true, parts: [0, 2] })
  assert.equal(parseVersion('abc'), null)
  assert.equal(parseVersion(''), null)
})

test('formatVersion 保留 dev 前缀与段数', () => {
  assert.equal(formatVersion({ dev: true, parts: [3, 0, 0] }), 'dev 3.0.0')
  assert.equal(formatVersion({ dev: false, parts: [3, 0, 0] }), '3.0.0')
  assert.equal(formatVersion({ dev: true, parts: [0, 2] }), 'dev 0.2')
})

test('bumpSemver 递增规则正确（含 2 段版本）', () => {
  assert.equal(formatVersion(bumpSemver(parseVersion('dev 3.0.0'), 'patch')), 'dev 3.0.1')
  assert.equal(formatVersion(bumpSemver(parseVersion('dev 3.0.0'), 'minor')), 'dev 3.1.0')
  assert.equal(formatVersion(bumpSemver(parseVersion('dev 3.0.0'), 'major')), 'dev 4.0.0')
  assert.equal(formatVersion(bumpSemver(parseVersion('dev 0.2'), 'patch')), 'dev 0.2.1', '2 段补 patch')
  assert.equal(formatVersion(bumpSemver(parseVersion('dev 0.2'), 'minor')), 'dev 0.3', '2 段 minor 不引入 patch')
  assert.equal(bumpSemver(parseVersion('x'), 'minor'), null)
})

test('readVersions 读出四条版本线', (t) => {
  const root = makeRoot(t)
  const v = readVersions(root)
  assert.equal(v.app, 'dev 3.0.0')
  assert.equal(v.kernel, 'dev 0.2')
  assert.equal(v.pkg, '3.0.0')
  assert.equal(v.kernelPkg, '0.2.0')
})

test('writeVersions 同时改写 version.mjs 与对应 package.json', (t) => {
  const root = makeRoot(t)
  const changed = writeVersions(root, { app: 'dev 3.1.0' })
  assert.ok(changed.some(f => f.includes('version.mjs')))
  assert.ok(changed.some(f => f.includes('package.json')))
  const v = readVersions(root)
  assert.equal(v.app, 'dev 3.1.0', 'version.mjs 的 APP_VERSION 必须改')
  assert.equal(v.pkg, '3.1.0', 'package.json 必须同步（去 dev 前缀）')
  assert.equal(v.kernel, 'dev 0.2', '未指定的版本线不得被动')
  // 不得破坏 version.mjs 其他行
  const text = readFileSync(join(root, 'version.mjs'), 'utf8')
  assert.match(text, /export const SCHEMA_VERSION = 1/)
  assert.match(text, /export const KERNEL_VERSION = 'dev 0\.2'/)
})

test('writeVersions kernel 线同步 kernel/package.json', (t) => {
  const root = makeRoot(t)
  writeVersions(root, { kernel: 'dev 0.3' })
  const v = readVersions(root)
  assert.equal(v.kernel, 'dev 0.3')
  assert.equal(v.kernelPkg, '0.3.0', '2 段映射到 package.json 补 .0')
  assert.equal(v.app, 'dev 3.0.0')
})

test('checkDrift 检出 app 线漂移、kernel 线视为等价', (t) => {
  const root = makeRoot(t)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '2.8.0' }, null, 2) + '\n')
  const d = checkDrift(root)
  assert.equal(d.app.drift, true, 'dev 3.0.0 vs 2.8.0 必须判为漂移')
  assert.equal(d.app.normalizedSource, '3.0.0')
  assert.equal(d.app.normalizedPkg, '2.8.0')
  assert.equal(d.kernel.drift, false, 'dev 0.2 vs 0.2.0 视为等价')
})

test('planTestSync 只命中允许清单内的文件与模式', (t) => {
  const root = makeRoot(t)
  const plans = planTestSync(root, { app: 'dev 3.1.0' })
  const hit = plans.find(p => p.file === 'shared/knowledge-pack.test.mjs')
  assert.ok(hit, '允许清单内的文件必须被扫到')
  assert.equal(hit.count, 2, '该文件里两处 dev 3.0.0 都应计入')
  assert.equal(hit.to, 'dev 3.1.0')
  assert.ok(plans.every(p => !p.file.includes('..')), '不得越出 root')
})

test('applyTestSync 默认 dry-run 不写盘，--write 才落盘', (t) => {
  const root = makeRoot(t)
  const file = join(root, 'shared', 'knowledge-pack.test.mjs')
  const before = readFileSync(file, 'utf8')
  const dry = applyTestSync(root, { app: 'dev 3.1.0' }, { write: false })
  assert.ok(dry.length > 0)
  assert.equal(readFileSync(file, 'utf8'), before, 'dry-run 不得写盘')
  applyTestSync(root, { app: 'dev 3.1.0' }, { write: true })
  assert.match(readFileSync(file, 'utf8'), /dev 3\.1\.0/)
  assert.ok(!/dev 3\.0\.0/.test(readFileSync(file, 'utf8')))
})

test('CLI check 发现漂移退出码 1，无漂移退出 0', (t) => {
  const root = makeRoot(t)
  const ok = execFileSync(process.execPath, [CLI, 'check', '--repo', root], { encoding: 'utf8' })
  assert.match(ok, /无漂移|ok/i)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2) + '\n')
  let code = 0
  try { execFileSync(process.execPath, [CLI, 'check', '--repo', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e) { code = e.status }
  assert.equal(code, 1, '漂移时退出码必须为 1（可用于门禁）')
})

test('CLI bump 递增并落盘，非法输入退出码 2', (t) => {
  const root = makeRoot(t)
  execFileSync(process.execPath, [CLI, 'bump', 'app', 'minor', '--repo', root], { encoding: 'utf8' })
  const v = readVersions(root)
  assert.equal(v.app, 'dev 3.1.0')
  assert.equal(v.pkg, '3.1.0')
  let code = 0
  try { execFileSync(process.execPath, [CLI, 'bump', 'app', 'sideways', '--repo', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e) { code = e.status }
  assert.equal(code, 2)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/bump-version.test.mjs`
Expected: FAIL —— `Cannot find module './bump-version.mjs'`

- [ ] **Step 3: 写最小实现**

创建 `scripts/bump-version.mjs`：

```js
#!/usr/bin/env node
// scripts/bump-version.mjs —— 版本号提升（version.mjs 与 knowledge-routes.mjs 两处
// 文档声明的唯一入口，此前缺失）。三条版本线映射：
//   app    ↔ version.mjs APP_VERSION    + package.json version
//   kernel ↔ version.mjs KERNEL_VERSION + kernel/package.json version
// 版本规范：dev <major>.<minor>[.<patch>]（发布稳定后去 dev 前缀），与 version.mjs 注释一致。
//
// 子命令：
//   check                 检查 version.mjs 与 package.json 是否漂移（漂移退出码 1，可做门禁）
//   bump  <app|kernel> <major|minor|patch>
//   set   <app|kernel> <version>
//   sync-tests [--write]  同步测试中的版本期望值（默认 dry-run）
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 测试版本期望值的**允许清单**：只改这些文件的这些模式，绝不做全文数字替换 */
export const TEST_VERSION_TARGETS = [
  { file: 'src/lib/knowledgePacksApi.test.ts', re: /appVersion: 'dev \d+\.\d+\.\d+'/g, plain: false },
  { file: 'shared/knowledge-pack.test.mjs', re: /'dev \d+\.\d+\.\d+'/g, plain: false },
  { file: 'server/knowledge-pack-install.test.mjs', re: /appVersion: '\d+\.\d+\.\d+'/g, plain: true },
  { file: 'server/knowledge-routes.test.mjs', re: /appVersion: '\d+\.\d+\.\d+'/g, plain: true },
]

const LEVELS = ['major', 'minor', 'patch']

export function parseVersion(str) {
  const m = /^(dev\s+)?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(str || '').trim())
  if (!m) return null
  const parts = [Number(m[2]), Number(m[3])]
  if (m[4] !== undefined) parts.push(Number(m[4]))
  return { dev: !!m[1], parts }
}

export function formatVersion(v) {
  if (!v) return ''
  return (v.dev ? 'dev ' : '') + v.parts.join('.')
}

export function bumpSemver(v, level) {
  if (!v || !LEVELS.includes(level)) return null
  const p = [...v.parts]
  if (level === 'major') { p[0] += 1; p[1] = 0; if (p.length > 2) p[2] = 0 }
  else if (level === 'minor') { p[1] += 1; if (p.length > 2) p[2] = 0 }
  else { if (p.length > 2) p[2] += 1; else p.push(1) }
  return { dev: v.dev, parts: p }
}

/** 数值型归一化：段数不同时补 0（dev 0.2 ≡ 0.2.0） */
export function normalizeForCompare(str) {
  const v = parseVersion(str)
  if (!v) return null
  const p = [...v.parts]
  while (p.length < 3) p.push(0)
  return p.join('.')
}

const VER_RE = {
  app: /(export const APP_VERSION = ')([^']*)(')/,
  kernel: /(export const KERNEL_VERSION = ')([^']*)(')/,
}

function pkgPath(root, line) {
  return line === 'kernel' ? join(root, 'kernel', 'package.json') : join(root, 'package.json')
}

export function readVersions(root) {
  const src = readFileSync(join(root, 'version.mjs'), 'utf8')
  const grab = (re) => (re.exec(src) || [])[2] || ''
  const pkgOf = (line) => {
    try { return JSON.parse(readFileSync(pkgPath(root, line), 'utf8')).version || '' } catch { return '' }
  }
  return {
    app: grab(VER_RE.app), kernel: grab(VER_RE.kernel),
    pkg: pkgOf('app'), kernelPkg: pkgOf('kernel'),
  }
}

/** package.json 只替换顶层第一次出现的 `"version": "..."`（依赖项里没有裸 version 键） */
function setPkgVersion(file, version) {
  const text = readFileSync(file, 'utf8')
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
  if (next === text) throw new Error(`package.json 未找到 version 字段：${file}`)
  writeFileSync(file, next)
}

/** 只改 version.mjs 的版本常量行，其他行一律不动 */
export function writeVersions(root, { app, kernel } = {}) {
  const changed = []
  const verFile = join(root, 'version.mjs')
  let src = readFileSync(verFile, 'utf8')
  const apply = (line, value) => {
    const v = parseVersion(value)
    if (!v) throw new Error(`非法版本：${value}`)
    const before = src
    src = src.replace(VER_RE[line], `$1${formatVersion(v)}$3`)
    if (src === before) throw new Error(`version.mjs 未找到 ${line} 版本常量`)
  }
  if (app) {
    apply('app', app)
    writeFileSync(verFile, src)
    changed.push('version.mjs')
    setPkgVersion(join(root, 'package.json'), parseVersion(app).parts.join('.'))
    changed.push('package.json')
  }
  if (kernel) {
    apply('kernel', kernel)
    writeFileSync(verFile, src)
    if (!changed.includes('version.mjs')) changed.push('version.mjs')
    const p = [...parseVersion(kernel).parts]
    while (p.length < 3) p.push(0)
    setPkgVersion(join(root, 'kernel', 'package.json'), p.join('.'))
    changed.push('kernel/package.json')
  }
  return changed
}

export function checkDrift(root) {
  const v = readVersions(root)
  const item = (source, pkg) => ({
    source, pkg,
    normalizedSource: normalizeForCompare(source),
    normalizedPkg: normalizeForCompare(pkg),
    drift: normalizeForCompare(source) !== normalizeForCompare(pkg),
  })
  return { app: item(v.app, v.pkg), kernel: item(v.kernel, v.kernelPkg) }
}

export function planTestSync(root, { app }) {
  const target = parseVersion(app)
  if (!target) return []
  const devForm = formatVersion(target)
  const plainForm = target.parts.join('.')
  const plans = []
  for (const t of TEST_VERSION_TARGETS) {
    const full = join(root, t.file)
    if (!existsSync(full)) continue
    const text = readFileSync(full, 'utf8')
    const matches = text.match(t.re) || []
    if (matches.length === 0) continue
    const to = t.plain ? plainForm : devForm
    const already = matches.every(m => m === (t.plain ? `appVersion: '${plainForm}'` : t.plain ? '' : (t.file.endsWith('.ts') ? `appVersion: '${devForm}'` : `'${devForm}'`)))
    if (already) continue
    plans.push({ file: t.file, from: matches[0], to, count: matches.length })
  }
  return plans
}

export function applyTestSync(root, { app }, { write = false } = {}) {
  const target = parseVersion(app)
  if (!target) return []
  const devForm = formatVersion(target)
  const plainForm = target.parts.join('.')
  const done = []
  for (const t of TEST_VERSION_TARGETS) {
    const full = join(root, t.file)
    if (!existsSync(full)) continue
    const text = readFileSync(full, 'utf8')
    const to = t.plain ? plainForm : devForm
    const next = text.replace(t.re, (m) => (t.plain ? `appVersion: '${to}'` : m.replace(/'[^']*'/, `'${to}'`)))
    if (next === text) continue
    if (write) writeFileSync(full, next)
    done.push({ file: t.file, to, count: (text.match(t.re) || []).length, written: write })
  }
  return done
}

export function runCli(argv, { root = process.cwd(), log = console.log } = {}) {
  const args = [...argv]
  const ri = args.indexOf('--repo')
  let repoRoot = root
  if (ri >= 0) { repoRoot = args[ri + 1] || root; args.splice(ri, 2) }
  const json = args.includes('--json')
  const write = args.includes('--write')
  const cmd = args.find(a => !a.startsWith('--'))
  const positional = args.filter(a => !a.startsWith('--'))

  if (cmd === 'check') {
    const d = checkDrift(repoRoot)
    const drifted = d.app.drift || d.kernel.drift
    const text = drifted
      ? `发现漂移：\n  app    version.mjs=${d.app.source}  package.json=${d.app.pkg}\n  kernel version.mjs=${d.kernel.source}  kernel/package.json=${d.kernel.pkg}\n用 \`bump-version.mjs set <app|kernel> <version>\` 收敛。`
      : '无漂移：三条版本线一致。'
    log(json ? JSON.stringify({ ok: !drifted, drift: d }, null, 2) : text)
    return drifted ? 1 : 0
  }

  if (cmd === 'bump' || cmd === 'set') {
    const [, line, value] = positional
    if (!['app', 'kernel'].includes(line)) { log(`版本线必须是 app 或 kernel\n用法：bump-version.mjs ${cmd} <app|kernel> <${cmd === 'bump' ? LEVELS.join('|') : 'version'}>`); return 2 }
    let next
    if (cmd === 'bump') {
      if (!LEVELS.includes(value)) { log(`级别必须是 ${LEVELS.join('|')}`); return 2 }
      next = bumpSemver(parseVersion(readVersions(repoRoot)[line]), value)
    } else {
      next = parseVersion(value)
    }
    if (!next) { log(`非法版本或无法解析当前版本：${value}`); return 2 }
    const changed = writeVersions(repoRoot, { [line]: formatVersion(next) })
    log(json ? JSON.stringify({ ok: true, line, version: formatVersion(next), changed }, null, 2)
      : `${line} → ${formatVersion(next)}\n已改写：${changed.join(', ')}`)
    return 0
  }

  if (cmd === 'sync-tests') {
    const v = readVersions(repoRoot)
    const plans = applyTestSync(repoRoot, { app: v.app }, { write })
    const text = plans.length === 0 ? '测试期望值已是最新，无需同步。'
      : (write ? '已同步：\n' : '[dry-run] 将同步（加 --write 落盘）：\n') +
        plans.map(p => `  ${p.file}  ${p.count} 处 → ${p.to}`).join('\n')
    log(json ? JSON.stringify({ ok: true, write, plans }, null, 2) : text)
    return 0
  }

  log(`用法：
  bump-version.mjs check [--json] [--repo <root>]
  bump-version.mjs bump <app|kernel> <${LEVELS.join('|')}> [--repo <root>]
  bump-version.mjs set  <app|kernel> <version> [--repo <root>]
  bump-version.mjs sync-tests [--write] [--repo <root>]`)
  return 2
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/bump-version.mjs')) {
  process.exit(runCli(process.argv.slice(2)))
}
```

> `planTestSync` 中 `already` 的一行判断较绕，可简化为：先算 `to`，再判断 `matches` 是否都已等于目标形态；保持行为即可（测试已钉住）。
> `if (process.argv[1] && ...)` 用路径后缀判断入口，规避 Windows 下 `file://` URL 拼接差异。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/bump-version.test.mjs`
Expected: PASS（11 个 test）

- [ ] **Step 5: 全量回归 + 提交**

```bash
node --test server/version-store.test.mjs scripts/yfw-version.test.mjs scripts/bump-version.test.mjs
git add scripts/bump-version.mjs scripts/bump-version.test.mjs
git commit -m "feat(scripts): 补齐 bump-version（三条版本线 + 漂移检查 + 测试期望值同步）"
```

---

### Task 8: 收敛既有版本号漂移（**需用户决策，不得擅自执行**）

**Files:**
- Modify: `package.json`（**仅在用户批准后**）

**背景：** `checkDrift` 在真实仓库上会报出 app 线漂移——`version.mjs` 为 `dev 3.0.0`，`package.json` 为 `2.8.0`。`server/knowledge-routes.mjs:291` 声明二者应由 bump 脚本保持同步，且 `package.json.version` 是**打包后唯一可见的版本源**（`version.mjs` 不在 `electron-builder.yml` 的 files 里）。因此当前打包产物对外上报的版本是 `dev 2.8.0`，而开发侧认为是 `dev 3.0.0`。

- [ ] **Step 1: 跑漂移检查，固化现状证据**

Run: `node scripts/bump-version.mjs check`
Expected: 退出码 1，输出 app 线 `version.mjs=dev 3.0.0  package.json=2.8.0`

- [ ] **Step 2: 统计测试中的版本期望值分布**

Run: `node scripts/bump-version.mjs sync-tests`
Expected: 列出待同步文件与处数（dry-run，不写盘）。**把该输出原样贴给用户**作为决策依据。

- [ ] **Step 3: 向用户报告并征求决策（禁止自行选择）**

报告内容必须包含：
1. 漂移事实：`dev 3.0.0` vs `2.8.0`；
2. 影响：打包后上报版本为 `dev 2.8.0`（因 `package.json` 是打包唯一可见源，且被 `knowledge-routes.mjs:defaultAppVersion()` 读取，用于知识包版本兼容判定）；
3. 两个可选动作：**(A)** 以 `version.mjs` 为准收敛 → `set app 3.0.0`，再 `sync-tests --write`；**(B)** 以 `package.json` 为准把 APP_VERSION 降为 `dev 2.8.0`；**(C)** 暂不处理，仅记录。
4. 说明 `set app` 会同时改写 `package.json`（影响后续 electron-builder 产物版本与知识包兼容判定），故须用户拍板。

- [ ] **Step 4: 按用户选择执行（若选 C 则跳过本步）**

以选项 A 为例：

```bash
node scripts/bump-version.mjs set app 3.0.0
node scripts/bump-version.mjs sync-tests --write
node scripts/bump-version.mjs check          # 期望退出码 0：无漂移
```

随后运行受影响的测试确认未回归：

```bash
node --test shared/knowledge-pack.test.mjs server/knowledge-routes.test.mjs server/knowledge-pack-install.test.mjs
```

- [ ] **Step 5: 提交（若执行了 Step 4）**

```bash
git add package.json version.mjs src/lib/knowledgePacksApi.test.ts shared/knowledge-pack.test.mjs server/knowledge-pack-install.test.mjs server/knowledge-routes.test.mjs
git commit -m "chore(version): 收敛 app 线版本漂移（package.json 与 APP_VERSION 对齐）"
```

---

## Self-Review

**1. Spec coverage（逐条对照设计文档）：**

| 设计章节 | 覆盖任务 |
|---|---|
| §4 数据模型（消息格式、`for-each-ref` 单次读取、零索引文件） | Task 1 |
| §4.3 护栏（空改动跳过、体积上限、尊重 .gitignore） | Task 2 |
| §5 创建机制（临时索引、不碰 HEAD、幽灵引用） | Task 2 |
| §5.1 命名（`yyyyMMdd-HHmmss-slug` + 冲突加序号） | Task 2 |
| §7.1 打快照契约（三态返回） | Task 2 + Task 6 |
| §7.2 回退（软/全量、强制保护快照、拒绝 reset/clean） | Task 4 |
| §7.3 对比差异（`--stat` + 单文件 patch、与工作区比较） | Task 3 |
| §7.4 清理（保留策略、保护类型、审批、不做 gc） | Task 5 + Task 6（`--yes` 门） |
| §9 CLI 契约（命令集、`--json`、dry-run 优先） | Task 6 |
| §12 bump-version 补齐（三线、测试期望值同步） | Task 7 |
| §11 安全边界 1/2/3/6 | Task 2（只写 refs/yfw/）、Task 4（保护快照）、Task 5（ref 前缀闸）、Task 6（`--yes`） |
| §11 安全边界 4（pre-commit 钩子需批准） | **不在 P0**——属 P2，届时单独获批 |
| §8 HTTP 契约、§10 GUI 面板、§6 自动触发、§13 P1–P3 文件 | **不在 P0**——P1/P2/P3 分别另出计划 |

**2. Placeholder scan：** 无 TBD/TODO；每个代码步骤都含完整可实现代码；Task 3 与 Task 7 各有一处「按实际运行结果校准」的显式说明（分别针对 git 计数细节与 `planTestSync` 的 `already` 写法），均给定了修正方法而非留空。

**3. Type consistency 核对：**

- `createSnapshot` 返回字段 `{ ref, sha, at, branch, kind, name, files, insertions, deletions }` —— Task 3/4/5/6/7 引用一致（Task 6 CLI 用 `r.files`/`r.insertions`/`r.deletions`/`r.skipped`）。
- `listSnapshots` 元素 `{ ref, sha, name, kind, at, branch, session, milestone, files, note }` —— Task 5 `planPrune` 用 `s.branch`/`s.kind`，Task 6 `status` 用 `s.kind`，一致。
- `diffSnapshots` 元素 `{ path, insertions, deletions, binary }` —— Task 6 CLI 输出用同名字段。
- `restoreSnapshot` 返回 `{ ok, ref, sha, mode, restored, protectionRef, protectionSkipped }` —— Task 6 用 `r.restored`/`r.protectionRef`，一致。
- `planPrune` 返回 `{ ok, retention, candidates, groups }` —— Task 6 用 `plan.candidates`/`plan.retention`/`plan.groups`，一致。
- Task 7 内部：`parseVersion`/`formatVersion`/`bumpSemver`/`normalizeForCompare` 的入参出参在测试与实现间一致；`readVersions` 返回 `{ app, kernel, pkg, kernelPkg }` 被 `checkDrift` 与 CLI 一致使用。
- 常量名跨任务一致：`SNAP_REF_PREFIX`、`PROTECTED_KINDS`、`DEFAULT_RETENTION`、`MAX_SNAPSHOT_FILES`、`MAX_SNAPSHOT_BYTES`、`EMPTY_TREE`。

**4. 已知风险（实施时留意）：**

- Task 5 的 `seedTurns` 依赖系统时钟推进；同一秒内多个快照的 `at` 相同，`listSnapshots` 以 `ref` 降序兜底稳定排序，测试断言基于 `slice(0, retention)` 的相对顺序，不依赖绝对时间——若出现不稳定，改为向 `createSnapshot` 传递增的 `now`。
- Task 6 的 `isMain` 判断在 Windows 下可能不成立（`file://` URL 拼接差异），Step 3 已给出替代写法；若 CLI 在 spawn 下无任何输出，先查此处。
- Task 7 的 `sync-tests` 会改动 4 个测试文件；**必须在 Task 8 获得用户批准后才执行 `--write`**，默认 dry-run 是刻意的安全设计。
- `restoreSnapshot` 创建保护快照时**不传 `gitEnv`**（真实运行不需要；身份兜底会自行触发）。若日后需要在该路径下模拟无身份环境，须先把 `gitEnv` 透传下去。
- Task 2 的身份兜底测试依赖 `gitEnv` 参数才能覆盖到兜底分支——**该参数是测试有效性的前提，不要在实现时省掉**；测试内含前置断言（`user.email` 必须为空）防止测试静默失效。

