// 摘要失真判定的**口径校准**回归网（2026-09-17）。
//
// 背景（用户反馈"上下文健康度好像压缩一次就提示失真；部分失真应当是正常的"）：
//   `auditSummaryFidelity` 原以"从**整段原文**抽到的（上限 120 个）高信号实体"为分母，检查摘要是否
//   **逐字**包含它们。但摘要是原文的抽象，长度只有其 1/30–1/140——要求它逐字复述原文的 120 个实体
//   在物理上做不到。实测真实会话 8 次压缩，该口径缺失率恒为 61–98%（均值 80%），永远 ≥ 强证据阈值
//   0.4 ⇒ **每次压缩都判红**（且门禁 8/8 拦下，每次压缩都白跑一次重压）。
//
// 本文件的三个用例分别钉住修复后的三条不变量：
//   ① 正常压缩（保住了"被要求保留的事实"）**不得**报警——即使旧口径会误报；
//   ② 真把关键事实丢了**必须**仍被抓到（修复不得把信号一起关掉）；
//   ③ 判红需同时满足"比例达标"与"失真量达标"——小幅丢失只落 amber（部分失真属正常）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHealth } from '../kernel/health.mjs'
import { extractEntities } from '../kernel/fidelity.mjs'
import { auditSummaryFidelity, extractKeyInfo, keyInfoBlock } from '../kernel/compact.mjs'

// ── 构造"真实形态"的会话：早期大量无关文件撑起旧口径的分母，最近才是真正在改的少数文件 ──────────
const text = (t) => ({ type: 'text', text: t })
const writeUse = (p) => ({ type: 'tool_use', id: `t:${p}`, name: 'Write', input: { file_path: p, content: 'x' } })

/** 最近真正在改的文件（`extractKeyInfo` 的 files 取最近若干条 Write/Edit） */
const RECENT = [
  'src/core/engine.ts', 'src/core/loop.ts', 'src/lib/healthUi.ts',
  'kernel/fidelity.mjs', 'kernel/compact.mjs', 'server/bridge.mjs',
  'shared/knowledge-core.mjs', 'electron/bridge-header-inject.cjs',
]

function realisticCovered() {
  const legacyPaths = []
  for (let i = 1; i <= 60; i++) legacyPaths.push(`legacy/old-module-${i}.mjs`)
  return [
    // 历史：与本轮无关的大量文件（旧口径 120 个实体的来源）。
    // 注意必须落在 `content[].text` 里——`auditSummaryFidelity` 只从文本块取原文
    // （tool_use 的 input 不进原文），这正是真实会话的样子：路径大量出现在工具结果与叙述里。
    { role: 'assistant', content: [text(`历史探索涉及：${legacyPaths.join('、')}`)] },
    { role: 'assistant', content: [text('过程记录：先探索旧模块，逐个核对历史实现。')] },
    // 最近：被 key-info 收录的写入 + 决策/清单文本
    { role: 'assistant', content: RECENT.map(writeUse) },
    { role: 'assistant', content: [text(`最近决定：判定基准改用 must-keep 事实，涉及 ${RECENT.join('、')}。`)] },
    { role: 'assistant', content: [text('任务清单：修判定口径；补回归测试。')] },
  ]
}

const covered = realisticCovered()
const mustKeepEntities = extractEntities(keyInfoBlock(extractKeyInfo(covered)), { max: 60, kinds: 'key' })

test('① 正常压缩不得误报：摘要保住"被要求保留的事实"时，新口径不报警而旧口径会误报', () => {
  assert.ok(mustKeepEntities.length >= 3, `本用例的前提是 key-info 里确有实体（实际 ${mustKeepEntities.length} 个）`)
  // 一份"好摘要"：把 key-info 要求保留的事实都带上（外加正常叙述）
  const summary = `本轮完成：${mustKeepEntities.join('、')}。决定见上。`

  const audit = auditSummaryFidelity({ covered, summary })

  assert.ok(audit.raw.ratio >= 0.4,
    `旧口径（原文实体为分母）在此形态下必然误报，实测基准值应 ≥0.4（实际 ${audit.raw.ratio.toFixed(3)}）`)
  assert.ok(audit.ratio < 0.4,
    `新口径（must-keep 为分母）不得误报：摘要已保住被要求保留的事实（实际 ${audit.ratio.toFixed(3)}）`)
  assert.equal(audit.mustKeep.total, mustKeepEntities.length, 'must-keep 基准应被真正采用（total 即其规模）')
  assert.equal(typeof audit.lostTokens, 'number', '须回报可读的失真量（token）')
})

test('② 真丢关键事实仍被抓到：摘要不含被要求保留的事实时，缺失率与失真量都必须出手', () => {
  const audit = auditSummaryFidelity({ covered, summary: '继续之前的开发。' })
  assert.ok(audit.ratio >= 0.4, `丢掉 must-keep 事实必须判为高缺失率（实际 ${audit.ratio.toFixed(3)}）`)
  assert.equal(audit.mustKeep.missing, mustKeepEntities.length, '应当报告全部 must-keep 事实都缺失')
  assert.ok(audit.lostTokens > 0, '失真量必须为正，才能支撑"丢了约 N token"的提示与建议')
})

test('③ raw 诊断字段保留旧口径，便于回归对比与排障', () => {
  const audit = auditSummaryFidelity({ covered, summary: '继续之前的开发。' })
  assert.ok(audit.raw && Array.isArray(audit.raw.entities) && typeof audit.raw.ratio === 'number',
    'raw 必须保留旧口径（entities/missing/total/ratio），否则无法解释历史报警')
  assert.ok(audit.raw.entities.length >= 60, `旧口径分母应是原文里的大批实体（实际 ${audit.raw.entities.length}）`)
})

// ── ③ 失真量下限：比例达标但量太小 → 只落 amber（"部分失真应当是正常的"）────────────────────────
const mk = () => {
  const ev = []
  return { ev, wire: { health: (d) => ev.push(d), summary: () => {} } }
}
const AUDIT_ARGS = {
  entities: ['src/a.ts', 'src/b.ts', 'src/c.ts', '阈值 120'],
  missing: ['src/a.ts', 'src/b.ts'],
  ratio: 0.5,
}

test('④ 比例达标但失真量过小：不得判红（落 amber），避免"部分失真"被当成红灯', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordCompactionAudit({ ...AUDIT_ARGS, lostTokens: 12 })
  const tier = h.getState().distortionTier
  assert.notEqual(tier, 'red', `丢失 12 token 只是正常损耗，不得判红（实际 ${tier}）`)
  assert.equal(tier, 'amber', '应当落在 amber（角标提示，不打扰）')
  assert.equal(ev.filter((e) => e.distortion?.tier === 'red').length, 0, '不得发出红档事件')
})

test('⑤ 比例与失真量同时达标：必须判红（下限不得把真信号一并挡掉）', () => {
  const { ev, wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordCompactionAudit({ ...AUDIT_ARGS, lostTokens: 120 })
  assert.equal(h.getState().distortionTier, 'red', `比例 0.5 且丢失 120 token 属真失真（实际 ${h.getState().distortionTier}）`)
  assert.equal(ev.filter((e) => e.distortion?.tier === 'red').length, 1, '失真转红必须发事件')
  // 文案须含"失真量"与可执行建议（用户要求：按失真量分级并通过计算给建议）
  const red = ev.find((e) => e.distortion?.tier === 'red')
  const textOf = JSON.stringify(red)
  assert.match(textOf, /失真量约 120 token/, '证据里必须写明失真量')
  assert.match(textOf, /建议/, '证据里必须给出建议')
})

test('⑥ 旧调用方兼容：不提供 lostTokens 时行为不变（ratio 达标即判红）', () => {
  const { wire } = mk()
  const h = createHealth({ wire, env: {} })
  h.record({ usage: { input_tokens: 1000 }, lastUsage: { input_tokens: 1000 } })
  h.recordCompactionAudit({ ...AUDIT_ARGS })
  assert.equal(h.getState().distortionTier, 'red', '缺省不得因新增下限而改变既有语义')
})
