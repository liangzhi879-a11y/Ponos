# 上下文失真健康 · 实施计划（内核检测 + 契约 + GUI 两级动作）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上下文健康模块的被测量从"压力（还能装多少）"换成"失真（还准不准）"，使弹窗建议只在**失真过多**时出现，并提供「重新锚定（轻）→ 携带摘要新建会话（重）」两级动作。

**Architecture:** 新增内核纯函数模块 `kernel/fidelity.mjs`（证据抽取 / 衰减聚合 / 去抖 / 锚点拼接，零模型调用），由 `kernel/health.mjs` 装配进既有 `ponos_health` 事件的可选字段 `distortion`（压力字段与语义完全不动）。引擎在轮尾喂"内容侧观测"（本轮 user/assistant 文本 + 工具结果摘要），压缩器在 `landSummary` 落地时喂保真审计。GUI 侧判定全部落在纯函数 `src/lib/healthUi.ts`，组件按新档位渲染证据清单与两级动作；锚定生效经 `POST /session/anchor-applied` → 内核 stdin 回执 → `fidelity.markResolved()`。

**Tech Stack:** 内核 Node ESM（零外部依赖，仅 `node:*` 与仓库内相对路径）；测试 `node --test`（Node 24，`.mjs` 与 `.ts` 均可直跑）；前端 React 18 + zustand + Tailwind；无新依赖。

**设计依据：** `docs/superpowers/specs/2026-09-12-context-fidelity-health-design.md`（本计划逐节对应其 §1–§13）

**已采纳的评审项（spec §13 推荐项，用户"继续"即采纳）：** ①红色泛光改由失真红触发；②新增 `POST /session/anchor-applied`；③压缩点 LLM 保真审计默认开；④"说到做不到"留二期；⑤失真证据不落盘（仅进程内 + 前端 persisted 快照）。

## Global Constraints

- **内核零外部依赖**：`kernel/**` 只能 import `node:*` 与仓库内相对路径；`scripts/build-kernel.mjs`（bun build `--external=node:*`）必须仍能打包成功。
- **压力语义冻结**：`ponos_health.tier` 的取值规则与文案一律不改（血条继续读它）；失真档位只出现在 `distortion.tier`。**两个 tier 严禁互相赋值**，每个相关任务都要有"互不干扰"断言。
- **契约纯增量**：`distortion` 为可选字段；老 GUI 忽略它；老内核不发它时前端一律按 green（默认健康）。
- **静默降级**：fidelity 的任一函数异常都不得影响主流程（与 `health.mjs` 同款 try/catch 纪律）；检测器不得抛穿 `runTurn`。
- **测试命令**：内核 `node --test kernel-tests/<file>.test.mjs`；前端纯函数 `node --test src/lib/<file>.test.ts`；桥/宿主 `npm test`（= `node --test "server/*.test.mjs" "electron/*.test.mjs"`）。
- **回归基线**：改动前后各跑一次 `npm test` 与 `node --test "kernel-tests/*.test.mjs"`（除本计划新增用例，不得有新增失败）。
- **测试 hermetic**：涉及 `createHealth` 的测试必须传 `env: {}` 隔离（防 `PONOS_HEALTH_COMPACT_COUNT` 泄漏）；涉及模型的审计测试用 `PONOS_MOCK_API=1` 门控 + `mockStream` 新 marker 分支。
- **性能上限**：单轮参与检测的文本合计 ≤ `PONOS_FIDELITY_MAX_TEXT`（默认 20 万字符，超出截断）；锚点文本 ≤ 4KB。
- **不落盘**：失真证据只存内存与前端 persisted 快照，不写 transcript、不写独立日志文件。

---

## 文件结构（本计划锁定）

| 文件 | 动作 | 职责 |
|---|---|---|
| `kernel/fidelity.mjs` | 新建 | 证据抽取与聚合：`extractEntities` / `normalizeEntity` / `missingEntities` / `extractFacts` / `detectContradictions` / `extractConstraints` / `detectUserCorrection` / `detectRequirementChange` / `taskCoverage` / `buildAnchorText` / `createFidelity` |
| `kernel-tests/fidelity.test.mjs` | 新建 | 纯函数 + 聚合器全量验收（含假红/假绿/回绿/去抖/衰减） |
| `kernel/health.mjs` | 改 | 装配 fidelity；`snapshot()` 增 `distortion`；`emitIfChanged` 把失真档变化也当变化；`recordTurnContent` / `recordCompactionAudit` / `markFidelityResolved` / `fidelityEvidence` |
| `kernel-tests/health-distortion.test.mjs` | 新建 | 事件契约 + 两 tier 互不干扰 + 老内核缺字段兼容 |
| `kernel/engine.mjs` | 改 | 轮尾收集内容侧 digest（toolDigest / assistantTexts）并交给 health |
| `kernel/cli.mjs` | 改 | `createHealth` 注入锚点源与压缩审计回调；stdin 增 `anchor_applied`；压缩后触发审计 |
| `kernel/api.mjs` | 改 | 新增 mock marker `[mock:fidelity-read-fail]`（仅供引擎失真观测测试） |
| `kernel-tests/engine-fidelity.test.mjs` | 新建 | 引擎喂观测的端到端（mock）用例 |
| `kernel/compact.mjs` | 改 | `landSummary` 落地时产出确定性保真审计；新增 LLM 保真审计调用（可关） |
| `kernel-tests/compact-fidelity.test.mjs` | 新建 | 摘要审计：丢实体 / 完整 / 稀疏不判定 / LLM 失败不影响落地与熔断 |
| `src/lib/healthUi.ts` | 改 | 新增 `distortionState` / `shouldShowDistortionAlert` / `anchorTextFrom` / `mergeIssues` |
| `src/lib/healthUi.test.ts` | 改 | 上列纯函数用例（假红/假绿/去抖/回绿） |
| `src/stores/healthStore.ts` | 改 | 增失真快照与去抖/冷却/观察期状态；`reset` 一并清 |
| `src/components/chat/HealthMeter.tsx` | 改 | 血条语义不变；失真 ≥ amber 时显示失真角标 + tooltip 证据摘要 |
| `src/components/chat/HealthSuggestCard.tsx` | 改 | 触发源改为失真红；正文=证据清单；两级动作 |
| `src/components/chat/HealthGlow.tsx` | 改 | 泛光触发由压力红改为失真红 |
| `src/hooks/useYFWCLI.ts` | 改 | 锚定应用后上行 `POST /session/anchor-applied` |
| `src/i18n/translations/{zh-CN,en-US}.ts` | 改 | `health.distortion.*` 文案 |
| `server/bridge.mjs` | 改 | 新增 `POST /session/anchor-applied` 路由（复用 `writeControlRequest`，:810） |
| `server/health-anchor.test.mjs` | 新建 | 路由契约：写入内核 stdin / 会话不存在时的回执 |
| `docs/bridge-contract.md` | 改 | 增补 `ponos_health.distortion` 字段表；`anchor_applied` stdin 子命令 |
| `docs/manual/YFWorking产品使用说明书.md` | 改 | 血条/建议卡章节改述（压力=仪表、失真=弹窗） |

依赖顺序：Task 1 → 2 → 3 →（4 与 5 可并行）→ 6 → 7 → 8。

---

### Task 1: 失真检测纯函数与聚合器（无接线，零行为变更）

**Files:**
- Create: `kernel/fidelity.mjs`
- Test: `kernel-tests/fidelity.test.mjs`

**Interfaces:**
- Consumes: 无（本计划起点）
- Produces（后续任务全部依赖此签名，不得改名）：

```js
export const DEFAULT_FIDELITY_CONFIG = {
  windowTurns: 12, decay: 0.85, red: 70, amber: 40,
  summaryMissingStrong: 0.4, summaryMissingMedium: 0.2,
  minEntities: 3, goalCoverageMin: 0.15, goalWindow: 6,
  observeTurns: 3, maxText: 200_000,
}
export function fidelityConfigFromEnv(env = process.env) → config
// —— 纯函数（无状态，全部可单测）——
export function normalizeEntity(s) → string
export function extractEntities(text, { max = 200 } = {}) → string[]
export function missingEntities(entities, summary) → { missing: string[], total: number, ratio: number }
export function extractFacts(text) → Array<{ key: string, value: string, sentence: string }>
export function detectContradictions(factsByTurn) → Array<{ key, a, b, turnA, turnB }>
export function extractConstraints(text) → string[]
export function detectUserCorrection(userText) → { corrected: boolean, phrases: string[] }
export function detectRequirementChange(userText) → boolean
export function taskCoverage(anchorEntities, texts) → number      // 0..1
export function buildAnchorText({ task, memoryText, missing, constraints, maxBytes = 4096 }) → string
// —— 聚合器（有状态；去抖/衰减/回绿/观察期）——
export function createFidelity({ config, getAnchorSource, now } = {}) → {
  recordTurn({ user, assistant, toolDigest }) → FidelityIssue[]   // 轮序号由内部自增
  recordCompactionAudit({ entities, missing, ratio, llm }) → FidelityIssue[]
  markResolved(issueIds) → number
  snapshot() → { score, tier, axes, issues, trigger, observeUntilTurn, anchorAvailable, anchorText }
  evidenceLog() → { active: FidelityIssue[], resolved: FidelityIssue[] }
  reset()
}
```

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/fidelity.test.mjs`，先写下列用例（**先红后绿**）：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractEntities, missingEntities, extractFacts, detectContradictions,
  detectUserCorrection, detectRequirementChange, taskCoverage, buildAnchorText,
  createFidelity,
} from '../kernel/fidelity.mjs'

test('extractEntities：路径/数字/约束/标识符都抽到且归一化', () => {
  const e = extractEntities('按 SPEC 必须把 src/a.ts 的行号上限设为 120，运行 `npm test` 验证 C:\\x\\y.md')
  assert.ok(e.some(x => x.includes('src/a.ts')), '路径要抽到')
  assert.ok(e.some(x => x.includes('120')), '数字要抽到')
  assert.ok(e.some(x => /npm test/.test(x)), '反引号标识符要抽到')
})

test('missingEntities：summary 覆盖全部实体 → ratio 0；丢路径 → 命中', () => {
  const e = extractEntities('必须保留 src/a.ts、src/b.ts 与阈值 120')
  const full = missingEntities(e, '仍需保留 src/a.ts、src/b.ts，阈值 120 不变')
  assert.equal(full.ratio, 0)
  const lost = missingEntities(e, '继续之前的开发工作')
  assert.ok(lost.ratio >= 0.5, '关键实体成片丢失')
  assert.equal(missingEntities(['a'], 'a').total < 3, true, 'total<3 时调用方不判定（minEntities）')
})

test('extractFacts + detectContradictions：同 key 互斥取值 → 冲突；显式演进不计', () => {
  const f1 = extractFacts('模型用 deepseek-v4-flash，上限设 0.8')
  const f2 = extractFacts('模型用 deepseek-v4-flash')
  assert.ok(detectContradictions([f1, f2]).length === 0, '同值不算冲突')
  const f3 = extractFacts('上限已改为 0.5')
  assert.equal(detectContradictions([f1, f3]).length, 0, '显式演进（已改为）不计矛盾')
  const f4 = extractFacts('上限设 0.5')
  assert.ok(detectContradictions([f1, f4]).length >= 1, '无演进语的互斥取值算冲突')
})

test('detectUserCorrection / detectRequirementChange', () => {
  assert.equal(detectUserCorrection('我前面说过数据库是 MySQL').corrected, true)
  assert.equal(detectUserCorrection('继续').corrected, false)
  assert.equal(detectRequirementChange('先放一放，改做导出功能'), true)
  assert.equal(detectRequirementChange('继续实现'), false)
})

test('taskCoverage：延续任务高、无关任务低', () => {
  const anchor = extractEntities('实现 workflow 画布的删除交互')
  assert.ok(taskCoverage(anchor, ['删除交互已完成，新增确认框']) > 0.3)
  assert.ok(taskCoverage(anchor, ['今天天气不错']) < 0.15)
})

test('假绿：无信号恒 green、不弹窗', () => {
  const f = createFidelity({ getAnchorSource: () => ({}) })
  f.recordTurn({ user: '实现 A', assistant: '好的，开始实现 A', toolDigest: [] })
  const s = f.snapshot()
  assert.equal(s.tier, 'green')
  assert.equal(s.trigger, null)
  assert.equal(s.score, 0)
})

test('强证据直通：摘要实体缺失率 ≥ 0.4 → red + trigger 非空', () => {
  const f = createFidelity({ getAnchorSource: () => ({ task: '实现 A' }) })
  const issues = f.recordCompactionAudit({
    entities: ['src/a.ts', 'src/b.ts', 'src/c.ts', '阈值 120'],
    missing: ['src/a.ts', 'src/b.ts'],
    ratio: 0.5,
  })
  assert.equal(issues[0].strength, 'strong')
  const s = f.snapshot()
  assert.equal(s.tier, 'red')
  assert.ok(s.trigger)
  assert.ok(s.issues.some(i => i.kind === 'summary-missing-entity'))
})

test('中证据累积：单点不弹（amber）、两点转 amber 且不直通、三点仍 amber', () => {
  const f = createFidelity({ getAnchorSource: () => ({}) })
  f.recordTurn({ user: '引用 src/gone.ts 继续', assistant: '读取 src/gone.ts', toolDigest: [{ name: 'Read', path: 'src/gone.ts', isError: true, errorText: 'ENOENT: no such file' }] })
  let s = f.snapshot()
  assert.equal(s.tier, 'green', '单点中证据不打扰')
  f.recordTurn({ user: '再试 src/gone.ts', assistant: '再读一次', toolDigest: [{ name: 'Read', path: 'src/gone.ts', isError: true, errorText: 'ENOENT' }] })
  s = f.snapshot()
  assert.equal(s.tier, 'amber')
  assert.equal(s.trigger, null, 'amber 不弹窗')
})

test('去抖：同 id 不叠加分数；markResolved 后回绿', () => {
  const f = createFidelity({ getAnchorSource: () => ({}) })
  const d = { name: 'Read', path: 'src/x.ts', isError: true, errorText: 'ENOENT' }
  f.recordTurn({ user: 'a', assistant: 'a', toolDigest: [d], forceStrong: true })
  const s1 = f.snapshot()
  f.recordTurn({ user: 'a', assistant: 'a', toolDigest: [d], forceStrong: true })
  const s2 = f.snapshot()
  assert.equal(s2.score, s1.score, '同 id 重复不刷分')
  assert.equal(f.markResolved(s2.issues.map(i => i.id)), s2.issues.length)
  assert.equal(f.snapshot().tier, 'green', 'resolved 后立即回绿')
})

test('半衰期：老证据随轮龄衰减，够老即自动回绿', () => {
  const f = createFidelity({ getAnchorSource: () => ({}) })
  f.recordTurn({ user: 'u', assistant: 'a', toolDigest: [{ name: 'Read', path: 'src/y.ts', isError: true, errorText: 'ENOENT' }], forceStrong: true })
  assert.equal(f.snapshot().tier, 'red')
  for (let i = 0; i < 20; i++) f.recordTurn({ user: 'u', assistant: 'a', toolDigest: [] })
  assert.equal(f.snapshot().tier, 'green', '窗口外的老证据不再计分')
})

test('观察期：markResolved 后 3 轮内不弹（除非新 id 强证据）', () => {
  const f = createFidelity({ getAnchorSource: () => ({}) })
  f.recordTurn({ user: 'u', assistant: 'a', toolDigest: [{ name: 'Read', path: 'src/z.ts', isError: true, errorText: 'ENOENT' }], forceStrong: true })
  const ids = f.snapshot().issues.map(i => i.id)
  f.markResolved(ids)
  f.recordTurn({ user: 'u', assistant: 'a', toolDigest: [{ name: 'Read', path: 'src/z.ts', isError: true, errorText: 'ENOENT' }], forceStrong: true })
  assert.equal(f.snapshot().trigger, null, '观察期内同源不再弹')
})

test('buildAnchorText：含任务/缺失实体/约束，且 ≤ 4KB', () => {
  const t = buildAnchorText({
    task: '实现删除交互', memoryText: '## 文件变更\n- src/a.tsx',
    missing: ['src/a.ts'], constraints: ['必须二次确认'],
  })
  assert.match(t, /实现删除交互/)
  assert.match(t, /src\/a\.ts/)
  assert.match(t, /必须二次确认/)
  assert.ok(Buffer.byteLength(t, 'utf-8') <= 4096)
})
```

Run: `node --test kernel-tests/fidelity.test.mjs`
Expected: FAIL（模块不存在 / 导出缺失）。

- [ ] **Step 2: 实现 `kernel/fidelity.mjs`**

要求（按此顺序写，便于逐步转绿）：

1. 文件头注释写明：设计依据 spec 路径、被测量定义、**强证据直通 + 中证据累积**的原则、全程静默降级纪律。
2. `fidelityConfigFromEnv(env)`：逐项读 §8 参数表的 env（`PONOS_FIDELITY*`），非法值回落默认；`PONOS_FIDELITY=0` 由调用方（health）判定关闭，此处只出配置。
3. 抽取器（全部纯函数、无副作用、对超长文本截断到 `maxText`）：
   - `extractEntities`：五类——①路径/文件名（`/(?:[A-Za-z]:)?[\\/][^\s"'`]+/` 与 `\S+\.(md|ts|tsx|js|mjs|py|json|yml|yaml|xlsx|docx|pdf)`）；②数字类（版本号 `\d+(?:\.\d+)+`、百分数、`阈值/上限/下限/行号/金额/日期` 邻近数字）；③约束句（含 `必须|不得|只能|默认|上限|禁止|仅` 的句子取其关键实体）；④反引号标识符；⑤全大写常量/模型名（`[A-Z][A-Z0-9_-]{3,}`、`[a-z][\w.-]*-\w+` 形如 `deepseek-v4-flash`）。归一化后去重，`max` 截断。
   - `normalizeEntity`：trim、全角转半角、去 markdown 装饰（`` ` ``/`**`）、路径分隔符统一为 `/`、小写化（**但保留数字与大小写形式的可读别名**：归一化只用于比对，展示用原形——实现上用 `{ raw, key }` 分离，导出面统一返回 `key`，展示取 `raw` 由 `detail` 携带）。
   - `missingEntities`：`key` 集覆盖判定（summary 归一化后做子串包含）；`ratio = missing.length / total`；`total < minEntities` 时 `ratio` 仍算但调用方跳过判定。
   - `extractFacts`：抽 `(key, value)` 对——模板：`配置项/参数 + 取值`、`模型 + 名称`、`路径 + 属性`、`数字 + 量纲 + 名词`、`版本号`；返回 `sentence`（用于演进语判定）。
   - `detectContradictions`：同 key 不同 value；**排除显式演进**（`EVOLVE_MARKERS = /改为|更新为|已修正|已改|换成|弃用|调整为|修订为/`，命中则前后 1 句内不计）。
   - `extractConstraints`：约束句原文（去重、每条 ≤120 字、最多 12 条）。
   - `detectUserCorrection`：句式表 `[/我(?:前面|之前|刚才)?说过/, /不是这样/, /我明明/, /又(?:错|来)了/, /\bagain\b/, /\bno,? i said\b/i, /我说的是/]`。
   - `detectRequirementChange`：`[/先放一放/, /改做|改成|换个任务|换一个/, /需求变更/, /重新开始做/]`。
   - `taskCoverage`：`anchorEntities` 在 `texts` 连接串中的命中比例。
   - `buildAnchorText`：固定 5 段（原始任务 / 此前摘要遗漏的关键事实 / 任务清单·文件变更·最近决策 / 硬约束 / 行为指令），逐段按 `maxBytes` 截断（**先截尾段**，保证头部任务陈述与指令必然保留）。
4. `createFidelity()`：
   - 内部状态：`turn`（自增）、`issues: Map<id, {…, resolved?: true, hits}>`、`factsByTurn: []`、`anchor`（`{ entities, task }`，首条真实 user 来自 `recordTurn` 的首个非空 `user`；`detectRequirementChange` 命中则**重设锚点并清空 goal 轴证据**）、`observeUntilTurn`。
   - `recordTurn`：a) 首次调用记录锚点；b) 用户纠错 + 纠错实体命中"已压缩"区间（由 `recordCompactionAudit` 记下的 `compressedTurnCeiling`）→ S1 强证据；c) `toolDigest` 的 `isError` + `path` 与近 6 轮 assistant 文本引用相同路径 → 陈旧引用（第 1 次 medium，第 2 次不同轮升级 strong/S3）；d) `extractFacts` 入环 → `detectContradictions` → medium 1 点/对，≥2 对计 2 点；e) `taskCoverage` 连续 `goalWindow` 轮低于 `goalCoverageMin` → medium 2 点（连续计数内部维护，恢复即清零）；f) 同 id 只刷新 `at`/`hits`，不刷分。
   - `recordCompactionAudit`：`ratio ≥ summaryMissingStrong` → S2 strong；`[summaryMissingMedium, summaryMissingStrong)` → 2 点 medium；`llm.rewritten.length` → 2 点 medium；`llm.missing` 与确定性缺失差集 → 1 点 medium；同时记录 `compressedTurnCeiling = turn`（供 S1 使用）与该次审计的 `missing` 供锚点。
   - `snapshot()`：窗口内（`turn - windowTurns`）证据按 `strength==='strong'?1:0.6`、`0.85^age` 加权聚合为 0–100；`axes` 三轴各自单独算；`tier`：有 strong 或 `score ≥ red` → `red`；`score ≥ amber` 或有 ≥2 点中证据 → `amber`；否则 `green`。`trigger` = red 时取"最强证据 id"（strong 优先、其次分高者）；`observeUntilTurn` 存在且 `turn ≤ observeUntilTurn` 时**抑制 trigger 但保留 tier**（tier 用于角标，trigger 用于弹窗）；`anchorAvailable` = red；`anchorText` = `buildAnchorText(...)`（仅 red 时计算）。
   - `markResolved(ids)`：标 `resolved`（退出计分）、设 `observeUntilTurn = turn + observeTurns`、返回命中数。
   - `evidenceLog()`：`{ active, resolved }`（供前端"已修复的旧问题"区）。
   - 全部方法 try/catch 静默返回空（`snapshot()` 异常时返回 green 中性对象）。
5. `FidelityIssue` 字段严格按 spec §2（`id/axis/kind/strength/turn/evidence/detail/at`）；`id` 稳定可复现（如 `c:stale:src/gone.ts`、`m:summary:src/a.ts`、`g:coverage`、`c:contradiction:<normalize(key)>`、`u:correction:<normalize(entity)>`）。

- [ ] **Step 3: 转绿并加固**

Run: `node --test kernel-tests/fidelity.test.mjs`
Expected: PASS（全绿）。

补 3 条边界用例（必须）：
- `PONOS_FIDELITY=0` 时 `snapshot()` 恒 green（由 health 层判定，此处断言 `fidelityConfigFromEnv({PONOS_FIDELITY:'0'}).enabled === false`）；
- `recordTurn` 传入超长文本（> `maxText`）不抛且耗时 < 200ms；
- 任一输入为 `undefined`/`null` 时不抛（静默返回 `[]`）。

- [ ] **Step 4: 提交**

```bash
cd /c/Users/T203-15/yfworking && git add kernel/fidelity.mjs kernel-tests/fidelity.test.mjs && git commit -m "feat(kernel): 上下文失真检测纯函数与聚合器（无接线）"
```

---

### Task 2: health 装配失真档位并随事件下发

**Files:**
- Modify: `kernel/health.mjs`（`createHealth` :63 起；`snapshot()` :86；`emitIfChanged()` :125）
- Modify: `kernel/cli.mjs`（`createHealth` :293）
- Test: `kernel-tests/health-distortion.test.mjs`（新建）

**Interfaces:**
- Consumes: `createFidelity` / `fidelityConfigFromEnv`（Task 1）
- Produces:
  - `createHealth({ wire, model, contextWindow, env, getAnchorSource })`（新可选参 `getAnchorSource`）
  - 新增方法 `recordTurnContent({ user, assistant, toolDigest })`、`recordCompactionAudit(audit)`、`markFidelityResolved(ids)`、`fidelityEvidence()`
  - `ponos_health` 事件新增 `distortion` 字段（spec §6.1）

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/health-distortion.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHealth, computeHealthScore } from '../kernel/health.mjs'

const mk = () => { const ev = []; return { ev, wire: { health: (d) => ev.push(d) } } }

test('压力档语义不变：tier 仍由 computeHealthScore 决定', () => {
  const r = computeHealthScore({ compactCount: 1, remainingPct: 9, remainingTurns: 158, model: 'Qwen3.8-27B' })
  assert.equal(r.tier, 'red')
  assert.match(r.reason, /水位仅剩/)          // 既有文案回归
})

test('缺 distortion 时不抛；无失真信号时 distortion 恒 green', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  assert.equal(typeof h.recordTurnContent, 'function')
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordTurnContent({ user: '实现 A', assistant: '开始', toolDigest: [] })
  const last = ev[ev.length - 1]
  assert.equal(last.distortion.tier, 'green')
  assert.equal(last.tier, 'green', '压力档不受失真影响')
})

test('失真档变化也触发事件（压力档不变时）', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  const n0 = ev.length
  h.recordCompactionAudit({ entities: ['src/a.ts', 'src/b.ts', 'src/c.ts', '阈值 120'], missing: ['src/a.ts', 'src/b.ts'], ratio: 0.5 })
  assert.ok(ev.length > n0, '失真转红必须发事件')
  const last = ev[ev.length - 1]
  assert.equal(last.distortion.tier, 'red')
  assert.equal(last.tier, 'green', '两个 tier 互不干扰')
  assert.equal(typeof last.distortion.anchorText, 'string', 'red 时下发锚点文本')
})

test('non-red 不下发 anchorText（省流量）', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.recordTurnContent({ user: 'a', assistant: 'a', toolDigest: [] })
  const last = ev[ev.length - 1] ?? { distortion: { tier: 'green', anchorText: undefined } }
  assert.equal(last.distortion.anchorText, undefined)
})

test('markFidelityResolved 后回绿并发事件', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.recordCompactionAudit({ entities: ['a.md','b.md','c.md','d.md'], missing: ['a.md','b.md'], ratio: 0.5 })
  const ids = h.fidelityEvidence().active.map((i) => i.id)
  h.markFidelityResolved(ids)
  const last = ev[ev.length - 1]
  assert.equal(last.distortion.tier, 'green')
})

test('PONOS_FIDELITY=0 时 distortion 仍存在但恒 green', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: { PONOS_FIDELITY: '0' } })
  h.recordCompactionAudit({ entities: ['a.md','b.md','c.md','d.md'], missing: ['a.md','b.md'], ratio: 0.5 })
  const last = ev[ev.length - 1]
  assert.equal(last.distortion.tier, 'green')
})
```

Run: `node --test kernel-tests/health-distortion.test.mjs` → FAIL。

- [ ] **Step 2: 实现**

1. `import { createFidelity, fidelityConfigFromEnv } from './fidelity.mjs'`。
2. `createHealth` 内（`win`/`compactCount` 附近）建 fidelity 实例：
   ```js
   const fidCfg = fidelityConfigFromEnv(env)
   const fidEnabled = fidCfg.enabled !== false
   const fid = createFidelity({ config: fidCfg, getAnchorSource })
   let lastDistortionTier = 'green'
   ```
3. `snapshot()` 末尾：`const distortion = fidEnabled ? fid.snapshot() : GREEN_DISTORTION`，返回 `{ ...h, growthPerTurn, predictedTurns, distortion }`。
   - `GREEN_DISTORTION = { score: 0, tier: 'green', axes: { memory: 0, coherence: 0, goal: 0 }, issues: [], trigger: null, observeUntilTurn: null, anchorAvailable: false }`（**不含 anchorText**）。
4. `emitIfChanged(force)`：`changed = force || h.tier !== lastTier || h.distortion.tier !== lastDistortionTier`；发事件时把 `distortion` 附上，且**仅当 `distortion.tier === 'red'` 才附 `anchorText`**（否则显式 `delete`/不赋值）；发完更新 `lastDistortionTier`。
5. 新方法（全部 try/catch 静默）：
   ```js
   recordTurnContent(d) { fid.recordTurn(d); emitIfChanged() },
   recordCompactionAudit(a) { fid.recordCompactionAudit(a); emitIfChanged() },
   markFidelityResolved(ids) { const n = fid.markResolved(ids); emitIfChanged(); return n },
   fidelityEvidence() { return fid.evidenceLog() },
   ```
6. `getState()` 增 `distortionTier: lastDistortionTier`（供诊断/测试）。

- [ ] **Step 3: 转绿 + 压力回归**

Run:
```bash
node --test kernel-tests/health-distortion.test.mjs && node --test kernel-tests/health-waterlevel.test.mjs && node --test kernel-tests/health-judge.test.mjs
```
Expected: 三份全绿（压力水位与 Judge 行为零回归）。

- [ ] **Step 4: 提交**

```bash
git add kernel/health.mjs kernel-tests/health-distortion.test.mjs && git commit -m "feat(kernel): health 装配失真档位并随 ponos_health 下发（压力语义不变）"
```

---

### Task 3: 引擎喂内容侧观测 + cli 装配锚点源

**Files:**
- Modify: `kernel/engine.mjs`（`runTurnInternal` :718 起；工具结果处 :1344-1370；`return` :1438；`runTurn` :2443-2500 的 `health.record` :2490）
- Modify: `kernel/cli.mjs`（`createHealth` :287）
- Modify: `kernel/api.mjs`（mock 分支区，紧随 `[mock:tool-safe]` :406-412 之后加一个 marker，供本任务测试用）
- Test: `kernel-tests/engine-fidelity.test.mjs`（新建）

**Interfaces:**
- Consumes: `health.recordTurnContent`（Task 2）、`createEngine({ opts, wire, session, compactor, health })`（engine.mjs:596 已接受 `health`）
- Produces: 引擎每轮把 `{ user, assistant, toolDigest }` 交给 health；`toolDigest` 元素形状 `{ name, path, isError, errorText }`（`errorText ≤ 200` 字）

- [ ] **Step 1: 写失败测试**

先在 `kernel/api.mjs` 的 mock 分支区（紧随 `[mock:tool-safe]` 块，:406-412 之后）加：

```js
  // 上下文失真观测测试用（2026-09-12）：产出一次必然失败的 Read（相对路径不存在）
  // → 引擎轮尾工具摘要应收录 { name:'Read', isError:true }，供 fidelity 陈旧引用检测。
  if (lastText.includes('[mock:fidelity-read-fail]')) {
    if (signal?.aborted) throw abortError()
    await sleep(MOCK_SLEEP_MS)
    yield { type: 'tool_use', id: 'tool_use_mock_fid_read', name: 'Read', input: { file_path: '__yfw_fidelity_missing__.md' } }
    yield { type: 'usage', usage: MOCK_USAGE }
    return
  }
```

创建 `kernel-tests/engine-fidelity.test.mjs`（**注意：`PONOS_*` 阈值在 engine 模块求值期冻结，env 必须在 `await import` 之前设定**——照 `kernel-tests/engine-tool-result.test.mjs:8-13` 的写法）：

```js
// 引擎内容侧观测（上下文失真，2026-09-12）：轮尾须把 user/assistant/toolDigest 交给 health
process.env.PONOS_MOCK_API = '1'
process.env.PONOS_STREAM_IDLE_MS = '5000'
const { createEngine } = await import('../kernel/engine.mjs')
const { createSessionStore } = await import('../kernel/session.mjs')
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function mkWire() {
  return { assistant: () => {}, result: () => {}, controlRequest: () => {}, system: () => {},
    summary: () => {}, health: () => {}, warning: () => {}, toolResult: () => {} }
}

test('引擎轮尾把 user/assistant/toolDigest 交给 health（含失败 Read）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-fidelity-'))
  const calls = []
  const health = { record: () => {}, recordTurnContent: (d) => calls.push(d), recordFailure: () => {} }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-0000000000f1' })
  try {
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire: mkWire(), session, health })
    await engine.runTurn({ content: '[mock:fidelity-read-fail] 读取一下那个文件' })
    assert.equal(calls.length, 1, '每轮恰好上报一次')
    const d = calls[0]
    assert.ok(d.user.includes('fidelity-read-fail'), 'user 文本原样带上')
    assert.ok(Array.isArray(d.toolDigest) && d.toolDigest.length >= 1, '工具摘要非空')
    const t = d.toolDigest.find((x) => x.name === 'Read')
    assert.ok(t, '应收录 Read 调用')
    assert.equal(t.isError, true, '不存在的文件必须记为失败')
    assert.ok(String(t.path).includes('__yfw_fidelity_missing__.md'))
    assert.ok(String(t.errorText).length > 0 && String(t.errorText).length <= 200)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('health.recordTurnContent 抛异常不影响轮次结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-fidelity-bo-'))
  const health = { record: () => {}, recordTurnContent: () => { throw new Error('boom') }, recordFailure: () => {} }
  const session = createSessionStore({ configDir: dir, cwd: 'proj', sessionId: '00000000-0000-0000-0000-0000000000f2' })
  try {
    const engine = createEngine({ opts: { model: 'm', addDirs: [dir], skipPermissions: true, systemPrompt: '' }, wire: mkWire(), session, health })
    const r = await engine.runTurn({ content: '[mock:fidelity-read-fail] 再来一次' })
    assert.ok(r && typeof r.text === 'string' && r.text.length > 0, '轮次结果仍正常返回')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

Run: `node --test kernel-tests/engine-fidelity.test.mjs` → FAIL（`recordTurnContent` 未被调用 → `calls.length === 0`）。

- [ ] **Step 2: 实现**

1. `runTurnInternal`：在 `let textBuf = ''`（:727）后加
   `const turnToolDigest = []`、`const turnTexts = []`。
2. 每轮迭代 textBuf 被消费处（:1031 与 :1334 两处 `assistantBlocks` 附近）把 `textBuf` 快照 push 进 `turnTexts`（截断单条 ≤ 4KB、总计 ≤ 16 条）。
3. 工具执行处（`const toolResults = blocks.map(...)` :1344 之后）补：
   ```js
   for (let i = 0; i < toolResults.length; i++) {
     turnToolDigest.push({
       name: String(blocks[i]?.name || ''),
       path: String(blocks[i]?.input?.file_path ?? blocks[i]?.input?.path ?? blocks[i]?.input?.pattern ?? '').slice(0, 300),
       isError: !!toolResults[i].is_error,
       errorText: String(typeof toolResults[i].content === 'string' ? toolResults[i].content : '').slice(0, 200),
     })
   }
   ```
4. `return { usage, model, text: textBuf, lastUsage: callUsage }`（:1438）→ 增 `toolDigest: turnToolDigest, assistantTexts: turnTexts`。（若存在第二条 return 路径，同样带上；用 `git grep -n "return { usage" kernel/engine.mjs` 核对。）
5. `runTurn`（:2452 解构处）增取 `toolDigest, assistantTexts`；在 `health?.record(...)`（:2490）**之后**加：
   ```js
   try { health?.recordTurnContent?.({ user: String(content ?? ''), assistant: String(text ?? '') + (assistantTexts?.length ? '\n' + assistantTexts.join('\n') : ''), toolDigest: toolDigest || [] }) } catch { /* 失真观测失败不得影响轮次 */ }
   ```
6. `cli.mjs`：`createHealth({ wire, model, contextWindow, env: process.env, getAnchorSource })`（:293；**注意 `sessionMemoryPath` 在 :296 才声明**，故闭包内就地按同式 `join(configDir, 'memory', 'session', sessionId + '.md')` 计算路径，不依赖声明顺序）：
   ```js
   const memoryFile = join(configDir, 'memory', 'session', sessionId + '.md')
   const getAnchorSource = () => {
     let task = ''
     try {
       const msgs = store.deriveMessages()
       const first = msgs.find((m) => m?.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')))
       task = typeof first?.content === 'string' ? first.content.slice(0, 1000) : ''
     } catch { /* 静默 */ }
     let memoryText = ''
     try { memoryText = readFileSync(memoryFile, 'utf-8').slice(0, 4000) } catch { /* 无记忆文件时为空 */ }
     return { task, memoryText, constraints: [] }
   }
   ```
   （`readFileSync` 已在 cli.mjs:19 导入；`join`/`extractKeyInfo`/`buildSessionMemoryText` 均在既有导入链上，无需新增依赖。）

- [ ] **Step 3: 转绿 + 引擎回归**

Run:
```bash
node --test kernel-tests/engine-fidelity.test.mjs && node --test kernel-tests/engine-guard-idle.test.mjs kernel-tests/engine-guard-stall.test.mjs kernel-tests/engine-tool-result.test.mjs
```
Expected: 全绿（turnStats 形状只增字段，既有消费者不受影响）。

- [ ] **Step 4: 提交**

```bash
git add kernel/engine.mjs kernel/cli.mjs kernel/api.mjs kernel-tests/engine-fidelity.test.mjs && git commit -m "feat(kernel): 引擎轮尾上报内容侧观测，cli 注入锚点源"
```

---

### Task 4: 压缩点保真审计（确定性 + LLM）

**Files:**
- Modify: `kernel/compact.mjs`（`createCompactor` :379；内部 `callSummaryBody` :470、`runSummarizer` :494、`landSummary` :519、`summarize` :508 的两个落地调用点）
- Modify: `kernel/cli.mjs`（compactor 装配处 :297 传 `onCompactionAudit`）
- Test: `kernel-tests/compact-fidelity.test.mjs`（新建）

**Interfaces:**
- Consumes: `extractEntities` / `missingEntities`（Task 1）、`health.recordCompactionAudit`（Task 2）、`createCompactor` 既有内部 `callSummaryBody({ body, maxOut })`（:470，`body` 即 messages 数组）与 `keyInfoBlock(extractKeyInfo(messages))`（:495）
- Produces:
  - `createCompactor({ …, onCompactionAudit })`（新可选回调，签名 `(audit) => void`）
  - `export function auditSummaryFidelity({ covered, summary, minEntities }) → { entities, missing, ratio, total, skipped? }`（纯函数）
  - `export function buildFidelityAuditRequest({ excerpt, summary }) → messages`（纯函数，**返回 messages 数组**，可直接交给 `callSummaryBody`）
  - `export function parseFidelityAudit(text) → { ok, missing, rewritten }`（容错解析，非法 JSON 返回 `{ok:false,missing:[],rewritten:[]}`）

- [ ] **Step 1: 写失败测试**

创建 `kernel-tests/compact-fidelity.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditSummaryFidelity, buildFidelityAuditRequest, parseFidelityAudit } from '../kernel/compact.mjs'

test('auditSummaryFidelity：保留实体 → ratio 0', () => {
  const covered = [{ role: 'user', content: '必须保留 src/a.ts 与阈值 120' }]
  const r = auditSummaryFidelity({ covered, summary: '保留 src/a.ts，阈值 120 不变' })
  assert.equal(r.ratio, 0)
})

test('auditSummaryFidelity：丢关键实体 → ratio 命中且 missing 命名具体', () => {
  const covered = [{ role: 'user', content: '必须保留 src/a.ts、src/b.ts 与阈值 120' }]
  const r = auditSummaryFidelity({ covered, summary: '继续之前的开发' })
  assert.ok(r.ratio >= 0.5)
  assert.ok(r.missing.some((m) => m.includes('src/a.ts')))
})

test('buildFidelityAuditRequest 要求严格 JSON；parseFidelityAudit 容错', () => {
  const msgs = buildFidelityAuditRequest({ excerpt: 'x', summary: 'y' })
  assert.ok(JSON.stringify(msgs).includes('JSON'))
  assert.deepEqual(parseFidelityAudit('垃圾输出'), { ok: false, missing: [], rewritten: [] })
  assert.deepEqual(parseFidelityAudit('{"ok":true,"missing":["a"],"rewritten":[]}').missing, ['a'])
  assert.deepEqual(parseFidelityAudit('前缀 ```json\n{"ok":true,"missing":[],"rewritten":["MySQL→PostgreSQL"]}\n```').rewritten.length, 1)
})
```

Run: `node --test kernel-tests/compact-fidelity.test.mjs` → FAIL。

- [ ] **Step 2: 实现确定性部分**

1. 在 `compact.mjs` 顶部 import fidelity 纯函数（`import { extractEntities, missingEntities } from './fidelity.mjs'`）。
2. 新增 `auditSummaryFidelity({ covered, summary, minEntities = 3 })`：`covered` 中取 `role==='user'` 文本（含 tool_result 块的 `content` 也抽取，路径常在这里）+ assistant 文本，合计截断 20 万字符 → `extractEntities` → `missingEntities(entities, summary)`；`total < minEntities` 时返回 `ratio: 0, skipped: true`（**不判定**）。
3. `landSummary(summary, c, coveredTk)`（:519，`summarize` 内部函数）内、`health.recordCompaction`（:533 附近）**之后**加确定性审计：
   ```js
   try {
     const audit = auditSummaryFidelity({ covered: c.covered, summary })
     if (!audit.skipped) onCompactionAudit?.({ ...audit })
   } catch { /* 审计失败不影响压缩落地 */ }
   void auditFidelityAsync(summary, c.covered)   // Step 3 的 LLM 审计：fire-and-forget，不阻塞
   ```
   **位置纪律**：必须在 `compactOk = true` 与 `health.recordCompaction` 之后（压缩落地是第一优先级，审计是附产物；`landSummary` 的 seq 反查校验 :521 绝不能因审计被绕过）。

- [ ] **Step 3: 实现 LLM 审计（默认开，可关，不阻塞轮次）**

1. `buildFidelityAuditRequest({ excerpt, summary })`：返回 **messages 数组**（`[{ role: 'user', content: '<指令>\n\n【原文摘录】\n' + excerpt + '\n\n【摘要】\n' + summary }]`，指令为"你是事实保真审计器……只输出 JSON：{\"missing\":[],\"rewritten\":[\"原值→新值\"]}"），可直接交给 `callSummaryBody({ body, maxOut })`（:470）。
2. 在 `createCompactor` 内新增 `auditFidelityAsync(summary, covered)`（**fire-and-forget，不 await、绝不影响轮次时延**）：
   ```js
   let auditInFlight = false
   async function auditFidelityAsync(summary, covered) {
     if (auditInFlight) return                      // 最多 1 个在飞，防并发堆积
     if (env.PONOS_FIDELITY_LLM_AUDIT === '0') return
     auditInFlight = true
     try {
       const keyInfo = keyInfoBlock(extractKeyInfo(covered))                       // 复用 :495 的既有抽取
       const excerpt = (keyInfo + '\n' + headTailText(covered, 6, 4)).slice(0, 8000) // 头 6 条 + key-info + 尾 4 条
       const { text } = await callSummaryBody({ body: buildFidelityAuditRequest({ excerpt, summary }), maxOut: 512 })
       const parsed = parseFidelityAudit(text)
       if (parsed.missing.length || parsed.rewritten.length) onCompactionAudit?.({ entities: [], missing: parsed.missing, ratio: 0, llm: parsed })
     } catch { /* 审计失败静默：不计熔断、不影响落地 */ } finally { auditInFlight = false }
   }
   ```
3. 触发点：在 `landSummary` 末尾（Step 2 已加）调用 `void auditFidelityAsync(summary, c.covered)` —— 此时 `summary`/`c` 均在作用域内、seq 反查校验已通过，**且两个落地分支（:593 分块 / :641 单发）都经过它，无需重复接线**。`onCompactionAudit` 收到的两种形态：①确定性 `{ entities, missing, ratio, total }`；②LLM `{ entities: [], missing, ratio: 0, llm: { ok, missing, rewritten } }`——由 health 侧统一转成 `FidelityIssue`。
   **三条硬约束**：①每次压缩最多 1 次调用（`auditInFlight` 门）；②`maxOut = 512`；③**失败绝不触碰 `consecutiveFailures`/熔断计数**（不得让审计拖垮压缩熔断）。
4. `cli.mjs` compactor 装配（:297 `createCompactor({ ... })`）传 `onCompactionAudit: (a) => { try { health.recordCompactionAudit?.(a) } catch {} }`。

- [ ] **Step 4: 转绿 + 压缩回归**

Run:
```bash
node --test kernel-tests/compact-fidelity.test.mjs && node --test kernel-tests/compact-safety.test.mjs kernel-tests/compact-chunked.test.mjs kernel-tests/compact-memory.test.mjs
```
Expected: 全绿（压缩落地与熔断行为零回归）。

- [ ] **Step 5: 提交**

```bash
git add kernel/compact.mjs kernel/cli.mjs kernel-tests/compact-fidelity.test.mjs && git commit -m "feat(kernel): 压缩点保真审计（确定性实体覆盖 + LLM 改写检测）"
```

---

### Task 5: 前端纯函数与 store

**Files:**
- Modify: `src/lib/healthUi.ts`、`src/stores/healthStore.ts`
- Test: `src/lib/healthUi.test.ts`（扩展）

**Interfaces:**
- Consumes: 事件里的 `distortion` 字段（Task 2）
- Produces:
  ```ts
  export interface DistortionIssue { id: string; axis: 'memory'|'coherence'|'goal'; kind: string; strength: 'strong'|'medium'; turn: number; evidence: string; at: string }
  export interface DistortionInfo { score: number; tier: MeterColor; axes: Record<'memory'|'coherence'|'goal', number>; issues: DistortionIssue[]; trigger: string | null; observeUntilTurn: number | null; anchorAvailable: boolean; anchorText?: string }
  export function distortionOf(health: HealthInfo | null): DistortionInfo   // 缺字段 → green 中性对象
  export function distortionBadge(health): { show: boolean; count: number; tier: MeterColor }
  export function shouldShowDistortionAlert(health, dismissedUntil, shownIds: string[]): boolean
  export function anchorTextFrom(health): string
  export function mergeIssues(prev: DistortionIssue[], next: DistortionIssue[]): DistortionIssue[]
  ```
- store 新增：`distortionShownIdsBySession`、`dismissedDistortionUntilBySession`（persist），`markDistortionShown(sessionId, id)`、`dismissDistortion(sessionId)`；`reset()` 一并清；`partialize` 带上新键（`name` 仍为 `yfworking-health`，`version` 升 `2` 并给 `migrate` 兜底旧快照）。

- [ ] **Step 1: 写失败测试**（`src/lib/healthUi.test.ts` 追加）

```ts
test('缺 distortion 字段时按 green（老内核兼容）', () => {
  assert.equal(distortionOf(h({})).tier, 'green')
  assert.equal(distortionOf(null).tier, 'green')
})
test('失真档与压力档互不干扰', () => {
  const x = h({ tier: 'green', distortion: d({ tier: 'red', trigger: 'm:summary:src/a.ts' }) })
  assert.equal(meterState(x).color, 'green', '血条仍读压力档')
  assert.equal(distortionOf(x).tier, 'red')
})
test('shouldShowDistortionAlert：仅 red + 未在冷却 + 证据 id 未展示过', () => {
  const x = h({ distortion: d({ tier: 'red', trigger: 'm:1' }) })
  assert.equal(shouldShowDistortionAlert(x, 0, []), true)
  assert.equal(shouldShowDistortionAlert(x, 0, ['m:1']), false, '同 id 不重复弹')
  assert.equal(shouldShowDistortionAlert(x, Date.now() + 1000, []), false, '冷却期内不弹')
  assert.equal(shouldShowDistortionAlert(h({ distortion: d({ tier: 'amber' }) }), 0, []), false, 'amber 不弹')
})
test('amber 显示角标、green 不显示', () => {
  assert.equal(distortionBadge(h({ distortion: d({ tier: 'amber', issues: [i('c:1'), i('c:2')] }) })).show, true)
  assert.equal(distortionBadge(h({ distortion: d({ tier: 'green' }) })).show, false)
})
test('anchorTextFrom 透传且缺省为空串', () => {
  assert.equal(anchorTextFrom(h({ distortion: d({ tier: 'red', anchorText: 'X' }) })), 'X')
  assert.equal(anchorTextFrom(h({})), '')
})
```

Run: `node --test src/lib/healthUi.test.ts` → FAIL。

- [ ] **Step 2: 实现**

`healthUi.ts`：按上面签名实现；`distortionOf` 对缺失字段返回常量 `GREEN_DISTORTION`（**不含 anchorText**）；`shouldShowDistortionAlert` 复用现有 `shouldShowRedAlert` 的冷却语义但改为读 `distortion.tier`，并要求 `trigger` 非空（trigger 是去抖键；观察期由内核用 `trigger=null` 表达）。
`healthStore.ts`：`HealthInfo` 增 `distortion?: DistortionInfo`；新增状态与方法；`persist` version→2 + `migrate`（旧快照缺新键时补空对象）。

- [ ] **Step 3: 转绿 + 类型检查**

```bash
node --test src/lib/healthUi.test.ts && npx tsc --noEmit
```
Expected: 全绿 + 零类型错误。

- [ ] **Step 4: 提交**

```bash
git add src/lib/healthUi.ts src/lib/healthUi.test.ts src/stores/healthStore.ts && git commit -m "feat(gui): 失真档纯函数与 store 状态（含去抖/冷却/观察期）"
```

---

### Task 6: GUI 组件（角标 / 失真卡两级动作 / 泛光换轴 / i18n）

**Files:**
- Modify: `src/components/chat/HealthMeter.tsx`、`src/components/chat/HealthSuggestCard.tsx`、`src/components/chat/HealthGlow.tsx`、`src/i18n/translations/zh-CN.ts`、`src/i18n/translations/en-US.ts`

**Interfaces:**
- Consumes: Task 5 的纯函数与 store
- Produces: 失真红时弹"证据清单 + 两级动作"卡片；amber 显示角标；泛光只在失真红

- [ ] **Step 1: HealthMeter 加失真角标（不改血条语义）**

- `remainingPct`/`tier` 用法**一行都不改**；
- 血条右端追加角标：`distortionBadge(health).show` 时渲染一个 `w-1.5 h-1.5` 圆点 + `×N` 计数（色用 `var(--health-tier-amber|red)`），`title` 为前 3 条 issue 的 `evidence` 拼接；
- 既有压缩脉冲逻辑（`flash`）保持。

- [ ] **Step 2: HealthSuggestCard 改为失真卡（证据清单 + 两级动作）**

- 触发：`shouldShowDistortionAlert(health, dismissedUntil, shownIds)`（**替换** 现有 `shouldShowRedAlert`（healthUi.ts:19，签名仅 `(health, dismissedUntil)`））；沿用最小化 / dismiss / 冷却（`healthStore.ts:35` `RED_DISMISS_MS`）结构，`detail` 改为 `t('health.distortion.evidenceCount', { n: issues.length })`；
- 标题：`t('health.distortion.redTitle')`，并按主证据 axis 分支（`axis.memory` / `axis.coherence` / `axis.goal`）；
- **证据清单**（必须逐条展示，这是本卡片的核心价值）：最多 5 条，每行 `第 {turn} 轮 · {axisLabel} · {evidence}`；超出折叠为"N 条更早证据"；
- **主按钮「重新锚定」**：点击展开预览区（`textarea`，初值 `anchorTextFrom(health)`，可编辑），确认后 `useUIStore.getState().setPendingInput(text, true)` + `onStopSource?.()` 不动（重锚不停止会话）+ `markDistortionShown(sessionId, trigger)` + 调 `onAnchorApplied?.(issueIds)`（Task 7 注入的上行回调）+ `dismiss`（进冷却）；
- **次按钮「新建会话携带摘要」**：沿用现有 `handleNewSession()`（:30），但注入内容改为 `anchorTextFrom(health) + '\n\n' + summary`（锚点在前）；
- 观察期（`trigger === null` 但 red）时只显示角标不弹卡片——由 `shouldShowDistortionAlert` 已保证。

- [ ] **Step 3: HealthGlow 换轴**

`shouldShowRedAlert(health, dismissedUntil)` → 改读失真：`distortionOf(health).tier === 'red' && Date.now() >= dismissedUntil`（复用同一个 dismiss 冷却键，避免出现两套冷却）。压力红**不再泛光**。

- [ ] **Step 4: i18n**

`zh-CN.ts` 增：
```
distortion: {
  redTitle: '上下文可能已失真 {n} 处，建议先纠正再继续',
  axis: { memory: '记忆失真', coherence: '自相矛盾', goal: '目标漂移' },
  evidenceLine: '第 {turn} 轮 · {axis} · {evidence}',
  moreEvidence: '另有 {n} 条更早证据',
  evidenceCount: '{n} 条失真证据',
  reanchor: '重新锚定',
  reanchorPreview: '确认将发送给模型的锚定内容（可编辑）',
  sendAnchor: '发送锚定',
  newSessionWithSummary: '新建会话（锚点+摘要）',
  badgeTooltip: '失真 {n} 处'
}
```
`en-US.ts` 同步英文；两文件的 key 集合必须一致（既有 i18n 纪律）。

- [ ] **Step 5: 类型检查与构建**

```bash
npx tsc --noEmit && npm run build
```
Expected: 零类型错误；构建成功。

- [ ] **Step 6: 提交**

```bash
git add src/components/chat src/i18n/translations && git commit -m "feat(gui): 失真证据卡（两级动作）+ 血条角标 + 泛光换轴"
```

---

### Task 7: 锚定生效链路（bridge 路由 + 内核 stdin + 前端上行）

**Files:**
- Modify: `server/bridge.mjs`（新增路由；复用 `writeControlRequest` :810）
- Modify: `kernel/cli.mjs`（stdin 分派链 :849 后追加分支）
- Modify: `src/hooks/useYFWCLI.ts`（新增 `applyAnchor` 并传给 `HealthSuggestCard`）
- Modify: `src/components/chat/ChatInput.tsx`（把 `onAnchorApplied` 传给卡片，:605）
- Test: `server/health-anchor.test.mjs`（新建）

**Interfaces:**
- Consumes: `health.markFidelityResolved`（Task 2）、`writeControlRequest`（bridge :810）、`fidelity.markResolved`（Task 1）
- Produces: `POST /session/anchor-applied` `{ sessionId, issueIds }` → `{ ok: true, resolved: n }`

- [ ] **Step 1: 写失败测试**

创建 `server/health-anchor.test.mjs`：直接测**纯函数化的路由处理**（避免起真桥；与既有 `server/*.test.mjs` 的写法一致——若桥的路由未导出，则把"参数校验 + 构造内核消息"抽为 `server/health-anchor.mjs` 的 `buildAnchorApplied(sessionId, issueIds)` 并单测，路由只做转发）：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnchorApplied } from './health-anchor.mjs'

test('buildAnchorApplied：构造内核 stdin 消息', () => {
  assert.deepEqual(buildAnchorApplied('s1', ['a', 'b']), { sessionId: 's1', message: { type: 'anchor_applied', issueIds: ['a', 'b'] } })
})
test('issueIds 清洗：去重、限长、非法回落空数组', () => {
  assert.deepEqual(buildAnchorApplied('s1', ['a', 'a', 1, 'x'.repeat(300)]).message.issueIds, ['a'])
  assert.deepEqual(buildAnchorApplied('s1', null).message.issueIds, [])
})
test('sessionId 必填：缺失返回 null（路由回 400）', () => {
  assert.equal(buildAnchorApplied('', ['a']), null)
})
```

Run: `node --test server/health-anchor.test.mjs` → FAIL。

- [ ] **Step 2: 实现**

1. `server/health-anchor.mjs`（新建）：导出 `buildAnchorApplied`（纯函数，同上）。
2. `server/bridge.mjs`：在既有 JSON body 路由区（紧邻 `:1740` 的 `/api/profile` POST 分支）加（**响应写法照抄 :1740-1751 既有样式**）：
   ```js
   if (url.pathname === '/session/anchor-applied' && req.method === 'POST') {
     const body = await readJsonBody(req).catch(() => ({}))   // bridge.mjs:38 既有函数
     const built = buildAnchorApplied(String(body?.sessionId ?? ''), body?.issueIds)
     if (!built) return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'sessionId required' }))
     writeControlRequest(built.sessionId, built.message)      // bridge.mjs:810 既有函数
     return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
   }
   ```
3. `kernel/cli.mjs`：在 `parsed.type === 'user'`（:849）分派链中追加
   ```js
   } else if (parsed.type === 'anchor_applied') {
     try { health.markFidelityResolved(Array.isArray(parsed.issueIds) ? parsed.issueIds : []) } catch { /* 静默 */ }
   }
   ```
4. `src/hooks/useYFWCLI.ts`：新增
   ```ts
   const applyAnchor = useCallback(async (sessionId: string, issueIds: string[]) => {
     try { await fetch(`http://127.0.0.1:${__BRIDGE_PORT__}/session/anchor-applied`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, issueIds }) }) } catch { /* 上报失败不影响本地回绿 */ }
   }, [])
   ```
   （`__BRIDGE_PORT__` 是既有编译期常量；`fetch` 基址写法照抄文件内既有调用。）
5. `ChatInput.tsx`：`<HealthSuggestCard conversationId={conversationId} onStopSource={...} onAnchorApplied={(ids) => applyAnchor(conversationId, ids)} />`。

- [ ] **Step 3: 转绿 + 全量回归**

```bash
node --test server/health-anchor.test.mjs && npm test
```
Expected: 新用例全绿；`npm test` 无新增失败（既有基线约 236–292 项）。

- [ ] **Step 4: 提交**

```bash
git add server/health-anchor.mjs server/bridge.mjs server/health-anchor.test.mjs kernel/cli.mjs src/hooks/useYFWCLI.ts src/components/chat/ChatInput.tsx && git commit -m "feat: 锚定生效链路（bridge 路由 + 内核 stdin + 前端上行）"
```

---

### Task 8: 收尾（假红/假绿回归、契约与手册、端到端验收）

**Files:**
- Modify: `docs/bridge-contract.md`、`docs/manual/YFWorking产品使用说明书.md`
- Test: 全量回归 + 人工端到端清单

- [ ] **Step 1: 假红/假绿回归用例补齐**

在 `kernel-tests/fidelity.test.mjs` 追加两条（必须）：
- **假红回归**（对应 2026-09-11 事故场景）：压缩刚落地（`recordCompactionAudit` 后紧跟一轮 `recordTurn`，且该轮 `toolDigest` 正常）时，`distortion.tier` 不得为 red 且 `trigger` 为 null；
- **假绿**：连续 20 轮纯问答（无工具、无压缩、无纠错）`distortion.tier` 恒 green、`issues.length === 0`。

Run: `node --test kernel-tests/fidelity.test.mjs` → PASS。

- [ ] **Step 2: 契约与手册更新**

- `docs/bridge-contract.md`：新增 `ponos_health.distortion` 字段表（`score/tier/axes/issues[]/trigger/observeUntilTurn/anchorAvailable/anchorText`），标注"可选字段、缺省即 green"、**"`tier` 为压力语义、`distortion.tier` 为失真语义，二者禁止互赋"**；新增 stdin 子命令 `anchor_applied`；顺带修正 :85 附近 `YFW_HEALTH_COMPACT_COUNT` 的记载（见 Task 8 Step 3）。
- `docs/manual/YFWorking产品使用说明书.md`：改写 3 处——`:46`（能力概述）、`:236`（血条详述）、`:655`（常见问题"血条是什么"）——口径统一为：血条=压力仪表（不再触发弹窗）；失真卡=唯一建议弹窗，动作含「重新锚定」与「新建会话（锚点+摘要）」。

- [ ] **Step 3: 修复顺带发现的既有缺陷（需用户确认后执行）**

`server/bridge.mjs:1148` 注入 `YFW_HEALTH_COMPACT_COUNT`，而 `kernel/health.mjs:74` 读 `PONOS_HEALTH_COMPACT_COUNT` —— 名称不一致使 seed 从未生效。**推荐**：内核侧双名兼容读（`env.PONOS_HEALTH_COMPACT_COUNT ?? env.YFW_HEALTH_COMPACT_COUNT`），并补一条断言两种 env 名都能 seed 的单测（放 `kernel-tests/health-distortion.test.mjs`）。比改桥更稳（同时兼容已装旧桥）。

- [ ] **Step 4: 全量回归**

```bash
npm test && node --test "kernel-tests/*.test.mjs" && node --test src/lib/healthUi.test.ts && npx tsc --noEmit && npm run build
```
Expected: 全部通过；无新增失败（记录改动前后的 pass 计数对比）。

- [ ] **Step 5: 端到端人工验收清单**

1. 起应用 → 长会话（触发一次压缩）→ 观察血条**宽度/颜色仍按压力**变化；
2. 压缩落地后无失真信号 → 卡片不出现、泛光不出现；
3. 构造失真：让会话引用一个已被删除的路径 → 连续两轮 → 血条出现 amber 角标（**不弹卡**）；
4. 打日志确认 `ponos_health.distortion.issues` 含 `c:stale:...`；
5. 构造强证据（压缩摘要丢关键路径）→ 出现失真卡：逐条证据可见、无重复弹出；
6. 点「重新锚定」→ 预览可编辑 → 发送 → 锚点作为一条 user 消息可见 → 3 轮内不再弹 → `distortion.tier` 回 green（bridge 日志可见 stdin 回执）；
7. 再构造同源失真 → 卡片重现，动作推荐「新建会话（锚点+摘要）」；
8. 重启应用 → 血条与角标从 persisted 快照恢复；老会话（无 distortion 字段）不显示角标。

- [ ] **Step 6: 提交**

```bash
git add docs && git commit -m "docs: 失真健康契约与产品手册更新 + 端到端验收记录"
```

---

## Self-Review（写完计划后自查结论）

| 检查项 | 结论 |
|---|---|
| spec 覆盖 | spec §1–§13 全部有对应任务：§1–§3→T1，§4.1→T4，§4.2–4.3→T1，§5.1→T6/T7，§5.2→T6，§6.1→T2/T5，§6.2→T4，§6.3→T7，§7→T5/T6/T7，§8→T1，§9→各任务 Step 3 与 T8，§10→任务顺序，§11/§12→Global Constraints 与 T8 |
| 命名一致 | `FidelityIssue` / `distortion` / `recordTurnContent` / `recordCompactionAudit` / `markFidelityResolved` / `shouldShowDistortionAlert` / `anchorTextFrom` 在 T1–T7 逐字一致 |
| 两 tier 风险 | T2/T5 各有"互不干扰"断言，T8 Step 2 写进契约文档 |
| 误报风险 | T1 Step 1 已含"显式演进不计矛盾"与"用户改需求=合法转向"的负例；T8 Step 1 有假红/假绿回归 |
| 成本风险 | T4 三条硬约束（1 次 / ≤512 / 不计熔断），LLM 审计失败不影响压缩落地 |
| 老版本兼容 | `distortion` 可选 + 前端缺省 green（T5 Step 1 有用例）；内核双名 env（T8 Step 3） |
| 无占位符 | 所有 Step 都给出文件、签名、命令与预期结果；无 TODO/TBD |
