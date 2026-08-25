// server/skill-search.test.mjs —— SkillSearch 联网技能搜索（注入 fetcher 替身，不触网）
// 覆盖：marketplace.json 双形态解析、粗筛→深挖检索、中文/英文匹配、source 过滤、
//       市场失败容错、marketplace 缓存、limit 生效。
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMarketplace, discoverMarketSkills, searchSkills, setTestFetcher, clearMarketCache,
} from '../kernel/skill-search.mjs'

// ── fixtures ───────────────────────────────────────────────────────────────────
const MP_ANTHROPIC = 'https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json'
const MP_COMMUNITY = 'https://raw.githubusercontent.com/secondsky/claude-skills/main/.claude-plugin/marketplace.json'
const XLSX_URL = 'https://raw.githubusercontent.com/anthropics/skills/main/skills/xlsx/SKILL.md'
const PDF_URL = 'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md'
const API_COMMUNITY = 'https://api.github.com/repos/secondsky/claude-skills/contents/skills'
const UI_URL = 'https://raw.githubusercontent.com/secondsky/claude-skills/main/skills/ui-components/SKILL.md'

const FIXTURE_A = JSON.stringify({
  name: 'test-skills',
  plugins: [{
    name: 'document-skills',
    description: 'Document processing suite: Excel spreadsheet, Word, PowerPoint, PDF capabilities',
    source: './',
    skills: ['./skills/xlsx', './skills/pdf'],
  }],
})
const FIXTURE_B = JSON.stringify({
  name: 'community-test',
  plugins: [
    { name: 'ui-kit', description: 'React UI components for frontend dashboards' },
    { name: 'doc-zh', description: '处理表格和文档转换的中文技能包' },
  ],
})
const FIXTURE_B_LISTING = JSON.stringify([
  { type: 'dir', name: 'ui-components' },
  { type: 'dir', name: 'theming' },
  { type: 'dir', name: '表格处理' },
])
const XLSX_MD = `---
name: xlsx
description: "Create, edit, analyze spreadsheet files (.xlsx, .csv, .tsv)"
triggers:
  - excel
  - spreadsheet
  - csv
---
# XLSX
Handle tabular data with openpyxl / pandas.
`
const PDF_MD = `---
name: pdf
description: "PDF extraction, merging, and form filling"
triggers:
  - pdf
  - extract
---
# PDF
Process PDF documents.
`
const UI_MD = `---
name: ui-components
description: "React components for building dashboards and data tables"
triggers:
  - react
  - ui
---
# UI Components
Build frontend with reusable components.
`
const DOC_MD = `---
name: 表格处理
description: "处理表格、合并 PDF、文档格式转换"
triggers:
  - 表格
  - 处理表格
---
# 表格处理
中文场景的表格与文档处理。
`

const ROUTES = {
  [MP_ANTHROPIC]: FIXTURE_A,
  [MP_COMMUNITY]: FIXTURE_B,
  [XLSX_URL]: XLSX_MD,
  [PDF_URL]: PDF_MD,
  [API_COMMUNITY]: FIXTURE_B_LISTING,
  [UI_URL]: UI_MD,
  ['https://raw.githubusercontent.com/secondsky/claude-skills/main/skills/表格处理/SKILL.md']: DOC_MD,
}

let fetchCount = 0
function fakeFetcher(url, opts) {
  fetchCount++
  const hit = ROUTES[url]
  if (!hit) return Promise.resolve({ ok: false, status: 404, text: '' })
  return Promise.resolve({ ok: true, status: 200, text: hit })
}

beforeEach(() => { fetchCount = 0; clearMarketCache(); setTestFetcher(fakeFetcher) })
afterEach(() => { setTestFetcher(null) })

// ── 解析（形态 A/B） ───────────────────────────────────────────────────────────
test('parseMarketplace 形态 A：skills 数组直接定位技能', () => {
  const { items, error } = parseMarketplace(
    { name: 'anthropic', repoBase: 'https://x/main/' },
    FIXTURE_A,
  )
  assert.equal(error, null)
  assert.equal(items.length, 2)
  const xlsx = items.find((i) => i.name === 'xlsx')
  assert.equal(xlsx.kind, 'direct')
  assert.equal(xlsx.url, 'https://x/main/skills/xlsx/SKILL.md')
  assert.equal(xlsx.plugin, 'document-skills')
  assert.equal(xlsx.source, 'anthropic')
})

test('parseMarketplace 形态 B：目录形态待枚举，skillsUrl 正确', () => {
  const market = { name: 'community', repoBase: 'https://raw/r/', apiBase: 'https://api.github.com/repos/o/r/' }
  const { items, error } = parseMarketplace(market, FIXTURE_B)
  assert.equal(error, null)
  assert.equal(items.length, 2)
  const item = items.find((i) => i.plugin === 'ui-kit')
  assert.equal(item.kind, 'plugin-dir')
  assert.equal(item.name, 'ui-kit')
  assert.equal(item.skillsUrl, 'https://api.github.com/repos/o/r/contents/skills')
  assert.equal(item.url, '')
})

// ── 检索 ──────────────────────────────────────────────────────────────────────
test('searchSkills：英文关键词命中技能（粗筛→深挖精化）', async () => {
  const { results, failed, error } = await searchSkills({ query: 'spreadsheet' })
  assert.equal(error, undefined)
  assert.equal(failed.length, 0)
  assert.ok(results.length >= 1, `应命中至少 1 条，实际 ${results.length}`)
  const top = results[0]
  assert.equal(top.name, 'xlsx')
  assert.equal(top.source, 'anthropic')
  assert.equal(top.url, XLSX_URL)
  assert.ok(top.triggers.includes('spreadsheet'), `triggers 应含 spreadsheet，实际 ${JSON.stringify(top.triggers)}`)
})

test('searchSkills：中文关键词命中', async () => {
  // 中文「表格」在 xlsx 的 description 无，但 plugin.description（spreadsheet）无中文；
  // 用「处理」应命中 document-skills 插件（description 含 Document processing）→ 深挖 xlsx/pdf
  const { results } = await searchSkills({ query: '处理表格' })
  assert.ok(results.length >= 1, `中文检索应命中，实际 ${results.length}`)
})

test('searchSkills：source 过滤只查指定市场', async () => {
  const { results } = await searchSkills({ query: 'spreadsheet', source: 'anthropic' })
  assert.ok(results.length >= 1)
  for (const r of results) assert.equal(r.source, 'anthropic')
})

test('searchSkills：limit 生效', async () => {
  const { results } = await searchSkills({ query: 'document', limit: 1 })
  assert.ok(results.length <= 1)
})

test('searchSkills：无匹配返回提示而非报错', async () => {
  const { results, error } = await searchSkills({ query: '量子物理不存在词xyzzy' })
  assert.equal(results.length, 0)
  assert.match(String(error), /未在技能市场找到/)
})

test('searchSkills：缺 query 拒绝', async () => {
  const { error } = await searchSkills({})
  assert.equal(error, 'query 参数缺失')
})

// ── 容错与缓存 ────────────────────────────────────────────────────────────────
test('市场拉取失败容错：单源失败不阻断，failed 如实记录', async () => {
  const broken = (url, opts) => {
    fetchCount++
    if (url === MP_ANTHROPIC) return Promise.resolve({ ok: false, status: 500, text: '' })
    return fakeFetcher(url, opts)
  }
  setTestFetcher(broken)
  const { results, failed } = await searchSkills({ query: 'react' })
  assert.ok(failed.some((f) => f.source === 'anthropic'), 'failed 应记录 anthropic')
  assert.ok(results.length >= 1, 'community 市场应仍返回结果')
  assert.equal(results[0].source, 'community')
})

test('marketplace 缓存：重复调用只拉一次', async () => {
  await discoverMarketSkills()
  const afterFirst = fetchCount
  await discoverMarketSkills()
  assert.equal(fetchCount, afterFirst, '第二次调用应命中缓存，不重复拉取 marketplace')
})
