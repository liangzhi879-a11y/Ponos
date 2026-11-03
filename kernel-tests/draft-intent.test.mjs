// kernel-tests/draft-intent.test.mjs —— 起草意图拼装（纯函数；B1）
// 纪律：确定性、无对话正文、白名单含产出工具不含执行面。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DRAFT_TOOL_ALLOWLIST, buildDraftIntent, routeOfDraft } from '../kernel/draft-intent.mjs'
// 事实行的单一实现（起草与评审共用）——测试直接引用它，钉住"两处逐字同源"
import { renderFacts } from '../kernel/candidate-facts.mjs'

const cand = (over = {}) => ({
  id: 'abc123', ruleId: 'OPP-2', subject: 'gxtz-1', count: 3,
  evidence: [{ sessionId: 's1', seq: 9, ts: 'T' }],
  advice: { hypoth: [], actions: [{ code: 'revise-skill', route: 'draft:skill' }] },
  ...over,
})

test('★ 起草白名单：含 SkillDraft（技能通道的产出工具），不含任何执行/网络/递归派发面', () => {
  assert.ok(DRAFT_TOOL_ALLOWLIST.includes('SkillDraft'), 'SkillDraft 是产出通道，必须在白名单内')
  for (const bad of ['Bash', 'WebFetch', 'WebSearch', 'Browser', 'Agent', 'Task', 'Workflow', 'OCR', 'Vision']) {
    assert.ok(!DRAFT_TOOL_ALLOWLIST.includes(bad), `起草白名单不得含 ${bad}`)
  }
  assert.ok(Object.isFrozen(DRAFT_TOOL_ALLOWLIST))
})

test('★ 意图消息确定性：同输入两次 ⇒ 逐字相同', () => {
  const o = { existingArtifacts: [{ id: 'gxtz-1', kind: 'skill' }], draftsDir: '/home/evolution/drafts' }
  assert.equal(buildDraftIntent(cand(), o), buildDraftIntent(cand(), o))
})

test('★ 意图消息不含对话正文（隐私口径：只带统计与引用）', () => {
  const s = buildDraftIntent(cand())
  assert.ok(s.includes('s1#9'), '证据必须以 会话id#seq 引用形式出现（可回跳）')
  for (const forbidden of ['transcript', '正文', '对话内容', 'user:', 'assistant:']) {
    assert.ok(!s.includes(forbidden), `不得出现 ${forbidden}`)
  }
})

test('★ 硬约束四条必须都在（缺一条 = agent 可能越界）', () => {
  const s = buildDraftIntent(cand())
  assert.ok(s.includes('只产出草案'), '缺"只产出草案"')
  assert.ok(s.includes('不得修改 kernel/'), '缺"不得改内核"约束')
  assert.ok(s.includes('修订既有'), '缺"优先修订既有"约束')
  assert.ok(s.includes('外部副作用'), '缺"不得外部副作用"约束')
})

test('★ 无 route / 非法 route ⇒ 消息必须写明"只做分析不要建件"（不许默默起草）', () => {
  const s = buildDraftIntent(cand({ advice: { hypoth: [], actions: [] } }))
  assert.ok(s.includes('不要建件'), '没有可起草对象时必须明说，否则 agent 会自由发挥')
})

test('routeOfDraft：仅三条 draft:* 给通道，其余 null', () => {
  assert.equal(routeOfDraft('draft:skill'), 'skill')
  assert.equal(routeOfDraft('draft:workflow'), 'workflow')
  assert.equal(routeOfDraft('draft:app'), 'app')
  assert.equal(routeOfDraft('advice'), null)
  assert.equal(routeOfDraft('settings'), null)
  assert.equal(routeOfDraft(undefined), null)
})

test('通道落点写进消息：skill 用 SkillDraft、workflow/app 落 draftsDir（且不含生产目录）', () => {
  const s1 = buildDraftIntent(cand(), { draftsDir: '/h/evolution/drafts' })
  assert.ok(s1.includes('SkillDraft'), 'skill 通道必须指明用 SkillDraft')
  const s2 = buildDraftIntent(cand({ advice: { hypoth: [], actions: [{ code: 'x', route: 'draft:workflow' }] } }), { draftsDir: '/h/evolution/drafts' })
  assert.ok(s2.includes('/h/evolution/drafts'), 'workflow 通道必须指明落点')
  assert.ok(s2.includes('不要写 workflows/'), '必须明确禁止写生产目录')
})

test('路径归一：Windows 反斜杠转正斜杠（消息可读、可跨平台比对）', () => {
  const s = buildDraftIntent(cand({ advice: { hypoth: [], actions: [{ code: 'x', route: 'draft:workflow' }] } }), { draftsDir: 'C:\\Users\\x\\drafts' })
  assert.ok(s.includes('C:/Users/x/drafts'), '反斜杠必须归一')
  assert.ok(!s.includes('C:\\'), '不得残留反斜杠')
})

test('垃圾输入不抛（候选缺字段/evidence 非数组/draftsDir 缺失）', () => {
  assert.doesNotThrow(() => buildDraftIntent(null))
  assert.doesNotThrow(() => buildDraftIntent({}, {}))
  assert.ok(buildDraftIntent({}).includes('（无）'), '无证据时如实标"（无）"，不造数据')
})

// ── 2026-10-14（Task 17）：**按模式分派约束** ───────────────────────────────────
// ★ 为什么分派：现有的「不要写 workflows/ 生产目录」是为**无人看管的自动起草**写的
//   （"自动化止于暂存区"）；手动起草时用户就在**自己的会话**里看着 agent、可随时打断，
//   把同一条禁令用在手动路径上等于**人为掐断**了"建好工作流 → 去面板跑一次（= 试用）"这条链。
//   ★ 这不是放宽安全边界（手动路径用户本来就能让 agent 写任何文件），自动路径的禁令**一字不动**；
//   两条底线（不得改 kernel/ 、不得外部副作用）**两种模式都在**（下面各有对照断言钉住）。
const OPP8 = () => ({
  ...cand(),
  id: 'opp800000001', ruleId: 'OPP-8', subject: 'demo-flow', count: 4,
  advice: {
    hypoth: [{ code: 'repeatable-pattern' }],
    actions: [
      { code: 'crystallize-skill', route: 'draft:skill' },
      { code: 'create-workflow', route: 'draft:workflow' },
    ],
  },
})
// ★ 2026-10-14：夹具补上**真实目录**（落点从占位符改成实参后的必要同步 —— 语义没放宽，
//   只是模板不再内嵌 `<PONOS_HOME>`；端点会用 homeDir 派生出这几个路径）。
const OPTS = {
  existingArtifacts: [{ id: 'demo-skill', kind: 'skill' }],
  draftsDir: '/h/evolution/drafts',
  skillsDir: '/h/skills',
  workflowsDir: '/h/workflows',
  appsDir: '/h/apps',
}

test('★ manual 列出**全部**方向，auto 只列首条通道（两条对照，防恒真）', () => {
  const manual = buildDraftIntent(OPP8(), { ...OPTS, mode: 'manual' })
  assert.ok(manual.includes('技能：用 SkillDraft'), 'manual 缺技能方向')
  assert.ok(manual.includes('流程：把工作流写进'), 'manual 缺流程方向（OPP-8 的 workflow 恰是第二条）')
  assert.match(manual, /workflows\/<id>\/workflow\.yml/, 'manual 必须给出工作流的生产落点')
  // ★ 对照：auto 照旧只讲首条通道（skill）⇒ 一条都不提 workflows/
  const auto = buildDraftIntent(OPP8(), OPTS)
  assert.ok(auto.includes('SkillDraft'), 'auto 照旧讲首条通道（skill）')
  assert.ok(!auto.includes('workflows/'), '★ 对照：auto 只讲首条通道，不得出现 workflows/')
  assert.ok(!auto.includes('流程：'), '★ 对照：auto 不得列出第二个方向')
  // 反向顺序对照：首条是 workflow 时 auto 只列流程、不提技能方向
  const wfFirst = {
    ...OPP8(),
    advice: { hypoth: [], actions: [{ code: 'a', route: 'draft:workflow' }, { code: 'b', route: 'draft:skill' }] },
  }
  assert.ok(!buildDraftIntent(wfFirst, OPTS).includes('SkillDraft'), 'auto 不提第二条通道')
  assert.ok(buildDraftIntent(wfFirst, { ...OPTS, mode: 'manual' }).includes('技能：用 SkillDraft'),
    'manual 两个方向都在（actions 顺序不改变"都列"这条）')
})

test('manual 方向去重且只列真实 draft 方向（不许把 advice/settings 当方向编进去）', () => {
  const c = {
    ...OPP8(),
    advice: {
      hypoth: [],
      actions: [
        { code: 'a', route: 'draft:skill' },
        { code: 'b', route: 'advice' },
        { code: 'c', route: 'draft:skill' },          // 重复方向
        { code: 'd', route: 'draft:bogus' },          // 非法通道
        { code: 'e', route: 'draft:app' },
      ],
    },
  }
  const s = buildDraftIntent(c, { ...OPTS, mode: 'manual' })
  const count = (needle) => s.split(needle).length - 1
  assert.equal(count('技能：用 SkillDraft'), 1, '同方向重复出现只列一次（去重）')
  assert.ok(s.includes('应用：'), 'app 是真 draft 方向 ⇒ 必须列出')
  assert.ok(!s.includes('draft:bogus'), '非法通道不进消息')
})

test('★ manual 允许写生产工件（给出**真实** workflows 落点、无禁令）；auto 仍禁写生产目录（逐字保留）', () => {
  const wf = { ...cand(), advice: { hypoth: [], actions: [{ code: 'x', route: 'draft:workflow' }] } }
  assert.ok(buildDraftIntent(wf, OPTS).includes('不要写 workflows/'), 'auto 的禁令是既有契约，一字不动')
  // ★ 2026-10-14：落点从占位 `<PONOS_HOME>/workflows/` 改成**传入的真实路径**
  //   （实测：占位符会被模型照抄，且用户还要自己换算）。故这里显式传 workflowsDir 并断言真实值。
  const manual = buildDraftIntent(wf, { ...OPTS, mode: 'manual', workflowsDir: '/home/u/.ponos/workflows' })
  assert.ok(manual.includes('/home/u/.ponos/workflows/<id>/workflow.yml'),
    '★ manual 必须给出**具体**工作流生产落点（本任务的核心改动）')
  assert.ok(!manual.includes('不要写'), '★ manual 不得残留任何"不要写…"禁令 —— 那正是被修掉的掐断点')
  assert.ok(manual.includes('可直接创建'), 'manual 必须明说"我就在会话里，可直接创建生产工件"')
  assert.ok(manual.includes('创建前把要点讲清'), '允许创建 ≠ 闷头建：要点要先讲清')
})

test('★★ 占位符绝不泄漏（实测踩过 `(未指定)`）：缺路径时**整段省略/如实标注**，不出现模板花括号', () => {
  // 为什么钉这条：`draftsDir` 一度用 `|| '(未指定)'` 兜底，而前端从不传 ⇒ 每次消息都漏出 `(未指定)`；
  // 模型会把占位符当真、用户要自己换算。占位符泄漏比"不提这件事"更糟。
  const wf = { ...cand(), advice: { hypoth: [], actions: [{ code: 'x', route: 'draft:workflow' }] } }
  const noDirs = buildDraftIntent(wf, { mode: 'manual' })   // 一个路径都不传
  for (const bad of ['(未指定)', '{workflowsDir}', '{draftsDir}', '{appsDir}', '{{', '}}']) {
    assert.ok(!noDirs.includes(bad), `缺路径时不得泄漏占位符：${bad}`)
  }
  assert.ok(!noDirs.includes('只想先出草案的话'), '没有草稿目录 ⇒ "先出草案"那句整句省略（不占位）')
  // 有真实目录时才出现该句，且值是真实路径
  const withDraft = buildDraftIntent(wf, { mode: 'manual', draftsDir: '/h/evolution/drafts' })
  assert.ok(withDraft.includes('/h/evolution/drafts'), '给了草稿目录才提这句，且用真实值')
})

test('★★ 不臆造既有件：没给清单时**不得**断言"目录中无高度相关的既有件"，而是如实说"未提供"+该查哪', () => {
  // 实测：消息里断言"（目录中无高度相关的既有件）"，而 agent 一查就找到 4 个相关技能 ⇒ 那句是假话。
  // 根因：端点从不传 existingArtifacts，而模板把"空数组"当成了"确认无相关件"。
  const noList = buildDraftIntent({ ...cand(), advice: { hypoth: [], actions: [{ code: 'x', route: 'draft:skill' }] } },
    { mode: 'manual', skillsDir: '/h/skills', workflowsDir: '/h/workflows' })
  assert.ok(!noList.includes('无高度相关的既有件'), '★ 不得断言"没有相关件"（不知道不能说 —— 本仓禁臆造）')
  assert.ok(noList.includes('未提供既有件清单'), '应如实说"未提供"')
  assert.ok(noList.includes('/h/skills') && noList.includes('/h/workflows'), '并给出**该去核对**的目录（省 agent 猜路径的步数）')
  assert.ok(noList.includes('不要假定目录里没有'), '把"别假定为空"写进去，避免 agent 直接断定需要新建')
  // 给了清单 ⇒ 如实列出（两种状态互斥，防"永远说未提供"的恒真）
  const withList = buildDraftIntent(OPP8(), { mode: 'manual', existingArtifacts: [{ id: 'systematic-debugging', kind: 'skill' }] })
  assert.ok(withList.includes('skill:systematic-debugging'), '有清单就列出来')
  assert.ok(!withList.includes('未提供既有件清单'), '有清单时不得再说"未提供"')
})

test('★★ 起草消息必须带**事实行**（实测：不带 ⇒ agent 自己扫 30 天转录重算，跑了 82 步）', () => {
  const withMetrics = {
    ...cand({ ruleId: 'OPP-7', subject: 'Bash、Edit' }), count: 51, score: 0.9,
    metrics: { failures: 941, sessions: 3, tools: ['Bash', 'Edit'], distinctTools: 2, avgCalls: 18.5 },
    advice: { hypoth: [], actions: [{ code: 'x', route: 'draft:skill' }] },
  }
  const s = buildDraftIntent(withMetrics, { mode: 'manual' })
  assert.ok(s.includes('事实（系统实测到的'), '必须有事实行（否则 agent 只能重扫转录）')
  for (const needle of ['rule=OPP-7', 'subject=Bash、Edit', 'failures=941', 'sessions=3', 'toolList=Bash+Edit', 'distinctTools=2', 'avgCalls=18.5']) {
    assert.ok(s.includes(needle), `事实行缺 ${needle}（这些是内核已算好的，不该让 agent 重算）`)
  }
  assert.ok(s.includes('不必自己去扫转录重算'), '要明说"可直接引用"，否则模型仍可能去重扫')
  // 与评审侧同源：同一候选两处的事实行必须逐字相同（单一实现，防漂移）
  assert.ok(s.includes(renderFacts(withMetrics)), '事实行必须与 candidate-facts 的实现逐字一致')
})

test('★ 两条安全底线 + 发布确认，两种模式都在（防"手动模式顺手把底线也删了"）', () => {
  for (const mode of ['auto', 'manual']) {
    const s = buildDraftIntent(OPP8(), { ...OPTS, mode })
    assert.ok(s.includes('不得修改 kernel/'), `${mode}：缺"不得修改 kernel/"底线`)
    assert.ok(s.includes('server/'), `${mode}：缺 server/ （同一条底线的另一半）`)
    assert.ok(s.includes('外部副作用'), `${mode}：缺"不得外部副作用"底线`)
    assert.ok(s.includes('我确认'), `${mode}：缺"发布需/仍需我确认"（留痕与审批不得消失）`)
    assert.ok(s.includes('修订既有'), `${mode}：缺"优先修订既有"`)
  }
})

test('★ 无 draft 方向 ⇒ 两种模式都写"不要建件"（不因 manual 就自由发挥）', () => {
  const cases = [
    { ...cand(), advice: { hypoth: [], actions: [{ code: 'x', route: 'advice' }] } },
    { ...cand(), advice: { hypoth: [], actions: [] } },
    { ...cand(), advice: undefined },
    { ...cand(), advice: { hypoth: [], actions: [{ code: 'x', route: 'draft:bogus' }] } },
  ]
  for (const c of cases) {
    for (const mode of ['auto', 'manual']) {
      const s = buildDraftIntent(c, { ...OPTS, mode })
      assert.ok(s.includes('不要建件'), `${mode} / route=${c.advice?.actions?.[0]?.route ?? '(无)'}：无可起草对象时必须明说`)
      assert.ok(!/workflows\//.test(s), `${mode}：没有方向就不得给生产落点（不许凭空许一个落点）`)
    }
  }
})

test('★ manual 收尾指引：有 workflow 方向才给（"去面板跑一次"= 试用面，设计稿 D47 不新增机制）', () => {
  const m = buildDraftIntent(OPP8(), { ...OPTS, mode: 'manual' })
  assert.ok(m.includes('收尾：'), 'manual 消息末尾必须给可执行的收尾指引')
  assert.ok(m.includes('工作流面板'), '收尾必须指明"去哪试用"（工作流 rail 的运行抽屉）')
  assert.ok(m.includes('写明它的 id'), '收尾要能落地：让 agent 回报 id，用户才知道跑哪一个')
  assert.ok(!buildDraftIntent(OPP8(), OPTS).includes('收尾：'), '对照：auto 不附加手动收尾指引')
  const skillOnly = { ...cand(), advice: { hypoth: [], actions: [{ code: 'x', route: 'draft:skill' }] } }
  assert.ok(!buildDraftIntent(skillOnly, { ...OPTS, mode: 'manual' }).includes('收尾：'),
    '没有 workflow 方向时不提"去工作流面板"（指错地方比不说更糟）')
})

test('★ manual 确定性：同输入两次逐字相同（mode 进参数参与拼装，但无时钟、无随机）', () => {
  assert.equal(buildDraftIntent(OPP8(), { ...OPTS, mode: 'manual' }), buildDraftIntent(OPP8(), { ...OPTS, mode: 'manual' }))
  assert.notEqual(buildDraftIntent(OPP8(), OPTS), buildDraftIntent(OPP8(), { ...OPTS, mode: 'manual' }),
    '对照：两种模式确实不同（否则上面那句恒真）')
})

test('★ 缺省 mode === auto（旧调用方不传 ⇒ 行为逐字不变）；未知 mode 也走 auto 那一侧（更严）', () => {
  assert.equal(buildDraftIntent(OPP8(), OPTS), buildDraftIntent(OPP8(), { ...OPTS, mode: 'auto' }))
  assert.equal(buildDraftIntent(OPP8(), { ...OPTS, mode: 'bogus' }), buildDraftIntent(OPP8(), { ...OPTS, mode: 'auto' }))
  // 逐字不变的实证：老测试那几条断言（首条通道 + draftsDir 落点 + 禁令）在缺省模式下仍成立
  const legacy = buildDraftIntent({ ...cand(), advice: { hypoth: [], actions: [{ code: 'x', route: 'draft:workflow' }] } }, { ...OPTS })
  assert.ok(legacy.includes('/h/evolution/drafts') && legacy.includes('不要写 workflows/'))
})
