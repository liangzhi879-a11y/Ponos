// src/stores/healthStore.test.ts
// node --test src/stores/healthStore.test.ts
// 覆盖 store 的快照搬运逻辑（组件与 useYFWCLI 都依赖它，但目前只有 tsc 把关）。
// 需要 localStorage 垫片：store 用 persist(createJSONStorage(() => localStorage))。
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---- localStorage 垫片（必须在 import store 之前装好） ----
const mem = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  removeItem: (k: string) => { mem.delete(k) },
  clear: () => { mem.clear() },
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size },
} as Storage

const { useHealthStore } = await import('./healthStore.ts')
const { distortionOf } = await import('../lib/healthUi.ts')
type HealthInfo = import('./healthStore.ts').HealthInfo
type DistortionInfo = import('../lib/healthUi.ts').DistortionInfo

const SID = 's1'

/** 压力红 + 失真红的快照；用覆盖参数构造变体（避免字面量类型锁死） */
function health(over: Partial<DistortionInfo> = {}): HealthInfo {
  return {
    score: 90, tier: 'red', compactCount: 1, remainingPct: 9, remainingTurns: 158,
    suggestNewSession: true, reason: '压力档',
    distortion: {
      score: 85, tier: 'red', axes: { memory: 0, coherence: 60, goal: 0 },
      issues: [{ id: 'c:1', axis: 'coherence', kind: 'stale_ref', strength: 'strong', turn: 3, evidence: '引用了已删除的 x', at: '' }],
      trigger: 'c:1', observeUntilTurn: null, anchorAvailable: true, anchorText: '锚点',
      ...over,
    },
  }
}

function reset() {
  useHealthStore.setState({
    healthBySession: {}, summaryBySession: {}, summaryCompactCountBySession: {},
    dismissedUntilBySession: {}, distortionShownIdsBySession: {}, dismissedDistortionUntilBySession: {},
  })
}

test('update：失真未消除时累积证据（内核窗口滑走后旧证据仍可核对）', () => {
  reset()
  const { update } = useHealthStore.getState()
  update(SID, health())
  update(SID, health({ issues: [{ ...health().distortion!.issues[0], id: 'c:2', turn: 5 }] }))
  const issues = distortionOf(useHealthStore.getState().healthBySession[SID]).issues
  assert.deepEqual(issues.map(i => i.id), ['c:1', 'c:2'], '应累积两条证据')
})

test('update：回绿即丢弃累积证据（不显示已消除的旧证据）', () => {
  reset()
  const { update } = useHealthStore.getState()
  update(SID, health())
  update(SID, health({ tier: 'green', score: 0, issues: [], trigger: null, anchorAvailable: false }))
  assert.deepEqual(distortionOf(useHealthStore.getState().healthBySession[SID]).issues, [])
})

test('markDistortionShown：去重 + 上限（防持久化快照无限增长）', () => {
  reset()
  const { markDistortionShown } = useHealthStore.getState()
  markDistortionShown(SID, 'a')
  markDistortionShown(SID, 'a')
  assert.deepEqual(useHealthStore.getState().distortionShownIdsBySession[SID], ['a'], '同键不重复登记')
  markDistortionShown(SID, '')
  assert.deepEqual(useHealthStore.getState().distortionShownIdsBySession[SID], ['a'], '空键忽略')
  for (let i = 0; i < 60; i++) markDistortionShown(SID, `k${i}`)
  const list = useHealthStore.getState().distortionShownIdsBySession[SID]
  assert.equal(list.length, 50, '上限 50（保留最近）')
  assert.equal(list[list.length - 1], 'k59')
})

test('clearDistortion：丢弃失真快照与失真 UI 状态，但保留压力档', () => {
  // 内核失真证据只存在于进程内（不落盘）；新内核进程的失真态是空的（green）。
  // 若不清理：新内核首轮绿档不发事件 → 旧的红色卡片/角标/泛光永久赖着，且"关闭"只
  // 冷却 5 分钟 → 反复复现（与 15811 假红同族的假警报），锚点文本也是过期的。
  reset()
  const st = useHealthStore.getState()
  st.update(SID, health())
  st.markDistortionShown(SID, 'c:1')
  st.dismissDistortion(SID)
  st.clearDistortion(SID)

  const after = useHealthStore.getState()
  const h = after.healthBySession[SID]
  assert.ok(h, '压力快照必须保留（血条不该瞬间回满）')
  assert.equal(h.tier, 'red', '压力档保留')
  assert.equal(h.remainingPct, 9, '压力数值保留')
  assert.equal(h.distortion, undefined, '失真快照必须丢弃')
  assert.equal(distortionOf(h).tier, 'green', '失真读作 green（无角标/卡片/泛光）')
  assert.deepEqual(after.distortionShownIdsBySession[SID], undefined, '失真去抖键随进程失效而清空')
  assert.deepEqual(after.dismissedDistortionUntilBySession[SID], undefined, '失真冷却一并清空')
  // 未登记的会话：调用不应抛异常，也不该制造空快照
  st.clearDistortion('no-such-session')
  assert.equal(useHealthStore.getState().healthBySession['no-such-session'], undefined)
})

test('reset：清空该会话全部健康与失真状态（全新会话路径）', () => {
  reset()
  const st = useHealthStore.getState()
  st.update(SID, health())
  st.markDistortionShown(SID, 'c:1')
  st.dismissDistortion(SID)
  st.reset(SID)
  const after = useHealthStore.getState()
  assert.equal(after.healthBySession[SID], undefined)
  assert.equal(after.distortionShownIdsBySession[SID], undefined)
  assert.equal(after.dismissedDistortionUntilBySession[SID], undefined)
})
