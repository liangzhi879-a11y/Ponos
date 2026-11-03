// kernel-tests/knowledge-inject-record.test.mjs —— S1.3 仪表接线（plan Task 2）
// ---------------------------------------------------------------------------
// 病灶（本次调研实测）：`recordChannel` / `recordSource` 两个仪表**零业务调用** ——
// `git grep -n -E "recordChannel|recordSource"` 只命中定义处与文档；同文件 `record()`
// 还绕过它们直写 acc ⇒ `channels.{static,bridge,guard,payload}` 与
// `bySource.{systemPrompt,toolSchema,skill,protocol,payload}` **恒为 0**。
//
// 本文件钉住四件事：
//   ① 两个仪表自身的白名单/非负语义（函数本就存在，接线前即应绿）；
//   ② ★ 接线生效：`composeSystemPrompt` 一次 ⇒ 仪表非零，且**数值与实渲染的段落字节相符**
//      （接线前必红 —— 这是"零调用"的直接证据）；
//   ③ Step 4b 技能清单天花板：保留全部 id、triggers→description→仅列 id 三档降级、
//      **缺省不设限**（存量逐行不变）；
//   ④ 收尾轮：天花板的**设置接线**（settings.skill.catalogBudgetBytes → 真内核进程 → 实际请求体）
//      与 `record()` 的**字节口径**（修前在量"数字字符串的长度"）。
//
// ★ 断言口径：计量值的期望一律**从被渲染出来的提示词文本独立重算**（或来自字面量契约），
//   不拿 `getPromptSegmentMeters()` 自己的输出当期望值——否则"仪表错、测试跟着错"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  recordChannel, recordSource, getInjectStats, resetInjectStats, buildKnowledgeInjection,
} from '../kernel/knowledge-inject.mjs'
import { composeSystemPrompt, getPromptSegmentMeters, resolveSkillCatalogBudget } from '../kernel/prompt.mjs'
import { discoverSkills } from '../kernel/skills.mjs'
import { sanitizeSegment } from '../kernel/session.mjs'

// ── 断言工具：从实渲染文本里定位段落（找不到就红，绝不静默跳过）─────────────
const bytes = (s) => Buffer.byteLength(s, 'utf8')

/** 提示词按 `composeSystemPrompt` 的 join 分隔符切成段 */
function chunksOf(out) {
  return out.split('\n\n')
}

/** 取以某前缀开头的段（唯一）；找不到 ⇒ 红 */
function chunkStartingWith(out, prefix) {
  const hit = chunksOf(out).filter((c) => c.startsWith(prefix))
  assert.equal(hit.length, 1, `实渲染提示词里应恰有一个以「${prefix}」开头的段（实际 ${hit.length} 个）`)
  return hit[0]
}

/** 计量口径 = 段字节 + 2（join 的 '\n\n'），与 prompt.mjs 计量循环同式 */
function segBytesOf(out, prefixes) {
  const hit = chunksOf(out).filter((c) => prefixes.some((p) => c.startsWith(p)))
  assert.ok(hit.length > 0, `未能在实渲染提示词里定位段落 ${prefixes.join('/')}`)
  return hit.reduce((a, c) => a + bytes(c) + 2, 0)
}

const SKILL_SEG_PREFIXES = ['【技能与编排】', '【可用技能】', '【可用工作流】', '【可用子 Agent】']

/** 技能清单夹具：n 个平级技能（description/triggers 长度决定各档字节） */
function fixtures(n, { description, trigger }) {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, description, triggers: [trigger], parent: null }))
}

// ── ① 仪表自身的白名单与非负语义 ────────────────────────────────────────────

test('仪表：recordChannel 只累加白名单渠道，非法名抛错（不静默）', () => {
  resetInjectStats()
  recordChannel('static', { calls: 1, hits: 0, injectedBytes: 120 })
  recordChannel('static', { calls: 1, hits: 1, injectedBytes: 80 })
  const c = getInjectStats().channels.static
  assert.equal(c.calls, 2)
  assert.equal(c.hits, 1)
  assert.equal(c.injectedBytes, 200)
  assert.throws(() => recordChannel('nope', { calls: 1 }), /未知注入渠道/)
})

test('仪表：recordSource 只累加白名单来源，负值/非数字按 0（不污染账）', () => {
  resetInjectStats()
  recordSource('skill', 300)
  recordSource('skill', -5)      // 负值 ⇒ 0
  recordSource('skill', Number.NaN)
  assert.equal(getInjectStats().bySource.skill, 300)
  assert.throws(() => recordSource('nope', 1), /未知注入来源/)
})

// ── ①b 消除同文件内的"直写绕过"（Step 3）────────────────────────────────────

test('消除直写绕过：统一注入改走仪表记账，且三数同口径（来源之和 = 渠道字节）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kir-'))
  try {
    const personal = join(dir, 'memory', 'personal')
    mkdirSync(personal, { recursive: true })
    writeFileSync(join(personal, 'workflow.md'), [
      '---', 'name: workflow', 'description: 工作流', '---',
      '## 沟通渠道',
      '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
      '- [会话|申报材料] 四表联动交叉校验 -- RD/PS/IP/TOAI 四表的产品名称与收入口径必须对齐',
    ].join('\n') + '\n', 'utf-8')
    resetInjectStats()
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: personal, query: '四表联动 产品名称', keywords: ['四表联动'], mode: 'unified',
    })
    assert.ok(r.recallSection.length > 0, '夹具应产出抽调层（否则来源项为 0 的分支测不到）')
    const s = getInjectStats()
    assert.equal(s.calls, 1)
    // 走仪表（而不是直写 acc）：接线前这里恒 0，只有 record() 改走 recordChannel 才有值
    assert.equal(s.channels.derived.calls, 1, 'derived 渠道应记一次')
    assert.equal(s.channels.derived.hits, 1, '本次确有注入内容 ⇒ 命中记 1')
    // ★ 字节口径（Task 2 收尾轮修正）：期望值来自**本次实渲染产物**的字节数（独立算），
    //   不是"实现此刻恰好输出的那个数"。修正前 record() 里多套了一层 byteLen()，
    //   在量"数字字符串的长度"⇒ 157 B / 373 B 被记成 3 / 3（详见本文件顶部说明）。
    assert.equal(s.bySource.experience, bytes(r.indexSection), '经验来源字节 = 索引层实渲染字节')
    assert.equal(s.bySource.knowledge, bytes(r.recallSection), '知识来源字节 = 抽调层实渲染字节')
    assert.equal(s.channels.derived.injectedBytes, bytes(r.indexSection) + bytes(r.recallSection),
      'derived 渠道字节 = 两层实渲染字节之和')
    assert.equal(s.bySource.experience + s.bySource.knowledge, s.channels.derived.injectedBytes)
    assert.ok(s.bySource.experience > 0 && s.bySource.knowledge > 0, '索引层与抽调层都非空 ⇒ 两项来源都应 > 0')
    // 这条路径不得污染别的渠道（bridge/guard/payload 各有自己的注入点）
    assert.equal(s.channels.bridge.calls + s.channels.guard.calls + s.channels.payload.calls, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('★ 字节口径回归：空注入 ⇒ 全 0（不得把"0 字节"记成别的数）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kir-empty-'))
  try {
    resetInjectStats()
    // 空经验目录 ⇒ 索引层与抽调层都是空串 ⇒ 三个数必须都是 0。
    // 这条钉的是"归零口径"本身（有限正数取整、其余一律 0）：任何把 0/NaN/负值 记成非 0 的
    // 归一化（含"把 0 当成 1 个数字字符"这类假值）都会让它红。
    const r = buildKnowledgeInjection({
      configDir: dir, memoryRootDir: join(dir, 'memory', 'personal'), query: '随便', keywords: ['随便'], mode: 'unified',
    })
    assert.equal(r.indexSection, '')
    assert.equal(r.recallSection, '')
    const s = getInjectStats()
    assert.equal(s.bySource.experience, 0)
    assert.equal(s.bySource.knowledge, 0)
    assert.equal(s.channels.derived.injectedBytes, 0)
    assert.equal(s.channels.derived.hits, 0, '没有注入任何字节 ⇒ 不得记命中')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── ② ★ 接线生效（接线前必红）──────────────────────────────────────────────
test('★ 回归：提示词分段计量后，两个仪表必须非零（接线生效的证据）', () => {
  resetInjectStats()
  composeSystemPrompt({
    cwd: process.cwd(),
    skills: [{ id: 'demo', description: '演示技能', triggers: ['演示'], parent: null }],
    workflows: [],
  })
  const m = getPromptSegmentMeters()
  const s = getInjectStats()
  assert.ok(m.systemPromptBytes > 0 || m.skillBytes > 0, '分段计量本身应有值')
  const touched = ['static', 'bridge', 'guard', 'payload'].filter((k) => s.channels[k].calls > 0)
  assert.ok(touched.length > 0, `接线后至少应有一个渠道 calls > 0；实际 ${JSON.stringify(s.channels)}`)
  assert.ok(s.bySource.systemPrompt > 0 || s.bySource.skill > 0, `bySource 应被填写；实际 ${JSON.stringify(s.bySource)}`)
})

test('★ 计量与实渲染一致：static 渠道字节 = 提示词字节 + 2，来源三分之和 = 该渠道字节', () => {
  resetInjectStats()
  const out = composeSystemPrompt({
    cwd: process.cwd(), toolNames: ['Read', 'Bash'],
    skills: [{ id: 'demo', description: '演示技能', triggers: ['演示'], parent: null }], workflows: [],
  })
  const s = getInjectStats()
  // 计量循环对每个段记 byteLength(p)+2，段间恰有 (段数-1) 个 '\n\n' ⇒ Σ(段+2) = 全文 + 2。
  // ★ 这里只用**渲染出来的字符串**独立重算，不读计量器自身的中间量。
  assert.equal(s.channels.static.injectedBytes, bytes(out) + 2, 'static 渠道字节应等于实渲染提示词 + 2')
  // 段数：base + 【技能与编排】 + 【可用技能】 + 可用工具 ≥ 4（字面下界，非实现推导）
  assert.ok(s.channels.static.calls >= 4, `段数应 ≥ 4；实际 ${s.channels.static.calls}`)
  assert.equal(s.channels.static.hits, s.channels.static.calls, '每段都非空 ⇒ 命中数应等于段数')
  assert.equal(s.bySource.toolSchema, bytes('可用工具：Read, Bash。') + 2, '工具 schema 段的来源归因')
  assert.equal(s.bySource.skill, segBytesOf(out, SKILL_SEG_PREFIXES), '技能段来源归因应与实渲染的四个技能段相符')
  assert.equal(
    s.bySource.systemPrompt + s.bySource.skill + s.bySource.toolSchema, s.channels.static.injectedBytes,
    '每个段恰好归入一个来源 ⇒ 三者之和应等于 static 渠道字节',
  )
})

// ── ③ Step 4b：技能清单天花板 ──────────────────────────────────────────────

test('skillCatalogBytes 只算【可用技能】段（与 skillBytes 的四段口径分离）', () => {
  const out = composeSystemPrompt({
    cwd: process.cwd(), toolNames: [],
    skills: [{ id: 'demo', description: '演示技能', triggers: ['演示'], parent: null }],
    workflows: [{ id: 'wf-demo', description: '演示工作流', triggers: ['流程'], parent: null }],
  })
  const m = getPromptSegmentMeters()
  assert.equal(m.skillCatalogBytes, bytes(chunkStartingWith(out, '【可用技能】')) + 2, '目录段口径 = 仅【可用技能】')
  assert.ok(m.skillBytes > m.skillCatalogBytes, 'skillBytes 仍含工作流等段 ⇒ 必须严格大于目录段（不得被改口径）')
})

test('天花板·描述档：触发词长于描述时超预算 ⇒ 降级为描述，且一个 id 都不能丢', () => {
  const many = fixtures(60, { description: 'x'.repeat(40), trigger: 't'.repeat(80) })
  const out = composeSystemPrompt({ cwd: process.cwd(), skills: many, workflows: [], skillCatalogBudgetBytes: 4000 })
  const block = chunkStartingWith(out, '【可用技能】')
  const lines = block.split('\n')
  for (const s of many) {
    assert.ok(lines.includes(`- ${s.id}：${'x'.repeat(40)}`), `应降级为 description 且保留 ${s.id}`)
  }
  assert.ok(!block.includes('t'.repeat(80)), '触发词应被降级掉（改前是 `- id：tttt…`）')
  assert.ok(!block.includes('等 '), '描述档还没到"仅列 id"档，不应出现省略提示')
  assert.ok(bytes(block) + 2 <= 4000, `天花板应生效：实际 ${bytes(block) + 2} > 4000`)
  assert.equal(getPromptSegmentMeters().skillCatalogBytes, bytes(block) + 2, '计量应等于实际装入的目录段字节')
})

test('天花板·仅列 id 档：预算极小 ⇒ 保留全部 id + “等 N 个”降级提示（不得丢技能）', () => {
  const many = fixtures(60, { description: 'x'.repeat(40), trigger: 't'.repeat(20) })
  const out = composeSystemPrompt({ cwd: process.cwd(), skills: many, workflows: [], skillCatalogBudgetBytes: 1500 })
  const block = chunkStartingWith(out, '【可用技能】')
  const lines = block.split('\n')
  for (const s of many) {
    assert.ok(lines.includes(`- ${s.id}`), `一个技能都不能丢：${s.id}`)
  }
  assert.ok(block.includes('等 60 个'), '应有降级提示（…等 N 个）')
  assert.ok(!block.includes('t'.repeat(20)), '触发词与说明应被省略')
  assert.ok(bytes(block) + 2 <= 1500, `天花板应生效：实际 ${bytes(block) + 2} > 1500`)
})

test('缺省不设限（存量零变化）：未给预算时逐行等同改动前，不得截断', () => {
  const many = fixtures(60, { description: 'x'.repeat(40), trigger: 't'.repeat(20) })
  const out = composeSystemPrompt({ cwd: process.cwd(), skills: many, workflows: [] })
  const block = chunkStartingWith(out, '【可用技能】')
  const lines = block.split('\n')
  for (const s of many) {
    assert.ok(lines.includes(`- ${s.id}：${'t'.repeat(20)}`), `未给预算 ⇒ 必须保持改动前的触发词行：${s.id}`)
  }
  assert.ok(!block.includes('等 '), '未给预算时不得截断/降级')
  assert.ok(!lines.some((l) => l === `- s0`), '不得退化成"仅列 id"档')
})

// ── ④ 收尾轮：天花板的**设置接线**（settings → cli.mjs → 实际请求体）──────────
// 上一轮只加了 composeSystemPrompt 的**可选**参数、零调用方 ⇒ 天花板默认永不生效。
// 这一节钉两层：① 设置值解析的纯函数语义；② 从 settings.json 一路走到真内核请求体的整条链。

const CLI_PATH = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const CLI_SRC = readFileSync(CLI_PATH, 'utf-8')

test('天花板设置解析：缺省/非法一律 null（不设限），且与"不传参数"逐字节等价', () => {
  // ★ 期望值不是"实现输出的数"：null 的语义由 composeSystemPrompt 的**未传参**行为独立给出
  for (const bad of [undefined, null, 0, -0, -1, 'abc', Number.NaN, Infinity, {}, []]) {
    assert.equal(resolveSkillCatalogBudget({ settings: { skill: { catalogBudgetBytes: bad } } }), null,
      `非法值 ${String(bad)} ⇒ 必须 null（不设限），不得退化成某个"默认预算"（那等于替用户改提示词）`)
  }
  assert.equal(resolveSkillCatalogBudget({ settings: {} }), null, '未配置 ⇒ 不设限')
  assert.equal(resolveSkillCatalogBudget(), null, '不传 settings ⇒ 不设限')
  assert.equal(resolveSkillCatalogBudget({ settings: { skill: { catalogBudgetBytes: 1500.9 } } }), 1500, '正数取整（与 publicLimit 同口径）')
  assert.equal(resolveSkillCatalogBudget({ settings: { skill: { catalogBudgetBytes: '1500' } } }), 1500, '数字字符串按数字处理')
  // ★ 存量零变化：resolver 在"未配置"下吐出的 null 喂进渲染，必须与**根本不传**该参数逐字节相同
  const many = fixtures(60, { description: 'x'.repeat(40), trigger: 't'.repeat(20) })
  const base = { cwd: process.cwd(), skills: many, workflows: [] }
  const fromSettings = composeSystemPrompt({
    ...base, skillCatalogBudgetBytes: resolveSkillCatalogBudget({ settings: {} }),
  })
  assert.equal(fromSettings, composeSystemPrompt({ ...base }), '未配置时经 resolver 传参必须与不传参数逐字节一致')
})

test('设置值真的能驱动天花板：resolveSkillCatalogBudget({settings}) → composeSystemPrompt ⇒ 降级', () => {
  const many = fixtures(60, { description: 'x'.repeat(40), trigger: 't'.repeat(20) })
  assert.equal(resolveSkillCatalogBudget({ settings: { skill: { catalogBudgetBytes: 1500 } } }), 1500)
  const out = composeSystemPrompt({
    cwd: process.cwd(), skills: many, workflows: [],
    skillCatalogBudgetBytes: resolveSkillCatalogBudget({ settings: { skill: { catalogBudgetBytes: 1500 } } }),
  })
  const block = chunkStartingWith(out, '【可用技能】')
  for (const s of many) assert.ok(block.includes(`- ${s.id}`), `不得丢技能：${s.id}`)
  assert.ok(block.includes('等 60 个'), '设置值经 resolver 后应真的生效（降级为仅列 id 档）')
  assert.ok(bytes(block) + 2 <= 1500, `天花板应生效：实际 ${bytes(block) + 2} > 1500`)
})

test('★ 源码面守卫：cli.mjs 必须把设置值传进 composeSystemPrompt（防"建了没接"复发）', () => {
  assert.match(CLI_SRC, /import\s*\{[^}]*\bresolveSkillCatalogBudget\b[^}]*\}\s*from\s*'\.\/prompt\.mjs'/,
    'cli.mjs 应从 prompt.mjs 引入 resolveSkillCatalogBudget（设置值解析的唯一入口）')
  const m = /skillCatalogBudgetBytes:\s*([^,\n]+)/.exec(CLI_SRC)
  assert.ok(m, 'cli.mjs 必须把 skillCatalogBudgetBytes 传给 composeSystemPrompt —— 否则天花板默认永不生效（"机制存在 ≠ 机制生效"）')
  const expr = m[1].trim()
  assert.ok(!/^[\d'"]/.test(expr), `不得传字面量（${expr}）：那等于替所有存量用户改提示词默认形态`)
  // expr 是标识符（不含正则元字符），直接拼即可（无需转义）
  const decl = new RegExp('const\\s+' + expr + '\\s*=\\s*resolveSkillCatalogBudget\\(').exec(CLI_SRC)
  assert.ok(decl, `传进去的 ${expr} 必须是 resolveSkillCatalogBudget(...) 的返回值（不得是别处硬编码）`)
})

// 进程级：真内核 + 真 settings.json + mock 系统提示探针 ⇒ 证明设置一路走到**实际请求体**。
// 探针口径（kernel/api.mjs 的 PONOS_MOCK_SYS_PROBE）：请求的 system 条目含 needle 则回 bit 1。
// 两根针：①「因技能清单字节预算受限」——只有降级到 ids 档才出现的字面量（真源在 renderSkillCatalog）；
//        ② 触发词字面量（降级后应当消失）。
// ⇒ 配了预算 = '10'、未配 = '01'。这把"设置 → 提示词 → 请求体"整条链钉住（纯函数测试只能钉前两段）。
const WIRE_HINT = '因技能清单字节预算受限'
const WIRE_TRIG = 'zzztriggerzzz'

function spawnKernelProbe({ settings, skills = 40 }) {
  const root = mkdtempSync(join(tmpdir(), 'ponos-catbudget-'))
  const home = join(root, 'home')
  const proj = join(root, 'proj')
  mkdirSync(join(home, 'skills'), { recursive: true })
  mkdirSync(proj, { recursive: true })
  for (let i = 0; i < skills; i++) {
    const d = join(home, 'skills', `s${i}`)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), [
      '---', `name: s${i}`, `description: ${'x'.repeat(40)}`, `triggers: ${WIRE_TRIG}${i}`, '---', `# s${i}`, '正文',
    ].join('\n') + '\n', 'utf-8')
  }
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings), 'utf-8')
  const proc = spawn(process.execPath, [
    CLI_PATH, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', proj,
  ], {
    cwd: proj,
    env: {
      ...process.env,
      PONOS_MOCK_API: '1',
      PONOS_CONFIG_DIR: home,
      PONOS_HOME: home,
      PONOS_MOCK_SYS_PROBE: `${WIRE_HINT}|${WIRE_TRIG}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  proc.stdout.on('data', (d) => { out += d })
  proc.stderr.on('data', (d) => { err += d })
  proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '你好' } }) + '\n')
  return { proc, root, home, proj, get out() { return out }, get err() { return err } }
}

/** 等探针回值；mock 的文本会被切成多个 assistant 块 ⇒ 必须按块拼接后再找（否则永远等不到完整串） */
async function probeBits(k, timeoutMs = 60_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const text = k.out.split('\n').filter((l) => l.trim()).flatMap((l) => {
      try {
        const e = JSON.parse(l)
        return e.type === 'assistant' ? (e.message?.content || []).map((c) => c?.text || '') : []
      } catch { return [] }
    }).join('')
    const m = /SYS_PROBE:(\d+)/.exec(text)
    if (m) return m[1]
    if (k.proc.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

// ── 真转录读取（终审修复轮：台账落盘值 vs 同轮实渲染）───────────────────────────
/** 从流式 stdout 里取 system(init) 的 session_id（转录文件名要用它） */
function initSessionId(out) {
  for (const l of out.split('\n')) {
    if (!l.trim()) continue
    try {
      const e = JSON.parse(l)
      if (e.type === 'system' && e.subtype === 'init' && e.session_id) return e.session_id
    } catch { /* 非 JSON 行（日志/警告） */ }
  }
  return null
}

/** 轮末 inject_snapshot（读**真转录**：<home>/projects/<cwd>/<sid>.jsonl）；还没落盘 ⇒ null */
function snapshotOf(k) {
  const sid = initSessionId(k.out)
  if (!sid) return null
  const file = join(k.home, 'projects', sanitizeSegment(k.proj), `${sid}.jsonl`)
  if (!existsSync(file)) return null
  const entries = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return entries.find((e) => e.kind === 'inject_snapshot') || null
}

/** 轮询到某个条件成立（落盘/stderr 都是异步的 ⇒ 不能"读到就断言"，否则会假红） */
async function waitUntil(fn, timeoutMs = 60_000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 >= timeoutMs) return fn()
    await new Promise((r) => setTimeout(r, 100))
  }
}

test('★ 进程级：settings.skill.catalogBudgetBytes 一路生效到实际请求体；未配置/非法值则完全不截断',
  { timeout: 180_000 }, async () => {
    const cases = [
      { name: '配了 600 B ⇒ 降级为仅列 id（含"预算受限"提示、触发词消失）', settings: { skill: { catalogBudgetBytes: 600 } }, expect: '10' },
      { name: '未配置 ⇒ 不设限（触发词在、无降级提示）', settings: {}, expect: '01', expectNoOverWarn: true },
      { name: '配了 0（非法）⇒ 不设限，但必须出声（不得静默无效）', settings: { skill: { catalogBudgetBytes: 0 } }, expect: '01' },
    ]
    const results = []
    for (const c of cases) {
      const k = spawnKernelProbe({ settings: c.settings })
      try {
        const bits = await probeBits(k)
        results.push(`${c.name} → SYS_PROBE:${bits}`)
        assert.equal(bits, c.expect, `${c.name}（stderr 尾部：${k.err.slice(-400)}）`)
        if (c.settings.skill?.catalogBudgetBytes === 0) {
          assert.match(k.err, /catalogBudgetBytes=0 不是正数/, '配了非法值必须 warn（否则用户以为已开启天花板）')
        }
        if (c.expectNoOverWarn) {
          // 缺省不设限 ⇒ 没有"超限"这回事 ⇒ 越限告警必须不出现（否则是噪声，会把真问题淹没）
          assert.doesNotMatch(k.err, /技能清单超预算/, '未配置预算时不得出现越限告警（缺省不设限）')
        }
      } finally {
        try { k.proc.kill() } catch { /* 已退出 */ }
        // Windows：刚 kill 的进程仍可能持有临时目录句柄（失败不影响结论）
        try { rmSync(k.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }) } catch { /* 残留可接受 */ }
      }
    }
    // 每个场景都在循环内断言（bits 为 null 亦红）⇒ 走到这里 = 三个场景都跑过且脉冲值符合真值
  })

// ── ⑤ 终审修复轮：技能清单字节数**进台账** + 越限出声（spec §5 S1.4 验收项）────────────
// 病灶：`skillCatalogBytes` 在 prompt.mjs 定义之后**全仓零消费方**（注释却写"超限由调用方从
//   skillCatalogBytes 观测"），而 spec §5 S1.4 的验收明确列有「技能清单字节数进台账」——
//   台账 `inject_snapshot` 的 segments 当时是固定 4 段，这个数字进不去 ⇒ 验收项未达成。
// 本节钉两层：
//   ① 源码面守卫：cli.mjs 轮末确实把这个数字送进 summarizeInjection，且有"越限告警"的出口；
//   ② ★ 进程级：真内核 + 真 settings + 真转录 ⇒ 台账里的数字 == **同轮实渲染**的目录段字节（独立算）。
test('★ 源码面守卫：cli.mjs 必须把 skillCatalogBytes 送进台账，且越限有 warn 出口（防"计量了没人读"复发）', () => {
  assert.match(CLI_SRC, /skillCatalogBytes:\s*[^,\n]+/, 'cli.mjs 必须把 skillCatalogBytes 传给 summarizeInjection（spec §5 S1.4）')
  const m = /skillCatalogBytes:\s*([^,\n]+)/.exec(CLI_SRC)
  const expr = m[1].trim()
  assert.ok(!/^[\d'"]/.test(expr), `不得传字面量（${expr}）：那等于造一个恒定的假账`)
  const decl = new RegExp('const\\s+' + expr + '\\s*=\\s*Number\\([A-Za-z_]\\w*\\??\\.skillCatalogBytes').exec(CLI_SRC)
  assert.ok(decl, '送进台账的 ' + expr + ' 必须取自 getPromptSegmentMeters 的 skillCatalogBytes 读数（不得是别处算的另一个数）')
  // 越限出口：判据必须与"生效预算"比较，且**仅在预算存在时**（缺省不设限 ⇒ 不得告警）
  assert.match(CLI_SRC, /if\s*\(\s*skillCatalogBudget\s*!==\s*null\s*&&[^)]*>\s*skillCatalogBudget/,
    '越限告警必须与**生效预算**比较，并显式排除 null（缺省不设限 ⇒ 没有"超限"这回事）')
  assert.match(CLI_SRC, /log\.warn\(`技能清单超预算/,
    '越限必须 log.warn 出声（预算设了 200、实际装了 700 也不得静默）')
})

test('★ 进程级：台账里的 skillCatalogBytes == 同一轮实渲染的目录段字节（独立算）；越限有 warn',
  { timeout: 180_000 }, async () => {
    const BUDGET = 250   // 40 个夹具技能下，ids 终档仍 > 250 ⇒ 正好造出"静默超限"这条路径
    const k = spawnKernelProbe({ settings: { skill: { catalogBudgetBytes: BUDGET } }, skills: 40 })
    try {
      // 前提：预算确实生效到了请求体（否则后面测的可能是"未降级"的形态）
      assert.equal(await probeBits(k), '10',
        `预算 ${BUDGET} ⇒ 应降级为仅列 id（stderr 尾部：${k.err.slice(-400)}）`)
      const snap = await waitUntil(() => snapshotOf(k))
      assert.ok(snap, '轮末必须落一条 inject_snapshot（S1+/O4：每轮一条）')
      // ① ★ 独立重算：同夹具（从夹具技能根真发现）+ 同预算，在**测试进程内**渲染一次，
      //    再对渲染出来的【可用技能】段取 Buffer.byteLength —— 不读台账自身、不读计量器中间量。
      const skills = discoverSkills({ root: join(k.home, 'skills'), allowFlat: true })
      assert.equal(skills.length, 40, '夹具技能根应恰有 40 个技能（否则夹具与内核的渲染输入脱节）')
      const out = composeSystemPrompt({ cwd: k.proj, skills, workflows: [], skillCatalogBudgetBytes: BUDGET })
      const expected = bytes(chunkStartingWith(out, '【可用技能】')) + 2
      assert.ok(expected > BUDGET, `前提：本预算下 ids 终档仍超限（实测 ${expected} > ${BUDGET}）—— 否则越限那半测不到`)
      assert.equal(snap.skillCatalogBytes, expected,
        '台账里的技能清单字节数必须等于同轮实渲染的目录段字节（修前该字段根本不存在 ⇒ undefined ⇒ 必红）')
      // ② 分段口径不得被污染：目录段是 skill 段的**子集** ⇒ 不进 segments（进了 totalBytes 会重复计数）
      assert.equal(snap.segments.length, 4, `segments 仍须四段；实际 ${JSON.stringify(snap.segments.map((s) => s.id))}`)
      const skillSeg = snap.segments.find((s) => s.id === 'skill')
      assert.ok(snap.skillCatalogBytes <= skillSeg.bytes,
        `目录段是 skill 段的子集：${snap.skillCatalogBytes} 不得大于 ${skillSeg.bytes}`)
      // ③ 越限可见：必须出声（"宁超预算不丢技能"是刻意取舍，但不得静默）
      await waitUntil(() => /技能清单超预算/.test(k.err))
      assert.match(k.err, /技能清单超预算/, `越限必须 warn（原始 stderr 尾部：${k.err.slice(-600)}）`)
      assert.match(k.err, new RegExp(`生效预算 ${BUDGET}`), '告警要写出生效预算与实测字节，否则读的人无从处置')
    } finally {
      try { k.proc.kill() } catch { /* 已退出 */ }
      try { rmSync(k.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }) } catch { /* 残留可接受 */ }
    }
  })
