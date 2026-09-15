// T3：`--knowledge import` 的 **flag 接线守卫**（真进程）。
//
// 为什么必须真进程：本 CLI 对未知 `--` 参数是**静默忽略**的（parseArgs 的 default 分支），
// 且 `runKnowledgeCommand` 的调用方（HTTP 路由/工具/GUI）都经 `kernel/cli.mjs` 的
// parseArgs → 转发对象 这条管道。于是"漏登记 / 漏转发"的失败形态不是报错，而是
// **静默降级**：`--dry-run` 丢了 = 预览变成真写盘；`--max-ocr-pages` 丢了 = 200 页全跑。
// 命令级用例（直接调 runKnowledgeCommand）**绕不过这一层**，只有真进程能钉住。
// （同一纪律的历史用例：knowledge-related-cli.test.mjs 的 `--doc`/`--related` 真进程段。）
//
// pytest 依赖处理：转换器由**假解析器**承担（`YFW_DOC_TO_MD` 指向一段打印单行 JSON 的
// python 脚本），故用例不依赖真实 pd 解析库、不加载 OCR 模型。没有可用 python 解释器的
// 环境里，只有"需要落盘产物"的用例 skip（flag 校验/护栏/零落盘那批不依赖 python）。
//
// 隔离：mkdtemp + PONOS_HOME（并清掉 CLAUDE_CONFIG_DIR，防宿主把 configDir 指到真实库）；
// 不起 bridge、不联网。真实 `knowledge/` 一律不碰。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importDocuments, resolvePython } from '../kernel/knowledge-import.mjs'

const CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const REPO = fileURLToPath(new URL('..', import.meta.url))
const FMT = ['--output-format', 'stream-json', '--input-format', 'stream-json']

/** 临时 configDir：真实的那个一定非空（内含 config.json），bad-root 短路依赖它存在 */
function mkHome(tag = 'h') {
  const dir = mkdtempSync(join(tmpdir(), `ponos-kbimpcli-${tag}-`))
  writeFileSync(join(dir, 'config.json'), '{"model":"fake"}', 'utf-8')
  return dir
}
function mkSrc(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kbimpsrc-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }
  return dir
}

// 假解析器：恰好一行 UTF-8 JSON（与 doc_to_md.py 的 stdout 契约同形）。
// 正文里回显输入文件名，便于断言"哪份文件落成了哪篇 md"。
let FAKE = null
function fakeParser() {
  if (FAKE) return FAKE
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kbimpfake-'))
  FAKE = join(dir, 'doc_to_md.py')
  writeFileSync(FAKE, [
    'import sys, json, os',
    'sys.stdout.reconfigure(encoding="utf-8")',
    'a = sys.argv[1:]',
    'inp = a[a.index("--input") + 1] if "--input" in a else ""',
    'name = os.path.basename(inp)',
    'print(json.dumps({"ok": True, "converter": "fake", "title": name,',
    '  "sections": [{"heading": "一", "level": 1, "text": "正文 " + name,',
    '    "tables": [[["科目", "金额"], ["材料费", "320"]]]}], "warnings": []}, ensure_ascii=False))',
  ].join('\n'), 'utf-8')
  return FAKE
}

/** 是否有可用 python（无则"需要产物"的用例 skip；flag 守卫用例不依赖它） */
function pyOk() {
  try {
    const py = resolvePython()
    const r = spawnSync(py, ['-c', 'print(1)'], { encoding: 'utf-8' })
    return r.status === 0
  } catch { return false }
}

function envFor(home, extra = {}) {
  const env = { ...process.env, PONOS_HOME: home, ...extra }
  delete env.CLAUDE_CONFIG_DIR   // 否则优先级高于 PONOS_HOME，用例会写进真实 configDir
  return env
}
/** 真进程跑 `--knowledge <args…>`（格式旗标必须带：`--knowledge` 短路在格式校验之后） */
function runCli(home, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...FMT, '--knowledge', ...args], {
    cwd: REPO, encoding: 'utf-8', env: envFor(home, extraEnv),
  })
  let json = null
  try { json = JSON.parse(r.stdout) } catch { /* 非 JSON 时留 null，由断言给出上下文 */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr }
}
/** 目录快照（路径 + 大小）：证明"预览/被拒"没有留下任何字节 */
function snap(root) {
  const out = []
  const walk = (d, rel = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { out.push(r + '/'); walk(p, r) } else out.push(`${r} ${statSync(p).size}`)
    }
  }
  if (existsSync(root)) walk(root)
  return out.sort().join('\n')
}
const idxRoot = (home) => join(home, 'knowledge')
const spaceRootOf = (home, id) => join(home, 'knowledge', 'spaces', id)

// —— 1. dry-run：报告契约 + **零落盘**（spec P2-2）——
test('真进程 import --dry-run：报告含 dryRun 回显与三档清单，且**一个文件都不写**', () => {
  const home = mkHome('dry')
  const src = mkSrc({ 'a.txt': 'A', 'sub/b.txt': 'B', 'evil.exe': 'MZ' })
  try {
    const before = snap(home)
    const r = runCli(home, ['import', '--src', src, '--name', '预演空间', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    assert.equal(r.json.ok, true)
    // dryRun 回显是"转发真的到了模块"的证据之一（漏转发时模块拿到 undefined → false）
    assert.equal(r.json.dryRun, true)
    assert.equal(r.json.spaceName, '预演空间')
    assert.equal(r.json.source, src, '单源时回显字符串源路径（不是数组）')
    assert.deepEqual(r.json.counts, { total: 3, converted: 2, skipped: 0, failed: 1 })
    assert.deepEqual(r.json.converted.map((c) => c.source).sort(), ['a.txt', 'sub/b.txt'])
    assert.equal(r.json.converted[0].out, null, '预览不得给出目标名（那要落盘后才知道）')
    assert.equal(r.json.failed[0].error, 'blocked-ext')
    // 零落盘：连 knowledge 根与 .index 脚手架都不该出现
    assert.equal(snap(home), before, 'dry-run 后目录必须逐字节不变')
    assert.ok(!existsSync(idxRoot(home)), 'dry-run 不得建 knowledge 根（含 .index）')
    assert.ok(!existsSync(spaceRootOf(home, '预演空间')), 'dry-run 不得建空间目录')
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

// —— 2. 真落盘 + 幂等 + 索引同步 ——
test('真进程 import：md/台账/.space.json 落盘；二次导入全跳过；导入即可检索', (t) => {
  if (!pyOk()) return t.skip('无可用 python 解释器')
  const home = mkHome('real')
  const src = mkSrc({ 'a.txt': 'A', 'sub/b.txt': 'B' })
  try {
    const r = runCli(home, ['import', '--src', src, '--name', '空间甲'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    assert.deepEqual(r.json.counts, { total: 2, converted: 2, skipped: 0, failed: 0 })
    const root = spaceRootOf(home, '空间甲')
    assert.ok(existsSync(join(root, 'a.md')))
    assert.ok(existsSync(join(root, 'sub', 'b.md')), '目录结构必须保留')
    assert.ok(readFileSync(join(root, 'a.md'), 'utf-8').includes('| 科目 | 金额 |'), '表格必须转成 Markdown')
    assert.ok(existsSync(join(root, '.import.json')), '台账必须落盘（幂等的依据）')
    assert.ok(existsSync(join(root, '.space.json')))
    assert.match(r.json.indexSync, /incremental|reloaded/, '导入后必须同步索引（否则要等下次会话才搜得到）')

    // 二次导入：全跳过（幂等）
    const mtime = statSync(join(root, 'a.md')).mtimeMs
    const r2 = runCli(home, ['import', '--src', src, '--name', '空间甲'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(r2.code, 0)
    assert.deepEqual(r2.json.counts, { total: 2, converted: 0, skipped: 2, failed: 0 })
    assert.equal(statSync(join(root, 'a.md')).mtimeMs, mtime, '跳过时不得重写产物')

    // 检索命中：证明"导入 → 可检索"这条闭环在**真进程**上也成立
    const s = runCli(home, ['search', '--query', '正文 a.txt'])
    assert.equal(s.code, 0, `stderr=${s.stderr}`)
    assert.ok((s.json.items || []).some((x) => x.docId === '空间甲/a.md'), `检索未命中：${s.stdout.slice(0, 200)}`)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

// —— 3. `--src` 可重复（多源）——
test('--src 可重复：多源回显数组且两源都落盘；单源保持字符串', (t) => {
  if (!pyOk()) return t.skip('无可用 python 解释器')
  const home = mkHome('multi')
  const s1 = mkSrc({ 'a.txt': 'A' })
  const s2 = mkSrc({ 'c.txt': 'C' })
  try {
    const r = runCli(home, ['import', '--src', s1, '--src', s2, '--name', '空间乙'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    assert.ok(Array.isArray(r.json.source), '多源必须是数组（否则调用方看不出这批来自哪几个地方）')
    assert.equal(r.json.source.length, 2)
    assert.deepEqual(r.json.counts, { total: 2, converted: 2, skipped: 0, failed: 0 })
    // 多源时逐源加 `<源目录名>/` 前缀：两条同名 a.txt 不会互相覆盖
    const root = spaceRootOf(home, '空间乙')
    assert.ok(existsSync(join(root, basename(s1), 'a.md')), `实得：${snap(root)}`)
    assert.ok(existsSync(join(root, basename(s2), 'c.md')))
  } finally {
    for (const d of [home, s1, s2]) rmSync(d, { recursive: true, force: true })
  }
})

// —— 4. `--name` / `--space` 二选一 ——
test('--name 与 --space 二选一都能定空间；两者皆缺 → bad-space-id（不是静默建空间）', () => {
  const home = mkHome('name')
  const src = mkSrc({ 'a.txt': 'A' })
  try {
    const byName = runCli(home, ['import', '--src', src, '--name', '只用名称', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(byName.code, 0, `stderr=${byName.stderr}`)
    assert.equal(byName.json.spaceId, '只用名称')
    const bySpace = runCli(home, ['import', '--src', src, '--space', '空间丙', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(bySpace.code, 0)
    assert.equal(bySpace.json.spaceId, '空间丙')
    assert.equal(bySpace.json.spaceName, '空间丙', '缺 name 时显示名回落 space id')
    const neither = runCli(home, ['import', '--src', src, '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(neither.code, 1)
    assert.equal(neither.json.error, 'bad-space-id')
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

// —— 5. 参数错必须明确报错（缺 --src / 坏 --max-ocr-pages）——
test('缺 --src → missing-from；--max-ocr-pages 非法值 → 明确报错（证明该 flag 被读到并转发）', () => {
  const home = mkHome('argerr')
  const src = mkSrc({ 'a.txt': 'A' })
  try {
    const noSrc = runCli(home, ['import', '--name', '空间丁', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(noSrc.code, 1)
    assert.equal(noSrc.json.error, 'missing-from')
    // stderr 补充通道（HTTP 侧 kernelReadonly 非零退出会丢弃 stdout，声明"为什么被拒"只能靠它）
    assert.match(noSrc.stderr, /\[knowledge\] missing-from/)

    // 非法值**必须报错**：静默回落默认 200 会让"我限了 5 页"变成跑了 40 倍 OCR 工作量。
    // 该断言同时是"flag 真的穿过 parseArgs → 转发 → op"的证据：任一层漏了，这里都会 code=0。
    for (const bad of ['abc', '0', '-3']) {
      const r = runCli(home, ['import', '--src', src, '--name', '空间丁', '--dry-run', '--max-ocr-pages', bad], { YFW_DOC_TO_MD: fakeParser() })
      assert.equal(r.code, 1, `--max-ocr-pages ${bad} 必须报错（实际 code=${r.code}）`)
      assert.equal(r.json.error, 'bad-max-ocr-pages')
    }
    // 合法值放行（含小数 floor：与 server/tool 两层同口径，不算参数错误）
    for (const okv of ['1', '5.5']) {
      const r = runCli(home, ['import', '--src', src, '--name', '空间丁', '--dry-run', '--max-ocr-pages', okv], { YFW_DOC_TO_MD: fakeParser() })
      assert.equal(r.code, 0, `--max-ocr-pages ${okv} 应放行（stderr=${r.stderr}）`)
      assert.equal(r.json.dryRun, true)
    }
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

// —— 6. `--dry-run` 的布尔解析形态 ——
test('--dry-run 是"存在即真"的开关：不带值 / 带值 / 带 false 一律预览（值被当 positional 忽略）', () => {
  const home = mkHome('bool')
  const src = mkSrc({ 'a.txt': 'A' })
  try {
    for (const form of [[], ['true'], ['false']]) {
      const r = runCli(home, ['import', '--src', src, '--name', '空间戊', '--dry-run', ...form], { YFW_DOC_TO_MD: fakeParser() })
      assert.equal(r.code, 0, `--dry-run ${form.join(' ')} → stderr=${r.stderr}`)
      assert.equal(r.json.dryRun, true, `--dry-run ${form.join(' ')} 必须仍是预览`)
      assert.ok(!existsSync(spaceRootOf(home, '空间戊')), '预览不得建空间')
    }
    // 说明（不做断言，只留契约）：本 CLI 所有布尔 flag 都是"存在即真"，
    // 不存在 `--dry-run false` 的"关"语义 —— 要真跑就别传该 flag。
    // 上面三种形态都仍是预览，正是这条纪律的行为证据。
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

// —— 7. P3-1 只读/非法目标 ——
test('P3-1：pack- 前缀 / 已存在 packs/<id> / 非法 id / 内置空间 → 明确错误且不落盘', () => {
  const home = mkHome('p3')
  const src = mkSrc({ 'a.txt': 'A' })
  mkdirSync(join(home, 'knowledge', 'packs', '资料包'), { recursive: true })
  try {
    const pack = runCli(home, ['import', '--src', src, '--space', 'pack-xxx', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(pack.code, 1)
    assert.equal(pack.json.error, 'readonly-space', '403 语义：是权限问题，不是"名字打错了"')
    const exist = runCli(home, ['import', '--src', src, '--space', '资料包', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(exist.code, 1)
    assert.equal(exist.json.error, 'readonly-space')
    const bad = runCli(home, ['import', '--src', src, '--space', 'a/b', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(bad.code, 1)
    assert.equal(bad.json.error, 'bad-space-id')
    const builtin = runCli(home, ['import', '--src', src, '--space', 'experience', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(builtin.code, 1)
    assert.equal(builtin.json.error, 'bad-space-id')
    // 四种被拒路径都不得留下空间目录
    assert.ok(!existsSync(join(home, 'knowledge', 'spaces')), '被拒时不得建 spaces 根')
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

// —— 8. 配置根不存在时短路（与 append 同一道闸门）——
test('PONOS_HOME 指向不存在的路径 → bad-root，且**不新建**这棵树', () => {
  const ghost = join(tmpdir(), `ponos-kbimp-ghost-${process.pid}-${Date.now()}`)
  const src = mkSrc({ 'a.txt': 'A' })
  try {
    const r = runCli(ghost, ['import', '--src', src, '--name', '空间己', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(r.code, 1)
    assert.equal(r.json.error, 'bad-root')
    assert.ok(!existsSync(ghost), '拼错的 configDir 不得被种出一棵树（实测踩过的病灶）')
  } finally { rmSync(ghost, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

// —— 9. P2-1：与 agent 工具/T2 模块**同一份报告**（不是两套实现）——
test('P2-1：--knowledge import 与直接调 T2 模块返回同一份报告（管道复用）', async () => {
  const homeA = mkHome('pipeA')
  const homeB = mkHome('pipeB')
  const src = mkSrc({ 'a.txt': 'A', 'sub/b.txt': 'B', 'evil.exe': 'MZ' })
  try {
    const cli = runCli(homeA, ['import', '--src', src, '--name', '管道空间', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(cli.code, 0, `stderr=${cli.stderr}`)
    // 直接调模块（同一批参数）——dryRun 下不调转换器，故两份报告必须逐字段相同
    const mod = await importDocuments({ configDir: homeB, from: src, name: '管道空间', dryRun: true })
    const strip = (o) => { const { spaceRoot, ...rest } = o; return rest }
    assert.deepEqual(strip(cli.json), strip(mod), 'CLI 与模块的报告必须同源（含计数、拒因、dryRun 回显）')
    assert.equal(mod.spaceRoot, spaceRootOf(homeB, '管道空间'), '模块报告里的 spaceRoot 就是空间根（CLI 只多了自己的临时 home 前缀）')
  } finally {
    rmSync(homeA, { recursive: true, force: true })
    rmSync(homeB, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  }
})

// —— 10. parseArgs 层面的登记（真进程用例的"文件级"补充：漏登记时这里先红）——
test('parseArgs 登记：--src/--name/--dry-run/--max-ocr-pages 逐项可解析（转发另有真进程用例）', async () => {
  const { parseArgs } = await import('../kernel/cli.mjs')
  const a = parseArgs(['--knowledge', 'import', '--src', 'A', '--src', 'B', '--space', 'S', '--name', 'N', '--dry-run', '--max-ocr-pages', '3'])
  assert.equal(a.knowledge, 'import')
  assert.deepEqual(a.src, ['A', 'B'], '可重复 flag 收集为数组')
  assert.equal(parseArgs(['--knowledge', 'import', '--src', 'A']).src, 'A', '单源保持字符串')
  assert.equal(a.space, 'S')
  assert.equal(a.name, 'N')
  assert.equal(a.dryRun, true)
  assert.equal(a.maxOcrPages, '3', 'parseArgs 不做数值转换（转换与校验在 op 侧）')
  const b = parseArgs(['--knowledge', 'import'])
  assert.equal(b.dryRun, undefined)
  assert.equal(b.src, undefined)
})

// —— 11. `--from` 兼容别名（plan.md 验收命令的原文写法）——
// 权威名是 spec §7.2 R2 的 `--src`；但 plan 的验收命令写 `--from <目录>`，且 `--from`
// 本就是既有 flag（范围语义），故在 import 路径上做一次入参归一。三条性质必须同时成立：
//   a) `--from <目录>` 能真跑通（否则按 plan 原文验收会得到 missing-from）；
//   b) 与 `--src` 同时给出时 `--src` 优先（显式胜过别名，不静默改道）；
//   c) 其它 op 的 `--from` 语义零变化（不被当成路径）——否则 readonly/范围窗口会被污染。
test('--from 兼容别名：import 路径上等义于 --src，且不污染范围语义', async () => {
  const { parseArgs } = await import('../kernel/cli.mjs')
  // a) 别名生效，且 `out.from` 原样保留（范围语义可继续读它）
  const viaFrom = parseArgs(['--knowledge', 'import', '--from', 'D:/资料', '--space', 'S'])
  assert.equal(viaFrom.src, 'D:/资料')
  assert.equal(viaFrom.from, 'D:/资料', '别名只增不改：out.from 必须保持原值')
  // b) 同时给出 → --src 优先（顺序无关）
  assert.equal(parseArgs(['--knowledge', 'import', '--from', 'A', '--src', 'B']).src, 'B')
  assert.equal(parseArgs(['--knowledge', 'import', '--src', 'B', '--from', 'A']).src, 'B')
  // c) 非 import op：`--from` 一律不折成 src（范围窗口语义零变化）
  assert.equal(parseArgs(['--knowledge', 'search', '--query', 'x', '--from', '2026-09-14']).src, undefined)
  assert.equal(parseArgs(['--usage', '--from', '2026-09-14']).src, undefined)
  assert.equal(parseArgs(['--from', '2026-09-14']).src, undefined)
  // 无 --knowledge 时也不该凭空长出 src
  assert.equal(parseArgs(['--from', 'A']).src, undefined)
})

test('真进程 import --from（plan 验收命令原文写法）：与 --src 同一条管线，dry-run 零落盘', () => {
  const home = mkHome('fromalias')
  const src = mkSrc({ 'a.txt': 'A', 'sub/b.txt': 'B', 'evil.exe': 'MZ' })
  try {
    const before = snap(home)
    const from = runCli(home, ['import', '--from', src, '--space', '别名空间', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(from.code, 0, `--from 必须能跑通（原样报错即验收失败）：stderr=${from.stderr} stdout=${from.stdout.slice(0, 200)}`)
    assert.equal(from.json.dryRun, true)
    assert.equal(from.json.spaceId, '别名空间')
    assert.equal(from.json.source, src, 'source 回显的是 --from 给的目录（别名真的送到了模块）')
    assert.deepEqual(from.json.counts, { total: 3, converted: 2, skipped: 0, failed: 1 })
    assert.equal(snap(home), before, '别名路径同样必须零落盘')
    // 与权威名给出**逐字段相同**的报告（别名不是第二条口径）
    const viaSrc = runCli(home, ['import', '--src', src, '--space', '别名空间', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(viaSrc.code, 0, `stderr=${viaSrc.stderr}`)
    const strip = (o) => { const { spaceRoot, ...rest } = o; return rest }
    assert.deepEqual(strip(from.json), strip(viaSrc.json), '--from 与 --src 的报告必须逐字段相同')
    // 同时给出时 --src 胜出（真进程侧复核：源换成另一个目录，报告应指向它）
    const src2 = mkSrc({ 'c.txt': 'C' })
    try {
      const both = runCli(home, ['import', '--from', src2, '--src', src, '--space', '别名空间', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
      assert.equal(both.code, 0, `stderr=${both.stderr}`)
      assert.equal(both.json.source, src, '--src 优先于 --from')
    } finally { rmSync(src2, { recursive: true, force: true }) }
    // 非 import op 的 --from 不得被当作路径：search 仍按 query 正常工作
    const s = runCli(home, ['search', '--query', 'x', '--from', '2026-09-14'])
    assert.equal(s.code, 0, `stderr=${s.stderr}`)
    assert.ok(!('error' in s.json), `--from 在非 import op 上不得触发参数错误：${s.stdout.slice(0, 200)}`)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})

// —— 12. `--space` 的转发（真进程，独立于 --name 的那条）——
test('--space 转发：真进程 import 到指定 space id，且空间由 id 定名', () => {
  const home = mkHome('spc')
  const src = mkSrc({ 'a.txt': 'A' })
  try {
    const r = runCli(home, ['import', '--src', src, '--space', '真进程空间', '--dry-run'], { YFW_DOC_TO_MD: fakeParser() })
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    assert.equal(r.json.spaceId, '真进程空间', '--space 漏转发时这里会变成 bad-space-id')
    assert.equal(r.json.spaceName, '真进程空间')
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) }
})
