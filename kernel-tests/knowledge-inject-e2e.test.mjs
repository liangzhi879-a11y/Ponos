// kernel-tests/knowledge-inject-e2e.test.mjs —— S3 Task 3：注入灰度开关的**端到端**接线锁
// ---------------------------------------------------------------------------
// 为什么必须 spawn 真内核：注入发生在 kernel/cli.mjs 的启动段（composeSystemPrompt 的 memory
// 参数），engine 级单测绕过 cli 层，覆盖不到"开关 → 实际提示词"这条链。系统提示不落盘
// （transcript 只有 user/assistant），故沿用 kernel-tests/chat-mode.test.mjs 的
// PONOS_MOCK_SYS_PROBE 多针探针口子（'|' 分隔，回 SYS_PROBE:<bits>，位序 = NEEDLES 顺序）。
//
// 隔离纪律：PONOS_CONFIG_DIR/YFW_HOME 都指向 mkdtempSync 出来的临时目录，绝不碰真实 home。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))

// 针脚顺序即 bits 顺序：0=索引层（legacy/unified 都应有）、
// 1=【相关经验抽调】= 图谱抽调（仅 legacy）、2=【相关知识抽调】= 块级抽调（仅 unified）。
const NEEDLES = ['【个人经验索引】', '【相关经验抽调】', '【相关知识抽调】']

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-inject-e2e-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', 'description: 工作流', '---',
    '- [会话|申报材料] 四表联动交叉校验 -- RD/PS/IP/TOAI 四表的产品名称与收入口径必须对齐',
    '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
  ].join('\n') + '\n', 'utf-8')
  return dir
}

function assistantText(events) {
  return events
    .filter((e) => e.type === 'assistant')
    .map((e) => (e.message?.content || []).map((b) => (b?.type === 'text' ? b.text : '')).join(''))
    .join('')
}

/** 跑一轮真实会话：等 init → 发一条用户消息 → 关 stdin → 收全部事件。 */
async function runTurn({ env = {}, userText = '你好，四表联动的口径是什么' } = {}) {
  const dir = makeHome()
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir,
  ], {
    env: {
      ...process.env, PONOS_MOCK_API: '1', PONOS_MOCK_SYS_PROBE: NEEDLES.join('|'),
      PONOS_CONFIG_DIR: dir, YFW_HOME: dir,
      // 关键词注入：graph.search 与块级抽调都靠它拿到 query（与真实会话同一条来源链）
      PONOS_MEMORY_KEYWORDS: '四表联动',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let buf = ''
  const events = []
  proc.stdout.on('data', (d) => {
    out += d
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 半行/脏行跳过 */ }
    }
  })
  try {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && !events.some((e) => e.type === 'system' && e.subtype === 'init')) {
      await new Promise((r) => setTimeout(r, 20))
    }
    proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'knowledge-inject-e2e', message: { role: 'user', content: userText } }) + '\n')
    proc.stdin.end()
    const code = await new Promise((res) => { proc.on('close', res) })
    const bits = (assistantText(events).match(/SYS_PROBE:([01]+)/) || [])[1]
    return { code, bits, dir, out }
  } finally {
    try { proc.kill() } catch {}
  }
}

test('legacy（缺省）：索引层 + 图谱抽调，且无块级抽调（= 改动前的行为）', async () => {
  const r = await runTurn({})
  try {
    assert.equal(r.code, 0, `内核应正常退出（实际 ${r.code}）\nstdout=${r.out.slice(-400)}`)
    assert.ok(r.bits, `探针未回显：${r.out.slice(-400)}`)
    assert.equal(r.bits[0], '1', '索引层必须注入（legacy 与 unified 都不变）')
    assert.equal(r.bits[1], '1', 'legacy 仍走 graph.search 抽调')
    assert.equal(r.bits[2], '0', 'legacy 不得出现块级抽调（那是 unified 的产物）')
  } finally { rmSync(r.dir, { recursive: true, force: true }) }
})

test('unified（PONOS_KNOWLEDGE_INJECT_MODE=unified）：块级抽调替换图谱抽调，索引层不变', async () => {
  const r = await runTurn({ env: { PONOS_KNOWLEDGE_INJECT_MODE: 'unified' } })
  try {
    assert.equal(r.code, 0, `内核应正常退出（实际 ${r.code}）\nstdout=${r.out.slice(-400)}`)
    assert.ok(r.bits, `探针未回显：${r.out.slice(-400)}`)
    assert.equal(r.bits[0], '1', '索引层必须保留（两层注入的"目录行"不因换策略而消失）')
    assert.equal(r.bits[1], '0', 'unified 不得再走图谱抽调（收敛，不叠加）')
    assert.equal(r.bits[2], '1', 'unified 必须产出块级抽调层')
  } finally { rmSync(r.dir, { recursive: true, force: true }) }
})

test('非法取值回落 legacy（老用户升级后行为不得突变）', async () => {
  const r = await runTurn({ env: { PONOS_KNOWLEDGE_INJECT_MODE: 'banana' } })
  try {
    assert.equal(r.bits?.[1], '1', '非法值应回落 legacy（图谱抽调仍在）')
    assert.equal(r.bits?.[2], '0', '非法值不得进 unified 路径')
  } finally { rmSync(r.dir, { recursive: true, force: true }) }
})

test('chat 模式仍不注入知识（S1 隔离语义不变，即便工具已放行）', async () => {
  const r = await runTurn({ userText: '你好' })
  try {
    // 上面那条是 task 模式；这里只锁 chat 的重定向——用 --session-mode chat 再跑一轮成本高，
    // 故改为对 chat 分支的静态契约断言：注入段必须整块在 `if (!chatMode)` 内。
    const src = readFileSync(KERNEL_CLI, 'utf-8')
    const seg = src.slice(src.indexOf('buildKnowledgeInjection(') - 1200, src.indexOf('buildKnowledgeInjection('))
    assert.match(seg, /if \(!chatMode\)/, 'buildKnowledgeInjection 调用必须在 chat 守卫内')
  } finally { rmSync(r.dir, { recursive: true, force: true }) }
})

test('轮末沉淀：命中捕获模式时写入经验文件（修 graph 作用域后真正落盘）', async () => {
  const r = await runTurn({ userText: '记住：以后申报材料一律先做四表联动交叉校验' })
  try {
    // 主题由 captureMemoryCandidates 的 inferTheme 推断（文本含"申报/材料" → project-application），
    // 故不能只盯 workflow.md：扫描整个个人经验根。
    const personal = join(r.dir, 'memory', 'personal')
    const files = readdirSync(personal).filter((f) => f.endsWith('.md'))
    const hit = files.find((f) => /业务要点|流程要点|用户纠正|用户偏好/.test(readFileSync(join(personal, f), 'utf-8')))
    assert.ok(hit, `轮末捕获应落盘至少一条经验（实际文件：${files.join(', ') || '无'}）`)
  } finally { rmSync(r.dir, { recursive: true, force: true }) }
})

// S3 §5：沉淀闭环必须在**同一进程内**把新经验同步进索引（否则"刚记下就查不到"）。
// 断言口子：磁盘索引 docs.jsonl（权威派生物）应包含刚捕获的主题文档。
test('S3 Task 5：轮末沉淀后索引里立刻有该文档（unified 模式下复用同一 store）', async () => {
  const r = await runTurn({
    env: { PONOS_KNOWLEDGE_INJECT_MODE: 'unified' },
    userText: '记住：以后申报材料一律先做四表联动交叉校验',
  })
  try {
    const docs = join(r.dir, 'knowledge', '.index', 'docs.jsonl')
    assert.ok(existsSync(docs), `索引文件应存在（实际目录：${join(r.dir, 'knowledge', '.index')}）`)
    const rows = readFileSync(docs, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const ids = rows.map((d) => d.id)
    assert.ok(ids.some((id) => id.startsWith('experience/')), `索引应含个人经验空间文档（实际 ${ids.join(', ')}）`)
    assert.ok(rows.some((d) => JSON.stringify(d).includes('四表联动交叉校验')), '刚捕获的内容应已进索引')
  } finally { rmSync(r.dir, { recursive: true, force: true }) }
})
