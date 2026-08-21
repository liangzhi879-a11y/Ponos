// T004 验收：transcript 统计聚合模块正确性（纯函数）+ bridge 路由注册
// 用法：node verify.mjs <workspace>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ws = process.argv[2]
const modPath = join(ws, 'server', 'transcript-stats.mjs')

let mod
try {
  mod = await import(pathToFileURL(modPath).href)
} catch (e) {
  console.error('VERIFY_FAIL: 无法导入 server/transcript-stats.mjs ——', e.message)
  process.exit(1)
}

const { aggregateTranscriptStats, sanitizePathSegment } = mod
if (typeof aggregateTranscriptStats !== 'function' || typeof sanitizePathSegment !== 'function') {
  console.error('VERIFY_FAIL: 缺少 aggregateTranscriptStats / sanitizePathSegment 导出')
  process.exit(1)
}

// ── 用例 1：三维分组（项目/模型/日期）正确 ──────────────────────────────────
const entries = [
  // 项目A · 模型M1 · 2026-08-19
  { type: 'assistant', _project: 'project-a', ts: '2026-08-19T10:00:00Z', message: { model: 'm1', usage: { input_tokens: 100, output_tokens: 50 } } },
  { type: 'assistant', _project: 'project-a', ts: '2026-08-19T11:00:00Z', message: { model: 'm1', usage: { input_tokens: 200, output_tokens: 30 } } },
  // 项目A · 模型M2 · 2026-08-20
  { type: 'assistant', _project: 'project-a', ts: '2026-08-20T09:00:00Z', message: { model: 'm2', usage: { input_tokens: 400, output_tokens: 100 } } },
  // 项目B · 模型M1 · 2026-08-20
  { type: 'assistant', _project: 'project-b', ts: '2026-08-20T10:00:00Z', message: { model: 'm1', usage: { input_tokens: 50, output_tokens: 10 } } },
  // 无 usage → 跳过不抛错
  { type: 'assistant', _project: 'project-a', ts: '2026-08-20T10:00:00Z', message: { model: 'm1' } },
  { type: 'user', _project: 'project-a', ts: '2026-08-20T10:00:00Z', message: { content: 'hi' } },
]
const r = aggregateTranscriptStats(entries)
const byProjA = r.byProject?.['project-a']
const byModelM1 = r.byModel?.['m1']
const byDate = r.byDate?.['2026-08-19']
const ok1 =
  byProjA && byProjA.inputTokens === 700 && byProjA.outputTokens === 180 && byProjA.requests === 3 &&
  byModelM1 && byModelM1.inputTokens === 350 && byModelM1.outputTokens === 90 &&
  byDate && byDate.inputTokens === 300 && byDate.outputTokens === 80 &&
  r.totals && r.totals.inputTokens === 750 && r.totals.outputTokens === 190
if (!ok1) {
  console.error('VERIFY_FAIL: 三维分组聚合错误')
  console.error('byProject:', JSON.stringify(r.byProject))
  console.error('byModel:', JSON.stringify(r.byModel))
  console.error('byDate:', JSON.stringify(r.byDate))
  console.error('totals:', JSON.stringify(r.totals))
  process.exit(1)
}

// ── 用例 2：cost 计算 / null ────────────────────────────────────────────────
const noPrice = aggregateTranscriptStats(entries)
if (noPrice.totals.costUsd !== null) {
  console.error('VERIFY_FAIL: 未提供 modelPriceUsd 时 costUsd 应为 null')
  process.exit(1)
}
const withPrice = aggregateTranscriptStats(entries, {
  modelPriceUsd: { m1: { input: 0.2, output: 1.2 }, m2: { input: 0.5, output: 2.0 } },
})
const expectCost = (350 / 1e6 * 0.2) + (90 / 1e6 * 1.2) + (400 / 1e6 * 0.5) + (100 / 1e6 * 2.0)
if (typeof withPrice.totals.costUsd !== 'number' || Math.abs(withPrice.totals.costUsd - expectCost) > 1e-9) {
  console.error('VERIFY_FAIL: costUsd 计算错误，期望', expectCost, '实际', withPrice.totals.costUsd)
  process.exit(1)
}

// ── 用例 3：sanitizePathSegment ─────────────────────────────────────────────
// 逐字符替换非字母数字 → '-'（不合并连续字符）：C : \ 空格 / 研发 共 6 处
// 替换 → C--my-proj---（与 kernel/session.mjs sanitizeSegment 同算法）
if (sanitizePathSegment('C:\\my proj/研发') !== 'C--my-proj---') {
  console.error('VERIFY_FAIL: sanitizePathSegment 归一错误，实际', JSON.stringify(sanitizePathSegment('C:\\my proj/研发')))
  process.exit(1)
}

// ── 用例 4：bridge 路由注册 ─────────────────────────────────────────────────
const bridgeSrc = readFileSync(join(ws, 'server', 'bridge.mjs'), 'utf8')
if (!/transcript\/stats/.test(bridgeSrc)) {
  console.error('VERIFY_FAIL: bridge.mjs 未注册 /transcript/stats 路由')
  process.exit(1)
}

console.log('VERIFY_PASS')
process.exit(0)
