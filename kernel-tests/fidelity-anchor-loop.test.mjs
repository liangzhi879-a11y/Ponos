// 锚定闭环修复（A 客观回绿 + D 断反馈环）——2026-09-16 活跃度巡检后续
// ---------------------------------------------------------------------------
// 问题（已实证，非推测）：
//
//  ① **锚点"已在模型侧生效"没有任何通道回流健康度模块**。`snapshot()` 的
//     `anchorAvailable = tier === 'red'`，而 issue 的 `turn` 创建时钉死、退出计分只靠
//     `turn - windowTurns`（12 轮）轮龄 —— 与"模型是否已按锚点恢复"完全无关。消解路径
//     只有 `markResolved`（GUI 回传，health.mjs:249 注释自陈"保持 GUI 回传为唯一人工确认
//     路径"）。实测：模型连续 6 轮完整复述确认后，`tier/score/issues` **一字不变**，
//     直到第 13 轮才因轮龄出窗回绿 ⇒ 若模型第 1 轮就恢复，剩下 11 轮锚定全是白花（~90%）。
//
//  ② **强制复述会"制造"新的失真证据，形成自维持反馈环**。压缩前模型自述"端口是 8080"，
//     压缩后锚点要求"先复述关键事实确认"，模型按权威值复述"端口是 51517" → 同一 key 两个
//     取值分处不同轮 → 被判 `c:contradiction`。可这不是失真、是**勘误**，而且是锚点自己
//     要求的勘误（spec 只排除了"已改为"这类显式演进语，模型不会这么说）。后果：锚定 →
//     复述 → 新增矛盾证据 → 失真分被自己抬高、窗口延长 → 更多锚定。
//
// 修复（本文件钉死四条不许退化的边界）：
//   A 客观回绿：用**工具记录**（真值优先级②）确定性核实"缺失实体已重回上下文"→ 自动消解
//     该 `m:summary:*`；**绝不**采信模型自述（守铁律②"模型自评最高只到 medium"）。
//   D 断反馈环：标记"本轮请求注过锚点"→ 该轮事实视作权威更新（覆盖历史同 key），不计矛盾。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFidelity, entityRegained } from '../kernel/fidelity.mjs'

const ENTITIES = ['src/a.ts', 'src/b.ts', 'src/c.ts']
// 缺失率 2/3 = 0.67 ≥ summaryMissingStrong(0.4) ⇒ strong ⇒ tier=red
const MISSING = ['src/b.ts', 'src/c.ts']

function redFidelity() {
  const fid = createFidelity({})
  fid.recordCompactionAudit({ entities: ENTITIES, missing: MISSING, ratio: 2 / 3 })
  return fid
}
const issueIds = (fid) => fid.snapshot().issues.map((i) => i.id)
const digestOk = (path) => ({ name: 'Read', path, isError: false })
const digestErr = (path) => ({ name: 'Read', path, isError: true })

// ===========================================================================
// A 客观回绿
// ===========================================================================
test('A1 客观回绿：缺失实体被成功读取 ⇒ 该证据自动消解、档位随证据清零而回绿', () => {
  const fid = redFidelity()
  assert.equal(fid.snapshot().tier, 'red', '前置：压缩丢关键实体应进 red')
  assert.ok(issueIds(fid).includes('m:summary:src/b.ts'))

  // 工具**成功读取**了 src/b.ts（绝对路径）⇒ 该实体已重回上下文 = 确定性事实
  fid.recordTurn({ user: '继续', assistant: '已核对。', toolDigest: [digestOk('C:/work/src/b.ts')] })
  assert.ok(!issueIds(fid).includes('m:summary:src/b.ts'),
    `成功读取后该记忆证据应自动消解，实际仍active=${JSON.stringify(issueIds(fid))}`)
  // 另一实体（src/c.ts）未读回 ⇒ 不得被连带消解（逐实体核实，不做整档清空）
  assert.ok(issueIds(fid).includes('m:summary:src/c.ts'), '未读回的实体必须仍保留证据')
  assert.equal(fid.snapshot().tier, 'red', '仍有 strong 证据 ⇒ 仍 red')

  // 读回最后一个 ⇒ 证据清零 ⇒ 回绿
  fid.recordTurn({ user: '继续', assistant: '已核对。', toolDigest: [digestOk('C:/work/src/c.ts')] })
  assert.deepEqual(issueIds(fid), [], '全部读回后不应再有 active 证据')
  assert.equal(fid.snapshot().tier, 'green', '证据清零 ⇒ 回绿')
  assert.equal(fid.snapshot().anchorAvailable, false, '回绿后锚点应停止注入（这就是省 token 的地方）')
})

test('A2 判据只认成功真值：失败读取不得回绿', () => {
  const fid = redFidelity()
  fid.recordTurn({ user: '继续', assistant: '读取失败。', toolDigest: [digestErr('C:/work/src/b.ts')] })
  assert.ok(issueIds(fid).includes('m:summary:src/b.ts'),
    '工具报错的路径不算"已重回上下文"——读失败恰恰说明实体仍不可达')
  assert.equal(fid.snapshot().tier, 'red')
})

test('A3 无关路径不得回绿（防"读任意文件即清空证据"）', () => {
  const fid = redFidelity()
  fid.recordTurn({ user: '继续', assistant: '读了别的文件。', toolDigest: [digestOk('C:/work/src/zzz-other.ts'), digestOk('package.json')] })
  assert.deepEqual(issueIds(fid), ['m:summary:src/b.ts', 'm:summary:src/c.ts'], '无关路径不得消解任何证据')
  assert.equal(fid.snapshot().tier, 'red')
})

test('A4 ★ 绝不采信模型自述：声称"我已恢复/文件有效"不得回绿（守铁律②）', () => {
  const fid = redFidelity()
  // 锚点文案自带缺失实体清单 ⇒ 若拿模型复述当依据，必然假绿、绕过"不信任自述"铁律
  fid.recordTurn({
    user: '继续',
    assistant: '关键事实确认：src/b.ts、src/c.ts 均有效，我已按锚点恢复记忆，上下文无失真。',
  })
  assert.deepEqual(issueIds(fid), ['m:summary:src/b.ts', 'm:summary:src/c.ts'],
    '模型自述恢复不构成任何证据变化（自评最高只到 medium，何况这里连工具记录都没有）')
  assert.equal(fid.snapshot().tier, 'red')
})

test('A5 客观回绿打 autoResolved 标记，与 GUI 人工消解可区分', () => {
  const fid = redFidelity()
  fid.recordTurn({ user: '继续', assistant: '已核对。', toolDigest: [digestOk('src/b.ts')] })
  const ev = fid.evidenceLog()
  const auto = ev.resolved.find((i) => i.id === 'm:summary:src/b.ts')
  assert.ok(auto, '应出现在 resolved 列表')
  assert.equal(auto.autoResolved, true, '客观回绿须带 autoResolved 标记（审计与前端区分人工/客观）')
  // 人工路径仍独立可用（GUI 回传），且不误标 auto
  const n = fid.markResolved(['m:summary:src/c.ts'])
  assert.equal(n, 1, 'GUI 回传路径仍可消解')
  const manual = fid.evidenceLog().resolved.find((i) => i.id === 'm:summary:src/c.ts')
  assert.ok(manual && !manual.autoResolved, '人工消解不得被标成 auto')
})

test('A6 逐实体判据 entityRegained：相对/绝对路径互通，但不得跨文件名误匹配', () => {
  const digest = [digestOk('C:/Users/x/yfworking/src/lib/mcpApi.ts')]
  assert.equal(entityRegained('src/lib/mcpApi.ts', digest), true, '相对实体 vs 绝对路径 → 命中')
  assert.equal(entityRegained('C:/Users/x/yfworking/src/lib/mcpApi.ts', [digestOk('src/lib/mcpApi.ts')]), true, '反向亦命中')
  assert.equal(entityRegained('mcpApi.ts', digest), true, 'basename 命中')
  assert.equal(entityRegained('src/lib/other.ts', digest), false, '不同文件名不得命中')
  assert.equal(entityRegained('src/other/mcpApi.ts', digest), false, '同名不同目录不得命中（防"同名即算恢复"）')
  assert.equal(entityRegained('', digest), false)
  assert.equal(entityRegained('src/lib/mcpApi.ts', []), false)
  assert.equal(entityRegained('src/lib/mcpApi.ts', [digestErr('C:/Users/x/yfworking/src/lib/mcpApi.ts')]), false, '失败读取不算恢复')
})

// ===========================================================================
// E health 层接线 + 反挂账（单测通过但"没接线"= 白做，故在此钉死端到端通路）
// ===========================================================================
test('E1 health 层通路：recordTurnContent 带回绿、markFidelityAnchorInjected 报告已注入', async () => {
  const { createHealth } = await import('../kernel/health.mjs')
  const h = createHealth({ wire: { send() {} }, env: { PONOS_FIDELITY: '1' } })

  h.recordCompactionAudit({ entities: ENTITIES, missing: MISSING, ratio: 2 / 3 })
  assert.ok(h.fidelityAnchor(), '前置：压缩丢实体 ⇒ red ⇒ 提供锚点（engine 就是读这个来注入）')

  // ① 注入回报 → fidelity 侧标记（返回 1 = 确实设了权威标记）
  assert.equal(h.markFidelityAnchorInjected(ANCHOR_TEXT), 1, 'health 必须把注入回报转发给 fidelity')

  // ② 工具成功读取缺失实体 ⇒ 客观回绿（经 health.recordTurnContent 完整通路）
  h.recordTurnContent({
    user: '继续',
    assistant: '已核对。',
    toolDigest: [digestOk('C:/work/src/b.ts'), digestOk('C:/work/src/c.ts')],
  })
  assert.equal(h.fidelityAnchor(), null,
    '★ 两个实体都被工具读回 ⇒ 证据清零 ⇒ 回绿 ⇒ 不再提供锚点（后续请求不再重复注入，省 token 的落点）')
})

test('E2 反挂账：engine 必须回报锚点注入（否则 D 的标记永不设置、形同虚设）', () => {
  const src = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf-8')
  assert.ok(src.includes('markFidelityAnchorInjected'),
    'engine 注入锚点处必须回调 health.markFidelityAnchorInjected——只读锚点而不回报，D 断不了反馈环')
  // 必须在"确实注入"的分支里回报（节流跳过的分支不得回报：那步模型没看到锚点）
  const injectIdx = src.indexOf('anchorFace = withAnchorTail(face, a.text)')
  const markIdx = src.indexOf('markFidelityAnchorInjected')
  assert.ok(injectIdx > 0 && markIdx > injectIdx,
    '回报须紧跟在"确实注入"之后（withAnchorTail 之后），不得落到节流跳过分支')
  const healthSrc = readFileSync(new URL('../kernel/health.mjs', import.meta.url), 'utf-8')
  assert.ok(healthSrc.includes('markFidelityAnchorInjected'), 'health 必须暴露该回报入口')
})

test('E3 反挂账：A 的输入链路必须真的把 toolDigest 送进来（否则客观回绿永不触发）', () => {
  const src = readFileSync(new URL('../kernel/engine.mjs', import.meta.url), 'utf-8')
  assert.ok(/recordTurnContent\?\.\(\{[\s\S]{0,400}toolDigest:/.test(src),
    'engine 轮尾须把 outcome.toolDigest 传给 recordTurnContent（A 判据的输入）')
  const fidSrc = readFileSync(new URL('../kernel/fidelity.mjs', import.meta.url), 'utf-8')
  assert.ok(/const digest = Array\.isArray\(input\.toolDigest\)/.test(fidSrc),
    'fidelity.recordTurn 须从 input.toolDigest 取摘要（字段名一致才通）')
  // 判据只认成功：isError 为真必须被跳过（防"读失败也当恢复"）
  assert.ok(/if \(!d \|\| d\.isError\) continue/.test(fidSrc),
    'entityRegained 必须跳过 isError 的条目')
})

// ===========================================================================
// D 断反馈环
// ===========================================================================
// 锚点原文实例（含权威端口 51517 与缺失实体；**不含**模型名——用于验证豁免只覆盖
// "值确实出现在锚点里"的那部分，而不是把整轮放行）
const ANCHOR_TEXT = [
  '【上下文锚定 · 权威事实】',
  '■ 此前摘要遗漏、现已补回的关键事实',
  '- src/b.ts',
  '- src/c.ts',
  '■ 会话记忆（任务清单 / 文件变更 / 最近决策）',
  '- 服务端口是 51517',
  '若上述事实与你记忆中的内容冲突，以上述为准；请先复述关键事实确认，再继续任务。',
].join('\n')

test('D1 断反馈环：锚点注入轮里复述锚点权威值，不被判成自相矛盾', () => {
  const fid = createFidelity({})
  // 压缩前模型自述过端口 8080（进入事实历史）
  fid.recordTurn({ user: '服务端口是多少？', assistant: '服务端口是 8080。' })
  fid.recordCompactionAudit({ entities: ENTITIES, missing: MISSING, ratio: 2 / 3 })
  // 引擎确实注入了锚点（带上锚点原文——判据按值比对，必须传）
  fid.markAnchorInjected(ANCHOR_TEXT)
  // 模型按锚点要求复述权威值——这正是锚点文案要求的动作，属**勘误**而非失真
  fid.recordTurn({ user: '继续', assistant: '按权威事实确认：服务端口是 51517。' })

  const ids = issueIds(fid)
  assert.ok(!ids.some((i) => i.startsWith('c:contradiction:port')),
    `锚点轮复述权威值不得被判自相矛盾（那是勘误，不是失真），实际=${JSON.stringify(ids)}`)
})

test('D2 对照：未注入锚点时同样文本仍判矛盾（证明 D 判据确有作用、非空转）', () => {
  const fid = createFidelity({})
  fid.recordTurn({ user: '服务端口是多少？', assistant: '服务端口是 8080。' })
  fid.recordCompactionAudit({ entities: ENTITIES, missing: MISSING, ratio: 2 / 3 })
  // 不调用 markAnchorInjected —— 同 D1 的文本
  fid.recordTurn({ user: '继续', assistant: '按权威事实确认：服务端口是 51517。' })
  assert.ok(issueIds(fid).some((i) => i.startsWith('c:contradiction:port')),
    '非锚点轮的同一 key 互斥取值仍须判矛盾（否则 D 会把矛盾检测整条改废）')
})

test('D3 锚点轮里与锚点无关的 key 矛盾照抓（豁免按值，不是整轮放行）', () => {
  const fid = createFidelity({})
  fid.recordTurn({ user: '配置确认', assistant: '会话模型是 claude-sonnet-4-5。' })
  fid.recordCompactionAudit({ entities: ENTITIES, missing: MISSING, ratio: 2 / 3 })
  fid.markAnchorInjected(ANCHOR_TEXT)
  // 同轮里既复述了锚点权威值（端口 51517），又冒出锚点里没有的另一种模型名
  fid.recordTurn({ user: '继续', assistant: '按权威事实确认：服务端口是 51517。另外模型是 gpt-5-mini。' })
  const ids = issueIds(fid)
  assert.ok(ids.some((i) => i.startsWith('c:contradiction:model')),
    `锚点未提及的 key 出现互斥取值仍须检测，实际=${JSON.stringify(ids)}`)
  assert.ok(!ids.some((i) => i.startsWith('c:contradiction:port')),
    '锚点里的权威值仍应豁免')
})

test('D6 ★ 锚点轮里编造一个锚点中不存在的取值，照抓（防"整轮免检"漏洞）', () => {
  const fid = createFidelity({})
  fid.recordTurn({ user: '服务端口是多少？', assistant: '服务端口是 8080。' })
  fid.recordCompactionAudit({ entities: ENTITIES, missing: MISSING, ratio: 2 / 3 })
  fid.markAnchorInjected(ANCHOR_TEXT)
  // 51517 在锚点里、7777 不在 —— 说 7777 是编造，必须判矛盾
  fid.recordTurn({ user: '继续', assistant: '服务端口是 7777。' })
  assert.ok(issueIds(fid).some((i) => i.startsWith('c:contradiction:port')),
    '锚点里没有的取值不得豁免（否则注入锚点等于给模型一张任意改口的免检牌）')
})

test('D7 空锚点文本不设权威标记（否则等于整轮放行）', () => {
  const fid = createFidelity({})
  fid.recordTurn({ user: '服务端口是多少？', assistant: '服务端口是 8080。' })
  fid.recordTurn({ user: '继续', assistant: '服务端口是 51517。' })
  fid.markAnchorInjected('')
  fid.recordTurn({ user: '继续', assistant: '服务端口是 7777。' })
  assert.ok(issueIds(fid).some((i) => i.startsWith('c:contradiction:port')), '空锚点不得开豁免')
})

test('D8 ★ 豁免沿 key 传递：模型在后续多轮持续复述权威值，仍不得报矛盾', () => {
  // 这条是**真实验证时抓到的漏网情形**：只豁免注入轮那一条不够——锚点让模型在后续轮里
  // 持续保持正确取值，第 2 轮起再复述同一权威值时会与压缩前的旧自述重新配对并报矛盾
  // （假失真照旧，只是延后 1 轮）。故豁免须沿 key 传递：较晚侧取值 = 该 key 的权威取值
  // ⇒ 视为复述，不计矛盾。（量化验证脚本实测：修好前 coherence 轴 16→18、假矛盾 1 个。）
  const fid = createFidelity({})
  fid.recordTurn({ user: '服务端口是多少？', assistant: '服务端口是 8080。' })
  fid.recordCompactionAudit({ entities: ENTITIES, missing: MISSING, ratio: 2 / 3 })
  fid.markAnchorInjected(ANCHOR_TEXT)
  fid.recordTurn({ user: '继续', assistant: '按权威事实确认：服务端口是 51517。' })
  for (let i = 0; i < 4; i++) {
    fid.recordTurn({ user: '继续', assistant: '服务端口是 51517，与锚点一致。' })
  }
  assert.ok(!issueIds(fid).some((i) => i.startsWith('c:contradiction:port')),
    `持续复述权威值不得在第 2..5 轮重新冒矛盾，实际=${JSON.stringify(issueIds(fid))}`)
})

test('D9 模型从权威值改口成任意非权威值：照抓（豁免不是免check牌）', () => {
  const fid = createFidelity({})
  fid.recordTurn({ user: '服务端口是多少？', assistant: '服务端口是 8080。' })
  fid.recordCompactionAudit({ entities: ENTITIES, missing: MISSING, ratio: 2 / 3 })
  fid.markAnchorInjected(ANCHOR_TEXT)
  fid.recordTurn({ user: '继续', assistant: '按权威事实确认：服务端口是 51517。' })
  fid.recordTurn({ user: '继续', assistant: '服务端口是 51517。' })
  // 之后改口成一个既非旧值、也非权威值的数字 → 真失真
  fid.recordTurn({ user: '继续', assistant: '其实端口是 31337。' })
  assert.ok(issueIds(fid).some((i) => i.startsWith('c:contradiction:port')),
    '非权威取值之间的互斥仍须判矛盾')
})

test('D4 标记一次性消费：下一轮（未注入）同 key 互斥取值仍判矛盾', () => {
  const fid = createFidelity({})
  fid.recordTurn({ user: '服务端口是多少？', assistant: '服务端口是 8080。' })
  fid.recordCompactionAudit({ entities: ENTITIES, missing: MISSING, ratio: 2 / 3 })
  fid.markAnchorInjected(ANCHOR_TEXT)
  fid.recordTurn({ user: '继续', assistant: '按权威事实确认：服务端口是 51517。' })
  // 下一轮没有注入锚点，模型又说了第三个取值 → 真失真，必须抓
  fid.recordTurn({ user: '继续', assistant: '你刚才说的端口是 9999 吧。' })
  assert.ok(issueIds(fid).some((i) => i.startsWith('c:contradiction:port')),
    '锚点授权只覆盖注入当轮，后续轮次的矛盾照常检测')
})

test('D5 未注入锚点时不得有隐式权威（默认行为不变）', () => {
  const fid = createFidelity({})
  fid.recordTurn({ user: '服务端口是多少？', assistant: '服务端口是 8080。' })
  fid.recordTurn({ user: '继续', assistant: '服务端口是 51517。' })
  assert.ok(issueIds(fid).some((i) => i.startsWith('c:contradiction:port')),
    'fidelity 默认不得自作主张把某轮当权威（只有 engine 明确注入锚点才算）')
})
