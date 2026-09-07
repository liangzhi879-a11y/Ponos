// kernel/skill-search.mjs —— 联网技能搜索（SkillSearch 工具执行体）
// ---------------------------------------------------------------------------
// 检索 Claude Code marketplace 生态（Anthropic 官方 + 社区市场）中的技能，
// 返回技能名/描述/触发词/来源/SKILL.md 地址。只读检索，不安装、不落盘。
//
// marketplace.json 两种形态（同一事实标准）：
//   A. skills 数组形态（anthropics/skills）：plugin.skills = [相对路径]，直接定位技能
//   B. 目录形态（secondsky/claude-skills 等社区市场）：无 skills 字段，技能在
//      plugin.source/skills/<name>/SKILL.md（经 GitHub API contents 枚举）
//
// 零依赖：node:https（与 tools.mjs fetchUrl 同风格）；parseFrontmatter 复用 skills.mjs。
// 网络策略：marketplace.json 缓存 10 分钟；粗筛（plugin name/description）零成本先行，
// 仅对命中的 top-K 候选做 SKILL.md 深挖，控制请求预算。
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { parseFrontmatter, parseYamlList } from './skills.mjs'

// ── 数据源表 ──────────────────────────────────────────────────────────────────
// env 扩展：PONOS_SKILL_MARKETS="name=url@repoBase,name2=url2@repoBase2"（追加/覆盖同名）
const BUILTIN_MARKETS = [
  {
    name: 'anthropic',
    label: 'Anthropic 官方',
    url: 'https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json',
    repoBase: 'https://raw.githubusercontent.com/anthropics/skills/main/',
  },
  {
    name: 'community',
    label: '社区 claude-skills',
    url: 'https://raw.githubusercontent.com/secondsky/claude-skills/main/.claude-plugin/marketplace.json',
    repoBase: 'https://raw.githubusercontent.com/secondsky/claude-skills/main/',
    apiBase: 'https://api.github.com/repos/secondsky/claude-skills/',
  },
]

const MARKET_TTL = 10 * 60 * 1000 // marketplace.json 缓存 10 分钟
const SEARCH_BUDGET_MS = 25_000 // 单次搜索总预算
const CONCURRENCY = 6 // 技能深挖并发
const MAX_DIG = 15 // 深挖候选上限（粗筛 top-K）
const SKILL_MD_MAX = 16 * 1024 // 每个 SKILL.md 拉取上限（frontmatter+头部）

// ── 测试钩子：可注入 fetcher 替身（单测不触网） ────────────────────────────────
let fetcher = fetchText
export function setTestFetcher(fn) { fetcher = fn || fetchText }
export function clearMarketCache() { marketCache.clear() }

// ── 零依赖 HTTP 抓取（node:https，与 tools.mjs fetchUrl 同风格） ──────────────
export function fetchText(url, { timeoutMs = 8000, maxBytes = 64 * 1024 } = {}) {
  return new Promise((resolvePromise) => {
    let u
    try { u = new URL(String(url || '')) } catch { return resolvePromise({ ok: false, status: 0, text: '' }) }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return resolvePromise({ ok: false, status: 0, text: '' })
    const mod = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = mod(u, {
      method: 'GET',
      headers: { 'user-agent': 'Ponos-turbo/0.1', accept: 'application/json,text/plain,*/*' },
    }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        let next
        try { next = new URL(String(res.headers.location), u) } catch { return resolvePromise({ ok: false, status, text: '' }) }
        return resolvePromise(fetchText(next.toString(), { timeoutMs, maxBytes }))
      }
      const chunks = []
      let size = 0
      res.on('data', (d) => {
        size += d.length
        if (size > maxBytes) { req.destroy(); return resolvePromise({ ok: false, status, text: '' }) }
        chunks.push(d)
      })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        resolvePromise({ ok: status >= 200 && status < 300, status, text })
      })
    })
    req.on('error', () => resolvePromise({ ok: false, status: 0, text: '' }))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolvePromise({ ok: false, status: 0, text: '' }) })
    req.end()
  })
}

// ── 路径工具 ──────────────────────────────────────────────────────────────────
// posixJoin 只处理仓库相对路径（'/' 分隔，去空段与 '.'，不去 '..'）；URL 拼接单独处理
function posixJoin(...parts) {
  const segs = []
  for (const p of parts) {
    for (const seg of String(p || '').replace(/\\/g, '/').split('/')) {
      if (!seg || seg === '.') continue
      segs.push(seg)
    }
  }
  return segs.join('/')
}
// SKILL.md raw URL：repoBase（以 / 结尾的 https 根）+ 相对目录
function rawUrl(repoBase, relDir) {
  const dir = posixJoin(relDir)
  if (!dir) return ''
  return String(repoBase).replace(/\/+$/, '') + '/' + dir + '/SKILL.md'
}
function basenamePosix(p) { return String(p).replace(/\/+$/, '').split('/').pop() || String(p) }

function resolveMarkets() {
  const byName = new Map()
  for (const m of BUILTIN_MARKETS) byName.set(m.name, m)
  const env = process.env.PONOS_SKILL_MARKETS || ''
  for (const seg of env.split(',')) {
    const s = seg.trim()
    if (!s || !s.includes('=')) continue
    const eq = s.indexOf('=')
    const name = s.slice(0, eq).trim()
    const at = s.indexOf('@')
    const url = (at >= 0 ? s.slice(eq + 1, at) : s.slice(eq + 1)).trim()
    const repoBase = at >= 0 ? s.slice(at + 1).trim() : ''
    if (name && url) byName.set(name, { name, label: name, url, repoBase })
  }
  return [...byName.values()]
}

// ── marketplace.json 解析（双形态） ────────────────────────────────────────────
export function parseMarketplace(market, jsonText) {
  let mp
  try { mp = JSON.parse(String(jsonText || '')) } catch { return { items: [], error: 'marketplace.json 解析失败' } }
  const plugins = Array.isArray(mp.plugins) ? mp.plugins : []
  const items = []
  for (const p of plugins) {
    if (!p || typeof p !== 'object' || !p.name) continue
    const pluginName = String(p.name)
    const description = String(p.description || '').slice(0, 300)
    if (Array.isArray(p.skills) && p.skills.length) {
      // 形态 A：skills 数组 → 每个技能路径直接定位
      for (const sp of p.skills) {
        const dir = posixJoin(p.source || '.', String(sp))
        if (!dir) continue
        items.push({
          source: market.name, sourceLabel: market.label, plugin: pluginName,
          name: basenamePosix(dir), description,
          kind: 'direct', url: rawUrl(market.repoBase, dir),
        })
      }
    } else {
      // 形态 B：目录形态 → 技能在 <source>/skills/<name>/SKILL.md，待 contents API 枚举
      const srcDir = posixJoin(p.source || '.')
      items.push({
        source: market.name, sourceLabel: market.label, plugin: pluginName,
        name: pluginName, description,
        kind: 'plugin-dir', url: '',
        repoBase: market.repoBase,
        sourceDir: srcDir || '.',
        skillsUrl: market.apiBase
          ? `${String(market.apiBase).replace(/\/+$/, '')}/contents${srcDir ? '/' + srcDir : ''}/skills`
          : '',
      })
    }
  }
  return { items, error: null }
}

// ── 市场列表拉取（缓存） ──────────────────────────────────────────────────────
const marketCache = new Map() // url -> { ts, items }
export async function discoverMarketSkills({ sources } = {}) {
  const markets = resolveMarkets()
  const want = sources ? markets.filter((m) => sources.split(',').map((s) => s.trim()).includes(m.name)) : markets
  const skills = []
  const failed = []
  for (const market of want) {
    const cached = marketCache.get(market.url)
    if (cached && Date.now() - cached.ts < MARKET_TTL) { skills.push(...cached.items); continue }
    // 社区市场 marketplace.json 可达 80KB+（GitHub raw CDN 首连慢），超时放宽 + 失败重试 1 次
    let r = await fetcher(market.url, { timeoutMs: 20000, maxBytes: 3 * 1024 * 1024 })
    if (!r.ok) r = await fetcher(market.url, { timeoutMs: 20000, maxBytes: 3 * 1024 * 1024 })
    if (!r.ok) { failed.push({ source: market.name, reason: `marketplace 拉取失败（HTTP ${r.status}）` }); continue }
    const { items, error } = parseMarketplace(market, r.text)
    if (error) { failed.push({ source: market.name, reason: error }); continue }
    marketCache.set(market.url, { ts: Date.now(), items })
    skills.push(...items)
  }
  return { skills, failed }
}

// ── 关键词分词（英文 token + 中文短语） ──────────────────────────────────────
function tokenize(q) {
  const s = String(q || '').toLowerCase().trim()
  if (!s) return []
  const ascii = s.match(/[a-z0-9][a-z0-9+\-._]{1,}/g) || []
  const cjk = s.match(/[\u4e00-\u9fff]{2,}/g) || []
  return [...new Set([...ascii, ...cjk])].filter((t) => t.length >= 2)
}

// 轻量同义词扩展（双向）：官方技能常缺 triggers、description 用词与用户查询不同，
// 字面匹配会漏检（如 'excel' → xlsx 的 description 只有 'spreadsheet'）。扩展后参与打分。
const SYNONYMS = {
  excel: ['spreadsheet', 'xlsx', 'csv', '表格'],
  spreadsheet: ['excel', 'xlsx', 'csv', '表格'],
  xlsx: ['excel', 'spreadsheet', 'csv', '表格'],
  csv: ['excel', 'spreadsheet', '表格'],
  pdf: ['document', 'extract', '文档'],
  docx: ['word', 'document', '文档'],
  pptx: ['powerpoint', 'slide', 'presentation', '演示'],
  word: ['docx', 'document', '文档'],
  react: ['frontend', 'ui', 'reactjs', '前端'],
  frontend: ['ui', 'react', 'reactjs', '前端'],
  ui: ['frontend', 'react', '界面'],
  前端: ['ui', 'react', 'frontend', 'web'],
  python: ['py', '脚本'],
  shell: ['bash', 'command', '命令'],
  bash: ['shell', 'command', '命令'],
  git: ['版本控制', 'repo', '仓库'],
  docker: ['container', '容器'],
  表格: ['excel', 'spreadsheet', 'xlsx', 'csv'],
  文档: ['document', 'pdf', 'word', 'docx'],
  表格处理: ['excel', 'spreadsheet', 'csv'],
  演示: ['pptx', 'powerpoint', 'slide'],
}
function expandTokens(tokens) {
  const out = new Set(tokens)
  for (const t of tokens) for (const s of SYNONYMS[t] || []) out.add(s)
  return [...out]
}

// 粗筛打分：name 3 分 / triggers 2 分 / description 1 分（substring 匹配）
function coarseScore(item, tokens) {
  const name = String(item.name || '').toLowerCase()
  const desc = String(item.description || '').toLowerCase()
  let score = 0
  for (const t of tokens) {
    if (name.includes(t)) score += 3
    if (desc.includes(t)) score += 1
  }
  return score
}
function fineScore(name, triggers, description, tokens) {
  const n = String(name || '').toLowerCase()
  const d = String(description || '').toLowerCase()
  const tr = (Array.isArray(triggers) ? triggers : []).map((x) => String(x).toLowerCase())
  let score = 0
  for (const t of tokens) {
    if (n.includes(t)) score += 3
    if (tr.some((x) => x.includes(t) || t.includes(x))) score += 2
    if (d.includes(t)) score += 1
  }
  return score
}

// 深挖单个候选：direct → 探测 SKILL.md；plugin-dir → contents API 枚举子技能
function frontmatterYaml(md) { return String(md || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '' }
function triggersOf(md) { return parseYamlList(frontmatterYaml(md), 'triggers') }

async function digItem(item, tokens) {
  if (item.kind === 'direct') {
    const r = await fetcher(item.url, { timeoutMs: 8000, maxBytes: SKILL_MD_MAX })
    if (!r.ok) return null
    const fm = parseFrontmatter(r.text)
    return {
      ...item, md: r.text,
      score: fineScore(item.name, triggersOf(r.text), fm.description || item.description, tokens),
    }
  }
  // plugin-dir：枚举 <source>/skills/ 子目录
  if (!item.skillsUrl) return null
  const api = await fetcher(item.skillsUrl, { timeoutMs: 8000, maxBytes: 512 * 1024 })
  if (!api.ok) return null
  let listing
  try { listing = JSON.parse(api.text) } catch { return null }
  const subDirs = (Array.isArray(listing) ? listing : []).filter((e) => e.type === 'dir' && e.name).map((e) => e.name)
  if (!subDirs.length) return null
  const results = []
  for (const sub of subDirs) {
    const url = rawUrl(item.repoBase, posixJoin(item.sourceDir, 'skills', sub))
    if (!url) continue
    const r = await fetcher(url, { timeoutMs: 8000, maxBytes: SKILL_MD_MAX })
    if (!r.ok) continue
    const fm = parseFrontmatter(r.text)
    const score = fineScore(sub, triggersOf(r.text), fm.description || item.description, tokens)
    results.push({ ...item, name: sub, url, md: r.text, description: fm.description || item.description, score })
  }
  if (!results.length) return null
  results.sort((a, b) => b.score - a.score)
  return results[0]
}

// ── 主入口：搜索技能 ──────────────────────────────────────────────────────────
export async function searchSkills({ query, limit = 8, source } = {}) {
  const q = String(query || '').trim()
  if (!q) return { results: [], failed: [], error: 'query 参数缺失' }
  const tokens = expandTokens(tokenize(q))
  const lim = Math.min(Math.max(Number(limit) || 8, 1), 20)
  const { skills, failed } = await discoverMarketSkills({ sources: source })
  if (!skills.length) return { results: [], failed, error: failed.length ? '技能市场均不可达' : '无可用技能市场' }

  // 深挖一批候选（并发 + 预算内），返回 score>0 的精化结果
  const digAll = async (list) => {
    if (!list.length) return []
    const deadline = Date.now() + SEARCH_BUDGET_MS
    const dug = []
    let cursor = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
      while (cursor < list.length) {
        const item = list[cursor++]
        if (Date.now() > deadline) break
        try { const r = await digItem(item, tokens); if (r) dug.push(r) } catch { /* 单技能失败跳过 */ }
      }
    })
    await Promise.all(workers)
    return dug.filter((r) => r.score > 0)
  }

  // 第一轮：粗筛（marketplace.json 自带 name/description，零成本）→ 深挖 top-K
  const scored = skills
    .map((s) => ({ s, score: coarseScore(s, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  let merged = await digAll(scored.slice(0, MAX_DIG).map((x) => x.s))
  // 第二轮（精化后仍无有效匹配）：direct 形态技能全量深挖——官方技能的 SKILL.md
  // description 才精确（如 xlsx 的插件级描述不含 'spreadsheet'，粗筛必然漏检）。
  // 成本可控（官方技能数十个 × 16KB）；plugin-dir（社区）不展开防请求失控。
  if (!merged.length) {
    merged = await digAll(skills.filter((s) => s.kind === 'direct').slice(0, 40))
  }
  if (!merged.length) {
    const hint = failed.length ? `（部分来源不可达：${failed.map((f) => f.source).join('、')}）` : ''
    return { results: [], failed, error: `未在技能市场找到与「${q}」匹配的技能${hint}` }
  }
  merged.sort((a, b) => b.score - a.score)
  const results = merged.slice(0, lim).map((r) => ({
    source: r.source, sourceLabel: r.sourceLabel, plugin: r.plugin,
    name: r.name, description: (r.description || '').slice(0, 160),
    triggers: triggersOf(r.md || '').slice(0, 6),
    url: r.url || '', score: r.score,
  }))
  return { results, failed }
}
