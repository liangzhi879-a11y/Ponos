// Task 3.1 / 3.2：Spec 生成与试跑验证（全部用假 LLM，不需要真模型）
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  buildPrompt, extractSpec, generateSpec, verifySpec, validateSpecBasic, snapshotForPrompt,
  MAX_ROUNDS, VERIFY_MAX_READS,
} = require('../electron/app-generate.cjs')

const GOOD_SPEC = {
  specVersion: 1, appId: 'demo', name: '示例站',
  target: { type: 'web', url: 'https://example.com' },
  expose: { mode: 'console' },
  commands: [
    { action: 'queryOrder', title: '查单', kind: 'read', params: [{ name: 'id', type: 'string', required: true }], steps: [{ act: 'goto', url: '/o/${id}' }, { act: 'snapshot', save: 'result' }] },
    { action: 'listRecent', title: '最近列表', kind: 'read', params: [], steps: [{ act: 'goto', url: '/recent' }, { act: 'snapshot', save: 'result' }] },
    { action: 'submit', title: '提交', kind: 'write', params: [], steps: [{ act: 'click', selector: '#ok' }] },
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

test('buildPrompt：有 previousErrors 时追加回喂段与错误清单', () => {
  const { user } = buildPrompt({ target: {}, probeMaterial: {}, previousErrors: ['输出不是合法 JSON', '缺少 name'] })
  assert.ok(user.includes('上一轮输出不合法'))
  assert.ok(user.includes('输出不是合法 JSON'))
  assert.ok(user.includes('缺少 name'))
})

test('buildPrompt：探测素材超长要截断（20k 上限）', () => {
  const { user } = buildPrompt({ target: {}, probeMaterial: { big: 'x'.repeat(50000) } })
  assert.ok(user.length < 30000, `提示词过长：${user.length}`)
})

test('snapshotForPrompt：只保留 page/text/interactives 三个字段', () => {
  const s = snapshotForPrompt({ page: { url: 'u', title: 't', readyState: 'complete', loading: false, captcha: false, logged_in: true }, text: 'body', interactives: [{ ref: 'e1', tag: 'button', label: '查询', path_hint: 'div>button' }], secret: '不该出现' })
  assert.deepEqual(Object.keys(s).sort(), ['interactives', 'page', 'text'])
  assert.equal(s.interactives[0].ref, 'e1')
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
