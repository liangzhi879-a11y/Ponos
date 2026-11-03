// EVO-09 修复验证（P2）：判据重做后，按旧判据产出的候选**永久滞留**为 new。
//
// 【缺陷】`planScanAppends` 只遍历"本轮 mined 出的候选"，对"**已存在但本轮不再产出**"的行
//   **没有任何分支** ⇒ 判据语义变更后（例如 OPP-7 从"会话指纹"改成"工具集合"），
//   旧候选既不会被清理、也不会再产出，纯粹是噪声，永久占着待办位。
//
//   实测代价：2026-10-17 处置前 85 个待处置候选里 **64 个**属此类（subject 还是
//   `sessionId:hash` 机器码），需人工逐条 dismiss 81 条才把待处理降到 0。
//
// 【为什么不能用"时间窗"当退休判据（实测无效）】旧孤儿候选的 lastAt 集中在 10-06~10-16，
//   即便把窗口放宽到 30 天它们也**不会自然到期**。"判据变了"与"窗口波动暂时不命中"是两件事。
//
// 【修法】引入 **`RULE_V`（判据语义版本）**，与 `MINE_V`（管字段形状）是两个不同维度：
//   候选行写入 `rv`；扫描时若 `prev.rv < RULE_V` 且仍为 new ⇒ **退休**（dismissed + 理由)。
//   rv 与当前相同 ⇒ 是同类判据下的正常波动，**不动**（这点是判据的关键：不能误杀）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planScanAppends, RULE_V, MINE_V } from '../kernel/opportunity-mine.mjs'

/** 造一条"存量候选"（上一个扫描周期留下的） */
const prevRow = (over = {}) => ({
  id: 'pid1', ruleId: 'OPP-7', kind: 'x', subject: 'old-subject',
  count: 5, score: 10, state: 'new', v: 2, ...over,
})

test('★ EVO-09：必须存在判据语义版本 RULE_V，且与 MINE_V 分离', () => {
  assert.equal(typeof RULE_V, 'number', '必须导出 RULE_V（判据语义版本）')
  assert.ok(RULE_V >= 1, 'RULE_V 应 ≥1')
  // 两者是不同维度：MINE_V 管字段形状、RULE_V 管判据语义。允许数值巧合但必须是两个独立导出。
  assert.equal(typeof MINE_V, 'number', 'MINE_V 必须仍导出（字段形状版本）')
})

test('★ EVO-09：旧判据（rv < RULE_V）的 new 候选必须被退休', () => {
  const latest = new Map([['pid1', prevRow({ rv: RULE_V - 1 })]])
  const rows = planScanAppends([], latest)
  const retire = rows.filter((r) => r.id === 'pid1' && r.state === 'dismissed')
  assert.equal(retire.length, 1,
    '旧判据产出的候选必须被追加一条 dismissed —— 否则它永久滞留为 new（本缺陷原形态）')
  assert.match(String(retire[0].retireReason || ''), /superseded-rule/,
    '退休理由必须写明是"判据升级"清掉的（与"用户否掉"区分，便于事后审计）')
})

test('★ EVO-09：同判据版本、本轮暂时不命中的候选**不得**被退休', () => {
  // 这是判据的关键边界：窗口波动 ≠ 判据变更。误杀会让用户正在跟的候选突然消失。
  const latest = new Map([['pid1', prevRow({ rv: RULE_V })]])
  const rows = planScanAppends([], latest)
  assert.equal(rows.filter((r) => r.id === 'pid1').length, 0,
    'rv === 当前版本的候选本轮不命中时**不得**被退休 —— 那只是窗口波动')
})

test('★ EVO-09：无 rv 字段的历史行（v2 及以前）视为旧判据，一并退休', () => {
  const latest = new Map([['pid1', prevRow()]])   // 无 rv
  const rows = planScanAppends([], latest)
  assert.equal(rows.filter((r) => r.id === 'pid1' && r.state === 'dismissed').length, 1,
    '无 rv 的历史行应视为旧判据产出并退休 —— 否则升级后这批历史噪声永远清不掉')
})

test('★ EVO-09：已裁决（dismissed/actioned）的候选不得被改动', () => {
  for (const st of ['dismissed', 'actioned']) {
    const latest = new Map([['pid1', prevRow({ rv: 0, state: st })]])
    const rows = planScanAppends([], latest)
    assert.equal(rows.filter((r) => r.id === 'pid1').length, 0,
      `已裁决为 ${st} 的候选不得被退休逻辑碰 —— 尊重既有裁决`)
  }
})

test('★ EVO-09：本轮仍命中的候选走正常流程，不被误退休', () => {
  const latest = new Map([['pid1', prevRow({ rv: 0 })]])
  const mined = [{ id: 'pid1', ruleId: 'OPP-7', kind: 'x', subject: 'old-subject', count: 6, score: 12 }]
  const rows = planScanAppends(mined, latest)
  const forPid1 = rows.filter((r) => r.id === 'pid1')
  assert.equal(forPid1.length, 1, '本轮仍命中的候选只应追加一条（不该再叠加一条退休行）')
  assert.notEqual(forPid1[0].state, 'dismissed', '仍命中的候选不得被退休')
})

test('★ EVO-09：退休行必须带 rv（避免下一轮被自己再退休一次）', () => {
  const latest = new Map([['pid1', prevRow({ rv: 0 })]])
  const rows = planScanAppends([], latest)
  const retire = rows.find((r) => r.id === 'pid1')
  assert.equal(retire.rv, RULE_V,
    '退休行必须写入当前 rv —— 否则它会被下一轮当成"旧判据行"再退休一次')
})
