// ENG-03 修复验证（P2）：`--fresh` 与 `--until` 打架 —— 判词器看裁剪窗口，看不到上一轮目标。
//
// 【缺陷（engine.mjs:3306，修前）】
//   ```js
//   async judgeUntil({ target, maxTokens = 512 }) {
//     const history = deriveHistory().slice(-20)   // ← deriveHistory 会应用 --fresh 的 historySkip
//     ...
//   }
//   ```
//   `--fresh` 的语义是「**请求面**跳过 fresh 之前的消息」（`setFreshWindow()` 把 `historySkip`
//   设为当前消息数，`deriveHistory()` 据此 `base.slice(historySkip)`）。
//   而判词器**复用同一个 `deriveHistory()`** ⇒ 第 2 轮起判词只能看到 fresh 之后的消息，
//   **看不到上一轮的目标与产出** ⇒ 终止条件判定失去依据：
//     · 目标其实已达成 → 判词说"未达成" → **无限循环**（烧预算）
//     · 或反过来误判"已达成" → 提前收口
//
// 【修法（用户已拍板：方案① —— 只裁模型侧，判词读全量历史）】
//   把「判词消息组装」抽成纯函数 `buildJudgeMessages({ history, target })`
//   （`kernel/loop-judge.mjs`），engine 侧传**全量**历史（不经 `historySkip` 裁剪）。
//   判词是**独立的一次小调用**（maxTokens 512），与主对话的上下文裁剪无关：
//   裁剪主对话是为了省 token，而判词必须看到"目标 + 达成证据"才能判定。
//
//   ★ 仍保留 `.slice(-20)` 作为上界：判词不需要整段历史，但**必须能跨过 fresh 边界**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildJudgeMessages, JUDGE_HISTORY_LIMIT } from '../kernel/loop-judge.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENGINE = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const msg = (role, content) => ({ role, content })

test('★ ENG-03：判词消息必须含目标（显式传入，不依赖历史里有）', () => {
  const out = buildJudgeMessages({ history: [], target: '把 README 补上安装步骤' })
  const last = out[out.length - 1]
  assert.equal(last.role, 'user', '最后一条必须是 user（判词指令）')
  assert.match(last.content, /把 README 补上安装步骤/, '目标文本必须出现在判词指令里')
  assert.match(out[0].content, /JSON/i, '首条必须是系统提示且要求输出 JSON')
})

test('★★ ENG-03：历史里的**上一轮产出**必须进入判词（跨过 fresh 边界也不许丢）', () => {
  // 模拟"fresh 之后的窗口"里只有新一轮开头，而达成证据在更早位置
  const history = [
    msg('user', '目标：把 README 补上安装步骤'),
    msg('assistant', '已补上「## 安装」小节，含 npm i 与 dev 两条命令。'),   // ← 达成证据
    msg('user', '（fresh 后新一轮开始）'),
  ]
  const out = buildJudgeMessages({ history, target: '把 README 补上安装步骤' })
  const all = out.map((m) => String(m.content)).join('\n')
  assert.match(all, /已补上「## 安装」小节/,
    '达成证据必须在判词输入里 —— 修前 judgeUntil 用 deriveHistory（受 --fresh 裁剪），'
    + '第 2 轮起看不到上一轮产出 ⇒ 目标已达成也会被判"未达成" ⇒ **无限循环烧预算**')
})

test('★ ENG-03：判词历史必须有上界（不能把整段历史塞进去）', () => {
  const many = Array.from({ length: 100 }, (_, i) => msg('user', `m${i}`))
  const out = buildJudgeMessages({ history: many, target: 'x' })
  // 系统提示 1 + 历史 ≤ LIMIT + 判词指令 1
  assert.equal(out.length, 1 + JUDGE_HISTORY_LIMIT + 1,
    `判词消息数应为 1 + ${JUDGE_HISTORY_LIMIT} + 1，实得 ${out.length}`)
  // 且取的是**最近**的（末尾）
  const histTexts = out.slice(1, -1).map((m) => m.content)
  assert.equal(histTexts[histTexts.length - 1], 'm99', '上界截取必须保留最近的（末尾），不是最早的')
})

test('★ ENG-03：system 角色消息不得进判词历史（避免与判词系统提示混淆）', () => {
  const history = [
    msg('system', '你是助手…'),
    msg('user', '目标：X'),
    msg('assistant', '做完了'),
  ]
  const out = buildJudgeMessages({ history, target: 'X' })
  const histPart = out.slice(1, -1)
  assert.ok(!histPart.some((m) => m.role === 'system'),
    '判词历史里不得混入 system 消息 —— 判词自己已有 system 提示，混入会让模型分不清哪条规则优先')
})

test('★★ ENG-03：engine 的 judgeUntil 不得再用 fresh 裁剪过的历史', () => {
  const i = ENGINE.indexOf('async judgeUntil(')
  assert.ok(i > -1, '必须有 judgeUntil')
  const body = ENGINE.slice(i, i + 1200)
  assert.ok(!/deriveHistory\(\)/.test(body),
    'judgeUntil 不得使用 deriveHistory() —— 它会应用 --fresh 的 historySkip，'
    + '导致判词看不到上一轮目标/产出（本缺陷原形态）')
  assert.match(body, /buildJudgeMessages\(|deriveFullHistory\(/,
    'judgeUntil 必须用全量历史（buildJudgeMessages + 不裁剪的历史访问器）')
})

test('★ ENG-03：主对话侧仍必须受 --fresh 裁剪（不能把功能改坏）', () => {
  // 这是反向守卫：修法只能改判词侧，主对话的 fresh 语义必须逐字保留
  const i = ENGINE.indexOf('function deriveHistory()')
  assert.ok(i > -1, '必须有 deriveHistory')
  const body = ENGINE.slice(i, i + 500)
  assert.match(body, /historySkip/,
    'deriveHistory 必须继续应用 historySkip —— 主对话的 --fresh 裁剪是本项功能本体，不得被顺手删掉')
})
