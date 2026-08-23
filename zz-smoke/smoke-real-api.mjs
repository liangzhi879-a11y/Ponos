// Ponos-turbo 真实 API 冒烟（非破坏性）：Anthropic 协议 env 接线 / chunk 形状 / usage 累计 / 工具 schema 注入
// 用法：
//   node zz-smoke/smoke-real-api.mjs   # 用 ANTHROPIC_* env（OpenAI 兼容协议已删除）
// 前置：ANTHROPIC_* env 已配置且未设 PONOS_MOCK_API。脚本只打印 base/model，不打印密钥。
import { streamMessages, detectProtocol } from '../kernel/api.mjs'
import { createEngine } from '../kernel/engine.mjs'

if (process.env.PONOS_MOCK_API === '1') {
  console.error('错误: PONOS_MOCK_API=1 会走 mock，先清除再跑真实 API')
  process.exit(2)
}

const MODEL = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash'
const BASE = process.env.ANTHROPIC_BASE_URL
if (!BASE) {
  console.error('错误: 需要 ANTHROPIC_BASE_URL env')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (p, ms, tag) => Promise.race([
  p,
  sleep(ms).then(() => { throw new Error(`${tag} 超时 ${ms}ms`) }),
])

function summarize(text) {
  const t = String(text ?? '').trim()
  return t.length > 80 ? t.slice(0, 80) + `…(+${t.length - 80}字符)` : t
}

const TOOLS = [{ name: 'Bash', description: '执行 shell 命令', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }]

// 层1 协议层：直接 streamMessages，验证协议选择 / chunk 形状 / 恰一个终态 usage
async function smokeProtocol() {
  console.log(`\n═══ 层1 协议层 smokeProtocol [anthropic] model=${MODEL} base=${BASE} ═══`)
  const detected = detectProtocol()
  console.log(`detectProtocol() → ${detected}（期望 anthropic）`)
  const chunks = []
  const t0 = Date.now()
  for await (const c of streamMessages({
    model: MODEL,
    messages: [{ role: 'user', content: '请只回复：SMOKE_OK' }],
    maxTokens: 256,
    tools: TOOLS,
  })) chunks.push(c)
  const dur = Date.now() - t0
  const texts = chunks.filter((c) => c.type === 'text').map((c) => c.text)
  const usages = chunks.filter((c) => c.type === 'usage')
  const thinks = chunks.filter((c) => c.type === 'thinking')
  const toolUses = chunks.filter((c) => c.type === 'tool_use')
  console.log(`耗时 ${dur}ms | chunk 分布: text=${texts.length} thinking=${thinks.length} tool_use=${toolUses.length} usage=${usages.length}`)
  console.log(`text 累计: ${summarize(texts.join(''))}`)
  console.log(`usage: ${JSON.stringify(usages.map((u) => u.usage))}`)
  const ok = []
  ok.push(texts.join('').trim() ? '✅ text 非空' : '❌ text 为空')
  ok.push(usages.length === 1 ? `✅ 恰一个终态 usage（usagePushed 兜底正常）` : `❌ usage chunk 数=${usages.length}（应=1）`)
  ok.push(usages.length === 1 && (usages[0].usage.input_tokens ?? 0) > 0 ? '✅ usage.input_tokens 有计数' : '❌ usage.input_tokens 无计数')
  if (thinks.length) console.log(`（含 thinking 块 ×${thinks.length}）`)
  console.log(ok.join('\n'))
  return { dur, text: texts.join(''), usage: usages[0]?.usage, chunks: chunks.length }
}

// 层2 引擎层：完整 runTurn，验证工具 schema 注入不破坏请求 + usage 累计 + turnStats + wire.result
async function smokeEngine() {
  console.log(`\n═══ 层2 引擎层 smokeEngine [anthropic]（完整 runTurn）═══`)
  const wireEvents = []
  const wire = {
    assistant(blocks) { wireEvents.push({ type: 'assistant', blocks }) },
    controlRequest(req) { wireEvents.push({ type: 'controlRequest', req }) },
    result(usage, meta) { wireEvents.push({ type: 'result', usage, meta }) },
  }
  const engine = createEngine({ opts: { model: MODEL }, wire })
  const t0 = Date.now()
  const result = await withTimeout(
    engine.runTurn({ content: '请调用 Bash 工具执行命令 echo SMOKE_OK（仅此一条命令）。执行后回复：DONE' }),
    90_000,
    'engine.runTurn',
  )
  const dur = Date.now() - t0
  console.log(`耗时 ${dur}ms | result: ${JSON.stringify({ usage: result.usage, model: result.model, text: summarize(result.text) })}`)
  const toolUses = wireEvents.filter((e) => e.type === 'assistant' && e.blocks.some((b) => b.type === 'tool_use'))
  const resultEv = wireEvents.find((e) => e.type === 'result')
  console.log(`wire 事件: assistant=${wireEvents.filter((e) => e.type === 'assistant').length} controlRequest=${wireEvents.filter((e) => e.type === 'controlRequest').length} result=${resultEv ? 1 : 0}`)
  console.log(`工具调用块: ${toolUses.length ? toolUses.map((e) => e.blocks.find((b) => b.type === 'tool_use').name).join(',') : 0}`)
  console.log(`turnStats[0]: ${JSON.stringify(engine.getTurnStats()[0] ?? null)}`)
  const ok = []
  ok.push((result.usage.input_tokens ?? 0) > 0 || (result.usage.output_tokens ?? 0) > 0 ? '✅ result.usage 有计数' : '❌ result.usage 全零')
  ok.push(result.text.trim() ? '✅ 有最终文本' : '❌ 最终文本为空')
  ok.push(engine.getTurnStats().length === 1 ? '✅ turnStats 产出 1 条' : `❌ turnStats 条数=${engine.getTurnStats().length}`)
  ok.push(resultEv ? '✅ wire.result 事件发出（含 duration_ms）' : '❌ wire.result 未发出')
  console.log(ok.join('\n'))
  return { dur, result, toolUses: toolUses.length }
}

try {
  const p = await smokeProtocol()
  console.log(`\n层1 PASS: 协议层真实调用成功（${p.dur}ms，${p.chunks} chunks）`)
  const e = await smokeEngine()
  console.log(`层2 PASS: 引擎层 runTurn 成功（${e.dur}ms）`)
  console.log(`\n=== smoke [anthropic] 完成 ===`)
} catch (err) {
  console.error(`\n✗ smoke [anthropic] 失败: ${err.message}`)
  process.exitCode = 1
}
