#!/usr/bin/env node
// kernel/atlas/cli.mjs —— Atlas 命令行（P0：构建/查询/校验）
// ---------------------------------------------------------------------------
// 输出默认是**单个 JSON**（便于脚本/agent 消费）；`--text` 输出注入面同款文本。
// 例：
//   node kernel/atlas/cli.mjs build --root . --force
//   node kernel/atlas/cli.mjs overview --root . --level l1 --text
//   node kernel/atlas/cli.mjs find "聊天 窗口" --root . --kind code --limit 5
//   node kernel/atlas/cli.mjs search "ATLAS_VERSION" --root . --files-only
//   node kernel/atlas/cli.mjs card kernel/knowledge.mjs --root . --text
//   node kernel/atlas/cli.mjs impact shared/atomic-write.mjs --root . --depth 2
//   node kernel/atlas/cli.mjs verify --root .
import path from 'node:path'
import {
  buildAtlas, loadAtlas, loadAtlasMeta, verifyAtlas,
} from './store.mjs'
import {
  overview, find, card, impact, related, pathBetween,
} from './query.mjs'
import { searchContent, renderSearch } from './search.mjs'
import { loadAtlasConfig, resolveAtlasDir } from './config.mjs'

/**
 * 查询命令只读已有快照（与工具面同口径）：不构建、不校验。
 * 没有缓存时返回 ok:false，调用方提示先跑 `build`。
 */
function loadSnapshot(root, { metaOnly = false } = {}) {
  const dir = resolveAtlasDir(root).dir
  const loaded = metaOnly
    ? loadAtlasMeta(dir)
    : loadAtlas(dir, { cacheMB: loadAtlasConfig(root).cacheMB })
  if (!loaded.ok) return { ...loaded, dir, hint: '先用 build 显式构建（大目录加 --scope）' }
  if (path.resolve(loaded.meta.root) !== root) {
    return { ok: false, reason: 'root-mismatch', dir, hint: '缓存属于另一个工作区，请先 build' }
  }
  return { ...loaded, built: false }
}

function parseArgv(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (key === 'force' || key === 'text' || key === 'dry-run' || key === 'debug' || key === 'help' || key === 'json') {
        opts[key] = true
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) opts[key] = true
      else { opts[key] = next; i++ }
    } else {
      opts._.push(a)
    }
  }
  return opts
}

function usage() {
  return [
    '用法：node kernel/atlas/cli.mjs <command> [options]',
    '',
    'command:',
    '  build                      构建/增量更新 Atlas（默认写盘；--scope <相对目录> 只建子树）',
    '  overview                   项目宏观结构（--level l0|l1，默认 l1；查询不自动构建）',
    '  find <query>               按路径/职责/标题/导出检索',
    '  search <query>             正文内容检索（--path 限定目录；--files-only 只列文件）',
    '  card <id|path>             单文件卡',
    '  impact <id|path>           反向影响面（--depth 1..5，默认 3）',
    '  related <id|path>          一跳关联（--limit）',
    '  path <from> <to>           两节点最短关系路径',
    '  verify                     校验索引与工作区是否一致',
    '  stats                      输出 meta/coverage（不重建）',
    '',
    'options:',
    '  --root <dir>               工作区根（默认 cwd）',
    '  --scope <相对目录>         build 只索引子树（缓存独立，不冒充全量）',
    '  --max-build-files <n>      build 抽取上限（默认 10000，超限拒绝）',
    '  --force                    强制全量重建',
    '  --dry-run                  build 不写盘',
    '  --text                     输出文本（overview/card 默认也是文本更可读）',
    '  --json                     强制 JSON（默认）',
    '  --kind code,test,doc,file   find 过滤',
    '  --path <prefix>            search 作用域（目录/文件前缀）',
    '  --files-only               search 只输出文件清单',
    '  --limit <n>                find/impact/related 数量上限',
    '  --depth <n>                impact 深度',
    '  --budget <n>               overview/card 字节预算',
    '  --level l0|l1              overview 层级',
    '  --help                     本帮助',
  ].join('\n')
}

function textForFind(res) {
  if (!res.results?.length) return `未找到：${res.query}`
  return res.results.map((r) => `${r.score}\t${r.path}\t${r.purpose || ''}`).join('\n')
}

function textForImpact(res) {
  if (!res.ok) return `未找到：${res.query}`
  const lines = [`影响 ${res.target.path}：直接 ${res.directDependents} · 传递 ${res.total}（cap ${res.truncated ? '是' : '否'}）`]
  for (const [label, key] of [['依赖方', 'imports'], ['引用方', 'references'], ['测试', 'tests'], ['文档', 'docs']]) {
    const arr = res.direct[key]
    if (arr.length) lines.push(`${label}（${arr.length}）：${arr.map((n) => n.path).join('、')}`)
  }
  for (const t of res.transitive) lines.push(`  ${'  '.repeat(Math.max(0, t.depth - 1))}${t.path}（${t.via}，深度 ${t.depth}）`)
  return lines.join('\n')
}

function textForRelated(res) {
  if (!res.ok) return `未找到：${res.query}`
  return [`关联 ${res.target.path}（${res.total}）`, ...res.results.map((r) => `  ${r.path} — ${r.types.join('/')}`)].join('\n')
}

function textForPath(res) {
  if (!res.ok) return `未找到：${res.from || ''} / ${res.to || ''}`
  if (!res.found) return `无路径：${res.from.path} → ${res.to.path}`
  return res.steps.map((s, i) => `${i === 0 ? '' : '  '}${s.path}${s.via ? `（←${s.via}）` : ''}`).join('\n')
}

function main() {
  const opts = parseArgv(process.argv.slice(2))
  const command = opts._[0]
  const root = path.resolve(opts.root && opts.root !== true ? opts.root : process.cwd())
  const asText = opts.text === true && opts.json !== true

  if (!command || opts.help || command === 'help') {
    process.stdout.write(usage() + '\n')
    return
  }

  if (command === 'build') {
    const scope = typeof opts.scope === 'string' ? opts.scope : ''
    const maxRaw = Number(opts['max-build-files'])
    const res = buildAtlas({
      root,
      config: loadAtlasConfig(root),
      force: opts.force === true,
      write: opts['dry-run'] !== true,
      scope,
      maxBuildFiles: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null,
    })
    if (!res.ok) {
      process.stdout.write(JSON.stringify({ ok: false, op: 'build', ...res }, null, 2) + '\n')
      process.exitCode = 1
      return
    }
    const out = {
      ok: true,
      op: 'build',
      dir: res.dir,
      scope: res.meta.scope || null,
      cacheMode: res.meta.cacheMode,
      meta: {
        buildId: res.meta.buildId,
        createdAt: res.meta.createdAt,
        counts: res.meta.counts,
        incremental: res.meta.incremental,
        timings: res.meta.timings,
        git: res.meta.git,
        truncated: res.meta.truncated,
      },
      summary: res.summary,
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    return
  }

  if (command === 'verify') {
    const res = verifyAtlas({ root })
    process.stdout.write(JSON.stringify({ op: 'verify', ...res }, null, 2) + '\n')
    if (!res.ok) process.exitCode = 1
    return
  }

  if (command === 'stats') {
    const atlas = loadSnapshot(root, { metaOnly: true })
    if (!atlas.ok) {
      process.stdout.write(JSON.stringify({
        ok: false, op: 'stats', dir: atlas.dir, error: `尚无可用索引（${atlas.reason}）`, hint: atlas.hint,
      }, null, 2) + '\n')
      process.exitCode = 1
      return
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      op: 'stats',
      dir: atlas.dir,
      built: false,
      meta: atlas.meta,
      coverage: atlas.meta?.coverage,
      summary: atlas.meta?.summary,
    }, null, 2) + '\n')
    return
  }

  const atlas = loadSnapshot(root)
  if (!atlas.ok) {
    process.stdout.write(JSON.stringify({
      ok: false, op: command, dir: atlas.dir,
      error: `尚无可用索引（${atlas.reason}）`, hint: atlas.hint,
    }, null, 2) + '\n')
    process.exitCode = 1
    return
  }

  if (command === 'overview') {
    const level = opts.level === 'l0' ? 'l0' : 'l1'
    const budget = opts.budget && opts.budget !== true ? Number(opts.budget) : undefined
    const res = overview(atlas, { level, budget })
    if (asText) process.stdout.write(res.text + '\n')
    else process.stdout.write(JSON.stringify({ ok: true, op: 'overview', built: atlas.built, bytes: Buffer.byteLength(res.text), ...res }, null, 2) + '\n')
    return
  }

  if (command === 'find') {
    const query = opts._[1]
    if (!query) throw new Error('find 需要查询词：find <query>')
    const res = find(atlas, query, {
      kind: typeof opts.kind === 'string' ? opts.kind : undefined,
      limit: opts.limit,
    })
    if (asText) process.stdout.write(textForFind(res) + '\n')
    else process.stdout.write(JSON.stringify({ ok: true, op: 'find', built: atlas.built, ...res }, null, 2) + '\n')
    return
  }

  if (command === 'search') {
    const query = opts._[1]
    if (!query) throw new Error('search 需要查询词：search <query>')
    const res = searchContent(atlas, query, {
      path: typeof opts.path === 'string' ? opts.path : undefined,
      filesOnly: opts['files-only'] === true,
      limit: opts.limit,
      config: loadAtlasConfig(root),
    })
    if (asText) process.stdout.write(renderSearch(res) + '\n')
    else process.stdout.write(JSON.stringify({ op: 'search', built: atlas.built, ...res }, null, 2) + '\n')
    if (!res.ok) process.exitCode = 1
    return
  }

  if (command === 'card') {
    const id = opts._[1]
    if (!id) throw new Error('card 需要 id 或路径：card <id|path>')
    const budget = opts.budget && opts.budget !== true ? Number(opts.budget) : undefined
    const res = card(atlas, id, { budget })
    if (asText && res.ok && 'text' in res) process.stdout.write(String(res.text) + '\n')
    else process.stdout.write(JSON.stringify({ op: 'card', built: atlas.built, ...res }, null, 2) + '\n')
    if (!res.ok) process.exitCode = 1
    return
  }

  if (command === 'impact') {
    const id = opts._[1]
    if (!id) throw new Error('impact 需要 id 或路径：impact <id|path>')
    const res = impact(atlas, id, { depth: opts.depth, limit: opts.limit })
    if (asText) process.stdout.write(textForImpact(res) + '\n')
    else process.stdout.write(JSON.stringify({ op: 'impact', built: atlas.built, ...res }, null, 2) + '\n')
    if (!res.ok) process.exitCode = 1
    return
  }

  if (command === 'related') {
    const id = opts._[1]
    if (!id) throw new Error('related 需要 id 或路径：related <id|path>')
    const res = related(atlas, id, { limit: opts.limit })
    if (asText) process.stdout.write(textForRelated(res) + '\n')
    else process.stdout.write(JSON.stringify({ op: 'related', built: atlas.built, ...res }, null, 2) + '\n')
    if (!res.ok) process.exitCode = 1
    return
  }

  if (command === 'path') {
    const from = opts._[1]
    const to = opts._[2]
    if (!from || !to) throw new Error('path 需要两个节点：path <from> <to>')
    const res = pathBetween(atlas, from, to, { maxDepth: opts['max-depth'] || 6 })
    if (asText) process.stdout.write(textForPath(res) + '\n')
    else process.stdout.write(JSON.stringify({ op: 'path', built: atlas.built, ...res }, null, 2) + '\n')
    if (!res.ok) process.exitCode = 1
    return
  }

  throw new Error(`未知命令：${command}\n\n${usage()}`)
}

try {
  main()
} catch (err) {
  const payload = { ok: false, error: err && err.message ? err.message : String(err) }
  if (process.argv.includes('--debug') && err && err.stack) payload.stack = err.stack
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  process.exitCode = 1
}
