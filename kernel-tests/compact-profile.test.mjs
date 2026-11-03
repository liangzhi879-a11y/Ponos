// 压缩档位（profile）机制回归 —— 2026-10-26
//
// 【背景】用户实测：16 轮对话落地 40 次摘要，上下文只占窗口 12%（est 5–7 万 vs 实测 12.5 万
//   token，window=1M）。根因不是"窗口配错"，而是压缩阈值**锚定能力上限**：token 门 = 80 万
//   永远不触发，退化成一维条数门；而条数门 120 与"摘要后保留 60 条"之间的余量只有 60 条
//   ≈ 30 次工具调用，远小于单轮实际的 86 次 ⇒ 每轮必然多次摘要。
//
// 【本文件钉的是】档位机制的四条不变量：
//   ① 自动判档：1M→long-task、200K→balanced、32K→small-window、**local 优先于窗口**；
//   ② 显式/非法值：非法值必须回落到自动档**并带 requested**（不静默）；
//   ③ 存量兼容：200K 窗口仍得 120、默认档的 ratio 逐字不变、M1/M2 在默认档**关闭**；
//   ④ 参数真源补齐：8 个参数全部随 context 下发（此前 4 个配了也不生效）。
//
// 【为什么 ③ 要单独立断言】`kernel-tests/compact-count-gate.test.mjs:20` 与多条运行时用例
//   依赖"默认路径逐字不变"。改 COMPACT_MAX_MESSAGES_DIVISOR 或默认档参数时，本文件先红，
//   比等到那批老用例红更好定位。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPACT_PROFILES,
  COMPACT_PROFILE_NAMES,
  COMPACT_MAX_MESSAGES_DIVISOR,
  autoCompactProfile,
  resolveCompactProfile,
  resolveCompactSettings,
  extractKeyInfo,
  keyInfoBlock,
} from '../kernel/compact.mjs'

// —— ① 自动判档 ——
test('autoCompactProfile：1M 窗口 → long-task', () => {
  assert.equal(autoCompactProfile(1_048_576, {}), 'long-task')
})

test('autoCompactProfile：200K 窗口 → balanced', () => {
  assert.equal(autoCompactProfile(200_000, {}), 'balanced')
})

test('autoCompactProfile：32K 窗口 → small-window', () => {
  assert.equal(autoCompactProfile(32_768, {}), 'small-window')
})

test('★ autoCompactProfile：local 画像优先于窗口大小（本地标 1M 也不进 long-task）', () => {
  // 反例后果：vLLM/Ollama 常把 context 填成 1M，按窗口判定会进 long-task ⇒ 门被放大 5 倍，
  // 而本地 prefill 慢、摘要请求本身很贵 ⇒ 恰好与 long-task 的取舍相反。
  assert.equal(autoCompactProfile(1_048_576, { PONOS_PROVIDER_PROFILE: 'local' }), 'local')
  assert.equal(autoCompactProfile(131_072, { PONOS_PROVIDER_PROFILE: 'local' }), 'local')
})

test('autoCompactProfile：非法/缺失窗口不得抛错，回落到 balanced', () => {
  assert.equal(autoCompactProfile(undefined, {}), 'balanced')
  assert.equal(autoCompactProfile(0, {}), 'balanced')
  assert.equal(autoCompactProfile(NaN, {}), 'balanced')
})

// —— ② 解析优先级与非法值 ——
test('resolveCompactProfile：显式设置压过自动判定（可把 1M 锁回 balanced）', () => {
  const r = resolveCompactProfile({ window: 1_048_576, env: { PONOS_COMPACT_PROFILE: 'balanced' } })
  assert.equal(r.profile, 'balanced')
  assert.equal(r.source, 'explicit')
})

test('★ resolveCompactProfile：非法档位名回落自动档，且必须带 requested（不静默）', () => {
  // 反例后果：`long_task`（下划线）静默回落成 balanced ⇒ 用户以为开了长任务档，
  // 实际压缩节奏没变，而日志里看不出来。
  const r = resolveCompactProfile({ window: 1_048_576, env: { PONOS_COMPACT_PROFILE: 'long_task' } })
  assert.equal(r.profile, 'long-task', '应回落到该窗口的自动档')
  assert.equal(r.source, 'fallback')
  assert.equal(r.requested, 'long_task', '必须回显用户填的原始值，否则无从排查')
})

test('★ resolveCompactProfile：原型链名字不得被当成合法档位', () => {
  // `COMPACT_PROFILES[v]` 直接取值会让 '__proto__'/'constructor' 命中真值 ⇒ 必须用
  // hasOwnProperty 判定。
  for (const bad of ['__proto__', 'constructor', 'toString']) {
    const r = resolveCompactProfile({ window: 200_000, env: { PONOS_COMPACT_PROFILE: bad } })
    assert.equal(r.source, 'fallback', `${bad} 不应被认作合法档位`)
  }
})

test('resolveCompactProfile：settings 优先于 env', () => {
  const r = resolveCompactProfile({
    window: 1_048_576,
    settings: { compact: { profile: 'small-window' } },
    env: { PONOS_COMPACT_PROFILE: 'long-task' },
  })
  assert.equal(r.profile, 'small-window')
  assert.equal(r.source, 'explicit')
})

// —— ③ 存量兼容（最关键的一组）——
test('★★ resolveCompactSettings：200K 窗口仍得 maxMessages=120（存量断言的前提）', () => {
  // kernel-tests/compact-count-gate.test.mjs:20 逐字钉着这条。除数改动最先破这里。
  assert.equal(resolveCompactSettings({ window: 200_000, settings: {}, env: {} }).maxMessages, 120)
})

test('★★ resolveCompactSettings：balanced 档的 thresholdRatio / retainRatio 与改动前逐字一致', () => {
  const s = resolveCompactSettings({ window: 200_000, settings: {}, env: {} })
  assert.equal(s.thresholdRatio, 0.8)
  assert.equal(s.retainRatio, 0.16)
})

test('★★ resolveCompactSettings：默认档 M1/M2 必须关闭（0 = 不拦）', () => {
  // 多条运行时用例期待"低 token 水位下也能 summarized"（compact-chunked / context-estimate /
  // effort-wire）。默认档若开启水位闸，这些用例会成片变红 —— 而正确修法是"新档才启用"，
  // 不是去改那批断言。
  const s = resolveCompactSettings({ window: 200_000, settings: {}, env: {} })
  assert.equal(s.escalateTokenFloor, 0, '默认档不得启用 token 水位闸')
  assert.equal(s.minSummaryIntervalCalls, 0, '默认档不得启用摘要频次护栏')
})

test('★ 条数门在 200K 边界两侧都落在下限 120（不得跳变）', () => {
  for (const w of [199_999, 200_000, 200_001]) {
    assert.equal(resolveCompactSettings({ window: w, settings: {}, env: {} }).maxMessages, 120, `window=${w}`)
  }
})

test('条数门上界：超长窗口仍封顶 600', () => {
  assert.equal(resolveCompactSettings({ window: 2_000_000, settings: {}, env: {} }).maxMessages, 600)
})

test('★ 除数常量必须让"200K→120 / 1M→600"同时成立（改它前先读这条）', () => {
  assert.equal(Math.floor(200_000 / COMPACT_MAX_MESSAGES_DIVISOR) < 120, true,
    '除数变大到 200K/divisor ≥ 120 会直接破 compact-count-gate 的存量断言')
  assert.equal(Math.floor(1_048_576 / COMPACT_MAX_MESSAGES_DIVISOR) >= 300, true,
    '除数变小到 1M/divisor < 300 会让 long-task 档失去意义')
})

// —— ④ 档位真正生效 ——
test('★ resolveCompactSettings：1M 窗口自动进 long-task，条数门 600 + 两项护栏开启', () => {
  const s = resolveCompactSettings({ window: 1_048_576, settings: {}, env: {} })
  assert.equal(s.profile, 'long-task')
  assert.equal(s.maxMessages, 600, '600 条 ≈ 300 次工具调用 ≈ 3.5 个实际轮次')
  assert.equal(s.escalateTokenFloor, 0.30)
  assert.equal(s.minSummaryIntervalCalls, 40)
  assert.equal(s.keepTargetRatio, 0.20, '摘要后保留 120 条，续航 480 条')
})

test('★ resolveCompactSettings：local 档按画像生效（128K 本地模型）', () => {
  const s = resolveCompactSettings({ window: 131_072, settings: {}, env: { PONOS_PROVIDER_PROFILE: 'local' } })
  assert.equal(s.profile, 'local')
  assert.equal(s.escalateTokenFloor, 0.35, '本地摘要更贵 ⇒ 水位门槛更高')
  assert.equal(s.minSummaryIntervalCalls, 60, '本地 prefill 慢 ⇒ 摘要间隔更长')
})

test('★ 8 个压缩参数必须全部随返回值下发（此前 4 项只能走 env，配了也不生效）', () => {
  const s = resolveCompactSettings({ window: 1_048_576, settings: {}, env: {} })
  for (const k of [
    'thresholdRatio', 'retainRatio', 'maxRetainRatio', 'keepTargetRatio',
    'maxMessages', 'toolResultBudget', 'escalateTokenFloor', 'minSummaryIntervalCalls',
  ]) {
    assert.equal(typeof s[k], 'number', `缺参数 ${k}（或类型不是 number）`)
  }
})

test('★ settings 可覆盖新增的 4 项（补的正是"配了不生效"这个缺口）', () => {
  const s = resolveCompactSettings({
    window: 1_048_576,
    settings: { compact: { keepTargetRatio: 0.5, maxRetainRatio: 0.3, escalateTokenFloor: 0.5, minSummaryIntervalCalls: 12 } },
    env: {},
  })
  assert.equal(s.keepTargetRatio, 0.5)
  assert.equal(s.maxRetainRatio, 0.3)
  assert.equal(s.escalateTokenFloor, 0.5)
  assert.equal(s.minSummaryIntervalCalls, 12)
})

test('★ escalateTokenFloor: 0 必须可显式关闭（0 是有效值，不是"未配置"）', () => {
  const s = resolveCompactSettings({ window: 1_048_576, settings: { compact: { escalateTokenFloor: 0 } }, env: {} })
  assert.equal(s.escalateTokenFloor, 0, '0 被当成未配置会让"关闭水位闸"无法表达')
})

test('maxMessages 显式配置（含 0=关闭）仍压过档位默认', () => {
  assert.equal(resolveCompactSettings({ window: 1_048_576, settings: { compact: { maxMessages: 0 } }, env: {} }).maxMessages, 0)
  assert.equal(resolveCompactSettings({ window: 1_048_576, settings: {}, env: { PONOS_COMPACT_MAX_MESSAGES: '77' } }).maxMessages, 77)
})

test('档位表自洽：四档齐全，且每档都给出 7 个参数', () => {
  assert.deepEqual([...COMPACT_PROFILE_NAMES].sort(), Object.keys(COMPACT_PROFILES).sort())
  for (const name of COMPACT_PROFILE_NAMES) {
    const P = COMPACT_PROFILES[name]
    for (const k of ['thresholdRatio', 'retainRatio', 'maxRetainRatio', 'keepTargetRatio', 'escalateTokenFloor', 'minSummaryIntervalCalls']) {
      assert.equal(typeof P[k], 'number', `${name}.${k} 缺失`)
    }
    assert.equal(typeof P.maxMessages, 'function', `${name}.maxMessages 应为函数（按窗口展开）`)
  }
})

// —— M3 工作记忆保底 ——
test('★ extractKeyInfo：保留最近真实用户任务，排除 tool_result 回灌的伪 user 消息', () => {
  // 反例后果：把 tool_result 回灌当"用户任务"，摘要开头会变成"用户要求返回 JSON"这类
  // 工具输出，而不是真正在做的任务。
  const k = extractKeyInfo([
    { role: 'user', content: '帮我修 A' },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{"ok":true}' }] },
    { role: 'user', content: '再修 B' },
  ])
  assert.deepEqual(k.userAsks, ['帮我修 A', '再修 B'])
})

test('★ extractKeyInfo：userAsks 最多 3 条、各截 200 字（防摘要请求被撑大）', () => {
  const msgs = [1, 2, 3, 4, 5].map((i) => ({ role: 'user', content: `任务${i}-` + 'x'.repeat(500) }))
  const k = extractKeyInfo(msgs)
  assert.equal(k.userAsks.length, 3)
  for (const t of k.userAsks) assert.ok(t.length <= 200, `单条应 ≤200 字，实得 ${t.length}`)
  assert.ok(k.userAsks[0].startsWith('任务3'), '应取最近 3 条（3/4/5）')
})

test('★ keyInfoBlock：任务脉络必须排在块首（摘要器对块首保留率最高）', () => {
  const block = keyInfoBlock({ todos: ['t1'], files: ['f1'], decisions: ['d1'], userAsks: ['目标 X'] })
  assert.ok(block.includes('用户任务脉络'))
  assert.ok(block.indexOf('用户任务脉络') < block.indexOf('任务清单'),
    '任务脉络若排在任务清单之后，长摘要里最先被压掉的就是它')
})

test('keyInfoBlock：无任何关键信息时返回空串（不得产出空标签块）', () => {
  assert.equal(keyInfoBlock({ todos: [], files: [], decisions: [], userAsks: [] }), '')
})
