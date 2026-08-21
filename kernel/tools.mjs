// YFW-turbo 工具注册表与执行器（docs/bridge-contract.md §9 替换面：工具执行器）
// ---------------------------------------------------------------------------
// 工具集：Bash（shell 执行，高危命令经 permissions 审批）、Read/Write/Edit
// （文件读写与编辑，路径边界校验）、Glob/Grep（边界内搜索）、Agent（子代理
// 分发，执行体在 engine）、Task（后台任务管理）、TodoWrite（任务规划）、
// WebFetch（URL 抓取，零依赖 Node https）、OCR（spawn python 调 ocr_engine.py
// 识别扫描件，零 npm 依赖）。返回统一结果 { content, isError, meta? }，由
// engine 以 tool_result 回填模型。
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep, join, extname } from 'node:path'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import { get as httpGet, request as httpRequest } from 'node:http'
import { matchesHighRisk } from './highrisk.mjs'

const BASH_TIMEOUT_MS = 120_000

// Windows 探测 git-bash：Bash 工具语义须与系统提示一致（shell: bash）。
// cmd.exe 的 /d /s /c 引号解析与 Node spawn 的参数包裹互相干扰（$HOME 不展开、
// 引号错乱），且 PATH 混入 Git Unix 工具时行为不可预测；git-bash 与模型所见
// 环境一致。找不到 git-bash 时回退 cmd.exe。
function findGitBash() {
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || null
}

function runShell(command, cwd) {
  return new Promise((resolvePromise) => {
    const isWin = process.platform === 'win32'
    let shell, args
    if (isWin) {
      const bash = findGitBash()
      if (bash) { shell = bash; args = ['-c', command] }
      else { shell = 'cmd.exe'; args = ['/d', '/s', '/c', command] }
    } else { shell = 'sh'; args = ['-c', command] }
    const child = spawn(shell, args, {
      cwd: cwd || undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (content, isError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ content, isError })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish(`命令超时（${BASH_TIMEOUT_MS}ms）`, true)
    }, BASH_TIMEOUT_MS)
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 200_000) stdout = stdout.slice(-200_000) })
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 100_000) stderr = stderr.slice(-100_000) })
    child.on('error', (e) => finish(`命令启动失败：${e.message}`, true))
    child.on('close', (code) => {
      const out = stdout.trim()
      const err = stderr.trim()
      const body = code === 0
        ? (out || '(命令执行完成，无输出)')
        : `退出码 ${code}\n${out ? out + '\n' : ''}${err ? 'stderr: ' + err : ''}`.trim()
      finish(body, code !== 0)
    })
  })
}

// 文件路径边界：仅允许读写 --add-dir 注入的目录（cwd / 技能根）内文件
function withinBoundary(filePath, allowDirs) {
  const resolved = resolve(filePath)
  return allowDirs.some((dir) => {
    const base = resolve(dir).toLowerCase()
    return resolved.toLowerCase() === base || resolved.toLowerCase().startsWith(base + sep)
  })
}

function readFile(filePath, allowDirs, input = {}) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    if (!existsSync(filePath)) return { content: `文件不存在：${filePath}`, isError: true }
    const st = statSync(filePath)
    if (st.isDirectory()) return { content: `是目录：${filePath}`, isError: true }
    const MAX = 2 * 1024 * 1024
    if (st.size > MAX) return { content: `文件过大（${st.size} 字节），超出 ${MAX} 字节读取上限`, isError: true }
    const full = readFileSync(filePath, 'utf-8')
    // offset/limit：按行范围读取（offset 从 1 开始，limit=行数，均可选）
    const offset = Number(input.offset)
    const limit = Number(input.limit)
    // 行数计算：split 会为末尾换行产生空元素，不计为行
    const totalLines = full.endsWith('\n') ? full.split('\n').length - 1 : full.split('\n').length
    const lineSlice = (from0, to1) => {
      const all = full.split('\n')
      const slice = all.slice(from0, to1)
      return { content: slice.join('\n') + (slice.length ? '\n' : ''), slice }
    }
    if (Number.isFinite(offset) && offset > 0) {
      const start = offset - 1
      const end = Number.isFinite(limit) && limit > 0 ? start + limit : totalLines
      const { content } = lineSlice(start, end)
      return { content, isError: false, meta: { range: [offset, Math.min(end, totalLines)], totalLines } }
    }
    if (Number.isFinite(limit) && limit > 0) {
      const { content } = lineSlice(0, limit)
      return { content, isError: false, meta: { range: [1, Math.min(limit, totalLines)], totalLines } }
    }
    return { content: full }
  } catch (e) {
    return { content: `读取失败：${e.message}`, isError: true }
  }
}

function writeFile(filePath, content, allowDirs) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    writeFileSync(filePath, String(content ?? ''), 'utf-8')
    return { content: `已写入 ${filePath}（${String(content ?? '').length} 字符）` }
  } catch (e) {
    return { content: `写入失败：${e.message}`, isError: true }
  }
}

// Edit：先读后改的字符串替换。old_string 需在文件中唯一（否则要求 replace_all）。
function editFile(filePath, oldString, newString, replaceAll, allowDirs) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    if (!existsSync(filePath)) return { content: `文件不存在：${filePath}`, isError: true }
    if (typeof oldString !== 'string' || !oldString) return { content: 'old_string 缺失或为空', isError: true }
    if (typeof newString !== 'string') return { content: 'new_string 必须为字符串', isError: true }
    const content = readFileSync(filePath, 'utf-8')
    const count = content.split(oldString).length - 1
    if (count === 0) return { content: `未找到匹配文本：${JSON.stringify(oldString.slice(0, 80))}`, isError: true }
    if (count > 1 && !replaceAll) {
      return { content: `old_string 出现 ${count} 次，不唯一；请使用 replace_all 或补充更多上下文`, isError: true }
    }
    const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
    writeFileSync(filePath, next, 'utf-8')
    return { content: `已编辑 ${filePath}（${replaceAll ? count : 1} 处替换）` }
  } catch (e) {
    return { content: `编辑失败：${e.message}`, isError: true }
  }
}

// Glob：在会话目录边界内递归匹配文件名/路径（pattern 支持 * ? 和 **）。
// 匹配前把路径归一化为正斜杠，Windows 反斜杠路径与 pattern 里的 / 均能命中。
function globSearch(pattern, allowDirs, { maxResults = 200 } = {}) {
  try {
    if (!pattern) return { content: 'pattern 缺失', isError: true }
    const re = globToRegExp(String(pattern).replace(/\\/g, '/'))
    const results = []
    const seen = new Set()
    const walk = (dir) => {
      if (results.length >= maxResults) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        if (results.length >= maxResults) break
        if (ent.name.startsWith('.') && ent.name !== '.' && ent.name !== '..') continue // 跳过隐藏项
        const full = join(dir, ent.name)
        if (ent.isDirectory()) walk(full)
        else {
          const normalized = full.replace(/\\/g, '/')
          if (re.test(normalized) && !seen.has(full)) { seen.add(full); results.push(full) }
        }
      }
    }
    for (const base of allowDirs) walk(base)
    if (results.length === 0) return { content: `无匹配文件（pattern: ${pattern}）` }
    const truncated = results.length >= maxResults ? `\n（已达 ${maxResults} 条上限，结果截断）` : ''
    return { content: results.join('\n') + truncated }
  } catch (e) {
    return { content: `搜索失败：${e.message}`, isError: true }
  }
}

// 简易 glob → RegExp：** 跨目录 / * 单段内任意 / ? 单字符
function globToRegExp(pattern) {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(re + '$', 'i')
}

// Grep：在边界内按正则搜索文件内容，返回 file:line 匹配行（含上下文）
function grepSearch(pattern, allowDirs, { glob, context = 0, maxResults = 200 } = {}) {
  try {
    if (!pattern) return { content: 'pattern 缺失', isError: true }
    let re
    try { re = new RegExp(String(pattern)) } catch (e) { return { content: `正则无效：${e.message}`, isError: true } }
    const ctx = Math.max(0, Math.min(Number(context) || 0, 10))
    const globRe = glob ? globToRegExp(String(glob).replace(/\\/g, '/')) : null
    const results = []
    const MAX_BYTES = 2 * 1024 * 1024
    const walk = (dir) => {
      if (results.length >= maxResults) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        if (results.length >= maxResults) break
        if (ent.name.startsWith('.')) continue
        const full = join(dir, ent.name)
        if (ent.isDirectory()) walk(full)
        else if (!globRe || globRe.test(full.replace(/\\/g, '/'))) {
          let st
          try { st = statSync(full) } catch { continue }
          if (!st.isFile() || st.size > MAX_BYTES) continue
          const lines = readFileSync(full, 'utf-8').split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              const from = Math.max(0, i - ctx)
              const to = Math.min(lines.length, i + ctx + 1)
              const block = []
              for (let j = from; j < to; j++) block.push(`${j + 1}:${lines[j]}`)
              results.push(`—— ${full}（行 ${i + 1}）\n${block.join('\n')}`)
              if (results.length >= maxResults) break
            }
          }
        }
      }
    }
    for (const base of allowDirs) walk(base)
    if (results.length === 0) return { content: `无匹配行（pattern: ${pattern}${glob ? `, glob: ${glob}` : ''}）` }
    const truncated = results.length >= maxResults ? `\n（已达 ${maxResults} 条上限，结果截断）` : ''
    return { content: results.join('\n\n') + truncated }
  } catch (e) {
    return { content: `搜索失败：${e.message}`, isError: true }
  }
}

// WebFetch：抓取 URL 内容。仅 http/https；30s 超时；2MB 上限；HTML→文本简易提取
function fetchUrl(url, { maxBytes = 2 * 1024 * 1024, timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise) => {
    let u
    try { u = new URL(String(url || '')) } catch { return resolvePromise({ content: `URL 无效：${url}`, isError: true }) }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolvePromise({ content: `仅支持 http/https：${u.protocol}`, isError: true })
    }
    const mod = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = mod(u, {
      method: 'GET',
      headers: { 'user-agent': 'YFW-turbo/0.1', accept: 'text/html,text/plain,*/*' },
    }, (res) => {
      const status = res.statusCode || 0
      const chunks = []
      let size = 0
      res.on('data', (d) => {
        size += d.length
        if (size > maxBytes) {
          req.destroy()
          resolvePromise({ content: `内容超限（>${maxBytes} 字节），已截断`, isError: true })
          return
        }
        chunks.push(d)
      })
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const type = String(res.headers['content-type'] || '')
        if (!/html/i.test(type) && !/^text\//i.test(type)) {
          return resolvePromise({ content: `响应类型 ${type}（${buf.length} 字节），非文本内容，未提取文本`, isError: false })
        }
        const text = /html/i.test(type) ? htmlToText(buf.toString('utf-8')) : buf.toString('utf-8')
        resolvePromise({ content: `HTTP ${status}\n${(text.slice(0, maxBytes) || '(空内容)').trim()}`, isError: status >= 400 })
      })
    })
    req.on('error', (e) => resolvePromise({ content: `抓取失败：${e.message}`, isError: true }))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolvePromise({ content: `抓取超时（${timeoutMs}ms）`, isError: true }) })
    req.end()
  })
}

// 简易 HTML→文本（零依赖）：去 script/style、标签、常用实体
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

// ---------------------------------------------------------------------------
// OCR：扫描件识别。内核保持零 npm 依赖——OCR 能力来自外部 python 引擎
// （RapidOCR/PP-OCRv4，见 ~/.claude/skills/_common/ocr_engine.py），工具仅负责
// 定位引擎、传参、解析输出。引擎探测：YFW_OCR_ENGINE env 覆盖 → 常见技能路径。
// 输出用 --output 写临时 JSON 全量结果（stdout 仅 500 字符预览），解析后删除。
// ---------------------------------------------------------------------------
const OCR_TIMEOUT_MS = 300_000

function findOcrEngine() {
  if (process.env.YFW_OCR_ENGINE && existsSync(process.env.YFW_OCR_ENGINE)) return process.env.YFW_OCR_ENGINE
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = [
    join(home, '.claude', 'skills', '_common', 'ocr_engine.py'),
    join(home, '.yfworking', 'skills', '_common', 'ocr_engine.py'),
  ]
  return candidates.find((p) => existsSync(p)) || null
}

// Windows 优先 python（rapidocr_onnxruntime 装入的解释器），ENOENT 时回退 py
function runPythonCapture(args, { cwd, timeoutMs = OCR_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    const pythons = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
    let idx = 0
    const attempt = () => {
      const py = pythons[idx]
      if (!py) return resolvePromise({ content: 'OCR 失败：未找到 python 解释器（需安装 python + rapidocr_onnxruntime）', isError: true })
      const child = spawn(py, args, { cwd: cwd || undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (content, isError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ content, isError })
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        finish(`OCR 超时（${timeoutMs}ms）`, true)
      }, timeoutMs)
      child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 500_000) stdout = stdout.slice(-500_000) })
      child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-200_000) })
      child.on('error', (e) => {
        if (e.code === 'ENOENT') { idx++; attempt() }
        else finish(`OCR 引擎启动失败：${e.message}`, true)
      })
      child.on('close', (code) => {
        const out = stdout.trim()
        const err = stderr.trim()
        const body = code === 0
          ? (out || '(OCR 引擎执行完成，无输出)')
          : `OCR 引擎退出码 ${code}\n${out ? out + '\n' : ''}${err ? 'stderr: ' + err.slice(0, 2000) : ''}`.trim()
        finish(body, code !== 0)
      })
    }
    attempt()
  })
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp']

// OCR 主逻辑：边界/存在性校验 → 引擎探测 → python 执行 → 解析。
// PDF 走 CLI（--output 临时 JSON 全量结果）；图片走内联 import 调 ocr_image()
// （引擎 CLI 的 ocr 命令面向 PDF，fitz 包装图片会判为空白页）。零 npm 依赖。
async function ocrFile(filePath, allowDirs, input = {}) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    if (!existsSync(filePath)) return { content: `文件不存在：${filePath}`, isError: true }
    if (statSync(filePath).isDirectory()) return { content: `是目录：${filePath}`, isError: true }
    const mode = input?.mode === 'table' ? 'table' : 'text'
    const project = String(input?.project || 'default')
    const engine = findOcrEngine()
    if (!engine) {
      return { content: 'OCR 引擎不可用：未找到 ocr_engine.py（可设置 YFW_OCR_ENGINE 指向引擎路径）', isError: true }
    }
    const isImage = IMAGE_EXTS.includes(extname(filePath).toLowerCase())
    let data = null
    if (isImage) {
      // 图片：内联 import ocr_engine.ocr_image（table 模式对图片无意义，一律全文）
      const engineDir = dirname(engine)
      const script = [
        'import sys, json',
        `sys.path.insert(0, ${JSON.stringify(engineDir)})`,
        'from ocr_engine import ocr_image',
        `r = ocr_image(${JSON.stringify(filePath)}, ${JSON.stringify(project)})`,
        'print(json.dumps(r, ensure_ascii=False))',
      ].join('; ')
      const r = await runPythonCapture(['-c', script], { cwd: dirname(filePath) })
      if (r.isError) return { content: `OCR 失败\n${r.content}`, isError: true }
      // 引擎初始化日志混在 stdout，JSON 是最后一个以 { 开头的行
      const jsonLine = r.content.split('\n').reverse().find((l) => l.trim().startsWith('{'))
      try { data = JSON.parse(jsonLine) } catch { return { content: `OCR 引擎输出无效\n${r.content}`, isError: true } }
      if (data?.error) return { content: `OCR 失败：${data.error}`, isError: true }
    } else {
      const tmpOut = join(tmpdir(), `yfw-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
      const args = mode === 'table'
        ? [engine, 'ocr-table', '--file', filePath, '--project', project, '--output', tmpOut]
        : [engine, 'ocr', '--file', filePath, '--project', project, '--output', tmpOut]
      const r = await runPythonCapture(args, { cwd: dirname(filePath) })
      try { data = JSON.parse(readFileSync(tmpOut, 'utf-8')) } catch {}
      try { rmSync(tmpOut, { force: true }) } catch {}
      if (r.isError) {
        const errMsg = data?.error ? `：${data.error}` : ''
        return { content: `OCR 失败${errMsg}\n${r.content}`, isError: true }
      }
      if (!data) return { content: `OCR 引擎无有效输出\n${r.content}`, isError: true }
    }
    // 组装结果：多页加页标记；table 模式追加表格（tab 分隔行）
    const pages = Array.isArray(data.pages) ? data.pages : []
    const textBlock = pages.length > 1
      ? pages.map((p) => `--- 第 ${p.page} 页 ---\n${p.text || ''}`).join('\n')
      : (pages[0]?.text || data.text || '')
    const tables = Array.isArray(data.tables) ? data.tables : []
    const tableBlock = tables.length
      ? tables.map((t, i) => {
          const rows = Array.isArray(t.data) ? t.data : []
          const lines = rows.map((row) => (Array.isArray(row) ? row.join('\t') : String(row ?? '')))
          return `[表格 ${i + 1}（第 ${t.page} 页，${lines.length} 行）]\n${lines.join('\n')}`
        }).join('\n\n')
      : ''
    const meta = {
      scanned: isImage ? null : data.is_scanned === true,
      pages: pages.length,
      cacheHit: data.cache_hit === true,
      tables: tables.length,
      confidence: data.confidence ?? pages[0]?.confidence ?? null,
    }
    const kind = isImage ? '图片' : (meta.scanned ? '扫描件' : '含文本层')
    const head = `[OCR] ${data.file || filePath}（${kind}，${meta.pages} 页，缓存命中：${meta.cacheHit ? '是' : '否'}）`
    const body = [head, textBlock, tableBlock].filter(Boolean).join('\n\n').trim()
    return { content: body || `OCR 未识别到文本（${filePath}）`, isError: false, meta }
  } catch (e) {
    return { content: `OCR 失败：${e.message}`, isError: true }
  }
}

export function createToolRegistry({ cwd, addDirs, skipPermissions }) {
  const allowDirs = [cwd, ...(addDirs || [])].filter(Boolean)
  // todo 清单（TodoWrite 覆盖式维护；同一进程共享）
  let todoItems = []
  const registry = {
    Bash: {
      description: '执行 shell 命令',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
        required: ['command'],
      },
      run: (input) => runShell(String(input?.command ?? ''), cwd),
      isHighRisk: (input) => matchesHighRisk(String(input?.command ?? '')),
    },
    Read: {
      description: '读取文本文件内容（支持 offset/limit 行范围读取，offset 从 1 开始）',
      // concurrencySafe：只读工具可并发执行（P0-4 只读批并行）
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要读取的文件绝对路径' },
          offset: { type: 'number', description: '可选：起始行号（1 开始）' },
          limit: { type: 'number', description: '可选：读取行数' },
        },
        required: ['file_path'],
      },
      run: (input) => readFile(String(input?.file_path ?? ''), allowDirs, input),
    },
    Write: {
      description: '写入文本文件',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要写入的文件绝对路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['file_path', 'content'],
      },
      run: (input) => writeFile(String(input?.file_path ?? ''), String(input?.content ?? ''), allowDirs),
    },
    Edit: {
      description: '先读后改的字符串替换编辑（old_string 需唯一，或指定 replace_all）',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要编辑的文件绝对路径' },
          old_string: { type: 'string', description: '要替换的原文（需精确匹配）' },
          new_string: { type: 'string', description: '替换后的内容' },
          replace_all: { type: 'boolean', description: '可选：true 时替换全部匹配（默认 false 仅替换唯一匹配）' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      run: (input) => editFile(String(input?.file_path ?? ''), String(input?.old_string ?? ''), String(input?.new_string ?? ''), input?.replace_all === true, allowDirs),
    },
    Glob: {
      description: '在会话目录内递归搜索文件路径（pattern 支持 * ? 和 ** 通配）',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string', description: '文件路径通配模式，如 **/*.mjs' },
          maxResults: { type: 'number', description: '可选：最大结果数（默认 200）' },
        },
        required: ['pattern'],
      },
      run: (input) => globSearch(String(input?.pattern ?? ''), allowDirs, { maxResults: Number(input?.maxResults) || 200 }),
    },
    Grep: {
      description: '在会话目录内按正则搜索文件内容，返回 file:line 匹配行',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          glob: { type: 'string', description: '可选：文件路径通配过滤，如 **/*.mjs' },
          context: { type: 'number', description: '可选：匹配行上下文件数（0-10，默认 0）' },
          maxResults: { type: 'number', description: '可选：最大结果数（默认 200）' },
        },
        required: ['pattern'],
      },
      run: (input) => grepSearch(String(input?.pattern ?? ''), allowDirs, {
        glob: input?.glob ? String(input.glob) : undefined,
        context: Number(input?.context) || 0,
        maxResults: Number(input?.maxResults) || 200,
      }),
    },
    // 子代理分发：执行体在 engine（ctx.spawnSubAgent）。子 lane 内禁止嵌套。
    Agent: {
      description: '将子任务委派给子 Agent 执行（按优势场景选择 subagent_type）；前台同步回填结果，或 run_in_background 后台异步执行',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subagent_type: { type: 'string', description: '子 Agent 类型（general-purpose / researcher 或用户注册的 agent id）' },
          prompt: { type: 'string', description: '委派给子 Agent 的完整任务说明' },
          run_in_background: { type: 'boolean', description: '可选：true 时后台异步执行，立即返回 task_id（Task 工具查询/中止）' },
          description: { type: 'string', description: '可选：任务描述（展示用）' },
        },
        required: ['subagent_type', 'prompt'],
      },
      run: (input, ctx) => {
        if (ctx?.lane) return { content: '子 Agent 不支持嵌套分发', isError: true }
        if (typeof ctx?.spawnSubAgent !== 'function') return { content: '子 Agent 执行器不可用', isError: true }
        return ctx.spawnSubAgent(input, ctx)
      },
    },
    // 后台子 Agent 任务管理（查询/中止）
    Task: {
      description: '管理后台子 Agent 任务：list 列出全部、status/output 查询单个、stop 中止',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', description: 'list | status | output | stop' },
          task_id: { type: 'string', description: '可选：status/output/stop 时的任务 id' },
        },
        required: ['command'],
      },
      run: (input, ctx) => {
        if (typeof ctx?.taskSystem !== 'object') return { content: '任务系统不可用', isError: true }
        const cmd = String(input?.command || '')
        const id = String(input?.task_id || '')
        const sys = ctx.taskSystem
        if (cmd === 'list') return { content: sys.list() }
        if (cmd === 'status') return { content: sys.status(id) }
        if (cmd === 'output') return sys.output(id)
        if (cmd === 'stop') return sys.stop(id)
        return { content: `未知 command：${cmd}（支持 list/status/output/stop）`, isError: true }
      },
    },
    // 任务规划清单（覆盖式更新，返回当前清单）
    TodoWrite: {
      description: '维护任务规划清单（todo list）：以完整清单覆盖更新，返回当前清单供模型跟踪进度',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            description: '完整的 todo 清单（覆盖式更新）：[{ content, status? }]，status 为 pending/in_progress/completed',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                content: { type: 'string', description: '任务描述' },
                status: { type: 'string', description: '可选：pending/in_progress/completed（默认 pending）' },
              },
            },
          },
        },
        required: ['todos'],
      },
      run: (input) => {
        const list = Array.isArray(input?.todos) ? input.todos : []
        todoItems = list
          .map((t) => ({
            content: String(t?.content ?? ''),
            status: ['pending', 'in_progress', 'completed'].includes(t?.status) ? t.status : 'pending',
          }))
          .filter((t) => t.content)
        if (todoItems.length === 0) return { content: '（todo 清单为空）' }
        const lines = todoItems.map((t, i) => {
          const mark = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '→' : ' '
          return `${i + 1}. [${mark}] ${t.content}`
        })
        return { content: lines.join('\n') }
      },
    },
    // URL 抓取（零依赖 Node http/https）
    WebFetch: {
      description: '抓取 URL 内容并提取文本（仅 http/https；30s 超时；2MB 上限；HTML 自动转文本）',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: '要抓取的 URL（http/https）' },
        },
        required: ['url'],
      },
      run: (input) => fetchUrl(String(input?.url || '')),
    },
    // 扫描件 OCR（spawn python 调 ocr_engine.py；PDF/图片均可；结果按 project 缓存）
    OCR: {
      description: '对扫描件 PDF 或图片执行 OCR 文字识别（mode=text 提取全文；mode=table 额外识别表格；结果按 project 缓存，重复识别秒回）',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要识别的 PDF/图片绝对路径' },
          mode: { type: 'string', description: '可选：text（默认，全文识别）| table（含表格识别）' },
          project: { type: 'string', description: '可选：项目名（缓存隔离，默认 default）' },
        },
        required: ['file_path'],
      },
      run: (input) => ocrFile(String(input?.file_path ?? ''), allowDirs, input),
    },
  }
  return {
    registry,
    toolNames: Object.keys(registry),
    // P0-4：只读工具并发安全标记（Bash/Write/Edit/Agent/Task/OCR 等写/执行类串行）
    isConcurrencySafe(name) {
      return registry[name]?.concurrencySafe === true
    },
    // 中立工具 schema 列表（Anthropic/OpenAI 协议字段映射在 api.mjs 完成）
    toolSchemas() {
      return Object.entries(registry).map(([name, tool]) => ({
        name,
        description: tool.description,
        input_schema: tool.input_schema,
      }))
    },
    // 执行入口：返回归一化 { content, isError }（成功路径可能缺省 isError）；
    // approval 决策由调用方（engine）先行
    async run(toolUse, ctx) {
      const tool = registry[toolUse?.name]
      if (!tool) return { content: `未知工具：${toolUse?.name}`, isError: true }
      const r = await tool.run(toolUse.input || {}, ctx)
      if (r && typeof r === 'object') {
        return { content: r.content ?? '', isError: r.isError === true, ...(r.meta ? { meta: r.meta } : {}) }
      }
      return { content: String(r ?? ''), isError: false }
    },
  }
}
