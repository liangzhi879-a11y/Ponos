// kernel-tests/atlas-inject.test.mjs —— P1.1：settings、主/lane 注入、工具面与仪表
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolveAtlasSettings, buildAtlasBlock } from '../kernel/atlas/inject.mjs'
import { buildAtlas, clearAtlasLoadCache, loadAtlas } from '../kernel/atlas/store.mjs'
import { loadAtlasConfig, resolveAtlasDir } from '../kernel/atlas/config.mjs'
import { composeSystemPrompt, withLaneAtlasPrompt } from '../kernel/prompt.mjs'
import { createToolRegistry } from '../kernel/tools.mjs'
import { classifyTool } from '../kernel/approval-mode.mjs'
import { getAtlasStats, resetAtlasStats } from '../kernel/inject-ledger.mjs'
import { getInjectStats, resetInjectStats } from '../kernel/knowledge-inject.mjs'
import { tempDir } from './atlas-test-helpers.mjs'

function write(root, rel, text) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** 显式构建：注入面已不再自动构建，测试必须先走真实构建入口。 */
function buildCache(root, configDir, env = {}) {
  const cfg = loadAtlasConfig(root, { env })
  const dir = resolveAtlasDir(root, { env, configDir }).dir
  return buildAtlas({ root, config: cfg, dir, write: true })
}

function setup(t) {
  const root = tempDir('atlas-inject-')
  // 缓存目录必须放在工作区**之外**：放根内会在第二次构建时把 nodes.json 当源文件扫进来。
  const configDir = tempDir('atlas-inject-cfg-')
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(configDir, { recursive: true, force: true })
  })
  write(root, 'alpha.mjs', '// alpha 职责：演示入口\n// 第二行\n// 第三行\nexport const a = 1\n')
  write(root, 'beta.mjs', "// beta 消费 alpha\nimport { a } from './alpha.mjs'\nexport const b = a\n")
  write(root, 'docs/guide.md', '# 使用指南\n\n说明。\n')
  write(root, 'widget.h', 'class Widget {};\n')
  write(root, 'widget.cc', '#include "widget.h"\nclass WidgetImpl : public Widget {};\n')
  return { root, configDir }
}

test('resolveAtlasSettings：默认启用/4096/2048，env > settings，非法预算回落默认', () => {
  assert.deepEqual(resolveAtlasSettings({ settings: null, env: {} }), {
    enabled: true,
    injectEnabled: true,
    injectMaxBytes: 4096,
    laneInjectMaxBytes: 2048,
  })
  assert.equal(resolveAtlasSettings({ settings: { atlas: { enabled: false } }, env: {} }).enabled, false)
  // 四臂消融的 tool-only：工具仍可用，只关掉系统提示里的地图块。
  const toolOnly = resolveAtlasSettings({ settings: { atlas: { inject: false } }, env: {} })
  assert.equal(toolOnly.enabled, true)
  assert.equal(toolOnly.injectEnabled, false)
  assert.equal(resolveAtlasSettings({ settings: null, env: { PONOS_ATLAS_INJECT: '0' } }).injectEnabled, false)
  assert.equal(resolveAtlasSettings({ settings: null, env: { PONOS_ATLAS_ENABLED: '0', PONOS_ATLAS_INJECT: '1' } }).injectEnabled, false, '总开关关闭时注入不许被单独打开')
  assert.equal(resolveAtlasSettings({ settings: { atlas: { injectMaxBytes: 1234 } }, env: {} }).injectMaxBytes, 1234)
  // env 覆盖 settings（含"settings 关、env 开"）
  assert.equal(resolveAtlasSettings({ settings: { atlas: { enabled: false } }, env: { PONOS_ATLAS_ENABLED: '1' } }).enabled, true)
  assert.equal(resolveAtlasSettings({ settings: { atlas: { injectMaxBytes: 1234 } }, env: { PONOS_ATLAS_INJECT_MAX_BYTES: '2048' } }).injectMaxBytes, 2048)
  // 0/负数/非数字不能被理解成"不注入"
  assert.equal(resolveAtlasSettings({ settings: null, env: { PONOS_ATLAS_INJECT_MAX_BYTES: '0' } }).injectMaxBytes, 4096)
  assert.equal(resolveAtlasSettings({ settings: null, env: { PONOS_ATLAS_LANE_INJECT_MAX_BYTES: 'abc' } }).laneInjectMaxBytes, 2048)
})

test('★ buildAtlasBlock 只读快照：无缓存不构建、不创建缓存目录（防初始化假死）', (t) => {
  const { root, configDir } = setup(t)
  const r = buildAtlasBlock({ root, env: {}, configDir, budget: 4096 })
  assert.equal(r.enabled, true)
  assert.equal(r.injectEnabled, true)
  assert.equal(r.text, '', '没有快照时应注入空串')
  assert.equal(r.bytes, 0)
  assert.equal(r.atlas?.ok, false, '应明确报告没有可用快照')
  assert.equal(fs.existsSync(path.join(configDir, 'atlas')), false, '注入路径不得创建/构建缓存')
})

test('buildAtlasBlock：主/lane 各自预算内，含地图与下钻提示；关闭/空工作区为空串', (t) => {
  const { root, configDir } = setup(t)
  resetAtlasStats()
  // 注入不再隐式构建：先走显式构建入口，再验证注入只读快照。
  buildCache(root, configDir)
  const main = buildAtlasBlock({ root, env: {}, configDir, budget: 4096 })
  assert.equal(main.enabled, true)
  assert.ok(main.bytes > 0)
  assert.ok(main.bytes <= 4096)
  assert.match(main.text, /【项目地图】/)
  assert.match(main.text, /ProjectAtlas\(op=find\|card\|impact\)/)
  assert.match(main.text, /alpha\.mjs/)

  const lane = buildAtlasBlock({ root, env: {}, configDir, budget: 512, lane: true })
  assert.ok(lane.bytes > 0 && lane.bytes <= 512, `lane bytes=${lane.bytes}`)
  assert.match(lane.text, /【项目地图】/)

  const stats = getAtlasStats()
  assert.equal(stats.builds, 1, '只有显式构建计数；注入不得再触发构建')
  assert.ok(stats.injectBytes >= main.bytes + lane.bytes, '注入字节应累加')
  assert.deepEqual(getInjectStats().atlas, getAtlasStats(), 'getInjectStats().atlas 与注入总账同源')

  const off = buildAtlasBlock({ root, env: {}, settings: { atlas: { enabled: false } } })
  assert.equal(off.enabled, false)
  assert.equal(off.text, '')

  // tool-only 臂：注入块为空，但总开关与工具面不受影响。
  const toolOnly = buildAtlasBlock({ root, env: { PONOS_ATLAS_INJECT: '0' }, settings: null })
  assert.equal(toolOnly.enabled, true)
  assert.equal(toolOnly.injectEnabled, false)
  assert.equal(toolOnly.text, '')
  assert.equal(toolOnly.bytes, 0)

  const empty = tempDir('atlas-inject-empty-')
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }))
  const none = buildAtlasBlock({ root: empty, env: {}, configDir: path.join(empty, '.cfg') })
  assert.equal(none.text, '', '空工作区不产生注入块')
})

test('buildAtlasBlock：meta 快路径不读大文件，源文件变化也不在注入路径重建', (t) => {
  const { root, configDir } = setup(t)
  const built = buildCache(root, configDir)
  assert.ok(built.nodes.length > 0, '显式构建应产生节点')
  const first = buildAtlasBlock({ root, env: {}, configDir, budget: 4096 })
  assert.equal(first.enabled, true)
  assert.ok(first.bytes > 0)
  assert.equal(first.atlas?.metaOnly, true)
  assert.equal(first.atlas?.built, false)

  // 源文件变化后只读快照仍返回同一 buildId：注入路径没有 verify/rebuild。
  const buildId = first.atlas.meta.buildId
  write(root, 'alpha.mjs', '// 注入路径不应读取这个变化\nexport const a = 2\n')
  const afterChange = buildAtlasBlock({ root, env: {}, configDir, budget: 4096 })
  assert.equal(afterChange.atlas?.meta?.buildId, buildId)
  assert.equal(afterChange.text, first.text)

  clearAtlasLoadCache()
  // 只需 meta.json：删掉 nodes.json 不影响注入（证明快路径没有读大文件）
  fs.rmSync(path.join(first.atlas.dir, 'nodes.json'))
  const second = buildAtlasBlock({ root, env: {}, configDir, budget: 4096 })
  assert.equal(second.enabled, true)
  assert.equal(second.text, first.text, '预计算 L1 的截断结果应与现场渲染逐字一致')
  assert.equal(second.atlas.metaOnly, true)
  assert.equal(second.atlas.built, false)
  assert.equal(second.atlas.nodes, undefined)
})

test('composeSystemPrompt：任务模式注入 Atlas，chat 模式不注入；lane 拼接不产生空段', () => {
  resetInjectStats()
  const task = composeSystemPrompt({
    toolNames: ['Read', 'ProjectAtlas'],
    agents: [],
    subagents: [],
    atlas: '【项目地图】测试块',
  })
  assert.match(task, /【项目地图】测试块/)

  const chat = composeSystemPrompt({
    toolNames: ['KnowledgeSearch'],
    mode: 'chat',
    atlas: '【项目地图】测试块',
  })
  assert.doesNotMatch(chat, /【项目地图】/)

  assert.equal(withLaneAtlasPrompt('base', ''), 'base')
  assert.equal(withLaneAtlasPrompt('base', '   '), 'base')
  assert.equal(withLaneAtlasPrompt('base', '【项目地图】L'), 'base\n\n【项目地图】L')
})

test('ProjectAtlas 工具：schema 可见、只读分类、八个 op、查询不自动构建', (t) => {
  const { root, configDir } = setup(t)
  const tools = createToolRegistry({ cwd: root })
  assert.ok(tools.toolNames.includes('ProjectAtlas'))
  const schema = tools.toolSchemas().find((s) => s.name === 'ProjectAtlas')
  assert.ok(schema, 'toolSchemas 必须包含 ProjectAtlas')
  assert.deepEqual(schema.input_schema.required, ['op'])
  assert.deepEqual(schema.input_schema.properties.op.enum, ['overview', 'find', 'search', 'card', 'impact', 'related', 'path', 'build'])
  assert.equal(classifyTool('ProjectAtlas'), 'read', '只读工具应进 READ_TOOLS（任何档位自动放行）')

  tools.setAtlasOptions({ root, configDir })
  const run = (input) => tools.registry.ProjectAtlas.run(input)

  // 没有快照时查询只给提示，不构建（这是 11k 文件初始化假死的直接回归测试）。
  const cold = run({ op: 'overview' })
  assert.equal(cold.isError, false)
  assert.match(cold.content, /查询不会自动构建/)
  assert.match(cold.content, /op=build/)
  assert.equal(fs.existsSync(path.join(configDir, 'atlas')), false, '查询不得创建缓存')

  const built = run({ op: 'build' })
  assert.equal(built.isError, false)
  assert.match(built.content, /构建完成/)
  assert.match(built.content, /范围：全工作区/)

  const overview = run({ op: 'overview' })
  assert.equal(overview.isError, false)
  assert.match(overview.content, /Atlas · /)

  const found = run({ op: 'find', query: 'alpha' })
  assert.equal(found.isError, false)
  assert.match(found.content, /alpha\.mjs/)

  // search：正文命中（find 做不到的“这行字在哪”），filesOnly 只回文件清单
  const searched = run({ op: 'search', query: 'alpha' })
  assert.equal(searched.isError, false)
  assert.match(searched.content, /Atlas 内容检索 · alpha/)
  assert.match(searched.content, /alpha\.mjs:1:/)
  const filesOnly = run({ op: 'search', query: 'alpha', filesOnly: true })
  assert.match(filesOnly.content, /alpha\.mjs（\d+ 处，首处 L\d+）/)
  const scoped = run({ op: 'search', query: '说明', path: 'docs' })
  assert.match(scoped.content, /docs\/guide\.md:3:/)
  assert.equal(run({ op: 'search' }).isError, true, 'search 缺 query 应报错')

  const card = run({ op: 'card', id: 'alpha.mjs' })
  assert.equal(card.isError, false)
  assert.match(card.content, /导出：a/)

  const impact = run({ op: 'impact', id: 'alpha.mjs' })
  assert.equal(impact.isError, false)
  assert.match(impact.content, /beta\.mjs/)

  const related = run({ op: 'related', id: 'alpha.mjs' })
  assert.equal(related.isError, false)
  assert.match(related.content, /beta\.mjs/)

  // C++ 的引号 #include 已建边：card/impact/related 直接给出真实依赖。
  const cppCard = run({ op: 'card', id: 'widget.h' })
  assert.match(cppCard.content, /被依赖（1）：widget\.cc/)
  assert.doesNotMatch(cppCard.content, /#include 结构边尚未解析/)
  const cppImpact = run({ op: 'impact', id: 'widget.h' })
  assert.match(cppImpact.content, /#include 实现（1）：widget\.cc/)
  assert.doesNotMatch(cppImpact.content, /不代表/)
  const cppRelated = run({ op: 'related', id: 'widget.h' })
  assert.match(cppRelated.content, /widget\.cc/)
  assert.doesNotMatch(cppRelated.content, /#include 结构边尚未解析/)

  const pathRes = run({ op: 'path', id: 'beta.mjs', query: 'alpha.mjs' })
  assert.equal(pathRes.isError, false)
  assert.match(pathRes.content, /alpha\.mjs/)

  assert.equal(run({ op: 'nope' }).isError, true)
  assert.equal(run({ op: 'find' }).isError, true, 'find 缺 query/过滤条件应报错')

  tools.setAtlasOptions({ enabled: false })
  const off = run({ op: 'overview' })
  assert.equal(off.isError, false, '关闭 Atlas 不应表现为工具失败')
  assert.match(off.content, /未启用/)
})

test('ProjectAtlas build path=...：只建子范围，查询按 path 命中范围快照', (t) => {
  const { root, configDir } = setup(t)
  const tools = createToolRegistry({ cwd: root })
  tools.setAtlasOptions({ root, configDir })
  const run = (input) => tools.registry.ProjectAtlas.run(input)
  const fullDir = resolveAtlasDir(root, { env: {}, configDir }).dir

  const built = run({ op: 'build', path: 'docs' })
  assert.equal(built.isError, false)
  assert.match(built.content, /范围：docs/)

  // 构建闸走用户可见路径：超限不是错误（isError=false），而是要求缩范围。
  const tooBig = run({ op: 'build', maxFiles: 1 })
  assert.equal(tooBig.isError, false)
  assert.match(tooBig.content, /超过单次上限 1/)
  assert.match(tooBig.content, /op=build \+ path=/)
  assert.equal(fs.existsSync(path.join(fullDir, 'meta.json')), false, '拒绝时不得写全量缓存')

  // 全量地图仍不存在：范围快照不会被伪装成全量快照。
  const overview = run({ op: 'overview' })
  assert.match(overview.content, /尚无可用索引/)

  const searched = run({ op: 'search', query: '说明', path: 'docs' })
  assert.equal(searched.isError, false)
  assert.match(searched.content, /docs\/guide\.md/)

  // 范围外查询不会误用别的范围缓存。
  const outside = run({ op: 'search', query: 'alpha', path: 'alpha.mjs' })
  assert.match(outside.content, /尚无可用索引/)

  const invalid = run({ op: 'build', path: '../escape' })
  assert.equal(invalid.isError, true)
  assert.match(invalid.content, /path 无效/)
})

test('buildAtlasBlock：PONOS_ATLAS_CONFIG 外仓配置经 env 透传生效', (t) => {
  const { root, configDir } = setup(t)
  const cfgFile = path.join(configDir, 'external-atlas.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ exclude: ['alpha.mjs'], maxFiles: 50 }))
  const cache = path.join(configDir, 'cache')
  const env = { PONOS_ATLAS_CONFIG: cfgFile, PONOS_ATLAS_DIR: cache }
  buildCache(root, null, env)
  const r = buildAtlasBlock({
    root,
    env,
    configDir: null,
    budget: 4096,
  })
  assert.equal(r.enabled, true)
  assert.ok(r.bytes > 0)
  const loaded = loadAtlas(cache)
  assert.equal(loaded.ok, true)
  const paths = loaded.nodes
    .filter((n) => n.kind !== 'domain' && n.kind !== 'layer')
    .map((n) => n.path)
  assert.ok(paths.includes('beta.mjs'), `应索引 beta.mjs：${paths.join(',')}`)
  assert.ok(!paths.includes('alpha.mjs'), '外仓配置的 exclude 应生效')
})
