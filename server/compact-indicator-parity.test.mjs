// 压缩指示条兜底上限 GUI/内核一致性：src/lib/compactIndicator.ts vs kernel/cli.mjs
// ---------------------------------------------------------------------------
// 为什么需要：GUI 的兜底复位（"挂起超过 COMPACT_INDICATOR_MAX_MS 即 done 帧丢失"）成立
// 的前提是**内核自己不会让压缩跑更久**——内核硬看门狗（PONOS_KERNEL_HARD_TIMEOUT_MS，
// kernel/cli.mjs）超时自杀、桥广播 closed、GUI 走正常复位路径。若哪天内核上限被抬高
// （T10 计划从 600s 抬到 900s 即是先例），而 GUI 的兜底值没跟着抬，出现的就不是静默
// 常驻而是"压缩还在跑、指示条先消失"的误清。本守卫把这条耦合钉死在测试里。
//
// 放在 server/ 才能直接从 .mjs import .ts（Node 24 原生 TS）；发布目录
// `release/YFWorking/` 只发 server/ electron/ dist/、**不含 src/**，而该目录同样带
// `.test.mjs`（发布会跑测试是既有做法）。故仅当"确实找不到 src/lib/compactIndicator.ts"
// 时跳过；源码树里 src/ 必然存在，导入因语法等原因失败时异常照旧抛出（不吞成静默跳过）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

let mod = null
let srcSkip = false
try {
  mod = await import('../src/lib/compactIndicator.ts')
} catch (e) {
  const notFound = e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND'
  if (notFound && /src[\\/]lib[\\/]compactIndicator/.test(String(e?.message || ''))) srcSkip = true
  else throw e
}
const SKIP = srcSkip ? '发布目录无 src/，一致性守卫仅在源码树运行' : false

test('兜底上限严格大于内核硬看门狗默认值（内核自杀前的压缩都不可能被误清）', { skip: SKIP }, () => {
  const cli = readFileSync(join(HERE, '..', 'kernel', 'cli.mjs'), 'utf-8')
  // 锚点：const hardTimeoutMs = Math.max(1, Number(process.env.PONOS_KERNEL_HARD_TIMEOUT_MS) || 900_000)
  const m = /PONOS_KERNEL_HARD_TIMEOUT_MS\)\s*\|\|\s*([0-9][0-9_]*)/.exec(cli)
  assert.ok(
    m,
    '内核硬看门狗默认值表达式已改形——请同步本守卫的锚点（kernel/cli.mjs 的 hardTimeoutMs）',
  )
  const kernelDefault = Number(m[1].replace(/_/g, ''))
  assert.ok(Number.isFinite(kernelDefault) && kernelDefault > 0, `解析出的内核上限非法：${m[1]}`)
  assert.ok(
    mod.COMPACT_INDICATOR_MAX_MS > kernelDefault,
    `GUI 兜底上限 ${mod.COMPACT_INDICATOR_MAX_MS}ms 必须 > 内核硬看门狗 ${kernelDefault}ms`
    + '（否则内核还在跑的压缩会被误清；同步抬高 src/lib/compactIndicator.ts 的 COMPACT_INDICATOR_MAX_MS）',
  )
})
