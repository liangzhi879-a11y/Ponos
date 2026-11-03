// ENG-08 修复验证（P2）：免费收缩"连续收不动"时，条数会无限增长且无人察觉。
//
// 【缺陷】`kernel/compact.mjs` 的设计意图是"不为条数多付费"：条数超限但 token 未过线时
//   只做免费收缩（清可重放工具结果 / 裁剪超大结果），**不做模型摘要**（摘要代价 480–600s）。
//   这个取舍本身合理，但有边界条件没处理：
//   若消息由大量**不可裁剪的小消息**构成（例如每轮一条短问 + 一条短答，既无工具结果可老化、
//   也无大块可裁剪），`freeShrink` 压不动任何东西 ⇒ 每次 shouldCompact 都返回
//   `{ action:'none', reason:'count-over-no-shrink' }` ⇒ **条数无限增长**：
//   每轮请求 body 越来越大 → 延迟/成本上升 → 最终撞上下文上限。
//   而返回值与正常情况**看不出差别**，没人能发现它正在失控。
//
// 【修法】引入**连续收不动计数**：连续 N 次（默认 3，`PONOS_COMPACT_NOSHRINK_LIMIT` 可调）
//   免费收缩都收不动 ⇒ 认定"免费路径已证明无解"，允许走一次付费摘要。
//   既尊重原成本约束（不是一撞条数就摘要），又给失控装了闸。
//   同时把 `noShrinkStreak` 透出到返回值 —— 让"正在失控"可见。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SRC_RAW = readFileSync(new URL('../kernel/compact.mjs', import.meta.url), 'utf8')
const SRC = SRC_RAW.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

test('★ ENG-08：必须有"连续收不动"计数（否则免费路径无解时无闸）', () => {
  assert.match(SRC, /consecutiveCountNoShrink/,
    '必须有"连续收不动"计数 —— 没有它时，freeShrink 压不动的场景会让条数无限增长')
})

test('★ ENG-08：连续收不动必须能升级到付费摘要', () => {
  const i = SRC.indexOf('count-over-no-shrink')
  assert.ok(i > -1, '必须有 count-over-no-shrink 判定点')
  const block = SRC.slice(Math.max(0, i - 1600), i + 900)
  assert.match(block, /escalat|升级|shouldEscalate/,
    '连续收不动必须能**升级**（走一次付费摘要）—— 原实现是无条件 return none')
  assert.match(block, /PONOS_COMPACT_NOSHRINK_LIMIT/,
    '升级阈值必须可配（不同项目对成本/失控的容忍度不同）')
})

test('★ ENG-08：免费收缩**有效**时必须清零计数（不得误升级）', () => {
  const i = SRC.indexOf('consecutiveCountNoShrink')
  const block = SRC.slice(i, i + 2000)
  assert.match(block, /consecutiveCountNoShrink\s*=\s*0/,
    '免费收缩有效时必须把计数清零 —— 否则"偶尔收得动"的会话也会被升级成付费摘要（白花钱）')
})

test('★ ENG-08：计数必须透出到返回值（让失控可见）', () => {
  const i = SRC.indexOf('count-over-no-shrink')
  const block = SRC.slice(Math.max(0, i - 400), i + 1200)
  assert.match(block, /noShrinkStreak/,
    '必须把 noShrinkStreak 透出到返回值 —— 否则"条数在涨且一直收不动"'
    + '与正常情况从返回上看不出差别，失控不可见（这正是原缺陷的隐蔽之处）')
})

test('★ ENG-08：默认阈值必须保守（不得设成 1，那等于每次条数超限都付费摘要）', () => {
  const m = SRC.match(/PONOS_COMPACT_NOSHRINK_LIMIT\s*\?\?\s*(\d+)/)
  assert.ok(m, '必须有 PONOS_COMPACT_NOSHRINK_LIMIT 的默认值')
  const def = Number(m[1])
  assert.ok(def >= 2, `默认阈值应 ≥2（实得 ${def}）—— 设 1 等于每次条数超限都付费摘要，`
    + '违背原设计"不为条数多付费"的取舍')
  assert.ok(def <= 10, `默认阈值应 ≤10（实得 ${def}）—— 设太大等于永远不升级，退化成原缺陷`)
})
