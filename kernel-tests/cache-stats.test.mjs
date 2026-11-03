// 前缀缓存观测 · 口径层契约（2026-09-18 spec §3.1）
// ---------------------------------------------------------------------------
// 本文件锁四件事：
//   1) **三态可分辨**：`supported` 必须区分「端点不支持缓存」与「真未命中」。
//      实测依据：`<10K` 请求档 92% 的轮次"完全未命中"——其中绝大部分是本地/小请求
//      端点缓存字段恒 0（见 context.mjs requestTokens 注释）。不加区分，观测一上线
//      就在本地 vLLM 场景全站假警。
//   1b) **（2026-09-18 修订）可分辨的依据是"字段存在性"**：`supported` 语义已从
//      「本请求命中过（read+create>0）」修正为「端点具备缓存计量」，信号 = `cache_fields_reported`；
//      缺该键时退化为旧启发式（兼容手写字面量/mock）。理由：旧定义下"端点无字段"与
//      "端点有缓存但本轮未命中"在判定层**不可分**，而二者处置相反（静默 vs suspicious 候选）。
//      见 context.mjs cacheStats 头注（语义变更声明）与 api.mjs normalizeUsage。
//   2) **口径唯一**：hitRatio 分母 = input + read（与 stats.mjs:62 一致），
//      cache_creation **不计入**——它是"写入"，与"读取"互斥；混入会让首轮写缓存的
//      请求显示为高命中（假象）。
//   3) **total 与 requestTokens 数值一致**：全仓只有一个"请求面"口径
//      （历史教训见 context.mjs:390「并行维护的第二个计数口径必然漂移」）。
//   4) **防御**：字段缺失 / null / undefined / 字符串数字不抛异常。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cacheStats, requestTokens } from '../kernel/context.mjs'
import { createAnthropicParser } from '../kernel/api.mjs'

test('端点无缓存字段 → supported=false（不能误判为"命中率 0 的严重事故"）', () => {
  const s = cacheStats({ input_tokens: 10, output_tokens: 20 })
  assert.equal(s.input, 10)
  assert.equal(s.read, 0)
  assert.equal(s.create, 0)
  assert.equal(s.supported, false)
  assert.equal(s.hitRatio, 0)
  assert.equal(s.total, 10)
})

test('只有 cache_read → supported=true 且高命中', () => {
  const s = cacheStats({ input_tokens: 10_000, cache_read_input_tokens: 90_000 })
  assert.equal(s.supported, true)
  assert.equal(s.total, 100_000)
  assert.equal(s.hitRatio, 0.9)
})

test('只有 cache_creation → supported=true 但 hitRatio=0（写入不是命中）', () => {
  const s = cacheStats({ input_tokens: 0, cache_creation_input_tokens: 50_000 })
  assert.equal(s.supported, true)
  assert.equal(s.hitRatio, 0, 'cache_creation 不得计入分母')
  assert.equal(s.total, 50_000)
})

test('read 与 create 并存 → 分母只含 input+read', () => {
  const s = cacheStats({ input_tokens: 1_000, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 8_000 })
  assert.equal(s.hitRatio, 0.5)
  assert.equal(s.total, 10_000)
})

test('total 与 requestTokens 数值一致（口径唯一）', () => {
  const u = { input_tokens: 1_234, cache_read_input_tokens: 56_789, cache_creation_input_tokens: 321 }
  assert.equal(cacheStats(u).total, requestTokens(u))
})

test('防御：空/缺字段/null/字符串数字均不抛，且按数值语义处理', () => {
  assert.deepEqual(cacheStats(), { input: 0, read: 0, create: 0, total: 0, reported: false, supported: false, hitRatio: 0 })
  const s = cacheStats({ input_tokens: null, cache_read_input_tokens: undefined, cache_creation_input_tokens: '300' })
  assert.equal(s.input, 0)
  assert.equal(s.read, 0)
  assert.equal(s.create, 300)
  assert.equal(s.supported, true)
})

// —— 字段存在性信号（2026-09-18，用户裁定"从根修复"，重开 Task 1）——
// 本组用例锁**两义可分**：`supported` 的语义已从"本请求命中过（read+create>0）"修正为
// "端点具备缓存计量"。修正前这两义在判定层**不可分**：一次 read=0 既可能是"端点无字段"、
// 也可能是"端点有缓存但本轮未命中"，而二者处置相反（前者静默，后者是 suspicious 候选）。
// 根因是 normalizeUsage 的 `?? 0` 在到达判定层前销毁了存在性 ⇒ 由新键 cache_fields_reported
// 从源头保留（见 kernel/api.mjs / kernel/context.mjs 注释）。
test('存在性信号：上报了但未命中（reported=true, read/create 全 0）⇒ supported=true', () => {
  const s = cacheStats({ input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_fields_reported: true })
  assert.equal(s.reported, true)
  assert.equal(s.supported, true, '端点上报了缓存字段，本轮未命中是"未命中"而非"无缓存"')
  assert.equal(s.read, 0)
  assert.equal(s.hitRatio, 0, '口径不变：read=0 时 hitRatio 仍为 0（supported 与命中率是两件事）')
  assert.equal(s.total, 10)
})

test('存在性信号：缺该键且 read/create 为 0 ⇒ supported=false（端点无字段，退化路径）', () => {
  const s = cacheStats({ input_tokens: 10 })
  assert.equal(s.reported, false)
  assert.equal(s.supported, false, '无存在性信号时退化为旧启发式 read+create>0')
  assert.equal(s.reported, s.supported, '两键恒同值（reported 是信号出口，supported 是既有契约名）')
})

test('存在性信号：显式 false 覆盖旧启发式（端点明确表示不上报）', () => {
  // 显式 false + 有数值：存在性优先——端点自报"无缓存计量"，不得被 read>0 翻成 supported
  const s = cacheStats({ input_tokens: 10, cache_read_input_tokens: 90_000, cache_fields_reported: false })
  assert.equal(s.reported, false)
  assert.equal(s.supported, false)
  assert.equal(s.read, 90_000, '数值仍如实暴露（口径层不隐藏数据，只据实报存在性）')
})

test('存在性信号：非布尔值不当作信号（只有 boolean 才算上报）', () => {
  const s = cacheStats({ input_tokens: 10, cache_fields_reported: undefined })
  assert.equal(s.supported, false, 'undefined = 缺键 ⇒ 退化路径')
  const t = cacheStats({ input_tokens: 10, cache_creation_input_tokens: 5, cache_fields_reported: null })
  assert.equal(t.supported, true, 'null 非 boolean ⇒ 退化为旧启发式（create>0）')
})

test('全零 → hitRatio=0 且不产生 NaN', () => {
  const s = cacheStats({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  assert.equal(s.hitRatio, 0)
  assert.equal(Number.isNaN(s.hitRatio), false)
})

// 跨协议别名回归（2026-09-18 A4）：本条**必须穿过真实解析路径**——只构造"已归一"
// 的形态（cache_read_input_tokens 直接给值）测不出 api.mjs 的别名 fallback，删掉那两
// 行也照样全绿。故以 message_start 喂 OpenAI 形态 usage，断言归一后 read 落到
// cache_read_input_tokens 且 supported=true。
// 注：断言刻意不含 total/hitRatio——OpenAI 形态的 prompt_tokens 已含 cached_tokens，
// 归一后 input 与 read 重复计入同一批 token（api.mjs normalizeUsage 的已知限制）。
test('cacheStats：OpenAI 形态 cached_tokens 经 normalizeUsage 真解析后落入 read 口径', () => {
  const chat = createAnthropicParser()
  assert.deepEqual(
    chat.feed({ type: 'message_start', message: { usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 90 } } } }),
    [],
    'message_start 只更新 usage，不产出 chunk',
  )
  assert.equal(chat.usage().cache_read_input_tokens, 90)
  assert.equal(cacheStats(chat.usage()).supported, true)

  const responses = createAnthropicParser()
  responses.feed({ type: 'message_start', message: { usage: { input_tokens: 23, input_tokens_details: { cached_tokens: 77 } } } })
  assert.equal(responses.usage().cache_read_input_tokens, 77)
  assert.equal(cacheStats(responses.usage()).supported, true)
})

// —— 根因修复的管线自证（2026-09-18 评审 Finding 3，提级必修）——
// 上面那组"存在性信号"用例全部是**手写 usage 字面量**：它们锁的是 cacheStats 的**判据层**，
// 而"从根修复"的关键两行在**产出链**上（api.mjs normalizeUsage 的键产出 :151、
// mergeCumulativeUsage 的取或 :170）——删掉任一行，上面所有用例**仍全绿**（字面量里直接给了
// 该键；缺键用例走的正是"退化路径"）。这正是本项目 Task 1 首轮踩过的模式：声称加了测试，
// 但测试不验证目标。故以下三条**必须穿过已导出的 createAnthropicParser 的真实解析路径**
// （不为测试扩大 api.mjs 导出面），把产出与合并各自钉成可证伪的命题：
//   · 用例 1 锁 :151（把 `?? 0` 之前的原始值用于存在性判定）；
//   · 用例 2 锁 :151 的反面（无字段必须判 false，不能恒 true）；
//   · 用例 3 锁 :170（取或——末片只带 output_tokens 时不得把存在性覆盖成 false/丢失）。
test('存在性产出（真实解析路径）：message_start 只带 cache_read_input_tokens=0 ⇒ cache_fields_reported=true', () => {
  const p = createAnthropicParser()
  assert.deepEqual(
    p.feed({ type: 'message_start', message: { usage: { input_tokens: 1_200, output_tokens: 0, cache_read_input_tokens: 0 } } }),
    [],
    'message_start 只更新 usage，不产出 chunk',
  )
  const u = p.usage()
  assert.equal(u.cache_fields_reported, true, '端点如实上报了字段（值为 0）⇒ 存在性必须在 `?? 0` 之前取到原始值')
  assert.equal(u.cache_read_input_tokens, 0, '数值本身仍如实暴露 0')
  assert.equal(cacheStats(u).supported, true, '这是"本轮未命中"，不是"端点无缓存能力"')
  assert.equal(cacheStats(u).hitRatio, 0, 'supported 与命中率是两件事：未命中仍是 0 命中率')
})

test('存在性产出（真实解析路径）：usage 无任何 cache 字段 ⇒ cache_fields_reported=false / supported=false', () => {
  const p = createAnthropicParser()
  p.feed({ type: 'message_start', message: { usage: { input_tokens: 1_200, output_tokens: 0 } } })
  const u = p.usage()
  assert.equal(u.cache_fields_reported, false, '无字段必须判 false（若该键恒 true，退化路径与真上报就不可分）')
  assert.equal(cacheStats(u).supported, false, '端点无缓存计量 ⇒ 整体静默（spec §5 不假警）')
})

test('存在性取或（真实解析路径）：message_start 带 cache 字段 + message_delta 只带 output_tokens ⇒ 仍为 true', () => {
  const p = createAnthropicParser()
  p.feed({
    type: 'message_start',
    message: { usage: { input_tokens: 1_200, output_tokens: 0, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0 } },
  })
  const out = p.feed({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 45 } })
  assert.ok(out.some((c) => c.type === 'usage'), 'message_delta 应产出 usage 快照')
  const u = p.usage()
  assert.equal(u.output_tokens, 45, '末片的 output_tokens 必须并入')
  assert.equal(u.cache_read_input_tokens, 30_000, '末片缺 cache 字段不得把累计值归零/丢失')
  // ★ 本行是本文件**唯一**能抓住 mergeCumulativeUsage 漏掉第五个键（或写成"取最后一片"）的断言：
  //   末片的 normalizeUsage 里 cache_fields_reported=false（只带 output_tokens）⇒ 不取或即丢成
  //   false/undefined，端点会被误判为"无缓存能力"、整条观测链在该端点静默。
  assert.equal(u.cache_fields_reported, true, '任一分片报过即视为端点上报（取或，不是取末片）')
  assert.equal(cacheStats(u).supported, true, '合并后的口径出口同样必须为 supported')
})
