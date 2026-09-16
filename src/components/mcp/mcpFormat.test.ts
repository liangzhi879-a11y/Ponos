// src/components/settings/mcpFormat.test.ts
// MCP 面板状态归并的测试。
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
