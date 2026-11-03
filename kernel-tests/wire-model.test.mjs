// kernel/wire/model.mjs 协议相关模型名测试（2026-09-23 OpenAI 协议兼容 Task 1）
// 实证来源：MiniMax 的 Anthropic 兼容端点接受 `MiniMax-M3[1m]`，同一域名的 OpenAI 兼容
// 端点对同一名字返回 `400 unknown model`，必须用去掉变体后缀的 `MiniMax-M3`。
// 本套用例把两条要求钉死：① 显式覆盖生效；② 未配置时**逐字回落默认名**（老配置零迁移）。
// 末条接线用例的**鉴别力已实测**（2026-09-23 复核补强）：此前只对 openai 侧断言，把
// anthropicStream 的 pickModelName 拆线（不传 modelByFormat，或请求体改回 `model`）时
// 该用例**仍 9 pass / 0 fail**。补上 anthropic 侧专用名断言后重跑同一拆线实验，两次都变为
// 11 pass / 1 fail（红），即该用例现在真的能钉住两个协议的接线。
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickModelName, modelNameCandidates, normalizeModelByFormat } from '../kernel/wire/model.mjs'
import { setProvider } from '../kernel/provider.mjs'
import { streamMessages, resetAutoFormatCacheForTest } from '../kernel/api.mjs'

test('模型名映射：该协议有显式值则用它（MiniMax 实证场景）', () => {
  // Anthropic 侧接受 MiniMax-M3[1m]；OpenAI 侧只认 MiniMax-M3
  assert.equal(
    pickModelName({ model: 'MiniMax-M3[1m]', format: 'openai', modelByFormat: { openai: 'MiniMax-M3' } }),
    'MiniMax-M3',
  )
  assert.equal(
    pickModelName({ model: 'MiniMax-M3[1m]', format: 'anthropic', modelByFormat: { openai: 'MiniMax-M3' } }),
    'MiniMax-M3[1m]',  // 未覆盖 anthropic ⇒ 回落默认名
  )
})

test('模型名映射：未配置时回落 model（老配置零迁移）', () => {
  assert.equal(pickModelName({ model: 'deepseek-v4-flash', format: 'openai' }), 'deepseek-v4-flash')
  assert.equal(pickModelName({ model: 'deepseek-v4-flash', format: 'anthropic', modelByFormat: {} }), 'deepseek-v4-flash')
})

test('模型名映射：显式空值不算覆盖（回落默认，防误填空串）', () => {
  assert.equal(pickModelName({ model: 'm', format: 'openai', modelByFormat: { openai: '' } }), 'm')
  assert.equal(pickModelName({ model: 'm', format: 'openai', modelByFormat: { openai: '   ' } }), 'm')
  assert.equal(pickModelName({ model: 'm', format: 'openai', modelByFormat: { openai: null } }), 'm')
})

test('模型名映射：model 为空返回空串（不抛）', () => {
  assert.equal(pickModelName({ model: '', format: 'openai' }), '')
  assert.equal(pickModelName({ model: undefined, format: 'anthropic' }), '')
})

// ── 归一（Task 1 导出、Task 4 才消费；此处先钉住语义，免得到接线时各自发明）────
test('归一 modelByFormat：丢空值、trim、丢未知协议键（GUI"留空即默认"的心智模型）', () => {
  assert.deepEqual(
    normalizeModelByFormat({ openai: '', anthropic: ' x ', other: 'y' }),
    { anthropic: 'x' },
  )
  // 只有空白的值等同未填（GUI 上删光输入框剩空格的情形）
  assert.deepEqual(normalizeModelByFormat({ openai: '   ', anthropic: '' }), {})
})

test('归一 modelByFormat：非法输入一律 {}（不抛、不返回 null）', () => {
  for (const v of [null, undefined, '', 'MiniMax-M3', ['MiniMax-M3'], 42, true]) {
    assert.deepEqual(normalizeModelByFormat(v), {}, `输入 ${JSON.stringify(v)} 应归一为 {}`)
  }
  // 值本身非字符串（GUI/外部写入 json 的脏数据）按未填处理，不 toString
  assert.deepEqual(normalizeModelByFormat({ openai: 42, anthropic: { name: 'x' } }), {})
})

test('归一 modelByFormat：两键都有值时都保留且已 trim（不串、不丢）', () => {
  assert.deepEqual(
    normalizeModelByFormat({ openai: ' MiniMax-M3 ', anthropic: 'MiniMax-M3[1m] ' }),
    { openai: 'MiniMax-M3', anthropic: 'MiniMax-M3[1m]' },
  )
  // 归一结果可直接喂 pickModelName（Task 4 的消费方式）
  assert.deepEqual(
    pickModelName({ model: 'MiniMax-M3[1m]', format: 'openai', modelByFormat: normalizeModelByFormat({ openai: ' MiniMax-M3 ' }) }),
    'MiniMax-M3',
  )
})

// ── 价格匹配（Task 1 Step 7）────────────────────────────────────────────────
// 为什么单列：`provider.modelPrices` 的**键就是模型名**（bridge 序列化进 PONOS_MODEL_PRICES，
// 内核价目查找按"键名 === 当前模型名"匹配）。真正下发的 wire 名可能与默认名不同 ⇒ 用户按
// 默认名填的单价会匹配不上，**成本统计静默归零**（看不出错的错）。故查找方按候选序列
// "wire 名 → 默认名"依次取首个命中。
// 注意：本仓当前分支**尚无**价目查找调用点（`resolveModelPrices` / `PONOS_MODEL_PRICES`
// 在 `feature/loop-phase1-reliability` 工作线上，未合入本分支）——这里锁定的是**查找语义**
// （候选序列的次序与去重），供该调用点接线时直接消费，避免届时各自发明一套。
const priceOf = (names, prices) => names.map((n) => prices[n]).find(Boolean)

test('价格候选序列：wire 名在前、默认名兜底；同名只出一项；trim 归一', () => {
  assert.deepEqual(
    modelNameCandidates({ model: 'MiniMax-M3[1m]', format: 'openai', modelByFormat: { openai: ' MiniMax-M3 ' } }),
    ['MiniMax-M3', 'MiniMax-M3[1m]'],
  )
  // 未配置 ⇒ 只有默认名（老配置行为逐字不变）
  assert.deepEqual(modelNameCandidates({ model: 'deepseek-v4-flash', format: 'openai' }), ['deepseek-v4-flash'])
  // wire 名与默认名相同 ⇒ 去重，不重复查
  assert.deepEqual(
    modelNameCandidates({ model: 'm', format: 'openai', modelByFormat: { openai: 'm' } }),
    ['m'],
  )
  assert.deepEqual(modelNameCandidates({ model: '', format: 'openai' }), [])
})

test('价格匹配：只填默认模型名的单价时，OpenAI 协议下仍能命中（wire 名回退默认名）', () => {
  const prices = { 'MiniMax-M3[1m]': { input: 1, output: 2 } }
  const names = modelNameCandidates({ model: 'MiniMax-M3[1m]', format: 'openai', modelByFormat: { openai: 'MiniMax-M3' } })
  // 反面对照（鉴别力证明）：若按**单值** wire 名查（引入 modelByFormat 前的等价写法），必然查不到
  // ⇒ 成本静默归零。本断言保证下面的"命中"不是因为表格里恰好有 wire 名的键。
  assert.equal(prices['MiniMax-M3'], undefined, '价目表里没有 wire 名键，单值查找必失败')
  assert.deepEqual(priceOf(names, prices), { input: 1, output: 2 })
})

test('价格匹配：两套协议各填单价时各自命中（不串）', () => {
  const prices = { 'MiniMax-M3': { input: 0.5, output: 1 }, 'MiniMax-M3[1m]': { input: 1, output: 2 } }
  const at = (format) => priceOf(modelNameCandidates({ model: 'MiniMax-M3[1m]', format, modelByFormat: { openai: 'MiniMax-M3' } }), prices)
  assert.deepEqual(at('openai'), { input: 0.5, output: 1 }, 'OpenAI 协议用协议专属单价')
  assert.deepEqual(at('anthropic'), { input: 1, output: 2 }, 'Anthropic 协议用默认名单价')
})

test('价格匹配：两套协议单价都缺失时返回 undefined（显示"无单价"，不得静默按 0 计价）', () => {
  const names = modelNameCandidates({ model: 'MiniMax-M3[1m]', format: 'openai', modelByFormat: { openai: 'MiniMax-M3' } })
  assert.equal(priceOf(names, {}), undefined)
  // 对照：undefined 与"真 0 价"（厂商免费额度）在语义上必须可区分，否则两者都被当成 0 计
  const free = priceOf(names, { 'MiniMax-M3': { input: 0, output: 0 } })
  assert.deepEqual(free, { input: 0, output: 0 })
})

// ── 接线回归（Task 1 Step 5 的可验证面）─────────────────────────────────────
// 为什么必须有这一条：上面的纯函数用例全绿也不能证明 api.mjs 真的用了它——把
// `model: wireModel` 改回 `model` 时，其余用例**一条都不会红**。故走真实调用链
// （streamMessages → anthropicStream/openaiStream → fetch），断言请求体里的 model。
// 说明：`getProvider()` 现读 env 的路径要等 Task 2 才带 `modelByFormat`，故此处先用
// setProvider 取得注册表对象再**就地**补该字段（不改产品代码）；Task 2 落地 env 读取后，
// 本用例仍成立（届时可改为直接走 env 构造）。
test('接线：两个协议的下发模型名都取自 pickModelName（未配置时逐字回落）', async () => {
  const prevEnv = { ...process.env }
  const prevFetch = global.fetch
  const seen = []
  const openaiSse = 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  const anthropicSse = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  global.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) })
    const isOpenAI = String(url).endsWith('/v1/chat/completions')
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(isOpenAI ? openaiSse : anthropicSse)); c.close() } }) }
  }
  Object.assign(process.env, {
    PONOS_BASE_URL: 'https://api.minimaxi.com/anthropic',   // detectProtocol 只判存在性
    PONOS_STREAM_RECONNECTS: '0',
    PONOS_API_FORMAT: 'auto',
  })
  const { provider } = setProvider({ baseUrl: 'https://api.minimaxi.com/anthropic', authToken: 'k', model: 'MiniMax-M3[1m]' })
  const drain = async (format) => {
    seen.length = 0
    process.env.PONOS_API_FORMAT = format
    resetAutoFormatCacheForTest()
    for await (const _ of streamMessages({ model: 'MiniMax-M3[1m]', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })) { /* drain */ }
    return seen[0]
  }
  try {
    provider.modelByFormat = { openai: 'MiniMax-M3' }
    const anth = await drain('anthropic')
    assert.ok(anth.url.endsWith('/anthropic/v1/messages'), anth.url)
    assert.equal(anth.body.model, 'MiniMax-M3[1m]', 'anthropic 未覆盖 ⇒ 回落默认名（零回归）')

    const oa = await drain('openai')
    assert.ok(oa.url.endsWith('/v1/chat/completions'), oa.url)
    assert.equal(oa.body.model, 'MiniMax-M3', 'openai 有显式值 ⇒ 用它（MiniMax 实证场景）')

    // ★ 鉴别力（只对 openai 断言时本用例其实没有鉴别力）：给 anthropic 也填一个专用名，
    //   两键并存下分别断言——若 anthropicStream 把 pickModelName 拆线（不传 modelByFormat
    //   或把请求体改回 model），下面的断言立刻变红，见本文件头注的"拆线实验"记录。
    provider.modelByFormat = { openai: 'MiniMax-M3', anthropic: 'MiniMax-M3-anthropic' }
    const anthCovered = await drain('anthropic')
    assert.equal(anthCovered.body.model, 'MiniMax-M3-anthropic', 'anthropic 有显式值 ⇒ 用它（证明 anthropic 侧覆盖真生效）')
    const oaCovered = await drain('openai')
    assert.equal(oaCovered.body.model, 'MiniMax-M3', '两键并存时各走各的，不串')

    provider.modelByFormat = undefined
    const oa2 = await drain('openai')
    assert.equal(oa2.body.model, 'MiniMax-M3[1m]', '未配置 modelByFormat ⇒ 与改动前逐字相同')
    const anth2 = await drain('anthropic')
    assert.equal(anth2.body.model, 'MiniMax-M3[1m]', '未配置 modelByFormat ⇒ anthropic 侧同样逐字回落（零回归）')
  } finally {
    global.fetch = prevFetch
    process.env = prevEnv
    resetAutoFormatCacheForTest()
  }
})


