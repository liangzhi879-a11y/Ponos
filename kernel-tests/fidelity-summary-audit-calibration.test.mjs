// 摘要失真判定的**口径校准**回归网（2026-09-17，含同夜的第二轮回修）。
//
// 背景（用户反馈"上下文健康度好像压缩一次就提示失真；部分失真应当是正常的"）：
//   首版 `auditSummaryFidelity` 以"从**整段原文**抽到的（上限 120 个）高信号实体"为分母，
//   检查摘要是否**逐字**包含。摘要是原文的抽象、长度只有其 1/30–1/140 ⇒ 分母与摘要容量无关
//   ⇒ 缺失率必然饱和 ⇒ 恒 ≥ 强证据阈值 ⇒ **每次压缩都判红**（真实 8/8），门禁亦 8/8 拦。
//
// 第一轮修：分母改为"摘要被**明确要求**保留的事实"（`<key-info>` 契约）——真实数据 21% 判红。
// 第二轮回修（本文件主要锁定的部分）：`<key-info>` **整块文本**抽实体仍带入三类噪声 ⇒ 21% 误报：
//   ① 包裹标签自身（抽出 "key-info"，每次必然缺 1 项）；
//   ② 一次性工作产物（scratch 探针 / commit-msg.txt / 日志 / .trae 构建脚本 / tmp-*）；
//   ③ 非事实碎片（`1/4`、`19/19`、字母串 `M/L/H/…`、CSS 值 `26px 24px 14px`、`polygon(...)`）。
// ⇒ 改为 `mustKeepFacts()`：只取**实质事实**（文件路径/标识符）并剔除上述噪声；
//   判定再加两道闸：失真量下限（100 token）+ 基准规模下限（8 项）；基准不足时**不做判定**
//   （绝不回落旧口径——已知会饱和，回落等于把误报重新引入）。
//
// 标定（本机 140+ 次真实压缩）：100% → 21% → **3.9%**，且残余判红均为真实工程文件成片丢失
// （如 kernel/knowledge.mjs、KnowledgeSearchView.tsx 未被摘要带上）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHealth } from '../kernel/health.mjs'
import { extractEntities } from '../kernel/fidelity.mjs'
import {
  auditSummaryFidelity, mustKeepFacts, isTransientArtifact, isSubstantiveFact,
} from '../kernel/compact.mjs'

const text = (t) => ({ type: 'text', text: t })
const writeUse = (p) => ({ type: 'tool_use', id: `t:${p}`, name: 'Write', input: { file_path: p, content: 'x' } })

/** 本轮的实质事实：真实工程文件（含测试文件） */
const RECENT = [
  'src/core/engine.ts', 'src/core/loop.ts', 'src/lib/healthUi.ts',
  'kernel/fidelity.mjs', 'kernel/compact.mjs', 'server/bridge.mjs',
  'shared/knowledge-core.mjs', 'electron/bridge-header-inject.cjs',
]
/** 一次性工作产物：不该被要求保留在摘要里 */
const TRANSIENT = [
  'scratch/probe-audit.mjs', 'scratch/commit-msg6.txt', 'kernel-tests/verify-final/x.mjs',
  '.trae/build_proof_dirs.py', 'tmp-e2e-b4.sh', '.superpowers/mem-append2.txt', 'logs/app.log',
]

function realisticCovered() {
  const legacy = []
  for (let i = 1; i <= 40; i++) legacy.push(`legacy/old-module-${i}.mjs`)
  return [
    // 历史：与本轮无关的大量文件（旧口径 120 个实体的来源）。
    // 必须落在 content[].text 里——审计只从**文本块**取原文（tool_use.input 不进原文），
    // 这正是真实会话的样子：路径大量出现在工具结果与叙述中。
    { role: 'assistant', content: [text(`历史探索涉及：${legacy.join('、')}`)] },
    // 最近：被 key-info 收录的写入（前/后各含临时产物，用于验证噪声剔除）
    { role: 'assistant', content: [...TRANSIENT.map(writeUse), ...RECENT.map(writeUse)] },
    { role: 'assistant', content: [text(`最近决定：判定基准改用 must-keep 实质事实，涉及 ${RECENT.join('、')}。`)] },
    { role: 'assistant', content: [text('任务清单：修判定口径；补回归测试。')] },
  ]
}

const covered = realisticCovered()
const basis = mustKeepFacts(covered)

test('① 基准只含"实质事实"：一次性工作产物与非事实碎片都不得进基准', () => {
  assert.ok(basis.length >= 8, `真实工程文件应构成足够基准（实际 ${basis.length} 项：${basis.join(', ')}）`)
  // 工程文件必须在基准里（否则检查就是空的）
  assert.ok(basis.some((e) => /compact\.mjs$/.test(e)), '本次修改的工程文件应在基准中')
  // 一次性产物不得进基准
  for (const t of TRANSIENT) {
    const key = t.replace(/\\/g, '/')
    assert.ok(!basis.some((e) => e.replace(/\\/g, '/').includes(key)),
      `一次性工作产物不应计入"必须保留"：${t}`)
  }
  // 旧口径的包裹标签噪声也不得进基准（它曾稳定产出必然缺失的 "key-info"）
  assert.ok(!basis.includes('key-info'), '不得再把 <key-info> 包裹标签当成待保留事实')
})

test('② 噪声判定函数：临时产物 / 非事实碎片', () => {
  for (const t of ['scratch/a.mjs', 'tmp-e2e.sh', '.trae/x.py', 'logs/app.log', 'docs/commit-msg6.txt']) {
    assert.equal(isTransientArtifact(t), true, `${t} 属一次性产物`)
  }
  assert.equal(isTransientArtifact('src/core/engine.ts'), false, '工程文件不是一次性产物')
  for (const n of ['1/4', '19/19', '2026-09-17', 'M/L/H/V', '26px 24px 14px', 'polygon(50% 0)', 'key-info', 'ab']) {
    assert.equal(isSubstantiveFact(n), false, `${n} 不是实质事实`)
  }
  for (const y of ['src/core/engine.ts', 'kernel/fidelity.mjs', 'PONOS_LANE_MAX_CONCURRENT=4', 'KnowledgeSearchView.tsx']) {
    assert.equal(isSubstantiveFact(y), true, `${y} 是实质事实`)
  }
})

test('③ 正常压缩不得误报：摘要保住被要求保留的事实时，新口径不报警而旧口径会误报', () => {
  const summary = `本轮完成：${basis.join('、')}。决定见上。`
  const audit = auditSummaryFidelity({ covered, summary })
  assert.ok(audit.raw.ratio >= 0.4,
    `旧口径（原文实体为分母）在此形态下必然误报，基准值应 ≥0.4（实际 ${audit.raw.ratio.toFixed(3)}）`)
  assert.ok(audit.ratio < 0.4,
    `新口径不得误报：摘要已保住被要求保留的事实（实际 ${audit.ratio.toFixed(3)}）`)
  assert.equal(typeof audit.lostTokens, 'number', '须回报可读的失真量（token）')
})

test('④ 真丢关键事实仍被抓到：摘要不含被要求保留的实质事实时，必须判红', () => {
  const audit = auditSummaryFidelity({ covered, summary: '继续之前的开发。' })
  assert.ok(audit.ratio >= 0.4, `丢掉实质事实必须判为高缺失率（实际 ${audit.ratio.toFixed(3)}）`)
  assert.equal(audit.mustKeep.missing, basis.length, '应当报告全部实质事实都缺失')
  assert.ok(audit.lostTokens > 0 && audit.basisTokens > 0, '须回报失真量与基准规模（token）')

  // 端到端：喂给健康度必须转红（失真量下限会按基准规模缩放，故不能只看绝对值）
  const ev = []
  const h = createHealth({ wire: { health: (d) => ev.push(d), summary: () => {} }, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordCompactionAudit(audit)
  assert.equal(h.getState().distortionTier, 'red',
    `关键事实全丢必须判红（基准 ${basis.length} 项 / ${audit.basisTokens} token，丢失 ${audit.lostTokens} token）`)
})

test('⑤ 基准不足时不做判定（绝不回落旧口径）——无从判断时误报比漏报更有害', () => {
  // 只有 1 个文件的会话：取不到足够实质事实
  const thin = [{ role: 'assistant', content: [text('随便聊聊，没有文件改动。')] }]
  const audit = auditSummaryFidelity({ covered: thin, summary: '随便聊聊' })
  assert.equal(audit.skipped, true, '基准不足必须标记 skipped（不出声）')
  assert.equal(audit.ratio, 0, 'skipped 时不得给出缺失率（否则会带出告警）')
  assert.ok(['no-basis', 'basis-too-small'].includes(audit.skipReason), `须说明跳过原因（实际 ${audit.skipReason}）`)
  assert.ok(audit.raw && typeof audit.raw.ratio === 'number', 'raw 仍保留旧口径供诊断')
})

test('⑥ raw 诊断字段保留旧口径，便于回归对比与排障', () => {
  const audit = auditSummaryFidelity({ covered, summary: '继续之前的开发。' })
  assert.ok(audit.raw && Array.isArray(audit.raw.entities) && typeof audit.raw.ratio === 'number',
    'raw 必须保留旧口径（entities/missing/total/ratio），否则无法解释历史报警')
  assert.ok(audit.raw.entities.length >= 40, `旧口径分母应是原文里的大批实体（实际 ${audit.raw.entities.length}）`)
})

// ── 健康度侧：失真量分级（"部分失真应当是正常的"）────────────────────────────────────
const mk = () => {
  const ev = []
  return { ev, wire: { health: (d) => ev.push(d), summary: () => {} } }
}
const bigBasis = Array.from({ length: 10 }, (_, i) => `C:/proj/src/module-${i}.ts`)
const auditArgs = (lostTokens) => ({
  entities: bigBasis,
  missing: bigBasis.slice(0, 6),
  ratio: 0.6,
  lostTokens,
})

test('⑦ 比例达标但失真量过小：不得判红（落 amber），避免"部分失真"被当成红灯', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordCompactionAudit(auditArgs(60))
  const tier = h.getState().distortionTier
  assert.notEqual(tier, 'red', `丢失 60 token 属正常损耗，不得判红（实际 ${tier}）`)
  assert.equal(tier, 'amber', '应当落在 amber（角标提示，不打扰）')
  assert.equal(ev.filter((e) => e.distortion?.tier === 'red').length, 0, '不得发出红档事件')
})

test('⑧ 比例与失真量同时达标：必须判红（下限不得把真信号一并挡掉）', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordCompactionAudit(auditArgs(260))
  assert.equal(h.getState().distortionTier, 'red', `比例 0.6 且丢失 260 token 属真失真（实际 ${h.getState().distortionTier}）`)
  const red = ev.find((e) => e.distortion?.tier === 'red')
  assert.ok(red, '失真转红必须发事件')
  const textOf = JSON.stringify(red)
  assert.match(textOf, /失真量约 260 token/, '证据里必须写明失真量')
  assert.match(textOf, /建议/, '证据里必须给出建议')
})

test('⑨ 基准小但"比例+失真量"都达标：仍判红（刻意不设基准规模门槛）', () => {
  // 曾经加过"基准 <8 项一律降 amber"（理由是缺失率统计意义不足），但基准净化后实测它
  // 只挡下 1/141 例、且那例本身是"关键事实全丢"的真信号 ⇒ 净收益为负，已撤除。
  // 本用例钉住该决定：小基准 + 比例达标 + 失真量达标 ⇒ 仍是红（噪声由基准净化本身挡住）。
  const { wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordCompactionAudit({ entities: ['a.ts', 'b.ts', 'c.ts'], missing: ['a.ts', 'b.ts'], ratio: 0.67, lostTokens: 300 })
  assert.equal(h.getState().distortionTier, 'red', '3 项缺 2 项且丢失 300 token 属真失真')
})

test('⑨b 小基准 + 丢失量小（基准大半未丢）：不得判红（体积门槛仍然把关）', () => {
  const { wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  // 基准 3 项共约 12 token，丢 2 项 ≈ 8 token：比例 0.67 达标，但绝对量与相对量都不足
  h.recordCompactionAudit({ entities: ['a.ts', 'b.ts', 'c.ts'], missing: ['a.ts', 'b.ts'], ratio: 0.67, lostTokens: 8, basisTokens: 12 })
  assert.notEqual(h.getState().distortionTier, 'red', '小基准下的轻微丢失不得判红')
})

test('⑩ 旧调用方兼容：不提供 lostTokens 时行为不变（ratio 达标即判红）', () => {
  const { wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordCompactionAudit({ ...auditArgs(0), lostTokens: undefined })
  assert.equal(h.getState().distortionTier, 'red', '缺省不得因新增下限而改变既有语义')
})
