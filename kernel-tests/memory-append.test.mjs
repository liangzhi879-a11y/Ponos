// S6：`--knowledge append`（append-only 写入通道）与 `--knowledge tags`（标签枚举）回归。
//
// 为什么需要这条通道（spec `2026-09-14-knowledge-write-channel-design.md` §1.1）：
// 记忆目录**只对只读工具开放**（`tools.mjs` 给 `readFile` 传了 `allowFiles`，而
// `writeFile`/`editFile` 没有）——这是 2026-09-10 的刻意决定（不允许整体覆盖经验库）。
// 但该决定承诺的"记忆写入走 memory.mjs 工具链"一直没有 agent 入口，导致 agent
// 要么靠 Bash `>>`（绕过全部边界检查）、要么放弃（经验静默丢失）。
// append 用**只追加**的语义满足原防护意图：结构上没有覆盖路径。
//
// 本文件钉住五件事：
//   ① 四个闸门真的拦得住：协议文本 / 空模板 / 过短 / tag 与 theme 非法（且**一个字节都不落盘**）
//   ② 幂等：同内容二次写返回 `deduped:true` 且文件不增长
//   ③ **落盘位置正确**：`root` 必须是 `memoryRoot(configDir)`（= `<configDir>/memory/personal`）。
//      传错一层**不会报错**，只会静默新建 `<configDir>/workflow.md` —— 实测踩过：
//      测试条目落到了 `~/.ponos/workflow.md`，真正的 memory 目录一个字节没变，返回值还是 `ok:true`。
//   ④ 写完**索引立刻联动**（同一次调用的后续 search 能查到）
//   ⑤ `--tag` / `--text` / `--theme` 的**真进程转发**没漏登记。
//      这条非用真进程不可：`parseArgs` 解析出的字段不会自动流到内核，漏一个等于该 flag
//      从未存在（S5 的 `--doc`/`--related` 就是这么静默失效的），而单测直调
//      `runKnowledgeCommand` 会绕过这一层管道，完全抓不到。
//
// 隔离：mkdtempSync + PONOS_HOME，并清 PONOS_CONFIG_DIR（宿主若设了它，真进程会读真实库）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateAppendEntry, listMemoryTags, memoryRoot } from '../kernel/memory.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'kernel', 'cli.mjs')

const tmpDirs = []
function fixture(lines = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-append-'))
  tmpDirs.push(dir)
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  const base = ['---', 'name: workflow', '---']
  writeFileSync(join(personal, 'workflow.md'), [...base, ...lines].join('\n') + '\n', 'utf-8')
  return dir
}
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

/** 真进程跑 `--knowledge <args>`；返回 `{code, stdout, stderr, env}` */
function runCli(dir, args) {
  const env = { ...process.env, PONOS_HOME: dir }
  delete env.PONOS_CONFIG_DIR
  const r = spawnSync(process.execPath, [CLI, '--output-format', 'stream-json', '--input-format', 'stream-json', ...args], {
    env, encoding: 'utf8', timeout: 60_000,
  })
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() }
}
const readWorkflow = (dir) => readFileSync(join(dir, 'memory', 'personal', 'workflow.md'), 'utf-8')
const countEntries = (dir) => (readWorkflow(dir).match(/^- \[/gm) || []).length

const ENTRY = '写入通道必须 append-only：Write 是整体覆盖语义，一次遗漏就会清空整个主题文件'

// ── ① 闸门（纯函数，不落盘）─────────────────────────────────────────────────
test('validateAppendEntry：四个闸门各自拦得住', () => {
  // 协议文本：harness 注入块不是经验（S5.1 实测垃圾主源）
  const p = validateAppendEntry({ text: '【上下文锚定 · 权威事实】这是一段协议注入文本，不该入库' })
  assert.equal(p.ok, false)
  assert.equal(p.error, 'protocol')

  const empty = validateAppendEntry({ text: '   ' })
  assert.equal(empty.error, 'empty')

  // 空模板：只有触发词、无实义内容
  const tpl = validateAppendEntry({ text: '流程是' })
  assert.equal(tpl.error, 'template')

  // 过短：入库后会被关联侧参与集过滤 → 等于制造孤立条目（故在入口就拒）
  const short = validateAppendEntry({ text: '太短了' })
  assert.equal(short.error, 'too-short')

  // theme 是文件名，非法名即路径穿越
  assert.equal(validateAppendEntry({ text: ENTRY, theme: '../evil' }).error, 'bad-theme')
  assert.equal(validateAppendEntry({ text: ENTRY, theme: 'a/b' }).error, 'bad-theme')
  assert.equal(validateAppendEntry({ text: ENTRY, theme: 'A' }).error, 'bad-theme')
  // tag 含 `]`/`|`/换行会破坏 `- [主题|tag] 摘要` 行格式
  assert.equal(validateAppendEntry({ text: ENTRY, tag: 'a]b' }).error, 'bad-tag')
  assert.equal(validateAppendEntry({ text: ENTRY, tag: 'a|b' }).error, 'bad-tag')
  assert.equal(validateAppendEntry({ text: ENTRY, tag: 'x'.repeat(41) }).error, 'tag-too-long')

  // 合法：theme 缺省按内容推断（含"申报/材料"→ project-application），并回显解析结果
  const okv = validateAppendEntry({ text: ENTRY, tag: '知识库写入通道' })
  assert.equal(okv.ok, true)
  assert.equal(okv.theme, 'workflow')
  assert.equal(okv.tag, '知识库写入通道')
  assert.equal(validateAppendEntry({ text: '申报材料里的研发费用必须与专审报告口径一致，否则会被核减', tag: 'x' }).theme, 'project-application')
})

test('inferTheme 只认词不认单字（裸"账"曾把"对账"判成 finance）', () => {
  // 实测踩过：一条讲"数据根合并…合并后要对账"的经验被塞进了 finance.md，
  // 只因 `对账` 含 `账`。误判主题是**静默**的（条目消失在一个语义无关的文件里），
  // 故这里把正反两侧都钉住。
  assert.equal(validateAppendEntry({ text: '数据根合并后必须对账：文件层条目数要与索引层一致才算迁完', tag: 'x' }).theme, 'workflow')
  assert.equal(validateAppendEntry({ text: '研发辅助账台账要与专审报告口径一致，否则被核减掉', tag: 'x' }).theme, 'project-application')
  // 真正的财务词仍要认（别把判据收得太狠）
  assert.equal(validateAppendEntry({ text: '报销发票抬头开错了要走红冲流程，税务口径按当期处理', tag: 'x' }).theme, 'finance')
  assert.equal(validateAppendEntry({ text: '记账凭证附件要留存，会计凭证号连续不能断号', tag: 'x' }).theme, 'finance')
})

test('闸门拒绝时真进程退出码 1、stdout 有 error、stderr 有可读理由', () => {
  const dir = fixture()
  const r = runCli(dir, ['--knowledge', 'append', '--text', '太短了'])
  assert.equal(r.code, 1)
  assert.equal(JSON.parse(r.stdout).error, 'too-short')
  // stderr 通道不是装饰：HTTP 侧 kernelReadonly 非零退出即 reject 并**丢弃 stdout**，
  // 没有这一行，路由只能回一个无信息量的 500（调用方看不到"为什么被拒"）。
  assert.match(r.stderr, /\[knowledge\] too-short:/)
  assert.equal(countEntries(dir), 0, '被拒的条目一个字节都不该落盘')
})

// ── ②③④ 写入 / 幂等 / 位置 / 索引联动（真进程）────────────────────────────
test('真进程 append：落盘位置正确、幂等、索引立刻联动', () => {
  const dir = fixture(['- [会话|应用智控] 既有条目 -- 这是既有的经验正文，内容包含足够字符以通过闸门校验'])

  const r1 = runCli(dir, ['--knowledge', 'append', '--tag', '应用智控', '--text', ENTRY])
  assert.equal(r1.code, 0)
  const o1 = JSON.parse(r1.stdout)
  assert.equal(o1.ok, true)
  assert.equal(o1.deduped, false)
  assert.equal(o1.theme, 'workflow')
  assert.equal(o1.tag, '应用智控')

  // ③ 位置：必须落在 memory/personal/ 内；绝不能新建 `<configDir>/workflow.md`
  assert.equal(countEntries(dir), 2)
  assert.ok(!existsSync(join(dir, 'workflow.md')), 'root 传错一层会静默新建 <configDir>/workflow.md')
  assert.equal(memoryRoot(dir), join(dir, 'memory', 'personal'))

  // ② 幂等：同内容再写 → deduped:true 且文件不增长
  const sizeBefore = readWorkflow(dir).length
  const r2 = runCli(dir, ['--knowledge', 'append', '--tag', '应用智控', '--text', ENTRY])
  assert.equal(JSON.parse(r2.stdout).deduped, true)
  assert.equal(readWorkflow(dir).length, sizeBefore, '幂等命中不该改动文件')
  assert.equal(countEntries(dir), 2)

  // ④ 索引联动（同一次调用内）：新条目立刻可检索
  const s = runCli(dir, ['--knowledge', 'search', '--query', 'append-only 覆盖语义'])
  const items = JSON.parse(s.stdout).items || []
  assert.ok(items.length > 0, '写入后应立刻检索得到（syncKnowledgeIndex 增量同步）')
})

test('append 后 tags 立刻反映新标签，并标出 single（写前可查）', () => {
  const dir = fixture([
    '- [会话|应用智控] 甲 -- 应用智控的第一条经验，内容足够长以通过闸门的最低长度要求',
    '- [会话|应用智控] 乙 -- 应用智控的第二条经验，用于验证 count 统计是否正确',
  ])
  const before = JSON.parse(runCli(dir, ['--knowledge', 'tags']).stdout)
  assert.deepEqual(before.tags, [{ tag: '应用智控', count: 2, theme: 'workflow', single: false }])
  assert.equal(before.singleCount, 0)

  runCli(dir, ['--knowledge', 'append', '--tag', '全新单例标签', '--text', ENTRY])
  const afterTags = JSON.parse(runCli(dir, ['--knowledge', 'tags']).stdout)
  const byName = Object.fromEntries(afterTags.tags.map((t) => [t.tag, t]))
  // 用的是**新** tag，故原标签计数不变（2 条），新标签以 single 出现
  assert.equal(byName['应用智控'].count, 2)
  assert.equal(byName['全新单例标签'].count, 1)
  // single=true 就是"写它会成孤岛"的预警信号 —— 这正是 tags 存在的理由
  assert.equal(byName['全新单例标签'].single, true)
  assert.equal(afterTags.singleCount, 1)
})

test('listMemoryTags 直接调用与文件实际一致（纯函数层）', () => {
  const dir = fixture(['- [会话|甲] 条目 -- 一段足够长的正文内容用于统计', '- [会话|乙] 条目 -- 另一段足够长的正文内容用于统计'])
  const t = listMemoryTags(dir)
  assert.equal(t.total, 2)
  assert.equal(t.singleCount, 2)
  assert.deepEqual(t.tags.map((x) => x.tag).sort(), ['乙', '甲'])
})

// ── ⑤ stdin 通道 ───────────────────────────────────────────────────────────
test('`--text -` 从 stdin 逐字读入（多行含 | 与反引号不被 shell 改写）', () => {
  const dir = fixture()
  const text = '多行经验：第一行说明背景\n第二行含 | 竖线与 `code` 反引号，经 stdin 应逐字保留'
  const env = { ...process.env, PONOS_HOME: dir }
  delete env.PONOS_CONFIG_DIR
  const r = spawnSync(process.execPath, [CLI, '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--knowledge', 'append', '--tag', 'stdin通道', '--text', '-'], {
    env, encoding: 'utf8', timeout: 60_000, input: text,
  })
  assert.equal(r.status, 0, r.stderr)
  const raw = readWorkflow(dir)
  assert.ok(raw.includes('`code` 反引号'), '反引号没被改写')
  assert.ok(raw.includes('| 竖线'), '竖线没被改写')
})

// ── 六：坏根不静默造树 ─────────────────────────────────────────────────────
test('configDir 不存在时拒绝写入（防拼错的根静默长出整棵树）', () => {
  const ghost = join(mkdtempSync(join(tmpdir(), 'ponos-ghost-')), 'nope', 'deeper')
  tmpDirs.push(ghost)
  const r = runCli(ghost, ['--knowledge', 'append', '--text', ENTRY])
  assert.equal(r.code, 1)
  assert.equal(JSON.parse(r.stdout).error, 'bad-root')
  assert.ok(!existsSync(ghost), '不该创建出这棵根')
})
