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
import { fileURLToPath } from 'node:url'
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
