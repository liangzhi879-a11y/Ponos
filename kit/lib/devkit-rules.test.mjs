// kit/lib/devkit-rules.test.mjs —— CT12 的判据测试（DevKit 边界：发行物不得含开发门禁）
//
// 用户口径（2026-09-20）：『**确保**正式打包不会带 devkit，也就是发行给用户的版本不带 kit 及相关配置』。
// "确保"两个字决定了本文件的重点：不只要测"正常情况是绿的"，更要测**每一种漏法都会红** ——
//   · 真源读不到 / JSON 坏 / `patterns[]` 被清空（后者会让规则**恒真通过**，比漏一个文件更危险）；
//   · 匹配实现被改成"恒不命中"（最隐蔽的做假）；
//   · 例外（`devChannelAllow`）被写成"什么都放行"；
//   · 某个发行面**不再引用真源**（退回各自维护一份清单 —— 本批修的漏洞正是这么长出来的）；
//   · `electron-builder.yml` 被改成 `**/*` 这种"全包含"（最常见的"顺手"改法，一次性带走 59 个文件）。
// 另外钉住真实修复的三处：源码交付包**真的会把 `kit/` 与 `AGENTS.md` 挡掉**（真调它的导出函数试算），
// 而**产品源码不该被误拦**（误拦会逼人乱加例外，那是另一种失效）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEVKIT_TRUTH, loadDevkit, devkitMatcher, devkitLeaks,
  assertNoDevkit, ymlPathEntries, includeHitsDevkit, devkitBoundaryCheck,
} from './devkit-rules.mjs'

const ROOT = new URL('../../', import.meta.url)
const readReal = (p) => { try { return readFileSync(new URL(p, ROOT), 'utf8') } catch { return null } }
/** 真仓（工作树）读取器：CT12 在门禁里读提交态；测试读工作树（提交后两者一致，测试不必等提交） */
const worktree = (f) => readReal(f)
const reader = (map) => (f) => (f in map ? map[f] : null)
const truthText = () => readReal(DEVKIT_TRUTH)
/** 夹具真源：从真仓真源复制后改（保证 patterns/surfaces 来自真源，而不是在测试里另抄一份） */
const fixture = (mutate) => { const d = JSON.parse(truthText()); mutate(d); return d }
/** 一份"合格"的读取器内容：真源 + 真实 electron-builder.yml + 各发行面文件（含真源引用） */
const okMap = (over = {}) => {
  const d = JSON.parse(truthText())
  const map = {
    [DEVKIT_TRUTH]: truthText(),
    'electron-builder.yml': readReal('electron-builder.yml'),
  }
  for (const s of d.releaseSurfaces) {
    if (s.guard.file === 'electron-builder.yml') continue
    map[s.guard.file] = '// 清单从真源取：kit/lib/devkit-rules.mjs\n'
  }
  return { ...map, ...over }
}
/** 健康态的期望核验点数：真源 + 匹配自证 3 + 例外自证 2 + **需引用真源的**发行面 + yml（读取 + 结构）。
 *  ★ 从真源算、不写死：`guard.kind === 'structural'`（声明式配置，如 electron-builder.yml）不参与
 *    "是否引用真源"那条判据 —— 它由 yml 结构校验守。 */
const expectedEvaluated = () => {
  const d = JSON.parse(truthText())
  const refSurfaces = d.releaseSurfaces.filter((s) => s.guard.kind !== 'structural').length
  return 1 + 3 + 2 + refSurfaces + 2
}

test('真仓自检：CT12 全绿，且 evaluated = 真源 + 自证 + 各发行面 + yml 结构（不写死数字）', () => {
  const r = devkitBoundaryCheck({ readTracked: worktree })
  assert.equal(r.check.rule, 'CT12')
  assert.deepEqual(r.findings, [], '真仓必须通过：四条发行面都从真源取清单，yml 白名单不含 devkit')
  assert.equal(r.check.passed, true)
  assert.equal(r.check.evaluated, expectedEvaluated(),
    'evaluated 必须等于真源登记的检查点数 —— 写死会掩盖"加了检查却没核"')
})

// ── 真源层面 ────────────────────────────────────────────────────────────────

test('★ 真源读不到 ⇒ 红（fail-closed：不知道边界 ≠ 没问题）', () => {
  const map = okMap()
  delete map[DEVKIT_TRUTH]
  const r = devkitBoundaryCheck({ readTracked: reader(map) })
  assert.equal(r.check.passed, false)
  assert.equal(r.check.evaluated, 0)
  assert.equal(r.findings[0].subject, 'devkit-truth-unreadable')
})

test('★ 真源 JSON 坏 ⇒ 红（不是抛栈）', () => {
  const r = devkitBoundaryCheck({ readTracked: reader(okMap({ [DEVKIT_TRUTH]: '{ 坏 JSON' })) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, 'devkit-truth-unreadable')
  assert.match(r.findings[0].actual, /JSON 解析失败/)
})

test('★ 恒真防护：patterns[] 被清空 ⇒ 红（否则"扫 0 条"会恒真通过）', () => {
  const d = fixture((x) => { x.patterns = []; x.devChannelAllow = [] })
  const r = devkitBoundaryCheck({ readTracked: reader(okMap({ [DEVKIT_TRUTH]: JSON.stringify(d) })) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, 'no-patterns')
  assert.match(r.findings[0].hint, /恒真/, 'hint 要点明白"这就是做假"')
})

test('★ 真源自洽：devChannelAllow 里的项必须在 patterns[] 里（否则是永不生效的例外）', () => {
  const d = fixture((x) => { x.devChannelAllow.push({ path: 'src/', why: '夹具：凭空加一条例外' }) })
  const r = devkitBoundaryCheck({ readTracked: reader(okMap({ [DEVKIT_TRUTH]: JSON.stringify(d) })) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, 'allow-not-in-patterns:src/')
})

// ── 匹配实现自证（防"恒不命中"）────────────────────────────────────────────

test('★ 匹配自证：命中整类失效 / 产品源码被误拦 —— 两种都必须报（否则规则会"恒真通过"或"恒红"）', () => {
  // ① 把 `kit/` 从真源删掉 ⇒ `kit/cli.mjs` "该命中却没命中" ⇒ 必须报
  //    ★ 这比漏一个文件更危险：命中整类失效 ⇒ 所有 devkit 都会通过检查，而规则仍显示"绿"。
  const noKit = fixture((x) => { x.patterns = x.patterns.filter((p) => p.path !== 'kit/') })
  const r1 = devkitBoundaryCheck({ readTracked: reader(okMap({ [DEVKIT_TRUTH]: JSON.stringify(noKit) })) })
  assert.ok(r1.findings.map((f) => f.subject).includes('matcher-proof:kit/cli.mjs'),
    '该命中却没命中 ⇒ 必须报（防"匹配被改成恒不命中"这种最隐蔽的做假）')

  // ② AGENTS.md 同理（同时会触发"例外不在 patterns 里"）
  const noAgents = fixture((x) => { x.patterns = x.patterns.filter((p) => p.path !== 'AGENTS.md') })
  const r2 = devkitBoundaryCheck({ readTracked: reader(okMap({ [DEVKIT_TRUTH]: JSON.stringify(noAgents) })) })
  assert.ok(r2.findings.map((f) => f.subject).includes('matcher-proof:AGENTS.md'))

  // ③ 反过来：把产品源码也划进 devkit ⇒ `src/App.tsx` "不该命中却命中" ⇒ 必须报
  //    （误拦会让交付包缺东西，且逼人到处加例外 —— 那是另一种失效）
  const over = fixture((x) => { x.patterns.push({ path: 'src/', why: '夹具：过度拦截产品源码' }) })
  const r3 = devkitBoundaryCheck({ readTracked: reader(okMap({ [DEVKIT_TRUTH]: JSON.stringify(over) })) })
  assert.ok(r3.findings.map((f) => f.subject).includes('matcher-proof:src/App.tsx'),
    '误拦产品源码 ⇒ 必须报（本仓 src/ 是产品本体）')
})

test('匹配语义：目录前缀 vs 根文件精确（`kit/` 不命中 `kitfoo/`；`AGENTS.md` 不命中子目录同名文件）', () => {
  const kit = devkitMatcher('kit/')
  assert.ok(kit.test('kit/cli.mjs'))
  assert.ok(!kit.test('kitfoo/x.mjs'), '前缀匹配不能变成"以 kit 开头就算"')
  assert.ok(!kit.test('src/kit/x.mjs'), '必须锚定在仓根')
  const agents = devkitMatcher('AGENTS.md')
  assert.ok(agents.test('AGENTS.md'))
  assert.ok(!agents.test('sub/AGENTS.md'), '仓根文件应精确匹配')
})

test('路径归一：Windows 反斜杠也要能命中（否则打包脚本在 Windows 上会漏拦）', () => {
  const d = fixture(() => {})
  assert.equal(devkitLeaks(['kit\\cli.mjs'], d).length, 1)
  assert.equal(devkitLeaks(['AGENTS.md'], d).length, 1)
})

// ── 例外机制自证 ───────────────────────────────────────────────────────────

test('★ 例外自证：开 devChannelAllow ⇒ AGENTS.md 放行；不开（发行物）⇒ 必须拦住', () => {
  const d = fixture(() => {})
  assert.equal(devkitLeaks(['AGENTS.md'], d, { allowDevChannel: true }).length, 0,
    '调试版必须能带 AGENTS.md —— CT11 要求人工测试环境里有这个入口')
  assert.equal(devkitLeaks(['AGENTS.md'], d).length, 1,
    '发行物里必须拦 —— 这条如果失效，本规则就变成"什么都放行"')
  // ★ 例外只放行登记过的那两项：kit/ 在本体在**两个渠道**都必须被拦
  assert.equal(devkitLeaks(['kit/cli.mjs'], d, { allowDevChannel: true }).length, 1)
  assert.equal(devkitLeaks(['docs/ci.md'], d, { allowDevChannel: true }).length, 1)
})

test('★ 例外机制被写坏（恒放行）⇒ 红', () => {
  // 模拟：把 AGENTS.md 从 patterns 里挪走、只留 devChannelAllow（即"永远放行"）
  const d = fixture((x) => { x.patterns = x.patterns.filter((p) => p.path !== 'AGENTS.md') })
  const r = devkitBoundaryCheck({ readTracked: reader(okMap({ [DEVKIT_TRUTH]: JSON.stringify(d) })) })
  const subjects = r.findings.map((f) => f.subject)
  assert.ok(subjects.includes('allow-not-in-patterns:AGENTS.md'), '例外不在 patterns 里 ⇒ 永不生效，必须报')
  assert.ok(subjects.includes('dev-channel-allow-overbroad') || subjects.includes('matcher-proof:AGENTS.md'),
    'AGENTS.md 不再被拦 ⇒ 必须有红（要么例外跑偏、要么匹配自证失败）')
})

// ── 发行面（四路）──────────────────────────────────────────────────────────

test('★ 每个发行面都必须仍引用真源（退回各自维护清单 ⇒ 红）', () => {
  for (const s of JSON.parse(truthText()).releaseSurfaces) {
    if (s.guard.file === 'electron-builder.yml') continue
    const r = devkitBoundaryCheck({ readTracked: reader(okMap({ [s.guard.file]: '// 这里不再引用真源，我自己抄了一份' })) })
    assert.equal(r.check.passed, false, `${s.id} 不再引用真源时必须红`)
    assert.equal(r.findings[0].subject, `surface-not-guarded:${s.guard.file}`)
    assert.match(r.findings[0].hint, /发给客户|抄一份/, 'hint 要说清后果：内部开发配置会发给客户')
  }
})

test('★ 发行面文件整个读不到 ⇒ 红且不抛（发行面消失 = 这条路没人把关）', () => {
  // 用**已入库**的发行面（`portable-dir` → verify-portable-layout.mjs）；
  // 未入库的那两个走 `guard.pending`（见下面两条用例），不会因为"读不到"而红。
  const committed = JSON.parse(truthText()).releaseSurfaces
    .find((s) => s.guard.kind !== 'structural' && !s.guard.pending)
  const map = okMap()
  delete map[committed.guard.file]
  const r = devkitBoundaryCheck({ readTracked: reader(map) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, `surface-missing:${committed.guard.file}`)
  assert.match(r.findings[0].hint, /guard\.pending/, 'hint 要给出正解：没入库就标 pending，而不是删登记')
})

test('★ `guard.pending` 是真判据不是借口：文件读得到却没引用真源 ⇒ 红（因此"入库后自动生效"）', () => {
  const pending = JSON.parse(truthText()).releaseSurfaces.find((s) => s.guard.pending)
  assert.ok(pending, '真源里应至少登记一个 pending 发行面（本机在途的打包脚本）')
  const r = devkitBoundaryCheck({ readTracked: reader(okMap({ [pending.guard.file]: '// 已入库但不再引用真源' })) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, `surface-not-guarded:${pending.guard.file}`)
})

test('★ pending 发行面**未入库**时跳过、不计 evaluated（否则未入库文件会让门禁永远红）', () => {
  const d = JSON.parse(truthText())
  const pending = d.releaseSurfaces.filter((s) => s.guard.pending)
  const map = okMap()
  for (const s of pending) delete map[s.guard.file] // 模拟"提交态读不到"（正是本机 .git/info/exclude 的效果）
  const r = devkitBoundaryCheck({ readTracked: reader(map) })
  assert.equal(r.check.passed, true, '未入库 ⇒ 不该红（"永远红"等于没有红灯）')
  const refCommitted = d.releaseSurfaces.filter((s) => s.guard.kind !== 'structural' && !s.guard.pending).length
  assert.equal(r.check.evaluated, 1 + 3 + 2 + refCommitted + 2, '未入库的不计入，已入库的照常计入')
})

// ── electron-builder.yml 结构校验（安装包 = 主要发行物）────────────────────

test('★ 安装包白名单里显式加 kit ⇒ 红', () => {
  const yml = 'files:\n  - dist/**/*\n  - kit/**/*\n  - package.json\n'
  const r = devkitBoundaryCheck({ readTracked: reader(okMap({ 'electron-builder.yml': yml })) })
  assert.equal(r.check.passed, false)
  const f = r.findings.find((x) => x.subject === 'installer-includes-devkit')
  assert.ok(f)
  assert.match(f.actual, /kit\/\*\*\/\*/, 'actual 要指出是**哪一条**模式把 devkit 带进来了')
  assert.match(f.hint, /全带上|\*\*\/\*/, 'hint 要点明最常见的漏法')
})

test('★★ 安装包改成 `**/*`（"顺手全带上"）⇒ 红 —— 这正是本判据存在的理由', () => {
  const yml = 'files:\n  - "**/*"\n  - "!node_modules/**/*"\n'
  const r = devkitBoundaryCheck({ readTracked: reader(okMap({ 'electron-builder.yml': yml })) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings.find((x) => x.subject === 'installer-includes-devkit').actual, 'files: **/*')
})

test('安装包白名单干净（真实 yml）⇒ 不报这条', () => {
  const r = devkitBoundaryCheck({ readTracked: reader(okMap()) })
  assert.equal(r.findings.find((x) => x.subject === 'installer-includes-devkit'), undefined)
})

test('★ electron-builder.yml 读不到 ⇒ 红（主要发行物无从判定）', () => {
  const map = okMap()
  delete map['electron-builder.yml']
  const r = devkitBoundaryCheck({ readTracked: reader(map) })
  assert.equal(r.check.passed, false)
  assert.equal(r.findings[0].subject, 'yml-missing')
})

test('ymlPathEntries：只取 files / extraResources 段的条目，跳过 `!` 排除项与注释', () => {
  const yml = [
    '# files: 注释里的不算',
    'files:',
    '  - dist/**/*',
    "  - '!public/sample-skills/**'",
    '  - "package.json"',
    'extraResources:',
    '  - from: runtime/python',
    '    to: runtime/python',
    '  - from: pet',
    'win:',
    '  - 这条在别的段里，不该被取',
  ].join('\n')
  const got = ymlPathEntries(yml).map((e) => `${e.key}:${e.value}`)
  assert.deepEqual(got, [
    'files:dist/**/*',
    'files:package.json', // `!` 排除项跳过；引号剥掉
    'extraResources:runtime/python',
    'extraResources:pet',
  ])
})

test('includeHitsDevkit：全包含 / devkit 祖先目录 / devkit 内部 ⇒ true；无关路径 ⇒ false', () => {
  const d = fixture(() => {})
  assert.equal(includeHitsDevkit('**/*', d), true, '最危险的一条：全包含')
  assert.equal(includeHitsDevkit('kit/**/*', d), true)
  assert.equal(includeHitsDevkit('kit', d), true)
  assert.equal(includeHitsDevkit('kit/cli.mjs', d), true)
  assert.equal(includeHitsDevkit('docs/**', d), true, 'docs 下有 devkit 文档 ⇒ 祖先目录也要判 true')
  assert.equal(includeHitsDevkit('dist/**/*', d), false)
  assert.equal(includeHitsDevkit('package.json', d), false)
  assert.equal(includeHitsDevkit('src/**/*', d), false)
})

// ── 打包期自查（真正把包拦下来的那一步）────────────────────────────────────

test('★ assertNoDevkit：命中 ⇒ 抛错（不是"记条日志继续打包"）', () => {
  const d = fixture(() => {})
  assert.throws(() => assertNoDevkit(['src/a.ts', 'kit/cli.mjs'], d),
    /DevKit 边界.*1 个/s, '必须抛 —— 日志留不住，包会照样发出去')
  assert.throws(() => assertNoDevkit(['AGENTS.md'], d), /DevKit 边界/)
  assert.doesNotThrow(() => assertNoDevkit(['src/a.ts', 'server/x.mjs'], d), '干净清单不该被误拦')
  assert.doesNotThrow(() => assertNoDevkit(['AGENTS.md'], d, { allowDevChannel: true }),
    '调试渠道按例外放行（CT11 要求调试版必须有入口）')
})

test('★ assertNoDevkit 的报错信息要**指名**命中项与命中规则（否则拿到报错也不知道改哪儿）', () => {
  const d = fixture(() => {})
  try {
    assertNoDevkit(['kit/lib/gui.mjs'], d)
    assert.fail('应当抛错')
  } catch (e) {
    assert.match(e.message, /kit\/lib\/gui\.mjs/)
    assert.match(e.message, /命中 kit\//)
    assert.match(e.message, /devkit\.json/, '要指向真源，便于改口径')
    assert.match(e.message, /已中止|不写包/)
  }
})

test('★ 真实修复自证：源码交付包的排除规则**真的**挡得住 kit/ 与 AGENTS.md', async (t) => {
  // ★ 这是本批的核心证据：不是"文本里有排除规则"，而是**真调它的导出函数试算**。
  //   若将来有人把 devkit 规则从 EXCLUDE_RULES 里摘掉，这条会红（而不是等包发出去了才知道）。
  //
  // ⚠️ 该脚本当前被**本地 `.git/info/exclude:11` 排除**（开发者本机在途文件，尚未入库）
  //   ⇒ **干净克隆上没有它**。此时跳过（并说明原因），否则本套件在 CI 上会因
  //   `ERR_MODULE_NOT_FOUND` 而红 —— 那是"测试环境问题"冒充"代码问题"，比的假红更费人。
  const src = new URL('../../scripts/pack-source-zip.mjs', import.meta.url)
  if (!existsSync(fileURLToPath(src))) {
    return t.skip('scripts/pack-source-zip.mjs 未入库（本地 .git/info/exclude:11）⇒ 干净克隆无此文件；入库后本用例自动生效')
  }
  const mod = await import(src.href)
  const devkitHits = ['kit/cli.mjs', 'AGENTS.md', 'docs/ci.md', 'docs/bridge-contract.md', 'kit-stamp.json']
  for (const rel of devkitHits) {
    const rule = mod.excludedBy(rel)
    assert.ok(rule, `${rel} 应被源码包排除（它只服务本仓开发门禁）`)
    assert.match(rule.why, /DevKit 边界/, `${rel} 的排除理由应来自真源（DevKit 边界），便于审计`)
  }
  // ★ 反向：产品源码与运行资产**不该**被误拦（误拦 = 交付包缺东西，同样是事故）
  for (const rel of ['src/App.tsx', 'server/bridge.mjs', 'kernel/cli.mjs', 'package.json']) {
    const rule = mod.excludedBy(rel)
    assert.ok(!rule || !/DevKit 边界/.test(rule.why), `${rel} 不该被 DevKit 边界拦（它不是 devkit）`)
  }
  assert.ok(mod.DEVKIT.ok, '打包脚本应能从真源读到边界')
  assert.equal(mod.DEVKIT_RULES.length, JSON.parse(truthText()).patterns.length,
    'DEVKIT_RULES 条数必须等于真源 patterns 条数（防"真源加了、脚本没跟上"）')
})

test('真源里的 why 都要写清"为什么它算 devkit"（没有理由的条目 = 后人不敢删、也不敢改）', () => {
  const d = JSON.parse(truthText())
  for (const p of d.patterns) {
    assert.ok(p.why && p.why.length > 20, `${p.path} 缺少 why（或过于敷衍）`)
  }
  for (const s of d.releaseSurfaces) {
    assert.ok(s.guard?.file, `${s.id} 缺少 guard.file`)
    assert.ok(s.guard?.how, `${s.id} 缺少 guard.how（怎么守的）`)
    assert.ok(s.status, `${s.id} 缺少 status（当前实况）`)
  }
})
