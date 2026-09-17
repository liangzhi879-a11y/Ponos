// src/components/mcp/mcpFormat.test.ts（2026-09-16 由 src/components/settings/ 迁入；既有断言原样保留）
// MCP 面板状态归并 + 授权档位/校验的测试。
//
// 测什么（挑真实风险，不凑覆盖率）：
//   ① **running 必须压过旧结论**：点「测试」时若仍显示上一次的「✓ 5 个工具」，
//      用户会以为测完了、拿旧结果当新结论。
//   ② **toolsOf 仅在成功时给清单**：失败后若还留着上次的工具名，是明确的误导。
//   ③ **统计只认当前配置里的服务器**：用户删掉一台后，残留的测试记录不得再计入
//      「N 通 / M 失败」，否则汇总数字与实际配置对不上。
//   ④ **一台失败不影响另一台**：这是「多服务器支持」在 UI 层的体现——
//      2 通 1 失败必须如实呈现为 2 通 1 失败，而不是整体判失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  badgeOf, toolsOf, errorOf, summarize, summaryText, transportOf, configForTransport, canSaveConfig,
  parseKeyValueLines, formatKeyValueLines, parseArgLines, formatArgLines, nextDraft,
  authLevelOf, applyAuthLevel, validateRowsMsg,
  promptListOf, promptsOfServer, promptArgsOf, renderPromptText, MCP_PROMPT_PREVIEW_CHARS,
  requiredPromptArgsOf, missingPromptArgs,
  type McpTestState,
} from './mcpFormat.ts'

const TOOLS = [{ name: 'echo' }, { name: 'boom' }]
const OK: McpTestState = { ok: true, tools: TOOLS }
const BAD: McpTestState = { ok: false, error: '已退出（code=1）' }

test('badgeOf：未测试=untested；running 优先于旧结论', () => {
  assert.equal(badgeOf(undefined), 'untested')
  assert.equal(badgeOf(OK), 'ok')
  assert.equal(badgeOf(BAD), 'failed')
  // 关键：测试进行中即便带着上一次的 ok，也必须显示 running
  assert.equal(badgeOf({ running: true, ok: true, tools: TOOLS }), 'running')
  assert.equal(badgeOf({ running: true, ok: false }), 'running')
})

test('toolsOf：仅在「已测且成功」时返回清单', () => {
  assert.deepEqual(toolsOf(OK).map(t => t.name), ['echo', 'boom'])
  assert.deepEqual(toolsOf(BAD), [], '失败不得残留上次工具清单')
  assert.deepEqual(toolsOf(undefined), [])
  assert.deepEqual(toolsOf({ running: true, ok: true, tools: TOOLS }), [], '测试中不得把旧清单当结论')
})

test('errorOf：仅在「已测且失败」时返回原因', () => {
  assert.equal(errorOf(BAD), '已退出（code=1）')
  assert.equal(errorOf(OK), '', '成功不得显示错误')
  assert.equal(errorOf({ running: true, ok: false, error: 'x' }), '', '测试中不显示上一次的失败')
  assert.equal(errorOf(undefined), '')
})

test('summarize：多服务器如实呈现（2 通 1 失败 ≠ 整体失败）', () => {
  const tests = { a: OK, b: OK, c: BAD }
  const s = summarize(['a', 'b', 'c'], tests)
  assert.deepEqual(
    { total: s.total, ok: s.ok, failed: s.failed, untested: s.untested },
    { total: 3, ok: 2, failed: 1, untested: 0 },
  )
  assert.equal(s.settled, true)
})

test('summarize：只统计当前配置里的服务器（删掉的残留记录不计入）', () => {
  // 配置里只剩 a，但 tests 里还留着已删的 z 的记录
  const s = summarize(['a'], { a: OK, z: BAD })
  assert.equal(s.total, 1)
  assert.equal(s.failed, 0, '已删除服务器的失败记录不得计入汇总')
  assert.equal(s.ok, 1)
})

test('summarize：空配置与未测试状态', () => {
  const empty = summarize([], {})
  assert.equal(empty.total, 0)
  assert.equal(empty.settled, true, '没有任何服务器时视为已就绪（按钮不该永远忙碌）')

  const notRun = summarize(['a', 'b'], {})
  assert.equal(notRun.untested, 2)
  assert.equal(notRun.settled, false)

  const running = summarize(['a'], { a: { running: true } })
  assert.equal(running.testing, 1)
  assert.equal(running.settled, false)
})

test('summaryText：全通时不列 0 项（避免「2 通 · 0 失败 · 0 未测」噪声）', () => {
  const L = { ok: '通', failed: '失败', testing: '测试中', untested: '未测' }
  assert.equal(summaryText(summarize(['a', 'b'], { a: OK, b: OK }), L), '2 通')
  assert.equal(summaryText(summarize(['a', 'b', 'c'], { a: OK, b: OK, c: BAD }), L), '2 通 · 1 失败')
  assert.equal(summaryText(summarize([], {}), L), '', '无服务器时无文案')
})

// 【HTTP 传输，2026-09-16】传输类型判定必须是纯函数：
// 面板要用它决定渲染哪一组字段，且「切换传输时清另一侧字段」也读它。
// 判定口径与内核 normalizeMcpServers 一致（按 url 是否存在），
// 但**不做**校验（command+url 并存仍报 'http'，交给内核 400 兜底）——
// 前端重复实现校验规则只会造出第二份会漂移的真源。
test('transportOf：按 url 判定传输类型（有 url 即 HTTP，否则 stdio）', () => {
  assert.equal(transportOf({ command: 'npx', args: [] }), 'stdio')
  assert.equal(transportOf({ url: 'https://e.com/mcp' }), 'http')
  assert.equal(transportOf({ url: 'http://127.0.0.1:8080/mcp', headers: { A: 'B' }, timeoutMs: 5000 }), 'http')
  assert.equal(transportOf({ command: 'node', args: [], env: {}, cwd: '/tmp', timeoutMs: 1000 }), 'stdio')
})

// 【HTTP 传输，2026-09-16】切换传输的实现 + 一个必须钉住的陷阱。
test('configForTransport：清掉另一侧字段，且保留两传输共用的 timeoutMs', () => {
  // 清另一侧不是洁癖：内核把「command 与 url 并存」「args/env/cwd 配 url」
  // 「headers 配 command」一律判 400。字段若只是被 UI 藏起来，保存就会被拒，
  // 而界面上找不到任何可疑输入 —— 属于极难自诊的失败。
  const fromStdio = configForTransport(
    { command: 'npx', args: ['-y'], env: { A: '1' }, cwd: '/x', timeoutMs: 12345 }, 'http',
  )
  assert.equal(fromStdio.url, '')
  assert.equal(fromStdio.command, undefined, 'HTTP 形态不得残留 command（与 url 并存会被 400）')
  assert.equal(fromStdio.args, undefined, 'HTTP 形态不得残留 args')
  assert.equal(fromStdio.env, undefined, 'HTTP 形态不得残留 env')
  assert.equal(fromStdio.cwd, undefined, 'HTTP 形态不得残留 cwd')
  assert.equal(fromStdio.timeoutMs, 12345, 'timeoutMs 两传输共用，切一次就丢会让用户白设')

  const fromHttp = configForTransport({ url: 'https://e.com/mcp', headers: { A: 'B' }, timeoutMs: 999 }, 'stdio')
  assert.equal(fromHttp.url, undefined, 'stdio 形态不得残留 url')
  assert.equal(fromHttp.headers, undefined, 'stdio 形态不得残留 headers')
  assert.equal(fromHttp.command, '')
  assert.equal(fromHttp.args?.length, 0)
  assert.equal(fromHttp.timeoutMs, 999)
})

// 【交互自查，2026-09-16】多行编辑器的"半成品输入不被抹掉"。
//
// 背景：面板里 args / env / headers 三个多行框的"值"都是解析结果，
// 而 `format(parse(text))` 是**有损**的。若拿它当受控值，用户每敲一个字符就被抹一次：
//   · env/headers：敲 "A"（还没到 `=`）→ 解析为空 → 受控值回空串 ⇒ 一个字都打不进去；
//   · args：敲回车 → 尾随空行被过滤 → 受控值回退 ⇒ 回车"没反应"，无法一行一个参数。
// 这类 bug 不报错、typecheck 与既有单测都拦不住，只表现为"输入框怪怪的"，故在此钉住。
test('parse/format：KEY=VALUE 只按第一个 = 切分，且半输入行会被忽略（有损是刻意的）', () => {
  assert.deepEqual(parseKeyValueLines('Authorization=Bearer ${TOKEN}'), { Authorization: 'Bearer ${TOKEN}' })
  assert.deepEqual(parseKeyValueLines('TOKEN=abc=='), { TOKEN: 'abc==' }, '值里的 = 不能被当分隔符')
  assert.deepEqual(parseKeyValueLines('A=1\n\nB=2'), { A: '1', B: '2' }, '空行忽略')
  assert.deepEqual(parseKeyValueLines('=x'), {}, '键为空的行忽略')
  assert.deepEqual(parseKeyValueLines('A'), {}, '还没敲到 = ⇒ 解析为空（这正是"直接受控"会吞字的根因）')
  assert.equal(formatKeyValueLines({ A: '1', B: '2' }), 'A=1\nB=2')
})

test('回归：env/headers 连敲一串字符，草稿不被"回声"抹掉', () => {
  // 模拟一次真实按键序列：组件草稿 + 父组件「解析→序列化」回声，逐字符走一遍。
  let draft = ''
  let lastExternal = ''
  const type = (ch: string) => {
    draft += ch
    const external = formatKeyValueLines(parseKeyValueLines(draft))  // 父组件回灌的受控值
    const next = nextDraft(draft, external, lastExternal)
    draft = next.draft
    lastExternal = next.lastExternal
  }
  for (const ch of 'A=1\nB=2') type(ch)
  assert.equal(draft, 'A=1\nB=2', '草稿应完整保留用户敲的原文')
  assert.deepEqual(parseKeyValueLines(draft), { A: '1', B: '2' })

  // 对照：若无草稿（直接受控于 format(parse())），第一个字符就被解析丢弃 ⇒ 输入框永远空
  assert.deepEqual(parseKeyValueLines('A'), {})
  assert.equal(formatKeyValueLines(parseKeyValueLines('A')), '', '受控值回到空串 —— 字被打进去又被抹掉')
})

test('回归：args 连敲 a⏎b，回车不被吃掉', () => {
  let draft = ''
  let lastExternal = ''
  const type = (ch: string) => {
    draft += ch
    const external = formatArgLines(parseArgLines(draft))
    const next = nextDraft(draft, external, lastExternal)
    draft = next.draft
    lastExternal = next.lastExternal
  }
  for (const ch of 'a\nb') type(ch)
  assert.equal(draft, 'a\nb')
  assert.deepEqual(parseArgLines(draft), ['a', 'b'])

  // 对照：直接受控时尾随换行被 filter(Boolean) 抹掉 ⇒ 回车"没反应"
  assert.deepEqual(parseArgLines('a\n'), ['a'])
  assert.equal(formatArgLines(parseArgLines('a\n')), 'a', '受控值回退成一行 —— 换行按了等于没按')
})

test('nextDraft：仅"外部真变了"才回灌（重新读取 / 切换传输清空要能生效）', () => {
  assert.deepEqual(
    nextDraft('A=1\nB', 'A=1', 'A=1'), { draft: 'A=1\nB', lastExternal: 'A=1' },
    '外部值没变（是自己输入的回声）⇒ 保留草稿，否则半成品会被抹掉',
  )
  assert.deepEqual(
    nextDraft('A=1', '', 'A=1'), { draft: '', lastExternal: '' },
    '外部清空（切换传输把认证头清空）⇒ 必须接受，否则残留旧内容会让人以为还在生效',
  )
  assert.deepEqual(
    nextDraft('old', 'new-from-reload', 'old'), { draft: 'new-from-reload', lastExternal: 'new-from-reload' },
    '重新读取后配置变了 ⇒ 覆盖草稿',
  )
})

// 【交互自查，2026-09-16】保存按钮的可用性 —— 含一条真实的数据丢失路径。
test('canSaveConfig：读取失败时必须禁用保存（否则空列表会覆盖磁盘上那份配置）', () => {
  // 配置文件损坏时 GET /mcp 返回 ok:false + servers:{}（后端刻意用 200 好让界面显示原因），
  // 界面拿到 rows=[]。若此时仍允许保存，一次点击就把空配置 PUT 回磁盘，
  // 覆盖掉那份也许只是少了个括号、还能手工救回来的文件。
  assert.equal(
    canSaveConfig({ rowCount: 0, validateMsg: '', loadFailed: true }), false,
    '读不出当前状态 ⇒ 不许写：空列表是"读失败"的假象，不是"用户清空了配置"',
  )
  assert.equal(canSaveConfig({ rowCount: 2, validateMsg: '', loadFailed: true }), false,
    '读取失败时即便界面上还留着行，也不该允许保存（状态本身不可信）')

  // 正常路径不受影响
  assert.equal(canSaveConfig({ rowCount: 0, validateMsg: '', loadFailed: false }), true,
    '文件不存在时内核返回 ok:true + 空配置 ⇒ 首次使用必须能保存')
  assert.equal(canSaveConfig({ rowCount: 1, validateMsg: '', loadFailed: false }), true)
  assert.equal(canSaveConfig({ rowCount: 1, validateMsg: '名称与命令均为必填', loadFailed: false }), false,
    '有校验错误时不许保存')
  assert.equal(canSaveConfig({ rowCount: 3, validateMsg: 'URL 必填', loadFailed: false }), false)
})

test('陷阱回归：**不得从 config 反推编辑态的传输类型**（否则"远程 HTTP"会选不中）', () => {
  // 真实故障：面板曾用 transportOf(row.config) 反推当前传输类型来决定按钮高亮与渲染哪组字段。
  // 而刚切到 HTTP 时 url 还是空串（用户还没填），transportOf 便判回 'stdio' ⇒
  // setTransport 认为"没变化"直接 return、高亮弹回「本地命令」、HTTP 表单不渲染，
  // 用户看到的就是"点『远程 HTTP』选不中"。
  // 根因是**空值状态表达不了"已选 HTTP 但还没填 URL"**：意图必须另存（Row.transport），
  // 不能靠数据倒推。下面这条断言把这个事实固定下来，防止有人改回反推写法。
  const justSwitched = configForTransport({ command: 'npx' }, 'http')
  assert.equal(transportOf(justSwitched), 'stdio',
    '空 url 被判成 stdio —— 这正是不该用 transportOf 反推编辑态的原因')

  // 而"读取已保存的合法配置"仍可用它判定：后端只存合法数据，HTTP 条目必有非空 url
  assert.equal(transportOf({ url: 'https://e.com/mcp' }), 'http')
})

// 【MCP 顶层面板与授权模型，2026-09-16】授权档位（四档）与配置的互转。
//
// 为什么把"档位 ↔ 配置"做成纯函数：档位是界面概念（关闭 / 仅测试 / 公开 / 指定 agent），
// 配置是磁盘契约（enabled + expose.mode + expose.bindAgents）。两者互转若散在 JSX 里，
// 最容易出的错就是**静默的权限扩大**——比如把"仅测试"当成"公开"写进文件，
// 用户以为只是测试，AI 却已经能用；或切档时把 bindAgents 清空导致"指定 agent"变成无人可用。
test('授权档位 ↔ 配置互转：四档语义清晰且往返稳定', () => {
  // off：不连接（内核连进程都不起）
  assert.equal(authLevelOf({ command: 'x', enabled: false, expose: { mode: 'public', bindAgents: [] } }), 'off')
  // test：连上但不给任何 AI（面板仍可测试）
  assert.equal(authLevelOf({ command: 'x', enabled: true, expose: { mode: 'private', bindAgents: [] } }), 'test')
  assert.equal(authLevelOf({ command: 'x', enabled: true, expose: { mode: 'public', bindAgents: [] } }), 'public')
  assert.equal(authLevelOf({ command: 'x', enabled: true, expose: { mode: 'bound', bindAgents: ['a'] } }), 'bound')
  // 存量配置（无新字段）= 开启 + 公开
  assert.equal(authLevelOf({ command: 'x' }), 'public')

  const base = { command: 'x' }
  assert.equal(authLevelOf(applyAuthLevel(base, 'off')), 'off')
  assert.equal(authLevelOf(applyAuthLevel(base, 'test')), 'test')
  assert.equal(authLevelOf(applyAuthLevel(base, 'public')), 'public')
  // 切到 bound 但还没选 agent：仍是 bound 档（空列表情形由校验拦保存）
  assert.equal(authLevelOf(applyAuthLevel(base, 'bound')), 'bound')
  // 从 bound 切走再切回：agent 列表要保留（否则用户要重选）
  const withAgents = applyAuthLevel(applyAuthLevel(base, 'bound'), 'bound')
  const bound = { ...withAgents, expose: { mode: 'bound' as const, bindAgents: ['r'] } }
  assert.equal(authLevelOf(bound), 'bound')
  assert.deepEqual(applyAuthLevel(bound, 'public').expose, { mode: 'public', bindAgents: ['r'] },
    '切档时保留列表：切回来不用重选（列表在非 bound 档不生效，留在配置里也无害）')
})

test('bound 无 agent ⇒ 校验必须报错（fail-closed 的界面侧对应）', () => {
  const rows = [{ key: '1', name: 'jira', transport: 'http' as const,
    config: { url: 'https://e.com/mcp', enabled: true, expose: { mode: 'bound' as const, bindAgents: [] } } }]
  assert.ok(validateRowsMsg(rows), 'bound 而无人可用 ⇒ 保存按钮必须被禁用，并在保存时报错')
})

test('关闭的服务器不因缺 URL/命令而报错（它本来就不连接）', () => {
  const rows = [{ key: '1', name: 'x', transport: 'stdio' as const,
    config: { command: '', enabled: false, expose: { mode: 'public' as const, bindAgents: [] } } }]
  assert.equal(validateRowsMsg(rows), '', '关闭的服务器没有必填项 —— 校验它会让用户无法保存')
})

// ---------------------------------------------------------------------------
// prompt 模板（2026-09-16，第二批；D-4：prompts 是 user-controlled，绝不给模型自动调用）
//
// 测什么（都是"只表现为界面上的一行字"、坏了却很难查的性质）：
//   ① 服务器返回的**不可信形状**不得让面板白屏（`arguments` 缺失/不是数组/required 是字符串）；
//   ② 多服务器下**错误不得串台**（A 台连不上的原因画到 B 台卡片上，用户会去修一台没坏的）；
//   ③ 必填参数的空串/纯空白必须算"没填"（否则渲染出的文本里那段变量是空的，用户不知道为什么）；
//   ④ 超长文本只裁剪**预览**，且要如实报出原始长度（把预览当全文复制走是静默的数据丢失）。
test('promptListOf：归一化服务器给的形状，坏数据一律安全缺省（绝不抛）', () => {
  assert.deepEqual(promptListOf(undefined), [])
  assert.deepEqual(promptListOf('oops'), [], '非数组不得让 .map 崩掉面板')
  assert.deepEqual(promptListOf([null, 42, { noName: 1 }]), [], '没有名字的模板无法选中/取回，直接丢')

  const got = promptListOf([
    { name: ' summarize ', description: '总结', arguments: [{ name: 'text', description: '要总结的', required: true }] },
    { name: 'greet' },                                   // 无 arguments 字段
    { name: 'weird', arguments: 'not-an-array' },         // 形状不对
    { name: 'str', arguments: [{ name: 'a', required: 'true' }, { name: '' }] },  // required 是字符串
  ])
  assert.deepEqual(got.map(p => p.name), ['summarize', 'greet', 'weird', 'str'])
  assert.deepEqual(got[0].arguments, [{ name: 'text', description: '要总结的', required: true }])
  assert.deepEqual(got[1].arguments, [], '缺 arguments ⇒ 空数组（界面据此渲染"无参数"而不是崩）')
  assert.deepEqual(got[2].arguments, [], '非数组 ⇒ 空数组')
  // required 只认显式 true：字符串 'true' 若被当真，界面上每个字段都会变成必填
  assert.deepEqual(got[3].arguments, [{ name: 'a', description: '', required: false }], '无名参数要丢掉')
})

test('promptsOfServer：多服务器下错误不串台；缺条目 ⇒ 空清单 + 空错误（不谎报失败）', () => {
  const res = {
    servers: { alpha: { prompts: [{ name: 'p1' }] }, beta: {} },
    errors: { beta: '连接失败：ECONNREFUSED' },
    disabled: ['off'],
  }
  assert.deepEqual(promptsOfServer(res, 'alpha'),
    { prompts: [{ name: 'p1', description: '', arguments: [] }], error: '', known: true })
  assert.equal(promptsOfServer(res, 'beta').error, '连接失败：ECONNREFUSED')
  assert.deepEqual(promptsOfServer(res, 'beta').prompts, [], '失败的那台不该显示上一次/别台的模板')
  assert.equal(promptsOfServer(res, 'off').known, true, '已关闭的台也在配置里（桥只是没连它）')
  // 名字不在桥看到的配置里（最常见：改了名还没保存）⇒ 必须能与"没提供模板"分开，
  // 否则用户会去服务器那边查一个根本不存在的问题
  assert.deepEqual(promptsOfServer(res, 'ghost'), { prompts: [], error: '', known: false })
  assert.equal(promptsOfServer(res, '  alpha  ').known, true, '名字两侧空白不该影响命中')
  assert.deepEqual(promptsOfServer(null, 'alpha'), { prompts: [], error: '', known: false })
  assert.deepEqual(promptsOfServer({ servers: { a: {} }, errors: { a: 123 as unknown as string } }, 'a').error, '',
    '非字符串错误值按"没有错误"处理，避免界面渲染出 [object Object]')
})

test('promptArgsOf：只认显式 required；空串/纯空白算没填；丢弃声明之外的键', () => {
  const decl = [{ name: 'text', required: true }, { name: 'tone' }]
  // 必填没填 ⇒ 按钮必须被拦下（这是"渲染"按钮唯一的禁用判据）
  const missing = promptArgsOf(decl, { tone: '简洁' })
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.missing, ['text'])
  // 纯空白与"没填"对服务器是同一件事：判为已填会让用户拿到一段少了变量的文本
  assert.equal(promptArgsOf(decl, { text: '   ' }).ok, false, '空格不算填了')
  assert.deepEqual(promptArgsOf(decl, { text: '   ' }).payload, {}, '空白值不得发给服务器')

  const ok = promptArgsOf(decl, { text: '正文', tone: '简洁' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.payload, { text: '正文', tone: '简洁' })
  // 可选参数没填不算错，也不进载荷（服务器收到空串可能判成"显式置空"）
  assert.deepEqual(promptArgsOf(decl, { text: '正文' }), { ok: true, missing: [], payload: { text: '正文' } })
  // 切换模板后残留的旧值不该被送出去
  assert.deepEqual(promptArgsOf(decl, { text: 'x', stale: 'y' }).payload, { text: 'x' })
  // 无参数模板（声明为空/缺失）：直接可渲染
  assert.deepEqual(promptArgsOf([], undefined), { ok: true, missing: [], payload: {} })
  assert.deepEqual(promptArgsOf(undefined, { a: '1' }), { ok: true, missing: [], payload: {} }, '没有声明就没有可发的参数')
  // 多个必填缺失时按声明顺序报（提示文案要稳定，不能随对象键序抖动）
  assert.deepEqual(promptArgsOf([{ name: 'b', required: true }, { name: 'a', required: true }], {}).missing, ['b', 'a'])
})

test('renderPromptText：空文本单列；超长只裁剪预览并如实报原始长度', () => {
  const empty = renderPromptText('')
  assert.deepEqual(empty, { text: '', truncated: false, originalChars: 0, empty: true })
  assert.equal(renderPromptText('   \n ').empty, true, '纯空白也算空：界面要给一句解释，而不是一片空白')
  assert.equal(renderPromptText(undefined).empty, true)
  assert.equal(renderPromptText(null).empty, true)

  const short = renderPromptText('短文本')
  assert.deepEqual(short, { text: '短文本', truncated: false, originalChars: 3, empty: false })

  // 两处"看起来对但错"的写法：① 等长也裁；② 裁了却不报原始长度（用户以为拿到全文）
  const atLimit = renderPromptText('x'.repeat(MCP_PROMPT_PREVIEW_CHARS))
  assert.equal(atLimit.truncated, false, '刚好等于上限不裁')
  const long = renderPromptText('x'.repeat(MCP_PROMPT_PREVIEW_CHARS + 5))
  assert.equal(long.truncated, true)
  assert.equal(long.text.length, MCP_PROMPT_PREVIEW_CHARS)
  assert.equal(long.originalChars, MCP_PROMPT_PREVIEW_CHARS + 5, '必须报**原始**长度：只给预览长度等于隐瞒截断')
  // 上限可调（用例/将来改小都走同一条路径），非法上限回退默认
  assert.equal(renderPromptText('abcdef', 3).text, 'abc')
  assert.equal(renderPromptText('abcdef', 0).truncated, false, '0/负数 → 回退默认上限，不是"裁成空串"')
  // 非字符串（服务器回了数字/对象）也要能显示，不得抛
  assert.equal(renderPromptText(42).text, '42')
  // 上限的两种写法等价（数字 / { max }）：两处调用各自写一种时不得出现不同结论
  assert.deepEqual(renderPromptText('abcdef', { max: 3 }), renderPromptText('abcdef', 3))
  assert.equal(renderPromptText('abcdef', { max: 0 }).truncated, false, '{ max } 的非法值同样回退默认')
  assert.equal(renderPromptText('abcdef', {}).truncated, false, '缺 max ⇒ 默认上限')
  assert.equal(renderPromptText('abcdef', 999).text.length, 6, '不超限不裁剪')
})

// 【提交前校验，第二批】必填清单与"缺哪几项"——它们是"渲染"按钮唯一的禁用判据。
//
// 为什么单独钉这两条：它们只影响界面上的一行提示，坏了不会报错，只会让用户
// ① 点了才知道缺什么（提示不到点上），或 ② 被判为"缺参数"却怎么填都不通过。
test('requiredPromptArgsOf：只认显式 required（缺省即选填），且坏声明一律安全缺省', () => {
  assert.deepEqual(requiredPromptArgsOf(undefined), [])
  assert.deepEqual(requiredPromptArgsOf({ arguments: 'not-an-array' }), [], '形状不对不得让面板崩')
  assert.deepEqual(requiredPromptArgsOf({ arguments: [null, 7, { name: '' }] }), [], '无名/非对象声明丢弃')
  assert.deepEqual(
    requiredPromptArgsOf({ arguments: [{ name: 'text', required: true }, { name: 'tone' }, { name: 'x', required: 'true' }] })
      .map(a => a.name),
    ['text'],
    '字符串 "true" 不算必填 —— 否则界面上每个字段都会被标成必填',
  )
  assert.deepEqual(
    requiredPromptArgsOf({ arguments: [{ name: 'b', required: true }, { name: 'a', required: true }] }).map(a => a.name),
    ['b', 'a'],
    '顺序按声明（提示文案要稳定，不能随对象键序抖动）',
  )
})

test('missingPromptArgs：必填缺失要点名 —— 空串与纯空白都算没填（反向断言：不放过）', () => {
  const decl = { arguments: [{ name: 'text', required: true }, { name: 'tone' }] }
  // 不放过空串 / 纯空白：判成"填了"会让用户拿到一段少了变量的文本，且不知道为什么
  assert.deepEqual(missingPromptArgs(decl, {}), ['text'], '没填')
  assert.deepEqual(missingPromptArgs(decl, { text: '' }), ['text'], '空串算没填')
  assert.deepEqual(missingPromptArgs(decl, { text: '   ' }), ['text'], '纯空白算没填')
  assert.deepEqual(missingPromptArgs(decl, { text: '\n\t ' }), ['text'], '换行/制表符同样算没填')
  assert.deepEqual(missingPromptArgs(decl, { tone: '简洁' }), ['text'], '只填了选填项 ⇒ 仍缺 text')
  // 反向：填了就**不得**再报缺失（否则按钮永远点不了）
  assert.deepEqual(missingPromptArgs(decl, { text: '正文' }), [], '必填填了就通过，选填不填不算缺')
  assert.deepEqual(missingPromptArgs(decl, { text: ' 正文 ' }), [], '前后空白不该把内容误判成缺失')
  assert.deepEqual(missingPromptArgs(decl, { text: 'x', stale: 'y' }), [], '声明之外的键不影响判定')
  // 无必填的模板：直接可渲染
  assert.deepEqual(missingPromptArgs({ arguments: [] }, {}), [])
  assert.deepEqual(missingPromptArgs(undefined, {}), [])
  // 与 promptArgsOf 必须给出同一份结论（两条判据若有分歧，"按钮可点但提示说缺参数"就会同时出现）
  const valueCases: Array<Record<string, string>> = [{}, { text: '' }, { text: '  ' }, { text: '正文' }, { tone: 'x' }]
  for (const values of valueCases) {
    assert.deepEqual(missingPromptArgs(decl, values), promptArgsOf(decl.arguments, values).missing,
      `两种判据必须一致：${JSON.stringify(values)}`)
  }
})
