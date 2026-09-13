// app-agent.cjs 单测：自主探索框架的编排逻辑（全部用假模型/假工具，不碰网络与真 LLM）
//
// 为什么这些用例值得存在：框架的价值全在"编排"上——把控制权交给模型、把**真实**结果回喂、
// 预算/早停兜底、质量门槛把住"能跑但没法用"的产物。这些逻辑一旦写错，表现是"生成很慢/命令很烂"，
// 在真机上极难定位（要跑真模型、真站点、等好几分钟）。所以全部用脚本化假模型钉死。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const {
  runAgentLoop, parseTurn, checkSpecQuality, renderLog, buildAgentSystem, buildAgentSeed,
  toolResultText, describeToolCall, DEFAULT_BUDGET,
} = require('../electron/app-agent.cjs')

const goodSpec = (n = 3) => ({
  specVersion: 1, appId: 'x', name: '示例站', target: { type: 'web', url: 'https://example.com/' }, expose: { mode: 'console' },
  commands: Array.from({ length: n }, (_, i) => ({
    action: `listItems${i}`,
    title: `查询条目清单${i}`,
    kind: 'read',
    params: [],
    steps: [{ act: 'goto', url: `/list/${i}` }, { act: 'snapshot', save: 'result' }],
    returns: { type: 'text', from: 'result' },
  })),
})
const submit = (spec) => JSON.stringify({ thought: '写完了', tool: 'submit_spec', spec })
const say = (obj) => JSON.stringify(obj)

/** 脚本化假模型：按顺序返回；用尽后重复最后一条 */
function scripted(texts) {
  let i = 0
  const calls = []
  const fn = async (p) => {
    calls.push(p)
    const text = texts[Math.min(i, texts.length - 1)]
    i += 1
    if (typeof text === 'function') return text(p, i)
    return { ok: true, text, error: null, chars: String(text).length }
  }
  fn.calls = calls
  return fn
}

// ---------- 解析 ----------

test('parseTurn：工具调用 / submit_spec / 裸 Spec / 垃圾输出', () => {
  assert.deepEqual(parseTurn(say({ thought: 'x', tool: 'fetch_page', args: { url: 'https://a.com' } })).tool, 'fetch_page')
  assert.equal(parseTurn(submit(goodSpec(1))).kind, 'spec')
  assert.equal(parseTurn(JSON.stringify(goodSpec(1))).kind, 'spec', '直接给出 Spec 也算提交（宽容）')
  assert.equal(parseTurn('```json\n' + submit(goodSpec(1)) + '\n```').kind, 'spec', '带代码块也要能读')
  assert.equal(parseTurn('我认为应该先看看页面').kind, 'bad')
  assert.equal(parseTurn('').kind, 'bad')
})

// ---------- 质量门槛（"封装格式质量要求"落地的地方） ----------

test('checkSpecQuality：占位语 title / 参数说明缺失 → 硬错误（产物不可用）', () => {
  const bad = {
    commands: [{
      action: 'query', title: 'TODO', kind: 'read',
      params: [{ name: 'q', type: 'string', required: true, desc: '待补充' }, { name: 'p', type: 'number', required: false }],
      steps: [{ act: 'goto', url: '/list' }],
    }],
  }
  const q = checkSpecQuality(bad, { hasMaterial: true })
  assert.equal(q.ok, false)
  assert.ok(q.errors.some((e) => e.includes('占位语') && e.includes('title')), q.errors.join('｜'))
  assert.ok(q.errors.some((e) => e.includes('占位语') && e.includes('desc')), q.errors.join('｜'))
  assert.ok(q.errors.some((e) => e.includes('缺少 desc')), q.errors.join('｜'))
})

test('checkSpecQuality：action 命名非法 / 没有 read 命令 → 硬错误', () => {
  const q1 = checkSpecQuality({ commands: [{ action: '查 询 列表', title: '查询列表', kind: 'read', params: [], steps: [] }] })
  assert.ok(q1.errors.some((e) => e.includes('action 不规范')), q1.errors.join('｜'))
  const q2 = checkSpecQuality({ commands: [{ action: 'doIt', title: '提交表单', kind: 'write', params: [], steps: [] }] })
  assert.ok(q2.errors.some((e) => e.includes('read 命令')), q2.errors.join('｜'))
})

test('checkSpecQuality：命令数偏少 / 缺 returns / 都在同一页面 → 只提示不拦（避免永远交不出东西）', () => {
  const spec = { commands: [{ action: 'listAll', title: '查询全部', kind: 'read', params: [], steps: [{ act: 'goto', url: '/list' }] }] }
  const q = checkSpecQuality(spec, { hasMaterial: true })
  assert.equal(q.ok, true, '这些属偏好，不该阻塞交付')
  assert.ok(q.warnings.some((w) => w.includes('命令数偏少')), q.warnings.join('｜'))
  assert.ok(q.warnings.some((w) => w.includes('returns')), q.warnings.join('｜'))
})

test('checkSpecQuality：合格产物零错误零提示', () => {
  const q = checkSpecQuality(goodSpec(3), { hasMaterial: true })
  assert.equal(q.ok, true)
  assert.deepEqual(q.warnings, [], q.warnings.join('｜'))
})

// ---------- 编排 ----------

test('runAgentLoop：探索 → 提交 → 试跑通过；工具结果真的回喂给了模型', async () => {
  const llm = scripted([
    say({ thought: '先抓详情页', tool: 'fetch_page', args: { url: 'https://example.com/detail' } }),
    submit(goodSpec(3)),
  ])
  const toolCalls = []
  const r = await runAgentLoop({
    target: { type: 'web', url: 'https://example.com/' }, driver: 'browser', probeMode: 'http', probeMaterial: { title: '首页', interactives: 5 },
    callLlm: llm,
    runTool: async ({ tool, args }) => { toolCalls.push({ tool, args }); return { ok: true, summary: '抓到了：详情页有 3 个按钮' } },
    verify: async (spec) => ({ ok: true, tried: ['listItems0'], failures: [] }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.equal(r.toolCalls, 1)
  assert.equal(toolCalls[0].tool, 'fetch_page')
  assert.ok(r.trace.some((t) => t.kind === 'tool' && t.tool === 'fetch_page'), '轨迹要记下模型的探索动作')
  assert.ok(r.trace.some((t) => t.kind === 'thought'), '轨迹要记下模型的思路')
  assert.ok(llm.calls[1].user.includes('抓到了：详情页有 3 个按钮'), '工具结果必须回喂给模型（否则"自主探索"是假的）')
})

test('runAgentLoop：试跑失败 → 真实报错回喂 → 模型改好 → 通过（自我调试闭环）', async () => {
  const llm = scripted([
    submit(goodSpec(3)),
    submit({ ...goodSpec(3), commands: goodSpec(3).commands.map((c) => ({ ...c, steps: [{ act: 'goto', url: '/fixed' }, { act: 'snapshot', save: 'result' }] })) }),
  ])
  let rounds = 0
  const r = await runAgentLoop({
    target: { type: 'web', url: 'https://example.com/' }, probeMode: 'http', probeMaterial: { title: 'T' },
    callLlm: llm,
    runTool: async () => ({ ok: true, summary: 'ok' }),
    verify: async () => (++rounds === 1
      ? { ok: false, tried: ['listItems0'], failures: [{ action: 'listItems0', error: '步骤 js 失败：js 缺少 expression' }] }
      : { ok: true, tried: ['listItems0'], failures: [] }),
  })
  assert.equal(r.verified, true, '修订后应通过')
  assert.equal(rounds, 2, '应真的试跑两轮')
  assert.ok(llm.calls[1].user.includes('js 缺少 expression'), '真实报错必须原样回喂（模型靠它调试）')
  assert.ok(r.verify.ok)
})

test('runAgentLoop：模型用 run_command 试跑，草稿会传给工具（没有草稿时如实说明）', async () => {
  const seen = []
  // 注意顺序：只有"提交过一版但没通过试跑"之后才会有草稿，所以第一轮先试跑（无草稿），
  // 第二轮试跑（有草稿），最后一轮提交修订版
  const llm = scripted([
    say({ thought: '先试着跑一下（还没有草稿）', tool: 'run_command', args: { action: 'listItems0', args: {} } }),
    submit(goodSpec(3)),
    say({ thought: '再跑一次看看', tool: 'run_command', args: { action: 'listItems0', args: {} } }),
    submit(goodSpec(3)),
  ])
  let verifyRound = 0
  const r = await runAgentLoop({
    target: { type: 'web', url: 'https://example.com/' }, probeMode: 'http', probeMaterial: { title: 'T' },
    callLlm: llm,
    runTool: async ({ tool, args, draft }) => { seen.push({ tool, action: args?.action, hasDraft: !!draft }); return { ok: true, summary: 'ok' } },
    verify: async () => (++verifyRound === 1
      ? { ok: false, tried: ['listItems0'], failures: [{ action: 'listItems0', error: '元素不存在' }] }
      : { ok: true, tried: ['listItems0'], failures: [] }),
  })
  assert.equal(r.ok, true)
  assert.equal(seen[0].hasDraft, false, '第一轮没有草稿，要如实告诉模型')
  assert.ok(seen.some((s) => s.hasDraft === true), '提交过草稿后应把草稿交给工具（模型才能试跑调试）')
})

test('runAgentLoop：模型原地打转 → 早停（不耗满预算），并如实报告', async () => {
  const junk = { commands: [{ action: 'doIt', title: 'TODO', kind: 'write', params: [], steps: [] }] }
  const r = await runAgentLoop({
    target: { type: 'web', url: 'https://example.com/' }, probeMode: 'http', probeMaterial: { title: 'T' },
    callLlm: scripted([submit(junk)]),
    runTool: async () => ({ ok: true, summary: '' }),
    verify: async () => ({ ok: true, tried: [], failures: [] }),
  })
  assert.equal(r.ok, false, '质量不达标就不该产出 Spec')
  assert.equal(r.stoppedBy, 'no-progress')
  assert.ok(r.turns <= 4, `应早停而不是耗满 ${DEFAULT_BUDGET.maxTurns} 轮，实际 ${r.turns}`)
  assert.ok(r.issues.some((i) => i.includes('早停')), r.issues.join('｜'))
})

test('runAgentLoop：输出读不懂 → 连续 3 次早停（bad-output）', async () => {
  const r = await runAgentLoop({
    target: { type: 'web', url: 'https://example.com/' }, probeMode: 'http', probeMaterial: { title: 'T' },
    callLlm: scripted(['随便说点什么', '还是不说 JSON', '我真不会']),
    runTool: async () => ({ ok: true, summary: '' }),
    verify: async () => ({ ok: true, tried: [], failures: [] }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.stoppedBy, 'bad-output')
  assert.equal(r.turns, 3)
})

test('runAgentLoop：工具调用次数用尽 → 用完即提示提交，不再执行工具', async () => {
  const llm = scripted([
    say({ tool: 'fetch_page', args: { url: 'https://a/1' } }),
    say({ tool: 'fetch_page', args: { url: 'https://a/2' } }),
    submit(goodSpec(3)),
  ])
  let executed = 0
  const r = await runAgentLoop({
    target: { type: 'web', url: 'https://example.com/' }, probeMode: 'http', probeMaterial: { title: 'T' },
    budget: { maxToolCalls: 1 },
    callLlm: llm,
    runTool: async () => { executed += 1; return { ok: true, summary: 'ok' } },
    verify: async () => ({ ok: true, tried: [], failures: [] }),
  })
  assert.equal(executed, 1, '超出上限的工具调用不得执行')
  assert.equal(r.toolCalls, 1)
  assert.equal(r.ok, true)
  assert.ok(llm.calls[2].user.includes('上限'), '要明确告诉模型别再调工具了、赶紧提交')
})

test('runAgentLoop：模型调用失败 / 时间预算耗尽 → 如实停止，不假装成功', async () => {
  const r1 = await runAgentLoop({
    target: { type: 'web', url: 'https://example.com/' }, probeMode: 'http', probeMaterial: { title: 'T' },
    callLlm: async () => ({ ok: false, error: 'provider 429', text: '' }),
    runTool: async () => ({ ok: true, summary: '' }),
    verify: async () => ({ ok: true, tried: [], failures: [] }),
  })
  assert.equal(r1.ok, false)
  assert.equal(r1.stoppedBy, 'llm-error')
  assert.ok(r1.issues.some((i) => i.includes('429')), r1.issues.join('｜'))

  const r2 = await runAgentLoop({
    target: { type: 'web', url: 'https://example.com/' }, probeMode: 'http', probeMaterial: { title: 'T' },
    budget: { timeBudgetMs: -1 },   // 立刻超时
    callLlm: async () => { throw new Error('不该被调用') },
    runTool: async () => ({ ok: true, summary: '' }),
    verify: async () => ({ ok: true, tried: [], failures: [] }),
  })
  assert.equal(r2.ok, false)
  assert.equal(r2.stoppedBy, 'time')
})

test('runAgentLoop：工具抛异常不致命，如实回喂后模型仍可继续', async () => {
  const llm = scripted([
    say({ tool: 'fetch_page', args: { url: 'https://a/1' } }),
    submit(goodSpec(3)),
  ])
  const r = await runAgentLoop({
    target: { type: 'web', url: 'https://example.com/' }, probeMode: 'http', probeMaterial: { title: 'T' },
    callLlm: llm,
    runTool: async () => { throw new Error('ECONNRESET') },
    verify: async () => ({ ok: true, tried: [], failures: [] }),
  })
  assert.equal(r.ok, true, '一次工具失败不该毁掉整次生成')
  assert.ok(llm.calls[1].user.includes('ECONNRESET'), '异常要如实回喂')
})

test('runAgentLoop：进度事件覆盖探索/解析/试跑/完成，且不编造百分比', async () => {
  const events = []
  const r = await runAgentLoop({
    target: { type: 'web', url: 'https://example.com/' }, probeMode: 'http', probeMaterial: { title: 'T' },
    callLlm: scripted([say({ tool: 'fetch_page', args: { url: 'https://a/1' } }), submit(goodSpec(3))]),
    runTool: async () => ({ ok: true, summary: '抓到了' }),
    verify: async () => ({ ok: true, tried: ['listItems0'], failures: [] }),
    onProgress: (p) => events.push(p),
  })
  assert.equal(r.verified, true)
  const phases = new Set(events.map((e) => e.phase))
  for (const p of ['round', 'explore', 'parse', 'parsed', 'verify', 'done']) assert.ok(phases.has(p), `缺少进度阶段 ${p}：${[...phases].join(',')}`)
  assert.ok(events.some((e) => String(e.detail || '').includes('抓取页面')), '探索细节要打印出来（界面据此给如实动画）')
  assert.ok(!events.some((e) => typeof e.percent === 'number'), '不得输出百分比（无从测量，编出来就是骗人）')
})

// ---------- 文案与工具函数 ----------

test('renderLog：超限时丢最早的探索记录，但保留最近的报错', () => {
  const log = [{ role: '工具', text: 'A'.repeat(500) }, { role: '工具', text: 'B'.repeat(500) }, { role: '系统', text: '最近的真实报错：元素不存在' }]
  const out = renderLog(log, 600)
  assert.ok(out.includes('最近的真实报错'), `最近的报错必须保留：${out}`)
  assert.ok(out.includes('已省略'), '要如实说明省略了多少条')
  assert.ok(out.length < 1200)
})

test('toolResultText / describeToolCall：失败要显眼、工具名要说人话', () => {
  assert.ok(toolResultText('fetch_page', { ok: false, summary: '连接超时' }).includes('失败'))
  assert.ok(toolResultText('fetch_page', { ok: false, summary: '连接超时' }).includes('连接超时'))
  assert.ok(toolResultText('fetch_page', { ok: true, summary: 'x'.repeat(9999) }).includes('已截断'))
  assert.ok(describeToolCall('fetch_page', { url: 'https://a/b' }).includes('https://a/b'))
  assert.ok(describeToolCall('run_command', { action: 'listItems' }).includes('listItems'))
})

test('buildAgentSystem：把工具协议与封装质量要求都写进提示词（交给模型的框架）', () => {
  const sys = buildAgentSystem({ target: { type: 'web', url: 'https://x/' }, driver: 'browser' })
  for (const k of ['fetch_page', 'list_pages', 'run_command', 'submit_spec']) assert.ok(sys.includes(k), `提示词缺少工具 ${k}`)
  assert.ok(sys.includes('title'), '要讲清 title 的质量要求')
  assert.ok(sys.includes('params[].desc'), '要讲清参数说明的质量要求')
  assert.ok(sys.includes('${参数名}') || sys.includes('${}'), '要讲清参数插值写法')
  assert.ok(sys.includes('自主探索') || sys.includes('自己去') || sys.includes('先探索'), '要明确要求模型自己探索')
  const seed = buildAgentSeed({ target: { type: 'web', url: 'https://x/' }, driver: 'browser', probeMode: 'http', probeMaterial: { title: 'T' }, seedSummary: '已预取 2 个页面' })
  assert.ok(seed.includes('已预取 2 个页面'), '种子素材要交代清楚')
  assert.ok(seed.includes('JSON'), '要说明输出格式')
})
