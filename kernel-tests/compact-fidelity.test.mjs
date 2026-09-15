// 压缩点保真审计（2026-09-12 spec §4.1）：摘要落地时核对"关键事实有没有丢/被改写"。
// 设计要点（本文件即其回归网）：
//   ① 方法 A 确定性实体覆盖（零模型成本）：只能发现"字面丢失"；
//   ② 方法 B LLM 审计（默认开、可关）：能发现"被改写"（如 MySQL→PostgreSQL），
//      但**失败绝不计入压缩熔断**——审计是附产物，压缩落地才是第一优先级；
//   ③ total < minEntities 不判定（稀疏文本上算缺失率纯属噪声）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditSummaryFidelity, buildFidelityAuditRequest, parseFidelityAudit } from '../kernel/compact.mjs'

test('auditSummaryFidelity：实体被摘要保留 → ratio 0', () => {
  const covered = [{ role: 'user', content: '必须保留 src/a.ts 与阈值 120' }]
  const r = auditSummaryFidelity({ covered, summary: '保留 src/a.ts，阈值 120 不变' })
  assert.equal(r.ratio, 0, `不应判定为丢失：${JSON.stringify(r)}`)
  assert.equal(r.missing.length, 0)
  assert.ok(r.total >= 3)
})

test('auditSummaryFidelity：关键实体成片丢失 → ratio 命中且 missing 具名到实体', () => {
  const covered = [{ role: 'user', content: '必须保留 src/a.ts、src/b.ts 与阈值 120' }]
  const r = auditSummaryFidelity({ covered, summary: '继续之前的开发' })
  assert.ok(r.ratio >= 0.5, `成片丢失应命中：${JSON.stringify(r)}`)
  assert.ok(r.missing.some((m) => m.includes('src/a.ts')), 'missing 要能指名道姓（供用户判断真伪）')
})

test('auditSummaryFidelity：覆盖 tool_result 内的路径（路径常只出现在工具结果里）', () => {
  const covered = [{
    role: 'user',
    content: [{ type: 'tool_result', content: '读取 kernel/cli.mjs、kernel/health.mjs、kernel/fidelity.mjs 成功，共 3 个文件' }],
  }]
  const r = auditSummaryFidelity({ covered, summary: '继续下一个任务' })
  assert.ok(r.total >= 3, `tool_result 文本也要参与实体抽取：${JSON.stringify(r)}`)
  assert.ok(r.missing.some((m) => m.includes('cli.mjs')), `工具结果里的路径丢了要能发现：${JSON.stringify(r)}`)
  assert.ok(r.ratio >= 0.5, '成片丢失')
})

test('auditSummaryFidelity：实体太少（< minEntities）不判定，标记 skipped', () => {
  const r = auditSummaryFidelity({ covered: [{ role: 'user', content: '继续' }], summary: '好' })
  assert.equal(r.skipped, true, '稀疏文本上算缺失率纯属噪声')
  assert.equal(r.ratio, 0)
})

test('parseFidelityAudit：容错解析（裸 JSON / ```json 围栏 / 垃圾输出）', () => {
  assert.deepEqual(parseFidelityAudit('垃圾输出'), { ok: false, missing: [], rewritten: [] })
  assert.deepEqual(parseFidelityAudit('{"ok":true,"missing":["a"],"rewritten":[]}').missing, ['a'])
  const fenced = parseFidelityAudit('前言\n```json\n{"ok":true,"missing":[],"rewritten":["MySQL→PostgreSQL"]}\n```\n后记')
  assert.equal(fenced.rewritten.length, 1, '围栏内的 JSON 要能解析出来')
  assert.equal(parseFidelityAudit('{"missing":["x"]}').ok, false, '缺 ok 字段视为不确定（不据此报错）')
  assert.deepEqual(parseFidelityAudit('').missing, [])
})

test('buildFidelityAuditRequest：产出 messages 数组，指令要求严格 JSON 且带两侧内容', () => {
  const msgs = buildFidelityAuditRequest({ excerpt: '原文摘录内容', summary: '摘要内容' })
  assert.ok(Array.isArray(msgs) && msgs.length >= 1, '必须是可直接交给调用方的 messages 数组')
  const all = JSON.stringify(msgs)
  assert.ok(all.includes('JSON'), '指令必须要求 JSON 输出')
  assert.ok(all.includes('原文摘录内容') && all.includes('摘要内容'), '两侧内容都要进请求')
  assert.ok(all.includes('rewritten'), '要显式要求 rewritten 字段（改写检测是本方法的核心价值）')
})

test('buildFidelityAuditRequest：两侧超长必须截断（审计请求自身不能撑爆窗口）', () => {
  const msgs = buildFidelityAuditRequest({ excerpt: 'x'.repeat(100_000), summary: 'y'.repeat(50_000) })
  const size = JSON.stringify(msgs).length
  assert.ok(size < 20_000, `审计请求必须限幅（实得 ${size} 字符）`)
})
