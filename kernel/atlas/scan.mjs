// kernel/atlas/scan.mjs —— 工作区文件发现 + 排除清单
// ---------------------------------------------------------------------------
// 口径：git 可见文件 = 已跟踪 + 未跟踪但未被忽略（`git ls-files --cached --others
// --exclude-standard`）。比只读 `--cached` 多覆盖“刚新建、还没提交”的文件 —— agent
// 正在编辑的新文件必须能被地图看到，否则 Atlas 在真实任务里会失明。
// 非 git 工作区退回目录遍历；符号链接一律不跟随（不越出工作区）。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  SKIP_ANY_DIR, SKIP_TOP_DIR, normalizeAtlasScope,
  exclusionReason, fileKind, isDocCandidate, isImagePath, isOfficePath,
} from './config.mjs'

function addExcluded(map, rule, rel) {
  if (!map.has(rule)) map.set(rule, { rule, count: 0, sample: [] })
  const item = map.get(rule)
  item.count++
  if (item.sample.length < 5) item.sample.push(rel)
}

function gitVisibleFiles(root, scope = '') {
  const out = execFileSync(
    'git',
    [
      '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
      // 范围构建交给 git 的 pathspec：只输出子树内的文件，避免先列出整仓再过滤。
      // `:(literal)` 与 walk 模式的口径一致：scope 里的 * ? [ 按普通字符处理。
      ...(scope ? ['--', `:(literal)${scope}`] : []),
    ],
    { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  )
  return [...new Set(
    out.toString('utf8').split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')),
  )]
}

function ignoreGlobToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2 } else { out += '.*'; i++ }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end > i + 1) { out += glob.slice(i, end + 1); i = end } else { out += '\\[' }
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return out
}

/**
 * `.gitignore` 的确定性子集：注释、`!` 反选、前导 `/` 锚定、尾随 `/` 仅目录、
 * `*` / `?` / `**`、嵌套 ignore 文件。不读全局 exclude，不执行 `.gitignore` 里的任何东西。
 */
function parseGitignore(text, baseRel) {
  const rules = []
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) { negate = true; line = line.slice(1) }
    let dirOnly = false
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1) }
    if (!line) continue
    const anchored = line.startsWith('/') || line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    if (!line) continue
    rules.push({
      negate,
      dirOnly,
      basenameOnly: !anchored,
      re: new RegExp(`^${ignoreGlobToRegExp(line)}$`),
      baseRel,
    })
  }
  return rules
}

function ruleMatches(rule, local, isDir) {
  const parts = local.split('/')
  if (rule.basenameOnly) {
    // `dist/` 这类目录规则对目录内的文件也要生效：检查祖先目录段。
    const limit = rule.dirOnly && !isDir ? parts.length - 1 : parts.length
    for (let i = 0; i < limit; i++) if (rule.re.test(parts[i])) return true
    return false
  }
  // 有 `/` 的规则按相对路径匹配；同时检查祖先目录，
  // 这样 `foo/bar` 命中目录后，其下所有文件都被覆盖。
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join('/')
    const candidateIsDir = i < parts.length || isDir
    if (rule.dirOnly && !candidateIsDir) continue
    if (rule.re.test(candidate)) return true
  }
  return false
}

function isIgnored(rel, isDir, rules) {
  let ignored = false
  for (const rule of rules) {
    let local = rel
    if (rule.baseRel) {
      if (!rel.startsWith(rule.baseRel + '/')) continue
      local = rel.slice(rule.baseRel.length + 1)
    }
    if (!local) continue
    if (ruleMatches(rule, local, isDir)) ignored = !rule.negate
  }
  return ignored
}

/**
 * 目录遍历（非 git 工作区）。
 *
 * `scope` 是工作区相对前缀：**在遍历时就只下探匹配的路径**，而不是先走完整棵树再
 * 过滤。十万级非 git 目录上，后者会让一次子目录构建仍然付全树扫描成本（Chromium
 * 实测 510k 文件约 10.8 分钟才走到 `build-too-large`）。
 *
 * 返回 `visited` = 实际枚举的目录项数，供测试/诊断确认剪枝生效。
 */
export function walkFiles(root, scope = '') {
  const out = []
  const ignored = []
  const norm = normalizeAtlasScope(scope)
  if (norm === null) throw new Error(`无效的 Atlas 构建范围：${scope}`)
  const scopeParts = norm ? norm.split('/') : null
  let visited = 0
  const visit = (dir, baseRel, inheritedRules, matched) => {
    let rules = inheritedRules
    const ignoreFile = path.join(dir, '.gitignore')
    if (fs.existsSync(ignoreFile)) {
      try { rules = inheritedRules.concat(parseGitignore(fs.readFileSync(ignoreFile, 'utf8'), baseRel)) } catch { /* 坏文件不阻断扫描 */ }
    }
    const hasNegation = rules.some((rule) => rule.negate)
    let items
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    items.sort((a, b) => a.name.localeCompare(b.name))
    for (const item of items) {
      visited++
      // 范围剪枝：还没走到 scope 根时，只允许匹配当前层级的那个名字下探。
      // 放在 SKIP/ignore 判定之前：范围外的兄弟目录既不遍历、也不计入 excluded。
      if (scopeParts && matched < scopeParts.length && item.name !== scopeParts[matched]) continue
      if (item.isSymbolicLink()) continue
      const abs = path.join(dir, item.name)
      const rel = baseRel ? `${baseRel}/${item.name}` : item.name
      if (item.isDirectory()) {
        if (SKIP_ANY_DIR.has(item.name)) continue
        if (dir === root && SKIP_TOP_DIR.has(item.name)) continue
        const skipped = isIgnored(rel, true, rules)
        if (skipped) {
          ignored.push(rel + '/')
          // 只有存在 `!` 反选时才继续下探；否则整棵子树剪掉。
          if (!hasNegation) continue
        }
        visit(abs, rel, rules, scopeParts ? matched + 1 : 0)
      } else if (item.isFile()) {
        // scope 还有未走完的层级时，同名文件不是范围根（如 scope=dir/file，根下有文件 dir），
        // 直接跳过；否则它会混进 rels，虽然下游还会过滤，但导出函数的语义就不准确了。
        if (scopeParts && matched < scopeParts.length - 1) continue
        if (isIgnored(rel, false, rules)) { ignored.push(rel); continue }
        out.push(rel)
      }
    }
  }
  visit(root, '', [], 0)
  return { rels: out, ignored, visited }
}

function readHead(abs, maxBytes = 4096) {
  let fd = null
  try {
    fd = fs.openSync(abs, 'r')
    const buf = Buffer.alloc(Math.min(maxBytes, 1 << 20))
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

function looksBinary(buf) {
  return buf.includes(0)
}

/**
 * 按需读取单个文件的正文（`textMode:'lazy'` 时由抽取阶段调用）。
 * 与 scan 的缓冲路径共用同一套规则，避免两条路径的“哪些文件有正文”口径漂移。
 * @param {string} abs
 * @param {any} entry 至少含 rel/kind/ext/size/tooLarge
 * @param {any} config
 * @returns {{text:string|undefined, content:boolean, binary:boolean, textTruncated:boolean}}
 */
export function readEntryText(abs, entry, config) {
  const { kind, ext, size, rel } = entry
  if (entry.tooLarge) return { text: undefined, content: false, binary: false, textTruncated: true }
  if (kind === 'code' || kind === 'test' || kind === 'doc' || kind === 'file') {
    if (isImagePath(rel) || isOfficePath(rel)) {
      return { text: undefined, content: false, binary: false, textTruncated: false }
    }
    // .txt/.csv 也读全文：抽取只需要头部，但词项索引/正文检索要覆盖后半段。
    // 体积上限已由 maxFileBytes 在扫描阶段挡住（超限走 tooLarge 元数据卡）。
    if (kind === 'doc' && (ext === '.txt' || ext === '.csv')) {
      try {
        const text = fs.readFileSync(abs, 'utf8')
        if (text.includes('\u0000')) return { text: undefined, content: false, binary: true, textTruncated: false }
        return { text, content: text.length > 0, binary: false, textTruncated: false }
      } catch {
        return { text: undefined, content: false, binary: true, textTruncated: false }
      }
    }
    try {
      const text = fs.readFileSync(abs, 'utf8')
      if (text.includes('\u0000')) return { text: undefined, content: false, binary: true, textTruncated: false }
      return { text, content: true, binary: false, textTruncated: false }
    } catch {
      return { text: undefined, content: false, binary: true, textTruncated: false }
    }
  }
  const head = readHead(abs, 4096)
  if (looksBinary(head)) return { text: undefined, content: false, binary: true, textTruncated: false }
  try {
    const text = fs.readFileSync(abs, 'utf8')
    return { text, content: true, binary: false, textTruncated: false }
  } catch {
    return { text: undefined, content: false, binary: true, textTruncated: false }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {object} opts.config
 * @param {Map<string, object>} [opts.reuse] 已建卡片（path → 旧卡）。命中
 *   `kind+mtimeMs+size` 时**不读正文**；调用方必须保证这些卡会被复用，
 *   否则抽取器会拿到空文本。`buildAtlas` 只在配置与根部元数据未变时传它。
 * @param {'buffer'|'lazy'} [opts.textMode] `buffer`（默认）把正文放进扫描结果；
 *   `lazy` 只 stat，正文由抽取阶段用 `readEntryText()` 逐个读、用完即弃——
 *   大仓（十万级文件）不能把所有正文同时驻留内存。`verifyAtlas` 用 lazy 只比 stat。
 * @param {string} [opts.scope] 工作区相对目录前缀（空 = 全工作区）；由 `buildAtlas` 归一化后传入。
 * @returns {{
 *   root: string, mode: 'git'|'walk', warnings: string[],
 *   files: Array<{rel:string,abs:string,kind:string,ext:string,size:number,mtimeMs:number,content:boolean,text?:string,binary?:boolean,reused?:boolean,tooLarge?:boolean,textTruncated?:boolean}>,
 *   excluded: Array<{rule:string,count:number,sample:string[]}>,
 *   truncated: boolean, maxFiles: number, scope: string|null,
 *   walked: number|null, // walk 模式实际枚举的目录项数；git 模式为 null
 * }}
 */
export function scanWorkspace({ root, config, reuse = null, textMode = 'buffer', scope = '' }) {
  const absRoot = path.resolve(root)
  const warnings = []
  const scopeNorm = normalizeAtlasScope(scope)
  if (scopeNorm === null) throw new Error(`无效的 Atlas 构建范围：${scope}`)
  /** @type {'git'|'walk'} */
  let mode = 'git'
  let rels
  let ignoredByGitignore = []
  let walkedCount = null
  try {
    rels = gitVisibleFiles(absRoot, scopeNorm)
  } catch (err) {
    mode = 'walk'
    warnings.push(`git 文件列表不可用（${err.message}），退回目录遍历`)
    const walked = walkFiles(absRoot, scopeNorm)
    rels = walked.rels
    ignoredByGitignore = walked.ignored
    walkedCount = walked.visited
  }

  const excluded = new Map()
  for (const rel of ignoredByGitignore) addExcluded(excluded, 'gitignore', rel)
  const files = []
  let truncated = false
  const sorted = [...new Set(rels)].sort()

  for (const rel of sorted) {
    if (!rel || rel.endsWith('/')) continue
    // 范围构建：只 stat 子树内文件。过滤必须排在 maxFiles 之前，否则大仓里
    // 未命中范围的路径会白白占用扫描配额。
    if (scopeNorm && rel !== scopeNorm && !rel.startsWith(scopeNorm + '/')) continue
    if (files.length >= config.maxFiles) { truncated = true; break }
    const reason = exclusionReason(rel, config)
    if (reason) { addExcluded(excluded, reason, rel); continue }

    const abs = path.join(absRoot, rel)
    let st
    try { st = fs.lstatSync(abs) } catch { addExcluded(excluded, 'missing', rel); continue }
    // git 模式也会列出符号链接；不跟随，避免越出工作区
    if (st.isSymbolicLink()) { addExcluded(excluded, 'symlink', rel); continue }
    if (!st.isFile()) { addExcluded(excluded, 'not-file', rel); continue }

    const kind = fileKind(rel, config)
    if (kind === 'doc' && isImagePath(rel) && !isDocCandidate(rel, config)) {
      addExcluded(excluded, 'image-outside-docs', rel)
      continue
    }
    // 大文件降级（P1）：业务文档超限仍保留元数据卡（tooLarge:true），代码等其它
    // 类型照旧排除。否则一份 3MB 的 PDF 会从地图上彻底消失，只剩一句“排除 29”。
    const tooLarge = st.size > config.maxFileBytes
    const largeDoc = tooLarge && kind === 'doc' && isDocCandidate(rel, config)
    if (tooLarge && !largeDoc) { addExcluded(excluded, 'too-large', rel); continue }

    const prev = reuse?.get(rel)
    if (prev && prev.v === 1 && prev.kind === kind &&
        prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      files.push({
        rel, abs, kind, ext: path.posix.extname(rel).toLowerCase(),
        size: st.size, mtimeMs: st.mtimeMs,
        content: false, text: undefined, binary: false,
        textTruncated: prev.textTruncated === true, tooLarge: prev.tooLarge === true, reused: true,
      })
      continue
    }

    const ext = path.posix.extname(rel).toLowerCase()
    const entry = {
      rel, abs, kind, ext,
      size: st.size, mtimeMs: st.mtimeMs,
      content: false, text: undefined, binary: false, textTruncated: largeDoc,
      tooLarge: largeDoc,
    }
    if (textMode !== 'lazy') {
      const read = readEntryText(abs, entry, config)
      entry.content = read.content
      entry.text = read.text
      entry.binary = read.binary
      entry.textTruncated = read.textTruncated
    }
    // lazy：只 stat。抽取阶段逐个 readEntryText()，用完即弃，避免十万级文件的正文同时驻留。
    files.push(entry)
  }

  return {
    root: absRoot,
    mode,
    warnings,
    files,
    excluded: [...excluded.values()].sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
    truncated,
    maxFiles: config.maxFiles,
    scope: scopeNorm || null,
    walked: walkedCount,
  }
}
