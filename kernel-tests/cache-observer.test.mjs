// 前缀缓存观测 · 判定层契约（2026-09-18 spec §3.2/§5）
// ---------------------------------------------------------------------------
// 本文件锁以下契约：
//   1) **三态可分辨**：ok / suspicious / compacted / unsupported。
//   2) **不误报是硬要求**（比"能抓到失效"更重要）：压缩后首次请求、小请求骤降、
//      请求面大幅缩小（压缩生效的正常规模效应，即 `drop ≤ 净收缩量`）三种情形**都不得**
//      判 suspicious。
//      实测教训：首版探针判据用 ±30% 容差 + 轮级聚合口径，372 个样本只命中 1 例失效
//      ——阈值与粒度双重失效；per-request 粒度 + 三重约束（§5）才有分辨力。
//   3) **归因优先级**：归因命中断定"预期性失效"，压过骤降判定（否则每次压缩都误报）。
//   4) **unsupported 静默**：端点无缓存字段时不报警、不计入异常。
//   5) **覆盖语义**：observe 每次传入的是"该请求最终 usage 快照"，非增量。
//   6) **存在性驱动 supported（2026-09-18 修订）**：`supported` = 端点**是否上报**缓存计量字段
//      （`cache_fields_reported`），不再等于"本请求 read+create>0"。据此判据 ③
//      （`cache-fields-vanished`，端点中途停报）在观测器路径上**真实可达**——端点级粘性已删除。
//   7) **summary 压缩走独立信号（2026-09-18 用户裁定 C）**：`summaryGen` 递增 ⇒
//      cause=post-compaction，**即使 epoch 未变**（摘要落地不改块内容 ⇒ 不 bump epoch，
//      epoch 语义下 post-compaction 本不可达）。见文件末「裁定 C」小节 5 个用例。
//   8) **判据⑤ = read 断崖（2026-09-18 用户裁定 D）**：`suspicious` 的第 3 条约束由
//      `sizeSimilar`（请求面相当，|Δtotal|/prev.total ≤ sizeTol）改为
//      `drop > 净收缩量 × (1 + sizeTol)`（净收缩量 = max(0, prev.total − cur.total)）。
//      依据：纯删除时 read 跌幅 ≤ total 跌幅 ⇒ drop ≤ 净收缩量；反之必有「新增/替换」。
//      原判据与判据⑦ 之间留 10%~30% 盲区（实测漏 195,456 tokens = 44%），`sizeTol` 语义
//      随之由"请求面容差"变为"净收缩量的容忍系数"（接口兼容）。见「裁定 D」小节 5 个用例。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCache, createCacheObserver } from '../kernel/cache-observer.mjs'

// ★ U() 默认带 `cache_fields_reported: true`（2026-09-18 存在性信号）：真实 Anthropic 端点
//   **如实上报**两个缓存计量字段（哪怕是 0），故 supported 由存在性驱动而非"值非零"。
//   第 4 参可显式覆盖为 `false`（端点自报"不上报"）。
//   ⚠️ 「**缺键**」形态（mock / 旧 transcript / 手写字面量 ⇒ cacheStats 走 `read + create > 0`
//      退化路径）请**直接写字面量对象**，不要靠 `U(..., undefined)`：JS 默认参数语义会把显式
//      `undefined` 换成默认值 `true`（本任务实测踩到，断言给出 `true !== false` 才发现）。
const U = (input, read, create = 0, reported = true) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: create,
  cache_fields_reported: reported,
})
// 缺键形态（与 api.mjs 的 MOCK_USAGE、旧 transcript 一致）：无任何缓存字段存在性信号。
const UKeyless = (input, read = 0, create = 0) => ({
  input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: create,
})

test('classifyCache：端点不支持（前后都不支持）→ unsupported，不报警', () => {
  const cur = { input: 10, read: 0, create: 0, total: 10, supported: false, hitRatio: 0 }
  const r = classifyCache({ prev: null, cur })
  assert.equal(r.state, 'unsupported')
})

test('classifyCache：归因命中 → compacted（预期性，压过骤降）', () => {
  const prev = { input: 5, read: 100_000, create: 0, total: 100_005, supported: true, hitRatio: 0.999 }
  const cur = { input: 100_000, read: 0, create: 0, total: 100_000, supported: true, hitRatio: 0 }
  // 请求面相当 + read 骤降，若无关因必判 suspicious；有关因则判 compacted
  assert.equal(classifyCache({ prev, cur }).state, 'suspicious')
  const r = classifyCache({ prev, cur, cause: 'post-aged' })
  assert.equal(r.state, 'compacted')
  assert.equal(r.reason, 'post-aged')
})

test('classifyCache：上次支持、本次不支持 → suspicious（方向性变化）', () => {
  const prev = { input: 5, read: 100_000, create: 0, total: 100_005, supported: true, hitRatio: 0.999 }
  const cur = { input: 100_000, read: 0, create: 0, total: 100_000, supported: false, hitRatio: 0 }
  assert.equal(classifyCache({ prev, cur }).state, 'suspicious')
})

test('classifyCache：首个受支持请求无基准 → ok（不判 suspicious）', () => {
  const cur = { input: 10, read: 90_000, create: 0, total: 90_010, supported: true, hitRatio: 0.999 }
  assert.equal(classifyCache({ prev: null, cur }).state, 'ok')
})

test('classifyCache：请求面相当 + read 骤降 → suspicious（真失效）', () => {
  const prev = { input: 10_000, read: 90_000, create: 0, total: 100_000, supported: true, hitRatio: 0.9 }
  const cur = { input: 100_000, read: 0, create: 0, total: 100_000, supported: true, hitRatio: 0 }
  const r = classifyCache({ prev, cur })
  assert.equal(r.state, 'suspicious')
  assert.equal(r.drop, 90_000)
})

test('classifyCache：请求面骤降（服务端压缩）→ compacted 而非 suspicious', () => {
  const prev = { input: 10_000, read: 90_000, create: 0, total: 100_000, supported: true, hitRatio: 0.9 }
  const cur = { input: 20_000, read: 10_000, create: 0, total: 30_000, supported: true, hitRatio: 0.333 }
  const r = classifyCache({ prev, cur })
  assert.equal(r.state, 'compacted')
  assert.equal(r.reason, 'server-compact')
})

test('classifyCache：不误报三连——小请求骤降 / 请求面大幅缩小 / 命中稳定', () => {
  // ① 小请求（prev.read < minRead）不参与失效判定
  const small = classifyCache({
    prev: { input: 1_000, read: 5_000, create: 0, total: 6_000, supported: true, hitRatio: 0.83 },
    cur: { input: 6_000, read: 0, create: 0, total: 6_000, supported: true, hitRatio: 0 },
  })
  assert.equal(small.state, 'ok', '小请求无缓存可失，不得误报')
  // ② 请求面大幅缩小（压缩/裁剪的正常规模效应）→ 不得误报为 suspicious
  //    ★ 冲突裁定（v2 A2 为准）：本条原期望 'ok' 与判据 ⑦（服务端压缩兜底）冲突——
  //    cur.total 25_000 < prev.total 310_000 × 0.7 且 cur.read 20_000 <= prev.read 300_000
  //    ⇒ 现判 compacted / server-compact（仍是"不误报"，只是归到"预期性"一侧）。
  //    ★ 2026-09-18 裁定 D 后本条注释更新：⑦ 与 ⑤ **不再互斥**（⑤ 已与请求面变化解耦，
  //    不再要求"请求面相当"）——⑦ 的职责变为"只对收缩 > 30% 先行兜底"，⑤ 覆盖其余；
  //    旧注释里"⑤ 与 ⑦ 在默认容差下互斥 / sizeTol 放大到 > 0.3 会让 ⑦ 先截住真失效"
  //    已作废（⑤ 的触发不再随请求面是否相当而变）。
  const shrunk = classifyCache({
    prev: { input: 10_000, read: 300_000, create: 0, total: 310_000, supported: true, hitRatio: 0.97 },
    cur: { input: 5_000, read: 20_000, create: 0, total: 25_000, supported: true, hitRatio: 0.8 },
  })
  assert.equal(shrunk.state, 'compacted', '请求面骤降 + read 同向下降是规模效应，判预期性而非 suspicious')
  assert.equal(shrunk.reason, 'server-compact')
  // ③ 命中稳定
  const stable = classifyCache({
    prev: { input: 10_000, read: 90_000, create: 0, total: 100_000, supported: true, hitRatio: 0.9 },
    cur: { input: 10_000, read: 89_000, create: 0, total: 99_000, supported: true, hitRatio: 0.899 },
  })
  assert.equal(stable.state, 'ok')
})

test('observer：连续三次请求 → ok / ok / suspicious（覆盖语义 + 计数正确）', () => {
  const obs = createCacheObserver()
  const a = obs.observe(U(10_000, 90_000))
  assert.equal(a.state, 'ok')
  assert.equal(a.seq, 1)
  const b = obs.observe(U(10_000, 90_000))
  assert.equal(b.state, 'ok')
  const c = obs.observe(U(100_000, 0))
  assert.equal(c.state, 'suspicious')
  assert.equal(c.seq, 3)
  const s = obs.snapshot()
  assert.equal(s.requests, 3)
  assert.equal(s.ok, 2)
  assert.equal(s.suspicious, 1)
  assert.equal(s.readTotal, 180_000)
  assert.equal(s.inputTotal, 120_000)
  assert.equal(s.hitRatio, 180_000 / 300_000)
})

test('observer：epoch+1 后首个请求判 compacted（预期性；noteShrink 只负责命名），次个恢复判定', () => {
  // ★ 冲突裁定（v2 A1 为准）：本用例原版「noteShrink 后首个请求判 compacted」与 A1 冲突——
  // A1 的判据是 **epoch 变化**，noteShrink() 只提供 cause 命名（**不是免报凭证**）。
  // 故这里显式传 epoch（1 → 2），并用"epoch 不变 + 有标签仍判 suspicious"证明标签不改变判据。
  const obs = createCacheObserver()
  obs.observe(U(10_000, 90_000), { epoch: 1 }) // 建基准
  obs.noteShrink() // 仅命名（A1）：判据是 epoch
  const a = obs.observe(U(100_000, 0), { epoch: 2 }) // epoch+1 + 请求面相当 → 预期性
  assert.equal(a.state, 'compacted')
  assert.equal(a.reason, 'post-aged', 'causeHint 生效：命名为 post-aged')
  // 恢复：请求面保持 100000（U(0,100_000) 的 total 也是 100000）——**让净收缩量为 0**，
  // 下一步的 read 骤降便无从被"少发内容"解释 ⇒ 判据⑤ 必判真失效。epoch 保持不变。
  // （★ 2026-09-18 裁定 D 后：判据⑤ 已与请求面变化解耦，不再要求"请求面相当"；
  //   旧注释"否则会被规模效应豁免（判据 ③）"表述的是改造前的 sizeSimilar 约束。）
  const b = obs.observe(U(0, 100_000), { epoch: 2 })
  assert.equal(b.state, 'ok')
  const c = obs.observe(U(100_000, 0), { epoch: 2 }) // epoch 未变 + 无标签 + 请求面相当 + read→0 → 真失效
  assert.equal(c.state, 'suspicious')
  assert.equal(c.reason, 'cache-drop')
})

test('observer：noteCompaction 归因与 noteShrink 区分（标签仅在 epoch 变化时被采用）', () => {
  const obs = createCacheObserver()
  obs.observe(U(10_000, 90_000), { epoch: 1 })
  obs.noteCompaction()
  // ★ 一致性修订（v2 A1）：epoch 未变时 hint 不产生 compacted（标签不是免报凭证），
  // 故本用例显式传 epoch 变化，只断言"命名"这一半语义（判据一半由上面的 4 个 epoch 单测覆盖）。
  assert.equal(obs.observe(U(100_000, 0), { epoch: 2 }).reason, 'post-compaction')
})

test('observer：unsupported 不发归因、计入计数、不建立判定基准', () => {
  const obs = createCacheObserver()
  const a = obs.observe({ input_tokens: 10, output_tokens: 20 })
  assert.equal(a.state, 'unsupported')
  obs.noteShrink()
  const b = obs.observe({ input_tokens: 10, output_tokens: 20 })
  assert.equal(b.state, 'unsupported', '端点不支持时不谈失效')
  assert.equal(obs.snapshot().unsupported, 2)
  // ★ 基准断言（评审 Minor-6：原文标题声称"不污染基准"却无任何基准断言）：两个
  //   unsupported 请求**不得**建立 read 基准——之后首个受支持请求仍走「无基准的首请求」，
  //   既不判失效、drop 也恒为 0（若基准被污染成 prev.read>0，这里会变成 ok/minor-drop 或
  //   更糟的 suspicious）。
  const c = obs.observe(U(10_000, 90_000))
  assert.equal(c.state, 'ok')
  assert.equal(c.reason, 'first-supported', 'unsupported 序列不构成失效基准')
  assert.equal(c.drop, 0)
})

test('observer：阈值可配（minRead / dropRatio / sizeTol）', () => {
  // ★ 因判据⑤ 改造（2026-09-18 用户裁定 D），本段期望**由 ok 改为 suspicious**：
  //   旧判据的第 3 条约束是"请求面相当"（sizeTol=0 ⇒ 请求面不相等即不判），
  //   prev.total=100000 而 cur.total=101000 ⇒ 旧判定 ok；新判据看"drop 是否超出净收缩量"，
  //   请求面**增长** ⇒ 净收缩量 = 0 ⇒ drop=90000 > 0 ⇒ suspicious。新判定**正确**：
  //   read 从 90000 归零而请求面只涨 1%，损失不可能由"少发内容"解释（必为新增/替换）。
  const obs = createCacheObserver({ sizeTol: 0 })
  obs.observe(U(10_000, 90_000))
  assert.equal(obs.observe(U(101_000, 0)).state, 'suspicious', '请求面增长 ⇒ 净收缩量 0 ⇒ 第③条约束退化为 drop > 0（第①②条仍在）')
  // ★ sizeTol 的新语义（净收缩量的容忍系数）方向锁：请求面缩 25%（200000 ← 150000）、
  //   read 跌 55%（100000 → 45000），drop=55000 恰好等于 净收缩量 50000 × (1 + 0.1)。
  //   默认 sizeTol=0.1 ⇒ 55000 ≤ 55000 ⇒ **不判**（损失可由"少发内容"解释，是纯删除）
  //   ⇒ ok / minor-drop；sizeTol=0 ⇒ 55000 > 50000 ⇒ 判 suspicious。容差越大越不敏感。
  const inTol = createCacheObserver()
  inTol.observe(U(100_000, 100_000))
  const okTol = inTol.observe(U(105_000, 45_000))
  assert.equal(okTol.state, 'ok', 'drop 落在净收缩量（含容忍系数）之内 ⇒ 不判失效')
  assert.equal(okTol.reason, 'minor-drop')
  const noTol = createCacheObserver({ sizeTol: 0 })
  noTol.observe(U(100_000, 100_000))
  assert.equal(noTol.observe(U(105_000, 45_000)).state, 'suspicious', '同一对数据、容差为 0 ⇒ 超出即判')
  // minRead 语义不变：prev.read 低于门槛 ⇒ 不参与失效判定（即使 read 归零）
  const small = createCacheObserver()
  small.observe(U(10_000, 5_000))
  const s = small.observe(U(60_000, 0))
  assert.equal(s.state, 'ok', '小请求无缓存可失（prev.read < minRead）⇒ 不判')
  assert.equal(s.reason, 'minor-drop')
  // dropRatio 语义不变：放宽到 0.1 ⇒ 小幅下降也算失效。**注意**：改造后判据与请求面解耦，
  // 这里 total 仍取 100000 只是让净收缩量为 0（判据退化为单纯 read 断崖）——旧版本要求
  // total 相等是因为 sizeSimilar 要求"请求面相当"，该要求已不存在。
  const obs2 = createCacheObserver({ dropRatio: 0.1 })
  obs2.observe(U(10_000, 90_000))
  assert.equal(obs2.observe(U(30_000, 70_000)).state, 'suspicious')
})

// —— v2 A1：epoch 主判据（判据来自 epoch；hint 只管命名）——

test('observer：epoch 变化 → compacted（即使无 causeHint，也不得误报 suspicious）', () => {
  const obs = createCacheObserver()
  obs.observe(U(10_000, 90_000), { epoch: 1 })
  const r = obs.observe(U(100_000, 0), { epoch: 2 }) // 请求面相当 + 骤降 + epoch 变了
  assert.equal(r.state, 'compacted')
  assert.equal(r.reason, 'history-rewrite', '无标签时退化为通用标签，而非 suspicious')
})

test('observer：epoch 未变 + 无标签 → suspicious（真未知失效）', () => {
  const obs = createCacheObserver()
  obs.observe(U(10_000, 90_000), { epoch: 7 })
  const r = obs.observe(U(100_000, 0), { epoch: 7 })
  assert.equal(r.state, 'suspicious')
  assert.equal(r.reason, 'cache-drop')
})

test('observer：causeHint 只影响命名，不影响判据（epoch 未变时不得因 hint 免报）', () => {
  const obs = createCacheObserver()
  obs.observe(U(10_000, 90_000), { epoch: 3 })
  obs.noteShrink() // 有标签但 epoch 没变（改写实际未发生/已被别处消费）
  const r = obs.observe(U(100_000, 0), { epoch: 3 })
  assert.equal(r.state, 'suspicious', '标签不是免报凭证——判据只认 epoch')
})

test('observer：无 epoch（null）时退化为原行为（向后兼容）', () => {
  const obs = createCacheObserver()
  obs.observe(U(10_000, 90_000))
  assert.equal(obs.observe(U(100_000, 0)).state, 'suspicious')
})

// —— 覆盖补强（评审 Minor-2 / Minor-4）：本任务最重的设计裁定与最微妙的规则 ——
// 【历史说明·过去时，2026-09-18 原地修订前的事实】补强前的覆盖状况（复审独立复现，两者
// 不同、勿混为一谈）——下面两条描述的是**当时**的状态，不是当前实现，勿按现在时阅读：
//   · 端点级 sticky：当时**无具名用例**，只被 3 个既有用例**间接**锁定（当时中和 sticky
//     会同轮红 5 例）；当时缺的是"在 reason 级别区分 cache-drop(⑤) 与 cache-fields-vanished(③)"
//     的直接锁，以及"返回的 cur 未被 sticky 污染"的锁。
//     ★ 该口径（端点级 sticky）**已于 2026-09-18 被删除并取代**：判据 ③ 的可分辨性改由
//       `cache_fields_reported` 存在性信号从源头提供（api.mjs normalizeUsage →
//       context.mjs cacheStats），代码里已无 sticky 机制，故"中和 sticky 会红 5 例"这类
//       当代判据不存在，本段仅作历史记录。取代关系见下方「端点中途停止上报缓存字段」
//       用例开头的替换声明（该声明即原 :226）。
//   · hint 一次性：**完全无覆盖**（删掉 `hint = null` 后修复前 16 例仍全绿）——此项仍为
//     彼时至今的同一状态，下面第二条用例即为此补强。
// 每条用例均做了红/绿自证（见 task-2-fix-report.md）。

test('observer：端点中途停止上报缓存字段 → suspicious / cache-fields-vanished（判据 ③ 真实可达）', () => {
  // ★ 本用例替换了原「端点级 sticky」用例（粘性已随 cacheStats 存在性信号删除）。
  //   判据 ③ 的**真实语义**就是本用例：端点从"上报缓存计量字段"变为"不上报"。
  //   为什么它曾是**不可达**的：cacheStats.supported 旧定义为 read+create>0（请求级证据），
  //   于是"端点有缓存但本轮未命中"也会得到 supported=false ⇒ ③ 无法区分该形态与"端点
  //   停报"，观测器只能用"端点级粘性"把全零请求一律补成 supported（代价：真停报被误归
  //   为 cache-drop）。根因已从源头修复（normalizeUsage 保留存在性）⇒ 粘性删除、③ 可达。
  const obs = createCacheObserver()
  const a = obs.observe(U(10_000, 90_000)) // 端点如实上报（reported: true）
  assert.equal(a.cur.reported, true, '前置条件：首请求端点确实上报了缓存字段')
  assert.equal(a.state, 'ok', '首个受支持请求无基准')
  // 端点**停报**：请求 usage 里不再有缓存计量字段（normalizeUsage 会把它标为
  // cache_fields_reported=false；此处用**缺键**形态构造，等价于 mock / 旧 transcript 的退化路径，
  // 也等价于本地 vLLM 类端点：两条路径都落到 read+create=0 ⇒ supported=false）。
  const b = obs.observe(UKeyless(100_000, 0, 0))
  assert.equal(b.cur.supported, false, '缺键 + read/create 全 0 ⇒ 退化判为"端点无字段"')
  assert.equal(b.state, 'suspicious')
  assert.equal(b.reason, 'cache-fields-vanished', '方向性变化：端点缓存能力退化')
  assert.equal(b.drop, 90_000, 'drop 仍按 prev.read − cur.read 如实计量（0 − 90_000 取正）')
  // 端点持续停报：prev 已是非支持态 ⇒ 由判据 ① 截住（unsupported），**不重复报警**
  const c = obs.observe(UKeyless(100_000, 0, 0))
  assert.equal(c.state, 'unsupported')
  assert.equal(c.reason, 'endpoint-no-cache')
  // 统计口径：requests = ok 1 + suspicious 1 + unsupported 1（无漏记）
  const s = obs.snapshot()
  assert.equal(s.requests, 3)
  assert.equal(s.ok, 1)
  assert.equal(s.suspicious, 1)
  assert.equal(s.unsupported, 1)
})

test('observer：hint 一次性——noteShrink 只命名紧邻的下一请求，第二个 epoch 变化退化为 history-rewrite', () => {
  // 为什么"一次性"必须锁：hint 若做成持久状态，一次 noteShrink() 之后**每个** epoch 变化的
  //   请求都会被叫成 post-aged，把真实原因（历史改写）掩盖掉——只有"用后置 null"才能区分。
  //   本用例靠"第二次 epoch 变化时标签已耗尽"把「一次性」与「持久化」分辨开：
  //   中和 hint = null（改成持久）后，第二次的 reason 会是 post-aged ⇒ 本断言变红。
  const obs = createCacheObserver()
  obs.observe(U(10_000, 90_000), { epoch: 1 })
  obs.noteShrink()
  const first = obs.observe(U(100_000, 0), { epoch: 2 })
  assert.equal(first.state, 'compacted')
  assert.equal(first.reason, 'post-aged', '标签生效于紧邻的第一个（epoch 变化）请求')
  // epoch **再次变化**但不带新标签：hint 已耗尽 ⇒ 退化为通用标签（若 hint 持久则仍是 post-aged）
  const second = obs.observe(U(100_000, 0), { epoch: 3 })
  assert.equal(second.state, 'compacted')
  assert.equal(second.reason, 'history-rewrite', '旧标签不得用于命名新的改写——hint 是一次性的')
})

// —— 2026-09-18 用户裁定 C：summary 压缩走**独立信号**（summaryGen = replaceGeneration/compactCount）——
// 背景（评审第一手证据）：`bumpContentEpoch()` 全仓仅 2 处（compact.mjs 的 ageOutToolResults /
//   freeShrink 裁剪），**都是原地改写**；而**摘要落地**（session.appendCompactionSummary）按设计
//   "换对象而非改内容"，**不 bump epoch** ⇒ 纯 summary 压缩后 epoch 未变 ⇒ cause=null ⇒
//   noteCompaction() 的标签被 observe 静默丢弃 ⇒ `cause=post-compaction` 在 epoch 语义下**不可达**。
//   反向：压缩伴随 freeShrink 原地老化时 epoch 会变，而调用点标签若停在 post-compaction 就会把
//   那次老化**错标**成 post-compaction。
// 修法：`observe(rawUsage, { epoch, summaryGen, causeHint })`——summaryGen 递增 ⇒
//   cause=post-compaction（信号，优先）；epoch 递增而 summaryGen 未动 ⇒ 走原有 hint / 通用标签。
// 本小节 5 个用例即该判据的可证伪覆盖（红/绿自证见 task-C-report.md：把 summaryAdvanced
//   分支中和成 false 后，用例 1 / 3 / 5 变红，恢复即全绿）。
const SG = (n) => ({ epoch: 0, summaryGen: n })

test('裁定C-1：纯 summary 压缩（summaryGen 递增而 epoch 不变）→ compacted / post-compaction', () => {
  // ★ 本次修复的灵魂用例：改动前本用例**必红**——那时 compacted 只由 epoch 变化触发，
  //   summaryGen 递增而 epoch 不变会落到 suspicious（请求面相当 + read 骤降），
  //   即"最值得深挖的真未知失效"被误报。
  const obs = createCacheObserver()
  obs.observe(U(10_000, 90_000), SG(1)) // 建基准（epoch 与 summaryGen 同守）
  const r = obs.observe(U(100_000, 0), SG(2)) // 摘要落地：summaryGen+1，**epoch 不动**
  assert.equal(r.state, 'compacted', 'summary 落地即压缩，必须判预期性失效（绝不是 suspicious）')
  assert.equal(r.reason, 'post-compaction', '命名由信号给出，与 noteCompaction 是否被调用无关')
})

test('裁定C-2：epoch 变化、summaryGen 不变 → history-rewrite（原地改写旧行为不回归）', () => {
  const obs = createCacheObserver()
  obs.observe(U(10_000, 90_000), { epoch: 1, summaryGen: 1 })
  const r = obs.observe(U(100_000, 0), { epoch: 2, summaryGen: 1 }) // aged/pruned：epoch+1，summary 未动
  assert.equal(r.state, 'compacted')
  assert.equal(r.reason, 'history-rewrite', '无标签时退化为通用标签；**不得**被误命名为 post-compaction')
})

test('裁定C-3：两者同时变化 + 老化标签在场 → post-compaction（summary 信号优先）', () => {
  // 反向错标的修复点：压缩**伴随**原地老化时 epoch 也会变，若让的一次性 hint 承重就会被命名成
  // post-aged；现在 summaryAdvance 是确定性信号 ⇒ 命名回到最具体的 post-compaction。
  const obs = createCacheObserver()
  obs.observe(U(10_000, 90_000), { epoch: 1, summaryGen: 1 })
  obs.noteShrink() // 同一 preStep 里还做了 freeShrink → engine 会先标记 post-aged
  const r = obs.observe(U(100_000, 0), { epoch: 2, summaryGen: 2 })
  assert.equal(r.state, 'compacted')
  assert.equal(r.reason, 'post-compaction', 'summary 落地是最具体的原因，优先于 hint 的 post-aged')
})

test('裁定C-4：首请求传非 null summaryGen 不误报（双非空守卫 ⇒ 加载期 +1 不触发）', () => {
  // session 加载恢复路径（session.mjs:145/:146）也会让 replaceGeneration / compactCount +1，
  // 而那是**进程内第一次**观察到的值 ⇒ 只需"上轮值为 null 时不判"即可挡住。
  const obs = createCacheObserver()
  const a = obs.observe(U(10_000, 90_000), { epoch: 1, summaryGen: 3 }) // 首请求：两路都是 null 基线
  assert.equal(a.state, 'ok', '首请求无基准')
  assert.equal(a.reason, 'first-supported')
  // 同一 summaryGen / epoch 的第二个请求：read 骤降 ⇒ 走骤降判定（suspicious），
  // 若守卫缺失（把首请求的值当"变化"）这里会被误判成 compacted/post-compaction。
  const b = obs.observe(U(100_000, 0), { epoch: 1, summaryGen: 3 })
  assert.equal(b.state, 'suspicious')
  assert.equal(b.reason, 'cache-drop')
  assert.equal(obs.snapshot().compactions, 0, '没有信号变化 ⇒ 不得计入 compactions')
})

test('裁定C-5：snapshot().compactions 只计 summary 信号命中次数（hint 不计）', () => {
  const obs = createCacheObserver()
  obs.observe(U(10_000, 90_000), { epoch: 1, summaryGen: 1 })
  // ① summary 信号命中 1 次（epoch 未变）。注意：归因命中即判 compacted（与 epoch 路径同语义
  //    ——"预期性失效"不要求 read 真的降了，压缩后首个请求本就必然失效）。
  const a = obs.observe(U(10_000, 90_000), { epoch: 1, summaryGen: 2 })
  assert.equal(a.state, 'compacted')
  assert.equal(a.reason, 'post-compaction')
  // ② epoch 变化 + hint 命名（纯原地改写路径）⇒ **不**计入 compactions
  obs.noteShrink()
  assert.equal(obs.observe(U(100_000, 0), { epoch: 2, summaryGen: 2 }).reason, 'post-aged')
  const s = obs.snapshot()
  assert.equal(s.compactions, 1, 'compactions 是"摘要落地次数"，与 hint/epoch 改写解耦')
  assert.equal(s.rewrites, 1, 'rewrites 只看得见 epoch 变化（aged/pruned），与本信号互补')
  assert.equal(s.requests, 3, 'requests 口径不受影响')
})

// —— 2026-09-18 用户裁定 D：判据⑤ 改造为「read 断崖」（与请求面变化解耦）——
// 背景（Task 6 专项对账的第一手结论）：原判据⑤ 的第 3 条约束是 `sizeSimilar`——要求请求面
//   相当（|Δtotal|/prev.total ≤ sizeTol = 0.1），而判据⑦ 要求请求面骤降（收缩 > 30%）
//   ⇒ **10%~30% 的请求面变化两侧都不点火**，真失效落判据⑥ 被判 ok/minor-drop。真实日志实测
//   漏掉 3 起、195,456 tokens（= 实测损失的 44%），收缩比 11.5% / 14.5% / 22.5%，
//   read 断崖至 0.25 / 0.54 / 0.64。
// 数学依据（判定正确性的全部来源）：设 prev = (in0, read0)、cur = (in1, read1)，
//   drop = max(0, read0 − read1)。若只发生「删除」（in1 ≤ in0 且 read1 ≤ read0），
//   则 total 跌幅 ≤ 单项最大跌幅 ⇒ read 跌幅 ≤ total 跌幅 ⇒ **drop ≤ 净收缩量**
//   （净收缩量 = max(0, prev.total − cur.total)）。反之 drop > 净收缩量 ⇒ 必然发生
//   「新增/替换」⇒ 该损失无法由"少发内容"解释 ⇒ 真失效。
// 新判据：`suspicious` ⟺ ① prev.read ≥ minRead ② cur.read < prev.read × (1 − dropRatio)
//   ③ drop > 净收缩量 × (1 + sizeTol)。`sizeTol` 语义随之由"请求面容差"变为"净收缩量的
//   容忍系数"——**参数名 / env 名（PONOS_CACHE_SIZE_TOL）/ 默认值（0.1）都不变**。
// 本节 5 个用例的红/绿自证（实际输出见 task-7-report.md）：把实现里的 `!shrinkExplainsDrop`
//   条件去掉（退回旧的 sizeSimilar 行为）⇒ D-1 / D-4 / D-5 变红；恢复 ⇒ 全绿。

test('裁定D-1：盲区真失效被判出（请求面缩 20% + read 腰斩；旧判据在此不判 ⇒ 改造前必红）', () => {
  // prev.total 200000 → cur.total 160000 = 收缩 20%，**正落在旧判据的 10%~30% 无覆盖带**
  // （sizeSimilar 要求 ≤ 10%、判据⑦ 要求 > 30% ⇒ 两侧都不点火，旧判定为 ok/minor-drop）。
  const prev = { input: 100_000, read: 100_000, create: 0, total: 200_000, supported: true, hitRatio: 0.5 }
  const cur = { input: 120_000, read: 40_000, create: 0, total: 160_000, supported: true, hitRatio: 0.25 }
  const r = classifyCache({ prev, cur })
  assert.equal(r.state, 'suspicious', 'read 断崖（100000→40000，跌 60%）且 drop 超出净收缩量 ⇒ 必判真失效')
  assert.equal(r.reason, 'cache-drop')
  assert.equal(r.drop, 60_000, 'drop = prev.read − cur.read = 100000 − 40000')
})

test('裁定D-2：纯删除不误报（缩 20% 且 read 同步下降，drop ≤ 净收缩量 ⇒ 解耦 ≠ 无脑放宽）', () => {
  // 本对数据**满足**判据⑤ 的前两条（prev.read ≥ minRead、read 跌 60%），但 drop（60000）
  //   小于净收缩量（70000）⇒ 损失完全可由"少发内容"解释（纯删除）⇒ 必须判 ok。
  //   改造前它不是 suspicious（20% 已超旧的 10% 容差），改造后**仍不是**——这条正是
  //   "解耦没有把守门放掉"的关键证明。
  const prev = { input: 250_000, read: 100_000, create: 0, total: 350_000, supported: true, hitRatio: 0.286 }
  const cur = { input: 240_000, read: 40_000, create: 0, total: 280_000, supported: true, hitRatio: 0.143 }
  const r = classifyCache({ prev, cur })
  assert.equal(r.state, 'ok', 'drop 60000 ≤ 净收缩量 70000 ⇒ 少发内容即可解释，不得判失效')
  assert.equal(r.reason, 'minor-drop')
  assert.equal(r.drop, 60_000)
  assert.ok(!(r.drop > Math.max(0, prev.total - cur.total) * 1.1),
    '前置条件自证：drop 未超净收缩量（含容忍系数）——否则本用例测的就不是守门')
})

test('裁定D-3：抖动仍不误报（read 只跌 8% ⇒ dropRatio 防抖仍生效）', () => {
  // 刻意让请求面**持平**（净收缩量 = 0）⇒ 若没有 dropRatio 这条门，任何 1 token 的 read 下降
  //   都会被判 suspicious；8% 的下降必须由 dropRatio（0.5）拦下（reason=stable）。
  const prev = { input: 100_000, read: 100_000, create: 0, total: 200_000, supported: true, hitRatio: 0.5 }
  const cur = { input: 108_000, read: 92_000, create: 0, total: 200_000, supported: true, hitRatio: 0.46 }
  const r = classifyCache({ prev, cur })
  assert.equal(r.state, 'ok', 'read 仅跌 8%（抖动量级）⇒ 不得判失效')
  assert.equal(r.reason, 'stable')
})

test('裁定D-4：请求面增长时仍能判出（净收缩量为 0 ⇒ 判据⑤ 的第③条约束退化为 drop > 0）', () => {
  // 请求面**增长 20%**（200000 → 240000，超出旧判据的 ±10% 容差）⇒ 旧判据必不判（本用例
  //   在改造前必红）；新判据下净收缩量为 0 ⇒ **第③条约束**退化为"drop > 0 即判"（第①②条
  //   仍在：prev.read ≥ minRead、read 跌幅 > dropRatio——措辞精确化见评审 Minor-m-4）。
  const prev = { input: 100_000, read: 100_000, create: 0, total: 200_000, supported: true, hitRatio: 0.5 }
  const cur = { input: 200_000, read: 40_000, create: 0, total: 240_000, supported: true, hitRatio: 0.167 }
  const r = classifyCache({ prev, cur })
  assert.equal(r.state, 'suspicious', '请求面增长 ⇒ 无收缩可解释 read 损失 ⇒ read 腰斩必为新增/替换')
  assert.equal(r.reason, 'cache-drop')
  assert.equal(r.drop, 60_000)
})

test('裁定D-5：sizeTol 容忍系数的边界（恰等于不判 / 略超即判，锁方向）', () => {
  // 构造 drop 恰等于 净收缩量 × (1 + sizeTol)：净收缩 50000、drop 55000、sizeTol 默认 0.1
  //   ⇒ 阈值 50000 × 1.1 = 55000 ⇒ `drop <= 阈值` 成立 ⇒ **不判**（边界落在容忍侧）。
  const prev = { input: 100_000, read: 100_000, create: 0, total: 200_000, supported: true, hitRatio: 0.5 }
  const atBoundary = { input: 105_000, read: 45_000, create: 0, total: 150_000, supported: true, hitRatio: 0.3 }
  assert.ok(Math.abs(Math.max(0, prev.total - atBoundary.total) * 1.1 - 55_000) < 1e-6,
    '前置条件自证：阈值（净收缩量 × 1.1）恰为 drop = 55000')
  assert.equal(classifyCache({ prev, cur: atBoundary }).state, 'ok', '恰等于阈值 ⇒ 不判')
  // 请求面多 1 token（净收缩少 1）⇒ 阈值 54998.9 < drop 55000 ⇒ **判**。方向：超出才判。
  const over = { input: 105_001, read: 45_000, create: 0, total: 150_001, supported: true, hitRatio: 0.3 }
  const r = classifyCache({ prev, cur: over })
  assert.equal(r.state, 'suspicious', '略超阈值 ⇒ 判（容忍系数只吸收"少发内容"可解释的量）')
  assert.equal(r.reason, 'cache-drop')
})

// —— 2026-09-18 最终评审 Minor-m-3 / m-5：sizeTol 需要上下界；净收缩量非负此前不可证伪 ——

test('裁定D-6：净收缩量恒非负（请求面增长时它必须为 0，不得因"负的净收缩量"凭空判失效）', () => {
  // 为什么补这例（评审 Minor-m-5）：`Math.max(0, prev.total − cur.total)` 这层"净收缩量非负"
  //   此前**不可证伪**——去掉 `Math.max` 后既有 28 例全绿。已用穷举确认原因：判据⑤ 的第②条
  //   要求 `read` 真降 ⇒ drop > 0；而请求面增长时"raw 净收缩量"为负，阈值 ≤ 负数 < drop
  //   恒成立 ⇒ 有/无 `Math.max` 判定**相同**。故第 ① 段只能锁**语义**，真正能分辨 `Math.max`
  //   的是第 ② 段（drop == 0 的边界）。
  // ① 语义锁（评审给出的形态）：请求面**增长** 20% + read 腰斩 ⇒ 净收缩量必须为 0（而非负数）
  //    ⇒ drop 60,000 无收缩可解释 ⇒ 必判真失效。
  const prev = { input: 100_000, read: 100_000, create: 0, total: 200_000, supported: true, hitRatio: 0.5 }
  const cur = { input: 200_000, read: 40_000, create: 0, total: 240_000, supported: true, hitRatio: 0.167 }
  assert.ok(cur.total > prev.total, '前置条件自证：请求面增长（raw 净收缩量为负）')
  const r = classifyCache({ prev, cur })
  assert.equal(r.state, 'suspicious', '请求面增长 ⇒ 净收缩量 0 ⇒ drop 60,000 无从被"少发内容"解释')
  assert.equal(r.reason, 'cache-drop')
  // ② 可证伪锁（唯一能分辨 `Math.max` 的构造）：read **持平**（drop = 0）+ 请求面增长——
  //    若净收缩量取负数（把 `Math.max` 去掉），阈值变负 ⇒ `drop <= 负阈值` 恒假 ⇒ 无中生有地
  //    判 suspicious（假警）。这里用 `dropRatio = -1`（退化但仍是合法旋钮取值）把第②条防抖门
  //    放开，好让判定真正走到第③条约束上——否则 drop == 0 会被第②条提前拦下、测不到 `Math.max`。
  //    实测：去掉 `Math.max` 后本段断言变红（红/绿实跑输出见 task-8-report.md §m-5）。
  const flat = createCacheObserver({ dropRatio: -1 })
  flat.observe(U(200_000, 100_000)) // total 300,000
  const flatOut = flat.observe(U(240_000, 100_000)) // total 340,000（增长）、read 持平
  assert.ok(flatOut.drop === 0, '前置条件自证：read 持平 ⇒ drop = 0')
  assert.equal(flatOut.state, 'ok', '净收缩量非负 ⇒ 不存在"超出可解释范围"的损失（drop=0 不得判失效）')
  assert.equal(flatOut.reason, 'stable')
})

test('裁定D-7：sizeTol 的极端/非法取值收敛到 [0, 1]（1e9 不再把判据钝化到失效；NaN 仍回落 0.1）', () => {
  // 与 m-3 的最终实现一致（收敛点 = 观测器读取处，见 `cache-observer.mjs` 的 `clampTol` / `tolOf`）。
  // ① 上界 1——"调大即钝化"被钉死为"最多容忍 2 倍净收缩量"：
  //    净收缩 50,000、drop 130,000（prev.read 150,000）⇒ 阈值 = 50,000 × 2 = 100,000 < 130,000
  //    ⇒ **仍判**。若不收敛（1e9）⇒ 阈值 = 50,000 × (1 + 1e9) ⇒ "超出"永不成立 ⇒ 判 ok/minor-drop
  //    ⇒ **判据整体失效**（评审实测的缺陷，本断言即为它的回归锁）。
  const prev = { input: 50_000, read: 150_000, create: 0, total: 200_000, supported: true, hitRatio: 0.75 }
  const cur = { input: 130_000, read: 20_000, create: 0, total: 150_000, supported: true, hitRatio: 0.133 }
  assert.ok(cur.read < prev.read * 0.5, '前置条件自证：第②条防抖门放开（read 跌 86.7%）')
  assert.ok(cur.total >= prev.total * 0.7, '前置条件自证：判据⑦ 不触发（收缩 25% < 30%），测的是判据⑤')
  assert.ok(Math.max(0, prev.total - cur.total) * (1 + 1) < prev.read - cur.read,
    '前置条件自证：drop 超过"收敛后上界（sizeTol=1）"的阈值 100,000')
  const rExtreme = classifyCache({ prev, cur, sizeTol: 1e9 })
  assert.equal(rExtreme.state, 'suspicious', 'sizeTol = 1e9 被收敛到 1 ⇒ 判据仍生效（不再钝化到失效）')
  assert.equal(rExtreme.reason, 'cache-drop')
  assert.equal(classifyCache({ prev, cur, sizeTol: 1 }).state, 'suspicious', '收敛上界 1 的行为 = 极端值的实际行为')
  const obsExtreme = createCacheObserver({ sizeTol: 1e9 }) // 观测器路径的定界（第二处 clamp 点）
  obsExtreme.observe(U(50_000, 150_000))
  assert.equal(obsExtreme.observe(U(130_000, 20_000)).state, 'suspicious',
    'createCacheObserver 路径同样收敛（engine 透传的 env 值最终在此收敛）')
  // ② 上界之内的"钝化"仍成立（≠ 无界放大）：净收缩 50,000、drop 55,000
  //    ⇒ sizeTol=1 的阈值 100,000 ≥ 55,000 ⇒ **不判**（容忍侧）。这一对同时是第③段 0.1 回落锁的载体。
  const inTolPrev = { input: 100_000, read: 100_000, create: 0, total: 200_000, supported: true, hitRatio: 0.5 }
  const inTolCur = { input: 105_000, read: 45_000, create: 0, total: 150_000, supported: true, hitRatio: 0.3 }
  assert.equal(classifyCache({ prev: inTolPrev, cur: inTolCur, sizeTol: 1e9 }).state, 'ok',
    '钝化有界：sizeTol=1 时 drop 55,000 ≤ 阈值 100,000 ⇒ 不判（但不会像 1e9 那样连 drop 130,000 也不判）')
  assert.equal(classifyCache({ prev: inTolPrev, cur: inTolCur, sizeTol: 1 }).state, 'ok')
  // ③ 非法值回落默认 0.1（既有行为不变）：阈值 = 50,000 × 1.1 = 55,000 ⇒ drop 恰等于阈值 ⇒ 不判。
  //    若回落成 0（阈值 50,000）就会判 suspicious ⇒ 本断言对"回落值"敏感。
  assert.equal(classifyCache({ prev: inTolPrev, cur: inTolCur, sizeTol: Number('abc') }).state, 'ok',
    'Number("abc") = NaN ⇒ 回落 0.1（判据⑤ 的既有默认），不是 0')
  assert.equal(classifyCache({ prev: inTolPrev, cur: inTolCur, sizeTol: 'abc' }).state, 'ok',
    '非数字字符串同样走 NaN 回落路径（Number.isFinite 先挡）')
  assert.equal(classifyCache({ prev: inTolPrev, cur: inTolCur }).state, 'ok', '默认值 0.1 的行为基线')
  // ④ 负值收敛到 0 ⇒ 等价于 sizeTol = 0（"drop > 净收缩量"即判，严格档）：
  //    净收缩 55,000、drop 55,000 ⇒ 不判；若不收敛（-5）⇒ 阈值 = 55,000 × (−4) < 0 ⇒ 判
  //    **放大误报**（评审实测的第二个缺陷）。
  const negPrev = { input: 100_000, read: 100_000, create: 0, total: 200_000, supported: true, hitRatio: 0.5 }
  const negCur = { input: 100_000, read: 45_000, create: 0, total: 145_000, supported: true, hitRatio: 0.31 }
  assert.ok(negCur.total >= negPrev.total * 0.7, '前置条件自证：判据⑦ 不触发（收缩 27.5% < 30%）')
  assert.ok(negPrev.read - negCur.read === Math.max(0, negPrev.total - negCur.total),
    '前置条件自证：drop 恰等于净收缩量 55,000 ⇒ 严格档（sizeTol=0）也取不判一侧')
  const rNeg = classifyCache({ prev: negPrev, cur: negCur, sizeTol: -5 })
  assert.equal(rNeg.state, 'ok', '负值收敛到 0 ⇒ 门槛不因负容差而变严')
  assert.equal(rNeg.reason, 'minor-drop')
  assert.equal(classifyCache({ prev: negPrev, cur: negCur, sizeTol: 0 }).state, 'ok', '等价于 sizeTol = 0')
  const negObs = createCacheObserver({ sizeTol: -5 })
  negObs.observe(U(100_000, 100_000))
  assert.equal(negObs.observe(U(100_000, 45_000)).state, 'ok', '观测器路径同样收敛（两处定界，同一 clampTol）')
})

test('裁定D-8：⑦（server-compact）优先于 ⑤——同时满足"收缩 > 30%"与"read 断崖"时判 compacted', () => {
  // 为什么补这例（评审 Minor-m-5 第 3 条）：⑦ 的优先级此前只被「不误报三连」②**间接**承重
  //   （那对的 drop 远小于净收缩量 ⇒ ⑤ 本来就不判，故测不到"谁先判"）。本用例构造一对**同时**
  //   满足两条判据的数据，直接断言结果由 ⑦ 给出。
  const prev = { input: 10_000, read: 90_000, create: 0, total: 100_000, supported: true, hitRatio: 0.9 }
  const cur = { input: 25_000, read: 40_000, create: 0, total: 65_000, supported: true, hitRatio: 0.615 }
  const drop = prev.read - cur.read // 50,000
  const shrink = prev.total - cur.total // 35,000
  // 前置条件自证（"若⑤ 先判，结果会是 suspicious"——否则本用例测不出优先级）：
  assert.ok(cur.total < prev.total * 0.7, '前置条件自证：⑦ 的触发条件成立（收缩 35% > 30%）')
  assert.ok(cur.read <= prev.read, '前置条件自证：⑦ 还要求 read 同向不升')
  assert.ok(prev.read >= 20_000, '前置条件自证：⑤ 的第①条（minRead）成立')
  assert.ok(cur.read < prev.read * 0.5, '前置条件自证：⑤ 的第②条（dropRatio 防抖）成立（跌 55.6%）')
  assert.ok(drop > shrink * 1.1, '前置条件自证：⑤ 的第③条成立（drop 50,000 > 净收缩 35,000 × 1.1 = 38,500）')
  const r = classifyCache({ prev, cur })
  assert.equal(r.state, 'compacted', '⑤ 与 ⑦ 同时成立 ⇒ 由位置在前的 ⑦ 判决（预期性失效）')
  assert.equal(r.reason, 'server-compact')
  assert.equal(r.drop, 50_000, 'drop 仍如实计量（判定类别不影响计量口径）')
  // 对照：把请求面收缩压到 30% 之下（71,000 = 缩 29%）⇒ ⑦ 不再触发 ⇒ 同一 drop 由 ⑤ 判
  //   suspicious。这证明上一条的差别确实来自"⑦ 的位置在前"，而不是 ⑤ 未成立。
  const curUnder = { input: 31_000, read: 40_000, create: 0, total: 71_000, supported: true, hitRatio: 0.563 }
  assert.ok(curUnder.total >= prev.total * 0.7, '对照前置条件：收缩 29% ⇒ ⑦ 不触发')
  const rUnder = classifyCache({ prev, cur: curUnder })
  assert.equal(rUnder.state, 'suspicious', '同一"read 断崖"在 ⑦ 不触发时由 ⑤ 判（两条判据都活着）')
  assert.equal(rUnder.reason, 'cache-drop')
})
