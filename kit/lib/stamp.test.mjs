// kit/lib/stamp.test.mjs —— 调试版渠道身份 stamp（spec §8 · 欠账 A1/A4）
//
// 为什么需要它：调试版是开发基座 + 用户测试通道，但它在盖章之前**没有身份** ——
// "用户手里正在测的这版，对应哪个 commit、含哪些产物、是否 dirty、距版本锚点差多少提交"
// 只能靠翻聊天记录猜。章的用途是**事后可回答**，所以字段错一个就等于答错一次。
//
// 断言分层（缺任何一层都留假绿路径；本计划 Task 1–12 的返工教训全是"断言不可能独立失败"）：
//   ① 契约层：接口字段齐全、**可 JSON 无损序列化** —— 章是要落盘的纯数据，
//      返回 `undefined` 的字段写进 JSON 会**整个消失**（"字段在那儿"变成"文件里没有"）；
//   ② 真源层：三条版本线来自 <root>/kit/manifest/versions.json，**换台账就跟着变**
//      （钉死"真读单一真源"，而不是换个地方硬编码版本号）；
//   ③ 事实层：sha256/bytes 由测试**独立重算**（不是"长度 64 就算过"）—— 且内容变则哈希变；
//   ④ 失败开放层：产物目录不在（未构建）要记 missing 而**不是崩**，也要能盖章；
//   ⑤ git 层：dirty 的**分类**（已跟踪改动 vs 未跟踪）与 ahead（**相对最近 tag**）
//      都在夹具里造真 git 仓来钉 —— 不依赖本机仓的 tag/脏工作树状态（CI 无 release/、也无本机改动）。
//
// ★ 夹具一律 mkdtempSync(tmpdir())：**本文件的断言绝不往真仓写** kit-stamp.json（那会变成需提交的产物或脏工作树）。
//   与 `kit/cli.test.mjs` 里那条"跑真 `stamp` 子命令"的测试区分开：那边写的是**主树**的
//   `release/YFWorking/kit-stamp.json`，而 `release/` 被 `.gitignore` 覆盖 —— 是 local-only 的**产物区**，
//   实测不产生 git 脏状态（`git status` 不显示）。两类"写"性质不同，别把本行的"不写真仓"读成"任何测试都不许碰 release/"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stampChannel } from './stamp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** 夹具根：写进临时目录的文件树（可传 `git: true` 造真 git 仓） */
function fixtureRoot(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-stamp-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 版本台账夹具：三条线给**互不相同**的假值 —— 抄真仓的版本号会让"硬编码"也能过 */
function ledger(lines) {
  return { 'kit/manifest/versions.json': JSON.stringify({ version: 1, lines }, null, 2) }
}
const LINES = (app, kernel, gui) => [
  { id: 'APP_VERSION', value: app }, { id: 'KERNEL_VERSION', value: kernel }, { id: 'GUI_VERSION', value: gui },
]

/**
 * 真 git 夹具：base 提交 → 供 dirty/ahead/commit 断言。
 * 身份与签名显式给定：本机全局 git 配置（gpgsign/hook）不得影响门禁结论。
 */
function gitFixture() {
  const root = fixtureRoot({ 'a.txt': 'v1\n' })
  const G = ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false']
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  git('init', '-q')
  git('add', '-A')
  git(...G, 'commit', '-qm', 'base')
  return {
    root,
    git,
    tag: (name) => git('tag', name),
    commit: (msg) => { writeFileSync(join(root, 'a.txt'), `${msg}\n`); git('add', '-A'); git(...G, 'commit', '-qm', msg) },
  }
}

// ── ① 契约层 ───────────────────────────────────────────────────────────────

test('stampChannel：接口字段齐全，且可 JSON 无损序列化（undefined 写进文件会整个消失）', () => {
  const root = fixtureRoot({ ...ledger(LINES('dev 9.9', 'dev 0.7', '9.8.7')), 'dist/app.js': 'A' })
  const info = stampChannel({ root, write: false, now: new Date('2026-09-19T08:30:00.000Z') })
  for (const k of ['stampFile', 'channel', 'appVersion', 'kernelVersion', 'guiVersion',
    'commit', 'commitSubject', 'dirty', 'ahead', 'builtAt', 'artifacts', 'missing']) {
    assert.ok(k in info, `缺字段 ${k}`)
  }
  assert.equal(info.channel, 'dev', '渠道身份是这条记录的第一性字段')
  assert.equal(info.builtAt, '2026-09-19T08:30:00.000Z', 'builtAt 必须用注入的 now（用运行时时钟就不可复现）')
  assert.deepEqual(JSON.parse(JSON.stringify(info)), info, '序列化必须无损：undefined 字段会被 JSON.stringify 丢掉')
  // ★ 字段集**恰好**等于 spec §8 的明确列表（Task 14 / Rider 4-2 把 §8 的形状示意写成了 13 个字段的清单）。
  //   为什么要钉死集合而不是只查"该有的都在"：多一个字段同样是契约漂移 —— 早期计划草图里有 `debug: null`，
  //   而 spec §8 从未定义它、仓内也没有可记的调试状态（一个恒 null 的字段会让人误以为"调试态可查"）。
  //   Task 13 审查裁定"不加回"，本断言让这条裁定**可执行**（加回即红）。
  assert.deepEqual(Object.keys(info).sort(), ['ahead', 'appVersion', 'artifacts', 'builtAt', 'channel',
    'commit', 'commitSubject', 'dirty', 'guiVersion', 'kernelVersion', 'missing', 'stampFile', 'tag'],
  '字段集必须恰好是 spec §8 的 13 个字段（多一个/少一个都是契约漂移；不含 debug）')
})

// ── ② 真源层：版本字段只从台账来 ───────────────────────────────────────────

test('stampChannel：三条版本线取自 <root>/kit/manifest/versions.json（换台账值就跟着变、不跨调用缓存）', () => {
  const a = fixtureRoot(ledger(LINES('dev 9.9', 'dev 0.7', '9.8.7')))
  const b = fixtureRoot(ledger(LINES('dev 1.1', 'dev 0.3', '1.2.3')))
  const ia = stampChannel({ root: a, write: false })
  assert.deepEqual([ia.appVersion, ia.kernelVersion, ia.guiVersion], ['dev 9.9', 'dev 0.7', '9.8.7'])
  const ib = stampChannel({ root: b, write: false })
  assert.deepEqual([ib.appVersion, ib.kernelVersion, ib.guiVersion], ['dev 1.1', 'dev 0.3', '1.2.3'],
    '第二次调用必须重读台账：缓存首值会让"换了版本却盖旧章"长期静默')
})

test('stampChannel：台账缺失 / 坏 JSON / 缺条目时版本字段为 null 且不崩（盖章不能比被盖章对象先死）', () => {
  const cases = {
    缺文件: fixtureRoot({}),
    坏JSON: fixtureRoot({ 'kit/manifest/versions.json': '{ 坏 JSON' }),
    缺条目: fixtureRoot(ledger([{ id: 'APP_VERSION', value: 'dev 9.9' }])),
  }
  for (const [name, root] of Object.entries(cases)) {
    const info = stampChannel({ root, write: false })
    assert.equal(info.appVersion, name === '缺条目' ? 'dev 9.9' : null, `${name}：appVersion`)
    assert.equal(info.kernelVersion, null, `${name}：kernelVersion 必须 null 而不是 undefined`)
    assert.equal(info.guiVersion, null, `${name}：guiVersion 必须 null 而不是 undefined`)
  }
})

test('stampChannel：不传 root 直接抛错（缺省成模块自己的仓根 = 把章盖到别的树上）', () => {
  assert.throws(() => stampChannel({ write: false }), /root/)
})

// ── ③ 事实层：sha256/bytes 是磁盘字节的事实 ────────────────────────────────

test('stampChannel：artifacts 的 sha256/bytes 与磁盘字节独立重算一致，且递归含子目录', () => {
  const files = { 'dist/index-abc.js': 'AAA', 'dist/assets/logo.svg': '<svg/>', 'kernel-dist/cli.mjs': 'KK' }
  const root = fixtureRoot(files)
  const info = stampChannel({ root, write: false })
  assert.deepEqual(info.artifacts.map((a) => a.path).sort(), Object.keys(files).sort(),
    '路径用 `/` 分隔（Windows 上写成 dist\\a.js 会让按 / 切分的下游找不到文件）')
  assert.deepEqual(info.missing, [])
  for (const a of info.artifacts) {
    const buf = readFileSync(join(root, a.path))
    assert.equal(a.sha256, sha256(buf), `${a.path}：sha256 必须是内容哈希`)
    assert.equal(a.bytes, buf.length, `${a.path}：bytes 必须是真实字节数`)
    assert.ok(a.bytes > 0, `${a.path}：bytes=0 的"存在但不含字节"是假事实`)
  }
  // 内容变 → 该文件哈希必须变（把路径/常量当哈希、或漏读内容的实现会在这里露出来）
  writeFileSync(join(root, 'dist/index-abc.js'), 'AAB')
  const after = stampChannel({ root, write: false })
  const pick = (r) => r.artifacts.find((a) => a.path === 'dist/index-abc.js').sha256
  assert.equal(pick(after), sha256(Buffer.from('AAB')), '改了内容必须重算，不得复用上次结果')
  assert.notEqual(pick(after), pick(info))
})

test('stampChannel：artifacts 顺序稳定且已排序（同一棵树连跑两次严格相等；目录项顺序不得泄漏进章）', () => {
  // ★ 为什么必须单独钉这一条（Task 14 / Rider 4-1）：`collectFiles` 末尾的 `.sort()` 是"稳定顺序"
  //   那句承诺的**唯一**实现，而上面那条断言**两端都先 `.sort()`**，等于把实现的顺序掩盖了 ——
  //   审查的变异④（删掉 `.sort()`）实测 11/11 全绿，即那条断言对顺序零约束。
  //   本断言不额外排序，且夹具刻意让 **目录项返回顺序 ≠ 码元序**：
  //   NTFS 的目录序是大小写不敏感校对（`a.js` 排在 `A1.js` 之前），而 `Array#sort()` 是 UTF-16 码元序
  //   （`A1.js` 排在 `a.js` 之前）。⇒ 删掉 `.sort()` 时本断言**必红**（已做变异验证）。
  const files = { 'dist/a.js': 'A', 'dist/A1.js': 'B', 'dist/assets/z.js': 'Z', 'kernel-dist/b.js': 'K' }
  const root = fixtureRoot(files)
  const first = stampChannel({ root, write: false }).artifacts.map((a) => a.path)
  const second = stampChannel({ root, write: false }).artifacts.map((a) => a.path)
  assert.deepEqual(second, first, '同一棵树连跑两次，artifacts 的路径数组必须严格相等（比对时不额外排序）')
  assert.deepEqual(first, [...first].sort(),
    `artifacts 必须已按码元序排好（目录项返回顺序不得泄漏进章）：实测 ${JSON.stringify(first)}`)
  assert.deepEqual(first, ['dist/A1.js', 'dist/a.js', 'dist/assets/z.js', 'kernel-dist/b.js'],
    '顺序契约的具体形态（递归：同一目录内先文件后子目录的展开顺序由路径序决定）')
})

// ── ④ 失败开放层：未构建也要能盖章 ─────────────────────────────────────────

test('stampChannel：产物目录缺失记 missing 而不是崩；只缺一个时只列那一个', () => {
  const empty = stampChannel({ root: fixtureRoot({}), write: false })
  assert.deepEqual(empty.artifacts, [])
  assert.deepEqual(empty.missing, ['dist', 'kernel-dist'], '两个都没构建 → 两条都点名')

  const half = stampChannel({ root: fixtureRoot({ 'dist/a.js': 'A' }), write: false })
  assert.deepEqual(half.missing, ['kernel-dist'], '一个缺就"全丢"会让另一边已构建的产物丢了身份')
  assert.deepEqual(half.artifacts.map((a) => a.path), ['dist/a.js'])
})

// ── ⑤ 落盘语义（local-only） ───────────────────────────────────────────────

test('stampChannel：默认写到 <root>/release/YFWorking/kit-stamp.json；write:false 一个字节都不写', () => {
  const root = fixtureRoot(ledger(LINES('dev 9.9', 'dev 0.7', '9.8.7')))
  const dry = stampChannel({ root, write: false })
  assert.equal(dry.stampFile, join(root, 'release', 'YFWorking', 'kit-stamp.json'),
    '路径必须挂在传入的 root 下（挂到模块自己的仓根会把章盖到别的树上）')
  assert.ok(!existsSync(dry.stampFile), 'write:false 必须真干跑')

  const info = stampChannel({ root })   // 默认 write:true；非 git 根也要落盘（见下一条）
  assert.ok(existsSync(info.stampFile), 'write 默认为真就必须真写出文件')
  assert.deepEqual(JSON.parse(readFileSync(info.stampFile, 'utf8')), info,
    '写出的 JSON 必须与返回值一致（否则"章"与"报告"是两个真相）')

  assert.match(join(ROOT, 'release', 'YFWorking', 'kit-stamp.json').replace(/\\/g, '/'),
    /release\/YFWorking\/kit-stamp\.json$/, '真仓口径：release/ 被 .gitignore 覆盖 → local-only，不进 CI 门禁')
})

test('stampChannel：拿不到 git 事实时照样落盘（commit=null），绝不"退出码 0 却没写文件"', () => {
  const root = fixtureRoot({})            // 不是 git 仓：commit/commitSubject 必为 null
  const info = stampChannel({ root })
  assert.equal(info.commit, null)
  assert.equal(info.commitSubject, null)
  assert.ok(existsSync(info.stampFile), '写不了 commit 不等于不该写章：静默跳过正是 cli.mjs 警告的最坏形态')
  assert.equal(JSON.parse(readFileSync(info.stampFile, 'utf8')).commit, null, '章里必须能读到"commit 未知"这个事实')
})

// ── ⑥ git 事实层：dirty 分类 + ahead 相对最近 tag ──────────────────────────

test('stampChannel：dirty 按"已跟踪改动 / 未跟踪文件"分开计数（合并成一个数就答不出"改动是否已入库"）', () => {
  const { root, git } = gitFixture()
  const clean = stampChannel({ root, write: false })
  assert.deepEqual(clean.dirty, { tracked: 0, untracked: 0 }, '刚提交的仓必须是干净的')
  assert.match(clean.commit, /^[0-9a-f]{7,}$/, 'commit 取自 git rev-parse --short HEAD')
  assert.equal(clean.commitSubject, 'base')

  writeFileSync(join(root, 'a.txt'), 'v2\n')      // 已跟踪文件改动
  writeFileSync(join(root, 'b.txt'), 'new\n')     // 未跟踪文件
  const dirty = stampChannel({ root, write: false })
  assert.deepEqual(dirty.dirty, { tracked: 1, untracked: 1 },
    `实测 git status --porcelain = ${JSON.stringify(git('status', '--porcelain').split('\n'))}`)
})

test('stampChannel：ahead = 距最近 tag 的提交数；无 tag 时 null（不拿"全部提交数"冒充锚点）', () => {
  const { root, tag, commit } = gitFixture()
  const noTag = stampChannel({ root, write: false })
  assert.equal(noTag.tag, null)
  assert.equal(noTag.ahead, null, '没有版本锚点时"距锚点差多少"是**未知**，不是"等于全部提交数"')

  tag('v0.0.1')
  assert.equal(stampChannel({ root, write: false }).ahead, 0, 'HEAD 就在 tag 上 → 差 0')
  commit('second')
  assert.equal(stampChannel({ root, write: false }).ahead, 1, 'tag 之后每提交一次 ahead 加一')
  commit('third')
  assert.equal(stampChannel({ root, write: false }).ahead, 2)
})

test('stampChannel：ahead 用最近 tag 而不是最老的 tag（多 tag 仓里"距锚点"才说得通）', () => {
  const { root, tag, commit } = gitFixture()
  tag('v1.0.0')
  commit('second')
  tag('v1.1.0')
  commit('third')
  const info = stampChannel({ root, write: false })
  assert.equal(info.tag, 'v1.1.0', '必须取可达的**最近** tag')
  assert.equal(info.ahead, 1, '距最近 tag 1 个提交（若拿 v1.0.0 会算成 2）')
})
