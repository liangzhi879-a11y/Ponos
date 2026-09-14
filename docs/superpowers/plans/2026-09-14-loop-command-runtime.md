# /loop 指令运行时（打通 + 生产级闭环）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 GUI→内核 `/loop` 指令通道，并把 loop 补齐为生产级闭环（指令族 + 状态持久化 + 双层 done_when 验证器 + 预算/无进展硬边界）。

**Architecture:** 新增三个内核模块承担 loop 逻辑——`loop-commands.mjs`（纯解析，零依赖）、`loop-verify.mjs`（双层验证器，命令式经 Bash 工具门）、`loop.mjs`（LoopController：状态机/预算/无进展/持久化/指令族）。`cli.mjs` 由内联 `loopState` 改为委托控制器；`bridge.mjs` 在 GUI send 路径前置拦截 `/loop` 文本并转译为 `loop` 载荷（start）或 `loop_command`（指令族）——这是当前断链的打通点。GUI 侧扩展 loop 帧归约并新增状态面板。

**Tech Stack:** Node ESM（`node:test`，仓库既有 kernel 栈）；React + zustand（GUI）；NDJSON wire 协议（`kernel/protocol.mjs`）。

## Global Constraints

- 测试命令：`node --test kernel-tests/*.test.mjs`（内核测试不在 `npm test` 内）；`npm test` 覆盖 server/electron。
- mock 测试环境：`PONOS_MOCK_API=1`（`kernel/api.mjs` mock 流，免网络）；engine 直连模板见 `kernel-tests/subagent.test.mjs` 的 `makeEnv`。
- **零回归锁①**：既有 TUI 语法 `/loop 3 <prompt>` / `--until <目标>` / `--fresh` 的解析结果逐字不变。
- **零回归锁②**：非 `/loop` 开头的用户文本，bridge 与内核行为与现状逐字一致（直通）。
- **零回归锁③**：`wire.loop` 既有帧字段（`state/index/total/until/fresh/judged/reason/error`）只增不改，旧 GUI 解析不受影响。
- 所有新增侧路（解析/验证/持久化/回执）异常一律 try/catch 静默降级，**绝不中断主 loop**（沿用 `kernel/health.mjs` 全模块风格）。
- 命令式验真**必须**经 `engine.tools.run({ name:'Bash', … })` 执行，禁止自建 `spawn/execSync`——验真命令同样受审批门、黑名单与审计约束。
- 退出码判定基准：Bash 工具返回 `{ content, isError }`，`isError === false` 即退出码 0（`kernel/tools.mjs:134-137`）。
- 配置一律 env 位 + 默认值，不触 settings 持久化层。逃生开关 `PONOS_LOOP_LEGACY=1` 回退内联路径，验收通过后移除。
- 提交粒度：每 Task 结尾一个 commit（实现 + 测试同提交），commit message 前缀 `feat/loop-runtime:`。
- 持久化文件：`<configDir>/loop/<sessionId>.json`，原子写（`tmp + rename`），`version: 1`。

---

### Task 1: `kernel/loop-commands.mjs` — 指令解析纯函数

**Files:**
- Create: `kernel/loop-commands.mjs`
- Test: `kernel-tests/loop-commands.test.mjs`

**Interfaces:**
- Consumes: 无（零依赖纯函数模块——设计上必须可被 `server/bridge.mjs` 直接 import 而无副作用）。
- Produces:
  - `parseDuration(s: string) → number | null`（`10m`→600000）
  - `parseLoopDirective(text: string) → null | { kind:'start', opts } | { kind:'op', op, args }`
  - `LOOP_OPS: string[]`（11 个指令）
  - `formatLoopStatus(state) → string`、`formatLoopReplay(history, lastN) → string`

`opts` 形状（与 Task 3 状态模型对齐）：
```js
{ count: number|null, until: string, everyMs: number, fresh: boolean,
  maxCostUsd: number, maxSteps: number, maxWallMs: number,
  doneWhen: [{ type:'cmd', run }], goal: string, prompt: string }
```

- [ ] **Step 1: 写失败测试**

Create `kernel-tests/loop-commands.test.mjs`：

```js
// loop 指令解析（纯函数）：语法矩阵 + GUI 旧语法兼容 + 零回归锁①。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration, parseLoopDirective, LOOP_OPS, formatLoopStatus, formatLoopReplay } from '../kernel/loop-commands.mjs'

test('parseDuration：支持的四种单位与非法输入', () => {
  assert.equal(parseDuration('10m'), 600_000)
  assert.equal(parseDuration('30s'), 30_000)
  assert.equal(parseDuration('2h'), 7_200_000)
  assert.equal(parseDuration('1d'), 86_400_000)
  assert.equal(parseDuration('abc'), null)
  assert.equal(parseDuration('10x'), null)
  assert.equal(parseDuration(''), null)
})

test('零回归锁①：既有 TUI 语法解析结果不变', () => {
  const a = parseLoopDirective('/loop 3 优化这个函数')
  assert.equal(a.kind, 'start')
  assert.equal(a.opts.count, 3)
  assert.equal(a.opts.prompt, '优化这个函数')
  assert.equal(a.opts.until, '')
  assert.equal(a.opts.fresh, false)
  assert.equal(a.opts.everyMs, 0)

  const b = parseLoopDirective('/loop 5 --until 测试全部通过 修复 bug')
  assert.equal(b.opts.count, 5)
  assert.equal(b.opts.until, '测试全部通过')
  assert.equal(b.opts.prompt, '修复 bug')

  const c = parseLoopDirective('/loop 3 --fresh 重新实现')
  assert.equal(c.opts.fresh, true)
  assert.equal(c.opts.count, 3)
  assert.equal(c.opts.prompt, '重新实现')
})

test('GUI 旧语法兼容：首个 token 为时长 → --every 语义（非次数）', () => {
  const d = parseLoopDirective('/loop 10m 检查磁盘')
  assert.equal(d.kind, 'start')
  assert.equal(d.opts.everyMs, 600_000)
  assert.equal(d.opts.count, null, '持续运行（无限轮）')
  assert.equal(d.opts.prompt, '检查磁盘')
})

test('新增参数：--done 可重复 / --goal / --max-cost / --max-steps / --max-wall', () => {
  const d = parseLoopDirective('/loop --goal 修复登录 --done "pytest tests/test_login.py" --done "ruff check ." --max-cost 2.0 --max-steps 30 --max-wall 1h 请修复 bug')
  assert.equal(d.kind, 'start')
  assert.equal(d.opts.goal, '修复登录')
  assert.deepEqual(d.opts.doneWhen, [
    { type: 'cmd', run: 'pytest tests/test_login.py' },
    { type: 'cmd', run: 'ruff check .' },
  ])
  assert.equal(d.opts.maxCostUsd, 2.0)
  assert.equal(d.opts.maxSteps, 30)
  assert.equal(d.opts.maxWallMs, 3_600_000)
  assert.equal(d.opts.prompt, '请修复 bug')
})

test('指令族：11 个 op 全部可解析', () => {
  assert.deepEqual(LOOP_OPS, ['start', 'status', 'pause', 'resume', 'stop', 'budget', 'approve', 'inject', 'rollback', 'replay', 'memory'])
  assert.deepEqual(parseLoopDirective('/loop status'), { kind: 'op', op: 'status', args: [] })
  assert.deepEqual(parseLoopDirective('/loop pause'), { kind: 'op', op: 'pause', args: [] })
  assert.deepEqual(parseLoopDirective('/loop stop 预算 不够'), { kind: 'op', op: 'stop', args: ['预算', '不够'] })
  assert.deepEqual(parseLoopDirective('/loop replay --last 5'), { kind: 'op', op: 'replay', args: ['--last', '5'] })
  assert.equal(parseLoopDirective('/loop inject 改用 v2 接口').op, 'inject')
  assert.equal(parseLoopDirective('/loop budget --max-cost 1.5').op, 'budget')
})

test('非 /loop 文本与不可解析输入 → null（零回归锁②：交调用方直通）', () => {
  assert.equal(parseLoopDirective('帮我修复登录 bug'), null)
  assert.equal(parseLoopDirective('/other 3 x'), null)
  assert.equal(parseLoopDirective(''), null)
  assert.equal(parseLoopDirective('/loop'), null)
})

test('formatLoopStatus / formatLoopReplay：文本回执含关键字段', () => {
  const s = formatLoopStatus({
    status: 'running', goal: '修复登录', index: 2, count: 5, steps: 12,
    costUsd: 0.4321, budget: { maxCostUsd: 2 }, noProgress: { streak: 1, threshold: 3 },
    history: [{ index: 1, ts: '2026-09-14T10:00:00Z', costUsd: 0.2, steps: 5, filesChanged: 2, verify: { passed: false } }],
  })
  assert.match(s, /running/)
  assert.match(s, /修复登录/)
  assert.match(s, /2\/5/)
  assert.match(s, /0\.4321/)
  const r = formatLoopReplay([{ index: 1, ts: '2026-09-14T10:00:00Z', costUsd: 0.2, steps: 5, filesChanged: 2, verify: { passed: true }, judged: false, note: 'ok' }], 5)
  assert.match(r, /#1/)
  assert.match(r, /0\.20/)
  assert.match(r, /通过/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test kernel-tests/loop-commands.test.mjs`
Expected: FAIL（`ERR_MODULE_NOT_FOUND: kernel/loop-commands.mjs`）

- [ ] **Step 3: 实现**

Create `kernel/loop-commands.mjs`：

```js
// kernel/loop-commands.mjs —— /loop 指令解析（纯函数，零依赖零 IO）
// ---------------------------------------------------------------------------
// 语法（cli/tui/bridge/GUI 四端统一）：
//   /loop [次数] [--until <目标>] [--every <间隔>] [--fresh]
//         [--max-cost <USD>] [--max-steps <N>] [--max-wall <时长>]
//         [--done <命令>]... [--goal <目标>] [prompt...]
// 指令族：/loop <op> [args...]（LOOP_OPS）。
// GUI 旧语法兼容：首个 token 形如 10m/30s/1h/1d → 识别为间隔（--every 语义），
// 而非次数（当前 GUI ScheduleGuide 发 `/loop 10m <任务>`，旧内核按 Number() 变 NaN
// 静默吞掉，是本轮修复点之一）。
export const LOOP_OPS = ['start', 'status', 'pause', 'resume', 'stop', 'budget', 'approve', 'inject', 'rollback', 'replay', 'memory']

const DURATION_UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** '10m'/'30s'/'2h'/'1d' → ms；非法返回 null */
export function parseDuration(s) {
  const m = String(s ?? '').trim().match(/^(\d+(?:\.\d+)?)([smhd])$/)
  if (!m) return null
  return Math.round(Number(m[1]) * DURATION_UNITS[m[2]])
}

/** token 是否为纯整数（次数位） */
const isCount = (t) => /^\d+$/.test(String(t ?? ''))

// 取下一个 token 的值；flags 形式（--key=value）在调用处先归一为 ['--key','value']
function tokenize(text) {
  // 支持双引号包裹的取值：--done "pytest tests/test_login.py"
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * 解析 /loop 文本。
 * @returns null | { kind:'start', opts } | { kind:'op', op, args }
 * null ⇒ 非 /loop 或不可解析（调用方按普通消息处理，绝不吞用户输入）
 */
export function parseLoopDirective(text) {
  const raw = String(text ?? '').trim()
  const m = raw.match(/^\/loop(?:\s+([\s\S]*))?$/)
  if (!m) return null
  const body = (m[1] || '').trim()
  if (!body) return null
  const tokens = tokenize(body)
  // 指令族：首 token 为 op 关键字
  if (LOOP_OPS.includes(tokens[0])) {
    return { kind: 'op', op: tokens[0], args: tokens.slice(1) }
  }

  const opts = {
    count: null, until: '', everyMs: 0, fresh: false,
    maxCostUsd: 0, maxSteps: 0, maxWallMs: 0,
    doneWhen: [], goal: '', prompt: '',
  }
  let i = 0
  // 首个 token：次数 | 时长（GUI 旧语法）| flag | prompt
  if (tokens.length && isCount(tokens[0])) {
    opts.count = parseInt(tokens[0], 10)
    i = 1
  } else if (tokens.length && parseDuration(tokens[0]) !== null) {
    opts.everyMs = parseDuration(tokens[0])
    opts.count = null // 间隔式 = 持续运行（靠 stop/until/预算终止）
    i = 1
  }
  const kv = {
    '--until': (v) => { opts.until = v },
    '--every': (v) => { opts.everyMs = parseDuration(v) ?? 0 },
    '--goal': (v) => { opts.goal = v },
    '--max-cost': (v) => { opts.maxCostUsd = Number(v) || 0 },
    '--max-steps': (v) => { opts.maxSteps = Number(v) || 0 },
    '--max-wall': (v) => { opts.maxWallMs = parseDuration(v) ?? 0 },
    '--done': (v) => { opts.doneWhen.push({ type: 'cmd', run: v }) },
  }
  const promptParts = []
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--fresh') { opts.fresh = true; continue }
    const eq = t.indexOf('=')
    if (t.startsWith('--') && eq > 2) {
      const key = t.slice(0, eq)
      if (kv[key]) { kv[key](t.slice(eq + 1)); continue }
    }
    if (kv[t]) {
      const v = tokens[++i]
      if (v === undefined) break // 缺值：忽略该 flag（容错，不抛）
      kv[t](v)
      continue
    }
    promptParts.push(t)
  }
  opts.prompt = promptParts.join(' ').trim()
  // count 缺省：显式给了间隔 → 持续运行；否则沿用现状默认 3
  if (opts.count === null && opts.everyMs === 0) opts.count = 3
  return { kind: 'start', opts }
}

const fmtUsd = (n) => (Number(n) || 0).toFixed(4)

export function formatLoopStatus(state = {}) {
  const st = state
  const lines = [
    `【loop 状态】${st.status || 'idle'}${st.endReason ? `（${st.endReason}）` : ''}`,
    `目标：${st.goal || st.prompt || '(未设定)'}`,
    `轮次：${st.index ?? 0}/${st.count ?? '∞'}    步数：${st.steps ?? 0}    成本：${fmtUsd(st.costUsd)}${st.budget?.maxCostUsd ? ` / ${st.budget.maxCostUsd}` : ''}`,
    `无进展连续：${st.noProgress?.streak ?? 0}/${st.noProgress?.threshold ?? 3}`,
    `验证条件：${(st.doneWhen || []).map((d) => d.run || d.text).join(' && ') || '(无，走 --until/--goal 判定)'}`,
  ]
  const last = (st.history || []).slice(-1)[0]
  if (last) {
    const v = last.verify ? `验证 ${last.verify.passed ? '通过' : '未通过'}` : (last.judged ? '判定达成' : '未判定')
    lines.push(`最近一轮：#${last.index} ${v}，变更 ${last.filesChanged ?? 0} 个文件，成本 ${fmtUsd(last.costUsd)}`)
  }
  if (st.pendingApproval) lines.push(`待批准：${st.pendingApproval.kind}（/loop approve 继续）`)
  return lines.join('\n')
}

export function formatLoopReplay(history = [], lastN = 10) {
  const rows = history.slice(-Math.max(1, Number(lastN) || 10))
  if (!rows.length) return '【loop 回放】暂无轮次记录'
  const lines = [`【loop 回放】最近 ${rows.length} 轮：`]
  for (const h of rows) {
    const v = h.verify ? (h.verify.passed ? '验证通过' : '验证未通过') : (h.judged ? '判定达成' : '—')
    lines.push(`- #${h.index} ${String(h.ts || '').slice(11, 19)} 成本 ${Number(h.costUsd || 0).toFixed(2)} 步数 ${h.steps ?? 0} 变更 ${h.filesChanged ?? 0} 文件 ${v}${h.note ? ` ${h.note}` : ''}`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test kernel-tests/loop-commands.test.mjs`
Expected: PASS（7 个 test）

- [ ] **Step 5: Commit**

```bash
git add kernel/loop-commands.mjs kernel-tests/loop-commands.test.mjs
git commit -m "feat/loop-runtime: Task1 /loop 指令解析纯函数（次数/--until/--every/--done/指令族 + GUI 旧语法兼容 + 零回归锁①）"
```

---

### Task 2: `kernel/loop-verify.mjs` — 双层验证器

**Files:**
- Create: `kernel/loop-verify.mjs`
- Test: `kernel-tests/loop-verify.test.mjs`

**Interfaces:**
- Consumes: `tools`（`engine.tools`，`run({name,input}, ctx) → {content, isError}`）、`engine.judgeUntil({target,maxTokens}) → {done, reason, error}`。
- Produces: `verifyDoneWhen(doneWhen, { tools, judge, signal, timeoutMs }) → { passed:boolean|null, results:[{spec,type,ok,run?,reason?,ms}], reason:string }`

> **退出码契约（实现期已核实并修正）**：Bash 工具的 `finish(content, isError)` 只表达「退出码是否为 0」，**不返回原始退出码**（`kernel/tools.mjs:107-111`）。故 `spec.expect` 仅支持 `0`（缺省）；显式要求非 0 退出码无法判定 → fail-closed 并在 `reason` 中说明「不支持自定义退出码」。计划初稿的 `spec.expect === undefined ? r?.isError !== true : false` 会让显式 expect 恒判失败，已按此订正为显式分支。

- [ ] **Step 1: 写失败测试**

Create `kernel-tests/loop-verify.test.mjs`：

```js
// 双层验证器：命令式（经 Bash 工具门）+ LLM 判词兜底；短路省预算。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyDoneWhen } from '../kernel/loop-verify.mjs'

function fakeTools(map) {
  const calls = []
  return {
    calls,
    async run({ name, input }) {
      calls.push({ name, input })
      const r = map[input.command]
      if (r === undefined) return { content: 'not found', isError: true }
      return { content: r.content ?? 'ok', isError: r.exit !== 0 }
    },
  }
}

test('命令式全过 → passed（且不调模型）', async () => {
  let judgeCalls = 0
  const tools = fakeTools({ 'pytest x': { exit: 0 }, 'ruff check .': { exit: 0 } })
  const r = await verifyDoneWhen([{ type: 'cmd', run: 'pytest x' }, { type: 'cmd', run: 'ruff check .' }], {
    tools, judge: async () => { judgeCalls++; return { done: true, reason: '' } },
  })
  assert.equal(r.passed, true)
  assert.equal(r.results.length, 2)
  assert.ok(r.results.every((x) => x.ok))
  assert.equal(judgeCalls, 0, '命令层已全过，无需判词')
})

test('命令式失败 → passed false 且短路（不再执行后续命令、不调模型）', async () => {
  let judgeCalls = 0
  const tools = fakeTools({ 'pytest x': { exit: 1, content: '1 failed' }, 'ruff check .': { exit: 0 } })
  const r = await verifyDoneWhen([{ type: 'cmd', run: 'pytest x' }, { type: 'cmd', run: 'ruff check .' }], {
    tools, judge: async () => { judgeCalls++; return { done: true, reason: '' } },
  })
  assert.equal(r.passed, false)
  assert.equal(r.results.length, 1, '首条失败即短路')
  assert.equal(tools.calls.length, 1)
  assert.equal(judgeCalls, 0)
  assert.match(r.reason, /pytest x/)
})

test('命令经 Bash 工具门执行（断言工具名 Bash，不绕审批自建 spawn）', async () => {
  const tools = fakeTools({ 'echo hi': { exit: 0 } })
  await verifyDoneWhen([{ type: 'cmd', run: 'echo hi' }], { tools, judge: async () => ({ done: false }) })
  assert.equal(tools.calls[0].name, 'Bash', '必须经 Bash 工具（受审批/黑名单/审计）')
  assert.equal(tools.calls[0].input.command, 'echo hi')
})

test('命令层全过后判词层失败 → passed false', async () => {
  const tools = fakeTools({ 'pytest x': { exit: 0 } })
  const r = await verifyDoneWhen(
    [{ type: 'cmd', run: 'pytest x' }, { type: 'judge', text: '文档已写完' }],
    { tools, judge: async () => ({ done: false, reason: '还缺第 3 章' }) },
  )
  assert.equal(r.passed, false)
  assert.equal(r.results.at(-1).type, 'judge')
  assert.equal(r.results.at(-1).ok, false)
})

test('仅判词条件（无命令）→ 只调模型', async () => {
  const tools = fakeTools({})
  const r = await verifyDoneWhen([{ type: 'judge', text: '目标达成' }], { tools, judge: async () => ({ done: true, reason: '已满足' }) })
  assert.equal(r.passed, true)
  assert.equal(tools.calls.length, 0)
})

test('doneWhen 为空 → passed null（调用方回落 --until/--goal 判定）', async () => {
  const r = await verifyDoneWhen([], { tools: fakeTools({}), judge: async () => ({ done: true }) })
  assert.equal(r.passed, null)
  assert.deepEqual(r.results, [])
})

test('工具抛异常 → 该条不通过且不影响其它判定（静默降级）', async () => {
  const tools = { calls: [], async run() { throw new Error('boom') } }
  const r = await verifyDoneWhen([{ type: 'cmd', run: 'x' }], { tools, judge: async () => ({ done: true }) })
  assert.equal(r.passed, false)
  assert.equal(r.results[0].ok, false)
  assert.match(String(r.results[0].reason), /boom/)
})

test('judge 抛异常 → 视为未通过（不误判为达成）', async () => {
  const r = await verifyDoneWhen([{ type: 'judge', text: 'x' }], {
    tools: fakeTools({}), judge: async () => { throw new Error('judge down') },
  })
  assert.equal(r.passed, false)
  assert.match(String(r.results[0].reason), /judge down/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test kernel-tests/loop-verify.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

Create `kernel/loop-verify.mjs`：

```js
// kernel/loop-verify.mjs —— loop 完成条件双层验证器（spec 3.2）
// ---------------------------------------------------------------------------
// 第一层「命令式验真」：确定性最高，逐条执行 expect 退出码（默认 0）。
//   **必须经 engine.tools.run({name:'Bash'})** —— 验真命令同样受五段式执行管线
//   （白名单 → 权限/审批 → 频率 → Schema → 有界重试）与审计约束，禁止自建 spawn 绕过。
//   退出码基准：Bash 工具以 isError = (code !== 0) 表达（kernel/tools.mjs:134-137）。
// 第二层「LLM 判词」：命令层全过后才调用（省预算），判定必须 done === true 才通过。
// 任一层异常/超时 → 该条不通过（fail-closed：绝不把"验证失败"当"已达成"）。
const DEFAULT_CMD_TIMEOUT_MS = 120_000

async function withTimeout(p, ms, onTimeout) {
  if (!ms || ms <= 0) return p
  let timer = null
  try {
    return await Promise.race([
      p,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(onTimeout || `超时（${ms}ms）`)), ms) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

/**
 * @param {Array<{type:'cmd',run:string,expect?:number,timeoutMs?:number}|{type:'judge',text:string}>} doneWhen
 * @param {{ tools:any, judge:(o:{target:string})=>Promise<{done:boolean,reason?:string}>, signal?:any, timeoutMs?:number }} deps
 * @returns {Promise<{passed:boolean|null, results:Array, reason:string}>}
 */
export async function verifyDoneWhen(doneWhen = [], deps = {}) {
  const { tools, judge, timeoutMs = DEFAULT_CMD_TIMEOUT_MS } = deps
  const specs = Array.isArray(doneWhen) ? doneWhen.filter(Boolean) : []
  if (!specs.length) return { passed: null, results: [], reason: '未配置完成条件' }
  const results = []
  for (const spec of specs) {
    const t0 = Date.now()
    if (spec.type === 'cmd') {
      try {
        const r = await withTimeout(
          tools.run({ name: 'Bash', input: { command: String(spec.run) } }, {}),
          Number(spec.timeoutMs) || timeoutMs,
          `验真命令超时：${spec.run}`,
        )
        const ok = spec.expect === undefined ? r?.isError !== true : false
        results.push({ spec, type: 'cmd', run: spec.run, ok, ms: Date.now() - t0, output: String(r?.content ?? '').slice(0, 400) })
        if (!ok) return { passed: false, results, reason: `命令未通过：${spec.run} → ${String(r?.content ?? '').slice(0, 200)}` }
      } catch (e) {
        results.push({ spec, type: 'cmd', run: spec.run, ok: false, ms: Date.now() - t0, reason: e?.message || String(e) })
        return { passed: false, results, reason: `命令执行异常：${spec.run} → ${e?.message || String(e)}` }
      }
    } else if (spec.type === 'judge') {
      try {
        const j = await withTimeout(judge({ target: String(spec.text) }), timeoutMs, `判词超时：${spec.text}`)
        const ok = j?.done === true
        results.push({ spec, type: 'judge', ok, ms: Date.now() - t0, reason: String(j?.reason ?? '') })
        if (!ok) return { passed: false, results, reason: `判词判定未达成：${j?.reason || spec.text}` }
      } catch (e) {
        results.push({ spec, type: 'judge', ok: false, ms: Date.now() - t0, reason: e?.message || String(e) })
        return { passed: false, results, reason: `判词异常：${e?.message || String(e)}` }
      }
    } else {
      results.push({ spec, type: String(spec.type || 'unknown'), ok: false, ms: Date.now() - t0, reason: '未知条件类型' })
      return { passed: false, results, reason: `未知条件类型：${spec.type}` }
    }
  }
  return { passed: true, results, reason: '全部完成条件通过' }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test kernel-tests/loop-verify.test.mjs`
Expected: PASS（8 个 test）

- [ ] **Step 5: Commit**

```bash
git add kernel/loop-verify.mjs kernel-tests/loop-verify.test.mjs
git commit -m "feat/loop-runtime: Task2 双层验证器（命令式经 Bash 工具门 + 判词兜底 + fail-closed + 短路省预算）"
```

---

### Task 3: `kernel/loop.mjs` — LoopController（状态机/预算/无进展/持久化/指令族）

**Files:**
- Create: `kernel/loop.mjs`
- Test: `kernel-tests/loop-controller.test.mjs`

**Interfaces:**
- Consumes: `parseLoopDirective`/`parseDuration`/`formatLoopStatus`/`formatLoopReplay`（Task 1）；`verifyDoneWhen`（Task 2）；`costOf`（`kernel/cost.mjs:4`）。
- Produces: `createLoopController({ wire, engine, store, configDir, sessionId, env })` 返回：
  `start(opts)`, `onTurnEnd({ outcome }) → { action:'next'|'wait'|'stop', delayMs, rationale }`,
  `status()`, `formatStatus()`, `pause()`, `resume()`, `stop(reason)`, `setBudget(patch)`,
  `approve()`, `inject(text)`, `snapshot()`, `rollback()`, `replay(n)`, `memory()`,
  `load()`, `persist()`, `isActive()`, `nextPayload()`。

`nextPayload()` 返回 cli 直接入队的内核消息：`{ message:{role:'user',content}, loop:{ count, until, fresh, index } }`。

- [ ] **Step 1: 写失败测试**

Create `kernel-tests/loop-controller.test.mjs`：

```js
// LoopController：状态机 / 预算硬停 / 无进展升级 / 次数耗尽 / 持久化 round-trip。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopController } from '../kernel/loop.mjs'

function makeEnv(env = {}) {
  const events = []
  const dir = mkdtempSync(join(tmpdir(), 'ponos-loop-'))
  const configDir = join(dir, 'home')
  mkdirSync(configDir, { recursive: true })
  const controller = createLoopController({
    wire: {
      loop: (state, data = {}) => events.push({ state, ...data }),
      warning: (d) => events.push({ warning: d }),
      system: (sub, d = {}) => events.push({ system: sub, ...d }),
    },
    engine: { queueNext: () => {}, judgeUntil: async () => ({ done: false, reason: '' }) },
    store: null,
    configDir,
    sessionId: 'sess-1',
    cwd: dir,
    env: { PONOS_PRICE_PER_M_INPUT: '0.2', PONOS_PRICE_PER_M_OUTPUT: '1.2', ...env },
  })
  return { events, controller, dir, configDir, file: join(configDir, 'loop', 'sess-1.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const OUTCOME = (inTok = 10, outTok = 20, extra = {}) => ({
  usage: { input_tokens: inTok, output_tokens: outTok }, text: 'ok', toolDigest: [], ...extra,
})

test('start → running + 持久化 + wire start 帧', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 3, prompt: '做事', goal: '修复登录' })
    const st = env.controller.status()
    assert.equal(st.status, 'running')
    assert.equal(st.count, 3)
    assert.equal(st.goal, '修复登录')
    assert.ok(env.events.some((e) => e.state === 'start' && e.goal === '修复登录'))
    assert.ok(existsSync(env.file), '应持久化')
    assert.equal(JSON.parse(readFileSync(env.file, 'utf-8')).status, 'running')
  } finally { env.cleanup() }
})

test('次数耗尽 → completed 且 stop', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 2, prompt: '做事' })
    const r1 = env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.equal(r1.action, 'next')
    const r2 = env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.equal(r2.action, 'stop')
    assert.equal(env.controller.status().status, 'done')
    assert.equal(env.controller.status().endReason, 'completed')
    assert.ok(env.events.some((e) => e.state === 'end' && e.reason === 'completed'))
  } finally { env.cleanup() }
})

test('预算硬停：成本超 maxCostUsd → budget_exceeded（先于其它判定）', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 99, prompt: '做事', maxCostUsd: 0.000001 })
    const r = env.controller.onTurnEnd({ outcome: OUTCOME(10, 20) })
    assert.equal(r.action, 'stop')
    const st = env.controller.status()
    assert.equal(st.status, 'budget_exceeded')
    assert.ok(st.costUsd > 0)
    assert.ok(env.events.some((e) => e.state === 'end' && e.reason === 'budget_exceeded'))
  } finally { env.cleanup() }
})

test('无进展连续 N 轮 → awaiting_approval + 注入反思（不静默烧钱）', async () => {
  const injected = []
  const env = makeEnv({ PONOS_LOOP_NOPROGRESS_N: '2' })
  try {
    env.controller.engine.queueNext = (c) => injected.push(String(c))
    env.controller.start({ count: 99, prompt: '做事' })
    // 四轮完全相同 outcome（同名工具同路径同错误）→ 指纹不变 → streak 增长
    const same = () => OUTCOME(10, 20, { toolDigest: [{ name: 'Bash', path: 'x', isError: true, errorText: 'E1' }] })
    env.controller.onTurnEnd({ outcome: same() })
    const r = env.controller.onTurnEnd({ outcome: same() })
    assert.equal(r.action, 'stop')
    const st = env.controller.status()
    assert.equal(st.status, 'awaiting_approval')
    assert.equal(st.pendingApproval.kind, 'no_progress')
    assert.ok(injected.some((t) => /无实质进展|换策略|阻塞/.test(t)), '应注入反思指令')
  } finally { env.cleanup() }
})

test('pause/resume/stop 状态迁移 + 事件', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 5, prompt: '做事' })
    env.controller.pause()
    assert.equal(env.controller.status().status, 'pausing')
    env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.equal(env.controller.status().status, 'paused')
    assert.equal(env.controller.onTurnEnd({ outcome: OUTCOME() }).action, 'wait', 'paused 不推进')
    env.controller.resume()
    assert.equal(env.controller.status().status, 'running')
    env.controller.stop('用户停止')
    assert.equal(env.controller.status().status, 'cancelled')
    assert.equal(env.controller.isActive(), false)
    assert.ok(env.events.some((e) => e.state === 'end' && e.reason === 'cancelled'))
  } finally { env.cleanup() }
})

test('doneWhen 验真通过 → verify_hit（经注入的 verify 依赖）', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 99, prompt: '做事', doneWhen: [{ type: 'cmd', run: 'pytest x' }] })
    env.controller.__setVerifyForTest(async () => ({ passed: true, results: [{ type: 'cmd', run: 'pytest x', ok: true }], reason: 'ok' }))
    const r = env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.equal(r.action, 'stop')
    assert.equal(env.controller.status().endReason, 'verify_hit')
  } finally { env.cleanup() }
})

test('doneWhen 未通过 → 继续下一轮且 iter 帧带 verify 摘要', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 99, prompt: '做事', doneWhen: [{ type: 'cmd', run: 'pytest x' }] })
    env.controller.__setVerifyForTest(async () => ({ passed: false, results: [{ type: 'cmd', run: 'pytest x', ok: false }], reason: 'failed' }))
    const r = env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.equal(r.action, 'next')
    const iter = env.events.filter((e) => e.state === 'iter').at(-1)
    assert.equal(iter.verify.passed, false)
    assert.equal(iter.verify.results[0].run, 'pytest x')
  } finally { env.cleanup() }
})

test('持久化 round-trip：新控制器 load 恢复 running 状态', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 5, prompt: '做事', goal: 'G', everyMs: 1000 })
    env.controller.onTurnEnd({ outcome: OUTCOME() })
    const before = env.controller.status()
    assert.equal(before.index, 1)
    // 同一 configDir/sessionId 建新控制器（模拟进程重启）
    const c2 = createLoopController({
      wire: { loop: () => {}, warning: () => {}, system: () => {} },
      engine: { queueNext: () => {}, judgeUntil: async () => ({ done: false }) },
      store: null, configDir: env.configDir, sessionId: 'sess-1', cwd: env.dir, env: {},
    })
    const loaded = c2.load()
    assert.equal(loaded, true)
    assert.equal(c2.status().status, 'running')
    assert.equal(c2.status().index, 1)
    assert.equal(c2.status().goal, 'G')
    assert.equal(c2.status().everyMs, 1000)
  } finally { env.cleanup() }
})

test('持久化文件损坏 → load 返回 false 且按新 loop 处理（不抛）', async () => {
  const env = makeEnv()
  try {
    mkdirSync(join(env.configDir, 'loop'), { recursive: true })
    writeFileSync(env.file, '{broken json')
    assert.equal(env.controller.load(), false)
    assert.equal(env.controller.status().status, 'idle')
  } finally { env.cleanup() }
})

test('已终结 loop 的 load → 不重启（返回 false）', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 1, prompt: '做事' })
    env.controller.onTurnEnd({ outcome: OUTCOME() }) // → done
    const c2 = createLoopController({
      wire: { loop: () => {}, warning: () => {}, system: () => {} },
      engine: { queueNext: () => {}, judgeUntil: async () => ({ done: false }) },
      store: null, configDir: env.configDir, sessionId: 'sess-1', cwd: env.dir, env: {},
    })
    assert.equal(c2.load(), false)
  } finally { env.cleanup() }
})

test('inject → 追加注入并调 engine.queueNext；budget 热更新生效', async () => {
  const injected = []
  const env = makeEnv()
  try {
    env.controller.engine.queueNext = (c) => injected.push(String(c))
    env.controller.start({ count: 5, prompt: '做事' })
    env.controller.inject('改用 v2 接口')
    assert.deepEqual(env.controller.status().injections, ['改用 v2 接口'])
    assert.deepEqual(injected, ['改用 v2 接口'])
    env.controller.setBudget({ maxCostUsd: 1.5 })
    assert.equal(env.controller.status().budget.maxCostUsd, 1.5)
  } finally { env.cleanup() }
})

test('replay/memory 文本回执可用', async () => {
  const env = makeEnv()
  try {
    env.controller.start({ count: 3, prompt: '做事' })
    env.controller.onTurnEnd({ outcome: OUTCOME() })
    assert.match(env.controller.replay(5), /#1/)
    assert.match(env.controller.memory(), /loop/i)
  } finally { env.cleanup() }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test kernel-tests/loop-controller.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

Create `kernel/loop.mjs`：

```js
// kernel/loop.mjs —— loop 运行时控制器（spec 3.3/3.4/5.3）
// ---------------------------------------------------------------------------
// 职责：loop 状态机（次数/until/every/fresh）·预算硬停·无进展升级·状态持久化·指令族。
// 边界（安全短路序，spec 3.4）：预算/无进展**先于**验证器判定 —— 防止"验证器反复失败
// → 无限重试烧钱"。所有方法幂等 + 静默降级：任何异常都不得中断主 loop（沿用 health 风格）。
// 持久化：<configDir>/loop/<sessionId>.json（原子写 tmp+rename）；只存控制面，不存对话。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { costOf } from './cost.mjs'
import { formatLoopReplay, formatLoopStatus, parseDuration } from './loop-commands.mjs'
import { verifyDoneWhen } from './loop-verify.mjs'

const SCHEMA_VERSION = 1
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'budget_exceeded', 'no_progress', 'stalled'])

export function createLoopController({ wire, engine, store = null, configDir = '', sessionId = '', cwd = '', env = process.env } = {}) {
  const file = join(configDir, 'loop', `${sessionId}.json`)
  const prices = {
    pricePerMInput: Number(env.PONOS_PRICE_PER_M_INPUT) || 0.2,
    pricePerMOutput: Number(env.PONOS_PRICE_PER_M_OUTPUT) || 1.2,
    cacheReadRatio: Number(env.PONOS_CACHE_READ_RATIO) || 0.1,
  }
  const noProgressN = Math.max(1, Number(env.PONOS_LOOP_NOPROGRESS_N) || 3)
  const onStall = String(env.PONOS_LOOP_ON_STALL || 'reflect_and_ask')
  let persistWarned = false
  let verifyImpl = (doneWhen, deps) => verifyDoneWhen(doneWhen, deps)

  let state = freshState()
  function freshState() {
    return {
      version: SCHEMA_VERSION, status: 'idle', goal: '', doneWhen: [], prompt: '',
      index: 0, count: null, everyMs: 0, fresh: false,
      budget: { maxCostUsd: 0, maxSteps: 0, maxWallMs: 0 },
      usageAcc: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      costUsd: 0, steps: 0,
      noProgress: { streak: 0, lastFingerprint: '', threshold: noProgressN },
      onStall, injections: [],
      startedAt: '', updatedAt: '', endedAt: '', endReason: '',
      history: [], pendingApproval: null, snapshotRef: '',
    }
  }

  // —— 持久化（原子写；失败静默但提示一次，绝不阻断循环） ——
  function persist() {
    try {
      const dir = join(configDir, 'loop')
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp`
      state.updatedAt = new Date().toISOString()
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
      renameSync(tmp, file)
      return true
    } catch {
      if (!persistWarned) {
        persistWarned = true
        try { wire?.warning?.({ level: 'loop_persist', message: 'loop 状态落盘失败（磁盘不可写？），断点续跑能力不可用' }) } catch { /* 静默 */ }
      }
      return false
    }
  }

  function emit(state_, data = {}) { try { wire?.loop?.(state_, data) } catch { /* 事件失败不阻断 */ } }

  function fingerprintOf(outcome) {
    const d = Array.isArray(outcome?.toolDigest) ? outcome.toolDigest : []
    const files = d.filter((t) => !t.isError && t.path).map((t) => `${t.name}:${t.path}`).sort().join(',')
    const errs = d.filter((t) => t.isError).map((t) => `${t.name}:${String(t.errorText || '').slice(0, 60)}`).sort().join(',')
    return `${files}|${errs}`
  }

  // —— 指令族 ——
  function start(opts = {}) {
    state = freshState()
    state.status = 'running'
    state.goal = String(opts.goal || '')
    state.doneWhen = Array.isArray(opts.doneWhen) ? opts.doneWhen : []
    state.prompt = String(opts.prompt || opts.goal || '')
    state.count = opts.count === null || opts.count === undefined ? null : Math.max(1, Number(opts.count) || 1)
    state.everyMs = Number(opts.everyMs) || 0
    state.fresh = opts.fresh === true
    state.budget = {
      maxCostUsd: Number(opts.maxCostUsd) || 0,
      maxSteps: Number(opts.maxSteps) || 0,
      maxWallMs: Number(opts.maxWallMs) || 0,
    }
    state.startedAt = new Date().toISOString()
    persist()
    emit('start', {
      index: 0, total: state.count, until: String(opts.until || ''), fresh: state.fresh,
      goal: state.goal, everyMs: state.everyMs, budget: state.budget,
      doneWhen: state.doneWhen.map((d) => d.run || d.text),
    })
    return state
  }

  function isActive() { return state.status === 'running' || state.status === 'pausing' || state.status === 'awaiting_approval' || state.status === 'verifying' }

  function stop(reason = 'cancelled') {
    const wasActive = isActive()
    state.status = reason === 'budget_exceeded' ? 'budget_exceeded' : 'cancelled'
    state.endReason = reason
    state.endedAt = new Date().toISOString()
    persist()
    if (wasActive || reason === 'budget_exceeded') emit('end', { reason, index: state.index, total: state.count, goal: state.goal, costUsd: Number(state.costUsd.toFixed(4)) })
    return state
  }

  function pause() {
    if (!isActive()) return state
    state.status = 'pausing' // 当前轮跑完转 paused（轮次边界停，不打断进行中的轮）
    persist()
    emit('status', { status: state.status, index: state.index, total: state.count })
    return state
  }

  function resume() {
    if (TERMINAL.has(state.status)) return state
    state.status = 'running'
    state.pendingApproval = null
    persist()
    emit('status', { status: state.status, index: state.index, total: state.count })
    return state
  }

  function approve() { return resume() }

  function setBudget(patch = {}) {
    for (const k of ['maxCostUsd', 'maxSteps', 'maxWallMs']) {
      if (patch[k] !== undefined) state.budget[k] = Number(patch[k]) || 0
    }
    persist()
    emit('status', { status: state.status, budget: state.budget })
    return state
  }

  function inject(text) {
    const t = String(text ?? '').trim()
    if (!t) return state
    state.injections.push(t)
    persist()
    try { engine?.queueNext?.(`【loop 人工补充】${t}`) } catch { /* 注入失败不阻断 */ }
    return state
  }

  function snapshot() {
    // 轻量检查点：记录 git HEAD（回滚目标）；非 git 仓库则跳过（静默）
    try {
      state.snapshotRef = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' })).trim()
      persist()
    } catch { /* 非 git / git 不可用：无快照可回滚 */ }
    return state.snapshotRef
  }

  function rollback() {
    if (!state.snapshotRef) return { ok: false, error: '无可回滚快照（非 git 仓库或尚未打点）' }
    state.pendingApproval = { kind: 'rollback', detail: state.snapshotRef }
    persist()
    emit('status', { status: 'awaiting_approval', pendingApproval: state.pendingApproval })
    return { ok: true, needApproval: true, ref: state.snapshotRef }
  }

  function status() { return { ...state } }
  function formatStatus() { return formatLoopStatus(state) }
  function replay(n = 10) { return formatLoopReplay(state.history, n) }
  function memory() {
    const fails = state.history.filter((h) => h.verify && h.verify.passed === false).length
    const rules = state.injections.length ? `\n人工补充：\n- ${state.injections.join('\n- ')}` : ''
    return `【loop 记忆】目标：${state.goal || state.prompt || '(未设定)'}\n验证失败轮次：${fails}/${state.history.length}\n无进展连续：${state.noProgress.streak}/${state.noProgress.threshold}${rules}`
  }

  /** 下一轮投递载荷（cli 直接入队） */
  function nextPayload(until = '') {
    const extra = state.injections.length ? `\n\n【loop 人工补充】\n- ${state.injections.join('\n- ')}` : ''
    return {
      message: { role: 'user', content: state.prompt + extra },
      loop: { count: state.count, until, fresh: state.fresh, index: state.index },
    }
  }

  async function runVerify() {
    const specs = state.doneWhen.length ? state.doneWhen : (state.goal ? [{ type: 'judge', text: state.goal }] : [])
    if (!specs.length) return null
    try {
      return await verifyImpl(specs, { tools: engine?.tools, judge: (o) => engine.judgeUntil(o), signal: engine?.signal })
    } catch (e) {
      return { passed: false, results: [], reason: `验证器异常：${e?.message || String(e)}` }
    }
  }

  /**
   * 轮末驱动（cli 在 finally 的 loop 推进处调用）。
   * @returns {{ action:'next'|'wait'|'stop', delayMs:number, rationale:string }}
   */
  async function onTurnEnd({ outcome } = {}) {
    if (!isActive()) return { action: 'wait', delayMs: 0, rationale: `status=${state.status}` }
    // 1. 累计用量/成本/步数
    try {
      const u = outcome?.usage
      if (u) for (const k of Object.keys(state.usageAcc)) state.usageAcc[k] += Number(u[k]) || 0
      state.costUsd = costOf(state.usageAcc, prices)
    } catch { /* 成本计算失败不阻断 */ }
    const digest = Array.isArray(outcome?.toolDigest) ? outcome.toolDigest : []
    state.steps += digest.length
    const filesChanged = digest.filter((t) => !t.isError && t.path).length

    // 2. 无进展指纹（轮次维度，补既有时间维度 LOOP_STALL_MS 的空档）
    // 语义：连续相同指纹轮数。首次记录即算第 1 轮（第 1 轮不可能"与前一轮相同"），
    // 后续每轮指纹不变则 +1；达到阈值（默认 3，env PONOS_LOOP_NOPROGRESS_N）即升级。
    // 指纹为空（本轮无工具调用）→ 不计无进展（纯文本轮无法判定是否实质推进，保守不误停）。
    const fp = fingerprintOf(outcome)
    if (fp && fp === state.noProgress.lastFingerprint) state.noProgress.streak += 1
    else if (fp) state.noProgress.streak = 1
    else state.noProgress.streak = 0
    state.noProgress.lastFingerprint = fp

    const historyEntry = {
      index: state.index + 1, ts: new Date().toISOString(),
      usage: outcome?.usage || null, costUsd: Number(state.costUsd.toFixed(4)),
      steps: digest.length, toolCount: digest.length, filesChanged,
      errors: digest.filter((t) => t.isError).length,
      verify: null, judged: false, note: '',
    }
    state.index += 1

    // 3. 短路序：pausing → 预算 → 无进展 → 验证 → 次数
    if (state.status === 'pausing') {
      state.status = 'paused'
      state.history.push(historyEntry)
      persist()
      emit('iter', { index: state.index, total: state.count, steps: state.steps, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak })
      emit('status', { status: 'paused', index: state.index, total: state.count })
      return { action: 'wait', delayMs: 0, rationale: 'paused' }
    }

    const overBudget = (state.budget.maxCostUsd > 0 && state.costUsd > state.budget.maxCostUsd)
      || (state.budget.maxSteps > 0 && state.steps > state.budget.maxSteps)
      || (state.budget.maxWallMs > 0 && Date.now() - Date.parse(state.startedAt) > state.budget.maxWallMs)
    if (overBudget) {
      state.history.push({ ...historyEntry, note: 'budget_exceeded' })
      stop('budget_exceeded')
      return { action: 'stop', delayMs: 0, rationale: 'budget_exceeded' }
    }

    if (state.noProgress.streak >= state.noProgress.threshold) {
      state.history.push({ ...historyEntry, note: 'no_progress' })
      if (onStall === 'stop') { stop('no_progress'); return { action: 'stop', delayMs: 0, rationale: 'no_progress' } }
      try {
        engine?.queueNext?.(`【loop 无进展预警】连续 ${state.noProgress.streak} 轮无实质进展（文件未变更/重复相同错误）。请换一种策略推进，或说明当前阻塞点与需要的帮助。`)
      } catch { /* 静默 */ }
      state.status = 'awaiting_approval'
      state.pendingApproval = { kind: 'no_progress', detail: `连续 ${state.noProgress.streak} 轮无进展` }
      state.endReason = 'stalled'
      persist()
      emit('iter', { index: state.index, total: state.count, steps: state.steps, costUsd: Number(state.costUsd.toFixed(4)), noProgressStreak: state.noProgress.streak })
      emit('status', { status: 'awaiting_approval', pendingApproval: state.pendingApproval, index: state.index, total: state.count })
      return { action: 'stop', delayMs: 0, rationale: 'no_progress' }
    }

    // 4. 完成条件（doneWhen 优先；否则 --until/goal 判词）
    if (state.doneWhen.length) {
      state.status = 'verifying'
      const v = await runVerify()
      historyEntry.verify = v ? { passed: v.passed, results: (v.results || []).map((r) => ({ run: r.run, type: r.type, ok: r.ok })) } : null
      historyEntry.note = v?.reason || ''
      state.status = 'running'
      state.history.push(historyEntry)
      if (v?.passed === true) {
        state.status = 'done'; state.endReason = 'verify_hit'; state.endedAt = new Date().toISOString()
        persist()
        emit('iter', { index: state.index, total: state.count, steps: state.steps, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak, verify: historyEntry.verify })
        emit('end', { reason: 'verify_hit', index: state.index, total: state.count, goal: state.goal, costUsd: Number(state.costUsd.toFixed(4)) })
        return { action: 'stop', delayMs: 0, rationale: 'verify_hit' }
      }
      persist()
      emit('iter', { index: state.index, total: state.count, steps: state.steps, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak, verify: historyEntry.verify })
      return { action: 'next', delayMs: state.everyMs, rationale: `verify_failed: ${v?.reason || ''}` }
    }

    state.history.push(historyEntry)
    persist()
    emit('iter', { index: state.index, total: state.count, steps: state.steps, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak })
    if (state.count !== null && state.index >= state.count) {
      state.status = 'done'; state.endReason = 'completed'; state.endedAt = new Date().toISOString()
      persist()
      emit('end', { reason: 'completed', index: state.index, total: state.count, goal: state.goal, costUsd: Number(state.costUsd.toFixed(4)) })
      return { action: 'stop', delayMs: 0, rationale: 'completed' }
    }
    return { action: 'next', delayMs: state.everyMs, rationale: 'continue' }
  }

  function load() {
    try {
      if (!existsSync(file)) return false
      const parsed = JSON.parse(readFileSync(file, 'utf-8'))
      if (Number(parsed?.version) !== SCHEMA_VERSION) return false
      if (TERMINAL.has(String(parsed?.status))) return false // 已终结不重启
      state = { ...freshState(), ...parsed, budget: { ...freshState().budget, ...(parsed.budget || {}) }, noProgress: { ...freshState().noProgress, ...(parsed.noProgress || {}) } }
      emit('start', { index: state.index, total: state.count, until: '', fresh: state.fresh, goal: state.goal, everyMs: state.everyMs, budget: state.budget, resumed: true })
      return true
    } catch { return false }
  }

  return {
    start, onTurnEnd, status, formatStatus, pause, resume, stop, setBudget, approve, inject,
    snapshot, rollback, replay, memory, load, persist, isActive, nextPayload,
    engine, // 暴露注入的 engine（cli 与测试共用同一实例；测试改其 queueNext 可断言注入）
    // 测试注入点（生产代码不调用）
    __setVerifyForTest(fn) { verifyImpl = fn },
  }
}
```

> **实现注意**：`snapshot()` 依赖的 `execFileSync` 已在文件顶部 `import`（ESM 下不可用 `require`）；实现时按此落地，勿改回 `require` 写法。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test kernel-tests/loop-controller.test.mjs`
Expected: PASS（12 个 test）

- [ ] **Step 5: Commit**

```bash
git add kernel/loop.mjs kernel-tests/loop-controller.test.mjs
git commit -m "feat/loop-runtime: Task3 LoopController（状态机/预算硬停/无进展升级/持久化 round-trip/指令族）"
```

---

### Task 4: `kernel/cli.mjs` 接线 — 委托控制器 + `loop_command` 路由 + resume 恢复

**Files:**
- Modify: `kernel/cli.mjs:866`（`loopState` → controller）、`:896-905`（start 登记）、`:1002-1030`（轮末推进）、`:1156-1160`（cancel）、`:1247-1285`（stdin 路由加 `loop_command`）、`:861`（`state` 附近建 controller）
- Modify: `kernel/protocol.mjs:119`（`loop` 帧注释与字段透传——无需改代码，只补注释说明扩展字段）
- Test: `kernel-tests/loop-e2e.test.mjs`

**Interfaces:**
- Consumes: `createLoopController`（Task 3）、`parseLoopDirective`（Task 1）、`wire.loop`（`protocol.mjs:119`）。
- Produces: 内核 stdin 新增消息类型 `{ type:'loop_command', op, args, requestId }`；stdout 新增回执 `{ type:'system', subtype:'loop_result', requestId, op, ok, text }`。

- [ ] **Step 1: 写失败测试**

Create `kernel-tests/loop-e2e.test.mjs`：

```js
// cli 接线端到端：loop 载荷驱动轮次推进 + loop_command 指令族路由 + 零回归锁②③。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KERNEL_CLI = join(__dirname, '..', 'kernel', 'cli.mjs')
const FMT = ['--output-format', 'stream-json', '--input-format', 'stream-json']

function makeKernel(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-loope2e-'))
  const env = {
    ...process.env, PONOS_MOCK_API: '1',
    CLAUDE_CONFIG_DIR: join(dir, 'home'), YFWORKING_HOME: join(dir, 'home'),
    PONOS_BUDGET_USD: '0', ...extraEnv,
  }
  const proc = spawn(process.execPath, [KERNEL_CLI, ...FMT, '--add-dir', dir, '--skip-permissions'], { env })
  const events = []
  createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (l) => {
    const t = l.trim(); if (!t) return
    try { events.push(JSON.parse(t)) } catch { /* 非 JSON 行忽略 */ }
  })
  const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n')
  const waitFor = async (pred, ms = 10_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = events.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 15))
    }
    return null
  }
  return { proc, events, send, waitFor, dir, cleanup: () => { try { proc.kill() } catch {} rmSync(dir, { recursive: true, force: true }) } }
}

test('loop 载荷驱动多轮推进：start → iter → end(completed)', async () => {
  const k = makeKernel()
  try {
    await k.waitFor((e) => e.type === 'system' && e.subtype === 'init')
    k.send({ type: 'user', message: { role: 'user', content: '你好' }, loop: { count: 2 } })
    const start = await k.waitFor((e) => e.type === 'loop' && e.state === 'start')
    assert.ok(start, '应发 loop start 帧')
    assert.equal(start.total, 2)
    await k.waitFor((e) => e.type === 'loop' && e.state === 'end')
    const end = k.events.filter((e) => e.type === 'loop' && e.state === 'end').at(-1)
    assert.equal(end.reason, 'completed')
    assert.equal(end.index, 2)
    // 零回归锁③：既有字段仍在
    assert.equal(typeof end.total, 'number')
  } finally { k.cleanup() }
})

test('loop_command status：回执含状态与轮次（新增指令族路由）', async () => {
  const k = makeKernel()
  try {
    await k.waitFor((e) => e.type === 'system' && e.subtype === 'init')
    k.send({ type: 'loop_command', op: 'status', args: [], requestId: 'req-1' })
    const r = await k.waitFor((e) => e.type === 'system' && e.subtype === 'loop_result' && e.requestId === 'req-1')
    assert.ok(r, '应回 loop_result')
    assert.equal(r.op, 'status')
    assert.equal(r.ok, true)
    assert.match(String(r.text), /loop 状态/)
  } finally { k.cleanup() }
})

test('loop_command stop / replay / memory 回执可用', async () => {
  const k = makeKernel()
  try {
    await k.waitFor((e) => e.type === 'system' && e.subtype === 'init')
    for (const op of ['replay', 'memory', 'stop']) {
      k.send({ type: 'loop_command', op, args: [], requestId: `req-${op}` })
    }
    for (const op of ['replay', 'memory', 'stop']) {
      const r = await k.waitFor((e) => e.type === 'system' && e.subtype === 'loop_result' && e.requestId === `req-${op}`)
      assert.ok(r, `${op} 应有回执`)
      assert.equal(r.ok, true)
    }
  } finally { k.cleanup() }
})

test('零回归锁②：普通消息（无 loop 字段）不触发 loop 帧', async () => {
  const k = makeKernel()
  try {
    await k.waitFor((e) => e.type === 'system' && e.subtype === 'init')
    k.send({ type: 'user', message: { role: 'user', content: '你好' } })
    await k.waitFor((e) => e.type === 'result')
    assert.equal(k.events.filter((e) => e.type === 'loop').length, 0, '无 loop 字段不得发 loop 帧')
  } finally { k.cleanup() }
})

test('doneWhen 命令式验真失败 → 继续下一轮；上限耗尽收尾', async () => {
  const k = makeKernel()
  try {
    await k.waitFor((e) => e.type === 'system' && e.subtype === 'init')
    k.send({
      type: 'user', message: { role: 'user', content: '修 bug' },
      loop: { count: 2, doneWhen: [{ type: 'cmd', run: 'node -e "process.exit(1)"' }] },
    })
    const end = await k.waitFor((e) => e.type === 'loop' && e.state === 'end', 20_000)
    assert.ok(end)
    assert.equal(end.reason, 'completed', '验证始终失败 → 走次数耗尽')
    const iters = k.events.filter((e) => e.type === 'loop' && e.state === 'iter')
    assert.ok(iters.some((e) => e.verify && e.verify.passed === false), 'iter 帧应带 verify 摘要')
  } finally { k.cleanup() }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test kernel-tests/loop-e2e.test.mjs`
Expected: FAIL（`end.reason` 有但缺 `verify` 字段 / `loop_result` 无回执——接线未做）

- [ ] **Step 3: 实现 cli 接线**

3a. import（`kernel/cli.mjs:27-33` 区）加：

```js
import { createLoopController } from './loop.mjs'
import { parseLoopDirective } from './loop-commands.mjs'
```

3b. 替换 `kernel/cli.mjs:865-866` 的 `loopState` 声明为控制器（保留 `loopState` 变量名做兼容判据，指向控制器状态）：

```js
  // loop 运行时（2026-09-14 抽模块）：状态机/预算/无进展/持久化/指令族集中在
  // kernel/loop.mjs。PONOS_LOOP_LEGACY=1 为逃生开关（回退内联旧路径，验收后移除）。
  const loop = createLoopController({
    wire, engine, store, configDir, sessionId, cwd: args.addDirs[0] || '', env: process.env,
  })
  const LOOP_LEGACY = process.env.PONOS_LOOP_LEGACY === '1'
  // --resume：恢复未终结 loop（崩溃/中断断点续跑）
  if (args.resume) { try { loop.load() } catch { /* 加载失败按新会话处理 */ } }
```

3c. `handleUser` 内 start 登记（`kernel/cli.mjs:896-905`）替换为：

```js
    // loop 初始化：首个带 loop 字段的消息进入时登记（内部推进消息已 active，跳过）
    const loopMsg = msg?.loop
    if (loopMsg && !loop.isActive()) {
      loop.start({
        count: loopMsg.count ?? null,
        until: String(loopMsg.until || ''),
        everyMs: Number(loopMsg.everyMs) || 0,
        fresh: loopMsg.fresh === true,
        goal: String(loopMsg.goal || ''),
        doneWhen: Array.isArray(loopMsg.doneWhen) ? loopMsg.doneWhen : [],
        maxCostUsd: Number(loopMsg.maxCostUsd) || 0,
        maxSteps: Number(loopMsg.maxSteps) || 0,
        maxWallMs: Number(loopMsg.maxWallMs) || 0,
        prompt: content,
      })
    }
```

3d. 轮末推进（`kernel/cli.mjs:1002-1030` 的 `if (loopState.active) { … }` 整块）替换为：

```js
      // loop 推进（轮次已完成）：控制器统一决策（预算/无进展/验证/次数）
      if (loop.isActive()) {
        let decision = { action: 'wait', delayMs: 0, rationale: '' }
        try {
          decision = await loop.onTurnEnd({ outcome: turnOutcome })
        } catch (e) {
          log.error('loop onTurnEnd failed', e) // 决策异常不阻断：按不推进处理
        }
        if (decision.action === 'next') {
          if (decision.delayMs > 0) {
            setTimeout(() => {
              const p = loop.nextPayload(loopStateUntil())
              state.queue.unshift({ message: p.message, loop: p.loop, skipMemoryCapture: true })
              if (!state.turnActive) { const n = state.queue.shift(); if (n) void handleUser(n) }
            }, decision.delayMs)
          } else {
            // fresh：第 1 轮完成后设窗口起点，第 2 轮请求面只含本轮之后内容
            if (loop.status().fresh && loop.status().index === 1) engine.setFreshWindow()
            const p = loop.nextPayload(loopStateUntil())
            state.queue.unshift({ message: p.message, loop: p.loop, skipMemoryCapture: true })
          }
        }
      }
```

配套 `loopStateUntil()`：控制器不持有 `--until`（判定在 cli 侧用 `judgeUntil`），故 cli 保存一份：

```js
  // --until 目标由 cli 持有（judgeUntil 调用点在 cli）；控制器只管轮次/预算/验证
  let loopUntil = ''
```

并在 3c 的 `loop.start({...})` 之前加 `loopUntil = String(loopMsg.until || '')`；`loopStateUntil()` 实现为 `() => loopUntil`。

> **注意**：既有 `--until` 判定逻辑（原 `:1010-1015` 的 `engine.judgeUntil` + `wire.loop('iter', {judged, reason})`）要**保留**在 cli 侧，但改为在 `decision.action === 'next'` 且 `loopUntil` 非空时先判定：

```js
        if (decision.action === 'next' && loopUntil) {
          let j = null
          try { j = await engine.judgeUntil({ target: loopUntil }) } catch { j = { done: false, error: true } }
          wire.loop('iter', { index: loop.status().index, total: loop.status().count, judged: j?.done === true, reason: j?.reason || '', error: !!j?.error })
          if (j?.done) { loop.stop('until_hit'); decision = { action: 'stop', delayMs: 0, rationale: 'until_hit' } }
          else if (j?.error) { loop.stop('judge_error'); decision = { action: 'stop', delayMs: 0, rationale: 'judge_error' } }
        }
```

3e. cancel 路径（`kernel/cli.mjs:1156-1160`）替换为 `loop.stop('cancelled')`。

3e-2. **轮次 outcome 采集**（无进展指纹与成本累计的数据来源）：
当前 `kernel/cli.mjs:958` 为 `await engine.runTurn({ content, msg })` 且**忽略返回值**；而
`engine.runTurn` 现返回 `{ usage, model, text, durationMs }`，**不含 `toolDigest`**
（`kernel/engine.mjs:2876`，内部 `outcome` 有该字段）。故需：

① `kernel/engine.mjs:2876` 的 return 补 `toolDigest`（只增字段，向后兼容）：
```js
      return { usage: outcome.usage, model: outcome.model, text: outcome.text, durationMs, toolDigest: outcome.toolDigest }
```
② cli 在 `handleUser` 的 try 之前声明 `let turnOutcome = null`，把 `:958` 改为：
```js
      turnOutcome = await engine.runTurn({ content, msg })
```
③ 轮末推进（3d）使用 `turnOutcome`（已按此订正）。

3f. stdin 路由（`kernel/cli.mjs:1247` 的 `if (parsed.type === 'user')` 分支**之前**）加 `loop_command` 分支——抽为 `handleLoopOp(op, args, requestId)` 复用：

```js
    if (parsed.type === 'loop_command') {
      // 指令族（bridge 转译 / TUI 直发）：status/pause/resume/stop/budget/approve/inject/rollback/replay/memory
      const { op, args: opArgs = [], requestId } = parsed
      wire.system('loop_result', { requestId, op, ...handleLoopOp(op, opArgs) })
      return
    }
```

`handleLoopOp` 实现（放在 `handleUser` 之前）：

```js
  function handleLoopOp(op, opArgs = []) {
    try {
      switch (op) {
        case 'status': { const st = loop.status(); try { wire.loop('status', { ...st }) } catch { /* 静默 */ } return { ok: true, text: loop.formatStatus() } }
        case 'pause': loop.pause(); return { ok: true, text: '已请求暂停（当前轮跑完生效）' }
        case 'resume': case 'approve': {
          const wasActive = loop.isActive()
          loop.resume()
          // 恢复后需重新投递下一轮：暂停/挂起都发生在"轮已结束"的边界，控制器不会自行
          // 推进（其 onTurnEnd 只在轮末被调用），故此处补投递，否则恢复后静默停住。
          if (wasActive) {
            const p = loop.nextPayload(loopUntil)
            state.queue.unshift({ message: p.message, loop: p.loop, skipMemoryCapture: true })
            if (!state.turnActive) { const n = state.queue.shift(); if (n) void handleUser(n) }
          }
          return { ok: true, text: '已恢复' }
        }
        case 'stop': loop.stop('cancelled'); return { ok: true, text: '已停止 loop' }
        case 'budget': {
          const patch = {}
          for (let i = 0; i < opArgs.length; i++) {
            const a = opArgs[i]
            if (a === '--max-cost') patch.maxCostUsd = Number(opArgs[++i]) || 0
            else if (a === '--max-steps') patch.maxSteps = Number(opArgs[++i]) || 0
            else if (a === '--max-wall') patch.maxWallMs = Number(opArgs[++i]) || 0
          }
          if (Object.keys(patch).length) loop.setBudget(patch)
          const b = loop.status().budget
          return { ok: true, text: `预算：成本上限 ${b.maxCostUsd || '不限'} USD，步数上限 ${b.maxSteps || '不限'}，墙钟上限 ${b.maxWallMs ? Math.round(b.maxWallMs / 1000) + 's' : '不限'}` }
        }
        case 'inject': loop.inject(opArgs.join(' ')); return { ok: true, text: '已注入补充信息' }
        case 'rollback': { const r = loop.rollback(); return { ok: r.ok !== false, text: r.ok ? `已登记回滚点（需 /loop approve 确认执行）` : String(r.error) } }
        case 'replay': return { ok: true, text: loop.replay(Number(opArgs[opArgs.indexOf('--last') + 1]) || 10) }
        case 'memory': return { ok: true, text: loop.memory() }
        default: return { ok: false, text: `未知 loop 指令：${op}` }
      }
    } catch (e) { return { ok: false, text: `指令执行失败：${e?.message || String(e)}` } }
  }
```

3g. 运行中的斜杠文本（TUI 进程内直发）在 `handleUser` 开头拦截：

```js
    // 进程内斜杠文本（TUI）：/loop 指令族经同一路由（GUI 路径由 bridge 转译为 loop_command）
    if (!LOOP_LEGACY) {
      const d = parseLoopDirective(content)
      if (d && d.kind === 'op') {
        wire.system('loop_result', { op: d.op, ...handleLoopOp(d.op, d.args) })
        return
      }
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test kernel-tests/loop-e2e.test.mjs && node --test kernel-tests/*.test.mjs`
Expected: 新测试 PASS；全量 kernel-tests 绿（既有 loop/guard/subagent 测试不受影响）。

- [ ] **Step 5: Commit**

```bash
git add kernel/cli.mjs kernel/protocol.mjs kernel-tests/loop-e2e.test.mjs
git commit -m "feat/loop-runtime: Task4 cli 接线——委托 LoopController + loop_command 指令族路由 + resume 恢复 + e2e 测试"
```

---

### Task 5: `server/bridge.mjs` 转译 — 打通 GUI（关键路径）

**Files:**
- Modify: `server/bridge.mjs:2975-2980`（GUI send 写内核路径前置换判定）、ws onmessage 加 `loop-command` case
- Create: `server/loop-translate.mjs`
- Test: `server/loop-translate.test.mjs`

**Interfaces:**
- Consumes: `parseLoopDirective`（`kernel/loop-commands.mjs`——纯函数零依赖，直 import 安全，不引入跨进程耦合）。
- Produces: `translateLoopSend(content) → null | { type:'user', message, loop } | { type:'loop_command', op, args }`；ws 入站新增 `{ type:'loop-command', sessionId, op, args }`。

- [ ] **Step 1: 写失败测试**

Create `server/loop-translate.test.mjs`：

```js
// bridge /loop 转译：GUI 文本 → loop 载荷 / loop_command（零回归锁②）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translateLoopSend } from './loop-translate.mjs'

test('GUI 旧语法 /loop 10m X → loop 载荷（everyMs 语义，非次数）', () => {
  const t = translateLoopSend('/loop 10m 检查磁盘')
  assert.equal(t.type, 'user')
  assert.equal(t.loop.everyMs, 600_000)
  assert.equal(t.loop.count, null)
  assert.equal(t.message.content, '检查磁盘')
})

test('次数式 → loop 载荷（count 语义）', () => {
  const t = translateLoopSend('/loop 3 优化函数')
  assert.equal(t.type, 'user')
  assert.equal(t.loop.count, 3)
  assert.equal(t.message.content, '优化函数')
})

test('完整参数 → loop 载荷字段齐备', () => {
  const t = translateLoopSend('/loop --goal G --done "pytest x" --max-cost 2 修 bug')
  assert.equal(t.loop.goal, 'G')
  assert.deepEqual(t.loop.doneWhen, [{ type: 'cmd', run: 'pytest x' }])
  assert.equal(t.loop.maxCostUsd, 2)
  assert.equal(t.message.content, '修 bug')
})

test('指令族 → loop_command', () => {
  assert.deepEqual(translateLoopSend('/loop status'), { type: 'loop_command', op: 'status', args: [] })
  assert.deepEqual(translateLoopSend('/loop stop 预算 不够'), { type: 'loop_command', op: 'stop', args: ['预算', '不够'] })
})

test('零回归锁②：普通文本 → null（原样直通，不吞输入）', () => {
  assert.equal(translateLoopSend('帮我修 bug'), null)
  assert.equal(translateLoopSend('/other x'), null)
  assert.equal(translateLoopSend(''), null)
  assert.equal(translateLoopSend('/loop'), null)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/loop-translate.test.mjs`
Expected: FAIL（`server/loop-translate.mjs` 不存在）

- [ ] **Step 3: 实现**

Create `server/loop-translate.mjs`：

```js
// server/loop-translate.mjs —— GUI → 内核 /loop 指令转译（打通点，spec 5.5）
// ---------------------------------------------------------------------------
// 背景：GUI（ScheduleGuide / 用户手输）发的是**纯文本** `/loop 10m <任务>`，而内核
// cli.mjs 无斜杠指令解析 → 该文本被当作普通 prompt 交给模型，loop 状态机永不启动
// （断链根因，2026-09-14 修复）。
// 本模块在 bridge 的 GUI send 热路径前置拦截并转译为内核原生载荷：
//   start 形式 → { type:'user', message, loop:{…} }（走内核既有 loop 通道）
//   指令族     → { type:'loop_command', op, args }（走 Task4 新增路由）
// 解析复用 kernel/loop-commands.mjs（纯函数、零 IO、无副作用 → 直 import 安全）。
import { parseLoopDirective } from '../kernel/loop-commands.mjs'

export function translateLoopSend(content) {
  let d = null
  try { d = parseLoopDirective(content) } catch { d = null } // 解析异常 = 非指令（直通）
  if (!d) return null
  if (d.kind === 'op') return { type: 'loop_command', op: d.op, args: d.args }
  const o = d.opts
  return {
    type: 'user',
    message: { role: 'user', content: o.prompt || o.goal || o.until || '' },
    loop: {
      count: o.count, until: o.until, everyMs: o.everyMs, fresh: o.fresh,
      goal: o.goal, doneWhen: o.doneWhen,
      maxCostUsd: o.maxCostUsd, maxSteps: o.maxSteps, maxWallMs: o.maxWallMs,
    },
  }
}
```

- [ ] **Step 4: bridge 接线**

4a. 顶部 import 加：

```js
import { translateLoopSend } from './loop-translate.mjs'
```

4b. GUI send 写内核处（`server/bridge.mjs:2975-2980`）改为：

```js
        // /loop 指令转译（打通点）：GUI 发纯文本 `/loop …` → 内核原生 loop 载荷/指令。
        // 非指令文本 translateLoopSend 返回 null → 原路径直通（零回归锁②）。
        const loopMsg = translateLoopSend(msg.prompt)
        session.proc.stdin.write(JSON.stringify(
          loopMsg || {
            type: 'user',
            message: { role: 'user', content: msg.prompt },
            ...(msg.priority ? { priority: msg.priority } : {}),
            ...(msg.uuid ? { uuid: msg.uuid } : {}),
          },
        ) + '\n')
        // loop_command 无轮次产出：不得置轮次活跃态（否则 UI 悬挂）
        if (!loopMsg || loopMsg.type !== 'loop_command') session._turnActive = true
```

> 实现时把紧随其后的既有 `session._turnActive = true` 删掉（避免重复置位）；若其前后还有 arm 首字节等待条逻辑，`loop_command` 分支需同步跳过。

4c. ws onmessage 加 `loop-command` 入站分支（GUI 指令族按钮通道）：

```js
      } else if (msg.type === 'loop-command') {
        const session = getSession(msg.sessionId)
        if (session?.proc?.stdin) {
          session.proc.stdin.write(JSON.stringify({
            type: 'loop_command', op: String(msg.op || ''), args: Array.isArray(msg.args) ? msg.args : [], requestId: msg.requestId,
          }) + '\n')
        }
      }
```

- [ ] **Step 5: 跑测试 + 全量 server 测试**

Run: `node --test server/loop-translate.test.mjs && npm test`
Expected: 新测试 PASS；`npm test` 全绿。

- [ ] **Step 6: Commit**

```bash
git add server/loop-translate.mjs server/bridge.mjs server/loop-translate.test.mjs
git commit -m "feat/loop-runtime: Task5 bridge /loop 文本转译（打通 GUI→内核通道）+ 零回归锁②测试"
```

---

### Task 6: GUI — 帧归约扩展 + 状态面板 + 控制按钮

**Files:**
- Modify: `src/stores/chatStore.ts`（`LoopState` 类型字段扩展）
- Modify: `src/hooks/useYFWCLI.ts:1048-1085`（loop 帧归约扩字段 + 导出 `sendLoopCommand`）
- Modify: `src/components/chat/LoopStatusBar.tsx:12-15`（reason 值域补全 + goal/cost 展示）
- Modify: `src/i18n/translations/zh-CN.ts` / `en-US.ts`（loopStatus / loopPanel 文案）
- Create: `src/components/chat/LoopPanel.tsx`（状态面板 + 控制按钮）
- Modify: `src/components/chat/ChatWindow.tsx:307`（挂载 LoopPanel）
- Modify: `src/components/chat/ScheduleGuide.tsx:46`（改发结构化 `--every` 语法）

**Interfaces:**
- Consumes: wire `{type:'loop', state, …}`（Task 4 扩展字段）、`system/loop_result` 回执、bridge `loop-command` 入站（Task 5）。
- Produces: `sendLoopCommand(conversationId, op, args?)`；`LoopState` 扩展字段 `{ goal?, status?, costUsd?, steps?, everyMs?, noProgressStreak?, verify?, pendingApproval? }`。

- [ ] **Step 1: 扩展 chatStore 类型**

`src/stores/chatStore.ts` 的 `LoopState` 接口：

```ts
export interface LoopState {
  active: boolean
  index: number
  total: number
  until?: string
  fresh?: boolean
  reason?: 'completed' | 'until_hit' | 'cancelled' | 'judge_error'
         | 'verify_hit' | 'budget_exceeded' | 'no_progress' | 'failed'
  judgeReason?: string
  // 2026-09-14 loop 运行时扩展
  goal?: string
  status?: 'running' | 'pausing' | 'paused' | 'awaiting_approval' | 'verifying'
         | 'done' | 'budget_exceeded' | 'cancelled'
  costUsd?: number
  steps?: number
  everyMs?: number
  noProgressStreak?: number
  verify?: { passed: boolean; results: Array<{ run?: string; type: string; ok: boolean }> }
  pendingApproval?: { kind: string; detail?: string }
}
```

- [ ] **Step 2: 帧归约扩展 + sendLoopCommand**

`src/hooks/useYFWCLI.ts` 的 `if (type === 'loop')` 分支（`:1048` 起）：
- `start` 分支补 `goal` / `everyMs` / `status: 'running'`；
- `iter` 分支补 `steps` / `costUsd` / `noProgressStreak` / `verify` / `pendingApproval`；
- `end` 分支的 `validEnd` 集合扩为 8 值（与 Task 4 `endReason` 对齐）；
- 新增 `status` 分支：

```ts
      } else if (loopState === 'status') {
        chat.setLoopState(sid, {
          status: (typeof d.status === 'string' ? d.status : undefined) as LoopState['status'],
          goal: typeof d.goal === 'string' && d.goal ? d.goal : undefined,
          costUsd: typeof d.costUsd === 'number' ? d.costUsd : undefined,
          steps: typeof d.steps === 'number' ? d.steps : undefined,
          everyMs: typeof d.everyMs === 'number' ? d.everyMs : undefined,
          noProgressStreak: typeof d.noProgress?.streak === 'number' ? d.noProgress.streak : undefined,
          pendingApproval: (d.pendingApproval as LoopState['pendingApproval']) ?? undefined,
          active: ['running', 'pausing', 'awaiting_approval', 'verifying'].includes(String(d.status)),
        })
      }
```

新增导出函数：

```ts
/** loop 指令族：经 bridge 转译为内核 loop_command（回执走 system/loop_result）。 */
export function sendLoopCommand(conversationId: string, op: string, args: string[] = []) {
  const target = conversationId || lastSessionId || 'default'
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'loop-command', sessionId: target, op, args }))
  }
}
```

> 回执展示：`system/loop_result` 帧在 `useYFWCLI` 的 system 分支里（`subtype === 'loop_result'`）推一条本地 assistant/system 消息（`text` 为 `loop status/replay/memory` 的可读文本），使 `/loop status` 有可见反馈。

- [ ] **Step 3: LoopStatusBar 扩展**

`src/components/chat/LoopStatusBar.tsx:12-15` 的 `REASON_KEY` 覆盖 8 值：

```ts
const REASON_KEY: Record<string, string> = {
  completed: 'loopStatus.reasonCompleted',
  until_hit: 'loopStatus.reasonUntilHit',
  cancelled: 'loopStatus.reasonCancelled',
  judge_error: 'loopStatus.reasonJudgeError',
  verify_hit: 'loopStatus.reasonVerifyHit',
  budget_exceeded: 'loopStatus.reasonBudget',
  no_progress: 'loopStatus.reasonNoProgress',
  failed: 'loopStatus.reasonFailed',
}
```

并在轮次行下方补 `goal` 摘要与 `costUsd`（成本仅在 `> 0` 时显示）。

- [ ] **Step 4: i18n 文案**

`zh-CN.ts` / `en-US.ts` 的 `loopStatus` 命名空间补 `reasonVerifyHit` / `reasonBudget` / `reasonNoProgress` / `reasonFailed` / `goal` / `cost`，并新增 `loopPanel` 命名空间：`title` / `goal` / `progress` / `steps` / `cost` / `noProgress` / `verify` / `verifyPass` / `verifyFail` / `pause` / `resume` / `stop` / `approve` / `refresh`。

- [ ] **Step 5: LoopPanel 面板**

Create `src/components/chat/LoopPanel.tsx`：

```tsx
/**
 * loop 状态面板（2026-09-14）：目标/轮次/步数/成本/无进展/验证结果 + 控制按钮。
 * 数据源：chatStore.loopStates[conversationId]（wire loop 帧归约）；操作经 sendLoopCommand →
 * bridge loop-command 入站 → 内核 loop_command 路由（Task4/5）。
 */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chatStore'
import { sendLoopCommand } from '@/hooks/useYFWCLI'

export function LoopPanel({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation()
  const loop = useChatStore((s) => s.loopStates[conversationId])
  if (!loop || (!loop.active && !loop.reason)) return null
  const st = loop.status
  return (
    <div className="mx-4 mb-2 space-y-2 rounded-lg border border-border bg-card p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium">{t('loopPanel.title')}</span>
        <span className="text-muted-foreground">{st ?? (loop.active ? 'running' : loop.reason)}</span>
      </div>
      {loop.goal && <div>{t('loopPanel.goal')}{loop.goal}</div>}
      <div>
        {t('loopPanel.progress', { current: loop.index, total: loop.total ?? '∞' })} ·{' '}
        {t('loopPanel.steps', { n: loop.steps ?? 0 })} · {t('loopPanel.cost', { usd: (loop.costUsd ?? 0).toFixed(4) })}
      </div>
      {!!loop.noProgressStreak && <div className="text-amber-600">{t('loopPanel.noProgress', { n: loop.noProgressStreak })}</div>}
      {loop.verify && (
        <div className={loop.verify.passed ? 'text-emerald-600' : 'text-destructive'}>
          {t('loopPanel.verify')}{loop.verify.passed ? t('loopPanel.verifyPass') : t('loopPanel.verifyFail')}
          {loop.verify.results?.length
            ? ` · ${loop.verify.results.map((r) => `${r.run ?? r.type}:${r.ok ? '✓' : '✗'}`).join(' ')}`
            : ''}
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {loop.active && st !== 'paused' && (
          <Button size="sm" variant="outline" onClick={() => sendLoopCommand(conversationId, 'pause')}>{t('loopPanel.pause')}</Button>
        )}
        {(st === 'paused' || st === 'awaiting_approval') && (
          <Button size="sm" onClick={() => sendLoopCommand(conversationId, 'resume')}>{t('loopPanel.resume')}</Button>
        )}
        {loop.pendingApproval && (
          <Button size="sm" variant="outline" onClick={() => sendLoopCommand(conversationId, 'approve')}>{t('loopPanel.approve')}</Button>
        )}
        {loop.active && (
          <Button size="sm" variant="outline" onClick={() => sendLoopCommand(conversationId, 'stop')}>{t('loopPanel.stop')}</Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => sendLoopCommand(conversationId, 'status')}>{t('loopPanel.refresh')}</Button>
      </div>
    </div>
  )
}
```

挂载：`src/components/chat/ChatWindow.tsx:307` 的 `LoopStatusBar` 之后加 `<LoopPanel conversationId={conversationId} />`（面板已含自身空态返回 null，无需额外条件）。

- [ ] **Step 6: ScheduleGuide 改发结构化语法**

`src/components/chat/ScheduleGuide.tsx:46` 改为：

```ts
      // 结构化 loop 语法：间隔走 --every（旧写法 `/loop ${iv} ${t}` 中的 10m 会被
      // 旧解析器 Number() 成 NaN 静默丢弃；2026-09-14 归一为 --every）
      send(conversationId, `/loop --every ${iv} ${t}`)
```

- [ ] **Step 7: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run build 2>&1 | tail -20`
Expected: 类型检查与构建通过。

- [ ] **Step 8: 手工冒烟（GUI 实机）**

1. ScheduleGuide 选「5 分钟」+ 任务 → 发送 → LoopPanel 出现且显示目标/持续态（**不再**退化为 0/3 轮）；
2. 点「暂停」→ 状态 paused、轮次停推；点「恢复」→ 继续推进；
3. 输入 `/loop status` → 面板/消息区显示成本与轮次（成本 > 0）；
4. 点「停止」→ `end(cancelled)`，面板 active 收起；
5. `/loop budget --max-cost 0.0001` → 下一轮 `budget_exceeded` 收尾并显示原因文案。

- [ ] **Step 9: Commit**

```bash
git add src/stores/chatStore.ts src/hooks/useYFWCLI.ts src/components/chat/LoopPanel.tsx src/components/chat/LoopStatusBar.tsx src/components/chat/ChatWindow.tsx src/components/chat/ScheduleGuide.tsx src/i18n/translations/zh-CN.ts src/i18n/translations/en-US.ts server/bridge.mjs
git commit -m "feat/loop-runtime: Task6 GUI——帧归约扩展 + LoopPanel 状态面板与暂停/恢复/停止控制 + ScheduleGuide 结构化语法"
```

---

### Task 7: 文档 + 全量回归 + 端到端验证

**Files:**
- Modify: `docs/bridge-contract.md`（loop 帧扩展字段 + `loop_command` 入站 + `loop_result` 出站 + ws `loop-command`）
- Modify: `docs/manual/YFWorking产品使用说明书.md:250,476,809`（`/loop` 完整语法与指令族）
- Modify: `docs/superpowers/specs/2026-09-14-loop-command-runtime-design.md`（追加实施结论）

- [ ] **Step 1: bridge-contract 补契约**

在 `docs/bridge-contract.md` 的入站章节补 `loop_command`（`{type,op,args,requestId}`）与 ws `loop-command`；出站章节补 `loop_result` 回执与 loop 帧扩展字段（照 spec 第 6 节表逐字段列出）。

- [ ] **Step 2: 使用说明书更新**

`docs/manual/YFWorking产品使用说明书.md` 三处（`:250` 指令表 `/loop` 行、`:476` 循环任务段落、`:809` 命令表）改为完整语法与指令族清单：

```
/loop [次数] [--until <目标>] [--every <间隔>] [--fresh] [--done <命令>] [--goal <目标>]
      [--max-cost <USD>] [--max-steps <N>] [--max-wall <时长>] [prompt...]
/loop start|status|pause|resume|stop|budget|approve|inject|rollback|replay|memory
```

- [ ] **Step 3: 全量回归**

Run: `node --test kernel-tests/*.test.mjs && npm test`
Expected: 全绿。

- [ ] **Step 4: 端到端手动验证（GUI 实机，记录结果）**

①GUI `/loop 10m <任务>` 真跑起 loop（此前为空转）；② `--done` 命令式验真拦住"自认完成"（构造必然失败的 `--done` → 轮次继续且面板显示 ✗）；③ 进程重启后 `--resume` 恢复未终结 loop（`load()` 返回 true 且发 `start{resumed:true}`）；④ 预算硬停生效；⑤ 停止按钮即时终止。

- [ ] **Step 5: 移除逃生开关（验收通过后）**

删除 `kernel/cli.mjs` 的 `LOOP_LEGACY` 分支与旧内联路径残留，重跑全量回归。

- [ ] **Step 6: Commit**

```bash
git add docs/bridge-contract.md docs/manual/YFWorking产品使用说明书.md docs/superpowers/specs/2026-09-14-loop-command-runtime-design.md kernel/cli.mjs
git commit -m "docs(loop-runtime): Task7 契约与说明书更新 + 端到端验收结论"
```

---

## 验收门槛（全部 Task 完成后）

- 全量 `node --test kernel-tests/*.test.mjs` 绿（含 3 把零回归锁显式断言）。
- `npm test` 绿（新增 `server/loop-translate.test.mjs`）。
- `npx tsc --noEmit` + `npm run build` 通过。
- GUI 实机五项验证通过（Task 6 Step 8 / Task 7 Step 4）。
- **核心验收**：GUI 发出的 `/loop …` 确实驱动内核 loop 状态机（修复断链）——以 `wire.loop` 帧序列 `start → iter… → end` 为证。

## 风险备注

- **Task 4** 是唯一触碰既有 loop 运行路径的改动 → 三把零回归锁 + 全量门槛；`PONOS_LOOP_LEGACY=1` 逃生开关兜底。
- **Task 5** 若 `_turnActive` 守卫遗漏，`loop_command` 会误置轮次活跃态（UI 悬挂：发送按钮长转）——测试须覆盖"发完指令族后仍可正常发下一条普通消息"。
- **Task 3** 的 `snapshot()` 在 ESM 下不可用 `require`，必须改为顶层 `import { execFileSync } from 'node:child_process'`。
- 无进展指纹以 `<工具名>:<路径>` / `<工具名>:<错误前缀>` 构成：若某轮仅改文件内容而未新增路径，指纹可能判为"无进展"——这是保守取向（宁可提前询问人工，也不静默烧钱），如需放宽可调 `PONOS_LOOP_NOPROGRESS_N`。

