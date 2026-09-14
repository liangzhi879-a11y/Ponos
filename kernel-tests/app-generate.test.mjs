// Task 3.1 / 3.2：Spec 生成与试跑验证（全部用假 LLM，不需要真模型）
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  buildPrompt, extractSpec, generateSpec, verifySpec, validateSpecBasic, snapshotForPrompt,
  MAX_ROUNDS, VERIFY_MAX_READS, ACT_CONTRACT, actContractLines, WEB_ACTS, DESKTOP_ACTS, SYSTEM_RULES, WEB_ONLY_RULES,
  driverOf, actsFor, tableFor, driverRulesLine, SPEC_SHAPE_LINE, WEB_CONTRACT, DESKTOP_CONTRACT, systemRulesFor,
} = require('../electron/app-generate.cjs')
// 跨模块一致性护栏（Task 8）：提示词侧（app-agent 的 buildAgentSystem）与校验侧（app-generate 的
// actsFor/validateSpecBasic）必须共用同一份驱动口径 —— 两处逐字节绑死，任何一边单边改动就红。
const { buildAgentSystem } = require('../electron/app-agent.cjs')

const GOOD_SPEC = {
  specVersion: 1, appId: 'demo', name: '示例站',
  target: { type: 'web', url: 'https://example.com' },
  expose: { mode: 'console' },
  commands: [
    { action: 'queryOrder', title: '查单', kind: 'read', params: [{ name: 'id', type: 'string', required: true }], steps: [{ act: 'goto', url: '/o/${id}' }, { act: 'snapshot', save: 'result' }] },
    { action: 'listRecent', title: '最近列表', kind: 'read', params: [], steps: [{ act: 'goto', url: '/recent' }, { act: 'snapshot', save: 'result' }] },
    { action: 'submit', title: '提交', kind: 'write', params: [], steps: [{ act: 'goto', url: '/new' }, { act: 'snapshot' }, { act: 'click', ref: 1 }] },
  ],
}
const llmReturning = (text) => async () => ({ ok: true, text, error: null, chars: text.length })

// ---------- extractSpec ----------

test('extractSpec：抠 ```json 代码块', () => {
  const s = extractSpec('说明文字\n```json\n{"a":1}\n```\n后面的废话')
  assert.deepEqual(s, { a: 1 })
})

test('extractSpec：裸 JSON 也认', () => {
  assert.deepEqual(extractSpec('{"a":2}'), { a: 2 })
})

test('extractSpec：前后有杂字时取首 { 到末 }', () => {
  assert.deepEqual(extractSpec('好的：{"a":3} 完毕'), { a: 3 })
})

test('extractSpec：非 JSON / 空 / 数组 → null（不抛）', () => {
  assert.equal(extractSpec('完全不是 JSON'), null)
  assert.equal(extractSpec(''), null)
  assert.equal(extractSpec(undefined), null)
  assert.equal(extractSpec('[1,2]'), null)
})

// ---------- buildPrompt ----------

test('buildPrompt：必须含 params、数组要求、read/write 规则与 URL', () => {
  const { system, user } = buildPrompt({ target: { type: 'web', url: 'https://a.com' }, probeMaterial: { page: { title: 'T' } } })
  assert.ok(system.includes('params'))
  assert.ok(system.includes('数组'))
  assert.ok(system.includes('read'))
  assert.ok(system.includes('write'))
  assert.ok(user.includes('https://a.com'))
  assert.ok(user.includes('请产出完整 App Spec JSON'))
})

test('buildPrompt：禁止 public、含 act 白名单、禁止敏感信息', () => {
  // target 必须写清类型：act 清单与 browser 专属示例按驱动下发，`target:{}` 会推成最保守的
  // desktop(uia)，"含 web act" 这类断言就失去意义了（这正是被驱动的真实口径）。
  const { system } = buildPrompt({ target: { type: 'web', url: 'https://a.com' }, probeMaterial: {} })
  assert.ok(system.includes('public'))
  assert.ok(system.includes('goto'))
  assert.ok(system.includes('cli'))
  assert.ok(/不要写入口令/.test(system))
})

test('buildPrompt：有 previousErrors 时追加回喂段与错误清单（含试跑失败）', () => {
  const { user } = buildPrompt({ target: {}, probeMaterial: {}, previousErrors: ['输出不是合法 JSON', '缺少 name'] })
  // 措辞要对"两类错误"都成立：结构校验失败 与 试跑失败（试跑失败也会走这条回喂通道）
  assert.ok(user.includes('上一轮结果有问题'))
  assert.ok(user.includes('试跑'))
  assert.ok(user.includes('输出不是合法 JSON'))
  assert.ok(user.includes('缺少 name'))
})

test('buildPrompt：探测素材超长要截断（20k 上限）', () => {
  const { user } = buildPrompt({ target: {}, probeMaterial: { big: 'x'.repeat(50000) } })
  assert.ok(user.length < 30000, `提示词过长：${user.length}`)
})

test('snapshotForPrompt：只保留 page/text/info/interactives 四个字段', () => {
  // info = 真实快照的页面正文（label/value，见 browser-common.cjs 的 buildSnapshot）；
  // 它必须进素材，否则模型只知道"能点什么"、不知道"页面里有什么"（真机验收补入）
  const s = snapshotForPrompt({ page: { url: 'u', title: 't', readyState: 'complete', loading: false, captcha: false, logged_in: true }, text: 'body', info: [{ label: 'A1', value: '已支付' }], interactives: [{ ref: 'e1', tag: 'button', label: '查询', path_hint: 'div>button' }], secret: '不该出现' })
  assert.deepEqual(Object.keys(s).sort(), ['info', 'interactives', 'page', 'text'])
  assert.equal(s.interactives[0].ref, 'e1')
  assert.deepEqual(s.info, [{ label: 'A1', value: '已支付' }])
  assert.equal(snapshotForPrompt(null), null)
})

// ---------- validateSpecBasic ----------

test('validateSpecBasic：合法 Spec 通过', () => {
  assert.equal(validateSpecBasic(GOOD_SPEC).ok, true)
})

test('validateSpecBasic：抓出常见错误（空命令/重复 action/坏 URL/public/params 非数组）', () => {
  const bad = { specVersion: 1, name: 'x', target: { type: 'web', url: 'nope' }, expose: { mode: 'public' }, commands: [{ action: 'a', kind: 'read', steps: [{}] }, { action: 'a', kind: 'bad', steps: [] }] }
  const r = validateSpecBasic(bad)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('url')))
  assert.ok(r.errors.some((e) => e.includes('public')))
  assert.ok(r.errors.some((e) => e.includes('重复')))
  assert.ok(r.errors.some((e) => e.includes('kind')))
})

test('validateSpecBasic：commands 为空 / 非数组 → 不通过', () => {
  assert.equal(validateSpecBasic({ ...GOOD_SPEC, commands: [] }).ok, false)
  assert.equal(validateSpecBasic({ ...GOOD_SPEC, commands: 'x' }).ok, false)
})

// ---------- generateSpec ----------

test('generateSpec：首轮合法 → rounds 1', async () => {
  const r = await generateSpec({ target: GOOD_SPEC.target, probeMaterial: {}, callLlm: llmReturning(JSON.stringify(GOOD_SPEC)) })
  assert.equal(r.ok, true)
  assert.equal(r.rounds, 1)
  assert.deepEqual(r.issues, [])
  assert.equal(r.spec.commands.length, 3)
})

test('generateSpec：首轮非法 JSON、次轮合法 → rounds 2 且回喂了错误', async () => {
  const seen = []
  let n = 0
  const callLlm = async ({ user }) => {
    seen.push(user)
    n += 1
    return n === 1 ? { ok: true, text: '这不是 JSON', error: null } : { ok: true, text: JSON.stringify(GOOD_SPEC), error: null }
  }
  const r = await generateSpec({ target: GOOD_SPEC.target, probeMaterial: {}, callLlm })
  assert.equal(r.ok, true)
  assert.equal(r.rounds, 2)
  assert.ok(seen[1].includes('输出不是合法 JSON'), '第二轮提示词应回喂上一轮错误')
})

test('generateSpec：结构不合法（空 commands）→ 回喂并继续，最终 ok=false 且 issues 非空', async () => {
  const bad = JSON.stringify({ ...GOOD_SPEC, commands: [] })
  const r = await generateSpec({ target: GOOD_SPEC.target, probeMaterial: {}, callLlm: llmReturning(bad) })
  assert.equal(r.ok, false)
  assert.equal(r.spec, null)
  assert.equal(r.rounds, MAX_ROUNDS)
  assert.ok(r.issues.length > 0)
})

test('generateSpec：轮数上限固定为 3（不无限循环）', async () => {
  let calls = 0
  const r = await generateSpec({ target: {}, probeMaterial: {}, callLlm: async () => { calls += 1; return { ok: true, text: 'x', error: null } } })
  assert.equal(calls, 3)
  assert.equal(r.rounds, 3)
})

test('generateSpec：模型调用失败 → 立即中止并保留真实原因（不假装重试）', async () => {
  let calls = 0
  const r = await generateSpec({ target: {}, probeMaterial: {}, callLlm: async () => { calls += 1; return { ok: false, error: '模型接口 401：invalid key', text: '' } } })
  assert.equal(calls, 1)
  assert.equal(r.ok, false)
  assert.ok(r.issues[0].includes('401'))
})

test('generateSpec：expose=public 会被强制收敛为 console（LLM 不得开全局）', async () => {
  const pub = JSON.stringify({ ...GOOD_SPEC, expose: { mode: 'public' } })
  const r = await generateSpec({ target: GOOD_SPEC.target, probeMaterial: {}, callLlm: llmReturning(pub) })
  assert.equal(r.ok, true)
  assert.equal(r.spec.expose.mode, 'console')
})

test('generateSpec：进度事件如实反映真实阶段', async () => {
  const phases = []
  await generateSpec({
    target: GOOD_SPEC.target, probeMaterial: {}, callLlm: llmReturning(JSON.stringify(GOOD_SPEC)),
    onProgress: (p) => phases.push(p.phase),
  })
  assert.deepEqual(phases, ['round', 'parse', 'parsed'])
})

test('generateSpec：流式字符数单调不减，且末值等于真实总长', async () => {
  const chars = []
  await generateSpec({
    target: GOOD_SPEC.target, probeMaterial: {}, maxRounds: 1,
    // 故意返回非法 JSON 也没关系——只关心 delta 回调是否把"真实累计字符数"透传上来
    callLlm: async ({ onDelta }) => { onDelta('abc', 3); onDelta('de', 5); return { ok: true, text: 'abcde', error: null } },
    onProgress: (p) => { if (p.phase === 'stream') chars.push(p.chars) },
  })
  assert.ok(chars.length >= 2, '应至少上报两次')
  for (let i = 1; i < chars.length; i++) assert.ok(chars[i] >= chars[i - 1], `字符数不应回退：${chars}`)
  assert.equal(chars[chars.length - 1], 5, '末值应等于真实总长')
})

test('generateSpec：流式增量文本被透传（界面据此展示真实输出）', async () => {
  const chunks = []
  await generateSpec({
    target: GOOD_SPEC.target, probeMaterial: {}, maxRounds: 1,
    callLlm: async ({ onDelta }) => { onDelta('x'.repeat(300), 300); return { ok: true, text: 'y', error: null } },
    onProgress: (p) => { if (p.delta) chunks.push(p.delta) },
  })
  assert.equal(chunks.join('').length, 300, '累计增量应与真实输出一致')
})

// ---------- verifySpec ----------

test('verifySpec：read 全通 → ok', async () => {
  const tried = []
  const r = await verifySpec({ spec: GOOD_SPEC, runCommand: async ({ action }) => { tried.push(action); return { ok: true, data: 'x' } }, sessionId: 's' })
  assert.equal(r.ok, true)
  assert.deepEqual(tried, ['listRecent'], '只跑无需参数的 read')
  assert.ok(r.skipped.includes('queryOrder'), '需要参数的 read 应记为跳过')
  assert.deepEqual(r.notRun, ['submit'])
})

test('verifySpec：最多只试跑 2 条 read', async () => {
  const many = { ...GOOD_SPEC, commands: [1, 2, 3, 4].map((i) => ({ action: `r${i}`, kind: 'read', params: [], steps: [{}] })) }
  const tried = []
  await verifySpec({ spec: many, runCommand: async ({ action }) => { tried.push(action); return { ok: true } }, sessionId: 's' })
  assert.equal(tried.length, VERIFY_MAX_READS)
})

test('verifySpec：read 失败 → failures 记录真实错误、ok=false', async () => {
  const r = await verifySpec({ spec: GOOD_SPEC, runCommand: async () => ({ ok: false, error: '选择器没找到' }), sessionId: 's' })
  assert.equal(r.ok, false)
  assert.equal(r.failures[0].action, 'listRecent')
  assert.ok(r.failures[0].error.includes('选择器'))
})

test('verifySpec：write 绝不试跑（ran 不含 write，且 notRun 里有它）', async () => {
  const ran = []
  const r = await verifySpec({ spec: GOOD_SPEC, runCommand: async ({ action }) => { ran.push(action); return { ok: true } }, sessionId: 's' })
  assert.ok(!ran.includes('submit'))
  assert.ok(r.notRun.includes('submit'))
})

test('verifySpec：没有任何 read 命令 → ok=false 且说明含 read', async () => {
  const onlyWrite = { ...GOOD_SPEC, commands: [GOOD_SPEC.commands[2]] }
  const r = await verifySpec({ spec: onlyWrite, runCommand: async () => ({ ok: true }), sessionId: 's' })
  assert.equal(r.ok, false)
  assert.ok(r.failures[0].error.includes('read'))
})

test('verifySpec：runCommand 抛错被吞成失败项（不冒泡）', async () => {
  const r = await verifySpec({ spec: GOOD_SPEC, runCommand: async () => { throw new Error('执行器炸了') }, sessionId: 's' })
  assert.equal(r.ok, false)
  assert.ok(r.failures[0].error.includes('执行器炸了'))
})

// ---------- public 的显式放行 ----------

test('validateSpecBasic：默认拒绝 expose=public（LLM 生成路径不得开全局）', () => {
  const pub = { ...GOOD_SPEC, expose: { mode: 'public' } }
  const r = validateSpecBasic(pub)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('public')))
})

test('validateSpecBasic：用户在界面显式选「全局可用」时放行（allowPublic）', () => {
  const pub = { ...GOOD_SPEC, expose: { mode: 'public' } }
  assert.equal(validateSpecBasic(pub, { allowPublic: true }).ok, true)
  // 显式放行只针对 public，其它错误照旧要拦住
  const broken = { ...pub, commands: [] }
  assert.equal(validateSpecBasic(broken, { allowPublic: true }).ok, false)
})

// ---------- 步骤字段契约（真实故障驱动的补充） ----------
//
// 背景（用户实测）：生成出来的命令试跑报 `步骤 js 失败：js 缺少 expression`。
// 根因是校验只查 "steps 非空"、提示词也只列 act 名字 —— 缺字段的步骤能过校验，直到试跑才炸。
// 下面这组用例把契约钉住：坏步骤必须在校验轮被拦下（生成循环才有机会回喂模型改正）。

const specWith = (steps, kind = 'read') => ({
  ...GOOD_SPEC, driver: 'browser',
  commands: [{ action: 'x', title: 'x', kind, params: [], steps }],
})

test('validateSpecBasic：js 缺 expression 必须被拦下，并点名正确的字段名', () => {
  const r = validateSpecBasic(specWith([{ act: 'goto', url: '/' }, { act: 'js' }]))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('expression')), `实际：${r.errors}`)
})

test('validateSpecBasic：js 把表达式写在 code/script/value 里 → 提示改名为 expression', () => {
  for (const alias of ['code', 'script', 'value', 'expr']) {
    const r = validateSpecBasic(specWith([{ act: 'js', [alias]: 'document.title' }]))
    assert.equal(r.ok, false, `${alias} 不该被当作合法写法`)
    assert.ok(r.errors.some((e) => e.includes(`"${alias}"`) && e.includes('expression')), `实际：${r.errors}`)
  }
})

test('validateSpecBasic：js 写了 expression → 通过', () => {
  assert.equal(validateSpecBasic(specWith([{ act: 'js', expression: 'document.title' }])).ok, true)
})

test('validateSpecBasic：click/type/select/hover 要的是 ref，写成 selector 会被拦并说明改法', () => {
  const r = validateSpecBasic(specWith([{ act: 'click', selector: '#ok' }]))
  assert.equal(r.ok, false)
  const msg = r.errors.join(' ')
  assert.ok(msg.includes('ref') && msg.includes('selector'), `实际：${r.errors}`)
  assert.ok(msg.includes('snapshot') || msg.includes('js'), '错误信息要给出可操作改法')
})

test('validateSpecBasic：ref 类动作给了 ref → 通过（ref 可为数字或数字字符串）', () => {
  assert.equal(validateSpecBasic(specWith([{ act: 'click', ref: 3 }, { act: 'type', ref: '4', text: '${q}' }])).ok, true)
})

test('validateSpecBasic：goto 缺 url、wait 既无 ms 也无 ref、未知 act 都要被拦', () => {
  assert.ok(validateSpecBasic(specWith([{ act: 'goto' }])).errors.some((e) => e.includes('url')))
  assert.ok(validateSpecBasic(specWith([{ act: 'wait' }])).errors.some((e) => e.includes('ms')))
  const unknown = validateSpecBasic(specWith([{ act: 'launchMissiles' }]))
  assert.equal(unknown.ok, false)
  assert.ok(unknown.errors.some((e) => e.includes('不合法') && e.includes('launchMissiles')), `实际：${unknown.errors}`)
})

// 生产里 desktop 目标的 driver 只可能是 process / script / uia（app-profiler.SURFACE_ORDER）。
// 旧的这条用例传 driver:'desktop' —— 生产不存在的值，正是它让"提示词说 web、校验说 desktop"
// 的矛盾长期没被发现（本地应用封装必失败的真实故障）。
const deskSpec = (driver, steps) => ({
  ...GOOD_SPEC, name: '本地应用', target: { type: 'desktop', exePath: 'C:/x.exe' }, driver,
  commands: [{ action: 'doIt', title: '执行', kind: 'read', params: [], steps }],
})

test('validateSpecBasic：driver=process 只接受 cli 步骤', () => {
  assert.equal(validateSpecBasic(deskSpec('process', [{ act: 'cli', argv: ['--version'] }])).ok, true)
  const web = validateSpecBasic(deskSpec('process', [{ act: 'goto', url: '/' }, { act: 'snapshot', save: 'r' }]))
  assert.equal(web.ok, false)
  assert.ok(web.errors.some((e) => e.includes('process') && e.includes('cli')), `要按真实驱动点名允许的 act：${web.errors.join('；')}`)
  assert.ok(validateSpecBasic(deskSpec('process', [{ act: 'cli' }])).errors.some((e) => e.includes('argv')), 'cli 缺 argv 应被拦')
})

test('validateSpecBasic：driver=script 只接受 script 步骤，且需要 lang + file|code', () => {
  assert.equal(validateSpecBasic(deskSpec('script', [{ act: 'script', lang: 'js', code: 'console.log(1)' }])).ok, true)
  assert.ok(validateSpecBasic(deskSpec('script', [{ act: 'script', code: 'x' }])).errors.some((e) => e.includes('lang')), 'script 缺 lang 应被拦')
  assert.ok(validateSpecBasic(deskSpec('script', [{ act: 'cli', argv: ['--version'] }])).errors.some((e) => e.includes('script')), 'script 驱动不得写 cli 步骤')
})

test('validateSpecBasic：driver=uia 只接受 focus/type/key/wait；driver 值非法则单独点名（不叠加噪音）', () => {
  assert.equal(validateSpecBasic(deskSpec('uia', [{ act: 'type', value: 'hello' }, { act: 'key', value: 'Enter' }])).ok, true)
  const badValue = validateSpecBasic(deskSpec('android', [{ act: 'goto', url: '/' }]))
  assert.equal(badValue.ok, false)
  assert.ok(badValue.errors.some((e) => e.includes('driver') && e.includes('android')), `driver 非法要点名：${badValue.errors.join('；')}`)
  assert.ok(!badValue.errors.some((e) => e.includes('steps[')), `driver 非法时不再叠加步骤契约噪音（实际：${badValue.errors.join('；')}）`)
  // m2：文案必须与实现一致 —— 'web' 被当合法别名放行，报错文案就不能只说"只允许 browser/process/script/uia"
  // （否则用户会去改一个本来能跑的值；历史 Spec 里真的存在 'web'，改写它纯属无谓的兼容性风险）
  assert.equal(validateSpecBasic({ ...GOOD_SPEC, driver: 'web' }).ok, true,
    "'web' 是合法历史别名（归一为 browser）")
  assert.ok(badValue.errors.some((e) => e.includes('"web"')), `报错文案要说明 web 别名，实际：${badValue.errors.join('；')}`)
})

test('ACT_CONTRACT 覆盖全部允许的 act（新增 act 忘了写契约会被这条挡住）', () => {
  for (const act of WEB_ACTS) assert.ok(ACT_CONTRACT.web[act], `web act 缺契约：${act}`)
  for (const act of DESKTOP_ACTS) assert.ok(ACT_CONTRACT.desktop[act], `desktop act 缺契约：${act}`)
  // type/wait 两侧语义不同，必须各有一份（web 用 ref+text，desktop 用 value）
  assert.ok(ACT_CONTRACT.web.type.required.includes('text'))
  assert.ok(ACT_CONTRACT.desktop.type.required.includes('value'))
})

// ---------- 驱动词汇表（唯一真源） ----------
//
// 背景（真实故障）：本地应用(desktop)封装必然失败 —— 提示词侧判 `driver === 'desktop'`，而生产
// driver 只有 browser/process/script/uia，该条件永不成立 → 给模型下发 web act 清单（goto/snapshot）；
// 同一条链路的校验又按 `target.type === 'desktop'` 收窄到 cli/script/focus/type/key/wait
// → 同一份 Spec 一边被要求写、一边被判非法。下面这组用例把驱动词汇表钉成单一真源。

test('driverOf：生产驱动值（process/script/uia）不再被当成 web；缺 driver 与 app-ipc.inferDriver 同口径', () => {
  assert.equal(driverOf({ driver: 'process', target: { type: 'desktop' } }), 'process')
  assert.equal(driverOf({ driver: 'script', target: { type: 'desktop' } }), 'script')
  assert.equal(driverOf({ driver: 'uia', target: { type: 'desktop' } }), 'uia')
  assert.equal(driverOf({ driver: 'browser', target: { type: 'web' } }), 'browser')
  // 没写 driver → web 推 browser、其余推 uia（最保守的兜底，与 electron/app-ipc.cjs 的 inferDriver 一致）
  assert.equal(driverOf({ target: { type: 'web' } }), 'browser')
  assert.equal(driverOf({ target: { type: 'desktop' } }), 'uia')
  // 历史别名：'desktop' 曾是 driver 值（真实故障源头），一律按 target.type 推定
  assert.equal(driverOf({ driver: 'desktop', target: { type: 'desktop' } }), 'uia')
  // targetType 显式给出时优先用它（提示词侧只拿得到 driver 字符串 + target）
  assert.equal(driverOf({ driver: 'desktop' }, { targetType: 'web' }), 'browser')
})

test('actsFor：每个驱动只给自己能执行的 act（多一个都会在运行期炸）', () => {
  assert.deepEqual(actsFor('process'), ['cli'], 'process 驱动只认 cli 步骤')
  assert.deepEqual(actsFor('script'), ['script'], 'script 驱动只认 script 步骤')
  assert.deepEqual(actsFor('uia'), ['focus', 'type', 'key', 'wait'])
  assert.ok(actsFor('browser').includes('snapshot'))
  assert.deepEqual(actsFor('desktop'), actsFor('uia'), "旧值兼容：'desktop' 不指明接口面 → 按最保守的 uia 算")
  assert.deepEqual(actsFor('web'), actsFor('browser'), 'web 是 browser 的历史别名')
  assert.deepEqual(actsFor('launchMissiles'), [], '未知驱动不返回任何 act（由校验层另行点名）')
})

test('tableFor：web 与桌面各自用自己那份字段契约（type/wait 两侧语义不同）', () => {
  assert.equal(tableFor('browser'), WEB_CONTRACT)
  assert.equal(tableFor('process'), DESKTOP_CONTRACT)
  assert.equal(tableFor('uia'), DESKTOP_CONTRACT)
})

test('SPEC_SHAPE_LINE / driverRulesLine：顶层结构与驱动约束各只有一份真源', () => {
  for (const k of ['specVersion', 'appId', 'name', 'target', 'commands']) assert.ok(SPEC_SHAPE_LINE.includes(k), `结构契约缺 ${k}`)
  const line = driverRulesLine('process')
  assert.ok(line.includes('process') && line.includes('cli'), `驱动行缺驱动/act：${line}`)
  assert.ok(!/snapshot/.test(line.split('\n')[0]), 'process 的允许 act 里不得出现 snapshot')
  assert.ok(line.includes('argv'), '要带字段契约（cli 必须 argv）')
})

test('actContractLines：只渲染传入驱动的 act，每个 act 都带字段要求（提示词与校验同源）', () => {
  const web = actContractLines('browser')
  for (const act of actsFor('browser')) assert.ok(web.includes(act), `浏览器契约缺 ${act}`)
  // 只匹配"契约条目"形态的 · cli：，而不是裸子串 —— 'click' 里就含 'cli'，
  // 裸 includes('cli') 与上面的"必须包含 click"直接矛盾（计划书里的这行断言写错了）
  assert.ok(!/· cli：/.test(web), '浏览器契约不该出现桌面 act')
  assert.ok(/js：必填 "expression"/.test(web), 'js 的字段要求要写清')
  assert.ok(web.includes('"ref"'), 'ref 要求要写进提示词')
  const desk = actContractLines('process')
  assert.ok(desk.includes('cli') && desk.includes('"argv"'), 'process 契约要有 cli/argv')
  assert.ok(!desk.includes('snapshot'), 'process 契约绝不能提 snapshot')
  // 二选一的字段要渲染成"或"，不能写成"且"（曾因此把 script 的 file|code 写成两者都要）
  assert.ok(/"file" 或 "code"/.test(actContractLines('script')), 'script 应渲染为 file 或 code')
  // browser 专属示例必须还在（只是被门控到 browser）：删掉它们等于把 web 生成能力弄坏
  assert.ok(WEB_ONLY_RULES.includes('expression'), 'WEB_ONLY_RULES 要包含 js 契约说明')
  assert.ok(WEB_ONLY_RULES.includes('不是 CSS 选择器'), 'WEB_ONLY_RULES 要明确 ref ≠ 选择器')
  // 通用规则里不得再夹带 browser 专属示例（否则桌面应用会照抄，写出校验必拒的步骤）
  assert.ok(!SYSTEM_RULES.includes('snapshot') && !SYSTEM_RULES.includes('goto'),
    'SYSTEM_RULES 是"所有驱动通用"，不得含 browser 专属示例：这些必须由 WEB_ONLY_RULES 承接')
})

test('systemRulesFor：browser 专属 act 示例只发给 browser，桌面驱动全文不得出现 snapshot/goto', () => {
  const deskTarget = { type: 'desktop', exePath: 'C:/x/y.exe' }
  for (const [driver, target] of [['uia', deskTarget], ['process', deskTarget], ['script', deskTarget]]) {
    // 不传 driver（按 target.type 推定）与显式传 driver 两条路都要门住
    for (const sys of [systemRulesFor(target), systemRulesFor(target, { driver })]) {
      assert.ok(!sys.includes('snapshot'), `${driver}：桌面提示词不得出现 snapshot`)
      assert.ok(!sys.includes('goto'), `${driver}：桌面提示词不得出现 goto`)
    }
  }
  const proc = systemRulesFor(deskTarget, { driver: 'process' })
  assert.ok(proc.includes('cli') && proc.includes('argv'), '分驱动不等于不分契约：process 仍要有 cli/argv 契约')
  const web = systemRulesFor({ type: 'web', url: 'https://a.com/' })
  assert.ok(web.includes('snapshot') && web.includes('goto'), 'browser 仍要拿到这些示例（门控不是把功能删了）')
  // 历史别名 'web' 归一为 browser：门控按**归一后**的驱动判定，否则别名用户会被降级成桌面提示词
  assert.ok(systemRulesFor(deskTarget, { driver: 'web' }).includes('snapshot'), "'web' 别名要按 browser 门控")
})

// ---------- 跨模块一致性护栏（Task 8） ----------
//
// 背景：同一份 driver 契约曾有两个判定口径 —— 提示词侧判 `driver === 'desktop'`（生产 driver 只有
// browser/process/script/uia，该条件永不成立），校验侧判 `target.type === 'desktop'`
// → 给模型下发的 act 清单与校验允许的 act 清单长期不一致，本地应用封装必然失败。
// 之所以长期没被发现，是因为测试里用的是生产不存在的 driver:'desktop'。
// 下面两条把两侧清单逐字节绑死，任何一边单边改动就会红。

test('一致性护栏：提示词下发的 act 清单与校验允许的 act 清单逐字节一致（四种驱动）', () => {
  const cases = [
    ['browser', { type: 'web', url: 'https://x/' }],
    ['process', { type: 'desktop', exePath: 'C:/x/y.exe' }],
    ['script', { type: 'desktop', exePath: 'C:/x/y.exe' }],
    ['uia', { type: 'desktop', exePath: 'C:/x/y.exe' }],
  ]
  for (const [driver, target] of cases) {
    const sys = buildAgentSystem({ target, driver })
    const line = sys.match(/steps\.act 只能取：([^\n]+)/)
    assert.ok(line, `${driver} 的提示词里没有 act 清单行`)
    const fromPrompt = line[1].replace(/[。.]\s*$/, '').split(/[、,，]\s*/).map((s) => s.trim()).filter(Boolean)
    assert.deepEqual(fromPrompt, actsFor(driver), `${driver}：提示词与校验的 act 清单必须一致`)
  }
})

test('一致性护栏：提示词说能写的 act，校验必须真的放行（逐驱动抽样）', () => {
  const sample = { browser: { act: 'snapshot' }, process: { act: 'cli', argv: ['--version'] }, script: { act: 'script', lang: 'js', code: '1' }, uia: { act: 'key', value: 'Enter' } }
  for (const [driver, step] of Object.entries(sample)) {
    const spec = { specVersion: 1, appId: 'a', name: '甲', driver, expose: { mode: 'console' },
                   target: driver === 'browser' ? { type: 'web', url: 'https://x/' } : { type: 'desktop', exePath: 'C:/x/y.exe' },
                   commands: [{ action: 'doIt', title: '执行一步', kind: 'read', params: [], steps: [step] }] }
    const sys = buildAgentSystem({ target: spec.target, driver })
    assert.ok(sys.includes(step.act), `${driver} 的提示词应包含 ${step.act}`)
    assert.equal(validateSpecBasic(spec).ok, true, `${driver}：提示词说能写却校验不过 —— ${JSON.stringify(validateSpecBasic(spec).errors)}`)
  }
})
