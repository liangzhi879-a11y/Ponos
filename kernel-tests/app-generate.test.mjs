// Task 3.1 / 3.2：Spec 生成与试跑验证（全部用假 LLM，不需要真模型）
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  buildPrompt, extractSpec, generateSpec, verifySpec, validateSpecBasic, snapshotForPrompt,
  MAX_ROUNDS, VERIFY_MAX_READS, ACT_CONTRACT, actContractLines, WEB_ACTS, DESKTOP_ACTS, SYSTEM_RULES,
} = require('../electron/app-generate.cjs')

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
  const { system } = buildPrompt({ target: {}, probeMaterial: {} })
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

test('validateSpecBasic：desktop 步骤按 desktop 契约校验（script 需 lang + file|code）', () => {
  const d = (steps) => ({ ...GOOD_SPEC, target: { type: 'desktop', exePath: 'C:/x.exe' }, driver: 'desktop', commands: [{ action: 'x', title: 'x', kind: 'read', params: [], steps }] })
  assert.equal(validateSpecBasic(d([{ act: 'cli', argv: ['--version'] }])).ok, true)
  assert.equal(validateSpecBasic(d([{ act: 'script', lang: 'js', code: 'console.log(1)' }])).ok, true)
  assert.ok(validateSpecBasic(d([{ act: 'script', code: 'x' }])).errors.some((e) => e.includes('lang')), 'script 缺 lang 应被拦')
  assert.ok(validateSpecBasic(d([{ act: 'cli' }])).errors.some((e) => e.includes('argv')), 'cli 缺 argv 应被拦')
  // web 的 act 不许混进 desktop
  assert.ok(validateSpecBasic(d([{ act: 'goto', url: '/' }])).errors.some((e) => e.includes('goto')))
})

test('ACT_CONTRACT 覆盖全部允许的 act（新增 act 忘了写契约会被这条挡住）', () => {
  for (const act of WEB_ACTS) assert.ok(ACT_CONTRACT.web[act], `web act 缺契约：${act}`)
  for (const act of DESKTOP_ACTS) assert.ok(ACT_CONTRACT.desktop[act], `desktop act 缺契约：${act}`)
  // type/wait 两侧语义不同，必须各有一份（web 用 ref+text，desktop 用 value）
  assert.ok(ACT_CONTRACT.web.type.required.includes('text'))
  assert.ok(ACT_CONTRACT.desktop.type.required.includes('value'))
})

test('actContractLines：每个 act 都带字段要求，js 明写 expression（提示词与校验同源）', () => {
  const lines = actContractLines()
  for (const act of [...WEB_ACTS, ...DESKTOP_ACTS]) assert.ok(lines.includes(act), `提示词缺 ${act}`)
  assert.ok(/js：必填 "expression"/.test(lines), `js 的字段要求要写清：${lines.split('\n').find((l) => l.includes('js：'))}`)
  assert.ok(lines.includes('"ref"'), 'ref 要求要写进提示词')
  // 二选一的字段要渲染成"或"，不能写成"且"（曾因此把 script 的 file|code 写成两者都要）
  assert.ok(/"file" 或 "code"/.test(lines), `script 应渲染为 file 或 code：${lines.split('\n').find((l) => l.includes('· script'))}`)
  assert.ok(/"ms" 或 "ref"/.test(lines), 'wait 应渲染为 ms 或 ref')
  assert.ok(SYSTEM_RULES.includes('expression'), 'SYSTEM_RULES 要包含契约说明')
  assert.ok(SYSTEM_RULES.includes('不是 CSS 选择器'), 'SYSTEM_RULES 要明确 ref ≠ 选择器')
})
