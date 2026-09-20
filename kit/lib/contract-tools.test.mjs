// kit/lib/contract-tools.test.mjs —— T4 工具 schema 提取器（DevKit P1 · 契约快照）
//
// 为什么必须有这些断言：
//   · **双路交叉校验**：运行时 `createToolRegistry({cwd}).toolSchemas()` 是出口真相，
//     静态解析 `kernel/tools.mjs` 的 registry 键是"代码里写了什么"。两路必须都能复算 ——
//     只信一路就抓不到"注册表有、出口没有"（工具声明存在但模型永远看不到）这一整类缺陷。
//   · `shapeOf` 只取**结构指纹**（properties 名+类型 / required / additionalProperties 存在性）：
//     改结构必须变（否则 schema 漂移无人发现），**改 description 散文绝不能变**
//     （否则改文案即红 → 门禁被基线淹没 = 噪声门禁，plan §7 反例 ⑩）。
//   · 动态源（工作流 `run_<slug>` / MCP `mcp__*` / 应用智控 / 出网映射）必须逐条登记：
//     它们是**随磁盘与配置变化**的工具，静态计数 21 不是全貌，"提取不到 ≠ 不存在"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractTools } from './contract-tools.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** 夹具：一个真 git 仓 + 可运行的 kernel/tools.mjs（提取器会真的 import 它） */
function fixture({ descriptionText = '甲', requiredOnRead = true, extraRuntimeTool = false, withDynamicSources = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-ct-tools-'))
  const write = (rel, content) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), content) }
  const toolsSrc = [
    'export function createToolRegistry({ cwd } = {}) {',
    '  return {',
    '    toolSchemas: () => [',
    "      { name: 'Bash', description: 'run shell', input_schema: { type: 'object', additionalProperties: false, properties: { command: { type: 'string' } }, required: ['command'] } },",
    // ★ 属性级 description 也随 descriptionText 变：naive 指纹（把整份 schema JSON 入哈希）
    //   必须在这里变红 —— 否则"改文案即红"这条反例只钉在工具级描述上，等于测空
    `      { name: 'Read', description: ${JSON.stringify(descriptionText)}, input_schema: { type: 'object', additionalProperties: false, properties: { file_path: { type: 'string', description: ${JSON.stringify(descriptionText + '-prop')} }, limit: { type: 'number' } }${requiredOnRead ? ", required: ['file_path']" : ''} } },`,
    ...(extraRuntimeTool ? ["      { name: 'Ghost', description: '只在出口', input_schema: { type: 'object', properties: {} } },"] : []),
    '    ],',
    '  }',
    '}',
    '// 静态表（4 空格缩进的顶层键 = registry 键）',
    'const registry = {',
    "    Bash: { description: 'x', input_schema: {} },",
    "    Read: { description: 'y', input_schema: {} },",
    '  }',
    'export { registry }',
    '',
  ].join('\n')
  write('kernel/tools.mjs', toolsSrc)
  if (withDynamicSources) {
    write('kernel/dyntools.mjs', "export const naming = 'run_<slug>'\nconst t = { input_schema: {} }\n")
    write('kernel/mcp-tools.mjs', "const a = { input_schema: {} }\nconst b = { input_schema: {} }\n")
    write('kernel/app-tools.mjs', "const a = { input_schema: {} }\n")
    write('kernel/api.mjs', "const wire = (t) => ({ input_schema: t.input_schema })\n")
  }
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return { root }
}

test('★双路交叉校验：names = 静态键 ∪ 运行时出口；staticCount 只数静态表', async () => {
  const { root } = fixture()
  const r = await extractTools({ root })
  assert.deepEqual(r.names, ['Bash', 'Read'])
  assert.equal(r.staticCount, 2)
  assert.equal(r.names.length, r.staticCount, '夹具里两路一致')
  // 出口多一个（静态表没登记）⇒ 并集把它带出来、且长度立刻不等（这就是"两路交叉"的可见性）
  const r2 = await extractTools({ root: fixture({ extraRuntimeTool: true }).root })
  assert.deepEqual(r2.names, ['Bash', 'Ghost', 'Read'])
  assert.equal(r2.staticCount, 2)
  assert.ok(r2.names.length > r2.staticCount, '出口有、静态表没有的工具必须让两侧条数不等（否则静默丢工具）')
})

test('★shapeOf = 结构指纹：改 required 必变，改 description 绝不 变', async () => {
  const a = await extractTools({ root: fixture({ requiredOnRead: true, descriptionText: '甲' }).root })
  const b = await extractTools({ root: fixture({ requiredOnRead: false, descriptionText: '甲' }).root })
  const c = await extractTools({ root: fixture({ requiredOnRead: true, descriptionText: '完全换一段散文描述' }).root })
  const fp = (r) => r.shapeOf('Read')
  assert.match(fp(a), /^[0-9a-f]{8}$/, 'shapeOf 是 sha256 前 8 位十六进制')
  assert.equal(fp(a), fp(c), '改 description 绝不 变指纹（否则改文案就红 = 噪声门禁，plan §7 反例 ⑩）')
  assert.notEqual(fp(a), fp(b), 'required 是结构：去掉它必须让指纹变（否则 schema 漂移无人发现）')
  assert.notEqual(a.shapeOf('Bash'), a.shapeOf('Read'))
  assert.equal(a.shapeOf('Nope'), null, '库里没有的工具，指纹返回 null（不假装）')
  // 同一份输入两次调用必须一致（否则快照无法复算）
  assert.equal(fp(a), fp(await extractTools({ root: fixture({ requiredOnRead: true, descriptionText: '甲' }).root })))
})

test('★动态源逐条登记（工作流 / MCP / 应用智控 / 出网映射）—— 缺失也要如实说 present:false', async () => {
  const withSources = await extractTools({ root: fixture({ withDynamicSources: true }).root })
  const ids = withSources.sources.map((s) => s.id)
  for (const id of ['static', 'workflow', 'mcp', 'app', 'wire']) {
    assert.ok(ids.includes(id), `动态源 ${id} 必须登记，实测 ${ids.join(',')}`)
  }
  const wf = withSources.sources.find((s) => s.id === 'workflow')
  assert.equal(wf.file, 'kernel/dyntools.mjs')
  assert.equal(wf.present, true)
  assert.equal(wf.role, 'dynamic')
  assert.ok(wf.naming.includes('run_'), `工作流派生工具的命名规则要写清楚，实测 ${wf.naming}`)
  assert.ok(wf.schemaSites.length >= 1, '每条动态源要记下 input_schema 出现位置（可复核）')

  const bare = await extractTools({ root: fixture().root })
  assert.deepEqual(bare.sources.filter((s) => s.role === 'dynamic').map((s) => s.present), [false, false, false],
    '没有这些文件的仓里必须如实报 present:false（而不是把条目删掉假装不存在）')
})

test('★kernel/tools.mjs 缺失：不抛错，但静态数 0 + 源 present:false（不得静默成功）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yfw-ct-tools-empty-'))
  mkdirSync(join(root, 'kernel'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: root })
  const r = await extractTools({ root })
  assert.deepEqual(r.names, [])
  assert.equal(r.staticCount, 0)
  assert.equal(r.sources.find((s) => s.id === 'static').present, false)
  assert.equal(r.shapeOf('Bash'), null)
})

test('真仓：静态 21 = 运行时出口 21，且两路逐名相等（CT6 的判据基础）', async () => {
  const r = await extractTools({ root: ROOT })
  assert.equal(r.staticCount, 21, 'kernel/tools.mjs 的 registry 键数（P1 计划记 21）')
  assert.equal(r.names.length, 21, `两路并集必须仍是 21（不等就是某一路多了/少了工具），实测 ${r.names.join(',')}`)
  for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'TodoWrite',
    'WebFetch', 'WebSearch', 'OCR', 'Vision', 'Skill', 'MemorySearch', 'KnowledgeSearch',
    'KnowledgeImport', 'KnowledgeDelete', 'SkillSearch', 'Workflow', 'Browser']) {
    assert.ok(r.names.includes(t), `真仓工具 ${t} 必须提取到`)
  }
  // 指纹：结构相同者必须相同、不同者必须不同（逐条 8 位十六进制）
  const fps = r.names.map((n) => r.shapeOf(n))
  assert.equal(fps.every((f) => /^[0-9a-f]{8}$/.test(f)), true, `每个工具都要有结构指纹，实测 ${JSON.stringify(r.names.map((n) => [n, r.shapeOf(n)]))}`)
  assert.equal(r.shapeOf('Bash') === r.shapeOf('Glob'), false, 'Bash 与 Glob 的入参结构不同')
  const wf = r.sources.find((s) => s.id === 'workflow')
  assert.equal(wf.present, true)
  assert.ok(wf.schemaSites.length >= 1)
  assert.equal(r.sources.find((s) => s.id === 'wire').file, 'kernel/api.mjs',
    'tools → wire 的映射在 kernel/api.mjs（出网时按 {name,description,input_schema} 打包）')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ 批 F（2026-09-19）：指纹从"只有顶层"扩到**递归** —— 专测敏感度与边界
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 批 F 夹具：只有 `Shape` 一个工具的最小仓。
 * ★ 设计要点：`tag`/`count`/`note` 三个 prop **恒在**（参数只改它们的**字段值**）——
 * 这样"改了 description ⇒ 指纹不变"才是在测"散文不入指纹"，而不是在测"新增属性"。
 * 每种变化只动一处 ⇒ "变/不变"能唯一定位到那个维度。
 */
function shapeFixture(o = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-ct-shape-'))
  const write = (rel, content) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), content) }
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: o.enumValues || ['fast', 'slow'] },
      paths: { type: 'array', items: { type: 'string', enum: o.itemsEnum || ['a', 'b'] } },
      nested: { type: 'object', properties: { [o.nestedKey || 'deep']: { type: 'string' } } },
      tag: { type: 'string', pattern: o.pattern || "^[a-z]+[0-9]*" },
      count: { type: 'number', default: o.defaultValue === undefined ? 1 : o.defaultValue },
      note: { type: 'string', description: o.prose || '甲' },
      ...(o.withUncovered ? { blob: { oneOf: [{ type: 'string' }, { type: 'number' }] } } : {}),
    },
    required: ['mode'],
  }
  write('kernel/tools.mjs', [
    'export function createToolRegistry({ cwd } = {}) {',
    '  return {',
    '    toolSchemas: () => [',
    `      { name: 'Shape', description: 'shape probe', input_schema: ${JSON.stringify(schema)} },`,
    '    ],',
    '  }',
    '}',
    '',
  ].join('\n'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return { root }
}

/** `Shape` 的指纹（夹具只有它） */
async function shapeFp(o) {
  const r = await extractTools({ root: shapeFixture(o).root })
  return r.shapeOf('Shape')
}

test('★批 F① `enum` 是结构：加/减取值必变指纹；**换顺序绝不 变**（集合语义 ⇒ 书写次序不是契约）', async () => {
  const base = await shapeFp({})
  assert.match(base, /^[0-9a-f]{8}$/)
  assert.notEqual(await shapeFp({ enumValues: ['fast', 'slow', 'auto'] }), base,
    '`enum` 多一个取值必须变 —— 否则"枚举悄悄放宽"无人发现（批 F 前的实际漏洞）')
  assert.notEqual(await shapeFp({ enumValues: ['fast'] }), base, '`enum` 少一个取值也必须变')
  assert.equal(await shapeFp({ enumValues: ['slow', 'fast'] }), base,
    '**换顺序不变** —— 指纹比的是取值**集合**，不是书写次序（否则改顺序即红 = 噪声门禁）')
})

test('★批 F② `items` 与**嵌套** `properties` 递归入指纹（批 F 前只取顶层 ⇒ 这两类漂移全漏）', async () => {
  const base = await shapeFp({})
  assert.notEqual(await shapeFp({ itemsEnum: ['a', 'b', 'c'] }), base, '`items.enum` 变必须变（数组元素约束）')
  assert.notEqual(await shapeFp({ nestedKey: 'deeper' }), base,
    '**嵌套** `properties` 里的字段改名必须变（此前完全不在指纹内；对象入参的第二层正是最容易漂移的地方）')
})

test('★批 F③ `pattern`/`format` 入指纹；散文与默认值**绝不**入', async () => {
  const base = await shapeFp({})
  assert.notEqual(await shapeFp({ pattern: "^[A-Z]+[0-9]*" }), base,
    '`pattern` 是调用方要照着构造入参的取值约束 ⇒ 属"输入形状"')
  assert.equal(await shapeFp({ prose: '完全换一段散文' }), base,
    '改 prop 的 `description` 绝不 变（否则改文案即红 = 噪声门禁，反例 ⑩）')
  assert.equal(await shapeFp({ defaultValue: 999 }), base,
    '改 `default` 不变 —— 默认值属**行为**不属**形状**（已在 README 边界说明里写明）')
})

test('★批 F④ 关键字**守卫**：真仓工具 schema 出现"结构类关键字"却未被指纹覆盖 ⇒ 直接失败（逼后来者显式决定，不许静默漏判）', async () => {
  // 本函数纳入的键（改这里就必须同步 README 边界说明 + §12 的 21 个指纹 + `npm run kit:sync`）
  const COVERED = new Set(['type', 'enum', 'items', 'properties', 'required', 'additionalProperties', 'pattern', 'format'])
  // 明确**不纳入**且**允许存在**（都要在 README 写明理由：散文/展示、数值范围、默认值）
  const EXEMPT = new Set(['description', 'title', 'examples', 'default', 'minimum', 'maximum',
    'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
    'uniqueItems', 'multipleOf', 'deprecated', 'readOnly', 'writeOnly'])
  // ★ Windows 下 ESM 动态 import 必须用 file:// URL（`join()` 出来的 `C:\…` 会被判为非法 scheme）
  const { createToolRegistry } = await import(pathToFileURL(join(ROOT, 'kernel/tools.mjs')).href)
  // 这些键的值是"**名字 → schema**"映射（名字是参数名/定义名，**不是** schema 关键字）⇒ 只递归其值
  const NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
  const seen = new Set()
  const walk = (n, isNameMap = false) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const x of n) walk(x, false); return }
    for (const k of Object.keys(n)) {
      if (isNameMap) { walk(n[k], false); continue }
      if (NAME_MAPS.has(k)) { walk(n[k], true); continue }
      seen.add(k)
      walk(n[k], false)
    }
  }
  for (const s of createToolRegistry({ cwd: ROOT }).toolSchemas()) walk(s.input_schema)
  const uncovered = [...seen].filter((k) => !COVERED.has(k) && !EXEMPT.has(k)).sort()
  assert.deepEqual(uncovered, [],
    `真仓出现未覆盖的 schema 关键字：${uncovered.join(', ')} —— 要么纳入指纹（并同步 README + §12 指纹 + kit:sync），要么加进 EXEMPT 并写明理由`)
  // 反向自证：守卫**真会**抓到未覆盖关键字（否则它是恒真断言）
  const probe = await shapeFp({ withUncovered: true })
  assert.match(probe, /^[0-9a-f]{8}$/, '带 `oneOf` 的夹具能正常出指纹')
  assert.equal(await shapeFp({ withUncovered: true }), probe, '`oneOf` 目前**不**入指纹（= 未覆盖）')
  assert.notEqual(probe, await shapeFp({}), '`oneOf` 的**存在**也不改变指纹 ⇒ 它确实是"未被覆盖"的维度，上面那条守卫不是空转')
})
