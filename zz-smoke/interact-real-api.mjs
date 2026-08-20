// YFW-turbo 内核人工交互测试（真实 API，ANTHROPIC_* env 必须已配置）
// ---------------------------------------------------------------------------
// 场景：S1 简单问答 / S2 工具调用（Bash echo）/ S3 多轮历史 / S4 取消 / S5 resume
// 用法：node zz-smoke/interact-real-api.mjs
// 契约：stdin 收 {"type":"user","message":{...}}；stdout 发 NDJSON 事件流。
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MODEL = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash'
const BASE = process.env.ANTHROPIC_BASE_URL
if (!BASE) { console.error('错误: 需要 ANTHROPIC_BASE_URL env'); process.exit(2) }
if (process.env.YFW_MOCK_API === '1') { console.error('错误: YFW_MOCK_API=1 会走 mock'); process.exit(2) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 启动一个内核进程，返回 { send, waitEvent, kill, sessionId }
function launch({ resume = null, dir } = {}) {
  const args = [
    join(ROOT, 'kernel/cli.mjs'),
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--model', MODEL,
    '--add-dir', dir,
  ]
  if (resume) args.push('--resume', resume)
  const child = spawn(process.execPath, args, {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  const waiters = []
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    const t = line.trim()
    if (!t) return
    let ev
    try { ev = JSON.parse(t) } catch { return }
    events.push(ev)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(ev)) { const w = waiters.splice(i, 1)[0]; w.resolve(ev) }
    }
  })
  child.stderr.on('data', (d) => process.stderr.write(`[kernel-stderr] ${d}`))
  return {
    send(obj) { child.stdin.write(JSON.stringify(obj) + '\n') },
    sendUser(content) { this.send({ type: 'user', message: { role: 'user', content } }) },
    sendCancel() { this.send({ type: 'control_request', request: { subtype: 'cancel' } }) },
    waitEvent(pred, ms = 30000, tag = 'event') {
      const hit = events.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, timer: setTimeout(() => { reject(new Error(`${tag} 超时`)) }, ms) }
        waiters.push(w)
      })
    },
    events() { return events },
    close() { try { child.stdin.end() } catch {} },
    kill() { try { child.kill() } catch {} },
  }
}

function summarizeText(ev) {
  const blocks = ev?.message?.content ?? ev?.blocks
  if (Array.isArray(blocks)) return blocks.map((b) => b?.text ?? b?.thinking ?? '').join('').trim()
  return String(blocks ?? '').trim()
}

// wire assistant 事件格式：{ type:'assistant', message:{ role, content: blocks } }
const hasToolUse = (e) => e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'tool_use')
const hasText = (e) => e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'text')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
}

const DIR = join(homedir(), '.yfworking', 'projects', 'interact-smoke')
mkdirSync(DIR, { recursive: true }) // --add-dir 必须存在，否则内核 spawn 子进程 cwd 无效 → ENOENT

console.log('═══ S1 简单问答 ═══')
{
  const cli = launch({ dir: DIR })
  const init = await cli.waitEvent((e) => e.type === 'system' && e.subtype === 'init', 15000, 'init')
  ok('system(init) 发出', !!init, `model=${init.model} tools=${(init.tools || []).join(',')} session=${init.session_id}`)
  cli.sendUser('你好，请只回复：交互测试OK')
  const text = await cli.waitEvent((e) => e.type === 'assistant' && summarizeText(e).includes('交互测试OK'), 30000, 'S1 回复')
  const result = await cli.waitEvent((e) => e.type === 'result', 5000, 'S1 result')
  ok('S1 模型回复正确', !!text, `「${summarizeText(text).slice(0, 60)}」`)
  ok('S1 result 携带 usage+duration', result?.usage && Number.isFinite(result.duration_ms), `usage=${JSON.stringify(result.usage)}`)
  const sid = init.session_id
  cli.close()
  await sleep(300)
  console.log(`  → session_id=${sid}`)

  console.log('═══ S2 工具调用（Bash echo）═══')
  {
    const cli2 = launch({ resume: sid, dir: DIR })
    await cli2.waitEvent((e) => e.type === 'system', 15000, 'init2')
    cli2.sendUser('请调用 Bash 工具执行 echo INTERACT_TOOL_OK，然后回复：工具完成')
    const tool = await cli2.waitEvent(hasToolUse, 30000, 'S2 tool_use')
    const toolUse = tool.message.content.find((b) => b.type === 'tool_use')
    ok('S2 模型发起工具调用', !!toolUse, `${toolUse.name}(${JSON.stringify(toolUse.input)})`)
    const final = await cli2.waitEvent((e) => e.type === 'assistant' && summarizeText(e).includes('工具完成'), 30000, 'S2 最终')
    ok('S2 工具结果回填后正常回复', !!final, `「${summarizeText(final).slice(0, 60)}」`)
    cli2.close()
    await sleep(300)
  }

  console.log('═══ S3 多轮历史（resume 延续）═══')
  {
    const cli3 = launch({ resume: sid, dir: DIR })
    await cli3.waitEvent((e) => e.type === 'system', 15000, 'init3')
    cli3.sendUser('上一轮我们做了什么？一句话回答。')
    const ans = await cli3.waitEvent(hasText, 30000, 'S3 回复')
    const text3 = summarizeText(ans)
    const historyOk = /工具|echo|Bash|INTERACT_TOOL_OK/i.test(text3)
    ok('S3 resume 后模型能引用前文历史', historyOk, `「${text3.slice(0, 60)}」`)
    const result3 = await cli3.waitEvent((e) => e.type === 'result', 5000, 'S3 result')
    ok('S3 cache_read 命中（前缀缓存复用）', (result3.usage?.cache_read_input_tokens ?? 0) > 0, `cache_read=${result3.usage?.cache_read_input_tokens}`)
    cli3.close()
    await sleep(300)
  }

  console.log('═══ S4 取消（control_request cancel）═══')
  {
    const cli4 = launch({ resume: sid, dir: DIR })
    await cli4.waitEvent((e) => e.type === 'system', 15000, 'init4')
    cli4.sendUser('请写一篇 500 字以上的文章，标题《内核取消测试》')
    await sleep(1200)
    cli4.sendCancel()
    const canceled = await cli4.waitEvent((e) => e.type === 'assistant' && String(summarizeText(e)).includes('已取消'), 15000, 'S4 取消')
    const result4 = await cli4.waitEvent((e) => e.type === 'result', 5000, 'S4 result')
    ok('S4 cancel 后收到「已取消。」', !!canceled)
    ok('S4 cancel 后 result 复位', !!result4)
    cli4.close()
    await sleep(300)
  }

  console.log('═══ S5 干净新会话（对比）═══')
  {
    const cli5 = launch({ dir: DIR })
    await cli5.waitEvent((e) => e.type === 'system', 15000, 'init5')
    cli5.sendUser('请只回复：新会话OK')
    const text5 = await cli5.waitEvent((e) => e.type === 'assistant' && summarizeText(e).includes('新会话OK'), 30000, 'S5 回复')
    ok('S5 新会话正常', !!text5, `「${summarizeText(text5).slice(0, 60)}」`)
    cli5.close()
  }

  console.log(`\n=== 人工交互测试完成：PASS=${pass} FAIL=${fail} ===`)
  process.exitCode = fail > 0 ? 1 : 0
}
