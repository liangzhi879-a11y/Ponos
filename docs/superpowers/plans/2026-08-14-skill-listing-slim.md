# Skill 披露瘦身与层级化实施计划（宿主 triggers 优先 + subskill 系统化 + 版本剥离）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 宿主技能清单从 11,073 字符瘦身到 ~2-3K；63 技能层级化归入 5 个父技能 + 6 个独立披露，清单只披露 11 条，子技能经父技能索引且仍可调用。

**Architecture:** 三层职责分层——宿主清单（`server/bridge.mjs` 每轮常驻）只列父技能与独立技能（聚合触发词 + 子名内联）；内核清单（`loadSkillsDir.ts` 解析 `parent`/`subskills` + `prompt.ts` 渲染过滤）同层级；调用时全文注入不变（SkillTool 走 `getAllCommands` 全量查找，子技能隐藏后仍可调用）。技能库 64 个 SKILL.md 层级化标注。

**Tech Stack:** Node.js ESM（bridge.mjs）、TypeScript + esbuild bundle（内核）、vitest（内核测试）、bun（内核构建，必须用 `~/.bun/bin/bun.exe`）、sha256sum（发布校验）。

## Global Constraints

- **全部技能名一个都不能丢**：父技能与独立技能独立成条，子技能名内联在父条目
- **子技能必须仍可被 Skill 工具调用**（调用走 `getAllCommands` 全量查找，清单过滤只在渲染层；禁止触碰 `SkillTool.ts`/`commands.ts` 过滤逻辑）
- **强制调用指令前缀【已安装技能清单】…必须调用 Skill 工具执行… 原样保留**
- **调用时全文注入 + invokedSkills 跨压缩存活——完全不动**
- 内核 1% 窗口预算、按 agentId 子代理注入——机制不变，仅渲染内容变化
- 版本剥离正则两处实现必须逐字符一致：`/\bv\d+\.\d+\.\d+[^。]*(?:。|$)/g`
- `subskills` 统一多行 `- ` 列表语法（与 triggers 同构，复用同一行清洗）；`parent` 单行
- 仅一层父子层级；二级协调者（gxtz-core-tables 等带 subskills 又有 parent）的 subskills 仅供正文、不参与清单层级
- 子技能 SKILL.md 除 frontmatter 加 `parent` 一行外零改动；独立技能零改动
- 触发词来源：父技能 `triggers` 字段优先，无则取聚合 description（剥版本后截断 80）
- 宿主条目：触发词段上限 80 字符（超截断加 `…`）；内联子技能名全部列出不截断；触发词与剥版本后描述均空 → 只列 `- {name}`
- 技能库位于 `~/.ponos/skills`（不在 git 仓库）——批量修改必须带 `--dry-run` + 修改前备份
- bun 一律用 `~/.bun/bin/bun.exe`；release 目录 git-ignored，同步不提交；生效需重启 live app（先征得用户同意）；不打包

---

### Task 1: 宿主清单层级化渲染（`server/bridge.mjs`）

**Files:**
- Modify: `server/bridge.mjs:535-560`（`listInstalledSkills`）、`server/bridge.mjs:583-594`（`appendSkillList`）
- Create: `scripts/verify-skill-listing.mjs`（回归脚本）

**Interfaces:**
- Consumes: 现有 `findSkillRoot()`、`skillDirFingerprint(dir)`、`skillListCache`/`skillListCacheKey`（不动）
- Produces: `export function parseTriggers(yaml): string[]`（多行列表通用解析）、`export function parseParent(yaml): string`、`export function stripVersionHistory(text): string`、`export function formatSkillEntry({name, description, triggers, subskills, hasParent}): string`、`export function listInstalledSkills(): {name, description, triggers, parent, subskills}[]`、`export function appendSkillList(basePrompt): string`（Task 4 验证脚本消费）

- [ ] **Step 1: 新增三个纯函数**

在 `server/bridge.mjs` L534 前插入：

```js
// 多行 "- " 列表解析（triggers 与 subskills 共用）：/^key:\n(- item\n)*/m
// 行清洗：去 "- " 前缀、去首尾空白、去引号（" / '）、过滤空行；无该字段或失败 → []
function parseTriggers(yaml) {
  const m = yaml.match(/^triggers:\s*\n((?:\s*-\s*.+\n?)+)/m)
  if (!m) return []
  return m[1]
    .split('\n')
    .map(line => line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

// 单行字段解析（parent 用）：值去引号/空白；无该字段或失败 → ''
function parseParent(yaml) {
  const m = yaml.match(/^parent:\s*["']?(.+?)["']?\s*$/m)
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
}

// 剥离 description 内嵌版本更新日志（v1.0.0初始版本：…。、v1.1.0新增：…。）
// 以句号或串尾为界；不匹配不完整版本号（如 v1.0）
const VERSION_HISTORY_RE = /\bv\d+\.\d+\.\d+[^。]*(?:。|$)/g
function stripVersionHistory(text) {
  return text.replace(VERSION_HISTORY_RE, '').trim()
}
```

- [ ] **Step 2: 新增 `parseSubskills` 与 `formatSkillEntry`**

在 `parseParent` 后追加（subskills 复用 triggers 的列表清洗，仅键名不同）：

```js
// subskills 多行列表解析：与 parseTriggers 同构，仅键名不同
function parseSubskills(yaml) {
  const m = yaml.match(/^subskills:\s*\n((?:\s*-\s*.+\n?)+)/m)
  if (!m) return []
  return m[1]
    .split('\n')
    .map(line => line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

// 单技能清单条目（spec 5.2）：
// 有 parent → 不生成条目（返回 null，调用方过滤）
// 父技能（有 subskills）→ "- {name}：{触发词段截 80}（子：名1、名2…）"
// 独立技能 → "- {name}：{triggers 或 desc 剥版本，截 80}"
// 触发词与剥版本后描述均空 → "- {name}"
const TRIGGER_CHAR_LIMIT = 80
function formatSkillEntry({ name, description, triggers, subskills, hasParent }) {
  if (hasParent) return null
  let triggerPart = ''
  if (triggers.length) {
    triggerPart = triggers.join('、')
  } else {
    const stripped = stripVersionHistory(description)
    if (stripped) triggerPart = stripped
  }
  if (triggerPart.length > TRIGGER_CHAR_LIMIT) {
    triggerPart = triggerPart.slice(0, TRIGGER_CHAR_LIMIT - 1) + '…'
  }
  let line = '- ' + name
  if (triggerPart) line += '：' + triggerPart
  if (subskills.length) line += '（子：' + subskills.join('、') + '）'
  return line
}
```

- [ ] **Step 3: 改造 `listInstalledSkills`**

`server/bridge.mjs:535-560` 整体替换为（新增 parent/subskills 解析，description 去掉 `.slice(0, 200)`——截断统一在 `formatSkillEntry` 做）：

```js
function listInstalledSkills() {
  const dir = findSkillRoot()
  const skills = []
  try {
    for (const it of readdirSync(dir, { withFileTypes: true })) {
      if (it.name.startsWith('_')) continue
      if (!it.isDirectory() && !it.name.endsWith('.md')) continue
      const entry = it.isDirectory() ? join(dir, it.name, 'SKILL.md') : join(dir, it.name)
      if (!existsSync(entry)) continue
      let name = it.name
      let desc = ''
      let triggers = []
      let parent = ''
      let subskills = []
      try {
        const md = readFileSync(entry, 'utf-8')
        const yaml = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (yaml) {
          const nm = yaml[1].match(/name:\s*["']?(.+?)["']?\s*$/m)
          const dm = yaml[1].match(/description:\s*["']?(.+?)["']?\s*$/m)
          if (nm) name = nm[1].trim()
          if (dm) desc = dm[1].trim()
          triggers = parseTriggers(yaml[1])
          parent = parseParent(yaml[1])
          subskills = parseSubskills(yaml[1])
        }
      } catch {}
      skills.push({ name, description: desc, triggers, parent, subskills })
    }
  } catch {}
  return skills
}
```

- [ ] **Step 4: 改造 `appendSkillList`**

`server/bridge.mjs:583-594` 中拼装行改为（前缀段落逐字符保留）：

```js
  const section = '\n\n【已安装技能清单】当用户任务与以下任一技能匹配时，必须调用 Skill 工具执行（skill 参数填技能名），不得跳过、自行模拟或改用其它方式：\n' +
    skills
      .map(s => formatSkillEntry({ name: s.name, description: s.description, triggers: s.triggers, subskills: s.subskills, hasParent: !!s.parent }))
      .filter(Boolean)
      .join('\n')
```

- [ ] **Step 5: export 六个函数**

给 `parseTriggers`、`parseParent`、`parseSubskills`、`stripVersionHistory`、`formatSkillEntry`、`listInstalledSkills`、`appendSkillList` 七个函数声明前加 `export`（其余代码零改动）。

- [ ] **Step 6: 写验证脚本 `scripts/verify-skill-listing.mjs`**

```js
// 宿主清单瘦身回归验证（Task 1 产物 + Task 4 扩展点）：node scripts/verify-skill-listing.mjs
// bridge.mjs 模块加载即 httpServer.listen(PORT)（L1413），注入 PONOS_BRIDGE_PORT=0 落到随机端口避免占用
process.env.PONOS_BRIDGE_PORT = '0'

const bridge = await import('../server/bridge.mjs')
const skills = bridge.listInstalledSkills()
const listing = bridge.appendSkillList('')

let failed = 0
const check = (cond, label) => {
  if (cond) console.log('ok: ' + label)
  else { console.error('FAIL: ' + label); failed++ }
}

// ── 层级断言（Task 3 技能库标注后生效；当前全部无 parent，父条目不出现） ──
const parents = skills.filter(s => s.subskills.length)
const children = skills.filter(s => s.parent)
const independents = skills.filter(s => !s.parent && !s.subskills.length)
console.log(`\n父技能 ${parents.length} / 子技能 ${children.length} / 独立 ${independents.length}`)
check(parents.length === 5, `父技能 = 5（实际 ${parents.length}）`)
check(children.length === 53, `子技能 = 53（实际 ${children.length}）`)
check(independents.length === 6, `独立技能 = 6（实际 ${independents.length}）`)

// ── 结构断言（中间态=全部独立披露 63 条；Task 3 后=父+独立 11 条） ──
const allNames = new Set(skills.map(s => s.name))
const lines = listing.split('\n').filter(l => l.startsWith('- '))
const lineNames = lines.map(l => l.match(/^- ([^：]+)/)?.[1]?.trim() || l.slice(2).split('：')[0])
check(lines.length === parents.length + independents.length, `清单行数 = 父+独立（${lines.length} = ${parents.length + independents.length}）`)
check(lineNames.every(n => allNames.has(n)), '清单每行首 token 均为真实技能名')
check(!/\bv\d+\.\d+\.\d+/.test(listing), '清单无版本号残留（vX.Y.Z 已剥离）')

// 子技能名不得作为独立行首出现；父条目须内联全部子技能名
const childNames = new Set(children.map(s => s.name))
check(!lines.some(l => childNames.has(l.match(/^- ([^：]+)/)?.[1]?.trim())), '子技能名不在清单独立成条')
for (const p of parents) {
  const line = lines.find(l => l.startsWith('- ' + p.name))
  const missing = p.subskills.filter(n => !line || !line.includes(n))
  check(!missing.length, `父技能 ${p.name} 条目内联全部 ${p.subskills.length} 子名（缺失 ${missing.join(',') || '无'}）`)
}

// 互逆一致性：父 subskills = 声明该父 parent 的子技能集合
const parentOf = {}
for (const c of children) parentOf[c.parent] = (parentOf[c.parent] || []).concat(c.name)
for (const p of parents) {
  const declared = [...p.subskills].sort()
  const actual = [...(parentOf[p.name] || [])].sort()
  check(JSON.stringify(declared) === JSON.stringify(actual), `父 ${p.name} 的 subskills 与子技能 parent 互逆一致`)
}
// 父技能不得有 parent
check(parents.every(p => !p.parent), '父技能均无 parent')

// ── 体积断言 ──
console.log(`\n宿主清单字符数：${listing.length}（改造前 11,073）`)
check(listing.length < 4000, '宿主清单 < 4000 字符')
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n全部通过')
// bridge.mjs 加载即 listen（L1413），事件循环被 httpServer 挂住——必须显式退出
process.exit(0)
```

- [ ] **Step 7: 运行验证脚本（技能库未标注的中间态）**

Run: `node scripts/verify-skill-listing.mjs`
Expected: 结构断言通过（行数 = 父+独立 = 0+63 = 63）；层级断言"父技能 = 5 / 子技能 = 53 / 独立 = 6"暂 FAIL（技能库尚未标注，全部为独立 63）——**这是预期中间态**，Task 3 完成后复跑全绿。体积断言 `<4000` 在中间态可能 FAIL（63 条 triggers 优先约 4.5K，无层级过滤）——同属预期，Task 4 层级过滤后达标。

- [ ] **Step 8: 提交**

```bash
git add server/bridge.mjs scripts/verify-skill-listing.mjs
git commit -m "feat(bridge): 宿主技能清单层级化渲染（parent/subskills 解析 + 父条目内联 + triggers 优先 + 版本剥离）"
```

---

### Task 2: 内核清单层级化渲染（`loadSkillsDir.ts` + `prompt.ts`）

**Files:**
- Modify: `ponos-kernel/claude-code/src/types/command.ts:175-203`（`CommandBase` 加字段）
- Modify: `ponos-kernel/claude-code/src/skills/loadSkillsDir.ts:185-265`（`parseSkillFrontmatterFields`）、`loadSkillsDir.ts:270+`（`createSkillCommand`）
- Modify: `ponos-kernel/claude-code/src/tools/SkillTool/prompt.ts:43-50`（`getCommandDescription`）、`prompt.ts:70-171`（`formatCommandsWithinBudget`）
- Create: `ponos-kernel/claude-code/tests/smoke/skill-listing.test.ts`

**Interfaces:**
- Consumes: 现有 `MAX_LISTING_DESC_CHARS`（250）、`formatCommandsWithinBudget`（已 export）
- Produces: `Command.parent?: string`、`Command.subskills?: string[]`；`formatCommandsWithinBudget` 过滤有 parent 条目、父条目内联子名

- [ ] **Step 1: `CommandBase` 加字段**

`ponos-kernel/claude-code/src/types/command.ts` 在 `userInvocable?: boolean`（L190）后插入：

```ts
  parent?: string // 子技能声明的父技能名（清单层级渲染用；调用不受影响）
  subskills?: string[] // 父技能声明的子技能名列表（清单内联展示用）
```

- [ ] **Step 2: `parseSkillFrontmatterFields` 解析新字段**

`loadSkillsDir.ts` 返回类型与 return 对象中加 `parent`、`subskills`（`disableModelInvocation` 行 L255-257 后追加）：

```ts
  parent: frontmatter.parent as string | undefined,
  subskills:
    frontmatter.subskills == null
      ? undefined
      : (Array.isArray(frontmatter.subskills)
          ? frontmatter.subskills.map(String)
          : String(frontmatter.subskills).split(',').map(s => s.trim()).filter(Boolean)),
```

返回类型声明同步加 `parent: string | undefined`、`subskills: string[] | undefined`。

- [ ] **Step 3: `createSkillCommand` 透传**

`loadSkillsDir.ts` `createSkillCommand` 参数类型加 `parent`、`subskills`，return 对象（`disableModelInvocation`（L328）后）加：

```ts
    parent,
    subskills,
```

调用 `createSkillCommand` 的位置需把 `parseSkillFrontmatterFields` 返回的 `parent`/`subskills` 传入（在调用点解构参数列表中追加两项）。

- [ ] **Step 4: `getCommandDescription` 版本剥离**

`prompt.ts` L43-50 替换为：

```ts
// 版本历史剥离正则——与宿主 server/bridge.mjs 的 VERSION_HISTORY_RE 逐字符一致
const VERSION_HISTORY_RE = /\bv\d+\.\d+\.\d+[^。]*(?:。|$)/g

function getCommandDescription(cmd: Command): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  const stripped = desc.replace(VERSION_HISTORY_RE, '').trim()
  return stripped.length > MAX_LISTING_DESC_CHARS
    ? stripped.slice(0, MAX_LISTING_DESC_CHARS - 1) + '\u2026'
    : stripped
}
```

- [ ] **Step 5: `formatCommandsWithinBudget` 层级渲染**

`prompt.ts` 改造（保留既有 bundled 分区/预算降级逻辑，插入层级过滤与父内联）：

```ts
// 层级渲染辅助：有 parent 的子技能 → null（隐藏）；父技能（有 subskills）→ 描述后追加子名内联
function renderSkillLine(cmd: Command): string | null {
  if (cmd.parent) return null
  const base = formatCommandDescription(cmd) // desc 已剥版本 + 截 250
  if (cmd.subskills && cmd.subskills.length > 0) {
    return base + `（子：${cmd.subskills.join('、')}）`
  }
  return base
}
```

在 `formatCommandsWithinBudget` 开头（`const budget = getCharBudget(...)` 之后）过滤并重算：

```ts
  const visible = commands.filter(cmd => !cmd.parent)
  if (visible.length === 0) return ''
```

后续所有 `commands` 引用替换为 `visible`（fullEntries/分区/预算计算一致）。`fullTotal` 计算中父条目字符数 = `formatCommandDescription` + 子名串（`（子：…）`）；`MIN_DESC_LENGTH` 极端降级分支对父技能保持 `- {name}（子：…）`（子名不丢）。

- [ ] **Step 6: 写失败测试 `tests/smoke/skill-listing.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { formatCommandsWithinBudget } from '../../src/tools/SkillTool/prompt.js'
import type { Command } from '../../src/commands.js'

function makeCmd(name: string, description: string, extra: Partial<Command> = {}): Command {
  return { name, description, type: 'prompt', source: 'custom', ...extra } as Command
}

describe('formatCommandsWithinBudget 版本历史剥离', () => {
  it('剥离描述尾部内嵌版本日志段落', () => {
    const out = formatCommandsWithinBudget([makeCmd('demo', '研发立项报告撰写。v1.0.0初始版本：模板。v1.1.0新增：验收模板。')], 200_000)
    expect(out).not.toMatch(/v1\.0\.0|v1\.1\.0/)
    expect(out).toContain('研发立项报告撰写')
  })
  it('不误删正文中的不完整版本号（v1.0 两段数字）', () => {
    const out = formatCommandsWithinBudget([makeCmd('demo', '基于 v1.0 协议实现的工具')], 200_000)
    expect(out).toContain('基于 v1.0 协议实现的工具')
  })
  it('版本日志在描述中间也被剥离', () => {
    const out = formatCommandsWithinBudget([makeCmd('demo', '核心表格统筹。v1.39.0核心架构变更：提示词驱动。后续说明。')], 200_000)
    expect(out).not.toMatch(/v1\.39\.0/)
    expect(out).toContain('后续说明')
  })
  it('剥离后为空时保留条目', () => {
    const out = formatCommandsWithinBudget([makeCmd('demo', 'v1.0.0初始版本：测试。')], 200_000)
    expect(out).toContain('- demo')
  })
  it('whenToUse 拼接后同样剥离', () => {
    const out = formatCommandsWithinBudget([makeCmd('demo', '写立项报告', { whenToUse: '当用户提到立项报告。v2.0.0重构：拆分。' })], 200_000)
    expect(out).not.toMatch(/v2\.0\.0/)
    expect(out).toContain('当用户提到立项报告')
  })
})

describe('formatCommandsWithinBudget 层级渲染', () => {
  it('有 parent 的子技能条目不渲染', () => {
    const out = formatCommandsWithinBudget([
      makeCmd('suite', '总路由', { subskills: ['sub-a', 'sub-b'] }),
      makeCmd('sub-a', '子技能A', { parent: 'suite' }),
      makeCmd('sub-b', '子技能B', { parent: 'suite' }),
      makeCmd('indep', '独立技能', {}),
    ], 200_000)
    expect(out).toContain('- suite')
    expect(out).toContain('（子：sub-a、sub-b）')
    expect(out).toContain('- indep')
    expect(out).not.toContain('子技能A')
    expect(out).not.toContain('子技能B')
  })
  it('无 subskills 的普通技能正常渲染', () => {
    const out = formatCommandsWithinBudget([makeCmd('indep', '独立技能')], 200_000)
    expect(out).toContain('- indep: 独立技能')
  })
  it('全部为子技能时返回空串', () => {
    const out = formatCommandsWithinBudget([
      makeCmd('sub-a', 'A', { parent: 'suite' }),
    ], 200_000)
    expect(out).toBe('')
  })
})
```

- [ ] **Step 7: 运行测试确认失败 → 通过**

Run: `cd ponos-kernel/claude-code && ~/.bun/bin/bun.exe run test`
Expected: 先 FAIL（层级/剥离未实现）→ Step 2-5 实现后 PASS（含既有 `tests/smoke/*` 基线）

- [ ] **Step 8: 提交**

```bash
git add ponos-kernel/claude-code/src/types/command.ts ponos-kernel/claude-code/src/skills/loadSkillsDir.ts ponos-kernel/claude-code/src/tools/SkillTool/prompt.ts ponos-kernel/claude-code/tests/smoke/skill-listing.test.ts
git commit -m "feat(kernel): skill 清单层级化渲染（Command.parent/subskills + 版本剥离 + 子条目隐藏/父内联）"
```

---

### Task 3: 技能库层级化改造（64 个 SKILL.md）

**Files:**
- Create: `~/.ponos/skills/gxtz-suite/SKILL.md`
- Create: `scripts/aggregate-skill-triggers.mjs`（聚合触发词初稿生成）
- Modify: `~/.ponos/skills/using-superpowers/SKILL.md`、`yfwdoc-suite/SKILL.md`、`yfwweb-suite/SKILL.md`、`yfwx-suite/SKILL.md`
- Modify: 53 个子技能 SKILL.md（frontmatter 加一行 `parent: <父名>`）
- ⚠️ 技能库在 `~/.ponos/skills`，**不在 git 仓库**——所有批量修改先备份到 `%TEMP%/skills-backup-<日期>/`

**Interfaces:**
- Consumes: spec 4.2 分类表（5 父 / 53 子 / 6 独立）
- Produces: 技能库层级化完成——Task 4 验证脚本断言 5/53/6 全绿

- [ ] **Step 1: 备份技能库**

```bash
mkdir -p "$TEMP/skills-backup-$(date +%Y%m%d)" && cp -r ~/.ponos/skills "$TEMP/skills-backup-$(date +%Y%m%d)/"
```

- [ ] **Step 2: 写聚合触发词脚本 `scripts/aggregate-skill-triggers.mjs`**

从子技能 frontmatter 聚合触发词初稿（读 triggers 字段，无则 description 前 40 字符的关键场景句），去重后按 `当用户提到A、B、C…时调用` 格式输出父技能 description 初稿：

```js
// 聚合子技能触发词生成父技能 description 初稿（人工审定后写入父技能 frontmatter）
// 用法：node scripts/aggregate-skill-triggers.mjs gxtz-suite [--print]
import { readFileSync, readdirSync, existsSync, join } from 'fs'
import { homedir } from 'os'

const SKILLS_DIR = join(homedir(), '.ponos', 'skills')
const parentName = process.argv[2]
if (!parentName) { console.error('用法: node scripts/aggregate-skill-triggers.mjs <父技能名>'); process.exit(1) }

// 子技能 = 声明了 parent: <parentName> 的技能（frontmatter 解析）
function parseFrontmatter(md) {
  const yaml = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!yaml) return {}
  const get = (re) => { const m = yaml[1].match(re); return m ? m[1].trim().replace(/^["']|["']$/g, '') : '' }
  const list = (key) => {
    const re = new RegExp('^' + key + ':\\s*\\n((?:\\s*-\\s*.+\\n?)+)', 'm')
    const m = yaml[1].match(re)
    return m ? m[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []
  }
  return { name: get(/name:\s*["']?(.+?)["']?\s*$/m), description: get(/description:\s*["']?(.+?)["']?\s*$/m), triggers: list('triggers'), parent: get(/^parent:\s*["']?(.+?)["']?\s*$/m) }
}

const children = []
for (const it of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!it.isDirectory() || it.name.startsWith('_')) continue
  const entry = join(SKILLS_DIR, it.name, 'SKILL.md')
  if (!existsSync(entry)) continue
  const fm = parseFrontmatter(readFileSync(entry, 'utf-8'))
  if (fm.parent === parentName) children.push({ dir: it.name, ...fm })
}

// 聚合：triggers 优先，无则从 description 提取"当用户提到…时调用"场景段
const seen = new Set()
const terms = []
for (const c of children) {
  const src = c.triggers.length ? c.triggers : [c.description]
  for (const t of src) {
    const key = t.replace(/[，。、]/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(t)
  }
}
console.log(`子技能数：${children.length}`)
console.log(`聚合触发词初稿（${terms.length} 项）：`)
console.log(`description: "${parentName} 是总路由父技能。当用户提到${terms.join('、').slice(0, 200)}…时调用本技能，再按目录索引具体子技能。"`)
```

- [ ] **Step 3: 用脚本生成 5 个父技能的聚合触发词初稿并人工审定**

Run（依次）:
```bash
node scripts/aggregate-skill-triggers.mjs gxtz-suite --print
node scripts/aggregate-skill-triggers.mjs yfwdoc-suite --print
node scripts/aggregate-skill-triggers.mjs yfwweb-suite --print
node scripts/aggregate-skill-triggers.mjs yfwx-suite --print
node scripts/aggregate-skill-triggers.mjs using-superpowers --print
```
Expected: 每个父技能输出子技能数（23/5/3/7/15）与触发词初稿。**人工审定**初稿（去重、补漏、控制 ≤1024 字符），写入对应父技能 frontmatter `description`。

- [ ] **Step 4: 新制 `gxtz-suite/SKILL.md`**

创建 `~/.ponos/skills/gxtz-suite/SKILL.md`，结构：

```markdown
---
name: gxtz-suite
description: "<Step 3 审定的聚合触发词>"
triggers:
  - 高企认定
  - 高新技术企业申报
  - 知识产权材料
  - 研发立项报告
  - 管理制度材料
  - 科技人员材料
  - 申报材料打包
  - 研发费用辅助账
  - 高新产品证明
  - 专审报告核对
subskills:
  - gxtz-achievement-materials
  - gxtz-audit-verification
  - gxtz-contract-review
  - gxtz-core-tables
  - gxtz-experience-sync
  - gxtz-file-compressor
  - gxtz-file-organizer
  - gxtz-info-collector
  - gxtz-innovation-statement
  - gxtz-invoice-ps-matching
  - gxtz-ip-materials
  - gxtz-ip-tables
  - gxtz-management-materials
  - gxtz-precision-refiner
  - gxtz-progress-manager
  - gxtz-ps-materials
  - gxtz-ps-tables
  - gxtz-rd-report
  - gxtz-rd-tables
  - gxtz-staff-materials
  - gxtz-submission-packager
  - gxtz-toai-tables
  - gxtz-wecom-collector
---

# gxtz-suite —— 高企认定材料总路由

**本技能是总路由，先定位具体子技能，再调用子技能执行；本文件不做具体材料工作。**

## 子技能目录

| 子技能 | 一句话职责 | 触发场景 |
|---|---|---|
| gxtz-info-collector | 企业信息调查与收资清单 | 信息收集、资料清单 |
| gxtz-ip-materials | 知识产权证明材料整理 | 专利、软著、IP材料 |
| gxtz-rd-report | 研发立项报告撰写 | 立项报告、RD报告 |
| gxtz-core-tables | 核心表格统筹（RD/PS/IP/TOAI） | RD表、PS表、IP表、TOAI汇总 |
| gxtz-rd-tables | RD研发项目表 | 研发项目表 |
| gxtz-ps-tables | PS高新产品表 | 高新产品表 |
| gxtz-ip-tables | IP知识产权表 | 知识产权表 |
| gxtz-toai-tables | TOAI汇总表 | 汇总表 |
| gxtz-ps-materials | 高新产品证明材料 | 产品证明、合同发票 |
| gxtz-management-materials | 管理制度及证明 | 研发制度、辅助账 |
| gxtz-staff-materials | 科技人员材料 | 人员比例、社保 |
| gxtz-innovation-statement | 创新能力四段文案 | 申报书创新文案 |
| gxtz-audit-verification | 专审报告核对 | 专审核对 |
| gxtz-contract-review | 技术合同评估审查 | 技术合同审查 |
| gxtz-achievement-materials | 科技成果转化证明 | 成果转化材料 |
| gxtz-invoice-ps-matching | 发票PS筛选匹配 | 发票匹配 |
| gxtz-experience-sync | 经验积累与同步 | 经验同步 |
| gxtz-file-compressor | 申报材料压缩 | 文件压缩 |
| gxtz-file-organizer | 申报材料整理归类 | 资料整理 |
| gxtz-precision-refiner | 材料核对精修 | 精修、问题修正 |
| gxtz-progress-manager | 项目进度看板 | 进度查看 |
| gxtz-submission-packager | 申报材料打包上传 | 打包、上传 |
| gxtz-wecom-collector | 企微会话资料收集 | 企微收集 |

## 分派规则

1. 用户诉求 → 在目录表定位最匹配子技能 → `skill: "gxtz-<name>"` 调用
2. 模糊诉求 → 先问清（ASK_USER）或调用 gxtz-info-collector 摸底
3. 复合流程 → 按材料生命周期顺序串联子技能（收资 → 撰写 → 表格 → 核对 → 打包）
4. 全部 gxtz-* 子技能均可直接 Skill 调用，无需先调本技能（本技能仅作入口索引）

## 禁止事项

- 本技能不直接执行子技能工作流（懒加载子技能 SKILL.md）
- 不编造数据；数据以专审/财审定稿 PDF 为准
```

（目录表其余行按 4.2 spec 分类表补全；职责/触发场景参照各子技能 description 提炼。）

- [ ] **Step 5: 改造 `using-superpowers/SKILL.md` 为父技能**

`~/.ponos/skills/using-superpowers/SKILL.md` frontmatter 改为（保留 name/description 原意并聚合触发词）：

```yaml
---
name: using-superpowers
description: "<Step 3 审定的聚合触发词，覆盖 brainstorming/计划/测试/调试/评审/提交等流程场景>"
subskills:
  - brainstorming
  - code-review-and-quality
  - dispatching-parallel-agents
  - example-skill
  - executing-plans
  - finishing-a-development-branch
  - receiving-code-review
  - requesting-code-review
  - subagent-driven-development
  - systematic-debugging
  - test-driven-development
  - using-git-worktrees
  - verification-before-completion
  - writing-plans
  - writing-skills
---
```

正文在现有内容（SUBAGENT-STOP/EXTREMELY-IMPORTANT/调用规则等**全部保留**）基础上，追加"## 子技能目录"表（15 个子技能：名字 + 一句话职责 + 触发场景）与"分派规则"（流程技能优先：brainstorming 先行 → writing-plans → subagent-driven-development/executing-plans → verification-before-completion；调试走 systematic-debugging；测试走 test-driven-development；评审走 requesting/receiving-code-review；收尾走 finishing-a-development-branch）。

- [ ] **Step 6: 改造 `yfwdoc-suite`/`yfwweb-suite`/`yfwx-suite`**

三个 suite frontmatter 加 `subskills` 列表（yfwdoc：word/pptx/pdf/excel/template；yfwweb：scrape/form/verify；yfwx：qualification-chain/kexiao/zhuanjingtexin/xiaojuren/dengling/unicorn/seal-extract），description 更新为 Step 3 审定的聚合触发词，正文核对现有"子技能目录/分派"章节完备（若已有则保留，只补缺失子技能与触发词）。

- [ ] **Step 7: 53 个子技能批量标注 parent**

写一次性脚本（或手工逐文件）在 53 个子技能 frontmatter 的 `---` 后插入一行 `parent: <父名>`。**先 `--dry-run` 输出全部 diff 再执行**：

```js
// scripts/annotate-skill-parent.mjs —— 批量标注（--dry-run 预览 / 默认执行）
import { readFileSync, writeFileSync, readdirSync, existsSync, join } from 'fs'
import { homedir } from 'os'

const SKILLS_DIR = join(homedir(), '.ponos', 'skills')
// 分类表（spec 4.2，53 项完整映射；键=目录名）：
const MAP = {
  // gxtz → gxtz-suite（23）
  'gxtz-achievement-materials': 'gxtz-suite',
  'gxtz-audit-verification': 'gxtz-suite',
  'gxtz-contract-review': 'gxtz-suite',
  'gxtz-core-tables': 'gxtz-suite',
  'gxtz-experience-sync': 'gxtz-suite',
  'gxtz-file-compressor': 'gxtz-suite',
  'gxtz-file-organizer': 'gxtz-suite',
  'gxtz-info-collector': 'gxtz-suite',
  'gxtz-innovation-statement': 'gxtz-suite',
  'gxtz-invoice-ps-matching': 'gxtz-suite',
  'gxtz-ip-materials': 'gxtz-suite',
  'gxtz-ip-tables': 'gxtz-suite',
  'gxtz-management-materials': 'gxtz-suite',
  'gxtz-precision-refiner': 'gxtz-suite',
  'gxtz-progress-manager': 'gxtz-suite',
  'gxtz-ps-materials': 'gxtz-suite',
  'gxtz-ps-tables': 'gxtz-suite',
  'gxtz-rd-report': 'gxtz-suite',
  'gxtz-rd-tables': 'gxtz-suite',
  'gxtz-staff-materials': 'gxtz-suite',
  'gxtz-submission-packager': 'gxtz-suite',
  'gxtz-toai-tables': 'gxtz-suite',
  'gxtz-wecom-collector': 'gxtz-suite',
  // yfwdoc → yfwdoc-suite（5）
  'yfwdoc-word': 'yfwdoc-suite',
  'yfwdoc-pptx': 'yfwdoc-suite',
  'yfwdoc-pdf': 'yfwdoc-suite',
  'yfwdoc-excel': 'yfwdoc-suite',
  'yfwdoc-template': 'yfwdoc-suite',
  // yfwweb → yfwweb-suite（3）
  'yfwweb-scrape': 'yfwweb-suite',
  'yfwweb-form': 'yfwweb-suite',
  'yfwweb-verify': 'yfwweb-suite',
  // yfwx → yfwx-suite（7）
  'yfwx-qualification-chain': 'yfwx-suite',
  'yfwx-kexiao': 'yfwx-suite',
  'yfwx-zhuanjingtexin': 'yfwx-suite',
  'yfwx-xiaojuren': 'yfwx-suite',
  'yfwx-dengling': 'yfwx-suite',
  'yfwx-unicorn': 'yfwx-suite',
  'yfwx-seal-extract': 'yfwx-suite',
  // superpowers → using-superpowers（15）
  'brainstorming': 'using-superpowers',
  'code-review-and-quality': 'using-superpowers',
  'dispatching-parallel-agents': 'using-superpowers',
  'example-skill': 'using-superpowers',
  'executing-plans': 'using-superpowers',
  'finishing-a-development-branch': 'using-superpowers',
  'receiving-code-review': 'using-superpowers',
  'requesting-code-review': 'using-superpowers',
  'subagent-driven-development': 'using-superpowers',
  'systematic-debugging': 'using-superpowers',
  'test-driven-development': 'using-superpowers',
  'using-git-worktrees': 'using-superpowers',
  'verification-before-completion': 'using-superpowers',
  'writing-plans': 'using-superpowers',
  'writing-skills': 'using-superpowers',
}
const dryRun = process.argv.includes('--dry-run')
let changed = 0
for (const [key, parent] of Object.entries(MAP)) {
  const entry = join(SKILLS_DIR, key, 'SKILL.md')
  if (!existsSync(entry)) { console.error('缺失: ' + key); process.exit(1) }
  let md = readFileSync(entry, 'utf-8')
  if (!/^---\r?\n/.test(md)) { console.error('无 frontmatter: ' + key); process.exit(1) }
  if (md.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1].includes('parent:')) { console.log('已有 parent，跳过: ' + key); continue }
  const next = md.replace(/^(---\r?\n)/, `$1parent: ${parent}\n`)
  if (dryRun) { console.log(`[dry-run] ${key} → parent: ${parent}`) }
  else { writeFileSync(entry, next); changed++ }
}
console.log(dryRun ? `\n[dry-run] 预览完成` : `\n已标注 ${changed} 个技能`)
```

实际执行：先 `node scripts/annotate-skill-parent.mjs --dry-run` 人工核对 53 项映射，再 `node scripts/annotate-skill-parent.mjs`。

- [ ] **Step 8: 中间验证（技能库自洽）**

Run: `node scripts/aggregate-skill-triggers.mjs gxtz-suite` 等输出子技能数仍为 23/5/3/7/15（说明 parent 标注与 subskills 声明一致）；抽查 5 个文件的 frontmatter 结构。

- [ ] **Step 9: 提交（仅仓库内文件）**

```bash
git add scripts/aggregate-skill-triggers.mjs scripts/annotate-skill-parent.mjs
git commit -m "feat(skills): 技能库层级化改造辅助脚本（聚合触发词生成 + parent 批量标注）"
```

（技能库本体在 `~/.ponos/skills`，git-ignored 不提交——备份见 Step 1。）

---

### Task 4: 全量实测与互逆校验

**Files:**
- 验证类，无代码改动；发现问题回到 Task 1-3 修复

**Interfaces:**
- Consumes: Task 1 验证脚本、Task 2 测试、Task 3 技能库标注

- [ ] **Step 1: 宿主清单实测（技能库标注后）**

Run: `node scripts/verify-skill-listing.mjs`
Expected: **全部断言全绿**——父技能 5 / 子技能 53 / 独立 6；子技能名不独立成条；父条目内联全部子名；互逆一致；宿主清单字符数 < 4000（记录实际值，目标 ~2-3K）。

- [ ] **Step 2: 内核清单实测**

Run: `cd ponos-kernel/claude-code && ~/.bun/bin/bun.exe run test`
Expected: 全部 PASS（单元 + 真实命令集）。真实命令集（getSkillToolCommands → formatCommandsWithinBudget）输出字符数人工记录（预期 < 5K，对比改造前 11,566）。

- [ ] **Step 3: 聚合触发词抽查**

对照 5 个父技能 description：gxtz-suite 含"知识产权/专利/软著/立项报告/管理制度/科技人员/打包/辅助账/高新产品"等子技能场景；using-superpowers 含"计划/测试/调试/评审/提交"等；yfwdoc-suite 含"文档/PPT/PDF/Excel/模板"；yfwweb-suite 含"抓取/填表/核验"；yfwx-suite 含"资质规划/科小/专精特新/小巨人/瞪羚/独角兽/公章"。

- [ ] **Step 4: 执行能力回归（diff 检查）**

Run: `git diff HEAD --stat`
Expected: 仅 `server/bridge.mjs`、`scripts/verify-skill-listing.mjs`、`scripts/aggregate-skill-triggers.mjs`、`scripts/annotate-skill-parent.mjs`、`ponos-kernel/claude-code/src/types/command.ts`、`ponos-kernel/claude-code/src/skills/loadSkillsDir.ts`、`ponos-kernel/claude-code/src/tools/SkillTool/prompt.ts`、`ponos-kernel/claude-code/tests/smoke/skill-listing.test.ts` 在改动集合内；`SkillTool.ts`、`commands.ts`、`attachments.ts`、`bootstrap/state.ts` 均不在 diff（调用执行/子代理注入/全文注入路径零改动）。

- [ ] **Step 5: 结论落账**

实测数字（宿主 11,073 → 实际；内核 11,566 → 实际；清单条数 63 → 11）与 e2e 冒烟状态（deferred 至用户重启）记录到 `.superpowers/sdd/2026-08-14-skill-listing-slim/progress.md`（git-ignored）。

---

### Task 5: release 双份同步 + sha256 校验

**Files:**
- Modify: `release/Ponos/server/bridge.mjs`、`release/Ponos_ms92cd6u/server/bridge.mjs`（复制自 workspace）
- Modify: `release/Ponos/kernel/cli.mjs`、`release/Ponos_ms92cd6u/kernel/cli.mjs`（rebuild 后复制）
- 说明：release 目录 git-ignored，本任务不提交 git

**Interfaces:**
- Consumes: Task 1-4 的 workspace 改动
- Produces: 三端一致的可运行副本（sha256 相等）

- [ ] **Step 1: 同步 server/bridge.mjs 双份**

```bash
cd C:/Users/T203-15/claude-code-gui
cp server/bridge.mjs release/Ponos/server/bridge.mjs
cp server/bridge.mjs release/Ponos_ms92cd6u/server/bridge.mjs
```

- [ ] **Step 2: rebuild 内核 bundle**

Run: `cd ponos-kernel/claude-code && ~/.bun/bin/bun.exe scripts/build-bundle.ts`
Expected: 生成 `ponos-kernel/claude-code/dist/cli.mjs`（无报错；不传 `--minify`，沿用既有构建参数）

- [ ] **Step 3: 同步 kernel 双份**

```bash
cd C:/Users/T203-15/claude-code-gui
cp ponos-kernel/claude-code/dist/cli.mjs release/Ponos/kernel/cli.mjs
cp ponos-kernel/claude-code/dist/cli.mjs release/Ponos_ms92cd6u/kernel/cli.mjs
# vendor 仅在存在差异时同步
diff -rq ponos-kernel/claude-code/dist/vendor release/Ponos/kernel/vendor 2>/dev/null || cp -r ponos-kernel/claude-code/dist/vendor/. release/Ponos/kernel/vendor/
diff -rq ponos-kernel/claude-code/dist/vendor release/Ponos_ms92cd6u/kernel/vendor 2>/dev/null || cp -r ponos-kernel/claude-code/dist/vendor/. release/Ponos_ms92cd6u/kernel/vendor/
```

- [ ] **Step 4: sha256 三端一致校验**

Run: `sha256sum ponos-kernel/claude-code/dist/cli.mjs release/Ponos/kernel/cli.mjs release/Ponos_ms92cd6u/kernel/cli.mjs server/bridge.mjs release/Ponos/server/bridge.mjs release/Ponos_ms92cd6u/server/bridge.mjs`
Expected: cli.mjs 三个 hash 相同；bridge.mjs 三个 hash 相同（跨组不同属正常）

- [ ] **Step 5: 重启授权 + 生效**

**不擅自重启**——向用户说明"改造已同步 release 双份，重启 live 应用后生效，是否现在重启？"用户同意后由其执行或按其指示操作；若稍后则 e2e 冒烟标记 deferred（长会话下技能清单 11 条、子技能可调、父技能聚合触发词触发）。

---

## 同步与发布速查

| 文件 | 同步目标 |
|---|---|
| `server/bridge.mjs` | `release/Ponos/server/` + `release/Ponos_ms92cd6u/server/` |
| `ponos-kernel/claude-code/dist/cli.mjs`（rebuild） | `release/Ponos/kernel/` + `release/Ponos_ms92cd6u/kernel/` |
| `~/.ponos/skills/**/SKILL.md` | 用户目录直接生效（宿主指纹重建；内核 memoize 需新会话/重启） |

- sha256 三端一致（Task 5 Step 4）；不打包；生效需重启 live app（先征得用户同意）
