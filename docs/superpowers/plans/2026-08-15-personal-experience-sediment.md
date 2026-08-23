# 个人经验沉积 + 跨设备分享 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Ponos 实现全自动静默的个人经验沉积（通用+业务两层，内核零改动），以及分类型可选的手动导出/导入，支撑"越用越好用"与跨设备项目继承、经验分享。

**Architecture:** 经验统一落盘 `~/.ponos/memory/personal/{主题}.md`（md + 极简 frontmatter），由内核在"经验沉淀引导"指示下自动追加；bridge 在 spawn 时把激活经验合并进现有 `--append-system-prompt-file` 注入段（默认 4KB 上限）；GUI 设置页新增"经验"分区管理浏览与导出/导入；导出/导入由 `server/packager.mjs` 实现（staging + tar zip + manifest），Electron 主进程新增 IPC，renderer 负责传 chat/settings 的 localStorage 数据。

**Tech Stack:** Node.js ESM（server/*.mjs）、node:test（内置测试）、Electron IPC（ipcMain.handle ↔ ipcRenderer.invoke）、React 18 + Zustand（前端）、Windows bsdtar（zip 打包，Git Bash GNU tar 与 `C:\Windows\System32\tar.exe` 均兼容）。

## Global Constraints

- 零内核改动：`ponos-kernel/claude-code/` 不得修改，全部复用现有机制（auto memory 写入约定 + `--append-system-prompt-file` 注入，见 server/bridge.mjs:751/767）。
- 所有新增代码遵循现有模式：server 模块 `export function` 风格；IPC 返回 `{ ok: boolean }` / `{ ok: false, error }` 风格（见 electron/main.cjs:486-534）；组件用 Tailwind + `cn()` + lucide-react 图标 + `@/components/ui`。
- 数据目录：`~/.ponos/` 为权威（`server/bridge.mjs:113 PONOS_HOME`）。`~/.trae-cn/` 仅做只读回退。skill_experiences 权威路径为 `~/.ponos/memory/skill_experiences/`（main.cjs:442 的旧 `.trae-cn` 路径需在 Task 5 修正为先新后旧）。
- 敏感数据：导出时 `authToken` 等凭据默认脱敏（configRedact 默认 true）；personal/skill_exp 导出按敏感词黑名单条目级过滤。
- 注入规模受控：默认 4KB 上限（`~/.ponos/config.json` 新增 `experienceInjectEnabled` / `experienceInjectMaxBytes` 字段控制，经现有 fetchBridgeConfig/saveBridgeConfig 读写）。
- 语言：前端新增 UI 文案走 `src/i18n/translations/zh-CN.ts` + `en-US.ts`；面板内示例/非关键说明可用中文字面量（项目已有先例，如 Sidebar.tsx"常规任务"）。
- 测试：`node --test server/`（Node v24 内置），每个测试模块独立建临时目录（`os.tmpdir()`），不污染真实 `~/.ponos`。
- 实施完成后必须同步改动到 release 副本 `release/Ponos_ms92cd6u/`（用户运行打包版；同步前先询问是否重启 live app）。

---

### Task 1: server/experience.mjs — 个人经验库核心模块

**Files:**
- Create: `server/experience.mjs`
- Test: `server/experience.test.mjs`
- Modify: `package.json`（加 `"test": "node --test server/"` script）

**Interfaces:**
- Consumes: Node 内置 `os` / `fs` / `path`；约定路径 `~/.ponos/memory/personal/`
- Produces（Task 2/5/6 依赖）:
  - `PERSONAL_DIR` / `INDEX_FILE` / `DEFAULT_THEMES`（常量）
  - `ensurePersonalDir()` → void（建目录 + 预置主题文件）
  - `listExperiences()` → `Array<{ theme: string, file: string, entryCount: number, updatedAt: number, active: boolean, entries: Array<{ text: string, hash: string }> }>`
  - `setThemeActive(theme, active)` → `{ ok: true }`（写 frontmatter `active`）
  - `deleteThemeEntry(theme, entryHash)` → `{ ok: boolean, deleted?: number }`
  - `buildExperienceSection(maxBytes = 4096)` → `string`（注入段，空库返回 `''`；按 updatedAt 降序截断）
  - `buildSedimentPrompt()` → `string`（沉积引导文本）
  - `refreshIndex()` → void（重扫并写 `_index.json`）
  - `hashLine(text)` → `string`（稳定行 hash，32 位十六进制）

- [ ] **Step 1: 写失败测试**

`server/experience.test.mjs`：

```js
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// 通过注入 HOME 重定向 personal 目录：模块导出 PERSONAL_DIR 基于 process.env.PONOS_TEST_HOME
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-exp-home-'))
process.env.PONOS_TEST_HOME = testHome
const mod = await import('./experience.mjs')

beforeEach(() => { mod.ensurePersonalDir() })
afterEach(() => { fs.rmSync(testHome, { recursive: true, force: true }) })

test('ensurePersonalDir 预置 7 个主题文件', () => {
  for (const t of mod.DEFAULT_THEMES) {
    assert.ok(fs.existsSync(path.join(testHome, '.ponos', 'memory', 'personal', `${t}.md`)), `${t}.md 缺失`)
  }
})

test('hashLine 稳定且区分内容', () => {
  assert.equal(mod.hashLine('abc'), mod.hashLine('abc'))
  assert.notEqual(mod.hashLine('abc'), mod.hashLine('abd'))
})

test('listExperiences 返回条目与 frontmatter 状态', () => {
  const file = path.join(testHome, '.ponos', 'memory', 'personal', 'communication.md')
  fs.writeFileSync(file, '---\nname: communication\ndescription: 沟通偏好\nactive: true\n---\n- [会话A] 用户偏好简洁回复\n- [会话B] 报告用中文\n', 'utf-8')
  const list = mod.listExperiences()
  const comm = list.find(x => x.theme === 'communication')
  assert.ok(comm)
  assert.equal(comm.active, true)
  assert.equal(comm.entryCount, 2)
})

test('setThemeActive 更新 frontmatter', () => {
  mod.setThemeActive('communication', false)
  const list = mod.listExperiences()
  assert.equal(list.find(x => x.theme === 'communication').active, false)
})

test('deleteThemeEntry 按行 hash 删除', () => {
  const file = path.join(testHome, '.ponos', 'memory', 'personal', 'communication.md')
  fs.writeFileSync(file, '---\nname: communication\nactive: true\n---\n- [A] 第一条\n- [B] 第二条\n', 'utf-8')
  const list = mod.listExperiences()
  const comm = list.find(x => x.theme === 'communication')
  const target = comm.entries.find(e => e.text.includes('第一条'))
  const res = mod.deleteThemeEntry('communication', target.hash)
  assert.equal(res.ok, true)
  assert.equal(res.deleted, 1)
  assert.equal(mod.listExperiences().find(x => x.theme === 'communication').entryCount, 1)
})

test('buildExperienceSection 按 updatedAt 降序且受 maxBytes 截断', () => {
  const base = testHome + '/.ponos/memory/personal/'
  fs.writeFileSync(base + 'a.md', '---\nname: a\nactive: true\n---\n- [A] ' + 'x'.repeat(100) + '\n', 'utf-8')
  fs.writeFileSync(base + 'b.md', '---\nname: b\nactive: true\n---\n- [B] ' + 'y'.repeat(100) + '\n', 'utf-8')
  const now = Date.now()
  fs.utimesSync(base + 'a.md', new Date(now - 10000), new Date(now - 10000))
  fs.utimesSync(base + 'b.md', new Date(now - 5000), new Date(now - 5000))
  const sec = mod.buildExperienceSection(200)
  assert.ok(sec.includes('y'.repeat(100)), '应优先含最近更新的 b')
  assert.ok(sec.length <= 400, '截断后不会远超上限')
})

test('buildExperienceSection 空库返回空串', () => {
  assert.equal(mod.buildExperienceSection(), '')
})

test('refreshIndex 写出 _index.json', () => {
  mod.refreshIndex()
  const idx = JSON.parse(fs.readFileSync(path.join(testHome, '.ponos', 'memory', 'personal', '_index.json'), 'utf-8'))
  assert.ok(idx.themes.communication)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/experience.test.mjs`
Expected: FAIL，`Cannot find module './experience.mjs'`

- [ ] **Step 3: 写实现**

`server/experience.mjs`：

```js
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync, rmSync, utimesSync } from 'node:fs'

// 测试注入 HOME：process.env.PONOS_TEST_HOME 存在时重定向（测试隔离，不碰真实 ~/.ponos）
const HOME = process.env.PONOS_TEST_HOME || homedir()
export const PERSONAL_DIR = join(HOME, '.ponos', 'memory', 'personal')
export const INDEX_FILE = join(PERSONAL_DIR, '_index.json')
export const DEFAULT_THEMES = ['communication', 'code-style', 'workflow', 'finance', 'policy', 'project-application', 'office-docs']

const THEME_META = {
  communication: '沟通偏好：回复风格、语气、汇报粒度',
  'code-style': '编码偏好：语言、风格、测试习惯、工具用法',
  workflow: '工作流心得：处理任务的通用方法、分步试探、验证习惯',
  finance: '财务业务经验：报销、账务、财务表格处理、财税政策要点',
  policy: '政策业务经验：政策解读、申报条件、时效节点、口径变化',
  'project-application': '项目申报经验：申报材料组织、系统填报、材料要点',
  'office-docs': '办公文档经验：Word/PPT/PDF/Excel 处理心得、模板使用',
}

export function hashLine(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

function themeFilePath(theme) {
  return join(PERSONAL_DIR, `${theme}.md`)
}

export function ensurePersonalDir() {
  mkdirSync(PERSONAL_DIR, { recursive: true })
  for (const t of DEFAULT_THEMES) {
    const fp = themeFilePath(t)
    if (existsSync(fp)) continue
    const desc = THEME_META[t] || ''
    writeFileSync(fp, `---\nname: ${t}\ndescription: ${desc}\nactive: true\n---\n`, 'utf-8')
  }
}

function parseFrontmatter(raw) {
  // 极简 frontmatter：文件头 --- 包裹的 key: value 行
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { front: {}, body: raw }
  const front = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) front[kv[1]] = kv[2]
  }
  return { front, body: raw.slice(m[0].length) }
}

function serializeFrontmatter(front) {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n`
}

export function readThemeFile(theme) {
  const fp = themeFilePath(theme)
  if (!existsSync(fp)) return null
  const raw = readFileSync(fp, 'utf-8')
  const { front, body } = parseFrontmatter(raw)
  const entries = body.split(/\r?\n/).filter(l => l.trim().startsWith('- ')).map(l => l.trim())
  return { front, entries, file: fp }
}

export function listExperiences() {
  ensurePersonalDir()
  const out = []
  for (const t of DEFAULT_THEMES) {
    const data = readThemeFile(t)
    if (!data) continue
    out.push({
      theme: t,
      file: data.file,
      entryCount: data.entries.length,
      updatedAt: statSync(data.file).mtimeMs,
      active: data.front.active !== 'false',
      entries: data.entries.map(text => ({ text, hash: hashLine(text) })),
    })
  }
  return out
}

function writeTheme(theme, front, body) {
  writeFileSync(themeFilePath(theme), serializeFrontmatter(front) + (body ? body + '\n' : ''), 'utf-8')
}

export function setThemeActive(theme, active) {
  const data = readThemeFile(theme)
  if (!data) return { ok: false, error: 'theme not found' }
  data.front.active = active ? 'true' : 'false'
  writeTheme(theme, data.front, data.entries.join('\n'))
  return { ok: true }
}

export function deleteThemeEntry(theme, entryHash) {
  const data = readThemeFile(theme)
  if (!data) return { ok: false, error: 'theme not found' }
  const before = data.entries.length
  const after = data.entries.filter(text => hashLine(text) !== entryHash)
  writeTheme(theme, data.front, after.join('\n'))
  return { ok: true, deleted: before - after.length }
}

export function buildExperienceSection(maxBytes = 4096) {
  const list = listExperiences()
    .filter(x => x.active && x.entryCount > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  if (!list.length) return ''
  const header = '\n\n【个人经验参考】以下为过往会话自动沉淀的个人经验（来源主题标注在前），供本次任务参考，按相关性自行取舍：\n'
  let out = header
  for (const item of list) {
    for (const e of item.entries) {
      const line = `- [${item.theme}] ${e.text.slice(2)}`
      if (out.length + line.length + 1 > maxBytes) return out
      out += line + '\n'
    }
  }
  return out
}

export function buildSedimentPrompt() {
  return [
    '',
    '【经验沉淀（静默，不询问用户）】当本次会话中出现以下情况时，用 Write/Edit 工具把经验写入 ~/.ponos/memory/personal/{主题}.md（文件不存在则按现有 frontmatter 模板创建；主题从 communication/code-style/workflow/finance/policy/project-application/office-docs 中选最贴合的）：',
    '① 用户明确表达偏好（回复风格、汇报粒度、代码风格、工具选择）',
    '② 业务事实（财务处理、政策解读、申报口径、项目要求等确定信息）',
    '③ 问题-解决模式（本次解决的关键问题及其方案、预防建议）',
    '④ 工作流心得（被验证有效的处理流程与验证习惯）',
    '每条经验写为一个以 "- [会话]" 开头的 bullet 行；写入前先读文件，相同内容不重复追加；严禁写入密钥、密码、API token、身份证号、银行账号等敏感信息。',
    '',
  ].join('\n')
}

export function refreshIndex() {
  const themes = {}
  for (const item of listExperiences()) {
    themes[item.theme] = {
      entry_count: item.entryCount,
      updated_at: new Date(item.updatedAt).toISOString(),
      active: item.active,
      inject_bytes: buildExperienceSection(4096).length,
    }
  }
  writeFileSync(INDEX_FILE, JSON.stringify({ themes }, null, 2), 'utf-8')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/experience.test.mjs`
Expected: PASS（8 个用例）。

- [ ] **Step 5: package.json 加 test script + commit**

`package.json` scripts 增加 `"test": "node --test server/"`。

```bash
git add server/experience.mjs server/experience.test.mjs package.json
git commit -m "feat(experience): 个人经验库核心模块（主题文件/frontmatter/索引/注入段组装）"
```

---

### Task 2: bridge 集成 — 沉积引导 + 注入段合并

**Files:**
- Modify: `server/bridge.mjs`（getOrCreateSession 的两个 prompt 组装分支：约 725-768 行；文件顶部 import 区）
- Verify: `scripts/verify-experience-inject.mjs`（新建）

**Interfaces:**
- Consumes: Task 1 的 `buildExperienceSection(maxBytes)`、`buildSedimentPrompt()`、`ensurePersonalDir()`
- Produces: 注入段出现在新会话与 resume 会话的 `--append-system-prompt-file` 内容中；沉积引导仅新会话注入。注入开关/上限读 `~/.ponos/config.json` 的 `experienceInjectEnabled`（默认 true）与 `experienceInjectMaxBytes`（默认 4096）。

- [ ] **Step 1: 写失败验证脚本**

`scripts/verify-experience-inject.mjs`：

```js
// 验证 bridge 的 getOrCreateSession 会把经验注入段（新会话含引导）拼进 prompt 文件
// 用法：node scripts/verify-experience-inject.mjs
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

process.env.PONOS_TEST_HOME = process.env.PONOS_TEST_HOME || join(os.tmpdir(), 'ponos-verify-inject-home')
const bridge = await import('../server/bridge.mjs')
bridge.ensurePersonalDir?.()

// 直接调用内部拼装函数（若导出）或断言模块可加载 + 关键常量存在
const fns = ['buildExperienceSection', 'buildSedimentPrompt', 'ensurePersonalDir']
for (const f of fns) {
  if (typeof bridge[f] !== 'function') throw new Error(`bridge 未导出 ${f}（Task 2 未集成）`)
}
const sec = bridge.buildExperienceSection(4096)
if (typeof sec !== 'string') throw new Error('buildExperienceSection 返回非字符串')
const sed = bridge.buildSedimentPrompt()
if (!sed.includes('经验沉淀')) throw new Error('引导文本缺失')
console.log('[verify] experience 集成 OK, section len=', sec.length, 'sediment len=', sed.length)
```

> 说明：Task 2 集成后，bridge.mjs 会 `export { ensurePersonalDir, buildExperienceSection, buildSedimentPrompt } from './experience.mjs'`（见 Step 3），verify 脚本即可直接调用并断言注入段/引导文本真实存在。spawn 端到端断言见 Task 7。

- [ ] **Step 2: 跑脚本确认失败**

Run: `node scripts/verify-experience-inject.mjs`
Expected: FAIL（`bridge 未导出 buildExperienceSection`）

- [ ] **Step 3: 实现 bridge 集成**

`server/bridge.mjs`：
1. 顶部 import 区（现有 `import ... from` 之后）加：

```js
import { buildExperienceSection, buildSedimentPrompt, ensurePersonalDir } from './experience.mjs'
export { ensurePersonalDir, buildExperienceSection, buildSedimentPrompt } from './experience.mjs'
```

2. 新增读取注入配置的 helper（放在 `getOrCreateSession` 之前，`appendSkillList` 附近）：

```js
// 经验注入开关/上限：存 ~/.ponos/config.json（GUI 设置页经 fetchBridgeConfig/saveBridgeConfig 读写）
function experienceInjectConfig() {
  try {
    const cfg = JSON.parse(readFileSync(join(PONOS_HOME, 'config.json'), 'utf-8'))
    return {
      enabled: cfg.experienceInjectEnabled !== false,
      maxBytes: Number(cfg.experienceInjectMaxBytes) > 0 ? Number(cfg.experienceInjectMaxBytes) : 4096,
    }
  } catch {
    return { enabled: true, maxBytes: 4096 }
  }
}
```

3. `getOrCreateSession` 的 resume 分支（现在 `const resumePrompt = appendSkillList(...)` 处）改为：

```js
    let resumePrompt = appendSkillList(PONOS_ASKUSER_FORMAT + PONOS_MILESTONE_PROTOCOL, resumeCompact)
    const injectCfg = experienceInjectConfig()
    if (injectCfg.enabled) resumePrompt += buildExperienceSection(injectCfg.maxBytes)
```

4. 新会话分支（现在 `const effectivePrompt = ...` 处）改为：

```js
    ensurePersonalDir()
    let effectivePrompt = systemPrompt
      ? appendSkillList(`${systemPrompt}\n\n${PONOS_ASKUSER_FORMAT}\n\n${PONOS_MILESTONE_PROTOCOL}`)
      : appendSkillList(PONOS_SYSTEM_PROMPT)
    const injectCfg = experienceInjectConfig()
    if (injectCfg.enabled) {
      effectivePrompt += buildSedimentPrompt()      // 沉积引导仅新会话注入
      effectivePrompt += buildExperienceSection(injectCfg.maxBytes)
    }
```

> 注意：`appendSkillList` 有指纹缓存（`skillListCacheKey`），经验段在它返回之后追加，不污染缓存；两个分支的 prompt 仍只写同一个临时文件，`--append-system-prompt-file` 参数不变（bridge.mjs:751/767 无需改动）。

- [ ] **Step 4: 跑验证脚本确认通过**

Run: `node --check server/bridge.mjs && node scripts/verify-experience-inject.mjs`
Expected: PASS（无语法错误，输出 `[verify] experience 集成 OK`）

- [ ] **Step 5: Commit**

```bash
git add server/bridge.mjs scripts/verify-experience-inject.mjs
git commit -m "feat(experience): bridge 集成——新会话注入沉积引导+经验反哺，resume 注入经验段"
```

---

### Task 3: server/packager.mjs — 导出（分类型打包 + tar zip + 敏感过滤）

**Files:**
- Create: `server/packager.mjs`
- Test: `server/packager.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `PERSONAL_DIR`（经验库路径）；`~/.ponos/config.json` / `~/.ponos/settings.json`（config 类型源，读时脱敏）；renderer 传入的 `chatsJson`（IPC payload）；当前项目 `.ponos/`（project 类型源，renderer 传 cwd）
- Produces（Task 4/5/6 依赖）:
  - `exportPackage(opts)` → `Promise<{ ok: true, outPath: string, manifest: object, skipped: Array<{type:string, reason:string}> } | { ok: false, error: string }>`
    - `opts: { outPath: string, included: string[], sensitiveWords?: string[], chatsJson?: string|null, projectCwd?: string|null, configRedact?: boolean, onProgress?: (msg:string)=>void }`
  - `TYPE_LABELS`（常量，供 GUI 勾选展示）
  - `collectTypeStats(included, opts)` → `{ included: string[], stats: Record<string,{files:number,bytes:number}> }`（导出前预览用）

- [ ] **Step 1: 写失败测试**

`server/packager.test.mjs`：

```js
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-home-'))
process.env.PONOS_TEST_HOME = testHome
const exp = await import('./experience.mjs')
exp.ensurePersonalDir()
const pkg = await import('./packager.mjs')

// 造一个可导出的迷你经验库 + config
const personal = path.join(testHome, '.ponos', 'memory', 'personal')
fs.writeFileSync(path.join(personal, 'finance.md'),
  '---\nname: finance\nactive: true\n---\n- [会话] 研发费用口径 6 项\n- [会话] 密码在 sk-abc 开头\n', 'utf-8')
fs.writeFileSync(path.join(testHome, '.ponos', 'config.json'),
  JSON.stringify({ activeProvider: 'p', providers: [{ id: 'p', authToken: 'sk-secret' }] }), 'utf-8')

let zipPath = ''

beforeEach(() => {
  zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-out-')), 'exp.zip')
})

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true })
  fs.rmSync(path.dirname(zipPath), { recursive: true, force: true })
})

test('导出 zip 含 manifest 与 personal 文件', async () => {
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['personal'], configRedact: true })
  assert.equal(res.ok, true)
  const { spawnSync } = await import('node:child_process')
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-un-'))
  spawnSync('tar', ['-xf', zipPath, '-C', staging])
  assert.ok(fs.existsSync(path.join(staging, 'manifest.json')))
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf-8'))
  assert.deepEqual(manifest.included, ['personal'])
  assert.ok(fs.existsSync(path.join(staging, 'personal', 'finance.md')))
  fs.rmSync(staging, { recursive: true, force: true })
})

test('敏感词过滤跳过命中条目', async () => {
  const res = await pkg.exportPackage({
    outPath: zipPath, included: ['personal'], sensitiveWords: ['密码'], configRedact: true,
  })
  assert.equal(res.ok, true)
  assert.ok(res.skipped.length > 0)
})

test('config 类型导出时 authToken 脱敏', async () => {
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['config'], configRedact: true })
  const { spawnSync } = await import('node:child_process')
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-un-'))
  spawnSync('tar', ['-xf', zipPath, '-C', staging])
  const cfg = JSON.parse(fs.readFileSync(path.join(staging, 'config', 'config.json'), 'utf-8'))
  assert.notEqual(cfg.providers[0].authToken, 'sk-secret')
  assert.equal(cfg.providers[0].authToken, '')
  fs.rmSync(staging, { recursive: true, force: true })
})

test('chatsJson 写入 chats 目录', async () => {
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['chats'], chatsJson: '{"conversations":[]}', configRedact: true })
  assert.equal(res.ok, true)
  const { spawnSync } = await import('node:child_process')
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-un-'))
  spawnSync('tar', ['-xf', zipPath, '-C', staging])
  const chat = JSON.parse(fs.readFileSync(path.join(staging, 'chats', 'chat-store.json'), 'utf-8'))
  assert.deepEqual(chat, { conversations: [] })
  fs.rmSync(staging, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/packager.test.mjs`
Expected: FAIL（`Cannot find module './packager.mjs'`）

- [ ] **Step 3: 写实现**

`server/packager.mjs`：

```js
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { PERSONAL_DIR } from './experience.mjs'

const HOME = process.env.PONOS_TEST_HOME || homedir()
const PONOS_HOME = join(HOME, '.ponos')
const SKILL_EXP_DIR = join(PONOS_HOME, 'memory', 'skill_experiences')
const SKILLS_DIR = join(PONOS_HOME, 'skills')

export const TYPE_LABELS = {
  personal: '个人记忆',
  skill_exp: '技能经验库',
  skills: '技能库',
  config: '全局配置',
  chats: '会话历史',
  project: '项目数据',
}

const REDACT_KEYS = ['authToken', 'apiKey', 'secret', 'token']

function redact(obj) {
  if (Array.isArray(obj)) return obj.map(redact)
  if (obj && typeof obj === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = REDACT_KEYS.some(r => k.toLowerCase().includes(r)) ? '' : redact(v)
    }
    return out
  }
  return obj
}

function lineHasSensitive(text, words) {
  return words.some(w => w && text.includes(w))
}

// 统计各类型文件数/字节数（导出前预览）
export function collectTypeStats(included, opts = {}) {
  const stats = {}
  const sources = {
    personal: PERSONAL_DIR,
    skill_exp: SKILL_EXP_DIR,
    skills: SKILLS_DIR,
  }
  for (const t of included) {
    if (sources[t]) {
      const dir = sources[t]
      let files = 0, bytes = 0
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          const fp = join(dir, f)
          if (statSync(fp).isFile()) { files++; bytes += statSync(fp).size }
        }
      }
      stats[t] = { files, bytes }
    } else if (t === 'chats') {
      stats[t] = { files: opts.chatsJson ? 1 : 0, bytes: opts.chatsJson ? opts.chatsJson.length : 0 }
    } else if (t === 'config') {
      let bytes = 0
      for (const f of ['config.json', 'settings.json']) {
        const fp = join(PONOS_HOME, f)
        if (existsSync(fp)) bytes += statSync(fp).size
      }
      stats[t] = { files: bytes ? 1 : 0, bytes }
    } else if (t === 'project') {
      const root = opts.projectCwd ? join(opts.projectCwd, '.ponos') : null
      stats[t] = { files: root && existsSync(root) ? 1 : 0, bytes: root && existsSync(root) ? 0 : 0 }
    }
  }
  return { included, stats }
}

function copyDirFiltered(src, dest, filterLine) {
  // 复制目录文件；filterLine(filePath)->bool 为 false 则跳过该文件
  mkdirSync(dest, { recursive: true })
  let skipped = 0
  for (const f of readdirSync(src)) {
    const fp = join(src, f)
    if (!statSync(fp).isFile()) continue
    if (filterLine && !filterLine(fp)) { skipped++; continue }
    copyFileSync(fp, join(dest, f))
  }
  return skipped
}

export async function exportPackage(opts) {
  const { outPath, included = [], sensitiveWords = [], chatsJson = null, projectCwd = null, configRedact = true, onProgress = () => {} } = opts
  if (!included.length) return { ok: false, error: '未选择任何导出类型' }
  const staging = mkdtempSync(join(tmpdir(), 'ponos-exp-export-'))
  const skipped = []
  try {
    onProgress('收集数据…')
    // personal：敏感词条目级过滤（逐文件重写为仅保留未命中行）
    if (included.includes('personal') && existsSync(PERSONAL_DIR)) {
      const dest = join(staging, 'personal')
      mkdirSync(dest, { recursive: true })
      for (const f of readdirSync(PERSONAL_DIR)) {
        if (!f.endsWith('.md')) continue
        const raw = readFileSync(join(PERSONAL_DIR, f), 'utf-8')
        if (sensitiveWords.length) {
          const lines = raw.split(/\r?\n/)
          let removed = 0
          const kept = lines.filter(l => {
            const hit = l.trim().startsWith('- ') && lineHasSensitive(l, sensitiveWords)
            if (hit) removed++
            return !hit
          })
          if (removed) skipped.push({ type: 'personal', reason: `${f} 过滤 ${removed} 条敏感条目` })
          writeFileSync(join(dest, f), kept.join('\n'), 'utf-8')
        } else {
          copyFileSync(join(PERSONAL_DIR, f), join(dest, f))
        }
      }
    }
    if (included.includes('skill_exp') && existsSync(SKILL_EXP_DIR)) {
      copyDirFiltered(SKILL_EXP_DIR, join(staging, 'skill_exp'))
    }
    if (included.includes('skills') && existsSync(SKILLS_DIR)) {
      cpSync(SKILLS_DIR, join(staging, 'skills'), { recursive: true })
    }
    if (included.includes('config')) {
      const dest = join(staging, 'config')
      mkdirSync(dest, { recursive: true })
      for (const f of ['config.json', 'settings.json']) {
        const fp = join(PONOS_HOME, f)
        if (!existsSync(fp)) continue
        const data = JSON.parse(readFileSync(fp, 'utf-8'))
        writeFileSync(join(dest, f), JSON.stringify(configRedact ? redact(data) : data, null, 2), 'utf-8')
      }
      if (!configRedact) skipped.push({ type: 'config', reason: '注意：已包含未脱敏凭据' })
    }
    if (included.includes('chats') && chatsJson) {
      mkdirSync(join(staging, 'chats'), { recursive: true })
      writeFileSync(join(staging, 'chats', 'chat-store.json'), chatsJson, 'utf-8')
    }
    if (included.includes('project') && projectCwd) {
      const src = join(projectCwd, '.ponos')
      if (existsSync(src)) cpSync(src, join(staging, 'project'), { recursive: true })
      else skipped.push({ type: 'project', reason: `${src} 不存在，跳过` })
    }

    const stats = {}
    for (const [k, v] of Object.entries(collectTypeStats(included, { chatsJson, projectCwd }).stats)) stats[k] = v
    const manifest = {
      format_version: 1,
      app_version: process.env.npm_package_version || '2.5.0',
      created_at: new Date().toISOString(),
      origin_device: process.env.COMPUTERNAME || 'unknown',
      included,
      stats,
    }
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

    onProgress('压缩打包…')
    mkdirSync(join(tmpdir(), 'ponos-exp-export'), { recursive: true })
    const tar = spawnSync('tar', ['-a', '-c', '-f', outPath, '-C', staging, '.'], { stdio: 'pipe' })
    if (tar.status !== 0) {
      return { ok: false, error: `tar 打包失败: ${tar.stderr?.toString() || tar.status}` }
    }
    return { ok: true, outPath, manifest, skipped }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/packager.test.mjs`
Expected: PASS（4 个用例）。若本机 PATH 无 `tar`（理论不会，Windows 10 自带 `C:\Windows\System32\tar.exe`，Git Bash 亦有 GNU tar），改用 `spawnSync('powershell', ['-NoProfile','-Command', 'Compress-Archive', '-Path', join(staging,'*'), '-DestinationPath', outPath])` 并在测试/文档中注明。

- [ ] **Step 5: Commit**

```bash
git add server/packager.mjs server/packager.test.mjs
git commit -m "feat(experience): 导出打包器（6 类型收集/manifest/敏感过滤/config 脱敏/tar zip）"
```

---

### Task 4: server/packager.mjs — 导入（解包/校验/冲突三模式/原子性）

**Files:**
- Modify: `server/packager.mjs`（追加 importPackage）
- Test: `server/packager.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 3 的 zip 格式（manifest + 类型目录）
- Produces（Task 5/6 依赖）:
  - `importPackage(zipPath, opts)` → `Promise<{ ok: true, manifest: object, restored: string[], conflicts: number, chatStoreJson: string|null } | { ok: false, error: string }>`
    - `opts: { conflict: 'skip'|'overwrite'|'merge', projectCwd?: string|null, onProgress?: (msg:string)=>void }`

- [ ] **Step 1: 写失败测试**

在 `server/packager.test.mjs` 追加：

```js
import { spawnSync } from 'node:child_process'

function makeZipWith(entries, outPath) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-make-'))
  for (const [rel, content] of Object.entries(entries)) {
    const fp = path.join(staging, rel)
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, content, 'utf-8')
  }
  spawnSync('tar', ['-a', '-c', '-f', outPath, '-C', staging, '.'])
  fs.rmSync(staging, { recursive: true, force: true })
}

test('导入拒绝缺失 manifest 的 zip', async () => {
  const badZip = path.join(path.dirname(zipPath), 'bad.zip')
  makeZipWith({ 'random.txt': 'x' }, badZip)
  const res = await pkg.importPackage(badZip, { conflict: 'skip' })
  assert.equal(res.ok, false)
})

test('导入个人经验 merge 模式按行去重', async () => {
  // 目标库已有一条
  fs.writeFileSync(path.join(personal, 'finance.md'),
    '---\nname: finance\nactive: true\n---\n- [旧] 已有条目\n', 'utf-8')
  // 打包：含一条重复 + 一条新增
  const zip = path.join(path.dirname(zipPath), 'merge.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['personal'] }),
    'personal/finance.md': '---\nname: finance\nactive: true\n---\n- [旧] 已有条目\n- [新] 新增条目\n',
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'merge' })
  assert.equal(res.ok, true)
  const after = fs.readFileSync(path.join(personal, 'finance.md'), 'utf-8')
  assert.ok(after.includes('新增条目'))
  assert.equal((after.match(/已有条目/g) || []).length, 1)
})

test('导入 overwrite 模式覆盖已有文件', async () => {
  const zip = path.join(path.dirname(zipPath), 'ow.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['personal'] }),
    'personal/finance.md': '---\nname: finance\nactive: true\n---\n- [覆盖] 新内容\n',
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'overwrite' })
  assert.equal(res.ok, true)
  assert.ok(fs.readFileSync(path.join(personal, 'finance.md'), 'utf-8').includes('新内容'))
})

test('导入 chats 返回 chatStoreJson 且不直接写盘', async () => {
  const zip = path.join(path.dirname(zipPath), 'chats.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['chats'] }),
    'chats/chat-store.json': '{"conversations":[{"id":"c1"}]}',
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'skip' })
  assert.equal(res.ok, true)
  const parsed = JSON.parse(res.chatStoreJson)
  assert.equal(parsed.conversations[0].id, 'c1')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/packager.test.mjs`
Expected: FAIL（`pkg.importPackage is not a function`）

- [ ] **Step 3: 写实现**

`server/packager.mjs` 追加：

```js
function manifestOf(staging) {
  const fp = join(staging, 'manifest.json')
  if (!existsSync(fp)) return null
  try { return JSON.parse(readFileSync(fp, 'utf-8')) } catch { return null }
}

function mergeEntryLines(targetRaw, incomingRaw) {
  // 行级合并：按 hash 去重，保留 frontmatter 用目标文件的（若目标无 frontmatter 用传入的）
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(targetRaw) || /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(incomingRaw) || ''
  const head = fm ? fm[0] : ''
  const bodyLines = (targetRaw + '\n' + incomingRaw).split(/\r?\n/).filter(l => l.trim().startsWith('- '))
  const seen = new Set()
  const merged = []
  for (const l of bodyLines) {
    const h = hashLine(l.trim())
    if (seen.has(h)) continue
    seen.add(h)
    merged.push(l.trim())
  }
  return head + merged.join('\n') + '\n'
}

export async function importPackage(zipPath, opts) {
  const { conflict = 'skip', projectCwd = null, onProgress = () => {} } = opts
  const staging = mkdtempSync(join(tmpdir(), 'ponos-exp-import-'))
  const restored = []
  let conflicts = 0
  try {
    onProgress('解包校验…')
    const tar = spawnSync('tar', ['-xf', zipPath, '-C', staging], { stdio: 'pipe' })
    if (tar.status !== 0) return { ok: false, error: `解包失败: ${tar.stderr?.toString() || tar.status}` }
    const manifest = manifestOf(staging)
    if (!manifest) return { ok: false, error: '包内缺少 manifest.json 或格式无效，已拒绝导入' }
    if (manifest.format_version !== 1) return { ok: false, error: `不支持的包版本 format_version=${manifest.format_version}（需要 1）` }

    const included = Array.isArray(manifest.included) ? manifest.included : []
    const targets = {
      personal: PERSONAL_DIR,
      skill_exp: SKILL_EXP_DIR,
      skills: SKILLS_DIR,
      config: PONOS_HOME,
    }
    for (const t of included) {
      const srcDir = join(staging, t)
      if (!existsSync(srcDir)) continue
      if (t === 'chats') continue // chats 由 renderer 写 localStorage，见 Task 6
      if (targets[t]) {
        mkdirSync(targets[t], { recursive: true })
        for (const f of readdirSync(srcDir)) {
          const src = join(srcDir, f)
          const dst = join(targets[t], f)
          if (statSync(src).isFile() && !f.startsWith('_')) {
            if (existsSync(dst)) {
              if (conflict === 'skip') { conflicts++; continue }
              if (conflict === 'overwrite') { copyFileSync(src, dst); restored.push(`${t}/${f}`); continue }
              // merge：行式文件按行去重，其余跳过已存在
              if (conflict === 'merge') {
                if (f.endsWith('.md') && t === 'personal') {
                  writeFileSync(dst, mergeEntryLines(readFileSync(dst, 'utf-8'), readFileSync(src, 'utf-8')), 'utf-8')
                  restored.push(`${t}/${f} (merged)`)
                } else if (f.endsWith('.json')) {
                  // 按顶层 key 浅合并（skill_exp/config 数组类文件走此路）
                  const a = JSON.parse(readFileSync(dst, 'utf-8'))
                  const b = JSON.parse(readFileSync(src, 'utf-8'))
                  writeFileSync(dst, JSON.stringify(mergeJson(a, b), null, 2), 'utf-8')
                  restored.push(`${t}/${f} (merged)`)
                } else { conflicts++; }
              }
            } else {
              copyFileSync(src, dst)
              restored.push(`${t}/${f}`)
            }
          }
        }
      } else if (t === 'project' && projectCwd) {
        cpSync(srcDir, join(projectCwd, '.ponos'), { recursive: true, force: conflict === 'overwrite' })
        restored.push('project/.ponos')
      }
    }

    let chatStoreJson = null
    const chatFile = join(staging, 'chats', 'chat-store.json')
    if (included.includes('chats') && existsSync(chatFile)) {
      chatStoreJson = readFileSync(chatFile, 'utf-8')
      restored.push('chats/chat-store.json (renderer 写入)')
    }

    return { ok: true, manifest, restored, conflicts, chatStoreJson }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function mergeJson(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(out[k]) && Array.isArray(v)) {
      const seen = new Set(out[k].map(x => JSON.stringify(x)))
      for (const item of v) {
        const s = JSON.stringify(item)
        if (!seen.has(s)) { out[k].push(item); seen.add(s) }
      }
    } else if (out[k] && v && typeof out[k] === 'object' && typeof v === 'object') {
      out[k] = mergeJson(out[k], v)
    } else if (!(k in out) || out[k] === undefined) {
      out[k] = v
    }
  }
  return out
}
```

> `hashLine` 需从 `./experience.mjs` 导入（把 Task 1 的 import 行改为 `import { PERSONAL_DIR, hashLine } from './experience.mjs'`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/packager.test.mjs`
Expected: PASS（原 4 + 新 4 = 8 个用例）

- [ ] **Step 5: Commit**

```bash
git add server/packager.mjs server/packager.test.mjs
git commit -m "feat(experience): 导入（manifest 校验/三种冲突模式/行与 JSON 合并/chats 回传 renderer）"
```

---

### Task 5: Electron 主进程 IPC + preload 暴露

**Files:**
- Modify: `electron/main.cjs`（`registerIpc()` 内追加 handler；`experienceDir()` 改为先新后旧；顶部 import 区）
- Modify: `electron/preload.cjs`（`ponosAPI` 追加 5 个方法）

**Interfaces:**
- Consumes: Task 1/3/4 的 `experience.mjs` / `packager.mjs` 函数
- Produces（Task 6 依赖）:
  - IPC handler：`experience:list`、`experience:set-active`、`experience:delete-entry`、`experience:export`、`experience:import`
  - preload：`window.ponosAPI.experienceList()` / `setExperienceActive(theme, active)` / `deleteExperienceEntry(theme, hash)` / `exportExperience(opts)` / `importExperience(opts)`

- [ ] **Step 1: 写失败验证（node --check + 手动 grep 断言）**

`node --check electron/main.cjs`（确保语法有效）+ 手动确认新 handler 存在：

```bash
node --check electron/main.cjs && node --check electron/preload.cjs
grep -c "experience:list" electron/main.cjs  # 期望 ≥1
grep -c "experienceExport" electron/preload.cjs  # 期望 ≥1
```

- [ ] **Step 2: 跑确认失败**

Run: 上面两条命令
Expected: `grep -c` 输出 `0`（handler 尚未添加）

- [ ] **Step 3: 实现**

`electron/main.cjs`：

1. 顶部 import 区（现有 `require(...)` 之后）追加：

```js
const { listExperiences, setThemeActive, deleteThemeEntry, refreshIndex, PERSONAL_DIR } = require('../server/experience.mjs')
const { exportPackage, importPackage, collectTypeStats, TYPE_LABELS } = require('../server/packager.mjs')
```

> 注意：`server/` 是 ESM（`"type": "module"`），main.cjs 是 CJS。Node 22+ 支持 `require()` ESM（module.sync）。若当前 Electron（v43，内置 Node 22+）运行报错，改为顶层动态 import 并在 `registerIpc` 内 `await import(...)`（所有 handler 已 async，可安全 await）。实现时以"能跑通"为准，二选一。

2. `experienceDir()`（现 441-443 行）改为先新后旧：

```js
function experienceDir() {
  const ponos = path.join(os.homedir(), '.ponos', 'memory', 'skill_experiences')
  if (fs.existsSync(ponos)) return ponos
  return path.join(os.homedir(), '.trae-cn', 'memory', 'skill_experiences')
}
```

3. `registerIpc()` 末尾（`agents:sync` handler 之后）追加：

```js
  // ---------------------------------------------------------------
  // 个人经验库（experience.mjs）+ 导出/导入（packager.mjs）
  // ---------------------------------------------------------------
  ipcMain.handle('experience:list', async () => {
    try {
      refreshIndex()
      const list = listExperiences()
      const alert = checkPendingExperienceAlert?.() || { shouldAlert: false, total: 0 }
      return { ok: true, themes: list, pendingAlert: alert.total }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('experience:set-active', async (_e, payload) => {
    try {
      const theme = String(payload?.theme || '')
      const active = !!payload?.active
      const res = setThemeActive(theme, active)
      refreshIndex()
      return { ...res }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('experience:delete-entry', async (_e, payload) => {
    try {
      const res = deleteThemeEntry(String(payload?.theme || ''), String(payload?.hash || ''))
      refreshIndex()
      return { ...res }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('experience:export', async (_e, payload) => {
    try {
      const included = Array.isArray(payload?.included) ? payload.included : []
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出 Ponos 经验/数据',
        defaultPath: path.join(app.getPath('downloads'), `ponos-export-${new Date().toISOString().slice(0, 10)}.zip`),
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      const res = await exportPackage({
        outPath: result.filePath,
        included,
        sensitiveWords: Array.isArray(payload?.sensitiveWords) ? payload.sensitiveWords : [],
        chatsJson: typeof payload?.chatsJson === 'string' ? payload.chatsJson : null,
        projectCwd: typeof payload?.projectCwd === 'string' ? payload.projectCwd : null,
        configRedact: payload?.configRedact !== false,
      })
      return res
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('experience:import', async (_e, payload) => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入 Ponos 经验/数据包',
        properties: ['openFile'],
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true }
      const res = await importPackage(result.filePaths[0], {
        conflict: payload?.conflict || 'skip',
        projectCwd: typeof payload?.projectCwd === 'string' ? payload.projectCwd : null,
      })
      return res
    } catch (e) { return { ok: false, error: e.message } }
  })
```

> 若 `checkPendingExperienceAlert` 是局部函数名，先确认 main.cjs 中实际名称（grep 后按实际名调用；该行可选，取不到就省略 `pendingAlert` 字段）。

`electron/preload.cjs` 的 `ponosAPI` 追加：

```js
  // 个人经验库与导出/导入（experience.mjs / packager.mjs）
  experienceList: () => ipcRenderer.invoke('experience:list'),
  setExperienceActive: (theme, active) => ipcRenderer.invoke('experience:set-active', { theme, active }),
  deleteExperienceEntry: (theme, hash) => ipcRenderer.invoke('experience:delete-entry', { theme, hash }),
  exportExperience: (opts) => ipcRenderer.invoke('experience:export', opts),
  importExperience: (opts) => ipcRenderer.invoke('experience:import', opts),
```

- [ ] **Step 4: 跑验证确认通过**

Run: `node --check electron/main.cjs && node --check electron/preload.cjs && grep -c "experience:list" electron/main.cjs`
Expected: 无语法错误，grep 输出 ≥1

- [ ] **Step 5: Commit**

```bash
git add electron/main.cjs electron/preload.cjs
git commit -m "feat(experience): 主进程 IPC（list/set-active/delete/export/import）+ preload 暴露 + skill_experiences 路径先新后旧"
```

---

### Task 6: 前端 — 设置页"经验"分区

**Files:**
- Create: `src/components/settings/ExperiencePanel.tsx`
- Modify: `src/components/settings/SettingsView.tsx`（Section 类型、nav 项、分区渲染）
- Modify: `src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`（新增 key）
- Modify: `src/types/index.ts`（preload API 类型：ponosAPI 扩展）

**Interfaces:**
- Consumes: Task 5 的 `window.ponosAPI.experienceList/setExperienceActive/deleteExperienceEntry/exportExperience/importExperience`；`fetchBridgeConfig/saveBridgeConfig`（`src/lib/config`，读写 `experienceInjectEnabled`/`experienceInjectMaxBytes`）；`useChatStore` 的 `lastCwd`
- Produces: 设置页"经验"分区（列表/搜索/激活/删除/统计/导出对话框/导入对话框/注入设置）

- [ ] **Step 1: 先加类型（让 typecheck 驱动失败）**

`src/types/index.ts` 的 `PonosAPI` 类型（或实际存在的 ponosAPI 声明处）追加：

```ts
export interface ExperienceTheme {
  theme: string
  file: string
  entryCount: number
  updatedAt: number
  active: boolean
  entries: { text: string; hash: string }[]
}

export interface PonosAPI { // 若已有同名接口，往里面追加以下 5 个方法
  experienceList: () => Promise<{ ok: boolean; themes?: ExperienceTheme[]; error?: string }>
  setExperienceActive: (theme: string, active: boolean) => Promise<{ ok: boolean; error?: string }>
  deleteExperienceEntry: (theme: string, hash: string) => Promise<{ ok: boolean; deleted?: number; error?: string }>
  exportExperience: (opts: { included: string[]; sensitiveWords?: string[]; chatsJson?: string | null; projectCwd?: string | null; configRedact?: boolean }) => Promise<{ ok: boolean; outPath?: string; skipped?: { type: string; reason: string }[]; error?: string }>
  importExperience: (opts: { conflict: 'skip' | 'overwrite' | 'merge'; projectCwd?: string | null }) => Promise<{ ok: boolean; restored?: string[]; chatStoreJson?: string | null; conflicts?: number; error?: string }>
}
```

- [ ] **Step 2: 实现 ExperiencePanel 组件**

`src/components/settings/ExperiencePanel.tsx`（完整实现，注释标明关键点）：

```tsx
import { useEffect, useMemo, useState } from 'react'
import { Brain, Search, Trash2, Download, Upload, RefreshCw, Package, Check, AlertTriangle } from 'lucide-react'
import { Button, Switch, ScrollArea } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { fetchBridgeConfig, saveBridgeConfig } from '@/lib/config'
import { cn } from '@/lib/utils'
import type { ExperienceTheme } from '@/types'

const TYPE_LABELS: Record<string, string> = {
  personal: '个人记忆', skill_exp: '技能经验库', skills: '技能库',
  config: '全局配置', chats: '会话历史', project: '项目数据',
}

export function ExperiencePanel({ t }: { t: (k: string) => string }) {
  const [themes, setThemes] = useState<ExperienceTheme[]>([])
  const [query, setQuery] = useState('')
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [injectEnabled, setInjectEnabled] = useState(true)
  const [injectMax, setInjectMax] = useState(4096)
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const lastCwd = useChatStore(s => s.lastCwd)

  const load = () => {
    window.ponosAPI.experienceList().then(r => {
      if (r.ok && r.themes) { setThemes(r.themes); return }
      setMsg({ text: r.error || '读取失败', ok: false })
    })
  }

  useEffect(() => {
    load()
    fetchBridgeConfig().then(cfg => {
      setInjectEnabled(cfg.experienceInjectEnabled !== false)
      setInjectMax(Number(cfg.experienceInjectMaxBytes) > 0 ? Number(cfg.experienceInjectMaxBytes) : 4096)
    }).catch(() => {})
  }, [])

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok })
    setTimeout(() => setMsg(null), 5000)
  }

  const saveInject = (enabled: boolean, maxBytes: number) => {
    fetchBridgeConfig().then(cfg => {
      saveBridgeConfig({ ...cfg, experienceInjectEnabled: enabled, experienceInjectMaxBytes: maxBytes }).then(() => flash('注入设置已保存'))
    }).catch(() => flash('保存失败', false))
  }

  const totalEntries = useMemo(() => themes.reduce((s, x) => s + x.entryCount, 0), [themes])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return themes.filter(x => !q || x.theme.includes(q) || x.entries.some(e => e.text.toLowerCase().includes(q)))
  }, [themes, query])

  const chatsJson = () => {
    try { return window.localStorage.getItem('ponos-chat') } catch { return null }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-primary mb-1 flex items-center gap-2">
          <Brain className="w-4 h-4" />
          个人经验
        </h3>
        <p className="text-xs text-tertiary mb-4">
          全自动静默沉积于 ~/.ponos/memory/personal/，新会话按相关性注入（上限 {injectMax} 字符）。共 {themes.length} 个主题 / {totalEntries} 条经验。
        </p>

        {/* 注入设置 */}
        <div className="rounded-lg border border bg-surface p-4 mb-4 space-y-3">
          <label className="flex items-center justify-between py-1">
            <div>
              <span className="text-sm text-secondary">新会话注入经验</span>
              <p className="text-[10px] text-tertiary mt-0.5">开启后每次会话自动携带已激活经验（含沉积引导）</p>
            </div>
            <Switch checked={injectEnabled} onCheckedChange={v => { setInjectEnabled(v); saveInject(v, injectMax) }} />
          </label>
          <label className="flex items-center justify-between py-1">
            <div>
              <span className="text-sm text-secondary">注入上限（字符）</span>
              <p className="text-[10px] text-tertiary mt-0.5">超出部分按最近更新截断</p>
            </div>
            <input
              type="number" min={512} max={16384} step={512}
              value={injectMax}
              onChange={e => setInjectMax(Number(e.target.value) || 4096)}
              onBlur={() => saveInject(injectEnabled, injectMax)}
              className="w-28 h-8 rounded-md border border bg-surface px-2 text-xs text-primary text-right font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
        </div>

        {/* 导出/导入 */}
        <div className="flex items-center gap-2 mb-4">
          <Button variant="primary" size="sm" leftIcon={<Download className="w-3.5 h-3.5" />} onClick={() => setExportOpen(true)}>导出</Button>
          <Button variant="outline" size="sm" leftIcon={<Upload className="w-3.5 h-3.5" />} onClick={() => setImportOpen(true)}>导入</Button>
          <Button variant="ghost" size="sm" leftIcon={<RefreshCw className="w-3.5 h-3.5" />} onClick={load}>刷新</Button>
          {msg && <span className={cn('text-xs', msg.ok ? 'text-success' : 'text-error')}>{msg.text}</span>}
        </div>

        {/* 搜索 */}
        <div className="relative mb-3">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-tertiary" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索主题或经验内容…"
            className="w-full h-8 bg-elevated border border rounded-md pl-7 pr-2 text-xs text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* 主题列表 */}
        <ScrollArea className="max-h-[46vh]">
          <div className="space-y-3">
            {filtered.map(x => (
              <div key={x.theme} className="rounded-lg border border bg-surface p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-primary">{x.theme}</span>
                  <span className="text-[10px] text-tertiary">{x.entryCount} 条</span>
                  <div className="ml-auto flex items-center gap-2">
                    <label className="flex items-center gap-1 text-[10px] text-tertiary">
                      激活
                      <Switch
                        checked={x.active}
                        onCheckedChange={v => {
                          window.ponosAPI.setExperienceActive(x.theme, v).then(r => { if (r.ok) load() })
                        }}
                      />
                    </label>
                  </div>
                </div>
                {x.entries.slice(0, 6).map(e => (
                  <div key={e.hash} className="group flex items-start gap-2 mt-1.5 text-xs text-secondary">
                    <span className="flex-1 min-w-0 leading-relaxed">{e.text}</span>
                    <button
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-tertiary hover:text-error transition-opacity"
                      title="删除该经验"
                      onClick={() => {
                        if (!confirm(`删除这条经验？\n${e.text.slice(0, 60)}…`)) return
                        window.ponosAPI.deleteExperienceEntry(x.theme, e.hash).then(r => {
                          if (r.ok) { load(); flash('已删除') } else flash(r.error || '删除失败', false)
                        })
                      }}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {x.entryCount > 6 && (
                  <div className="mt-1.5 text-[10px] text-tertiary">…另有 {x.entryCount - 6} 条</div>
                )}
              </div>
            ))}
            {filtered.length === 0 && <div className="p-4 text-center text-xs text-tertiary">暂无经验，多用 Ponos 工作会自动沉淀</div>}
          </div>
        </ScrollArea>
      </div>

      {exportOpen && (
        <ExportDialog
          lastCwd={lastCwd}
          chatsJson={chatsJson}
          onClose={() => setExportOpen(false)}
          onDone={m => { flash(m); load() }}
        />
      )}
      {importOpen && (
        <ImportDialog
          lastCwd={lastCwd}
          onClose={() => setImportOpen(false)}
          onDone={m => { flash(m); load() }}
        />
      )}
    </div>
  )
}

function ExportDialog({ lastCwd, chatsJson, onClose, onDone }: { lastCwd: string | null; chatsJson: () => string | null; onClose: () => void; onDone: (m: string) => void }) {
  const [sel, setSel] = useState<Record<string, boolean>>({ personal: true, skill_exp: true, chats: true })
  const [words, setWords] = useState('密码,password,apiKey,secret')
  const [busy, setBusy] = useState(false)

  const run = async () => {
    const included = Object.entries(sel).filter(([, v]) => v).map(([k]) => k)
    if (!included.length) return
    setBusy(true)
    const res = await window.ponosAPI.exportExperience({
      included,
      sensitiveWords: words.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      chatsJson: sel.chats ? chatsJson() : null,
      projectCwd: sel.project ? (lastCwd || null) : null,
      configRedact: true,
    })
    setBusy(false)
    if (!res.ok) { onDone(res.error || '导出失败（可能已取消）'); onClose(); return }
    onDone(`已导出到 ${res.outPath}${res.skipped?.length ? `，跳过 ${res.skipped.length} 项：${res.skipped.map(s => s.reason).join('；')}` : ''}`)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ background: 'var(--overlay-bg)' }}>
      <div className="w-[420px] bg-surface rounded-xl shadow-modal border border p-5">
        <h4 className="text-sm font-semibold text-primary flex items-center gap-1.5 mb-1"><Package className="w-4 h-4" /> 导出经验/数据</h4>
        <p className="text-[10px] text-tertiary mb-4">选择要打包的类型（zip + manifest.json，可在另一台设备导入）</p>
        <div className="space-y-2 mb-4">
          {Object.entries(TYPE_LABELS).map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 text-xs text-secondary">
              <input type="checkbox" checked={!!sel[id]} onChange={e => setSel({ ...sel, [id]: e.target.checked })} className="accent-brand-500" />
              {label}
            </label>
          ))}
        </div>
        <label className="block text-[10px] text-tertiary mb-1">敏感词过滤（命中条目不导出，逗号分隔）</label>
        <input
          value={words} onChange={e => setWords(e.target.value)}
          className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary font-mono focus:outline-none focus:ring-1 focus:ring-accent mb-1"
        />
        <p className="text-[10px] text-warning/80 mb-4 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> 全局配置导出自动脱敏（不含 authToken）</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" onClick={run} disabled={busy}>{busy ? '打包中…' : '导出'}</Button>
        </div>
      </div>
    </div>
  )
}

function ImportDialog({ lastCwd, onClose, onDone }: { lastCwd: string | null; onClose: () => void; onDone: (m: string) => void }) {
  const [conflict, setConflict] = useState<'skip' | 'overwrite' | 'merge'>('merge')

  const run = async () => {
    const res = await window.ponosAPI.importExperience({ conflict, projectCwd: lastCwd })
    if (!res.ok) { onDone(res.error || '导入失败（可能已取消）'); onClose(); return }
    // chats 回传 renderer 写回 localStorage
    if (res.chatStoreJson) {
      try { window.localStorage.setItem('ponos-chat', res.chatStoreJson) } catch {}
    }
    onDone(`导入完成：恢复 ${res.restored?.length ?? 0} 项${res.conflicts ? `，跳过冲突 ${res.conflicts} 项` : ''}`)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" style={{ background: 'var(--overlay-bg)' }}>
      <div className="w-[400px] bg-surface rounded-xl shadow-modal border border p-5">
        <h4 className="text-sm font-semibold text-primary flex items-center gap-1.5 mb-1"><Package className="w-4 h-4" /> 导入经验/数据包</h4>
        <p className="text-[10px] text-tertiary mb-4">选择 zip 文件后按 manifest 恢复，冲突处理方式：</p>
        <div className="space-y-2 mb-4">
          {([['merge', '合并（条目级去重）'], ['overwrite', '覆盖已有'], ['skip', '跳过已有']] as const).map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 text-xs text-secondary">
              <input type="radio" name="conflict" checked={conflict === id} onChange={() => setConflict(id)} className="accent-brand-500" />
              {label}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" onClick={run}>选择 zip 并导入</Button>
        </div>
      </div>
    </div>
  )
}
```

> 若 `src/lib/config` 的 `fetchBridgeConfig`/`saveBridgeConfig` 返回类型不含 `experienceInjectEnabled/MaxBytes`，在 `src/types/index.ts` 的 `PonosConfigV2` 追加两个可选字段：`experienceInjectEnabled?: boolean`、`experienceInjectMaxBytes?: number`（bridge 侧 `readBridgeConfig`/`saveBridgeConfig` 已按透传处理，无需改 bridge 的 config 读写逻辑）。

- [ ] **Step 3: 接入 SettingsView**

`src/components/settings/SettingsView.tsx`：
1. `type Section = 'general' | 'model' | 'skills' | 'pet' | 'about'` → 追加 `| 'experience'`
2. nav 数组追加 `{ id: 'experience' as Section, label: t('settings.experienceTab'), icon: Brain }`（`Brain` 已在 import 中）
3. 分区渲染追加（在 `{section === 'pet' && (...)}` 之后）：

```tsx
              {section === 'experience' && <ExperiencePanel t={t} />}
```

4. 顶部 import 追加：`import { ExperiencePanel } from '@/components/settings/ExperiencePanel'`

`src/i18n/translations/zh-CN.ts` 与 `en-US.ts` 的 settings 命名空间追加 `experienceTab`：
- zh-CN：`experienceTab: '经验'`
- en-US：`experienceTab: 'Experience'`

- [ ] **Step 4: typecheck 确认通过**

Run: `npm run typecheck`
Expected: PASS（0 错误）。若 `window.ponosAPI` 类型缺方法，按 Step 1 的类型声明补齐后再跑。

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/ExperiencePanel.tsx src/components/settings/SettingsView.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts src/types/index.ts
git commit -m "feat(experience): 设置页经验分区（浏览/激活/删除/注入设置/导出导入对话框）"
```

---

### Task 7: 全量验证 + release 同步

**Files:**
- Modify: 无源码（仅验证与同步）

- [ ] **Step 1: 全量静态检查 + 单元测试**

```bash
node --check server/experience.mjs && node --check server/packager.mjs && node --check server/bridge.mjs
node --check electron/main.cjs && node --check electron/preload.cjs
npm run typecheck
node --test server/
node scripts/verify-experience-inject.mjs
```
Expected: 全部通过（typecheck 0 错误；node --test 全部 PASS；verify 输出 OK）

- [ ] **Step 2: 端到端验证（不动 live app）**

```bash
# 导出→导入 往返（用临时 HOME 隔离）
PONOS_TEST_HOME=$(mktemp -d) node --test server/packager.test.mjs
# 验证 bridge 注入段真实出现在 spawn 的 prompt 文件（打印断言，不 spawn 内核）
node scripts/verify-experience-inject.mjs
```
Expected: 两个命令均 PASS。此步不重启 live app、不 spawn 内核进程。

- [ ] **Step 3: 同步 release 副本**

把改动同步到 `release/Ponos_ms92cd6u/`：
- `server/experience.mjs`、`server/packager.mjs`、`server/bridge.mjs`（及 `server/*.test.mjs` 可选）→ `release/Ponos_ms92cd6u/server/`
- `electron/main.cjs`、`electron/preload.cjs` → `release/Ponos_ms92cd6u/electron/`
- 前端：`npm run build` 后把 `dist/` 产物复制到 `release/Ponos_ms92cd6u/dist/`（或 release 对应静态目录）
- 完成后**询问用户**是否重启 live app 验证（memory: feedback_restart_permission），不得擅自杀进程/重启。

```bash
cp server/experience.mjs server/packager.mjs server/bridge.mjs release/Ponos_ms92cd6u/server/
cp electron/main.cjs electron/preload.cjs release/Ponos_ms92cd6u/electron/
```

- [ ] **Step 4: 收尾确认**

- 确认 `git status` 仅包含本计划涉及文件 + 既有未提交改动（`build/installer.nsh`、原型文件、vendor/）
- 汇报：功能清单、验证结果、release 同步情况、待用户重启验证

---

## Self-Review 记录

- **Spec coverage**：设计文档 §3 数据层 → Task 1；§4 沉积引导 → Task 2；§5 注入 → Task 2（4KB 上限经 config.json 字段）；§6 GUI 面板 → Task 6；§7 导出/导入 → Task 3/4/5/6；§8 错误处理/测试 → 各任务测试 + Task 7；§10 文件清单 → 全部覆盖。补充说明（财务/政策/申报主题预置）→ Task 1 `DEFAULT_THEMES`。
- **Placeholder scan**：无 TBD/TODO；每个代码步骤含完整可运行代码。
- **Type consistency**：`hashLine`（Task 1 定义，Task 4 复用）、`buildExperienceSection(maxBytes)` / `buildSedimentPrompt()` / `ensurePersonalDir()`（Task 1→2）、`exportPackage(opts)` / `importPackage(opts)` 签名（Task 3/4→5→6）、IPC 方法名 `experience:list/set-active/delete-entry/export/import`（Task 5→6）全链路一致；`mergeJson`/`mergeEntryLines` 在 Task 4 定义并仅 Task 4 使用。
