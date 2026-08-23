# P6 部署与分发（settings schema 版本化 / transcript 版本标记 / 版本统一 / 配置清单 / 独立部署包）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 升级不破坏数据（settings/transcript 版本化 + 迁移）、版本可审计（统一版本号 + buildId）、配置全量可查（生成式 reference）、内核可独立部署（无 GUI 最小包）。

**Architecture:** 版本单一数据源 `version.mjs` 扩展（SCHEMA_VERSION + buildId）；`kernel/settings.mjs` 追加 schema 校验/迁移/漂移检测纯函数；`kernel/session.mjs` 新会话写 transcript meta 首行 + 旧格式自动适配；`kernel/config-scan.mjs` 生成式配置清单；`kernel/package.json + .env.example + README` 独立部署形态。bridge 仅一处薄改动（diagInfo 版本字段），前端零新增设置项。

**Tech Stack:** 纯 Node ESM（node:test / node:fs / node:child_process），零 npm 依赖。测试沿用 `server/*.test.mjs`：单元直连 import；集成 spawn 真内核（`kernel/cli.mjs` + `PONOS_MOCK_API=1`）+ makeReader（参照 `server/kernel-contract.test.mjs`）。

## Global Constraints

- 零 npm 依赖：kernel/ 内新代码只用 node 内置模块；独立部署包无 dependencies。
- 内核优先：迁移/校验/漂移逻辑在 kernel/；bridge 只做版本展示（diagInfo 字段），前端零新增设置项。
- 向后兼容：无 schemaVersion 的 settings / 无 meta 首行的 transcript 一律视为 v1 自动适配，不报错不迁移；行为与现在完全一致。
- 版本单一数据源：`version.mjs` 导出 `PONOS_VERSION`（既有）+ `SCHEMA_VERSION` + `buildId()`；settings.mjs 引用 SCHEMA_VERSION，不得另起常量。
- 测试命令：`node --test server/<file>.test.mjs`；全量 `node --test "server/*.test.mjs"`。
- 前置依赖（按依赖链 P1→P5 已落地）：
  - `kernel/settings.mjs`（P4 Task 1）：`loadSettings({ configDir, cwd, local })` → `{ user, project, local, merged, paths }`（本计划 Task 1/6 在其上追加，不改既有返回字段语义）
  - `kernel/session.mjs`：既有 `createSessionStore({ configDir, cwd, sessionId, maxEntries })` 与 `append/load/rebuildSurface`（本计划 Task 2 追加 meta 首行，兼容 P4-5 已加的 `kind === 'meta'` 跳过逻辑）
  - `version.mjs`：既有 `PONOS_VERSION = 'dev 0.1'`（本计划 Task 1 追加 SCHEMA_VERSION、Task 3 追加 buildId）
  - cli init 事件（P5 Task 6 后已含 provider/vision/skills/settings 字段；本计划 Task 3 再增 schemaVersion/buildId，纯增量）

---

### Task 1: settings schema 版本化（D2-1）

**Files:**
- Modify: `version.mjs`（追加 `SCHEMA_VERSION`）
- Modify: `kernel/settings.mjs`（追加 `migrateSettings` / `validateSettings`；`loadSettings` 接线，返回 `schema` 信息）
- Create: `server/schema.test.mjs`

**Interfaces:**
- Consumes: `loadSettings`（P4 Task 1）；`PONOS_VERSION`（version.mjs 既有）
- Produces:
  - `version.mjs`：`export const SCHEMA_VERSION = 1`（settings 文件 schema 版本，当前 v1）
  - `kernel/settings.mjs`：
    - `MIGRATIONS`：`{ [fromVersion]: (data) => data }` 迁移函数表（from → from+1）；当前 `{ 0: (d) => ({ ...d, schemaVersion: 1 }) }`（v0 = 无版本字段，仅补版本号）
    - `migrateSettings(data)` → `{ data, from, to, migrated }`：无 `schemaVersion` → 视为 0 → 沿 MIGRATIONS 链迁移到 SCHEMA_VERSION
    - `validateSettings(data)` → `{ ok, error }`：`schemaVersion > SCHEMA_VERSION` → `{ ok: false, error: 'settings schema 版本 <v> 高于内核支持的 <SCHEMA_VERSION>，请升级内核' }`
    - `loadSettings` 返回追加 `schema: { version, migrated, error }`（增量字段，P4 测试不受影响）

- [x] **Step 1: 写失败测试**

```js
// server/schema.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA_VERSION } from '../version.mjs'
import { loadSettings, migrateSettings, validateSettings } from '../kernel/settings.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'ponos-schema-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('SCHEMA_VERSION 单一数据源：version.mjs 导出且当前为 1', () => {
  assert.equal(SCHEMA_VERSION, 1)
})

test('migrateSettings：无版本字段 → v0 → v1 迁移链', () => {
  const r = migrateSettings({ model: 'm1' })
  assert.equal(r.from, 0)
  assert.equal(r.to, 1)
  assert.equal(r.migrated, true)
  assert.equal(r.data.schemaVersion, 1)
  assert.equal(r.data.model, 'm1')
})

test('migrateSettings：已是当前版本 → 原样返回不迁移', () => {
  const r = migrateSettings({ schemaVersion: 1, model: 'm1' })
  assert.equal(r.migrated, false)
  assert.equal(r.to, 1)
})

test('validateSettings：高于当前版本 → 拒绝并提示升级', () => {
  const r = validateSettings({ schemaVersion: 99 })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('高于内核支持'))
})

test('loadSettings：无版本 settings 文件 → 自动迁移 + schema 信息', () => {
  const configDir = join(tmp, 'cfg')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ model: 'old-model' }), 'utf-8')
  const r = loadSettings({ configDir, cwd: join(tmp, 'nope'), local: {} })
  assert.equal(r.schema.version, 1)
  assert.equal(r.schema.migrated, true)
  assert.equal(r.schema.error, null)
  assert.equal(r.merged.model, 'old-model')
})

test('loadSettings：高于当前版本 → error 标注（merged 仍可用，拒绝硬失败）', () => {
  const configDir = join(tmp, 'cfg2')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ schemaVersion: 99 }), 'utf-8')
  const r = loadSettings({ configDir, cwd: join(tmp, 'nope'), local: {} })
  assert.ok(r.schema.error.includes('高于内核支持'))
})
```

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/schema.test.mjs`
Expected: FAIL —— `SCHEMA_VERSION` 未导出 / `migrateSettings is not a function`

- [x] **Step 3: 实现 version.mjs 追加**

`version.mjs` 末尾追加：

```js
// settings 文件 schema 版本（D2-1）：无 schemaVersion 的旧文件视为 v0，读取时沿迁移链升级。
export const SCHEMA_VERSION = 1
```

- [x] **Step 4: 实现 settings.mjs 追加**

`kernel/settings.mjs`：
1. import 区加 `import { SCHEMA_VERSION } from '../version.mjs'`
2. 文件末尾追加：

```js
// —— D2-1 settings schema 版本化：迁移链 + 校验 ——
// v0 = 无 schemaVersion 字段的旧文件；迁移表 { from: fn }，fn 返回 from+1 版本数据。
export const MIGRATIONS = {
  0: (d) => ({ ...d, schemaVersion: 1 }),
}

export function migrateSettings(data = {}) {
  let current = data
  let from = Number(current.schemaVersion)
  if (!Number.isFinite(from) || from < 0) from = 0
  let migrated = false
  while (from < SCHEMA_VERSION) {
    const fn = MIGRATIONS[from]
    if (!fn) break // 缺迁移函数：停在当前版本（不硬失败）
    current = fn(current)
    from++
    migrated = true
  }
  return { data: current, from: Number(data.schemaVersion) || 0, to: from, migrated }
}

export function validateSettings(data = {}) {
  const v = Number(data.schemaVersion)
  if (Number.isFinite(v) && v > SCHEMA_VERSION) {
    return { ok: false, error: `settings schema 版本 ${v} 高于内核支持的 ${SCHEMA_VERSION}，请升级内核` }
  }
  return { ok: true, error: null }
}
```

3. `loadSettings` 内 readJson 之后加迁移与校验，返回对象追加 schema：

```js
  const { data: migratedUser, migrated } = migrateSettings(user)
  const valid = validateSettings(migratedUser)
  // ...（原 user/project 合并逻辑用 migratedUser 替代 user）
  return {
    user: migratedUser,
    project,
    local,
    merged: deepMerge(deepMerge(migratedUser, project), local),
    paths: { user: userPath, project: projectPath },
    schema: { version: SCHEMA_VERSION, migrated, error: valid.error },
  }
```

> 注：project/local 层暂不独立迁移（与 user 同为 v1 结构；若未来分版本，在 merged 后统一校验）。迁移只对 user 文件执行，project/local 走 merged 校验兜底。

- [x] **Step 5: 跑测试验证通过**

Run: `node --test server/schema.test.mjs`
Expected: PASS（6 个测试）

- [x] **Step 6: 回归 + 提交**

Run: `node --test server/settings.test.mjs`
Expected: PASS（P4 既有测试：无版本文件 → 自动迁移 → merged 语义不变）

```bash
git add version.mjs kernel/settings.mjs server/schema.test.mjs
git commit -m "feat(kernel): settings schema 版本化（迁移链 + 高于版本拒绝，v0 自动适配）"
```

---

### Task 2: transcript 版本标记（D2-2）

**Files:**
- Modify: `kernel/session.mjs`（新会话写 meta 首行；`rebuildSurface` 跳过 meta；`load` 返回 `metaVersion`）
- Create: `server/session-meta.test.mjs`

**Interfaces:**
- Consumes: `createSessionStore`（session.mjs 既有）；P4-5 已加的 `kind === 'meta'` 条目语义（审计 meta）
- Produces:
  - 新会话（文件不存在）构造时首行写 `{"type":"meta","kind":"transcript","schemaVersion":1}`（不占 seq、不进 entriesBySeq/nodes）
  - `rebuildSurface`：`kind === 'meta'` 条目一律跳过（不投影、不占 seq 计数？——不占 seq 计数，仅读）
  - `load()` 返回追加 `metaVersion`：文件含 schemaVersion meta → 该值；旧格式（无 meta）→ 1（自动适配）
  - `TRanscript_SCHEMA_VERSION = 1` 常量导出（供 meta 写入）

- [x] **Step 1: 写失败测试**

```js
// server/session-meta.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStore, TRANSCRIPT_SCHEMA_VERSION } from '../kernel/session.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'ponos-meta-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('新会话：文件首行写 transcript schemaVersion meta', () => {
  const configDir = join(tmp, 'c1')
  const store = createSessionStore({ configDir, cwd: '/proj', sessionId: 'sess-1' })
  assert.ok(existsSync(store.file))
  const firstLine = readFileSync(store.file, 'utf-8').split('\n')[0]
  const meta = JSON.parse(firstLine)
  assert.equal(meta.type, 'meta')
  assert.equal(meta.kind, 'transcript')
  assert.equal(meta.schemaVersion, TRANSCRIPT_SCHEMA_VERSION)
  // meta 不占 seq：首个 user 条目 seq 为 1
  store.appendUser('hello')
  const lines = readFileSync(store.file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  const user = lines.find((l) => l.type === 'user')
  assert.equal(user.seq, 1)
})

test('load：meta 不投影进 deriveMessages + 返回 metaVersion', async () => {
  const configDir = join(tmp, 'c2')
  const store = createSessionStore({ configDir, cwd: '/proj', sessionId: 'sess-2' })
  store.appendUser('hi')
  store.appendAssistant([{ type: 'text', text: 'yo' }])
  const r = await store.load()
  assert.equal(r.metaVersion, TRANSCRIPT_SCHEMA_VERSION)
  const msgs = store.deriveMessages()
  assert.equal(msgs.length, 2) // 只有 user + assistant，无 meta
})

test('旧格式兼容：无 meta 首行的 transcript → load 正常 + metaVersion=1', async () => {
  const configDir = join(tmp, 'c3')
  const store = createSessionStore({ configDir, cwd: '/proj', sessionId: 'sess-3' })
  // 模拟旧文件：直接覆写为无 meta 的旧格式
  const { writeFileSync } = await import('node:fs')
  writeFileSync(store.file, [
    JSON.stringify({ type: 'user', id: 'a', seq: 1, timestamp: new Date().toISOString(), message: { role: 'user', content: 'old' } }),
    JSON.stringify({ type: 'assistant', id: 'b', seq: 2, timestamp: new Date().toISOString(), message: { role: 'assistant', content: 'old reply' } }),
    '',
  ].join('\n'), 'utf-8')
  const r = await store.load()
  assert.equal(r.metaVersion, 1)
  assert.equal(store.deriveMessages().length, 2)
})
```

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/session-meta.test.mjs`
Expected: FAIL —— `TRANSCRIPT_SCHEMA_VERSION` 未导出 / 新会话无 meta 首行 / meta 进入 deriveMessages

- [x] **Step 3: 实现 session.mjs 追加**

`kernel/session.mjs`：
1. 常量区（`MAX_SANITIZED_LENGTH` 附近）加：

```js
// transcript 文件 schema 版本（D2-2）：新会话首行写 meta 标记；旧格式（无 meta）视为 v1。
export const TRANSCRIPT_SCHEMA_VERSION = 1
```

2. `createSessionStore` 内 `mkdirSync` 之后、构造返回前，加首行写入：

```js
  // D2-2：新会话落盘 meta 首行（版本标记；不占 seq、不投影）。旧文件/恢复会话不写。
  if (!existsSync(file)) {
    try {
      appendFileSync(file, JSON.stringify({ type: 'meta', kind: 'transcript', schemaVersion: TRANSCRIPT_SCHEMA_VERSION, timestamp: new Date().toISOString() }) + '\n', 'utf-8')
    } catch { /* 磁盘不可写不致命 */ }
  }
```

3. `rebuildSurface`（原 line 67-95）循环开头加 meta 跳过（与既有 compaction/start 跳过并列）：

```js
      if (e.kind === 'meta') continue // D2-2：版本标记/审计 meta 不投影
```

4. `load()`（原 line 97-101）返回追加 metaVersion：

```js
  async function load() {
    const entries = await readLines()
    rebuildSurface(entries)
    const metaEntry = entries.find((e) => e?.kind === 'meta' && e?.schemaVersion != null)
    return { entries, surface: { nodes, replaceGeneration }, compactCount, metaVersion: metaEntry ? Number(metaEntry.schemaVersion) : 1 }
  }
```

- [x] **Step 4: 跑测试验证通过**

Run: `node --test server/session-meta.test.mjs`
Expected: PASS（3 个测试）

- [x] **Step 5: 回归 + 提交**

Run: `node --test server/kernel-contract.test.mjs server/kernel-bridge.test.mjs`
Expected: PASS（旧 transcript 恢复路径不受影响）

```bash
git add kernel/session.mjs server/session-meta.test.mjs
git commit -m "feat(kernel): transcript meta 版本标记（新会话首行 + 旧格式自动适配 v1）"
```

---

### Task 3: 版本号统一 + buildId（D4-1）

**Files:**
- Modify: `version.mjs`（追加 `buildId()`）
- Modify: `kernel/cli.mjs`（init 事件追加 `schemaVersion` / `buildId`）
- Modify: `server/bridge.mjs`（diagInfo 追加 kernelVersion/schemaVersion/buildId，init 事件处赋值）
- Create: `server/version.test.mjs`

**Interfaces:**
- Consumes: `PONOS_VERSION` / `SCHEMA_VERSION`（version.mjs）；`TRANSCRIPT_SCHEMA_VERSION`（Task 2，不强制）
- Produces:
  - `version.mjs`：`export function buildId() { return process.env.PONOS_BUILD_ID || 'dev' }`（构建时注入 PONOS_BUILD_ID；dev 默认）
  - cli init 事件：`wire.system('init', { ..., schemaVersion: SCHEMA_VERSION, buildId: buildId() })`（纯增量字段）
  - bridge：`diagInfo` 追加 `{ kernelVersion: '', schemaVersion: 0, buildId: '' }`；主会话 stdout 行循环解析到 `system/init` 事件时赋值（与既有 `firstTokenAt` 采集并列）

- [x] **Step 1: 写失败测试**

```js
// server/version.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { PONOS_VERSION, SCHEMA_VERSION, buildId } from '../version.mjs'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'cli.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'ponos-ver-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('version.mjs 单一数据源：常量 + buildId（env 注入 / dev 默认）', () => {
  assert.ok(typeof PONOS_VERSION === 'string' && PONOS_VERSION.length > 0)
  assert.equal(SCHEMA_VERSION, 1)
  assert.equal(buildId(), 'dev')
  const prev = process.env.PONOS_BUILD_ID
  process.env.PONOS_BUILD_ID = 'build-123'
  try { assert.equal(buildId(), 'build-123') } finally { if (prev === undefined) delete process.env.PONOS_BUILD_ID; else process.env.PONOS_BUILD_ID = prev }
})

test('init 事件：携带 schemaVersion + buildId（含 PONOS_BUILD_ID 注入）', async () => {
  const configDir = join(tmp, 'c')
  mkdirSync(configDir, { recursive: true })
  const child = spawn(process.execPath, [
    KERNEL, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion',
  ], {
    env: { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir, PONOS_BUILD_ID: 'ci-42' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  const waiters = []
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const t = l.trim()
    if (!t) return
    if (waiters.length) waiters.shift()(t)
    else lines.push(t)
  })
  const nextEvent = (ms = 5000) => {
    if (lines.length) return Promise.resolve(JSON.parse(lines.shift()))
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout')), ms)
      waiters.push((l) => { clearTimeout(to); res(JSON.parse(l)) })
    })
  }
  try {
    const ev = await nextEvent()
    assert.equal(ev.type, 'system')
    assert.equal(ev.subtype, 'init')
    assert.equal(ev.schemaVersion, 1)
    assert.equal(ev.buildId, 'ci-42')
  } finally {
    try { child.stdin.end() } catch {}
  }
})
```

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/version.test.mjs`
Expected: FAIL —— `buildId is not a function` / init 事件无 schemaVersion/buildId

- [x] **Step 3: 实现 version.mjs + cli.mjs**

`version.mjs` 末尾追加：

```js
// buildId（D4-1）：构建/发布时经环境注入（如 PONOS_BUILD_ID=release-2026-08-21-a1b2），
// dev 默认 'dev'。与 /diag 交叉比对：kernelVersion + schemaVersion + buildId 三源合一。
export function buildId() {
  return process.env.PONOS_BUILD_ID || 'dev'
}
```

`kernel/cli.mjs`：import 加 `buildId, SCHEMA_VERSION`；init 事件（P5 Task 6 扩展后）追加：

```js
    schemaVersion: SCHEMA_VERSION,
    buildId: buildId(),
```

- [x] **Step 4: 实现 bridge.mjs diagInfo**

`server/bridge.mjs`：
1. `diagInfo` 定义处（原 line 558）追加字段：

```js
const diagInfo = { firstTokenOk: 0, firstTokenTotal: 0, kernelCrashCount: 0, lastApiSuccessAt: null,
  kernelVersion: '', schemaVersion: 0, buildId: '' }
```

2. 主会话 stdout 行循环（原 line 928 `rl.on('line', ...)` 解析块内，`session.firstTokenAt` 采集附近）补 init 采集：

```js
    if (parsed?.type === 'system' && parsed?.subtype === 'init') {
      if (parsed.version) diagInfo.kernelVersion = parsed.version
      if (parsed.schemaVersion) diagInfo.schemaVersion = parsed.schemaVersion
      if (parsed.buildId) diagInfo.buildId = parsed.buildId
    }
```

（/diag/info 端点原样返回 diagInfo，无需改动。）

- [x] **Step 5: 跑测试验证通过**

Run: `node --test server/version.test.mjs`
Expected: PASS（2 个测试）

- [x] **Step 6: 提交**

```bash
git add version.mjs kernel/cli.mjs server/bridge.mjs server/version.test.mjs
git commit -m "feat: 版本统一（SCHEMA_VERSION/buildId 单一数据源 + init/diag 上报，可交叉比对）"
```

---

### Task 4: 内核配置清单生成式 reference（D1-1）

**Files:**
- Create: `kernel/config-scan.mjs`（扫描器纯函数 + CLI 生成入口）
- Create: `docs/manual/kernel-config.md`（生成物，提交入库）
- Create: `server/config-scan.test.mjs`

**Interfaces:**
- Consumes: kernel/ 源码文件（扫描对象）
- Produces:
  - `scanKernelConfig({ dir })` → `{ env: string[], flags: string[] }`：
    - env：扫描 `*.mjs` 中 `process.env.X` / `env.X`（模块级 env 参数）引用名，去重排序（排除 `env` 裸名）
    - flags：扫描 `cli.mjs` 的 `case '--x':` 分支，去重排序
  - `renderConfigReference({ env, flags })` → string（markdown：env 表 + CLI flag 表，含"影响面"占位列，默认值/示例由人工补注）
  - CLI：`node kernel/config-scan.mjs [--out <path>]` → 打印或写文件（无 --out 打印 stdout）

- [x] **Step 1: 写失败测试**

```js
// server/config-scan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanKernelConfig, renderConfigReference } from '../kernel/config-scan.mjs'

const KERNEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel')

test('scanKernelConfig：盘点 env 引用（关键项存在）', () => {
  const r = scanKernelConfig({ dir: KERNEL_DIR })
  assert.ok(r.env.includes('ANTHROPIC_BASE_URL'))
  assert.ok(r.env.includes('ANTHROPIC_AUTH_TOKEN'))
  assert.ok(r.env.includes('CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS'))
  assert.ok(r.env.includes('PONOS_MOCK_API'))
  assert.ok(r.env.includes('CLAUDE_CONFIG_DIR'))
  // 去重 + 排序
  assert.equal(new Set(r.env).size, r.env.length)
  assert.deepEqual(r.env, [...r.env].sort())
})

test('scanKernelConfig：盘点 CLI flag（关键项存在）', () => {
  const r = scanKernelConfig({ dir: KERNEL_DIR })
  for (const f of ['--output-format', '--input-format', '--add-dir', '--resume', '--model', '--append-system-prompt-file']) {
    assert.ok(r.flags.includes(f), `flag 存在: ${f}`)
  }
})

test('renderConfigReference：markdown 输出含 env/flags 两节', () => {
  const md = renderConfigReference({ env: ['ANTHROPIC_BASE_URL'], flags: ['--add-dir'] })
  assert.ok(md.includes('# 内核配置参考'))
  assert.ok(md.includes('| 环境变量 | 默认值 | 示例 | 影响面 |'))
  assert.ok(md.includes('ANTHROPIC_BASE_URL'))
  assert.ok(md.includes('| 命令行参数 | 说明 |'))
  assert.ok(md.includes('--add-dir'))
})
```

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/config-scan.test.mjs`
Expected: FAIL —— `Cannot find module '../kernel/config-scan.mjs'`

- [x] **Step 3: 实现 kernel/config-scan.mjs**

```js
#!/usr/bin/env node
// 内核配置清单生成器（D1-1）：扫描 kernel/*.mjs 提取 env 引用与 CLI flag，
// 输出生成式 reference（docs/manual/kernel-config.md）。零依赖正则扫描。
// 用法：node kernel/config-scan.mjs [--out <path>]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENV_RE = /(?:process\.env|env)\.([A-Z][A-Z0-9_]*)/g
const FLAG_RE = /case\s+'([^']*)':/g

export function scanKernelConfig({ dir }) {
  const env = new Set()
  const flags = new Set()
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.mjs')) } catch { return { env: [], flags: [] } }
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf-8')
    let m
    ENV_RE.lastIndex = 0
    while ((m = ENV_RE.exec(src))) env.add(m[1])
    if (f === 'cli.mjs') {
      FLAG_RE.lastIndex = 0
      while ((m = FLAG_RE.exec(src))) {
        const flag = m[1]
        if (flag.startsWith('--')) flags.add(flag)
      }
    }
  }
  return { env: [...env].sort(), flags: [...flags].sort() }
}

export function renderConfigReference({ env = [], flags = [] } = {}) {
  const lines = [
    '# 内核配置参考（生成式）',
    '',
    '> 本文件由 `node kernel/config-scan.mjs` 生成，覆盖 kernel/ 源码中的 env 引用与 CLI flag。',
    '> 默认值/示例/影响面为人工补注（生成器只负责盘点名称）。',
    '',
    '## 环境变量',
    '',
    '| 环境变量 | 默认值 | 示例 | 影响面 |',
    '|---|---|---|---|',
  ]
  for (const e of env) lines.push(`| ${e} |  |  |  |`)
  lines.push('', '## 命令行参数', '', '| 命令行参数 | 说明 |', '|---|---|')
  for (const f of flags) lines.push(`| ${f} |  |`)
  return lines.join('\n') + '\n'
}

const isMain = process.argv[1] && import.meta.url === fileURLToPath(process.argv[1]).href
if (isMain) {
  const dir = join(dirname(fileURLToPath(import.meta.url)))
  const { env, flags } = scanKernelConfig({ dir })
  const md = renderConfigReference({ env, flags })
  const outIdx = process.argv.indexOf('--out')
  if (outIdx >= 0 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], md, 'utf-8')
    console.log(`[config-scan] ${env.length} env / ${flags.length} flags -> ${process.argv[outIdx + 1]}`)
  } else {
    process.stdout.write(md)
  }
}
```

- [x] **Step 4: 生成文档 + 验证**

Run: `node --test server/config-scan.test.mjs`
Expected: PASS（3 个测试）

Run: `node kernel/config-scan.mjs --out docs/manual/kernel-config.md`
Expected: 输出 `[config-scan] N env / M flags -> docs/manual/kernel-config.md`（随后人工补注默认值/示例，属文档维护，不在测试范围）

- [x] **Step 5: 提交**

```bash
git add kernel/config-scan.mjs docs/manual/kernel-config.md server/config-scan.test.mjs
git commit -m "feat(kernel): 配置清单生成式 reference（env/CLI flag 盘点 + 文档入库）"
```

---

### Task 5: 独立部署包（D3-1）

**Files:**
- Create: `kernel/package.json`
- Create: `kernel/.env.example`
- Create: `kernel/README.md`
- Create: `server/deploy-smoke.test.mjs`（Task 5 部分：部署包冒烟）

**Interfaces:**
- Consumes: `kernel/cli.mjs`（既有入口）
- Produces: 最小部署形态——`package.json`（无 dependencies，`npm start` = `node cli.mjs`，`bin` 指向 cli.mjs）+ `.env.example`（必需 env 模板）+ `README.md`（一步启动说明，配置方式与 GUI 集成方式两用）

- [x] **Step 1: 写失败测试**

```js
// server/deploy-smoke.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const KERNEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'kernel')
const tmp = mkdtempSync(join(tmpdir(), 'ponos-deploy-'))
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('部署包：package.json 零依赖 + start 指向 cli.mjs + bin', () => {
  const pkg = JSON.parse(readFileSync(join(KERNEL_DIR, 'package.json'), 'utf-8'))
  assert.equal(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0, true)
  assert.ok(pkg.scripts?.start?.includes('cli.mjs'))
  assert.ok(pkg.bin && Object.values(pkg.bin).some((v) => v.includes('cli.mjs')))
})

test('部署包：.env.example 含必需 env 模板', () => {
  const sample = readFileSync(join(KERNEL_DIR, '.env.example'), 'utf-8')
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR']) {
    assert.ok(sample.includes(key), `.env.example 含 ${key}`)
  }
})

test('部署包：独立运行冒烟——--help 退出 0', async () => {
  const child = spawn(process.execPath, [join(KERNEL_DIR, 'cli.mjs'), '--help'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let code = null
  child.on('close', (c) => { code = c })
  const deadline = Date.now() + 8000
  while (code === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  assert.equal(code, 0)
})

test('部署包：无 GUI mock 完成一轮对话', async () => {
  const configDir = join(tmp, 'c')
  mkdirSync(configDir, { recursive: true })
  const child = spawn(process.execPath, [
    join(KERNEL_DIR, 'cli.mjs'), '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion',
  ], {
    env: { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  const waiters = []
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const t = l.trim()
    if (!t) return
    if (waiters.length) waiters.shift()(t)
    else lines.push(t)
  })
  const nextEvent = (ms = 5000) => {
    if (lines.length) return Promise.resolve(JSON.parse(lines.shift()))
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout')), ms)
      waiters.push((l) => { clearTimeout(to); res(JSON.parse(l)) })
    })
  }
  try {
    const init = await nextEvent()
    assert.equal(init.subtype, 'init')
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n')
    const a = await nextEvent()
    assert.equal(a.type, 'assistant')
    const r = await nextEvent()
    assert.equal(r.type, 'result')
  } finally {
    try { child.stdin.end() } catch {}
  }
})
```

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/deploy-smoke.test.mjs`
Expected: FAIL —— `kernel/package.json` 不存在（读取报错）

- [x] **Step 3: 创建部署包文件**

`kernel/package.json`：

```json
{
  "name": "ponos-kernel",
  "version": "0.1.0",
  "description": "Ponos-turbo 内核独立部署包（零 npm 依赖，无 GUI）",
  "type": "module",
  "bin": { "ponos-kernel": "cli.mjs" },
  "main": "engine.mjs",
  "scripts": {
    "start": "node cli.mjs",
    "smoke": "node cli.mjs --help"
  },
  "engines": { "node": ">=18" },
  "license": "UNLICENSED"
}
```

> 版本同步注记：package.json version 与 version.mjs `PONOS_VERSION`（'dev 0.1'）同线；发布时同步修改（D4-1 交叉比对项）。

`kernel/.env.example`：

```bash
# Ponos-turbo 内核必需环境变量（独立部署最小集；GUI 集成时由 bridge 注入，无需手动配置）
# Anthropic 兼容端点（必填）
ANTHROPIC_BASE_URL=https://api.example.com
ANTHROPIC_AUTH_TOKEN=sk-xxxx
ANTHROPIC_MODEL=your-model

# 数据目录（可选，默认 ~/.ponos）
# CLAUDE_CONFIG_DIR=C:/Users/you/.ponos

# 其他可选调优项见 docs/manual/kernel-config.md
```

`kernel/README.md`：

```markdown
# Ponos-turbo 内核（独立部署）

零 npm 依赖的 agent 内核。GUI 集成形态由 bridge spawn；本包为无 GUI 最小部署。

## 一步启动

1. 复制 `.env.example` 为 `.env` 并填入 `ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL`
2. 加载环境变量后运行：

   node cli.mjs

## 交互模式

- 标准输入逐行 NDJSON（type: user / control_request），标准输出 NDJSON 事件流
- 协议契约见 docs/bridge-contract.md

## 配置入口

- 环境变量 + CLI flag：docs/manual/kernel-config.md（生成式清单）
- 分层 settings（user < project < local）：见 kernel/settings.mjs 与生产化规划 Phase 4/6
```

- [x] **Step 4: 跑测试验证通过**

Run: `node --test server/deploy-smoke.test.mjs`
Expected: PASS（4 个测试）

- [x] **Step 5: 提交**

```bash
git add kernel/package.json kernel/.env.example kernel/README.md server/deploy-smoke.test.mjs
git commit -m "feat(kernel): 独立部署包（零依赖 package.json + env 模板 + README 一步启动）"
```

---

### Task 6: 迁移演练 + 配置漂移检测（D2-3 + D1-2）

**Files:**
- Modify: `kernel/settings.mjs`（追加 `SETTINGS_DEFAULTS` / `diffFromDefault`）
- Test: `server/deploy-smoke.test.mjs`（追加迁移演练集成）+ `server/schema.test.mjs`（追加 diffFromDefault 单元）

**Interfaces:**
- Consumes: `loadSettings`（P4 Task 1，Task 1 已加 schema）；`createSessionStore`（Task 2）
- Produces:
  - `SETTINGS_DEFAULTS`：`{ model: '', maxOutputTokens: 64000, autoApproveHighRisk: false, disallowedTools: [], env: {}, compact: { thresholdTokens: 0, reserveTokens: 0, maxToolResults: 0 }, memory: { inject: true, capture: true }, hooks: [] }`
  - `diffFromDefault(settings)` → `[{ key, value, default }]`：非默认项列表（JSON 序列化比较；undefined/缺键不算漂移）
  - 集成验收：无 schemaVersion 旧 settings + 无 meta 旧 transcript → loadSettings 迁移 v1 + spawn `--resume` 完成一轮（内容等价、可读）

- [x] **Step 1: 写失败测试（追加）**

`server/schema.test.mjs` 追加单元：

```js
import { diffFromDefault, SETTINGS_DEFAULTS } from '../kernel/settings.mjs'

test('diffFromDefault：默认值 → 空；非默认 → 标注漂移项', () => {
  assert.deepEqual(diffFromDefault({ ...SETTINGS_DEFAULTS }), [])
  const r = diffFromDefault({ ...SETTINGS_DEFAULTS, model: 'custom-model' })
  assert.equal(r.length, 1)
  assert.equal(r[0].key, 'model')
  assert.equal(r[0].value, 'custom-model')
  const hooks = diffFromDefault({ ...SETTINGS_DEFAULTS, hooks: [{ event: 'sessionStart' }] })
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].key, 'hooks')
})
```

`server/deploy-smoke.test.mjs` 追加迁移演练集成：

```js
test('迁移演练：旧 settings + 旧 transcript → --resume 完成一轮（内容等价）', async () => {
  const configDir = join(tmp, 'mc')
  const cwd = join(tmp, 'mproj')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  // 旧格式 settings（无 schemaVersion）+ 旧格式 transcript（无 meta 首行）
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ model: 'legacy-model' }), 'utf-8')
  const legacyLines = [
    JSON.stringify({ type: 'user', id: 'u1', seq: 1, timestamp: new Date().toISOString(), message: { role: 'user', content: '旧问题' } }),
    JSON.stringify({ type: 'assistant', id: 'a1', seq: 2, timestamp: new Date().toISOString(), message: { role: 'assistant', content: '旧回答' } }),
  ]
  const sid = '11111111-2222-3333-4444-555555555555'
  const projDir = join(configDir, 'projects', 'mproj')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, sid + '.jsonl'), legacyLines.join('\n') + '\n', 'utf-8')
  const child = spawn(process.execPath, [
    join(KERNEL_DIR, 'cli.mjs'), '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'AskUserQuestion', '--resume', sid, '--add-dir', cwd,
  ], {
    env: { ...process.env, PONOS_MOCK_API: '1', CLAUDE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  const waiters = []
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const t = l.trim()
    if (!t) return
    if (waiters.length) waiters.shift()(t)
    else lines.push(t)
  })
  const nextEvent = (ms = 5000) => {
    if (lines.length) return Promise.resolve(JSON.parse(lines.shift()))
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout')), ms)
      waiters.push((l) => { clearTimeout(to); res(JSON.parse(l)) })
    })
  }
  try {
    const init = await nextEvent()
    assert.equal(init.session_id, sid)
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '继续' } }) + '\n')
    const a = await nextEvent()
    assert.equal(a.type, 'assistant')
    const r = await nextEvent()
    assert.equal(r.type, 'result')
    // 旧 transcript 内容保持可读（新轮追加后仍含旧条目）
    const raw = readFileSync(join(projDir, sid + '.jsonl'), 'utf-8')
    assert.ok(raw.includes('旧问题') && raw.includes('旧回答'))
  } finally {
    try { child.stdin.end() } catch {}
  }
})
```

> 注：`writeFileSync` 需在 deploy-smoke.test.mjs 顶部 import 列表补 `writeFileSync`（既有 `readFileSync`）。

- [x] **Step 2: 跑测试验证失败**

Run: `node --test server/schema.test.mjs server/deploy-smoke.test.mjs`
Expected: 新增 FAIL —— `diffFromDefault is not a function`；迁移演练（resume 旧 transcript 依赖 Task 2 meta 跳过——若 Task 2 已落地则通过，此步用于确认集成接线）

- [x] **Step 3: 实现 settings.mjs 追加**

`kernel/settings.mjs` 末尾追加：

```js
// —— D1-2 配置漂移检测：运行配置 vs schema 默认值 ——
export const SETTINGS_DEFAULTS = {
  model: '',
  maxOutputTokens: 64000,
  autoApproveHighRisk: false,
  disallowedTools: [],
  env: {},
  compact: { thresholdTokens: 0, reserveTokens: 0, maxToolResults: 0 },
  memory: { inject: true, capture: true },
  hooks: [],
}

export function diffFromDefault(settings = {}) {
  const out = []
  for (const k of Object.keys(SETTINGS_DEFAULTS)) {
    if (settings[k] === undefined) continue
    if (JSON.stringify(settings[k]) !== JSON.stringify(SETTINGS_DEFAULTS[k])) {
      out.push({ key: k, value: settings[k], default: SETTINGS_DEFAULTS[k] })
    }
  }
  return out
}
```

（/diag/info 的漂移展示由 P3 计划 Task 6 的 configSummary 端点消费本函数——执行时合并输出 `changedFromDefault`；本计划交付内核侧纯函数 + 测试。）

- [x] **Step 4: 跑测试验证通过**

Run: `node --test server/schema.test.mjs server/deploy-smoke.test.mjs`
Expected: 全 PASS（schema 7 个 + deploy 5 个）

- [x] **Step 5: 全量回归 + 提交**

Run: `node --test "server/*.test.mjs"`
Expected: 全绿（222+ 既有测试 + 本计划新增）

```bash
git add kernel/settings.mjs server/schema.test.mjs server/deploy-smoke.test.mjs
git commit -m "feat(kernel): 配置漂移检测（diffFromDefault）+ 迁移演练验收（旧 settings/transcript 升级等价）"
```

---

## Self-Review

**1. Spec coverage（对照 docs/production/deploy.md §4 任务清单）：**
- D1-1 配置清单 → Task 4（config-scan 生成器 + docs/manual/kernel-config.md 入库）
- D2-1 schema 版本化 → Task 1（SCHEMA_VERSION + 迁移链 + 高于版本拒绝）
- D2-2 transcript 版本标记 → Task 2（meta 首行 + 旧格式 v1 适配）
- D2-3 迁移演练 → Task 6（旧 settings/transcript 样本 → 升级后 --resume 内容等价）
- D3-1 独立部署包 → Task 5（package.json/.env.example/README + 冒烟）
- D4-1 版本号统一 → Task 3（SCHEMA_VERSION/buildId 单一数据源 + init/diagInfo 上报）
- D1-2 配置漂移检测（P2 增强）→ Task 6（diffFromDefault 纯函数，/diag 展示随 P3 端点扩展）

**2. Placeholder scan：** 无 TBD/TODO；每步骤含完整测试与实现代码。Task 4 文档补注（默认值/示例人工补注）明确标注为文档维护动作而非代码占位；Task 3 bridge 注入点给出精确的既有代码锚点（diagInfo line 558、stdout 行循环解析块）与完整代码。跨计划引用（P4 loadSettings、P4-5 meta、P3 /diag configSummary）均给出既有签名/语义，不依赖未定义内容。

**3. Type consistency：** `SCHEMA_VERSION`（version.mjs 定义，settings.mjs/cli.mjs/bridge 消费）、`buildId()`（Task 3 定义，cli init 上报）、`TRANSCRIPT_SCHEMA_VERSION`（Task 2 定义，meta 写入/load 返回）、`migrateSettings/validateSettings`（Task 1 定义，loadSettings 接线，Task 6 迁移演练消费）、`diffFromDefault/SETTINGS_DEFAULTS`（Task 6 定义与测试断言一致）跨任务签名一致；loadSettings 返回的 `schema` 字段（version/migrated/error）Task 1 定义、Task 6 迁移演练隐式消费；init 事件字段（schemaVersion/buildId）Task 3 定义与测试断言一致。

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-08-21-kernel-deploy.md`（6 个 TDD 任务，覆盖 D1-1/D2-1/D2-2/D2-3/D3-1/D4-1/D1-2）。六份实现计划至此全部完成（P4-5 / P1 / P2 / P3 / P4 / P5 / P6）。两种执行方式：

**1. Subagent-Driven（推荐）** —— 每个任务派发独立 subagent，任务间审查，快速迭代
**2. Inline Execution** —— 本会话用 executing-plans 批量执行 + 检查点审查

选哪种？
